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
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

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

const IS_PROD = NODE_ENV === "production";

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    name: "igplanner.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", limiter);

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
          fields: "id,name,username,followers_count,media_count,biography,website,profile_picture_url,account_type",
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

  if (!parsed) throw new Error("Groq retornou JSON inválido.");
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

  if (!parsed) throw new Error("Gemini retornou JSON inválido.");
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
        return await callGeminiJSON({ system, user });
      }

      if (!gemini) throw error;
      return await callGeminiJSON({ system, user });
    }
  }

  return await callGeminiJSON({ system, user });
}

function getAccountFromSession(req, igId) {
  const accounts = req.session?.user?.accounts || [];
  return accounts.find((a) => a.id === igId);
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

function calculateStrategicScore(account, media) {
  let score = 0;

  if (account.biography) score += 15;
  if (account.website) score += 10;
  if (media.length >= 12) score += 20;
  else if (media.length >= 6) score += 12;
  else score += 6;

  const formats = new Set(media.map((m) => m.media_type));
  if (formats.size >= 3) score += 15;
  else if (formats.size === 2) score += 10;
  else score += 4;

  const engagementAvg = avg(
    media.map((m) => Number(m.like_count || 0) + Number(m.comments_count || 0))
  );
  const followers = Number(account.followers_count || 0) || 1;
  const engagementRate = (engagementAvg / followers) * 100;

  if (engagementRate >= 3) score += 20;
  else if (engagementRate >= 1.5) score += 14;
  else if (engagementRate >= 0.8) score += 8;
  else score += 4;

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

  const strategic_score = calculateStrategicScore(account, media);

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
    metrics: {
      avg_likes: Math.round(avg(likes)),
      avg_comments: Math.round(avg(comments)),
      avg_engagement: Math.round(engagementAverage),
      engagement_rate: Number(engagementRate)
    },
    strategic_score,
    strategic_score_label: scoreLabel(strategic_score),
    format_mix: byFormat,
    top_posts: topPosts
  };
}

function plannerSystemPrompt() {
  return `
Você é um estrategista sênior de conteúdo, copy e posicionamento para Instagram.

Regras:
- escreva em português do Brasil
- retorne sempre JSON válido
- nada genérico
- nada de "você sabia", "entenda", "saiba mais", "conheça nossa equipe"
- toda legenda precisa entregar valor real
- reels precisam ter roteiro
- carrossel precisa ter slides
- stories precisam ser úteis
`;
}

function evaluatePostQuality(post) {
  let score = 0;

  if (post?.hook && post.hook.length > 40) score += 20;
  if (post?.copy && post.copy.length > 300) score += 30;
  if (post?.cta && post.cta.length > 20) score += 10;
  if (post?.format === "Reels" && post?.script && post.script.length > 200) score += 20;
  if (post?.format === "Carrossel" && Array.isArray(post?.carousel_slides) && post.carousel_slides.length >= 5) score += 20;

  return Math.min(score, 100);
}

async function improveWeakPost(post) {
  try {
    const improved = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: `
Melhore este post e retorne o mesmo JSON, mais forte, mais específico e menos genérico.

POST:
${JSON.stringify(post, null, 2)}
`,
      maxTokens: 1600,
      temperature: 0.8
    });

    return improved;
  } catch {
    return post;
  }
}

async function captureInstagramProfileScreenshot(username) {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 2200 }
    });

    const cleanUsername = String(username || "").replace("@", "").trim();
    const url = `https://www.instagram.com/${cleanUsername}/`;

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(3500);

    const bodyText = await page.textContent("body").catch(() => "");
    const lower = String(bodyText || "").toLowerCase();

    if (
      lower.includes("login") ||
      lower.includes("entrar") ||
      lower.includes("sign up") ||
      lower.includes("something went wrong")
    ) {
      throw new Error("Instagram bloqueou a visualização pública para este perfil.");
    }

    const filename = `competitor_${cleanUsername}_${Date.now()}.png`;
    const filepath = path.join(PUBLIC_TMP_DIR, filename);

    await page.screenshot({
      path: filepath,
      fullPage: true
    });

    return {
      success: true,
      imageUrl: `/tmp/${filename}`,
      sourceUrl: url
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Falha ao gerar screenshot."
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function addPdfCover(doc, title, subtitle = "") {
  doc.rect(0, 0, doc.page.width, 170).fill("#19152f");

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 40, 36, { fit: [140, 70] });
  }

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24).text(title, 40, 90, {
    width: doc.page.width - 80,
    align: "center"
  });

  if (subtitle) {
    doc.font("Helvetica").fontSize(12).text(subtitle, 40, 120, {
      width: doc.page.width - 80,
      align: "center"
    });
  }

  doc.moveDown(7);
  doc.fillColor("#111111");
}

