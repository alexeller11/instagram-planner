require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';
const BASE_URL = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : `http://localhost:${PORT}`;
const IG_TOKENS = (process.env.IG_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);

// Validação da chave Gemini
if (!process.env.GEMINI_API_KEY) {
  console.error('[FATAL] GEMINI_API_KEY não está configurada! A IA não funcionará.');
  console.error('[FATAL] Configure a variável de ambiente GEMINI_API_KEY com sua chave do Google AI Studio.');
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ─── TOKEN TRACKING & COST CONTROL ────────────────────────
const MAX_MONTHLY_COST = parseFloat(process.env.MAX_GEMINI_COST || '5');
const COST_PER_1M_INPUT = 0.075;
const COST_PER_1M_OUTPUT = 0.30;
let monthlyTokensUsed = { input: 0, output: 0, cost: 0 };
let lastResetDate = new Date().toDateString();

function resetMonthlyIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate && new Date().getDate() === 1) {
    monthlyTokensUsed = { input: 0, output: 0, cost: 0 };
    lastResetDate = today;
  }
}

function calculateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000000) * COST_PER_1M_INPUT;
  const outputCost = (outputTokens / 1000000) * COST_PER_1M_OUTPUT;
  return inputCost + outputCost;
}

function checkTokenBudget(estimatedOutputTokens) {
  resetMonthlyIfNeeded();
  const estimatedCost = calculateCost(0, estimatedOutputTokens);
  const projectedCost = monthlyTokensUsed.cost + estimatedCost;
  return {
    canProceed: projectedCost <= MAX_MONTHLY_COST,
    currentCost: monthlyTokensUsed.cost.toFixed(4),
    projectedCost: projectedCost.toFixed(4),
    remainingBudget: (MAX_MONTHLY_COST - monthlyTokensUsed.cost).toFixed(4),
    percentage: ((monthlyTokensUsed.cost / MAX_MONTHLY_COST) * 100).toFixed(1)
  };
}

function recordTokenUsage(inputTokens, outputTokens) {
  resetMonthlyIfNeeded();
  const cost = calculateCost(inputTokens, outputTokens);
  monthlyTokensUsed.input += inputTokens;
  monthlyTokensUsed.output += outputTokens;
  monthlyTokensUsed.cost += cost;
  console.log(`[TOKENS] Input: ${inputTokens} | Output: ${outputTokens} | Cost: $${cost.toFixed(4)} | Total: $${monthlyTokensUsed.cost.toFixed(4)}/${MAX_MONTHLY_COST}`);
}

