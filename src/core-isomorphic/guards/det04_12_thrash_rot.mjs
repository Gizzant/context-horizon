/**
 * @file src/core-isomorphic/guards/det04_12_thrash_rot.mjs
 * Consecutive Failures, Diff Thrashing, Blind Search, Output Bomb, and Rot/Cliff Breakers (`DET-04`..`DET-12`).
 * Pure-V8 isomorphic ESM module (zero `node:*` imports).
 */

import { path, sha256Hex } from '../utils/runtime.mjs';
import { normalizeModelId, computeTotalPromptTokens } from '../config/catalogLoader.mjs';
import { SHELL_TOOL_REGEX } from './det01_03_shell_secret.mjs';

/**
 * DET-04: Consecutive Tool Failure Breaker (`>= 3` failures -> block 4th + strategy reset).
 *
 * @param {object} [params={}]
 * @param {number} [params.consecutiveFailures=0]
 * @param {number} [params.threshold=3]
 */
export function evaluateDet04ConsecutiveFailures(params = {}) {
  const count = Math.max(0, Number(params.consecutiveFailures || 0));
  const threshold = Math.max(1, Number(params.threshold ?? 3));

  if (count >= threshold) {
    return {
      detectorId: 'DET-04',
      triggered: true,
      decision: 'deny',
      consecutiveFailures: count,
      reason: `[DET-04 Consecutive Failure Breaker] ${count} consecutive tool failures detected. Halting 4th attempt to prevent retry churn; re-verify assumptions or escalate reasoning effort.`
    };
  }

  return {
    detectorId: 'DET-04',
    triggered: false,
    decision: 'allow',
    consecutiveFailures: count,
    reason: null
  };
}

/**
 * Computes added and deleted lines between `oldText` and `newText` without scanning unchanged lines.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ addedLines: Array<string>, deletedLines: Array<string>, oldLineCount: number, newLineCount: number }}
 */
export function computeAddedAndDeletedDiffLines(oldText = '', newText = '') {
  const oldLines = oldText ? String(oldText).split(/\r?\n/) : [];
  const newLines = newText ? String(newText).split(/\r?\n/) : [];

  const oldCounts = new Map();
  for (const line of oldLines) {
    oldCounts.set(line, (oldCounts.get(line) || 0) + 1);
  }

  const newCounts = new Map();
  for (const line of newLines) {
    newCounts.set(line, (newCounts.get(line) || 0) + 1);
  }

  const addedLines = [];
  for (const [line, count] of newCounts.entries()) {
    const prev = oldCounts.get(line) || 0;
    for (let i = 0; i < count - prev; i++) {
      addedLines.push(line);
    }
  }

  const deletedLines = [];
  for (const [line, count] of oldCounts.entries()) {
    const next = newCounts.get(line) || 0;
    for (let i = 0; i < count - next; i++) {
      deletedLines.push(line);
    }
  }

  return {
    addedLines,
    deletedLines,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length
  };
}

/**
 * Computes a fast deterministic hash of content for `A -> B -> A` oscillation tracking.
 * @param {string} content
 * @returns {string}
 */
export function hashFileContent(content = '') {
  return sha256Hex(String(content ?? '')).slice(0, 16);
}

/**
 * DET-05: AST/Diff Edit Thrashing & Destructive Code Stripping Breaker.
 * Scans ONLY newly added/deleted diff lines (never pre-existing unchanged file lines),
 * checks `A -> B -> A` file hash oscillation, `> 50%` sudden file shrinkage, and stripped assertions.
 * Never invokes destructive `git checkout -- <file>`.
 *
 * @param {object} [params={}]
 * @param {string} [params.filePath='']
 * @param {string} [params.oldText='']
 * @param {string} [params.newText='']
 * @param {number} [params.fullFileOldLines]
 * @param {number} [params.fullFileNewLines]
 * @param {Array<string>} [params.hashHistory=[]] - Previous content hashes for this file
 */
