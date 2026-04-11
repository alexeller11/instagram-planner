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
const { GoogleGenAI } = require("@google/genai");
const { chromium } = require("playwright");
const mongoose = require("mongoose");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const IS_PROD = process.env.NODE_ENV === "production";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const SESSION_SECRET = process.env.SESSION_SECRET || "agency-secret-123";
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const IG_TOKENS = (process.env.IG_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);
const MONGODB_URI = process.env.MONGODB_URI || "";

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

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
  saved_diagnostics: { type: Array, default: [] },
  saved_planners: { type: Array, default: [] },
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

// Redirecionamento amigável para o front-end
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

// --- SINGLETON BROWSER (POUPANÇA DE RAM) ---
let _browser = null;
async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process"]
    });
  }
  return _browser;
}

// --- UTILITÁRIOS DE IA ---
function safeJsonParse(text) {
  try {
    let cleaned = text.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) { return null; }
}

async function callAI({ system, user, imagePath }) {
  if (groq && !imagePath) { // Groq não suporta vision nativo neste SDK da mesma forma
    try {
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        max_tokens: 6000
      });
      return JSON.parse(res.choices[0].message.content);
    } catch (err) { if (!gemini) throw err; }
  }
  
  const model = gemini.getGenerativeModel({ model: "gemini-1.5-flash" });
  const parts = [`${system}\n\nResponda ESTRITAMENTE em formato JSON. Não use Markdown.\n\n${user}`];
  
  if (imagePath && fs.existsSync(imagePath)) {
    const imageData = fs.readFileSync(imagePath);
    parts.push({
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    });
  }
  
  const result = await model.generateContent(parts);
  return safeJsonParse(result.response.text());
}

