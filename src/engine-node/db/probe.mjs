/**
 * @file src/engine-node/db/probe.mjs
 * Dynamic runtime probe for node:sqlite builtin module.
 *
 * Enables full read-only SQLite & FTS5 on Node >= 22.5, with automatic fallback
 * to JSONL parsing on Node 20 LTS with zero --no-warnings flags.
 */

let warningSuppressed = false;

/**
 * Suppresses experimental SQLite warning from process.emitWarning.
 * Allows Node >= 22.5 to load node:sqlite with 0 stderr noise and zero --no-warnings CLI flags.
 */
export function suppressSqliteWarning({ force = false } = {}) {
  if ((warningSuppressed && !force) || typeof process === 'undefined') return;
  warningSuppressed = true;
  if (typeof process.emitWarning === 'function') {
    const orig = process.emitWarning.bind(process);
    process.emitWarning = function (warning, ...args) {
      const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
      const type = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].type) || (warning && warning.name) || '';
      if ((type === 'ExperimentalWarning' && /SQLite/i.test(msg)) || /SQLite is an experimental feature/i.test(msg)) {
        return;
      }
      return orig(warning, ...args);
    };
  }
}

let probedModule = undefined;

/**
 * Probes for built-in node:sqlite module via process.getBuiltinModule.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.forceFallback=false]
 * @param {Function|null} [options.getBuiltinModuleOverride=null]
 * @returns {object|null}
 */
export function probeSqliteBuiltin({ forceFallback = false, getBuiltinModuleOverride = null } = {}) {
  if (
    forceFallback ||
    (typeof process !== 'undefined' && process.env?.CTXTOP_FORCE_NO_SQLITE === '1')
  ) {
    return null;
  }
  if (probedModule !== undefined && !getBuiltinModuleOverride) return probedModule;

  suppressSqliteWarning();

  const getBuiltin = getBuiltinModuleOverride ||
    (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule.bind(process)
      : null);

  if (!getBuiltin) {
    if (!getBuiltinModuleOverride) probedModule = null;
    return null;
  }

  try {
    const mod = getBuiltin('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      if (!getBuiltinModuleOverride) probedModule = mod;
      return mod;
    }
  } catch {
    // Fail-open: probe never throws
  }

  if (!getBuiltinModuleOverride) probedModule = null;
  return null;
}

/**
 * Returns true if built-in node:sqlite with DatabaseSync is available in this runtime.
 *
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function isNodeSqliteAvailable(options = {}) {
  return Boolean(probeSqliteBuiltin(options));
}

/**
 * Returns the DatabaseSync constructor if available, or null.
 *
 * @param {object} [options={}]
 * @returns {Function|null}
 */
export function getDatabaseSyncClass(options = {}) {
  const mod = probeSqliteBuiltin(options);
  return mod?.DatabaseSync || null;
}

/**
 * Resets probe cache for testing environments.
 */
export function resetProbeCacheForTesting() {
  probedModule = undefined;
}

export default {
  suppressSqliteWarning,
  probeSqliteBuiltin,
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  resetProbeCacheForTesting
};
