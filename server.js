require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MemoryStore = require('memorystore')(session);
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
const mongoose = require("mongoose");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const IS_PROD = process.env.NODE_ENV === "production";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const SESSION_SECRET = process.env.SESSION_SECRET || "agency-secret-123";
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);
const MONGODB_URI = process.env.MONGODB_URI || "";

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// ==========================================
// 1. CONEXÃO COM O MONGODB ATLAS (PERSISTÊNCIA)
// ==========================================
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Conectado! Memória Permanente Ativada."))
    .catch(err => console.error("❌ Erro MongoDB:", err));
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
  }
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

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/tmp", express.static(PUBLIC_TMP_DIR));

// Redirecionamento amigável para o front-end
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.use(session({
  name: "planner.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({ checkPeriod: 86400000 }),
  cookie: { httpOnly: true, secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 }
}));

// --- SINGLETON BROWSER (POUPANÇA DE RAM) ---
let _browser = null;
async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
    });
  }
  return _browser;
}

// --- UTILITÁRIOS DE IA ---
function safeJsonParse(text) {
  try {
    let cleaned = text.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) { return null; }
}

async function callAI({ system, user }) {
  if (groq) {
    try {
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" }
      });
      return JSON.parse(res.choices[0].message.content);
    } catch (err) { if (!gemini) throw err; }
  }
  const model = gemini.getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await model.generateContent(`${system}\n\n${user}`);
  return safeJsonParse(result.response.text());
}

// --- ROTAS DA API ---
app.post("/api/auth", async (req, res) => {
  try {
    const accounts = [];
    for (const token of IG_TOKENS) {
      const r = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
      });
      accounts.push({ ...r.data, ig_token: token });
      await getClientMemory(r.data.username);
    }
    req.session.logged = true;
    req.session.accounts = accounts;
    res.json({ success: true, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", (req, res) => res.json({ logged: !!req.session.logged, accounts: req.session.accounts || [] }));

app.get("/api/dashboard/:igId", async (req, res) => {
  const acc = (req.session.accounts || []).find(a => a.id === req.params.igId);
  if (!acc) return res.status(404).send();
  try {
    const r = await axios.get(`https://graph.instagram.com/v21.0/${acc.id}/media`, {
      params: { fields: "id,caption,media_type,like_count,comments_count,timestamp", limit: 20, access_token: acc.ig_token }
    });
    const media = r.data.data || [];
    const likes = media.reduce((a, b) => a + (b.like_count || 0), 0);
    const comms = media.reduce((a, b) => a + (b.comments_count || 0), 0);
    const er = (((likes + comms) / (media.length || 1)) / (acc.followers_count || 1) * 100).toFixed(2);
    
    res.json({
      metrics: { engagement_rate: er, avg_likes: Math.round(likes/(media.length || 1)), avg_comments: Math.round(comms/(media.length || 1)) },
      format_mix: media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type] || 0) + 1; return acc; }, {}),
      recent_posts: media.slice(0, 10)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/intelligence", async (req, res) => {
  const { igId, niche, audience } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  const mem = await getClientMemory(acc.username);
  
  const prompt = `Analise @${acc.username}. Nicho: ${niche}. Público: ${audience}. 
  Palavras proibidas: ${mem.forbidden_words.join(", ")}.
  Retorne JSON: { "executive_summary": "", "priority_actions": [], "bio_suggestions": [] }`;
  
  const data = await callAI({ system: "Estrategista sénior.", user: prompt });
  res.json(data);
});

app.post("/api/competitors", async (req, res) => {
  const { username } = req.body;
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`https://www.instagram.com/${username.replace('@','')}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const filename = `comp_${Date.now()}.png`;
    await page.screenshot({ path: path.join(PUBLIC_TMP_DIR, filename) });
    res.json({ screenshot: `/tmp/${filename}`, analysis: "Análise visual concluída." });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { await context.close(); }
});

app.post("/api/generate", async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  const mem = await getClientMemory(acc.username);

  const prompt = `Plano 30 dias para @${acc.username}. Objetivo: ${goal}. Mix: ${reels}R, ${carousels}C, ${singlePosts}S.
  Proibido usar: ${mem.forbidden_words.join(", ")}.
  Retorne JSON: { "posts": [{ "n": 1, "format": "", "pillar": "", "title": "", "hook": "", "copy": "" }] }`;
  
  const data = await callAI({ system: "Estrategista de funil.", user: prompt });
  res.json(data);
});

app.post("/api/export-report", (req, res) => {
  const { payload, username } = req.body;
  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);
  doc.fontSize(20).text(`@${username} - Planeamento`, { align: "center" });
  doc.moveDown().fontSize(10).text(JSON.stringify(payload, null, 2));
  doc.end();
});

app.listen(PORT, "0.0.0.0", () => console.log(`🔥 Agency Pro em ${BASE_URL}`));
