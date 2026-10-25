import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { listAvailableDrives } from './util.js';

const RAW_CAPTURE_SUFFIX = 'RAW-UPSTREAM-SSE.txt';
const SERVER_LOG_PATTERN = /^server(-\d+)?\.log$/i;
const CACHE_MS = 10_000;
let cachedFiles = new Map();
let cachedLogFiles = new Map();
let cachedAt = 0;
let cachedResult = null;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
}

function captureDirs() {
  if (process.env.AERU_OLLAMA_CAPTURE_DIR) return [process.env.AERU_OLLAMA_CAPTURE_DIR];
  const codexHome = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
  const dirs = [path.join(codexHome, 'local14b-tool-adapter', 'captures')];
  if (!process.env.CODEX_HOME) {
    for (const drive of listAvailableDrives()) {
      for (const rel of [
        ['.codex', 'local14b-tool-adapter', 'captures'],
        ['Codex', 'local14b-tool-adapter', 'captures'],
        ['Ollama', 'captures'],
        ['OllamaModels', 'captures'],
      ]) {
        const candidate = path.join(drive, ...rel);
        if (!dirs.includes(candidate) && fs.existsSync(candidate)) dirs.push(candidate);
      }
    }
  }
  return dirs;
}

export function defaultOllamaModelsDirs() {
  if (process.env.AERUS_OLLAMA_MODELS_DIR) {
    return process.env.AERUS_OLLAMA_MODELS_DIR.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  }
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir) && fs.existsSync(dir)) dirs.push(dir);
  };
  if (process.env.OLLAMA_MODELS) add(process.env.OLLAMA_MODELS);
  for (const drive of listAvailableDrives()) {
    for (const rel of [
      ['OllamaModels'],
      ['ollama-models'],
      ['Ollama', 'models'],
      ['ollama', 'models'],
      ['.ollama', 'models'],
      ['models', 'ollama'],
    ]) {
      add(path.join(drive, ...rel));
    }
  }
  add(path.join(homeDir(), '.ollama', 'models'));
  return dirs;
}

export function defaultOllamaModelsDir() {
  const dirs = defaultOllamaModelsDirs();
  return dirs[0] || process.env.OLLAMA_MODELS || path.join(homeDir(), '.ollama', 'models');
}

export function defaultOllamaLogsDirs() {
  const custom = process.env.AERUS_OLLAMA_LOG_DIR;
  if (custom === 'off' || custom === '0') return [];
  if (custom) return custom.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  if (process.env.AERU_OLLAMA_CAPTURE_DIR) return [];

  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir) && fs.existsSync(dir)) dirs.push(dir);
  };
  const localAppData = process.env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(homeDir(), 'AppData', 'Local') : '');
  if (localAppData) add(path.join(localAppData, 'Ollama'));
  for (const drive of listAvailableDrives()) {
    for (const rel of [
      ['Ollama', 'logs'],
      ['Ollama'],
      ['OllamaModels', 'logs'],
      ['OllamaModels'],
      ['ollama-models', 'logs'],
      ['.ollama', 'logs'],
      ['.ollama'],
    ]) {
      add(path.join(drive, ...rel));
    }
  }
  return dirs;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function dateFromName(name) {
  const match = name.match(/^\d+-([0-9]{4}-[0-9]{2}-[0-9]{2})T/);
  return match ? match[1] : null;
}

function dateFromMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Capture names look like 0001-2026-09-20T19-36-30-854Z-RAW-UPSTREAM-SSE.txt (UTC time of the response).
function timeFromName(name) {
  const match = name.match(/^\d+-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

async function readCapture(file, name) {
  // The time comes from the file name when it has one, otherwise from the file's last-modified time.
  const stat = await fsp.stat(file);
  const result = { inputTokens: 0, outputTokens: 0, totalTokens: 0, responses: 0, model: 'unknown', date: dateFromName(name), at: timeFromName(name) ?? stat.mtimeMs };
  let latest = null;
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let event;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      if (event.type === 'response.completed' && event.response && typeof event.response === 'object') latest = event.response;
    }
  } finally {
    lines.close();
    input.destroy();
  }

  const usage = latest?.usage;
  if (!usage || typeof usage !== 'object') return result;
  result.inputTokens = number(usage.input_tokens ?? usage.prompt_tokens);
  result.outputTokens = number(usage.output_tokens ?? usage.completion_tokens);
  result.totalTokens = number(usage.total_tokens) || result.inputTokens + result.outputTokens;
  result.model = typeof latest.model === 'string' && latest.model ? latest.model : 'unknown';
  if (result.totalTokens > 0) result.responses = 1;
  return result;
}

