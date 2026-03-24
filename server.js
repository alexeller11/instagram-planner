const express = require('express');
const session = require('express-session');
const axios = require('axios');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret-v4-1-final-reset';

// OpenAI
const openai = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY || '').trim() });

// Railway/Proxy
app.set('trust proxy', 1);

// KILL ALL CACHE HEADERS
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  name: 'ig_planner_session_final_v41',
  cookie: { 
    secure: true,
    sameSite: 'none',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { etag: false, lastModified: false }));

// AUX
function superClean(token) { return (token || '').replace(/[^a-zA-Z0-9]/g, '').trim(); }

async function discoverInstagramAccounts(token) {
  const accounts = [];
  const t = superClean(token);
  try {
    try {
      const direct = await axios.get('https://graph.facebook.com/v21.0/me?fields=id,username,name,followers_count,media_count,biography,website', { headers: { 'Authorization': `Bearer ${t}` } });
      if (direct.data.username) accounts.push({ ...direct.data, ig_token: t });
    } catch (e) { }

    if (accounts.length === 0) {
      const pages = await axios.get('https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,followers_count,media_count,biography,website}', { headers: { 'Authorization': `Bearer ${t}` } });
      if (pages.data.data) {
        for (const page of pages.data.data) {
          if (page.instagram_business_account) {
            accounts.push({ ...page.instagram_business_account, ig_token: page.access_token || t });
          }
        }
      }
    }
  } catch (e) { throw e; }
  return accounts;
}

function cleanAndParseJSON(rawText) {
  let text = (rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = Math.min(...[text.indexOf('{'), text.indexOf('[')].filter(i => i !== -1));
  const end = Math.max(...[text.lastIndexOf('}'), text.lastIndexOf(']')].filter(i => i !== -1));
  if (start !== -1 && end !== -1) text = text.substring(start, end + 1);
  return JSON.parse(text);
}

// ROUTES
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ROTA FINAL PARA FORÇAR CARREGAMENTO DO DASHBOARD
app.get('/dashboard-final', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'dashboard.html'));
});

// REDIRECTS
app.get('/app', (req, res) => res.redirect('/dashboard-final'));
app.get('/dashboard-v41', (req, res) => res.redirect('/dashboard-final'));

app.post('/api/auth', (req, res) => {
  req.session.user = { accounts: [] };
  req.session.save(() => res.json({ success: true }));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.json({ logged: false });
  res.json({ logged: true, accounts: req.session.user.accounts || [] });
});

app.post('/api/test-token', async (req, res) => {
  const { token } = req.body;
  try {
    const found = await discoverInstagramAccounts(token);
    if (!req.session.user) req.session.user = { accounts: [] };
    found.forEach(acc => { if (!req.session.user.accounts.find(a => a.id === acc.id)) req.session.user.accounts.push(acc); });
    req.session.save(() => res.json({ success: true, accounts: found }));
  } catch (e) { res.status(401).json({ success: false, error: e.response?.data?.error?.message || e.message }); }
});

app.post('/api/suggestions', async (req, res) => {
  const prompt = `Gere sugestões estratégicas para Instagram em JSON.`;
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate', async (req, res) => {
  const { goal, tone } = req.body;
  const prompt = `Crie um plano de 30 dias para Instagram. Objetivo: ${goal}, Tom: ${tone}. Retorne JSON.`;
  try {
    const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor FINAL v4.1.2 rodando na porta ${PORT}`));
