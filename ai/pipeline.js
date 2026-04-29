const { runLLM } = require("./engine");

async function generate({ clients, niche, memory }) {

  const prompt = `
Você é um estrategista de conteúdo que cria posts que PRENDEM atenção.

NICHO:
${niche}

OBJETIVO:
Criar conteúdo que:
- faça a pessoa parar de rolar
- gere curiosidade
- cause identificação
- pareça uma história real

REGRAS IMPORTANTES:
- NÃO use frases genéricas (tipo "você sabia", "descubra", "dicas")
- NÃO escreva como empresa
- escreva como alguém contando algo real
- use situações específicas
- use problemas reais do dia a dia do cliente

ESTILO:
- direto
- humano
- com tensão (problema → consequência)
- linguagem simples

Crie 6 posts.

FORMATOS:
- reels → impacto e história rápida
- carrossel → explicação com curiosidade
- estatico → posicionamento forte ou opinião

Evite repetir:
${memory}

EXEMPLOS DO NÍVEL ESPERADO:

Oficina:
- "Ele achou que era só um barulho… até o carro parar no meio da estrada"

Clínica:
- "Tem gente que descobre problema na visão tarde demais — e nem percebeu os sinais"

Loja:
- "Ela não comprava roupa há meses… até entender o que realmente valorizava o corpo dela"

RETORNE APENAS JSON:
{
  "posts": [
    {
      "theme": "...",
      "caption": "...",
      "format": "reels"
    }
  ]
}
`;

  const result = await runLLM({
    clients,
    system: "Você responde apenas JSON puro.",
    user: prompt
  });

  return result || { posts: [] };
}

module.exports = { generate };
