/**
 * @file hooks/handlers/post-tool-use.mjs
 * Tier 2 Command Hook handler for `PostToolUse` (`Bash|PowerShell|Grep|Glob|Task|Agent|WebFetch|mcp__.*`).
 * Runs lossless output sanitization, 100% critical error-line recovery,
 * >4,000 token programmatic artifact offloading (excluding workspace `Read`),
 * and `DET-19` subagent IPI boundary & Unicode tag stripping (`ISS-034`, `ISS-053`).
 */

import { sanitizePostToolOutput } from '../../src/core-isomorphic/guards/losslessPostSanitizer.mjs';
import {
  CircuitBreakerEngine,
  evaluateDet19SubagentIpiSanitizer,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { recordWorkspaceShellOutcome } from '../../src/core-isomorphic/coach/microSkills.mjs';
import { recordSavingsReceipt } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { resolveEffectiveRates, computeTotalPromptTokens } from '../../src/core-isomorphic/config/catalogLoader.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitWithStdoutJson
} from './hookIo.mjs';

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

  const shouldPersistState =
    options.persistState !== false &&
    Boolean(event.cwd || options.cwd || options.breakerStatePath || options.persistState);

  if (shouldPersistState) {
    const failed = didToolExecutionFail(event);
    const priorSnap = readBreakerStateSnapshot(sessionId, cwdOptions);
    const engine = new CircuitBreakerEngine({
      ...cwdOptions,
      horizonConfig,
      mode: event.mode || options.mode || horizonConfig.flightMode || 'COACH',
      initialState: priorSnap
    });
    engine.recordToolOutcome(!failed, toolName);
    if (failed && engine.modifiedFilesInTurn.size > 0) {
      // If a test command failed, code edits remain unverified
      engine.codeEditedSinceLastTest = true;
    }
    writeBreakerStateSnapshot(sessionId, engine.exportStateSnapshot(), cwdOptions);

    // RSI-04 ('micro-skills'): Capture shell failure -> recovery pairs within <= 3 turns
    if (/^(Bash|PowerShell|pwsh|cmd|sh)$/i.test(toolName) && resolveDetectorOverride('micro-skills', horizonConfig) !== 'off') {
      const toolInput = event.tool_input || event.toolInput || {};
      const cmdStr = String(toolInput.command || toolInput.cmd || event.command || '');
      if (cmdStr) {
        const rawExit =
          event.exit_code ??
          event.exitCode ??
          event.tool_response?.exit_code ??
          event.tool_response?.exitCode;
        recordWorkspaceShellOutcome(
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

  const sanitized = sanitizePostToolOutput(
    {
      toolName,
      toolOutput: rawOutput
    },
    cwdOptions
  );

  let finalOutput = sanitized.updatedToolOutput;
  let wasModified = sanitized.sanitized;

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

  if (sanitized.savedTokens > 0 && options.recordLedger !== false) {
    const liveState = options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions);
    const rawEventModel =
      typeof event.model === 'string'
        ? event.model
        : event.model?.id || event.model?.model_id || event.modelId || event.model_id;
    const modelId = rawEventModel || liveState?.modelId || 'claude-sonnet-5-5';
    const usageSource =
      event.usage || event.context_window?.current_usage || liveState?.contextWindow || {};
    const totalPromptTokens = computeTotalPromptTokens(usageSource);
    const rates = resolveEffectiveRates(modelId, totalPromptTokens, cwdOptions);

    recordSavingsReceipt(
      {
        sessionId,
        modelId: rates.modelId,
        category: sanitized.offloaded ? 'ARTIFACT_OFFLOAD_4K' : 'LOSSLESS_POST_SANITIZER',
        savedTokens: sanitized.savedTokens,
        savedUSD: Number(((sanitized.savedTokens / 1_000_000) * rates.inputPer1M).toFixed(6)),
        detail: `${toolName} output compressed (${sanitized.originalTokens} -> ${sanitized.finalTokens} tokens)`
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

/**
 * CLI runner for `PostToolUse` (`ISS-035`).
 * Non-blocking post hook: logs diagnostic to stderr and exits `0` on uncaught error.
 *
 * @param {object} [cliOptions={}]
 */
export async function executePostToolUseCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runPostToolUseHook;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const payload = await readPayload(cliOptions.timeoutMs);
    const res = runHook(payload, { persistState: true, ...(cliOptions.hookOptions || {}) });
    if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitDiagnosticZero(err?.message || String(err), 'PostToolUse', ioOverride);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executePostToolUseCli().catch((err) => {
    exitDiagnosticZero(err?.message || String(err), 'PostToolUse');
  });
}
