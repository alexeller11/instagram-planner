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
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const IG_TOKENS = (process.env.IG_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

app.use(express.json({ limit: "4mb" }));
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
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");

  if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  } else if (firstBracket !== -1 && lastBracket !== -1 && firstBracket < lastBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
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
    .slice(0, 15)
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
          fields: "id,name,username,followers_count,media_count,biography,website,profile_picture_url,account_type",
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
    model: GROQ_MODEL,
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
Você é um estrategista sênior de conteúdo, copy e posicionamento para Instagram, com padrão de agência premium.

Você NÃO gera conteúdo para preencher calendário.
Você NÃO escreve como IA.
Você NÃO faz legenda vazia.
Você cria conteúdo que:
- prende atenção
- entrega substância
- gera autoridade
- gera percepção de valor
- movimenta para ação

REGRAS MÁXIMAS:
- escreva em português do Brasil
- retorne SOMENTE JSON válido
- nada de texto genérico
- nada de frases vazias
- nada de institucional sem entrega
- nada de título burocrático
- nada de "você sabia", "entenda", "veja os benefícios", "nossa equipe pode ajudar", "conheça nossos serviços"
- toda legenda precisa ter corpo, explicação, argumento ou construção
- todo reels precisa ter estrutura de cena, fala, progressão e fechamento
- todo carrossel precisa ter sequência lógica de slides
- se o título prometer algo, a legenda precisa cumprir essa promessa
- se a ideia estiver fraca, você deve reescrever mentalmente antes de responder

TIPOS DE PEÇA:
- EXPLICATIVA: ensina de forma simples e concreta
- DOR: mostra problema real e consequência
- ERRO: mostra o erro e por que ele custa caro
- OBJEÇÃO: quebra crença com lógica
- AUTORIDADE: demonstra conhecimento real, sem autopromoção vazia
- PROVA: mostra processo, evidência, caso ou bastidor
- COMERCIAL: vende com substância, não só com chamada promocional

PARA REELS:
- hook de abertura
- descrição das cenas
- fala principal
- virada / progressão
- fechamento
- CTA coerente

PARA CARROSSEL:
- capa forte
- progressão
- fechamento útil
- não repetir a mesma frase em 7 variações

PADRÃO DE QUALIDADE:
o conteúdo precisa parecer escrito por alguém que entende o nicho e quer gerar resultado real.
`;
}

function buildContextBlock({ account, niche = "", audience = "", goal = "", tone = "", extra = "", location = "" }) {
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
Use nicho, público, objetivo e localização para tornar tudo mais aderente ao contexto real.
`;
}

function normalizeFormat(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("reel")) return "Reels";
  if (raw.includes("carross")) return "Carrossel";
  if (raw.includes("carousel")) return "Carrossel";
  return "Post";
}

function buildPlannerMetaPrompt({ account, niche, audience, goal, tone, extra, location, totalPosts, reels, carousels, singlePosts, media }) {
  return `
Você vai montar a ESTRATÉGIA do mês antes de escrever as peças.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location })}

POSTS RECENTES:
${summarizePosts(media)}

MIX OBRIGATÓRIO:
- Total de posts: ${totalPosts}
- Reels: ${reels}
- Carrosséis: ${carousels}
- Posts estáticos: ${singlePosts}

RETORNE EXATAMENTE NESTE JSON:
{
  "audit": {
    "summary": "resumo do plano",
    "month_strategy": "estratégia central do mês",
    "funnel_logic": "como o mês foi distribuído"
  },
  "content_pillars": ["pilar 1", "pilar 2", "pilar 3"],
  "priority_ctas": ["cta 1", "cta 2", "cta 3"],
  "post_blueprints": [
    {
      "n": 1,
      "week": 1,
      "day_suggestion": "Segunda",
      "format": "Reels",
      "pillar": "Autoridade",
      "intent": "Dor",
      "core_angle": "qual é o ângulo central",
      "title_direction": "como o título deve soar",
      "promise": "o que esse conteúdo promete entregar",
      "objective": "objetivo do post"
    }
  ],
  "story_blueprints": [
    {
      "day": "Dia 1",
      "theme": "tema",
      "objective": "objetivo",
      "angle": "ângulo"
    }
  ],
  "hashtags": {
    "niche": ["#hashtag1", "#hashtag2", "#hashtag3"],
    "local": ["#local1", "#local2"],
    "broad": ["#ampla1", "#ampla2", "#ampla3"],
    "strategy": "estratégia de hashtags"
  }
}

REGRAS:
- criar EXATAMENTE ${totalPosts} blueprints
- criar EXATAMENTE ${reels} blueprints com format "Reels"
- criar EXATAMENTE ${carousels} blueprints com format "Carrossel"
- criar EXATAMENTE ${singlePosts} blueprints com format "Post"
- não repetir ângulo
- variar entre dor, erro, objeção, prova, bastidor, desejo, percepção, contexto local e venda
`;
}

