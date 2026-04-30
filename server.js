require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { buildClients } = require("./ai/engine");
const {
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
} = require("./ai/pipeline");

const app = express();
app.use(express.json({ limit: "10mb" }));
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public/app.html")));
app.get("/app", (_, res) => res.sendFile(path.join(__dirname, "public/app.html")));

const CLIENTS_FILE = path.join(__dirname, "data", "clients", "clients.json");
const METRICS_FILE = path.join(__dirname, "data", "metrics", "metrics.json");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
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
    range: {
      startDate: startDate || null,
      endDate: endDate || null,
      totalDays: filtered.length
    },
    summary: {
      alcance: sum(filtered, "alcance"),
      impressoes: sum(filtered, "impressoes"),
      engajamentos: sum(filtered, "engajamentos"),
      seguidores_ganhos: sum(filtered, "seguidores_ganhos"),
      posts_publicados: sum(filtered, "posts_publicados"),
      taxa_engajamento_media: avg(filtered, "taxa_engajamento")
    },
    top_contents: [...filtered]
      .sort((a, b) => Number(b.engajamentos || 0) - Number(a.engajamentos || 0))
      .slice(0, 5)
  };
}

const aiClients = buildClients(process.env);

app.get("/api/me", (_, res) => {
  res.json({ logged: true, accounts: getAccounts() });
});

app.post("/api/dashboard", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
    if (!acc) return res.status(404).json({ error: "Nenhum cliente cadastrado" });

    const profile = await dashboard360({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username
    });

    const metrics = buildMetrics(acc.username, req.body?.startDate, req.body?.endDate);

    res.json({ profile, metrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/diagnostico", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
    if (!acc) return res.status(404).json({ error: "Nenhum cliente cadastrado" });

    const data = await diagnostico({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username,
      objective: req.body?.objective || "tomada de decisão e clareza de conteúdo"
    });

    if (!data?.problemas?.length) {
      return res.status(422).json({ error: "Diagnóstico retornou vazio" });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/plano", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
    if (!acc) return res.status(404).json({ error: "Nenhum cliente cadastrado", posts: [] });

    const data = await planoMensal({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username,
      goal: req.body?.goal || "Autoridade",
      secondaryGoals: Array.isArray(req.body?.secondaryGoals) ? req.body.secondaryGoals : [],
      qtyReels: Number(req.body?.qtyReels || 8),
      qtyCarrossel: Number(req.body?.qtyCarrossel || 6),
      qtyFoto: Number(req.body?.qtyFoto || 2),
      city: req.body?.city || "Linhares",
      tone: req.body?.tone || "humano, direto, especialista e sem clichê"
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, posts: [] });
  }
});

app.post("/api/concorrencia", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
    if (!acc) return res.status(404).json({ error: "Nenhum cliente cadastrado" });

    const data = await concorrencia({
      clients: aiClients,
      niche: acc.niche,
      city: req.body?.city || "Linhares"
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("🚀 Server rodando na porta", PORT));
