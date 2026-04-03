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

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";

const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const IG_TOKENS = (process.env.IG_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "";

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.set("trust proxy", 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: NODE_ENV === "production",
      httpOnly: true,
      sameSite: NODE_ENV === "production" ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

const DATA_DIR = path.join(__dirname, "data");
const CLIENTS_DIR = path.join(DATA_DIR, "clients");
const DEFAULT_CLIENT_PATH = path.join(CLIENTS_DIR, "default.json");
const PUBLIC_TMP_DIR = path.join(__dirname, "public", "tmp");
const LOGO_PATH = path.join(__dirname, "public", "assets", "ideale-logo.png");

function ensureDirs() {
  [DATA_DIR, CLIENTS_DIR, PUBLIC_TMP_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  if (!fs.existsSync(DEFAULT_CLIENT_PATH)) {
    fs.writeFileSync(
      DEFAULT_CLIENT_PATH,
      JSON.stringify(
        {
          niche: "",
          audience: "",
          location: "",
          tone: "",
          goals: [],
          differentials: [],
          cta_style: "",
          forbidden_words: [
            "você sabia",
            "entenda",
            "saiba mais",
            "nossa equipe explica",
            "podemos ajudar",
            "veja como"
          ],
          memory: {
            what_works: [],
            what_doesnt_work: [],
            strong_angles: []
          }
        },
        null,
        2
      )
    );
  }
}

ensureDirs();

function sanitizeFileName(value) {
  return String(value || "cliente")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .toLowerCase();
}

function ensureAtLeastOneModel(res) {
  if (!groq && !gemini) {
    res.status(500).json({ error: "Configure GROQ_API_KEY ou GEMINI_API_KEY." });
    return false;
  }
  return true;
}

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");

  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  } else if (firstBracket !== -1 && lastBracket !== -1 && firstBracket < lastBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function compactText(value, max = 300) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizePosts(media = [], maxItems = 8, captionMax = 120) {
  return media
    .slice(0, maxItems)
    .map((m, i) => {
      const caption = compactText(m.caption || "Sem legenda", captionMax);
      return `${i + 1}. [${m.media_type}] ${caption} | likes=${m.like_count || 0} | comments=${m.comments_count || 0}`;
    })
    .join("\n");
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function fetchIGProfiles(tokens) {
  const accounts = [];

  for (const token of tokens) {
    try {
      const res = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: {
          fields:
            "id,name,username,followers_count,media_count,biography,website,profile_picture_url,account_type",
          access_token: token
        }
      });

      accounts.push({
        ...res.data,
        ig_token: token
      });
    } catch (error) {
      console.error("[IG_PROFILE_ERROR]", error.response?.data || error.message);
    }
  }

  return accounts;
}

async function fetchMedia(igId, token, limit = 30) {
  try {
    const res = await axios.get(`https://graph.instagram.com/v21.0/${igId}/media`, {
      params: {
        fields: "id,caption,media_type,timestamp,like_count,comments_count,permalink",
        limit,
        access_token: token
      }
    });

    return res.data.data || [];
  } catch (error) {
    console.error("[IG_MEDIA_ERROR]", error.response?.data || error.message);
    return [];
  }
}

async function callGroqJSON({ system, user, maxTokens = 4096, temperature = 0.7 }) {
  if (!groq) throw new Error("GROQ_API_KEY não configurada");

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const text = completion.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(text);

  if (!parsed) {
    throw new Error("Groq retornou JSON inválido.");
  }

  return parsed;
}

async function callGeminiJSON({ system, user }) {
  if (!gemini) throw new Error("GEMINI_API_KEY não configurada");

  const prompt = `${system}\n\n${user}`;

  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  });

  const text = response.text || "";
  const parsed = safeJsonParse(text);

  if (!parsed) {
    throw new Error("Gemini retornou JSON inválido.");
  }

  return parsed;
}

function shouldFallbackToGemini(error) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("request too large") ||
    msg.includes("tokens per minute") ||
    msg.includes("rate_limit_exceeded") ||
    (msg.includes("requested") && msg.includes("limit"))
  );
}

async function callAIWithFallback({ system, user, maxTokens = 4096, temperature = 0.7 }) {
  if (groq) {
    try {
      return await callGroqJSON({ system, user, maxTokens, temperature });
    } catch (error) {
      console.log("[AI] Groq falhou:", error.message);

      if (gemini && shouldFallbackToGemini(error)) {
        console.log("[AI] Usando fallback para Gemini...");
        return await callGeminiJSON({ system, user });
      }

      if (!gemini) throw error;

      console.log("[AI] Groq falhou por outro motivo, tentando Gemini...");
      return await callGeminiJSON({ system, user });
    }
  }

  return await callGeminiJSON({ system, user });
}

function getAccountFromSession(req, igId) {
  const accounts = req.session?.user?.accounts || [];
  return accounts.find((a) => a.id === igId);
}

