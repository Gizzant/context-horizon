/**
 * @file src/core-isomorphic/guards/bucketBHeuristics.mjs
 * Unified Pure Isomorphic Barrel for all 12 Bucket B Heuristic Guardrails (`#2`, `#3b`, `#4`,
 * `#5`, `#6`, `#8`, `#9`, `#13`, `#16`, `#17`, `#19`, `#20`).
 *
 * Mod Law 4 Compliant: Zero `node:*` imports.
 */

export {
  POPULAR_ECOSYSTEM_PACKAGES,
  KNOWN_LLM_CONFLATIONS,
  damerauLevenshteinMax1,
  normalizePackageSpec,
  parsePackageInstallCommands,
  evaluateSlopsquatCommand
} from './slopsquatGate.mjs';

export {
  isBucketBForbiddenSkuPath,
  evaluateGrepGlobFirewall,
  distillHtmlWebPayload,
  evaluateBlastRadiusBreaker,
  fnv1a64Hex,
  normalizeLinesForShingling,
  computeFileShingles,
  detectDuplicateClones,
  evaluateHardcodedOracle,
  evaluateOverengineeringDiffGate
} from './bucketBAlphaBeta.mjs';

export {
  evaluateSubagentGovernor,
  evaluateVaguePromptAnchor,
  evaluateMcpCliRouter,
  evaluateLspSymbolRouter,
  compileProseRulesToHooks
} from './bucketBGamma.mjs';
