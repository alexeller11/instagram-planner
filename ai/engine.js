const axios = require("axios");

function buildClients(env) {
  return {
    nvidia: {
      key: env.NVIDIA_API_KEY,
      model: env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct"
    },
    groq: {
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "llama-3.1-8b-instant"
    }
  };
}

function extractJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch {
    return {};
  }
}

// ================= NVIDIA =================
async function callNvidia(client, system, user) {
  const res = await axios.post(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${client.key}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices[0].message.content;
}

// ================= GROQ =================
async function callGroq(client, system, user) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${client.key}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices[0].message.content;
}

// ================= ORQUESTRADOR =================
async function runLLM({ clients, system, user }) {

  // 🔥 NVIDIA primeiro
  try {
    if (clients.nvidia.key) {
      console.log("🟣 Tentando NVIDIA...");
      const text = await callNvidia(clients.nvidia, system, user);
      console.log("🧠 NVIDIA OK");
      return extractJSON(text);
    }
  } catch (err) {
    console.log("⚠️ NVIDIA falhou:", err.response?.status || err.message);
  }

  // 🔥 GROQ fallback
  try {
    if (clients.groq.key) {
      console.log("🟢 Tentando GROQ...");
      const text = await callGroq(clients.groq, system, user);
      console.log("🧠 GROQ OK");
      return extractJSON(text);
    }
  } catch (err) {
    console.log("❌ GROQ falhou:", err.response?.status || err.message);
  }

  console.log("❌ Nenhuma IA respondeu");

  return {};
}

module.exports = {
  buildClients,
  runLLM
};
