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
import vm from 'node:vm';
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

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof',
  'in', 'of', 'new', 'yield', 'await', 'else', 'do'
]);
const CTRL_HEADER_KEYWORDS = new Set(['if', 'for', 'while', 'with', 'catch']);

function readQuotedLiteral(src, startIdx) {
  const quote = src[startIdx];
  let out = quote;
  let i = startIdx + 1;
  while (i < src.length) {
    const c = src[i++];
    out += c;
    if (c === '\\' && i < src.length) out += src[i++];
    else if (c === quote) break;
  }
  return { text: out, nextIdx: i, lastChar: quote };
}

function readTemplateBody(src, startIdx, templateBraceStack) {
  let out = '';
  let i = startIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      out += c + src[i + 1];
      i += 2;
    } else if (c === '$' && src[i + 1] === '{') {
      out += '${';
      i += 2;
      templateBraceStack.push(0);
      return { text: out, nextIdx: i, lastChar: '{', enteredExpr: true };
    } else if (c === '`') {
      out += '`';
      return { text: out, nextIdx: i + 1, lastChar: '`', enteredExpr: false };
    } else {
      out += c;
      i++;
    }
  }
  return { text: out, nextIdx: i, lastChar: '`', enteredExpr: false };
}

function readRegexLiteral(src, startIdx) {
  let out = '/';
  let i = startIdx + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i++];
    out += c;
    if (c === '\\' && i < src.length) out += src[i++];
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      while (i < src.length && /[a-z]/i.test(src[i])) out += src[i++];
      break;
    }
  }
  return { text: out, nextIdx: i };
}

/**
 * Strips JS comments and unnecessary line indentation/blank lines from `<script>`
 * while preserving strings, multi-line template literals, regex literals, and ASI boundaries.
 * Validates the compacted output with `vm.Script`.
 * @param {string} src
 * @returns {string}
 */
export function compactWebviewScript(src = '') {
  const input = String(src || '').replace(/\r\n/g, '\n');
  let out = '';
  let i = 0;
  const n = input.length;
  let lastSigChar = '';
  let prevWord = '';
  const parenAllowsRegexStack = [];
  let pendingCtrlHeader = false;
  let afterCtrlCloseParen = false;
  const templateBraceStack = [];

  while (i < n) {
    const ch = input[i];
    const next = input[i + 1];

    if (ch === "'" || ch === '"') {
      const lit = readQuotedLiteral(input, i);
      out += lit.text;
      i = lit.nextIdx;
      lastSigChar = lit.lastChar;
      prevWord = '';
      afterCtrlCloseParen = false;
      pendingCtrlHeader = false;
      continue;
    }

    if (ch === '`') {
      const seg = readTemplateBody(input, i + 1, templateBraceStack);
      out += '`' + seg.text;
      i = seg.nextIdx;
      lastSigChar = seg.lastChar;
      prevWord = '';
      afterCtrlCloseParen = false;
      pendingCtrlHeader = false;
      continue;
    }

    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1]++;
      out += ch;
      i++;
      lastSigChar = '{';
      prevWord = '';
      afterCtrlCloseParen = false;
      pendingCtrlHeader = false;
      continue;
    }

    if (ch === '}' && templateBraceStack.length > 0) {
      if (templateBraceStack[templateBraceStack.length - 1] === 0) {
        templateBraceStack.pop();
        const seg = readTemplateBody(input, i + 1, templateBraceStack);
        out += '}' + seg.text;
        i = seg.nextIdx;
        lastSigChar = seg.lastChar;
        prevWord = '';
        afterCtrlCloseParen = false;
        pendingCtrlHeader = false;
        continue;
      }
      templateBraceStack[templateBraceStack.length - 1]--;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && input[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      let hadNewline = false;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) {
        if (input[i] === '\n') hadNewline = true;
        i++;
      }
      i += 2;
      out += hadNewline ? '\n' : ' ';
      continue;
    }

    if (ch === '(') {
      parenAllowsRegexStack.push(pendingCtrlHeader);
      pendingCtrlHeader = false;
      afterCtrlCloseParen = false;
      lastSigChar = '(';
      prevWord = '';
      out += ch;
      i++;
      continue;
    }

    if (ch === ')') {
      afterCtrlCloseParen = Boolean(parenAllowsRegexStack.pop());
      pendingCtrlHeader = false;
      lastSigChar = ')';
      prevWord = '';
      out += ch;
      i++;
      continue;
    }

    if (ch === '/') {
      const canBeRegex =
        !lastSigChar ||
        '([{:;,=!?&|+-*%^~<>'.includes(lastSigChar) ||
        afterCtrlCloseParen ||
        REGEX_PREV_KEYWORDS.has(prevWord);
      if (canBeRegex) {
        const rx = readRegexLiteral(input, i);
        out += rx.text;
        i = rx.nextIdx;
        lastSigChar = '/';
        prevWord = '';
        afterCtrlCloseParen = false;
        pendingCtrlHeader = false;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let id = '';
      while (i < n && /[A-Za-z0-9_$]/.test(input[i])) {
        id += input[i++];
      }
      out += id;
      prevWord = id;
      lastSigChar = id[id.length - 1];
      pendingCtrlHeader = CTRL_HEADER_KEYWORDS.has(id);
      afterCtrlCloseParen = false;
      continue;
    }

    if (ch === '\n') {
      out = out.replace(/[ \t]+$/, '');
      if (!out.endsWith('\n')) out += '\n';
      i++;
      while (i < n && (input[i] === ' ' || input[i] === '\t' || input[i] === '\r')) i++;
      continue;
    }

    if (!/\s/.test(ch)) {
      lastSigChar = ch;
      prevWord = '';
      pendingCtrlHeader = false;
      afterCtrlCloseParen = false;
    }
    out += ch;
    i++;
  }

  const trimmed = out.trim();
  new vm.Script(trimmed);
  return trimmed;
}

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

  const styleCompacted = chunks.join('\n').replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs, css) => {
    const compactCss = css
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//g, (tok) => (tok.startsWith('/*') ? '' : tok))
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/([{;,])\n/g, '$1')
      .replace(/\n}/g, '}')
      .replace(/;}/g, '}')
      .replace(/\n{2,}/g, '\n')
      .trim();
    return `<style${attrs}>\n${compactCss}\n</style>`;
  });
  const scriptOpenIdx = styleCompacted.indexOf('<script>');
  const scriptCloseIdx = styleCompacted.lastIndexOf('</script>');
  let assembled = styleCompacted;
  if (scriptOpenIdx !== -1 && scriptCloseIdx > scriptOpenIdx) {
    const beforeScript = styleCompacted
      .slice(0, scriptOpenIdx + '<script>'.length)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/>\n+</g, '><');
    const compactJs = compactWebviewScript(
      styleCompacted.slice(scriptOpenIdx + '<script>'.length, scriptCloseIdx)
    );
    assembled = `${beforeScript}\n${compactJs}\n${styleCompacted.slice(scriptCloseIdx)}`;
  }
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
