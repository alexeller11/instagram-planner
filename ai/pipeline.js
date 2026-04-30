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
Sem markdown. Sem blocos de código. Sem texto extra.

VOCÊ É O DIRETOR DE CRIAÇÃO E COPYWRITER SÊNIOR DE UMA AGÊNCIA DE PERFORMANCE DE ELITE.
Sua missão é gerar conteúdo que PARE O SCROLL e gere DESEJO imediato.

DIRETRIZES DE OURO:
1. PROIBIDO clichês: "Você quer saber", "Descubra como", "Confira essas dicas", "Você já se perguntou", "Nós temos a solução".
2. GANCHOS (Hooks): Devem ser agressivos ou extremamente curiosos. Use contra-intuição, quebra de padrão ou promessa de benefício imediato nos primeiros 2 segundos.
3. TÉCNICA AIDA (OBRIGATÓRIA): 
   - ATENÇÃO: O Gancho.
   - INTERESSE: O problema ou a oportunidade detalhada.
   - DESEJO: A transformação ou o resultado.
   - AÇÃO: CTA claro, direto e imperativo.
4. LEGENDAS: Devem ser LONGAS, persuasivas e com parágrafos curtos para leitura fácil. Use emojis de forma estratégica (não excessiva).
5. ROTEIROS DE REELS: Devem ser CINEMATOGRÁFICOS. Indique o que deve aparecer na tela (texto, gesto, corte, b-roll).
6. QUALIDADE: Se o conteúdo parecer "gerado por IA genérica", você falhou. Escreva como um humano estrategista que entende de psicologia de vendas.
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
Faça uma leitura estratégica do cliente abaixo.

Dados disponíveis:
- Marca: ${brandName}
- Username: ${username}
- Nicho: ${niche}
- Cidade: ${city}
- Oferta: ${offer}
- Público: ${targetAudience}
- Dores: ${safeArray(audiencePainPoints).join(", ")}
- Tom: ${brandTone}
- Pilares: ${safeArray(contentPillars).join(", ")}

Tarefas:
1) Refinar o nicho para algo lucrativo e específico.
2) Mapear a psicologia da audiência (medos inconscientes e desejos reais).
3) Definir ângulos editoriais que diferenciem a marca da concorrência amadora.

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
Entregue 3 Bios Magnéticas, 6 melhorias de perfil e 4 insights de domínio de mercado.

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

Diagnóstico para agência de performance. Liste problemas, oportunidades e ações imediatas.

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
Cliente: ${JSON.stringify(clientData, null, 2)}
Análise: ${JSON.stringify(analysis, null, 2)}
Objetivo: ${goal}
Tom: ${tone}

ESTRATÉGIA DE CONTEÚDO DE ALTA PERFORMANCE:
1. REELS (Roteiro Cinematográfico): Detalhe cenas, textos na tela e ações do apresentador. Mínimo 5 cenas.
2. CARROSSEL (Estrutura de Retenção): Detalhe o que vai em cada slide (do 1 ao 10 se necessário).
3. LEGENDA (AIDA de Elite): Mínimo 300 palavras. Deve ser persuasiva, quebrar objeções e levar à ação.
4. GANCHOS: Devem ser impossíveis de ignorar.

Quantidades: Reels (${qtyReels}), Carrossel (${qtyCarrossel}), Foto (${qtyFoto}). Total: ${total}.

JSON:
{
  "posts": [
    {
      "theme": "string",
      "format": "Reels|Carrossel|Foto",
      "hook": "Gancho agressivo/curioso",
      "script_or_slides": ["Cena/Slide 1: ...", "Cena/Slide 2: ...", "Cena/Slide 3: ...", "Cena/Slide 4: ...", "Cena/Slide 5: ..."],
      "caption": "Legenda LONGA e PERSUASIVA seguindo técnica AIDA detalhada",
      "creative_direction": "Orientação de luz, enquadramento e edição",
      "goal": "string",
      "viral_score": { "score": 0, "reason": "string" }
    }
  ]
}
`.trim();

  const d = await ask(clients, prompt);
  let posts = safeArray(d?.posts).map((p, i) => sanitizePost(p, i, goal));

  // Garantir que temos o número solicitado de posts, repetindo a chamada se necessário (ou aceitando o que veio se for suficiente)
  // Para evitar o problema de "apenas 1 conteúdo", vamos reforçar no prompt ou fazer múltiplas chamadas se o LLM for preguiçoso.
  // No momento, vamos confiar que o prompt reforçado de "Elite" e "Agência" trará a lista completa.

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

Liste concorrentes e monte um plano de dominação de nicho.

JSON:
{
  "concorrentes": [
    { 
      "nome": "string", 
      "perfil": "string",
      "positioning": "string",
      "opportunity": "string"
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
