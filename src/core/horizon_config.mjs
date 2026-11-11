import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFileSync } from './atomic_io.mjs';

/**
 * Unified Cross-Harness Configuration, Per-Detector Override Engine (`.attention-horizon.json`),
 * Zero-PII Bug Report Generator (`doctor --diagnostic`), and Git Efficiency Receipt Exporter
 * for Attention Horizon (`attention-horizon-antigravity`).
 */

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
  'DET-20'
]);

export const EXTENDED_DETECTOR_IDS = Object.freeze([
  ...CANONICAL_DETECTOR_IDS,
  'DET-21',
  'DET-22',
  'DET-23',
  'DET-24',
  'DET-25',
  'DET-26',
  'DET-27',
  'DET-28',
  'DET-29'
]);

export const RING0_SECURITY_DETECTORS = Object.freeze([
  'DET-08',
  'DET-15',
  'DET-18',
  'DET-19'
]);

export const ANTIGRAVITY_DETECTOR_SLUGS = Object.freeze({
  'DET-01': 'retry-churn',
  'DET-02': 'edit-oscillation',
  'DET-03': 'assertion-weakening',
  'DET-04': 'fake-screenshot',
  'DET-05': 'premature-stop',
  'DET-06': 'redundant-reread',
  'DET-07': 'phantom-file',
  'DET-08': 'git-shell-safety',
  'DET-09': 'prefix-mutation-fence',
  'DET-10': 'output-bomb',
  'DET-11': 'zombie-process',
  'DET-12': 'premature-exec',
  'DET-13': 'subagent-collision',
  'DET-14': 'placeholder-slop',
  'DET-15': 'secret-boundary',
  'DET-16': 'ttl-watchdog',
  'DET-17': 'shadow-file-bloat',
  'DET-18': 'untrusted-settings',
  'DET-19': 'git-hook-bypass',
  'DET-20': 'scope-lock',
  'DET-21': 'blind-edit',
  'DET-22': 'file-shrinkage',
  'DET-23': 'empty-catch',
  'DET-24': 'high-turn-degradation',
  'DET-25': 'progressive-checkpoint',
  'DET-26': 'prompt-decomposer',
  'DET-27': 'rule-file-bloat',
  'DET-28': 'subagent-phantom',
  'DET-29': 'reflector-queue'
});

export const SLUG_TO_ANTIGRAVITY_DETECTOR = Object.freeze({
  'retry-churn': 'DET-01',
  'edit-oscillation': 'DET-02',
  'assertion-weakening': 'DET-03',
  'fake-screenshot': 'DET-04',
  'panic-spiral': 'DET-05',
  'premature-stop': 'DET-05',
  'redundant-reread': 'DET-06',
  'blind-search': 'DET-06',
  'phantom-file': 'DET-07',
  'git-shell-safety': 'DET-08',
  'prefix-mutation-fence': 'DET-09',
  'output-bomb': 'DET-10',
  'zombie-process': 'DET-11',
  'premature-exec': 'DET-12',
  'subagent-collision': 'DET-13',
  'placeholder-slop': 'DET-14',
  'secret-boundary': 'DET-15',
  'ttl-watchdog': 'DET-16',
  'shadow-file-bloat': 'DET-17',
  'context-rot': 'DET-17',
  'untrusted-settings': 'DET-18',
  'git-hook-bypass': 'DET-19',
  'scope-lock': 'DET-20',
  'blind-edit': 'DET-21',
  'blind-edit-without-read': 'DET-21',
  'file-shrinkage': 'DET-22',
  'diff-thrashing': 'DET-22',
  'empty-catch': 'DET-23',
  'high-turn-degradation': 'DET-24',
  'progressive-checkpoint': 'DET-25',
  'prompt-decomposer': 'DET-26',
  'rule-file-bloat': 'DET-27',
  'subagent-phantom': 'DET-28',
  'reflector-queue': 'DET-29'
});

/**
 * Claude Code numeric DET-01..20 -> Antigravity detector / semantic mapping.
 * Crucially, CC DET-19 (`subagent-ipi`) maps ONLY to `semanticDetectors['subagent-ipi']`
 * and NEVER disables Antigravity Ring-0 `DET-19` (`git-hook-bypass`).
 */
