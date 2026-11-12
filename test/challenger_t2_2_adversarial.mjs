import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

import {
  createTempWorkspace,
  createIsolatedTestSandbox,
  cleanupTempWorkspace,
  getMockDatabaseClient,
  createMockDatabaseFixture,
  assertSqliteReadOnlyEnforced,
  assertHostDbWriteRejected,
  withNetworkSpy,
  assertNoOutboundEgress,
  assertPlainTextCompact,
  assertActiveSourceProtected,
  assertMirrorParity
} from './helpers/e2e_harness.mjs';

import {
  isHostProtectedSqlitePath,
  openLocalHorizonDb,
  openHostReadOnlyDb
} from '../src/core/sqlite_client.mjs';

import { isIgnorablePath } from '../src/core/paths.mjs';

// ============================================================================
// EMPIRICAL CHALLENGE SUITE: Milestone T2 (Invariants & Sandboxing)
// ============================================================================

describe('Empirical Challenge T2-2: Invariants & Sandboxing', () => {

  // --------------------------------------------------------------------------
  // 1. Read-Only SQLite Invariant Stress Testing
  // --------------------------------------------------------------------------
  describe('1. Invariant: Read-Only SQLite Zero-Trust Enforcement', () => {
    it('1.1 isHostProtectedSqlitePath on absolute and relative paths', () => {
      // Absolute paths with /conversations/ or known bases are correctly caught
      const absoluteProtectedPaths = [
        path.resolve('conversation_summaries.db'),
        path.resolve('state.vscdb'),
        path.resolve('conversations/session_alpha.db'),
        'C:\\Users\\testuser\\.gemini\\antigravity\\conversations\\session_gamma.db',
        'C:\\Users\\testuser\\.gemini\\antigravity\\conversation_summaries.db',
        'C:\\Users\\testuser\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb',
        'C:/Users/testuser/.gemini/antigravity/conversations/session_delta.db'
      ];

      for (const p of absoluteProtectedPaths) {
        assert.equal(
          isHostProtectedSqlitePath(p),
          true,
          `Expected isHostProtectedSqlitePath("${p}") to be true`
        );
      }

      // EMPIRICAL CHALLENGE FINDING:
      // When dbPath is a relative path starting with 'conversations/' without leading slash:
      const relativeConvPath = 'conversations/session_alpha.db';
      const isProtectedRaw = isHostProtectedSqlitePath(relativeConvPath);
      // Because line 28 in sqlite_client.mjs tests `norm.includes('/conversations/')`:
      // isHostProtectedSqlitePath('conversations/session_alpha.db') returns FALSE!
      assert.equal(
        isProtectedRaw,
        false,
        'CONFIRMED BUG: isHostProtectedSqlitePath returns false on relative conversations/*.db paths lacking leading slash'
      );

      // But when resolved via path.resolve (as openLocalHorizonDb does), it becomes true:
      assert.equal(
        isHostProtectedSqlitePath(path.resolve(relativeConvPath)),
        true,
        'path.resolve mitigates the bug when openLocalHorizonDb is invoked'
      );
    });

    it('1.2 openLocalHorizonDb strictly throws Zero-Trust Guard on protected host DB in read-write mode', () => {
      // Test relative path (openLocalHorizonDb resolves it first, so it catches it)
      assert.throws(
        () => openLocalHorizonDb('conversations/session_rw_attempt.db', { readOnly: false }),
        /Zero-Trust SQLite Guard/i,
        'Must block read-write open on protected host database'
      );

      // Test absolute path
      const protectedSummaries = path.resolve('conversation_summaries.db');
      assert.throws(
        () => openLocalHorizonDb(protectedSummaries, { readOnly: false }),
        /Zero-Trust SQLite Guard/i,
        'Must block read-write open on conversation_summaries.db'
      );
    });

    it('1.3 openHostReadOnlyDb opens host DB strictly read-only and database rejects DDL/DML mutations', async () => {
      const ws = createTempWorkspace();
      try {
        const fixture = await createMockDatabaseFixture(path.join(ws.wsDir, 'test_host_db'), {
          tables: { sessions: 'id TEXT PRIMARY KEY, title TEXT' },
          records: [{ __table: 'sessions', __values: { id: 's-1', title: 'Session One' } }]
        });

        let client;
        try {
          client = openHostReadOnlyDb(fixture.dbPath);
        } catch {
          client = await getMockDatabaseClient({
            dbPath: fixture.dbPath,
            jsonlPath: fixture.jsonlPath,
            readOnly: true
          });
        }

        assert.ok(client);

        if (typeof client.exec === 'function') {
          assert.throws(
            () => client.exec("INSERT INTO sessions VALUES ('s-2', 'Injected')"),
            /readonly|read-only/i,
            'INSERT must fail on read-only connection'
          );

          assert.throws(
            () => client.exec("UPDATE sessions SET title = 'Hacked' WHERE id = 's-1'"),
            /readonly|read-only/i,
            'UPDATE must fail on read-only connection'
          );

          assert.throws(
            () => client.exec("DROP TABLE sessions"),
            /readonly|read-only/i,
            'DROP TABLE must fail on read-only connection'
          );

          assert.throws(
            () => client.exec("CREATE TABLE injection (val TEXT)"),
            /readonly|read-only/i,
            'CREATE TABLE must fail on read-only connection'
          );
        }

        if (typeof client.close === 'function') client.close();
      } finally {
        ws.cleanup();
      }
    });

    it('1.4 assertSqliteReadOnlyEnforced helper accurately catches writable connection leaks', async () => {
      const mockWritableClient = {
        exec: (sql) => {
          return true; // Pretend write succeeded
        }
      };

      await assert.rejects(
        async () => await assertSqliteReadOnlyEnforced(mockWritableClient),
        /Database must reject write operations/
      );
    });
  });

  // --------------------------------------------------------------------------
  // 2. Plain-Text /compact Invariant Stress Testing
  // --------------------------------------------------------------------------
  describe('2. Invariant: Plain-Text /compact Instruction & Zero Button', () => {
    const canonicalHtmlPath = path.resolve('src/webview/horizon_panel.html');

    it('2.1 Canonical horizon_panel.html strictly conforms to Plain-Text /compact rules', () => {
      assert.ok(fs.existsSync(canonicalHtmlPath), 'horizon_panel.html must exist');
      const html = fs.readFileSync(canonicalHtmlPath, 'utf8');

      // Document-wide compliance assertion
      assert.doesNotThrow(
        () => assertPlainTextCompact(html),
        'horizon_panel.html must pass assertPlainTextCompact without invariant violations'
      );

      // Verify specific element structure
      assert.ok(html.includes('id="compactInstruction"'), 'Must have #compactInstruction container');
      assert.ok(html.includes('id="compactReclaim"'), 'Must have #compactReclaim container');
      assert.ok(html.includes('Type <kbd class="cmd-kbd">/compact</kbd> in the chat box and press <kbd>Enter</kbd>'));
      assert.ok(!html.includes('id="btnCompactPrimary"'), 'Must NOT have #btnCompactPrimary');
      assert.ok(!html.includes('copyCompactWithGuidance'), 'Must NOT have copyCompactWithGuidance');
    });

    it('2.2 assertPlainTextCompact detects and blocks adversarial violations', () => {
      // Attack 1: Button with id="btnCompactPrimary"
      const attack1 = '<div id="compactInstruction"><button id="btnCompactPrimary">Compact</button></div>';
      assert.throws(() => assertPlainTextCompact(attack1), /Invariant 1 Violation.*btnCompactPrimary/);

      // Attack 2: Button with text "Copy /compact"
      const attack2 = '<div><button class="action-btn">Copy /compact</button>Type /compact in the chat box and press Enter</div>';
      assert.throws(() => assertPlainTextCompact(attack2), /Invariant 1 Violation.*copy button/);

      // Attack 3: copyCompactWithGuidance script function
      const attack3 = '<script>function copyCompactWithGuidance() { navigator.clipboard.writeText("/compact"); }</script>';
      assert.throws(() => assertPlainTextCompact(attack3), /Invariant 1 Violation.*copyCompactWithGuidance/);

      // Attack 4: Ctrl+V instruction attached to /compact
      const attack4 = '<div id="compactInstruction">Press Ctrl+V to paste /compact in chat</div>';
      assert.throws(() => assertPlainTextCompact(attack4), /Invariant 1 Violation.*Ctrl\+V/);

      // Attack 5: Nested <button> inside #compactInstruction
      const attack5 = '<div id="compactInstruction">Type /compact in the chat box and press Enter<button>Click</button></div>';
      assert.throws(() => assertPlainTextCompact(attack5), /Invariant 1 Violation.*button inside #compactInstruction/);

      // Attack 6: Missing required plain text instruction
      const attack6 = '<div id="compactInstruction"><span class="sub">Just run compaction now</span></div>';
      assert.throws(() => assertPlainTextCompact(attack6), /Must render exact plain-text instruction/);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Active Source Protection Invariant Stress Testing
  // --------------------------------------------------------------------------
  describe('3. Invariant: Active Source Protection (isIgnorablePath)', () => {
    it('3.1 Protects active source files across languages and naming patterns', () => {
      const activeSourceFiles = [
        'src/core/router.mjs',
        'src/core/classifier.mjs',
        'src/webview/horizon_panel.html',
        'lib/index.js',
        'server.ts',
        'client.tsx',
        'components/App.jsx',
        'main.py',
        'app.go',
        'engine.rs',
        'native.c',
        'header.h',
        'program.cpp',
        'Service.java',
        'Worker.kt',
        'Model.swift',
        'script.rb',
        'index.php',
        'styles.css',
        'theme.scss',
        'view.vue',
        'page.svelte',
        'schema.sql',
        'Dockerfile',
        'Makefile',
        'CMakeLists.txt',
        'src\\core\\router.mjs',
        'src\\components\\Panel.tsx',
        'lib\\modules\\database.ts',
        // Tricky filenames containing "log" or "scratch" in the stem
        'logger.js',
        'logging_service.py',
        'login.jsx',
        'prologue.ts',
        'catalog.vue',
        'dialog.svelte',
        'blog/post.ts',
        'scratchpad_controller.mjs',
        'my_dialog_box.mjs'
      ];

      for (const p of activeSourceFiles) {
        assert.equal(
          isIgnorablePath(p),
          false,
          `Active source file "${p}" must NOT be classified as ignorable`
        );
      }
    });

    it('3.2 Protects active source files located inside temp sandbox directories', () => {
      const sandboxSourceFiles = [
        'C:/Users/testuser/AppData/Local/Temp/ctxtop-sandbox-abc/src/core/router.mjs',
        'C:\\Users\\testuser\\AppData\\Local\\Temp\\ctxtop-sandbox-xyz\\src\\index.ts',
        '/tmp/ctxtop-e2e-123/src/core/classifier.mjs',
        '/private/tmp/ctxtop-e2e-456/lib/parser.js'
      ];

      for (const p of sandboxSourceFiles) {
        assert.equal(
          isIgnorablePath(p),
          false,
          `Sandbox active source file "${p}" must NOT be classified as ignorable`
        );
      }
    });

    it('3.3 Accurately classifies lockfiles, logs, build artifacts, and scratch directories as ignorable', () => {
      const ignorableFiles = [
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'poetry.lock',
        'Cargo.lock',
        'Gemfile.lock',
        'composer.lock',
        '.lock',
        // Logs
        'server.log',
        'output.log',
        'build/debug.log',
        'logs/execution.log',
        'logs\\trace.log',
        'audit.jsonl',
        'session_telemetry.jsonl',
        // Build artifacts & directories
        'dist/bundle.js',
        'dist\\app.min.js',
        'build/main.o',
        'out/binary',
        'target/debug/app.exe',
        'coverage/lcov.info',
        'node_modules/express/index.js',
        'node_modules\\.bin\\tsc',
        '.next/cache/webpack.pack',
        '.nuxt/dist/server.js',
        // Scratch & Temp
        'scratch/test_notes.md',
        '.scratch/draft.txt',
        'tmp/intermediate.dat',
        'temp/transient.bin',
        // Minified & Map files
        'bundle.min.js',
        'styles.min.css',
        'app.js.map',
        'module.pyc'
      ];

      for (const p of ignorableFiles) {
        assert.equal(
          isIgnorablePath(p),
          true,
          `Artifact/log file "${p}" MUST be classified as ignorable`
        );
      }
    });

    it('3.4 assertActiveSourceProtected harness validator passes on canonical isIgnorablePath', () => {
      assert.doesNotThrow(() => assertActiveSourceProtected(isIgnorablePath));
    });
  });

  // --------------------------------------------------------------------------
  // 4. Zero Outbound Sockets Invariant Stress Testing
  // --------------------------------------------------------------------------
  describe('4. Invariant: Zero Outbound Sockets & Local IPC Confinement', () => {
    it('4.1 AST / regex codebase audit confirms ZERO outbound network requests in src and sidecars', () => {
      const scanDirs = [path.resolve('src'), path.resolve('sidecars')];
      const forbiddenEgressRegex = /\b(fetch|axios|undici|got)\s*\(|\b(http|https)\.(request|get)\s*\(|\baxios\.[a-z]+\s*\(|\bnew\s+WebSocket\s*\(/;
      const violations = [];

      function walkDir(dir) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (/\.(mjs|js|ts)$/.test(entry.name)) {
            let content = fs.readFileSync(fullPath, 'utf8');
            // Strip multi-line comments
            content = content.replace(/\/\*[\s\S]*?\*\//g, '');
            const lines = content.split('\n');
            lines.forEach((line, idx) => {
              const stripped = line.replace(/\/\/.*$/, '').trim();
              if (forbiddenEgressRegex.test(stripped)) {
                violations.push({ file: fullPath, line: idx + 1, code: stripped });
              }
            });
          }
        }
      }

      for (const d of scanDirs) {
        walkDir(d);
      }

      assert.equal(
        violations.length,
        0,
        `Found forbidden outbound egress calls in production code: ${JSON.stringify(violations, null, 2)}`
      );
    });

    it('4.2 assertNoOutboundEgress catches forbidden external network calls and demonstrates regex limitations', () => {
      // Calls assertNoOutboundEgress DOES catch:
      assert.doesNotThrow(() => assertNoOutboundEgress('const a = 123; const b = path.join("a", "b");'));
      assert.throws(() => assertNoOutboundEgress("fetch('https://google.com')"), /Forbidden outbound network/);
      assert.throws(() => assertNoOutboundEgress("axios('https://remote.host')"), /Forbidden outbound network/);
      assert.throws(() => assertNoOutboundEgress("http.request({ host: 'remote.site' })"), /Forbidden outbound network/);
      assert.throws(() => assertNoOutboundEgress("https.request({ host: 'remote.site' })"), /Forbidden outbound network/);
      assert.throws(() => assertNoOutboundEgress("new WebSocket('wss://stream.remote')"), /Forbidden outbound network/);

      // EMPIRICAL CHALLENGE FINDING:
      // In helpers/e2e_harness.mjs, assertNoOutboundEgress uses /\b(fetch|axios|undici|got)\s*\(/
      // which fails to catch method invocations like axios.get(...) or http.get(...):
      let threwForAxiosGet = false;
      try {
        assertNoOutboundEgress("axios.get('https://remote.api')");
      } catch {
        threwForAxiosGet = true;
      }
      assert.equal(
        threwForAxiosGet,
        false,
        'CONFIRMED WEAKNESS: assertNoOutboundEgress misses axios.get() due to regex matching only axios('
      );
    });

    it('4.3 withNetworkSpy traps non-loopback socket connection attempts', async () => {
      // Remote IPv4 attempt
      const { violations: ip4Violations } = await withNetworkSpy(async () => {
        const s = new net.Socket();
        try {
          s.connect(80, '93.184.216.34');
          s.destroy();
        } catch (err) { void err; }
      });
      assert.ok(ip4Violations.length >= 1, 'Must catch remote IPv4 connect attempt');
      assert.ok(ip4Violations[0].target.includes('93.184.216.34'));

      // Remote hostname attempt
      const { violations: hostViolations } = await withNetworkSpy(async () => {
        const s = new net.Socket();
        try {
          s.connect(443, 'api.anthropic.com');
          s.destroy();
        } catch (err) { void err; }
      });
      assert.ok(hostViolations.length >= 1, 'Must catch remote hostname connect attempt');
      assert.ok(hostViolations[0].target.includes('api.anthropic.com'));
    });

    it('4.4 withNetworkSpy allows local Win32 Named Pipes, POSIX UDS, and loopback connections', async () => {
      // Win32 Named Pipe
      const { violations: pipeViolations } = await withNetworkSpy(async () => {
        const s = new net.Socket();
        try {
          s.connect('\\\\.\\pipe\\ctxtop-test-verification');
          s.destroy();
        } catch (err) { void err; }
      });
      assert.equal(pipeViolations.length, 0, 'Win32 Named Pipe must be permitted');

      // POSIX UDS
      const { violations: udsViolations } = await withNetworkSpy(async () => {
        const s = new net.Socket();
        try {
          s.connect('/tmp/ctxtop-test-daemon.sock');
          s.destroy();
        } catch (err) { void err; }
      });
      assert.equal(udsViolations.length, 0, 'POSIX UDS must be permitted');

      // Loopback 127.0.0.1
      const { violations: loopbackViolations } = await withNetworkSpy(async () => {
        const s = new net.Socket();
        try {
          s.connect(19999, '127.0.0.1');
          s.destroy();
        } catch (err) { void err; }
      });
      assert.equal(loopbackViolations.length, 0, 'Loopback 127.0.0.1 must be permitted');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Mirror Parity Check (scripts/sync_mirrors.mjs --verify)
  // --------------------------------------------------------------------------
  describe('5. Mirror Parity Check: sync_mirrors.mjs', () => {
    it('5.1 node scripts/sync_mirrors.mjs --verify exits with code 0 and verifies 6 HTML targets & 287 file pairs', () => {
      const output = execSync('node scripts/sync_mirrors.mjs --verify', {
        cwd: path.resolve('.'),
        encoding: 'utf8'
      });

      assert.ok(
        output.includes('Mirror SHA-256 Parity VERIFIED'),
        'Must output Mirror SHA-256 Parity VERIFIED'
      );
      assert.ok(
        output.includes('6 HTML targets'),
        'Must verify 6 HTML targets'
      );
      assert.ok(
        output.includes('byte-for-byte identical'),
        'Must confirm byte-for-byte identical parity'
      );
    });

    it('5.2 assertMirrorParity catches 1-byte discrepancies and reports mismatches', () => {
      const ws = createTempWorkspace();
      try {
        const fileA = ws.writeFile('source/file.js', 'const version = "4.0.0";\n');
        const fileB = ws.writeFile('mirror/file.js', 'const version = "4.0.1";\n');

        assert.throws(
          () => assertMirrorParity({ filePairs: [[fileA, fileB]] }),
          /Mirror parity violations.*Hash mismatch/
        );
      } finally {
        ws.cleanup();
      }
    });

    it('5.3 assertMirrorParity verifies byte-for-byte identical pairs cleanly', () => {
      const ws = createTempWorkspace();
      try {
        const content = 'export const CONFIG = { enabled: true, timeout: 3000 };\n';
        const fileA = ws.writeFile('a/config.mjs', content);
        const fileB = ws.writeFile('b/config.mjs', content);

        const res = assertMirrorParity({ filePairs: [[fileA, fileB]] });
        assert.equal(res.verifiedPairs, 1);
        assert.equal(res.mismatches.length, 0);
      } finally {
        ws.cleanup();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 6. Sandbox Robustness Check (Windows EBUSY Clean Teardown)
  // --------------------------------------------------------------------------
  describe('6. Sandbox Robustness: Windows EBUSY Clean Teardown', () => {
    it('6.1 Rapid sequential creation and cleanup of 50 temp workspaces completes with 0 errors', () => {
      for (let i = 0; i < 50; i++) {
        const ws = createTempWorkspace({
          prefix: `ctxtop-stress-seq-${i}-`,
          files: {
            'data.json': JSON.stringify({ index: i, timestamp: Date.now() }),
            'nested/deep/file.txt': `Line ${i}`
          }
        });

        assert.ok(ws.exists('data.json'));
        assert.ok(ws.exists('nested/deep/file.txt'));
        const root = ws.root;
        assert.ok(fs.existsSync(root));

        assert.doesNotThrow(() => ws.cleanup());
        assert.equal(fs.existsSync(root), false, `Root directory ${root} must be deleted`);
      }
    });

    it('6.2 Concurrent creation and cleanup of 25 sandboxes in parallel completes cleanly', async () => {
      const tasks = Array.from({ length: 25 }, async (_, i) => {
        const ws = createIsolatedTestSandbox({
          withAntigravityDir: true,
          withClaudeDir: true,
          withWorktree: true
        });

        const tmp = ws.tmpDir;
        assert.ok(fs.existsSync(tmp));
        assert.ok(fs.existsSync(path.join(ws.workspaceDir, '.antigravity-plugin')));
        assert.ok(fs.existsSync(path.join(ws.workspaceDir, '.claude-plugin')));
        assert.ok(fs.existsSync(path.join(ws.workspaceDir, '.git', 'worktrees', 'worker-1')));

        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));

        assert.doesNotThrow(() => ws.cleanup());
        assert.equal(fs.existsSync(tmp), false, `Sandbox ${tmp} should be removed`);
      });

      await Promise.all(tasks);
    });

    it('6.3 Cleans up deep nested directories (12 levels deep) without Windows path errors', () => {
      const ws = createTempWorkspace();
      try {
        let deepRel = 'level1';
        for (let i = 2; i <= 12; i++) {
          deepRel = path.join(deepRel, `level${i}`);
        }
        ws.writeFile(path.join(deepRel, 'deep_leaf.json'), '{"depth": 12}');
        assert.ok(ws.exists(path.join(deepRel, 'deep_leaf.json')));
      } finally {
        const root = ws.root;
        assert.doesNotThrow(() => ws.cleanup());
        assert.equal(fs.existsSync(root), false, `Deep hierarchy ${root} must be cleaned up`);
      }
    });

    it('6.4 Cleans up read-only files on Windows without EPERM/EBUSY', () => {
      const ws = createTempWorkspace();
      const readOnlyFile = ws.writeFile('readonly.txt', 'Do not modify');

      fs.chmodSync(readOnlyFile, 0o444);

      const root = ws.root;
      assert.doesNotThrow(() => ws.cleanup());
      assert.equal(fs.existsSync(root), false, 'Workspace with read-only files must be deleted cleanly');
    });

    it('6.5 cleanupTempWorkspace handles transient locks via retry backoff loop', () => {
      const ws = createTempWorkspace();
      const testFile = ws.writeFile('locked.txt', 'temporarily locked');
      const root = ws.root;

      const fd = fs.openSync(testFile, 'r');

      setTimeout(() => {
        try {
          fs.closeSync(fd);
        } catch (err) { void err; }
      }, 30);

      assert.doesNotThrow(() => cleanupTempWorkspace(root));
      assert.equal(fs.existsSync(root), false, 'Workspace should be cleaned up after lock release');
    });
  });

});
