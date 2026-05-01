const axios = require("axios");

function buildClients(env) {
  return {
    groq: {
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL || "llama-3.3-70b-versatile"
    },
    nvidia: {
      key: env.NVIDIA_API_KEY,
      model: env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct"
    },
    openai: {
      key: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-4o-mini"
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

// FASE 1: Implementar retry com backoff exponencial
async function callGenericWithRetry(url, key, model, system, user, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[${url.split('/')[2]}] Tentativa ${attempt}/${maxRetries}...`);
      
      const res = await axios.post(
        url,
        {
          model: model,
          temperature: 0.4,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          response_format: { type: "json_object" }
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          timeout: 30000 // Reduzido de 90s para 30s
        }
      );
      
      console.log(`[${url.split('/')[2]}] ✓ Sucesso na tentativa ${attempt}`);
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (e) {
      lastError = e;
      
      // Não fazer retry para erros de validação (400)
      if (e.response?.status === 400) {
        console.error(`[${url.split('/')[2]}] ✗ Erro de validação (400):`, e.response?.data?.error?.message || e.message);
        throw e;
      }
      
      // Não fazer retry para erros de autenticação (401, 403)
      if (e.response?.status === 401 || e.response?.status === 403) {
        console.error(`[${url.split('/')[2]}] ✗ Erro de autenticação (${e.response.status})`);
        throw e;
      }
      
      if (attempt < maxRetries) {
        // Backoff exponencial: 1s, 2s, 4s
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`[${url.split('/')[2]}] ⏳ Retry em ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`[${url.split('/')[2]}] ✗ Falha após ${maxRetries} tentativas:`, e.message);
      }
    }
  }
  
  throw lastError;
}

async function runLLM({ clients, system, user }) {
  // Prioridade 1: Groq (Rápido e Estável)
  if (clients.groq?.key) {
    try {
      const text = await callGenericWithRetry(
        "https://api.groq.com/openai/v1/chat/completions",
        clients.groq.key,
        clients.groq.model,
        system,
        user
      );
      const data = tryParseJSON(text);
      if (Object.keys(data).length) return data;
    } catch (e) {
      console.log("✗ Groq falhou:", e.message);
    }
  }

  // Prioridade 2: OpenAI (Backup Robusto)
  if (clients.openai?.key) {
    try {
      const text = await callGenericWithRetry(
        "https://api.openai.com/v1/chat/completions",
        clients.openai.key,
        clients.openai.model,
        system,
        user
      );
      const data = tryParseJSON(text);
      if (Object.keys(data).length) return data;
    } catch (e) {
      console.log("✗ OpenAI falhou:", e.message);
    }
  }

  // Prioridade 3: NVIDIA
  if (clients.nvidia?.key) {
    try {
      const text = await callGenericWithRetry(
        "https://integrate.api.nvidia.com/v1/chat/completions",
        clients.nvidia.key,
        clients.nvidia.model,
        system,
        user
      );
      const data = tryParseJSON(text);
      if (Object.keys(data).length) return data;
    } catch (e) {
      console.log("✗ NVIDIA falhou:", e.message);
    }
  }

  console.warn("⚠ Nenhum provedor de IA disponível");
  return {};
}

module.exports = { buildClients, runLLM };
