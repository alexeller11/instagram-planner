require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");

const app = express();
app.use(express.json());

// 🔥 SERVIR ARQUIVOS FRONT
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ================= DB =================
mongoose.connect(process.env.MONGODB_URI || "")
  .then(() => console.log("✅ Mongo conectado"))
  .catch(err => console.log("❌ Mongo erro:", err.message));

// ================= IA =================
const clients = buildClients(process.env);

// ================= ROTAS FRONT =================

// LOGIN
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// APP PRINCIPAL
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public/app.html"));
});

// DASHBOARD (backup)
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public/dashboard.html"));
});

// PRIVACY
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public/privacy.html"));
});

// ================= API =================

// FAKE AUTH (pra não travar seu login)
app.post("/api/auth", (req, res) => {
  res.json({ success: true });
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// GERAÇÃO
app.get("/api/generate", async (req, res) => {
  try {
    const username = req.query.username || "teste";
    const niche = req.query.niche || "negócios";

    console.log("🔍 Gerando para:", username, niche);

    const result = await generate({
      clients,
      niche,
      memory: ""
    });

    return res.json(result);

  } catch (err) {
    console.log("❌ erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
});
