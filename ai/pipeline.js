const { runLLM } = require("./engine");

async function generate({ clients, system, memory }) {

  const prompt = `
Você é um estrategista de conteúdo para redes sociais.

Nicho: OFICINA MECÂNICA (carros)

Objetivo:
Gerar conteúdo que:
- prenda atenção
- gere identificação
- mostre autoridade
- faça o cliente confiar

Crie 6 posts.

REGRAS IMPORTANTES:
- NÃO use frases genéricas (tipo "você sabia", "nos dias de hoje")
- NÃO fale de forma ampla
- Use situações reais de oficina
- Use problemas que clientes realmente vivem
- Use linguagem simples e direta

Cada post deve ter:
- theme (curto e específico)
- caption (texto envolvente)
- format (reels, carrossel ou estatico)

Exemplo de nível esperado:
- "Cliente chegou com barulho no motor e quase perdeu tudo"
- "O erro que faz seu carro consumir mais combustível sem você perceber"

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
