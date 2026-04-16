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
// Senha de acesso ao app (define APP_PASSWORD no Render; se vazio, sem proteção)
const APP_PASSWORD = (process.env.APP_PASSWORD || "").trim();

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ==========================================
// LOGGER ESTRUTURADO
// ==========================================
const log = {
  info:  (...a) => console.log(`[${new Date().toISOString()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...a),
  debug: (...a) => !IS_PROD && console.log(`[${new Date().toISOString()}] [DEBUG]`, ...a),
};

// ==========================================
// 1. CONEXÃO COM O MONGODB ATLAS
// ==========================================
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => log.info("✅ MongoDB Conectado! Memória Permanente Ativada."))
    .catch(err => log.error("❌ Erro MongoDB:", err));
}

// ==========================================
// 2. MODELO DE DADOS DO CLIENTE
// ==========================================
const clientSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  niche: { type: String, default: "" },
  audience: { type: String, default: "" },
  location: { type: String, default: "" },
  tone: { type: String, default: "" },
  forbidden_words: {
    type: [String],
    default: ["você sabia", "entenda", "saiba mais", "veja como"]
  },
  memory: {
    what_works: [String],
    what_doesnt_work: [String],
    strong_angles: [String]
  },
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
  if (!client) {
    client = new Client({ username });
    await client.save();
  }
  return client;
}

// ==========================================
// 3. CONFIGURAÇÕES DO SERVIDOR
// ==========================================
const PUBLIC_TMP_DIR = path.join(__dirname, "public", "tmp");
if (!fs.existsSync(PUBLIC_TMP_DIR)) fs.mkdirSync(PUBLIC_TMP_DIR, { recursive: true });

// Limpeza automática de screenshots antigos (> 2 horas)
function cleanTmpDir() {
  try {
    const files = fs.readdirSync(PUBLIC_TMP_DIR);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of files) {
      const fp = path.join(PUBLIC_TMP_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
    }
    if (removed > 0) log.info(`🧹 Limpeza tmp: ${removed} arquivo(s) removido(s).`);
  } catch (e) {
    log.warn("Erro na limpeza tmp:", e.message);
  }
}
setInterval(cleanTmpDir, 30 * 60 * 1000); // roda a cada 30 min
cleanTmpDir(); // roda no boot

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/tmp", express.static(PUBLIC_TMP_DIR));

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

// Session: usa MongoDB se disponível, senão MemoryStore como fallback
const sessionStore = MONGODB_URI
  ? MongoStore.create({ mongoUrl: MONGODB_URI, ttl: 60 * 60 * 24, touchAfter: 3600 })
  : new MemoryStore({ checkPeriod: 86400000 });

if (!MONGODB_URI) log.warn("⚠️  MONGODB_URI não definida — sessões em memória (perdidas no restart).");

app.use(session({
  name: "planner.sid",
  secret: SESSION_SECRET || "fallback-secret-change-me",
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { httpOnly: true, secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 }
}));

// ==========================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ==========================================
function requireAuth(req, res, next) {
  if (req.session?.logged) return next();
  return res.status(401).json({ error: "Não autenticado. Faça login primeiro." });
}

// Proteção por senha do app (opcional)
app.post("/api/app-login", (req, res) => {
  if (!APP_PASSWORD) return res.json({ success: true }); // sem senha configurada, libera
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    req.session.app_unlocked = true;
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Senha incorreta." });
});

function requireAppPassword(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.session?.app_unlocked) return next();
  return res.status(401).json({ error: "App bloqueado. Informe a senha de acesso." });
}

// --- SINGLETON BROWSER ---
let _browser = null;
async function getBrowser() {
  try {
    if (!_browser || !_browser.isConnected()) {
      log.info("🕸️ Iniciando nova instância do navegador Playwright...");
      _browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
      });
    }
  } catch (err) {
    log.error("❌ Falha ao iniciar Browser:", err.message);
    _browser = null;
  }
  return _browser;
}

// ==========================================
// 🛡️ FACEBOOK GRAPH API — RATE LIMIT
// ==========================================
const fbCallTimestamps = [];
const FB_WINDOW_MS = 60 * 1000;
const FB_MAX_CALLS_PER_MIN = 50;

async function callFbApiWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const now = Date.now();
      while (fbCallTimestamps.length > 0 && now - fbCallTimestamps[0] > FB_WINDOW_MS)
        fbCallTimestamps.shift();
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

// --- UTILITÁRIOS ---
function safeJsonParse(text) {
  try {
    const cleaned = text.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(cleaned);
  } catch (e) {
    log.error("Falha no Parse JSON IA:", e.message);
    return null;
  }
}

// Trunca string mantendo no máximo N caracteres
function truncate(str, max = 300) {
  if (!str) return "";
  return str.length > max ? str.substring(0, max) + "..." : str;
}

// ==========================================
// MOTOR DE PERSONA PLATINUM
// ==========================================
const SYSTEM_PROMPTS = {
  PLATINUM_CORE: `VOCÊ É O ESTRATEGISTA-CHEFE DE UMA AGÊNCIA DE MARKETING BOUTIQUE (Diretor de Criação Sênior).
  PERFIL: Analítico, denso, provocativo e focado em lucro/conversão.
  FILTRO 2026:
  - VETO TOTAL DE CLICHÊS: Absolutamente proibido: "você sabia", "atualmente", "nos dias de hoje", "não perca tempo", "descubra como".
  - TOM DE VOZ: Minimalista, sofisticado e "Premium". Use frases curtas de impacto mescladas com parágrafos densos de puro valor.
  - ESTRATÉGIA SILENCIOSA: Cada peça deve quebrar uma objeção ou elevar o status do cliente.
  - HUMANIZAÇÃO: Não fale sobre o "produto", fale sobre a "transformação ou o medo de ficar para trás".`,
  VISION: "Analise estética, cores e autoridade visual. Dê conselhos agressivos e táticos de melhoria como um Diretor de Arte Sênior.",
  COPYWRITER: `Copywriter Sênior focada em Conversão Inevitável.
  MÉTODO:
  1. Gancho: Inicie com uma afirmação contraintuitiva ou uma pergunta que exponha uma ferida.
  2. Desenvolvimento: Use Storytelling denso. Não descreva, faça sentir.
  3. Estilo Visual: Use emojis de forma minimalista (máximo 3 por post), apenas para pontuar. Use espaçamento generoso para facilitar a leitura.
  4. CTA: Chamada direta para o "Próximo Nível", nada de "comente azul".`
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

  // Wrapper com timeout para qualquer Promise de IA
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s) em ${label}`)), ms)
      )
    ]);

  // 1. GROQ — modelos com limite suficiente para o Platinum prompt
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

  // 3. GEMINI (fallback final + visão)
  if (!gemini) {
    const isRate = lastError?.status === 429 || lastError?.response?.status === 429;
    throw new Error(isRate
      ? "Limite de uso Groq/SambaNova atingido. Configure GEMINI_API_KEY no Render."
      : `IA Offline. Último erro: ${lastError?.message || "Chave ausente"}`
    );
  }

  try {
    log.info("🚀 Tentando Gemini (gemini-2.5-flash)...");
    const model = gemini.getGenerativeModel({
      model: "gemini-2.5-flash",
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
    throw new Error(`Falha Crítica IA: ${isRateLimit ? "Cota Gemini esgotada." : err.message} Verifique suas chaves no Render.`);
  }
}

// ==========================================
// ROTAS DA API
// ==========================================

// Auth Instagram
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
            accounts.push({
              ...p.instagram_business_account,
              name: p.instagram_business_account.name || p.name,
              ig_token: token,
              is_business: true
            });
            await getClientMemory(p.instagram_business_account.username);
          }
        }
      } catch (e) {
        try {
          const r = await axios.get("https://graph.instagram.com/v21.0/me", {
            params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
          });
          accounts.push({ ...r.data, ig_token: token, is_business: false });
          await getClientMemory(r.data.username);
        } catch (err) { }
      }
    }
    req.session.logged = true;
    req.session.accounts = accounts;
    res.json({ success: true, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", (req, res) => res.json({ logged: !!req.session.logged, accounts: req.session.accounts || [] }));
app.get("/api/auth/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get("/api/version", (req, res) => res.json({ version: "2026.04-Ideale-v3.1-Platinum" }));

app.get("/api/debug-status", (req, res) => {
  const recentFbCalls = fbCallTimestamps.filter(t => Date.now() - t < FB_WINDOW_MS).length;
  res.json({
    env: process.env.NODE_ENV || "development",
    groq: !!GROQ_API_KEY,
    gemini: !!GEMINI_API_KEY,
    sambanova: !!SAMBANOVA_API_KEY,
    mongodb: mongoose.connection.readyState === 1,
    session_store: MONGODB_URI ? "mongodb" : "memory",
    app_password_set: !!APP_PASSWORD,
    tokens: IG_TOKENS.length,
    fb_calls_recent: recentFbCalls,
    fb_throttle_active: recentFbCalls >= FB_MAX_CALLS_PER_MIN,
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

app.get("/api/dashboard/:igId", requireAuth, async (req, res) => {
  const acc = (req.session.accounts || []).find(a => a.id === req.params.igId);
  if (!acc) return res.status(404).send();
  try {
    const r = await callFbApiWithRetry(() =>
      axios.get(`https://graph.facebook.com/v21.0/${acc.id}/media`, {
        params: {
          fields: "id,caption,media_type,like_count,comments_count,timestamp,insights.metric(reach,impressions,engagement)",
          limit: 15,
          access_token: acc.ig_token
        }
      })
    );
    const media = r.data.data || [];
    const likes = media.reduce((a, b) => a + (b.like_count || 0), 0);
    const comms = media.reduce((a, b) => a + (b.comments_count || 0), 0);
    const totalReach = media.reduce((a, b) => {
      const reachVal = b.insights?.data?.find(m => m.name === 'reach')?.values[0]?.value || 0;
      return a + reachVal;
    }, 0);
    const er = (((likes + comms) / (media.length || 1)) / (acc.followers_count || 1) * 100).toFixed(2);
    const sorted = [...media].sort((a, b) => (b.like_count || 0) - (a.like_count || 0));
    res.json({
      metrics: {
        engagement_rate: er,
        avg_likes: Math.round(likes / (media.length || 1)),
        avg_comments: Math.round(comms / (media.length || 1)),
        total_reach_recent: totalReach
      },
      format_mix: media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type] || 0) + 1; return acc; }, {}),
      recent_posts: media.slice(0, 10),
      top_posts: sorted.slice(0, 3),
      worst_posts: sorted.slice(-3).reverse()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/quick-verdict", requireAuth, async (req, res) => {
  const { username, followers, er, igId } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  let realInsights = { reach: 0, impressions: 0, cities: "Apurando..." };
  let isReal = false;

  if (acc && acc.is_business) {
    try {
      const [insightRes, audienceRes] = await Promise.all([
        callFbApiWithRetry(() => axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
          params: { metric: "reach,impressions", period: "day", access_token: acc.ig_token }
        })),
        callFbApiWithRetry(() => axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
          params: { metric: "audience_city", period: "lifetime", access_token: acc.ig_token }
        }))
      ]);
      const rVal = insightRes.data.data.find(m => m.name === 'reach')?.values.reverse()[0]?.value || 0;
      const iVal = insightRes.data.data.find(m => m.name === 'impressions')?.values.reverse()[0]?.value || 0;
      if (rVal > 0) { realInsights.reach = rVal * 30; realInsights.impressions = iVal * 30; isReal = true; }
      const citiesMap = audienceRes.data.data[0]?.values[0]?.value || {};
      realInsights.cities = Object.keys(citiesMap).slice(0, 3).join(", ") || "Apurando...";
    } catch (e) { }
  }

  if (!isReal) {
    realInsights.reach = Math.round(followers * (er / 10) * 1.5) || 150;
    realInsights.impressions = Math.round(realInsights.reach * 1.8);
  }

  const prompt = `AUDITORIA MÉTRICA PLATINUM para @${username}.
  Seguidores: ${followers}. ER: ${er}%.
  STATUS: ${isReal ? 'DADOS REAIS' : 'ESTIMATIVA PREDITIVA IDEALE'}.
  Crie um Veredito EXPERT (Humanizado, Direto, Mentoriano). MÁX 3 frases.
  Determine o 'Health Status' (Pico de Tração, Estável, Alerta de Queda ou Em Maturação).
  RETORNE JSON: { "verdict": "...", "demographics": { "cities": "...", "gender": "...", "time": "..." }, "health_status": "..." }`;

  try {
    const data = await callAI({ system: "Estrategista de Dados Premium. Fale como um consultor humano.", user: prompt });
    res.json({
      verdict: data.verdict,
      demographics: {
        cities: realInsights.cities !== "Apurando..." ? realInsights.cities : (data.demographics?.cities || "Brasil (Estimado)"),
        gender: data.demographics?.gender || "Misto",
        time: data.demographics?.time || "18h-21h"
      },
      health_status: data.health_status || (er > 3 ? "Pico de Tração" : "Estável"),
      real_metrics: realInsights,
      is_real: isReal
    });
  } catch (e) {
    res.json({ verdict: "Análise Preditiva: Sua conta está em fase de aquecimento de base. Focar em retenção.", demographics: { cities: "Brasil", gender: "Misto", time: "19h" }, real_metrics: realInsights, is_real: isReal });
  }
});

app.post("/api/evaluate-post", requireAuth, async (req, res) => {
  const { theme, script_or_slides, caption, username } = req.body;
  const prompt = `AVALIE ESTE POST:
  Tema: ${theme}.
  Roteiro/Estrutura: ${JSON.stringify(script_or_slides)}.
  Legenda: ${caption}.
  Dê nota de 0 a 10 e analise Hook (Gancho), Body (Corpo) e CTA (Chamada).
  FORNEÇA UM REFINAMENTO DA LEGENDA PARA MAXIMIZAR O ALGORITMO.
  Retorne JSON: { "score": 8.5, "analysis": { "hook": "...", "body": "...", "cta": "..." }, "refined_caption": "..." }`;
  try {
    const data = await callAI({ system: "Especialista em Copywriting de Alta Performance.", user: prompt, username });
    if (username && data.score >= 8) {
      const mem = await getClientMemory(username);
      mem.evolutionary_dna.top_successes.push({ subject: theme, content: caption, rating: data.score, date: new Date() });
      if (mem.evolutionary_dna.top_successes.length > 20) mem.evolutionary_dna.top_successes.shift();
      await mem.save();
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/intelligence", requireAuth, async (req, res) => {
  const { igId, niche, audience } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Account not found" });

  const mem = await getClientMemory(acc.username);
  mem.niche = niche; mem.audience = audience;
  await mem.save();

  let postsContext = "";
  try {
    const r = await callFbApiWithRetry(() =>
      axios.get(`https://graph.instagram.com/v21.0/${acc.id}/media`, {
        params: { fields: "caption,media_type,like_count", limit: 10, access_token: acc.ig_token }
      })
    );
    // Trunca cada legenda em 80 chars para não estourar o token count
    postsContext = (r.data.data || [])
      .map(p => `[${p.media_type}] ${truncate(p.caption, 80)}`)
      .join(' | ')
      .substring(0, 1500);
  } catch (e) { }

  const prompt = `AUDITORIA DIGITAL PLATINUM para @${acc.username}.
  Você é o Estrategista-Chefe da Ideale. Analise o feed e o nicho.
  Feed Atual: ${postsContext}
  Nicho: ${niche}, Público: ${audience}.

  MISSÃO ESPECIAL: Gere 3 variações de BIO PREMIUM (Instagram) para o cliente.
  REGRAS: MÁXIMO 150 caracteres por Bio. Use técnica de Authority-Connection-Offer.

  Retorne JSON:
  {
    "executive_summary": "Análise densa, sem clichês, foco em branding.",
    "detected_niche": "nicho lido",
    "detected_tone": "tom de voz lido",
    "bio_suggestions_3D": {
      "authority": "Bio focada em marcos, prova social e quem você atende. Máx 150 carac.",
      "connection": "Bio focada em dor, conexão humana e transformação. Máx 150 carac.",
      "conversion": "Bio focada em CTA agressivo, link/vendas. Máx 150 carac."
    },
    "strengths": ["...", "..."],
    "weaknesses": ["...", "..."],
    "pillars": ["3 pilares táticos únicos"],
    "priority_actions": ["Ação imediata"]
  }`;

  try {
    const data = await callAI({ system: "Estrategista de Elite. Inale Storytelling e Exale Resultados.", user: prompt });
    mem.saved_diagnostics.push({ date: new Date(), ...data });
    // Limite de 20 diagnósticos por conta
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
      results.push({ username: user, screenshot: null, analysis: { vibe: "Erro na captura", counter_attack: "Tentar manualmente." } });
    } finally { await context.close(); }
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
    mem.swipe_file.push({ date: new Date(), ...entry });
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

app.post("/api/generate", requireAuth, async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Acct not found" });
  const mem = await getClientMemory(acc.username);
  const prompt = `Crie um Planejamento de Lançamento Eterno (Funil 4 Semanas) para @${acc.username}.
  PERSONA DO CLIENTE: Nicho: ${mem.niche}. Público: ${mem.audience}. Tom: ${tone}.
  Distribuição: ${reels} Reels, ${carousels} Carrosséis, ${singlePosts} Estáticos.
  DIRETRIZ ESTRATÉGICA PLATINUM:
  - PROIBIDO: Listas óbvias, adjetivos genéricos como "incrível" ou "essencial".
  - CONTEÚDO: Cada post deve ser uma peça de "Doutrinação".
  - COERÊNCIA: Semana 1 gera curiosidade; Semana 2 prova que o cliente é gênio; Semana 3 humaniza com falha/história; Semana 4 é a proposta final.
  Retorne JSON:
  { "posts": [{ "n": 1, "week_funnel": "Semana 1: Atenção", "format": "reels", "theme": "Título Curto de Impacto", "visual_audio_direction": "Direção de cinema", "script_or_slides": ["Gancho de 2 segundos", "Corpo com 3 quebras de padrão", "Chamada de transbordamento"], "caption": "Legenda Densa. Zero clichês.", "strategic_logic": "Por que esse post vai parar o scroll?" }] }`;
  try {
    const data = await callAI({ system: "Você é um Co-Produtor Sênior de Lançamentos e Estrategista. Apenas JSON válido.", user: prompt, username: acc.username });
    mem.saved_planners.push({ date: new Date(), goal, posts: (data.posts || []) });
    // Limite de 15 planners por conta
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
  - NÃO use hashtags genéricas.
  - O roteiro deve ser FLUIDO.
  - A legenda deve começar com um "Gancho de Curiosidade Irresistível".
  - Foque em quebrar a crença limitante nº 1 desse nicho.
  { "format": "${format}", "theme": "${subject}", "visual_audio_direction": "direção de arte épica", "script_or_slides": ["parte 1", "parte 2", "..."], "caption": "legenda humanizada", "strategic_logic": "por que isso vende?" }`;
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

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.listen(PORT, "0.0.0.0", () => log.info(`🔥 Ideale Platinum v3.1 ativo em ${BASE_URL}`));
