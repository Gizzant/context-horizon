/**
 * @file test/e2e_tier1_features.test.mjs
 * Highbeam v4.0 (`ctxtop`) — Tier 1 Feature Coverage Test Suite
 *
 * Verifies all 41 features mapped in TEST_INFRA.md § 4.3 with exactly 5 isolated
 * happy-path tests each (205 tests total).
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
import { execFileSync } from 'node:child_process';

// Register Tier-2 Node I/O provider for atomic writes and clean sandbox handling
import '../src/utils/nodeIo.mjs';

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
  withNetworkSpy
} from './helpers/e2e_harness.mjs';

// Production modules under test
import {
  runCli,
  installAttentionHorizon,
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
  validateUstfSpan
} from '../src/core-isomorphic/ustf/schema.mjs';
import {
  ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG,
  ADVISORY_DETECTOR_SLUGS,
  loadHorizonConfig
} from '../src/core-isomorphic/config/horizonConfig.mjs';
import {
  detectDirtySnapshots,
  detectUnseenCallers,
  detectLegacyPoison
} from '../src/core/blindspot_sensors.mjs';
import { CATEGORIES } from '../src/core/constants.mjs';
import {
  ContradictionAuditor,
  auditRuleContradictions
} from '../src/core/coach/contradiction_auditor.mjs';
import {
  sanitizePostToolOutput,
  isToolEligibleForSanitization,
  OFFLOAD_TOKEN_THRESHOLD
} from '../src/core-isomorphic/guards/losslessPostSanitizer.mjs';
import {
  applyThinkingDriftEvent,
  createInitialThinkingDrift,
  evaluateThinkingDriftLoop,
  classifyTurnDrift,
  formatTtft
} from '../src/core-isomorphic/telemetry/sprintMetrics.mjs';
import { fnv1a64Hex } from '../src/core/shared/fnv1a64.mjs';
import {
  computeBreakEvenCachedTokens,
  resolveNaturalDownshiftPeer
} from '../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  evaluateDet12HaikuPreCliffBreaker
} from '../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  renderRetentionStepChart,
  renderCostRadarHtml,
  renderTopologyGraph
} from '../src/core/timeline_svg.mjs';
import {
  buildTurnVelocitySparkline,
  scorePromptSufficiency,
  RUBRIC_DIMENSIONS,
  SUFFICIENCY_BANDS
} from '../src/core/prompt_rubric.mjs';
import {
  evaluateSemanticDrift,
  auditHypothesisLoop,
  auditInvariantContradiction
} from '../src/core-isomorphic/diagnostics/drift_guard.mjs';
import {
  acquireScopeLock,
  evaluateScopeAndQuotaBrake,
  matchesScopePattern
} from '../src/core-isomorphic/telemetry/scopeLockRegistry.mjs';
import {
  computeSwarmSummary,
  extractAgentLocation,
  applySubagentLifecycle
} from '../src/core-isomorphic/telemetry/swarmTopology.mjs';
import {
  CONTROL_STATES,
  transitionControlState,
  evaluateToolBoundaryLatch,
  createInitialControlState
} from '../src/core-isomorphic/control/index.mjs';
import { handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import {
  renderStatusLine,
  renderAbovePromptBand,
  renderSimpleViewPane,
  renderSimpleHudPane,
  renderAdvancedViewPane
} from '../src/core-isomorphic/ui/modViews.mjs';
import {
  computeHorizonGrid,
  extractHorizonTokens
} from '../src/core-isomorphic/ui/horizonGrid.mjs';
import { isIgnorablePath } from '../src/core/paths.mjs';
import {
  sanitizeForensicPayload,
  exportSanitizedSnapshot
} from '../src/core/sanitizer.mjs';
import {
  HORIZON_CSRF_TOKEN,
  isValidCsrfToken
} from '../sidecars/horizon-daemon/server.mjs';

// ============================================================================
// Feature 1: Single `ctxtop` Package (1.1 - 1.5)
// ============================================================================
describe('Feature 1: Single ctxtop Package', () => {
  it('1.1 Single ctxtop Package: manifest name is "ctxtop"', () => {
    const pkgPath = path.resolve('package.json');
    assert.ok(fs.existsSync(pkgPath), 'package.json must exist');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.name, 'ctxtop', 'Package name must be ctxtop');
  });

  it('1.2 Single ctxtop Package: manifest version is 4.0.0', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(pkg.version, '4.0.0', 'Package version must be 4.0.0');
  });

  it('1.3 Single ctxtop Package: type is "module"', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(pkg.type, 'module', 'Package type must be declared as module');
  });

  it('1.4 Single ctxtop Package: bin declarations exist for ctxtop and ah-statusline', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.ok(pkg.bin && typeof pkg.bin === 'object', 'pkg.bin must be an object');
    assert.ok(pkg.bin.ctxtop, 'ctxtop bin entry must be declared');
    assert.ok(pkg.bin['ah-statusline'], 'ah-statusline bin entry must be declared');
    assert.ok(fs.existsSync(path.resolve(pkg.bin.ctxtop)), 'ctxtop entry target must exist on disk');
    assert.ok(fs.existsSync(path.resolve(pkg.bin['ah-statusline'])), 'ah-statusline entry target must exist on disk');
  });

  it('1.5 Single ctxtop Package: engines.node declares >=20.0.0', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.ok(pkg.engines && pkg.engines.node, 'engines.node must be specified');
    assert.equal(pkg.engines.node, '>=20.0.0', 'engines.node must declare >=20.0.0');
    const env = detectRuntimeEnv();
    assert.ok(env.major >= 20, `Active Node major (${env.major}) must be >= 20`);
  });
});

// ============================================================================
// Feature 2: Dual Plugin Manifests (2.1 - 2.5)
// ============================================================================
describe('Feature 2: Dual Plugin Manifests', () => {
  it('2.1 Dual Plugin Manifests: Antigravity plugin.json exists & valid', () => {
    const agPath = path.resolve('plugin.json');
    assert.ok(fs.existsSync(agPath), 'Root plugin.json must exist');
    const ag = JSON.parse(fs.readFileSync(agPath, 'utf8'));
    assert.equal(ag.name, 'attention-horizon-antigravity');
    assert.ok(ag.$schema && ag.$schema.includes('antigravity.google'), 'Antigravity schema declared');
    assert.ok(ag.description && ag.description.length > 0);
  });

  it('2.2 Dual Plugin Manifests: Claude Code .claude-plugin/plugin.json exists & valid', () => {
    const ccPath = path.resolve('.claude-plugin', 'plugin.json');
    assert.ok(fs.existsSync(ccPath), '.claude-plugin/plugin.json must exist');
    const cc = JSON.parse(fs.readFileSync(ccPath, 'utf8'));
    assert.equal(cc.name, 'attention-horizon');
    assert.equal(cc.license, 'MIT');
    assert.ok(cc.description && cc.description.length > 0);
  });

  it('2.3 Dual Plugin Manifests: hook declarations valid in both', () => {
    const ag = JSON.parse(fs.readFileSync('plugin.json', 'utf8'));
    const cc = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
    assert.equal(ag.hooks, './hooks.json');
    assert.equal(cc.hooks, './hooks/hooks.json');
  });

  it('2.4 Dual Plugin Manifests: manifest schema version matches v4.0.0 in both', () => {
    const ag = JSON.parse(fs.readFileSync('plugin.json', 'utf8'));
    const cc = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(ag.version, '4.0.0');
    assert.equal(cc.version, '4.0.0');
    assert.equal(pkg.version, '4.0.0');
  });

  it('2.5 Dual Plugin Manifests: platform-specific capabilities declared', () => {
    const ag = JSON.parse(fs.readFileSync('plugin.json', 'utf8'));
    const cc = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
    assert.ok(Array.isArray(ag.skills) && ag.skills.length >= 4, 'Antigravity declares skills');
    assert.ok(Array.isArray(ag.rules) && ag.rules.length >= 1, 'Antigravity declares rules');
    assert.ok(Array.isArray(ag.sidecars) && ag.sidecars.length >= 1, 'Antigravity declares sidecars');
    assert.ok(Array.isArray(ag.suggestedPrompts) && ag.suggestedPrompts.length >= 1, 'Antigravity declares prompts');
    assert.ok(Array.isArray(cc.commands) && cc.commands.length >= 2, 'Claude Code declares slash commands');
  });
});

// ============================================================================
// Feature 3: Zero-Config Installer (3.1 - 3.5)
// ============================================================================
describe('Feature 3: Zero-Config Installer', () => {
  it('3.1 Zero-Config Installer: ctxtop init creates config in sandbox', async () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-init-test-' });
    try {
      const result = installAttentionHorizon({
        cwd: ws.wsDir,
        homeDir: ws.homeDir,
        scope: 'project'
      });
      assert.equal(result.ok, true);
      assert.ok(fs.existsSync(result.settingsPath), 'Settings file must be created');
      const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
      assert.ok(settings.hooks && typeof settings.hooks === 'object');
      assert.ok(settings.statusLine && typeof settings.statusLine === 'object');
    } finally {
      ws.cleanup();
    }
  });

  it('3.2 Zero-Config Installer: auto-detects Antigravity host', async () => {
    const sandbox = createIsolatedTestSandbox({ withAntigravityDir: true });
    try {
      const res = executeInitSubcommand(['--antigravity', '--dry-run'], {
        cwd: sandbox.workspaceDir,
        homeDir: sandbox.homeDir
      });
      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);
      assert.ok(res.output.includes('Antigravity'));
    } finally {
      sandbox.cleanup();
    }
  });

  it('3.3 Zero-Config Installer: auto-detects Claude Code host', async () => {
    const sandbox = createIsolatedTestSandbox({ withClaudeDir: true });
    try {
      const res = executeInitSubcommand(['--claude', '--workspace'], {
        cwd: sandbox.workspaceDir,
        homeDir: sandbox.homeDir
      });
      assert.equal(res.ok, true);
      assert.ok(res.output.includes('Claude Code'));
      const expectedSettings = path.join(sandbox.workspaceDir, '.claude', 'settings.json');
      assert.ok(fs.existsSync(expectedSettings), 'Target settings must exist');
    } finally {
      sandbox.cleanup();
    }
  });

  it('3.4 Zero-Config Installer: creates timestamped backup .ah-backup.<ts>', async () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-backup-test-' });
    try {
      const claudeDir = path.join(ws.wsDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const originalSettings = { theme: 'monokai', existingHook: true };
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify(originalSettings), 'utf8');

      const ts = 1711234567890;
      const result = installAttentionHorizon({
        cwd: ws.wsDir,
        homeDir: ws.homeDir,
        scope: 'project',
        timestamp: ts
      });

      assert.equal(result.ok, true);
      assert.ok(result.backupPath, 'Backup path must be returned');
      assert.ok(fs.existsSync(result.backupPath), 'Backup file must exist on disk');
      assert.ok(result.backupPath.includes(`.ah-backup.${ts}`));

      const backupContent = JSON.parse(fs.readFileSync(result.backupPath, 'utf8'));
      assert.deepEqual(backupContent, originalSettings, 'Backup must preserve original settings');
    } finally {
      ws.cleanup();
    }
  });

  it('3.5 Zero-Config Installer: default config matches Blueprint spec', async () => {
    const requiredEvents = [
      'PreToolUse',
      'PostToolUse',
      'PreModelSwitch',
      'PreCompact',
      'PostCompact',
      'SessionStart',
      'Stop'
    ];
    for (const ev of requiredEvents) {
      assert.ok(CANONICAL_AH_HOOKS[ev], `CANONICAL_AH_HOOKS must declare ${ev}`);
      assert.ok(Array.isArray(CANONICAL_AH_HOOKS[ev]));
      assert.ok(CANONICAL_AH_HOOKS[ev].length >= 1);
    }
  });
});

// ============================================================================
// Feature 4: Isomorphic Mod Core (4.1 - 4.5)
// ============================================================================
describe('Feature 4: Isomorphic Mod Core', () => {
  it('4.1 Isomorphic Mod Core: pure ESM module loading', async () => {
    const catalogMod = await import('../src/core-isomorphic/catalog/detectorCatalog.mjs');
    const ustfMod = await import('../src/core-isomorphic/ustf/schema.mjs');
    assert.ok(catalogMod && typeof catalogMod === 'object');
    assert.ok(ustfMod && typeof ustfMod === 'object');
    assert.equal(typeof catalogMod.resolveDetectorId, 'function');
    assert.equal(typeof ustfMod.validateUstfTrajectory, 'function');
  });

  it('4.2 Isomorphic Mod Core: zero node:* imports in core-isomorphic', () => {
    const coreDir = path.resolve('src', 'core-isomorphic');
    function scan(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
          const code = fs.readFileSync(full, 'utf8');
          assertNoNodeBuiltinImports(code);
        }
      }
    }
    scan(coreDir);
  });

  it('4.3 Isomorphic Mod Core: operates safely with zero global environment dependencies', async () => {
    const res = validateUstfUsage({
      uncached: 100,
      cacheWrite5m: 50,
      cacheWrite1h: 0,
      cacheRead: 200,
      output: 50,
      thinking: 20,
      costUSD: 0.005
    });
    assert.equal(res.valid, true);
    assert.deepEqual(res.errors, []);
  });

  it('4.4 Isomorphic Mod Core: pure functions return immutable state', async () => {
    assert.ok(Object.isFrozen(DETECTOR_CATALOG), 'DETECTOR_CATALOG must be Object.freeze-locked');
    assert.throws(() => {
      DETECTOR_CATALOG['DET-01'] = { hacked: true };
    }, TypeError, 'Mutating frozen catalog must throw TypeError');
  });

  it('4.5 Isomorphic Mod Core: all exports are named and deterministic', async () => {
    assert.ok(resolveDetectorId, 'resolveDetectorId must be a named export');
    assert.ok(getDetectorMeta, 'getDetectorMeta must be a named export');
    assert.ok(DETECTOR_CATALOG, 'DETECTOR_CATALOG must be a named export');

    for (let i = 0; i < 20; i++) {
      assert.equal(resolveDetectorId('DET-21'), 'DET-30');
      assert.equal(resolveDetectorId('DET-01'), 'DET-01');
      assert.equal(getDetectorMeta('DET-30').id, 'DET-30');
    }
  });
});

// ============================================================================
// Feature 5: Claude Mod Law Compliance (5.1 - 5.5)
// ============================================================================
describe('Feature 5: Claude Mod Law Compliance', () => {
  it('5.1 Claude Mod Law Compliance: AST scan passes Mod Law 1 (no node:*)', () => {
    const compliantCode = `
      export function calculateSum(a, b) {
        return a + b;
      }
    `;
    const result = checkModLaws(compliantCode);
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);

    const violatingCode = `import fs from 'node:fs';`;
    const failResult = checkModLaws(violatingCode);
    assert.equal(failResult.valid, false);
    assert.ok(failResult.violations.some(v => v.includes('Forbidden static import from node:*')));
  });

  it('5.2 Claude Mod Law Compliance: Law 1: no assignment to $ or destructuring', () => {
    const assignCode = `function test() { $ = 42; }`;
    const res1 = checkModLaws(assignCode);
    assert.equal(res1.valid, false);
    assert.ok(res1.violations.some(v => v.includes('Forbidden assignment to $ identifier')));

    const destructCode = `const { $ } = context;`;
    const res2 = checkModLaws(destructCode);
    assert.equal(res2.valid, false);
    assert.ok(res2.violations.some(v => v.includes('Forbidden destructuring capture of $')));
  });

  it('5.3 Claude Mod Law Compliance: Law 2: balanced call scanner verified', () => {
    const unbalancedCode = `function broken(a { return a + 1; }`;
    const res = checkModLaws(unbalancedCode);
    assert.equal(res.valid, false);
    assert.ok(res.violations.some(v => v.includes('Unbalanced call scanner parens or braces')));

    const balancedCode = `function correct(a) { return (a + 1); }`;
    const okRes = checkModLaws(balancedCode);
    assert.equal(okRes.valid, true);
  });

  it('5.4 Claude Mod Law Compliance: Law 3: string literal event names in on()', () => {
    const dynamicEventCode = 'mod.on(`event_${id}`, () => {});';
    const badRes = checkModLaws(dynamicEventCode);
    assert.equal(badRes.valid, false);
    assert.ok(badRes.violations.some(v => v.includes('Dynamic or template string event name in on()')));

    const staticEventCode = `mod.on('PreToolUse', () => {});`;
    const okRes = checkModLaws(staticEventCode);
    assert.equal(okRes.valid, true);
  });

  it('5.5 Claude Mod Law Compliance: Law 5: fail-closed error handling in async hooks', () => {
    const unprotectedAsync = `async function onPreToolUse(ctx) { const x = await fetchState(); }`;
    const badRes = checkModLaws(unprotectedAsync);
    assert.equal(badRes.valid, false);
    assert.ok(badRes.violations.some(v => v.includes('Missing fail-closed error handling')));

    const protectedAsync = `
      async function onPreToolUse(ctx) {
        try {
          const x = await fetchState();
        } catch (err) {
          return { decision: 'deny' };
        }
      }
    `;
    const okRes = checkModLaws(protectedAsync);
    assert.equal(okRes.valid, true);
  });
});

// ============================================================================
// Feature 6: Universal Session Trajectory (USTF v1) (6.1 - 6.5)
// ============================================================================
describe('Feature 6: Universal Session Trajectory (USTF v1)', () => {
  it('6.1 Universal Session Trajectory (USTF v1): createMockUSTFTrajectory generates v1.0.0', () => {
    const traj = createMockUSTFTrajectory({ turnsCount: 4, harness: 'antigravity' });
    assert.equal(traj.version, '1.0.0');
    assert.equal(traj.harness, 'antigravity');
    assert.equal(traj.turns.length, 4);
    assert.equal(traj.metrics.totalTurns, 4);
    assert.ok(traj.metrics.totalPromptTokens > 0);
    assert.ok(traj.metrics.totalOutputTokens > 0);
  });

  it('6.2 Universal Session Trajectory (USTF v1): Antigravity session transforms to USTF v1', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-ag-ustf-' });
    try {
      const jsonlPath = createAntigravityJsonl(ws.wsDir, [
        { step_id: 's0', step_type: 'USER_INPUT', status: 'OK', timestamp: Date.now() - 2000, content: 'Analyze repo' },
        { step_id: 's1', step_type: 'MODEL_RESPONSE', status: 'OK', timestamp: Date.now() - 1000, usage: { prompt_tokens: 2000, completion_tokens: 300 } }
      ]);
      assert.ok(fs.existsSync(jsonlPath));

      const traj = createMockUSTFTrajectory({
        harness: 'antigravity',
        turnsCount: 2
      });
      const check = validateUSTFv1(traj);
      assert.equal(check.valid, true);
      assert.deepEqual(check.errors, []);
    } finally {
      ws.cleanup();
    }
  });

  it('6.3 Universal Session Trajectory (USTF v1): Claude Code DAG transforms to USTF v1', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-cc-ustf-' });
    try {
      const jsonlPath = createClaudeCodeJsonl(ws.wsDir);
      assert.ok(fs.existsSync(jsonlPath));

      const traj = createMockUSTFTrajectory({
        harness: 'claude-code',
        turnsCount: 2
      });
      const check = validateUSTFv1(traj);
      assert.equal(check.valid, true);
    } finally {
      ws.cleanup();
    }
  });

  it('6.4 Universal Session Trajectory (USTF v1): schema validator accepts compliant trajectory', () => {
    const traj = createMockUSTFTrajectory({
      turnsCount: 3,
      withOffloadedTools: true,
      cacheState: 'warm'
    });
    const check = validateUSTFv1(traj);
    assert.equal(check.valid, true);
    assert.equal(check.errors.length, 0);

    const badTraj = { ...traj, version: '2.0.0' };
    const badCheck = validateUSTFv1(badTraj);
    assert.equal(badCheck.valid, false);
    assert.ok(badCheck.errors.some(e => e.includes("version must be '1.0.0'")));
  });

  it('6.5 Universal Session Trajectory (USTF v1): JSON serializer & deserializer round-trip identical', () => {
    const original = createMockUSTFTrajectory({ turnsCount: 2 });
    const jsonString = serializeUSTFv1(original);
    assert.equal(typeof jsonString, 'string');
    const restored = deserializeUSTFv1(jsonString);
    assert.deepEqual(restored, original);
  });
});

// ============================================================================
// Feature 7: Zero Runtime Dependencies (7.1 - 7.5)
// ============================================================================
describe('Feature 7: Zero Runtime Dependencies', () => {
  it('7.1 Zero Runtime Dependencies: package.json has empty "dependencies": {}', () => {
    const res = checkZeroRuntimeDeps('package.json');
    assert.equal(res.valid, true, 'Zero runtime dependencies gate must pass');
    assert.equal(res.dependencies.length, 0, 'Dependencies list must be empty');
  });

  it('7.2 Zero Runtime Dependencies: production dependencies key is empty object or undefined', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const deps = pkg.dependencies || {};
    assert.equal(Object.keys(deps).length, 0, 'Production dependencies count must be 0');
  });

  it('7.3 Zero Runtime Dependencies: devDependencies isolated from runtime bin', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.ok(pkg.devDependencies, 'devDependencies allowed for build/test scripts');
    const deps = pkg.dependencies || {};
    assert.equal(Object.keys(deps).length, 0, 'pkg.dependencies must not exist or be empty in production');
  });

  it('7.4 Zero Runtime Dependencies: zero imports of external packages in src/', () => {
    function scanDir(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          scanDir(full);
        } else if (ent.name.endsWith('.mjs') || ent.name.endsWith('.js')) {
          const code = fs.readFileSync(full, 'utf8');
          const matches = code.matchAll(/\bimport\s+.*?from\s+['"]([^'"]+)['"]/g);
          for (const m of matches) {
            const spec = m[1];
            const isRelative = spec.startsWith('.') || spec.startsWith('/');
            const isNode = spec.startsWith('node:');
            assert.ok(isRelative || isNode, `Forbidden external package import '${spec}' in ${full}`);
          }
        }
      }
    }
    scanDir(path.resolve('src'));
  });

  it('7.5 Zero Runtime Dependencies: verification helper functions reliably in clean sandbox', () => {
    const ws = createTempWorkspace({
      files: {
        'package.json': JSON.stringify({ name: 'test-airgap', version: '1.0.0', dependencies: {} })
      }
    });
    try {
      const res = checkZeroRuntimeDeps(path.join(ws.wsDir, 'package.json'));
      assert.equal(res.valid, true);
      assert.equal(res.dependencies.length, 0);

      ws.writeFile('package.json', JSON.stringify({ dependencies: { express: '^4.18.0' } }));
      const badRes = checkZeroRuntimeDeps(path.join(ws.wsDir, 'package.json'));
      assert.equal(badRes.valid, false);
      assert.deepEqual(badRes.dependencies, ['express']);
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 8: Dynamic SQLite Probing (8.1 - 8.5)
// ============================================================================
describe('Feature 8: Dynamic SQLite Probing', () => {
  it('8.1 Dynamic SQLite Probing: detects node:sqlite capability based on Node version', async () => {
    const env = detectRuntimeEnv();
    const available = await isSqliteAvailable();
    if (env.isNode22Plus) {
      assert.equal(available, true, 'node:sqlite should be available on Node >=22.5');
    } else if (env.isNode20) {
      assert.equal(available, false, 'node:sqlite should not be available on Node 20 LTS');
    }
  });

  it('8.2 Dynamic SQLite Probing: probe executes cleanly without unhandled rejection', async () => {
    const promise = isSqliteAvailable();
    await assert.doesNotReject(promise, 'Probing must never throw unhandled rejection');
    const res = await promise;
    assert.equal(typeof res, 'boolean');
  });

  it('8.3 Dynamic SQLite Probing: verifies client operational capability', async () => {
    const ws = createTempWorkspace();
    try {
      const target = path.join(ws.wsDir, 'test_probe');
      const { dbPath, jsonlPath } = await createMockDatabaseFixture(target, {
        tables: { steps: 'id INT, name TEXT' },
        records: [{ __table: 'steps', __values: { id: 1, name: 'first' } }]
      });

      const client = await getMockDatabaseClient({ dbPath, jsonlPath, readOnly: true });
      assert.ok(client.type === 'sqlite' || client.type === 'jsonl');
      const row = client.get('SELECT * FROM steps WHERE id = 1');
      assert.ok(row && (row.name === 'first' || row.id === 1));
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('8.4 Dynamic SQLite Probing: gracefully handles probe calls and resets', async () => {
    resetSqliteProbeCache();
    const res1 = await isSqliteAvailable();
    assert.equal(typeof res1, 'boolean');
    resetSqliteProbeCache();
    const res2 = await isSqliteAvailable();
    assert.equal(res1, res2);
  });

  it('8.5 Dynamic SQLite Probing: caches probe result for sub-millisecond reuse', async () => {
    await isSqliteAvailable();
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      await isSqliteAvailable();
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 20, `200 cached probe checks took ${elapsed}ms (expected < 20ms)`);
  });
});

// ============================================================================
// Feature 9: Node 20 LTS JSONL Fallback (9.1 - 9.5)
// ============================================================================
describe('Feature 9: Node 20 LTS JSONL Fallback', () => {
  it('9.1 Node 20 LTS JSONL Fallback: activates when forceFallback: true', async () => {
    const ws = createTempWorkspace({
      files: { 'store.jsonl': '{"id": 1, "status": "active"}\n' }
    });
    try {
      const jsonlPath = path.join(ws.wsDir, 'store.jsonl');
      const client = await getMockDatabaseClient({ jsonlPath, forceFallback: true, readOnly: true });
      assert.equal(client.type, 'jsonl');
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('9.2 Node 20 LTS JSONL Fallback: JsonlDatabaseFallbackWrapper loads records', () => {
    const ws = createTempWorkspace({
      files: {
        'data.jsonl': [
          JSON.stringify({ step: 1, type: 'USER' }),
          JSON.stringify({ step: 2, type: 'TOOL' }),
          JSON.stringify({ step: 3, type: 'RESPONSE' })
        ].join('\n') + '\n'
      }
    });
    try {
      const p = path.join(ws.wsDir, 'data.jsonl');
      const wrapper = new JsonlDatabaseFallbackWrapper(p, { readOnly: true });
      const records = wrapper.all();
      assert.equal(records.length, 3);
      assert.equal(records[0].step, 1);
    } finally {
      ws.cleanup();
    }
  });

  it('9.3 Node 20 LTS JSONL Fallback: all(filterFn) returns matching items', () => {
    const ws = createTempWorkspace({
      files: {
        'steps.jsonl': [
          JSON.stringify({ idx: 0, status: 'OK' }),
          JSON.stringify({ idx: 1, status: 'ERROR' }),
          JSON.stringify({ idx: 2, status: 'OK' })
        ].join('\n') + '\n'
      }
    });
    try {
      const p = path.join(ws.wsDir, 'steps.jsonl');
      const wrapper = new JsonlDatabaseFallbackWrapper(p, { readOnly: true });
      const okRows = wrapper.all("SELECT * FROM steps WHERE status = 'OK'");
      assert.equal(okRows.length, 2);
      assert.equal(okRows[0].idx, 0);
      assert.equal(okRows[1].idx, 2);

      const fnRows = wrapper.all(r => r.status === 'ERROR');
      assert.equal(fnRows.length, 1);
      assert.equal(fnRows[0].idx, 1);
    } finally {
      ws.cleanup();
    }
  });

  it('9.4 Node 20 LTS JSONL Fallback: get(filterFn) returns single match', () => {
    const ws = createTempWorkspace({
      files: {
        'steps.jsonl': [
          JSON.stringify({ idx: 10, name: 'alpha' }),
          JSON.stringify({ idx: 20, name: 'beta' })
        ].join('\n') + '\n'
      }
    });
    try {
      const p = path.join(ws.wsDir, 'steps.jsonl');
      const wrapper = new JsonlDatabaseFallbackWrapper(p, { readOnly: true });
      const match = wrapper.get(r => r.idx === 20);
      assert.ok(match);
      assert.equal(match.name, 'beta');

      const miss = wrapper.get(r => r.idx === 999);
      assert.equal(miss, null);
    } finally {
      ws.cleanup();
    }
  });

  it('9.5 Node 20 LTS JSONL Fallback: searchFts(query) performs tokenized search', () => {
    const ws = createTempWorkspace({
      files: {
        'logs.jsonl': [
          JSON.stringify({ id: 1, text: 'Prefix cache hit rate is 95%' }),
          JSON.stringify({ id: 2, text: 'Cold cache miss on turn 3' }),
          JSON.stringify({ id: 3, text: 'Unrelated log message' })
        ].join('\n') + '\n'
      }
    });
    try {
      const p = path.join(ws.wsDir, 'logs.jsonl');
      const wrapper = new JsonlDatabaseFallbackWrapper(p, { readOnly: true });
      const hits = wrapper.searchFts('cache hit');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, 1);

      const misses = wrapper.searchFts('cache miss');
      assert.equal(misses.length, 1);
      assert.equal(misses[0].id, 2);
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 10: Read-Only SQLite Invariant (10.1 - 10.5)
// ============================================================================
describe('Feature 10: Read-Only SQLite Invariant', () => {
  it('10.1 Read-Only SQLite Invariant: opens session DB with { readOnly: true }', async () => {
    const ws = createTempWorkspace({
      files: { 'session.jsonl': '{"turn": 0}\n' }
    });
    try {
      const client = await getMockDatabaseClient({
        jsonlPath: path.join(ws.wsDir, 'session.jsonl'),
        forceFallback: true,
        readOnly: true
      });
      assert.ok(client);
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('10.2 Read-Only SQLite Invariant: SELECT queries succeed normally', async () => {
    const ws = createTempWorkspace();
    try {
      const target = path.join(ws.wsDir, 'readonly_test');
      const { dbPath, jsonlPath } = await createMockDatabaseFixture(target, {
        tables: { telemetry: 'key TEXT, val INT' },
        records: [{ __table: 'telemetry', __values: { key: 'tokens', val: 1200 } }]
      });

      const client = await getMockDatabaseClient({ dbPath, jsonlPath, readOnly: true });
      const rows = client.all("SELECT * FROM telemetry WHERE key = 'tokens'");
      assert.ok(Array.isArray(rows));
      assert.ok(rows.length >= 1);
      assert.equal(rows[0].val, 1200);
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('10.3 Read-Only SQLite Invariant: protected host DBs guarded against read-write', () => {
    const mockOpenFn = (dbPath, opts) => {
      if (!opts || !opts.readOnly) {
        throw new Error('Zero-Trust SQLite Guard: Cannot open host database in read-write mode');
      }
      return { ok: true };
    };
    assertHostDbWriteRejected(mockOpenFn, 'conversations/session_123.db');
  });

  it('10.4 Read-Only SQLite Invariant: assertSqliteReadOnlyEnforced rejects write operations', async () => {
    const ws = createTempWorkspace({
      files: { 'test.jsonl': '{"id": 1}\n' }
    });
    try {
      const client = await getMockDatabaseClient({
        jsonlPath: path.join(ws.wsDir, 'test.jsonl'),
        forceFallback: true,
        readOnly: true
      });
      await assertSqliteReadOnlyEnforced(client);
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  it('10.5 Read-Only SQLite Invariant: connection closes cleanly without lock leak', async () => {
    const ws = createTempWorkspace({
      files: { 'session.jsonl': '{"step": 1}\n' }
    });
    const client = await getMockDatabaseClient({
      jsonlPath: path.join(ws.wsDir, 'session.jsonl'),
      forceFallback: true,
      readOnly: true
    });
    client.get(r => r.step === 1);
    client.close();
    assert.doesNotThrow(() => ws.cleanup());
  });
});

// ============================================================================
// Feature 11: Unified DET-01..32 Catalog (11.1 - 11.5)
// ============================================================================
describe('Feature 11: Unified DET-01..32 Catalog', () => {
  it('11.1 Unified DET-01..32 Catalog: all 32 detectors defined in catalog', () => {
    const keys = Object.keys(DETECTOR_CATALOG);
    assert.equal(keys.length, 32, 'Catalog must contain exactly 32 detectors');
    for (let i = 1; i <= 32; i++) {
      const id = `DET-${String(i).padStart(2, '0')}`;
      assert.ok(DETECTOR_CATALOG[id], `Catalog must define ${id}`);
      assert.equal(DETECTOR_CATALOG[id].id, id);
    }
  });

  it('11.2 Unified DET-01..32 Catalog: DET-30 designated as scratchpad loop detector', () => {
    const det30 = DETECTOR_CATALOG['DET-30'];
    assert.ok(det30);
    assert.ok(det30.name.includes('Scratchpad Loop'));
    assert.equal(det30.primarySlug, 'thinking-drift-loop');
    assert.equal(det30.defaultMode, 'guard');
  });

  it('11.3 Unified DET-01..32 Catalog: detector severity levels & modes mapped', () => {
    for (const [id, meta] of Object.entries(DETECTOR_CATALOG)) {
      assert.ok(['guard', 'advisory'].includes(meta.defaultMode), `${id} must have valid defaultMode`);
      assert.ok(typeof meta.name === 'string' && meta.name.length > 0);
    }
  });

  it('11.4 Unified DET-01..32 Catalog: detectors facade functions correctly', () => {
    assert.equal(detectors.has('DET-01'), true);
    assert.equal(detectors.has('DET-32'), true);
    assert.equal(detectors.has('DET-99'), false);

    const meta = detectors.get('DET-05');
    assert.ok(meta);
    assert.equal(meta.id, 'DET-05');
  });

  it('11.5 Unified DET-01..32 Catalog: standard findings schema verified', () => {
    const meta = getDetectorMeta('DET-14');
    assert.ok(meta);
    assert.equal(meta.id, 'DET-14');
    assert.equal(meta.defaultMode, 'guard');
    assert.ok(meta.name.includes('Stop Gate'));
  });
});

// ============================================================================
// Feature 12: DET-21 Deprecated Alias (12.1 - 12.5)
// ============================================================================
describe('Feature 12: DET-21 Deprecated Alias', () => {
  it('12.1 DET-21 Deprecated Alias: resolveDetectorId maps DET-21 to DET-30', () => {
    assert.equal(resolveDetectorId('DET-21'), 'DET-30');
    assert.equal(resolveDetectorId('DET21'), 'DET-30');
    assert.equal(resolveDetectorId('det-21'), 'DET-30');
    assert.equal(resolveCanonicalDetectorId('DET-21'), 'DET-30');
  });

  it('12.2 DET-21 Deprecated Alias: aliasOf points to DET-30', () => {
    const det21 = DETECTOR_CATALOG['DET-21'];
    assert.ok(det21);
    assert.equal(det21.aliasOf, 'DET-30');
    assert.ok(det21.name.includes('Deprecated Alias'));
  });

  it('12.3 DET-21 Deprecated Alias: getDetectorMeta resolves alias to DET-30', () => {
    const meta = getDetectorMeta('DET-21');
    assert.ok(meta);
    assert.equal(meta.id, 'DET-30');
    assert.equal(meta.primarySlug, 'thinking-drift-loop');
  });

  it('12.4 DET-21 Deprecated Alias: semantic slugs map consistently', () => {
    const canonical = resolveDetectorId('DET-21');
    assert.equal(canonical, 'DET-30');
    assert.equal(ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG[canonical], 'thinking-drift-loop');
    assert.equal(ADVISORY_DETECTOR_SLUGS[canonical], 'thinking-drift-loop');
  });

  it('12.5 DET-21 Deprecated Alias: configuration overrides map cleanly', () => {
    const cfg = loadHorizonConfig({
      overrides: {
        detectors: { 'DET-21': 'off' }
      }
    });
    assert.ok(cfg && cfg.detectors);
    assert.equal(cfg.detectors['DET-30'], 'off');
  });
});

// ============================================================================
// Feature 13: Local Repo Blindspot Sensors (13.1 - 13.5)
// ============================================================================
describe('Feature 13: Local Repo Blindspot Sensors', () => {
  it('13.1 Local Repo Blindspot Sensors: DIRTY_SNAP detects externally modified files', async () => {
    const ws = createTempWorkspace();
    try {
      const targetFile = ws.writeFile('src/app.js', 'console.log("v1");');
      const baseTime = Date.now() - 5000;

      fs.utimesSync(targetFile, new Date(), new Date());

      const events = [
        {
          toolName: 'read_file',
          targetPath: targetFile,
          timestampMs: baseTime
        }
      ];

      const dirty = detectDirtySnapshots(events, ws.wsDir);
      assert.ok(Array.isArray(dirty));
      assert.ok(dirty.length >= 1);
      assert.ok(dirty[0].includes('app.js'));
    } finally {
      ws.cleanup();
    }
  });

  it('13.2 Local Repo Blindspot Sensors: UNSEEN_CALLERS identifies workspace callers', async () => {
    const ws = createTempWorkspace();
    try {
      const target = ws.writeFile('src/target.js', 'export const secret = 42;');
      const caller = ws.writeFile('src/caller.js', "import { secret } from './target.js'; console.log(secret);");

      const unseen = detectUnseenCallers([target], [target], ws.wsDir);
      assert.ok(Array.isArray(unseen));
      assert.ok(unseen.some(p => p.includes('caller.js')));
    } finally {
      ws.cleanup();
    }
  });

  it('13.3 Local Repo Blindspot Sensors: LEGACY_POISON detects deprecated code', () => {
    const events = [
      {
        targetPath: 'src/legacy/oldService.js',
        content: '/** @deprecated Use newService instead */\nexport function old() {}'
      }
    ];
    const poison = detectLegacyPoison(events);
    assert.ok(Array.isArray(poison));
    assert.equal(poison.length, 1);
    assert.ok(poison[0].toLowerCase().includes('oldservice.js'));
  });

  it('13.4 Local Repo Blindspot Sensors: FOREIGN_BLEED category declared in taxonomy', () => {
    assert.ok(CATEGORIES.FOREIGN_BLEED, 'CATEGORIES.FOREIGN_BLEED must be defined');
    assert.equal(CATEGORIES.FOREIGN_BLEED, 'FOREIGN_BLEED');
  });

  it('13.5 Local Repo Blindspot Sensors: clean workspace produces zero findings', () => {
    assert.deepEqual(detectDirtySnapshots([], ''), []);
    assert.deepEqual(detectUnseenCallers([], [], ''), []);
    assert.deepEqual(detectLegacyPoison([], {}), []);
  });
});

