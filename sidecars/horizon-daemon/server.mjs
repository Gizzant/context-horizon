import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHomeDir, getDaemonPortFile, ensureSupportedNodeVersion } from '../../src/core/paths.mjs';
import { resolveSurfaceTag, resolveModelCeiling } from '../../src/core/constants.mjs';
import { runCLI } from '../../src/cli/horizon_hud.mjs';
import { buildCostRadarFromState } from '../../src/cli/cost_radar.mjs';
import { findSessionDirectory } from '../../src/core/parser.mjs';
import { loadSettings, saveSettings, SETTINGS_LIMITS } from '../../src/core/settings.mjs';
import { pruneSessionTranscript } from '../../src/core/pruner.mjs';
import { inspectHostProcesses, reapOrphanProcesses } from '../../src/core/host_watchdog.mjs';
import { generateHandoffMarkdown } from '../../src/core/handoff_audit.mjs';
import { registerCliDampeningHook, promoteRuleWithAttentionZone } from '../../src/core/layer5_hygiene.mjs';
import { exportSanitizedSnapshot } from '../../src/core/sanitizer.mjs';
import { executeToolOutputSurgery } from '../../src/core/tool_surgeon.mjs';
import { buildGitCommitTokenLedger } from '../../src/core/git_ledger.mjs';
import { synthesizeResumeHerePack } from '../../src/core/episodic_memory.mjs';
import { getFlightcheckDir } from '../../src/core/sidecar_store.mjs';
import { PrefixCacheShield } from '../../src/core/prefix_cache_shield.mjs';
import { CompactionCoach, assessCompactionState, trimUncachedTail } from '../../src/core/compaction_coach.mjs';
import { RsiInstinctEngine } from '../../src/core/rsi_instinct_engine.mjs';
import { UShapedAttentionOptimizer } from '../../src/core/u_shaped_optimizer.mjs';
import {
  evaluateTaskAndQuotaRoute,
  actuateRoutingRecommendation,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator
} from '../../src/core/task_quota_router.mjs';
import { loadHorizonConfig } from '../../src/core/horizon_config.mjs';
import { TrajectoryWatcher } from '../../src/core/telemetry/trajectory_watcher.mjs';
import { detectShadowedFileBloat } from '../../src/core/telemetry/shadow_file_detector.mjs';
import { CacheTtlWatchdog } from '../../src/core/telemetry/cache_ttl_watchdog.mjs';
import {
  loadRegistry as loadScopeLockRegistry,
  detectScopeCollision,
  deriveSessionClaimedPaths
} from '../../src/core/telemetry/scope_lock_registry.mjs';
import { HysteresisLock, TurnBoundaryActuationQueue } from '../../src/core/coach/task_quota_router.mjs';
import { CircuitBreakers } from '../../src/core/coach/circuit_breakers.mjs';
import { SubagentPhantomAuditor } from '../../src/core/coach/subagent_phantom_auditor.mjs';
import { TurnZeroGate } from '../../src/core/coach/turn_zero_gate.mjs';
import { HandoffHydrationLauncher } from '../../src/core/coach/handoff_hydrator.mjs';
import { SavedQuotaReceiptLedger } from '../../src/core/coach/saved_quota_ledger.mjs';
import { ProgressiveCheckpointer } from '../../src/core/coach/progressive_checkpointer.mjs';
import { atomicWriteFileSync } from '../../src/core/atomic_io.mjs';

export const HORIZON_CSRF_TOKEN = crypto.randomBytes(32).toString('hex');
export const MAX_REQUEST_BODY_BYTES = 1_048_576; // 1 MB
export const MAX_SSE_CLIENTS = 16;
export const MAX_DAEMON_DIAGNOSTICS = 50;

const daemonDiagnostics = [];
let daemonDiagnosticTotalCount = 0;

export function recordDaemonDiagnostic(operation, err) {
  const entry = {
    timestamp: new Date().toISOString(),
    operation: String(operation || 'unknown').slice(0, 96),
    name: err && typeof err === 'object' && err.name ? String(err.name).slice(0, 48) : 'Error',
    code: err && typeof err === 'object' && err.code ? String(err.code) : null,
    message: String(err instanceof Error ? err.message : (err ?? 'Unknown error')).slice(0, 240)
  };
  daemonDiagnosticTotalCount += 1;
  daemonDiagnostics.push(entry);
  while (daemonDiagnostics.length > MAX_DAEMON_DIAGNOSTICS) {
    daemonDiagnostics.shift();
  }
  return entry;
}

export function getDaemonDiagnostics() {
  return {
    count: daemonDiagnostics.length,
    totalRecorded: daemonDiagnosticTotalCount,
    recent: [...daemonDiagnostics]
  };
}

export function clearDaemonDiagnostics() {
  daemonDiagnostics.length = 0;
  daemonDiagnosticTotalCount = 0;
}

export function isValidCsrfToken(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== HORIZON_CSRF_TOKEN.length) {
    return false;
  }
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(HORIZON_CSRF_TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
import { ContradictionAuditor } from '../../src/core/coach/contradiction_auditor.mjs';
import { ReflectorQueue } from '../../src/core/coach/reflector_queue.mjs';
import { PromptDecomposerCoach } from '../../src/core/coach/prompt_decomposer_coach.mjs';
import { getFts5CompressionStats } from '../../src/core/fts5_output_compressor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--demo')) {
  process.env.HORIZON_DEMO = '1';
}
const isDemoMode = process.env.HORIZON_DEMO === '1' || process.argv.includes('--demo');

const EXPLICIT_PORT = parseInt(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||
  process.env.PORT ||
  '0',
  10
);
const DEFAULT_PORT_START = 62935;
const DEFAULT_PORT_MAX = 62945;
const BIND_HOST = '127.0.0.1';
const clients = new Set();

const defaultCacheDir = path.join(getHomeDir(), '.gemini', 'antigravity', 'cache', 'agy-horizon');
const runtimeDir = path.join(getHomeDir(), '.gemini', 'runtime');
const stateFile = path.join(defaultCacheDir, 'latest.state.json');

const sidePaneHtml = path.resolve(__dirname, '../../src/ui/sidepane.html');
const horizonPanelHtml = path.resolve(__dirname, '../../src/webview/horizon_panel.html');

function getHtmlMtimeMs() {
  const target = fs.existsSync(horizonPanelHtml) ? horizonPanelHtml : (fs.existsSync(sidePaneHtml) ? sidePaneHtml : null);
  if (target) {
    try {
      return fs.statSync(target).mtimeMs;
    } catch (err) {
      if (err?.code !== 'ENOENT') recordDaemonDiagnostic('getHtmlMtimeMs', err);
    }
  }
  return 0;
}

let lastEvalMs = 0;
let cachedLiveState = null;
let pinnedConversationId = null;
let activeLockfiles = [];

