function decideStrategy(insights) {
  if (!insights.length) {
    return {
      reels: 3,
      carrossel: 3,
      estatico: 2
    };
  }

  const avgScore = insights.reduce((a, b) => a + b.score, 0) / insights.length;

  if (avgScore > 10000) {
    return { reels: 5, carrossel: 2, estatico: 1 };
  }

  return { reels: 3, carrossel: 3, estatico: 2 };
}

module.exports = { decideStrategy };
