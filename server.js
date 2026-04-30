require("dotenv").config();
const express = require("express");
const path = require("path");

const { buildClients } = require("./ai/engine");
const { dashboard360, diagnostico, planoMensal, concorrencia } = require("./ai/pipeline");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const accounts = [
  { id:"1", username:"qualitycar_autocenter", niche:"oficina mecânica" },
  { id:"2", username:"bortotclinicadeolhos", niche:"clínica oftalmológica" }
];

const aiClients = buildClients(process.env);

app.get("/api/me",(req,res)=>{
  res.json({ logged:true, accounts });
});

function acc(id){
  return accounts.find(a=>a.id==id) || accounts[0];
}

app.post("/api/dashboard", async (req,res)=>{
  const a = acc(req.body.igId);
  res.json(await dashboard360({ clients:aiClients, niche:a.niche, username:a.username }));
});

app.post("/api/diagnostico", async (req,res)=>{
  const a = acc(req.body.igId);
  res.json(await diagnostico({ clients:aiClients, niche:a.niche }));
});

app.post("/api/plano", async (req,res)=>{
  const a = acc(req.body.igId);
  res.json(await planoMensal({
    clients:aiClients,
    niche:a.niche,
    username:a.username,
    goal:req.body.goal
  }));
});

app.post("/api/concorrencia", async (req,res)=>{
  const a = acc(req.body.igId);
  res.json(await concorrencia({
    clients:aiClients,
    niche:a.niche,
    city:req.body.city || "Brasil"
  }));
});

app.listen(PORT, ()=>console.log("🚀 Rodando"));
