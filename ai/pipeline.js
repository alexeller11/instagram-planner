const { runLLM } = require("./engine");

// ===== HELPERS =====
function safeArray(x){
  return Array.isArray(x) ? x : [];
}

function cleanText(x){
  if(!x) return "";
  if(typeof x === "string") return x;
  if(typeof x === "object") return Object.values(x).join(" ");
  return String(x);
}

async function ask(clients, prompt){
  return await runLLM({
    clients,
    // mantemos a exigência de JSON, mas deixamos o estilo para o prompt do usuário
    system: "Responda apenas JSON válido. Sem texto fora do JSON.",
    user: prompt
  });
}

// ===== DASHBOARD =====
async function dashboard360({ clients, niche, username }){

  const prompt = `
Você é um estrategista sênior de social media no Brasil.
Fale como um humano, direto, sem jargões exagerados e sem parecer IA.
Use linguagem natural, como se estivesse escrevendo para o dono do negócio.

Cliente: ${username}
Nicho: ${niche}

Tarefas:

1) Crie exatamente 3 bios premium para Instagram.
   - Em português brasileiro.
   - Cada bio com no máximo 150 caracteres (incluindo espaços).
   - Use no máximo 3 emojis por bio.
   - Misture posicionamento + prova social + CTA curto.
   - Evite frases clichê como “Bem-vindo ao meu perfil”, “Aqui você encontra”.

2) Liste 6 melhorias reais para o perfil:
   - Sempre em frases curtas e diretas.
   - Foque em coisas acionáveis (ex.: "Padronizar capa dos destaques com ícones simples").

3) Escreva 1 frase de posicionamento forte:
   - Em primeira pessoa ou em voz da marca.
   - Deixe claro público, promessa e diferença.

Responda SOMENTE neste JSON:

{
 "bio": [
   "string",
   "string",
   "string"
 ],
 "melhorias": [
   "string",
   "string"
 ],
 "posicionamento": "string"
}
`;

  const d = await ask(clients, prompt);

  return {
    bio: safeArray(d?.bio).map(cleanText),
    melhorias: safeArray(d?.melhorias).map(cleanText),
    posicionamento: cleanText(d?.posicionamento)
  };
}

// ===== DIAGNÓSTICO =====
async function diagnostico({ clients, niche }){

  const prompt = `
Você é um estrategista de social media que fala como humano.
Explique os problemas e oportunidades como se estivesse conversando com o cliente,
com exemplos concretos e sem linguagem de relatório.

Contexto do perfil: Instagram de ${niche}.

Tarefas:

1) "problemas":
   - Liste de 4 a 7 problemas.
   - Cada item como uma frase curta, bem direta, exemplo:
     "O feed está visualmente bagunçado, isso passa a sensação de amadorismo."
   - Evite frases genéricas tipo "falta de engajamento". Sempre traga o porquê.

2) "oportunidades":
   - Liste de 4 a 7 oportunidades de crescimento.
   - Traga ideias específicas, ex.:
     "Transformar dúvidas frequentes da recepção em vídeos rápidos de Reels."

3) "acoes_14_dias":
   - Liste de 7 a 10 ações muito práticas para os próximos 14 dias.
   - Cada ação começa com verbo no imperativo (Ex.: "Padronize as capas dos destaques...").

Responda SOMENTE neste JSON:

{
 "problemas": [
   "string"
 ],
 "oportunidades": [
   "string"
 ],
 "acoes_14_dias": [
   "string"
 ]
}
`;

  const d = await ask(clients, prompt);

  return {
    problemas: safeArray(d?.problemas).map(cleanText),
    oportunidades: safeArray(d?.oportunidades).map(cleanText),
    acoes_14_dias: safeArray(d?.acoes_14_dias).map(cleanText)
  };
}

