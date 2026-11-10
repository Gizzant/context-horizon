import { isTestFilePath } from '../detectors_det01_to_16.mjs';

/**
 * Phase 2.1: Contradiction Auditor & Immutable Evaluation Protection (`src/core/coach/contradiction_auditor.mjs`)
 *
 * Feature #19 (Top Unbuilt Gap #3):
 *  - Prevents self-improving agents (RSI) from injecting opposing/contradictory directives
 *    into `AGENTS.md`, `.agents/CONTEXT.md`, or `.agents/skills/<skill>/SKILL.md`.
 *  - Protects evaluation and unit test suites (`test/*`, `tests/*`, `*.test.*`) from
 *    uninvited agent mutation when the user's prompt did not authorize modifying tests.
 */

const STOP_WORDS = new Set([
  'always', 'never', 'must', 'should', 'dont', 'do', 'not', 'stop', 'avoid',
  'use', 'using', 'prefer', 'when', 'while', 'with', 'from', 'into', 'that',
  'this', 'only', 'ever', 'please', 'make', 'sure', 'ensure', 'keep', 'all',
  'any', 'the', 'and', 'for', 'are', 'is', 'in', 'on', 'to', 'of', 'by', 'as'
]);

const NEGATIVE_POLARITY_REGEX =
  /\b(never|must\s+not|do\s+not|don'?t|stop\s+(?:using|doing|calling|writing|adding)|avoid|forbid|forbidden|prohibited|disallow)\b/i;

const POSITIVE_POLARITY_REGEX =
  /\b(always|must(?!\s+not)|require|required|mandatory|enforce|prefer|use)\b/i;

const INSTEAD_OF_REGEX =
  /\b(?:always\s+)?(?:use|prefer)\s+([^.,;!\n]+?)\s+instead\s+of\s+([^.,;!\n]+)/i;

function extractSubjectTokens(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/\*+/g, ' ')
    .replace(/\[rsi:[^\]]+\]/gi, ' ')
    .replace(/\(trigger:[^)]+\)/gi, ' ')
    .replace(/[^a-z0-9/_-]+/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length >= 2 && !STOP_WORDS.has(tok));
}

/**
 * Normalizes a rule directive into polarity (`POSITIVE` | `NEGATIVE` | `NEUTRAL`),
 * subject tokens, and optional `insteadOfPair` (`{ preferred, forbidden }`).
 */
