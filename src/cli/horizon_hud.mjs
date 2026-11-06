import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalizePath } from '../core/path_canonicalizer.mjs';
import {
  readSidecarSync,
  writeSidecarAtomicSync,
  readToolUsageSync,
  createDefaultSidecar
} from '../core/sidecar_store.mjs';
import { resolveAndReadTranscriptIncremental } from '../core/log_resolver.mjs';
import { classifyHorizonWindow, CATEGORIES } from '../core/horizon_classifier.mjs';
import { runAllBlindspotSensors } from '../core/blindspot_sensors.mjs';
import { CATEGORIES as H_CATEGORIES, CATEGORY_METADATA, scaleEffortProfileForCeiling, resolveModelCeiling } from '../core/constants.mjs';
import { findSessionDirectory, parseTranscriptIncremental, reconcileWorkspaceAndKIs } from '../core/parser.mjs';
import { classifyHorizon } from '../core/classifier.mjs';
import { getHomeDir } from '../core/paths.mjs';
import { recordAndDelta } from '../core/history.mjs';
import { loadSettings, resolveWindow } from '../core/settings.mjs';
import { measureBaseline } from '../core/baseline.mjs';
import { updateChronicReads } from '../core/offenders.mjs';
import { buildDemoHorizonState, DEMO_SCENARIOS } from '../../tests/fixtures/synthetic_states.mjs';

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

