/**
 * @file test/mod_static_compliance.test.mjs
 * Phase 5 Exit Gate & Hardened Lexer/Token Static-Analyzer Verification Suite (`ISS-062`):
 *   - Claude Code Mod Static-Analyzer Self-Test (`hooks/register.js` + transitive Mod graph + `src/` + `bin/`)
 *   - Reusable token-stream validators (`validateModLaw1`, `validateModLaw2`, `validateModLaw3`,
 *     `validateModLaw4Imports`, `validateModLaw5ToolCallCatch`)
 *   - Non-Destructive Installer CLI (`bin/cli.mjs` `install`, `uninstall`, `doctor`, `receipt`)
 *   - Anti-Clobber `settings.json` backup & existing user hook preservation
 *   - `.git/info/exclude` hygiene (`.claude/cache/` and `.claude/locks/`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  PKG_ROOT,
  installAttentionHorizon,
  uninstallAttentionHorizon,
  runDoctorDiagnostics,
  generateReceiptReport,
  runCli
} from '../bin/ctxtop.mjs';
import { getNodeIo, registerNodeIo } from '../src/core-isomorphic/utils/runtime.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { runPreModelSwitchHook } from '../hooks/handlers/pre-model-switch.mjs';
import { runStopGateHook } from '../hooks/handlers/stop-gate.mjs';
import register from '../hooks/register.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Recursively collects all `.js` and `.mjs` files in a directory.
 * @param {string} dirPath
 * @returns {string[]}
 */
export function collectJsFiles(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(fullPath));
    } else if (/\.(m?js)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'yield',
  'await',
  'else',
  'do'
]);

const CONDITION_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'catch']);

/**
 * Determines whether a `/` at the current lexer position begins a RegExp literal
 * (rather than division `/` or `/=`) according to preceding JS token context.
 *
 * @param {Array<object>} tokens
 * @param {Map<number, boolean>} parenIsConditionMap
 * @returns {boolean}
 */
function canStartRegexLiteral(tokens, parenIsConditionMap) {
  if (tokens.length === 0) return true;
  const prev = tokens[tokens.length - 1];
  if (prev.type === 'number' || prev.type === 'string' || prev.type === 'template' || prev.type === 'regex') {
    return false;
  }
  if (prev.type === 'ident') {
    return REGEX_PRECEDING_KEYWORDS.has(prev.value);
  }
  if (prev.type === 'punct') {
    if (prev.value === ')' && !parenIsConditionMap.get(tokens.length - 1)) {
      return false;
    }
    if (prev.value === ']' || prev.value === '++' || prev.value === '--') {
      return false;
    }
    return true;
  }
  return true;
}

/**
 * Full JavaScript lexical scanner that strips `//` and `/* ... *\/` comments cleanly,
 * tokenizes strings (`'...'`, `"..."`), regex literals (`/…/flags`), and template literals
 * (recursively lexing `${ ... }` interpolation expressions as real code tokens!).
 *
 * @param {string} source
 * @returns {Array<{ type: string, value: string, pos: number }>}
 */
export function scanJsTokens(source = '') {
  const src = String(source ?? '');
  const len = src.length;
  const tokens = [];
  const openParenStack = [];
  const parenIsConditionMap = new Map();
  const templateBraceStack = [];

  let i = 0;

  const scanTemplateChunk = (isHead) => {
    const start = i;
    let val = '';
    while (i < len) {
      const ch = src[i];
      if (ch === '\\') {
        val += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        tokens.push({ type: 'template', value: val, pos: start });
        return;
      }
      if (ch === '$' && src[i + 1] === '{') {
        i += 2;
        tokens.push({ type: isHead ? 'template_head' : 'template_middle', value: val, pos: start });
        templateBraceStack.push({ braceDepth: 0 });
        return;
      }
      val += ch;
      i += 1;
    }
    tokens.push({ type: 'template', value: val, pos: start });
  };

  while (i < len) {
    const ch = src[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Single-line comment (including shebang `#!` at start of file)
    if ((ch === '/' && src[i + 1] === '/') || (i === 0 && ch === '#' && src[1] === '!')) {
      i += 2;
      while (i < len && src[i] !== '\n') i += 1;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // String literal ('...' or "...")
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      let val = '';
      while (i < len && src[i] !== quote) {
        if (src[i] === '\\') {
          const nextCh = src[i + 1] || '';
          val += nextCh;
          i += 2;
        } else {
          val += src[i];
          i += 1;
        }
      }
      if (i < len) i += 1;
      tokens.push({ type: 'string', value: val, pos: start });
      continue;
    }

    // Template literal (`...`)
    if (ch === '`') {
      i += 1;
      scanTemplateChunk(true);
      continue;
    }

    // Closing `}` that may terminate a `${ ... }` template interpolation
    if (ch === '}' && templateBraceStack.length > 0) {
      const top = templateBraceStack[templateBraceStack.length - 1];
      if (top.braceDepth === 0) {
        templateBraceStack.pop();
        i += 1;
        scanTemplateChunk(false);
        continue;
      }
      top.braceDepth -= 1;
    }

    // Opening `{` inside `${ ... }` template interpolation
    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1].braceDepth += 1;
    }

    // RegExp literal (`/pattern/flags`)
    if (ch === '/' && canStartRegexLiteral(tokens, parenIsConditionMap)) {
      const start = i;
      i += 1;
      let inCharClass = false;
      while (i < len) {
        const rc = src[i];
        if (rc === '\\') {
          i += 2;
          continue;
        }
        if (rc === '[') {
          inCharClass = true;
          i += 1;
          continue;
        }
        if (rc === ']') {
          inCharClass = false;
          i += 1;
          continue;
        }
        if (rc === '/' && !inCharClass) {
          i += 1;
          break;
        }
        if (rc === '\n') {
          break;
        }
        i += 1;
      }
      while (i < len && /[a-zA-Z]/.test(src[i])) i += 1;
      tokens.push({ type: 'regex', value: src.slice(start, i), pos: start });
      continue;
    }

    // Numeric literal
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const start = i;
      i += 1;
      while (i < len && /[0-9a-fA-FxXoObBn_.]/.test(src[i])) {
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-')) {
          i += 2;
          continue;
        }
        i += 1;
      }
      tokens.push({ type: 'number', value: src.slice(start, i), pos: start });
      continue;
    }

    // Identifier / keyword (including `$`)
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < len && /[A-Za-z0-9_$]/.test(src[i])) i += 1;
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }

    // Multi-char punctuators
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (['===', '!==', '...', '>>>', '**=', '&&=', '||=', '??='].includes(three)) {
      tokens.push({ type: 'punct', value: three, pos: i });
      i += 3;
      continue;
    }
    if (
      [
        '=>',
        '?.',
        '==',
        '!=',
        '<=',
        '>=',
        '&&',
        '||',
        '??',
        '++',
        '--',
        '+=',
        '-=',
        '*=',
        '/=',
        '%=',
        '<<',
        '>>'
      ].includes(two)
    ) {
      tokens.push({ type: 'punct', value: two, pos: i });
      i += 2;
      continue;
    }

    // Single-char punctuator (tracking condition `(...)` pairs)
    const tokIdx = tokens.length;
    if (ch === '(') {
      const prevTok = tokens[tokens.length - 1];
      const isCond = Boolean(prevTok && prevTok.type === 'ident' && CONDITION_PAREN_KEYWORDS.has(prevTok.value));
      openParenStack.push({ isCond });
    } else if (ch === ')') {
      const popped = openParenStack.pop();
      if (popped?.isCond) {
        parenIsConditionMap.set(tokIdx, true);
      }
    }
    tokens.push({ type: 'punct', value: ch, pos: i });
    i += 1;
  }

  return tokens;
}

