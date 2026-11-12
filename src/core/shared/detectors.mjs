/**
 * Pure Zero-I/O Cross-Repo Capability Portfolio Evaluators (Ranks 1–12)
 * (`src/core/shared/detectors.mjs`)
 *
 * Normalized Cross-Repo Detector IDs:
 *  - DET-02  (Rank 11): Zero-Token PreInvocation Secret & Mega-Dump Hold + Sensitive File Guard
 *  - DET-04  (Rank 5) : 3-Strike Consecutive Tool Failure Breaker
 *  - DET-05  (Rank 1) : Pre-Write Destructive Code-Strip, Test-Assertion & 6-Turn FNV-1a Flip-Flop Guard
 *  - DET-06  (Rank 2) : Unmodified File Re-Read & GitClear Blind-Edit Guard
 *  - DET-06B (Rank 6) : Lean Flash Subagent Search Offloader (@ah-flash-scout)
 *  - DET-07  (Rank 3) : Exit-Safe CLI Compressor (30-head + 45-tail + 100% error recovery)
 *  - DET-08  (Rank 7) : KV-Cache Gravity & Same-Model Between-Turn Effort Router
 *  - DET-10  (Rank 8) : Idle 5m Implicit-Cache Watchdog & Cold-Resume Baton Pulse
 *  - DET-13  (Rank 10): Eager MCP Override & Startup Bloat Auditor
 *  - DET-16  (Rank 12): 80% Hybrid Quota Fan-Out Throttle & 40k/12-Turn Subagent Cap
 *  - DET-17  (Rank 4) : 70k Cascade Progressive Checkpoints & Premature /compact Suppressor
 *  - DET-20  (Rank 12): Vision Overage HTTP 400 Quirk Guard
 *  - RSI-01  (Rank 9) : Skill Fault Router & /evolve Prefix Diet (>8k tokens, >=5 instincts)
 */

import { evaluateFnv1aRingBuffer, fnv1a64Hex } from './fnv1a64.mjs';
import {
  LIVE_SECRET_DEFINITIONS,
  isPlaceholderSecretValue,
  computeShannonEntropy,
  redactSecretsPure
} from './ipi_sanitizer.mjs';
import {
  CASCADE_COMPACTION_CEILING_TOKENS,
  CASCADE_CHECKPOINT_BANDS
} from './handoff_schema.mjs';

export const NORMALIZED_PORTFOLIO_DETECTORS = Object.freeze({
  'DET-02': { id: 'DET-02', rank: 11, name: 'Zero-Token PreInvocation Secret & Mega-Dump Hold' },
  'DET-04': { id: 'DET-04', rank: 5, name: '3-Strike Consecutive Tool Failure Breaker' },
  'DET-05': { id: 'DET-05', rank: 1, name: 'Pre-Write Destructive Code-Strip & Test-Assertion Guard' },
  'DET-06': { id: 'DET-06', rank: 2, name: 'Unmodified File Re-Read & GitClear Blind-Edit Guard' },
  'DET-06B': { id: 'DET-06B', rank: 6, name: 'Lean Flash Subagent Search Offloader' },
  'DET-07': { id: 'DET-07', rank: 3, name: 'Exit-Safe CLI Compressor & 5 MB FTS5 Archive' },
  'DET-08': { id: 'DET-08', rank: 7, name: 'KV-Cache Gravity & Between-Turn Effort Router' },
  'DET-10': { id: 'DET-10', rank: 8, name: 'Idle Implicit-Cache Watchdog & Cold-Resume Baton Pulse' },
  'DET-13': { id: 'DET-13', rank: 10, name: 'Eager MCP Override & Startup Bloat Auditor' },
  'DET-16': { id: 'DET-16', rank: 12, name: '80% Hybrid Quota Fan-Out Throttle & Subagent Cap' },
  'DET-17': { id: 'DET-17', rank: 4, name: '70k Cascade Progressive Checkpoints & Baton-Pass Coach' },
  'DET-20': { id: 'DET-20', rank: 12, name: 'Vision Overage HTTP 400 Quirk Guard' },
  'RSI-01': { id: 'RSI-01', rank: 9, name: 'Skill Fault Router & /evolve Prefix Diet' }
});

// ============================================================================
// Rank 1 (DET-05): Pre-Write Destructive Code-Strip & Test-Assertion Guard
// ============================================================================

export const CLEANUP_INTENT_RE = /\b(delete|remove|deprecate|drop|prune)\b/i;

export const LAZY_ELISION_PATTERNS = Object.freeze([
  /\/\/\s*\.\.\.\s*(?:rest\s+of\s+(?:code|file|implementation|function|class)|existing\s+(?:code|implementation|logic)|unchanged|keep\s+existing|omitted|remaining\s+code)/i,
  /\/\*\s*\.\.\.\s*(?:rest\s+of\s+(?:code|file|implementation)|existing\s+(?:code|implementation)|unchanged|omitted)[\s\S]*?\*\//i,
  /#\s*\.\.\.\s*(?:rest\s+of\s+(?:code|file|implementation)|existing\s+(?:code|implementation)|unchanged|omitted)/i,
  /\/\/\s*existing\s+implementation\b/i,
  /\/\/\s*rest\s+of\s+code\b/i
]);

export function isTestOrSpecFilePath(filePath = '') {
  const norm = String(filePath || '').replace(/\\/g, '/');
  return /(?:^|\/)(?:tests?|__tests__|specs?)\//i.test(norm) || /\.(?:test|spec)\.[a-z0-9]+$/i.test(norm);
}

export function countTryCatchBlocks(code = '') {
  const matches = String(code || '').match(/\btry\s*\{[\s\S]*?\}\s*catch\b/g);
  return matches ? matches.length : 0;
}

