const axios = require("axios");

async function getInstagramInsights(username) {
  try {
    const url = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
    const res = await axios.get(url);

    const posts = res.data.graphql.user.edge_owner_to_timeline_media.edges;

    return posts.slice(0, 10).map(p => {
      const node = p.node;
      return {
        caption: node.edge_media_to_caption.edges[0]?.node?.text || "",
        score: node.edge_liked_by.count + node.edge_media_to_comment.count
      };
    });

  } catch {
    return [];
  }
}

function extractPatterns(posts) {
  return posts
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(p => p.caption.slice(0, 100));
}

module.exports = { getInstagramInsights, extractPatterns };
