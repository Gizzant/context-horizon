# Source File: src/core/prompt_rubric.mjs

```javascript
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
    'Cache expired. Run parameterized compaction now before firing next turn.'
});

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
 * Hotfix: formats a file path as a clean workspace-relative path (no `.../` prefixes).
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
 * Hotfix: sanitizes a raw user message into a concise constraint clause.
 * Strips `/plan` (and other slash-command) headers, artifact/file URIs, XML-ish wrapper tags and
 * markdown headers, then truncates cleanly at a word boundary within `maxLen` characters.
 * Returns '' when nothing meaningful remains.
 */
export function sanitizeUserConstraintText(raw, maxLen = 90) {
  if (typeof raw !== 'string') return '';
  let txt = raw
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
 * Phase 4 (Layer 4): Synthesizes a parameterized, context-preserving /compact command
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
 * Phase 4 (Layer 4): Evaluates Cache-Aware Compaction Advisory.
 * - If Cache TTL > 0s and totalActiveTokens <= 179k: Defer compaction until work pause.
 * - If Cache TTL == 0s OR totalActiveTokens > 179k: Run parameterized compaction now.
 * - Hotfix: when `isCacheTrulyWarm === false` (0 cache reads / 0% hit / prefix bust), never DEFER_WARM.
 */
export function evaluateCompactionCacheAdvisory({
  cacheTtlRemainingSec = 300,
  totalActiveTokens = 0,
  safeHorizonTokens = 179000,
  isCacheTrulyWarm
} = {}) {
  const isExpiredOrOverHorizon = isCacheTrulyWarm === false ||
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
 * Phase 4 (Layer 4): Synthesizes The Baton Pass (/handoff) workflow command and target path.
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

  const command = `/handoff Summarize active AST contracts (${filesSummary}), latest test verification states, and pending task.md items (${tasksSummary}) into ${handoffFile} so the next session starts with zero conversational debt and 100% constraint retention.`;
  return {
    timestamp: ts,
    handoffFile,
    command
  };
}
```
