require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const MemoryStore = require('memorystore')(session);
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { chromium } = require("playwright");
const mongoose = require("mongoose");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const IS_PROD = process.env.NODE_ENV === "production";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const SESSION_SECRET = (process.env.SESSION_SECRET || "").trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const SAMBANOVA_API_KEY = (process.env.SAMBANOVA_API_KEY || "").trim();
const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);
const MONGODB_URI = (process.env.MONGODB_URI || "").trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || "").trim();

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const log = {
  info:  (...a) => console.log(`[${new Date().toISOString()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...a),
  debug: (...a) => !IS_PROD && console.log(`[${new Date().toISOString()}] [DEBUG]`, ...a),
};

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => log.info("✅ MongoDB Conectado!"))
    .catch(err => log.error("❌ Erro MongoDB:", err));
}

const clientSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  niche: { type: String, default: "" },
  audience: { type: String, default: "" },
  location: { type: String, default: "" },
  tone: { type: String, default: "" },
  forbidden_words: { type: [String], default: ["você sabia", "entenda", "saiba mais", "veja como"] },
  memory: { what_works: [String], what_doesnt_work: [String], strong_angles: [String] },
  evolutionary_dna: {
    preferred_tone: { type: String, default: "" },
    forbidden_styles: [String],
    writing_patterns: [String],
    top_successes: [{ subject: String, content: String, rating: Number, date: Date }]
  },
  saved_diagnostics: { type: Array, default: [] },
  saved_planners:    { type: Array, default: [] },
  single_posts:      { type: Array, default: [] },
  swipe_file:        { type: Array, default: [] }
}, { timestamps: true });

const Client = mongoose.model('Client', clientSchema);

async function getClientMemory(username) {
  let client = await Client.findOne({ username });
  if (!client) { client = new Client({ username }); await client.save(); }
  return client;
}

const PUBLIC_TMP_DIR = path.join(__dirname, "public", "tmp");
if (!fs.existsSync(PUBLIC_TMP_DIR)) fs.mkdirSync(PUBLIC_TMP_DIR, { recursive: true });

function cleanTmpDir() {
  try {
    const files = fs.readdirSync(PUBLIC_TMP_DIR);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of files) {
      try {
        const fp = path.join(PUBLIC_TMP_DIR, f);
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
      } catch (_) {}
    }
    if (removed > 0) log.info(`🧹 Limpeza tmp: ${removed} arquivo(s) removido(s).`);
  } catch (e) { log.warn("Erro na limpeza tmp:", e.message); }
}
setInterval(cleanTmpDir, 30 * 60 * 1000);
cleanTmpDir();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/tmp", express.static(PUBLIC_TMP_DIR));

app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));

const sessionStore = MONGODB_URI
  ? MongoStore.create({ mongoUrl: MONGODB_URI, ttl: 60 * 60 * 24, touchAfter: 3600 })
  : new MemoryStore({ checkPeriod: 86400000 });

if (!MONGODB_URI) log.warn("⚠️  MONGODB_URI não definida — sessões em memória.");

app.use(session({
  name: "planner.sid",
  secret: SESSION_SECRET || "fallback-secret-change-me",
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { httpOnly: true, secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 }
}));

function requireAuth(req, res, next) {
  if (req.session?.logged) return next();
  return res.status(401).json({ error: "Não autenticado. Faça login primeiro." });
}

app.post("/api/app-login", (req, res) => {
  if (!APP_PASSWORD) return res.json({ success: true });
  const { password } = req.body;
  if (password === APP_PASSWORD) { req.session.app_unlocked = true; return res.json({ success: true }); }
  return res.status(401).json({ error: "Senha incorreta." });
});

function requireAppPassword(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.session?.app_unlocked) return next();
  return res.status(401).json({ error: "App bloqueado. Informe a senha de acesso." });
}

let _browser = null;
async function getBrowser() {
  try {
    if (!_browser || !_browser.isConnected()) {
      log.info("🕸️ Iniciando nova instância do navegador Playwright...");
      _browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
      });
    }
  } catch (err) { log.error("❌ Falha ao iniciar Browser:", err.message); _browser = null; }
  return _browser;
}

const fbCallTimestamps = [];
const FB_WINDOW_MS = 60 * 1000;
const FB_MAX_CALLS_PER_MIN = 50;

async function callFbApiWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const now = Date.now();
      while (fbCallTimestamps.length > 0 && now - fbCallTimestamps[0] > FB_WINDOW_MS) fbCallTimestamps.shift();
      if (fbCallTimestamps.length >= FB_MAX_CALLS_PER_MIN) {
        const waitMs = FB_WINDOW_MS - (now - fbCallTimestamps[0]) + 200;
        log.warn(`⏳ FB Rate Limit preventivo. Aguardando ${Math.round(waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
      fbCallTimestamps.push(Date.now());
      return await fn();
    } catch (err) {
      const errCode = err.response?.data?.error?.code;
      const isRateLimit = err.response?.status === 429 || [4, 17, 32, 613].includes(errCode);
      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 2000;
        log.warn(`⚠️ Rate Limit Facebook (código ${errCode}). Retry ${attempt + 1}/${maxRetries} em ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else throw err;
    }
  }
}

function safeJsonParse(text) {
  try {
    const cleaned = text.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(cleaned);
  } catch (e) { log.error("Falha no Parse JSON IA:", e.message); return null; }
}

function truncate(str, max = 300) {
  if (!str) return "";
  return str.length > max ? str.substring(0, max) + "..." : str;
}

// Garante que uma bio não ultrapasse 150 caracteres (limite do Instagram)
function enforceBioLimit(bio) {
  if (!bio || typeof bio !== 'string') return bio;
  return bio.length > 150 ? bio.substring(0, 150) : bio;
}

// ==========================================
// MOTOR DE PERSONA PLATINUM
// ==========================================
const SYSTEM_PROMPTS = {
  PLATINUM_CORE: `VOCÊ É O ESTRATEGISTA-CHEFE DE UMA AGÊNCIA DE MARKETING BOUTIQUE (Diretor de Criação Sênior).
PERFIL: Analítico, denso, provocativo e focado em lucro/conversão.
FILTRO 2026:
- VETO TOTAL DE CLICHÊS: Absolutamente proibido usar: "você sabia", "atualmente", "nos dias de hoje", "não perca tempo", "descubra como", "incrível", "essencial", "transforme sua vida".
- TOM DE VOZ: Minimalista, sofisticado e Premium. Frases curtas de impacto + parágrafos densos de valor real.
- ESTRATÉGIA SILENCIOSA: Cada peça quebra uma objeção ou eleva o status do cliente.
- HUMANIZAÇÃO: Fale sobre TRANSFORMAÇÃO e MEDO DE FICAR PARA TRÁS, não sobre produto.`,

  VISION: "Analise estética, cores e autoridade visual. Dê conselhos agressivos e táticos de melhoria como um Diretor de Arte Sênior.",

  COPYWRITER: `Copywriter Sênior focada em Conversão Inevitável.
MÉTODO:
1. Gancho: Afirmação contraintuitiva ou pergunta que expõe uma ferida real.
2. Desenvolvimento: Storytelling denso com fatos, números e imagens mentais. Não descreva, faça sentir.
3. Estilo Visual: Use espaçamento generoso. Emojis ZERO ou máximo 2 por post, apenas para pontuar.
4. CTA: Chamada direta para o 'Próximo Nível'. Proibido 'comente azul' ou CTAs genéricos.`,

  PLANNER_CORE: `VOCÊ É O CO-PRODUTOR SÊNIOR DE LANÇAMENTOS DA IDEALE AGENCY.
SUA MISSÃO: Criar roteiros e legendas que param o scroll, geram salvamentos e convertem.

REGRAS ABSOLUTAS DE COPY:
- Cada post começa com um GANCHO de 2 a 3 segundos que gera curiosidade, choque ou identificação imediata.
- O roteiro/telas deve ter NO MÍNIMO 4 partes distintas: Gancho → Desenvolvimento (2-3 partes com informação real/história) → CTA de transbordamento.
- A legenda deve ter: 1 frase de abertura impactante + corpo com quebra de linha a cada 2 frases + CTA final único.
- PROIBIDO: posts genéricos, listas óbvias, adjetivos vazios, estrutura idêntica entre posts.
- OBRIGATÓRIO: cada post usa um gatilho mental diferente (Polêmica, Prova Social, Escassez, Identificação, Autoridade, Curiosidade, Medo de Ficar Para Trás).
- O script_or_slides deve ter entre 4 e 7 itens DETALHADOS — cada item com no mínimo 20 palavras descrevendo exatamente o que dizer ou mostrar.
- A legenda deve ter entre 80 e 200 palavras, com espaçamento visual entre blocos.

ESTRUTURA DO FUNIL 4 SEMANAS:
- Semana 1 (Atenção): Gerar curiosidade intensa. O cliente ainda não sabe que precisa de você.
- Semana 2 (Prova de Inteligência): Conteúdo que faz o seguidor se sentir mais inteligente ao consumir. Ele salva e manda para alguém.
- Semana 3 (Humanização/Emoção): História real, falha, aprendizado. O cliente se enxerga no conteúdo.
- Semana 4 (Proposta/CTA): A oferta chega de forma natural, o seguidor já confia. CTA de alta conversão.`
};

// ==========================================
// MOTOR IA COM TIMEOUT E FALLBACK COMPLETO
// ==========================================
async function callAI({ system, user, imagePath, username }) {
  let evolutionaryContext = "";
  if (username) {
    try {
      const mem = await getClientMemory(username);
      const successes = (mem.evolutionary_dna?.top_successes || []).slice(-3);
      if (successes.length) {
        evolutionaryContext = `\nVIGILÂNCIA DE SUCESSO ANTERIOR:\n${successes
          .map(s => `- TEMA: ${s.subject} | PONTUAÇÃO: ${s.rating}/10 | CONTEÚDO: ${truncate(s.content, 150)}`)
          .join("\n")}`;
      }
    } catch (e) { }
  }

  const combinedSystem = [
    SYSTEM_PROMPTS.PLATINUM_CORE,
    system,
    evolutionaryContext,
    "CONSELHO DE ESPECIALISTAS 2026: Simule o debate entre um Estrategista de Retenção, um Psicólogo Comportamental e um Copywriter Premium antes de retornar a resposta final em JSON."
  ].filter(Boolean).join("\n\n");

  const estimatedTokens = Math.round((combinedSystem.length + user.length) / 3.5);
  let lastError = null;

  log.info(`🧠 Chamada IA | [Groq:${!!groq}] [SambaNova:${!!SAMBANOVA_API_KEY}] [Gemini:${!!gemini}] | ~${estimatedTokens} tokens`);

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s) em ${label}`)), ms))
    ]);

  // 1. GROQ
  if (groq && !imagePath) {
    for (const model of ["llama-3.3-70b-versatile", "llama3-70b-8192"]) {
      try {
        log.info(`🤖 Tentando Groq: ${model}`);
        const res = await withTimeout(
          groq.chat.completions.create({
            model,
            messages: [
              { role: "system", content: combinedSystem },
              { role: "user", content: user }
            ],
            response_format: { type: "json_object" },
            max_tokens: 4000
          }),
          30000, `Groq/${model}`
        );
        log.info(`✅ Groq (${model}) respondeu.`);
        return JSON.parse(res.choices[0].message.content);
      } catch (err) {
        const status = err.status || err.response?.status;
        log.warn(`⚠️ Groq (${model}) falhou [${status}]: ${err.message}`);
        lastError = err;
        if (status !== 413 && status !== 429) break;
      }
    }
  }

  // 2. SAMBANOVA
  if (SAMBANOVA_API_KEY && !imagePath) {
    try {
      log.info("🔥 Tentando SambaNova Cloud (Llama 3.3)...");
      const res = await withTimeout(
        axios.post(
          "https://api.sambanova.ai/v1/chat/completions",
          {
            model: "Meta-Llama-3.3-70B-Instruct",
            messages: [
              { role: "system", content: combinedSystem },
              { role: "user", content: user }
            ],
            response_format: { type: "json_object" },
            max_tokens: 4000
          },
          { headers: { Authorization: `Bearer ${SAMBANOVA_API_KEY}`, "Content-Type": "application/json" }, timeout: 55000 }
        ),
        60000, "SambaNova"
      );
      const content = res.data.choices[0].message.content;
      log.info("✅ SambaNova respondeu.");
      return typeof content === "string" ? JSON.parse(content) : content;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.error?.message || err.message;
      log.warn(`⚠️ SambaNova falhou [${status}]: ${detail}`);
      lastError = err;
    }
  }

  // 3. GEMINI
  if (!gemini) {
    const isRate = lastError?.status === 429 || lastError?.response?.status === 429;
    throw new Error(isRate
      ? "Limite de uso Groq/SambaNova atingido. Configure GEMINI_API_KEY no Render."
      : `IA Offline. Último erro: ${lastError?.message || "Chave ausente"}`
    );
  }

  try {
    log.info("🚀 Tentando Gemini (gemini-1.5-flash)...");
    const model = gemini.getGenerativeModel({
      model: "gemini-1.5-flash",
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    });
    const parts = [`${combinedSystem}\n\nResponda ESTRITAMENTE em formato JSON. Não use Markdown.\n\n${user}`];
    if (imagePath && fs.existsSync(imagePath)) {
      const imageData = fs.readFileSync(imagePath);
      parts.push({ inlineData: { data: imageData.toString("base64"), mimeType: "image/png" } });
    }
    const result = await withTimeout(model.generateContent(parts), 60000, "Gemini");
    const text = result.response.text();
    const parsed = safeJsonParse(text);
    if (!parsed) throw new Error("Falha no parse JSON da Gemini.");
    log.info("✅ Gemini respondeu.");
    return parsed;
  } catch (err) {
    const isRateLimit = err.message?.includes("429") || err.status === 429;
    throw new Error(`Falha Crítica IA: ${isRateLimit ? "Cota Gemini esgotada." : err.message}`);
  }
}

