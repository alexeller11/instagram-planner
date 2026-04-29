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

function normalizeFormat(f) {
  if (!f) return "Reels";
  f = f.toLowerCase();

  if (f.includes("reel")) return "Reels";
  if (f.includes("car")) return "Carrossel";
  return "Estático";
}

async function generatePlan30({ clients, niche, goal, tone }) {

  const prompt = `
Você é um estrategista de conteúdo nível agência premium.

Cliente: ${niche}
Objetivo: ${goal}
Tom: ${tone}

MISSÃO:
Criar conteúdo que gera:
- autoridade
- conexão
- desejo
- ação

NÃO FAÇA:
- nada genérico
- nada clichê
- nada tipo "você sabia"
- nada inventado
- nada superficial

FAÇA:
- ganchos fortes (primeira linha impactante)
- situações reais do cliente
- dores reais
- linguagem humana
- conteúdo que faria alguém parar o scroll

FORMATO:

{
 "posts":[
  {
    "theme":"",
    "format":"",
    "caption":"",
    "script_or_slides":["",""],
    "visual_audio_direction":"",
    "strategic_logic":""
  }
 ]
}

REGRAS DE CONTEÚDO:

REELS:
- storytelling ou problema direto
- abertura forte
- final com CTA

CARROSSEL:
- educativo ou quebra de crença
- dividido em etapas

FOTO:
- posicionamento ou prova

IMPORTANTE:
Se for oficina:
- falar de problema mecânico real
- falar de erro comum
- falar de prejuízo evitável
- linguagem prática

NÃO FALAR:
- luxo
- estética premium
- "segredo"
- coisas irreais

Crie 30 conteúdos diferentes.
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
      p.visual_audio_direction || "Gravação simples com especialista",
    strategic_logic: p.strategic_logic || ""
  }));

  // fallback
  if (!posts.length) {
    posts = Array.from({ length: 12 }).map((_, i) => ({
      n: i + 1,
      theme: `Conteúdo estratégico ${i + 1}`,
      format: i % 3 === 0 ? "Reels" : i % 2 === 0 ? "Carrossel" : "Estático",
      caption: "Conteúdo em construção",
      script_or_slides: ["Gancho", "Conteúdo", "CTA"],
      visual_audio_direction: "Gravação simples",
      strategic_logic: "Fallback"
    }));
  }

  return { posts };
}

module.exports = {
  generatePlan30
};
