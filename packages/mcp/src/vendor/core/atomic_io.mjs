import fs from 'node:fs';
import path from 'node:path';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_RENAME_ATTEMPTS = 5;

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // synchronous spin fallback when SharedArrayBuffer is unavailable
    }
  }
}

/**
 * Writes `content` to `targetPath` atomically via a PID/timestamp/random temp file,
 * `fsyncSync`, and bounded 5x Windows `EPERM`/`EBUSY`/`EACCES` rename retry.
 *
 * Invariants:
 *  - NEVER calls `fs.unlinkSync(targetPath)` prior to `fs.renameSync` (zero ENOENT gap).
 *  - NEVER falls back to non-atomic in-place `fs.writeFileSync(targetPath, ...)`.
 *  - Always cleans up `tempPath` if write or rename fails before rethrowing.
 */
export function atomicWriteFileSync(targetPath, content, options = {}) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new TypeError('atomicWriteFileSync requires a non-empty string targetPath');
  }

  const opts = typeof options === 'string' ? { encoding: options } : (options || {});
  const encoding = opts.encoding || 'utf8';
  const fsMod = opts.fsModule || fs;
  const maxAttempts = Number.isInteger(opts.maxRetries) && opts.maxRetries > 0
    ? opts.maxRetries
    : MAX_RENAME_ATTEMPTS;

  const resolvedTarget = path.resolve(targetPath);
  const parentDir = path.dirname(resolvedTarget);
  const mkdirOpts = opts.dirMode !== undefined
    ? { recursive: true, mode: opts.dirMode }
    : { recursive: true };
  fsMod.mkdirSync(parentDir, mkdirOpts);

  const rand = Math.random().toString(36).slice(2, 8);
  const tempPath = `${resolvedTarget}.tmp.${process.pid}.${Date.now()}.${rand}`;
  const buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content ?? ''), encoding);

  let fd = null;
  try {
    fd = opts.mode !== undefined
      ? fsMod.openSync(tempPath, 'w', opts.mode)
      : fsMod.openSync(tempPath, 'w');

    let offset = 0;
    while (offset < buffer.length) {
      const written = fsMod.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error(`Short write to temporary file: ${tempPath}`);
      }
      offset += written;
    }

    if (typeof fsMod.fsyncSync === 'function') {
      fsMod.fsyncSync(fd);
    }
    fsMod.closeSync(fd);
    fd = null;

    let lastRenameErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fsMod.renameSync(tempPath, resolvedTarget);
        lastRenameErr = null;
        break;
      } catch (err) {
        lastRenameErr = err;
        if (RETRYABLE_RENAME_CODES.has(err?.code) && attempt < maxAttempts) {
          sleepSync(15 * attempt);
          continue;
        }
        throw err;
      }
    }

    if (lastRenameErr) {
      throw lastRenameErr;
    }

    return resolvedTarget;
  } catch (err) {
    if (fd !== null) {
      try { fsMod.closeSync(fd); } catch {}
    }
    try {
      if (fsMod.existsSync(tempPath)) {
        fsMod.unlinkSync(tempPath);
      }
    } catch {}
    throw err;
  }
}

/**
 * Serializes `data` as formatted JSON and writes it atomically via `atomicWriteFileSync`.
 */
export function atomicWriteJsonSync(targetPath, data, options = {}) {
  const opts = options || {};
  const indent = opts.indent !== undefined ? opts.indent : 2;
  const trailingNewline = opts.trailingNewline !== false;
  const serialized = JSON.stringify(data, null, indent) + (trailingNewline ? '\n' : '');
  return atomicWriteFileSync(targetPath, serialized, opts);
}

export default {
  atomicWriteFileSync,
  atomicWriteJsonSync
};
