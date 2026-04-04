require("dotenv").config();

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");
const { chromium } = require("playwright");

const app = express();

const PORT = process.env.PORT || 3000;

// ================= CONFIG =================
const GROQ = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const GEMINI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);

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

// ================= IA PROMPT PROFISSIONAL =================
function plannerSystemPrompt() {
  return `
Você é um estrategista sênior de marketing, copywriting e conteúdo para Instagram.

REGRAS CRÍTICAS:
- Proibido conteúdo genérico
- Proibido frases vazias
- Proibido “você sabia”, “entenda”, “saiba mais”
- Nada pode parecer escrito por IA

REGRAS DE QUALIDADE:
- Conteúdo precisa gerar atenção real
- Legenda precisa ensinar ou convencer
- Texto direto e humano

REELS:
- roteiro completo
- abertura forte

CARROSSEL:
- narrativa progressiva
- cada slide com função

POST:
- ensinar, provocar ou quebrar objeção

STORIES:
- práticos e úteis

Retorne sempre JSON válido.
`;
}

// ================= IA ENGINE =================
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

// ================= QUALITY SYSTEM =================
function evaluatePostQuality(post) {
  let score = 0;

  if (post.hook?.length > 40) score += 20;
  if (post.copy?.length > 300) score += 30;
  if (post.cta?.length > 20) score += 10;

  if (post.format === "Reels" && post.script?.length > 200) score += 20;
  if (post.format === "Carrossel" && post.carousel_slides?.length >= 5) score += 20;

  return Math.min(score, 100);
}

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
  } catch {
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

// ================= PLANNER =================
app.post("/api/generate", async (req, res) => {
  const { niche, location } = req.body;

  const prompt = `
${plannerSystemPrompt()}

Crie um planejamento de conteúdo estratégico.

Nicho: ${niche}
Local: ${location}

Retorne JSON com posts completos.
`;

  let raw = await runAI(prompt);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return res.status(500).json({ error: "IA retornou inválido" });
  }

  // score + melhoria automática
  for (let i = 0; i < data.posts.length; i++) {
    let p = data.posts[i];

    p.quality_score = evaluatePostQuality(p);

    if (p.quality_score < 60) {
      try {
        const improvedRaw = await runAI(`
Melhore esse post:

${JSON.stringify(p)}
`);

        const improved = JSON.parse(improvedRaw);

        p = {
          ...improved,
          quality_score: evaluatePostQuality(improved),
          quality_label: "Ajustado"
        };
      } catch {}
    }

    data.posts[i] = p;
  }

  res.json(data);
});

// ================= CONCORRÊNCIA =================
app.post("/api/competitors", async (req, res) => {
  const { competitors } = req.body;

  const prompt = `
Analise concorrentes:

${competitors.join(",")}

Inclua score (0-100) e nível de ameaça.
`;

  const ai = await runAI(prompt);

  res.json({ result: ai });
});

// ================= EXPORT =================
app.post("/api/export-report", (req, res) => {
  const { posts } = req.body;

  const doc = new PDFDocument();

  posts.forEach((p, i) => {
    doc.text(`#${i + 1} ${p.title}`);
    doc.text(`GANCHO:\n${p.hook}`);
    doc.text(`LEGENDA:\n${p.copy}`);
    doc.text(`CTA:\n${p.cta}`);
    doc.moveDown();
  });

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

// ================= HEALTH =================
app.get("/health", (req, res) => res.send("OK"));

// ================= START =================
app.listen(PORT, () => {
  console.log("🔥 RUNNING ON PORT", PORT);
});
