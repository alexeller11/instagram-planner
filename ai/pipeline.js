const { runLLM } = require("./engine");

async function generate({ clients, system, prompt, memory }) {
  const fullPrompt = `
${system}

TEMAS JÁ USADOS:
${memory}

TAREFA:
${prompt}

FORMATO DE RESPOSTA (OBRIGATÓRIO):
Responda apenas JSON válido, sem texto antes ou depois.

Exemplo:
{
  "posts": [
    {
      "theme": "Tema do post",
      "caption": "Texto do post",
      "format": "reels"
    }
  ]
}

REGRAS:
- NÃO escreva explicações
- NÃO escreva texto fora do JSON
- NÃO use markdown
`;

  const res = await runLLM({
    clients,
    system: "Você responde apenas JSON puro.",
    user: fullPrompt
  });

  return res || { posts: [] };
}

module.exports = { generate };
