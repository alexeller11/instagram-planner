# 🤖 AI Social Media Agent — Instagram Planner

Integração com o projeto [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) adaptada para planejamento inteligente de conteúdo no Instagram.

## O que faz

- **`generateContentPlan()`** — Gera calendário editorial completo com tipo de post, legenda, hashtags, horário e CTA
- **`analyzeAndImprove()`** — Analisa métricas de posts anteriores e recomenda melhorias de estratégia
- **`generateCaptions()`** — Gera 3 variações de legenda (emocional, educativa, provocativa) para qualquer post
- **`suggestBestTimes()`** — Identifica os melhores horários de publicação por dia da semana

## Configuração

```bash
npm install openai
```

Adicione no `.env`:
```
OPENAI_API_KEY=sk-...
```

## Uso

```js
const { AiSocialAgent } = require('./ai/ai_social_agent');

const agent = new AiSocialAgent({ apiKey: process.env.OPENAI_API_KEY });

// Gerar plano de 7 dias
const plan = await agent.generateContentPlan({
  niche: 'marketing digital',
  days: 7,
  tone: 'profissional',
  objective: 'engajamento'
});

// Gerar legendas para um post
const captions = await agent.generateCaptions({
  topic: 'Dicas de tráfego pago',
  imageDescription: 'Gráfico de ROI crescente',
  tone: 'educativo',
  cta: 'Salve esse post!'
});
```

## Referência

Inspirado no **AI Social Media News and Podcast Agent** do repositório [Shubhamsaboo/awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) — #1 GitHub Trending.
