/**
 * @file hooks/handlers/compact-lifecycle.mjs
 * Tier 2 Command Hook handler for `PreCompact`, `SessionStart[compact|resume|startup|clear|fork]`,
 * and `PostCompact` (`ISS-034`, `ISS-035`, `ISS-036`).
 */

import {
  handlePreCompactBatonFlush,
  handleSessionStartHydration,
  handlePostCompactFlush
} from '../../src/core-isomorphic/coach/stateBatonHydrator.mjs';
import {
  evaluateDet17AutoCompactionDeferral,
  readBreakerStateSnapshot,
  writeBreakerStateSnapshot
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { isSilentOrOffMode } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  computeActiveToolsetHash,
  evaluateResumeToolsetChange
} from '../../src/core-isomorphic/coach/resumeToolsetAuditor.mjs';
import { readLiveStateSnapshot } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { loadMicroSkillsRegistry, formatMicroSkillsBatonSnippet } from '../../src/core-isomorphic/coach/microSkills.mjs';
import { readTextSafe, resolvePath, getCwd } from '../../src/core-isomorphic/utils/runtime.mjs';
import { inspectClaudeBinaryCapabilities } from '../../src/diagnostics/claudeHookCapabilities.mjs';
import {
  auditClaudeIdleDrainSettings,
  auditClaudeAgentAutoCompactWindows,
  auditClaudeAutoMemory,
  snapshotWorkspaceTestHashes
} from '../../src/core/shield_manager.mjs';
import { handleClaudeRslHook } from '../../src/hooks/claude_rsl_hook.mjs';
import { evaluateGeminiThinkingTimeoutRisk } from '../../src/core-isomorphic/economics/driftLatency.mjs';
import {
  isCliEntrypoint,
  readStdinJsonAsync,
  exitPassThrough,
  exitDiagnosticZero,
  exitWithStdoutJson
} from './hookIo.mjs';

/**
 * Scans workspace instruction files (CLAUDE.md, .claude/CLAUDE.md, AGENTS.md)
 * for token bloat (>4k tokens or >200 lines) and direct rule contradictions.
 *
 * @param {string} [cwd='']
 * @param {object} [options={}]
 * @returns {object}
 */
export function auditWorkspaceClaudeMd(cwd = '', options = {}) {
  const root = cwd || getCwd(options);
  const candidateFiles = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md'];
  let totalTokens = 0;
  let totalLines = 0;
  const foundFiles = [];
  const polarContradictions = [];

  for (const rel of candidateFiles) {
    const full = resolvePath(root, rel);
    const content = readTextSafe(full, null, options);
    if (typeof content === 'string' && content.length > 0) {
      foundFiles.push(rel);
      const lines = content.split(/\r?\n/).length;
      totalLines += lines;
      const tokens = Math.ceil(content.length / 3.8);
      totalTokens += tokens;

      if (
        /always\s+use\s+(?:tabs|spaces)\b/i.test(content) &&
        /never\s+use\s+(?:tabs|spaces)\b/i.test(content)
      ) {
        polarContradictions.push('tabs vs spaces contradiction');
      }
      if (
        /always\s+use\s+default\s+exports\b/i.test(content) &&
        /never\s+use\s+default\s+exports\b/i.test(content)
      ) {
        polarContradictions.push('Always vs NEVER use Default Exports contradiction');
      }
      if (
        /always\s+use\s+semicolons\b/i.test(content) &&
        /never\s+use\s+semicolons\b/i.test(content)
      ) {
        polarContradictions.push('Always vs NEVER use semicolons contradiction');
      }
    }
  }

  const isBloated = totalTokens > 4000 || totalLines > 200 || polarContradictions.length > 0;
  if (!isBloated) {
    return { triggered: false };
  }

  const reasons = [];
  if (totalTokens > 4000 || totalLines > 200) {
    reasons.push(`Rules file bloat: ${Math.round(totalTokens / 1000)}k tokens across ${totalLines} lines (>4k tokens / >200 lines cap)`);
  }
  if (polarContradictions.length > 0) {
    reasons.push(`Contradictions detected: ${polarContradictions.join('; ')}`);
  }

  const advisory = `[DET-09 / RSI-01 Static Rule Bloat Advisory] ${reasons.join('. ')}. Prune stale conventions or extract domain skills via /compact.`;

  return {
    triggered: true,
    totalTokens,
    totalLines,
    foundFiles,
    polarContradictions,
    advisory
  };
}

