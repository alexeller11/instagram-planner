function updateMemory(memory, posts) {
  const themes = posts.map(p => (p.theme || "").toLowerCase());
  memory.last = [...(memory.last || []), ...themes].slice(-50);
  return memory;
}

function avoidRepetition(posts, memory) {
  const last = memory.last || [];
  return posts.filter(p => !last.includes((p.theme || "").toLowerCase()));
}

module.exports = { updateMemory, avoidRepetition };
