require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const session = require("express-session");
const MemoryStore = require("memorystore")(session);
const path = require("path");

const { buildClients } = require("./ai/engine");
const { generateSuggestions, generatePlan30 } = require("./ai/pipeline");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// ===== Static frontend =====
app.use(express.static(path.join(__dirname, "public")));

// ===== Session (Render/HTTPS) =====
app.set("trust proxy", 1);
app.use(
  session({
    name: "planner.sid",
    secret: (process.env.SESSION_SECRET || "change-me-now").trim(),
    resave: false,
    saveUninitialized: false,
    store: new MemoryStore({ checkPeriod: 86400000 }),
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

const log = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a)
};

// ===== Mongo =====
mongoose
  .connect((process.env.MONGODB_URI || "").trim())
  .then(() => log.info("✅ Mongo conectado"))
  .catch((err) => log.error("❌ Mongo erro:", err.message));

// ===== Tokens =====
const IG_TOKENS = (process.env.IG_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// ===== AI Clients =====
const aiClients = buildClients(process.env);

// ===== Front routes =====
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public/app.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public/privacy.html")));

app.get("/api/debug-status", (req, res) => {
  res.json({
    groq: !!process.env.GROQ_API_KEY,
    gemini: false,
    sambanova: false,
    mongodb: mongoose.connection.readyState === 1,
    fb_throttle_active: false
  });
});

// ===== Helpers =====
function requireAuth(req, res, next) {
  if (req.session?.logged && Array.isArray(req.session.accounts) && req.session.accounts.length) return next();
  return res.status(401).json({ success: false, error: "Não autenticado" });
}

async function fetchBusinessAccounts(token) {
  // Pega páginas e igIds
  const r = await axios.get("https://graph.facebook.com/v21.0/me/accounts", {
    params: {
      fields: "instagram_business_account{id,username,name}",
      access_token: token
    },
    timeout: 30000
  });

  const pages = r.data?.data || [];
  const igIds = [];
  for (const p of pages) {
    const ig = p.instagram_business_account;
    if (ig?.id) igIds.push(ig.id);
  }

  // Para cada igId, puxa dados corretos
  const accounts = [];
  for (const igId of igIds) {
    try {
      const rr = await axios.get(`https://graph.facebook.com/v21.0/${igId}`, {
        params: {
          fields: "id,username,name,followers_count,biography,media_count",
          access_token: token
        },
        timeout: 30000
      });

      const ig = rr.data;
      accounts.push({
        id: ig.id,
        username: ig.username,
        name: ig.name || ig.username,
        followers_count: ig.followers_count ?? 0,
        biography: ig.biography ?? "",
        media_count: ig.media_count ?? 0
      });
    } catch (_) {
      // se não der, ainda adiciona o mínimo
      accounts.push({
        id: igId,
        username: "",
        name: "",
        followers_count: 0,
        biography: "",
        media_count: 0
      });
    }
  }

  return accounts;
}

async function fetchBasicAccount(token) {
  const r = await axios.get("https://graph.instagram.com/me", {
    params: { fields: "id,username,account_type,media_count", access_token: token },
    timeout: 30000
  });
  const me = r.data;
  if (!me?.id) return [];
  return [{
    id: me.id,
    username: me.username,
    name: me.username,
    followers_count: 0,
    biography: "",
    media_count: me.media_count ?? 0
  }];
}

function mergeAccounts(existing, incoming) {
  const map = new Map();
  for (const a of existing || []) map.set(a.id, a);
  for (const a of incoming || []) {
    const prev = map.get(a.id) || {};
    map.set(a.id, { ...prev, ...a, id: a.id });
  }
  return Array.from(map.values());
}

// ===== AUTH =====
app.post("/api/auth", async (req, res) => {
  try {
    if (!IG_TOKENS.length) {
      return res.status(400).json({ success: false, error: "IG_TOKENS não configurado" });
    }

    const all = [];
    for (const token of IG_TOKENS) {
      try {
        const biz = await fetchBusinessAccounts(token);
        all.push(...biz);
        continue;
      } catch (e) {
        console.log("⚠️ me/accounts falhou:", e.response?.data || e.message);
      }

      try {
        const basic = await fetchBasicAccount(token);
        all.push(...basic);
      } catch (e) {
        console.log("⚠️ graph.instagram.com/me falhou:", e.response?.data || e.message);
      }
    }

    // remove duplicados
    const seen = new Set();
    const uniq = [];
    for (const a of all) {
      if (!a?.id) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      uniq.push(a);
    }

    req.session.logged = true;
    req.session.accounts = uniq;

    req.session.save(() => res.json({ success: true, accounts: uniq }));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/me", (req, res) => {
  res.json({
    logged: !!req.session?.logged,
    accounts: req.session?.accounts || []
  });
});

// conectar token via app
app.post("/api/test-token", async (req, res) => {
  try {
    const token = (req.body?.token || "").trim();
    if (!token) return res.status(400).json({ success: false, error: "Token vazio" });

    let accounts = [];
    try { accounts = await fetchBusinessAccounts(token); } catch (_) {}
    if (!accounts.length) {
      try { accounts = await fetchBasicAccount(token); } catch (_) {}
    }

    if (!accounts.length) {
      return res.status(400).json({ success: false, error: "Token inválido ou sem permissões" });
    }

    req.session.logged = true;
    req.session.accounts = mergeAccounts(req.session.accounts || [], accounts);

    req.session.save(() => res.json({ success: true, accounts }));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Suggestions =====
app.post("/api/suggestions", requireAuth, async (req, res) => {
  try {
    const out = await generateSuggestions({ clients: aiClients, nicheHint: "conteúdo do Instagram" });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Planner =====
app.post("/api/generate", requireAuth, async (req, res) => {
  try {
    const { goal, tone, igId } = req.body || {};
    const acc = (req.session.accounts || []).find(a => a.id === igId) || (req.session.accounts || [])[0];
    const niche = acc?.username ? `Instagram de ${acc.username}` : "negócios locais";

    const out = await generatePlan30({
      clients: aiClients,
      niche,
      goal: goal || "Crescimento",
      tone: tone || "Profissional"
    });

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => log.info(`🚀 Server rodando na porta ${PORT}`));