function addSectionTitle(doc, title) {
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111").text(title);
  doc.moveDown(0.4);
}

function addListItems(doc, items = []) {
  doc.font("Helvetica").fontSize(10);
  items.forEach((item) => doc.text(`• ${item}`));
  doc.moveDown(0.4);
}

app.post("/api/auth", async (req, res) => {
  if (!IG_TOKENS.length) {
    return res.status(400).json({ success: false, error: "Nenhum token configurado em IG_TOKENS." });
  }

  try {
    const accounts = await fetchIGProfiles(IG_TOKENS);

    if (!accounts.length) {
      return res.status(400).json({
        success: false,
        error: "Nenhuma conta foi carregada com os tokens atuais."
      });
    }

    req.session.user = { accounts };
    req.session.logged = true;

    req.session.save((err) => {
      if (err) {
        console.error("[SESSION_SAVE_ERROR]", err);
        return res.status(500).json({ success: false, error: "Erro ao salvar sessão." });
      }

      return res.json({
        success: true,
        accounts: accounts.map((a) => ({
          id: a.id,
          username: a.username,
          followers_count: a.followers_count
        }))
      });
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/me", (req, res) => {
  const accounts = req.session?.user?.accounts || [];
  const logged = Boolean(req.session?.logged && accounts.length);

  return res.json({
    logged,
    accounts
  });
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.post("/api/test-token", async (req, res) => {
  const token = (req.body?.token || "").trim();
  if (!token) return res.status(400).json({ success: false, error: "Token vazio." });

  try {
    const accounts = await fetchIGProfiles([token]);
    if (!accounts.length) {
      return res.status(400).json({ success: false, error: "Token inválido ou sem acesso." });
    }

    if (!req.session.user) req.session.user = { accounts: [] };

    for (const acc of accounts) {
      const exists = req.session.user.accounts.find((a) => a.id === acc.id);
      if (!exists) req.session.user.accounts.push(acc);
    }

    req.session.logged = true;

    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ success: false, error: "Erro ao salvar sessão." });
      }

      return res.json({ success: true, accounts });
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/dashboard/:igId", async (req, res) => {
  const account = getAccountFromSession(req, req.params.igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 30);
  return res.json({
    ...buildDashboard(media, account),
    media_sample: media.slice(0, 12)
  });
});

app.post("/api/suggest", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { igId } = req.body || {};
  const account = getAccountFromSession(req, igId);

  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 18);

  const prompt = `
Faça um auto preenchimento estratégico para esta conta.

Perfil:
- @${account.username}
- Nome: ${account.name || ""}
- Bio: ${account.biography || ""}
- Website: ${account.website || ""}
- Seguidores: ${account.followers_count || 0}

Posts recentes:
${summarizePosts(media, 6, 90)}

Retorne exatamente neste JSON:
{
  "niche": "",
  "audience": "",
  "goal": "",
  "tone": "",
  "location": "",
  "extra": ""
}
`;

  try {
    const data = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: prompt,
      maxTokens: 1000,
      temperature: 0.4
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/client-memory/:username", (req, res) => {
  try {
    const data = getClientMemory(req.params.username);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/client-memory/:username", (req, res) => {
  try {
    const merged = mergeClientMemory(req.params.username, req.body || {});
    return res.json({ success: true, data: merged });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/intelligence", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { igId, niche = "", audience = "", goal = "", tone = "", extra = "", location = "" } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 20);
  const dashboard = buildDashboard(media, account);

  const userPrompt = `
Faça uma análise estratégica profunda deste perfil.

Perfil:
- @${account.username}
- Nicho: ${niche}
- Público: ${audience}
- Objetivo: ${goal}
- Tom: ${tone}
- Localização: ${location}
- Contexto extra: ${extra}

Dashboard:
${JSON.stringify(dashboard, null, 2)}

Posts recentes:
${summarizePosts(media, 6, 90)}

Retorne exatamente neste JSON:
{
  "executive_summary": "",
  "diagnosis": {
    "positioning": "",
    "content_strength": "",
    "content_gap": "",
    "engagement_read": "",
    "funnel_read": ""
  },
  "local_market_read": "",
  "opportunities": ["", "", "", ""],
  "priority_actions": ["", "", "", ""],
  "content_angles": ["", "", "", "", ""],
  "bio_suggestions": ["", "", ""]
}
`;

  try {
    const data = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 2400,
      temperature: 0.7
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/competitors", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const {
    igId,
    niche = "",
    audience = "",
    competitors = [],
    location = "",
    goal = "",
    tone = "",
    extra = ""
  } = req.body || {};

  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 12);

  const competitorsData = (competitors || [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .map((c) => ({ username: c.startsWith("@") ? c : `@${c}` }));

  const userPrompt = `
Faça uma análise estratégica profunda de concorrência.

Perfil analisado:
- @${account.username}
- Nicho: ${niche}
- Público: ${audience}
- Objetivo: ${goal}
- Tom: ${tone}
- Localização: ${location}
- Contexto extra: ${extra}

Bio atual:
${account.biography || "Não informada"}

Link atual:
${account.website || "Não informado"}

Posts recentes:
${summarizePosts(media, 6, 90)}

Concorrentes:
${JSON.stringify(competitorsData, null, 2)}

Inclua também:
- score competitivo de 0 a 100
- nível de ameaça: baixo, médio ou alto
- quem está ganhando mais atenção hoje

Retorne exatamente neste JSON:
{
  "market_overview": "",
  "competitors_analysis": [
    {
      "username": "@concorrente",
      "score": 0,
      "threat_level": "",
      "positioning": "",
      "content_style": "",
      "visual_style": "",
      "attention_winner_reason": "",
      "strengths": ["", ""],
      "weaknesses": ["", ""],
      "opportunity_against": ""
    }
  ],
  "comparative_analysis": {
    "where_you_are_stronger": ["", ""],
    "where_you_are_weaker": ["", ""],
    "positioning_gap": ""
  },
  "bio_optimization": {
    "analysis": "",
    "improvements": ["", "", ""],
    "bio_suggestions": [
      { "type": "direta", "bio": "", "char_count": 0 },
      { "type": "autoridade", "bio": "", "char_count": 0 },
      { "type": "conversão", "bio": "", "char_count": 0 }
    ]
  },
  "profile_optimization": {
    "name_suggestions": [
      { "name": "", "char_count": 0 },
      { "name": "", "char_count": 0 },
      { "name": "", "char_count": 0 }
    ],
    "highlights_suggestions": ["", "", "", "", ""],
    "link_bio_recommendation": ""
  },
  "strategic_direction": ["", "", ""]
}
`;

  try {
    const data = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 3000,
      temperature: 0.75
    });

    const enrichedCompetitors = [];

    for (const comp of data.competitors_analysis || []) {
      const username = String(comp.username || "").replace("@", "").trim();
      const preview = await captureInstagramProfileScreenshot(username);

      enrichedCompetitors.push({
        ...comp,
        preview_image: preview.success ? preview.imageUrl : "",
        preview_error: preview.success ? "" : preview.error
      });
    }

    if (data.bio_optimization?.bio_suggestions) {
      data.bio_optimization.bio_suggestions = data.bio_optimization.bio_suggestions.map((b) => {
        const bio = String(b.bio || "").slice(0, 150);
        return { ...b, bio, char_count: bio.length };
      });
    }

    if (data.profile_optimization?.name_suggestions) {
      data.profile_optimization.name_suggestions = data.profile_optimization.name_suggestions.map((n) => {
        const name = String(n.name || "").slice(0, 64);
        return { ...n, name, char_count: name.length };
      });
    }

    data.competitors_analysis = enrichedCompetitors;

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/improve-post", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { post } = req.body || {};
  if (!post) return res.status(400).json({ error: "Post não enviado." });

  try {
    const improved = await improveWeakPost(post);
    const score = evaluatePostQuality(improved);

    return res.json({
      ...improved,
      quality_score: score,
      quality_label:
        score >= 80 ? "Forte" :
        score >= 60 ? "Bom" :
        score >= 40 ? "Regular" : "Fraco"
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const {
    igId,
    niche = "",
    audience = "",
    goal = "",
    tone = "",
    extra = "",
    location = "",
    mode = "conversao",
    totalPosts = 16,
    reels = 6,
    carousels = 6,
    singlePosts = 4
  } = req.body || {};

  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const total = Number(totalPosts);
  const totalReels = Number(reels);
  const totalCarousels = Number(carousels);
  const totalSingles = Number(singlePosts);

  if (total !== totalReels + totalCarousels + totalSingles) {
    return res.status(400).json({
      error: "O total de posts precisa ser exatamente a soma de reels + carrosséis + estáticos."
    });
  }

  const media = await fetchMedia(account.id, account.ig_token, 20);

  const prompt = `
Monte um planejamento estratégico de Instagram.

Perfil:
- @${account.username}
- Nicho: ${niche}
- Público: ${audience}
- Objetivo: ${goal}
- Tom: ${tone}
- Localização: ${location}
- Contexto extra: ${extra}
- Modo: ${mode}

Mix obrigatório:
- Total: ${total}
- Reels: ${totalReels}
- Carrosséis: ${totalCarousels}
- Estáticos: ${totalSingles}

Posts recentes:
${summarizePosts(media, 6, 90)}

Retorne exatamente neste JSON:
{
  "audit": {
    "summary": "",
    "month_strategy": "",
    "funnel_logic": ""
  },
  "content_pillars": ["", "", ""],
  "priority_ctas": ["", "", ""],
  "posts": [
    {
      "n": 1,
      "week": 1,
      "day_suggestion": "Segunda",
      "format": "Reels",
      "pillar": "Autoridade",
      "intent": "Dor",
      "title": "",
      "objective": "",
      "hook": "",
      "copy": "",
      "cta": "",
      "script": "",
      "carousel_slides": []
    }
  ],
  "stories": [
    {
      "day": "Dia 1",
      "theme": "",
      "objective": "",
      "slides": [
        { "n": 1, "text": "", "action": "" },
        { "n": 2, "text": "", "action": "" },
        { "n": 3, "text": "", "action": "" }
      ]
    }
  ]
}
`;

  try {
    const data = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: prompt,
      maxTokens: 4200,
      temperature: 0.8
    });

    const posts = Array.isArray(data.posts) ? data.posts : [];

    for (let i = 0; i < posts.length; i++) {
      let p = posts[i];
      let score = evaluatePostQuality(p);

      p.quality_score = score;
      p.quality_label =
        score >= 80 ? "Forte" :
        score >= 60 ? "Bom" :
        score >= 40 ? "Regular" : "Fraco";

      if (score < 60) {
        const improved = await improveWeakPost(p);
        score = evaluatePostQuality(improved);

        p = {
          ...improved,
          quality_score: score,
          quality_label: "Ajustado"
        };
      }

      posts[i] = p;
    }

    data.posts = posts;

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/export-report", async (req, res) => {
  try {
    const { type, username = "perfil", payload = {} } = req.body || {};
    const doc = new PDFDocument({ margin: 40, size: "A4" });

    const filename = `${type || "relatorio"}_${sanitizeFileName(username)}_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    doc.pipe(res);

    const titles = {
      planner: "PLANEJAMENTO DE INSTAGRAM",
      intelligence: "ANÁLISE ESTRATÉGICA",
      competitors: "ANÁLISE DE CONCORRÊNCIA",
      memory: "MEMÓRIA DO CLIENTE"
    };

    addPdfCover(doc, titles[type] || "RELATÓRIO", `@${username}`);

    if (type === "intelligence") {
      addSectionTitle(doc, "Resumo executivo");
      doc.font("Helvetica").fontSize(10).text(payload.executive_summary || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Diagnóstico");
      doc.font("Helvetica").fontSize(10).text(`Posicionamento: ${payload.diagnosis?.positioning || ""}`);
      doc.text(`Força atual: ${payload.diagnosis?.content_strength || ""}`);
      doc.text(`Gap: ${payload.diagnosis?.content_gap || ""}`);
      doc.text(`Engajamento: ${payload.diagnosis?.engagement_read || ""}`);
      doc.text(`Funil: ${payload.diagnosis?.funnel_read || ""}`);
      doc.moveDown(0.6);

      addSectionTitle(doc, "Leitura local");
      doc.font("Helvetica").fontSize(10).text(payload.local_market_read || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Oportunidades");
      addListItems(doc, payload.opportunities || []);

      addSectionTitle(doc, "Ações prioritárias");
      addListItems(doc, payload.priority_actions || []);

      addSectionTitle(doc, "Ângulos de conteúdo");
      addListItems(doc, payload.content_angles || []);
    }

    if (type === "competitors") {
      addSectionTitle(doc, "Leitura do mercado");
      doc.font("Helvetica").fontSize(10).text(payload.market_overview || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Concorrentes analisados");
      for (const comp of payload.competitors_analysis || []) {
        doc.font("Helvetica-Bold").fontSize(12).text(`${comp.username || ""} • Score ${comp.score || 0} • ${comp.threat_level || ""}`);
        doc.font("Helvetica").fontSize(10).text(`Posicionamento: ${comp.positioning || ""}`);
        doc.text(`Conteúdo: ${comp.content_style || ""}`);
        doc.text(`Visual: ${comp.visual_style || ""}`);
        doc.text(`Atenção: ${comp.attention_winner_reason || ""}`);
        doc.text(`Forças: ${(comp.strengths || []).join(", ")}`);
        doc.text(`Fraquezas: ${(comp.weaknesses || []).join(", ")}`);
        doc.text(`Como bater: ${comp.opportunity_against || ""}`);
        doc.moveDown(0.6);
      }
    }

    if (type === "planner") {
      addSectionTitle(doc, "Resumo executivo");
      doc.font("Helvetica").fontSize(10).text(payload.audit?.summary || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Estratégia do mês");
      doc.font("Helvetica").fontSize(10).text(payload.audit?.month_strategy || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Funil");
      doc.font("Helvetica").fontSize(10).text(payload.audit?.funnel_logic || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Pilares");
      addListItems(doc, payload.content_pillars || []);

      addSectionTitle(doc, "Posts");
      (payload.posts || []).forEach((post) => {
        doc.font("Helvetica-Bold").fontSize(11).text(`#${post.n} • ${post.format} • ${post.title || ""}`);
        doc.font("Helvetica").fontSize(10).text(`GANCHO:\n${post.hook || ""}\n\nLEGENDA:\n${post.copy || ""}\n\nCTA:\n${post.cta || ""}`);
        doc.moveDown(0.6);
      });
    }

    if (type === "memory") {
      addSectionTitle(doc, "Memória");
      doc.font("Helvetica").fontSize(10).text(JSON.stringify(payload, null, 2));
    }

    doc.end();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/competitor-preview/:username", async (req, res) => {
  const username = String(req.params.username || "").replace("@", "").trim();
  if (!username) return res.status(400).json({ error: "Username inválido." });

  try {
    const result = await captureInstagramProfileScreenshot(username);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

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
    playwright_browsers_path: PLAYWRIGHT_BROWSERS_PATH || "(não definido)",
    has_session: Boolean(req.session?.logged),
    session_id: req.sessionID || null
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/app", (req, res) => {
  if (!req.session?.logged) {
    return res.redirect("/");
  }

  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Instagram Planner Agency 7.2-A rodando em ${BASE_URL}`);
  console.log(`[INIT] GROQ configurado: ${Boolean(GROQ_API_KEY)}`);
  console.log(`[INIT] GEMINI configurado: ${Boolean(GEMINI_API_KEY)}`);
  console.log(`[INIT] Tokens IG configurados: ${IG_TOKENS.length}`);
  console.log(`[INIT] PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH || "(não definido)"}`);
});
