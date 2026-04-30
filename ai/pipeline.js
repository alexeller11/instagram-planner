const { runLLM } = require("./engine");

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function cleanText(x) {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (Array.isArray(x)) return x.map(cleanText).join(" ").trim();
  if (typeof x === "object") return Object.values(x).map(cleanText).join(" ").trim();
  return String(x).trim();
}

function uniqueStrings(arr = []) {
  const seen = new Set();
  return arr.filter((item) => {
    const key = cleanText(item).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function ask(clients, prompt) {
  return await runLLM({
    clients,
    system: `
Você responde SOMENTE JSON válido.
Sem markdown.
Sem blocos de código.
Sem comentários.
Sem texto antes ou depois do JSON.

Você é um estrategista sênior de conteúdo para Instagram no Brasil, trabalhando em uma agência de publicidade de alto nível.
Escreve como um profissional experiente, criativo e focado em performance.
Nada de clichês.
Nada de frases genéricas de marketing.
Nada de conteúdo para gestão interna da empresa, a menos que isso tenha valor claro para a audiência do perfil.
O conteúdo deve ser pensado para quem consome o perfil, gerando desejo, autoridade ou conexão.
`.trim(),
    user: prompt
  });
}

function sanitizePost(post, index, fallbackGoal) {
  const score = Number(post?.viral_score?.score ?? 0);

  return {
    theme: cleanText(post?.theme || `Post ${index + 1}`),
    format: ["Reels", "Carrossel", "Foto"].includes(cleanText(post?.format))
      ? cleanText(post?.format)
      : "Reels",
    hook: cleanText(post?.hook),
    script_or_slides: safeArray(post?.script_or_slides).map(cleanText).filter(Boolean),
    caption: cleanText(post?.caption),
    creative_direction: cleanText(post?.creative_direction),
    goal: cleanText(post?.goal || fallbackGoal),
    viral_score: {
      score: Math.max(0, Math.min(10, score)),
      reason: cleanText(post?.viral_score?.reason)
    }
  };
}

/**
 * Removido o viés de nicho fixo (oficina). 
 * Agora o filtro é focado em qualidade e evitar conteúdo puramente institucional/interno.
 */
function looksBad(post) {
  const text = [
    post.theme,
    post.hook,
    post.caption,
    ...(post.script_or_slides || [])
  ].join(" ").toLowerCase();

  const bannedTerms = [
    "gestão interna",
    "equipe motivada",
    "produtividade interna",
    "funcionários felizes",
    "excelência",
    "dicas imperdíveis",
    "história de sucesso",
    "serviços oferecidos"
  ];

  return bannedTerms.some(term => text.includes(term));
}

async function analisarCliente({
  clients,
  brandName,
  username,
  niche,
  targetAudience,
  audiencePainPoints,
  brandTone,
  offer,
  city,
  contentPillars
}) {
  const prompt = `
Faça uma leitura estratégica do cliente abaixo.

Dados disponíveis:
- Marca: ${brandName}
- Username: ${username}
- Nicho informado: ${niche}
- Cidade/base: ${city}
- Oferta principal: ${offer}
- Público-alvo informado: ${targetAudience}
- Dores informadas: ${safeArray(audiencePainPoints).join(", ")}
- Tom da marca: ${brandTone}
- Pilares de conteúdo: ${safeArray(contentPillars).join(", ")}

Tarefas:
1) Confirmar ou refinar o nicho do perfil (seja específico, ex: "Estética Avançada" em vez de "Beleza").
2) Descrever a audiência real (quem compra e por que compra).
3) Listar dores, desejos e objeções profundas (não óbvias).
4) Explicar o que esse perfil deveria comunicar para ser desejado.
5) Definir ângulos editoriais criativos para agência.

Regras:
- Trabalhe com raciocínio plausível e prático.
- Nada genérico. Nada de linguagem vazia.

JSON:
{
  "niche_analysis": "string",
  "audience_summary": "string",
  "pain_points": ["string"],
  "desires": ["string"],
  "objections": ["string"],
  "positioning_focus": ["string"],
  "content_angles": ["string"]
}
`.trim();

  const d = await ask(clients, prompt);

  return {
    niche_analysis: cleanText(d?.niche_analysis),
    audience_summary: cleanText(d?.audience_summary),
    pain_points: uniqueStrings(safeArray(d?.pain_points).map(cleanText)).slice(0, 6),
    desires: uniqueStrings(safeArray(d?.desires).map(cleanText)).slice(0, 6),
    objections: uniqueStrings(safeArray(d?.objections).map(cleanText)).slice(0, 6),
    positioning_focus: uniqueStrings(safeArray(d?.positioning_focus).map(cleanText)).slice(0, 6),
    content_angles: uniqueStrings(safeArray(d?.content_angles).map(cleanText)).slice(0, 8)
  };
}

async function dashboard360({ clients, clientData, analysis }) {
  const prompt = `
Cliente: ${JSON.stringify(clientData, null, 2)}
Análise: ${JSON.stringify(analysis, null, 2)}

Crie um dashboard estratégico. 
Entregue:
1) 3 bios fortes (Máximo 150 caracteres cada).
2) 6 melhorias de perfil (Bio, Destaques, Foto, Link).
3) 1 posicionamento claro de mercado.
4) 4 insights para a agência dominar o nicho do cliente.

JSON:
{
  "bio": ["string"],
  "melhorias": ["string"],
  "posicionamento": "string",
  "insights": ["string"]
}
`.trim();

  const d = await ask(clients, prompt);

  return {
    bio: uniqueStrings(safeArray(d?.bio).map(cleanText)).slice(0, 3),
    melhorias: uniqueStrings(safeArray(d?.melhorias).map(cleanText)).slice(0, 6),
    posicionamento: cleanText(d?.posicionamento),
    insights: uniqueStrings(safeArray(d?.insights).map(cleanText)).slice(0, 4)
  };
}

async function diagnostico({ clients, clientData, analysis, objective }) {
  const prompt = `
Cliente: ${JSON.stringify(clientData, null, 2)}
Análise: ${JSON.stringify(analysis, null, 2)}
Objetivo: ${objective}

Diagnóstico para agência de performance:
- problemas observáveis,
- oportunidades aproveitáveis,
- ações em 14 dias,
- prioridades da agência.

JSON:
{
  "problemas": ["string"],
  "oportunidades": ["string"],
  "acoes_14_dias": ["string"],
  "prioridade_agencia": ["string"]
}
`.trim();

  const d = await ask(clients, prompt);

  return {
    problemas: uniqueStrings(safeArray(d?.problemas).map(cleanText)).slice(0, 7),
    oportunidades: uniqueStrings(safeArray(d?.oportunidades).map(cleanText)).slice(0, 7),
    acoes_14_dias: uniqueStrings(safeArray(d?.acoes_14_dias).map(cleanText)).slice(0, 10),
    prioridade_agencia: uniqueStrings(safeArray(d?.prioridade_agencia).map(cleanText)).slice(0, 5)
  };
}

async function planoMensal({
  clients,
  clientData,
  analysis,
  goal,
  secondaryGoals = [],
  qtyReels = 8,
  qtyCarrossel = 6,
  qtyFoto = 2,
  tone = "humano, direto, especialista e sem clichê"
}) {
  const total = qtyReels + qtyCarrossel + qtyFoto;

  const prompt = `
Cliente: ${JSON.stringify(clientData, null, 2)}
Análise: ${JSON.stringify(analysis, null, 2)}
Objetivo: ${goal}
Secundários: ${safeArray(secondaryGoals).join(", ")}
Tom: ${tone}

IMPORTANTE: 
- Não assuma nicho fixo. Identifique o nicho pela análise acima.
- Crie conteúdo para a AUDIÊNCIA, não para o dono do negócio.
- Evite "posts institucionais" chatos. Foque em entretenimento, educação e venda.

Quantidades: Reels (${qtyReels}), Carrossel (${qtyCarrossel}), Foto (${qtyFoto}). Total: ${total}.

JSON:
{
  "posts": [
    {
      "theme": "string",
      "format": "Reels|Carrossel|Foto",
      "hook": "string",
      "script_or_slides": ["string"],
      "caption": "string",
      "creative_direction": "string",
      "goal": "string",
      "viral_score": { "score": 0, "reason": "string" }
    }
  ]
}
`.trim();

  const d = await ask(clients, prompt);
  let posts = safeArray(d?.posts).map((p, i) => sanitizePost(p, i, goal));
  posts = posts.filter((p) => !looksBad(p));

  const reels = posts.filter((p) => p.format === "Reels").slice(0, qtyReels);
  const carrossel = posts.filter((p) => p.format === "Carrossel").slice(0, qtyCarrossel);
  const foto = posts.filter((p) => p.format === "Foto").slice(0, qtyFoto);

  return {
    meta: {
      requested: { qtyReels, qtyCarrossel, qtyFoto, total, goal, secondaryGoals }
    },
    posts: [...reels, ...carrossel, ...foto].slice(0, total)
  };
}

async function concorrencia({ clients, clientData, analysis }) {
  const prompt = `
Cliente: ${JSON.stringify(clientData, null, 2)}
Análise: ${JSON.stringify(analysis, null, 2)}

Liste concorrentes plausíveis e monte um plano para ganhar espaço no Instagram.
Analise: Posicionamento, Estilo de Conteúdo e Fraquezas.

JSON:
{
  "concorrentes": [
    { 
      "nome": "string", 
      "perfil": "string",
      "positioning": "string",
      "opportunity": "como ganhar deles"
    }
  ],
  "plano_para_ganhar": ["string"]
}
`.trim();

  const d = await ask(clients, prompt);

  return {
    concorrentes: safeArray(d?.concorrentes).map((c) => ({
      nome: cleanText(c?.nome),
      perfil: cleanText(c?.perfil),
      positioning: cleanText(c?.positioning),
      opportunity: cleanText(c?.opportunity)
    })).slice(0, 6),
    plano_para_ganhar: uniqueStrings(safeArray(d?.plano_para_ganhar).map(cleanText)).slice(0, 10)
  };
}

module.exports = {
  analisarCliente,
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
};
