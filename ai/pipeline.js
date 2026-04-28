const { runLLM } = require("./engine");

async function generateBatch({
  clients,
  system,
  slots,
  patterns,
  memory
}) {
  const totalVariants = slots.reduce((a, s) => a + s.variants, 0);

  const planText = slots
    .map((s, i) => `Slot ${i + 1}: ${s.format} (gerar ${s.variants} variações)`)
    .join("\n");

  const res = await runLLM({
    clients,
    system: `${system}

PADRÕES QUE FUNCIONAM:
${patterns.join("\n- ")}

TEMAS PROIBIDOS (já usados):
${memory}

INSTRUÇÕES:
- Para cada slot, gere o número de VARIAÇÕES indicado
- Cada variação deve ser DIFERENTE (ângulo, gancho, estrutura)
- Evite genérico e clichê

Formato de saída JSON:
{
  "variants": [
    { "slot": 1, "format": "reels|carrossel|estatico", "theme": "...", "caption": "..." }
  ]
}
`,
    user: `Plano:\n${planText}`
  });

  return res && Array.isArray(res.variants) ? res.variants : [];
}

module.exports = { generateBatch };
