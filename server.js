require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generateWithPipeline } = require("./ai/pipeline");
const { filterRepetitions, updateMemory } = require("./ai/memory");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

mongoose.connect(process.env.MONGODB_URI);

const Client = mongoose.model("Client", new mongoose.Schema({
  username: String,
  niche: String,
  audience: String,
  content_memory: {
    last_themes: [String]
  },
  performance_memory: {
    top_posts: Array
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

function normalizeFormat(f) {
  f = String(f || "").toLowerCase();
  if (f.includes("reel")) return "reels";
  if (f.includes("carro")) return "carrossel";
  return "estatico";
}

const aiClients = buildClients(process.env);

const SYSTEM = `
Você é estrategista de conteúdo premium.

PROIBIDO:
- conteúdo genérico
- repetir temas
- focar só em manutenção

OBRIGATÓRIO:
- histórias reais
- erros de clientes
- bastidores
- comparações
- curiosidades técnicas
`;

app.post("/api/generate", async (req, res) => {
  try {
    const { username, reels, carousels, singlePosts } = req.body;

    const client = await getClient(username);

    const memoryContext = client.content_memory.last_themes.join(", ");

    const total = reels + carousels + singlePosts;

    const prompt = `
Crie ${total} posts.

Mix:
${reels} reels
${carousels} carrossel
${singlePosts} estatico

Cada post deve ser único.
`;

    const { output } = await generateWithPipeline({
      clients: aiClients,
      combinedSystem: SYSTEM,
      userPrompt: prompt,
      memoryContext
    });

    let posts = output.posts.map(p => ({
      ...p,
      format: normalizeFormat(p.format)
    }));

    // 🔥 remove repetidos
    posts = filterRepetitions(posts, client.content_memory);

    // 🔥 atualiza memória
    client.content_memory = updateMemory(client.content_memory, posts);

    await client.save();

    res.json({ posts });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Server rodando:", PORT);
});
