// Compatibility tests: isolated disposable profiles, provider combinations, portable paths, and dedupe.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultCodexDir, scanCodex } from '../src/codex.js';
import { defaultClaudeDir, scanClaude } from '../src/claude.js';
import { buildView } from '../src/aggregate.js';
import { computeCodexTotals, computeOllamaTotal, ollamaEvents } from '../src/totals.js';
import { emptyStore, loadStore, recordSnapshot, saveStore } from '../src/account-store.js';

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// A profile root with spaces and non-ASCII characters, as found on real Windows accounts.
function profileRoot(label) {
  const dir = path.join(os.tmpdir(), `Aerus Profile Ünïcødé 用户 ${label} ${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const isoName = (iso) => iso.replace(/[:.]/g, '-');

function writeCodexSession(codexDir, tokens, at = new Date().toISOString()) {
  const dir = path.join(codexDir, 'sessions', '2026', '10', '23');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session_meta', timestamp: at, payload: { id: `sess-${Math.random().toString(36).slice(2)}`, cwd: 'C:\\Users\\Someone\\Work Ünï', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0, total_tokens: tokens } } } },
  ];
  fs.writeFileSync(path.join(dir, `rollout-${Math.random().toString(36).slice(2)}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeClaudeMessage(claudeDir, { id, output, at = new Date().toISOString() }) {
  const dir = path.join(claudeDir, 'projects', 'Work Ünï');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    sessionId: 'claude-session-1',
    cwd: 'C:\\Users\\Someone\\Work Ünï',
    timestamp: at,
    message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  fs.appendFileSync(path.join(dir, 'session.jsonl'), line + '\n');
}

let captureNumber = 0;
function writeOllamaCapture(captureDir, { input, output, model = 'qwen2.5-coder:14b', at = new Date().toISOString() }) {
  fs.mkdirSync(captureDir, { recursive: true });
  captureNumber += 1;
  // Same shape as the adapter's files: a numeric sequence, the UTC time, then the suffix.
  const name = `${String(captureNumber).padStart(4, '0')}-${isoName(at)}-RAW-UPSTREAM-SSE.txt`;
  const event = { type: 'response.completed', response: { model, usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } };
  fs.writeFileSync(path.join(captureDir, name), `data: ${JSON.stringify(event)}\n`);
}

// Fresh module instance so the Ollama reader's in-process cache cannot carry over between profiles.
let ollamaCase = 0;
async function readOllamaFor(captureDir) {
  process.env.AERU_OLLAMA_CAPTURE_DIR = captureDir;
  ollamaCase += 1;
  const mod = await import(`../src/local-ollama.js?case=${ollamaCase}`);
  const usage = await mod.readLocalOllamaUsage();
  delete process.env.AERU_OLLAMA_CAPTURE_DIR;
  return usage;
}

// Builds the HUD's All Time view for one disposable profile, as the server does.
async function viewFor(profile, { snapshot = null, now = Date.now() } = {}) {
  const codexDir = path.join(profile, 'codex');
  const claudeDir = path.join(profile, 'claude');
  const dataDir = path.join(profile, 'hud-data');
  const captureDir = path.join(profile, 'ollama', 'captures');
  const codex = await scanCodex(codexDir);
  const claude = await scanClaude({ claudeDir, dataDir });
  const ollama = await readOllamaFor(captureDir);
  const ollamaUsage = ollamaEvents(ollama?.records ?? []);
  const store = snapshot ?? (await loadStore(dataDir));
  const events = [...codex.events, ...claude.events, ...ollamaUsage];
  const allTime = {
    codex: computeCodexTotals({ events: codex.events, account: store.current }),
    ollama: computeOllamaTotal({ events: ollamaUsage, stored: store.ollama }),
    lookup: { status: store.current ? 'offline' : 'none' },
  };
  return buildView({ events, range: 'all', offset: 0, now, allTime });
}

test('paths with spaces and non-ASCII characters work for Codex, Claude and the HUD data folder', async () => {
  const profile = profileRoot('unicode');
  const codexDir = path.join(profile, 'codex home');
  const claudeDir = path.join(profile, 'claude 配置');
  writeCodexSession(codexDir, 1234);
  writeClaudeMessage(claudeDir, { id: 'm-unicode', output: 50 });
  const codex = await scanCodex(codexDir);
  const claude = await scanClaude({ claudeDir, dataDir: path.join(profile, 'data 数据') });
  assert.equal(codex.found, true);
  assert.equal(codex.events.reduce((s, e) => s + e.input, 0), 1234);
  assert.equal(claude.found, true);
  assert.equal(claude.events.length, 1);
  assert.ok(fs.existsSync(path.join(profile, 'data 数据', 'claude-ledger.json')));
});

test('CODEX_HOME and CLAUDE_CONFIG_DIR are honored; defaults come from the current user profile', () => {
  const saved = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR, aerus: process.env.AERUS_CODEX_DIR };
  try {
    delete process.env.AERUS_CODEX_DIR;
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'custom codex 家');
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'custom claude 家');
    assert.equal(defaultCodexDir(), process.env.CODEX_HOME);
    assert.equal(defaultClaudeDir(), process.env.CLAUDE_CONFIG_DIR);

    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(defaultCodexDir(), path.join(os.homedir(), '.codex'));
    assert.equal(defaultClaudeDir(), path.join(os.homedir(), '.claude'));
  } finally {
    for (const [key, value] of [['CODEX_HOME', saved.codex], ['CLAUDE_CONFIG_DIR', saved.claude], ['AERUS_CODEX_DIR', saved.aerus]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('clean profile: nothing installed and nothing recorded gives zero totals and no invented data', async () => {
  const profile = profileRoot('clean');
  const view = await viewFor(profile);
  assert.equal(view.totals.total, 0);
  assert.equal(view.providers.codex.total, 0);
  assert.equal(view.providers.claude.total, 0);
  assert.equal(view.providers.ollama.total, 0);
  assert.equal(view.allTime.codex.basis, 'local-only');
  assert.equal(view.allTime.codex.snapshot, null);
  assert.equal(view.sessions.length, 0);
  assert.equal(fs.existsSync(path.join(profile, 'hud-data')), false, 'a clean read must not create user data');
});

test('Codex only: Codex totals, Claude and Ollama are zero', async () => {
  const profile = profileRoot('codex-only');
  writeCodexSession(path.join(profile, 'codex'), 700);
  const view = await viewFor(profile);
  assert.equal(view.providers.codex.total, 700);
  assert.equal(view.providers.claude.total, 0);
  assert.equal(view.providers.ollama.total, 0);
  assert.equal(view.totals.total, 700);
});

test('Claude Code only: Claude totals, Codex and Ollama are zero', async () => {
  const profile = profileRoot('claude-only');
  writeClaudeMessage(path.join(profile, 'claude'), { id: 'only-claude', output: 80 });
  const view = await viewFor(profile);
  assert.equal(view.providers.claude.total, 10 + 80);
  assert.equal(view.providers.codex.total, 0);
  assert.equal(view.providers.ollama.total, 0);
});

test('Ollama only: real captures counted, cache reported as unavailable, nothing else counted', async () => {
  const profile = profileRoot('ollama-only');
  const captureDir = path.join(profile, 'ollama', 'captures');
  writeOllamaCapture(captureDir, { input: 900, output: 100 });
  writeOllamaCapture(captureDir, { input: 300, output: 50, model: 'qwen3-coder:30b' });
  const view = await viewFor(profile);
  assert.equal(view.providers.ollama.total, 1350);
  assert.equal(view.providers.ollama.input, 1200);
  assert.equal(view.providers.ollama.cacheAvailable, false);
  assert.equal(view.providers.codex.total, 0);
  assert.equal(view.totals.total, 1350);
});

test('all three providers: Grand Total is Codex + Claude + Ollama, and Ollama is never inside Codex', async () => {
  const profile = profileRoot('all-three');
  writeCodexSession(path.join(profile, 'codex'), 5000);
  writeClaudeMessage(path.join(profile, 'claude'), { id: 'all-claude', output: 200 });
  writeOllamaCapture(path.join(profile, 'ollama', 'captures'), { input: 400, output: 100 });
  const view = await viewFor(profile);
  const { codex, claude, ollama } = { codex: view.providers.codex.total, claude: view.providers.claude.total, ollama: view.providers.ollama.total };
  assert.equal(codex, 5000);
  assert.equal(claude, 210);
  assert.equal(ollama, 500);
  assert.equal(view.totals.total, codex + claude + ollama);
});

test('repeated refreshes and overlapping records never add the same usage twice', async () => {
  const profile = profileRoot('dedupe');
  writeCodexSession(path.join(profile, 'codex'), 300);
  // The same Claude message written twice (as streaming does) must count once.
  writeClaudeMessage(path.join(profile, 'claude'), { id: 'dup-msg', output: 40 });
  writeClaudeMessage(path.join(profile, 'claude'), { id: 'dup-msg', output: 40 });
  writeOllamaCapture(path.join(profile, 'ollama', 'captures'), { input: 60, output: 40 });
  const first = await viewFor(profile);
  const second = await viewFor(profile);
  const third = await viewFor(profile);
  for (const view of [second, third]) {
    assert.equal(view.totals.total, first.totals.total);
    assert.equal(view.providers.claude.total, 10 + 40);
    assert.equal(view.providers.ollama.total, 100);
  }
});

test('no account snapshot in this profile: Codex is local sessions only, and the account-only gap is 0', async () => {
  const profile = profileRoot('no-account');
  writeCodexSession(path.join(profile, 'codex'), 42);
  const view = await viewFor(profile);
  assert.equal(view.allTime.codex.basis, 'local-only');
  assert.equal(view.allTime.codex.accountOnly, 0);
  assert.equal(view.providers.codex.total, 42);
});

test("another user's saved snapshot is never used as a fallback", async () => {
  const mine = profileRoot('owner');
  const theirs = profileRoot('newcomer');
  const store = emptyStore();
  recordSnapshot(store, { lifetimeTokens: 6_824_351_856, capturedAt: new Date().toISOString(), localTotalAtCapture: 4_199_634_689, source: 'owner' });
  await saveStore(path.join(mine, 'hud-data'), store);
  const loaded = await loadStore(path.join(theirs, 'hud-data'));
  assert.equal(loaded.current, null);
  assert.equal(loaded.ollama, null);
  const view = await viewFor(theirs);
  assert.equal(view.allTime.codex.snapshot, null);
  assert.equal(view.providers.codex.total, 0);
});

test('an existing snapshot is restored after a restart with no online lookup', async () => {
  const profile = profileRoot('restart');
  const store = emptyStore();
  const capturedAt = new Date().toISOString();
  writeCodexSession(path.join(profile, 'codex'), 100, capturedAt.replace(/\.\d+Z$/, 'Z'));
  recordSnapshot(store, { lifetimeTokens: 1_000, capturedAt, localTotalAtCapture: 0, source: 'test' });
  await saveStore(path.join(profile, 'hud-data'), store);
  // Simulated restart: nothing in memory, so the saved file is the only source.
  const view = await viewFor(profile, { now: Date.now() });
  assert.equal(view.allTime.codex.snapshot.lifetimeTokens, 1_000);
  assert.equal(view.allTime.codex.localTotal, 100);
});


test('Claude backup directories on secondary drives are merged and deduplicated by message id', async () => {
  const profile = profileRoot('claude-backup');
  const claudeDir = path.join(profile, 'claude');
  const backupDir = path.join(profile, 'secondary-drive', 'Backups', 'claude-transcripts');
  const dataDir = path.join(profile, 'hud-data');
  writeClaudeMessage(claudeDir, { id: 'm1', output: 40 });
  writeClaudeMessage(claudeDir, { id: 'm2', output: 60 });
  const backupProj = path.join(backupDir, 'Work Backup');
  fs.mkdirSync(backupProj, { recursive: true });
  const backupLine = (id, output) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: 'claude-backup-session',
      cwd: 'D:\\Workspace\\Demo',
      timestamp: new Date().toISOString(),
      message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
  fs.writeFileSync(path.join(backupProj, 'old.jsonl'), [backupLine('m1', 40), backupLine('m0', 100)].join('\n') + '\n');

  const scan = await scanClaude({ claudeDir, backupDirs: [backupDir], dataDir });
  assert.equal(scan.found, true);
  assert.equal(scan.events.length, 3, 'm0, m1, and m2 counted once each');
  const totalOutput = scan.events.reduce((s, e) => s + e.output, 0);
  assert.equal(totalOutput, 40 + 60 + 100);
});

test('Ollama server logs and secondary drive model manifests are auto-discovered, parsed and deduplicated', async () => {
  const profile = profileRoot('ollama-server-logs');
  const fakeDrive = path.join(profile, 'DriveD');
  const modelsDir = path.join(fakeDrive, 'OllamaModels');
  const manifestDir = path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3-coder');
  const logDir = path.join(fakeDrive, 'Ollama', 'logs');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const digest = 'sha256:d214b44b2401b1a933c43db24f086cff2472106b496df08346a4f4a541df4b4f';
  const blobName = digest.replace(':', '-');
  fs.writeFileSync(
    path.join(manifestDir, '30b'),
    JSON.stringify({
      layers: [{ mediaType: 'application/vnd.ollama.image.model', digest }],
    }),
  );

  const logContent = [
    `time=2026-10-24T15:24:01.395-07:00 level=INFO source=server.go:107 msg="using llama-server for model" model=D:\\OllamaModels\\blobs\\${blobName}`,
    'slot print_timing: id  0 | task 0 | prompt eval time =   1200.50 ms /   400 tokens (    3.00 ms per token,   333.19 tokens per second)',
    'slot print_timing: id  0 | task 0 |        eval time =   2400.25 ms /   120 tokens (   20.00 ms per token,    50.00 tokens per second)',
    '[GIN] 2026/10/24 - 15:24:05 | 200 |            4s |       127.0.0.1 | POST     "/api/chat"',
  ].join('\n');
  fs.writeFileSync(path.join(logDir, 'server.log'), logContent + '\n');
  fs.writeFileSync(path.join(logDir, 'server-1.log'), logContent + '\n');

  const savedDrives = process.env.AERUS_DRIVES;
  const savedLocalAppData = process.env.LOCALAPPDATA;
  const savedOllamaModels = process.env.OLLAMA_MODELS;
  process.env.AERUS_DRIVES = fakeDrive;
  process.env.LOCALAPPDATA = path.join(profile, 'empty-localappdata');
  delete process.env.OLLAMA_MODELS;
  delete process.env.AERUS_OLLAMA_MODELS_DIR;
  delete process.env.AERUS_OLLAMA_LOG_DIR;
  process.env.CODEX_HOME = path.join(profile, 'empty-codex');
  delete process.env.AERU_OLLAMA_CAPTURE_DIR;
  try {
    ollamaCase += 1;
    const mod = await import(`../src/local-ollama.js?case=${ollamaCase}`);
    const usage = await mod.readLocalOllamaUsage();
    assert.equal(usage.available, true);
    assert.equal(usage.responses, 1);
    assert.equal(usage.inputTokens, 400);
    assert.equal(usage.outputTokens, 120);
    assert.equal(usage.totalTokens, 520);
    assert.equal(usage.models[0].name, 'qwen3-coder:30b');
  } finally {
    if (savedDrives === undefined) delete process.env.AERUS_DRIVES;
    else process.env.AERUS_DRIVES = savedDrives;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
    if (savedOllamaModels === undefined) delete process.env.OLLAMA_MODELS;
    else process.env.OLLAMA_MODELS = savedOllamaModels;
    delete process.env.CODEX_HOME;
  }
});
