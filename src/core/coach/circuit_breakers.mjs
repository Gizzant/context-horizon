import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { canonicalizePath } from '../paths.mjs';
import { isTestFilePath } from '../detectors_det01_to_16.mjs';

/**
 * Phase 3.1: Deterministic Circuit Breakers (`src/core/coach/circuit_breakers.mjs`)
 *
 * Zero-LLM-token (<2ms) stateful and batch circuit breakers:
 *  - `DET-01` (Retry Churn): >= 2 identical failing tool calls or non-zero exit codes.
 *    Triggers sticky tier escalation via `HysteresisLock`.
 *  - `DET-02` (AST Edit Oscillation): Rolling SHA-256 file hash matches state from
 *    T-2 or T-3 within 5 turns. Surfaces the 1-Click 3-Stage Stepwise Refinement
 *    (Design-by-Contract) Prompt Pill (injected as next user message so prefix cache
 *    remains 100% intact).
 *  - `DET-03` (Test Assertion Weakening): `git diff` on test files detects deleted
 *    `assert`/`expect` statements while fixing tests. Renders a 1-click git hunk revert action.
 *  - Supports `purgeRewoundTurns(newStepCount)` when `TrajectoryWatcher` emits `TRAJECTORY_REWIND`.
 */

export const THREE_STAGE_CONTRACT_PROMPT = [
  'STOP modifying files immediately. Enter 3-Stage Stepwise Refinement (Design-by-Contract):',
  'Stage 1 (Preconditions & Invariants): State the exact input/output contract and root cause of the oscillation in <= 3 bullets.',
  'Stage 2 (Minimal Dry-Run Diff): Propose the smallest non-oscillating change that satisfies all existing assertions.',
  'Stage 3 (Targeted Verification): Run only the affected unit test before touching any other file.'
].join('\n');

