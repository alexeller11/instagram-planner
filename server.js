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

function readJson(file, fallback = []) {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw);
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

function getMetricsStore() {
  return readJson(METRICS_FILE, {});
}

function parseDateBRLike(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function filterMetricsByPeriod(items = [], startDate, endDate) {
  const start = startDate ? parseDateBRLike(startDate) : null;
  const end = endDate ? parseDateBRLike(endDate) : null;

  return items.filter((item) => {
    const d = parseDateBRLike(item.date);
    if (!d) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

function sum(items = [], field) {
  return items.reduce((acc, item) => acc + Number(item[field] || 0), 0);
}

function average(items = [], field) {
  if (!items.length) return 0;
  return sum(items, field) / items.length;
}

function buildDashboardMetrics({ account, startDate, endDate }) {
  const store = getMetricsStore();
  const rows = Array.isArray(store?.[account.username]) ? store[account.username] : [];
  const filtered = filterMetricsByPeriod(rows, startDate, endDate);

  if (!filtered.length) {
    return {
      range: { startDate: startDate || null, endDate: endDate || null, totalDays: 0 },
      summary: {
        alcance: 0,
        impressoes: 0,
        engajamentos: 0,
        seguidores_ganhos: 0,
        posts_publicados: 0,
        taxa_engajamento_media: 0
      },
      top_contents: []
    };
  }

  const topContents = [...filtered]
    .sort((a, b) => Number(b.engajamentos || 0) - Number(a.engajamentos || 0))
    .slice(0, 5)
    .map((item) => ({
      date: item.date,
      titulo: item.titulo || "Conteúdo sem título",
      formato: item.formato || "Post",
      alcance: Number(item.alcance || 0),
      impressoes: Number(item.impressoes || 0),
      engajamentos: Number(item.engajamentos || 0),
      taxa_engajamento: Number(item.taxa_engajamento || 0)
    }));

  return {
    range: {
      startDate: startDate || filtered[0]?.date || null,
      endDate: endDate || filtered[filtered.length - 1]?.date || null,
      totalDays: filtered.length
    },
    summary: {
      alcance: sum(filtered, "alcance"),
      impressoes: sum(filtered, "impressoes"),
      engajamentos: sum(filtered, "engajamentos"),
      seguidores_ganhos: sum(filtered, "seguidores_ganhos"),
      posts_publicados: sum(filtered, "posts_publicados"),
      taxa_engajamento_media: Number(average(filtered, "taxa_engajamento").toFixed(2))
    },
    top_contents: topContents
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

    const strategic = await dashboard360({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username
    });

    const metrics = buildDashboardMetrics({
      account: acc,
      startDate: req.body?.startDate,
      endDate: req.body?.endDate
    });

    res.json({
      profile: strategic,
      metrics
    });
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
      positioning: req.body?.positioning || "",
      objective: req.body?.objective || "mais clareza estratégica e conteúdo que gere decisão"
    });

    const isEmpty =
      !Array.isArray(data?.problemas) || !data.problemas.length;

    if (isEmpty) {
      return res.status(422).json({
        error: "Diagnóstico gerado sem conteúdo útil"
      });
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

    const payload = {
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
    };

    const data = await planoMensal(payload);
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

app.listen(PORT, () => {
  console.log("🚀 SERVER RODANDO:", PORT);
});
