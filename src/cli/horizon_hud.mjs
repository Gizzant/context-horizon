import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalizePath } from '../core/path_canonicalizer.mjs';
import {
  readSidecarSync,
  writeSidecarAtomicSync,
  writeJsonAtomicSync,
  readToolUsageSync,
  createDefaultSidecar
} from '../core/sidecar_store.mjs';
import { resolveAndReadTranscriptIncremental } from '../core/log_resolver.mjs';
import { classifyHorizonWindow, CATEGORIES } from '../core/horizon_classifier.mjs';
import { runAllBlindspotSensors } from '../core/blindspot_sensors.mjs';
import { CATEGORIES as H_CATEGORIES, CATEGORY_METADATA, scaleEffortProfileForCeiling, resolveModelCeiling } from '../core/constants.mjs';
import { findSessionDirectory, parseTranscriptIncremental, reconcileWorkspaceAndKIs, resolveSessionModel } from '../core/parser.mjs';
import { classifyHorizon } from '../core/classifier.mjs';
import { getHomeDir, ensureSupportedNodeVersion } from '../core/paths.mjs';
import { recordAndDelta } from '../core/history.mjs';
import { loadSettings, resolveWindow } from '../core/settings.mjs';
import { measureBaseline } from '../core/baseline.mjs';
import { updateChronicReads } from '../core/offenders.mjs';
import { computePlanChurn, gradeProofQuality, detectContextRot } from '../core/session_forensics.mjs';
import { auditHandoff } from '../core/handoff_audit.mjs';
import { inspectHostProcesses } from '../core/host_watchdog.mjs';
import { loadFlightcheckConfig } from '../core/config.mjs';
import { buildDemoHorizonState, DEMO_SCENARIOS } from '../demo/synthetic_states.mjs';
import { buildActionQueue, formatActionQueueAnsi } from '../core/action_queue.mjs';
import { renderHorizonPanelHtml } from '../core-isomorphic/ui/horizonPanelHtml.mjs';

export { buildActionQueue, formatActionQueueAnsi, renderHorizonPanelHtml };

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str = '') {
  return String(str).replace(ANSI_ESCAPE_RE, '');
}

export function visibleWidth(str = '') {
  return Array.from(stripAnsi(str)).length;
}

export function clampAnsiLine(line = '', maxCols = 80) {
  const limit = Math.max(10, Number(maxCols) || 80);
  const raw = String(line || '');
  if (visibleWidth(raw) <= limit) return raw;
  let vis = 0;
  let out = '';
  let i = 0;
  let hadAnsi = false;
  const target = Math.max(1, limit - 1);
  while (i < raw.length && vis < target) {
    if (raw[i] === '\x1b') {
      const m = raw.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        hadAnsi = true;
        continue;
      }
    }
    const cp = raw.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out += ch;
    i += ch.length;
    vis += 1;
  }
  return `${out}…${hadAnsi ? '\x1b[0m' : ''}`;
}

export function clampAnsiText(text = '', maxCols = 80) {
  return String(text || '')
    .split('\n')
    .map(l => clampAnsiLine(l, maxCols))
    .join('\n');
}

const FALLBACK_BAR = '\x1b[38;5;244m[░░░░░░░░░░░░░░░░░░░░] Purity: 100% | Noise: 0k | Quota: 100% | Effort: OK\x1b[0m';

function safeExitFallback() {
  try { console.log(FALLBACK_BAR); } catch {}
  process.exit(0);
}

const ANSI_COLORS = {
  [CATEGORIES.ANCHOR_CORE]: '\x1b[38;5;51m█\x1b[0m',
  [CATEGORIES.ANCHOR_SCHEMA]: '\x1b[38;5;30m▒\x1b[0m',
  [CATEGORIES.MEMORY_KI]: '\x1b[38;5;141m▓\x1b[0m',
  [CATEGORIES.MEMORY_BLEED]: '\x1b[38;5;205m▓\x1b[0m',
  [CATEGORIES.ACTIVE_SET]: '\x1b[38;5;82m█\x1b[0m',
  [CATEGORIES.STALE_DUP]: '\x1b[38;5;214m▒\x1b[0m',
  [CATEGORIES.DIRTY_SNAP]: '\x1b[38;5;214m▒\x1b[0m',
  [CATEGORIES.LEGACY_POISON]: '\x1b[38;5;208m▒\x1b[0m',
  [CATEGORIES.DEAD_ERROR]: '\x1b[38;5;196m▓\x1b[0m',
  [CATEGORIES.FREE_HEADROOM]: '\x1b[38;5;240m░\x1b[0m'
};

async function readStdinSafe(timeoutMs = 150) {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => {
      resolve(parseJsonSafe(raw));
    }, timeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(parseJsonSafe(raw));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

function parseJsonSafe(str) {
  try {
    const trimmed = str ? str.trim() : '';
    return trimmed ? JSON.parse(trimmed) : {};
  } catch {
    return {};
  }
}

function scanKnowledgeItems() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const kiRoot = path.join(home, '.gemini', 'antigravity', 'knowledge');
  const items = [];
  if (!fs.existsSync(kiRoot)) return items;

  try {
    const dirs = fs.readdirSync(kiRoot, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory()) {
        const metaPath = path.join(kiRoot, d.name, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            items.push(meta);
          } catch {}
        }
      }
    }
  } catch {}
  return items;
}

