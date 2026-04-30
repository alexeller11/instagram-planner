const { runLLM } = require("./engine");

function safeArray(x){
  return Array.isArray(x) ? x : [];
}

async function ask(clients, prompt){
  return await runLLM({
    clients,
    system: "Responda apenas JSON válido.",
    user: prompt
  });
}

// ================= DASHBOARD =================
async function dashboard360({ clients, niche, username }){

  const prompt = `
Cliente: ${username}
Nicho: ${niche}

Crie:
- 3 bios premium
- 6 melhorias reais
- 1 posicionamento forte

JSON:
{
 "bio":[],
 "melhorias":[],
 "posicionamento":""
}
`;

  const d = await ask(clients, prompt);

  return {
    bio: safeArray(d?.bio),
    melhorias: safeArray(d?.melhorias),
    posicionamento: d?.posicionamento || ""
  };
}

// ================= DIAGNOSTICO =================
async function diagnostico({ clients, niche }){

  const prompt = `
Analise um Instagram de ${niche}

Crie:
- problemas
- oportunidades
- ações práticas

JSON:
{
 "problemas":[],
 "oportunidades":[],
 "acoes_14_dias":[]
}
`;

  const d = await ask(clients, prompt);

  return {
    problemas: safeArray(d?.problemas),
    oportunidades: safeArray(d?.oportunidades),
    acoes_14_dias: safeArray(d?.acoes_14_dias)
  };
}

// ================= PLANO =================
async function planoMensal({ clients, niche, username, goal }){

  const prompt = `
Cliente: ${username}
Nicho: ${niche}
Objetivo: ${goal}

Crie 20 posts estratégicos.

JSON:
{
 "posts":[
  {
   "theme":"",
   "format":"",
   "hook":"",
   "script_or_slides":[],
   "caption":"",
   "creative_direction":"",
   "goal":""
  }
 ]
}
`;

  const d = await ask(clients, prompt);

  let posts = safeArray(d?.posts);

  if(posts.length === 0){
    posts = Array.from({length:10}).map((_,i)=>({
      theme:`Post ${i+1}`,
      format:"Reels",
      hook:"Gancho direto",
      script_or_slides:["Abertura","Conteúdo","CTA"],
      caption:"Fallback",
      creative_direction:"Vídeo simples",
      goal:goal
    }));
  }

  return { posts };
}

// ================= CONCORRENCIA =================
async function concorrencia({ clients, niche, city }){

  const prompt = `
Analise concorrência de ${niche} em ${city}

JSON:
{
 "concorrentes":[{"nome":"","perfil":""}],
 "plano_para_ganhar":[]
}
`;

  const d = await ask(clients, prompt);

  return {
    concorrentes: safeArray(d?.concorrentes),
    plano_para_ganhar: safeArray(d?.plano_para_ganhar)
  };
}

module.exports = {
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
};
