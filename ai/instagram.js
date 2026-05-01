const axios = require("axios");

/**
 * Busca informações do usuário e suas contas vinculadas do Instagram
 * @param {string} token - Token de acesso do usuário (User Access Token)
 */
async function fetchInstagramAccount(token) {
  try {
    // 1. Pegar o ID do usuário do Facebook e suas páginas
    const meRes = await axios.get(`https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`);
    const pages = meRes.data?.data || [];
    
    if (pages.length === 0) return null;

    // 2. Para cada página, procurar o ID da conta do Instagram vinculada
    for (const page of pages) {
      const igRes = await axios.get(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${token}`);
      const igId = igRes.data?.instagram_business_account?.id;
      
      if (igId) {
        // 3. Pegar detalhes do perfil do Instagram
        const profileRes = await axios.get(`https://graph.facebook.com/v19.0/${igId}?fields=username,name,biography,profile_picture_url,followers_count&access_token=${token}`);
        const profile = profileRes.data;

        return {
          id: igId,
          username: profile.username,
          brandName: profile.name || profile.username,
          biography: profile.biography || "",
          profile_picture: profile.profile_picture_url,
          followers: profile.followers_count,
          token: token // Guardamos o token para chamadas futuras se necessário
        };
      }
    }
    return null;
  } catch (error) {
    console.error("Erro ao buscar conta do Instagram:", error.response?.data || error.message);
    return null;
  }
}

/**
 * Busca métricas reais da conta do Instagram
 */
async function fetchInstagramMetrics(igId, token) {
  try {
    // Busca métricas básicas de insights (exemplo simplificado)
    const metricsRes = await axios.get(`https://graph.facebook.com/v19.0/${igId}/insights?metric=impressions,reach,profile_views&period=day&access_token=${token}`);
    return metricsRes.data?.data || [];
  } catch (error) {
    console.error(`Erro ao buscar métricas para ${igId}:`, error.response?.data || error.message);
    return [];
  }
}

module.exports = {
  fetchInstagramAccount,
  fetchInstagramMetrics
};
