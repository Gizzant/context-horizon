/**
 * @file src/config/horizonConfig.mjs
 * Unified Cross-Harness Configuration & Per-Detector Override Engine (`.attention-horizon.json`).
 *
 * Shared across `attention-horizon-claude` and `attention-horizon-antigravity` so developers
 * can individually configure any of the 20 circuit breakers (`DET-01`..`DET-20` or semantic slugs
 * -> `off` | `warn` | `block`), default `flightMode` (`COACH` | `AUTO_PILOT` | `SILENT` | `OFF`),
 * and threshold knobs at the project (`.attention-horizon.json`) or user
 * (`~/.attention-horizon/config.json`) level without editing source code.
 */

import {
  path,
  getCwd,
  getHomeDir,
  unlinkSafe,
  readJsonSafe,
  writeJsonAtomic
} from '../utils/runtime.mjs';
export {
  LEGACY_GA_V3_ID_MAP,
  migrateLegacyHorizonConfig
} from '../catalog/detectorCatalog.mjs';

export const CANONICAL_DETECTOR_IDS = Object.freeze([
  'DET-01',
  'DET-02',
  'DET-03',
  'DET-04',
  'DET-05',
  'DET-06',
  'DET-07',
  'DET-08',
  'DET-09',
  'DET-10',
  'DET-11',
  'DET-12',
  'DET-13',
  'DET-14',
  'DET-15',
  'DET-16',
  'DET-17',
  'DET-18',
  'DET-19',
  'DET-20',
  'DET-21',
  'DET-22',
  'DET-23',
  'DET-24',
  'DET-25',
  'DET-26',
  'DET-27',
  'DET-28',
  'DET-29',
  'DET-30',
  'DET-31',
  'DET-32'
]);

export const RING0_SECURITY_DETECTOR_IDS = Object.freeze([
  'DET-01',
  'DET-02',
  'DET-18',
  'DET-19'
]);

/**
 * Canonical primary semantic slug per Claude Code `DET-01..DET-32` (`ISS-052`).
 */
export const DETECTOR_SEMANTIC_SLUGS = Object.freeze({
  'DET-01': 'git-shell-safety',
  'DET-02': 'secret-boundary',
  'DET-03': 'protected-files',
  'DET-04': 'retry-churn',
  'DET-05': 'diff-thrashing',
  'DET-06': 'blind-search',
  'DET-07': 'output-bomb',
  'DET-08': 'cache-gravity-hold',
  'DET-09': 'prefix-mutation-fence',
  'DET-10': 'ttl-watchdog',
  'DET-11': 'context-rot',
  'DET-12': 'haiku-pre-cliff',
  'DET-13': 'mcp-schema-bloat',
  'DET-14': 'premature-stop',
  'DET-15': 'batched-formatter',
  'DET-16': 'subagent-recursion',
  'DET-17': 'auto-compact-deferral',
  'DET-18': 'untrusted-settings',
  'DET-19': 'subagent-ipi',
  'DET-20': 'scope-lock',
  'DET-21': 'thinking-drift-loop',
  'DET-22': 'file-shrinkage-rapid',
  'DET-23': 'empty-catch-block',
  'DET-24': 'high-turn-degradation',
  'DET-25': 'progressive-checkpoint',
  'DET-26': 'prompt-decomposer',
  'DET-27': 'rule-file-bloat',
  'DET-28': 'subagent-phantom',
  'DET-29': 'reflector-queue',
  'DET-30': 'thinking-drift-loop',
  'DET-31': 'worktree-merge-conflict',
  'DET-32': 'semantic-drift-guard'
});

/**
 * Primary slug + accepted cross-edition semantic aliases per Claude Code `DET-01..DET-32`.
 */
