require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");
const { updateMemory, avoidRepetition } = require("./ai/memory");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================= LOG =================
const log = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

// ================= DATABASE =================
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

// ================= IA =================
const clients = buildClients(process.env);

const SYSTEM = `
Você é um estrategista de conteúdo premium.

PROIBIDO:
- conteúdo genérico
- repetir ideias
- falar só de manutenção

OBRIGATÓRIO:
- curiosidade
- storytelling
- exemplos reais
- impacto
`;

// ================= ROUTE =================
app.post("/api/generate", async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: "username obrigatório" });
    }

    const client = await getClient(username);

    const prompt = `
Crie 6 posts para Instagram.

Cada post deve ter:
- theme
- caption
- format (reels, carrossel ou estatico)

Todos diferentes entre si.
`;

    const result = await generate({
      clients,
      system: SYSTEM,
      prompt,
      memory: client.memory.last.join(", ")
    });

    let posts = Array.isArray(result.posts) ? result.posts : [];

    if (!posts.length) {
      return res.json({ posts: [] });
    }

    posts = avoidRepetition(posts, client.memory);

    client.memory = updateMemory(client.memory, posts);
    await client.save();

    res.json({ posts });

  } catch (err) {
    log.error("❌ erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= HEALTH =================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ================= START =================
app.listen(PORT, () => {
  log.info(`🚀 Server rodando na porta ${PORT}`);
});
