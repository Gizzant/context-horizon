/**
 * @file test/phase7_config_diagnostics_calibration_receipt.test.mjs
 * Verification Suite for Phase 7 (`>= 9.0` Across All 18 Evaluation Categories):
 *   - IDEA-01: Unified `.attention-horizon.json` Per-Detector Config & Override Engine (`off` | `warn` | `block`)
 *   - IDEA-02: Zero-PII `doctor --diagnostic` GitHub Issue Bug-Report & Contract Self-Test
 *   - IDEA-03: Empirical Repo-Calibrated Context Physics (`repoCalibration.mjs`)
 *   - IDEA-04: Shareable Git-Commit & Session Efficiency Receipt (`receipt --markdown` / `--json`)
 *   - IDEA-05: Cross-Harness Scope Lock (`DET-20` `.agents/locks` + `.claude/locks`)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  CANONICAL_DETECTOR_IDS,
  normalizeDetectorId,
  normalizeDetectorMode,
  loadHorizonConfig,
  setDetectorOverride,
  resetHorizonConfig,
  mapTriggerToNativeCommand,
  applyDetectorOverride
} from '../../src/core-isomorphic/config/horizonConfig.mjs';
import {
  recordRepoFileRead,
  recordRepoCompactionOutcome,
  recordRepoCacheTurn,
  getTopChronicReadFiles,
  loadRepoCalibration
} from '../../src/core-isomorphic/coach/repoCalibration.mjs';
import {
  redactUserPaths,
  resolveGitHeadMetadata,
  generateZeroPiiDiagnosticBundle,
  generateGitCommitEfficiencyReceipt
} from '../../src/diagnostics/bugReportGenerator.mjs';
import { CircuitBreakerEngine } from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import { recordTurnCacheSavings } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import { runCli, runDoctorDiagnostics } from '../../bin/cli.mjs';

function makeTempDir(prefix = 'ah-phase7-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// SECTION 1: IDEA-01 — Unified `.attention-horizon.json` Per-Detector Config
// ============================================================================

test('P7-01: normalizeDetectorId and normalizeDetectorMode handle all shorthand inputs', () => {
  assert.equal(normalizeDetectorId('det-7'), 'DET-07');
  assert.equal(normalizeDetectorId('DET19'), 'DET-19');
  assert.equal(normalizeDetectorId('DET-20'), 'DET-20');
  assert.equal(normalizeDetectorId('DET-99'), null);

  assert.equal(normalizeDetectorMode('off'), 'off');
  assert.equal(normalizeDetectorMode(false), 'off');
  assert.equal(normalizeDetectorMode('warn'), 'warn');
  assert.equal(normalizeDetectorMode('advisory'), 'warn');
  assert.equal(normalizeDetectorMode('block'), 'block');
  assert.equal(normalizeDetectorMode(true), 'default');
  assert.equal(CANONICAL_DETECTOR_IDS.length, 32);
});

test('P7-02: setDetectorOverride writes `.attention-horizon.json` and merges with global config', () => {
  const tmp = makeTempDir();
  try {
    const res = setDetectorOverride('det-7', 'off', { cwd: tmp });
    assert.equal(res.ok, true);
    assert.equal(res.detectorId, 'DET-07');
    assert.equal(res.mode, 'off');

    const loaded = loadHorizonConfig({ cwd: tmp });
    assert.equal(loaded.detectors['DET-07'], 'off');
    assert.equal(loaded.detectors['DET-01'], 'default');
    assert.equal(loaded.sources.projectLoaded, true);

    const reset = resetHorizonConfig({ cwd: tmp });
    assert.equal(reset.ok, true);
    const afterReset = loadHorizonConfig({ cwd: tmp });
    assert.equal(afterReset.detectors['DET-07'], 'default');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P7-03: CircuitBreakerEngine honors `.attention-horizon.json` `off`, `warn`, and `block` overrides', () => {
  const tmp = makeTempDir();
  try {
    // 1. Mute DET-07 (`off`) -> unbounded `git log --stat` should pass through
    setDetectorOverride('DET-07', 'off', { cwd: tmp });
    const engineMuted = new CircuitBreakerEngine({ cwd: tmp });
    const vMuted = engineMuted.evaluatePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git log --stat' }
    });
    assert.equal(vMuted.triggered, false);
    assert.equal(vMuted.decision, 'allow');

    // 2. Set DET-07 to `warn` -> triggers as non-blocking advisory (`decision: 'allow'`, `advisory: true`)
    setDetectorOverride('DET-07', 'warn', { cwd: tmp });
    const engineWarn = new CircuitBreakerEngine({ cwd: tmp });
    const vWarn = engineWarn.evaluatePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git log --stat' }
    });
    assert.equal(vWarn.triggered, true);
    assert.equal(vWarn.detectorId, 'DET-07');
    assert.equal(vWarn.decision, 'allow');
    assert.equal(vWarn.advisory, true);
    assert.equal(vWarn.overriddenByConfig, 'warn');

    // 3. Set DET-03 (normally `ask`) to `block` -> upgrades to hard `deny`
    setDetectorOverride('DET-03', 'block', { cwd: tmp });
    const engineBlock = new CircuitBreakerEngine({ cwd: tmp });
    const vBlock = engineBlock.evaluatePreToolUse({
      tool_name: 'Edit',
      tool_input: { file_path: 'package-lock.json', old_string: 'a', new_string: 'b' }
    });
    assert.equal(vBlock.triggered, true);
    assert.equal(vBlock.detectorId, 'DET-03');
    assert.equal(vBlock.decision, 'deny');
    assert.equal(vBlock.overriddenByConfig, 'block');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 2: IDEA-03 — Empirical Repo-Calibrated Context Physics
// ============================================================================

test('P7-04: RepoCalibrationStore tracks chronic file re-reads while exempting normal README onboarding', () => {
  const tmp = makeTempDir();
  try {
    // Reading README.md 3 times across 2 sessions is normal onboarding, not a chronic sink
    recordRepoFileRead({ filePath: 'README.md', estimatedTokens: 2500, sessionId: 's1' }, { cwd: tmp });
    recordRepoFileRead({ filePath: 'README.md', estimatedTokens: 2500, sessionId: 's2' }, { cwd: tmp });
    const r3 = recordRepoFileRead(
      { filePath: 'README.md', estimatedTokens: 2500, sessionId: 's2' },
      { cwd: tmp }
    );
    assert.equal(r3.isChronicSink, false);

    // Reading a large source file (`src/webview/horizon_panel.html`) 3x (9,000 tok) flags it as a chronic sink
    recordRepoFileRead(
      { filePath: 'src/webview/horizon_panel.html', estimatedTokens: 3000, sessionId: 's1' },
      { cwd: tmp }
    );
    recordRepoFileRead(
      { filePath: 'src/webview/horizon_panel.html', estimatedTokens: 3000, sessionId: 's1' },
      { cwd: tmp }
    );
    const sink = recordRepoFileRead(
      { filePath: 'src/webview/horizon_panel.html', estimatedTokens: 3000, sessionId: 's2' },
      { cwd: tmp }
    );
    assert.equal(sink.isChronicSink, true);
    assert.match(sink.recommendation, /Repo Calibration Alert/);

    const top = getTopChronicReadFiles({ cwd: tmp });
    assert.equal(top[0].fileKey, 'src/webview/horizon_panel.html');
    assert.equal(top[0].totalEstimatedTokens, 9000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P7-05: RepoCalibrationStore records empirical compaction survival ratio and cache-hit baseline', () => {
  const tmp = makeTempDir();
  try {
    const comp = recordRepoCompactionOutcome({ preTokens: 100000, postTokens: 18000 }, { cwd: tmp });
    assert.equal(comp.count, 1);
    assert.equal(comp.averageSurvivalRatio, 0.18);

    recordRepoCacheTurn({ cacheReadTokens: 80000, totalPromptTokens: 90000 }, { cwd: tmp });
    const cachePerf = recordRepoCacheTurn(
      { cacheReadTokens: 10000, totalPromptTokens: 50000 },
      { cwd: tmp }
    );
    assert.equal(cachePerf.totalTurns, 2);
    assert.equal(cachePerf.warmHitTurns, 1);
    assert.equal(cachePerf.empiricalHitRatio, 0.5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 3: IDEA-02 & IDEA-04 — Zero-PII Diagnostics & Git-Commit Receipts
// ============================================================================

test('P7-06: generateZeroPiiDiagnosticBundle redacts OS home paths and validates all 7 doctor contracts', () => {
  const tmp = makeTempDir();
  try {
    setDetectorOverride('DET-14', 'warn', { cwd: tmp });
    const doc = runDoctorDiagnostics({ cwd: tmp });
    assert.equal(doc.ok, true);
    assert.equal(doc.checks.length, 7);

    const bundle = generateZeroPiiDiagnosticBundle(doc, {
      cwd: tmp,
      homeDir: 'C:\\Users\\SecretDeveloperName'
    });
    assert.equal(bundle.ok, true);
    assert.match(bundle.markdown, /Highbeam — Zero-PII Diagnostic Report/);
    assert.match(bundle.markdown, /DET-14=warn/);
    assert.equal(
      redactUserPaths('Loaded from C:\\Users\\SecretDeveloperName\\.claude', 'C:\\Users\\SecretDeveloperName'),
      'Loaded from ~\\.claude'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P7-07: generateGitCommitEfficiencyReceipt correlates `.git/HEAD` with SavedQuotaLedger', () => {
  const tmp = makeTempDir();
  try {
    // Create a mock `.git/HEAD` and branch ref
    const headsDir = path.join(tmp, '.git', 'refs', 'heads');
    fs.mkdirSync(headsDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/feat/quiet-beta\n', 'utf-8');
    fs.writeFileSync(
      path.join(headsDir, 'feat', 'quiet-beta').replace(
        path.join(headsDir, 'feat', 'quiet-beta'),
        (() => {
          fs.mkdirSync(path.join(headsDir, 'feat'), { recursive: true });
          return path.join(headsDir, 'feat', 'quiet-beta');
        })()
      ),
      'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n',
      'utf-8'
    );

    const ledgerPath = path.join(tmp, 'horizon_ledger.jsonl');
    recordTurnCacheSavings(
      {
        sessionId: 'beta-1',
        modelId: 'claude-sonnet-5-5',
        inputTokens: 5000,
        cacheReadTokens: 50000
      },
      { ledgerPath }
    );

    const receipt = generateGitCommitEfficiencyReceipt({ cwd: tmp, ledgerPath });
    assert.equal(receipt.git.branch, 'feat/quiet-beta');
    assert.equal(receipt.git.shortCommit, 'a1b2c3d');
    assert.equal(receipt.summary.totalSavedTokens, 50000);
    assert.ok(receipt.summary.totalSavedUSD > 0);
    assert.match(receipt.markdown, /feat\/quiet-beta@a1b2c3d/);
    assert.match(receipt.markdown, /50,000 tok/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 4: IDEA-05 — Cross-Harness Scope Lock (`DET-20`) & CLI Subcommands
// ============================================================================

test('P7-08: DET-20 detects cross-harness Antigravity locks in `.agents/locks/active_scopes.json`', () => {
  const tmp = makeTempDir();
  try {
    const nowMs = Date.now();
    const agyLocksDir = path.join(tmp, '.agents', 'locks');
    fs.mkdirSync(agyLocksDir, { recursive: true });
    fs.writeFileSync(
      path.join(agyLocksDir, 'active_scopes.json'),
      JSON.stringify({
        version: 1,
        leases: [
          {
            agent_id: 'antigravity-ide-session-1',
            session_id: '25520b4b-909e-4688-896d-95523af52c4e',
            files_locked: ['src/core/*'],
            acquired_at: new Date(nowMs - 5000).toISOString(),
            expires_at: new Date(nowMs + 895000).toISOString(),
            ttl_ms: 900000
          }
        ]
      }),
      'utf-8'
    );

    const engine = new CircuitBreakerEngine({ cwd: tmp });
    const verdict = engine.evaluatePreToolUse(
      {
        tool_name: 'Edit',
        tool_input: { file_path: 'src/core/engine.mjs', old_string: 'a', new_string: 'b' }
      },
      { sessionId: 'claude-cli-session-2' }
    );
    assert.equal(verdict.triggered, true);
    assert.equal(verdict.detectorId, 'DET-20');
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /antigravity-ide-session-1/);

    const allowedVerdict = engine.evaluatePreToolUse(
      {
        tool_name: 'Edit',
        tool_input: { file_path: 'src/core-isomorphic/ui/panel.mjs', old_string: 'a', new_string: 'b' }
      },
      { sessionId: 'claude-cli-session-2' }
    );
    assert.equal(allowedVerdict.triggered, false);
    assert.equal(allowedVerdict.decision, 'allow');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P7-09: CLI subcommands (`config`, `doctor --diagnostic`, `receipt --markdown`) execute cleanly', () => {
  const tmp = makeTempDir();
  try {
    const setRes = runCli(['config', 'set', 'DET-06', 'warn'], { cwd: tmp });
    assert.equal(setRes.exitCode, 0);
    assert.match(setRes.output, /DET-06=warn/);

    const listRes = runCli(['config', 'list'], { cwd: tmp });
    assert.equal(listRes.exitCode, 0);
    assert.match(listRes.output, /DET-06: warn/);

    const diagRes = runCli(['doctor', '--diagnostic'], { cwd: tmp });
    assert.equal(diagRes.exitCode, 0);
    assert.match(diagRes.output, /Zero-PII Diagnostic Report/);

    const mdReceipt = runCli(['receipt', '--markdown'], {
      cwd: tmp,
      ledgerPath: path.join(tmp, 'empty.jsonl')
    });
    assert.equal(mdReceipt.exitCode, 0);
    assert.match(mdReceipt.output, /Session & Git Efficiency Receipt/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P7-10: mapTriggerToNativeCommand prescribes /rewind, /fork, scoped /compact, /mcp, /effort, and /handoff -> /clear', () => {
  const poisoned = mapTriggerToNativeCommand({ consecutiveFailures: 3, detectorId: 'DET-04' });
  assert.equal(poisoned.category, 'POISONED_CONTEXT_RECOVERY');
  assert.equal(poisoned.primaryCommand, '/rewind');
  assert.equal(poisoned.secondaryCommand, '/fork');

  const compact = mapTriggerToNativeCommand({
    platform: 'claude_code',
    contextUsedPct: 78,
    modifiedFiles: ['src/guards/circuitBreakers.mjs', 'bin/cli.mjs'],
    unresolvedTasks: ['verify Windows hooks']
  });
  assert.equal(compact.category, 'SCOPED_CONTEXT_COMPACTION');
  assert.match(compact.primaryCommand, /^\/compact Preserve modified files/);
  assert.match(compact.primaryCommand, /src\/guards\/circuitBreakers\.mjs/);

  const overhead = mapTriggerToNativeCommand({ detectorId: 'DET-13', idleMcpBloat: true });
  assert.equal(overhead.category, 'STANDING_OVERHEAD_TRIM');
  assert.equal(overhead.primaryCommand, '/mcp');
  assert.equal(overhead.secondaryCommand, '/context');

  const baton = mapTriggerToNativeCommand({ milestoneComplete: true });
  assert.equal(baton.category, 'CLEAN_SESSION_BATON');
  assert.equal(baton.sequence, '/handoff -> /clear');
});

test('P7-11: Bundled skills/handoff/SKILL.md exists with minimal progressive-disclosure frontmatter', () => {
  const skillPath = path.resolve(process.cwd(), 'skills', 'handoff', 'SKILL.md');
  assert.equal(fs.existsSync(skillPath), true);
  const raw = fs.readFileSync(skillPath, 'utf8');
  assert.match(raw, /^---\r?\nname:\s*handoff\r?\ndescription:\s*.+\r?\n---/);
  assert.match(raw, /HANDOFF\.md/);
});
