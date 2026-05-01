require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { buildClients } = require("./ai/engine");
const {
  analisarCliente,
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
} = require("./ai/pipeline");
const { fetchInstagramAccount } = require("./ai/instagram");
const { getFacebookLoginUrl, getAccessToken, getInstagramAccounts } = require("./ai/auth");

const app = express();
app.use(express.json({ limit: "10mb" }));
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ============ CONFIGURAÇÃO FACEBOOK LOGIN ============
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FACEBOOK_REDIRECT_URI = process.env.FACEBOOK_REDIRECT_URI || `${BASE_URL}/auth/facebook/callback`;

// Store para sessões (em produção, usar Redis ou banco de dados)
const sessions = new Map();

// ============ ROTAS DE AUTENTICAÇÃO ============

app.get("/auth/facebook", (req, res) => {
  const state = Math.random().toString(36).substring(7);
  sessions.set(state, { createdAt: Date.now() });

  const loginUrl = getFacebookLoginUrl(FACEBOOK_APP_ID, FACEBOOK_REDIRECT_URI, state);
  res.redirect(loginUrl);
});

app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?error=${error}`);
  }

  if (!state || !sessions.has(state)) {
    return res.status(400).send("Estado inválido ou expirado");
  }

  sessions.delete(state);

  try {
    // Obter token de acesso
    const accessToken = await getAccessToken(
      code,
      FACEBOOK_APP_ID,
      FACEBOOK_APP_SECRET,
      FACEBOOK_REDIRECT_URI
    );

    // Buscar contas do Instagram
    const accounts = await getInstagramAccounts(accessToken);

    if (accounts.length === 0) {
      return res.redirect("/?error=no_accounts");
    }

    // Criar sessão
    const sessionId = Math.random().toString(36).substring(7);
    sessions.set(sessionId, {
      accessToken,
      accounts,
      createdAt: Date.now()
    });

    // Redirecionar para o app com o sessionId
    res.redirect(`/app?session=${sessionId}`);
  } catch (error) {
    console.error("Erro na autenticação:", error.message);
    res.redirect(`/?error=auth_failed`);
  }
});

app.get("/auth/logout", (req, res) => {
  const { session } = req.query;
  if (session) {
    sessions.delete(session);
  }
  res.redirect("/");
});

// ============ MIDDLEWARE DE AUTENTICAÇÃO ============

function requireAuth(req, res, next) {
  const sessionId = req.query.session || req.headers.authorization?.replace("Bearer ", "");

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  const session = sessions.get(sessionId);

  // Verificar se a sessão não expirou (24 horas)
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    sessions.delete(sessionId);
    return res.status(401).json({ error: "Sessão expirada" });
  }

  req.session = session;
  req.sessionId = sessionId;
  next();
}

// ============ ROTAS DA API ============

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public/dashboard-v2.html")));
app.get("/app", (_, res) => res.sendFile(path.join(__dirname, "public/dashboard-v2.html")));

app.get("/health", (_, res) => res.status(200).json({ status: "ok", timestamp: new Date().toISOString() }));

// Obter contas do usuário logado
app.get("/api/me", requireAuth, (req, res) => {
  const accounts = req.session.accounts.map((acc) => ({
    id: acc.id,
    username: acc.username,
    brandName: acc.brandName || acc.username,
    niche: acc.niche || "",
    city: acc.city || ""
  }));

  res.json({ logged: true, accounts });
});

// ============ FUNÇÕES AUXILIARES ============

const CLIENTS_FILE = path.join(__dirname, "data", "clients", "clients.json");
const METRICS_FILE = path.join(__dirname, "data", "clients", "metrics", "metrics.json");

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`Erro ao ler ${file}:`, e.message);
    return fallback;
  }
}

function getAccount(id, accounts) {
  if (!id) return accounts[0] || null;
  return accounts.find((a) => String(a.id) === String(id) || a.username === String(id)) || accounts[0] || null;
}

function parseDateSafe(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function filterByDate(rows = [], startDate, endDate) {
  const start = startDate ? parseDateSafe(startDate) : null;
  const end = endDate ? parseDateSafe(endDate) : null;
  return rows.filter((row) => {
    const d = parseDateSafe(row.date);
    if (!d) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

function sum(rows = [], key) {
  return rows.reduce((acc, row) => acc + Number(row[key] || 0), 0);
}

function avg(rows = [], key) {
  if (!rows.length) return 0;
  return Number((sum(rows, key) / rows.length).toFixed(2));
}

function buildMetrics(username, startDate, endDate) {
  const store = readJson(METRICS_FILE, {}) || {};
  const rows = Array.isArray(store[username]) ? store[username] : [];
  const filtered = filterByDate(rows, startDate, endDate);

  return {
    range: { startDate: startDate || null, endDate: endDate || null, totalDays: filtered.length },
    summary: {
      alcance: sum(filtered, "alcance"),
      impressoes: sum(filtered, "impressoes"),
      engajamentos: sum(filtered, "engajamentos"),
      seguidores_ganhos: sum(filtered, "seguidores_ganhos"),
      posts_publicados: sum(filtered, "posts_publicados"),
      taxa_engajamento_media: avg(filtered, "taxa_engajamento"),
      demographics: {
        genderAge: {
          "F 18-24": 1200,
          "F 25-34": 1850,
          "M 18-24": 980,
          "M 25-34": 1450,
          "F 35-44": 650,
          "M 35-44": 720
        },
        cities: [
          ["São Paulo", 3200],
          ["Rio de Janeiro", 1800],
          ["Belo Horizonte", 950],
          ["Curitiba", 650]
        ]
      }
    },
    top_contents: [...filtered].sort((a, b) => Number(b.engajamentos || 0) - Number(a.engajamentos || 0)).slice(0, 5)
  };
}

function normalizeClient(acc) {
  return {
    id: acc.id,
    username: acc.username,
    brandName: acc.brandName || acc.username,
    niche: acc.niche || "",
    targetAudience: acc.targetAudience || "",
    audiencePainPoints: Array.isArray(acc.audiencePainPoints) ? acc.audiencePainPoints : [],
    brandTone: acc.brandTone || "",
    offer: acc.offer || "",
    city: acc.city || "",
    contentPillars: Array.isArray(acc.contentPillars) ? acc.contentPillars : []
  };
}

function validateClientData(data) {
  const errors = [];
  if (!data.igId || typeof data.igId !== 'string') errors.push("igId inválido ou ausente");
  if (data.goal && typeof data.goal !== 'string') errors.push("goal deve ser string");
  if (data.qtyReels && (typeof data.qtyReels !== 'number' || data.qtyReels < 0 || data.qtyReels > 20)) errors.push("qtyReels deve estar entre 0 e 20");
  if (data.qtyCarrossel && (typeof data.qtyCarrossel !== 'number' || data.qtyCarrossel < 0 || data.qtyCarrossel > 20)) errors.push("qtyCarrossel deve estar entre 0 e 20");
  if (data.qtyFoto && (typeof data.qtyFoto !== 'number' || data.qtyFoto < 0 || data.qtyFoto > 20)) errors.push("qtyFoto deve estar entre 0 e 20");
  if (errors.length > 0) throw new Error(`Validação falhou: ${errors.join(', ')}`);
}

const aiClients = buildClients(process.env);

// ============ ROTAS DE CONTEÚDO ============

app.post("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const raw = getAccount(req.body?.igId, req.session.accounts);
    if (!raw) return res.status(404).json({ error: "Nenhum cliente cadastrado" });

    const clientData = normalizeClient(raw);
    let analysis = {};
    try {
      analysis = await analisarCliente({ clients: aiClients, ...clientData });
    } catch (e) {
      analysis = { niche_analysis: clientData.niche, audience_summary: clientData.targetAudience };
    }

    const profile = await dashboard360({ clients: aiClients, clientData, analysis });
    const metrics = buildMetrics(clientData.username, req.body?.startDate, req.body?.endDate);
    res.json({ analysis, profile, metrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/diagnostico", requireAuth, async (req, res) => {
  try {
    const raw = getAccount(req.body?.igId, req.session.accounts);
    if (!raw) return res.status(404).json({ error: "Nenhum cliente cadastrado" });

    const clientData = normalizeClient(raw);
    const analysis = await analisarCliente({ clients: aiClients, ...clientData });
    const data = await diagnostico({ clients: aiClients, clientData, analysis, objective: req.body?.objective || "performance" });
    res.json({ analysis, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/plano", requireAuth, async (req, res) => {
  try {
    validateClientData(req.body);
    const raw = getAccount(req.body?.igId, req.session.accounts);
    if (!raw) return res.status(404).json({ error: "Nenhum cliente cadastrado", posts: [] });

    const clientData = normalizeClient(raw);
    let analysis = {};
    try {
      analysis = await analisarCliente({ clients: aiClients, ...clientData });
    } catch (err) {
      analysis = { niche_analysis: clientData.niche, audience_summary: clientData.targetAudience };
    }

    const data = await planoMensal({
      clients: aiClients,
      clientData,
      analysis,
      goal: req.body?.goal || "Autoridade",
      qtyReels: Number(req.body?.qtyReels || 8),
      qtyCarrossel: Number(req.body?.qtyCarrossel || 6),
      qtyFoto: Number(req.body?.qtyFoto || 2)
    });

    if (!data.posts || data.posts.length === 0) {
      return res.status(500).json({ error: "A IA não conseguiu gerar os posts. Verifique as chaves de API.", posts: [] });
    }

    res.json({ analysis, ...data });
  } catch (e) {
    res.status(400).json({ error: e.message, posts: [] });
  }
});

app.post("/api/concorrencia", requireAuth, async (req, res) => {
  try {
    const raw = getAccount(req.body?.igId, req.session.accounts);
    if (!raw) return res.status(404).json({ error: "Nenhum cliente cadastrado" });

    const clientData = normalizeClient(raw);
    const analysis = await analisarCliente({ clients: aiClients, ...clientData });
    const data = await concorrencia({ clients: aiClients, clientData, analysis });
    res.json({ analysis, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("🚀 Server rodando na porta", PORT));
