function isGeneric(text) {
  const banned = [
    "troca de óleo",
    "faça manutenção",
    "dica importante",
    "você sabia"
  ];

  return banned.some(b => text.toLowerCase().includes(b));
}

function scorePost(post) {
  let score = 10;

  if (isGeneric(post.caption)) score -= 5;
  if (!post.caption || post.caption.length < 80) score -= 3;
  if (!post.theme) score -= 2;

  return score;
}

function filterQuality(posts) {
  return posts.filter(p => scorePost(p) >= 5);
}

module.exports = { filterQuality };
