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

// --- MOTOR DE PERSONA PLATINUM ---
const SYSTEM_PROMPTS = {
  STRATEGIST: `Você é o Estrategista-Chefe da Ideale Agency, treinado nos maiores frameworks de marketing (AIDA, Storytelling, Neuromarketing).
  Sua voz é: Sofisticada, Mentoriana, Direct-Response e ALTAMENTE HUMANA. 
  REGRAS DE OURO:
  1. NUNCA faça listas óbvias ou superficiais (ex: "Poste dicas").
  2. Use ganchos baseados em DOR e DESEJO (ex: "O erro silencioso que drena seu lucro").
  3. Evite jargões robóticos. Escreva como um mentor falando com um cliente VIP.
  4. Foque em TRANSFORMAÇÃO e não apenas em informação bruta.`,
  
  Vision: "DIRETOR DE CRIAÇÃO SÊNIOR. Analise estética, cores e o 'feeling' de autoridade. Por que essa conta ganha de nós ou como podemos vencê-la visualmente?",
  Copywriter: "MESTRE DO COPYWRITING HUMANIZADO. Seu texto deve soar como um áudio de WhatsApp de um amigo mentor. Evite listas óbvias. Use ganchos de curiosidade extrema e quebra de padrões. Zero clichês."
};

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}

async function callAI({ system, user, imagePath }) {
  const platinum_core = `VOCÊ É UM HUMANO ESTRATEGISTA. PROIBIDO listas genéricas, PROIBIDO tons robóticos, PROIBIDO 'Aqui estão 3 dicas'. 
  Sua escrita deve ter RITMO, VULNERABILIDADE e AUTORIDADE. Estruture as legendas com parágrafos curtos e um gancho inicial que pare o scroll.`;
  
  const combinedSystem = `${platinum_core}\n\n${system}`;
  if (groq && !imagePath) {
    try {
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: combinedSystem }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        max_tokens: 6000
      });
      return JSON.parse(res.choices[0].message.content);
    } catch (err) { if (!gemini) throw err; }
  }
  
  const model = gemini.getGenerativeModel({ model: "gemini-1.5-flash" });
  const parts = [`${combinedSystem}\n\nResponda ESTRITAMENTE em formato JSON. Não use Markdown.\n\n${user}`];
  
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const imageData = fs.readFileSync(imagePath);
      parts.push({
        inlineData: {
          data: imageData.toString("base64"),
          mimeType: "image/png"
        }
      });
    } catch(e) { console.error("Erro leitura imagem vision:", e); }
  }
  
  const result = await model.generateContent(parts);
  return safeJsonParse(result.response.text());
}

// --- ROTAS DA API ---
app.post("/api/auth", async (req, res) => {
  try {
    const accounts = [];
    for (const token of IG_TOKENS) {
      try {
        // TENTA BUSINESS API (via Facebook Graph)
        const pagesRes = await axios.get("https://graph.facebook.com/v21.0/me/accounts", {
          params: { fields: "instagram_business_account{id,username,name,followers_count,biography,media_count}", access_token: token }
        });
        
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
        } catch (err) {}
      }
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
  const { username, followers, er, media, igId } = req.body;
  const acc = (req.session.accounts || []).find(a => a.id === igId);
  
  let realInsights = { reach: 0, impressions: 0, cities: "Apurando..." };
  let isReal = false;
  
  if (acc && acc.is_business) {
    try {
      const insightRes = await axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
        params: { metric: "reach,impressions", period: "day", access_token: acc.ig_token }
      });
      const audienceRes = await axios.get(`https://graph.facebook.com/v21.0/${acc.id}/insights`, {
        params: { metric: "audience_city", period: "lifetime", access_token: acc.ig_token }
      });
      
      const rVal = insightRes.data.data.find(m => m.name === 'reach')?.values.reverse()[0]?.value || 0;
      const iVal = insightRes.data.data.find(m => m.name === 'impressions')?.values.reverse()[0]?.value || 0;
      
      if (rVal > 0) {
        realInsights.reach = rVal * 30; // Est. mensal
        realInsights.impressions = iVal * 30;
        isReal = true;
      }
      
      const citiesMap = audienceRes.data.data[0]?.values[0]?.value || {};
      realInsights.cities = Object.keys(citiesMap).slice(0, 3).join(", ") || "Apurando...";
    } catch(e) {}
  }

  // Fallback Inteligente baseado em ER e Seguidores se o Reach for 0 ou N/A
  if (!isReal) {
    realInsights.reach = Math.round(followers * (er/50) * 1.5); 
    realInsights.impressions = Math.round(realInsights.reach * 1.8);
  }

  const prompt = `Conta @${username}. Seguidores: ${followers}. ER: ${er}%. 
  STATUS: ${isReal ? 'DADOS REAIS DA META' : 'ESTIMATIVA IA (API BUSY)'}.
  Crie um Veredito PLATINUM (Sênior, Humano, Mentoriano). MÁX 3 frases. 
  Analise o 'Health Status' (Pico de Tração, Estável ou Queda) com base no engajamento de ${er}%.
  Retorne JSON: { "verdict": "...", "demographics": { "cities": "...", "gender": "...", "time": "..." }, "health_status": "..." }`;
  
  try {
    const data = await callAI({ system: "Especialista em métricas premium.", user: prompt });
    res.json({
      verdict: data.verdict,
      demographics: {
        cities: realInsights.cities !== "Apurando..." ? realInsights.cities : (data.demographics?.cities || "Brasil"),
        gender: data.demographics?.gender || "Misto",
        time: data.demographics?.time || "18h-21h"
      },
      health_status: data.health_status || (er > 3 ? "Pico de Tração" : "Estável"),
      real_metrics: realInsights,
      is_real: isReal
    });
  } catch (e) { res.json({ verdict: "Métricas dentro do padrão.", demographics: { cities: "Brasil", gender: "Misto", time: "19h" }, real_metrics: realInsights, is_real: isReal }); }
});

