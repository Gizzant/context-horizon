/**
 * @file src/core-isomorphic/diagnostics/prompt_hygiene_governor.mjs
 * Prompt Hygiene Governor (v4.1 Phase 1): Scope Brake ('vague-prompt-rubric')
 * and Relay Breaker ('relay-breaker').
 *
 * Strictly zero `node:*` imports (Claude Code Mod Law 4 compliant).
 * Runs in memory in < 1 ms using Highbeam's local sidecar/breaker ledger
 * with zero background LLM calls and zero synchronous `git status` spawns.
 */

export const RELAY_STATES = Object.freeze({
  IDLE: 'Idle',
  CANDIDATE: 'Candidate',
  ARMED: 'Armed',
  FINAL_PASS: 'Final Pass',
  LOCKED: 'Locked'
});

const AFFIRMATIVE_OR_CONTINUATION_RE =
  /^(?:yes|y|yep|yeah|ok|okay|sure|ship\s+it|go\s+ahead|proceed|continue|approved|approve|lgtm|do\s+it|sounds\s+good|looks\s+good|run\s+it|commit(?:\s+it)?|push(?:\s+it)?|next|thanks|thank\s+you)[.!?\s]*$/i;

const AUTONOMOUS_PROVENANCE_RE =
  /^(?:scheduled|cron|loop|subagent|agent_callback|callback|auto|autonomous|background|system|hook|task_notification|wake)$/i;

const VAGUE_UNANCHORED_IMPERATIVE_RE =
  /\b(?:make\s+(?:it|this)\s+(?:better|faster|cleaner|nicer|work)|optimize\s+(?:it|this)|clean\s+(?:this|it)\s+up|speed\s+(?:this|it)\s+up|(?:still\s+)?(?:broken|not\s+working|failing|buggy)|fix\s+(?:it|this|bugs|errors|everything)|improve\s+(?:it|this|performance|code)|refactor\s+(?:it|this)|polish\s+(?:it|this)|update\s+(?:it|this))\b/i;

const CONCRETE_FILE_OR_PATH_RE =
  /(?:^|\s)@[A-Za-z0-9_./\\-]+|\b[A-Za-z0-9_.-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|rb|java|kt|cs|cpp|c|h|css|scss|html|json|ya?ml|toml|md|sql|sh|ps1)\b|(?:^|[\s'"`(])(?:src|test|tests|lib|app|packages|hooks|scripts|sidecars|bin|config|docs)[\\/][A-Za-z0-9_./\\-]+/i;

const CONCRETE_SYMBOL_OR_METRIC_RE =
  /`[^`]{2,}`|\b[a-z][a-zA-Z0-9]+_[a-zA-Z0-9_]+\b|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]+\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-zA-Z_]\w*\s*\([^)]*\)|\b(?:line|ln)\s+\d+\b|\b\d+(?:\.\d+)?\s*(?:ms|s|sec|mb|kb|gb|%|tok|tokens|fps|rps|qps)\b|\b(?:DET|ISS|RSI|SIM)-\d+\b|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EACCES|ECONNREFUSED|ERR_[A-Z0-9_]+|HTTP\s+[45]\d\d)\b|\b(?:[Uu][Ii]\s+alignment|alignment|margin|padding|z-index|flexbox|grid\s+layout|tooltip|dropdown|sidebar|navbar|modal|button|input|form|card|table|header|footer|panel|drawer|badge|icon|color|font|border|layout|style|css|html|test|tests|spec|build|lint|typecheck|commit|branch|merge|hook|daemon|server|client|router|cache|token|prompt|rule|config|package|readme|console)\b/;

// Hard negative filters for Relay Breaker (3.1.4): stack traces, compiler errors, unified diffs, log timestamps, SQL, JSON/CSV payloads
const HARD_NEGATIVE_STACK_TRACE_RE =
  /(?:^\s*at\s+[^\r\n]+\([^\r\n]+:\d+:\d+\)|Traceback\s+\(most\s+recent\s+call\s+last\):|^\s*File\s+"[^"]+",\s+line\s+\d+|panic:\s+runtime\s+error)/m;

const HARD_NEGATIVE_COMPILER_ERROR_RE =
  /(?:\berror\s+TS\d{3,5}:|\b(?:SyntaxError|TypeError|ReferenceError|RangeError|AssertionError):|^\s*error\[E\d{4}\]:|\bFAIL\s+[^\r\n]+\.(?:test|spec)\.)/m;

const HARD_NEGATIVE_UNIFIED_DIFF_RE =
  /(?:^diff\s+--git\s+a\/|^---\s+a\/|^\+\+\+\s+b\/|^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@)/m;

const HARD_NEGATIVE_LOG_TIMESTAMP_RE =
  /(?:^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+(?:\[?(?:INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\]?))/m;

const HARD_NEGATIVE_SQL_RE =
  /\b(?:SELECT\s+[\s\S]{1,120}\s+FROM\s+[A-Za-z0-9_."`]+|INSERT\s+INTO\s+[A-Za-z0-9_."`]+|CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z0-9_."`]+|ALTER\s+TABLE\s+[A-Za-z0-9_."`]+)/i;

