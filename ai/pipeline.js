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
Você é um Copywriter Sênior e Estrategista de Conteúdo com 15 anos de experiência em grandes agências de publicidade.
Sua missão é criar conteúdo que pareça escrito por um especialista humano, com autoridade, personalidade e foco em conversão.

REGRAS DE OURO:
1. PROIBIDO começar frases com clichês como "Você quer saber", "Descubra como", "Saiba mais", "Confira agora".
2. PROIBIDO usar linguagem de "vendedor de curso" ou marketing genérico.
3. Use Ganchos (Hooks) de impacto que ataquem uma dor real ou curiosidade específica.
4. As legendas devem seguir a estrutura AIDA (Atenção, Interesse, Desejo, Ação).
5. Para Reels, o roteiro deve ser cinematográfico: Cena, Texto Falado e Ação.
6. Seja específico. Se o nicho é odontologia, fale de "sensibilidade pós-clareamento", não de "cuidar do sorriso".

Você responde SOMENTE JSON válido, sem markdown ou textos extras.
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
Faça uma análise estratégica PROFUNDA para o cliente:
Marca: ${brandName} | Nicho: ${niche} | Oferta: ${offer}
Dores: ${safeArray(audiencePainPoints).join(", ")}

Tarefas:
1) Refine o nicho para um nível de autoridade (Ex: de "Dentista" para "Reabilitação Oral e Estética de Alto Padrão").
2) Crie uma Persona de Audiência detalhada (Medos, Aspirações e Nível de Consciência).
3) Identifique 3 "Inimigos Comuns" do nicho que podemos atacar no conteúdo.
4) Defina 5 Ângulos de Venda Indireta.

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
Crie um Dashboard de Autoridade para ${clientData.brandName}.
Análise: ${JSON.stringify(analysis)}

Entregue:
1) 3 Bios de Agência: Uma focada em Autoridade, uma em Conexão e uma em Venda Direta.
2) 6 Melhorias de Conversão no Perfil.
3) 1 Declaração de Posicionamento Único (USP).
4) 4 Insights de Performance baseados em tendências de 2024.

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
Gere um Diagnóstico de Agência para o perfil @${clientData.username}.
Objetivo: ${objective}

Quero uma análise crua e honesta sobre:
- Erros fatais de posicionamento.
- Oportunidades de crescimento rápido (Quick Wins).
- Plano de Guerra de 14 dias.

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
  tone = "especialista, autoridade e direto"
}) {
  const total = qtyReels + qtyCarrossel + qtyFoto;

  const prompt = `
Crie um Plano de Conteúdo de Elite para @${clientData.username}.
Nicho: ${analysis.niche_analysis}
Objetivo: ${goal}

ESTRUTURA OBRIGATÓRIA PARA CADA POST:
- theme: Título forte e magnético.
- format: Reels, Carrossel ou Foto.
- hook: O gancho inicial (O que aparece nos primeiros 3 segundos ou na primeira frase).
- script_or_slides: 
   - Se REELS: Roteiro detalhado (Cena 1: [Ação] + [Texto], Cena 2: ...).
   - Se CARROSSEL: Texto de cada slide (Slide 1, Slide 2...).
- caption: Legenda completa usando copywriting (AIDA). Use emojis moderadamente.
- creative_direction: Instruções para o designer ou editor de vídeo.

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
  
  if (posts.length === 0) {
    console.log("Aviso: IA retornou 0 posts no plano.");
  }

  return {
    meta: {
      requested: { qtyReels, qtyCarrossel, qtyFoto, total, goal, secondaryGoals }
    },
    posts: posts.slice(0, total)
  };
}

async function concorrencia({ clients, clientData, analysis }) {
  const prompt = `
Análise de Ecossistema Competitivo para @${clientData.username}.
Mapeie 5 concorrentes e defina como vamos "roubar" a atenção da audiência deles.

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