function buildPlannerWritingPrompt(metaPlan) {
  return `
Agora escreva as peças completas do planner abaixo.

ESTRATÉGIA DEFINIDA:
${JSON.stringify(metaPlan, null, 2)}

RETORNE EXATAMENTE NESTE JSON:
{
  "audit": ${JSON.stringify(metaPlan.audit || {}, null, 2)},
  "content_pillars": ${JSON.stringify(metaPlan.content_pillars || [], null, 2)},
  "priority_ctas": ${JSON.stringify(metaPlan.priority_ctas || [], null, 2)},
  "hashtags": ${JSON.stringify(metaPlan.hashtags || {}, null, 2)},
  "posts": [
    {
      "n": 1,
      "week": 1,
      "day_suggestion": "Segunda",
      "format": "Reels",
      "pillar": "Autoridade",
      "intent": "Dor",
      "title": "título forte",
      "objective": "objetivo do post",
      "hook": "gancho forte",
      "copy": "legenda completa, robusta, com substância",
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
  ]
}

REGRAS DE ESCRITA:
- escrever EXATAMENTE a mesma quantidade de posts dos blueprints
- manter os formatos dos blueprints
- toda legenda deve ter substância real
- toda legenda deve cumprir a promessa do título
- se for explicativo, precisa explicar
- se for de erro, precisa mostrar o erro e a consequência
- se for de objeção, precisa quebrar a objeção
- se for comercial, pode vender, mas com argumento
- reels precisam ter script com cena, fala, progressão e fechamento
- carrosséis precisam ter slides com progressão lógica
- posts estáticos não precisam de carousel_slides
- não usar textos vazios como:
  "nossa equipe explica", "podemos ajudar", "veja como", "entenda melhor", "saiba mais"
- não gerar legendas curtas demais
`;
}

function buildPlannerReviewPrompt(draftPlan) {
  return `
Você vai atuar como revisor sênior de agência.

Revise o planner abaixo e MELHORE o que estiver:
- genérico
- vazio
- institucional demais
- repetitivo
- sem entrega
- sem profundidade
- com reels fracos
- com carrosséis fracos

NÃO resuma.
MELHORE o texto.

RETORNE NO MESMO FORMATO JSON, COMPLETO:
${JSON.stringify(draftPlan, null, 2)}

REGRAS:
- não alterar a quantidade de posts
- não alterar a distribuição de formatos
- legenda precisa soar útil
- título precisa ser magnético
- reels precisam ter script forte
- não pode haver legenda oca
- não pode haver frase vaga
- se o conteúdo prometer explicar algo, ele deve explicar
`;
}

function forcePlannerMix(plan, { totalPosts, reels, carousels, singlePosts }) {
  if (!plan || !Array.isArray(plan.posts)) return plan;

  let posts = plan.posts.map((post, idx) => ({
    ...post,
    n: idx + 1,
    format: normalizeFormat(post.format)
  }));

  const desiredFormats = [
    ...Array(reels).fill("Reels"),
    ...Array(carousels).fill("Carrossel"),
    ...Array(singlePosts).fill("Post")
  ];

  if (desiredFormats.length !== totalPosts) {
    throw new Error("O mix solicitado não bate com o total de posts.");
  }

  if (posts.length < totalPosts) {
    const last = posts[posts.length - 1] || {
      week: 1,
      day_suggestion: "Segunda",
      pillar: "Autoridade",
      intent: "Autoridade",
      title: "Post a complementar",
      objective: "complementar o plano",
      hook: "Hook a complementar",
      copy: "Conteúdo complementar a aprofundar.",
      cta: "Fale conosco"
    };

    while (posts.length < totalPosts) {
      posts.push({
        ...last,
        n: posts.length + 1,
        title: `${last.title} ${posts.length + 1}`,
        format: "Post"
      });
    }
  }

  if (posts.length > totalPosts) {
    posts = posts.slice(0, totalPosts);
  }

  posts = posts.map((post, idx) => ({
    ...post,
    n: idx + 1,
    format: desiredFormats[idx]
  }));

  return {
    ...plan,
    posts
  };
}

