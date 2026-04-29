const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  const prompt = `
Você é um estrategista de conteúdo e social media.

NICHO:
${niche}

OBJETIVO:
Criar um calendário semanal completo para Instagram.

ESTRATÉGIA:
- 3 reels (alcance e conexão)
- 2 carrosséis (valor e autoridade)
- 1 post estático (posicionamento)

DISTRIBUIÇÃO:
Segunda: reels
Terça: carrossel
Quarta: reels
Quinta: carrossel
Sexta: reels
Sábado: estático

CADA POST DEVE TER:

- day: dia da semana
- type: reels | carrossel | estatico
- objective: (engajamento, autoridade, venda)

- theme: ideia central
- hook: frase inicial forte

SE FOR REELS:
- script: fala completa

SE FOR CARROSSEL:
- slides: lista com ideias de cada slide

- caption: legenda pronta (com storytelling)
- cta: chamada para ação
- hashtags: 5 a 8 hashtags relevantes

REGRAS IMPORTANTES:
- NÃO usar frases genéricas
- NÃO parecer propaganda
- usar situações reais do nicho
- linguagem simples e humana

Evitar repetir:
${memory}

RETORNE APENAS JSON:

{
  "calendar": [
    {
      "day": "Segunda",
      "type": "reels",
      "objective": "engajamento",
      "theme": "...",
      "hook": "...",
      "script": "...",
      "caption": "...",
      "cta": "...",
      "hashtags": ["...", "..."]
    }
  ]
}
`;

  const result = await runLLM({
    clients,
    system: "Você responde apenas JSON puro.",
    user: prompt
  });

  return result || { calendar: [] };
}

module.exports = { generate };
