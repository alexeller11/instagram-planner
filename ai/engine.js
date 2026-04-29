const axios = require("axios");

function buildClients(env) {
  return {
    groq: {
      key: env.GROQ_API_KEY,
      model: "llama3-70b-8192"
    },
    openai: {
      key: env.OPENAI_API_KEY,
      model: "gpt-3.5-turbo"
    }
  };
}

// extrai JSON mesmo se vier bagunçado
function extractJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { posts: [] };
  } catch {
    return { posts: [] };
  }
}

// ================= GROQ =================
async function callGroq(client, system, user) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.8,
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

// ================= OPENAI (fallback) =================
async function callOpenAI(client, system, user) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.8,
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

  // 🔥 PRIMEIRO: GROQ
  try {
    if (clients.groq.key) {
      console.log("🟢 Usando GROQ...");
      const text = await callGroq(clients.groq, system, user);
      console.log("🧠 GROQ respondeu:", text);
      return extractJSON(text);
    }
  } catch (err) {
    console.log("⚠️ GROQ falhou:", err.message);
  }

  // 🔥 FALLBACK: OPENAI
  try {
    if (clients.openai.key) {
      console.log("🟡 Tentando OpenAI...");
      const text = await callOpenAI(clients.openai, system, user);
      return extractJSON(text);
    }
  } catch (err) {
    console.log("❌ OpenAI falhou:", err.message);
  }

  console.log("❌ Nenhuma IA respondeu");

  return { posts: [] };
}

module.exports = { buildClients, runLLM };
