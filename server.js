const express = require('express');
const session = require('express-session');
const axios = require('axios');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret';
const BASE_URL = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : `http://localhost:${PORT}`;

// Credenciais Meta
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;

// Tokens legados (opcional)
const IG_TOKENS = (process.env.IG_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);

console.log(`[INIT] Servidor iniciando...`);
console.log(`[INIT] BASE_URL: ${BASE_URL}`);

// Configuração OpenAI
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim()
});

if (!(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('[FATAL] OPENAI_API_KEY não está configurada!');
}

// Configuração para Railway/Proxy
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  name: 'ig_planner_session',
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Middleware de log
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url} - Session: ${!!req.session.user}`);
  next();
});

// ─── AUXILIARES ─────────────────────────────────────────────
async function fetchMedia(userId, token, limit = 20) {
  try {
    const url = `https://graph.facebook.com/v21.0/${userId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${limit}&access_token=${token}`;
    const response = await axios.get(url);
    return response.data.data || [];
  } catch (e) {
    console.error(`[IG] Erro media ${userId}:`, e.response?.data || e.message);
    return [];
  }
}

function cleanAndParseJSON(rawText) {
  if (!rawText || typeof rawText !== 'string') throw new Error('Resposta vazia da IA');
  let text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = Math.min(...[text.indexOf('{'), text.indexOf('[')].filter(i => i !== -1));
  const end = Math.max(...[text.lastIndexOf('}'), text.lastIndexOf(']')].filter(i => i !== -1));
  if (start !== -1 && end !== -1) text = text.substring(start, end + 1);
  return JSON.parse(text);
}

// ─── ROTAS DE AUTENTICAÇÃO REAL (OAUTH) ──────────────────────

// 1. Redirecionar para o Facebook
app.get('/api/auth/facebook', (req, res) => {
  if (!FB_APP_ID) return res.status(500).send('FB_APP_ID não configurado');
  const redirectUri = `${BASE_URL}/auth/callback`;
  const scope = 'instagram_basic,instagram_manage_insights,pages_read_engagement,pages_show_list';
  const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code`;
  res.redirect(authUrl);
});

// 2. Callback do Facebook (Ajustado para /auth/callback)
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const redirectUri = `${BASE_URL}/auth/callback`;
    // Trocar código por token de acesso
    const tokenRes = await axios.get(`https://graph.facebook.com/v21.0/oauth/access_token`, {
      params: {
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: redirectUri,
        code
      }
    });

    const accessToken = tokenRes.data.access_token;
    
    // Obter contas do Instagram vinculadas às páginas do usuário
    const pagesRes = await axios.get(`https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account{id,username,name,followers_count,media_count,biography,website}&access_token=${accessToken}`);
    
    const accounts = pagesRes.data.data
      .filter(p => p.instagram_business_account)
      .map(p => ({
        ...p.instagram_business_account,
        ig_token: accessToken
      }));

    if (accounts.length === 0 && IG_TOKENS.length === 0) {
      return res.redirect('/?error=no_instagram_account');
    }

    req.session.user = { accounts: accounts };
    req.session.save(() => res.redirect('/app'));

  } catch (e) {
    console.error('[AUTH] Erro no callback:', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

// ─── ROTAS DE API ───────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'app.html'));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  
  if (req.session.user.accounts && req.session.user.accounts.length > 0) {
    return res.json({ logged: true, accounts: req.session.user.accounts });
  }

  const accounts = [];
  for (const token of IG_TOKENS) {
    try {
      const me = await axios.get(`https://graph.facebook.com/v21.0/me?fields=id,username,name,followers_count,media_count,biography,website&access_token=${token}`);
      accounts.push({ ...me.data, ig_token: token });
    } catch (e) { console.error('[AUTH] Erro token legado:', e.message); }
  }
  
  req.session.user.accounts = accounts;
  res.json({ logged: true, accounts: accounts });
});

app.post('/api/suggestions', async (req, res) => {
  if (!req.session.user || !process.env.OPENAI_API_KEY) return res.status(401).json({ error: 'Erro de config' });
  const { igId } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  if (!account) return res.status(404).json({ error: 'Not found' });
  const media = await fetchMedia(account.id, account.ig_token, 10);
  const captions = media.map(m => m.caption?.substring(0, 150) || '').filter(Boolean).join(' | ');
  const prompt = `Você é um estrategista de Instagram. Analise: @${account.username}, BIO: ${account.biography}, POSTS: ${captions}. Retorne JSON: { "niche": "...", "audience": "...", "suggestions": ["..."], "bio_options": ["..."], "insights": "..." }`;
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/intelligence', async (req, res) => {
  const { igId, competitors, niche, location, goal } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  const prompt = `Analise mercado para @${account.username} no nicho ${niche}. Retorne JSON com inteligência estratégica.`;
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate', async (req, res) => {
  const { igId, posts, goal, tone, extra, objections, audience, niche } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  const prompt = `Crie plano 30 dias para @${account.username}. Nicho: ${niche}, Objetivo: ${goal}. Retorne JSON: { "audit": {}, "posts": [], "stories": [], "tips": [] }`;
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