export function sha256Hex(content = '') {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function normalizeToolSignature(toolName = '', args = {}) {
  const cleanName = String(toolName || '').toLowerCase().trim();
  const sortedKeys = Object.keys(args || {}).sort();
  const normObj = {};
  for (const k of sortedKeys) {
    const val = args[k];
    normObj[k] = typeof val === 'string' ? val.trim().replace(/\s+/g, ' ') : val;
  }
  return `${cleanName}::${JSON.stringify(normObj)}`;
}

export function inspectGitDiffAssertionWeakening(diffText = '', filePath = '') {
  const lines = String(diffText || '').split(/\r?\n/);
  const deletedAssertions = [];
  const addedAssertions = [];

  const assertRegex = /\b(assert(?:\.[a-zA-Z0-9_]+)?|expect|should)\s*\(|^\s*assert\s+/;

  for (const rawLine of lines) {
    if (rawLine.startsWith('---') || rawLine.startsWith('+++')) continue;
    if (rawLine.startsWith('-')) {
      const body = rawLine.slice(1);
      if (assertRegex.test(body)) {
        deletedAssertions.push(body.trim());
      }
    } else if (rawLine.startsWith('+')) {
      const body = rawLine.slice(1);
      if (assertRegex.test(body)) {
        addedAssertions.push(body.trim());
      }
    }
  }

  const netDeletedCount = Math.max(0, deletedAssertions.length - addedAssertions.length);
  return {
    weakened: netDeletedCount > 0,
    deletedCount: deletedAssertions.length,
    addedCount: addedAssertions.length,
    netDeletedCount,
    deletedAssertions,
    filePath
  };
}

/**
 * DET-04: Inspects before/after file content for destructive code-stripping (>50% shrinkage
 * on non-trivial files >= 30 lines) when not explicitly requested by the user.
 */
export function inspectFileShrinkage({
  previousContent = '',
  newContent = '',
  filePath = '',
  userPrompt = '',
  minBaselineLines = 30,
  shrinkageThreshold = 0.50
} = {}) {
  const prevStr = String(previousContent ?? '');
  const nextStr = String(newContent ?? '');
  if (!prevStr) {
    return {
      stripped: false,
      previousLines: 0,
      newLines: nextStr ? nextStr.split(/\r?\n/).length : 0,
      shrinkageRatio: 0,
      shrinkagePct: 0,
      userAuthorized: false,
      filePath
    };
  }

  const prevLines = prevStr.split(/\r?\n/).length;
  const nextLines = nextStr ? nextStr.split(/\r?\n/).length : 0;
  const userAuthorized = /\b(delete|remove|drop|strip|clear|truncate|gut|empty|rewrite\s+from\s+scratch)\b/i.test(
    String(userPrompt || '')
  );

  if (prevLines < minBaselineLines) {
    return {
      stripped: false,
      previousLines: prevLines,
      newLines: nextLines,
      shrinkageRatio: 0,
      shrinkagePct: 0,
      userAuthorized,
      filePath
    };
  }

  const droppedLines = Math.max(0, prevLines - nextLines);
  const shrinkageRatio = prevLines > 0 ? droppedLines / prevLines : 0;
  const shrinkagePct = Math.round(shrinkageRatio * 100);
  const stripped = shrinkageRatio > shrinkageThreshold && !userAuthorized;

  return {
    stripped,
    previousLines: prevLines,
    newLines: nextLines,
    droppedLines,
    shrinkageRatio: Number(shrinkageRatio.toFixed(4)),
    shrinkagePct,
    userAuthorized,
    filePath
  };
}

/**
 * DET-05: Inspects a unified diff or before/after diff lines for error-masking constructs:
 *  - Deleted `try` / `catch` blocks
 *  - Added empty `catch (e) {}` swallow blocks
 *  - Added `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, or `# type: ignore` directives
 */
export function inspectErrorMaskingDiff(diffText = '', filePath = '', { newContent = '' } = {}) {
  const lines = String(diffText || '').split(/\r?\n/);
  let removedTryCatchCount = 0;
  let addedTryCatchCount = 0;
  let suppressionsAddedCount = 0;
  let emptyCatchAddedCount = 0;
  const evidence = [];

  const catchBlockRegex = /\bcatch\s*(?:\([^)]*\))?\s*\{|\bexcept(?:\s+[A-Za-z0-9_.,\s]+)?\s*:/;
  const suppressionRegex = /(@ts-ignore|@ts-expect-error|eslint-disable(?:-next-line|-line)?|#\s*type:\s*ignore|#\s*noqa\b)/;
  const singleLineEmptyCatchRegex = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n}]*)?\}/;

  for (const rawLine of lines) {
    if (rawLine.startsWith('---') || rawLine.startsWith('+++')) continue;
    if (rawLine.startsWith('-')) {
      const body = rawLine.slice(1);
      if (catchBlockRegex.test(body)) {
        removedTryCatchCount++;
        evidence.push(`Removed error handler: ${body.trim()}`);
      }
    } else if (rawLine.startsWith('+')) {
      const body = rawLine.slice(1);
      if (catchBlockRegex.test(body)) {
        addedTryCatchCount++;
      }
      if (suppressionRegex.test(body)) {
        suppressionsAddedCount++;
        evidence.push(`Added error suppression: ${body.trim()}`);
      }
      if (singleLineEmptyCatchRegex.test(body)) {
        emptyCatchAddedCount++;
        evidence.push(`Added empty catch swallow: ${body.trim()}`);
      }
    }
  }

  // Also check multi-line empty catch in newContent if provided
  if (newContent) {
    const multiEmptyMatches =
      String(newContent).match(/\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*)*\}/g) || [];
    if (multiEmptyMatches.length > emptyCatchAddedCount) {
      const extra = multiEmptyMatches.length - emptyCatchAddedCount;
      emptyCatchAddedCount += extra;
      evidence.push(`Empty catch block detected in ${filePath || 'file'}`);
    }
  }

  const netRemovedCatchCount = Math.max(0, removedTryCatchCount - addedTryCatchCount);
  const masked =
    netRemovedCatchCount > 0 || emptyCatchAddedCount > 0 || suppressionsAddedCount > 0;

  return {
    masked,
    netRemovedCatchCount,
    emptyCatchAddedCount,
    suppressionsAddedCount,
    evidence,
    filePath
  };
}

