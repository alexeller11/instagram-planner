require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generateWithPipeline } = require("./ai/pipeline");
const { filterRepetitions, updateMemory } = require("./ai/memory");
const { getProfilePosts, extractPatterns } = require("./ai/insights");
const { filterQuality } = require("./ai/quality");

const app = express();
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI || "");

const Client = mongoose.model("Client", new mongoose.Schema({
  username: String,
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

const clients = buildClients(process.env);

const SYSTEM = `
Você é estrategista de conteúdo nível TITAN.

PROIBIDO:
- conteúdo genérico
- repetir ideias

OBRIGATÓRIO:
- curiosidade
- contraste
- storytelling
- impacto
`;

function enforceMix(posts, reels, carousels, single) {
  const byType = {
    reels: posts.filter(p => p.format === "reels"),
    carrossel: posts.filter(p => p.format === "carrossel"),
    estatico: posts.filter(p => p.format === "estatico")
  };

  return [
    ...byType.reels.slice(0, reels),
    ...byType.carrossel.slice(0, carousels),
    ...byType.estatico.slice(0, single)
  ];
}

app.post("/api/generate", async (req, res) => {
  try {
    const { username, reels = 0, carousels = 0, singlePosts = 0 } = req.body;

    const client = await getClient(username);

    const postsRaw = await getProfilePosts(username);
    const patterns = extractPatterns(postsRaw);

    const memory = client.content_memory.last_themes.join(", ");

    const total = reels + carousels + singlePosts;

    const prompt = `
Crie ${total} posts.

Cada post deve conter:
- theme
- caption
- format (reels/carrossel/estatico)

Todos diferentes.
`;

    const result = await generateWithPipeline({
      clients,
      system: SYSTEM,
      prompt,
      memory,
      patterns
    });

    let posts = result.posts || [];

    // normaliza formato
    posts = posts.map(p => ({
      ...p,
      format: (p.format || "").toLowerCase().includes("reel")
        ? "reels"
        : (p.format || "").toLowerCase().includes("carro")
        ? "carrossel"
        : "estatico"
    }));

    // filtros TITAN
    posts = filterRepetitions(posts, client.content_memory);
    posts = filterQuality(posts);

    // garante mix
    posts = enforceMix(posts, reels, carousels, singlePosts);

    // atualiza memória
    client.content_memory = updateMemory(client.content_memory, posts);
    await client.save();

    res.json({ posts });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(10000, () => {
  console.log("🚀 TITAN MODE ONLINE");
});