/**
 * Finds the matching closing bracket index (`)`, `}`, `]`) for an opening bracket at `openIdx`.
 *
 * @param {Array<object>} tokens
 * @param {number} openIdx
 * @returns {number}
 */
function findMatchingCloseIndex(tokens, openIdx) {
  const openChar = tokens[openIdx]?.value;
  const closeChar = openChar === '(' ? ')' : openChar === '{' ? '}' : openChar === '[' ? ']' : null;
  if (!closeChar) return -1;
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].type !== 'punct') continue;
    if (tokens[i].value === openChar) depth += 1;
    else if (tokens[i].value === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Mod Law 1 Validator: No assignment or destructuring of `$` or `$.*` capability namespaces.
 * Allows assigning the return value of a direct capability call (e.g. `const v = $.store.get('k')`).
 *
 * @param {string} source
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function validateModLaw1(source = '') {
  const tokens = scanJsTokens(source);
  const violations = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Check `= $` or `= $.ns` or `= $.ns.method` (without invoking `(`)
    if (tok.type === 'punct' && tok.value === '=') {
      const rhs = tokens[i + 1];
      const prev = tokens[i - 1];
      if (!rhs || rhs.type !== 'ident' || rhs.value !== '$') continue;

      // Check if RHS is a direct capability method invocation `$.ns.method(...)`
      const isDirectCall =
        (tokens[i + 2]?.value === '.' || tokens[i + 2]?.value === '?.') &&
        tokens[i + 3]?.type === 'ident' &&
        (tokens[i + 4]?.value === '.' || tokens[i + 4]?.value === '?.') &&
        tokens[i + 5]?.type === 'ident' &&
        tokens[i + 6]?.value === '(';

      if (!isDirectCall) {
        if (prev?.value === '}' || prev?.value === ']') {
          violations.push('Must never destructure $ or any $.namespace');
        } else {
          violations.push('Must never assign $ or uninvoked $.namespace/method to a variable');
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Mod Law 2 Validator: Balanced Call-Argument, Object-Shorthand & Array Scanner.
 * Verifies `$` only appears as:
 *   1. Formal parameter of a direct `on('<event>', (..., $, ...) => ...)` callback, OR
 *   2. Direct capability method invocation `$.<namespace>.<method>(...)`.
 * Catches nested calls (`helper(foo(), $)`, `helper(a, $.store)`), object shorthand/properties
 * (`{ $ }`, `{ s: $.store }`), arrays (`[$]`), helper parameters (`function f($)`), and computed `$[...]`.
 *
 * @param {string} source
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function validateModLaw2(source = '') {
  const tokens = scanJsTokens(source);
  const violations = [];
  const allowedOnCallbackParamIndices = new Set();

  // 1. Identify formal `$` parameters strictly in direct `on('<event>', <callback>)` registrations
  for (let i = 0; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    if (
      tokens[i]?.type === 'ident' &&
      tokens[i].value === 'on' &&
      !(prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === '(' &&
      tokens[i + 2]?.type === 'string' &&
      tokens[i + 3]?.type === 'punct' &&
      tokens[i + 3].value === ','
    ) {
      let cbStart = i + 4;
      if (tokens[cbStart]?.type === 'ident' && tokens[cbStart].value === 'async') {
        cbStart += 1;
      }
      if (tokens[cbStart]?.type === 'ident' && tokens[cbStart].value === 'function') {
        cbStart += 1;
        if (tokens[cbStart]?.type === 'ident') cbStart += 1;
      }
      if (tokens[cbStart]?.type === 'punct' && tokens[cbStart].value === '(') {
        const closeParen = findMatchingCloseIndex(tokens, cbStart);
        if (closeParen !== -1) {
          for (let p = cbStart + 1; p < closeParen; p++) {
            if (tokens[p].type === 'ident' && tokens[p].value === '$') {
              allowedOnCallbackParamIndices.add(p);
            }
          }
        }
      }
    }
  }

  // 2. Flag any non-`on(...)` function or arrow parameter list that accepts `$`
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'ident' && tokens[i].value === 'function') {
      let pStart = i + 1;
      if (tokens[pStart]?.type === 'ident') pStart += 1;
      if (tokens[pStart]?.type === 'punct' && tokens[pStart].value === '(') {
        const pClose = findMatchingCloseIndex(tokens, pStart);
        if (pClose !== -1) {
          for (let p = pStart + 1; p < pClose; p++) {
            if (
              tokens[p].type === 'ident' &&
              tokens[p].value === '$' &&
              !allowedOnCallbackParamIndices.has(p)
            ) {
              violations.push('No helper function may accept "$" as a parameter');
            }
          }
        }
      }
    }

    // Arrow parameter list `( ... ) =>` or `$ =>`
    if (tokens[i].type === 'punct' && tokens[i].value === '=>') {
      if (tokens[i - 1]?.type === 'ident' && tokens[i - 1].value === '$') {
        if (!allowedOnCallbackParamIndices.has(i - 1)) {
          violations.push('Arrow function outside direct on(...) registration may not accept "$"');
        }
      } else if (tokens[i - 1]?.type === 'punct' && tokens[i - 1].value === ')') {
        // Walk backwards to matching `(`
        let depth = 0;
        let openIdx = -1;
        for (let k = i - 1; k >= 0; k--) {
          if (tokens[k].type !== 'punct') continue;
          if (tokens[k].value === ')') depth += 1;
          else if (tokens[k].value === '(') {
            depth -= 1;
            if (depth === 0) {
              openIdx = k;
              break;
            }
          }
        }
        if (openIdx !== -1) {
          for (let p = openIdx + 1; p < i - 1; p++) {
            if (
              tokens[p].type === 'ident' &&
              tokens[p].value === '$' &&
              !allowedOnCallbackParamIndices.has(p)
            ) {
              violations.push('Arrow function outside direct on(...) registration may not accept "$"');
            }
          }
        }
      }
    }
  }

  // 3. Walk balanced `()`, `{}`, `[]` scopes and verify every remaining `$` token
  const bracketStack = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'punct') {
      if (tok.value === '(') {
        const prev1 = tokens[i - 1];
        const prev2 = tokens[i - 2];
        const prev3 = tokens[i - 3];
        const callee =
          prev1?.type === 'ident'
            ? prev2?.value === '.' && prev3?.type === 'ident'
              ? `${prev3.value}.${prev1.value}`
              : prev1.value
            : null;
        bracketStack.push({ kind: 'paren', callee });
      } else if (tok.value === '{') {
        bracketStack.push({ kind: 'brace' });
      } else if (tok.value === '[') {
        bracketStack.push({ kind: 'bracket' });
      } else if (tok.value === ')' || tok.value === '}' || tok.value === ']') {
        bracketStack.pop();
      }
      continue;
    }

    if (tok.type !== 'ident' || tok.value !== '$') continue;
    if (allowedOnCallbackParamIndices.has(i)) continue;

    // Ignore property access `obj.$` where `$` is not the root capability identifier
    const before = tokens[i - 1];
    if (before?.type === 'punct' && (before.value === '.' || before.value === '?.')) {
      continue;
    }

    // Valid direct capability method invocation: `$ . <namespace> . <method> (`
    const isDirectCapabilityCall =
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === '.' &&
      tokens[i + 2]?.type === 'ident' &&
      tokens[i + 3]?.type === 'punct' &&
      tokens[i + 3].value === '.' &&
      tokens[i + 4]?.type === 'ident' &&
      tokens[i + 5]?.type === 'punct' &&
      tokens[i + 5].value === '(';

    if (isDirectCapabilityCall) {
      continue;
    }

    const nearestScope = bracketStack[bracketStack.length - 1] || null;
    const enclosingCall = [...bracketStack].reverse().find((b) => b.kind === 'paren' && b.callee);

    if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.' && tokens[i + 2]?.type === 'ident') {
      const ns = tokens[i + 2].value;
      violations.push(
        `Capability namespace "$.${ns}" must be invoked directly and never passed or stored${
          enclosingCall ? ` (in call ${enclosingCall.callee}(...))` : ''
        }`
      );
    } else if (nearestScope?.kind === 'brace') {
      violations.push('Object literal / shorthand "{ $ }" must never capture or pass "$"');
    } else if (nearestScope?.kind === 'bracket') {
      violations.push('Array literal "[$]" must never capture or pass "$"');
    } else if (enclosingCall) {
      violations.push(`Must never pass "$" as an argument to function "${enclosingCall.callee}(...)"`);
    } else {
      violations.push('Bare "$" must never escape lexical on(...) capability calls');
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Mod Law 3 Validator: Direct string literals in `on(...)` registrations without shadowing `on`.
 *
 * @param {string} source
 * @returns {{ ok: boolean, onEvents: string[], violations: string[] }}
 */
export function validateModLaw3(source = '') {
  const tokens = scanJsTokens(source);
  const violations = [];
  const onEvents = [];

  for (let i = 0; i < tokens.length; i++) {
    if (
      tokens[i].type === 'ident' &&
      (tokens[i].value === 'const' || tokens[i].value === 'let' || tokens[i].value === 'var') &&
      tokens[i + 1]?.type === 'ident' &&
      tokens[i + 1].value === 'on'
    ) {
      violations.push('Must never shadow "on" via variable declaration');
    }
    if (
      tokens[i].type === 'ident' &&
      tokens[i].value === 'function' &&
      tokens[i + 1]?.type === 'ident' &&
      tokens[i + 1].value === 'on'
    ) {
      violations.push('Must never shadow "on" via function declaration');
    }
    const prev = tokens[i - 1];
    if (
      tokens[i].type === 'ident' &&
      tokens[i].value === 'on' &&
      !(prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === '('
    ) {
      const firstArg = tokens[i + 2];
      const afterArg = tokens[i + 3];
      if (
        !firstArg ||
        firstArg.type !== 'string' ||
        !/^[a-zA-Z0-9_.]+$/.test(firstArg.value) ||
        !(afterArg?.type === 'punct' && (afterArg.value === ',' || afterArg.value === ')'))
      ) {
        violations.push(
          `on(...) first argument must be a direct string literal, found: ${firstArg?.value ?? 'none'}`
        );
      } else {
        onEvents.push(firstArg.value);
      }
    }
  }

  return { ok: violations.length === 0, onEvents, violations };
}

/**
 * Mod Law 4 Validator: Extracts ALL static ESM import & re-export specifiers
 * (`import def from`, `import * as ns from`, `import { a } from`, `import def, { a } from`,
 * `import def, * as ns from`, `import '...'`, and `export ... from '...'`) and verifies:
 *   - Zero `require(...)`, zero `module.exports`, zero dynamic `import(...)`, zero `getBuiltinModule`
 *   - Zero `node:*` specifiers and strictly relative `./` or `../` specifiers in Mod graph.
 *
 * @param {string} source
 * @param {{ allowBareOrNodeSpecifiers?: boolean }} [options={}]
 * @returns {{ ok: boolean, specifiers: string[], violations: string[] }}
 */
export function validateModLaw4Imports(source = '', options = {}) {
  const tokens = scanJsTokens(source);
  const specifiers = [];
  const violations = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    const isProperty = prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.');

    if (tok.type === 'ident' && tok.value === 'getBuiltinModule') {
      violations.push('Forbidden process.getBuiltinModule usage');
    }

    if (!isProperty && tok.type === 'ident' && tok.value === 'require' && tokens[i + 1]?.value === '(') {
      violations.push('Forbidden CommonJS require() call');
    }

    if (
      !isProperty &&
      tok.type === 'ident' &&
      tok.value === 'module' &&
      tokens[i + 1]?.value === '.' &&
      tokens[i + 2]?.type === 'ident' &&
      tokens[i + 2].value === 'exports'
    ) {
      violations.push('Forbidden CommonJS module.exports assignment');
    }

    // `import` forms
    if (!isProperty && tok.type === 'ident' && tok.value === 'import') {
      const next = tokens[i + 1];
      if (!next) continue;

      // Dynamic `import(...)`
      if (next.type === 'punct' && next.value === '(') {
        violations.push('Forbidden dynamic import() call');
        continue;
      }

      // `import.meta`
      if (next.type === 'punct' && next.value === '.') {
        continue;
      }

      // Side-effect `import './mod.mjs'`
      if (next.type === 'string') {
        specifiers.push(next.value);
        i += 1;
        continue;
      }

      // `import <clause> from '<specifier>'` (covers default, namespace, named, and mixed default+named/namespace)
      let cursor = i + 1;
      let foundFrom = false;
      while (cursor < tokens.length) {
        const ct = tokens[cursor];
        if (ct.type === 'punct' && ct.value === '{') {
          const closeBrace = findMatchingCloseIndex(tokens, cursor);
          if (closeBrace === -1) break;
          cursor = closeBrace + 1;
          continue;
        }
        if (ct.type === 'ident' && ct.value === 'from' && tokens[cursor + 1]?.type === 'string') {
          specifiers.push(tokens[cursor + 1].value);
          foundFrom = true;
          i = cursor + 1;
          break;
        }
        if (ct.type === 'punct' && ct.value === ';') {
          break;
        }
        cursor += 1;
      }
      if (!foundFrom) {
        violations.push('Malformed ESM import statement');
      }
      continue;
    }

    // Re-export forms: `export * from '...'`, `export * as ns from '...'`, `export { ... } from '...'`
    if (!isProperty && tok.type === 'ident' && tok.value === 'export') {
      let cursor = i + 1;
      if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '*') {
        cursor += 1;
        if (tokens[cursor]?.type === 'ident' && tokens[cursor].value === 'as') {
          cursor += 2;
        }
        if (tokens[cursor]?.type === 'ident' && tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'string') {
          specifiers.push(tokens[cursor + 1].value);
          i = cursor + 1;
        }
      } else if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '{') {
        const closeBrace = findMatchingCloseIndex(tokens, cursor);
        if (
          closeBrace !== -1 &&
          tokens[closeBrace + 1]?.type === 'ident' &&
          tokens[closeBrace + 1].value === 'from' &&
          tokens[closeBrace + 2]?.type === 'string'
        ) {
          specifiers.push(tokens[closeBrace + 2].value);
          i = closeBrace + 2;
        }
      }
    }
  }

  if (!options.allowBareOrNodeSpecifiers) {
    for (const spec of specifiers) {
      if (/^node:/i.test(spec)) {
        violations.push(`Forbidden node: builtin import "${spec}"`);
      } else if (!/^\.\.?\//.test(spec)) {
        violations.push(`Non-relative import specifier "${spec}" (must start with ./ or ../)`);
      }
    }
  }

  return { ok: violations.length === 0, specifiers, violations };
}

/**
 * Checks whether a token slice representing an error-handler body or `.catch(...)` callback
 * returns an object literal with `decision: 'deny'` and contains ZERO `throw` tokens.
 *
 * @param {Array<object>} handlerTokens
 * @returns {{ ok: boolean, reason: string | null }}
 */
function verifyFailClosedHandlerTokens(handlerTokens) {
  if (!handlerTokens || handlerTokens.length === 0) {
    return { ok: false, reason: 'Empty fail-closed catch handler' };
  }

  for (const tok of handlerTokens) {
    if (tok.type === 'ident' && tok.value === 'throw') {
      return { ok: false, reason: 'Fail-closed catch handler must NEVER contain a throw statement' };
    }
  }

  // Verify `decision: 'deny'` inside an object literal returned by the catch handler
  let hasDenyDecisionObject = false;
  for (let i = 0; i < handlerTokens.length - 2; i++) {
    const keyTok = handlerTokens[i];
    const colonTok = handlerTokens[i + 1];
    const valTok = handlerTokens[i + 2];
    const keyMatches =
      (keyTok.type === 'ident' && keyTok.value === 'decision') ||
      (keyTok.type === 'string' && keyTok.value === 'decision');
    if (
      keyMatches &&
      colonTok?.type === 'punct' &&
      colonTok.value === ':' &&
      valTok?.type === 'string' &&
      valTok.value === 'deny'
    ) {
      hasDenyDecisionObject = true;
      break;
    }
  }

  if (!hasDenyDecisionObject) {
    return { ok: false, reason: 'Fail-closed catch handler must resolve { decision: "deny" }' };
  }

  // If the handler is a block `{ ... }` (not concise arrow `=> ({ decision: 'deny' })`), verify `return` is present
  let arrowIdx = -1;
  for (let i = 0; i < handlerTokens.length; i++) {
    if (handlerTokens[i].type === 'punct' && handlerTokens[i].value === '=>') {
      arrowIdx = i;
      break;
    }
  }
  const bodySlice = arrowIdx !== -1 ? handlerTokens.slice(arrowIdx + 1) : handlerTokens;
  if (bodySlice[0]?.type === 'punct' && bodySlice[0].value === '{') {
    const hasReturn = bodySlice.some((t) => t.type === 'ident' && t.value === 'return');
    if (!hasReturn) {
      return { ok: false, reason: 'Block catch handler must explicitly return { decision: "deny" }' };
    }
  }

  return { ok: true, reason: null };
}

/**
 * Checks whether a Promise expression token slice ends at top-level bracket depth
 * with a chained `.catch(<failClosedHandler>)`.
 *
 * @param {Array<object>} exprTokens
 * @returns {{ ok: boolean, reason: string | null }}
 */
function verifyPromiseExprEndsWithFailClosedCatch(exprTokens) {
  const trimmed = [...exprTokens];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].type === 'punct' && trimmed[trimmed.length - 1].value === ';') {
    trimmed.pop();
  }
  if (trimmed.length < 5) {
    return { ok: false, reason: 'on("tool.call", ...) expression does not chain .catch(...)' };
  }
  if (trimmed[trimmed.length - 1].type !== 'punct' || trimmed[trimmed.length - 1].value !== ')') {
    return { ok: false, reason: 'on("tool.call", ...) return expression must end with .catch(...)' };
  }

  // Walk top-level depth from start to find the matching `(` for the final `)`
  let depth = 0;
  let lastTopOpenParen = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const t = trimmed[i];
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '{' || t.value === '[') {
      if (depth === 0 && t.value === '(') {
        lastTopOpenParen = i;
      }
      depth += 1;
    } else if (t.value === ')' || t.value === '}' || t.value === ']') {
      depth -= 1;
    }
  }

  if (
    lastTopOpenParen < 2 ||
    trimmed[lastTopOpenParen - 1]?.type !== 'ident' ||
    trimmed[lastTopOpenParen - 1].value !== 'catch' ||
    trimmed[lastTopOpenParen - 2]?.type !== 'punct' ||
    trimmed[lastTopOpenParen - 2].value !== '.'
  ) {
    return {
      ok: false,
      reason: 'on("tool.call", ...) must chain .catch(...) directly onto its returned Promise'
    };
  }

  const catchArgTokens = trimmed.slice(lastTopOpenParen + 1, trimmed.length - 1);
  return verifyFailClosedHandlerTokens(catchArgTokens);
}