export async function runHud(options = {}) {
  try {
    const stdinData = options.stdinData !== undefined ? options.stdinData : await readStdinSafe(150);
    const columns = options.columns || process.stdout.columns || 120;
    const conversationId = stdinData.conversation_id || stdinData.session_id || 'default_session';
    const workspacePath = canonicalizePath(stdinData.workspacePath || process.cwd());
    const config = options.configOverride || loadFlightcheckConfig();

    let sidecar = readSidecarSync(conversationId);
    if (!sidecar.conversationId) {
      sidecar = createDefaultSidecar(conversationId, workspacePath);
    }

    // Extract native statusLine telemetry
    const ctxWindow = stdinData.context_window || {};
    const totalInputTokens = ctxWindow.total_input_tokens || sidecar.telemetry.totalInputTokens || 0;
    const usedPercentage = ctxWindow.used_percentage || sidecar.telemetry.usedPercentage || 0;
    const exceeds200k = Boolean(ctxWindow.exceeds_200k_tokens);
    const modelName = stdinData.modelName || stdinData.model?.id || sidecar.sessionMeta.activeModel || 'gemini-3.8-flash';
    const mode = stdinData.mode || sidecar.telemetry.mode || 'auto';
    const agentState = stdinData.agent_state || sidecar.telemetry.agentState || 'idle';

    // Extract minimum quota fraction
    let minQuotaFraction = 1.0;
    if (stdinData.quota) {
      if (typeof stdinData.quota.remaining_fraction === 'number') {
        minQuotaFraction = stdinData.quota.remaining_fraction;
      } else if (stdinData.quota.buckets) {
        for (const b of Object.values(stdinData.quota.buckets)) {
          if (typeof b.remaining_fraction === 'number') {
            minQuotaFraction = Math.min(minQuotaFraction, b.remaining_fraction);
          }
        }
      }
    }

    // Incremental log resolution
    const logCursor = sidecar.cursor || {};
    const logState = resolveAndReadTranscriptIncremental(conversationId, logCursor);

    // Knowledge Items & Sensors
    const kis = scanKnowledgeItems();
    const toolLedger = readToolUsageSync();
    const sensorResults = runAllBlindspotSensors({
      stepEvents: logState.parsedEvents,
      sidecarState: sidecar,
      workspacePath,
      targetFiles: sidecar.fileState.activeSetPaths,
      activeSetPaths: sidecar.fileState.activeSetPaths,
      toolUsageLedger: toolLedger,
      promptText: '',
      config
    });

    // 40-Cell Classifier
    const classification = classifyHorizonWindow(
      logState.parsedEvents,
      { total_input_tokens: totalInputTokens, modelName },
      workspacePath,
      kis,
      config,
      sensorResults
    );

    // Update sidecar atomically
    sidecar.updatedAtMs = Date.now();
    sidecar.cursor = { filePath: logState.filePath, byteOffset: logState.byteOffset, tier: logState.tier };
    sidecar.sessionMeta.activeModel = modelName;
    sidecar.sessionMeta.inPlanMode = mode === 'plan';
    sidecar.telemetry = {
      totalInputTokens: classification.totalInputTokens,
      usedPercentage,
      exceeds200kTokens: exceeds200k,
      signalPurityPct: classification.metrics.signalPurityPct,
      sludgeTaxUsdPerTurn: classification.metrics.sludgeTaxUsdPerTurn,
      amputationRisk: classification.flags.amputationRisk,
      confidence: classification.confidence || 'HIGH',
      parseHealth: classification.parseHealth || null,
      ceilingSource: classification.model?.ceilingSource || 'fallback',
      agentState,
      mode,
      quota: {
        remaining_fraction: minQuotaFraction,
        remaining_amount: stdinData.quota?.remaining_amount ?? null,
        reset_in_seconds: stdinData.quota?.reset_in_seconds ?? 0,
        buckets: stdinData.quota?.buckets || {}
      },
      history: (sidecar.telemetry.history || []).slice(-19).concat([{
        turn: sidecar.sessionMeta.turnCount,
        purity: classification.metrics.signalPurityPct,
        sludge: classification.metrics.sludgeTaxUsdPerTurn
      }])
    };
    sidecar.cells = classification.cells;
    sidecar.fileState = {
      ...sidecar.fileState,
      activeSetPaths: classification.fileState.activeSetPaths,
      staleDupPaths: classification.fileState.staleDupPaths,
      dirtySnapshotPaths: sensorResults.dirtySnapshotPaths,
      legacyPoisonPaths: classification.fileState.legacyPoisonPaths,
      unseenCallers: sensorResults.unseenCallers,
      streamCutoffRiskFiles: sensorResults.streamCutoffRiskFiles,
      foreignBleedKiIds: classification.fileState.foreignBleedKiIds
    };
    const planChurn = computePlanChurn(logState.parsedEvents, config);
    const proofQuality = gradeProofQuality(logState.parsedEvents);
    const contextRot = detectContextRot(logState.parsedEvents, {
      totalActiveTokens: totalInputTokens,
      correctionCount: 0,
      lateStageTaskChurn: planChurn.lateStageTaskChurn,
      signalPurityPct: classification.metrics.signalPurityPct
    }, config);
    const handoff = auditHandoff(workspacePath, {
      planChurn,
      errorLoop: { loop: sensorResults.threeStrikeLoop, fingerprint: sensorResults.loopFingerprint },
      deadErrors: { isErrorLoop: sensorResults.threeStrikeLoop },
      activeSignal: { taskMdTurnsBehind: 0 }
    });

    sidecar.sensors = {
      schemaTaxPct: sensorResults.schemaTaxPct,
      unusedMcpServers: sensorResults.unusedMcpServers,
      oversizedPayloadDetected: sensorResults.oversizedPayloadDetected,
      quotaFloorBreached: sensorResults.quotaFloorBreached,
      planToFlashHandoffNeeded: sensorResults.planToFlashHandoffNeeded,
      threeStrikeLoop: sensorResults.threeStrikeLoop,
      loopFingerprint: sensorResults.loopFingerprint || null,
      uncheckpointedGitDrift: sensorResults.uncheckpointedGitDrift,
      dirtyGitFileCount: sensorResults.dirtyGitFileCount,
      planRevisions: planChurn.planRevisions,
      planRevisionWarn: planChurn.warn,
      proofQuality: proofQuality.grade,
      proofQualityReason: proofQuality.reason,
      splitRecommended: contextRot.splitRecommended,
      splitReason: contextRot.reason
    };

    sidecar.handoff = {
      result: handoff.result,
      targetFile: handoff.targetFile,
      failingChecks: handoff.checks.filter(c => !c.pass).map(c => c.name),
      fixes: handoff.fixes
    };

    writeSidecarAtomicSync(conversationId, sidecar);

    // Format ANSI status line
    const isAmputation = classification.flags.amputationRisk;
    const isFullMode = columns >= 120;
    const cellCount = isFullMode ? 40 : 20;
    const downsampleRatio = 40 / cellCount;

    let glyphStrip = '';
    for (let i = 0; i < cellCount; i++) {
      const origIdx = Math.floor(i * downsampleRatio);
      const cell = classification.cells[origIdx] || { dominantCategory: CATEGORIES.FREE_HEADROOM };
      const glyph = ANSI_COLORS[cell.dominantCategory] || ANSI_COLORS[CATEGORIES.FREE_HEADROOM];

      if (isAmputation && origIdx === 0) {
        glyphStrip += '\x1b[38;5;196m![\x1b[0m';
      }
      glyphStrip += glyph;
      if (isAmputation && origIdx === 7 && (isFullMode ? i === 7 : i === 3)) {
        glyphStrip += '\x1b[38;5;196m]!\x1b[0m';
      }
    }

    const quotaPct = Math.round(minQuotaFraction * 100);
    const purity = classification.metrics.signalPurityPct;
    const noiseK = Math.round((classification.metrics.sludgeTokens || 0) / 1000);
    const activeK = Math.round((classification.totalInputTokens || 0) / 1000);
    const resolvedMaxTokens = classification.model?.maxTokens ||
      resolveModelCeiling(modelName, stdinData.context_window, { useLegacyDefault: false, config });
    const maxK = Math.round(resolvedMaxTokens / 1000);
    const usedPct = maxK > 0 ? Math.round((activeK / maxK) * 100) : 0;
    const modeTag = classification.workloadMode?.tag || '[Mode: Read-Heavy Audit]';
    let outputLine = '';

    if (isFullMode) {
      const effortStatus = sensorResults.threeStrikeLoop ? 'LOOP_HALT' : (sensorResults.quotaFloorBreached ? 'QUOTA_LOW' : 'OK');
      const cacheHitPct = Math.max(0, Number(classification.metrics?.cacheHitPct ?? 0) || 0);
      const ttlSec = Math.max(0, Math.round(Number(classification.metrics?.ttlRemainingSec ?? 0) || 0));
      let extraHints = '';
      if (planChurn.warn) extraHints += ` | Plan: ${planChurn.planRevisions} revs ⚠`;
      if (handoff.result === 'NEEDS_FIXES') extraHints += ' | Handoff: Needs fixes';
      outputLine = `[${glyphStrip}] ${activeK}k / ${maxK}k · ${usedPct}% | Cache Hit: ${cacheHitPct}% | Waste: ${noiseK}k tok | TTL: ${ttlSec}s | Purity: ${purity}% | Noise: ${noiseK}k tok | Quota: ${quotaPct}% | ${modeTag} | Effort: ${effortStatus}${extraHints}`;
    } else {
      outputLine = `[${glyphStrip}] ${activeK}k/${maxK}k·${usedPct}% | P:${purity}% | N:${noiseK}k | Q:${quotaPct}%`;
    }

    if (columns <= 80) {
      outputLine = clampAnsiText(outputLine, Math.min(columns, 80));
    }

    if (!options.silent) {
      console.log(outputLine);
    }
    return { output: outputLine, sidecar };
  } catch {
    safeExitFallback();
  }
}

