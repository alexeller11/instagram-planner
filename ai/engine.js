const axios = require("axios");

function buildClients(env) {
  return {
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-3.5-turbo"
    }
  };
}

function extractJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { posts: [] };
  } catch {
    return { posts: [] };
  }
}

async function runLLM({ clients, system, user }) {
  try {
    const { openai } = clients;

    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: openai.model,
        temperature: 0.8,
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

    console.log("🧠 IA respondeu:", text);

    return extractJSON(text);

  } catch (err) {
    console.error("❌ ERRO IA:", err.message);
    return { posts: [] };
  }
}

module.exports = { buildClients, runLLM };
