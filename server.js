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

const BASE_URL =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  `http://localhost:${PORT}`;

const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";

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

/**
 * STORAGE
 * Prioridade:
 * 1. caminho explícito vindo do Render disk
 * 2. /var/data (padrão comum quando disk é montado manualmente)
 * 3. pasta temporária gravável
 */
const CANDIDATE_STORAGE_ROOTS = [
  process.env.RENDER_DISK_PATH,
  "/var/data",
  path.join(os.tmpdir(), "instagram-planner-storage")
].filter(Boolean);

function firstWritableDir(candidates) {
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {}
  }
  return path.join(os.tmpdir(), "instagram-planner-storage");
}

const STORAGE_ROOT = firstWritableDir(CANDIDATE_STORAGE_ROOTS);
const CLIENTS_DIR = path.join(STORAGE_ROOT, "clients");
const PUBLIC_TMP_DIR = path.join(os.tmpdir(), "instagram-planner-public-tmp");
const DEFAULT_CLIENT_PATH = path.join(CLIENTS_DIR, "default.json");
const LOGO_PATH = path.join(__dirname, "public", "assets", "ideale-logo.png");

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
app.use("/tmp", express.static(PUBLIC_TMP_DIR));

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

app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

function ensureDirs() {
  [STORAGE_ROOT, CLIENTS_DIR, PUBLIC_TMP_DIR].forEach((dir) => {
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
    contents: prompt
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
      if (gemini && shouldFallbackToGemini(error)) {
        return await callGeminiJSON({ system, user });
      }
      if (!gemini) throw error;
      return await callGeminiJSON({ system, user });
    }
  }

  return await callGeminiJSON({ system, user });
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

function getAccountFromSession(req, igId) {
  const accounts = req.session?.user?.accounts || [];
  return accounts.find((a) => a.id === igId);
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildDashboard(media, account) {
  const likes = media.map((m) => Number(m.like_count || 0));
  const comments = media.map((m) => Number(m.comments_count || 0));
  const engagementAverage = avg(media.map((m) => Number(m.like_count || 0) + Number(m.comments_count || 0)));
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
    format_mix: byFormat,
    top_posts: media.slice(0, 5)
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

async function captureInstagramProfileScreenshot(username) {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
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

app.post("/api/auth", async (req, res) => {
  if (!IG_TOKENS.length) {
    return res.status(400).json({ success: false, error: "Nenhum token configurado em IG_TOKENS." });
  }

  try {
    const accounts = await fetchIGProfiles(IG_TOKENS);

    if (!accounts.length) {
      return res.status(400).json({ success: false, error: "Nenhuma conta foi carregada com os tokens atuais." });
    }

    req.session.user = { accounts };
    req.session.logged = true;

    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, error: "Erro ao salvar sessão." });
      return res.json({ success: true, accounts });
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/me", (req, res) => {
  const accounts = req.session?.user?.accounts || [];
  const logged = Boolean(req.session?.logged && accounts.length);
  res.json({ logged, accounts });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    render: Boolean(process.env.RENDER),
    base_url: BASE_URL,
    port: PORT,
    has_session: Boolean(req.session?.logged),
    session_id: req.sessionID || null,
    tokens_configured: IG_TOKENS.length,
    groq: Boolean(GROQ_API_KEY),
    gemini: Boolean(GEMINI_API_KEY),
    storage_root: STORAGE_ROOT,
    public_tmp_dir: PUBLIC_TMP_DIR,
    playwright_browsers_path: PLAYWRIGHT_BROWSERS_PATH || "(não definido)"
  });
});

app.get("/api/dashboard/:igId", async (req, res) => {
  const account = getAccountFromSession(req, req.params.igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 30);
  res.json(buildDashboard(media, account));
});

app.post("/api/suggest", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { igId } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 12);

  const prompt = `
${plannerSystemPrompt()}

Faça um auto preenchimento estratégico para esta conta.

Perfil:
- @${account.username}
- Nome: ${account.name || ""}
- Bio: ${account.biography || ""}
- Website: ${account.website || ""}
- Seguidores: ${account.followers_count || 0}

Posts recentes:
${media.map((m, i) => `${i + 1}. ${String(m.caption || "").slice(0, 100)}`).join("\n")}

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
      maxTokens: 1200,
      temperature: 0.4
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/client-memory/:username", (req, res) => {
  try {
    const data = getClientMemory(req.params.username);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/client-memory/:username", (req, res) => {
  try {
    const merged = mergeClientMemory(req.params.username, req.body || {});
    res.json({ success: true, data: merged });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/intelligence", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { igId, niche = "", audience = "", goal = "", tone = "", extra = "", location = "" } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 20);
  const dashboard = buildDashboard(media, account);

  const prompt = `
${plannerSystemPrompt()}

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
      user: prompt,
      maxTokens: 2600,
      temperature: 0.7
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/competitors", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { igId, niche = "", audience = "", competitors = [], location = "", goal = "", tone = "", extra = "" } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const competitorsList = (competitors || []).map(c => String(c || "").trim()).filter(Boolean);

  const prompt = `
${plannerSystemPrompt()}

Faça uma análise estratégica profunda de concorrência.

Perfil analisado:
- @${account.username}
- Nicho: ${niche}
- Público: ${audience}
- Objetivo: ${goal}
- Tom: ${tone}
- Localização: ${location}
- Contexto extra: ${extra}

Concorrentes:
${JSON.stringify(competitorsList, null, 2)}

Regras:
- se faltar evidência pública, explicite isso
- não invente fatos específicos
- mesmo com pouca evidência, entregue leitura estratégica útil
- compare com a lógica do nicho e da cidade

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
      "opportunity_against": "",
      "data_confidence": "",
      "evidence_summary": "",
      "needs_manual_review": false
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
      user: prompt,
      maxTokens: 3200,
      temperature: 0.65
    });

    const enriched = [];
    for (const comp of data.competitors_analysis || []) {
      const uname = String(comp.username || "").replace("@", "").trim();
      const preview = await captureInstagramProfileScreenshot(uname);

      enriched.push({
        ...comp,
        preview_image: preview.success ? preview.imageUrl : "",
        preview_error: preview.success ? "" : preview.error
      });
    }

    data.competitors_analysis = enriched;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

  const prompt = `
${plannerSystemPrompt()}

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
- Total: ${totalPosts}
- Reels: ${reels}
- Carrosséis: ${carousels}
- Estáticos: ${singlePosts}

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

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    doc.fontSize(20).text(`Relatório • @${username}`, { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(JSON.stringify(payload, null, 2));
    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/app", (req, res) => {
  if (!req.session?.logged) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Instagram Planner Agency Render rodando em ${BASE_URL}`);
  console.log(`[INIT] PORT: ${PORT}`);
  console.log(`[INIT] GROQ configurado: ${Boolean(GROQ_API_KEY)}`);
  console.log(`[INIT] GEMINI configurado: ${Boolean(GEMINI_API_KEY)}`);
  console.log(`[INIT] Tokens IG configurados: ${IG_TOKENS.length}`);
  console.log(`[INIT] STORAGE_ROOT: ${STORAGE_ROOT}`);
  console.log(`[INIT] PUBLIC_TMP_DIR: ${PUBLIC_TMP_DIR}`);
  console.log(`[INIT] PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH || "(não definido)"}`);
});