export function formatDemoScenarioAnsi(scenarioId = 5, options = {}) {
  const maxCols = options.columns && options.columns <= 80
    ? Math.min(Number(options.columns) || 80, 80)
    : 80;
  const state = buildDemoHorizonState(scenarioId);
  const meta = state.demoMeta || DEMO_SCENARIOS[4];
  const isAmputation = state.amputation.inAmputationZone;

  let glyphStrip = '';
  for (let i = 0; i < 40; i++) {
    const cell = state.cells[i];
    const cat = cell?.hudCategory || CATEGORIES.FREE_HEADROOM;
    const glyph = ANSI_COLORS[cat] || ANSI_COLORS[CATEGORIES.FREE_HEADROOM];
    if (isAmputation && i === 0) glyphStrip += '\x1b[38;5;196m![\x1b[0m';
    glyphStrip += glyph;
    if (isAmputation && i === 7) glyphStrip += '\x1b[38;5;196m]!\x1b[0m';
  }

  const activeK = Math.round(state.window.totalActiveTokens / 1000);
  const maxK = Math.round(state.window.maxTokens / 1000);
  const usedPct = maxK > 0 ? Math.round((activeK / maxK) * 100) : 0;
  const purity = state.metrics.signalPurityPct;
  const noiseK = Math.round(state.metrics.sludgeTokens / 1000);
  const quotaPct = state.quota.sprint5h.remainingPct;
  const cacheHitPct = Math.max(0, Number(state.quota?.cache?.hitRatePct ?? 0) || 0);
  const ttlSec = Math.max(0, Math.round(Number(state.quota?.cache?.ttlRemainingSec ?? 0) || 0));
  const modeTag = state.workloadMode?.tag || '[Mode: Read-Heavy Audit]';
  const statusColor = isAmputation ? '\x1b[38;5;196m' : (purity < 60 ? '\x1b[38;5;214m' : '\x1b[38;5;82m');

  const aqAnsi = formatActionQueueAnsi(state);
  const aqLines = aqAnsi ? aqAnsi.split('\n').filter(Boolean) : [];
  const boxWidth = Math.max(40, Math.min(78, maxCols));
  const headerLabel = `╭── Flight Check v3.3 (${meta.routerState}) `;
  const headerDashCount = Math.max(1, boxWidth - visibleWidth(headerLabel) - 1);
  const footerLine = `╰${'─'.repeat(Math.max(1, boxWidth - 2))}╯`;

  const rawLines = [
    `\x1b[1m\x1b[38;5;51m${meta.title}\x1b[0m`,
    `\x1b[38;5;245m${modeTag} · "${meta.complaint}"\x1b[0m`,
    `[${glyphStrip}] ${statusColor}${activeK}k / ${maxK}k · ${usedPct}%\x1b[0m | Purity: ${statusColor}${purity}%\x1b[0m`,
    `Cache Hit: ${cacheHitPct}% | Waste: ${noiseK}k tok | TTL: ${ttlSec}s | Quota: ${quotaPct}%`,
    ...aqLines,
    `\x1b[38;5;244m${headerLabel}${'─'.repeat(headerDashCount)}╮\x1b[0m`,
    `\x1b[38;5;244m│\x1b[0m 1. PROMPT : "${meta.fixture.prompt.slice(0, 56)}"`,
    `\x1b[38;5;244m│\x1b[0m 2. HORIZON: [${activeK}k/${maxK}k·${usedPct}% | Cache:${cacheHitPct}% | Waste:${noiseK}k | TTL:${ttlSec}s | Q:${quotaPct}%]`,
    `\x1b[38;5;244m│\x1b[0m 3. ACTION : \x1b[38;5;82m${meta.recommendedAction}\x1b[0m`,
    `\x1b[38;5;244m│\x1b[0m 4. REWRITE: \x1b[38;5;51m"${meta.rewrite}"\x1b[0m`,
    `\x1b[38;5;244m${footerLine}\x1b[0m`
  ];
  const lines = rawLines.map(l => clampAnsiLine(l, maxCols));
  return { text: lines.join('\n'), state };
}

