/**
 * @file src/engine-node/db/index.mjs
 * Unified database client factory for Highbeam storage engines.
 *
 * Dynamically resolves to native read-only node:sqlite on Node >= 22.5,
 * or pure-JS JsonlDatabaseFallbackWrapper on Node 20 LTS without warnings.
 */

import { isNodeSqliteAvailable, getDatabaseSyncClass, suppressSqliteWarning } from './probe.mjs';
import { SqliteDatabaseSyncWrapper } from './sqlite_wrapper.mjs';
import { JsonlDatabaseFallbackWrapper } from './jsonl_fallback.mjs';

/**
 * Returns a unified read-only database client.
 *
 * @param {object} options
 * @param {string} options.dbPath - Path to database or session transcript
 * @param {boolean} options.readOnly - Must strictly be true
 * @param {boolean} [options.forceFallback=false] - Force JSONL fallback wrapper
 * @returns {SqliteDatabaseSyncWrapper | JsonlDatabaseFallbackWrapper}
 */
export function getDatabaseClient(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('getDatabaseClient requires an options object');
  }
  if (options.readOnly !== true) {
    throw new Error('[Zero-Trust SQLite Guard] getDatabaseClient strictly requires { readOnly: true }');
  }
  if (!options.dbPath || typeof options.dbPath !== 'string') {
    throw new TypeError('getDatabaseClient requires a non-empty dbPath string');
  }

  const { dbPath, forceFallback = false } = options;

  if (!forceFallback && isNodeSqliteAvailable()) {
    const DatabaseSync = getDatabaseSyncClass();
    return new SqliteDatabaseSyncWrapper(dbPath, { ...options, DatabaseSync });
  }

  return new JsonlDatabaseFallbackWrapper(dbPath, options);
}

export {
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  suppressSqliteWarning,
  SqliteDatabaseSyncWrapper,
  JsonlDatabaseFallbackWrapper
};

export default {
  getDatabaseClient,
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  suppressSqliteWarning,
  SqliteDatabaseSyncWrapper,
  JsonlDatabaseFallbackWrapper
};
