require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MemoryStore = require("memorystore")(session);
const mongoose = require("mongoose");
const axios = require("axios");
const path = require("path");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");
const { updateMemory, avoidRepetition } = require("./ai/memory");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// =======================
// STATIC FRONT
// =======================
app.use(express.static(path.join(__dirname, "public")));

// =======================
// SESSION
// =======================
app.set("trust proxy", 1);
app.use(
  session({
    name: "planner.sid",
    secret: (process.env.SESSION_SECRET || "change-me").trim(),
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

// =======================
// LOG
// =======================
const log = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

// =======================
// DB
// =======================
mongoose
  .connect((process.env.MONGODB_URI || "").trim())
  .then(() => log.info("✅ Mongo conectado"))
  .catch((err) => log.error("❌ Mongo erro:", err.message));

const Client = mongoose.model(
  "Client",
  new mongoose.Schema(
    {
      username: String,
      niche: String,
      memory: { last: [String] },
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

// =======================
// IG TOKENS
// =======================
const IG_TOKENS = (process.env.IG_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// =======================
// IA CLIENTS
// =======================
const aiClients = buildClients(process.env);

// =======================
// FRONT ROUTES
// =======================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public/app.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public/privacy.html")));

// =======================
// HEALTH
// =======================
app.get("/health", (req, res) => res.json({ status: "ok" }));

// =======================
// AUTH HELPERS
// =======================
function requireAuth(req, res, next) {
  if (req.session?.logged && Array.isArray(req.session.accounts)) return next();
  return res.status(401).json({ success: false, error: "Não autenticado" });
}

async function tryFetchBusinessAccounts(token) {
  // Busca páginas do Facebook e tenta pegar instagram_business_account
  const url = "https://graph.facebook.com/v21.0/me/accounts";
  const r = await axios.get(url, {
    params: {
      fields: "instagram_business_account{id,username,name,followers_count,biography,media_count}",
      access_token: token,
    },
    timeout: 30000,
  });

  const pages = r.data?.data || [];
  const accounts = [];
  for (const p of pages) {
    if (p.instagram_business_account) {
      const ig = p.instagram_business_account;
      accounts.push({
        id: ig.id,
        username: ig.username,
        name: ig.name || ig.username,
        followers_count: ig.followers_count,
        biography: ig.biography,
        media_count: ig.media_count,
        is_business: true,
      });
    }
  }
  return accounts;
}

async function tryFetchBasicInstagram(token) {
  // Fallback: tenta pegar "me" pelo Graph Instagram (nem sempre funciona dependendo do token)
  const url = "https://graph.instagram.com/me";
  const r = await axios.get(url, {
    params: {
      fields: "id,username,account_type,media_count",
      access_token: token,
    },
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
      media_count: me.media_count,
      is_business: false,
    },
  ];
}

// =======================
// AUTH ROUTES (para o front puxar clientes)
// =======================
app.post("/api/auth", async (req, res) => {
  try {
    if (!IG_TOKENS.length) {
      return res.status(400).json({
        success: false,
        error: "IG_TOKENS não configurado no Render",
      });
    }

    const all = [];
    for (const token of IG_TOKENS) {
      try {
        const biz = await tryFetchBusinessAccounts(token);
        all.push(...biz);
      } catch (e) {
        // ignora e tenta o fallback
        try {
          const basic = await tryFetchBasicInstagram(token);
          all.push(...basic);
        } catch (_) {}
      }
    }

    // remove duplicados por id
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

    // cria memória no mongo
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

// =======================
// CONTENT GENERATION (monthly intelligent + filter lives in pipeline)
// =======================
app.get("/api/generate", requireAuth, async (req, res) => {
  try {
    const username = (req.query.username || "").trim();
    const niche = (req.query.niche || "").trim();

    // Se o front não passar username, usa o primeiro da sessão
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

    // Suporta posts, weekly calendar, monthly calendar
    let output = [];
    let type = "unknown";

    if (Array.isArray(result?.month_plan)) {
      output = result.month_plan;
      type = "monthly_calendar";
    } else if (Array.isArray(result?.calendar)) {
      output = result.calendar;
      type = "weekly_calendar";
    } else if (Array.isArray(result?.posts)) {
      output = result.posts;
      type = "posts";
    }

    if (!output.length) {
      return res.json({
        type: "fallback",
        data: [
          {
            theme: "Conteúdo em ajuste",
            caption: "Estamos refinando sua estratégia.",
            format: "estatico",
          },
        ],
      });
    }

    // Memória (apenas quando forem posts simples)
    if (type === "posts") {
      const cleaned = avoidRepetition(output, client.memory);
      client.memory = updateMemory(client.memory, cleaned);
      await client.save();
      return res.json({ type, data: cleaned });
    }

    return res.json({ type, data: output });
  } catch (err) {
    log.error("❌ erro:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  log.info(`🚀 API rodando na porta ${PORT}`);
});
