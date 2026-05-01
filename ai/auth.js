const axios = require('axios');

/**
 * Gera a URL de login do Facebook
 */
function getFacebookLoginUrl(appId, redirectUri, state) {
  const scope = [
    'instagram_basic',
    'pages_read_engagement',
    'pages_read_user_content'
  ].join(',');

  return `https://www.facebook.com/v19.0/dialog/oauth?` +
    `client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${state}` +
    `&response_type=code`;
}

/**
 * Troca o código de autorização por um token de acesso
 */
async function getAccessToken(code, appId, appSecret, redirectUri) {
  try {
    const res = await axios.post(
      'https://graph.facebook.com/v19.0/oauth/access_token',
      {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code: code
      }
    );

    return res.data.access_token;
  } catch (error) {
    console.error('Erro ao obter token de acesso:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Busca as contas do Instagram Business vinculadas ao usuário
 */
async function getInstagramAccounts(accessToken) {
  try {
    // 1. Obter informações do usuário
    const meRes = await axios.get(
      `https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${accessToken}`
    );

    // 2. Obter páginas do Facebook
    const pagesRes = await axios.get(
      `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account&access_token=${accessToken}`
    );

    const pages = pagesRes.data?.data || [];
    const accounts = [];

    // 3. Para cada página, buscar a conta do Instagram Business
    for (const page of pages) {
      try {
        const igId = page.instagram_business_account?.id;

        if (igId) {
          const profileRes = await axios.get(
            `https://graph.facebook.com/v19.0/${igId}?fields=username,name,biography,profile_picture_url,followers_count&access_token=${accessToken}`
          );

          const profile = profileRes.data;

          accounts.push({
            id: igId,
            username: profile.username,
            brandName: profile.name || profile.username,
            biography: profile.biography || '',
            profile_picture: profile.profile_picture_url,
            followers: profile.followers_count,
            facebookPageId: page.id,
            token: accessToken,
            // Campos padrão para compatibilidade
            niche: 'Nicho a definir',
            targetAudience: 'Público a definir',
            audiencePainPoints: [],
            brandTone: 'Profissional',
            offer: 'Serviços',
            city: 'Brasil',
            contentPillars: ['Educação', 'Bastidores']
          });

          console.log(`✅ Conta carregada: @${profile.username}`);
        }
      } catch (pageError) {
        console.log(`⚠️ Página sem Instagram Business: ${page.name}`);
      }
    }

    return accounts;
  } catch (error) {
    console.error('Erro ao buscar contas do Instagram:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Valida e renova um token de acesso se necessário
 */
async function validateToken(accessToken, appId, appSecret) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v19.0/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`
    );

    const data = res.data?.data;

    if (!data?.is_valid) {
      throw new Error('Token inválido ou expirado');
    }

    return {
      valid: true,
      expiresAt: data.expires_at,
      scopes: data.scopes || []
    };
  } catch (error) {
    console.error('Erro ao validar token:', error.message);
    return { valid: false };
  }
}

module.exports = {
  getFacebookLoginUrl,
  getAccessToken,
  getInstagramAccounts,
  validateToken
};
