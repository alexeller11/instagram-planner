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
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
  res.json({ logged: true, igAccounts: req.session.user.accounts });
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
    total_output_tokens: monthlyTokensUsed.output
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

Retorne APENAS JSON:
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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 1000
      }
    });
    const text = result.response.text();
    const inputTokens = result.response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = result.response.usageMetadata?.candidatesTokenCount || 0;
    recordTokenUsage(inputTokens, outputTokens);
    try { res.json(JSON.parse(text.replace(/```json|```/g,'').trim())); }
    catch { res.json({ error: text }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ─── INTELLIGENCE ─────────────────────────────────────────────
app.post('/api/intelligence', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
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

Retorne APENAS JSON válido com análise estratégica completa incluindo market intelligence, audience intelligence, competitive intelligence, financial intelligence, operational intelligence, bio otimizada e strategic score.`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const stream = await model.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 5000
      }
    });
    for await (const chunk of stream.stream) {
      const delta = chunk.text || '';
      if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`); }
    }
    const usageMetadata = stream.response.usageMetadata;
    recordTokenUsage(usageMetadata?.promptTokenCount || 0, usageMetadata?.candidatesTokenCount || 0);
    res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

// ─── GENERATE PLAN (COM FUNIL, LINHAS EDITORIAIS E HOOKS) ─────
app.post('/api/generate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
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

Retorne APENAS JSON válido com: audit, editorial_pillars, posts (com hooks, scripts, carousel_slides), stories, hashtags, post_days, event_days, tips.`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const stream = await model.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8000
      }
    });
    for await (const chunk of stream.stream) {
      const delta = chunk.text || '';
      if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`); }
    }
    const usageMetadata = stream.response.usageMetadata;
    recordTokenUsage(usageMetadata?.promptTokenCount || 0, usageMetadata?.candidatesTokenCount || 0);
    res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
    res.end();
  } catch (e) {
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
  console.log(`🚀 Instagram Marketing Planner com Gemini 2.0 Flash + Token Control rodando em http://0.0.0.0:${PORT}`);
  console.log(`[SERVER] Base URL configurada: ${BASE_URL}`);
  console.log(`[SERVER] Orçamento mensal: $${MAX_MONTHLY_COST}`);
  console.log(`[SERVER] Diretório público: ${publicDir}`);
});
