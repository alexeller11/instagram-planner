const { runLLM } = require("./engine");

// Sugestões + Bios
async function generateSuggestions({ clients, nicheHint }) {
  const prompt = `
Gere sugestões de conteúdo e opções de BIO para um Instagram de ${nicheHint || "negócios locais"}.

Regras:
- Nada genérico ("você sabia", "descubra")
- Sugestões práticas e específicas

Retorne JSON:
{
  "suggestions": ["..."],
  "bio_options": ["...", "...", "..."]
}
`.trim();

  const out = await runLLM({
    clients,
    system: "Responda apenas JSON válido.",
    user: prompt
  });

  return {
    suggestions: Array.isArray(out?.suggestions) ? out.suggestions.slice(0, 12) : [],
    bio_options: Array.isArray(out?.bio_options) ? out.bio_options.slice(0, 6) : []
  };
}

// Plano 30 dias no formato do app (d.posts[])
async function generatePlan30({ clients, niche, goal, tone }) {
  const basePrompt = `
Crie um PLANO DE 30 DIAS para Instagram.

Nicho: ${niche}
Objetivo: ${goal}
Tom: ${tone}

Preciso de 30 itens. Cada item deve ter:
- n (1..30)
- title (tema curto e específico)
- format ("Reels" ou "Carrossel" ou "Foto")
- copy (legenda pronta para postar, com 3+ quebras de linha)

Regras:
- Nada genérico
- Evitar repetir temas
- Reels: mais emocional e história
- Carrossel: educativo em tópicos (mas a legenda também pronta)

Retorne APENAS JSON:
{ "posts": [ { "n": 1, "title": "...", "format": "Reels", "copy": "..." } ] }
`.trim();

  // Tentativa 1
  let out = await runLLM({ clients, system: "Responda apenas JSON válido.", user: basePrompt });

  // Validação simples
  const ok =
    Array.isArray(out?.posts) &&
    out.posts.length >= 24; // tolerância; se vier menos, refaz 1x

  if (!ok) {
    // Tentativa 2 (mais rígida)
    const retryPrompt = basePrompt + "\n\nIMPORTANTE: Se retornar menos de 30 posts, o resultado será rejeitado. Retorne 30.";
    out = await runLLM({ clients, system: "Responda apenas JSON válido.", user: retryPrompt });
  }

  const posts = Array.isArray(out?.posts) ? out.posts : [];
  // Normalização final
  const normalized = posts
    .slice(0, 30)
    .map((p, idx) => ({
      n: Number(p?.n || idx + 1),
      title: String(p?.title || p?.theme || `Post ${idx + 1}`),
      format: normalizeFormatLabel(p?.format),
      copy: String(p?.copy || p?.caption || "")
    }));

  return { posts: normalized };
}

function normalizeFormatLabel(fmt) {
  const f = String(fmt || "").toLowerCase();
  if (f.includes("reel")) return "Reels";
  if (f.includes("carro")) return "Carrossel";
  if (f.includes("foto") || f.includes("static") || f.includes("est")) return "Foto";
  // padrão
  return "Reels";
}

module.exports = {
  generateSuggestions,
  generatePlan30
};
