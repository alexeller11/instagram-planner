require("dotenv").config();
const express = require("express");
const path = require("path");

const { buildClients } = require("./ai/engine");
const { dashboard360, diagnostico, planoMensal, concorrencia } = require("./ai/pipeline");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public/app.html")));

// contas fixas (como está hoje no seu repo) :contentReference[oaicite:3]{index=3}
const accounts = [
  { id: "1", username: "qualitycar_autocenter", niche: "oficina mecânica automotiva especializada em manutenção, revisão e diagnóstico" },
  { id: "2", username: "luiztintas", niche: "loja de tintas e materiais de pintura" },
  { id: "3", username: "drogamaisfarma", niche: "farmácia e drogaria" },
  { id: "4", username: "naturedobrasil.br", niche: "indústria e venda de açaí" },
  { id: "5", username: "acentuecontabilidade", niche: "contabilidade para empresas" },
  { id: "6", username: "bortotclinicadeolhos", niche: "clínica oftalmológica" },
  { id: "7", username: "limilklaticinios", niche: "laticínios e produção de derivados de leite" }
];

const aiClients = buildClients(process.env);

app.get("/api/me", (req, res) => {
  res.json({ logged: true, accounts });
});

function getAcc(igId) {
  return accounts.find(a => a.id === String(igId)) || accounts[0];
}

app.post("/api/dashboard", async (req, res) => {
  try {
    const acc = getAcc(req.body?.igId);
    const data = await dashboard360({ clients: aiClients, niche: acc.niche, username: acc.username });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/diagnostico", async (req, res) => {
  try {
    const acc = getAcc(req.body?.igId);
    const data = await diagnostico({ clients: aiClients, niche: acc.niche, username: acc.username });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/plano", async (req, res) => {
  try {
    const acc = getAcc(req.body?.igId);
    const goal = req.body?.goal || "Autoridade";
    const mix = req.body?.mix || { reels: 14, carrosseis: 10, estaticos: 6 };
    const data = await planoMensal({ clients: aiClients, niche: acc.niche, username: acc.username, goal, mix });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, posts: [] });
  }
});

app.post("/api/concorrencia", async (req, res) => {
  try {
    const acc = getAcc(req.body?.igId);
    const city = req.body?.city || "Linhares";
    const data = await concorrencia({ clients: aiClients, niche: acc.niche, city });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("🚀 SERVER RODANDO:", PORT));
