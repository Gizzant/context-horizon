/**
 * Sprint 2.2 — `/cost-radar` HTML/SVG timeline artifact.
 *
 * Pure, zero-dependency renderer (no `node:*` imports) so it can be shared with the
 * Claude Code edition and embedded into Antigravity Studio as an Artifact.
 *
 * Panels (dark, Tufte-style high data-ink, tabular figures):
 *   1. Prefix-Cache Retention step chart per turn, bust markers + savings callout.
 *   2. Thinking vs. Generation drift sparkline + TTFT strip, DET-30 loop turns highlighted.
 *   3. Swarm / worktree topology graph (coordinator -> workers, worktrees, DET-20 overlaps).
 *
 * Unmeasured inputs render an explicit "no data" note — never fabricated values.
 */

export const COST_RADAR_DIMENSIONS = Object.freeze({
  WIDTH: 640,
  CHART_HEIGHT: 120,
  PAD_LEFT: 36,
  PAD_RIGHT: 12,
  PAD_TOP: 14,
  PAD_BOTTOM: 18
});

const COLORS = Object.freeze({
  bg: '#0b1020',
  fg: '#cbd5e1',
  muted: '#64748b',
  grid: '#1e293b',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  accent: '#60a5fa',
  think: '#a78bfa'
});

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtUsd(n) {
  const v = Number(n) || 0;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function emptyPanel(message, height = 40) {
  const { WIDTH } = COST_RADAR_DIMENSIONS;
  return `<svg class="cr-svg" viewBox="0 0 ${WIDTH} ${height}" width="100%" role="img" aria-label="${escapeXml(message)}">` +
    `<text x="${WIDTH / 2}" y="${height / 2 + 4}" text-anchor="middle" fill="${COLORS.muted}" font-size="11">${escapeXml(message)}</text></svg>`;
}

/**
 * Panel 1: retention step chart. `retention.series` = [{ pct, bust, cause, ttlExpired, savedUSD }].
 */
export function renderRetentionStepChart(retention) {
  const series = Array.isArray(retention?.series) ? retention.series : [];
  if (!retention?.measured || series.length === 0) {
    return emptyPanel('Prefix retention: no multi-turn cache usage measured yet');
  }
  const { WIDTH, CHART_HEIGHT: H, PAD_LEFT: L, PAD_RIGHT: R, PAD_TOP: T, PAD_BOTTOM: B } = COST_RADAR_DIMENSIONS;
  const innerW = WIDTH - L - R;
  const innerH = H - T - B;
  const n = series.length;
  const step = innerW / Math.max(1, n);
  const y = (pct) => T + innerH - (Math.max(0, Math.min(100, pct)) / 100) * innerH;

  let d = '';
  let lastY = y(0);
  const marks = [];
  series.forEach((pt, i) => {
    const x0 = L + i * step;
    const x1 = x0 + step;
    if (pt.ttlExpired || pt.pct === null || pt.pct === undefined) {
      marks.push(`<rect x="${x0.toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${innerH}" fill="${COLORS.grid}" opacity="0.6"><title>Turn ${i + 1}: TTL expired while idle (excluded)</title></rect>`);
      return;
    }
    const yy = y(pt.pct);
    d += d ? ` L${x0.toFixed(1)},${lastY.toFixed(1)} L${x0.toFixed(1)},${yy.toFixed(1)}` : `M${x0.toFixed(1)},${yy.toFixed(1)}`;
    d += ` L${x1.toFixed(1)},${yy.toFixed(1)}`;
    lastY = yy;
    if (pt.bust) {
      const cx = x0 + step / 2;
      marks.push(`<path d="M${cx.toFixed(1)},${(yy - 7).toFixed(1)} l4,7 l-8,0 z" fill="${COLORS.bad}"><title>Turn ${i + 1}: prefix bust (${escapeXml(String(pt.cause || 'unknown').replace(/_/g, ' '))}) — ${pt.pct}% retained</title></path>`);
    }
  });

  const grid = [0, 50, 90, 100].map((p) =>
    `<line x1="${L}" x2="${WIDTH - R}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" stroke="${COLORS.grid}" stroke-width="${p === 90 ? 1 : 0.5}"${p === 90 ? ' stroke-dasharray="3,3"' : ''}/>` +
    `<text x="${L - 4}" y="${(y(p) + 3).toFixed(1)}" text-anchor="end" fill="${COLORS.muted}" font-size="9">${p}%</text>`
  ).join('');

  const pct = retention.retentionIndexPct;
  const color = retention.grade === 'A' ? COLORS.good : retention.grade === 'B' ? COLORS.warn : COLORS.bad;
  const callout = `<text x="${WIDTH - R}" y="${T - 3}" text-anchor="end" fill="${color}" font-size="10">` +
    `${escapeXml(`${pct}% retained · saved ${fmtUsd(retention.retainedDiscountSavingsUSD)} · leaked ${fmtUsd(retention.leakedColdPrefillUSD)}`)}</text>`;

  return `<svg class="cr-svg" viewBox="0 0 ${WIDTH} ${H}" width="100%" role="img" aria-label="Prefix-cache retention per turn">` +
    grid + marks.join('') +
    (d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>` : '') +
    callout +
    `<text x="${L}" y="${H - 4}" fill="${COLORS.muted}" font-size="9">turns 2+ (${retention.measuredTurns} measured, ${retention.bustCount} bust${retention.bustCount === 1 ? '' : 's'}, ${retention.ttlExpiredTurns} TTL-expired)</text>` +
    `</svg>`;
}

/**
 * Panel 2: drift sparkline (thinking:output ratio per turn) + TTFT strip.
 */
export function renderDriftSparkline(drift) {
  const turns = Array.isArray(drift?.turns) ? drift.turns : [];
  if (!drift?.measured || turns.length === 0) {
    return emptyPanel('Thinking drift: no reported reasoning tokens yet');
  }
  const { WIDTH, PAD_LEFT: L, PAD_RIGHT: R } = COST_RADAR_DIMENSIONS;
  const H = 96;
  const sparkTop = 14;
  const sparkH = 44;
  const stripTop = sparkTop + sparkH + 12;
  const stripH = 12;
  const innerW = WIDTH - L - R;
  const n = turns.length;
  const step = innerW / Math.max(1, n);
  const maxRatio = Math.max(12, ...turns.map((t) => Number(t.driftRatio) || 0));
  const y = (r) => sparkTop + sparkH - (Math.min(maxRatio, Math.max(0, r)) / maxRatio) * sparkH;
  const maxTtft = Math.max(1, ...turns.map((t) => Number(t.ttftMs) || 0));

  const pts = turns.map((t, i) => `${(L + i * step + step / 2).toFixed(1)},${y(Number(t.driftRatio) || 0).toFixed(1)}`);
  const loopBands = turns.map((t, i) => (t.driftState === 'loop_suspect'
    ? `<rect x="${(L + i * step).toFixed(1)}" y="${sparkTop}" width="${step.toFixed(1)}" height="${sparkH}" fill="${COLORS.bad}" opacity="0.18"><title>Turn ${i + 1}: DET-30 loop suspect — ${fmtTokens(t.thinkingTokens)} thinking, ${t.mutatingCalls} edits</title></rect>`
    : '')).join('');
  const thresholdY = y(12).toFixed(1);
  const ttftStrip = turns.map((t, i) => {
    if (typeof t.ttftMs !== 'number') return '';
    const intensity = Math.max(0.15, Math.min(1, t.ttftMs / maxTtft));
    return `<rect x="${(L + i * step + 0.5).toFixed(1)}" y="${stripTop}" width="${Math.max(1, step - 1).toFixed(1)}" height="${stripH}" fill="${COLORS.accent}" opacity="${intensity.toFixed(2)}"><title>Turn ${i + 1}: TTFT ${(t.ttftMs / 1000).toFixed(1)}s</title></rect>`;
  }).join('');
  const last = turns[turns.length - 1];
  const dot = `<circle cx="${(L + (n - 1) * step + step / 2).toFixed(1)}" cy="${y(Number(last.driftRatio) || 0).toFixed(1)}" r="2.5" fill="${drift.loop?.triggered ? COLORS.bad : COLORS.think}"/>`;
  const headline = drift.loop?.triggered
    ? `DET-30 ${String(drift.loop.severity || 'warn').toUpperCase()}: ${drift.loop.consecutiveLoopTurns || 0} consecutive loop turn(s)`
    : `last ${drift.lastDriftRatio ?? '—'}x · rolling ${drift.rollingDriftRatio ?? '—'}x · avg TTFT ${drift.avgTtftMs != null ? (drift.avgTtftMs / 1000).toFixed(1) + 's' : '—'}`;

  return `<svg class="cr-svg" viewBox="0 0 ${WIDTH} ${H}" width="100%" role="img" aria-label="Thinking vs generation drift and TTFT">` +
    loopBands +
    `<line x1="${L}" x2="${WIDTH - R}" y1="${thresholdY}" y2="${thresholdY}" stroke="${COLORS.bad}" stroke-width="0.6" stroke-dasharray="3,3"/>` +
    `<text x="${L - 4}" y="${(Number(thresholdY) + 3).toFixed(1)}" text-anchor="end" fill="${COLORS.muted}" font-size="9">12x</text>` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="${COLORS.think}" stroke-width="1.3"/>` + dot +
    `<text x="${WIDTH - R}" y="10" text-anchor="end" fill="${drift.loop?.triggered ? COLORS.bad : COLORS.fg}" font-size="10">${escapeXml(headline)}</text>` +
    `<text x="${L - 4}" y="${stripTop + 9}" text-anchor="end" fill="${COLORS.muted}" font-size="9">TTFT</text>` +
    ttftStrip +
    `<text x="${L}" y="${H - 4}" fill="${COLORS.muted}" font-size="9">thinking ÷ visible output per user turn (estimates excluded)</text>` +
    `</svg>`;
}

/**
 * Panel 3: swarm / worktree topology graph.
 */
export function renderTopologyGraph(topology) {
  const workers = Array.isArray(topology?.workers) ? topology.workers : [];
  const worktrees = Array.isArray(topology?.worktrees) ? topology.worktrees : [];
  const collisions = Array.isArray(topology?.scopeLocks?.collisions) ? topology.scopeLocks.collisions : [];
  if (workers.length === 0 && worktrees.length <= 1 && collisions.length === 0) {
    return emptyPanel('Topology: solo agent · single worktree');
  }
  const { WIDTH } = COST_RADAR_DIMENSIONS;
  const rowH = 18;
  const rows = Math.max(workers.length, worktrees.length, 1);
  const H = 30 + rows * rowH + (collisions.length > 0 ? 18 : 0);
  const rootX = 60;
  const rootY = 22 + (rows * rowH) / 2;
  const workerX = 220;
  const wtX = 440;
  const stateColor = { working: COLORS.good, waiting: COLORS.accent, stopped: COLORS.warn, killed: COLORS.muted };

  let out = `<circle cx="${rootX}" cy="${rootY.toFixed(1)}" r="6" fill="${COLORS.fg}"/>` +
    `<text x="${rootX}" y="${(rootY + 18).toFixed(1)}" text-anchor="middle" fill="${COLORS.fg}" font-size="10">coordinator</text>`;
  workers.forEach((w, i) => {
    const wy = 22 + i * rowH + rowH / 2;
    const color = stateColor[w.state] || COLORS.muted;
    out += `<path d="M${rootX + 6},${rootY.toFixed(1)} C${rootX + 70},${rootY.toFixed(1)} ${workerX - 70},${wy.toFixed(1)} ${workerX - 5},${wy.toFixed(1)}" fill="none" stroke="${color}" stroke-width="1" opacity="${w.state === 'killed' ? 0.35 : 0.8}"${w.state === 'waiting' ? ' stroke-dasharray="3,3"' : ''}/>` +
      `<circle cx="${workerX}" cy="${wy.toFixed(1)}" r="4" fill="${color}"/>` +
      `<text x="${workerX + 9}" y="${(wy + 3).toFixed(1)}" fill="${COLORS.fg}" font-size="10">${escapeXml(`${w.name} · ${w.state}${w.parked ? ' ($0)' : ''} · ${w.model || 'inherit'} · ${w.workspace || 'inherit'}`)}</text>`;
  });
  worktrees.forEach((t, i) => {
    const ty = 22 + i * rowH + rowH / 2;
    const label = `${t.isMain ? '★ ' : ''}${t.branch || (t.detached ? `detached@${t.head || ''}` : t.name)}${t.locked ? ' [locked]' : ''}${t.prunable ? ' [prunable]' : ''}`;
    out += `<rect x="${wtX}" y="${(ty - 6).toFixed(1)}" width="10" height="10" fill="none" stroke="${COLORS.accent}"/>` +
      `<text x="${wtX + 16}" y="${(ty + 3).toFixed(1)}" fill="${COLORS.fg}" font-size="10">${escapeXml(label)}<title>${escapeXml(t.path || '')}</title></text>`;
  });
  if (collisions.length > 0) {
    const cy = H - 8;
    out += `<text x="12" y="${cy}" fill="${COLORS.bad}" font-size="10">${escapeXml(`DET-20 overlap: ${collisions.map((c) => `${c.trajectories.join(' ↔ ')} [${c.overlappingPaths.join(', ')}]`).join('; ')}`)}</text>`;
  }
  out += `<text x="${workerX}" y="12" fill="${COLORS.muted}" font-size="9">workers</text>` +
    `<text x="${wtX}" y="12" fill="${COLORS.muted}" font-size="9">git worktrees</text>`;
  return `<svg class="cr-svg" viewBox="0 0 ${WIDTH} ${H}" width="100%" role="img" aria-label="Swarm and worktree topology">${out}</svg>`;
}

/**
 * Builds the full self-contained HTML artifact.
 */
export function renderCostRadarHtml({ retention = null, drift = null, topology = null, meta = {} } = {}) {
  const title = meta.sessionTitle ? `Cost Radar — ${meta.sessionTitle}` : 'Cost Radar';
  const generated = meta.generatedAt || new Date().toISOString();
  const subtitleParts = [meta.model ? `model ${meta.model}` : null, meta.edition || null, `generated ${generated}`].filter(Boolean);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px 20px; background: ${COLORS.bg}; color: ${COLORS.fg}; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .sub { color: ${COLORS.muted}; font-size: 11px; margin-bottom: 12px; }
  section { margin: 0 0 14px; max-width: 680px; }
  h2 { font-size: 11px; font-weight: 500; color: ${COLORS.muted}; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 4px; border-bottom: 1px solid ${COLORS.grid}; padding-bottom: 2px; }
  .cr-svg { display: block; font-family: inherit; }
</style></head>
<body>
<h1>${escapeXml(title)}</h1>
<div class="sub">${escapeXml(subtitleParts.join(' · '))}</div>
<section id="cr-retention"><h2>Prefix-Cache Retention</h2>${renderRetentionStepChart(retention)}</section>
<section id="cr-drift"><h2>Thinking vs. Generation Drift · TTFT</h2>${renderDriftSparkline(drift)}</section>
<section id="cr-topology"><h2>Swarm &amp; Worktree Topology</h2>${renderTopologyGraph(topology)}</section>
</body></html>
`;
}