export const DETECTOR_SEMANTIC_ALIASES = Object.freeze({
  'DET-01': Object.freeze(['git-shell-safety', 'git-hook-bypass']),
  'DET-02': Object.freeze(['secret-boundary']),
  'DET-03': Object.freeze(['protected-files']),
  'DET-04': Object.freeze(['retry-churn']),
  'DET-05': Object.freeze([
    'diff-thrashing',
    'edit-oscillation',
    'assertion-weakening',
    'file-shrinkage',
    'empty-catch'
  ]),
  'DET-06': Object.freeze(['blind-search', 'redundant-reread']),
  'DET-07': Object.freeze(['output-bomb']),
  'DET-08': Object.freeze(['cache-gravity-hold']),
  'DET-09': Object.freeze(['prefix-mutation-fence']),
  'DET-10': Object.freeze(['ttl-watchdog']),
  'DET-11': Object.freeze(['context-rot', 'shadow-file-bloat']),
  'DET-12': Object.freeze(['haiku-pre-cliff']),
  'DET-13': Object.freeze(['mcp-schema-bloat']),
  'DET-14': Object.freeze(['premature-stop']),
  'DET-15': Object.freeze(['batched-formatter']),
  'DET-16': Object.freeze(['subagent-recursion']),
  'DET-17': Object.freeze(['auto-compact-deferral']),
  'DET-18': Object.freeze(['untrusted-settings']),
  'DET-19': Object.freeze(['subagent-ipi']),
  'DET-20': Object.freeze(['scope-lock']),
  'DET-21': Object.freeze(['thinking-drift-loop', 'scratchpad-loop', 'thinking-drift']),
  'DET-22': Object.freeze(['file-shrinkage-rapid', 'rapid-mutation-sensor']),
  'DET-23': Object.freeze(['empty-catch-block', 'swallowed-error', 'knowledge-bleed']),
  'DET-24': Object.freeze(['high-turn-degradation', 'prompt-bloat']),
  'DET-25': Object.freeze(['progressive-checkpoint', 'cascade-handshake', 'foreign-bleed']),
  'DET-26': Object.freeze(['prompt-decomposer', 'monolithic-prompt', 'legacy-poison']),
  'DET-27': Object.freeze(['rule-file-bloat', 'prefix-diet', 'unseen-callers']),
  'DET-28': Object.freeze(['subagent-phantom', 'orphan-subagent', 'dirty-snap']),
  'DET-29': Object.freeze(['reflector-queue', 'async-feedback', 'turn-zero-gate']),
  'DET-30': Object.freeze(['thinking-drift-loop', 'scratchpad-loop', 'thinking-drift']),
  'DET-31': Object.freeze(['worktree-merge-conflict', 'git-merge-tree-probe']),
  'DET-32': Object.freeze(['semantic-drift-guard', 'hypothesis-loop', 'ioedr-remory-guard'])
});

export const SEMANTIC_SLUG_TO_DETECTOR_ID = Object.freeze(
  Object.fromEntries(
    Object.entries(DETECTOR_SEMANTIC_ALIASES).flatMap(([detId, slugs]) =>
      slugs.map((slug) => [slug, detId])
    )
  )
);

/**
 * Cross-edition translation map from Antigravity numeric `DET-XX` IDs to shared semantic slugs (`ISS-052`).
 * Ensures `GA DET-01` (`retry-churn` -> `CC DET-04`) NEVER disables `CC DET-01` (`git-shell-safety`)
 * and `GA DET-02` (`edit-oscillation` -> `CC DET-05`) NEVER disables `CC DET-02` (`secret-boundary`).
 */
export const ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG = Object.freeze({
  'DET-01': 'retry-churn',
  'DET-02': 'edit-oscillation',
  'DET-03': 'assertion-weakening',
  'DET-06': 'redundant-reread',
  'DET-08': 'git-shell-safety',
  'DET-09': 'prefix-mutation-fence',
  'DET-10': 'output-bomb',
  'DET-15': 'secret-boundary',
  'DET-17': 'shadow-file-bloat',
  'DET-17B': 'shadow-file-bloat',
  'DET-18': 'untrusted-settings',
  'DET-19': 'git-shell-safety',
  'DET-20': 'scope-lock',
  'DET-30': 'thinking-drift-loop',
  'DET-31': 'worktree-merge-conflict',
  'DET-32': 'semantic-drift-guard'
});

/**
 * Advisory (non-gating) Claude Code detectors.
 * They never block tool calls; they surface Coach warnings only.
 */
export const ADVISORY_DETECTOR_IDS = Object.freeze([
  'DET-06',
  'DET-10',
  'DET-11',
  'DET-13',
  'DET-15',
  'DET-16',
  'DET-17',
  'DET-23',
  'DET-24',
  'DET-25',
  'DET-26',
  'DET-27',
  'DET-28',
  'DET-31'
]);
export const ADVISORY_DETECTOR_SLUGS = Object.freeze({
  'DET-30': 'thinking-drift-loop',
  'DET-31': 'worktree-merge-conflict'
});
const ADVISORY_SLUG_TO_ID = Object.freeze({
  'thinking-drift-loop': 'DET-30',
  'scratchpad-loop': 'DET-30',
  'thinking-drift': 'DET-30',
  'worktree-merge-conflict': 'DET-31',
  'semantic-drift-guard': 'DET-32'
});

export const VALID_DETECTOR_MODES = Object.freeze(['default', 'off', 'warn', 'block']);

export const HABIT_SEMANTIC_SLUGS = Object.freeze([
  'formatter-bypass',
  'drip-feed',
  'vague-prompt-rubric',
  'effort-overkill',
  'post-commit-handoff',
  'vision-screenshot-coach',
  'micro-skills',
  'relay-breaker'
]);

export const DEFAULT_HORIZON_CONFIG = Object.freeze({
  schemaVersion: '1.0.0',
  detectorNamespace: 'claude-code',
  flightMode: 'COACH',
  detectors: Object.fromEntries(CANONICAL_DETECTOR_IDS.slice(0, 20).map((id) => [id, 'default'])),
  semanticDetectors: Object.freeze(
    Object.fromEntries(HABIT_SEMANTIC_SLUGS.map((slug) => [slug, 'default']))
  ),
  thresholds: {
    safeLimitTokens: 147000,
    reminderAtPct: 75,
    subagentOffloadTokens: 12000,
    blindSearchLimit: 6,
    consecutiveFailureLimit: 3,
    enableLocalKeepAlive: false,
    microSkillConfirmSessions: 2
  }
});

