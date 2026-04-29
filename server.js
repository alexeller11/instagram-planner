require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const session = require("express-session");
const MemoryStore = require("memorystore")(session);
const path = require("path");

const { buildClients } = require("./ai/engine");
const { generateMonthlyWithQuality } = require("./ai/pipeline");
const { updateMemory, avoidRepetition } = require("./ai/memory");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// ===== Static frontend =====
app.use(express.static(path.join(__dirname, "public")));

// ===== Session =====
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

// ===== Mongo =====
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
      audience: { type: String, default: "" },
      tone: { type: String, default: "" },
      memory: { last: { type: [String], default: [] } },

      // histórico (para a aba "Cofre")
      saved_diagnostics: { type: Array, default: [] },
      saved_planners: { type: Array, default: [] },
      single_posts: { type: Array, default: [] },
      swipe_file: { type: Array, default: [] },
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

// ===== IG TOKENS =====
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

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ===== Auth helpers =====
function requireAuth(req, res, next) {
  if (req.session?.logged && Array.isArray(req.session.accounts)) return next();
  return res.status(401).json({ success: false, error: "Não autenticado" });
}

// ===== FB/IG fetch =====
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
      followers_count: ig.followers_count ?? 0,
      biography: ig.biography ?? "",
      media_count: ig.media_count ?? 0,
      is_business: true,
    });
  }
  return accounts;
}

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
      followers_count: 0,
      biography: "",
      media_count: me.media_count ?? 0,
      is_business: false,
    },
  ];
}

// ===== AUTH ROUTES =====
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

    // cria memória pra cada conta
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

// ===== DEBUG STATUS (o painel usa) =====
app.get("/api/debug-status", (req, res) => {
  res.json({
    groq: !!process.env.GROQ_API_KEY,
    gemini: false,
    sambanova: false,
    mongodb: mongoose.connection.readyState === 1,
    fb_throttle_active: false,
  });
});