// ─── LIMPEZA DE JSON ROBUSTA ───────────────────────────────
function cleanAndParseJSON(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Resposta vazia ou inválida do Gemini');
  }

  let text = rawText.trim();

  // Remove blocos de código markdown: ```json ... ``` ou ``` ... ```
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  // Remove qualquer texto antes do primeiro { ou [
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }
  if (startIdx > 0) {
    text = text.substring(startIdx);
  }

  // Remove qualquer texto após o último } ou ]
  const lastBrace = text.lastIndexOf('}');
  const lastBracket = text.lastIndexOf(']');
  const endIdx = Math.max(lastBrace, lastBracket);
  if (endIdx !== -1 && endIdx < text.length - 1) {
    text = text.substring(0, endIdx + 1);
  }

  // Tenta parse direto
  try {
    return JSON.parse(text);
  } catch (e1) {
    // Tenta corrigir problemas comuns de JSON vindos de LLMs
    let fixed = text
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"') // Aspas inteligentes
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'") // Aspas simples inteligentes
      .replace(/,\s*([}\]])/g, '$1') // Vírgulas extras no final de arrays/objetos
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, (m, p1, p2) => `${p1}"${p2}":`) // Chaves sem aspas
      .replace(/:\s*'([^']*)'/g, (m, p1) => `: "${p1.replace(/"/g, '\\"')}"`); // Valores com aspas simples
    
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      // Última tentativa: remover quebras de linha dentro de strings (comum em bios/legendas)
      try {
        const superFixed = fixed.replace(/: "([^"]*)"/g, (m, p1) => `: "${p1.replace(/\n/g, '\\n')}"`);
        return JSON.parse(superFixed);
      } catch (e3) {
        console.error('[JSON_PARSE_ERROR] Texto original:', rawText);
        throw new Error(`JSON inválido após limpeza: ${e2.message}`);
      }
    }
  }
}

// ─── VALIDAÇÃO DE CAMPOS DO PLANO ─────────────────────────
function validateAndNormalizePlan(data) {
  if (!data || typeof data !== 'object') return data;

  // Garante arrays obrigatórios
  if (!Array.isArray(data.posts)) data.posts = [];
  if (!Array.isArray(data.stories)) data.stories = [];
  if (!Array.isArray(data.tips)) data.tips = [];
  if (!Array.isArray(data.post_days)) data.post_days = [];
  if (!data.hashtags) data.hashtags = { niche: [], local: [], broad: [], strategy: '' };
  if (!data.audit) data.audit = {};
  if (!Array.isArray(data.editorial_pillars)) data.editorial_pillars = [];

  // Normaliza posts
  data.posts = data.posts.map((p, i) => ({
    n: p.n || p.number || p.num || (i + 1),
    week: p.week || p.semana || 1,
    day_suggestion: p.day_suggestion || p.day || p.dia || '',
    format: p.format || p.formato || p.type || 'Post',
    pillar: p.pillar || p.pilar || '',
    title: p.title || p.titulo || p.tema || '',
    objective: p.objective || p.objetivo || '',
    visual: p.visual || p.visual_suggestion || '',
    copy: p.copy || p.legenda || p.caption || p.texto || '',
    cta: p.cta || '',
    audio: p.audio || p.musica || '',
    hook: p.hook || p.gancho || '',
    script: p.script || p.roteiro || '',
    carousel_slides: Array.isArray(p.carousel_slides) ? p.carousel_slides :
                     Array.isArray(p.slides) ? p.slides : []
  }));

  // Normaliza stories
  data.stories = data.stories.map((s, i) => ({
    day: s.day || s.dia || `Dia ${i + 1}`,
    theme: s.theme || s.tema || '',
    objective: s.objective || s.objetivo || '',
    funnel_stage: s.funnel_stage || s.etapa_funil || '',
    slides: Array.isArray(s.slides) ? s.slides.map(sl => ({
      n: sl.n || sl.numero || '',
      text: sl.text || sl.texto || '',
      action: sl.action || sl.acao || '',
      copy_detail: sl.copy_detail || sl.detalhe || ''
    })) : []
  }));

  // Normaliza hashtags
  if (Array.isArray(data.hashtags)) {
    data.hashtags = { niche: data.hashtags, local: [], broad: [], strategy: '' };
  } else {
    if (!Array.isArray(data.hashtags.niche)) data.hashtags.niche = [];
    if (!Array.isArray(data.hashtags.local)) data.hashtags.local = [];
    if (!Array.isArray(data.hashtags.broad)) data.hashtags.broad = [];
    if (!data.hashtags.strategy) data.hashtags.strategy = '';
  }

  // Normaliza datas (pode vir como event_days ou dates)
  if (!Array.isArray(data.dates) && Array.isArray(data.event_days)) {
    data.dates = data.event_days;
  } else if (!Array.isArray(data.dates)) {
    data.dates = [];
  }

  return data;
}

// ─── VALIDAÇÃO DE CAMPOS DE SUGESTÕES ─────────────────────
function validateSuggestions(data) {
  if (!data || typeof data !== 'object') return {};
  return {
    niche: data.niche || data.nicho || '',
    niche_confidence: data.niche_confidence || data.confianca_nicho || 'médio',
    location: data.location || data.localizacao || data.cidade || 'Brasil',
    audience: data.audience || data.publico || data.publico_alvo || '',
    goal: data.goal || data.objetivo || '',
    tone: data.tone || data.tom || data.tom_de_voz || '',
    extra: data.extra || data.contexto || '',
    competitors_search: Array.isArray(data.competitors_search) ? data.competitors_search : [],
    bio_suggestions: Array.isArray(data.bio_suggestions) ? data.bio_suggestions : [],
    insights: data.insights || ''
  };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
console.log(`[SERVER] Diretório público configurado em: ${publicDir}`);
const isProduction = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ─── FETCH IG PROFILES ───────────────────────────────────────
async function fetchIGProfiles(tokens) {
  const accounts = [];
  for (const token of tokens) {
    try {
      const res = await axios.get('https://graph.instagram.com/v21.0/me', {
        params: { fields: 'id,name,username,followers_count,media_count,biography,website,profile_picture_url,account_type', access_token: token }
      });
      accounts.push({ ...res.data, ig_token: token });
      console.log(`[IG] @${res.data.username} | ${res.data.followers_count} seguidores`);
    } catch (e) { console.log(`[IG_ERR] ${e.response?.data?.error?.message || e.message}`); }
  }
  return accounts;
}

async function fetchMedia(igId, token, limit = 50) {
  try {
    const res = await axios.get(`https://graph.instagram.com/v21.0/${igId}/media`, {
      params: { fields: 'id,caption,media_type,timestamp,like_count,comments_count', limit, access_token: token }
    });
    return res.data.data || [];
  } catch (e) { return []; }
}

