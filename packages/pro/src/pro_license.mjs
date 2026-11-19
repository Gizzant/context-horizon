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
 * Callers (tests, key-rotation checks) may pass `options.publicKeyPem`. There is deliberately NO
 * environment-variable override: a shell variable that replaces the trust root would let anyone
 * sign their own Pro license.
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
 * Three-tier feature and entitlement matrix (Free, Pro, Team).
 */
export const PLG_TIER_MATRIX = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Free Tier (MIT Core + COACH Mode)',
    priceMonthlyUSD: 0,
    installCommand: 'npx highbeam-cli init',
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
      'Signed Corporate PDF 1.4 FinOps + GreenOps Expense Receipt (highbeam receipt --pdf)',
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
      'BYO-Grafana OpenTelemetry & Prometheus Alerting Pack (highbeam team-pack)'
    ])
  })
});

export const MAX_TRIAL_DURATION_MS = 14 * 86400 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const TRIAL_DURATION_TOLERANCE_MS = 60 * 1000;

export function resolveLicenseFilePath(options = {}) {
  if (typeof options.licensePath === 'string' && options.licensePath.trim()) {
    return path.resolve(options.licensePath.trim());
  }
  const homeDir = options.homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(homeDir, '.ctxtop', 'license.json');
}

export function resolveTrialReceiptPath(options = {}) {
  if (typeof options.trialReceiptPath === 'string' && options.trialReceiptPath.trim()) {
    return path.resolve(options.trialReceiptPath.trim());
  }
  return path.join(path.dirname(resolveLicenseFilePath(options)), 'trial_receipt.json');
}

function writeJsonAtomicLocalSync(targetPath, data) {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const rand = crypto.randomBytes(4).toString('hex');
  const tempPath = `${resolved}.tmp.${process.pid}.${Date.now()}.${rand}`;
  const buf = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    let offset = 0;
    while (offset < buf.length) {
      const written = fs.writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) {
        throw new Error(`Short write to temporary file: ${tempPath}`);
      }
      offset += written;
    }
    try {
      fs.fsyncSync(fd);
    } catch (_fsyncErr) {
      // fsyncSync can return EINVAL/EROFS on virtual or temp filesystems; rename still proceeds.
      void _fsyncErr;
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, resolved);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_closeErr) {
        // Preserve original write/rename error while cleaning up fd.
        void _closeErr;
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_cleanupErr) {
      // Best-effort temp cleanup before rethrowing primary error.
      void _cleanupErr;
    }
    throw err;
  }
}

function computeTrialIntegrityMac({ activatedAt, expiresAt }, scopeDir) {
  const normalizedDir = path.resolve(scopeDir).replace(/\\/g, '/').toLowerCase();
  const keyMaterial = `${os.hostname()}|${process.platform}|${normalizedDir}|highbeam-trial-v1`;
  return crypto
    .createHmac('sha256', keyMaterial)
    .update(`v1|${activatedAt}|${expiresAt}`, 'utf8')
    .digest('hex');
}

function validateTrialRecord(record, { nowMs = Date.now(), scopeDir } = {}) {
  if (!record || typeof record !== 'object') {
    return { valid: false, expired: false, tampered: true, reason: 'INVALID_TRIAL_RECORD' };
  }
  const activatedAt = typeof record.activatedAt === 'string' ? record.activatedAt : '';
  const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : '';
  const actMs = Date.parse(activatedAt);
  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(actMs) || !Number.isFinite(expMs)) {
    return { valid: false, expired: false, tampered: true, reason: 'INVALID_TRIAL_DATES' };
  }
  if (expMs <= actMs || expMs - actMs > MAX_TRIAL_DURATION_MS + TRIAL_DURATION_TOLERANCE_MS) {
    return { valid: false, expired: false, tampered: true, reason: 'INVALID_TRIAL_DURATION' };
  }
  if (actMs > nowMs + FUTURE_CLOCK_SKEW_MS) {
    return { valid: false, expired: false, tampered: true, reason: 'INVALID_TRIAL_FUTURE_START' };
  }
  const macHex = typeof record.integrityMac === 'string' ? record.integrityMac.trim() : '';
  if (!/^[a-f0-9]{64}$/i.test(macHex)) {
    return { valid: false, expired: false, tampered: true, reason: 'MISSING_OR_INVALID_TRIAL_MAC' };
  }
  const expectedHex = computeTrialIntegrityMac({ activatedAt, expiresAt }, scopeDir);
  const a = Buffer.from(macHex.toLowerCase(), 'utf8');
  const b = Buffer.from(expectedHex.toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, expired: false, tampered: true, reason: 'TRIAL_MAC_MISMATCH' };
  }
  const expired = nowMs > expMs;
  return {
    valid: !expired,
    expired,
    tampered: false,
    reason: expired ? 'TRIAL_EXPIRED' : null,
    activatedAt,
    expiresAt,
    actMs,
    expMs
  };
}

