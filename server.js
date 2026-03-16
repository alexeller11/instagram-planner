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
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { secure: false, maxAge: 24*60*60*1000 } }));

// ─── FETCH IG PROFILES ───────────────────────────────────────
async function fetchIGProfiles(tokens) {
  const accounts = [];
  for (const token of tokens) {
    try {
      const res = await axios.get('https://graph.instagram.com/v21.0/me', {
        params: { fields: 'id,name,username,followers_count,media_count,biography,website,profile_picture_url,account_type,category', access_token: token }
      });
      accounts.push({ ...res.data, ig_token: token });
      console.log(`[IG] @${res.data.username} | ${res.data.followers_count} seguidores | categoria: ${res.data.category}`);
    } catch (e) { console.log(`[IG_ERR] ${e.response?.data?.error?.message || e.message}`); }
  }
  return accounts;
}

// ─── FETCH MEDIA INSIGHTS ────────────────────────────────────
async function fetchMediaInsights(igId, token, limit = 20) {
  try {
    const res = await axios.get(`https://graph.instagram.com/v21.0/${igId}/media`, {
      params: { fields: 'id,caption,media_type,timestamp,like_count,comments_count,thumbnail_url,media_url', limit, access_token: token }
    });
    return res.data.data || [];
  } catch (e) { return []; }
}

// ─── ROUTES ──────────────────────────────────────────────────
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

