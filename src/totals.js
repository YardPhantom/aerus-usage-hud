// Totals for each source, kept separate so nothing is counted twice.
//
// Codex
//   Local session logs are the detailed record: sessions, models, cost. A verified account snapshot is the
//   account's lifetime total at capturedAt. That total already contains every local session that existed at
//   capturedAt, so only local sessions that started after it are added:
//
//     codexUnique = max(lifetime, localAtCapture) + local sessions started after capturedAt
//     accountOnly = codexUnique - local sessions on disk now   (account usage the logs do not show)
//
//   Without a snapshot, Codex is just the local sessions. Nothing is estimated.
//
// Ollama
//   Each capture file is one real local response with its model, input and output tokens. Cache tokens are
//   not in the captures, so they are reported as unavailable. The total is the larger of the captures on disk
//   and the total already verified and stored, so history is not lost if a capture file is deleted.
//
// Claude is tracked from Claude Code logs and does not overlap with either source.

export function computeCodexTotals({ events, account = null }) {
  const capturedAt = account ? Date.parse(account.capturedAt) : null;
  let localTotal = 0;
  let localAfter = 0;
  for (const event of events) {
    if (event.provider !== 'codex') continue;
    localTotal += event.total;
    if (capturedAt != null && event.at > capturedAt) localAfter += event.total;
  }

  const codexUnique = account
    ? Math.max(account.lifetimeTokens, account.localTotalAtCapture) + localAfter
    : localTotal;

  return {
    basis: account ? 'account-snapshot' : 'local-only',
    localTotal,
    accountOnly: Math.max(0, codexUnique - localTotal),
    codexUnique,
    snapshot: account
      ? {
          lifetimeTokens: account.lifetimeTokens,
          capturedAt: account.capturedAt,
          checkedAt: account.checkedAt,
          source: account.source,
        }
      : null,
  };
}

// Ollama usage events from real capture records. Cache is not recorded, so it is null (unavailable).
export function ollamaEvents(records) {
  return records.map((record) => {
    const day = localDayKey(record.at);
    return {
      provider: 'ollama',
      at: record.at,
      sessionId: `${day}|${record.model}`,
      project: 'Local Ollama',
      model: record.model,
      input: record.input,
      output: record.output,
      cacheRead: 0,
      cacheWrite: 0,
      cacheKnown: false,
      total: record.input + record.output,
      cost: 0,
      evalMs: record.evalMs || 0,
      promptEvalMs: record.promptEvalMs || 0,
      tokensPerSec: record.tokensPerSec || 0,
    };
  });
}

// All Time Ollama total: the captured sum, or the larger verified total already stored when captures were removed.
export function computeOllamaTotal({ events, stored = null, observedAt = null }) {
  let captured = 0;
  for (const event of events) if (event.provider === 'ollama') captured += event.total;
  const storedTotal = stored?.total ?? 0;
  return {
    total: Math.max(captured, storedTotal),
    storedFloorApplied: storedTotal > captured,
    observedAt,
  };
}

function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
