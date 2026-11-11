import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSidecarSync, writeSidecarAtomicSync, getSidecarPath } from '../core/sidecar_store.mjs';
import { canonicalizePath } from '../core/path_canonicalizer.mjs';
import { scorePromptSufficiency, toWorkspaceRelativePath } from '../core/prompt_rubric.mjs';
import { loadFlightcheckConfig } from '../core/config.mjs';
import {
  resolveModelCeiling,
  normalizeModelKey,
  isModelDeprecated,
  getDeprecatedModelMigrationNotice,
  evaluateCarbonVerbosityGuardrail
} from '../core/constants.mjs';
import {
  SwarmIdleTtlTracker,
  evaluateSwarmColdCacheWakeup,
  computeSwarmRosterTtlBadges
} from '../core/subagents.mjs';
import {
  classifyTaskComplexity,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
} from '../core/task_quota_router.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../core/horizon_config.mjs';
import {
  evaluateDet08DestructiveShell,
  evaluateDet09MidSessionRuleMutate,
  evaluateDet18UntrustedWorkspaceSettings,
  evaluateDet19GitHookBypass,
  evaluateDet20ScopeCollision
} from '../core/detectors_det01_to_16.mjs';
import { loadRegistry } from '../core/telemetry/scope_lock_registry.mjs';
import { recordHookDiagnostic } from '../core/hook_diagnostics.mjs';

export {
  classifyTaskComplexity,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator,
  evaluateTaskAndQuotaRoute
};

async function readStdinSafe({ maxTimeoutMs = 1000, settleMs = 50 } = {}) {
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
        recordHookDiagnostic('pre_invocation', 'stdin.pause', err, { persist: false });
      }
      resolve(val);
    };

    const tryParse = () => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch (err) {
        recordHookDiagnostic('pre_invocation', 'stdin.parse', err);
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
            recordHookDiagnostic('pre_invocation', 'stdin.settleParse', err, { persist: false });
          }
        }, settleMs);
      }
    });
    process.stdin.on('end', () => finish(tryParse()));
    process.stdin.on('error', (err) => {
      recordHookDiagnostic('pre_invocation', 'stdin.error', err);
      finish({});
    });
  });
}

function formatScorecard(p1, p2, p3, p4) {
  const pad = (s, len = 74) => s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
  return [
    '╭─ Flight Check v3.1 ──────────────────────────────────────────────────────────╮',
    `│ 1. PROMPT : ${pad(p1, 62)} │`,
    `│ 2. HORIZON: ${pad(p2, 62)} │`,
    `│ 3. ACTION : ${pad(p3, 62)} │`,
    `│ 4. REWRITE: ${pad(p4, 62)} │`,
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    'Bypass once: prefix with `!`  •  Lock model/effort: include `!lock`'
  ].join('\n');
}

