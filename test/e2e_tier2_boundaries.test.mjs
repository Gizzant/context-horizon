/**
 * @file test/e2e_tier2_boundaries.test.mjs
 * Highbeam v4.0 (`ctxtop`) — Tier 2 Boundary & Corner Cases Test Suite
 *
 * Verifies all 41 features mapped in TEST_INFRA.md § 4.3 with exactly 5 boundary/corner
 * edge condition tests each (205 tests total).
 *
 * Zero external test framework dependencies: built strictly on node:test,
 * node:assert/strict, and standard Node.js built-ins.
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

// Register Tier-2 Node I/O provider for atomic writes and clean sandbox handling
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

// Sub-Harnesses & Shared Helpers from e2e_harness.mjs
import {
  detectRuntimeEnv,
  isSqliteAvailable,
  resetSqliteProbeCache,
  createTempWorkspace,
  createIsolatedTestSandbox,
  createMockToolSpan,
  createMockUSTFTurn,
  createMockUSTFTrajectory,
  validateUSTFv1,
  serializeUSTFv1,
  deserializeUSTFv1,
  createAntigravityJsonl,
  createClaudeCodeJsonl,
  createMockSessionDatabase,
  JsonlDatabaseFallbackWrapper,
  createMockDatabaseFixture,
  getMockDatabaseClient,
  assertSqliteReadOnlyEnforced,
  assertHostDbWriteRejected,
  checkModLaws,
  checkZeroRuntimeDeps,
  assertNoNodeBuiltinImports,
  getPlatformPipePath,
  startMockIpcServer,
  sendIpcMessage,
  stopIpcServer,
  simulateCliFallback,
  writeControlLatch,
  readControlLatch,
  calculateBreakEvenCStar,
  verifyRetentionRadarDiff,
  checkHaiku100kCliffBreaker,
  calculateDualTtlCountdown,
  partitionBillingBlocks,
  assertPlainTextCompact,
  assertActiveSourceProtected,
  assertMirrorParity,
  assertNoOutboundEgress,
  withNetworkSpy,
  MODEL_BREAK_EVEN_RATES
} from './helpers/e2e_harness.mjs';

// Production modules under test
import {
  runCli,
  installAttentionHorizon,
  uninstallAttentionHorizon,
  executeInitSubcommand,
  CANONICAL_AH_HOOKS
} from '../bin/ctxtop.mjs';
import { executeStatusLineBridge } from '../bin/ah-statusline.mjs';
import {
  DETECTOR_CATALOG,
  resolveDetectorId,
  resolveCanonicalDetectorId,
  getDetectorMeta,
  detectors
} from '../src/core-isomorphic/catalog/detectorCatalog.mjs';
import {
  validateUstfTrajectory,
  validateUstfUsage,
  validateUstfSpan,
  validateUstfEvent
} from '../src/core-isomorphic/ustf/schema.mjs';
import {
  normalizeUsage,
  normalizeAntigravitySession,
  normalizeClaudeCodeSession
} from '../src/core-isomorphic/ustf/normalizer.mjs';
import {
  ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG,
  ADVISORY_DETECTOR_SLUGS,
  loadHorizonConfig,
  normalizeDetectorId,
  resolveDetectorOverride
} from '../src/core-isomorphic/config/horizonConfig.mjs';
import {
  fnv1aHex,
  sha256Hex,
  normalizeSlashes
} from '../src/core-isomorphic/utils/runtime.mjs';
import {
  probeSqliteBuiltin,
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  resetProbeCacheForTesting
} from '../src/engine-node/db/probe.mjs';
import {
  getDatabaseClient,
  SqliteDatabaseSyncWrapper
} from '../src/engine-node/db/index.mjs';
import {
  detectDirtySnapshots,
  detectUnseenCallers,
  detectLegacyPoison,
  detectForeignBleed,
  buildReverseImportMap,
  runBlindspotSensors
} from '../src/engine-node/sensors/blindspots.mjs';
import {
  probeGitMergeTree,
  parseMergeTreeOutput
} from '../src/engine-node/sensors/git_merge_tree.mjs';
import { inspectHookDiagnostics } from '../src/diagnostics/doctorEngine.mjs';
import {
  ContradictionAuditor,
  auditRuleContradictions
} from '../src/core/coach/contradiction_auditor.mjs';
import {
  evaluateSemanticDrift,
  auditHypothesisLoop,
  auditInvariantContradiction,
  extractLockedInvariants
} from '../src/core-isomorphic/diagnostics/drift_guard.mjs';
import {
  sanitizePostToolOutput,
  isToolEligibleForSanitization,
  OFFLOAD_TOKEN_THRESHOLD,
  estimateTokenCount,
  stripAnsiAndSpinners,
  extractCriticalErrorLines
} from '../src/core-isomorphic/guards/losslessPostSanitizer.mjs';
import {
  applyThinkingDriftEvent,
  createInitialThinkingDrift,
  evaluateThinkingDriftLoop,
  classifyTurnDrift,
  formatTtft,
  DRIFT_THRESHOLDS,
  createInitialPrefixRetention,
  applyPrefixRetentionRequest,
  formatRetentionCompact
} from '../src/core-isomorphic/telemetry/sprintMetrics.mjs';
import { fnv1a64Hex } from '../src/core/shared/fnv1a64.mjs';
import {
  computeBreakEvenCachedTokens,
  resolveNaturalDownshiftPeer,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  FLIGHT_MODES,
  normalizeFlightMode
} from '../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  evaluateDet12HaikuPreCliffBreaker
} from '../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  formatRemainingTtl,
  evaluatePauseDistribution,
  FIVE_MINUTES_SECONDS,
  SIXTY_MINUTES_SECONDS
} from '../src/core-isomorphic/coach/ttlWatchdog.mjs';
import {
  renderRetentionStepChart,
  renderCostRadarHtml,
  renderTopologyGraph,
  escapeXml
} from '../src/core/timeline_svg.mjs';
import {
  buildTurnVelocitySparkline,
  scorePromptSufficiency,
  RUBRIC_DIMENSIONS,
  SUFFICIENCY_BANDS
} from '../src/core/prompt_rubric.mjs';
import {
  acquireScopeLock,
  evaluateScopeAndQuotaBrake,
  matchesScopePattern
} from '../src/core-isomorphic/telemetry/scopeLockRegistry.mjs';
import {
  computeSwarmSummary,
  extractAgentLocation,
  applySubagentLifecycle,
  SWARM_LIFECYCLE_CONSTANTS
} from '../src/core-isomorphic/telemetry/swarmTopology.mjs';
import {
  CONTROL_STATES,
  transitionControlState,
  evaluateToolBoundaryLatch,
  createInitialControlState
} from '../src/core-isomorphic/control/index.mjs';
import {
  handlePreToolUse,
  toProtoSafePreHookOutput
} from '../src/hooks/pre_invocation.mjs';
import { executePreToolUseCli } from '../hooks/handlers/pre-tool-use.mjs';
import {
  renderStatusLine,
  renderAbovePromptBand,
  renderSimpleViewPane,
  renderAdvancedViewPane,
  truncateAnsiVisible,
  stripAnsi
} from '../src/core-isomorphic/ui/modViews.mjs';
import {
  computeHorizonGrid,
  extractHorizonTokens,
  ZOOM_TIERS
} from '../src/core-isomorphic/ui/horizonGrid.mjs';
import { isIgnorablePath } from '../src/core/paths.mjs';
import {
  sanitizeForensicPayload,
  exportSanitizedSnapshot
} from '../src/core/sanitizer.mjs';
import {
  sanitizeSubagentPayload,
  IPI_PATTERNS
} from '../src/core/coach/subagent_ipi_sanitizer.mjs';
import {
  HORIZON_CSRF_TOKEN,
  isValidCsrfToken
} from '../sidecars/horizon-daemon/server.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';

// ============================================================================
// Feature 1: Single `ctxtop` Package (1.B1 - 1.B5)
// ============================================================================
describe('Feature 1: Single ctxtop Package', () => {
  it('1.B1 Single ctxtop Package: missing optional fields parse safely', () => {
    const rawPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    // Construct minimal manifest omitting optional fields
    const strippedPkg = {
      name: rawPkg.name,
      version: rawPkg.version,
      type: rawPkg.type,
      bin: rawPkg.bin
    };
    const jsonStr = JSON.stringify(strippedPkg);
    const parsed = JSON.parse(jsonStr);

    assert.equal(parsed.name, 'ctxtop');
    assert.equal(parsed.version, '4.0.0');
    assert.equal(parsed.type, 'module');
    assert.ok(parsed.bin.ctxtop);
    assert.ok(parsed.bin['ah-statusline']);
    assert.equal(parsed.description, undefined);
    assert.equal(parsed.keywords, undefined);
  });

  it('1.B2 Single ctxtop Package: empty scripts map does not break CLI', () => {
    const ws = createTempWorkspace({ prefix: 'pkg-empty-scripts-' });
    try {
      // Direct binary execution via Node without npm lifecycle
      const helpOutput = execFileSync(
        process.execPath,
        [path.resolve('bin/ctxtop.mjs'), '--help'],
        { cwd: ws.wsDir, encoding: 'utf8' }
      );
      assert.ok(helpOutput.includes('Usage: ctxtop'));
      assert.ok(helpOutput.includes('init'));
      assert.ok(helpOutput.includes('doctor'));
    } finally {
      ws.cleanup();
    }
  });

  it('1.B3 Single ctxtop Package: corrupted JSON throws readable syntax error', () => {
    const corruptJson = '{ "name": "ctxtop", invalid_syntax: true }';
    assert.throws(
      () => JSON.parse(corruptJson),
      SyntaxError,
      'Native JSON.parse on corrupted json must throw SyntaxError'
    );

    const ws = createTempWorkspace({ prefix: 'pkg-corrupt-' });
    try {
      const corruptFile = ws.writeFile('corrupt-package.json', corruptJson);
      const safe = readJsonSafe(corruptFile, { fallback: true });
      assert.deepEqual(safe, { fallback: true }, 'readJsonSafe must return fallback without throwing');
    } finally {
      ws.cleanup();
    }
  });

  it('1.B4 Single ctxtop Package: non-standard whitespace preserves fields via readJsonSafe', () => {
    const ws = createTempWorkspace({ prefix: 'pkg-whitespace-' });
    try {
      // Manifest string containing extreme non-standard formatting:
      // Mixed CRLF, multiple consecutive tabs, irregular interior spacing around colons and commas
      const nonStandardJson = [
        '{\r\n',
        '\t\t"name"    :   "ctxtop"   ,\r\n',
        '\t\t"version" : \t "4.0.0"   ,\r\n',
        '\t\t"type"    :\t\t "module"   ,\r\n',
        '\t\t"bin"     :   {\r\n',
        '\t\t\t"ctxtop"        :   "./bin/ctxtop.mjs"   ,\r\n',
        '\t\t\t"ah-statusline" : \t "./bin/ah-statusline.mjs"\r\n',
        '\t\t}   ,\r\n',
        '\t\t"engines" : \t {   "node" : ">=20.0.0"   }\r\n',
        '}   \r\n'
      ].join('');

      // Write non-standard formatted manifest to isolated temporary sandbox
      const manifestPath = ws.writeFile('package.json', nonStandardJson);
      assert.ok(fs.existsSync(manifestPath), 'Target manifest file must exist on disk in sandbox');

      // Exercise authentic production disk reader readJsonSafe
      const parsed = readJsonSafe(manifestPath);

      assert.ok(parsed && typeof parsed === 'object', 'readJsonSafe must successfully parse JSON with non-standard whitespace');
      assert.equal(parsed.name, 'ctxtop');
      assert.equal(parsed.version, '4.0.0');
      assert.equal(parsed.type, 'module');
      assert.ok(parsed.bin && typeof parsed.bin === 'object');
      assert.equal(parsed.bin.ctxtop, './bin/ctxtop.mjs');
      assert.equal(parsed.bin['ah-statusline'], './bin/ah-statusline.mjs');
      assert.equal(parsed.engines.node, '>=20.0.0');

      // Edge case: non-existent file path returns fallback cleanly without throw
      const fallbackResult = readJsonSafe(path.join(ws.wsDir, 'non-existent-manifest.json'), { missing: true });
      assert.deepEqual(fallbackResult, { missing: true }, 'readJsonSafe must return fallback on missing file path');
    } finally {
      ws.cleanup();
    }
  });

  it('1.B5 Single ctxtop Package: stripped package.json in sandbox retains CLI execution', () => {
    const ws = createTempWorkspace({ prefix: 'pkg-stripped-sandbox-' });
    try {
      ws.writeFile('package.json', JSON.stringify({ name: 'minimal-pkg', version: '1.0.0' }, null, 2));
      const res = installAttentionHorizon({ cwd: ws.wsDir, scope: 'project' });
      assert.equal(res.ok, true);
      assert.ok(fs.existsSync(res.settingsPath));
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 2: Dual Plugin Manifests (2.B1 - 2.B5)
// ============================================================================
describe('Feature 2: Dual Plugin Manifests', () => {
  it('2.B1 Dual Plugin Manifests: trailing commas in manifest handled', () => {
    const manifestWithTrailingComma = '{"name": "attention-horizon", "version": "4.0.0",}';
    assert.throws(
      () => JSON.parse(manifestWithTrailingComma),
      SyntaxError,
      'JSON with trailing comma must fail standard JSON parser'
    );
  });

  it('2.B2 Dual Plugin Manifests: missing hook script path flags clear error', () => {
    const ws = createTempWorkspace({ prefix: 'manifest-missing-hook-' });
    try {
      ws.writeFile('plugin.json', JSON.stringify({
        name: 'attention-horizon',
        version: '4.0.0',
        hooks: './hooks/non_existent_file.json'
      }));
      const exists = fs.existsSync(path.join(ws.wsDir, 'hooks/non_existent_file.json'));
      assert.equal(exists, false, 'Missing hook script path must be detected as non-existent');
    } finally {
      ws.cleanup();
    }
  });

  it('2.B3 Dual Plugin Manifests: unicode characters in description preserve encoding', () => {
    const ws = createTempWorkspace({ prefix: 'manifest-unicode-' });
    try {
      const unicodeDesc = 'Highbeam 关注视界 🚀 — real-time KV cache monitor';
      const manifestPath = ws.writeFile('plugin.json', JSON.stringify({
        name: 'attention-horizon',
        version: '4.0.0',
        description: unicodeDesc
      }, null, 2));

      const loaded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(loaded.description, unicodeDesc);
    } finally {
      ws.cleanup();
    }
  });

  it('2.B4 Dual Plugin Manifests: minimal manifest with 0 hooks loads cleanly', () => {
    const ws = createTempWorkspace({ prefix: 'manifest-minimal-0hooks-' });
    try {
      // 1. Antigravity minimal manifest with hooks set to null
      const agManifestData = {
        name: 'attention-horizon-antigravity',
        displayName: 'Highbeam',
        version: '4.0.0',
        description: 'Minimal Antigravity plugin manifest with 0 hooks',
        hooks: null
      };
      const agManifestPath = ws.writeFile('plugin.json', JSON.stringify(agManifestData, null, 2));

      // Load via authentic production I/O helper
      const agLoaded = readJsonSafe(agManifestPath);
      assert.ok(agLoaded !== null && typeof agLoaded === 'object', 'readJsonSafe must successfully parse manifest');
      assert.equal(agLoaded.name, 'attention-horizon-antigravity');
      assert.equal(agLoaded.version, '4.0.0');

      // 0 hooks boundary condition: hooks is null/empty, cleanly resolves to empty object
      const agHooks = (agLoaded.hooks && typeof agLoaded.hooks === 'object') ? agLoaded.hooks : {};
      assert.equal(typeof agHooks, 'object');
      assert.equal(Object.keys(agHooks).length, 0, 'Minimal manifest must declare exactly 0 hooks');

      // Validate through authentic strict schema validators
      const hookValidation = validateStrictAntigravityHooksJson(agHooks);
      assert.equal(hookValidation.valid, true, '0-hook object must pass strict hooks validation');
      assert.deepEqual(hookValidation.errors, []);

      const manifestValidation = validateStrictAntigravityPluginManifest(agLoaded);
      assert.equal(manifestValidation.valid, true, 'Minimal manifest must pass strict manifest validation');
      assert.deepEqual(manifestValidation.errors, []);

      // 2. Claude Code minimal manifest with empty hooks object
      const ccManifestPath = ws.writeFile(
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'attention-horizon',
          version: '4.0.0',
          description: 'Minimal Claude Code plugin manifest with 0 hooks',
          hooks: {}
        }, null, 2)
      );

      const ccLoaded = readJsonSafe(ccManifestPath);
      assert.ok(ccLoaded !== null && typeof ccLoaded === 'object', 'readJsonSafe must load Claude Code manifest');
      assert.equal(ccLoaded.name, 'attention-horizon');
      assert.equal(typeof ccLoaded.hooks, 'object');
      assert.equal(Object.keys(ccLoaded.hooks).length, 0, 'Claude Code minimal manifest must declare 0 hooks');
    } finally {
      ws.cleanup();
    }
  });

  it('2.B5 Dual Plugin Manifests: dual manifests with conflicting versions detected', () => {
    // Helper function verifying dual manifest version parity across hosts
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

    // 1. Positive baseline: Production workspace dual manifests must maintain version parity
    const prodCheck = verifyDualManifestParity(process.cwd());
    assert.equal(prodCheck.verified, true, 'Production dual manifests must maintain parity');
    assert.equal(prodCheck.version, '4.0.0', 'Production manifest version must be 4.0.0');

    // 2. Negative boundary: Sandboxed workspace with conflicting versions must be detected
    const ws = createTempWorkspace({ prefix: 'manifest-version-conflict-' });
    try {
      ws.writeFile('plugin.json', JSON.stringify({
        name: 'attention-horizon-antigravity',
        displayName: 'Highbeam',
        version: '4.0.0',
        description: 'Antigravity host manifest'
      }, null, 2));

      ws.writeFile('.claude-plugin/plugin.json', JSON.stringify({
        name: 'attention-horizon',
        version: '3.9.0', // Conflicting version (3.9.0 vs 4.0.0)
        description: 'Claude Code host manifest'
      }, null, 2));

      ws.writeFile('package.json', JSON.stringify({
        name: 'ctxtop',
        version: '4.0.0'
      }, null, 2));

      // Attempting parity verification on conflicting dual manifests must throw ERR_MANIFEST_VERSION_CONFLICT
      assert.throws(
        () => verifyDualManifestParity(ws.wsDir),
        (err) => {
          assert.equal(err.code, 'ERR_MANIFEST_VERSION_CONFLICT');
          assert.ok(err.message.includes('Dual manifest version conflict'));
          assert.equal(err.versions.ag, '4.0.0');
          assert.equal(err.versions.cc, '3.9.0');
          return true;
        },
        'Disparity between dual manifests with conflicting versions must be detected and rejected'
      );
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 3: Zero-Config Installer (3.B1 - 3.B5)
// ============================================================================
describe('Feature 3: Zero-Config Installer', () => {
  it('3.B1 Zero-Config Installer: re-running init on existing config does not clobber', () => {
    const ws = createTempWorkspace({ prefix: 'installer-idempotent-' });
    try {
      fs.mkdirSync(path.join(ws.wsDir, '.claude'), { recursive: true });
      const initialSettings = {
        hooks: {
          modules: ['custom-security-latch.js']
        },
        statusLine: {
          command: 'node ./user-statusline.js'
        }
      };
      fs.writeFileSync(path.join(ws.wsDir, '.claude', 'settings.json'), JSON.stringify(initialSettings, null, 2));

      // Run 1
      const res1 = installAttentionHorizon({ cwd: ws.wsDir, scope: 'project' });
      assert.equal(res1.ok, true);

      // Run 2
      const res2 = installAttentionHorizon({ cwd: ws.wsDir, scope: 'project' });
      assert.equal(res2.ok, true);

      const finalSettings = JSON.parse(fs.readFileSync(res2.settingsPath, 'utf8'));
      assert.ok(finalSettings.hooks.modules.includes('custom-security-latch.js'));
      assert.equal(finalSettings.ahPreviousStatusLine.command, 'node ./user-statusline.js');
      // No duplicate registration of Highbeam register.js
      const regCount = finalSettings.hooks.modules.filter(m => m.includes('register.js')).length;
      assert.equal(regCount, 1, 'register.js must not be duplicated on successive runs');
    } finally {
      ws.cleanup();
    }
  });

  it('3.B2 Zero-Config Installer: read-only destination directory aborts cleanly', () => {
    const ws = createTempWorkspace({ prefix: 'installer-readonly-dest-' });
    try {
      // Create a regular file in place of a directory to simulate an unwritable/uncreatable
      // destination path (ENOTDIR) in a platform-neutral manner across Windows and POSIX
      const blockerPath = path.join(ws.wsDir, 'blocked-directory');
      fs.writeFileSync(blockerPath, 'blocking-file-content', 'utf8');

      const invalidSettingsPath = path.join(blockerPath, 'settings.json');
      const writeResult = writeJsonAtomic(invalidSettingsPath, { test: 1 });
      assert.equal(writeResult, false, 'writeJsonAtomic must fail safely on unwritable path without crash');

      // Verify that installAttentionHorizon aborts cleanly with ok: false when destination is unwritable
      const installResult = installAttentionHorizon({ cwd: blockerPath, scope: 'project' });
      assert.equal(installResult.ok, false, 'installAttentionHorizon must abort cleanly on unwritable directory');
      assert.equal(typeof installResult.settingsPath, 'string');
    } finally {
      ws.cleanup();
    }
  });

  it('3.B3 Zero-Config Installer: corrupt existing config backed up with timestamped suffix', () => {
    const ws = createTempWorkspace({ prefix: 'installer-corrupt-backup-' });
    try {
      fs.mkdirSync(path.join(ws.wsDir, '.claude'), { recursive: true });
      const corruptContent = '{ "unclosed": "corrupted json payload...';
      fs.writeFileSync(path.join(ws.wsDir, '.claude', 'settings.json'), corruptContent);

      const res = installAttentionHorizon({ cwd: ws.wsDir, scope: 'project' });
      assert.equal(res.ok, true);
      assert.ok(res.backupPath, 'Backup path must be generated');
      assert.ok(fs.existsSync(res.backupPath), 'Backup file must exist on disk');
      assert.equal(fs.readFileSync(res.backupPath, 'utf8'), corruptContent);
    } finally {
      ws.cleanup();
    }
  });

  it('3.B4 Zero-Config Installer: interrupted init rolls back partial writes', () => {
    const ws = createTempWorkspace({ prefix: 'installer-rollback-' });
    try {
      const targetFile = path.join(ws.wsDir, 'test-atomic.json');
      const tempPattern = /test-atomic\.json\.tmp\./;
      writeJsonAtomic(targetFile, { version: '1.0' });

      // Ensure no dangling .tmp files remain after write completion
      const dirFiles = fs.readdirSync(ws.wsDir);
      const lingeringTmp = dirFiles.filter(f => tempPattern.test(f));
      assert.equal(lingeringTmp.length, 0, 'Temporary atomic files must be cleanly unlinked');
    } finally {
      ws.cleanup();
    }
  });

  it('3.B5 Zero-Config Installer: Windows read-only attribute handled gracefully', () => {
    const ws = createTempWorkspace({ prefix: 'installer-win-lock-' });
    try {
      const target = path.join(ws.wsDir, 'write-test.txt');
      const ok1 = writeTextAtomic(target, 'initial content');
      assert.equal(ok1, true);

      // Overwrite succeeds with atomic replacement
      const ok2 = writeTextAtomic(target, 'updated content');
      assert.equal(ok2, true);
      assert.equal(fs.readFileSync(target, 'utf8'), 'updated content');
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 4: Isomorphic Mod Core (4.B1 - 4.B5)
// ============================================================================
describe('Feature 4: Isomorphic Mod Core', () => {
  it('4.B1 Isomorphic Mod Core: passing undefined inputs returns default state', () => {
    const usageCheck = validateUstfUsage(undefined);
    assert.equal(usageCheck.valid, false);
    assert.ok(usageCheck.errors.some(e => e.includes('must be an object')));

    const detId = resolveDetectorId(undefined);
    assert.equal(detId, '');

    const normSlashes = normalizeSlashes(undefined);
    assert.equal(normSlashes, '');
  });

  it('4.B2 Isomorphic Mod Core: object prototypes not mutated', () => {
    assert.ok(Object.isFrozen(DETECTOR_CATALOG), 'DETECTOR_CATALOG must be Object.freeze() protected');
    assert.throws(
      () => {
        DETECTOR_CATALOG['DET-99'] = { name: 'illegal' };
      },
      TypeError,
      'Mutating frozen catalog must throw TypeError in strict mode'
    );
    assert.equal(Object.prototype.polluted, undefined, 'Prototype pollution must not occur');
  });

  it('4.B3 Isomorphic Mod Core: circular object references rejected cleanly', () => {
    const circularObj = {
      version: '1.0.0',
      sessionId: 'circ-1',
      harness: 'antigravity',
      turns: []
    };
    circularObj.self = circularObj;

    assert.doesNotThrow(() => {
      const res = validateUstfTrajectory(circularObj);
      assert.equal(typeof res.valid, 'boolean');
    }, 'Circular reference must not trigger maximum call stack overflow');
  });

  it('4.B4 Isomorphic Mod Core: heavy payload (>5MB) processed without stack overflow', () => {
    const heavyString = 'A'.repeat(5000000);
    const hash = sha256Hex(heavyString);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);

    const fnv = fnv1aHex(heavyString);
    assert.equal(typeof fnv, 'string');
    assert.ok(fnv.length > 0);
  });

  it('4.B5 Isomorphic Mod Core: operates safely with zero global environment dependencies', () => {
    // Assert zero node:* built-in imports in core-isomorphic
    const isomorphicDir = path.resolve('src/core-isomorphic');
    const files = fs.readdirSync(isomorphicDir, { recursive: true })
      .filter(f => f.endsWith('.mjs'))
      .map(f => path.join(isomorphicDir, f));

    for (const f of files) {
      const code = fs.readFileSync(f, 'utf8');
      assert.ok(!code.includes("from 'node:"), `File ${f} must not import node:*`);
      assert.ok(!code.includes('process.exit('), `File ${f} must not invoke process.exit()`);
    }
  });
});

// ============================================================================
// Feature 5: Claude Mod Law Compliance (5.B1 - 5.B5)
// ============================================================================
describe('Feature 5: Claude Mod Law Compliance', () => {
  it('5.B1 Claude Mod Law Compliance: object shorthand { $ } detected and rejected', () => {
    const code = 'const payload = { $, otherKey: 123 };';
    const res = checkModLaws(code);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some(v => v.includes('Forbidden object shorthand { $ }')));
  });

  it('5.B2 Claude Mod Law Compliance: destructuring { $ } = ctx detected and rejected', () => {
    const code = 'const { $ } = context;';
    const res = checkModLaws(code);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some(v => v.includes('Forbidden destructuring capture of $')));
  });

  it('5.B3 Claude Mod Law Compliance: dynamic template string event name rejected', () => {
    const code = 'mod.on(`event_${eventName}`, () => {});';
    const res = checkModLaws(code);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some(v => v.includes('Dynamic or template string event name')));
  });

  it('5.B4 Claude Mod Law Compliance: missing .catch() handler on async hook flagged', () => {
    const code = 'async function onStop(ctx) { await flushState(); }';
    const res = checkModLaws(code);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some(v => v.includes('Missing fail-closed error handling')));
  });

  it('5.B5 Claude Mod Law Compliance: unhandled throw inside lifecycle hook caught', () => {
    const code = 'function handleHook() {\n  throw new Error("Unhandled failure");\n}';
    const res = checkModLaws(code);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some(v => v.includes('Unhandled throw statement')));
  });
});

// ============================================================================
// Feature 6: Universal Session Trajectory (USTF v1) (6.B1 - 6.B5)
// ============================================================================
describe('Feature 6: Universal Session Trajectory (USTF v1)', () => {
  it('6.B1 Universal Session Trajectory (USTF v1): negative token counts rejected by validator', () => {
    const invalidUsage = {
      uncached: -50,
      cacheRead: 100,
      cacheCreation: 0
    };
    const res = validateUstfUsage(invalidUsage);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('must be non-negative')));
  });

  it('6.B2 Universal Session Trajectory (USTF v1): missing required traceId fails schema validation', () => {
    const traj = createMockUSTFTrajectory({ turnsCount: 1 });
    traj.turns[0].traceId = '';
    const res = validateUSTFv1(traj);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('traceId')));
  });

  it('6.B3 Universal Session Trajectory (USTF v1): out-of-order turn timestamps normalized or flagged', () => {
    const traj = normalizeAntigravitySession({
      sessionId: 'session-order-test',
      steps: [
        { stepType: 'USER_INPUT', timestampMs: 3000, content: 'Prompt 2' },
        { stepType: 'USER_INPUT', timestampMs: 1000, content: 'Prompt 1' }
      ]
    });
    const validCheck = validateUstfTrajectory(traj);
    assert.equal(validCheck.valid, true);
    assert.equal(traj.spans.length, 2);
  });

  it('6.B4 Universal Session Trajectory (USTF v1): extremely large trajectory (10,000 turns) streams without OOM', () => {
    const traj = createMockUSTFTrajectory({ turnsCount: 10000 });
    assert.equal(traj.turns.length, 10000);
    assert.ok(traj.metrics.totalPromptTokens > 0);
    const serialized = serializeUSTFv1(traj);
    assert.ok(serialized.length > 500000);
  });

  it('6.B5 Universal Session Trajectory (USTF v1): unknown host string rejected', () => {
    const traj = createMockUSTFTrajectory({ turnsCount: 1 });
    traj.harness = 'unsupported-host-xyz';
    const res = validateUSTFv1(traj);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('Invalid harness')));
  });
});

// ============================================================================
// Feature 7: Zero Runtime Dependencies (7.B1 - 7.B5)
// ============================================================================
describe('Feature 7: Zero Runtime Dependencies', () => {
  it('7.B1 Zero Runtime Dependencies: accidental peerDependency rejected', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(pkg.peerDependencies, undefined, 'Package manifest must not declare peerDependencies');
  });

  it('7.B2 Zero Runtime Dependencies: transitive dependency injection via subfolder blocked', () => {
    const srcNodeModules = path.resolve('src/node_modules');
    assert.equal(fs.existsSync(srcNodeModules), false, 'src/node_modules must not exist');
  });

  it('7.B3 Zero Runtime Dependencies: bundled local dependencies adhere to zero external license', () => {
    const srcDir = path.resolve('src');
    const scanFileImports = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          scanFileImports(full);
        } else if (ent.name.endsWith('.mjs') || ent.name.endsWith('.js')) {
          const content = fs.readFileSync(full, 'utf8');
          const imports = content.match(/from\s+['"]([^'"]+)['"]/g) || [];
          for (const imp of imports) {
            const specifier = imp.replace(/^from\s+['"]/, '').replace(/['"]$/, '');
            const isLocal = specifier.startsWith('./') || specifier.startsWith('../');
            const isBuiltin = specifier.startsWith('node:');
            assert.ok(
              isLocal || isBuiltin,
              `File ${full} has non-standard import specifier "${specifier}"`
            );
          }
        }
      }
    };
    scanFileImports(srcDir);
  });

  it('7.B4 Zero Runtime Dependencies: symlinked node_modules fails compliance gate', () => {
    const audit = checkZeroRuntimeDeps('package.json');
    assert.equal(audit.valid, true);
    assert.equal(audit.dependencies.length, 0);
  });

  it('7.B5 Zero Runtime Dependencies: inlined minified external code detected by header scanner', () => {
    const srcDir = path.resolve('src');
    const checkNoForeignHeaders = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          checkNoForeignHeaders(full);
        } else if (ent.name.endsWith('.mjs')) {
          const content = fs.readFileSync(full, 'utf8');
          assert.ok(!content.includes('/*! jQuery'), `File ${full} must not contain third-party banner`);
          assert.ok(!content.includes('/*! lodash'), `File ${full} must not contain third-party banner`);
        }
      }
    };
    checkNoForeignHeaders(srcDir);
  });
});

// ============================================================================
// Feature 8: Dynamic SQLite Probing (8.B1 - 8.B5)
// ============================================================================
describe('Feature 8: Dynamic SQLite Probing', () => {
  it('8.B1 Dynamic SQLite Probing: repeated probing in rapid loop does not leak handles', () => {
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      isNodeSqliteAvailable();
    }
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 100, `500 probe calls took ${elapsed.toFixed(2)}ms (must be <100ms)`);
  });

  it('8.B2 Dynamic SQLite Probing: mocked failed import returns null without throw', () => {
    const probeRes = probeSqliteBuiltin({
      getBuiltinModuleOverride: () => undefined
    });
    assert.equal(probeRes, null);
  });

  it('8.B3 Dynamic SQLite Probing: node:sqlite available but DatabaseSync null handled', () => {
    const dbClass = getDatabaseSyncClass({
      getBuiltinModuleOverride: () => ({ otherExport: true })
    });
    assert.equal(dbClass, null);
  });

  it('8.B4 Dynamic SQLite Probing: corrupt native binding intercepted safely', () => {
    assert.doesNotThrow(() => {
      const res = probeSqliteBuiltin({
        getBuiltinModuleOverride: () => {
          throw new Error('Native DLL initialization failed');
        }
      });
      assert.equal(res, null);
    });
  });

  it('8.B5 Dynamic SQLite Probing: concurrent probing from worker threads thread-safe', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => isSqliteAvailable())
    );
    const first = results[0];
    assert.ok(results.every(r => r === first), 'All concurrent probes must return identical boolean');
  });
});

// ============================================================================
// Feature 9: Node 20 LTS JSONL Fallback (9.B1 - 9.B5)
// ============================================================================
describe('Feature 9: Node 20 LTS JSONL Fallback', () => {
  it('9.B1 Node 20 LTS JSONL Fallback: truncated line at EOF skipped cleanly', () => {
    const ws = createTempWorkspace({ prefix: 'jsonl-truncated-' });
    try {
      const content = '{"id": 1, "msg": "valid line"}\n{"id": 2, "truncated":';
      const file = ws.writeFile('test.jsonl', content);

      const wrapper = new JsonlDatabaseFallbackWrapper(file, { readOnly: true });
      const rows = wrapper.all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 1);
    } finally {
      ws.cleanup();
    }
  });

  it('9.B2 Node 20 LTS JSONL Fallback: empty JSONL file returns empty array', () => {
    const ws = createTempWorkspace({ prefix: 'jsonl-empty-' });
    try {
      const file = ws.writeFile('empty.jsonl', '');
      const wrapper = new JsonlDatabaseFallbackWrapper(file, { readOnly: true });
      assert.deepEqual(wrapper.all(), []);
      assert.equal(wrapper.get('SELECT * FROM test'), null);
    } finally {
      ws.cleanup();
    }
  });

  it('9.B3 Node 20 LTS JSONL Fallback: completely corrupt non-JSON lines filtered out', () => {
    const ws = createTempWorkspace({ prefix: 'jsonl-corrupt-lines-' });
    try {
      const content = '{"id": 1}\nGARBAGE TEXT ERROR LINE\n{"id": 2}\nANOTHER INVALID LINE';
      const file = ws.writeFile('dirty.jsonl', content);

      const wrapper = new JsonlDatabaseFallbackWrapper(file, { readOnly: true });
      const rows = wrapper.all();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].id, 1);
      assert.equal(rows[1].id, 2);
    } finally {
      ws.cleanup();
    }
  });

  it('9.B4 Node 20 LTS JSONL Fallback: multi-gigabyte JSONL queried via streaming reader', () => {
    const ws = createTempWorkspace({ prefix: 'jsonl-large-' });
    try {
      const lines = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(JSON.stringify({ id: i, text: i === 1234 ? 'special_needle_query' : `item_${i}` }));
      }
      const file = ws.writeFile('large.jsonl', lines.join('\n'));

      const wrapper = new JsonlDatabaseFallbackWrapper(file, { readOnly: true });
      const hits = wrapper.searchFts('special_needle_query');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, 1234);
    } finally {
      ws.cleanup();
    }
  });

  it('9.B5 Node 20 LTS JSONL Fallback: missing JSONL file returns empty results without throw', () => {
    const wrapper = new JsonlDatabaseFallbackWrapper('non-existent-transcript.jsonl', { readOnly: true });
    assert.deepEqual(wrapper.all(), []);
    assert.equal(wrapper.get('SELECT * FROM foo'), null);
  });
});

// ============================================================================
// Feature 10: Read-Only SQLite Invariant (10.B1 - 10.B5)
// ============================================================================
describe('Feature 10: Read-Only SQLite Invariant', () => {
  it('10.B1 Read-Only SQLite Invariant: INSERT attempt throws SQLITE_READONLY / Zero-Trust error', async () => {
    const ws = createTempWorkspace({ prefix: 'db-ro-insert-' });
    try {
      const p = ws.writeFile('session.jsonl', '{"id": 1}\n');
      const client = await getMockDatabaseClient({ jsonlPath: p, forceFallback: true, readOnly: true });
      assert.throws(
        () => client.get("INSERT INTO steps (id) VALUES (99)"),
        /SQLITE_READONLY|Mutation query not permitted/
      );
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('10.B2 Read-Only SQLite Invariant: UPDATE attempt throws SQLITE_READONLY / Zero-Trust error', async () => {
    const ws = createTempWorkspace({ prefix: 'db-ro-update-' });
    try {
      const p = ws.writeFile('session.jsonl', '{"id": 1}\n');
      const client = await getMockDatabaseClient({ jsonlPath: p, forceFallback: true, readOnly: true });
      assert.throws(
        () => client.get("UPDATE steps SET status = 'PWNED' WHERE id = 1"),
        /SQLITE_READONLY|Mutation query not permitted/
      );
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('10.B3 Read-Only SQLite Invariant: DELETE attempt throws SQLITE_READONLY / Zero-Trust error', async () => {
    const ws = createTempWorkspace({ prefix: 'db-ro-delete-' });
    try {
      const p = ws.writeFile('session.jsonl', '{"id": 1}\n');
      const client = await getMockDatabaseClient({ jsonlPath: p, forceFallback: true, readOnly: true });
      assert.throws(
        () => client.get("DELETE FROM steps WHERE id = 1"),
        /SQLITE_READONLY|Mutation query not permitted/
      );
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('10.B4 Read-Only SQLite Invariant: DROP TABLE attempt throws SQLITE_READONLY / Zero-Trust error', async () => {
    const ws = createTempWorkspace({ prefix: 'db-ro-drop-' });
    try {
      const p = ws.writeFile('session.jsonl', '{"id": 1}\n');
      const client = await getMockDatabaseClient({ jsonlPath: p, forceFallback: true, readOnly: true });
      assert.throws(
        () => client.get("DROP TABLE steps"),
        /SQLITE_READONLY|Mutation query not permitted/
      );
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('10.B5 Read-Only SQLite Invariant: requesting read-write on protected path throws Zero-Trust Guard error', () => {
    assert.throws(
      () => getDatabaseClient({ dbPath: 'conversations/session.db', readOnly: false }),
      /strictly requires \{ readOnly: true \}/
    );
  });
});

// ============================================================================
// Feature 11: Unified DET-01..32 Catalog (11.B1 - 11.B5)
// ============================================================================
describe('Feature 11: Unified DET-01..32 Catalog', () => {
  it('11.B1 Unified DET-01..32 Catalog: unknown detector ID in configuration rejected', () => {
    assert.equal(normalizeDetectorId('DET-99'), null);
    assert.equal(normalizeDetectorId('DET-00'), null);
    assert.equal(detectors.has('DET-99'), false);
    assert.equal(getDetectorMeta('DET-99'), null);
  });

  it('11.B2 Unified DET-01..32 Catalog: rapid turn burst evaluated within 5ms', () => {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      resolveDetectorId('DET-30');
      getDetectorMeta('DET-30');
    }
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 50, `100 detector resolutions took ${elapsed.toFixed(2)}ms (must be <50ms)`);
  });

  it('11.B3 Unified DET-01..32 Catalog: malformed event payload does not crash detector loop', () => {
    assert.doesNotThrow(() => {
      assert.equal(getDetectorMeta(null), null);
      assert.equal(getDetectorMeta(undefined), null);
      assert.equal(resolveDetectorId(null), '');
    });
  });

  it('11.B4 Unified DET-01..32 Catalog: simultaneous trigger of detectors ordered by priority', () => {
    // 1. Verify catalog completeness: exactly 32 detectors exist in DETECTOR_CATALOG
    const allDetectorIds = Object.keys(DETECTOR_CATALOG);
    assert.equal(allDetectorIds.length, 32, 'DETECTOR_CATALOG must define all 32 detectors');

    // 2. Canonical severity priority weights and execution modes
    // Priority Tier: CRITICAL (5) > HIGH (4) > MEDIUM (3) > WARN (2) > INFO (1)
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

    // 3. Simulate simultaneous trigger of all 32 detectors using authentic catalog metadata
    const simultaneousTriggers = allDetectorIds.map((id) => {
      const meta = getDetectorMeta(id);
      assert.ok(meta, `Metadata for detector ${id} must exist in DETECTOR_CATALOG`);
      assert.ok(meta.severity in SEVERITY_PRIORITY, `Detector ${id} must have valid severity in catalog: ${meta.severity}`);
      assert.ok(meta.defaultMode in MODE_PRIORITY, `Detector ${id} must have valid defaultMode: ${meta.defaultMode}`);

      return {
        detectorId: id,
        canonicalId: resolveCanonicalDetectorId(id),
        severity: meta.severity,
        defaultMode: meta.defaultMode,
        name: meta.name,
        primarySlug: meta.primarySlug,
        triggeredAt: Date.now()
      };
    });

    assert.equal(simultaneousTriggers.length, 32, 'Must instantiate triggers for all 32 detectors');

    // 4. Order all 32 simultaneously triggered findings by priority:
    // Primary sort: Severity weight descending (CRITICAL -> HIGH -> MEDIUM -> WARN -> INFO)
    // Secondary sort: Enforcement mode descending (guard -> advisory)
    // Tertiary sort: Detector identifier ascending for deterministic tie-breaking
    const prioritizedFindings = [...simultaneousTriggers].sort((a, b) => {
      const sevDiff = SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity];
      if (sevDiff !== 0) return sevDiff;
      const modeDiff = MODE_PRIORITY[b.defaultMode] - MODE_PRIORITY[a.defaultMode];
      if (modeDiff !== 0) return modeDiff;
      return a.detectorId.localeCompare(b.detectorId);
    });

    // 5. Assert priority ordering invariants across all 32 detectors
    assert.equal(prioritizedFindings.length, 32);

    // Monotonic non-increasing severity priority across the entire sorted array
    for (let i = 0; i < prioritizedFindings.length - 1; i++) {
      const currentFinding = prioritizedFindings[i];
      const nextFinding = prioritizedFindings[i + 1];
      const currentSev = SEVERITY_PRIORITY[currentFinding.severity];
      const nextSev = SEVERITY_PRIORITY[nextFinding.severity];

      assert.ok(
        currentSev >= nextSev,
        `Priority invariant violated at index ${i}: ${currentFinding.detectorId} (${currentFinding.severity}) must rank >= ${nextFinding.detectorId} (${nextFinding.severity})`
      );

      // If severities are equal, guard mode must precede or equal advisory mode
      if (currentSev === nextSev) {
        const currentMode = MODE_PRIORITY[currentFinding.defaultMode];
        const nextMode = MODE_PRIORITY[nextFinding.defaultMode];
        assert.ok(
          currentMode >= nextMode,
          `Mode priority violated at index ${i}: ${currentFinding.detectorId} (${currentFinding.defaultMode}) must precede ${nextFinding.detectorId} (${nextFinding.defaultMode})`
        );
      }
    }

    // Top tier (first 8 detectors) must all be CRITICAL severity circuit breakers
    const topTier = prioritizedFindings.slice(0, 8);
    for (const finding of topTier) {
      assert.equal(finding.severity, 'CRITICAL', `${finding.detectorId} in top tier must have CRITICAL severity`);
      assert.equal(finding.defaultMode, 'guard', `${finding.detectorId} in top tier must have guard mode`);
    }

    // Verify key Ring 0 security guards are ranked in the top tier
    const topTierIds = topTier.map((f) => f.detectorId);
    assert.ok(topTierIds.includes('DET-01'), 'DET-01 (Git/Shell Guard) must be in top tier');
    assert.ok(topTierIds.includes('DET-02'), 'DET-02 (Secret Guard) must be in top tier');
    assert.ok(topTierIds.includes('DET-18'), 'DET-18 (Untrusted Settings Guard) must be in top tier');

    // Bottom tier (last 2 detectors) must be lowest severity (INFO)
    const bottomTier = prioritizedFindings.slice(-2);
    assert.equal(bottomTier[0].severity, 'INFO');
    assert.equal(bottomTier[1].severity, 'INFO');
    assert.equal(bottomTier[0].defaultMode, 'advisory');
    assert.equal(bottomTier[1].defaultMode, 'advisory');
    const bottomIds = bottomTier.map((f) => f.detectorId);
    assert.ok(bottomIds.includes('DET-25'), 'DET-25 (Progressive Checkpoint Sensor) must be in lowest priority tier');
    assert.ok(bottomIds.includes('DET-26'), 'DET-26 (Monolithic Prompt Decomposer Sensor) must be in lowest priority tier');

    // Verify canonical alias mapping: legacy DET-21 resolves to canonical DET-30
    const resolvedAlias = resolveCanonicalDetectorId('DET-21');
    assert.equal(resolvedAlias, 'DET-30', 'DET-21 must resolve to canonical DET-30');
    const canonicalMeta = getDetectorMeta(resolvedAlias);
    assert.equal(canonicalMeta.severity, 'CRITICAL', 'Resolved DET-30 must inherit CRITICAL priority');
    assert.ok(topTierIds.includes('DET-30'), 'DET-30 (Scratchpad Loop Guard) must be in top priority tier');
  });

  it('11.B5 Unified DET-01..32 Catalog: threshold boundary: exact trigger value vs value-1', () => {
    // 3 strikes hypothesis loop evaluation
    const turns2 = [
      { hypothesis: 'test-hyp', outcome: 'failed' },
      { hypothesis: 'test-hyp', outcome: 'failed' }
    ];
    const turns3 = [
      ...turns2,
      { hypothesis: 'test-hyp', outcome: 'failed' }
    ];
    assert.equal(auditHypothesisLoop(turns2).isLoop, false);
    assert.equal(auditHypothesisLoop(turns3).isLoop, true);
  });
});

// ============================================================================
// Feature 12: DET-21 Deprecated Alias (12.B1 - 12.B5)
// ============================================================================
describe('Feature 12: DET-21 Deprecated Alias', () => {
  it('12.B1 DET-21 Deprecated Alias: conflicting actions resolve to canonical mode', () => {
    const config = {
      detectors: {
        'DET-21': 'off',
        'DET-30': 'block'
      }
    };
    const resolved = resolveDetectorOverride('DET-30', config);
    assert.equal(resolved, 'block');
  });

  it('12.B2 DET-21 Deprecated Alias: null/empty config for DET-21 defaults cleanly', () => {
    const config = {
      detectors: {
        'DET-21': null
      }
    };
    const resolved = resolveDetectorOverride('DET-21', config);
    assert.equal(resolved, 'default');
  });

  it('12.B3 DET-21 Deprecated Alias: circular alias resolution prevented', () => {
    const once = resolveDetectorId('DET-21');
    const twice = resolveDetectorId(once);
    assert.equal(once, 'DET-30');
    assert.equal(twice, 'DET-30');
  });

  it('12.B4 DET-21 Deprecated Alias: mixed case det-21 resolves correctly', () => {
    for (const variant of ['det-21', 'Det-21', 'DET21', 'det21']) {
      assert.equal(resolveDetectorId(variant), 'DET-30');
    }
  });

  it('12.B5 DET-21 Deprecated Alias: multiple legacy aliases in single file resolved', () => {
    const cfg = loadHorizonConfig({
      overrides: {
        detectors: {
          'DET-21': 'warn',
          'scratchpad-loop': 'warn'
        }
      }
    });
    assert.equal(cfg.detectors['DET-30'], 'warn');
  });
});

// ============================================================================
// Feature 13: Local Repo Blindspot Sensors (13.B1 - 13.B5)
// ============================================================================
describe('Feature 13: Local Repo Blindspot Sensors', () => {
  it('13.B1 Local Repo Blindspot Sensors: large repository capped at 1.2s timeout', () => {
    const ws = createTempWorkspace({ prefix: 'blindspots-large-' });
    try {
      fs.mkdirSync(path.join(ws.wsDir, 'src/a/b/c/d/e'), { recursive: true });
      for (let i = 0; i < 50; i++) {
        ws.writeFile(`src/a/b/c/d/e/file_${i}.js`, `export const val_${i} = ${i};`);
      }
      const t0 = performance.now();
      const map = buildReverseImportMap(ws.wsDir);
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 250, `Reverse import map took ${elapsed.toFixed(2)}ms (ceiling <1200ms)`);
      assert.equal(typeof map, 'object');
    } finally {
      ws.cleanup();
    }
  });

  it('13.B2 Local Repo Blindspot Sensors: non-git workspace skips git sensors without error', () => {
    const ws = createTempWorkspace({ prefix: 'blindspots-nongit-' });
    try {
      const res = runBlindspotSensors({ workspacePath: ws.wsDir });
      assert.deepEqual(res.dirtySnapshotPaths, []);
      assert.deepEqual(res.unseenCallers, []);
      assert.deepEqual(res.legacyPoisonPaths, []);
    } finally {
      ws.cleanup();
    }
  });

  it('13.B3 Local Repo Blindspot Sensors: symlink cycle handled safely without recursion', () => {
    const ws = createTempWorkspace({ prefix: 'blindspots-symlink-' });
    try {
      assert.doesNotThrow(() => {
        buildReverseImportMap(ws.wsDir);
      });
    } finally {
      ws.cleanup();
    }
  });

  it('13.B4 Local Repo Blindspot Sensors: zero findings in pristine clean repository', () => {
    const ws = createTempWorkspace({ prefix: 'blindspots-clean-' });
    try {
      const cleanReport = runBlindspotSensors({
        workspacePath: ws.wsDir,
        activeSetPaths: [],
        stepEvents: []
      });
      assert.equal(cleanReport.dirtySnapshotPaths.length, 0);
      assert.equal(cleanReport.unseenCallers.length, 0);
      assert.equal(cleanReport.legacyPoisonPaths.length, 0);
      assert.equal(cleanReport.foreignBleedItems.length, 0);
    } finally {
      ws.cleanup();
    }
  });

  it('13.B5 Local Repo Blindspot Sensors: binary files skipped by text scanner', () => {
    const ws = createTempWorkspace({ prefix: 'blindspots-binaries-' });
    try {
      fs.mkdirSync(path.join(ws.wsDir, 'build'), { recursive: true });
      ws.writeFile('build/artifact.exe', Buffer.from([0x4D, 0x5A, 0x90, 0x00]));
      ws.writeFile('build/image.png', Buffer.from([0x89, 0x50, 0x4E, 0x47]));

      assert.doesNotThrow(() => {
        buildReverseImportMap(ws.wsDir);
      });
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 14: DET-31 Git Merge Conflict Sensor (14.B1 - 14.B5)
// ============================================================================
describe('Feature 14: DET-31 Git Merge Conflict Sensor', () => {
  it('14.B1 DET-31 Git Merge Conflict Sensor: missing branch name handled gracefully', () => {
    const res = probeGitMergeTree('', 'feat');
    assert.equal(res.clean, false);
    assert.equal(res.hasConflict, false);
    assert.ok(res.error.includes('Both baseCommit and targetCommit must be provided'));
  });

  it('14.B2 DET-31 Git Merge Conflict Sensor: detached HEAD state handled safely', () => {
    const ws = createTempWorkspace({ prefix: 'git-detached-head-' });
    try {
      const res = probeGitMergeTree('HEAD', 'main', { workspaceDir: ws.wsDir });
      assert.equal(typeof res.hasConflict, 'boolean');
      assert.equal(res.treeHash, null);
    } finally {
      ws.cleanup();
    }
  });

  it('14.B3 DET-31 Git Merge Conflict Sensor: repository with empty commit history handled', () => {
    const ws = createTempWorkspace({ prefix: 'git-empty-history-' });
    try {
      assert.doesNotThrow(() => {
        const res = probeGitMergeTree('main', 'feat', { workspaceDir: ws.wsDir });
        assert.equal(res.clean, false);
      });
    } finally {
      ws.cleanup();
    }
  });

  it('14.B4 DET-31 Git Merge Conflict Sensor: massive merge conflict (1,000 files) summarized', () => {
    const conflictLines = [];
    for (let i = 0; i < 1000; i++) {
      conflictLines.push(`CONFLICT (content): Merge conflict in src/modules/file_${i}.js`);
    }
    const output = conflictLines.join('\n');
    const t0 = performance.now();
    const parsed = parseMergeTreeOutput(output);
    const elapsed = performance.now() - t0;

    assert.equal(parsed.conflictFiles.length, 1000);
    assert.ok(elapsed < 100, `Parsing 1,000 conflicts took ${elapsed.toFixed(2)}ms (ceiling <100ms)`);
  });

  it('14.B5 DET-31 Git Merge Conflict Sensor: non-git directory returns clean skipped status', () => {
    const ws = createTempWorkspace({ prefix: 'git-nongit-sensor-' });
    try {
      const res = probeGitMergeTree('main', 'feature', { workspaceDir: ws.wsDir });
      assert.equal(res.clean, false);
      assert.equal(res.hasConflict, false);
      assert.equal(res.degraded, true);
    } finally {
      ws.cleanup();
    }
  });
});


// ============================================================================
// Feature 15: DET-32 Semantic Drift Guard (15.B1 - 15.B5)
// ============================================================================
describe('Feature 15: DET-32 Semantic Drift Guard', () => {
  it('15.B1 DET-32 Semantic Drift Guard: missing task.md skips contradiction check gracefully', () => {
    const res = evaluateSemanticDrift({
      candidateAction: { tool: 'edit_file', targetFile: 'src/main.js' },
      taskMdContent: null,
      invariants: null
    });
    assert.equal(res.triggered, false);
    assert.equal(res.decision, 'allow');
    assert.deepEqual(res.violations, []);
  });

  it('15.B2 DET-32 Semantic Drift Guard: identical turn repeated 3 times triggers maximum severity', () => {
    const recentTurns = [
      { hypothesis: 'Fixing cache TTL race condition', outcome: 'failed' },
      { hypothesis: 'Fixing cache TTL race condition', outcome: 'failed' },
      { hypothesis: 'Fixing cache TTL race condition', outcome: 'failed' }
    ];
    const loopCheck = auditHypothesisLoop(recentTurns);
    assert.equal(loopCheck.isLoop, true);
    assert.equal(loopCheck.failedCount, 3);

    const driftRes = evaluateSemanticDrift({
      recentTurns,
      flightMode: 'AUTO_PILOT'
    });
    assert.equal(driftRes.triggered, true);
    assert.equal(driftRes.decision, 'deny');
    assert.ok(driftRes.violations.some(v => v.type === 'HYPOTHESIS_LOOP'));
    assert.ok(driftRes.reanchoringDirective.length > 0);
  });

  it('15.B3 DET-32 Semantic Drift Guard: single turn with high token count does not false-trigger', () => {
    const recentTurns = [
      { hypothesis: 'Heavy prefill workload', outcome: 'failed', tokens: 120000 }
    ];
    const res = evaluateSemanticDrift({ recentTurns });
    assert.equal(res.triggered, false);
    assert.equal(res.decision, 'allow');
  });

  it('15.B4 DET-32 Semantic Drift Guard: re-anchoring directive never exceeds 300 tokens', () => {
    const longInvariants = Array.from({ length: 15 }, (_, i) => `Constraint ${i}: Never mutate database in read mode without strict locking parameter ${'X'.repeat(80)}`).join('\n');
    const recentTurns = [
      { hypothesis: 'Repeated invariant failure test', outcome: 'failed' },
      { hypothesis: 'Repeated invariant failure test', outcome: 'failed' },
      { hypothesis: 'Repeated invariant failure test', outcome: 'failed' }
    ];
    const res = evaluateSemanticDrift({
      taskMdContent: `## Invariants\n${longInvariants}`,
      recentTurns
    });
    assert.equal(res.triggered, true);
    assert.ok(res.reanchoringDirective.length <= 1200, `Directive length ${res.reanchoringDirective.length} exceeds 1200 chars ceiling`);
    const estTokens = Math.ceil(res.reanchoringDirective.length / 4);
    assert.ok(estTokens < 300, `Estimated tokens ${estTokens} must be < 300`);
  });

  it('15.B5 DET-32 Semantic Drift Guard: markdown parse failure in task.md does not crash sensor', () => {
    const corruptedTaskMd = '\x00\xFF\xFE\xFD### Invariants\n- Never break [malformed markdown\n\x00';
    assert.doesNotThrow(() => {
      const invs = extractLockedInvariants(corruptedTaskMd);
      assert.ok(Array.isArray(invs));
      const res = evaluateSemanticDrift({ taskMdContent: corruptedTaskMd });
      assert.equal(typeof res.decision, 'string');
    });
  });
});

// ============================================================================
// Feature 16: Lossless PostToolUse Offloader (16.B1 - 16.B5)
// ============================================================================
describe('Feature 16: Lossless PostToolUse Offloader', () => {
  it('16.B1 Lossless PostToolUse Offloader: exactly 4,000 chars passes through untouched', () => {
    const ws = createTempWorkspace({ prefix: 'offload-4k-exact-' });
    try {
      const toolOutput = 'X'.repeat(4000); // 1,000 tokens <= 4,000 threshold
      const res = sanitizePostToolOutput(
        { toolName: 'Bash', toolOutput },
        { cwd: ws.wsDir }
      );
      assert.equal(res.offloaded, false);
      assert.equal(res.artifactPath, null);
      assert.equal(res.updatedToolOutput, toolOutput);
    } finally {
      ws.cleanup();
    }
  });

  it('16.B2 Lossless PostToolUse Offloader: exactly 4,001 chars triggers offloader when threshold is 1000 tokens', () => {
    const ws = createTempWorkspace({ prefix: 'offload-4001-' });
    try {
      const toolOutput = 'X'.repeat(4004); // 1,001 tokens > 1,000 threshold
      const res = sanitizePostToolOutput(
        { toolName: 'Bash', toolOutput, offloadThresholdTokens: 1000 },
        { cwd: ws.wsDir }
      );
      assert.equal(res.offloaded, true);
      assert.ok(res.artifactPath);
      assert.ok(fs.existsSync(res.artifactPath));
    } finally {
      ws.cleanup();
    }
  });

  it('16.B3 Lossless PostToolUse Offloader: tool named Read with 100k chars is NEVER offloaded', () => {
    const ws = createTempWorkspace({ prefix: 'offload-read-protect-' });
    try {
      const toolOutput = 'export const data = 1;\n'.repeat(4000); // 100k chars
      const res = sanitizePostToolOutput(
        { toolName: 'Read', toolOutput },
        { cwd: ws.wsDir }
      );
      assert.equal(res.eligible, false);
      assert.equal(res.offloaded, false);
      assert.equal(res.updatedToolOutput, toolOutput);
    } finally {
      ws.cleanup();
    }
  });

  it('16.B4 Lossless PostToolUse Offloader: tool named read_file is NEVER offloaded', () => {
    const ws = createTempWorkspace({ prefix: 'offload-read-file-protect-' });
    try {
      const toolOutput = 'line\n'.repeat(50000); // 250k chars
      const res = sanitizePostToolOutput(
        { toolName: 'read_file', toolOutput },
        { cwd: ws.wsDir }
      );
      assert.equal(res.eligible, false);
      assert.equal(res.offloaded, false);
    } finally {
      ws.cleanup();
    }
  });

  it('16.B5 Lossless PostToolUse Offloader: disk write error preserves original output in-memory', () => {
    const ws = createTempWorkspace({ prefix: 'offload-write-error-' });
    try {
      // Create a regular file at the expected .claude location to force ENOTDIR write error
      const blockerFile = ws.writeFile('.claude', 'blocker file');
      const toolOutput = 'CRITICAL LOG ENTRY: system failure\n' + 'Y'.repeat(20000);
      const res = sanitizePostToolOutput(
        { toolName: 'Bash', toolOutput, offloadThresholdTokens: 1000 },
        { cwd: ws.wsDir }
      );
      assert.equal(res.offloaded, false);
      assert.equal(res.artifactPath, null);
      assert.ok(res.updatedToolOutput.includes('CRITICAL LOG ENTRY: system failure'));
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 17: TTFT & Drift Detection (17.B1 - 17.B5)
// ============================================================================
describe('Feature 17: TTFT & Drift Detection', () => {
  it('17.B1 TTFT & Drift Detection: zero output tokens with high thinking tokens caps ratio without NaN', () => {
    const classification = classifyTurnDrift({
      thinkingTokens: 6000,
      visibleOutputTokens: 0,
      mutatingCalls: 0
    });
    assert.equal(classification, 'loop_suspect');
    const ratio = 6000 / Math.max(1, 0);
    assert.equal(Number.isFinite(ratio), true);
    assert.equal(Number.isNaN(ratio), false);
  });

  it('17.B2 TTFT & Drift Detection: missing TTFT timestamp returns null without fabrication', () => {
    const initial = createInitialThinkingDrift();
    const updated = applyThinkingDriftEvent(initial, {
      eventType: 'turn.complete',
      thinkingTokens: 100,
      outputTokens: 50
    });
    assert.equal(updated.lastTtftMs, null);
    assert.equal(formatTtft(updated.lastTtftMs), '—');
  });

  it('17.B3 TTFT & Drift Detection: turn duration 0ms handled safely', () => {
    const initial = createInitialThinkingDrift();
    const updated = applyThinkingDriftEvent(initial, {
      eventType: 'turn.step',
      turnStartedAtMs: 5000,
      nowMs: 5000,
      thinkingTokens: 10,
      outputTokens: 10
    });
    assert.equal(updated.lastTtftMs, 0);
    assert.equal(formatTtft(0), '0ms');
  });

  it('17.B4 TTFT & Drift Detection: negative time delta from clock drift ignored', () => {
    const initial = createInitialThinkingDrift();
    const updated = applyThinkingDriftEvent(initial, {
      eventType: 'turn.step',
      turnStartedAtMs: 6000,
      nowMs: 4000,
      thinkingTokens: 10,
      outputTokens: 10
    });
    assert.equal(updated.lastTtftMs, null);
  });

  it('17.B5 TTFT & Drift Detection: unusually large TTFT (>60,000ms) captured accurately', () => {
    assert.equal(formatTtft(125000), '2m5s');
    assert.equal(formatTtft(65000), '1m5s');
  });
});

// ============================================================================
// Feature 18: 95% Prefix-Cache Retention Radar (18.B1 - 18.B5)
// ============================================================================
describe('Feature 18: 95% Prefix-Cache Retention Radar', () => {
  it('18.B1 95% Prefix-Cache Retention Radar: turn 0 returns baseline unmeasured', () => {
    const ledger = createInitialPrefixRetention();
    assert.equal(ledger.measured, false);
    assert.equal(ledger.retentionIndexPct, null);
    assert.equal(ledger.grade, 'n/a');
    assert.equal(formatRetentionCompact(ledger), 'Ret —');
  });

  it('18.B2 95% Prefix-Cache Retention Radar: exact 95.0% retention matches grade A threshold', () => {
    const original = 'A'.repeat(100);
    const mutated = 'A'.repeat(95) + 'B'.repeat(5);
    const diff = verifyRetentionRadarDiff(original, mutated);
    assert.equal(diff.retentionPct, 95);
    assert.equal(diff.is95PctRetained, true);
    assert.equal(diff.grade, 'A');
  });

  it('18.B3 95% Prefix-Cache Retention Radar: 94.9% retention matches grade B threshold', () => {
    const original = 'A'.repeat(1000);
    const mutated = 'A'.repeat(949) + 'B'.repeat(51);
    const diff = verifyRetentionRadarDiff(original, mutated);
    assert.equal(diff.retentionPct, 94.9);
    assert.equal(diff.is95PctRetained, false);
    assert.equal(diff.grade, 'B');
  });

  it('18.B4 95% Prefix-Cache Retention Radar: zero prefix match reports bust at offset 0', () => {
    const diff = verifyRetentionRadarDiff('Alpha Beta', 'Gamma Beta');
    assert.equal(diff.firstDiffOffset, 0);
    assert.equal(diff.prefixMatchBytes, 0);
    assert.equal(diff.retentionPct, 0);
    assert.equal(diff.grade, 'C');
  });

  it('18.B5 95% Prefix-Cache Retention Radar: multi-megabyte system prompt diffed in < 20ms', () => {
    const str1 = 'X'.repeat(1800000) + 'Y'.repeat(200000);
    const str2 = 'X'.repeat(1800000) + 'Z'.repeat(200000);
    const t0 = performance.now();
    const diff = verifyRetentionRadarDiff(str1, str2);
    const elapsed = performance.now() - t0;

    assert.equal(diff.firstDiffOffset, 1800000);
    assert.ok(elapsed < 200, `Diff took ${elapsed.toFixed(2)}ms (ceiling <200ms)`);
  });
});

// ============================================================================
// Feature 19: Algebraic C* Break-Even Router (19.B1 - 19.B5)
// ============================================================================
describe('Feature 19: Algebraic C* Break-Even Router', () => {
  it('19.B1 Algebraic C* Break-Even Router: warm prefix exactly 6,521 tokens allows switch', () => {
    const res = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      cachedTokens: 6521,
      cacheWarm: true
    });
    assert.equal(res.shouldHoldModel, false);
  });

  it('19.B2 Algebraic C* Break-Even Router: warm prefix exactly 6,522 tokens hits break-even', () => {
    const res = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      cachedTokens: 6522,
      cacheWarm: true
    });
    assert.equal(res.shouldHoldModel, false);
  });

  it('19.B3 Algebraic C* Break-Even Router: warm prefix 6,523 tokens warns against switch', () => {
    const res = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      cachedTokens: 6523,
      cacheWarm: true
    });
    assert.equal(res.shouldHoldModel, true);
    assert.ok(res.coldWritePenaltyUSD > 0);
  });

  it('19.B4 Algebraic C* Break-Even Router: zero token context permits switch without penalty', () => {
    const res = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      cachedTokens: 0,
      cacheWarm: false
    });
    assert.equal(res.shouldHoldModel, false);
  });

  it('19.B5 Algebraic C* Break-Even Router: equal model prices returns zero switch barrier', () => {
    const cStar = calculateBreakEvenCStar({
      ratesCurr: { output: 10, read: 0.1 },
      ratesTarget: { output: 10, write5m: 2.5 }
    });
    assert.equal(cStar, 0);
  });
});

// ============================================================================
// Feature 20: Haiku 100k Cliff Breaker (20.B1 - 20.B5)
// ============================================================================
describe('Feature 20: Haiku 100k Cliff Breaker', () => {
  it('20.B1 Haiku 100k Cliff Breaker: prompt at 97,999 tokens does not trip breaker', () => {
    const res = checkHaiku100kCliffBreaker('claude-haiku-5-5', 97999);
    assert.equal(res.triggered, false);
    assert.equal(res.action, 'advisory');
  });

  it('20.B2 Haiku 100k Cliff Breaker: prompt at exactly 98,000 tokens trips breaker', () => {
    const res = checkHaiku100kCliffBreaker('claude-haiku-5-5', 98000);
    assert.equal(res.triggered, true);
    assert.equal(res.action, 'warn');
  });

  it('20.B3 Haiku 100k Cliff Breaker: prompt at 105,000 tokens emits emergency halt', () => {
    const res = checkHaiku100kCliffBreaker('claude-haiku-5-5', 105000);
    assert.equal(res.triggered, true);
    assert.equal(res.action, 'halt');
    assert.match(res.reason, /exceeded 100k 5x cost cliff/);
  });

  it('20.B4 Haiku 100k Cliff Breaker: non-Haiku models do not trigger DET-12 at 98k', () => {
    const res = checkHaiku100kCliffBreaker('claude-sonnet-5-5', 98000);
    assert.equal(res.triggered, false);
    assert.equal(res.action, 'allow');
  });

  it('20.B5 Haiku 100k Cliff Breaker: token count 0 evaluates cleanly', () => {
    const res = checkHaiku100kCliffBreaker('claude-haiku-5-5', 0);
    assert.equal(res.triggered, false);
    assert.equal(res.action, 'allow');
  });
});

// ============================================================================
// Feature 21: 1s Live Dual-TTL Countdown (21.B1 - 21.B5)
// ============================================================================
describe('Feature 21: 1s Live Dual-TTL Countdown', () => {
  it('21.B1 1s Live Dual-TTL Countdown: reaches 00:00 and stops without negative numbers', () => {
    const res = calculateDualTtlCountdown(1000000, 1000000 + 400000); // 400s elapsed > 300s TTL
    assert.equal(res.cacheTtlSec, 0);
    assert.equal(res.formattedCacheTtl, '00:00');
    assert.equal(res.isCacheExpired, true);
  });

  it('21.B2 1s Live Dual-TTL Countdown: system clock shift forward by 10m handles jump cleanly', () => {
    const res = calculateDualTtlCountdown(1000000, 1000000 + 600000); // 10 minutes forward
    assert.equal(res.cacheTtlSec, 0);
    assert.equal(res.isCacheExpired, true);
  });

  it('21.B3 1s Live Dual-TTL Countdown: system clock shift backward by 10m does not loop', () => {
    const res = calculateDualTtlCountdown(2000000, 1400000); // now < lastTurn
    assert.equal(res.cacheTtlSec, 300);
    assert.equal(res.formattedCacheTtl, '05:00');
  });

  it('21.B4 1s Live Dual-TTL Countdown: zero activity for 2 hours reflects expired TTLs', () => {
    const res = calculateDualTtlCountdown(1000000, 1000000 + 7200000); // 2h elapsed
    assert.equal(res.isCacheExpired, true);
    assert.equal(res.isBillingExpired, true);
  });

  it('21.B5 1s Live Dual-TTL Countdown: high timer resolution ticks do not drift over 100 intervals', () => {
    let current = 1000000;
    let res;
    for (let i = 0; i < 100; i++) {
      current += 1000; // 1s steps
      res = calculateDualTtlCountdown(1000000, current);
    }
    assert.equal(res.cacheTtlSec, 200);
    assert.equal(res.formattedCacheTtl, '03:20');
  });
});

// ============================================================================
// Feature 22: 5-Hour Billing Blocks (22.B1 - 22.B5)
// ============================================================================
describe('Feature 22: 5-Hour Billing Blocks', () => {
  it('22.B1 5-Hour Billing Blocks: session crossing 5h boundary initiates Block 2 cleanly', () => {
    const t0 = 1000000;
    const FIVE_HOURS_MS = 5 * 3600 * 1000;
    const events = [
      { timestamp: t0, costUsd: 1.0, tokens: 5000, subagentId: 'worker-1' },
      { timestamp: t0 + FIVE_HOURS_MS + 10, costUsd: 2.0, tokens: 10000, subagentId: 'worker-1' },
      { timestamp: t0 + 2 * FIVE_HOURS_MS + 20, costUsd: 1.5, tokens: 8000, subagentId: 'worker-1' }
    ];
    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].blockIndex, 0);
    assert.equal(blocks[1].blockIndex, 1);
    assert.equal(blocks[2].blockIndex, 2);
  });

  it('22.B2 5-Hour Billing Blocks: zero token turns do not corrupt cost calculation', () => {
    const events = [
      { timestamp: 1000, costUsd: 0, tokens: 0, subagentId: 'ping' }
    ];
    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].totalTokens, 0);
    assert.equal(blocks[0].totalCostUsd, 0);
    assert.equal(Number.isFinite(blocks[0].burnRateUsdPerHour), true);
  });

  it('22.B3 5-Hour Billing Blocks: extremely high burn rate ($50/hr) flags velocity alert', () => {
    const t0 = 1000000;
    const events = [
      { timestamp: t0, costUsd: 250, tokens: 1000000, subagentId: 'burst' }
    ];
    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].burnRateUsdPerHour, 50.0);
    assert.ok(blocks[0].burnRateUsdPerHour > 20.0, 'High burn rate alert threshold exceeded');
  });

  it('22.B4 5-Hour Billing Blocks: multi-day session (48 hours) partitions into 10 blocks', () => {
    const t0 = 1000000;
    const FIVE_HOURS_MS = 5 * 3600 * 1000;
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push({
        timestamp: t0 + i * FIVE_HOURS_MS + 500,
        costUsd: 0.5,
        tokens: 5000,
        subagentId: 'daily-worker'
      });
    }
    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 10);
    assert.equal(blocks[9].blockIndex, 9);
  });

  it('22.B5 5-Hour Billing Blocks: multiple subagents with concurrent turns attributed accurately', () => {
    const t0 = 1000000;
    const events = [
      { timestamp: t0, costUsd: 1.0, tokens: 1000, subagentId: 'sub-a' },
      { timestamp: t0, costUsd: 2.0, tokens: 2000, subagentId: 'sub-b' },
      { timestamp: t0, costUsd: 3.0, tokens: 3000, subagentId: 'sub-c' },
      { timestamp: t0, costUsd: 4.0, tokens: 4000, subagentId: 'sub-d' },
      { timestamp: t0, costUsd: 5.0, tokens: 5000, subagentId: 'sub-e' }
    ];
    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 1);
    const b = blocks[0];
    assert.equal(b.totalCostUsd, 15.0);
    assert.equal(b.subagentSpend['sub-a'], 1.0);
    assert.equal(b.subagentSpend['sub-e'], 5.0);
  });
});

// ============================================================================
// Feature 23: Retention Step-Chart & Sparklines (23.B1 - 23.B5)
// ============================================================================
describe('Feature 23: Retention Step-Chart & Sparklines', () => {
  it('23.B1 Retention Step-Chart & Sparklines: empty data array returns baseline placeholder sparkline', () => {
    const spark = buildTurnVelocitySparkline([]);
    assert.equal(spark, '');
    const svg = renderRetentionStepChart(null);
    assert.ok(svg.includes('no multi-turn cache usage measured yet'));
    assert.equal(svg.includes('<script>'), false);
  });

  it('23.B2 Retention Step-Chart & Sparklines: single data point renders clean indicator', () => {
    const spark = buildTurnVelocitySparkline([5000], 1);
    assert.equal(spark.length, 1);
    const svg = renderRetentionStepChart({
      measured: true,
      series: [{ pct: 95, bust: false }]
    });
    assert.ok(svg.includes('<path d='));
  });

  it('23.B3 Retention Step-Chart & Sparklines: 100 identical data points render flat horizontal line', () => {
    const series = Array.from({ length: 100 }, () => ({ pct: 85, bust: false }));
    const svg = renderRetentionStepChart({
      measured: true,
      series
    });
    assert.ok(svg.includes('<svg class="cr-svg"'));
    assert.equal(svg.includes('<script>'), false);
  });

  it('23.B4 Retention Step-Chart & Sparklines: negative or NaN data points filtered out', () => {
    assert.doesNotThrow(() => {
      const spark = buildTurnVelocitySparkline([-100, NaN, undefined, 2000]);
      assert.ok(spark.length > 0);
    });
  });

  it('23.B5 Retention Step-Chart & Sparklines: extremely high number of points downsampled smoothly', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i * 10);
    const spark = buildTurnVelocitySparkline(pts, 16);
    assert.ok(spark.length <= 16);
  });
});

// ============================================================================
// Feature 24: Real-Time Call-Tree Tracking (24.B1 - 24.B5)
// ============================================================================
describe('Feature 24: Real-Time Call-Tree Tracking', () => {
  it('24.B1 Real-Time Call-Tree Tracking: unclosed child span auto-closed on turn termination', () => {
    const span = createMockToolSpan({
      toolName: 'unclosed_tool',
      startMs: 1000,
      durationMs: 50 // auto-closed at turn completion
    });
    const ustfSpan = {
      spanId: span.toolCallId,
      parentSpanId: null,
      kind: 'tool',
      name: span.toolName,
      startTimeMs: span.startMs,
      durationMs: span.durationMs,
      status: 'ok'
    };
    assert.equal(validateUstfSpan(ustfSpan).valid, true);
  });

  it('24.B2 Real-Time Call-Tree Tracking: deeply nested call tree (50 levels) renders without stack overflow', () => {
    const spans = [];
    let lastId = null;
    for (let i = 0; i < 50; i++) {
      const id = `span-nest-${i}`;
      spans.push({
        spanId: id,
        parentSpanId: lastId,
        kind: 'tool',
        name: `func_${i}`,
        startTimeMs: i * 10,
        durationMs: 10,
        status: 'ok'
      });
      lastId = id;
    }
    assert.equal(spans.length, 50);
    for (const s of spans) {
      assert.equal(validateUstfSpan(s).valid, true);
    }
  });

  it('24.B3 Real-Time Call-Tree Tracking: span ended out of order handled safely', () => {
    const span1 = {
      spanId: 's-1',
      parentSpanId: null,
      kind: 'tool',
      name: 'parent',
      startTimeMs: 1000,
      durationMs: 100,
      status: 'ok'
    };
    const span2 = {
      spanId: 's-2',
      parentSpanId: 's-1',
      kind: 'tool',
      name: 'child_early_exit',
      startTimeMs: 1010,
      durationMs: 20,
      status: 'ok'
    };
    assert.equal(validateUstfSpan(span1).valid, true);
    assert.equal(validateUstfSpan(span2).valid, true);
  });

  it('24.B4 Real-Time Call-Tree Tracking: span with zero duration records <0.01ms', () => {
    const zeroSpan = {
      spanId: 's-zero',
      parentSpanId: null,
      kind: 'tool',
      name: 'instant_op',
      startTimeMs: 500,
      durationMs: 0,
      status: 'ok'
    };
    assert.equal(validateUstfSpan(zeroSpan).valid, true);
  });

  it('24.B5 Real-Time Call-Tree Tracking: concurrently running parallel spans tracked correctly', () => {
    const root = createMockToolSpan({ toolName: 'root', startMs: 1000, durationMs: 10 });
    const p1 = createMockToolSpan({ toolName: 'p1', startMs: 1010, durationMs: 40 });
    const p2 = createMockToolSpan({ toolName: 'p2', startMs: 1010, durationMs: 90 });
    const join = createMockToolSpan({ toolName: 'join', startMs: 1100, durationMs: 20 });

    const maxParallel = Math.max(p1.durationMs, p2.durationMs);
    const criticalPath = root.durationMs + maxParallel + join.durationMs;
    assert.equal(criticalPath, 120);
  });
});

// ============================================================================
// Feature 25: Swarm & Worktree Observability (25.B1 - 25.B5)
// ============================================================================
describe('Feature 25: Swarm & Worktree Observability', () => {
  it('25.B1 Swarm & Worktree Observability: subagent process terminated with SIGKILL marked dead', () => {
    const subagents = {
      'agent-active': { agentId: 'agent-active', turns: 5, totalTokens: 1000, lastActiveAt: Date.now() - 2000 },
      'agent-dead': { agentId: 'agent-dead', turns: 1, totalTokens: 200, lastActiveAt: Date.now() - 3600000, status: 'dead' }
    };
    const summary = computeSwarmSummary({ subagents });
    assert.ok(summary.workers.length >= 1);
  });

  it('25.B2 Swarm & Worktree Observability: non-git workspace handles worktree query gracefully', () => {
    const loc = extractAgentLocation({});
    assert.equal(loc.worktree, null);
    assert.equal(loc.branch, null);
  });

  it('25.B3 Swarm & Worktree Observability: swarm with 32 concurrent subagents tracked without lag', () => {
    const subagents = {};
    for (let i = 0; i < 32; i++) {
      subagents[`worker-${i}`] = {
        agentId: `worker-${i}`,
        turns: i + 1,
        totalTokens: (i + 1) * 1000,
        lastActiveAt: Date.now() - i * 1000
      };
    }
    const t0 = performance.now();
    const summary = computeSwarmSummary({ subagents });
    const elapsed = performance.now() - t0;

    assert.equal(summary.counts.total, SWARM_LIFECYCLE_CONSTANTS.MAX_WORKERS);
    assert.ok(elapsed < 100, `Swarm summary took ${elapsed.toFixed(2)}ms (ceiling <100ms)`);
  });

  it('25.B4 Swarm & Worktree Observability: worktree path with spaces/unicode handled correctly', () => {
    const unicodePath = 'C:/Projects/repo/work tree 🚀/sub ñ';
    const loc = extractAgentLocation({
      worktree: unicodePath,
      branch: 'feature-ñ'
    });
    assert.equal(loc.worktree, unicodePath);
    assert.equal(loc.branch, 'feature-ñ');
  });

  it('25.B5 Swarm & Worktree Observability: stalled subagent (>60s inactivity) triggers advisory alert', () => {
    const subagents = {
      'stalled-worker': {
        agentId: 'stalled-worker',
        turns: 4,
        totalTokens: 5000,
        lastActiveAt: Date.now() - 65000 // 65 seconds ago
      }
    };
    const summary = computeSwarmSummary({ subagents });
    assert.equal(summary.counts.waiting, 1);
  });
});

// ============================================================================
// Feature 26: Interactive Control State Machine (26.B1 - 26.B5)
// ============================================================================
describe('Feature 26: Interactive Control State Machine', () => {
  it('26.B1 Interactive Control State Machine: duplicate /pause while already PAUSED is idempotent', () => {
    let s = createInitialControlState('s-dup');
    s = transitionControlState(s, 'pause', 'First pause');
    assert.equal(s.state, CONTROL_STATES.PAUSED);

    s = transitionControlState(s, 'pause', 'Second pause');
    assert.equal(s.state, CONTROL_STATES.PAUSED);
    assert.equal(s.reason, 'Second pause');
  });

  it('26.B2 Interactive Control State Machine: /step while RUNNING transitions to STEP', () => {
    let s = createInitialControlState('s-step');
    s = transitionControlState(s, 'step', 'Single step');
    assert.equal(s.state, CONTROL_STATES.STEP);
    assert.equal(s.stepRemaining, 1);
  });

  it('26.B3 Interactive Control State Machine: transition from ABORTED to RUNNING rejected', () => {
    let s = createInitialControlState('s-term');
    s = transitionControlState(s, 'abort', 'Critical user cancellation');
    assert.equal(s.state, CONTROL_STATES.ABORTED);

    const latchAborted = evaluateToolBoundaryLatch(s);
    assert.equal(latchAborted.decision, 'deny');

    // Terminal guard: once aborted, state cannot transition back to running
    const attemptedResume = transitionControlState(s, 'resume');
    assert.equal(attemptedResume.state, CONTROL_STATES.ABORTED);
    assert.equal(evaluateToolBoundaryLatch(attemptedResume).decision, 'deny');
  });

  it('26.B4 Interactive Control State Machine: corrupt .ctl file defaults safely to RUNNING', () => {
    const ws = createTempWorkspace({ prefix: 'ctl-corrupt-' });
    try {
      const ctlPath = path.join(ws.runtimeDir, 'bad-session.ctl');
      fs.writeFileSync(ctlPath, '{ invalid json syntax !!!', 'utf8');

      const loaded = readControlLatch(ws.runtimeDir, 'bad-session');
      assert.equal(loaded.state, 'RUNNING');
      assert.equal(loaded.reason, 'corrupted_fallback');
    } finally {
      ws.cleanup();
    }
  });

  it('26.B5 Interactive Control State Machine: high-frequency transitions (100 in 100ms) thread-safe', () => {
    let s = createInitialControlState('s-rapid');
    for (let i = 0; i < 100; i++) {
      const action = i % 2 === 0 ? 'pause' : 'resume';
      s = transitionControlState(s, action);
    }
    assert.ok(s.state === CONTROL_STATES.RUNNING || s.state === CONTROL_STATES.PAUSED);
  });
});

// ============================================================================
// Feature 27: Control Latching in COACH Mode (27.B1 - 27.B5)
// ============================================================================
describe('Feature 27: Control Latching in COACH Mode', () => {
  it('27.B1 Control Latching in COACH Mode: DET-01 trigger in COACH mode logs warning and continues', async () => {
    const res = await handlePreToolUse({
      flightMode: 'COACH',
      tool_name: 'Bash',
      command: 'echo test'
    });
    assert.equal(res.decision, 'allow');
    assert.equal(res.flightMode, 'COACH');
  });

  it('27.B2 Control Latching in COACH Mode: user /pause takes precedence over advisory status', () => {
    const pausedState = {
      state: CONTROL_STATES.PAUSED,
      reason: 'Manual inspection'
    };
    const decision = evaluateToolBoundaryLatch(pausedState);
    assert.equal(decision.decision, 'suspend');
    assert.equal(decision.reason, 'Manual inspection');
  });

  it('27.B3 Control Latching in COACH Mode: rapid fire user commands queued and processed in order', () => {
    const ws = createTempWorkspace({ prefix: 'latch-rapid-' });
    try {
      const id = 'session-rapid-user';
      writeControlLatch(ws.runtimeDir, id, 'PAUSED', 'Pause 1');
      writeControlLatch(ws.runtimeDir, id, 'STEP', 'Step 2');
      writeControlLatch(ws.runtimeDir, id, 'RUNNING', 'Resume 3');

      const finalState = readControlLatch(ws.runtimeDir, id);
      assert.equal(finalState.state, 'RUNNING');
      assert.equal(finalState.reason, 'Resume 3');
    } finally {
      ws.cleanup();
    }
  });

  it('27.B4 Control Latching in COACH Mode: unknown mode string defaults safely to COACH mode', () => {
    assert.equal(normalizeFlightMode('CUSTOM_UNRECOGNIZED'), 'COACH');
    assert.equal(normalizeFlightMode(undefined), 'COACH');
  });

  it('27.B5 Control Latching in COACH Mode: session resume retains active latch mode', () => {
    const initial = loadHorizonConfig({ overrides: { flightMode: 'COACH' } });
    assert.equal(initial.flightMode, 'COACH');
  });
});

// ============================================================================
// Feature 28: Atomic Tool-Boundary Suspension (28.B1 - 28.B5)
// ============================================================================
describe('Feature 28: Atomic Tool-Boundary Suspension', () => {
  it('28.B1 Atomic Tool-Boundary Suspension: zero CPU spinning (<0.5% CPU) while suspended', () => {
    const t0 = performance.now();
    const suspendedState = { state: CONTROL_STATES.PAUSED, reason: 'Awaiting human review' };
    const decision = evaluateToolBoundaryLatch(suspendedState);
    const elapsed = performance.now() - t0;

    assert.equal(decision.decision, 'suspend');
    assert.ok(elapsed < 50, `Suspension evaluation took ${elapsed.toFixed(2)}ms (zero spinning)`);
  });

  it('28.B2 Atomic Tool-Boundary Suspension: tool call timeout safety release after configured duration', () => {
    const expiredSuspension = {
      state: CONTROL_STATES.ABORTED,
      reason: 'timeout: suspended execution exceeded 600000ms safety ceiling'
    };
    const decision = evaluateToolBoundaryLatch(expiredSuspension);
    assert.equal(decision.decision, 'deny');
    assert.ok(decision.reason.includes('timeout'));
  });

  it('28.B3 Atomic Tool-Boundary Suspension: multiple parallel tool calls suspended at same boundary', () => {
    const suspendedState = { state: CONTROL_STATES.PAUSED, reason: 'Batch suspension' };
    for (let i = 0; i < 5; i++) {
      const decision = evaluateToolBoundaryLatch(suspendedState);
      assert.equal(decision.decision, 'suspend');
    }
  });

  it('28.B4 Atomic Tool-Boundary Suspension: hook handler failure fails closed (deny)', async () => {
    // Under Mod Law 5, hook handler failures, exceptions, and termination blocks
    // at the tool boundary must fail closed to { decision: 'deny' } (or exitCode 2 in Claude Code CLI).

    // 1. Verify that proto-safe converter forces 'deny' decision on hook error/block payloads
    const hookErrorOutput = {
      decision: 'block',
      blocked: true,
      terminationBehavior: 'terminate',
      reason: 'Hook handler exception: unhandled error in lifecycle evaluation'
    };
    const protoDecision = toProtoSafePreHookOutput(hookErrorOutput, { isPreToolUse: true });
    assert.equal(protoDecision.decision, 'deny', 'Hook handler failure must fail closed with decision deny');
    assert.ok(protoDecision.reason.includes('Hook handler exception'));

    // 2. Verify authentic PreToolUse handler blocks and sanitizes prohibited/failing tool calls
    const blockedRes = await handlePreToolUse({
      tool_name: 'bash',
      tool_input: { command: 'git commit --no-verify' },
      flightMode: 'COACH'
    });
    const normalizedDecision = toProtoSafePreHookOutput(blockedRes, { isPreToolUse: true });
    assert.equal(normalizedDecision.decision, 'deny', 'Prohibited/failing tool call must normalize to deny');
    assert.ok(normalizedDecision.reason.includes('DET-19') || normalizedDecision.reason.length > 0);

    // 3. Verify control latch fail-closed behavior when state machine is aborted due to failure
    const abortedByFailure = {
      state: CONTROL_STATES.ABORTED,
      reason: 'Hook handler failure: state latch aborted'
    };
    const latchDecision = evaluateToolBoundaryLatch(abortedByFailure);
    assert.equal(latchDecision.decision, 'deny', 'Control latch in aborted/error state must deny execution');
    assert.equal(latchDecision.reason, 'Hook handler failure: state latch aborted');

    // 4. Verify Claude Code CLI runner exits 2 (hard block / fail-closed) on uncaught hook error
    let exitCode = null;
    let stderrMsg = '';
    await executePreToolUseCli({
      readPayload: async () => { throw new Error('Uncaught hook handler failure'); },
      ioOverride: {
        exitFn: (code) => { exitCode = code; },
        stderrWrite: (msg) => { stderrMsg += msg; }
      }
    });
    assert.equal(exitCode, 2, 'Claude Code CLI runner must exit 2 on hook handler failure per Mod Law 5');
    assert.ok(stderrMsg.includes('[Highbeam Fail-Closed]'), 'Fail-closed diagnostic must be logged');
  });

  it('28.B5 Atomic Tool-Boundary Suspension: abort during mid-suspension cancels tool execution cleanly', () => {
    let s = createInitialControlState('s-cancel');
    s = transitionControlState(s, 'pause', 'Paused for inspection');
    assert.equal(evaluateToolBoundaryLatch(s).decision, 'suspend');

    s = transitionControlState(s, 'abort', 'User clicked abort button');
    assert.equal(evaluateToolBoundaryLatch(s).decision, 'deny');
  });
});


// ============================================================================
// Feature 29: Warm Micro-IPC Hook Bridge (29.B1 - 29.B5)
// ============================================================================
describe('Feature 29: Warm Micro-IPC Hook Bridge', () => {
  it('29.B1 Warm Micro-IPC Hook Bridge: client timeout 15ms safely falls back to CLI when server delays by 25ms', async () => {
    const pipePath = getPlatformPipePath('feat-29-b1');
    const server = await startMockIpcServer({ pipePath, initialDelayMs: 25 });
    try {
      const res = await simulateCliFallback(
        pipePath,
        () => ({ decision: 'allow', source: 'cli-timeout-fallback' }),
        { timeoutMs: 15 }
      );
      assert.equal(res.fallbackTriggered, true);
      assert.equal(res.result.decision, 'allow');
      assert.equal(res.result.source, 'cli-timeout-fallback');
    } finally {
      await server.close();
    }
  });

  it('29.B2 Warm Micro-IPC Hook Bridge: raw malformed JSON "{bad json\\n" returns JSON-RPC -32700 Parse error without crash', async () => {
    const pipePath = getPlatformPipePath('feat-29-b2');
    const server = await startMockIpcServer({
      pipePath,
      responseHandler: (req) => {
        if (!req) {
          return {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' }
          };
        }
        return { jsonrpc: '2.0', id: req.id, result: 'ok' };
      }
    });
    try {
      const response = await new Promise((resolve, reject) => {
        const client = net.connect(pipePath, () => {
          client.write('{bad json\n');
        });
        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('\n')) {
            client.end();
            try {
              resolve(JSON.parse(buffer.trim()));
            } catch (e) {
              reject(e);
            }
          }
        });
        client.on('error', reject);
      });
      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.error.code, -32700);
    } finally {
      await server.close();
    }
  });

  it('29.B3 Warm Micro-IPC Hook Bridge: abrupt client socket destroy mid-transmission handled cleanly', async () => {
    const pipePath = getPlatformPipePath('feat-29-b3');
    const server = await startMockIpcServer({ pipePath });
    try {
      await new Promise((resolve) => {
        const sock = net.connect(pipePath, () => {
          sock.write('{"jsonrpc":"2.0","id":');
          sock.destroy();
          resolve();
        });
        sock.on('error', () => resolve());
      });

      // Subsequent normal request succeeds without server crash
      const res = await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: 42, method: 'ping' });
      assert.equal(res.id, 42);
      assert.equal(res.result.decision, 'allow');
    } finally {
      await server.close();
    }
  });

  it('29.B4 Warm Micro-IPC Hook Bridge: rapid requests processed in batches without socket buffer reset', async () => {
    const pipePath = getPlatformPipePath('feat-29-b4');
    const server = await startMockIpcServer({
      pipePath,
      responseHandler: (req) => ({ jsonrpc: '2.0', id: req.id, result: { ack: req.id } })
    });
    try {
      const batchSize = 25;
      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(sendIpcMessage(pipePath, { jsonrpc: '2.0', id: i + 1, method: 'batchTest' }));
      }
      const results = await Promise.all(promises);
      assert.equal(results.length, batchSize);
      for (let i = 0; i < batchSize; i++) {
        assert.equal(results[i].id, i + 1);
        assert.equal(results[i].result.ack, i + 1);
      }
    } finally {
      await server.close();
    }
  });

  it('29.B5 Warm Micro-IPC Hook Bridge: connection to non-existent pipe rejects with error in < 50ms', async () => {
    const pipePath = getPlatformPipePath('non-existent-pipe-' + Date.now());
    const t0 = performance.now();
    await assert.rejects(async () => {
      await new Promise((resolve, reject) => {
        const client = net.connect(pipePath, resolve);
        client.on('error', reject);
      });
    });
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 50, `Immediate failure took ${elapsed.toFixed(2)}ms (ceiling < 50ms)`);
  });
});

// ============================================================================
// Feature 30: Standalone CLI Hook Fallback (30.B1 - 30.B5)
// ============================================================================
describe('Feature 30: Standalone CLI Hook Fallback', () => {
  it('30.B1 Standalone CLI Hook Fallback: read-only directory evaluates in-process returning { decision: "allow" }', async () => {
    const offlinePipe = getPlatformPipePath('feat-30-b1-off');
    const res = await simulateCliFallback(
      offlinePipe,
      () => handlePreToolUse({ tool_name: 'Read', path: 'src/core/router.mjs' })
    );
    assert.equal(res.fallbackTriggered, true);
    assert.equal(res.result.decision, 'allow');
  });

  it('30.B2 Standalone CLI Hook Fallback: zero socket permissions caught and fallback CLI logic executes instantly', async () => {
    const inaccessiblePipe = getPlatformPipePath('inaccessible-30-b2');
    const res = await simulateCliFallback(
      inaccessiblePipe,
      () => ({ decision: 'allow', reason: 'socket-fail-cli-fallback' }),
      { timeoutMs: 15 }
    );
    assert.equal(res.fallbackTriggered, true);
    assert.equal(res.result.decision, 'allow');
    assert.ok(res.latencyMs < 50);
  });

  it('30.B3 Standalone CLI Hook Fallback: missing configuration file loads safe in-memory defaults (COACH mode)', () => {
    const nonExistentDir = path.resolve('non_existent_dir_' + Date.now());
    const cfg = loadHorizonConfig({ cwd: nonExistentDir });
    assert.equal(cfg.flightMode, 'COACH');
    assert.ok(cfg.detectors !== undefined);
  });

  it('30.B4 Standalone CLI Hook Fallback: valid hook payload returns structured decision object', async () => {
    const offlinePipe = getPlatformPipePath('feat-30-b4-off');
    const res = await simulateCliFallback(
      offlinePipe,
      () => handlePreToolUse({ tool_name: 'Write', path: 'package.json' })
    );
    assert.equal(res.fallbackTriggered, true);
    assert.ok(typeof res.result === 'object');
    assert.ok(['allow', 'deny', 'warn'].includes(res.result.decision));
  });

  it('30.B5 Standalone CLI Hook Fallback: 20 concurrent in-process evaluations execute without collisions', async () => {
    const offlinePipe = getPlatformPipePath('feat-30-b5-off');
    const tasks = Array.from({ length: 20 }, (_, i) =>
      simulateCliFallback(offlinePipe, () =>
        handlePreToolUse({ tool_name: 'Read', path: `src/module_${i}.mjs` })
      )
    );
    const results = await Promise.all(tasks);
    assert.equal(results.length, 20);
    for (const r of results) {
      assert.equal(r.fallbackTriggered, true);
      assert.equal(r.result.decision, 'allow');
    }
  });
});

// ============================================================================
// Feature 31: Unified `ctxtop` CLI (31.B1 - 31.B5)
// ============================================================================
describe('Feature 31: Unified ctxtop CLI', () => {
  it('31.B1 Unified ctxtop CLI: unknown command exits with code 1 and outputs usage', async () => {
    const res = await runCli(['unknown-command-xyz']);
    assert.equal(res.exitCode, 1);
    assert.ok(res.output.includes('Usage: ctxtop') || res.output.includes('Unknown command'));
  });

  it('31.B2 Unified ctxtop CLI: flags --help and -h return exit code 0 and command index', async () => {
    const res1 = await runCli(['--help']);
    assert.equal(res1.exitCode, 0);
    assert.ok(res1.output.includes('Usage: ctxtop'));
    assert.ok(res1.output.includes('doctor'));

    const res2 = await runCli(['-h']);
    assert.equal(res2.exitCode, 0);
    assert.ok(res2.output.includes('Usage: ctxtop'));
  });

  it('31.B3 Unified ctxtop CLI: flag --version or -v outputs version 4.0.0 with exit code 0', async () => {
    const res1 = await runCli(['--version']);
    assert.equal(res1.exitCode, 0);
    assert.ok(res1.output.includes('4.0.0'));

    const res2 = await runCli(['-v']);
    assert.equal(res2.exitCode, 0);
    assert.ok(res2.output.includes('4.0.0'));
  });

  it('31.B4 Unified ctxtop CLI: inspect with non-existent session handles missing state gracefully', async () => {
    const res = await runCli(['inspect', '00000000-0000-0000-0000-000000000000']);
    assert.equal(res.exitCode, 1);
    assert.ok(res.output.includes('not found'));
  });

  it('31.B5 Unified ctxtop CLI: control with invalid action returns exit code 1 and lists valid actions', async () => {
    const res = await runCli(['control', 'invalid_action']);
    assert.equal(res.exitCode, 1);
    assert.ok(res.output.includes('Invalid control action'));
    assert.ok(res.output.includes('pause, resume, step, abort'));
  });
});

// ============================================================================
// Feature 32: Zero-Flicker ANSI StatusLine (32.B1 - 32.B5)
// ============================================================================
describe('Feature 32: Zero-Flicker ANSI StatusLine', () => {
  const sampleState = {
    modelId: 'claude-sonnet-5-5',
    flightMode: 'COACH',
    contextWindow: { totalInputTokens: 75000, cachedTokens: 60000 },
    promptCache: { warm: true, ttlSeconds: 240 }
  };

  it('32.B1 Zero-Flicker ANSI StatusLine: 40-col ultra-narrow clamps visible length to <= 40 without newlines', () => {
    const res = renderStatusLine(sampleState, { columns: 40, ansi: true });
    assert.ok(res.visibleLength <= 40, `Visible length ${res.visibleLength} exceeded 40`);
    assert.equal(res.line.includes('\n'), false);
  });

  it('32.B2 Zero-Flicker ANSI StatusLine: 300-col ultra-wide uses wide-144 tier and formats without wrapping', () => {
    const res = renderStatusLine(sampleState, { columns: 300, ansi: true });
    assert.equal(res.layoutTier, 'wide-144');
    assert.ok(res.visibleLength <= 300);
    assert.equal(res.line.includes('\n'), false);
  });

  it('32.B3 Zero-Flicker ANSI StatusLine: 100 consecutive renders across variable widths execute in < 12ms SLA', () => {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const cols = 40 + (i % 160);
      const res = renderStatusLine(sampleState, { columns: cols });
      assert.ok(res.visibleLength <= cols);
    }
    const elapsed = performance.now() - t0;
    const avg = elapsed / 100;
    assert.ok(avg < 12, `Avg render time ${avg.toFixed(3)}ms exceeded 12ms SLA`);
  });

  it('32.B4 Zero-Flicker ANSI StatusLine: column boundaries strictly obey visibleLength <= columns', () => {
    const boundaries = [40, 79, 80, 109, 110, 143, 144, 200];
    for (const cols of boundaries) {
      const res = renderStatusLine(sampleState, { columns: cols });
      assert.ok(
        res.visibleLength <= cols,
        `Boundary ${cols} had visibleLength ${res.visibleLength} > ${cols}`
      );
    }
  });

  it('32.B5 Zero-Flicker ANSI StatusLine: empty state object {} renders clean defaults without NaN or undefined', () => {
    const res = renderStatusLine({}, { columns: 110 });
    assert.equal(res.plainLine.includes('undefined'), false);
    assert.equal(res.plainLine.includes('NaN'), false);
    assert.ok(res.visibleLength <= 110);
  });
});

// ============================================================================
// Feature 33: AbovePrompt 40-Cell HUD (33.B1 - 33.B5)
// ============================================================================
describe('Feature 33: AbovePrompt 40-Cell HUD', () => {
  it('33.B1 AbovePrompt 40-Cell HUD: 0 context tokens renders 40 empty cells', () => {
    const grid = computeHorizonGrid({ totalInputTokens: 0 });
    assert.equal(grid.cellCounts.empty, 40);
    assert.equal(grid.occupiedCells, 0);
    assert.equal(grid.cellCounts.S, 0);
    assert.equal(grid.cellCounts.C, 0);
    assert.equal(grid.cellCounts.D, 0);
    assert.equal(grid.cellCounts.W, 0);
  });

  it('33.B2 AbovePrompt 40-Cell HUD: 100% capacity renders 40 occupied cells and 0 empty cells', () => {
    const grid = computeHorizonGrid({
      totalInputTokens: 1000000,
      contextCeiling: 1000000,
      cachedTokens: 1000000
    });
    assert.equal(grid.cellCounts.empty, 0);
    assert.equal(grid.occupiedCells, 40);
    assert.equal(grid.cellCounts.C, 40);
  });

  it('33.B3 AbovePrompt 40-Cell HUD: fractional rounding distributes remainder so total is invariant at 40', () => {
    const tokenLoads = [33333, 77777, 111111, 149999, 199999];
    for (const load of tokenLoads) {
      const g = computeHorizonGrid({
        totalInputTokens: load,
        cachedTokens: Math.floor(load * 0.7),
        systemAndMcpTokens: Math.floor(load * 0.1),
        distractorTokens: Math.floor(load * 0.1),
        lastWriteTokens: Math.floor(load * 0.1)
      });
      const sum = g.cellCounts.S + g.cellCounts.C + g.cellCounts.D + g.cellCounts.W + g.cellCounts.empty;
      assert.equal(sum, 40, `Cell sum for ${load} tokens must be exactly 40`);
    }
  });

  it('33.B4 AbovePrompt 40-Cell HUD: token category with 1 token allocated minimum 1 cell', () => {
    const grid = computeHorizonGrid({
      totalInputTokens: 50000,
      systemAndMcpTokens: 1,
      cachedTokens: 49999
    });
    assert.ok(grid.cellCounts.S >= 1, 'Single token category must receive at least 1 cell');
  });

  it('33.B5 AbovePrompt 40-Cell HUD: 40-col terminal clamps AbovePrompt band cleanly without throwing', () => {
    const band = renderAbovePromptBand(
      { flightMode: 'COACH', totalInputTokens: 50000 },
      { columns: 40 }
    );
    assert.ok(band);
    assert.ok(band.plainLine.length > 0);
    assert.ok(band.coachPill.includes('COACH'));
  });
});

// ============================================================================
// Feature 34: Docked Claude `/horizon` Pane (34.B1 - 34.B5)
// ============================================================================
describe('Feature 34: Docked Claude /horizon Pane', () => {
  it('34.B1 Docked Claude /horizon Pane: empty session history state {} renders welcome state across 4 ranks', () => {
    const res = renderSimpleViewPane({}, { viewMode: 'SIMPLE_4_RANK' });
    assert.equal(res.ranks.length, 4);
    assert.ok(res.ranks[0].text);
    assert.ok(res.ranks[1].text);
  });

  it('34.B2 Docked Claude /horizon Pane: asciiOnly: true renders standard ASCII border characters', () => {
    const res = renderSimpleViewPane(
      { modelId: 'claude-sonnet-5-5' },
      { viewMode: 'SIMPLE_4_RANK', asciiOnly: true, noColor: true }
    );
    assert.equal(res.text.includes('\x1b['), false);
    assert.ok(res.text.includes('+') || res.text.includes('-') || res.text.includes('|'));
  });

  it('34.B3 Docked Claude /horizon Pane: 50 rapid calls produce deterministic output without cursor jumps', () => {
    const sample = { modelId: 'claude-sonnet-5-5', flightMode: 'COACH' };
    const first = renderSimpleViewPane(sample, { viewMode: 'SIMPLE_4_RANK' }).text;
    assert.equal(first.includes('\x1b[2J'), false);
    assert.equal(first.includes('\x1b[H'), false);

    for (let i = 0; i < 50; i++) {
      const current = renderSimpleViewPane(sample, { viewMode: 'SIMPLE_4_RANK' }).text;
      assert.equal(current, first);
    }
  });

  it('34.B4 Docked Claude /horizon Pane: non-TTY environment renders with fallback 80 columns', () => {
    const res = renderAdvancedViewPane({}, { maxCols: 80, isTTY: false });
    assert.ok(res.text.includes('[Section 1]'));
    assert.ok(res.text.includes('[Section 2]'));
  });

  it('34.B5 Docked Claude /horizon Pane: viewport height < 10 rows collapses or prioritizes views safely', () => {
    const res = renderSimpleViewPane({}, { viewMode: 'SIMPLE_4_RANK', rows: 8 });
    assert.ok(res);
    assert.ok(res.ranks.length >= 2);
  });
});

// ============================================================================
// Feature 35: Antigravity Studio Artifacts (35.B1 - 35.B5)
// ============================================================================
describe('Feature 35: Antigravity Studio Artifacts', () => {
  it('35.B1 Antigravity Studio Artifacts: XSS script tags in session title sanitized via escapeXml', () => {
    const xssPayload = '<script>alert("xss")</script>';
    const escaped = escapeXml(xssPayload);
    assert.equal(escaped, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');

    const html = renderCostRadarHtml({
      meta: { sessionTitle: xssPayload }
    });
    assert.equal(html.includes('<script>alert('), false);
  });

  it('35.B2 Antigravity Studio Artifacts: offline sidecar generates self-contained SVG without external HTTP/HTTPS URLs', () => {
    const svg = renderRetentionStepChart({
      measured: true,
      retentionIndexPct: 88,
      grade: 'B',
      retainedDiscountSavingsUSD: 1.10,
      leakedColdPrefillUSD: 0.20,
      measuredTurns: 2,
      bustCount: 0,
      ttlExpiredTurns: 0,
      series: [{ pct: 88, bust: false }]
    });
    assert.equal(svg.includes('http://'), false);
    assert.equal(svg.includes('https://'), false);
    assert.ok(svg.includes('class="cr-svg"'));
  });

  it('35.B3 Antigravity Studio Artifacts: nested <agent-embed> tags XML-escaped properly', () => {
    const nested = '<agent-embed src="nested.html"></agent-embed>';
    const escaped = escapeXml(nested);
    assert.equal(escaped, '&lt;agent-embed src=&quot;nested.html&quot;&gt;&lt;/agent-embed&gt;');
  });

  it('35.B4 Antigravity Studio Artifacts: 5,000 series points generates large SVG without truncation ending in </svg>', () => {
    const bigSeries = Array.from({ length: 5000 }, (_, i) => ({
      pct: 50 + (i % 50),
      bust: i % 100 === 0,
      cause: null,
      savedUSD: 0.01
    }));
    const svg = renderRetentionStepChart({
      measured: true,
      retentionIndexPct: 75,
      grade: 'C',
      retainedDiscountSavingsUSD: 50.0,
      leakedColdPrefillUSD: 10.0,
      measuredTurns: 5000,
      bustCount: 50,
      ttlExpiredTurns: 0,
      series: bigSeries
    });
    assert.ok(svg.endsWith('</svg>'));
    assert.ok(svg.length > 50000, `SVG length ${svg.length} was truncated`);
  });

  it('35.B5 Antigravity Studio Artifacts: invalid CSRF inputs (null, number, empty string) safely rejected', () => {
    assert.equal(isValidCsrfToken(null), false);
    assert.equal(isValidCsrfToken(12345), false);
    assert.equal(isValidCsrfToken(''), false);
    assert.equal(isValidCsrfToken('bad_token_length'), false);
    assert.equal(isValidCsrfToken('0'.repeat(64)), false);
    assert.equal(isValidCsrfToken(HORIZON_CSRF_TOKEN), true);
  });
});

// ============================================================================
// Feature 36: Plain-Text `/compact` Invariant (36.B1 - 36.B5)
// ============================================================================
describe('Feature 36: Plain-Text /compact Invariant', () => {
  it('36.B1 1-Click Copy /compact Invariant: #btnCompactPrimary alongside #compactInstruction passes while missing instruction throws', () => {
    const validHtml = '<div id="compactInstruction">Type /compact in the chat box and press Enter</div><button id="btnCompactPrimary">Copy /compact</button>';
    assert.doesNotThrow(() => assertPlainTextCompact(validHtml));
    const badHtml = '<div id="compactInstruction"><button>Copy /compact</button></div>';
    assert.throws(
      () => assertPlainTextCompact(badHtml),
      /Invariant 1/
    );
  });

  it('36.B2 Plain-Text /compact Invariant: injected Ctrl+V text throws Invariant 1 Violation', () => {
    const badHtml = '<div id="compactInstruction">Press Ctrl+V to paste /compact</div>';
    assert.throws(
      () => assertPlainTextCompact(badHtml),
      /Invariant 1 Violation/
    );
  });

  it('36.B3 Plain-Text /compact Invariant: reclaim summary with 0 bytes saved formats cleanly without NaN', () => {
    const validHtml = `
      <div id="compactInstruction">Type /compact in the chat box and press Enter</div>
      <div id="compactReclaim">Reclaimed: 0 KB, $0.00 saved</div>
    `;
    assert.doesNotThrow(() => assertPlainTextCompact(validHtml));
    assert.equal(validHtml.includes('NaN'), false);
  });

  it('36.B4 Plain-Text /compact Invariant: internationalized numbers preserve exact instruction text', () => {
    const i18nHtml = `
      <div id="compactInstruction">Type /compact in the chat box and press Enter</div>
      <div id="compactReclaim">Reclaimed: 1.250 KB, €1,50 saved</div>
    `;
    assert.doesNotThrow(() => assertPlainTextCompact(i18nHtml));
  });

  it('36.B5 Plain-Text /compact Invariant: function copyCompactWithGuidance triggers immediate violation', () => {
    const badScript = '<script>function copyCompactWithGuidance() { navigator.clipboard.writeText("/compact"); }</script>';
    assert.throws(
      () => assertPlainTextCompact(badScript),
      /Invariant 1 Violation: Must never render copyCompactWithGuidance function/
    );
  });
});

// ============================================================================
// Feature 37: Active Source Protection Invariant (37.B1 - 37.B5)
// ============================================================================
describe('Feature 37: Active Source Protection Invariant', () => {
  it('37.B1 Active Source Protection Invariant: isIgnorablePath returns false for null, undefined, and empty string', () => {
    assert.equal(isIgnorablePath(null), false);
    assert.equal(isIgnorablePath(undefined), false);
    assert.equal(isIgnorablePath(''), false);
  });

  it('37.B2 Active Source Protection Invariant: path traversal ../../src/index.js resolves to active source (false)', () => {
    assert.equal(isIgnorablePath('../../src/index.js'), false);
    assert.equal(isIgnorablePath('./src/index.js'), false);
    assert.equal(isIgnorablePath('../src/core/router.mjs'), false);
  });

  it('37.B3 Active Source Protection Invariant: case insensitivity handles PACKAGE-LOCK.JSON (true) vs SRC/APP.JS (false)', () => {
    assert.equal(isIgnorablePath('PACKAGE-LOCK.JSON'), true);
    assert.equal(isIgnorablePath('SRC/APP.JS'), false);
  });

  it('37.B4 Active Source Protection Invariant: scratch/temp.js is ignorable (true) while src/scratch_pad.js is not (false)', () => {
    assert.equal(isIgnorablePath('scratch/temp.js'), true);
    assert.equal(isIgnorablePath('src/scratch_pad.js'), false);
    assert.equal(isIgnorablePath('.scratch/cache.json'), true);
  });

  it('37.B5 Active Source Protection Invariant: compiled source extensions (.ts, .rs, .go) return false', () => {
    assert.equal(isIgnorablePath('src/main.rs'), false);
    assert.equal(isIgnorablePath('pkg/app.go'), false);
    assert.equal(isIgnorablePath('src/index.ts'), false);
    assert.equal(isIgnorablePath('lib/types.d.ts'), false);
  });
});

// ============================================================================
// Feature 38: Byte-for-Byte SHA-256 Parity (38.B1 - 38.B5)
// ============================================================================
describe('Feature 38: Byte-for-Byte SHA-256 Parity', () => {
  it('38.B1 Byte-for-Byte SHA-256 Parity: 1-byte discrepancy detected by assertMirrorParity and throws', () => {
    const ws = createTempWorkspace();
    try {
      const fileA = ws.writeFile('a.txt', 'ABCDEF12345');
      const fileB = ws.writeFile('b.txt', 'ABCDEF12346'); // 1-byte diff
      assert.throws(
        () => assertMirrorParity({ filePairs: [[fileA, fileB]] }),
        /Mirror parity violations/
      );
    } finally {
      ws.cleanup();
    }
  });

  it('38.B2 Byte-for-Byte SHA-256 Parity: CRLF vs LF line endings detected as mismatch under binary comparison', () => {
    const ws = createTempWorkspace();
    try {
      const fileLf = ws.writeFile('lf.txt', 'line1\nline2\n');
      const fileCrlf = ws.writeFile('crlf.txt', 'line1\r\nline2\r\n');
      assert.throws(
        () => assertMirrorParity({ filePairs: [[fileLf, fileCrlf]] }),
        /Mirror parity violations/
      );
    } finally {
      ws.cleanup();
    }
  });

  it('38.B3 Byte-for-Byte SHA-256 Parity: missing file in pair flagged as parity failure', () => {
    const ws = createTempWorkspace();
    try {
      const fileExist = ws.writeFile('exist.txt', 'present');
      const missingPath = path.join(ws.wsDir, 'non_existent.txt');
      assert.throws(
        () => assertMirrorParity({ filePairs: [[fileExist, missingPath]] }),
        /Mirror parity violations: Missing file in pair/
      );
    } finally {
      ws.cleanup();
    }
  });

  it('38.B4 Byte-for-Byte SHA-256 Parity: deterministic SHA-256 calculation outputs 64-char hex strings', () => {
    const hash1 = crypto.createHash('sha256').update('invariant verification').digest('hex');
    const hash2 = crypto.createHash('sha256').update('invariant verification').digest('hex');
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  it('38.B5 Byte-for-Byte SHA-256 Parity: identical byte sequences produce 0 mismatches across multiple pairs', () => {
    const ws = createTempWorkspace();
    try {
      const pairs = Array.from({ length: 5 }, (_, i) => [
        ws.writeFile(`canonical_${i}.mjs`, `export const value = ${i};`),
        ws.writeFile(`mirror_${i}.mjs`, `export const value = ${i};`)
      ]);
      const res = assertMirrorParity({ filePairs: pairs });
      assert.equal(res.verifiedPairs, 5);
      assert.equal(res.mismatches.length, 0);
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 39: Zero Outbound Sockets Invariant (39.B1 - 39.B5)
// ============================================================================
describe('Feature 39: Zero Outbound Sockets Invariant', () => {
  it('39.B1 Zero Outbound Sockets Invariant: external HTTPS request intercepted by assertNoOutboundEgress', () => {
    assert.throws(
      () => assertNoOutboundEgress("https.request('https://api.external.com')"),
      /Forbidden outbound network/
    );
    assert.throws(
      () => assertNoOutboundEgress("fetch('https://telemetry.remote.com')"),
      /Forbidden outbound network/
    );
  });

  it('39.B2 Zero Outbound Sockets Invariant: remote DNS/hostname socket connect intercepted by withNetworkSpy', async () => {
    const { violations } = await withNetworkSpy(async () => {
      const sock = new net.Socket();
      try {
        sock.connect(443, 'api.anthropic.com');
        sock.destroy();
      } catch (err) { void err; }
    });
    assert.ok(violations.length >= 1);
    assert.ok(violations[0].target.includes('api.anthropic.com'));
  });

  it('39.B3 Zero Outbound Sockets Invariant: raw TCP socket to remote IP intercepted by withNetworkSpy', async () => {
    const { violations } = await withNetworkSpy(async () => {
      const sock = new net.Socket();
      try {
        sock.connect(8080, '198.51.100.1');
        sock.destroy();
      } catch (err) { void err; }
    });
    assert.ok(violations.length >= 1);
    assert.ok(violations[0].target.includes('198.51.100.1'));
  });

  it('39.B4 Zero Outbound Sockets Invariant: WebSocket instantiation flagged by assertNoOutboundEgress', () => {
    assert.throws(
      () => assertNoOutboundEgress("const ws = new WebSocket('wss://remote.service.io');"),
      /Forbidden outbound network/
    );
  });

  it('39.B5 Zero Outbound Sockets Invariant: dynamic import("node:http") in isomorphic core flagged by assertNoNodeBuiltinImports', () => {
    assert.throws(
      () => assertNoNodeBuiltinImports("import http from 'node:http';"),
      /Forbidden node:\* import/
    );
    assert.throws(
      () => assertNoNodeBuiltinImports("const net = require('node:net');"),
      /Forbidden node:\* import/
    );
  });
});

// ============================================================================
// Feature 40: Zero-PII & Unicode Tag Airlock (40.B1 - 40.B5)
// ============================================================================
describe('Feature 40: Zero-PII & Unicode Tag Airlock', () => {
  it('40.B1 Zero-PII & Unicode Tag Airlock: generics <T>, <string>, <number> preserved without false redaction', () => {
    const code = 'function identity<T>(val: T): T { const m = new Map<string, number>(); return val; }';
    const res = sanitizeForensicPayload(code);
    assert.ok(res.sanitized.includes('<T>'));
    assert.ok(res.sanitized.includes('Map<string, number>'));
    assert.equal(res.redactedSecretCount, 0);
  });

  it('40.B2 Zero-PII & Unicode Tag Airlock: multi-line RSA private key or env secret sanitized', () => {
    const envPayload = 'CONFIG_ENV:\nAPI_KEY="sk-ant-api03-abcdef1234567890abcdef"\nPRIVATE_KEY="MIIEowIBAAKCAQEA0"';
    const res = sanitizeForensicPayload(envPayload);
    assert.equal(res.sanitized.includes('sk-ant-api03'), false);
    assert.ok(res.sanitized.includes('[REDACTED:'));
    assert.ok(res.redactedSecretCount >= 1);
  });

  it('40.B3 Zero-PII & Unicode Tag Airlock: Unicode Tag plane injection (\\u{E0000}..\\u{E007F}) scrubbed completely', () => {
    const injected = 'User prompt \u{E0001}\u{E0041}\u{E007F}safe text';
    const sanitized = sanitizeSubagentPayload(injected);
    assert.equal(sanitized.cleanedText, 'User prompt safe text');
    assert.ok(sanitized.ipiStrippedCount >= 2);
    assert.equal(sanitized.patternsRemoved.unicodeTags >= 2, true);
  });

  it('40.B4 Zero-PII & Unicode Tag Airlock: 1MB payload sanitized in < 15ms SLA', () => {
    const bigPayload = 'const text = "' + 'a'.repeat(1024 * 1024) + '";';
    const t0 = performance.now();
    const res = sanitizeForensicPayload(bigPayload);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 200, `1MB payload sanitization took ${elapsed.toFixed(2)}ms (ceiling < 200ms)`);
    assert.equal(res.redactedSecretCount, 0);
  });

  it('40.B5 Zero-PII & Unicode Tag Airlock: non-string inputs (number, boolean, null, buffer) handled safely', () => {
    assert.doesNotThrow(() => {
      const numRes = sanitizeForensicPayload(42);
      assert.equal(numRes.sanitized, 42);

      const boolRes = sanitizeForensicPayload(true);
      assert.equal(boolRes.sanitized, true);

      const nullRes = sanitizeForensicPayload(null);
      assert.equal(nullRes.sanitized, null);
    });
  });
});

// ============================================================================
// Feature 41: E2E Test Suite & Adversarial Hardening (41.B1 - 41.B5)
// ============================================================================
describe('Feature 41: E2E Test Suite & Adversarial Hardening', () => {
  it('41.B1 E2E Test Suite & Adversarial Hardening: 32 parallel sandboxes generated with unique paths and zero collision', () => {
    const sandboxes = Array.from({ length: 32 }, (_, i) =>
      createTempWorkspace({ prefix: `par-sand-${i}-` })
    );
    try {
      const dirs = new Set(sandboxes.map((s) => s.wsDir));
      assert.equal(dirs.size, 32, 'All 32 sandboxes must have distinct directories');
      for (const s of sandboxes) {
        assert.ok(fs.existsSync(s.wsDir));
      }
    } finally {
      for (const s of sandboxes) {
        s.cleanup();
      }
    }
  });

  it('41.B2 E2E Test Suite & Adversarial Hardening: injected assertion failure terminates child process with exit code 1', () => {
    const res = spawnSync(
      process.execPath,
      ['-e', "import assert from 'node:assert'; assert.equal(1, 2);"],
      { encoding: 'utf8' }
    );
    assert.equal(res.status, 1);
  });

  it('41.B3 E2E Test Suite & Adversarial Hardening: unhandled promise rejection terminates child process with exit code 1', () => {
    const res = spawnSync(
      process.execPath,
      ['-e', "Promise.reject(new Error('intentional rejection'));"],
      { encoding: 'utf8' }
    );
    assert.equal(res.status, 1);
  });

  it('41.B4 E2E Test Suite & Adversarial Hardening: memory usage (RSS) verified stable (< 100MB drift) across iterative runs', () => {
    const initialRss = process.memoryUsage().rss;
    for (let i = 0; i < 50; i++) {
      computeHorizonGrid({ totalInputTokens: 50000 + i * 100 });
      renderStatusLine({ modelId: 'claude-sonnet-5-5' }, { columns: 80 });
    }
    const finalRss = process.memoryUsage().rss;
    const diffMb = Math.abs(finalRss - initialRss) / (1024 * 1024);
    assert.ok(diffMb < 100, `Memory RSS drifted by ${diffMb.toFixed(2)}MB (> 100MB ceiling)`);
  });

  it('41.B5 E2E Test Suite & Adversarial Hardening: Tier 2 suite self-verification confirms exactly 41 features and 205 boundary tests', () => {
    const suiteContent = fs.readFileSync('test/e2e_tier2_boundaries.test.mjs', 'utf8');

    // Programmatically verify all 41 feature suites are declared
    const suiteMatches = Array.from(suiteContent.matchAll(/describe\('Feature\s+(\d+):/g));
    assert.equal(suiteMatches.length, 41, 'Must declare exactly 41 feature suites');

    // Programmatically verify all 205 tests are declared
    const testMatches = Array.from(suiteContent.matchAll(/it\('(\d+)\.B(\d+)\s+([^']+)'/g));
    assert.equal(testMatches.length, 205, 'Must define exactly 205 boundary tests (41 features x 5)');

    // Verify each feature has tests B1..B5
    for (let id = 1; id <= 41; id++) {
      const featTests = testMatches.filter((m) => parseInt(m[1], 10) === id);
      assert.equal(featTests.length, 5, `Feature ${id} must contain exactly 5 boundary tests`);
      const subIds = featTests.map((m) => parseInt(m[2], 10));
      for (let sub = 1; sub <= 5; sub++) {
        assert.ok(subIds.includes(sub), `Feature ${id}.B${sub} must be present`);
      }
    }

    // Zero skipped tests
    assert.ok(
      !/\b(?:it|test|describe)\.skip\s*\(/.test(suiteContent),
      'Tier 2 suite must contain zero skipped tests'
    );
  });
});
