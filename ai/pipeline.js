// pipeline.js

function normalizeFormat(f) {
  if (!f) return "Reels";
  f = f.toLowerCase();

  if (f.includes("reel")) return "Reels";
  if (f.includes("carrossel")) return "Carrossel";
  if (f.includes("carousel")) return "Carrossel";
  return "Estático";
}

async function runLLM({ clients, system, user }) {
  for (const c of clients) {
    try {
      const res = await c(system, user);
      if (res) return res;
    } catch (e) {
      console.log("IA falhou:", e.message);
    }
  }
  return null;
}

async function generatePlan30({ clients, niche, goal, tone }) {
  const prompt = `
Você é um estrategista de marketing de alto nível.

Cliente/Nicho: ${niche}
Objetivo: ${goal}
Tom: ${tone}

IMPORTANTE:
- Nada genérico
- Nada clichê
- Nada superficial
- Conteúdo aplicável ao nicho real
- Não inventar histórias fake

Crie 30 posts estratégicos.

Formato JSON:

{
  "posts":[
    {
      "n":1,
      "theme":"",
      "format":"Reels | Carrossel | Estático",
      "caption":"",
      "script_or_slides":["",""],
      "visual_audio_direction":"",
      "strategic_logic":""
    }
  ]
}
`;

  const out = await runLLM({
    clients,
    system: "Responda apenas JSON válido",
    user: prompt
  });

  let posts = Array.isArray(out?.posts) ? out.posts : [];

  posts = posts.slice(0, 30).map((p, i) => ({
    n: i + 1,
    theme: p.theme || "Conteúdo estratégico",
    format: normalizeFormat(p.format),
    caption: p.caption || "",
    script_or_slides: p.script_or_slides || [
      "Gancho forte",
      "Desenvolvimento",
      "Chamada para ação"
    ],
    visual_audio_direction:
      p.visual_audio_direction || "Vídeo direto com especialista",
    strategic_logic: p.strategic_logic || ""
  }));

  // fallback caso IA falhe
  if (!posts.length) {
    posts = Array.from({ length: 12 }).map((_, i) => ({
      n: i + 1,
      theme: `Conteúdo estratégico ${i + 1}`,
      format: i % 3 === 0 ? "Reels" : i % 2 === 0 ? "Carrossel" : "Estático",
      caption: "Conteúdo em construção",
      script_or_slides: ["Gancho", "Conteúdo", "CTA"],
      visual_audio_direction: "Gravação simples",
      strategic_logic: "Fallback automático"
    }));
  }

  return { posts };
}

module.exports = {
  generatePlan30
};
