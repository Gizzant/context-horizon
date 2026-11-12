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
import { evaluateDet17AutoCompactionDeferral } from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { loadHorizonConfig, resolveDetectorOverride } from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { loadMicroSkillsRegistry, formatMicroSkillsBatonSnippet } from '../../src/core-isomorphic/coach/microSkills.mjs';
import { readTextSafe, resolvePath, getCwd } from '../../src/core-isomorphic/utils/runtime.mjs';
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
        : event.hook_event_name === 'WorktreeCreate'
          ? 'worktree'
          : 'pre';
  const phase = String(options.phase || event.phase || inferredPhase).toLowerCase();
  const cwdOptions = event.cwd && !options.cwd ? { ...options, cwd: event.cwd } : options;

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
    const horizonConfig = options.horizonConfig || loadHorizonConfig(cwdOptions);
    let microSkillsBaton = '';
    if (resolveDetectorOverride('micro-skills', horizonConfig) !== 'off') {
      const msReg = loadMicroSkillsRegistry(cwdOptions);
      const formatted = formatMicroSkillsBatonSnippet(msReg);
      microSkillsBaton = formatted.snippet || '';
    }

    let hookSpecificOutput = hydration.hookSpecificOutput || null;
    const extraBlocks = [];
    if (microSkillsBaton) extraBlocks.push(microSkillsBaton);
    if (ruleAudit.triggered) extraBlocks.push(ruleAudit.advisory);

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

    if (hookSpecificOutput) {
      const stdoutJson = { hookSpecificOutput };
      return {
        exitCode: 0,
        stdout: JSON.stringify(stdoutJson),
        stdoutJson,
        stderr: '',
        result: {
          ...hydration,
          ruleAudit,
          microSkillsBaton
        }
      };
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      result: hydration
    };
  }

  if (phase === 'post' || event.hook_event_name === 'PostCompact') {
    const postRes = handlePostCompactFlush(event, cwdOptions);
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
