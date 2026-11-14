/**
 * Highbeam Airlock (ctxtop Pro Stateless v1 Module) — Isomorphic Core Index.
 * Mod Law 4 compliant: pure ES module re-exports and pure configuration resolver.
 */

export * from './hmacTwin.mjs';
export * from './detector.mjs';
export * from './claudeOutputShaper.mjs';
export * from './preToolGuard.mjs';

export const AIRLOCK_DEFAULT_WATCHDOG_MS = 3500;

export function resolveAirlockConfig(horizonConfig = {}, policy = {}, env = {}) {
  const hcAirlock = (horizonConfig && typeof horizonConfig.airlock === 'object' && horizonConfig.airlock)
    ? horizonConfig.airlock
    : {};
  const pol = (policy && typeof policy === 'object') ? policy : {};

  const envEnabled = env?.AH_AIRLOCK_ENABLED;
  const envMode = env?.AH_AIRLOCK_MODE ? String(env.AH_AIRLOCK_MODE).trim().toLowerCase() : '';

  let enabled = false;
  if (typeof envEnabled === 'string' && envEnabled.trim() !== '') {
    enabled = envEnabled === '1' || envEnabled.toLowerCase() === 'true';
  } else if (typeof pol.enabled === 'boolean') {
    enabled = pol.enabled;
  } else if (typeof hcAirlock.enabled === 'boolean') {
    enabled = hcAirlock.enabled;
  }

  let mode = envMode || String(pol.mode || hcAirlock.mode || (enabled ? 'enforce' : 'off')).toLowerCase();
  if (!['off', 'audit', 'enforce'].includes(mode)) {
    mode = enabled ? 'enforce' : 'off';
  }
  if (mode === 'off') {
    enabled = false;
  }

  const rawWatchdog = Number(
    env?.AH_AIRLOCK_WATCHDOG_MS ||
    pol.watchdogTimeoutMs ||
    hcAirlock.watchdogTimeoutMs ||
    AIRLOCK_DEFAULT_WATCHDOG_MS
  );
  // Keep watchdog safely below host 5000ms timeout so self-timeout can emit exit 2 before SIGKILL
  const watchdogTimeoutMs = Number.isFinite(rawWatchdog)
    ? Math.max(500, Math.min(4500, Math.trunc(rawWatchdog)))
    : AIRLOCK_DEFAULT_WATCHDOG_MS;

  const terms = Array.isArray(pol.terms)
    ? pol.terms
    : (Array.isArray(pol.customTerms) ? pol.customTerms : []);
  const allowlistHmacs = Array.isArray(pol.allowlistHmacs)
    ? pol.allowlistHmacs
    : (Array.isArray(pol.hmacAllowlist) ? pol.hmacAllowlist : []);

  return {
    enabled,
    mode,
    failClosed: pol.failClosed !== false && hcAirlock.failClosed !== false,
    watchdogTimeoutMs,
    policySigned: Boolean(pol._signed),
    policySignatureValid: Boolean(pol._signatureValid),
    trustedDirectories: Array.isArray(pol.trustedDirectories) ? pol.trustedDirectories : [],
    classASecretGlobs: Array.isArray(pol.classASecretGlobs) ? pol.classASecretGlobs : [],
    allowPathGlobs: Array.isArray(pol.allowPathGlobs) ? pol.allowPathGlobs : [],
    internalDomains: Array.isArray(pol.internalDomains) ? pol.internalDomains : [],
    terms,
    allowlistHmacs,
    allowlistGlobs: Array.isArray(pol.allowlistGlobs) ? pol.allowlistGlobs : [],
    enableStage3Redaction: Boolean(pol.enableStage3Redaction),
    strictSsn: Boolean(pol.strictSsn),
    fm1StrikeCap: Number.isFinite(Number(pol.fm1StrikeCap)) ? Number(pol.fm1StrikeCap) : 2
  };
}
