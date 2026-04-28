const { runLLM } = require("./engine");

async function generate({ clients, system, prompt, patterns, memory }) {
  return await runLLM({
    clients,
    system: `${system}

PADRÕES QUE FUNCIONAM:
${patterns}

NÃO REPETIR:
${memory}

GERAR CONTEÚDO ÚNICO E FORA DO PADRÃO.`,
    user: prompt
  });
}

module.exports = { generate };
