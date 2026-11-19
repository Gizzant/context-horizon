import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  readSidecarSync,
  writeSidecarAtomicSync,
  readToolUsageSync,
  writeToolUsageAtomicSync
} from '../core/sidecar_store.mjs';
import { getHomeDir, getBrainStores } from '../core/paths.mjs';
import { parseTranscriptIncremental } from '../core/parser.mjs';
import { isCompactionCheckpointStep, evaluateSmartFileReReads } from '../core/layer5_hygiene.mjs';
import { canonicalizePath } from '../core/path_canonicalizer.mjs';
import { resolveModelCeiling, normalizeModelKey } from '../core/constants.mjs';
import { SwarmIdleTtlTracker, computeSwarmRosterTtlBadges } from '../core/subagents.mjs';
import { loadHorizonConfig } from '../core/horizon_config.mjs';
import { recordHookDiagnostic } from '../core/hook_diagnostics.mjs';
import { evaluateBetweenTurnEffortAdvisor } from '../core/coach/effort_advisor.mjs';
import { runBucketBPostToolPass, runBucketBStopPass } from '../core/bucket_b_runtime.mjs';
import { isMutatingOrExecRslTool } from '../core/rsl_triage.mjs';
import { atomicWriteFileSync } from '../core/atomic_io.mjs';

const requireFromHere = createRequire(import.meta.url);
let _agRslMod = null;
function getAgRslMod() {
  if (!_agRslMod) _agRslMod = requireFromHere('./antigravity_rsl_hook.mjs');
  return _agRslMod;
}

let _fts5Mod = null;
function getFts5Mod() {
  if (!_fts5Mod) _fts5Mod = requireFromHere('../core/fts5_output_compressor.mjs');
  return _fts5Mod;
}

let _postSanitizerMod = null;
function getPostSanitizerMod() {
  if (!_postSanitizerMod) _postSanitizerMod = requireFromHere('../core-isomorphic/guards/losslessPostSanitizer.mjs');
  return _postSanitizerMod;
}

let _smartCompactMod = null;
function getSmartCompactMod() {
  if (!_smartCompactMod) _smartCompactMod = requireFromHere('../core-isomorphic/coach/smartCompactAdvisor.mjs');
  return _smartCompactMod;
}

let _batonMod = null;
function getBatonMod() {
  if (!_batonMod) _batonMod = requireFromHere('../core-isomorphic/coach/stateBatonHydrator.mjs');
  return _batonMod;
}

let _prefixShieldMod = null;
function getPrefixShieldMod() {
  if (!_prefixShieldMod) _prefixShieldMod = requireFromHere('../core/prefix_cache_shield.mjs');
  return _prefixShieldMod;
}

let _subagentSanitizerMod = null;
function getSubagentSanitizerMod() {
  if (!_subagentSanitizerMod) _subagentSanitizerMod = requireFromHere('../core/coach/subagent_ipi_sanitizer.mjs');
  return _subagentSanitizerMod;
}

function extractAntigravityRawOutput(inputData = {}) {
  const raw =
    inputData.tool_output ??
    inputData.toolOutput ??
    inputData.output ??
    inputData.tool_response;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.content)) {
      const blocks = raw.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
        .map((b) => b.text)
        .join('\n');
      if (blocks.length > 0) return blocks;
    }
    const parts = [raw.output, raw.content, raw.result, raw.stdout, raw.stderr]
      .filter((v) => typeof v === 'string' && v.length > 0);
    if (parts.length > 0) return parts.join('\n');
    return '';
  }
  return raw !== undefined && raw !== null ? String(raw) : '';
}

/**
 * OPT-1C: Updates Antigravity task-boundary state across PostToolUse / PostInvocation,
 * evaluates ROI-gated /compact suggestion, and pre-stages durable baton outside workspace.
 */
function evaluateAntigravityTaskBoundaryCompact({
  sidecar,
  conversationId,
  toolName = '',
  cmdStr = '',
  filePath = '',
  failed = false,
  exitCode = 0,
  inputData = {},
  flightMode = 'COACH',
  horizonConfig = {}
}) {
  try {
    const smartMod = getSmartCompactMod();
    const boundaryEval = smartMod.evaluateTaskBoundaryTurn(
      { toolName, command: cmdStr, filePath, failed, exitCode },
      sidecar.taskBoundaryState || {}
    );
    sidecar.taskBoundaryState = {
      openFailure: boundaryEval.openFailure,
      editsSinceBoundary: boundaryEval.editsSinceBoundary,
      turnBoundaryReached:
        boundaryEval.detectorState === 'mid_debug'
          ? false
          : boundaryEval.boundaryDetected
            ? true
            : Boolean(sidecar.taskBoundaryState?.turnBoundaryReached && boundaryEval.editsSinceBoundary === 0),
      lastBoundarySuggestedTurn: sidecar.taskBoundaryState?.lastBoundarySuggestedTurn ?? null
    };

    const boundaryReached = Boolean(
      inputData.boundaryDetected ?? inputData.boundary_detected ?? sidecar.taskBoundaryState.turnBoundaryReached
    );
    if (!boundaryReached || flightMode === 'OFF' || flightMode === 'SILENT') {
      return null;
    }

    const contextTokens = Number(
      inputData.contextTokens ??
        inputData.context_tokens ??
        inputData.cachedTokens ??
        sidecar.telemetry?.cachedTokens ??
        sidecar.telemetry?.totalInputTokens ??
        0
    );
    const modelId = String(
      inputData.modelName ||
        inputData.model ||
        sidecar.sessionMeta?.active_model_id ||
        sidecar.sessionMeta?.activeModel ||
        'claude-sonnet-5-5'
    );
    const turnsSince =
      inputData.turnsSinceLastCompact ??
      inputData.turns_since_last_compact ??
      sidecar.sessionMeta?.turnsSinceLastCompact ??
      null;

    const suggestion = smartMod.evaluateSmartCompactSuggestion(
      {
        enabled:
          inputData.smartCompactBoundarySuggest ??
          horizonConfig?.thresholds?.smartCompactBoundarySuggest ??
          true,
        detectorState: 'task_boundary',
        boundaryDetected: true,
        openFailure: false,
        editsSinceBoundary: 0,
        turnsSinceLastCompact: turnsSince,
        modelId,
        preCompactTokens: contextTokens,
        expectedRemainingRequests: inputData.expectedRemainingRequests,
        expectedRemainingTurns:
          inputData.expectedRemainingTurns ?? horizonConfig?.expectedRemainingTurns,
        turnsCompleted: Number(sidecar.sessionMeta?.turnCount || 0)
      },
      { horizonConfig }
    );

    if (!suggestion.shouldSuggest) {
      return suggestion;
    }

    const baton = getBatonMod().buildDurableStateBaton({
      sessionId: conversationId,
      modifiedFiles: sidecar.fileState?.activeSetPaths || [],
      activeTask: sidecar.sessionMeta?.lastUserPrompt || '',
      nowMs: inputData.nowMs ?? Date.now()
    });
    const safeSid = String(conversationId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
    const homeDir = inputData.homeDir || getHomeDir();
    const batonDir =
      inputData.batonDir || path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'batons');
    fs.mkdirSync(batonDir, { recursive: true });
    const batonPath = path.join(batonDir, `baton_${safeSid}.json`);
    atomicWriteFileSync(batonPath, `${JSON.stringify(baton, null, 2)}\n`);

    sidecar.sessionMeta = sidecar.sessionMeta || {};
    sidecar.sessionMeta.turnsSinceLastCompact = 1;
    sidecar.taskBoundaryState.turnBoundaryReached = false;

    return {
      ...suggestion,
      batonStaged: true,
      batonPath
    };
  } catch (tbErr) {
    recordHookDiagnostic('post_invocation', 'taskBoundaryCompact', tbErr, { persist: false });
    return null;
  }
}

