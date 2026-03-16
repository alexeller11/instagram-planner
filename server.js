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
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Tokens do Instagram — adicione um por linha separado por vírgula
// Formato: TOKEN1,TOKEN2,TOKEN3
const IG_TOKENS = (process.env.IG_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ─── MIDDLEWARE ──────────────────────────────────────────────
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

// ─── BUSCAR PERFIS VIA TOKENS IG ────────────────────────────
async function fetchIGProfiles(tokens) {
  const accounts = [];
  for (const token of tokens) {
    try {
      const res = await axios.get('https://graph.instagram.com/v21.0/me', {
        params: {
          fields: 'id,name,username,followers_count,media_count,biography,website,profile_picture_url',
          access_token: token
        }
      });
      console.log(`[IG] Encontrado: @${res.data.username} (${res.data.followers_count} seguidores)`);
      accounts.push({ ...res.data, ig_token: token });
    } catch (e) {
      console.log(`[IG_ERR] Token inválido ou expirado: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  console.log(`[FETCH] Total contas IG: ${accounts.length}`);
  return accounts;
}

// ─── ROUTES ──────────────────────────────────────────────────
app.get('/auth/login', async (req, res) => {
  if (!IG_TOKENS.length) return res.redirect('/?error=no_tokens');
  try {
    const accounts = await fetchIGProfiles(IG_TOKENS);
    req.session.user = { accounts };
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

// ─── API ─────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  res.json({ logged: true, igAccounts: req.session.user.accounts });
});

app.get('/api/debug', async (req, res) => {
  const results = [];
  for (const token of IG_TOKENS.slice(0, 3)) {
    try {
      const r = await axios.get('https://graph.instagram.com/v21.0/me', {
        params: { fields: 'id,username,followers_count', access_token: token }
      });
      results.push({ ok: true, data: r.data });
    } catch (e) {
      results.push({ ok: false, error: e.response?.data || e.message });
    }
  }
  res.json({ tokens_configured: IG_TOKENS.length, results });
});

// ─── GERAR PLANO ─────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { igId, posts, goal, tone, extra, objections, audience, niche, location } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);

  let profileContext = '';
  let topPostsContext = '';

  if (account) {
    profileContext = `
Dados REAIS do perfil @${account.username}:
- Nome: ${account.name}
- Seguidores: ${(account.followers_count||0).toLocaleString('pt-BR')}
- Posts publicados: ${account.media_count || 'N/A'}
- Bio: ${account.biography || 'Não informada'}
- Website: ${account.website || 'Não informado'}`;

    try {
      const mediaRes = await axios.get(`https://graph.instagram.com/v21.0/${igId}/media`, {
        params: {
          fields: 'caption,media_type,like_count,comments_count,timestamp',
          limit: 6,
          access_token: account.ig_token
        }
      });
      const media = mediaRes.data.data || [];
      if (media.length > 0) {
        topPostsContext = '\n\nÚltimos posts publicados:\n' +
          media.map((m, i) => `${i+1}. [${m.media_type}] ${m.caption?.substring(0, 120) || 'Sem legenda'}... | ❤️ ${m.like_count||0} | 💬 ${m.comments_count||0}`).join('\n');
      }
    } catch (e) {
      console.log('[MEDIA_ERR]', e.response?.data?.error?.message || e.message);
    }
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

Retorne APENAS JSON válido sem markdown:

{
  "audit": {
    "summary": "Análise humanizada usando os dados reais. Mencione seguidores, posts recentes e oportunidades. Use frases como Olhando seus números...",
    "differentials": ["diferencial 1", "diferencial 2", "diferencial 3"],
    "positioning": "Como se posicionar vs concorrentes locais",
    "engagement_analysis": "Análise do engajamento dos últimos posts"
  },
  "dates": [
    {"day": 8, "name": "Nome da data", "relevance": "Por que é relevante para este nicho", "content_idea": "Ideia específica de post"}
  ],
  "posts": [
    {
      "n": 1, "week": 1, "day_suggestion": "Terça",
      "format": "Reels",
      "pillar": "Educação",
      "objective": "Quebra de objeção específica",
      "visual": "Descrição detalhada da cena",
      "copy": "Legenda completa 6-10 linhas AIDA/PAS com emojis estratégicos",
      "cta": "CTA específico e criativo",
      "audio": "Estilo musical sugerido",
      "script": "Script linha a linha 30-45s (somente para Reels)"
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
    {"icon": "🔥", "title": "Dica de Ouro", "text": "Dica personalizada e específica"},
    {"icon": "📈", "title": "Crescimento", "text": "Estratégia para crescer na cidade"},
    {"icon": "💰", "title": "Gatilho de Vendas", "text": "Gatilho mais efetivo para este público"},
    {"icon": "🎯", "title": "Melhores Horários", "text": "Dias e horários ideais para este nicho"},
    {"icon": "🤝", "title": "Parcerias", "text": "Parceiros estratégicos locais"}
  ]
}

REGRAS: Crie EXATAMENTE ${posts} posts. Funil: S1=Atenção, S2=Autoridade, S3=Conexão, S4=Conversão. Mínimo 8 sequências de Stories. Scripts completos para todos os Reels. Legendas com copy REAL de 6-10 linhas.`;

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
        { role: 'system', content: 'Responda APENAS com JSON válido, sem markdown, sem texto fora do JSON.' },
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
