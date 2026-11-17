/**
 * @file src/core/code_fold_lite.mjs
 * Lightweight, zero-heavy-dependency AST signature folder, tombstone collapser,
 * and unified post-edit line diff computer (`foldCodeToSignatureStub`,
 * `collapseDeadErrorToTombstone`, `computeCompactLineDiff`).
 *
 * Extracted from `src/core/pruner.mjs` so hook entrypoints do not transitively
 * load `parser.mjs` / `classifier.mjs` / `node:sqlite` on cold startup.
 */

import path from 'node:path';

export const SIGNATURE_LINE_RE =
  /^\s*(?:export\s+|import\s+|async\s+function\s+|function\s+|class\s+|interface\s+|type\s+\w+\s*=|const\s+\w+\s*=\s*(?:async\s*)?\(|def\s+\w+|class\s+\w+|pub\s+(?:fn|struct|enum|trait)|fn\s+\w+|struct\s+\w+|CREATE\s+TABLE)/;

/**
 * Folds raw source code or file read output into a compact AST-like signature stub
 * with original line numbers preserved.
 *
 * @param {string} rawContent
 * @param {string} [targetPath='file']
 * @returns {{ condensed: string, savedChars: number, wasFolded: boolean }}
 */
export function foldCodeToSignatureStub(rawContent, targetPath = 'file') {
  const text = String(rawContent || '');
  const lines = text.split(/\r?\n/);
  if (lines.length <= 24 || text.length <= 1000) {
    return { condensed: text, savedChars: 0, wasFolded: false };
  }

  const kept = [];
  let skippedRun = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    // Strip optional `123: ` prefix from read_file outputs before matching
    const cleanLine = line.replace(/^\s*\d+\s*[:|]\s*/, '');
    if (i < 3 || i >= lines.length - 2 || SIGNATURE_LINE_RE.test(cleanLine)) {
      if (skippedRun > 0) {
        kept.push(`  /* ... [condensed ${skippedRun} implementation lines] ... */`);
        skippedRun = 0;
      }
      kept.push(`${lineNum}: ${cleanLine.slice(0, 140)}`);
    } else {
      skippedRun++;
    }
  }
  if (skippedRun > 0) {
    kept.push(`  /* ... [condensed ${skippedRun} implementation lines] ... */`);
  }

  const header = `[AST Signature Stub — Condensed Stale Read of ${path.basename(String(targetPath || 'file'))} (${lines.length} lines)]`;
  const condensed = `${header}\n${kept.join('\n')}`;
  const savedChars = Math.max(0, text.length - condensed.length);
  return {
    condensed: savedChars > 200 ? condensed : text,
    savedChars: savedChars > 200 ? savedChars : 0,
    wasFolded: savedChars > 200
  };
}

/**
 * Collapses a resolved Dead Error stack trace into a 1-line tombstone.
 *
 * @param {string} rawContent
 * @param {number} [stepIndex=0]
 * @param {string} [target='Command']
 * @returns {{ condensed: string, savedChars: number, wasCollapsed: boolean }}
 */
export function collapseDeadErrorToTombstone(rawContent, stepIndex = 0, target = 'Command') {
  const text = String(rawContent || '');
  if (text.length <= 400) {
    return { condensed: text, savedChars: 0, wasCollapsed: false };
  }
  const firstMeaningfulLine =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('Created At:') && !l.startsWith('Completed At:')) ||
    'Error output';
  const savedTokensEst = Math.round(text.length / 4);
  const tombstone = `[Resolved Error at Turn #${stepIndex} (${target}): "${firstMeaningfulLine.slice(0, 120)}" — pruned ~${savedTokensEst} tokens of resolved stack trace]`;
  const savedChars = Math.max(0, text.length - tombstone.length);
  return {
    condensed: tombstone,
    savedChars,
    wasCollapsed: savedChars > 100
  };
}

/**
 * Computes a compact unified delta diff + exported signature index when an agent re-reads
 * a file that was modified since its previous unclipped read in the same session.
 *
 * @param {string} prevContent
 * @param {string} nextContent
 * @param {string} [targetPath='file']
 * @param {number} [contextLines=3]
 */
export function computeCompactLineDiff(prevContent = '', nextContent = '', targetPath = 'file', contextLines = 3) {
  const prev = String(prevContent ?? '');
  const next = String(nextContent ?? '');
  if (!prev || !next || prev === next || next.length > 256 * 1024) {
    return { diffText: next, savedChars: 0, savedTokens: 0, changedLines: 0, wasDiffed: false };
  }

  const oldLines = prev.split(/\r?\n/);
  const newLines = next.split(/\r?\n/);

  let prefixLen = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChangedEnd = oldLines.length - suffixLen;
  const newChangedEnd = newLines.length - suffixLen;

  const ctxBeforeStart = Math.max(0, prefixLen - contextLines);
  const oldCtxAfterEnd = Math.min(oldLines.length, oldChangedEnd + contextLines);
  const newCtxAfterEnd = Math.min(newLines.length, newChangedEnd + contextLines);

  const hunkLines = [];
  hunkLines.push(`--- a/${targetPath}`);
  hunkLines.push(`+++ b/${targetPath}`);
  hunkLines.push(
    `@@ -${ctxBeforeStart + 1},${Math.max(1, oldCtxAfterEnd - ctxBeforeStart)} +${ctxBeforeStart + 1},${Math.max(1, newCtxAfterEnd - ctxBeforeStart)} @@`
  );

  for (let i = ctxBeforeStart; i < prefixLen; i++) {
    hunkLines.push(` ${oldLines[i]}`);
  }
  for (let i = prefixLen; i < oldChangedEnd; i++) {
    hunkLines.push(`-${oldLines[i]}`);
  }
  for (let i = prefixLen; i < newChangedEnd; i++) {
    hunkLines.push(`+${newLines[i]}`);
  }
  for (let i = newChangedEnd; i < newCtxAfterEnd; i++) {
    hunkLines.push(` ${newLines[i]}`);
  }

  const folded = foldCodeToSignatureStub(next, targetPath);
  const sigAppendix = folded.wasFolded ? `\n\n[Updated File Signature Index]\n${folded.condensed}` : '';
  const diffText = `[Delta Read since prior snapshot of ${targetPath} (${oldLines.length} -> ${newLines.length} lines)]\n${hunkLines.join('\n')}${sigAppendix}`;
  const savedChars = next.length - diffText.length;

  if (savedChars <= 160 || diffText.length > next.length * 0.75) {
    return { diffText: next, savedChars: 0, savedTokens: 0, changedLines: 0, wasDiffed: false };
  }

  const changedLines = oldChangedEnd - prefixLen + (newChangedEnd - prefixLen);
  return {
    diffText,
    savedChars,
    savedTokens: Math.max(1, Math.round(savedChars / 4)),
    changedLines,
    wasDiffed: true
  };
}
