const { runLLM } = require("./engine");

async function generate({ clients, system, prompt, memory }) {
  const result = await runLLM({
    clients,
    system: `${system}

ANTI-REPETIÇÃO:
${memory}

REGRAS:
- Não gerar conteúdo genérico
- Não repetir temas
- Criar posts diferentes entre si
`,
    user: prompt
  });

  return result || { posts: [] };
}

module.exports = { generate };