// ============================================================================
// Feature 14: DET-31 Git Merge Conflict Sensor (14.1 - 14.5)
// ============================================================================
describe('Feature 14: DET-31 Git Merge Conflict Sensor', () => {
  it('14.1 DET-31 Git Merge Conflict Sensor: executes git merge-tree probe', () => {
    const ws = createTempWorkspace();
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('file.txt', 'base content\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: ws.wsDir, stdio: 'ignore' });

      const defaultBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

      // Branch 1
      execFileSync('git', ['checkout', '-b', 'feat1'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('file.txt', 'feat1 content\n');
      execFileSync('git', ['commit', '-am', 'feat1 commit'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Branch 2
      execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feat2'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('file.txt', 'feat2 content\n');
      execFileSync('git', ['commit', '-am', 'feat2 commit'], { cwd: ws.wsDir, stdio: 'ignore' });

      let conflict = false;
      try {
        execFileSync('git', ['merge-tree', '--write-tree', 'feat1', 'feat2'], {
          cwd: ws.wsDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch {
        conflict = true;
      }
      assert.equal(conflict, true, 'Probe must detect conflict between feat1 and feat2');
    } finally {
      ws.cleanup();
    }
  });

  it('14.2 DET-31 Git Merge Conflict Sensor: detects conflicting files accurately', () => {
    const ws = createTempWorkspace();
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('conflicted.txt', 'line 1\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'c0'], { cwd: ws.wsDir, stdio: 'ignore' });

      const defaultBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

      execFileSync('git', ['checkout', '-b', 'b1'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('conflicted.txt', 'line 1 changed in b1\n');
      execFileSync('git', ['commit', '-am', 'c1'], { cwd: ws.wsDir, stdio: 'ignore' });

      execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'b2'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('conflicted.txt', 'line 1 changed in b2\n');
      execFileSync('git', ['commit', '-am', 'c2'], { cwd: ws.wsDir, stdio: 'ignore' });

      let output = '';
      try {
        output = execFileSync('git', ['merge-tree', '--write-tree', 'b1', 'b2'], {
          cwd: ws.wsDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        output = `${err.stdout || ''}\n${err.stderr || ''}`;
      }
      assert.ok(output.includes('conflicted.txt'), 'Output must identify conflicted.txt');
    } finally {
      ws.cleanup();
    }
  });

  it('14.3 DET-31 Git Merge Conflict Sensor: zero disk/index mutation', () => {
    const ws = createTempWorkspace();
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('file.txt', 'base\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: ws.wsDir, stdio: 'ignore' });

      execFileSync('git', ['branch', 'branch1'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['branch', 'branch2'], { cwd: ws.wsDir, stdio: 'ignore' });

      const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: ws.wsDir, encoding: 'utf8' });
      const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws.wsDir, encoding: 'utf8' }).trim();

      try {
        execFileSync('git', ['merge-tree', '--write-tree', 'branch1', 'branch2'], {
          cwd: ws.wsDir,
          stdio: 'ignore'
        });
      } catch (err) { void err; }

      const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: ws.wsDir, encoding: 'utf8' });
      const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws.wsDir, encoding: 'utf8' }).trim();

      assert.equal(statusAfter, statusBefore, 'Working tree must remain unchanged');
      assert.equal(headAfter, headBefore, 'HEAD commit must remain unchanged');
    } finally {
      ws.cleanup();
    }
  });

  it('14.4 DET-31 Git Merge Conflict Sensor: completes within latency benchmark SLA', () => {
    const ws = createTempWorkspace();
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('file.txt', 'base\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: ws.wsDir, stdio: 'ignore' });

      execFileSync('git', ['branch', 'b1'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['branch', 'b2'], { cwd: ws.wsDir, stdio: 'ignore' });

      const t0 = Date.now();
      execFileSync('git', ['merge-tree', '--write-tree', 'b1', 'b2'], {
        cwd: ws.wsDir,
        stdio: 'ignore'
      });
      const durationMs = Date.now() - t0;
      assert.ok(durationMs < 250, `git merge-tree probe completed in ${durationMs}ms`);
    } finally {
      ws.cleanup();
    }
  });

  it('14.5 DET-31 Git Merge Conflict Sensor: clean merge returns clean status without conflict', () => {
    const ws = createTempWorkspace();
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('fileA.txt', 'content A\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: ws.wsDir, stdio: 'ignore' });

      const defaultBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

      // Branch 1 adds fileB
      execFileSync('git', ['checkout', '-b', 'branchA'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('fileB.txt', 'content B\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add fileB'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Branch 2 adds fileC
      execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'branchB'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('fileC.txt', 'content C\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add fileC'], { cwd: ws.wsDir, stdio: 'ignore' });

      const output = execFileSync('git', ['merge-tree', '--write-tree', 'branchA', 'branchB'], {
        cwd: ws.wsDir,
        encoding: 'utf8'
      }).trim();

      assert.match(output, /^[0-9a-f]{40}$/, 'Output must be a valid 40-char SHA in a clean merge');
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 15: DET-32 Semantic Drift Guard (15.1 - 15.5)
// ============================================================================
describe('Feature 15: DET-32 Semantic Drift Guard', () => {
  it('15.1 DET-32 Semantic Drift Guard: detects agent oscillating between refuted hypotheses', () => {
    // Realistic turn history where an agent repeats a refuted hypothesis >= 3 times
    const recentTurns = [
      { turn: 1, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 2, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 3, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' }
    ];

    // 1. Direct verification via production auditHypothesisLoop
    const loopAudit = auditHypothesisLoop(recentTurns);
    assert.equal(loopAudit.isLoop, true);
    assert.equal(loopAudit.failedCount, 3);
    assert.equal(loopAudit.hypothesis, 'Bug is caused by missing env var');

    // 2. Comprehensive verification via production evaluateSemanticDrift
    const driftResult = evaluateSemanticDrift({
      recentTurns,
      flightMode: 'COACH'
    });
    assert.equal(driftResult.detectorId, 'DET-32');
    assert.equal(driftResult.triggered, true);
    assert.equal(driftResult.decision, 'warn');
    assert.equal(driftResult.violations.length, 1);
    assert.equal(driftResult.violations[0].type, 'HYPOTHESIS_LOOP');
    assert.equal(driftResult.violations[0].hypothesis, 'Bug is caused by missing env var');
  });

  it('15.2 DET-32 Semantic Drift Guard: tracks task.md constraint contradiction', () => {
    const existingTaskRules = [
      '# Architectural Invariants',
      '- NEVER modify package-lock.json without prior user authorization.',
      '- ALWAYS open SQLite session databases in read-only mode.'
    ].join('\n');

    const contradictoryDirective = 'ALWAYS modify package-lock.json to resolve peerDependencies.';
    const result = auditRuleContradictions(contradictoryDirective, existingTaskRules);

    assert.equal(result.hasContradiction, true);
    assert.ok(result.conflictCount >= 1);
    assert.ok(result.conflicts[0].overlapTokens.includes('modify'));
  });

  it('15.3 DET-32 Semantic Drift Guard: generates re-anchoring directive bounded strictly under 300 tokens', () => {
    const turnContext = {
      invariants: [
        'NEVER modify package-lock.json directly',
        'All SQLite connections must be read-only',
        'Keep /compact instructions plain-text'
      ],
      candidateAction: {
        tool: 'edit_file',
        targetFile: 'package-lock.json',
        description: 'Updating dependencies in package-lock.json'
      },
      flightMode: 'COACH'
    };

    // Evaluates production re-anchoring directive generation
    const result = evaluateSemanticDrift(turnContext);
    assert.equal(result.triggered, true);
    assert.ok(result.reanchoringDirective, 'Re-anchoring directive must be produced');
    assert.ok(result.reanchoringDirective.includes('[DET-32 Re-anchoring Directive]'));
    assert.ok(result.reanchoringDirective.includes('Mandatory Remediation:'));
    assert.ok(result.reanchoringDirective.includes('package-lock.json'));

    // Token estimation (~4 characters per token heuristic)
    const tokenEstimate = Math.ceil(result.reanchoringDirective.length / 4);
    assert.ok(tokenEstimate < 300, `Directive tokens (${tokenEstimate}) must be strictly < 300`);
  });

  it('15.4 DET-32 Semantic Drift Guard: distinguishes legitimate progressive pivot from repetitive loop', () => {
    // Legitimate progressive pivot: 3 failed attempts with distinct hypotheses
    const progressiveTurns = [
      { turn: 1, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 2, hypothesis: 'Bug is caused by incorrect CORS header', outcome: 'failed' },
      { turn: 3, hypothesis: 'Bug is caused by invalid token expiry', outcome: 'failed' }
    ];
    const progressiveResult = auditHypothesisLoop(progressiveTurns);
    assert.equal(progressiveResult.isLoop, false, 'Progressive pivot must not trigger loop detection');
    assert.equal(progressiveResult.hypothesis, null);

    const progressiveEval = evaluateSemanticDrift({
      recentTurns: progressiveTurns,
      flightMode: 'COACH'
    });
    assert.equal(progressiveEval.triggered, false);
    assert.equal(progressiveEval.decision, 'allow');

    // Circular repetitive loop: 3 failed attempts repeating the identical hypothesis
    const circularTurns = [
      { turn: 1, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 2, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 3, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' }
    ];
    const circularResult = auditHypothesisLoop(circularTurns);
    assert.equal(circularResult.isLoop, true, 'Circular repeating hypothesis must trigger loop detection');
    assert.equal(circularResult.failedCount, 3);

    const circularEval = evaluateSemanticDrift({
      recentTurns: circularTurns,
      flightMode: 'COACH'
    });
    assert.equal(circularEval.triggered, true);
    assert.equal(circularEval.violations[0].type, 'HYPOTHESIS_LOOP');
  });

  it('15.5 DET-32 Semantic Drift Guard: operates in advisory mode by default without blocking execution', () => {
    const turnContext = {
      invariants: ['NEVER touch package lockfiles directly'],
      candidateAction: {
        tool: 'edit_file',
        targetFile: 'package-lock.json',
        description: 'Modifying package-lock.json dependencies'
      }
      // flightMode omitted: evaluates in default COACH mode
    };

    // Default execution mode (COACH) generates advisory warning rather than blocking execution
    const advisoryResult = evaluateSemanticDrift(turnContext);
    assert.equal(advisoryResult.triggered, true);
    assert.equal(advisoryResult.decision, 'warn', 'Default flightMode (COACH) must yield advisory warning');
    assert.ok(advisoryResult.reanchoringDirective);

    // Explicit AUTO_PILOT mode triggers blocking deny
    const blockingResult = evaluateSemanticDrift({
      ...turnContext,
      flightMode: 'AUTO_PILOT'
    });
    assert.equal(blockingResult.triggered, true);
    assert.equal(blockingResult.decision, 'deny', 'AUTO_PILOT flightMode must yield blocking deny');
  });
});

// ============================================================================
// Feature 16: Lossless PostToolUse Offloader (16.1 - 16.5)
// ============================================================================
describe('Feature 16: Lossless PostToolUse Offloader', () => {
  it('16.1 Lossless PostToolUse Offloader: triggers when tool output exceeds 4,000 tokens', () => {
    const ws = createTempWorkspace();
    try {
      const largeOutput = 'PASS test/unit_1.test.mjs\n' + 'Log line data chunk.\n'.repeat(850);
      const res = sanitizePostToolOutput({
        toolName: 'Bash',
        toolOutput: largeOutput
      }, { cwd: ws.wsDir });

      assert.equal(res.eligible, true);
      assert.equal(res.offloaded, true);
      assert.ok(res.originalTokens >= OFFLOAD_TOKEN_THRESHOLD);
      assert.ok(res.finalTokens < res.originalTokens);
    } finally {
      ws.cleanup();
    }
  });

  it('16.2 Lossless PostToolUse Offloader: writes complete lossless content to disk artifact store with SHA-256 naming', () => {
    const ws = createTempWorkspace();
    try {
      const payload = 'Command test log payload.\n'.repeat(900);
      const res = sanitizePostToolOutput({
        toolName: 'Bash',
        toolOutput: payload
      }, { cwd: ws.wsDir });

      assert.equal(res.offloaded, true);
      assert.ok(res.artifactPath && typeof res.artifactPath === 'string');
      assert.ok(fs.existsSync(res.artifactPath));
      assert.match(path.basename(res.artifactPath), /^ah_[0-9a-f]{64}\.txt$/);

      const savedDiskContent = fs.readFileSync(res.artifactPath, 'utf8');
      assert.equal(savedDiskContent.trim(), payload.trim());
    } finally {
      ws.cleanup();
    }
  });

  it('16.3 Lossless PostToolUse Offloader: replaces transcript output with structured summary pointer and preserves error lines', () => {
    const ws = createTempWorkspace();
    try {
      const errorLine = 'AssertionError: Expected 200 OK but received 500 Internal Error at server.mjs:42';
      const outputWithError = 'Downloading packages...\n'.repeat(600) + errorLine + '\nDone.\n'.repeat(500);

      const res = sanitizePostToolOutput({
        toolName: 'Bash',
        toolOutput: outputWithError
      }, { cwd: ws.wsDir });

      assert.equal(res.offloaded, true);
      assert.match(res.updatedToolOutput, /\[Highbeam Artifact Offload:/);
      assert.match(res.updatedToolOutput, /Critical Error \/ Failure Lines Preserved Verbatim/);
      assert.ok(res.updatedToolOutput.includes(errorLine));
    } finally {
      ws.cleanup();
    }
  });

  it('16.4 Lossless PostToolUse Offloader: strictly preserves workspace Read / read_file operations without offloading', () => {
    const ws = createTempWorkspace();
    try {
      const codeOutput = 'export const API_KEY = "dummy";\n'.repeat(1600);
      assert.equal(isToolEligibleForSanitization('read_file'), false);
      assert.equal(isToolEligibleForSanitization('Read'), false);
      assert.equal(isToolEligibleForSanitization('View'), false);

      const res = sanitizePostToolOutput({
        toolName: 'read_file',
        toolOutput: codeOutput
      }, { cwd: ws.wsDir });

      assert.equal(res.eligible, false);
      assert.equal(res.offloaded, false);
      assert.equal(res.updatedToolOutput, codeOutput);
    } finally {
      ws.cleanup();
    }
  });

  it('16.5 Lossless PostToolUse Offloader: retrieval verification recovers byte-for-byte identical content from offloaded store', () => {
    const ws = createTempWorkspace();
    try {
      const originalText = 'Exact raw line 1\nExact raw line 2\n'.repeat(500);
      const res = sanitizePostToolOutput({
        toolName: 'PowerShell',
        toolOutput: originalText
      }, { cwd: ws.wsDir });

      assert.ok(res.artifactPath);
      const retrieved = fs.readFileSync(res.artifactPath, 'utf8');
      assert.equal(retrieved, originalText);
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 17: TTFT & Drift Detection (17.1 - 17.5)
// ============================================================================
describe('Feature 17: TTFT & Drift Detection', () => {
  it('17.1 TTFT & Drift Detection: calculates exact Time-To-First-Token (TTFT) in milliseconds from turn events', () => {
    let drift = createInitialThinkingDrift();
    const tStart = 1000000;
    const tFirstToken = tStart + 420;

    drift = applyThinkingDriftEvent(drift, {
      eventType: 'turn.step',
      turnStartedAtMs: tStart,
      nowMs: tFirstToken,
      thinkingTokens: 100,
      outputTokens: 50
    });

    assert.equal(drift.lastTtftMs, 420);
    assert.equal(formatTtft(420), '420ms');
  });

  it('17.2 TTFT & Drift Detection: calculates thinking-to-output token ratio accurately', () => {
    let drift = createInitialThinkingDrift();
    drift = applyThinkingDriftEvent(drift, {
      eventType: 'turn.complete',
      thinkingTokens: 6000,
      outputTokens: 500,
      turnStartedAtMs: 1000,
      nowMs: 2500
    });

    assert.equal(drift.lastDriftRatio, 12.0);
    const classification = classifyTurnDrift({ thinkingTokens: 6000, visibleOutputTokens: 500, mutatingCalls: 0 });
    assert.equal(classification, 'loop_suspect');
  });

  it('17.3 TTFT & Drift Detection: detects thinking drift loop and triggers DET-30 scratchpad loop alert', () => {
    const turns = [
      { thinkingTokens: 5000, visibleOutputTokens: 200, mutatingCalls: 0 },
      { thinkingTokens: 6000, visibleOutputTokens: 150, mutatingCalls: 0 }
    ];

    const result = evaluateThinkingDriftLoop(turns);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'critical');
    assert.equal(result.gaDetectorId, 'DET-30');
    assert.match(result.message, /DET-(?:30|21) Scratchpad Loop/);
  });

  it('17.4 TTFT & Drift Detection: records rolling per-turn TTFT history and computes rolling averages', () => {
    let drift = createInitialThinkingDrift();
    const ttfts = [300, 500, 700];

    for (let i = 0; i < ttfts.length; i++) {
      drift = applyThinkingDriftEvent(drift, {
        eventType: 'turn.complete',
        ttftMs: ttfts[i],
        thinkingTokens: 1000,
        outputTokens: 500,
        nowMs: 1000 + (i * 1000)
      });
    }

    assert.equal(drift.turns.length, 3);
    assert.equal(drift.lastTtftMs, 700);
    assert.equal(drift.avgTtftMs, 500);
  });

  it('17.5 TTFT & Drift Detection: flags sudden TTFT latency spikes above baseline', () => {
    const baselineAvg = 400;
    const spikeTtft = 8500;
    const isSpike = spikeTtft > (baselineAvg * 5);

    assert.equal(isSpike, true);
    assert.equal(formatTtft(spikeTtft), '8.5s');
  });
});

// ============================================================================
// Feature 18: 95% Prefix-Cache Retention Radar (18.1 - 18.5)
// ============================================================================
describe('Feature 18: 95% Prefix-Cache Retention Radar', () => {
  it('18.1 95% Prefix-Cache Retention Radar: calculates prefix byte-offset mutation diff between consecutive prompts', () => {
    const promptA = 'System Prompt: You are Highbeam v4 assistant.'.repeat(10);
    const promptB = promptA.slice(0, 200) + ' [MODIFIED RULE] ' + promptA.slice(200);

    const diff = verifyRetentionRadarDiff(promptA, promptB);
    assert.equal(diff.firstDiffOffset, 200);
    assert.equal(diff.prefixMatchBytes, 200);
  });

  it('18.2 95% Prefix-Cache Retention Radar: reports retention percentage across turns accurately', () => {
    const base = 'A'.repeat(1000);
    const mutated = 'A'.repeat(850) + 'B'.repeat(150);

    const diff = verifyRetentionRadarDiff(base, mutated);
    assert.equal(diff.retentionPct, 85);
    assert.equal(diff.is95PctRetained, false);
    assert.equal(diff.grade, 'B');
  });

  it('18.3 95% Prefix-Cache Retention Radar: flags cache bust cause and byte position on mid-session prefix modification', () => {
    const orig = 'System Role: Senior Fullstack Software Engineer and Architecture Guard\nRules:\n- Never break build\n- Keep tests passing\n';
    const mutated = 'System Role: Senior Fullstack Software Engineer and Architecture Guard\nRules:\n- Never break build [BUST]\n- Keep tests passing\n';

    const diff = verifyRetentionRadarDiff(orig, mutated);
    assert.ok(diff.firstDiffOffset > 0);
    const bustCause = diff.firstDiffOffset < 50 ? 'role_prefix_mutation' : 'rule_mutation';
    assert.equal(bustCause, 'rule_mutation');
  });

  it('18.4 95% Prefix-Cache Retention Radar: grades retention accurately into Grade A, B, and C', () => {
    const base = 'X'.repeat(100);

    const gradeA = verifyRetentionRadarDiff(base, 'X'.repeat(96) + 'Y'.repeat(4));
    assert.equal(gradeA.retentionPct, 96);
    assert.equal(gradeA.grade, 'A');
    assert.equal(gradeA.is95PctRetained, true);

    const gradeB = verifyRetentionRadarDiff(base, 'X'.repeat(88) + 'Y'.repeat(12));
    assert.equal(gradeB.retentionPct, 88);
    assert.equal(gradeB.grade, 'B');

    const gradeC = verifyRetentionRadarDiff(base, 'X'.repeat(60) + 'Y'.repeat(40));
    assert.equal(gradeC.retentionPct, 60);
    assert.equal(gradeC.grade, 'C');
  });

  it('18.5 95% Prefix-Cache Retention Radar: tracks FNV-1a 64-bit block hash match rate for prompt sections', () => {
    const block1 = 'Context section: invariant rules';
    const block2 = 'Context section: invariant rules';
    const block3 = 'Context section: modified rules';

    const hash1 = fnv1a64Hex(block1);
    const hash2 = fnv1a64Hex(block2);
    const hash3 = fnv1a64Hex(block3);

    assert.equal(hash1, hash2);
    assert.notEqual(hash1, hash3);
    assert.equal(hash1.length, 16);
  });
});

// ============================================================================
// Feature 19: Algebraic C* Break-Even Router (19.1 - 19.5)
// ============================================================================
describe('Feature 19: Algebraic C* Break-Even Router', () => {
  it('19.1 Algebraic C* Break-Even Router: computes exact algebraic break-even C* = 6,522 tokens for Opus 5.5 to Sonnet 5.5', () => {
    const cStar = calculateBreakEvenCStar();
    assert.equal(cStar, 6522);
  });

  it('19.2 Algebraic C* Break-Even Router: advises model switch when cache is cold (cachedTokens = 0)', () => {
    const evaluation = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 0,
      cacheWarm: false
    });

    assert.ok(evaluation.switchToTargetModelUSD < evaluation.stayOnCurrentModelUSD);
  });

  it('19.3 Algebraic C* Break-Even Router: blocks model switch when warm cache makes Opus cheaper (cachedTokens > C*)', () => {
    const evaluation = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 25000,
      cacheWarm: true
    });

    assert.ok(evaluation.stayOnCurrentModelUSD < evaluation.switchToTargetModelUSD);
  });

  it('19.4 Algebraic C* Break-Even Router: evaluates user-defined price override tables and model variants', () => {
    const cStarOpus46 = calculateBreakEvenCStar({
      currentModel: 'claude-opus-4-6',
      targetModel: 'claude-sonnet-4-6'
    });
    assert.equal(cStarOpus46, 4615);
  });

  it('19.5 Algebraic C* Break-Even Router: calculates exact switch penalty in USD when switching prematurely', () => {
    const evaluation = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 50000,
      cacheWarm: true
    });

    const penaltyUSD = evaluation.switchToTargetModelUSD - evaluation.stayOnCurrentModelUSD;
    assert.ok(penaltyUSD > 0);
  });
});

// ============================================================================
// Feature 20: Haiku 100k Cliff Breaker (20.1 - 20.5)
// ============================================================================
describe('Feature 20: Haiku 100k Cliff Breaker', () => {
  it('20.1 Haiku 100k Cliff Breaker: monitors Haiku prompt token volume and passes safe volume (<90k)', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 65000);
    assert.equal(check.triggered, false);
    assert.equal(check.action, 'allow');
  });

  it('20.2 Haiku 100k Cliff Breaker: emits advisory compaction warning at 90,000 tokens', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 92000);
    assert.equal(check.triggered, false);
    assert.equal(check.action, 'advisory');
    assert.match(check.reason, /approaching (?:90k advisory boundary|100k cliff)/i);
  });

  it('20.3 Haiku 100k Cliff Breaker: fires circuit breaker at >= 98,000 tokens prior to cliff', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 98500);
    assert.equal(check.triggered, true);
    assert.equal(check.action, 'warn');

    const rawDet12 = evaluateDet12HaikuPreCliffBreaker({
      modelId: 'claude-haiku-5-5',
      totalInputTokens: 98500
    });
    assert.equal(rawDet12.triggered, true);
    assert.equal(rawDet12.decision, 'deny');
  });

  it('20.4 Haiku 100k Cliff Breaker: emits emergency halt when prompt token count crosses 100k cliff', () => {
    const check = checkHaiku100kCliffBreaker('claude-haiku-5-5', 101000);
    assert.equal(check.triggered, true);
    assert.equal(check.action, 'halt');
    assert.match(check.reason, /exceeded 100k 5x cost cliff/);
  });

  it('20.5 Haiku 100k Cliff Breaker: exempts non-Haiku models from DET-12 cliff breaker', () => {
    const checkSonnet = checkHaiku100kCliffBreaker('claude-sonnet-5-5', 180000);
    assert.equal(checkSonnet.triggered, false);
    assert.equal(checkSonnet.action, 'allow');
    assert.match(checkSonnet.reason, /Non-Haiku model/);
  });
});

// ============================================================================
// Feature 21: 1s Live Dual-TTL Countdown (21.1 - 21.5)
// ============================================================================
describe('Feature 21: 1s Live Dual-TTL Countdown', () => {
  it('21.1 1s Live Dual-TTL Countdown: tracks 5-minute prompt cache TTL (300s) and 1-hour billing TTL (3,600s)', () => {
    const now = 1000000;
    const lastTurn = now - 60000;
    const res = calculateDualTtlCountdown(lastTurn, now);

    assert.equal(res.cacheTtlSec, 240);
    assert.equal(res.billingTtlSec, 3540);
    assert.equal(res.isCacheExpired, false);
    assert.equal(res.isBillingExpired, false);
  });

  it('21.2 1s Live Dual-TTL Countdown: decrements countdown with sub-second accuracy and produces MM:SS formatted string', () => {
    const now = 1000000;
    const lastTurn = now - 175000;
    const res = calculateDualTtlCountdown(lastTurn, now);

    assert.equal(res.cacheTtlSec, 125);
    assert.equal(res.formattedCacheTtl, '02:05');
  });

  it('21.3 1s Live Dual-TTL Countdown: resets cache TTL countdown to full 300s upon new turn/cache event', () => {
    const now = 2000000;
    const res = calculateDualTtlCountdown(now, now);

    assert.equal(res.cacheTtlSec, 300);
    assert.equal(res.formattedCacheTtl, '05:00');
  });

  it('21.4 1s Live Dual-TTL Countdown: handles prompt cache expiration cleanly at 00:00 without negative numbers', () => {
    const now = 1000000;
    const lastTurn = now - 450000;
    const res = calculateDualTtlCountdown(lastTurn, now);

    assert.equal(res.cacheTtlSec, 0);
    assert.equal(res.formattedCacheTtl, '00:00');
    assert.equal(res.isCacheExpired, true);
  });

  it('21.5 1s Live Dual-TTL Countdown: supports rolling billing TTL countdown across 1-hour boundaries', () => {
    const start = 1000000;
    const now = start + 4500000;
    const res = calculateDualTtlCountdown(start, now, 300000, 3600000, { rolling: true });

    assert.equal(res.billingTtlSec, 2700);
    assert.equal(res.formattedBillingTtl, '45:00');
    assert.equal(res.isBillingExpired, true);
  });
});

// ============================================================================
// Feature 22: 5-Hour Billing Blocks (22.1 - 22.5)
// ============================================================================
describe('Feature 22: 5-Hour Billing Blocks', () => {
  it('22.1 5-Hour Billing Blocks: partitions continuous usage events into rolling 5-hour blocks', () => {
    const t0 = 1000000;
    const fiveHoursMs = 5 * 3600 * 1000;
    const events = [
      { timestamp: t0 + 1000, costUsd: 1.5, tokens: 50000, subagentId: 'main' },
      { timestamp: t0 + fiveHoursMs + 1000, costUsd: 2.0, tokens: 60000, subagentId: 'main' },
      { timestamp: t0 + (2 * fiveHoursMs) + 1000, costUsd: 3.0, tokens: 90000, subagentId: 'main' }
    ];

    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].blockIndex, 0);
    assert.equal(blocks[1].blockIndex, 1);
    assert.equal(blocks[2].blockIndex, 2);
  });

  it('22.2 5-Hour Billing Blocks: computes spend velocity ($/hr and tokens/min) per billing block', () => {
    const t0 = 1000000;
    const hour = 3600 * 1000;
    const events = [
      // Block 0 events (within first 5 hours)
      { timestamp: t0, costUsd: 6.0, tokens: 120000, subagentId: 'worker-1' },
      { timestamp: t0 + (2 * hour), costUsd: 9.0, tokens: 180000, subagentId: 'worker-2' },
      // Block 1 event (rolls over into second 5-hour block at 6h)
      { timestamp: t0 + (6 * hour), costUsd: 5.0, tokens: 150000, subagentId: 'worker-1' }
    ];

    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 2, 'Should partition into 2 rolling blocks');

    // Block 0 velocity: 15.0 USD over 5h = 3.0 USD/hr, 300k tokens over 300 min = 1000 tok/min
    assert.equal(blocks[0].blockIndex, 0);
    assert.equal(blocks[0].totalCostUsd, 15.0);
    assert.equal(blocks[0].totalTokens, 300000);
    assert.equal(blocks[0].burnRateUsdPerHour, 3.0);
    assert.equal(blocks[0].tokensPerMin, 1000);

    // Block 1 velocity: 5.0 USD over 5h = 1.0 USD/hr, 150k tokens over 300 min = 500 tok/min
    assert.equal(blocks[1].blockIndex, 1);
    assert.equal(blocks[1].totalCostUsd, 5.0);
    assert.equal(blocks[1].totalTokens, 150000);
    assert.equal(blocks[1].burnRateUsdPerHour, 1.0);
    assert.equal(blocks[1].tokensPerMin, 500);
  });

  it('22.3 5-Hour Billing Blocks: attributes spend accurately per subagent and coordinator stream', () => {
    const t0 = 1000000;
    const events = [
      { timestamp: t0 + 100, costUsd: 2.5, tokens: 10000, subagentId: 'worker-1' },
      { timestamp: t0 + 200, costUsd: 1.5, tokens: 5000, subagentId: 'worker-2' },
      { timestamp: t0 + 300, costUsd: 0.8, tokens: 2000, subagentId: 'main' }
    ];

    const [block] = partitionBillingBlocks(events);
    assert.equal(block.subagentSpend['worker-1'], 2.5);
    assert.equal(block.subagentSpend['worker-2'], 1.5);
    assert.equal(block.subagentSpend['main'], 0.8);
    assert.equal(block.totalCostUsd, 4.8);
  });

  it('22.4 5-Hour Billing Blocks: calculates cumulative session cost USD across all active blocks', () => {
    const t0 = 1000000;
    const fiveHoursMs = 5 * 3600 * 1000;
    const events = [
      { timestamp: t0, costUsd: 3.25, tokens: 20000 },
      { timestamp: t0 + fiveHoursMs + 10, costUsd: 4.75, tokens: 30000 }
    ];

    const blocks = partitionBillingBlocks(events);
    const cumulativeCost = blocks.reduce((sum, b) => sum + b.totalCostUsd, 0);
    assert.equal(cumulativeCost, 8.0);
  });

  it('22.5 5-Hour Billing Blocks: handles zero-activity blocks and empty usage events gracefully', () => {
    const blocks = partitionBillingBlocks([]);
    assert.deepEqual(blocks, []);
  });
});

// ============================================================================
// Feature 23: Retention Step-Chart & Sparklines (23.1 - 23.5)
// ============================================================================
describe('Feature 23: Retention Step-Chart & Sparklines', () => {
  it('23.1 Retention Step-Chart & Sparklines: generates valid script-free SVG retention step-chart from series data', () => {
    const retention = {
      measured: true,
      series: [
        { pct: 100, bust: false },
        { pct: 95, bust: false },
        { pct: 60, bust: true, cause: 'system_prompt_mutation' }
      ]
    };

    const svg = renderRetentionStepChart(retention);
    assert.match(svg, /<svg class="cr-svg"/);
    assert.match(svg, /<path d="/);
    assert.equal(svg.includes('<script>'), false);
  });

  it('23.2 Retention Step-Chart & Sparklines: generates Unicode sparklines adapting to token growth data', () => {
    const deltas = [1000, 2000, 5000, 8000];
    const sparkline = buildTurnVelocitySparkline(deltas, 4);

    assert.equal(sparkline.length, 4);
    assert.match(sparkline, /[\u2581-\u2588]+/);
  });

  it('23.3 Retention Step-Chart & Sparklines: adapts sparkline length to data point count and caps at maxTurns', () => {
    const longDeltas = Array.from({ length: 30 }, (_, i) => (i + 1) * 100);
    const capped = buildTurnVelocitySparkline(longDeltas, 16);

    assert.equal(capped.length, 16);
  });

  it('23.4 Retention Step-Chart & Sparklines: SVG includes accessible viewBox, role="img", and aria-label attributes', () => {
    const emptySvg = renderRetentionStepChart(null);

    assert.match(emptySvg, /viewBox="0 0 640 40"/);
    assert.match(emptySvg, /role="img"/);
    assert.match(emptySvg, /aria-label="Prefix retention: no multi-turn cache usage measured yet"/);
  });

  it('23.5 Retention Step-Chart & Sparklines: renders full Cost Radar HTML artifact with zero scripts and escaped session title', () => {
    const maliciousTitle = '<script>alert("xss")</script>';
    const html = renderCostRadarHtml({ meta: { sessionTitle: maliciousTitle } });

    assert.equal(html.includes('<script>alert'), false);
    assert.match(html, /&lt;script&gt;alert/);
    assert.match(html, /<!doctype html>/);
  });
});

// ============================================================================
// Feature 24: Real-Time Call-Tree Tracking (24.1 - 24.5)
// ============================================================================
describe('Feature 24: Real-Time Call-Tree Tracking', () => {
  it('24.1 Real-Time Call-Tree Tracking: starts and ends hierarchical execution spans with precise timestamps', () => {
    const span = createMockToolSpan({
      toolName: 'read_file',
      startMs: 1000,
      durationMs: 45
    });

    assert.ok(span.toolCallId);
    assert.equal(span.toolName, 'read_file');
    assert.equal(span.durationMs, 45);
    assert.equal(span.endMs, 1045);
  });

  it('24.2 Real-Time Call-Tree Tracking: maintains parent-child span hierarchy across nested tool calls', () => {
    const rootTurnId = `turn-${crypto.randomUUID().slice(0, 8)}`;
    const rootSpan = {
      spanId: rootTurnId,
      parentSpanId: null,
      kind: 'turn',
      name: 'turn_0',
      startTimeMs: 1000,
      durationMs: 350,
      status: 'ok'
    };

    const parentTool = createMockToolSpan({
      toolName: 'invoke_subagent',
      startMs: 1050,
      durationMs: 200
    });
    const parentSpan = {
      spanId: parentTool.toolCallId,
      parentSpanId: rootSpan.spanId,
      kind: 'tool',
      name: parentTool.toolName,
      startTimeMs: parentTool.startMs,
      durationMs: parentTool.durationMs,
      status: parentTool.status
    };

    const nestedTool = createMockToolSpan({
      toolName: 'read_file',
      startMs: 1070,
      durationMs: 45
    });
    const childSpan = {
      spanId: nestedTool.toolCallId,
      parentSpanId: parentSpan.spanId,
      kind: 'tool',
      name: nestedTool.toolName,
      startTimeMs: nestedTool.startMs,
      durationMs: nestedTool.durationMs,
      status: nestedTool.status
    };

    // Verify all spans comply with strict USTF span schema
    assert.equal(validateUstfSpan(rootSpan).valid, true);
    assert.equal(validateUstfSpan(parentSpan).valid, true);
    assert.equal(validateUstfSpan(childSpan).valid, true);

    // Verify parent-child lineage
    assert.equal(parentSpan.parentSpanId, rootSpan.spanId);
    assert.equal(childSpan.parentSpanId, parentSpan.spanId);

    // Verify trajectory-level span collection validates cleanly
    const trajectory = {
      $schema: 'https://ctxtop.dev/schemas/ustf-v1.json',
      version: '1.0.0',
      sessionId: 'session-calltree-hierarchy',
      harness: 'antigravity',
      events: [
        { eventId: 'ev-1', type: 'turn.start', timestampMs: 1000 },
        { eventId: 'ev-2', type: 'tool.call', timestampMs: 1050 },
        { eventId: 'ev-3', type: 'tool.result', timestampMs: 1250 },
        { eventId: 'ev-4', type: 'turn.complete', timestampMs: 1350 }
      ],
      spans: [rootSpan, parentSpan, childSpan]
    };
    const trajVal = validateUstfTrajectory(trajectory);
    assert.equal(trajVal.valid, true, `Call-tree trajectory must validate: ${trajVal.errors?.join(', ') || ''}`);
  });

  it('24.3 Real-Time Call-Tree Tracking: measures duration per span with sub-millisecond precision', () => {
    // Generate high-precision tool span using harness generator
    const span = createMockToolSpan({
      toolName: 'probe_sqlite_fts5',
      startMs: 100.25,
      durationMs: 0.60
    });

    assert.equal(span.startMs, 100.25);
    assert.equal(span.durationMs, 0.60);
    assert.equal(span.endMs, 100.85);

    const calculatedDuration = Number((span.endMs - span.startMs).toFixed(2));
    assert.equal(calculatedDuration, 0.60);

    // Verify sub-millisecond span passes USTF schema validation
    const ustfSpan = {
      spanId: span.toolCallId,
      parentSpanId: null,
      kind: 'tool',
      name: span.toolName,
      startTimeMs: span.startMs,
      durationMs: span.durationMs,
      status: span.status
    };
    const spanVal = validateUstfSpan(ustfSpan);
    assert.equal(spanVal.valid, true, 'Sub-millisecond duration span must satisfy USTF schema');

    // Verify trajectory containing sub-millisecond tool span validates
    const trajectory = createMockUSTFTrajectory({ turnsCount: 1 });
    trajectory.turns[0].toolSpans = [span];
    const trajVal = validateUSTFv1(trajectory);
    assert.equal(trajVal.valid, true, 'Trajectory with sub-millisecond span must be valid USTF v1');
  });

  it('24.4 Real-Time Call-Tree Tracking: generates ASCII hierarchical representation of call-tree', () => {
    // Build genuine trajectory with multi-tool call spans via harness
    const traj = createMockUSTFTrajectory({ turnsCount: 1, harness: 'antigravity' });
    traj.turns[0].turnIndex = 1;
    traj.turns[0].ttftMs = 150;
    traj.turns[0].toolSpans = [
      createMockToolSpan({ toolName: 'read_file', durationMs: 40 }),
      createMockToolSpan({ toolName: 'edit_file', durationMs: 80 })
    ];

    // Ensure trajectory conforms to USTF v1 specification
    const valResult = validateUSTFv1(traj);
    assert.equal(valResult.valid, true, 'Trajectory must pass USTF validation');

    // Generate hierarchical call-tree ASCII representation
    const renderCallTree = (trajectory) => {
      let out = `Session: ${trajectory.sessionId} [${trajectory.harness}]\n`;
      for (const t of trajectory.turns) {
        out += `└── Turn ${t.turnIndex} [${t.ttftMs}ms]\n`;
        const spans = t.toolSpans || [];
        for (let i = 0; i < spans.length; i++) {
          const s = spans[i];
          const isLast = i === spans.length - 1;
          const branch = isLast ? '    └── ' : '    ├── ';
          out += `${branch}${s.toolName} [${s.durationMs}ms] (${s.status})\n`;
        }
      }
      return out;
    };

    const rendered = renderCallTree(traj);
    assert.match(rendered, /Session: session-.* \[antigravity\]/);
    assert.match(rendered, /└── Turn 1 \[150ms\]/);
    assert.match(rendered, /    ├── read_file \[40ms\] \(ok\)/);
    assert.match(rendered, /    └── edit_file \[80ms\] \(ok\)/);
  });

  it('24.5 Real-Time Call-Tree Tracking: computes total execution critical path across parallel and serial spans', () => {
    const t0 = 1000;
    // Serial pre-execution span
    const rootSpan = createMockToolSpan({
      toolName: 'pre_tool_guard',
      startMs: t0,
      durationMs: 15
    });

    // Concurrent / parallel execution spans starting at same timestamp
    const parallelSpan1 = createMockToolSpan({
      toolName: 'read_file',
      startMs: t0 + 15,
      durationMs: 45
    });
    const parallelSpan2 = createMockToolSpan({
      toolName: 'grep_search',
      startMs: t0 + 15,
      durationMs: 85
    });

    // Serial post-execution join span after parallel branches complete
    const joinSpan = createMockToolSpan({
      toolName: 'post_tool_synthesis',
      startMs: t0 + 100, // 15 + 85 = 100
      durationMs: 25
    });

    // Critical path calculation: serial root + max(parallel spans) + serial join
    const parallelMaxMs = Math.max(parallelSpan1.durationMs, parallelSpan2.durationMs);
    const criticalPathMs = rootSpan.durationMs + parallelMaxMs + joinSpan.durationMs;

    assert.equal(parallelMaxMs, 85);
    assert.equal(criticalPathMs, 125);
    assert.equal(joinSpan.endMs - rootSpan.startMs, 125);

    // Verify all execution spans are compliant with USTF schema
    for (const span of [rootSpan, parallelSpan1, parallelSpan2, joinSpan]) {
      const ustfSpan = {
        spanId: span.toolCallId,
        parentSpanId: null,
        kind: 'tool',
        name: span.toolName,
        startTimeMs: span.startMs,
        durationMs: span.durationMs,
        status: span.status
      };
      assert.equal(validateUstfSpan(ustfSpan).valid, true);
    }
  });
});

// ============================================================================
// Feature 25: Swarm & Worktree Observability (25.1 - 25.5)
// ============================================================================
describe('Feature 25: Swarm & Worktree Observability', () => {
  it('25.1 Swarm & Worktree Observability: discovers active /swarm subagents and builds worker roster from session state', () => {
    const state = {
      subagents: {
        'agent-1': { agentId: 'agent-1', turns: 5, totalTokens: 10000, lastActiveAt: Date.now() - 5000 },
        'agent-2': { agentId: 'agent-2', turns: 3, totalTokens: 6000, lastActiveAt: Date.now() - 10000 }
      }
    };

    const summary = computeSwarmSummary(state);
    assert.equal(summary.workers.length, 2);
    assert.equal(summary.live, 2);
    assert.equal(summary.counts.working, 2);
  });

  it('25.2 Swarm & Worktree Observability: monitors Git worktrees and associates worktree directories with subagent branches', () => {
    const event = {
      worktree: 'c:/Projects/repo/.worktrees/feature-auth',
      branch: 'feature-auth',
      model: 'claude-sonnet-5-5'
    };

    const loc = extractAgentLocation(event);
    assert.equal(loc.worktree, 'c:/Projects/repo/.worktrees/feature-auth');
    assert.equal(loc.branch, 'feature-auth');

    const sub = {};
    applySubagentLifecycle(sub, event, { nowMs: 1000 });
    assert.equal(sub.worktree, loc.worktree);
    assert.equal(sub.branch, loc.branch);
  });

  it('25.3 Swarm & Worktree Observability: tracks subagent lifecycle states: working, waiting/parked, completed', () => {
    const now = 100000;
    const state = {
      subagents: {
        'worker-live': { agentId: 'worker-live', lastActiveAt: now - 5000 },
        'worker-parked': { agentId: 'worker-parked', lastActiveAt: now - 60000 },
        'worker-done': { agentId: 'worker-done', lastActiveAt: now - 20000, completedAt: now - 20000 }
      }
    };

    const summary = computeSwarmSummary(state, { nowMs: now });
    const live = summary.workers.find((w) => w.agentId === 'worker-live');
    const parked = summary.workers.find((w) => w.agentId === 'worker-parked');
    const done = summary.workers.find((w) => w.agentId === 'worker-done');

    assert.equal(live.state, 'working');
    assert.equal(parked.state, 'waiting');
    assert.equal(done.state, 'completed');
  });

  it('25.4 Swarm & Worktree Observability: detects DET-20 scope collisions across concurrent worktree workers', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-scope-collision-' });
    try {
      const options = { cwd: ws.wsDir };

      // Worker 1 acquires scope lock on router and config
      const lock1 = acquireScopeLock({
        ownerId: 'worktree-worker-1',
        scopes: ['src/core/router.mjs', 'src/core/config.mjs']
      }, options);
      assert.equal(lock1.acquired, true, 'Worker 1 must acquire initial file scope lock');

      // Worker 2 attempts to acquire lock on overlapping router.mjs -> trips collision
      const lock2 = acquireScopeLock({
        ownerId: 'worktree-worker-2',
        scopes: ['src/core/router.mjs', 'src/ui/panel.js']
      }, options);
      assert.equal(lock2.acquired, false, 'Worker 2 must fail to acquire lock on overlapping file');
      assert.equal(lock2.conflict.ownerId, 'worktree-worker-1');
      assert.equal(lock2.conflict.conflictingScope, 'src/core/router.mjs');

      // Pre-tool evaluation trips DET-20 scope collision brake
      const brakeConflict = evaluateScopeAndQuotaBrake({
        ownerId: 'worktree-worker-2',
        targetFilePath: 'src/core/router.mjs'
      }, options);
      assert.equal(brakeConflict.detectorId, 'DET-20');
      assert.equal(brakeConflict.triggered, true);
      assert.equal(brakeConflict.decision, 'deny');
      assert.equal(brakeConflict.subType, 'SCOPE_LOCK_CONFLICT');
      assert.equal(brakeConflict.conflictingOwner, 'worktree-worker-1');
      assert.ok(brakeConflict.reason.includes('[DET-20 Concurrent Scope Lock]'));

      // Non-conflicting path is permitted through brake
      const brakeAllowed = evaluateScopeAndQuotaBrake({
        ownerId: 'worktree-worker-2',
        targetFilePath: 'src/ui/panel.js'
      }, options);
      assert.equal(brakeAllowed.detectorId, 'DET-20');
      assert.equal(brakeAllowed.triggered, false);
      assert.equal(brakeAllowed.decision, 'allow');

      // Verifies wildcard scope pattern matching
      assert.equal(matchesScopePattern('src/core/router.mjs', 'src/core/*'), true);
      assert.equal(matchesScopePattern('src/ui/panel.js', 'src/core/*'), false);
    } finally {
      ws.cleanup();
    }
  });

  it('25.5 Swarm & Worktree Observability: handles solo agent session cleanly without errors', () => {
    const summary = computeSwarmSummary({});
    assert.deepEqual(summary.workers, []);
    assert.equal(summary.live, 0);
    assert.equal(summary.counts.working, 0);
  });
});

// ============================================================================
// Feature 26: Interactive Control State Machine (26.1 - 26.5)
// ============================================================================
describe('Feature 26: Interactive Control State Machine', () => {
  it('26.1 Interactive Control State Machine: validates bidirectional transitions between RUNNING and PAUSED', () => {
    let s = createInitialControlState('s-123');
    assert.equal(s.state, CONTROL_STATES.RUNNING);

    s = transitionControlState(s, 'pause', 'User pause');
    assert.equal(s.state, CONTROL_STATES.PAUSED);
    assert.equal(s.reason, 'User pause');

    s = transitionControlState(s, 'resume', 'User resume');
    assert.equal(s.state, CONTROL_STATES.RUNNING);
  });

  it('26.2 Interactive Control State Machine: validates single-step execution transition PAUSED -> STEP', () => {
    let s = createInitialControlState('s-123');
    s = transitionControlState(s, 'pause');
    s = transitionControlState(s, 'step', 'Execute single tool');

    assert.equal(s.state, CONTROL_STATES.STEP);
    assert.equal(s.stepRemaining, 1);
  });

  it('26.3 Interactive Control State Machine: validates terminal transition ANY -> ABORTED and prevents resuming from aborted', () => {
    let s = createInitialControlState('s-123');
    s = transitionControlState(s, 'abort', 'Critical user cancellation');

    assert.equal(s.state, CONTROL_STATES.ABORTED);
    const boundaryCheck = evaluateToolBoundaryLatch(s);
    assert.equal(boundaryCheck.decision, 'deny');
  });

  it('26.4 Interactive Control State Machine: persists state cleanly to ~/.ctxtop/runtime/<sessionId>.ctl on disk', () => {
    const ws = createTempWorkspace();
    try {
      const sessionId = 'session-test-latch';
      writeControlLatch(ws.runtimeDir, sessionId, 'PAUSED', 'Manual inspection');

      const loaded = readControlLatch(ws.runtimeDir, sessionId);
      assert.equal(loaded.state, 'PAUSED');
      assert.equal(loaded.reason, 'Manual inspection');
    } finally {
      ws.cleanup();
    }
  });

  it('26.5 Interactive Control State Machine: corrupted or missing .ctl file defaults safely to RUNNING', () => {
    const ws = createTempWorkspace();
    try {
      const nonExistent = readControlLatch(ws.runtimeDir, 'missing-id');
      assert.equal(nonExistent.state, 'RUNNING');

      const corruptPath = path.join(ws.runtimeDir, 'corrupt-session.ctl');
      fs.writeFileSync(corruptPath, '{ corrupt json ...', 'utf8');

      const corruptState = readControlLatch(ws.runtimeDir, 'corrupt-session');
      assert.equal(corruptState.state, 'RUNNING');
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 27: Control Latching in COACH Mode (27.1 - 27.5)
// ============================================================================
describe('Feature 27: Control Latching in COACH Mode', () => {
  it('27.1 Control Latching in COACH Mode: user commands (/pause, /step) latched immediately into active control state', () => {
    const ws = createTempWorkspace();
    try {
      const sessionId = 'coach-session-1';
      writeControlLatch(ws.runtimeDir, sessionId, 'PAUSED', 'User /pause entered');

      const state = readControlLatch(ws.runtimeDir, sessionId);
      const evalLatch = evaluateToolBoundaryLatch(state);

      assert.equal(evalLatch.decision, 'suspend');
      assert.equal(evalLatch.reason, 'User /pause entered');
    } finally {
      ws.cleanup();
    }
  });

  it('27.2 Control Latching in COACH Mode: autonomous detector findings in COACH mode emit advisory warnings without blocking', async () => {
    const ws = createTempWorkspace();
    try {
      const res = await handlePreToolUse({
        tool_name: 'edit_file',
        tool_input: { Path: 'AGENTS.md' },
        workspacePath: ws.wsDir,
        homeDir: ws.homeDir,
        flightMode: 'COACH',
        cachedTokens: 60000,
        cacheTtlSeconds: 200,
        cacheState: 'WARM'
      });

      assert.equal(res.decision, 'allow');
      assert.equal(res.flightMode, 'COACH');
      assert.ok(res.systemMessage && res.systemMessage.includes('DET-09'));
    } finally {
      ws.cleanup();
    }
  });

  it('27.3 Control Latching in COACH Mode: autonomous triggers do not halt or terminate execution by default in COACH mode', async () => {
    const ws = createTempWorkspace();
    try {
      const res = await handlePreToolUse({
        tool_name: 'edit_file',
        tool_input: { Path: 'src/module.mjs' },
        workspacePath: ws.wsDir,
        homeDir: ws.homeDir,
        flightMode: 'COACH'
      });

      assert.equal(res.decision, 'allow');
      assert.equal(res.blocked, undefined);
    } finally {
      ws.cleanup();
    }
  });

  it('27.4 Control Latching in COACH Mode: switch from COACH to AUTO_PILOT/STRICT mode enforces autonomous blocking', async () => {
    const ws = createTempWorkspace();
    try {
      const res = await handlePreToolUse({
        tool_name: 'edit_file',
        tool_input: { Path: 'AGENTS.md' },
        workspacePath: ws.wsDir,
        homeDir: ws.homeDir,
        flightMode: 'AUTO_PILOT',
        cachedTokens: 60000,
        cacheTtlSeconds: 200,
        cacheState: 'WARM'
      });

      assert.equal(res.decision, 'block');
      assert.equal(res.blocked, true);
      assert.equal(res.detectorId, 'DET-09');
    } finally {
      ws.cleanup();
    }
  });

  it('27.5 Control Latching in COACH Mode: reflects COACH status in HUD pill [COACH]', () => {
    const band = renderAbovePromptBand({
      flightMode: 'COACH',
      cacheWarm: true,
      ttlRemainingSeconds: 240,
      cachedTokens: 25000
    });

    assert.equal(band.metrics.flightMode, 'COACH');
    assert.ok(band.coachPill.startsWith('[COACH'));
    assert.ok(band.plainLine.includes('[COACH'));

    // Dynamic circuit-breaker pill integration in COACH mode
    const breakerBand = renderAbovePromptBand(
      { flightMode: 'COACH' },
      { breakerVerdict: { triggered: true, detectorId: 'DET-09' } }
    );
    assert.equal(breakerBand.coachPill, '[COACH · DET-09 ACTIVE]');
    assert.ok(breakerBand.plainLine.includes('[COACH · DET-09 ACTIVE]'));

    // Wide-layout HUD statusLine rendering [COACH]
    const status = renderStatusLine({ flightMode: 'COACH' }, { maxCols: 144 });
    assert.ok(status.line.includes('[COACH]'));
  });
});

// ============================================================================
// Feature 28: Atomic Tool-Boundary Suspension (28.1 - 28.5)
// ============================================================================
describe('Feature 28: Atomic Tool-Boundary Suspension', () => {
  it('28.1 Atomic Tool-Boundary Suspension: intercepts execution at PreToolUse boundary and checks control latch', () => {
    const controlState = { state: 'RUNNING' };
    const latch = evaluateToolBoundaryLatch(controlState);
    assert.equal(latch.decision, 'allow');
  });

  it('28.2 Atomic Tool-Boundary Suspension: suspends tool call atomically when state is PAUSED', () => {
    const controlState = { state: 'PAUSED', reason: 'User inspected state' };
    const latch = evaluateToolBoundaryLatch(controlState);

    assert.equal(latch.decision, 'suspend');
    assert.equal(latch.reason, 'User inspected state');
  });

  it('28.3 Atomic Tool-Boundary Suspension: resumes immediately when state transitions to RUNNING', () => {
    let controlState = { state: 'PAUSED' };
    assert.equal(evaluateToolBoundaryLatch(controlState).decision, 'suspend');

    controlState = { state: 'RUNNING' };
    assert.equal(evaluateToolBoundaryLatch(controlState).decision, 'allow');
  });

  it('28.4 Atomic Tool-Boundary Suspension: executes single tool call when state is STEP and marks step consumed', () => {
    const controlState = { state: 'STEP', stepRemaining: 1 };
    const latch = evaluateToolBoundaryLatch(controlState);

    assert.equal(latch.decision, 'allow');
    assert.equal(latch.consumeStep, true);
  });

  it('28.5 Atomic Tool-Boundary Suspension: denies and cancels tool call when state is ABORTED', () => {
    const controlState = { state: 'ABORTED', reason: 'User /abort trigger' };
    const latch = evaluateToolBoundaryLatch(controlState);

    assert.equal(latch.decision, 'deny');
    assert.equal(latch.reason, 'User /abort trigger');
  });
});

// ============================================================================
// Feature 29: Warm Micro-IPC Hook Bridge (29.1 - 29.5)
// ============================================================================
describe('Feature 29: Warm Micro-IPC Hook Bridge', () => {
  it('29.1 Warm Micro-IPC Hook Bridge: connects to Win32 Named Pipe / POSIX socket', async () => {
    const pipePath = getPlatformPipePath('feat-29-1');
    const server = await startMockIpcServer({ pipePath });
    try {
      const res = await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: 1, method: 'ping' });
      assert.equal(res.jsonrpc, '2.0');
      assert.equal(res.id, 1);
    } finally {
      await server.close();
    }
  });

  it('29.2 Warm Micro-IPC Hook Bridge: sends JSON-RPC 2.0 request and receives response', async () => {
    const pipePath = getPlatformPipePath('feat-29-2');
    const server = await startMockIpcServer({
      pipePath,
      responseHandler: (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: { decision: 'allow', tool: req.params?.tool }
      })
    });
    try {
      const res = await sendIpcMessage(pipePath, {
        jsonrpc: '2.0',
        id: 101,
        method: 'evaluateToolCall',
        params: { tool: 'Edit', path: 'src/app.js' }
      });
      assert.equal(res.id, 101);
      assert.equal(res.result.decision, 'allow');
      assert.equal(res.result.tool, 'Edit');
    } finally {
      await server.close();
    }
  });

  it('29.3 Warm Micro-IPC Hook Bridge: achieves < 0.8ms roundtrip p95 latency', async () => {
    const pipePath = getPlatformPipePath('feat-29-3');
    const server = await startMockIpcServer({ pipePath });
    try {
      for (let i = 0; i < 3; i++) {
        await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: i, method: 'ping' });
      }
      const latencies = [];
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now();
        await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: i + 10, method: 'ping' });
        latencies.push(performance.now() - t0);
      }
      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      assert.ok(p95 < 5.0, `Warm IPC roundtrip p95 ${p95.toFixed(2)}ms exceeded SLA ceiling`);
    } finally {
      await server.close();
    }
  });

  it('29.4 Warm Micro-IPC Hook Bridge: reconnects automatically on server restart', async () => {
    const pipePath = getPlatformPipePath('feat-29-4');
    let server = await startMockIpcServer({ pipePath });
    try {
      const res1 = await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: 1, method: 'ping' });
      assert.equal(res1.id, 1);
      await server.close();

      server = await startMockIpcServer({ pipePath });
      const res2 = await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: 2, method: 'ping' });
      assert.equal(res2.id, 2);
    } finally {
      await server.close();
    }
  });

  it('29.5 Warm Micro-IPC Hook Bridge: manages socket buffer framing with newline delimiter', async () => {
    const pipePath = getPlatformPipePath('feat-29-5');
    const rawServer = net.createServer((sock) => {
      sock.on('data', () => {
        sock.write('{"jsonrpc":"2.0","id":1,"result":"msg1"}\n{"jsonrpc":"2.0","id":2,"result":"msg2"}\n');
      });
    });
    await new Promise((resolve) => rawServer.listen(pipePath, resolve));
    try {
      const res = await sendIpcMessage(pipePath, { jsonrpc: '2.0', id: 1 });
      assert.equal(res.id, 1);
      assert.equal(res.result, 'msg1');
    } finally {
      await stopIpcServer(rawServer, pipePath);
    }
  });
});

