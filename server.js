require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");
const { getProfileData, extractPatterns } = require("./ai/insights");
const { decideStrategy } = require("./ai/brain");
const { updateMemory, avoidRepetition } = require("./ai/memory");
const { filter } = require("./ai/quality");

const app = express();
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI || "");

const Client = mongoose.model("Client", new mongoose.Schema({
  username: String,
  memory: {
    last: [String]
  }
}));

async function getClient(username) {
  let c = await Client.findOne({ username });
  if (!c) {
    c = new Client({ username, memory: { last: [] } });
    await c.save();
  }
  return c;
}

const clients = buildClients(process.env);

const SYSTEM = `
Você é um estrategista omnisciente.

Crie conteúdo:
- não óbvio
- não repetido
- altamente engajador
`;

app.post("/api/generate", async (req, res) => {
  try {
    const { username } = req.body;

    const client = await getClient(username);

    const insights = await getProfileData(username);
    const patterns = extractPatterns(insights);

    const strategy = decideStrategy(insights);

    const total =
      strategy.reels +
      strategy.carrossel +
      strategy.estatico;

    const prompt = `
Crie ${total} posts.

Distribuição:
${strategy.reels} reels
${strategy.carrossel} carrossel
${strategy.estatico} estatico

Cada post:
- theme
- caption
- format
`;

    let result = await generate({
      clients,
      system: SYSTEM,
      prompt,
      patterns,
      memory: client.memory.last.join(", ")
    });

    let posts = result.posts || [];

    posts = avoidRepetition(posts, client.memory);
    posts = filter(posts);

    client.memory = updateMemory(client.memory, posts);
    await client.save();

    res.json({
      strategy,
      posts
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(10000, () => {
  console.log("🧠 OMNISCIENT AI ONLINE");
});
