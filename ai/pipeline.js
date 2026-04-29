const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  // ================= GERADOR =================
  const buildPrompt = () => `
Você é um estrategista de conteúdo.

NICHO:
${niche}

Crie um calendário mensal completo (4 semanas).

REGRAS:
- 4 semanas completas
- 6 posts por semana
- sem repetição
- sem conteúdo genérico

PROIBIDO:
- "conheça nossa clínica"
- "nossa equipe"
- "testemunhos"
- "dicas de..."

ESTILO:
- conflito
- curiosidade
- situação real

RETORNE JSON:
{
  "month_plan": [...]
}
`;

  // ================= AVALIADOR =================
  const evaluatePrompt = (content) => `
Você é um diretor criativo.

Avalie o conteúdo abaixo.

CRITÉRIOS:
- originalidade
- impacto
- ausência de clichês
- variedade
- semanas completas

Se estiver RUIM, responda:
{ "approved": false, "reason": "..." }

Se estiver BOM:
{ "approved": true }

Conteúdo:
${JSON.stringify(content)}
`;

  let attempt = 0;
  let result = null;

  while (attempt < 3) {
    attempt++;

    console.log("🔁 Tentativa:", attempt);

    // 1. GERA
    const generated = await runLLM({
      clients,
      system: "Você responde apenas JSON.",
      user: buildPrompt()
    });

    if (!generated?.month_plan) continue;

    // 2. AVALIA
    const evaluation = await runLLM({
      clients,
      system: "Você responde apenas JSON.",
      user: evaluatePrompt(generated)
    });

    console.log("🧠 Avaliação:", evaluation);

    if (evaluation?.approved === true) {
      result = generated;
      break;
    }

    console.log("⚠️ Conteúdo rejeitado:", evaluation?.reason);
  }

  if (!result) {
    console.log("❌ Nenhuma tentativa passou no filtro");

    return {
      month_plan: [
        {
          week: 1,
          focus: "fallback",
          posts: [
            {
              theme: "Conteúdo em ajuste",
              caption: "Estamos refinando sua estratégia.",
              format: "estatico"
            }
          ]
        }
      ]
    };
  }

  return result;
}

module.exports = { generate };
