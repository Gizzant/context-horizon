import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAllBlindspotSensors } from '../src/core/blindspot_sensors.mjs';

console.log('--- Verifying Phase 3: The 6 Blind-Spot Sensors ---');

const tmpDir = path.join(os.tmpdir(), `fc_sensors_test_${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

// Setup test files
const dirtyFilePath = path.join(tmpDir, 'dirty_target.js');
fs.writeFileSync(dirtyFilePath, 'console.log("hello");\n', 'utf8');

const largeFilePath = path.join(tmpDir, 'large_file.js');
const largeLines = Array.from({ length: 750 }, (_, i) => `// Line ${i}`).join('\n');
fs.writeFileSync(largeFilePath, largeLines, 'utf8');

// Caller file importing large_file
const callerFilePath = path.join(tmpDir, 'caller.js');
fs.writeFileSync(callerFilePath, `import { something } from './large_file.js';\n`, 'utf8');

// Touch dirtyFilePath mtime 5 seconds into future
const nowSec = Date.now() / 1000;
fs.utimesSync(dirtyFilePath, nowSec + 5, nowSec + 5);

// Mock step events
const stepEvents = [
  // Turn 0: Schemas
  {
    stepIndex: 0,
    role: 'system',
    type: 'SCHEMA',
    tokenEstimate: 35000 // 17.5% schema tax
  },
  // Step 1: Read dirty target at now - 10,000ms
  {
    stepIndex: 1,
    role: 'tool',
    toolName: 'view_file',
    targetPath: dirtyFilePath,
    timestampMs: Date.now() - 10000,
    tokenEstimate: 500
  },
  // Step 2: Legacy poison read
  {
    stepIndex: 2,
    role: 'tool',
    toolName: 'view_file',
    targetPath: 'c:/projects/my-app/legacy/old_helper.js',
    timestampMs: Date.now() - 8000,
    tokenEstimate: 500
  },
  // Trailing 3 consecutive failed run_command steps
  {
    stepIndex: 3,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 100
  },
  {
    stepIndex: 4,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 100
  },
  {
    stepIndex: 5,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 100
  }
];

const mockSidecarState = {
  sessionMeta: {
    turnCount: 5,
    activeModel: 'gemini-3.8-flash',
    inPlanMode: true,
    turnsSinceLastPassingTest: 4
  },
  telemetry: {
    totalInputTokens: 50000,
    quota: {
      remaining_fraction: 0.08 // below 0.10
    }
  }
};

const mockToolLedger = {
  servers: {
    'unused-mcp': { invocationsLast15Sessions: 0 },
    'active-mcp': { invocationsLast15Sessions: 12 }
  }
};

const config = {
  quota_floor_fraction: 0.10,
  max_single_write_lines: 600,
  deprecated_paths: ['**/legacy/**'],
  consecutive_error_strike_limit: 3,
  uncheckpointed_dirty_file_limit: 4
};

// Benchmark runAllBlindspotSensors
const t0 = process.hrtime.bigint();
const results = runAllBlindspotSensors({
  stepEvents,
  sidecarState: mockSidecarState,
  workspacePath: tmpDir,
  targetFiles: [largeFilePath],
  activeSetPaths: [],
  toolUsageLedger: mockToolLedger,
  promptText: 'Please rewrite the whole component from scratch',
  config
});
const t1 = process.hrtime.bigint();
const durationMs = Number(t1 - t0) / 1_000_000;

console.log(`Results:`, JSON.stringify(results, null, 2));
console.log(`Execution time: ${durationMs.toFixed(3)}ms (Threshold: < 15.0ms)`);

// Assert Sensor 1: DIRTY_SNAP
assert.ok(results.dirtySnapshotPaths.length > 0, 'DIRTY_SNAP must flag modified file');
console.log('✓ Sensor 1 (DIRTY_SNAP) passed.');

// Assert Sensor 2: SCHEMA_TAX
assert.equal(results.schemaTaxPct, 17.5, 'Schema tax must equal 17.5%');
assert.ok(results.unusedMcpServers.includes('unused-mcp'), 'Unused MCP server must be flagged');
console.log('✓ Sensor 2 (SCHEMA_TAX) passed.');

// Assert Sensor 3: UNSEEN_CALLERS
assert.ok(results.unseenCallers.length > 0, 'Unseen callers must detect caller.js');
console.log('✓ Sensor 3 (UNSEEN_CALLERS) passed.');

// Assert Sensor 4: LEGACY_POISON
assert.ok(results.legacyPoisonPaths.some(p => p.includes('legacy')), 'Legacy poison path detected');
console.log('✓ Sensor 4 (LEGACY_POISON) passed.');

// Assert Sensor 5: QUOTA_AND_STREAM_SHIELD
assert.equal(results.quotaFloorBreached, true, 'Quota floor breached (<10%)');
assert.equal(results.planToFlashHandoffNeeded, true, 'Plan to flash handoff detected (>40k tokens in plan)');
assert.ok(results.streamCutoffRiskFiles.length > 0, '750-line file flagged for full rewrite stream cutoff risk');
console.log('✓ Sensor 5 (QUOTA_AND_STREAM_SHIELD) passed.');

// Assert Sensor 6: LOOP_AND_GIT_GUARD
assert.equal(results.threeStrikeLoop, true, '3-strike consecutive error loop flagged');
console.log('✓ Sensor 6 (LOOP_AND_GIT_GUARD) passed.');

assert.ok(durationMs < 15.0, `Sensors took ${durationMs}ms which exceeds 15ms threshold`);

// Clean up
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log('✓ Phase 3 verification PASSED with 0 errors.');
