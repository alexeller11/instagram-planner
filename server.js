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
- clichês
- repetir ideias

OBRIGATÓRIO:
- curiosidade
- storytelling
- exemplos reais
- impacto
`;

// ================= ROTA HOME =================
app.get("/", (req, res) => {
  res.send("🚀 API Instagram Planner está online");
});

// ================= HEALTH =================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ================= GERAÇÃO =================
app.get("/api/generate", async (req, res) => {
  try {
    const username = req.query.username || "teste";

    log.info("🔍 Gerando conteúdo para:", username);

    const client = await getClient(username);

    const prompt = `
Crie 6 posts para Instagram.

Cada post deve conter:
- theme
- caption
- format (reels, carrossel ou estatico)

Todos diferentes entre si.
`;

    const result = await generate({
      clients,
      system: SYSTEM,
      prompt,
      memory: (client.memory.last || []).join(", ")
    });

    console.log("🧠 RESPOSTA BRUTA IA:", result);

    let posts = Array.isArray(result.posts) ? result.posts : [];

    // 🔥 fallback se vier vazio
    if (!posts.length) {
      log.error("⚠️ IA retornou vazio, usando fallback");

      posts = [
        {
          theme: "Erro comum que custa caro",
          caption: "Esse é o tipo de erro que a maioria das pessoas só percebe quando já virou prejuízo. E o pior: dava pra evitar com algo simples.",
          format: "reels"
        },
        {
          theme: "Bastidores do serviço",
          caption: "O que ninguém vê por trás de um serviço bem feito é exatamente o que garante o resultado final.",
          format: "carrossel"
        }
      ];
    }

    // evita repetição
    posts = avoidRepetition(posts, client.memory);

    // salva memória
    client.memory = updateMemory(client.memory, posts);
    await client.save();

    res.json({ posts });

  } catch (err) {
    log.error("❌ erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
app.listen(PORT, () => {
  log.info(`🚀 API rodando na porta ${PORT}`);
});
