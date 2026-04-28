const axios = require("axios");

async function getProfileData(username) {
  try {
    const res = await axios.get(`https://www.instagram.com/${username}/?__a=1&__d=dis`);
    const edges = res.data.graphql.user.edge_owner_to_timeline_media.edges;

    return edges.slice(0, 12).map(e => {
      const n = e.node;
      return {
        caption: n.edge_media_to_caption.edges[0]?.node?.text || "",
        score: (n.edge_liked_by.count || 0) + (n.edge_media_to_comment.count || 0)
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
    .map(p => p.caption.slice(0, 140));
}

module.exports = { getProfileData, extractPatterns };
