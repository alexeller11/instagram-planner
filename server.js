require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const Groq = require('groq-sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IG_TOKENS = (process.env.IG_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(publicDir));
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
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', max_tokens: 1000, temperature: 0.7,
      messages: [
        { role: 'system', content: 'Responda APENAS com JSON válido, sem markdown.' },
        { role: 'user', content: prompt }
      ]
    });
    const text = completion.choices[0]?.message?.content || '{}';
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

Retorne APENAS JSON válido:
{
  "market_intelligence": {
    "niche_detected": "nicho específico e detalhado",
    "niche_analysis": "análise de 3-4 linhas sobre o nicho no mercado brasileiro atual, oportunidades e desafios reais",
    "seasonality": [
      {"month": "Janeiro", "level": "alto", "reason": "motivo específico para o nicho", "opportunity": "ação concreta que pode ser tomada"}
    ],
    "trends": [
      {"trend": "tendência específica", "how_to_use": "como aplicar no conteúdo"}
    ],
    "market_benchmark": {"avg_engagement": "X%", "avg_posts_month": "N", "top_formats": ["Reels", "Carrossel"], "insight": "o que isso significa para este perfil"}
  },
  "audience_intelligence": {
    "ideal_profile": "descrição detalhada e humanizada do cliente ideal — nome fictício, idade, profissão, rotina, dores",
    "pain_map": [
      {"pain": "dor específica", "how_to_address": "como o conteúdo pode resolver isso"}
    ],
    "desire_map": [
      {"desire": "desejo específico", "content_angle": "ângulo de conteúdo para explorar"}
    ],
    "journey_stage": "qual estágio predomina e por quê",
    "psychographic": {"values": ["valor 1","valor 2"], "fears": ["medo 1","medo 2"], "motivations": ["motivação 1","motivação 2"], "language": "como esta audiência fala — gírias, expressões, tom"}
  },
  "competitive_intelligence": {
    "likely_competitors": ["@concorrente1 — por que é concorrente", "@concorrente2", "@concorrente3"],
    "content_gaps": [
      {"gap": "tema não explorado", "opportunity": "como transformar isso em conteúdo", "format": "formato ideal"}
    ],
    "differentiation_opportunities": ["oportunidade 1 específica", "oportunidade 2", "oportunidade 3"],
    "positioning_suggestion": "posicionamento único e específico para este perfil no mercado local"
  },
  "financial_intelligence": {
    "follower_value_estimate": "R$ X,XX — explique o cálculo para o nicho",
    "monthly_revenue_potential": "estimativa de receita mensal com X seguidores neste nicho",
    "content_roi_by_format": [
      {"format": "Reels", "roi_description": "por que gera mais X no nicho"},
      {"format": "Carrossel", "roi_description": "benefício específico"},
      {"format": "Foto", "roi_description": "quando usar"}
    ],
    "monetization_opportunities": ["oportunidade 1 detalhada", "oportunidade 2", "oportunidade 3"],
    "investment_priority": "onde investir primeiro — seja específico com valores e ações"
  },
  "operational_intelligence": {
    "content_repurposing": [
      {"original": "tipo de conteúdo original", "repurpose_to": ["formato 1", "formato 2"], "tip": "como fazer na prática"}
    ],
    "production_calendar": {
      "weekly_hours": "X horas",
      "batch_suggestion": "gravar X vídeos + Y fotos numa sessão de Z horas",
      "best_production_day": "dia ideal e por quê",
      "tools_suggestion": "ferramentas gratuitas ou baratas para este nicho"
    },
    "alert_thresholds": {
      "engagement_drop": "abaixo de X% = alerta",
      "posting_gap": "mais de X dias sem post = queda no alcance"
    }
  },
  "bio_optimized": [
    {
      "version": "Autoridade",
      "bio": "bio completa — máximo 150 caracteres COM emojis, quebra de linha com \\n, CTA com link",
      "strategy": "por que esta versão funciona",
      "char_count": 0
    },
    {
      "version": "Conexão",
      "bio": "bio focada em conexão emocional — máximo 150 caracteres",
      "strategy": "por que esta versão funciona",
      "char_count": 0
    },
    {
      "version": "Conversão",
      "bio": "bio focada em conversão direta — máximo 150 caracteres",
      "strategy": "por que esta versão funciona",
      "char_count": 0
    }
  ],
  "strategic_score": {
    "overall": 75,
    "content_quality": 70,
    "posting_consistency": 80,
    "audience_alignment": 65,
    "growth_potential": 85,
    "diagnosis": "diagnóstico honesto e humanizado em 3-4 linhas — o que está funcionando, o que precisa melhorar",
    "recommendations": [
      {"priority": 1, "action": "ação específica e imediata", "expected_result": "resultado esperado em X semanas"},
      {"priority": 2, "action": "ação de médio prazo", "expected_result": "resultado esperado"},
      {"priority": 3, "action": "ação de longo prazo", "expected_result": "resultado esperado"}
    ]
  }
}`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', max_tokens: 5000, temperature: 0.75, stream: true,
      messages: [
        { role: 'system', content: 'Você é um consultor de marketing digital sênior brasileiro. Responda APENAS com JSON válido, sem markdown, sem texto fora do JSON. Seja específico, humanizado e direto.' },
        { role: 'user', content: prompt }
      ]
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`); }
    }
    res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

