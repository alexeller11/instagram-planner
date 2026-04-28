require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const MemoryStore = require('memorystore')(session);
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

// ✅ NOVO: motor modular + pipeline
const { buildClients } = require("./ai/engine");
const { generateWithPipeline } = require("./ai/pipeline");

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

// ✅ NOVO: OpenAI env (opcional)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

// Clientes antigos (mantidos p/ compat)
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ✅ NOVO: clientes do motor modular
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

const Client = mongoose.model('Client', clientSchema);

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
    const cleaned = text.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
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
  if (!bio || typeof bio !== 'string') return bio;
  return bio.length > 150 ? bio.substring(0, 150) : bio;
}

// ==========================================
// HELPERS DE ESTRATÉGIA DE CONTEÚDO
// ==========================================

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
  if (fmt.includes("reels")) return hooks.reels;
  if (fmt.includes("carro")) return hooks.carrossel;
  return hooks.estatico;
}

// ==========================================
// MOTOR DE PERSONA PLATINUM — PROMPTS MELHORADOS
// ==========================================
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

  VISION: `Você é um Diretor de Arte com 15 anos de experiência em branding digital.
Analise: identidade visual, coerência cromática, legibilidade mobile (thumb-stop) e posicionamento percebido vs. desejado.
Seja brutal e específico. Nada de "poderia melhorar" — diga exatamente o que está errado e por quê prejudica conversão.`,

  COPYWRITER: `COPYWRITER SÊNIOR — ESPECIALISTA EM CONVERSÃO E RETENÇÃO.

MÉTODO PALCO-PLATEIA:
O post é uma peça em 3 atos. Cada ato tem uma função psicológica.
- Ato 1 (GANCHO): Crie dissonância cognitiva ou reconhecimento imediato de dor. Não descreva — provoque.
- Ato 2 (DESENVOLVIMENTO): Entregue mais do que foi prometido. Use a regra 3:1 — 3 informações que o seguidor não sabia para cada ponto óbvio.
- Ato 3 (CTA): Não peça uma ação. Apresente a consequência de NÃO agir. O CTA deve parecer inevitável, não solicitado.

MÉTRICAS QUE IMPORTAM:
- Taxa de leitura até o fim (retenção)
- Taxa de salvamento (percepção de valor permanente)
- Taxa de compartilhamento (identificação de identidade)
- Taxa de comentário qualificado (não apenas emojis)`,

  PLANNER_CORE: `VOCÊ É O CO-PRODUTOR EXECUTIVO DE CONTEÚDO DA IDEALE AGENCY.

PRINCÍPIO DA PRESSÃO DRAMÁTICA:
Um mês de conteúdo é uma novela em 4 episódios. O seguidor deve sentir que perdeu algo se não viu o anterior.

ESTRUTURA DE FUNIL EMOCIONAL OBRIGATÓRIA:

SEMANA 1 — DESPERTAR (Gatilho: Identidade Ameaçada)
Objetivo: Fazer o seguidor questionar uma crença que tinha como verdade.
Frame: "O motivo pelo qual você ainda não [resultado] não é o que você pensa."
Métrica alvo: Alto alcance (salva + compartilha), comentários de "isso me pegou"

SEMANA 2 — EVIDÊNCIA (Gatilho: Prova Inteligente)
Objetivo: Mostrar o mecanismo por trás do problema identificado na semana 1.
Frame: Dados reais, caso específico, comparação com metodologia visível.
Métrica alvo: Alto salvamento, comentários de "manda no privado"

SEMANA 3 — HUMANIZAÇÃO (Gatilho: Vulnerabilidade Calculada)
Objetivo: O especialista mostra que também errou — mas aprendeu o que o seguidor ainda não sabe.
Frame: "O erro que me custou [X] e o que aprendi que ninguém ensina."
Métrica alvo: Alto comentário (conexão emocional), compartilhamento orgânico

SEMANA 4 — DECISÃO (Gatilho: Custo de Oportunidade)
Objetivo: A oferta chega como consequência natural das 3 semanas anteriores.
Frame: Não venda o produto — venda a versão futura do seguidor que tomou a decisão.
Métrica alvo: Clique no link/DM, conversão direta

REGRAS DE ROTEIRO ABSOLUTAS:
- script_or_slides: 5-7 partes com mínimo 25 palavras por parte, cada uma com função psicológica definida
- Para Reels: visual + fala/texto na tela + mood de áudio + direção de câmera
- Para Carrossel: título do slide + copy + elemento visual + gancho para próximo slide (incomplete loop)
- Para Estáticos: copy principal + sub-copy + elementos visuais específicos + micro-copy de CTA
- Legenda: 100-200 palavras, 3+ quebras de parágrafo, CTA que cria consequência de não-ação`
};

// ✅ NOVO: helper para combinedSystem (reuso no pipeline)
function buildCombinedSystem({ system, evolutionaryContext }) {
  return [
    SYSTEM_PROMPTS.PLATINUM_CORE,
    system,
    evolutionaryContext,
    "ANTES DE RESPONDER: Simule internamente o debate entre um Estrategista de Retenção, um Psicólogo Comportamental e um Copywriter Sênior. Retorne apenas o consenso final em JSON."
  ].filter(Boolean).join("\n\n");
}

