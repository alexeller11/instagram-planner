const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  const prompt = `
Você é um estrategista de conteúdo.

NICHO DO CLIENTE:
${niche}

OBJETIVO:
Criar conteúdo que gere:
- atenção
- identificação
- autoridade
- confiança

REGRAS:
- NÃO seja genérico
- NÃO use frases clichê
- use situações reais do nicho
- fale como alguém do mercado falaria

Crie 6 posts.

Cada post deve ter:
- theme (curto e específico)
- caption (envolvente e direto)
- format (reels, carrossel ou estatico)

Evite repetir temas:
${memory}

Retorne apenas JSON:
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

  const result = await runLLM({
    clients,
    system: "Você responde apenas JSON puro.",
    user: prompt
  });

  return result || { posts: [] };
}

module.exports = { generate };