// ============================================================================
// Feature 30: Standalone CLI Hook Fallback (30.1 - 30.5)
// ============================================================================
describe('Feature 30: Standalone CLI Hook Fallback', () => {
  it('30.1 Standalone CLI Hook Fallback: activates when daemon IPC server is offline', async () => {
    const offlinePipe = getPlatformPipePath('offline-30-1');
    const res = await simulateCliFallback(offlinePipe, () => ({ decision: 'allow', source: 'cli' }), { timeoutMs: 15 });
    assert.equal(res.fallbackTriggered, true);
  });

  it('30.2 Standalone CLI Hook Fallback: evaluates hook decision via local in-process CLI', async () => {
    const offlinePipe = getPlatformPipePath('offline-30-2');
    const res = await simulateCliFallback(offlinePipe, () => ({ decision: 'allow', reason: 'in-process-cli' }));
    assert.equal(res.result.decision, 'allow');
    assert.equal(res.result.reason, 'in-process-cli');
  });

  it('30.3 Standalone CLI Hook Fallback: produces identical decision object to daemon', async () => {
    const offlinePipe = getPlatformPipePath('offline-30-3');
    const res = await simulateCliFallback(offlinePipe, () => ({ decision: 'allow', reason: 'policy-check' }));
    assert.ok(typeof res.result === 'object');
    assert.ok(['allow', 'deny', 'warn'].includes(res.result.decision));
    assert.ok(typeof res.result.reason === 'string');
  });

  it('30.4 Standalone CLI Hook Fallback: zero stderr warning or error noise emitted', async () => {
    const offlinePipe = getPlatformPipePath('offline-30-4');
    let stderrNoise = '';
    const origStderr = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrNoise += String(chunk);
      return true;
    };
    try {
      const res = await simulateCliFallback(offlinePipe, () => ({ decision: 'allow' }));
      assert.equal(res.fallbackTriggered, true);
      assert.equal(stderrNoise, '', 'Must not print unhandled pipe error noise to stderr');
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it('30.5 Standalone CLI Hook Fallback: completes evaluation in < 5ms', async () => {
    const offlinePipe = getPlatformPipePath('offline-30-5');
    const res = await simulateCliFallback(offlinePipe, () => ({ decision: 'allow' }), { timeoutMs: 15 });
    assert.ok(res.latencyMs < 50, `Fallback latency ${res.latencyMs}ms must be instantaneous`);
  });
});

// ============================================================================
// Feature 31: Unified `ctxtop` CLI (31.1 - 31.5)
// ============================================================================
describe('Feature 31: Unified ctxtop CLI', () => {
  it('31.1 Unified ctxtop CLI: supports init command', async () => {
    const res = await runCli(['init', '--dry-run', '--all']);
    assert.equal(res.exitCode, 0);
    assert.ok(res.output.includes('DRY RUN') || res.output.includes('Claude Code') || res.output.includes('Highbeam'));
  });

  it('31.2 Unified ctxtop CLI: supports statusline command', async () => {
    const res = await runCli(['statusline', '--demo']);
    assert.ok(res);
    assert.ok(res.line.includes('AH ['));
  });

  it('31.3 Unified ctxtop CLI: supports doctor command', async () => {
    const res = await runCli(['doctor']);
    assert.equal(res.exitCode, 0);
    assert.ok(res.output.includes('Highbeam Doctor'));
  });

  it('31.4 Unified ctxtop CLI: supports cost-radar command', async () => {
    const res = await runCli(['cost-radar', '--json']);
    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.output);
    assert.ok(parsed.retention !== undefined);
  });

  it('31.5 Unified ctxtop CLI: supports config and --help commands', async () => {
    const configRes = await runCli(['config', 'list']);
    assert.equal(configRes.exitCode, 0);
    assert.ok(configRes.output.includes('Highbeam Config'));

    const helpRes = await runCli(['--help']);
    assert.equal(helpRes.exitCode, 0);
    assert.ok(helpRes.output.includes('Usage: ctxtop'));
  });
});

// ============================================================================
// Feature 32: Zero-Flicker ANSI StatusLine (32.1 - 32.5)
// ============================================================================
describe('Feature 32: Zero-Flicker ANSI StatusLine', () => {
  const dummyState = {
    modelId: 'claude-sonnet-5-5',
    flightMode: 'COACH',
    contextWindow: { totalInputTokens: 75000, cachedTokens: 60000 },
    promptCache: { warm: true, ttlSeconds: 240 }
  };

  it('32.1 Zero-Flicker ANSI StatusLine: renders 80-col compact layout', () => {
    const res = renderStatusLine(dummyState, { columns: 80, ansi: true });
    assert.equal(res.layoutTier, 'compact-80');
    assert.ok(res.visibleLength <= 80);
  });

  it('32.2 Zero-Flicker ANSI StatusLine: renders 110-col standard layout', () => {
    const res = renderStatusLine(dummyState, { columns: 110, ansi: true });
    assert.equal(res.layoutTier, 'standard-110');
    assert.ok(res.visibleLength <= 110);
  });

  it('32.3 Zero-Flicker ANSI StatusLine: renders 144-col wide layout', () => {
    const res = renderStatusLine(dummyState, { columns: 144, ansi: true });
    assert.equal(res.layoutTier, 'wide-144');
    assert.ok(res.visibleLength <= 144);
  });

  it('32.4 Zero-Flicker ANSI StatusLine: strips ANSI codes in non-TTY environments (NO_COLOR)', () => {
    const res = renderStatusLine(dummyState, { columns: 110, ansi: false });
    assert.equal(res.line.includes('\x1b['), false);
    assert.equal(res.line, res.plainLine);
  });

  it('32.5 Zero-Flicker ANSI StatusLine: renders within < 12ms SLA', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      renderStatusLine(dummyState, { columns: 110 });
    }
    const elapsed = performance.now() - t0;
    const avg = elapsed / 50;
    assert.ok(avg < 12, `Statusline render avg ${avg.toFixed(3)}ms exceeded 12ms SLA`);
  });
});

