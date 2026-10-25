// Auto-discovers and tails usage and session activity across other AI coding applications:
// Antigravity, Kiro, Cursor, Freebuff, OpenCode, and Grok Bot.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listAvailableDrives } from './util.js';

export const OTHER_APP_META = {
  antigravity: { name: 'Antigravity', tag: 'AG', color: '#a855f7', desc: 'Google Antigravity AI agentic coding workspace' },
  kiro: { name: 'Kiro', tag: 'KI', color: '#10b981', desc: 'Kiro agentic coding assistant & crew' },
  cursor: { name: 'Cursor', tag: 'CU', color: '#0ea5e9', desc: 'Cursor AI code editor & composer' },
  freebuff: { name: 'Freebuff', tag: 'FB', color: '#f59e0b', desc: 'Freebuff desktop AI coding orchestrator' },
  opencode: { name: 'OpenCode', tag: 'OC', color: '#14b8a6', desc: 'OpenCode AI development desktop' },
  grokbot: { name: 'Grok Bot', tag: 'GK', color: '#ec4899', desc: 'Grok Bot local execution & coding assistant' },
};

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// 1. Antigravity Scanner -----------------------------------------------------
export function scanAntigravity(customRoot) {
  const home = os.homedir();
  const candidates = customRoot
    ? [customRoot]
    : [
        path.join(home, '.gemini', 'antigravity', 'brain'),
        ...listAvailableDrives().map((d) => path.join(d, '.gemini', 'antigravity', 'brain')),
      ];

  const events = [];
  const roots = [];

  for (const brainDir of candidates) {
    if (!fs.existsSync(brainDir) || roots.includes(brainDir)) continue;
    roots.push(brainDir);

    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const convId = ent.name;
      const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;

      try {
        const stat = fs.statSync(transcriptPath);
        const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
        let inpChars = 0;
        let outChars = 0;
        let turnCount = 0;
        let lastAt = stat.mtimeMs;
        let project = 'Workspace';
        let detectedModel = 'Gemini 2.5 / 3.8';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const step = JSON.parse(line);
            if (step.created_at) {
              const t = Date.parse(step.created_at);
              if (!Number.isNaN(t)) lastAt = t;
            }
            const len = typeof step.content === 'string' ? step.content.length : 0;
            if (step.source === 'USER_INPUT' || step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT') {
              inpChars += len;
              turnCount++;
            } else if (step.source === 'MODEL' || step.type === 'PLANNER_RESPONSE') {
              outChars += len;
              if (step.thinking && typeof step.thinking === 'string') outChars += step.thinking.length;
            }

            // Extract project path from file URIs if present
            if (project === 'Workspace' && typeof step.content === 'string') {
              const m = step.content.match(/file:\/\/\/([a-zA-Z]:\/[^/\r\n]+(?:\/[^/\r\n]+)?)/);
              if (m) {
                const parts = m[1].replace(/\\/g, '/').split('/');
                project = parts.slice(parts.length > 2 ? -2 : -1).join('/');
              }
            }
          } catch {}
        }

        const inputTokens = Math.max(1, Math.round(inpChars / 4));
        const outputTokens = Math.max(1, Math.round(outChars / 4));
        const total = inputTokens + outputTokens;

        events.push({
          provider: 'antigravity',
          app: 'Antigravity',
          at: lastAt,
          sessionId: convId,
          project: project === 'Workspace' ? `Brain ${convId.slice(0, 8)}` : project,
          model: detectedModel,
          input: inputTokens,
          output: outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          cacheKnown: false,
          turnCount: Math.max(1, turnCount),
          total,
          cost: 0,
        });
      } catch {}
    }
  }

  return {
    app: 'antigravity',
    found: events.length > 0,
    sessions: events.length,
    events,
  };
}

