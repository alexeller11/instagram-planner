function decideStrategy(insights) {
  if (!insights.length) {
    return { reels: 4, carrossel: 3, estatico: 2 };
  }

  const avg = insights.reduce((a, b) => a + b.score, 0) / insights.length;

  if (avg > 10000) return { reels: 5, carrossel: 2, estatico: 1 };
  if (avg > 5000)  return { reels: 4, carrossel: 3, estatico: 1 };

  return { reels: 3, carrossel: 3, estatico: 2 };
}

// Gera 2 variações por slot (A/B)
function planSlots(strategy) {
  const slots = [];
  const push = (format, n) => {
    for (let i = 0; i < n; i++) {
      slots.push({ format, variants: 2 });
    }
  };
  push("reels", strategy.reels);
  push("carrossel", strategy.carrossel);
  push("estatico", strategy.estatico);
  return slots;
}

module.exports = { decideStrategy, planSlots };