// ==========================================
// MOTOR IA COM TIMEOUT E FALLBACK COMPLETO (LEGADO)
// ==========================================
async function callAI({ system, user, imagePath, username }) {
  let evolutionaryContext = "";
  if (username) {
    try {
      const mem = await getClientMemory(username);
      const successes = (mem.evolutionary_dna?.top_successes || []).slice(-3);
      if (successes.length) {
        evolutionaryContext = `\nPADRÕES QUE JÁ FUNCIONARAM NESTA CONTA (incorpore a profundidade, não o tema):\n${successes
          .map(s => `- TEMA: ${s.subject} | NOTA: ${s.rating}/10 | CONTEÚDO: ${truncate(s.content, 150)}`)
          .join("\n")}`;
      }
    } catch (e) { }
  }

  const combinedSystem = buildCombinedSystem({ system, evolutionaryContext });

  const estimatedTokens = Math.round((combinedSystem.length + user.length) / 3.5);
  let lastError = null;

  log.info(`🧠 Chamada IA | [Groq:${!!groq}] [SambaNova:${!!SAMBANOVA_API_KEY}] [Gemini:${!!gemini}] | ~${estimatedTokens} tokens`);

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s) em ${label}`)), ms))
    ]);

  // 1. GROQ
  if (groq && !imagePath) {
    for (const model of ["llama-3.3-70b-versatile", "llama3-70b-8192"]) {
      try {
        log.info(`🤖 Tentando Groq: ${model}`);
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
          30000, `Groq/${model}`
        );
        log.info(`✅ Groq (${model}) respondeu.`);
        return JSON.parse(res.choices[0].message.content);
      } catch (err) {
        const status = err.status || err.response?.status;
        log.warn(`⚠️ Groq (${model}) falhou [${status}]: ${err.message}`);
        lastError = err;
        if (status !== 413 && status !== 429) break;
      }
    }
  }

  // 2. SAMBANOVA
  if (SAMBANOVA_API_KEY && !imagePath) {
    try {
      log.info("🔥 Tentando SambaNova Cloud (Llama 3.3)...");
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
        60000, "SambaNova"
      );
      const content = res.data.choices[0].message.content;
      log.info("✅ SambaNova respondeu.");
      return typeof content === "string" ? JSON.parse(content) : content;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.error?.message || err.message;
      log.warn(`⚠️ SambaNova falhou [${status}]: ${detail}`);
      lastError = err;
    }
  }

  // 3. GEMINI
  if (!gemini) {
    const isRate = lastError?.status === 429 || lastError?.response?.status === 429;
    throw new Error(isRate
      ? "Limite de uso Groq/SambaNova atingido. Configure GEMINI_API_KEY no Render."
      : `IA Offline. Último erro: ${lastError?.message || "Chave ausente"}`
    );
  }

  try {
    log.info("🚀 Tentando Gemini (gemini-1.5-flash)...");
    const model = gemini.getGenerativeModel({
      model: "gemini-1.5-flash",
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    });
    const parts = [`${combinedSystem}\n\nResponda ESTRITAMENTE em formato JSON. Não use Markdown.\n\n${user}`];
    if (imagePath && fs.existsSync(imagePath)) {
      const imageData = fs.readFileSync(imagePath);
      parts.push({ inlineData: { data: imageData.toString("base64"), mimeType: "image/png" } });
    }
    const result = await withTimeout(model.generateContent(parts), 60000, "Gemini");
    const text = result.response.text();
    const parsed = safeJsonParse(text);
    if (!parsed) throw new Error("Falha no parse JSON da Gemini.");
    log.info("✅ Gemini respondeu.");
    return parsed;
  } catch (err) {
    const isRateLimit = err.message?.includes("429") || err.status === 429;
    throw new Error(`Falha Crítica IA: ${isRateLimit ? "Cota Gemini esgotada." : err.message}`);
  }
}

const dashCache = new Map();
const DASH_CACHE_TTL = 5 * 60 * 1000;

// ==========================================
// ROTAS DA API
// ==========================================
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
      } catch (e) {
        try {
          const r = await axios.get("https://graph.instagram.com/v21.0/me", {
            params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
          });
          accounts.push({ ...r.data, is_business: false });
          await getClientMemory(r.data.username);
        } catch (err) { }
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
    } catch (_) { }
    try {
      const r = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: { fields: "id", access_token: token }
      });
      if (r.data.id === igId) return token;
    } catch (_) { }
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
    dash_cache_entries: dashCache.size,
    timestamp: new Date()
  });
});

// Invalidação manual de cache do dashboard
app.post("/api/dashboard/invalidate/:igId", requireAuth, (req, res) => {
  dashCache.delete(req.params.igId);
  res.json({ success: true, message: "Cache invalidado." });
});

app.get("/api/memory/:username", requireAuth, async (req, res) => {
  try {
    const mem = await getClientMemory(req.params.username);
    res.json({
      diagnostics: mem.saved_diagnostics || [],
      planners: mem.saved_planners || [],
      single_posts: (mem.single_posts || []).slice().reverse(),
      swipe_file: mem.swipe_file || [],
      forbidden: mem.forbidden_words || []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/identity/:username", requireAuth, async (req, res) => {
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

// ==========================================
// DASHBOARD
// ==========================================
app.get("/api/dashboard/:igId", requireAuth, async (req, res) => {
  const igId = req.params.igId;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(403).json({ error: "Acesso negado." });

  const cached = dashCache.get(igId);
  if (cached && Date.now() - cached.ts < DASH_CACHE_TTL) {
    log.info(`📦 Dashboard cache hit: ${igId}`);
    return res.json(cached.data);
  }

  try {
    const token = await resolveToken(igId);
    if (!token) return res.status(401).json({ error: "Token não encontrado para esta conta." });

    let media = [];
    try {
      const r = await callFbApiWithRetry(() =>
        axios.get(`https://graph.facebook.com/v21.0/${igId}/media`, {
          params: {
            fields: "id,caption,media_type,like_count,comments_count,timestamp,insights.metric(reach,impressions,engagement)",
            limit: 15,
            access_token: token
          }
        })
      );
      media = r.data.data || [];
    } catch (mediaErr) {
      log.warn(`⚠️ Falha ao buscar media insights detalhados (${mediaErr.message}). Tentando fallback básico...`);
      try {
        const r2 = await callFbApiWithRetry(() =>
          axios.get(`https://graph.facebook.com/v21.0/${igId}/media`, {
            params: { fields: "id,caption,media_type,like_count,comments_count,timestamp", limit: 15, access_token: token }
          })
        );
        media = r2.data.data || [];
      } catch (fallbackErr) {
        log.error(`❌ Fallback de media também falhou: ${fallbackErr.message}`);
      }
    }

    const likes = media.reduce((a, b) => a + (b.like_count || 0), 0);
    const comms = media.reduce((a, b) => a + (b.comments_count || 0), 0);
    const totalReach = media.reduce((a, b) => {
      const reachVal = b.insights?.data?.find(m => m.name === 'reach')?.values?.[0]?.value || 0;
      return a + reachVal;
    }, 0);
    const er = media.length > 0
      ? (((likes + comms) / media.length) / (acc.followers_count || 1) * 100).toFixed(2)
      : "0.00";
    const sorted = [...media].sort((a, b) => (b.like_count || 0) - (a.like_count || 0));

    const result = {
      metrics: {
        engagement_rate: er,
        avg_likes: media.length ? Math.round(likes / media.length) : 0,
        avg_comments: media.length ? Math.round(comms / media.length) : 0,
        total_reach_recent: totalReach,
        posts_analyzed: media.length
      },
      format_mix: media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type] || 0) + 1; return acc; }, {}),
      recent_posts: media.slice(0, 10),
      top_posts: sorted.slice(0, 3),
      worst_posts: sorted.slice(-3).reverse()
    };
    dashCache.set(igId, { ts: Date.now(), data: result });
    res.json(result);
  } catch (e) {
    log.error("❌ Erro /api/dashboard:", e.message);
    res.json({
      metrics: { engagement_rate: "0.00", avg_likes: 0, avg_comments: 0, total_reach_recent: 0, posts_analyzed: 0 },
      format_mix: {},
      recent_posts: [],
      top_posts: [],
      worst_posts: [],
      _warning: e.message
    });
  }
});

