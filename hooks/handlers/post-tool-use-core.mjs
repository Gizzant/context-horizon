/**
 * @file hooks/handlers/post-tool-use-core.mjs
 * Full evaluation engine for `PostToolUse` (`Bash|PowerShell|Grep|Glob|Task|Agent|WebFetch|mcp__.*`).
 * Runs lossless output sanitization, 100% critical error-line recovery,
 * >4,000 token programmatic artifact offloading (excluding workspace `Read`),
 * and `DET-19` subagent IPI boundary & Unicode tag stripping (`ISS-034`, `ISS-053`).
 */

import { createRequire } from 'node:module';
import { sanitizePostToolOutput } from '../../src/core-isomorphic/guards/losslessPostSanitizer.mjs';
import {
  CircuitBreakerEngine,
  evaluateDet19SubagentIpiSanitizer,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { evaluateTaskBoundaryTurn } from '../../src/core-isomorphic/coach/smartCompactAdvisor.mjs';
import { runBucketBPostToolPass } from '../../src/core/bucket_b_runtime.mjs';

const requireFromHere = createRequire(import.meta.url);
const AUTO_MODE_ALIAS_RE = /^(?:AUTO_PILOT|AUTOPILOT|AUTO|AUTO-PILOT)$/i;
const RSL_MUTATING_OR_EXEC_TOOL_RE =
  /^(?:Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|run_command|execute_bash|bash|powershell|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|edit|multiedit|multi_edit|write|notebookedit)$/i;

let _proLicenseMod = null;
function getProLicenseMod() {
  if (!_proLicenseMod) _proLicenseMod = requireFromHere('../../src/core/pro_license.mjs');
  return _proLicenseMod;
}

let _microSkillsMod = null;
function getMicroSkillsMod() {
  if (!_microSkillsMod) _microSkillsMod = requireFromHere('../../src/core-isomorphic/coach/microSkills.mjs');
  return _microSkillsMod;
}

let _savedQuotaMod = null;
function getSavedQuotaMod() {
  if (!_savedQuotaMod) _savedQuotaMod = requireFromHere('../../src/core-isomorphic/coach/savedQuotaLedger.mjs');
  return _savedQuotaMod;
}

let _telemetryMod = null;
function getTelemetryMod() {
  if (!_telemetryMod) _telemetryMod = requireFromHere('../../src/core-isomorphic/telemetry/telemetryBridge.mjs');
  return _telemetryMod;
}

let _catalogMod = null;
function getCatalogMod() {
  if (!_catalogMod) _catalogMod = requireFromHere('../../src/core-isomorphic/config/catalogLoader.mjs');
  return _catalogMod;
}

let _claudeRslMod = null;
function getClaudeRslMod() {
  if (!_claudeRslMod) _claudeRslMod = requireFromHere('../../src/hooks/claude_rsl_hook.mjs');
  return _claudeRslMod;
}

function resolveSimpleFlightMode(rawMode = 'COACH') {
  const upper = String(rawMode || 'COACH').trim().toUpperCase();
  if (upper === 'OFF' || upper === 'DISABLED') return 'OFF';
  if (upper === 'SILENT') return 'SILENT';
  return 'COACH';
}

/**
 * Extracts text from a string or structured `tool_response` object.
 * @param {object} event
 * @returns {string}
 */
function extractPostToolText(event = {}) {
  const resp = event.tool_response ?? event.tool_output ?? event.toolOutput ?? event.output;
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const parts = [resp.stdout, resp.stderr, resp.output, resp.content, resp.error]
      .filter((x) => typeof x === 'string' && x.length > 0);
    if (parts.length > 0) return parts.join('\n');
    return '';
  }
  return resp !== undefined && resp !== null ? String(resp) : '';
}

/**
 * Determines whether a completed tool call failed (`is_error`, non-zero `exit_code`, etc.).
 * @param {object} event
 * @returns {boolean}
 */