export async function handlePreToolUse(inputData = {}) {
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  sidecar.sessionMeta = sidecar.sessionMeta || {};
  sidecar.swarmRoster = sidecar.swarmRoster || {};

  // Phase 3.2: Buffer mid-turn model switches without mutating active_model_id
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

  const toolName = String(inputData.tool_name || inputData.tool || inputData.toolName || '').trim();
  const toolInput = inputData.tool_input || inputData.args || inputData.parameters || inputData.Arguments || inputData;
  const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  const flightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
  const isSilentMode = flightMode === 'SILENT';
  const isOffMode = flightMode === 'OFF';
  const isAutoPilotMode = flightMode === 'AUTO_PILOT';

  const syntheticStep = [{
    toolCalls: [{
      name: toolName,
      args: toolInput && typeof toolInput === 'object' ? toolInput : {}
    }]
  }];

  const makeBlockPayload = (detResult) => ({
    decision: 'block',
    permissionDecision: 'deny',
    terminationBehavior: 'terminate',
    blocked: true,
    flightMode,
    detectorId: detResult.id,
    reason: detResult.message,
    userMessage: detResult.message,
    systemMessage: detResult.message
  });

  // Ring-0 Security Gates (active even in SILENT / OFF unless explicitly disabled in Antigravity namespace)
  if (/^(run_command|execute_bash|bash|powershell|exec)$/i.test(toolName)) {
    if (resolveDetectorOverride(horizonConfig, 'DET-19') !== 'off') {
      const det19 = evaluateDet19GitHookBypass(syntheticStep);
      if (det19) return makeBlockPayload(det19);
    }
    if (resolveDetectorOverride(horizonConfig, 'DET-08') !== 'off') {
      const det08 = evaluateDet08DestructiveShell(syntheticStep);
      if (det08) return makeBlockPayload(det08);
    }
  }
  if (/^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|run_command|execute_bash|bash|powershell)$/i.test(toolName)) {
    if (resolveDetectorOverride(horizonConfig, 'DET-18') !== 'off') {
      const det18 = evaluateDet18UntrustedWorkspaceSettings(syntheticStep, {
        workspacePath,
        scanWorkspace: false
      });
      if (det18) return makeBlockPayload(det18);
    }
  }

  // Non-Ring-0 Guardrails (DET-09 warm-cache rule fence, DET-20 concurrent scope lock collision)
  let gateSystemMessage = null;
  if (!isOffMode && /^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(toolName)) {
    const det09Mode = resolveDetectorOverride(horizonConfig, 'DET-09');
    if (det09Mode !== 'off') {
      const det09 = evaluateDet09MidSessionRuleMutate(syntheticStep, {
        cachedTokens: inputData.cachedTokens ?? sidecar.telemetry?.cachedTokens ?? sidecar.telemetry?.totalInputTokens ?? 0,
        cacheTtlSeconds: inputData.cacheTtlSeconds ?? sidecar.telemetry?.cacheTtlSeconds ?? 300,
        cacheState: inputData.cacheState
      });
      if (det09) {
        if (isAutoPilotMode || det09Mode === 'block') return makeBlockPayload(det09);
        if (!isSilentMode) gateSystemMessage = det09.message;
      }
    }

    const det20Mode = resolveDetectorOverride(horizonConfig, 'DET-20');
    if (det20Mode !== 'off') {
      const rawTarget = String(
        toolInput?.Path || toolInput?.path || toolInput?.TargetFile || toolInput?.AbsolutePath || ''
      ).trim();
      if (rawTarget) {
        const relTarget = path.isAbsolute(rawTarget)
          ? path.relative(workspacePath, rawTarget).replace(/\\/g, '/')
          : rawTarget.replace(/\\/g, '/');
        const activeLeases = Array.isArray(inputData.activeLeases)
          ? inputData.activeLeases
          : loadRegistry(workspacePath).leases;
        const det20 = evaluateDet20ScopeCollision([], {
          currentTrajectoryId: conversationId,
          claimedPaths: [relTarget],
          activeLeases,
          workspaceDir: workspacePath
        });
        if (det20) {
          if (isAutoPilotMode || det20Mode === 'block') return makeBlockPayload(det20);
          if (!isSilentMode && !gateSystemMessage) gateSystemMessage = det20.message;
        }
      }
    }
  }

  const nowMs = inputData.nowMs ?? inputData.eventTimestampUtc ?? Date.now();
  const eventTimestampUtc = inputData.eventTimestampUtc ?? nowMs;
  const serviceTier = inputData.serviceTier || 'standard';
  const tracker = new SwarmIdleTtlTracker({
    initialRoster: inputData.swarmRoster || sidecar.swarmRoster,
    cacheTtlMs: inputData.cacheTtlMs ?? 300000,
    coldWakeThresholdTokens: inputData.coldWakeThresholdTokens ?? 100000
  });

  let coldCacheWakeup = null;
  let systemMessage = gateSystemMessage;

  if (toolName === 'send_message' || toolInput?.Recipient || toolInput?.recipient || /@[a-z0-9_-]+/i.test(String(toolInput?.Message || toolInput?.message || toolInput?.brief || ''))) {
    coldCacheWakeup = tracker.handlePreToolSendMessage(toolInput, {
      nowMs,
      eventTimestampUtc,
      serviceTier
    });
    if (coldCacheWakeup.coldWakeDetected) {
      if (isAutoPilotMode && !inputData.allowColdWake && Number(coldCacheWakeup.incrementalColdPenaltyUsd || 0) >= 0.5) {
        return {
          decision: 'block',
          permissionDecision: 'deny',
          terminationBehavior: 'terminate',
          blocked: true,
          flightMode,
          autoPilotGate: 'COLD_CACHE_CLIFF_HOLD',
          coldCacheWakeup,
          reason: coldCacheWakeup.message,
          userMessage: coldCacheWakeup.message,
          systemMessage: coldCacheWakeup.message
        };
      }
      if (!isSilentMode && !isOffMode) {
        systemMessage = coldCacheWakeup.message;
      }
    }
  } else if (toolName === 'invoke_subagent' || toolName === 'define_subagent') {
    const subagentId = toolInput?.ConversationId || toolInput?.conversationId || toolInput?.Name || toolInput?.TypeName || toolInput?.Role || 'subagent';
    const subagentModel = toolInput?.Model && toolInput.Model !== 'inherit'
      ? toolInput.Model
      : (sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || 'gemini-4-carbon');
    tracker.touchAgentActive(subagentId, {
      modelId: subagentModel,
      warmPrefixTokens: Number(toolInput?.warm_prefix_tokens ?? 0),
      timestampMs: nowMs
    });
  } else if (toolName === 'manage_subagents') {
    const action = String(toolInput?.Action || toolInput?.action || '').toLowerCase();
    if (action === 'kill' && Array.isArray(toolInput?.ConversationIds)) {
      for (const id of toolInput.ConversationIds) {
        tracker.terminateAgent(id, { timestampMs: nowMs });
      }
    } else if (action === 'kill_all') {
      for (const id of Object.keys(tracker.getRosterSnapshot())) {
        tracker.terminateAgent(id, { timestampMs: nowMs });
      }
    }
  }

  sidecar.swarmRoster = tracker.getRosterSnapshot();
  sidecar.swarmTtlBadges = computeSwarmRosterTtlBadges(sidecar.swarmRoster, {
    nowMs,
    cacheTtlMs: inputData.cacheTtlMs ?? 300000
  });

  try {
    writeSidecarAtomicSync(conversationId, sidecar);
  } catch (err) {
    recordHookDiagnostic('pre_invocation', 'handlePreToolUse.writeSidecar', err);
  }

  const response = {
    flightMode,
    active_model_id: sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || null,
    pending_model_id: sidecar.sessionMeta.pending_model_id || null,
    swarmTtlBadges: sidecar.swarmTtlBadges
  };
  if (coldCacheWakeup) response.coldCacheWakeup = coldCacheWakeup;
  if (systemMessage && !isSilentMode && !isOffMode) response.systemMessage = systemMessage;
  return response;
}

