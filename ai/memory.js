function filterRepetitions(posts, memory) {
  const history = memory.last_themes || [];

  return posts.filter(p => {
    const theme = p.theme?.toLowerCase() || "";
    return !history.some(h => theme.includes(h));
  });
}

function updateMemory(memory, posts) {
  const themes = posts.map(p => p.theme?.toLowerCase());

  memory.last_themes = [
    ...(memory.last_themes || []),
    ...themes
  ].slice(-30);

  return memory;
}

module.exports = { filterRepetitions, updateMemory };
