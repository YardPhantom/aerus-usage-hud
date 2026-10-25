import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  scanAntigravity,
  scanKiro,
  scanCursor,
  scanFreebuff,
  scanOpenCode,
  scanGrokBot,
  scanEcosystemApps,
  OTHER_APP_META,
} from '../src/ecosystem.js';
import { appBreakdown } from '../src/models.js';
import { buildView } from '../src/aggregate.js';

test('OTHER_APP_META contains all 6 ecosystem apps with tags and descriptions', () => {
  const apps = ['antigravity', 'kiro', 'cursor', 'freebuff', 'opencode', 'grokbot'];
  for (const app of apps) {
    assert.ok(OTHER_APP_META[app], `Missing metadata for ${app}`);
    assert.ok(OTHER_APP_META[app].name, `Missing name for ${app}`);
    assert.ok(OTHER_APP_META[app].tag, `Missing tag for ${app}`);
    assert.ok(OTHER_APP_META[app].color, `Missing color for ${app}`);
  }
});

test('scanAntigravity parses conversation transcripts and extracts session metrics', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerus-antigravity-'));
  try {
    const convDir = path.join(tmp, 'test-conv-123', '.system_generated', 'logs');
    await fsp.mkdir(convDir, { recursive: true });

    const transcriptLines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_INPUT',
        created_at: new Date(Date.now() - 3600_000).toISOString(),
        content: 'Please inspect file:///d:/projects/Aerus/server.js and fix the bug',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        created_at: new Date(Date.now() - 3500_000).toISOString(),
        content: 'I have analyzed the file and resolved the issue.',
        thinking: 'Checking requirements and file bounds',
      }),
    ];
    await fsp.writeFile(path.join(convDir, 'transcript.jsonl'), transcriptLines.join('\n'));

    const result = scanAntigravity(tmp);
    assert.equal(result.found, true);
    assert.equal(result.sessions, 1);
    assert.equal(result.events.length, 1);
    const ev = result.events[0];
    assert.equal(ev.provider, 'antigravity');
    assert.equal(ev.sessionId, 'test-conv-123');
    assert.equal(ev.project, 'projects/Aerus');
    assert.ok(ev.total > 0);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('scanKiro parses session metadata and message events', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerus-kiro-'));
  try {
    const sessDir = path.join(tmp, 'workspace-alpha', 'session-456');
    await fsp.mkdir(sessDir, { recursive: true });

    await fsp.writeFile(
      path.join(sessDir, 'session.json'),
      JSON.stringify({
        id: 'session-456',
        model: 'Claude 3.7 Sonnet',
        workspace: 'd:\\repos\\MyProject',
        createdAt: new Date().toISOString(),
      }),
    );

    const msgs = [
      JSON.stringify({ role: 'user', content: 'Hello Kiro' }),
      JSON.stringify({ role: 'assistant', content: 'Hello! How can I help you today?' }),
    ];
    await fsp.writeFile(path.join(sessDir, 'messages.jsonl'), msgs.join('\n'));

    const result = scanKiro(tmp);
    assert.equal(result.found, true);
    assert.equal(result.sessions, 1);
    assert.equal(result.events.length, 1);
    const ev = result.events[0];
    assert.equal(ev.provider, 'kiro');
    assert.equal(ev.model, 'Claude 3.7 Sonnet');
    assert.equal(ev.project, 'MyProject');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('appBreakdown ranks ecosystem apps by token count and calculates shares', () => {
  const events = [
    { provider: 'codex', app: 'Codex', total: 50_000, cost: 0.2 },
    { provider: 'antigravity', app: 'Antigravity', total: 30_000, cost: 0 },
    { provider: 'kiro', app: 'Kiro', total: 20_000, cost: 0 },
  ];

  const res = appBreakdown(events);
  assert.equal(res.appCount, 3);
  assert.equal(res.total, 100_000);
  assert.equal(res.apps[0].provider, 'codex');
  assert.equal(res.apps[0].total, 50_000);
  assert.equal(res.apps[0].share, 0.5);
  assert.equal(res.apps[1].provider, 'antigravity');
  assert.equal(res.apps[1].share, 0.3);
  assert.equal(res.apps[2].provider, 'kiro');
  assert.equal(res.apps[2].share, 0.2);
});

test('buildView includes ecosystem apps in breakdown, sessions and summary while preserving top KPIs', () => {
  const now = Date.now();
  const events = [
    {
      provider: 'codex',
      app: 'Codex',
      at: now - 1000,
      sessionId: 'cx-1',
      project: 'Aerus',
      model: 'gpt-4o',
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 0,
      total: 1500,
      cost: 0.01,
      cacheKnown: true,
    },
    {
      provider: 'antigravity',
      app: 'Antigravity',
      at: now - 500,
      sessionId: 'ag-conv-99',
      project: 'Aerus',
      model: 'Gemini 2.5',
      input: 2000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      total: 3000,
      cost: 0,
      cacheKnown: false,
    },
  ];

  const view = buildView({
    events,
    range: 'today',
    offset: 0,
    now,
    ecosystem: {
      antigravity: { found: true, sessions: 1, meta: OTHER_APP_META.antigravity },
    },
  });

  // Top KPI remains the primary 3 providers (Codex only in this event set)
  assert.equal(view.totals.total, 1500);
  assert.equal(view.providers.codex.total, 1500);

  // Breakdown includes apps
  assert.ok(view.apps);
  assert.equal(view.apps.appCount, 2);
  assert.equal(view.apps.apps[0].provider, 'antigravity');
  assert.equal(view.apps.apps[0].total, 3000);

  // Recent sessions includes the Antigravity session
  assert.equal(view.sessions.length, 2);
  const agSess = view.sessions.find((s) => s.provider === 'antigravity');
  assert.ok(agSess);
  assert.equal(agSess.sessionId, 'ag-conv-99');

  // Ecosystem summary is attached
  assert.ok(view.ecosystem);
  assert.equal(view.ecosystem.antigravity.found, true);
});
