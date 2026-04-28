require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const MemoryStore = require("memorystore")(session);
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { chromium } = require("playwright");
const mongoose = require("mongoose");

// motor modular + pipeline
const { buildClients } = require("./ai/engine");
const { generateWithPipeline, generateMissingBatch } = require("./ai/pipeline");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const IS_PROD = process.env.NODE_ENV === "production";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const SESSION_SECRET = (process.env.SESSION_SECRET || "").trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const SAMBANOVA_API_KEY = (process.env.SAMBANOVA_API_KEY || "").trim();
const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);
const MONGODB_URI = (process.env.MONGODB_URI || "").trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || "").trim();

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

// Clientes legados (mantidos)
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Clientes do motor modular
const aiClients = buildClients(process.env);

const log = {
  info:  (...a) => console.log(`[${new Date().toISOString()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...a),
  debug: (...a) => !IS_PROD && console.log(`[${new Date().toISOString()}] [DEBUG]`, ...a),
};

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => log.info("✅ MongoDB Conectado!"))
    .catch(err => log.error("❌ Erro MongoDB:", err));
}

const clientSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  niche: { type: String, default: "" },
  audience: { type: String, default: "" },
  location: { type: String, default: "" },
  tone: { type: String, default: "" },
  forbidden_words: { type: [String], default: ["você sabia", "entenda", "saiba mais", "veja como"] },
  memory: { what_works: [String], what_doesnt_work: [String], strong_angles: [String] },
  evolutionary_dna: {
    preferred_tone: { type: String, default: "" },
    forbidden_styles: [String],
    writing_patterns: [String],
    top_successes: [{ subject: String, content: String, rating: Number, date: Date }]
  },
  saved_diagnostics: { type: Array, default: [] },
  saved_planners:    { type: Array, default: [] },
  single_posts:      { type: Array, default: [] },
  swipe_file:        { type: Array, default: [] }
}, { timestamps: true });

const Client = mongoose.model("Client", clientSchema);

async function getClientMemory(username) {
  let client = await Client.findOne({ username });
  if (!client) { client = new Client({ username }); await client.save(); }
  return client;
}

const PUBLIC_TMP_DIR = path.join(__dirname, "public", "tmp");
if (!fs.existsSync(PUBLIC_TMP_DIR)) fs.mkdirSync(PUBLIC_TMP_DIR, { recursive: true });

function cleanTmpDir() {
  try {
    const files = fs.readdirSync(PUBLIC_TMP_DIR);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of files) {
      try {
        const fp = path.join(PUBLIC_TMP_DIR, f);
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
      } catch (_) {}
    }
    if (removed > 0) log.info(`🧹 Limpeza tmp: ${removed} arquivo(s) removido(s).`);
  } catch (e) { log.warn("Erro na limpeza tmp:", e.message); }
}
setInterval(cleanTmpDir, 30 * 60 * 1000);
cleanTmpDir();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/tmp", express.static(PUBLIC_TMP_DIR));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));

const sessionStore = MONGODB_URI
  ? MongoStore.create({ mongoUrl: MONGODB_URI, ttl: 60 * 60 * 24, touchAfter: 3600 })
  : new MemoryStore({ checkPeriod: 86400000 });

if (!MONGODB_URI) log.warn("⚠️  MONGODB_URI não definida — sessões em memória.");

app.use(session({
  name: "planner.sid",
  secret: SESSION_SECRET || "fallback-secret-change-me",
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { httpOnly: true, secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 }
}));

function requireAuth(req, res, next) {
  if (req.session?.logged) return next();
  return res.status(401).json({ error: "Não autenticado. Faça login primeiro." });
}

app.post("/api/app-login", (req, res) => {
  if (!APP_PASSWORD) return res.json({ success: true });
  const { password } = req.body;
  if (password === APP_PASSWORD) { req.session.app_unlocked = true; return res.json({ success: true }); }
  return res.status(401).json({ error: "Senha incorreta." });
});

function requireAppPassword(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.session?.app_unlocked) return next();
  return res.status(401).json({ error: "App bloqueado. Informe a senha de acesso." });
}

let _browser = null;
async function getBrowser() {
  try {
    if (!_browser || !_browser.isConnected()) {
      log.info("🕸️ Iniciando nova instância do navegador Playwright...");
      _browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
      });
    }
  } catch (err) { log.error("❌ Falha ao iniciar Browser:", err.message); _browser = null; }
  return _browser;
}

const fbCallTimestamps = [];
const FB_WINDOW_MS = 60 * 1000;
const FB_MAX_CALLS_PER_MIN = 50;

async function callFbApiWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const now = Date.now();
      while (fbCallTimestamps.length > 0 && now - fbCallTimestamps[0] > FB_WINDOW_MS) fbCallTimestamps.shift();
      if (fbCallTimestamps.length >= FB_MAX_CALLS_PER_MIN) {
        const waitMs = FB_WINDOW_MS - (now - fbCallTimestamps[0]) + 200;
        log.warn(`⏳ FB Rate Limit preventivo. Aguardando ${Math.round(waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
      fbCallTimestamps.push(Date.now());
      return await fn();
    } catch (err) {
      const errCode = err.response?.data?.error?.code;
      const isRateLimit = err.response?.status === 429 || [4, 17, 32, 613].includes(errCode);
      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 2000;
        log.warn(`⚠️ Rate Limit Facebook (código ${errCode}). Retry ${attempt + 1}/${maxRetries} em ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else throw err;
    }
  }
}

function safeJsonParse(text) {
  try {
    const cleaned = String(text || "").trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(cleaned);
  } catch (e) { log.error("Falha no Parse JSON IA:", e.message); return null; }
}

function truncate(str, max = 300) {
  if (!str) return "";
  return str.length > max ? str.substring(0, max) + "..." : str;
}

function enforceBioLimit(bio) {
  if (!bio || typeof bio !== "string") return bio;
  return bio.length > 150 ? bio.substring(0, 150) : bio;
}

// ------------------- helpers conteúdo -------------------

function getBestPostingTimes(niche) {
  const nicheTimings = {
    saude:       { days: "Terça, Quinta, Sábado", times: "06h-08h e 19h-21h", reasoning: "Decisão de saúde é matinal ou noturna (reflexão do dia)" },
    beleza:      { days: "Quarta, Sexta, Domingo", times: "11h-13h e 20h-22h", reasoning: "Descoberta visual no almoço e planejamento noturno de cuidados" },
    fitness:     { days: "Segunda, Quarta, Sexta", times: "05h30-07h e 17h-19h", reasoning: "Audiência treina cedo ou depois do trabalho — conteúdo sincronizado com rotina" },
    negocios:    { days: "Terça, Quarta, Quinta", times: "07h-09h e 12h-13h", reasoning: "Decisor B2B acessa antes do expediente e no almoço" },
    moda:        { days: "Quinta, Sexta, Domingo", times: "12h-14h e 21h-23h", reasoning: "Descoberta no almoço, consideração/compra à noite" },
    educacao:    { days: "Segunda, Terça, Quarta", times: "07h-09h e 20h-22h", reasoning: "Motivação início de semana e estudo noturno" },
    gastronomia: { days: "Quarta, Quinta, Domingo", times: "11h-13h e 18h-20h", reasoning: "Decisão de onde comer é tomada próximo ao horário" },
    default:     { days: "Terça, Quarta, Quinta", times: "07h-09h e 19h-21h", reasoning: "Janelas de maior atenção baseadas em comportamento médio brasileiro" }
  };
  const lowerNiche = (niche || "").toLowerCase();
  for (const [key, val] of Object.entries(nicheTimings)) {
    if (lowerNiche.includes(key)) return val;
  }
  return nicheTimings.default;
}

function getHookLibrary(format) {
  const hooks = {
    reels: [
      "Consequência antes da causa: 'Perdi [X] fazendo [Y]. Não porque sou burro — porque ninguém me contou essa regra.'",
      "Afirmação contraintuitiva dita com certeza absoluta — sem condicionais, sem 'talvez'",
      "Demonstração do resultado antes da explicação — o espectador fica para entender como chegou lá",
      "Exposição de crença limitante: '[Mito do nicho]? Então esse vídeo é urgente.' — pausa antes de continuar",
      "Corte frio no meio da ação — começa já acontecendo, sem introdução ou contexto"
    ],
    carrossel: [
      "Slide 1: Promessa com número específico — 'Os X erros que custam [resultado negativo concreto] a 90% dos [público]'",
      "Slide 1: Revelação contraintuitiva que cria dissonância — leva ao swipe para resolver a tensão",
      "Slide 1: Antes/depois sem explicar o mecanismo — a curiosidade força o próximo slide",
      "Slide 1: Autodiagnóstico — 'Você faz [X]? Então está perdendo [Y]'",
      "Slide 1: Dado real chocante sem contexto — o contexto vem no slide 2"
    ],
    estatico: [
      "Declaração polêmica ou verdade inconveniente do nicho em destaque",
      "Contraste visual entre estado atual (dor) e estado desejado (transformação)",
      "Número específico em destaque — dado real que muda perspectiva",
      "Frase que parece errada à primeira leitura mas é verdade — cria parada e segundo olhar"
    ]
  };
  const fmt = (format || "").toLowerCase();
  if (fmt.includes("reel")) return hooks.reels;
  if (fmt.includes("carro") || fmt.includes("carousel")) return hooks.carrossel;
  return hooks.estatico;
}

function normalizeFormat(format) {
  const f = String(format || "").toLowerCase().trim();
  if (f.includes("reel")) return "reels";
  if (f.includes("carro") || f.includes("carousel")) return "carrossel";
  if (f.includes("estat") || f.includes("static")) return "estatico";
  return "estatico";
}

const SYSTEM_PROMPTS = {
  PLATINUM_CORE: `VOCÊ É O DIRETOR DE ESTRATÉGIA DE CONTEÚDO DE UMA AGÊNCIA BOUTIQUE DE ALTO DESEMPENHO.
FILOSOFIA CENTRAL:
Todo conteúdo existe para mover uma pessoa de um estado mental A para um estado mental B.
Não existem "posts de valor" — existe conteúdo que muda comportamento ou conteúdo que ocupa espaço.

FILTRO DE QUALIDADE 2026 — VETO ABSOLUTO COM JUSTIFICATIVA:
❌ "você sabia" — sinaliza que você acha que o seguidor não sabe. Cria hierarquia errada.
❌ "atualmente / nos dias de hoje" — marcador de tempo desnecessário que enfraquece a afirmação.
❌ "transforme sua vida" — promessa sem mecanismo. Não converte.
❌ "conteúdo de valor / dica de ouro" — meta-comentário sobre o conteúdo ao invés de ser o conteúdo.
❌ "comente sim / salva esse post" — CTA que não filtra audiência nem gera conversa real.
❌ "compartilhe com quem precisa" — transfere responsabilidade de distribuição para o seguidor.
❌ Listas de tópicos óbvios sem tensão entre eles.
❌ Perguntas retóricas no início que qualquer pessoa responderia "sim" automaticamente.

✅ TOM OBRIGATÓRIO: Escreva como alguém que já chegou onde o seguidor quer chegar — com autoridade casual, não arrogante.
✅ TESTE DO SCROLL: Cada frase deve fazer a pessoa querer ler a próxima. Frase "skip-able" = corte ou reescreva.
✅ ESPECIFICIDADE: Números reais, exemplos concretos, nomes de situações reconhecíveis > abstrações bonitas.`,
  COPYWRITER: `COPYWRITER SÊNIOR — ESPECIALISTA EM CONVERSÃO E RETENÇÃO.`,
  PLANNER_CORE: `VOCÊ É O CO-PRODUTOR EXECUTIVO DE CONTEÚDO DA IDEALE AGENCY.`
};

function buildCombinedSystem({ system, evolutionaryContext }) {
  return [
    SYSTEM_PROMPTS.PLATINUM_CORE,
    system,
    evolutionaryContext,
    "ANTES DE RESPONDER: Simule internamente o debate entre um Estrategista de Retenção, um Psicólogo Comportamental e um Copywriter Sênior. Retorne apenas o consenso final em JSON."
  ].filter(Boolean).join("\n\n");
}

// --------- motor legado callAI (mantido p/ outros endpoints) ---------

async function callAI({ system, user, imagePath, username }) {
  let evolutionaryContext = "";
  if (username) {
    try {
      const mem = await getClientMemory(username);
      const successes = (mem.evolutionary_dna?.top_successes || []).slice(-3);
      if (successes.length) {
        evolutionaryContext = `\nPADRÕES QUE JÁ FUNCIONARAM NESTA CONTA:\n${successes
          .map(s => `- TEMA: ${s.subject} | NOTA: ${s.rating}/10 | CONTEÚDO: ${truncate(s.content, 150)}`)
          .join("\n")}`;
      }
    } catch (_) {}
  }

  const combinedSystem = buildCombinedSystem({ system, evolutionaryContext });
  let lastError = null;

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s) em ${label}`)), ms)
      )
    ]);

  if (groq && !imagePath) {
    for (const model of ["llama-3.3-70b-versatile", "llama3-70b-8192"]) {
      try {
        const res = await withTimeout(
          groq.chat.completions.create({
            model,
            messages: [
              { role: "system", content: combinedSystem },
              { role: "user", content: user }
            ],
            response_format: { type: "json_object" },
            max_tokens: 4000
          }),
          30000,
          `Groq/${model}`
        );
        return JSON.parse(res.choices[0].message.content);
      } catch (err) {
        lastError = err;
      }
    }
  }

  if (SAMBANOVA_API_KEY && !imagePath) {
    try {
      const res = await withTimeout(
        axios.post(
          "https://api.sambanova.ai/v1/chat/completions",
          {
            model: "Meta-Llama-3.3-70B-Instruct",
            messages: [
              { role: "system", content: combinedSystem },
              { role: "user", content: user }
            ],
            response_format: { type: "json_object" },
            max_tokens: 4000
          },
          { headers: { Authorization: `Bearer ${SAMBANOVA_API_KEY}`, "Content-Type": "application/json" }, timeout: 55000 }
        ),
        60000,
        "SambaNova"
      );
      const content = res.data.choices[0].message.content;
      return typeof content === "string" ? JSON.parse(content) : content;
    } catch (err) {
      lastError = err;
    }
  }

  if (!gemini) {
    const isRate = lastError?.status === 429 || lastError?.response?.status === 429;
    throw new Error(isRate
      ? "Limite de uso Groq/SambaNova atingido. Configure GEMINI_API_KEY no Render."
      : `IA Offline. Último erro: ${lastError?.message || "Chave ausente"}`
    );
  }

  const model = gemini.getGenerativeModel({ model: "gemini-1.5-flash" });
  const parts = [`${combinedSystem}\n\nResponda ESTRITAMENTE em formato JSON. Não use Markdown.\n\n${user}`];
  if (imagePath && fs.existsSync(imagePath)) {
    const imageData = fs.readFileSync(imagePath);
    parts.push({ inlineData: { data: imageData.toString("base64"), mimeType: "image/png" } });
  }
  const result = await withTimeout(model.generateContent(parts), 60000, "Gemini");
  const text = result.response.text();
  const parsed = safeJsonParse(text);
  if (!parsed) throw new Error("Falha no parse JSON da Gemini.");
  return parsed;
}