/**
 * Parses a strict numeric `DET-XX` (or `DET-17b`) token without resolving semantic slugs.
 * @param {unknown} rawKey
 * @returns {string | null}
 */
function parseRawNumericDetToken(rawKey) {
  const m = String(rawKey || '')
    .trim()
    .toUpperCase()
    .match(/^DET[-_]?(\d{1,2})([A-Z])?$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (num < 1 || num > 99) return null;
  const suffix = m[2] || '';
  return `DET-${String(num).padStart(2, '0')}${suffix}`;
}

/**
 * Normalizes a semantic slug token (`git_shell_safety` -> `git-shell-safety`).
 * @param {unknown} rawSlug
 * @returns {string}
 */
function normalizeSlugToken(rawSlug) {
  return String(rawSlug || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

/**
 * Normalizes a detector ID or semantic slug (`det-1`, `DET01`, `git-shell-safety`, `retry-churn` -> `DET-01..DET-20`).
 * @param {string} rawId
 * @returns {string | null}
 */
export function normalizeDetectorId(rawId) {
  const rawToken = parseRawNumericDetToken(rawId);
  if (rawToken === 'DET-21') {
    return 'DET-30';
  }
  if (rawToken && (CANONICAL_DETECTOR_IDS.includes(rawToken) || ADVISORY_DETECTOR_IDS.includes(rawToken))) {
    return rawToken;
  }
  const slug = normalizeSlugToken(rawId);
  if (slug && Object.prototype.hasOwnProperty.call(SEMANTIC_SLUG_TO_DETECTOR_ID, slug)) {
    return SEMANTIC_SLUG_TO_DETECTOR_ID[slug];
  }
  if (slug && Object.prototype.hasOwnProperty.call(ADVISORY_SLUG_TO_ID, slug)) {
    return ADVISORY_SLUG_TO_ID[slug];
  }
  const targetHabitSlug =
    slug === 'prompt-decomposer' || slug === 'scope-brake'
      ? 'vague-prompt-rubric'
      : slug === 'spec-relay'
        ? 'relay-breaker'
        : slug;
  if (targetHabitSlug && HABIT_SEMANTIC_SLUGS.includes(targetHabitSlug)) {
    return targetHabitSlug;
  }
  return null;
}

/**
 * Resolves the canonical primary semantic slug for any `DET-01..DET-32` ID or alias.
 * @param {string} idOrSlug
 * @returns {string | null}
 */
export function resolveDetectorSlug(idOrSlug) {
  const normId = normalizeDetectorId(idOrSlug);
  if (normId && HABIT_SEMANTIC_SLUGS.includes(normId)) return normId;
  return normId ? DETECTOR_SEMANTIC_SLUGS[normId] || ADVISORY_DETECTOR_SLUGS[normId] || null : null;
}

/**
 * Normalizes a detector override mode (`off` | `warn` | `block` | `default`).
 * @param {unknown} rawMode
 * @returns {'default' | 'off' | 'warn' | 'block'}
 */
export function normalizeDetectorMode(rawMode) {
  if (rawMode === false || rawMode === 0) return 'off';
  if (rawMode === true) return 'default';
  const s = String(rawMode || 'default')
    .trim()
    .toLowerCase();
  if (s === 'off' || s === 'disable' || s === 'disabled' || s === 'mute') return 'off';
  if (s === 'warn' || s === 'advisory' || s === 'coach' || s === 'steer') return 'warn';
  if (s === 'block' || s === 'deny' || s === 'strict' || s === 'enforce') return 'block';
  return 'default';
}

/**
 * Normalizes a configured `flightMode` (`COACH` | `AUTO_PILOT` | `SILENT` | `OFF`),
 * returning `null` when unrecognized.
 *
 * @param {unknown} rawFlightMode
 * @returns {'COACH' | 'AUTO_PILOT' | 'SILENT' | 'OFF' | null}
 */
export function normalizeConfiguredFlightMode(rawFlightMode) {
  if (typeof rawFlightMode !== 'string' || !rawFlightMode.trim()) return null;
  const cleaned = rawFlightMode
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, '_');
  if (cleaned === 'COACH') return 'COACH';
  if (cleaned === 'AUTO_PILOT' || cleaned === 'AUTOPILOT' || cleaned === 'AUTO') {
    return 'AUTO_PILOT';
  }
  if (cleaned === 'SILENT' || cleaned === 'QUIET' || cleaned === 'MUTE') {
    return 'SILENT';
  }
  if (cleaned === 'OFF' || cleaned === 'DISABLED') {
    return 'OFF';
  }
  return null;
}

/**
 * Resolves the effective override mode (`default` | `off` | `warn` | `block`) for a detector ID
 * or semantic slug against a loaded or partial config object.
 *
 * @param {string} idOrSlug
 * @param {object | null} [config=null]
 * @returns {'default' | 'off' | 'warn' | 'block'}
 */
export function resolveDetectorOverride(idOrSlug, config = null) {
  if (!config || typeof config !== 'object') return 'default';
  const rawSlug = normalizeSlugToken(idOrSlug);
  const habitAliases =
    rawSlug === 'vague-prompt-rubric' || rawSlug === 'scope-brake'
      ? ['vague-prompt-rubric', 'prompt-decomposer', 'scope-brake']
      : rawSlug === 'prompt-decomposer'
        ? ['prompt-decomposer', 'vague-prompt-rubric', 'scope-brake']
        : rawSlug === 'relay-breaker' || rawSlug === 'spec-relay'
          ? ['relay-breaker', 'spec-relay']
          : HABIT_SEMANTIC_SLUGS.includes(rawSlug)
            ? [rawSlug]
            : [];

  for (const hSlug of habitAliases) {
    if (config.semanticDetectors && Object.prototype.hasOwnProperty.call(config.semanticDetectors, hSlug)) {
      const m = normalizeDetectorMode(config.semanticDetectors[hSlug]);
      if (m !== 'default') return m;
    }
    if (config.detectors && Object.prototype.hasOwnProperty.call(config.detectors, hSlug)) {
      const m = normalizeDetectorMode(config.detectors[hSlug]);
      if (m !== 'default') return m;
    }
    if (config.claudeDetectors && Object.prototype.hasOwnProperty.call(config.claudeDetectors, hSlug)) {
      const m = normalizeDetectorMode(config.claudeDetectors[hSlug]);
      if (m !== 'default') return m;
    }
  }

  const normId = normalizeDetectorId(idOrSlug);
  if (!normId) return 'default';

  const lookupIds = normId === 'DET-30' ? ['DET-30', 'DET-21'] : [normId];

  if (config.claudeDetectors && typeof config.claudeDetectors === 'object') {
    for (const lid of lookupIds) {
      if (Object.prototype.hasOwnProperty.call(config.claudeDetectors, lid)) {
        return normalizeDetectorMode(config.claudeDetectors[lid]);
      }
    }
    for (const [k, v] of Object.entries(config.claudeDetectors)) {
      if (normalizeDetectorId(k) === normId) {
        return normalizeDetectorMode(v);
      }
    }
  }

  const detMap = config.detectors;
  if (detMap && typeof detMap === 'object') {
    for (const lid of lookupIds) {
      if (Object.prototype.hasOwnProperty.call(detMap, lid)) {
        const directMode = normalizeDetectorMode(detMap[lid]);
        if (directMode !== 'default') return directMode;
      }
    }
    const aliases = DETECTOR_SEMANTIC_ALIASES[normId] || [];
    for (const slug of aliases) {
      if (Object.prototype.hasOwnProperty.call(detMap, slug)) {
        const slugMode = normalizeDetectorMode(detMap[slug]);
        if (slugMode !== 'default') return slugMode;
      }
    }
    for (const [k, v] of Object.entries(detMap)) {
      if (normalizeDetectorId(k) === normId) {
        return normalizeDetectorMode(v);
      }
    }
  }

  if (config.semanticDetectors && typeof config.semanticDetectors === 'object') {
    const primarySlug = DETECTOR_SEMANTIC_SLUGS[normId];
    if (primarySlug && Object.prototype.hasOwnProperty.call(config.semanticDetectors, primarySlug)) {
      return normalizeDetectorMode(config.semanticDetectors[primarySlug]);
    }
  }

  return 'default';
}

/**
 * Resolves user-global and project-local `.attention-horizon.json` paths.
 * @param {object} [options={}]
 * @returns {{ projectConfigPath: string, globalConfigPath: string, activeWritePath: string }}
 */
export function resolveHorizonConfigPaths(options = {}) {
  const cwd = getCwd(options);
  const homeDir = getHomeDir(options) || cwd;
  const scope = options.scope === 'global' ? 'global' : 'project';

  const projectConfigPath = options.configPath || path.join(cwd, '.attention-horizon.json');
  const globalConfigPath =
    options.globalConfigPath || path.join(homeDir, '.attention-horizon', 'config.json');
  const activeWritePath = scope === 'global' ? globalConfigPath : projectConfigPath;

  return {
    projectConfigPath,
    globalConfigPath,
    activeWritePath
  };
}

const MODE_STRICTNESS_RANK = Object.freeze({
  default: 0,
  off: 1,
  warn: 2,
  block: 3
});

/**
 * Translates an Antigravity detector override map into Claude Code canonical `DET-XX` overrides
 * via `ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG` + semantic slugs.
 *
 * @param {Record<string, unknown>} rawMap
 * @param {Record<string, 'default' | 'off' | 'warn' | 'block'>} targetDetectors
 */
function mergeForeignEditionDetectorMap(rawMap, targetDetectors) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return;

  const staged = new Map();
  for (const [rawKey, rawVal] of Object.entries(rawMap)) {
    const mode = normalizeDetectorMode(rawVal);
    const numericToken = parseRawNumericDetToken(rawKey);

    let resolvedCcId = null;
    if (numericToken) {
      const mappedSlug = ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG[numericToken];
      if (!mappedSlug) {
        // Foreign-only numeric detector with no Claude Code counterpart: ignore safely
        continue;
      }
      resolvedCcId = SEMANTIC_SLUG_TO_DETECTOR_ID[mappedSlug] || null;
    } else {
      resolvedCcId = normalizeDetectorId(rawKey);
    }

    if (!resolvedCcId) continue;

    if (!staged.has(resolvedCcId)) {
      staged.set(resolvedCcId, mode);
    } else {
      const prev = staged.get(resolvedCcId);
      if (mode !== 'default' && (prev === 'default' || MODE_STRICTNESS_RANK[mode] > MODE_STRICTNESS_RANK[prev])) {
        staged.set(resolvedCcId, mode);
      }
    }
  }

  for (const [detId, mode] of staged.entries()) {
    targetDetectors[detId] = mode;
  }
}

/**
 * Loads and merges `~/.attention-horizon/config.json` and `<cwd>/.attention-horizon.json`.
 * Project-level settings take precedence over user-global settings.
 *
 * Implements Cross-Edition Semantic Translation & Ring-0 Inversion Protection (`ISS-052`).
 *
 * @param {object} [options={}]
 * @returns {{
 *   schemaVersion: string,
 *   detectorNamespace: string,
 *   flightMode: string,
 *   detectors: Record<string, 'default' | 'off' | 'warn' | 'block'>,
 *   semanticDetectors: Record<string, 'default' | 'off' | 'warn' | 'block'>,
 *   thresholds: Record<string, number | boolean>,
 *   warnings: string[],
 *   sources: { globalLoaded: boolean, projectLoaded: boolean, projectConfigPath: string, globalConfigPath: string }
 * }}
 */
export function loadHorizonConfig(options = {}) {
  const { projectConfigPath, globalConfigPath } = resolveHorizonConfigPaths(options);

  const globalRaw = readJsonSafe(globalConfigPath, null, options);
  const projectRaw = readJsonSafe(projectConfigPath, null, options);

  const detectors = { ...DEFAULT_HORIZON_CONFIG.detectors };
  const habitSemantics = Object.fromEntries(HABIT_SEMANTIC_SLUGS.map((s) => [s, 'default']));
  const thresholds = { ...DEFAULT_HORIZON_CONFIG.thresholds };
  const warnings = [];
  let flightMode = DEFAULT_HORIZON_CONFIG.flightMode;
  let resolvedNamespace = DEFAULT_HORIZON_CONFIG.detectorNamespace;

  const mergeHabitSlugsFromMap = (mapObj) => {
    if (!mapObj || typeof mapObj !== 'object' || Array.isArray(mapObj)) return;
    for (const [rk, rv] of Object.entries(mapObj)) {
      const slug = normalizeSlugToken(rk);
      const targetSlug =
        slug === 'prompt-decomposer' || slug === 'scope-brake'
          ? 'vague-prompt-rubric'
          : slug === 'spec-relay'
            ? 'relay-breaker'
            : slug;
      if (HABIT_SEMANTIC_SLUGS.includes(targetSlug)) {
        habitSemantics[targetSlug] = normalizeDetectorMode(rv);
      }
    }
  };

  const mergeLayer = (layer, { isDiskLayer = false, sourceLabel = 'config' } = {}) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return;

    mergeHabitSlugsFromMap(layer.semanticDetectors);
    mergeHabitSlugsFromMap(layer.detectors);
    mergeHabitSlugsFromMap(layer.claudeDetectors);

    const parsedMode = normalizeConfiguredFlightMode(layer.flightMode);
    if (parsedMode) {
      flightMode = parsedMode;
    }

    const rawNs =
      typeof layer.detectorNamespace === 'string'
        ? layer.detectorNamespace.trim().toLowerCase()
        : '';
    if (rawNs) {
      resolvedNamespace = rawNs;
    }

    const hasClaudeDetectors =
      Boolean(layer.claudeDetectors) &&
      typeof layer.claudeDetectors === 'object' &&
      !Array.isArray(layer.claudeDetectors);

    // 1. Optional cross-edition `antigravityDetectors` map (translated via semantic slugs)
    if (layer.antigravityDetectors && typeof layer.antigravityDetectors === 'object') {
      mergeForeignEditionDetectorMap(layer.antigravityDetectors, detectors);
    }

    // 2. Primary `detectors` map
    if (layer.detectors && typeof layer.detectors === 'object' && !Array.isArray(layer.detectors)) {
      if (rawNs === 'antigravity') {
        mergeForeignEditionDetectorMap(layer.detectors, detectors);
      } else {
        // Track which Ring-0 detectors have explicit semantic slug `'off'` confirmation in this layer
        const slugConfirmedOff = new Set();
        for (const [k, v] of Object.entries(layer.detectors)) {
          if (!parseRawNumericDetToken(k) && normalizeDetectorMode(v) === 'off') {
            const mappedId = normalizeDetectorId(k);
            if (mappedId) slugConfirmedOff.add(mappedId);
          }
        }

        const isAmbiguousLegacyDiskLayer =
          isDiskLayer && !rawNs && !hasClaudeDetectors;

        // First apply numeric keys, then semantic slugs so explicit slugs always win
        const entries = Object.entries(layer.detectors);
        const numericEntries = entries.filter(([k]) => Boolean(parseRawNumericDetToken(k)));
        const slugEntries = entries.filter(([k]) => !parseRawNumericDetToken(k));

        for (const [k, v] of [...numericEntries, ...slugEntries]) {
          const normId = normalizeDetectorId(k);
          if (!normId || HABIT_SEMANTIC_SLUGS.includes(normId)) continue;
          let normMode = normalizeDetectorMode(v);

          if (
            isAmbiguousLegacyDiskLayer &&
            Boolean(parseRawNumericDetToken(k)) &&
            normMode === 'off' &&
            RING0_SECURITY_DETECTOR_IDS.includes(normId) &&
            !slugConfirmedOff.has(normId)
          ) {
            const reqSlug = DETECTOR_SEMANTIC_SLUGS[normId];
            normMode = 'warn';
            warnings.push(
              `[ISS-052 Ring-0 Inversion Guard] Clamped ambiguous un-namespaced "${normId}": "off" in ${sourceLabel} to "warn" to protect "${reqSlug}". Set "${reqSlug}": "off" or "detectorNamespace": "claude-code" to disable intentionally.`
            );
          }

          detectors[normId] = normMode;
        }
      }
    }

    // 3. Explicit `claudeDetectors` map always takes precedence for Claude Code
    if (hasClaudeDetectors) {
      for (const [k, v] of Object.entries(layer.claudeDetectors)) {
        const normId = normalizeDetectorId(k);
        if (normId && !HABIT_SEMANTIC_SLUGS.includes(normId)) {
          detectors[normId] = normalizeDetectorMode(v);
        }
      }
    }

    if (layer.thresholds && typeof layer.thresholds === 'object') {
      for (const [tk, tv] of Object.entries(layer.thresholds)) {
        if (tk in thresholds && (typeof tv === 'number' || typeof tv === 'boolean')) {
          thresholds[tk] = tv;
        }
      }
    }
  };

  mergeLayer(globalRaw, { isDiskLayer: true, sourceLabel: globalConfigPath });
  mergeLayer(projectRaw, { isDiskLayer: true, sourceLabel: projectConfigPath });
  if (options.overrides && typeof options.overrides === 'object') {
    mergeLayer(options.overrides, { isDiskLayer: false, sourceLabel: 'overrides' });
  }

  const semanticDetectors = {
    ...Object.fromEntries(
      CANONICAL_DETECTOR_IDS.map((id) => [DETECTOR_SEMANTIC_SLUGS[id], detectors[id]])
    ),
    ...habitSemantics
  };

  return {
    schemaVersion: '1.0.0',
    detectorNamespace: resolvedNamespace,
    flightMode,
    detectors,
    semanticDetectors,
    thresholds,
    warnings,
    sources: {
      globalLoaded: Boolean(globalRaw),
      projectLoaded: Boolean(projectRaw),
      projectConfigPath,
      globalConfigPath
    }
  };
}

