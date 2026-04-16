require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MemoryStore = require('memorystore')(session);
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const os = require("os");
const PDFDocument = require("pdfkit");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { chromium } = require("playwright");
const mongoose = require("mongoose");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const IS_PROD = process.env.NODE_ENV === "production";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const SESSION_SECRET = process.env.SESSION_SECRET; // Removido fallback inseguro "agency-secret-123"const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const SAMBANOVA_API_KEY = (process.env.SAMBANOVA_API_KEY || "").trim();
const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);
const MONGODB_URI = process.env.MONGODB_URI || "";

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ==========================================
// 1. CONEXÃO COM O MONGODB ATLAS (PERSISTÊNCIA)
// ==========================================
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Conectado! Memória Permanente Ativada."))
    .catch(err => console.error("❌ Erro MongoDB:", err));
}

// ==========================================
// 2. MODELO DE DADOS DO CLIENTE
// ==========================================
const clientSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  niche: { type: String, default: "" },
  audience: { type: String, default: "" },
  location: { type: String, default: "" },
  tone: { type: String, default: "" },
  forbidden_words: {
    type: [String],
    default: ["você sabia", "entenda", "saiba mais", "veja como"]
  },
  memory: {
    what_works: [String],
    what_doesnt_work: [String],
    strong_angles: [String]
  },
  evolutionary_dna: {
    preferred_tone: { type: String, default: "" },
    forbidden_styles: [String],
    writing_patterns: [String],
    top_successes: [{ subject: String, content: String, rating: Number, date: Date }]
  },
  saved_diagnostics: { type: Array, default: [] },
  saved_planners: { type: Array, default: [] },
  single_posts: { type: Array, default: [] },       // 🆕 Histórico de posts únicos (Fábrica)
  swipe_file: { type: Array, default: [] }
}, { timestamps: true });

const Client = mongoose.model('Client', clientSchema);

async function getClientMemory(username) {
  let client = await Client.findOne({ username });
  if (!client) {
    client = new Client({ username });
    await client.save();
  }
  return client;
}

// ==========================================
// 3. CONFIGURAÇÕES DO SERVIDOR
// ==========================================
const PUBLIC_TMP_DIR = path.join(__dirname, "public", "tmp");
if (!fs.existsSync(PUBLIC_TMP_DIR)) fs.mkdirSync(PUBLIC_TMP_DIR, { recursive: true });

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/tmp", express.static(PUBLIC_TMP_DIR));

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

app.use(session({
  name: "planner.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({ checkPeriod: 86400000 }),
  cookie: { httpOnly: true, secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 }
}));

// --- SINGLETON BROWSER (POUPANÇA DE RAM COM RESILIÊNCIA) ---
let _browser = null;
async function getBrowser() {
  try {
    if (!_browser || !_browser.isConnected()) {
      console.log("🕸️ Iniciando nova instância do navegador Playwright...");
      _browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
      });
    }
  } catch (err) {
    console.error("❌ Falha ao iniciar Browser:", err.message);
    _browser = null;
  }
  return _browser;
}

// ==========================================
// 🛡️ BLINDAGEM: FACEBOOK GRAPH API — RATE LIMIT INTELIGENTE
// ==========================================
const fbCallTimestamps = [];
const FB_WINDOW_MS = 60 * 1000;    // Janela de 1 minuto
const FB_MAX_CALLS_PER_MIN = 50;   // Limite conservador (real é 200/h app-level)