/**
 * Mod Law 5 Validator: Exact `on('tool.call', ...)` Fail-Closed Scanner.
 * Locates EVERY `on('tool.call', ...)` invocation via balanced parenthesis scanning and verifies:
 *   - Non-`async` callback returns a Promise directly chained with `.catch(...)` resolving `{ decision: 'deny' }` with zero `throw`, OR
 *   - `async` callback wraps its entire body in `try { ... } catch (...) { return { decision: 'deny', ... }; }` with zero `throw`.
 * Decoy `.catch(() => ({ decision: 'deny' }))` handlers elsewhere in the file NEVER satisfy an unguarded `on('tool.call', ...)`.
 *
 * @param {string} source
 * @returns {{ ok: boolean, toolCallCount: number, violations: string[] }}
 */
export function validateModLaw5ToolCallCatch(source = '') {
  const tokens = scanJsTokens(source);
  const violations = [];
  let toolCallCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    if (
      tokens[i]?.type === 'ident' &&
      tokens[i].value === 'on' &&
      !(prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === '(' &&
      tokens[i + 2]?.type === 'string' &&
      tokens[i + 2].value === 'tool.call' &&
      tokens[i + 3]?.type === 'punct' &&
      tokens[i + 3].value === ','
    ) {
      toolCallCount += 1;
      const closeOnParen = findMatchingCloseIndex(tokens, i + 1);
      if (closeOnParen === -1) {
        violations.push('Unbalanced parentheses in on("tool.call", ...)');
        continue;
      }

      const cbTokens = tokens.slice(i + 4, closeOnParen);
      if (cbTokens.length > 0 && cbTokens[cbTokens.length - 1].value === ',') {
        cbTokens.pop();
      }

      let cursor = 0;
      let isAsync = false;
      if (cbTokens[cursor]?.type === 'ident' && cbTokens[cursor].value === 'async') {
        isAsync = true;
        cursor += 1;
      }

      if (cbTokens[cursor]?.type === 'ident' && cbTokens[cursor].value === 'function') {
        cursor += 1;
        if (cbTokens[cursor]?.type === 'ident') cursor += 1;
        if (cbTokens[cursor]?.value === '(') {
          const closeParams = findMatchingCloseIndex(cbTokens, cursor);
          if (closeParams === -1) {
            violations.push('Malformed function parameters in on("tool.call", ...)');
            continue;
          }
          cursor = closeParams + 1;
        }
      } else if (cbTokens[cursor]?.type === 'punct' && cbTokens[cursor].value === '(') {
        const closeParams = findMatchingCloseIndex(cbTokens, cursor);
        if (closeParams === -1 || cbTokens[closeParams + 1]?.value !== '=>') {
          violations.push('Malformed arrow callback in on("tool.call", ...)');
          continue;
        }
        cursor = closeParams + 2;
      } else if (cbTokens[cursor]?.type === 'ident' && cbTokens[cursor + 1]?.value === '=>') {
        cursor += 2;
      } else {
        violations.push('on("tool.call", ...) second argument must be an inline callback function');
        continue;
      }

      const bodyTokens = cbTokens.slice(cursor);
      if (bodyTokens.length === 0) {
        violations.push('Empty callback body in on("tool.call", ...)');
        continue;
      }

      if (!isAsync) {
        if (bodyTokens[0].type === 'punct' && bodyTokens[0].value === '{') {
          const closeBrace = findMatchingCloseIndex(bodyTokens, 0);
          if (closeBrace !== bodyTokens.length - 1) {
            violations.push('Unexpected tokens after on("tool.call", ...) callback block');
            continue;
          }
          const inner = bodyTokens.slice(1, closeBrace);
          if (inner[0]?.type !== 'ident' || inner[0].value !== 'return') {
            violations.push(
              'Non-async on("tool.call", ...) block must immediately return a fail-closed Promise.catch(...) chain'
            );
            continue;
          }
          const check = verifyPromiseExprEndsWithFailClosedCatch(inner.slice(1));
          if (!check.ok) {
            violations.push(check.reason);
          }
        } else {
          const check = verifyPromiseExprEndsWithFailClosedCatch(bodyTokens);
          if (!check.ok) {
            violations.push(check.reason);
          }
        }
      } else {
        // `async` callback: entire body MUST be a single `try { ... } catch (...) { return { decision: 'deny' }; }`
        if (bodyTokens[0].type !== 'punct' || bodyTokens[0].value !== '{') {
          violations.push('Unguarded concise async arrow in on("tool.call", ...) can reject');
          continue;
        }
        const closeBrace = findMatchingCloseIndex(bodyTokens, 0);
        const inner = bodyTokens.slice(1, closeBrace);
        while (inner.length > 0 && inner[inner.length - 1].value === ';') {
          inner.pop();
        }
        if (inner[0]?.type !== 'ident' || inner[0].value !== 'try' || inner[1]?.value !== '{') {
          violations.push(
            'Async on("tool.call", ...) callback must wrap its entire body in try { ... } catch { return { decision: "deny" }; }'
          );
          continue;
        }
        const closeTry = findMatchingCloseIndex(inner, 1);
        if (closeTry === -1 || inner[closeTry + 1]?.type !== 'ident' || inner[closeTry + 1].value !== 'catch') {
          violations.push('Async on("tool.call", ...) try block is missing a fail-closed catch block');
          continue;
        }
        let catchBodyOpen = closeTry + 2;
        if (inner[catchBodyOpen]?.value === '(') {
          const closeCatchParam = findMatchingCloseIndex(inner, catchBodyOpen);
          if (closeCatchParam === -1) {
            violations.push('Malformed catch parameter in async on("tool.call", ...)');
            continue;
          }
          catchBodyOpen = closeCatchParam + 1;
        }
        if (inner[catchBodyOpen]?.value !== '{') {
          violations.push('Malformed catch block in async on("tool.call", ...)');
          continue;
        }
        const closeCatchBody = findMatchingCloseIndex(inner, catchBodyOpen);
        if (closeCatchBody !== inner.length - 1) {
          violations.push(
            'Unguarded statements after try/catch in async on("tool.call", ...) callback'
          );
          continue;
        }
        const catchBodyTokens = inner.slice(catchBodyOpen, closeCatchBody + 1);
        const check = verifyFailClosedHandlerTokens(catchBodyTokens);
        if (!check.ok) {
          violations.push(check.reason);
        }
      }
    }
  }

  if (toolCallCount === 0) {
    violations.push('Missing on("tool.call", ...) guard registration');
  }

  return { ok: violations.length === 0, toolCallCount, violations };
}

