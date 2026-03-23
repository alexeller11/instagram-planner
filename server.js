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

// Função de limpeza RADICAL de tokens
function getCleanTokens() {
  const raw = process.env.IG_TOKENS || '';
  // Divide por vírgula e limpa cada token individualmente
  return raw.split(',')
    .map(t => {
      // Remove ABSOLUTAMENTE tudo que não for alfanumérico (letras e números)
      // Tokens do IG/FB são alfanuméricos. Isso remove espaços, \n, \r, aspas, etc.
      return t.replace(/[^a-zA-Z0-9]/g, '').trim();
    })
    .filter(t => t.length > 20); // Filtra apenas o que parece ser um token real
}

const IG_TOKENS = getCleanTokens();

console.log(`[INIT] Servidor iniciando...`);
console.log(`[INIT] IG_TOKENS encontrados: ${IG_TOKENS.length}`);

// LOG DE INSPEÇÃO (Apenas os primeiros 5 caracteres para segurança)
IG_TOKENS.forEach((t, i) => {
  console.log(`[DEBUG] Token #${i+1}: Tamanho=${t.length} | Início=${t.substring(0, 10)}... | Fim=...${t.substring(t.length - 5)}`);
});

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
  console.log(`[REQ] ${req.method} ${req.url} - SessionID: ${req.sessionID} - UserSession: ${!!req.session.user}`);
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

// ─── ROTAS ──────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'app.html'));
});

app.post('/api/auth', (req, res) => {
  const currentTokens = getCleanTokens();
  if (currentTokens.length === 0) return res.status(500).json({ success: false, error: 'Nenhum token configurado.' });
  req.session.user = { accounts: [] };
  req.session.save((err) => {
    if (err) return res.status(500).json({ success: false, error: 'Erro de sessão.' });
    res.json({ success: true });
  });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  
  const currentTokens = getCleanTokens();
  console.log(`[AUTH] Validando ${currentTokens.length} tokens...`);
  const accounts = [];
  
  for (let i = 0; i < currentTokens.length; i++) {
    const token = currentTokens[i];
    try {
      const me = await axios.get(`https://graph.facebook.com/v21.0/me?fields=id,username,name,followers_count,media_count,biography,website&access_token=${token}`);
      accounts.push({ ...me.data, ig_token: token });
      console.log(`[AUTH] Token #${i+1} OK: @${me.data.username}`);
    } catch (e) { 
      const errMsg = e.response?.data?.error?.message || e.message;
      console.error(`[AUTH] Token #${i+1} FALHOU (${token.substring(0, 10)}...): ${errMsg}`); 
    }
  }
  
  req.session.user.accounts = accounts;
  res.json({ logged: true, accounts: accounts });
});

// Outras rotas (suggestions, intelligence, generate)
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
