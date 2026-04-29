require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generate } = require("./ai/pipeline");
const { updateMemory, avoidRepetition } = require("./ai/memory");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URI || "");

const Client = mongoose.model("Client", new mongoose.Schema({
  username: String,
  niche: String,
  memory: { last: [String] }
}));

async function getClient(username, niche) {
  let c = await Client.findOne({ username });

  if (!c) {
    c = new Client({
      username,
      niche,
      memory: { last: [] }
    });
    await c.save();
  }

  // atualiza nicho se vier novo
  if (niche && c.niche !== niche) {
    c.niche = niche;
    await c.save();
  }

  return c;
}

const clients = buildClients(process.env);

app.get("/", (req, res) => {
  res.send("🚀 API Instagram Planner está online");
});

app.get("/api/generate", async (req, res) => {
  try {
    const username = req.query.username || "teste";
    const niche = req.query.niche || "negócios locais";

    console.log("🔍 Cliente:", username, "| Nicho:", niche);

    const client = await getClient(username, niche);

    const result = await generate({
      clients,
      niche: client.niche,
      memory: (client.memory.last || []).join(", ")
    });

    let posts = Array.isArray(result.posts) ? result.posts : [];

    if (!posts.length) {
      posts = [
        {
          theme: "Conteúdo temporariamente indisponível",
          caption: "Estamos ajustando sua estratégia de conteúdo.",
          format: "estatico"
        }
      ];
    }

    posts = avoidRepetition(posts, client.memory);

    client.memory = updateMemory(client.memory, posts);
    await client.save();

    res.json({ posts });

  } catch (err) {
    console.error("❌ erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("🚀 API rodando:", PORT);
});