/**
 * Sets a specific detector override (`off` | `warn` | `block` | `default`) in `.attention-horizon.json`.
 * Writes `detectorNamespace: 'claude-code'`, `detectors[canonicalDetId]`, `detectors[semanticSlug]`,
 * and `claudeDetectors[canonicalDetId]` for unambiguous cross-edition safety (`ISS-052`).
 *
 * @param {string} idOrSlug
 * @param {string} mode
 * @param {object} [options={}]
 * @returns {{ ok: boolean, detectorId: string | null, semanticSlug: string | null, mode: string, configPath: string, config: object }}
 */
export function setDetectorOverride(idOrSlug, mode, options = {}) {
  const rawSlug = normalizeSlugToken(idOrSlug);
  const targetHabitSlug =
    rawSlug === 'prompt-decomposer' || rawSlug === 'scope-brake'
      ? 'vague-prompt-rubric'
      : rawSlug === 'spec-relay'
        ? 'relay-breaker'
        : rawSlug;
  const normMode = normalizeDetectorMode(mode);
  const { activeWritePath } = resolveHorizonConfigPaths(options);

  if (HABIT_SEMANTIC_SLUGS.includes(targetHabitSlug)) {
    const existing = readJsonSafe(activeWritePath, {}, options) || {};
    const nextDetectors = { ...(existing.detectors || {}) };
    const nextSemantic = { ...(existing.semanticDetectors || {}) };
    if (normMode === 'default') {
      delete nextDetectors[targetHabitSlug];
      delete nextSemantic[targetHabitSlug];
    } else {
      nextDetectors[targetHabitSlug] = normMode;
      nextSemantic[targetHabitSlug] = normMode;
    }
    const nextPayload = {
      schemaVersion: '1.0.0',
      detectorNamespace: 'claude-code',
      ...existing,
      detectorNamespace: 'claude-code',
      detectors: nextDetectors,
      semanticDetectors: nextSemantic
    };
    const ok = writeJsonAtomic(activeWritePath, nextPayload, options);
    return {
      ok,
      detectorId: targetHabitSlug,
      semanticSlug: targetHabitSlug,
      mode: normMode,
      configPath: activeWritePath,
      config: loadHorizonConfig(options)
    };
  }

  const normId = normalizeDetectorId(idOrSlug);
  const semanticSlug = normId ? DETECTOR_SEMANTIC_SLUGS[normId] : null;

  if (!normId || !semanticSlug) {
    return {
      ok: false,
      detectorId: null,
      semanticSlug: null,
      mode: normMode,
      configPath: activeWritePath,
      config: loadHorizonConfig(options)
    };
  }

  const existing = readJsonSafe(activeWritePath, {}, options) || {};
  const nextDetectors = { ...(existing.detectors || {}) };
  const nextClaudeDetectors = { ...(existing.claudeDetectors || {}) };
  const allAliases = DETECTOR_SEMANTIC_ALIASES[normId] || [semanticSlug];

  if (normMode === 'default') {
    delete nextDetectors[normId];
    for (const alias of allAliases) {
      delete nextDetectors[alias];
    }
    delete nextClaudeDetectors[normId];
    for (const alias of allAliases) {
      delete nextClaudeDetectors[alias];
    }
  } else {
    // If existing file was previously foreign-namespaced, migrate its detectors cleanly before writing claude-code namespace
    if (
      typeof existing.detectorNamespace === 'string' &&
      existing.detectorNamespace.trim().toLowerCase() === 'antigravity'
    ) {
      const migrated = {};
      mergeForeignEditionDetectorMap(nextDetectors, migrated);
      for (const k of Object.keys(nextDetectors)) {
        delete nextDetectors[k];
      }
      for (const [mId, mMode] of Object.entries(migrated)) {
        if (mMode !== 'default') {
          nextDetectors[mId] = mMode;
          nextDetectors[DETECTOR_SEMANTIC_SLUGS[mId]] = mMode;
          nextClaudeDetectors[mId] = mMode;
        }
      }
    }
    nextDetectors[normId] = normMode;
    nextDetectors[semanticSlug] = normMode;
    nextClaudeDetectors[normId] = normMode;
  }

  const nextPayload = {
    schemaVersion: '1.0.0',
    ...existing,
    detectorNamespace: 'claude-code',
    detectors: nextDetectors,
    claudeDetectors: nextClaudeDetectors
  };

  const ok = writeJsonAtomic(activeWritePath, nextPayload, options);
  return {
    ok,
    detectorId: normId,
    semanticSlug,
    mode: normMode,
    configPath: activeWritePath,
    config: loadHorizonConfig(options)
  };
}

