require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");
const { updateMemory, avoidRepetition } = require("./ai/memory");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== DB =====
mongoose.connect(process.env.MONGODB_URI || "");

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
Você é um estrategista de conteúdo premium.

Crie conteúdo:
- não genérico
- variado
- interessante
`;

// ===== ROTAS =====
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/generate", async (req, res) => {
  try {
    const username = req.query.username || "teste";

    const client = await getClient(username);

    const prompt = `
Crie 5 posts para Instagram.

Cada post:
- theme
- caption
- format
`;

    const result = await generate({
      clients,
      system: SYSTEM,
      prompt,
      memory: client.memory.last.join(", ")
    });

    let posts = result.posts || [];

    posts = avoidRepetition(posts, client.memory);

    client.memory = updateMemory(client.memory, posts);
    await client.save();

    res.json({ posts });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("🚀 API rodando:", PORT);
});
