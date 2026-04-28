const { runLLM } = require("./engine");

async function generate({ clients, system, prompt, memory }) {
  const combinedSystem = `${system}

ANTI-REPETIÇÃO:
${memory}

REGRAS:
- Não gerar conteúdo genérico
- Não repetir temas
- Criar posts diferentes entre si

Saída obrigatória em JSON:
{ "posts": [ { "theme": "...", "caption": "...", "format": "reels|carrossel|estatico" } ] }
`;

  const res = await runLLM({
    clients,
    system: combinedSystem,
    user: prompt
  });

  return res || { posts: [] };
}

module.exports = { generate };