function buildTrialLicenseRecord(activatedAt, expiresAt, integrityMac) {
  return {
    version: 1,
    trial: true,
    activatedAt,
    expiresAt,
    integrityMac,
    payload: {
      v: 1,
      tier: 'trial',
      email: 'trial@local',
      seats: 1,
      issuedAt: activatedAt,
      expiresAt,
      source: 'local_trial'
    }
  };
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
 * JSON.parse that tolerates a leading UTF-8 byte-order mark (Windows PowerShell 5.1 writes one
 * with `Set-Content -Encoding utf8`).
 * @param {string} text
 */
export function parseJsonText(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

/**
 * Starts a 14-day zero-network local trial stored in `~/.ctxtop/license.json` with a
 * persistent local receipt (`trial_receipt.json`) and HMAC integrity tag to prevent
 * trivial reset loops and timestamp tampering.
 */
export function activateLocalTrial(options = {}) {
  const licensePath = resolveLicenseFilePath(options);
  const receiptPath = resolveTrialReceiptPath(options);
  const scopeDir = path.dirname(licensePath);
  const nowMs = Number(options.nowMs || Date.now());
  const allowReset = Boolean(options.forceResetTrial && (options.licensePath || options.homeDir));

  let storedLicense = null;
  if (fs.existsSync(licensePath)) {
    try {
      storedLicense = parseJsonText(fs.readFileSync(licensePath, 'utf8'));
      if (storedLicense?.licenseKey) {
        const verified = verifyProLicenseKey(storedLicense.licenseKey, options);
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
    } catch (_err) {
      // Treat unreadable license file as absent unless a valid trial receipt remains on disk.
      void _err;
    }
  }

  if (!allowReset && fs.existsSync(receiptPath)) {
    try {
      const receipt = parseJsonText(fs.readFileSync(receiptPath, 'utf8'));
      const check = validateTrialRecord(receipt, { nowMs, scopeDir });
      if (check.tampered) {
        return {
          ok: false,
          alreadyUsed: true,
          tampered: true,
          reason: check.reason || 'INVALID_TRIAL_RECORD',
          licensePath
        };
      }
      if (check.expired) {
        return {
          ok: false,
          alreadyUsed: true,
          trialExpired: true,
          reason: 'TRIAL_ALREADY_EXPIRED',
          expiresAt: check.expiresAt,
          licensePath
        };
      }
      const hadActiveLicense = Boolean(
        storedLicense?.trial &&
          !storedLicense?.licenseKey &&
          storedLicense?.activatedAt === check.activatedAt &&
          storedLicense?.expiresAt === check.expiresAt &&
          storedLicense?.integrityMac === receipt.integrityMac
      );
      if (!hadActiveLicense) {
        writeJsonAtomicLocalSync(
          licensePath,
          buildTrialLicenseRecord(check.activatedAt, check.expiresAt, receipt.integrityMac)
        );
      }
      return {
        ok: true,
        tier: 'trial',
        alreadyActive: hadActiveLicense,
        restored: !hadActiveLicense,
        expiresAt: check.expiresAt,
        licensePath
      };
    } catch (_err) {
      // Corrupt receipt cannot grant a fresh trial; reject fail-closed.
      void _err;
      return {
        ok: false,
        alreadyUsed: true,
        tampered: true,
        reason: 'INVALID_TRIAL_RECORD',
        licensePath
      };
    }
  }

  if (!allowReset && storedLicense?.trial && storedLicense?.expiresAt) {
    const check = validateTrialRecord(storedLicense, { nowMs, scopeDir });
    if (check.tampered) {
      const prevExpMs = Date.parse(storedLicense.expiresAt);
      if (Number.isFinite(prevExpMs) && nowMs > prevExpMs) {
        return {
          ok: false,
          alreadyUsed: true,
          trialExpired: true,
          reason: 'TRIAL_ALREADY_EXPIRED',
          expiresAt: storedLicense.expiresAt,
          licensePath
        };
      }
      return {
        ok: false,
        alreadyUsed: true,
        tampered: true,
        reason: check.reason || 'INVALID_TRIAL_RECORD',
        licensePath
      };
    }
    if (check.expired) {
      writeJsonAtomicLocalSync(receiptPath, {
        version: 1,
        activatedAt: check.activatedAt,
        expiresAt: check.expiresAt,
        integrityMac: storedLicense.integrityMac
      });
      return {
        ok: false,
        alreadyUsed: true,
        trialExpired: true,
        reason: 'TRIAL_ALREADY_EXPIRED',
        expiresAt: check.expiresAt,
        licensePath
      };
    }
    writeJsonAtomicLocalSync(receiptPath, {
      version: 1,
      activatedAt: check.activatedAt,
      expiresAt: check.expiresAt,
      integrityMac: storedLicense.integrityMac
    });
    return {
      ok: true,
      tier: 'trial',
      alreadyActive: true,
      expiresAt: check.expiresAt,
      licensePath
    };
  }

  const activatedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + MAX_TRIAL_DURATION_MS).toISOString();
  const integrityMac = computeTrialIntegrityMac({ activatedAt, expiresAt }, scopeDir);
  const record = buildTrialLicenseRecord(activatedAt, expiresAt, integrityMac);
  const receipt = { version: 1, activatedAt, expiresAt, integrityMac };

  writeJsonAtomicLocalSync(licensePath, record);
  writeJsonAtomicLocalSync(receiptPath, receipt);
  return {
    ok: true,
    tier: 'trial',
    expiresAt,
    licensePath
  };
}

export function deactivateProLicense(options = {}) {
  const licensePath = resolveLicenseFilePath(options);
  const receiptPath = resolveTrialReceiptPath(options);
  const scopeDir = path.dirname(licensePath);
  const existed = fs.existsSync(licensePath);
  if (existed) {
    try {
      const stored = parseJsonText(fs.readFileSync(licensePath, 'utf8'));
      if (stored?.trial && !stored?.licenseKey && !fs.existsSync(receiptPath)) {
        const check = validateTrialRecord(stored, {
          nowMs: Number(options.nowMs || Date.now()),
          scopeDir
        });
        if (!check.tampered) {
          writeJsonAtomicLocalSync(receiptPath, {
            version: 1,
            activatedAt: check.activatedAt,
            expiresAt: check.expiresAt,
            integrityMac: stored.integrityMac
          });
        } else if (typeof stored.activatedAt === 'string' && typeof stored.expiresAt === 'string') {
          const actMs = Date.parse(stored.activatedAt);
          const expMs = Date.parse(stored.expiresAt);
          if (
            Number.isFinite(actMs) &&
            Number.isFinite(expMs) &&
            expMs > actMs &&
            expMs - actMs <= MAX_TRIAL_DURATION_MS + TRIAL_DURATION_TOLERANCE_MS
          ) {
            const mac = computeTrialIntegrityMac(
              { activatedAt: stored.activatedAt, expiresAt: stored.expiresAt },
              scopeDir
            );
            writeJsonAtomicLocalSync(receiptPath, {
              version: 1,
              activatedAt: stored.activatedAt,
              expiresAt: stored.expiresAt,
              integrityMac: mac
            });
          }
        }
      }
    } catch (_err) {
      // Best-effort trial receipt preservation before removing license.json.
      void _err;
    }
    try {
      fs.unlinkSync(licensePath);
    } catch (_err) {
      // Best-effort cleanup when unlinking license.json.
      void _err;
    }
  }
  return {
    ok: true,
    removed: existed,
    licensePath,
    trialHistoryPreserved: fs.existsSync(receiptPath)
  };
}

/**
 * Evaluates current Pro entitlement across both Antigravity and Claude Code.
 * Zero env-var or test-runner bypasses: requires a valid Ed25519 `CTXP1` key or valid local trial.
 */
export function getProEntitlementStatus(options = {}) {
  const licensePath = resolveLicenseFilePath(options);
  const receiptPath = resolveTrialReceiptPath(options);
  const scopeDir = path.dirname(licensePath);
  const nowMs = Number(options.nowMs || Date.now());

  if (fs.existsSync(licensePath)) {
    try {
      const stored = parseJsonText(fs.readFileSync(licensePath, 'utf8'));
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
        const check = validateTrialRecord(stored, { nowMs, scopeDir });
        if (check.tampered) {
          return {
            entitled: false,
            tier: 'free',
            source: 'tampered_trial',
            reason: check.reason,
            licensePath,
            pricing: PRO_PRICING_TIERS
          };
        }
        if (fs.existsSync(receiptPath)) {
          try {
            const receipt = parseJsonText(fs.readFileSync(receiptPath, 'utf8'));
            const rCheck = validateTrialRecord(receipt, { nowMs, scopeDir });
            if (
              !rCheck.tampered &&
              (check.expMs > rCheck.expMs || check.activatedAt !== rCheck.activatedAt)
            ) {
              return {
                entitled: false,
                tier: 'free',
                source: 'tampered_trial',
                reason: 'TRIAL_RECEIPT_MISMATCH',
                licensePath,
                pricing: PRO_PRICING_TIERS
              };
            }
          } catch (_receiptErr) {
            // Unreadable receipt falls back to license.json MAC validation above.
            void _receiptErr;
          }
        }
        if (!check.expired) {
          return {
            entitled: true,
            tier: 'trial',
            source: 'local_trial',
            expiresAt: check.expiresAt,
            daysRemaining: Math.max(1, Math.ceil((check.expMs - nowMs) / 86400000)),
            licensePath,
            pricing: PRO_PRICING_TIERS
          };
        }
        return {
          entitled: false,
          tier: 'free',
          source: 'expired_trial',
          trialExpired: true,
          trialActivatedAt: stored.activatedAt || null,
          expiresAt: check.expiresAt,
          licensePath,
          pricing: PRO_PRICING_TIERS
        };
      }
    } catch (_err) {
      // Unreadable or corrupt license.json resolves cleanly to free_core.
      void _err;
    }
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
 *
 * @param {string} [featureId='pro_feature']
 * @param {object} [options={}]
 */
export function requireProFeature(featureId = 'pro_feature', options = {}) {
  const status = getProEntitlementStatus(options);
  const needsTeamTier = featureId === 'team_finops_pack';

  const allowed = needsTeamTier
    ? Boolean(
        status.entitled &&
          (status.tier === 'team' ||
            status.tier === 'trial')
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
      ? 'Requires Highbeam Team ($299/yr for 5 seats — Commercial License: packages/pro/LICENSE-COMMERCIAL.md) or an active 14-day trial (`npx highbeam-cli license trial`).'
      : 'Requires Highbeam Pro ($149/yr · $199 Founder Lifetime — Commercial License: packages/pro/LICENSE-COMMERCIAL.md) or an active 14-day trial (`npx highbeam-cli license trial`).'
  };
}

/**
 * Provisions a one-time 14-day Reverse Trial for brand-new Free users without
 * overwriting paid licenses or reviving expired trials.
 *
 * @param {object} [options={}]
 */
export function ensureReverseTrialProvisioned(options = {}) {
  if (options.skipAutoProvision === true) {
    return {
      ok: true,
      provisioned: false,
      steppedDownToCoach: false,
      skippedAutoProvision: true,
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
  if (current.trialExpired || current.source === 'invalid_or_expired_license' || current.source === 'tampered_trial') {
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
