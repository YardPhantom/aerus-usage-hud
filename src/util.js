import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Accepts epoch seconds, epoch milliseconds, or an ISO string. Returns epoch ms or null.
export function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

export function normalizeModel(name) {
  return String(name || 'unknown')
    .trim()
    .replace(/^openai\//i, '');
}

export function projectFromCwd(cwd, root) {
  if (!cwd || typeof cwd !== 'string') return 'Unattributed';
  let decoded = cwd;
  try {
    decoded = decodeURIComponent(cwd);
  } catch {
    decoded = cwd;
  }
  const normalized = path.normalize(decoded);
  if (root && normalized.toLowerCase().startsWith(path.normalize(root).toLowerCase())) return 'Workspace';
  const base = path.basename(normalized);
  if (!base || base === '.' || base === path.parse(normalized).root) return 'Unattributed';
  return base;
}

export async function isDirectory(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function listJsonl(dir, depth = 0) {
  const found = [];
  if (depth > 8) return found;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listJsonl(full, depth + 1)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) found.push(full);
  }
  return found;
}

// Discovers mounted drive roots (Windows C:\..Z:\ or custom AERUS_DRIVES) for secondary storage scanning.
export function listAvailableDrives() {
  const custom = process.env.AERUS_DRIVES;
  if (custom === 'off' || custom === '0') return [];
  if (custom) {
    return custom
      .split(path.delimiter)
      .map((d) => d.trim())
      .filter(Boolean);
  }
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        drives.push(root);
      }
    } catch {
      // Unready or inaccessible drive letter.
    }
  }
  return drives;
}
