require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const session = require("express-session");
const MemoryStore = require("memorystore")(session);
const path = require("path");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");
const { updateMemory, avoidRepetition } = require("./ai/memory");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// ========= Static (Front antigo) =========
app.use(express.static(path.join(__dirname, "public")));

// ========= Session =========
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
      secure: IS_PROD,
      sameSite: IS_PROD ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

const log = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

// ========= Mongo =========
mongoose
  .connect((process.env.MONGODB_URI || "").trim())
  .then(() => log.info("✅ Mongo conectado"))
  .catch((err) => log.error("❌ Mongo erro:", err.message));

const Client = mongoose.model(
  "Client",
  new mongoose.Schema(
    {
      username: { type: String, index: true },
      niche: { type: String, default: "" },
      memory: { last: { type: [String], default: [] } },
    },
    { timestamps: true }
  )
);

async function getClient(username, niche) {
  let c = await Client.findOne({ username });
  if (!c) {
    c = new Client({ username, niche: niche || "", memory: { last: [] } });
    await c.save();
  }
  if (niche && c.niche !== niche) {
    c.niche = niche;
    await c.save();
  }
  return c;
}

// ========= IG Tokens =========
const IG_TOKENS = (process.env.IG_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// ========= AI Clients =========
const aiClients = buildClients(process.env);

// ========= Front routes =========
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public/app.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public/privacy.html")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ========= Auth helpers =========
function requireAuth(req, res, next) {
  if (req.session?.logged && Array.isArray(req.session.accounts)) return next();
  return res.status(401).json({ success: false, error: "Não autenticado" });
}

// tenta contas business (páginas)
async function fetchBusinessAccounts(token) {
  const r = await axios.get("https://graph.facebook.com/v21.0/me/accounts", {
    params: {
      fields: "instagram_business_account{id,username,name,followers_count,biography,media_count}",
      access_token: token,
    },
    timeout: 30000,
  });

  const pages = r.data?.data || [];
  const accounts = [];
  for (const p of pages) {
    const ig = p.instagram_business_account;
    if (!ig?.id) continue;
    accounts.push({
      id: ig.id,
      username: ig.username,
      name: ig.name || ig.username,
      followers_count: ig.followers_count ?? null,
      biography: ig.biography ?? "",
      media_count: ig.media_count ?? null,
      is_business: true,
    });
  }
  return accounts;
}

// fallback: basic instagram graph (nem sempre funciona)
async function fetchBasicAccount(token) {
  const r = await axios.get("https://graph.instagram.com/me", {
    params: { fields: "id,username,account_type,media_count", access_token: token },
    timeout: 30000,
  });
  const me = r.data;
  if (!me?.id) return [];
  return [
    {
      id: me.id,
      username: me.username,
      name: me.username,
      followers_count: null,
      biography: "",
      media_count: me.media_count ?? null,
      is_business: false,
    },
  ];
}

// ========= Auth routes =========
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
      } catch (_) {}

      try {
        const basic = await fetchBasicAccount(token);
        all.push(...basic);
      } catch (_) {}
    }

    const uniq = [];
    const seen = new Set();
    for (const a of all) {
      if (!a?.id) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      uniq.push(a);
    }

    req.session.logged = true;
    req.session.accounts = uniq;

    for (const acc of uniq) {
      if (acc?.username) await getClient(acc.username, "");
    }

    return res.json({ success: true, accounts: uniq });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/me", (req, res) => {
  return res.json({
    logged: !!req.session?.logged,
    accounts: req.session?.accounts || [],
  });
});

app.get("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ========= Generation (mantém tudo que construímos) =========
app.get("/api/generate", requireAuth, async (req, res) => {
  try {
    const username = (req.query.username || "").trim();
    const niche = (req.query.niche || "").trim();

    const fallbackAcc = req.session.accounts?.[0];
    const effectiveUsername = username || fallbackAcc?.username || "teste";
    const effectiveNiche = niche || "negócios locais";

    log.info("🔍 Cliente:", effectiveUsername, "| Nicho:", effectiveNiche);

    const client = await getClient(effectiveUsername, effectiveNiche);

    const result = await generate({
      clients: aiClients,
      niche: client.niche,
      memory: (client.memory.last || []).join(", "),
    });

    let type = "unknown";
    let data = [];

    if (Array.isArray(result?.month_plan)) {
      type = "monthly_calendar";
      data = result.month_plan;
    } else if (Array.isArray(result?.calendar)) {
      type = "weekly_calendar";
      data = result.calendar;
    } else if (Array.isArray(result?.posts)) {
      type = "posts";
      data = result.posts;
    }

    if (!data.length) {
      return res.json({
        type: "fallback",
        data: [
          { theme: "Conteúdo em ajuste", caption: "Estamos refinando sua estratégia.", format: "estatico" },
        ],
      });
    }

    // atualiza memória só se vier lista simples de posts
    if (type === "posts") {
      const cleaned = avoidRepetition(data, client.memory);
      client.memory = updateMemory(client.memory, cleaned);
      await client.save();
      return res.json({ type, data: cleaned });
    }

    return res.json({ type, data });
  } catch (err) {
    log.error("❌ erro:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => log.info(`🚀 API rodando na porta ${PORT}`));
