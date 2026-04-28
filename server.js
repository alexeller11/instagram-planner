require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generateWithPipeline } = require("./ai/pipeline");
const { filterRepetitions, updateMemory } = require("./ai/memory");
const { getInstagramInsights, extractPatterns } = require("./ai/insights");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ================= DB =================
mongoose.connect(process.env.MONGODB_URI || "");

const Client = mongoose.model("Client", new mongoose.Schema({
  username: String,
  niche: String,
  audience: String,
  content_memory: {
    last_themes: [String]
  }
}));

async function getClient(username) {
  let c = await Client.findOne({ username });
  if (!c) {
    c = new Client({ username, content_memory: { last_themes: [] } });
    await c.save();
  }
  return c;
}

// ================= IA =================
const clients = buildClients(process.env);

const SYSTEM = `
Você é estrategista nível elite.

CRIE CONTEÚDO QUE:
- prende atenção
- foge do óbvio
- gera curiosidade

PROIBIDO:
- conteúdo genérico
- repetir ideias
`;

// ================= ROUTE =================
app.post("/api/generate", async (req, res) => {
  try {
    const { username, reels = 0, carousels = 0, singlePosts = 0 } = req.body;

    const client = await getClient(username);

    // 🔥 coleta dados reais
    const insights = await getInstagramInsights(username);
    const patterns = extractPatterns(insights);

    const memory = client.content_memory.last_themes.join(", ");

    const total = reels + carousels + singlePosts;

    const prompt = `
Crie ${total} posts totalmente diferentes.

Formato livre.

Cada post deve ter:
- theme
- caption
- formato (reels/carrossel/estatico)
`;

    const result = await generateWithPipeline({
      clients,
      system: SYSTEM,
      prompt,
      memory,
      patterns
    });

    let posts = result.posts || [];

    posts = filterRepetitions(posts, client.content_memory);

    client.content_memory = updateMemory(client.content_memory, posts);
    await client.save();

    res.json({ posts });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("🚀 GOD MODE rodando:", PORT);
});
