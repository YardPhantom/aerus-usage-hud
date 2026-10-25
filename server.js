#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanCodex, defaultCodexDir, defaultCodexExtraDirs } from './src/codex.js';
import { scanClaude, defaultClaudeDir, defaultClaudeBackupDirs } from './src/claude.js';
import { readAccountUsage } from './src/codex-account.js';
import { readLocalOllamaUsage, readOllamaLiveStatus, defaultOllamaModelsDir, defaultOllamaLogsDirs } from './src/local-ollama.js';
import { loadStore, saveStore, recordSnapshot } from './src/account-store.js';
import { computeCodexTotals, computeOllamaTotal, ollamaEvents } from './src/totals.js';
import { buildView, RANGES } from './src/aggregate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'public');
const DATA_DIR = process.env.AERUS_DATA_DIR || path.join(HERE, 'data');
const HOST = '127.0.0.1';
const PREFERRED = Number(process.env.PORT) || 8790;
const SHOULD_OPEN = !process.argv.includes('--no-open');
// A live account lookup is reused for this long. After that the next All Time view checks again.
const ACCOUNT_FRESH_MS = 10 * 60_000;
// Set AERUS_ACCOUNT_LOOKUP=off to run fully offline (the saved snapshot is still used).
const ACCOUNT_LOOKUP_OFF = process.env.AERUS_ACCOUNT_LOOKUP === 'off';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// Asks the local Codex app-server for the account lifetime total and records it only if the lookup succeeds.
async function reconcileAccount(store, localTotal) {
  if (ACCOUNT_LOOKUP_OFF) return { status: 'off', reason: 'online lookup is turned off', changed: false };
  if (store.current && Date.now() - Date.parse(store.current.checkedAt) < ACCOUNT_FRESH_MS) {
    return { status: 'current', reason: null, changed: false };
  }
  const result = await readAccountUsage().catch(() => ({ available: false, reason: 'Codex account lookup failed.' }));
  if (!result.available) return { status: 'unavailable', reason: result.reason, changed: false };

  const capturedAt = new Date().toISOString();
  const outcome = recordSnapshot(store, {
    lifetimeTokens: Math.round(result.lifetimeTokens),
    capturedAt,
    localTotalAtCapture: localTotal,
    source: 'Codex app-server account/usage/read',
  });
  if (!outcome.accepted) return { status: 'rejected', reason: outcome.reason, changed: false };
  return { status: 'live', reason: null, changed: true };
}

// Keeps the largest Ollama total verified so far. Captures can be deleted, and a stored total is never lowered.
function recordOllama(store, ollama) {
  if (!ollama?.available) return false;
  const observed = Math.round(ollama.totalTokens);
  const total = Math.max(observed, store.ollama?.total ?? 0);
  store.ollama = { total, observedAt: new Date().toISOString(), source: 'local Ollama logs and captures' };
  return true;
}

function clampOffset(raw) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.min(0, Math.max(-3650, n));
}

