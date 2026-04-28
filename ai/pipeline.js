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

/**
 * ✅ NOVO (Premium): gera APENAS posts faltantes em lote, já no formato correto,
 * e passa por uma etapa rápida de humanização para evitar texto robótico.
 *
 * Retorna:
 * { posts: [...] }
 */
async function generateMissingBatch({
  clients,
  log,
  combinedSystem,
  accountUsername,
  niche,
  audience,
  goal,
  tone,
  timings,
  count,
  format, // "reels" | "carrossel" | "estatico"
  hookLibrary = [],
}) {
  const formatLabel =
    format === "reels" ? "REELS" : format === "carrossel" ? "CARROSSEL" : "ESTÁTICO";

  const hooksText = (hookLibrary || []).slice(0, 5).map((h, i) => `${i + 1}. ${h}`).join("\n");

  const writer = await runLLM({
    clients,
    log,
    temperature: 0.85,
    maxTokens: 3500,
    json: true,
    system: `${combinedSystem}
Você é um COPYWRITER e PLANNER tático.

Tarefa: gerar exatamente ${count} posts no formato ${formatLabel} para @${accountUsername}.
Siga as regras do app.

REGRAS:
- Retorne JSON com { "posts": [...] }
- Cada post deve ter:
  n (número), week_funnel (texto), format, theme, posting_suggestion,
  visual_audio_direction (30+ palavras),
  script_or_slides (5-7 itens, 25+ palavras cada),
  caption (100-200 palavras, 3+ quebras),
  strategic_logic, expected_metric
- format deve ser EXATAMENTE: "${format}"
- Não gere menos e não gere mais.

Contexto:
Nicho: ${niche || "Geral"}
Público: ${audience || "Geral"}
Tom: ${tone || "profissional"}
Objetivo: ${goal || "engajamento"}
Melhores dias: ${timings?.days || "-"} | Horários: ${timings?.times || "-"}

Biblioteca de ganchos (use e adapte):
${hooksText || "-"}`
    ,
    user: `Gere ${count} posts no formato ${formatLabel}.`,
  });

  // Humaniza o lote
  const humanized = await runLLM({
    clients,
    log,
    temperature: 0.9,
    maxTokens: 3500,
    json: true,
    system: `${combinedSystem}
Você é um EDITOR HUMANO.
Reescreva APENAS textos (caption, script_or_slides, visual_audio_direction, strategic_logic) para soar humano.
${HUMAN_VOICE}

Entrada: JSON com posts.
Saída: o MESMO JSON.`,
    user: `JSON para refino:\n${stringify(writer)}`,
  });

  const posts = Array.isArray(humanized?.posts) ? humanized.posts : [];
  return { posts };
}

module.exports = { generateWithPipeline, generateMissingBatch };
