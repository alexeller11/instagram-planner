function filterRepetitions(posts, memory) {
  const history = memory.last_themes || [];

  return posts.filter(p => {
    const t = (p.theme || "").toLowerCase();
    return !history.some(h => t.includes(h));
  });
}

function updateMemory(memory, posts) {
  const themes = posts.map(p => (p.theme || "").toLowerCase());

  memory.last_themes = [
    ...(memory.last_themes || []),
    ...themes
  ].slice(-50);

  return memory;
}

module.exports = { filterRepetitions, updateMemory };
