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

function dedupeStrings(arr = []) {
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
Você responde apenas JSON válido.
Sem markdown.
Sem bloco de código.
Sem comentários.
Sem texto fora do JSON.
Escreva em português do Brasil.
Nada de clichês.
Nada de linguagem de coach.
Nada de frases com cara de agência genérica.
`.trim(),
    user: prompt
  });
}

function sanitizePost(p, idx, fallbackGoal) {
  const viral = p?.viral_score || {};
  return {
    theme: cleanText(p?.theme || `Post ${idx + 1}`),
    format: cleanText(p?.format || "Reels"),
    hook: cleanText(p?.hook),
    script_or_slides: safeArray(p?.script_or_slides).map(cleanText).filter(Boolean),
    caption: cleanText(p?.caption),
    creative_direction: cleanText(p?.creative_direction),
    goal: cleanText(p?.goal || fallbackGoal),
    viral_score: {
      score: Math.max(0, Math.min(10, Number(viral?.score ?? 0))),
      reason: cleanText(viral?.reason)
    }
  };
}

async function dashboard360({ clients, niche, username }) {
  const prompt = `
Você é um estrategista sênior de conteúdo e posicionamento para Instagram.

Cliente: ${username}
Nicho: ${niche}

Entregue:
1) 3 bios fortes, claras e humanas.
2) 6 melhorias reais de perfil.
3) 1 posicionamento de marca.
4) 4 insights de conteúdo úteis para tomada de decisão de uma agência de performance.

Regras:
- Nada de "excelência", "transformando", "sua melhor escolha", "bem-vindo".
- Escreva como alguém que auditou um perfil real.
- Vá direto ao ponto.
- Nada superficial.

JSON:
{
  "bio": ["string", "string", "string"],
  "melhorias": ["string"],
  "posicionamento": "string",
  "insights": ["string"]
}
`.trim();

  const d = await ask(clients, prompt);

  return {
    bio: dedupeStrings(safeArray(d?.bio).map(cleanText)).slice(0, 3),
    melhorias: dedupeStrings(safeArray(d?.melhorias).map(cleanText)).slice(0, 6),
    posicionamento: cleanText(d?.posicionamento),
    insights: dedupeStrings(safeArray(d?.insights).map(cleanText)).slice(0, 4)
  };
}

async function diagnostico({ clients, niche, username, positioning, objective }) {
  const prompt = `
Você é estrategista de conteúdo de uma agência de performance.
Faça um diagnóstico que ajude em tomada de decisão.

Cliente: ${username}
Nicho: ${niche}
Posicionamento atual: ${positioning || "não informado"}
Objetivo: ${objective}

Regras:
- Diagnóstico útil, específico e acionável.
- Nada de generalidades.
- Escreva como consultor experiente apresentando leitura estratégica para agência.
- Aponte falhas de conteúdo, de conversão, de percepção de valor e de clareza comercial.

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
    problemas: dedupeStrings(safeArray(d?.problemas).map(cleanText)).slice(0, 7),
    oportunidades: dedupeStrings(safeArray(d?.oportunidades).map(cleanText)).slice(0, 7),
    acoes_14_dias: dedupeStrings(safeArray(d?.acoes_14_dias).map(cleanText)).slice(0, 10),
    prioridade_agencia: dedupeStrings(safeArray(d?.prioridade_agencia).map(cleanText)).slice(0, 5)
  };
}

async function planoMensal({
  clients,
  niche,
  username,
  goal,
  secondaryGoals = [],
  qtyReels = 8,
  qtyCarrossel = 6,
  qtyFoto = 2,
  city = "Linhares",
  tone = "humano, direto, especialista e sem clichê"
}) {
  const total = qtyReels + qtyCarrossel + qtyFoto;

  const prompt = `
Você é diretor criativo e estrategista de conteúdo de uma agência de performance.

Cliente: ${username}
Nicho: ${niche}
Cidade/base: ${city}
Objetivo principal: ${goal}
Objetivos secundários: ${secondaryGoals.join(", ") || "nenhum"}
Tom desejado: ${tone}

Quantidade obrigatória:
- Reels: ${qtyReels}
- Carrossel: ${qtyCarrossel}
- Foto/Post estático: ${qtyFoto}
- Total: ${total}

Regras:
- Nada de clichês.
- Nada de "você já imaginou", "excelência", "qualidade", "serviços oferecidos", "dicas imperdíveis", "transforme", "história de sucesso".
- Cada conteúdo precisa ter utilidade estratégica.
- O conteúdo deve ajudar uma agência a tomar decisão e publicar melhor.
- Use linguagem brasileira real, observável, concreta.
- Traga tensão, dúvida do cliente, objeção, critério de escolha, prova de bastidor ou repertório prático.
- Não repetir ângulo.
- Não repetir CTA.
- Não escrever como agência falando de si; escrever como plano pronto do cliente.

Para cada item, entregue:
- theme
- format
- hook
- script_or_slides
- caption
- creative_direction
- goal
- viral_score:
  - score: nota de 0 a 10
  - reason: justificativa curta e honesta

A nota de viralização deve considerar:
- força do gancho
- potencial de retenção
- apelo emocional/prático
- capacidade de compartilhamento
- chance real de performar no Instagram

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
      "viral_score": {
        "score": 0,
        "reason": "string"
      }
    }
  ]
}
`.trim();

  const d = await ask(clients, prompt);
  let posts = safeArray(d?.posts).map((p, i) => sanitizePost(p, i, goal));

  const byFormat = {
    Reels: posts.filter((p) => p.format === "Reels"),
    Carrossel: posts.filter((p) => p.format === "Carrossel"),
    Foto: posts.filter((p) => p.format === "Foto")
  };

  const enough =
    byFormat.Reels.length >= qtyReels &&
    byFormat.Carrossel.length >= qtyCarrossel &&
    byFormat.Foto.length >= qtyFoto;

  if (!enough) {
    posts = [
      ...byFormat.Reels.slice(0, qtyReels),
      ...byFormat.Carrossel.slice(0, qtyCarrossel),
      ...byFormat.Foto.slice(0, qtyFoto)
    ];
  }

  return {
    meta: {
      requested: { qtyReels, qtyCarrossel, qtyFoto, total, goal, secondaryGoals }
    },
    posts: posts.slice(0, total)
  };
}

async function concorrencia({ clients, niche, city }) {
  const prompt = `
Você analisa concorrência para uma agência de performance.

Nicho: ${niche}
Cidade/base: ${city}

JSON:
{
  "concorrentes": [
    { "nome": "string", "perfil": "string" }
  ],
  "plano_para_ganhar": ["string"]
}
`.trim();

  const d = await ask(clients, prompt);

  return {
    concorrentes: safeArray(d?.concorrentes).map((c) => ({
      nome: cleanText(c?.nome),
      perfil: cleanText(c?.perfil)
    })).slice(0, 6),
    plano_para_ganhar: dedupeStrings(safeArray(d?.plano_para_ganhar).map(cleanText)).slice(0, 10)
  };
}

module.exports = {
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
};
