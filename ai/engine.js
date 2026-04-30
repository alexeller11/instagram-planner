const axios = require("axios");

function buildClients(env) {
  return {
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini"
    },
    groq: {
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "llama-3.3-70b-versatile"
    },
    gemini: {
      key: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || "gemini-2.5-flash"
    },
    sambanova: {
      key: env.SAMBANOVA_API_KEY,
      model: env.SAMBANOVA_MODEL || "Meta-Llama-3.1-70B-Instruct"
    },
    nvidia: {
      key: env.NVIDIA_API_KEY,
      model: env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct"
    }
  };
}

function tryParseJSON(text) {
  try {
    const raw = String(text || "").trim();

    const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);

    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first !== -1 && last !== -1) {
      return JSON.parse(raw.slice(first, last + 1));
    }

    return {};
  } catch {
    return {};
  }
}

async function callOpenAI(client, system, user) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.4,
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

async function callGemini(client, system, user) {
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${client.model}:generateContent?key=${client.key}`,
    {
      contents: [
        {
          role: "user",
          parts: [
            { text: `${system}\n\n${user}` }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.4
      }
    },
    {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 90000
    }
  );

  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callSambaNova(client, system, user) {
  const res = await axios.post(
    "https://api.sambanova.ai/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.4,
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

async function callNvidia(client, system, user) {
  const res = await axios.post(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      model: client.model,
      temperature: 0.4,
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
      temperature: 0.4,
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
  const providers = [
    { name: "OpenAI", key: "openai", fn: callOpenAI },
    { name: "Groq", key: "groq", fn: callGroq },
    { name: "Gemini", key: "gemini", fn: callGemini },
    { name: "SambaNova", key: "sambanova", fn: callSambaNova },
    { name: "NVIDIA", key: "nvidia", fn: callNvidia }
  ];

  for (const provider of providers) {
    try {
      if (clients[provider.key]?.key) {
        const text = await provider.fn(clients[provider.key], system, user);
        const data = tryParseJSON(text);
        if (Object.keys(data || {}).length) {
          console.log(`✓ ${provider.name} respondeu com sucesso`);
          return data;
        }
      }
    } catch (e) {
      console.log(`✗ ${provider.name} falhou:`, e.response?.status || e.message);
    }
  }

  console.warn("⚠ Nenhum provedor de IA disponível");
  return {};
}

module.exports = { buildClients, runLLM };
