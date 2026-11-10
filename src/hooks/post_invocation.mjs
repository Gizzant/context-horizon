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
import { resolveModelCeiling } from '../core/constants.mjs';

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
      try { process.stdin.pause(); } catch {}
      resolve(val);
    };

    const tryParse = () => {
      try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
    };

    const maxTimer = setTimeout(() => finish(tryParse()), maxTimeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      raw += chunk;
      if (settleTimer) clearTimeout(settleTimer);
      if (raw.trim().endsWith('}')) {
        settleTimer = setTimeout(() => {
          try { finish(JSON.parse(raw)); } catch {}
        }, settleMs);
      }
    });
    process.stdin.on('end', () => finish(tryParse()));
    process.stdin.on('error', () => finish({}));
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
    const estFromLength = Number(step.untruncatedLength) > 0 ? Math.round(step.untruncatedLength / 4) : 0;
    let tok = step.inputTokens > 0 && step.outputTokens > 0
      ? Math.max(step.outputTokens, estFromLength)
      : (step.outputTokens || estFromLength || 1000);
    if (step.stepIndex === 0 && step.inputTokens > 0) {
      tok = step.inputTokens;
    }
    totalTokens += tok;

    const isError = step.status === 'ERROR' || (typeof step.exitCode === 'number' && step.exitCode !== 0);
    if (isError || smartReReads.wasteTargetByStep.has(idx)) {
      wasteTokens += tok;
    }

    for (const call of (step.toolCalls || [])) {
      const rawArgs = call?.args || call?.arguments || call?.parameters || call?.Arguments || {};
      const a = typeof rawArgs === 'string' ? (() => { try { return JSON.parse(rawArgs); } catch { return {}; } })() : rawArgs;
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

export async function handlePostInvocation(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);

  sidecar.sessionMeta.turnCount = (sidecar.sessionMeta.turnCount || 0) + 1;

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
  const promptTokens = inputData.promptTokens || inputData.tokens || 100;
  if (isMaxEffort && promptTokens < 15) {
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
  } catch {
    // Fail-open: never break hook execution if transcript file is temporarily unavailable
  }

  writeSidecarAtomicSync(conversationId, sidecar);
  return {};
}

// Auto-run if executed directly
const isMain = process.argv[1] && (process.argv[1].endsWith('post_invocation.mjs') || process.argv[1].endsWith('post_invocation.js'));
if (isMain) {
  readStdinSafe().then(input => {
    return handlePostInvocation(input);
  }).then(output => {
    console.log(JSON.stringify(output || {}));
    process.exit(0);
  }).catch(() => {
    console.log('{}');
    process.exit(0);
  });
}
