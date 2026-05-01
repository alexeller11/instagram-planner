const axios = require("axios");

function buildClients(env) {
  return {
    groq: {
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "llama-3.3-70b-versatile"
    },
    nvidia: {
      key: env.NVIDIA_API_KEY,
      model: env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct"
    },
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini"
    }
  };
}

function tryParseJSON(text) {
  try {
    const raw = String(text || "").trim();
    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first !== -1 && last !== -1) {
      return JSON.parse(raw.slice(first, last + 1));
    }
    return {};
  } catch {
    return {};
  }
}

async function callGeneric(url, key, model, system, user) {
  const res = await axios.post(
    url,
    {
      model: model,
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );
  return res.data?.choices?.[0]?.message?.content || "";
}

async function runLLM({ clients, system, user }) {
  // Prioridade 1: Groq (Rápido e Estável)
  if (clients.groq?.key) {
    try {
      const text = await callGeneric("https://api.groq.com/openai/v1/chat/completions", clients.groq.key, clients.groq.model, system, user);
      const data = tryParseJSON(text);
      if (Object.keys(data).length) return data;
    } catch (e) { console.log("GROQ Error:", e.message); }
  }

  // Prioridade 2: OpenAI (Backup Robusto)
  if (clients.openai?.key) {
    try {
      const text = await callGeneric("https://api.openai.com/v1/chat/completions", clients.openai.key, clients.openai.model, system, user);
      const data = tryParseJSON(text);
      if (Object.keys(data).length) return data;
    } catch (e) { console.log("OpenAI Error:", e.message); }
  }

  // Prioridade 3: NVIDIA
  if (clients.nvidia?.key) {
    try {
      const text = await callGeneric("https://integrate.api.nvidia.com/v1/chat/completions", clients.nvidia.key, clients.nvidia.model, system, user);
      const data = tryParseJSON(text);
      if (Object.keys(data).length) return data;
    } catch (e) { console.log("NVIDIA Error:", e.message); }
  }

  return {};
}

module.exports = { buildClients, runLLM };
