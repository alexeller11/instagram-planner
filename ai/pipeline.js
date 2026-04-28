const { runLLM } = require("./engine");

const HUMAN_VOICE = `
- Escreva como humano real
- Frases curtas + variação de ritmo
- Pode usar pausas naturais (...)
- Proibido: "nos dias de hoje", "você sabia", "é importante"
- Sem CTA forçado
`;

function safeJson(obj) {
  try { return JSON.stringify(obj, null, 2); }
  catch { return String(obj); }
}

async function generateWithPipeline({
  clients,
  log,
  combinedSystem,
  userPrompt,
  formatHint,
}) {
  let strategy = null;
  let draft = null;
  let humanized = null;

  try {
    // ========================
    // 1. STRATEGY
    // ========================
    strategy = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.7,
      maxTokens: 1200,
      system: `${combinedSystem}

Você é um estrategista de conteúdo.

Retorne JSON:
{
  "angle": "ângulo principal",
  "structure": ["parte1", "parte2"]
}`,
      user: userPrompt,
    });

    // ========================
    // 2. WRITER
    // ========================
    draft = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.85,
      maxTokens: 3500,
      system: `${combinedSystem}

Você é um copywriter.

Use essa estratégia:
${safeJson(strategy)}

Retorne JSON completo no padrão do sistema.`,
      user: userPrompt,
    });

    // ========================
    // 3. HUMANIZER
    // ========================
    humanized = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.9,
      maxTokens: 3500,
      system: `${combinedSystem}

Você é um editor humano.

${HUMAN_VOICE}

Reescreva apenas os textos mantendo o JSON.`,
      user: safeJson(draft),
    });

  } catch (err) {
    log.error("❌ Pipeline error:", err.message);
  }

  // ========================
  // 🔥 FALLBACK INTELIGENTE
  // ========================
  let output = null;

  if (humanized && Array.isArray(humanized.posts)) {
    output = humanized;
  } else if (draft && Array.isArray(draft.posts)) {
    output = draft;
  } else {
    output = { posts: [] };
  }

  return {
    strategy,
    output
  };
}

async function generateMissingBatch({
  clients,
  log,
  combinedSystem,
  count,
  format,
  context
}) {
  try {
    const result = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.85,
      maxTokens: 3000,
      system: combinedSystem,
      user: `
Gere exatamente ${count} posts no formato ${format}.

CONTEXTO:
${context}

REGRAS:
- Não repetir ideias
- Não ser genérico
- Não usar manutenção como padrão

JSON:
{ "posts": [] }
`
    });

    if (result && Array.isArray(result.posts)) {
      return result;
    }

    return { posts: [] };

  } catch (err) {
    log.error("❌ Missing batch error:", err.message);
    return { posts: [] };
  }
}

module.exports = {
  generateWithPipeline,
  generateMissingBatch
};
