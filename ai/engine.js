const axios = require("axios");

function buildClients(env) {
  return {
    openai: {
      key: env.OPENAI_API_KEY,
      model: "gpt-3.5-turbo"
    },
    groq: {
      key: env.GROQ_API_KEY,
      model: "llama3-70b-8192"
    }
  };
}

async function callOpenAI(client, system, user) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: client.model,
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

async function callGroq(client, system, user) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: client.model,
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

function extractJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { posts: [] };
  } catch {
    return { posts: [] };
  }
}

async function runLLM({ clients, system, user }) {
  try {
    if (clients.openai.key) {
      const text = await callOpenAI(clients.openai, system, user);
      return extractJSON(text);
    }
  } catch (err) {
    console.log("⚠️ OpenAI falhou, tentando Groq...");
  }

  try {
    if (clients.groq.key) {
      const text = await callGroq(clients.groq, system, user);
      return extractJSON(text);
    }
  } catch (err) {
    console.log("❌ Groq também falhou");
  }

  return { posts: [] };
}

module.exports = { buildClients, runLLM };
