const { runLLM } = require("./engine");

// -----------------------------
// Utilidades de qualidade
// -----------------------------
const BANNED_PHRASES = [
  "você sabia",
  "nos dias de hoje",
  "descubra",
  "dica de ouro",
  "conteúdo de valor",
  "compartilhe com quem precisa",
  "comente sim",
  "salva esse post",
];

const SUSPICIOUS_CLAIMS = [
  "aumentou em 300%",
  "dobrou",
  "triplicou",
  "milhões",
  "garantido",
  "certeza absoluta",
];

function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeTheme(s) {
  return normalizeWhitespace(s).toLowerCase();
}

function hasBannedPhrase(text) {
  const t = String(text || "").toLowerCase();
  return BANNED_PHRASES.some((p) => t.includes(p));
}

function hasSuspiciousClaim(text) {
  const t = String(text || "").toLowerCase();
  return SUSPICIOUS_CLAIMS.some((p) => t.includes(p));
}

function uniqueRatio(arr) {
  const set = new Set(arr);
  return arr.length ? set.size / arr.length : 1;
}

function validatePosts(posts) {
  const issues = [];

  if (!Array.isArray(posts) || posts.length === 0) {
    issues.push("Sem posts gerados.");
    return issues;
  }

  // Campos mínimos
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i] || {};
    if (!p.title && !p.theme) issues.push(`Post ${i + 1}: sem title/theme`);
    if (!p.format) issues.push(`Post ${i + 1}: sem format`);
    if (!p.copy && !p.caption) issues.push(`Post ${i + 1}: sem copy/caption`);
  }

  // Anti-genérico
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i] || {};
    const text = `${p.title || p.theme || ""} ${p.copy || p.caption || ""}`;
    if (hasBannedPhrase(text)) issues.push(`Post ${i + 1}: contém frase genérica/proibida`);
    if (hasSuspiciousClaim(text)) issues.push(`Post ${i + 1}: claim suspeita (número/garantia)`);
  }

  // Anti-repetição por tema
  const themes = posts.map((p) => normalizeTheme(p.title || p.theme || ""));
  if (uniqueRatio(themes) < 0.85) issues.push("Muita repetição de temas (baixa diversidade).");

  // Distribuição de formatos (não obrigatória, mas ajuda a evitar 30 reels iguais)
  const formats = posts.map((p) => String(p.format || "").toLowerCase());
  const reelsCount = formats.filter((f) => f.includes("reel")).length;
  const carCount = formats.filter((f) => f.includes("car")).length;
  const fotoCount = formats.filter((f) => f.includes("foto") || f.includes("est") || f.includes("static")).length;

  if (reelsCount === posts.length || carCount === posts.length || fotoCount === posts.length) {
    issues.push("Só veio um formato (precisa variar entre Reels/Carrossel/Foto).");
  }

  return issues;
}

function normalizeFormatLabel(fmt) {
  const f = String(fmt || "").toLowerCase();
  if (f.includes("reel")) return "Reels";
  if (f.includes("carro") || f.includes("carousel")) return "Carrossel";
  if (f.includes("foto") || f.includes("static") || f.includes("est")) return "Foto";
  return "Reels";
}

function normalizePostsShape(posts) {
  const arr = Array.isArray(posts) ? posts : [];
  return arr.slice(0, 30).map((p, idx) => ({
    n: Number(p?.n || idx + 1),
    title: String(p?.title || p?.theme || `Post ${idx + 1}`),
    format: normalizeFormatLabel(p?.format),
    copy: String(p?.copy || p?.caption || "")
  }));
}

