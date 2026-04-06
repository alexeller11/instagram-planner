require("dotenv").config();

const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: "planner-secret",
  resave: false,
  saveUninitialized: true
}));

// ================= LOGIN =================
app.post("/api/auth", (req,res)=>{
  req.session.logged=true;
  res.json({success:true});
});

// ================= STATUS =================
app.get("/api/status",(req,res)=>{
  res.json({ok:true});
});

// ================= CONCORRENCIA =================

async function analisarConcorrente({ username, nicho, cidade }) {

  const prompt = `
Você é um estrategista de marketing nível agência.

Analise @${username}

Se não houver dados públicos:
ASSUMA comportamento padrão de empresas de ${nicho} em ${cidade}

Gere:

1. Score (0-100)
2. Diagnóstico direto
3. Posicionamento provável
4. Estilo de conteúdo
5. Estilo visual
6. O que funciona
7. Fraquezas
8. Oportunidades
9. Como bater esse concorrente

NÃO seja genérico.
`;

  const response = await gemini.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt
  });

  return {
    username,
    analise: response.text
  };
}

app.post("/api/competitors", async (req,res)=>{

  const { competitors, niche, location } = req.body;

  const results = [];

  for(const c of competitors){
    const data = await analisarConcorrente({
      username:c,
      nicho:niche,
      cidade:location
    });
    results.push(data);
  }

  res.json({competitors_analysis:results});
});

// ================= EXPORT PDF =================

app.post("/api/export", async (req,res)=>{
  const PDFDocument = require("pdfkit");

  const doc = new PDFDocument();
  res.setHeader('Content-Type','application/pdf');

  doc.pipe(res);

  doc.fontSize(18).text("Relatório", {align:"center"});

  req.body.data.forEach(c=>{
    doc.moveDown();
    doc.fontSize(14).text(c.username);
    doc.fontSize(10).text(c.analise);
  });

  doc.end();
});

// ================= ROTAS =================
app.get("/",(req,res)=>{
  res.sendFile(path.join(__dirname,"public/index.html"));
});

app.get("/app",(req,res)=>{
  if(!req.session.logged) return res.redirect("/");
  res.sendFile(path.join(__dirname,"public/app.html"));
});

app.listen(PORT,()=>console.log("🔥 RUNNING",PORT));
