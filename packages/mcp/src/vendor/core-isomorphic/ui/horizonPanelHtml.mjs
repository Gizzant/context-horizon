/**
 * @file src/ui/horizonPanelHtml.mjs
 * Zero-Socket, Self-Contained 420px Side-Panel HTML HUD for Highbeam (`ah` v4.0 — Claude Code Studio).
 *
 * Enforces:
 *   1. Simple View (4-Rank Glanceable Hierarchy, <= 440px height at 420px width):
 *      - Rank 1: Plain-English Status Verdict + Claude Model & Flight Mode (`COACH` / `AUTO_PILOT`)
 *      - Rank 2: 40-Cell `[S]/[C]/[D]/[W]` Horizon Bar + 3-Stat Row + Anthropic 5m/1h Cache TTL Shield
 *      - Rank 3: Single Priority Next Action (1-click Copy `/compact` button `#btnCompactPrimary` alongside `#compactInstruction`)
 *      - Rank 4: Elevated "Tokens & USD Saved" Card (`+X.Xk ($Y.YY) this session · +X.XM ($Z.ZZ) 30d`)
 *   2. Advanced View (5 `<details>` Accordions):
 *      - Accordion 1: Verified 5-Category Savings, Anthropic Cache ROI (`C*` & `0.263` R/W) & Signed PDF Expense Receipt
 *      - Accordion 2: 40-Cell `[S]/[C]/[D]/[W]` Context Anatomy & Top Context Offenders (`.claudeignore` only on ignorable paths)
 *      - Accordion 3: 6 Core Auditable Guards (`DET-01..32`), Thinking Drift & Prefix Retention
 *      - Accordion 4: Subagent Swarm (`Task`/`Agent`), Worktrees & `DET-20` Scope Locks
 *      - Accordion 5: `PreCompact` State Baton (`HANDOFF_LATEST.md`) & Session Forensics
 *   3. Pure relative imports and zero `node:*` dependencies (Mod Law 4 compliant).
 */

import { computeHorizonGrid, CELL_CATEGORIES } from './horizonGrid.mjs';
import { DETECTOR_CATALOG, summarizeCoreAuditableGuards } from '../catalog/detectorCatalog.mjs';
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
import { computeShadowAutoSummary } from '../economics/shadowAutoModel.mjs';

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
                : 'var(--bg-elevated)';
      const label =
        cat === '.'
          ? `Cell ${idx + 1}: Available capacity`
          : `Cell ${idx + 1}: [${cat}] ${cell.label}`;
      return `<span class="ah-cell ah-cell-${cat === '.' ? 'empty' : cat}" style="background:${bg}" title="${escapeHtml(label)}"></span>`;
    })
    .join('');
}

const FLIGHT_SLOTS = 40;
const FLIGHT_GLYPH = { COLD_GAP: '\u25D0', COMPACT: '\u25B2', MODEL_SWITCH: '\u21C4', CHECKPOINT: '\u25C6' };
const FLIGHT_GLYPH_ORDER = ['COLD_GAP', 'COMPACT', 'MODEL_SWITCH', 'CHECKPOINT'];

/**
 * Coalesces repeated identical auto-fix events (same type/label, turn, detail) into one row with an xN count badge.
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
function coalesceClaudeAutoFixItems(items) {
  const grouped = [];
  const byKey = new Map();
  for (const it of items) {
    if (!it) continue;
    const key = `${it.type || it.label || ''}|${it.turn || 0}|${it.detail || ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.tokensSaved += Number(it.tokensSaved || 0);
      existing.usd += Number(it.usd || 0);
    } else {
      const merged = {
        ...it,
        count: 1,
        tokensSaved: Number(it.tokensSaved || 0),
        usd: Number(it.usd || 0)
      };
      byKey.set(key, merged);
      grouped.push(merged);
    }
  }
  return grouped;
}

/**
 * Computes SVG stroke-dashoffset for the 48x48 Watch Cache Ring (`r = 19`, circumference `119.38`).
 * @param {number} pct
 * @returns {string}
 */
function computeCacheRingDashOffset(pct) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const circ = 2 * Math.PI * 19;
  return (circ * (1 - clamped / 100)).toFixed(2);
}

function sanitizeClaudeCopy(text = '') {
  return String(text || '')
    .replace(/\bAGENTS\.md\s*\/\s*CLAUDE\.md\b/gi, 'CLAUDE.md')
    .replace(/\btask\.md\b/gi, 'plan state')
    .replace(/\bGEMINI\.md\b/gi, 'CLAUDE.md')
    .replace(/\bAntigravity\b/gi, 'Claude Code');
}

/**
 * Builds sorted live guard roster rows (`tripped` -> `blocks` -> `advises`) from DETECTOR_CATALOG.
 * @param {object|null} breakerVerdict
 * @returns {{ summaryText: string, count: number, html: string }}
 */
function renderGuardRosterHtml(breakerVerdict = null) {
  const trippedId = breakerVerdict?.triggered
    ? String(breakerVerdict.detectorId || breakerVerdict.ruleId || '').toUpperCase()
    : '';
  const weight = { tripped: 0, blocks: 1, advises: 2 };
  const items = Object.values(DETECTOR_CATALOG).map((det) => {
    const role = trippedId && det.id === trippedId
      ? 'tripped'
      : det.defaultMode === 'guard'
        ? 'blocks'
        : 'advises';
    return { det, role };
  });
  items.sort((a, b) => weight[a.role] - weight[b.role] || a.det.id.localeCompare(b.det.id));
  const trippedCount = items.filter((it) => it.role === 'tripped').length;
  const blockCount = items.filter((it) => it.role === 'blocks').length;
  const summaryText = trippedCount > 0
    ? `${trippedCount} tripped · ${items.length} armed`
    : `${blockCount} blocking · ${items.length - blockCount} advisory`;
  const html = items
    .map(({ det, role }) => {
      const badge = role === 'tripped' ? 'TRIPPED' : role;
      return `<li class="ts-guard-row" data-role="${role}" title="${escapeHtml(sanitizeClaudeCopy(det.description))}"><span class="ts-guard-id">${escapeHtml(det.id)}</span><span class="ts-guard-name">${escapeHtml(sanitizeClaudeCopy(det.name))}</span><span class="ts-guard-role ts-role-${role}">${badge}</span></li>`;
    })
    .join('');
  return { summaryText, count: items.length, html };
}

/**
 * Renders Card 3 (`AUTOMATED ACTIVITY`) with coalesced auto-guard events, Shield/RSL badges, and live guard roster.
 */