/**
 * Resets `.attention-horizon.json` detector overrides to defaults.
 * @param {object} [options={}]
 * @returns {{ ok: boolean, configPath: string }}
 */
export function resetHorizonConfig(options = {}) {
  const { activeWritePath } = resolveHorizonConfigPaths(options);
  const ok = unlinkSafe(activeWritePath, options);
  return { ok, configPath: activeWritePath };
}

/**
 * Maps a detector trigger or runtime telemetry state to concrete native slash-command
 * recovery prescriptions (`/rewind`, `/fork`, `/compact`, `/mcp`, `/context`, `/effort`, `/handoff` -> `/clear`).
 *
 * @param {object} [trigger={}]
 * @returns {{
 *   category: string,
 *   primaryCommand: string,
 *   secondaryCommand: string | null,
 *   sequence?: string,
 *   plainTextInstruction?: string,
 *   clickableCopyAllowed: boolean,
 *   preservedFiles: string[],
 *   summary: string
 * } | null}
 */
export function mapTriggerToNativeCommand(trigger = {}) {
  const normId = normalizeDetectorId(trigger.detectorId);
  const consecutiveFailures = Number(
    trigger.consecutiveFailures ?? trigger.failureCount ?? (normId === 'DET-04' ? 3 : 0)
  );
  const contextUsedPct = Number(trigger.contextUsedPct ?? trigger.context_used_pct ?? 0);
  const modifiedFiles = Array.isArray(trigger.modifiedFiles)
    ? trigger.modifiedFiles.filter(Boolean)
    : [];
  const unresolvedTasks = Array.isArray(trigger.unresolvedTasks)
    ? trigger.unresolvedTasks.filter(Boolean)
    : [];

  // 1. Poisoned Context Recovery (/rewind and /fork)
  if (consecutiveFailures >= 3 || normId === 'DET-04' || normId === 'DET-05') {
    return {
      category: 'POISONED_CONTEXT_RECOVERY',
      primaryCommand: '/rewind',
      secondaryCommand: '/fork',
      clickableCopyAllowed: true,
      preservedFiles: modifiedFiles,
      summary:
        'Run `/rewind` to step back before the consecutive failure chain, or `/fork` to test a risky fix in isolation.'
    };
  }

  // 2. Standing Overhead Trim (/mcp, /context, /effort)
  if (
    normId === 'DET-13' ||
    normId === 'DET-12' ||
    Boolean(trigger.instructionsOverBudget) ||
    Boolean(trigger.idleMcpBloat)
  ) {
    const isEffort = normId === 'DET-12' || Boolean(trigger.effortStepDown);
    return {
      category: 'STANDING_OVERHEAD_TRIM',
      primaryCommand: isEffort ? '/effort' : '/mcp',
      secondaryCommand: isEffort ? '/mcp' : '/context',
      clickableCopyAllowed: true,
      preservedFiles: modifiedFiles,
      summary: isEffort
        ? 'Run `/effort` to step down reasoning cost or switch models before the 100k token cliff.'
        : 'Run `/mcp` and `/context` to prune idle MCP tool manifests, or `/effort` to step down reasoning cost on routine edits.'
    };
  }

  // 3. Clean Session Baton (/handoff -> /clear)
  if (Boolean(trigger.milestoneComplete) || Boolean(trigger.cacheEfficiencyDropped)) {
    return {
      category: 'CLEAN_SESSION_BATON',
      primaryCommand: '/handoff',
      secondaryCommand: '/clear',
      sequence: '/handoff -> /clear',
      clickableCopyAllowed: true,
      preservedFiles: modifiedFiles,
      summary:
        'Run `/handoff` (or `/attention-horizon:handoff`) to write HANDOFF.md, followed immediately by `/clear`.'
    };
  }

  // 4. Scoped Context Compaction (/compact)
  const warnThreshold = Number(trigger.horizonWarningThresholdPct || 70);
  if (contextUsedPct >= warnThreshold || normId === 'DET-11') {
    const fileScope =
      modifiedFiles.length > 0 ? modifiedFiles.join(', ') : 'active modified files';
    const taskScope =
      unresolvedTasks.length > 0 ? `; unresolved tasks: ${unresolvedTasks.join('; ')}` : '';
    const scopedCompactCmd = `/compact Preserve modified files (${fileScope})${taskScope} and active architectural invariants.`;
    return {
      category: 'SCOPED_CONTEXT_COMPACTION',
      primaryCommand: scopedCompactCmd,
      secondaryCommand: '/handoff',
      plainTextInstruction: 'Type /compact in the chat box and press Enter',
      clickableCopyAllowed: true,
      preservedFiles: modifiedFiles,
      summary: `Preserve ${fileScope}${taskScope} during context compaction.`
    };
  }

  return null;
}

