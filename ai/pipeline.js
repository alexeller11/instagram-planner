const { runLLM } = require("./engine");

// =========================
// SUGESTÕES
// =========================
async function generateSuggestions({ clients, nicheHint }) {
  const prompt = `
Você é um estrategista de conteúdo.

Cliente: ${nicheHint}

Crie:
- 10 ideias de conteúdo REAIS e específicas
- 3 bios profissionais

REGRAS:
- Nada genérico
- Nada de "você sabia"
- Nada de promessa absurda

Retorne JSON:
{
  "suggestions": [],
  "bio_options": []
}
`;

  const out = await runLLM({
    clients,
    system: "Retorne apenas JSON válido",
    user: prompt
  });

  return {
    suggestions: out?.suggestions || [],
    bio_options: out?.bio_options || []
  };
}

// =========================
// PLANO 30 DIAS
// =========================
async function generatePlan30({ clients, niche, goal, tone }) {
  const prompt = `
Você é um estrategista de marketing real.

Cliente: ${niche}

Objetivo: ${goal}
Tom: ${tone}

Crie 30 posts REAIS.

FORMATOS:
- 14 Reels
- 10 Carrossel
- 6 Foto

REGRAS:
- Conteúdo deve ser realista para o negócio
- NÃO inventar histórias falsas
- NÃO usar frases genéricas
- NÃO repetir ideias

Cada post:
{
 "n":1,
 "title":"",
 "format":"",
 "copy":""
}

Retorne JSON.
`;

  const out = await runLLM({
    clients,
    system: "Retorne apenas JSON válido",
    user: prompt
  });

  let posts = Array.isArray(out?.posts) ? out.posts : [];

  // normalização
  posts = posts.slice(0, 30).map((p, i) => ({
    n: i + 1,
    title: p.title || "Post",
    format: normalizeFormat(p.format),
    copy: p.copy || ""
  }));

  return { posts };
}

function normalizeFormat(f) {
  if (!f) return "Reels";
  const x = f.toLowerCase();
  if (x.includes("reel")) return "Reels";
  if (x.includes("car")) return "Carrossel";
  return "Foto";
}

module.exports = {
  generateSuggestions,
  generatePlan30
};
