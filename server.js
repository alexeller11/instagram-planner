const express = require('express');
const session = require('express-session');
const axios = require('axios');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret-v4-1-1';

// Limpeza de tokens (mantém apenas o que é alfanumérico)
function superClean(token) {
  if (!token) return '';
  return token.replace(/[^a-zA-Z0-9]/g, '').trim();
}

function getCleanTokens() {
  const raw = process.env.IG_TOKENS || '';
  return raw.split(',')
    .map(t => superClean(t))
    .filter(t => t.length > 20); 
}

// Configuração OpenAI
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim()
});

// Configuração para Railway/Proxy
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  name: 'ig_planner_session_v4',
  cookie: { 
    secure: true,
    sameSite: 'none',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ─── AUXILIARES ─────────────────────────────────────────────
async function discoverInstagramAccounts(token) {
  const accounts = [];
  const t = superClean(token);
  try {
    // 1. Tentar ver se o token já é de uma conta do Instagram direta
    try {
      const direct = await axios.get('https://graph.facebook.com/v21.0/me?fields=id,username,name,followers_count,media_count,biography,website', {
        headers: { 'Authorization': `Bearer ${t}` }
      });
      if (direct.data.username) accounts.push({ ...direct.data, ig_token: t });
    } catch (e) { /* Não é conta direta */ }

    // 2. Buscar Páginas do Facebook vinculadas
    if (accounts.length === 0) {
      const pages = await axios.get('https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,followers_count,media_count,biography,website}', {
        headers: { 'Authorization': `Bearer ${t}` }
      });
      
      if (pages.data.data) {
        for (const page of pages.data.data) {
          if (page.instagram_business_account) {
            accounts.push({
              ...page.instagram_business_account,
              ig_token: page.access_token || t 
            });
          }
        }
      }
    }
  } catch (e) {
    throw e;
  }
  return accounts;
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

// ROTA DO APP (FORÇANDO DASHBOARD.HTML PARA QUEBRAR CACHE)
app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'dashboard.html'));
});

app.post('/api/auth', (req, res) => {
  req.session.user = { accounts: [] };
  req.session.save((err) => {
    if (err) return res.status(500).json({ success: false, error: 'Erro de sessão.' });
    res.json({ success: true });
  });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  
  let allAccounts = req.session.user.accounts || [];
  const tokens = getCleanTokens();
  
  for (const t of tokens) {
    try {
      const found = await discoverInstagramAccounts(t);
      found.forEach(acc => {
        if (!allAccounts.find(a => a.id === acc.id)) allAccounts.push(acc);
      });
    } catch (e) { /* silenciar */ }
  }
  
  req.session.user.accounts = allAccounts;
  res.json({ logged: true, accounts: allAccounts });
});

app.post('/api/test-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token não fornecido' });
  
  try {
    const found = await discoverInstagramAccounts(token);
    if (found.length === 0) {
      return res.status(404).json({ success: false, error: 'Nenhuma conta encontrada.' });
    }
    
    if (!req.session.user) req.session.user = { accounts: [] };
    found.forEach(acc => {
      if (!req.session.user.accounts.find(a => a.id === acc.id)) {
        req.session.user.accounts.push(acc);
      }
    });
    
    req.session.save(() => res.json({ success: true, accounts: found }));
  } catch (e) {
    res.status(401).json({ success: false, error: e.response?.data?.error?.message || e.message });
  }
});

// IA
app.post('/api/suggestions', async (req, res) => {
  const { igId } = req.body;
  const prompt = `Gere sugestões estratégicas para o Instagram em JSON: { "niche": "...", "insights": "...", "suggestions": [], "bio_options": [] }`;
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate', async (req, res) => {
  const { igId, goal, tone, niche } = req.body;
  const prompt = `Crie um plano de 30 dias para o Instagram. Objetivo: ${goal}, Tom: ${tone}. Retorne JSON com as chaves "posts" (array de 30) e "stories" (array de 30).`;
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