export class CircuitBreakers {
  constructor(options = {}) {
    this.hysteresisLock = options.hysteresisLock || null;
    this.workspacePath = options.workspacePath || process.cwd();
    this.enableBlindEditGuard = Boolean(options.enableBlindEditGuard);
    // turnRecords: Array<{ turnIndex, toolSig, failed, exitCode, filePath, fileHash }>
    this.turnRecords = [];
    // fileHashHistory: normalizedPath -> Array<{ turnIndex, hash }>
    this.fileHashHistory = new Map();
    // DET-17b state tracking
    this.readFiles = new Set();
    this.hasSearchedWorkspace = false;
    this.activeAlerts = [];
  }

  markFileIndexed(filePath = '') {
    const norm = canonicalizePath(String(filePath || '').trim());
    if (norm) this.readFiles.add(norm);
  }

  markWorkspaceSearched() {
    this.hasSearchedWorkspace = true;
  }

  /**
   * Records a turn or tool execution and evaluates DET-01, DET-02, and DET-03 in <2ms.
   */
  recordTurn(turnInput = {}) {
    const startMs = performance.now();
    const turnIndex = Number.isFinite(turnInput.turnIndex)
      ? Number(turnInput.turnIndex)
      : this.turnRecords.length;
    const stepId = String(turnInput.activeTaskMdStepId || turnInput.stepId || 'active-step');

    const toolName = String(turnInput.toolName || turnInput.tool || '').toLowerCase().trim();
    const args = turnInput.args || turnInput.parameters || {};
    const exitCode = Number(turnInput.exitCode ?? (turnInput.error ? 1 : 0));
    const failed = Boolean(turnInput.failed || turnInput.error || exitCode !== 0);
    const toolSig = normalizeToolSignature(toolName, args);

    const rawPath = String(
      turnInput.filePath ||
      args.Path ||
      args.path ||
      args.TargetFile ||
      args.AbsolutePath ||
      ''
    ).trim();
    const normPath = rawPath ? canonicalizePath(rawPath) : '';

    const replacementChunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : null;
    const chunksOld = replacementChunks
      ? replacementChunks.map((ch) => String(ch?.TargetContent ?? ch?.Target ?? ch?.oldContent ?? '')).filter(Boolean).join('\n')
      : undefined;
    const chunksNew = replacementChunks
      ? replacementChunks.map((ch) => String(ch?.ReplacementContent ?? ch?.Replacement ?? ch?.newContent ?? '')).filter(Boolean).join('\n')
      : undefined;

    const resolvedPreviousContent = turnInput.previousContent !== undefined
      ? turnInput.previousContent
      : (args.Target !== undefined
        ? args.Target
        : (args.TargetContent !== undefined ? args.TargetContent : chunksOld));

    const resolvedNewContent = turnInput.newContent !== undefined
      ? turnInput.newContent
      : (args.Content !== undefined
        ? args.Content
        : (args.CodeContent !== undefined
          ? args.CodeContent
          : (args.Replacement !== undefined
            ? args.Replacement
            : (args.ReplacementContent !== undefined ? args.ReplacementContent : chunksNew))));

    let fileHash = turnInput.fileHash || null;
    if (!fileHash && resolvedNewContent !== undefined && resolvedNewContent !== null) {
      fileHash = sha256Hex(resolvedNewContent);
    }

    this.turnRecords.push({
      turnIndex,
      stepId,
      toolName,
      toolSig,
      failed,
      exitCode,
      filePath: rawPath,
      normPath,
      fileHash
    });

    const triggered = [];

    // 1. Evaluate DET-01 (Retry Churn: >= 2 identical failing tool calls or non-zero exit codes)
    const recentFailuresForSig = this.turnRecords.filter(
      (r) => r.failed && r.toolSig === toolSig && (turnIndex - r.turnIndex) <= 5
    );
    const consecutiveNonZero = [];
    for (let i = this.turnRecords.length - 1; i >= 0; i--) {
      if (this.turnRecords[i].failed) {
        consecutiveNonZero.push(this.turnRecords[i]);
      } else {
        break;
      }
    }

    if (failed && (recentFailuresForSig.length >= 2 || consecutiveNonZero.length >= 2)) {
      const retryCount = Math.max(recentFailuresForSig.length, consecutiveNonZero.length);
      if (this.hysteresisLock && typeof this.hysteresisLock.engage === 'function') {
        this.hysteresisLock.engage({
          stepId,
          model: 'gemini-4-argon',
          effort: 'high',
          detectorId: 'DET-01',
          reason: `DET-01 Retry Churn (${retryCount} failing attempts)`,
          turnIndex
        });
      }

      const alert = {
        detectorId: 'DET-01',
        name: 'Retry Churn',
        severity: 'CRITICAL',
        turnIndex,
        retryCount,
        escalatedTier: { model: 'gemini-4-argon', effort: 'high' },
        message: `🚨 DET-01 Retry Churn: ${retryCount} consecutive failures detected. Sticky tier escalation engaged.`
      };
      triggered.push(alert);
      this.activeAlerts.push(alert);
    }

    // 2. Evaluate DET-02 (AST Edit Oscillation: SHA-256 matches T-2 or T-3 within 5 turns)
    if (normPath && fileHash) {
      if (!this.fileHashHistory.has(normPath)) {
        this.fileHashHistory.set(normPath, []);
      }
      const hist = this.fileHashHistory.get(normPath);

      // Look for matching hash at T-2 or T-3 within <= 5 turns
      const priorMatch = hist.find((entry, idx) => {
        const turnsAgo = turnIndex - entry.turnIndex;
        const snapshotsAgo = hist.length - idx;
        return entry.hash === fileHash && turnsAgo <= 5 && (snapshotsAgo >= 2 || turnsAgo >= 2);
      });

      hist.push({ turnIndex, hash: fileHash });

      if (priorMatch) {
        if (this.hysteresisLock && typeof this.hysteresisLock.engage === 'function') {
          this.hysteresisLock.engage({
            stepId,
            model: 'gemini-4-argon',
            effort: 'high',
            detectorId: 'DET-02',
            reason: `DET-02 AST Edit Oscillation on ${rawPath} (reverted to turn #${priorMatch.turnIndex} state)`,
            turnIndex
          });
        }

        const alert = {
          detectorId: 'DET-02',
          name: 'AST Edit Oscillation',
          severity: 'CRITICAL',
          turnIndex,
          filePath: rawPath,
          matchedTurnIndex: priorMatch.turnIndex,
          fileHash,
          promptPill: {
            label: '🛡️ Inject 3-Stage Stepwise Refinement Contract',
            injectAsNextUserMessage: true,
            preservesPrefixCache: true,
            prompt: THREE_STAGE_CONTRACT_PROMPT
          },
          message: `🚨 DET-02 AST Edit Oscillation: ${rawPath} reverted to state from turn #${priorMatch.turnIndex}.`
        };
        triggered.push(alert);
        this.activeAlerts.push(alert);
      }
    }

    // 3. Evaluate DET-03 (Test Assertion Weakening via git diff or before/after content)
    let resolvedDiffText = String(turnInput.gitDiff || '');
    if (!resolvedDiffText && resolvedPreviousContent !== undefined && resolvedNewContent !== undefined) {
      const oldLines = String(resolvedPreviousContent).split(/\r?\n/).map((l) => `-${l}`);
      const newLines = String(resolvedNewContent).split(/\r?\n/).map((l) => `+${l}`);
      resolvedDiffText = [...oldLines, ...newLines].join('\n');
    }

    if (rawPath && isTestFilePath(rawPath) && resolvedDiffText) {
      const audit = inspectGitDiffAssertionWeakening(resolvedDiffText, rawPath);
      if (audit.weakened) {
        const alert = {
          detectorId: 'DET-03',
          name: 'Test Assertion Weakening',
          severity: 'CRITICAL',
          turnIndex,
          filePath: rawPath,
          deletedCount: audit.deletedCount,
          netDeletedCount: audit.netDeletedCount,
          deletedAssertions: audit.deletedAssertions,
          revertAction: {
            type: 'GIT_HUNK_REVERT',
            nonDestructive: true,
            requiresConfirmation: true,
            label: `🔍 Preview & Restore Deleted Assertions in ${rawPath}`,
            command: `git diff -- "${rawPath}"`,
            prompt: `Restore the ${audit.netDeletedCount} deleted test assertion(s) in ${rawPath} without discarding other uncommitted changes (inspect diff via: git diff -- "${rawPath}").`,
            filePath: rawPath
          },
          message: `🚨 DET-03 Test Assertion Weakening: ${audit.netDeletedCount} assert/expect statement(s) deleted in ${rawPath}.`
        };
        triggered.push(alert);
        this.activeAlerts.push(alert);
      }
    }

    // 4. Evaluate DET-04 (Destructive Code-Stripping / >50% File Shrinkage)
    if (rawPath && resolvedPreviousContent !== undefined && resolvedNewContent !== undefined) {
      const shrinkAudit = inspectFileShrinkage({
        previousContent: resolvedPreviousContent,
        newContent: resolvedNewContent,
        filePath: rawPath,
        userPrompt: turnInput.userPrompt || ''
      });
      if (shrinkAudit.stripped) {
        const alert = {
          detectorId: 'DET-04',
          name: 'Destructive Code-Stripping (>50% File Shrinkage)',
          severity: 'CRITICAL',
          turnIndex,
          filePath: rawPath,
          previousLines: shrinkAudit.previousLines,
          newLines: shrinkAudit.newLines,
          shrinkagePct: shrinkAudit.shrinkagePct,
          revertAction: {
            type: 'GIT_HUNK_REVERT',
            nonDestructive: true,
            requiresConfirmation: true,
            label: `🔍 Preview & Restore ${shrinkAudit.shrinkagePct}% Shrinkage in ${rawPath}`,
            command: `git diff -- "${rawPath}"`,
            prompt: `Restore the stripped code in ${rawPath} (${shrinkAudit.previousLines} -> ${shrinkAudit.newLines} lines) without discarding valid edits (inspect diff via: git diff -- "${rawPath}").`,
            filePath: rawPath
          },
          message: `🚨 DET-04 Destructive Code-Stripping: ${rawPath} shrank by ${shrinkAudit.shrinkagePct}% (${shrinkAudit.previousLines} -> ${shrinkAudit.newLines} lines) without user authorization.`
        };
        triggered.push(alert);
        this.activeAlerts.push(alert);
      }
    }

    // 5. Evaluate DET-05 (Error-Masking & Silent try/catch Stripping)
    if (rawPath && resolvedDiffText && !isTestFilePath(rawPath)) {
      const maskAudit = inspectErrorMaskingDiff(resolvedDiffText, rawPath, {
        newContent: resolvedNewContent || ''
      });
      if (maskAudit.masked) {
        const alert = {
          detectorId: 'DET-05',
          name: 'Error-Masking & Try/Catch Stripping',
          severity: 'HIGH',
          turnIndex,
          filePath: rawPath,
          netRemovedCatchCount: maskAudit.netRemovedCatchCount,
          emptyCatchAddedCount: maskAudit.emptyCatchAddedCount,
          suppressionsAddedCount: maskAudit.suppressionsAddedCount,
          evidence: maskAudit.evidence,
          revertAction: {
            type: 'GIT_HUNK_REVERT',
            nonDestructive: true,
            requiresConfirmation: true,
            label: `🔍 Preview & Restore Error Handling in ${rawPath}`,
            command: `git diff -- "${rawPath}"`,
            prompt: `Restore proper try/catch error handling in ${rawPath} without silent suppression (inspect diff via: git diff -- "${rawPath}").`,
            filePath: rawPath
          },
          message: `🚨 DET-05 Error-Masking Detected in ${rawPath}: ${maskAudit.evidence[0] || 'Error handler stripped or suppressed'}.`
        };
        triggered.push(alert);
        this.activeAlerts.push(alert);
      }
    }

    // 6. Track read/search indexing and evaluate DET-17b (Blind-Edit / Unindexed File Creation Guard)
    const isReadTool = /^(read_file|view_file|view_file_outline|view_code_item)$/.test(toolName);
    const isSearchTool = /^(grep_search|find_by_name|codebase_search|list_dir)$/.test(toolName);
    const isWriteOrEditTool = /^(edit_file|replace_file_content|multi_replace_file_content|write_file|write_to_file)$/.test(toolName);

    if (isReadTool && normPath) {
      this.readFiles.add(normPath);
    }
    if (isSearchTool) {
      this.hasSearchedWorkspace = true;
    }

    if ((this.enableBlindEditGuard || turnInput.checkBlindEdit) && isWriteOrEditTool && normPath) {
      const isCreateNew = Boolean(turnInput.isNewFile || /^write_(file|to_file)$/.test(toolName));
      const wasRead = this.readFiles.has(normPath);
      if (!isCreateNew && !wasRead) {
        const alert = {
          detectorId: 'DET-17b',
          name: 'Blind-Edit Without Prior File Read',
          severity: 'WARN',
          turnIndex,
          filePath: rawPath,
          mode: 'blind_edit',
          message: `⚠️ DET-17b Blind-Edit Guard: ${rawPath} was modified without prior read_file inspection in this session.`
        };
        triggered.push(alert);
        this.activeAlerts.push(alert);
      } else if (isCreateNew && !this.hasSearchedWorkspace && this.readFiles.size === 0) {
        const alert = {
          detectorId: 'DET-17b',
          name: 'Unindexed New File Creation',
          severity: 'WARN',
          turnIndex,
          filePath: rawPath,
          mode: 'unindexed_create',
          message: `⚠️ DET-17b Unindexed File Creation: ${rawPath} was created without prior codebase search or file indexing.`
        };
        triggered.push(alert);
        this.activeAlerts.push(alert);
      }
      // Once written/edited, mark it known for subsequent turns
      this.readFiles.add(normPath);
    }

    return {
      turnIndex,
      triggered,
      hasTripped: triggered.length > 0,
      elapsedMs: Number((performance.now() - startMs).toFixed(3))
    };
  }