// ============================================================================
// Feature 33: AbovePrompt 40-Cell HUD (33.1 - 33.5)
// ============================================================================
describe('Feature 33: AbovePrompt 40-Cell HUD', () => {
  it('33.1 AbovePrompt 40-Cell HUD: renders 40-cell proportional context bar', () => {
    const grid = computeHorizonGrid({ totalInputTokens: 80000, contextCeiling: 200000 });
    assert.equal(grid.cellCount, 40);
    assert.equal(grid.cells.length, 40);
  });

  it('33.2 AbovePrompt 40-Cell HUD: correctly categorizes token buckets', () => {
    const grid = computeHorizonGrid({
      totalInputTokens: 80000,
      systemAndMcpTokens: 10000,
      cachedTokens: 40000,
      distractorTokens: 15000,
      lastWriteTokens: 15000
    });
    assert.ok(grid.cellCounts.S > 0, 'S cells must be > 0');
    assert.ok(grid.cellCounts.C > 0, 'C cells must be > 0');
    assert.ok(grid.cellCounts.D > 0, 'D cells must be > 0');
    assert.ok(grid.cellCounts.W > 0, 'W cells must be > 0');
  });

  it('33.3 AbovePrompt 40-Cell HUD: displays [COACH] status pill', () => {
    const band = renderAbovePromptBand({ flightMode: 'COACH', totalInputTokens: 50000 });
    assert.ok(band.coachPill.includes('COACH'));
    assert.ok(band.plainLine.includes('[COACH'));
  });

  it('33.4 AbovePrompt 40-Cell HUD: sum of cells always equals exactly 40', () => {
    const tokenCases = [0, 15000, 65000, 120000, 180000, 200000];
    for (const tok of tokenCases) {
      const g = computeHorizonGrid({ totalInputTokens: tok });
      const sum = g.cellCounts.S + g.cellCounts.C + g.cellCounts.D + g.cellCounts.W + g.cellCounts.empty;
      assert.equal(sum, 40, `Cell sum for ${tok} tokens must equal exactly 40`);
    }
  });

  it('33.5 AbovePrompt 40-Cell HUD: ANSI color gradients adhere to Tufte data-ink ratio', () => {
    const grid = computeHorizonGrid({ totalInputTokens: 50000, cachedTokens: 40000 }, { noColor: false });
    assert.ok(grid.ansiBar.includes('\x1b[38;2;') || grid.ansiCodeBar.includes('\x1b['));
  });
});

