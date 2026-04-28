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

ANTI-GENERICIDADE:
- não repetir temas
- não fazer conteúdo padrão

TEMAS PROIBIDOS:
${memory}

BASEADO NO QUE FUNCIONA:
${patterns}
`,
    user: prompt
  });

  return res || { posts: [] };
}

module.exports = { generateWithPipeline };
