#!/usr/bin/env node
/**
 * @file src/core/doc_indexer.mjs
 * Zero-Token Structural Document & Log Indexer (`< 20ms`, zero LLM calls).
 *
 * Exposes programmatic helpers (`resolveIndexPath`, `checkIndex`, `buildIndex`, `sliceFile`)
 * and CLI flags:
 *   - `--check <file> [--cwd <dir>]` -> exits `0` (`FRESH`), `1` (`STALE`), or `2` (`MISSING`)
 *   - `--build <file> [--cwd <dir>]` -> writes cached `.index.md` under `.agents/cache/indices/`
 *   - `--slice <file> <start_line> <end_line>` -> prints 1-indexed line-numbered output
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './atomic_io.mjs';
import {
  isForbiddenSkuPath,
  compareIndexFreshness,
  buildStructuralIndexMarkdown,
  formatSlicedLines
} from '../core-isomorphic/guards/docIndexCore.mjs';

export { isForbiddenSkuPath, compareIndexFreshness, buildStructuralIndexMarkdown, formatSlicedLines };

/**
 * Computes canonical LF-normalized SHA-256 hex digest of text content.
 *
 * @param {string} rawText
 * @returns {string}
 */
export function computeFileContentSha256(rawText = '') {
  const normalized = String(rawText ?? '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Resolves the gitignored `.agents/cache/indices/<slug>_<hash>.index.md` target path
 * so indexing never dirties `git status` alongside workspace source files.
 * Callers may pass `options.indexPath` when indexing an already-gitignored temp/cache file.
 *
 * @param {string} filePath
 * @param {object} [options={}]
 * @param {string} [options.cwd]
 * @param {string} [options.indexPath]
 * @returns {string}
 */
export function resolveIndexPath(filePath, options = {}) {
  if (typeof options.indexPath === 'string' && options.indexPath.trim()) {
    return path.resolve(options.indexPath.trim());
  }
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const absFile = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseCwd, filePath);
  const relRaw = path.relative(baseCwd, absFile).replace(/\\/g, '/');
  const isInsideWorkspace = !relRaw.startsWith('..') && !path.isAbsolute(relRaw);

  // If the file itself already lives inside a gitignored cache/tmp folder, allow adjacent `.index.md`
  if (
    isInsideWorkspace &&
    /^(?:\.agents\/(?:tmp|cache|telemetry)|\.claude\/cache)\//i.test(relRaw)
  ) {
    return `${absFile}.index.md`;
  }

  const keyBasis = isInsideWorkspace ? relRaw : absFile.replace(/\\/g, '/');
  const pathHash = crypto.createHash('sha256').update(keyBasis, 'utf8').digest('hex').slice(0, 12);
  const safeSlug = (isInsideWorkspace ? relRaw : path.basename(absFile))
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-72);
  return path.join(baseCwd, '.agents', 'cache', 'indices', `${safeSlug}_${pathHash}.index.md`);
}

function isBlockedTargetPath(absFile, baseCwd) {
  const rel = path.relative(baseCwd, absFile).replace(/\\/g, '/');
  return isForbiddenSkuPath(absFile) || isForbiddenSkuPath(rel);
}

/**
 * Checks whether `<file>`'s structural index is `FRESH` (`0`), `STALE` (`1`), or `MISSING` (`2`).
 *
 * @param {string} filePath
 * @param {object} [options={}]
 * @returns {{ code: 0 | 1 | 2, status: 'FRESH' | 'STALE' | 'MISSING' | 'SKIPPED', indexPath: string, sha256: string | null }}
 */
export function checkIndex(filePath, options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const absFile = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseCwd, filePath);
  const indexPath = resolveIndexPath(absFile, options);

  if (isBlockedTargetPath(absFile, baseCwd)) {
    return { code: 2, status: 'SKIPPED', indexPath, sha256: null };
  }
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    return { code: 2, status: 'MISSING', indexPath, sha256: null };
  }

  const rawText = fs.readFileSync(absFile, 'utf8');
  const liveSha = computeFileContentSha256(rawText);
  if (!fs.existsSync(indexPath)) {
    return { code: 2, status: 'MISSING', indexPath, sha256: liveSha };
  }
  const indexMd = fs.readFileSync(indexPath, 'utf8');
  const cmp = compareIndexFreshness(liveSha, indexMd);
  return {
    code: cmp.code,
    status: cmp.status,
    indexPath,
    sha256: liveSha
  };
}

/**
 * Builds or refreshes the zero-token `.index.md` structural map for `<file>`.
 *
 * @param {string} filePath
 * @param {object} [options={}]
 * @returns {{
 *   ok: boolean,
 *   skipped: boolean,
 *   reason?: string,
 *   refreshed?: boolean,
 *   indexPath: string,
 *   relIndexPath: string,
 *   sha256: string | null,
 *   totalLines: number,
 *   spanCount: number,
 *   usedFallback: boolean,
 *   indexTokens: number,
 *   markdown: string
 * }}
 */
