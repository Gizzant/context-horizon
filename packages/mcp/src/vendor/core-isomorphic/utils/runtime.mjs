/**
 * @file src/utils/runtime.mjs
 * 100% Pure JavaScript ES module runtime utilities for Highbeam.
 *
 * Architectural Invariants (ISS-032 & ISS-022):
 * - ZERO `node:*` imports, ZERO `require()`, ZERO dynamic `import()`, ZERO `process.getBuiltinModule()`.
 * - Safe to load inside sandboxed V8 Mod isolates where `globalThis.process` is `undefined`
 *   as well as all Node.js >= 20.0.0 versions (`20.0.0` through `24.x`).
 * - Provides pure-JS cross-platform POSIX/Win32 path manipulation (`joinPath`, `dirnamePath`,
 *   `basenamePath`, `isAbsolutePath`, `resolvePath`, `relativePath`, `normalizeSlashes`) and
 *   pure-JS deterministic hashing (`fnv1aHex`, FIPS 180-4 `sha256Hex`).
 * - Tier-2 Node CLI entrypoints register a Node I/O adapter via `registerNodeIo(...)` (from
 *   `src/utils/nodeIo.mjs`), enabling Windows-safe atomic disk writes (`writeTextAtomic`,
 *   `writeJsonAtomic`) with `'utf8'`, `fsyncSync`, 5x bounded `EPERM`/`EBUSY`/`EACCES` rename
 *   retries, and guaranteed `.tmp` unlink cleanup on error.
 */

let registeredNodeIo = null;

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Registers (or clears when `null`) the Tier-2 Node.js host I/O provider.
 * Never called in sandboxed V8 Mod isolates where persistence uses `$.store`.
 *
 * @param {object | null} ioProvider
 * @returns {object | null}
 */
export function registerNodeIo(ioProvider) {
  registeredNodeIo = ioProvider || null;
  return registeredNodeIo;
}

/**
 * Resolves the active I/O provider from `options.io` or the registered Tier-2 provider.
 *
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function getNodeIo(options = {}) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'io')) {
    return options.io || null;
  }
  return registeredNodeIo;
}

/**
 * Detects whether the host environment uses Windows path conventions.
 * Safe when `globalThis.process` is `undefined`.
 *
 * @param {string} [samplePath='']
 * @returns {boolean}
 */
function isWindowsEnv(samplePath = '') {
  if (/^[A-Za-z]:[\\/]/.test(samplePath) || samplePath.includes('\\')) {
    return true;
  }
  return globalThis.process?.platform === 'win32';
}

/**
 * Normalizes all backslashes to forward slashes.
 *
 * @param {string} [rawPath='']
 * @returns {string}
 */
export function normalizeSlashes(rawPath = '') {
  return String(rawPath ?? '').replace(/\\/g, '/');
}

/**
 * Checks whether a path is absolute on POSIX (`/foo`) or Windows (`C:/foo`, `C:\foo`, `\\server\share`).
 *
 * @param {string} [rawPath='']
 * @returns {boolean}
 */
export function isAbsolutePath(rawPath = '') {
  const str = String(rawPath ?? '');
  return /^(?:\/|[A-Za-z]:[\\/]|[\\/]{2})/.test(str);
}

/**
 * Internal pure-JS path normalizer handling `.` and `..` across POSIX and Windows roots.
 *
 * @param {string} rawPosix
 * @param {boolean} useWinSep
 * @returns {string}
 */
function normalizeInternal(rawPosix, useWinSep) {
  const sep = useWinSep ? '\\' : '/';
  if (!rawPosix) return '.';

  let root = '';
  let rest = rawPosix;

  const uncMatch = rawPosix.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  const driveMatch = !uncMatch ? rawPosix.match(/^([A-Za-z]:)(?:\/(.*))?$/) : null;

  if (uncMatch) {
    root = `//${uncMatch[1]}/${uncMatch[2]}/`;
    rest = uncMatch[3] || '';
  } else if (driveMatch) {
    const hasSlash = rawPosix.length > 2 && rawPosix[2] === '/';
    root = hasSlash ? `${driveMatch[1]}/` : driveMatch[1];
    rest = driveMatch[2] || '';
  } else if (rawPosix.startsWith('/')) {
    root = '/';
    rest = rawPosix.replace(/^\/+/, '');
  }

  const isAbs = root === '/' || root.endsWith('/');
  const rawParts = rest.split('/');
  const resolved = [];

  for (const part of rawParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else if (!isAbs) {
        resolved.push('..');
      }
    } else {
      resolved.push(part);
    }
  }

  const joined = resolved.join('/');
  let result = '';
  if (root) {
    if (root.endsWith('/')) {
      result = joined ? `${root}${joined}` : root;
    } else {
      result = joined ? `${root}/${joined}` : `${root}.`;
    }
  } else {
    result = joined || '.';
  }

  return useWinSep ? result.replace(/\//g, sep) : result;
}