async function usageFor(url) {
  const requested = url.searchParams.get('range');
  const range = RANGES.includes(requested) ? requested : 'today';
  const offset = clampOffset(url.searchParams.get('offset'));
  const claudeDir = defaultClaudeDir();
  const codexDir = defaultCodexDir();
  const warnings = [];

  const [codex, claude, ollama, ollamaLive] = await Promise.all([
    scanCodex(codexDir),
    scanClaude({ claudeDir, dataDir: DATA_DIR }),
    readLocalOllamaUsage().catch(() => null),
    readOllamaLiveStatus().catch(() => ({ running: false, models: [] })),
  ]);
  if (!codex.found) warnings.push(`Codex history not found at ${codexDir}.`);
  if (!claude.found) warnings.push(`Claude Code logs not found at ${path.join(claudeDir, 'projects')}.`);
  const ollamaUsage = ollamaEvents(ollama?.records ?? []);

  let allTime = null;
  if (range === 'all') {
    const store = await loadStore(DATA_DIR);
    const localTotal = codex.events.reduce((sum, event) => sum + event.total, 0);
    const lookup = await reconcileAccount(store, localTotal);
    const ollamaChanged = recordOllama(store, ollama);
    if (lookup.changed || ollamaChanged) await saveStore(DATA_DIR, store);

    allTime = {
      codex: computeCodexTotals({ events: codex.events, account: store.current }),
      ollama: computeOllamaTotal({ events: ollamaUsage, stored: store.ollama }),
      lookup,
    };

    if (lookup.status === 'unavailable' || lookup.status === 'rejected' || lookup.status === 'off') {
      warnings.push(
        store.current
          ? `Online account total not refreshed (${lookup.reason}). Showing the verified snapshot from ${new Date(store.current.checkedAt).toLocaleString('en-US')}.`
          : `No verified account total yet (${lookup.reason}). All Time shows local sessions and Ollama only.`,
      );
    }
  }

  return buildView({
    events: [...codex.events, ...claude.events, ...ollamaUsage],
    range,
    offset,
    allTime,
    warnings,
    ollamaLive,
    sources: {
      codex: { found: codex.found, files: codex.files },
      claude: { found: claude.found, files: claude.files, records: claude.ledgerRecords },
      ollama: { found: Boolean(ollama?.available), files: ollama?.captureFiles ?? 0, records: ollama?.responses ?? 0 },
    },
  });
}

// Live local file watcher for Server-Sent Events (/api/stream).
const sseClients = new Set();
const activeWatchers = [];
let notifyTimer = null;

function broadcastRefresh(reason = 'file-change') {
  if (!sseClients.size) return;
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const payload = `data: ${JSON.stringify({ type: 'refresh', reason, at: Date.now() })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }, 900);
}

function setupLocalWatchers() {
  const dirs = new Set([
    path.join(defaultClaudeDir(), 'projects'),
    ...defaultClaudeBackupDirs(),
    path.join(defaultCodexDir(), 'sessions'),
    ...defaultCodexExtraDirs().map((d) => path.join(d, 'sessions')),
    ...defaultOllamaLogsDirs(),
  ]);
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const lower = String(filename).toLowerCase();
        if (lower.endsWith('.jsonl') || lower.endsWith('.log') || lower.endsWith('.txt')) {
          broadcastRefresh(path.basename(String(filename)));
        }
      });
      watcher.on('error', () => {});
      activeWatchers.push(watcher);
    } catch {
      // Recursive fs.watch may not be supported on some virtual filesystems; polling fallback remains active.
    }
  }
}

function send(response, status, body, type) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${HOST}`);
    if (url.pathname === '/api/usage') {
      try {
        send(response, 200, JSON.stringify(await usageFor(url)), 'application/json; charset=utf-8');
      } catch (error) {
        send(response, 500, JSON.stringify({ error: 'Unable to scan local usage.', detail: error.message }), 'application/json; charset=utf-8');
      }
      return;
    }

    if (url.pathname === '/api/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({ type: 'connected', at: Date.now() })}\n\n`);
      sseClients.add(response);
      request.on('close', () => sseClients.delete(response));
      return;
    }

    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
      return;
    }
    try {
      const body = await fsp.readFile(file);
      send(response, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
    } catch {
      send(response, 404, 'Not found', 'text/plain; charset=utf-8');
    }
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

const server = createServer();
let port = PREFERRED;
for (; port < PREFERRED + 10; port += 1) {
  try {
    await listen(server, port);
    break;
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || port === PREFERRED + 9) throw error;
  }
}

setupLocalWatchers();

const url = `http://${HOST}:${port}`;
console.log('\nAERUS AI USAGE HUD');
console.log('Local logs stay on this computer.\n');
console.log(`Dashboard  ${url}`);
console.log(`Codex      ${defaultCodexDir()}`);
console.log(`Claude     ${[path.join(defaultClaudeDir(), 'projects'), ...defaultClaudeBackupDirs()].join(' ; ')}`);
console.log(`Ollama     ${defaultOllamaModelsDir()}`);
console.log(`Data       ${DATA_DIR}\n`);
if (SHOULD_OPEN) openBrowser(url);

const close = () => {
  for (const w of activeWatchers) {
    try { w.close(); } catch {}
  }
  server.close(() => process.exit(0));
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
