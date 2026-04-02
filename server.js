require("dotenv").config();

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");
const { chromium } = require("playwright");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";

const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const IG_TOKENS = (process.env.IG_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

app.use(express.json({ limit: "8mb" }));
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

const DATA_DIR = path.join(__dirname, "data");
const CLIENTS_DIR = path.join(DATA_DIR, "clients");
const DEFAULT_CLIENT_PATH = path.join(CLIENTS_DIR, "default.json");
const PUBLIC_TMP_DIR = path.join(__dirname, "public", "tmp");
const LOGO_PATH = path.join(__dirname, "public", "assets", "ideale-logo.png");

function ensureDirs() {
  [DATA_DIR, CLIENTS_DIR, PUBLIC_TMP_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  if (!fs.existsSync(DEFAULT_CLIENT_PATH)) {
    fs.writeFileSync(
      DEFAULT_CLIENT_PATH,
      JSON.stringify(
        {
          niche: "",
          audience: "",
          location: "",
          tone: "",
          goals: [],
          differentials: [],
          cta_style: "",
          forbidden_words: [
            "você sabia",
            "entenda",
            "saiba mais",
            "nossa equipe explica",
            "podemos ajudar",
            "veja como"
          ],
          memory: {
            what_works: [],
            what_doesnt_work: [],
            strong_angles: []
          }
        },
        null,
        2
      )
    );
  }
}

ensureDirs();

function sanitizeFileName(value) {
  return String(value || "cliente")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .toLowerCase();
}

function ensureAtLeastOneModel(res) {
  if (!groq && !gemini) {
    res.status(500).json({ error: "Configure GROQ_API_KEY ou GEMINI_API_KEY." });
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

function summarizePosts(media = [], maxItems = 8, captionMax = 120) {
  return media
    .slice(0, maxItems)
    .map((m, i) => {
      const caption = compactText(m.caption || "Sem legenda", captionMax);
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
    throw new Error("Groq retornou JSON inválido.");
  }

  return parsed;
}

async function callGeminiJSON({ system, user }) {
  if (!gemini) throw new Error("GEMINI_API_KEY não configurada");

  const prompt = `${system}\n\n${user}`;

  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  });

  const text = response.text || "";
  const parsed = safeJsonParse(text);

  if (!parsed) {
    throw new Error("Gemini retornou JSON inválido.");
  }

  return parsed;
}

function shouldFallbackToGemini(error) {
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("request too large") ||
    msg.includes("tokens per minute") ||
    msg.includes("rate_limit_exceeded") ||
    (msg.includes("requested") && msg.includes("limit"))
  );
}

async function callAIWithFallback({ system, user, maxTokens = 4096, temperature = 0.7 }) {
  if (groq) {
    try {
      return await callGroqJSON({ system, user, maxTokens, temperature });
    } catch (error) {
      console.log("[AI] Groq falhou:", error.message);

      if (gemini && shouldFallbackToGemini(error)) {
        console.log("[AI] Usando fallback para Gemini...");
        return await callGeminiJSON({ system, user });
      }

      if (!gemini) throw error;

      console.log("[AI] Groq falhou por outro motivo, tentando Gemini...");
      return await callGeminiJSON({ system, user });
    }
  }

  return await callGeminiJSON({ system, user });
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
  const engagementAverage = avg(
    media.map((m) => Number(m.like_count || 0) + Number(m.comments_count || 0))
  );
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

function getClientFilePath(username) {
  return path.join(CLIENTS_DIR, `${sanitizeFileName(username)}.json`);
}

function getClientMemory(username) {
  const clientPath = getClientFilePath(username);
  try {
    if (fs.existsSync(clientPath)) {
      return JSON.parse(fs.readFileSync(clientPath, "utf8"));
    }
    return JSON.parse(fs.readFileSync(DEFAULT_CLIENT_PATH, "utf8"));
  } catch {
    return JSON.parse(fs.readFileSync(DEFAULT_CLIENT_PATH, "utf8"));
  }
}

function saveClientMemory(username, data) {
  const clientPath = getClientFilePath(username);
  fs.writeFileSync(clientPath, JSON.stringify(data, null, 2));
}

function mergeClientMemory(username, patch) {
  const current = getClientMemory(username);
  const merged = {
    ...current,
    ...patch,
    memory: {
      ...(current.memory || {}),
      ...(patch.memory || {})
    }
  };
  saveClientMemory(username, merged);
  return merged;
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
`;
}

function buildMemorySummary(clientMemory = {}) {
  return {
    differentials: (clientMemory.differentials || []).slice(0, 5),
    cta_style: clientMemory.cta_style || "",
    what_works: (clientMemory.memory?.what_works || []).slice(0, 5),
    what_doesnt_work: (clientMemory.memory?.what_doesnt_work || []).slice(0, 5),
    strong_angles: (clientMemory.memory?.strong_angles || []).slice(0, 5),
    forbidden_words: (clientMemory.forbidden_words || []).slice(0, 5)
  };
}

function buildContextBlock({
  account,
  niche = "",
  audience = "",
  goal = "",
  tone = "",
  extra = "",
  location = "",
  clientMemory = {}
}) {
  const mem = buildMemorySummary(clientMemory);

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

MEMÓRIA DO CLIENTE:
- Diferenciais: ${mem.differentials.join(", ")}
- Estilo de CTA: ${mem.cta_style}
- O que funciona: ${mem.what_works.join(", ")}
- O que não funciona: ${mem.what_doesnt_work.join(", ")}
- Ângulos fortes: ${mem.strong_angles.join(", ")}
- Palavras proibidas: ${mem.forbidden_words.join(", ")}
`;
}

function normalizeFormat(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("reel")) return "Reels";
  if (raw.includes("carross")) return "Carrossel";
  if (raw.includes("carousel")) return "Carrossel";
  return "Post";
}

function getModeInstruction(mode) {
  const map = {
    autoridade: "focar em profundidade técnica, autoridade e percepção de referência",
    conversao: "focar em ação, argumento comercial, desejo e geração de demanda",
    engajamento: "focar em retenção, identificação e conversa com o público",
    prova: "focar em evidência, processo, bastidor, caso e validação"
  };
  return map[mode] || "equilibrar autoridade, retenção e conversão";
}

function buildPlannerMetaPrompt({
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
  media,
  clientMemory,
  mode
}) {
  return `
Você vai montar a ESTRATÉGIA do mês antes de escrever as peças.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location, clientMemory })}

POSTS RECENTES:
${summarizePosts(media, 6, 90)}

MODO DE GERAÇÃO:
${getModeInstruction(mode)}

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
`;
}

function buildPlannerWritingPrompt(metaPlan, mode, startIndex, endIndex) {
  const selected = (metaPlan.post_blueprints || []).slice(startIndex, endIndex);

  return `
Agora escreva as peças completas APENAS para estes blueprints.

MODO DE GERAÇÃO:
${getModeInstruction(mode)}

BLUEPRINTS SELECIONADOS:
${JSON.stringify(selected, null, 2)}

RETORNE EXATAMENTE NESTE JSON:
{
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
  ]
}
`;
}

function buildStoriesPrompt(metaPlan) {
  const selected = (metaPlan.story_blueprints || []).slice(0, 6);

  return `
Escreva as sequências de stories abaixo.

BLUEPRINTS:
${JSON.stringify(selected, null, 2)}

RETORNE EXATAMENTE NESTE JSON:
{
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
`;
}

function buildPlannerReviewPrompt(draftPlan) {
  const compactReviewObject = {
    posts: (draftPlan.posts || []).map((p) => ({
      n: p.n,
      format: p.format,
      title: p.title,
      hook: p.hook,
      copy: p.copy,
      cta: p.cta,
      script: p.script,
      carousel_slides: p.carousel_slides
    }))
  };

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

RETORNE EXATAMENTE NESTE JSON:
${JSON.stringify(compactReviewObject, null, 2)}
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
      title: "Post complementar",
      objective: "complementar o plano",
      hook: "Gancho complementar",
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

function qualityCheck(plan) {
  if (!plan || !Array.isArray(plan.posts)) return plan;

  const weakPatterns = [
    "nossa equipe",
    "saiba mais",
    "entenda",
    "podemos ajudar",
    "veja como",
    "conheça nossos serviços"
  ];

  plan.posts = plan.posts.map((post) => {
    let copy = String(post.copy || "").trim();
    let script = String(post.script || "").trim();

    if (copy.length < 220) {
      copy += "\n\nExplique melhor o contexto, mostre consequência real e detalhe prático para o leitor.";
    }

    weakPatterns.forEach((pattern) => {
      if (copy.toLowerCase().includes(pattern)) {
        copy += "\n\nSubstitua linguagem institucional por explicação prática, argumento ou consequência concreta.";
      }
    });

    if (post.format === "Reels" && script.length < 180) {
      script +=
        "\n\nCena 1: abertura forte.\nCena 2: contexto do problema.\nCena 3: explicação prática.\nCena 4: consequência ou virada.\nCena 5: fechamento com CTA.";
    }

    if (post.format === "Carrossel") {
      if (!Array.isArray(post.carousel_slides) || post.carousel_slides.length < 5) {
        post.carousel_slides = [
          post.title || "Tema do carrossel",
          "Contextualize o problema ou a dúvida.",
          "Aprofunde a explicação com clareza.",
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

function scorePostQuality(post) {
  let score = 0;
  const title = String(post.title || "");
  const hook = String(post.hook || "");
  const copy = String(post.copy || "");
  const script = String(post.script || "");
  const slides = Array.isArray(post.carousel_slides) ? post.carousel_slides : [];

  if (title.length >= 20 && title.length <= 85) score += 20;
  else if (title.length >= 12) score += 12;

  if (hook.length >= 20) score += 15;
  if (copy.length >= 260) score += 25;
  else if (copy.length >= 180) score += 15;

  if (post.format === "Reels") {
    if (script.length >= 220) score += 20;
    else if (script.length >= 140) score += 10;
  }

  if (post.format === "Carrossel") {
    if (slides.length >= 5) score += 20;
    else if (slides.length >= 3) score += 10;
  }

  const weakPatterns = [
    "nossa equipe",
    "saiba mais",
    "entenda",
    "podemos ajudar",
    "veja como",
    "conheça nossos serviços"
  ];

  let penalty = 0;
  weakPatterns.forEach((p) => {
    if (copy.toLowerCase().includes(p)) penalty += 8;
  });

  const finalScore = Math.max(0, Math.min(100, score - penalty));

  let label = "Fraco";
  if (finalScore >= 80) label = "Muito forte";
  else if (finalScore >= 65) label = "Bom";
  else if (finalScore >= 45) label = "Regular";

  return {
    score: finalScore,
    label
  };
}

function updateMemory(username, plan) {
  const current = getClientMemory(username);
  const titles = (plan.posts || []).map((p) => p.title).filter(Boolean);
  const intents = (plan.posts || []).map((p) => p.intent).filter(Boolean);

  const merged = {
    ...current,
    memory: {
      ...(current.memory || {}),
      what_works: [...new Set([...(current.memory?.what_works || []), ...titles.slice(0, 5)])],
      what_doesnt_work: [...new Set([...(current.memory?.what_doesnt_work || [])])],
      strong_angles: [...new Set([...(current.memory?.strong_angles || []), ...intents.slice(0, 5)])]
    }
  };

  saveClientMemory(username, merged);
}

async function generateAgencyLevelPlanner({
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
  media,
  mode,
  clientMemory
}) {
  const system = plannerSystemPrompt();

  const metaPlan = await callAIWithFallback({
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
      media,
      clientMemory,
      mode
    }),
    maxTokens: 2800,
    temperature: 0.75
  });

  const batchSize = 5;
  const postBatches = [];
  for (let i = 0; i < totalPosts; i += batchSize) {
    postBatches.push([i, Math.min(i + batchSize, totalPosts)]);
  }

  let posts = [];
  for (const [start, end] of postBatches) {
    const batch = await callAIWithFallback({
      system,
      user: buildPlannerWritingPrompt(metaPlan, mode, start, end),
      maxTokens: 3200,
      temperature: 0.82
    });

    posts = posts.concat(batch.posts || []);
  }

  const storiesResponse = await callAIWithFallback({
    system,
    user: buildStoriesPrompt(metaPlan),
    maxTokens: 1800,
    temperature: 0.72
  });

  const draftPlan = {
    audit: metaPlan.audit || {},
    content_pillars: metaPlan.content_pillars || [],
    priority_ctas: metaPlan.priority_ctas || [],
    hashtags: metaPlan.hashtags || {},
    posts,
    stories: storiesResponse.stories || []
  };

  const reviewedSubset = await callAIWithFallback({
    system,
    user: buildPlannerReviewPrompt(draftPlan),
    maxTokens: 3200,
    temperature: 0.65
  });

  const reviewedPostsMap = new Map(
    (reviewedSubset.posts || []).map((p) => [Number(p.n), p])
  );

  draftPlan.posts = draftPlan.posts.map((p) => {
    const rev = reviewedPostsMap.get(Number(p.n));
    return rev ? { ...p, ...rev } : p;
  });

  const mixed = forcePlannerMix(draftPlan, { totalPosts, reels, carousels, singlePosts });
  const qualityChecked = qualityCheck(mixed);

  qualityChecked.posts = (qualityChecked.posts || []).map((post) => {
    const q = scorePostQuality(post);
    return {
      ...post,
      quality_score: q.score,
      quality_label: q.label
    };
  });

  return qualityChecked;
}

async function captureInstagramProfileScreenshot(username) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 2200 }
    });

    const cleanUsername = String(username || "").replace("@", "").trim();
    const url = `https://www.instagram.com/${cleanUsername}/`;

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(3500);

    const bodyText = await page.textContent("body").catch(() => "");
    const lower = String(bodyText || "").toLowerCase();

    if (
      lower.includes("login") ||
      lower.includes("entrar") ||
      lower.includes("sign up") ||
      lower.includes("something went wrong")
    ) {
      throw new Error("Instagram bloqueou a visualização pública para este perfil.");
    }

    const filename = `competitor_${cleanUsername}_${Date.now()}.png`;
    const filepath = path.join(PUBLIC_TMP_DIR, filename);

    await page.screenshot({
      path: filepath,
      fullPage: true
    });

    return {
      success: true,
      imageUrl: `/tmp/${filename}`,
      sourceUrl: url
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

function addPdfCover(doc, title, subtitle = "") {
  doc.rect(0, 0, doc.page.width, 170).fill("#19152f");

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 40, 36, { fit: [140, 70] });
  }

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24).text(title, 40, 90, {
    width: doc.page.width - 80,
    align: "center"
  });

  if (subtitle) {
    doc.font("Helvetica").fontSize(12).text(subtitle, 40, 120, {
      width: doc.page.width - 80,
      align: "center"
    });
  }

  doc.moveDown(7);
  doc.fillColor("#111111");
}

function addSectionTitle(doc, title) {
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111").text(title);
  doc.moveDown(0.4);
}

function addListItems(doc, items = []) {
  doc.font("Helvetica").fontSize(10);
  items.forEach((item) => {
    doc.text(`• ${item}`);
  });
  doc.moveDown(0.4);
}

function renderPostToPdf(doc, post) {
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111").text(`#${post.n} • ${post.format} • ${post.title}`);
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(10).fillColor("#555555");
  doc.text(`Objetivo: ${post.objective || ""}`);
  doc.text(`Pilar: ${post.pillar || ""} | Intenção: ${post.intent || ""} | Sugestão de dia: ${post.day_suggestion || ""}`);
  doc.text(`Score: ${post.quality_score || 0} (${post.quality_label || "-"})`);
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

app.post("/api/export-report", async (req, res) => {
  try {
    const { type, username = "perfil", payload = {} } = req.body || {};
    const doc = new PDFDocument({ margin: 40, size: "A4" });

    const filename = `${type || "relatorio"}_${sanitizeFileName(username)}_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    doc.pipe(res);

    const titles = {
      planner: "PLANEJAMENTO DE INSTAGRAM",
      intelligence: "ANÁLISE ESTRATÉGICA",
      competitors: "ANÁLISE DE CONCORRÊNCIA",
      memory: "MEMÓRIA DO CLIENTE"
    };

    addPdfCover(doc, titles[type] || "RELATÓRIO", `@${username}`);

    if (type === "planner") {
      if (payload.audit) {
        addSectionTitle(doc, "Resumo executivo");
        doc.font("Helvetica").fontSize(11).text(payload.audit.summary || "");
        doc.moveDown(0.5);

        addSectionTitle(doc, "Estratégia do mês");
        doc.font("Helvetica").fontSize(10).text(payload.audit.month_strategy || "");
        doc.moveDown(0.4);

        addSectionTitle(doc, "Lógica do funil");
        doc.font("Helvetica").fontSize(10).text(payload.audit.funnel_logic || "");
        doc.moveDown(0.6);
      }

      addSectionTitle(doc, "Pilares");
      doc.font("Helvetica").fontSize(10).text((payload.content_pillars || []).join(" • "));
      doc.moveDown(0.5);

      addSectionTitle(doc, "CTAs prioritários");
      doc.font("Helvetica").fontSize(10).text((payload.priority_ctas || []).join(" • "));
      doc.moveDown(0.6);

      if (Array.isArray(payload.posts)) {
        doc.addPage();
        addSectionTitle(doc, "Calendário resumido");
        payload.posts.forEach((post) => {
          doc.font("Helvetica-Bold").fontSize(11).text(`#${post.n} • ${post.day_suggestion || ""} • ${post.format || ""}`);
          doc.font("Helvetica").fontSize(10).text(post.title || "");
          doc.moveDown(0.4);
        });

        payload.posts.forEach((post) => {
          doc.addPage();
          renderPostToPdf(doc, post);
        });
      }

      if (Array.isArray(payload.stories) && payload.stories.length) {
        doc.addPage();
        addSectionTitle(doc, "Sequências de stories");
        payload.stories.forEach((story) => {
          doc.font("Helvetica-Bold").fontSize(12).text(`${story.day || ""} • ${story.theme || ""}`);
          doc.font("Helvetica").fontSize(10).text(`Objetivo: ${story.objective || ""}`);
          doc.moveDown(0.2);
          (story.slides || []).forEach((slide) => {
            doc.text(`Slide ${slide.n}: ${slide.text} (${slide.action || "ação"})`);
          });
          doc.moveDown(0.8);
        });
      }
    }

    if (type === "intelligence") {
      addSectionTitle(doc, "Resumo executivo");
      doc.font("Helvetica").fontSize(10).text(payload.executive_summary || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Diagnóstico");
      doc.font("Helvetica").fontSize(10).text(`Posicionamento: ${payload.diagnosis?.positioning || ""}`);
      doc.text(`Força atual: ${payload.diagnosis?.content_strength || ""}`);
      doc.text(`Gap: ${payload.diagnosis?.content_gap || ""}`);
      doc.text(`Engajamento: ${payload.diagnosis?.engagement_read || ""}`);
      doc.text(`Funil: ${payload.diagnosis?.funnel_read || ""}`);
      doc.moveDown(0.6);

      addSectionTitle(doc, "Leitura local");
      doc.font("Helvetica").fontSize(10).text(payload.local_market_read || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Oportunidades");
      addListItems(doc, payload.opportunities || []);

      addSectionTitle(doc, "Ações prioritárias");
      addListItems(doc, payload.priority_actions || []);

      addSectionTitle(doc, "Ângulos de conteúdo");
      addListItems(doc, payload.content_angles || []);

      addSectionTitle(doc, "Sugestões de bio");
      addListItems(doc, payload.bio_suggestions || []);
    }

    if (type === "competitors") {
      addSectionTitle(doc, "Leitura do mercado");
      doc.font("Helvetica").fontSize(10).text(payload.market_overview || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Concorrentes analisados");
      for (const comp of payload.competitors_analysis || []) {
        doc.font("Helvetica-Bold").fontSize(12).text(comp.username || "");
        doc.font("Helvetica").fontSize(10).text(`Posicionamento: ${comp.positioning || ""}`);
        doc.text(`Conteúdo: ${comp.content_style || ""}`);
        doc.text(`Visual: ${comp.visual_style || ""}`);
        doc.text(`Forças: ${(comp.strengths || []).join(", ")}`);
        doc.text(`Fraquezas: ${(comp.weaknesses || []).join(", ")}`);
        doc.text(`Como bater: ${comp.opportunity_against || ""}`);
        doc.moveDown(0.6);
      }

      addSectionTitle(doc, "Comparativo");
      doc.font("Helvetica").fontSize(10).text(`Onde você está mais forte: ${(payload.comparative_analysis?.where_you_are_stronger || []).join(", ")}`);
      doc.text(`Onde você está mais fraco: ${(payload.comparative_analysis?.where_you_are_weaker || []).join(", ")}`);
      doc.text(`Lacuna de posicionamento: ${payload.comparative_analysis?.positioning_gap || ""}`);
      doc.moveDown(0.6);

      addSectionTitle(doc, "Otimização da bio");
      doc.font("Helvetica").fontSize(10).text(payload.bio_optimization?.analysis || "");
      doc.moveDown(0.3);
      addListItems(doc, payload.bio_optimization?.improvements || []);

      addSectionTitle(doc, "Sugestões de bio");
      (payload.bio_optimization?.bio_suggestions || []).forEach((b) => {
        doc.font("Helvetica-Bold").fontSize(10).text(`${b.type || ""} • ${b.char_count || 0} caracteres`);
        doc.font("Helvetica").fontSize(10).text(b.bio || "");
        doc.moveDown(0.4);
      });

      addSectionTitle(doc, "Sugestões de nome");
      (payload.profile_optimization?.name_suggestions || []).forEach((n) => {
        doc.font("Helvetica-Bold").fontSize(10).text(`${n.name || ""} • ${n.char_count || 0} caracteres`);
      });
      doc.moveDown(0.5);

      addSectionTitle(doc, "Destaques sugeridos");
      addListItems(doc, payload.profile_optimization?.highlights_suggestions || []);

      addSectionTitle(doc, "Recomendação para link da bio");
      doc.font("Helvetica").fontSize(10).text(payload.profile_optimization?.link_bio_recommendation || "");
      doc.moveDown(0.6);

      addSectionTitle(doc, "Direção estratégica");
      addListItems(doc, payload.strategic_direction || []);
    }

    if (type === "memory") {
      addSectionTitle(doc, "Nicho");
      doc.font("Helvetica").fontSize(10).text(payload.niche || "-");
      doc.moveDown(0.4);

      addSectionTitle(doc, "Público");
      doc.font("Helvetica").fontSize(10).text(payload.audience || "-");
      doc.moveDown(0.4);

      addSectionTitle(doc, "Localização");
      doc.font("Helvetica").fontSize(10).text(payload.location || "-");
      doc.moveDown(0.4);

      addSectionTitle(doc, "Tom");
      doc.font("Helvetica").fontSize(10).text(payload.tone || "-");
      doc.moveDown(0.4);

      addSectionTitle(doc, "Diferenciais");
      addListItems(doc, payload.differentials || []);

      addSectionTitle(doc, "Palavras proibidas");
      addListItems(doc, payload.forbidden_words || []);

      addSectionTitle(doc, "O que funciona");
      addListItems(doc, payload.memory?.what_works || []);

      addSectionTitle(doc, "O que não funciona");
      addListItems(doc, payload.memory?.what_doesnt_work || []);

      addSectionTitle(doc, "Ângulos fortes");
      addListItems(doc, payload.memory?.strong_angles || []);
    }

    doc.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/intelligence", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { igId, niche = "", audience = "", goal = "", tone = "", extra = "", location = "" } = req.body || {};
  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  const media = await fetchMedia(account.id, account.ig_token, 20);
  const dashboard = buildDashboard(media, account);
  const clientMemory = getClientMemory(account.username);

  const userPrompt = `
Faça uma análise estratégica profunda deste perfil de Instagram.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location, clientMemory })}

DADOS DO DASHBOARD:
${JSON.stringify(dashboard, null, 2)}

ÚLTIMOS POSTS:
${summarizePosts(media, 6, 90)}

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
    const data = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 2200,
      temperature: 0.7
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/competitors", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

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

  const media = await fetchMedia(account.id, account.ig_token, 12);
  const clientMemory = getClientMemory(account.username);

  const competitorsData = (competitors || [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .map((c) => ({
      username: c.startsWith("@") ? c : `@${c}`
    }));

  const userPrompt = `
Faça uma análise estratégica PROFUNDA.

${buildContextBlock({ account, niche, audience, goal, tone, extra, location, clientMemory })}

PERFIL ANALISADO:
@${account.username}

BIO ATUAL:
${account.biography || "Não informada"}

LINK ATUAL:
${account.website || "Não informado"}

POSTS RECENTES:
${summarizePosts(media, 6, 90)}

CONCORRENTES:
${JSON.stringify(competitorsData, null, 2)}

RETORNE EXATAMENTE NESTE JSON:
{
  "market_overview": "leitura do mercado",
  "competitors_analysis": [
    {
      "username": "@concorrente",
      "positioning": "como se posiciona",
      "content_style": "como se comunica",
      "visual_style": "como aparenta visualmente",
      "strengths": ["força 1", "força 2"],
      "weaknesses": ["fraqueza 1", "fraqueza 2"],
      "opportunity_against": "como bater esse concorrente"
    }
  ],
  "comparative_analysis": {
    "where_you_are_stronger": ["ponto 1", "ponto 2"],
    "where_you_are_weaker": ["ponto 1", "ponto 2"],
    "positioning_gap": "o que falta no seu perfil hoje"
  },
  "bio_optimization": {
    "analysis": "o que está errado ou fraco na bio atual",
    "improvements": ["ajuste 1", "ajuste 2", "ajuste 3"],
    "bio_suggestions": [
      {
        "type": "direta",
        "bio": "bio clara e objetiva",
        "char_count": 0
      },
      {
        "type": "autoridade",
        "bio": "bio que gera confiança",
        "char_count": 0
      },
      {
        "type": "conversão",
        "bio": "bio que puxa para ação",
        "char_count": 0
      }
    ]
  },
  "profile_optimization": {
    "name_suggestions": [
      {
        "name": "Nome sugerido 1",
        "char_count": 0
      },
      {
        "name": "Nome sugerido 2",
        "char_count": 0
      },
      {
        "name": "Nome sugerido 3",
        "char_count": 0
      }
    ],
    "highlights_suggestions": ["Destaque 1", "Destaque 2", "Destaque 3", "Destaque 4", "Destaque 5"],
    "link_bio_recommendation": "como o link da bio deveria ser usado"
  },
  "strategic_direction": ["movimento 1", "movimento 2", "movimento 3"]
}

REGRAS IMPORTANTES:
- cada bio deve ter NO MÁXIMO 150 caracteres
- cada sugestão de nome deve ter NO MÁXIMO 64 caracteres
- bio precisa ser específica
- bio precisa deixar claro o que faz, para quem e diferencial
- evitar frases vagas
- concorrentes devem ser analisados individualmente
`;

  try {
    const data = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: userPrompt,
      maxTokens: 2600,
      temperature: 0.75
    });

    const enrichedCompetitors = [];

    for (const comp of data.competitors_analysis || []) {
      const username = String(comp.username || "").replace("@", "").trim();
      const preview = await captureInstagramProfileScreenshot(username);

      enrichedCompetitors.push({
        ...comp,
        preview_image: preview.success ? preview.imageUrl : "",
        preview_error: preview.success ? "" : preview.error
      });
    }

    if (data.bio_optimization?.bio_suggestions) {
      data.bio_optimization.bio_suggestions = data.bio_optimization.bio_suggestions.map((b) => ({
        ...b,
        bio: String(b.bio || "").slice(0, 150),
        char_count: String(b.bio || "").slice(0, 150).length
      }));
    }

    if (data.profile_optimization?.name_suggestions) {
      data.profile_optimization.name_suggestions = data.profile_optimization.name_suggestions.map((n) => ({
        ...n,
        name: String(n.name || "").slice(0, 64),
        char_count: String(n.name || "").slice(0, 64).length
      }));
    }

    data.competitors_analysis = enrichedCompetitors;

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/improve-post", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const { post, mode = "conversao" } = req.body || {};

  if (!post) {
    return res.status(400).json({ error: "Post não enviado." });
  }

  const prompt = `
Você vai reescrever um post fraco para deixá-lo mais forte.

POST ORIGINAL:
${JSON.stringify(post, null, 2)}

MODO:
${getModeInstruction(mode)}

RETORNE EXATAMENTE NESTE JSON:
{
  "title": "novo título",
  "hook": "novo gancho",
  "copy": "nova legenda completa",
  "cta": "novo cta",
  "script": "novo roteiro se for reels",
  "carousel_slides": ["slide 1", "slide 2", "slide 3"]
}

REGRAS:
- manter o mesmo formato do post original
- deixar mais forte, mais útil e mais comercial
- nada genérico
- se for reels, fortalecer o script
- se for carrossel, fortalecer a progressão
`;

  try {
    const improved = await callAIWithFallback({
      system: plannerSystemPrompt(),
      user: prompt,
      maxTokens: 1800,
      temperature: 0.78
    });

    const merged = {
      ...post,
      ...improved
    };

    const q = scorePostQuality(merged);

    return res.json({
      ...merged,
      quality_score: q.score,
      quality_label: q.label
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/competitor-preview/:username", async (req, res) => {
  const username = String(req.params.username || "").replace("@", "").trim();

  if (!username) {
    return res.status(400).json({ error: "Username inválido." });
  }

  try {
    const result = await captureInstagramProfileScreenshot(username);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/generate", async (req, res) => {
  if (!ensureAtLeastOneModel(res)) return;

  const {
    igId,
    niche = "",
    audience = "",
    goal = "",
    tone = "",
    extra = "",
    location = "",
    mode = "conversao",
    totalPosts = 16,
    reels = 6,
    carousels = 6,
    singlePosts = 4
  } = req.body || {};

  const account = getAccountFromSession(req, igId);
  if (!account) return res.status(404).json({ error: "Conta não encontrada." });

  try {
    const total = Number(totalPosts);
    const totalReels = Number(reels);
    const totalCarousels = Number(carousels);
    const totalSingles = Number(singlePosts);

    if (total !== totalReels + totalCarousels + totalSingles) {
      return res.status(400).json({
        error: "O total de posts precisa ser exatamente a soma de reels + carrosséis + estáticos."
      });
    }

    const media = await fetchMedia(account.id, account.ig_token, 20);
    const clientMemory = getClientMemory(account.username);

    const plan = await generateAgencyLevelPlanner({
      account,
      niche,
      audience,
      goal,
      tone,
      extra,
      location,
      totalPosts: total,
      reels: totalReels,
      carousels: totalCarousels,
      singlePosts: totalSingles,
      media,
      mode,
      clientMemory
    });

    updateMemory(account.username, plan);

    return res.json(plan);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    groq: Boolean(GROQ_API_KEY),
    gemini: Boolean(GEMINI_API_KEY),
    tokens_configured: IG_TOKENS.length,
    base_url: BASE_URL,
    groq_model: GROQ_MODEL,
    gemini_model: GEMINI_MODEL,
    clients_dir: CLIENTS_DIR
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
  console.log(`🔥 Instagram Planner Agency 6.4.1 rodando em ${BASE_URL}`);
  console.log(`[INIT] GROQ configurado: ${Boolean(GROQ_API_KEY)}`);
  console.log(`[INIT] GEMINI configurado: ${Boolean(GEMINI_API_KEY)}`);
  console.log(`[INIT] Tokens IG configurados: ${IG_TOKENS.length}`);
});
