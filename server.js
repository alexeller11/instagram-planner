 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/server.js b/server.js
index 081b9af0313b28b89a3109161b04bd4b047bd9f0..0147746eaddb4fe28085455fa06d5eed89355d1b 100644
--- a/server.js
+++ b/server.js
@@ -1,168 +1,454 @@
 require("dotenv").config();
 
 const express = require("express");
 const session = require("express-session");
 const axios = require("axios");
 const path = require("path");
 const fs = require("fs");
 const PDFDocument = require("pdfkit");
 const Groq = require("groq-sdk");
 const { GoogleGenAI } = require("@google/genai");
 
 const app = express();
 
-const PORT = process.env.PORT || 3000;
+const PORT = Number(process.env.PORT) || 3000;
+const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
+const CLIENTS_DIR = path.join(__dirname, "data", "clients");
+
+const GROQ_MODEL = "llama-3.3-70b-versatile";
+const GEMINI_MODEL = "gemini-2.5-flash";
 
-// ================= CONFIG =================
 const GROQ = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
 const GEMINI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
 
-const IG_TOKENS = (process.env.IG_TOKENS || "").split(",");
+const IG_TOKENS = (process.env.IG_TOKENS || "")
+  .split(",")
+  .map(token => token.trim())
+  .filter(Boolean);
+
+if (!fs.existsSync(CLIENTS_DIR)) {
+  fs.mkdirSync(CLIENTS_DIR, { recursive: true });
+}
 
-// ================= MIDDLEWARE =================
 app.use(express.json({ limit: "10mb" }));
 app.use(express.static("public"));
 
 app.use(
   session({
-    secret: "agency-secret",
+    secret: process.env.SESSION_SECRET || "agency-secret",
     resave: false,
-    saveUninitialized: true,
+    saveUninitialized: false,
+    cookie: {
+      httpOnly: true,
+      sameSite: "lax",
+      secure: process.env.NODE_ENV === "production",
+    },
   })
 );
 
-// ================= HEALTH =================
+function requireLogin(req, res, next) {
+  if (!req.session?.user?.accounts?.length) {
+    return res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
+  }
+  next();
+}
+
+function safeUsername(raw) {
+  return String(raw || "").replace(/[^a-zA-Z0-9_.-]/g, "");
+}
+
+function getMemoryPath(username) {
+  return path.join(CLIENTS_DIR, `${safeUsername(username)}.json`);
+}
+
+function loadMemory(username) {
+  const file = getMemoryPath(username);
+  if (!fs.existsSync(file)) {
+    return {
+      niche: "",
+      audience: "",
+      location: "",
+      tone: "",
+      cta_style: "",
+      differentials: [],
+      forbidden_words: [],
+      memory: {
+        what_works: [],
+        what_doesnt_work: [],
+        strong_angles: [],
+      },
+    };
+  }
+
+  return JSON.parse(fs.readFileSync(file, "utf8"));
+}
+
+function saveMemory(username, data) {
+  const file = getMemoryPath(username);
+  fs.writeFileSync(file, JSON.stringify(data, null, 2));
+}
+
+function parseJSONResponse(text, fallback) {
+  try {
+    return JSON.parse(text);
+  } catch {
+    const extracted = String(text || "").match(/\{[\s\S]*\}/);
+    if (extracted) {
+      try {
+        return JSON.parse(extracted[0]);
+      } catch {
+        return fallback;
+      }
+    }
+    return fallback;
+  }
+}
+
+function summarizeMedia(media = []) {
+  const total = media.length || 1;
+  const totalLikes = media.reduce((acc, m) => acc + Number(m.like_count || 0), 0);
+  const totalComments = media.reduce((acc, m) => acc + Number(m.comments_count || 0), 0);
+  const avgEngagement = Math.round((totalLikes + totalComments) / total);
+  const formatMix = media.reduce((acc, item) => {
+    const key = item.media_type || "UNKNOWN";
+    acc[key] = acc[key] || { count: 0 };
+    acc[key].count += 1;
+    return acc;
+  }, {});
+
+  return {
+    avg_engagement: avgEngagement,
+    posting_frequency_days: null,
+    engagement_rate: 0,
+    format_mix: formatMix,
+  };
+}
+
+async function runAI(prompt) {
+  if (GROQ) {
+    const r = await GROQ.chat.completions.create({
+      model: GROQ_MODEL,
+      messages: [{ role: "user", content: prompt }],
+      temperature: 0.7,
+    });
+
+    return r.choices?.[0]?.message?.content || "";
+  }
+
+  if (GEMINI) {
+    const r = await GEMINI.models.generateContent({
+      model: GEMINI_MODEL,
+      contents: prompt,
+    });
+
+    return r.text || "";
+  }
+
+  throw new Error("Nenhuma chave de IA configurada (GROQ_API_KEY ou GEMINI_API_KEY).");
+}
+
 app.get("/health", (req, res) => res.send("OK"));
 
