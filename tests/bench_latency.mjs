import assert from 'node:assert/strict';
import { readSidecarSync, writeSidecarAtomicSync, createDefaultSidecar } from '../src/core/sidecar_store.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { runHud } from '../src/cli/horizon_hud.mjs';

const ITERATIONS = 200;
const benchId = 'bench_session_200';
const baseSidecar = createDefaultSidecar(benchId, 'c:/projects/ga-visualizer-v2');
baseSidecar.fileState.activeSetPaths = ['c:/projects/ga-visualizer-v2/src/core/router.mjs'];
writeSidecarAtomicSync(benchId, baseSidecar);

function calculatePercentiles(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return { p50, p95, p99, avg };
}

console.log(`========================================================================`);
console.log(`  Chrono-Attention Horizon & Flight Check v3.1.0 Latency Benchmark`);
console.log(`  Running ${ITERATIONS} iterations per critical path`);
console.log(`========================================================================\n`);

// 1. Benchmark readSidecarSync
const readTimes = [];
for (let i = 0; i < ITERATIONS; i++) {
  const t0 = process.hrtime.bigint();
  readSidecarSync(benchId);
  const t1 = process.hrtime.bigint();
  readTimes.push(Number(t1 - t0) / 1_000_000);
}
const readStats = calculatePercentiles(readTimes);

// 2. Benchmark PreInvocation Tier 1 Routing
const hookTimes = [];
for (let i = 0; i < ITERATIONS; i++) {
  const t0 = process.hrtime.bigint();
  await handlePreInvocation({
    conversationId: benchId,
    prompt: 'In router.mjs add debug logger'
  });
  const t1 = process.hrtime.bigint();
  hookTimes.push(Number(t1 - t0) / 1_000_000);
}
const hookStats = calculatePercentiles(hookTimes);

// 3. Benchmark Incremental StatusLine HUD Render
const hudTimes = [];
const sampleStdin = {
  conversation_id: benchId,
  context_window: { total_input_tokens: 35000, used_percentage: 17.5 },
  modelName: 'gemini-3.8-flash',
  quota: { remaining_fraction: 0.85 }
};

for (let i = 0; i < ITERATIONS; i++) {
  const t0 = process.hrtime.bigint();
  await runHud({ stdinData: sampleStdin, silent: true, columns: 120 });
  const t1 = process.hrtime.bigint();
  hudTimes.push(Number(t1 - t0) / 1_000_000);
}
const hudStats = calculatePercentiles(hudTimes);

// Print Tabular Results
console.log(`| Critical Path                 | SLA Budget | Avg (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Status |`);
console.log(`|:------------------------------|:-----------|:---------|:---------|:---------|:---------|:-------|`);

const formatRow = (name, budget, stats) => {
  const passed = stats.p95 <= budget;
  const status = passed ? '✅ PASS' : '❌ FAIL';
  return `| ${name.padEnd(30)} | < ${String(budget).padEnd(6)}ms | ${stats.avg.toFixed(3).padStart(8)} | ${stats.p50.toFixed(3).padStart(8)} | ${stats.p95.toFixed(3).padStart(8)} | ${stats.p99.toFixed(3).padStart(8)} | ${status} |`;
};

console.log(formatRow('readSidecarSync', 2.0, readStats));
console.log(formatRow('PreInvocation Tier 1 Gate', 15.0, hookStats));
console.log(formatRow('horizon_hud statusLine Render', 45.0, hudStats));
console.log(`\n========================================================================`);

assert.ok(readStats.p95 < 2.0, `readSidecarSync p95 (${readStats.p95.toFixed(3)}ms) exceeded 2.0ms`);
assert.ok(hookStats.p95 < 15.0, `PreInvocation Tier 1 p95 (${hookStats.p95.toFixed(3)}ms) exceeded 15.0ms`);
assert.ok(hudStats.p95 < 45.0, `horizon_hud p95 (${hudStats.p95.toFixed(3)}ms) exceeded 45.0ms`);

console.log(`All SLA performance budgets met successfully!`);