export async function handlePreInvocation(inputData = {}) {
  if (
    inputData.hook_event_name === 'PreToolUse' ||
    inputData.event === 'PreToolUse' ||
    inputData.tool_name ||
    inputData.tool === 'run_command' ||
    inputData.tool === 'edit_file' ||
    inputData.tool === 'write_file' ||
    inputData.tool === 'read_file' ||
    inputData.tool === 'view_file' ||
    inputData.tool === 'send_message' ||
    inputData.tool === 'invoke_subagent' ||
    inputData.tool === 'define_subagent' ||
    inputData.tool === 'manage_subagents'
  ) {
    return handlePreToolUse(inputData);
  }

  const config = inputData.configOverride || loadFlightcheckConfig();
  const rawPrompt = String(inputData.prompt || inputData.user_input || inputData.message || '').trim();
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  const flightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();

  // 1. Control Flags & flightMode Handling (ISS-039)
  if (config.hook_level === 'off' || flightMode === 'OFF') {
    return {};
  }
  if (flightMode === 'SILENT') {
    // SILENT suppresses all non-Ring-0 advisory context/stderr chatter on PreInvocation
    // (Ring-0 security blocks remain active in PreToolUse and workspace settings checks).
    if (resolveDetectorOverride(horizonConfig, 'DET-18') !== 'off' && inputData.scanWorkspaceSettings === true) {
      const det18 = evaluateDet18UntrustedWorkspaceSettings([], { workspacePath, scanWorkspace: true });
      if (det18) {
        return { terminationBehavior: 'terminate', decision: 'block', detectorId: 'DET-18', userMessage: det18.message };
      }
    }
    return {};
  }

  const sessionMeta = sidecar.sessionMeta || {};
  const telemetry = sidecar.telemetry || {};
  const sensors = sidecar.sensors || {};
  const fileState = sidecar.fileState || {};

  if (rawPrompt.includes('!lock')) {
    sessionMeta.effortLocked = true;
    sidecar.sessionMeta = sessionMeta;
    try {
      writeSidecarAtomicSync(conversationId, sidecar);
    } catch (err) {
      recordHookDiagnostic('pre_invocation', 'effortLock.writeSidecar', err);
    }
    return {};
  }

  if (rawPrompt.startsWith('! ') || rawPrompt === '!' || rawPrompt.startsWith('!force')) {
    return {};
  }

  const hasCheckTag = /#check\b/i.test(rawPrompt);
  const turnCount = sessionMeta.turnCount || 0;
  const purity = telemetry.signalPurityPct ?? 100.0;
  const tokens = telemetry.totalInputTokens || 0;
  const activeEffort = inputData.effort || sessionMeta.activeEffort || 'high';
  const activeModel = inputData.modelName || sessionMeta.activeModel || (config.recommended_models?.fast || 'gemini-3.8-flash');
  const quotaFrac = telemetry.quota?.remaining_fraction ?? 1.0;
  const ceiling = resolveModelCeiling(activeModel, null, { config }) || 256000;
  const ceilingK = Math.round(ceiling / 1000);

  // In AUTO_PILOT mode, enforce active guard halts even if legacy hook_level was 'advisory'
  const hookLevel = flightMode === 'AUTO_PILOT' ? 'guard' : (config.hook_level || 'guard');
  const cooldownTurns = config.halt_cooldown_turns ?? 3;
  const lastHalts = { ...(sessionMeta.lastHalts || {}) };
  const isTelemetryReliable = telemetry.confidence !== 'LOW';

  function haltOrAdvise(stateKey, card, { exemptFromCooldown = false } = {}) {
    const lastFiredTurn = lastHalts[stateKey];
    const isWithinCooldown = typeof lastFiredTurn === 'number' && ((turnCount - lastFiredTurn) <= cooldownTurns);

    if (hookLevel === 'advisory' || (isWithinCooldown && !exemptFromCooldown)) {
      return { systemMessage: card };
    }

    lastHalts[stateKey] = turnCount;
    sessionMeta.lastHalts = lastHalts;
    sidecar.sessionMeta = sessionMeta;
    try {
      writeSidecarAtomicSync(conversationId, sidecar);
    } catch (err) {
      recordHookDiagnostic('pre_invocation', 'haltOrAdvise.writeSidecar', err);
    }
    return { terminationBehavior: 'terminate', userMessage: card };
  }

  // 2. ALLOW_PLAN_OR_SUBAGENT
  if (!hasCheckTag && (sessionMeta.inPlanMode || sessionMeta.lastTurnUsedSubagent)) {
    if (!telemetry.amputationRisk && !sensors.threeStrikeLoop) {
      return {};
    }
  }

  // 3. HALT_HYGIENE_OR_SAFETY
  const isHighOrMaxEffort = activeEffort === 'high' || activeEffort === 'max';
  if (telemetry.amputationRisk && isTelemetryReliable) {
    const handoff = sidecar.handoff || {};
    const handoffAction = handoff.result === 'NEEDS_FIXES'
      ? `Handoff NEEDS FIXES: ${(handoff.failingChecks || []).slice(0, 2).join('; ') || 'update task.md'}`
      : `/clear or /compact`;
    const rewriteCmd = handoff.result === 'NEEDS_FIXES'
      ? `"Update task.md checkpoint (/handoff), then type /compact or /clear"`
      : `"Save progress to task.md and start a clean session with /clear (or /compact)"`;

    const card = formatScorecard(
      `[Amputation Crisis] Tokens: ${Math.round(tokens / 1000)}k/${ceilingK}k (Context Truncation Risk)`,
      `[Useful Context: ${purity}% | Oldest Rules at Risk]`,
      handoffAction,
      rewriteCmd
    );
    return haltOrAdvise('AMPUTATION_CRISIS', card, { exemptFromCooldown: true });
  }

  if (sensors.threeStrikeLoop) {
    const loopInfo = sensors.loopFingerprint
      ? `Loop: ${sensors.loopFingerprint.slice(0, 48)}`
      : 'Consecutive command failures detected';
    const card = formatScorecard(
      `[3-Strike Error Loop] ${loopInfo}`,
      `[Useful Context: ${purity}% | Errors: 3 strikes]`,
      `Break loop: isolate with subagent or compact`,
      `"Diagnose previous errors using invoke_subagent or run /compact"`
    );
    return haltOrAdvise('THREE_STRIKE_LOOP', card);
  }

  if (fileState.foreignBleedKiIds && fileState.foreignBleedKiIds.length > 0 && sessionMeta.inPlanMode) {
    const card = formatScorecard(
      `[Foreign KI Bleed] Injected memory from other workspace`,
      `[Bleed IDs: ${fileState.foreignBleedKiIds.join(', ')}]`,
      `/context`,
      `"Eject foreign knowledge items in /context before planning"`
    );
    return haltOrAdvise('FOREIGN_BLEED', card);
  }

  if (isTelemetryReliable && purity < (config.compact_halt_purity_pct || 45.0) && isHighOrMaxEffort) {
    const card = formatScorecard(
      `[Low Useful Context] ${purity}% useful context on ${activeEffort} effort`,
      `[Wasted Context: +$${(telemetry.sludgeTaxUsdPerTurn || 0).toFixed(2)}/turn]`,
      `/compact`,
      `"Run /compact to compress stale reads before high-effort execution"`
    );
    return haltOrAdvise('LOW_PURITY', card);
  }

  if (sensors.uncheckpointedGitDrift) {
    const card = formatScorecard(
      `[Uncheckpointed Drift] ${sensors.dirtyGitFileCount || 4}+ dirty files untested`,
      `[Git Drift: >=3 turns without passing test]`,
      `git commit or run test`,
      `"Run unit tests and commit working changes before editing further"`
    );
    return haltOrAdvise('GIT_DRIFT', card);
  }

  // 4. HALT_EFFORT_OR_QUOTA
  const fastModel = config.recommended_models?.fast || 'gemini-3.8-flash';
  const deepModel = config.recommended_models?.deep || 'gemini-3.1-pro';

  if (isTelemetryReliable && sensors.quotaFloorBreached && (activeModel.includes('pro') || activeModel.includes('argon') || activeModel.includes('carbon') || activeEffort === 'max')) {
    const card = formatScorecard(
      `[Quota Floor Breached] 5h Quota: ${Math.round(quotaFrac * 100)}% (<10%)`,
      `[Tokens: ${Math.round(tokens / 1000)}k | Risk: 0% lockout]`,
      `/model ${fastModel}  •  /effort low`,
      `"Switch to ${fastModel} on low effort to preserve remaining quota"`
    );
    return haltOrAdvise('QUOTA_FLOOR', card);
  }

  const promptTokenEst = Math.max(1, Math.ceil(rawPrompt.length / 4));
  const isColdCache = tokens < 10000;
  const isTrivial = promptTokenEst < 15;
  if (isTelemetryReliable && !sessionMeta.effortLocked && isTrivial && (sessionMeta.consecutiveTrivialOnMax >= 2 || (isColdCache && (activeModel.includes('pro') || activeModel.includes('argon') || activeModel.includes('carbon')) && activeEffort === 'max'))) {
    const card = formatScorecard(
      `[Effort Overkill] Trivial edit (${promptTokenEst} tokens) on max effort`,
      `[Cold cache / trivial turn]`,
      `/model ${fastModel}  •  /effort low`,
      `"Run trivial single-file edit on ${fastModel} / low effort"`
    );
    return haltOrAdvise('EFFORT_OVERKILL', card);
  }

  // 5. INJECT_CONTEXT_GUARD
  const guards = [];
  const eventTimestampUtc = inputData.eventTimestampUtc ?? null;
  if (isModelDeprecated(activeModel, eventTimestampUtc)) {
    const notice = getDeprecatedModelMigrationNotice(activeModel, eventTimestampUtc);
    if (notice) guards.push(notice);
  }
  const recentTurns = inputData.recentTurns || sidecar.recentTurns || [];
  if (Array.isArray(recentTurns) && recentTurns.length >= 2) {
    const verbosityGuard = evaluateCarbonVerbosityGuardrail(recentTurns, {
      modelId: activeModel,
      activeEffort,
      eventTimestampUtc
    });
    if (verbosityGuard.triggered && verbosityGuard.prescription) {
      guards.push(verbosityGuard.prescription);
    }
  }
  if (!isTelemetryReliable) {
    guards.push('Telemetry confidence DEGRADED (parser schema drift detected) — running fail-open');
  }
  if (fileState.dirtySnapshotPaths && fileState.dirtySnapshotPaths.length > 0) {
    guards.push(`Dirty Snapshots modified externally: ${fileState.dirtySnapshotPaths.slice(0, 2).join(', ')} — re-read with view_file before editing`);
  }
  if (fileState.unseenCallers && fileState.unseenCallers.length > 0) {
    guards.push(`Unseen Callers importing target: ${fileState.unseenCallers.slice(0, 2).join(', ')} — verify signature compatibility`);
  }
  if (fileState.legacyPoisonPaths && fileState.legacyPoisonPaths.length > 0) {
    guards.push(`Legacy Poison paths in context: ${fileState.legacyPoisonPaths.slice(0, 2).join(', ')} — avoid copying deprecated patterns`);
  }
  if (fileState.streamCutoffRiskFiles && fileState.streamCutoffRiskFiles.length > 0) {
    guards.push(`Stream Cutoff Risk (>600 lines): ${fileState.streamCutoffRiskFiles.slice(0, 2).join(', ')} — use surgical edit chunks under 300 lines`);
  }

  if (guards.length > 0) {
    return {
      systemMessage: `[Flight Check Context Guard] Active hazards: ${guards.join('; ')}`
    };
  }

  // 6. STEER_SUBAGENT
  const isComplexTopic = /(concurrency|deadlock|race condition|architecture refactor|multi-module)/i.test(rawPrompt);
  if (tokens >= (config.subagent_min_cache_tokens || 25000) &&
      purity >= (config.subagent_min_purity_pct || 70.0) &&
      (activeEffort === 'low' || activeEffort === 'medium') &&
      isComplexTopic) {
    return {
      systemMessage: `[Flight Check KV-Cache Guard] Warm context detected (${Math.round(tokens / 1000)}k tokens, ${purity}% Purity). Do not switch session model (preserves warm KV cache). Delegate this analysis via invoke_subagent with pro/max depth.`
    };
  }

  // 7. ALLOW_ACTIVE_SET & Trust Decay
  const hasActiveSetMatch = (fileState.activeSetPaths || []).some(p => {
    const base = path.basename(p);
    return rawPrompt.includes(base) || rawPrompt.includes(p);
  });

  if (!hasCheckTag) {
    if (hasActiveSetMatch) return {};
    if (config.hook_level === 'guard' && turnCount > (config.trust_decay_turn_threshold || 10)) {
      return {};
    }
  }

  // 8. HALT_REWRITE_SCORECARD (Explicit #check or Cold Session Vague Multi-File Prompt)
  const isColdSession = turnCount <= (config.cold_session_max_turns || 3);
  const promptSufficiency = scorePromptSufficiency(rawPrompt, { activeSetPaths: fileState.activeSetPaths });
  const isVagueMultiFile = /(refactor everything|fix all|update the whole project|caching)/i.test(rawPrompt) && !rawPrompt.includes('@');

  // Ground rule: "Short prompts are not bad by default" - concise scoped instructions shouldn't trigger vague halt
  if (hasCheckTag || (isColdSession && isVagueMultiFile && !promptSufficiency.shortPrompt)) {
    const cleanedPrompt = rawPrompt.replace(/#check\b/gi, '').trim();
    const recommendedModel = tokens > 50000 ? deepModel : fastModel;
    const recommendedEffort = isComplexTopic ? 'high' : 'medium';
    const rawTargetHint = (fileState.activeSetPaths && fileState.activeSetPaths[0]) || '';
    const targetHint = (rawTargetHint ? toWorkspaceRelativePath(rawTargetHint, sidecar.workspacePath || process.cwd()) : '') || '<target-file>';
    const missingSnippet = promptSufficiency.missing.length > 0 ? ` | Missing: ${promptSufficiency.missing[0]}` : '';

    const rewriteSuggestion = promptSufficiency.missing.includes('testability & expected outcome')
      ? `"In @${targetHint}, ${cleanedPrompt || 'implement updates'} and run automated tests to verify"`
      : `"In @${targetHint}, ${cleanedPrompt || 'implement surgical updates with unit test'}"`;

    const card = formatScorecard(
      `[Sufficiency ${promptSufficiency.score}/12 ${promptSufficiency.band}]${missingSnippet}`,
      `[Purity: ${purity}% | Sludge: +$${(telemetry.sludgeTaxUsdPerTurn || 0).toFixed(2)}/t | Tokens: ${Math.round(tokens / 1000)}k]`,
      `/model ${recommendedModel}  •  /effort ${recommendedEffort}`,
      rewriteSuggestion
    );
    return haltOrAdvise('REWRITE_SCORECARD', card);
  }

  return {};
}

// Auto-run when executed directly by Antigravity Hook Harness
const isMain = process.argv[1] && (process.argv[1].endsWith('pre_invocation.mjs') || process.argv[1].endsWith('pre_invocation.js'));
if (isMain) {
  readStdinSafe().then(input => {
    return handlePreInvocation(input);
  }).then(output => {
    console.log(JSON.stringify(output || {}));
    process.exit(0);
  }).catch((err) => {
    recordHookDiagnostic('pre_invocation', 'main', err);
    console.log(JSON.stringify({}));
    process.exit(0);
  });
}
