const { runLLM } = require("./engine");

function buildPrompt({ niche, memory, goal, tone, mix }) {
  const reels = mix?.reels ?? 4;
  const car = mix?.carousels ?? 4;
  const img = mix?.statics ?? 2;

  return `
Você é um estrategista de conteúdo de alto nível.

NICHO: ${niche}
OBJETIVO: ${goal}
TOM: ${tone}

CRIE UM CALENDÁRIO MENSAL COMPLETO (4 semanas).

REGRAS CRÍTICAS:
- Todas as 4 semanas DEVEM estar preenchidas
- Cada semana deve ter 6 posts (Seg a Sáb)
- Não repetir temas
- Sem conteúdo genérico

PROIBIDO:
- "conheça nossa clínica"
- "nossa equipe"
- "testemunhos"
- "dicas de..." (genérico)
- institucional fraco

ESTRATÉGIA DO MÊS:
SEMANA 1 → ATRAÇÃO
SEMANA 2 → CONEXÃO
SEMANA 3 → AUTORIDADE
SEMANA 4 → CONVERSÃO

FORMATO POR SEMANA (fixo para consistência):
Segunda: reels
Terça: carrossel
Quarta: reels
Quinta: carrossel
Sexta: reels
Sábado: estatico

(Se precisar aproximar o mix do pedido geral: Reels=${reels}, Carrosséis=${car}, Estáticos=${img})

CADA POST DEVE TER:
- day
- type (reels|carrossel|estatico)
- objective (engajamento|autoridade|venda)
- theme
- hook

Se REELS:
- script (fala completa, natural)

Se CARROSSEL:
- slides (lista com 5 a 8 itens)

Sempre:
- caption (legenda pronta, com 3+ quebras de linha)
- cta
- hashtags (5 a 8)

EVITE REPETIR ESTES TEMAS:
${memory}

RETORNE APENAS JSON:
{
  "month_plan": [
    { "week": 1, "focus": "atração", "posts": [] },
    { "week": 2, "focus": "conexão", "posts": [] },
    { "week": 3, "focus": "autoridade", "posts": [] },
    { "week": 4, "focus": "conversão", "posts": [] }
  ]
}
`.trim();
}

function evalPrompt(content) {
  return `
Você é um diretor criativo rigoroso.

Aprovar somente se:
- month_plan tem 4 semanas
- cada semana tem 6 posts
- sem repetição de themes
- sem conteúdo institucional fraco
- hooks fortes (nada "você sabia", "descubra", etc)

Responda APENAS JSON:
Reprovado: { "approved": false, "reason": "..." }
Aprovado: { "approved": true }

Conteúdo:
${JSON.stringify(content)}
`.trim();
}

async function generateMonthlyWithQuality({ clients, niche, memory, goal, tone, mix }) {
  let best = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log("🔁 Tentativa calendário:", attempt);

    const generated = await runLLM({
      clients,
      system: "Você responde apenas JSON puro.",
      user: buildPrompt({ niche, memory, goal, tone, mix }),
    });

    if (!generated?.month_plan) {
      best = generated;
      continue;
    }

    const evaluation = await runLLM({
      clients,
      system: "Você responde apenas JSON puro.",
      user: evalPrompt(generated),
    });

    if (evaluation?.approved === true) {
      best = generated;
      break;
    }

    console.log("⚠️ Reprovado:", evaluation?.reason || "sem motivo");
    best = generated;
  }

  if (!best?.month_plan) return { month_plan: [] };
  return best;
}

module.exports = { generateMonthlyWithQuality };