const prefixCacheShield = new PrefixCacheShield();
const compactionCoach = new CompactionCoach({ prefixCacheShield, prefixShield: prefixCacheShield });
let rsiEngine = null;
try {
  rsiEngine = new RsiInstinctEngine({ prefixCacheShield, prefixShield: prefixCacheShield });
} catch (err) {
  recordDaemonDiagnostic('init:RsiInstinctEngine', err);
  rsiEngine = null;
}
const uShapedOptimizer = new UShapedAttentionOptimizer({ prefixCacheShield, prefixShield: prefixCacheShield });
const cacheGravityScorer = new CacheGravityScorer();
const modelSelectorActuator = new ModelSelectorActuator({ cacheGravityScorer });
const taskMdWatcher = new TaskMdDirectiveWatcher({ cacheGravityScorer, actuator: modelSelectorActuator });
const hysteresisLock = new HysteresisLock();
const turnBoundaryQueue = new TurnBoundaryActuationQueue();
const circuitBreakers = new CircuitBreakers({ hysteresisLock });
const trajectoryWatcher = new TrajectoryWatcher({ hysteresisLock, circuitBreaker: circuitBreakers });
const handoffHydrator = new HandoffHydrationLauncher();
const cacheTtlWatchdog = new CacheTtlWatchdog({
  onPreSnapshot: () => {
    try {
      const wsDir = cachedLiveState?.workspace?.canonicalPath || process.cwd();
      handoffHydrator.preStageOnTtlSnapshot({
        workspaceDir: wsDir,
        sessionId: cachedLiveState?.sessionId || pinnedConversationId || 'default-session',
        writeToDisk: true,
        writeDocsHandoff: false
      });
    } catch (err) {
      recordDaemonDiagnostic('cacheTtlWatchdog:onPreSnapshot', err);
    }
  }
});
const subagentPhantomAuditor = new SubagentPhantomAuditor();
const turnZeroGate = new TurnZeroGate();
const progressiveCheckpointer = new ProgressiveCheckpointer({
  checkpointDir: path.join(getFlightcheckDir(), 'checkpoints'),
  captureGitStat: false
});
const contradictionAuditor = new ContradictionAuditor();
const reflectorQueue = new ReflectorQueue({ prefixCacheShield });
prefixCacheShield.attachReflectorQueue(reflectorQueue);
const promptDecomposerCoach = new PromptDecomposerCoach();
let savedQuotaLedger = null;
try {
  savedQuotaLedger = new SavedQuotaReceiptLedger();
} catch (err) {
  recordDaemonDiagnostic('init:SavedQuotaReceiptLedger', err);
  savedQuotaLedger = null;
}

let cachedTaskMdMeta = { path: '', mtimeMs: -1, content: '' };
function getCachedTaskMdContent(wsDir) {
  if (!wsDir) return '';
  const candidate = path.join(wsDir, 'task.md');
  try {
    if (!fs.existsSync(candidate)) return '';
    const st = fs.statSync(candidate);
    if (cachedTaskMdMeta.path === candidate && cachedTaskMdMeta.mtimeMs === st.mtimeMs) {
      return cachedTaskMdMeta.content;
    }
    const content = fs.readFileSync(candidate, 'utf8');
    cachedTaskMdMeta = { path: candidate, mtimeMs: st.mtimeMs, content };
    return content;
  } catch (err) {
    if (err?.code !== 'ENOENT') recordDaemonDiagnostic('getCachedTaskMdContent', err);
    return '';
  }
}

let lastBreakerSessionKey = null;
let lastBreakerStepCount = 0;

function syncLiveCircuitBreakers(state, sessionKey) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  if (sessionKey !== lastBreakerSessionKey) {
    circuitBreakers.purgeRewoundTurns(0);
    lastBreakerSessionKey = sessionKey;
    lastBreakerStepCount = 0;
  } else if (steps.length < lastBreakerStepCount) {
    circuitBreakers.purgeRewoundTurns(steps.length);
    lastBreakerStepCount = steps.length;
  }

  for (let idx = lastBreakerStepCount; idx < steps.length; idx++) {
    const st = steps[idx] || {};
    const calls = Array.isArray(st.toolCalls) ? st.toolCalls : [];
    if (calls.length === 0) continue;

    const nextSt = steps[idx + 1] || null;
    const nextHasOwnCalls = Array.isArray(nextSt?.toolCalls) && nextSt.toolCalls.length > 0;
    const isPairedNext = Boolean(
      nextSt &&
      !nextHasOwnCalls &&
      nextSt.type !== 'USER_INPUT' &&
      nextSt.source !== 'USER_EXPLICIT'
    );

    const exitCode = isPairedNext && typeof nextSt.exitCode === 'number'
      ? nextSt.exitCode
      : (typeof st.exitCode === 'number'
        ? st.exitCode
        : ((st.status === 'ERROR' || (isPairedNext && nextSt.status === 'ERROR')) ? 1 : 0));
    const failed = Boolean(st.status === 'ERROR' || (isPairedNext && nextSt.status === 'ERROR') || exitCode !== 0);

    for (const c of calls) {
      const toolName = String(c?.name || c?.tool || '').toLowerCase();
      const args = c?.args || {};
      const filePath = args.Path || args.path || args.TargetFile || args.AbsolutePath || '';
      const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : null;
      const chunksOld = chunks
        ? chunks.map((ch) => String(ch?.TargetContent ?? ch?.Target ?? '')).filter(Boolean).join('\n')
        : undefined;
      const chunksNew = chunks
        ? chunks.map((ch) => String(ch?.ReplacementContent ?? ch?.Replacement ?? '')).filter(Boolean).join('\n')
        : undefined;
      const previousContent = args.Target !== undefined
        ? args.Target
        : (args.TargetContent !== undefined ? args.TargetContent : chunksOld);
      const newContent = args.Content !== undefined
        ? args.Content
        : (args.CodeContent !== undefined
          ? args.CodeContent
          : (args.Replacement !== undefined
            ? args.Replacement
            : (args.ReplacementContent !== undefined ? args.ReplacementContent : chunksNew)));
      circuitBreakers.recordTurn({
        turnIndex: Number.isFinite(st.stepIndex) ? st.stepIndex : idx,
        toolName,
        args,
        exitCode,
        failed,
        filePath,
        previousContent,
        newContent
      });
    }
  }
  lastBreakerStepCount = steps.length;
}

