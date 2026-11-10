/**
 * Prompt Sufficiency Rubric (adapted from analyze-project.md Step 4).
 * Evaluates prompt quality deterministically across 6 dimensions (0-2 each, total 12).
 *
 * Ground Rule: "Short prompts are not bad by default" - concise scoped instructions
 * targeting existing active-set files should not be penalised.
 */

export const RUBRIC_DIMENSIONS = [
  'clarity',
  'boundedness',
  'testability',
  'architecturalSpecificity',
  'constraintAwareness',
  'dependencyAwareness'
];

export const SUFFICIENCY_BANDS = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low'
};

/**
 * Deterministically scores a user prompt against the 6 sufficiency dimensions.
 * @param {string} promptText
 * @param {Object} context
 * @param {string[]} [context.activeSetPaths=[]]
 * @returns {Object} { score: number, band: string, dims: Object, missing: string[], shortPrompt: boolean }
 */
export function scorePromptSufficiency(promptText = '', { activeSetPaths = [] } = {}) {
  const text = String(promptText || '').trim();
  const lower = text.toLowerCase();

  const tokenCountEst = Math.max(1, Math.ceil(text.length / 4));

  // Detect explicit file/symbol targets
  const hasFilePath = /(@[\w./\\-]+|\b[\w-]+\.(mjs|js|ts|json|md|py|go|rs|html|css)\b|[/\\][\w.-]+)/i.test(text);
  const hasSymbol = /\b[a-zA-Z_]\w+\([^)]*\)|\b[A-Z][a-zA-Z0-9]+\b/.test(text);
  const matchesActiveSet = (activeSetPaths || []).some(p => {
    const base = p.split(/[/\\]/).pop();
    return base && (lower.includes(base.toLowerCase()) || text.includes(p));
  });

  const isShort = tokenCountEst <= 18;
  const shortPrompt = isShort && (hasFilePath || matchesActiveSet || /^(fix|yes|no|proceed|continue|run|test|compact)\b/i.test(text));

  const dims = {
    clarity: 0,
    boundedness: 0,
    testability: 0,
    architecturalSpecificity: 0,
    constraintAwareness: 0,
    dependencyAwareness: 0
  };

  const missing = [];

  // 1. Clarity (0-2): Action verb + clear object, penalise floating vague pronouns
  const hasActionVerb = /\b(add|create|update|modify|refactor|fix|remove|delete|implement|wire|extract|replace|audit|check)\b/i.test(text);
  const vagueCatchAll = /\b(everything|all|stuff|things|broken|make it work|fix this|do it)\b/i.test(lower);
  if (hasActionVerb && !vagueCatchAll) {
    dims.clarity = 2;
  } else if (hasActionVerb || (text.length > 10 && !vagueCatchAll)) {
    dims.clarity = 1;
  } else {
    dims.clarity = 0;
    missing.push('clear action verb & concrete scope');
  }

  // 2. Boundedness (0-2): explicit scope boundaries
  const hasNegativeBoundary = /\b(do not|don't|only|leave alone|without touching|out of scope|non-goal|avoid|preserve)\b/i.test(lower);
  const hasSingleTarget = (hasFilePath && !/\b(all files|entire codebase|everywhere)\b/i.test(lower));
  if (hasNegativeBoundary) {
    dims.boundedness = 2;
  } else if (hasSingleTarget || shortPrompt) {
    dims.boundedness = 1;
  } else {
    dims.boundedness = 0;
    missing.push('scope boundaries (what NOT to touch)');
  }

  // 3. Testability (0-2): explicit verification criteria
  const hasVerificationSpec = /\b(test|tests|verify|verification|acceptance criteria|should pass|assert|exit code|exit 0|spec|benchmark)\b/i.test(lower);
  const hasExpectedOutput = /\b(expect|expected|result should be|returns|outputs)\b/i.test(lower);
  if (hasVerificationSpec && hasExpectedOutput) {
    dims.testability = 2;
  } else if (hasVerificationSpec || hasExpectedOutput) {
    dims.testability = 1;
  } else {
    dims.testability = 0;
    missing.push('testability & expected outcome');
  }

  // 4. Architectural Specificity (0-2): target files or code symbols
  if (hasFilePath && hasSymbol) {
    dims.architecturalSpecificity = 2;
  } else if (hasFilePath || matchesActiveSet || hasSymbol) {
    dims.architecturalSpecificity = 1;
  } else {
    dims.architecturalSpecificity = 0;
    missing.push('file/symbol target (@file or function)');
  }

  // 5. Constraint Awareness (0-2): explicit operational invariants
  const hasHardConstraints = /\b(must|must not|cannot|without adding|zero[- ]dep|strict|<15ms|backward compatible|parity|invariant)\b/i.test(lower);
  const hasSoftConstraints = /\b(keep|ensure|make sure|prefer|clean|minimal)\b/i.test(lower);
  if (hasHardConstraints) {
    dims.constraintAwareness = 2;
  } else if (hasSoftConstraints) {
    dims.constraintAwareness = 1;
  } else {
    dims.constraintAwareness = 0;
    missing.push('invariants or operational constraints');
  }

  // 6. Dependency Awareness (0-2): downstream callers, imports, mirrors
  const hasDepTerms = /\b(caller|callers|import|imports|importer|importers|dependent|downstream|consumer|mirror|mirrors|sidecar|sync)\b/i.test(lower);
  const hasCrossFileMention = (text.match(/[\w-]+\.(mjs|js|ts|json|md)/g) || []).length >= 2;
  if (hasDepTerms && hasCrossFileMention) {
    dims.dependencyAwareness = 2;
  } else if (hasDepTerms || hasCrossFileMention) {
    dims.dependencyAwareness = 1;
  } else {
    dims.dependencyAwareness = 0;
    missing.push('dependency / caller considerations');
  }

  // Total Score (0-12)
  const score = Object.values(dims).reduce((sum, v) => sum + v, 0);

  let band = SUFFICIENCY_BANDS.LOW;
  if (score >= 9) {
    band = SUFFICIENCY_BANDS.HIGH;
  } else if (score >= 5) {
    band = SUFFICIENCY_BANDS.MEDIUM;
  }

  return {
    score,
    band,
    dims,
    missing,
    shortPrompt
  };
}

