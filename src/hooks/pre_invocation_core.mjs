import fs from 'node:fs';
import { normalizeAntigravityToolPayload } from './antigravity_payload.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readSidecarSync, writeSidecarAtomicSync, getSidecarPath } from '../core/sidecar_store.mjs';
import { canonicalizePath } from '../core/path_canonicalizer.mjs';
import { scorePromptSufficiency, toWorkspaceRelativePath } from '../core/prompt_rubric.mjs';
import { loadFlightcheckConfig } from '../core/config.mjs';
import {
  resolveModelCeiling,
  resolveModelRates,
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
import { loadRegistry } from '../core/telemetry/scope_lock_registry.mjs';
import { recordHookDiagnostic } from '../core/hook_diagnostics.mjs';
import {
  evaluateScopeBrake,
  evaluateRelayBreaker,
  evaluateTwoStageSightseeingIntercept,
  evaluateShardedSpecDrift,
  evaluateTurn1ContractGate
} from '../core/shared/prompt_hygiene_governor.mjs';
import {
  runBucketBPreToolShadowPass,
  runBucketBPromptPass
} from '../core/bucket_b_runtime.mjs';
import { evaluateParameterizedCliffBreaker } from '../core-isomorphic/economics/cliffBreaker.mjs';
import { evaluateActiveDet30StepDown } from '../core-isomorphic/economics/driftLatency.mjs';
import { evaluateDet05DiffThrashing } from '../core-isomorphic/guards/det04_12_thrash_rot.mjs';
import { hasExplicitTestModifyIntent } from '../core-isomorphic/guards/det01_03_shell_secret.mjs';
import { evaluateDet04ConsecutiveFailureBreaker } from '../core/shared/detectors.mjs';

const requireFromHere = createRequire(import.meta.url);
const AUTO_MODE_ALIAS_RE = /^(?:AUTO_PILOT|AUTOPILOT|AUTO|AUTO-PILOT)$/i;

let _proMod = null;
function getProMod() {
  if (!_proMod) _proMod = requireFromHere('../core/pro_license.mjs');
  return _proMod;
}

let _shadowAutoMod = null;
function getShadowAutoMod() {
  if (!_shadowAutoMod) _shadowAutoMod = requireFromHere('../core/shadow_auto_ledger.mjs');
  return _shadowAutoMod;
}

let _detectorsMod = null;
function getDetectorsMod() {
  if (!_detectorsMod) _detectorsMod = requireFromHere('../core/detectors_det01_to_16.mjs');
  return _detectorsMod;
}

let _codeFoldMod = null;
function getCodeFoldMod() {
  if (!_codeFoldMod) _codeFoldMod = requireFromHere('../core/code_fold_lite.mjs');
  return _codeFoldMod;
}

let _shieldMod = null;
function getShieldMod() {
  if (!_shieldMod) _shieldMod = requireFromHere('../core/shield_manager.mjs');
  return _shieldMod;
}

let _smartCompactMod = null;
function getSmartCompactMod() {
  if (!_smartCompactMod) _smartCompactMod = requireFromHere('../core-isomorphic/coach/smartCompactAdvisor.mjs');
  return _smartCompactMod;
}

let _prefixShieldMod = null;
function getPrefixShieldMod() {
  if (!_prefixShieldMod) _prefixShieldMod = requireFromHere('../core/prefix_cache_shield.mjs');
  return _prefixShieldMod;
}

let _bucketBGammaMod = null;
function getBucketBGammaMod() {
  if (!_bucketBGammaMod) _bucketBGammaMod = requireFromHere('../core-isomorphic/guards/bucketBGamma.mjs');
  return _bucketBGammaMod;
}

function resolveSimpleAgMode(rawMode = 'COACH') {
  const upper = String(rawMode || 'COACH').trim().toUpperCase();
  if (upper === 'OFF' || upper === 'DISABLED') return 'OFF';
  if (upper === 'SILENT') return 'SILENT';
  return 'COACH';
}

const KNOWN_ANTIGRAVITY_TOOL_NAMES = new Set([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'run_command',
  'grep_search',
  'find_by_name',
  'list_dir',
  'search_web',
  'invoke_subagent',
  'define_subagent',
  'send_message',
  'manage_subagents',
  'manage_task',
  'schedule',
  'ask_question',
  'call_mcp_tool',
  'list_resources',
  'read_resource',
  'swarm',
  'run_workflow',
  'search_marketplace',
  'list_plugin_accounts'
]);

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

function recordAntigravitySidecarSavings(sidecar, { category = 'BOUNDED_READ_ENFORCED', savedTokens = 0, detail = '', nowMs = Date.now() } = {}) {
  const tokens = Math.max(0, Number(savedTokens || 0));
  if (!sidecar || typeof sidecar !== 'object' || tokens <= 0) return;
  sidecar.telemetry = sidecar.telemetry && typeof sidecar.telemetry === 'object' ? sidecar.telemetry : {};
  sidecar.telemetry.savedTokens = Number(sidecar.telemetry.savedTokens || 0) + tokens;
  sidecar.telemetry.boundedReadInterventions = Number(sidecar.telemetry.boundedReadInterventions || 0) + 1;
  sidecar.telemetry.savedTokensByCategory =
    sidecar.telemetry.savedTokensByCategory && typeof sidecar.telemetry.savedTokensByCategory === 'object'
      ? sidecar.telemetry.savedTokensByCategory
      : {};
  sidecar.telemetry.savedTokensByCategory[category] =
    Number(sidecar.telemetry.savedTokensByCategory[category] || 0) + tokens;
  const recent = Array.isArray(sidecar.telemetry.recentInterventions)
    ? sidecar.telemetry.recentInterventions
    : [];
  recent.push({
    ts: new Date(nowMs).toISOString(),
    category,
    savedTokens: tokens,
    detail
  });
  sidecar.telemetry.recentInterventions = recent.slice(-25);
}

export async function handlePreToolUse(inputData = {}) {
  inputData = normalizeAntigravityToolPayload(inputData) || {};
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
  const toolInput = inputData.tool_input || inputData.toolInput || inputData.args || inputData.parameters || inputData.Arguments || inputData;
  const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  const rawFlightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
  const resolvedModeInfo = AUTO_MODE_ALIAS_RE.test(rawFlightMode)
    ? getProMod().resolveEffectiveAutoFlightMode(rawFlightMode, {
        licensePath: inputData.licensePath,
        homeDir: inputData.homeDir,
        strict: Boolean(inputData.strictProGate)
      })
    : { effectiveFlightMode: resolveSimpleAgMode(rawFlightMode) };
  const flightMode = resolvedModeInfo.effectiveFlightMode;
  const isSilentMode = flightMode === 'SILENT';
  const isOffMode = flightMode === 'OFF';
  const isAutoPilotMode = flightMode === 'AUTO_PILOT';
  const shadowMissOpts = {
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {}),
    ...(inputData.shadowLedgerPath ? { shadowLedgerPath: inputData.shadowLedgerPath } : {})
  };
  const logAgToolShadowMiss = (detectorId, category, missedUsd, wastedTokens, detail) => {
    if (isAutoPilotMode) return;
    getShadowAutoMod().recordShadowAutoMiss(
      {
        sessionId: conversationId,
        workspacePath,
        harness: 'antigravity',
        effectiveMode: flightMode,
        category,
        detectorId,
        turnKey: inputData.turnKey || inputData.turn || `${detectorId}:${toolName}`,
        wastedTokens,
        missedUsd,
        avoidedPrompts: 1,
        autoSelected: rawFlightMode === 'AUTO_PILOT' || rawFlightMode === 'AUTOPILOT',
        detail
      },
      shadowMissOpts
    );
  };

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
  const effectivePromptText = String(
    inputData.lastUserInput ??
      inputData.prompt ??
      inputData.user_input ??
      sidecar.sessionMeta?.lastUserPrompt ??
      ''
  );
  const userExplicitTestIntent =
    Boolean(inputData.userExplicitTestIntent || inputData.userAuthorizedTestDeletion) ||
    hasExplicitTestModifyIntent(effectivePromptText);
  if (/^(run_command|execute_bash|bash|powershell|exec)$/i.test(toolName)) {
    if (resolveDetectorOverride(horizonConfig, 'DET-19') !== 'off') {
      const det19 = getDetectorsMod().evaluateDet19GitHookBypass(syntheticStep);
      if (det19) return makeBlockPayload(det19);
    }
    if (resolveDetectorOverride(horizonConfig, 'DET-08') !== 'off') {
      const det08 = getDetectorsMod().evaluateDet08DestructiveShell(syntheticStep, { userExplicitTestIntent });
      if (det08) return makeBlockPayload(det08);
    }
  }
  if (/^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|run_command|execute_bash|bash|powershell)$/i.test(toolName)) {
    if (resolveDetectorOverride(horizonConfig, 'DET-18') !== 'off') {
      const det18 = getDetectorsMod().evaluateDet18UntrustedWorkspaceSettings(syntheticStep, {
        workspacePath,
        scanWorkspace: false
      });
      if (det18) return makeBlockPayload(det18);
    }
  }

  // Non-Ring-0 Guardrails (DET-09 warm-cache rule fence, DET-20 concurrent scope lock collision, Two-Stage Prompt Hygiene)
  let gateSystemMessage = null;
  if (!isOffMode) {
    const scopeOverride = resolveDetectorOverride(horizonConfig, 'vague-prompt-rubric');
    const relayOverride = resolveDetectorOverride(horizonConfig, 'relay-breaker');
    const twoStage = evaluateTwoStageSightseeingIntercept({
      toolName,
      toolArgs: toolInput && typeof toolInput === 'object' ? toolInput : {},
      unanchoredTurnFlag: Boolean(inputData.unanchoredTurnFlag ?? sidecar.sessionMeta?.unanchoredTurnFlag),
      candidateFiles: Array.isArray(inputData.candidateFiles)
        ? inputData.candidateFiles
        : (sidecar.fileState?.modifiedFiles || sidecar.fileState?.activeSetPaths || []),
      relayState: inputData.relayState ?? sidecar.sessionMeta?.relayState,
      overrideMode: scopeOverride !== 'default' ? scopeOverride : relayOverride,
      flightMode,
      detectorId: 'DET-26'
    });
    if (twoStage.intercepted) {
      if (twoStage.consumeFlag && sidecar.sessionMeta) {
        sidecar.sessionMeta.unanchoredTurnFlag = false;
        sidecar.sessionMeta.sightseeingToolsPrevented = Number(sidecar.sessionMeta.sightseeingToolsPrevented || 0) + 1;
        try {
          writeSidecarAtomicSync(conversationId, sidecar);
        } catch (err) {
          recordHookDiagnostic('pre_invocation', 'twoStage.writeSidecar', err);
        }
      }
      if (twoStage.decision === 'deny') {
        return makeBlockPayload({ id: twoStage.detectorId, message: twoStage.reason });
      }
      if (!isSilentMode) gateSystemMessage = twoStage.reason;
    }

    // Item A0: Unify shared DET-04 3-Strike Consecutive Tool Failure Breaker in handlePreToolUse
    if (resolveDetectorOverride(horizonConfig, 'DET-04') !== 'off' && sidecar.portfolio?.failureStreaks) {
      const currentTurnNum = Math.max(1, Number(inputData.turn ?? sidecar.sessionMeta?.turnCount ?? 1));
      const det04 = evaluateDet04ConsecutiveFailureBreaker({
        toolName,
        toolArgs: toolInput && typeof toolInput === 'object' ? toolInput : {},
        failureStreaks: sidecar.portfolio.failureStreaks,
        currentTurn: currentTurnNum,
        lastAlertTurnByKey: sidecar.portfolio.lastAlertTurnByKey || {},
        cooldownTurns: 3,
        flightMode
      });
      if (det04.triggered) {
        if (det04.decision === 'deny') {
          return makeBlockPayload({ id: 'DET-04', message: det04.reason });
        }
        logAgToolShadowMiss(
          'DET-04',
          'RUNAWAY_LOOP_TURN',
          0.35,
          Number(sidecar.telemetry?.totalInputTokens || 30000),
          det04.reason
        );
        if (!isSilentMode && !gateSystemMessage && det04.reason) gateSystemMessage = det04.reason;
      }
    }

    // Item A0: Validate define_subagent tools: array against known Antigravity tool names
    if (toolName === 'define_subagent') {
      const rawTools = toolInput?.tools ?? toolInput?.Tools;
      if (Array.isArray(rawTools) && rawTools.length > 0) {
        const invalidTools = rawTools
          .map((t) => String(t || '').trim().replace(/^default_api:/, ''))
          .filter((t) => t && !KNOWN_ANTIGRAVITY_TOOL_NAMES.has(t) && !t.startsWith('mcp_'));
        if (invalidTools.length > 0) {
          const invalidMsg = `[DET-16 Subagent Tool Validation] Unknown tool name(s) in define_subagent (${invalidTools.join(', ')}). Invalid names are silently stripped by the host; use canonical Antigravity tool names or EnableWriteTools/EnableMCPTools.`;
          if (isAutoPilotMode) return makeBlockPayload({ id: 'DET-16', message: invalidMsg });
          if (!isSilentMode && !gateSystemMessage) gateSystemMessage = invalidMsg;
        }
      }
    }

    // Item A0 + #10: Guard Monitor / IsDaemon shell commands lacking bounds & track active background tasks
    if (toolName === 'Monitor') {
      const hasTimeout = Number.isFinite(Number(toolInput?.timeout_ms ?? toolInput?.timeoutMs));
      const hasFilter = Boolean(toolInput?.filter || toolInput?.pattern || toolInput?.regex);
      if (!hasTimeout || !hasFilter) {
        const monMsg = '[Highbeam Quota Shield — Unbounded Monitor (#10)] Monitor called without explicit timeout_ms and filter; stream bursts can flood main-thread context.';
        if (isAutoPilotMode) return makeBlockPayload({ id: 'DET-07', message: monMsg });
        if (!isSilentMode && !gateSystemMessage) gateSystemMessage = monMsg;
      }
    } else if (/^(run_command|execute_bash)$/i.test(toolName) && Boolean(toolInput?.IsDaemon)) {
      sidecar.sessionMeta = sidecar.sessionMeta || {};
      const bgList = Array.isArray(sidecar.sessionMeta.activeBackgroundTasks)
        ? sidecar.sessionMeta.activeBackgroundTasks
        : [];
      const label = String(toolInput?.toolSummary || toolInput?.CommandLine || 'daemon_task').slice(0, 60);
      if (!bgList.includes(label)) bgList.push(label);
      sidecar.sessionMeta.activeBackgroundTasks = bgList.slice(-16);
    } else if (toolName === 'manage_task' && String(toolInput?.Action || '').toLowerCase() === 'kill') {
      if (Array.isArray(sidecar.sessionMeta?.activeBackgroundTasks)) {
        const killedId = String(toolInput?.TaskId || '').trim();
        sidecar.sessionMeta.activeBackgroundTasks = killedId
          ? sidecar.sessionMeta.activeBackgroundTasks.filter((t) => t !== killedId)
          : [];
      }
    }

    // Item A3 (#7): Parameterized Pricing Cliff Breaker (Haiku 100K 5x + Gemini 3.1/2.5 Pro 200K 2x/1.5x)
    const det12Mode = resolveDetectorOverride(horizonConfig, 'DET-12');
    if (det12Mode !== 'off') {
      const cliffEval = evaluateParameterizedCliffBreaker({
        modelId:
          inputData.modelName ||
          sidecar.sessionMeta?.active_model_id ||
          sidecar.sessionMeta?.activeModel ||
          '',
        totalInputTokens: Number(
          inputData.totalPromptTokens ??
            inputData.totalInputTokens ??
            sidecar.telemetry?.totalInputTokens ??
            0
        )
      });
      if (cliffEval.triggered) {
        if (cliffEval.decision === 'deny' && (isAutoPilotMode || det12Mode === 'block')) {
          return makeBlockPayload({ id: 'DET-12', message: cliffEval.reason });
        }
        if (!isSilentMode && !gateSystemMessage) {
          gateSystemMessage = cliffEval.reason;
        }
      }
    }
  }
  let postEditVerifyInfo = null;
  if (!isOffMode && /^(?:default_api:)?(?:read_file|view_file)$/i.test(toolName)) {
    const startRaw = toolInput?.StartLine ?? toolInput?.start_line ?? toolInput?.offset;
    const endRaw = toolInput?.EndLine ?? toolInput?.end_line;
    const limitRaw = toolInput?.limit;
    const hasBounds =
      startRaw !== undefined ||
      endRaw !== undefined ||
      limitRaw !== undefined;
    const rawReadTarget = String(
      toolInput?.Path || toolInput?.AbsolutePath || toolInput?.file_path || toolInput?.path || ''
    ).trim();

    // Item A8 (#14): Multimodal .ipynb Base64 Stripper & Unbounded >10-page .pdf Read Blocker
    if (rawReadTarget && /\.(?:ipynb|pdf)$/i.test(rawReadTarget)) {
      const mmRes = getShieldMod().inspectAndSanitizeMultimodalRead({
        platform: 'antigravity',
        cwd: workspacePath,
        filePath: rawReadTarget,
        pages: toolInput?.pages,
        hasPageBounds: hasBounds || toolInput?.pages !== undefined
      });
      if (mmRes.action === 'deny') {
        return {
          decision: 'deny',
          permissionDecision: 'deny',
          terminationBehavior: 'terminate',
          blocked: true,
          flightMode,
          detectorId: mmRes.detectorId,
          subType: mmRes.subType,
          reason: mmRes.reason,
          userMessage: mmRes.reason,
          systemMessage: mmRes.reason,
          sanitizedPath: mmRes.sanitizedPath || null,
          pageCount: mmRes.pageCount || null,
          savedTokens: mmRes.savedTokens || 0
        };
      }
    }

    // IMP-4B: Immediate post-Edit verify re-read fold (<= 2 ops/turns) before heavy Shield block
    if (rawReadTarget) {
      try {
        const absFoldTarget = path.isAbsolute(rawReadTarget)
          ? rawReadTarget
          : path.resolve(workspacePath, rawReadTarget);
        const normFoldKey = absFoldTarget.replace(/\\/g, '/').toLowerCase();
        if (!sidecar.fileState || typeof sidecar.fileState !== 'object') sidecar.fileState = {};
        sidecar.fileState.opSeq = Number(sidecar.fileState.opSeq || 0) + 1;
        const curOpSeq = sidecar.fileState.opSeq;
        const curTurnNum = Number(sidecar.sessionMeta?.turnCount || 0);
        const readNowMs = inputData.nowMs ?? inputData.eventTimestampUtc ?? Date.now();
        const recentEdit =
          inputData.recentEdit || sidecar.fileState?.recentEdits?.[normFoldKey] || null;
        const isRecentPostEdit = Boolean(
          recentEdit &&
            ((Number.isFinite(Number(recentEdit.opSeq)) &&
              curOpSeq - Number(recentEdit.opSeq) <= 2) ||
              (Number.isFinite(Number(recentEdit.turn)) &&
                Math.abs(curTurnNum - Number(recentEdit.turn)) <= 2) ||
              (Number.isFinite(Number(recentEdit.timestampMs)) &&
                readNowMs - Number(recentEdit.timestampMs) <= 120_000))
        );
        if (
          isRecentPostEdit &&
          fs.existsSync(absFoldTarget) &&
          fs.statSync(absFoldTarget).isFile()
        ) {
          const stFold = fs.statSync(absFoldTarget);
          if (stFold.size > 256 && stFold.size <= 512 * 1024) {
            const rawContent = fs.readFileSync(absFoldTarget, 'utf8');
            const totalLines =
              rawContent.length > 0 ? rawContent.replace(/\r\n/g, '\n').split('\n').length : 0;
            const startN = Number(startRaw);
            const endN = Number(endRaw);
            const limitN = Number(limitRaw);
            const explicitSpan =
              Number.isFinite(endN) && Number.isFinite(startN)
                ? endN - startN + 1
                : Number.isFinite(limitN)
                  ? limitN
                  : totalLines;
            const requestedSpan = hasBounds ? explicitSpan : totalLines;
            if (totalLines > 150 && requestedSpan > 150) {
              const prevSnap =
                typeof inputData.priorContentSnapshot === 'string'
                  ? inputData.priorContentSnapshot
                  : typeof sidecar.fileState?.readSnapshots?.[normFoldKey] === 'string'
                    ? sidecar.fileState.readSnapshots[normFoldKey]
                    : '';
              const win = getCodeFoldMod().computePostEditReadWindow({
                prevContent: prevSnap,
                nextContent: rawContent,
                explicitStartLine: recentEdit.approxLineStart,
                windowLines: 150
              });
              const delta =
                prevSnap && prevSnap !== rawContent
                  ? getCodeFoldMod().computeCompactLineDiff(
                      prevSnap,
                      rawContent,
                      path.basename(absFoldTarget)
                    )
                  : { wasDiffed: false, diffText: '', savedTokens: 0 };
              const clampedLines = Math.max(
                1,
                Math.min(requestedSpan, totalLines) - win.windowLimit
              );
              const estSliceSavings = Math.max(
                1,
                Math.round((rawContent.length / 4) * (clampedLines / Math.max(1, totalLines)))
              );
              const savedTokens = Math.max(Number(delta.savedTokens || 0), estSliceSavings);

              if (!sidecar.fileState.readSnapshots || typeof sidecar.fileState.readSnapshots !== 'object') {
                sidecar.fileState.readSnapshots = {};
              }
              if (rawContent.length <= 128 * 1024) {
                sidecar.fileState.readSnapshots[normFoldKey] = rawContent;
              }
              try {
                recordAntigravitySidecarSavings(sidecar, {
                  category: 'BOUNDED_READ_ENFORCED',
                  savedTokens,
                  detail: `Post-edit verify fold L${win.windowStart}-L${win.windowEnd} of ${path.basename(absFoldTarget)}`,
                  nowMs: readNowMs
                });
              } catch (saveErr) {
                recordHookDiagnostic('pre_invocation', 'handlePreToolUse.postEditVerifyFold', saveErr);
              }

              const cfg =
                inputData.shieldConfig || getShieldMod().loadShieldConfig({ cwd: workspacePath });
              const shieldOn = Boolean(
                inputData.shieldForceActive ||
                  (cfg.enabled && cfg.platforms?.antigravity !== false)
              );
              const foldMsg =
                `[Highbeam Post-Edit Verify Fold — ${path.basename(absFoldTarget)} (${totalLines} lines, +${savedTokens} tok saved)] Re-read near your edited hunk instead of reloading the full file: use StartLine: ${win.windowStart}, EndLine: ${win.windowEnd}.` +
                (delta.wasDiffed ? `\n${delta.diffText}` : '');
              const recommendedSlice = {
                StartLine: win.windowStart,
                EndLine: win.windowEnd
              };

              if (shieldOn) {
                try {
                  writeSidecarAtomicSync(conversationId, sidecar);
                } catch (sidecarErr) {
                  recordHookDiagnostic('pre_invocation', 'handlePreToolUse.postEditSidecar', sidecarErr);
                }
                return {
                  decision: 'deny',
                  permissionDecision: 'deny',
                  terminationBehavior: 'terminate',
                  blocked: true,
                  flightMode,
                  detectorId: 'DET-06',
                  subType: 'POST_EDIT_VERIFY_FOLD',
                  postEditVerifyFolded: true,
                  recommendedSlice,
                  ...(delta.wasDiffed ? { deltaDiffStub: delta.diffText } : {}),
                  savedTokens,
                  reason: foldMsg,
                  userMessage: foldMsg,
                  systemMessage: foldMsg
                };
              }

              postEditVerifyInfo = {
                recommendedSlice,
                deltaDiffStub: delta.wasDiffed ? delta.diffText : null,
                savedTokens,
                message: foldMsg
              };
            }
          }
        }
      } catch (agFoldErr) {
        recordHookDiagnostic('pre_invocation', 'handlePreToolUse.postEditVerifyFoldEval', agFoldErr, {
          persist: false
        });
      }
    }

    if (rawReadTarget && !postEditVerifyInfo) {
      const agSliceOffset = hasBounds ? Math.max(1, Number(startRaw) || 1) : null;
      const agSliceLimit = hasBounds
        ? limitRaw !== undefined && Number.isFinite(Number(limitRaw))
          ? Math.max(1, Number(limitRaw))
          : endRaw !== undefined && Number.isFinite(Number(endRaw))
            ? Math.max(1, Number(endRaw) - (agSliceOffset || 1) + 1)
            : null
        : null;
      const shieldRes = getShieldMod().evaluateShieldReadGuard({
        platform: 'antigravity',
        sessionId: conversationId,
        cwd: workspacePath,
        filePath: rawReadTarget,
        hasSliceBounds: hasBounds,
        sliceOffset: agSliceOffset,
        sliceLimit: agSliceLimit,
        currentPromptTokens: Number(
          inputData.totalPromptTokens ?? sidecar.telemetry?.totalInputTokens ?? 0
        ),
        modelId:
          inputData.modelName ||
          sidecar.sessionMeta?.active_model_id ||
          sidecar.sessionMeta?.activeModel ||
          'gemini-4-carbon',
        shieldConfig: inputData.shieldConfig,
        forceActive: Boolean(inputData.shieldForceActive),
        recordLedger: inputData.recordLedger !== false
      });
      if (shieldRes.action === 'deny') {
        return {
          decision: 'deny',
          permissionDecision: 'deny',
          terminationBehavior: 'terminate',
          blocked: true,
          flightMode,
          detectorId: shieldRes.detectorId,
          triggerReason: shieldRes.triggerReason,
          reason: shieldRes.reason,
          userMessage: shieldRes.reason,
          systemMessage: shieldRes.reason,
          indexPath: shieldRes.indexPath,
          fileBytes: shieldRes.fileBytes,
          maxBytes: shieldRes.maxBytes,
          savedTokens: shieldRes.savedTokens,
          savedUSD: shieldRes.savedUSD
        };
      }
    }
  }
  if (!isOffMode && /^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(toolName)) {
    // Item A2 (#3) & Item A7 (#12): Test Integrity Lock + Standalone Silent Error-Masking Linter
    const det03Mode = resolveDetectorOverride(horizonConfig, 'DET-03');
    if (det03Mode !== 'off') {
      const editTarget = String(
        toolInput?.Path || toolInput?.path || toolInput?.TargetFile || toolInput?.AbsolutePath || ''
      ).trim();
      const chunks = Array.isArray(toolInput?.ReplacementChunks) ? toolInput.ReplacementChunks : null;
      let oldTxt = String(
        toolInput?.Target ??
          toolInput?.TargetContent ??
          toolInput?.old_string ??
          (chunks ? chunks.map((c) => c?.TargetContent ?? c?.Target ?? '').join('\n') : '') ??
          ''
      );
      if (!oldTxt && /^(write_file|write_to_file)$/i.test(toolName) && editTarget) {
        try {
          const absEdit = path.isAbsolute(editTarget)
            ? editTarget
            : path.resolve(workspacePath, editTarget);
          if (fs.existsSync(absEdit) && fs.statSync(absEdit).isFile()) {
            oldTxt = fs.readFileSync(absEdit, 'utf8');
          }
        } catch {
          oldTxt = '';
        }
      }
      const newTxt = String(
        toolInput?.Replacement ??
          toolInput?.ReplacementContent ??
          toolInput?.Content ??
          toolInput?.CodeContent ??
          toolInput?.new_string ??
          (chunks ? chunks.map((c) => c?.ReplacementContent ?? c?.Replacement ?? '').join('\n') : '') ??
          ''
      );
      if (oldTxt || newTxt) {
        const diffRes = evaluateDet05DiffThrashing({
          filePath: editTarget,
          oldText: oldTxt,
          newText: newTxt,
          toolName,
          flightMode,
          lastUserInput: effectivePromptText,
          userExplicitTestIntent
        });
        if (diffRes.triggered && diffRes.decision === 'deny' && diffRes.subType !== 'SUDDEN_FILE_SHRINKAGE') {
          if (det03Mode !== 'warn') {
            return makeBlockPayload({ id: 'DET-03', message: diffRes.reason });
          }
          if (!isSilentMode && !gateSystemMessage) gateSystemMessage = diffRes.reason;
        } else if (
          diffRes.triggered &&
          diffRes.subType === 'SUDDEN_FILE_SHRINKAGE' &&
          /\.(?:test|spec)\.[a-z0-9]+$/i.test(editTarget) &&
          !userExplicitTestIntent
        ) {
          if (det03Mode !== 'warn') {
            return makeBlockPayload({ id: 'DET-03', message: diffRes.reason });
          }
          if (!isSilentMode && !gateSystemMessage) gateSystemMessage = diffRes.reason;
        }
      }
    }

    const det09Mode = resolveDetectorOverride(horizonConfig, 'DET-09');
    if (det09Mode !== 'off') {
      const det09CachedTok =
        inputData.cachedTokens ?? sidecar.telemetry?.cachedTokens ?? sidecar.telemetry?.totalInputTokens ?? 0;
      const det09TtlSec =
        inputData.cacheTtlSeconds ?? sidecar.telemetry?.cacheTtlSeconds ?? 300;
      const det09 = getDetectorsMod().evaluateDet09MidSessionRuleMutate(syntheticStep, {
        cachedTokens: det09CachedTok,
        cacheTtlSeconds: det09TtlSec,
        cacheState: inputData.cacheState
      });
      if (det09) {
        // OPT-4B: Stage rule/prefix mutation via PrefixCacheShield for automatic post-compaction flush
        let stagedRes = null;
        if (inputData.stagePrefixDelta !== false) {
          const agStageTarget = String(
            toolInput?.Path || toolInput?.path || toolInput?.TargetFile || toolInput?.AbsolutePath || ''
          ).trim();
          const { PrefixCacheShield, isProtectedPrefixFile } = getPrefixShieldMod();
          if (agStageTarget && isProtectedPrefixFile(agStageTarget)) {
            const agChunks = Array.isArray(toolInput?.ReplacementChunks) ? toolInput.ReplacementChunks : null;
            const agOldTxt = String(
              toolInput?.Target ??
                toolInput?.TargetContent ??
                toolInput?.old_string ??
                (agChunks ? agChunks.map((c) => c?.TargetContent ?? c?.Target ?? '').join('\n') : '') ??
                ''
            );
            const agNewTxt = String(
              toolInput?.Replacement ??
                toolInput?.ReplacementContent ??
                toolInput?.Content ??
                toolInput?.CodeContent ??
                toolInput?.new_string ??
                (agChunks ? agChunks.map((c) => c?.ReplacementContent ?? c?.Replacement ?? '').join('\n') : '') ??
                ''
            );
            if (agOldTxt || agNewTxt) {
              try {
                const absStageTarget = path.isAbsolute(agStageTarget)
                  ? agStageTarget
                  : path.resolve(workspacePath, agStageTarget);
                const shield = new PrefixCacheShield({
                  homeDir: inputData.homeDir || undefined,
                  warmCacheThreshold: 25_000
                });
                const deltaOp = agOldTxt
                  ? 'MODIFY'
                  : /^(?:write_file|write_to_file)$/i.test(toolName)
                    ? 'REPLACE'
                    : 'ADD';
                stagedRes = shield.stageOrApplyDelta(
                  {
                    targetPath: absStageTarget,
                    operation: deltaOp,
                    targetText: agOldTxt || null,
                    replacementText: agOldTxt ? agNewTxt : null,
                    newContent: !agOldTxt ? agNewTxt : null,
                    ruleText: !agOldTxt ? agNewTxt : null,
                    source: 'det09_antigravity'
                  },
                  {
                    sessionId: conversationId,
                    cachedTokens: Math.max(Number(det09CachedTok) || 0, 25_000),
                    cacheTtlSeconds: Math.max(Number(det09TtlSec) || 0, 1),
                    cacheWarm: true
                  }
                );
                sidecar.prefixShield = {
                  stagedCount: Number(stagedRes?.stagedCount || 0),
                  badge: stagedRes?.badge || '',
                  queuePath: stagedRes?.queuePath || null
                };
                writeSidecarAtomicSync(conversationId, sidecar);
              } catch (stageErr) {
                recordHookDiagnostic('pre_invocation', 'det09Stage', stageErr, { persist: false });
              }
            }
          }
        }
        if (isAutoPilotMode || det09Mode === 'block') {
          const blockRes = makeBlockPayload(det09);
          if (stagedRes?.staged) {
            blockRes.prefixDeltaStaged = true;
            blockRes.stagedCount = stagedRes.stagedCount;
            blockRes.stagedBadge = stagedRes.badge;
          }
          return blockRes;
        }
        logAgToolShadowMiss(
          'DET-09',
          'PREFIX_MUTATION_BUST',
          0.25,
          Number(inputData.cachedTokens ?? sidecar.telemetry?.cachedTokens ?? sidecar.telemetry?.totalInputTokens ?? 30000),
          det09.message
        );
        if (!isSilentMode) {
          gateSystemMessage = stagedRes?.badge
            ? `${det09.message} ${stagedRes.badge}`
            : det09.message;
        }
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
        const det20 = getDetectorsMod().evaluateDet20ScopeCollision([], {
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

  if (!isOffMode && inputData.bucketBShadow !== false) {
    try {
      const hasExplicitCwd = Boolean(inputData.cwd || inputData.workspacePath);
      const priorUnverifiedEdits = Array.isArray(inputData.editsSinceVerify)
        ? inputData.editsSinceVerify
        : Array.isArray(sidecar.fileState?.unverifiedEdits)
          ? sidecar.fileState.unverifiedEdits
          : [];
      const shadowRes = runBucketBPreToolShadowPass({
        platform: 'antigravity',
        sessionId: conversationId,
        cwd: workspacePath,
        hasExplicitCwd,
        toolName,
        toolInput: toolInput && typeof toolInput === 'object' ? toolInput : {},
        lastUserPrompt: effectivePromptText,
        editsSinceVerify: priorUnverifiedEdits,
        options: {
          bucketBStage: inputData.bucketBStage,
          bucketBAlphaStage: inputData.bucketBAlphaStage,
          bucketBBetaStage: inputData.bucketBBetaStage,
          bucketBGammaStage: inputData.bucketBGammaStage,
          bucketBLspStage: inputData.bucketBLspStage,
          persistState: inputData.persistState,
          mode: flightMode,
          registryMetadata: inputData.registryMetadata,
          cliCapabilities: inputData.cliCapabilities,
          lspCapabilities: inputData.lspCapabilities,
          horizonConfig
        }
      });
      if (shadowRes.triggered && shadowRes.activeRecords.length > 0) {
        const blockingEntry = shadowRes.activeRecords.find(
          (r) => r.stage === 'ENFORCE' || (isAutoPilotMode && r.verdict.decision === 'ask')
        );
        if (blockingEntry) {
          return makeBlockPayload({
            id: blockingEntry.verdict.code || 'BUCKET_B_GUARD',
            message: blockingEntry.verdict.reason
          });
        }
        if (!isSilentMode && !gateSystemMessage) {
          gateSystemMessage = shadowRes.activeRecords
            .map((r) => r.verdict.reason)
            .filter(Boolean)
            .join('\n');
        }
      }
    } catch (err) {
      recordHookDiagnostic('pre_invocation', 'handlePreToolUse.bucketBShadow', err, { persist: false });
    }
  }

  if (
    !isOffMode &&
    /^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(
      toolName
    )
  ) {
    const editTarget = String(
      toolInput?.Path || toolInput?.path || toolInput?.TargetFile || toolInput?.AbsolutePath || ''
    ).trim();
    if (editTarget) {
      const chunks = Array.isArray(toolInput?.ReplacementChunks) ? toolInput.ReplacementChunks : null;
      const newTxt = String(
        toolInput?.Replacement ??
          toolInput?.ReplacementContent ??
          toolInput?.Content ??
          toolInput?.CodeContent ??
          toolInput?.new_string ??
          (chunks ? chunks.map((c) => c?.ReplacementContent ?? c?.Replacement ?? '').join('\n') : '') ??
          ''
      );
      const oldTxt = String(
        toolInput?.Target ??
          toolInput?.TargetContent ??
          toolInput?.old_string ??
          (chunks ? chunks.map((c) => c?.TargetContent ?? c?.Target ?? '').join('\n') : '') ??
          ''
      );
      const changedLines = newTxt.split(/\r?\n/);
      const netLines = changedLines.filter((l) => l.trim().length > 0).length;
      const deletedLineCount = oldTxt ? oldTxt.split(/\r?\n/).length : 0;
      if (!sidecar.fileState || typeof sidecar.fileState !== 'object') sidecar.fileState = {};
      if (!Array.isArray(sidecar.fileState.unverifiedEdits)) sidecar.fileState.unverifiedEdits = [];
      sidecar.fileState.unverifiedEdits.push({
        filePath: editTarget,
        netLines,
        changedLines: changedLines.slice(0, 64)
      });
      if (sidecar.fileState.unverifiedEdits.length > 32) {
        sidecar.fileState.unverifiedEdits = sidecar.fileState.unverifiedEdits.slice(-32);
      }
      if (!Array.isArray(sidecar.fileState.turnFileDiffs)) sidecar.fileState.turnFileDiffs = [];
      sidecar.fileState.turnFileDiffs.push({
        filePath: editTarget,
        addedLines: newTxt ? changedLines.slice(0, 400) : [],
        deletedLineCount
      });
      if (sidecar.fileState.turnFileDiffs.length > 32) {
        sidecar.fileState.turnFileDiffs = sidecar.fileState.turnFileDiffs.slice(-32);
      }
      if (effectivePromptText) {
        sidecar.sessionMeta.lastUserPrompt = effectivePromptText;
      }

      // Record pre-edit snapshot + recent-edit marker for IMP-4B verify re-read folding
      try {
        const absEdit = path.isAbsolute(editTarget)
          ? editTarget
          : path.resolve(workspacePath, editTarget);
        const normEditKey = absEdit.replace(/\\/g, '/').toLowerCase();
        sidecar.fileState.opSeq = Number(sidecar.fileState.opSeq || 0) + 1;
        if (!sidecar.fileState.readSnapshots || typeof sidecar.fileState.readSnapshots !== 'object') {
          sidecar.fileState.readSnapshots = {};
        }
        let preEditTxt = '';
        if (fs.existsSync(absEdit) && fs.statSync(absEdit).isFile() && fs.statSync(absEdit).size <= 128 * 1024) {
          preEditTxt = fs.readFileSync(absEdit, 'utf8');
          const snapKeys = Object.keys(sidecar.fileState.readSnapshots);
          if (!sidecar.fileState.readSnapshots[normEditKey] && snapKeys.length >= 12) {
            delete sidecar.fileState.readSnapshots[snapKeys[0]];
          }
          sidecar.fileState.readSnapshots[normEditKey] = preEditTxt;
        } else if (typeof sidecar.fileState.readSnapshots[normEditKey] === 'string') {
          preEditTxt = sidecar.fileState.readSnapshots[normEditKey];
        }
        if (!sidecar.fileState.recentEdits || typeof sidecar.fileState.recentEdits !== 'object') {
          sidecar.fileState.recentEdits = {};
        }
        const editKeys = Object.keys(sidecar.fileState.recentEdits);
        if (!sidecar.fileState.recentEdits[normEditKey] && editKeys.length >= 16) {
          delete sidecar.fileState.recentEdits[editKeys[0]];
        }
        let approxLineStart = Number(toolInput?.StartLine ?? toolInput?.start_line);
        if (!Number.isFinite(approxLineStart) || approxLineStart < 1) {
          const probe = String(oldTxt || '').split(/\r?\n/).find((l) => l.trim().length > 0) || '';
          const idx = probe && preEditTxt ? preEditTxt.indexOf(probe) : -1;
          approxLineStart = idx >= 0 ? preEditTxt.slice(0, idx).split(/\r?\n/).length : 1;
        }
        sidecar.fileState.recentEdits[normEditKey] = {
          opSeq: sidecar.fileState.opSeq,
          turn: Number(sidecar.sessionMeta?.turnCount || 0),
          timestampMs: inputData.nowMs ?? inputData.eventTimestampUtc ?? Date.now(),
          approxLineStart: Math.round(approxLineStart)
        };
        if (!getSmartCompactMod().isNonCodeDocOrArtifactPath(editTarget)) {
          sidecar.taskBoundaryState = {
            openFailure: Boolean(sidecar.taskBoundaryState?.openFailure),
            editsSinceBoundary: Math.max(0, Number(sidecar.taskBoundaryState?.editsSinceBoundary || 0)) + 1,
            turnBoundaryReached: false,
            lastBoundarySuggestedTurn: sidecar.taskBoundaryState?.lastBoundarySuggestedTurn ?? null
          };
        }
      } catch (agEditSnapErr) {
        recordHookDiagnostic('pre_invocation', 'handlePreToolUse.recentEditTrack', agEditSnapErr, {
          persist: false
        });
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
  let astSignatureStub = null;
  let deltaDiffStub = postEditVerifyInfo?.deltaDiffStub || null;
  let astStubSavedTokens = postEditVerifyInfo?.savedTokens || 0;
  let autoTieredSubagentInput = null;
  let autoTieredSavedTokens = 0;
  if (postEditVerifyInfo && !isSilentMode && !systemMessage) {
    systemMessage = postEditVerifyInfo.message;
  }

  if (!isOffMode && !postEditVerifyInfo && (toolName === 'read_file' || toolName === 'Read' || toolName === 'view_file')) {
    const rawTarget = String(
      toolInput?.Path || toolInput?.path || toolInput?.file_path || toolInput?.TargetFile || toolInput?.AbsolutePath || ''
    ).trim();
    const hasLineBounds = Number.isFinite(Number(toolInput?.StartLine ?? toolInput?.start_line ?? toolInput?.offset)) ||
      Number.isFinite(Number(toolInput?.EndLine ?? toolInput?.end_line ?? toolInput?.limit));
    if (rawTarget && !hasLineBounds) {
      const resolvedPath = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(workspacePath, rawTarget);
      const normKey = resolvedPath.replace(/\\/g, '/').toLowerCase();
      if (!sidecar.fileState || typeof sidecar.fileState !== 'object') sidecar.fileState = {};
      if (!sidecar.fileState.unclippedReadCounts || typeof sidecar.fileState.unclippedReadCounts !== 'object') {
        sidecar.fileState.unclippedReadCounts = {};
      }
      if (!sidecar.fileState.readSnapshots || typeof sidecar.fileState.readSnapshots !== 'object') {
        sidecar.fileState.readSnapshots = {};
      }
      const priorReads = Number(inputData.priorUnclippedReads ?? sidecar.fileState.unclippedReadCounts[normKey] ?? 0);
      const nextReads = priorReads + 1;
      sidecar.fileState.unclippedReadCounts[normKey] = nextReads;

      if (fs.existsSync(resolvedPath)) {
        try {
          const stat = fs.statSync(resolvedPath);
          if (stat.isFile() && stat.size > 256 && stat.size <= 512 * 1024) {
            const rawContent = fs.readFileSync(resolvedPath, 'utf8');
            const prevSnap = typeof inputData.priorContentSnapshot === 'string'
              ? inputData.priorContentSnapshot
              : (typeof sidecar.fileState.readSnapshots[normKey] === 'string' ? sidecar.fileState.readSnapshots[normKey] : null);

            if (prevSnap !== null && prevSnap !== rawContent) {
              const delta = getCodeFoldMod().computeCompactLineDiff(prevSnap, rawContent, path.basename(resolvedPath));
              if (delta.wasDiffed) {
                deltaDiffStub = delta.diffText;
                astStubSavedTokens = delta.savedTokens;
                const deltaNotice = `[Highbeam Post-Edit Delta Read — ${path.basename(resolvedPath)} (+${delta.savedTokens} tokens saved)]\n${delta.diffText}`;
                if (!isSilentMode && !systemMessage) {
                  systemMessage = deltaNotice;
                }
                try {
                  recordAntigravitySidecarSavings(sidecar, {
                    category: 'BOUNDED_READ_ENFORCED',
                    savedTokens: delta.savedTokens,
                    detail: `Post-edit delta read for ${path.basename(resolvedPath)}`,
                    nowMs: inputData.nowMs ?? inputData.eventTimestampUtc ?? Date.now()
                  });
                } catch (err) {
                  recordHookDiagnostic('pre_invocation', 'handlePreToolUse.recordDeltaSavings', err);
                }
              }
            } else if (nextReads >= 3 && stat.size > 512) {
              const fullTokens = Math.max(1, Math.ceil(rawContent.length / 4));
              const folded = getCodeFoldMod().foldCodeToSignatureStub(rawContent, resolvedPath);
              const stubText = typeof folded?.condensed === 'string' && folded.condensed.length > 0
                ? folded.condensed
                : rawContent.slice(0, 1200);
              const stubTokens = Math.max(1, Math.ceil(stubText.length / 4));
              astStubSavedTokens = Math.max(0, fullTokens - stubTokens);
              astSignatureStub = stubText;
              const stubNotice = `[Highbeam AST Signature Stub — Read #${nextReads} of ${path.basename(resolvedPath)} (${astStubSavedTokens} tokens saved; pass StartLine/EndLine for full bodies)]\n${stubText}`;
              if (!isSilentMode && !systemMessage) {
                systemMessage = stubNotice;
              }
              if (astStubSavedTokens > 0) {
                try {
                  recordAntigravitySidecarSavings(sidecar, {
                    category: 'BOUNDED_READ_ENFORCED',
                    savedTokens: astStubSavedTokens,
                    detail: `AST signature stub read #${nextReads} for ${path.basename(resolvedPath)}`,
                    nowMs: inputData.nowMs ?? inputData.eventTimestampUtc ?? Date.now()
                  });
                } catch (err) {
                  recordHookDiagnostic('pre_invocation', 'handlePreToolUse.recordAstStubSavings', err);
                }
              }
            }

            if (rawContent.length <= 128 * 1024) {
              const snapKeys = Object.keys(sidecar.fileState.readSnapshots);
              if (!sidecar.fileState.readSnapshots[normKey] && snapKeys.length >= 12) {
                delete sidecar.fileState.readSnapshots[snapKeys[0]];
              }
              sidecar.fileState.readSnapshots[normKey] = rawContent;
            }
          }
        } catch (err) {
          recordHookDiagnostic('pre_invocation', 'handlePreToolUse.astSignatureStub', err);
        }
      }
    }
  }

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
      if (!isAutoPilotMode && Number(coldCacheWakeup.incrementalColdPenaltyUsd || 0) >= 0.5) {
        logAgToolShadowMiss(
          'DET-16',
          'COLD_SWARM_WAKEUP',
          Number(coldCacheWakeup.incrementalColdPenaltyUsd || 0.55),
          Number(inputData.cachedTokens ?? sidecar.telemetry?.cachedTokens ?? 120000),
          coldCacheWakeup.message
        );
      }
      if (!isSilentMode && !isOffMode) {
        systemMessage = coldCacheWakeup.message;
      }
    }
  } else if (toolName === 'invoke_subagent' || toolName === 'define_subagent' || toolName === 'swarm') {
    // Item A9 (#18): Concurrent Multi-Agent Worktree Isolation Guard (`Workspace: "branch" | "share"`)
    if (
      !isOffMode &&
      (toolName === 'invoke_subagent' ||
        (toolName === 'swarm' && String(toolInput?.action || '').toLowerCase() === 'add'))
    ) {
      const subType = String(toolInput?.TypeName || toolInput?.name || '').trim().toLowerCase();
      const isReadOnlySub =
        subType === 'research' || subType === 'ah-flash-scout' || subType === 'browser';
      const wsMode = String(toolInput?.Workspace || toolInput?.workspace || 'inherit')
        .trim()
        .toLowerCase();
      if (!isReadOnlySub && wsMode !== 'branch' && wsMode !== 'share') {
        const activeLeasesCount = Array.isArray(inputData.activeLeases)
          ? inputData.activeLeases.length
          : loadRegistry(workspacePath).leases.length;
        const activeRosterCount = Object.values(tracker.getRosterSnapshot() || {}).filter(
          (a) => a && a.status !== 'terminated' && !/^(research|ah-flash-scout|browser)$/i.test(String(a.id || ''))
        ).length;
        const concurrentWriters = Math.max(
          activeLeasesCount,
          activeRosterCount,
          Number(inputData.activeWriteWorkers ?? 0)
        );
        if (concurrentWriters >= 1 && resolveDetectorOverride(horizonConfig, 'DET-20') !== 'off') {
          const wtMsg =
            `[DET-20 Worktree Isolation Guard (#18)] Spawning write-capable ${toolName} with Workspace: "${wsMode}" while ${concurrentWriters} write worker(s)/lease(s) are already active risks shared-tree clobbering. Set Workspace: "branch" or "share".`;
          if (isAutoPilotMode || resolveDetectorOverride(horizonConfig, 'DET-20') === 'block') {
            return makeBlockPayload({ id: 'DET-20', message: wtMsg });
          }
          if (!isSilentMode && !systemMessage) systemMessage = wtMsg;
        }
      }
    }
    if (toolName === 'invoke_subagent' || toolName === 'define_subagent') {
      const subagentId = toolInput?.ConversationId || toolInput?.conversationId || toolInput?.Name || toolInput?.TypeName || toolInput?.Role || 'subagent';
      let subagentModel = toolInput?.Model && toolInput.Model !== 'inherit'
        ? toolInput.Model
        : (sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || 'gemini-4-carbon');
      if (toolName === 'invoke_subagent' && !isOffMode) {
        const gov = getBucketBGammaMod().evaluateSubagentGovernor({
          typeName: toolInput?.TypeName || toolInput?.subagent_type || '',
          role: toolInput?.Role || toolInput?.description || '',
          prompt: toolInput?.Prompt || toolInput?.prompt || '',
          model: toolInput?.Model || toolInput?.model || 'inherit',
          enableWriteTools: toolInput?.EnableWriteTools,
          allowedTools: toolInput?.Tools || toolInput?.tools,
          workspace: toolInput?.Workspace || toolInput?.workspace || 'inherit'
        });
        const hasExplicitFrontierPin =
          /\b(?:use\s+(?:opus|sonnet|pro|carbon|fable|mythos)|with\s+(?:opus|sonnet|pro|carbon)|model\s*[:=]\s*(?:opus|sonnet|pro|carbon))\b/i.test(
            effectivePromptText
          );
        if (
          isAutoPilotMode &&
          gov.triggered &&
          gov.isReadOnlyScout === true &&
          gov.recommendedModel === 'flash_or_haiku' &&
          !hasExplicitFrontierPin
        ) {
          subagentModel = 'flash';
          autoTieredSubagentInput = { ...toolInput, Model: 'flash' };
          autoTieredSavedTokens = Math.max(autoTieredSavedTokens, Number(gov.tokensSavedEst || 4500));
          if (!isSilentMode && !systemMessage && gov.reason) {
            systemMessage = gov.reason;
          }
        }
      }
      tracker.touchAgentActive(subagentId, {
        modelId: subagentModel,
        warmPrefixTokens: Number(toolInput?.warm_prefix_tokens ?? 0),
        timestampMs: nowMs
      });
    }
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
    decision: 'allow',
    flightMode,
    active_model_id: sidecar.sessionMeta.active_model_id || sidecar.sessionMeta.activeModel || null,
    pending_model_id: sidecar.sessionMeta.pending_model_id || null,
    swarmTtlBadges: sidecar.swarmTtlBadges
  };
  if (autoTieredSubagentInput) {
    response.updatedInput = autoTieredSubagentInput;
    response.autoTieredModel = 'flash';
    response.savedTokens = Math.max(Number(response.savedTokens || 0), autoTieredSavedTokens);
  }
  if (coldCacheWakeup) response.coldCacheWakeup = coldCacheWakeup;
  if (astSignatureStub) {
    response.astSignatureStub = astSignatureStub;
    response.savedTokens = astStubSavedTokens;
  }
  if (postEditVerifyInfo) {
    response.postEditVerifyFolded = true;
    response.recommendedSlice = postEditVerifyInfo.recommendedSlice;
    response.savedTokens = postEditVerifyInfo.savedTokens;
  }
  if (deltaDiffStub) {
    response.deltaDiffStub = deltaDiffStub;
    response.savedTokens = astStubSavedTokens;
  }
  if (systemMessage && !isSilentMode && !isOffMode) response.systemMessage = systemMessage;
  return response;
}

/**
 * Prompt halts that COACH keeps. The README promises COACH never stops a prompt except for a
 * 3-strike error loop or a destructive command (the latter is a PreToolUse deny, not a prompt
 * halt). Detectors the user explicitly set to `block`, and an explicit `#check`, also keep their halt.
 */
const COACH_KEPT_HALT_KEYS = new Set(['THREE_STRIKE_LOOP']);

/**
 * In COACH, turns a prompt halt into an on-screen message unless it is one COACH keeps.
 * AUTO_PILOT and other modes are returned unchanged.
 * @param {object} out
 * @param {object} inputData
 * @returns {object}
 */
export function applyCoachHaltPolicy(out, inputData = {}) {
  if (!out || typeof out !== 'object' || out.terminationBehavior !== 'terminate') return out;
  if (out.explicitBlock === true || out.userRequested === true || COACH_KEPT_HALT_KEYS.has(out.haltKey)) return out;
  let effective = 'COACH';
  try {
    const workspacePath = inputData.cwd || inputData.workspacePath || inputData.workspacePaths?.[0] || process.cwd();
    const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
      cwd: workspacePath,
      ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
    });
    const rawFlightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
    effective = AUTO_MODE_ALIAS_RE.test(rawFlightMode)
      ? getProMod().resolveEffectiveAutoFlightMode(rawFlightMode, {
          licensePath: inputData.licensePath,
          homeDir: inputData.homeDir,
          strict: Boolean(inputData.strictProGate)
        }).effectiveFlightMode
      : resolveSimpleAgMode(rawFlightMode);
  } catch (err) {
    recordHookDiagnostic('pre_invocation', 'applyCoachHaltPolicy.resolveMode', err);
  }
  if (effective !== 'COACH') return out;
  const message = String(out.errorMessage?.userMessage || out.userMessage || out.reason || out.systemMessage || '');
  const { terminationBehavior, decision, errorMessage, userMessage, ...rest } = out;
  return { ...rest, systemMessage: message, ephemeralMessage: message, coachAdvisory: true };
}

export async function handlePreInvocation(inputData = {}) {
  inputData = normalizeAntigravityToolPayload(inputData) || {};
  // Tool calls never go through the COACH prompt-halt policy: a destructive command stays denied.
  if (isPreToolUsePayload(inputData)) return handlePreToolUse(inputData);
  const out = await runPreInvocationChecks(inputData);
  return applyCoachHaltPolicy(out, inputData);
}

function isPreToolUsePayload(inputData = {}) {
  return Boolean(
    inputData.hook_event_name === 'PreToolUse' ||
    inputData.event === 'PreToolUse' ||
    inputData.tool_name ||
    inputData.toolName ||
    inputData.tool_input ||
    inputData.args ||
    inputData.parameters ||
    inputData.Arguments ||
    (typeof inputData.tool === 'string' && inputData.tool.length > 0) ||
    (typeof inputData.name === 'string' && !inputData.prompt && !inputData.user_input)
  );
}

async function runPreInvocationChecks(inputData = {}) {
  if (
    inputData.hook_event_name === 'PreToolUse' ||
    inputData.event === 'PreToolUse' ||
    inputData.tool_name ||
    inputData.toolName ||
    inputData.tool_input ||
    inputData.args ||
    inputData.parameters ||
    inputData.Arguments ||
    (typeof inputData.tool === 'string' && inputData.tool.length > 0) ||
    (typeof inputData.name === 'string' && !inputData.prompt && !inputData.user_input)
  ) {
    return handlePreToolUse(inputData);
  }

  const config = inputData.configOverride || loadFlightcheckConfig();
  const rawPrompt = String(
    inputData.prompt || inputData.user_input || inputData.lastUserInput || inputData.message || ''
  ).trim();
  const conversationId = inputData.conversationId || inputData.session_id || inputData.conversation_id || 'default_session';
  const sidecar = readSidecarSync(conversationId);
  const workspacePath = inputData.cwd || inputData.workspacePath || sidecar.workspacePath || process.cwd();
  const horizonConfig = inputData.horizonConfig || loadHorizonConfig({
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {})
  });
  const rawFlightMode = String(inputData.flightMode || horizonConfig.flightMode || 'COACH').toUpperCase();
  const resolvedModeInfo = AUTO_MODE_ALIAS_RE.test(rawFlightMode)
    ? getProMod().resolveEffectiveAutoFlightMode(rawFlightMode, {
        licensePath: inputData.licensePath,
        homeDir: inputData.homeDir,
        strict: Boolean(inputData.strictProGate)
      })
    : { effectiveFlightMode: resolveSimpleAgMode(rawFlightMode) };
  const flightMode = resolvedModeInfo.effectiveFlightMode;
  const agPromptShadowOpts = {
    cwd: workspacePath,
    ...(inputData.homeDir ? { homeDir: inputData.homeDir } : {}),
    ...(inputData.shadowLedgerPath ? { shadowLedgerPath: inputData.shadowLedgerPath } : {})
  };
  const logAgPromptShadowMiss = (detectorId, category, missedUsd, wastedTokens, detail) => {
    if (flightMode === 'AUTO_PILOT') return;
    getShadowAutoMod().recordShadowAutoMiss(
      {
        sessionId: conversationId,
        workspacePath,
        harness: 'antigravity',
        effectiveMode: flightMode,
        category,
        detectorId,
        turnKey: inputData.turnKey || inputData.turn || `${detectorId}:prompt`,
        wastedTokens,
        missedUsd,
        avoidedPrompts: 1,
        autoSelected: rawFlightMode === 'AUTO_PILOT' || rawFlightMode === 'AUTOPILOT',
        detail
      },
      agPromptShadowOpts
    );
  };

  // 1. Control Flags & flightMode Handling (ISS-039)
  if (config.hook_level === 'off' || flightMode === 'OFF') {
    return {};
  }
  if (flightMode === 'SILENT') {
    // SILENT suppresses all non-Ring-0 advisory context/stderr chatter on PreInvocation
    // (Ring-0 security blocks remain active in PreToolUse and workspace settings checks).
    if (resolveDetectorOverride(horizonConfig, 'DET-18') !== 'off' && inputData.scanWorkspaceSettings === true) {
      const det18 = getDetectorsMod().evaluateDet18UntrustedWorkspaceSettings([], { workspacePath, scanWorkspace: true });
      if (det18) {
        return { terminationBehavior: 'terminate', decision: 'block', detectorId: 'DET-18', userMessage: det18.message };
      }
    }
    if (rawPrompt && (inputData.cwd || inputData.workspacePath) && inputData.bucketBShadow !== false) {
      try {
        const silentFileState = sidecar.fileState || {};
        const silentSessionMeta = sidecar.sessionMeta || {};
        const isAutonomousOrSubagent = Boolean(
          inputData.isAutonomousTurn ||
            inputData.autonomous ||
            inputData.isSubagent ||
            silentSessionMeta.isSubagent ||
            inputData.isScheduledTask ||
            inputData.isLoopIteration ||
            /^(?:scheduled|cron|loop|subagent|agent_callback|callback|auto|autonomous|background|system|hook|task_notification|wake)$/i.test(
              String(inputData.provenance || inputData.source || '')
            )
        );
        const cachedDirtyFiles = Array.isArray(inputData.cachedDirtyFiles)
          ? inputData.cachedDirtyFiles
          : [
              ...(silentFileState.modifiedFiles || []),
              ...(Array.isArray(silentFileState.unverifiedEdits)
                ? silentFileState.unverifiedEdits.map((e) => e?.filePath)
                : [])
            ];
        runBucketBPromptPass({
          platform: 'antigravity',
          sessionId: conversationId,
          cwd: workspacePath,
          hasExplicitCwd: true,
          prompt: rawPrompt,
          isAutonomousOrSubagent,
          cachedDirtyFiles,
          lastFailingLocation:
            inputData.lastFailingLocation ?? silentSessionMeta.lastFailingLocation ?? '',
          options: {
            bucketBStage: inputData.bucketBStage,
            bucketBGammaStage: inputData.bucketBGammaStage,
            mode: 'SILENT',
            horizonConfig
          }
        });
      } catch (err) {
        recordHookDiagnostic('pre_invocation', 'handlePreInvocation.silentPromptPass', err, { persist: false });
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
    return { terminationBehavior: 'terminate', userMessage: card, haltKey: stateKey };
  }

  function applyHabitOverride(slug, stateKey, card, { detectorId = null, defaultMode = 'haltOrAdvise', extraWarn = {}, extraBlock = {} } = {}) {
    const override = resolveDetectorOverride(horizonConfig, slug);
    if (override === 'off') return null;
    if (override === 'warn') {
      return { systemMessage: card, ...(detectorId ? { detectorId } : {}), ...extraWarn };
    }
    if (override === 'block') {
      lastHalts[stateKey] = turnCount;
      sessionMeta.lastHalts = lastHalts;
      sidecar.sessionMeta = sessionMeta;
      try {
        writeSidecarAtomicSync(conversationId, sidecar);
      } catch (err) {
        recordHookDiagnostic('pre_invocation', 'applyHabitOverride.writeSidecar', err);
      }
      return {
        terminationBehavior: 'terminate',
        decision: 'block',
        ...(detectorId ? { detectorId } : {}),
        userMessage: card,
        explicitBlock: true,
        ...extraBlock
      };
    }
    if (defaultMode === 'flightMode') {
      if (flightMode === 'AUTO_PILOT') {
        return {
          terminationBehavior: 'terminate',
          decision: 'block',
          ...(detectorId ? { detectorId } : {}),
          userMessage: card,
          ...extraBlock
        };
      }
      return { systemMessage: card, ...(detectorId ? { detectorId } : {}), ...extraWarn };
    }
    return haltOrAdvise(stateKey, card);
  }

  // 2. ALLOW_PLAN_OR_SUBAGENT
  if (!hasCheckTag && (sessionMeta.inPlanMode || sessionMeta.lastTurnUsedSubagent)) {
    if (!telemetry.amputationRisk && !sensors.threeStrikeLoop) {
      return {};
    }
  }

  // 3. HALT_HYGIENE_OR_SAFETY
  sessionMeta.lastUserPrompt = rawPrompt;
  const isHighOrMaxEffort = activeEffort === 'high' || activeEffort === 'max';

  // 3a.0 Item A6 (#11): Active DET-30 Thinking Runaway Step-Down Gate (>4,000 thinking tokens & >12x ratio across >=2 turns)
  if (resolveDetectorOverride(horizonConfig, 'DET-30') !== 'off') {
    const det30Check = evaluateActiveDet30StepDown({
      recentTurns: inputData.recentTurns || telemetry.recentTurns,
      thinkingDrift: inputData.thinkingDrift || telemetry.thinkingDrift || sensors.thinkingDrift,
      mode: flightMode
    });
    if (det30Check.triggered) {
      const det30Card = formatScorecard(
        det30Check.reason,
        `[Thinking Streak: ${det30Check.consecutiveTurns} turns | Ratio: ${det30Check.latestRatio}x]`,
        `Step down effort to medium or cap MAX_THINKING_TOKENS=16000`,
        `"Switch to medium effort before sending next prompt"`
      );
      const det30Res = applyHabitOverride('thinking-runaway', 'DET30_THINKING_STEPDOWN', det30Card, {
        detectorId: 'DET-30',
        defaultMode: 'flightMode'
      });
      if (det30Res) {
        if (det30Res.decision !== 'block' && det30Res.terminationBehavior !== 'terminate') {
          logAgPromptShadowMiss('DET-30', 'RUNAWAY_LOOP_TURN', 0.35, Number(tokens || 40000), det30Check.reason);
        }
        return det30Res;
      }
    }
  }

  // 3a. Item A3 (#7): Parameterized Pricing Cliff Breaker (Haiku 100K 5x + Gemini 3.1/2.5 Pro 200K 2x/1.5x)
  if (resolveDetectorOverride(horizonConfig, 'DET-12') !== 'off') {
    const cliffCheck = evaluateParameterizedCliffBreaker({
      modelId: activeModel,
      totalInputTokens: Number(inputData.totalInputTokens ?? inputData.totalPromptTokens ?? tokens)
    });
    if (cliffCheck.triggered) {
      if (cliffCheck.decision === 'deny') {
        const cliffCard = formatScorecard(
          cliffCheck.reason,
          `[Useful Context: ${purity}% | Cliff Threshold: ${Math.round(cliffCheck.cliffThresholdTokens / 1000)}k]`,
          `/compact or /clear`,
          `"Compact context before crossing the ${Math.round(cliffCheck.cliffThresholdTokens / 1000)}k stepped pricing cliff"`
        );
        return haltOrAdvise('PRICING_CLIFF_BREAKER', cliffCard, { exemptFromCooldown: true });
      }
      const advRes = applyHabitOverride('pricing-cliff', 'PRICING_CLIFF_ADVISORY', cliffCheck.reason, {
        detectorId: 'DET-12',
        defaultMode: 'warn'
      });
      if (advRes) return advRes;
    }
  }

  // 3b. Item A1 (#1): Warm-Cache Mid-Session Model Switch Guard (Antigravity PreInvocation)
  const priorActiveModel = sessionMeta.active_model_id || sessionMeta.activeModel || null;
  if (
    inputData.modelName &&
    priorActiveModel &&
    turnCount >= 1 &&
    normalizeModelKey(inputData.modelName) !== normalizeModelKey(priorActiveModel)
  ) {
    const cachedTok = Number(
      inputData.cachedTokens ?? telemetry.cachedTokens ?? telemetry.cacheReadTokens ?? tokens ?? 0
    );
    const cacheTtlSec = Number(inputData.cacheTtlSeconds ?? telemetry.cacheTtlSeconds ?? 300);
    if (cachedTok >= 25000 && cacheTtlSec > 0) {
      const prevRates = resolveModelRates(priorActiveModel, inputData.eventTimestampUtc, 'standard', {
        totalPromptTokens: cachedTok
      });
      const nextRates = resolveModelRates(inputData.modelName, inputData.eventTimestampUtc, 'standard', {
        totalPromptTokens: cachedTok
      });
      const coldPenaltyUsd =
        (cachedTok / 1_000_000) * Math.max(0, nextRates.write5m - prevRates.cachedRead);
      const outputDeltaSavingUsd =
        (1500 / 1_000_000) * Math.max(0, prevRates.output - nextRates.output);
      if (coldPenaltyUsd > outputDeltaSavingUsd && coldPenaltyUsd >= 0.03) {
        const bustCard = formatScorecard(
          `[DET-08 Warm-Cache Model Switch] ${normalizeModelKey(priorActiveModel)} -> ${normalizeModelKey(inputData.modelName)} on ${Math.round(cachedTok / 1000)}k warm prefix`,
          `[Cold Cache Penalty: +$${coldPenaltyUsd.toFixed(3)} vs $${outputDeltaSavingUsd.toFixed(3)} output saving]`,
          `Stay on ${normalizeModelKey(priorActiveModel)} or delegate via invoke_subagent`,
          `"Keep main thread on ${normalizeModelKey(priorActiveModel)} until /compact, or use invoke_subagent"`
        );
        const bustRes = applyHabitOverride('mid-session-model-switch', 'MID_SESSION_CACHE_BUST', bustCard, {
          detectorId: 'DET-08',
          defaultMode: 'flightMode'
        });
        if (bustRes) {
          if (bustRes.decision !== 'block' && bustRes.terminationBehavior !== 'terminate') {
            logAgPromptShadowMiss(
              'DET-08',
              'WARM_SWITCH_BUST',
              Number(Math.max(0.03, coldPenaltyUsd - outputDeltaSavingUsd).toFixed(4)),
              cachedTok,
              `Warm model switch ${normalizeModelKey(priorActiveModel)} -> ${normalizeModelKey(inputData.modelName)}`
            );
          }
          return bustRes;
        }
      }
    }
  }
  // An explicit `#check` is answered by the scorecard below, so the context-crisis card does not shadow it.
  if (telemetry.amputationRisk && isTelemetryReliable && !hasCheckTag) {
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
    const effortRes = applyHabitOverride('effort-overkill', 'EFFORT_OVERKILL', card);
    if (effortRes) return effortRes;
  }

  // 4b. Local Formatter / Import Sorter Bypass (DET-15 / 'formatter-bypass')
  const isFormattingIntent = /\b(fix\s+(?:the\s+)?indentation|sort\s+(?:the\s+)?imports|format\s+this\s+(?:code|file|block)|convert\s+tabs\s+to\s+spaces|run\s+prettier)\b/i.test(rawPrompt);
  const pastedLineCount = (rawPrompt.match(/\r?\n/g) || []).length;
  if (isFormattingIntent && pastedLineCount >= 40 && !/\b(add|implement|refactor|create|fix\s+bug|logic|test|calculate)\b/i.test(rawPrompt)) {
    const bypassNotice = '[DET-15 Local Formatter Bypass] Prompt requests code formatting / import sorting on a pasted code block. Run `npx prettier --write <file>` or `npx eslint --fix <file>` directly (0 LLM tokens).';
    const fmtRes = applyHabitOverride('formatter-bypass', 'LOCAL_FORMATTER_BYPASS', bypassNotice, {
      detectorId: 'DET-15',
      defaultMode: 'flightMode'
    });
    if (fmtRes) return fmtRes;
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
  const matchedScope = (fileState.activeSetPaths || fileState.modifiedFiles || []).find(p => {
    const base = path.basename(p);
    return rawPrompt.includes(base) || rawPrompt.includes(p);
  }) || '';
  const hasActiveSetMatch = Boolean(matchedScope);

  // Conversational Drip-Feeding check (DET-02B) & Cross-Turn Sharded Spec Detector:
  // Even if prompt mentions activeSetPaths, 4+ rapid micro-prompts (<= 18 words) targeting the same file within 90s trigger DET-02B,
  // while 4+ requirement-mutating shards across >=25k tokens trigger SHARDED_SPEC_DRIFT.
  const timestampMs = Number(inputData.timestampMs ?? inputData.nowMs ?? inputData.timestamp ?? Date.now());
  const wordCount = rawPrompt.split(/\s+/).filter(Boolean).length;
  const effectiveTurnNumber = Number(
    inputData.turnNumber ?? Math.max(turnCount + 1, Number(sessionMeta.promptTurnSeq || 0) + 1)
  );
  sessionMeta.promptTurnSeq = effectiveTurnNumber;
  sessionMeta.recentPrompts = Array.isArray(sessionMeta.recentPrompts) ? sessionMeta.recentPrompts : [];
  sessionMeta.recentPrompts = sessionMeta.recentPrompts.filter(e => (timestampMs - e.ts) <= 90000);
  sessionMeta.recentPrompts.push({ ts: timestampMs, wordCount, targetScope: matchedScope });

  const shardedOverride = resolveDetectorOverride(horizonConfig, 'sharded-spec-drift');
  const shardedEval = rawPrompt
    ? evaluateShardedSpecDrift({
        prompt: rawPrompt,
        provenance: inputData.provenance || inputData.source || 'user',
        isAutonomousTurn: Boolean(inputData.isAutonomousTurn || inputData.autonomous),
        isSubagent: Boolean(inputData.isSubagent || sessionMeta.isSubagent),
        isScheduledTask: Boolean(inputData.isScheduledTask),
        isLoopIteration: Boolean(inputData.isLoopIteration),
        priorShards: Array.isArray(inputData.specShards) ? inputData.specShards : (sessionMeta.specShards || []),
        initialGoal: inputData.initialGoal ?? sessionMeta.initialGoal ?? '',
        totalTokens: Number(inputData.totalInputTokens ?? inputData.totalPromptTokens ?? tokens),
        turnNumber: effectiveTurnNumber,
        lastAlertTurn: Number(sessionMeta.lastShardedSpecAlertTurn || 0),
        overrideMode: shardedOverride,
        flightMode,
        detectorId: 'DET-26'
      })
    : { triggered: false, specShards: sessionMeta.specShards || [], initialGoal: sessionMeta.initialGoal || '', lastAlertTurn: Number(sessionMeta.lastShardedSpecAlertTurn || 0) };

  sessionMeta.specShards = shardedEval.specShards;
  if (shardedEval.initialGoal) sessionMeta.initialGoal = shardedEval.initialGoal;
  sessionMeta.lastShardedSpecAlertTurn = shardedEval.lastAlertTurn;

  sidecar.sessionMeta = sessionMeta;
  const flushSidecarOnce = () => {
    try {
      writeSidecarAtomicSync(conversationId, sidecar);
    } catch (err) {
      recordHookDiagnostic('pre_invocation', 'recentPrompts.writeSidecar', err);
    }
  };

  const rapidSameScopeCount = sessionMeta.recentPrompts.filter(
    e => e.targetScope && e.targetScope === matchedScope && e.wordCount <= 18
  ).length;

  if (rapidSameScopeCount >= 4) {
    const dripCard = `[DET-02B Conversational Drip-Feed Advisory] Detected ${rapidSameScopeCount} rapid single-sentence prompts on ${matchedScope || 'target file'} in <90s. Batch requirements into a single checklist turn to save prefix cache and 4x turn overhead.`;
    const dripRes = applyHabitOverride('drip-feed', 'CONVERSATIONAL_DRIP_FEED', dripCard, {
      detectorId: 'DET-02B',
      defaultMode: 'flightMode',
      extraWarn: { continue: true },
      extraBlock: { continue: false }
    });
    if (dripRes) {
      if (!dripRes.terminationBehavior && dripRes.decision !== 'block') flushSidecarOnce();
      return dripRes;
    }
  }

  if (shardedEval.triggered) {
    flushSidecarOnce();
    return {
      ephemeralMessage: shardedEval.steerContext,
      systemMessage: shardedEval.steerContext,
      detectorId: 'DET-26',
      subType: shardedEval.subType,
      shardCount: shardedEval.shardCount
    };
  }

  if (!hasCheckTag) {
    if (hasActiveSetMatch) {
      flushSidecarOnce();
      return {};
    }
    if (config.hook_level === 'guard' && turnCount > (config.trust_decay_turn_threshold || 10)) {
      flushSidecarOnce();
      return {};
    }
  }

  // 8a. Prompt Hygiene Governor (v4.1 Phase 1): Relay Breaker ('relay-breaker') & Scope Brake ('vague-prompt-rubric')
  const relayOverride = resolveDetectorOverride(horizonConfig, 'relay-breaker');
  const relayEval = evaluateRelayBreaker({
    prompt: rawPrompt,
    relayState: inputData.relayState ?? sessionMeta.relayState,
    sourceCodeEditsInSession: Number(inputData.sourceCodeEditsInSession ?? (fileState.modifiedFiles || []).filter(p => !/\.md$/i.test(String(p || ''))).length),
    sourceCodeEditedSinceLastRelay: Boolean(inputData.sourceCodeEditedSinceLastRelay),
    priorTurnWebSearches: Number(inputData.priorTurnWebSearches ?? sessionMeta.priorTurnWebSearches ?? 0),
    zeroEditSessionTokens: Number(inputData.zeroEditSessionTokens ?? (((fileState.modifiedFiles || []).length === 0) ? tokens : 0)),
    boundSpecPath: inputData.boundSpecPath ?? sessionMeta.relayState?.boundSpecPath ?? null,
    overrideMode: relayOverride,
    flightMode,
    detectorId: 'DET-26'
  });
  sessionMeta.relayState = relayEval.relayStateSnapshot;
  if (relayEval.triggered) {
    sidecar.sessionMeta = sessionMeta;
    try {
      writeSidecarAtomicSync(conversationId, sidecar);
    } catch (err) {
      recordHookDiagnostic('pre_invocation', 'relayBreaker.writeSidecar', err);
    }
    if (relayEval.decision === 'block') {
      sessionMeta.blockedPrompts = Number(sessionMeta.blockedPrompts || 0) + 1;
      return {
        terminationBehavior: 'terminate',
        decision: 'block',
        detectorId: 'DET-26',
        subType: relayEval.subType,
        relayState: relayEval.nextState,
        userMessage: relayEval.tailInjection
      };
    }
    sessionMeta.steeredPrompts = Number(sessionMeta.steeredPrompts || 0) + 1;
    return {
      ephemeralMessage: relayEval.tailInjection,
      systemMessage: relayEval.tailInjection,
      detectorId: 'DET-26',
      subType: relayEval.subType,
      relayState: relayEval.nextState
    };
  }

  const scopeOverride = resolveDetectorOverride(horizonConfig, 'vague-prompt-rubric');
  const scopeEval = evaluateScopeBrake({
    prompt: rawPrompt,
    provenance: inputData.provenance || inputData.source || 'user',
    isAutonomousTurn: Boolean(inputData.isAutonomousTurn || inputData.autonomous),
    isSubagent: Boolean(inputData.isSubagent || sessionMeta.isSubagent),
    isScheduledTask: Boolean(inputData.isScheduledTask),
    isLoopIteration: Boolean(inputData.isLoopIteration),
    priorTurnEditedFilesCount: Number(
      inputData.priorTurnEditedFilesCount ??
      (Array.isArray(sessionMeta.lastTurnEditedFiles) ? sessionMeta.lastTurnEditedFiles.length : 0)
    ),
    priorTurnSingleFileTarget: inputData.priorTurnSingleFileTarget ?? sessionMeta.priorTurnSingleFileTarget ?? null,
    priorTurnHadToolOrTestFailure: Boolean(
      inputData.priorTurnHadToolOrTestFailure ??
      sensors.lastTurnToolFailed ??
      sensors.threeStrikeLoop
    ),
    priorTurnAssistantAskedQuestion: Boolean(
      inputData.priorTurnAssistantAskedQuestion ?? sessionMeta.lastTurnAskedQuestion
    ),
    activeSetPaths: fileState.activeSetPaths || [],
    modifiedFiles: fileState.modifiedFiles || [],
    recentlyViewedFiles: fileState.recentlyViewedFiles || [],
    overrideMode: scopeOverride,
    flightMode,
    detectorId: 'DET-26'
  });
  if (scopeEval.triggered) {
    sessionMeta.unanchoredTurnFlag = true;
    sidecar.sessionMeta = sessionMeta;
    try {
      writeSidecarAtomicSync(conversationId, sidecar);
    } catch (err) {
      recordHookDiagnostic('pre_invocation', 'scopeBrake.writeSidecar', err);
    }
    if (scopeEval.decision === 'block') {
      sessionMeta.blockedPrompts = Number(sessionMeta.blockedPrompts || 0) + 1;
      return {
        terminationBehavior: 'terminate',
        decision: 'block',
        detectorId: 'DET-26',
        subType: scopeEval.subType,
        userMessage: scopeEval.blockReason
      };
    }
    sessionMeta.steeredPrompts = Number(sessionMeta.steeredPrompts || 0) + 1;
    return {
      ephemeralMessage: scopeEval.steerContext,
      systemMessage: scopeEval.steerContext,
      detectorId: 'DET-26',
      subType: scopeEval.subType,
      candidateFiles: scopeEval.candidateFiles
    };
  }
  sessionMeta.unanchoredTurnFlag = false;

  // 8b. HALT_REWRITE_SCORECARD (Explicit #check or Cold Session Vague Multi-File Prompt)
  const isColdSession = turnCount <= (config.cold_session_max_turns || 3);
  const promptSufficiency = scorePromptSufficiency(rawPrompt, { activeSetPaths: fileState.activeSetPaths });
  const isArchitecturalVague = promptSufficiency.score <= 4 &&
    /\b(refactor|rewrite|rearchitect|migrate|overhaul|redesign)\s+(?:the\s+)?[a-z0-9_-]+\s+(?:pipeline|system|architecture|service|subsystem|layer|workflow|engine)\b/i.test(rawPrompt);
  const isVagueMultiFile = (/(refactor everything|fix all|update the whole project|caching)/i.test(rawPrompt) || isArchitecturalVague) && !rawPrompt.includes('@');

  // Ground rule: "Short prompts are not bad by default" - concise scoped instructions shouldn't trigger vague halt
  if (hasCheckTag || (isColdSession && isVagueMultiFile && (!promptSufficiency.shortPrompt || isArchitecturalVague))) {
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
    const vagueRes = applyHabitOverride('vague-prompt-rubric', 'REWRITE_SCORECARD', card);
    // `#check` is the user asking for the scorecard instead of a run, so its stop is kept in COACH.
    if (vagueRes && hasCheckTag && vagueRes.terminationBehavior === 'terminate') vagueRes.userRequested = true;
    if (vagueRes) {
      if (!vagueRes.terminationBehavior && vagueRes.decision !== 'block') flushSidecarOnce();
      return vagueRes;
    }
  }

  const hasTurn1Workspace = Boolean(
    inputData.cwd ||
      inputData.workspacePath ||
      (Array.isArray(inputData.workspacePaths) && inputData.workspacePaths.length > 0) ||
      inputData.enableTurn1Contract
  );
  if (hasTurn1Workspace && resolveDetectorOverride(horizonConfig, 'turn1-contract-gate') !== 'off') {
    const contractEval = evaluateTurn1ContractGate({
      prompt: rawPrompt,
      provenance: inputData.provenance || inputData.source || 'user',
      isAutonomousTurn: Boolean(inputData.isAutonomousTurn || inputData.autonomous),
      isSubagent: Boolean(inputData.isSubagent || sessionMeta.isSubagent),
      isScheduledTask: Boolean(inputData.isScheduledTask),
      isLoopIteration: Boolean(inputData.isLoopIteration),
      inPlanMode: Boolean(sessionMeta.inPlanMode || inputData.inPlanMode),
      turnNumber: effectiveTurnNumber,
      invocationNum: Number(inputData.invocationNum ?? 1),
      alreadyInjected: Boolean(sessionMeta.turn1ContractInjected),
      hasActiveSetMatch,
      sufficiency: promptSufficiency,
      overrideMode: resolveDetectorOverride(horizonConfig, 'turn1-contract-gate'),
      flightMode,
      detectorId: 'DET-26'
    });
    if (contractEval.triggered) {
      sessionMeta.turn1ContractInjected = true;
      sessionMeta.lastUserPrompt = rawPrompt;
      sidecar.sessionMeta = sessionMeta;
      try {
        writeSidecarAtomicSync(conversationId, sidecar);
      } catch (err) {
        recordHookDiagnostic('pre_invocation', 'turn1Contract.writeSidecar', err);
      }
      return {
        ephemeralMessage: contractEval.contractDirective,
        systemMessage: contractEval.contractDirective,
        detectorId: 'DET-26',
        subType: contractEval.subType
      };
    }
  }

  if (rawPrompt && (inputData.cwd || inputData.workspacePath)) {
    sessionMeta.lastUserPrompt = rawPrompt;
    sidecar.sessionMeta = sessionMeta;
  }

  if (rawPrompt && inputData.bucketBShadow !== false) {
    try {
      const isAutonomousOrSubagent = Boolean(
        inputData.isAutonomousTurn ||
          inputData.autonomous ||
          inputData.isSubagent ||
          sessionMeta.isSubagent ||
          inputData.isScheduledTask ||
          inputData.isLoopIteration ||
          /^(?:scheduled|cron|loop|subagent|agent_callback|callback|auto|autonomous|background|system|hook|task_notification|wake)$/i.test(
            String(inputData.provenance || inputData.source || '')
          )
      );
      const cachedDirtyFiles = Array.isArray(inputData.cachedDirtyFiles)
        ? inputData.cachedDirtyFiles
        : [
            ...(fileState.modifiedFiles || []),
            ...(Array.isArray(fileState.unverifiedEdits)
              ? fileState.unverifiedEdits.map((e) => e?.filePath)
              : [])
          ];
      const promptAnchor = runBucketBPromptPass({
        platform: 'antigravity',
        sessionId: conversationId,
        cwd: workspacePath,
        hasExplicitCwd: Boolean(inputData.cwd || inputData.workspacePath),
        prompt: rawPrompt,
        isAutonomousOrSubagent,
        cachedDirtyFiles,
        lastFailingLocation:
          inputData.lastFailingLocation ?? sessionMeta.lastFailingLocation ?? '',
        options: {
          bucketBStage: inputData.bucketBStage,
          bucketBGammaStage: inputData.bucketBGammaStage,
          mode: flightMode,
          horizonConfig
        }
      });
      if (promptAnchor.triggered) {
        flushSidecarOnce();
        return {
          ephemeralMessage: promptAnchor.reason,
          systemMessage: promptAnchor.reason,
          anchorContext: promptAnchor.anchorContext,
          detectorId: 'VAGUE_PROMPT_ANCHOR'
        };
      }
    } catch (err) {
      recordHookDiagnostic('pre_invocation', 'handlePreInvocation.bucketBPromptPass', err, { persist: false });
    }
  }

  // OPT-4A: Idle-TTL Pre-Compact Gate when resuming after expired (>5m/>1h) cache on >=60k context
  const nowIdleCheckMs = Number(inputData.nowMs ?? Date.now());
  const priorPromptTs = Number(inputData.lastTurnTimestampMs ?? sessionMeta.lastPromptTimestampMs ?? 0);
  const idleGapMs =
    inputData.idleGapMs !== undefined
      ? Math.max(0, Number(inputData.idleGapMs) || 0)
      : priorPromptTs > 0
        ? Math.max(0, nowIdleCheckMs - priorPromptTs)
        : 0;
  const idleGate = getSmartCompactMod().evaluateIdleTtlPreCompactGate(
    {
      enabled:
        inputData.idlePreCompactGate ??
        horizonConfig?.thresholds?.idlePreCompactGate ??
        true,
      idleGapMs,
      contextTokens: Number(
        inputData.contextTokens ??
          inputData.context_tokens ??
          inputData.cachedTokens ??
          sidecar.telemetry?.cachedTokens ??
          sidecar.telemetry?.totalInputTokens ??
          0
      ),
      modelId:
        inputData.modelName ||
        inputData.model ||
        sessionMeta.active_model_id ||
        sessionMeta.activeModel ||
        'claude-sonnet-5-5',
      cacheTtlTier: inputData.cacheTtlTier || '5m',
      turnsSinceLastCompact:
        inputData.turnsSinceLastCompact ?? sessionMeta.turnsSinceLastCompact ?? null,
      promptText: rawPrompt
    },
    { horizonConfig }
  );
  const recentlyIdleAlerted =
    Number(sessionMeta.lastIdleCompactAlertTs || 0) > 0 &&
    Math.abs(nowIdleCheckMs - Number(sessionMeta.lastIdleCompactAlertTs)) < 60_000;
  sessionMeta.lastPromptTimestampMs = nowIdleCheckMs;
  sidecar.sessionMeta = sessionMeta;

  if (idleGate.shouldSuggest && !recentlyIdleAlerted) {
    sessionMeta.lastIdleCompactAlertTs = nowIdleCheckMs;
    sidecar.sessionMeta = sessionMeta;
    flushSidecarOnce();
    return {
      decision: 'allow',
      detectorId: 'DET-08',
      subType: 'IDLE_TTL_PRE_COMPACT',
      idlePreCompactSuggestion: idleGate,
      ephemeralMessage: idleGate.message,
      systemMessage: idleGate.message
    };
  }

  flushSidecarOnce();
  return {};
}

/**
 * Sanitizes internal hook return payloads into strict Antigravity protojson-compatible
 * CLI stdout objects (no unknown fields like flightMode, active_model_id, swarmTtlBadges).
 */
export function toProtoSafePreHookOutput(output, { isPreToolUse = false } = {}) {
  const out = output && typeof output === 'object' ? output : {};
  if (isPreToolUse) {
    const rawDecision = String(out.decision || '').toLowerCase();
    let decision = 'allow';
    if (rawDecision === 'deny' || rawDecision === 'block' || out.blocked === true || out.terminationBehavior === 'terminate') {
      decision = 'deny';
    } else if (rawDecision === 'ask') {
      decision = 'ask';
    }
    const reasonText = out.reason || out.errorMessage?.userMessage || out.userMessage || out.systemMessage || out.ephemeralMessage;
    if (decision !== 'allow' && reasonText) {
      return { decision, reason: String(reasonText) };
    }
    return { decision };
  }

  if (out.terminationBehavior === 'terminate') {
    const userMessage = String(
      out.errorMessage?.userMessage ||
      out.userMessage ||
      out.reason ||
      out.systemMessage ||
      'Halted by Highbeam Flightcheck'
    );
    // Documented Antigravity PreInvocation stop: https://antigravity.google/docs/hooks
    return {
      injectSteps: [{ errorMessage: { userMessage } }],
      terminationBehavior: 'terminate'
    };
  }
  const advisory = out.ephemeralMessage || out.systemMessage;
  if (typeof advisory === 'string' && advisory.trim().length > 0) {
    return { ephemeralMessage: advisory };
  }
  return {};
}