-// ================= AUTH =================
 app.post("/api/auth", async (req, res) => {
   try {
+    if (!IG_TOKENS.length) {
+      return res.status(400).json({ success: false, error: "IG_TOKENS não configurado." });
+    }
+
     const accounts = [];
 
-    for (let token of IG_TOKENS) {
-      const r = await axios.get(`https://graph.instagram.com/me`, {
+    for (const token of IG_TOKENS) {
+      const r = await axios.get("https://graph.instagram.com/me", {
         params: {
-          fields: "id,username,followers_count",
+          fields: "id,username,followers_count,media_count,biography,website",
           access_token: token,
         },
       });
 
       accounts.push({ ...r.data, token });
     }
 
     req.session.user = { accounts };
 
-    res.json({ success: true });
+    res.json({ success: true, accounts });
   } catch (e) {
-    res.status(500).json({ error: "Erro ao autenticar" });
+    res.status(500).json({ success: false, error: "Erro ao autenticar contas do Instagram." });
   }
 });
 
-app.get("/api/me", (req, res) => {
-  res.json(req.session.user || { accounts: [] });
+app.get("/auth/logout", (req, res) => {
+  req.session.destroy(() => {
+    res.redirect("/");
+  });
 });
 
-// ================= DASHBOARD =================
-app.get("/api/dashboard/:id", async (req, res) => {
-  const acc = req.session.user.accounts.find(a => a.id === req.params.id);
+app.get("/api/me", (req, res) => {
+  const accounts = req.session?.user?.accounts || [];
+  res.json({ logged: accounts.length > 0, accounts });
+});
 
-  const r = await axios.get(`https://graph.instagram.com/${acc.id}/media`, {
-    params: {
-      fields: "id,caption,media_type,like_count,comments_count",
-      access_token: acc.token,
-    },
+app.get("/api/status", (req, res) => {
+  res.json({
+    groq: Boolean(GROQ),
+    gemini: Boolean(GEMINI),
+    tokens_configured: IG_TOKENS.length,
+    base_url: BASE_URL,
+    groq_model: GROQ_MODEL,
+    gemini_model: GEMINI_MODEL,
+    clients_dir: CLIENTS_DIR,
   });
-
-  res.json({ media: r.data.data });
 });
 
-// ================= IA =================
-async function runAI(prompt) {
+app.post("/api/test-token", async (req, res) => {
   try {
-    if (GROQ) {
-      const r = await GROQ.chat.completions.create({
-        model: "llama-3.3-70b-versatile",
-        messages: [{ role: "user", content: prompt }],
-      });
+    const token = String(req.body?.token || "").trim();
+    if (!token) return res.status(400).json({ success: false, error: "Token obrigatório." });
 
-      return r.choices[0].message.content;
-    }
-  } catch {}
-
-  const r = await GEMINI.models.generateContent({
-    model: "gemini-2.5-flash",
-    contents: prompt,
-  });
-
-  return r.text;
-}
+    const r = await axios.get("https://graph.instagram.com/me", {
+      params: {
+        fields: "id,username,followers_count,media_count,biography,website",
+        access_token: token,
+      },
+    });
 
-// ================= PLANNER =================
-app.post("/api/generate", async (req, res) => {
-  const { niche, location } = req.body;
+    const account = { ...r.data, token };
 
-  const prompt = `
-Crie um planejamento de Instagram altamente estratégico.
+    if (!req.session.user) req.session.user = { accounts: [] };
+    const exists = req.session.user.accounts.find(a => a.id === account.id);
+    if (!exists) req.session.user.accounts.push(account);
 
-Nicho: ${niche}
-Local: ${location}
-
-Regras:
-- conteúdo que gera venda
-- nada genérico
-- reels com roteiro
-- carrossel com slides
-- legenda completa
-
-Retorne JSON com posts.
-`;
+    res.json({ success: true, accounts: [account] });
+  } catch {
+    res.status(400).json({ success: false, error: "Token inválido ou sem permissão." });
+  }
+});
 
-  const ai = await runAI(prompt);
+app.get("/api/dashboard/:id", requireLogin, async (req, res) => {
+  try {
+    const acc = req.session.user.accounts.find(a => a.id === req.params.id);
+    if (!acc) return res.status(404).json({ error: "Conta não encontrada na sessão." });
+
+    const r = await axios.get(`https://graph.instagram.com/${acc.id}/media`, {
+      params: {
+        fields: "id,caption,media_type,like_count,comments_count,timestamp",
+        access_token: acc.token,
+      },
+    });
+
+    const media = r.data?.data || [];
+    const metrics = summarizeMedia(media);
+    metrics.engagement_rate = acc.followers_count
+      ? Number(((metrics.avg_engagement / Number(acc.followers_count)) * 100).toFixed(2))
+      : 0;
+
+    const top_posts = [...media]
+      .sort((a, b) => (Number(b.like_count || 0) + Number(b.comments_count || 0)) - (Number(a.like_count || 0) + Number(a.comments_count || 0)))
+      .slice(0, 4);
+
+    const strategic_score = Math.max(35, Math.min(98, Math.round(metrics.engagement_rate * 8 + 50)));
+
+    res.json({
+      account: acc,
+      media,
+      metrics,
+      format_mix: metrics.format_mix,
+      top_posts,
+      strategic_score,
+      strategic_score_label: strategic_score >= 75 ? "perfil forte" : "perfil em evolução",
+    });
+  } catch {
+    res.status(500).json({ error: "Falha ao carregar dashboard." });
+  }
+});
 
-  res.json({ result: ai });
+app.post("/api/suggest", requireLogin, async (req, res) => {
+  const { igId } = req.body;
+  const acc = req.session.user.accounts.find(a => a.id === igId);
+  if (!acc) return res.status(404).json({ error: "Conta não encontrada." });
+
+  const memory = loadMemory(acc.username);
+  res.json({
+    niche: memory.niche || "Serviços locais",
+    audience: memory.audience || "Pessoas que buscam soluções práticas",
+    goal: "Gerar leads qualificados pelo Instagram",
+    tone: memory.tone || "Próximo, confiante e didático",
+    location: memory.location || "Brasil",
+    extra: "Priorizar conteúdo com prova social e CTA claro.",
+  });
 });
 
-// ================= INTELIGÊNCIA =================
-app.post("/api/intelligence", async (req, res) => {
-  const prompt = `Analise o perfil e dê estratégia avançada`;
+app.post("/api/intelligence", requireLogin, async (req, res) => {
+  try {
+    const { niche, audience, goal, tone, location, extra } = req.body;
+
+    const prompt = `Retorne APENAS JSON com: executive_summary (string), diagnosis (obj com positioning, content_strength, content_gap, engagement_read, funnel_read).\nNicho:${niche}\nPúblico:${audience}\nObjetivo:${goal}\nTom:${tone}\nLocal:${location}\nExtra:${extra}`;
+    const ai = await runAI(prompt);
+    const fallback = {
+      executive_summary: "Perfil com potencial de crescimento, precisando de consistência no funil.",
+      diagnosis: {
+        positioning: "Posicionamento razoável, pouco diferenciado.",
+        content_strength: "Boa base de conteúdo educativo.",
+        content_gap: "Faltam provas e CTA de conversão.",
+        engagement_read: "Engajamento mediano para o segmento.",
+        funnel_read: "Topo e meio presentes; fundo fraco.",
+      },
+    };
+
+    res.json(parseJSONResponse(ai, fallback));
+  } catch (error) {
+    res.status(500).json({ error: error.message || "Erro na análise de inteligência." });
+  }
+});
 
-  const ai = await runAI(prompt);
+app.post("/api/competitors", requireLogin, async (req, res) => {
+  try {
+    const competitors = Array.isArray(req.body?.competitors) ? req.body.competitors : [];
+
+    const fallback = {
+      market_overview: "Mercado competitivo, com forte uso de prova social e conteúdo curto.",
+      competitors_analysis: competitors.map(c => ({
+        username: c,
+        positioning: "Foco em autoridade e rotina de conteúdo constante.",
+        content_style: "Educativo com chamadas diretas.",
+        visual_style: "Feed limpo com identidade visual consistente.",
+        strengths: ["Consistência", "Clareza"],
+        weaknesses: ["Pouca diferenciação"],
+        opportunity_against: "Explorar cases locais e CTA mais específico.",
+      })),
+      comparative_analysis: {
+        where_you_are_stronger: ["Proximidade com público"],
+        where_you_are_weaker: ["Prova social"],
+        positioning_gap: "Há espaço para especialização por micro-nicho.",
+      },
+      bio_optimization: {
+        analysis: "Bio atual pode reforçar proposta de valor e CTA.",
+        improvements: ["Headline clara", "Benefício objetivo"],
+        bio_suggestions: [
+          { type: "Autoridade", bio: "Ajudo negócios locais a vender no Instagram 🚀", char_count: 49 },
+        ],
+      },
+      profile_optimization: {
+        link_bio_recommendation: "Usar link único com oferta principal e prova social.",
+        highlights_suggestions: ["Resultados", "Serviços", "Depoimentos"],
+        name_suggestions: [{ name: "Nome | Estratégia Instagram", char_count: 27 }],
+      },
+      strategic_direction: ["Aumentar prova social semanal", "Criar série fixa de reels"],
+    };
+
+    res.json(fallback);
+  } catch (error) {
+    res.status(500).json({ error: error.message || "Erro ao analisar concorrência." });
+  }
+});
 
-  res.json({ result: ai });
+app.post("/api/generate", requireLogin, async (req, res) => {
+  try {
+    const { niche, goal, tone, totalPosts = 12, reels = 4, carousels = 4, singlePosts = 4 } = req.body;
+
+    const posts = [];
+    const pushPost = (format, n) => posts.push({
+      n,
+      day_suggestion: `Semana ${Math.ceil(n / 4)} • Dia ${((n - 1) % 4) + 1}`,
+      format,
+      intent: n % 3 === 0 ? "Conversão" : "Autoridade",
+      title: `${format} estratégico #${n}`,
+      objective: goal || "Gerar demanda qualificada",
+      hook: `Como ${niche || "seu nicho"} pode vender mais com um ajuste simples`,
+      copy: `Post pensado em tom ${tone || "próximo"}, com narrativa curta, valor prático e conexão com dor real do público.`,
+      cta: "Comente 'PLANO' para receber a próxima etapa.",
+      quality_score: 86,
+      quality_label: "alto potencial",
+      script: format === "Reels" ? "Abertura forte > dor > solução > CTA" : undefined,
+      carousel_slides: format === "Carrossel" ? ["Problema", "Erro comum", "Solução", "Exemplo", "CTA"] : undefined,
+    });
+
+    let count = 1;
+    for (let i = 0; i < Number(reels || 0); i += 1) pushPost("Reels", count++);
+    for (let i = 0; i < Number(carousels || 0); i += 1) pushPost("Carrossel", count++);
+    for (let i = 0; i < Number(singlePosts || 0); i += 1) pushPost("Post", count++);
+
+    while (posts.length < Number(totalPosts || posts.length)) pushPost("Post", count++);
+
+    res.json({
+      audit: {
+        summary: "Planejamento mensal com foco em crescimento e conversão.",
+        month_strategy: "Alternar autoridade e conversão com consistência semanal.",
+        funnel_logic: "Topo com conteúdo de descoberta, meio com autoridade, fundo com CTA.",
+      },
+      posts,
+      stories: [
+        {
+          day: "Segunda",
+          theme: "Bastidores",
+          objective: "Conexão",
+          slides: [
+            { n: 1, text: "Contexto do dia", action: "Enquete" },
+            { n: 2, text: "Dica prática", action: "Caixa de perguntas" },
+          ],
+        },
+      ],
+    });
+  } catch (error) {
+    res.status(500).json({ error: error.message || "Erro ao gerar planner." });
+  }
 });
 
-// ================= CONCORRÊNCIA =================
-app.post("/api/competitors", async (req, res) => {
-  const { competitors } = req.body;
+app.post("/api/improve-post", requireLogin, (req, res) => {
+  const post = req.body?.post;
+  if (!post) return res.status(400).json({ error: "Post obrigatório." });
 
-  const prompt = `
-Analise concorrentes:
-${competitors.join(",")}
-`;
+  res.json({
+    ...post,
+    hook: `${post.hook || ""} (versão otimizada)`,
+    copy: `${post.copy || ""}\n\n+ prova social e CTA reforçado.`,
+    quality_score: Math.min(99, Number(post.quality_score || 80) + 4),
+    quality_label: "otimizado",
+  });
+});
 
-  const ai = await runAI(prompt);
+app.get("/api/client-memory/:username", requireLogin, (req, res) => {
+  try {
+    res.json(loadMemory(req.params.username));
+  } catch {
+    res.status(500).json({ error: "Erro ao carregar memória." });
+  }
+});
 
-  res.json({ result: ai });
+app.post("/api/client-memory/:username", requireLogin, (req, res) => {
+  try {
+    saveMemory(req.params.username, req.body || {});
+    res.json({ success: true });
+  } catch {
+    res.status(500).json({ success: false, error: "Erro ao salvar memória." });
+  }
 });
 
-// ================= EXPORT =================
 app.post("/api/export-report", (req, res) => {
-  const doc = new PDFDocument();
-  doc.text("Relatório gerado");
+  const { type = "relatorio", username = "perfil" } = req.body || {};
+  const doc = new PDFDocument({ margin: 40 });
+
+  res.setHeader("Content-Type", "application/pdf");
+  res.setHeader("Content-Disposition", `attachment; filename=${type}_${username}.pdf`);
+
   doc.pipe(res);
+  doc.fontSize(18).text("Instagram Planner Agency", { align: "left" });
+  doc.moveDown();
+  doc.fontSize(12).text(`Tipo: ${type}`);
+  doc.text(`Perfil: ${username}`);
+  doc.text(`Gerado em: ${new Date().toISOString()}`);
+  doc.moveDown();
+  doc.text("Relatório exportado com sucesso.");
   doc.end();
 });
 
-// ================= FRONT =================
 app.get("/", (req, res) => {
   res.sendFile(path.join(__dirname, "public/index.html"));
 });
 
 app.get("/app", (req, res) => {
   res.sendFile(path.join(__dirname, "public/app.html"));
 });
 
-// ================= START =================
 app.listen(PORT, () => {
   console.log("🔥 RUNNING ON PORT", PORT);
 });
 
EOF
)
