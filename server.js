require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const Groq = require('groq-sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ────────────────────────────────────────────────
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── MIDDLEWARE ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const fs = require('fs');
const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(publicDir));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── AUTH ROUTES ────────────────────────────────────────────
app.get('/auth/instagram', (req, res) => {
  // Escopos válidos para Facebook Login — pega páginas e contas Instagram vinculadas
  const scopes = [
    'public_profile',
    'email',
    'pages_show_list',
    'pages_read_engagement',
    'business_management'
  ].join(',');

  const url = `https://www.facebook.com/v21.0/dialog/oauth?` +
    `client_id=${FB_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&response_type=code`;

  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect('/?error=auth_failed');
  }

  try {
    // Trocar code por access_token
    const tokenRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      }
    });
    const shortToken = tokenRes.data.access_token;

    // Trocar por long-lived token
    const longRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortToken
      }
    });
    const longToken = longRes.data.access_token;

    // Buscar páginas do Facebook vinculadas
    const pagesRes = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: { access_token: longToken, fields: 'id,name,access_token,instagram_business_account' }
    });

    const pages = pagesRes.data.data || [];
    console.log(`[AUTH] Páginas encontradas: ${pages.length}`);
    pages.forEach(p => console.log(`[PAGE] ${p.name} | IG: ${JSON.stringify(p.instagram_business_account)}`));

    const igAccounts = [];

    for (const page of pages) {
      // Tenta instagram_business_account primeiro, depois connected_instagram_account
      let igId = page.instagram_business_account?.id;

      // Se não tem IG no campo direto, tenta buscar via página
      if (!igId) {
        try {
          const pageDetailRes = await axios.get(`https://graph.facebook.com/v21.0/${page.id}`, {
            params: {
              fields: 'instagram_business_account,connected_instagram_account',
              access_token: page.access_token
            }
          });
          igId = pageDetailRes.data.instagram_business_account?.id || 
                 pageDetailRes.data.connected_instagram_account?.id;
          console.log(`[PAGE_DETAIL] ${page.name} => igId: ${igId}`);
        } catch(e) {
          console.log(`[PAGE_DETAIL_ERR] ${page.name}: ${e.message}`);
        }
      }

      if (igId) {
        try {
          const igRes = await axios.get(`https://graph.facebook.com/v21.0/${igId}`, {
            params: {
              fields: 'id,name,username,profile_picture_url,followers_count,media_count,biography,website',
              access_token: page.access_token
            }
          });
          console.log(`[IG] Encontrado: @${igRes.data.username}`);
          igAccounts.push({
            ...igRes.data,
            page_name: page.name,
            page_token: page.access_token
          });
        } catch(e) {
          console.log(`[IG_ERR] ${igId}: ${e.response?.data || e.message}`);
        }
      }
    }

    // Se ainda não achou nada, tenta via /me com token longo
    if (igAccounts.length === 0) {
      console.log('[AUTH] Nenhum IG via páginas. Tentando via businesses...');
      try {
        const bizRes = await axios.get('https://graph.facebook.com/v21.0/me/businesses', {
          params: { access_token: longToken, fields: 'id,name,instagram_business_accounts' }
        });
        const bizzes = bizRes.data.data || [];
        console.log(`[BIZ] Businesses: ${bizzes.length}`);
        for (const biz of bizzes) {
          const igList = biz.instagram_business_accounts?.data || [];
          for (const ig of igList) {
            try {
              const igRes = await axios.get(`https://graph.facebook.com/v21.0/${ig.id}`, {
                params: {
                  fields: 'id,name,username,profile_picture_url,followers_count,media_count,biography,website',
                  access_token: longToken
                }
              });
              console.log(`[IG_BIZ] Encontrado: @${igRes.data.username}`);
              igAccounts.push({ ...igRes.data, page_name: biz.name, page_token: longToken });
            } catch(e) {
              console.log(`[IG_BIZ_ERR] ${e.message}`);
            }
          }
        }
      } catch(e) {
        console.log(`[BIZ_ERR] ${e.response?.data || e.message}`);
      }
    }

    console.log(`[AUTH] Total IG accounts: ${igAccounts.length}`);
    req.session.user = { longToken, pages, igAccounts };
    res.redirect('/app');
  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect('/?error=token_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── API ROUTES ──────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  res.json({ logged: true, igAccounts: req.session.user.igAccounts });
});