  /**
   * Purges oscillation hashes, retry counters, and alerts recorded during rewound turns
   * (`turnIndex >= newStepCount`) when `TrajectoryWatcher` emits `TRAJECTORY_REWIND`.
   */
  purgeRewoundTurns(newStepCount = 0) {
    const cutoff = Math.max(0, Number(newStepCount) || 0);
    const beforeCount = this.turnRecords.length;
    this.turnRecords = this.turnRecords.filter((r) => r.turnIndex < cutoff);
    this.activeAlerts = this.activeAlerts.filter((a) => a.turnIndex < cutoff);

    for (const [normPath, hist] of this.fileHashHistory.entries()) {
      const kept = hist.filter((entry) => entry.turnIndex < cutoff);
      if (kept.length === 0) {
        this.fileHashHistory.delete(normPath);
      } else {
        this.fileHashHistory.set(normPath, kept);
      }
    }

    if (this.hysteresisLock && typeof this.hysteresisLock.onTrajectoryRewind === 'function') {
      this.hysteresisLock.onTrajectoryRewind({ newStepCount: cutoff });
    }

    return {
      purgedTurnCount: Math.max(0, beforeCount - this.turnRecords.length),
      remainingTurns: this.turnRecords.length,
      activeAlertCount: this.activeAlerts.length
    };
  }

