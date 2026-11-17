/**
 * @file src/core/pro_license.mjs
 * Highbeam Pro (`@ctxtop/pro`) — Zero-Network Offline Ed25519 License Verifier & Cross-Harness Entitlement Store.
 *
 * Uses Node.js built-in `node:crypto` Ed25519 signature verification (`CTXP1.<payloadB64Url>.<sigB64Url>`).
 * Stores verified license state at `~/.ctxtop/license.json` shared across Google Antigravity and Claude Code.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Default embedded Ed25519 public key (SPKI PEM) for Polar.sh / `@ctxtop/pro` offline license verification.
 * Can be overridden in tests or enterprise deployments via `options.publicKeyPem` or `CTXTOP_ED25519_PUBLIC_KEY_PEM`.
 */
export const DEFAULT_PRO_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAsKBx+VAPklTmfQPootRr8wzq4ZEDhEu9ImAI7Q4GMDM=',
  '-----END PUBLIC KEY-----'
].join('\n');

export const PRO_PRICING_TIERS = Object.freeze({
  free: { id: 'free', label: 'Free Core (MIT)', priceUSD: 0, billing: 'forever' },
  pro_monthly: { id: 'pro', label: 'Highbeam Pro (Monthly)', priceUSD: 15, priceRangeUSD: [12, 19], billing: 'month' },
  pro_annual: { id: 'pro', label: 'Highbeam Pro (Annual)', priceUSD: 149, effectiveMonthlyUSD: 12.42, billing: 'year' },
  pro_ltd: { id: 'ltd', label: 'Highbeam Pro (Founder Lifetime)', priceUSD: 199, cap: 200, billing: 'lifetime' },
  team: { id: 'team', label: 'Highbeam Team (Annual 5-Seat Starter + OTel)', priceUSD: 299, seats: 5, seatMonthlyUSD: 39, billing: 'year' },
  team_seat_monthly: { id: 'team', label: 'Highbeam Team FinOps (Per-Seat Monthly)', priceUSD: 39, seatMonthlyUSD: 39, billing: 'month' }
});

/**
 * Three-Tier "Self-Expensing" PLG Funnel Matrix (VC Playbook Step 5).
 */
export const PLG_TIER_MATRIX = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Free Tier (MIT Core + COACH Mode)',
    priceMonthlyUSD: 0,
    installCommand: 'npx ctxtop init',
    features: Object.freeze([
      'Simple View HUD & 4-Rank Tufte Verdict Bar',
      '40-Cell Parabolic U-Curve Context Map',
      '5m/1h Live Prompt Cache TTL Countdown',
      'SQLite FTS5 CLI & Test Output Compression (PostToolUse)',
      'Automated PreToolUse Delta-Read & AST Signature Stub Interception (GUARD-4)',
      'HOLD_COMPACT Warm Cache Warning & 32 Auditable Guards (COACH Default)'
    ])
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro Tier (Self-Expensing Solo Developer)',
    priceMonthlyUSD: 15,
    priceAnnualUSD: 149,
    priceLtdUSD: 199,
    ltdCap: 200,
    priceRangeMonthlyUSD: Object.freeze([12, 19]),
    features: Object.freeze([
      'AUTO_PILOT Hands-Free Enforcement & Horizon-Calibrated C_max Model Switch Hold',
      'Signed Corporate PDF 1.4 FinOps + GreenOps Expense Receipt (ctxtop receipt --pdf)',
      'Cross-Session Chronic Offender Memory & 30-Day Workspace Savings Ledger (#tufteBaselineStrip)',
      '14-Day Zero-Network Local Trial'
    ])
  }),
  team: Object.freeze({
    id: 'team',
    name: 'Team / Enterprise Tier (Zero-Cloud FinOps)',
    starterAnnualUSD: 299,
    starterSeats: 5,
    pricePerSeatMonthlyUSD: 39,
    features: Object.freeze([
      'Shared .agents/rules/ Primacy-Band Governance',
      'Sanitized Cross-Developer Bloat Analytics (/api/export/sanitized)',
      'Repo-Wide MCP Lazy-Loading Enforcement',
      'BYO-Grafana OpenTelemetry & Prometheus Alerting Pack (ctxtop team-pack)'
    ])
  })
});

export function resolveLicenseFilePath(options = {}) {
  if (typeof options.licensePath === 'string' && options.licensePath.trim()) {
    return path.resolve(options.licensePath.trim());
  }
  const homeDir = options.homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(homeDir, '.ctxtop', 'license.json');
}

/**
 * Generates an Ed25519 keypair (PEM) for signing offline `CTXP1` Pro license keys.
 */
