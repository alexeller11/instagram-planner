function extractThemes(posts) {
  return posts.map(p => p.theme?.toLowerCase()).filter(Boolean);
}

function isSimilar(a, b) {
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function filterRepetitions(newPosts, memory) {
  const history = memory.last_themes || [];

  return newPosts.filter(post => {
    const theme = post.theme?.toLowerCase();

    const repeated = history.some(h => isSimilar(h, theme));
    return !repeated;
  });
}

function updateMemory(memory, posts) {
  const themes = extractThemes(posts);

  memory.last_themes = [
    ...(memory.last_themes || []),
    ...themes
  ].slice(-30); // guarda últimos 30

  return memory;
}

module.exports = {
  filterRepetitions,
  updateMemory
};