// ===== PLANO =====
async function planoMensal({ clients, niche, username, goal }){

  const prompt = `
Você é um diretor de criação de social media no Brasil.
Monte um plano de conteúdo humano, variado e pé-no-chão para Instagram.

Cliente: ${username}
Nicho: ${niche}
Objetivo principal: ${goal}

Estilo:
- Linguagem coloquial, mas profissional.
- Nada de frases genéricas tipo "No mundo de hoje" ou "Em 2024".
- Legendas com storytelling curto, trazendo contexto do dia a dia do negócio.
- Sempre terminar a legenda com um CTA claro e específico (ex.: "Comenta 'SIM' se você quer ver mais bastidores assim.").

Crie EXATAMENTE 20 posts estratégicos com:

- "theme": tema resumido do post (não é título de clickbait, é o assunto).
- "format": um destes valores: "Reels", "Carrossel" ou "Foto".
  Misture os formatos ao longo dos 20 posts.
- "hook": frase de abertura forte, para os 2 primeiros segundos.
- "script_or_slides":
  - Para Reels: roteiro com 3 a 6 bullets, cada uma descrevendo o que aparece na cena.
  - Para Carrossel: 4 a 7 bullets, cada uma representando um slide.
  - Para Foto: 2 a 3 bullets com o que a foto deve mostrar e o contexto.
- "caption": legenda final, escrita em tom humano:
  - 2 a 6 frases curtas.
  - Pode usar emojis, mas no máximo 4 por legenda.
  - Traga detalhes concretos do nicho (situações reais que o cliente vive).
  - Terminar sempre com um CTA claro (comentário, salvar, direct, clique no link).

- "creative_direction": instrução visual pro designer/videomaker.
- "goal": objetivo específico daquele post (ex.: "gerar prova social", "atrair novos seguidores de Linhares").

Responda SOMENTE neste JSON:

{
 "posts":[
  {
   "theme":"string",
   "format":"Reels" | "Carrossel" | "Foto",
   "hook":"string",
   "script_or_slides":[ "string" ],
   "caption":"string",
   "creative_direction":"string",
   "goal":"string"
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
      hook:"Gancho direto e simples para chamar atenção.",
      script_or_slides:["Cena 1: Abertura rápida","Cena 2: Conteúdo principal","Cena 3: CTA olhando para a câmera"],
      caption:"Legenda de fallback gerada automaticamente para não ficar vazio.",
      creative_direction:"Vídeo simples gravado com celular na vertical.",
      goal:goal
    }));
  }

  posts = posts.map((p, idx) => ({
    theme: cleanText(p.theme || `Post ${idx+1}`),
    format: cleanText(p.format || "Reels"),
    hook: cleanText(p.hook),
    caption: cleanText(p.caption),
    creative_direction: cleanText(p.creative_direction),
    goal: cleanText(p.goal || goal),
    script_or_slides: safeArray(p.script_or_slides).map(cleanText)
  }));

  return { posts };
}

// ===== CONCORRÊNCIA =====
async function concorrencia({ clients, niche, city }){

  const prompt = `
Você é um estrategista analisando a concorrência de ${niche} em ${city}.
Explique de forma humana, como se estivesse resumindo para o dono do negócio.

Tarefas:

1) "concorrentes":
   - Liste de 3 a 6 concorrentes fictícios, mas plausíveis.
   - "nome": nome fantasia.
   - "perfil": @perfil do Instagram.

2) "plano_para_ganhar":
   - Liste de 5 a 10 ações estratégicas bem diretas para superar a concorrência.
   - Cada item deve parecer conselho prático que você daria em uma call:
     exemplo: "Comece a postar 2 Reels por semana mostrando bastidores da oficina, com o mecânico explicando o problema do carro em linguagem simples."

Responda SOMENTE neste JSON:

{
 "concorrentes":[
   { "nome":"string","perfil":"string" }
 ],
 "plano_para_ganhar":[
   "string"
 ]
}
`;

  const d = await ask(clients, prompt);

  return {
    concorrentes: safeArray(d?.concorrentes).map(c => ({
      nome: cleanText(c.nome),
      perfil: cleanText(c.perfil)
    })),
    plano_para_ganhar: safeArray(d?.plano_para_ganhar).map(cleanText)
  };
}

module.exports = {
  dashboard360,
  diagnostico,
  planoMensal,
  concorrencia
};
