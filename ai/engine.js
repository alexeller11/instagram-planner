const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  const prompt = `
Você é um estrategista de conteúdo de alto nível.

NICHO:
${niche}

CRIE UM CALENDÁRIO MENSAL COMPLETO (4 semanas).

REGRAS CRÍTICAS:

- Todas as 4 semanas DEVEM estar preenchidas
- Cada semana deve ter 6 posts (Seg a Sáb)
- NÃO repetir temas
- NÃO usar conteúdo genérico

PROIBIDO:
- "conheça nossa clínica"
- "nossa equipe"
- "testemunhos"
- "dicas de cuidados"
- qualquer conteúdo institucional fraco

O CONTEÚDO DEVE:
- ter conflito
- ter situação real
- gerar curiosidade
- parecer história verdadeira

ESTRUTURA:

SEMANA 1 → ATRAÇÃO (problemas, erros)
SEMANA 2 → CONEXÃO (histórias reais)
SEMANA 3 → AUTORIDADE (explicação prática)
SEMANA 4 → CONVERSÃO (prova + ação)

FORMATOS:

REELS:
- hook forte
- script com história

CARROSSEL:
- lista de slides com lógica

ESTÁTICO:
- opinião forte ou quebra de crença

CADA POST:

- day
- type
- objective
- theme
- hook

SE REELS:
- script

SE CARROSSEL:
- slides (lista)

- caption
- cta
- hashtags

EVITE REPETIR:
${memory}

RETORNE JSON COMPLETO:

{
  "month_plan": [
    {
      "week": 1,
      "focus": "atração",
      "posts": [...]
    },
    {
      "week": 2,
      "focus": "conexão",
      "posts": [...]
    },
    {
      "week": 3,
      "focus": "autoridade",
      "posts": [...]
    },
    {
      "week": 4,
      "focus": "conversão",
      "posts": [...]
    }
  ]
}
`;

  const result = await runLLM({
    clients,
    system: "Você responde apenas JSON válido e completo.",
    user: prompt
  });

  return result || { month_plan: [] };
}

module.exports = { generate };
