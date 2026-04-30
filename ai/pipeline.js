// ai/pipeline.js

function generateFakePosts(niche){

  const base = [
    "Erro comum que custa caro",
    "O que ninguém te conta",
    "3 erros que você comete",
    "Antes de fazer isso, veja isso",
    "Isso pode estar te fazendo perder dinheiro",
    "O jeito certo de fazer isso",
    "Você está fazendo isso errado",
    "Como evitar prejuízo",
    "O detalhe que faz diferença",
    "O que muda tudo"
  ];

  const formats = ["Reels","Carrossel","Estático"];

  return Array.from({length:30}).map((_,i)=>({
    n:i+1,
    theme:`${base[i%base.length]} (${niche})`,
    format:formats[i%3],
    caption:`Conteúdo direto sobre ${niche}. Aplicável, real e sem enrolação.`,
    script_or_slides:[
      "Gancho direto",
      "Explicação simples",
      "Chamada para ação"
    ],
    visual_audio_direction:"Vídeo simples",
    strategic_logic:"Conteúdo base validado"
  }));
}

async function generatePlan30({ niche }) {
  return { posts: generateFakePosts(niche) };
}

module.exports = { generatePlan30 };
