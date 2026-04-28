const axios = require("axios");

function buildClients(env) {
  return {
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini"
    }
  };
}

async function runLLM({ clients, system, user, temperature = 0.9 }) {
  const { openai } = clients;

  if (!openai.key) {
    throw new Error("OPENAI_API_KEY não configurada");
  }

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: openai.model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${openai.key}`,
        "Content-Type": "application/json"
      }
    }
  );

  const text = res.data.choices[0].message.content;

  try {
    return JSON.parse(text);
  } catch {
    return { posts: [] };
  }
}

module.exports = { buildClients, runLLM };