// -----------------------------
// Sugestões + Bio (mantido)
// -----------------------------
async function generateSuggestions({ clients, nicheHint }) {
  const prompt = `
Gere sugestões de conteúdo e opções de BIO para um Instagram de ${nicheHint || "negócios locais"}.

Regras:
- Nada genérico ("você sabia", "descubra", "dica de ouro")
- Sugestões práticas e específicas
- Sem promessas impossíveis (ex: "aumente 300%")

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

// -----------------------------
// Plano 30 dias COM FILTRO AUTO
// -----------------------------
async function generatePlan30({ clients, niche, goal, tone }) {
  const basePrompt = `
Crie um PLANO DE 30 DIAS para Instagram.

Nicho: ${niche}
Objetivo: ${goal}
Tom: ${tone}

Você deve criar 30 posts com variedade real e linguagem humana.

FORMATOS:
- 14 Reels
- 10 Carrosséis
- 6 Fotos (estático)

CADA ITEM deve ter:
- n (1..30)
- title (tema curto e específico, sem clichê)
- format ("Reels" ou "Carrossel" ou "Foto")
- copy (legenda PRONTA PARA POSTAR, com 3+ quebras de linha)

REGRAS ANTI-DELÍRIO:
- NÃO invente números (“300%”, “milhões”, “garantido”)
- NÃO prometa resultados sem contexto
- NÃO invente histórias como fatos (“um cliente perdeu milhões”) — se usar história, deixe como exemplo hipotético
- NÃO use frases genéricas ("você sabia", "descubra", "dica de ouro")

REGRAS DE QUALIDADE:
- Cada post precisa ser bem diferente (tema/ângulo/gancho)
- Comece a copy com um gancho forte (primeira linha)
- Inclua CTA natural no final (comentário, direct, salvar)

Retorne APENAS JSON:
{ "posts": [ { "n": 1, "title": "...", "format": "Reels", "copy": "..." } ] }
`.trim();

  // Tentativa 1: gerar
  let out = await runLLM({
    clients,
    system: "Responda apenas JSON válido.",
    user: basePrompt
  });

  let posts = normalizePostsShape(out?.posts);
  let issues = validatePosts(posts);

  // Tentativa 2: corrigir se tiver issues
  if (issues.length) {
    const fixPrompt = `
Você gerou um plano com problemas. Corrija e RETORNE NOVAMENTE OS 30 POSTS.

Problemas detectados:
- ${issues.join("\n- ")}

Regras obrigatórias:
- 30 posts
- 14 Reels, 10 Carrosséis, 6 Fotos
- Sem frases genéricas e sem números inventados
- Alta diversidade de temas
- Copy pronta para postar com 3+ quebras de linha

Retorne APENAS JSON no mesmo formato:
{ "posts": [ { "n": 1, "title": "...", "format": "Reels", "copy": "..." } ] }

Plano atual:
${JSON.stringify({ posts }, null, 2)}
`.trim();

    out = await runLLM({
      clients,
      system: "Responda apenas JSON válido.",
      user: fixPrompt
    });

    posts = normalizePostsShape(out?.posts);
    issues = validatePosts(posts);
  }

  // Tentativa 3: reforço final
  if (issues.length) {
    const hardPrompt = `
Última tentativa. Gere do zero um plano que passe no filtro.

Regras:
- 30 posts
- 14 Reels, 10 Carrosséis, 6 Fotos
- Sem frases genéricas (proibido: ${BANNED_PHRASES.join(", ")})
- Sem claims suspeitas (proibido: ${SUSPICIOUS_CLAIMS.join(", ")})
- Diversidade alta (sem repetir tema)
- Copy com gancho + corpo + CTA
- Tudo em PT-BR natural

Nicho: ${niche}
Objetivo: ${goal}
Tom: ${tone}

Retorne APENAS JSON:
{ "posts": [ { "n": 1, "title": "...", "format": "Reels", "copy": "..." } ] }
`.trim();

    out = await runLLM({
      clients,
      system: "Responda apenas JSON válido.",
      user: hardPrompt
    });

    posts = normalizePostsShape(out?.posts);
    issues = validatePosts(posts);
  }

  // Fallback: se ainda falhar, devolve o melhor que temos (não quebra o app)
  if (!posts.length) {
    return {
      posts: [
        {
          n: 1,
          title: "Conteúdo em ajuste",
          format: "Foto",
          copy: "Estamos refinando sua estratégia.\n\nTente novamente em instantes.\n\nSe quiser, me diga o nicho e o objetivo."
        }
      ]
    };
  }

  return { posts };
}

module.exports = {
  generateSuggestions,
  generatePlan30
};
