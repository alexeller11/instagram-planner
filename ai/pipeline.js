// ai/pipeline.js
const { runLLM } = require("./engine");

function safeArray(x) { return Array.isArray(x) ? x : []; }
function asStr(x) { return String(x ?? "").trim(); }

function hasGeneric(text) {
  const t = String(text || "").toLowerCase();
  const banned = ["você sabia", "descubra", "dica de ouro", "nos dias de hoje", "clique no link da bio", "segredo"];
  return banned.some(w => t.includes(w));
}

function dedupeByTheme(posts) {
  const seen = new Set();
  const out = [];
  for (const p of posts) {
    const key = (p.theme || "").toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function normalizeFormat(f) {
  const x = String(f || "").toLowerCase();
  if (x.includes("reel")) return "Reels";
  if (x.includes("car")) return "Carrossel";
  return "Estático";
}

async function llmJSON(clients, prompt) {
  return await runLLM({
    clients,
    system: "Responda APENAS JSON válido. Sem markdown. Sem texto fora do JSON.",
    user: prompt
  });
}

/** DASHBOARD 360 */
async function dashboard360({ clients, niche, username }) {
  const prompt = `
Você é um estrategista sênior de Instagram (nível agência premium).

Conta: @${username}
Nicho: ${niche}

Entregue:
- 3 opções de BIO (autoridade, conexão, conversão)
- 6 melhorias objetivas do perfil
- 4 pilares editoriais (com explicação curta)
- 1 posicionamento (frase-mestre)

Regras:
- Nada genérico
- Nada de "você sabia"
- Linguagem humana e direta

JSON:
{
  "bio": ["...","...","..."],
  "melhorias": ["..."],
  "pilares": [{"nome":"...","por_que":"..."}],
  "posicionamento":"..."
}
`.trim();

  const out = await llmJSON(clients, prompt);
  return {
    bio: safeArray(out?.bio).slice(0,3),
    melhorias: safeArray(out?.melhorias).slice(0,8),
    pilares: safeArray(out?.pilares).slice(0,6),
    posicionamento: asStr(out?.posicionamento)
  };
}

/** DIAGNÓSTICO */
async function diagnostico({ clients, niche, username }) {
  const prompt = `
Você é um consultor de crescimento para Instagram.

Conta: @${username}
Nicho: ${niche}

Faça um diagnóstico (sem inventar métricas):
- 8 problemas prováveis (bem específicos)
- 8 oportunidades (bem específicas)
- 10 ações (executáveis) para 14 dias

JSON:
{
  "problemas": ["..."],
  "oportunidades": ["..."],
  "acoes_14_dias": ["..."]
}
`.trim();

  const out = await llmJSON(clients, prompt);
  return {
    problemas: safeArray(out?.problemas).slice(0,10),
    oportunidades: safeArray(out?.oportunidades).slice(0,10),
    acoes_14_dias: safeArray(out?.acoes_14_dias).slice(0,14),
  };
}

/** PLANO MENSAL (30 posts) */
async function planoMensal({ clients, niche, username, goal, mix }) {
  const reels = Number(mix?.reels ?? 14);
  const car = Number(mix?.carrosseis ?? 10);
  const est = Number(mix?.estaticos ?? 6);

  const prompt = `
Você é um estrategista de conteúdo (nível agência premium).

Conta: @${username}
Nicho: ${niche}
Objetivo do mês: ${goal}

Crie 30 posts PRONTOS PARA POSTAR.
Distribuição: ${reels} Reels, ${car} Carrosséis, ${est} Estáticos (Foto).

Regras obrigatórias:
- Não inventar serviços fora do nicho
- Não usar frases genéricas ("você sabia", "descubra", "segredo", "link na bio")
- Cada post deve ser diferente (ângulo/tema/gancho)
- Reels: roteiro em 4-7 linhas
- Carrossel: slides (5-8 títulos curtos)
- Estático: 3 bullets de apoio

JSON:
{
  "posts":[
    {
      "n": 1,
      "theme":"...",
      "format":"Reels|Carrossel|Estático",
      "caption":"...",
      "script_or_slides":["..."],
      "visual_audio_direction":"...",
      "strategic_logic":"..."
    }
  ]
}
`.trim();

  // tentativa 1
  let out = await llmJSON(clients, prompt);
  let posts = safeArray(out?.posts).map((p,i)=>({
    n: Number(p?.n ?? i+1),
    theme: asStr(p?.theme || `Post ${i+1}`),
    format: normalizeFormat(p?.format),
    caption: asStr(p?.caption),
    script_or_slides: safeArray(p?.script_or_slides).length ? safeArray(p?.script_or_slides) : ["Gancho", "Conteúdo", "CTA"],
    visual_audio_direction: asStr(p?.visual_audio_direction || "Câmera no rosto + legenda dinâmica"),
    strategic_logic: asStr(p?.strategic_logic || goal)
  }));

  // filtro mínimo
  posts = posts.filter(p => p.caption && !hasGeneric(p.caption) && p.theme);
  posts = dedupeByTheme(posts);

  // tentativa 2 se veio ruim
  if (posts.length < 20) {
    const retryPrompt = prompt + "\n\nIMPORTANTE: a resposta anterior foi rejeitada por ser genérica/repetitiva. Gere novamente mais específico.";
    out = await llmJSON(clients, retryPrompt);
    posts = safeArray(out?.posts).map((p,i)=>({
      n: Number(p?.n ?? i+1),
      theme: asStr(p?.theme || `Post ${i+1}`),
      format: normalizeFormat(p?.format),
      caption: asStr(p?.caption),
      script_or_slides: safeArray(p?.script_or_slides).length ? safeArray(p?.script_or_slides) : ["Gancho", "Conteúdo", "CTA"],
      visual_audio_direction: asStr(p?.visual_audio_direction || "Câmera no rosto + legenda dinâmica"),
      strategic_logic: asStr(p?.strategic_logic || goal)
    }));
    posts = posts.filter(p => p.caption && !hasGeneric(p.caption) && p.theme);
    posts = dedupeByTheme(posts);
  }

  // fallback final (não quebra UI)
  if (posts.length === 0) {
    posts = Array.from({length:12}).map((_,i)=>({
      n:i+1,
      theme:`Conteúdo ${i+1} (@${username})`,
      format: i%3===0?"Reels":i%3===1?"Carrossel":"Estático",
      caption:`Gancho forte aqui.\n\nCorpo do texto específico para ${niche}.\n\nCTA: Comenta "QUERO" que eu te mando os detalhes.`,
      script_or_slides:["Gancho","Ponto 1","Ponto 2","CTA"],
      visual_audio_direction:"Câmera no rosto + texto na tela",
      strategic_logic: goal
    }));
  }

  return { posts: posts.slice(0,30) };
}

/** CONCORRÊNCIA (IA — sem scraping pesado) */
async function concorrencia({ clients, niche, city }) {
  const prompt = `
Você é um estrategista competitivo (Instagram).

Nicho: ${niche}
Cidade/Região: ${city}

Sem buscar na internet, faça uma análise estratégica baseada em padrões reais de mercado:
- 5 perfis concorrentes "arquétipos" (ex: 'Oficina A focada em preço', etc)
- o que eles fazem bem
- onde normalmente falham
- como ganhar deles em 30 dias (plano em 6 pontos)

JSON:
{
  "concorrentes": [{"nome":"...","perfil":"..."}],
  "o_que_fazem_bem": ["..."],
  "onde_falham": ["..."],
  "plano_para_ganhar": ["..."]
}
`.trim();

  const out = await llmJSON(clients, prompt);
  return {
    concorrentes: safeArray(out?.concorrentes).slice(0,6),
    o_que_fazem_bem: safeArray(out?.o_que_fazem_bem).slice(0,8),
    onde_falham: safeArray(out?.onde_falham).slice(0,8),
    plano_para_ganhar: safeArray(out?.plano_para_ganhar).slice(0,8),
  };
}

module.exports = {
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
};