// ==========================================
// QUICK VERDICT
// ==========================================
app.post("/api/quick-verdict", requireAuth, async (req, res) => {
  const { username, followers, er, igId } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(403).json({ error: "Acesso negado." });

  let realInsights = { reach: 0, impressions: 0, cities: "Brasil (Principal)" };
  let isReal = false;

  if (acc && acc.is_business) {
    try {
      const token = await resolveToken(igId);
      if (token) {
        try {
          const insightRes = await callFbApiWithRetry(() => axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
            params: { metric: "reach,impressions", period: "day", access_token: token }
          }));
          const rVal = insightRes.data.data.find(m => m.name === 'reach')?.values.slice(-1)[0]?.value || 0;
          const iVal = insightRes.data.data.find(m => m.name === 'impressions')?.values.slice(-1)[0]?.value || 0;
          if (rVal > 0) { realInsights.reach = rVal * 30; realInsights.impressions = iVal * 30; isReal = true; }
        } catch (insErr) { log.warn(`⚠️ Insights reach/impressions indisponíveis: ${insErr.message}`); }

        try {
          const audienceRes = await callFbApiWithRetry(() => axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
            params: { metric: "audience_city", period: "lifetime", access_token: token }
          }));
          const citiesMap = audienceRes.data.data?.[0]?.values?.[0]?.value || {};
          const topCities = Object.keys(citiesMap).slice(0, 3).join(", ");
          if (topCities) realInsights.cities = topCities;
        } catch (citErr) { log.warn(`⚠️ Cidades indisponíveis (permissão): ${citErr.message}`); }
      }
    } catch (e) { log.warn("⚠️ Erro geral quick-verdict insights:", e.message); }
  }

  if (!isReal || realInsights.reach === 0) {
    realInsights.reach = Math.round((followers || 100) * ((parseFloat(er) || 1) / 10) * 1.5);
    realInsights.impressions = Math.round(realInsights.reach * 1.8);
  }

  const prompt = `AUDITORIA MÉTRICA PLATINUM para @${username}.
Seguidores: ${followers}. Taxa de Engajamento: ${er}%.
STATUS: ${isReal ? 'DADOS REAIS DA API' : 'ESTIMATIVA PREDITIVA IDEALE'}.

MISSÃO: Veredito de consultor sênior — humanizado, direto, máximo 3 frases densas.
Determine o Health Status: Pico de Tração | Em Maturação | Estável | Alerta de Queda.

JSON:
{
  "verdict": "2-3 frases densas e específicas",
  "demographics": {
    "cities": "${realInsights.cities}",
    "gender": "Estimado com base no nicho",
    "time": "Melhor horário estimado"
  },
  "health_status": "..."
}`;

  try {
    const data = await callAI({ system: "Estrategista de Dados Premium. Consultor humano sênior. Zero clichês.", user: prompt });
    res.json({
      verdict: data.verdict || "Conta em análise. Execute o Diagnóstico Avançado para leitura completa.",
      demographics: {
        cities: realInsights.cities,
        gender: data.demographics?.gender || "Misto",
        time: data.demographics?.time || "19h-21h"
      },
      health_status: data.health_status || (parseFloat(er) > 3 ? "Pico de Tração" : "Estável"),
      real_metrics: realInsights,
      is_real: isReal
    });
  } catch (e) {
    res.json({
      verdict: "Análise Preditiva: Conta em fase de aquecimento de base. Focar em retenção e consistência de postagem.",
      demographics: { cities: realInsights.cities, gender: "Misto", time: "19h" },
      health_status: parseFloat(er) > 3 ? "Pico de Tração" : "Estável",
      real_metrics: realInsights,
      is_real: isReal
    });
  }
});