export async function runDemoShowcase({ scenarioId = null, animate = false, columns = process.stdout.columns || 80 } = {}) {
  const maxCols = columns <= 80 ? Math.min(columns, 80) : 80;
  console.log('\n' + clampAnsiLine('\x1b[1m\x1b[38;5;51m⚡ HIGHBEAM (ctxtop v3.4.0) — 40-Cell Context Telemetry & Flight Check\x1b[0m', maxCols));
  console.log(clampAnsiLine('\x1b[38;5;244mLegend: \x1b[38;5;51m█ Anchor\x1b[0m \x1b[38;5;141m▓ Memory\x1b[0m \x1b[38;5;205m▓ Bleed\x1b[0m \x1b[38;5;214m▒ Stale\x1b[0m \x1b[38;5;196m▓ Error\x1b[0m \x1b[38;5;82m█ Active\x1b[0m \x1b[38;5;196m![..]! (>140k)\x1b[0m', maxCols) + '\n');

  const ids = scenarioId ? [Number(scenarioId)] : (animate ? [2, 4, 5, 6, 7] : [5]);
  for (let idx = 0; idx < ids.length; idx++) {
    const { text } = formatDemoScenarioAnsi(ids[idx], { columns: maxCols });
    console.log(text);
    if (idx < ids.length - 1) {
      console.log('');
      if (animate) await new Promise(r => setTimeout(r, 450));
    }
  }
  console.log('\n' + clampAnsiLine('\x1b[38;5;245mTry: npx attention-horizon-antigravity --demo-animate | Web UI: npx attention-horizon-antigravity ui\x1b[0m', maxCols) + '\n');
}

