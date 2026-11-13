/**
 * @file test/challenger_m1_mod_laws.mjs
 * Empirical Challenger Verification Suite for Milestone 1:
 * - Adversarial scanner bypass stress-testing against Mod Laws 1–5
 * - Exhaustive static audit of all files in src/core-isomorphic/ (strictly 0 node:* imports)
 * - Transitive graph closure analysis from hooks/register.js
 * - Sandboxed V8 execution without process.getBuiltinModule
 * - USTF v1 trajectory edge case and performance stress harness
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  scanJsTokens,
  validateModLaw1,
  validateModLaw2,
  validateModLaw3,
  validateModLaw4Imports,
  validateModLaw5ToolCallCatch,
  collectJsFiles
} from './mod_static_compliance.test.mjs';

import register from '../hooks/register.js';
import * as isomorphicBarrel from '../src/core-isomorphic/index.js';
import {
  USTF_EVENT_TYPES,
  USTF_SPAN_KINDS,
  validateUstfTrajectory,
  validateUstfEvent,
  validateUstfSpan,
  validateUstfUsage,
  createEmptyUstfSession,
  normalizeSessionTrajectory,
  normalizeClaudeCodeSession,
  normalizeAntigravitySession
} from '../src/core-isomorphic/ustf/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ============================================================================
// SUITE 1: Adversarial Scanner Bypass Stress-Testing (Mod Laws 1–5)
// ============================================================================

test('Challenger 1.1: Scanner correctly rejects sneaky variable assignment and destructuring bypasses (Mod Law 1)', () => {
  const attacks = [
    {
      name: 'Direct assignment: const sneaky = $',
      code: 'const sneaky = $;'
    },
    {
      name: 'Uninvoked namespace assignment: const s = $.store',
      code: 'const s = $.store;'
    },
    {
      name: 'Uninvoked method assignment: const g = $.store.get',
      code: 'const g = $.store.get;'
    },
    {
      name: 'Object destructuring of $: const { store } = $',
      code: 'const { store } = $;'
    },
    {
      name: 'Aliased object destructuring: const { store: s } = $',
      code: 'const { store: s } = $;'
    },
    {
      name: 'Destructuring of $.store: const { get } = $.store',
      code: 'const { get } = $.store;'
    },
    {
      name: 'Computed property access assignment: const s = $["store"]',
      code: 'const s = $["store"];'
    },
    {
      name: 'Assignment with preceding multiline comment: /* evil */ const s = $',
      code: '/* evil comment */ const s = $;'
    },
    {
      name: 'Assignment with newline between tokens: const s =\n  $',
      code: 'const s =\n  $;'
    },
    {
      name: 'Assignment with rest destructuring: const { ...rest } = $',
      code: 'const { ...rest } = $;'
    },
    {
      name: 'Assignment with computed property destructuring: const { ["store"]: s } = $',
      code: 'const { ["store"]: s } = $;'
    },
    {
      name: 'Assignment inside for loop header: for (let s = $; ; ) {}',
      code: 'for (let s = $; ; ) {}'
    },
    {
      name: 'Assignment inside while condition: while (s = $) {}',
      code: 'while (s = $) {}'
    },
    {
      name: 'Assignment inside if condition: if (s = $) {}',
      code: 'if (s = $) {}'
    }
  ];

  for (const attack of attacks) {
    const res = validateModLaw1(attack.code);
    assert.equal(
      res.ok,
      false,
      `Mod Law 1 scanner failed to detect attack: ${attack.name} (Code: ${attack.code})`
    );
  }

  // Legitimate direct capability call assignment MUST pass
  const validDirectCall = 'const val = $.store.get("myKey");';
  const validRes = validateModLaw1(validDirectCall);
  assert.equal(validRes.ok, true, `Mod Law 1 falsely rejected legitimate call: ${validRes.violations.join('; ')}`);

  // Direct capability call with optional namespace $.store?.get("myKey") MUST pass
  const validOptionalNsCall = 'const val = $.store?.get("myKey");';
  const validOptNsRes = validateModLaw1(validOptionalNsCall);
  assert.equal(validOptNsRes.ok, true, `Mod Law 1 falsely rejected optional namespace call: ${validOptNsRes.violations.join('; ')}`);
});