// ─── DASHBOARD DATA ──────────────────────────────────────────
app.get('/api/dashboard/:igId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const account = req.session.user.accounts.find(a => a.id === req.params.igId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const media = await fetchMediaInsights(account.id, account.ig_token, 50);
    const now = new Date();

    // Calcular métricas por período
    const periods = { '7d': 7, '15d': 15, '30d': 30, '90d': 90 };
    const periodStats = {};
    for (const [key, days] of Object.entries(periods)) {
      const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
      const filtered = media.filter(m => new Date(m.timestamp) >= cutoff);
      const totalLikes = filtered.reduce((s, m) => s + (m.like_count || 0), 0);
      const totalComments = filtered.reduce((s, m) => s + (m.comments_count || 0), 0);
      periodStats[key] = {
        posts: filtered.length,
        likes: totalLikes,
        comments: totalComments,
        engagement: filtered.length ? ((totalLikes + totalComments) / filtered.length).toFixed(1) : 0,
        avgLikes: filtered.length ? Math.round(totalLikes / filtered.length) : 0,
        avgComments: filtered.length ? Math.round(totalComments / filtered.length) : 0
      };
    }

    // Mix de formatos
    const formatMix = media.reduce((acc, m) => {
      acc[m.media_type] = (acc[m.media_type] || 0) + 1;
      return acc;
    }, {});

    // Melhores horários
    const hourStats = {};
    media.forEach(m => {
      const hour = new Date(m.timestamp).getHours();
      if (!hourStats[hour]) hourStats[hour] = { posts: 0, likes: 0, comments: 0 };
      hourStats[hour].posts++;
      hourStats[hour].likes += m.like_count || 0;
      hourStats[hour].comments += m.comments_count || 0;
    });
    const bestHours = Object.entries(hourStats)
      .map(([h, s]) => ({ hour: parseInt(h), avgEngagement: s.posts ? ((s.likes + s.comments) / s.posts).toFixed(1) : 0 }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement)
      .slice(0, 5);

    // Melhores dias da semana
    const dayStats = {};
    const dayNames = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    media.forEach(m => {
      const day = new Date(m.timestamp).getDay();
      if (!dayStats[day]) dayStats[day] = { posts: 0, likes: 0, comments: 0 };
      dayStats[day].posts++;
      dayStats[day].likes += m.like_count || 0;
      dayStats[day].comments += m.comments_count || 0;
    });
    const bestDays = Object.entries(dayStats)
      .map(([d, s]) => ({ day: dayNames[parseInt(d)], avgEngagement: s.posts ? ((s.likes + s.comments) / s.posts).toFixed(1) : 0 }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // Top posts
    const topPosts = [...media].sort((a, b) => ((b.like_count||0) + (b.comments_count||0)) - ((a.like_count||0) + (a.comments_count||0))).slice(0, 5);

    // Score do perfil
    const engRate = account.followers_count ? ((periodStats['30d'].likes + periodStats['30d'].comments) / Math.max(periodStats['30d'].posts, 1) / account.followers_count * 100).toFixed(2) : 0;
    const hassBio = account.biography ? 20 : 0;
    const hasWebsite = account.website ? 10 : 0;
    const postFreq = periodStats['30d'].posts >= 12 ? 30 : periodStats['30d'].posts >= 8 ? 20 : periodStats['30d'].posts >= 4 ? 10 : 0;
    const engScore = engRate >= 3 ? 30 : engRate >= 1 ? 20 : engRate >= 0.5 ? 10 : 0;
    const mixScore = Object.keys(formatMix).length >= 3 ? 10 : Object.keys(formatMix).length >= 2 ? 5 : 0;
    const profileScore = Math.min(100, hassBio + hasWebsite + postFreq + engScore + mixScore);

    // Evolução mensal (últimos 6 meses)
    const monthlyEvolution = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const nextD = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const monthMedia = media.filter(m => { const t = new Date(m.timestamp); return t >= d && t < nextD; });
      const mLikes = monthMedia.reduce((s, m) => s + (m.like_count || 0), 0);
      const mComments = monthMedia.reduce((s, m) => s + (m.comments_count || 0), 0);
      monthlyEvolution.push({
        month: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
        posts: monthMedia.length,
        likes: mLikes,
        comments: mComments,
        engagement: monthMedia.length ? ((mLikes + mComments) / monthMedia.length).toFixed(1) : 0
      });
    }

    res.json({ account, periodStats, formatMix, bestHours, bestDays, topPosts, profileScore, engRate, monthlyEvolution, totalMedia: media.length });
  } catch (e) {
    console.error('[DASHBOARD_ERR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── STRATEGIC INTELLIGENCE (IA) ─────────────────────────────
app.post('/api/intelligence', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const { igId, competitors, niche, location, goal } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  if (!account) return res.status(404).json({ error: 'Not found' });

  const media = await fetchMediaInsights(account.id, account.ig_token, 20);
  const topCaptions = media.slice(0, 5).map(m => m.caption?.substring(0, 200) || '').filter(Boolean);

  const prompt = `Você é um estrategista de marketing digital e inteligência de mercado sênior para o mercado brasileiro.

PERFIL REAL:
- @${account.username} | ${account.name}
- Categoria: ${account.category || niche}
- Seguidores: ${(account.followers_count||0).toLocaleString('pt-BR')}
- Posts totais: ${account.media_count}
- Bio: ${account.biography || 'Não informada'}
- Localização: ${location || 'Brasil'}
- Objetivo: ${goal || 'Crescimento geral'}
- Concorrentes informados: ${competitors || 'Não informados'}
- Últimas legendas: ${topCaptions.join(' | ')}

Retorne APENAS JSON válido:
{
  "market_intelligence": {
    "niche_detected": "nicho específico detectado automaticamente",
    "seasonality": [
      {"month": "Janeiro", "level": "alto/médio/baixo", "reason": "por que este mês é importante para o nicho", "opportunity": "oportunidade específica"}
    ],
    "trends": ["tendência 1 atual do nicho", "tendência 2", "tendência 3", "tendência 4", "tendência 5"],
    "market_benchmark": {"avg_engagement": "X%", "avg_posts_month": "N", "top_formats": ["Reels", "Carrossel"]}
  },
  "audience_intelligence": {
    "ideal_profile": "descrição do cliente ideal para este nicho",
    "pain_map": ["dor principal 1", "dor 2", "dor 3", "dor 4", "dor 5"],
    "desire_map": ["desejo 1", "desejo 2", "desejo 3", "desejo 4", "desejo 5"],
    "journey_stage": "consciência/consideração/decisão — onde está a maioria dos seguidores",
    "psychographic": {"values": ["valor 1", "valor 2"], "fears": ["medo 1", "medo 2"], "motivations": ["motivação 1", "motivação 2"]}
  },
  "competitive_intelligence": {
    "content_gaps": ["tema não explorado 1", "tema 2", "tema 3", "tema 4"],
    "differentiation_opportunities": ["oportunidade 1", "oportunidade 2", "oportunidade 3"],
    "competitor_weaknesses": ["fraqueza comum no nicho 1", "fraqueza 2"],
    "positioning_suggestion": "como se posicionar de forma única neste nicho"
  },
  "financial_intelligence": {
    "follower_value_estimate": "R$ X,XX por seguidor estimado para este nicho",
    "content_roi_estimate": "projeção de retorno por tipo de post",
    "monetization_opportunities": ["oportunidade 1", "oportunidade 2", "oportunidade 3"],
    "investment_priority": "onde investir primeiro para maior retorno"
  },
  "operational_intelligence": {
    "content_repurposing": [
      {"original": "tipo de conteúdo", "repurpose_to": ["formato 1", "formato 2"], "tip": "como reaproveitar"}
    ],
    "production_calendar": {"weekly_hours": "X horas/semana estimadas", "batch_suggestion": "gravar X conteúdos por sessão", "best_production_day": "dia ideal para produção"},
    "alert_thresholds": {"engagement_drop": "X% abaixo da média = alerta", "posting_gap": "X dias sem post = alerta"}
  },
  "bio_optimized": "bio otimizada de até 150 caracteres para este nicho com emoji e CTA",
  "strategic_score": {
    "overall": 75,
    "content_quality": 70,
    "posting_consistency": 80,
    "audience_alignment": 65,
    "growth_potential": 85,
    "recommendations": ["recomendação prioritária 1", "recomendação 2", "recomendação 3"]
  }
}`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', max_tokens: 4000, temperature: 0.7, stream: true,
      messages: [
        { role: 'system', content: 'Responda APENAS com JSON válido, sem markdown.' },
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

// ─── GENERATE PLAN ───────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const { igId, posts, reels, carousels, singlePosts, goal, tone, extra, objections, audience, niche, location } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);

  let profileContext = '', topPostsContext = '';
  if (account) {
    profileContext = `Perfil @${account.username}: ${(account.followers_count||0).toLocaleString('pt-BR')} seguidores | ${account.media_count} posts | Categoria: ${account.category || niche} | Bio: ${account.biography || 'N/A'}`;
    const media = await fetchMediaInsights(account.id, account.ig_token, 6);
    if (media.length) {
      topPostsContext = '\nÚltimos posts: ' + media.map((m,i) => `${i+1}.[${m.media_type}] ${m.caption?.substring(0,100)||'Sem legenda'} | ❤️${m.like_count||0} 💬${m.comments_count||0}`).join(' | ');
    }
  }

  const now = new Date();
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const month = months[now.getMonth()];
  const totalPosts = parseInt(posts) || 24;
  const totalReels = parseInt(reels) || Math.round(totalPosts * 0.4);
  const totalCarousels = parseInt(carousels) || Math.round(totalPosts * 0.35);
  const totalSingle = totalPosts - totalReels - totalCarousels;

  const prompt = `Você é um Estrategista de Marketing Digital Sênior para o mercado brasileiro.

${profileContext}
${topPostsContext}

PLANO: Nicho: ${niche||account?.category||'N/A'} | Local: ${location||'Brasil'} | Público: ${audience||'N/A'} | Objetivo: ${goal} | Tom: ${tone} | Mês: ${month}/${now.getFullYear()}
MIX: ${totalReels} Reels + ${totalCarousels} Carrosséis + ${totalSingle} Fotos = ${totalPosts} posts totais
Objeções: ${objections||'N/A'} | Contexto: ${extra||'N/A'}

Retorne APENAS JSON válido:
{
  "audit": {
    "summary": "análise humanizada com dados reais — use Olhando seus números...",
    "differentials": ["dif1","dif2","dif3"],
    "positioning": "posicionamento vs concorrentes locais",
    "engagement_analysis": "análise do engajamento dos posts recentes"
  },
  "dates": [{"day":8,"name":"nome","relevance":"relevância","content_idea":"ideia"}],
  "posts": [
    {
      "n":1,"week":1,"day_suggestion":"Terça","format":"Reels","pillar":"Educação",
      "title":"Título chamativo para o conteúdo (max 60 chars)",
      "objective":"objetivo específico",
      "visual":"descrição detalhada da cena/design",
      "copy":"legenda completa 6-10 linhas AIDA/PAS com emojis",
      "cta":"CTA específico e criativo",
      "audio":"estilo musical",
      "script":"script linha a linha 30-45s (só Reels)",
      "carousel_slides":["slide 1 texto","slide 2","slide 3"] 
    }
  ],
  "stories": [
    {
      "week":1,"day":"Terça-feira","theme":"tema","objective":"objetivo",
      "slides":[{"n":1,"text":"texto impactante","action":"enquete/pergunta/link","tip":"dica design"}]
    }
  ],
  "hashtags": {
    "niche":["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],
    "local":["#tag1","#tag2","#tag3","#tag4","#tag5"],
    "broad":["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7"],
    "strategy":"estratégia de uso"
  },
  "post_days":[3,5,7,9,12,14,16,19,21,23,26,28],
  "event_days":[],
  "tips":[
    {"icon":"🔥","title":"Dica de Ouro","text":"dica específica"},
    {"icon":"📈","title":"Crescimento","text":"estratégia local"},
    {"icon":"💰","title":"Gatilho de Vendas","text":"gatilho efetivo"},
    {"icon":"🎯","title":"Melhores Horários","text":"dias e horários"},
    {"icon":"🤝","title":"Parcerias","text":"parceiros locais"},
    {"icon":"♻️","title":"Reaproveitamento","text":"como reaproveitar conteúdo"},
    {"icon":"📊","title":"Métrica Chave","text":"qual métrica acompanhar este mês"}
  ]
}
REGRAS: EXATAMENTE ${totalPosts} posts (${totalReels} Reels, ${totalCarousels} Carrosséis, ${totalSingle} Fotos). Funil: S1=Atenção, S2=Autoridade, S3=Conexão, S4=Conversão. 8+ Stories. Scripts completos para todos Reels. Slides para todos Carrosséis (mín 5 slides). Copy REAL 6-10 linhas. SEMPRE inclua "title" em cada post.`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let fullText = '';
    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', max_tokens: 8000, temperature: 0.7, stream: true,
      messages: [
        { role: 'system', content: 'Responda APENAS com JSON válido, sem markdown, sem texto fora do JSON.' },
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
app.listen(PORT, () => console.log(`🚀 Social Planner v3 rodando em ${BASE_URL}`));
