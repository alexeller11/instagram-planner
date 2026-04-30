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
Você responde SOMENTE JSON válido. Sem markdown. Sem blocos de código. Sem texto extra.

VOCÊ É O MAIOR ESTRATEGISTA DE CONTEÚDO E COPYWRITER DE RESPOSTA DIRETA DO BRASIL.
Sua escrita é hipnótica, agressiva e focada em extrair dinheiro do bolso do cliente através de autoridade e desejo.

REGRAS DE OURO (NUNCA QUEBRE):
1. PROIBIDO clichês: "Você quer saber", "Descubra como", "Confira essas dicas", "Você já se perguntou", "Nós temos a solução", "Muitas pessoas sofrem com".
2. GANCHOS (Hooks): Use a técnica da "Curiosidade Insuportável" ou "Ameaça Imediata". Ex: "O erro de R$ 5.000 que você comete todo dia no seu carro" ou "Por que sua visão está morrendo e você não percebeu".
3. LEGENDA (AIDA DE ELITE): 
   - Mínimo de 400 palavras.
   - Use Storytelling agressivo.
   - Quebre objeções que o cliente nem sabia que tinha.
   - CTA (Chamada para Ação) deve ser um comando imperativo e urgente.
4. ROTEIROS DE REELS: 
   - Ritmo frenético.
   - Indique cortes a cada 2-3 segundos.
   - Textos de impacto na tela.
5. PERSONA: Um especialista bilionário que não tem tempo para amadorismo. Direto, autoritário e magnético.
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
Analise este cliente como se fosse um Mestre de Marketing. 
Dados: Marca ${brandName}, Username @${username}, Nicho ${niche}, Oferta ${offer}.

Retorne um mapeamento psicológico brutal da audiência e ângulos editoriais que ninguém mais está usando.

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
Cliente: ${JSON.stringify(clientData)}
Crie 3 Bios que fazem o seguidor sentir vergonha de não seguir o perfil. 
Liste 6 melhorias de perfil e 4 insights de domínio.

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
Diagnóstico de Performance para @${clientData.username}. 
Seja brutalmente honesto sobre problemas e aponte oportunidades de lucro imediato.

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
  tone = "autoritário, persuasivo e magnético"
}) {
  const total = qtyReels + qtyCarrossel + qtyFoto;

  const prompt = `
ESTRATÉGIA DE GUERRA PARA @${clientData.username}.
Objetivo: ${goal}. Tom: ${tone}.

Gere ${total} posts sendo: ${qtyReels} Reels, ${qtyCarrossel} Carrosséis e ${qtyFoto} Fotos.
CADA POST DEVE SER UMA OBRA DE ARTE DE COPYWRITING.

- REELS: Roteiro detalhado cena a cena (mínimo 6 cenas).
- CARROSSEL: Estrutura de 10 slides com retenção máxima.
- LEGENDA: Mínimo 400 palavras. Técnica AIDA de Resposta Direta.

JSON:
{
  "posts": [
    {
      "theme": "string",
      "format": "Reels|Carrossel|Foto",
      "hook": "Gancho brutal",
      "script_or_slides": ["Cena 1: ...", "Cena 2: ...", "Cena 3: ...", "Cena 4: ...", "Cena 5: ...", "Cena 6: ..."],
      "caption": "Legenda LONGA (mínimo 400 palavras) e extremamente persuasiva",
      "creative_direction": "Direção de arte e edição",
      "goal": "string",
      "viral_score": { "score": 0, "reason": "string" }
    }
  ]
}
`.trim();

  const d = await ask(clients, prompt);
  let posts = safeArray(d?.posts).map((p, i) => sanitizePost(p, i, goal));

  // Fallback para garantir que não venha apenas 1
  if (posts.length < 3) {
      const d2 = await ask(clients, prompt + " (FOQUE EM GERAR A LISTA COMPLETA DE POSTS AGORA)");
      posts = [...posts, ...safeArray(d2?.posts).map((p, i) => sanitizePost(p, i + posts.length, goal))];
  }

  const reels = posts.filter((p) => p.format === "Reels").slice(0, qtyReels);
  const carrossel = posts.filter((p) => p.format === "Carrossel").slice(0, qtyCarrossel);
  const foto = posts.filter((p) => p.format === "Foto").slice(0, qtyFoto);

  return {
    meta: { requested: { qtyReels, qtyCarrossel, qtyFoto, total, goal, secondaryGoals } },
    posts: [...reels, ...carrossel, ...foto].slice(0, total)
  };
}

async function concorrencia({ clients, clientData, analysis }) {
  const prompt = `
Mapeie a concorrência para @${clientData.username}. 
Ache os pontos fracos deles e onde podemos esmagar o mercado.

JSON:
{
  "concorrentes": [
    { "nome": "string", "perfil": "string", "positioning": "string", "opportunity": "string" }
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