// ---------------- routes base ----------------

app.post("/api/auth", requireAppPassword, async (req, res) => {
  try {
    const accounts = [];
    for (const token of IG_TOKENS) {
      try {
        const pagesRes = await callFbApiWithRetry(() =>
          axios.get("https://graph.facebook.com/v21.0/me/accounts", {
            params: { fields: "instagram_business_account{id,username,name,followers_count,biography,media_count}", access_token: token }
          })
        );
        const pages = pagesRes.data.data || [];
        for (const p of pages) {
          if (p.instagram_business_account) {
            accounts.push({ ...p.instagram_business_account, name: p.instagram_business_account.name || p.name, is_business: true });
            await getClientMemory(p.instagram_business_account.username);
          }
        }
      } catch (_) {
        try {
          const r = await axios.get("https://graph.instagram.com/v21.0/me", {
            params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
          });
          accounts.push({ ...r.data, is_business: false });
          await getClientMemory(r.data.username);
        } catch (_) {}
      }
    }
    req.session.logged = true;
    req.session.accounts = accounts;
    res.json({ success: true, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function resolveToken(igId) {
  for (const token of IG_TOKENS) {
    try {
      const r = await axios.get("https://graph.facebook.com/v21.0/me/accounts", {
        params: { fields: "instagram_business_account{id}", access_token: token }
      });
      const found = (r.data.data || []).find(p => p.instagram_business_account?.id === igId);
      if (found) return token;
    } catch (_) {}
    try {
      const r = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: { fields: "id", access_token: token }
      });
      if (r.data.id === igId) return token;
    } catch (_) {}
  }
  return null;
}

app.get("/api/me", (req, res) => res.json({ logged: !!req.session.logged, accounts: req.session.accounts || [] }));
app.get("/api/auth/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get("/api/version", (req, res) => res.json({ version: "2026.05-Ideale-v4.0-Platinum" }));

app.get("/api/debug-status", (req, res) => {
  const recentFbCalls = fbCallTimestamps.filter(t => Date.now() - t < FB_WINDOW_MS).length;
  res.json({
    env: process.env.NODE_ENV || "development",
    groq: !!GROQ_API_KEY,
    gemini: !!GEMINI_API_KEY,
    sambanova: !!SAMBANOVA_API_KEY,
    openai: !!OPENAI_API_KEY,
    openai_model: OPENAI_MODEL,
    mongodb: mongoose.connection.readyState === 1,
    session_store: MONGODB_URI ? "mongodb" : "memory",
    app_password_set: !!APP_PASSWORD,
    tokens: IG_TOKENS.length,
    fb_calls_recent: recentFbCalls,
    fb_throttle_active: recentFbCalls >= FB_MAX_CALLS_PER_MIN,
    timestamp: new Date()
  });
});

// ---------------- PREMIUM FIX: /api/generate ----------------

app.post("/api/generate", requireAuth, async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;

  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada." });

  const requested = {
    reels: Math.max(0, Number(reels) || 0),
    carrossel: Math.max(0, Number(carousels) || 0),
    estatico: Math.max(0, Number(singlePosts) || 0),
  };

  const totalRequested = requested.reels + requested.carrossel + requested.estatico;
  if (totalRequested > 15) return res.status(400).json({ error: "Total de posts não pode exceder 15 por plano." });

  const mem = await getClientMemory(acc.username);
  const timings = getBestPostingTimes(mem.niche);

  const topSuccesses = (mem.evolutionary_dna?.top_successes || []).slice(-3);
  const evolutionContext = topSuccesses.length
    ? `\nPADRÕES QUE JÁ FUNCIONARAM NESTA CONTA (incorpore a profundidade, não o tema):\n${topSuccesses.map(s => `- TEMA: "${s.subject}" | NOTA: ${s.rating}/10`).join('\n')}`
    : "";

  const reelsHooks = getHookLibrary("reels");
  const carHooks = getHookLibrary("carrossel");

  const prompt = `MISSÃO: Planejamento Tático Mensal de 4 Semanas para @${acc.username}.

════ CONTEXTO DA MARCA ════
Nicho: ${mem.niche || 'Inferir pelo username'}
Público: ${mem.audience || 'Inferir pelo nicho'}
Tom: ${tone}
Objetivo: ${goal}
Mix OBRIGATÓRIO: ${requested.reels} Reels | ${requested.carrossel} Carrosséis | ${requested.estatico} Estáticos
Melhores dias: ${timings.days} | Horários: ${timings.times}
Por quê: ${timings.reasoning}
${evolutionContext}

REGRAS CRÍTICAS:
- Retorne exatamente ${totalRequested} posts.
- Respeite o MIX OBRIGATÓRIO acima (quantidade por formato).
- Se você errar o mix, o resultado será rejeitado.

JSON:
{ "posts": [ { "n": 1, "week_funnel": "...", "format": "reels|carrossel|estatico", "theme": "...", "posting_suggestion": "...", "visual_audio_direction": "...", "script_or_slides": ["..."], "caption": "...", "strategic_logic": "...", "expected_metric": "..." } ] }`;

  try {
    const combinedSystem = buildCombinedSystem({ system: SYSTEM_PROMPTS.PLANNER_CORE, evolutionaryContext: evolutionContext });

    // 1) gera o lote principal
    const { output } = await generateWithPipeline({
      clients: aiClients,
      log,
      combinedSystem,
      userPrompt: prompt,
      formatHint: "auto"
    });

    let posts = Array.isArray(output?.posts) ? output.posts : [];
    // normaliza formatos
    posts = posts.map(p => ({ ...p, format: normalizeFormat(p.format) }));

    // 2) conta o que veio
    const countBy = { reels: 0, carrossel: 0, estatico: 0 };
    for (const p of posts) countBy[p.format] = (countBy[p.format] || 0) + 1;

    const missing = {
      reels: Math.max(0, requested.reels - countBy.reels),
      carrossel: Math.max(0, requested.carrossel - countBy.carrossel),
      estatico: Math.max(0, requested.estatico - countBy.estatico),
    };

    log.info("📌 Mix solicitado:", requested, "| Mix gerado:", countBy, "| Faltando:", missing);

    // 3) se faltar, gera PREMIUM por tipo faltante
    const generatedMissing = [];

    if (missing.reels > 0) {
      const batch = await generateMissingBatch({
        clients: aiClients,
        log,
        combinedSystem,
        accountUsername: acc.username,
        niche: mem.niche,
        audience: mem.audience,
        goal,
        tone,
        timings,
        count: missing.reels,
        format: "reels",
        hookLibrary: reelsHooks
      });
      generatedMissing.push(...(batch.posts || []).map(p => ({ ...p, format: "reels" })));
    }

    if (missing.carrossel > 0) {
      const batch = await generateMissingBatch({
        clients: aiClients,
        log,
        combinedSystem,
        accountUsername: acc.username,
        niche: mem.niche,
        audience: mem.audience,
        goal,
        tone,
        timings,
        count: missing.carrossel,
        format: "carrossel",
        hookLibrary: carHooks
      });
      generatedMissing.push(...(batch.posts || []).map(p => ({ ...p, format: "carrossel" })));
    }

    if (missing.estatico > 0) {
      const batch = await generateMissingBatch({
        clients: aiClients,
        log,
        combinedSystem,
        accountUsername: acc.username,
        niche: mem.niche,
        audience: mem.audience,
        goal,
        tone,
        timings,
        count: missing.estatico,
        format: "estatico",
        hookLibrary: getHookLibrary("estatico")
      });
      generatedMissing.push(...(batch.posts || []).map(p => ({ ...p, format: "estatico" })));
    }

    // 4) junta tudo
    posts = [...posts, ...generatedMissing].map(p => ({ ...p, format: normalizeFormat(p.format) }));

    // 5) agora garante o mix exato selecionando (se sobrar)
    const buckets = {
      reels: posts.filter(p => p.format === "reels"),
      carrossel: posts.filter(p => p.format === "carrossel"),
      estatico: posts.filter(p => p.format === "estatico"),
    };

    const finalPosts = [
      ...buckets.reels.slice(0, requested.reels),
      ...buckets.carrossel.slice(0, requested.carrossel),
      ...buckets.estatico.slice(0, requested.estatico),
    ];

    // 6) re-numera e posting suggestion
    finalPosts.forEach((p, idx) => {
      p.n = idx + 1;
      p.posting_suggestion = p.posting_suggestion || `${timings.days.split(",")[idx % 3]?.trim()} às ${timings.times.split(" e ")[0]}`;
    });

    const result = { posts: finalPosts };

    mem.saved_planners.push({ date: new Date(), goal, posts: finalPosts });
    if (mem.saved_planners.length > 15) mem.saved_planners.shift();
    await mem.save();

    res.json(result);
  } catch (e) {
    log.error("❌ Erro /api/generate:", e.message);
    res.status(500).json({ error: `Falha no Planejamento: ${e.message}` });
  }
});

// ---------------- /api/single-post (mantido) ----------------

app.post("/api/single-post", requireAuth, async (req, res) => {
  const { igId, format, subject, angle, intensity } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada." });

  const mem = await getClientMemory(acc.username);
  const hooks = getHookLibrary(format);
  const timings = getBestPostingTimes(mem.niche);

  const prompt = `UM POST ESTRATÉGICO PREMIUM para @${acc.username}.
CONTEXTO: Nicho: ${mem.niche || 'Geral'}. Público: ${mem.audience || 'Geral'}.
TEMA: ${subject}. FORMATO: ${format}. ÂNGULO: ${angle}. INTENSIDADE COMERCIAL: ${intensity}/10.
MELHOR HORÁRIO: ${timings.times.split(' e ')[0]} (${timings.days.split(',')[0].trim()})

PADRÕES DE GANCHO DISPONÍVEIS:
${hooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}

JSON:
{
  "format": "${normalizeFormat(format)}",
  "theme": "${subject}",
  "posting_suggestion": "${timings.days.split(',')[0].trim()} às ${timings.times.split(' e ')[0]}",
  "visual_audio_direction": "Direção detalhada (30+ palavras)",
  "script_or_slides": ["GANCHO (0-3s): 25+ palavras", "PARTE 2: ...", "PARTE 3: ...", "PARTE 4: ...", "CTA: ..."],
  "caption": "Legenda completa 100-200 palavras",
  "strategic_logic": "Por que este post converte para intensidade ${intensity}/10",
  "hook_pattern_used": "Qual padrão de gancho foi usado e por quê"
}`;

  try {
    const combinedSystem = buildCombinedSystem({ system: SYSTEM_PROMPTS.COPYWRITER, evolutionaryContext: "" });
    const { output } = await generateWithPipeline({
      clients: aiClients,
      log,
      combinedSystem,
      userPrompt: prompt,
      formatHint: normalizeFormat(format)
    });

    const out = { ...output, format: normalizeFormat(output.format || format) };

    mem.single_posts.push({ date: new Date(), subject, format: out.format, angle, ...out });
    if (mem.single_posts.length > 50) mem.single_posts.shift();
    await mem.save();

    res.json(out);
  } catch (e) {
    log.error("❌ Erro /api/single-post:", e.message);
    res.status(500).json({ error: `Falha no Post Único: ${e.message}` });
  }
});

// ---------- endpoints auxiliares mínimos (mantém app vivo) ----------

app.get("/health", (req, res) => res.json({
  status: "ok",
  uptime: process.uptime(),
  db: mongoose.connection.readyState
}));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use("/api/", limiter);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => log.info(`✅ Server rodando em ${BASE_URL} (porta ${PORT})`));
