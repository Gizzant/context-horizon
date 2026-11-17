/**
 * @file src/core-isomorphic/diagnostics/drift_guard.mjs
 * DET-32 IOEDR / REMORY Semantic Drift & Contradiction Guard.
 *
 * Detects actions contradicting locked task.md invariants and repeating
 * falsified hypotheses across >= 3 turns. Injects a <300-token re-anchoring directive.
 *
 * Pure JS / ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

const POSITIVE_MARKERS = /\b(always|must|ensure|require|required|mandatory|enforce)\b/i;
const NEGATIVE_MARKERS = /\b(never|do not|don't|dont|prohibit|prohibited|forbidden|cannot|must not|disallow|refuse)\b/i;
const INSTEAD_OF_REGEX = /(?:use|prefer)\s+([a-zA-Z0-9_-]+)\s+(?:instead of|rather than)\s+([a-zA-Z0-9_-]+)/i;

/**
 * Escapes special regex characters in a string.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a regex that matches a token with word/command boundaries,
 * avoiding substring collisions (e.g. `pnpm` matching `npm`, `bash` or `push` matching `sh`)
 * and preventing file extensions (e.g. `.sh` in `run.sh` or `.npm` in `package.npm`) from matching.
 *
 * @param {string} token
 * @returns {RegExp}
 */
export function buildTokenBoundaryRegex(token) {
  const escaped = escapeRegex(token);
  return new RegExp(`(?<![a-zA-Z0-9_.])(?:${escaped})(?![a-zA-Z0-9_])`, 'i');
}

/**
 * Parses directive polarity and subjects.
 *
 * @param {string} directive
 * @returns {{ polarity: 'POSITIVE' | 'NEGATIVE' | 'INSTEAD_OF' | 'NEUTRAL', preferred?: string, forbidden?: string, subjects: string[] }}
 */
export function parseDirectivePolarity(directive = '') {
  const str = String(directive || '').trim();
  if (!str) return { polarity: 'NEUTRAL', subjects: [] };

  const insteadMatch = str.match(INSTEAD_OF_REGEX);
  if (insteadMatch) {
    const preferred = insteadMatch[1].toLowerCase();
    const forbidden = insteadMatch[2].toLowerCase();
    return {
      polarity: 'INSTEAD_OF',
      preferred,
      forbidden,
      subjects: [preferred, forbidden]
    };
  }

  const isNeg = NEGATIVE_MARKERS.test(str);
  const isPos = POSITIVE_MARKERS.test(str);

  // Stop words: purely grammatical, prepositions, auxiliaries, quantifiers, negation words
  // DO NOT drop domain rule subjects like 'delete', 'modify', 'remove', 'files' when they are rule targets.
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'always', 'never',
    'must', 'should', 'would', 'could', 'cannot', 'have', 'been', 'before', 'after',
    'directly', 'manually', 'using',
    'not', 'don', 'dont', 'any', 'all', 'does', 'do', 'without', 'each', 'every', 'such',
    'code', 'step', 'turn', 'will', 'shall', 'just', 'only', 'both', 'either'
  ]);

  const rawTokens = str.toLowerCase()
    .replace(/[^a-z0-9_.-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !stopWords.has(t));

  const subjects = Array.from(new Set(rawTokens));

  // Modal precedence: Negative prohibitions take precedence over positive modal auxiliaries
  // e.g. "You must NEVER run rm -rf" -> NEGATIVE
  if (isNeg) {
    return { polarity: 'NEGATIVE', subjects };
  }
  if (isPos) {
    return { polarity: 'POSITIVE', subjects };
  }

  return { polarity: 'NEUTRAL', subjects };
}

/**
 * Extracts invariant strings from raw task.md content or list.
 *
 * @param {string|string[]} source
 * @returns {string[]}
 */
export function extractLockedInvariants(source) {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.map(s => String(s || '').trim()).filter(Boolean);
  }

  const text = String(source || '');
  const lines = text.split(/\r?\n/);
  const invariants = [];
  let inInvariantSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#+\s+(?:.*(?:Invariant|Constraint|Key Rule|Never|Ground Rule)|🔒)/i.test(trimmed)) {
      inInvariantSection = true;
      continue;
    }
    if (inInvariantSection && /^#+\s+/.test(trimmed)) {
      inInvariantSection = false;
    }

    if (inInvariantSection) {
      if (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
        const cleaned = trimmed.replace(/^[-*]|\d+\.\s*/, '').trim();
        if (cleaned) invariants.push(cleaned);
      }
    } else if (
      (trimmed.startsWith('-') || trimmed.startsWith('*')) &&
      (NEGATIVE_MARKERS.test(trimmed) || POSITIVE_MARKERS.test(trimmed) || INSTEAD_OF_REGEX.test(trimmed))
    ) {
      const cleaned = trimmed.replace(/^[-*]\s*/, '').trim();
      if (cleaned) invariants.push(cleaned);
    }
  }

  return invariants;
}