function buildCoachState(state, targetConvId) {
  try {
    const sessionKey = targetConvId || state?.sessionId || 'default';
    const wsDir = state?.workspace?.canonicalPath || process.cwd();
    const taskMdContent = state?.taskMdContent || getCachedTaskMdContent(wsDir);
    const livePrompt = String(state?.lastUserPrompt || '');

    const ttlSec = Math.max(0, Number(state?.quota?.cache?.ttlRemainingSec ?? state?.cache?.ttlRemainingSec ?? 0) || 0);
    // Single source of truth for cache warmth: classifier `sessionRisk.isCacheTrulyWarm`
    // (requires real cache-read evidence). A cold/busted cache contributes 0 warm tokens,
    // so Coach never defends a prefix that is not actually resident.
    const cacheBlock = state?.quota?.cache || state?.cache || {};
    const totalActive = Number(state?.window?.totalActiveTokens || state?.tokens?.total || 0);
    const trulyWarm = typeof state?.sessionRisk?.isCacheTrulyWarm === 'boolean'
      ? state.sessionRisk.isCacheTrulyWarm
      : (ttlSec > 0 && Number(cacheBlock.cacheReadTokens || 0) > 0 && !cacheBlock.prefixBustDetected);
    const cachedTokens = trulyWarm
      ? Math.max(Number(cacheBlock.lastTurnCacheReadTokens || 0), totalActive)
      : 0;
    const session = {
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      ttlRemainingSeconds: ttlSec,
      turnCount: Number(state?.window?.turnCount ?? state?.turnCount ?? 0)
    };

    syncLiveCircuitBreakers(state, sessionKey);

    let scopeCollisionAlert = null;
    try {
      const registry = loadScopeLockRegistry(wsDir);
      if (Array.isArray(registry.leases) && registry.leases.length > 0) {
        const stepEditedPaths = [];
        for (const st of (Array.isArray(state?.steps) ? state.steps : [])) {
          for (const c of (Array.isArray(st?.toolCalls) ? st.toolCalls : [])) {
            if (/write|edit|replace|create|patch/i.test(String(c?.name || ''))) {
              const p = c?.args?.Path || c?.args?.path || c?.args?.TargetFile || c?.args?.AbsolutePath;
              if (p) stepEditedPaths.push(path.isAbsolute(p) ? path.relative(wsDir, p) : String(p));
            }
          }
        }
        const claimed = Array.from(new Set([
          ...deriveSessionClaimedPaths({ workspaceDir: wsDir, taskMdContent }),
          ...stepEditedPaths
        ]));
        const collision = detectScopeCollision(sessionKey, claimed, registry.leases);
        if (collision) {
          const shortId = String(sessionKey).slice(0, 8);
          const worktreeCommand = `git worktree add ../${path.basename(wsDir)}-worktree-${shortId} -b feature-parallel-${shortId}`;
          scopeCollisionAlert = {
            detectorId: 'DET-20',
            name: 'Scope Lock Collision',
            severity: 'WARN',
            conflictingTrajectoryId: collision.trajectoryId,
            conflictingPid: collision.pid,
            overlappingPaths: collision.overlappingPaths,
            worktreeCommand,
            message: `🚨 DET-20 Scope Collision: [${collision.overlappingPaths.join(', ')}] leased by "${collision.trajectoryId}" (PID ${collision.pid}). Isolate via git worktree.`
          };
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') recordDaemonDiagnostic('buildCoachState:scopeCollision', err);
    }

    const shieldStatus = prefixCacheShield.getStatus(session);
    const compactionEval = assessCompactionState({
      totalTokens: cachedTokens,
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      turnCount: session.turnCount,
      reclaimableWasteTokens: Number(state?.metrics?.sludgeTokens || 0)
    });

    const clusters = rsiEngine?.getDomainClusters ? rsiEngine.getDomainClusters() : [];
    const horizonCfg = loadHorizonConfig({ cwd: wsDir });
    const configuredFlightMode = String(horizonCfg.flightMode || 'COACH').toUpperCase();
    const effectiveRouterMode = modelSelectorActuator.mode === 'autopilot' || configuredFlightMode === 'AUTO_PILOT'
      ? 'autopilot'
      : (configuredFlightMode === 'OFF' ? 'off' : modelSelectorActuator.mode);
    const effectiveFlightMode = effectiveRouterMode === 'autopilot'
      ? 'AUTO_PILOT'
      : configuredFlightMode;

    const resolvedEffort = String(
      state?.activeEffort ||
      state?.activeEffortProfile?.shortLabel ||
      state?.activeEffortProfile?.tier ||
      'auto'
    ).toLowerCase();
    const taskRoute = evaluateTaskAndQuotaRoute({
      prompt: livePrompt,
      taskMdContent,
      activeModel: state?.model?.id || state?.model?.rawLabel || state?.activeModel || 'gemini-4-argon',
      activeEffort: resolvedEffort === 'standard' ? 'auto' : resolvedEffort,
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      routerMode: effectiveRouterMode
    });

    const det17ShadowBloat = detectShadowedFileBloat(state?.steps || []);
    const elapsedIdleSec = Math.max(0, 300 - ttlSec);
    const ttlWatchdogState = cacheTtlWatchdog.evaluateElapsed(elapsedIdleSec, {
      sessionId: sessionKey,
      cachedTokens,
      flightMode: effectiveFlightMode
    });
    const subagentAudit = subagentPhantomAuditor.auditTrajectories(state?.subagents?.invocations || []);
    const ledgerSummary = savedQuotaLedger
      ? savedQuotaLedger.getSummary()
      : {
          totalArgonEquivTokensSaved: 0,
          formattedSavedK: '0.0k',
          statusBarText: '$(shield) Horizon: +0.0k Argon-equiv tokens saved (0 Cold Prefills • 0 Downshifts • 0 CLI Compress)',
          footerText: '🛡️ Horizon: +0.0k Argon-equiv tokens saved (0 Cold Prefills • 0 Downshifts • 0 CLI Compress)'
        };

    const ckptEval = progressiveCheckpointer.evaluateAndSnapshot({
      sessionId: sessionKey,
      totalTokens: cachedTokens,
      maxTokens: Number(state?.window?.maxTokens) || resolveModelCeiling(
        state?.model?.id || state?.model?.rawLabel || state?.activeModel || 'gemini-4-argon',
        null,
        { useLegacyDefault: false }
      ),
      taskMdContent,
      agentsMdContent: state?.agentsMdContent || '',
      userConstraints: state?.userConstraints || [],
      writeToDisk: !Boolean(state?.demoMeta || process.env.HORIZON_DEMO === '1')
    });
    const latestCkpt = progressiveCheckpointer.getLatestCheckpoint(sessionKey);
    const evaporationCheck = latestCkpt && state?.contextSummary
      ? progressiveCheckpointer.detectConstraintEvaporation(state.contextSummary, sessionKey, latestCkpt)
      : null;

    const stagedLearnings = reflectorQueue.listItems();
    const promptAdvisory = promptDecomposerCoach.evaluate(livePrompt);

    const combinedAlerts = [...circuitBreakers.activeAlerts];
    if (scopeCollisionAlert) combinedAlerts.push(scopeCollisionAlert);
    const thinkingDrift = state?.quota?.thinkingDrift || null;
    const det30Mode = String(horizonCfg?.detectors?.['DET-30'] || 'default').toLowerCase();
    if (thinkingDrift?.loop?.triggered && det30Mode !== 'off') {
      combinedAlerts.push({
        detectorId: 'DET-30',
        name: 'thinking-drift-loop',
        severity: thinkingDrift.loop.severity === 'critical' ? 'CRITICAL' : 'WARN',
        message: thinkingDrift.loop.message
      });
    }
    const primaryTripped = combinedAlerts.length > 0 ? combinedAlerts[combinedAlerts.length - 1] : null;

    return {
      prefixCacheShield: shieldStatus,
      detectors: {
        active: true,
        totalCount: 20,
        tripped: primaryTripped
          ? {
              detectorId: primaryTripped.detectorId,
              reason: primaryTripped.message || primaryTripped.name,
              severity: primaryTripped.severity || 'WARN',
              revertAction: primaryTripped.revertAction || null,
              worktreeCommand: primaryTripped.worktreeCommand || null
            }
          : null,
        summary: combinedAlerts.length > 0
          ? `${combinedAlerts.length} breaker${combinedAlerts.length === 1 ? '' : 's'} tripped (${combinedAlerts.map(a => a.detectorId).join(', ')})`
          : '20 guards quiet (DET-01..20 Active)'
      },
      scopeCollision: scopeCollisionAlert,
      thinkingDrift,
      prefixRetention: state?.quota?.cache?.prefixRetention || null,
      det17ShadowBloat,
      ttlWatchdog: ttlWatchdogState,
      hysteresisLock: hysteresisLock.getStatus(),
      turnBoundaryQueue: {
        languageServerState: turnBoundaryQueue.languageServerState,
        queuedCount: turnBoundaryQueue.queue.length
      },
      circuitBreakerAlerts: combinedAlerts,
      subagentAudit,
      turnZeroGate: {
        lockedByInvariant1: turnZeroGate.isWarmPrefixLocked(session),
        queuedCount: turnZeroGate.queuedMutations.length,
        activeMcpProfile: turnZeroGate.activeMcpProfile
      },
      checkpoints: {
        latest: latestCkpt,
        evaporationCheck,
        allBands: progressiveCheckpointer.listCheckpoints(targetConvId || state?.sessionId || 'default')
      },
      reflectorQueue: {
        projectHash: reflectorQueue.projectHash,
        items: stagedLearnings,
        stagedCount: stagedLearnings.filter((it) => it.status === 'staged').length,
        approvedCount: stagedLearnings.filter((it) => it.status === 'approved').length
      },
      promptAdvisory,
      savedQuotaLedger: ledgerSummary,
      fts5Compressor: {
        active: true,
        savedTokens: getFts5CompressionStats().savedTokens
      },
      compactionCoach: compactionEval,
      rsiEngine: {
        clusters,
        readyToEvolveCount: clusters.length,
        globalCandidates: rsiEngine?.getGlobalPromotionCandidates ? rsiEngine.getGlobalPromotionCandidates() : []
      },
      uShapedAttention: (() => {
        try {
          const ruleScan = uShapedOptimizer.scanWorkspaceAndGlobalRules();
          return {
            healthScore: ruleScan?.avgPrimacyPct || 94,
            middleTroughRiskCount: ruleScan?.totalMiddleTroughRisk || 0,
            recencyMirrorActive: Boolean(fs.existsSync(path.join(wsDir || '.', 'task.md')) && fs.readFileSync(path.join(wsDir || '.', 'task.md'), 'utf8').includes('## Active Guardrail Pin'))
          };
        } catch (err) {
          if (err?.code !== 'ENOENT') recordDaemonDiagnostic('buildCoachState:uShapedAttention', err);
          return {
            healthScore: 94,
            middleTroughRiskCount: 0,
            recencyMirrorActive: false
          };
        }
      })(),
      taskQuotaRouter: taskRoute
    };
  } catch (err) {
    recordDaemonDiagnostic('buildCoachState', err);
    return null;
  }
}

function getWorkspaceHash(wsPath = process.cwd()) {
  return crypto.createHash('sha1').update(String(wsPath).toLowerCase()).digest('hex').slice(0, 10);
}

function writeRuntimeLockfile(boundPort, workspacePath = process.cwd()) {
  try {
    const homeDir = getHomeDir();
    fs.mkdirSync(runtimeDir, { recursive: true });
    const ctxtopPortFile = getDaemonPortFile(homeDir);
    const ctxtopDir = path.dirname(ctxtopPortFile);
    const ctxtopJsonFile = path.join(ctxtopDir, 'daemon.json');
    fs.mkdirSync(ctxtopDir, { recursive: true });

    const wsHash = getWorkspaceHash(workspacePath);
    const payload = JSON.stringify({
      pid: process.pid,
      port: boundPort,
      host: BIND_HOST,
      workspace: workspacePath,
      workspaceHash: wsHash,
      startedAt: new Date().toISOString()
    }, null, 2);

    const wsPortFile = path.join(runtimeDir, `horizon-${wsHash}.port`);
    const wsJsonFile = path.join(runtimeDir, `horizon-${wsHash}.json`);
    const latestJsonFile = path.join(runtimeDir, 'horizon-latest.json');

    atomicWriteFileSync(wsPortFile, String(boundPort), { encoding: 'utf8' });
    atomicWriteFileSync(wsJsonFile, payload, { encoding: 'utf8' });
    atomicWriteFileSync(latestJsonFile, payload, { encoding: 'utf8' });
    atomicWriteFileSync(ctxtopPortFile, String(boundPort), { encoding: 'utf8' });
    atomicWriteFileSync(ctxtopJsonFile, payload, { encoding: 'utf8' });
    activeLockfiles = [wsPortFile, wsJsonFile, ctxtopPortFile, ctxtopJsonFile];
  } catch (err) {
    recordDaemonDiagnostic('writeRuntimeLockfile', err);
  }
}

function cleanupRuntimeLockfiles() {
  for (const f of activeLockfiles) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (err) {
      if (err?.code !== 'ENOENT') recordDaemonDiagnostic('cleanupRuntimeLockfiles', err);
    }
  }
}

process.on('exit', cleanupRuntimeLockfiles);
process.on('SIGINT', () => { cleanupRuntimeLockfiles(); process.exit(0); });
process.on('SIGTERM', () => { cleanupRuntimeLockfiles(); process.exit(0); });

async function refreshLiveState(force = false, explicitConvId = null) {
  const now = Date.now();
  const htmlMtimeMs = getHtmlMtimeMs();
  const targetConvId = explicitConvId || pinnedConversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  if (!force && !explicitConvId && cachedLiveState && (now - lastEvalMs) < 1000) {
    if (cachedLiveState) {
      cachedLiveState.uiMtimeMs = htmlMtimeMs;
      try {
        cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId);
      } catch (err) {
        recordDaemonDiagnostic('refreshLiveState:cachedCoachState', err);
      }
    }
    return cachedLiveState;
  }
  try {
    const [resLive, hostHealth] = await Promise.all([
      runCLI({
        silent: true,
        useNativeCeiling: true,
        stdinData: targetConvId ? { conversation_id: targetConvId } : null
      }),
      inspectHostProcesses({ force: false }).catch((err) => {
        recordDaemonDiagnostic('refreshLiveState:inspectHostProcesses', err);
        return null;
      })
    ]);
    if (resLive && resLive.state) {
      resLive.state.pinnedConversationId = pinnedConversationId;
      resLive.state.hostHealth = hostHealth;
      resLive.state.uiMtimeMs = htmlMtimeMs;
      try {
        const wsPath = resLive.state.workspace?.canonicalPath || process.cwd();
        resLive.state.gitLedger = buildGitCommitTokenLedger(wsPath, []);
      } catch (err) {
        if (err?.code !== 'ENOENT') recordDaemonDiagnostic('refreshLiveState:gitLedger', err);
      }
      cachedLiveState = resLive.state;
      lastEvalMs = now;
      try {
        cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId);
      } catch (err) {
        recordDaemonDiagnostic('refreshLiveState:liveCoachState', err);
      }
      if (
        cachedLiveState?.coachState?.taskRoute &&
        (modelSelectorActuator.mode === 'autopilot' || cachedLiveState.coachState.taskRoute.routerMode === 'autopilot')
      ) {
        try {
          cachedLiveState.coachState.autoPilotActuation = await actuateRoutingRecommendation(
            cachedLiveState.coachState.taskRoute,
            {
              actuator: modelSelectorActuator,
              flightMode: 'AUTO_PILOT',
              sessionId: targetConvId || cachedLiveState.sessionId || 'default_session',
              cachedTokens: Number(cachedLiveState?.window?.totalActiveTokens || 0),
              cacheTtlSeconds: Number(cachedLiveState?.quota?.cache?.ttlRemainingSec || 0)
            }
          );
        } catch (err) {
          recordDaemonDiagnostic('refreshLiveState:autoPilotActuation', err);
        }
      }
      return cachedLiveState;
    }
  } catch (err) {
    recordDaemonDiagnostic('refreshLiveState:runCLI', err);
  }

  if (fs.existsSync(stateFile)) {
    try {
      cachedLiveState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      cachedLiveState.uiMtimeMs = htmlMtimeMs;
      if (!cachedLiveState.hostHealth) {
        cachedLiveState.hostHealth = await inspectHostProcesses({ force: false }).catch((err) => {
          recordDaemonDiagnostic('refreshLiveState:stateFileHostProcesses', err);
          return null;
        });
      }
      try {
        cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId);
      } catch (err) {
        recordDaemonDiagnostic('refreshLiveState:stateFileCoachState', err);
      }
      return cachedLiveState;
    } catch (err) {
      if (err?.code !== 'ENOENT') recordDaemonDiagnostic('refreshLiveState:readStateFile', err);
    }
  }

  // Fallback to FlightCheck session sidecar if present (strictly real UUID sessions, never synthetic test fixtures)
  const fcSessionsDir = path.join(getHomeDir(), '.gemini', 'flightcheck', 'sessions');
  if (fs.existsSync(fcSessionsDir)) {
    try {
      const uuidSidecarRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sidecar\.json$/i;
      const files = fs.readdirSync(fcSessionsDir)
        .filter(f => uuidSidecarRe.test(f))
        .map(f => ({ name: f, time: fs.statSync(path.join(fcSessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (files.length > 0) {
        cachedLiveState = JSON.parse(fs.readFileSync(path.join(fcSessionsDir, files[0].name), 'utf8'));
        cachedLiveState.uiMtimeMs = htmlMtimeMs;
        try {
          cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId);
        } catch (err) {
          recordDaemonDiagnostic('refreshLiveState:sidecarCoachState', err);
        }
        return cachedLiveState;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') recordDaemonDiagnostic('refreshLiveState:readSidecarFallback', err);
    }
  }

  if (!cachedLiveState && isDemoMode) {
    try {
      const demoRes = await runCLI({ silent: true, demo: true, useNativeCeiling: true });
      if (demoRes && demoRes.state) {
        cachedLiveState = demoRes.state;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') recordDaemonDiagnostic('refreshLiveState:demoFallback', err);
    }
  }

  if (cachedLiveState) {
    cachedLiveState.uiMtimeMs = htmlMtimeMs;
    try {
      cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId);
    } catch (err) {
      recordDaemonDiagnostic('refreshLiveState:finalCoachState', err);
    }
  }
  return cachedLiveState;
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const LOOPBACK_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const IDE_WEBVIEW_ORIGIN_RE = /^(vscode-webview|antigravity):\/\//i;

export function isAllowedOriginHeader(origin) {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  const s = String(origin);
  return LOOPBACK_ORIGIN_RE.test(s) || IDE_WEBVIEW_ORIGIN_RE.test(s);
}

/**
 * Allows only requests addressed to this loopback daemon (Host check blocks DNS rebinding)
 * and, when a browser sends an Origin header, only strict local loopback pages or IDE webviews
 * (explicitly rejecting `Origin: null` sandboxed iframes).
 */
export function isAllowedLocalRequest(req) {
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const hostMatch = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!hostMatch || !LOCAL_HOSTNAMES.has(hostMatch[1])) return false;

  const sidecarToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  if (sidecarToken && req.headers['x-sidecar-token'] === sidecarToken) {
    return true;
  }

  return isAllowedOriginHeader(req.headers.origin);
}

/**
 * Reads an HTTP request body up to `maxBytes` (default 1 MB).
 * Responds with `413 Payload Too Large` and destroys the socket on oversized payloads.
 */
function readRequestBody(req, res, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve) => {
    const declaredLen = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(
        JSON.stringify({ success: false, error: `Payload Too Large (max ${maxBytes} bytes)` }),
        () => {
          try {
            req.destroy();
          } catch (err) {
            if (err?.code !== 'ERR_STREAM_DESTROYED') recordDaemonDiagnostic('readRequestBody:destroy413Header', err);
          }
        }
      );
      resolve(null);
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        try {
          req.pause();
        } catch (err) {
          recordDaemonDiagnostic('readRequestBody:pause', err);
        }
        res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(
          JSON.stringify({ success: false, error: `Payload Too Large (max ${maxBytes} bytes)` }),
          () => {
            try {
              req.destroy();
            } catch (err) {
              if (err?.code !== 'ERR_STREAM_DESTROYED') recordDaemonDiagnostic('readRequestBody:destroy413Stream', err);
            }
          }
        );
        resolve(null);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      resolve(null);
    });
  });
}