// Maps blob sha256-<hash> identifiers across all discovered Ollama model roots to human-readable model names.
async function loadBlobModelMap(modelsRoots) {
  const blobToModels = new Map();
  async function walkManifests(dir, relParts = []) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkManifests(full, [...relParts, entry.name]);
      } else if (entry.isFile()) {
        try {
          const data = JSON.parse(await fsp.readFile(full, 'utf8'));
          const tag = entry.name;
          const model = relParts[relParts.length - 1] || 'unknown';
          let label = `${model}:${tag}`;
          if (model === 'llamacpp') {
            const fromLayer = (data.layers || []).find((l) => typeof l?.from === 'string' && l.from);
            if (fromLayer) label = fromLayer.from;
          }
          const digests = [];
          if (data.config?.digest) digests.push(data.config.digest);
          for (const layer of data.layers || []) {
            if (layer?.digest && (!layer.mediaType || layer.mediaType.includes('model'))) {
              digests.push(layer.digest);
            }
          }
          for (const digest of digests) {
            const key = String(digest).replace(':', '-').toLowerCase();
            if (!blobToModels.has(key)) blobToModels.set(key, []);
            const list = blobToModels.get(key);
            if (!list.includes(label)) list.push(label);
          }
        } catch {
          // Ignore malformed manifest files.
        }
      }
    }
  }

  for (const modelsRoot of modelsRoots) {
    for (const sub of ['manifests', 'manifests-v2']) {
      await walkManifests(path.join(modelsRoot, sub));
    }
    if (path.basename(modelsRoot).startsWith('manifests')) {
      await walkManifests(modelsRoot);
    }
  }
  return blobToModels;
}

// Parses Ollama server*.log files where llama-server reports prompt eval and eval token counts.
async function readServerLog(file, blobToModels) {
  const stat = await fsp.stat(file);
  const records = [];
  let currentModel = 'unknown';
  let currentTime = stat.mtimeMs;
  let pendingPrompt = 0;
  let pendingPromptMs = 0;
  let pendingPromptSig = '';

  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.includes('time=')) {
        const tMatch = line.match(/time=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/);
        if (tMatch) {
          const parsed = Date.parse(tMatch[1]);
          if (!Number.isNaN(parsed)) currentTime = parsed;
        }
      } else if (line.startsWith('[GIN]')) {
        const ginTime = line.match(/^\[GIN\]\s+(\d{4})\/(\d{2})\/(\d{2})\s+-\s+(\d{2}):(\d{2}):(\d{2})/);
        if (ginTime) {
          const [, y, mo, d, h, mi, s] = ginTime.map(Number);
          currentTime = new Date(y, mo - 1, d, h, mi, s).getTime();
        }
      }

      if (line.includes('sha256-')) {
        const blobMatch = line.match(/sha256-[0-9a-f]{64}/i);
        if (blobMatch && (line.includes('loading model') || line.includes('using llama-server') || line.includes('model='))) {
          const candidates = blobToModels.get(blobMatch[0].toLowerCase());
          if (candidates && candidates.length) currentModel = candidates[0];
        }
      }

      if (line.includes('eval time =')) {
        const pMatch = line.match(/prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/);
        if (pMatch) {
          pendingPromptMs = number(pMatch[1]);
          pendingPrompt = number(pMatch[2]);
          pendingPromptSig = `${pMatch[1]}:${pMatch[2]}`;
          continue;
        }
        const eMatch = line.match(/(?<!prompt )eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens(?:\s*\([^,]*,\s*([\d.]+)\s*tokens per second\))?/);
        if (eMatch) {
          const evalMs = number(eMatch[1]);
          const outputTokens = number(eMatch[2]);
          const reportedTps = number(eMatch[3]);
          const tokensPerSec = reportedTps || (evalMs > 0 && outputTokens > 0 ? (outputTokens / evalMs) * 1000 : 0);
          const inputTokens = pendingPrompt;
          const totalTokens = inputTokens + outputTokens;
          if (totalTokens > 0) {
            const key = `${currentModel}|${pendingPromptSig}|${eMatch[1]}:${eMatch[2]}|${Math.floor(currentTime / 60_000)}`;
            records.push({
              key,
              at: currentTime,
              date: dateFromMs(currentTime),
              model: currentModel,
              input: inputTokens,
              output: outputTokens,
              total: totalTokens,
              promptEvalMs: pendingPromptMs,
              evalMs,
              tokensPerSec,
            });
          }
          pendingPrompt = 0;
          pendingPromptMs = 0;
          pendingPromptSig = '';
        }
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return records;
}

