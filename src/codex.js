// Codex CLI history: ~/.codex/sessions and archived_sessions (JSONL),
// plus auto-discovered relocated Codex directories across mounted drives.
// Each turn is read from last_token_usage (the per-turn delta). Cumulative totals are only used
// as a fallback when no per-turn delta exists, so nothing is counted twice.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { codexCost } from './pricing.js';
import {
  discoverDriveDirs,
  isDirectory,
  listJsonl,
  normalizeModel,
  num,
  parseTime,
  projectFromCwd,
  pruneMapKeys,
} from './util.js';

export function defaultCodexDir() {
  return process.env.AERUS_CODEX_DIR || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function defaultCodexExtraDirs() {
  if (process.env.AERUS_CODEX_DIR || process.env.CODEX_HOME) return [];
  return discoverDriveDirs([
    ['.codex'],
    ['Codex'],
    ['codex'],
    ['Backups', 'codex-sessions'],
  ]);
}

// Parsed file results, keyed by path, so unchanged sessions are not re-read on every open.
const fileCache = new Map();

export async function scanCodex(codexDir = defaultCodexDir()) {
  const extraDirs = codexDir === defaultCodexDir() ? defaultCodexExtraDirs() : [];
  const allDirs = [codexDir, ...extraDirs];
  let anyFound = false;
  const files = [];

  for (const dir of allDirs) {
    if (await isDirectory(dir)) {
      anyFound = true;
      files.push(
        ...(await listJsonl(path.join(dir, 'sessions'))),
        ...(await listJsonl(path.join(dir, 'archived_sessions'))),
      );
    }
  }
  if (!anyFound) {
    fileCache.clear();
    return { found: false, files: 0, events: [] };
  }

  const presentFiles = new Set(files);
  const seenSessions = new Set();
  const events = [];

  for (const file of files) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue;
    }
    const key = `${stat.mtimeMs}:${stat.size}:${codexDir}`;
    let cached = fileCache.get(file);
    if (!cached || cached.key !== key) {
      cached = { key, session: await parseCodexFile(file, codexDir) };
      fileCache.set(file, cached);
    }
    // An archived copy can repeat an active session. Count each session id once.
    if (seenSessions.has(cached.session.sessionId)) continue;
    seenSessions.add(cached.session.sessionId);
    events.push(...cached.session.events);
  }
  pruneMapKeys(fileCache, presentFiles);
  return { found: anyFound, files: files.length, events };
}

async function parseCodexFile(file, codexDir) {
  const meta = { id: path.basename(file, '.jsonl'), cwd: '', model: 'unknown' };
  const counts = [];
  try {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || line.length > 2_000_000) continue;
      if (!line.includes('token_count') && !line.includes('token_usage') && !line.includes('session_meta') && !line.includes('turn_context')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
      if (record.type === 'session_meta') {
        meta.id = payload.id || payload.session_id || meta.id;
        meta.cwd = payload.cwd || meta.cwd;
        if (payload.model) meta.model = normalizeModel(payload.model);
        continue;
      }
      if (record.type === 'turn_context') {
        if (payload.model) meta.model = normalizeModel(payload.model);
        if (payload.cwd) meta.cwd = payload.cwd;
        continue;
      }
      const info = payload.info && typeof payload.info === 'object' ? payload.info : payload;
      const isCount =
        (record.type === 'event_msg' && (payload.type === 'token_count' || payload.type === 'token_usage')) ||
        record.type === 'token_count';
      if (!isCount) continue;
      counts.push({
        last: info.last_token_usage || payload.last_token_usage,
        total: info.total_token_usage || payload.total_token_usage,
        model: normalizeModel(info.model || payload.model || meta.model),
        at: parseTime(record.timestamp || payload.timestamp || record.time),
      });
    }
  } catch {
    return { sessionId: meta.id, events: [] };
  }

  const project = projectFromCwd(meta.cwd, codexDir);
  const events = [];
  let prev = null;
  for (const count of counts) {
    let tokens = null;
    if (count.last) {
      tokens = codexTokens(count.last);
    } else if (count.total) {
      const cur = codexTokens(count.total);
      if (cur) {
        tokens =
          !prev || cur.total + 1 < prev.total
            ? cur
            : {
                input: Math.max(0, cur.input - prev.input),
                output: Math.max(0, cur.output - prev.output),
                cached: Math.max(0, cur.cached - prev.cached),
                total: Math.max(0, cur.total - prev.total),
              };
        prev = cur;
      }
    }
    if (!tokens || count.at == null || (!tokens.input && !tokens.output)) continue;
    const input = Math.max(0, tokens.input - tokens.cached);
    const cacheRead = tokens.cached;
    events.push({
      provider: 'codex',
      at: count.at,
      sessionId: meta.id,
      project,
      model: count.model,
      input,
      output: tokens.output,
      cacheRead,
      cacheWrite: 0,
      total: input + cacheRead + tokens.output,
      cost: codexCost(count.model, { input, cached: cacheRead, output: tokens.output }),
    });
  }
  return { sessionId: meta.id, events };
}

// Codex reports input_tokens including cached input, so cached is split out where it is counted.
function codexTokens(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = num(raw.input_tokens ?? raw.inputTokens);
  const output = num(raw.output_tokens ?? raw.outputTokens);
  const cached = Math.min(input, num(raw.cached_input_tokens ?? raw.cachedInputTokens));
  const total = num(raw.total_tokens ?? raw.totalTokens) || input + output;
  if (!input && !output && !total) return null;
  return { input, output, cached, total };
}