// ─── AUTH ─────────────────────────────────────────────────────
app.get('/auth/login', async (req, res) => {
  if (!IG_TOKENS.length) return res.redirect('/?error=no_tokens');
  try {
    const accounts = await fetchIGProfiles(IG_TOKENS);
    req.session.user = { accounts };
    res.redirect('/app');
  } catch (e) { res.redirect('/?error=fetch_failed'); }
});
app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  const accounts = req.session.user.accounts || [];
  console.log('[API/ME] Retornando', accounts.length, 'contas');
  res.json({ logged: true, igAccounts: accounts, accounts: accounts });
});

// ─── TOKEN STATUS ─────────────────────────────────────────────
app.get('/api/token-status', (req, res) => {
  resetMonthlyIfNeeded();
  res.json({
    current_cost: monthlyTokensUsed.cost.toFixed(4),
    max_budget: MAX_MONTHLY_COST.toFixed(4),
    percentage_used: ((monthlyTokensUsed.cost / MAX_MONTHLY_COST) * 100).toFixed(1),
    remaining_budget: (MAX_MONTHLY_COST - monthlyTokensUsed.cost).toFixed(4),
    total_input_tokens: monthlyTokensUsed.input,
    total_output_tokens: monthlyTokensUsed.output,
    gemini_configured: !!process.env.GEMINI_API_KEY,
    ig_tokens_configured: IG_TOKENS.length
  });
});

// ─── DEBUG ────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const results = [];
  for (const token of IG_TOKENS.slice(0, 3)) {
    try {
      const r = await axios.get('https://graph.instagram.com/v21.0/me', {
        params: { fields: 'id,username,followers_count,account_type', access_token: token }
      });
      results.push({ ok: true, data: r.data });
    } catch (e) { results.push({ ok: false, error: e.response?.data || e.message }); }
  }
  res.json({ tokens_configured: IG_TOKENS.length, results });
});