// 2. Kiro Scanner ------------------------------------------------------------
export function scanKiro(customRoot) {
  const home = os.homedir();
  const candidates = customRoot
    ? [customRoot]
    : [
        path.join(home, '.kiro', 'sessions'),
        ...listAvailableDrives().map((d) => path.join(d, '.kiro', 'sessions')),
      ];

  const events = [];
  const roots = [];

  for (const rootDir of candidates) {
    if (!fs.existsSync(rootDir) || roots.includes(rootDir)) continue;
    roots.push(rootDir);

    let workspaces = [];
    try {
      workspaces = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const wsPath = path.join(rootDir, ws.name);
      let sessionDirs = [];
      try {
        sessionDirs = fs.readdirSync(wsPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const s of sessionDirs) {
        if (!s.isDirectory() || (!s.name.startsWith('sess_') && !s.name.startsWith('session'))) continue;
        const sPath = path.join(wsPath, s.name);
        const meta = safeReadJson(path.join(sPath, 'session.json'));
        const messagesPath = path.join(sPath, 'messages.jsonl');
        if (!meta && !fs.existsSync(messagesPath)) continue;

        let turnCount = 0;
        let charCount = 0;
        let at = meta?.createdAt ? Date.parse(meta.createdAt) : Date.now();
        if (meta?.lastModifiedAt) {
          const t = Date.parse(meta.lastModifiedAt);
          if (!Number.isNaN(t)) at = t;
        }

        if (fs.existsSync(messagesPath)) {
          try {
            const stat = fs.statSync(messagesPath);
            charCount = stat.size;
            const lines = fs.readFileSync(messagesPath, 'utf8').split('\n');
            turnCount = lines.filter((l) => l.trim().length > 0).length;
          } catch {}
        }

        const project =
          meta?.workspacePaths?.[0]
            ? path.basename(meta.workspacePaths[0])
            : meta?.workspace
              ? path.basename(meta.workspace)
              : meta?.title
                ? meta.title
                : ws.name.slice(0, 8);
        const model = meta?.modelId || meta?.model || 'qwen3-coder-next';
        const total = Math.max(100, Math.round(charCount / 4));
        const inp = Math.round(total * 0.7);
        const out = total - inp;

        events.push({
          provider: 'kiro',
          app: 'Kiro',
          at,
          sessionId: meta?.id || s.name,
          project,
          model,
          input: inp,
          output: out,
          cacheRead: 0,
          cacheWrite: 0,
          cacheKnown: false,
          turnCount: Math.max(1, turnCount),
          total,
          cost: 0,
        });
      }
    }
  }

  return {
    app: 'kiro',
    found: events.length > 0,
    sessions: events.length,
    events,
  };
}

// 3. Cursor Scanner ----------------------------------------------------------
export function scanCursor() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const storageDir = path.join(appData, 'Cursor', 'User', 'workspaceStorage');
  const events = [];

  if (fs.existsSync(storageDir)) {
    let wsList = [];
    try {
      wsList = fs.readdirSync(storageDir, { withFileTypes: true });
    } catch {}

    for (const ws of wsList) {
      if (!ws.isDirectory()) continue;
      const wsFile = path.join(storageDir, ws.name, 'workspace.json');
      const vscdb = path.join(storageDir, ws.name, 'state.vscdb');
      const json = safeReadJson(wsFile);
      if (!json && !fs.existsSync(vscdb)) continue;

      let at = Date.now();
      let sizeBytes = 0;
      try {
        if (fs.existsSync(vscdb)) {
          const st = fs.statSync(vscdb);
          at = st.mtimeMs;
          sizeBytes = st.size;
        } else if (fs.existsSync(wsFile)) {
          at = fs.statSync(wsFile).mtimeMs;
        }
      } catch {}

      const rawFolder = json?.folder || '';
      let project = 'Workspace';
      if (rawFolder) {
        try {
          const decoded = decodeURIComponent(rawFolder.replace(/^file:\/\/\/?/, ''));
          project = path.basename(decoded) || decoded;
        } catch {
          project = path.basename(rawFolder);
        }
      }

      const total = Math.max(250, Math.round(sizeBytes / 32));
      const inp = Math.round(total * 0.65);
      const out = total - inp;

      events.push({
        provider: 'cursor',
        app: 'Cursor',
        at,
        sessionId: ws.name.slice(0, 8),
        project: project || ws.name.slice(0, 8),
        model: 'Cursor Composer / Tab',
        input: inp,
        output: out,
        cacheRead: 0,
        cacheWrite: 0,
        cacheKnown: false,
        turnCount: 1,
        total,
        cost: 0,
      });
    }
  }

  return {
    app: 'cursor',
    found: events.length > 0,
    sessions: events.length,
    events,
  };
}

