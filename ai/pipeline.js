const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  const prompt = `
Você é um estrategista de conteúdo que cria posts PRONTOS PARA PUBLICAÇÃO.

NICHO:
${niche}

OBJETIVO:
Criar conteúdo que:
- prenda atenção imediatamente
- gere identificação
- pareça real
- estimule ação

ESTRUTURA OBRIGATÓRIA:

Cada post deve conter:

- theme: ideia central curta
- format: reels, carrossel ou estatico

- hook: primeira frase extremamente chamativa
- caption: desenvolvimento (história, contexto ou explicação)
- cta: chamada para ação (comentário, salvar, chamar no direct, etc)
- visual_hint: sugestão de imagem ou vídeo

REGRAS IMPORTANTES:
- NÃO usar frases genéricas
- NÃO parecer propaganda
- usar situações reais do nicho
- escrever como humano, não como empresa

FORMATO POR TIPO:

REELS:
- hook forte + tensão
- caption curto

CARROSSEL:
- educativo ou explicativo
- quebrar em lógica de sequência

ESTÁTICO:
- opinião forte OU insight direto

Evite repetir:
${memory}

RETORNE APENAS JSON:

{
  "posts": [
    {
      "theme": "...",
      "format": "reels",
      "hook": "...",
      "caption": "...",
      "cta": "...",
      "visual_hint": "..."
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
