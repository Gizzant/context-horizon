/**
 * @file test/challenger_t4_r2_2_empirical.test.mjs
 * Empirical Challenge Harness for Milestone T4 Iteration 2 (E2E Testing Track)
 * Challenger 2: Verification of Sandbox Hermeticity & Multi-Tenant Invariant Concurrency
 *
 * Mandate:
 * 1. Test 3.2 Sandbox Hermeticity:
 *    - Verify ctxtop init executed with cwd and homeDir directed to an ephemeral sandbox
 *      writes strictly into that sandbox.
 *    - Assert zero files written to repository root or user's actual home directory.
 * 2. Test 3.41 Multi-Tenant Invariant Concurrency:
 *    - Execute 16 concurrent workers executing all 6 canonical invariants:
 *      * Invariant 1: Plain-text /compact instruction, no button.
 *      * Invariant 2: Active source protection via isIgnorablePath.
 *      * Invariant 3: Byte-for-byte SHA-256 mirror parity.
 *      * Invariant 4: Zero-Trust read-only SQLite guard.
 *      * Invariant 5: Zero outbound socket egress.
 *      * Invariant 6: Zero-PII sanitization airlock.
 *    - Assert composite prompt sufficiency score >= 96.25 for all workers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  createIsolatedTestSandbox,
  createTempWorkspace,
  cleanupTempWorkspace,
  assertPlainTextCompact,
  assertActiveSourceProtected,
  assertMirrorParity,
  assertNoOutboundEgress,
  createMockDatabaseFixture,
  isSqliteAvailable
} from './helpers/e2e_harness.mjs';

import { isIgnorablePath, getHomeDir } from '../src/core/paths.mjs';
import { sanitizeForensicPayload } from '../src/core/sanitizer.mjs';
import { sanitizeSubagentPayload } from '../src/core/coach/subagent_ipi_sanitizer.mjs';
import { scorePromptSufficiency, RUBRIC_DIMENSIONS, SUFFICIENCY_BANDS } from '../src/core/prompt_rubric.mjs';
import { SqliteDatabaseSyncWrapper } from '../src/engine-node/db/sqlite_wrapper.mjs';
import { executeInitSubcommand, runCli } from '../bin/ctxtop.mjs';

/**
 * Gets exact stat metadata for target candidate leak paths across repo root and user home.
 * @param {string[]} pathsToCheck
 * @returns {Map<string, { exists: boolean, size?: number, mtimeMs?: number }>}
 */
