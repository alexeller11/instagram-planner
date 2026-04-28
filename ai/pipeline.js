const { runLLM } = require("./engine");

const HUMAN_VOICE = `DIRETRIZES DE VOZ HUMANA (aplique no texto final):
- Escreva como um humano de verdade, não como "copy perfeita".
- Ritmo: frases curtas + uma frase mais longa (mistura).
- Pausas naturais: "..." e travessão — quando fizer sentido.
- Pode começar com "E" / "Mas" (sem exagero).
- Proibido: "Com certeza!", "Absolutamente!", "Nos dias de hoje", "É importante ressaltar".
- Sem CTA mendigo ("comenta SIM", "salva esse post"). CTA tem que ser consequência, não pedido.
- Se soar como PowerPoint, reescreva.`;

function stringify(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

/**
 * Pipeline 3 etapas:
 * 1) Strategy: define ângulo/estrutura
 * 2) Writer: escreve a peça no formato esperado (JSON)
 * 3) Humanizer: refina textos mantendo o mesmo JSON
 */
async function generateWithPipeline({
  clients,
  log,
  combinedSystem,
  userPrompt,
  formatHint,
}) {
  // 1) Strategy
  const strategy = await runLLM({
    clients,
    log,
    temperature: 0.75,
    maxTokens: 1200,
    json: true,
    system: `${combinedSystem}
Você vai atuar como ESTRATEGISTA.
Defina o melhor ângulo e estrutura para o conteúdo.
Responda em JSON:
{ "angle": "...", "format": "...", "hook": "...", "structure": ["...","..."], "do": ["..."], "dont": ["..."] }`,
    user: `Pedido: ${userPrompt}\nFormato sugerido: ${formatHint || "auto"}`,
  });

  // 2) Writer
  const draft = await runLLM({
    clients,
    log,
    temperature: 0.85,
    maxTokens: 3500,
    json: true,
    system: `${combinedSystem}
Você vai atuar como COPYWRITER.
Use a estratégia abaixo e produza o resultado FINAL em JSON no formato esperado pelo app.

Estratégia (JSON):
${stringify(strategy)}`,
    user: userPrompt,
  });

  // 3) Humanizer
  const humanized = await runLLM({
    clients,
    log,
    temperature: 0.9,
    maxTokens: 3500,
    json: true,
    system: `${combinedSystem}
Você vai atuar como EDITOR HUMANO.
Objetivo: reescrever APENAS textos (legendas, roteiros, copies) para soar humano e natural.
Não mude o sentido, não invente fatos, não altere números.
${HUMAN_VOICE}

Entrada: JSON do conteúdo.
Saída: o MESMO JSON, com os textos refinados.`,
    user: `JSON para refino:\n${stringify(draft)}`,
  });

  return { strategy, output: humanized };
}

module.exports = { generateWithPipeline };
