const { runLLM } = require("./engine");

function buildPrompt({ niche, memory }) {
  return `
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
- "dicas de..."
- conteúdo institucional fraco

ESTILO:
- conflito
- curiosidade
- situação real
- linguagem humana

SEMANA 1 → ATRAÇÃO
SEMANA 2 → CONEXÃO
SEMANA 3 → AUTORIDADE
SEMANA 4 → CONVERSÃO

FORMATO DE CADA POST:
- day
- type (reels|carrossel|estatico)
- objective (engajamento|autoridade|venda)
- theme
- hook
- se reels: script
- se carrossel: slides (lista)
- caption
- cta
- hashtags (5 a 8)

EVITE REPETIR ESTES TEMAS:
${memory}

RETORNE APENAS JSON NO FORMATO:
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

Aponte se o conteúdo está aprovado.

Critérios (reprovar se falhar em qualquer):
- month_plan tem 4 semanas
- cada semana tem 6 posts
- não repetiu temas
- não tem conteúdo institucional fraco
- hooks fortes, sem clichê

Responda APENAS JSON:
Se reprovado: { "approved": false, "reason": "..." }
Se aprovado: { "approved": true }
Conteúdo:
${JSON.stringify(content)}
`.trim();
}

async function generate({ clients, niche, memory }) {
  let best = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log("🔁 Tentativa:", attempt);

    const generated = await runLLM({
      clients,
      system: "Você responde apenas JSON puro.",
      user: buildPrompt({ niche, memory }),
    });

    if (!generated?.month_plan) continue;

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
    best = generated; // guarda o melhor que temos
  }

  if (!best?.month_plan) return { month_plan: [] };
  return best;
}

module.exports = { generate };