export function generateProKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Signs a Pro license payload using an Ed25519 private key PEM and returns a `CTXP1.<payload>.<sig>` string.
 *
 * @param {object} payload
 * @param {string} privateKeyPem
 * @returns {string}
 */
export function signProLicensePayload(payload = {}, privateKeyPem = '') {
  if (!privateKeyPem) {
    throw new Error('signProLicensePayload requires an Ed25519 privateKeyPem');
  }
  const nowIso = new Date().toISOString();
  const normalizedPayload = {
    v: 1,
    tier: payload.tier || 'pro',
    email: payload.email || 'developer@local',
    seats: Number(payload.seats || 1),
    issuedAt: payload.issuedAt || nowIso,
    expiresAt: payload.expiresAt || null,
    source: payload.source || 'polar.sh',
    features: Array.isArray(payload.features)
      ? payload.features
      : ['auto_pilot_locks', 'cross_harness_scope_locks', 'corporate_expense_receipts', 'otel_team_bundle']
  };
  const payloadB64 = Buffer.from(JSON.stringify(normalizedPayload), 'utf8').toString('base64url');
  const sigBuf = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKeyPem);
  const sigB64 = sigBuf.toString('base64url');
  return `CTXP1.${payloadB64}.${sigB64}`;
}

/**
 * Strictly verifies a `CTXP1.<payloadB64Url>.<sigB64Url>` license key offline via `node:crypto` Ed25519.
 *
 * @param {string} licenseKey
 * @param {object} [options={}]
 * @returns {{ valid: boolean, reason: string | null, payload: object | null }}
 */
export function verifyProLicenseKey(licenseKey = '', options = {}) {
  const raw = String(licenseKey || '').trim();
  if (!raw) {
    return { valid: false, reason: 'EMPTY_KEY', payload: null };
  }
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'CTXP1') {
    return { valid: false, reason: 'INVALID_FORMAT', payload: null };
  }
  const [, payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) {
    return { valid: false, reason: 'MALFORMED_SEGMENTS', payload: null };
  }

  const publicKeyPem =
    options.publicKeyPem ||
    process.env.CTXTOP_ED25519_PUBLIC_KEY_PEM ||
    DEFAULT_PRO_PUBLIC_KEY_PEM;

  try {
    const isVerified = crypto.verify(
      null,
      Buffer.from(payloadB64, 'utf8'),
      publicKeyPem,
      Buffer.from(sigB64, 'base64url')
    );
    if (!isVerified) {
      return { valid: false, reason: 'INVALID_SIGNATURE', payload: null };
    }
  } catch (err) {
    return { valid: false, reason: `CRYPTO_VERIFY_ERROR: ${err.message}`, payload: null };
  }

  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'INVALID_PAYLOAD_JSON', payload: null };
  }

  const nowMs = Number(options.nowMs || Date.now());
  if (payload.expiresAt) {
    const expMs = Date.parse(payload.expiresAt);
    if (Number.isFinite(expMs) && nowMs > expMs) {
      return { valid: false, reason: 'LICENSE_EXPIRED', payload };
    }
  }

  return { valid: true, reason: null, payload };
}

/**
 * Activates and persists a verified `CTXP1` license key into `~/.ctxtop/license.json`.
 */
