function updateMemory(memory, posts) {
  const themes = (posts || [])
    .map((p) => (p?.theme || "").toLowerCase().trim())
    .filter(Boolean);

  memory.last = [...(memory.last || []), ...themes].slice(-80);
  return memory;
}

function avoidRepetition(posts, memory) {
  const last = new Set((memory?.last || []).map((t) => String(t)));
  return (posts || []).filter((p) => !last.has((p?.theme || "").toLowerCase().trim()));
}

module.exports = { updateMemory, avoidRepetition };
