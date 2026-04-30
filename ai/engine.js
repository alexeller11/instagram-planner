const axios = require("axios");

function buildClients(env) {
  return {
    nvidia: {
      key: env.NVIDIA_API_KEY,
      model: env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct"
    },
    groq: {
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "llama-3.3-70b-versatile"
    }
  };
}

function tryParseJSON(text) {
  try {
    const raw = String(text || "").trim();

    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);

    const firstBracket = raw.indexOf("{");
    const lastBracket = raw.lastIndexOf("}");
    if (firstBracket !== -1 && lastBracket !== -1) {
      return JSON.parse(raw.slice(firstBracket, lastBracket + 1));
    }

    return {};
  } catch {
    return {};
  }
}

async function callNvidia(client, system, user) {
  const res = await axios.post(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.45,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${client.key}`,
        "Content-Type": "application/json"
      },
      timeout: 90000
    }
  );

  return res.data?.choices?.[0]?.message?.content || "";
}

async function callGroq(client, system, user) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.45,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${client.key}`,
        "Content-Type": "application/json"
      },
      timeout: 90000
    }
  );

  return res.data?.choices?.[0]?.message?.content || "";
}

async function runLLM({ clients, system, user }) {
  try {
    if (clients.nvidia?.key) {
      const text = await callNvidia(clients.nvidia, system, user);
      const json = tryParseJSON(text);
      if (Object.keys(json).length) return json;
    }
  } catch (e) {
    console.log("NVIDIA falhou:", e.response?.status || e.message);
  }

  try {
    if (clients.groq?.key) {
      const text = await callGroq(clients.groq, system, user);
      const json = tryParseJSON(text);
      if (Object.keys(json).length) return json;
    }
  } catch (e) {
    console.log("GROQ falhou:", e.response?.status || e.message);
  }

  return {};
}

module.exports = { buildClients, runLLM };