export function evaluateDet05DiffThrashing(params = {}) {
  const oldText = String(params.oldText ?? '');
  const newText = String(params.newText ?? '');
  const { addedLines, deletedLines, oldLineCount, newLineCount } =
    computeAddedAndDeletedDiffLines(oldText, newText);

  const effectiveOldLines = Number(params.fullFileOldLines ?? oldLineCount);
  const effectiveNewLines = Number(params.fullFileNewLines ?? newLineCount);
  const nextHash = hashFileContent(params.fullNewContent ?? newText);

  // 0. Check lazy elision comment placeholders (// ... existing code ...)
  const LAZY_ELISION_REGEX = /(?:\/\/|#|--|\/\*)\s*(?:\.\.\.|…)?\s*(?:existing|rest of|remaining|unchanged)\s+(?:code|implementation|file|methods|lines)\b/i;
  if (LAZY_ELISION_REGEX.test(newText)) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'LAZY_ELISION_PLACEHOLDER',
      nextHash,
      reason: `[DET-05 Destructive Code-Stripping] Diff inserts lazy placeholder comments ("// ... existing code ...") deleting implemented logic. Write the complete surgical replacement.`
    };
  }

  // 1. Check `A -> B -> A` hash oscillation
  const hashHistory = Array.isArray(params.hashHistory) ? params.hashHistory : [];
  const oscillationDetected =
    hashHistory.length >= 2 &&
    hashHistory[hashHistory.length - 2] === nextHash &&
    hashHistory[hashHistory.length - 1] !== nextHash;

  if (oscillationDetected) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'HASH_OSCILLATION_ABA',
      nextHash,
      addedLinesCount: addedLines.length,
      deletedLinesCount: deletedLines.length,
      reason: `[DET-05 Edit Thrashing Breaker] A -> B -> A file hash oscillation detected on "${params.filePath || 'file'}". Stop reverting and re-evaluate root cause.`
    };
  }

  // 2. Check > 50% sudden file shrinkage (when original has >= 12 lines)
  if (effectiveOldLines >= 12 && effectiveNewLines < effectiveOldLines * 0.5) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'SUDDEN_FILE_SHRINKAGE',
      nextHash,
      oldLineCount: effectiveOldLines,
      newLineCount: effectiveNewLines,
      reason: `[DET-05 Destructive Shrinkage Breaker] Edit shrinks "${params.filePath || 'file'}" from ${effectiveOldLines} lines to ${effectiveNewLines} lines (>50% reduction).`
    };
  }

  // 2b. Full-File Regurgitation Check (>=300 lines with >=90% unchanged lines on Write)
  const isFullWrite = String(params.toolName || '').toLowerCase() === 'write' || Boolean(params.isFullWrite);
  if (isFullWrite && effectiveOldLines >= 300 && effectiveNewLines >= Math.floor(effectiveOldLines * 0.9)) {
    const oldLinesArr = oldText.split(/\r?\n/);
    const newLinesArr = newText.split(/\r?\n/);
    const beforeMap = new Map();
    for (const line of oldLinesArr) {
      const trimmed = line.trim();
      beforeMap.set(trimmed, (beforeMap.get(trimmed) || 0) + 1);
    }
    let unchangedCount = 0;
    for (const line of newLinesArr) {
      const trimmed = line.trim();
      const count = beforeMap.get(trimmed) || 0;
      if (count > 0) {
        unchangedCount++;
        beforeMap.set(trimmed, count - 1);
      }
    }
    const changedCount = effectiveOldLines - unchangedCount;
    if (unchangedCount / effectiveOldLines >= 0.90 && changedCount <= Math.max(25, Math.floor(effectiveOldLines * 0.10))) {
      const flightMode = String(params.flightMode || 'COACH').toUpperCase();
      return {
        detectorId: 'DET-05',
        triggered: true,
        decision: flightMode === 'AUTO_PILOT' ? 'ask' : 'allow',
        advisory: flightMode !== 'AUTO_PILOT',
        subType: 'FULL_FILE_REGURGITATION',
        nextHash,
        oldLineCount: effectiveOldLines,
        newLineCount: effectiveNewLines,
        reason: `[DET-05 Full-File Regurgitation] Writing entire ${effectiveOldLines}-line file with ${unchangedCount} lines (${Math.round((unchangedCount / effectiveOldLines) * 100)}%) unchanged. Use surgical Edit instead.`
      };
    }
  }

  const rawIntentPrompt = String(params.lastUserInput || params.prompt || '');
  const userExplicitTestIntent =
    Boolean(params.userExplicitTestIntent) ||
    /\b(?:edit|update|modify|delete|remove|drop|skip|disable|rewrite|adjust|refactor)\s+(?:(?:the|all|any|some|these|those|existing|failing|obsolete|legacy|old|broken|flaky|unit|integration|e2e)\s+)*(?:tests?|specs?|assertions?)\b/i.test(
      rawIntentPrompt
    ) ||
    (/\.(?:test|spec)\.[a-z0-9]+\b/i.test(rawIntentPrompt) &&
      /\b(?:delete|remove|drop|skip|disable|update|rewrite)\b/i.test(rawIntentPrompt));
  const normFilePath = String(params.filePath || '').replace(/\\/g, '/');
  const isTestTarget =
    /\.(?:test|spec)\.[a-z0-9]+$/i.test(normFilePath) ||
    /(?:^|\/)(?:test|tests|__tests__)\/.*\.(?:[cm]?[jt]sx?|py|go|rs)$/i.test(normFilePath) ||
    /_test\.(?:py|go)$/i.test(normFilePath);

  // 2a. Test file truncation lock (#3): block emptying/truncating short test files (>=3 lines -> <=20%)
  if (
    isTestTarget &&
    !userExplicitTestIntent &&
    effectiveOldLines >= 3 &&
    effectiveNewLines <= Math.floor(effectiveOldLines * 0.2)
  ) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'TEST_ASSERTION_STRIPPING',
      nextHash,
      oldLineCount: effectiveOldLines,
      newLineCount: effectiveNewLines,
      reason: `[DET-05 Test Integrity Lock (#3)] Truncating test file "${params.filePath || 'test'}" from ${effectiveOldLines} lines to ${effectiveNewLines} lines without explicit user instruction is forbidden.`
    };
  }

  // 3. Scan ONLY deleted and added diff lines for test-assertion stripping / skip injection / weakening / error masking
  const assertionRegex =
    /\b(?:assert(?:\.[a-zA-Z0-9_]+)?\s*\x28|expect\s*\x28|should\.|assert_eq!\s*\x28|assert_ne!\s*\x28)|^\s*assert\s+(?!false\b)\S+/;
  const trivialTautologyRegex =
    /\b(?:assert\.ok\s*\(\s*true\s*\)|assert\.(?:strictEqual|equal)\s*\(\s*true\s*,\s*true\s*\)|expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\))/;
  const deletedAssertions = deletedLines.filter(
    (l) => assertionRegex.test(l) && !trivialTautologyRegex.test(l)
  );
  const addedAssertions = addedLines.filter(
    (l) => assertionRegex.test(l) && !trivialTautologyRegex.test(l)
  );

  // Item A2 (#3): Block >= 1 net deleted assertion without replacement unless user explicitly asked
  if (!userExplicitTestIntent && deletedAssertions.length > addedAssertions.length) {
    const netDeleted = deletedAssertions.length - addedAssertions.length;
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'TEST_ASSERTION_STRIPPING',
      nextHash,
      deletedAssertionsCount: netDeleted,
      reason: `[DET-05 Test Integrity Lock (#3)] Diff deletes ${netDeleted} net test assertion(s) without replacement.`
    };
  }

  // Item A2 (#3): Block net increase in skipped/disabled tests (.skip, xit, @pytest.mark.skip, #[ignore])
  const skipMarkerRegex =
    /(?:\.(?:skip|todo)\s*\x28|\b(?:xit|xdescribe|xtest)\s*\x28|@pytest\.mark\.skip(?:if)?\b|#\[\s*ignore\b)/;
  const deletedSkips = deletedLines.filter((l) => skipMarkerRegex.test(l));
  const addedSkips = addedLines.filter((l) => skipMarkerRegex.test(l));
  if (!userExplicitTestIntent && addedSkips.length > deletedSkips.length) {
    const netSkips = addedSkips.length - deletedSkips.length;
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'TEST_SKIP_INJECTION',
      nextHash,
      addedSkipsCount: netSkips,
      reason: `[DET-05 Test Integrity Lock (#3)] Diff injects ${netSkips} skipped/disabled test marker(s) (.skip / xit / @pytest.mark.skip) without explicit user instruction.`
    };
  }

  // Item A2 (#3): Block assertion weakening (strict equality -> truthy/defined)
  const strongAssertRegex = /\b(?:toEqual|toStrictEqual|deepStrictEqual|strictEqual|deepEqual)\s*\x28/;
  const weakAssertRegex = /\b(?:toBeTruthy|toBeDefined|toBeUndefined|assert\.ok)\s*\x28/;
  if (
    !userExplicitTestIntent &&
    deletedLines.some((l) => strongAssertRegex.test(l)) &&
    addedLines.some((l) => weakAssertRegex.test(l)) &&
    !addedLines.some((l) => strongAssertRegex.test(l))
  ) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'TEST_ASSERTION_WEAKENING',
      nextHash,
      reason: `[DET-05 Test Integrity Lock (#3)] Diff weakens strict equality assertion(s) (toEqual/deepStrictEqual) into loose truthiness check(s) (toBeTruthy/toBeDefined).`
    };
  }

  // Item A7 (#12): Standalone Silent Error-Masking Linter (independent of deletedAssertions!)
  const justificationCommentRe = /(?:\/\/|\/\*|#)\s*(?:ignore|expected|noop|fallback|non-fatal|intentionally|best-effort)\b/i;
  const inlineSuppressionRe = /(?:@ts-ignore|@ts-nocheck|eslint-disable(?!\s+[^\r\n]*--\s*\S{4,}))/;
  const singleLineEmptyCatchRe = /\bcatch\s*(?:\x28[^\x29]*\x29)?\s*\{\s*\}/;
  const addedInlineMasking = addedLines.filter(
    (l) =>
      (singleLineEmptyCatchRe.test(l) || inlineSuppressionRe.test(l)) &&
      !justificationCommentRe.test(l)
  );

  const multiLineEmptyCatchRe = /\bcatch\s*(?:\x28[^\x29]*\x29)?\s*\{\s*\}/g;
  const oldEmptyCatchCount = (oldText.match(multiLineEmptyCatchRe) || []).length;
  const newEmptyCatchCount = (newText.match(multiLineEmptyCatchRe) || []).length;

  const pyPassBlockRe = /\bexcept(?:\s+[A-Za-z0-9_.,\s()]+)?\s*:(?:[ \t]*(?:#[^\r\n]*)?\r?\n[ \t]*|[ \t]*)pass\b/g;
  const countUnjustifiedPyPass = (txt) => {
    const matches = txt.match(pyPassBlockRe) || [];
    return matches.filter((m) => !justificationCommentRe.test(m)).length;
  };
  const addedMultiLineMasking =
    newEmptyCatchCount > oldEmptyCatchCount ||
    countUnjustifiedPyPass(newText) > countUnjustifiedPyPass(oldText);

  if (addedInlineMasking.length > 0 || addedMultiLineMasking) {
    return {
      detectorId: 'DET-05',
      triggered: true,
      decision: 'deny',
      subType: 'ERROR_MASKING_DIFF',
      nextHash,
      reason: `[DET-05 Error Masking Breaker (#12)] Newly added diff introduces silent error masking (empty catch / except: pass / @ts-ignore / eslint-disable) without logging, rethrow, or justification comment.`
    };
  }

  return {
    detectorId: 'DET-05',
    triggered: false,
    decision: 'allow',
    subType: null,
    nextHash,
    addedLinesCount: addedLines.length,
    deletedLinesCount: deletedLines.length,
    reason: null
  };
}

/**
 * DET-06: Main-Thread Blind Search Guard (`> 6` sequential `Read`/`Grep`/`Glob` calls -> nudge `Explore` subagent).
 *
 * @param {object} [params={}]
 * @param {number} [params.sequentialSearchCount=0]
 * @param {number} [params.threshold=6]
 * @param {number} [params.limit]
 */
export function evaluateDet06BlindSearchGuard(params = {}) {
  const count = Math.max(0, Number(params.sequentialSearchCount || 0));
  const rawThreshold = params.threshold ?? params.limit ?? 6;
  const threshold = Math.max(1, Number(rawThreshold));

  if (count > threshold) {
    return {
      detectorId: 'DET-06',
      triggered: true,
      decision: 'advise_subagent',
      advisory: true,
      sequentialSearchCount: count,
      threshold,
      recommendedSubagent: {
        agentType: 'Explore',
        model: 'claude-haiku-5-5'
      },
      reason: `[DET-06 Blind Search Guard] ${count} sequential Read/Grep calls on the main thread (> ${threshold}). Delegate open-ended codebase exploration to an Explore subagent on claude-haiku-5-5 to prevent main-window distractor bloat.`
    };
  }

  return {
    detectorId: 'DET-06',
    triggered: false,
    decision: 'allow',
    sequentialSearchCount: count,
    threshold,
    reason: null
  };
}

/**
 * DET-07: Unbounded Command Output Bomb Guard (`git log` without limit, unpaged `cat` on huge logs/lockfiles).
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Bash']
 * @param {string} [params.command='']
 */
export function evaluateDet07OutputBombGuard(params = {}) {
  const toolName = String(params.toolName || 'Bash');
  const filePath = String(params.filePath || params.path || params.targetPath || '');
  const limit = params.limit != null ? Number(params.limit) : null;

  // Native Read / read_file check on lockfiles and minified bundles
  if (/^(read|read_file|view_file)$/i.test(toolName) && filePath) {
    const norm = filePath.replace(/\\/g, '/');
    const isLockfileOrBundle =
      /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$/i.test(norm) ||
      /\.(?:min\.js|bundle\.min\.js|bundle\.js|min\.css|map)$/i.test(norm) ||
      /(?:^|\/)(dist|build|\.next|out)\/.*\.(?:js|json|css)$/i.test(norm);
    if (isLockfileOrBundle) {
      const isBounded = limit != null && limit > 0 && limit <= 100;
      if (!isBounded) {
        const base = norm.split('/').pop() || 'lockfile';
        return {
          detectorId: 'DET-07',
          triggered: true,
          decision: 'deny',
          subType: 'LOCKFILE_OR_BUNDLE_READ_BLOCKED',
          reason: `[DET-07 Unbounded Output Bomb Guard] Unbounded native Read on "${base}". Dumping full lockfile/bundle wastes context. Inspect package.json or specify line limits <= 100.`
        };
      }
    }
  }

  if (!SHELL_TOOL_REGEX.test(toolName)) {
    return { detectorId: 'DET-07', triggered: false, decision: 'allow', reason: null };
  }

  const command = String(params.command || '').trim();
  if (!command) {
    return { detectorId: 'DET-07', triggered: false, decision: 'allow', reason: null };
  }

  // Unbounded `git log` without `-n`, `--max-count`, `-<number>`, `head`, or `Select-Object`
  if (
    /\bgit\s+log\b/i.test(command) &&
    !/(?:\s-[n]\s*\d+|\s-\d+\b|--max-count|--oneline\s+-\d+|\|\s*(?:head|tail|Select-Object))/i.test(
      command
    )
  ) {
    return {
      detectorId: 'DET-07',
      triggered: true,
      decision: 'deny',
      subType: 'UNBOUNDED_GIT_LOG',
      reason: `[DET-07 Unbounded Output Bomb Guard] Unbounded "git log" can flood the context window. Add "-n 20" or "--max-count=20".`
    };
  }

  // Unpaged `cat` or `Get-Content` on massive lockfiles or `.jsonl` transcripts
  if (
    /\b(?:cat|Get-Content|type)\s+\S*(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|\.jsonl)\b/i.test(
      command
    ) &&
    !/(?:\|\s*(?:head|tail|Select-Object)|-TotalCount\s+\d+|-Tail\s+\d+)/i.test(command)
  ) {
    return {
      detectorId: 'DET-07',
      triggered: true,
      decision: 'deny',
      subType: 'UNPAGED_LARGE_FILE_DUMP',
      reason: `[DET-07 Unbounded Output Bomb Guard] Dumping entire lockfiles or JSONL transcripts without line limits floods the KV cache. Use head/tail or Grep.`
    };
  }

  return { detectorId: 'DET-07', triggered: false, decision: 'allow', reason: null };
}

/**
 * DET-11: Context Rot Soft Horizon Gate (`> 60k` tokens and middle distractor ratio `[D] > 35%`).
 *
 * @param {object} [params={}]
 * @param {number} [params.totalInputTokens=0]
 * @param {number} [params.distractorTokens=0]
 * @param {number} [params.distractorRatio]
 */
export function evaluateDet11ContextRotGate(params = {}) {
  const totalInputTokens = Math.max(
    0,
    Number(params.totalInputTokens ?? params.totalPromptTokens ?? 0)
  );
  let distractorTokens = 0;
  let distractorRatio = 0;

  if (params.distractorTokens !== undefined && params.distractorTokens !== null) {
    distractorTokens = Math.max(0, Number(params.distractorTokens || 0));
    distractorRatio =
      totalInputTokens > 0 ? Number((distractorTokens / totalInputTokens).toFixed(4)) : 0;
  } else if (params.distractorRatio !== undefined && params.distractorRatio !== null) {
    const rawRatio = Math.max(0, Number(params.distractorRatio || 0));
    distractorRatio = Number((rawRatio > 1 ? rawRatio / 100 : rawRatio).toFixed(4));
    distractorTokens = Math.round(totalInputTokens * distractorRatio);
  }

  // Sim 05: Post-commit topic shift check
  const lastTurnGitCommitted = Boolean(params.lastTurnGitCommitted ?? params.last_turn_git_committed);
  const topicShiftDetected = Boolean(params.topicShiftDetected ?? params.topic_shift ?? params.topicShift);
  const turnId = Number(params.turnId ?? params.currentTurn ?? 0);
  const postCommitTopicShift = Boolean(
    params.postCommitTopicShift ??
    (lastTurnGitCommitted && topicShiftDetected && (turnId === 0 || turnId >= 15) && totalInputTokens >= 25_000)
  );

  if (postCommitTopicShift) {
    return {
      detectorId: 'DET-11',
      triggered: true,
      decision: 'advise_compact',
      advisory: true,
      subType: 'POST_COMMIT_TOPIC_SHIFT',
      totalInputTokens,
      distractorTokens,
      distractorRatio,
      reason: `[DET-11 Context Rot Soft Horizon] Post-commit topic shift detected (${(totalInputTokens / 1000).toFixed(1)}k tokens). Previous task was committed; run /compact or /handoff to clear stale context before new feature.`
    };
  }

  if (totalInputTokens > 60_000 && distractorRatio > 0.35) {
    return {
      detectorId: 'DET-11',
      triggered: true,
      decision: 'advise_compact',
      advisory: true,
      totalInputTokens,
      distractorTokens,
      distractorRatio,
      reason: `[DET-11 Context Rot Soft Horizon] Context is ${(totalInputTokens / 1000).toFixed(1)}k tokens with ${(distractorRatio * 100).toFixed(1)}% stale middle-window distractor debt (> 35%). Recommend /compact with StateBaton handoff.`
    };
  }

  return {
    detectorId: 'DET-11',
    triggered: false,
    decision: 'allow',
    totalInputTokens,
    distractorTokens,
    distractorRatio,
    reason: null
  };
}

/**
 * DET-12: Haiku 5.5 `90,000`-Token Pre-Cliff Compaction Breaker (prevents crossing 100k `5x` cliff).
 * Sums `inputTokens + cacheReadTokens + cacheWriteTokens` when `totalPromptTokens` / `totalInputTokens`
 * is not pre-computed so the full prompt envelope is always evaluated against the 100,000-token cliff.
 *
 * @param {object} [params={}]
 * @param {string} [params.modelId='claude-haiku-5-5']
 * @param {number} [params.totalInputTokens=0]
 * @param {number} [params.totalPromptTokens]
 * @param {number} [params.inputTokens]
 * @param {number} [params.cacheReadTokens]
 * @param {number} [params.cacheWriteTokens]
 */
export function evaluateDet12HaikuPreCliffBreaker(params = {}) {
  const modelId = normalizeModelId(params.modelId || params.model || '');
  const totalInputTokens = computeTotalPromptTokens(params);

  if (modelId === 'claude-haiku-5-5' && totalInputTokens >= 90_000) {
    const isHardDeny = totalInputTokens >= 98_000;
    return {
      detectorId: 'DET-12',
      triggered: true,
      decision: isHardDeny ? 'deny' : 'advise_compact',
      advisory: !isHardDeny,
      modelId,
      totalInputTokens,
      cliffThresholdTokens: 100_000,
      reason: `[DET-12 Haiku 5.5 90k Pre-Cliff Breaker] Total prompt size (${totalInputTokens.toLocaleString()} tokens) is approaching Claude Haiku 5.5's 100,000-token 5x price cliff ($0.10->$0.50 input, $0.50->$2.50 output). Compact now to avoid a 5x jump across all token categories.`
    };
  }

  return {
    detectorId: 'DET-12',
    triggered: false,
    decision: 'allow',
    modelId,
    totalInputTokens,
    reason: null
  };
}
