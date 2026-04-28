const { runLLM } = require("./engine");

const HUMAN_VOICE = `
- Escreva como humano real
- Frases curtas + ritmo variado
- Pode usar "..." e pausas naturais
- Proibido: "nos dias de hoje", "você sabia", "é importante"
- Sem CTA forçado
`;

function stringify(obj) {
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
  let strategy, draft, humanized;

  try {
    // 1. Estratégia
    strategy = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.7,
      system: `${combinedSystem}
Você é estrategista. Retorne JSON:
{ "angle": "", "structure": [] }`,
      user: userPrompt
    });

    // 2. Escrita
    draft = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.85,
      system: `${combinedSystem}
Você é copywriter. Use a estratégia:
${stringify(strategy)}

Retorne JSON completo.`,
      user: userPrompt
    });

    // 3. Humanização
    humanized = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.9,
      system: `${combinedSystem}
Você é editor humano.
${HUMAN_VOICE}

Reescreva mantendo JSON.`,
      user: stringify(draft)
    });

  } catch (err) {
    log.error("Pipeline error:", err.message);
  }

  // 🔥 Fallback inteligente
  const safeOutput =
    (humanized && humanized.posts) ? humanized :
    (draft && draft.posts) ? draft :
    { posts: [] };

  return { strategy, output: safeOutput };
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
    const res = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.85,
      system: combinedSystem,
      user: `
Gere ${count} posts no formato ${format}.

CONTEXTO:
${context}

Retorne JSON:
{ "posts": [] }
`
    });

    return res || { posts: [] };

  } catch (err) {
    log.error("Missing batch error:", err.message);
    return { posts: [] };
  }
}

module.exports = {
  generateWithPipeline,
  generateMissingBatch
};
