require("dotenv").config();
const express = require("express");
const path = require("path");

const { buildClients } = require("./ai/engine");
const { generatePlan30 } = require("./ai/pipeline");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// ===== FRONT =====
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public/app.html")));

// ===== CLIENTES =====
const clients = [
  { id: "1", username: "qualitycar_autocenter", niche: "oficina mecânica automotiva especializada em manutenção, revisão e diagnóstico" },
  { id: "2", username: "luiztintas", niche: "loja de tintas e materiais de pintura" },
  { id: "3", username: "drogamaisfarma", niche: "farmácia e drogaria" },
  { id: "4", username: "naturedobrasil.br", niche: "indústria e venda de açaí" },
  { id: "5", username: "acentuecontabilidade", niche: "contabilidade para empresas" },
  { id: "6", username: "bortotclinicadeolhos", niche: "clínica oftalmológica" },
  { id: "7", username: "limilklaticinios", niche: "laticínios e produção de derivados de leite" }
];

// ===== IA =====
const aiClients = buildClients(process.env);

// ===== API =====

// clientes (sem login)
app.get("/api/me", (req, res) => {
  res.json({
    logged: true,
    accounts: clients
  });
});

// gerar plano
app.post("/api/generate", async (req, res) => {
  try {
    const { igId, goal, tone } = req.body;
    const acc = clients.find(c => c.id === igId) || clients[0];

    const result = await generatePlan30({
      clients: aiClients,
      niche: acc.niche,
      goal: goal || "Crescimento",
      tone: tone || "Profissional"
    });

    res.json(result);
  } catch (e) {
    console.error("ERRO:", e.message);
    res.json({ posts: [] });
  }
});

app.listen(PORT, () => {
  console.log("🚀 SERVER RODANDO:", PORT);
});