// ===== DASHBOARD 360 (o painel usa) =====
// Minimal funcional: puxa posts recentes e calcula mix/ER básico
app.get("/api/dashboard/:igId", requireAuth, async (req, res) => {
  try {
    const igId = req.params.igId;
    const acc = (req.session.accounts || []).find((a) => a.id === igId);
    if (!acc) return res.status(404).json({ error: "Conta não encontrada na sessão" });

    // tenta pegar 10 posts recentes via Graph (se token tiver permissão)
    // como temos múltiplos tokens, tentamos todos até funcionar
    let media = [];
    let usedToken = null;

    for (const token of IG_TOKENS) {
      try {
        const r = await axios.get(`https://graph.facebook.com/v21.0/${igId}/media`, {
          params: {
            fields: "id,caption,media_type,like_count,comments_count,timestamp",
            limit: 10,
            access_token: token,
          },
          timeout: 30000,
        });
        media = r.data?.data || [];
        usedToken = token;
        break;
      } catch (_) {}
    }

    // format mix
    const mix = {};
    for (const m of media) {
      mix[m.media_type] = (mix[m.media_type] || 0) + 1;
    }

    // engagement rate proxy
    const followers = acc.followers_count || 1;
    const totalInteractions = media.reduce(
      (sum, p) => sum + (p.like_count || 0) + (p.comments_count || 0),
      0
    );
    const er = media.length ? ((totalInteractions / media.length) / followers) * 100 : 0;

    // top / worst posts by likes
    const sorted = [...media].sort((a, b) => (b.like_count || 0) - (a.like_count || 0));
    const top_posts = sorted.slice(0, 3);
    const worst_posts = sorted.slice(-3).reverse();

    return res.json({
      token_used: !!usedToken,
      metrics: { engagement_rate: Number(er.toFixed(2)) },
      recent_posts: media.map((p) => ({
        like_count: p.like_count || 0,
        comments_count: p.comments_count || 0,
        caption: p.caption || "",
        media_type: p.media_type,
        timestamp: p.timestamp,
      })),
      format_mix: mix,
      top_posts,
      worst_posts,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ===== QUICK VERDICT (o painel usa) =====
// Minimal: retorna texto + métricas estimadas
app.post("/api/quick-verdict", requireAuth, async (req, res) => {
  try {
    const { username, followers, er } = req.body || {};
    const verdict = `
<b>Resumo rápido:</b> Perfil @${username || "-"} com ${Number(followers || 0).toLocaleString("pt-BR")} seguidores.
<br>Taxa de engajamento estimada: <b>${Number(er || 0).toFixed(2)}%</b>.
<br><br><b>Direção:</b> aumentar Reels com histórias reais + carrosséis de prova/autoridade e uma CTA leve por semana.
`.trim();

    res.json({
      verdict,
      health_status: "Estável",
      is_real: false,
      real_metrics: { reach: 0, impressions: 0 },
      demographics: { cities: "Inferindo...", gender: "Inferindo...", time: "07h-09h e 19h-21h" },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== IDENTITY (o painel usa) =====
app.get("/api/identity/:username", requireAuth, async (req, res) => {
  const username = req.params.username;
  const c = await getClient(username, "");
  res.json({
    niche: c.niche || "Não definido",
    tone: c.tone || "Não definido",
    audience: c.audience || "Não definido",
  });
});

// ===== INTELLIGENCE (o painel usa) =====
// Minimal funcional: salva no cofre e retorna estrutura que o front espera
app.post("/api/intelligence", requireAuth, async (req, res) => {
  try {
    const { igId, niche, audience } = req.body || {};
    const acc = (req.session.accounts || []).find((a) => a.id === igId);
    if (!acc) return res.status(404).json({ error: "Conta não encontrada" });

    const client = await getClient(acc.username, niche || "");
    if (audience) client.audience = audience;

    const out = {
      executive_summary:
        "Auditoria gerada. Próximo passo: alinhar nicho, fortalecer prova, e construir calendário com narrativa mensal (atração→conexão→autoridade→conversão).",
      bio_analysis: "Bio atual precisa de promessa + prova + CTA claro.",
      detected_niche: client.niche || niche || "Não definido",
      detected_tone: client.tone || "Profissional",
      weaknesses: [
        "Hooks fracos nas primeiras linhas",
        "Pouca prova social concreta",
        "Formato de conteúdo pouco consistente",
      ],
      bio_suggestions_3D: {
        authority: `✦ ${client.niche || "Especialidade"}\nResultados reais + método\nAgende no Direct`,
        connection: `Aqui a gente fala de ${client.niche || "conteúdo"} sem enrolação\nRotina, bastidores e verdade\nVem comigo 👇`,
        sales: `Quer ${client.niche || "resultado"}?\nAtendimento direto e rápido\nChame no Direct`,
      },
      pillars: ["Dor real do público", "Bastidores e prova", "Educação aplicável", "Oferta leve"],
    };

    client.saved_diagnostics.unshift({ date: new Date(), data: out });
    client.saved_diagnostics = client.saved_diagnostics.slice(0, 20);
    await client.save();

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PLANNER (Motor Mensal) - o painel chama via genPlan() =====
// Aqui devolvemos o mesmo “month_plan” gerado no pipeline (com filtro de qualidade)
app.post("/api/generate", requireAuth, async (req, res) => {
  try {
    const { igId, goal, tone, reels, carousels, singlePosts } = req.body || {};
    const acc = (req.session.accounts || []).find((a) => a.id === igId);
    if (!acc) return res.status(404).json({ error: "Conta não encontrada" });

    const client = await getClient(acc.username, "");
    const result = await generateMonthlyWithQuality({
      clients: aiClients,
      niche: client.niche || "negócios locais",
      memory: (client.memory.last || []).join(", "),
      // hints (não obrigatório pro prompt, mas ajuda)
      goal: goal || "Construção de Autoridade e Confiança",
      tone: tone || "Profissional, Sofisticado e Provocativo",
      mix: { reels: Number(reels || 4), carousels: Number(carousels || 4), statics: Number(singlePosts || 2) },
    });

    // salva no cofre
    client.saved_planners.unshift({ date: new Date(), data: result });
    client.saved_planners = client.saved_planners.slice(0, 20);

    // memória de temas (se vier posts achatados)
    // aqui month_plan tem posts dentro; vamos coletar themes:
    const allThemes = [];
    for (const w of result.month_plan || []) {
      for (const p of w.posts || []) {
        if (p?.theme) allThemes.push({ theme: p.theme });
      }
    }
    client.memory = updateMemory(client.memory, allThemes);

    await client.save();

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== HASHTAGS (o painel chama genHashtags) =====
app.post("/api/hashtags", requireAuth, async (req, res) => {
  // Stub funcional (p/ painel não quebrar). Depois refinamos com IA.
  res.json({
    sets: [
      { name: "Set 1", tags: ["#instagram", "#marketing", "#negocios", "#empreendedorismo", "#conteudo"] },
      { name: "Set 2", tags: ["#socialmedia", "#branding", "#reels", "#carrossel", "#vendas"] },
      { name: "Set 3", tags: ["#dicas", "#estrategia", "#criativos", "#ideias", "#alcance"] },
      { name: "Set 4", tags: ["#localbusiness", "#clientes", "#autoridade", "#servico", "#agenda"] },
      { name: "Set 5", tags: ["#conteudodigital", "#growth", "#instagrowth", "#engajamento", "#copywriting"] },
    ],
  });
});

// ===== MEMORY / COFRE (o painel chama loadMemory()) =====
app.get("/api/memory/:username", requireAuth, async (req, res) => {
  try {
    const username = req.params.username;
    const c = await getClient(username, "");
    res.json({
      diagnostics: c.saved_diagnostics || [],
      plans: c.saved_planners || [],
      posts: c.single_posts || [],
      swipe: c.swipe_file || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Logout helper used by UI =====
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.listen(PORT, () => log.info(`🚀 API rodando na porta ${PORT}`));
