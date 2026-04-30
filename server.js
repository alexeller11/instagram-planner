require("dotenv").config();
const express = require("express");
const path = require("path");

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

// ================= FRONT =================
app.use(express.static(path.join(__dirname, "public")));

// 🔥 ENTRA DIRETO NO APP (SEM LOGIN)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/app.html"));
});

// mantém rota /app também
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public/app.html"));
});

// ================= CLIENTES =================
const accounts = [
  {
    id: "1",
    username: "qualitycar_autocenter",
    niche: "oficina mecânica automotiva especializada em manutenção, revisão e diagnóstico"
  },
  {
    id: "2",
    username: "luiztintas",
    niche: "loja de tintas e materiais de pintura"
  },
  {
    id: "3",
    username: "drogamaisfarma",
    niche: "farmácia e drogaria"
  },
  {
    id: "4",
    username: "naturedobrasil.br",
    niche: "indústria e venda de açaí"
  },
  {
    id: "5",
    username: "acentuecontabilidade",
    niche: "contabilidade para empresas"
  },
  {
    id: "6",
    username: "bortotclinicadeolhos",
    niche: "clínica oftalmológica"
  },
  {
    id: "7",
    username: "limilklaticinios",
    niche: "laticínios e produção de derivados de leite"
  }
];

// ================= IA =================
const aiClients = buildClients(process.env);

// helper
function getAccount(id) {
  return accounts.find(a => a.id === String(id)) || accounts[0];
}

// ================= API =================

// retorna contas (sem login)
app.get("/api/me", (req, res) => {
  res.json({
    logged: true,
    accounts
  });
});

// DASHBOARD
app.post("/api/dashboard", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);

    const data = await dashboard360({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username
    });

    res.json(data);
  } catch (err) {
    console.error("dashboard error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DIAGNÓSTICO
app.post("/api/diagnostico", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);

    const data = await diagnostico({
      clients: aiClients,
      niche: acc.niche
    });

    res.json(data);
  } catch (err) {
    console.error("diagnostico error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PLANO
app.post("/api/plano", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);

    const data = await planoMensal({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username,
      goal: req.body?.goal || "Autoridade"
    });

    res.json(data);
  } catch (err) {
    console.error("plano error:", err.message);
    res.status(500).json({
      error: err.message,
      posts: []
    });
  }
});

// CONCORRÊNCIA
app.post("/api/concorrencia", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);

    const data = await concorrencia({
      clients: aiClients,
      niche: acc.niche,
      city: req.body?.city || "Brasil"
    });

    res.json(data);
  } catch (err) {
    console.error("concorrencia error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log("🚀 SERVER RODANDO NA PORTA:", PORT);
});