export function isHudMain(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

// Auto-run if executed as main CLI script
const isMain = isHudMain();
if (isMain) {
  process.on('uncaughtException', () => safeExitFallback());
  process.on('unhandledRejection', () => safeExitFallback());
  const args = process.argv.slice(2);
  if (args.includes('--emit-widget')) {
    const emitIdx = args.indexOf('--emit-widget');
    const outIdx = args.indexOf('--out');
    let targetPath = null;
    if (outIdx !== -1 && args[outIdx + 1]) {
      targetPath = args[outIdx + 1];
    } else if (emitIdx !== -1 && args[emitIdx + 1] && !args[emitIdx + 1].startsWith('-')) {
      targetPath = args[emitIdx + 1];
    } else {
      targetPath = path.resolve('horizon_widget.html');
    }

    emitHorizonWidget({ out: targetPath, silent: false })
      .then(() => process.exit(0))
      .catch(() => safeExitFallback());
  } else if (args.includes('--demo') || args.includes('--demo-animate')) {
    const scenIdx = args.indexOf('--scenario');
    const scenarioId = scenIdx !== -1 ? Number(args[scenIdx + 1]) : null;
    runDemoShowcase({ scenarioId, animate: args.includes('--demo-animate') })
      .then(() => process.exit(0))
      .catch(() => safeExitFallback());
  } else if (process.stdin.isTTY || args.includes('--live')) {
    runCLI().then(() => process.exit(0)).catch(() => safeExitFallback());
  } else {
    readStdinSafe(150).then((stdinData) => {
      if (stdinData && Object.keys(stdinData).length > 0) {
        return runHud({ stdinData });
      }
      // If non-TTY stdin had malformed content vs empty stdin:
      // runHud handles fallback bar for statusLine contracts when --hud-legacy or piped
      return runHud({ stdinData });
    }).then(() => process.exit(0)).catch(() => safeExitFallback());
  }
}

/**
 * Adapts an Antigravity `classifyHorizon` state object into the Claude Code
 * static HUD contract consumed by `renderHorizonPanelHtml`. Passes native
 * Claude Code states through unchanged.
 */
export function adaptClassifierStateForStaticHud(state = {}, options = {}) {
  const isAntigravityState = Boolean(
    state &&
    typeof state === 'object' &&
    state.window &&
    typeof state.window.totalActiveTokens === 'number' &&
    !state.contextWindow &&
    typeof state.totalInputTokens !== 'number'
  );
  if (!isAntigravityState) {
    return { state, options };
  }

  const totalInputTokens = Math.max(0, Number(state.window.totalActiveTokens || 0));
  const contextCeiling = Math.max(0, Number(state.window.maxTokens || 0));
  const breakdown = state.breakdown || {};
  const systemTokens = Math.max(0, Number(breakdown.ANCHOR ?? state.baseline?.totalEst ?? 0));
  const dupTok = Math.max(0, Number(breakdown.STALE_DUPLICATE ?? breakdown.DUPLICATE_READ ?? 0));
  const oldHistTok = Math.max(0, Number(breakdown.STALE_TURN ?? 0));
  const deadErrTok = Math.max(0, Number(breakdown.DEAD_ERROR ?? 0));
  const bleedTok = Math.max(0, Number(breakdown.FOREIGN_BLEED ?? 0));
  const distractorTokens = dupTok + oldHistTok + deadErrTok + bleedTok;

  const cacheObj = state.quota?.cache || {};
  const ttlSec = Math.max(0, Math.round(Number(cacheObj.ttlRemainingSec || 0) || 0));
  const hitPct = Math.max(0, Math.min(100, Math.round(Number(cacheObj.hitRatePct || 0) || 0)));
  const cacheReadTokens = Math.max(0, Number(cacheObj.cacheReadTokens || 0));
  const isWarm = Boolean(
    !cacheObj.isCacheCold &&
    !cacheObj.prefixBustDetected &&
    ttlSec > 0 &&
    (cacheReadTokens > 0 || hitPct > 0)
  );
  const nonAnchorOrDistractor = Math.max(0, totalInputTokens - systemTokens - distractorTokens);

  const adaptedState = {
    sessionId: state.sessionId || 'horizon-hud',
    model: state.model?.id || 'claude-sonnet-5-5',
    modelLabel: state.model?.displayName || state.model?.rawLabel || state.model?.id || 'claude-sonnet-5-5',
    totalInputTokens,
    contextCeiling: contextCeiling > 0 ? contextCeiling : undefined,
    systemTokens,
    distractorTokens,
    cachedTokens: isWarm ? nonAnchorOrDistractor : 0,
    cacheReadTokens,
    uncachedInputTokens: isWarm ? 0 : nonAnchorOrDistractor,
    promptCache: {
      warm: isWarm,
      ttlRemainingSec: isWarm ? ttlSec : 0,
      ttlTier: '5m'
    },
    cacheRoi: {
      cacheHitRatio: hitPct / 100
    },
    amnesiaRisk: Boolean(
      state.amputation?.amputationCrisis ||
      state.amputation?.inAmputationZone ||
      state.telemetry?.amputationRisk
    ),
    sessionTimeline: state.sessionTimeline || null,
    autoFixLog: state.autoFixLog || null,
    compactCommand: typeof state.compaction?.parameterizedCommand === 'string' &&
      state.compaction.parameterizedCommand.startsWith('/compact ')
      ? state.compaction.parameterizedCommand
      : '/compact'
  };

  const mergedOptions = { ...options };
  if (!Array.isArray(mergedOptions.offenders)) {
    const derivedOffenders = [];
    const seen = new Set();
    const bs = state.brainSignals || {};
    const topFiles = Array.isArray(bs.duplicateReads?.topFiles) ? bs.duplicateReads.topFiles : [];
    for (const f of topFiles) {
      const target = f?.path || f?.file;
      const wastedTokens = Number(f?.wastedTokens ?? f?.tokens ?? 0);
      if (!target || wastedTokens <= 0) continue;
      seen.add(String(target).toLowerCase());
      derivedOffenders.push({
        target,
        occurrences: Number(f.occurrences || f.reads || 1),
        wastedTokens,
        category: '[D]'
      });
    }
    for (const o of (Array.isArray(state.offenders) ? state.offenders : [])) {
      const rawTarget = String(o?.target || '');
      const wastedTokens = Number(o?.wastedTokens || 0);
      if (!rawTarget || wastedTokens <= 0) continue;
      if (rawTarget === 'Foreign Bleed Knowledge') continue;
      const key = rawTarget.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      derivedOffenders.push({
        target: rawTarget,
        occurrences: Number(o.occurrences || 1),
        wastedTokens,
        category: '[D]'
      });
    }
    if (bleedTok > 0) {
      derivedOffenders.push({
        target: 'Cross-project memory bleed (foreign KIs)',
        occurrences: 1,
        wastedTokens: bleedTok,
        category: '[D]'
      });
    }
    for (const b of (Array.isArray(bs.blowupSteps) ? bs.blowupSteps : [])) {
      const wastedTokens = Number(b?.tokens || 0);
      if (wastedTokens <= 0) continue;
      const isFile = b.payload?.kind === 'file' && Boolean(b.payload?.path);
      const target = isFile ? b.payload.path : (b.payload?.detail || b.target || 'Output spike');
      const key = String(target).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      derivedOffenders.push({
        target,
        occurrences: 1,
        wastedTokens,
        category: isFile ? '[D]' : '[W]'
      });
    }
    for (const srv of (Array.isArray(bs.mcpAudit?.unusedEagerServers) ? bs.mcpAudit.unusedEagerServers : [])) {
      const schemaTokens = Number(srv?.schemaTokens || 0);
      if (!srv?.name || schemaTokens <= 0) continue;
      derivedOffenders.push({
        target: srv.name,
        occurrences: 1,
        wastedTokens: schemaTokens,
        category: '[S]'
      });
    }
    derivedOffenders.sort((a, b) => (b.wastedTokens || 0) - (a.wastedTokens || 0));
    mergedOptions.offenders = derivedOffenders;
  }

  if (!mergedOptions.breakerVerdict) {
    const tripped = state.coachState?.detectors?.tripped;
    const isErrLoop = Boolean(state.brainSignals?.deadErrors?.isErrorLoop);
    const errCount = Number(state.brainSignals?.deadErrors?.errorCount || 0);
    if (state.amputation?.amputationCrisis) {
      mergedOptions.breakerVerdict = {
        triggered: true,
        detectorId: tripped?.detectorId || 'CRISIS',
        reason: tripped?.reason || `Context truncation crisis (${Math.round(totalInputTokens / 1000)}k used — oldest rules at risk).`
      };
    } else if (tripped && tripped.detectorId) {
      mergedOptions.breakerVerdict = {
        triggered: true,
        detectorId: tripped.detectorId,
        reason: tripped.reason || `${tripped.detectorId} guard triggered.`
      };
    } else if (isErrLoop) {
      mergedOptions.breakerVerdict = {
        triggered: true,
        detectorId: 'ERR-LOOP',
        reason: `Stuck error loop (${errCount}x failing attempts). Pause retries and isolate a minimal repro.`
      };
    }
  }

  if (state.savings && mergedOptions.sessionSavedTokens === undefined) {
    const sessTok = Math.max(0, Number(state.savings?.session?.totalPhysicalTokens ?? state.savings?.session?.totalTokens ?? 0));
    const sessUsd = Math.max(0, Number(state.savings?.session?.estimatedInputValueUsd ?? state.savings?.session?.estimatedUsd ?? Number(((sessTok / 1_000_000) * 2).toFixed(2))));
    const wsTok = Math.max(sessTok, Number(state.savings?.workspace30d?.totalPhysicalTokens ?? state.savings?.workspace30d?.totalTokens ?? 0));
    const wsUsd = Math.max(sessUsd, Number(state.savings?.workspace30d?.estimatedInputValueUsd ?? state.savings?.workspace30d?.estimatedUsd ?? Number(((wsTok / 1_000_000) * 2).toFixed(2))));
    mergedOptions.sessionSavedTokens = sessTok;
    mergedOptions.sessionSavedUSD = sessUsd;
    mergedOptions.workspace30dSavedTokens = wsTok;
    mergedOptions.workspace30dSavedUSD = wsUsd;
    if (mergedOptions.includeDiskLedger === undefined) {
      mergedOptions.includeDiskLedger = false;
    }
  }

  return { state: adaptedState, options: mergedOptions };
}

/**
 * Renders the static HTML HUD from either an Antigravity `classifyHorizon`
 * state or a native Claude Code state.
 */
export function renderClassifierHudHtml(state = {}, options = {}) {
  const { state: adaptedState, options: mergedOptions } = adaptClassifierStateForStaticHud(state, options);
  return renderHorizonPanelHtml(adaptedState, mergedOptions);
}

/**
 * Formats the single-line ANSI CLI status bar for a `classifyHorizon` state
 * clamped cleanly to `columns` when <= 80.
 */
export function formatCliStatusLine(state = {}, { columns = 120 } = {}) {
  let cellCount = 40;
  if (columns < 80) cellCount = 10;
  else if (columns < 120) cellCount = 20;

  const downsampleRatio = 40 / cellCount;
  const isAmputation = Boolean(state.amputation?.inAmputationZone);
  const isCrisis = Boolean(state.amputation?.amputationCrisis);

  let bar = isCrisis ? '\x1b[48;5;196m\x1b[38;5;255m![ 🚨 \x1b[0m ' : (isAmputation ? '\x1b[38;5;196m![\x1b[0m' : '[');
  for (let i = 0; i < cellCount; i++) {
    const origStart = Math.floor(i * downsampleRatio);
    const origEnd = Math.floor((i + 1) * downsampleRatio);
    const slice = (state.cells || []).slice(origStart, origEnd);
    const dominant = slice[0]?.dominantCategory || H_CATEGORIES.FREE_HEADROOM;
    const meta = CATEGORY_METADATA[dominant] || CATEGORY_METADATA.FREE_HEADROOM;
    if (slice.some(c => c.isCrisisCell)) {
      bar += `\x1b[48;5;196m\x1b[38;5;255m${meta.symbol}\x1b[0m`;
    } else {
      bar += `${meta.ansiCode}${meta.symbol}\x1b[0m`;
    }
  }
  bar += isCrisis ? ' \x1b[48;5;196m\x1b[38;5;255m]!\x1b[0m' : (isAmputation ? '\x1b[38;5;196m]!\x1b[0m' : ']');

  const activeK = Math.round((state.window?.totalActiveTokens || 0) / 1000);
  const maxK = Math.round((state.window?.maxTokens || 0) / 1000);
  const usedPct = maxK > 0 ? Math.round((activeK / maxK) * 100) : 0;
  const purity = state.metrics?.signalPurityPct ?? 100;
  const noiseK = Math.round((state.metrics?.sludgeTokens || 0) / 1000);
  const rawRecCmd = state.diagnostics?.recommendedCommand || 'Ready';
  const recCmd = rawRecCmd === '/fast' ? 'Ready' : rawRecCmd;
  const isCacheCold = state.quota?.cache ? Boolean(state.quota.cache.isCacheCold) : false;
  const ttlSec = Math.max(0, Math.round(Number(state.quota?.cache?.ttlRemainingSec || 0) || 0));
  const cacheHitPct = Math.max(0, Number(state.quota?.cache?.hitRatePct || 0) || 0);
  const cacheLabel = (!isCacheCold && ttlSec > 0 && cacheHitPct > 0) ? `Warm(${ttlSec}s)` : 'Cold';
  const modeTag = state.workloadMode?.tag || '[Mode: Read-Heavy Audit]';
  const strandedCnt = Number(state.attentionHeatmap?.strandedSignalCount || 0);
  const strandedSuffix = strandedCnt > 0 ? ` | \u26A0 ${strandedCnt}/40 mid-window blocks` : '';

  let line1 = '';
  if (cellCount === 40) {
    line1 = `${bar}  [ ${activeK}k / ${maxK}k · ${usedPct}% ]  \x1b[1mPurity:\x1b[0m ${purity}% | \x1b[1mCache Hit:\x1b[0m ${cacheHitPct}% | \x1b[1mWaste:\x1b[0m ${noiseK}k tok | \x1b[1mCache:\x1b[0m ${cacheLabel} | ${modeTag}${strandedSuffix}  \x1b[38;5;51m-> ${recCmd}\x1b[0m`;
  } else if (cellCount === 20) {
    line1 = `${bar} [${activeK}k/${maxK}k·${usedPct}%] P:${purity}% Waste:${noiseK}k -> ${recCmd}`;
  } else {
    line1 = `${bar} ${activeK}k P:${purity}% ${recCmd}`;
  }
  if (columns <= 80) {
    line1 = clampAnsiText(line1, Math.min(columns, 80));
  }
  return line1;
}

/**
 * Renders the ANSI statusLine bar and full 256K-aware HorizonStatePayload for Antigravity CLI / Sidecar Daemon
 */
export async function runCLI(options = {}) {
  const {
    stdinData = null,
    columns = process.stdout.columns || 120,
    sessionDirOverride = null,
    cacheDirOverride = null,
    useNativeCeiling = true,
    demoScenario = null
  } = options;

  if (demoScenario || process.env.HORIZON_DEMO === '1') {
    const { text, state } = formatDemoScenarioAnsi(
      Number(demoScenario || process.env.HORIZON_DEMO_SCENARIO || 5),
      { columns }
    );
    if (options.emitWidget || (Array.isArray(process.argv) && process.argv.includes('--emit-widget'))) {
      const target = path.resolve(options.out || 'horizon_widget.html');
      const { html } = renderClassifierHudHtml(state, { viewMode: 'simple' });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, html, 'utf8');
      const fileUri = `file:///${target.replace(/\\/g, '/').replace(/^\/+/, '')}`;
      const embedTag = `<agent-embed src="${fileUri}"></agent-embed>`;
      if (!options.silent) console.log(embedTag);
      return { output: text, state, html, path: target, fileUri, embedTag };
    }
    if (!options.silent) console.log(text);
    return { output: text, state };
  }

  let sessionInfo = null;
  if (sessionDirOverride) {
    const lowerOverride = String(sessionDirOverride).toLowerCase();
    const inferredStore = lowerOverride.endsWith('.vscdb') || fs.existsSync(path.join(sessionDirOverride, 'state.vscdb'))
      ? 'cursor'
      : (lowerOverride.endsWith('.jsonl') ? 'claude-code' : 'antigravity');
    sessionInfo = {
      storeName: inferredStore,
      sessionDir: sessionDirOverride,
      sessionId: path.basename(sessionDirOverride).replace(/\.(jsonl|vscdb)$/i, '')
    };
  } else {
    const passedSessionId = stdinData?.session_id || stdinData?.conversation_id;
    sessionInfo = findSessionDirectory(passedSessionId);
  }

  if (!sessionInfo || !fs.existsSync(sessionInfo.sessionDir)) {
    const fallbackText = '\x1b[38;5;244m[ - ] No Antigravity session active\x1b[0m';
    if (!options.silent) console.log(fallbackText);
    return { output: fallbackText, state: null };
  }

  const parsed = parseTranscriptIncremental(sessionInfo.sessionDir, cacheDirOverride);
  if (!parsed.steps || parsed.steps.length === 0) {
    const initText = '\x1b[38;5;244m[ ... ] Initialize session to build attention horizon\x1b[0m';
    if (!options.silent) console.log(initText);
    return { output: initText, state: null };
  }

  const reconciliation = await reconcileWorkspaceAndKIs(sessionInfo.sessionId, getHomeDir());
  const defaultCacheDir = path.join(getHomeDir(), '.gemini', 'antigravity', 'cache', 'agy-horizon');
  const cacheDir = cacheDirOverride || defaultCacheDir;
  // Model precedence: stdin > gen_metadata.model > last USER_INPUT Model Selection > fallback.
  const activeGenMetadata = reconciliation.sessionGenMetadata || parsed.genMetadata || null;
  const resolvedModel = resolveSessionModel({
    stdinData,
    genMetadata: activeGenMetadata,
    steps: parsed.steps
  });
  const modelId = resolvedModel.id;
  const loadedSettings = loadSettings(cacheDir);
  const win = resolveWindow(loadedSettings, modelId);
  const hasCustomLimit = Boolean(
    (modelId && loadedSettings.modelOverrides?.[modelId]) ||
    (loadedSettings.safeLimitTokens && loadedSettings.safeLimitTokens !== 140000)
  );
  const nativeMax = resolveModelCeiling(modelId, stdinData?.context_window, { useLegacyDefault: !useNativeCeiling });
  const scaledEffort = scaleEffortProfileForCeiling(parsed.activeEffortProfile, nativeMax);
  const effectiveSafeLimit = hasCustomLimit
    ? win.safeLimit
    : (scaledEffort?.safeLimit || win.safeLimit);

  const state = classifyHorizon(parsed.steps, {
    sessionId: sessionInfo.sessionId,
    storeSource: sessionInfo.storeName,
    logTierUsed: parsed.tier,
    logFilePath: parsed.filePath,
    canonicalWorkspace: reconciliation.primaryWorkspace || parsed.workspacePath || '',
    projectId: reconciliation.projectId,
    kiBleedMap: reconciliation.kiBleedMap,
    modelId,
    stdinContextWindow: stdinData?.context_window,
    stdinQuota: stdinData?.quota,
    genMetadata: activeGenMetadata,
    modelSource: resolvedModel.source,
    useNativeCeiling,
    cacheDir,
    safeLimitTokens: effectiveSafeLimit,
    reminderAtPct: win.reminderAtPct,
    activeEffortProfile: scaledEffort,
    effortTransitions: parsed.effortTransitions
  });
  state.sessionTitle = reconciliation.sessionTitle || parsed.sessionTitle || '';
  if (state.model && typeof state.model === 'object') {
    state.model.source = resolvedModel.source;
    state.model.rawLabel = resolvedModel.raw;
  }
  state.recentSessions = reconciliation.recentSessions || [];
  state.rewindDetected = Boolean(parsed.rewindDetected);
  try { state.baseline = measureBaseline(reconciliation.primaryWorkspace || ''); } catch { state.baseline = null; }
  state.chronicReads = updateChronicReads(
    cacheDir,
    sessionInfo.sessionId,
    state.brainSignals?.duplicateReads?.topFiles || [],
    10,
    reconciliation.primaryWorkspace || state.workspace?.canonicalPath || ''
  );

  state.delta = recordAndDelta(cacheDir, sessionInfo.sessionId, state, parsed.steps).delta;
  try {
    state.hostHealth = await inspectHostProcesses({ force: false });
  } catch {
    state.hostHealth = { rssGb: 0, languageServerCount: 0, orphanCount: 0, orphans: [], status: 'HEALTHY', alertBanner: null, checkedAt: new Date().toISOString() };
  }
  try {
    writeJsonAtomicSync(path.join(cacheDir, 'latest.state.json'), state);
  } catch {}

  const line1 = formatCliStatusLine(state, { columns });

  if (options.emitWidget || (Array.isArray(process.argv) && process.argv.includes('--emit-widget'))) {
    const target = path.resolve(options.out || 'horizon_widget.html');
    const { html } = renderClassifierHudHtml(state, { viewMode: 'simple' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, html, 'utf8');
    const fileUri = `file:///${target.replace(/\\/g, '/').replace(/^\/+/, '')}`;
    const embedTag = `<agent-embed src="${fileUri}"></agent-embed>`;
    if (!options.silent) console.log(embedTag);
    return { output: line1, state, html, path: target, fileUri, embedTag };
  }

  if (!options.silent) console.log(line1);
  return { output: line1, state };
}

/**
 * Generates self-contained HTML widget and prints/returns `<agent-embed src="file:///<path>"></agent-embed>`
 */
export async function emitHorizonWidget(options = {}) {
  const targetPath = path.resolve(options.out || 'horizon_widget.html');
  const cliRes = await runCLI({ ...options, silent: true, useNativeCeiling: true });
  const state = cliRes?.state || {};
  const { html } = renderClassifierHudHtml(state, { viewMode: 'simple' });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, html, 'utf8');
  const fileUri = `file:///${targetPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const embedTag = `<agent-embed src="${fileUri}"></agent-embed>`;
  if (!options.silent) {
    process.stdout.write(`${embedTag}\n`);
  }
  return { ok: true, path: targetPath, fileUri, embedTag, html, state };
}