// ─── PROFILE SUGGESTIONS (IA preenche campos) ────────────────
app.post('/api/suggestions', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY não configurada. Adicione a chave no painel de variáveis de ambiente do Railway/Render.' });
  const { igId } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  if (!account) return res.status(404).json({ error: 'Not found' });

  const budgetCheck = checkTokenBudget(1000);
  if (!budgetCheck.canProceed) return res.status(429).json({ error: 'Orçamento de tokens esgotado', budget: budgetCheck });

  const media = await fetchMedia(account.id, account.ig_token, 10);
  const captions = media.map(m => m.caption?.substring(0, 150) || '').filter(Boolean).join(' | ');
  const mediaTypes = media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type]||0)+1; return acc; }, {});

  const prompt = `Analise este perfil do Instagram e sugira preenchimentos inteligentes para um formulário de planejamento de marketing.

PERFIL REAL:
- Username: @${account.username}
- Nome: ${account.name}
- Seguidores: ${(account.followers_count||0).toLocaleString('pt-BR')}
- Posts: ${account.media_count}
- Bio atual: ${account.biography || 'Não informada'}
- Website: ${account.website || 'Não informado'}
- Tipos de posts: ${JSON.stringify(mediaTypes)}
- Exemplos de legendas: ${captions || 'Sem dados'}

IMPORTANTE: Retorne SOMENTE o JSON abaixo, sem texto adicional, sem markdown, sem explicações. Apenas o JSON puro:
{
  "niche": "nicho detectado com base nos posts e bio (ex: Nutricionista Funcional, Moda Feminina Plus Size)",
  "niche_confidence": "alto/médio/baixo",
  "location": "cidade/estado detectado se possível na bio/legendas, senão Brasil",
  "audience": "perfil do público ideal baseado no nicho e conteúdo",
  "goal": "objetivo mais provável: Vender mais / Ganhar seguidores / Lançar serviço / Engajamento / Autoridade",
  "tone": "tom de voz detectado: Próximo e amigável / Profissional / Humor / Inspirador / Luxo",
  "extra": "contexto adicional detectado nos posts",
  "competitors_search": ["termo de busca 1 para encontrar concorrentes", "termo 2", "termo 3"],
  "bio_suggestions": [
    "Bio opção 1 — máximo 150 caracteres, com emoji estratégico e CTA claro",
    "Bio opção 2 — ângulo diferente, máximo 150 caracteres",
    "Bio opção 3 — mais direta e focada em resultado, máximo 150 caracteres"
  ],
  "insights": "observação humanizada sobre o perfil em 2 frases, como um consultor falando diretamente para o dono do perfil"
}`;

  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: "application/json" }
    });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 2048
      }
    });
    const text = result.response.text();
    const inputTokens = result.response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = result.response.usageMetadata?.candidatesTokenCount || 0;
    recordTokenUsage(inputTokens, outputTokens);
    console.log(`[SUGGESTIONS] Resposta bruta completa: ${text}`);
    try {
      const parsed = cleanAndParseJSON(text);
      res.json(validateSuggestions(parsed));
    } catch (parseErr) {
      console.error('[SUGGESTIONS] Erro de parse:', parseErr.message);
      console.error('[SUGGESTIONS] Texto que falhou no parse:', text);
      res.status(500).json({ error: 'Erro ao processar resposta da IA: ' + parseErr.message, raw: text });
    }
  } catch (e) {
    console.error('[SUGGESTIONS] Erro Gemini:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────
app.get('/api/dashboard/:igId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const account = req.session.user.accounts.find(a => a.id === req.params.igId);
  if (!account) return res.status(404).json({ error: 'Not found' });

  const media = await fetchMedia(account.id, account.ig_token, 50);
  const now = new Date();

  const periods = { '7d': 7, '15d': 15, '30d': 30, '90d': 90 };
  const periodStats = {};
  for (const [key, days] of Object.entries(periods)) {
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
    const filtered = media.filter(m => new Date(m.timestamp) >= cutoff);
    const totalLikes = filtered.reduce((s, m) => s + (m.like_count||0), 0);
    const totalComments = filtered.reduce((s, m) => s + (m.comments_count||0), 0);
    periodStats[key] = {
      posts: filtered.length, likes: totalLikes, comments: totalComments,
      engagement: filtered.length ? ((totalLikes + totalComments) / filtered.length).toFixed(1) : 0,
      avgLikes: filtered.length ? Math.round(totalLikes / filtered.length) : 0,
      avgComments: filtered.length ? Math.round(totalComments / filtered.length) : 0
    };
  }

  const formatMix = media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type]||0)+1; return acc; }, {});

  const hourStats = {};
  media.forEach(m => {
    const h = new Date(m.timestamp).getHours();
    if (!hourStats[h]) hourStats[h] = { posts:0, likes:0, comments:0 };
    hourStats[h].posts++; hourStats[h].likes += m.like_count||0; hourStats[h].comments += m.comments_count||0;
  });
  const bestHours = Object.entries(hourStats)
    .map(([h,s]) => ({ hour: parseInt(h), avgEngagement: s.posts ? ((s.likes+s.comments)/s.posts).toFixed(1) : 0 }))
    .sort((a,b) => b.avgEngagement - a.avgEngagement).slice(0, 5);

  const dayNames = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const dayStats = {};
  media.forEach(m => {
    const d = new Date(m.timestamp).getDay();
    if (!dayStats[d]) dayStats[d] = { posts:0, likes:0, comments:0 };
    dayStats[d].posts++; dayStats[d].likes += m.like_count||0; dayStats[d].comments += m.comments_count||0;
  });
  const bestDays = Object.entries(dayStats)
    .map(([d,s]) => ({ day: dayNames[parseInt(d)], avgEngagement: s.posts ? ((s.likes+s.comments)/s.posts).toFixed(1) : 0 }))
    .sort((a,b) => b.avgEngagement - a.avgEngagement);

  const topPosts = [...media].sort((a,b) => ((b.like_count||0)+(b.comments_count||0)) - ((a.like_count||0)+(a.comments_count||0))).slice(0, 5);

  const engRate = account.followers_count && periodStats['30d'].posts ?
    ((periodStats['30d'].likes + periodStats['30d'].comments) / periodStats['30d'].posts / account.followers_count * 100).toFixed(2) : 0;

  const profileScore = Math.min(100,
    (account.biography ? 20 : 0) + (account.website ? 10 : 0) +
    (periodStats['30d'].posts >= 12 ? 30 : periodStats['30d'].posts >= 8 ? 20 : 10) +
    (engRate >= 3 ? 30 : engRate >= 1 ? 20 : 10) +
    (Object.keys(formatMix).length >= 3 ? 10 : 5)
  );

  const monthlyEvolution = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const nextD = new Date(now.getFullYear(), now.getMonth()-i+1, 1);
    const mm = media.filter(m => { const t = new Date(m.timestamp); return t >= d && t < nextD; });
    const ml = mm.reduce((s,m) => s+(m.like_count||0), 0);
    const mc = mm.reduce((s,m) => s+(m.comments_count||0), 0);
    monthlyEvolution.push({ month: d.toLocaleDateString('pt-BR',{month:'short',year:'2-digit'}), posts: mm.length, likes: ml, comments: mc, engagement: mm.length ? ((ml+mc)/mm.length).toFixed(1) : 0 });
  }

  res.json({ account, periodStats, formatMix, bestHours, bestDays, topPosts, profileScore, engRate, monthlyEvolution, totalMedia: media.length });
});

