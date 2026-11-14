/**
 * Node-layer Airlock Policy, Signed Bundle, Session Key, Org Salt, and Strike State Loader.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { resolveAirlockConfig } from '../../core-isomorphic/airlock/index.mjs';

function ensurePrivateDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function writePrivateFileAtomic(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // chmod may be a no-op on some Windows ACL setups
  }
}

function sanitizeKeySegment(val, fallback = 'default') {
  const cleaned = String(val || fallback).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  return cleaned || fallback;
}

export function resolveAirlockStateDir(options = {}) {
  if (options.stateDir) return path.resolve(String(options.stateDir));
  if (process.env.AH_AIRLOCK_STATE_DIR) return path.resolve(process.env.AH_AIRLOCK_STATE_DIR);
  const homeBase = process.env.AH_HOME || process.env.HORIZON_HOME || os.homedir();
  return path.join(homeBase, '.highbeam', 'airlock');
}

export function resolveAirlockPolicyPath(options = {}) {
  if (options.policyPath) return path.resolve(String(options.policyPath));
  if (process.env.AH_AIRLOCK_POLICY_PATH) return path.resolve(process.env.AH_AIRLOCK_POLICY_PATH);
  if (options.cwd) {
    const wsPolicy = path.join(path.resolve(String(options.cwd)), '.airlock', 'policy.json');
    if (fs.existsSync(wsPolicy)) return wsPolicy;
  }
  const statePolicy = path.join(resolveAirlockStateDir(options), 'policy.json');
  if (fs.existsSync(statePolicy)) return statePolicy;
  if (options.cwd) {
    return path.join(path.resolve(String(options.cwd)), '.airlock', 'policy.json');
  }
  return statePolicy;
}

function sortKeysCanonical(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysCanonical(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value).sort();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === '_signed' || k === '_signatureValid' || k === '_tampered' || k === '_signatureReason' || k === 'signature') {
        continue;
      }
      out[k] = sortKeysCanonical(value[k]);
    }
    return out;
  }
  return value;
}

export function canonicalizePolicyPayload(policy = {}) {
  return JSON.stringify(sortKeysCanonical(policy || {}));
}

/**
 * Signs an Airlock policy object using either Ed25519 (PEM private key) or HMAC-SHA256.
 * Returns `{ policy, signatureEnvelope, canonicalSha256, publicKeyPem }`.
 */
export function signAirlockPolicy(policy = {}, keyOrOptions = {}) {
  const opts = typeof keyOrOptions === 'string'
    ? { key: keyOrOptions }
    : (keyOrOptions && typeof keyOrOptions === 'object' ? keyOrOptions : {});

  const canonical = canonicalizePolicyPayload(policy);
  const canonicalSha256 = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');

  let privateKeyPem = opts.privateKeyPem || (typeof opts.key === 'string' && opts.key.includes('BEGIN') ? opts.key : '');
  let publicKeyPem = opts.publicKeyPem || '';
  const hmacKey = !privateKeyPem
    ? (opts.hmacKey || (typeof opts.key === 'string' && !opts.key.includes('BEGIN') ? opts.key : ''))
    : '';

  if (privateKeyPem) {
    const sigBuf = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
    if (!publicKeyPem) {
      publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
    }
    return {
      policy,
      canonicalSha256,
      publicKeyPem,
      signatureEnvelope: {
        v: 1,
        alg: 'Ed25519',
        canonicalSha256,
        sig: sigBuf.toString('base64'),
        signedAt: new Date().toISOString()
      }
    };
  }

  if (hmacKey) {
    const sig = crypto.createHmac('sha256', String(hmacKey)).update(canonical, 'utf8').digest('hex');
    return {
      policy,
      canonicalSha256,
      publicKeyPem: '',
      signatureEnvelope: {
        v: 1,
        alg: 'HMAC-SHA256',
        canonicalSha256,
        sig,
        signedAt: new Date().toISOString()
      }
    };
  }

  // Generate local Ed25519 keypair when no explicit signing material was supplied
  const pair = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const sigBuf = crypto.sign(null, Buffer.from(canonical, 'utf8'), pair.privateKey);
  return {
    policy,
    canonicalSha256,
    publicKeyPem: pair.publicKey,
    privateKeyPem: pair.privateKey,
    signatureEnvelope: {
      v: 1,
      alg: 'Ed25519',
      canonicalSha256,
      sig: sigBuf.toString('base64'),
      signedAt: new Date().toISOString()
    }
  };
}