function calculateStrategicScore(account, media, metrics, formatMix) {
  let score = 0;

  if (account.biography) score += 20;
  if (account.website) score += 10;
  if (media.length >= 12) score += 20;
  else if (media.length >= 6) score += 12;
  else score += 6;

  const formats = Object.keys(formatMix || {});
  if (formats.length >= 3) score += 15;
  else if (formats.length === 2) score += 10;
  else score += 4;

  const engagementRate = Number(metrics.engagement_rate || 0);
  if (engagementRate >= 3) score += 20;
  else if (engagementRate >= 1.5) score += 14;
  else if (engagementRate >= 0.8) score += 8;
  else score += 4;

  const freq = metrics.posting_frequency_days;
  if (freq && freq <= 3) score += 15;
  else if (freq && freq <= 7) score += 10;
  else if (freq) score += 5;

  return Math.min(100, Math.round(score));
}

function scoreLabel(score) {
  if (score >= 80) return "Muito forte";
  if (score >= 60) return "Bom";
  if (score >= 40) return "Regular";
  return "Fraco";
}

function buildDashboard(media, account) {
  const likes = media.map((m) => Number(m.like_count || 0));
  const comments = media.map((m) => Number(m.comments_count || 0));
  const engagementAverage = avg(
    media.map((m) => Number(m.like_count || 0) + Number(m.comments_count || 0))
  );
  const followerBase = Number(account.followers_count || 0) || 1;
  const engagementRate = ((engagementAverage / followerBase) * 100).toFixed(2);

  const byFormat = media.reduce((acc, item) => {
    const key = item.media_type || "UNKNOWN";
    if (!acc[key]) acc[key] = { count: 0, likes: 0, comments: 0 };
    acc[key].count += 1;
    acc[key].likes += Number(item.like_count || 0);
    acc[key].comments += Number(item.comments_count || 0);
    return acc;
  }, {});

  const topPosts = [...media]
    .sort((a, b) => {
      const aScore = Number(a.like_count || 0) + Number(a.comments_count || 0);
      const bScore = Number(b.like_count || 0) + Number(b.comments_count || 0);
      return bScore - aScore;
    })
    .slice(0, 5);

  const recentFrequencyDays = (() => {
    if (media.length < 2) return null;
    const ordered = [...media].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let totalDiff = 0;
    for (let i = 1; i < ordered.length; i++) {
      const prev = new Date(ordered[i - 1].timestamp).getTime();
      const curr = new Date(ordered[i].timestamp).getTime();
      totalDiff += Math.abs(curr - prev);
    }
    return Math.round(totalDiff / (ordered.length - 1) / (1000 * 60 * 60 * 24));
  })();

  const metrics = {
    avg_likes: Math.round(avg(likes)),
    avg_comments: Math.round(avg(comments)),
    avg_engagement: Math.round(engagementAverage),
    engagement_rate: Number(engagementRate),
    posting_frequency_days: recentFrequencyDays
  };

  const strategic_score = calculateStrategicScore(account, media, metrics, byFormat);

  return {
    account: {
      id: account.id,
      username: account.username,
      name: account.name,
      biography: account.biography || "",
      website: account.website || "",
      followers_count: Number(account.followers_count || 0),
      media_count: Number(account.media_count || 0)
    },
    metrics,
    strategic_score,
    strategic_score_label: scoreLabel(strategic_score),
    format_mix: byFormat,
    top_posts: topPosts
  };
}

function getClientFilePath(username) {
  return path.join(CLIENTS_DIR, `${sanitizeFileName(username)}.json`);
}

function getClientMemory(username) {
  const clientPath = getClientFilePath(username);
  try {
    if (fs.existsSync(clientPath)) {
      return JSON.parse(fs.readFileSync(clientPath, "utf8"));
    }
    return JSON.parse(fs.readFileSync(DEFAULT_CLIENT_PATH, "utf8"));
  } catch {
    return JSON.parse(fs.readFileSync(DEFAULT_CLIENT_PATH, "utf8"));
  }
}

function saveClientMemory(username, data) {
  const clientPath = getClientFilePath(username);
  fs.writeFileSync(clientPath, JSON.stringify(data, null, 2));
}

function mergeClientMemory(username, patch) {
  const current = getClientMemory(username);
  const merged = {
    ...current,
    ...patch,
    memory: {
      ...(current.memory || {}),
      ...(patch.memory || {})
    }
  };
  saveClientMemory(username, merged);
  return merged;
}

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    groq: Boolean(GROQ_API_KEY),
    gemini: Boolean(GEMINI_API_KEY),
    tokens_configured: IG_TOKENS.length,
    base_url: BASE_URL,
    groq_model: GROQ_MODEL,
    gemini_model: GEMINI_MODEL,
    clients_dir: CLIENTS_DIR,
    playwright_browsers_path: PLAYWRIGHT_BROWSERS_PATH || "(não definido)"
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/app", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Instagram Planner Agency 6.4.3 rodando em ${BASE_URL}`);
  console.log(`[INIT] GROQ configurado: ${Boolean(GROQ_API_KEY)}`);
  console.log(`[INIT] GEMINI configurado: ${Boolean(GEMINI_API_KEY)}`);
  console.log(`[INIT] Tokens IG configurados: ${IG_TOKENS.length}`);
  console.log(`[INIT] PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH || "(não definido)"}`);
});