function loadConfig() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const cfgPath = path.resolve(__dirname, '../../config/default_flightcheck.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch {}
  return {
    amputation_token_threshold: 140000,
    quota_floor_fraction: 0.10,
    model_pricing_per_1m_input: { 'gemini-3.8-flash': 0.15 }
  };
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
    const config = options.configOverride || loadConfig();

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
      agentState,
      mode,
      quota: {
        remaining_fraction: minQuotaFraction,
        remaining_amount: stdinData.quota?.remaining_amount || 100,
        reset_in_seconds: stdinData.quota?.reset_in_seconds || 18000,
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
    sidecar.sensors = {
      schemaTaxPct: sensorResults.schemaTaxPct,
      unusedMcpServers: sensorResults.unusedMcpServers,
      oversizedPayloadDetected: sensorResults.oversizedPayloadDetected,
      quotaFloorBreached: sensorResults.quotaFloorBreached,
      planToFlashHandoffNeeded: sensorResults.planToFlashHandoffNeeded,
      threeStrikeLoop: sensorResults.threeStrikeLoop,
      uncheckpointedGitDrift: sensorResults.uncheckpointedGitDrift,
      dirtyGitFileCount: sensorResults.dirtyGitFileCount
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
    let outputLine = '';

    if (isFullMode) {
      const effortStatus = sensorResults.threeStrikeLoop ? 'LOOP_HALT' : (sensorResults.quotaFloorBreached ? 'QUOTA_LOW' : 'OK');
      outputLine = `[${glyphStrip}] Purity: ${purity}% | Noise: ${noiseK}k tok | Quota: ${quotaPct}% | Effort: ${effortStatus}`;
    } else {
      outputLine = `[${glyphStrip}] P:${purity}% | N:${noiseK}k | Q:${quotaPct}%`;
    }

    if (!options.silent) {
      console.log(outputLine);
    }
    return { output: outputLine, sidecar };
  } catch {
    safeExitFallback();
  }
}

export function formatDemoScenarioAnsi(scenarioId = 5) {
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
  const purity = state.metrics.signalPurityPct;
  const noiseK = Math.round(state.metrics.sludgeTokens / 1000);
  const quotaPct = state.quota.sprint5h.remainingPct;
  const statusColor = isAmputation ? '\x1b[38;5;196m' : (purity < 60 ? '\x1b[38;5;214m' : '\x1b[38;5;82m');

  const lines = [
    `\x1b[1m\x1b[38;5;51m${meta.title}\x1b[0m`,
    `\x1b[38;5;245mRedditor Complaint: "${meta.complaint}"\x1b[0m`,
    `[${glyphStrip}] ${statusColor}${activeK}k/${maxK}k\x1b[0m | Purity: ${statusColor}${purity}%\x1b[0m | Sludge: \x1b[38;5;214m+$${meta.sludgeTaxUsd.toFixed(2)}/turn\x1b[0m (${noiseK}k tok) | Quota: ${quotaPct}%`,
    `\x1b[38;5;244m╭── Flight Check v3.1 (${meta.routerState}) ───────────────────────────────────────────╮\x1b[0m`,
    `\x1b[38;5;244m│\x1b[0m 1. PROMPT : [Score ${meta.score}/100] "${meta.fixture.prompt.slice(0, 56)}"`,
    `\x1b[38;5;244m│\x1b[0m 2. HORIZON: [Purity: ${purity}% | Reclaimable: ${Math.round(meta.reclaimTokens / 1000)}k tok | Tokens: ${activeK}k/${maxK}k | Quota: ${quotaPct}%]`,
    `\x1b[38;5;244m│\x1b[0m 3. ACTION : \x1b[38;5;82m${meta.recommendedAction}\x1b[0m`,
    `\x1b[38;5;244m│\x1b[0m 4. REWRITE: \x1b[38;5;51m"${meta.rewrite}"\x1b[0m`,
    `\x1b[38;5;244m╰────────────────────────────────────────────────────────────────────────────────────────╯\x1b[0m`
  ];
  return { text: lines.join('\n'), state };
}

export async function runDemoShowcase({ scenarioId = null, animate = false } = {}) {
  console.log('\n\x1b[1m\x1b[38;5;51m⚡ CONTEXT HORIZON (ctxtop v3.1.0) — 40-Cell Context Telemetry & Flight Check Demo\x1b[0m');
  console.log('\x1b[38;5;244mLegend: \x1b[38;5;51m█ Anchor\x1b[0m  \x1b[38;5;141m▓ Memory KI\x1b[0m  \x1b[38;5;205m▓ Foreign Bleed\x1b[0m  \x1b[38;5;214m▒ Stale/Dirty\x1b[0m  \x1b[38;5;196m▓ Dead Error\x1b[0m  \x1b[38;5;82m█ Active Set\x1b[0m  \x1b[38;5;196m![...]! Amputation (>140k)\x1b[0m\n');

  const ids = scenarioId ? [Number(scenarioId)] : (animate ? [2, 4, 5, 6, 7] : [5]);
  for (let idx = 0; idx < ids.length; idx++) {
    const { text } = formatDemoScenarioAnsi(ids[idx]);
    console.log(text);
    if (idx < ids.length - 1) {
      console.log('');
      if (animate) await new Promise(r => setTimeout(r, 450));
    }
  }
  console.log('\n\x1b[38;5;245mTry all 8 scenarios: npx context-horizon --demo-animate | Launch Webview: npx context-horizon --serve | Roast local logs: npx ctxtop --roast\x1b[0m\n');
}

// Auto-run if executed as main CLI script
const isMain = process.argv[1] && (process.argv[1].endsWith('horizon_hud.mjs') || process.argv[1].endsWith('horizon_hud.js'));
if (isMain) {
  process.on('uncaughtException', () => safeExitFallback());
  process.on('unhandledRejection', () => safeExitFallback());
  const args = process.argv.slice(2);
  if (args.includes('--demo') || args.includes('--demo-animate')) {
    const scenIdx = args.indexOf('--scenario');
    const scenarioId = scenIdx !== -1 ? Number(args[scenIdx + 1]) : null;
    runDemoShowcase({ scenarioId, animate: args.includes('--demo-animate') })
      .then(() => process.exit(0))
      .catch(() => safeExitFallback());
  } else {
    runHud().then(() => process.exit(0)).catch(() => safeExitFallback());
  }
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
    const { text, state } = formatDemoScenarioAnsi(Number(demoScenario || process.env.HORIZON_DEMO_SCENARIO || 5));
    if (!options.silent) console.log(text);
    return { output: text, state };
  }

  let sessionInfo = null;
  if (sessionDirOverride) {
    sessionInfo = {
      storeName: 'antigravity',
      sessionDir: sessionDirOverride,
      sessionId: path.basename(sessionDirOverride)
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
  const modelId = stdinData?.model?.id || stdinData?.modelName || 'gemini-3.8-flash';
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
    canonicalWorkspace: reconciliation.primaryWorkspace,
    projectId: reconciliation.projectId,
    kiBleedMap: reconciliation.kiBleedMap,
    modelId,
    stdinContextWindow: stdinData?.context_window,
    stdinQuota: stdinData?.quota,
    useNativeCeiling,
    cacheDir,
    safeLimitTokens: effectiveSafeLimit,
    reminderAtPct: win.reminderAtPct,
    activeEffortProfile: scaledEffort,
    effortTransitions: parsed.effortTransitions
  });
  state.sessionTitle = reconciliation.sessionTitle || '';
  state.recentSessions = reconciliation.recentSessions || [];
  state.rewindDetected = Boolean(parsed.rewindDetected);
  try { state.baseline = measureBaseline(reconciliation.primaryWorkspace || ''); } catch { state.baseline = null; }
  state.chronicReads = updateChronicReads(cacheDir, sessionInfo.sessionId, state.brainSignals?.duplicateReads?.topFiles || []);

  state.delta = recordAndDelta(cacheDir, sessionInfo.sessionId, state, parsed.steps).delta;
  try {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'latest.state.json'), JSON.stringify(state, null, 2), 'utf8');
  } catch {}

  let cellCount = 40;
  if (columns < 80) cellCount = 10;
  else if (columns < 120) cellCount = 20;

  const downsampleRatio = 40 / cellCount;
  const isAmputation = state.amputation.inAmputationZone;
  const isCrisis = state.amputation.amputationCrisis;

  let bar = isCrisis ? '\x1b[48;5;196m\x1b[38;5;255m![ 🚨 \x1b[0m ' : (isAmputation ? '\x1b[38;5;196m![\x1b[0m' : '[');
  for (let i = 0; i < cellCount; i++) {
    const origStart = Math.floor(i * downsampleRatio);
    const origEnd = Math.floor((i + 1) * downsampleRatio);
    const slice = state.cells.slice(origStart, origEnd);
    const dominant = slice[0]?.dominantCategory || H_CATEGORIES.FREE_HEADROOM;
    const meta = CATEGORY_METADATA[dominant] || CATEGORY_METADATA.FREE_HEADROOM;
    if (slice.some(c => c.isCrisisCell)) {
      bar += `\x1b[48;5;196m\x1b[38;5;255m${meta.symbol}\x1b[0m`;
    } else {
      bar += `${meta.ansiCode}${meta.symbol}\x1b[0m`;
    }
  }
  bar += isCrisis ? ' \x1b[48;5;196m\x1b[38;5;255m]!\x1b[0m' : (isAmputation ? '\x1b[38;5;196m]!\x1b[0m' : ']');

  const activeK = Math.round(state.window.totalActiveTokens / 1000);
  const maxK = Math.round(state.window.maxTokens / 1000);
  const purity = state.metrics.signalPurityPct;
  const noiseK = Math.round((state.metrics.sludgeTokens || 0) / 1000);
  const recCmd = state.diagnostics.recommendedCommand;

  let line1 = '';
  if (cellCount === 40) {
    line1 = `${bar}  [ ${activeK}k / ${maxK}k ]  \x1b[1mPurity:\x1b[0m ${purity}% | \x1b[1mNoise:\x1b[0m ${noiseK}k tok  \x1b[38;5;51m-> ${recCmd}\x1b[0m`;
  } else if (cellCount === 20) {
    line1 = `${bar} [${activeK}k/${maxK}k] P:${purity}% Noise:${noiseK}k -> ${recCmd}`;
  } else {
    line1 = `${bar} ${activeK}k P:${purity}% ${recCmd}`;
  }

  if (!options.silent) console.log(line1);
  return { output: line1, state };
}