function summarize(files, logFiles) {
  const summary = {
    available: true,
    captureFiles: files.size + logFiles.size,
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    models: [],
    dailyUsageBuckets: [],
    records: [],
    telemetry: {
      avgTokensPerSec: 0,
      peakTokensPerSec: 0,
      totalEvalMs: 0,
      totalPromptEvalMs: 0,
      cloudEquivalentUsd: 0,
    },
  };
  const models = new Map();
  const days = new Map();
  let timedOutputTokens = 0;
  let timedEvalMs = 0;
  let peakTps = 0;
  let totalPromptMs = 0;

  for (const entry of files.values()) {
    if (!entry.usage.responses) continue;
    summary.responses += entry.usage.responses;
    summary.inputTokens += entry.usage.inputTokens;
    summary.outputTokens += entry.usage.outputTokens;
    summary.totalTokens += entry.usage.totalTokens;
    models.set(entry.usage.model, (models.get(entry.usage.model) || 0) + entry.usage.totalTokens);
    if (entry.usage.date) days.set(entry.usage.date, (days.get(entry.usage.date) || 0) + entry.usage.totalTokens);
    if (entry.usage.at != null) {
      summary.records.push({
        at: entry.usage.at,
        model: entry.usage.model,
        input: entry.usage.inputTokens,
        output: entry.usage.outputTokens,
        total: entry.usage.totalTokens,
        evalMs: 0,
        promptEvalMs: 0,
        tokensPerSec: 0,
      });
    }
  }

  // Deduplicate rotated server logs by response signature so overlapping logs are never counted twice.
  const seenLogKeys = new Set();
  for (const entry of logFiles.values()) {
    for (const rec of entry.records) {
      if (seenLogKeys.has(rec.key)) continue;
      seenLogKeys.add(rec.key);
      summary.responses += 1;
      summary.inputTokens += rec.input;
      summary.outputTokens += rec.output;
      summary.totalTokens += rec.total;
      models.set(rec.model, (models.get(rec.model) || 0) + rec.total);
      if (rec.date) days.set(rec.date, (days.get(rec.date) || 0) + rec.total);
      if (rec.evalMs > 0 && rec.output > 0) {
        timedOutputTokens += rec.output;
        timedEvalMs += rec.evalMs;
      }
      if (rec.promptEvalMs > 0) totalPromptMs += rec.promptEvalMs;
      if (rec.tokensPerSec > peakTps) peakTps = rec.tokensPerSec;
      summary.records.push({
        at: rec.at,
        model: rec.model,
        input: rec.input,
        output: rec.output,
        total: rec.total,
        evalMs: rec.evalMs || 0,
        promptEvalMs: rec.promptEvalMs || 0,
        tokensPerSec: rec.tokensPerSec || 0,
      });
    }
  }

  summary.telemetry = {
    avgTokensPerSec: timedEvalMs > 0 ? Number(((timedOutputTokens / timedEvalMs) * 1000).toFixed(1)) : 0,
    peakTokensPerSec: Number(peakTps.toFixed(1)),
    totalEvalMs: Math.round(timedEvalMs),
    totalPromptEvalMs: Math.round(totalPromptMs),
    // Cloud equivalent savings vs standard $2/1M input + $8/1M output API rates.
    cloudEquivalentUsd: (summary.inputTokens * 2 + summary.outputTokens * 8) / 1e6,
  };

  summary.models = [...models.entries()].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens);
  summary.dailyUsageBuckets = [...days.entries()].map(([startDate, tokens]) => ({ startDate, tokens })).sort((a, b) => a.startDate.localeCompare(b.startDate));
  return summary;
}

