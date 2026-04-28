const axios = require("axios");

async function getInstagramInsights(username) {
  try {
    // Simples scraping público (você pode evoluir depois)
    const url = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
    const res = await axios.get(url);

    const posts = res.data.graphql.user.edge_owner_to_timeline_media.edges;

    const insights = posts.slice(0, 10).map(p => {
      const node = p.node;

      return {
        caption: node.edge_media_to_caption.edges[0]?.node?.text || "",
        likes: node.edge_liked_by.count,
        comments: node.edge_media_to_comment.count
      };
    });

    return insights;

  } catch (err) {
    return [];
  }
}

function extractPatterns(posts) {
  const sorted = posts.sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments));

  const top = sorted.slice(0, 5);

  return top.map(p => ({
    hook: p.caption.slice(0, 100),
    score: p.likes + p.comments
  }));
}

module.exports = {
  getInstagramInsights,
  extractPatterns
};
