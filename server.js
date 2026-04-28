require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");
const { updateMemory, avoidRepetition } = require("./ai/memory");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== LOG =====
const log = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

// ===== DB =====
mongoose.connect(process.env.MONGODB_URI || "")
  .then(() => log.info("✅ Mongo conectado"))
  .catch(err => log.error("❌ Mongo erro:", err.message));

const Client = mongoose.model("Client", new mongoose.Schema({
  username: String,
  memory: { last: [String] }
}));

async function getClient(username) {
  let c = await Client.findOne({ username });
  if (!c) {
    c = new Client({ username, memory: { last: [] } });
    await c.save();
  }
  return c;
}

// ===== IA =====
const clients = buildClients(process.env);

const SYSTEM = `
Você é estrategista de conteúdo premium.

PROIBIDO:
- conteúdo genérico
- repetir ideias

OBRIGATÓRIO:
- curiosidade
- impacto
- storytelling
`;

// ===== ROUTE =====
app.post("/api/generate", async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: "username obrigatório" });
    }

    const client = await getClient(username);

    // 🔥 PROMPT SIMPLES (sem scraping quebrado)
    const prompt = `
Crie 6 posts para Instagram.

Cada post:
- theme
- caption
- format (reels/carrossel/estatico)

Todos diferentes.
`;

    let result;

    try {
      result = await generate({
        clients,
        system: SYSTEM,
        prompt,
        patterns: "",
        memory: client.memory.last.join(", ")
      });
    } catch (err) {
      log.error("❌ IA erro:", err.message);
      return res.status(500).json({ error: "Erro na IA" });
    }

    let posts = Array.isArray(result?.posts) ? result.posts : [];

    // fallback
    if (!posts.length) {
      log.error("⚠️ IA retornou vazio");
      return res.json({ posts: [] });
    }

    // remove repetição
    posts = avoidRepetition(posts, client.memory);

    // salva memória
    client.memory = updateMemory(client.memory, posts);
    await client.save();

    res.json({ posts });

  } catch (err) {
    log.error("❌ erro geral:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== HEALTH =====
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ===== START =====
app.listen(PORT, () => {
  log.info(`🚀 Server rodando na porta ${PORT}`);
});