app.post("/api/evaluate-post", async (req, res) => {
  const { theme, script_or_slides, caption } = req.body;
  const prompt = `AVALIE ESTE POST:
  Tema: ${theme}. 
  Roteiro/Estrutura: ${JSON.stringify(script_or_slides)}. 
  Legenda: ${caption}.
  Dê nota de 0 a 10 e analise Hook (Gancho), Body (Corpo) e CTA (Chamada).
  FORNEÇA UM REFINAMENTO DA LEGENDA PARA MAXIMIZAR O ALGORITMO.
  Retorne JSON: { "score": 8.5, "analysis": { "hook": "...", "body": "...", "cta": "..." }, "refined_caption": "..." }`;
  
  try {
    const data = await callAI({ system: "Especialista em Copywriting de Alta Performance.", user: prompt });
    res.json(data);
  } catch(e) { res.status(500).json({ error: "Erro na avaliação." }); }
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

  const prompt = `AUDITORIA DIGITAL PLATINUM para @${acc.username}.
  Você é o Estrategista-Chefe da Ideale. Analise o feed e seja incisivo.
  Feed Atual: ${postsContext}
  Regras: Nicho ${niche}, Público ${audience}.
  Foco: Diferenciação, Autoridade e Branding Humano.
  
  Retorne JSON: 
  { 
    "executive_summary": "Análise densa, sem clichês, foco em branding.", 
    "detected_niche": "nicho lido",
    "detected_tone": "tom de voz lido",
    "bio_analysis": "O que mudar para converter mais.", 
    "bio_suggestions_3D": {
      "authority": "Bio Autoridade Inquestionável",
      "connection": "Bio Conexão Humana",
      "conversion": "Bio Máquina de Vendas"
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
      await page.goto(`https://www.instagram.com/${user}/`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      const filename = `comp_${user}_${Date.now()}.png`;
      const fullPath = path.resolve(PUBLIC_TMP_DIR, filename);
      await page.screenshot({ path: fullPath });
      
      const prompt = `Analise @${user}. Cores? Vibe (luxo, popular)? Counter-attack: Como ser melhor? 
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
  if (field_type === 'niche') prompt = `Analise a bio: "${acc.biography || ''}". Sugira o "Nicho e Diferencial Único" (sem clichês). Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'audience') prompt = `Analise a bio: "${acc.biography || ''}". Qual o público-alvo exato (demografia e dor)? Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'subject') prompt = `Baseado em ${mem.niche || 'este perfil'}, dê uma ideia de post 'fora da caixa' que gere autoridade imediata. Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'angle') prompt = `Qual gatilho mental (Polêmica, Erro, Desejo Oculto) seria perfeito para esse nicho hoje? Retorne JSON: {"suggestion": "..."}`;
  else if (field_type === 'city') prompt = `Analise a bio: "${acc.biography || ''}". Localize a cidade/estado principal ou responda "Brasil (Nacional)". Retorne JSON: {"suggestion": "..."}`;
  
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

  const prompt = `Crie um Planejamento de Lançamento Eterno (Funil 4 Semanas) para @${acc.username}.
  PERSONA DO CLIENTE: Nicho: ${mem.niche}. Público: ${mem.audience}. Tom: ${tone}.
  Distribuição: ${reels} Reels, ${carousels} Carrosséis, ${singlePosts} Estáticos.
  
  DIRETRIZ PLATINUM:
  - Cada post deve ter um MOTIVO PSICOLÓGICO (estratégia silenciosa).
  - Semana 1: Quebra de Padrão (Viral com substância).
  - Semana 2: Doutrinação (Autoridade Técnica).
  - Semana 3: Desejo (Storytelling e Conexão).
  - Semana 4: Fechamento (Conversão Inevitável).
  
  Retorne JSON:
  {
    "posts": [
      {
        "n": 1,
        "week_funnel": "Semana 1: Atenção",
        "format": "reels",
        "theme": "A verdade que ninguém te conta sobre...",
        "visual_audio_direction": "Cena cinematográfica com áudio de tensão",
        "script_or_slides": ["0-3s Gancho Impossível", "Corpo Narrativo", "CTA de Transbordo"],
        "caption": "Legenda humana, mentoriana e densa.",
        "strategic_logic": "Pânico controlado seguido de solução única."
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
  if (!acc) return res.status(404).json({ error: "Conta não encontrada" });
  const mem = await getClientMemory(acc.username);
  
  const prompt = `Crie exatamente UM POST ESTRATÉGICO para @${acc.username}. 
  CONTEXTO DA MARCA: Nicho: ${mem.niche || 'Geral'}. Público: ${mem.audience || 'Geral'}.
  TEMA: ${subject}. FORMATO: ${format}. ÂNGULO: ${angle}. INTENSIDADE: ${intensity}/10.
  
  REGRAS PLATINUM:
  - Não use listas numeradas.
  - O roteiro deve ser fluido, como um vídeo de alto nível da Apple ou de um influenciador premium.
  - A legenda deve ser curta, impactante e usar STORYTELLING.
  - Foque em quebrar uma crença do público.
  
  Retorne JSON VÁLIDO:
  {
    "format": "${format}",
    "theme": "${subject}",
    "visual_audio_direction": "direção de arte épica",
    "script_or_slides": ["parte 1", "parte 2", "..."],
    "caption": "legenda humanizada",
    "strategic_logic": "por que isso vende?"
  }`;
  
  try {
    const data = await callAI({ system: SYSTEM_PROMPTS.COPYWRITER, user: prompt });
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