const RULE_FILE_RE = /(^|[\\/])(AGENTS\.md|GEMINI\.md)$|[\\/]\.agents[\\/]rules[\\/][^\\/]+\.md$/i;

function parseJsonBodyOrSend400(bodyStr, res, routeName) {
  const trimmed = String(bodyStr ?? '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    recordDaemonDiagnostic(`${routeName}:parseBody`, err);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, success: false, error: err?.message || 'Invalid JSON' }));
    }
    return null;
  }
}

function sendRouteError500(res, routeName, err) {
  recordDaemonDiagnostic(routeName, err);
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, success: false, error: String(err?.message || err) }));
  }
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  const isStaticUiAsset = req.method === 'GET' && (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/widget' ||
    url.pathname === '/widget.html' ||
    url.pathname === '/preload.js' ||
    url.pathname === '/favicon.ico'
  );

  // Host header is always verified (blocks DNS rebinding).
  // Origin is strictly enforced for API / mutation endpoints.
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const hostMatch = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  const isHostValid = hostMatch && LOCAL_HOSTNAMES.has(hostMatch[1]);
  const sidecarToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  const hasValidTokenQuery = Boolean(sidecarToken && url.searchParams.get('token') === sidecarToken);

  if (!isHostValid || (!isStaticUiAsset && !hasValidTokenQuery && !isAllowedLocalRequest(req))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: cross-origin or non-local request' }));
    return;
  }

  // Emit CORS headers ONLY echoing the specific validated origin (never wildcard '*')
  const origin = req.headers.origin;
  if (origin && isAllowedOriginHeader(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token, X-Horizon-CSRF');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/api/csrf-token' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true, csrfToken: HORIZON_CSRF_TOKEN }));
    return;
  }

  // Enforce per-boot random CSRF token on browser-originated mutating POST requests
  if (req.method === 'POST') {
    const providedCsrf = req.headers['x-horizon-csrf'];
    const isBrowserOriginated = Boolean(req.headers.origin);
    const hasValidSidecarHeader = Boolean(sidecarToken && req.headers['x-sidecar-token'] === sidecarToken);
    if (isBrowserOriginated && !hasValidSidecarHeader && !isValidCsrfToken(providedCsrf)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Forbidden: missing or invalid X-Horizon-CSRF token' }));
      return;
    }
    if (!isBrowserOriginated && providedCsrf !== undefined && !isValidCsrfToken(providedCsrf)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Forbidden: invalid X-Horizon-CSRF token' }));
      return;
    }
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }

  if (url.pathname === '/api/health') {
    const addr = server.address();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      port: addr ? addr.port : 0,
      workspace: cachedLiveState?.workspace?.canonicalPath || process.cwd(),
      pinnedConversationId,
      diagnostics: getDaemonDiagnostics()
    }));
    return;
  }

  if (url.pathname === '/preload.js') {
    const candidates = [
      path.join(getHomeDir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
      path.join(getHomeDir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'preload.js')
    ];
    const target = candidates.find(p => fs.existsSync(p));
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(target ? fs.readFileSync(target) : '// no preload');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/widget' || url.pathname === '/widget.html') {
    const qConv = url.searchParams.get('conversationId');
    if (qConv && qConv !== 'auto') {
      pinnedConversationId = qConv;
    }
    const initState = await refreshLiveState(false, pinnedConversationId);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    const rawHtmlPath = fs.existsSync(horizonPanelHtml)
      ? horizonPanelHtml
      : (fs.existsSync(sidePaneHtml) ? sidePaneHtml : null);
    if (rawHtmlPath) {
      let html = fs.readFileSync(rawHtmlPath, 'utf8');
      const mtimeMs = getHtmlMtimeMs();
      const mtimeScript = `<script id="liveInitialMtime">window.__INITIAL_UI_MTIME__ = ${mtimeMs}; window.__HORIZON_CSRF_TOKEN__ = ${JSON.stringify(HORIZON_CSRF_TOKEN)};</script>`;
      if (initState) {
        initState.uiMtimeMs = mtimeMs;
        const safeJson = JSON.stringify(initState)
          .replace(/</g, '\\u003c')
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029');
        const stateScript = `<script id="liveInitialState">window.__LIVE_INITIAL_STATE__ = ${safeJson};</script>`;
        html = html.replace(
          '<script id="precomputedCatalogScript">',
          () => `${mtimeScript}\n${stateScript}\n<script id="precomputedCatalogScript">`
        );
      } else {
        html = html.replace(
          '<script id="precomputedCatalogScript">',
          () => `${mtimeScript}\n<script id="precomputedCatalogScript">`
        );
      }
      res.end(html);
    } else {
      res.end('<h1>Attention Horizon Side-Pane</h1>');
    }
    return;
  }

  if (url.pathname === '/api/state') {
    const qConv = url.searchParams.get('conversationId');
    const qScenario = url.searchParams.get('scenario');
    if (qScenario) {
      process.env.HORIZON_DEMO = '1';
      process.env.HORIZON_DEMO_SCENARIO = qScenario;
    }
    if (qConv) {
      pinnedConversationId = qConv === 'auto' ? null : qConv;
    }
    const forceEval = Boolean(qConv || qScenario || url.searchParams.get('force') === '1');
    const state = await refreshLiveState(forceEval, pinnedConversationId);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(state || {}));
    return;
  }

  // Route: GET /api/cost-radar (Sprint 2.2 HTML/SVG timeline artifact, loopback only)
  if (url.pathname === '/api/cost-radar' && req.method === 'GET') {
    try {
      const state = await refreshLiveState(false, pinnedConversationId);
      const { html, summary } = buildCostRadarFromState(state || {});
      if (url.searchParams.get('format') === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...summary }));
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        });
        res.end(html);
      }
    } catch (err) {
      sendRouteError500(res, 'GET /api/cost-radar', err);
    }
    return;
  }

  if (url.pathname === '/api/stream') {
    if (clients.size >= MAX_SSE_CLIENTS) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `SSE client cap reached (max ${MAX_SSE_CLIENTS})` }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    clients.add(res);
    const current = await refreshLiveState(true);
    if (current) {
      res.write(`data: ${JSON.stringify(current)}\n\n`);
    }

    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ settings: loadSettings(defaultCacheDir), limits: SETTINGS_LIMITS }));
      return;
    }
    if (req.method === 'POST') {
      const bodyStr = await readRequestBody(req, res);
      if (bodyStr === null) return;
      const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/settings');
      if (body === null) return;
      const patch = {};
      for (const k of ['safeLimitTokens', 'reminderAtPct', 'modelOverrides']) {
        if (body && body[k] !== undefined) patch[k] = body[k];
      }
      try {
        const settings = saveSettings(defaultCacheDir, patch);
        const nextState = await refreshLiveState(true, pinnedConversationId);
        broadcastState(nextState);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, settings, state: nextState }));
      } catch (e) {
        sendRouteError500(res, 'POST /api/settings', e);
      }
      return;
    }
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  // Route: POST /api/prune (Prefix-Safe Surgical Context Pruner & AST Folder)
  if (url.pathname === '/api/prune' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/prune');
    if (body === null) return;
    const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
    const sessionInfo = findSessionDirectory(targetConvId);
    if (!sessionInfo || !sessionInfo.sessionDir) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Active session directory not found' }));
      return;
    }
    const pruneResult = pruneSessionTranscript(sessionInfo.sessionDir, {
      dryRun: Boolean(body.dryRun),
      forceHotCache: Boolean(body.forceHotCache),
      cacheDir: defaultCacheDir
    });
    const nextState = await refreshLiveState(true, targetConvId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...pruneResult, state: nextState }));
    return;
  }

  // Route: POST /api/host/reap (Host Process & Zombie Subagent/MCP Watchdog)
  if (url.pathname === '/api/host/reap' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/host/reap');
    if (body === null) return;
    const reapResult = await reapOrphanProcesses(body.pids || null);
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...reapResult, state: nextState }));
    return;
  }

  // Route: POST /api/open-brain (Dual-Target Session Jump: Alt+Click opens ~/.gemini/<surface>/brain/<uuid>/)
  if (url.pathname === '/api/open-brain' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/open-brain');
    if (body === null) return;
    const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
    const requestedSurface = ['antigravity', 'antigravity-ide', 'antigravity-cli'].includes(body.surface)
      ? body.surface
      : null;
    const sessionInfo = findSessionDirectory(targetConvId);
    const safeId = String(targetConvId || sessionInfo?.sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const matchedInfo = (sessionInfo && sessionInfo.sessionId === safeId) ? sessionInfo : null;
    const surfaceName = requestedSurface || matchedInfo?.storeName || sessionInfo?.storeName || cachedLiveState?.storeSource || 'antigravity';

    let resolvedBrainDir = null;
    if (matchedInfo && matchedInfo.sessionDir && fs.existsSync(matchedInfo.sessionDir)) {
      resolvedBrainDir = matchedInfo.sessionDir;
    } else if (safeId) {
      const directBrainDir = path.join(getHomeDir(), '.gemini', surfaceName, 'brain', safeId);
      if (fs.existsSync(directBrainDir)) {
        resolvedBrainDir = directBrainDir;
      }
    }
    let fallbackUsed = false;

    if (!resolvedBrainDir || !fs.existsSync(resolvedBrainDir)) {
      const convDir = path.join(getHomeDir(), '.gemini', surfaceName, 'conversations');
      if (fs.existsSync(convDir)) {
        resolvedBrainDir = convDir;
        fallbackUsed = true;
      } else {
        const surfaceRoot = path.join(getHomeDir(), '.gemini', surfaceName);
        if (fs.existsSync(surfaceRoot)) {
          resolvedBrainDir = surfaceRoot;
          fallbackUsed = true;
        }
      }
    }

    if (!resolvedBrainDir || !fs.existsSync(resolvedBrainDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Session brain directory not found' }));
      return;
    }

    if (!body.dryRun && process.env.HORIZON_TEST_NO_SPAWN !== '1') {
      try {
        const onSpawnDone = (spawnErr) => {
          if (spawnErr) recordDaemonDiagnostic('POST /api/open-brain:execFile', spawnErr);
        };
        if (process.platform === 'win32') {
          execFile('explorer.exe', [resolvedBrainDir], onSpawnDone);
        } else if (process.platform === 'darwin') {
          execFile('open', [resolvedBrainDir], onSpawnDone);
        } else {
          execFile('xdg-open', [resolvedBrainDir], onSpawnDone);
        }
      } catch (err) {
        recordDaemonDiagnostic('POST /api/open-brain:spawn', err);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      conversationId: safeId,
      surface: surfaceName,
      surfaceTag: resolveSurfaceTag(surfaceName),
      brainDir: resolvedBrainDir,
      fallbackUsed
    }));
    return;
  }

  // Route: POST /api/handoff or /api/handoff/generate (The Baton Pass /handoff Markdown Generator)
  if ((url.pathname === '/api/handoff' || url.pathname === '/api/handoff/generate') && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, `POST ${url.pathname}`);
    if (body === null) return;
    const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
    const state = await refreshLiveState(false, targetConvId) || cachedLiveState || {};
    const handoffRes = generateHandoffMarkdown(state, {
      timestamp: body.timestamp || null,
      workspacePath: body.workspacePath || state?.workspace?.canonicalPath || process.cwd(),
      writeToDisk: body.writeToDisk !== false
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(handoffRes));
    return;
  }

  // Route: POST /api/hooks/dampen (Fail-Open CLI Command Dampening Hook in .agents/hooks.json)
  if (url.pathname === '/api/hooks/dampen' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/hooks/dampen');
    if (body === null) return;
    const wsPath = body.workspacePath || cachedLiveState?.workspace?.canonicalPath || process.cwd();
    const hookRes = registerCliDampeningHook(wsPath, {
      command: body.command || '',
      maxLines: body.maxLines || 100,
      logFile: body.logFile || '.agents/tmp/cli_stdout.log',
      writeToDisk: body.writeToDisk !== false
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(hookRes));
    return;
  }

  // Route: POST /api/rules/promote (Attention-Aware Rule Promotion in Primacy/Recency zones)
  if (url.pathname === '/api/rules/promote' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/rules/promote');
    if (body === null) return;
    const wsPath = body.targetPath || body.workspacePath || cachedLiveState?.workspace?.canonicalPath || process.cwd();
    // Only rule files may be written: a directory target, or an explicit AGENTS.md / GEMINI.md / .agents/rules/*.md file.
    let isDirTarget = false;
    try {
      isDirTarget = fs.existsSync(wsPath) && fs.statSync(wsPath).isDirectory();
    } catch (err) {
      if (err?.code !== 'ENOENT') recordDaemonDiagnostic('POST /api/rules/promote:statTarget', err);
    }
    const badTarget = !isDirTarget && !RULE_FILE_RE.test(String(wsPath));
    const badFileName = body.targetFileName != null && !/^[\w.-]+\.md$/i.test(String(body.targetFileName));
    if (badTarget || badFileName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Rule promotion target must be a rule file (AGENTS.md, GEMINI.md, .agents/rules/*.md)' }));
      return;
    }
    const fallbackRule = cachedLiveState?.brainSignals?.userCorrectionTexts?.[0] ||
      'Follow all in-chat user corrections and architectural constraints.';
    const resolvedRuleText = body.ruleText || fallbackRule;

    const liveCachedTokens = Number(
      body.cachedTokens ??
      cachedLiveState?.window?.totalActiveTokens ??
      cachedLiveState?.tokens?.total ??
      0
    );
    const liveTtlSec = Math.max(0, Number(
      body.cacheTtlSeconds ??
      cachedLiveState?.quota?.cache?.ttlRemainingSec ??
      cachedLiveState?.cache?.ttlRemainingSec ??
      0
    ) || 0);
    const liveTurnCount = Number(
      body.turnCount ??
      cachedLiveState?.window?.turnCount ??
      cachedLiveState?.turnCount ??
      1
    );
    const shieldStatus = prefixCacheShield.getStatus({
      cachedTokens: liveCachedTokens,
      cacheTtlSeconds: liveTtlSec,
      turnCount: liveTurnCount
    });

    if (shieldStatus.locked && body.writeToDisk !== false && !body.forceHotCache) {
      try {
        reflectorQueue.enqueue({
          directive_action: resolvedRuleText,
          domain: 'rules',
          sessionId: cachedLiveState?.sessionId || pinnedConversationId || 'default-session'
        });
      } catch (err) {
        recordDaemonDiagnostic('POST /api/rules/promote:enqueueStaged', err);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        staged: true,
        requiresConfirmation: true,
        ttlRemainingSec: liveTtlSec,
        cachedTokens: liveCachedTokens,
        reason: `Warm prompt cache active (${liveTtlSec}s TTL). Rule promotion staged until cache expires to protect your 95% KV discount.`
      }));
      return;
    }

    const promoRes = promoteRuleWithAttentionZone(wsPath, resolvedRuleText, {
      zone: body.zone || 'primacy',
      targetFileName: body.targetFileName || null,
      maxLines: body.maxLines || 200,
      writeToDisk: body.writeToDisk !== false
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(promoRes));
    return;
  }

  // Route: POST /api/export/sanitized (Zero-PII Sanitized Snapshot Exporter)
  if (url.pathname === '/api/export/sanitized' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/export/sanitized');
    if (body === null) return;
    const targetState = body.state || cachedLiveState || (await refreshLiveState(true, pinnedConversationId)) || {};
    const outPath = path.join(defaultCacheDir, `sanitized_snapshot_${Date.now()}.json`);
    const expRes = exportSanitizedSnapshot(targetState, {
      format: body.format || 'json',
      outputPath: outPath
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(expRes));
    return;
  }

  // Route: POST /api/surgeon (Offline Tool-Output Surgeon)
  if (url.pathname === '/api/surgeon' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/surgeon');
    if (body === null) return;
    const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
    const sessionInfo = findSessionDirectory(targetConvId);
    const transcriptFile = body.transcriptPath ||
      (sessionInfo?.sessionDir ? path.join(sessionInfo.sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl') : null);
    const surgRes = executeToolOutputSurgery(transcriptFile, { dryRun: Boolean(body.dryRun) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(surgRes));
    return;
  }

  // Route: GET /api/memory/resume (SQLite FTS5 Episodic Memory Resume Pack)
  if (url.pathname === '/api/memory/resume' && req.method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const wsPath = url.searchParams.get('workspace') || cachedLiveState?.workspace?.canonicalPath || process.cwd();
    const epDbPath = path.join(getFlightcheckDir(), 'episodic_memory.db');
    const pack = await synthesizeResumeHerePack(epDbPath, { workspacePath: wsPath, query });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(pack));
    return;
  }

  // Helper: Resolve live or caller-supplied warm-cache state for ISS-041 PrefixCacheShield fencing
  const resolveRouteCacheContext = (body = {}) => {
    const cachedTokens = body.cachedTokens !== undefined
      ? Number(body.cachedTokens || 0)
      : Number(cachedLiveState?.window?.totalActiveTokens ?? cachedLiveState?.tokens?.total ?? 0);
    const cacheTtlSeconds = body.cacheTtlSeconds !== undefined
      ? Number(body.cacheTtlSeconds || 0)
      : Number(cachedLiveState?.quota?.cache?.ttlRemainingSec ?? cachedLiveState?.cache?.ttlRemainingSec ?? 0);
    const cacheState = body.cacheState || body.options?.cacheState || null;
    const cacheWarm = body.cacheWarm === true || body.options?.cacheWarm === true;
    return {
      cachedTokens,
      cacheTtlSeconds,
      ttlRemainingSeconds: cacheTtlSeconds,
      ...(cacheState ? { cacheState } : {}),
      ...(cacheWarm ? { cacheWarm: true } : {})
    };
  };

  // Route: POST /api/shield/flush (Flush PrefixCacheShield staged deltas — fenced when cache is warm unless force=true)
  if (url.pathname === '/api/shield/flush' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/shield/flush');
    if (body === null) return;
    const sessCtx = resolveRouteCacheContext(body);
    const forceFlush = body.force === true || body.forceColdBust === true;
    if (!forceFlush && prefixCacheShield.isPrefixLocked(sessCtx)) {
      const shieldState = prefixCacheShield.getStatus(sessCtx);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        flushed: false,
        deferred: true,
        reason: 'CACHE_WARM_FENCE',
        queuedCount: shieldState.queuedCount,
        ttlRemainingSec: sessCtx.cacheTtlSeconds,
        cachedTokens: sessCtx.cachedTokens
      }));
      return;
    }
    const resPayload = prefixCacheShield._flushAllNow('MANUAL_FLUSH');
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, deferred: false, ...resPayload, state: nextState }));
    return;
  }

  // Route: POST /api/tail/trim (Read-Only Host Transcript Analysis -> Staged Plugin Output)
  if (url.pathname === '/api/tail/trim' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/tail/trim');
    if (body === null) return;
    const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
    const sessionInfo = findSessionDirectory(targetConvId);
    const transcriptFile = body.transcriptPath || (sessionInfo?.sessionDir
      ? path.join(sessionInfo.sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl')
      : null);
    let trimRes = {
      trimmed: false,
      message: 'No transcript found',
      hostTranscriptMutated: false,
      persistBlockedReason: body.persist ? 'HOST_TRANSCRIPT_READONLY_GUARD' : null
    };
    if (transcriptFile && fs.existsSync(transcriptFile)) {
      try {
        // Strictly read-only ('r') on host Antigravity transcript logs (AGENTS.md Invariant 4 & ISS-040)
        const fd = fs.openSync(transcriptFile, 'r');
        let rawTranscript = '';
        try {
          rawTranscript = fs.readFileSync(fd, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        const lines = rawTranscript.trim().split('\n').filter(Boolean);
        const steps = lines.map(l => JSON.parse(l));
        const offloadDir = body.cwd
          ? path.join(body.cwd, '.agents', 'tmp')
          : path.join(defaultCacheDir, 'staged_trims', 'offloads');
        trimRes = trimUncachedTail(steps, {
          cachedTokens: cachedLiveState?.window?.totalActiveTokens || 50000,
          ...(body.cwd ? { cwd: body.cwd } : { offloadDir })
        });
        if (trimRes && typeof trimRes === 'object') {
          trimRes.hostTranscriptMutated = false;
          trimRes.persistBlockedReason = body.persist ? 'HOST_TRANSCRIPT_READONLY_GUARD' : null;
        }
        if (trimRes && trimRes.modifiedCount > 0 && trimRes.headBytesPreserved) {
          const safeSessionSlug = String(sessionInfo?.sessionId || targetConvId || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
          const stagedDir = path.join(defaultCacheDir, 'staged_trims');
          const stagedFullPath = path.join(stagedDir, `${safeSessionSlug}.transcript_full.staged.jsonl`);
          const serialized = trimRes.prunedSteps.map(s => JSON.stringify(s)).join('\n') + '\n';
          atomicWriteFileSync(stagedFullPath, serialized, { encoding: 'utf8' });
          trimRes.trimmed = true;
          trimRes.stagedOnly = true;
          trimRes.hostTranscriptMutated = false;
          trimRes.stagedPath = stagedFullPath;

          // Also stage companion transcript.jsonl preview without mutating host logs
          const compactFile = path.join(path.dirname(transcriptFile), 'transcript.jsonl');
          if (fs.existsSync(compactFile)) {
            try {
              const cFd = fs.openSync(compactFile, 'r');
              let rawCompact = '';
              try {
                rawCompact = fs.readFileSync(cFd, 'utf8');
              } finally {
                fs.closeSync(cFd);
              }
              const cLines = rawCompact.trim().split('\n').filter(Boolean);
              const cSteps = cLines.map(l => JSON.parse(l));
              const cRes = trimUncachedTail(cSteps, {
                cachedTokens: cachedLiveState?.window?.totalActiveTokens || 50000,
                ...(body.cwd ? { cwd: body.cwd } : { offloadDir })
              });
              if (cRes && cRes.modifiedCount > 0 && cRes.headBytesPreserved) {
                const stagedCompactPath = path.join(stagedDir, `${safeSessionSlug}.transcript.staged.jsonl`);
                atomicWriteFileSync(
                  stagedCompactPath,
                  cRes.prunedSteps.map(s => JSON.stringify(s)).join('\n') + '\n',
                  { encoding: 'utf8' }
                );
                trimRes.stagedCompactPath = stagedCompactPath;
              }
            } catch (err) {
              recordDaemonDiagnostic('POST /api/tail/trim:stageCompact', err);
            }
          }
        }
      } catch (e) {
        recordDaemonDiagnostic('POST /api/tail/trim:readOrStage', e);
        trimRes = { trimmed: false, hostTranscriptMutated: false, error: String(e?.message || e) };
      }
    }
    const nextState = await refreshLiveState(true, targetConvId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...trimRes, state: nextState }));
    return;
  }

  // Route: POST /api/rsi/evolve & POST /api/instincts/promote (Synthesize / Promote Instincts via PrefixCacheShield fence)
  if ((url.pathname === '/api/rsi/evolve' || url.pathname === '/api/instincts/promote') && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, `POST ${url.pathname}`);
    if (body === null) return;
    const sessCtx = resolveRouteCacheContext(body);
    const forceColdBust = Boolean(body.force || body.forceColdBust || body.options?.forceColdBust);
    let evolveRes = null;
    try {
      if (body.ruleText && url.pathname === '/api/instincts/promote') {
        const wsPath = body.workspacePath || cachedLiveState?.workspace?.canonicalPath || process.cwd();
        evolveRes = promoteRuleWithAttentionZone(wsPath, body.ruleText, {
          ...sessCtx,
          ...(body.options || {}),
          zone: body.zone || 'primacy',
          targetFileName: body.targetFileName || 'AGENTS.md',
          prefixCacheShield,
          forceColdBust
        });
      } else {
        const domain = body.domain || 'general';
        evolveRes = rsiEngine?.evolveDomainToSkill
          ? rsiEngine.evolveDomainToSkill(domain, {
              ...sessCtx,
              ...(body.options || {}),
              prefixCacheShield,
              forceColdBust
            })
          : { error: 'RSI engine not initialized' };
      }
    } catch (err) {
      recordDaemonDiagnostic(`POST ${url.pathname}`, err);
      evolveRes = { success: false, error: String(err?.message || err) };
    }
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: !evolveRes?.error, ...evolveRes, state: nextState }));
    return;
  }

  // Route: POST /api/rules/u-curve-optimize & POST /api/ushape/reorder (Reorder Rules via PrefixCacheShield fence)
  if ((url.pathname === '/api/rules/u-curve-optimize' || url.pathname === '/api/ushape/reorder') && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, `POST ${url.pathname}`);
    if (body === null) return;
    const wsPath = body.workspacePath || cachedLiveState?.workspace?.canonicalPath || process.cwd();
    const targetRule = body.filePath || path.join(wsPath, 'AGENTS.md');
    const sessCtx = resolveRouteCacheContext(body);
    const forceColdBust = Boolean(body.force || body.forceColdBust || body.options?.forceColdBust);
    let optRes = null;
    try {
      optRes = uShapedOptimizer.optimizeRuleFile(targetRule, {
        ...sessCtx,
        ...(body.options || {}),
        prefixCacheShield,
        forceColdBust
      });
    } catch (err) {
      recordDaemonDiagnostic(`POST ${url.pathname}`, err);
      optRes = { success: false, error: String(err?.message || err) };
    }
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: !optRes?.error, ...optRes, state: nextState }));
    return;
  }

  // Route: POST /api/rsi/queue-action (Approve or dismiss staged learning in ReflectorQueue)
  if (url.pathname === '/api/rsi/queue-action' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/rsi/queue-action');
    if (body === null) return;
    const itemId = body.id || body.itemId || null;
    const action = String(body.action || 'approve').toLowerCase();
    let actionRes = null;
    if (action === 'approve') {
      actionRes = reflectorQueue.approve(itemId);
    } else {
      actionRes = reflectorQueue.dismiss(itemId);
    }
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: Boolean(actionRes), ...actionRes, state: nextState }));
    return;
  }

  // Route: POST /api/checkpoint/evaporation-check
  if (url.pathname === '/api/checkpoint/evaporation-check' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/checkpoint/evaporation-check');
    if (body === null) return;
    const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || 'default';
    const evapRes = progressiveCheckpointer.detectConstraintEvaporation(
      body.summaryText || '',
      targetConvId
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...evapRes }));
    return;
  }

  // Route: POST /api/router/mode (Set Coach / Auto-Pilot mode)
  if (url.pathname === '/api/router/mode' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/router/mode');
    if (body === null) return;
    const mode = body.mode || 'coach';
    const modeRes = modelSelectorActuator.setMode(mode);
    cacheTtlWatchdog.setFlightMode(
      modeRes.mode === 'autopilot' ? 'AUTO_PILOT' : (modeRes.mode === 'off' ? 'OFF' : 'COACH')
    );
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...modeRes, state: nextState }));
    return;
  }

  // Route: POST /api/router/actuate (Actuate model/effort change)
  if (url.pathname === '/api/router/actuate' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/router/actuate');
    if (body === null) return;
    const actuateRes = await modelSelectorActuator.evaluateAndActuate({
      ...body,
      forceActuate: true
    });
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...actuateRes, state: nextState }));
    return;
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    const bodyStr = await readRequestBody(req, res);
    if (bodyStr === null) return;
    const body = parseJsonBodyOrSend400(bodyStr, res, 'POST /api/action');
    if (body === null) return;
    if (body.action === 'select_session') {
      pinnedConversationId = (!body.conversationId || body.conversationId === 'auto') ? null : body.conversationId;
      const nextState = await refreshLiveState(true, pinnedConversationId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, state: nextState }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, action: body.action }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
  } catch (err) {
    sendRouteError500(res, `${req.method || 'HTTP'} ${req.url || '/'}`, err);
  }
});

function broadcastState(state) {
  if (!state || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (err) {
      clients.delete(client);
      recordDaemonDiagnostic('broadcastState:write', err);
    }
  }
}

setInterval(async () => {
  if (clients.size > 0) {
    try {
      const state = await refreshLiveState(true);
      broadcastState(state);
    } catch (err) {
      recordDaemonDiagnostic('sseBroadcastInterval', err);
    }
  }
}, 2000).unref();

export function startServer(port = EXPLICIT_PORT) {
  return new Promise((resolve, reject) => {
    const candidates = port > 0
      ? [port]
      : [...Array.from({ length: DEFAULT_PORT_MAX - DEFAULT_PORT_START + 1 }, (_, i) => DEFAULT_PORT_START + i), 0];

    let idx = 0;
    const tryListen = () => {
      const candidatePort = candidates[idx++];
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && idx < candidates.length) {
          tryListen();
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const boundPort = server.address().port;
        writeRuntimeLockfile(boundPort);
        cacheTtlWatchdog.startPolling(1000);
        server.once('close', () => {
          cacheTtlWatchdog.stopPolling();
        });
        console.log(`[Horizon Daemon] Listening on http://${BIND_HOST}:${boundPort}`);
        resolve({ server, port: boundPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidatePort, BIND_HOST);
    };

    tryListen();
  });
}

function isDaemonMain(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch (err) {
    if (err?.code !== 'ENOENT') recordDaemonDiagnostic('isDaemonMain:realpath', err);
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

const isMain = isDaemonMain();
if (isMain) {
  ensureSupportedNodeVersion();
  startServer();
}
