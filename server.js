require("dotenv").config();
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generateWithPipeline, generateMissingBatch } = require("./ai/pipeline");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

const log = {
  info: (...a) => console.log("[INFO]", ...a),
  error: (...a) => console.error("[ERROR]", ...a),
};

// ================= DATABASE =================

mongoose.connect(process.env.MONGODB_URI || "")
  .then(() => log.info("Mongo conectado"))
  .catch(err => log.error(err));

const Client = mongoose.model("Client", new mongoose.Schema({
  username: String,
  niche: String,
  audience: String,
  saved_planners: Array
}));

async function getClient(username) {
  let c = await Client.findOne({ username });
  if (!c) {
    c = new Client({ username });
    await c.save();
  }
  return c;
}

// ================= HELPERS =================

function normalizeFormat(f) {
  f = String(f || "").toLowerCase();
  if (f.includes("reel")) return "reels";
  if (f.includes("carro")) return "carrossel";
  return "estatico";
}

// ================= IA =================

const aiClients = buildClients(process.env);

const SYSTEM = `
Você é um estrategista de conteúdo avançado.

ANTI-GENERICIDADE OBRIGATÓRIA:
- NÃO falar só de manutenção
- NÃO repetir ideias
- NÃO fazer conteúdo padrão

VARIAÇÃO OBRIGATÓRIA:
- histórias reais
- bastidores
- erros de clientes
- comparações
- curiosidades técnicas
- polêmicas do setor

Se parecer genérico → reescreva.
`;

// ================= ROUTE =================

app.post("/api/generate", async (req, res) => {
  try {
    const { username, reels, carousels, singlePosts, goal, tone } = req.body;

    const client = await getClient(username);

    const total = reels + carousels + singlePosts;

    const prompt = `
Crie ${total} posts.

Mix obrigatório:
${reels} reels
${carousels} carrossel
${singlePosts} estatico

Nicho: ${client.niche}
Público: ${client.audience}
Objetivo: ${goal}
Tom: ${tone}

Cada post deve ser totalmente diferente.
`;

    const { output } = await generateWithPipeline({
      clients: aiClients,
      log,
      combinedSystem: SYSTEM,
      userPrompt: prompt
    });

    let posts = Array.isArray(output.posts) ? output.posts : [];

    posts = posts.map(p => ({
      ...p,
      format: normalizeFormat(p.format)
    }));

    const count = { reels: 0, carrossel: 0, estatico: 0 };
    posts.forEach(p => count[p.format]++);

    const missing = {
      reels: Math.max(0, reels - count.reels),
      carrossel: Math.max(0, carousels - count.carrossel),
      estatico: Math.max(0, singlePosts - count.estatico),
    };

    let extra = [];

    const context = `
Conta: ${username}
Nicho: ${client.niche}
Público: ${client.audience}
`;

    for (const [type, qty] of Object.entries(missing)) {
      if (qty > 0) {
        const batch = await generateMissingBatch({
          clients: aiClients,
          log,
          combinedSystem: SYSTEM,
          count: qty,
          format: type,
          context
        });

        if (Array.isArray(batch.posts)) {
          extra.push(...batch.posts.map(p => ({
            ...p,
            format: type
          })));
        }
      }
    }

    posts = [...posts, ...extra];

    const final = [
      ...posts.filter(p => p.format === "reels").slice(0, reels),
      ...posts.filter(p => p.format === "carrossel").slice(0, carousels),
      ...posts.filter(p => p.format === "estatico").slice(0, singlePosts),
    ];

    final.forEach((p, i) => p.n = i + 1);

    client.saved_planners.push({ date: new Date(), posts: final });
    await client.save();

    res.json({ posts: final });

  } catch (err) {
    log.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  log.info("Server rodando na porta", PORT);
});
