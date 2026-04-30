require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
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

// Rota principal
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));

const CLIENTS_FILE = path.join(__dirname, "data", "clients", "clients.json");
const METRICS_FILE = path.join(__dirname, "data", "clients", "metrics", "metrics.json");

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return fallback;
  }
}

/**
 * Busca dados reais do Instagram Graph API se houver tokens no ENV
 */
async function fetchInstagramData(token) {
  try {
    const me = await axios.get(`https://graph.facebook.com/v17.0/me?fields=id,username,name,biography,profile_picture_url,followers_count,media_count&access_token=${token}`);
    const accountId = me.data.id;
    
    // Busca métricas básicas (exemplo simplificado)
    const insights = await axios.get(`https://graph.facebook.com/v17.0/${accountId}/insights?metric=impressions,reach,profile_views&period=day&access_token=${token}`);
    
    return {
      id: accountId,
      username: me.data.username,
      brandName: me.data.name || me.data.username,
      biography: me.data.biography,
      followers: me.data.followers_count,
      ig_token: token,
      realData: true,
      metrics: insights.data.data
    };
  } catch (e) {
    console.error("Erro ao buscar dados do Instagram:", e.message);
    return null;
  }
}

async function getAccounts() {
  const staticClients = readJson(CLIENTS_FILE, []);
  const tokens = (process.env.IG_TOKENS || "").split(",").filter(Boolean);
  
  const dynamicClients = [];
  for (const token of tokens) {
    const data = await fetchInstagramData(token.trim());
    if (data) dynamicClients.push(data);
  }
  
  // Mescla clientes estáticos com dinâmicos (priorizando dinâmicos pelo username)
  const all = [...dynamicClients];
  staticClients.forEach(sc => {
    if (!all.find(a => a.username === sc.username)) {
      all.push(sc);
    }
  });
  
  return all;
}

async function getAccount(id) {
  const accounts = await getAccounts();
  return accounts.find((a) => a.id === String(id)) || accounts[0] || null;
}

function buildMetrics(username, startDate, endDate) {
  const store = readJson(METRICS_FILE, {}) || {};
  const rows = Array.isArray(store[username]) ? store[username] : [];
  
  // Se não houver dados no JSON, retornamos um esqueleto para não quebrar a UI
  const summary = {
    alcance: rows.reduce((acc, r) => acc + (r.alcance || 0), 0) || "12.4K",
    impressoes: rows.reduce((acc, r) => acc + (r.impressoes || 0), 0) || "45.2K",
    engajamentos: rows.reduce((acc, r) => acc + (r.engajamentos || 0), 0) || "1.8K",
    seguidores_ganhos: rows.reduce((acc, r) => acc + (r.seguidores_ganhos || 0), 0) || 124,
    posts_publicados: rows.length || 12,
    taxa_engajamento_media: (rows.reduce((acc, r) => acc + (r.taxa_engajamento || 0), 0) / (rows.length || 1)).toFixed(2) || "4.85"
  };

  return {
    summary,
    top_contents: rows.sort((a, b) => (b.engajamentos || 0) - (a.engajamentos || 0)).slice(0, 5)
  };
}

const aiClients = buildClients(process.env);

app.get("/api/me", async (_, res) => {
  const accounts = await getAccounts();
  res.json({ logged: true, accounts });
});

app.post("/api/dashboard", async (req, res) => {
  try {
    const clientData = await getAccount(req.body?.igId);
    if (!clientData) return res.status(404).json({ error: "Cliente não encontrado" });

    const analysis = await analisarCliente({ clients: aiClients, ...clientData });
    const profile = await dashboard360({ clients: aiClients, clientData, analysis });
    const metrics = buildMetrics(clientData.username);

    res.json({ analysis, profile, metrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/plano", async (req, res) => {
  try {
    const clientData = await getAccount(req.body?.igId);
    if (!clientData) return res.status(404).json({ error: "Cliente não encontrado" });

    const analysis = await analisarCliente({ clients: aiClients, ...clientData });
    const data = await planoMensal({
      clients: aiClients,
      clientData,
      analysis,
      goal: req.body?.goal || "Performance e Conversão",
      qtyReels: Number(req.body?.qtyReels || 8),
      qtyCarrossel: Number(req.body?.qtyCarrossel || 6),
      qtyFoto: Number(req.body?.qtyFoto || 2)
    });

    res.json({ analysis, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/diagnostico", async (req, res) => {
  try {
    const clientData = await getAccount(req.body?.igId);
    const analysis = await analisarCliente({ clients: aiClients, ...clientData });
    const data = await diagnostico({ clients: aiClients, clientData, analysis, objective: "Performance" });
    res.json({ analysis, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/concorrencia", async (req, res) => {
  try {
    const clientData = await getAccount(req.body?.igId);
    const analysis = await analisarCliente({ clients: aiClients, ...clientData });
    const data = await concorrencia({ clients: aiClients, clientData, analysis });
    res.json({ analysis, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("🚀 Agência Pro rodando na porta", PORT));
