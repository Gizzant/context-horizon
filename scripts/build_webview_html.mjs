#!/usr/bin/env node
/**
 * @file scripts/build_webview_html.mjs
 * Deterministic partial-to-bundle compiler for the Antigravity WebView HUD (`src/webview/horizon_panel.html`).
 *
 * Concatenates ordered partials under `src/webview/partials/` (`< 2,500` lines each)
 * with normalized LF endings to guarantee 100% byte-for-byte deterministic builds.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const PARTIALS_DIR = path.join(ROOT, 'src', 'webview', 'partials');
export const TARGET_HTML = path.join(ROOT, 'src', 'webview', 'horizon_panel.html');

export const REQUIRED_DOM_IDS = Object.freeze([
  'argonSimpleSurface',
  'argonAdvancedSurface',
  'btnCompactPrimary',
  'compactInstruction',
  'compactReclaim'
]);

/**
 * Compiles or verifies `src/webview/partials/*` into `src/webview/horizon_panel.html`.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.checkOnly=false] - Throw if assembled bytes differ from TARGET_HTML.
 * @param {boolean} [options.silent=false] - Suppress console logs.
 * @param {string} [options.partialsDir=PARTIALS_DIR]
 * @param {string} [options.targetHtml=TARGET_HTML]
 */
export function buildWebviewHtml({
  checkOnly = false,
  silent = false,
  partialsDir = PARTIALS_DIR,
  targetHtml = TARGET_HTML
} = {}) {
  if (!fs.existsSync(partialsDir)) {
    throw new Error(`WebView partials directory missing: ${partialsDir}`);
  }
  const files = fs
    .readdirSync(partialsDir)
    .filter((f) => /\.part$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No WebView partial files found in: ${partialsDir}`);
  }

  let maxPartialLines = 0;
  const chunks = files.map((fileName) => {
    const raw = fs.readFileSync(path.join(partialsDir, fileName), 'utf8').replace(/\r\n/g, '\n');
    const lineCount = raw.split('\n').length;
    if (lineCount > maxPartialLines) maxPartialLines = lineCount;
    return raw;
  });

  const assembled = chunks.join('\n');
  for (const reqId of REQUIRED_DOM_IDS) {
    if (!assembled.includes(`id="${reqId}"`)) {
      throw new Error(`Assembled horizon_panel.html missing required DOM id="${reqId}"`);
    }
  }

  const assembledSha = crypto.createHash('sha256').update(assembled, 'utf8').digest('hex');
  const existing = fs.existsSync(targetHtml) ? fs.readFileSync(targetHtml, 'utf8') : null;
  const currentSha = existing !== null
    ? crypto.createHash('sha256').update(existing, 'utf8').digest('hex')
    : null;
  const identical = currentSha === assembledSha;

  if (checkOnly) {
    if (!identical) {
      throw new Error(
        `horizon_panel.html is out of sync with src/webview/partials/* (target=${currentSha}, assembled=${assembledSha}). Run node scripts/build_webview_html.mjs`
      );
    }
    if (!silent) {
      console.log(`✓ WebView Partials VERIFIED (${files.length} partials, max ${maxPartialLines} lines, sha256=${assembledSha.slice(0, 12)}...)`);
    }
    return {
      ok: true,
      checkOnly: true,
      identical: true,
      wrote: false,
      partialCount: files.length,
      maxPartialLines,
      sha256: assembledSha
    };
  }

  if (!identical) {
    fs.writeFileSync(targetHtml, assembled, 'utf8');
  }
  if (!silent) {
    console.log(
      identical
        ? `✓ WebView HTML already up to date (${files.length} partials, sha256=${assembledSha.slice(0, 12)}...)`
        : `✓ Compiled ${files.length} WebView partials -> ${path.relative(ROOT, targetHtml)} (${assembled.length} bytes)`
    );
  }
  return {
    ok: true,
    checkOnly: false,
    identical,
    wrote: !identical,
    partialCount: files.length,
    maxPartialLines,
    sha256: assembledSha
  };
}

function isBuildMain(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

if (isBuildMain()) {
  const checkOnly = process.argv.includes('--check');
  const json = process.argv.includes('--json');
  const res = buildWebviewHtml({ checkOnly, silent: json });
  if (json) {
    console.log(JSON.stringify(res, null, 2));
  }
}