test('Challenger 1.2: Scanner correctly rejects argument passing, closures, object shorthand, and spreads (Mod Law 2)', () => {
  const attacks = [
    {
      name: 'Helper function formal parameter $: function helper($)',
      code: 'function helper($) { return $; }'
    },
    {
      name: 'Async helper function formal parameter $: async function helper($)',
      code: 'async function helper($) { return $; }'
    },
    {
      name: 'Arrow function single parameter: const f = $ => $',
      code: 'const f = $ => $;'
    },
    {
      name: 'Arrow function parenthesized parameter: const f = ($) => $',
      code: 'const f = ($) => $;'
    },
    {
      name: 'Arrow function multi-parameter: const f = (a, $) => $',
      code: 'const f = (a, $) => $;'
    },
    {
      name: 'Passing $ as argument to helper: helper($)',
      code: 'helper($);'
    },
    {
      name: 'Passing $.store as argument to helper: helper($.store)',
      code: 'helper($.store);'
    },
    {
      name: 'Object literal shorthand { $ }',
      code: 'const obj = { $ };'
    },
    {
      name: 'Object literal explicit property { s: $ }',
      code: 'const obj = { s: $ };'
    },
    {
      name: 'Array literal [ $ ]',
      code: 'const arr = [ $ ];'
    },
    {
      name: 'Array spread [...$]',
      code: 'const arr = [...$];'
    },
    {
      name: 'Object spread {...$}',
      code: 'const obj = {...$};'
    },
    {
      name: 'Object spread with namespace {...$.store}',
      code: 'const obj = {...$.store};'
    },
    {
      name: 'Ternary passing $: const s = cond ? $ : null',
      code: 'const s = cond ? $ : null;'
    },
    {
      name: 'Logical expression passing $: const s = $ || null',
      code: 'const s = $ || null;'
    },
    {
      name: 'Parenthesized $: const s = ($)',
      code: 'const s = ($);'
    },
    {
      name: 'Template literal interpolation with bare $: `val: ${$}`',
      code: 'const s = `val: ${$}`;'
    },
    {
      name: 'Template literal interpolation with $.store: `val: ${$.store}`',
      code: 'const s = `val: ${$.store}`;'
    },
    {
      name: 'Nested template literal with $: `outer ${ `inner ${ $ }` }`',
      code: 'const s = `outer ${ `inner ${ $ }` }`;'
    },
    {
      name: 'Class method parameter $: class Foo { leak($) {} }',
      code: 'class Foo { leak($) {} }'
    },
    {
      name: 'Object method named $: const obj = { $(arg) {} }',
      code: 'const obj = { $(arg) {} };'
    },
    {
      name: 'For-in iteration over $: for (const k in $) {}',
      code: 'for (const k in $) {}'
    },
    {
      name: 'For-of iteration over $: for (const v of $) {}',
      code: 'for (const v of $) {}'
    },
    {
      name: 'Nested helper inside direct on(...) callback',
      code: `
        on('tool.call', (evt, $) => {
          function sneakyHelper($) { return $; }
          return Promise.resolve().then(() => {}).catch(() => ({ decision: 'deny' }));
        });
      `
    }
  ];

  for (const attack of attacks) {
    const res = validateModLaw2(attack.code);
    assert.equal(
      res.ok,
      false,
      `Mod Law 2 scanner failed to detect attack: ${attack.name} (Code: ${attack.code})`
    );
  }

  // Legitimate usage MUST pass
  const validCode = `
    on('tool.call', (event, $, next) => {
      $.ui.invalidate('ui.render');
      const val = $.store.get('key');
      $.clock.every(1000, () => {});
      return Promise.resolve().then(() => {}).catch(() => ({ decision: 'deny' }));
    });
  `;
  const validRes = validateModLaw2(validCode);
  assert.equal(validRes.ok, true, `Mod Law 2 falsely rejected legitimate capability call: ${validRes.violations.join('; ')}`);
});

