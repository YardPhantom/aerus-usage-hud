// Turns usage events into the view the dashboard draws.
// Every event has: provider ('codex' | 'claude' | 'ollama'), at (epoch ms), sessionId, project, model,
// input, output, cacheRead, cacheWrite, total, cost, and optionally cacheKnown (false when cache is not recorded).
import { modelBreakdown, projectBreakdown } from './models.js';
import { cacheSavingsForEvent, ollamaCloudEquivalent } from './pricing.js';

export const RANGES = ['today', '7d', '30d', 'all'];
export const PROVIDERS = ['codex', 'claude', 'ollama'];

const DAY_MS = 86_400_000;

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const addDays = (ms, days) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const dayLabel = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Window in local time. Offset moves back in steps of one day (Today) or one range (7d, 30d).
export function resolveWindow(range, offset, now = Date.now()) {
  const today = startOfDay(now);
  if (range === 'all') {
    return {
      range,
      offset: 0,
      start: -Infinity,
      end: Infinity,
      canForward: false,
      granularity: 'day',
      seriesStart: addDays(today, -29),
      seriesEnd: addDays(today, 1),
      label: 'All time',
    };
  }
  if (range === 'today') {
    const start = addDays(today, offset);
    return {
      range,
      offset,
      start,
      end: addDays(start, 1),
      canForward: offset < 0,
      granularity: 'hour',
      seriesStart: start,
      seriesEnd: addDays(start, 1),
      label: dayLabel(start),
    };
  }
  const days = range === '30d' ? 30 : 7;
  const end = addDays(today, 1 + offset * days);
  const start = addDays(end, -days);
  return {
    range: days === 30 ? '30d' : '7d',
    offset,
    start,
    end,
    canForward: offset < 0,
    granularity: 'day',
    seriesStart: start,
    seriesEnd: end,
    label: `${dayLabel(start)} – ${dayLabel(addDays(end, -1))}`,
  };
}

function bucketKeys(win) {
  if (win.granularity === 'hour') {
    return Array.from({ length: 24 }, (_, hour) => {
      const d = new Date(win.seriesStart);
      d.setHours(hour, 0, 0, 0);
      return d.getTime();
    });
  }
  const keys = [];
  for (let t = win.seriesStart; t < win.seriesEnd; t = addDays(t, 1)) keys.push(t);
  return keys;
}

const bucketOf = (granularity, at) => (granularity === 'hour' ? new Date(at).setMinutes(0, 0, 0) : startOfDay(at));

const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
const TOKEN_KEYS = Object.keys(blank());

function addInto(target, source) {
  for (const key of TOKEN_KEYS) target[key] += source[key];
  return target;
}

const hitRate = (input, cacheRead) => (input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0);

// Computes 364-day (52-week) activity heatmap, current/longest streak, peak day, and busiest hour.
function computeActivity(events, now) {
  const today = startOfDay(now);
  const byDay = new Map();
  const hours = new Array(24).fill(0);

  for (const event of events) {
    if (!event.total || !Number.isFinite(event.at)) continue;
    const day = startOfDay(event.at);
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { total: 0, codex: 0, claude: 0, ollama: 0 };
      byDay.set(day, bucket);
    }
    bucket.total += event.total;
    if (bucket[event.provider] != null) bucket[event.provider] += event.total;
    const hr = new Date(event.at).getHours();
    if (hr >= 0 && hr < 24) hours[hr] += event.total;
  }

  let peakDay = null;
  const sortedDays = [...byDay.keys()].sort((a, b) => a - b);
  let longestStreakDays = 0;
  let runningStreak = 0;
  let prevDay = null;

  for (const d of sortedDays) {
    const info = byDay.get(d);
    if (!peakDay || info.total > peakDay.total) {
      peakDay = { at: d, label: dayLabel(d), total: info.total };
    }
    if (prevDay != null && Math.round((d - prevDay) / DAY_MS) === 1) {
      runningStreak += 1;
    } else {
      runningStreak = 1;
    }
    if (runningStreak > longestStreakDays) longestStreakDays = runningStreak;
    prevDay = d;
  }

  let currentStreakDays = 0;
  let cursor = byDay.has(today) ? today : byDay.has(addDays(today, -1)) ? addDays(today, -1) : null;
  while (cursor != null && byDay.has(cursor)) {
    currentStreakDays += 1;
    cursor = addDays(cursor, -1);
  }

  let busiestHour = null;
  let maxHourTokens = 0;
  for (let h = 0; h < 24; h += 1) {
    if (hours[h] > maxHourTokens) {
      maxHourTokens = hours[h];
      busiestHour = h;
    }
  }

  const heatmap = [];
  const startHeat = addDays(today, -363);
  for (let d = startHeat; d <= today; d = addDays(d, 1)) {
    const b = byDay.get(d);
    if (!b || !b.total) {
      heatmap.push({ at: d, total: 0, dominant: 'none' });
    } else {
      const dominant =
        b.claude >= b.codex && b.claude >= b.ollama
          ? 'claude'
          : b.codex >= b.ollama
            ? 'codex'
            : 'ollama';
      heatmap.push({ at: d, total: b.total, dominant });
    }
  }

  return {
    currentStreakDays,
    longestStreakDays,
    peakDay,
    busiestHour,
    activeDays: byDay.size,
    heatmap,
  };
}

