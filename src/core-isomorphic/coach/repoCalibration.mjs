/**
 * @file src/coach/repoCalibration.mjs
 * Empirical Repo-Calibrated Context Physics (`IDEA-03` — Technical Moat `A4`).
 *
 * Learns repository-specific context sinks across coding sessions:
 *   1. Chronic file re-read hotspots (`fileReads` frequency & cumulative token drain across sessions)
 *   2. Empirical post-compaction token survival ratio (`compactions.averageSurvivalRatio`)
 *   3. Empirical KV-cache hit baseline (`cachePerformance.empiricalHitRatio`)
 *
 * Persisted locally in `.claude/horizon-state/repo_calibration.json` (100% zero-socket).
 */

import { path, getCwd, readJsonSafe, writeJsonAtomic } from '../utils/runtime.mjs';

const DEFAULT_CALIBRATION_STATE = Object.freeze({
  schemaVersion: '1.0.0',
  updatedAt: null,
  fileReads: {},
  compactions: {
    count: 0,
    totalPreTokens: 0,
    totalPostTokens: 0,
    averageSurvivalRatio: 0.22
  },
  cachePerformance: {
    totalTurns: 0,
    warmHitTurns: 0,
    empiricalHitRatio: 0
  }
});

/**
 * Resolves the path to `.claude/horizon-state/repo_calibration.json`.
 * @param {object} [options={}]
 * @returns {string}
 */
export function getRepoCalibrationPath(options = {}) {
  if (options.calibrationPath) return options.calibrationPath;
  const cwd = getCwd(options);
  const stateDir = options.stateDir || path.join(cwd, '.claude', 'horizon-state');
  return path.join(stateDir, 'repo_calibration.json');
}

/**
 * Normalizes a repository file path to a portable forward-slash key.
 * @param {string} filePath
 * @param {string} [cwd='.']
 * @returns {string}
 */
export function normalizeRepoFileKey(filePath, cwd = '.') {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  try {
    const rel = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw;
    const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    return clean.startsWith('..') ? raw.replace(/\\/g, '/') : clean;
  } catch (_err) {
    return raw.replace(/\\/g, '/');
  }
}

/**
 * Loads the empirical calibration store for the current repository.
 * @param {object} [options={}]
 * @returns {object}
 */
export function loadRepoCalibration(options = {}) {
  const targetPath = getRepoCalibrationPath(options);
  const raw = readJsonSafe(targetPath, null, options);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return JSON.parse(JSON.stringify(DEFAULT_CALIBRATION_STATE));
  }
  return {
    schemaVersion: '1.0.0',
    updatedAt: raw.updatedAt || null,
    fileReads: raw.fileReads && typeof raw.fileReads === 'object' ? { ...raw.fileReads } : {},
    compactions: {
      ...DEFAULT_CALIBRATION_STATE.compactions,
      ...(raw.compactions || {})
    },
    cachePerformance: {
      ...DEFAULT_CALIBRATION_STATE.cachePerformance,
      ...(raw.cachePerformance || {})
    }
  };
}

/**
 * Records a file read event in the repository calibration store and detects
 * whether the file has become a chronic multi-read context sink.
 *
 * @param {{ filePath: string, estimatedTokens?: number, sessionId?: string }} event
 * @param {object} [options={}]
 * @returns {{
 *   fileKey: string,
 *   readCount: number,
 *   sessionCount: number,
 *   totalEstimatedTokens: number,
 *   isChronicSink: boolean,
 *   recommendation: string | null
 * }}
 */