export function parseDirectivePolarity(rawDirective = '') {
  const cleaned = String(rawDirective || '')
    .replace(/^\s*[-*+]\s*/, '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/\*\*\[RSI:[^\]]+\]\*\*/gi, '')
    .replace(/\*\(trigger:[\s\S]*?\)\*/gi, '')
    .trim();

  const insteadMatch = cleaned.match(INSTEAD_OF_REGEX);
  if (insteadMatch) {
    const stripPrep = (s) =>
      String(s || '')
        .replace(/\s+(?:for|in|when|while|on|with|during|across|inside|to)\b.*$/i, '')
        .trim()
        .toLowerCase();
    const preferred = stripPrep(insteadMatch[1]);
    const forbidden = stripPrep(insteadMatch[2]);
    return {
      polarity: 'INSTEAD_OF',
      preferred,
      forbidden,
      subjectTokens: extractSubjectTokens(`${preferred} ${forbidden}`),
      cleanedText: cleaned
    };
  }

  const isNegative = NEGATIVE_POLARITY_REGEX.test(cleaned);
  const isPositive = !isNegative && POSITIVE_POLARITY_REGEX.test(cleaned);

  return {
    polarity: isNegative ? 'NEGATIVE' : isPositive ? 'POSITIVE' : 'NEUTRAL',
    preferred: null,
    forbidden: null,
    subjectTokens: extractSubjectTokens(cleaned),
    cleanedText: cleaned
  };
}

/**
 * Audits a candidate rule or instinct against existing rules text (or array of rules)
 * for direct polarity contradictions or `instead of` inversions.
 */
export function auditRuleContradictions(candidateRule = '', existingRulesInput = []) {
  const candidateText =
    typeof candidateRule === 'string'
      ? candidateRule
      : String(candidateRule?.directive_action || candidateRule?.ruleText || '');

  const parsedCandidate = parseDirectivePolarity(candidateText);
  const rawLines = Array.isArray(existingRulesInput)
    ? existingRulesInput
    : String(existingRulesInput || '').split(/\r?\n/);

  const conflicts = [];
  let isDuplicate = false;

  for (const rawEntry of rawLines) {
    const lineText =
      typeof rawEntry === 'string'
        ? rawEntry
        : String(rawEntry?.directive_action || rawEntry?.ruleText || '');
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('<!--')) {
      continue;
    }

    const parsedExisting = parseDirectivePolarity(trimmed);
    if (!parsedExisting.cleanedText || parsedExisting.subjectTokens.length === 0) {
      continue;
    }

    if (
      parsedExisting.cleanedText.toLowerCase().replace(/\s+/g, ' ') ===
      parsedCandidate.cleanedText.toLowerCase().replace(/\s+/g, ' ')
    ) {
      isDuplicate = true;
      continue;
    }

    // Case 1: Both are INSTEAD_OF directives with inverted preferred/forbidden targets
    if (
      parsedCandidate.polarity === 'INSTEAD_OF' &&
      parsedExisting.polarity === 'INSTEAD_OF'
    ) {
      if (
        parsedCandidate.preferred === parsedExisting.forbidden ||
        parsedCandidate.forbidden === parsedExisting.preferred
      ) {
        conflicts.push({
          existingRule: parsedExisting.cleanedText,
          candidateRule: parsedCandidate.cleanedText,
          reason: `Inverted preference ("${parsedCandidate.preferred} instead of ${parsedCandidate.forbidden}" contradicts "${parsedExisting.preferred} instead of ${parsedExisting.forbidden}")`,
          overlapTokens: [parsedCandidate.preferred, parsedCandidate.forbidden]
        });
        continue;
      }
    }

    // Case 2: INSTEAD_OF vs POSITIVE/NEGATIVE
    if (parsedCandidate.polarity === 'INSTEAD_OF' && parsedExisting.polarity === 'POSITIVE') {
      const existingJoined = parsedExisting.subjectTokens.join(' ');
      if (existingJoined.includes(parsedCandidate.forbidden) && !existingJoined.includes(parsedCandidate.preferred)) {
        conflicts.push({
          existingRule: parsedExisting.cleanedText,
          candidateRule: parsedCandidate.cleanedText,
          reason: `Candidate forbids "${parsedCandidate.forbidden}" which an existing rule requires`,
          overlapTokens: [parsedCandidate.forbidden]
        });
        continue;
      }
    }

    if (parsedExisting.polarity === 'INSTEAD_OF' && parsedCandidate.polarity === 'POSITIVE') {
      const candidateJoined = parsedCandidate.subjectTokens.join(' ');
      if (candidateJoined.includes(parsedExisting.forbidden) && !candidateJoined.includes(parsedExisting.preferred)) {
        conflicts.push({
          existingRule: parsedExisting.cleanedText,
          candidateRule: parsedCandidate.cleanedText,
          reason: `Candidate requires "${parsedExisting.forbidden}" which an existing rule forbids in favor of "${parsedExisting.preferred}"`,
          overlapTokens: [parsedExisting.forbidden]
        });
        continue;
      }
    }

    // Case 3: Direct Polarity Inversion (POSITIVE vs NEGATIVE) on high subject token overlap
    const oppositePolarity =
      (parsedCandidate.polarity === 'POSITIVE' && parsedExisting.polarity === 'NEGATIVE') ||
      (parsedCandidate.polarity === 'NEGATIVE' && parsedExisting.polarity === 'POSITIVE');

    if (oppositePolarity && parsedCandidate.subjectTokens.length > 0) {
      const existingSet = new Set(parsedExisting.subjectTokens);
      const overlapTokens = parsedCandidate.subjectTokens.filter((t) => existingSet.has(t));
      const minLen = Math.min(parsedCandidate.subjectTokens.length, parsedExisting.subjectTokens.length);
      const overlapRatio = minLen > 0 ? overlapTokens.length / minLen : 0;

      if (overlapTokens.length >= 1 && overlapRatio >= 0.6) {
        conflicts.push({
          existingRule: parsedExisting.cleanedText,
          candidateRule: parsedCandidate.cleanedText,
          reason: `Opposing directive polarity (${parsedCandidate.polarity} vs ${parsedExisting.polarity}) on subject [${overlapTokens.join(', ')}]`,
          overlapTokens
        });
      }
    }
  }

  return {
    hasContradiction: conflicts.length > 0,
    conflictCount: conflicts.length,
    conflicts,
    isDuplicate,
    candidatePolarity: parsedCandidate.polarity
  };
}

/**
 * Protects evaluation suites (`test/*`, `tests/*`, `*.test.*`) from unauthorized mutation
 * when the user prompt did not explicitly ask to write, update, or fix tests.
 */
export function auditTestSuiteImmutability({ modifiedFiles = [], userPrompt = '' } = {}) {
  const promptStr = String(userPrompt || '');
  const userAuthorized =
    /\b(test|tests|unit\s+test|spec|specs|assertion|assertions|verify_|test\s+suite|e2e)\b/i.test(promptStr);

  const unauthorizedTestFiles = [];
  for (const item of Array.isArray(modifiedFiles) ? modifiedFiles : []) {
    const filePath = typeof item === 'string' ? item : String(item?.path || item?.filePath || '');
    if (!filePath) continue;
    if (isTestFilePath(filePath) && !userAuthorized) {
      unauthorizedTestFiles.push(filePath);
    }
  }

  return {
    violated: unauthorizedTestFiles.length > 0,
    userAuthorized,
    unauthorizedTestFiles,
    message:
      unauthorizedTestFiles.length > 0
        ? `🛡️ Immutable Evaluation Guard: Agent modified test file(s) [${unauthorizedTestFiles.join(', ')}] without user test authorization.`
        : ''
  };
}

export class ContradictionAuditor {
  auditRule(candidateRule = '', existingRulesInput = []) {
    return auditRuleContradictions(candidateRule, existingRulesInput);
  }

  auditTestBoundary({ modifiedFiles = [], userPrompt = '' } = {}) {
    return auditTestSuiteImmutability({ modifiedFiles, userPrompt });
  }
}

export default ContradictionAuditor;
