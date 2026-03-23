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
const IG_TOKENS = (process.env.IG_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);

// Configuração OpenAI
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim()
});

if (!(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('[FATAL] OPENAI_API_KEY não está configurada!');
} else {
  const key = process.env.OPENAI_API_KEY.trim();
  console.log(`[INIT] OpenAI carregada: ${key.substring(0, 7)}...${key.substring(key.length - 4)}`);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ─── AUXILIARES ─────────────────────────────────────────────
async function fetchMedia(userId, token, limit = 20) {
  try {
    const url = `https://graph.facebook.com/v21.0/${userId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&access_token=${token}`;
    const response = await axios.get(url);
    return response.data.data || [];
  } catch (e) {
    console.error(`[IG] Erro ao buscar media para ${userId}:`, e.message);
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
  if (IG_TOKENS.length === 0) return res.status(500).json({ error: 'Nenhum token configurado no servidor.' });
  req.session.user = { accounts: [] };
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const accounts = [];
  for (const token of IG_TOKENS) {
    try {
      const me = await axios.get(`https://graph.facebook.com/v21.0/me?fields=id,username,name,followers_count,media_count,biography,website&access_token=${token}`);
      accounts.push({ ...me.data, ig_token: token });
    } catch (e) { console.error('[AUTH] Erro token:', e.message); }
  }
  req.session.user.accounts = accounts;
  res.json(accounts);
});

// SUGGESTIONS (ANÁLISE DE PERFIL)
app.post('/api/suggestions', async (req, res) => {
  if (!req.session.user || !process.env.OPENAI_API_KEY) return res.status(401).json({ error: 'Erro de config' });
  const { igId } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  if (!account) return res.status(404).json({ error: 'Not found' });

  const media = await fetchMedia(account.id, account.ig_token, 10);
  const captions = media.map(m => m.caption?.substring(0, 150) || '').filter(Boolean).join(' | ');

  const prompt = `Você é um estrategista de Instagram de alto nível. Analise este perfil e dê sugestões HUMANAS e ESTRATÉGICAS.\n  PERFIL: @${account.username} (${account.name})\n  BIO: ${account.biography}\n  ÚLTIMAS LEGENDAS: ${captions}\n  \n  PROIBIDO: Começar frases com "Você sabia", "Já pensou", "Descubra como".\n  FOCO: Linguagem natural brasileira, direta, como um consultor conversando no WhatsApp. Use neuromarketing.\n  \n  Retorne JSON: { "niche": "...", "audience": "...", "suggestions": ["..."], "bio_options": ["..."], "insights": "..." }`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" }
    });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// INTELLIGENCE (ANÁLISE DE CONCORRENTES)
app.post('/api/intelligence', async (req, res) => {
  const { igId, competitors, niche, location, goal } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);
  
  const prompt = `Analise o mercado para @${account.username} no nicho ${niche} em ${location}.\n  CONCORRENTES: ${competitors || 'Analise os 5 principais do setor automaticamente'}.\n  OBJETIVO: ${goal}\n  \n  ESTILO: Humanizado, sem clichês de IA. Analise GAPS de mercado que ninguém está explorando. Seja disruptivo.\n  Retorne JSON com: market_intelligence, audience_intelligence, competitive_intelligence, financial_intelligence, bio_optimized, strategic_score.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" }
    });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GENERATE (PLANNER)
app.post('/api/generate', async (req, res) => {
  const { igId, posts, goal, tone, extra, objections, audience, niche } = req.body;
  const account = req.session.user.accounts.find(a => a.id === igId);

  const prompt = `Crie um plano de 30 dias para @${account.username}.\n  NICHO: ${niche} | OBJETIVO: ${goal} | TOM: ${tone} | OBJEÇÕES: ${objections}\n  \n  REGRAS DE OURO:\n  1. NUNCA comece um post com "Você sabia", "Sabia que", "Ei você". \n  2. HUMANIZAÇÃO TOTAL: Use histórias reais, ganchos emocionais (medo, desejo, surpresa) e linguagem falada brasileira.\n  3. ANÁLISE DE CONCORRENTES: Diferencie o conteúdo do que todo mundo já faz. Se todos fazem "dicas", você faz "o erro que ninguém te conta".\n  4. OBEDEÇA AO TOM: Se o tom é "${tone}", cada palavra deve refletir isso.\n  \n  Retorne JSON: { "audit": {...}, "posts": [...], "stories": [...], "tips": [...] }`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" }
    });
    res.json(cleanAndParseJSON(response.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req, res) => {
  res.json({
    openai_configured: !!process.env.OPENAI_API_KEY,
    ig_tokens_configured: IG_TOKENS.length,
    status: 'OK - GPT-4o Ativo'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Instagram Planner GPT-4o rodando na porta ${PORT}`);
});
