const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  // 🔹 1. GERAÇÃO BRUTA
  const basePrompt = `
Crie 6 ideias de posts para o nicho: ${niche}

Evite:
- genérico
- clichês
- frases prontas

Retorne JSON:
{
  "posts": [
    {
      "theme": "...",
      "caption": "...",
      "format": "reels"
    }
  ]
}
`;

  const base = await runLLM({
    clients,
    system: "Você gera ideias de conteúdo.",
    user: basePrompt
  });

  if (!base?.posts?.length) return { posts: [] };

  // 🔥 2. REFINAMENTO (AQUI MUDA TUDO)
  const refinePrompt = `
Reescreva esses posts para nível agência premium.

REGRAS:
- mais impacto
- mais específico
- mais humano
- menos genérico
- parecer história real

Posts:
${JSON.stringify(base.posts)}

Retorne JSON no mesmo formato.
`;

  const refined = await runLLM({
    clients,
    system: "Você melhora conteúdo para alto impacto.",
    user: refinePrompt
  });

  return refined || base;
}

module.exports = { generate };