// Queries the local Ollama daemon (127.0.0.1:11434/api/ps) to inspect models currently loaded in VRAM.
export async function readOllamaLiveStatus() {
  if (process.env.AERUS_OLLAMA_LIVE === 'off' || process.env.AERU_OLLAMA_CAPTURE_DIR) {
    return { running: false, models: [] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 450);
  try {
    const res = await fetch('http://127.0.0.1:11434/api/ps', { signal: controller.signal });
    if (!res.ok) return { running: false, models: [] };
    const body = await res.json();
    const list = Array.isArray(body?.models) ? body.models : [];
    return {
      running: true,
      models: list.map((m) => ({
        name: m.name || m.model || 'unknown',
        sizeBytes: number(m.size),
        sizeVramBytes: number(m.size_vram),
        quantization: m.details?.quantization_level || null,
        parameterSize: m.details?.parameter_size || null,
        contextLength: number(m.context_length),
      })),
    };
  } catch {
    return { running: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function readLocalOllamaUsage() {
  if (cachedResult && Date.now() - cachedAt < CACHE_MS) return cachedResult;
  const directories = captureDirs();
  let foundAnySource = false;
  const presentCaptures = new Set();

  for (const directory of directories) {
    try {
      const names = (await fsp.readdir(directory)).filter((name) => name.endsWith(RAW_CAPTURE_SUFFIX));
      if (names.length || directory === process.env.AERU_OLLAMA_CAPTURE_DIR) foundAnySource = true;
      await Promise.all(names.map(async (name) => {
        const file = path.join(directory, name);
        presentCaptures.add(file);
        try {
          const stat = await fsp.stat(file);
          const existing = cachedFiles.get(file);
          if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) return;
          const usage = await readCapture(file, name);
          cachedFiles.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, usage });
        } catch {
          // A capture can be rotated or removed while the folder is being scanned.
        }
      }));
    } catch {
      // Directory not present.
    }
  }
  for (const key of cachedFiles.keys()) {
    if (!presentCaptures.has(key)) cachedFiles.delete(key);
  }

  const logDirs = defaultOllamaLogsDirs();
  const modelsDirs = defaultOllamaModelsDirs();
  if (logDirs.length) {
    const blobToModels = await loadBlobModelMap(modelsDirs);
    const presentLogs = new Set();
    for (const logDir of logDirs) {
      let names;
      try {
        names = (await fsp.readdir(logDir)).filter((name) => SERVER_LOG_PATTERN.test(name));
      } catch {
        continue;
      }
      if (names.length) foundAnySource = true;
      await Promise.all(names.map(async (name) => {
        const file = path.join(logDir, name);
        presentLogs.add(file);
        try {
          const stat = await fsp.stat(file);
          const existing = cachedLogFiles.get(file);
          if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) return;
          const records = await readServerLog(file, blobToModels);
          cachedLogFiles.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, records });
        } catch {
          // A log file can be rotated while being read.
        }
      }));
    }
    for (const file of cachedLogFiles.keys()) {
      if (!presentLogs.has(file)) cachedLogFiles.delete(file);
    }
  } else {
    cachedLogFiles.clear();
  }

  if (!foundAnySource) {
    const result = { available: false, reason: 'Local Ollama logs or captures were not found.', captureFiles: 0, responses: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [], dailyUsageBuckets: [] };
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  }

  cachedResult = summarize(cachedFiles, cachedLogFiles);
  cachedAt = Date.now();
  return cachedResult;
}
