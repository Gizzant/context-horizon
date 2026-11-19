/**
 * @file packages/pro/src/encrypted_sync.mjs
 * Pro Anchor #1: Cross-Machine Zero-Knowledge Encrypted Memory & Ledger Sync.
 *
 * Encrypts the local 30-day savings ledger, episodic memory records, and promoted
 * instincts with scrypt + AES-256-GCM before leaving the developer's disk, strips
 * detected credentials beforehand, and merges bundles across machines with
 * idempotent deduplication + Last-Write-Wins (LWW) timestamps. Zero network calls.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { requireProFeature } from './_license.mjs';

export const SYNC_VAULT_FORMAT = 'highbeam-encrypted-sync/v1';
export const SYNC_VAULT_AAD = 'highbeam-sync:v1';
export const MIN_PASSPHRASE_LENGTH = 8;

const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  alg: 'scrypt',
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 32
});

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi
];

/**
 * Recursively scrubs embedded API keys, GitHub PATs, AWS keys, Bearer tokens, and PEM blocks.
 *
 * @param {*} value
 * @returns {{ data: *, redactedCount: number }}
 */
export function scrubSyncSecrets(value) {
  let redactedCount = 0;
  const walk = (node) => {
    if (typeof node === 'string') {
      let out = node;
      for (const baseRe of SECRET_PATTERNS) {
        const re = new RegExp(baseRe.source, baseRe.flags);
        out = out.replace(re, () => {
          redactedCount += 1;
          return '[REDACTED_SECRET]';
        });
      }
      return out;
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (node && typeof node === 'object') {
      const copy = {};
      for (const [k, v] of Object.entries(node)) {
        copy[k] = walk(v);
      }
      return copy;
    }
    return node;
  };
  return { data: walk(value), redactedCount };
}

function defaultMachineFingerprint() {
  const basis = `${os.hostname()}:${os.platform()}:${os.arch()}`;
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 12);
}

function writeFileAtomicSync(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (unlinkErr) {
      void unlinkErr; // Best-effort cleanup of temp file after failed rename.
    }
    throw err;
  }
}

function readJsonlSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (err) {
      void err; // Skip malformed historical JSONL lines without aborting vault sync.
    }
  }
  return rows;
}

function writeJsonlAtomicSync(filePath, records = []) {
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  writeFileAtomicSync(filePath, payload);
}

/**
 * Encrypts a sync bundle (`{ ledgerEntries, episodicRecords, instincts }`) with scrypt + AES-256-GCM.
 */
export function encryptSyncPayload(bundleObj = {}, passphrase = '', options = {}) {
  const pass = String(passphrase || '');
  if (pass.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Sync passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }

  const normalizedBundle = {
    ledgerEntries: Array.isArray(bundleObj.ledgerEntries) ? bundleObj.ledgerEntries : [],
    episodicRecords: Array.isArray(bundleObj.episodicRecords) ? bundleObj.episodicRecords : [],
    instincts: Array.isArray(bundleObj.instincts) ? bundleObj.instincts : []
  };

  const { data: scrubbedBundle, redactedCount } = scrubSyncSecrets(normalizedBundle);
  const serialized = JSON.stringify(scrubbedBundle);
  const payloadSha256 = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
  const compressed = zlib.gzipSync(Buffer.from(serialized, 'utf8'), { level: 9 });

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, DEFAULT_SCRYPT_PARAMS.keyLen, {
    N: DEFAULT_SCRYPT_PARAMS.N,
    r: DEFAULT_SCRYPT_PARAMS.r,
    p: DEFAULT_SCRYPT_PARAMS.p,
    maxmem: 64 * 1024 * 1024
  });

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(SYNC_VAULT_AAD, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    format: SYNC_VAULT_FORMAT,
    kdf: {
      alg: DEFAULT_SCRYPT_PARAMS.alg,
      N: DEFAULT_SCRYPT_PARAMS.N,
      r: DEFAULT_SCRYPT_PARAMS.r,
      p: DEFAULT_SCRYPT_PARAMS.p,
      keyLen: DEFAULT_SCRYPT_PARAMS.keyLen,
      saltB64: salt.toString('base64')
    },
    cipher: {
      alg: 'aes-256-gcm',
      ivB64: iv.toString('base64'),
      authTagB64: authTag.toString('base64')
    },
    aad: SYNC_VAULT_AAD,
    createdAt: options.createdAt || new Date().toISOString(),
    machineFingerprint: options.machineFingerprint || defaultMachineFingerprint(),
    counts: {
      ledgerEntries: scrubbedBundle.ledgerEntries.length,
      episodicRecords: scrubbedBundle.episodicRecords.length,
      instincts: scrubbedBundle.instincts.length
    },
    redactedSecretsCount: redactedCount,
    payloadSha256,
    ciphertextB64: ciphertext.toString('base64')
  };
}

