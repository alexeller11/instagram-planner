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

  if (niche && c.niche !== niche) {
    c.niche = niche;
    await c.save();
  }

  return c;
}

// ================= IA =================
const clients = buildClients(process.env);

// ================= ROTAS =================

app.get("/", (req, res) => {
  res.send("🚀 API Instagram Planner está online");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ================= GERAÇÃO =================

app.get("/api/generate", async (req, res) => {
  try {
    const username = req.query.username || "teste";
    const niche = req.query.niche || "negócios locais";

    log.info("🔍 Cliente:", username, "| Nicho:", niche);

    const client = await getClient(username, niche);

    const result = await generate({
      clients,
      niche: client.niche,
      memory: (client.memory.last || []).join(", ")
    });

    console.log("🧠 RESPOSTA BRUTA IA:", result);

    // 🔥 SUPORTE A TODOS FORMATOS
    let output = [];

    if (Array.isArray(result.posts)) {
      output = result.posts;
    } else if (Array.isArray(result.calendar)) {
      output = result.calendar;
    } else if (Array.isArray(result.month_plan)) {
      output = result.month_plan;
    }

    // 🔥 FALLBACK
    if (!output.length) {
      log.error("⚠️ IA retornou vazio, usando fallback");

      output = [
        {
          theme: "Conteúdo indisponível",
          caption: "Estamos ajustando sua estratégia.",
          format: "estatico"
        }
      ];
    }

    // 🔥 SE FOR POSTS SIMPLES → aplica memória
    if (Array.isArray(result.posts)) {
      let posts = avoidRepetition(output, client.memory);
      client.memory = updateMemory(client.memory, posts);
      await client.save();
      return res.json({ type: "posts", data: posts });
    }

    // 🔥 CALENDÁRIO SEMANAL
    if (Array.isArray(result.calendar)) {
      return res.json({ type: "weekly_calendar", data: output });
    }

    // 🔥 CALENDÁRIO MENSAL
    if (Array.isArray(result.month_plan)) {
      return res.json({ type: "monthly_calendar", data: output });
    }

    // fallback final
    res.json({ type: "unknown", data: output });

  } catch (err) {
    log.error("❌ erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================

app.listen(PORT, () => {
  log.info(`🚀 API rodando na porta ${PORT}`);
});