function recordAntigravityPostSavings(sidecar, { category = 'CLI_FTS5_COMPRESSED', savedTokens = 0, detail = '', nowMs = Date.now() } = {}) {
  const tokens = Math.max(0, Number(savedTokens || 0));
  if (!sidecar || typeof sidecar !== 'object' || tokens <= 0) return;
  sidecar.telemetry = sidecar.telemetry && typeof sidecar.telemetry === 'object' ? sidecar.telemetry : {};
  sidecar.telemetry.savedTokens = Number(sidecar.telemetry.savedTokens || 0) + tokens;
  sidecar.telemetry.savedTokensByCategory =
    sidecar.telemetry.savedTokensByCategory && typeof sidecar.telemetry.savedTokensByCategory === 'object'
      ? sidecar.telemetry.savedTokensByCategory
      : {};
  sidecar.telemetry.savedTokensByCategory[category] =
    Number(sidecar.telemetry.savedTokensByCategory[category] || 0) + tokens;
  const recent = Array.isArray(sidecar.telemetry.recentInterventions)
    ? sidecar.telemetry.recentInterventions
    : [];
  recent.push({ ts: new Date(nowMs).toISOString(), category, savedTokens: tokens, detail });
  sidecar.telemetry.recentInterventions = recent.slice(-25);
}

/**
 * OPT-2B: Unified FTS5 CLI compressor + lossless post-tool sanitizer for Antigravity hooks.
 * Never writes `.claude/` directories inside workspacePath; stores FTS5 DB & artifacts under
 * `~/.gemini/antigravity/agy-horizon` (or test-provided `homeDir`/`toolLogsDbPath`/`artifactRootDir`).
 */
