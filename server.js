require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { buildClients } = require("./ai/engine");
const { dashboard360, diagnostico, planoMensal, concorrencia } = require("./ai/pipeline");

const app = express();
app.use(express.json({ limit: "10mb" }));
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/app.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public/app.html")));

const CLIENTS_FILE = path.join(__dirname, "data", "clients", "clients.json");

function loadAccounts() {
  try {
    const raw = fs.readFileSync(CLIENTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("Erro ao carregar clients.json:", e.message);
    return [];
  }
}

function getAccounts() {
  return loadAccounts();
}

function getAccount(id) {
  const accounts = getAccounts();
  return accounts.find(a => a.id === String(id)) || accounts[0] || null;
}

const aiClients = buildClients(process.env);

app.get("/api/me", (req, res) => {
  const accounts = getAccounts();
  res.json({ logged: true, accounts });
});

app.post("/api/dashboard", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
    if (!acc) return res.status(404).json({ error: "Nenhum cliente cadastrado" });

    const data = await dashboard360({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username
    });

    res.json(data);
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
      niche: acc.niche
    });

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
      goal: req.body?.goal || "Autoridade"
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
      city: req.body?.city || "Brasil"
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("🚀 SERVER RODANDO:", PORT);
});
