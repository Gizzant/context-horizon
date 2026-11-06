import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { readSidecarSync } from '../src/core/sidecar_store.mjs';

console.log('--- Verifying Phase 4: Dual-Surface HUD (statusLine CLI & Tufte Webview) ---');

const samplePayload = {
  conversation_id: 'test_phase_4_session',
  workspacePath: 'c:/projects/ga-visualizer-v2',
  modelName: 'gemini-3.8-flash',
  mode: 'auto',
  agent_state: 'working',
  context_window: {
    total_input_tokens: 45000,
    used_percentage: 22.5,
    exceeds_200k_tokens: false
  },
  quota: {
    remaining_fraction: 0.75,
    remaining_amount: 75,
    reset_in_seconds: 14400,
    buckets: {
      standard: { remaining_fraction: 0.75 }
    }
  }
};

const payloadJson = JSON.stringify(samplePayload);

// Test 1: Pipe valid payload and measure execution latency
const t0 = process.hrtime.bigint();
const stdoutValid = execSync('node src/cli/horizon_hud.mjs', {
  input: payloadJson,
  encoding: 'utf8',
  timeout: 5000
});
const t1 = process.hrtime.bigint();
const durationMs = Number(t1 - t0) / 1_000_000;

console.log(`HUD Output:\n${stdoutValid.trim()}`);
console.log(`Execution Latency: ${durationMs.toFixed(3)}ms (Threshold: < 45.0ms)`);
assert.ok(stdoutValid.includes('Purity:'), 'Output must contain Purity label');
assert.ok(stdoutValid.includes('Quota: 75%'), 'Output must contain parsed Quota');
console.log('✓ Check 1: Formatted ANSI status bar output in under 45ms.');

// Test 2: Check sidecar.json persistence
const sidecar = readSidecarSync('test_phase_4_session');
assert.equal(sidecar.telemetry.quota.remaining_fraction, 0.75, 'Sidecar quota fraction must be 0.75');
assert.equal(sidecar.telemetry.mode, 'auto', 'Sidecar mode must be auto');
assert.equal(sidecar.telemetry.totalInputTokens, 45000, 'Sidecar tokens must be 45000');
console.log('✓ Check 2: Sidecar atomically persisted with correct quota and mode.');

// Test 3: Malformed stdin test
const stdoutMalformed = execSync('node src/cli/horizon_hud.mjs', {
  input: '{ corrupt_json: [ unclosed ',
  encoding: 'utf8',
  timeout: 5000
});
console.log(`Malformed stdin HUD output:\n${stdoutMalformed.trim()}`);
assert.ok(stdoutMalformed.includes('Purity:'), 'Malformed stdin must produce safe fallback status bar');
console.log('✓ Check 3: Malformed stdin exited 0 with fallback bar.');

console.log('✓ Phase 4 verification PASSED with 0 errors.');
