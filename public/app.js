// Aerus AI Usage HUD. Fetches /api/usage and draws the dashboard. Nothing here is sent anywhere else.
const state = {
  range: 'today',
  offset: 0,
  data: null,
  showAll: false,
  breakdownMode: 'models', // 'models' | 'projects'
  filter: null, // { type: 'provider' | 'model' | 'project', provider?: string, value: string }
  search: '',
  miniHud: false,
  requestId: 0,
  lastLoad: 0,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const RING_RADIUS = 80;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const PROVIDERS = ['codex', 'claude', 'ollama'];
const PROVIDER_META = {
  codex: { letter: 'C', label: 'Codex' },
  claude: { letter: 'A', label: 'Claude' },
  ollama: { letter: 'O', label: 'Ollama' },
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const n = (value) => Math.round(Number(value) || 0).toLocaleString('en-US');

function compact(value) {
  const v = Number(value) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

const money = (value) =>
  `$${(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortId = (id) => (id && id.length > 12 ? id.slice(0, 8) : id || '');

function stamp(ms) {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDurationMs(ms) {
  const sec = Math.round((Number(ms) || 0) / 1000);
  if (sec <= 0) return '';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatBytesGb(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '';
  return `${(b / (1024 ** 3)).toFixed(1)} GB`;
}

function setText(selector, value, root = document) {
  const el = $(selector, root);
  if (el) el.textContent = value;
}

// Date / range controls ----------------------------------------------------

function syncControls() {
  $$('.seg button').forEach((button) => {
    const active = button.dataset.range === state.range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('.mini-tab').forEach((tab) => {
    const active = tab.dataset.breakdown === state.breakdownMode;
    tab.classList.toggle('active', active);
  });
  $$('.clickable-card').forEach((card) => {
    const pf = card.dataset.providerFilter || '';
    const active = state.filter?.type === 'provider' && state.filter.value === pf;
    card.classList.toggle('active-filter-card', active);
  });
  const isAll = state.range === 'all';
  $('#prev').disabled = isAll;
  $('#next').disabled = isAll || state.offset >= 0;
  $('#toggle-sessions').textContent = state.showAll ? 'Show recent sessions' : 'View all sessions →';
  const miniBtn = $('#toggle-mini');
  if (miniBtn) miniBtn.textContent = state.miniHud ? 'Full HUD' : 'Mini HUD';
}

async function load() {
  const requestId = ++state.requestId;
  setBusy(true);
  try {
    const response = await fetch(`/api/usage?range=${state.range}&offset=${state.offset}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    const data = await response.json();
    if (requestId !== state.requestId) return;
    state.data = data;
    state.lastLoad = Date.now();
    render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    showBanner([`Could not read local usage: ${error.message}. Keep this window open and try Refresh.`]);
    $('#chip-scan .dot').className = 'dot bad';
  } finally {
    if (requestId === state.requestId) setBusy(false);
  }
}

function setBusy(busy) {
  $('#refresh').disabled = busy;
  $('#refresh').textContent = busy ? 'Scanning…' : 'Refresh';
  $('.hud').classList.toggle('loading', busy && !state.data);
}

// Rendering ----------------------------------------------------------------

function render() {
  const d = state.data;
  if (!d) return;
  $('#chip-scan .dot').className = 'dot ok';
  setText('#chip-updated', `Updated ${new Date(d.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
  setText('#range-label', d.label);
  syncControls();
  showBanner(d.warnings || []);
  renderKpis(d);
  renderDonut(d);
  renderChart(d);
  renderCost(d);
  renderSessions(d);
  renderBreakdown(d);
  setText('#foot-sources', footerText(d));
}

// Each provider keeps its colour family. Models/projects within a provider get different shades so bars stay distinct.
const MODEL_PALETTE = {
  codex: ['#2f8cff', '#5aa9ff', '#1f6fd6', '#8cc4ff'],
  claude: ['#ff8a1f', '#ffb35c', '#e0701a', '#ffa54d'],
  ollama: ['#3ddc84', '#7af0a8', '#27b26a', '#5fe3a0'],
  other: ['#5b6f88'],
};

function renderBreakdown(d) {
  const isProjects = state.breakdownMode === 'projects' && d.projects;
  setText('#models-title', isProjects ? 'Top projects' : 'Model proportion');
  setText('#models-subtitle', isProjects ? 'By workspace token usage · click bar to filter' : 'By total token supply · click bar to filter');

  const items = isProjects ? d.projects.projects : d.models.models;
  const total = isProjects ? d.projects.total : d.models.total;
  const count = isProjects ? d.projects.projectCount : d.models.modelCount;
  const list = $('#model-bars');
  const shades = {};

  if (!items.length) {
    list.innerHTML = `<li class="model-empty">No ${isProjects ? 'project' : 'model'} usage in this range.</li>`;
    $('#model-axis').innerHTML = '';
  } else {
    const max = items[0].total;
    list.innerHTML = items
      .map((row) => {
        const palette = MODEL_PALETTE[row.provider] ?? MODEL_PALETTE.other;
        shades[row.provider] = (shades[row.provider] ?? -1) + 1;
        const colour = palette[shades[row.provider] % palette.length];
        const width = max ? (row.total / max) * 100 : 0;
        const name = isProjects ? row.project : row.model;
        const provLabel = row.provider === 'other' ? name : PROVIDER_META[row.provider]?.label ?? '';
        const filterType = isProjects ? 'project' : 'model';
        const isSelected = state.filter?.type === filterType && state.filter.value === name && state.filter.provider === row.provider;

        let extraMeta = '';
        if (!isProjects && row.avgTokensPerSec > 0) {
          extraMeta = ` · ${row.avgTokensPerSec} tok/s`;
        } else if (isProjects && row.sessions > 0) {
          extraMeta = ` · ${row.sessions} sess`;
        }
        const costMeta = row.cost > 0 ? ` · ${money(row.cost)}` : '';
        const title = `${provLabel} · ${name} — ${n(row.total)} tokens (${(row.share * 100).toFixed(1)}%)${extraMeta}${costMeta}`;
        const subBadge = !isProjects && row.avgTokensPerSec > 0
          ? `${(row.share * 100).toFixed(1)}% · ${row.avgTokensPerSec}t/s`
          : isProjects && row.cost > 0
            ? `${(row.share * 100).toFixed(1)}% · ${money(row.cost)}`
            : `${(row.share * 100).toFixed(1)}%`;

        return `<li class="model-row ${esc(row.provider)}${isSelected ? ' selected-row' : ''}" data-filter-type="${filterType}" data-filter-provider="${esc(row.provider)}" data-filter-value="${esc(name)}" title="${esc(title)}">
          <span class="model-name">${esc(name)}</span>
          <span class="model-track"><span class="model-fill" style="width:${width}%;background:linear-gradient(90deg, ${colour}33, ${colour});box-shadow:0 0 10px ${colour}66"></span></span>
          <span class="model-val">${esc(compact(row.total))}<small>${esc(subBadge)}</small></span>
        </li>`;
      })
      .join('');
    $('#model-axis').innerHTML = [0, 0.5, 1]
      .map((f) => `<span style="left:${f * 100}%">${esc(compact(max * f))}</span>`)
      .join('');
  }

  const unattributed = d.unattributed || 0;
  const noun = isProjects ? 'project' : 'model';
  const parts = [`Chart total ${compact(total)} across ${n(count)} ${noun}${count === 1 ? '' : 's'}.`];
  if (unattributed > 0) {
    parts.push(`Account-only Codex usage (${compact(unattributed)}) has no ${noun} identity, so it is not charted. It stays in the Codex total.`);
  }
  setText('#model-note', parts.join(' '));
}

// Writes the five token fields. Cache that a source does not record is shown as unavailable, not as zero.
function fillCard(card, totals, cacheAvailable = true) {
  for (const field of ['total', 'input', 'output', 'cacheRead', 'cacheWrite']) {
    const el = $(`[data-field="${field}"]`, card);
    if (!el) continue;
    const isCache = field === 'cacheRead' || field === 'cacheWrite';
    if (isCache && !cacheAvailable) {
      el.textContent = 'Unavailable';
      el.classList.add('na');
      el.title = 'Ollama captures do not record cache tokens';
    } else {
      el.textContent = n(totals[field]);
      el.classList.remove('na');
      el.removeAttribute('title');
    }
  }
}

// a is the All Time block: { codex: { snapshot }, lookup: { status } }.
function accountStatus(a) {
  const snapshot = a.codex.snapshot;
  if (!snapshot) return ' · No account total yet';
  const checked = new Date(snapshot.checkedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return a.lookup.status === 'live' || a.lookup.status === 'current' ? ` · Account checked ${checked}` : ` · Account snapshot ${checked} (offline)`;
}

function renderKpis(d) {
  fillCard($('#kpi-codex'), d.providers.codex);
  fillCard($('#kpi-grand'), d.totals);
  fillCard($('#kpi-claude'), d.providers.claude);
  fillCard($('#kpi-ollama'), d.providers.ollama, false);

  let codexNote = `${n(d.providers.codex.sessions)} sessions`;
  if (d.providers.codex.cacheHitRate > 0) {
    codexNote += ` · ${(d.providers.codex.cacheHitRate * 100).toFixed(0)}% cache hit`;
  }
  const a = d.allTime;
  if (a) {
    codexNote += ` · Local ${compact(a.codex.localTotal)} · Account-only ${compact(a.codex.accountOnly)}`;
    codexNote += accountStatus(a);
  }
  setText('#codex-note', codexNote);
  setText('#grand-note', 'Codex + Claude + Ollama, each counted once. Cache totals exclude Ollama.');

  let claudeNote = `${n(d.providers.claude.sessions)} sessions`;
  if (d.providers.claude.cacheHitRate > 0) {
    claudeNote += ` · ${(d.providers.claude.cacheHitRate * 100).toFixed(1)}% cache hit`;
  }
  if (d.providers.claude.cacheSavedUsd > 0) {
    claudeNote += ` · ~${money(d.providers.claude.cacheSavedUsd)} saved by cache`;
  }
  setText('#claude-note', claudeNote);

  const ollamaTel = d.efficiency?.ollamaTelemetry;
  const ollamaParts = [];
  if (d.sources.ollama?.found) {
    ollamaParts.push(`${n(d.providers.ollama.sessions)} sessions`);
    if (ollamaTel?.avgTokensPerSec > 0) {
      ollamaParts.push(`${ollamaTel.avgTokensPerSec} tok/s avg (${ollamaTel.peakTokensPerSec} peak)`);
    }
    const computeTime = formatDurationMs((ollamaTel?.totalEvalMs || 0) + (ollamaTel?.totalPromptEvalMs || 0));
    if (computeTime) ollamaParts.push(`${computeTime} GPU eval`);
    const activeModels = ollamaTel?.live?.models || [];
    if (activeModels.length) {
      const m = activeModels[0];
      const vram = formatBytesGb(m.sizeVramBytes || m.sizeBytes);
      const quant = m.quantization ? ` · ${m.quantization}` : '';
      ollamaParts.push(`VRAM: ${m.name}${vram ? ` (${vram}${quant})` : ''}`);
    } else {
      ollamaParts.push('Local / self-hosted');
    }
  } else {
    ollamaParts.push('No Ollama captures found on this computer');
  }
  setText('#ollama-note', ollamaParts.join(' · '));
}

function renderDonut(d) {
  const svg = $('#donut');
  let offset = 0;
  const rings = PROVIDERS.map((p) => {
    const length = d.share[p] * RING_LENGTH;
    const ring = d.totals.total && length > 0
      ? `<circle class="seg-${p}" cx="100" cy="100" r="${RING_RADIUS}" stroke-dasharray="${length} ${RING_LENGTH}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"/>`
      : '';
    offset += length;
    return ring;
  }).join('');
  svg.innerHTML = `
    <circle class="track" cx="100" cy="100" r="${RING_RADIUS}"/>
    ${rings}
    <text class="center-val" x="100" y="103" text-anchor="middle">${esc(compact(d.totals.total))}</text>
    <text class="center-unit" x="100" y="124" text-anchor="middle">tokens</text>`;
  for (const p of PROVIDERS) {
    setText(`[data-share="${p}"]`, `${(d.share[p] * 100).toFixed(1)}% · ${compact(d.providers[p].total)}`);
  }
}

function axisLabel(granularity, key) {
  const d = new Date(key);
  return granularity === 'hour'
    ? d.toLocaleTimeString('en-US', { hour: 'numeric' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderChart(d) {
  const { granularity, labels } = d.series;
  const chart = $('#chart');
  const totals = labels.map((_, i) => PROVIDERS.reduce((sum, p) => sum + d.series[p][i], 0));
  const max = Math.max(1, ...totals);
  const hasData = totals.some((t) => t > 0);

  const yAxis = [max, max / 2, 0].map((v) => `<span>${esc(hasData ? compact(v) : '')}</span>`).join('');
  const columns = labels
    .map((_, i) => {
      const tot = totals[i];
      const height = (tot / max) * 100;
      // Stacked bottom to top: Codex, Claude, Ollama.
      const parts = PROVIDERS.map((p) => {
        const share = tot ? (d.series[p][i] / tot) * 100 : 0;
        return `<i class="c-${p}" style="height:${share}%"></i>`;
      }).join('');
      return `<div class="col" data-i="${i}"><div class="stack" style="height:${height}%">${parts}</div></div>`;
    })
    .join('');

  const every = granularity === 'hour' ? 4 : Math.max(1, Math.ceil(labels.length / 8));
  const ticks = labels
    .map((key, i) => (i % every === 0 ? `<span style="left:${((i + 0.5) / labels.length) * 100}%">${esc(axisLabel(granularity, key))}</span>` : ''))
    .join('');

  chart.innerHTML = `
    <div class="y-axis">${yAxis}</div>
    <div class="plot">${columns}${hasData ? '' : '<div class="chart-empty">No token activity in this range.</div>'}</div>
    <div class="x-axis">${ticks}</div>`;
  chart.dataset.granularity = granularity;
}

function renderCost(d) {
  for (const p of PROVIDERS) setText(`[data-cost="${p}"]`, money(d.providers[p].cost));
  setText('[data-cost="grand"]', money(d.totals.cost));

  const codexCacheSaved = d.providers.codex.cacheSavedUsd || 0;
  setText(
    '[data-cost-tokens="codex"]',
    `~ ${compact(d.providers.codex.total)} tokens${codexCacheSaved > 0.01 ? ` · ${money(codexCacheSaved)} cache saved` : ''}`,
  );

  const claudeCacheSaved = d.providers.claude.cacheSavedUsd || 0;
  setText(
    '[data-cost-tokens="claude"]',
    `~ ${compact(d.providers.claude.total)} tokens${claudeCacheSaved > 0.01 ? ` · ${money(claudeCacheSaved)} cache saved` : ''}`,
  );

  const ollamaEq = d.efficiency?.ollamaCloudEquivalentUsd || 0;
  setText(
    '[data-cost-tokens="ollama"]',
    `${compact(d.providers.ollama.total)} tokens · Local${ollamaEq > 0.01 ? ` (~${money(ollamaEq)} cloud API saved)` : ' / no API cost'}`,
  );

  setText('[data-cost-tokens="grand"]', `~ ${compact(d.totals.total)} tokens`);

  const pill = $('#cache-savings-pill');
  if (pill) {
    const totalSaved = (d.efficiency?.cacheSavedUsd || 0) + ollamaEq;
    if (totalSaved >= 0.01) {
      const hitPct = ((d.efficiency?.cacheHitRate || 0) * 100).toFixed(1);
      pill.textContent = `${hitPct}% cache hit · ~${money(totalSaved)} saved`;
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
  }
}

function getFilteredSessions(d) {
  let list = d?.sessions || [];
  if (state.filter) {
    const { type, provider, value } = state.filter;
    if (type === 'provider' && value) {
      list = list.filter((s) => s.provider === value);
    } else if (type === 'model' && value) {
      list = list.filter((s) => (provider === 'other' ? true : s.provider === provider) && s.model === value);
    } else if (type === 'project' && value) {
      list = list.filter((s) => (provider === 'other' ? true : s.provider === provider) && s.project === value);
    }
  }
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (s) =>
        String(s.project || '').toLowerCase().includes(q) ||
        String(s.model || '').toLowerCase().includes(q) ||
        String(s.sessionId || '').toLowerCase().includes(q) ||
        String(s.provider || '').toLowerCase().includes(q),
    );
  }
  return list;
}

function renderSessions(d) {
  const pill = $('#active-filter');
  if (pill) {
    if (state.filter && state.filter.value) {
      pill.textContent = `${state.filter.type}: ${state.filter.value} ×`;
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
  }

  const filtered = getFilteredSessions(d);
  const rows = filtered.slice(0, state.showAll ? 500 : 8);
  const body = $('#sessions');
  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty-cell" colspan="9">No matching sessions in this range.</td></tr>`;
  } else {
    body.innerHTML = rows
      .map((s, i) => {
        const meta = PROVIDER_META[s.provider];
        const cache = s.cache == null
          ? '<span class="na" title="Ollama captures do not record cache tokens">Unavailable</span>'
          : n(s.cache);
        const speedBadge = s.tokensPerSec > 0 ? `<span class="speed-tag" title="Average generation throughput">${s.tokensPerSec} tok/s</span>` : '';
        return `<tr>
          <td class="num">${i + 1}</td>
          <td><span class="prov ${s.provider}"><span class="badge ${s.provider}-badge">${meta.letter}</span>${meta.label}</span></td>
          <td><span class="sess-name">${esc(s.project)}</span><span class="sess-id">${esc(shortId(s.sessionId))}</span></td>
          <td>${esc(s.model)}${speedBadge}</td>
          <td>${esc(stamp(s.at))}</td>
          <td class="num">${n(s.input)}</td>
          <td class="num">${n(s.output)}</td>
          <td class="num">${cache}</td>
          <td class="num total">${n(s.total)}</td>
        </tr>`;
      })
      .join('');
  }
  const toggle = $('#toggle-sessions');
  toggle.hidden = filtered.length <= 8;
}

function footerText(d) {
  const codex = d.sources.codex?.found ? `${n(d.sources.codex.files)} Codex files` : 'Codex not found';
  const claude = d.sources.claude?.found
    ? `${n(d.sources.claude.files)} Claude files, ${n(d.sources.claude.records)} messages kept`
    : 'Claude Code not found';
  const ollama = d.sources.ollama?.found ? `${n(d.sources.ollama.files)} Ollama sources (${n(d.sources.ollama.records)} generations)` : 'Ollama captures not found';
  return `${codex} · ${claude} · ${ollama}`;
}

function showBanner(messages) {
  const banner = $('#banner');
  if (!messages.length) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = messages.join(' ');
}

// Export helpers -----------------------------------------------------------

function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSessionsCsv() {
  if (!state.data) return;
  const rows = getFilteredSessions(state.data);
  const headers = ['provider', 'project', 'sessionId', 'model', 'timestamp', 'input', 'output', 'cache', 'total', 'costUsd', 'tokensPerSec'];
  const csvCell = (val) => {
    const str = String(val ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      [
        r.provider,
        r.project,
        r.sessionId,
        r.model,
        new Date(r.at).toISOString(),
        r.input,
        r.output,
        r.cache ?? '',
        r.total,
        (Number(r.cost) || 0).toFixed(4),
        r.tokensPerSec || '',
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  downloadBlob(`aerus-usage-${state.range}.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
}

function exportSessionsJson() {
  if (!state.data) return;
  const rows = getFilteredSessions(state.data);
  const payload = {
    exportedAt: new Date().toISOString(),
    range: state.range,
    label: state.data.label,
    filter: state.filter,
    totals: state.data.totals,
    providers: state.data.providers,
    efficiency: state.data.efficiency,
    sessions: rows,
  };
  downloadBlob(`aerus-usage-${state.range}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
}

// Chart tooltip ------------------------------------------------------------

function wireTooltip() {
  const tip = $('#tooltip');
  const chart = $('#chart');
  chart.addEventListener('mouseover', (event) => {
    const col = event.target.closest('.col');
    if (!col || !state.data) {
      tip.hidden = true;
      return;
    }
    const i = Number(col.dataset.i);
    const { granularity, labels } = state.data.series;
    const when = granularity === 'hour'
      ? stamp(labels[i]).replace(/, \d{4}/, '')
      : new Date(labels[i]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const rows = PROVIDERS.map((p) => `<span class="t${p[0]}">${PROVIDER_META[p].label}</span> ${n(state.data.series[p][i])} tokens`).join('<br>');
    const total = PROVIDERS.reduce((sum, p) => sum + state.data.series[p][i], 0);
    tip.innerHTML = `<strong>${esc(when)}</strong>${rows}<br>Total ${n(total)} tokens`;
    tip.hidden = false;
  });
  chart.addEventListener('mousemove', (event) => {
    const pad = 14;
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.min(event.clientX + pad, window.innerWidth - width - 8);
    const top = Math.min(event.clientY + pad, window.innerHeight - height - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  });
  chart.addEventListener('mouseleave', () => {
    tip.hidden = true;
  });
}

// Live SSE stream ----------------------------------------------------------

function connectLiveStream() {
  if (typeof EventSource === 'undefined') return;
  try {
    const es = new EventSource('/api/stream');
    es.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'connected') {
          setText('#chip-scan-label', 'Live local stream');
        } else if (msg.type === 'refresh') {
          load();
        }
      } catch {}
    });
    es.addEventListener('error', () => {
      setText('#chip-scan-label', 'Live local scan');
    });
  } catch {}
}

function toggleMiniHud(forceState) {
  state.miniHud = typeof forceState === 'boolean' ? forceState : !state.miniHud;
  document.body.classList.toggle('mini-hud', state.miniHud);
  syncControls();
  try {
    window.chrome?.webview?.postMessage(JSON.stringify({ type: 'mini-hud', enabled: state.miniHud }));
  } catch {}
}

window.setAerusMiniHud = (enabled) => toggleMiniHud(Boolean(enabled));

// Wiring -------------------------------------------------------------------

function wire() {
  $$('.seg button').forEach((button) =>
    button.addEventListener('click', () => {
      if (state.range === button.dataset.range) return;
      state.range = button.dataset.range;
      state.offset = 0;
      syncControls();
      load();
    }),
  );
  $$('.mini-tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      state.breakdownMode = tab.dataset.breakdown;
      syncControls();
      if (state.data) renderBreakdown(state.data);
    }),
  );
  $$('.clickable-card').forEach((card) =>
    card.addEventListener('click', () => {
      const pf = card.dataset.providerFilter || '';
      if (!pf || (state.filter?.type === 'provider' && state.filter.value === pf)) {
        state.filter = null;
      } else {
        state.filter = { type: 'provider', value: pf };
      }
      syncControls();
      if (state.data) {
        renderBreakdown(state.data);
        renderSessions(state.data);
      }
    }),
  );
  $('#model-bars').addEventListener('click', (event) => {
    const row = event.target.closest('.model-row');
    if (!row || !row.dataset.filterValue) return;
    const type = row.dataset.filterType || 'model';
    const provider = row.dataset.filterProvider || '';
    const value = row.dataset.filterValue;
    if (value.startsWith('Other (')) return;
    if (state.filter?.type === type && state.filter.value === value && state.filter.provider === provider) {
      state.filter = null;
    } else {
      state.filter = { type, provider, value };
    }
    syncControls();
    if (state.data) {
      renderBreakdown(state.data);
      renderSessions(state.data);
    }
  });
  $('#active-filter')?.addEventListener('click', () => {
    state.filter = null;
    syncControls();
    if (state.data) {
      renderBreakdown(state.data);
      renderSessions(state.data);
    }
  });
  $('#session-search')?.addEventListener('input', (event) => {
    state.search = event.target.value || '';
    if (state.data) renderSessions(state.data);
  });
  $('#export-csv')?.addEventListener('click', exportSessionsCsv);
  $('#export-json')?.addEventListener('click', exportSessionsJson);
  $('#toggle-mini')?.addEventListener('click', () => toggleMiniHud());
  $('#prev').addEventListener('click', () => {
    state.offset -= 1;
    load();
  });
  $('#next').addEventListener('click', () => {
    if (state.offset >= 0) return;
    state.offset += 1;
    load();
  });
  $('#refresh').addEventListener('click', () => load());
  $('#toggle-sessions').addEventListener('click', () => {
    state.showAll = !state.showAll;
    if (state.data) renderSessions(state.data);
    syncControls();
  });
  wireTooltip();
  connectLiveStream();

  // Refresh when the window comes back into view, and once a minute while it stays open.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.lastLoad > 30_000) load();
  });
  setInterval(() => {
    if (!document.hidden) load();
  }, 60_000);
}

wire();
syncControls();
load();