// 4. Freebuff Scanner --------------------------------------------------------
export function scanFreebuff() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const logFile = path.join(appData, 'Freebuff', 'logs', 'orchestrator-stderr.log');
  const events = [];

  if (fs.existsSync(logFile)) {
    try {
      const text = fs.readFileSync(logFile, 'utf8');
      const stat = fs.statSync(logFile);
      const sessions = text.split(/Starting Freebuff orchestrator/);
      let sessionIdx = 0;

      for (const block of sessions) {
        if (!block.trim()) continue;
        sessionIdx++;
        let at = stat.mtimeMs;
        const timeMatch = block.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]/);
        if (timeMatch) {
          const parsed = Date.parse(timeMatch[1]);
          if (!Number.isNaN(parsed)) at = parsed;
        }

        let model = 'Freebuff Assistant';
        const modelMatch = block.match(/model:\s*"([^"]+)"/);
        if (modelMatch) {
          model = modelMatch[1].split('.')[0] || 'Freebuff AI';
        }

        const lines = block.split('\n').length;
        const total = Math.max(500, lines * 45);
        const inp = Math.round(total * 0.7);
        const out = total - inp;

        events.push({
          provider: 'freebuff',
          app: 'Freebuff',
          at,
          sessionId: `fb-${sessionIdx}`,
          project: 'Freebuff Desktop',
          model,
          input: inp,
          output: out,
          cacheRead: 0,
          cacheWrite: 0,
          cacheKnown: false,
          turnCount: Math.max(1, Math.round(lines / 20)),
          total,
          cost: 0,
        });
      }
    } catch {}
  }

  return {
    app: 'freebuff',
    found: events.length > 0,
    sessions: events.length,
    events,
  };
}

// 5. OpenCode Scanner --------------------------------------------------------
export function scanOpenCode() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const ocDir = path.join(appData, 'ai.opencode.desktop');
  const events = [];

  if (fs.existsSync(ocDir)) {
    try {
      const files = fs.readdirSync(ocDir);
      for (const f of files) {
        if (!f.startsWith('opencode.workspace.')) continue;
        const fPath = path.join(ocDir, f);
        const stat = fs.statSync(fPath);
        // e.g. opencode.workspace.D--Pippa.1vqyw2i.dat -> Pippa
        const namePart = f.replace(/^opencode\.workspace\./, '').replace(/\.[^.]+$/, '');
        let project = namePart;
        if (namePart.includes('--')) {
          const segments = namePart.split('--');
          project = segments[segments.length - 1];
        }

        const total = Math.max(200, stat.size * 2);
        const inp = Math.round(total * 0.75);
        const out = total - inp;

        events.push({
          provider: 'opencode',
          app: 'OpenCode',
          at: stat.mtimeMs,
          sessionId: f.slice(-10, -4) || f.slice(0, 8),
          project: project || 'OpenCode Workspace',
          model: 'OpenCode Assistant',
          input: inp,
          output: out,
          cacheRead: 0,
          cacheWrite: 0,
          cacheKnown: false,
          turnCount: 1,
          total,
          cost: 0,
        });
      }
    } catch {}
  }

  return {
    app: 'opencode',
    found: events.length > 0,
    sessions: events.length,
    events,
  };
}

// 6. Grok Bot Scanner --------------------------------------------------------
export function scanGrokBot() {
  const home = os.homedir();
  const grokDir = path.join(home, '.grokbot');
  const events = [];

  if (fs.existsSync(grokDir)) {
    try {
      const files = fs.readdirSync(grokDir);
      for (const f of files) {
        if (!f.startsWith('local-exec-daemon') || !f.endsWith('.json')) continue;
        const fPath = path.join(grokDir, f);
        const stat = fs.statSync(fPath);
        const json = safeReadJson(fPath);

        events.push({
          provider: 'grokbot',
          app: 'Grok Bot',
          at: stat.mtimeMs,
          sessionId: f.slice(0, 16),
          project: 'Grok Assistant',
          model: json?.model || 'Grok Code',
          input: 1200,
          output: 800,
          cacheRead: 0,
          cacheWrite: 0,
          cacheKnown: false,
          turnCount: 1,
          total: 2000,
          cost: 0,
        });
      }
    } catch {}
  }

  return {
    app: 'grokbot',
    found: events.length > 0,
    sessions: events.length,
    events,
  };
}

// Aggregates all ecosystem apps
export function scanEcosystemApps(opts = {}) {
  const apps = [
    scanAntigravity(opts.antigravityRoot),
    scanKiro(opts.kiroRoot),
    scanCursor(),
    scanFreebuff(),
    scanOpenCode(),
    scanGrokBot(),
  ];

  const allEvents = [];
  const summary = {};

  for (const app of apps) {
    summary[app.app] = {
      found: app.found,
      sessions: app.sessions,
      meta: OTHER_APP_META[app.app],
    };
    if (app.found) allEvents.push(...app.events);
  }

  return {
    events: allEvents,
    summary,
    totalSessions: allEvents.length,
    discoveredCount: Object.values(summary).filter((s) => s.found).length,
  };
}
