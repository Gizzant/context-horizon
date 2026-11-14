/**
 * @file src/core-isomorphic/airlock/hmacTwin.mjs
 * Pure-JS (Mod Law 4 compliant, zero `node:*` imports) RFC 2104 HMAC-SHA256,
 * CRC-8, and Write-Only Co-Reference Placeholder generator/detector.
 */

import { sha256HexPure } from '../ui/pdfReceiptGenerator.mjs';

const TEXT_ENCODER = new TextEncoder();

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function toUtf8Bytes(input) {
  if (input instanceof Uint8Array) return input;
  return TEXT_ENCODER.encode(String(input ?? ''));
}

/**
 * Pure-V8 FIPS 180-4 SHA-256 returning a 32-byte Uint8Array for arbitrary binary inputs.
 * @param {string | Uint8Array} input
 * @returns {Uint8Array}
 */
export function sha256BytesPure(input) {
  const bytes = toUtf8Bytes(input);
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export { sha256HexPure };

/**
 * Pure-JS RFC 2104 HMAC-SHA256 returning 64-char lowercase hex.
 * @param {string | Uint8Array} key
 * @param {string | Uint8Array} message
 * @returns {string}
 */
export function hmacSha256HexPure(key, message) {
  let keyBytes = toUtf8Bytes(key);
  if (keyBytes.length > 64) {
    keyBytes = sha256BytesPure(keyBytes);
  }
  const paddedKey = new Uint8Array(64);
  paddedKey.set(keyBytes);

  const msgBytes = toUtf8Bytes(message);
  const innerBuf = new Uint8Array(64 + msgBytes.length);
  const outerBuf = new Uint8Array(64 + 32);

  for (let i = 0; i < 64; i++) {
    innerBuf[i] = paddedKey[i] ^ 0x36;
    outerBuf[i] = paddedKey[i] ^ 0x5c;
  }
  innerBuf.set(msgBytes, 64);

  const innerDigest = sha256BytesPure(innerBuf);
  outerBuf.set(innerDigest, 64);
  return bytesToHex(sha256BytesPure(outerBuf));
}

/**
 * Computes an 8-bit CRC (polynomial 0x07) formatted as 2 lowercase hex digits.
 * @param {string} str
 * @returns {string}
 */
export function crc8Hex(str = '') {
  const bytes = toUtf8Bytes(str);
  let crc = 0x00;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc.toString(16).padStart(2, '0');
}

export const SYNTHETIC_PLACEHOLDER_TEST_RE =
  /\b(?:persona_[0-9a-f]{8,16}@synthetic\.test|host-[0-9a-f]{8,16}\.synthetic\.internal|SYNTH_[A-Z0-9_]+_[0-9a-f]{8,16}_[0-9a-f]{2}|CODENAME_[0-9a-f]{8,16})\b/;

export const SYNTHETIC_PLACEHOLDER_RE =
  /\b(?:persona_[0-9a-f]{8,16}@synthetic\.test|host-[0-9a-f]{8,16}\.synthetic\.internal|SYNTH_[A-Z0-9_]+_[0-9a-f]{8,16}_[0-9a-f]{2}|CODENAME_[0-9a-f]{8,16})\b/g;

/**
 * Generates a deterministic Write-Only Co-Reference Placeholder for a detected secret/entity.
 * Uses keyed ephemeral HMAC-SHA256 plus CRC-8 so identical entities share a co-reference token
 * within a session without keeping any reversible lookup map.
 *
 * @param {string} category
 * @param {string} rawValue
 * @param {string} [sessionKey='ephemeral-default-key']
 * @returns {string}
 */
export function deriveWriteOnlyPlaceholder(
  category,
  rawValue,
  sessionKey = 'ephemeral-default-key'
) {
  const normCat = String(category || 'SECRET').toUpperCase();
  const rawStr = String(rawValue ?? '');
  const mac = hmacSha256HexPure(sessionKey, `${normCat}:${rawStr}`);
  const id12 = mac.slice(0, 12);

  if (normCat === 'EMAIL') {
    return `persona_${id12}@synthetic.test`;
  }
  if (normCat === 'HOST' || normCat === 'DOMAIN') {
    return `host-${id12}.synthetic.internal`;
  }
  if (normCat === 'DB_URI') {
    const uriMatch = rawStr.match(/^([a-zA-Z0-9+.-]+):\/\/[^:\s/'"@]+:[^@\s/'"]+@([^:/?\s]+)(.*)$/);
    if (uriMatch) {
      const scheme = uriMatch[1];
      const suffix = uriMatch[3] || '';
      const base = `SYNTH_DBPASS_${id12}`;
      const chk = crc8Hex(base);
      return `${scheme}://synth:${base}_${chk}@host-${id12}.synthetic.internal${suffix}`;
    }
  }

  const catUpper = normCat.replace(/[^A-Z0-9]/g, '_').slice(0, 16) || 'SECRET';
  const base = `SYNTH_${catUpper}_${id12}`;
  return `${base}_${crc8Hex(base)}`;
}

/**
 * Validates the CRC-8 check byte on `SYNTH_*` placeholders and syntax on reserved domains.
 * @param {string} token
 * @returns {boolean}
 */
export function verifyPlaceholderCrc8(token = '') {
  const s = String(token || '').trim();
  if (/^persona_[0-9a-f]{8,16}@synthetic\.test$/.test(s)) return true;
  if (/^host-[0-9a-f]{8,16}\.synthetic\.internal$/.test(s)) return true;
  const match = s.match(/^(SYNTH_[A-Z0-9_]+_[0-9a-f]{8,16})_([0-9a-f]{2})$/);
  if (!match) return false;
  return crc8Hex(match[1]) === match[2];
}

/**
 * Recursively finds all Write-Only Co-Reference Placeholders inside strings, arrays, or objects.
 * @param {any} value
 * @returns {string[]}
 */
export function findWriteOnlyPlaceholders(value) {
  const found = new Set();

  function walk(node) {
    if (typeof node === 'string') {
      SYNTHETIC_PLACEHOLDER_RE.lastIndex = 0;
      let m;
      while ((m = SYNTHETIC_PLACEHOLDER_RE.exec(node)) !== null) {
        found.add(m[0]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    if (node && typeof node === 'object') {
      const vals = Object.values(node);
      for (let i = 0; i < vals.length; i++) walk(vals[i]);
    }
  }

  walk(value);
  return Array.from(found);
}

/**
 * Returns `true` if any string leaf inside `value` contains a Write-Only Co-Reference Placeholder.
 * @param {any} value
 * @returns {boolean}
 */
export function containsWriteOnlyPlaceholder(value) {
  let detected = false;

  function walk(node) {
    if (detected) return;
    if (typeof node === 'string') {
      if (SYNTHETIC_PLACEHOLDER_TEST_RE.test(node)) {
        detected = true;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && !detected; i++) walk(node[i]);
      return;
    }
    if (node && typeof node === 'object') {
      const vals = Object.values(node);
      for (let i = 0; i < vals.length && !detected; i++) walk(vals[i]);
    }
  }

  walk(value);
  return detected;
}