test('Challenger 1.3: Scanner enforces static string event names and prevents on() shadowing (Mod Law 3)', () => {
  const attacks = [
    {
      name: 'Shadowing on with const',
      code: 'const on = () => {};'
    },
    {
      name: 'Shadowing on with let',
      code: 'let on = 123;'
    },
    {
      name: 'Shadowing on with var',
      code: 'var on = null;'
    },
    {
      name: 'Shadowing on with function declaration',
      code: 'function on() {}'
    },
    {
      name: 'Dynamic event variable',
      code: 'const evt = "tool.call"; on(evt, () => {});'
    },
    {
      name: 'Template literal event name',
      code: 'on(`tool.call`, () => {});'
    },
    {
      name: 'Concatenated event name',
      code: 'on("tool" + ".call", () => {});'
    }
  ];

  for (const attack of attacks) {
    const res = validateModLaw3(attack.code);
    assert.equal(
      res.ok,
      false,
      `Mod Law 3 scanner failed to reject attack: ${attack.name} (Code: ${attack.code})`
    );
  }

  // Legitimate on registrations pass
  const validCode = `
    on('turn.step', async (event, $) => {});
    on('turn.complete', async (event, $) => {});
    on('tool.call', (event, $, next) => {});
  `;
  const validRes = validateModLaw3(validCode);
  assert.equal(validRes.ok, true, `Mod Law 3 falsely rejected valid registrations: ${validRes.violations.join('; ')}`);
  assert.deepEqual(validRes.onEvents, ['turn.step', 'turn.complete', 'tool.call']);
});

test('Challenger 1.4: Scanner prevents CommonJS, dynamic import, node builtins, and process.getBuiltinModule (Mod Law 4)', () => {
  const attacks = [
    {
      name: 'node:fs import',
      code: 'import fs from "node:fs";'
    },
    {
      name: 'node:path import',
      code: 'import path from "node:path";'
    },
    {
      name: 'node:crypto import',
      code: 'import { createHash } from "node:crypto";'
    },
    {
      name: 'Bare package specifier without relative path',
      code: 'import lodash from "lodash";'
    },
    {
      name: 'Scoped package specifier: @foo/bar',
      code: 'import { bar } from "@foo/bar";'
    },
    {
      name: 'HTTPS URL import',
      code: 'import { remote } from "https://example.com/mod.mjs";'
    },
    {
      name: 'Data URL import',
      code: 'import { evil } from "data:text/javascript,export const evil=1;";'
    },
    {
      name: 'CommonJS require call',
      code: 'const fs = require("fs");'
    },
    {
      name: 'CommonJS module.exports assignment',
      code: 'module.exports = {};'
    },
    {
      name: 'Dynamic import() invocation',
      code: 'const m = await import("./mod.mjs");'
    },
    {
      name: 'process.getBuiltinModule call',
      code: 'const fs = process.getBuiltinModule("fs");'
    },
    {
      name: 'getBuiltinModule property reference',
      code: 'const fn = getBuiltinModule;'
    }
  ];

  for (const attack of attacks) {
    const res = validateModLaw4Imports(attack.code);
    assert.equal(
      res.ok,
      false,
      `Mod Law 4 scanner failed to detect forbidden import/construct: ${attack.name}`
    );
  }

  // Legitimate relative ESM imports pass
  const validCode = `
    import { a } from './a.mjs';
    import defaultB from '../b.mjs';
    import * as c from './dir/c.mjs';
    import './sideEffect.mjs';
    export { a } from './a.mjs';
    export * from './b.mjs';
  `;
  const validRes = validateModLaw4Imports(validCode);
  assert.equal(validRes.ok, true, `Mod Law 4 falsely rejected valid ESM relative imports: ${validRes.violations.join('; ')}`);
  assert.equal(validRes.specifiers.length, 6);
});

