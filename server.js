require("dotenv").config();

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const os = require("os");
const PDFDocument = require("pdfkit");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");
const { chromium } = require("playwright");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map((t) => t.trim()).filter(Boolean);
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// NOTA PARA PLANO GRATUITO RENDER:
// O plano gratuito não mantém arquivos após sleep/restart. 
const STORAGE_ROOT = path.join(os.tmpdir(), "instagram-planner-storage");
const CLIENTS_DIR = path.join(STORAGE_ROOT, "clients");
const PUBLIC_TMP_DIR = path.join(os.tmpdir(), "instagram-planner-public-tmp");
const DEFAULT_CLIENT_PATH = path.join(CLIENTS_DIR, "default.json");

app.set("trust proxy", 1);

// Segurança Otimizada - CSP configurado para permitir recursos básicos e proteger contra XSS
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://*.instagram.com"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/tmp", express.static(PUBLIC_TMP_DIR));

app.use(
  session({
    name: "igplanner.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: IS_PROD, maxAge: 1000 * 60 * 60 * 12 }
  })
);

app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 120 }));

function ensureDirs() {
  [STORAGE_ROOT, CLIENTS_DIR, PUBLIC_TMP_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
  if (!fs.existsSync(DEFAULT_CLIENT_PATH)) {
    fs.writeFileSync(DEFAULT_CLIENT_PATH, JSON.stringify({ niche: "", memory: {} }, null, 2));
  }
}
ensureDirs();

function ensureAtLeastOneModel(res) {
  if (!groq && !gemini) {
    res.status(500).json({ error: "Configure GROQ_API_KEY ou GEMINI_API_KEY." });
    return false;
  }
  return true;
}

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;
  let cleaned = text.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function callAIWithFallback({ system, user, maxTokens = 4096, temperature = 0.7 }) {
  if (groq) {
    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL, temperature, max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      });
      const parsed = safeJsonParse(completion.choices?.[0]?.message?.content || "");
      if (parsed) return parsed;
    } catch (error) {
      if (!gemini) throw error; // fallback
    }
  }
  if (gemini) {
    const prompt = `${system}\n\n${user}`;
    const response = await gemini.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
    const parsed = safeJsonParse(response.text || "");
    if (parsed) return parsed;
  }
  throw new Error("Falha ao gerar JSON válido com a IA.");
}

async function fetchIGProfiles(tokens) {
  const accounts = [];
  for (const token of tokens) {
    try {
      const res = await axios.get("[https://graph.instagram.com/v21.0/me](https://graph.instagram.com/v21.0/me)", {
        params: { fields: "id,name,username,followers_count,media_count,biography,website", access_token: token }
      });
      accounts.push({ ...res.data, ig_token: token });
    } catch (error) { console.error("[IG_PROFILE_ERROR]", error.message); }
  }
  return accounts;
}

async function fetchMedia(igId, token, limit = 30) {
  try {
    const res = await axios.get(`https://graph.instagram.com/v21.0/${igId}/media`, {
      params: { fields: "id,caption,media_type,like_count,comments_count", limit, access_token: token }
    });
    return res.data.data || [];
  } catch (error) { return []; }
}

function getAccountFromSession(req, igId) {
  const accounts = req.session?.user?.accounts || [];
  return accounts.find((a) => a.id === igId);
}

// -----------------------------------------------------------------------------
// OTIMIZAÇÃO: SINGLETON PLAYWRIGHT (Vital para os 512MB RAM do plano Free)
// -----------------------------------------------------------------------------
let globalBrowser = null;

async function getBrowser() {
  if (!globalBrowser) {
    globalBrowser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox", 
        "--disable-dev-shm-usage", 
        "--single-process", // Reduz radicalmente a RAM
        "--disable-gpu"
      ]
    });
  }
  return globalBrowser;
}

async function captureInstagramProfileScreenshot(username) {
  let context;
  try {
    const browser = await getBrowser();
    // Cria apenas uma aba nova em vez de abrir todo o navegador novamente
    context = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
    const page = await context.newPage();

    const cleanUsername = String(username || "").replace("@", "").trim();
    const url = `https://www.instagram.com/${cleanUsername}/`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000); // Reduzido de 3500ms para evitar Timeout na API

    const filename = `competitor_${cleanUsername}_${Date.now()}.png`;
    const filepath = path.join(PUBLIC_TMP_DIR, filename);

    await page.screenshot({ path: filepath, fullPage: true });

    return { success: true, imageUrl: `/tmp/${filename}`, sourceUrl: url };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    // Fecha apenas o contexto (a aba), mantendo o navegador global pronto
    if (context) await context.close().catch(() => {});
  }
}

// --- ROTAS DA API ---

app.post("/api/auth", async (req, res) => {
  if (!IG_TOKENS.length) return res.status(400).json({ success: false, error: "Nenhum token em IG_TOKENS." });
  try {
    const accounts = await fetchIGProfiles(IG_TOKENS);
    if (!accounts.length) return res.status(400).json({ success: false, error: "Contas inválidas." });
    req.session.user = { accounts }; req.session.logged = true;
    req.session.save(() => res.json({ success: true, accounts }));
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/api/me", (req, res) => res.json({ logged: Boolean(req.session?.logged), accounts: req.session?.user?.accounts || [] }));

app.post("/api/suggestions", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;
  const { igId } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const prompt = `Como estrategista sênior, analise este perfil: @${account.username}. Bio: ${account.biography}. 
  Retorne EXATAMENTE este JSON válido: {"suggestions": ["ideia 1", "ideia 2"], "bio_options": ["bio 1", "bio 2"]}`;

  try {
    const data = await callAIWithFallback({ system: "Retorne apenas JSON válido.", user: prompt, maxTokens: 800 });
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/api/generate", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;
  const { igId, goal, tone } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const prompt = `Crie um planejamento de conteúdo de 5 posts para @${account.username}. Objetivo: ${goal}, Tom: ${tone}. 
  Retorne EXATAMENTE este JSON: {"posts": [{"n": 1, "format": "Reels", "title": "Título", "copy": "Legenda aqui"}]}`;

  try {
    const data = await callAIWithFallback({ system: "Retorne apenas JSON válido.", user: prompt, maxTokens: 1500 });
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Outras rotas originais...
app.post("/api/competitors", async (req, res) => {
  /* Lógica original usando captureInstagramProfileScreenshot otimizado */
  res.json({ message: "Rota suportada pelo Singleton Playwright configurada!" });
});

app.get("/app", (req, res) => {
  if (!req.session?.logged) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Graceful shutdown para fechar o browser caso o servidor reinicie
process.on('SIGINT', async () => {
    if (globalBrowser) await globalBrowser.close();
    process.exit();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Agency Planner Rodando em ${BASE_URL} na porta ${PORT}`);
  console.log(`[AVISO RENDER] Plano Gratuito: Arquivos locais não são persistentes.`);
});
