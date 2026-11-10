import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SESSION_RISK_THRESHOLDS } from './constants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLED_CONFIG_PATH = path.resolve(__dirname, '../../config/default_flightcheck.json');

/**
 * Built-in minimal defaults guaranteed to exist even without disk config files.
 */
export const BUILTIN_CONFIG = Object.freeze({
  hook_level: 'guard', // 'off' | 'advisory' | 'guard'
  halt_cooldown_turns: 3,
  cold_session_max_turns: 3,
  trust_decay_turn_threshold: 10,
  warm_cache_lock_tokens: SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS,
  subagent_min_cache_tokens: SESSION_RISK_THRESHOLDS.LEAN_SESSION_TOKENS,
  subagent_min_purity_pct: 70.0,
  compact_halt_purity_pct: 45.0,
  amputation_token_threshold: 140000,
  quota_floor_fraction: 0.10,
  max_single_write_lines: 600,
  max_tool_payload_tokens: 25000,
  uncheckpointed_dirty_file_limit: 4,
  consecutive_error_strike_limit: 3,
  plan_revision_warn: 3,
  split_recommend_minutes: 45,
  proof_quality_warn_on: ['None'],
  handoff_audit_enabled: true,
  deprecated_paths: ['**/legacy/**', '**/deprecated/**', '**/v1/**'],
  recommended_models: {
    fast: 'gemini-3.8-flash',
    deep: 'gemini-3.1-pro'
  },
  model_ceilings: {
    'gemini-3.8-flash': 256000,
    'gemini-4-argon': 256000,
    'gemini-4-argon-high': 256000,
    'gemini-4-argon-medium': 256000,
    'claude-opus-5.5': 256000,
    'claude-3-5-sonnet': 256000,
    'gemini-1.5-pro-1m': 1000000,
    'gemini-2.5-pro-1m': 1000000,
    'default': 256000
  },
  model_pricing_per_1m_input: {
    'gemini-3.8-flash': 0.75,
    'gemini-2.0-flash': 0.75,
    'gemini-3.1-pro': 1.25,
    'gemini-1.5-pro': 1.25,
    'gemini-4-argon': 1.25,
    'claude-3-5-sonnet': 3.00,
    'claude-opus-5.5': 3.00,
    'claude-opus-4-6-thinking': 5.00,
    'default': 0.75
  }
});

let cachedConfig = null;
let lastCheckTime = 0;
let lastBundledMtime = 0;
let lastUserMtime = 0;
const CACHE_TTL_MS = 250; // In-memory cache valid for 250ms to ensure sub-millisecond hook SLA

/**
 * Returns the path to the optional user config overlay (~/.gemini/flightcheck/config.json).
 */
export function getUserConfigPath(baseDirOverride = null) {
  if (baseDirOverride) return path.join(baseDirOverride, 'config.json');
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.gemini', 'flightcheck', 'config.json');
}

/**
 * Safely reads and parses JSON, returning fallback on any error.
 */
function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Merges source properties into target (shallow merge for primitives, shallow merge for top-level objects).
 */
function shallowObjectMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && result[k] && typeof result[k] === 'object' && !Array.isArray(result[k])) {
      result[k] = { ...result[k], ...v };
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Loads the active Flight Check configuration with three-tier precedence:
 * Built-in minimal defaults < Bundled config/default_flightcheck.json < User overlay (~/.gemini/flightcheck/config.json)
 */
export function loadFlightcheckConfig({
  baseDirOverride = null,
  bundledPath = DEFAULT_BUNDLED_CONFIG_PATH,
  forceReload = false
} = {}) {
  const now = Date.now();
  const userCfgPath = getUserConfigPath(baseDirOverride);

  if (!forceReload && cachedConfig && (now - lastCheckTime < CACHE_TTL_MS)) {
    return cachedConfig;
  }

  let bundledMtime = 0;
  let userMtime = 0;
  try {
    if (fs.existsSync(bundledPath)) bundledMtime = fs.statSync(bundledPath).mtimeMs;
  } catch {}
  try {
    if (fs.existsSync(userCfgPath)) userMtime = fs.statSync(userCfgPath).mtimeMs;
  } catch {}

  if (!forceReload && cachedConfig && bundledMtime === lastBundledMtime && userMtime === lastUserMtime) {
    lastCheckTime = now;
    return cachedConfig;
  }

  const bundledJson = readJsonSafe(bundledPath);
  const userJson = readJsonSafe(userCfgPath);

  let merged = shallowObjectMerge(BUILTIN_CONFIG, bundledJson);
  merged = shallowObjectMerge(merged, userJson);

  lastBundledMtime = bundledMtime;
  lastUserMtime = userMtime;
  lastCheckTime = now;
  cachedConfig = Object.freeze(merged);
  return cachedConfig;
}

/**
 * Clears the in-memory cache (primarily for tests).
 */
export function clearConfigCache() {
  cachedConfig = null;
  lastCheckTime = 0;
  lastBundledMtime = 0;
  lastUserMtime = 0;
}