test('Challenger 1.5: Scanner strictly enforces tool.call fail-closed .catch() and try/catch semantics (Mod Law 5)', () => {
  const attacks = [
    {
      name: 'Non-async tool.call missing .catch() entirely',
      code: `
        on('tool.call', (evt, $) => {
          return Promise.resolve({ decision: 'allow' });
        });
      `
    },
    {
      name: 'Non-async tool.call with decoy .catch on a different expression',
      code: `
        on('tool.call', (evt, $) => {
          otherPromise().catch(() => ({ decision: 'deny' }));
          return realPromise();
        });
      `
    },
    {
      name: 'Non-async tool.call catch resolves decision: "allow" instead of "deny"',
      code: `
        on('tool.call', (evt, $) => {
          return realPromise().catch(() => ({ decision: 'allow' }));
        });
      `
    },
    {
      name: 'Non-async tool.call catch re-throws an error',
      code: `
        on('tool.call', (evt, $) => {
          return realPromise().catch((err) => { throw err; });
        });
      `
    },
    {
      name: 'Async tool.call without try/catch wrapper',
      code: `
        on('tool.call', async (evt, $) => {
          return { decision: 'allow' };
        });
      `
    },
    {
      name: 'Async tool.call with statements after try/catch block',
      code: `
        on('tool.call', async (evt, $) => {
          try {
            await doStuff();
          } catch (e) {
            return { decision: 'deny' };
          }
          return { decision: 'allow' };
        });
      `
    },
    {
      name: 'Async tool.call catch block re-throwing',
      code: `
        on('tool.call', async (evt, $) => {
          try {
            return await doStuff();
          } catch (e) {
            throw e;
          }
        });
      `
    },
    {
      name: 'Async tool.call catch block returning decision: "allow"',
      code: `
        on('tool.call', async (evt, $) => {
          try {
            return await doStuff();
          } catch (e) {
            return { decision: 'allow' };
          }
        });
      `
    }
  ];

  for (const attack of attacks) {
    const res = validateModLaw5ToolCallCatch(attack.code);
    assert.equal(
      res.ok,
      false,
      `Mod Law 5 scanner failed to reject unhandled/unsafe tool.call: ${attack.name}`
    );
  }

  // Legitimate non-async tool.call with .catch fail-closed MUST pass
  const validNonAsync = `
    on('tool.call', (event, $, next) => {
      return Promise.resolve()
        .then(async () => {
          return { decision: 'allow' };
        })
        .catch((err) => {
          return { decision: 'deny', reason: err.message };
        });
    });
  `;
  const resNonAsync = validateModLaw5ToolCallCatch(validNonAsync);
  assert.equal(resNonAsync.ok, true, `Mod Law 5 falsely rejected valid non-async tool.call: ${resNonAsync.violations.join('; ')}`);

  // Legitimate async tool.call wrapped entirely in try/catch MUST pass
  const validAsync = `
    on('tool.call', async (event, $, next) => {
      try {
        return await handleTool(event);
      } catch (err) {
        return { decision: 'deny', reason: err.message };
      }
    });
  `;
  const resAsync = validateModLaw5ToolCallCatch(validAsync);
  assert.equal(resAsync.ok, true, `Mod Law 5 falsely rejected valid async tool.call: ${resAsync.violations.join('; ')}`);
});

// ============================================================================
// SUITE 2: Exhaustive Static Graph & Transitive Module Audit of src/core-isomorphic/
// ============================================================================

test('Challenger 2.1: Every single file in src/core-isomorphic/ has 0 node:* imports and 0 CJS/process.getBuiltinModule', () => {
  const isomorphicDir = path.join(PROJECT_ROOT, 'src', 'core-isomorphic');
  assert.ok(fs.existsSync(isomorphicDir), 'src/core-isomorphic directory must exist');

  const allFiles = collectJsFiles(isomorphicDir);
  assert.ok(allFiles.length >= 20, `Expected at least 20 isomorphic modules, found ${allFiles.length}`);

  for (const file of allFiles) {
    const rel = path.relative(PROJECT_ROOT, file);
    const content = fs.readFileSync(file, 'utf-8');

    // 1. Scanner check via validateModLaw4Imports (strict relative only, 0 node:*, 0 CJS, 0 dynamic import)
    const law4 = validateModLaw4Imports(content, { allowBareOrNodeSpecifiers: false });
    assert.equal(
      law4.ok,
      true,
      `Mod Law 4 violation in ${rel}: ${law4.violations.join('; ')}`
    );

    // 2. Explicit specifier scan: verify 0 node:* or bare node built-in imports
    for (const spec of law4.specifiers) {
      assert.equal(
        spec.startsWith('node:'),
        false,
        `File ${rel} imports forbidden node builtin: ${spec}`
      );
      assert.equal(
        /^(fs|path|crypto|os|child_process|process|net|http|sqlite)(\/|$)/.test(spec),
        false,
        `File ${rel} imports bare node builtin: ${spec}`
      );
    }

    // 3. Token-level verification of AST tokens (ignoring JSDoc comments): zero require(), zero process.getBuiltinModule
    const tokens = scanJsTokens(content);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type === 'ident' && tok.value === 'getBuiltinModule') {
        assert.fail(`File ${rel} contains real code token getBuiltinModule at pos ${tok.pos}`);
      }
      if (tok.type === 'ident' && tok.value === 'require' && tokens[i + 1]?.value === '(') {
        assert.fail(`File ${rel} contains real CommonJS require() at pos ${tok.pos}`);
      }
      if (tok.type === 'ident' && tok.value === 'import' && tokens[i + 1]?.value === '(') {
        assert.fail(`File ${rel} contains real dynamic import() at pos ${tok.pos}`);
      }
    }

    // 4. Verify that all relative imports in this file point to existing files
    for (const spec of law4.specifiers) {
      const resolved = path.resolve(path.dirname(file), spec);
      assert.ok(
        fs.existsSync(resolved),
        `Broken import in ${rel}: "${spec}" does not resolve to an existing file (${resolved})`
      );
      // Ensure it stays inside src/core-isomorphic/
      const relResolved = path.relative(isomorphicDir, resolved);
      assert.equal(
        relResolved.startsWith('..'),
        false,
        `Import in ${rel} escapes src/core-isomorphic/: "${spec}" -> "${resolved}"`
      );
    }
  }
});

