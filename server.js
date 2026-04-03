require("dotenv").config();

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const GROQ = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const GEMINI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const IG_TOKENS = (process.env.IG_TOKENS || "").split(",");

// ================= MIDDLEWARE =================
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

app.use(
  session({
    secret: "agency-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// ================= HEALTH =================
app.get("/health", (req, res) => res.send("OK"));

// ================= AUTH =================
app.post("/api/auth", async (req, res) => {
  try {
    const accounts = [];

    for (let token of IG_TOKENS) {
      const r = await axios.get(`https://graph.instagram.com/me`, {
        params: {
          fields: "id,username,followers_count",
          access_token: token,
        },
      });

      accounts.push({ ...r.data, token });
    }

    req.session.user = { accounts };

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao autenticar" });
  }
});

app.get("/api/me", (req, res) => {
  res.json(req.session.user || { accounts: [] });
});

// ================= DASHBOARD =================
app.get("/api/dashboard/:id", async (req, res) => {
  const acc = req.session.user.accounts.find(a => a.id === req.params.id);

  const r = await axios.get(`https://graph.instagram.com/${acc.id}/media`, {
    params: {
      fields: "id,caption,media_type,like_count,comments_count",
      access_token: acc.token,
    },
  });

  res.json({ media: r.data.data });
});

// ================= IA =================
async function runAI(prompt) {
  try {
    if (GROQ) {
      const r = await GROQ.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
      });

      return r.choices[0].message.content;
    }
  } catch {}

  const r = await GEMINI.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  });

  return r.text;
}

// ================= PLANNER =================
app.post("/api/generate", async (req, res) => {
  const { niche, location } = req.body;

  const prompt = `
Crie um planejamento de Instagram altamente estratégico.

Nicho: ${niche}
Local: ${location}

Regras:
- conteúdo que gera venda
- nada genérico
- reels com roteiro
- carrossel com slides
- legenda completa

Retorne JSON com posts.
`;

  const ai = await runAI(prompt);

  res.json({ result: ai });
});

// ================= INTELIGÊNCIA =================
app.post("/api/intelligence", async (req, res) => {
  const prompt = `Analise o perfil e dê estratégia avançada`;

  const ai = await runAI(prompt);

  res.json({ result: ai });
});

// ================= CONCORRÊNCIA =================
app.post("/api/competitors", async (req, res) => {
  const { competitors } = req.body;

  const prompt = `
Analise concorrentes:
${competitors.join(",")}
`;

  const ai = await runAI(prompt);

  res.json({ result: ai });
});

// ================= EXPORT =================
app.post("/api/export-report", (req, res) => {
  const doc = new PDFDocument();
  doc.text("Relatório gerado");
  doc.pipe(res);
  doc.end();
});

// ================= FRONT =================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public/app.html"));
});

// ================= START =================
app.listen(PORT, () => {
  console.log("🔥 RUNNING ON PORT", PORT);
});