/**
 * Pure-JS cross-platform `path.join` implementation.
 *
 * @param {...string} parts
 * @returns {string}
 */
export function joinPath(...parts) {
  const valid = [];
  let winHint = globalThis.process?.platform === 'win32';
  for (const p of parts) {
    if (p === undefined || p === null) continue;
    const s = String(p);
    if (!s) continue;
    if (/^[A-Za-z]:[\\/]/.test(s) || s.includes('\\')) {
      winHint = true;
    }
    valid.push(normalizeSlashes(s));
  }
  if (valid.length === 0) return '.';

  let combined = valid[0];
  for (let i = 1; i < valid.length; i++) {
    const seg = valid[i].replace(/^\/+/, '');
    if (!seg) continue;
    combined = combined.endsWith('/') ? `${combined}${seg}` : `${combined}/${seg}`;
  }
  return normalizeInternal(combined, winHint);
}

/**
 * Resolves the active working directory safely without throwing in V8 isolates.
 *
 * @param {object} [options={}]
 * @returns {string}
 */
export function getCwd(options = {}) {
  if (typeof options?.cwd === 'string' && options.cwd.trim()) {
    return options.cwd.trim();
  }
  const io = getNodeIo(options);
  if (typeof io?.cwd === 'function') {
    const c = io.cwd();
    if (c) return c;
  }
  if (typeof globalThis.process?.cwd === 'function') {
    try {
      return globalThis.process.cwd();
    } catch {
      return '.';
    }
  }
  return '.';
}

/**
 * Resolves the user home directory safely when available.
 *
 * @param {object} [options={}]
 * @returns {string}
 */
export function getHomeDir(options = {}) {
  if (typeof options?.homeDir === 'string' && options.homeDir.trim()) {
    return options.homeDir.trim();
  }
  const io = getNodeIo(options);
  if (typeof io?.os?.homedir === 'function') {
    try {
      return io.os.homedir() || '';
    } catch {
      return '';
    }
  }
  const env = globalThis.process?.env;
  if (env) {
    return env.HOME || env.USERPROFILE || '';
  }
  return '';
}

/**
 * Pure-JS cross-platform `path.resolve` implementation.
 *
 * @param {...string} parts
 * @returns {string}
 */
export function resolvePath(...parts) {
  let resolvedPosix = '';
  let hitAbs = false;
  let winHint = globalThis.process?.platform === 'win32';

  for (let i = parts.length - 1; i >= 0; i--) {
    const raw = parts[i];
    if (raw === undefined || raw === null || raw === '') continue;
    const s = String(raw);
    if (/^[A-Za-z]:[\\/]/.test(s) || s.includes('\\')) {
      winHint = true;
    }
    const norm = normalizeSlashes(s);
    resolvedPosix = resolvedPosix ? `${norm}/${resolvedPosix}` : norm;
    if (isAbsolutePath(s)) {
      hitAbs = true;
      break;
    }
  }

  if (!hitAbs) {
    const cwd = getCwd();
    if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\')) {
      winHint = true;
    }
    const normCwd = normalizeSlashes(cwd);
    resolvedPosix = resolvedPosix ? `${normCwd}/${resolvedPosix}` : normCwd;
  }

  return normalizeInternal(resolvedPosix, winHint);
}

/**
 * Pure-JS cross-platform `path.dirname` implementation.
 *
 * @param {string} [targetPath='']
 * @returns {string}
 */
