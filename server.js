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
const IS_PROD = process.env.NODE_ENV === "production";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const SESSION_SECRET = process.env.SESSION_SECRET || "agency-secret-123";
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Configuração de Pastas Temporárias (Padrão Render Free)
const STORAGE_ROOT = path.join(os.tmpdir(), "planner-agency-storage");
const CLIENTS_DIR = path.join(STORAGE_ROOT, "clients");
const PUBLIC_TMP_DIR = path.join(__dirname, "public", "tmp");

if (!fs.existsSync(CLIENTS_DIR)) fs.mkdirSync(CLIENTS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_TMP_DIR)) fs.mkdirSync(PUBLIC_TMP_DIR, { recursive: true });

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/tmp", express.static(PUBLIC_TMP_DIR));

app.use(session({
  name: "planner.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 }
}));

// --- SINGLETON BROWSER (ECONOMIA DE RAM) ---
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
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" }
    });
    return JSON.parse(res.choices[0].message.content);
  }
  const model = gemini.getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await model.generateContent(`${system}\n\n${user}`);
  return safeJsonParse(result.response.text());
}

// --- ROTAS API ---
app.post("/api/auth", async (req, res) => {
  try {
    const accounts = [];
    for (const token of IG_TOKENS) {
      const r = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
      });
      accounts.push({ ...r.data, ig_token: token });
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
    const er = (((likes + comms) / media.length) / (acc.followers_count || 1) * 100).toFixed(2);
    
    const formats = media.reduce((acc, m) => {
      acc[m.media_type] = (acc[m.media_type] || 0) + 1;
      return acc;
    }, {});

    res.json({
      metrics: { engagement_rate: er, avg_likes: Math.round(likes/media.length), avg_comments: Math.round(comms/media.length) },
      format_mix: formats,
      recent_posts: media.slice(0, 10)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/intelligence", async (req, res) => {
  const { igId, niche, audience } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  const prompt = `Analise o perfil @${acc.username}. Nicho: ${niche}, Público: ${audience}. Bio atual: ${acc.biography}. 
  Retorne JSON: { "executive_summary": "", "priority_actions": [], "bio_suggestions": [] }`;
  const data = await callAI({ system: "Você é um estrategista sênior.", user: prompt });
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
    const analysis = await callAI({ system: "Analise concorrente", user: `O perfil @${username} foca em qual estilo?` });
    res.json({ screenshot: `/tmp/${filename}`, analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { await context.close(); }
});

app.post("/api/generate", async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  const prompt = `Crie um plano de 30 dias para @${acc.username}. Objetivo: ${goal}, Tom: ${tone}. 
  Mix: ${reels} Reels, ${carousels} Carrosséis, ${singlePosts} Estáticos.
  Retorne JSON: { "posts": [{ "n": 1, "format": "", "pillar": "", "title": "", "hook": "", "copy": "" }] }`;
  const data = await callAI({ system: "Estrategista de copy e funil.", user: prompt });
  res.json(data);
});

app.post("/api/export-report", (req, res) => {
  const { payload, username } = req.body;
  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);
  doc.fontSize(20).text(`Relatório Estratégico: @${username}`, { align: "center" });
  doc.moveDown().fontSize(12).text(JSON.stringify(payload, null, 2));
  doc.end();
});

app.listen(PORT, "0.0.0.0", () => console.log(`🔥 Agency Pro em ${BASE_URL}`));