// Returns turn-by-turn breakdown for a single session in the Session Deep-Inspector Modal.
export function inspectSession(events, provider, sessionId) {
  const matches = events
    .filter((e) => e.provider === provider && e.sessionId === sessionId)
    .sort((a, b) => a.at - b.at);
  if (!matches.length) return null;

  const totals = blank();
  let cacheKnown = true;
  let cumulative = 0;
  const turns = matches.map((e, index) => {
    addInto(totals, e);
    if (e.cacheKnown === false) cacheKnown = false;
    cumulative += e.total;
    return {
      turn: index + 1,
      at: e.at,
      model: e.model,
      input: e.input,
      output: e.output,
      cacheRead: e.cacheRead,
      cacheWrite: e.cacheWrite,
      total: e.total,
      cumulativeTotal: cumulative,
      cost: e.cost || 0,
      tokensPerSec: e.tokensPerSec || 0,
    };
  });

  const last = matches[matches.length - 1];
  return {
    provider,
    sessionId,
    project: last.project,
    model: last.model,
    startedAt: matches[0].at,
    endedAt: last.at,
    turnCount: turns.length,
    cacheKnown,
    cacheHitRate: cacheKnown ? hitRate(totals.input, totals.cacheRead) : null,
    totals,
    turns,
  };
}

