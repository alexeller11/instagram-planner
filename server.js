// 🔥 SERVER 5.3 - FOCO EM CONTEÚDO QUE VENDE

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const PDFDocument = require("pdfkit");
const Groq = require("groq-sdk");

const app = express();

const PORT = process.env.PORT || 3000;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: "planner-secret",
  resave: false,
  saveUninitialized: true
}));

// =============================
// 🧠 PROMPT SUPER EVOLUÍDO
// =============================
function plannerSystemPrompt() {
  return `
Você é um estrategista de marketing nível agência premium.

Você NÃO escreve conteúdo genérico.
Você NÃO escreve frases vazias.
Você NÃO escreve como IA.

Você cria conteúdo que:
- prende atenção
- ensina
- gera autoridade
- gera desejo
- move para ação

❌ PROIBIDO:
- "você sabia"
- "entenda"
- "nossa equipe"
- "podemos ajudar"
- "veja como"
- frases vagas

✅ OBRIGATÓRIO:
- legenda precisa ENSINAR ou CONVENCER
- reels precisam ter CENA + FALA + PROGRESSÃO
- carrossel precisa ter sequência lógica
- cada post precisa parecer útil sozinho

ESTRUTURA:

POST EXPLICATIVO:
- explica de verdade (sem enrolação)

POST DE ERRO:
- mostra erro + consequência real

POST DE VENDA:
- direto + concreto

REELS:
- abertura forte
- desenvolvimento
- fechamento

CARROSSEL:
- progressão de ideia
- não repetir frase com palavra diferente

SE A RESPOSTA ESTIVER FRACA:
REFAÇA mentalmente antes de responder.

RETORNE JSON PERFEITO.
`;
}

// =============================
// 🚀 GERAÇÃO 5.3
// =============================
app.post("/api/generate", async (req, res) => {
  const { niche, audience, goal, location } = req.body;

  const prompt = `
Crie um planner de alto nível.

Contexto:
Nicho: ${niche}
Público: ${audience}
Objetivo: ${goal}
Localização: ${location}

QUERO:
- conteúdo que venderia de verdade
- nada genérico

RETORNO:

{
  "posts":[
    {
      "format":"Reels",
      "title":"",
      "hook":"",
      "copy":"",
      "cta":"",
      "script":""
    }
  ]
}
`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.9,
      messages: [
        { role: "system", content: plannerSystemPrompt() },
        { role: "user", content: prompt }
      ]
    });

    const text = completion.choices[0].message.content;

    const json = JSON.parse(text.replace(/```json|```/g, ""));

    res.json(json);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================
// 📄 PDF PREMIUM
// =============================
app.post("/api/export-pdf", (req, res) => {

  const { plan } = req.body;

  const doc = new PDFDocument({ margin: 40 });

  res.setHeader("Content-Type", "application/pdf");

  doc.pipe(res);

  doc.fontSize(20).text("PLANO ESTRATÉGICO", { align: "center" });
  doc.moveDown();

  plan.posts.forEach((p, i) => {
    doc.fontSize(14).text(`#${i + 1} - ${p.title}`);
    doc.moveDown(0.3);

    doc.fontSize(10).text(`GANCHO:\n${p.hook}`);
    doc.moveDown(0.2);

    doc.text(`LEGENDA:\n${p.copy}`);
    doc.moveDown(0.2);

    if (p.script) {
      doc.text(`ROTEIRO:\n${p.script}`);
      doc.moveDown(0.2);
    }

    doc.text(`CTA:\n${p.cta}`);
    doc.moveDown(1);
  });

  doc.end();
});

app.listen(PORT, () => {
  console.log("🔥 5.3 rodando");
});