test('Challenger 2.2: Transitive closure from hooks/register.js touches strictly pure isomorphic code and never reaches nodeIo or engine-node', () => {
  const registerEntry = path.join(PROJECT_ROOT, 'hooks', 'register.js');
  assert.ok(fs.existsSync(registerEntry), 'hooks/register.js must exist');

  const visited = new Set();
  const queue = [registerEntry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const rel = path.relative(PROJECT_ROOT, current);
    const content = fs.readFileSync(current, 'utf-8');

    // Must strictly pass Mod Law 4
    const law4 = validateModLaw4Imports(content, { allowBareOrNodeSpecifiers: false });
    assert.equal(law4.ok, true, `Mod Law 4 failure in transitive dependency ${rel}: ${law4.violations.join('; ')}`);

    for (const spec of law4.specifiers) {
      const resolved = path.resolve(path.dirname(current), spec);
      if (fs.existsSync(resolved) && /\.(m?js)$/.test(resolved)) {
        queue.push(resolved);
      }
    }
  }

  // Verify that neither src/utils/nodeIo.mjs nor src/engine-node/ is in the transitive graph
  const forbiddenFiles = [
    path.join(PROJECT_ROOT, 'src', 'utils', 'nodeIo.mjs'),
    path.join(PROJECT_ROOT, 'src', 'engine-node', 'index.mjs')
  ];

  for (const forbidden of forbiddenFiles) {
    assert.equal(
      visited.has(forbidden),
      false,
      `Forbidden file leaked into register.js transitive closure: ${forbidden}`
    );
  }

  for (const visitedFile of visited) {
    const rel = path.relative(PROJECT_ROOT, visitedFile).replace(/\\/g, '/');
    const isHooks = rel.startsWith('hooks/');
    const isCoreIso = rel.startsWith('src/core-isomorphic/');
    assert.ok(
      isHooks || isCoreIso,
      `File in register.js transitive graph is outside hooks/ and src/core-isomorphic/: ${rel}`
    );
  }

  assert.ok(visited.size >= 12, `Expected at least 12 modules in transitive closure, found ${visited.size}`);
});

// ============================================================================
// SUITE 3: Sandboxed V8 Isolate Execution Stress Test
// ============================================================================