// ─── GENERATE PLAN ────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const { igId, posts, reels, carousels, singlePosts, goal, tone, extra, objections, audience, niche, location } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);

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

  const prompt = `Você é um estrategista de marketing digital e copywriter sênior, especializado no mercado brasileiro. Você conhece profundamente o comportamento do consumidor brasileiro, as tendências do Instagram e as técnicas de neuromarketing. Seu trabalho é criar planos de conteúdo que REALMENTE geram resultados — não apenas listas de posts.

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
1. Tom humanizado: escreva as legendas como se fossem escritas pelo próprio dono do perfil, não por uma IA. Use a primeira pessoa, seja natural, mostre personalidade.
2. Cada post deve ter uma RAZÃO ESTRATÉGICA clara para existir no funil de vendas.
3. As legendas devem ter GANCHOS poderosos na primeira linha — algo que pare o scroll.
4. Os CTAs devem ser específicos e variados — nunca genéricos como "me chama no DM".
5. Os scripts de Reels devem ser FALADOS, não escritos — use linguagem oral, pausas, entonações.
6. Os slides de carrossel devem ter progressão lógica — o leitor deve sentir que precisa ver o próximo.
7. Distribua em 4 semanas respeitando a jornada: S1=Atenção/Curiosidade, S2=Autoridade/Educação, S3=Conexão/Prova Social, S4=Urgência/Conversão.

Retorne APENAS JSON válido:
{
  "audit": {
    "summary": "análise de 4-5 linhas falando DIRETAMENTE com o dono do perfil — use 'você', mencione dados reais dos posts, seja específico. Ex: Olhando seus números, vejo que seus posts de [tipo] estão performando X% acima da média...",
    "differentials": ["diferencial específico detectado nos posts", "diferencial 2", "diferencial 3"],
    "positioning": "posicionamento detalhado: como se destacar dos concorrentes locais em ${location||'sua cidade'} com ações práticas",
    "engagement_analysis": "análise humanizada do engajamento real — o que está funcionando e por quê, com base nos dados",
    "month_strategy": "estratégia específica para ${month} — por que este mês é importante para este nicho e como aproveitar"
  },
  "dates": [
    {"day": 8, "name": "nome da data", "relevance": "por que é relevante para este nicho específico", "content_idea": "ideia criativa e específica de post"}
  ],
  "posts": [
    {
      "n": 1,
      "week": 1,
      "day_suggestion": "Terça",
      "format": "Reels",
      "pillar": "Educação",
      "title": "título chamativo para o conteúdo (máx 60 chars) — como seria o título de um YouTube",
      "objective": "objetivo estratégico específico no funil",
      "visual": "descrição cinematográfica da cena — ambiente, iluminação, roupa, expressão, movimentos. Detalhe o suficiente para alguém gravar sem dúvida",
      "copy": "legenda COMPLETA pronta para publicar, 8-12 linhas. Primeiro linha = GANCHO que para o scroll. Use emojis estrategicamente (não excessivamente). Tom natural, como o dono do perfil falaria. Termine com pergunta ou reflexão antes do CTA.",
      "cta": "CTA específico e criativo — não use 'me chama no DM' genérico. Ex: 'Comenta QUERO aqui embaixo que te mando o link'",
      "audio": "descrição do sentimento/energia da música — ritmo, instrumento, mood. Ex: 'Lo-fi animado, algo como um café estiloso numa manhã produtiva'",
      "script": "script FALADO completo para o Reels (30-45s). Formato: [0-3s GANCHO]: frase que prende. [3-15s DESENVOLVIMENTO]: conteúdo. [15-25s VIRADA]: surpresa ou dado. [25-35s CTA]: chamada clara. Use // para indicar pausa. Use CAPS para ênfase.",
      "carousel_slides": ["Slide 1: título impactante (máx 8 palavras)", "Slide 2: ponto principal", "Slide 3: desenvolvimento", "Slide 4: prova ou exemplo", "Slide 5: continuação", "Slide 6: conclusão", "Slide 7: CTA direto"]
    }
  ],
  "stories": [
    {
      "week": 1,
      "day": "Segunda-feira",
      "theme": "tema estratégico da sequência",
      "objective": "objetivo desta sequência de stories",
      "funnel_stage": "topo/meio/fundo",
      "slides": [
        {
          "n": 1,
          "text": "texto curto e impactante (máx 15 palavras)",
          "action": "enquete / caixa de perguntas / link / reação / quiz / contagem regressiva",
          "tip": "dica de design: cor de fundo, fonte, elemento visual sugerido",
          "copy_detail": "detalhe do que escrever ou falar neste slide"
        }
      ]
    }
  ],
  "hashtags": {
    "niche": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],
    "local": ["#tag1","#tag2","#tag3","#tag4","#tag5"],
    "broad": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7"],
    "strategy": "estratégia detalhada — quantas usar, como combinar, quando variar. Seja específico para o nicho e cidade."
  },
  "post_days": [3,5,7,9,12,14,16,19,21,23,26,28],
  "event_days": [],
  "tips": [
    {"icon": "🔥", "title": "Dica de Ouro do Mês", "text": "dica específica e acionável para ${month} neste nicho"},
    {"icon": "📈", "title": "Como Crescer em ${location||'sua cidade'}", "text": "estratégia local específica com ações práticas"},
    {"icon": "💰", "title": "Gatilho de Vendas para Este Público", "text": "o gatilho mental mais efetivo e como usar nos posts"},
    {"icon": "🎯", "title": "Horário e Frequência Ideal", "text": "quando e com que frequência postar para este nicho e público"},
    {"icon": "🤝", "title": "Parceria Estratégica", "text": "com quem fazer parceria neste nicho e como abordar"},
    {"icon": "♻️", "title": "Reaproveitamento de Conteúdo", "text": "como transformar 1 post em 5 peças de conteúdo para este nicho"},
    {"icon": "📊", "title": "Métrica que Importa Este Mês", "text": "qual número acompanhar e o que fazer se cair"}
  ]
}

REGRAS CRÍTICAS:
- EXATAMENTE ${totalPosts} posts: ${totalReels} Reels, ${totalCarousels} Carrosséis, ${totalSingle} Fotos
- EXATAMENTE 30 sequências de Stories (uma para cada dia do mês, distribuídas estrategicamente)
- Scripts FALADOS para TODOS os Reels — linguagem oral, não escrita
- Slides para TODOS os Carrosséis (mínimo 7 slides cada)
- Legendas prontas para publicar — copy REAL, não descrição do que escrever
- NUNCA use frases genéricas como "me conta nos comentários" sem contexto específico`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', max_tokens: 8000, temperature: 0.8, stream: true,
      messages: [
        { role: 'system', content: 'Você é um dos melhores estrategistas de conteúdo e copywriters do Brasil. Cria planos de marketing que realmente funcionam. Responda APENAS com JSON válido, sem markdown. Seja humanizado, específico e estratégico em tudo.' },
        { role: 'user', content: prompt }
      ]
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) { fullText += delta; res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`); }
    }
    res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/app', (req, res) => { if (!req.session.user) return res.redirect('/'); res.sendFile(path.join(publicDir, 'app.html')); });
app.listen(PORT, () => console.log(`🚀 Social Planner v4 rodando em ${BASE_URL}`));
