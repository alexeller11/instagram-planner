require("dotenv").config();

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const PDFDocument = require("pdfkit");
const Groq = require("groq-sdk");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const IG_TOKENS = (process.env.IG_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.set("trust proxy", 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: NODE_ENV === "production",
      httpOnly: true,
      sameSite: NODE_ENV === "production" ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

function ensureGroq(res) {
  if (!groq) {
    res.status(500).json({ error: "GROQ_API_KEY não configurada." });
    return false;
  }
  return true;
}

function safeJsonParse(text) {
  if (!text || typeof text !== "string") return null;

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function compactText(value, max = 300) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizePosts(media = []) {
  return media
    .slice(0, 12)
    .map((m, i) => {
      const caption = compactText(m.caption || "Sem legenda", 180);
      return `${i + 1}. [${m.media_type}] ${caption} | likes=${m.like_count || 0} | comments=${m.comments_count || 0}`;
    })
    .join("\n");
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function fetchIGProfiles(tokens) {
  const accounts = [];

  for (const token of tokens) {
    try {
      const res = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: {
          fields:
            "id,name,username,followers_count,media_count,biography,website,profile_picture_url,account_type",
          access_token: token
        }
      });

      accounts.push({
        ...res.data,
        ig_token: token
      });
    } catch (error) {
      console.error("[IG_PROFILE_ERROR]", error.response?.data || error.message);
    }
  }

  return accounts;
}

async function fetchMedia(igId, token, limit = 30) {
  try {
    const res = await axios.get(`https://graph.instagram.com/v21.0/${igId}/media`, {
      params: {
        fields: "id,caption,media_type,timestamp,like_count,comments_count,permalink",
        limit,
        access_token: token
      }
    });

    return res.data.data || [];
  } catch (error) {
    console.error("[IG_MEDIA_ERROR]", error.response?.data || error.message);
    return [];
  }
}

async function callGroqJSON({ system, user, maxTokens = 4096, temperature = 0.7 }) {
  if (!groq) throw new Error("GROQ_API_KEY não configurada");

  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const text = completion.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(text);

  if (!parsed) {
    throw new Error("A IA retornou JSON inválido.");
  }

  return parsed;
}

function getAccountFromSession(req, igId) {
  const accounts = req.session?.user?.accounts || [];
  return accounts.find((a) => a.id === igId);
}

function calculateStrategicScore(account, media, metrics, formatMix) {
  let score = 0;

  if (account.biography) score += 20;
  if (account.website) score += 10;
  if (media.length >= 12) score += 20;
  else if (media.length >= 6) score += 12;
  else score += 6;

  const formats = Object.keys(formatMix || {});
  if (formats.length >= 3) score += 15;
  else if (formats.length === 2) score += 10;
  else score += 4;

  const engagementRate = Number(metrics.engagement_rate || 0);
  if (engagementRate >= 3) score += 20;
  else if (engagementRate >= 1.5) score += 14;
  else if (engagementRate >= 0.8) score += 8;
  else score += 4;

  const freq = metrics.posting_frequency_days;
  if (freq && freq <= 3) score += 15;
  else if (freq && freq <= 7) score += 10;
  else if (freq) score += 5;

  return Math.min(100, Math.round(score));
}

function scoreLabel(score) {
  if (score >= 80) return "Muito forte";
  if (score >= 60) return "Bom";
  if (score >= 40) return "Regular";
  return "Fraco";
}

function buildDashboard(media, account) {
  const likes = media.map((m) => Number(m.like_count || 0));
  const comments = media.map((m) => Number(m.comments_count || 0));
  const engagementAverage = avg(media.map((m) => Number(m.like_count || 0) + Number(m.comments_count || 0)));
  const followerBase = Number(account.followers_count || 0) || 1;
  const engagementRate = ((engagementAverage / followerBase) * 100).toFixed(2);

  const byFormat = media.reduce((acc, item) => {
    const key = item.media_type || "UNKNOWN";
    if (!acc[key]) acc[key] = { count: 0, likes: 0, comments: 0 };
    acc[key].count += 1;
    acc[key].likes += Number(item.like_count || 0);
    acc[key].comments += Number(item.comments_count || 0);
    return acc;
  }, {});

  const topPosts = [...media]
    .sort((a, b) => {
      const aScore = Number(a.like_count || 0) + Number(a.comments_count || 0);
      const bScore = Number(b.like_count || 0) + Number(b.comments_count || 0);
      return bScore - aScore;
    })
    .slice(0, 5);

  const recentFrequencyDays = (() => {
    if (media.length < 2) return null;
    const ordered = [...media].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let totalDiff = 0;
    for (let i = 1; i < ordered.length; i++) {
      const prev = new Date(ordered[i - 1].timestamp).getTime();
      const curr = new Date(ordered[i].timestamp).getTime();
      totalDiff += Math.abs(curr - prev);
    }
    return Math.round(totalDiff / (ordered.length - 1) / (1000 * 60 * 60 * 24));
  })();

  const metrics = {
    avg_likes: Math.round(avg(likes)),
    avg_comments: Math.round(avg(comments)),
    avg_engagement: Math.round(engagementAverage),
    engagement_rate: Number(engagementRate),
    posting_frequency_days: recentFrequencyDays
  };

  const strategic_score = calculateStrategicScore(account, media, metrics, byFormat);

  return {
    account: {
      id: account.id,
      username: account.username,
      name: account.name,
      biography: account.biography || "",
      website: account.website || "",
      followers_count: Number(account.followers_count || 0),
      media_count: Number(account.media_count || 0)
    },
    metrics,
    strategic_score,
    strategic_score_label: scoreLabel(strategic_score),
    format_mix: byFormat,
    top_posts: topPosts
  };
}

function plannerSystemPrompt() {
  return `
Você é um estrategista sênior de marketing, conteúdo e posicionamento para Instagram, com nível de agência premium.

Você NÃO escreve como uma IA genérica.
Você NÃO cria conteúdo para preencher calendário.
Você cria conteúdo para gerar atenção, percepção de valor, autoridade, desejo e ação.

Seu trabalho é:
- analisar o perfil e o contexto do negócio
- pensar como estrategista de marca e conversão
- propor conteúdos que façam o público parar, sentir, pensar e agir
- evitar qualquer linguagem previsível, rasa ou repetitiva

REGRAS OBRIGATÓRIAS:
- escreva sempre em português do Brasil
- retorne SOMENTE JSON válido
- seja específico, prático, estratégico e comercial
- evite respostas genéricas, superficiais ou decorativas
- não use repetidamente expressões como:
  "você sabia", "arraste para o lado", "sabia que", "descubra", "confira", "entenda", "veja os benefícios"
- não crie títulos burocráticos, escolares ou frios
- não escreva como blog genérico
- não monte calendário com o mesmo ângulo repetido
- varie ganchos, tensões, intenções e tipos de conteúdo
- considere nicho, público, objetivo, tom de voz, contexto e localização
- pense como alguém que quer gerar resultado real para o cliente

ÂNGULOS QUE VOCÊ DEVE MISTURAR NO CONTEÚDO:
- dor real
- erro comum
- prejuízo evitável
- objeção
- bastidor
- prova
- autoridade
- percepção de problema
- desejo
- comparação
- quebra de crença
- contexto local
- oportunidade comercial
- comportamento do público
- urgência inteligente

QUANDO GERAR POSTS:
- títulos precisam ser fortes, humanos e específicos
- títulos não podem soar como matéria de blog
- ganchos precisam abrir loops mentais
- legendas precisam soar naturais e úteis
- CTA precisa combinar com a intenção do post
- nem todo post precisa vender diretamente, mas todo post precisa mover a pessoa

QUANDO GERAR PLANNER:
- cada post precisa ter função clara no funil
- não repetir a mesma ideia com palavras diferentes
- alternar formatos e intenções
- não concentrar tudo em conteúdo informativo
- incluir posts que gerem atenção, identificação, prova, autoridade e conversão

QUANDO GERAR CONCORRÊNCIA:
- não invente dados exatos
- use raciocínio estratégico
- considere contexto regional quando houver localização
- sugira diferenciação real

QUANDO GERAR INTELIGÊNCIA:
- fale como consultor estratégico
- mostre o que está travando o perfil
- mostre o que fazer
- seja direto e útil

Seu padrão é:
forte, específico, humano, estratégico e comercial.
`;
}

function buildContextBlock({
  account,
  niche = "",
  audience = "",
  goal = "",
  tone = "",
  extra = "",
  location = ""
}) {
  return `
CONTEXTO DA EMPRESA:
- Perfil: @${account.username}
- Nome: ${account.name || ""}
- Nicho: ${niche}
- Público: ${audience}
- Objetivo: ${goal}
- Tom de voz: ${tone}
- Localização: ${location}
- Contexto extra: ${extra}
- Bio atual: ${account.biography || ""}
- Website: ${account.website || ""}

IMPORTANTE:
Use a localização e o nicho para tornar a análise e as sugestões mais aderentes ao contexto real da empresa.
`;
}

app.post("/api/auth", async (req, res) => {
  if (!IG_TOKENS.length) {
    return res.status(400).json({
      success: false,
      error: "Nenhum token configurado em IG_TOKENS."
    });
  }

  try {
    const accounts = await fetchIGProfiles(IG_TOKENS);

    if (!accounts.length) {
      return res.status(400).json({
        success: false,
        error: "Nenhuma conta foi carregada com os tokens atuais."
      });
    }

    req.session.user = { accounts };

    return res.json({
      success: true,
      accounts: accounts.map((a) => ({
        id: a.id,
        username: a.username,
        followers_count: a.followers_count
      }))
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.json({ logged: false, accounts: [] });
  }

  return res.json({
    logged: true,
    accounts: req.session.user.accounts || []
  });
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.post("/api/test-token", async (req, res) => {
  const token = (req.body?.token || "").trim();
  if (!token) {
    return res.status(400).json({ success: false, error: "Token vazio." });
  }

  try {
    const accounts = await fetchIGProfiles([token]);
    if (!accounts.length) {
      return res.status(400).json({ success: false, error: "Token inválido ou sem acesso." });
    }

    if (!req.session.user) req.session.user = { accounts: [] };

    for (const acc of accounts) {
      const exists = req.session.user.accounts.find((a) => a.id === acc.id);
      if (!exists) req.session.user.accounts.push(acc);
    }

    return res.json({ success: true, accounts });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/dashboard/:igId", async (req, res) => {
  const account = getAccountFromSession(req, req.params.igId);
  if (!account) {
    return res.status(404).json({ error: "Conta não encontrada na sessão." });
  }

  const media = await fetchMedia(account.id, account.ig_token, 30);
  const dashboard = buildDashboard(media, account);

  return res.json({
    ...dashboard,
    media_sample: media.slice(0, 12)
  });
});

app.post("/api/intelligence", async (req, res) => {
  if (!ensureGroq(res)) return;

  const {
    igId,
    niche = "",
    audience = "",
    goal = "",
    tone = "",
    extra = "",
    location = ""
  } = req.body || {};

  const account = getAccountFromSession(req, igId);

  if (!account) {
    return res.status(404).json({ error: "Conta não encontrada." });
  }

  const media = await fetchMedia(account.id, account.ig_token, 20);
  const dashboard = buildDashboard(media, account);

  const userPrompt = `
Faça uma análise estratégica profunda deste perfil de Instagram.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location })}

DADOS DO DASHBOARD:
${JSON.stringify(dashboard, null, 2)}

ÚLTIMOS POSTS:
${summarizePosts(media)}

QUERO UMA LEITURA REAL DE NEGÓCIO, NÃO UMA ANÁLISE GENÉRICA.

Você deve responder:
- o que esse perfil comunica hoje
- onde ele está fraco
- onde ele perde atenção
- onde ele não gera percepção de valor
- o que está faltando no funil
- como a localização e o nicho interferem no jogo
- quais oportunidades estão mal exploradas
- o que precisa ser feito para o perfil ficar mais forte e mais vendável

RETORNE EXATAMENTE NESTE JSON:
{
  "executive_summary": "resumo estratégico em 3 a 5 frases",
  "diagnosis": {
    "positioning": "como o perfil está posicionado hoje",
    "content_strength": "o que está funcionando",
    "content_gap": "o que está faltando",
    "engagement_read": "leitura do engajamento",
    "funnel_read": "leitura do funil"
  },
  "local_market_read": "como nicho e localização influenciam o perfil",
  "opportunities": [
    "oportunidade 1",
    "oportunidade 2",
    "oportunidade 3",
    "oportunidade 4"
  ],
  "priority_actions": [
    "ação prática 1",
    "ação prática 2",
    "ação prática 3",
    "ação prática 4"
  ],
  "content_angles": [
    "ângulo forte 1",
    "ângulo forte 2",
    "ângulo forte 3",
    "ângulo forte 4",
    "ângulo forte 5"
  ],
  "bio_suggestions": [
    "bio 1",
    "bio 2",
    "bio 3"
  ]
}

REGRAS:
- não use linguagem genérica
- não escreva como diagnóstico escolar
- seja direto e consultivo
- não repita ideias parecidas
- os ângulos precisam ser fortes e úteis de verdade
`;

  try {
    const data = await callGroqJSON({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 3200
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/competitors", async (req, res) => {
  if (!ensureGroq(res)) return;

  const {
    igId,
    niche = "",
    audience = "",
    competitors = [],
    location = "",
    goal = "",
    tone = "",
    extra = ""
  } = req.body || {};

  const account = getAccountFromSession(req, igId);

  if (!account) {
    return res.status(404).json({ error: "Conta não encontrada." });
  }

  const media = await fetchMedia(account.id, account.ig_token, 15);

  const competitorsText =
    Array.isArray(competitors) && competitors.length
      ? competitors.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "Nenhum concorrente específico informado.";

  const userPrompt = `
Faça uma análise estratégica de concorrência para este perfil.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location })}

POSTS RECENTES DO PERFIL:
${summarizePosts(media)}

CONCORRENTES/REFERÊNCIAS INFORMADAS:
${competitorsText}

IMPORTANTE:
Se a lista de concorrentes estiver fraca ou vazia, use nicho + localização + público para inferir o tipo de concorrência e o tipo de referência que a empresa deveria observar.

QUERO UMA RESPOSTA DE AGÊNCIA:
- o que o mercado provavelmente valoriza
- o que os concorrentes tendem a explorar
- o que costuma saturar nesse nicho
- onde existe espaço de diferenciação
- quais temas e abordagens podem destacar essa marca
- como localização e comportamento local interferem nisso

RETORNE EXATAMENTE NESTE JSON:
{
  "market_read": "leitura do cenário competitivo",
  "local_competitive_context": "como localização e nicho influenciam o mercado",
  "suggested_reference_profiles": [
    "tipo de perfil/referência 1",
    "tipo de perfil/referência 2",
    "tipo de perfil/referência 3"
  ],
  "competitor_patterns": [
    "padrão 1",
    "padrão 2",
    "padrão 3",
    "padrão 4"
  ],
  "what_they_do_well": [
    "ponto 1",
    "ponto 2",
    "ponto 3"
  ],
  "gaps_to_exploit": [
    "gap 1",
    "gap 2",
    "gap 3",
    "gap 4"
  ],
  "positioning_differentiators": [
    "diferencial 1",
    "diferencial 2",
    "diferencial 3"
  ],
  "content_opportunities": [
    "conteúdo 1",
    "conteúdo 2",
    "conteúdo 3",
    "conteúdo 4",
    "conteúdo 5"
  ]
}

REGRAS:
- não invente dados exatos
- não faça comparação superficial
- não sugira conteúdo genérico
- use nicho + localização como parte central do raciocínio
`;

  try {
    const data = await callGroqJSON({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 3200
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate", async (req, res) => {
  if (!ensureGroq(res)) return;

  const {
    igId,
    niche = "",
    audience = "",
    goal = "",
    tone = "",
    extra = "",
    location = "",
    totalPosts = 16,
    reels = 6,
    carousels = 6,
    singlePosts = 4
  } = req.body || {};

  const account = getAccountFromSession(req, igId);

  if (!account) {
    return res.status(404).json({ error: "Conta não encontrada." });
  }

  const media = await fetchMedia(account.id, account.ig_token, 20);

  const userPrompt = `
Crie um planejamento mensal completo para Instagram com foco profissional de agência.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location })}

MIX SOLICITADO:
- Total de posts: ${totalPosts}
- Reels: ${reels}
- Carrosséis: ${carousels}
- Posts estáticos: ${singlePosts}

POSTS RECENTES:
${summarizePosts(media)}

O planejamento precisa parecer feito por um estrategista forte, não por uma IA genérica.

QUERO UM PLANO QUE:
- chame atenção
- gere identificação
- trabalhe dor, desejo, objeção e prova
- ajude a posicionar
- ajude a vender
- use o contexto do nicho e da localização
- evite completamente títulos previsíveis e conteúdos burocráticos

RETORNE EXATAMENTE NESTE JSON:
{
  "audit": {
    "summary": "resumo do plano",
    "month_strategy": "estratégia central do mês",
    "funnel_logic": "como o mês foi distribuído"
  },
  "posts": [
    {
      "n": 1,
      "week": 1,
      "day_suggestion": "Segunda",
      "format": "Reels",
      "pillar": "Autoridade",
      "title": "título forte e humano",
      "objective": "objetivo do post",
      "hook": "gancho inicial",
      "copy": "legenda completa natural e estratégica",
      "cta": "cta",
      "script": "roteiro completo se for reels",
      "carousel_slides": ["slide 1", "slide 2", "slide 3"]
    }
  ],
  "stories": [
    {
      "day": "Dia 1",
      "theme": "tema",
      "objective": "objetivo",
      "slides": [
        { "n": 1, "text": "texto do slide 1", "action": "ação" },
        { "n": 2, "text": "texto do slide 2", "action": "ação" },
        { "n": 3, "text": "texto do slide 3", "action": "ação" }
      ]
    }
  ],
  "hashtags": {
    "niche": ["#hashtag1", "#hashtag2", "#hashtag3"],
    "local": ["#local1", "#local2"],
    "broad": ["#ampla1", "#ampla2", "#ampla3"],
    "strategy": "estratégia de hashtags"
  },
  "content_pillars": [
    "pilar 1",
    "pilar 2",
    "pilar 3"
  ],
  "priority_ctas": [
    "cta 1",
    "cta 2",
    "cta 3"
  ]
}

REGRAS IMPORTANTÍSSIMAS:
- o número de posts precisa bater com o mix solicitado
- reels precisam ter script
- carrosséis precisam ter slides
- stories precisam ser úteis e práticos
- use a localização e o nicho como parte da construção das ideias
- NÃO use repetidamente ganchos como:
  "você sabia", "arraste para o lado", "sabia que", "entenda", "veja os benefícios"
- NÃO escreva títulos como:
  "a importância de", "os benefícios de", "entenda", "conheça nossa equipe", "por que isso é importante"
- varie os ângulos entre:
  dor, erro, objeção, desejo, prova, bastidor, percepção, comparação, contexto local, oportunidade comercial
- não faça todos os posts começarem do mesmo jeito
- não faça o planner parecer blog genérico
- títulos precisam ser mais magnéticos, mais humanos e mais específicos
- pense em conteúdo que alguém realmente pararia para ver

REGRAS DE COERÊNCIA ENTRE TÍTULO, GANCHO E LEGENDA:
- a legenda precisa cumprir a promessa do título e do gancho
- se o título prometer explicar algo, a legenda deve realmente explicar
- se o título levantar uma dúvida, a legenda deve responder essa dúvida
- se o título abordar um erro, a legenda deve mostrar esse erro com clareza
- se o título abordar um risco, a legenda deve explicar o risco e a consequência
- a legenda não pode ser apenas institucional ou promocional
- a legenda deve entregar valor antes de vender
- evitar legendas vagas como:
  "nossa equipe explica", "entenda mais", "saiba tudo", "conheça nossos serviços"
- o conteúdo do post deve parecer útil mesmo se o CTA for removido

REGRAS POR TIPO DE POST:
- se o post for explicativo, a legenda deve ensinar de forma simples e direta
- se o post for de dor, a legenda deve mostrar o problema de forma concreta
- se o post for de objeção, a legenda deve quebrar a objeção com lógica
- se o post for de prova, a legenda deve mostrar evidência, caso, processo ou resultado
- se o post for de autoridade, a legenda deve demonstrar conhecimento real, e não apenas dizer que a empresa entende do assunto
- se o post for comercial, a legenda pode vender mais diretamente, mas ainda precisa ter substância
`;

  try {
    const data = await callGroqJSON({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 7600,
      temperature: 0.85
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/export-pdf", (req, res) => {
  const { plan, username = "perfil" } = req.body || {};

  try {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const filename = `plano_${username}_${Date.now()}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    doc.pipe(res);

    doc.fontSize(20).text("Plano Estratégico de Instagram", { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`@${username}`, { align: "center" });
    doc.moveDown(1);

    if (plan?.audit) {
      doc.fontSize(15).text("Resumo Estratégico");
      doc.moveDown(0.3);
      doc.fontSize(10).text(`Resumo: ${plan.audit.summary || ""}`);
      doc.moveDown(0.2);
      doc.text(`Estratégia do mês: ${plan.audit.month_strategy || ""}`);
      doc.moveDown(0.2);
      doc.text(`Lógica do funil: ${plan.audit.funnel_logic || ""}`);
      doc.moveDown(1);
    }

    if (Array.isArray(plan?.posts)) {
      doc.fontSize(15).text("Posts do Mês");
      doc.moveDown(0.5);

      plan.posts.slice(0, 12).forEach((post) => {
        doc.fontSize(11).text(`#${post.n} • ${post.format} • ${post.title}`, { underline: true });
        doc.fontSize(9).text(`Objetivo: ${post.objective || ""}`);
        doc.text(`Gancho: ${post.hook || ""}`);
        doc.text(`CTA: ${post.cta || ""}`);
        doc.moveDown(0.4);
      });
    }

    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    groq: Boolean(GROQ_API_KEY),
    tokens_configured: IG_TOKENS.length,
    base_url: BASE_URL
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/app", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/");
  }
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Instagram Planner Agency 5.2 rodando em ${BASE_URL}`);
  console.log(`[INIT] GROQ configurado: ${Boolean(GROQ_API_KEY)}`);
  console.log(`[INIT] Tokens IG configurados: ${IG_TOKENS.length}`);
});
