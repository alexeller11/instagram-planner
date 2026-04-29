const axios = require("axios");

function buildClients(env) {
  return {
    groq: {
      key: env.GROQ_API_KEY,
      model: "llama3-70b-8192"
    }
  };
}

// extrai JSON mesmo se vier texto junto
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
    if (!clients.groq.key) {
      throw new Error("GROQ_API_KEY não definida");
    }

    console.log("🟢 Chamando GROQ...");

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-70b-8192",
        temperature: 0.7,
        messages: [
          {
            role: "user",
            content: `${system}\n\n${user}`
          }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${clients.groq.key}`,
          "Content-Type": "application/json"
        }
      }
    );

    const text = response.data.choices[0].message.content;

    console.log("🧠 RESPOSTA GROQ:\n", text);

    return extractJSON(text);

  } catch (err) {
    console.error("❌ ERRO GROQ:", err.response?.data || err.message);
    return { posts: [] };
  }
}

module.exports = { buildClients, runLLM };