export const COMPACTION_ADVISORY_MESSAGES = Object.freeze({
  DEFER_WARM:
    'Cache is currently warm (95% token cost discount). Defer compaction until work pause to avoid 70s execution stall and complete KV cache invalidation.',
  COMPACT_NOW:
    'Cache expired. Run parameterized compaction now before firing next turn.',
  LEAN_NO_COMPACT:
    'Session is lean \u2014 no compaction needed until >50k tokens'
});

export const LEAN_SESSION_MIN_TOKENS = 50000;
export const LEAN_SESSION_MIN_SLUDGE = 25000;

/** True when compaction is worth its ~70s stall: >=50k active, >=25k reclaimable, or past the safe horizon. */
export function isCompactionRelevant({ totalActiveTokens = 0, sludgeTokens = 0, safeHorizonTokens = 179000 } = {}) {
  return Number(totalActiveTokens) > Number(safeHorizonTokens || 179000) ||
    Number(totalActiveTokens) >= LEAN_SESSION_MIN_TOKENS ||
    Number(sludgeTokens) >= LEAN_SESSION_MIN_SLUDGE;
}

/**
 * Returns true if a file path is an internal Antigravity telemetry/hydration log
 * or brain artifact path that must be excluded from active workspace AST lists.
 */
export function isInternalTelemetryPath(p) {
  if (!p) return true;
  const s = String(p).trim().replace(/\\/g, '/');
  if (!s || s.includes('Older chat history')) return true;
  if (/\.system_generated(\/|$)/i.test(s)) return true;
  if (/(^|\/)\.gemini\/antigravity[^/]*\/brain(\/|$)/i.test(s)) return true;
  if (/(^|\/)steps\/\d+\/output\.txt$/i.test(s)) return true;
  if (/^\d+\/output\.txt$/i.test(s)) return true;
  return false;
}

