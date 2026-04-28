const axios = require("axios");

function buildClients(env) {
  return {
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-3.5-turbo"
    }
  };
}

async function runLLM({ clients, system, user }) {
  const { openai } = clients;

  try {
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

    try {
      return JSON.parse(text);
    } catch {
      return { posts: [] };
    }

  } catch (err) {
    if (err.response?.status === 429) {
      console.error("🚫 LIMITE DA OPENAI ATINGIDO (429)");
      return {
        posts: [
          {
            theme: "Sistema temporariamente limitado",
            caption: "A geração automática está temporariamente indisponível. Tente novamente em alguns minutos.",
            format: "estatico"
          }
        ]
      };
    }

    console.error("❌ ERRO IA:", err.message);

    return { posts: [] };
  }
}

module.exports = { buildClients, runLLM };
