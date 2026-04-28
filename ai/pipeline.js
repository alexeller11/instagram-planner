const { runLLM } = require("./engine");

async function generateWithPipeline({
  clients,
  system,
  prompt,
  memory,
  patterns
}) {
  const res = await runLLM({
    clients,
    system: `${system}

ANTI-REPETIÇÃO:
${memory}

PADRÕES QUE FUNCIONAM:
${patterns}

VARIAÇÃO OBRIGATÓRIA:
Cada post deve ser diferente.
`,
    user: prompt
  });

  return res || { posts: [] };
}

module.exports = { generateWithPipeline };
