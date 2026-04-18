/**
 * AI Social Media Agent — inspirado em Shubhamsaboo/awesome-llm-apps
 * Geração automática de conteúdo, sugestões de posts e calendário editorial
 *
 * Uso:
 *   const agent = new AiSocialAgent({ apiKey: process.env.OPENAI_API_KEY });
 *   const posts = await agent.generateContentPlan({ niche: 'marketing digital', days: 7 });
 */

const { OpenAI } = require('openai');

class AiSocialAgent {
  constructor({ apiKey, model = 'gpt-4o-mini' } = {}) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  /**
   * Gera plano de conteúdo para Instagram
   * @param {Object} options - { niche, days, tone, objective }
   * @returns {Promise<Object>} calendário editorial com posts, legendas e hashtags
   */
  async generateContentPlan({ niche, days = 7, tone = 'profissional', objective = 'engajamento' }) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: `Você é um estrategista de conteúdo para Instagram especializado em ${niche}.
          Crie um calendário editorial completo com:
          - Tipo de post (reels, carrossel, estático, stories)
          - Legenda pronta para publicar
          - 10-15 hashtags relevantes
          - Melhor horário de publicação
          - CTA sugerido
          Responda em JSON com array "posts".`,
        },
        {
          role: 'user',
          content: `Nicho: ${niche}\nDias: ${days}\nTom: ${tone}\nObjetivo: ${objective}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Analisa métricas e sugere melhorias de conteúdo
   * @param {Array} postsMetrics - Métricas de posts anteriores
   * @returns {Promise<Object>} análise e recomendações
   */
  async analyzeAndImprove(postsMetrics) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'Você é um analista de redes sociais. Analise as métricas dos posts e identifique padrões de sucesso, formatos com melhor engajamento e recomende estratégias de melhoria. Responda em JSON.',
        },
        {
          role: 'user',
          content: `Métricas:\n${JSON.stringify(postsMetrics, null, 2)}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Gera legendas otimizadas para um post
   * @param {Object} options - { topic, imageDescription, tone, cta }
   * @returns {Promise<Object>} variações de legenda
   */
  async generateCaptions({ topic, imageDescription, tone = 'engajador', cta }) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'Você é um copywriter especialista em Instagram. Gere 3 variações de legenda para o post, cada uma com um ângulo diferente (emocional, educativo, provocativo). Inclua hashtags e CTA. Responda em JSON com array "captions".',
        },
        {
          role: 'user',
          content: `Tópico: ${topic}\nDescrição da imagem: ${imageDescription}\nTom: ${tone}\nCTA desejado: ${cta}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Sugere melhores horários de publicação baseado no histórico
   * @param {Array} engagementHistory - Histórico de engajamento por horário
   * @returns {Promise<Object>} horários recomendados por dia da semana
   */
  async suggestBestTimes(engagementHistory) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'Analise o histórico de engajamento e identifique os melhores dias e horários para publicar. Responda em JSON com "bestTimes" por dia da semana.',
        },
        {
          role: 'user',
          content: `Histórico:\n${JSON.stringify(engagementHistory, null, 2)}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    return JSON.parse(response.choices[0].message.content);
  }
}

module.exports = { AiSocialAgent };
