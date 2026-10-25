// Claude Code history: ~/.claude/projects/**/*.jsonl (assistant messages carry a usage object),
// plus auto-discovered Claude transcript and backup directories across mounted drives.
//
// Two things matter here:
// 1. Claude Code writes several records per API message while it streams. Records are keyed by
//    message.id and only the record with the highest output_tokens is kept, so nothing is double counted.
// 2. Claude Code prunes old transcripts (about 30 days by default). Every message seen is saved to a
//    local ledger in the HUD data folder, so All Time totals keep history after the source is pruned.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { claudeCost } from './pricing.js';
import {
  discoverDriveDirs,
  isDirectory,
  listJsonl,
  normalizeModel,
  normalizePathKey,
  num,
  parseTime,
  projectFromCwd,
  pruneMapKeys,
} from './util.js';

const LEDGER_VERSION = 1;

export function defaultClaudeDir() {
  return process.env.AERUS_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Auto-discovers relocated Claude folders and transcript backup directories across all mounted drives.
export function defaultClaudeBackupDirs() {
  const custom = process.env.AERUS_CLAUDE_BACKUP_DIR;
  if (custom === 'off' || custom === '0') return [];
  if (custom) return custom.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  if (process.env.AERUS_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR) return [];

  return discoverDriveDirs([
    ['Backups', 'claude-transcripts'],
    ['backups', 'claude-transcripts'],
    ['Claude', 'projects'],
    ['Claude'],
    ['.claude', 'projects'],
    ['.claude'],
  ]);
}

// Scans run one at a time, so two open tabs cannot write the ledger at the same time.
let queue = Promise.resolve();

export function scanClaude(options) {
  const run = queue.then(() => scanClaudeNow(options));
  queue = run.catch(() => {});
  return run;
}

const fileCache = new Map();

// Collects both the active scan directories and their .jsonl files in a single pass.
async function collectProjectFiles(claudeDir, backupDirs) {
  const scanDirs = [];
  const files = [];
  const seenDirs = new Set();
  const seenFiles = new Set();

  const scanCandidate = async (candidate) => {
    const sub = path.join(candidate, 'projects');
    const target = (await isDirectory(sub)) ? sub : (await isDirectory(candidate)) ? candidate : null;
    if (!target) return;
    const dirKey = normalizePathKey(target);
    if (seenDirs.has(dirKey)) return;

    const foundFiles = await listJsonl(target);
    if (target === sub || foundFiles.length > 0) {
      seenDirs.add(dirKey);
      scanDirs.push(target);
      for (const file of foundFiles) {
        const fileKey = normalizePathKey(file);
        if (!seenFiles.has(fileKey)) {
          seenFiles.add(fileKey);
          files.push(file);
        }
      }
    }
  };

  await scanCandidate(claudeDir);
  for (const extra of backupDirs) {
    await scanCandidate(extra);
  }
  return { scanDirs, files };
}

async function scanClaudeNow({ claudeDir = defaultClaudeDir(), backupDirs = null, dataDir } = {}) {
  const extraDirs = backupDirs ?? (claudeDir === defaultClaudeDir() ? defaultClaudeBackupDirs() : []);
  const { scanDirs, files } = await collectProjectFiles(claudeDir, extraDirs);
  const found = scanDirs.length > 0;
  const ledgerFile = path.join(dataDir, 'claude-ledger.json');
  const ledger = await loadLedger(ledgerFile);
  const presentFiles = new Set(files);

  let changed = false;
  for (const file of files) {
    for (const rec of await readFileRecords(file)) {
      if (mergeRecord(ledger.records, rec)) changed = true;
    }
  }
  pruneMapKeys(fileCache, presentFiles);
  if (changed) await saveLedger(ledgerFile, ledger);

  const events = Object.values(ledger.records).map(toEvent);
  return { found, files: files.length, scanDirs, events, ledgerRecords: events.length };
}

// Returns true when the stored record was added or replaced.
export function mergeRecord(records, rec) {
  const prior = records[rec.id];
  if (prior && prior.output >= rec.output) return false;
  records[rec.id] = {
    id: rec.id,
    at: rec.at,
    sessionId: rec.sessionId,
    cwd: rec.cwd,
    model: rec.model,
    input: rec.input,
    output: rec.output,
    cacheRead: rec.cacheRead,
    cw5m: rec.cw5m,
    cw1h: rec.cw1h,
  };
  return true;
}

export function toEvent(rec) {
  const cacheWrite = rec.cw5m + rec.cw1h;
  return {
    provider: 'claude',
    at: rec.at,
    sessionId: rec.sessionId,
    project: projectFromCwd(rec.cwd),
    model: rec.model,
    input: rec.input,
    output: rec.output,
    cacheRead: rec.cacheRead,
    cacheWrite,
    total: rec.input + rec.output + rec.cacheRead + cacheWrite,
    cost: claudeCost(rec.model, rec),
  };
}

async function readFileRecords(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = fileCache.get(file);
  if (cached && cached.key === key) return cached.records;

  const records = [];
  try {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = usageRecord(json, file);
      if (rec) records.push(rec);
    }
  } catch {
    return [];
  }
  fileCache.set(file, { key, records });
  return records;
}

function usageRecord(json, file) {
  if (json.type !== 'assistant') return null;
  const message = json.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheCreation) return null;
  // The 1-hour split is optional. Anything not marked 1-hour is treated as 5-minute.
  const cw1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  const at = parseTime(json.timestamp);
  const id = message.id || json.uuid;
  if (at == null || !id) return null;
  return {
    id,
    at,
    sessionId: json.sessionId || path.basename(file, '.jsonl'),
    cwd: json.cwd || '',
    model: normalizeModel(message.model),
    input,
    output,
    cacheRead,
    cw5m: Math.max(0, cacheCreation - cw1h),
    cw1h,
  };
}

async function loadLedger(file) {
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (data && data.version === LEDGER_VERSION && data.records) return data;
  } catch {
    // Missing or unreadable ledger: start a new one.
  }
  return { version: LEDGER_VERSION, records: {} };
}

async function saveLedger(file, ledger) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(ledger));
  await fsp.rename(temp, file);
}
