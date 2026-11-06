import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { canonicalizePath } from '../src/core/path_canonicalizer.mjs';
import {
  createDefaultSidecar,
  readSidecarSync,
  writeSidecarAtomicSync,
  updateSidecarPartialSync
} from '../src/core/sidecar_store.mjs';

console.log('--- Verifying Phase 1: Schemas, Config & Shared IPC Spine ---');

// 1. Path canonicalization test
const uriPath = 'file:///c%3A/Projects/argon-test\\studio\\generators.py';
const winPath = 'C:\\Projects\\argon-test/studio/generators.py';
const canonical1 = canonicalizePath(uriPath);
const canonical2 = canonicalizePath(winPath);

console.log(`URI Path canonical: ${canonical1}`);
console.log(`Win Path canonical: ${canonical2}`);
assert.equal(canonical1, canonical2, 'Canonicalized paths must match!');
assert.equal(canonical1, 'c:/projects/argon-test/studio/generators.py');
console.log('✓ Check 1: Path canonicalization matches perfectly.');

// 2. 100 round-trip read/write latency test
const testDir = path.join(os.tmpdir(), `fc_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });

const testId = 'test-conversation-uuid-1234';
const initial = createDefaultSidecar(testId, 'C:\\Projects\\argon-test');
writeSidecarAtomicSync(testId, initial, testDir);

const iterations = 100;
const readDurationsMs = [];

for (let i = 0; i < iterations; i++) {
  // Update state
  updateSidecarPartialSync(testId, (state) => {
    state.sessionMeta.turnCount = i + 1;
    state.telemetry.totalInputTokens = (i + 1) * 500;
    return state;
  }, testDir);

  // Measure read latency
  const t0 = process.hrtime.bigint();
  const readState = readSidecarSync(testId, testDir);
  const t1 = process.hrtime.bigint();

  const durationMs = Number(t1 - t0) / 1_000_000;
  readDurationsMs.push(durationMs);

  assert.equal(readState.sessionMeta.turnCount, i + 1);
  assert.equal(readState.telemetry.totalInputTokens, (i + 1) * 500);
}

const avgReadMs = readDurationsMs.reduce((a, b) => a + b, 0) / iterations;
readDurationsMs.sort((a, b) => a - b);
const p95ReadMs = readDurationsMs[Math.floor(iterations * 0.95)];

console.log(`✓ 100 Round-trips completed successfully.`);
console.log(`  Average Read Latency: ${avgReadMs.toFixed(3)}ms (Threshold: < 2.0ms)`);
console.log(`  P95 Read Latency: ${p95ReadMs.toFixed(3)}ms (Threshold: < 2.0ms)`);

assert.ok(avgReadMs < 2.0, `Average read latency (${avgReadMs}ms) must be under 2ms`);
assert.ok(p95ReadMs < 2.0, `P95 read latency (${p95ReadMs}ms) must be under 2ms`);

// Clean up test dir
try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}

console.log('✓ Phase 1 verification PASSED with 0 errors.');