const REFEREE_SYNTAX_PATTERNS = Object.freeze([
  /\bwhat\s+i\s+confirmed\b/i,
  /\bcould(?:n't|\s+not)\s+confirm\b/i,
  /\bwhat\s+holds\s+up\b/i,
  /\bwhere\s+(?:it|the\s+(?:spec|review|critique|reviewer|author))\s+(?:overreaches|falls\s+short|is\s+right|is\s+wrong|misses)\b/i,
  /\b(?:verdict|overall\s+assessment|blind\s+spots?|my\s+rebuttal|point-by-point|counter-?argument|reviewer(?:'s)?\s+(?:claim|critique|feedback))\b/i,
  /\b\d+(?:\.\d+)?\s*\/\s*(?:10|100)\b/,
  /\b(?:S0|S1|S2)\s*[:—-]\s*(?:Blocker|Major|Minor|Nit)\b/i,
  /\b(?:concede|push\s+back|disagree\s+with\s+point|agree\s+with\s+point|round\s+[234]\s+rebuttal)\b/i
]);

function isJsonOrCsvPayload(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Not pure JSON; check if >60% of lines look like JSON key-value pairs
      const lines = trimmed.split(/\r?\n/);
      if (lines.length >= 6) {
        const jsonLikeLines = lines.filter((l) => /^\s*"[^"]+"\s*:/.test(l)).length;
        if (jsonLikeLines / lines.length >= 0.6) return true;
      }
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 4) {
    const commaCounts = lines.slice(0, 6).map((l) => (l.match(/,/g) || []).length);
    if (commaCounts[0] >= 3 && commaCounts.every((c) => c === commaCounts[0])) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a prompt matches any of the Relay Breaker hard negative filters (Section 3.1.4).
 *
 * @param {string} promptText
 * @returns {{ matched: boolean, filter: string | null }}
 */
export function matchRelayHardNegativeFilter(promptText = '') {
  const text = String(promptText || '');
  if (!text) return { matched: false, filter: null };
  if (HARD_NEGATIVE_STACK_TRACE_RE.test(text)) return { matched: true, filter: 'STACK_TRACE' };
  if (HARD_NEGATIVE_COMPILER_ERROR_RE.test(text)) return { matched: true, filter: 'COMPILER_OR_TEST_ERROR' };
  if (HARD_NEGATIVE_UNIFIED_DIFF_RE.test(text)) return { matched: true, filter: 'UNIFIED_DIFF' };
  if (HARD_NEGATIVE_LOG_TIMESTAMP_RE.test(text)) return { matched: true, filter: 'LOG_TIMESTAMPS' };
  if (HARD_NEGATIVE_SQL_RE.test(text)) return { matched: true, filter: 'SQL_PAYLOAD' };
  if (isJsonOrCsvPayload(text)) return { matched: true, filter: 'JSON_OR_CSV_PAYLOAD' };
  return { matched: false, filter: null };
}

/**
 * Counts how many distinct referee/critique markers appear in `promptText`.
 *
 * @param {string} promptText
 * @returns {{ count: number, matchedMarkers: string[] }}
 */
export function countRefereeSyntaxMarkers(promptText = '') {
  const text = String(promptText || '');
  const matchedMarkers = [];
  for (const re of REFEREE_SYNTAX_PATTERNS) {
    const m = text.match(re);
    if (m) {
      matchedMarkers.push(m[0]);
    }
  }
  return {
    count: matchedMarkers.length,
    matchedMarkers
  };
}

/**
 * Pure zero-I/O Scope Brake classifier (Section 3.2 & 5.1).
 * Consolidated into `'vague-prompt-rubric'` (`DET-26` on Antigravity, `DET-14` on Claude Code).
 *
 * @param {object} [params={}]
 * @returns {{
 *   detectorId: string,
 *   slug: string,
 *   triggered: boolean,
 *   subType: string | null,
 *   decision: 'allow' | 'steer' | 'block',
 *   mode: string,
 *   bypassReason: string | null,
 *   wordCount: number,
 *   candidateFiles: string[],
 *   steerContext: string | null,
 *   blockReason: string | null,
 *   unanchoredTurnFlag: boolean
 * }}
 */
export function evaluateScopeBrake({
  prompt = '',
  provenance = 'user',
  isAutonomousTurn = false,
  isSubagent = false,
  isScheduledTask = false,
  isLoopIteration = false,
  priorTurnEditedFilesCount = 0,
  priorTurnSingleFileTarget = null,
  priorTurnHadToolOrTestFailure = false,
  priorTurnAssistantAskedQuestion = false,
  activeSetPaths = [],
  modifiedFiles = [],
  recentlyViewedFiles = [],
  overrideMode = 'default',
  flightMode = 'COACH',
  detectorId = 'DET-26'
} = {}) {
  const raw = String(prompt || '').trim();
  const cleaned = raw.replace(/#check\b/gi, '').trim();
  const words = cleaned ? cleaned.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;

  const normOverride = String(overrideMode || 'default').toLowerCase();
  if (normOverride === 'off' || String(flightMode || '').toUpperCase() === 'OFF') {
    return {
      detectorId,
      slug: 'vague-prompt-rubric',
      triggered: false,
      subType: null,
      decision: 'allow',
      mode: 'off',
      bypassReason: 'DISABLED_BY_CONFIG',
      wordCount,
      candidateFiles: [],
      steerContext: null,
      blockReason: null,
      unanchoredTurnFlag: false
    };
  }

  // 1. Autonomous turn & affirmative reply bypass (< 1 ms)
  if (
    Boolean(isAutonomousTurn) ||
    Boolean(isSubagent) ||
    Boolean(isScheduledTask) ||
    Boolean(isLoopIteration) ||
    AUTONOMOUS_PROVENANCE_RE.test(String(provenance || '')) ||
     cleaned.startsWith('/') ||
    AFFIRMATIVE_OR_CONTINUATION_RE.test(cleaned)
  ) {
    return {
      detectorId,
      slug: 'vague-prompt-rubric',
      triggered: false,
      subType: null,
      decision: 'allow',
      mode: normOverride,
      bypassReason: 'AUTONOMOUS_OR_AFFIRMATIVE_BYPASS',
      wordCount,
      candidateFiles: [],
      steerContext: null,
      blockReason: null,
      unanchoredTurnFlag: false
    };
  }

  // 2. Trailing context anchor suppression (single-file edit, tool/test failure, or assistant question)
  const effectiveSingleFileEdit =
    Number(priorTurnEditedFilesCount) === 1 || Boolean(priorTurnSingleFileTarget);
  if (
    effectiveSingleFileEdit ||
    Boolean(priorTurnHadToolOrTestFailure) ||
    Boolean(priorTurnAssistantAskedQuestion)
  ) {
    return {
      detectorId,
      slug: 'vague-prompt-rubric',
      triggered: false,
      subType: null,
      decision: 'allow',
      mode: normOverride,
      bypassReason: 'TRAILING_CONTEXT_ANCHOR',
      wordCount,
      candidateFiles: [],
      steerContext: null,
      blockReason: null,
      unanchoredTurnFlag: false
    };
  }

  // 3. Lexical trigger: < 12 words built around bare imperatives / vague comparatives lacking file/symbol/metric/error
  const hasConcreteAnchor =
    CONCRETE_FILE_OR_PATH_RE.test(cleaned) || CONCRETE_SYMBOL_OR_METRIC_RE.test(cleaned);
  const isUnder12Words = wordCount > 0 && wordCount < 12;
  const matchesVagueDirective = VAGUE_UNANCHORED_IMPERATIVE_RE.test(cleaned);

  if (!isUnder12Words || hasConcreteAnchor || !matchesVagueDirective) {
    return {
      detectorId,
      slug: 'vague-prompt-rubric',
      triggered: false,
      subType: null,
      decision: 'allow',
      mode: normOverride,
      bypassReason: null,
      wordCount,
      candidateFiles: [],
      steerContext: null,
      blockReason: null,
      unanchoredTurnFlag: false
    };
  }

  // Gather top 5 candidate paths from sidecar activeSetPaths / modifiedFiles / recentlyViewedFiles (zero git spawn)
  const seen = new Set();
  const candidates = [];
  for (const list of [modifiedFiles, activeSetPaths, recentlyViewedFiles]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const p = String(item || '').trim().replace(/\\/g, '/');
      if (!p || seen.has(p)) continue;
      seen.add(p);
      candidates.push(p);
      if (candidates.length >= 5) break;
    }
    if (candidates.length >= 5) break;
  }

  const candidateDisplay =
    candidates.length > 0 ? candidates.slice(0, 5).join(', ') : '<target-file>';
  const recentTwoDisplay =
    candidates.length > 0 ? candidates.slice(0, 2).join(' or ') : '@<target-file>';

  const isBlockMode =
    normOverride === 'block' ||
    (normOverride === 'default' && String(flightMode || '').toUpperCase() === 'AUTO_PILOT');

  const steerContext =
    `[${detectorId} Scope Brake] Unanchored directive ("${cleaned}") with no target file, symbol, or error anchor. ` +
    `Candidate active files: [${candidateDisplay}]. ` +
    `Single-turn boundary: Do NOT call repository-wide search, directory-listing, or multi-file edit tools on this turn; ask 1 concise scoping question naming candidate target files (${recentTwoDisplay}) and the specific optimization axis (latency, memory allocation, error handling, or readability).`;

  const blockReason =
    `[${detectorId} Scope Brake] Unanchored directive ("${cleaned}"). ` +
    `Re-send with a concrete target (e.g., "In ${recentTwoDisplay}, ${cleaned} focusing on latency/readability").`;

  return {
    detectorId,
    slug: 'vague-prompt-rubric',
    triggered: true,
    subType: 'UNANCHORED_SCOPE_BRAKE',
    decision: isBlockMode ? 'block' : 'steer',
    mode: isBlockMode ? 'block' : 'steer',
    bypassReason: null,
    wordCount,
    candidateFiles: candidates,
    steerContext,
    blockReason,
    unanchoredTurnFlag: true
  };
}

/**
 * Pure zero-I/O Relay Breaker classifier & 5-state machine (Section 3.1, 4 & 5.2):
 * `Idle -> Candidate -> Armed -> Final Pass -> Locked`.
 * Any edit to source code outside the bound Markdown specification resets Relay Breaker back to `Idle`.
 *
 * @param {object} [params={}]
 * @returns {{
 *   detectorId: string,
 *   slug: string,
 *   triggered: boolean,
 *   subType: string | null,
 *   prevState: string,
 *   nextState: string,
 *   decision: 'allow' | 'steer' | 'block',
 *   refereeMarkerCount: number,
 *   matchedMarkers: string[],
 *   hardNegativeFilter: string | null,
 *   pasteChars: number,
 *   tailInjection: string | null,
 *   hudBadge: string | null,
 *   relayStateSnapshot: object
 * }}
 */
export function evaluateRelayBreaker({
  prompt = '',
  relayState = null,
  sourceCodeEditsInSession = 0,
  sourceCodeEditedSinceLastRelay = false,
  priorTurnWebSearches = 0,
  zeroEditSessionTokens = 0,
  boundSpecPath = null,
  overrideMode = 'default',
  flightMode = 'COACH',
  detectorId = 'DET-26'
} = {}) {
  const prevSnap = relayState && typeof relayState === 'object' ? relayState : {};
  const prevState = Object.values(RELAY_STATES).includes(prevSnap.state)
    ? prevSnap.state
    : RELAY_STATES.IDLE;
  const prevCritiquePastes = Math.max(0, Number(prevSnap.critiquePastes || 0));
  const activeSpecPath = boundSpecPath || prevSnap.boundSpecPath || 'SPEC.md';

  const normOverride = String(overrideMode || 'default').toLowerCase();
  if (normOverride === 'off' || String(flightMode || '').toUpperCase() === 'OFF') {
    return {
      detectorId,
      slug: 'relay-breaker',
      triggered: false,
      subType: null,
      prevState,
      nextState: prevState,
      decision: 'allow',
      refereeMarkerCount: 0,
      matchedMarkers: [],
      hardNegativeFilter: null,
      pasteChars: String(prompt || '').length,
      tailInjection: null,
      hudBadge: null,
      relayStateSnapshot: {
        state: prevState,
        critiquePastes: prevCritiquePastes,
        boundSpecPath: activeSpecPath
      }
    };
  }

  // Any source-code edit outside the bound Markdown spec resets Relay Breaker to Idle
  if (Boolean(sourceCodeEditedSinceLastRelay) || Number(sourceCodeEditsInSession) > 0) {
    return {
      detectorId,
      slug: 'relay-breaker',
      triggered: false,
      subType: null,
      prevState,
      nextState: RELAY_STATES.IDLE,
      decision: 'allow',
      refereeMarkerCount: 0,
      matchedMarkers: [],
      hardNegativeFilter: null,
      pasteChars: String(prompt || '').length,
      tailInjection: null,
      hudBadge: null,
      relayStateSnapshot: {
        state: RELAY_STATES.IDLE,
        critiquePastes: 0,
        boundSpecPath: activeSpecPath
      }
    };
  }

  const text = String(prompt || '');
  const pasteChars = text.length;

  // 4. Hard negative filters abort scoring immediately
  const neg = matchRelayHardNegativeFilter(text);
  if (neg.matched) {
    return {
      detectorId,
      slug: 'relay-breaker',
      triggered: false,
      subType: null,
      prevState,
      nextState: prevState,
      decision: 'allow',
      refereeMarkerCount: 0,
      matchedMarkers: [],
      hardNegativeFilter: neg.filter,
      pasteChars,
      tailInjection: null,
      hudBadge: null,
      relayStateSnapshot: {
        state: prevState,
        critiquePastes: prevCritiquePastes,
        boundSpecPath: activeSpecPath
      }
    };
  }

  const { count: refereeMarkerCount, matchedMarkers } = countRefereeSyntaxMarkers(text);
  const isCritiquePaste = pasteChars > 1500 && refereeMarkerCount >= 2;
  const hasVerificationSprawl =
    Number(priorTurnWebSearches) >= 3 || Number(zeroEditSessionTokens) > 35000;

  if (!isCritiquePaste) {
    return {
      detectorId,
      slug: 'relay-breaker',
      triggered: false,
      subType: null,
      prevState,
      nextState: prevState,
      decision: 'allow',
      refereeMarkerCount,
      matchedMarkers,
      hardNegativeFilter: null,
      pasteChars,
      tailInjection: null,
      hudBadge: prevState === RELAY_STATES.IDLE ? null : `Relay: ${prevState}`,
      relayStateSnapshot: {
        state: prevState,
        critiquePastes: prevCritiquePastes,
        boundSpecPath: activeSpecPath
      }
    };
  }

  const nextCritiquePastes = prevCritiquePastes + 1;
  let nextState = prevState;

  if (prevState === RELAY_STATES.IDLE) {
    nextState = hasVerificationSprawl && nextCritiquePastes >= 2
      ? RELAY_STATES.ARMED
      : RELAY_STATES.CANDIDATE;
  } else if (prevState === RELAY_STATES.CANDIDATE) {
    nextState = hasVerificationSprawl || nextCritiquePastes >= 2
      ? RELAY_STATES.ARMED
      : RELAY_STATES.CANDIDATE;
  } else if (prevState === RELAY_STATES.ARMED) {
    nextState = RELAY_STATES.FINAL_PASS;
  } else if (prevState === RELAY_STATES.FINAL_PASS || prevState === RELAY_STATES.LOCKED) {
    nextState = RELAY_STATES.LOCKED;
  }

  const isBlockMode =
    normOverride === 'block' ||
    (normOverride === 'default' && String(flightMode || '').toUpperCase() === 'AUTO_PILOT' && nextState === RELAY_STATES.LOCKED);

  let tailInjection = null;
  let hudBadge = null;
  let subType = null;

  if (nextState === RELAY_STATES.CANDIDATE) {
    hudBadge = 'Spec Churn Candidate (Round 1)';
    subType = 'RELAY_CANDIDATE';
  } else if (nextState === RELAY_STATES.ARMED) {
    hudBadge = 'Relay Mode Armed (Owner Protocol)';
    subType = 'RELAY_ARMED';
    tailInjection =
      `[${detectorId} Relay Breaker — Armed (Owner Protocol)] Cross-model spec relay detected (${pasteChars.toLocaleString('en-US')} chars, ${refereeMarkerCount} critique markers, 0 code edits). ` +
      `Act as the stateful Spec Owner: (1) Commit accepted spec changes directly to "${activeSpecPath}" instead of printing full prose recaps; ` +
      `(2) Do NOT run exploratory web searches on uncited peer claims; ` +
      `(3) Triage feedback into Blocker (S0), Major flaw (S1), or Testable runtime question (T) and defer style nits.`;
  } else if (nextState === RELAY_STATES.FINAL_PASS) {
    hudBadge = 'Relay Round 2 of 2 (Final Pass)';
    subType = 'RELAY_FINAL_PASS';
    tailInjection =
      `[${detectorId} Relay Breaker — Round 2 of 2 Cap] Final critique pass for "${activeSpecPath}". Resolve remaining S0/S1 items on disk and convert unresolved runtime debates into a local verification test.`;
  } else if (nextState === RELAY_STATES.LOCKED) {
    hudBadge = 'Relay Locked (Round 3+ Cap Reached)';
    subType = 'RELAY_LOCKED';
    tailInjection =
      `[${detectorId} Relay Breaker — LOCKED (Round ${nextCritiquePastes})] Spec relay cap reached with 0 source-code edits. Stop cross-model prose relays; freeze "${activeSpecPath}" and write a local verification script or begin implementation.`;
  }

  const triggered =
    nextState === RELAY_STATES.ARMED ||
    nextState === RELAY_STATES.FINAL_PASS ||
    nextState === RELAY_STATES.LOCKED;

  return {
    detectorId,
    slug: 'relay-breaker',
    triggered,
    subType,
    prevState,
    nextState,
    decision: triggered ? (isBlockMode ? 'block' : 'steer') : 'allow',
    refereeMarkerCount,
    matchedMarkers,
    hardNegativeFilter: null,
    pasteChars,
    tailInjection,
    hudBadge,
    relayStateSnapshot: {
      state: nextState,
      critiquePastes: nextCritiquePastes,
      boundSpecPath: activeSpecPath
    }
  };
}

/**
 * Two-Stage `PreToolUse` Sightseeing-Tool Interception Fallback (Section 4).
 * When `unanchoredTurnFlag` or `relayState === 'Locked'` (or `'Armed'` web search) was recorded
 * at prompt submission, intercepts the model's first exploratory repository scan or web search.
 *
 * @param {object} [params={}]
 * @returns {{
 *   intercepted: boolean,
 *   detectorId: string | null,
 *   subType: string | null,
 *   decision: 'allow' | 'deny',
 *   reason: string | null,
 *   consumeFlag: boolean
 * }}
 */
export function evaluateTwoStageSightseeingIntercept({
  toolName = '',
  toolArgs = {},
  unanchoredTurnFlag = false,
  candidateFiles = [],
  relayState = null,
  overrideMode = 'default',
  flightMode = 'COACH',
  detectorId = 'DET-26'
} = {}) {
  const name = String(toolName || '').trim();
  const isExploratorySearchOrList =
    /^(?:Grep|Glob|grep_search|find_by_name|list_dir|WebFetch|web_search|search_web)$/i.test(name);
  const isWebSearchTool = /^(?:WebFetch|web_search|search_web)$/i.test(name);
  const isUnscopedRead =
    /^(?:Read|read_file|view_file)$/i.test(name) &&
    candidateFiles.length > 0 &&
    !candidateFiles.some((cf) => {
      const target = String(
        toolArgs?.file_path || toolArgs?.Path || toolArgs?.TargetFile || toolArgs?.path || ''
      ).replace(/\\/g, '/');
      return target && (target.endsWith(cf) || cf.endsWith(target));
    });

  // 1. Scope Brake Two-Stage Gate: intercept first exploratory search/list/unscoped read on unanchored turn
  if (Boolean(unanchoredTurnFlag) && (isExploratorySearchOrList || isUnscopedRead)) {
    const candidateHint =
      Array.isArray(candidateFiles) && candidateFiles.length > 0
        ? candidateFiles.slice(0, 3).join(', ')
        : '@<target-file>';
    const normOverride = String(overrideMode || 'default').toLowerCase();
    const shouldDeny =
      normOverride === 'block' ||
      normOverride === 'warn' ||
      String(flightMode || '').toUpperCase() === 'AUTO_PILOT';

    return {
      intercepted: true,
      detectorId,
      subType: 'TWO_STAGE_SCOPE_BRAKE_INTERCEPT',
      decision: shouldDeny ? 'deny' : 'allow',
      reason:
        `[${detectorId} Scope Brake Two-Stage Gate] Exploratory tool "${name}" intercepted on unanchored turn. ` +
        `Stop scanning the repository and ask 1 concrete scoping question naming candidate files (${candidateHint}) and the optimization axis.`,
      consumeFlag: true
    };
  }

  // 2. Relay Breaker Two-Stage Gate: intercept exploratory WebFetch/web_search during Armed/Final Pass/Locked spec relay
  const currentRelayState =
    typeof relayState === 'string' ? relayState : relayState?.state || RELAY_STATES.IDLE;
  if (
    isWebSearchTool &&
    (currentRelayState === RELAY_STATES.ARMED ||
      currentRelayState === RELAY_STATES.FINAL_PASS ||
      currentRelayState === RELAY_STATES.LOCKED)
  ) {
    return {
      intercepted: true,
      detectorId,
      subType: 'TWO_STAGE_RELAY_WEB_SEARCH_INTERCEPT',
      decision: 'deny',
      reason:
        `[${detectorId} Relay Breaker Two-Stage Gate] Exploratory web fetch ("${name}") blocked during ${currentRelayState} spec relay. ` +
        `Do not scrape uncited external pages during critique relays; verify claims via local code or ask the user for primary source citations.`,
      consumeFlag: false
    };
  }

  return {
    intercepted: false,
    detectorId: null,
    subType: null,
    decision: 'allow',
    reason: null,
    consumeFlag: false
  };
}

const SHARDED_SPEC_PIVOT_PATTERNS = Object.freeze([
  /\b(?:actually|instead|wait)\b[^.?!]{0,40}\b(?:make|use|support|change|switch|add|keep|enforce|require|return|handle|format|allow|reject|export|include|preserve)\b/i,
  /\b(?:also|additionally)\s+(?:make\s+sure|add|support|include|handle|enforce|allow|ensure|require|update|expose|reject|export|return)\b/i,
  /\b(?:don't\s+forget\s+to|do\s+not\s+forget\s+to|make\s+sure\s+(?:it|we|you)\s+(?:also\s+)?(?:support|handle|reject|enforce|preserve|include|export|return)|one\s+more\s+(?:thing|requirement|constraint)|new\s+requirement|change\s+the\s+(?:format|schema|output|contract|behavior)\s+to)\b/i
]);

const TRIVIAL_COMMAND_FOLLOWUP_RE =
  /^(?:also|and|now|then|please)?\s*(?:just\s+)?(?:run|re-?run|execute|check)\s+(?:the\s+)?(?:unit\s+|integration\s+|all\s+)?(?:tests?|npm\s+test|pnpm\s+test|pytest|vitest|jest|lint|build|typecheck|tsc|git\s+status|git\s+diff)[.!?\s]*$/i;

const TURN1_BUILD_INTENT_RE =
  /\b(?:build|implement|create|design|architect|redesign|migrate|refactor|overhaul|integrate|add\s+support\s+for|set\s+up)\b/i;

const TURN1_QUESTION_RE =
  /^(?:how|why|what|where|when|who|can\s+you\s+explain|could\s+you\s+explain|explain|describe|review|summarize)\b/i;

const TURN1_SPEC_REF_RE = /\bspecs?[\\/][\w.-]+\.md\b/i;

const REAL_CODE_SYMBOL_RE =
  /`[^`]{2,}`|\b[a-z][a-zA-Z0-9]+_[a-zA-Z0-9_]+\b|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]+\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-zA-Z_]\w+\([^\x29]*\)/;

const TURN1_BOUNDARY_RE =
  /\b(?:do\s+not|don't|only|without\s+touching|out\s+of\s+scope|non-goal|avoid|preserve|must\s+not|cannot)\b/i;

const TURN1_VERIFY_RE =
  /\b(?:test|tests|verify|verification|acceptance\s+criteria|should\s+pass|assert|exit\s+code|exit\s+0|spec|benchmark)\b/i;

export const TURN1_CONTRACT_DIRECTIVE =
  '[CTX_CONTRACT: State (1) target files, (2) negative constraints/invariants, and (3) verification command in <=8 lines before calling file-mutation tools.]';

/**
 * Tracks cross-turn requirement-modifying user prompts (`Spec Sharding / Drip-Feed`)
 * and emits `[CTX_HINT: SHARDED_SPEC]` when 4+ constraint shards accumulate alongside `>=25k` tokens.
 * Zero I/O, Mod Law 4 compliant.
 *
 * @param {object} [params={}]
 */
export function evaluateShardedSpecDrift({
  prompt = '',
  provenance = 'user',
  isAutonomousTurn = false,
  isSubagent = false,
  isScheduledTask = false,
  isLoopIteration = false,
  priorShards = [],
  initialGoal = '',
  totalTokens = 0,
  turnNumber = 1,
  lastAlertTurn = 0,
  minShards = 4,
  minTokens = 25000,
  cooldownTurns = 3,
  overrideMode = 'default',
  flightMode = 'COACH',
  detectorId = 'DET-26'
} = {}) {
  const safeShards = Array.isArray(priorShards)
    ? priorShards
        .filter((s) => s && typeof s.excerpt === 'string' && s.excerpt.trim().length > 0)
        .map((s) => ({ turn: Number(s.turn || 0), excerpt: String(s.excerpt).trim() }))
    : [];
  const raw = String(prompt || '').trim();
  const cleaned = raw.replace(/#check\b/gi, '').trim();
  const normOverride = String(overrideMode || 'default').toLowerCase();
  const fmUpper = String(flightMode || 'COACH').toUpperCase();
  const numericTurn = Math.max(1, Number(turnNumber || 1));
  const numericLastAlert = Number(lastAlertTurn || 0);
  const nextInitialGoal =
    String(initialGoal || '').trim() || (numericTurn <= 1 && cleaned ? cleaned.slice(0, 280) : '');

  const noOp = (reason = null) => ({
    detectorId,
    slug: 'sharded-spec-drift',
    triggered: false,
    subType: null,
    decision: 'allow',
    bypassReason: reason,
    shardCount: safeShards.length,
    specShards: safeShards,
    initialGoal: nextInitialGoal,
    lastAlertTurn: numericLastAlert,
    steerContext: null
  });

  if (normOverride === 'off' || fmUpper === 'OFF' || fmUpper === 'SILENT') {
    return noOp('DISABLED_BY_CONFIG');
  }

  if (
    Boolean(isAutonomousTurn) ||
    Boolean(isSubagent) ||
    Boolean(isScheduledTask) ||
    Boolean(isLoopIteration) ||
    AUTONOMOUS_PROVENANCE_RE.test(String(provenance || '')) ||
    !cleaned ||
    cleaned.startsWith('/') ||
    AFFIRMATIVE_OR_CONTINUATION_RE.test(cleaned)
  ) {
    return noOp('AUTONOMOUS_OR_CONTINUATION');
  }

  if (matchRelayHardNegativeFilter(cleaned).matched) {
    return noOp('HARD_NEGATIVE_PAYLOAD');
  }

  let nextShards = safeShards.slice();
  const isFollowUpTurn = numericTurn >= 2 || Boolean(String(initialGoal || '').trim()) || safeShards.length > 0;
  const isPivotPrompt =
    isFollowUpTurn &&
    !TRIVIAL_COMMAND_FOLLOWUP_RE.test(cleaned) &&
    SHARDED_SPEC_PIVOT_PATTERNS.some((re) => re.test(cleaned));

  if (isPivotPrompt) {
    const excerpt = cleaned.slice(0, 220);
    const prevExcerpt = nextShards.length > 0 ? nextShards[nextShards.length - 1].excerpt : '';
    if (excerpt && excerpt !== prevExcerpt) {
      nextShards.push({ turn: numericTurn, excerpt });
      if (nextShards.length > 10) {
        nextShards = nextShards.slice(-10);
      }
    }
  }

  const tokensNum = Math.max(0, Number(totalTokens || 0));
  const cooldownOk = numericLastAlert <= 0 || numericTurn - numericLastAlert >= Number(cooldownTurns || 3);
  const triggered =
    isPivotPrompt &&
    nextShards.length >= Number(minShards || 4) &&
    tokensNum >= Number(minTokens || 25000) &&
    cooldownOk;

  if (!triggered) {
    return {
      detectorId,
      slug: 'sharded-spec-drift',
      triggered: false,
      subType: null,
      decision: 'allow',
      bypassReason: null,
      shardCount: nextShards.length,
      specShards: nextShards,
      initialGoal: nextInitialGoal,
      lastAlertTurn: numericLastAlert,
      steerContext: null
    };
  }

  const steerContext = `[CTX_HINT: SHARDED_SPEC — ${nextShards.length} incremental constraint turns across ~${Math.round(tokensNum / 1000)}k tokens. Run \`npx ctxtop handoff --consolidate\` (or /handoff) to merge scattered requirements into one clean contract before restarting.]`;
  return {
    detectorId,
    slug: 'sharded-spec-drift',
    triggered: true,
    subType: 'SHARDED_SPEC_DRIFT',
    decision: 'steer',
    bypassReason: null,
    shardCount: nextShards.length,
    specShards: nextShards,
    initialGoal: nextInitialGoal,
    lastAlertTurn: numericTurn,
    steerContext
  };
}

/**
 * One-shot Turn-1 Specification Contract Gate (`[CTX_CONTRACT]`) for unanchored multi-file build/refactor prompts.
 * Skips `/plan` mode, questions, slash commands, active-set matches, and Turn 2+.
 * Zero I/O, Mod Law 4 compliant.
 *
 * @param {object} [params={}]
 */
export function evaluateTurn1ContractGate({
  prompt = '',
  provenance = 'user',
  isAutonomousTurn = false,
  isSubagent = false,
  isScheduledTask = false,
  isLoopIteration = false,
  inPlanMode = false,
  turnNumber = 1,
  invocationNum = 1,
  alreadyInjected = false,
  hasActiveSetMatch = false,
  sufficiency = null,
  overrideMode = 'default',
  flightMode = 'COACH',
  detectorId = 'DET-26'
} = {}) {
  const allow = (bypassReason = null) => ({
    detectorId,
    slug: 'turn1-contract-gate',
    triggered: false,
    subType: null,
    decision: 'allow',
    bypassReason,
    contractDirective: null
  });

  const normOverride = String(overrideMode || 'default').toLowerCase();
  const fmUpper = String(flightMode || 'COACH').toUpperCase();
  if (normOverride === 'off' || fmUpper === 'OFF' || fmUpper === 'SILENT') {
    return allow('DISABLED_BY_CONFIG');
  }

  if (
    Boolean(alreadyInjected) ||
    Number(turnNumber || 1) > 1 ||
    Number(invocationNum || 1) > 1 ||
    Boolean(inPlanMode) ||
    Boolean(hasActiveSetMatch)
  ) {
    return allow('NOT_ELIGIBLE_TURN1');
  }

  if (
    Boolean(isAutonomousTurn) ||
    Boolean(isSubagent) ||
    Boolean(isScheduledTask) ||
    Boolean(isLoopIteration) ||
    AUTONOMOUS_PROVENANCE_RE.test(String(provenance || ''))
  ) {
    return allow('AUTONOMOUS_BYPASS');
  }

  const cleaned = String(prompt || '').replace(/#check\b/gi, '').trim();
  if (
    !cleaned ||
    cleaned.startsWith('/') ||
    AFFIRMATIVE_OR_CONTINUATION_RE.test(cleaned) ||
    cleaned.endsWith('?') ||
    TURN1_QUESTION_RE.test(cleaned) ||
    TURN1_SPEC_REF_RE.test(cleaned) ||
    matchRelayHardNegativeFilter(cleaned).matched
  ) {
    return allow('EXEMPT_PROMPT_KIND');
  }

  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount < 8 || wordCount > 55 || !TURN1_BUILD_INTENT_RE.test(cleaned)) {
    return allow('NOT_UNANCHORED_BUILD');
  }

  const hasConcreteTarget =
    CONCRETE_FILE_OR_PATH_RE.test(cleaned) || REAL_CODE_SYMBOL_RE.test(cleaned);
  if (hasConcreteTarget) {
    return allow('HAS_CONCRETE_TARGET');
  }

  const dims = sufficiency?.dims || null;
  const lacksBoundaryOrVerify = dims
    ? Number(dims.boundedness || 0) === 0 || Number(dims.testability || 0) === 0
    : !TURN1_BOUNDARY_RE.test(cleaned) || !TURN1_VERIFY_RE.test(cleaned);

  if (!lacksBoundaryOrVerify) {
    return allow('HAS_CONSTRAINTS_AND_VERIFY');
  }

  return {
    detectorId,
    slug: 'turn1-contract-gate',
    triggered: true,
    subType: 'TURN1_CONTRACT_GATE',
    decision: 'steer',
    bypassReason: null,
    contractDirective: TURN1_CONTRACT_DIRECTIVE
  };
}