function renderAutomatedActivityHtml(log, breakerVerdict, shieldData, rslData) {
  const rawItems = log && Array.isArray(log.items) ? log.items : [];
  const items = coalesceClaudeAutoFixItems(rawItems);
  const total = Math.max(Number((log && log.total) || 0), rawItems.length);
  const visibleItems = items.slice(0, 4);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  const renderRow = (it) => {
    const mult = it.count > 1 ? `<span class="ah-fx-mult">\u00D7${it.count}</span>` : '';
    const extra = `${it.detail || it.label} \u00B7 ${formatTokensCompact(it.tokensSaved)} tokens`;
    return `<details class="ah-fx-row"><summary><span class="ah-fx-turn">${it.turn ? `T${escapeHtml(it.turn)}` : '\u00B7'}</span><span class="ah-fx-label">\u2713 ${escapeHtml(it.label)}${mult}</span><span class="ah-fx-detail">${escapeHtml(it.detail || '')}</span><span class="ah-fx-saved">+${escapeHtml(formatTokensCompact(it.tokensSaved))}</span></summary><div class="ah-fx-more">${escapeHtml(extra)}</div></details>`;
  };
  const rowsHtml = items.length === 0
    ? '<div class="ah-fx-empty">No auto-fixes yet.</div>'
    : visibleItems.map(renderRow).join('') +
      (hiddenCount > 0
        ? `<details class="ah-fx-overflow"><summary>+${hiddenCount} older guard event${hiddenCount === 1 ? '' : 's'}</summary>${items.slice(4).map(renderRow).join('')}</details>`
        : '');

  const roster = renderGuardRosterHtml(breakerVerdict);
  const signalChips = [];
  if (shieldData && (shieldData.armed !== false || shieldData.quarantined)) {
    signalChips.push(
      `<span class="ah-pill${shieldData.quarantined ? ' ah-pill-risk' : ''}" id="ccShieldBadge">${shieldData.quarantined ? 'Shield: mutation held' : 'Shield: armed'}</span>`
    );
  }
  if (rslData) {
    const activeR = Number(rslData.activeRules || 0);
    const candR = Number(rslData.candidateRules || 0);
    const clashR = Number(rslData.clashCount || 0);
    const label = clashR > 0
      ? `RSL: ${clashR} clash${clashR === 1 ? '' : 'es'}`
      : candR > 0
        ? `RSL: ${activeR} active · ${candR} staged`
        : `RSL: ${activeR} active`;
    signalChips.push(
      `<span class="ah-pill${clashR > 0 ? ' ah-pill-risk' : ''}" id="ccRslBadge">${escapeHtml(label)}</span>`
    );
  }

  return `<section class="ah-card ts-card" id="ccActivitySection" aria-label="Automated activity" data-rank="3b">
      <div class="ts-card-head">
        <span class="ah-sec-name">Automated activity</span>
        <span class="ts-kpi-sub" id="ccGuardsSummary">${escapeHtml(roster.summaryText)}</span>
      </div>
      <div class="ah-sec-blurb">Background protections trimming noisy outputs, shielding warm caches, and managing learned rules.</div>
      ${signalChips.length > 0 ? `<div class="ts-signal-row">${signalChips.join('')}</div>` : ''}
      <div class="ah-fr-zone ah-fr-log">
        <div class="ah-fr-head"><span>AUTO-GUARD STREAM</span><span class="ah-fr-count" id="autoFixCount">${total}</span></div>
        <div class="ah-sec-blurb">Wasteful reads and loops the guard fixed automatically. Nothing to do.</div>
        <div class="ah-fx-list" id="autoFixList">${rowsHtml}<div class="ah-fx-rail-armed"><span class="ah-rail-dot" aria-hidden="true"></span>Auto-guard armed · watching reads &amp; CLI spikes</div></div>
      </div>
      <details class="ts-drawer" id="ccActivityDrawer">
        <summary><span>Active safety &amp; efficiency guards (${roster.count})</span><span class="ts-kpi-sub">${breakerVerdict?.triggered ? '1 tripped' : 'Details'}</span></summary>
        <ul id="ccGuardList" class="ts-guard-list" role="list">${roster.html}</ul>
      </details>
    </section>`;
}

/**
 * Renders Card 4 (`SESSION OVERVIEW` + `#simpleFlightRecorder` Turn Pulse & `#tokensSavedCard`).
 */
function renderSessionOverviewHtml(tl, metrics, catList, shadowAuto = null, proEntitlement = null) {
  const turns = tl && Array.isArray(tl.turns) ? tl.turns : [];
  const slots = [];
  if (turns.length > 0) {
    if (tl.earlier && tl.earlier.turns > 0) slots.push({ kind: 'earlier' });
    for (const t of turns) slots.push({ kind: 'turn', t });
  }
  const visible = slots.slice(-FLIGHT_SLOTS);
  const maxAdd = Math.max(1, ...turns.map((t) => t.tokensAdded));
  let bars = '';
  for (let i = 0; i < FLIGHT_SLOTS; i++) {
    const s = visible[i];
    if (!s) {
      bars += '<span class="ah-tl-slot ah-tl-empty"><span class="ah-tl-bar"></span></span>';
    } else if (s.kind === 'earlier') {
      const e = tl.earlier;
      bars += `<span class="ah-tl-slot ah-tl-earlier" title="${escapeHtml(`Earlier ${e.turns} turns \u00B7 ${formatTokensCompact(e.tokens)} added \u00B7 ${e.bad} bad \u00B7 ${e.good} good`)}"><span class="ah-tl-bar" style="height:40%"></span></span>`;
    } else {
      const h = Math.max(4, Math.round((s.t.tokensAdded / maxAdd) * 100));
      bars += `<span class="ah-tl-slot" title="${escapeHtml(`T${s.t.turn} \u00B7 ${s.t.reason}`)}"><span class="ah-tl-bar ah-tl-${escapeHtml(s.t.practice)}" style="height:${h}%"></span></span>`;
    }
  }
  const peak = Math.max(0, ...turns.map((t) => t.cumulative));
  const limit = Number((tl && tl.safeLimit) || 0);
  const yMax = Math.max(limit * 1.1, peak * 1.05, 1);
  const pts = [];
  visible.forEach((s, i) => {
    if (s.kind !== 'turn') return;
    pts.push(`${(((i + 0.5) / FLIGHT_SLOTS) * 100).toFixed(2)},${(100 - Math.min(100, (s.t.cumulative / yMax) * 100)).toFixed(2)}`);
  });
  const limitY = limit > 0 ? 100 - Math.min(100, (limit / yMax) * 100) : null;
  const overlay = turns.length > 0
    ? `<svg class="ah-tl-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${
        limitY !== null ? `<line x1="0" y1="${limitY.toFixed(2)}" x2="100" y2="${limitY.toFixed(2)}" stroke="currentColor" class="ah-tl-limit-svg" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : ''
      }${pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" class="ah-tl-poly-svg" stroke-width="1.25" vector-effect="non-scaling-stroke"/>` : ''}</svg>`
    : '';
  let marks = '';
  for (let i = 0; i < FLIGHT_SLOTS; i++) {
    const s = visible[i];
    const list = s && s.kind === 'turn' ? (tl.markers || []).filter((m) => m.turn === s.t.turn) : [];
    if (!list.length) { marks += '<span class="ah-tl-mk"></span>'; continue; }
    const top = FLIGHT_GLYPH_ORDER.find((k) => list.some((m) => m.kind === k)) || list[0].kind;
    marks += `<span class="ah-tl-mk" title="${escapeHtml(list.map((m) => m.label).join(' \u00B7 '))}">${FLIGHT_GLYPH[top] || '\u00B7'}</span>`;
  }
  const focus = [...turns].reverse().find((t) => t.practice === 'bad') || turns[turns.length - 1];
  const detail = focus
    ? `<span class="ah-tl-dot ah-tl-${escapeHtml(focus.practice)}"></span>${escapeHtml(`T${focus.turn} \u00B7 ${focus.reason}`)}`
    : 'Pulse tracking starts after the first turn.';

  const hasSessionSavings = Number(metrics.sessionSavedTokens || 0) > 0;
  const savedMainTxt = hasSessionSavings
    ? `+${formatTokensCompact(metrics.sessionSavedTokens)} tokens`
    : 'Tracking ready';
  const saved30dTxt = `+${formatTokensCompact(metrics.workspace30dSavedTokens)} tokens (30d)`;
  const driverTxt = `${metrics.topSavingsDriver.label} (+${formatTokensCompact(metrics.topSavingsDriver.savedTokens)})`;
  const avoidedSess = Number(metrics.savingsBuckets?.avoidedWrites?.sessionTokens || 0);
  const platformSess = Number(metrics.savingsBuckets?.platformCacheDiscount?.sessionTokens || 0);
  const realizedBucket = metrics.savingsBuckets?.realizedPromptBill || { count: 0, tokens: 0, usd: 0 };
  const realizedSignedTok = realizedBucket.tokens >= 0
    ? `+${formatTokensCompact(realizedBucket.tokens)}`
    : `-${formatTokensCompact(Math.abs(realizedBucket.tokens))}`;
  const realizedRowHtml =
    Number(realizedBucket.count || 0) > 0
      ? `<div class="ah-saved-cat-row" id="savedBucketRealized"><span>Ex-post realized prompt-bill</span><strong>${escapeHtml(realizedSignedTok)} tok</strong></div>`
      : '';

  return `<section class="ah-card ts-card ah-flight" id="simpleFlightRecorder" aria-label="Session overview and savings">
      <div class="ah-fr-topbar">
        <span class="ah-fr-title">SESSION OVERVIEW</span>
        <details class="ah-saved-pill-wrap${hasSessionSavings ? '' : ' ah-saved-zero'}" id="tokensSavedCard" data-rank="4">
          <summary class="ah-saved-pill" id="savedSessionHeadline" title="View estimated session savings breakdown">
            <span class="ah-saved-kicker">Saved</span>
            <strong class="ah-saved-num">${escapeHtml(savedMainTxt)}</strong>
            <span class="ah-saved-30d" id="savedWorkspace30d" title="Tokens saved across all your chats in this workspace over the last 30 days">${escapeHtml(saved30dTxt)}</span>
          </summary>
          <div class="ah-saved-why">
            <div class="ah-saved-driver" id="savedTopDriver">Top driver: ${escapeHtml(driverTxt)}</div>
            <div class="ah-saved-cat-row" id="savedBucketAvoided"><span>Highbeam avoided writes</span><strong>+${escapeHtml(formatTokensCompact(avoidedSess))} tok</strong></div>
            <div class="ah-saved-cat-row" id="savedBucketPlatformCache"><span>Platform cache discount (provider)</span><strong>+${escapeHtml(formatTokensCompact(platformSess))} tok</strong></div>
            ${realizedRowHtml}
            ${catList.map((c) => `<div class="ah-saved-cat-row"><span>${escapeHtml(c.label)}</span><strong>+${escapeHtml(formatTokensCompact(c.savedTokens))} tok</strong></div>`).join('')}
          </div>
        </details>
      </div>
      <div class="ah-sec-blurb">Session pace from Turn 1, turn-by-turn growth, and estimated tokens saved.</div>
      <div class="ah-fr-zones-body">
        <div class="ah-fr-zone">
          <div class="ah-fr-head"><span>TURN PULSE</span><span class="ah-fr-legend" aria-hidden="true"><i class="ah-lg ah-lg-good"></i>clean <i class="ah-lg ah-lg-bad"></i>waste <i class="ah-lg ah-lg-limit"></i>safe limit</span></div>
          <div class="ah-sec-blurb">Memory growth turn by turn. Dark bars mark clean turns, red bars mark waste.</div>
          <div class="ah-tl-chart" id="timelineChart" role="img" aria-label="Per-turn context growth">${bars}${overlay}</div>
          <div class="ah-tl-markers" id="timelineMarkers" aria-hidden="true">${marks}</div>
          <div class="ah-tl-detail" id="timelineDetail">${detail}</div>
        </div>
      </div>
      ${
        proEntitlement &&
        !proEntitlement.entitled &&
        shadowAuto &&
        Number(shadowAuto.incidentCount30d || 0) > 0
          ? `<div class="ah-shadow-auto-row" id="claudeShadowAutoRow" role="note" aria-label="Auto mode counterfactual preview"><div class="ah-shadow-auto-head">${escapeHtml(sanitizeClaudeCopy(shadowAuto.headlineText))}</div><div class="ah-shadow-auto-sub">${escapeHtml(sanitizeClaudeCopy(shadowAuto.sublineText))} &middot; <code>${escapeHtml(shadowAuto.ctaMode === 'upgrade_pro' ? 'npx highbeam-cli license activate <key>' : 'npx highbeam-cli license trial')}</code></div></div>`
          : ''
      }
    </section>`;
}