export function verifyAirlockPolicySignature(policy = {}, signatureEnvelope = null, keyOrOptions = {}) {
  const envelope = typeof signatureEnvelope === 'string'
    ? (() => { try { return JSON.parse(signatureEnvelope); } catch { return null; } })()
    : signatureEnvelope;

  if (!envelope || typeof envelope !== 'object' || !envelope.sig || !envelope.alg) {
    return { valid: false, alg: null, reason: 'Missing or malformed signature envelope' };
  }

  const canonical = canonicalizePolicyPayload(policy);
  const canonicalSha256 = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  if (envelope.canonicalSha256 && envelope.canonicalSha256 !== canonicalSha256) {
    return { valid: false, alg: envelope.alg, reason: 'Policy digest mismatch (possible tampering)' };
  }

  const opts = typeof keyOrOptions === 'string'
    ? (keyOrOptions.includes('BEGIN') ? { publicKeyPem: keyOrOptions } : { hmacKey: keyOrOptions })
    : (keyOrOptions && typeof keyOrOptions === 'object' ? keyOrOptions : {});

  try {
    if (envelope.alg === 'Ed25519') {
      const pubPem = opts.publicKeyPem || opts.publicKey;
      if (!pubPem) {
        return { valid: false, alg: 'Ed25519', reason: 'No Ed25519 public key configured to verify signature' };
      }
      const ok = crypto.verify(
        null,
        Buffer.from(canonical, 'utf8'),
        pubPem,
        Buffer.from(String(envelope.sig), 'base64')
      );
      return ok
        ? { valid: true, alg: 'Ed25519', reason: 'Verified Ed25519 signature' }
        : { valid: false, alg: 'Ed25519', reason: 'Ed25519 signature verification failed' };
    }

    if (envelope.alg === 'HMAC-SHA256') {
      const hmacKey = opts.hmacKey;
      if (!hmacKey) {
        return { valid: false, alg: 'HMAC-SHA256', reason: 'No HMAC key configured to verify signature' };
      }
      const expected = crypto.createHmac('sha256', String(hmacKey)).update(canonical, 'utf8').digest('hex');
      const a = Buffer.from(String(envelope.sig).toLowerCase(), 'utf8');
      const b = Buffer.from(expected.toLowerCase(), 'utf8');
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      return ok
        ? { valid: true, alg: 'HMAC-SHA256', reason: 'Verified HMAC-SHA256 signature' }
        : { valid: false, alg: 'HMAC-SHA256', reason: 'HMAC-SHA256 signature verification failed' };
    }
  } catch (err) {
    return { valid: false, alg: envelope.alg, reason: `Verification error: ${err?.message || String(err)}` };
  }

  return { valid: false, alg: envelope.alg, reason: `Unsupported signature algorithm: ${envelope.alg}` };
}

export function loadAirlockPolicy(options = {}) {
  const policyPath = resolveAirlockPolicyPath(options);
  const sigPath = options.sigPath || `${policyPath.replace(/\.json$/i, '')}.sig`;
  const pubPath = options.publicKeyPath || `${policyPath.replace(/\.json$/i, '')}.pub`;

  let rawPolicy = {};
  let policyExists = false;
  if (fs.existsSync(policyPath)) {
    policyExists = true;
    try {
      rawPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) || {};
    } catch (err) {
      // Fail closed on corrupted policy JSON
      return {
        policy: {
          enabled: true,
          mode: 'enforce',
          failClosed: true,
          _signed: false,
          _signatureValid: false,
          _tampered: true,
          _signatureReason: `Corrupted policy JSON: ${err?.message || String(err)}`
        },
        config: resolveAirlockConfig(options.horizonConfig, {
          enabled: true,
          mode: 'enforce',
          failClosed: true,
          _signed: false,
          _signatureValid: false
        }, options.env || process.env),
        policyPath,
        policyExists: true,
        tampered: true
      };
    }
  }

  let signed = false;
  let signatureValid = false;
  let tampered = false;
  let signatureReason = 'unsigned';

  const hasSigFile = fs.existsSync(sigPath);
  const embeddedSig = rawPolicy && typeof rawPolicy.signature === 'object' ? rawPolicy.signature : null;
  if (hasSigFile || embeddedSig) {
    signed = true;
    const envelope = embeddedSig || (() => {
      try { return JSON.parse(fs.readFileSync(sigPath, 'utf8')); } catch { return null; }
    })();
    const publicKeyPem = options.publicKeyPem
      || process.env.AH_AIRLOCK_POLICY_PUBKEY
      || (fs.existsSync(pubPath) ? fs.readFileSync(pubPath, 'utf8') : '');
    const hmacKey = options.hmacKey || process.env.AH_AIRLOCK_POLICY_HMAC_KEY || '';
    const verified = verifyAirlockPolicySignature(rawPolicy, envelope, { publicKeyPem, hmacKey });
    signatureValid = verified.valid;
    signatureReason = verified.reason;
    if (!verified.valid) {
      tampered = true;
      // Fail-closed posture: signature failure refuses weakening to 'off'
      if (rawPolicy.mode === 'off' || rawPolicy.enabled === false) {
        rawPolicy.enabled = true;
        rawPolicy.mode = 'enforce';
      }
      rawPolicy.failClosed = true;
    }
  }

  const annotatedPolicy = {
    ...rawPolicy,
    _signed: signed,
    _signatureValid: signatureValid,
    _tampered: tampered,
    _signatureReason: signatureReason
  };

  const config = resolveAirlockConfig(options.horizonConfig, annotatedPolicy, options.env || process.env);

  return {
    policy: annotatedPolicy,
    config,
    policyPath,
    sigPath,
    policyExists,
    signed,
    signatureValid,
    tampered,
    signatureReason
  };
}