const dashCache = new Map();
const DASH_CACHE_TTL = 5 * 60 * 1000;

// ==========================================
// ROTAS DA API
// ==========================================
app.post("/api/auth", requireAppPassword, async (req, res) => {
  try {
    const accounts = [];
    for (const token of IG_TOKENS) {
      try {
        const pagesRes = await callFbApiWithRetry(() =>
          axios.get("https://graph.facebook.com/v21.0/me/accounts", {
            params: { fields: "instagram_business_account{id,username,name,followers_count,biography,media_count}", access_token: token }
          })
        );
        const pages = pagesRes.data.data || [];
        for (const p of pages) {
          if (p.instagram_business_account) {
            accounts.push({ ...p.instagram_business_account, name: p.instagram_business_account.name || p.name, is_business: true });
            await getClientMemory(p.instagram_business_account.username);
          }
        }
      } catch (e) {
        try {
          const r = await axios.get("https://graph.instagram.com/v21.0/me", {
            params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
          });
          accounts.push({ ...r.data, is_business: false });
          await getClientMemory(r.data.username);
        } catch (err) { }
      }
    }
    req.session.logged = true;
    req.session.accounts = accounts;
    res.json({ success: true, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function resolveToken(igId) {
  for (const token of IG_TOKENS) {
    try {
      const r = await axios.get("https://graph.facebook.com/v21.0/me/accounts", {
        params: { fields: "instagram_business_account{id}", access_token: token }
      });
      const found = (r.data.data || []).find(p => p.instagram_business_account?.id === igId);
      if (found) return token;
    } catch (_) { }
    try {
      const r = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: { fields: "id", access_token: token }
      });
      if (r.data.id === igId) return token;
    } catch (_) { }
  }
  return null;
}

app.get("/api/me", (req, res) => res.json({ logged: !!req.session.logged, accounts: req.session.accounts || [] }));
app.get("/api/auth/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get("/api/version", (req, res) => res.json({ version: "2026.04-Ideale-v3.3-Platinum" }));

app.get("/api/debug-status", (req, res) => {
  const recentFbCalls = fbCallTimestamps.filter(t => Date.now() - t < FB_WINDOW_MS).length;
  res.json({
    env: process.env.NODE_ENV || "development",
    groq: !!GROQ_API_KEY, gemini: !!GEMINI_API_KEY, sambanova: !!SAMBANOVA_API_KEY,
    mongodb: mongoose.connection.readyState === 1,
    session_store: MONGODB_URI ? "mongodb" : "memory",
    app_password_set: !!APP_PASSWORD,
    tokens: IG_TOKENS.length,
    fb_calls_recent: recentFbCalls,
    fb_throttle_active: recentFbCalls >= FB_MAX_CALLS_PER_MIN,
    dash_cache_entries: dashCache.size,
    timestamp: new Date()
  });
});

app.get("/api/memory/:username", requireAuth, async (req, res) => {
  try {
    const mem = await getClientMemory(req.params.username);
    res.json({
      diagnostics: mem.saved_diagnostics || [],
      planners: mem.saved_planners || [],
      single_posts: (mem.single_posts || []).slice().reverse(),
      swipe_file: mem.swipe_file || [],
      forbidden: mem.forbidden_words || []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/identity/:username", requireAuth, async (req, res) => {
  try {
    const mem = await getClientMemory(req.params.username);
    res.json({
      niche: mem.niche || "Aguardando Diagnóstico...",
      audience: mem.audience || "Aguardando...",
      tone: mem.tone || "Aguardando...",
      last_update: mem.updatedAt
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// DASHBOARD
// ==========================================
app.get("/api/dashboard/:igId", requireAuth, async (req, res) => {
  const igId = req.params.igId;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(403).json({ error: "Acesso negado." });

  const cached = dashCache.get(igId);
  if (cached && Date.now() - cached.ts < DASH_CACHE_TTL) {
    log.info(`📦 Dashboard cache hit: ${igId}`);
    return res.json(cached.data);
  }

  try {
    const token = await resolveToken(igId);
    if (!token) return res.status(401).json({ error: "Token não encontrado para esta conta." });

    let media = [];
    try {
      const r = await callFbApiWithRetry(() =>
        axios.get(`https://graph.facebook.com/v21.0/${igId}/media`, {
          params: {
            fields: "id,caption,media_type,like_count,comments_count,timestamp,insights.metric(reach,impressions,engagement)",
            limit: 15,
            access_token: token
          }
        })
      );
      media = r.data.data || [];
    } catch (mediaErr) {
      log.warn(`⚠️ Falha ao buscar media insights detalhados (${mediaErr.message}). Tentando fallback básico...`);
      try {
        const r2 = await callFbApiWithRetry(() =>
          axios.get(`https://graph.facebook.com/v21.0/${igId}/media`, {
            params: { fields: "id,caption,media_type,like_count,comments_count,timestamp", limit: 15, access_token: token }
          })
        );
        media = r2.data.data || [];
      } catch (fallbackErr) {
        log.error(`❌ Fallback de media também falhou: ${fallbackErr.message}`);
      }
    }

    const likes = media.reduce((a, b) => a + (b.like_count || 0), 0);
    const comms = media.reduce((a, b) => a + (b.comments_count || 0), 0);
    const totalReach = media.reduce((a, b) => {
      const reachVal = b.insights?.data?.find(m => m.name === 'reach')?.values?.[0]?.value || 0;
      return a + reachVal;
    }, 0);
    const er = media.length > 0
      ? (((likes + comms) / media.length) / (acc.followers_count || 1) * 100).toFixed(2)
      : "0.00";
    const sorted = [...media].sort((a, b) => (b.like_count || 0) - (a.like_count || 0));

    const result = {
      metrics: {
        engagement_rate: er,
        avg_likes: media.length ? Math.round(likes / media.length) : 0,
        avg_comments: media.length ? Math.round(comms / media.length) : 0,
        total_reach_recent: totalReach,
        posts_analyzed: media.length
      },
      format_mix: media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type] || 0) + 1; return acc; }, {}),
      recent_posts: media.slice(0, 10),
      top_posts: sorted.slice(0, 3),
      worst_posts: sorted.slice(-3).reverse()
    };
    dashCache.set(igId, { ts: Date.now(), data: result });
    res.json(result);
  } catch (e) {
    log.error("❌ Erro /api/dashboard:", e.message);
    res.json({
      metrics: { engagement_rate: "0.00", avg_likes: 0, avg_comments: 0, total_reach_recent: 0, posts_analyzed: 0 },
      format_mix: {},
      recent_posts: [],
      top_posts: [],
      worst_posts: [],
      _warning: e.message
    });
  }
});

// ==========================================
// QUICK VERDICT
// ==========================================
app.post("/api/quick-verdict", requireAuth, async (req, res) => {
  const { username, followers, er, igId } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(403).json({ error: "Acesso negado." });

  let realInsights = { reach: 0, impressions: 0, cities: "Brasil (Principal)" };
  let isReal = false;

  if (acc && acc.is_business) {
    try {
      const token = await resolveToken(igId);
      if (token) {
        try {
          const insightRes = await callFbApiWithRetry(() => axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
            params: { metric: "reach,impressions", period: "day", access_token: token }
          }));
          const rVal = insightRes.data.data.find(m => m.name === 'reach')?.values.slice(-1)[0]?.value || 0;
          const iVal = insightRes.data.data.find(m => m.name === 'impressions')?.values.slice(-1)[0]?.value || 0;
          if (rVal > 0) { realInsights.reach = rVal * 30; realInsights.impressions = iVal * 30; isReal = true; }
        } catch (insErr) { log.warn(`⚠️ Insights reach/impressions indisponíveis: ${insErr.message}`); }

        try {
          const audienceRes = await callFbApiWithRetry(() => axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
            params: { metric: "audience_city", period: "lifetime", access_token: token }
          }));
          const citiesMap = audienceRes.data.data?.[0]?.values?.[0]?.value || {};
          const topCities = Object.keys(citiesMap).slice(0, 3).join(", ");
          if (topCities) realInsights.cities = topCities;
        } catch (citErr) { log.warn(`⚠️ Cidades indisponíveis (permissão): ${citErr.message}`); }
      }
    } catch (e) { log.warn("⚠️ Erro geral quick-verdict insights:", e.message); }
  }

  if (!isReal || realInsights.reach === 0) {
    realInsights.reach = Math.round((followers || 100) * ((parseFloat(er) || 1) / 10) * 1.5);
    realInsights.impressions = Math.round(realInsights.reach * 1.8);
  }

  const prompt = `AUDITORIA MÉTRICA PLATINUM para @${username}.
Seguidores: ${followers}. Taxa de Engajamento: ${er}%.
STATUS: ${isReal ? 'DADOS REAIS DA API' : 'ESTIMATIVA PREDITIVA IDEALE'}.

MISSÃO: Gere um Veredito EXPERT — humanizado, direto e mentoriano. Máximo 3 frases densas.
Determine o 'Health Status' (uma das opções: Pico de Tração | Em Maturação | Estável | Alerta de Queda).
Na seção demographics, dê a melhor leitura possível mesmo sem dados reais.

RETORNE JSON:
{
  "verdict": "Veredito de 2-3 frases densas e específicas...",
  "demographics": {
    "cities": "${realInsights.cities}",
    "gender": "Estimado com base no nicho",
    "time": "Melhor horário estimado (ex: 19h-21h)"
  },
  "health_status": "..."
}`;

  try {
    const data = await callAI({ system: "Estrategista de Dados Premium. Fale como um consultor humano sênior. Sem clichês.", user: prompt });
    res.json({
      verdict: data.verdict || "Conta em análise. Execute o Diagnóstico Avançado para leitura completa.",
      demographics: {
        cities: realInsights.cities,
        gender: data.demographics?.gender || "Misto",
        time: data.demographics?.time || "19h-21h"
      },
      health_status: data.health_status || (parseFloat(er) > 3 ? "Pico de Tração" : "Estável"),
      real_metrics: realInsights,
      is_real: isReal
    });
  } catch (e) {
    res.json({
      verdict: "Análise Preditiva: Conta em fase de aquecimento de base. Focar em retenção e consistência de postagem.",
      demographics: { cities: realInsights.cities, gender: "Misto", time: "19h" },
      health_status: parseFloat(er) > 3 ? "Pico de Tração" : "Estável",
      real_metrics: realInsights,
      is_real: isReal
    });
  }
});

app.post("/api/evaluate-post", requireAuth, async (req, res) => {
  const { theme, script_or_slides, caption, username } = req.body;
  const prompt = `AVALIE ESTE POST:
Tema: ${theme}.
Roteiro/Estrutura: ${JSON.stringify(script_or_slides)}.
Legenda: ${caption}.

Dê nota de 0 a 10 e analise Hook (Gancho), Body (Corpo) e CTA (Chamada).
FORNEÇA UM REFINAMENTO DA LEGENDA com mais impacto, espaçamento visual e SEO 2026.
Retorne JSON: { "score": 8.5, "analysis": { "hook": "...", "body": "...", "cta": "..." }, "refined_caption": "..." }`;
  try {
    const data = await callAI({ system: "Especialista em Copywriting de Alta Performance e Retenção de Audiência.", user: prompt, username });
    if (username && data.score >= 8) {
      const mem = await getClientMemory(username);
      mem.evolutionary_dna.top_successes.push({ subject: theme, content: caption, rating: data.score, date: new Date() });
      if (mem.evolutionary_dna.top_successes.length > 20) mem.evolutionary_dna.top_successes.shift();
      await mem.save();
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// DIAGNÓSTICO — com enforce de 150 chars nas bios
// ==========================================
app.post("/api/intelligence", requireAuth, async (req, res) => {
  const { igId, niche, audience } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(403).json({ error: "Acesso negado." });

  const mem = await getClientMemory(acc.username);
  mem.niche = niche; mem.audience = audience;
  await mem.save();

  let postsContext = "";
  try {
    const token = await resolveToken(igId);
    if (token) {
      const r = await callFbApiWithRetry(() =>
        axios.get(`https://graph.instagram.com/v21.0/${acc.id}/media`, {
          params: { fields: "caption,media_type,like_count", limit: 10, access_token: token }
        })
      );
      postsContext = (r.data.data || [])
        .map(p => `[${p.media_type}] ${truncate(p.caption, 80)}`)
        .join(' | ')
        .substring(0, 1500);
    }
  } catch (e) { log.warn("⚠️ Não foi possível buscar posts para diagnóstico:", e.message); }

  const prompt = `AUDITORIA DIGITAL PLATINUM para @${acc.username}.
Você é o Estrategista-Chefe da Ideale. Analise o feed e o nicho.
Feed Atual: ${postsContext || 'Indisponível (conta pessoal ou sem permissão)'}
Nicho: ${niche}. Público: ${audience}.

MISSÃO ESPECIAL: Gere 3 variações de BIO PREMIUM (Instagram) para o cliente.
REGRAS ABSOLUTAS: MÁXIMO 150 CARACTERES por bio — este é o limite do Instagram, não pode ser ultrapassado em hipótese alguma. Use técnica de Authority-Connection-Offer.

Retorne JSON:
{
  "executive_summary": "Análise densa, sem clichês, foco em branding e pontos de alavancagem.",
  "detected_niche": "nicho lido",
  "detected_tone": "tom de voz lido",
  "bio_suggestions_3D": {
    "authority": "Bio focada em marcos, prova social e quem você atende. MÁXIMO 150 CARACTERES.",
    "connection": "Bio focada em dor, conexão humana e transformação. MÁXIMO 150 CARACTERES.",
    "conversion": "Bio focada em CTA agressivo, link/vendas. MÁXIMO 150 CARACTERES."
  },
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "pillars": ["3 pilares táticos únicos para este nicho específico"],
  "priority_actions": ["Ação imediata de alto impacto"]
}`;

  try {
    const data = await callAI({ system: "Estrategista de Elite. Inale Storytelling e Exale Resultados.", user: prompt });

    // Enforce server-side: garante que nenhuma bio ultrapasse 150 chars
    if (data.bio_suggestions_3D) {
      data.bio_suggestions_3D.authority  = enforceBioLimit(data.bio_suggestions_3D.authority);
      data.bio_suggestions_3D.connection = enforceBioLimit(data.bio_suggestions_3D.connection);
      data.bio_suggestions_3D.conversion = enforceBioLimit(data.bio_suggestions_3D.conversion);
    }

    mem.saved_diagnostics.push({ date: new Date(), ...data });
    if (mem.saved_diagnostics.length > 20) mem.saved_diagnostics.shift();
    await mem.save();
    res.json(data);
  } catch (e) {
    log.error("❌ Erro /api/intelligence:", e.message);
    res.status(500).json({ error: `Falha no Diagnóstico: ${e.message}` });
  }
});

app.post("/api/export-diagnostic", requireAuth, async (req, res) => {
  const { payload, username } = req.body;
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);
  doc.rect(0, 0, doc.page.width, 100).fill("#051A22");
  doc.fillColor("#22ceb5").fontSize(28).text("IDEALE", 50, 40);
  doc.fillColor("#ffffff").fontSize(14).text("DIAGNÓSTICO ESTRATÉGICO", 50, 70);
  doc.moveDown(3);
  doc.fillColor("#000000").fontSize(20).text(`Análise: @${username}`, { underline: true }).moveDown();
  doc.fontSize(14).fillColor("#22ceb5").text("Resumo Executivo");
  doc.fontSize(11).fillColor("#333333").text(payload.executive_summary, { align: 'justify' }).moveDown();
  if (payload.bio_analysis) {
    doc.fontSize(14).fillColor("#e74c3c").text("Análise da Bio & Falhas Críticas");
    doc.fontSize(11).fillColor("#333333").text(payload.bio_analysis, { align: 'justify' }).moveDown();
    (payload.weaknesses || []).forEach(w => doc.text(`• ${w}`));
    doc.moveDown();
  }
  doc.fontSize(14).fillColor("#27ae60").text("Bio Tridimensional (Variações)");
  doc.fontSize(12).fillColor("#333").text("Autoridade: ", { continued: true }).fontSize(11).text(payload.bio_suggestions_3D?.authority || "-");
  doc.fontSize(12).fillColor("#333").text("Conexão: ", { continued: true }).fontSize(11).text(payload.bio_suggestions_3D?.connection || "-");
  doc.fontSize(12).fillColor("#333").text("Conversão: ", { continued: true }).fontSize(11).text(payload.bio_suggestions_3D?.conversion || "-");
  doc.moveDown(2);
  doc.fontSize(14).fillColor("#2980b9").text("Pilares Editoriais Recomendados");
  (payload.pillars || []).forEach(p => doc.text(`• ${p}`));
  doc.moveDown();
  doc.fontSize(10).fillColor("#999999").text("Relatório Confidencial - Ideale Agency", 50, doc.page.height - 50, { align: 'center' });
  doc.end();
});

app.post("/api/competitors", requireAuth, async (req, res) => {
  const { username } = req.body;
  const usernames = username.split(',').map(u => u.trim().replace('@', '')).filter(Boolean).slice(0, 3);
  const browser = await getBrowser();
  if (!browser) return res.status(500).json({ error: "Navegador indisponível. Tente novamente." });
  const results = [];
  for (const user of usernames) {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    try {
      log.info(`📡 Capturando perfil: @${user}...`);
      await page.goto(`https://www.instagram.com/${user}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
      const filename = `comp_${user}_${Date.now()}.png`;
      const fullPath = path.resolve(PUBLIC_TMP_DIR, filename);
      await page.screenshot({ path: fullPath, fullPage: false });
      const prompt = `Analise @${user}. Cores? Vibe (luxo, popular)? Counter-attack: Como ser melhor para se destacar dele?
JSON: { "colors": "...", "vibe": "...", "counter_attack": "..." }`;
      const vision = await callAI({ system: "Espião de Marketing com visão afiada.", user: prompt, imagePath: fullPath });
      results.push({ username: user, screenshot: `/tmp/${filename}`, analysis: vision || { vibe: "Inconsistente", counter_attack: "Focar em conteúdo autoral." } });
    } catch (e) {
      log.error(`❌ Erro ao capturar @${user}:`, e.message);
      try { await context.close(); } catch (_) {}
      _browser = null;
      results.push({ username: user, screenshot: null, analysis: { vibe: "Erro na captura", counter_attack: "Tentar manualmente." } });
      continue;
    } finally {
      try { await context.close(); } catch (_) {}
    }
  }
  res.json({ results, analysis: "Varredura concluída." });
});

app.post("/api/suggest-competitors", requireAuth, async (req, res) => {
  const { niche, city } = req.body;
  const prompt = `Sugira 3 arrobas reais do Instagram (benchmark ou negócio local) no nicho de '${niche}' na região '${city}'.
Retorne JSON: { "competitors": ["@nome1", "@nome2", "@nome3"] }`;
  try {
    const data = await callAI({ system: "Especialista em pesquisa de mercado.", user: prompt });
    res.json(data);
  } catch (e) { res.status(500).json({ error: "Erro buscando recomendação." }); }
});

app.post("/api/hashtags", requireAuth, async (req, res) => {
  const { igId, objective, niche: customNiche } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  let resolvedNiche = customNiche || "Marketing Digital";
  if (acc) {
    try {
      const mem = await getClientMemory(acc.username);
      if (mem.niche && !customNiche) resolvedNiche = mem.niche;
    } catch (e) { }
  }
  const prompt = `Você é um especialista em SEO e algoritmo do Instagram 2026.
Gere 5 sets de hashtags estratégicos para o nicho: "${resolvedNiche}" com objetivo: "${objective}".
Regras obrigatórias:
- Misture hashtags de alta (>1M posts), média (100k-1M) e baixa (<100k) competição.
- Nunca repita a mesma hashtag entre sets.
- Cada set deve ter entre 12 e 15 hashtags.
- Inclua pelo menos 2-3 hashtags em português por set.
Retorne JSON:
{
  "sets": [{ "name": "...", "strategy": "...", "tags": ["#tag1"], "competition": "alta|media|baixa", "best_for": "..." }],
  "banned_to_avoid": ["#tag_shadowban"],
  "pro_tip": "Dica de ouro específica para o nicho"
}`;
  try {
    const data = await callAI({ system: "Especialista em SEO e algoritmo do Instagram 2026. Apenas JSON válido.", user: prompt, username: acc?.username });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/swipe-file/save", requireAuth, async (req, res) => {
  const { username, entry } = req.body;
  try {
    const mem = await getClientMemory(username);
    const safeEntry = {
      date: new Date(),
      ...entry,
      caption: truncate(entry.caption || "", 500),
      notes: truncate(entry.notes || "", 300),
      screenshot: undefined
    };
    mem.swipe_file.push(safeEntry);
    if (mem.swipe_file.length > 30) mem.swipe_file.shift();
    await mem.save();
    res.json({ success: true, total: mem.swipe_file.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/autofill", requireAuth, async (req, res) => {
  const { igId, field_type } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada" });
  const mem = await getClientMemory(acc.username);
  const bio = truncate(acc.biography, 200);
  const prompts = {
    niche:    `Analise a bio: "${bio}". Sugira o "Nicho e Diferencial Único" (sem clichês). JSON: {"suggestion": "..."}`,
    audience: `Analise a bio: "${bio}". Qual o público-alvo exato (demografia e dor)? JSON: {"suggestion": "..."}`,
    subject:  `Baseado em ${mem.niche || 'este perfil'}, dê uma ideia de post 'fora da caixa' que gere autoridade imediata. JSON: {"suggestion": "..."}`,
    angle:    `Qual gatilho mental (Polêmica, Erro, Desejo Oculto) seria perfeito para esse nicho hoje? JSON: {"suggestion": "..."}`,
    city:     `Analise a bio: "${bio}". Localize a cidade/estado principal ou responda "Brasil (Nacional)". JSON: {"suggestion": "..."}`
  };
  const prompt = prompts[field_type];
  if (!prompt) return res.status(400).json({ error: "field_type inválido" });
  try {
    const data = await callAI({ system: "Você é focado em respostas ultra-diretas. Só retorne JSON.", user: prompt, username: acc.username });
    res.json(data);
  } catch (e) { res.json({ suggestion: `Erro Técnico: ${e.message}` }); }
});

// ==========================================
// PLANNER
// ==========================================
app.post("/api/generate", requireAuth, async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Acct not found" });

  const totalPosts = (Number(reels) || 0) + (Number(carousels) || 0) + (Number(singlePosts) || 0);
  if (totalPosts > 15) return res.status(400).json({ error: "Total de posts não pode exceder 15 por plano." });

  const mem = await getClientMemory(acc.username);

  const topSuccesses = (mem.evolutionary_dna?.top_successes || []).slice(-3);
  const evolutionContext = topSuccesses.length
    ? `\nREFERÊNCIAS DE SUCESSO DESTA CONTA (imite a profundidade, não o tema):\n${topSuccesses.map(s => `- TEMA: ${s.subject} | NOTA: ${s.rating}/10`).join('\n')}`
    : '';

  const prompt = `MISSÃO: Criar um Planejamento Tático Mensal PLATINUM de 4 Semanas para @${acc.username}.

CONTEXTO OBRIGATÓRIO DA MARCA:
- Nicho: ${mem.niche || 'Não definido — infira pelo nome da conta'}
- Público-alvo: ${mem.audience || 'Não definido — infira pelo nicho'}
- Tom de Voz da Campanha: ${tone}
- Objetivo da Campanha: ${goal}
- Mix de Formatos: ${reels} Reels | ${carousels} Carrosséis | ${singlePosts} Estáticos
${evolutionContext}

DIRETRIZES ABSOLUTAS DE QUALIDADE:
1. Cada post TEM que ser uma peça única — temas, ângulos e estruturas diferentes entre si.
2. O campo script_or_slides deve ter entre 4 e 7 itens. Cada item deve descrever com detalhes o que dizer/mostrar (mínimo 20 palavras por item).
   - Para Reels: descreva o visual, áudio, texto de tela e ritmo de cada cena.
   - Para Carrosséis: descreva o título e o conteúdo de cada slide com clareza.
   - Para Estáticos: descreva o texto principal, o elemento visual e o texto secundário.
3. O campo caption (legenda) deve ter entre 80 e 200 palavras.
4. O campo visual_audio_direction deve ser uma instrução cinematográfica real, não vaga.
5. O campo strategic_logic deve explicar por que este post vai gerar resultado.
6. Distribua os gatilhos mentais ao longo do mês:
   - Semana 1 (Atenção): Curiosidade, Polêmica, Choque
   - Semana 2 (Inteligência): Prova Social, Autoridade, Dado Real
   - Semana 3 (Emoção): Identificação, Vulnerabilidade, História Pessoal
   - Semana 4 (Conversão): Escassez, Urgência, Proposta Direta

Retorne APENAS JSON válido, sem markdown:
{
  "posts": [
    {
      "n": 1,
      "week_funnel": "Semana 1: Atenção · REELS",
      "format": "reels",
      "theme": "Título curto e impactante do post",
      "visual_audio_direction": "Instrução de direção detalhada",
      "script_or_slides": ["GANCHO (0-3s): ...", "PARTE 2: ...", "PARTE 3: ...", "CTA: ..."],
      "caption": "Legenda com quebras de linha e CTA.",
      "strategic_logic": "Por que este post funciona."
    }
  ]
}`;

  try {
    const data = await callAI({
      system: SYSTEM_PROMPTS.PLANNER_CORE,
      user: prompt,
      username: acc.username
    });
    mem.saved_planners.push({ date: new Date(), goal, posts: (data.posts || []) });
    if (mem.saved_planners.length > 15) mem.saved_planners.shift();
    await mem.save();
    res.json(data);
  } catch (e) {
    log.error("❌ Erro /api/generate:", e.message);
    res.status(500).json({ error: `Falha no Planejamento: ${e.message}` });
  }
});

app.post("/api/single-post", requireAuth, async (req, res) => {
  const { igId, format, subject, angle, intensity } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada" });
  const mem = await getClientMemory(acc.username);
  const prompt = `Crie exatamente UM POST ESTRATÉGICO para @${acc.username}.
CONTEXTO DA MARCA: Nicho: ${mem.niche || 'Geral'}. Público: ${mem.audience || 'Geral'}.
TEMA: ${subject}. FORMATO: ${format}. ÂNGULO: ${angle}. INTENSIDADE: ${intensity}/10.

REGRAS DE OURO:
- NÃO use hashtags genéricas na legenda.
- O roteiro deve ter pelo menos 4 partes com no mínimo 20 palavras cada.
- A legenda deve começar com um Gancho de Curiosidade Irresistível de 1 linha.
- Foque em quebrar a crença limitante nº 1 desse nicho.
- visual_audio_direction deve ser uma instrução de cinema real.

Retorne JSON:
{ "format": "${format}", "theme": "${subject}", "visual_audio_direction": "direção de arte e áudio detalhada", "script_or_slides": ["GANCHO (0-3s): ...", "PARTE 2: ...", "PARTE 3: ...", "CTA: ..."], "caption": "legenda humanizada com quebras de linha e CTA", "strategic_logic": "por que isso converte?" }`;
  try {
    const data = await callAI({ system: SYSTEM_PROMPTS.COPYWRITER, user: prompt, username: acc.username });
    mem.single_posts.push({ date: new Date(), subject, format, angle, ...data });
    if (mem.single_posts.length > 50) mem.single_posts.shift();
    await mem.save();
    res.json(data);
  } catch (e) {
    log.error("❌ Erro /api/single-post:", e.message);
    res.status(500).json({ error: `Falha no Post Único: ${e.message}` });
  }
});

app.post("/api/export-report", requireAuth, (req, res) => {
  const { payload, username } = req.body;
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);
  doc.rect(0, 0, doc.page.width, 100).fill("#051A22");
  doc.fillColor("#22ceb5").fontSize(28).text("IDEALE", 50, 40);
  doc.fillColor("#ffffff").fontSize(14).text("PLANEJAMENTO TÁTICO", 50, 70);
  doc.moveDown(3);
  doc.fillColor("#000000").fontSize(20).text(`Cliente: @${username}`, { underline: true }).moveDown();
  (payload.posts || []).forEach(p => {
    doc.fontSize(14).fillColor("#22ceb5").text(`${p.week_funnel || 'Planejamento'} | Post ${p.n} - ${p.format.toUpperCase()} | Temática: ${p.theme}`);
    doc.fontSize(11).fillColor("#e74c3c").text(`Direção Visual/Áudio:`, { continued: true }).fillColor("#333333").text(` ${p.visual_audio_direction}`);
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#2980b9").text("Roteiro / Telas:");
    (p.script_or_slides || []).forEach(s => doc.fillColor("#333333").text(`• ${s}`));
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#27ae60").text("Legenda (Copy):");
    doc.fillColor("#333333").text(p.caption, { align: 'justify' });
    doc.moveDown(2);
  });
  doc.fontSize(10).fillColor("#999999").text("Relatório Confidencial - Ideale Agency", 50, doc.page.height - 50, { align: 'center' });
  doc.end();
});

app.get("/health", (req, res) => res.json({
  status: "ok",
  uptime: process.uptime(),
  db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  version: "2026.04-Ideale-v3.3-Platinum"
}));

app.listen(PORT, "0.0.0.0", () => log.info(`🔥 Ideale Platinum v3.3 ativo em ${BASE_URL}`));