export function dirnamePath(targetPath = '') {
  const raw = String(targetPath ?? '');
  if (!raw) return '.';
  const win = isWindowsEnv(raw);
  const sep = win ? '\\' : '/';
  const norm = normalizeSlashes(raw).replace(/\/+$/, '');

  if (!norm) {
    return raw.startsWith('/') || raw.startsWith('\\') ? sep : '.';
  }
  if (/^[A-Za-z]:$/.test(norm)) {
    return `${norm}${sep}`;
  }

  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash === -1) return '.';
  if (lastSlash === 0) return sep;

  const parent = norm.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}${sep}`;
  }
  return win ? parent.replace(/\//g, sep) : parent;
}

/**
 * Pure-JS cross-platform `path.basename` implementation.
 *
 * @param {string} [targetPath='']
 * @param {string} [ext='']
 * @returns {string}
 */
export function basenamePath(targetPath = '', ext = '') {
  const norm = normalizeSlashes(String(targetPath ?? '')).replace(/\/+$/, '');
  if (!norm) return '';
  const idx = norm.lastIndexOf('/');
  const base = idx === -1 ? norm : norm.slice(idx + 1);
  if (ext && base.endsWith(ext)) {
    return base.slice(0, base.length - ext.length);
  }
  return base;
}

/**
 * Pure-JS cross-platform `path.relative` implementation.
 *
 * @param {string} [from='']
 * @param {string} [to='']
 * @returns {string}
 */
export function relativePath(from = '', to = '') {
  const win = isWindowsEnv(from) || isWindowsEnv(to);
  const sep = win ? '\\' : '/';
  const absFrom = normalizeSlashes(resolvePath(from)).replace(/\/+$/, '');
  const absTo = normalizeSlashes(resolvePath(to)).replace(/\/+$/, '');

  const cmpFrom = win ? absFrom.toLowerCase() : absFrom;
  const cmpTo = win ? absTo.toLowerCase() : absTo;
  if (cmpFrom === cmpTo) return '';

  const fromDrive = cmpFrom.match(/^[a-z]:/)?.[0] || '';
  const toDrive = cmpTo.match(/^[a-z]:/)?.[0] || '';
  if (fromDrive !== toDrive) {
    return win ? absTo.replace(/\//g, sep) : absTo;
  }

  const fromParts = absFrom.replace(/^[A-Za-z]:\/?|^\/+/, '').split('/').filter(Boolean);
  const toParts = absTo.replace(/^[A-Za-z]:\/?|^\/+/, '').split('/').filter(Boolean);
  const cmpFromParts = win ? fromParts.map((s) => s.toLowerCase()) : fromParts;
  const cmpToParts = win ? toParts.map((s) => s.toLowerCase()) : toParts;

  let common = 0;
  while (
    common < cmpFromParts.length &&
    common < cmpToParts.length &&
    cmpFromParts[common] === cmpToParts[common]
  ) {
    common += 1;
  }

  const upMoves = new Array(fromParts.length - common).fill('..');
  const downMoves = toParts.slice(common);
  return [...upMoves, ...downMoves].join(sep);
}

/**
 * Pure-JS `file://` URL to filesystem path converter.
 *
 * @param {string} [fileUrl='']
 * @param {object} [options={}]
 * @returns {string | null}
 */
export function fileUrlToPathPure(fileUrl = '', options = {}) {
  const io = getNodeIo(options);
  if (typeof io?.url?.fileURLToPath === 'function') {
    try {
      return io.url.fileURLToPath(fileUrl);
    } catch {
      return null;
    }
  }
  const str = String(fileUrl || '');
  if (!str.startsWith('file://')) return null;
  try {
    let pathname = decodeURIComponent(str.slice('file://'.length));
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1).replace(/\//g, '\\');
    }
    return pathname;
  } catch {
    return null;
  }
}

/**
 * Pure-JS path namespace object providing drop-in `join`, `dirname`, `basename`,
 * `isAbsolute`, `resolve`, and `relative` methods in every environment.
 */
export const path = Object.freeze({
  join: joinPath,
  dirname: dirnamePath,
  basename: basenamePath,
  isAbsolute: isAbsolutePath,
  resolve: resolvePath,
  relative: relativePath
});

/**
 * Fast deterministic 32-bit FNV-1a hex digest (pure JS).
 *
 * @param {string} [input='']
 * @returns {string}
 */