const NEGATION_BYPASS_PREFIX = '(?:skip(?:ping|ped)?|bypass(?:ing|ed)?|disabl(?:e|ing|ed)|omit(?:ting|ted)?|ignor(?:e|ing|ed)|without|never|no|not|do not)';

/**
 * Audits candidate action against locked invariants.
 *
 * @param {object} candidateAction
 * @param {string[]} invariants
 * @returns {Array<{ rule: string, reason: string }>}
 */
export function auditInvariantContradiction(candidateAction = {}, invariants = []) {
  if (!candidateAction || !Array.isArray(invariants) || invariants.length === 0) return [];

  const actionText = [
    candidateAction.description,
    candidateAction.command,
    candidateAction.targetFile,
    candidateAction.proposedContent,
    candidateAction.tool
  ].filter(Boolean).join(' ').toLowerCase();

  const violations = [];

  for (const rule of invariants) {
    const parsed = parseDirectivePolarity(rule);

    if (parsed.polarity === 'INSTEAD_OF' && parsed.forbidden) {
      const forbiddenRegex = buildTokenBoundaryRegex(parsed.forbidden);
      if (forbiddenRegex.test(actionText)) {
        violations.push({
          rule,
          reason: `Action references forbidden alternative "${parsed.forbidden}" instead of preferred "${parsed.preferred}"`
        });
      }
    } else if (parsed.polarity === 'NEGATIVE' && parsed.subjects.length > 0) {
      // Check if candidate action explicitly invokes forbidden subject as a word/token
      const matches = parsed.subjects.filter(s => {
        const regex = buildTokenBoundaryRegex(s);
        return regex.test(actionText);
      });
      if (matches.length > 0) {
        violations.push({
          rule,
          reason: `Action violates negative invariant by operating on forbidden subject(s): ${matches.join(', ')}`
        });
      }
    } else if (parsed.polarity === 'POSITIVE' && parsed.subjects.length > 0) {
      // Check if action explicitly skips, bypasses, disables, or negates required positive subjects
      const contradictedSubjects = [];
      for (const s of parsed.subjects) {
        // Pattern 1: Negation prefix within 0-3 words before subject (e.g. "skip verification tests")
        const r1 = new RegExp(`\\b${NEGATION_BYPASS_PREFIX}\\s+(?:\\w+\\s+){0,3}\\b${escapeRegex(s)}\\b`, 'i');
        // Pattern 2: Subject followed by passive negation (e.g. "verification is disabled")
        const r2 = new RegExp(`\\b${escapeRegex(s)}\\s+(?:(?:is|are|was|were)\\s+)?(?:skip(?:ped)?|disabl(?:ed)?|bypassed|omit(?:ted)?|ignor(?:ed)?)\\b`, 'i');
        // Pattern 3: CLI flags like --no-verify, --skip-tests
        const r3 = new RegExp(`(?:--no-|--skip-)${escapeRegex(s)}`, 'i');

        if (r1.test(actionText) || r2.test(actionText) || r3.test(actionText)) {
          contradictedSubjects.push(s);
        }
      }
      if (contradictedSubjects.length > 0) {
        violations.push({
          rule,
          reason: `Action contradicts positive invariant by omitting, skipping, or negating required subject(s): ${contradictedSubjects.join(', ')}`
        });
      }
    }
  }

  return violations;
}

/**
 * Normalizes hypothesis string for loop comparison.
 *
 * @param {string} hyp
 * @returns {string}
 */
function normalizeHypothesis(hyp = '') {
  return String(hyp || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 15)
    .join(' ');
}

/**
 * Audits recent turns for repeating falsified hypotheses across >= 3 turns.
 *
 * @param {Array<object>} recentTurns
 * @returns {{ isLoop: boolean, hypothesis: string | null, failedCount: number }}
 */