// allTime (All Time only) = { codexUnique, ollama: { total, storedFloorApplied, observedAt }, codex: result of
// computeCodexTotals(), lookup } from totals.js. Those replace the windowed sums for Codex and Ollama totals.
export function buildView({
  events,
  range,
  offset,
  now = Date.now(),
  sources = {},
  allTime = null,
  warnings = [],
  ollamaLive = null,
  ollamaCatalog = null,
}) {
  const win = resolveWindow(range, offset, now);
  const keys = bucketKeys(win);
  const slot = new Map(keys.map((key, index) => [key, index]));
  const providers = Object.fromEntries(PROVIDERS.map((p) => [p, blank()]));
  const cacheSavings = Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
  const series = Object.fromEntries(PROVIDERS.map((p) => [p, keys.map(() => 0)]));
  const sessions = new Map();
  const inWindow = events.filter((event) => event.at >= win.start && event.at < win.end);

  let ollamaTimedOutput = 0;
  let ollamaTimedEvalMs = 0;
  let ollamaPeakTps = 0;
  let ollamaPromptEvalMs = 0;

  for (const event of inWindow) {
    addInto(providers[event.provider], event);
    cacheSavings[event.provider] += cacheSavingsForEvent(event);

    if (event.provider === 'ollama') {
      if (event.evalMs > 0 && event.output > 0) {
        ollamaTimedOutput += event.output;
        ollamaTimedEvalMs += event.evalMs;
      }
      if (event.promptEvalMs > 0) ollamaPromptEvalMs += event.promptEvalMs;
      if ((event.tokensPerSec || 0) > ollamaPeakTps) ollamaPeakTps = event.tokensPerSec;
    }

    const index = slot.get(bucketOf(win.granularity, event.at));
    if (index !== undefined) series[event.provider][index] += event.total;

    const key = `${event.provider}:${event.sessionId}`;
    let session = sessions.get(key);
    if (!session) {
      session = {
        provider: event.provider,
        sessionId: event.sessionId,
        project: event.project,
        model: event.model,
        lastAt: event.at,
        turnCount: 0,
        cacheKnown: event.cacheKnown !== false,
        timedOutput: 0,
        timedEvalMs: 0,
        ...blank(),
      };
      sessions.set(key, session);
    }
    session.turnCount += 1;
    if (event.at >= session.lastAt) {
      session.lastAt = event.at;
      session.model = event.model;
      session.project = event.project;
    }
    if (event.evalMs > 0 && event.output > 0) {
      session.timedOutput += event.output;
      session.timedEvalMs += event.evalMs;
    }
    addInto(session, event);
  }

  // All Time replaces the Codex and Ollama totals with the no-double-count figures.
  if (range === 'all' && allTime) {
    providers.codex.total = allTime.codex.codexUnique;
    providers.ollama.total = Math.max(providers.ollama.total, allTime.ollama.total);
  }

  const sessionRows = [...sessions.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 500)
    .map((s) => ({
      provider: s.provider,
      sessionId: s.sessionId,
      project: s.project,
      model: s.model,
      at: s.lastAt,
      turnCount: s.turnCount,
      input: s.input,
      output: s.output,
      cache: s.cacheKnown ? s.cacheRead + s.cacheWrite : null,
      total: s.total,
      cost: s.cost,
      tokensPerSec: s.timedEvalMs > 0 ? Number(((s.timedOutput / s.timedEvalMs) * 1000).toFixed(1)) : 0,
    }));

  const sessionCounts = Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
  for (const s of sessions.values()) sessionCounts[s.provider] += 1;

  const totals = PROVIDERS.reduce((sum, p) => addInto(sum, providers[p]), blank());
  const share = Object.fromEntries(
    PROVIDERS.map((p) => [p, totals.total ? providers[p].total / totals.total : 0]),
  );

  const totalCacheSavedUsd = cacheSavings.codex + cacheSavings.claude;
  const ollamaEquivalentUsd = ollamaCloudEquivalent(providers.ollama);
  const activity = computeActivity(events, now);
  const windowDays = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : Math.max(1, activity.activeDays);
  const dailyBurnUsd = totals.cost / windowDays;

  return {
    generatedAt: now,
    range: win.range,
    offset: win.offset,
    label: win.label,
    canForward: win.canForward,
    totals: {
      ...totals,
      sessions: sessions.size,
      cacheHitRate: hitRate(totals.input, totals.cacheRead),
      cacheSavedUsd: totalCacheSavedUsd,
    },
    providers: Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        {
          ...providers[p],
          sessions: sessionCounts[p],
          // Ollama captures do not record cache tokens, so cache is reported as unavailable.
          cacheAvailable: p !== 'ollama',
          cacheHitRate: p === 'ollama' ? null : hitRate(providers[p].input, providers[p].cacheRead),
          cacheSavedUsd: cacheSavings[p] || 0,
        },
      ]),
    ),
    efficiency: {
      cacheHitRate: hitRate(totals.input, totals.cacheRead),
      cacheSavedUsd: totalCacheSavedUsd,
      ollamaCloudEquivalentUsd: ollamaEquivalentUsd,
      dailyBurnUsd,
      projectedMonthlyUsd: dailyBurnUsd * 30,
      ollamaTelemetry: {
        avgTokensPerSec: ollamaTimedEvalMs > 0 ? Number(((ollamaTimedOutput / ollamaTimedEvalMs) * 1000).toFixed(1)) : 0,
        peakTokensPerSec: Number(ollamaPeakTps.toFixed(1)),
        totalEvalMs: Math.round(ollamaTimedEvalMs),
        totalPromptEvalMs: Math.round(ollamaPromptEvalMs),
        installedModelsCount: ollamaCatalog?.installedModelsCount || 0,
        totalDiskBytes: ollamaCatalog?.totalDiskBytes || 0,
        live: ollamaLive,
      },
    },
    activity,
    share,
    // Per-model totals for the Model Proportion chart. Account-only Codex usage has no model, so it is
    // reported here as unattributed and kept out of the chart.
    models: modelBreakdown(inWindow),
    projects: projectBreakdown(inWindow),
    unattributed: range === 'all' && allTime ? allTime.codex.accountOnly : 0,
    series: { granularity: win.granularity, labels: keys, ...series },
    sessions: sessionRows,
    sources,
    allTime: range === 'all' ? allTime : null,
    warnings,
  };
}
