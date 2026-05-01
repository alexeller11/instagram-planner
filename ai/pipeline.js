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
    system: `Você responde SOMENTE JSON válido. Sem markdown. Sem blocos de código. Sem texto extra.

VOCÊ É O MAIOR ESTRATEGISTA DE CONTEÚDO E COPYWRITER DE RESPOSTA DIRETA DO BRASIL.
Sua escrita é hipnótica, agressiva e focada em extrair dinheiro do bolso do cliente através de autoridade e desejo.

REGRAS DE OURO (NUNCA QUEBRE):
1. PROIBIDO clichês e repetições: "Você quer saber", "Descubra como", "Confira essas dicas", "Você já se perguntou", "Nós temos a solução", "Muitas pessoas sofrem com", "Saiba mais", "Clique aqui", "Não perca", "Aprenda", "Descubra o segredo", "Você não vai acreditar".
2. VARIABILIDADE TOTAL: Cada post deve ter um ângulo, gancho e abordagem COMPLETAMENTE DIFERENTE dos outros. Não repita temas, não repita estruturas de frases. Se um post fala de economia, o outro fala de segurança, o outro de status, o outro de medo, o outro de bastidores.
3. GANCHOS (Hooks): Use a técnica da "Curiosidade Insuportável" ou "Ameaça Imediata". Ex: "O erro de R$ 5.000 que você comete todo dia no seu carro" ou "Por que sua visão está morrendo e você não percebeu". Sempre específico, nunca genérico. Mínimo 15 palavras.
4. LEGENDA (AIDA DE ELITE):
   - Mínimo de 400 palavras, máximo 600.
   - Use Storytelling agressivo com dados reais e números específicos.
   - Quebre objeções profundas que o cliente nem sabia que tinha.
   - CTA (Chamada para Ação) deve ser um comando imperativo e urgente: "Clique no link da bio AGORA", "Responda com um emoji", "Salve este post", "Compartilhe com um amigo que precisa".
   - Estrutura: Abertura explosiva → Problema específico → Prova social → Solução → Urgência → CTA.
5. ROTEIROS DE REELS:
   - Ritmo frenético com cortes a cada 2-3 segundos.
   - Indique transições: "CORTE RÁPIDO", "ZOOM IN", "TRANSIÇÃO DINÂMICA", "EFEITO SONORO: [descrição]".
   - Textos de impacto na tela em MAIÚSCULAS.
   - Mínimo 8 cenas, máximo 12.
   - Inclua efeitos sonoros sugeridos e movimentos de câmera.
6. PERSONA: Um especialista bilionário que não tem tempo para amadorismo. Direto, autoritário, magnético e brutalmente honesto.
7. QUALIDADE: Cada post deve ser uma obra-prima de copywriting. Nada genérico. Nada fraco. Tudo deve vender.
8. ESPECIFICIDADE: Use números reais, dados, estatísticas. Nunca fale em abstratos.
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
  const prompt = `Analise este cliente como se fosse um Mestre de Marketing de Resposta Direta.
Dados: Marca ${brandName}, Username @${username}, Nicho ${niche}, Oferta ${offer}.

Retorne um mapeamento psicológico BRUTAL da audiência e ângulos editoriais que ninguém mais está usando.
Seja específico, agressivo e focado em VENDA. Nada genérico.

JSON:
{
  "niche_analysis": "string com análise profunda e específica do nicho",
  "audience_summary": "string descrevendo a audiência ideal com detalhes psicográficos",
  "pain_points": ["string", "string", "string", "string", "string", "string"],
  "desires": ["string", "string", "string", "string", "string", "string"],
  "objections": ["string", "string", "string", "string", "string", "string"],
  "positioning_focus": ["string", "string", "string", "string", "string", "string"],
  "content_angles": ["string", "string", "string", "string", "string", "string", "string", "string"]
}`.trim();

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
  const prompt = `Cliente: ${JSON.stringify(clientData)}
Crie 3 Bios que fazem o seguidor sentir VERGONHA de não seguir o perfil.
Cada bio deve ser uma arma de persuasão. Mínimo 80 caracteres cada.
Liste 6 melhorias de perfil ESPECÍFICAS (não genéricas) e 4 insights de domínio que geram lucro.