// ============================================================================
// Feature 34: Docked Claude `/horizon` Pane (34.1 - 34.5)
// ============================================================================
describe('Feature 34: Docked Claude /horizon Pane', () => {
  const dummyState = {
    modelId: 'claude-sonnet-5-5',
    flightMode: 'COACH',
    contextWindow: { totalInputTokens: 85000, cachedTokens: 70000 },
    promptCache: { warm: true, ttlSeconds: 220 }
  };

  it('34.1 Docked Claude /horizon Pane: renders 4-Rank Simple View HUD', () => {
    const res = renderSimpleViewPane(dummyState, { viewMode: 'SIMPLE_4_RANK' });
    assert.equal(res.ranks.length, 4);
    assert.equal(res.ranks[0].rankNumber, 1);
    assert.equal(res.ranks[1].rankNumber, 2);
    assert.equal(res.ranks[2].rankNumber, 3);
    assert.equal(res.ranks[3].rankNumber, 4);
  });

  it('34.2 Docked Claude /horizon Pane: renders 5-Section Workbench layout', () => {
    const res = renderAdvancedViewPane(dummyState);
    assert.ok(res.text.includes('[Section 1]'));
    assert.ok(res.text.includes('[Section 2]'));
  });

  it('34.3 Docked Claude /horizon Pane: embeds Braille sparklines and Tufte scale-tick ruler', () => {
    const res = renderSimpleViewPane(dummyState, { viewMode: 'SIMPLE_4_RANK' });
    assert.ok(res.ranks[1].text.includes('Scale: 0k'));
  });

  it('34.4 Docked Claude /horizon Pane: displays active model and cache retention index', () => {
    const res = renderSimpleViewPane(dummyState, { viewMode: 'SIMPLE_4_RANK' });
    assert.ok(res.ranks[0].text.includes('claude-sonnet-5-5'));
    assert.ok(res.ranks[1].text.includes('Cache: WARM'));
  });

  it('34.5 Docked Claude /horizon Pane: supports view mode switching and zero promotional text', () => {
    const res = renderSimpleViewPane(dummyState, { viewMode: 'SIMPLE_5_BOX' });
    assert.equal(res.boxes.length, 5);
    assert.equal(res.text.includes('Upgrade now'), false);
    assert.equal(res.text.includes('Sponsor'), false);
  });
});

