// Per-model and per-project totals for the proportion charts. Read-only: it sums events that were already
// deduplicated by the provider scanners, so a token is never counted twice here. Usage without model identity
// is only labelled "Unknown model" when a session reported no model.
const PROVIDERS = ['codex', 'claude', 'ollama'];

export const MODEL_CHART_LIMIT = 12;
export const PROJECT_CHART_LIMIT = 12;
export const UNKNOWN_MODEL = 'Unknown model';
export const UNKNOWN_PROJECT = 'General';

function rankDimension(events, { limit, keyField, fallbackName, pluralNoun }) {
  const byKey = new Map();
  for (const event of events) {
    if (!PROVIDERS.includes(event.provider) || !event.total) continue;
    const raw = event[keyField];
    const name = raw && String(raw).trim() && raw !== 'unknown' ? String(raw).trim() : fallbackName;
    const key = `${event.provider}\u0000${name}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        provider: event.provider,
        [keyField]: name,
        total: 0,
        cost: 0,
        sessions: new Set(),
        timedOutput: 0,
        timedEvalMs: 0,
        peakTps: 0,
      };
      byKey.set(key, row);
    }
    row.total += event.total;
    row.cost += Number(event.cost) || 0;
    if (event.sessionId) row.sessions.add(event.sessionId);
    if (event.evalMs > 0 && event.output > 0) {
      row.timedOutput += event.output;
      row.timedEvalMs += event.evalMs;
    }
    if ((event.tokensPerSec || 0) > row.peakTps) row.peakTps = event.tokensPerSec;
  }

  const ranked = [...byKey.values()]
    .map(({ sessions, timedOutput, timedEvalMs, peakTps, ...row }) => ({
      ...row,
      sessions: sessions.size,
      avgTokensPerSec: timedEvalMs > 0 ? Number(((timedOutput / timedEvalMs) * 1000).toFixed(1)) : 0,
      peakTokensPerSec: Number(peakTps.toFixed(1)),
    }))
    .sort((a, b) => b.total - a.total || a[keyField].localeCompare(b[keyField]));

  const total = ranked.reduce((sum, row) => sum + row.total, 0);
  const shown = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  if (rest.length) {
    shown.push({
      provider: 'other',
      [keyField]: `Other (${rest.length} ${pluralNoun})`,
      total: rest.reduce((sum, row) => sum + row.total, 0),
      cost: rest.reduce((sum, row) => sum + row.cost, 0),
      sessions: rest.reduce((sum, row) => sum + row.sessions, 0),
      avgTokensPerSec: 0,
      peakTokensPerSec: 0,
    });
  }
  return {
    total,
    items: shown.map((row) => ({ ...row, share: total ? row.total / total : 0 })),
    count: ranked.length,
  };
}

export function modelBreakdown(events, { limit = MODEL_CHART_LIMIT } = {}) {
  const { total, items, count } = rankDimension(events, {
    limit,
    keyField: 'model',
    fallbackName: UNKNOWN_MODEL,
    pluralNoun: 'models',
  });
  return { total, models: items, modelCount: count };
}

export function projectBreakdown(events, { limit = PROJECT_CHART_LIMIT } = {}) {
  const { total, items, count } = rankDimension(events, {
    limit,
    keyField: 'project',
    fallbackName: UNKNOWN_PROJECT,
    pluralNoun: 'projects',
  });
  return { total, projects: items, projectCount: count };
}
