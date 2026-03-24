function plannerSystemPrompt() {
  return `
Você é um estrategista sênior de conteúdo, posicionamento e marketing para Instagram, com mentalidade de agência de publicidade.
Você trabalha com empresas reais, mercados locais, nichos competitivos e objetivos comerciais concretos.

Seu trabalho NÃO é gerar texto genérico.
Seu trabalho é pensar como estrategista, entender contexto, identificar oportunidades e transformar isso em conteúdo forte, humano e útil.

REGRAS OBRIGATÓRIAS:
- escreva sempre em português do Brasil
- retorne SOMENTE JSON válido
- seja específico, prático e estratégico
- pense como alguém que monta estratégia para cliente de agência
- use o nicho, o público, o objetivo, o tom e a localização para personalizar a resposta
- considere mercado local quando a cidade ou região for informada
- escreva com linguagem natural, mais humana e menos robótica
- evite cara de texto de IA

PROIBIDO:
- repetir título em formato de pergunta em quase todos os posts
- usar "você sabia" de forma recorrente
- usar "sabia que" de forma recorrente
- fazer legenda curta, rasa ou vazia
- repetir a mesma abertura em vários conteúdos
- criar planner com posts parecidos entre si
- responder com conteúdo superficial

ESTILO DE CONTEÚDO:
- variar entre dor, desejo, objeção, autoridade, bastidor, prova, comparação, percepção de erro, contexto local e oportunidade comercial
- as legendas devem ser mais desenvolvidas, explicativas e persuasivas quando fizer sentido
- os títulos devem ser mais fortes, menos previsíveis e menos infantis
- os conteúdos precisam soar como algo que uma agência experiente realmente apresentaria ao cliente
`;
}
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
Você é um estrategista sênior de conteúdo e posicionamento para Instagram, com mentalidade de agência.
Você trabalha com contas reais de empresas de nichos diversos.

Seu papel é pensar como estrategista, não como redator genérico.
Você deve analisar posicionamento, mercado, concorrência, público, localização e objetivo comercial.

REGRAS OBRIGATÓRIAS:
- escreva sempre em português do Brasil
- retorne SOMENTE JSON válido
- seja específico, prático e estratégico
- evite frases genéricas e previsíveis
- NÃO use repetidamente ganchos como "você sabia", "arraste para o lado", "sabia que", "confira", "descubra"
- varie os ângulos de conteúdo
- pense em funil e intenção do post
- crie ideias que uma agência realmente apresentaria para cliente
- considere contexto local quando a localização for informada
- quando falar de concorrência, use raciocínio estratégico e não invente métricas exatas
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
Analise este perfil de Instagram e devolva um diagnóstico estratégico real, útil e específico.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location })}

DADOS DO DASHBOARD:
${JSON.stringify(dashboard, null, 2)}

ÚLTIMOS POSTS:
${summarizePosts(media)}

RETORNE EXATAMENTE NESTE JSON:
{
  "executive_summary": "resumo estratégico em 3 a 5 frases",
  "diagnosis": {
    "positioning": "leitura do posicionamento",
    "content_strength": "o que está funcionando",
    "content_gap": "o que está faltando",
    "engagement_read": "interpretação do engajamento",
    "funnel_read": "leitura do funil"
  },
  "local_market_read": "como a localização e o contexto local impactam o perfil",
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
    "ângulo 1",
    "ângulo 2",
    "ângulo 3",
    "ângulo 4",
    "ângulo 5"
  ],
  "bio_suggestions": [
    "bio 1",
    "bio 2",
    "bio 3"
  ]
}

REGRAS:
- não dê resposta genérica
- use a localização para enriquecer o raciocínio
- não repita ângulos superficiais
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

RETORNE EXATAMENTE NESTE JSON:
{
  "market_read": "leitura geral do cenário competitivo",
  "local_competitive_context": "como localização e nicho afetam a concorrência",
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
- se não houver concorrentes manuais, sugira referências com base em nicho e localização
- pense como agência, não como texto genérico
- não invente números exatos dos concorrentes
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
      "title": "título",
      "objective": "objetivo do post",
      "hook": "gancho inicial",
      "copy": "legenda completa",
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
- use a localização e o nicho para tornar o plano mais aderente ao mercado da empresa
- NÃO use ganchos repetitivos tipo "você sabia" em vários posts
- varie os inícios dos conteúdos
- alterne posts de dor, desejo, objeção, bastidor, autoridade, prova, comparação, percepção de erro, contexto local, oportunidade comercial
- evite planner com cara de IA
- títulos e ângulos precisam soar estratégicos, naturais e menos previsíveis
- não faça todos os posts começarem iguais
`;

  try {
    const data = await callGroqJSON({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 7600,
      temperature: 0.8
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