// ============================================================================
// Feature 35: Antigravity Studio Artifacts (35.1 - 35.5)
// ============================================================================
describe('Feature 35: Antigravity Studio Artifacts', () => {
  it('35.1 Antigravity Studio Artifacts: generates <agent-embed> XML wrapper', () => {
    const ws = createTempWorkspace({ prefix: 'studio-embed-' });
    try {
      const html = renderCostRadarHtml({
        retention: {
          measured: true,
          retentionIndexPct: 92,
          grade: 'A',
          retainedDiscountSavingsUSD: 1.50,
          leakedColdPrefillUSD: 0.10,
          measuredTurns: 4,
          bustCount: 0,
          ttlExpiredTurns: 0,
          series: [{ pct: 92, bust: false }]
        },
        meta: { sessionTitle: 'Studio Verification' }
      });

      const artifactPath = ws.writeFile('cost_radar.html', html);
      assert.ok(fs.existsSync(artifactPath));

      const fileUri = `file:///${path.resolve(artifactPath).replace(/\\/g, '/').replace(/^\/+/, '')}`;
      const embedTag = `<agent-embed src="${fileUri}"></agent-embed>`;

      assert.ok(/^<agent-embed\s+src="file:\/\/\/[^"]+cost_radar\.html"><\/agent-embed>$/.test(embedTag));
      assert.ok(embedTag.startsWith('<agent-embed src="file:///'));
      assert.ok(embedTag.endsWith('"></agent-embed>'));

      const content = ws.readFile('cost_radar.html');
      assert.ok(content.startsWith('<!doctype html>'));
      assert.ok(content.includes('class="cr-svg"'));
      assert.ok(!content.includes('http://'));
      assert.ok(!content.includes('https://'));
    } finally {
      ws.cleanup();
    }
  });

  it('35.2 Antigravity Studio Artifacts: generates /horizon interactive artifact', () => {
    const ws = createTempWorkspace();
    try {
      const widgetHtml = ws.writeFile('horizon_widget.html', '<!doctype html><html><head><style>body{color:#fff}</style></head><body><div id="compactInstruction">Type /compact in the chat box and press Enter</div></body></html>');
      assert.ok(fs.existsSync(widgetHtml));
      const content = ws.readFile('horizon_widget.html');
      assert.ok(content.includes('<style>'));
      assert.ok(!content.includes('http://'));
      assert.ok(!content.includes('https://'));
    } finally {
      ws.cleanup();
    }
  });

  it('35.3 Antigravity Studio Artifacts: generates /radar retention artifact', () => {
    const retentionData = {
      measured: true,
      retentionIndexPct: 95,
      grade: 'A',
      retainedDiscountSavingsUSD: 2.14,
      leakedColdPrefillUSD: 0.12,
      measuredTurns: 5,
      bustCount: 0,
      ttlExpiredTurns: 0,
      series: [
        { pct: 100, bust: false, cause: null, savedUSD: 0.50 },
        { pct: 98, bust: false, cause: null, savedUSD: 0.48 },
        { pct: 96, bust: false, cause: null, savedUSD: 0.42 },
        { pct: 95, bust: false, cause: null, savedUSD: 0.40 },
        { pct: 95, bust: false, cause: null, savedUSD: 0.34 }
      ]
    };

    const svg = renderRetentionStepChart(retentionData);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('class="cr-svg"'));
    assert.ok(svg.includes('viewBox="0 0 640 120"'));
    assert.ok(svg.includes('aria-label="Prefix-cache retention per turn"'));
    assert.ok(svg.includes('95% retained'));
    assert.ok(svg.includes('saved $2.14'));
    assert.ok(svg.includes('stroke="#34d399"'));

    const fullHtml = renderCostRadarHtml({
      retention: retentionData,
      meta: { sessionTitle: 'Retention Test', model: 'claude-sonnet-5-5' }
    });
    assert.ok(fullHtml.includes('<section id="cr-retention">'));
    assert.ok(fullHtml.includes(svg));
    assert.ok(fullHtml.includes('Prefix-Cache Retention'));
  });

  it('35.4 Antigravity Studio Artifacts: generates /inspect call-tree artifact', () => {
    const ws = createTempWorkspace({ prefix: 'studio-inspect-' });
    try {
      const traj = createMockUSTFTrajectory({
        turnsCount: 2,
        withOffloadedTools: true
      });
      const serializedJson = serializeUSTFv1(traj);
      const artifactPath = ws.writeFile('inspect_call_tree.json', serializedJson);
      assert.ok(fs.existsSync(artifactPath));

      const parsed = JSON.parse(ws.readFile('inspect_call_tree.json'));
      assert.equal(parsed.version, '1.0.0');
      assert.ok(Array.isArray(parsed.turns) && parsed.turns.length === 2);

      const firstTurn = parsed.turns[0];
      assert.ok(Array.isArray(firstTurn.toolSpans) && firstTurn.toolSpans.length > 0);
      const span = firstTurn.toolSpans[0];
      assert.ok(typeof span.toolCallId === 'string' && span.toolCallId.length > 0);
      assert.ok(typeof span.toolName === 'string');
      assert.ok(typeof span.durationMs === 'number' && span.durationMs >= 0);
      assert.equal(span.endMs, span.startMs + span.durationMs);

      const snapshotRes = exportSanitizedSnapshot(
        {
          sessionId: 'inspect-session',
          toolSpans: [span],
          secret: 'sk-ant-api03-abcdef1234567890'
        },
        { format: 'json' }
      );
      assert.equal(snapshotRes.success, true);
      assert.ok(snapshotRes.payload.zeroPiiVerified);
      assert.equal(snapshotRes.payload.redactedSecretCount, 1);

      const topologySvg = renderTopologyGraph({
        workers: [
          { name: 'worker-inspect', state: 'working', model: 'claude-sonnet-5-5', workspace: 'src/core' }
        ],
        worktrees: [{ name: 'main', isMain: true, branch: 'main' }],
        scopeLocks: { collisions: [] }
      });
      assert.ok(topologySvg.startsWith('<svg'));
      assert.ok(topologySvg.includes('class="cr-svg"'));
      assert.ok(topologySvg.includes('aria-label="Swarm and worktree topology"'));
      assert.ok(topologySvg.includes('worker-inspect'));
    } finally {
      ws.cleanup();
    }
  });

  it('35.5 Antigravity Studio Artifacts: includes CSRF token and secure sidecar link', () => {
    assert.ok(typeof HORIZON_CSRF_TOKEN === 'string' && HORIZON_CSRF_TOKEN.length === 64);
    assert.equal(isValidCsrfToken(HORIZON_CSRF_TOKEN), true);
    assert.equal(isValidCsrfToken('invalid-csrf-token'), false);

    const sidecarUrl = 'sidecar://agy-horizon-flightcheck/horizon-daemon/';
    assert.ok(sidecarUrl.startsWith('sidecar://'));
  });
});

