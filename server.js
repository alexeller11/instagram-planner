require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generateWithPipeline } = require("./ai/pipeline");
const { filterRepetitions, updateMemory } = require("./ai/memory");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ================= LOG =================
const log = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

// ================= DATABASE =================
mongoose.connect(process.env.MONGODB_URI || "")
  .then(() => log.info("✅ Mongo conectado"))
  .catch(err => log.error("❌ Mongo erro:", err.message));

// ================= SCHEMA =================
const clientSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },

  niche: { type: String, default: "" },
  audience: { type: String, default: "" },
  location: { type: String, default: "" },
  tone: { type: String, default: "" },

  // 🔥 MEMÓRIA DE CONTEÚDO
  content_memory: {
    last_themes: { type: [String], default: [] }
  },

  // 🔥 MEMÓRIA DE PERFORMANCE
  performance_memory: {
    top_posts: [{
      theme: String,
      content: String,
      score: Number,
      date: Date
    }]
  },

  saved_planners: { type: Array, default: [] },
  single_posts: { type: Array, default: [] }

}, { timestamps: true });

const Client = mongoose.model("Client", clientSchema);

// ================= HELPERS =================

async function getClient(username) {
  let client = await Client.findOne({ username });

  if (!client) {
    client = new Client({
      username,
      content_memory: { last_themes: [] }
    });
    await client.save();
  }

  return client;
}

function normalizeFormat(format) {
  const f = String(format || "").toLowerCase();

  if (f.includes("reel")) return "reels";
  if (f.includes("carro")) return "carrossel";
  return "estatico";
}

// ================= IA =================

const aiClients = buildClients(process.env);

const SYSTEM = `
Você é um estrategista de conteúdo nível agência premium.

ANTI-GENERICIDADE (OBRIGATÓRIO):
- NÃO focar só em manutenção
- NÃO repetir ideias
- NÃO fazer conteúdo genérico

VARIAÇÃO OBRIGATÓRIA:
- histórias reais de clientes
- bastidores da empresa
- erros comuns
- comparações (barato vs caro)
- curiosidades técnicas
- situações do dia a dia

Se parecer conteúdo padrão → reescreva.
`;

// ================= ROUTE PRINCIPAL =================

app.post("/api/generate", async (req, res) => {
  try {
    const {
      username,
      reels = 0,
      carousels = 0,
      singlePosts = 0,
      goal = "",
      tone = ""
    } = req.body;

    if (!username) {
      return res.status(400).json({ error: "username obrigatório" });
    }

    const client = await getClient(username);

    const total = reels + carousels + singlePosts;

    if (total === 0) {
      return res.status(400).json({ error: "Defina quantidade de posts" });
    }

    const memoryContext = (client.content_memory?.last_themes || []).join(", ");

    const prompt = `
Crie ${total} posts para Instagram.

MIX:
${reels} reels
${carousels} carrossel
${singlePosts} estatico

Nicho: ${client.niche}
Público: ${client.audience}
Objetivo: ${goal}
Tom: ${tone}

TEMAS JÁ USADOS (NÃO REPETIR):
${memoryContext}

REGRA:
Cada post deve ser completamente diferente.
`;

    const { output } = await generateWithPipeline({
      clients: aiClients,
      log,
      combinedSystem: SYSTEM,
      userPrompt: prompt,
      memoryContext
    });

    let posts = Array.isArray(output?.posts) ? output.posts : [];

    // 🔥 fallback (não quebra mais)
    if (!posts.length) {
      return res.json({ posts: [] });
    }

    // normaliza formato
    posts = posts.map(p => ({
      ...p,
      format: normalizeFormat(p.format)
    }));

    // 🔥 remove repetidos
    posts = filterRepetitions(posts, client.content_memory);

    // 🔥 atualiza memória
    client.content_memory = updateMemory(client.content_memory, posts);

    // 🔥 salva planner
    client.saved_planners.push({
      date: new Date(),
      posts
    });

    if (client.saved_planners.length > 20) {
      client.saved_planners.shift();
    }

    await client.save();

    // numeração
    posts.forEach((p, i) => p.n = i + 1);

    res.json({ posts });

  } catch (err) {
    log.error("❌ Erro generate:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= HEALTH =================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    db: mongoose.connection.readyState
  });
});

// ================= START =================

app.listen(PORT, () => {
  log.info(`🚀 Server rodando na porta ${PORT}`);
});