  onTrajectoryRewind(rewindPayload = {}) {
    return this.purgeRewoundTurns(rewindPayload.newStepCount ?? 0);
  }

  /**
   * Generates a non-destructive git diff preview and explicit restoration prompt
   * for DET-03 weakened test assertions (never executes destructive `git checkout --`).
   */
  revertWeakenedTestFile(filePath, { cwd = this.workspacePath, execFn = execFileSync } = {}) {
    const target = String(filePath || '').trim();
    if (!target) {
      throw new Error('CircuitBreakers.revertWeakenedTestFile: filePath is required');
    }
    let diffPreview = '';
    try {
      const out = execFn('git', ['diff', '--', target], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000
      });
      diffPreview = typeof out === 'string' ? out : (out ? String(out) : '');
    } catch {
      diffPreview = '';
    }
    this.activeAlerts = this.activeAlerts.filter(
      (a) => !((a.detectorId === 'DET-03' || a.detectorId === 'DET-06') && canonicalizePath(a.filePath) === canonicalizePath(target))
    );
    return {
      ok: true,
      nonDestructive: true,
      requiresConfirmation: true,
      revertedFile: target,
      previewCommand: `git diff -- "${target}"`,
      diffPreview,
      prompt: `Restore the deleted test assertions in ${target} without discarding other uncommitted edits.`
    };
  }
}

export default CircuitBreakers;