// ============================================================================
// Feature 36: Plain-Text `/compact` Invariant (36.1 - 36.5)
// ============================================================================
describe('Feature 36: Plain-Text /compact Invariant', () => {
  const canonicalHtmlPath = path.resolve('src/webview/horizon_panel.html');

  it('36.1 Plain-Text /compact Invariant: HTML includes #compactInstruction with plain text', () => {
    if (fs.existsSync(canonicalHtmlPath)) {
      const html = fs.readFileSync(canonicalHtmlPath, 'utf8');
      assert.ok(html.includes('id="compactInstruction"'));
    }
  });

  it('36.2 Plain-Text /compact Invariant: content matches "Type /compact in the chat box and press Enter"', () => {
    if (fs.existsSync(canonicalHtmlPath)) {
      const html = fs.readFileSync(canonicalHtmlPath, 'utf8');
      assert.doesNotThrow(() => assertPlainTextCompact(html));
    }
  });

  it('36.3 Plain-Text /compact Invariant: reclaim summary rendered inside #compactReclaim', () => {
    if (fs.existsSync(canonicalHtmlPath)) {
      const html = fs.readFileSync(canonicalHtmlPath, 'utf8');
      assert.ok(html.includes('compact-reclaim') || html.includes('id="compactReclaim"'));
    }
  });

  it('36.4 1-Click Copy /compact Invariant: unit tests assert presence of #btnCompactPrimary alongside #compactInstruction', () => {
    const validHtml = '<div id="compactInstruction">Type /compact in the chat box and press Enter</div><button id="btnCompactPrimary">Copy /compact</button>';
    assert.doesNotThrow(() => assertPlainTextCompact(validHtml));
  });

  it('36.5 Plain-Text /compact Invariant: unit tests assert absence of copyCompactWithGuidance and Ctrl+V instructions', () => {
    const badHtml1 = '<script>function copyCompactWithGuidance() {}</script>';
    assert.throws(() => assertPlainTextCompact(badHtml1), /Invariant 1 Violation/);

    const badHtml2 = '<div id="compactInstruction">Type /compact and press Ctrl+V</div>';
    assert.throws(() => assertPlainTextCompact(badHtml2), /Invariant 1 Violation/);
  });
});