/**
 * Applies `.attention-horizon.json` per-detector override (`off` | `warn` | `block`)
 * to a circuit breaker verdict and attaches any native slash-command prescription.
 *
 * @param {object} verdict
 * @param {object} [config]
 * @returns {object}
 */
export function applyDetectorOverride(verdict, config = null) {
  if (!verdict || !verdict.triggered || !verdict.detectorId) {
    return verdict;
  }
  const normId = normalizeDetectorId(verdict.detectorId);
  const semanticSlug = normId ? DETECTOR_SEMANTIC_SLUGS[normId] : null;
  const mode = normId ? resolveDetectorOverride(normId, config) : 'default';

  if (mode === 'off') {
    return {
      detectorId: null,
      semanticSlug: null,
      triggered: false,
      decision: 'allow',
      blocked: false,
      overriddenByConfig: 'off',
      suppressedDetectorId: normId,
      suppressedSemanticSlug: semanticSlug,
      reason: null
    };
  }

  const prescription =
    verdict.prescription || mapTriggerToNativeCommand({ detectorId: normId }) || null;
  const baseVerdict = {
    ...verdict,
    ...(semanticSlug ? { semanticSlug } : {}),
    ...(prescription ? { prescription } : {})
  };

  if (!mode || mode === 'default') {
    return baseVerdict;
  }

  if (mode === 'warn') {
    return {
      ...baseVerdict,
      decision: 'allow',
      blocked: false,
      advisory: true,
      overriddenByConfig: 'warn',
      reason: `[Advisory Override (${normId}=warn)] ${verdict.reason || ''}`.trim()
    };
  }

  if (mode === 'block') {
    return {
      ...baseVerdict,
      decision: 'deny',
      blocked: true,
      advisory: false,
      overriddenByConfig: 'block'
    };
  }

  return baseVerdict;
}

export default {
  CANONICAL_DETECTOR_IDS,
  RING0_SECURITY_DETECTOR_IDS,
  DETECTOR_SEMANTIC_SLUGS,
  DETECTOR_SEMANTIC_ALIASES,
  SEMANTIC_SLUG_TO_DETECTOR_ID,
  ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG,
  VALID_DETECTOR_MODES,
  DEFAULT_HORIZON_CONFIG,
  normalizeDetectorId,
  resolveDetectorSlug,
  normalizeDetectorMode,
  normalizeConfiguredFlightMode,
  resolveDetectorOverride,
  resolveHorizonConfigPaths,
  loadHorizonConfig,
  setDetectorOverride,
  resetHorizonConfig,
  mapTriggerToNativeCommand,
  applyDetectorOverride
};