function registerComplianceTestSuite() {
  test('Phase 5.1: Mod Law 1 — No assignment or destructuring of `$` or `$.*` in `hooks/register.js`', () => {
    const registerPath = path.join(PROJECT_ROOT, 'hooks', 'register.js');
    const source = fs.readFileSync(registerPath, 'utf-8');
    const res = validateModLaw1(source);
    assert.equal(res.ok, true, `Mod Law 1 violations: ${res.violations.join('; ')}`);
  });

  test('Phase 5.2: Mod Law 2 — Balanced call & object/array scanner proves `$` or `$.*` never passed in `hooks/register.js`', () => {
    const registerPath = path.join(PROJECT_ROOT, 'hooks', 'register.js');
    const source = fs.readFileSync(registerPath, 'utf-8');
    const res = validateModLaw2(source);
    assert.equal(res.ok, true, `Mod Law 2 violations: ${res.violations.join('; ')}`);
  });

  test('Phase 5.3: Mod Law 3 — Direct string literals in `on(...)` registrations without shadowing `on`', () => {
    const registerPath = path.join(PROJECT_ROOT, 'hooks', 'register.js');
    const source = fs.readFileSync(registerPath, 'utf-8');
    assert.match(source, /export\s+default\s+function\s+register\s*\(\s*on\s*\)/);

    const res = validateModLaw3(source);
    assert.equal(res.ok, true, `Mod Law 3 violations: ${res.violations.join('; ')}`);
    assert.ok(
      res.onEvents.length >= 7,
      `Expected at least 7 on(...) registrations, found ${res.onEvents.length}`
    );
  });

  test('Phase 5.4: Mod Law 4 — Pure-JS transitive Mod graph from `hooks/register.js` & zero `process.getBuiltinModule` smuggling', async () => {
    const registerEntry = path.join(PROJECT_ROOT, 'hooks', 'register.js');
    const visited = new Set();
    const queue = [registerEntry];

    while (queue.length > 0) {
      const currentFile = queue.shift();
      if (visited.has(currentFile)) continue;
      visited.add(currentFile);

      const rel = path.relative(PROJECT_ROOT, currentFile);
      const source = fs.readFileSync(currentFile, 'utf-8');
      const law4 = validateModLaw4Imports(source);

      assert.equal(
        law4.ok,
        true,
        `Mod Law 4 violation in ${rel}: ${law4.violations.join('; ')}`
      );

      for (const specifier of law4.specifiers) {
        const resolved = path.resolve(path.dirname(currentFile), specifier);
        if (/\.(m?js)$/.test(resolved) && fs.existsSync(resolved)) {
          queue.push(resolved);
        }
      }
    }

    assert.ok(
      visited.size >= 12,
      `Expected at least 12 pure-JS modules in register.js transitive graph, found ${visited.size}`
    );
    assert.equal(
      visited.has(path.join(PROJECT_ROOT, 'src', 'utils', 'nodeIo.mjs')),
      false,
      'Tier-2 src/utils/nodeIo.mjs must NEVER enter hooks/register.js transitive graph'
    );

    // Prove runtime sandboxed V8 isolate compatibility with process.getBuiltinModule = undefined & null Node I/O
    const savedGetBuiltin = process.getBuiltinModule;
    const savedIo = getNodeIo();
    try {
      process.getBuiltinModule = undefined;
      registerNodeIo(null);

      const sandboxHandlers = {};
      register((evt, fn) => {
        sandboxHandlers[evt] = fn;
      });
      assert.ok(typeof sandboxHandlers['tool.call'] === 'function');
      assert.ok(typeof sandboxHandlers['turn.step'] === 'function');

      const memStore = new Map();
      const sandboxCtx = {
        store: { get: (k) => memStore.get(k), set: (k, v) => memStore.set(k, v) },
        ui: { open: () => {}, invalidate: () => {} },
        clock: { every: () => () => {} }
      };
      const sandboxVerdict = await sandboxHandlers['tool.call'](
        { tool_name: 'Read', tool_input: { file_path: '.env' } },
        sandboxCtx,
        async () => 'allowed'
      );
      assert.equal(sandboxVerdict.decision, 'deny');
    } finally {
      process.getBuiltinModule = savedGetBuiltin;
      registerNodeIo(savedIo);
    }

    // Scan all `.js`/`.mjs` files across `hooks/`, `src/core-isomorphic/`, and `bin/` for zero CJS, zero dynamic import(), & zero getBuiltinModule smuggling
    const files = [
      ...collectJsFiles(path.join(PROJECT_ROOT, 'hooks')),
      ...collectJsFiles(path.join(PROJECT_ROOT, 'src', 'core-isomorphic')),
      ...collectJsFiles(path.join(PROJECT_ROOT, 'bin'))
    ];

    assert.ok(files.length >= 15, `Expected at least 15 runtime files, found ${files.length}`);

    for (const filePath of files) {
      const rel = path.relative(PROJECT_ROOT, filePath);
      const source = fs.readFileSync(filePath, 'utf-8');
      const check = validateModLaw4Imports(source, { allowBareOrNodeSpecifiers: true });
      assert.equal(
        check.ok,
        true,
        `Forbidden CJS / dynamic import / getBuiltinModule in ${rel}: ${check.violations.join('; ')}`
      );
    }
  });

  test('Phase 5.5: Mod Law 5 — Exact balanced `on("tool.call", ...)` `.catch(...)` fail-closed handler (never re-throws)', async () => {
    const registerPath = path.join(PROJECT_ROOT, 'hooks', 'register.js');
    const source = fs.readFileSync(registerPath, 'utf-8');

    const law5 = validateModLaw5ToolCallCatch(source);
    assert.equal(law5.ok, true, `Mod Law 5 violations: ${law5.violations.join('; ')}`);
    assert.equal(law5.toolCallCount, 1);

    // Runtime proof: if an evaluator or store access throws inside tool.call, it resolves fail-closed!
    const handlers = {};
    register((eventName, fn) => {
      handlers[eventName] = fn;
    });
    const throwingContext = {
      store: {
        get: () => {
          throw new Error('simulated isolate store fault');
        },
        set: () => {}
      },
      ui: { invalidate: () => {}, open: () => {} },
      clock: { every: () => () => {} }
    };
    const failClosed = await handlers['tool.call'](
      { tool_name: 'Bash', tool_input: { command: 'echo test' } },
      throwingContext,
      async () => 'passed'
    );
    assert.equal(failClosed.decision, 'deny');
    assert.match(failClosed.reason, /\[Attention Horizon Fail-Closed\].*simulated isolate store fault/);
  });

  test('Phase 5.6: CLI `install` & `uninstall` anti-clobber backup and existing user hook preservation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-phase5-cli-'));
    try {
      const claudeDir = path.join(tmpDir, '.claude');
      const gitInfoDir = path.join(tmpDir, '.git', 'info');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.mkdirSync(gitInfoDir, { recursive: true });

      const settingsPath = path.join(claudeDir, 'settings.json');
      const existingUserSettings = {
        env: { CUSTOM_FLAG: '1' },
        permissions: { allow: ['Read'] },
        statusLine: {
          type: 'command',
          command: 'node ./my-custom-status.js'
        },
        hooks: {
          modules: ['./my-existing-mod.js'],
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'node ./my-company-audit-hook.js'
                }
              ]
            }
          ]
        }
      };
      fs.writeFileSync(settingsPath, JSON.stringify(existingUserSettings, null, 2), 'utf-8');

      const installRes = installAttentionHorizon({
        cwd: tmpDir,
        settingsPath,
        timestamp: 1762752000000
      });

      assert.equal(installRes.ok, true);
      assert.ok(installRes.backupPath && fs.existsSync(installRes.backupPath));
      assert.equal(installRes.gitExcludeUpdated, true);

      const backupJson = JSON.parse(fs.readFileSync(installRes.backupPath, 'utf-8'));
      assert.deepEqual(backupJson, existingUserSettings);

      const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.equal(merged.env.CUSTOM_FLAG, '1');
      assert.deepEqual(merged.permissions.allow, ['Read']);
      assert.ok(merged.hooks.modules.includes('./my-existing-mod.js'));
      assert.ok(merged.hooks.modules.includes(`${PKG_ROOT}/hooks/register.js`));
      assert.equal(merged.hooks.PreToolUse.length, 2);
      assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'node ./my-company-audit-hook.js');
      assert.equal(
        merged.hooks.PreToolUse[1].hooks[0].command,
        `node "${PKG_ROOT}/hooks/handlers/pre-tool-use.mjs"`
      );
      assert.equal(merged.statusLine.command, `node "${PKG_ROOT}/bin/ah-statusline.mjs"`);
      assert.equal(merged.ahPreviousStatusLine.command, 'node ./my-custom-status.js');

      const excludeContent = fs.readFileSync(path.join(gitInfoDir, 'exclude'), 'utf-8');
      assert.match(excludeContent, /\.claude\/cache\//);
      assert.match(excludeContent, /\.claude\/locks\//);

      const secondInstall = installAttentionHorizon({ cwd: tmpDir, settingsPath });
      assert.equal(secondInstall.settings.hooks.PreToolUse.length, 2);
      assert.equal(secondInstall.settings.hooks.modules.length, 2);

      const uninstallRes = uninstallAttentionHorizon({ cwd: tmpDir, settingsPath });
      assert.equal(uninstallRes.ok, true);
      assert.ok(uninstallRes.removedHooksCount >= 8);

      const afterUninstall = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.deepEqual(afterUninstall.hooks.modules, ['./my-existing-mod.js']);
      assert.equal(afterUninstall.hooks.PreToolUse.length, 1);
      assert.equal(
        afterUninstall.hooks.PreToolUse[0].hooks[0].command,
        'node ./my-company-audit-hook.js'
      );
      assert.equal(afterUninstall.statusLine.command, 'node ./my-custom-status.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Phase 5.7: CLI `doctor` and `receipt` subcommands execute cleanly with 0-fallback ledger', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-phase5-doc-'));
    try {
      const doctorOut = runCli(['doctor'], { cwd: tmpDir });
      assert.equal(doctorOut.exitCode, 0);
      assert.match(doctorOut.output, /Status: HEALTHY/);

      const diag = runDoctorDiagnostics({ cwd: tmpDir });
      assert.equal(diag.ok, true);
      assert.ok(diag.checks.every((c) => c.ok));
      assert.equal(diag.hookDiagnostics.recentErrorCount, 0);

      const receiptOut = runCli(['receipt'], { cwd: tmpDir });
      assert.equal(receiptOut.exitCode, 0);
      assert.match(receiptOut.output, /\[Box 1\] Capacity & Horizon Bar/);
      assert.match(receiptOut.output, /\[Box 5\] Deterministic Saved-Quota Receipt/);
      assert.match(receiptOut.output, /\$0\.00 USD \| 0 tokens preserved/);

      const report = generateReceiptReport({ cwd: tmpDir });
      assert.equal(report.summary.totalSavedTokens, 0);
      assert.equal(report.summary.totalSavedUSD, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Phase 5.8: Package manifest & 0-runtime-dependency invariant verification', () => {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    assert.equal(pkg.name, 'ctxtop');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.dependencies || {}, {});
    assert.ok(pkg.bin['ctxtop']);
    assert.ok(pkg.bin['ah-claude']);
    assert.ok(pkg.bin['attention-horizon-claude']);
    assert.ok(pkg.bin['ah-statusline']);
    assert.equal('cc-attention-horizon' in pkg.bin, false);
  });

  test('Phase 5.9: Tier 2 CLI Hook Handlers E2E (PreToolUse, PostToolUse, PreModelSwitch, Stop)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-phase5-hooks-'));
    try {
      const preDeny = runPreToolUseHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'git commit --no-verify -m "skip hooks"' }
        },
        { cwd: tmpDir }
      );
      assert.equal(preDeny.exitCode, 2);
      assert.match(preDeny.stderr, /DET-01/);

      const preDenyPwsh = runPreToolUseHook(
        {
          tool_name: 'PowerShell',
          tool_input: { command: '& "git.exe" commit `--no-verify -m "skip hooks"' }
        },
        { cwd: tmpDir }
      );
      assert.equal(preDenyPwsh.exitCode, 2);
      assert.match(preDenyPwsh.stderr, /DET-01/);

      const postRes = runPostToolUseHook(
        {
          tool_name: 'Bash',
          tool_response: '\x1b[32mPASS\x1b[0m suite 1\nSyntaxError: Unexpected token in app.mjs:14'
        },
        { cwd: tmpDir }
      );
      assert.equal(postRes.exitCode, 0);
      assert.ok(postRes.stdout.includes('SyntaxError: Unexpected token in app.mjs:14'));

      const switchRes = runPreModelSwitchHook(
        {
          currentModel: 'claude-opus-5-5',
          targetModel: 'claude-sonnet-5-5',
          cachedTokens: 45000,
          cacheWarm: true,
          mode: 'AUTO_PILOT'
        },
        { cwd: tmpDir, mode: 'AUTO_PILOT' }
      );
      assert.equal(switchRes.exitCode, 2);
      assert.equal(switchRes.verdict.blocked, true);
      assert.equal(switchRes.verdict.recommendedModel, 'claude-opus-5-5');

      const stopSafe = runStopGateHook({
        stop_hook_active: true,
        hasUnverifiedEdits: true,
        mode: 'AUTO_PILOT'
      });
      assert.equal(stopSafe.exitCode, 0);
      assert.equal(stopSafe.stdout, '');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Phase 5.10: In-Process Mod Full Lifecycle E2E (`turn.step` -> `turn.complete` -> `tool.call` -> `command.horizon`)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-phase5-mod-'));
    try {
      const handlers = {};
      register((eventName, fn) => {
        handlers[eventName] = fn;
      });

      const store = new Map();
      let openedPane = null;
      let invalidatedCount = 0;

      const mockContext = {
        store: {
          get: (k) => store.get(k),
          set: (k, v) => store.set(k, v)
        },
        ui: {
          open: (cfg) => {
            openedPane = cfg;
          },
          invalidate: () => {
            invalidatedCount += 1;
          }
        },
        clock: {
          every: () => {}
        }
      };

      await handlers['turn.step'](
        {
          cwd: tmpDir,
          sessionId: 'sess-e2e-mod',
          model: 'claude-opus-5-5',
          result: {
            usage: {
              input_tokens: 2000,
              cache_creation_input_tokens: 30000,
              cache_read_input_tokens: 50000,
              output_tokens: 900
            }
          }
        },
        mockContext
      );

      await handlers['turn.complete'](
        {
          cwd: tmpDir,
          sessionId: 'sess-e2e-mod',
          model: 'claude-opus-5-5',
          result: {
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 82000,
              output_tokens: 600
            }
          }
        },
        mockContext
      );

      assert.ok(invalidatedCount >= 1);
      const savedTelemetry = store.get('ah_session_telemetry');
      assert.equal(savedTelemetry.turnsCompleted, 1);
      assert.equal(savedTelemetry.promptCache.warm, true);

      await handlers['command.horizon']({}, mockContext);
      assert.deepEqual(openedPane, {
        id: 'attention-horizon',
        title: 'Attention Horizon',
        closeOnEscape: true
      });

      const denyVerdict = await handlers['tool.call'](
        {
          tool_name: 'Read',
          tool_input: { file_path: '.env.production' }
        },
        mockContext,
        async () => 'ok'
      );
      assert.equal(denyVerdict.decision, 'deny');
      assert.match(denyVerdict.reason, /DET-02/);

      const askVerdict = await handlers['tool.call'](
        {
          tool_name: 'Edit',
          tool_input: { file_path: 'pnpm-lock.yaml', old_string: 'a', new_string: 'b' }
        },
        mockContext,
        async () => 'ok'
      );
      assert.equal(askVerdict.decision, 'ask');
      assert.match(askVerdict.reason, /DET-03/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Phase 5.11: Workspace isolation — tests never leak `.claude/cache` or `.claude/locks` into repo or parent directories', () => {
    const parentDir = path.resolve(PROJECT_ROOT, '..');
    assert.equal(fs.existsSync(path.join(parentDir, '.claude', 'cache')), false);
    assert.equal(fs.existsSync(path.join(parentDir, '.claude', 'locks')), false);
    assert.equal(fs.existsSync(path.join(PROJECT_ROOT, '.claude', 'cache')), false);
    assert.equal(fs.existsSync(path.join(PROJECT_ROOT, '.claude', 'locks')), false);
  });
}

if (path.resolve(process.argv[1] || '') === __filename) {
  registerComplianceTestSuite();
}