export const CLAUDE_CODE_DETECTOR_TRANSLATION = Object.freeze({
  'DET-01': { gaIds: ['DET-08', 'DET-19'], slug: 'git-shell-safety' },
  'DET-02': { gaIds: ['DET-15'], slug: 'secret-boundary' },
  'DET-03': { gaIds: [], slug: 'scope-drift' },
  'DET-04': { gaIds: ['DET-01'], slug: 'retry-churn' },
  'DET-05': { gaIds: ['DET-02'], slug: 'edit-oscillation' },
  'DET-06': { gaIds: ['DET-06'], slug: 'redundant-reread' },
  'DET-07': { gaIds: ['DET-10'], slug: 'output-bomb' },
  'DET-08': { gaIds: [], slug: 'cache-gravity-hold' },
  'DET-09': { gaIds: ['DET-09'], slug: 'prefix-mutation-fence' },
  'DET-10': { gaIds: ['DET-16'], slug: 'ttl-watchdog' },
  'DET-11': { gaIds: ['DET-17'], slug: 'shadow-file-bloat' },
  'DET-12': { gaIds: ['DET-22'], slug: 'file-shrinkage' },
  'DET-13': { gaIds: ['DET-03'], slug: 'assertion-weakening' },
  'DET-14': { gaIds: ['DET-23'], slug: 'empty-catch' },
  'DET-15': { gaIds: ['DET-14'], slug: 'placeholder-slop' },
  'DET-16': { gaIds: ['DET-05'], slug: 'premature-stop' },
  'DET-17': { gaIds: ['DET-21'], slug: 'blind-edit' },
  'DET-18': { gaIds: ['DET-18'], slug: 'untrusted-settings' },
  'DET-19': { gaIds: [], slug: 'subagent-ipi' },
  'DET-20': { gaIds: ['DET-20'], slug: 'scope-lock' }
});

export const DEFAULT_HORIZON_CONFIG = Object.freeze({
  schemaVersion: '1.0.0',
  detectorNamespace: 'antigravity',
  flightMode: 'COACH',
  detectors: Object.freeze(Object.fromEntries(EXTENDED_DETECTOR_IDS.map((id) => [id, 'default']))),
  semanticDetectors: Object.freeze({
    'subagent-ipi': 'default',
    'cache-gravity-hold': 'default',
    'scope-drift': 'default'
  }),
  thresholds: Object.freeze({
    safeLimitTokens: 147000,
    reminderAtPct: 75,
    subagentOffloadTokens: 12000,
    blindSearchLimit: 6,
    consecutiveFailureLimit: 3
  })
});