function compressAntigravityPostOutput({
  conversationId,
  toolName,
  cmdStr = '',
  baseText = '',
  exitCode = 0,
  inputData = {}
}) {
  if (!baseText || !toolName || inputData.enablePostOutputCompression === false) {
    return null;
  }
  try {
    const { stripAnsiAndSpinners, isToolEligibleForSanitization, sanitizePostToolOutput } = getPostSanitizerMod();
    const isShellTool = /^(?:run_command|execute_bash|Bash|PowerShell|pwsh|cmd|sh)$/i.test(toolName);
    if (isShellTool && cmdStr && inputData.enableFts5CliCompression !== false) {
      const cleanShell = stripAnsiAndSpinners(baseText);
      const homeDir = inputData.homeDir || getHomeDir();
      const ftsDbPath = inputData.toolLogsDbPath || getFts5Mod().getDefaultToolLogsDbPath(homeDir);
      const ftsRes = getFts5Mod().compressCliOutputFts5Sync({
        sessionId: String(conversationId),
        turnId: String(inputData.tool_use_id || inputData.turnId || inputData.turn_id || `turn-${Date.now()}`),
        command: cmdStr,
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
        rawOutput: cleanShell,
        dbPath: ftsDbPath,
        recordLedger: false
      });
      if (ftsRes.compressed && ftsRes.tokensSaved > 0) {
        const ansiSavedTok = Math.max(0, Math.ceil((baseText.length - cleanShell.length) / 4));
        const totalSaved = ftsRes.tokensSaved + ansiSavedTok;
        return {
          compressed: true,
          output: ftsRes.output,
          savedTokens: totalSaved,
          guardrailId: 'CLI_FTS5_COMPRESSED',
          reason: `Highbeam compressed CLI output via FTS5 (+${totalSaved} tokens saved)`
        };
      }
    }

    if (/^(?:default_api:)?invoke_subagent$/i.test(toolName) && inputData.enableSubagentHandoffCondenser !== false) {
      const subMod = getSubagentSanitizerMod();
      const ipiClean = subMod.sanitizeSubagentPayload(baseText, 'invoke_subagent', {
        truncate: false,
        horizonConfig: inputData.horizonConfig || null
      });
      const capTokens = Number(inputData.subagentHandoffCapTokens || subMod.DEFAULT_SUBAGENT_HANDOFF_CAP_TOKENS || 1200);
      if (ipiClean.cleanedText.length > Math.max(200, capTokens) * 4) {
        const homeDir = inputData.homeDir || getHomeDir();
        const ftsDbPath = inputData.toolLogsDbPath || getFts5Mod().getDefaultToolLogsDbPath(homeDir);
        const subTurnId = String(
          inputData.tool_use_id || inputData.turnId || inputData.turn_id || `subagent-${Date.now()}`
        );
        try {
          getFts5Mod().compressCliOutputFts5Sync({
            sessionId: String(conversationId),
            turnId: subTurnId,
            command: 'subagent:invoke_subagent',
            exitCode: typeof exitCode === 'number' ? exitCode : 0,
            rawOutput: baseText,
            forceCompress: true,
            dbPath: ftsDbPath,
            recordLedger: false
          });
        } catch (agSubFtsErr) {
          recordHookDiagnostic('post_invocation', 'subagentFtsArchive', agSubFtsErr, { persist: false });
        }
        const condRes = subMod.condenseSubagentHandoffOutput(ipiClean.cleanedText, {
          maxTokens: capTokens,
          archivePointer: subTurnId
        });
        if (condRes.condensed) {
          const framed = subMod.sanitizeSubagentPayload(condRes.text, 'invoke_subagent', {
            truncate: false,
            horizonConfig: inputData.horizonConfig || null
          }).framedPayload;
          const savedTokens = Math.max(0, Math.ceil((baseText.length - framed.length) / 4));
          if (savedTokens > 0) {
            return {
              compressed: true,
              output: framed,
              savedTokens,
              guardrailId: 'SUBAGENT_HANDOFF_CONDENSED',
              reason: `Highbeam condensed invoke_subagent handoff (+${savedTokens} tokens saved)`
            };
          }
        }
      } else if (ipiClean.ipiStrippedCount > 0) {
        const savedTokens = Math.max(1, Math.ceil((baseText.length - ipiClean.cleanedText.length) / 4));
        return {
          compressed: true,
          output: ipiClean.framedPayload,
          savedTokens,
          guardrailId: 'SUBAGENT_IPI_SANITIZED',
          reason: `Highbeam stripped ${ipiClean.ipiStrippedCount} subagent IPI vector(s)`
        };
      }
    }

    if (isToolEligibleForSanitization(toolName)) {
      const homeDir = inputData.homeDir || getHomeDir();
      const agyArtifactRoot =
        inputData.artifactRootDir || path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon');
      const san = sanitizePostToolOutput(
        {
          toolName,
          toolOutput: baseText,
          offloadThresholdTokens: Number(inputData.offloadThresholdTokens || 4000)
        },
        { cwd: agyArtifactRoot }
      );
      if (san.sanitized && san.savedTokens > 0) {
        const guardrailId = san.offloaded ? 'ARTIFACT_OFFLOAD_4K' : 'LOSSLESS_POST_SANITIZER';
        return {
          compressed: true,
          output: san.updatedToolOutput,
          savedTokens: san.savedTokens,
          guardrailId,
          reason: `Highbeam sanitized ${toolName} output (+${san.savedTokens} tokens saved)`
        };
      }
    }
  } catch (agCompErr) {
    recordHookDiagnostic('post_invocation', 'fts5PostCompress', agCompErr, { persist: false });
  }
  return null;
}

export async function readStdinSafe({ maxTimeoutMs = 1000, settleMs = 50 } = {}) {
  if (process.stdin.isTTY || process.stdin.readableEnded) return {};
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    let settleTimer = null;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        process.stdin.pause();
      } catch (err) {
        recordHookDiagnostic('post_invocation', 'stdin.pause', err, { persist: false });
      }
      resolve(val);
    };

    const tryParse = () => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch (err) {
        recordHookDiagnostic('post_invocation', 'stdin.parse', err);
        return {};
      }
    };

    const maxTimer = setTimeout(() => finish(tryParse()), maxTimeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      raw += chunk;
      if (settleTimer) clearTimeout(settleTimer);
      if (raw.trim().endsWith('}')) {
        settleTimer = setTimeout(() => {
          try {
            finish(JSON.parse(raw));
          } catch (err) {
            recordHookDiagnostic('post_invocation', 'stdin.settleParse', err, { persist: false });
          }
        }, settleMs);
      }
    });
    process.stdin.on('end', () => finish(tryParse()));
    process.stdin.on('error', (err) => {
      recordHookDiagnostic('post_invocation', 'stdin.error', err);
      finish({});
    });
  });
}