export function buildIndex(filePath, options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const absFile = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseCwd, filePath);
  const indexPath = resolveIndexPath(absFile, options);
  const relIndexPath = path.relative(baseCwd, indexPath).replace(/\\/g, '/');

  if (isBlockedTargetPath(absFile, baseCwd)) {
    return {
      ok: false,
      skipped: true,
      reason: 'SKU boundary: isolated directory excluded from ctxtop indexing',
      indexPath,
      relIndexPath,
      sha256: null,
      totalLines: 0,
      spanCount: 0,
      usedFallback: false,
      indexTokens: 0,
      markdown: ''
    };
  }

  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    return {
      ok: false,
      skipped: true,
      reason: `Target file not found: ${absFile}`,
      indexPath,
      relIndexPath,
      sha256: null,
      totalLines: 0,
      spanCount: 0,
      usedFallback: false,
      indexTokens: 0,
      markdown: ''
    };
  }

  const rawText = fs.readFileSync(absFile, 'utf8');
  const liveSha = computeFileContentSha256(rawText);

  if (!options.force && fs.existsSync(indexPath)) {
    try {
      const existingMd = fs.readFileSync(indexPath, 'utf8');
      const cmp = compareIndexFreshness(liveSha, existingMd);
      if (cmp.code === 0) {
        const lineCount = rawText.length === 0 ? 0 : rawText.replace(/\r\n/g, '\n').split('\n').length;
        return {
          ok: true,
          skipped: false,
          refreshed: false,
          indexPath,
          relIndexPath,
          sha256: liveSha,
          totalLines: lineCount,
          spanCount: Math.max(0, existingMd.split('\n').filter((l) => l.startsWith('| L')).length),
          usedFallback: existingMd.includes('| Unstructured Span L'),
          indexTokens: Math.max(1, Math.ceil(existingMd.length / 4)),
          markdown: existingMd
        };
      }
    } catch {
      // Rebuild below
    }
  }

  const relDisplay = path.relative(baseCwd, absFile).replace(/\\/g, '/');
  const displayPath = !relDisplay.startsWith('..') && !path.isAbsolute(relDisplay)
    ? relDisplay
    : path.basename(absFile);

  const built = buildStructuralIndexMarkdown({
    filePath: absFile,
    displayPath,
    rawText,
    sha256: liveSha
  });

  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  atomicWriteFileSync(indexPath, built.markdown);

  return {
    ok: true,
    skipped: false,
    refreshed: true,
    indexPath,
    relIndexPath,
    sha256: built.sha256,
    totalLines: built.totalLines,
    spanCount: built.spanCount,
    usedFallback: built.usedFallback,
    indexTokens: built.indexTokens,
    markdown: built.markdown
  };
}

/**
 * Slices `<file>` between 1-indexed `startLine` and `endLine` inclusive across CRLF/LF.
 *
 * @param {string} filePath
 * @param {number} startLine
 * @param {number} endLine
 * @param {object} [options={}]
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, text: string, startLine: number, endLine: number, totalLines: number }}
 */
export function sliceFile(filePath, startLine, endLine, options = {}) {
  const baseCwd = path.resolve(options.cwd || process.cwd());
  const absFile = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseCwd, filePath);
  if (isBlockedTargetPath(absFile, baseCwd)) {
    return {
      ok: false,
      skipped: true,
      reason: 'SKU boundary: isolated directory excluded from ctxtop slicing',
      text: '',
      startLine: 0,
      endLine: 0,
      totalLines: 0
    };
  }
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    return {
      ok: false,
      reason: `File not found: ${absFile}`,
      text: '',
      startLine: 0,
      endLine: 0,
      totalLines: 0
    };
  }
  const rawText = fs.readFileSync(absFile, 'utf8');
  const sliced = formatSlicedLines(rawText, startLine, endLine);
  return {
    ok: true,
    ...sliced
  };
}

/**
 * CLI runner for `node src/core/doc_indexer.mjs <--check|--build|--slice> ...`.
 *
 * @param {string[]} [args=[]]
 * @returns {{ exitCode: number, output: string }}
 */
export function runDocIndexerCli(args = process.argv.slice(2)) {
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx !== -1 && args[cwdIdx + 1] ? path.resolve(args[cwdIdx + 1]) : process.cwd();
  const outIdx = args.indexOf('--index-path');
  const indexPath = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : undefined;
  const opts = { cwd, ...(indexPath ? { indexPath } : {}) };

  const checkIdx = args.indexOf('--check');
  if (checkIdx !== -1 && args[checkIdx + 1]) {
    const res = checkIndex(args[checkIdx + 1], opts);
    return {
      exitCode: res.code,
      output: `${res.status} (${res.indexPath})`
    };
  }

  const buildIdx = args.indexOf('--build');
  if (buildIdx !== -1 && args[buildIdx + 1]) {
    const res = buildIndex(args[buildIdx + 1], opts);
    if (!res.ok) {
      return {
        exitCode: res.skipped ? 0 : 1,
        output: res.reason || 'Skipped'
      };
    }
    return {
      exitCode: 0,
      output: `${res.indexPath} (${res.totalLines} lines, ${res.spanCount} spans)`
    };
  }

  const sliceIdx = args.indexOf('--slice');
  if (sliceIdx !== -1 && args[sliceIdx + 1]) {
    const target = args[sliceIdx + 1];
    const start = Number(args[sliceIdx + 2] || 1);
    const end = Number(args[sliceIdx + 3] || start + 149);
    const res = sliceFile(target, start, end, opts);
    if (!res.ok) {
      return { exitCode: 1, output: res.reason || 'Slice failed' };
    }
    return { exitCode: 0, output: res.text };
  }

  return {
    exitCode: 1,
    output: 'Usage: doc_indexer.mjs <--check <file> | --build <file> | --slice <file> <start_line> <end_line>> [--cwd <dir>]'
  };
}

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const res = runDocIndexerCli();
  if (res.output) process.stdout.write(`${res.output}\n`);
  process.exit(res.exitCode);
}
