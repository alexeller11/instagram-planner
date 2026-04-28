const axios = require("axios");

// ========= CONFIG =========
function buildClients(env) {
  return {
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini"
    },
    groq: {
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "llama3-70b-8192"
    },
    openrouter: {
      key: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini"
    }
  };
}

// ========= HELPERS =========
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function retry(fn, { tries = 3, baseDelay = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      // backoff maior pra 429
      const delay = status === 429 ? baseDelay * Math.pow(2, i + 1) : baseDelay * Math.pow(2, i);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { posts: [] };
  }
}

// ========= PROVIDERS =========

// OpenAI
async function callOpenAI({ key, model, system, user }) {
  if (!key) throw new Error("OPENAI_API_KEY ausente");
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );
  const text = res.data.choices?.[0]?.message?.content || "";
  return safeJSON(text);
}

// Groq
async function callGroq({ key, model, system, user }) {
  if (!key) throw new Error("GROQ_API_KEY ausente");
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );
  const text = res.data.choices?.[0]?.message?.content || "";
  return safeJSON(text);
}

// OpenRouter
async function callOpenRouter({ key, model, system, user }) {
  if (!key) throw new Error("OPENROUTER_API_KEY ausente");
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );
  const text = res.data.choices?.[0]?.message?.content || "";
  return safeJSON(text);
}

// ========= ORQUESTRADOR =========

async function runLLM({ clients, system, user }) {
  const providers = [
    async () => retry(() => callOpenAI({
      key: clients.openai.key,
      model: clients.openai.model,
      system,
      user
    })),
    async () => retry(() => callGroq({
      key: clients.groq.key,
      model: clients.groq.model,
      system,
      user
    })),
    async () => retry(() => callOpenRouter({
      key: clients.openrouter.key,
      model: clients.openrouter.model,
      system,
      user
    }))
  ];

  const errors = [];

  for (const fn of providers) {
    try {
      const res = await fn();
      if (res && Array.isArray(res.posts)) {
        console.log("✅ Provider respondeu com sucesso");
        return res;
      }
    } catch (err) {
      const status = err?.response?.status;
      console.error("❌ Provider falhou:", status || err.message);
      errors.push({ status, msg: err.message });
      continue;
    }
  }

  // Degradação elegante
  console.error("🧯 Todos providers falharam:", errors);
  return {
    posts: [
      {
        theme: "Sistema temporariamente indisponível",
        caption:
          "A geração automática está instável no momento. Tente novamente em alguns minutos ou verifique suas chaves de API.",
        format: "estatico"
      }
    ]
  };
}

module.exports = { buildClients, runLLM };