// ==========================================
// AVALIAÇÃO DE POST — CRITÉRIOS PONDERADOS
// ==========================================
app.post("/api/evaluate-post", requireAuth, async (req, res) => {
  const { theme, script_or_slides, caption, username } = req.body;
  const mem = username ? await getClientMemory(username) : null;

  const prompt = `AVALIAÇÃO TÉCNICA DE CONTEÚDO — NÍVEL DIRETOR DE CRIAÇÃO.

POST:
Tema: ${theme}
Roteiro: ${JSON.stringify(script_or_slides)}
Legenda: ${caption}
Nicho da conta: ${mem?.niche || 'Geral'}
Público: ${mem?.audience || 'Geral'}

CRITÉRIOS (média ponderada = score final):
1. FORÇA DO GANCHO (peso 3x): Os primeiros 3s/palavras provocam curiosidade ou dissonância real?
   0-3: Genérico ("você sabia", pergunta óbvia) | 4-6: Intenção mas não surpreende | 7-9: Cria tensão genuína | 10: Para qualquer membro do público no piloto automático
2. ESPECIFICIDADE (peso 2x): Tem dados, exemplos ou situações reconhecíveis?
   0-3: Só abstrações | 4-6: Alguns exemplos | 7-9: Dados reais ou situações muito específicas | 10: Só quem é do nicho entende a profundidade
3. RETENÇÃO (peso 2x): Cada parte leva para a próxima? Existe "loop incompleto"?
4. QUALIDADE DO CTA (peso 1x): A ação é inevitável ou solicitada?
   0-3: "Comente sim" | 7-10: CTA que apresenta consequência de não agir
5. ALINHAMENTO COM PÚBLICO (peso 2x): Ressoa com o público específico desta conta?

Retorne JSON:
{
  "score": 7.5,
  "breakdown": {
    "hook": { "score": 8, "feedback": "..." },
    "specificity": { "score": 7, "feedback": "..." },
    "retention": { "score": 6, "feedback": "..." },
    "cta": { "score": 9, "feedback": "..." },
    "audience_fit": { "score": 7, "feedback": "..." }
  },
  "analysis": { "hook": "...", "body": "...", "cta": "..." },
  "refined_caption": "Legenda melhorada completa",
  "script_improvements": ["Melhoria específica 1", "Melhoria específica 2", "Melhoria específica 3"],
  "better_hook_suggestion": "Como o gancho poderia ser 20% mais forte"
}`;

  try {
    const data = await callAI({ system: "Diretor de Criação com 10 anos avaliando conteúdo premium. Brutal, específico, construtivo. Só JSON.", user: prompt, username });
    if (username && data.score >= 8) {
      const mem = await getClientMemory(username);
      mem.evolutionary_dna.top_successes.push({ subject: theme, content: caption, rating: data.score, date: new Date() });
      if (mem.evolutionary_dna.top_successes.length > 20) mem.evolutionary_dna.top_successes.shift();
      await mem.save();
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// DIAGNÓSTICO
// ==========================================
app.post("/api/intelligence", requireAuth, async (req, res) => {
  const { igId, niche, audience } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(403).json({ error: "Acesso negado." });

  const mem = await getClientMemory(acc.username);
  mem.niche = niche; mem.audience = audience;
  await mem.save();

  let postsContext = "";
  try {
    const token = await resolveToken(igId);
    if (token) {
      const r = await callFbApiWithRetry(() =>
        axios.get(`https://graph.instagram.com/v21.0/${acc.id}/media`, {
          params: { fields: "caption,media_type,like_count", limit: 10, access_token: token }
        })
      );
      postsContext = (r.data.data || [])
        .map(p => `[${p.media_type}] ${truncate(p.caption, 80)}`)
        .join(' | ')
        .substring(0, 1500);
    }
  } catch (e) { log.warn("⚠️ Não foi possível buscar posts para diagnóstico:", e.message); }

  const prompt = `AUDITORIA DIGITAL PLATINUM para @${acc.username}.

DADOS:
Bio atual: ${acc.biography || 'Não fornecida'}
Feed: ${postsContext || 'Indisponível'}
Nicho: ${niche}. Público: ${audience}.

Diga o que os outros não têm coragem de dizer. Análise como se tivesse estudado esta conta por 2 semanas.

REGRAS DAS BIOS (inflexíveis):
- MÁXIMO 150 caracteres por bio (limite técnico do Instagram)
- Sem verbos no gerúndio ("ajudando", "transformando")
- Sem "especialista em" seguido de coisa óbvia
- Específica o suficiente para alienar quem não é o público

JSON:
{
  "executive_summary": "Análise honesta em 3 frases densas — o que está bem, o que é crítico e o maior gap",
  "detected_niche": "nicho específico detectado",
  "detected_tone": "tom de voz atual detectado",
  "bio_analysis": "O que está errado na bio e por quê prejudica conversão",
  "bio_suggestions_3D": {
    "authority": "Bio max 150 chars — credenciais + resultado + para quem",
    "connection": "Bio max 150 chars — dor + transformação + identificação",
    "conversion": "Bio max 150 chars — CTA + prova + urgência"
  },
  "strengths": ["Ponto forte com exemplo específico do feed", "Ponto forte 2"],
  "weaknesses": ["Fraqueza crítica — o que custa em resultado", "Fraqueza 2"],
  "pillars": ["Pilar editorial específico para este nicho", "Pilar 2", "Pilar 3"],
  "priority_actions": ["Ação imediata (próximos 7 dias)", "Ação de médio prazo (30 dias)"],
  "hidden_opportunity": "Posicionamento que este perfil não explora mas deveria"
}`;

  try {
    const data = await callAI({ system: "Estrategista de Elite. Inale Storytelling e Exale Resultados.", user: prompt });

    if (data.bio_suggestions_3D) {
      data.bio_suggestions_3D.authority  = enforceBioLimit(data.bio_suggestions_3D.authority);
      data.bio_suggestions_3D.connection = enforceBioLimit(data.bio_suggestions_3D.connection);
      data.bio_suggestions_3D.conversion = enforceBioLimit(data.bio_suggestions_3D.conversion);
    }

    mem.saved_diagnostics.push({ date: new Date(), ...data });
    if (mem.saved_diagnostics.length > 20) mem.saved_diagnostics.shift();
    await mem.save();
    res.json(data);
  } catch (e) {
    log.error("❌ Erro /api/intelligence:", e.message);
    res.status(500).json({ error: `Falha no Diagnóstico: ${e.message}` });
  }
});

app.post("/api/export-diagnostic", requireAuth, async (req, res) => {
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
  if (payload.hidden_opportunity) {
    doc.fontSize(14).fillColor("#f39c12").text("Oportunidade Oculta");
    doc.fontSize(11).fillColor("#333333").text(payload.hidden_opportunity, { align: 'justify' }).moveDown();
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

// ==========================================
// SPY DE CONCORRENTES
// ==========================================
app.post("/api/competitors", requireAuth, async (req, res) => {
  const { username } = req.body;
  const usernames = username.split(',').map(u => u.trim().replace('@', '')).filter(Boolean).slice(0, 3);
  const browser = await getBrowser();
  if (!browser) return res.status(500).json({ error: "Navegador indisponível. Tente novamente." });
  const results = [];
  for (const user of usernames) {
    let context;
    try {
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      log.info(`📡 Capturando perfil: @${user}...`);
      await page.goto(`https://www.instagram.com/${user}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
      const filename = `comp_${user}_${Date.now()}.png`;
      const fullPath = path.resolve(PUBLIC_TMP_DIR, filename);
      await page.screenshot({ path: fullPath, fullPage: false });
      const prompt = `Analise @${user}. Cores dominantes? Vibe (luxo, popular, técnico)? Posicionamento percebido? Counter-attack: como se diferenciar e ganhar mercado deste perfil?
JSON: { "colors": "...", "vibe": "...", "positioning": "...", "counter_attack": "..." }`;
      const vision = await callAI({ system: "Espião de Marketing com visão de Diretor de Arte.", user: prompt, imagePath: fullPath });
      results.push({ username: user, screenshot: `/tmp/${filename}`, analysis: vision || { vibe: "Inconsistente", counter_attack: "Focar em conteúdo autoral." } });
    } catch (e) {
      log.error(`❌ Erro ao capturar @${user}:`, e.message);
      _browser = null;
      results.push({ username: user, screenshot: null, analysis: { vibe: "Erro na captura", counter_attack: "Tentar manualmente." } });
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }
  res.json({ results, analysis: "Varredura concluída." });
});

app.post("/api/suggest-competitors", requireAuth, async (req, res) => {
  const { niche, city } = req.body;
  const prompt = `Sugira 3 arrobas reais do Instagram (benchmark ou negócio local) no nicho de '${niche}' na região '${city}'.
JSON: { "competitors": ["@nome1", "@nome2", "@nome3"] }`;
  try {
    const data = await callAI({ system: "Especialista em pesquisa de mercado.", user: prompt });
    res.json(data);
  } catch (e) { res.status(500).json({ error: "Erro buscando recomendação." }); }
});

// ==========================================
// ANÁLISE COMPETITIVA PROFUNDA (NOVA)
// ==========================================
app.post("/api/competitor-deep", requireAuth, async (req, res) => {
  const { igId, competitors } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada." });
  const mem = await getClientMemory(acc.username);

  const prompt = `ANÁLISE COMPETITIVA ESTRATÉGICA para @${acc.username}.
Nicho: ${mem.niche || 'A inferir'}. Público: ${mem.audience || 'A inferir'}.
Concorrentes: ${(competitors || []).join(', ')}

Identifique os Espaços em Branco — posicionamentos que NENHUM concorrente ocupa ainda.

JSON:
{
  "market_landscape": "Quem domina e por quê. Leitura honesta do mercado.",
  "competitors": [
    {
      "username": "@handle",
      "perceived_positioning": "Como o mercado os vê",
      "content_strategy": "Padrão de conteúdo usado",
      "audience_owned": "Fatia de mercado que têm",
      "weakness": "Ponto cego — o que NÃO estão fazendo",
      "threat_level": "baixo|médio|alto",
      "beat_them_with": "Estratégia específica para ganhar a fatia deles"
    }
  ],
  "white_spaces": ["Posicionamento que ninguém ocupa ainda neste nicho"],
  "our_unique_angle": "Qual posicionamento @${acc.username} deveria tomar que nenhum concorrente ocupa",
  "content_gaps": ["Tema que o mercado precisa mas ninguém cobre bem"],
  "30_day_battle_plan": "3 movimentos concretos para ganhar terreno em 30 dias"
}`;

  try {
    const data = await callAI({ system: "Consultor de Estratégia Competitiva Digital. Brutal, específico, orientado a resultado.", user: prompt, username: acc.username });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// HASHTAG INTELLIGENCE
// ==========================================
app.post("/api/hashtags", requireAuth, async (req, res) => {
  const { igId, objective, niche: customNiche } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  let resolvedNiche = customNiche || "Marketing Digital";
  if (acc) {
    try {
      const mem = await getClientMemory(acc.username);
      if (mem.niche && !customNiche) resolvedNiche = mem.niche;
    } catch (e) { }
  }
  const prompt = `Especialista em SEO e algoritmo do Instagram 2026.
Gere 5 sets de hashtags estratégicos para o nicho: "${resolvedNiche}" com objetivo: "${objective}".
- Misture alta (>1M posts), média (100k-1M) e baixa (<100k) competição.
- Nunca repita a mesma hashtag entre sets.
- 12 a 15 hashtags por set.
- Pelo menos 2-3 hashtags em português por set.
JSON:
{
  "sets": [{ "name": "...", "strategy": "...", "tags": ["#tag1"], "competition": "alta|media|baixa", "best_for": "..." }],
  "banned_to_avoid": ["#tag_shadowban"],
  "pro_tip": "Dica específica para o nicho"
}`;
  try {
    const data = await callAI({ system: "Especialista em SEO e algoritmo do Instagram 2026. Apenas JSON válido.", user: prompt, username: acc?.username });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// GANCHOS POR TENDÊNCIA (NOVA)
// ==========================================
app.post("/api/trend-hook", requireAuth, async (req, res) => {
  const { igId, theme } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada." });
  const mem = await getClientMemory(acc.username);

  const prompt = `Especialista em psicologia de scroll e tendências 2025-2026.
Nicho: "${mem.niche || 'Geral'}". Tema: "${theme}". Público: "${mem.audience || 'Geral'}".

Gere 5 variações de gancho (primeiros 3 segundos) com padrão psicológico diferente em cada.
Padrões disponíveis: Identidade Ameaçada | Polarização Estratégica | Especificidade Numérica | Urgência de Contexto Real | Vulnerabilidade Calculada

JSON:
{
  "hooks": [
    {
      "type": "Identidade Ameaçada",
      "hook": "Texto do gancho (máx 20 palavras)",
      "psychology": "Por que funciona para este público específico",
      "risk_level": "baixo|médio|alto",
      "expected_outcome": "salvamento|compartilhamento|comentário|alcance"
    }
  ],
  "recommended": 0,
  "recommendation_reason": "Por que este gancho é o mais forte para este contexto"
}`;

  try {
    const data = await callAI({ system: "Especialista em psicologia de conteúdo. JSON apenas.", user: prompt, username: acc.username });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// VARIAÇÕES DE LEGENDA POR MÉTRICA (NOVA)
// ==========================================
app.post("/api/caption-variations", requireAuth, async (req, res) => {
  const { igId, theme, format, core_message } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada." });
  const mem = await getClientMemory(acc.username);

  const prompt = `3 variações de legenda para o mesmo post, cada uma otimizada para uma métrica diferente.
Conta: @${acc.username} | Nicho: ${mem.niche} | Público: ${mem.audience}
Tema: ${theme} | Formato: ${format} | Mensagem central: ${core_message}

VERSÃO 1 — Otimizada para SALVAMENTO:
Conteúdo denso como referência. Listas com informação não óbvia, frameworks nomeados, dados específicos.

VERSÃO 2 — Otimizada para COMENTÁRIO:
Polarização saudável ou pergunta que exige opinião pessoal. Declaração controversa + convite explícito à discordância.

VERSÃO 3 — Otimizada para CONVERSÃO:
Problema → dor agravada → ponte → CTA específico de baixa fricção.

JSON:
{
  "variations": [
    {
      "objective": "salvamento",
      "caption": "Legenda completa 100-200 palavras",
      "why_it_works": "Mecanismo psicológico específico",
      "ideal_for": "Quando usar esta versão"
    }
  ],
  "recommendation": "Qual usar baseado no momento do funil"
}`;

  try {
    const data = await callAI({ system: SYSTEM_PROMPTS.COPYWRITER, user: prompt, username: acc.username });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// SWIPE FILE
// ==========================================
app.post("/api/swipe-file/save", requireAuth, async (req, res) => {
  const { username, entry } = req.body;
  try {
    const mem = await getClientMemory(username);
    const safeEntry = {
      date: new Date(),
      ...entry,
      caption: truncate(entry.caption || "", 500),
      notes: truncate(entry.notes || "", 300),
      screenshot: undefined
    };
    mem.swipe_file.push(safeEntry);
    if (mem.swipe_file.length > 30) mem.swipe_file.shift();
    await mem.save();
    res.json({ success: true, total: mem.swipe_file.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// AUTOFILL
// ==========================================
app.post("/api/autofill", requireAuth, async (req, res) => {
  const { igId, field_type } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada" });
  const mem = await getClientMemory(acc.username);
  const bio = truncate(acc.biography, 200);
  const prompts = {
    niche:    `Analise a bio: "${bio}". Sugira o "Nicho e Diferencial Único" (sem clichês). JSON: {"suggestion": "..."}`,
    audience: `Analise a bio: "${bio}". Qual o público-alvo exato (demografia e dor)? JSON: {"suggestion": "..."}`,
    subject:  `Baseado em ${mem.niche || 'este perfil'}, dê uma ideia de post 'fora da caixa' que gere autoridade imediata. JSON: {"suggestion": "..."}`,
    angle:    `Qual gatilho mental (Polêmica, Erro, Desejo Oculto) seria perfeito para esse nicho hoje? JSON: {"suggestion": "..."}`,
    city:     `Analise a bio: "${bio}". Localize a cidade/estado principal ou responda "Brasil (Nacional)". JSON: {"suggestion": "..."}`
  };
  const prompt = prompts[field_type];
  if (!prompt) return res.status(400).json({ error: "field_type inválido" });
  try {
    const data = await callAI({ system: "Respostas ultra-diretas. Só JSON.", user: prompt, username: acc.username });
    res.json(data);
  } catch (e) { res.json({ suggestion: `Erro Técnico: ${e.message}` }); }
});

// ==========================================
// PLANNER MENSAL — (PIPELINE)
// ==========================================
app.post("/api/generate", requireAuth, async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada." });

  const totalPosts = (Number(reels) || 0) + (Number(carousels) || 0) + (Number(singlePosts) || 0);
  if (totalPosts > 15) return res.status(400).json({ error: "Total de posts não pode exceder 15 por plano." });

  const mem = await getClientMemory(acc.username);
  const timings = getBestPostingTimes(mem.niche);

  const topSuccesses = (mem.evolutionary_dna?.top_successes || []).slice(-3);
  const evolutionContext = topSuccesses.length
    ? `\nPADRÕES QUE JÁ FUNCIONARAM NESTA CONTA (incorpore a profundidade, não o tema):\n${topSuccesses.map(s => `- TEMA: "${s.subject}" | NOTA: ${s.rating}/10`).join('\n')}`
    : '';

  const reelsHooks = getHookLibrary("reels").map((h, i) => `  ${i + 1}. ${h}`).join('\n');
  const carHooks = getHookLibrary("carrossel").map((h, i) => `  ${i + 1}. ${h}`).join('\n');

  const prompt = `MISSÃO: Planejamento Tático Mensal de 4 Semanas para @${acc.username}.

════ CONTEXTO DA MARCA ════
Nicho: ${mem.niche || 'Inferir pelo username'}
Público: ${mem.audience || 'Inferir pelo nicho'}
Tom: ${tone}
Objetivo: ${goal}
Mix: ${reels} Reels | ${carousels} Carrosséis | ${singlePosts} Estáticos
Melhores dias: ${timings.days} | Horários: ${timings.times}
Por quê: ${timings.reasoning}
${evolutionContext}

════ BIBLIOTECA DE GANCHOS — USE E ADAPTE ════
Para Reels:
${reelsHooks}

Para Carrosséis:
${carHooks}

════ REGRAS DE QUALIDADE ════
1. Cada post usa um gatilho mental DIFERENTE: Identidade Ameaçada | Custo de Oportunidade | Curiosidade Irresolvida | Prova Social Inversa | Autoridade Casual | Vulnerabilidade Calculada | Urgência Real | Contraste Injusto
2. script_or_slides: 5-7 partes com mínimo 25 palavras cada. Função psicológica definida em cada parte.
   - Reels: [visual] + [fala/texto na tela] + [mood de áudio] + [direção de câmera]
   - Carrosséis: [título] + [copy] + [visual específico] + [gancho para próximo slide]
   - Estáticos: [copy principal] + [sub-copy] + [elementos visuais] + [CTA]
3. caption: 100-200 palavras, 3+ quebras de parágrafo, CTA que cria consequência de não-ação
4. visual_audio_direction: instrução de cinema real (mínimo 30 palavras)
5. strategic_logic: psicologia por trás do post + por que funciona nesta semana do funil

JSON:
{
  "posts": [
    {
      "n": 1,
      "week_funnel": "Semana 1: Despertar · REELS",
      "format": "reels",
      "theme": "Título curto e específico",
      "posting_suggestion": "${timings.days.split(',')[0].trim()} às ${timings.times.split(' e ')[0]}",
      "visual_audio_direction": "Instrução detalhada (30+ palavras)",
      "script_or_slides": ["GANCHO (0-3s): 25+ palavras", "PARTE 2: ...", "PARTE 3: ...", "PARTE 4: ...", "CTA: ..."],
      "caption": "Legenda 100-200 palavras com quebras e CTA",
      "strategic_logic": "Psicologia + por que funciona nesta semana do funil",
      "expected_metric": "salvamento|compartilhamento|comentário|clique"
    }
  ]
}`;

  try {
    const combinedSystem = buildCombinedSystem({ system: SYSTEM_PROMPTS.PLANNER_CORE, evolutionaryContext: evolutionContext });
    const { output } = await generateWithPipeline({
      clients: aiClients,
      log,
      combinedSystem,
      userPrompt: prompt,
      formatHint: "auto"
    });

    if (output.posts) {
      output.posts = output.posts.map((p, i) => ({
        ...p,
        posting_suggestion: p.posting_suggestion || `${timings.days.split(',')[i % 3]?.trim()} às ${timings.times.split(' e ')[0]}`
      }));
    }

    mem.saved_planners.push({ date: new Date(), goal, posts: (output.posts || []) });
    if (mem.saved_planners.length > 15) mem.saved_planners.shift();
    await mem.save();
    res.json(output);
  } catch (e) {
    log.error("❌ Erro /api/generate:", e.message);
    res.status(500).json({ error: `Falha no Planejamento: ${e.message}` });
  }
});

// ==========================================
// POST ÚNICO — (PIPELINE)
// ==========================================
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

INTENSIDADE ${intensity}/10:
${Number(intensity) <= 4
  ? 'Conteúdo de posicionamento. Venda implícita na autoridade. Sem CTA direto de produto.'
  : Number(intensity) <= 7
  ? 'CTA suave ao final — "Se quiser aprofundar, o próximo passo é [X]." Venda como consequência do conteúdo.'
  : 'Post de decisão. O copy deve fazer o seguidor sentir o custo de NÃO agir hoje. CTA direto com prazo ou escassez real.'
}

REGRAS:
- 5-7 partes no roteiro, mínimo 25 palavras cada
- Legenda 100-200 palavras, 3+ quebras de parágrafo
- visual_audio_direction com 30+ palavras
- Gancho nos primeiros 3s usando um dos padrões acima adaptado ao tema

JSON:
{
  "format": "${format}",
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
      formatHint: format || "auto"
    });

    mem.single_posts.push({ date: new Date(), subject, format, angle, ...output });
    if (mem.single_posts.length > 50) mem.single_posts.shift();
    await mem.save();
    res.json(output);
  } catch (e) {
    log.error("❌ Erro /api/single-post:", e.message);
    res.status(500).json({ error: `Falha no Post Único: ${e.message}` });
  }
});

// ==========================================
// EXPORT PDF
// ==========================================
app.post("/api/export-report", requireAuth, (req, res) => {
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
    doc.fontSize(14).fillColor("#22ceb5").text(`${p.week_funnel || 'Planejamento'} | Post ${p.n} - ${String(p.format || "").toUpperCase()} | ${p.theme}`);
    if (p.posting_suggestion) {
      doc.fontSize(10).fillColor("#f39c12").text(`📅 ${p.posting_suggestion}`);
    }
    doc.fontSize(11).fillColor("#e74c3c").text(`Direção Visual/Áudio:`, { continued: true }).fillColor("#333333").text(` ${p.visual_audio_direction || ""}`);
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#2980b9").text("Roteiro / Telas:");
    (p.script_or_slides || []).forEach(s => doc.fillColor("#333333").text(`• ${s}`));
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#27ae60").text("Legenda (Copy):");
    doc.fillColor("#333333").text(p.caption || "", { align: 'justify' });
    if (p.strategic_logic) {
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor("#888888").text(`Lógica: ${p.strategic_logic}`);
    }
    doc.moveDown(2);
  });
  doc.fontSize(10).fillColor("#999999").text("Relatório Confidencial - Ideale Agency", 50, doc.page.height - 50, { align: 'center' });
  doc.end();
});

app.get("/health", (req, res) => res.json({
  status: "ok",
  uptime: process.uptime(),
  db: mongoose.connection.readyState
}));

// Rate limit básico (mantendo leve)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120
});
app.use("/api/", limiter);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => log.info(`✅ Server rodando em ${BASE_URL} (porta ${PORT})`));