/**
 * Decrypts and integrity-checks an encrypted sync envelope.
 */
export function decryptSyncPayload(envelope, passphrase = '') {
  const pass = String(passphrase || '');
  if (!pass) {
    return { ok: false, error: 'Missing sync passphrase.' };
  }
  if (!envelope || typeof envelope !== 'object' || envelope.format !== SYNC_VAULT_FORMAT) {
    return { ok: false, error: `Unsupported vault format (expected ${SYNC_VAULT_FORMAT}).` };
  }
  if (envelope.aad !== SYNC_VAULT_AAD) {
    return { ok: false, error: 'Vault AAD header mismatch.' };
  }

  try {
    const kdf = envelope.kdf || {};
    const N = Number(kdf.N);
    const r = Number(kdf.r);
    const p = Number(kdf.p);
    const keyLen = Number(kdf.keyLen);
    if (
      kdf.alg !== 'scrypt' ||
      !Number.isInteger(N) ||
      N < 16384 ||
      N > 131072 ||
      !Number.isInteger(r) ||
      r < 1 ||
      r > 16 ||
      !Number.isInteger(p) ||
      p < 1 ||
      p > 4 ||
      keyLen !== 32
    ) {
      return { ok: false, error: 'Invalid or out-of-policy KDF parameters in vault envelope.' };
    }

    const salt = Buffer.from(String(kdf.saltB64 || ''), 'base64');
    const iv = Buffer.from(String(envelope.cipher?.ivB64 || ''), 'base64');
    const authTag = Buffer.from(String(envelope.cipher?.authTagB64 || ''), 'base64');
    const ciphertext = Buffer.from(String(envelope.ciphertextB64 || ''), 'base64');

    if (salt.length < 16 || iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
      return { ok: false, error: 'Malformed cryptographic envelope buffers.' };
    }

    const key = crypto.scryptSync(pass, salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(envelope.aad, 'utf8'));
    decipher.setAuthTag(authTag);

    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const jsonBuf = zlib.gunzipSync(compressed);
    const actualSha = crypto.createHash('sha256').update(jsonBuf).digest('hex');
    const expectedSha = String(envelope.payloadSha256 || '');

    const actualBuf = Buffer.from(actualSha, 'hex');
    const expectedBuf = Buffer.from(expectedSha, 'hex');
    if (
      actualBuf.length !== 32 ||
      expectedBuf.length !== 32 ||
      !crypto.timingSafeEqual(actualBuf, expectedBuf)
    ) {
      return { ok: false, error: 'Decrypted payload SHA-256 digest mismatch.' };
    }

    const bundle = JSON.parse(jsonBuf.toString('utf8'));
    return {
      ok: true,
      bundle: {
        ledgerEntries: Array.isArray(bundle.ledgerEntries) ? bundle.ledgerEntries : [],
        episodicRecords: Array.isArray(bundle.episodicRecords) ? bundle.episodicRecords : [],
        instincts: Array.isArray(bundle.instincts) ? bundle.instincts : []
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to decrypt sync vault (wrong passphrase or tampered vault): ${err?.message || String(err)}`
    };
  }
}

/**
 * Reads public vault envelope metadata without requiring the passphrase.
 */
export function inspectSyncVault(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: `Sync vault file not found: ${filePath}` };
  }
  try {
    const env = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (env?.format !== SYNC_VAULT_FORMAT) {
      return { ok: false, error: `Unsupported vault format: ${env?.format || 'unknown'}` };
    }
    return {
      ok: true,
      format: env.format,
      createdAt: env.createdAt || null,
      machineFingerprint: env.machineFingerprint || null,
      counts: env.counts || { ledgerEntries: 0, episodicRecords: 0, instincts: 0 },
      redactedSecretsCount: Number(env.redactedSecretsCount || 0),
      payloadSha256: env.payloadSha256 || null
    };
  } catch (err) {
    return { ok: false, error: `Invalid vault JSON: ${err?.message || String(err)}` };
  }
}

function ledgerDedupKey(entry = {}) {
  if (entry.id) return String(entry.id);
  return [
    entry.timestamp ?? entry.ts ?? '',
    entry.sessionId ?? '',
    entry.category ?? entry.type ?? '',
    Number(entry.savedTokens || 0),
    entry.source ?? ''
  ].join('|');
}

function lwwRecordKey(rec = {}) {
  if (rec.id) return String(rec.id);
  return `${String(rec.sessionId || '')}::${String(rec.title || rec.directive_action || rec.rule || '')}`;
}

function recordTimestampMs(rec = {}) {
  const raw = rec.updatedAt || rec.createdAt || rec.timestamp || 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeLwwArray(localArr = [], remoteArr = []) {
  const byKey = new Map();
  let addedCount = 0;
  let updatedCount = 0;

  for (const rec of localArr) {
    byKey.set(lwwRecordKey(rec), rec);
  }
  for (const rec of remoteArr) {
    const k = lwwRecordKey(rec);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, rec);
      addedCount += 1;
    } else if (recordTimestampMs(rec) > recordTimestampMs(existing)) {
      byKey.set(k, rec);
      updatedCount += 1;
    }
  }
  return { merged: Array.from(byKey.values()), addedCount, updatedCount };
}

/**
 * Performs idempotent deduplicated + Last-Write-Wins merge of local and remote sync bundles.
 */
export function mergeSyncBundles(localBundle = {}, remoteBundle = {}) {
  const localLedger = Array.isArray(localBundle.ledgerEntries) ? localBundle.ledgerEntries : [];
  const remoteLedger = Array.isArray(remoteBundle.ledgerEntries) ? remoteBundle.ledgerEntries : [];

  const ledgerMap = new Map();
  let ledgerAdded = 0;
  for (const entry of localLedger) {
    ledgerMap.set(ledgerDedupKey(entry), entry);
  }
  for (const entry of remoteLedger) {
    const k = ledgerDedupKey(entry);
    if (!ledgerMap.has(k)) {
      ledgerMap.set(k, entry);
      ledgerAdded += 1;
    }
  }
  const mergedLedger = Array.from(ledgerMap.values()).sort((a, b) => {
    return recordTimestampMs(a) - recordTimestampMs(b);
  });

  const episodicMerge = mergeLwwArray(localBundle.episodicRecords, remoteBundle.episodicRecords);
  const instinctMerge = mergeLwwArray(localBundle.instincts, remoteBundle.instincts);

  return {
    merged: {
      ledgerEntries: mergedLedger,
      episodicRecords: episodicMerge.merged,
      instincts: instinctMerge.merged
    },
    added: {
      ledgerEntries: ledgerAdded,
      episodicRecords: episodicMerge.addedCount,
      instincts: instinctMerge.addedCount
    },
    updated: {
      episodicRecords: episodicMerge.updatedCount,
      instincts: instinctMerge.updatedCount
    },
    totals: {
      ledgerEntries: mergedLedger.length,
      episodicRecords: episodicMerge.merged.length,
      instincts: instinctMerge.merged.length
    }
  };
}

function resolveStorePaths(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const ctxDir = path.join(String(homeDir || os.homedir()), '.ctxtop');
  const syncStoreDir = path.join(ctxDir, 'sync-store');
  return {
    ledgerPath: path.resolve(options.ledgerPath || path.join(ctxDir, 'saved_quota_ledger.jsonl')),
    episodicJsonlPath: path.resolve(options.episodicJsonlPath || path.join(syncStoreDir, 'episodic_memory.jsonl')),
    instinctsJsonlPath: path.resolve(options.instinctsJsonlPath || path.join(syncStoreDir, 'instincts.jsonl'))
  };
}

/**
 * Reads local JSONL sync stores (Node 20+ compatible).
 */
export function readLocalSyncStores(options = {}) {
  const paths = resolveStorePaths(options);
  return {
    paths,
    bundle: {
      ledgerEntries: Array.isArray(options.ledgerEntries) ? options.ledgerEntries : readJsonlSafe(paths.ledgerPath),
      episodicRecords: Array.isArray(options.episodicRecords)
        ? options.episodicRecords
        : readJsonlSafe(paths.episodicJsonlPath),
      instincts: Array.isArray(options.instincts) ? options.instincts : readJsonlSafe(paths.instinctsJsonlPath)
    }
  };
}

/**
 * Atomically writes merged bundle stores back to JSONL on disk.
 */
export function writeLocalSyncStores(bundle = {}, options = {}) {
  const paths = resolveStorePaths(options);
  writeJsonlAtomicSync(paths.ledgerPath, Array.isArray(bundle.ledgerEntries) ? bundle.ledgerEntries : []);
  writeJsonlAtomicSync(paths.episodicJsonlPath, Array.isArray(bundle.episodicRecords) ? bundle.episodicRecords : []);
  writeJsonlAtomicSync(paths.instinctsJsonlPath, Array.isArray(bundle.instincts) ? bundle.instincts : []);
  return paths;
}

/**
 * Exports an encrypted sync vault to disk (Pro/LTD/Team/Trial).
 */
export function exportEncryptedSyncVault(options = {}) {
  const entitlement = requireProFeature('encrypted_memory_sync', options);
  if (!entitlement.allowed && !options.preview) {
    return { ok: false, entitlement, upgradeHint: entitlement.upgradeHint };
  }

  const passphrase = options.passphrase || process.env.HIGHBEAM_SYNC_PASSPHRASE || '';
  if (String(passphrase).length < MIN_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      error: `Sync passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters (--passphrase or HIGHBEAM_SYNC_PASSPHRASE).`,
      entitlement
    };
  }

  const outPath = path.resolve(
    options.outPath || path.join(options.cwd || process.cwd(), 'highbeam-sync.vault.json')
  );
  const { bundle } = readLocalSyncStores(options);
  const envelope = encryptSyncPayload(bundle, passphrase, options);
  const jsonText = JSON.stringify(envelope, null, 2) + '\n';
  writeFileAtomicSync(outPath, jsonText);

  return {
    ok: true,
    outPath,
    counts: envelope.counts,
    redactedSecretsCount: envelope.redactedSecretsCount,
    bytes: Buffer.byteLength(jsonText, 'utf8'),
    payloadSha256: envelope.payloadSha256,
    entitlement
  };
}

/**
 * Imports and merges an encrypted sync vault into local JSONL stores (Pro/LTD/Team/Trial).
 */
export function importEncryptedSyncVault(options = {}) {
  const entitlement = requireProFeature('encrypted_memory_sync', options);
  if (!entitlement.allowed && !options.preview) {
    return { ok: false, entitlement, upgradeHint: entitlement.upgradeHint };
  }

  const inPath = options.inPath ? path.resolve(options.inPath) : null;
  if (!inPath || !fs.existsSync(inPath)) {
    return { ok: false, error: `Sync vault file not found: ${inPath || '(unspecified)'}`, entitlement };
  }

  const passphrase = options.passphrase || process.env.HIGHBEAM_SYNC_PASSPHRASE || '';
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `Invalid vault JSON: ${err?.message || String(err)}`, entitlement };
  }

  const decrypted = decryptSyncPayload(envelope, passphrase);
  if (!decrypted.ok) {
    return { ok: false, error: decrypted.error, entitlement };
  }

  const { bundle: localBundle } = readLocalSyncStores(options);
  const mergeRes = mergeSyncBundles(localBundle, decrypted.bundle);
  const dryRun = Boolean(options.dryRun);
  if (!dryRun) {
    writeLocalSyncStores(mergeRes.merged, options);
  }

  return {
    ok: true,
    dryRun,
    inPath,
    added: mergeRes.added,
    updated: mergeRes.updated,
    totals: mergeRes.totals,
    entitlement
  };
}
