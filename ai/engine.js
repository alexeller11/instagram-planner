const axios = require("axios");

function buildClients(env) {
  return {
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini"
    }
  };
}

async function runLLM({ clients, system, user }) {
  try {
    const { openai } = clients;

    if (!openai.key) {
      throw new Error("OPENAI_API_KEY não configurada");
    }

    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: openai.model,
        temperature: 0.9,
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

    console.log("🧠 RESPOSTA IA:", text.slice(0, 300));

    try {
      return JSON.parse(text);
    } catch (err) {
      console.error("❌ JSON inválido da IA");
      return { posts: [] };
    }

  } catch (err) {
    console.error("❌ ERRO IA:", err.message);
    return { posts: [] };
  }
}

module.exports = { buildClients, runLLM };
