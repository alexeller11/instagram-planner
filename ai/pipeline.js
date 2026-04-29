const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  const prompt = `
Você é um roteirista profissional de vídeos curtos (Reels/TikTok).

NICHO:
${niche}

OBJETIVO:
Criar roteiros que:
- prendam atenção nos primeiros 3 segundos
- mantenham retenção
- gerem identificação
- incentivem ação

Crie 4 roteiros de REELS completos.

ESTRUTURA OBRIGATÓRIA:

Para cada roteiro:

- theme: ideia central
- hook: primeira frase (impactante, curiosa ou tensa)

- script: texto que a pessoa vai falar (natural, humano, direto)

- scenes: lista de cenas (ex: câmera, ação, corte)
  Exemplo:
  [
    "câmera no rosto, expressão séria",
    "corte mostrando situação",
    "aproximação no final"
  ]

- cta: chamada para ação

- editing: sugestão de edição (legenda, cortes, zoom, música)

REGRAS IMPORTANTES:
- NÃO usar frases genéricas
- NÃO parecer propaganda
- usar situações reais do nicho
- linguagem simples e natural
- parecer algo que alguém falaria de verdade

Evite repetir:
${memory}

RETORNE APENAS JSON:

{
  "posts": [
    {
      "theme": "...",
      "hook": "...",
      "script": "...",
      "scenes": ["...", "..."],
      "cta": "...",
      "editing": "..."
    }
  ]
}
`;

  const result = await runLLM({
    clients,
    system: "Você responde apenas JSON puro.",
    user: prompt
  });

  return result || { posts: [] };
}

module.exports = { generate };