test('Challenger 3.1: hooks/register.js executes cleanly in sandboxed V8 isolate with null nodeIo and deleted process.getBuiltinModule', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-challenger-v8-'));
  const savedGetBuiltin = process.getBuiltinModule;
  try {
    delete process.getBuiltinModule;

    const handlers = {};
    register((eventName, fn) => {
      handlers[eventName] = fn;
    });

    const expectedEvents = [
      'turn.step',
      'turn.complete',
      'tool.call',
      'command.horizon',
      'classic.SessionStart',
      'classic.PreCompact',
      'classic.PostCompact',
      'classic.Stop',
      'file.changed',
      'ui.render'
    ];

    for (const evt of expectedEvents) {
      assert.ok(typeof handlers[evt] === 'function', `Missing handler for event: ${evt}`);
    }

    const store = new Map();
    let uiInvalidations = 0;
    let openedPanes = [];
    let intervalDisposed = false;

    const mockCtx = {
      store: {
        get: (k) => store.get(k),
        set: (k, v) => store.set(k, v)
      },
      ui: {
        invalidate: (t) => { uiInvalidations += 1; },
        open: (p) => { openedPanes.push(p); }
      },
      clock: {
        every: (ms, fn) => {
          return () => { intervalDisposed = true; };
        }
      }
    };

    // 1. Test classic.SessionStart
    await handlers['classic.SessionStart']({ cwd: tmpDir, sessionId: 'sandbox-sess-1', mode: 'COACH' }, mockCtx);

    // 2. Test turn.step
    await handlers['turn.step']({
      cwd: tmpDir,
      sessionId: 'sandbox-sess-1',
      model: 'claude-opus-5-5',
      result: {
        usage: {
          input_tokens: 1500,
          cache_creation_input_tokens: 25000,
          cache_read_input_tokens: 40000,
          output_tokens: 500
        }
      }
    }, mockCtx);

    // 3. Test tool.call normal execution (allowed)
    const allowVerdict = await handlers['tool.call'](
      { cwd: tmpDir, tool_name: 'Grep', tool_input: { query: 'export' } },
      mockCtx,
      async () => ({ decision: 'allow' })
    );
    assert.deepEqual(allowVerdict, { decision: 'allow' });

    // 4. Test tool.call fault injection: store throws an error -> must fail closed with decision: 'deny'
    const faultCtx = {
      store: {
        get: () => { throw new Error('V8 memory isolate fault'); },
        set: () => {}
      },
      ui: { invalidate: () => {}, open: () => {} },
      clock: { every: () => () => {} }
    };
    const failClosedVerdict = await handlers['tool.call'](
      { cwd: tmpDir, tool_name: 'Bash', tool_input: { command: 'ls' } },
      faultCtx,
      async () => ({ decision: 'allow' })
    );
    assert.equal(failClosedVerdict.decision, 'deny');
    assert.match(failClosedVerdict.reason, /\[Highbeam Fail-Closed\]/);

    // 5. Test command.horizon
    await handlers['command.horizon']({ cwd: tmpDir }, mockCtx);
    assert.equal(openedPanes.length, 1);
    assert.equal(openedPanes[0].id, 'attention-horizon');

    // 6. Test classic.PreCompact and classic.PostCompact
    await handlers['classic.PreCompact']({ cwd: tmpDir, sessionId: 'sandbox-sess-1' }, mockCtx);
    await handlers['classic.PostCompact']({ cwd: tmpDir, sessionId: 'sandbox-sess-1' }, mockCtx);

    // 7. Test turn.complete
    await handlers['turn.complete']({
      cwd: tmpDir,
      sessionId: 'sandbox-sess-1',
      turnId: 'turn-999',
      model: 'claude-opus-5-5',
      result: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 65000,
          output_tokens: 400
        }
      }
    }, mockCtx);

    assert.ok(uiInvalidations >= 1);
  } finally {
    process.getBuiltinModule = savedGetBuiltin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Challenger 3.2: Complete isomorphic barrel src/core-isomorphic/index.js executes with globalThis.process = undefined', () => {
  const savedProcess = globalThis.process;
  try {
    delete globalThis.process;
    assert.equal(typeof globalThis.process, 'undefined');

    // Verify key isomorphic modules function without process
    assert.ok(typeof isomorphicBarrel.calculateTurnCostUSD === 'function');
    assert.ok(typeof isomorphicBarrel.joinPath === 'function');
    assert.ok(typeof isomorphicBarrel.sha256Hex === 'function');
    assert.ok(typeof isomorphicBarrel.normalizeFlightMode === 'function');
    assert.ok(typeof isomorphicBarrel.CircuitBreakerEngine === 'function');

    // Exercise path routines without process.platform
    const joined = isomorphicBarrel.joinPath('a', 'b', 'c');
    assert.ok(joined.includes('a') && joined.includes('b') && joined.includes('c'));

    // Exercise SHA-256 without node:crypto
    const hash = isomorphicBarrel.sha256Hex('hello world');
    assert.equal(hash, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  } finally {
    globalThis.process = savedProcess;
  }
});