const WORKSPACE_TOP_LEVEL_DIRS = new Set([
  'src', 'tests', 'test', 'scripts', 'docs', 'lib', 'app', 'packages', 'config',
  'sidecars', 'skills', 'rules', 'public', 'assets', 'bin', 'tools', 'examples'
]);

/**
 * formats a file path as a clean workspace-relative path (no `.../` prefixes).
 * Prefers stripping `workspaceRoot`; otherwise anchors on a well-known top-level directory
 * (src/, tests/, scripts/, ...); otherwise falls back to the last two path segments.
 */
export function toWorkspaceRelativePath(p, workspaceRoot = '') {
  if (!p) return '';
  let s = String(p).trim().replace(/\\/g, '/').replace(/^file:\/\/\/?/i, '');
  s = s.replace(/^(\.\.\.\/)+/, '').replace(/^\.\//, '');
  const root = String(workspaceRoot || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && s.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    return s.slice(root.length + 1);
  }
  const segs = s.split('/').filter(Boolean);
  if (segs.length <= 1) return segs.join('/');
  const isAbsolute = /^([a-zA-Z]:|\/)/.test(s);
  if (!isAbsolute) return segs.join('/');
  for (let i = segs.length - 2; i >= 0; i--) {
    if (WORKSPACE_TOP_LEVEL_DIRS.has(segs[i].toLowerCase())) {
      // Use the outermost matching anchor (e.g. src/webview/x.html, not webview/x.html)
      let j = i;
      for (let k = i - 1; k >= 0; k--) {
        if (WORKSPACE_TOP_LEVEL_DIRS.has(segs[k].toLowerCase())) j = k;
      }
      return segs.slice(j).join('/');
    }
  }
  return segs.slice(-2).join('/');
}

/**
 * sanitizes a raw user message into a concise constraint clause.
 * Strips `/plan` (and other slash-command) headers, artifact/file URIs, XML-ish wrapper tags and
 * markdown headers, then truncates cleanly at a word boundary within `maxLen` characters.
 * Returns '' when nothing meaningful remains.
 */
export function sanitizeUserConstraintText(raw, maxLen = 90) {
  if (typeof raw !== 'string') return '';
  let txt = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, ' ')
    .replace(/<\/?[A-Za-z_][\w-]*[^>]*>/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^\/[a-z][\w-]*\b/i.test(line) && !/^#{1,6}\s/.test(line))
    .join(' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/\[([^\]]*)\]\(\s*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!txt || !/[a-z]{2,}/i.test(txt)) return '';
  if (txt.length > maxLen) {
    const cut = txt.slice(0, maxLen - 1);
    const lastSpace = cut.lastIndexOf(' ');
    txt = (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-]+$/, '') + '\u2026';
  }
  return txt;
}

/**
 * Synthesizes a parameterized, context-preserving /compact command
 * pulling in active file paths and extracted in-chat user corrections.
 */
export function synthesizeParameterizedCompact({
  activeFiles = [],
  userCorrections = [],
  steps = [],
  workspaceRoot = ''
} = {}) {
  const fileSet = new Set();
  for (const f of activeFiles || []) {
    if (!f) continue;
    const raw = typeof f === 'string' ? f : (f.path || f.target || '');
    if (isInternalTelemetryPath(raw)) continue;
    const clean = toWorkspaceRelativePath(raw, workspaceRoot);
    if (clean && !isInternalTelemetryPath(clean)) fileSet.add(clean);
  }
  if (fileSet.size === 0 && Array.isArray(steps)) {
    for (let i = steps.length - 1; i >= 0 && fileSet.size < 4; i--) {
      const calls = steps[i]?.toolCalls || [];
      for (const c of calls) {
        const p = c?.args?.Path || c?.args?.path || c?.args?.TargetFile;
        if (p && typeof p === 'string' && !isInternalTelemetryPath(p)) {
          const clean = toWorkspaceRelativePath(p, workspaceRoot);
          if (clean && !isInternalTelemetryPath(clean)) fileSet.add(clean);
        }
      }
    }
  }
  const filesList = fileSet.size > 0
    ? Array.from(fileSet).slice(0, 4).join(', ')
    : 'active workspace files';

  const constraintsSet = new Set();
  if (Array.isArray(userCorrections)) {
    for (const corr of userCorrections) {
      const clean = sanitizeUserConstraintText(corr, 90);
      if (clean) constraintsSet.add(clean);
    }
  }
  if (constraintsSet.size === 0 && Array.isArray(steps)) {
    for (const s of steps) {
      if (s?.source === 'USER_EXPLICIT' || s?.type === 'USER_INPUT') {
        const txt = String(s.content || '').trim();
        if (/\b(no[, ]|don't|do not|instead|wrong|must|never|strictly|preserve)\b/i.test(txt)) {
          const clean = sanitizeUserConstraintText(txt, 90);
          if (clean) constraintsSet.add(clean);
        }
      }
    }
  }

  const base = `/compact Focus on preserving: 1) Exported symbol signatures and state scales for [${filesList}], 2) Current checklist state in task.md`;
  if (constraintsSet.size === 0) {
    // No valid user constraint text: omit clause 3 entirely rather than emitting a placeholder.
    return `${base}.`;
  }
  const constraintsList = Array.from(constraintsSet).slice(0, 3).join('; ');
  return `${base}, 3) Explicit user constraints: [${constraintsList}].`;
}

/**
 * Evaluates Cache-Aware Compaction Advisory.
 * - If Cache TTL > 0s and totalActiveTokens <= 179k: Defer compaction until work pause.
 * - If Cache TTL == 0s OR totalActiveTokens > 179k: Run parameterized compaction now.
 * - when `isCacheTrulyWarm === false` (0 cache reads / 0% hit / prefix bust), never DEFER_WARM.
 */
export function evaluateCompactionCacheAdvisory({
  cacheTtlRemainingSec = 300,
  totalActiveTokens = 0,
  safeHorizonTokens = 179000,
  isCacheTrulyWarm,
  nextTurnLikelyWarm,
  sludgeTokens = 0
} = {}) {
  if (!isCompactionRelevant({ totalActiveTokens, sludgeTokens, safeHorizonTokens })) {
    return {
      state: 'LEAN_NO_COMPACT',
      domState: 'lean-no-compact',
      message: COMPACTION_ADVISORY_MESSAGES.LEAN_NO_COMPACT
    };
  }
  // a turn that missed the cache wrote a fresh prefix, so the *next* turn is likely warm.
  // When `nextTurnLikelyWarm` is supplied it supersedes the strict badge predicate for this advisory.
  const warmEvidence = typeof nextTurnLikelyWarm === 'boolean' ? nextTurnLikelyWarm : isCacheTrulyWarm;
  const isExpiredOrOverHorizon = warmEvidence === false ||
    Number(cacheTtlRemainingSec) <= 0 || Number(totalActiveTokens) > Number(safeHorizonTokens || 179000);
  if (isExpiredOrOverHorizon) {
    return {
      state: 'COMPACT_NOW',
      domState: 'cold-compact-now',
      message: COMPACTION_ADVISORY_MESSAGES.COMPACT_NOW
    };
  }
  return {
    state: 'DEFER_WARM',
    domState: 'warm-defer',
    message: COMPACTION_ADVISORY_MESSAGES.DEFER_WARM
  };
}

/**
 * Synthesizes The Baton Pass (/handoff) workflow command and target path.
 */
export function synthesizeBatonPassHandoffCommand({
  timestamp = null,
  activeFiles = [],
  pendingTasks = []
} = {}) {
  const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const handoffFile = `docs/HANDOFF_${ts}.md`;
  const cleanActive = (activeFiles || [])
    .map(f => typeof f === 'string' ? f : (f?.path || f?.target || ''))
    .filter(p => p && !isInternalTelemetryPath(p));
  const filesSummary = cleanActive.length > 0
    ? cleanActive.slice(0, 5).join(', ')
    : 'active workspace modules';
  const tasksSummary = (pendingTasks && pendingTasks.length > 0)
    ? pendingTasks.slice(0, 3).join('; ')
    : 'remaining checklist items in task.md';

  const command = `/handoff Summarize active AST contracts (${filesSummary}), latest test verification states, and pending task.md items (${tasksSummary}) into ${handoffFile} so a fresh chat can pick up from a written summary.`;
  return {
    timestamp: ts,
    handoffFile,
    command
  };
}

function fmtKShort(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n <= 0) return '0k';
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

function fmtMmSs(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${String(rem).padStart(2, '0')}s` : `${rem}s`;
}

/**
 * Computes a single deterministic top-level Tufte verdict line resolving
 * the trade-off between KV-cache warmth (300s TTL), Effort-Adaptive Safe Limit (e.g. 147k High),
 * and active DET-* circuit breakers.
 */
export function computeUnifiedVerdict({
  totalActiveTokens = 0,
  safeLimitTokens = 147000,
  maxTokens = 256000,
  effortShortLabel = 'High',
  cacheTtlRemainingSec = 0,
  isCacheWarm = false,
  reclaimableTokens = 0,
  activeCircuitBreaker = null,
  routerNudgeLabel = ''
} = {}) {
  const total = Math.max(0, Number(totalActiveTokens) || 0);
  const safe = Math.max(20000, Number(safeLimitTokens) || 147000);
  const ceiling = Math.max(safe, Number(maxTokens) || 256000);
  const ttl = Math.max(0, Number(cacheTtlRemainingSec) || 0);
  const warm = Boolean(isCacheWarm && ttl > 0);
  const reclaim = Math.max(0, Number(reclaimableTokens) || 0);
  const label = effortShortLabel || 'Auto';

  // Precedence 1: Active DET-* Circuit Breaker or Imminent Hard Ceiling (>90% of maxTokens)
  if (activeCircuitBreaker || total >= Math.round(ceiling * 0.90)) {
    const reason = activeCircuitBreaker || `At ${fmtKShort(total)} / ${fmtKShort(ceiling)} ceiling`;
    return {
      state: 'CRITICAL_STOP',
      severity: 'danger',
      headline: `STOP & HANDOFF · ${reason} · Overrides warm cache`,
      routerHoldNote: ''
    };
  }

  // Precedence 2: Over Effort-Adaptive Safe Limit while Cache is Warm -> HOLD COMPACT
  if (total > safe && warm) {
    const overStr = fmtKShort(total - safe);
    return {
      state: 'HOLD_COMPACT',
      severity: 'warn',
      headline: `HOLD COMPACT · Cache warm ${fmtMmSs(ttl)} · +${overStr} over ${label}`,
      routerHoldNote: routerNudgeLabel ? `${routerNudgeLabel} (held while cache warm)` : ''
    };
  }

  // Precedence 3: Over Safe Limit or High Reclaimable Sludge (>=25k on >=50k session) with Cold Cache -> COMPACT NOW
  if (total > safe || (total >= LEAN_SESSION_MIN_TOKENS && reclaim >= LEAN_SESSION_MIN_SLUDGE)) {
    if (!warm) {
      const recStr = fmtKShort(reclaim > 0 ? reclaim : Math.max(1000, total - safe));
      return {
        state: 'COMPACT_NOW',
        severity: 'amber',
        headline: `COMPACT NOW · Cache cold · Reclaim ${recStr}`,
        routerHoldNote: routerNudgeLabel || ''
      };
    }
    return {
      state: 'HOLD_COMPACT',
      severity: 'warn',
      headline: `HOLD COMPACT · Cache warm ${fmtMmSs(ttl)} · ${fmtKShort(reclaim)} staged`,
      routerHoldNote: routerNudgeLabel ? `${routerNudgeLabel} (held while cache warm)` : ''
    };
  }

  // Precedence 4: Nominal
  const headroomStr = fmtKShort(Math.max(0, safe - total));
  const cachePart = warm ? `Cache warm ${fmtMmSs(ttl)}` : 'Cache cold';
  return {
    state: 'NOMINAL',
    severity: 'ok',
    headline: `NOMINAL · ${cachePart} · ${headroomStr} to ${label} cap`,
    routerHoldNote: routerNudgeLabel
      ? (warm ? `${routerNudgeLabel} (locked ${fmtMmSs(ttl)})` : routerNudgeLabel)
      : ''
  };
}

const SPARK_GLYPHS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/**
 * Renders a 16-turn inline Unicode sparkline of per-turn token growth.
 */
export function buildTurnVelocitySparkline(turnDeltas = [], maxTurns = 16) {
  const arr = Array.isArray(turnDeltas)
    ? turnDeltas.map(n => Math.max(0, Number(n) || 0)).slice(-maxTurns)
    : [];
  if (arr.length === 0) return '';
  const peak = Math.max(...arr, 1000);
  return arr.map(val => {
    if (val <= 0) return SPARK_GLYPHS[0];
    const idx = Math.min(SPARK_GLYPHS.length - 1, Math.max(0, Math.floor((val / peak) * (SPARK_GLYPHS.length - 1))));
    return SPARK_GLYPHS[idx];
  }).join('');
}

/**
 * Accounts for 100% of a single turn's token delta (e.g. "write 5.5k + 4 tool steps 46.6k")
 * so there is never an unexplained gap between the total delta and the single largest step.
 */
export function formatFullTurnDeltaAccounting(delta = {}) {
  const total = Math.max(0, Number(delta?.tokens) || 0);
  if (total < 100) return '';
  if (typeof delta?.accountingSummary === 'string' && delta.accountingSummary.trim()) {
    return delta.accountingSummary.trim();
  }
  const writeTok = Number(delta?.writeTokens ?? delta?.promptAndResponseTokens ?? 0);
  const toolTok = Number(delta?.toolTokens ?? 0);
  const toolCount = Number(delta?.toolStepCount ?? delta?.toolCallsCount ?? 0);
  if (writeTok > 0 && toolTok > 0) {
    const stepLabel = toolCount > 0 ? `${toolCount} tool step${toolCount === 1 ? '' : 's'}` : 'tools';
    return `write ${fmtKShort(writeTok)} + ${stepLabel} ${fmtKShort(toolTok)}`;
  }
  const topTok = Math.min(total, Math.max(0, Number(delta?.topSource?.tokens) || 0));
  const topLabel = String(delta?.topSource?.label || '').trim();
  if (topTok > 0 && topTok < total * 0.88) {
    const restTok = Math.max(0, total - topTok);
    const stepCount = Math.max(1, Number(delta?.stepCount || toolCount || 2) - 1);
    const cleanTop = /^(planner response|model response|agent response)$/i.test(topLabel)
      ? 'write'
      : (topLabel ? topLabel.split(/[\\/]/).pop().slice(0, 18) : 'top step');
    return `${cleanTop} ${fmtKShort(topTok)} + ${stepCount} step${stepCount === 1 ? '' : 's'} ${fmtKShort(restTok)}`;
  }
  if (topLabel) {
    const cleanTop = /^(planner response|model response)$/i.test(topLabel) ? 'agent response' : topLabel.split(/[\\/]/).pop();
    return `${cleanTop} (${fmtKShort(topTok || total)})`;
  }
  return `${fmtKShort(total)} across turn`;
}