// ─── INTELLIGENCE ─────────────────────────────────────────────────────────
app.post('/api/intelligence', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!process.env.GEMINI_API_KEY) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY não configurada. Adicione a chave no painel de variáveis de ambiente do Railway/Render.' })}\n\n`);
    res.end();
    return;
  }
  const { igId, competitors, niche, location, goal } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  if (!account) return res.status(404).json({ error: 'Not found' });

  const budgetCheck = checkTokenBudget(5000);
  if (!budgetCheck.canProceed) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Orçamento de tokens esgotado', budget: budgetCheck })}\n\n`);
    res.end();
    return;
  }

  const media = await fetchMedia(account.id, account.ig_token, 20);
  const topCaptions = media.slice(0, 8).map(m => m.caption?.substring(0, 200)||'').filter(Boolean);
  const engStats = media.length ? { avgLikes: Math.round(media.reduce((s,m)=>s+(m.like_count||0),0)/media.length), avgComments: Math.round(media.reduce((s,m)=>s+(m.comments_count||0),0)/media.length) } : {};

  const prompt = `Você é um dos melhores estrategistas de marketing digital do Brasil, com profundo conhecimento em Instagram, comportamento do consumidor brasileiro e neuromarketing.

ANÁLISE DO PERFIL REAL @${account.username}:
- Nome: ${account.name}
- Seguidores: ${(account.followers_count||0).toLocaleString('pt-BR')}
- Posts: ${account.media_count} | Média curtidas: ${engStats.avgLikes||0} | Média comentários: ${engStats.avgComments||0}
- Bio: ${account.biography || 'Não informada'}
- Nicho identificado: ${niche}
- Localização: ${location || 'Brasil'}
- Objetivo: ${goal}
- Concorrentes mencionados: ${competitors || 'buscar automaticamente'}
- Exemplos reais de legendas: ${topCaptions.join(' /// ')}

IMPORTANTE: Fale diretamente com o dono do perfil. Use "você", "seu perfil", "seus seguidores". Seja específico, use os dados reais. Evite generalidades. Pense como um consultor de R$500/hora que conhece profundamente o nicho.

Retorne SOMENTE JSON válido (sem markdown, sem texto extra) com análise estratégica completa incluindo:
- market_intelligence: { seasonality: [{month, level, opportunity}], trends: [{trend, how_to_use}] }
- audience_intelligence: { ideal_profile, pain_map: [{pain, how_to_address}], desire_map: [{desire, content_angle}], journey_stage }
- competitive_intelligence: { likely_competitors: [], content_gaps: [{gap, opportunity}] }
- financial_intelligence: { follower_value_estimate, monthly_revenue_potential, monetization_opportunities: [], investment_priority }
- operational_intelligence: { content_repurposing: [{original, repurpose_to, tip}], production_calendar: {weekly_hours, batch_suggestion, best_production_day, tools_suggestion} }
- bio_optimized: [{version, bio, strategy, char_count}]
- strategic_score: { content_quality, posting_consistency, audience_alignment, growth_potential, overall, diagnosis, recommendations: [{priority, action, expected_result}] }`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: "application/json" }
    });
    const stream = await model.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192
      }
    });
    for await (const chunk of stream.stream) {
      const delta = chunk.text || '';
      if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`); }
    }
    const usageMetadata = stream.response.usageMetadata;
    recordTokenUsage(usageMetadata?.promptTokenCount || 0, usageMetadata?.candidatesTokenCount || 0);

    // Envia o texto limpo para o frontend processar
    let cleanedText = fullText;
    try {
      const parsed = cleanAndParseJSON(fullText);
      cleanedText = JSON.stringify(parsed);
    } catch (e) {
      console.warn('[INTELLIGENCE] Não foi possível pré-parsear JSON, enviando texto bruto limpo');
      cleanedText = fullText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    }

    res.write(`data: ${JSON.stringify({ type: 'done', fullText: cleanedText })}\n\n`);
    res.end();
  } catch (e) {
    console.error('[INTELLIGENCE] Erro:', e.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

// ─── GENERATE PLAN (COM FUNIL, LINHAS EDITORIAIS E HOOKS) ─────
app.post('/api/generate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!process.env.GEMINI_API_KEY) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY não configurada. Adicione a chave no painel de variáveis de ambiente do Railway/Render.' })}\n\n`);
    res.end();
    return;
  }
  const { igId, posts, reels, carousels, singlePosts, goal, tone, extra, objections, audience, niche, location } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);

  const budgetCheck = checkTokenBudget(8000);
  if (!budgetCheck.canProceed) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Orçamento de tokens esgotado', budget: budgetCheck })}\n\n`);
    res.end();
    return;
  }

  let profileContext = '', topPostsContext = '';
  if (account) {
    profileContext = `PERFIL REAL @${account.username}:
- Nome: ${account.name} | Seguidores: ${(account.followers_count||0).toLocaleString('pt-BR')} | Posts: ${account.media_count}
- Bio atual: ${account.biography || 'Não informada'} | Website: ${account.website || 'Não informado'}`;

    const media = await fetchMedia(account.id, account.ig_token, 12);
    if (media.length) {
      const avgLikes = Math.round(media.reduce((s,m)=>s+(m.like_count||0),0)/media.length);
      const avgComments = Math.round(media.reduce((s,m)=>s+(m.comments_count||0),0)/media.length);
      topPostsContext = `\nENGAJAMENTO REAL: Média ${avgLikes} curtidas e ${avgComments} comentários por post.\nÚLTIMOS POSTS:\n` +
        media.slice(0,6).map((m,i) => `${i+1}. [${m.media_type}] "${m.caption?.substring(0,100)||'Sem legenda'}" | ❤️${m.like_count||0} 💬${m.comments_count||0}`).join('\n');
    }
  }

  const now = new Date();
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  const totalPosts = parseInt(posts)||24;
  const totalReels = parseInt(reels)||Math.round(totalPosts*.4);
  const totalCarousels = parseInt(carousels)||Math.round(totalPosts*.35);
  const totalSingle = Math.max(0, totalPosts - totalReels - totalCarousels);

  const prompt = `Você é um estrategista de marketing digital e copywriter sênior, especializado no mercado brasileiro. Você conhece profundamente o comportamento do consumidor brasileiro, as tendências do Instagram e as técnicas de neuromarketing. Seu trabalho é criar planos de conteúdo que REALMENTE geram resultados.

${profileContext}
${topPostsContext}

BRIEFING DO PLANO:
- Nicho: ${niche}
- Localização: ${location || 'Brasil'}
- Público-alvo: ${audience}
- Objetivo principal do mês: ${goal}
- Tom de voz: ${tone}
- Mix de conteúdo: ${totalReels} Reels + ${totalCarousels} Carrosséis + ${totalSingle} Fotos = ${totalPosts} posts
- Mês: ${month} de ${year}
- Contexto/diferenciais: ${extra || 'Não informado'}
- Principais objeções: ${objections || 'Não informadas'}

DIRETRIZES DE QUALIDADE (OBRIGATÓRIO):
1. FUNIL DE 4 SEMANAS: S1=Atração (Reels virais, curiosidade), S2=Autoridade (Educação, prova social), S3=Conexão (Stories, humanização), S4=Conversão (Urgência, CTA claro)
2. LINHAS EDITORIAIS FIXAS: Defina 3 pilares de conteúdo que se repetem (ex: Educativo, Lifestyle, Prova Social)
3. GANCHOS MAGNÉTICOS: Cada post começa com uma frase que PARA o scroll — use curiosidade, medo, desejo ou surpresa
4. SCRIPTS FALADOS: Reels devem ser roteiros para GRAVAR, não textos — use linguagem oral, pausas, entonações
5. SLIDES COM PROGRESSÃO: Carrosséis devem ter lógica visual
6. CTAs ESPECÍFICOS: Nunca genéricos como "me chama no DM"
7. HISTÓRIAS DIÁRIAS: 30 sequências de Stories (uma por dia) com objetivo estratégico claro

FORMATO DE SAÍDA (OBRIGATÓRIO):
Retorne SOMENTE JSON puro e válido, sem markdown, sem blocos de código, sem texto antes ou depois. Estrutura exata:
{
  "audit": { "summary": "...", "month_strategy": "...", "engagement_analysis": "...", "differentials": ["..."], "positioning": "..." },
  "editorial_pillars": [{ "name": "...", "description": "...", "frequency": "..." }],
  "posts": [
    {
      "n": 1, "week": 1, "day_suggestion": "Segunda", "format": "Reels",
      "pillar": "Educativo", "title": "...", "objective": "...",
      "visual": "...", "hook": "...", "copy": "...", "cta": "...", "audio": "...",
      "script": "roteiro falado para gravar (apenas para Reels)",
      "carousel_slides": ["Slide 1: ...", "Slide 2: ..."]
    }
  ],
  "stories": [
    {
      "day": "Dia 1", "theme": "...", "objective": "...", "funnel_stage": "topo/meio/fundo",
      "slides": [{ "n": 1, "text": "...", "action": "...", "copy_detail": "..." }]
    }
  ],
  "hashtags": {
    "niche": ["#hashtag1", "#hashtag2"],
    "local": ["#cidade", "#estado"],
    "broad": ["#hashtag_ampla"],
    "strategy": "explicação da estratégia de hashtags"
  },
  "post_days": [1, 3, 5, 8, 10],
  "dates": [{ "day": 15, "name": "...", "relevance": "...", "content_idea": "..." }],
  "tips": [{ "icon": "💡", "title": "...", "text": "..." }]
}`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: "application/json" }
    });
    const stream = await model.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192
      }
    });
    for await (const chunk of stream.stream) {
      const delta = chunk.text || '';
      if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`); }
    }
    const usageMetadata = stream.response.usageMetadata;
    recordTokenUsage(usageMetadata?.promptTokenCount || 0, usageMetadata?.candidatesTokenCount || 0);

    // Pré-processa e valida o JSON antes de enviar ao frontend
    let finalText = fullText;
    try {
      const parsed = cleanAndParseJSON(fullText);
      const normalized = validateAndNormalizePlan(parsed);
      finalText = JSON.stringify(normalized);
      console.log(`[GENERATE] Plano gerado com sucesso: ${normalized.posts?.length || 0} posts, ${normalized.stories?.length || 0} stories`);
    } catch (parseErr) {
      console.error('[GENERATE] Erro de parse, enviando texto bruto:', parseErr.message);
      // Tenta pelo menos remover o markdown
      finalText = fullText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    }

    res.write(`data: ${JSON.stringify({ type: 'done', fullText: finalText })}\n\n`);
    res.end();
  } catch (e) {
    console.error('[GENERATE] Erro:', e.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/privacy.html', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'app.html'));
});

app.use((req, res) => {
  console.log(`[404] Rota não encontrada: ${req.url}`);
  res.status(404).sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Instagram Marketing Planner com Gemini 2.5 Flash + Token Control rodando em http://0.0.0.0:${PORT}`);
  console.log(`[SERVER] Base URL configurada: ${BASE_URL}`);
  console.log(`[SERVER] Orçamento mensal: $${MAX_MONTHLY_COST}`);
  console.log(`[SERVER] Diretório público: ${publicDir}`);
  console.log(`[SERVER] GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'CONFIGURADA ✅' : 'NÃO CONFIGURADA ❌ - A IA não funcionará!'}`);
  console.log(`[SERVER] IG_TOKENS: ${IG_TOKENS.length} token(s) configurado(s)`);
});
