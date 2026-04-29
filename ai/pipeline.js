const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  const prompt = `
Você é um estrategista de conteúdo profissional.

NICHO:
${niche}

OBJETIVO:
Criar um calendário MENSAL (4 semanas) inteligente para Instagram.

ESTRATÉGIA DO MÊS:

SEMANA 1 → ATRAÇÃO (chamar atenção)
SEMANA 2 → CONEXÃO (gerar identificação)
SEMANA 3 → AUTORIDADE (provar conhecimento)
SEMANA 4 → CONVERSÃO (levar para ação)

CADA SEMANA DEVE TER:

- 3 reels
- 2 carrosséis
- 1 post estático

DISTRIBUIÇÃO:
Segunda: reels
Terça: carrossel
Quarta: reels
Quinta: carrossel
Sexta: reels
Sábado: estatico

CADA POST DEVE TER:

- day
- type (reels | carrossel | estatico)
- objective (engajamento, autoridade, venda)

- theme
- hook

SE FOR REELS:
- script

SE FOR CARROSSEL:
- slides (lista de ideias por slide)

- caption (legenda completa com storytelling)
- cta
- hashtags (5 a 8)

REGRAS IMPORTANTES:
- NÃO ser genérico
- NÃO parecer propaganda
- usar situações reais do nicho
- linguagem humana

Evitar repetir:
${memory}

RETORNE APENAS JSON:

{
  "month_plan": [
    {
      "week": 1,
      "focus": "atração",
      "posts": []
    }
  ]
}
`;

  const result = await runLLM({
    clients,
    system: "Você responde apenas JSON puro.",
    user: prompt
  });

  return result || { month_plan: [] };
}

module.exports = { generate };
