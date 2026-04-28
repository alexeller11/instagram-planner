require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const { buildClients } = require("./ai/engine");
const { generateBatch } = require("./ai/pipeline");
const { getProfileData, extractPatterns } = require("./ai/insights");
const { decideStrategy, planSlots } = require("./ai/brain");
const { updateMemory, avoidRepetition } = require("./ai/memory");
const { baseScore, filterQuality } = require("./ai/quality");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===== DB =====
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

// ===== IA =====
const clients = buildClients(process.env);

const SYSTEM = `
Você é um estrategista SINGULARITY.

CRIE CONTEÚDO:
- específico
- não óbvio
- com gancho forte
- com variação de ângulo

PROIBIDO:
- clichês
- repetição
- frases genéricas
`;

// normaliza formato
function normalize(f) {
  const x = (f || "").toLowerCase();
  if (x.includes("reel")) return "reels";
  if (x.includes("carro")) return "carrossel";
  return "estatico";
}

app.post("/api/generate", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "username obrigatório" });

    const client = await getClient(username);

    // 1) Dados reais
    const insights = await getProfileData(username);
    const patterns = extractPatterns(insights);

    // 2) Estratégia (mix)
    const strategy = decideStrategy(insights);
    const slots = planSlots(strategy);

    // 3) Geração A/B (variantes)
    let variants = await generateBatch({
      clients,
      system: SYSTEM,
      slots,
      patterns,
      memory: (client.memory.last || []).join(", ")
    });

    // fallback
    if (!variants.length) {
      return res.json({ strategy, posts: [] });
    }

    // 4) Normaliza + filtra repetição
    variants = variants.map(v => ({
      ...v,
      format: normalize(v.format)
    }));

    variants = avoidRepetition(variants, client.memory);

    // 5) Score e seleção (escolhe a melhor variação por slot)
    const grouped = {};
    for (const v of variants) {
      if (!grouped[v.slot]) grouped[v.slot] = [];
      grouped[v.slot].push(v);
    }

    let selected = [];
    for (const slotId of Object.keys(grouped)) {
      const list = grouped[slotId];

      // remove lixo
      const good = filterQuality(list);

      // ordena por score
      const ranked = (good.length ? good : list)
        .map(p => ({ ...p, _score: baseScore(p) }))
        .sort((a, b) => b._score - a._score);

      if (ranked.length) selected.push(ranked[0]);
    }

    // 6) Garante mix final
    const byType = {
      reels: selected.filter(p => p.format === "reels"),
      carrossel: selected.filter(p => p.format === "carrossel"),
      estatico: selected.filter(p => p.format === "estatico")
    };

    const final = [
      ...byType.reels.slice(0, strategy.reels),
      ...byType.carrossel.slice(0, strategy.carrossel),
      ...byType.estatico.slice(0, strategy.estatico)
    ].map((p, i) => ({ ...p, n: i + 1 }));

    // 7) Memória evolutiva
    client.memory = updateMemory(client.memory, final);
    await client.save();

    res.json({
      strategy,
      count: final.length,
      posts: final
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("🧠 SINGULARITY ONLINE:", PORT);
});
