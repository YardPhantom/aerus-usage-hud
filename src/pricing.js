// Public API list prices in USD per 1M tokens (checked Oct 2026).
// These are estimates from list prices, not a subscription invoice.

// Codex / OpenAI rows: [model pattern, input, cached input, output].
// Cached input tokens are priced at the cached rate and are not also charged as fresh input.
const CODEX_RATES = [
  [/gpt-5\.6-luna/i, 0.2, 0.02, 1.2],
  [/gpt-5\.6-terra/i, 2, 0.2, 12],
  [/gpt-5\.6-sol/i, 4, 0.4, 20],
  [/gpt-6\.1-sol/i, 2, 0.1, 10],
  [/gpt-6-sol/i, 2, 0.2, 10],
  [/gpt-6-luna/i, 0.1, 0.01, 0.5],
  [/gpt-6-astra|gpt-6\.0-astra/i, 10, 1, 50],
  [/gpt-5\.5/i, 5, 0.5, 30],
  [/gpt-5\.4-mini/i, 0.75, 0.075, 4.5],
  [/gpt-5\.4-nano/i, 0.2, 0.02, 1.25],
  [/gpt-5\.4/i, 2.5, 0.25, 15],
  [/gpt-5\.3-codex/i, 1.75, 0.175, 14],
  [/gpt-5\.2/i, 1.75, 0.175, 14],
  [/gpt-5\.1/i, 1.25, 0.125, 10],
  [/gpt-5-mini/i, 0.25, 0.025, 2],
  [/gpt-5-nano/i, 0.05, 0.005, 0.4],
  [/gpt-5/i, 1.25, 0.125, 10],
  [/gpt-4o-mini/i, 0.15, 0.075, 0.6],
  [/gpt-4o/i, 2.5, 1.25, 10],
  [/o4-mini/i, 1.1, 0.275, 4.4],
  [/o3-mini/i, 1.1, 0.55, 4.4],
  [/o1-mini/i, 1.1, 0.55, 4.4],
  [/codex-auto-review/i, 2, 0.2, 8],
];
const CODEX_FALLBACK = { input: 2, cached: 0.2, output: 8 };

// Claude Opus 4 and 4.1 were priced higher than Opus 4.5 and later.
const LEGACY_OPUS = /opus-4(?:-[01])?(?:-\d{8})?(?:$|[^-\d.])/;

export function codexRate(model) {
  const id = String(model || '');
  for (const [pattern, input, cached, output] of CODEX_RATES) {
    if (pattern.test(id)) return { input, cached, output, known: true };
  }
  return { ...CODEX_FALLBACK, known: false };
}

export function claudeRate(model) {
  const id = String(model || '').toLowerCase();
  if (id.includes('opus')) {
    return LEGACY_OPUS.test(id) ? { input: 15, output: 75, known: true } : { input: 5, output: 25, known: true };
  }
  if (/3-5-haiku|3\.5-haiku/.test(id)) return { input: 0.8, output: 4, known: true };
  if (/claude-3-haiku/.test(id)) return { input: 0.25, output: 1.25, known: true };
  if (id.includes('haiku')) return { input: 1, output: 5, known: true };
  if (id.includes('sonnet')) return { input: 3, output: 15, known: true };
  // Unknown Claude model: price like Sonnet and mark it as not known.
  return { input: 3, output: 15, known: false };
}

export function codexCost(model, { input, cached, output }) {
  const r = codexRate(model);
  return (input * r.input + cached * r.cached + output * r.output) / 1e6;
}

// Claude cache writes cost 1.25x base input (5 minute) or 2x (1 hour). Cache reads cost 0.1x.
export function claudeCost(model, { input, output, cacheRead, cw5m, cw1h }) {
  const r = claudeRate(model);
  const cacheMultiplier = cw5m * 1.25 + cw1h * 2 + cacheRead * 0.1;
  return (input * r.input + output * r.output + cacheMultiplier * r.input) / 1e6;
}

// Estimates USD saved by prompt cache hits vs paying full fresh input rates.
export function cacheSavingsForEvent(event) {
  const cacheRead = Number(event?.cacheRead) || 0;
  if (cacheRead <= 0) return 0;
  if (event.provider === 'codex') {
    const r = codexRate(event.model);
    return (cacheRead * Math.max(0, r.input - r.cached)) / 1e6;
  }
  if (event.provider === 'claude') {
    const r = claudeRate(event.model);
    return (cacheRead * (r.input * 0.9)) / 1e6;
  }
  return 0;
}

// Estimates the equivalent cloud API cost ($2/M input, $8/M output) saved by running a model locally via Ollama.
export function ollamaCloudEquivalent({ input = 0, output = 0 } = {}) {
  return (Number(input) * 2 + Number(output) * 8) / 1e6;
}
