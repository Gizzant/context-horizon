/**
 * Phase 3.2: Advisory TDD Planning Gate & Mega-Prompt Decomposer (`DET-12`)
 * (`src/core/coach/prompt_decomposer_coach.mjs`)
 *
 * Feature #13:
 *  - Detects multi-objective "mega-prompts" (>= 3 distinct mutation verbs, >= 4 target
 *    files/modules, or >= 120 words with multiple objectives) when no `implementation_plan.md`
 *    or `/plan` workflow is active.
 *  - Operates strictly in non-blocking Advisory Mode (`COACH`): never hard-blocks experienced
 *    developers, but recommends `/plan` or `/grill-me` with a structured 3-step decomposition.
 */

export const DECOMPOSER_CONSTANTS = Object.freeze({
  MIN_MUTATION_VERBS: 3,
  MIN_TARGET_FILES: 4,
  MEGA_PROMPT_WORD_THRESHOLD: 120,
  MIN_BULLET_OBJECTIVES: 3
});

const MUTATION_VERB_REGEX =
  /\b(implement|refactor|migrate|redesign|create|build|rewrite|replace|integrate|convert|upgrade|overhaul|extract|deprecate|architect)\b/gi;

const FILE_OR_PATH_REGEX =
  /\b(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.[a-z0-9]{1,6}\b|\b[a-zA-Z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|html|css|sql|json|md)\b/g;

export function analyzePromptSprawl(promptText = '', options = {}) {
  const raw = String(promptText || '').trim();
  if (!raw) {
    return {
      isMegaPrompt: false,
      detectorId: 'DET-26',
      blocking: false,
      wordCount: 0,
      distinctVerbCount: 0,
      distinctVerbs: [],
      targetFileCount: 0,
      targetFiles: [],
      bulletObjectiveCount: 0,
      hasPlanCommand: false,
      recommendedSlashCommand: null,
      decomposedStages: [],
      advisoryPrompt: ''
    };
  }

  const hasPlanCommand =
    Boolean(options.hasApprovedPlan) ||
    /(?:^|\s)(\/plan|\/grill-me|implementation_plan\.md)\b/i.test(raw);

  const words = raw.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const verbMatches = raw.match(MUTATION_VERB_REGEX) || [];
  const distinctVerbs = Array.from(new Set(verbMatches.map((v) => v.toLowerCase())));

  const fileMatches = raw.match(FILE_OR_PATH_REGEX) || [];
  const explicitFiles = Array.isArray(options.referencedFiles) ? options.referencedFiles : [];
  const targetFiles = Array.from(
    new Set([...fileMatches, ...explicitFiles].map((f) => String(f).trim()).filter(Boolean))
  );

  const lines = raw.split(/\r?\n/);
  const bulletLines = lines
    .map((l) => l.trim())
    .filter((l) => /^([-*+]|\d+[.)])\s+\S+/.test(l));
  const bulletObjectiveCount = bulletLines.length;

  const ClauseConjunctions = (raw.match(/\b(and\s+also|then\s+also|additionally|furthermore|finally)\b/gi) || []).length;

  const triggersVerbSprawl =
    distinctVerbs.length >= DECOMPOSER_CONSTANTS.MIN_MUTATION_VERBS &&
    (targetFiles.length >= 2 || bulletObjectiveCount >= 2 || wordCount >= 45 || ClauseConjunctions >= 1);

  const triggersFileSprawl = targetFiles.length >= DECOMPOSER_CONSTANTS.MIN_TARGET_FILES;

  const triggersLengthSprawl =
    wordCount >= DECOMPOSER_CONSTANTS.MEGA_PROMPT_WORD_THRESHOLD &&
    bulletObjectiveCount >= DECOMPOSER_CONSTANTS.MIN_BULLET_OBJECTIVES;

  const isMegaPrompt =
    !hasPlanCommand && (triggersVerbSprawl || triggersFileSprawl || triggersLengthSprawl);

  if (!isMegaPrompt) {
    return {
      isMegaPrompt: false,
      detectorId: 'DET-26',
      blocking: false,
      wordCount,
      distinctVerbCount: distinctVerbs.length,
      distinctVerbs,
      targetFileCount: targetFiles.length,
      targetFiles,
      bulletObjectiveCount,
      hasPlanCommand,
      recommendedSlashCommand: null,
      decomposedStages: [],
      advisoryPrompt: ''
    };
  }

  const primaryTargets =
    targetFiles.length > 0 ? targetFiles.slice(0, 4).join(', ') : 'target modules';

  const decomposedStages = [
    `Phase 1 (Contract & Plan): Align on interfaces and edge cases for ${primaryTargets} in implementation_plan.md before mutating files.`,
    `Phase 2 (Scoped Implementation): Execute changes incrementally (${distinctVerbs.slice(0, 3).join(' -> ') || 'step-by-step'}) with pause gates.`,
    `Phase 3 (TDD Verification): Run targeted unit tests for ${primaryTargets} before expanding scope.`
  ];

  const advisoryPrompt = `/plan Break this request into a phased implementation plan with verification gates for ${primaryTargets}:\n\n${raw}`;

  return {
    isMegaPrompt: true,
    detectorId: 'DET-26',
    blocking: false, // Strictly advisory in COACH mode
    mode: 'ADVISORY_COACH',
    wordCount,
    distinctVerbCount: distinctVerbs.length,
    distinctVerbs,
    targetFileCount: targetFiles.length,
    targetFiles,
    bulletObjectiveCount,
    hasPlanCommand,
    recommendedSlashCommand: '/plan',
    alternativeSlashCommand: '/grill-me',
    decomposedStages,
    advisoryPrompt,
    message: `💡 DET-26 Mega-Prompt Advisory: Detected ${distinctVerbs.length} action verbs across ${targetFiles.length || bulletObjectiveCount || 'multiple'} targets. Consider running /plan or /grill-me first to prevent unaligned multi-file edits.`
  };
}

export class PromptDecomposerCoach {
  evaluate(promptText = '', options = {}) {
    return analyzePromptSprawl(promptText, options);
  }
}

export default PromptDecomposerCoach;
