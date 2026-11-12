/**
 * @file src/ui/horizonPanelHtml.mjs
 * Zero-Socket, Self-Contained 420px Side-Panel HTML HUD for Claude Code Attention Horizon (`ah-claude panel`).
 *
 * Enforces:
 *   1. Simple View (4-Rank Glanceable Hierarchy, <= 440px height at 420px width):
 *      - Rank 1: Plain-English Status Verdict + Claude Model & Flight Mode (`COACH` / `AUTO_PILOT`)
 *      - Rank 2: 40-Cell `[S]/[C]/[D]/[W]` Horizon Bar + 3-Stat Row + Anthropic 5m/1h Cache TTL Shield
 *      - Rank 3: Single Priority Next Action (plain-text `/compact` instruction in `#compactInstruction`, zero copy buttons)
 *      - Rank 4: Elevated "Tokens & USD Saved" Card (`+X.Xk ($Y.YY) this session · +X.XM ($Z.ZZ) 30d`)
 *   2. Advanced View (5 `<details>` Accordions):
 *      - Accordion 1: Verified 5-Category Savings & Anthropic Cache ROI (`C*` & `0.263` R/W)
 *      - Accordion 2: 40-Cell `[S]/[C]/[D]/[W]` Context Anatomy & Top Context Offenders (`.claudeignore` only on ignorable paths)
 *      - Accordion 3: Circuit Breakers (`DET-01..21`), Thinking Drift & Prefix Retention
 *      - Accordion 4: Subagent Swarm (`Task`/`Agent`), Worktrees & `DET-20` Scope Locks
 *      - Accordion 5: `PreCompact` State Baton (`HANDOFF_LATEST.md`) & Session Forensics
 *   3. Pure relative imports and zero `node:*` dependencies (Mod Law 4 compliant).
 */

import { computeHorizonGrid, CELL_CATEGORIES } from './horizonGrid.mjs';
import {
  formatTokensCompact,
  formatUsd,
  deriveSurfaceMetrics,
  deriveClaudeCodeVerdictAndActions,
  isIgnorableClaudePath,
  renderSimpleViewPane,
  renderAdvancedViewPane
} from './modViews.mjs';
import {
  computeBreakEvenCachedTokens,
  resolveNaturalDownshiftPeer
} from '../coach/cacheGravityRouter.mjs';
import { formatRetentionLabel, formatDriftLabel } from '../telemetry/sprintMetrics.mjs';
import { computeSwarmSummary } from '../telemetry/swarmTopology.mjs';

/**
 * Escapes HTML special characters safely.
 * @param {any} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the 40-cell graphical HTML grid bar using canonical `[S]/[C]/[D]/[W]/[.]` colors.
 * @param {object} grid
 * @returns {string}
 */
function renderHtmlHorizonCells(grid) {
  return grid.cells
    .map((cell, idx) => {
      const cat = cell.category;
      const bg =
        cat === 'S'
          ? CELL_CATEGORIES.S.colorHex
          : cat === 'C'
            ? CELL_CATEGORIES.C.colorHex
            : cat === 'D'
              ? CELL_CATEGORIES.D.colorHex
              : cat === 'W'
                ? CELL_CATEGORIES.W.colorHex
                : '#1e293b';
      const label =
        cat === '.'
          ? `Cell ${idx + 1}: Available capacity`
          : `Cell ${idx + 1}: [${cat}] ${cell.label}`;
      return `<span class="ah-cell ah-cell-${cat === '.' ? 'empty' : cat}" style="background:${bg}" title="${escapeHtml(label)}"></span>`;
    })
    .join('');
}

/**
 * Renders the self-contained Claude Code Attention Horizon HTML HUD (`horizon_panel.html`).
 *
 * @param {object} [state={}]
 * @param {object} [options={}]
 * @param {'simple'|'advanced'} [options.initialView='simple']
 * @returns {{
 *   html: string,
 *   simplePane: object,
 *   advancedPane: object,
 *   grid: object,
 *   metrics: object,
 *   verdict: object,
 *   priorityAction: object
 * }}
 */