JSON:
{
  "bio": ["string", "string", "string"],
  "melhorias": ["string", "string", "string", "string", "string", "string"],
  "posicionamento": "string com posicionamento de mercado",
  "insights": ["string", "string", "string", "string"]
}`.trim();

  const d = await ask(clients, prompt);

  return {
    bio: uniqueStrings(safeArray(d?.bio).map(cleanText)).slice(0, 3),
    melhorias: uniqueStrings(safeArray(d?.melhorias).map(cleanText)).slice(0, 6),
    posicionamento: cleanText(d?.posicionamento),
    insights: uniqueStrings(safeArray(d?.insights).map(cleanText)).slice(0, 4)
  };
}

async function diagnostico({ clients, clientData, analysis, objective }) {
  const prompt = `Diagnóstico de Performance para @${clientData.username}.
Seja brutalmente honesto sobre problemas e aponte oportunidades de lucro IMEDIATO.
Cada item deve ser específico e acionável. Nada genérico.

JSON:
{
  "problemas": ["string", "string", "string", "string", "string", "string", "string"],
  "oportunidades": ["string", "string", "string", "string", "string", "string", "string"],
  "acoes_14_dias": ["string", "string", "string", "string", "string", "string", "string", "string", "string", "string"],
  "prioridade_agencia": ["string", "string", "string", "string", "string"]
}`.trim();

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

  const prompt = `ESTRATÉGIA DE GUERRA PARA @${clientData.username}.
Objetivo: ${goal}. Tom: ${tone}.

Gere EXATAMENTE ${total} posts sendo: ${qtyReels} Reels, ${qtyCarrossel} Carrosséis e ${qtyFoto} Fotos.
CADA POST DEVE SER UMA OBRA-PRIMA DE COPYWRITING DE RESPOSTA DIRETA.
NÃO GERE MENOS. NÃO GERE GENÉRICO.

REGRAS DE VARIEDADE:
- PROIBIDO repetir o mesmo gancho ou tema em posts diferentes.
- Se o Post 1 é sobre "Economia", o Post 2 deve ser sobre "Segurança", o Post 3 sobre "Status", etc.
- Varie os ângulos: use medo, desejo, curiosidade, prova social, autoridade e bastidores.

- REELS: Roteiro detalhado cena a cena (MÍNIMO 8 cenas, máximo 12). Inclua transições, efeitos sonoros e textos de impacto.
- CARROSSEL: Estrutura de 10 slides com retenção máxima. Cada slide deve ter um gatilho psicológico diferente.
- LEGENDA: MÍNIMO 400 palavras, máximo 600. Técnica AIDA de Resposta Direta com prova social e urgência.

JSON:
{
  "posts": [
    {
      "theme": "string com título específico e agressivo",
      "format": "Reels|Carrossel|Foto",
      "hook": "Gancho brutal e específico (mínimo 15 palavras)",
      "script_or_slides": ["Cena 1: ...", "Cena 2: ...", "Cena 3: ...", "Cena 4: ...", "Cena 5: ...", "Cena 6: ...", "Cena 7: ...", "Cena 8: ..."],
      "caption": "Legenda LONGA (400-600 palavras) com storytelling agressivo, dados reais, prova social e CTA urgente",
      "creative_direction": "Direção de arte, edição, efeitos sonoros e movimento de câmera",
      "goal": "string",
      "viral_score": { "score": 0, "reason": "string" }
    }
  ]
}`.trim();

  const d = await ask(clients, prompt);
  let posts = safeArray(d?.posts).map((p, i) => sanitizePost(p, i, goal));

  // Fallback para garantir que não venha apenas 1
  if (posts.length < 3) {
      console.warn(`⚠ Apenas ${posts.length} posts gerados. Solicitando lista completa...`);
      const d2 = await ask(clients, prompt + " (FOQUE EM GERAR A LISTA COMPLETA DE POSTS AGORA. MÍNIMO " + total + " POSTS. VARIE OS TEMAS!)");
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
  const prompt = `Mapeie a concorrência para @${clientData.username} como um estrategista de guerra de mercado.
Identifique os 6 maiores concorrentes, seus pontos fracos ESPECÍFICOS e onde podemos esmagar o mercado.
Seja brutal e específico. Nada genérico.

JSON:
{
  "concorrentes": [
    { "nome": "string com nome real do concorrente", "perfil": "@username", "positioning": "string com análise específica do posicionamento", "opportunity": "string com oportunidade específica de ataque" }
  ],
  "plano_para_ganhar": ["string", "string", "string", "string", "string", "string", "string", "string", "string", "string"]
}`.trim();

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