function didToolExecutionFail(event = {}) {
  if (
    event.is_error === true ||
    event.isError === true ||
    event.succeeded === false ||
    Boolean(event.tool_error || event.error) ||
    (typeof event.exit_code === 'number' && event.exit_code !== 0) ||
    (typeof event.exitCode === 'number' && event.exitCode !== 0)
  ) {
    return true;
  }
  const resp = event.tool_response;
  if (resp && typeof resp === 'object') {
    if (
      resp.is_error === true ||
      resp.isError === true ||
      resp.succeeded === false ||
      resp.status === 'error' ||
      resp.status === 'failed' ||
      Boolean(resp.error) ||
      (typeof resp.exit_code === 'number' && resp.exit_code !== 0) ||
      (typeof resp.exitCode === 'number' && resp.exitCode !== 0) ||
      (typeof resp.returncode === 'number' && resp.returncode !== 0)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates a `PostToolUse` hook payload and returns the contract response.
 * @param {object} event
 * @param {object} [options={}]
 */
export function runPostToolUseHook(event = {}, options = {}) {
  const toolName = String(event.tool_name || event.toolName || 'Bash');
  const rawOutput = extractPostToolText(event);
  const tier1Active = Boolean(
    options.tier1ModActive ||
    event.tier1ModActive ||
    globalThis.process?.env?.AH_TIER1_MOD_ACTIVE === '1'
  );
  if (tier1Active && /^(Grep|Glob)$/i.test(toolName) && rawOutput.length < 16000 && !didToolExecutionFail(event)) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      fastPath: 'tier1_mod_active',
      sanitized: { modified: false, offloaded: false }
    };
  }
  const sessionId = event.session_id || event.sessionId || 'default';
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
  const rawMode = event.mode || options.mode || horizonConfig.flightMode || 'COACH';
  const effectiveMode = AUTO_MODE_ALIAS_RE.test(String(rawMode || '').trim())
    ? getProLicenseMod().resolveEffectiveAutoFlightMode(rawMode, {
        licensePath: options.licensePath || event.licensePath,
        homeDir: options.homeDir || event.homeDir,
        nowMs: options.nowMs,
        strict: Boolean(options.strict ?? event.strict)
      }).effectiveFlightMode
    : resolveSimpleFlightMode(rawMode);

  const hasExplicitCwd = Boolean(event.cwd || options.cwd);
  let loadedPriorSnap = null;
  const shouldPersistState =
    options.persistState !== false &&
    Boolean(event.cwd || options.cwd || options.breakerStatePath || options.persistState);

  if (shouldPersistState) {
    if (hasExplicitCwd && options.enableRsl !== false && RSL_MUTATING_OR_EXEC_TOOL_RE.test(toolName)) {
      try {
        getClaudeRslMod().handleClaudeRslHook(event, { ...cwdOptions, event: 'PostToolUse' });
      } catch {
        // Fail open for RSL step telemetry
      }
    }
    const failed = didToolExecutionFail(event);
    const priorSnap = readBreakerStateSnapshot(sessionId, cwdOptions);
    loadedPriorSnap = priorSnap;
    const engine = new CircuitBreakerEngine({
      ...cwdOptions,
      horizonConfig,
      mode: effectiveMode,
      initialState: priorSnap
    });
    const toolInput = event.tool_input || event.toolInput || {};
    const cmdStr = String(toolInput.command || toolInput.cmd || event.command || '');
    const rawExit =
      event.exit_code ??
      event.exitCode ??
      event.tool_response?.exit_code ??
      event.tool_response?.exitCode;
    engine.recordToolOutcome(!failed, toolName);
    if (/^(Bash|PowerShell|pwsh|cmd|sh|run_command|execute_bash)$/i.test(toolName)) {
      engine.recordVerificationOutcome({
        succeeded: !failed,
        command: cmdStr,
        outputText: rawOutput
      });
    }
    if (failed && engine.modifiedFilesInTurn.size > 0) {
      // If a test command failed, code edits remain unverified
      engine.codeEditedSinceLastTest = true;
    }
    const editedPath = String(
      event.tool_input?.file_path ||
        event.tool_input?.Path ||
        event.tool_input?.path ||
        event.tool_input?.TargetFile ||
        ''
    );
    const boundaryEval = evaluateTaskBoundaryTurn(
      {
        toolName,
        command: cmdStr,
        filePath: editedPath,
        failed,
        exitCode: typeof rawExit === 'number' ? rawExit : (failed ? 1 : 0)
      },
      engine.taskBoundaryState
    );
    engine.taskBoundaryState = {
      openFailure: boundaryEval.openFailure,
      editsSinceBoundary: boundaryEval.editsSinceBoundary,
      lastBoundarySuggestedTurn: engine.taskBoundaryState?.lastBoundarySuggestedTurn ?? null
    };
    const nextTurnBoundaryReached =
      boundaryEval.detectorState === 'mid_debug'
        ? false
        : boundaryEval.boundaryDetected
          ? true
          : boundaryEval.editsSinceBoundary > 0 && priorSnap?.turnBoundaryReached
            ? false
            : Boolean(priorSnap?.turnBoundaryReached);
    const nextTurnMidDebug =
      boundaryEval.detectorState === 'mid_debug'
        ? true
        : boundaryEval.boundaryDetected
          ? false
          : Boolean(priorSnap?.turnMidDebug);
    if (Array.isArray(event.active_background_tasks || event.activeBackgroundTasks)) {
      engine.activeBackgroundTasks = (event.active_background_tasks || event.activeBackgroundTasks)
        .filter(Boolean)
        .map((t) => (typeof t === 'string' ? t : String(t?.id || t?.command || 'bg_task')));
    }
    writeBreakerStateSnapshot(
      sessionId,
      {
        ...engine.exportStateSnapshot(),
        turnBoundaryReached: nextTurnBoundaryReached,
        turnMidDebug: nextTurnMidDebug
      },
      cwdOptions
    );

    // RSI-04 ('micro-skills'): Capture shell failure -> recovery pairs within <= 3 turns
    if (/^(Bash|PowerShell|pwsh|cmd|sh)$/i.test(toolName) && resolveDetectorOverride('micro-skills', horizonConfig) !== 'off') {
      if (cmdStr) {
        getMicroSkillsMod().recordWorkspaceShellOutcome(
          {
            command: cmdStr,
            exitCode: typeof rawExit === 'number' ? rawExit : (failed ? 1 : 0),
            turn: Number(event.turnId ?? event.turn_id ?? event.turn ?? 1),
            sessionId: String(sessionId),
            confirmSessions: Number(horizonConfig.thresholds?.microSkillConfirmSessions ?? 2)
          },
          cwdOptions
        );
      }
    }
  }

  if (!loadedPriorSnap && options.bucketBShadow !== false && hasExplicitCwd && /^(?:Grep|Glob)$/i.test(toolName)) {
    loadedPriorSnap = readBreakerStateSnapshot(sessionId, cwdOptions);
  }
  const bAlphaPost =
    options.bucketBShadow === false
      ? { triggered: false, updatedOutput: rawOutput, savedTokens: 0 }
      : runBucketBPostToolPass({
          platform: 'claude',
          sessionId,
          cwd: event.cwd || options.cwd || '',
          hasExplicitCwd,
          toolName,
          toolInput: event.tool_input || event.toolInput || {},
          rawOutput,
          lastUserPrompt: event.prompt || loadedPriorSnap?.lastUserPrompt || '',
          activeFiles: event.activeFiles || loadedPriorSnap?.modifiedFilesInTurn || [],
          dirtyFiles: event.dirtyFiles || [],
          lastEditedFile:
            event.lastEditedFile || (loadedPriorSnap?.modifiedFilesInTurn || []).slice(-1)[0] || '',
          webFetchesInTurn: Number(event.webFetchesInTurn || 1),
          options: {
            ...options,
            mode: effectiveMode,
            horizonConfig
          }
        });

  const effectiveRawOutput = bAlphaPost.triggered ? bAlphaPost.updatedOutput : rawOutput;

  const sanitized = sanitizePostToolOutput(
    {
      toolName,
      toolOutput: effectiveRawOutput
    },
    cwdOptions
  );

  let finalOutput = sanitized.updatedToolOutput;
  let wasModified = sanitized.sanitized || Boolean(bAlphaPost.triggered);

  // Apply DET-19 IPI sanitizer if output comes from a subagent (Task/Agent/agentId) or external WebFetch/MCP tool
  const isSubagentSource =
    Boolean(event.agentId || event.subagentId) || /^(Task|Agent)$/i.test(toolName);
  const isUntrustedSource =
    isSubagentSource || /^(WebFetch|mcp__.+)$/i.test(toolName);

  if (
    isUntrustedSource &&
    finalOutput &&
    resolveDetectorOverride('DET-19', horizonConfig) !== 'off'
  ) {
    const ipi = evaluateDet19SubagentIpiSanitizer({
      text: finalOutput,
      wrapUntrusted: isSubagentSource
    });
    if (ipi.triggered || isSubagentSource) {
      finalOutput = ipi.sanitizedText;
      wasModified = true;
    }
  }

  const totalSavedTokens = sanitized.savedTokens + Number(bAlphaPost.savedTokens || 0);
  if (
    totalSavedTokens > 0 &&
    options.recordLedger !== false &&
    (sanitized.savedTokens > 0 || hasExplicitCwd || options.ledgerPath || options.recordLedger === true)
  ) {
    const liveState = options.telemetryState || getTelemetryMod().readLiveStateSnapshot(sessionId, cwdOptions);
    const rawEventModel =
      typeof event.model === 'string'
        ? event.model
        : event.model?.id || event.model?.model_id || event.modelId || event.model_id;
    const modelId = rawEventModel || liveState?.modelId || 'claude-sonnet-5-5';
    const usageSource =
      event.usage || event.context_window?.current_usage || liveState?.contextWindow || {};
    const { computeTotalPromptTokens, resolveEffectiveRates } = getCatalogMod();
    const totalPromptTokens = computeTotalPromptTokens(usageSource);
    const rates = resolveEffectiveRates(modelId, totalPromptTokens, cwdOptions);
    const computedSavedUSD =
      rates && !rates.unknownModel && Number.isFinite(rates.inputPer1M)
        ? Number(((totalSavedTokens / 1_000_000) * rates.inputPer1M).toFixed(6))
        : 0;

    getSavedQuotaMod().recordSavingsReceipt(
      {
        sessionId,
        modelId: rates.unknownModel ? (rates.rawModelId || modelId) : rates.modelId,
        category: sanitized.offloaded
          ? 'ARTIFACT_OFFLOAD_4K'
          : sanitized.savedTokens > 0
            ? 'LOSSLESS_POST_SANITIZER'
            : bAlphaPost.code || 'BUCKET_B_POST_SHIELD',
        savedTokens: totalSavedTokens,
        savedUSD: computedSavedUSD,
        detail: `${toolName} output compressed (+${totalSavedTokens} tokens saved)`
      },
      cwdOptions
    );
  }

  if (!wasModified) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      sanitized
    };
  }

  // ISS-034: updatedMCPToolOutput applies strictly to MCP tools; built-in tools use additionalContext!
  const isMcpTool = /^mcp__/i.test(toolName);
  const hookSpecificOutput = isMcpTool
    ? {
        hookEventName: 'PostToolUse',
        updatedMCPToolOutput: finalOutput
      }
    : {
        hookEventName: 'PostToolUse',
        additionalContext: finalOutput
      };

  return {
    exitCode: 0,
    stdout: JSON.stringify({ hookSpecificOutput }),
    stderr: '',
    sanitized,
    hookSpecificOutput
  };
}