function resolveExactSessionDir(conversationId, inputData = {}) {
  if (inputData.sessionDir && fs.existsSync(inputData.sessionDir)) {
    return inputData.sessionDir;
  }
  if (!conversationId || conversationId === 'default_session') return null;
  const homeDir = inputData.homeDir || getHomeDir();
  for (const store of getBrainStores(homeDir)) {
    const candidate = path.join(store.path, String(conversationId));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function syncTranscriptTelemetryToSidecar(sidecar, sessionDir, inputData = {}) {
  const parsed = parseTranscriptIncremental(sessionDir, inputData.cacheDir || null);
  const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  if (rawSteps.length === 0) return;

  let lastCheckpointIdx = -1;
  for (let i = rawSteps.length - 1; i >= 0; i--) {
    if (rawSteps[i] && isCompactionCheckpointStep(rawSteps[i])) {
      lastCheckpointIdx = i;
      break;
    }
  }
  const activeSteps = lastCheckpointIdx >= 0 ? rawSteps.slice(lastCheckpointIdx) : rawSteps;
  const smartReReads = evaluateSmartFileReReads(activeSteps);

  let totalTokens = 0;
  let wasteTokens = 0;
  const activeSet = new Set(sidecar.fileState?.activeSetPaths || []);
  const staleSet = new Set(sidecar.fileState?.staleDupPaths || []);

  for (let idx = 0; idx < activeSteps.length; idx++) {
    const step = activeSteps[idx] || {};
    const estFromLength = Number(step.untruncatedLength) > 0 ? Math.round(Number(step.untruncatedLength) / 4) : 0;
    const stepPromptEnvelope = Number(step.totalPromptTokens || 0) ||
      (Number(step.inputTokens || 0) + Number(step.cacheReadTokens || 0) + Number(step.cacheCreationTokens || 0));
    let tok = stepPromptEnvelope > 0 && Number(step.outputTokens || 0) > 0
      ? Math.max(Number(step.outputTokens || 0), estFromLength)
      : (Number(step.outputTokens || 0) || estFromLength || 0);
    if (step.stepIndex === 0 && stepPromptEnvelope > 0) {
      tok = stepPromptEnvelope;
    }
    totalTokens += tok;

    const isError = step.status === 'ERROR' || (typeof step.exitCode === 'number' && step.exitCode !== 0);
    if (isError || smartReReads.wasteTargetByStep.has(idx)) {
      wasteTokens += tok;
    }

    for (const call of (step.toolCalls || [])) {
      const rawArgs = call?.args || call?.arguments || call?.parameters || call?.Arguments || {};
      const a = typeof rawArgs === 'string'
        ? (() => {
            try {
              return JSON.parse(rawArgs);
            } catch (err) {
              recordHookDiagnostic('post_invocation', 'toolCallArgs.parse', err, { persist: false });
              return {};
            }
          })()
        : rawArgs;
      const fp = a.Path || a.path || a.TargetFile || a.AbsolutePath;
      if (fp && typeof fp === 'string') {
        const canon = canonicalizePath(fp);
        if (smartReReads.wasteTargetByStep.has(idx)) {
          staleSet.add(canon);
        } else {
          activeSet.add(canon);
        }
      }
    }
  }

  const stdinTotal = Number(inputData.context_window?.total_input_tokens || 0);
  const effectiveTotal = Math.max(stdinTotal, totalTokens);
  const activeModel = inputData.modelName || inputData.model?.id || sidecar.sessionMeta?.activeModel || 'gemini-3.8-flash';
  const maxCeiling = resolveModelCeiling(activeModel, inputData.context_window);
  const usedPct = maxCeiling > 0 ? Number(((effectiveTotal / maxCeiling) * 100).toFixed(1)) : 0;
  const purityPct = effectiveTotal > 0
    ? Number(Math.min(100, Math.max(0, (((effectiveTotal - wasteTokens) / effectiveTotal) * 100))).toFixed(1))
    : 100.0;

  sidecar.telemetry = sidecar.telemetry || {};
  sidecar.telemetry.totalInputTokens = effectiveTotal;
  sidecar.telemetry.usedPercentage = Number(inputData.context_window?.used_percentage || usedPct);
  sidecar.telemetry.exceeds200kTokens = effectiveTotal > 200000;
  sidecar.telemetry.signalPurityPct = purityPct;
  sidecar.telemetry.amputationRisk = effectiveTotal >= 179000;

  sidecar.fileState = sidecar.fileState || {};
  sidecar.fileState.activeSetPaths = Array.from(activeSet).slice(-32);
  sidecar.fileState.staleDupPaths = Array.from(staleSet).slice(-32);

  if (parsed.filePath) {
    sidecar.cursor = {
      filePath: parsed.filePath,
      byteOffset: Number(parsed.lastByteOffset || 0),
      tier: Number(parsed.tier || 1)
    };
  }
}

export async function handlePostToolUse(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  sidecar.sessionMeta = sidecar.sessionMeta || {};
  sidecar.swarmRoster = sidecar.swarmRoster || {};

  // Phase 3.2: Mid-turn model switch buffer — record pending_model_id without mutating active_model_id
  const requestedMidTurnModel = inputData.requestedModel || inputData.newModel || inputData.pending_model_id || null;
  if (requestedMidTurnModel) {
    const normalizedNext = normalizeModelKey(requestedMidTurnModel);
    if (!sidecar.sessionMeta.active_model_id) {
      sidecar.sessionMeta.active_model_id = normalizeModelKey(
        inputData.active_model_id || inputData.modelName || sidecar.sessionMeta.activeModel || 'gemini-3.8-flash'
      );
    }
    if (normalizedNext !== sidecar.sessionMeta.active_model_id) {
      sidecar.sessionMeta.pending_model_id = normalizedNext;
    }
  }

  const nowMs = inputData.nowMs ?? inputData.eventTimestampUtc ?? Date.now();
  const tracker = new SwarmIdleTtlTracker({
    initialRoster: inputData.swarmRoster || sidecar.swarmRoster,
    cacheTtlMs: inputData.cacheTtlMs ?? 300000
  });

  if (inputData.agent_id || inputData.agentId) {
    const aid = String(inputData.agent_id || inputData.agentId).trim();
    tracker.touchAgentActive(aid, {
      modelId: inputData.modelId || inputData.modelName || sidecar.sessionMeta.active_model_id || 'gemini-4-carbon',
      warmPrefixTokens: Number(inputData.warm_prefix_tokens ?? inputData.warmPrefixTokens ?? 0),
      timestampMs: nowMs
    });
  }

  sidecar.swarmRoster = tracker.getRosterSnapshot();
  sidecar.swarmTtlBadges = computeSwarmRosterTtlBadges(sidecar.swarmRoster, {
    nowMs,
    cacheTtlMs: inputData.cacheTtlMs ?? 300000
  });

  const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  const flightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();

  const toolName = String(inputData.toolCall?.name || inputData.tool_name || inputData.toolName || '');
  const toolInput = inputData.toolCall?.args || inputData.tool_input || inputData.toolInput || inputData.args || {};
  const cmdStr = String(toolInput.CommandLine || toolInput.command || toolInput.cmd || inputData.command || '');

  if (
    inputData.enableRsl !== false &&
    (inputData.workspacePaths?.[0] || inputData.cwd || inputData.workspacePath) &&
    isMutatingOrExecRslTool(toolName)
  ) {
    try {
      getAgRslMod().handleAntigravityRslHook(inputData, { event: 'PostToolUse' });
    } catch {
      // Fail open for RSL step telemetry
    }
  }
  const rawOutput = extractAntigravityRawOutput(inputData);
  const didFail =
    inputData.is_error === true ||
    inputData.isError === true ||
    inputData.succeeded === false ||
    inputData.status === 'ERROR' ||
    (typeof inputData.exitCode === 'number' && inputData.exitCode !== 0) ||
    (typeof inputData.exit_code === 'number' && inputData.exit_code !== 0);

  if (/^(?:run_command|execute_bash|Bash|PowerShell)$/i.test(toolName)) {
    const isVerificationCmd =
      /\b(?:node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|tsc(?:\s|$)|npx\s+tsc)\b/i.test(
        cmdStr
      );
    if (!didFail && isVerificationCmd) {
      if (sidecar.fileState) {
        sidecar.fileState.unverifiedEdits = [];
      }
      if (sidecar.sessionMeta) {
        sidecar.sessionMeta.lastFailingLocation = null;
      }
    } else if (didFail && rawOutput) {
      const locMatch = rawOutput.match(
        /([A-Za-z0-9_./\\-]+\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kt|swift|c|cpp|h|hpp)):(\d+)(?::\d+)?/
      );
      if (locMatch) {
        sidecar.sessionMeta.lastFailingLocation = `${locMatch[1].replace(/\\/g, '/')}:${locMatch[2]}`;
      }
    }
  }

  let postPass = null;
  if (flightMode !== 'OFF' && inputData.bucketBShadow !== false && toolName && rawOutput) {
    try {
      postPass = runBucketBPostToolPass({
        platform: 'antigravity',
        sessionId: conversationId,
        cwd: workspacePath,
        hasExplicitCwd: Boolean(inputData.cwd || inputData.workspacePath),
        toolName,
        toolInput: toolInput && typeof toolInput === 'object' ? toolInput : {},
        rawOutput,
        lastUserPrompt: String(inputData.lastUserPrompt || ''),
        activeFiles: sidecar.fileState?.activeSetPaths || [],
        webFetchesInTurn: Number(inputData.webFetchesInTurn || 1),
        options: {
          bucketBStage: inputData.bucketBStage,
          bucketBAlphaStage: inputData.bucketBAlphaStage,
          mode: flightMode,
          horizonConfig
        }
      });
    } catch (_postErr) {
      void _postErr;
      postPass = null;
    }
  }

  let compPass = null;
  if (flightMode !== 'OFF' && toolName && rawOutput) {
    const baseText = postPass?.triggered ? postPass.updatedOutput : rawOutput;
    const rawExitCode =
      inputData.exitCode ??
      inputData.exit_code ??
      inputData.tool_response?.exitCode ??
      inputData.tool_response?.exit_code;
    compPass = compressAntigravityPostOutput({
      conversationId,
      toolName,
      cmdStr,
      baseText,
      exitCode: typeof rawExitCode === 'number' ? rawExitCode : (didFail ? 1 : 0),
      inputData
    });
    if (compPass?.compressed) {
      recordAntigravityPostSavings(sidecar, {
        category: compPass.guardrailId,
        savedTokens: compPass.savedTokens,
        detail: compPass.reason,
        nowMs
      });
    }
  }

  const rawExitCodeForBoundary =
    inputData.exitCode ??
    inputData.exit_code ??
    inputData.tool_response?.exitCode ??
    inputData.tool_response?.exit_code;
  const targetFilePath = String(
    toolInput.Path || toolInput.path || toolInput.file_path || toolInput.TargetFile || ''
  );
  const smartCompactSuggestion =
    flightMode !== 'OFF' && (toolName || inputData.boundaryDetected !== undefined)
      ? evaluateAntigravityTaskBoundaryCompact({
          sidecar,
          conversationId,
          toolName,
          cmdStr,
          filePath: targetFilePath,
          failed: didFail,
          exitCode: typeof rawExitCodeForBoundary === 'number' ? rawExitCodeForBoundary : (didFail ? 1 : 0),
          inputData,
          flightMode,
          horizonConfig
        })
      : null;

  writeSidecarAtomicSync(conversationId, sidecar);
  if (flightMode === 'OFF') {
    return { flightMode };
  }
  const postToolOut = {
    flightMode,
    active_model_id: sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || null,
    pending_model_id: sidecar.sessionMeta.pending_model_id || null,
    swarmTtlBadges: sidecar.swarmTtlBadges
  };
  if (smartCompactSuggestion) {
    postToolOut.smartCompactSuggestion = smartCompactSuggestion;
  }
  if (postPass?.triggered || compPass?.compressed) {
    postToolOut.updatedOutput = compPass?.compressed ? compPass.output : postPass.updatedOutput;
    postToolOut.savedTokens =
      Number(postPass?.triggered ? postPass.savedTokens || 0 : 0) +
      Number(compPass?.compressed ? compPass.savedTokens || 0 : 0);
    postToolOut.guardrailId = compPass?.compressed ? compPass.guardrailId : postPass.guardrailId;
    if (flightMode !== 'SILENT') {
      postToolOut.systemMessage = compPass?.compressed ? compPass.reason : postPass.reason;
    }
  }
  if (smartCompactSuggestion?.shouldSuggest && flightMode !== 'SILENT') {
    postToolOut.systemMessage = postToolOut.systemMessage
      ? `${postToolOut.systemMessage} | ${smartCompactSuggestion.message}`
      : smartCompactSuggestion.message;
  }
  return postToolOut;
}

export async function handlePostInvocation(inputData = {}) {
  if (
    inputData.hookEventName === 'PostToolUse' ||
    inputData.hook_event_name === 'PostToolUse' ||
    inputData.event === 'PostToolUse' ||
    Boolean(inputData.toolCall)
  ) {
    return handlePostToolUse(inputData);
  }

  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);

  sidecar.sessionMeta = sidecar.sessionMeta || {};
  sidecar.sessionMeta.turnCount = (sidecar.sessionMeta.turnCount || 0) + 1;

  // Phase 3.2: Promote pending_model_id -> active_model_id strictly on turn completion (PostInvocation or Stop)
  const pendingModel = inputData.pending_model_id || sidecar.sessionMeta.pending_model_id || null;
  if (pendingModel) {
    const promoted = normalizeModelKey(pendingModel);
    sidecar.sessionMeta.active_model_id = promoted;
    sidecar.sessionMeta.activeModel = promoted;
    sidecar.sessionMeta.pending_model_id = null;
  } else if (inputData.modelName || inputData.active_model_id) {
    const current = normalizeModelKey(inputData.active_model_id || inputData.modelName);
    sidecar.sessionMeta.active_model_id = current;
    sidecar.sessionMeta.activeModel = current;
  }

  // Track subagent use
  const toolsInvoked = Array.isArray(inputData.toolsInvoked)
    ? inputData.toolsInvoked
    : (inputData.tool_calls || []).map(c => c.name || c.tool);

  const usedSubagent = toolsInvoked.some(t => t === 'invoke_subagent');
  sidecar.sessionMeta.lastTurnUsedSubagent = usedSubagent;

  // Update tool usage ledger for MCP tools
  const toolLedger = readToolUsageSync();
  toolLedger.servers = toolLedger.servers || {};
  let ledgerChanged = false;

  for (const t of toolsInvoked) {
    if (typeof t === 'string' && t.startsWith('mcp_')) {
      const parts = t.split('_');
      const server = parts[1];
      if (server) {
        if (!toolLedger.servers[server]) {
          toolLedger.servers[server] = { invocationsLast15Sessions: 1, lastUsedMs: Date.now() };
        } else {
          toolLedger.servers[server].invocationsLast15Sessions = (toolLedger.servers[server].invocationsLast15Sessions || 0) + 1;
          toolLedger.servers[server].lastUsedMs = Date.now();
        }
        ledgerChanged = true;
      }
    }
  }
  if (ledgerChanged) {
    writeToolUsageAtomicSync(toolLedger);
  }

  // Track consecutive trivial on max
  const effort = inputData.effort || sidecar.sessionMeta.activeEffort || 'high';
  const isMaxEffort = effort === 'max';
  const rawPromptTokens = inputData.promptTokens ?? inputData.tokens ?? null;
  const promptTokens = rawPromptTokens !== null && rawPromptTokens !== undefined
    ? Number(rawPromptTokens)
    : null;
  if (isMaxEffort && promptTokens !== null && Number.isFinite(promptTokens) && promptTokens > 0 && promptTokens < 15) {
    sidecar.sessionMeta.consecutiveTrivialOnMax = (sidecar.sessionMeta.consecutiveTrivialOnMax || 0) + 1;
  } else {
    sidecar.sessionMeta.consecutiveTrivialOnMax = 0;
  }

  // Track error streak
  const hasError = inputData.exitCode !== undefined && inputData.exitCode !== null && inputData.exitCode !== 0;
  if (hasError || inputData.status === 'ERROR') {
    sidecar.sessionMeta.consecutiveErrorStreak = (sidecar.sessionMeta.consecutiveErrorStreak || 0) + 1;
  } else {
    sidecar.sessionMeta.consecutiveErrorStreak = 0;
  }

  // Track test runs (including TypeScript typecheck `tsc`)
  const isTestRun = toolsInvoked.includes('run_command') && /\b(?:test|pytest|jest|vitest|cargo\s+test|go\s+test|tsc)\b/i.test(inputData.command || '');
  if (isTestRun && inputData.exitCode === 0) {
    sidecar.sessionMeta.turnsSinceLastPassingTest = 0;
    if (sidecar.fileState) {
      sidecar.fileState.unverifiedEdits = [];
    }
  } else {
    sidecar.sessionMeta.turnsSinceLastPassingTest = (sidecar.sessionMeta.turnsSinceLastPassingTest || 0) + 1;
  }

  if (Array.isArray(inputData.activeBackgroundTasks)) {
    sidecar.sessionMeta.activeBackgroundTasks = inputData.activeBackgroundTasks
      .filter(Boolean)
      .map((t) => (typeof t === 'string' ? t : String(t?.id || t?.command || 'bg_task')));
  }

  // Incremental transcript sync so sidecar.telemetry.totalInputTokens updates in standalone CLI/hook mode
  try {
    const resolvedSessionDir = resolveExactSessionDir(conversationId, inputData);
    if (resolvedSessionDir) {
      syncTranscriptTelemetryToSidecar(sidecar, resolvedSessionDir, inputData);
    } else if (Number(inputData.context_window?.total_input_tokens || 0) > 0) {
      sidecar.telemetry = sidecar.telemetry || {};
      sidecar.telemetry.totalInputTokens = Number(inputData.context_window.total_input_tokens);
    }
  } catch (err) {
    // Fail-open: never break hook execution if transcript file is temporarily unavailable
    recordHookDiagnostic('post_invocation', 'syncTranscriptTelemetryToSidecar', err, { ignoreCodes: ['ENOENT'] });
  }

  // Phase 4.2: Transition completing /swarm agent to idle_zero_token and compute TTL cliff badges
  const nowMs = inputData.nowMs ?? inputData.eventTimestampUtc ?? Date.now();
  const tracker = new SwarmIdleTtlTracker({
    initialRoster: inputData.swarmRoster || sidecar.swarmRoster || {},
    cacheTtlMs: inputData.cacheTtlMs ?? 300000
  });
  const agentId = inputData.agent_id || inputData.agentId || null;
  if (agentId) {
    tracker.onTurnComplete(agentId, {
      modelId: sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || inputData.modelName || 'gemini-4-carbon',
      warmPrefixTokens: Number(
        inputData.warm_prefix_tokens ??
        inputData.warmPrefixTokens ??
        sidecar.telemetry?.totalInputTokens ??
        0
      ),
      timestampMs: nowMs,
      parentSwarmLive: inputData.parentSwarmLive !== false
    });
  }
  sidecar.swarmRoster = tracker.getRosterSnapshot();
  sidecar.swarmTtlBadges = computeSwarmRosterTtlBadges(sidecar.swarmRoster, {
    nowMs,
    cacheTtlMs: inputData.cacheTtlMs ?? 300000
  });

  // Rank 7 (DET-08): Trigger between-turn EffortAdvisor from PostInvocation
  try {
    const cachedTok = Number(
      inputData.cachedTokens ??
      sidecar.telemetry?.cachedTokens ??
      sidecar.telemetry?.cacheReadTokens ??
      sidecar.telemetry?.totalInputTokens ??
      0
    );
    const recentFailures = Number(
      inputData.recentTestFailures ??
      (typeof inputData.exitCode === 'number' && inputData.exitCode !== 0 ? 1 : 0)
    );
    const det05Osc = Boolean(
      inputData.det05Oscillation ||
      (sidecar.portfolio?.hudAlerts || []).some((a) => a.detectorId === 'DET-05' && /FLIP_FLOP/.test(String(a.message || '')))
    );
    sidecar.effortAdvisor = evaluateBetweenTurnEffortAdvisor(
      {
        sessionId: conversationId,
        turnCount: Number(sidecar.sessionMeta?.turnCount || 0),
        cachedTokens: cachedTok,
        activeModel: sidecar.sessionMeta?.active_model_id || sidecar.sessionMeta?.activeModel || inputData.modelName || 'gemini-4-carbon',
        activeEffort: inputData.effort || sidecar.sessionMeta?.activeEffort || 'high',
        isSimpleTask: inputData.isSimpleTask !== false,
        recentTestFailures: recentFailures,
        det05Oscillation: det05Osc,
        timestampUtc: inputData.eventTimestampUtc || new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString()
      },
      inputData.effortAdvisorDbPath ? { dbPath: inputData.effortAdvisorDbPath } : (inputData.homeDir ? { homeDir: inputData.homeDir } : {})
    );
  } catch (err) {
    recordHookDiagnostic('post_invocation', 'effortAdvisor', err, { persist: false });
  }

  const bgTasks = Array.isArray(sidecar.sessionMeta?.activeBackgroundTasks)
    ? sidecar.sessionMeta.activeBackgroundTasks
    : [];
  const orphanBackgroundWarning =
    bgTasks.length > 0 && (inputData.sessionEnding === true || inputData.stop === true)
      ? `[Highbeam Quota Shield — Orphan Background Drain (#10)] ${bgTasks.length} background daemon/task(s) still active (${bgTasks.slice(0, 3).join(', ')}). Kill via manage_task before ending session.`
      : null;

  const postWorkspace = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const postHorizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: postWorkspace,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  let invPostFlightMode = String(inputData.flightMode || postHorizonConfig.flightMode || 'COACH').toUpperCase();

  let postCompactFlushRes = null;
  if (inputData.postCompact === true || inputData.isPostCompact === true) {
    sidecar.taskBoundaryState = {
      openFailure: false,
      editsSinceBoundary: 0,
      turnBoundaryReached: false,
      lastBoundarySuggestedTurn: null
    };
    sidecar.sessionMeta.turnsSinceLastCompact = 0;
    if (inputData.flushPrefixDeltas !== false) {
      try {
        const shield = new (getPrefixShieldMod().PrefixCacheShield)({
          homeDir: inputData.homeDir || getHomeDir()
        });
        postCompactFlushRes = shield.flushOnPostCompact();
        if (postCompactFlushRes?.flushedCount > 0) {
          sidecar.prefixShield = { stagedCount: 0, badge: '', queuePath: shield.queuePath };
        }
      } catch (flushErr) {
        recordHookDiagnostic('post_invocation', 'prefixShieldFlush', flushErr, { persist: false });
      }
    }
  } else if (typeof sidecar.sessionMeta.turnsSinceLastCompact === 'number') {
    sidecar.sessionMeta.turnsSinceLastCompact += 1;
  }

  const postToolName = String(inputData.tool_name || inputData.toolName || '');
  const postRawOutput = inputData.tool_output ?? inputData.toolOutput ?? inputData.output;
  let invPostPass = null;
  let invCompPass = null;
  if (postToolName && postRawOutput) {
    if (invPostFlightMode !== 'OFF' && inputData.bucketBShadow !== false) {
      try {
        invPostPass = runBucketBPostToolPass({
          platform: 'antigravity',
          sessionId: conversationId,
          cwd: postWorkspace,
          hasExplicitCwd: Boolean(inputData.cwd || inputData.workspacePath),
          toolName: postToolName,
          toolInput: inputData.tool_input || inputData.toolInput || {},
          rawOutput: String(postRawOutput),
          lastUserPrompt: String(inputData.lastUserPrompt || ''),
          activeFiles: sidecar.fileState?.activeSetPaths || [],
          webFetchesInTurn: Number(inputData.webFetchesInTurn || 1),
          options: {
            bucketBStage: inputData.bucketBStage,
            bucketBAlphaStage: inputData.bucketBAlphaStage,
            mode: invPostFlightMode,
            horizonConfig: postHorizonConfig
          }
        });
      } catch (_invPostErr) {
        void _invPostErr;
        invPostPass = null;
      }
    }
    if (invPostFlightMode !== 'OFF') {
      const postToolIn = inputData.tool_input || inputData.toolInput || {};
      const postCmd = String(postToolIn.CommandLine || postToolIn.command || postToolIn.cmd || inputData.command || '');
      const baseText = invPostPass?.triggered ? invPostPass.updatedOutput : String(postRawOutput);
      const rawInvExit = inputData.exitCode ?? inputData.exit_code;
      invCompPass = compressAntigravityPostOutput({
        conversationId,
        toolName: postToolName,
        cmdStr: postCmd,
        baseText,
        exitCode: typeof rawInvExit === 'number' ? rawInvExit : (hasError ? 1 : 0),
        inputData
      });
      if (invCompPass?.compressed) {
        recordAntigravityPostSavings(sidecar, {
          category: invCompPass.guardrailId,
          savedTokens: invCompPass.savedTokens,
          detail: invCompPass.reason,
          nowMs
        });
      }
    }
  }

  let invSmartCompactSuggestion = null;
  if (invPostFlightMode !== 'OFF' && (postToolName || inputData.boundaryDetected !== undefined)) {
    const postToolIn = inputData.tool_input || inputData.toolInput || {};
    const postCmd = String(postToolIn.CommandLine || postToolIn.command || postToolIn.cmd || inputData.command || '');
    const postFile = String(postToolIn.Path || postToolIn.path || postToolIn.file_path || '');
    const rawInvExit = inputData.exitCode ?? inputData.exit_code;
    invSmartCompactSuggestion = evaluateAntigravityTaskBoundaryCompact({
      sidecar,
      conversationId,
      toolName: postToolName,
      cmdStr: postCmd,
      filePath: postFile,
      failed: hasError,
      exitCode: typeof rawInvExit === 'number' ? rawInvExit : (hasError ? 1 : 0),
      inputData,
      flightMode: invPostFlightMode,
      horizonConfig: postHorizonConfig
    });
  }

  const turnFileDiffs = Array.isArray(inputData.fileDiffs)
    ? inputData.fileDiffs
    : Array.isArray(sidecar.fileState?.turnFileDiffs)
      ? sidecar.fileState.turnFileDiffs
      : [];
  let turnStopPass = null;
  let turnFlightMode = invPostFlightMode;
  if (turnFileDiffs.length > 0 && inputData.bucketBShadow !== false) {
    try {
      const turnWorkspace = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
      const turnHorizonConfig = inputData.horizonConfig || loadHorizonConfig({
        cwd: turnWorkspace,
        ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
      });
      turnFlightMode = String(inputData.flightMode || turnHorizonConfig.flightMode || 'COACH').toUpperCase();
      if (turnFlightMode !== 'OFF') {
        turnStopPass = runBucketBStopPass({
          platform: 'antigravity',
          sessionId: conversationId,
          cwd: turnWorkspace,
          hasExplicitCwd: Boolean(inputData.cwd || inputData.workspacePath),
          fileDiffs: turnFileDiffs,
          lastUserPrompt: String(inputData.lastUserPrompt ?? inputData.prompt ?? sidecar.sessionMeta?.lastUserPrompt ?? ''),
          options: {
            bucketBStage: inputData.bucketBStage,
            bucketBBetaStage: inputData.bucketBBetaStage,
            mode: turnFlightMode,
            horizonConfig: turnHorizonConfig
          }
        });
      }
    } catch (_turnStopErr) {
      turnStopPass = null;
    }
  }
  if (sidecar.fileState) {
    sidecar.fileState.turnFileDiffs = [];
  }

  writeSidecarAtomicSync(conversationId, sidecar);
  const out = {
    active_model_id: sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || null,
    pending_model_id: sidecar.sessionMeta.pending_model_id || null,
    swarmRoster: sidecar.swarmRoster,
    swarmTtlBadges: sidecar.swarmTtlBadges,
    effortAdvisor: sidecar.effortAdvisor || null,
    ...(invSmartCompactSuggestion ? { smartCompactSuggestion: invSmartCompactSuggestion } : {}),
    ...(postCompactFlushRes ? { flushedPrefixDeltas: postCompactFlushRes } : {})
  };
  if (invPostPass?.triggered || invCompPass?.compressed) {
    out.updatedOutput = invCompPass?.compressed ? invCompPass.output : invPostPass.updatedOutput;
    out.savedTokens =
      Number(invPostPass?.triggered ? invPostPass.savedTokens || 0 : 0) +
      Number(invCompPass?.compressed ? invCompPass.savedTokens || 0 : 0);
    out.guardrailId = invCompPass?.compressed ? invCompPass.guardrailId : invPostPass.guardrailId;
  }
  if (turnStopPass?.triggered) {
    out.overengineeringHint = turnStopPass.reason;
    out.savedTokens = (out.savedTokens || 0) + (turnStopPass.savedTokens || 0);
    out.guardrailId = out.guardrailId || turnStopPass.guardrailId;
  }
  if (orphanBackgroundWarning) {
    out.orphanBackgroundWarning = orphanBackgroundWarning;
    out.systemMessage = orphanBackgroundWarning;
  } else if (invCompPass?.compressed && invPostFlightMode !== 'SILENT' && !out.systemMessage) {
    out.systemMessage = invCompPass.reason;
  } else if (invPostPass?.triggered && invPostFlightMode !== 'SILENT' && !out.systemMessage) {
    out.systemMessage = invPostPass.reason;
  } else if (turnStopPass?.triggered && turnFlightMode !== 'SILENT' && !out.systemMessage) {
    out.systemMessage = turnStopPass.reason;
  } else if (invSmartCompactSuggestion?.shouldSuggest && invPostFlightMode !== 'SILENT' && !out.systemMessage) {
    out.systemMessage = invSmartCompactSuggestion.message;
  } else if (postCompactFlushRes?.flushedCount > 0 && invPostFlightMode !== 'SILENT' && !out.systemMessage) {
    out.systemMessage = `[Highbeam] Flushed ${postCompactFlushRes.flushedCount} staged prefix rule update(s) post-compaction with zero cache bust.`;
  }
  return out;
}