/**
 * Evaluates a compaction / session-start lifecycle event (`pre`, `start`, or `post`).
 * @param {object} event
 * @param {object} [options={}]
 */
export function runCompactLifecycleHook(event = {}, options = {}) {
  const inferredPhase =
    event.hook_event_name === 'SessionStart'
      ? 'start'
      : event.hook_event_name === 'PostCompact'
        ? 'post'
        : event.hook_event_name === 'InstructionsLoaded'
          ? 'instructions'
          : event.hook_event_name === 'WorktreeCreate'
            ? 'worktree'
            : 'pre';
  const phase = String(options.phase || event.phase || inferredPhase).toLowerCase();
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;
  const sessionId = event.session_id || event.sessionId || 'default';

  if (phase === 'instructions' || event.hook_event_name === 'InstructionsLoaded') {
    const cwd = event.cwd || cwdOptions.cwd || '';
    const ruleAudit = auditWorkspaceClaudeMd(cwd, cwdOptions);
    const memoryAudit = auditClaudeAutoMemory({
      cwd: cwd || process.cwd(),
      homeDir: cwdOptions.homeDir,
      memoryDir: event.memoryDir || cwdOptions.memoryDir,
      memoryFilePath: event.memoryFilePath || cwdOptions.memoryFilePath
    });
    const agentCliffAudit = cwd ? auditClaudeAgentAutoCompactWindows({ cwd }) : { triggered: false };
    const blocks = [];
    if (ruleAudit.triggered) blocks.push(ruleAudit.advisory);
    if (memoryAudit.triggered) blocks.push(memoryAudit.advisory);
    if (agentCliffAudit.triggered) blocks.push(agentCliffAudit.advisory);
    if (blocks.length > 0) {
      const stdoutJson = {
        hookSpecificOutput: {
          hookEventName: 'InstructionsLoaded',
          additionalContext: blocks.join('\n\n')
        }
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(stdoutJson),
        stdoutJson,
        stderr: '',
        result: { ruleAudit, memoryAudit, agentCliffAudit }
      };
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      result: { ruleAudit, memoryAudit, agentCliffAudit }
    };
  }

  if (phase === 'worktree' || event.hook_event_name === 'WorktreeCreate') {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      result: {
        ok: true,
        hookEventName: 'WorktreeCreate',
        passThrough: true
      }
    };
  }

  if (phase === 'pre' || event.hook_event_name === 'PreCompact') {
    const det17 = evaluateDet17AutoCompactionDeferral({
      trigger: event.trigger || 'auto',
      midBatchEditInProgress: Boolean(event.midBatchEditInProgress),
      unbalancedSyntaxDetected: Boolean(event.unbalancedSyntaxDetected),
      cacheExpired: Boolean(event.cacheExpired),
      cachedTokens: Number(event.cachedTokens ?? event.cached_tokens ?? 0)
    });
    if (det17.triggered) {
      // ISS-034: Never emit invalid hookSpecificOutput.permissionDecision on PreCompact!
      const stdoutJson = {
        decision: 'block',
        reason: det17.reason
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(stdoutJson),
        stdoutJson,
        stderr: '',
        result: det17
      };
    }

    const flushRes = handlePreCompactBatonFlush(event, cwdOptions);
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      result: flushRes
    };
  }

  if (phase === 'start' || event.hook_event_name === 'SessionStart') {
    const hydration = handleSessionStartHydration(event, cwdOptions);
    const cwd = event.cwd || cwdOptions.cwd || '';
    const ruleAudit = auditWorkspaceClaudeMd(cwd, cwdOptions);
    const memoryAudit = auditClaudeAutoMemory({
      cwd: cwd || process.cwd(),
      homeDir: cwdOptions.homeDir,
      memoryDir: event.memoryDir || cwdOptions.memoryDir,
      memoryFilePath: event.memoryFilePath || cwdOptions.memoryFilePath
    });
    const agentCliffAudit = cwd ? auditClaudeAgentAutoCompactWindows({ cwd }) : { triggered: false };
    const idleDrainAudit = cwd ? auditClaudeIdleDrainSettings({ cwd }) : { triggered: false };
    const thinkingTimeoutAudit = evaluateGeminiThinkingTimeoutRisk({
      modelId: event.model || event.modelId || '',
      maxOutputTokens: event.maxOutputTokens ?? event.max_output_tokens ?? 0,
      thinkingBudget: event.thinkingBudget ?? event.thinking_budget ?? 0,
      timeoutMs: event.timeoutMs ?? event.timeout_ms ?? 0
    });
    const testHashSnapshot =
      cwd && options.snapshotTestHashes !== false
        ? snapshotWorkspaceTestHashes({ cwd, sessionId })
        : null;
    if (cwd && options.persistState !== false && options.enableRsl !== false && !testHashSnapshot) {
      try {
        handleClaudeRslHook(event, { ...cwdOptions, event: 'SessionStart' });
      } catch {
        // Fail open for RSL baseline capture
      }
    }
    const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
    const effectiveMode = event.mode || options.mode || horizonConfig?.flightMode || 'COACH';
    const sessionStartSource = String(event.source || event.trigger || '').toLowerCase();
    const shouldPersistState =
      options.persistState !== false &&
      Boolean(event.cwd || cwdOptions.cwd || options.breakerStatePath || options.cliInvocation);

    let compactSystemMessage = null;
    let resumeSystemMessage = null;
    let resumeToolsetAudit = null;
    let surfacedPendingDownshift = null;
    const priorSnap =
      sessionStartSource === 'compact' || sessionStartSource === 'resume' || shouldPersistState
        ? readBreakerStateSnapshot(sessionId, cwdOptions)
        : null;
    const currentToolsetHash =
      event.cwd || cwdOptions.cwd || event.tools || event.mcp_servers || options.cliArgs || event.cliArgs
        ? computeActiveToolsetHash(event, cwdOptions)
        : null;

    if (sessionStartSource === 'compact') {
      const explicitPending = event.pending_downshift_model || event.pendingDownshiftModel || null;
      const pendingRecord =
        priorSnap?.pending_downshift ||
        (priorSnap?.pendingDownshiftModel
          ? {
              fromModel: priorSnap.lastModelId || null,
              toModel: priorSnap.pendingDownshiftModel,
              recordedAt: null
            }
          : null) ||
        (explicitPending ? { fromModel: null, toModel: String(explicitPending), recordedAt: null } : null) ||
        (Array.isArray(priorSnap?.queuedMutations)
          ? (() => {
              const m = priorSnap.queuedMutations.find((x) => x && x.type === 'model' && x.value);
              return m ? { fromModel: priorSnap.lastModelId || null, toModel: String(m.value), recordedAt: null } : null;
            })()
          : null);

      if (shouldPersistState) {
        writeBreakerStateSnapshot(
          sessionId,
          {
            ...(priorSnap || {}),
            updatedAt: Date.now(),
            justCompacted: true,
            turnsSinceLastCompact: 0,
            taskBoundaryState: {
              openFailure: false,
              editsSinceBoundary: 0,
              lastBoundarySuggestedTurn: null
            },
            ...(currentToolsetHash ? { lastToolsetHash: currentToolsetHash } : {}),
            pending_downshift: null,
            pendingDownshiftModel: null,
            queuedMutations: []
          },
          cwdOptions
        );
      }

      if (pendingRecord?.toModel && !isSilentOrOffMode(effectiveMode)) {
        surfacedPendingDownshift = pendingRecord;
        const pairLabel = pendingRecord.fromModel
          ? ` (${pendingRecord.fromModel} -> ${pendingRecord.toModel})`
          : '';
        // Verified at $0 on claude.exe@2.1.325: SessionStart:compact systemMessage displays
        // notice to user with 0 tokens injected into post-compaction /v1/messages wire requests.
        compactSystemMessage =
          `[Highbeam] Compaction cleared the large warm cache; run /model ${pendingRecord.toModel} ` +
          `to apply held downshift${pairLabel} without rewriting the pre-compact prefix (H6).`;
      }
    } else if (sessionStartSource === 'resume' && currentToolsetHash) {
      const liveForResume =
        event.context_tokens !== undefined || priorSnap?.lastContextTokens !== undefined
          ? null
          : (options.telemetryState || readLiveStateSnapshot(sessionId, cwdOptions));
      const resumeContextTokens = Number(
        event.context_tokens ??
          event.contextTokens ??
          event.cached_tokens ??
          event.cachedTokens ??
          priorSnap?.lastContextTokens ??
          liveForResume?.contextWindow?.cachedTokens ??
          0
      );
      const resumeCacheExpired = Boolean(
        event.prompt_cache_likely_expired ??
          event.cacheExpired ??
          liveForResume?.promptCache?.expired
      );
      const resumeModelId = String(
        event.model ||
          event.modelId ||
          priorSnap?.lastModelId ||
          liveForResume?.modelId ||
          'claude-sonnet-5-5'
      );
      resumeToolsetAudit = evaluateResumeToolsetChange(
        {
          previousHashRecord: priorSnap?.lastToolsetHash || null,
          currentHashRecord: currentToolsetHash,
          contextTokens: resumeContextTokens,
          cacheExpired: resumeCacheExpired,
          modelId: resumeModelId,
          cacheTtlTier: liveForResume?.promptCache?.ttlTier === '1h' ? '1h' : '5m',
          minContextTokens: Number(horizonConfig?.thresholds?.resumeToolsetWarnMinTokens ?? 10_000)
        },
        cwdOptions
      );
      if (
        resumeToolsetAudit.shouldWarn &&
        resumeToolsetAudit.advisory &&
        !isSilentOrOffMode(effectiveMode)
      ) {
        resumeSystemMessage = resumeToolsetAudit.advisory;
      }
      if (shouldPersistState) {
        writeBreakerStateSnapshot(
          sessionId,
          {
            ...(priorSnap || {}),
            updatedAt: Date.now(),
            lastToolsetHash: currentToolsetHash,
            ...(resumeContextTokens > 0 ? { lastContextTokens: resumeContextTokens } : {}),
            ...(resumeModelId ? { lastModelId: resumeModelId } : {})
          },
          cwdOptions
        );
      }
    } else if (shouldPersistState && currentToolsetHash) {
      writeBreakerStateSnapshot(
        sessionId,
        {
          ...(priorSnap || {}),
          updatedAt: Date.now(),
          lastToolsetHash: currentToolsetHash
        },
        cwdOptions
      );
    }

    let microSkillsBaton = '';
    if (resolveDetectorOverride('micro-skills', horizonConfig) !== 'off') {
      const msReg = loadMicroSkillsRegistry(cwdOptions);
      const formatted = formatMicroSkillsBatonSnippet(msReg);
      microSkillsBaton = formatted.snippet || '';
    }

    let hookSpecificOutput = hydration.hookSpecificOutput || null;
    const claudeCapabilities =
      options.checkCapabilities === false
        ? null
        : inspectClaudeBinaryCapabilities({ ...cwdOptions, cwd, probeVersion: false });
    const extraBlocks = [];
    if (microSkillsBaton) extraBlocks.push(microSkillsBaton);
    if (ruleAudit.triggered) extraBlocks.push(ruleAudit.advisory);
    if (memoryAudit.triggered) extraBlocks.push(memoryAudit.advisory);
    if (agentCliffAudit.triggered) extraBlocks.push(agentCliffAudit.advisory);
    if (idleDrainAudit.triggered) extraBlocks.push(idleDrainAudit.advisory);
    if (thinkingTimeoutAudit.triggered) extraBlocks.push(thinkingTimeoutAudit.advisory);
    if (claudeCapabilities?.found && !claudeCapabilities.contractValid && claudeCapabilities.warning) {
      extraBlocks.push(claudeCapabilities.warning);
    }

    if (extraBlocks.length > 0) {
      const joinedExtra = extraBlocks.join('\n\n');
      if (!hookSpecificOutput) {
        hookSpecificOutput = {
          hookEventName: 'SessionStart',
          additionalContext: joinedExtra
        };
      } else {
        hookSpecificOutput.additionalContext = hookSpecificOutput.additionalContext
          ? `${hookSpecificOutput.additionalContext}\n\n${joinedExtra}`
          : joinedExtra;
      }
    }

    const combinedSystemMessage = [compactSystemMessage, resumeSystemMessage]
      .filter(Boolean)
      .join(' | ');

    if (hookSpecificOutput || combinedSystemMessage) {
      const stdoutJson = {
        ...(combinedSystemMessage ? { systemMessage: combinedSystemMessage } : {}),
        ...(hookSpecificOutput ? { hookSpecificOutput } : {})
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(stdoutJson),
        stdoutJson,
        stderr: '',
        result: {
          ...hydration,
          ruleAudit,
          memoryAudit,
          agentCliffAudit,
          idleDrainAudit,
          thinkingTimeoutAudit,
          testHashSnapshot,
          microSkillsBaton,
          claudeCapabilities,
          surfacedPendingDownshift,
          resumeToolsetAudit
        }
      };
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      result: {
        ...hydration,
        memoryAudit,
        agentCliffAudit,
        idleDrainAudit,
        thinkingTimeoutAudit,
        testHashSnapshot,
        claudeCapabilities,
        surfacedPendingDownshift,
        resumeToolsetAudit
      }
    };
  }

  if (phase === 'post' || event.hook_event_name === 'PostCompact') {
    const postRes = handlePostCompactFlush(event, cwdOptions);
    const snap = readBreakerStateSnapshot(sessionId, cwdOptions);
    const pendingModel =
      event.pending_downshift_model ||
      event.pendingDownshiftModel ||
      snap?.pending_downshift?.toModel ||
      snap?.pendingDownshiftModel ||
      (Array.isArray(snap?.queuedMutations)
        ? snap.queuedMutations.find((m) => m && m.type === 'model')?.value || null
        : null);

    if (
      options.persistState !== false &&
      Boolean(event.cwd || cwdOptions.cwd || options.breakerStatePath || options.cliInvocation)
    ) {
      writeBreakerStateSnapshot(
        sessionId,
        {
          ...(snap || {}),
          updatedAt: Date.now(),
          justCompacted: true,
          turnsSinceLastCompact: 0,
          taskBoundaryState: {
            openFailure: false,
            editsSinceBoundary: 0,
            lastBoundarySuggestedTurn: null
          },
          pending_downshift: null,
          pendingDownshiftModel: null,
          queuedMutations: []
        },
        cwdOptions
      );
    }

    if (pendingModel) {
      const actuatedMsg =
        `[Highbeam] Compaction cleared the large warm cache; run /model ${pendingModel} ` +
        `to apply held downshift without rewriting the pre-compact prefix (H6).`;
      // PostCompact lacks hookSpecificOutput in Claude Code 2.1.325 (qY); emit systemMessage only.
      const stdoutJson = {
        systemMessage: actuatedMsg
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(stdoutJson),
        stdoutJson,
        stderr: '',
        result: {
          ...postRes,
          actuatedDownshiftModel: pendingModel
        }
      };
    }

    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      result: postRes
    };
  }

  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    result: null
  };
}