export function fnv1aHex(input = '') {
  let h = 0x811c9dc5;
  const s = String(input ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

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

/**
 * Encodes a UTF-16 JS string into UTF-8 bytes without requiring Node `Buffer`.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
function encodeUtf8Bytes(str) {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(str);
  }
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Computes an exact FIPS 180-4 SHA-256 hex digest in pure JavaScript (with optional acceleration
 * when a Tier-2 Node `crypto` adapter is registered).
 *
 * @param {string} [content='']
 * @param {object} [options={}]
 * @returns {string}
 */
export function sha256Hex(content = '', options = {}) {
  const str = String(content ?? '');
  const io = getNodeIo(options);
  if (typeof io?.crypto?.createHash === 'function') {
    return io.crypto.createHash('sha256').update(str, 'utf8').digest('hex');
  }

  const msg = encodeUtf8Bytes(str);
  const bitLenHi = Math.floor((msg.length * 8) / 0x100000000);
  const bitLenLo = (msg.length * 8) >>> 0;
  const padLen = ((msg.length + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, bitLenHi, false);
  view.setUint32(padLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

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

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Checks whether a file exists via the registered Tier-2 Node `fs` provider.
 * Returns `false` cleanly in pure V8 Mod isolates.
 *
 * @param {string} targetPath
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function fileExists(targetPath, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod || !targetPath) return false;
  try {
    return Boolean(fsMod.existsSync(targetPath));
  } catch {
    return false;
  }
}

/**
 * Safely returns the byte size of a file on disk via the registered Tier-2 Node `fs` provider.
 * Returns `0` cleanly in pure V8 Mod isolates or when the file does not exist (`ISS-024`).
 *
 * @param {string} targetPath
 * @param {object} [options={}]
 * @returns {number}
 */
export function getFileByteSizeSafe(targetPath, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod || typeof fsMod.statSync !== 'function' || !targetPath) return 0;
  try {
    if (!fsMod.existsSync(targetPath)) return 0;
    const st = fsMod.statSync(targetPath);
    return st && st.isFile?.() !== false && Number(st.size) > 0 ? Number(st.size) : 0;
  } catch {
    return 0;
  }
}

/**
 * Safely returns the modification timestamp (`mtimeMs`) of a file on disk via the registered
 * Tier-2 Node `fs` provider. Returns `0` cleanly in pure V8 Mod isolates or when missing.
 *
 * @param {string} targetPath
 * @param {object} [options={}]
 * @returns {number}
 */
export function getFileMtimeMsSafe(targetPath, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod || typeof fsMod.statSync !== 'function' || !targetPath) return 0;
  try {
    if (!fsMod.existsSync(targetPath)) return 0;
    const st = fsMod.statSync(targetPath);
    return st && st.isFile?.() !== false && Number(st.mtimeMs) > 0 ? Number(st.mtimeMs) : 0;
  } catch {
    return 0;
  }
}

/**
 * Safely lists filenames inside a directory via the registered Tier-2 Node `fs` provider.
 * Returns `[]` cleanly in pure V8 Mod isolates or when the directory does not exist.
 *
 * @param {string} dirPath
 * @param {object} [options={}]
 * @returns {string[]}
 */
export function readdirSafe(dirPath, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod || typeof fsMod.readdirSync !== 'function' || !dirPath) return [];
  try {
    if (!fsMod.existsSync(dirPath)) return [];
    const entries = fsMod.readdirSync(dirPath);
    return Array.isArray(entries) ? entries.map((e) => String(e)) : [];
  } catch {
    return [];
  }
}

/**
 * Deletes a file safely if it exists.
 *
 * @param {string} targetPath
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function unlinkSafe(targetPath, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod) return false;
  try {
    if (fsMod.existsSync(targetPath)) {
      fsMod.unlinkSync(targetPath);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely reads UTF-8 text from disk via the registered Node `fs` provider.
 *
 * @param {string} targetPath
 * @param {string | null} [fallback=null]
 * @param {object} [options={}]
 * @returns {string | null}
 */
export function readTextSafe(targetPath, fallback = null, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod || !targetPath) return fallback;
  try {
    if (!fsMod.existsSync(targetPath)) return fallback;
    return fsMod.readFileSync(targetPath, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Atomically writes UTF-8 text to disk (`ISS-022`):
 * - Uses `${targetPath}.tmp.${pid}.${Date.now()}.${rand}`
 * - Explicit `'utf8'` encoding + `fs.fsyncSync(fd)` before `closeSync`
 * - 5x bounded retry on Windows `EPERM` / `EBUSY` / `EACCES` lock contention
 * - Guaranteed `unlinkSync(tempPath)` cleanup on any write/rename failure
 *
 * @param {string} targetPath
 * @param {string} content
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function writeTextAtomic(targetPath, content, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod || !targetPath) return false;

  const pid = globalThis.process?.pid || 0;
  const rand = Math.random().toString(36).slice(2, 8);
  const tempPath = `${targetPath}.tmp.${pid}.${Date.now()}.${rand}`;

  try {
    const dir = dirnamePath(targetPath);
    if (dir && dir !== '.' && !fsMod.existsSync(dir)) {
      fsMod.mkdirSync(dir, { recursive: true });
    }

    if (typeof fsMod.openSync === 'function' && typeof fsMod.fsyncSync === 'function') {
      const fd = fsMod.openSync(tempPath, 'w');
      try {
        fsMod.writeFileSync(fd, String(content ?? ''), 'utf8');
        fsMod.fsyncSync(fd);
      } finally {
        try {
          fsMod.closeSync(fd);
        } catch {
          // Ignore close error
        }
      }
    } else {
      fsMod.writeFileSync(tempPath, String(content ?? ''), 'utf8');
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fsMod.renameSync(tempPath, targetPath);
        return true;
      } catch (err) {
        if (!RETRYABLE_RENAME_CODES.has(err?.code) || attempt === 4) {
          throw err;
        }
        try {
          if (typeof SharedArrayBuffer === 'function' && typeof Atomics?.wait === 'function') {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 4);
          }
        } catch {
          // Ignore if SharedArrayBuffer is unavailable
        }
      }
    }
    return true;
  } catch {
    try {
      if (fsMod.existsSync(tempPath)) {
        fsMod.unlinkSync(tempPath);
      }
    } catch {
      // Ignore temp cleanup error
    }
    return false;
  }
}