export function countTestAssertions(code = '') {
  const text = String(code || '');
  const matches = text.match(/(?:\bassert(?:\.[a-zA-Z0-9_]+|\s*\()|\bexpect\s*\(|\bt\.assert\b|\.[a-zA-Z0-9_]*should\b)/g);
  return matches ? matches.length : 0;
}

/**
 * Simulates the resulting file buffer BEFORE disk mutation for full-write and partial-replace tools.
 */
export function simulateProposedFileBuffer(toolName = '', toolArgs = {}, currentDiskContent = '') {
  const name = String(toolName || '').toLowerCase();
  const args = toolArgs && typeof toolArgs === 'object' ? toolArgs : {};
  const existing = String(currentDiskContent ?? '');

  if (/^(write_to_file|write_file|write)$/.test(name)) {
    const proposed = args.CodeContent ?? args.Content ?? args.content ?? args.newContent ?? '';
    return { supported: true, isFullWrite: true, proposedContent: String(proposed) };
  }

  if (/^(replace_file_content|edit_file|edit)$/.test(name)) {
    const target = args.TargetContent ?? args.Target ?? args.old_string ?? args.oldText;
    const replacement = args.ReplacementContent ?? args.Replacement ?? args.new_string ?? args.newText ?? '';
    if (typeof target === 'string' && target.length > 0 && existing.includes(target)) {
      const nextBuf = existing.replace(target, () => String(replacement));
      return { supported: true, isFullWrite: false, proposedContent: nextBuf, hunkText: String(replacement) };
    }
    if (typeof replacement === 'string') {
      return { supported: true, isFullWrite: false, proposedContent: existing, hunkText: String(replacement), hunkUnmatched: true };
    }
  }

  if (/^(multi_replace_file_content|multiedit|multi_edit)$/.test(name)) {
    const chunks = Array.isArray(args.ReplacementChunks)
      ? args.ReplacementChunks
      : (Array.isArray(args.edits) ? args.edits : []);
    let working = existing;
    const hunkParts = [];
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const t = chunk.TargetContent ?? chunk.Target ?? chunk.old_string;
      const r = chunk.ReplacementContent ?? chunk.Replacement ?? chunk.new_string ?? '';
      hunkParts.push(String(r));
      if (typeof t === 'string' && t.length > 0 && working.includes(t)) {
        working = working.replace(t, () => String(r));
      }
    }
    return { supported: true, isFullWrite: false, proposedContent: working, hunkText: hunkParts.join('\n') };
  }

  return { supported: false, isFullWrite: false, proposedContent: existing };
}

export function evaluateDet05PreWriteIntegrity({
  toolName = '',
  toolArgs = {},
  filePath = '',
  currentDiskContent = null,
  userPrompt = '',
  flightMode = 'COACH',
  fnvRing = [],
  turn = 0
} = {}) {
  const sim = simulateProposedFileBuffer(toolName, toolArgs, currentDiskContent ?? '');
  if (!sim.supported) {
    return { detectorId: 'DET-05', triggered: false, violations: [], ring: fnvRing };
  }

  const proposed = sim.proposedContent;
  const checkSurface = sim.hunkUnmatched ? (sim.hunkText || '') : proposed;
  const hasCleanupIntent = CLEANUP_INTENT_RE.test(String(userPrompt || ''));
  const violations = [];

  // 1. Lazy elision placeholder check (always active, even on new files or partial hunks)
  const hadElisionBefore = typeof currentDiskContent === 'string'
    && LAZY_ELISION_PATTERNS.some((re) => re.test(currentDiskContent));
  if (!hadElisionBefore && LAZY_ELISION_PATTERNS.some((re) => re.test(checkSurface))) {
    violations.push('LAZY_ELISION_PLACEHOLDER');
  }

  // 2. Compare against existing file on disk when present
  if (typeof currentDiskContent === 'string' && currentDiskContent.length > 0 && !sim.hunkUnmatched) {
    const beforeLinesArr = currentDiskContent.split(/\r?\n/);
    const afterLinesArr = proposed.split(/\r?\n/);
    const beforeLines = beforeLinesArr.length;
    const afterLines = afterLinesArr.length;

    if (!hasCleanupIntent) {
      // Full-file regurgitation check on full-file writes (>= 300 lines with >= 90% lines unchanged)
      if (sim.isFullWrite && beforeLines >= 300 && afterLines >= Math.floor(beforeLines * 0.9)) {
        const beforeMap = new Map();
        for (const line of beforeLinesArr) {
          const trimmed = line.trim();
          beforeMap.set(trimmed, (beforeMap.get(trimmed) || 0) + 1);
        }
        let unchangedCount = 0;
        for (const line of afterLinesArr) {
          const trimmed = line.trim();
          const count = beforeMap.get(trimmed) || 0;
          if (count > 0) {
            unchangedCount++;
            beforeMap.set(trimmed, count - 1);
          }
        }
        const changedLines = beforeLines - unchangedCount;
        if (unchangedCount / beforeLines >= 0.90 && changedLines <= Math.max(25, Math.floor(beforeLines * 0.10))) {
          violations.push(`FULL_FILE_REGURGITATION (${unchangedCount}/${beforeLines} lines unchanged — use surgical edit_file/replace_file_content instead of rewriting the full file)`);
        }
      }

      // > 50% shrinkage on files >= 40 lines
      if (beforeLines >= 40 && afterLines < beforeLines * 0.5) {
        const shrinkPct = Math.round(((beforeLines - afterLines) / beforeLines) * 100);
        violations.push(`UNREQUESTED_FILE_SHRINKAGE_${shrinkPct}PCT (${beforeLines}->${afterLines} lines)`);
      }

      // Stripped try/catch without replacement
      const beforeTry = countTryCatchBlocks(currentDiskContent);
      const afterTry = countTryCatchBlocks(proposed);
      if (beforeTry > 0 && afterTry < beforeTry) {
        violations.push(`STRIPPED_TRY_CATCH (${beforeTry}->${afterTry})`);
      }

      // Deleted test assertions in test/spec files
      if (isTestOrSpecFilePath(filePath)) {
        const beforeAsserts = countTestAssertions(currentDiskContent);
        const afterAsserts = countTestAssertions(proposed);
        if (beforeAsserts > 0 && afterAsserts < beforeAsserts) {
          violations.push(`DELETED_TEST_ASSERTIONS (${beforeAsserts}->${afterAsserts})`);
        }
      }
    }
  }

  // 3. 6-Turn 64-bit FNV-1a Ring Buffer Flip-Flop Check (State A -> State B -> State A)
  const ringEval = evaluateFnv1aRingBuffer(fnvRing, proposed, {
    turn,
    maxEntries: 6,
    initialContent: typeof currentDiskContent === 'string' ? currentDiskContent : null
  });
  if (ringEval.oscillationDetected) {
    violations.push(`EDIT_FLIP_FLOP_FNV1A64 (reverted to Turn ${ringEval.matchedTurn} hash ${ringEval.hash.slice(0, 8)})`);
  }

  if (violations.length === 0) {
    return {
      detectorId: 'DET-05',
      triggered: false,
      decision: 'allow',
      violations: [],
      hash: ringEval.hash,
      ring: ringEval.ring
    };
  }

  const mode = String(flightMode || 'COACH').toUpperCase();
  const contractGuidance =
    '3-Stage Design-by-Contract: (1) State invariant & pre-conditions, (2) Apply minimal surgical diff preserving error handling & assertions, (3) Verify post-conditions via test suite.';
  const reason = `[DET-05] Pre-write integrity violation on ${filePath || 'target'}: ${violations.join('; ')}. ${contractGuidance}`;

  return {
    detectorId: 'DET-05',
    triggered: true,
    decision: mode === 'AUTO_PILOT' ? 'deny' : 'allow',
    hudAlert: reason,
    reason,
    violations,
    cleanupExempted: false,
    hash: ringEval.hash,
    ring: ringEval.ring
  };
}

// ============================================================================
// Rank 2 (DET-06): Unmodified File Re-Read & GitClear Blind-Edit Guard
// ============================================================================

export const SOURCE_CODE_EXT_RE = /\.(mjs|js|ts|tsx|py|go|rs)$/i;
export const BLIND_EDIT_EXEMPT_PATH_RE =
  /(?:^|\/)(?:migrations|docs)\/|\.(?:test|spec)\.[a-z0-9]+$|\.md$/i;

function isRangeCovered(prevStart, prevEnd, reqStart, reqEnd) {
  // Full-file read previously covers any subsequent full or partial read
  if (prevStart == null && prevEnd == null) return true;
  // Previous read was partial, new read is full-file -> NOT covered
  if (reqStart == null || reqEnd == null) return false;
  const pS = Number(prevStart);
  const pE = Number(prevEnd ?? Number.MAX_SAFE_INTEGER);
  const rS = Number(reqStart);
  const rE = Number(reqEnd);
  return rS >= pS && rE <= pE;
}

export function evaluateDet06UnmodifiedReRead({
  absPath = '',
  sha256 = '',
  mtimeMs = 0,
  startLine = null,
  endLine = null,
  currentTurn = 1,
  readLedger = [],
  flightMode = 'COACH'
} = {}) {
  const normPath = String(absPath || '').replace(/\\/g, '/');
  const entries = Array.isArray(readLedger) ? readLedger : [];

  const matchingPrior = entries.find((entry) => {
    if (!entry || String(entry.absPath || '').replace(/\\/g, '/') !== normPath) return false;
    const sameHash = Boolean(sha256 && entry.sha256 && sha256 === entry.sha256);
    const sameMtime = !sha256 && !entry.sha256 && mtimeMs > 0 && entry.mtimeMs === mtimeMs;
    if (!sameHash && !sameMtime) return false;
    return isRangeCovered(entry.startLine, entry.endLine, startLine, endLine);
  });

  const nextEntry = {
    absPath: normPath,
    sha256: String(sha256 || ''),
    mtimeMs: Number(mtimeMs || 0),
    startLine: startLine != null ? Number(startLine) : null,
    endLine: endLine != null ? Number(endLine) : null,
    turnRead: Number(currentTurn || 1)
  };

  if (!matchingPrior) {
    return {
      detectorId: 'DET-06',
      triggered: false,
      decision: 'allow',
      updatedLedger: [...entries, nextEntry]
    };
  }

  const mode = String(flightMode || 'COACH').toUpperCase();
  const reason = `[DET-06] Unmodified since Turn ${matchingPrior.turnRead}; reuse in-context buffer`;
  return {
    detectorId: 'DET-06',
    subType: 'UNMODIFIED_REREAD',
    triggered: true,
    decision: mode === 'AUTO_PILOT' ? 'deny' : 'allow',
    reason,
    hudAlert: `${reason} (${normPath})`,
    turnRead: matchingPrior.turnRead,
    updatedLedger: entries
  };
}

export function evaluateDet06BlindNewModule({
  targetPath = '',
  overwrite = false,
  fileAlreadyExists = false,
  discoveryCallsCount = 0,
  siblingSourceFileCount = 3,
  userPrompt = '',
  flightMode = 'COACH',
  editedFilesCount = 0,
  turnCount = 1
} = {}) {
  const mode = String(flightMode || 'COACH').toUpperCase();
  const norm = String(targetPath || '').replace(/\\/g, '/');

  if (norm && (!SOURCE_CODE_EXT_RE.test(norm) || BLIND_EDIT_EXEMPT_PATH_RE.test(norm))) {
    return { detectorId: 'DET-06', triggered: false, decision: 'allow', exemptReason: 'PATH_EXEMPT' };
  }

  // Turn 1 blind multi-file edit check on non-exempt source files (TDD *.test.*/*.spec.* companion files exempted)
  const hasSpecificAnchor = /(?:^|\s)@[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/.test(String(userPrompt || ''));
  const nonTestEditedCount = Array.isArray(arguments[0]?.editedFiles)
    ? arguments[0].editedFiles.filter((p) => {
        const np = String(p || '').replace(/\\/g, '/');
        return SOURCE_CODE_EXT_RE.test(np) && !BLIND_EDIT_EXEMPT_PATH_RE.test(np) && !isTestOrSpecFilePath(np);
      }).length
    : Number(editedFilesCount || 0);

  if (turnCount <= 1 && nonTestEditedCount >= 2 && Number(discoveryCallsCount) === 0 && !hasSpecificAnchor) {
    const reason = `[DET-06] Blind unplanned multi-file edit on Turn 1 (${nonTestEditedCount} non-test source files modified) with 0 prior read/search discovery calls; verify existing code or create a plan first.`;
    return {
      detectorId: 'DET-06',
      subType: 'BLIND_UNPLANNED_MULTI_EDIT',
      triggered: true,
      decision: mode === 'AUTO_PILOT' ? 'ask' : 'allow',
      reason,
      hudAlert: reason
    };
  }

  if (!norm || overwrite === true || fileAlreadyExists === true) {
    return { detectorId: 'DET-06', triggered: false, decision: 'allow' };
  }
  if (Number(siblingSourceFileCount) < 3) {
    return { detectorId: 'DET-06', triggered: false, decision: 'allow', exemptReason: 'GREENFIELD_DIR' };
  }
  const baseName = norm.split('/').pop() || '';
  if (baseName && String(userPrompt || '').includes(baseName)) {
    return { detectorId: 'DET-06', triggered: false, decision: 'allow', exemptReason: 'USER_NAMED_FILE' };
  }
  if (Number(discoveryCallsCount) > 0) {
    return { detectorId: 'DET-06', triggered: false, decision: 'allow' };
  }

  const reason = `[DET-06] Creating new module "${norm}" with 0 prior grep_search/find_by_name/list_dir calls; verify existing utilities first to prevent duplicate modules.`;
  return {
    detectorId: 'DET-06',
    subType: 'BLIND_NEW_MODULE',
    triggered: true,
    decision: mode === 'AUTO_PILOT' ? 'ask' : 'allow',
    reason,
    hudAlert: reason
  };
}

/**
 * DET-07: Guard against unbounded reads of package-lock.json, pnpm-lock.yaml, and minified bundles.
 * Strictly adheres to Active Source File Protection: active source files (.ts, .js, etc.) are never blocked.
 */
export function evaluateDet07IgnorableFileReadGuard({
  toolName = '',
  targetPath = '',
  startLine = null,
  endLine = null,
  limit = null,
  flightMode = 'COACH'
} = {}) {
  const name = String(toolName || '').toLowerCase();
  if (!/^(view_file|read_file|read)$/i.test(name)) {
    return { detectorId: 'DET-07', triggered: false, decision: 'allow' };
  }
  const norm = String(targetPath || '').replace(/\\/g, '/');
  const isLockfileOrBundle =
    /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$/i.test(norm) ||
    /\.(?:min\.js|bundle\.min\.js|bundle\.js|min\.css|map)$/i.test(norm) ||
    /(?:^|\/)(dist|build|\.next|out)\/.*\.(?:js|json|css)$/i.test(norm);

  if (!isLockfileOrBundle) {
    return { detectorId: 'DET-07', triggered: false, decision: 'allow' };
  }

  const isBounded =
    (startLine != null && endLine != null && (Number(endLine) - Number(startLine)) <= 100) ||
    (Number(limit) > 0 && Number(limit) <= 100);

  if (isBounded) {
    return { detectorId: 'DET-07', triggered: false, decision: 'allow' };
  }

  const mode = String(flightMode || 'COACH').toUpperCase();
  const base = norm.split('/').pop() || 'lockfile';
  const reason = `[DET-07] Unbounded read of lockfile or minified bundle ("${base}"). Dumping full lockfile/bundle wastes context. Inspect package.json or use StartLine/EndLine <= 100.`;
  return {
    detectorId: 'DET-07',
    subType: 'LOCKFILE_OR_BUNDLE_READ_BLOCKED',
    triggered: true,
    decision: mode === 'AUTO_PILOT' ? 'deny' : 'allow',
    reason,
    hudAlert: reason
  };
}

// ============================================================================
// Rank 5 (DET-04): 3-Strike Consecutive Tool Failure Breaker
// ============================================================================

export function normalizeToolTargetKey(toolName = '', toolArgs = {}) {
  const name = String(toolName || '').toLowerCase().trim();
  const args = toolArgs && typeof toolArgs === 'object' ? toolArgs : {};
  const rawTarget = String(
    args.CommandLine || args.command || args.cmd || args.Path || args.path || args.TargetFile || args.Query || args.Pattern || ''
  )
    .trim()
    .replace(/\s+/g, () => ' ');
  const prefix = rawTarget.slice(0, 48).toLowerCase();
  return `${name}::${prefix || '*'}`;
}

export function evaluateDet04ConsecutiveFailureBreaker({
  toolName = '',
  toolArgs = {},
  failureStreaks = {},
  currentTurn = 1,
  lastAlertTurnByKey = {},
  cooldownTurns = 3,
  flightMode = 'COACH'
} = {}) {
  const key = normalizeToolTargetKey(toolName, toolArgs);
  const streaks = failureStreaks && typeof failureStreaks === 'object' ? { ...failureStreaks } : {};
  const alerts = lastAlertTurnByKey && typeof lastAlertTurnByKey === 'object' ? { ...lastAlertTurnByKey } : {};
  const priorFailures = Number(streaks[key] || 0);

  if (priorFailures < 3) {
    return {
      detectorId: 'DET-04',
      triggered: false,
      decision: 'allow',
      key,
      consecutiveFailures: priorFailures
    };
  }

  const mode = String(flightMode || 'COACH').toUpperCase();
  const reason = `[DET-04] ${priorFailures} consecutive failures on "${key}". State a root-cause hypothesis or inspect state before a 4th retry.`;
  const lastTurn = alerts[key];
  const inCooldown = typeof lastTurn === 'number' && (Number(currentTurn) - lastTurn) < Number(cooldownTurns);
  if (!inCooldown) {
    alerts[key] = Number(currentTurn);
  }

  return {
    detectorId: 'DET-04',
    triggered: true,
    decision: mode === 'AUTO_PILOT' ? 'deny' : 'allow',
    reason,
    hudAlert: inCooldown ? null : reason,
    inCooldown,
    key,
    consecutiveFailures: priorFailures,
    lastAlertTurnByKey: alerts
  };
}

export function recordToolOutcomeForDet04({
  toolName = '',
  toolArgs = {},
  failed = false,
  failureStreaks = {}
} = {}) {
  const streaks = failureStreaks && typeof failureStreaks === 'object' ? { ...failureStreaks } : {};
  const name = String(toolName || '').toLowerCase();

  // Successful source edit resets command/test streaks so fixed code can be re-tested immediately
  if (!failed && /^(write_to_file|write_file|replace_file_content|multi_replace_file_content|edit_file|edit)$/.test(name)) {
    return {};
  }

  const key = normalizeToolTargetKey(toolName, toolArgs);
  if (failed) {
    streaks[key] = Number(streaks[key] || 0) + 1;
  } else {
    delete streaks[key];
  }
  return streaks;
}

// ============================================================================
// Rank 3 (DET-07): Exit-Safe CLI Output Noise Stripper & Head/Tail/Error Slicer
// ============================================================================

export const DET07_ERROR_LINE_RE =
  /(?:Error|Exception|FAIL|FAILED|AssertionError|SyntaxError|error\[E|panic:|ERR!)/;

const PROGRESS_NOISE_LINE_RE =
  /^(?:\s*(?:\[[\s=#>-]{4,}\]|\d{1,3}%\s*[|█▉▊▋▌▍▎▏-]+|(?:Downloading|Downloaded|Fetch|Fetching)\s+\S+\s*\.\.\.|npm\s+http\s+fetch|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s*)$/i;

const PASSING_BOILERPLATE_LINE_RE =
  /^\s*(?:✓|✔|PASS\s+\S+|ok\s+\d+\s+-\s+|\.\.\.\s*ok\s*$|test\s+\S+\s+\.\.\.\s+ok\s*$)/;

export function compressCliOutputPure(rawOutput = '', {
  headCount = 30,
  tailCount = 45,
  archiveThresholdChars = 4096,
  queryHint = 'node .agents/shims/ah_log_query.mjs "<term>"'
} = {}) {
  const raw = String(rawOutput ?? '');
  // 1. Strip ANSI CSI/OSC sequences
  const noAnsi = raw.replace(
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g,
    () => ''
  );

  // 2. Collapse \r spinner overwrites and filter pure progress/passing boilerplate
  const rawLines = noAnsi.split(/\r?\n/);
  const filteredLines = [];
  for (const rawLine of rawLines) {
    const collapsed = rawLine.includes('\r')
      ? (rawLine.split('\r').filter((seg) => seg.length > 0).pop() || '')
      : rawLine;
    if (DET07_ERROR_LINE_RE.test(collapsed)) {
      filteredLines.push(collapsed);
      continue;
    }
    if (PROGRESS_NOISE_LINE_RE.test(collapsed) || PASSING_BOILERPLATE_LINE_RE.test(collapsed)) {
      continue;
    }
    filteredLines.push(collapsed);
  }

  const exceedsThreshold = raw.length > archiveThresholdChars;
  if (!exceedsThreshold && filteredLines.length <= headCount + tailCount) {
    const joined = filteredLines.join('\n');
    return {
      detectorId: 'DET-07',
      compressed: joined !== raw,
      archived: false,
      output: joined,
      rawBytes: raw.length,
      compressedBytes: joined.length,
      bytesSaved: Math.max(0, raw.length - joined.length),
      preservedErrorLineCount: filteredLines.filter((l) => DET07_ERROR_LINE_RE.test(l)).length
    };
  }

  const head = filteredLines.slice(0, headCount);
  const tailStartIdx = Math.max(headCount, filteredLines.length - tailCount);
  const middle = filteredLines.slice(headCount, tailStartIdx);
  const middleErrors = middle.filter((line) => DET07_ERROR_LINE_RE.test(line));
  const tail = filteredLines.slice(tailStartIdx);

  const omittedCount = Math.max(0, middle.length - middleErrors.length);
  const outParts = [...head];
  if (omittedCount > 0 || middleErrors.length > 0) {
    outParts.push(`... [${omittedCount} noisy/passing line(s) elided; ${middleErrors.length} middle error line(s) preserved] ...`);
    outParts.push(...middleErrors);
  }
  outParts.push(...tail);
  if (exceedsThreshold && queryHint) {
    outParts.push(`[DET-07 FTS5 Archive] Query full redacted log: ${queryHint}`);
  }

  const compressedText = outParts.join('\n');
  const allErrorCount = outParts.filter((l) => DET07_ERROR_LINE_RE.test(l)).length;
  return {
    detectorId: 'DET-07',
    compressed: true,
    archived: exceedsThreshold,
    output: compressedText,
    rawBytes: raw.length,
    compressedBytes: compressedText.length,
    bytesSaved: Math.max(0, raw.length - compressedText.length),
    preservedErrorLineCount: allErrorCount
  };
}

// ============================================================================
// Rank 11 (DET-02): Zero-Token PreInvocation Secret & Mega-Dump Hold + Env Deny
// ============================================================================

const SENSITIVE_FILE_PATH_RE =
  /(?:^|[\\/])(?:\.env(?:\.[A-Za-z0-9_.-]+)?|id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts)$|\.(?:pem|key|p12|pfx)$|(?:^|[\\/])\.ssh[\\/]/i;

const SAFE_ENV_TEMPLATE_RE = /\.(?:example|sample|template|dist|schema)$/i;

export function isSensitiveCredentialPath(resolvedPath = '') {
  const norm = String(resolvedPath || '').replace(/\\/g, '/').trim();
  if (!norm || SAFE_ENV_TEMPLATE_RE.test(norm)) return false;
  return SENSITIVE_FILE_PATH_RE.test(norm);
}

export function evaluateDet02PreInvocationHold({
  prompt = '',
  invocationNum = 1,
  flightMode = 'COACH',
  megaDumpThresholdChars = 20000
} = {}) {
  if (Number(invocationNum) > 1) {
    return { detectorId: 'DET-02', triggered: false, fastExit: true, output: {} };
  }

  const text = String(prompt ?? '');
  if (!text) {
    return { detectorId: 'DET-02', triggered: false, fastExit: false, output: {} };
  }

  const allowSecret = text.includes('[ah:allow-secret]');
  if (!allowSecret) {
    const matchedLabels = [];
    for (const def of LIVE_SECRET_DEFINITIONS) {
      const re = new RegExp(def.re.source, def.re.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const token = m[0];
        if (def.id === 'pem_private_key' || !isPlaceholderSecretValue(token)) {
          matchedLabels.push(def.label);
          break;
        }
      }
    }

    // High-entropy .env assignment check
    const envLines = text.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})\s*=\s*(['"]?)([^\s'"\r\n#]{20,})\2\s*$/gm);
    for (const match of envLines) {
      const key = match[1];
      const val = match[3];
      if (isPlaceholderSecretValue(val)) continue;
      if (/^(?:PATH|HOME|PYTHONPATH|NODE_OPTIONS|DATABASE_URL)$/i.test(key) && !/:\/\/[^:]+:[^@]+@/.test(val)) {
        continue;
      }
      if (computeShannonEntropy(val) >= 3.6) {
        matchedLabels.push(`High-entropy .env assignment (${key})`);
        break;
      }
    }

    if (matchedLabels.length > 0) {
      const userMessage = `[DET-02 Secret Hold] Blocked live credential paste (${matchedLabels[0]}) at 0 tokens. Store secrets in .env and reference variable names instead (or include [ah:allow-secret] for synthetic fixtures).`;
      return {
        detectorId: 'DET-02',
        subType: 'LIVE_SECRET',
        triggered: true,
        blocked: true,
        matchedLabels,
        output: {
          terminationBehavior: 'terminate',
          errorMessage: { userMessage }
        }
      };
    }
  }

  // Raw Mega-Dump check (>= 20,000 chars without @file or [ah:allow-paste])
  const allowPaste = text.includes('[ah:allow-paste]');
  const hasFileRef = /(?:^|\s)@[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/.test(text);
  if (!allowPaste && !hasFileRef && text.length >= megaDumpThresholdChars) {
    const mode = String(flightMode || 'COACH').toUpperCase();
    const msg = `[DET-02 Mega-Dump Hold] Raw paste is ${text.length.toLocaleString('en-US')} chars (>= ${megaDumpThresholdChars.toLocaleString('en-US')}). Save to a workspace file and reference via @file (or add [ah:allow-paste]).`;
    if (mode === 'AUTO_PILOT') {
      return {
        detectorId: 'DET-02',
        subType: 'MEGA_DUMP',
        triggered: true,
        blocked: true,
        output: {
          terminationBehavior: 'terminate',
          errorMessage: { userMessage: msg }
        }
      };
    }
    return {
      detectorId: 'DET-02',
      subType: 'MEGA_DUMP',
      triggered: true,
      blocked: false,
      hudHint: msg,
      output: {}
    };
  }

  return { detectorId: 'DET-02', triggered: false, fastExit: false, output: {} };
}

// ============================================================================
// Rank 10 (DET-13): Eager MCP Override & Startup Bloat Auditor
// ============================================================================

export function evaluateDet13EagerMcpAuditor({
  servers = [],
  eagerTokenThreshold = 15000,
  bundledSkillsTokens = 0,
  syncedSkillsTokens = 0,
  mcpSchemaTokens = 0,
  claudeMdTokens = 0,
  turnsElapsed = 0,
  mcpInvocations = 0
} = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const eagerOverrides = [];
  const unreachableServers = [];
  let totalEagerTokens = 0;

  for (const srv of list) {
    if (!srv || typeof srv !== 'object') continue;
    const name = String(srv.name || 'unnamed-mcp');
    const isExplicitEager = srv.eager === true || srv.lazy === false || srv.loadingMode === 'eager';
    const estTokens = Math.max(0, Number(srv.estimatedTokens ?? srv.tokenCount ?? (isExplicitEager ? 2500 : 0)));

    if (isExplicitEager) {
      eagerOverrides.push(name);
      totalEagerTokens += estTokens;
    } else if (Number(srv.eagerTokens) > 0) {
      totalEagerTokens += Number(srv.eagerTokens);
    }

    if (srv.transport === 'stdio' && srv.commandReachable === false) {
      unreachableServers.push(name);
    }
  }

  const effectiveMcpTokens = Math.max(totalEagerTokens, Math.max(0, Number(mcpSchemaTokens || 0)));
  const bTok = Math.max(0, Number(bundledSkillsTokens || 0));
  const sTok = Math.max(0, Number(syncedSkillsTokens || 0));
  const cTok = Math.max(0, Number(claudeMdTokens || 0));
  const turn0StaticPrefillBreakdown = {
    bundledSkillsTokens: bTok,
    syncedSkillsTokens: sTok,
    mcpSchemaTokens: effectiveMcpTokens,
    claudeMdTokens: cTok,
    totalStaticPrefillTokens: bTok + sTok + effectiveMcpTokens + cTok
  };

  const idleMcpHoarding5Turns =
    effectiveMcpTokens >= eagerTokenThreshold &&
    Number(turnsElapsed) >= 5 &&
    Number(mcpInvocations) === 0;

  const exceedsBudget = effectiveMcpTokens > eagerTokenThreshold;
  const triggered =
    eagerOverrides.length > 0 ||
    unreachableServers.length > 0 ||
    exceedsBudget ||
    idleMcpHoarding5Turns;
  const offendingServers = Array.from(new Set([...eagerOverrides, ...unreachableServers]));

  const parts = [];
  if (eagerOverrides.length > 0) {
    parts.push(`explicit "eager": true override on [${eagerOverrides.join(', ')}]`);
  }
  if (unreachableServers.length > 0) {
    parts.push(`unreachable/orphaned stdio binary on [${unreachableServers.join(', ')}]`);
  }
  if (exceedsBudget) {
    parts.push(`eager schema overhead ${effectiveMcpTokens.toLocaleString('en-US')} tok exceeds ${eagerTokenThreshold.toLocaleString('en-US')} tok`);
  }
  if (idleMcpHoarding5Turns) {
    parts.push(`0 MCP invocations across ${turnsElapsed} turns (set ENABLE_TOOL_SEARCH=auto:5 or lazy loading; Turn-0 static prefill = ${turn0StaticPrefillBreakdown.totalStaticPrefillTokens.toLocaleString('en-US')} tok)`);
  }

  return {
    detectorId: 'DET-13',
    subType: idleMcpHoarding5Turns ? 'IDLE_MCP_HOARDING_5_TURNS' : 'EAGER_MCP_AUDIT',
    triggered,
    eagerOverrides,
    unreachableServers,
    offendingServers,
    totalEagerTokens: effectiveMcpTokens,
    exceedsBudget,
    idleMcpHoarding5Turns,
    recommendedEnv: idleMcpHoarding5Turns ? 'ENABLE_TOOL_SEARCH=auto:5' : null,
    turn0StaticPrefillBreakdown,
    hudAlert: triggered
      ? `[DET-13 MCP Audit] Antigravity 1.3.3+ defaults to lazy MCP loading, but detected ${parts.join('; ')}.`
      : null
  };
}

export const evaluateDet09McpSchemaTax = evaluateDet13EagerMcpAuditor;

// ============================================================================
// Rank 6 (DET-06B): Lean Flash Subagent Search Offloader
// ============================================================================

const SEARCH_OR_READ_TOOL_RE = /^(view_file|read_file|grep_search|find_by_name|list_dir|glob|grep)$/i;
const WRITE_OR_EDIT_TOOL_RE = /^(write_to_file|write_file|replace_file_content|multi_replace_file_content|edit_file|edit|multiedit)$/i;

export function evaluateDet06bFlashScoutOffloader({
  toolName = '',
  consecutiveReadSearchCount = 0,
  activeModel = '',
  cachedTokens = 0,
  isSubagent = false,
  flightMode = 'COACH'
} = {}) {
  if (isSubagent) {
    return { detectorId: 'DET-06B', triggered: false, decision: 'allow', nextCount: consecutiveReadSearchCount };
  }
  if (WRITE_OR_EDIT_TOOL_RE.test(toolName)) {
    return { detectorId: 'DET-06B', triggered: false, decision: 'allow', nextCount: 0 };
  }
  if (!SEARCH_OR_READ_TOOL_RE.test(toolName)) {
    return { detectorId: 'DET-06B', triggered: false, decision: 'allow', nextCount: consecutiveReadSearchCount };
  }

  const nextCount = Number(consecutiveReadSearchCount || 0) + 1;
  const modelNorm = String(activeModel || '').toLowerCase();
  const isWarmFrontier = (modelNorm.includes('gemini-4-carbon') || modelNorm.includes('gemini-4-argon'))
    && Number(cachedTokens) > 3529;

  if (!isWarmFrontier || nextCount < 7) {
    return { detectorId: 'DET-06B', triggered: false, decision: 'allow', nextCount };
  }

  const mode = String(flightMode || 'COACH').toUpperCase();
  const reason = `[DET-06B] Unedited read/search call #${nextCount} on warm ${activeModel} (${cachedTokens} cached tok). Delegate repository scouting to @ah-flash-scout (<200-tok File:Line summary) to protect main-thread KV cache.`;
  return {
    detectorId: 'DET-06B',
    triggered: true,
    decision: mode === 'AUTO_PILOT' ? 'deny' : 'allow',
    reason,
    hudAlert: reason,
    nextCount
  };
}

// ============================================================================
// Rank 7 (DET-08): KV-Cache Gravity & Between-Turn Effort Router
// ============================================================================

export const WARM_CACHE_GRAVITY_FLOOR_TOKENS = 3529;

export function resolveCarbonPricingForTimestamp(timestampUtc = '2026-11-10T00:00:00Z') {
  const ts = Date.parse(String(timestampUtc || '2026-11-10T00:00:00Z'));
  const stepTs = Date.parse('2026-12-01T00:00:00Z');
  if (!Number.isNaN(ts) && ts >= stepTs) {
    return { inputPer1M: 4.00, cachedReadPer1M: 0.20, outputPer1M: 20.00, window: 'post_2026_12_01' };
  }
  return { inputPer1M: 2.00, cachedReadPer1M: 0.10, outputPer1M: 10.00, window: 'pre_2026_12_01' };
}

export function evaluateDet08CacheGravityAndEffort({
  turnCount = 0,
  cachedTokens = 0,
  activeModel = 'gemini-4-carbon',
  activeEffort = 'high',
  isSimpleTask = false,
  recentTestFailures = 0,
  det05Oscillation = false,
  dismissalStrikes = 0,
  timestampUtc = '2026-11-10T00:00:00Z'
} = {}) {
  const cached = Math.max(0, Number(cachedTokens || 0));
  const turn = Math.max(0, Number(turnCount || 0));
  const modelNorm = String(activeModel || '').toLowerCase();
  const isFrontier = modelNorm.includes('carbon') || modelNorm.includes('argon');
  const carbonRates = resolveCarbonPricingForTimestamp(timestampUtc);
  const flashColdInputPer1M = 0.75;

  // Lane 1: Turn 0-2 (cachedTokens <= 3529) -> route simple single-file/typo tasks to gemini-3.8-flash
  if (turn <= 2 && cached <= WARM_CACHE_GRAVITY_FLOOR_TOKENS) {
    if (isFrontier && isSimpleTask) {
      return {
        detectorId: 'DET-08',
        lane: 'TURN_0_2_COLD_FLASH_ROUTE',
        triggered: true,
        keepSameModel: false,
        recommendedModel: 'gemini-3.8-flash',
        recommendedEffort: 'low',
        chipLabel: '[Route: gemini-3.8-flash (cold Turn 0-2 simple task)]',
        carbonRates
      };
    }
    return {
      detectorId: 'DET-08',
      lane: 'TURN_0_2_NOMINAL',
      triggered: false,
      keepSameModel: true,
      recommendedModel: activeModel,
      recommendedEffort: activeEffort,
      carbonRates
    };
  }

  // Lane 2: Mid-Session (cachedTokens > 3529) -> NEVER switch main-thread model ID to Flash!
  const hysteresisLocked = Number(recentTestFailures) >= 2 || Boolean(det05Oscillation);
  const mutedByStrikes = Number(dismissalStrikes) >= 3;
  const coldFlashInputCostRatio = Number((flashColdInputPer1M / carbonRates.cachedReadPer1M).toFixed(2));
  const canDownshiftEffort =
    isFrontier &&
    String(activeEffort || '').toLowerCase() !== 'low' &&
    !hysteresisLocked &&
    !mutedByStrikes &&
    isSimpleTask;

  return {
    detectorId: 'DET-08',
    lane: 'MID_SESSION_SAME_MODEL_EFFORT',
    triggered: canDownshiftEffort,
    keepSameModel: true,
    forbidFlashModelSwitch: true,
    coldFlashInputPenaltyMultiplier: coldFlashInputCostRatio,
    hysteresisLocked,
    mutedByStrikes,
    recommendedModel: activeModel,
    recommendedEffort: canDownshiftEffort ? 'low' : activeEffort,
    outputBurnReductionPct: 68,
    chipLabel: canDownshiftEffort
      ? '[Downshift: /effort low (-68% output burn, keeps warm cache)]'
      : null,
    carbonRates
  };
}

// ============================================================================
// Rank 12 (DET-16 & DET-20): 80% Hybrid Quota Fan-Out Throttle & Vision Quirk
// ============================================================================

export function evaluateDet16HybridQuotaThrottle({
  baseQuotaUsedPct = 0,
  activeSubagentsCount = 0,
  requestedWorkers = 1,
  subagentTokens = 0,
  subagentTurns = 0,
  maxSubagentTokens = 40000,
  maxSubagentTurns = 12
} = {}) {
  const usedPct = Math.max(0, Number(baseQuotaUsedPct || 0));

  if (Number(subagentTokens) > maxSubagentTokens || Number(subagentTurns) > maxSubagentTurns) {
    return {
      detectorId: 'DET-16',
      triggered: true,
      subType: 'SUBAGENT_BUDGET_CAP',
      decision: 'deny',
      reason: `[DET-16] Subagent run exceeded per-worker budget (${subagentTokens}/${maxSubagentTokens} tok, ${subagentTurns}/${maxSubagentTurns} turns). Return compact summary now.`
    };
  }

  if (usedPct >= 90) {
    return {
      detectorId: 'DET-16',
      triggered: true,
      subType: 'HYBRID_QUOTA_90_HARD_ASK',
      decision: 'ask',
      maxParallelWorkers: 1,
      reason: `[DET-16] Base Quota is at ${usedPct}% (>=90%). Confirm before spawning subagents/swarms to avoid triggering a 4-to-7-day (168h) Hybrid Quota lockout.`
    };
  }

  if (usedPct >= 80 && (Number(requestedWorkers) > 1 || Number(activeSubagentsCount) >= 1)) {
    return {
      detectorId: 'DET-16',
      triggered: true,
      subType: 'HYBRID_QUOTA_80_SINGLE_WORKER_CAP',
      decision: 'deny',
      maxParallelWorkers: 1,
      reason: `[DET-16] Base Quota is at ${usedPct}% (>=80% throttle). Capped at 1 sequential subagent worker (requested ${requestedWorkers}, active ${activeSubagentsCount}) to prevent 168h lockout.`
    };
  }

  return {
    detectorId: 'DET-16',
    triggered: false,
    decision: 'allow',
    maxParallelWorkers: usedPct >= 80 ? 1 : 4
  };
}

export function evaluateDet20VisionOverageGuard({
  quirkConfig = { enabled: true },
  aiCreditOveragesActive = false,
  hasImageAttachment = false,
  consecutiveImageTurns = 0,
  promptText = '',
  imageCount = 0,
  messages = [],
  contentBlocks = [],
  tokensPerImage = 1600
} = {}) {
  // Inspect historical messages & contentBlocks for base64 / image blocks
  let base64ImageBlockCount = 0;
  let cumulativeVisionTaxTokens = 0;
  const msgList = Array.isArray(messages) ? messages : [];
  const totalMsgLen = msgList.length;

  for (let i = 0; i < totalMsgLen; i++) {
    const msg = msgList[i];
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    let msgImages = 0;
    for (const b of blocks) {
      if (
        b &&
        (b.type === 'image' ||
          b.type === 'image_url' ||
          b?.source?.type === 'base64' ||
          String(b?.mime_type || b?.mimeType || '').startsWith('image/'))
      ) {
        base64ImageBlockCount += 1;
        msgImages += 1;
      }
    }
    if (msgImages > 0) {
      // Each historical image block is re-sent on every subsequent turn (`totalMsgLen - i` turns)
      const turnsResent = Math.max(1, Math.ceil((totalMsgLen - i) / 2));
      cumulativeVisionTaxTokens += msgImages * Number(tokensPerImage || 1600) * turnsResent;
    }
  }

  if (Array.isArray(contentBlocks)) {
    for (const b of contentBlocks) {
      if (b && (b.type === 'image' || b?.source?.type === 'base64')) {
        base64ImageBlockCount += 1;
        cumulativeVisionTaxTokens += Number(tokensPerImage || 1600);
      }
    }
  }

  const effectiveHasImage = Boolean(hasImageAttachment || base64ImageBlockCount > 0 || imageCount > 0);
  const effectiveImageCount = Math.max(Number(imageCount || 0), base64ImageBlockCount);
  if (cumulativeVisionTaxTokens === 0 && effectiveImageCount > 0) {
    const resendFactor = Math.max(1, Number(consecutiveImageTurns || 1));
    cumulativeVisionTaxTokens = effectiveImageCount * Number(tokensPerImage || 1600) * resendFactor;
  }

  if (!quirkConfig?.enabled || !effectiveHasImage) {
    return {
      detectorId: 'DET-20',
      triggered: false,
      base64ImageBlockCount,
      cumulativeVisionTaxTokens: 0
    };
  }

  // 1. Google HTTP 400 crash during credit overages
  if (aiCreditOveragesActive) {
    const message =
      quirkConfig.warningMessage ||
      '[DET-20 Vision Overage Quirk] AI Credit Overages are active and an image/screenshot is attached. Remove image attachments or switch to a text-only turn to avoid Google HTTP 400 Bad Request (Unable to process input image).';
    return {
      detectorId: 'DET-20',
      subType: 'VISION_OVERAGE_HTTP400',
      triggered: true,
      base64ImageBlockCount,
      cumulativeVisionTaxTokens,
      warningMessage: message,
      ephemeralMessage: message
    };
  }

  // 2. Normal billing vision/screenshot abuse on text-based CSS/console errors or multi-turn Base64 accumulation
  const isTextDebuggablePrompt =
    /\b(TypeError|ReferenceError|SyntaxError|console\.error|stack\s*trace|padding|margin|z-index|flex|grid|css|align|overflow|dom|selector|button|headless|playwright|puppeteer)\b/i.test(
      promptText
    );
  if ((consecutiveImageTurns >= 2 || effectiveImageCount >= 2) && (isTextDebuggablePrompt || base64ImageBlockCount >= 2)) {
    const message = `[DET-20 Vision Token Drain Advisory] ${effectiveImageCount} screenshot/image blocks accumulated (~${cumulativeVisionTaxTokens.toLocaleString('en-US')} cumulative vision tokens) for text/DOM/CSS debugging. Paste console logs or DOM/CSS rules as text instead.`;
    return {
      detectorId: 'DET-20',
      subType: 'VISION_SCREENSHOT_ABUSE',
      triggered: true,
      base64ImageBlockCount,
      cumulativeVisionTaxTokens,
      warningMessage: message,
      ephemeralMessage: message
    };
  }

  return {
    detectorId: 'DET-20',
    triggered: false,
    base64ImageBlockCount,
    cumulativeVisionTaxTokens
  };
}

// ============================================================================
// Rank 4 (DET-17) & Rank 8 (DET-10) & Rank 9 (RSI-01)
// ============================================================================

export function evaluateDet17CascadeCheckpoints({
  currentTokens = 0,
  ceilingTokens = CASCADE_COMPACTION_CEILING_TOKENS,
  crossedBands = [],
  cacheHitRatio = 0
} = {}) {
  const tok = Math.max(0, Number(currentTokens || 0));
  const crossed = new Set(Array.isArray(crossedBands) ? crossedBands : []);
  const newlyCrossed = [];

  for (const band of CASCADE_CHECKPOINT_BANDS) {
    if (tok >= band.tokens && !crossed.has(band.label)) {
      newlyCrossed.push(band);
      crossed.add(band.label);
    }
  }

  const suppressPrematureCompact = Number(cacheHitRatio) > 0.96 && tok < 50000;
  return {
    detectorId: 'DET-17',
    ceilingTokens,
    newlyCrossedBands: newlyCrossed,
    shouldWriteStateBaton: newlyCrossed.length > 0,
    crossedBands: Array.from(crossed),
    suppressPrematureCompact
  };
}

export function evaluateDet10IdleCacheWatchdog({
  elapsedSeconds = 0,
  ttlWindowSeconds = 300,
  planDefaultTtlSeconds = null,
  aiCreditOveragesActive = false,
  isSubagent = false,
  billingMode = 'subscription',
  cachedTokens = 0,
  workspaceEditsOccurred = false
} = {}) {
  const force5mDrop =
    Boolean(aiCreditOveragesActive) ||
    Boolean(isSubagent) ||
    String(billingMode || '').toLowerCase() === 'api';
  const effectiveTtlSeconds =
    planDefaultTtlSeconds != null
      ? (force5mDrop ? 300 : Math.max(60, Number(planDefaultTtlSeconds)))
      : Math.max(1, Number(ttlWindowSeconds ?? 300));
  const ttlDroppedTo5m =
    planDefaultTtlSeconds != null &&
    Number(planDefaultTtlSeconds) > 300 &&
    effectiveTtlSeconds === 300;

  const elapsed = Math.max(0, Number(elapsedSeconds || 0));
  const cacheExpired = elapsed > effectiveTtlSeconds;
  const rem = Math.max(0, Number((effectiveTtlSeconds - elapsed).toFixed(1)));
  const mins = Math.floor(rem / 60);
  const secs = Math.floor(rem % 60);
  const tierPrefix = effectiveTtlSeconds >= 3600 ? 'Est. 1h Cache' : 'Est. 5m Implicit Cache';
  const label = `${tierPrefix}: ${mins}m ${String(secs).padStart(2, '0')}s`;
  const pulseAmber = rem > 0 && rem <= 45 && Number(cachedTokens) >= 25000 && Boolean(workspaceEditsOccurred);

  return {
    detectorId: 'DET-10',
    subType: cacheExpired ? 'CACHE_TTL_EXPIRED' : (pulseAmber ? 'PRE_EXPIRY_PULSE' : 'NOMINAL'),
    effectiveTtlSeconds,
    ttlDroppedTo5m,
    cacheExpired,
    remainingSeconds: rem,
    label,
    pulseAmber,
    shouldFlushColdResumeBaton: pulseAmber || (cacheExpired && Number(cachedTokens) >= 25000)
  };
}

/**
 * Pure zero-I/O evaluator for Silent Prefix Mutations (`Sim 01` & `Sim 16`):
 *  - `LATE_MCP_CONNECT`: MCP server count or schema hash changing after Turn 1
 *  - `MEMORY_MD_MID_THREAD_MUTATION`: Mid-thread `MEMORY.md` hash/byte change (up to 25KB)
 *  - `IDE_STATE_PREFIX_MUTATION`: Dynamic IDE state (active tab, line selection, Problems tab) injected into system prefix instead of user-turn tail
 *  - `LOOKBACK_WINDOW_DELETION`: Message deletion inside 20-block lookback window shifting cached suffix
 */
export function evaluateSilentPrefixMutations({
  turnCount = 1,
  prevMcpServerCount = null,
  currMcpServerCount = null,
  prevMcpSchemaHash = null,
  currMcpSchemaHash = null,
  prevMemoryMdHash = null,
  currMemoryMdHash = null,
  prevMemoryMdBytes = null,
  currMemoryMdBytes = null,
  ideStateInSystemPrefix = false,
  prevIdePrefixHash = null,
  currIdePrefixHash = null,
  prevMessageIds = null,
  currMessageIds = null,
  tokensPerMessage = 5000,
  cachedTokens = 0
} = {}) {
  const turn = Math.max(1, Number(turnCount || 1));
  const subTypes = [];
  const details = [];
  let shiftedSuffixTokens = 0;

  if (turn > 1) {
    const mcpCountChanged =
      prevMcpServerCount != null &&
      currMcpServerCount != null &&
      Number(prevMcpServerCount) !== Number(currMcpServerCount);
    const mcpHashChanged =
      Boolean(prevMcpSchemaHash && currMcpSchemaHash) &&
      String(prevMcpSchemaHash) !== String(currMcpSchemaHash);
    if (mcpCountChanged || mcpHashChanged) {
      subTypes.push('LATE_MCP_CONNECT');
      details.push(
        `Mid-session MCP server/schema change at Turn ${turn} (${prevMcpServerCount ?? '?'} -> ${currMcpServerCount ?? '?'} servers)`
      );
    }

    const memHashChanged =
      Boolean(prevMemoryMdHash && currMemoryMdHash) &&
      String(prevMemoryMdHash) !== String(currMemoryMdHash);
    const memBytesChanged =
      prevMemoryMdBytes != null &&
      currMemoryMdBytes != null &&
      Number(prevMemoryMdBytes) !== Number(currMemoryMdBytes);
    if (memHashChanged || memBytesChanged) {
      subTypes.push('MEMORY_MD_MID_THREAD_MUTATION');
      const kb = currMemoryMdBytes != null ? `${(Number(currMemoryMdBytes) / 1024).toFixed(1)}KB` : 'updated';
      details.push(`Mid-thread MEMORY.md mutation (${kb}) invalidated static system prefix`);
    }

    const ideHashChanged =
      Boolean(prevIdePrefixHash && currIdePrefixHash) &&
      String(prevIdePrefixHash) !== String(currIdePrefixHash);
    if (Boolean(ideStateInSystemPrefix) || ideHashChanged) {
      subTypes.push('IDE_STATE_PREFIX_MUTATION');
      details.push(
        'Dynamic IDE state (active tab / highlighted lines / Problems diagnostics) injected into system prefix instead of user-turn tail'
      );
    }
  }

  if (Array.isArray(prevMessageIds) && Array.isArray(currMessageIds) && prevMessageIds.length > 0) {
    const currSet = new Set(currMessageIds);
    let firstDeletedIdx = -1;
    let deletedCount = 0;
    for (let i = 0; i < prevMessageIds.length; i++) {
      if (!currSet.has(prevMessageIds[i])) {
        if (firstDeletedIdx === -1) firstDeletedIdx = i;
        deletedCount += 1;
      }
    }
    if (firstDeletedIdx !== -1) {
      const remainingAfterDeletion = Math.max(0, prevMessageIds.length - firstDeletedIdx - deletedCount);
      const tokPerMsg = Array.isArray(tokensPerMessage)
        ? 0
        : Math.max(1, Number(tokensPerMessage || 5000));
      if (Array.isArray(tokensPerMessage)) {
        for (let j = firstDeletedIdx + deletedCount; j < prevMessageIds.length; j++) {
          shiftedSuffixTokens += Math.max(0, Number(tokensPerMessage[j] || 0));
        }
      } else {
        shiftedSuffixTokens = remainingAfterDeletion * tokPerMsg;
      }
      subTypes.push('LOOKBACK_WINDOW_DELETION');
      details.push(
        `Deleted ${deletedCount} historical message(s) starting at index ${firstDeletedIdx}, shifting ${shiftedSuffixTokens.toLocaleString('en-US')} suffix tokens outside 20-block lookback window`
      );
    }
  }

  const triggered = subTypes.length > 0;
  const detectorId = subTypes.includes('LOOKBACK_WINDOW_DELETION')
    ? 'DET-26'
    : subTypes.includes('LATE_MCP_CONNECT')
      ? 'DET-25'
      : 'DET-09';

  return {
    detectorId,
    triggered,
    subTypes,
    shiftedSuffixTokens: shiftedSuffixTokens || (triggered ? Math.max(0, Number(cachedTokens || 0)) : 0),
    details,
    reason: triggered ? `[${detectorId} Silent Prefix Mutation] ${details.join('; ')}.` : null
  };
}

export function evaluateRsi01PrefixDietAndSkillFault({
  staticRulesTokens = 0,
  staticRulesOverheadCeiling = 8000,
  domainSections = [],
  lastExecutedSkill = null,
  userCorrectionText = '',
  validatedDomainInstinctsCount = 0
} = {}) {
  const prefixBloatExceeded = Number(staticRulesTokens) > Number(staticRulesOverheadCeiling);
  const proposedExtractions = prefixBloatExceeded
    ? (Array.isArray(domainSections) ? domainSections : []).map((sec) => ({
        domain: String(sec.domain || sec).toLowerCase().replace(/[^a-z0-9-]+/g, () => '-'),
        targetSkillPath: `.agents/skills/${String(sec.domain || sec).toLowerCase().replace(/[^a-z0-9-]+/g, () => '-')}/SKILL.md`,
        estimatedTokensSaved: Number(sec.tokens || 1200)
      }))
    : [];

  let routedDeltaTarget = null;
  if (userCorrectionText && String(userCorrectionText).trim()) {
    if (lastExecutedSkill) {
      const cleanSkill = String(lastExecutedSkill).replace(/[^a-zA-Z0-9_-]/g, () => '');
      routedDeltaTarget = `.agents/skills/${cleanSkill}/SKILL.md`;
    } else {
      routedDeltaTarget = 'INSTINCT_QUEUE';
    }
  }

  const canSynthesizeNewSkillDraft = Number(validatedDomainInstinctsCount) >= 5;
  return {
    detectorId: 'RSI-01',
    prefixBloatExceeded,
    proposedExtractions,
    routedDeltaTarget,
    mutatesGlobalAgentsMdDirectly: false,
    canSynthesizeNewSkillDraft,
    recursiveSubagentCritiqueAllowed: false,
    requiresExplicitOneClickDiffApproval: true,
    gatedByTurnZeroGate: true
  };
}

export { fnv1a64Hex, redactSecretsPure };
export {
  RELAY_STATES,
  matchRelayHardNegativeFilter,
  countRefereeSyntaxMarkers,
  evaluateScopeBrake,
  evaluateRelayBreaker,
  evaluateTwoStageSightseeingIntercept
} from './prompt_hygiene_governor.mjs';