export function renderHorizonPanelHtml(state = {}, options = {}) {
  const initialView =
    String(options.initialView || options.viewMode || 'simple').toLowerCase() === 'advanced'
      ? 'advanced'
      : 'simple';

  const grid = computeHorizonGrid(state, options);
  const metrics = deriveSurfaceMetrics(state, options);
  const { verdict, priorityAction, secondaryActions, overflowActionCount } =
    deriveClaudeCodeVerdictAndActions(state, grid, metrics, options);
  const simplePane = renderSimpleViewPane(state, options);
  const advancedPane = renderAdvancedViewPane(state, options);

  const peerModel = resolveNaturalDownshiftPeer(grid.modelId);
  const breakEven = computeBreakEvenCachedTokens(
    {
      currentModel: grid.modelId,
      targetModel: peerModel,
      expectedOutputTokens: 1500,
      cacheTtlTier: metrics.ttlTier
    },
    options
  );
  const swarmSummary = computeSwarmSummary(state, { nowMs: options.nowMs || Date.now() });
  const headroomTokens = Math.max(0, grid.zoomTier.ceilingTokens - grid.totalInputTokens);

  const rawOffenders = Array.isArray(options.offenders) && options.offenders.length > 0
    ? options.offenders.slice(0, 4).map((o) => {
        const name = String(o.name || 'Context Item');
        const tokens = Math.max(0, Number(o.tokens || 0));
        return {
          name,
          tokens,
          category: String(o.category || '[D]'),
          ignorable: isIgnorableClaudePath(name),
          pct:
            grid.totalInputTokens > 0
              ? Number(((tokens / grid.totalInputTokens) * 100).toFixed(1))
              : 0
        };
      })
    : [
        {
          name: 'Middle-Window Distractor / Stale Tool Output',
          tokens: grid.tokens.D,
          category: '[D]',
          ignorable: false
        },
        {
          name: 'System Prompt & MCP Tool Schemas',
          tokens: grid.tokens.S,
          category: '[S]',
          ignorable: false
        },
        {
          name: 'Fresh 1.25x Cache Write Delta',
          tokens: grid.tokens.W,
          category: '[W]',
          ignorable: false
        },
        {
          name: 'Warm Cached Conversation Prefix',
          tokens: grid.tokens.C,
          category: '[C]',
          ignorable: false
        }
      ]
        .filter((e) => e.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
        .map((e) => ({
          ...e,
          pct:
            grid.totalInputTokens > 0
              ? Number(((e.tokens / grid.totalInputTokens) * 100).toFixed(1))
              : 0
        }));

  const midTickLabel =
    grid.zoomTier.id === '100k'
      ? '50k'
      : grid.zoomTier.id === '1M'
        ? '500k'
        : `${Math.round(grid.zoomTier.ceilingTokens / 2000)}k`;
  const maxTickLabel =
    grid.zoomTier.id === '100k' ? '100k (5x Haiku Cliff)' : grid.zoomTier.id;

  const isCompactRecommended =
    priorityAction.commandHint.includes('/compact') ||
    priorityAction.instruction.includes('/compact');

  const compactInstructionText = isCompactRecommended
    ? 'Type /compact in the chat box and press Enter'
    : priorityAction.instruction;
  const compactReclaimText =
    priorityAction.reclaimTokens > 0
      ? `Reclaims ~${formatTokensCompact(priorityAction.reclaimTokens)} (${metrics.cacheWarm && metrics.remainingSeconds > 60 ? `after ${metrics.ttlCompact} warm TTL` : 'ready now'})`
      : metrics.cacheWarm
        ? `${formatTokensCompact(metrics.cachedTokens)} warm at 0.10x read discount`
        : 'Cold prefix — ready for next turn';

  const catList = [
    metrics.savingsCategories.cacheReadDiscount,
    metrics.savingsCategories.prefixBustAvoided,
    metrics.savingsCategories.toolOutputCompressed,
    metrics.savingsCategories.loopAndReadGuarded,
    metrics.savingsCategories.subagentIsolated
  ];

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attention Horizon — Claude Code</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1020;
    --card: #111827;
    --card-alt: #162033;
    --border: #1e293b;
    --fg: #e2e8f0;
    --muted: #94a3b8;
    --good: #34d399;
    --warn: #fbbf24;
    --bad: #f87171;
    --accent: #60a5fa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg);
    color: var(--fg);
    font: 12px/1.38 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .ah-wrap {
    max-width: 420px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ah-view-radio {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .ah-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  .ah-brand {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg);
  }
  .ah-tabs {
    display: inline-flex;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px;
  }
  .ah-tab-label {
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
  }
  #viewModeSimple:checked ~ .ah-wrap .ah-tabs label[for="viewModeSimple"],
  #viewModeAdvanced:checked ~ .ah-wrap .ah-tabs label[for="viewModeAdvanced"] {
    background: var(--card-alt);
    color: var(--fg);
  }
  #viewModeSimple:checked ~ .ah-wrap #advancedViewContainer {
    display: none;
  }
  #viewModeAdvanced:checked ~ .ah-wrap #simpleViewContainer {
    display: none;
  }
  #simpleViewContainer {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ah-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 9px;
  }
  /* Rank 1: Status Verdict & Flight Header */
  .ah-verdict-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .ah-verdict-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .ah-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .ah-dot-healthy { background: var(--good); }
  .ah-dot-warn { background: var(--warn); }
  .ah-dot-critical { background: var(--bad); }
  .ah-verdict-title {
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ah-pills {
    display: inline-flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .ah-pill {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--card-alt);
    border: 1px solid var(--border);
    color: var(--fg);
  }
  .ah-verdict-sub {
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Rank 2: 40-Cell Bar, 3-Stat Row & Cache Shield */
  .ah-grid-bar {
    display: grid;
    grid-template-columns: repeat(40, 1fr);
    gap: 1px;
    height: 10px;
    border-radius: 3px;
    overflow: hidden;
    background: #0f172a;
  }
  .ah-cell {
    display: block;
    height: 100%;
  }
  .ah-ruler {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
  }
  .ah-stats-3 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid var(--border);
  }
  .ah-stat-lbl {
    font-size: 10px;
    color: var(--muted);
  }
  .ah-stat-val {
    font-size: 12px;
    font-weight: 700;
  }
  .ah-cache-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 5px;
    padding: 3px 6px;
    border-radius: 4px;
    background: var(--card-alt);
    font-size: 11px;
  }
  /* Rank 3: Priority Next Action */
  .ah-action-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 700;
  }
  .ah-action-instr {
    margin-top: 3px;
    font-size: 11px;
    color: var(--fg);
    background: var(--card-alt);
    padding: 4px 6px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .ah-action-reclaim {
    font-size: 10px;
    color: var(--good);
    font-weight: 600;
  }
  details.ah-overflow {
    margin-top: 4px;
    font-size: 11px;
    color: var(--muted);
  }
  details.ah-overflow summary {
    cursor: pointer;
    color: var(--accent);
    font-weight: 600;
  }
  /* Rank 4: Elevated Tokens & USD Saved Card */
  .ah-saved-card {
    background: linear-gradient(180deg, #112233 0%, #111827 100%);
    border-color: #1e3a5f;
  }
  .ah-saved-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
  }
  .ah-saved-lbl {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--good);
  }
  .ah-saved-30d {
    font-size: 11px;
    color: var(--muted);
  }
  .ah-saved-main {
    font-size: 15px;
    font-weight: 800;
    color: var(--fg);
    margin-top: 2px;
  }
  .ah-saved-driver {
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
  }
  /* Advanced View Accordions */
  #advancedViewContainer {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  details.adv-accordion {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 9px;
  }
  details.adv-accordion summary {
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    color: var(--fg);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .adv-body {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .adv-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .adv-badge-ignore {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: #3b2f13;
    color: var(--warn);
    border: 1px solid #785a1a;
  }
</style>
</head>
<body>
<input class="ah-view-radio" type="radio" name="ah-view" id="viewModeSimple" ${initialView === 'simple' ? 'checked' : ''}>
<input class="ah-view-radio" type="radio" name="ah-view" id="viewModeAdvanced" ${initialView === 'advanced' ? 'checked' : ''}>
<div class="ah-wrap" id="ahPanelRoot">
  <header class="ah-topbar">
    <span class="ah-brand">Attention Horizon · Claude Code</span>
    <nav class="ah-tabs" aria-label="View Mode">
      <label class="ah-tab-label" for="viewModeSimple" id="tabSimple">Simple</label>
      <label class="ah-tab-label" for="viewModeAdvanced" id="tabAdvanced">Advanced</label>
    </nav>
  </header>

  <!-- SIMPLE VIEW: Strict 4-Rank Glanceable Hierarchy (<= 440px at 420px width) -->
  <main id="simpleViewContainer">
    <!-- Rank 1: Status Verdict & Flight Header -->
    <section class="ah-card" id="verdictBanner" data-rank="1">
      <div class="ah-verdict-row">
        <div class="ah-verdict-left">
          <span class="ah-dot ah-dot-${escapeHtml(verdict.severity)}"></span>
          <span class="ah-verdict-title" id="verdictHeadline">${escapeHtml(verdict.headline)}</span>
        </div>
        <div class="ah-pills">
          <span class="ah-pill" id="modelBadge">${escapeHtml(state.modelLabel || grid.modelId)}</span>
          <span class="ah-pill" id="flightModeBadge">${escapeHtml(metrics.flightMode)}</span>
        </div>
      </div>
      <div class="ah-verdict-sub" id="verdictDetail">${escapeHtml(verdict.detail)}</div>
    </section>

    <!-- Rank 2: 40-Cell Horizon Bar, 3-Stat Row & 5m/1h Prompt Cache Shield -->
    <section class="ah-card" id="capacityAndCacheCard" data-rank="2">
      <div class="ah-grid-bar" id="horizonGridBar" role="img" aria-label="40-Cell Context Horizon Bar">
        ${renderHtmlHorizonCells(grid)}
      </div>
      <div class="ah-ruler">
        <span>0k</span>
        <span>${escapeHtml(midTickLabel)}</span>
        <span>${escapeHtml(maxTickLabel)}</span>
      </div>
      <div class="ah-stats-3">
        <div>
          <div class="ah-stat-lbl">Used / Horizon</div>
          <div class="ah-stat-val" id="statUsed">${escapeHtml(`${formatTokensCompact(grid.totalInputTokens)} / ${grid.zoomTier.id} (${grid.utilizationPct}%)`)}</div>
        </div>
        <div>
          <div class="ah-stat-lbl">Stale Tool Debt [D]</div>
          <div class="ah-stat-val" id="statDebt">${escapeHtml(formatTokensCompact(grid.tokens.D))}</div>
        </div>
        <div>
          <div class="ah-stat-lbl">Free Headroom</div>
          <div class="ah-stat-val" id="statHeadroom">${escapeHtml(formatTokensCompact(headroomTokens))}</div>
        </div>
      </div>
      <div class="ah-cache-strip" id="cacheShieldStrip">
        <span>Prompt Cache: <strong>${metrics.cacheWarm ? 'WARM' : 'COLD'}</strong> (${escapeHtml(metrics.ttlTier)} TTL)</span>
        <span>TTL: <strong>${escapeHtml(metrics.ttlClock)}</strong> · Hit <strong>${metrics.cacheHitPct}%</strong></span>
      </div>
    </section>

    <!-- Rank 3: Single Priority Next Action -->
    <section class="ah-card" id="priorityActionCard" data-rank="3">
      <div class="ah-action-hdr">
        <span id="priorityActionTitle">${escapeHtml(priorityAction.title)}</span>
        <span class="ah-action-reclaim" id="compactReclaim">${escapeHtml(compactReclaimText)}</span>
      </div>
      <div class="ah-action-instr" id="compactInstruction">${escapeHtml(compactInstructionText)}</div>
      ${
        overflowActionCount > 0
          ? `<details class="ah-overflow"><summary>+${overflowActionCount} more optimization${overflowActionCount === 1 ? '' : 's'}</summary><ul>${secondaryActions.map((a) => `<li><strong>${escapeHtml(a.title)}:</strong> ${escapeHtml(a.instruction)}</li>`).join('')}</ul></details>`
          : ''
      }
    </section>

    <!-- Rank 4: Elevated Verified Tokens & USD Saved Card -->
    <section class="ah-card ah-saved-card" id="tokensSavedCard" data-rank="4">
      <div class="ah-saved-top">
        <span class="ah-saved-lbl">Tokens &amp; USD Saved</span>
        <span class="ah-saved-30d" id="savedWorkspace30d">+${escapeHtml(formatTokensCompact(metrics.workspace30dSavedTokens))} (${escapeHtml(formatUsd(metrics.workspace30dSavedUSD))}) 30d</span>
      </div>
      <div class="ah-saved-main" id="savedSessionHeadline">+${escapeHtml(formatTokensCompact(metrics.sessionSavedTokens))} tokens (${escapeHtml(formatUsd(metrics.sessionSavedUSD))}) this session</div>
      <div class="ah-saved-driver" id="savedTopDriver">Top driver: ${escapeHtml(metrics.topSavingsDriver.label)} (+${escapeHtml(formatTokensCompact(metrics.topSavingsDriver.savedTokens))})</div>
    </section>
  </main>

  <!-- ADVANCED VIEW: 5 Progressive-Disclosure Accordions -->
  <section id="advancedViewContainer">
    <!-- Accordion 1: Verified 5-Category Savings & Anthropic Cache ROI -->
    <details class="adv-accordion" id="advSavingsAccordion" open>
      <summary>
        <span>1. Verified Savings Breakdown &amp; Cache ROI</span>
        <span>+${escapeHtml(formatTokensCompact(metrics.sessionSavedTokens))} (${escapeHtml(formatUsd(metrics.sessionSavedUSD))})</span>
      </summary>
      <div class="adv-body">
        ${catList
          .map(
            (c) =>
              `<div class="adv-row"><span>${escapeHtml(c.label)}</span><strong>+${escapeHtml(formatTokensCompact(c.savedTokens))} (${escapeHtml(formatUsd(c.savedUSD))})</strong></div>`
          )
          .join('')}
        <div class="adv-row"><span>Break-Even Gravity C* (${escapeHtml(grid.modelId)} &rarr; ${escapeHtml(peerModel)})</span><strong>${escapeHtml(breakEven.breakEvenTokens.toLocaleString('en-US'))} tok</strong></div>
        <div class="adv-row"><span>Reads / Write Ratio (Break-Even &ge; ${escapeHtml(metrics.breakEvenReadsPerWrite)})</span><strong>${escapeHtml(metrics.readsPerWriteRatio.toFixed(2))}</strong></div>
      </div>
    </details>

    <!-- Accordion 2: 40-Cell Context Anatomy & Top Offenders -->
    <details class="adv-accordion" id="advAnatomyAccordion">
      <summary>
        <span>2. Context Anatomy ([S]/[C]/[D]/[W]) &amp; Top Offenders</span>
        <span>${escapeHtml(formatTokensCompact(grid.totalInputTokens))} / ${escapeHtml(grid.zoomTier.id)}</span>
      </summary>
      <div class="adv-body">
        <div class="adv-row"><span>[S] System &amp; MCP Tool Schemas</span><strong>${grid.cellCounts.S} cells (${escapeHtml(formatTokensCompact(grid.tokens.S))})</strong></div>
        <div class="adv-row"><span>[C] Warm Cached Prefix</span><strong>${grid.cellCounts.C} cells (${escapeHtml(formatTokensCompact(grid.tokens.C))})</strong></div>
        <div class="adv-row"><span>[D] Stale Tool Output Debt</span><strong>${grid.cellCounts.D} cells (${escapeHtml(formatTokensCompact(grid.tokens.D))})</strong></div>
        <div class="adv-row"><span>[W] Fresh 1.25x Cache Write Delta</span><strong>${grid.cellCounts.W} cells (${escapeHtml(formatTokensCompact(grid.tokens.W))})</strong></div>
        ${rawOffenders
          .map(
            (o) =>
              `<div class="adv-row"><span>${escapeHtml(o.category)} ${escapeHtml(o.name)} ${o.ignorable ? '<span class="adv-badge-ignore">.claudeignore candidate</span>' : ''}</span><strong>${escapeHtml(formatTokensCompact(o.tokens))} (${o.pct}%)</strong></div>`
          )
          .join('')}
      </div>
    </details>

    <!-- Accordion 3: Circuit Breakers (DET-01..21), Thinking Drift & Retention -->
    <details class="adv-accordion" id="advBreakersAccordion">
      <summary>
        <span>3. Circuit Breakers (DET-01..21) &amp; Thinking Drift</span>
        <span>${escapeHtml(options.breakerVerdict?.triggered ? options.breakerVerdict.detectorId || 'ACTIVE' : '21 nominal')}</span>
      </summary>
      <div class="adv-body">
        <div class="adv-row"><span>Flight Mode</span><strong>${escapeHtml(metrics.flightMode)}</strong></div>
        <div class="adv-row"><span>Prefix Retention</span><strong>${escapeHtml(formatRetentionLabel(state.prefixRetention))}</strong></div>
        <div class="adv-row"><span>Thinking Drift (DET-21)</span><strong>${escapeHtml(formatDriftLabel(state.thinkingDrift))}</strong></div>
        <div class="adv-row"><span>Haiku 5.5 100k 5x Cliff (DET-12)</span><strong>${escapeHtml(state.cliffTriggered ? 'EXCEEDED (5x)' : state.preCliffWarningTriggered ? 'PRE-CLIFF (>=90k)' : 'Nominal')}</strong></div>
      </div>
    </details>

    <!-- Accordion 4: Subagent Swarm (Task/Agent), Worktrees & Scope Locks -->
    <details class="adv-accordion" id="advSwarmAccordion">
      <summary>
        <span>4. Subagent Swarm (Task/Agent) &amp; Worktrees</span>
        <span>${escapeHtml(swarmSummary.active ? `${swarmSummary.workers.length} workers` : 'Solo')}</span>
      </summary>
      <div class="adv-body">
        <div class="adv-row"><span>Swarm Status</span><strong>${escapeHtml(swarmSummary.active ? swarmSummary.label : 'Solo main agent')}</strong></div>
        ${
          swarmSummary.active
            ? swarmSummary.workers
                .map(
                  (w) =>
                    `<div class="adv-row"><span>${escapeHtml(w.agentId)} (${escapeHtml(w.state)}${w.state === 'waiting' ? ' $0' : ''})</span><strong>${escapeHtml(formatTokensCompact(w.totalTokens))} · ${w.turns}t</strong></div>`
                )
                .join('')
            : '<div class="adv-row"><span>Isolated Subagent Tokens</span><strong>0</strong></div>'
        }
      </div>
    </details>

    <!-- Accordion 5: PreCompact State Baton & Claude Code Forensics -->
    <details class="adv-accordion" id="advForensicsAccordion">
      <summary>
        <span>5. PreCompact State Baton &amp; Session Forensics</span>
        <span>${escapeHtml(grid.zoomTier.label)}</span>
      </summary>
      <div class="adv-body">
        <div class="adv-row"><span>Session ID</span><strong>${escapeHtml(state.sessionId || 'default')}</strong></div>
        <div class="adv-row"><span>State Baton Handoff</span><strong>.claude/cache/HANDOFF_LATEST.md</strong></div>
        <div class="adv-row"><span>Prefix Config Files</span><strong>CLAUDE.md · .claude/rules/ · .mcp.json</strong></div>
        <div class="adv-row"><span>Diagnostics CLI</span><strong>npx ah-claude doctor</strong></div>
      </div>
    </details>
  </section>
</div>
</body>
</html>
`;

  return {
    html,
    simplePane,
    advancedPane,
    grid,
    metrics,
    verdict,
    priorityAction
  };
}

export default {
  escapeHtml,
  renderHorizonPanelHtml
};