/**
 * CLI runner for `compact-lifecycle` (`ISS-035`).
 * Non-blocking lifecycle hook: logs diagnostic to stderr and exits `0` on uncaught error.
 *
 * @param {object} [cliOptions={}]
 */
export async function executeCompactLifecycleCli(cliOptions = {}) {
  const readPayload = cliOptions.readPayload || readStdinJsonAsync;
  const runHook = cliOptions.runHook || runCompactLifecycleHook;
  const ioOverride = cliOptions.ioOverride || {};
  try {
    const argv = cliOptions.argv || globalThis.process?.argv || [];
    const phaseArg = argv.find((a) => String(a).startsWith('--phase='));
    const explicitPhase = phaseArg ? String(phaseArg).split('=')[1] : undefined;
    const payload = await readPayload(cliOptions.timeoutMs);
    const res = runHook(payload, {
      ...(cliOptions.hookOptions || {}),
      ...(explicitPhase ? { phase: explicitPhase } : {})
    });
    if (res.stdout) {
      exitWithStdoutJson(res.stdout, ioOverride);
    } else {
      exitPassThrough(ioOverride.exitFn);
    }
  } catch (err) {
    exitDiagnosticZero(err?.message || String(err), 'CompactLifecycle', ioOverride);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  executeCompactLifecycleCli().catch((err) => {
    exitDiagnosticZero(err?.message || String(err), 'CompactLifecycle');
  });
}
