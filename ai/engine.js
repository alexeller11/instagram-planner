const fs = require("fs");
const axios = require("axios");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// OpenAI (opcional)
let OpenAIClient = null;
try {
  OpenAIClient = require("openai");
} catch (_) {
  OpenAIClient = null;
}

function safeJsonParse(text) {
  try {
    const cleaned = String(text || "")
      .trim()
      .replace(/^```json/i, "")
      .replace(/```$/i, "")
      .trim();

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s) em ${label}`)), ms)
    ),
  ]);
}

function buildClients(env) {
  const GROQ_API_KEY = (env.GROQ_API_KEY || "").trim();
  const GEMINI_API_KEY = (env.GEMINI_API_KEY || "").trim();
  const SAMBANOVA_API_KEY = (env.SAMBANOVA_API_KEY || "").trim();
  const OPENAI_API_KEY = (env.OPENAI_API_KEY || "").trim();
  const OPENAI_MODEL = (env.OPENAI_MODEL || "gpt-4o-mini").trim();

  const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
  const gemini = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

  let openai = null;
  if (OpenAIClient && OPENAI_API_KEY) {
    const OpenAI = OpenAIClient;
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  }

  return {
    groq,
    gemini,
    openai,
    sambanovaKey: SAMBANOVA_API_KEY,
    openaiModel: OPENAI_MODEL,
  };
}

/**
 * Motor de IA com fallback e retorno SEMPRE em objeto JS
 * Ordem:
 * 0) OpenAI (se configurado e sem imagem)
 * 1) Groq (se configurado e sem imagem)
 * 2) SambaNova (se configurado e sem imagem)
 * 3) Gemini (se configurado, suporta imagem)
 */
async function runLLM({
  clients,
  system,
  user,
  imagePath,
  log,
  maxTokens = 3500,
  temperature = 0.8,
  json = true,
}) {
  const { openai, openaiModel, groq, sambanovaKey, gemini } = clients || {};
  let lastError = null;

  const mustJson = !!json;

  // 0) OPENAI
  if (openai && !imagePath) {
    try {
      log?.info?.(`🤖 Tentando OpenAI (${openaiModel})...`);
      const res = await withTimeout(
        openai.chat.completions.create({
          model: openaiModel,
          temperature,
          max_tokens: maxTokens,
          response_format: mustJson ? { type: "json_object" } : undefined,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        45000,
        `OpenAI/${openaiModel}`
      );

      const content = res?.choices?.[0]?.message?.content || "";
      const parsed = mustJson ? safeJsonParse(content) : { text: content };
      if (!parsed) throw new Error("OpenAI retornou JSON inválido.");
      log?.info?.("✅ OpenAI respondeu.");
      return parsed;
    } catch (err) {
      lastError = err;
      log?.warn?.(`⚠️ OpenAI falhou: ${err.message}`);
    }
  }

  // 1) GROQ
  if (groq && !imagePath) {
    for (const model of ["llama-3.3-70b-versatile", "llama3-70b-8192"]) {
      try {
        log?.info?.(`🤖 Tentando Groq: ${model}`);
        const res = await withTimeout(
          groq.chat.completions.create({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: mustJson ? { type: "json_object" } : undefined,
            max_tokens: maxTokens,
          }),
          30000,
          `Groq/${model}`
        );

        const content = res?.choices?.[0]?.message?.content || "";
        const parsed = mustJson ? safeJsonParse(content) : { text: content };
        if (!parsed) throw new Error("Groq retornou JSON inválido.");
        log?.info?.(`✅ Groq (${model}) respondeu.`);
        return parsed;
      } catch (err) {
        lastError = err;
        log?.warn?.(`⚠️ Groq (${model}) falhou: ${err.message}`);
      }
    }
  }

  // 2) SAMBANOVA
  if (sambanovaKey && !imagePath) {
    try {
      log?.info?.("🔥 Tentando SambaNova Cloud...");
      const res = await withTimeout(
        axios.post(
          "https://api.sambanova.ai/v1/chat/completions",
          {
            model: "Meta-Llama-3.3-70B-Instruct",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: mustJson ? { type: "json_object" } : undefined,
            max_tokens: maxTokens,
          },
          {
            headers: {
              Authorization: `Bearer ${sambanovaKey}`,
              "Content-Type": "application/json",
            },
            timeout: 55000,
          }
        ),
        60000,
        "SambaNova"
      );

      const content = res?.data?.choices?.[0]?.message?.content || "";
      const parsed = mustJson ? safeJsonParse(content) : { text: content };
      if (!parsed) throw new Error("SambaNova retornou JSON inválido.");
      log?.info?.("✅ SambaNova respondeu.");
      return parsed;
    } catch (err) {
      lastError = err;
      log?.warn?.(`⚠️ SambaNova falhou: ${err.message}`);
    }
  }

  // 3) GEMINI
  if (gemini) {
    try {
      log?.info?.("🚀 Tentando Gemini (gemini-1.5-flash)...");
      const model = gemini.getGenerativeModel({
        model: "gemini-1.5-flash",
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      });

      const parts = [
        `${system}\n\nResponda ESTRITAMENTE em formato JSON. Não use Markdown.\n\n${user}`,
      ];

      if (imagePath && fs.existsSync(imagePath)) {
        const imageData = fs.readFileSync(imagePath);
        parts.push({
          inlineData: { data: imageData.toString("base64"), mimeType: "image/png" },
        });
      }

      const result = await withTimeout(model.generateContent(parts), 60000, "Gemini");
      const text = result?.response?.text?.() || "";
      const parsed = mustJson ? safeJsonParse(text) : { text };
      if (!parsed) throw new Error("Gemini retornou JSON inválido.");
      log?.info?.("✅ Gemini respondeu.");
      return parsed;
    } catch (err) {
      lastError = err;
      log?.warn?.(`⚠️ Gemini falhou: ${err.message}`);
    }
  }

  throw new Error(`IA Offline. Último erro: ${lastError?.message || "chaves ausentes"}`);
}

module.exports = { buildClients, runLLM, safeJsonParse };