// --- ROTAS DA API ---
app.post("/api/auth", async (req, res) => {
  try {
    const accounts = [];
    for (const token of IG_TOKENS) {
      const r = await axios.get("https://graph.instagram.com/v21.0/me", {
        params: { fields: "id,name,username,followers_count,media_count,biography", access_token: token }
      });
      accounts.push({ ...r.data, ig_token: token });
      await getClientMemory(r.data.username);
    }
    req.session.logged = true;
    req.session.accounts = accounts;
    res.json({ success: true, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", (req, res) => res.json({ logged: !!req.session.logged, accounts: req.session.accounts || [] }));

app.get("/api/memory/:username", async (req, res) => {
  try {
    const mem = await getClientMemory(req.params.username);
    res.json({
      diagnostics: mem.saved_diagnostics || [],
      planners: mem.saved_planners || [],
      swipe_file: mem.swipe_file || [],
      forbidden: mem.forbidden_words || []
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/dashboard/:igId", async (req, res) => {
  const acc = (req.session.accounts || []).find(a => a.id === req.params.igId);
  if (!acc) return res.status(404).send();
  try {
    const r = await axios.get(`https://graph.instagram.com/v21.0/${acc.id}/media`, {
      params: { fields: "id,caption,media_type,like_count,comments_count,timestamp", limit: 20, access_token: acc.ig_token }
    });
    const media = r.data.data || [];
    const likes = media.reduce((a, b) => a + (b.like_count || 0), 0);
    const comms = media.reduce((a, b) => a + (b.comments_count || 0), 0);
    const er = (((likes + comms) / (media.length || 1)) / (acc.followers_count || 1) * 100).toFixed(2);
    
    res.json({
      metrics: { engagement_rate: er, avg_likes: Math.round(likes/(media.length || 1)), avg_comments: Math.round(comms/(media.length || 1)) },
      format_mix: media.reduce((acc, m) => { acc[m.media_type] = (acc[m.media_type] || 0) + 1; return acc; }, {}),
      recent_posts: media.slice(0, 10)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/quick-verdict", async (req, res) => {
  const { username, followers, er, media } = req.body;
  const prompt = `Conta @${username} tem ${followers} segs, ER de ${er}%. Últimos posts: ${media.slice(0,3).map(m=>m.media_type).join(', ')}. 
  Crie um "Veredito de Estrategista Sênior" RÁPIDO (máx 3 frases) em PORTUGUÊS DIRECIONADO AO DONO.
  Também ESPECULE/INFIRA de forma realista a Demografia desta conta para o Brasil (cidades e estado, sexo e idade dominante, e 2 faixas métricas de melhores horários de tração).
  Retorne JSON: { "verdict": "...", "demographics": { "cities": "...", "gender": "...", "time": "..." } }`;
  try {
    const data = await callAI({ system: "Especialista em métricas de Instagram. Retorne sempre JSON válido.", user: prompt });
    res.json({
      verdict: data.verdict || "Continue o bom trabalho com a audiência.",
      demographics: data.demographics || { cities: "São Paulo, Rio de Janeiro", gender: "Misto Uniforme", time: "11h-13h / 18h-21h" }
    });
  } catch (e) { 
    res.json({ 
      verdict: "Métricas saudáveis, continue o bom trabalho.",
      demographics: { cities: "Apurando cidades...", gender: "Apurando...", time: "Apurando..." }
    }); 
  }
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
    const r = await axios.get(`https://graph.instagram.com/v21.0/${acc.id}/media`, {
      params: { fields: "caption,media_type,like_count", limit: 15, access_token: acc.ig_token }
    });
    postsContext = (r.data.data || []).map(p => `[${p.media_type}] ${p.caption ? p.caption.substring(0, 100) : ''}...`).join(' | ');
  } catch(e) {}

  const prompt = `Faça uma AUDITORIA DIGITAL PROFUNDA E HUMANIZADA para @${acc.username}.
  Você deve deduzir o 'nicho verdadeiro' e o 'tom de voz atual' baseado no feed.
  Conteúdo recente do feed: ${postsContext}
  Nicho Sugerido Pela Agência: ${niche}. Público: ${audience}.
  (Se o feed divergir do sugerido, imponha a realidade da sua leitura).
  Regras (Proibidas): ${mem.forbidden_words.join(", ")}.
  Retorne JSON EXATAMENTE ESTE: 
  { 
    "executive_summary": "resumo profundo", 
    "detected_niche": "nicho lido",
    "detected_tone": "tom de voz lido",
    "bio_analysis": "O que está errado", 
    "bio_suggestions_3D": {
      "authority": "Bio focada em gerar respeito e autoridade + Emojis",
      "connection": "Bio focada em vulnerabilidade e conexão humana",
      "conversion": "Bio agressiva focada em CTA e vendas rápidas"
    },
    "strengths": ["ponto forte 1"], 
    "weaknesses": ["fraco 1"], 
    "pillars": ["pilar editorial 1"], 
    "priority_actions": ["ação 1"] 
  }`;
  
  try {
    const data = await callAI({ system: "Você é o Estrategista-Chefe da Ideale Agency. Seja incisivo, cirúrgico e focado em vendas e branding premium.", user: prompt });
    mem.saved_diagnostics.push({ date: new Date(), ...data });
    await mem.save();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: "Erro na geração do diagnóstico." });
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
  doc.moveDown();
  doc.moveDown();
  
  doc.fontSize(14).fillColor("#2980b9").text("Pilares Editoriais Recomendados");
  (payload.pillars || []).forEach(p => doc.text(`• ${p}`));
  doc.moveDown();
  
  doc.fontSize(10).fillColor("#999999").text("Relatório Confidencial - Ideale Agency", 50, doc.page.height - 50, { align: 'center' });
  doc.end();
});

app.post("/api/competitors", async (req, res) => {
  const { username } = req.body;
  const usernames = username.split(',').map(u => u.trim().replace('@','')).filter(Boolean).slice(0, 3);
  const browser = await getBrowser();
  const results = [];
  
  for (const user of usernames) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`https://www.instagram.com/${user}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const filename = `comp_${user}_${Date.now()}.png`;
      const fullPath = path.join(PUBLIC_TMP_DIR, filename);
      await page.screenshot({ path: fullPath });
      
      const prompt = `Analise visualmente este perfil do Instagram de @${user}. 
      Quais cores dominam? Qual a "vibe" do conteúdo (ex: luxo, educacional, memes)? 
      Dê 1 conselho tático: O que podemos fazer para sermos melhores que este concorrente?
      Retorne JSON: { "colors": "...", "vibe": "...", "counter_attack": "..." }`;
      
      const vision = await callAI({ 
        system: "Você é um espião de marketing digital com visão computacional aguçada.", 
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
    } finally { 
      await context.close(); 
    }
  }
  res.json({ results, analysis: "Varredura de Visão concluída." });
});

app.post("/api/suggest-competitors", async (req, res) => {
  const { niche, city } = req.body;
  const prompt = `Sugira 3 arrobas reais do Instagram (benchmark ou negócio local) no nicho de '${niche}' na região '${city}'. 
  Retorne JSON: { "competitors": ["@nome1", "@nome2", "@nome3"] }`;
  try {
    const data = await callAI({ system: "Especialista em pesquisa de mercado.", user: prompt });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: "Erro buscando recomendação." });
  }
});

app.post("/api/autofill", async (req, res) => {
  const { igId, field_type } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Conta não encontrada" });
  const mem = await getClientMemory(acc.username);
  
  let prompt = "";
  if (field_type === 'niche') prompt = `Analise a bio original do cliente (@${acc.username}): "${acc.biography || ''}". Sugira em até 6 palavras o "Nicho e Diferencial Exato" desta conta. Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'audience') prompt = `Analise a bio original do cliente (@${acc.username}): "${acc.biography || ''}". Qual é o público-alvo que essa conta obviamente tenta atrair e vender? (Resumo em 5 palavras). Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'subject') prompt = `A conta @${acc.username} atua em ${mem.niche || 'conteúdo'}. Nos forneça UMA (1) excelente ideia ESPECÍFICA de "Assunto Tático" para postar hoje, baseada no que esse mercado gosta de ler e comprar. Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'angle') prompt = `Para @${acc.username} vendedo seu serviço, qual seria um gatilho/ângulo criativo forte? Ex (Polêmica do mercado, Erro ignorado, Quebra de crença limitante). Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'city') prompt = `Analise a bio original do cliente (@${acc.username}): "${acc.biography || ''}". Sugira em MAX 3 palavras a LOCALIZAÇÃO MAIS PROVÁVEL ou PRINCIPAL (Cidade/Estado). Se for puramente digital/nacional, responda "Brasil". Retorne JSON: {"suggestion": "..."}`;
  
  try {
    const data = await callAI({ system: "Você é focado em respostas ultra-diretas. Só retorne JSON.", user: prompt });
    res.json(data);
  } catch(e) {
    res.json({ suggestion: "Valor Genérico (Tente Novamente)" });
  }
});

app.post("/api/generate", async (req, res) => {
  const { igId, goal, tone, reels, carousels, singlePosts } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Acct not found" });
  const mem = await getClientMemory(acc.username);

  const prompt = `Crie um planejamento de conteúdo ALTA CONVERSÃO para @${acc.username}.
  Objetivo: ${goal}. Tom de Voz: ${tone}.
  Distribuição solicitada: ${reels} Reels, ${carousels} Carrosséis, ${singlePosts} Estáticos. Pode dividir isso em 4 Semanas de Funil.
  PROIBIDO usar as palavras: ${mem.forbidden_words.join(", ")}.
  Obrigatoriamente, cada post pertence a uma das semanas do Funil de 4 Semanas:
  - Semana 1: Atenção (Topo de Funil / Viral / Curiosidade)
  - Semana 2: Autoridade (Prova / Científico / Bastidores)
  - Semana 3: Conexão (História / Identificação Humana)
  - Semana 4: Conversão (Oferta Direta / Oferta Indireta / Objeção)
  
  Para Reels: Forneça ROTEIROS FEITOS PARA SER FALADOS NO TELEPROMPTER, divididos (0-3s Gancho Impossível de ignorar, Corpo narrativo, CTA estrito de conversão).
  Para Carrossel: Forneça descrição matadora de cada tela.
  Sempre incluir legenda pronta (caption).
  
  Retorne JSON ESTRITO E VÁLIDO:
  {
    "posts": [
      {
        "n": 1,
        "week_funnel": "Semana 1: Atenção",
        "format": "reels",
        "theme": "Assunto",
        "visual_audio_direction": "Instruções do vídeo/arte/áudio",
        "script_or_slides": ["0-3s: Gancho...", "3-15s: Corpo...", "CTA..."],
        "caption": "Legenda persuasiva pronta"
      }
    ]
  }`;
  
  try {
    const data = await callAI({ system: "Você é um Co-Produtor Sênior de Lançamentos e Estrategista. Apenas JSON válido.", user: prompt });
    mem.saved_planners.push({ date: new Date(), goal, posts: (data.posts || []) });
    await mem.save();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: "Erro gerando planejamento." });
  }
});

app.post("/api/single-post", async (req, res) => {
  const { igId, format, subject, angle, intensity } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  if (!acc) return res.status(404).json({ error: "Acct not found" });
  const mem = await getClientMemory(acc.username);
  
  const prompt = `Crie exatamente UM POST para @${acc.username}. 
  Formato: ${format}. Assunto: ${subject}. Ângulo: ${angle}. Intensidade de Venda: ${intensity}/10.
  Palavras proibidas: ${mem.forbidden_words.join(", ")}.
  Para Reels: roteiro script (0-3s, etc). Para Carrosséis: telas separadas.
  Retorne JSON VÁLIDO:
  {
    "format": "${format}",
    "theme": "${subject}",
    "visual_audio_direction": "...",
    "script_or_slides": ["..."],
    "caption": "..."
  }`;
  
  try {
    const data = await callAI({ system: "Crie a copy e roteiro perfeitos. Apenas JSON válido.", user: prompt });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: "Erro gerando post único." });
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

app.listen(PORT, "0.0.0.0", () => console.log(`🔥 Agency Pro em ${BASE_URL}`));