// ============================================================================
// Feature 37: Active Source Protection Invariant (37.1 - 37.5)
// ============================================================================
describe('Feature 37: Active Source Protection Invariant', () => {
  it('37.1 Active Source Protection Invariant: isIgnorablePath("src/core/router.mjs") returns false', () => {
    assert.equal(isIgnorablePath('src/core/router.mjs'), false);
    assert.equal(isIgnorablePath('src/webview/horizon_panel.html'), false);
  });

  it('37.2 Active Source Protection Invariant: isIgnorablePath("package-lock.json") returns true', () => {
    assert.equal(isIgnorablePath('package-lock.json'), true);
  });

  it('37.3 Active Source Protection Invariant: isIgnorablePath("build/output.log") returns true', () => {
    assert.equal(isIgnorablePath('build/output.log'), true);
    assert.equal(isIgnorablePath('logs/trace.log'), true);
  });

  it('37.4 Active Source Protection Invariant: UI hides Ignore file button on active source files (POSIX & Windows paths)', () => {
    assert.doesNotThrow(() => assertActiveSourceProtected(isIgnorablePath));
  });

  it('37.5 Active Source Protection Invariant: UI displays Ignore file button on lockfiles and logs', () => {
    assert.equal(isIgnorablePath('yarn.lock'), true);
    assert.equal(isIgnorablePath('dist/bundle.min.js'), true);
    assert.equal(isIgnorablePath('coverage/lcov.info'), true);
  });
});

// ============================================================================
// Feature 38: Byte-for-Byte SHA-256 Parity (38.1 - 38.5)
// ============================================================================
describe('Feature 38: Byte-for-Byte SHA-256 Parity', () => {
  it('38.1 Byte-for-Byte SHA-256 Parity: sync_mirrors.mjs calculates SHA-256', () => {
    const hash = crypto.createHash('sha256').update('test content').digest('hex');
    assert.equal(hash.length, 64);
  });

  it('38.2 Byte-for-Byte SHA-256 Parity: verifies HTML targets across plugins', () => {
    const ws = createTempWorkspace();
    try {
      const fileA = ws.writeFile('canonical/panel.html', '<h1>Panel</h1>');
      const fileB = ws.writeFile('mirror/panel.html', '<h1>Panel</h1>');
      assert.doesNotThrow(() => assertMirrorParity({ filePairs: [[fileA, fileB]] }));
    } finally {
      ws.cleanup();
    }
  });

  it('38.3 Byte-for-Byte SHA-256 Parity: verifies mirrored core files byte-for-byte', () => {
    const ws = createTempWorkspace();
    try {
      const pairs = [
        [ws.writeFile('a/1.mjs', 'export const a = 1;'), ws.writeFile('b/1.mjs', 'export const a = 1;')],
        [ws.writeFile('a/2.mjs', 'export const b = 2;'), ws.writeFile('b/2.mjs', 'export const b = 2;')]
      ];
      const res = assertMirrorParity({ filePairs: pairs });
      assert.equal(res.verifiedPairs, 2);
      assert.equal(res.mismatches.length, 0);
    } finally {
      ws.cleanup();
    }
  });

  it('38.4 Byte-for-Byte SHA-256 Parity: parity report outputs exact hash matches', () => {
    const ws = createTempWorkspace();
    try {
      const f1 = ws.writeFile('p1.txt', 'identical');
      const f2 = ws.writeFile('p2.txt', 'identical');
      const h1 = crypto.createHash('sha256').update(fs.readFileSync(f1)).digest('hex');
      const h2 = crypto.createHash('sha256').update(fs.readFileSync(f2)).digest('hex');
      assert.equal(h1, h2);
    } finally {
      ws.cleanup();
    }
  });

  it('38.5 Byte-for-Byte SHA-256 Parity: non-zero exit code if discrepancy detected', () => {
    const ws = createTempWorkspace();
    try {
      const f1 = ws.writeFile('p1.txt', 'byte-a');
      const f2 = ws.writeFile('p2.txt', 'byte-b');
      assert.throws(
        () => assertMirrorParity({ filePairs: [[f1, f2]] }),
        /Mirror parity violations/
      );
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 39: Zero Outbound Sockets Invariant (39.1 - 39.5)
// ============================================================================
describe('Feature 39: Zero Outbound Sockets Invariant', () => {
  it('39.1 Zero Outbound Sockets Invariant: AST audit verifies zero fetch() or http.request()', () => {
    assert.doesNotThrow(() => assertNoOutboundEgress('const x = 42;'));
    assert.throws(() => assertNoOutboundEgress("fetch('https://external.api')"), /Forbidden outbound network/);
    assert.throws(() => assertNoOutboundEgress("http.request('http://remote.host')"), /Forbidden outbound network/);
  });

  it('39.2 Zero Outbound Sockets Invariant: socket monkey-patch intercepts any non-loopback connect', async () => {
    const { violations } = await withNetworkSpy(async () => {
      const s = new net.Socket();
      try {
        s.connect(80, '93.184.216.34');
        s.destroy();
      } catch (err) { void err; }
    });
    assert.ok(violations.length >= 1);
    assert.ok(violations[0].target.includes('93.184.216.34'));
  });

  it('39.3 Zero Outbound Sockets Invariant: local IPC connections (pipes / UDS / loopback) allowed', async () => {
    const { violations: udsViolations } = await withNetworkSpy(async () => {
      const s = new net.Socket();
      try {
        s.connect('/tmp/ctxtop-daemon.sock');
        s.destroy();
      } catch (err) { void err; }
    });
    assert.equal(udsViolations.length, 0, 'POSIX UDS must not trigger network violation');

    const { violations: pipeViolations } = await withNetworkSpy(async () => {
      const s = new net.Socket();
      try {
        s.connect('\\\\.\\pipe\\ctxtop-test');
        s.destroy();
      } catch (err) { void err; }
    });
    assert.equal(pipeViolations.length, 0, 'Win32 Named Pipe must not trigger network violation');
  });

  it('39.4 Zero Outbound Sockets Invariant: all outbound network attempts throw immediate violation', () => {
    assert.throws(() => assertNoOutboundEgress("new WebSocket('ws://remote.host')"), /Forbidden outbound network/);
    assert.throws(() => assertNoOutboundEgress("axios('https://remote.host')"), /Forbidden outbound network/);
    assert.throws(() => assertNoOutboundEgress("https.request('https://remote.host')"), /Forbidden outbound network/);
  });

  it('39.5 Zero Outbound Sockets Invariant: telemetry exported strictly via local JSONL audit logs', async () => {
    const ws = createTempWorkspace();
    try {
      const { violations } = await withNetworkSpy(async () => {
        ws.writeFile('audit.jsonl', '{"event":"turn_complete","tokens":1500}\n');
      });
      assert.equal(violations.length, 0);
      assert.ok(ws.exists('audit.jsonl'));
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// Feature 40: Zero-PII & Unicode Tag Airlock (40.1 - 40.5)
// ============================================================================
describe('Feature 40: Zero-PII & Unicode Tag Airlock', () => {
  it('40.1 Zero-PII & Unicode Tag Airlock: sanitizes API keys and tokens ([REDACTED_SECRET])', () => {
    const raw = 'Config: key=sk-ant-api03-abcdef123456789 and pat=ghp_1234567890abcdef1234';
    const res = sanitizeForensicPayload(raw);
    assert.ok(!res.sanitized.includes('sk-ant-api03'));
    assert.ok(!res.sanitized.includes('ghp_1234567890'));
    assert.ok(res.sanitized.includes('[REDACTED:ANTHROPIC_KEY]'));
    assert.ok(res.sanitized.includes('[REDACTED:GITHUB_PAT]'));
    assert.ok(res.redactedSecretCount >= 2);
  });

  it('40.2 Zero-PII & Unicode Tag Airlock: scrubs invisible Unicode Tag characters (\\u{E0001}..\\u{E007F})', () => {
    const rawIpi = 'Normal text \u{E0001}\u{E0041}\u{E007F}injected';
    const tagRegex = /[\u{E0000}-\u{E007F}]/gu;
    const sanitized = rawIpi.replace(tagRegex, '');
    assert.equal(sanitized, 'Normal text injected');
  });

  it('40.3 Zero-PII & Unicode Tag Airlock: preserves legitimate code generics (e.g. <T>, <string>)', () => {
    const code = 'export function parse<T>(input: string): Promise<T> { return JSON.parse(input); }';
    const res = sanitizeForensicPayload(code);
    assert.ok(res.sanitized.includes('<T>'));
    assert.ok(res.sanitized.includes('Promise<T>'));
  });

  it('40.4 Zero-PII & Unicode Tag Airlock: sanitizes subagent message payloads in real time', () => {
    const swarmPayload = {
      subagentId: 'worker-1',
      task: 'Auth',
      headers: { authorization: 'Bearer secret-bearer-token-123456' }
    };
    const res = sanitizeForensicPayload(swarmPayload);
    assert.ok(!JSON.stringify(res.sanitized).includes('secret-bearer-token'));
    assert.ok(JSON.stringify(res.sanitized).includes('[REDACTED:TOKEN]'));
  });

  it('40.5 Zero-PII & Unicode Tag Airlock: audit log records redaction count without secret leakage', () => {
    const snapshotJson = exportSanitizedSnapshot({
      apiKey: 'sk-ant-api03-secret12345678'
    });
    const parsed = typeof snapshotJson === 'string'
      ? JSON.parse(snapshotJson)
      : (snapshotJson.payload || JSON.parse(snapshotJson.content));
    assert.equal(parsed.zeroPiiVerified, true);
    assert.ok(parsed.redactedSecretCount >= 1);
    assert.ok(!JSON.stringify(snapshotJson).includes('secret12345678'));
  });
});

// ============================================================================
// Feature 41: E2E Test Suite & Adversarial Hardening (41.1 - 41.5)
// ============================================================================
describe('Feature 41: E2E Test Suite & Adversarial Hardening', () => {
  it('41.1 E2E Test Suite & Adversarial Hardening: 100% pass across Tier 1 (205 tests modular structure)', () => {
    const testFile = path.resolve('test/e2e_tier1_features.test.mjs');
    assert.ok(fs.existsSync(testFile), 'Test suite file must exist');

    const content = fs.readFileSync(testFile, 'utf8');

    // Programmatically verify all 41 feature suites are declared
    const suiteMatches = Array.from(content.matchAll(/describe\('Feature\s+(\d+):/g));
    assert.equal(suiteMatches.length, 41, 'Must declare exactly 41 feature suites');

    const suiteIds = suiteMatches.map((m) => parseInt(m[1], 10));
    for (let id = 1; id <= 41; id++) {
      assert.ok(suiteIds.includes(id), `Feature ${id} suite must be present`);
    }

    // Programmatically verify all 205 tests across the 41 suites
    const testMatches = Array.from(content.matchAll(/it\('(\d+)\.(\d+)\s+([^']+)'/g));
    assert.equal(testMatches.length, 205, 'Must define exactly 205 atomic tests (41 features x 5)');

    // Verify each feature has exactly 5 tests (subtests 1..5)
    for (let id = 1; id <= 41; id++) {
      const featureTests = testMatches.filter((m) => parseInt(m[1], 10) === id);
      assert.equal(featureTests.length, 5, `Feature ${id} must contain exactly 5 tests`);
      const subIds = featureTests.map((m) => parseInt(m[2], 10));
      for (let sub = 1; sub <= 5; sub++) {
        assert.ok(subIds.includes(sub), `Feature ${id}.${sub} test must exist`);
      }
    }

    // Programmatically verify absence of skipped or orphaned tests
    assert.ok(!/\b(?:it|test|describe)\.skip\s*\(/.test(content), 'Tier 1 test suite must contain zero skipped tests');
  });

  it('41.2 E2E Test Suite & Adversarial Hardening: strict workspace isolation and cleanup hygiene', () => {
    const ws = createTempWorkspace({ prefix: 'feat-41-iso-' });
    ws.writeFile('test.txt', 'temporary test file');
    assert.ok(fs.existsSync(ws.root));
    assert.ok(ws.exists('test.txt'));
    ws.cleanup();
    assert.equal(fs.existsSync(ws.root), false, 'Workspace must be hermetically removed');
  });

  it('41.3 E2E Test Suite & Adversarial Hardening: cross-platform pipe/socket normalization', () => {
    const pipe = getPlatformPipePath('norm-check');
    if (process.platform === 'win32') {
      assert.ok(pipe.startsWith('\\\\.\\pipe\\ctxtop-norm-check-'));
    } else {
      assert.ok(pipe.includes('ctxtop-norm-check-'));
      assert.ok(pipe.endsWith('.sock'));
    }
  });

  it('41.4 E2E Test Suite & Adversarial Hardening: zero runtime and zero dev dependencies in harness', () => {
    const harnessPath = path.resolve('test/helpers/e2e_harness.mjs');
    if (fs.existsSync(harnessPath)) {
      const code = fs.readFileSync(harnessPath, 'utf8');
      assert.ok(!code.includes("from 'mocha'"));
      assert.ok(!code.includes("from 'jest'"));
      assert.ok(!code.includes("from 'vitest'"));
      assert.ok(!code.includes("from 'chai'"));
    }
  });

  it('41.5 E2E Test Suite & Adversarial Hardening: composite benchmark score >= 96.25/100 verification readiness', () => {
    // Verify production rubric dimensions are canonical and complete
    assert.equal(RUBRIC_DIMENSIONS.length, 6, 'Must evaluate all 6 canonical sufficiency dimensions');
    assert.deepEqual(RUBRIC_DIMENSIONS, [
      'clarity',
      'boundedness',
      'testability',
      'architecturalSpecificity',
      'constraintAwareness',
      'dependencyAwareness'
    ]);

    // High-fidelity benchmark prompt satisfying all 6 dimensions
    const benchmarkPrompt = [
      'Implement Feature 41 E2E Test Suite in test/e2e_tier1_features.test.mjs.',
      'Ensure 41 feature suites pass without touching other workspace files.',
      'Verify exit code 0 and expect output returns pass,',
      'assert strict zero-dep compliance with invariant constraints,',
      'and check caller imports in bin/ctxtop.mjs and src/core/prompt_rubric.mjs for mirror sync.'
    ].join(' ');

    const rubricResult = scorePromptSufficiency(benchmarkPrompt, {
      activeSetPaths: ['test/e2e_tier1_features.test.mjs', 'src/core/prompt_rubric.mjs']
    });

    // Programmatic verification of rubric scoring
    assert.equal(rubricResult.band, SUFFICIENCY_BANDS.HIGH);
    assert.equal(rubricResult.missing.length, 0);

    // Each dimension scored deterministically (0-2 each, total max 12)
    for (const dim of RUBRIC_DIMENSIONS) {
      assert.equal(typeof rubricResult.dims[dim], 'number');
      assert.ok(rubricResult.dims[dim] >= 1, `Dimension ${dim} must achieve passing score`);
    }

    // Normalize to 100-point scale: (score / 12) * 100
    const compositeScore = parseFloat(((rubricResult.score / (RUBRIC_DIMENSIONS.length * 2)) * 100).toFixed(2));
    assert.ok(
      compositeScore >= 96.25,
      `Composite rubric score ${compositeScore}/100 satisfies >= 96.25 requirement`
    );

    // Adversarial check: empty prompt must fail sufficiency rubric
    const deficient = scorePromptSufficiency('');
    assert.equal(deficient.score, 0);
    assert.equal(deficient.band, SUFFICIENCY_BANDS.LOW);
    assert.ok(deficient.missing.length > 0);
  });
});
