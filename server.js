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

const app = express();
app.use(express.json({ limit: "10mb" }));
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));
app.get("/app", (_, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));

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

function getAccounts() {
  const data = readJson(CLIENTS_FILE, []);
  return Array.isArray(data) ? data : [];
}

function getAccount(id) {
  const accounts = getAccounts();
  return accounts.find((a) => a.id === String(id)) || accounts[0] || null;
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
      taxa_engajamento_media: avg(filtered, "taxa_engajamento")
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

const aiClients = buildClients(process.env);

app.get("/api/me", (_, res) => {
  const accounts = getAccounts().map((acc) => ({
    id: acc.id,
    username: acc.username,
    brandName: acc.brandName || acc.username,
    niche: acc.niche || "",
    city: acc.city || ""
  }));
  res.json({ logged: true, accounts });
});

app.post("/api/dashboard", async (req, res) => {
  try {
    const raw = getAccount(req.body?.igId);
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

app.post("/api/diagnostico", async (req, res) => {
  try {
    const raw = getAccount(req.body?.igId);
    if (!raw) return res.status(404).json({ error: "Nenhum cliente cadastrado" });
    const clientData = normalizeClient(raw);
    const analysis = await analisarCliente({ clients: aiClients, ...clientData });
    const data = await diagnostico({ clients: aiClients, clientData, analysis, objective: req.body?.objective || "performance" });
    res.json({ analysis, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/plano", async (req, res) => {
  try {
    const raw = getAccount(req.body?.igId);
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
    res.status(500).json({ error: e.message, posts: [] });
  }
});

app.post("/api/concorrencia", async (req, res) => {
  try {
    const raw = getAccount(req.body?.igId);
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