export function getOrCreateSessionHmacKey(sessionId = 'default', options = {}) {
  const stateDir = resolveAirlockStateDir(options);
  const safeId = sanitizeKeySegment(sessionId, 'default');
  const keyPath = path.join(stateDir, 'sessions', `${safeId}.key`);

  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) {
        return existing;
      }
    }
  } catch {
    // Regenerate on read error
  }

  const keyHex = crypto.randomBytes(32).toString('hex');
  writePrivateFileAtomic(keyPath, `${keyHex}\n`, 0o600);
  return keyHex;
}

export function getOrCreateOrgSalts(options = {}) {
  const stateDir = resolveAirlockStateDir(options);
  const saltsPath = path.join(stateDir, 'org_salts.json');

  try {
    if (fs.existsSync(saltsPath)) {
      const parsed = JSON.parse(fs.readFileSync(saltsPath, 'utf8'));
      if (parsed?.orgAuditSalt && parsed?.orgAllowlistSalt) {
        return {
          orgAuditSalt: String(parsed.orgAuditSalt),
          orgAllowlistSalt: String(parsed.orgAllowlistSalt),
          path: saltsPath
        };
      }
    }
  } catch {
    // Fall through and recreate
  }

  const salts = {
    v: 1,
    createdAt: new Date().toISOString(),
    orgAuditSalt: crypto.randomBytes(32).toString('hex'),
    orgAllowlistSalt: crypto.randomBytes(32).toString('hex')
  };
  writePrivateFileAtomic(saltsPath, JSON.stringify(salts, null, 2) + '\n', 0o600);
  return {
    orgAuditSalt: salts.orgAuditSalt,
    orgAllowlistSalt: salts.orgAllowlistSalt,
    path: saltsPath
  };
}

export function readStrikeState(sessionId = 'default', options = {}) {
  const stateDir = resolveAirlockStateDir(options);
  const safeId = sanitizeKeySegment(sessionId, 'default');
  const strikePath = path.join(stateDir, 'strikes', `${safeId}.json`);
  try {
    if (fs.existsSync(strikePath)) {
      const parsed = JSON.parse(fs.readFileSync(strikePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          strikeCount: Number(parsed.strikeCount) || 0,
          totalBlocked: Number(parsed.totalBlocked) || 0,
          lastFmCode: parsed.lastFmCode || null,
          updatedAt: parsed.updatedAt || null
        };
      }
    }
  } catch {
    // Return default clean strike state
  }
  return { strikeCount: 0, totalBlocked: 0, lastFmCode: null, updatedAt: null };
}

export function writeStrikeState(sessionId = 'default', state = {}, options = {}) {
  const stateDir = resolveAirlockStateDir(options);
  const safeId = sanitizeKeySegment(sessionId, 'default');
  const strikePath = path.join(stateDir, 'strikes', `${safeId}.json`);
  const payload = {
    strikeCount: Number(state.strikeCount) || 0,
    totalBlocked: Number(state.totalBlocked) || 0,
    lastFmCode: state.lastFmCode || null,
    updatedAt: state.updatedAt || new Date().toISOString()
  };
  writePrivateFileAtomic(strikePath, JSON.stringify(payload, null, 2) + '\n', 0o600);
  return payload;
}
