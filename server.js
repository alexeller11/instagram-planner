require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const Groq = require('groq-sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const LONG_TOKEN = process.env.FB_LONG_TOKEN;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── MIDDLEWARE ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(publicDir));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── BUSCAR CONTAS IG via token fixo ─────────────────────────
async function fetchIGAccounts(token) {
  const igAccounts = [];
  try {
    // Buscar todas as páginas
    let url = `https://graph.facebook.com/v21.0/me/accounts`;
    let allPages = [];
    let nextUrl = url;

    while (nextUrl) {
      const res = await axios.get(nextUrl, {
        params: nextUrl === url ? {
          access_token: token,
          fields: 'id,name,access_token,instagram_business_account',
          limit: 100
        } : { access_token: token }
      });
      allPages = allPages.concat(res.data.data || []);
      nextUrl = res.data.paging?.next || null;
    }

    console.log(`[FETCH] Total páginas: ${allPages.length}`);

    for (const page of allPages) {
      // Buscar IG via página com token da página
      try {
        const pageRes = await axios.get(`https://graph.facebook.com/v21.0/${page.id}`, {
          params: {
            fields: 'instagram_business_account',
            access_token: page.access_token || token
          }
        });

        const igId = pageRes.data.instagram_business_account?.id;
        if (igId) {
          const igRes = await axios.get(`https://graph.facebook.com/v21.0/${igId}`, {
            params: {
              fields: 'id,name,username,followers_count,media_count,biography,website',
              access_token: page.access_token || token
            }
          });
          console.log(`[IG] Encontrado: @${igRes.data.username} (${page.name})`);
          igAccounts.push({
            ...igRes.data,
            page_name: page.name,
            page_id: page.id,
            page_token: page.access_token || token
          });
        }
      } catch (e) {
        // silencioso
      }
    }

    console.log(`[FETCH] Total IG accounts: ${igAccounts.length}`);
  } catch (e) {
    console.error('[FETCH_ERR]', e.response?.data || e.message);
  }
  return igAccounts;
}

// ─── ROUTES ──────────────────────────────────────────────────

// Login direto com token fixo
app.get('/auth/login', async (req, res) => {
  const token = LONG_TOKEN;
  if (!token) return res.redirect('/?error=no_token');
  try {
    const igAccounts = await fetchIGAccounts(token);
    req.session.user = { longToken: token, igAccounts };
    res.redirect('/app');
  } catch (e) {
    console.error(e);
    res.redirect('/?error=fetch_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── API ──────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  res.json({ logged: true, igAccounts: req.session.user.igAccounts });
});

app.get('/api/refresh', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const igAccounts = await fetchIGAccounts(req.session.user.longToken);
    req.session.user.igAccounts = igAccounts;
    res.json({ success: true, count: igAccounts.length, igAccounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gerar plano com Groq
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
- Seguidores: ${(account.followers_count||0).toLocaleString('pt-BR')}
- Posts publicados: ${account.media_count || 'N/A'}
- Bio: ${account.biography || 'Não informada'}
- Website: ${account.website || 'Não informado'}
- Página Facebook vinculada: ${account.page_name}`;

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
        topPostsContext = '\n\nÚltimos posts publicados:\n' +
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

Retorne APENAS JSON válido com esta estrutura exata (sem markdown, sem texto fora do JSON):

{
  "audit": {
    "summary": "Análise humanizada do perfil usando os dados reais. Use frases como Olhando seus números... Seja específico.",
    "differentials": ["diferencial 1", "diferencial 2", "diferencial 3"],
    "positioning": "Como se posicionar vs concorrentes locais",
    "engagement_analysis": "Análise do engajamento dos últimos posts"
  },
  "dates": [
    {"day": 8, "name": "Nome da data", "relevance": "Por que é relevante", "content_idea": "Ideia de post"}
  ],
  "posts": [
    {
      "n": 1, "week": 1, "day_suggestion": "Terça",
      "format": "Reels",
      "pillar": "Educação",
      "objective": "Quebra de objeção específica",
      "visual": "Descrição detalhada da cena",
      "copy": "Legenda completa 6-10 linhas AIDA/PAS com emojis",
      "cta": "CTA específico e criativo",
      "audio": "Estilo musical sugerido",
      "script": "Script linha a linha 30-45s (só para Reels)"
    }
  ],
  "stories": [
    {
      "week": 1, "day": "Terça-feira",
      "theme": "Tema estratégico",
      "objective": "Objetivo desta sequência",
      "slides": [
        {"n": 1, "text": "Texto curto e impactante", "action": "enquete/pergunta/link/reação", "tip": "Dica de design"}
      ]
    }
  ],
  "hashtags": {
    "niche": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],
    "local": ["#tag1","#tag2","#tag3","#tag4","#tag5"],
    "broad": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7"],
    "strategy": "Estratégia de uso para este nicho e cidade"
  },
  "post_days": [3,5,7,9,12,14,16,19,21,23,26,28],
  "event_days": [],
  "tips": [
    {"icon": "🔥", "title": "Dica de Ouro", "text": "Dica personalizada"},
    {"icon": "📈", "title": "Crescimento", "text": "Estratégia para a cidade"},
    {"icon": "💰", "title": "Gatilho de Vendas", "text": "Gatilho mais efetivo"},
    {"icon": "🎯", "title": "Melhores Horários", "text": "Dias e horários ideais"},
    {"icon": "🤝", "title": "Parcerias", "text": "Parceiros estratégicos locais"}
  ]
}

REGRAS: Crie EXATAMENTE ${posts} posts. Funil: S1=Atenção, S2=Autoridade, S3=Conexão, S4=Conversão. Mínimo 8 sequências de Stories. Scripts completos para todos os Reels.`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullText = '';
    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 8000,
      temperature: 0.7,
      stream: true,
      messages: [
        {
          role: 'system',
          content: 'Você é um estrategista de marketing digital sênior. Responda SEMPRE e APENAS com JSON válido, sem markdown, sem texto fora do JSON.'
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

// ─── PAGES ───────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'app.html'));
});

app.listen(PORT, () => console.log(`🚀 Social Planner rodando em ${BASE_URL}`));
