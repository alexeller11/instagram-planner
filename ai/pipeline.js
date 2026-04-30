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
Sem comentários.
Sem blocos de código.
Sem texto antes ou depois do JSON.

Você é um estrategista sênior de conteúdo para Instagram no Brasil.
Escreve de forma humana, específica, prática e sem clichês.
Nunca escreva como consultor de gestão interna da empresa, a menos que isso seja explicitamente pedido.
O conteúdo deve ser pensado para o público que segue ou pode seguir o perfil no Instagram.
`.trim(),
    user: prompt
  });
}

function sanitizePost(p, idx, fallbackGoal) {
  const score = Number(p?.viral_score?.score ?? 0);
  return {
    theme: cleanText(p?.theme || `Post ${idx + 1}`),
    format: ["Reels", "Carrossel", "Foto"].includes(cleanText(p?.format))
      ? cleanText(p?.format)
      : "Reels",
    hook: cleanText(p?.hook),
    script_or_slides: safeArray(p?.script_or_slides).map(cleanText).filter(Boolean),
    caption: cleanText(p?.caption),
    creative_direction: cleanText(p?.creative_direction),
    goal: cleanText(p?.goal || fallbackGoal),
    viral_score: {
      score: Math.max(0, Math.min(10, score)),
      reason: cleanText(p?.viral_score?.reason)
    }
  };
}

function looksLikeInternalBusinessAdvice(post) {
  const text = [
    post.theme,
    post.hook,
    post.caption,
    ...(post.script_or_slides || [])
  ].join(" ").toLowerCase();

  const forbidden = [
    "mantenha sua oficina limpa",
    "mantenha sua equipe",
    "produtividade da oficina",
    "perdendo dinheiro por falta de eficiência",
    "funcionários",
    "equipe saudável e motivada",
    "normas de segurança da oficina",
    "organização da oficina",
    "boa gestão da oficina"
  ];

  return forbidden.some((term) => text.includes(term));
}

async function dashboard360({ clients, niche, username }) {
  const prompt = `
Cliente: ${username}
Nicho: ${niche}

Crie uma leitura estratégica de perfil para Instagram.

Entregue:
1) 3 bios fortes e naturais.
2) 6 melhorias reais de perfil.
3) 1 posicionamento claro.
4) 4 insights que ajudem uma agência a tomar decisão.

Regras:
- Nada de clichês como "excelência", "bem-vindo", "sua melhor escolha", "transformando".
- Escreva com linguagem prática.
- Pense no perfil como ferramenta comercial e de percepção.
- Nada superficial.

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

async function diagnostico({ clients, niche, username, objective }) {
  const prompt = `
Cliente: ${username}
Nicho: ${niche}
Objetivo de análise: ${objective}

Faça um diagnóstico de Instagram para uma agência de performance.

Regras:
- Problemas específicos e observáveis.
- Oportunidades aproveitáveis.
- Ações práticas em até 14 dias.
- Prioridades da agência.
- Nada vazio. Nada genérico.

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
Você está criando um plano de conteúdo para o perfil de Instagram do cliente abaixo.

Cliente: ${username}
Nicho: ${niche}
Cidade/base: ${city}
Objetivo principal: ${goal}
Objetivos secundários: ${secondaryGoals.join(", ") || "nenhum"}
Tom de marca: ${tone}

ATENÇÃO:
- O conteúdo deve ser pensado para o público do perfil, não para o dono do negócio gerir melhor a empresa.
- Exemplo: se for oficina, fale com donos de carro, motoristas, pessoas com dúvidas, medos, problemas e desejos relacionados ao carro.
- Não crie conteúdo sobre gestão interna, equipe, produtividade, limpeza da empresa, motivação de funcionários ou processos internos, a menos que isso seja um bastidor com valor claro para o seguidor.
- O perfil existe para atrair, educar, gerar confiança e conversão.

Quantidade obrigatória:
- Reels: ${qtyReels}
- Carrossel: ${qtyCarrossel}
- Foto: ${qtyFoto}
- Total: ${total}

Regras:
- Nada de clichês.
- Nada de linguagem genérica de agência.
- Nada de post que pareça aula de gestão empresarial.
- Cada post precisa ter ângulo diferente.
- Cada legenda precisa parecer publicável.
- O hook deve ter tensão, curiosidade útil, identificação ou dor real.
- O conteúdo precisa soar brasileiro e natural.

Avalie cada peça com uma nota de viralização de 0 a 10.
A nota deve ser honesta, não inflada.

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

  posts = posts.filter((p) => !looksLikeInternalBusinessAdvice(p));

  const reels = posts.filter((p) => p.format === "Reels").slice(0, qtyReels);
  const carrossel = posts.filter((p) => p.format === "Carrossel").slice(0, qtyCarrossel);
  const foto = posts.filter((p) => p.format === "Foto").slice(0, qtyFoto);

  const finalPosts = [...reels, ...carrossel, ...foto].slice(0, total);

  if (!finalPosts.length) {
    return {
      meta: {
        requested: { qtyReels, qtyCarrossel, qtyFoto, total, goal, secondaryGoals }
      },
      posts: [
        {
          theme: "Barulho no carro que muita gente ignora até virar gasto alto",
          format: "Reels",
          hook: "Tem barulho no carro que começa baixo e termina com o motorista arrependido de ter esperado.",
          script_or_slides: [
            "Motorista comenta o barulho que aparece em rua irregular",
            "Close rápido no carro entrando na oficina",
            "Mecânico explica em linguagem simples o que pode causar o ruído",
            "Fechar com orientação objetiva sobre quando procurar avaliação"
          ],
          caption: "Muita gente adia porque o carro ainda anda. O problema é que alguns sinais começam pequenos e cobram mais caro depois. Se seu carro mudou barulho, vibração ou resposta, vale olhar antes de piorar. Chama no direct e te ajudamos a entender o primeiro passo.",
          creative_direction: "Vídeo com cara de rotina real, sem atuação exagerada, cortes curtos e fala simples do técnico.",
          goal: goal,
          viral_score: {
            score: 8.2,
            reason: "Gancho útil, dor real e alto potencial de identificação para quem usa o carro no dia a dia."
          }
        }
      ]
    };
  }

  return {
    meta: {
      requested: { qtyReels, qtyCarrossel, qtyFoto, total, goal, secondaryGoals }
    },
    posts: finalPosts
  };
}

async function concorrencia({ clients, niche, city }) {
  const prompt = `
Nicho: ${niche}
Cidade: ${city}

Liste concorrentes plausíveis e monte um plano para ganhar espaço no Instagram.

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
    plano_para_ganhar: uniqueStrings(safeArray(d?.plano_para_ganhar).map(cleanText)).slice(0, 10)
  };
}

module.exports = {
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
};
