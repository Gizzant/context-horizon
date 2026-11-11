import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HORIZON_WINDOW, SHARED_1M_CONTEXT_POOL_TOKENS, resolvePatchedCliCeiling } from './constants.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';

/**
 * User-editable Context Memory settings, stored at
 * `<cacheDir>/settings.json`:
 *   { safeLimitTokens, reminderAtPct, modelOverrides: { [modelId]: safeLimitTokens } }
 */

export const SETTINGS_LIMITS = {
  SAFE_LIMIT_MIN: 20000,
  SAFE_LIMIT_MAX: SHARED_1M_CONTEXT_POOL_TOKENS,
  REMINDER_PCT_MIN: 50,
  REMINDER_PCT_MAX: 99
};

export const DEFAULT_SETTINGS = Object.freeze({
  safeLimitTokens: HORIZON_WINDOW.AMPUTATION_THRESHOLD_TOKENS,
  reminderAtPct: 85,
  modelOverrides: {}
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function toInt(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[_,\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

/** Returns a fully-populated, clamped settings object. Unknown keys are dropped. */
export function validateSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS, modelOverrides: {} };
  const limit = toInt(input.safeLimitTokens);
  if (!Number.isNaN(limit)) out.safeLimitTokens = clamp(limit, SETTINGS_LIMITS.SAFE_LIMIT_MIN, SETTINGS_LIMITS.SAFE_LIMIT_MAX);
  const pct = toInt(input.reminderAtPct);
  if (!Number.isNaN(pct)) out.reminderAtPct = clamp(pct, SETTINGS_LIMITS.REMINDER_PCT_MIN, SETTINGS_LIMITS.REMINDER_PCT_MAX);
  if (input.modelOverrides && typeof input.modelOverrides === 'object') {
    for (const [model, v] of Object.entries(input.modelOverrides)) {
      const n = toInt(v);
      if (model && model.length <= 120 && !Number.isNaN(n)) {
        out.modelOverrides[model] = clamp(n, SETTINGS_LIMITS.SAFE_LIMIT_MIN, SETTINGS_LIMITS.SAFE_LIMIT_MAX);
      }
    }
  }
  return out;
}

export function settingsFile(cacheDir) {
  return path.join(cacheDir, 'settings.json');
}

export function loadSettings(cacheDir) {
  try {
    return validateSettings(JSON.parse(fs.readFileSync(settingsFile(cacheDir), 'utf8')));
  } catch {
    return validateSettings({});
  }
}

/** Merges `patch` over the stored settings, validates, writes atomically, returns the result. */
export function saveSettings(cacheDir, patch = {}) {
  const merged = validateSettings({ ...loadSettings(cacheDir), ...patch });
  atomicWriteFileSync(settingsFile(cacheDir), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/** Resolves `{ safeLimit, reminderAt, reminderAtPct }` for a model. */
export function resolveWindow(settings, modelId) {
  const s = settings || DEFAULT_SETTINGS;
  const safeLimit = (modelId && s.modelOverrides?.[modelId]) || s.safeLimitTokens;
  return {
    safeLimit,
    reminderAtPct: s.reminderAtPct,
    reminderAt: Math.round(safeLimit * s.reminderAtPct / 100)
  };
}

/**
 * Reads `~/.gemini/antigravity-cli/settings.json` (or a custom path)
 * to inspect patched CLI context window overrides (512k or 900k whitelisted tiers).
 */
export function loadCliSurfaceSettings(customFilePath = null) {
  const targetFile = customFilePath || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  try {
    if (!fs.existsSync(targetFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const patchedTokens = resolvePatchedCliCeiling(parsed);
    return {
      ...parsed,
      patchedCeilingTokens: patchedTokens
    };
  } catch {
    return null;
  }
}