function parseNumericDetKey(rawId) {
  const s = String(rawId || '').trim().toUpperCase();
  if (/^DET[-_]?17B$/.test(s)) {
    return 'DET-21';
  }
  const m = s.match(/^DET[-_]?(\d{1,2})$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (num < 1 || num > 29) return null;
  return `DET-${String(num).padStart(2, '0')}`;
}

export function normalizeDetectorId(rawId) {
  if (rawId === null || rawId === undefined) return null;
  const trimmed = String(rawId).trim();
  if (!trimmed) return null;

  const numeric = parseNumericDetKey(trimmed);
  if (numeric) return numeric;

  const slugKey = trimmed.toLowerCase().replace(/_/g, '-');
  if (Object.prototype.hasOwnProperty.call(SLUG_TO_ANTIGRAVITY_DETECTOR, slugKey)) {
    return SLUG_TO_ANTIGRAVITY_DETECTOR[slugKey];
  }

  return null;
}

export function normalizeDetectorMode(rawMode) {
  if (rawMode === false || rawMode === 0) return 'off';
  if (rawMode === true) return 'default';
  const s = String(rawMode || 'default')
    .trim()
    .toLowerCase();
  if (s === 'off' || s === 'disable' || s === 'disabled' || s === 'mute') return 'off';
  if (s === 'warn' || s === 'advisory' || s === 'coach') return 'warn';
  if (s === 'block' || s === 'deny' || s === 'strict' || s === 'enforce') return 'block';
  return 'default';
}

export function resolveDetectorOverride(config, idOrSlug) {
  if (!config || typeof config !== 'object') return 'default';
  const slugLower = String(idOrSlug || '').trim().toLowerCase().replace(/_/g, '-');
  if (config.semanticDetectors && Object.prototype.hasOwnProperty.call(config.semanticDetectors, slugLower)) {
    const semMode = config.semanticDetectors[slugLower];
    if (semMode && semMode !== 'default') return semMode;
  }
  const normId = normalizeDetectorId(idOrSlug);
  if (normId && config.detectors && Object.prototype.hasOwnProperty.call(config.detectors, normId)) {
    return config.detectors[normId] || 'default';
  }
  return 'default';
}

function readJsonSafe(targetPath, fallback = null) {
  try {
    if (!fs.existsSync(targetPath)) return fallback;
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(targetPath, data) {
  try {
    atomicWriteFileSync(targetPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

export function resolveHorizonConfigPaths(options = {}) {
  const cwd = options.cwd || options.workspacePath || process.cwd();
  const homeDir = options.homeDir || os.homedir();
  const scope = options.scope === 'global' ? 'global' : 'project';

  const projectConfigPath = options.configPath || path.join(cwd, '.attention-horizon.json');
  const globalConfigPath = path.join(homeDir, '.attention-horizon', 'config.json');
  const activeWritePath = scope === 'global' ? globalConfigPath : projectConfigPath;

  return {
    projectConfigPath,
    globalConfigPath,
    activeWritePath
  };
}

function normalizeFlightMode(raw) {
  const fm = String(raw || '').trim().toUpperCase().replace(/-/g, '_');
  if (fm === 'AUTOPILOT') return 'AUTO_PILOT';
  if (fm === 'COACH' || fm === 'AUTO_PILOT' || fm === 'SILENT' || fm === 'OFF') {
    return fm;
  }
  return null;
}

export function loadHorizonConfig(options = {}) {
  const { projectConfigPath, globalConfigPath } = resolveHorizonConfigPaths(options);
  const globalRaw = readJsonSafe(globalConfigPath, null);
  const projectRaw = readJsonSafe(projectConfigPath, null);

  const detectors = { ...DEFAULT_HORIZON_CONFIG.detectors };
  const semanticDetectors = { ...DEFAULT_HORIZON_CONFIG.semanticDetectors };
  const thresholds = { ...DEFAULT_HORIZON_CONFIG.thresholds };
  const warnings = [];
  let flightMode = DEFAULT_HORIZON_CONFIG.flightMode;
  let detectorNamespace = DEFAULT_HORIZON_CONFIG.detectorNamespace;

  const mergeLayer = (layer, { isDiskLayer = false, sourceLabel = 'config' } = {}) => {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return;

    const rawNamespace = typeof layer.detectorNamespace === 'string'
      ? layer.detectorNamespace.trim().toLowerCase()
      : '';
    const isClaudeNamespace = rawNamespace === 'claude-code' || rawNamespace === 'claude_code' || rawNamespace === 'claude';
    const isAntigravityNamespace =
      rawNamespace === 'antigravity' ||
      rawNamespace === 'ga' ||
      Boolean(layer.antigravityDetectors && typeof layer.antigravityDetectors === 'object');

    if (rawNamespace) {
      detectorNamespace = isClaudeNamespace ? 'claude-code' : 'antigravity';
    }

    if (typeof layer.flightMode === 'string' && layer.flightMode.trim()) {
      const parsedFm = normalizeFlightMode(layer.flightMode);
      if (parsedFm) {
        flightMode = parsedFm;
      }
    }

    // Track explicit semantic slug overrides in this layer
    const explicitSlugsInLayer = new Map();
    if (layer.semanticDetectors && typeof layer.semanticDetectors === 'object') {
      for (const [sk, sv] of Object.entries(layer.semanticDetectors)) {
        const cleanSlug = String(sk || '').trim().toLowerCase().replace(/_/g, '-');
        const mode = normalizeDetectorMode(sv);
        semanticDetectors[cleanSlug] = mode;
        explicitSlugsInLayer.set(cleanSlug, mode);
        const mappedGa = SLUG_TO_ANTIGRAVITY_DETECTOR[cleanSlug];
        if (mappedGa) {
          detectors[mappedGa] = mode;
        }
      }
    }

    // Translate explicit `claudeDetectors` map if present
    if (layer.claudeDetectors && typeof layer.claudeDetectors === 'object') {
      for (const [ck, cv] of Object.entries(layer.claudeDetectors)) {
        const mode = normalizeDetectorMode(cv);
        const ccNum = parseNumericDetKey(ck);
        if (ccNum && CLAUDE_CODE_DETECTOR_TRANSLATION[ccNum]) {
          const entry = CLAUDE_CODE_DETECTOR_TRANSLATION[ccNum];
          if (entry.slug) semanticDetectors[entry.slug] = mode;
          for (const gaId of entry.gaIds) {
            detectors[gaId] = mode;
          }
        } else {
          const cleanSlug = String(ck || '').trim().toLowerCase().replace(/_/g, '-');
          if (cleanSlug === 'subagent-ipi') {
            semanticDetectors['subagent-ipi'] = mode;
          } else {
            const normGa = normalizeDetectorId(ck);
            if (normGa) detectors[normGa] = mode;
          }
        }
      }
    }

    if (layer.detectors && typeof layer.detectors === 'object') {
      // Pass 1: collect semantic slug keys first so Ring-0 guard knows whether a slug confirmed the intent
      for (const [k, v] of Object.entries(layer.detectors)) {
        const cleanKey = String(k || '').trim();
        const numericKey = parseNumericDetKey(cleanKey);
        if (!numericKey) {
          const slugKey = cleanKey.toLowerCase().replace(/_/g, '-');
          const mode = normalizeDetectorMode(v);
          explicitSlugsInLayer.set(slugKey, mode);
          semanticDetectors[slugKey] = mode;
          if (slugKey !== 'subagent-ipi' && Object.prototype.hasOwnProperty.call(SLUG_TO_ANTIGRAVITY_DETECTOR, slugKey)) {
            detectors[SLUG_TO_ANTIGRAVITY_DETECTOR[slugKey]] = mode;
          }
        }
      }

      // Pass 2: process numeric DET-XX keys according to namespace & Ring-0 Inversion Guard
      for (const [k, v] of Object.entries(layer.detectors)) {
        const numericKey = parseNumericDetKey(k);
        if (!numericKey) continue;
        const mode = normalizeDetectorMode(v);

        if (isClaudeNamespace) {
          const entry = CLAUDE_CODE_DETECTOR_TRANSLATION[numericKey];
          if (entry) {
            if (entry.slug && !explicitSlugsInLayer.has(entry.slug)) {
              semanticDetectors[entry.slug] = mode;
            }
            for (const gaId of entry.gaIds) {
              const gaSlug = ANTIGRAVITY_DETECTOR_SLUGS[gaId];
              if (!gaSlug || !explicitSlugsInLayer.has(gaSlug)) {
                detectors[gaId] = mode;
              }
            }
          }
          continue;
        }

        // Ring-0 Inversion Guard on un-namespaced legacy disk configs
        const gaSlug = ANTIGRAVITY_DETECTOR_SLUGS[numericKey];
        const slugConfirmedOff = gaSlug && explicitSlugsInLayer.get(gaSlug) === 'off';
        const isUnnamespacedLegacy = isDiskLayer && !isAntigravityNamespace && !rawNamespace;

        if (
          isUnnamespacedLegacy &&
          mode === 'off' &&
          RING0_SECURITY_DETECTORS.includes(numericKey) &&
          !slugConfirmedOff
        ) {
          detectors[numericKey] = 'warn';
          warnings.push(
            `[Ring-0 Inversion Guard] Clamped un-namespaced "${numericKey}": "off" in ${sourceLabel} to "warn" to prevent cross-edition Ring-0 security disablement. Set "detectorNamespace": "antigravity" or "${gaSlug}": "off" to disable explicitly.`
          );
        } else if (!gaSlug || !explicitSlugsInLayer.has(gaSlug)) {
          detectors[numericKey] = mode;
        }
      }
    }

    // Explicit `antigravityDetectors` map always applies directly with full authority
    if (layer.antigravityDetectors && typeof layer.antigravityDetectors === 'object') {
      for (const [ak, av] of Object.entries(layer.antigravityDetectors)) {
        const normGa = normalizeDetectorId(ak);
        if (normGa) {
          const mode = normalizeDetectorMode(av);
          detectors[normGa] = mode;
          const gaSlug = ANTIGRAVITY_DETECTOR_SLUGS[normGa];
          if (gaSlug) semanticDetectors[gaSlug] = mode;
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
    mergeLayer(options.overrides, { isDiskLayer: Boolean(options.treatOverridesAsDisk), sourceLabel: 'overrides' });
  }

  return {
    schemaVersion: '1.0.0',
    detectorNamespace,
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

export function setDetectorOverride(detectorId, mode, options = {}) {
  const rawSlug = String(detectorId || '').trim().toLowerCase().replace(/_/g, '-');
  const normMode = normalizeDetectorMode(mode);
  const { activeWritePath } = resolveHorizonConfigPaths(options);

  if (rawSlug === 'subagent-ipi') {
    const existing = readJsonSafe(activeWritePath, {}) || {};
    const nextDetectors = { ...(existing.detectors || {}) };
    const nextSemantic = { ...(existing.semanticDetectors || {}) };
    if (normMode === 'default') {
      delete nextDetectors['subagent-ipi'];
      delete nextSemantic['subagent-ipi'];
    } else {
      nextDetectors['subagent-ipi'] = normMode;
      nextSemantic['subagent-ipi'] = normMode;
    }
    const nextPayload = {
      schemaVersion: '1.0.0',
      detectorNamespace: 'antigravity',
      ...existing,
      detectorNamespace: 'antigravity',
      detectors: nextDetectors,
      semanticDetectors: nextSemantic
    };
    const ok = writeJsonAtomic(activeWritePath, nextPayload);
    return {
      ok,
      detectorId: 'subagent-ipi',
      slug: 'subagent-ipi',
      mode: normMode,
      configPath: activeWritePath,
      config: loadHorizonConfig(options)
    };
  }

  const normId = normalizeDetectorId(detectorId);
  if (!normId) {
    return {
      ok: false,
      detectorId: null,
      mode: normMode,
      configPath: activeWritePath,
      config: loadHorizonConfig(options)
    };
  }

  const slug = ANTIGRAVITY_DETECTOR_SLUGS[normId] || null;
  const existing = readJsonSafe(activeWritePath, {}) || {};
  const nextDetectors = { ...(existing.detectors || {}) };
  const nextAntigravityDetectors = { ...(existing.antigravityDetectors || {}) };

  if (normMode === 'default') {
    delete nextDetectors[normId];
    if (slug) delete nextDetectors[slug];
    delete nextAntigravityDetectors[normId];
  } else {
    nextDetectors[normId] = normMode;
    if (slug) nextDetectors[slug] = normMode;
    nextAntigravityDetectors[normId] = normMode;
  }

  const nextPayload = {
    schemaVersion: '1.0.0',
    ...existing,
    detectorNamespace: 'antigravity',
    detectors: nextDetectors,
    antigravityDetectors: nextAntigravityDetectors
  };

  const ok = writeJsonAtomic(activeWritePath, nextPayload);
  return {
    ok,
    detectorId: normId,
    slug,
    mode: normMode,
    configPath: activeWritePath,
    config: loadHorizonConfig(options)
  };
}

/**
 * Maps a detector trigger or runtime telemetry state to concrete native slash-command
 * recovery prescriptions (`/rewind`, `/fork`, `/mcp`, `/context`, `/effort`, `/handoff` -> `/clear`).
 * Strictly preserves Antigravity UI Invariant #1: `/compact` is always a plain-text instruction
 * (`Type /compact in the chat box and press Enter`) and never a clickable copy button.
 */
export function mapTriggerToNativeCommand(trigger = {}) {
  const platform = String(trigger.platform || 'antigravity').toLowerCase();
  const normId = normalizeDetectorId(trigger.detectorId);
  const consecutiveFailures = Number(
    trigger.consecutiveFailures ?? trigger.failureCount ?? (normId === 'DET-01' ? 3 : 0)
  );
  const contextUsedPct = Number(trigger.contextUsedPct ?? trigger.context_used_pct ?? 0);
  const modifiedFiles = Array.isArray(trigger.modifiedFiles)
    ? trigger.modifiedFiles.filter(Boolean)
    : [];
  const unresolvedTasks = Array.isArray(trigger.unresolvedTasks)
    ? trigger.unresolvedTasks.filter(Boolean)
    : [];

  // 1. Poisoned Context Recovery (/rewind and /fork)
  if (consecutiveFailures >= 3 || normId === 'DET-01' || normId === 'DET-02') {
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
    normId === 'DET-10' ||
    normId === 'DET-11' ||
    Boolean(trigger.instructionsOverBudget) ||
    Boolean(trigger.idleMcpBloat)
  ) {
    const isEffort = normId === 'DET-11' || Boolean(trigger.effortStepDown);
    return {
      category: 'STANDING_OVERHEAD_TRIM',
      primaryCommand: isEffort ? '/effort' : '/mcp',
      secondaryCommand: isEffort ? '/mcp' : '/context',
      clickableCopyAllowed: true,
      preservedFiles: modifiedFiles,
      summary: isEffort
        ? 'Run `/effort` to step down reasoning cost on routine turns.'
        : 'Run `/mcp` and `/context` to prune idle MCP tool manifests, or `/effort` to step down reasoning cost.'
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
      summary: 'Run `/handoff` to write task.md / HANDOFF.md, followed immediately by `/clear`.'
    };
  }

  // 4. Scoped Context Compaction (/compact) — Plain-text invariant enforced on Antigravity
  const warnThreshold = Number(trigger.horizonWarningThresholdPct || 70);
  if (contextUsedPct >= warnThreshold || normId === 'DET-09') {
    const fileScope =
      modifiedFiles.length > 0 ? modifiedFiles.join(', ') : 'active modified files';
    const taskScope =
      unresolvedTasks.length > 0 ? `; unresolved tasks: ${unresolvedTasks.join('; ')}` : '';
    const isAntigravity = platform === 'antigravity';
    return {
      category: 'SCOPED_CONTEXT_COMPACTION',
      primaryCommand: isAntigravity
        ? 'Type /compact in the chat box and press Enter'
        : `/compact Preserve modified files (${fileScope})${taskScope} and active architectural invariants.`,
      secondaryCommand: '/handoff',
      plainTextInstruction: 'Type /compact in the chat box and press Enter',
      clickableCopyAllowed: !isAntigravity,
      preservedFiles: modifiedFiles,
      reclaimScope: `Preserve ${fileScope}${taskScope}`,
      summary: `Type /compact in the chat box and press Enter (preserving ${fileScope}${taskScope}).`
    };
  }

  return null;
}

/**
 * Applies `.attention-horizon.json` detector overrides (`off` | `warn` | `block`)
 * to an array of Antigravity detector findings (`evaluateDetectorsOnSteps`).
 */
export function filterFindingsByHorizonConfig(findings = [], config = null) {
  if (!Array.isArray(findings)) return findings;
  const result = [];
  for (const f of findings) {
    const normId = normalizeDetectorId(f?.detectorId);
    const mode = normId && config ? resolveDetectorOverride(config, normId) : 'default';
    if (mode === 'off') {
      continue;
    }
    const prescription =
      f.prescription || mapTriggerToNativeCommand({ detectorId: normId }) || null;
    const baseFinding = prescription ? { ...f, prescription } : f;
    if (mode === 'warn') {
      result.push({
        ...baseFinding,
        severity: 'WARN',
        haltsGeneration: false,
        overriddenByConfig: 'warn'
      });
    } else if (mode === 'block') {
      result.push({
        ...baseFinding,
        severity: 'CRITICAL',
        haltsGeneration: true,
        overriddenByConfig: 'block'
      });
    } else {
      result.push(baseFinding);
    }
  }
  return result;
}

export function redactUserPaths(text, homeDir = os.homedir()) {
  const raw = String(text || '');
  if (!homeDir) return raw;
  const escapedWin = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const posixHome = homeDir.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return raw
    .replace(new RegExp(escapedWin, 'gi'), '~')
    .replace(new RegExp(posixHome, 'gi'), '~');
}

export function resolveGitHeadMetadata(cwd = process.cwd()) {
  try {
    const gitDir = path.join(cwd, '.git');
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) {
      return { branch: 'untracked', shortCommit: 'none', isGitRepo: false };
    }
    const headRaw = fs.readFileSync(headPath, 'utf8').trim();
    if (headRaw.startsWith('ref:')) {
      const refRel = headRaw.replace(/^ref:\s*/, '').trim();
      const branch = refRel.replace(/^refs\/heads\//, '');
      const refFullPath = path.join(gitDir, ...refRel.split('/'));
      if (fs.existsSync(refFullPath)) {
        const sha = fs.readFileSync(refFullPath, 'utf8').trim();
        return { branch, shortCommit: sha.slice(0, 7) || 'HEAD', isGitRepo: true };
      }
      return { branch, shortCommit: 'HEAD', isGitRepo: true };
    }
    return { branch: 'detached', shortCommit: headRaw.slice(0, 7) || 'HEAD', isGitRepo: true };
  } catch {
    return { branch: 'unknown', shortCommit: 'none', isGitRepo: false };
  }
}

export function generateAntigravityDiagnosticMarkdown(results = [], options = {}) {
  const cwd = options.workspacePath || options.cwd || process.cwd();
  const homeDir = options.homeDir || os.homedir();
  const config = loadHorizonConfig({ ...options, cwd, homeDir });
  const git = resolveGitHeadMetadata(cwd);
  const activeOverrides = Object.entries(config.detectors || {})
    .filter(([, m]) => m !== 'default')
    .map(([id, m]) => `${id}=${m}`);

  const sanitized = results.map((r) => ({
    title: r.title,
    status: r.status,
    detail: redactUserPaths(r.detail, homeDir)
  }));

  const mdLines = [
    '### Attention Horizon (Antigravity Edition) — Zero-PII Diagnostic Report',
    '',
    '| Field | Value |',
    '| :--- | :--- |',
    `| **Package** | \`attention-horizon-antigravity@3.3.0\` |`,
    `| **OS / Arch** | \`${process.platform} (${process.arch})\` |`,
    `| **Node.js** | \`${process.version}\` |`,
    `| **Git Context** | \`${git.branch}@${git.shortCommit}\` |`,
    `| **Flight Mode** | \`${config.flightMode}\` |`,
    `| **Detector Overrides** | \`${activeOverrides.length ? activeOverrides.join(', ') : 'none (all 20 default)'}\` |`,
    '',
    '#### Doctor Check Matrix',
    ...sanitized.map(
      (r) => `- [${r.status === 'PASS' ? 'x' : ' '}] **\`${r.title}\`** (\`${r.status}\`): ${r.detail}`
    )
  ];

  return {
    ok: !sanitized.some((r) => r.status === 'FAIL'),
    git,
    config,
    checks: sanitized,
    markdown: mdLines.join('\n')
  };
}

export default {
  CANONICAL_DETECTOR_IDS,
  EXTENDED_DETECTOR_IDS,
  RING0_SECURITY_DETECTORS,
  ANTIGRAVITY_DETECTOR_SLUGS,
  SLUG_TO_ANTIGRAVITY_DETECTOR,
  CLAUDE_CODE_DETECTOR_TRANSLATION,
  DEFAULT_HORIZON_CONFIG,
  normalizeDetectorId,
  normalizeDetectorMode,
  resolveDetectorOverride,
  resolveHorizonConfigPaths,
  loadHorizonConfig,
  setDetectorOverride,
  mapTriggerToNativeCommand,
  filterFindingsByHorizonConfig,
  redactUserPaths,
  resolveGitHeadMetadata,
  generateAntigravityDiagnosticMarkdown
};