// ============================================================================
// SUITE 4: USTF v1 Trajectory Cross-Host Stress & Edge Cases
// ============================================================================

test('Challenger 4.1: USTF v1 Schema validates strictly and rejects malformed payloads', () => {
  // Test canonical constants
  assert.equal(USTF_EVENT_TYPES.length, 9);
  assert.equal(USTF_SPAN_KINDS.length, 5);

  const emptySession = createEmptyUstfSession('test-123', 'claude-code');
  assert.equal(validateUstfTrajectory(emptySession).valid, true);

  // Reject missing sessionId
  const noId = { ...emptySession, sessionId: '' };
  assert.equal(validateUstfTrajectory(noId).valid, false);

  // Reject negative usage token counts
  const badUsage = { uncached: -10, output: 5 };
  assert.equal(validateUstfUsage(badUsage).valid, false);

  // Reject malformed span
  const badSpan = { spanId: 's1', kind: 'invalid_kind' };
  assert.equal(validateUstfSpan(badSpan).valid, false);

  // Reject malformed event
  const badEvent = { eventId: 'e1', type: 'non_existent_type' };
  assert.equal(validateUstfEvent(badEvent).valid, false);
});

test('Challenger 4.2: USTF v1 Normalizer handles Claude DAG branches, rewinds, and Antigravity steps', () => {
  // 1. Claude DAG with rewind branch
  const claudeDagSession = {
    sessionId: 'claude-dag-1',
    entries: [
      { id: 'msg-1', parentId: null, type: 'user', content: 'hello' },
      { id: 'msg-2', parentId: 'msg-1', type: 'assistant', content: 'thinking', usage: { input_tokens: 100, output_tokens: 50 } },
      // Rewind branch from msg-1
      { id: 'msg-3', parentId: 'msg-1', type: 'assistant', content: 'alternative thought', usage: { input_tokens: 110, output_tokens: 45 } }
    ]
  };
  const normalizedClaude = normalizeClaudeCodeSession(claudeDagSession);
  assert.equal(normalizedClaude.sessionId, 'claude-dag-1');
  assert.equal(normalizedClaude.harness, 'claude-code');
  assert.ok(normalizedClaude.events.length >= 2);

  // 2. Antigravity steps session
  const antigravityStepsSession = {
    sessionId: 'ag-sess-1',
    steps: [
      {
        stepId: 'step-1',
        type: 'invocation',
        timestamp: Date.now(),
        tools: [
          { name: 'read_file', input: { Path: 'foo.txt' }, durationMs: 12 }
        ],
        tokens: { prompt: 500, cached: 200, completion: 80 }
      }
    ]
  };
  const normalizedAg = normalizeAntigravitySession(antigravityStepsSession);
  assert.equal(normalizedAg.sessionId, 'ag-sess-1');
  assert.equal(normalizedAg.harness, 'antigravity');
  assert.ok(normalizedAg.events.length >= 1);

  // 3. Auto-detection
  const autoClaude = normalizeSessionTrajectory(claudeDagSession);
  assert.equal(autoClaude.harness, 'claude-code');

  const autoAg = normalizeSessionTrajectory(antigravityStepsSession);
  assert.equal(autoAg.harness, 'antigravity');
});

test('Challenger 4.3: USTF v1 Trajectory high-volume event stress performance', () => {
  const session = createEmptyUstfSession('stress-sess', 'claude-code');
  const start = performance.now();

  // Ingest 500 events
  for (let i = 0; i < 500; i++) {
    const evt = {
      eventId: `evt-${i}`,
      type: 'tool.call',
      timestampMs: Date.now() + i,
      data: { tool_name: 'ReadFile', input: { path: `file-${i}.txt` } }
    };
    const valid = validateUstfEvent(evt);
    assert.equal(valid.valid, true);
    session.events.push(evt);
  }

  const durationMs = performance.now() - start;
  assert.ok(durationMs < 200, `Expected 500 USTF event validations in <200ms, took ${durationMs.toFixed(2)}ms`);
  assert.equal(session.events.length, 500);
});