function probeTargetPaths(pathsToCheck) {
  const result = new Map();
  for (const p of pathsToCheck) {
    if (fs.existsSync(p)) {
      try {
        const st = fs.statSync(p);
        result.set(p, { exists: true, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        result.set(p, { exists: true });
      }
    } else {
      result.set(p, { exists: false });
    }
  }
  return result;
}

/**
 * Compares target probed paths and asserts no modifications or additions.
 * @param {Map<string, { exists: boolean, size?: number, mtimeMs?: number }>} before
 * @param {Map<string, { exists: boolean, size?: number, mtimeMs?: number }>} after
 * @returns {string[]} List of violated paths
 */
function getPathViolations(before, after) {
  const violations = [];
  for (const [p, b] of before.entries()) {
    const a = after.get(p);
    if (!a) continue;
    if (!b.exists && a.exists) {
      violations.push(`Created unexpected file: ${p}`);
    } else if (b.exists && !a.exists) {
      violations.push(`Unexpectedly removed file: ${p}`);
    } else if (b.exists && a.exists) {
      if (b.mtimeMs !== a.mtimeMs || b.size !== a.size) {
        violations.push(`Mutated existing file: ${p} (mtime ${b.mtimeMs} -> ${a.mtimeMs}, size ${b.size} -> ${a.size})`);
      }
    }
  }
  return violations;
}

describe('Challenger 2 — Empirical Challenge: Sandbox Hermeticity (Test 3.2)', () => {
  const repoRoot = path.resolve('.');
  const actualHome = os.homedir();

  // All known configuration/plugin candidate paths that ctxtop init might touch
  const candidateHostPaths = [
    // Repository root candidate leak paths
    path.join(repoRoot, '.agents', 'plugins', 'agy-horizon-flightcheck', 'plugin.json'),
    path.join(repoRoot, '.agents', 'plugins', 'agy-horizon-flightcheck', 'hooks.json'),
    path.join(repoRoot, '.claude', 'settings.json'),
    path.join(repoRoot, '.git', 'info', 'exclude'),
    path.join(repoRoot, '.attention-horizon.json'),

    // Actual user profile (~/.gemini and ~/.claude) candidate leak paths
    path.join(actualHome, '.gemini', 'antigravity', 'settings.json'),
    path.join(actualHome, '.gemini', 'antigravity', 'settings.json.bak'),
    path.join(actualHome, '.gemini', 'antigravity-cli', 'settings.json'),
    path.join(actualHome, '.gemini', 'antigravity-cli', 'settings.json.bak'),
    path.join(actualHome, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck', 'plugin.json'),
    path.join(actualHome, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck', 'hooks.json'),
    path.join(actualHome, '.gemini', 'config', 'plugins', 'agy-horizon'),
    path.join(actualHome, '.claude', 'settings.json')
  ];

  it('3.2.1 Hermetic Workspace Init: writes strictly into sandbox and zero files into repo root or actual homeDir', () => {
    const stateBefore = probeTargetPaths(candidateHostPaths);
    const sandbox = createIsolatedTestSandbox({ withAntigravityDir: true, withClaudeDir: true });

    try {
      const res = executeInitSubcommand(['--all', '--workspace'], {
        cwd: sandbox.workspaceDir,
        homeDir: sandbox.homeDir
      });

      assert.equal(res.ok, true, 'executeInitSubcommand must exit ok');
      assert.equal(res.exitCode, 0);

      // Verify files created inside sandbox workspace
      const claudeSettings = path.join(sandbox.workspaceDir, '.claude', 'settings.json');
      assert.ok(fs.existsSync(claudeSettings), 'Claude settings.json must exist in sandbox workspace');

      const agPluginDir = path.join(sandbox.workspaceDir, '.agents', 'plugins', 'agy-horizon-flightcheck');
      assert.ok(fs.existsSync(path.join(agPluginDir, 'plugin.json')), 'plugin.json must exist in sandbox plugin dir');
      assert.ok(fs.existsSync(path.join(agPluginDir, 'hooks.json')), 'hooks.json must exist in sandbox plugin dir');

      // Verify files created inside sandbox home
      const agSettings = path.join(sandbox.homeDir, '.gemini', 'antigravity', 'settings.json');
      assert.ok(fs.existsSync(agSettings), 'settings.json must exist in sandbox home');

      // Assert ZERO changes to candidate host paths
      const stateAfter = probeTargetPaths(candidateHostPaths);
      const violations = getPathViolations(stateBefore, stateAfter);
      assert.equal(violations.length, 0, `Host paths leaked or mutated: ${violations.join('; ')}`);
    } finally {
      sandbox.cleanup();
    }
  });

  it('3.2.2 Hermetic Global Init: writes strictly into sandbox homeDir and zero files into actual homeDir', () => {
    const stateBefore = probeTargetPaths(candidateHostPaths);
    const sandbox = createIsolatedTestSandbox();

    try {
      const res = executeInitSubcommand(['--all', '--global'], {
        cwd: sandbox.workspaceDir,
        homeDir: sandbox.homeDir
      });

      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);

      // Verify deployed target in global mode is inside sandbox.homeDir
      const globalPluginDir = path.join(sandbox.homeDir, '.gemini', 'config', 'plugins', 'agy-horizon-flightcheck');
      assert.ok(fs.existsSync(globalPluginDir), 'Global plugin must be deployed inside sandbox home');
      assert.ok(fs.existsSync(path.join(globalPluginDir, 'plugin.json')), 'plugin.json must exist in global plugin dir');

      const globalClaudeSettings = path.join(sandbox.homeDir, '.claude', 'settings.json');
      assert.ok(fs.existsSync(globalClaudeSettings), 'Global Claude settings must exist in sandbox home');

      // Assert ZERO changes to actual home directory
      const stateAfter = probeTargetPaths(candidateHostPaths);
      const violations = getPathViolations(stateBefore, stateAfter);
      assert.equal(violations.length, 0, `Global init leaked into host paths: ${violations.join('; ')}`);
    } finally {
      sandbox.cleanup();
    }
  });

  it('3.2.3 Dry-Run Init: performs zero writes anywhere on disk', () => {
    const sandbox = createIsolatedTestSandbox();
    try {
      const res = executeInitSubcommand(['--all', '--workspace', '--dry-run'], {
        cwd: sandbox.workspaceDir,
        homeDir: sandbox.homeDir
      });

      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);

      // Verify no settings or plugins were written
      const claudeSettings = path.join(sandbox.workspaceDir, '.claude', 'settings.json');
      assert.equal(fs.existsSync(claudeSettings), false, 'Dry-run must not create .claude/settings.json');

      const agPluginDir = path.join(sandbox.workspaceDir, '.agents', 'plugins', 'agy-horizon-flightcheck');
      assert.equal(fs.existsSync(agPluginDir), false, 'Dry-run must not create .agents/plugins directory');

      const agSettings = path.join(sandbox.homeDir, '.gemini', 'antigravity', 'settings.json');
      assert.equal(fs.existsSync(agSettings), false, 'Dry-run must not create .gemini/antigravity/settings.json');
    } finally {
      sandbox.cleanup();
    }
  });

  it('3.2.4 Standalone Subprocess Invocation: executing bin/ctxtop.mjs init strictly respects redirected environment and cwd', () => {
    const stateBefore = probeTargetPaths(candidateHostPaths);
    const sandbox = createIsolatedTestSandbox({ withAntigravityDir: true });

    try {
      const cliPath = path.resolve('bin', 'ctxtop.mjs');
      const env = {
        ...process.env,
        USERPROFILE: sandbox.homeDir,
        HOME: sandbox.homeDir
      };

      const stdout = execFileSync(process.execPath, [cliPath, 'init', '--all', '--workspace'], {
        cwd: sandbox.workspaceDir,
        env,
        encoding: 'utf8'
      });

      assert.ok(stdout.includes('Zero-Config Unified Installer') || stdout.includes('Installation complete'));

      // Verify files created inside sandbox workspace
      const claudeSettings = path.join(sandbox.workspaceDir, '.claude', 'settings.json');
      assert.ok(fs.existsSync(claudeSettings), 'Subprocess must create .claude/settings.json in sandbox');

      const agPluginDir = path.join(sandbox.workspaceDir, '.agents', 'plugins', 'agy-horizon-flightcheck');
      assert.ok(fs.existsSync(path.join(agPluginDir, 'plugin.json')), 'Subprocess must create plugin.json in sandbox');

      // Verify files created inside sandbox home
      const agSettings = path.join(sandbox.homeDir, '.gemini', 'antigravity', 'settings.json');
      assert.ok(fs.existsSync(agSettings), 'Subprocess must create settings.json in sandbox homeDir');

      // Assert ZERO host path leaks
      const stateAfter = probeTargetPaths(candidateHostPaths);
      const violations = getPathViolations(stateBefore, stateAfter);
      assert.equal(violations.length, 0, `Subprocess init leaked into host paths: ${violations.join('; ')}`);
    } finally {
      sandbox.cleanup();
    }
  });
});

describe('Challenger 2 — Empirical Challenge: Multi-Tenant Invariant Concurrency (Test 3.41)', () => {
  it('3.41.1 Executes 16 concurrent workers enforcing all 6 canonical invariants with sufficiency >= 96.25', async () => {
    const WORKER_COUNT = 16;
    const sqliteReady = await isSqliteAvailable();

    const tasks = Array.from({ length: WORKER_COUNT }, async (_, workerId) => {
      const ws = createIsolatedTestSandbox({ withAntigravityDir: true });
      try {
        // ====================================================================
        // Invariant 1: Plain-Text /compact Instruction & No Clickable Buttons
        // ====================================================================
        // Positive verification
        assertPlainTextCompact('<div id="compactInstruction">Type /compact in the chat box and press Enter</div>');

        // Adversarial challenge: forbidden copy button must throw
        assert.throws(
          () => assertPlainTextCompact('<button id="btnCompactPrimary">Copy /compact</button>'),
          /Invariant 1 Violation/
        );
        // Adversarial challenge: forbidden copy function must throw
        assert.throws(
          () => assertPlainTextCompact('<button onclick="copyCompactWithGuidance()">Copy</button>'),
          /Invariant 1 Violation/
        );
        // Adversarial challenge: forbidden Ctrl+V paste instruction must throw
        assert.throws(
          () => assertPlainTextCompact('<div id="compactInstruction">Press Ctrl+V to paste /compact</div>'),
          /Invariant 1 Violation/
        );

        // ====================================================================
        // Invariant 2: Active Source File Protection via isIgnorablePath
        // ====================================================================
        // Positive verification
        assertActiveSourceProtected(isIgnorablePath);

        // Adversarial challenge: active source files across languages and platforms
        const activeSourceFiles = [
          'src/core/router.mjs',
          'src\\core\\router.mjs',
          'src/webview/horizon_panel.html',
          'src\\webview\\horizon_panel.html',
          'lib/index.js',
          'main.py',
          'app.ts',
          'Component.tsx',
          'engine.rs',
          'main.go',
          'Kernel.java',
          'server.c',
          'header.h',
          'scripts/sync_mirrors.mjs'
        ];
        for (const file of activeSourceFiles) {
          assert.equal(isIgnorablePath(file), false, `Active source file ${file} was falsely classified as ignorable`);
        }

        // Ignorable build artifacts, lockfiles, and logs
        const ignorableFiles = [
          'package-lock.json',
          'yarn.lock',
          'pnpm-lock.yaml',
          'poetry.lock',
          'Cargo.lock',
          'build/output.log',
          'dist/bundle.min.js',
          'dist\\bundle.min.js',
          'coverage/lcov.info',
          '.next/cache/webpack.log',
          'tmp/scratch.json'
        ];
        for (const file of ignorableFiles) {
          assert.equal(isIgnorablePath(file), true, `Ignorable file ${file} was not recognized as ignorable`);
        }

        // ====================================================================
        // Invariant 3: Byte-for-Byte SHA-256 Mirror Parity
        // ====================================================================
        const pA = path.join(ws.workspaceDir, `plugin_${workerId}_A.mjs`);
        const pB = path.join(ws.workspaceDir, `plugin_${workerId}_B.mjs`);
        const pDiff = path.join(ws.workspaceDir, `plugin_${workerId}_Diff.mjs`);

        fs.writeFileSync(pA, `export const tenantId = ${workerId};`);
        fs.writeFileSync(pB, `export const tenantId = ${workerId};`);
        fs.writeFileSync(pDiff, `export const tenantId = ${workerId + 999};`);

        const mirrorRes = assertMirrorParity({ filePairs: [[pA, pB]] });
        assert.equal(mirrorRes.verifiedPairs, 1);
        assert.equal(mirrorRes.mismatches.length, 0);

        // Adversarial challenge: modified byte must trigger violation
        assert.throws(
          () => assertMirrorParity({ filePairs: [[pA, pDiff]] }),
          /Mirror parity violations/
        );

        // ====================================================================
        // Invariant 4: Zero-Trust Read-Only SQLite Guard
        // ====================================================================
        // Adversarial challenge: constructor with readOnly: false must throw
        assert.throws(
          () => new SqliteDatabaseSyncWrapper(path.join(ws.workspaceDir, 'guard.db'), { readOnly: false }),
          /Zero-Trust SQLite Guard/
        );

        if (sqliteReady) {
          const fixture = await createMockDatabaseFixture(path.join(ws.workspaceDir, `db_${workerId}`), {
            tables: { t: 'id INT' },
            records: [{ __table: 't', __values: { id: workerId } }]
          });
          const db = new SqliteDatabaseSyncWrapper(fixture.dbPath, { readOnly: true });

          // Positive read query
          assert.equal(db.get('SELECT count(*) as c FROM t').c, 1);

          // Adversarial mutation attempts must throw
          assert.throws(() => db.get('INSERT INTO t VALUES (99)'), /Zero-Trust SQLite Guard/);
          assert.throws(() => db.get('UPDATE t SET id = 0'), /Zero-Trust SQLite Guard/);
          assert.throws(() => db.get('DELETE FROM t'), /Zero-Trust SQLite Guard/);
          assert.throws(() => db.get('DROP TABLE t'), /Zero-Trust SQLite Guard/);
          assert.throws(() => db.get('CREATE TABLE evil (x INT)'), /Zero-Trust SQLite Guard/);
          assert.throws(() => db.get('ALTER TABLE t ADD COLUMN x INT'), /Zero-Trust SQLite Guard/);
          assert.throws(() => db.get("ATTACH DATABASE ':memory:' AS evil"), /Zero-Trust SQLite Guard/);
          assert.throws(() => db.get('VACUUM'), /Zero-Trust SQLite Guard/);

          db.close();
        }

        // ====================================================================
        // Invariant 5: Zero Outbound Socket Egress
        // ====================================================================
        // Positive verification
        assert.doesNotThrow(() => assertNoOutboundEgress('const localOnly = true; const x = 42;'));

        // Adversarial challenge: forbidden outbound calls must throw
        assert.throws(() => assertNoOutboundEgress('fetch("https://evil.com")'), /Forbidden outbound network egress/);
        assert.throws(() => assertNoOutboundEgress('axios("http://1.2.3.4")'), /Forbidden outbound network egress/);
        assert.throws(() => assertNoOutboundEgress('http.request({ host: "evil.com" })'), /Forbidden outbound network egress/);
        assert.throws(() => assertNoOutboundEgress('https.request("https://evil.com")'), /Forbidden outbound network egress/);
        assert.throws(() => assertNoOutboundEgress('new WebSocket("wss://evil.com")'), /Forbidden outbound network egress/);

        // ====================================================================
        // Invariant 6: Zero-PII Sanitization & Unicode Tag Airlock
        // ====================================================================
        // Secret sanitization
        const rawPayload = `worker=${workerId} token=sk-ant-api03-testkey-${workerId}-secret123456789`;
        const sanitized = sanitizeForensicPayload(rawPayload);
        assert.ok(sanitized.sanitized.includes('[REDACTED:ANTHROPIC_KEY]'));
        assert.ok(!sanitized.sanitized.includes(`testkey-${workerId}-secret123456789`));

        // Unicode tag and steganography airlock
        const injectedStego = `Turn ${workerId}: \u{E0001}\u{E0041}\u{E0042}normal text\u200B\uFEFF`;
        const stegoResult = sanitizeSubagentPayload(injectedStego, `subagent-${workerId}`, { truncate: false });
        assert.ok(!stegoResult.cleanedText.includes('\u{E0001}'));
        assert.ok(!stegoResult.cleanedText.includes('\u{E0041}'));
        assert.ok(!stegoResult.cleanedText.includes('\u200B'));
        assert.ok(!stegoResult.cleanedText.includes('\uFEFF'));
        assert.ok(stegoResult.ipiStrippedCount >= 3);

        // ====================================================================
        // Composite Prompt Sufficiency Benchmark (Requirement >= 96.25/100)
        // ====================================================================
        const highSufficiencyPrompt = [
          'Implement Feature 41 E2E Test Suite in test/e2e_tier1_features.test.mjs.',
          'Ensure 41 feature suites pass without touching other workspace files.',
          'Verify exit code 0 and expect output returns pass,',
          'assert strict zero-dep compliance with invariant constraints,',
          'and check caller imports in bin/ctxtop.mjs and src/core/prompt_rubric.mjs for mirror sync.'
        ].join(' ');

        const rubric = scorePromptSufficiency(highSufficiencyPrompt, {
          activeSetPaths: ['test/e2e_tier1_features.test.mjs', 'src/core/prompt_rubric.mjs']
        });

        const compositeScore = parseFloat(((rubric.score / (RUBRIC_DIMENSIONS.length * 2)) * 100).toFixed(2));

        // Adversarial challenge: verify rubric does not blindly award 100% to vague prompts
        const vaguePrompt = 'fix the bug';
        const vagueRubric = scorePromptSufficiency(vaguePrompt);
        const vagueScore = parseFloat(((vagueRubric.score / (RUBRIC_DIMENSIONS.length * 2)) * 100).toFixed(2));
        assert.ok(vagueScore < 50.0, `Vague prompt score (${vagueScore}) should be < 50.0, got ${vagueScore}`);

        return {
          workerId,
          success: true,
          score: compositeScore,
          band: rubric.band
        };
      } finally {
        ws.cleanup();
      }
    });

    const results = await Promise.all(tasks);
    assert.equal(results.length, WORKER_COUNT);

    for (const r of results) {
      assert.equal(r.success, true);
      assert.equal(r.band, SUFFICIENCY_BANDS.HIGH);
      assert.ok(r.score >= 96.25, `Worker ${r.workerId} composite score ${r.score} < 96.25 requirement`);
    }
  });

  it('3.41.2 Stress burst: 3 consecutive rounds of 16 concurrent workers (48 total executions) show zero race conditions or degradation', async () => {
    const ROUNDS = 3;
    const WORKER_COUNT = 16;

    for (let round = 1; round <= ROUNDS; round++) {
      const tasks = Array.from({ length: WORKER_COUNT }, async (_, i) => {
        const id = `${round}_${i}`;
        const ws = createIsolatedTestSandbox();
        try {
          // Quick verification of all invariants in high burst
          assertPlainTextCompact('<div id="compactInstruction">Type /compact in the chat box and press Enter</div>');
          assert.equal(isIgnorablePath('src/core/router.mjs'), false);
          assert.equal(isIgnorablePath('package-lock.json'), true);

          const fA = path.join(ws.workspaceDir, `a_${id}.txt`);
          const fB = path.join(ws.workspaceDir, `b_${id}.txt`);
          fs.writeFileSync(fA, 'identical');
          fs.writeFileSync(fB, 'identical');
          assert.equal(assertMirrorParity({ filePairs: [[fA, fB]] }).verifiedPairs, 1);

          assert.throws(() => assertNoOutboundEgress('fetch("http://evil.com")'), /Forbidden/);

          const sanitized = sanitizeForensicPayload('sk-ant-api03-1234567890abcdef');
          assert.ok(sanitized.sanitized.includes('[REDACTED:ANTHROPIC_KEY]'));

          const prompt = 'Implement Feature 41 E2E Test Suite in test/e2e_tier1_features.test.mjs. Ensure 41 feature suites pass without touching other workspace files. Verify exit code 0 and expect output returns pass, assert strict zero-dep compliance with invariant constraints, and check caller imports in bin/ctxtop.mjs and src/core/prompt_rubric.mjs for mirror sync.';
          const rubric = scorePromptSufficiency(prompt, {
            activeSetPaths: ['test/e2e_tier1_features.test.mjs', 'src/core/prompt_rubric.mjs']
          });
          const score = parseFloat(((rubric.score / (RUBRIC_DIMENSIONS.length * 2)) * 100).toFixed(2));
          return score;
        } finally {
          ws.cleanup();
        }
      });

      const scores = await Promise.all(tasks);
      assert.equal(scores.length, WORKER_COUNT);
      for (const s of scores) {
        assert.ok(s >= 96.25, `Round ${round} score ${s} < 96.25`);
      }
    }
  });
});
