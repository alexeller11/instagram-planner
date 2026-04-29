const { runLLM } = require("./engine");

async function generate({ clients, system, prompt, memory }) {
  const fullPrompt = `
${system}

TEMAS JÁ USADOS:
${memory}

TAREFA:
${prompt}

RETORNE APENAS JSON VÁLIDO.

FORMATO:
{
  "posts": [
    {
      "theme": "tema",
      "caption": "texto",
      "format": "reels"
    }
  ]
}

REGRAS:
- NÃO escreva texto fora do JSON
- NÃO use markdown
- NÃO explique nada
`;

  const result = await runLLM({
    clients,
    system: "Você é um gerador de JSON puro.",
    user: fullPrompt
  });

  return result || { posts: [] };
}

module.exports = { generate };