function enforcePlannerQuality(plan) {
  if (!plan || !Array.isArray(plan.posts)) return plan;

  const bannedFragments = [
    "nossa equipe explica",
    "podemos ajudar",
    "saiba tudo",
    "entenda mais",
    "conheça nossos serviços",
    "veja como podemos ajudar",
    "nossa equipe especializada",
    "veja como"
  ];

  plan.posts = plan.posts.map((post) => {
    let copy = String(post.copy || "").trim();
    let script = String(post.script || "").trim();

    if (copy.length < 260) {
      copy += "\n\nAprofunde este conteúdo com explicação prática, consequência real e orientação clara para o leitor.";
    }

    for (const fragment of bannedFragments) {
      if (copy.toLowerCase().includes(fragment)) {
        copy += "\n\nSubstitua discurso institucional por explicação concreta, argumento ou orientação prática.";
        break;
      }
    }

    if (post.format === "Reels" && script.length < 260) {
      script += "\n\nCena 1: abertura visual forte.\nCena 2: contexto do problema.\nCena 3: explicação prática.\nCena 4: consequência ou virada.\nCena 5: fechamento com CTA.";
    }

    if (post.format === "Carrossel") {
      if (!Array.isArray(post.carousel_slides) || post.carousel_slides.length < 5) {
        post.carousel_slides = [
          post.title || "Tema do carrossel",
          "Abra o assunto com contexto real.",
          "Explique o ponto central com clareza.",
          "Mostre consequência, erro ou oportunidade.",
          "Feche com orientação prática."
        ];
      }
    } else {
      post.carousel_slides = [];
    }

    if (post.format !== "Reels") {
      post.script = "";
    }

    return {
      ...post,
      copy,
      script
    };
  });

  return plan;
}

async function generateAgencyLevelPlanner({ account, niche, audience, goal, tone, extra, location, totalPosts, reels, carousels, singlePosts, media }) {
  const system = plannerSystemPrompt();

  const metaPlan = await callGroqJSON({
    system,
    user: buildPlannerMetaPrompt({
      account,
      niche,
      audience,
      goal,
      tone,
      extra,
      location,
      totalPosts,
      reels,
      carousels,
      singlePosts,
      media
    }),
    maxTokens: 4500,
    temperature: 0.75
  });

  const draftPlan = await callGroqJSON({
    system,
    user: buildPlannerWritingPrompt(metaPlan),
    maxTokens: 8000,
    temperature: 0.85
  });

  const reviewedPlan = await callGroqJSON({
    system,
    user: buildPlannerReviewPrompt(draftPlan),
    maxTokens: 8000,
    temperature: 0.72
  });

  const mixed = forcePlannerMix(reviewedPlan, { totalPosts, reels, carousels, singlePosts });
  return enforcePlannerQuality(mixed);
}

function renderPostToPdf(doc, post) {
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111").text(`#${post.n} • ${post.format} • ${post.title}`);
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(10).fillColor("#555555");
  doc.text(`Objetivo: ${post.objective || ""}`);
  doc.text(`Pilar: ${post.pillar || ""} | Intenção: ${post.intent || ""} | Sugestão de dia: ${post.day_suggestion || ""}`);
  doc.moveDown(0.5);

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111").text("Gancho");
  doc.font("Helvetica").fontSize(10).text(post.hook || "");
  doc.moveDown(0.5);

  doc.font("Helvetica-Bold").fontSize(11).text("Legenda");
  doc.font("Helvetica").fontSize(10).text(post.copy || "");
  doc.moveDown(0.5);

  if (post.format === "Reels" && post.script) {
    doc.font("Helvetica-Bold").fontSize(11).text("Roteiro do reels");
    doc.font("Helvetica").fontSize(10).text(post.script);
    doc.moveDown(0.5);
  }

  if (post.format === "Carrossel" && Array.isArray(post.carousel_slides) && post.carousel_slides.length) {
    doc.font("Helvetica-Bold").fontSize(11).text("Slides do carrossel");
    doc.font("Helvetica").fontSize(10);
    post.carousel_slides.forEach((slide, idx) => doc.text(`${idx + 1}. ${slide}`));
    doc.moveDown(0.5);
  }

  doc.font("Helvetica-Bold").fontSize(11).text("CTA");
  doc.font("Helvetica").fontSize(10).text(post.cta || "");
}

