function score(post) {
  let s = 10;

  if (!post.caption || post.caption.length < 100) s -= 3;
  if (post.caption.includes("dica")) s -= 2;
  if (post.caption.includes("manutenção")) s -= 2;

  return s;
}

function filter(posts) {
  return posts.filter(p => score(p) >= 5);
}

module.exports = { filter };
