const { runLLM } = require("./engine");

function safeJson(obj) {
  try { return JSON.stringify(obj, null, 2); }
  catch { return String(obj); }
}

async function generateWithPipeline({
  clients,
  log,
  combinedSystem,
  userPrompt,
  memoryContext
}) {
  let draft = null;

  try {
    draft = await runLLM({
      clients,
      log,
      json: true,
      temperature: 0.9,
      maxTokens: 3500,
      system: `${combinedSystem}

ANTI-REPETIÇÃO:
Nunca repetir temas já usados:
${memoryContext}

DIVERSIDADE:
Cada post deve ser completamente diferente.

Se parecer genérico → reescreva.`,
      user: userPrompt
    });

  } catch (err) {
    log.error("Pipeline error:", err.message);
  }

  if (!draft || !draft.posts) {
    return { output: { posts: [] } };
  }

  return { output: draft };
}

module.exports = { generateWithPipeline };