export function auditHypothesisLoop(recentTurns = []) {
  if (!Array.isArray(recentTurns) || recentTurns.length < 3) {
    return { isLoop: false, hypothesis: null, failedCount: 0 };
  }

  let consecutiveFails = 0;
  let lastNormHyp = null;
  let rawHyp = null;

  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const turn = recentTurns[i];
    if (!turn) break;

    const isFailed = turn.outcome === 'failed' || turn.status === 'failed' || turn.error;
    if (!isFailed) break;

    const hyp = turn.hypothesis || turn.assumption || turn.description || '';
    const norm = normalizeHypothesis(hyp);

    if (!norm) {
      if (consecutiveFails === 0) {
        lastNormHyp = 'unspecified_failure';
        rawHyp = hyp || 'repeated failed step';
      }
      consecutiveFails++;
      continue;
    }

    if (consecutiveFails === 0) {
      lastNormHyp = norm;
      rawHyp = hyp;
      consecutiveFails = 1;
    } else if (lastNormHyp === norm || (norm.length > 10 && (lastNormHyp.includes(norm) || norm.includes(lastNormHyp)))) {
      consecutiveFails++;
    } else {
      break;
    }
  }

  const isLoop = consecutiveFails >= 3;
  return {
    isLoop,
    hypothesis: isLoop ? rawHyp : null,
    failedCount: consecutiveFails
  };
}

/**
 * Evaluates DET-32 IOEDR / REMORY semantic drift.
 *
 * @param {object} turnContext
 * @param {string[]} [turnContext.invariants] - Explicit locked invariant rule strings
 * @param {string} [turnContext.taskMdContent] - Raw content of task.md to parse invariants from
 * @param {object} [turnContext.candidateAction] - Action proposed in the current turn
 * @param {Array<object>} [turnContext.recentTurns] - Recent turn records with { hypothesis, outcome: 'passed'|'failed', turn }
 * @param {string} [turnContext.flightMode='COACH'] - 'COACH' | 'AUTO_PILOT'
 * @returns {object} Evaluation result
 */
export function evaluateSemanticDrift(turnContext = {}) {
  const invariants = Array.isArray(turnContext.invariants) && turnContext.invariants.length > 0
    ? turnContext.invariants
    : extractLockedInvariants(turnContext.taskMdContent);

  const candidateAction = turnContext.candidateAction || null;
  const recentTurns = turnContext.recentTurns || [];
  const flightMode = turnContext.flightMode || 'COACH';

  const invariantViolations = candidateAction ? auditInvariantContradiction(candidateAction, invariants) : [];
  const hypothesisAudit = auditHypothesisLoop(recentTurns);

  const violations = [];
  if (invariantViolations.length > 0) {
    for (const v of invariantViolations) {
      violations.push({
        type: 'INVARIANT_CONTRADICTION',
        rule: v.rule,
        detail: v.reason
      });
    }
  }

  if (hypothesisAudit.isLoop) {
    violations.push({
      type: 'HYPOTHESIS_LOOP',
      hypothesis: hypothesisAudit.hypothesis,
      failedCount: hypothesisAudit.failedCount,
      detail: `Repeating falsified hypothesis across ${hypothesisAudit.failedCount} consecutive failed turns: "${hypothesisAudit.hypothesis}"`
    });
  }

  const triggered = violations.length > 0;

  if (!triggered) {
    return {
      detectorId: 'DET-32',
      slug: 'semantic-drift-guard',
      triggered: false,
      decision: 'allow',
      violations: [],
      reanchoringDirective: null,
      reason: null
    };
  }

  // Defensive truncation: bounded conflict lines (max 3 items, max 120 chars each)
  const conflictLines = violations.slice(0, 3).map(v => {
    if (v.type === 'INVARIANT_CONTRADICTION') {
      const r = (v.rule || '').slice(0, 50);
      const d = (v.detail || '').slice(0, 50);
      return `- Invariant Conflict: Rule "${r}" (${d})`.slice(0, 120);
    }
    return `- Hypothesis Loop: ${(v.detail || '')}`.slice(0, 120);
  }).join('\n');

  // Concise <300 token re-anchoring directive
  const rawDirective = [
    '[DET-32 Re-anchoring Directive]',
    'Semantic drift detected:',
    conflictLines,
    'Mandatory Remediation:',
    '1. Re-anchor to task.md invariants. Never attempt forbidden actions or reverse required constraints.',
    '2. Formulate a new, alternative hypothesis grounded in actual test output rather than repeating prior failed attempts.',
    '3. Verify the next proposed step conforms to all locked invariants before executing.'
  ].join('\n');

  // Defensive hard cap: <= 1200 chars (< 300 tokens)
  const reanchoringDirective = rawDirective.length > 1150
    ? rawDirective.slice(0, 1140) + '\n...'
    : rawDirective;

  const reason = violations.map(v => v.detail).join('; ');
  const decision = flightMode === 'AUTO_PILOT' ? 'deny' : 'warn';

  return {
    detectorId: 'DET-32',
    slug: 'semantic-drift-guard',
    triggered: true,
    decision,
    violations,
    reanchoringDirective,
    reason
  };
}

export default {
  escapeRegex,
  buildTokenBoundaryRegex,
  parseDirectivePolarity,
  extractLockedInvariants,
  auditInvariantContradiction,
  auditHypothesisLoop,
  evaluateSemanticDrift
};