export function activateProLicense(licenseKey = '', options = {}) {
  const check = verifyProLicenseKey(licenseKey, options);
  if (!check.valid) {
    return { ok: false, ...check, licensePath: resolveLicenseFilePath(options) };
  }
  const licensePath = resolveLicenseFilePath(options);
  fs.mkdirSync(path.dirname(licensePath), { recursive: true });
  const record = {
    version: 1,
    licenseKey: String(licenseKey).trim(),
    activatedAt: new Date(options.nowMs || Date.now()).toISOString(),
    payload: check.payload
  };
  fs.writeFileSync(licensePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return {
    ok: true,
    valid: true,
    tier: check.payload.tier || 'pro',
    payload: check.payload,
    licensePath
  };
}

/**
 * Starts a 14-day zero-network local trial stored in `~/.ctxtop/license.json`.
 */
export function activateLocalTrial(options = {}) {
  const licensePath = resolveLicenseFilePath(options);
  const nowMs = Number(options.nowMs || Date.now());

  if (fs.existsSync(licensePath)) {
    try {
      const stored = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
      if (stored?.licenseKey) {
        const verified = verifyProLicenseKey(stored.licenseKey, options);
        if (verified.valid) {
          return {
            ok: true,
            tier: verified.payload.tier || 'pro',
            alreadyLicensed: true,
            expiresAt: verified.payload.expiresAt || null,
            licensePath
          };
        }
      }
      if (stored?.trial && stored?.expiresAt && !options.forceResetTrial) {
        const prevExpMs = Date.parse(stored.expiresAt);
        if (Number.isFinite(prevExpMs) && nowMs > prevExpMs) {
          return {
            ok: false,
            alreadyUsed: true,
            trialExpired: true,
            reason: 'TRIAL_ALREADY_EXPIRED',
            expiresAt: stored.expiresAt,
            licensePath
          };
        }
        if (Number.isFinite(prevExpMs) && nowMs <= prevExpMs) {
          return {
            ok: true,
            tier: 'trial',
            alreadyActive: true,
            expiresAt: stored.expiresAt,
            licensePath
          };
        }
      }
    } catch (_err) {
      void _err;
    }
  }

  const expiresAt = new Date(nowMs + 14 * 86400 * 1000).toISOString();
  fs.mkdirSync(path.dirname(licensePath), { recursive: true });
  const record = {
    version: 1,
    trial: true,
    activatedAt: new Date(nowMs).toISOString(),
    expiresAt,
    payload: {
      v: 1,
      tier: 'trial',
      email: 'trial@local',
      seats: 1,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt,
      source: 'local_trial'
    }
  };
  fs.writeFileSync(licensePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return {
    ok: true,
    tier: 'trial',
    expiresAt,
    licensePath
  };
}

export function deactivateProLicense(options = {}) {
  const licensePath = resolveLicenseFilePath(options);
  const existed = fs.existsSync(licensePath);
  if (existed) {
    try {
      fs.unlinkSync(licensePath);
    } catch (_err) {
      void _err;
    }
  }
  return { ok: true, removed: existed, licensePath };
}

/**
 * Evaluates current Pro entitlement across both Antigravity and Claude Code.
 * Supports automatic dev/test bypass unless `options.strict === true`.
 */
export function getProEntitlementStatus(options = {}) {
  const licensePath = resolveLicenseFilePath(options);
  const nowMs = Number(options.nowMs || Date.now());
  const isDevOrTest =
    !options.strict &&
    Boolean(
      process.env.CTXTOP_PRO_DEV === '1' ||
        process.env.NODE_ENV === 'test' ||
        process.env.NODE_TEST_CONTEXT ||
        process.execArgv?.includes('--test')
    );

  if (isDevOrTest && !options.licensePath) {
    return {
      entitled: true,
      tier: 'pro_dev_bypass',
      source: 'dev_or_test_bypass',
      isDevOrTestBypass: true,
      licensePath,
      pricing: PRO_PRICING_TIERS
    };
  }

  if (fs.existsSync(licensePath)) {
    try {
      const stored = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
      if (stored.licenseKey) {
        const verified = verifyProLicenseKey(stored.licenseKey, options);
        if (verified.valid) {
          return {
            entitled: true,
            tier: verified.payload.tier || 'pro',
            source: 'ed25519_license',
            email: verified.payload.email || null,
            expiresAt: verified.payload.expiresAt || null,
            licensePath,
            pricing: PRO_PRICING_TIERS
          };
        }
        return {
          entitled: false,
          tier: 'free',
          source: 'invalid_or_expired_license',
          reason: verified.reason,
          licensePath,
          pricing: PRO_PRICING_TIERS
        };
      }
      if (stored.trial && stored.expiresAt) {
        const expMs = Date.parse(stored.expiresAt);
        if (Number.isFinite(expMs) && nowMs <= expMs) {
          return {
            entitled: true,
            tier: 'trial',
            source: 'local_trial',
            expiresAt: stored.expiresAt,
            daysRemaining: Math.max(1, Math.ceil((expMs - nowMs) / 86400000)),
            licensePath,
            pricing: PRO_PRICING_TIERS
          };
        }
        if (Number.isFinite(expMs) && nowMs > expMs && !isDevOrTest) {
          return {
            entitled: false,
            tier: 'free',
            source: 'expired_trial',
            trialExpired: true,
            trialActivatedAt: stored.activatedAt || null,
            expiresAt: stored.expiresAt,
            licensePath,
            pricing: PRO_PRICING_TIERS
          };
        }
      }
    } catch (_err) {
      void _err;
    }
  }

  if (isDevOrTest) {
    return {
      entitled: true,
      tier: 'pro_dev_bypass',
      source: 'dev_or_test_bypass',
      isDevOrTestBypass: true,
      licensePath,
      pricing: PRO_PRICING_TIERS
    };
  }

  return {
    entitled: false,
    tier: 'free',
    source: 'free_core',
    licensePath,
    pricing: PRO_PRICING_TIERS
  };
}

/**
 * Evaluates whether a specific commercial Pro or Team feature is permitted.
 * Preserves automatic dev/test bypass unless `options.strict === true`.
 *
 * @param {string} [featureId='pro_feature']
 * @param {object} [options={}]
 */
export function requireProFeature(featureId = 'pro_feature', options = {}) {
  const status = getProEntitlementStatus(options);
  const needsTeamTier = featureId === 'team_finops_pack';
  const isDevOrTest =
    !options.strict &&
    Boolean(
      process.env.CTXTOP_PRO_DEV === '1' ||
        process.env.NODE_ENV === 'test' ||
        process.env.NODE_TEST_CONTEXT ||
        process.execArgv?.includes('--test')
    );

  const allowed = needsTeamTier
    ? Boolean(
        isDevOrTest ||
          (status.entitled &&
            (status.tier === 'team' ||
              status.tier === 'trial' ||
              status.tier === 'pro_dev_bypass' ||
              status.tier === 'ltd'))
      )
    : Boolean(status.entitled);

  return {
    allowed,
    featureId,
    entitled: status.entitled,
    tier: status.tier,
    source: status.source,
    status,
    upgradeHint: needsTeamTier
      ? 'Requires Highbeam Team ($299/yr for 5 seats — Commercial License: packages/pro/LICENSE-COMMERCIAL.md) or an active 14-day trial (`npx ctxtop license trial`).'
      : 'Requires Highbeam Pro ($15/mo · $149/yr · $199 LTD — Commercial License: packages/pro/LICENSE-COMMERCIAL.md) or an active 14-day trial (`npx ctxtop license trial`).'
  };
}

/**
 * Provisions a one-time 14-day Reverse Trial for brand-new Free users without
 * overwriting paid licenses or reviving expired trials.
 *
 * @param {object} [options={}]
 */
export function ensureReverseTrialProvisioned(options = {}) {
  const isTestEnv = Boolean(
    process.env.NODE_ENV === 'test' ||
      process.env.NODE_TEST_CONTEXT ||
      process.execArgv?.includes('--test')
  );
  if (
    isTestEnv &&
    !options.licensePath &&
    !options.homeDir &&
    !options.allowTestHomeWrite
  ) {
    return {
      ok: true,
      provisioned: false,
      steppedDownToCoach: false,
      skippedTestEnv: true,
      status: getProEntitlementStatus(options)
    };
  }

  const strictOpts = { ...options, strict: true };
  const current = getProEntitlementStatus(strictOpts);
  if (current.entitled) {
    return {
      ok: true,
      provisioned: false,
      steppedDownToCoach: false,
      status: current
    };
  }
  if (current.trialExpired || current.source === 'invalid_or_expired_license') {
    return {
      ok: false,
      provisioned: false,
      steppedDownToCoach: true,
      reason: current.trialExpired ? 'TRIAL_EXPIRED' : (current.reason || 'PRO_REQUIRED'),
      status: current
    };
  }

  const trialRes = activateLocalTrial(strictOpts);
  if (!trialRes.ok) {
    return {
      ok: false,
      provisioned: false,
      steppedDownToCoach: true,
      reason: trialRes.reason || 'PRO_REQUIRED',
      status: getProEntitlementStatus(strictOpts)
    };
  }

  return {
    ok: true,
    provisioned: true,
    steppedDownToCoach: false,
    status: getProEntitlementStatus(strictOpts)
  };
}

/**
 * Resolves effective flightMode across Antigravity and Claude Code, stepping
 * `AUTO_PILOT` down to `COACH` when Pro / Reverse Trial entitlement is absent.
 *
 * @param {string} [rawFlightMode='COACH']
 * @param {object} [options={}]
 */
export function resolveEffectiveAutoFlightMode(rawFlightMode = 'COACH', options = {}) {
  const upper = String(rawFlightMode || 'COACH').trim().toUpperCase();
  let normalized = 'COACH';
  if (upper === 'AUTO_PILOT' || upper === 'AUTOPILOT' || upper === 'AUTO' || upper === 'AUTO-PILOT') {
    normalized = 'AUTO_PILOT';
  } else if (upper === 'OFF' || upper === 'DISABLED') {
    normalized = 'OFF';
  } else if (upper === 'SILENT') {
    normalized = 'SILENT';
  }

  if (normalized === 'AUTO_PILOT') {
    const check = requireProFeature('auto_pilot_locks', options);
    if (!check.allowed) {
      return {
        effectiveFlightMode: 'COACH',
        steppedDown: true,
        proStatus: check.status
      };
    }
    return {
      effectiveFlightMode: 'AUTO_PILOT',
      steppedDown: false,
      proStatus: check.status
    };
  }

  return {
    effectiveFlightMode: normalized,
    steppedDown: false,
    proStatus: null
  };
}
