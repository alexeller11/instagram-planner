const axios = require("axios");

function buildClients(env) {
  return {
    nvidia: {
      key: env.NVIDIA_API_KEY,
      model: env.NVIDIA_MODEL || "meta/llama-3.1-8b-instruct"
    }
  };
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
    if (!clients.nvidia.key) {
      throw new Error("NVIDIA_API_KEY não definida");
    }

    console.log("🟣 Usando NVIDIA (modelo atual)...");

    const response = await axios.post(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        model: clients.nvidia.model,
        temperature: 0.7,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${clients.nvidia.key}`,
          "Content-Type": "application/json"
        }
      }
    );

    const text = response.data.choices[0].message.content;

    console.log("🧠 RESPOSTA NVIDIA:\n", text);

    return extractJSON(text);

  } catch (err) {
    console.error("❌ ERRO NVIDIA:", err.response?.data || err.message);
    return { posts: [] };
  }
}

module.exports = { buildClients, runLLM };
