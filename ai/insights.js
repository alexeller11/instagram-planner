const axios = require("axios");

async function getProfilePosts(username) {
  try {
    const res = await axios.get(`https://www.instagram.com/${username}/?__a=1&__d=dis`);
    const edges = res.data.graphql.user.edge_owner_to_timeline_media.edges;

    return edges.slice(0, 12).map(e => {
      const node = e.node;
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
    .map(p => p.caption.slice(0, 120));
}

module.exports = { getProfilePosts, extractPatterns };