// Buscar insights reais do perfil
app.get('/api/insights/:igId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { igId } = req.params;
  const account = req.session.user.igAccounts.find(a => a.id === igId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    // Buscar métricas do perfil
    const [profileRes, mediaRes] = await Promise.all([
      axios.get(`https://graph.facebook.com/v21.0/${igId}/insights`, {
        params: {
          metric: 'follower_count,impressions,reach,profile_views',
          period: 'day',
          since: Math.floor(Date.now()/1000) - 30*24*3600,
          until: Math.floor(Date.now()/1000),
          access_token: account.page_token
        }
      }).catch(() => ({ data: { data: [] } })),

      axios.get(`https://graph.facebook.com/v21.0/${igId}/media`, {
        params: {
          fields: 'id,caption,media_type,timestamp,like_count,comments_count,insights.metric(reach,impressions,saved,video_views)',
          limit: 12,
          access_token: account.page_token
        }
      }).catch(() => ({ data: { data: [] } }))
    ]);

    res.json({
      profile: account,
      insights: profileRes.data.data || [],
      recentMedia: mediaRes.data.data || []
    });
  } catch (err) {
    console.error('Insights error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch insights', details: err.response?.data });
  }
});

// Gerar plano com IA + dados reais
app.post('/api/generate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { igId, posts, goal, tone, extra, objections, audience, niche, location } = req.body;
  const account = req.session.user.igAccounts.find(a => a.id === igId);

  let profileContext = '';
  let topPostsContext = '';

  if (account) {
    profileContext = `
Dados REAIS do perfil @${account.username}:
- Nome: ${account.name}
- Seguidores: ${account.followers_count?.toLocaleString('pt-BR') || 'N/A'}
- Posts publicados: ${account.media_count || 'N/A'}
- Bio: ${account.biography || 'Não informada'}
- Website: ${account.website || 'Não informado'}`;

    // Buscar posts recentes para análise
    try {
      const mediaRes = await axios.get(`https://graph.facebook.com/v21.0/${igId}/media`, {
        params: {
          fields: 'caption,media_type,like_count,comments_count,timestamp',
          limit: 6,
          access_token: account.page_token
        }
      });
      const media = mediaRes.data.data || [];
      if (media.length > 0) {
        topPostsContext = '\n\nÚltimos posts publicados (use para entender o estilo atual):\n' +
          media.map((m, i) => `${i+1}. [${m.media_type}] ${m.caption?.substring(0, 120) || 'Sem legenda'}... | ❤️ ${m.like_count || 0} | 💬 ${m.comments_count || 0}`).join('\n');
      }
    } catch (e) {}
  }

  const now = new Date();
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const month = months[now.getMonth()];
  const year = now.getFullYear();

  const prompt = `Você é um Estrategista de Marketing Digital Sênior especializado em Instagram, Neuromarketing e Copywriting para o mercado brasileiro.

${profileContext}
${topPostsContext}

DADOS DO PLANO:
- Nicho: ${niche || account?.name || 'Não informado'}
- Localização: ${location || 'Brasil'}
- Público-alvo: ${audience || 'Não informado'}
- Quantidade de posts: ${posts}
- Objetivo do mês: ${goal}
- Tom de voz: ${tone}
- Contexto/Diferenciais: ${extra || 'Nenhum'}
- Objeções do cliente: ${objections || 'Não informadas'}
- Mês: ${month}/${year}

Retorne APENAS JSON válido com esta estrutura:

{
  "audit": {
    "summary": "Análise humanizada e específica baseada nos dados reais do perfil. Mencione os seguidores, engajamento dos últimos posts e oportunidades concretas. Use frases como Olhando seus números... e Com ${account?.followers_count || 'seus'} seguidores...",
    "differentials": ["diferencial 1 específico", "diferencial 2", "diferencial 3"],
    "positioning": "Como se posicionar vs concorrentes locais em ${location || 'sua cidade'}",
    "engagement_analysis": "Análise do engajamento médio dos últimos posts e o que funciona melhor"
  },
  "dates": [
    {"day": 8, "name": "Nome da data comemorativa", "relevance": "Por que é relevante para este nicho", "content_idea": "Ideia específica de post"}
  ],
  "posts": [
    {
      "n": 1, "week": 1, "day_suggestion": "Terça",
      "format": "Reels",
      "pillar": "Educação",
      "objective": "Quebra de objeção: [objeção específica do cliente]",
      "visual": "Descrição detalhada e específica da cena",
      "copy": "Legenda completa de 6-10 linhas com AIDA/PAS. Tom natural, emojis estratégicos. Copy REAL que converte.",
      "cta": "CTA específico e criativo",
      "audio": "Sentimento/estilo musical sugerido",
      "script": "Script completo linha a linha para Reels de 30-45s (apenas se formato for Reels)"
    }
  ],
  "stories": [
    {
      "week": 1, "day": "Terça-feira",
      "theme": "Tema estratégico",
      "objective": "Objetivo desta sequência",
      "slides": [
        {"n": 1, "text": "Texto curto e impactante do slide", "action": "enquete / caixa de perguntas / link / reação", "tip": "Dica de design/cor para este slide"}
      ]
    }
  ],
  "hashtags": {
    "niche": ["#hashtag1","#hashtag2","#hashtag3","#hashtag4","#hashtag5","#hashtag6","#hashtag7","#hashtag8"],
    "local": ["#hashtag1","#hashtag2","#hashtag3","#hashtag4","#hashtag5"],
    "broad": ["#hashtag1","#hashtag2","#hashtag3","#hashtag4","#hashtag5","#hashtag6","#hashtag7"],
    "strategy": "Estratégia detalhada de uso para este nicho e cidade específica"
  },
  "post_days": [3,5,7,9,12,14,16,19,21,23,26,28],
  "event_days": [],
  "tips": [
    {"icon": "🔥", "title": "Dica de Ouro", "text": "Dica personalizada e específica"},
    {"icon": "📈", "title": "Crescimento de Seguidores", "text": "Estratégia para ${location || 'sua cidade'}"},
    {"icon": "💰", "title": "Gatilho de Vendas", "text": "Gatilho mais efetivo para este público"},
    {"icon": "🎯", "title": "Melhores Horários", "text": "Horários e dias ideais para este nicho"},
    {"icon": "🤝", "title": "Parcerias Estratégicas", "text": "Parceiros ideais em ${location || 'sua região'}"}
  ]
}

REGRAS CRÍTICAS:
1. Crie EXATAMENTE ${posts} posts distribuídos em 4 semanas com funil: S1=Atenção/Educação, S2=Autoridade, S3=Conexão+Prova Social, S4=Conversão
2. Crie pelo menos 8 sequências de Stories para o mês
3. Para TODOS os Reels inclua script completo linha a linha
4. As legendas devem ter copy REAL e persuasivo, não apenas descrição
5. Use os dados reais do perfil para personalizar ao máximo`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullText = '';

    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',   // Groq gratuito — mais capaz
      max_tokens: 8000,
      temperature: 0.7,
      stream: true,
      messages: [
        {
          role: 'system',
          content: 'Você é um estrategista de marketing digital sênior especializado em Instagram e copywriting para o mercado brasileiro. Responda SEMPRE e APENAS com JSON válido, sem markdown, sem texto fora do JSON, sem blocos de código.'
        },
        { role: 'user', content: prompt }
      ]
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullText += delta;
        res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', fullText })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Generate error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

// ─── PAGE ROUTES ─────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'app.html'));
});

// ─── START ───────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Instagram Planner rodando em ${BASE_URL}`));
