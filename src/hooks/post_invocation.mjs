import fs from 'node:fs';
import path from 'node:path';
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

  writeSidecarAtomicSync(conversationId, sidecar);
  if (flightMode === 'OFF') {
    return { flightMode };
  }
  return {
    flightMode,
    active_model_id: sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || null,
    pending_model_id: sidecar.sessionMeta.pending_model_id || null,
    swarmTtlBadges: sidecar.swarmTtlBadges
  };
}

export async function handlePostInvocation(inputData = {}) {
  if (inputData.hook_event_name === 'PostToolUse' || inputData.event === 'PostToolUse') {
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

  // Track test runs
  const isTestRun = toolsInvoked.includes('run_command') && /(test|pytest|jest|vitest|cargo test)/i.test(inputData.command || '');
  if (isTestRun && inputData.exitCode === 0) {
    sidecar.sessionMeta.turnsSinceLastPassingTest = 0;
  } else {
    sidecar.sessionMeta.turnsSinceLastPassingTest = (sidecar.sessionMeta.turnsSinceLastPassingTest || 0) + 1;
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

  writeSidecarAtomicSync(conversationId, sidecar);
  return {
    active_model_id: sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || null,
    pending_model_id: sidecar.sessionMeta.pending_model_id || null,
    swarmRoster: sidecar.swarmRoster,
    swarmTtlBadges: sidecar.swarmTtlBadges
  };
}

// Auto-run if executed directly
const isMain = process.argv[1] && (process.argv[1].endsWith('post_invocation.mjs') || process.argv[1].endsWith('post_invocation.js'));
if (isMain) {
  readStdinSafe().then(input => {
    return handlePostInvocation(input);
  }).then(output => {
    console.log(JSON.stringify(output || {}));
    process.exit(0);
  }).catch((err) => {
    recordHookDiagnostic('post_invocation', 'main', err);
    console.log('{}');
    process.exit(0);
  });
}
