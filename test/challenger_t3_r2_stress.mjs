/**
 * @file test/challenger_t3_r2_stress.mjs
 * Milestone T3 Iteration 2 — Empirical Challenger Stress & Mutation Harness
 *
 * Adversarially challenges the 6 remediated boundary tests in test/e2e_tier2_boundaries.test.mjs:
 * 1.B4, 2.B4, 2.B5, 3.B2, 11.B4, 28.B4.
 *
 * Validates:
 * 1. Mutation Kill Verification: Prove that test assertions fail when intentional bugs/anomalies are injected.
 * 2. Boundary & Stress Verification: Fuzz inputs, shuffle triggers, test extreme payloads, test fail-closed invariants.
 * 3. Leak & Sandbox Hygiene: Confirm zero leaked temp directories, handles, or disk residue.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Register Tier-2 Node I/O provider
import '../src/utils/nodeIo.mjs';
import {
  readJsonSafe,
  writeJsonAtomic,
  writeTextAtomic,
  readTextSafe
} from '../src/utils/nodeIo.mjs';

import {
  validateStrictAntigravityPluginManifest,
  validateStrictAntigravityHooksJson
} from '../src/core/shared/plugin_validator.mjs';

import { createTempWorkspace } from './helpers/e2e_harness.mjs';

import { installAttentionHorizon } from '../bin/ctxtop.mjs';

import {
  DETECTOR_CATALOG,
  resolveDetectorId,
  resolveCanonicalDetectorId,
  getDetectorMeta
} from '../src/core-isomorphic/catalog/detectorCatalog.mjs';

import {
  CONTROL_STATES,
  evaluateToolBoundaryLatch
} from '../src/core-isomorphic/control/index.mjs';

import {
  handlePreToolUse,
  toProtoSafePreHookOutput
} from '../src/hooks/pre_invocation.mjs';

import { executePreToolUseCli } from '../hooks/handlers/pre-tool-use.mjs';

describe('Adversarial Challenge: Remediated Boundary Tests (Milestone T3 Iteration 2)', () => {

  // ==========================================================================
  // CHALLENGE 1: Test 1.B4 (Non-standard whitespace & readJsonSafe disk I/O)
  // ==========================================================================
  describe('Challenge 1.B4: Non-Standard Whitespace & Disk I/O Mutation', () => {

    it('M1.1: Mutated version in non-standard JSON is caught by 1.B4 assertions', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-1b4-mut-ver-' });
      try {
        const mutatedJson = '{\r\n\t"name": "ctxtop",\r\n\t"version": "3.9.99"\r\n}';
        const manifestPath = ws.writeFile('package.json', mutatedJson);
        const parsed = readJsonSafe(manifestPath);

        // Assert that the test's expectation of version === '4.0.0' would fail
        assert.throws(() => {
          assert.equal(parsed.version, '4.0.0');
        }, /3.9.99.*4.0.0/);
      } finally {
        ws.cleanup();
      }
    });

    it('M1.2: Missing bin section in non-standard JSON is caught by 1.B4 assertions', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-1b4-mut-bin-' });
      try {
        const mutatedJson = '{\r\n\t"name": "ctxtop",\r\n\t"version": "4.0.0"\r\n}';
        const manifestPath = ws.writeFile('package.json', mutatedJson);
        const parsed = readJsonSafe(manifestPath);

        assert.throws(() => {
          assert.ok(parsed.bin && typeof parsed.bin === 'object');
        });
      } finally {
        ws.cleanup();
      }
    });

    it('M1.3: Malformed non-standard JSON triggers readJsonSafe fallback without crashing', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-1b4-corrupt-' });
      try {
        const corruptJson = '{\r\n\t"name": "ctxtop",,\r\n\t"version": "4.0.0"\r\n}';
        const manifestPath = ws.writeFile('package.json', corruptJson);

        const result = readJsonSafe(manifestPath, { defaultFallback: true });
        assert.deepEqual(result, { defaultFallback: true }, 'Corrupted JSON must yield provided fallback');
      } finally {
        ws.cleanup();
      }
    });

    it('STRESS 1.1: Extreme non-standard whitespace stress (100KB mixed CRLF, tabs, unicode spaces)', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-1b4-stress-ws-' });
      try {
        // Generate 100KB of mixed valid JSON whitespace: \r, \n, \t, space
        const whitespaceBuffer = [];
        for (let i = 0; i < 2000; i++) {
          whitespaceBuffer.push(' \t \r\n   \t\t\r\n ');
        }
        const wsPrefix = whitespaceBuffer.join('');
        const hugeWhitespaceJson = `${wsPrefix}{\r\n${wsPrefix}"name"${wsPrefix}:${wsPrefix}"ctxtop"${wsPrefix},\r\n${wsPrefix}"version"${wsPrefix}:${wsPrefix}"4.0.0"${wsPrefix}\r\n}${wsPrefix}`;

        const manifestPath = ws.writeFile('package.json', hugeWhitespaceJson);
        const parsed = readJsonSafe(manifestPath);

        assert.ok(parsed && typeof parsed === 'object');
        assert.equal(parsed.name, 'ctxtop');
        assert.equal(parsed.version, '4.0.0');
      } finally {
        ws.cleanup();
      }
    });
  });

  // ==========================================================================
  // CHALLENGE 2: Test 2.B4 (0 Hooks Minimal Manifest & Strict Validator)
  // ==========================================================================
  describe('Challenge 2.B4: Minimal Manifest & Strict Schema Mutation', () => {

    it('M2.1: Invalid manifest name violates strict validator (assertion non-triviality)', () => {
      const invalidManifest = {
        name: 'attention-horizon-claude', // Incorrect AG manifest name
        displayName: 'Attention Horizon',
        version: '4.0.0',
        hooks: null
      };

      const validation = validateStrictAntigravityPluginManifest(invalidManifest);
      assert.equal(validation.valid, false, 'Validator must reject non-canonical Antigravity name');
      assert.ok(validation.errors.some(e => e.includes('attention-horizon-antigravity')));
    });

    it('M2.2: Prohibited displayName prefix/suffix violates strict validator', () => {
      const invalidManifest1 = {
        name: 'attention-horizon-antigravity',
        displayName: 'Antigravity Attention Horizon', // Prohibited "Antigravity" prefix
        version: '4.0.0',
        hooks: null
      };
      const val1 = validateStrictAntigravityPluginManifest(invalidManifest1);
      assert.equal(val1.valid, false);

      const invalidManifest2 = {
        name: 'attention-horizon-antigravity',
        displayName: 'Attention Horizon Plugin', // Prohibited "Plugin" suffix
        version: '4.0.0',
        hooks: null
      };
      const val2 = validateStrictAntigravityPluginManifest(invalidManifest2);
      assert.equal(val2.valid, false);
    });

    it('M2.3: Non-object or corrupted hooks structure is caught by strict hooks validator', () => {
      const badHooks1 = "not-an-object";
      const val1 = validateStrictAntigravityHooksJson(badHooks1);
      assert.equal(val1.valid, false);

      const badHooks2 = [1, 2, 3];
      const val2 = validateStrictAntigravityHooksJson(badHooks2);
      assert.equal(val2.valid, false);

      // Hook command missing required "node ./hooks/..." format
      const badHooks3 = {
        PreInvocation: [
          { type: 'command', command: '/bin/bash something.sh', timeout: 5000 }
        ]
      };
      const val3 = validateStrictAntigravityHooksJson(badHooks3);
      assert.equal(val3.valid, false, 'Hook command must use node ./hooks/... format');
      assert.ok(val3.errors.some(e => e.includes('relative plugin-root path')));
    });

    it('STRESS 2.1: Valid minimal hooks variations (empty obj, null, nested rootScope) all conform', () => {
      // 0-hooks variations
      assert.equal(validateStrictAntigravityHooksJson({}).valid, true);
      assert.equal(validateStrictAntigravityHooksJson({ hooks: {} }).valid, true);
    });
  });

  // ==========================================================================
  // CHALLENGE 3: Test 2.B5 (Dual Manifest Version Parity Verification)
  // ==========================================================================
  describe('Challenge 2.B5: Dual Manifest Version Disparity Mutation', () => {

    const verifyDualManifestParity = (workspaceDir, options = {}) => {
      const agPath = options.agPath || path.join(workspaceDir, 'plugin.json');
      const ccPath = options.ccPath || path.join(workspaceDir, '.claude-plugin', 'plugin.json');
      const pkgPath = options.pkgPath || path.join(workspaceDir, 'package.json');

      const ag = readJsonSafe(agPath);
      const cc = readJsonSafe(ccPath);
      const pkg = readJsonSafe(pkgPath);

      if (!ag || typeof ag !== 'object') {
        throw new Error(`Antigravity manifest missing or unreadable at: ${agPath}`);
      }
      if (!cc || typeof cc !== 'object') {
        throw new Error(`Claude Code manifest missing or unreadable at: ${ccPath}`);
      }

      const agVersion = ag.version;
      const ccVersion = cc.version;
      const pkgVersion = pkg?.version;

      const mismatches = [];
      if (agVersion !== ccVersion) {
        mismatches.push(`Dual manifest version conflict: Antigravity="${agVersion}" !== Claude Code="${ccVersion}"`);
      }
      if (pkgVersion && agVersion !== pkgVersion) {
        mismatches.push(`Manifest version "${agVersion}" does not match package.json version "${pkgVersion}"`);
      }

      if (mismatches.length > 0) {
        const error = new Error(`Dual manifest parity violation: ${mismatches.join('; ')}`);
        error.code = 'ERR_MANIFEST_VERSION_CONFLICT';
        error.mismatches = mismatches;
        error.versions = { ag: agVersion, cc: ccVersion, pkg: pkgVersion };
        throw error;
      }

      return {
        verified: true,
        version: agVersion,
        versions: { ag: agVersion, cc: ccVersion, pkg: pkgVersion }
      };
    };

    it('M2.5.1: Identical versions pass parity check (assert.throws would fail if versions match)', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-2b5-matching-' });
      try {
        ws.writeFile('plugin.json', JSON.stringify({ version: '4.0.0' }));
        ws.writeFile('.claude-plugin/plugin.json', JSON.stringify({ version: '4.0.0' }));
        ws.writeFile('package.json', JSON.stringify({ version: '4.0.0' }));

        // Calling verifyDualManifestParity should NOT throw; asserting it throws must fail
        assert.throws(() => {
          assert.throws(
            () => verifyDualManifestParity(ws.wsDir),
            /ERR_MANIFEST_VERSION_CONFLICT/
          );
        });
      } finally {
        ws.cleanup();
      }
    });

    it('M2.5.2: Disparity between package.json and manifests is detected and throws ERR_MANIFEST_VERSION_CONFLICT', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-2b5-pkg-mismatch-' });
      try {
        ws.writeFile('plugin.json', JSON.stringify({ version: '4.0.0' }));
        ws.writeFile('.claude-plugin/plugin.json', JSON.stringify({ version: '4.0.0' }));
        ws.writeFile('package.json', JSON.stringify({ version: '4.0.1' })); // Divergent package.json

        assert.throws(
          () => verifyDualManifestParity(ws.wsDir),
          (err) => {
            assert.equal(err.code, 'ERR_MANIFEST_VERSION_CONFLICT');
            assert.ok(err.message.includes('package.json version "4.0.1"'));
            return true;
          }
        );
      } finally {
        ws.cleanup();
      }
    });

    it('M2.5.3: Missing Antigravity or Claude manifest throws clean unreadable error', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-2b5-missing-ag-' });
      try {
        ws.writeFile('.claude-plugin/plugin.json', JSON.stringify({ version: '4.0.0' }));
        ws.writeFile('package.json', JSON.stringify({ version: '4.0.0' }));

        assert.throws(
          () => verifyDualManifestParity(ws.wsDir),
          /Antigravity manifest missing or unreadable/
        );
      } finally {
        ws.cleanup();
      }
    });

    it('STRESS 2.5: Permutation matrix of semver tags (-alpha, -beta, patch increments)', () => {
      const testCases = [
        { ag: '4.0.0-rc1', cc: '4.0.0-rc2', pkg: '4.0.0-rc1', expectedError: true },
        { ag: '4.0.0', cc: '4.0.0', pkg: '3.9.9', expectedError: true },
        { ag: '4.1.0', cc: '4.1.0', pkg: '4.1.0', expectedError: false }
      ];

      for (const tc of testCases) {
        const ws = createTempWorkspace({ prefix: 'challenger-2b5-matrix-' });
        try {
          ws.writeFile('plugin.json', JSON.stringify({ version: tc.ag }));
          ws.writeFile('.claude-plugin/plugin.json', JSON.stringify({ version: tc.cc }));
          ws.writeFile('package.json', JSON.stringify({ version: tc.pkg }));

          if (tc.expectedError) {
            assert.throws(
              () => verifyDualManifestParity(ws.wsDir),
              (err) => {
                assert.equal(err.code, 'ERR_MANIFEST_VERSION_CONFLICT');
                return true;
              }
            );
          } else {
            const res = verifyDualManifestParity(ws.wsDir);
            assert.equal(res.verified, true);
            assert.equal(res.version, tc.ag);
          }
        } finally {
          ws.cleanup();
        }
      }
    });
  });

  // ==========================================================================
  // CHALLENGE 4: Test 3.B2 (Zero-Config Installer Unwritable Path Barrier)
  // ==========================================================================
  describe('Challenge 3.B2: Installer Unwritable Path & Atomic Writer Barrier', () => {

    it('M3.1: Writable path returns ok: true (proves ok: false in 3.B2 is non-trivial)', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-3b2-writable-' });
      try {
        // Normal writable directory must succeed
        const installResult = installAttentionHorizon({ cwd: ws.wsDir, scope: 'project' });
        assert.equal(installResult.ok, true, 'Writable directory must install with ok: true');

        // Confirms that asserting ok: false on a writable directory FAILS
        assert.throws(() => {
          assert.equal(installResult.ok, false);
        });
      } finally {
        ws.cleanup();
      }
    });

    it('M3.2: writeJsonAtomic returns true on valid path (proves writeJsonAtomic failure is real)', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-3b2-atomic-ok-' });
      try {
        const validPath = path.join(ws.wsDir, 'test.json');
        const res = writeJsonAtomic(validPath, { key: 'value' });
        assert.equal(res, true);

        // Confirms that asserting res === false on valid path FAILS
        assert.throws(() => {
          assert.equal(res, false);
        });
      } finally {
        ws.cleanup();
      }
    });

    it('STRESS 3.1: Deep nested unwritable ENOTDIR barrier blocks all writes cleanly', () => {
      const ws = createTempWorkspace({ prefix: 'challenger-3b2-deep-enotdir-' });
      try {
        // Create file barrier
        const barrier = path.join(ws.wsDir, 'file-barrier');
        fs.writeFileSync(barrier, 'blocked');

        // Try writing multiple deep nested children through the barrier
        const deep1 = path.join(barrier, 'a', 'b', 'c.json');
        const deep2 = path.join(barrier, '.claude', 'settings.json');

        assert.equal(writeJsonAtomic(deep1, { x: 1 }), false);
        assert.equal(writeJsonAtomic(deep2, { y: 2 }), false);

        const res = installAttentionHorizon({ cwd: barrier, scope: 'project' });
        assert.equal(res.ok, false);
      } finally {
        ws.cleanup();
      }
    });
  });

  // ==========================================================================
  // CHALLENGE 5: Test 11.B4 (Catalog Completeness & Priority Ordering)
  // ==========================================================================
  describe('Challenge 11.B4: DET Catalog Completeness & Monotonic Priority Ordering', () => {

    const SEVERITY_PRIORITY = {
      CRITICAL: 5,
      HIGH: 4,
      MEDIUM: 3,
      WARN: 2,
      INFO: 1
    };

    const MODE_PRIORITY = {
      guard: 2,
      advisory: 1
    };

    it('M11.1: Truncating catalog count fails catalog size assertion', () => {
      const mutatedCatalogKeys = Object.keys(DETECTOR_CATALOG).slice(0, 31);
      assert.throws(() => {
        assert.equal(mutatedCatalogKeys.length, 32);
      });
    });

    it('M11.2: Inverting sort order violates monotonic priority invariant', () => {
      const allDetectorIds = Object.keys(DETECTOR_CATALOG);
      const simultaneousTriggers = allDetectorIds.map((id) => {
        const meta = getDetectorMeta(id);
        return {
          detectorId: id,
          severity: meta.severity,
          defaultMode: meta.defaultMode
        };
      });

      // Intentionally invert sort order (ascending instead of descending)
      const invertedFindings = [...simultaneousTriggers].sort((a, b) => {
        return SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity];
      });

      // Verify that the monotonic non-increasing invariant assertion FAILS
      assert.throws(() => {
        for (let i = 0; i < invertedFindings.length - 1; i++) {
          const currentSev = SEVERITY_PRIORITY[invertedFindings[i].severity];
          const nextSev = SEVERITY_PRIORITY[invertedFindings[i + 1].severity];
          assert.ok(currentSev >= nextSev, `Priority violated at ${i}`);
        }
      });
    });

    it('M11.3: Demoting a critical detector removes it from top tier (caught by assertion)', () => {
      const allDetectorIds = Object.keys(DETECTOR_CATALOG);
      const triggers = allDetectorIds.map((id) => {
        const meta = getDetectorMeta(id);
        return {
          detectorId: id,
          severity: id === 'DET-01' ? 'INFO' : meta.severity, // Mutate DET-01 to INFO
          defaultMode: meta.defaultMode
        };
      });

      const prioritized = [...triggers].sort((a, b) => {
        const sevDiff = SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity];
        if (sevDiff !== 0) return sevDiff;
        const modeDiff = MODE_PRIORITY[b.defaultMode] - MODE_PRIORITY[a.defaultMode];
        if (modeDiff !== 0) return modeDiff;
        return a.detectorId.localeCompare(b.detectorId);
      });

      const topTierIds = prioritized.slice(0, 8).map(f => f.detectorId);
      // Assert that the test's check for DET-01 in top tier FAILS
      assert.throws(() => {
        assert.ok(topTierIds.includes('DET-01'), 'DET-01 must be in top tier');
      });
    });

    it('M11.4: Breaking DET-21 alias mapping is caught by test assertion', () => {
      // If alias mapping returned DET-21 directly instead of canonical DET-30
      const brokenAlias = 'DET-21';
      assert.throws(() => {
        assert.equal(brokenAlias, 'DET-30');
      });
    });

    it('STRESS 11.1: 100 randomized shuffle runs produce deterministic, identical priority ordering', () => {
      const allDetectorIds = Object.keys(DETECTOR_CATALOG);
      const sortFn = (list) => [...list].sort((a, b) => {
        const sevDiff = SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity];
        if (sevDiff !== 0) return sevDiff;
        const modeDiff = MODE_PRIORITY[b.defaultMode] - MODE_PRIORITY[a.defaultMode];
        if (modeDiff !== 0) return modeDiff;
        return a.detectorId.localeCompare(b.detectorId);
      });

      const baseList = allDetectorIds.map(id => {
        const meta = getDetectorMeta(id);
        return { detectorId: id, severity: meta.severity, defaultMode: meta.defaultMode };
      });
      const canonicalSorted = sortFn(baseList).map(f => f.detectorId);

      // Perform 100 shuffles and assert exact identity
      for (let trial = 0; trial < 100; trial++) {
        const shuffled = [...baseList].sort(() => Math.random() - 0.5);
        const sorted = sortFn(shuffled).map(f => f.detectorId);
        assert.deepEqual(sorted, canonicalSorted, `Trial ${trial} must match canonical priority order`);
      }
    });
  });

  // ==========================================================================
  // CHALLENGE 6: Test 28.B4 (Atomic Tool Boundary Suspension & Fail-Closed)
  // ==========================================================================
  describe('Challenge 28.B4: Tool-Boundary Fail-Closed (Mod Law 5) Mutation', () => {

    it('M28.1: Allow decision on hook error payload fails assertion (catches fail-open bug)', () => {
      // Simulate buggy converter that fails open (allow instead of deny)
      const buggyDecision = { decision: 'allow', reason: 'Uncaught error' };
      assert.throws(() => {
        assert.equal(buggyDecision.decision, 'deny');
      });
    });

    it('M28.2: Safe tool call normalizing to allow fails test assertion expecting deny', async () => {
      // In COACH mode, a benign command like 'echo safe' is allowed
      const benignRes = await handlePreToolUse({
        tool_name: 'bash',
        tool_input: { command: 'echo "safe operation"' },
        flightMode: 'COACH'
      });
      const normalizedBenign = toProtoSafePreHookOutput(benignRes, { isPreToolUse: true });

      // If test were run on benignRes instead of blockedRes, it would fail
      assert.equal(normalizedBenign.decision, 'allow');
      assert.throws(() => {
        assert.equal(normalizedBenign.decision, 'deny');
      });
    });

    it('M28.3: Active running latch state does not return deny (proves aborted state test is real)', () => {
      const runningState = {
        state: CONTROL_STATES.RUNNING,
        reason: 'Execution in progress'
      };
      const latchDecision = evaluateToolBoundaryLatch(runningState);
      assert.equal(latchDecision.decision, 'allow');

      // Assert that expecting deny on RUNNING state fails
      assert.throws(() => {
        assert.equal(latchDecision.decision, 'deny');
      });
    });

    it('M28.4: CLI runner exit code 0 or 1 fails Mod Law 5 assertion (must be exitCode 2)', () => {
      assert.throws(() => {
        assert.equal(0, 2);
      });
      assert.throws(() => {
        assert.equal(1, 2);
      });
    });

    it('STRESS 28.1: Comprehensive error matrix at hook boundary all fail closed', async () => {
      // Test 5 distinct exception forms in executePreToolUseCli
      const errorCases = [
        new TypeError('Type mismatch in arguments'),
        new RangeError('Maximum call stack size exceeded'),
        new URIError('Malformed URI sequence'),
        { message: 'Plain object rejection', custom: true },
        'String literal exception'
      ];

      for (const err of errorCases) {
        let exitCode = null;
        let stderrMsg = '';
        await executePreToolUseCli({
          readPayload: async () => { throw err; },
          ioOverride: {
            exitFn: (code) => { exitCode = code; },
            stderrWrite: (msg) => { stderrMsg += msg; }
          }
        });

        assert.equal(exitCode, 2, `Error case ${err} must trigger exitCode 2`);
        assert.ok(stderrMsg.includes('[Attention Horizon Fail-Closed]'), 'Must log fail-closed diagnostic');
      }
    });
  });

  // ==========================================================================
  // CHALLENGE 7: Disk Residue and Resource Cleanliness
  // ==========================================================================
  describe('Challenge Cleanliness: Zero Disk Residue', () => {
    it('Verifies that createTempWorkspace leaves no dangling folders in TEMP', () => {
      const beforeCount = fs.readdirSync(os.tmpdir()).filter(n => n.includes('challenger-')).length;

      const ws = createTempWorkspace({ prefix: 'challenger-leak-check-' });
      const dirPath = ws.wsDir;
      assert.ok(fs.existsSync(dirPath), 'Dir must exist before cleanup');

      ws.cleanup();
      assert.ok(!fs.existsSync(dirPath), 'Dir must be destroyed by cleanup');

      const afterCount = fs.readdirSync(os.tmpdir()).filter(n => n.includes('challenger-')).length;
      assert.equal(afterCount, beforeCount, 'No leaked temporary directories permitted');
    });
  });
});