/**
 * Atomically writes a JSON payload to disk via `writeTextAtomic`.
 *
 * @param {string} targetPath
 * @param {unknown} data
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function writeJsonAtomic(targetPath, data, options = {}) {
  try {
    const serialized = JSON.stringify(data, null, 2);
    return writeTextAtomic(targetPath, serialized, options);
  } catch {
    return false;
  }
}

/**
 * Safely reads and parses a JSON file from disk.
 *
 * @param {string} targetPath
 * @param {any} [fallback=null]
 * @param {object} [options={}]
 * @returns {any}
 */
export function readJsonSafe(targetPath, fallback = null, options = {}) {
  const raw = readTextSafe(targetPath, null, options);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Safely appends a JSONL record to an append-only file using `'utf8'`.
 *
 * @param {string} targetPath
 * @param {object} record
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function appendJsonlSafe(targetPath, record, options = {}) {
  const fsMod = getNodeIo(options)?.fs;
  if (!fsMod || !targetPath) return false;
  try {
    const dir = dirnamePath(targetPath);
    if (dir && dir !== '.' && !fsMod.existsSync(dir)) {
      fsMod.mkdirSync(dir, { recursive: true });
    }
    fsMod.appendFileSync(targetPath, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export const MAX_RUNTIME_DIAGNOSTIC_ENTRIES = 50;

const inMemoryDiagnosticsRing = [];

/**
 * Redacts the user home directory from diagnostic messages in pure JavaScript.
 *
 * @param {string} text
 * @param {object} [options={}]
 * @returns {string}
 */
function redactDiagnosticHomePath(text, options = {}) {
  const raw = String(text ?? '');
  const home = getHomeDir(options);
  if (!home) return raw;
  const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const winHome = home.replace(/\//g, '\\');
  const posixHome = home.replace(/\\/g, '/');
  let out = raw;
  if (winHome) {
    out = out.replace(new RegExp(escapeRx(winHome), 'gi'), '~');
  }
  if (posixHome && posixHome !== winHome) {
    out = out.replace(new RegExp(escapeRx(posixHome), 'gi'), '~');
  }
  return out;
}

/**
 * Resolves `<cwd>/.claude/cache/ah_diagnostics.jsonl` (or `options.diagnosticsPath`).
 *
 * @param {object} [options={}]
 * @returns {string}
 */
export function getDiagnosticsFilePath(options = {}) {
  if (typeof options?.diagnosticsPath === 'string' && options.diagnosticsPath.trim()) {
    return options.diagnosticsPath.trim();
  }
  const cwd = getCwd(options);
  return joinPath(cwd, '.claude', 'cache', 'ah_diagnostics.jsonl');
}

/**
 * Records a structured non-fatal runtime diagnostic into the bounded 50-entry in-memory ring
 * buffer and (when Tier-2 disk I/O is active AND an explicit `cwd` or `diagnosticsPath` is
 * supplied) atomically maintains a bounded 50-line JSONL ring buffer at
 * `<cwd>/.claude/cache/ah_diagnostics.jsonl`. Never writes to `stdout` (`ISS-065`).
 *
 * @param {string} source
 * @param {string} operation
 * @param {any} err
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function recordRuntimeDiagnostic(source, operation, err, options = {}) {
  try {
    const maxEntries = Math.max(1, Number(options?.maxEntries || MAX_RUNTIME_DIAGNOSTIC_ENTRIES));
    const rawMsg =
      typeof err === 'string'
        ? err
        : err && typeof err.message === 'string'
          ? err.message
          : String(err ?? 'unknown error');
    const redactedMsg = redactDiagnosticHomePath(rawMsg, options).slice(0, 300);

    const entry = {
      timestamp:
        typeof options?.timestamp === 'string'
          ? options.timestamp
          : new Date(options?.nowMs ?? Date.now()).toISOString(),
      source: String(source || 'unknown'),
      operation: String(operation || 'unknown'),
      name: String(err?.name || 'Error').slice(0, 80),
      message: redactedMsg
    };

    inMemoryDiagnosticsRing.push(entry);
    if (inMemoryDiagnosticsRing.length > MAX_RUNTIME_DIAGNOSTIC_ENTRIES) {
      inMemoryDiagnosticsRing.splice(
        0,
        inMemoryDiagnosticsRing.length - MAX_RUNTIME_DIAGNOSTIC_ENTRIES
      );
    }

    const explicitDiagPath =
      typeof options?.diagnosticsPath === 'string' && options.diagnosticsPath.trim()
        ? options.diagnosticsPath.trim()
        : typeof options?.cwd === 'string' && options.cwd.trim() && options.cwd.trim() !== '.'
          ? joinPath(options.cwd.trim(), '.claude', 'cache', 'ah_diagnostics.jsonl')
          : null;

    const fsMod = getNodeIo(options)?.fs;
    if (fsMod && explicitDiagPath && options?.persistDisk !== false) {
      const existingRaw = readTextSafe(explicitDiagPath, '', options) || '';
      const lines = existingRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      lines.push(JSON.stringify(entry));
      const bounded = lines.length > maxEntries ? lines.slice(lines.length - maxEntries) : lines;
      writeTextAtomic(explicitDiagPath, `${bounded.join('\n')}\n`, options);
    }

    return entry;
  } catch {
    return null;
  }
}

/**
 * Reads bounded structured runtime diagnostics from `<cwd>/.claude/cache/ah_diagnostics.jsonl`
 * when Tier-2 disk I/O is available, or from the pure-JS in-memory ring buffer in V8 Mod isolates (`ISS-065`).
 *
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
export function readRuntimeDiagnostics(options = {}) {
  const maxEntries = Math.max(1, Number(options?.maxEntries || MAX_RUNTIME_DIAGNOSTIC_ENTRIES));
  const fsMod = getNodeIo(options)?.fs;

  if (!fsMod) {
    return inMemoryDiagnosticsRing.slice(-maxEntries);
  }

  const targetPath = getDiagnosticsFilePath(options);
  const raw = readTextSafe(targetPath, null, options);
  const diskEntries = [];
  if (raw) {
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          diskEntries.push({
            ...parsed,
            message: redactDiagnosticHomePath(parsed.message || '', options).slice(0, 300)
          });
        }
      } catch {
        // Ignore malformed diagnostic line
      }
    }
  }

  if (options?.includeMemory) {
    const combined = [...diskEntries, ...inMemoryDiagnosticsRing];
    return combined.slice(-maxEntries);
  }

  return diskEntries.slice(-maxEntries);
}

/**
 * Returns a snapshot of the bounded in-memory runtime diagnostics ring buffer.
 *
 * @param {number} [maxEntries=MAX_RUNTIME_DIAGNOSTIC_ENTRIES]
 * @returns {Array<object>}
 */
export function getInMemoryRuntimeDiagnostics(maxEntries = MAX_RUNTIME_DIAGNOSTIC_ENTRIES) {
  return inMemoryDiagnosticsRing.slice(-Math.max(1, Number(maxEntries || MAX_RUNTIME_DIAGNOSTIC_ENTRIES)));
}

/**
 * Clears the in-memory runtime diagnostics ring buffer (for deterministic unit testing).
 */
export function clearInMemoryRuntimeDiagnostics() {
  inMemoryDiagnosticsRing.length = 0;
}