export function recordRepoFileRead(event = {}, options = {}) {
  const cwd = getCwd(options);
  const fileKey = normalizeRepoFileKey(event.filePath, cwd);
  if (!fileKey) {
    return {
      fileKey: '',
      readCount: 0,
      sessionCount: 0,
      totalEstimatedTokens: 0,
      isChronicSink: false,
      recommendation: null
    };
  }

  const tokens = Math.max(0, Math.round(Number(event.estimatedTokens ?? 0)));
  const sessionId = String(event.sessionId || options.sessionId || 'default');
  const state = loadRepoCalibration(options);

  const existing = state.fileReads[fileKey] || {
    readCount: 0,
    totalEstimatedTokens: 0,
    sessionsSeen: [],
    lastReadAt: null
  };

  existing.readCount = Number(existing.readCount || 0) + 1;
  existing.totalEstimatedTokens = Number(existing.totalEstimatedTokens || 0) + tokens;
  const sessions = Array.isArray(existing.sessionsSeen) ? [...existing.sessionsSeen] : [];
  if (!sessions.includes(sessionId)) {
    sessions.push(sessionId);
  }
  existing.sessionsSeen = sessions.slice(-25);
  existing.lastReadAt = new Date().toISOString();

  state.fileReads[fileKey] = existing;
  state.updatedAt = existing.lastReadAt;
  writeJsonAtomic(getRepoCalibrationPath(options), state, options);

  // Exclude small onboarding docs (e.g., README.md read <= 2x per chat) from false-positive sink status
  const isOnboardingDoc = /^(?:README\.md|CLAUDE\.md|AGENTS\.md|LICENSE)$/i.test(
    path.basename(fileKey)
  );
  const avgReadsPerSession = existing.readCount / Math.max(1, existing.sessionsSeen.length);

  const isChronicSink = isOnboardingDoc
    ? existing.readCount >= 6 && avgReadsPerSession >= 3
    : existing.readCount >= 3 && existing.totalEstimatedTokens >= 6000;

  const recommendation = isChronicSink
    ? `Repo Calibration Alert: "${fileKey}" has been read ${existing.readCount}x (${existing.totalEstimatedTokens.toLocaleString()} cumulative tok across ${existing.sessionsSeen.length} session(s)). Use ranged line reads (offset/limit) or delegate to an Explore subagent.`
    : null;

  return {
    fileKey,
    readCount: existing.readCount,
    sessionCount: existing.sessionsSeen.length,
    totalEstimatedTokens: existing.totalEstimatedTokens,
    isChronicSink,
    recommendation
  };
}

/**
 * Records an observed compaction outcome (`preTokens` -> `postTokens`) to calibrate
 * the repository's empirical post-compaction survival ratio.
 *
 * @param {{ preTokens: number, postTokens: number }} event
 * @param {object} [options={}]
 * @returns {object}
 */
export function recordRepoCompactionOutcome(event = {}, options = {}) {
  const pre = Math.max(0, Number(event.preTokens || 0));
  const post = Math.max(0, Number(event.postTokens || 0));
  const state = loadRepoCalibration(options);

  if (pre > 0 && post > 0 && post <= pre) {
    state.compactions.count += 1;
    state.compactions.totalPreTokens += pre;
    state.compactions.totalPostTokens += post;
    state.compactions.averageSurvivalRatio = Number(
      (state.compactions.totalPostTokens / state.compactions.totalPreTokens).toFixed(4)
    );
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(getRepoCalibrationPath(options), state, options);
  }

  return state.compactions;
}

/**
 * Records a turn's KV-cache read ratio to maintain an empirical cache-hit baseline for the repo.
 *
 * @param {{ cacheReadTokens: number, totalPromptTokens: number }} event
 * @param {object} [options={}]
 * @returns {object}
 */
export function recordRepoCacheTurn(event = {}, options = {}) {
  const readTok = Math.max(0, Number(event.cacheReadTokens || 0));
  const totalTok = Math.max(0, Number(event.totalPromptTokens || 0));
  const state = loadRepoCalibration(options);

  if (totalTok > 0) {
    state.cachePerformance.totalTurns += 1;
    if (readTok / totalTok >= 0.5) {
      state.cachePerformance.warmHitTurns += 1;
    }
    state.cachePerformance.empiricalHitRatio = Number(
      (state.cachePerformance.warmHitTurns / state.cachePerformance.totalTurns).toFixed(4)
    );
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(getRepoCalibrationPath(options), state, options);
  }

  return state.cachePerformance;
}

/**
 * Returns the top chronic re-read context-sink files in this repository.
 *
 * @param {object} [options={}]
 * @returns {Array<{
 *   fileKey: string,
 *   readCount: number,
 *   sessionCount: number,
 *   totalEstimatedTokens: number
 * }>}
 */
export function getTopChronicReadFiles(options = {}) {
  const limit = Number(options.limit || 5);
  const state = loadRepoCalibration(options);
  const entries = Object.entries(state.fileReads || {}).map(([fileKey, info]) => ({
    fileKey,
    readCount: Number(info.readCount || 0),
    sessionCount: Array.isArray(info.sessionsSeen) ? info.sessionsSeen.length : 1,
    totalEstimatedTokens: Number(info.totalEstimatedTokens || 0)
  }));

  return entries
    .filter((e) => e.readCount >= 2)
    .sort((a, b) => b.totalEstimatedTokens - a.totalEstimatedTokens || b.readCount - a.readCount)
    .slice(0, limit);
}

export default {
  getRepoCalibrationPath,
  normalizeRepoFileKey,
  loadRepoCalibration,
  recordRepoFileRead,
  recordRepoCompactionOutcome,
  recordRepoCacheTurn,
  getTopChronicReadFiles
};
