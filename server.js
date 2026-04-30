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

// ===== FRONT =====
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/app.html"));
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public/app.html"));
});

// ===== CLIENTES FIXOS (POC) =====
const accounts = [
  { id: "1", username: "qualitycar_autocenter", niche: "oficina mecânica" },
  { id: "2", username: "bortotclinicadeolhos", niche: "clínica oftalmológica" }
];

const aiClients = buildClients(process.env);

function getAccount(id) {
  return accounts.find(a => a.id === String(id)) || accounts[0];
}

// ===== API BÁSICA EXISTENTE =====
app.get("/api/me", (req, res) => {
  res.json({ logged: true, accounts });
});

app.post("/api/dashboard", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
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

// ===== NOVOS ENDPOINTS PARA O DASHBOARD HTML =====

// Teste de token manual (stub, ainda sem integração real com Meta)
app.post("/api/test-token", (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.json({ success: false, error: "Token não enviado" });
  }

  // Aqui você pode plugar uma validação real na API da Meta
  // Por enquanto, só retorna as contas fixas
  return res.json({
    success: true,
    accounts
  });
});

// Inteligência: sugestões + BIOs (usando diagnostico como base)
app.post("/api/suggestions", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
    const data = await diagnostico({
      clients: aiClients,
      niche: acc.niche
    });

    // Ajuste conforme o formato real retornado por diagnostico()
    const suggestions = data.suggestions || data.oportunidades || [];
    const bioOptions = data.bio_options || data.bio || [];

    res.json({
      suggestions,
      bio_options: bioOptions
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: e.message, suggestions: [], bio_options: [] });
  }
});

// Geração do plano de 30 dias no formato esperado pelo front novo
app.post("/api/generate", async (req, res) => {
  try {
    const acc = getAccount(req.body?.igId);
    const data = await planoMensal({
      clients: aiClients,
      niche: acc.niche,
      username: acc.username,
      goal: req.body?.goal || "Autoridade"
    });

    // Normaliza para [{ n, title, format, copy }]
    const postsRaw = data.posts || [];
    const posts = postsRaw.map((p, idx) => ({
      n: p.day || idx + 1,
      title: p.theme || p.title || `Post ${idx + 1}`,
      format: p.format || "Reels",
      copy: p.copy || p.caption || ""
    }));

    res.json({ posts });
  } catch (e) {
    res.status(500).json({ error: e.message, posts: [] });
  }
});

// ===== LISTEN =====
app.listen(PORT, () => {
  console.log("🚀 SERVER RODANDO:", PORT);
});