async function callFbApiWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Throttle preventivo: verifica janela deslizante
      const now = Date.now();
      // Limpa timestamps expirados
      while (fbCallTimestamps.length > 0 && now - fbCallTimestamps[0] > FB_WINDOW_MS) {
        fbCallTimestamps.shift();
      }
      if (fbCallTimestamps.length >= FB_MAX_CALLS_PER_MIN) {
        const waitMs = FB_WINDOW_MS - (now - fbCallTimestamps[0]) + 200;
        console.log(`⏳ FB Rate Limit preventivo ativo. Aguardando ${Math.round(waitMs / 1000)}s antes da próxima chamada...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
      fbCallTimestamps.push(Date.now());

      return await fn();
    } catch (err) {
      const errCode = err.response?.data?.error?.code;
      const isRateLimit = err.response?.status === 429 || errCode === 4 || errCode === 17 || errCode === 32 || errCode === 613;
      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 2000; // 4s → 8s → 16s
        console.warn(`⚠️ Rate Limit Facebook (código ${errCode}). Retry ${attempt + 1}/${maxRetries} em ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// --- UTILITÁRIOS RESILIENTES ---
function safeJsonParse(text) {
  try {
    const cleaned = text.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Falha no Parse JSON IA:", e.message);
    return null;
  }
}

// --- MOTOR DE PERSONA PLATINUM (O "PENTE FINO" ESTRATÉGICO) ---
const SYSTEM_PROMPTS = {
  PLATINUM_CORE: `VOCÊ É O ESTRATEGISTA-CHEFE DE UMA AGÊNCIA DE MARKETING BOUTIQUE (Diretor de Criação Sênior).
  PERFIL: Analítico, denso, provocativo e focado em lucro/conversão.
  FILTRO 2026:
  - VETO TOTAL DE CLICHÊS: Absolutamente proibido: "você sabia", "atualmente", "nos dias de hoje", "não perca tempo", "descubra como".
  - TOM DE VOZ: Minimalista, sofisticado e "Premium". Use frases curtas de impacto mescladas com parágrafos densos de puro valor.
  - ESTRATÉGIA SILENCIOSA: Cada peça deve quebrar uma objeção ou elevar o status do cliente.
  - HUMANIZAÇÃO: Não fale sobre o "produto", fale sobre a "transformação ou o medo de ficar para trás".`,

  VISION: "Analise estética, cores e autoridade visual. Dê conselhos agressivos e táticos de melhoria como um Diretor de Arte Sênior.",
  COPYWRITER: `Copywriter Sênior focada em Conversão Inevitável.
  MÉTODO:
  1. Gancho: Inicie com uma afirmação contraintuitiva ou uma pergunta que exponha uma ferida.
  2. Desenvolvimento: Use Storytelling denso. Não descreva, faça sentir.
  3. Estilo Visual: Use emojis de forma minimalista (máximo 3 por post), apenas para pontuar. Use espaçamento generoso para facilitar a leitura.
  4. CTA: Chamada direta para o "Próximo Nível", nada de "comente azul".`
};

async function callAI({ system, user, imagePath, username }) {
  // 🧠 CONTEXTO EVOLUTIVO (2026 Edition)
  let evolutionaryContext = "";
  if (username) {
    try {
      const mem = await getClientMemory(username);
      const successes = (mem.evolutionary_dna?.top_successes || []).slice(-3);
      if (successes.length) {
        evolutionaryContext = `\nVIGILÂNCIA DE SUCESSO ANTERIOR: \n${successes.map(s => `- TEMA: ${s.subject} | PONTUAÇÃO: ${s.rating}/10 | CONTEÚDO APROVADO: ${s.content.substring(0, 150)}...`).join("\n")}`;
      }
    } catch (e) { }
  }

  const combinedSystem = `${SYSTEM_PROMPTS.PLATINUM_CORE}\n\n${system}\n\n${evolutionaryContext}\n\nCONSELHO DE ESPECIALISTAS 2026: Simule o debate entre um Estrategista de Retenção, um Psicólogo Comportamental e um Copywriter Premium antes de retornar a resposta final em JSON.`;
  const estimatedTokens = (combinedSystem.length + user.length) / 3.5;

  let lastError = null;
  console.log(`🧠 Chamada IA iniciada | [Groq: ${!!groq}] [SambaNova: ${!!SAMBANOVA_API_KEY}] [Gemini: ${!!gemini}] | Est. Tokens: ${Math.round(estimatedTokens)}`);

  // 1. TENTATIVA GROQ
  if (groq && !imagePath) {
    const groqModels = [];
    if (estimatedTokens < 3500) groqModels.push("llama-3.1-8b-instant");
    groqModels.push("llama-3.3-70b-versatile", "llama3-70b-8192");

    for (const model of groqModels) {
      try {
        console.log(`🤖 Tentando Groq: ${model}`);
        const res = await groq.chat.completions.create({
          model: model,
          messages: [{ role: "system", content: combinedSystem }, { role: "user", content: user }],
          response_format: { type: "json_object" },
          max_tokens: 6000
        });
        return JSON.parse(res.choices[0].message.content);
      } catch (err) {
        console.error(`⚠️ Groq (${model}) falhou:`, err.message);
        lastError = err;
        if (err.status !== 429) break;
      }
    }
  }

  // 1.5 TENTATIVA SAMBANOVA (Fallback de Alta Performance)
  if (SAMBANOVA_API_KEY && !imagePath) {
    try {
      console.log("🔥 Tentando SambaNova Cloud (Llama 3.3)...");
      const res = await axios.post("https://api.sambanova.ai/v1/chat/completions", {
        model: "Meta-Llama-3.3-70B-Instruct",
        messages: [{ role: "system", content: combinedSystem }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        max_tokens: 4000
      }, {
        headers: { "Authorization": `Bearer ${SAMBANOVA_API_KEY}`, "Content-Type": "application/json" }
      });
      const content = res.data.choices[0].message.content;
      return typeof content === "string" ? JSON.parse(content) : content;
    } catch (err) {
      console.error("⚠️ SambaNova falhou:", err.response?.data?.error?.message || err.message);
      lastError = err;
    }
  }

  // 2. TENTATIVA GEMINI (Fallback Final ou Visão)
  if (!gemini) {
    const errorMsg = lastError?.status === 429 ? "Limite de Uso do Groq atingido. Configure o Gemini no Render." : `IA Offline. Erro: ${lastError?.message || "Chave ausente"}`;
    throw new Error(errorMsg);
  }

  try {
    const modelName = imagePath ? "gemini-2.5-flash" : "gemini-2.5-flash";    console.log(`🚀 Tentando Fallback Gemini (${modelName})...`);

    const model = gemini.getGenerativeModel({
      model: modelName,
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    });

    const parts = [`${combinedSystem}\n\nResponda ESTRITAMENTE em formato JSON. Não use Markdown.\n\n${user}`];

    if (imagePath && fs.existsSync(imagePath)) {
      const imageData = fs.readFileSync(imagePath);
      parts.push({ inlineData: { data: imageData.toString("base64"), mimeType: "image/png" } });
    }

    const result = await model.generateContent(parts);
    const text = result.response.text();
    const parsed = safeJsonParse(text);

    if (!parsed) {
      console.error("❌ Resposta Gemini não é JSON válido:", text.substring(0, 200));
      throw new Error("Falha no parse JSON da Gemini.");
    }
    return parsed;
  } catch (err) {
    const isRateLimit = err.message?.includes("429") || err.status === 429;
    const finalMsg = isRateLimit ? "Limite de cota Gemini atingido." : (err.message || "Erro desconhecido");
    throw new Error(`Falha Crítica IA 2026: ${finalMsg}. Verifique suas chaves no Render.`);
  }
}

// ==========================================
// --- ROTAS DA API ---
// ==========================================

app.post("/api/auth", async (req, res) => {
  try {
    const accounts = [];
    for (const token of IG_TOKENS) {
      try {
        // TENTA BUSINESS API (via Facebook Graph) — com proteção de Rate Limit
        const pagesRes = await callFbApiWithRetry(() =>
          axios.get("https://graph.facebook.com/v21.0/me/accounts", {
            params: { fields: "instagram_business_account{id,username,name,followers_count,biography,media_count}", access_token: token }
          })
        );

        const pages = pagesRes.data.data || [];
        for (const p of pages) {
          if (p.instagram_business_account) {
            accounts.push({
              ...p.instagram_business_account,
              name: p.instagram_business_account.name || p.name,
              ig_token: token,
              is_business: true
            });
            await getClientMemory(p.instagram_business_account.username);
          }
        }
      } catch (e) {
        // FALLBACK: BASIC DISPLAY
        try {
          const r = await axios.get("https://graph.instagram.com/v21.0/me", {
            params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
          });
          accounts.push({ ...r.data, ig_token: token, is_business: false });
          await getClientMemory(r.data.username);
        } catch (err) { }
      }
    }
    req.session.logged = true;
    req.session.accounts = accounts;
    res.json({ success: true, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", (req, res) => res.json({ logged: !!req.session.logged, accounts: req.session.accounts || [] }));
app.get("/api/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/version", (req, res) => res.json({ version: "2026.04-Ideale-v3-Platinum" }));
app.get("/api/debug-status", (req, res) => {
  const recentFbCalls = fbCallTimestamps.filter(t => Date.now() - t < FB_WINDOW_MS).length;
  res.json({
    env: process.env.NODE_ENV || "development",
    groq: !!GROQ_API_KEY,
    gemini: !!GEMINI_API_KEY,
    sambanova: !!SAMBANOVA_API_KEY,
    mongodb: mongoose.connection.readyState === 1,
    tokens: IG_TOKENS.length,
    fb_calls_recent: recentFbCalls,
    fb_throttle_active: recentFbCalls >= FB_MAX_CALLS_PER_MIN,
    timestamp: new Date()
  });
});

app.get("/api/memory/:username", async (req, res) => {
  try {
    const mem = await getClientMemory(req.params.username);
    res.json({
      diagnostics: mem.saved_diagnostics || [],
      planners: mem.saved_planners || [],
      single_posts: (mem.single_posts || []).slice().reverse(), // Mais recente primeiro
      swipe_file: mem.swipe_file || [],
      forbidden: mem.forbidden_words || []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/identity/:username", async (req, res) => {
  try {
    const mem = await getClientMemory(req.params.username);
    res.json({
      niche: mem.niche || "Aguardando Diagnóstico...",
      audience: mem.audience || "Aguardando...",
      tone: mem.tone || "Aguardando...",
      last_update: mem.updatedAt
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🛡️ Dashboard com Rate Limit Protection + Top/Worst Posts
app.get("/api/dashboard/:igId", async (req, res) => {
  const acc = (req.session.accounts || []).find(a => a.id === req.params.igId);
  if (!acc) return res.status(404).send();
  try {
    const r = await callFbApiWithRetry(() =>
      axios.get(`https://graph.facebook.com/v21.0/${acc.id}/media`, {
        params: {
          fields: "id,caption,media_type,like_count,comments_count,timestamp,insights.metric(reach,impressions,engagement)",
          limit: 15,
          access_token: acc.ig_token
        }
      })
    );

    const media = r.data.data || [];
    const likes = media.reduce((a, b) => a + (b.like_count || 0), 0);
    const comms = media.reduce((a, b) => a + (b.comments_count || 0), 0);

    const totalReach = media.reduce((a, b) => {
      const reachVal = b.insights?.data?.find(m => m.name === 'reach')?.values[0]?.value || 0;
      return a + reachVal;
    }, 0);

    const er = (((likes + comms) / (media.length || 1)) / (acc.followers_count || 1) * 100).toFixed(2);

    // 🆕 Top/Worst Posts por curtidas
    const sorted = [...media].sort((a, b) => (b.like_count || 0) - (a.like_count || 0));

    res.json({
      metrics: {
        engagement_rate: er,
        avg_likes: Math.round(likes / (media.length || 1)),
        avg_comments: Math.round(comms / (media.length || 1)),
        total_reach_recent: totalReach
      },
      format_mix: media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type] || 0) + 1; return acc; }, {}),
      recent_posts: media.slice(0, 10),
      top_posts: sorted.slice(0, 3),
      worst_posts: sorted.slice(-3).reverse()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/quick-verdict", async (req, res) => {
  const { username, followers, er, media, igId } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);

  let realInsights = { reach: 0, impressions: 0, cities: "Apurando..." };
  let isReal = false;

  if (acc && acc.is_business) {
    try {
      const insightRes = await callFbApiWithRetry(() =>
        axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
          params: { metric: "reach,impressions", period: "day", access_token: acc.ig_token }
        })
      );
      const audienceRes = await callFbApiWithRetry(() =>
        axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
          params: { metric: "audience_city", period: "lifetime", access_token: acc.ig_token }
        })
      );

      const rVal = insightRes.data.data.find(m => m.name === 'reach')?.values.reverse()[0]?.value || 0;
      const iVal = insightRes.data.data.find(m => m.name === 'impressions')?.values.reverse()[0]?.value || 0;

      if (rVal > 0) {
        realInsights.reach = rVal * 30;
        realInsights.impressions = iVal * 30;
        isReal = true;
      }

      const citiesMap = audienceRes.data.data[0]?.values[0]?.value || {};
      realInsights.cities = Object.keys(citiesMap).slice(0, 3).join(", ") || "Apurando...";
    } catch (e) { }
  }

  if (!isReal) {
    realInsights.reach = Math.round(followers * (er / 10) * 1.5) || 150;
    realInsights.impressions = Math.round(realInsights.reach * 1.8);
  }

  const prompt = `AUDITORIA MÉTRICA PLATINUM para @${username}.
  Seguidores: ${followers}. ER: ${er}%.
  STATUS: ${isReal ? 'DADOS REAIS' : 'ESTIMATIVA PREDITIVA IDEALE'}.
  Crie um Veredito EXPERT (Humanizado, Direto, Mentoriano). MÁX 3 frases.
  Determine o 'Health Status' (Pico de Tração, Estável, Alerta de Queda ou Em Maturação).
  RETORNE JSON: { "verdict": "...", "demographics": { "cities": "...", "gender": "...", "time": "..." }, "health_status": "..." }`;

  try {
    const data = await callAI({ system: "Estrategista de Dados Premium. Fale como um consultor humano.", user: prompt });
    res.json({
      verdict: data.verdict,
      demographics: {
        cities: realInsights.cities !== "Apurando..." ? realInsights.cities : (data.demographics?.cities || "Brasil (Estimado)"),
        gender: data.demographics?.gender || "Misto",
        time: data.demographics?.time || "18h-21h"
      },
      health_status: data.health_status || (er > 3 ? "Pico de Tração" : "Estável"),
      real_metrics: realInsights,
      is_real: isReal
    });
  } catch (e) {
    res.json({ verdict: "Análise Preditiva: Sua conta está em fase de aquecimento de base. Focar em retenção.", demographics: { cities: "Brasil", gender: "Misto", time: "19h" }, real_metrics: realInsights, is_real: isReal });
  }
});

app.post("/api/evaluate-post", async (req, res) => {
  const { theme, script_or_slides, caption, username } = req.body;
  const prompt = `AVALIE ESTE POST:
  Tema: ${theme}.
  Roteiro/Estrutura: ${JSON.stringify(script_or_slides)}.
  Legenda: ${caption}.
  Dê nota de 0 a 10 e analise Hook (Gancho), Body (Corpo) e CTA (Chamada).
  FORNEÇA UM REFINAMENTO DA LEGENDA PARA MAXIMIZAR O ALGORITMO.
  Retorne JSON: { "score": 8.5, "analysis": { "hook": "...", "body": "...", "cta": "..." }, "refined_caption": "..." }`;

  try {
    const data = await callAI({ system: "Especialista em Copywriting de Alta Performance.", user: prompt, username });

    // 🧠 SALVAR DNA EVOLUTIVO SE A NOTA FOR ALTA
    if (username && data.score >= 8) {
      const mem = await getClientMemory(username);
      mem.evolutionary_dna.top_successes.push({
        subject: theme,
        content: caption,
        rating: data.score,
        date: new Date()
      });
      if (mem.evolutionary_dna.top_successes.length > 20) mem.evolutionary_dna.top_successes.shift();
      await mem.save();
    }

    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/intelligence", async (req, res) => {
  const { igId, niche, audience } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Account not found" });

  const mem = await getClientMemory(acc.username);
  mem.niche = niche; mem.audience = audience;
  await mem.save();

  let postsContext = "";
  try {
    const r = await callFbApiWithRetry(() =>
      axios.get(`https://graph.instagram.com/v21.0/${acc.id}/media`, {
        params: { fields: "caption,media_type,like_count", limit: 15, access_token: acc.ig_token }
      })
    );
    postsContext = (r.data.data || []).map(p => `[${p.media_type}] ${p.caption ? p.caption.substring(0, 100) : ''}...`).join(' | ');
  } catch (e) { }

  const prompt = `AUDITORIA DIGITAL PLATINUM para @${acc.username}.
  Você é o Estrategista-Chefe da Ideale. Analise o feed e o nicho.
  Feed Atual: ${postsContext}
  Nicho: ${niche}, Público: ${audience}.

  MISSÃO ESPECIAL: Gere 3 variações de BIO PREMIUM (Instagram) para o cliente.
  REGRAS: MÁXIMO 150 caracteres por Bio. Use técnica de Authority-Connection-Offer.

  Retorne JSON:
  {
    "executive_summary": "Análise densa, sem clichês, foco em branding.",
    "detected_niche": "nicho lido",
    "detected_tone": "tom de voz lido",
    "bio_suggestions_3D": {
      "authority": "Bio focada em marcos, prova social e quem você atende. Máx 150 carac.",
      "connection": "Bio focada em dor, conexão humana e transformação. Máx 150 carac.",
      "conversion": "Bio focada em CTA agressivo, link/vendas. Máx 150 carac."
    },
    "strengths": ["...", "..."],
    "weaknesses": ["...", "..."],
    "pillars": ["3 pilares táticos únicos"],
    "priority_actions": ["Ação imediata"]
  }`;

  try {
    const data = await callAI({ system: "Estrategista de Elite. Inale Storytelling e Exale Resultados.", user: prompt });
    mem.saved_diagnostics.push({ date: new Date(), ...data });
    await mem.save();
    res.json(data);
  } catch (e) {
    console.error("❌ Erro /api/intelligence:", e.message);
    res.status(500).json({ error: `Falha no Diagnóstico: ${e.message}` });
  }
});

app.post("/api/export-diagnostic", async (req, res) => {
  const { payload, username } = req.body;
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 100).fill("#051A22");
  doc.fillColor("#22ceb5").fontSize(28).text("IDEALE", 50, 40);
  doc.fillColor("#ffffff").fontSize(14).text("DIAGNÓSTICO ESTRATÉGICO", 50, 70);

  doc.moveDown(3);
  doc.fillColor("#000000").fontSize(20).text(`Análise: @${username}`, { underline: true }).moveDown();

  doc.fontSize(14).fillColor("#22ceb5").text("Resumo Executivo");
  doc.fontSize(11).fillColor("#333333").text(payload.executive_summary, { align: 'justify' }).moveDown();

  if (payload.bio_analysis) {
    doc.fontSize(14).fillColor("#e74c3c").text("Análise da Bio & Falhas Críticas");
    doc.fontSize(11).fillColor("#333333").text(payload.bio_analysis, { align: 'justify' }).moveDown();
    (payload.weaknesses || []).forEach(w => doc.text(`• ${w}`));
    doc.moveDown();
  }

  doc.fontSize(14).fillColor("#27ae60").text("Bio Tridimensional (Variações)");
  doc.fontSize(12).fillColor("#333").text("Autoridade: ", { continued: true }).fontSize(11).text(payload.bio_suggestions_3D?.authority || "-");
  doc.fontSize(12).fillColor("#333").text("Conexão: ", { continued: true }).fontSize(11).text(payload.bio_suggestions_3D?.connection || "-");
  doc.fontSize(12).fillColor("#333").text("Conversão: ", { continued: true }).fontSize(11).text(payload.bio_suggestions_3D?.conversion || "-");
  doc.moveDown(2);

  doc.fontSize(14).fillColor("#2980b9").text("Pilares Editoriais Recomendados");
  (payload.pillars || []).forEach(p => doc.text(`• ${p}`));
  doc.moveDown();

  doc.fontSize(10).fillColor("#999999").text("Relatório Confidencial - Ideale Agency", 50, doc.page.height - 50, { align: 'center' });
  doc.end();
});

app.post("/api/competitors", async (req, res) => {
  const { username } = req.body;
  const usernames = username.split(',').map(u => u.trim().replace('@', '')).filter(Boolean).slice(0, 3);
  const browser = await getBrowser();
  const results = [];

  for (const user of usernames) {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    try {
      console.log(`📡 Capturando perfil: @${user}...`);
      await page.goto(`https://www.instagram.com/${user}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);

      const filename = `comp_${user}_${Date.now()}.png`;
      const fullPath = path.resolve(PUBLIC_TMP_DIR, filename);
      await page.screenshot({ path: fullPath, fullPage: false });

      const prompt = `Analise @${user}. Cores? Vibe (luxo, popular)? Counter-attack: Como ser melhor para se destacar dele?
      JSON: { "colors": "...", "vibe": "...", "counter_attack": "..." }`;

      const vision = await callAI({
        system: "Espião de Marketing com visão afiada.",
        user: prompt,
        imagePath: fullPath
      });

      results.push({
        username: user,
        screenshot: `/tmp/${filename}`,
        analysis: vision || { vibe: "Inconsistente", counter_attack: "Focar em conteúdo autoral." }
      });
    } catch (e) {
      results.push({ username: user, screenshot: null, analysis: { vibe: "Erro na captura", counter_attack: "Tentar manualmente." } });
    } finally { await context.close(); }
  }
  res.json({ results, analysis: "Varredura concluída." });
});

app.post("/api/suggest-competitors", async (req, res) => {
  const { niche, city } = req.body;
  const prompt = `Sugira 3 arrobas reais do Instagram (benchmark ou negócio local) no nicho de '${niche}' na região '${city}'.
  Retorne JSON: { "competitors": ["@nome1", "@nome2", "@nome3"] }`;
  try {
    const data = await callAI({ system: "Especialista em pesquisa de mercado.", user: prompt });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Erro buscando recomendação." });
  }
});

// ==========================================
// 🆕 HASHTAG INTELLIGENCE ENGINE
// ==========================================
app.post("/api/hashtags", async (req, res) => {
  const { igId, objective, niche: customNiche } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);

  let resolvedNiche = customNiche || "Marketing Digital";
  if (acc) {
    try {
      const mem = await getClientMemory(acc.username);
      if (mem.niche && !customNiche) resolvedNiche = mem.niche;
    } catch (e) { }
  }

  const prompt = `Você é um especialista em SEO e algoritmo do Instagram 2026.
  Gere 5 sets de hashtags estratégicos para o nicho: "${resolvedNiche}" com objetivo: "${objective}".

  Regras obrigatórias:
  - Misture hashtags de alta (>1M posts), média (100k-1M) e baixa (<100k) competição para máximo alcance orgânico nos primeiros 30 minutos.
  - Nunca repita a mesma hashtag entre sets.
  - Cada set deve ter entre 12 e 15 hashtags.
  - Inclua pelo menos 2-3 hashtags em português por set.
  - As hashtags devem ser 100% reais e utilizadas ativamente no Instagram.

  Retorne JSON estritamente:
  {
    "sets": [
      {
        "name": "Nome estratégico do set",
        "strategy": "Quando e por que usar este set (1 frase direta)",
        "tags": ["#tag1", "#tag2", "#tag3"],
        "competition": "alta|media|baixa",
        "best_for": "Tipo de formato ideal (ex: Reels Educativos, Carrossel de Autoridade)"
      }
    ],
    "banned_to_avoid": ["#tag_que_shadowbanna", "#tag_saturada"],
    "pro_tip": "Dica de ouro específica para o nicho (1 frase de impacto)"
  }`;

  try {
    const data = await callAI({
      system: "Especialista em SEO, crescimento orgânico e algoritmo do Instagram 2026. Apenas JSON válido.",
      user: prompt,
      username: acc?.username
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 🆕 SWIPE FILE — SALVAR NO COFRE
// ==========================================
app.post("/api/swipe-file/save", async (req, res) => {
  const { username, entry } = req.body;
  try {
    const mem = await getClientMemory(username);
    mem.swipe_file.push({
      date: new Date(),
      ...entry
    });
    if (mem.swipe_file.length > 30) mem.swipe_file.shift(); // Limite de 30 itens
    await mem.save();
    res.json({ success: true, total: mem.swipe_file.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/autofill", async (req, res) => {
  const { igId, field_type } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada" });
  const mem = await getClientMemory(acc.username);

  let prompt = "";
  if (field_type === 'niche') prompt = `Analise a bio: "${acc.biography || ''}". Sugira o "Nicho e Diferencial Único" (sem clichês). Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'audience') prompt = `Analise a bio: "${acc.biography || ''}". Qual o público-alvo exato (demografia e dor)? Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'subject') prompt = `Baseado em ${mem.niche || 'este perfil'}, dê uma ideia de post 'fora da caixa' que gere autoridade imediata. Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'angle') prompt = `Qual gatilho mental (Polêmica, Erro, Desejo Oculto) seria perfeito para esse nicho hoje? Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'city') prompt = `Analise a bio: "${acc.biography || ''}". Localize a cidade/estado principal ou responda "Brasil (Nacional)". Retorne JSON: {"suggestion": "..."}`;

  try {
    const data = await callAI({ system: "Você é focado em respostas ultra-diretas. Só retorne JSON.", user: prompt, username: acc.username });
    res.json(data);
  } catch (e) {
    res.json({ suggestion: `Erro Técnico: ${e.message}` });
  }
});

app.post("/api/generate", async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Acct not found" });
  const mem = await getClientMemory(acc.username);

  const prompt = `Crie um Planejamento de Lançamento Eterno (Funil 4 Semanas) para @${acc.username}.
  PERSONA DO CLIENTE: Nicho: ${mem.niche}. Público: ${mem.audience}. Tom: ${tone}.
  Distribuição: ${reels} Reels, ${carousels} Carrosséis, ${singlePosts} Estáticos.

  DIRETRIZ ESTRATÉGICA PLATINUM:
  - PROIBIDO: Listas óbvias, adjetivos genéricos como "incrível" ou "essencial".
  - CONTEÚDO: Cada post deve ser uma peça de "Doutrinação". Use ganchos que causem um "estalo" mental no seguidor.
  - COERÊNCIA: A Semana 1 deve gerar curiosidade; a Semana 2 deve provar que o cliente é um gênio; a Semana 3 deve humanizar com uma falha ou história; a Semana 4 deve ser a proposta final.

  Retorne JSON:
  {
    "posts": [
      {
        "n": 1,
        "week_funnel": "Semana 1: Atenção",
        "format": "reels",
        "theme": "Título Curto de Impacto",
        "visual_audio_direction": "Direção de cinema (ex: luz de fundo, silêncio dramático)",
        "script_or_slides": ["Gancho de 2 segundos", "Corpo com 3 quebras de padrão", "Chamada de transbordamento"],
        "caption": "Legenda Densa. Use a regra dos 3 espaços. Zero clichês.",
        "strategic_logic": "Por que esse post vai parar o scroll?"
      }
    ]
  }`;

  try {
    const data = await callAI({ system: "Você é um Co-Produtor Sênior de Lançamentos e Estrategista. Apenas JSON válido.", user: prompt, username: acc.username });
    mem.saved_planners.push({ date: new Date(), goal, posts: (data.posts || []) });
    await mem.save();
    res.json(data);
  } catch (e) {
    console.error("❌ Erro /api/generate:", e.message);
    res.status(500).json({ error: `Falha no Planejamento: ${e.message}` });
  }
});

app.post("/api/single-post", async (req, res) => {
  const { igId, format, subject, angle, intensity } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada" });
  const mem = await getClientMemory(acc.username);

  const prompt = `Crie exatamente UM POST ESTRATÉGICO para @${acc.username}.
  CONTEXTO DA MARCA: Nicho: ${mem.niche || 'Geral'}. Público: ${mem.audience || 'Geral'}.
  TEMA: ${subject}. FORMATO: ${format}. ÂNGULO: ${angle}. INTENSIDADE: ${intensity}/10.

  REGRAS DE OURO (DIRETOR DE CRIAÇÃO):
  - NÃO use hashtags genéricas.
  - O roteiro deve ser FLUIDO. Se for carrossel, cada slide deve ser um soco no estômago.
  - A legenda deve começar com um "Gancho de Curiosidade Irresistível".
  - Foque em quebrar a crença limitante nº 1 desse nicho.
  - Estilo: Premium, Direto, Sem Enrolação.
  {
    "format": "${format}",
    "theme": "${subject}",
    "visual_audio_direction": "direção de arte épica",
    "script_or_slides": ["parte 1", "parte 2", "..."],
    "caption": "legenda humanizada",
    "strategic_logic": "por que isso vende?"
  }`;

  try {
    const data = await callAI({ system: SYSTEM_PROMPTS.COPYWRITER, user: prompt, username: acc.username });

    // 🆕 Salvar no histórico de posts únicos
    mem.single_posts.push({ date: new Date(), subject, format, angle, ...data });
    if (mem.single_posts.length > 50) mem.single_posts.shift();
    await mem.save();

    res.json(data);
  } catch (e) {
    console.error("❌ Erro /api/single-post:", e.message);
    res.status(500).json({ error: `Falha no Post Único: ${e.message}` });
  }
});

app.post("/api/export-report", (req, res) => {
  const { payload, username } = req.body;
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 100).fill("#051A22");
  doc.fillColor("#22ceb5").fontSize(28).text("IDEALE", 50, 40);
  doc.fillColor("#ffffff").fontSize(14).text("PLANEJAMENTO TÁTICO", 50, 70);

  doc.moveDown(3);
  doc.fillColor("#000000").fontSize(20).text(`Cliente: @${username}`, { underline: true }).moveDown();

  (payload.posts || []).forEach(p => {
    doc.fontSize(14).fillColor("#22ceb5").text(`${p.week_funnel || 'Planejamento'} | Post ${p.n} - ${p.format.toUpperCase()} | Temática: ${p.theme}`);
    doc.fontSize(11).fillColor("#e74c3c").text(`Direção Visual/Áudio:`, { continued: true }).fillColor("#333333").text(` ${p.visual_audio_direction}`);
    doc.moveDown(0.5);

    doc.fontSize(11).fillColor("#2980b9").text("Roteiro / Telas:");
    (p.script_or_slides || []).forEach(s => doc.fillColor("#333333").text(`• ${s}`));
    doc.moveDown(0.5);

    doc.fontSize(11).fillColor("#27ae60").text("Legenda (Copy):");
    doc.fillColor("#333333").text(p.caption, { align: 'justify' });
    doc.moveDown(2);
  });

  doc.fontSize(10).fillColor("#999999").text("Relatório Confidencial - Ideale Agency", 50, doc.page.height - 50, { align: 'center' });
  doc.end();
});

// Health check para Render.com
app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

app.listen(PORT, "0.0.0.0", () => console.log(`🔥 Ideale Platinum v3 ativo em ${BASE_URL}`));