app.post("/api/suggest", async (req, res) => {
  if (!ensureGroq(res)) return;

  const { igId } = req.body || {};
  const account = getAccountFromSession(req, igId);

  if (!account) {
    return res.status(404).json({ error: "Conta não encontrada." });
  }

  const media = await fetchMedia(account.id, account.ig_token, 18);

  const prompt = `
Faça um auto preenchimento estratégico para esta conta de Instagram.

PERFIL:
- @${account.username}
- Nome: ${account.name || ""}
- Bio: ${account.biography || ""}
- Website: ${account.website || ""}
- Seguidores: ${account.followers_count || 0}

POSTS RECENTES:
${summarizePosts(media)}

RETORNE EXATAMENTE NESTE JSON:
{
  "niche": "nicho sugerido",
  "audience": "público sugerido",
  "goal": "objetivo sugerido",
  "tone": "tom de voz sugerido",
  "location": "localização provável ou sugerida",
  "extra": "contexto estratégico curto"
}

REGRAS:
- seja específico
- use o nome, bio e posts para inferir
- se não souber a localização com precisão, dê uma sugestão plausível curta, ou deixe vazio
`;

  try {
    const data = await callGroqJSON({
      system: plannerSystemPrompt(),
      user: prompt,
      maxTokens: 1200,
      temperature: 0.4
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/auth", async (req, res) => {
  if (!IG_TOKENS.length) {
    return res.status(400).json({ success: false, error: "Nenhum token configurado em IG_TOKENS." });
  }

  try {
    const accounts = await fetchIGProfiles(IG_TOKENS);

    if (!accounts.length) {
      return res.status(400).json({ success: false, error: "Nenhuma conta foi carregada com os tokens atuais." });
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
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ logged: false, accounts: [] });
  return res.json({ logged: true, accounts: req.session.user.accounts || [] });
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.post("/api/test-token", async (req, res) => {
  const token = (req.body?.token || "").trim();
  if (!token) return res.status(400).json({ success: false, error: "Token vazio." });

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
  if (!account) return res.status(404).json({ error: "Conta não encontrada na sessão." });

  const media = await fetchMedia(account.id, account.ig_token, 30);
  const dashboard = buildDashboard(media, account);

  return res.json({
    ...dashboard,
    media_sample: media.slice(0, 12)
  });
});

app.post("/api/intelligence", async (req, res) => {
  if (!ensureGroq(res)) return;

  const { igId, niche = "", audience = "", goal = "", tone = "", extra = "", location = "" } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 20);
  const dashboard = buildDashboard(media, account);

  const userPrompt = `
Faça uma análise estratégica profunda deste perfil de Instagram.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location })}

DADOS DO DASHBOARD:
${JSON.stringify(dashboard, null, 2)}

ÚLTIMOS POSTS:
${summarizePosts(media)}

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
  "opportunities": ["oportunidade 1", "oportunidade 2", "oportunidade 3", "oportunidade 4"],
  "priority_actions": ["ação prática 1", "ação prática 2", "ação prática 3", "ação prática 4"],
  "content_angles": ["ângulo forte 1", "ângulo forte 2", "ângulo forte 3", "ângulo forte 4", "ângulo forte 5"],
  "bio_suggestions": ["bio 1", "bio 2", "bio 3"]
}
`;

  try {
    const data = await callGroqJSON({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 3400,
      temperature: 0.7
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
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

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

RETORNE EXATAMENTE NESTE JSON:
{
  "market_read": "leitura do cenário competitivo",
  "local_competitive_context": "como localização e nicho influenciam o mercado",
  "suggested_reference_profiles": ["tipo de perfil 1", "tipo de perfil 2", "tipo de perfil 3"],
  "competitor_patterns": ["padrão 1", "padrão 2", "padrão 3", "padrão 4"],
  "what_they_do_well": ["ponto 1", "ponto 2", "ponto 3"],
  "gaps_to_exploit": ["gap 1", "gap 2", "gap 3", "gap 4"],
  "positioning_differentiators": ["diferencial 1", "diferencial 2", "diferencial 3"],
  "content_opportunities": ["conteúdo 1", "conteúdo 2", "conteúdo 3", "conteúdo 4", "conteúdo 5"]
}
`;

  try {
    const data = await callGroqJSON({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 3400,
      temperature: 0.72
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
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  try {
    if (Number(totalPosts) !== Number(reels) + Number(carousels) + Number(singlePosts)) {
      return res.status(400).json({
        error: "O total de posts precisa ser exatamente a soma de reels + carrosséis + estáticos."
      });
    }

    const media = await fetchMedia(account.id, account.ig_token, 20);

    const plan = await generateAgencyLevelPlanner({
      account,
      niche,
      audience,
      goal,
      tone,
      extra,
      location,
      totalPosts: Number(totalPosts),
      reels: Number(reels),
      carousels: Number(carousels),
      singlePosts: Number(singlePosts),
      media
    });

    return res.json(plan);
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

    doc.rect(0, 0, doc.page.width, 170).fill("#19152f");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24).text("PLANO ESTRATÉGICO DE INSTAGRAM", 40, 50, {
      width: doc.page.width - 80,
      align: "center"
    });
    doc.font("Helvetica").fontSize(12).text(`@${username}`, 40, 95, {
      width: doc.page.width - 80,
      align: "center"
    });

    doc.moveDown(7);
    doc.fillColor("#111111");

    if (plan?.audit) {
      doc.font("Helvetica-Bold").fontSize(16).text("Resumo executivo");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(11).text(plan.audit.summary || "");
      doc.moveDown(0.5);

      doc.font("Helvetica-Bold").fontSize(12).text("Estratégia do mês");
      doc.font("Helvetica").fontSize(10).text(plan.audit.month_strategy || "");
      doc.moveDown(0.4);

      doc.font("Helvetica-Bold").fontSize(12).text("Lógica do funil");
      doc.font("Helvetica").fontSize(10).text(plan.audit.funnel_logic || "");
      doc.moveDown(0.8);
    }

    if (Array.isArray(plan?.content_pillars) && plan.content_pillars.length) {
      doc.font("Helvetica-Bold").fontSize(12).text("Pilares");
      doc.font("Helvetica").fontSize(10).text(plan.content_pillars.join(" • "));
      doc.moveDown(0.5);
    }

    if (Array.isArray(plan?.priority_ctas) && plan.priority_ctas.length) {
      doc.font("Helvetica-Bold").fontSize(12).text("CTAs prioritários");
      doc.font("Helvetica").fontSize(10).text(plan.priority_ctas.join(" • "));
      doc.moveDown(0.8);
    }

    if (Array.isArray(plan?.posts) && plan.posts.length) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(18).text("Calendário resumido");
      doc.moveDown(0.7);

      plan.posts.forEach((post) => {
        doc.font("Helvetica-Bold").fontSize(11).text(`#${post.n} • ${post.day_suggestion || ""} • ${post.format || ""}`);
        doc.font("Helvetica").fontSize(10).text(post.title || "");
        doc.moveDown(0.4);
      });
    }

    if (Array.isArray(plan?.posts)) {
      plan.posts.forEach((post) => {
        doc.addPage();
        renderPostToPdf(doc, post);
      });
    }

    if (Array.isArray(plan?.stories) && plan.stories.length) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(18).text("Sequências de stories");
      doc.moveDown(0.7);

      plan.stories.forEach((story) => {
        doc.font("Helvetica-Bold").fontSize(13).text(`${story.day || ""} • ${story.theme || ""}`);
        doc.font("Helvetica").fontSize(10).text(`Objetivo: ${story.objective || ""}`);
        doc.moveDown(0.3);

        (story.slides || []).forEach((slide) => {
          doc.text(`Slide ${slide.n}: ${slide.text} (${slide.action || "ação"})`);
        });

        doc.moveDown(0.8);
      });
    }

    if (plan?.hashtags) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(18).text("Hashtags e observações");
      doc.moveDown(0.7);

      doc.font("Helvetica-Bold").fontSize(12).text("Nicho");
      doc.font("Helvetica").fontSize(10).text((plan.hashtags.niche || []).join(" "));
      doc.moveDown(0.4);

      doc.font("Helvetica-Bold").fontSize(12).text("Local");
      doc.font("Helvetica").fontSize(10).text((plan.hashtags.local || []).join(" "));
      doc.moveDown(0.4);

      doc.font("Helvetica-Bold").fontSize(12).text("Amplas");
      doc.font("Helvetica").fontSize(10).text((plan.hashtags.broad || []).join(" "));
      doc.moveDown(0.6);

      doc.font("Helvetica-Bold").fontSize(12).text("Estratégia");
      doc.font("Helvetica").fontSize(10).text(plan.hashtags.strategy || "");
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
    base_url: BASE_URL,
    model: GROQ_MODEL
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/app", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.get("/privacy.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Instagram Planner Agency 5.5 rodando em ${BASE_URL}`);
  console.log(`[INIT] GROQ configurado: ${Boolean(GROQ_API_KEY)}`);
  console.log(`[INIT] Tokens IG configurados: ${IG_TOKENS.length}`);
});