/**
 * Renders the self-contained Claude Code Highbeam HTML HUD (`horizon_panel.html`).
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

  const offenderSource = (Array.isArray(options.offenders) && options.offenders.length > 0)
    ? options.offenders
    : (Array.isArray(state.offenders) && state.offenders.length > 0 ? state.offenders : null);
  const rawOffenders = offenderSource
    ? offenderSource.slice(0, 4).map((o) => {
        const name = String(o.name || o.target || o.path || 'Context Item');
        const tokens = Math.max(0, Number(o.tokens ?? o.wastedTokens ?? 0));
        const occ = Number(o.occurrences || 0);
        return {
          name,
          tokens,
          occurrences: occ,
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

  const tl = options.sessionTimeline || state.sessionTimeline || null;
  const k = (tl && tl.kpis) || {};
  let runwayText = headroomTokens > 0 ? `${formatTokensCompact(headroomTokens)} headroom` : 'Over safe limit';
  let runwayLevel = headroomTokens <= 0 ? 'bad' : 'good';
  if (k.overLimit || headroomTokens === 0) {
    runwayText = 'Over safe limit';
    runwayLevel = 'bad';
  } else if (k.turnsLeft !== null && k.turnsLeft !== undefined) {
    runwayText = `~${k.turnsLeft} turn${k.turnsLeft === 1 ? '' : 's'} left`;
    runwayLevel = k.turnsLeft <= 3 ? 'bad' : (k.turnsLeft <= 8 ? 'warn' : 'good');
  }
  const burnRateSub = k.burnRateTokens > 0 ? `\u00B7 ${formatTokensCompact(k.burnRateTokens)}/turn` : '';
  const runwaySub = `${formatTokensCompact(grid.totalInputTokens)} / ${grid.zoomTier.id} (${grid.utilizationPct}%) ${burnRateSub}`.trim();
  const ringDashOffset = computeCacheRingDashOffset(metrics.cacheHitPct);
  const ringWarm = Boolean(metrics.cacheWarm);
  const ringExpiring = Boolean(metrics.cacheWarm && metrics.remainingSeconds > 0 && metrics.remainingSeconds <= 60);
  const rawCompactCmd = typeof options.compactCommand === 'string' ? options.compactCommand : (typeof state.compactCommand === 'string' ? state.compactCommand : '');
  const compactCommand = rawCompactCmd.startsWith('/compact ') ? rawCompactCmd : '/compact';
  const compactCommandJs = compactCommand.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const amnesiaAtRisk = Boolean(state.amnesiaRisk || Number(state.anchorsAtRisk || 0) > 0 || state.cliffTriggered || grid.utilizationPct >= 85);
  const hasExplicitOffenders = Boolean(Array.isArray(options.offenders) && options.offenders.length > 0 && grid.tokens.D > 0);
  const usefulTokens = Math.max(0, grid.totalInputTokens - grid.tokens.D);
  const holdWarmActive = Boolean(metrics.cacheWarm && grid.tokens.D > 0 && verdict.severity !== 'critical');

  const rawMaxTok = Math.max(1000, Number(state.maxTokens || state.window?.maxTokens || grid.zoomTier.ceilingTokens || 200000));
  const safeLimitTok = Math.max(1, Number(state.safeLimitTokens || state.window?.safeLimit || Math.round(rawMaxTok * 0.7)));
  const pinnedTok = Math.max(0, Number(grid.tokens.S || 0));
  const reclaimTok = Math.max(0, Number(grid.tokens.D || 0));
  const rawNewActiveTok = Math.max(0, Number(grid.tokens.C || 0) + Number(grid.tokens.W || 0));
  // Synchronize displayed 3-row breakdown with the headline total in #simpleRunwaySub.
  const bScale = grid.totalInputTokens >= 1000000 ? 10000 : (grid.totalInputTokens >= 1000 ? 100 : 1);
  const bTotalU = grid.totalInputTokens >= 100000 && grid.totalInputTokens < 1000000
    ? Math.round(grid.totalInputTokens / 1000) * 10
    : Math.round(grid.totalInputTokens / bScale);
  const bReclaimU = Math.min(bTotalU, Math.round(reclaimTok / bScale));
  const bPinnedU = Math.min(bTotalU - bReclaimU, Math.round(pinnedTok / bScale));
  const bNewU = Math.max(0, bTotalU - bReclaimU - bPinnedU);
  const fmtBreakdownU = (u) => {
    if (u <= 0) return '0';
    if (bScale === 10000) return `${Number((u / 100).toFixed(2))}M`;
    if (bScale === 100) return `${Number((u / 10).toFixed(1))}k`;
    return String(u);
  };
  const dispNewActiveStr = fmtBreakdownU(bNewU);
  const dispReclaimStr = fmtBreakdownU(bReclaimU);
  const dispPinnedStr = fmtBreakdownU(bPinnedU);

  const usedSafePct = Math.round((grid.totalInputTokens / safeLimitTok) * 100);
  const fillPct = Math.min(100, Math.max(0, usedSafePct));
  const freePct = Math.max(0, 100 - fillPct);
  const glassSum = Math.max(1, rawNewActiveTok + reclaimTok + pinnedTok);
  const segNewPct = rawNewActiveTok > 0 ? Number(((rawNewActiveTok / glassSum) * 100).toFixed(1)) : 0;
  const segOldPct = reclaimTok > 0 ? Number(((reclaimTok / glassSum) * 100).toFixed(1)) : 0;
  const segPinPct = pinnedTok > 0 ? Math.max(0, Number((100 - segNewPct - segOldPct).toFixed(1))) : 0;

  const shieldData = options.shield || state.shield || null;
  const rslData = options.rsl || state.rsl || null;
  const proEntitlement = options.proEntitlement || state.proEntitlement || null;
  const shadowAuto =
    options.shadowAuto ||
    state.shadowAuto ||
    (proEntitlement ? computeShadowAutoSummary([], { proEntitlement }) : null);
  const trialDaysNum = Number(proEntitlement?.daysRemaining);
  const trialDaysTxt = Number.isFinite(trialDaysNum) ? (trialDaysNum <= 0 ? '<1' : String(Math.ceil(trialDaysNum))) : '14';
  const flightBadgeLabel =
    metrics.flightMode === 'AUTO_PILOT' && proEntitlement?.tier === 'trial'
      ? `Auto (Trial \u00B7 ${trialDaysTxt}d)`
      : metrics.flightMode;
  const avoidText = metrics.cacheWarm
    ? `Avoid switching models or editing CLAUDE.md/.mcp.json while ${formatTokensCompact(metrics.cachedTokens)} cached prefix reads at 0.10x.`
    : 'Avoid unbounded full-file reads so older instructions and CLAUDE.md rules stay inside the safe limit.';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Highbeam — Claude Code</title>
<style>
  :root {
    color-scheme: dark;
    --bg-canvas: #0B0C0E;
    --bg-surface: #121417;
    --bg-elevated: #1B1E23;
    --hairline: rgba(255, 255, 255, 0.07);
    --text-primary: #F1F3F4;
    --text-secondary: #9AA0A6;
    --text-muted: #80868B;
    --status-critical: #D93025;
    --status-warning: #F29900;
    --status-nominal: #1E8E3E;
    --accent-focus: #1A73E8;
    --font-sans: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Google Sans", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --control-height: 28px;
    --control-radius: 6px;
    --ease-snappy: 140ms cubic-bezier(0.2, 0, 0, 1);

    --bg: var(--bg-canvas);
    --card: var(--bg-surface);
    --card-alt: var(--bg-elevated);
    --border: var(--hairline);
    --fg: var(--text-primary);
    --muted: var(--text-muted);
    --good: var(--status-nominal);
    --warn: var(--status-warning);
    --bad: var(--status-critical);
    --accent: var(--accent-focus);
    --ring-track: var(--bg-elevated);
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg-canvas: #F8F9FA;
      --bg-surface: #FFFFFF;
      --bg-elevated: #F1F3F4;
      --hairline: rgba(0, 0, 0, 0.08);
      --text-primary: #111315;
      --text-secondary: #3C4043;
      --text-muted: #5F6368;
      --status-critical: #D93025;
      --status-warning: #B06000;
      --status-nominal: #137333;
      --accent-focus: #1A73E8;
    }
    .ah-wordmark { filter: invert(1) brightness(0.14); }
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg-canvas: #F8F9FA;
    --bg-surface: #FFFFFF;
    --bg-elevated: #F1F3F4;
    --hairline: rgba(0, 0, 0, 0.08);
    --text-primary: #111315;
    --text-secondary: #3C4043;
    --text-muted: #5F6368;
    --status-critical: #D93025;
    --status-warning: #B06000;
    --status-nominal: #137333;
    --accent-focus: #1A73E8;
  }
  [data-theme="light"] .ah-wordmark { filter: invert(1) brightness(0.14); }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px 12px;
    background: var(--bg-canvas);
    color: var(--text-primary);
    font: 12px/1.4 var(--font-sans);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  .ah-wrap {
    max-width: 420px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
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
    border-bottom: 1px solid var(--hairline);
  }
  .ah-brand-sub { display: inline-block; font-family: var(--font-mono); font-size: 10px; font-weight: 500; color: var(--text-muted); margin-left: 6px; }
  .ah-brand {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    flex-wrap: wrap;
    min-width: 0;
    color: var(--text-primary);
  }
  .ah-wordmark { height: 20px; width: auto; max-width: 100%; object-fit: contain; display: block; }
  .ah-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .ah-logo { width: 24px; height: 24px; border-radius: 6px; flex-shrink: 0; display: block; }
  .ah-tabs.ah-tabs-row { display: flex; }
  .ah-tabs-row .ah-tab-label { flex: 1 1 0; text-align: center; }
  .ah-tabs {
    display: inline-flex;
    background: var(--bg-surface);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 2px;
  }
  .ah-tab-label {
    padding: 2px 8px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--text-muted);
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    transition: opacity var(--ease-snappy);
  }
  #viewModeSimple:checked ~ .ah-wrap .ah-tabs label[for="viewModeSimple"],
  #viewModeAdvanced:checked ~ .ah-wrap .ah-tabs label[for="viewModeAdvanced"] {
    background: var(--bg-elevated);
    color: var(--text-primary);
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
    gap: 0;
  }
  .ah-card {
    background: var(--bg-surface);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 8px 10px;
  }
  /* Full-bleed 1px hairline telemetry rows (preserves #simpleViewContainer .ah-card selector) */
  #simpleViewContainer .ah-card {
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--hairline);
    border-radius: 0;
    padding: 8px 0;
    margin-bottom: 0;
  }
  .ah-verdict-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 4px;
  }
  .ah-verdict-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .ah-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .ah-dot-healthy { background: var(--text-secondary); }
  .ah-dot-warn { background: var(--status-warning); }
  .ah-dot-critical { background: var(--status-critical); }
  .ah-verdict-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ah-pills {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-width: 0;
    padding: 4px 0 6px;
    border-bottom: 1px solid var(--hairline);
  }
  #modelBadge { flex-shrink: 1; margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: right; }
  .ah-pill {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    box-sizing: border-box;
    height: 20px;
    line-height: 18px;
    white-space: nowrap;
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--bg-surface);
    border: 1px solid var(--hairline);
    color: var(--text-secondary);
  }
  .ah-pill-risk {
    color: var(--status-critical);
    border-color: var(--status-critical);
    font-weight: 600;
  }
  .ah-verdict-sub {
    font-size: 10.5px;
    color: var(--text-secondary);
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Runway Hero + 1D Prompt Cache BulletBar (Zero Radial Gauge Chartjunk) */
  .ah-hero-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 10px;
    margin-bottom: 6px;
  }
  .ah-runway-hero {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.2;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
  .ah-runway-hero[data-level="bad"] { color: var(--status-critical); }
  .ah-runway-hero[data-level="warn"] { color: var(--status-warning); }
  .ah-runway-hero[data-level="good"] { color: var(--text-primary); }
  .ah-runway-sub {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-secondary);
    margin-top: 1px;
    font-variant-numeric: tabular-nums;
  }
  .ah-ring-col { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
  .ah-ring-cap { font-size: 9.5px; font-weight: 500; color: var(--text-muted); white-space: nowrap; line-height: 1.1; }
  .ah-cache-ring-wrap {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    flex-shrink: 0;
  }
  .ah-ring-center {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    font-family: var(--font-mono);
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .ah-ring-pct { font-size: 11px; font-weight: 600; color: var(--text-primary); }
  .ah-ring-ttl { font-size: 10px; color: var(--text-secondary); }
  .ah-cache-bullet {
    position: relative;
    width: 68px;
    height: 6px;
    background: var(--bg-elevated);
    border: 1px solid var(--hairline);
    border-radius: 2px;
    overflow: hidden;
  }
  .ah-cache-bullet-fill {
    height: 100%;
    background: var(--text-secondary);
    transition: width var(--ease-snappy);
  }
  .ah-cache-ring-wrap[data-warm="true"] .ah-cache-bullet-fill { background: var(--status-nominal); }
  .ah-cache-ring-wrap[data-expiring="true"] .ah-cache-bullet-fill { background: var(--status-warning); }
  .ah-cache-bullet-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 80%;
    width: 1.5px;
    background: var(--text-muted);
  }
  .ah-sec-blurb { font-size: 10px; line-height: 1.3; color: var(--text-muted); margin: 0 0 4px 0; overflow-wrap: anywhere; }
  .ah-sec-name.ah-sec-gap { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--hairline); }
  .ah-sec-name { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-secondary); line-height: 1.2; margin: 0 0 2px 0; }
  @media (max-height: 580px) { .ah-sec-blurb { display: none; } }
  /* Clean 40-Cell 1D Horizon Bar + Quantitative Legend */
  .ah-grid-bar {
    display: grid;
    grid-template-columns: repeat(40, 1fr);
    gap: 1px;
    height: 7px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--bg-elevated);
    border: 1px solid var(--hairline);
  }
  .ah-cell { display: block; height: 100%; }
  .ah-ruler {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .ah-bar-legend {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 4px;
    font-size: 10.5px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .ah-bar-legend strong { font-family: var(--font-mono); color: var(--text-primary); font-weight: 600; }
  .ah-top-offender {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ah-offender-kicker { font-family: var(--font-sans); font-weight: 600; color: var(--status-warning); }
  .ah-hogs-drawer {
    margin-top: 4px;
    font-size: 10.5px;
    color: var(--text-secondary);
  }
  .ah-hogs-drawer summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-weight: 500;
  }
  .ah-hog-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 3px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .ah-hog-row:last-child { border-bottom: none; }
  .ah-hog-name { font-family: var(--font-mono); color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ah-hog-meta { font-family: var(--font-mono); display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  /* Primary Remediation ActionPill (28px Tactile Control) */
  .ah-action-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .ah-action-instr {
    margin-top: 4px;
    font-size: 10.5px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
  .ah-action-reclaim {
    font-family: var(--font-mono);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    font-weight: 500;
    margin-left: auto;
  }
  .ah-btn-copy-compact {
    cursor: pointer;
    min-height: var(--control-height);
    border-radius: var(--control-radius);
    border: 1px solid var(--hairline);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    flex-shrink: 0;
    transition: opacity var(--ease-snappy), transform var(--ease-snappy);
  }
  .ah-btn-copy-compact:hover { opacity: 0.9; }
  .ah-btn-copy-compact:active { transform: scale(0.985); }
  #priorityActionCard[data-severity="warn"][data-hold="false"] .ah-btn-copy-compact {
    background: var(--accent-focus);
    border-color: var(--accent-focus);
    color: #FFFFFF;
  }
  #priorityActionCard[data-severity="critical"] .ah-btn-copy-compact {
    background: var(--status-critical);
    border-color: var(--status-critical);
    color: #FFFFFF;
  }
  details.ah-overflow {
    margin-top: 5px;
    font-size: 10.5px;
    color: var(--text-secondary);
  }
  details.ah-overflow summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-weight: 500;
  }
  /* Session Activity + Saved Quantitative Row */
  .ah-flight {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ah-fr-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
  }
  .ah-fr-title {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }
  .ah-saved-pill-wrap {
    margin-left: auto;
  }
  .ah-saved-pill {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    cursor: pointer;
    list-style: none;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-surface);
    border: 1px solid var(--hairline);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }
  .ah-saved-pill::-webkit-details-marker { display: none; }
  .ah-saved-kicker { font-family: var(--font-sans); color: var(--text-secondary); font-weight: 600; font-size: 10px; }
  .ah-saved-num { color: var(--text-primary); font-weight: 600; }
  .ah-saved-30d { color: var(--text-muted); font-size: 10px; }
  .ah-saved-why {
    margin-top: 5px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--bg-surface);
    border: 1px solid var(--hairline);
    font-size: 10px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ah-saved-driver { color: var(--text-secondary); font-weight: 600; }
  .ah-saved-cat-row { display: flex; justify-content: space-between; gap: 8px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .ah-fr-zones-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ah-fr-zone { display: flex; flex-direction: column; min-height: 0; }
  .ah-fr-head > span:first-child { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-secondary); }
  .ah-fr-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 9.5px;
    font-weight: 500;
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .ah-fr-count { font-family: var(--font-mono); font-size: 10px; color: var(--text-primary); font-weight: 600; }
  .ah-fr-legend { display: inline-flex; align-items: center; gap: 3px 6px; font-weight: 500; }
  .ah-lg { display: inline-block; width: 6px; height: 6px; border-radius: 1px; }
  .ah-lg-good { background: var(--text-secondary); }
  .ah-lg-bad { background: var(--status-critical); }
  .ah-lg-limit { height: 0; width: 8px; border-radius: 0; border-top: 1px dashed var(--text-muted); }
  .ah-tl-chart {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: clamp(56px, 12vh, 84px);
    margin-top: 3px;
    border-bottom: 1px solid var(--hairline);
  }
  .ah-tl-slot { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; }
  .ah-tl-bar { display: block; width: 100%; min-height: 2px; border-radius: 1px 1px 0 0; }
  .ah-tl-bar.ah-tl-good { background: var(--text-secondary); opacity: 0.75; }
  .ah-tl-bar.ah-tl-bad { background: var(--status-critical); }
  .ah-tl-bar.ah-tl-neutral { background: var(--text-muted); opacity: 0.5; }
  .ah-tl-empty .ah-tl-bar { height: 2px; background: var(--bg-elevated); }
  .ah-tl-earlier .ah-tl-bar { background: repeating-linear-gradient(135deg, var(--text-muted) 0 2px, transparent 2px 4px); }
  .ah-tl-line { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
  .ah-tl-poly-svg { color: var(--text-primary); opacity: 0.85; }
  .ah-tl-limit-svg { color: var(--text-muted); opacity: 0.7; }
  .ah-tl-markers { display: flex; gap: 2px; height: 11px; margin-top: 2px; font-size: 8.5px; line-height: 11px; color: var(--text-muted); }
  .ah-tl-mk { flex: 1 1 0; min-width: 0; text-align: center; overflow: hidden; }
  .ah-tl-detail {
    min-height: 14px;
    margin-top: 2px;
    font-size: 10px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .ah-tl-dot { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--text-muted); }
  .ah-tl-dot.ah-tl-good { background: var(--text-secondary); }
  .ah-tl-dot.ah-tl-bad { background: var(--status-critical); }
  .ah-fx-list { margin-top: 3px; font-variant-numeric: tabular-nums; }
  .ah-fx-empty { padding: 3px 0; font-size: 10.5px; color: var(--text-muted); }
  .ah-fx-row { border-bottom: 1px solid var(--hairline); font-size: 10.5px; }
  .ah-fx-row:last-of-type { border-bottom: none; }
  .ah-fx-row summary {
    display: grid;
    grid-template-columns: 26px auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 6px;
    padding: 3px 0;
    cursor: pointer;
    list-style: none;
  }
  .ah-fx-row summary::-webkit-details-marker { display: none; }
  .ah-fx-turn { font-family: var(--font-mono); color: var(--text-muted); }
  .ah-fx-label { color: var(--text-primary); font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
  .ah-fx-mult { font-family: var(--font-mono); font-size: 9px; padding: 0 4px; border-radius: 4px; background: var(--bg-elevated); border: 1px solid var(--hairline); color: var(--text-secondary); }
  .ah-fx-detail { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ah-fx-saved { font-family: var(--font-mono); color: var(--text-primary); font-weight: 600; }
  .ah-fx-more { padding: 0 0 4px 32px; font-size: 10px; color: var(--text-muted); overflow-wrap: anywhere; }
  .ah-fx-overflow summary { cursor: pointer; font-size: 10px; color: var(--text-secondary); padding: 3px 0; }
  .ah-fx-rail-armed {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 4px;
    margin-top: 3px;
    border-top: 1px solid var(--hairline);
    font-size: 10px;
    color: var(--text-muted);
  }
  .ah-rail-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--status-nominal); flex-shrink: 0; }
  @media (max-height: 580px) {
    #simpleViewContainer[data-verdict-state="healthy"] .ah-fr-zones-body {
      display: none;
    }
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
  /* Wave 3: 4-Card Tufte Sketch Glass-of-Water & Direct Guidance Layout */
  html, body { overflow-x: hidden; max-width: 100%; }
  #claudeSimpleSurface { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .ts-card { display: flex; flex-direction: column; gap: 4px; }
  .ts-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .ts-context-split { display: grid; grid-template-columns: minmax(0, 1fr) 74px; gap: 10px; align-items: stretch; margin: 4px 0; }
  .ts-context-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .ts-cat-list { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; }
  .ts-cat-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 6px; }
  .ts-swatch-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .ts-cat-meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
  .ts-cat-name { font-weight: 600; color: var(--text-primary); font-size: 10.5px; }
  .ts-cat-sub { font-size: 9.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ts-cat-val { font-family: var(--font-mono); font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .ts-glass-col { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .ts-glass-vessel { position: relative; width: 60px; height: 108px; border: 1px solid var(--hairline); border-radius: 6px; background: var(--bg-elevated); overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; }
  .ts-glass-headroom-label { position: absolute; top: 4px; left: 4px; right: 4px; text-align: center; font-family: var(--font-mono); font-size: 8.5px; font-weight: 600; color: var(--text-primary); background: var(--bg-surface); border-radius: 3px; padding: 0 2px; opacity: 0.92; z-index: 2; pointer-events: none; }
  .ts-glass-safe-line { position: absolute; left: 0; right: 0; top: 14%; border-top: 1px dashed var(--text-muted); opacity: 0.7; z-index: 2; pointer-events: none; }
  .ts-glass-fill { width: 100%; display: flex; flex-direction: column; justify-content: flex-end; transition: height var(--ease-snappy); }
  .ts-glass-seg { width: 100%; min-height: 1px; }
  .ts-glass-seg-new { background: var(--accent-focus); }
  .ts-glass-seg-old { background: var(--status-warning); }
  .ts-glass-seg-pinned { background: var(--text-secondary); }
  .ts-glass-caption { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ts-guidance-row { display: grid; grid-template-columns: 44px minmax(0, 1fr); align-items: start; gap: 6px; padding: 5px 7px; border: 1px solid var(--hairline); border-radius: 5px; background: var(--bg-surface); font-size: 10.5px; color: var(--text-primary); }
  .ts-tag { font-family: var(--font-mono); font-size: 9px; font-weight: 700; text-align: center; padding: 1px 4px; border-radius: 3px; background: var(--bg-elevated); border: 1px solid var(--hairline); color: var(--text-primary); }
  .ts-guidance-row[data-tone="do"] .ts-tag { border-color: var(--status-nominal); }
  .ts-guidance-row[data-tone="avoid"] .ts-tag { border-color: var(--status-warning); }
  .ts-drawer { margin-top: 4px; font-size: 10.5px; color: var(--text-secondary); }
  .ts-drawer summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 6px; font-weight: 600; color: var(--text-secondary); }
  .ts-drawer-body { margin-top: 4px; font-size: 10px; color: var(--text-secondary); line-height: 1.35; }
  .ts-kpi-sub { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .ts-signal-row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .ts-guard-list { list-style: none; margin: 5px 0 0 0; padding: 0; max-height: 150px; overflow-y: auto; border-top: 1px solid var(--hairline); }
  .ts-guard-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--hairline); font-size: 10px; }
  .ts-guard-id { font-family: var(--font-mono); color: var(--text-muted); }
  .ts-guard-name { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ts-guard-role { font-family: var(--font-mono); font-size: 9px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--hairline); text-transform: uppercase; color: var(--text-secondary); }
  .ts-role-tripped { color: var(--text-primary); border-color: var(--status-critical); background: rgba(217, 48, 37, 0.16); font-weight: 700; }
  .ts-role-blocks { color: var(--text-primary); }
  .ts-role-advises { color: var(--text-muted); }
  .ah-saved-zero .ah-saved-pill { opacity: 0.72; }
  /* Explicit Dark Theme Override & Strict <=340px Zero-Overflow Wrapping */
  [data-theme="dark"] {
    color-scheme: dark;
    --bg-canvas: #0B0C0E;
    --bg-surface: #121417;
    --bg-elevated: #1B1E23;
    --hairline: rgba(255, 255, 255, 0.08);
    --text-primary: #F1F3F4;
    --text-secondary: #9AA0A6;
    --text-muted: #80868B;
    --status-critical: #D93025;
    --status-warning: #F29900;
    --status-nominal: #1E8E3E;
    --accent-focus: #1A73E8;
  }
  [data-theme="dark"] .ah-wordmark { filter: none; }
  .ah-wrap, #claudeSimpleSurface, .ah-card, .ts-card, .ts-context-info, .ts-cat-meta, .ts-guidance-row > *, .ah-fr-zone { min-width: 0; max-width: 100%; }
  .ah-pills { flex-wrap: wrap; }
  .ts-card-head { flex-wrap: wrap; min-width: 0; }
  .ah-verdict-row { flex: 1 1 140px; min-width: 0; margin-bottom: 0; justify-content: flex-end; }
  .ah-verdict-left { min-width: 0; overflow: hidden; }
  .ts-context-split { grid-template-columns: minmax(0, 1fr) 64px; gap: 8px; }
  .ts-glass-vessel { width: 58px; }
  .ah-action-hdr { flex-wrap: wrap; min-width: 0; }
  .ah-action-instr { overflow-wrap: anywhere; }
  .ts-drawer summary { flex-wrap: wrap; min-width: 0; }
  .ah-fr-topbar, .ah-fr-head, .ah-saved-pill { flex-wrap: wrap; white-space: normal; min-width: 0; max-width: 100%; }
  .ah-shadow-auto-row { margin-top: 6px; padding: 6px 8px; border-radius: 5px; border: 1px solid var(--hairline); border-left: 2px solid var(--accent-focus); background: var(--bg-elevated); display: flex; flex-direction: column; gap: 2px; min-width: 0; max-width: 100%; }
  .ah-shadow-auto-head { font-size: 10.5px; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
  .ah-shadow-auto-sub { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
</style>
</head>
<body>
<input class="ah-view-radio" type="radio" name="ah-view" id="viewModeSimple" ${initialView === 'simple' ? 'checked' : ''}>
<input class="ah-view-radio" type="radio" name="ah-view" id="viewModeAdvanced" ${initialView === 'advanced' ? 'checked' : ''}>
<div class="ah-wrap" id="ahPanelRoot">
  <header class="ah-topbar">
    <span class="ah-brand"><img class="ah-wordmark" src="data:image/png;base64,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" width="161" height="26" alt="Highbeam"><span class="ah-sr-only">Highbeam</span><span class="ah-brand-sub">Claude Code</span></span>
    <img class="ah-logo" src="data:image/png;base64,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" width="26" height="26" alt="" aria-hidden="true">
  </header>
  <nav class="ah-tabs ah-tabs-row" aria-label="View Mode">
      <label class="ah-tab-label" for="viewModeSimple" id="tabSimple">Simple</label>
      <label class="ah-tab-label" for="viewModeAdvanced" id="tabAdvanced">Advanced</label>
  </nav>

  <!-- SIMPLE VIEW: 4-Card Tufte Sketch Glass-of-Water Layout -->
  <main id="simpleViewContainer" data-verdict-state="${escapeHtml(verdict.severity)}">
    <div id="claudeSimpleSurface" aria-label="Highbeam Simple View">
      <div class="ah-pills" id="activeChatPills">
        <span class="ah-pill${amnesiaAtRisk ? ' ah-pill-risk' : ''}" id="simpleAmnesiaPill" title="Memory check: whether your rules and pinned instructions are still inside the AI's working memory.">${amnesiaAtRisk ? 'Memory: anchors at risk' : 'Memory: anchors pinned'}</span>
        <span class="ah-pill" id="flightModeBadge">${escapeHtml(flightBadgeLabel)}</span>
        <span class="ah-pill" id="modelBadge" title="Active model. Switching model or effort mid-session rewrites the prompt cache, so the next turn costs full price.">Model: ${escapeHtml(state.modelLabel || grid.modelId)}</span>
      </div>

      <!-- Card 1: CONTEXT + Reversed Glass-of-Water Vertical Gauge -->
      <section class="ah-card ts-card" id="capacityAndCacheCard" data-severity="${escapeHtml(verdict.severity)}" data-hold="${holdWarmActive ? 'true' : 'false'}" data-rank="1">
        <div class="ts-card-head">
          <span class="ah-sec-name">Context</span>
          <div class="ah-verdict-row" id="verdictBanner">
            <div class="ah-verdict-left">
              <span class="ah-dot ah-dot-${escapeHtml(verdict.severity)}"></span>
              <span class="ah-verdict-title" id="verdictHeadline">${escapeHtml(verdict.headline)}</span>
            </div>
          </div>
        </div>
        <div class="ah-sec-blurb">How full the AI's working memory is. Past the safe limit it starts forgetting your earliest instructions.</div>

        <div class="ts-context-split">
          <div class="ts-context-info">
            <div class="ah-runway-hero" id="simpleRunwayHero" data-level="${escapeHtml(runwayLevel)}">${escapeHtml(runwayText)}</div>
            <div class="ah-runway-sub" id="simpleRunwaySub">${escapeHtml(runwaySub)}</div>

            <div class="ts-cat-list" role="list" aria-label="Context breakdown from newest to oldest">
              <div class="ts-cat-row" role="listitem">
                <span class="ts-swatch-dot" style="background:var(--accent-focus);" aria-hidden="true"></span>
                <div class="ts-cat-meta"><span class="ts-cat-name">New &amp; active</span><span class="ts-cat-sub">Current files &amp; replies</span></div>
                <strong class="ts-cat-val">${escapeHtml(dispNewActiveStr)}</strong>
              </div>
              <div class="ts-cat-row" role="listitem">
                <span class="ts-swatch-dot" style="background:var(--status-warning);" aria-hidden="true"></span>
                <div class="ts-cat-meta"><span class="ts-cat-name">Reclaimable</span><span class="ts-cat-sub">Older chat &amp; repeat reads</span></div>
                <strong class="ts-cat-val">${escapeHtml(dispReclaimStr)}</strong>
              </div>
              <div class="ts-cat-row" role="listitem">
                <span class="ts-swatch-dot" style="background:var(--text-secondary);" aria-hidden="true"></span>
                <div class="ts-cat-meta"><span class="ts-cat-name">Rules &amp; tools</span><span class="ts-cat-sub">Pinned in CLAUDE.md &amp; MCP</span></div>
                <strong class="ts-cat-val">${escapeHtml(dispPinnedStr)}</strong>
              </div>
            </div>

            <div class="ah-hero-row">
              <div class="ah-ring-col">
                <span class="ah-ring-cap">Prompt cache</span>
                <div class="ah-cache-ring-wrap" id="simpleCacheRingWrap" role="img" aria-label="Prompt cache" data-warm="${ringWarm ? 'true' : 'false'}" data-expiring="${ringExpiring ? 'true' : 'false'}" title="Prompt cache ${ringWarm ? `warm ${metrics.ttlClock} (${metrics.ttlTier})` : 'cold'} · ${metrics.cacheHitPct}% hit. 'hit' = share of your prompt served from cache at a discount; 'warm' = time left before the cache expires and the next turn costs full price.">
                  <div class="ah-ring-center">
                    <span class="ah-ring-pct" id="simpleCacheRingPct">${metrics.cacheHitPct}%</span>
                    <span class="ah-ring-ttl" id="simpleCacheRingTtl">${escapeHtml(metrics.cacheWarm ? metrics.ttlCompact : 'cold')}</span>
                  </div>
                  <div class="ah-cache-bullet" aria-hidden="true">
                    <div class="ah-cache-bullet-fill" style="width:${Math.max(0, Math.min(100, Number(metrics.cacheHitPct) || 0))}%"></div>
                    <div class="ah-cache-bullet-tick" title="80% cache hit target"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="ts-glass-col">
            <div id="ccGlassVessel" class="ts-glass-vessel" role="img" aria-label="Vertical context fill gauge from pinned rules at bottom to new active work on top">
              <span id="ccGlassHeadroom" class="ts-glass-headroom-label">${freePct}% free</span>
              <div id="ccGlassSafeLine" class="ts-glass-safe-line" title="Safe limit line"></div>
              <div id="ccGlassFill" class="ts-glass-fill" style="height:${fillPct}%">
                <div id="ccGlassSegNew" class="ts-glass-seg ts-glass-seg-new" style="height:${segNewPct}%" title="New &amp; active: ${escapeHtml(dispNewActiveStr)}"></div>
                <div id="ccGlassSegOld" class="ts-glass-seg ts-glass-seg-old" style="height:${segOldPct}%" title="Reclaimable clutter: ${escapeHtml(dispReclaimStr)}"></div>
                <div id="ccGlassSegPinned" class="ts-glass-seg ts-glass-seg-pinned" style="height:${segPinPct}%" title="Rules &amp; tools: ${escapeHtml(dispPinnedStr)}"></div>
              </div>
            </div>
            <span id="ccGlassCaption" class="ts-glass-caption">${grid.totalInputTokens > safeLimitTok ? 'Over safe limit' : `${usedSafePct}% of safe`}</span>
          </div>
        </div>

        <div class="ah-grid-bar" id="horizonGridBar" role="img" aria-label="40-Cell Context Horizon Bar">
          ${renderHtmlHorizonCells(grid)}
        </div>
        <div class="ah-ruler">
          <span>0k</span>
          <span>${escapeHtml(midTickLabel)}</span>
          <span>${escapeHtml(maxTickLabel)}</span>
        </div>

        <div class="ah-bar-legend">
          <span>Useful <strong id="statUsed">${escapeHtml(`${formatTokensCompact(usefulTokens)} / ${grid.zoomTier.id}`)}</strong></span>
          <span>Reclaimable <strong id="statDebt">${escapeHtml(formatTokensCompact(grid.tokens.D))}</strong></span>
          <span>Free <strong id="statHeadroom">${escapeHtml(formatTokensCompact(headroomTokens))}</strong></span>
        </div>
        <div class="ah-verdict-sub" id="verdictDetail">${escapeHtml(verdict.detail)}</div>

        ${
          hasExplicitOffenders
            ? `<div class="ah-sec-name ah-sec-gap">Waste &amp; prompt cache</div>
          <div class="ah-sec-blurb">Files and old errors wasting memory that you can free, plus when the prompt cache expires.</div>
          <div class="ah-top-offender" id="simpleTopOffender"><span class="ah-offender-kicker">Cause:</span> ${escapeHtml(
                rawOffenders
                  .slice(0, 2)
                  .map((o) => {
                    const shortName = String(o.name).replace(/\\/g, '/').split('/').filter(Boolean).pop() || o.name;
                    return o.occurrences > 1
                      ? `${shortName} (${o.occurrences}x · ${formatTokensCompact(o.tokens)})`
                      : `${shortName} (${formatTokensCompact(o.tokens)})`;
                  })
                  .join(' · ')
              )}</div>
              <details class="ah-hogs-drawer" id="simpleTopHogsDrawer">
                <summary>Top context hogs (${rawOffenders.length})</summary>
                ${rawOffenders
                  .slice(0, 3)
                  .map((o) => {
                    const shortName = String(o.name).replace(/\\/g, '/').split('/').filter(Boolean).pop() || o.name;
                    return `<div class="ah-hog-row"><span class="ah-hog-name">${escapeHtml(shortName)}</span><span class="ah-hog-meta">${o.ignorable ? '<span class="adv-badge-ignore">.claudeignore</span>' : ''}<strong>${escapeHtml(formatTokensCompact(o.tokens))}</strong> (${o.pct}%)</span></div>`;
                  })
                  .join('')}
              </details>`
            : ''
        }
      </section>

      <!-- Card 2: DIRECT GUIDANCE (DO / AVOID / Copy /compact) -->
      <section class="ah-card ts-card" id="priorityActionCard" data-severity="${escapeHtml(verdict.severity)}" data-hold="${holdWarmActive ? 'true' : 'false'}" data-rank="3">
        <div class="ts-card-head">
          <span class="ah-sec-name">Direct guidance</span>
          <span class="ts-kpi-sub">${metrics.cacheWarm ? 'Model: Hold · Effort: Hold' : 'Model: OK · Effort: OK'}</span>
        </div>
        <div class="ah-sec-blurb">The highest-leverage step right now and what to avoid to protect your cache.</div>
        <div id="ccDoRow" class="ts-guidance-row" data-tone="do">
          <span class="ts-tag">DO</span>
          <span id="priorityActionTitle">${escapeHtml(priorityAction.title)}</span>
        </div>
        <div class="ah-action-hdr">
          <span class="ah-action-reclaim" id="compactReclaim">${escapeHtml(compactReclaimText)}</span>
          <button type="button" class="ah-btn-copy-compact" id="btnCompactPrimary" onclick="navigator.clipboard&&navigator.clipboard.writeText('${escapeHtml(compactCommandJs)}')">Copy /compact</button>
        </div>
        <div class="ah-action-instr" id="compactInstruction">${escapeHtml(compactInstructionText)}</div>
        <div id="ccAvoidRow" class="ts-guidance-row" data-tone="avoid">
          <span class="ts-tag">AVOID</span>
          <span>${escapeHtml(avoidText)}</span>
        </div>
        <details class="ts-drawer" id="ccSwitchDetailsDrawer">
          <summary><span>Model &amp; effort switching</span><span class="ts-kpi-sub">C*: ${escapeHtml(breakEven.breakEvenTokens.toLocaleString('en-US'))} tok &rarr; ${escapeHtml(peerModel)}</span></summary>
          <div class="ts-drawer-body">${metrics.cacheWarm ? `Cache is warm (${metrics.ttlCompact} left). Switching models rebuilds ${escapeHtml(formatTokensCompact(metrics.cachedTokens))} uncached.` : 'Cache is cold — switching model or effort adds zero rewrite penalty.'}</div>
        </details>
        ${
          overflowActionCount > 0
            ? `<details class="ah-overflow"><summary>+${overflowActionCount} more optimization${overflowActionCount === 1 ? '' : 's'}</summary><ul>${secondaryActions.map((a) => `<li><strong>${escapeHtml(a.title)}:</strong> ${escapeHtml(a.instruction)}</li>`).join('')}</ul></details>`
            : ''
        }
      </section>

      <!-- Card 3: AUTOMATED ACTIVITY & Live Guard Roster -->
      ${renderAutomatedActivityHtml(options.autoFixLog || state.autoFixLog || null, options.breakerVerdict || null, shieldData, rslData)}

      <!-- Card 4: SESSION OVERVIEW & Turn Pulse + Canonical Saved Pill -->
      ${renderSessionOverviewHtml(tl, metrics, catList, shadowAuto, proEntitlement)}
    </div>
  </main>

  <!-- ADVANCED VIEW: 5 Progressive-Disclosure Accordions -->
  <section id="advancedViewContainer">
    <!-- Accordion 1: Estimated 5-Category Savings & Anthropic Cache ROI -->
    <details class="adv-accordion" id="advSavingsAccordion" open>
      <summary>
        <span>1. Estimated Token Savings &amp; Cache Efficiency</span>
        <span>+${escapeHtml(formatTokensCompact(metrics.sessionSavedTokens))} tokens</span>
      </summary>
      <div class="adv-body">
        <div class="adv-row" id="advBucketAvoided"><span>Highbeam Avoided Writes (Session / 30d)</span><strong>+${escapeHtml(formatTokensCompact(metrics.savingsBuckets?.avoidedWrites?.sessionTokens || 0))} / +${escapeHtml(formatTokensCompact(metrics.savingsBuckets?.avoidedWrites?.workspace30dTokens || 0))} tok</strong></div>
        <div class="adv-row" id="advBucketPlatformCache"><span>Platform Cache Discount (Provider KV)</span><strong>+${escapeHtml(formatTokensCompact(metrics.savingsBuckets?.platformCacheDiscount?.sessionTokens || 0))} tok</strong></div>
        ${
          Number(metrics.savingsBuckets?.realizedPromptBill?.count || 0) > 0
            ? `<div class="adv-row" id="advBucketRealized"><span>Ex-Post Realized Prompt-Bill Delta</span><strong>${metrics.savingsBuckets.realizedPromptBill.tokens >= 0 ? '+' : '-'}${escapeHtml(formatTokensCompact(Math.abs(metrics.savingsBuckets.realizedPromptBill.tokens)))} tok</strong></div>`
            : ''
        }
        ${catList
          .map(
            (c) =>
              `<div class="adv-row"><span>${escapeHtml(c.label)}</span><strong>+${escapeHtml(formatTokensCompact(c.savedTokens))} tok</strong></div>`
          )
          .join('')}
        <div class="adv-row"><span>Break-Even Gravity C* (${escapeHtml(grid.modelId)} &rarr; ${escapeHtml(peerModel)})</span><strong>${escapeHtml(breakEven.breakEvenTokens.toLocaleString('en-US'))} tok</strong></div>
        <div class="adv-row"><span>Reads / Write Ratio (Break-Even &ge; ${escapeHtml(metrics.breakEvenReadsPerWrite)})</span><strong>${escapeHtml(metrics.readsPerWriteRatio.toFixed(2))}</strong></div>
        <div class="adv-row"><span>Corporate Expense Receipt (PDF 1.4)</span><strong>npx ah receipt --pdf</strong></div>
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

    <!-- Accordion 3: 6 Core Auditable Guards (DET-01..32), Thinking Drift & Retention -->
    <details class="adv-accordion" id="advBreakersAccordion">
      <summary>
        <span>3. 6 Core Auditable Guards (32 rules) &amp; Thinking Drift</span>
        <span>${escapeHtml(summarizeCoreAuditableGuards((options.breakerVerdict?.triggered ? options.breakerVerdict.detectorId : null) || state.coachState?.detectors?.tripped?.detectorId || state.circuitBreakerTripped?.detectorId || null).label)}</span>
      </summary>
      <div class="adv-body">
        <div class="adv-row"><span>Flight Mode</span><strong>${escapeHtml(metrics.flightMode)}</strong></div>
        <div class="adv-row"><span>Prefix Retention</span><strong>${escapeHtml(formatRetentionLabel(state.prefixRetention))}</strong></div>
        <div class="adv-row"><span>Thinking Drift (DET-30)</span><strong>${escapeHtml(formatDriftLabel(state.thinkingDrift))}</strong></div>
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
                    `<div class="adv-row"><span>${escapeHtml(w.agentId)} (${escapeHtml(w.state)}${w.state === 'waiting' ? ' 0 tok' : ''})</span><strong>${escapeHtml(formatTokensCompact(w.totalTokens))} · ${w.turns}t</strong></div>`
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
