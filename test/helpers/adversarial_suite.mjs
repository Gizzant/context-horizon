import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  detectRuntimeEnv,
  isSqliteAvailable,
  createTempWorkspace,
  cleanupTempWorkspace,
  createIsolatedTestSandbox,
  createMockToolSpan,
  createMockUSTFTurn,
  createMockUSTFTrajectory,
  validateUSTFv1,
  serializeUSTFv1,
  deserializeUSTFv1,
  startMockIpcServer,
  sendIpcMessage,
  stopIpcServer,
  writeControlLatch,
  readControlLatch,
  calculateBreakEvenCStar,
  verifyRetentionRadarDiff,
  checkHaiku100kCliffBreaker,
  calculateDualTtlCountdown,
  partitionBillingBlocks,
  checkModLaws,
  checkZeroRuntimeDeps,
  assertNoOutboundEgress,
  assertNoNodeBuiltinImports,
  assertPlainTextCompact,
  assertActiveSourceProtected,
  assertMirrorParity
} from './e2e_harness.mjs';

const results = {
  concurrency: null,
  fileLocking: null,
  ipcPingPong: null,
  schemaFuzzing: null,
  astEdgeCases: null,
  verdict: 'PENDING'
};

// ----------------------------------------------------------------------------
// Test 1: Concurrency Stress (50 parallel workspaces + file I/O)
// ----------------------------------------------------------------------------
async function runConcurrencyStress() {
  console.log('[Stress 1] Concurrency: Creating 50 parallel workspaces...');
  const t0 = performance.now();
  const workspaces = [];
  const COUNT = 50;

  for (let i = 0; i < COUNT; i++) {
    const ws = createTempWorkspace({
      prefix: `stress-ws-${i}-`,
      files: {
        'metadata.json': JSON.stringify({ id: i, created: Date.now() }),
        'deep/nested/file.txt': `Data payload ${i}`
      }
    });
    workspaces.push(ws);
  }
  const createMs = performance.now() - t0;

  // Concurrent verification
  for (let i = 0; i < COUNT; i++) {
    const ws = workspaces[i];
    assert.equal(ws.exists('metadata.json'), true);
    assert.equal(ws.exists('deep/nested/file.txt'), true);
    const meta = JSON.parse(ws.readFile('metadata.json'));
    assert.equal(meta.id, i);
  }

  // Concurrent cleanup
  const t1 = performance.now();
  for (const ws of workspaces) {
    ws.cleanup();
  }
  const cleanupMs = performance.now() - t1;

  for (let i = 0; i < COUNT; i++) {
    assert.equal(fs.existsSync(workspaces[i].root), false, `Workspace ${i} was not cleaned up`);
  }

  results.concurrency = {
    workspacesCount: COUNT,
    createDurationMs: parseFloat(createMs.toFixed(2)),
    cleanupDurationMs: parseFloat(cleanupMs.toFixed(2)),
    status: 'PASS'
  };
  console.log(`[Stress 1] PASS: 50 workspaces created in ${createMs.toFixed(1)}ms, cleaned in ${cleanupMs.toFixed(1)}ms.`);
}

// ----------------------------------------------------------------------------
// Test 2: Windows File Locking Delays
// ----------------------------------------------------------------------------
async function runFileLockingStress() {
  console.log('[Stress 2] Windows File Locking: Holding exclusive lock via PowerShell...');
  const ws = createTempWorkspace({ prefix: 'stress-lock-' });
  const lockTarget = ws.writeFile('exclusive.lock', 'Locked handle test');
  const escapedPath = lockTarget.replace(/\\/g, '\\\\');

  const psScript = `
    $file = [System.IO.File]::Open("${escapedPath}", [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    Write-Host "LOCKED"
    Start-Sleep -Milliseconds 350
    $file.Close()
    Write-Host "RELEASED"
  `;

  const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], {
    stdio: ['ignore', 'pipe', 'inherit']
  });

  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      if (data.toString().includes('LOCKED')) resolve();
    });
    child.on('error', reject);
  });

  const t0 = performance.now();
  // Call cleanup while file is locked for 350ms
  cleanupTempWorkspace(ws.root);
  const elapsed = performance.now() - t0;

  await new Promise(resolve => child.on('close', resolve));
  const existsAfter = fs.existsSync(ws.root);

  // If retry loop exhausted before release, perform final cleanup
  if (existsAfter) {
    cleanupTempWorkspace(ws.root);
  }
  const finalExists = fs.existsSync(ws.root);
  assert.equal(finalExists, false, 'Directory must be deleted after lock released');

  results.fileLocking = {
    lockDurationMs: 350,
    cleanupElapsedMs: parseFloat(elapsed.toFixed(2)),
    deletedDuringLockRetries: !existsAfter,
    finalCleaned: !finalExists,
    status: 'PASS'
  };
  console.log(`[Stress 2] PASS: Windows file lock handled in ${elapsed.toFixed(1)}ms (deleted during retry: ${!existsAfter}).`);
}

// ----------------------------------------------------------------------------
// Test 3: IPC Ping-Pong Performance (50 iterations, SLA: p95 < 0.80ms)
// ----------------------------------------------------------------------------
async function runIpcBenchmark() {
  console.log('[Stress 3] IPC Ping-Pong: Benchmarking 50 iterations against SLA p95 < 0.80ms...');
  const server = await startMockIpcServer({ pipeName: 'bench-sla' });
  const latenciesOneShot = [];

  // Warmup 5
  for (let i = 0; i < 5; i++) {
    await sendIpcMessage(server.pipePath, { jsonrpc: '2.0', id: i, method: 'ping' });
  }

  // 50 iterations with sendIpcMessage (new connection per request)
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const res = await sendIpcMessage(server.pipePath, { jsonrpc: '2.0', id: i, method: 'ping' });
    const t1 = performance.now();
    assert.equal(res.id, i);
    latenciesOneShot.push(t1 - t0);
  }

  // 50 iterations over a persistent warm socket
  const client = net.connect(server.pipePath);
  await new Promise(r => client.on('connect', r));
  const latenciesPersistent = [];
  let buffer = '';

  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const responsePromise = new Promise(resolve => {
      const onData = (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          client.off('data', onData);
          const lines = buffer.split('\n');
          buffer = lines.slice(1).join('\n');
          resolve(lines[0]);
        }
      };
      client.on('data', onData);
    });

    client.write(JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'ping' }) + '\n');
    await responsePromise;
    const t1 = performance.now();
    latenciesPersistent.push(t1 - t0);
  }

  client.destroy();
  await server.close();

  // Calculate statistics
  function stats(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      min: parseFloat(sorted[0].toFixed(4)),
      median: parseFloat(sorted[Math.floor(sorted.length * 0.5)].toFixed(4)),
      p90: parseFloat(sorted[Math.floor(sorted.length * 0.9)].toFixed(4)),
      p95: parseFloat(sorted[Math.floor(sorted.length * 0.95)].toFixed(4)),
      p99: parseFloat(sorted[Math.floor(sorted.length * 0.99)].toFixed(4)),
      max: parseFloat(sorted[sorted.length - 1].toFixed(4)),
      avg: parseFloat((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(4))
    };
  }

  const oneShotStats = stats(latenciesOneShot);
  const persistentStats = stats(latenciesPersistent);

  const slaMet = oneShotStats.p95 < 0.80 && persistentStats.p95 < 0.80;

  results.ipcPingPong = {
    iterations: 50,
    oneShotConnection: oneShotStats,
    persistentConnection: persistentStats,
    slaThresholdMs: 0.80,
    slaMet,
    status: slaMet ? 'PASS' : 'FAIL'
  };

  console.log(`[Stress 3] ${slaMet ? 'PASS' : 'FAIL'}: One-Shot p95 = ${oneShotStats.p95}ms, Persistent p95 = ${persistentStats.p95}ms (SLA: < 0.80ms)`);
}

// ----------------------------------------------------------------------------
// Test 4: Schema Fuzzing & Anomaly Mining
// ----------------------------------------------------------------------------
async function runSchemaFuzzing() {
  console.log('[Stress 4] USTF v1 Schema Fuzzing: Corrupted, truncated, and edge-case payloads...');
  const anomalies = [];
  let fuzzCount = 0;

  const validBase = () => createMockUSTFTrajectory({ turnsCount: 1 });

  // 4.1 NaN / Infinity numeric acceptance (Loophole check)
  const numericFields = [
    { target: 'createdAt', path: (t, v) => { t.createdAt = v; } },
    { target: 'turnIndex', path: (t, v) => { t.turns[0].turnIndex = v; } },
    { target: 'ttftMs', path: (t, v) => { t.turns[0].ttftMs = v; } },
    { target: 'usage.uncached', path: (t, v) => { t.turns[0].usage.uncached = v; } },
    { target: 'usage.cacheWrite5m', path: (t, v) => { t.turns[0].usage.cacheWrite5m = v; } },
    { target: 'usage.cacheWrite1h', path: (t, v) => { t.turns[0].usage.cacheWrite1h = v; } },
    { target: 'usage.cacheRead', path: (t, v) => { t.turns[0].usage.cacheRead = v; } },
    { target: 'usage.thinking', path: (t, v) => { t.turns[0].usage.thinking = v; } },
    { target: 'usage.output', path: (t, v) => { t.turns[0].usage.output = v; } }
  ];

  for (const { target, path } of numericFields) {
    fuzzCount++;
    const tNan = validBase();
    path(tNan, NaN);
    const resNan = validateUSTFv1(tNan);
    if (resNan.valid) {
      anomalies.push({
        field: target,
        anomaly: 'ACCEPTED_NAN',
        severity: 'MEDIUM',
        description: `Field '${target}' with value NaN passed validation`
      });
    }

    fuzzCount++;
    const tInf = validBase();
    path(tInf, Infinity);
    const resInf = validateUSTFv1(tInf);
    if (resInf.valid) {
      anomalies.push({
        field: target,
        anomaly: 'ACCEPTED_INFINITY',
        severity: 'LOW',
        description: `Field '${target}' with value Infinity passed validation`
      });
    }
  }

  // 4.2 Non-hex prefixHash64 check
  {
    fuzzCount++;
    const t = validBase();
    t.turns[0].prefixHash64 = 'gggggggggggggggg'; // 16 non-hex chars
    const res = validateUSTFv1(t);
    if (res.valid) {
      anomalies.push({
        field: 'prefixHash64',
        anomaly: 'ACCEPTED_NON_HEX',
        severity: 'LOW',
        description: 'prefixHash64 contains 16 non-hex characters but passed validation'
      });
    }
  }

  // 4.3 Floating turnIndex check
  {
    fuzzCount++;
    const t = validBase();
    t.turns[0].turnIndex = 3.14159;
    const res = validateUSTFv1(t);
    if (res.valid) {
      anomalies.push({
        field: 'turnIndex',
        anomaly: 'ACCEPTED_NON_INTEGER',
        severity: 'LOW',
        description: 'turnIndex contains floating-point number (3.14159) but passed validation'
      });
    }
  }

  // 4.4 Round-trip serialization check on NaN payload
  let roundTripBroken = false;
  {
    const t = validBase();
    t.turns[0].usage.uncached = NaN;
    if (validateUSTFv1(t).valid) {
      const serialized = serializeUSTFv1(t);
      try {
        deserializeUSTFv1(serialized);
      } catch (err) {
        roundTripBroken = true;
      }
    }
  }

  // 4.5 Truncated & Corrupted JSON Deserialization
  const corruptedStrings = [
    '{',
    '{"version":',
    '{"version": "1.0.0", "turns": [',
    '{"version": "1.0.0",,}',
    '{"version": "1.0.0", "sessionId": null}',
    'null',
    '123'
  ];

  let rejectedCorrupted = 0;
  for (const str of corruptedStrings) {
    fuzzCount++;
    try {
      deserializeUSTFv1(str);
    } catch {
      rejectedCorrupted++;
    }
  }
  assert.equal(rejectedCorrupted, corruptedStrings.length, 'All corrupted strings must be rejected');

  results.schemaFuzzing = {
    totalFuzzTests: fuzzCount,
    anomaliesFound: anomalies.length,
    anomalies,
    roundTripBrokenOnNan: roundTripBroken,
    status: anomalies.length > 0 ? 'ANOMALIES_DISCOVERED' : 'PASS'
  };

  console.log(`[Stress 4] COMPLETED: ${fuzzCount} fuzz tests executed, ${anomalies.length} vulnerabilities/anomalies cataloged.`);
}

// ----------------------------------------------------------------------------
// Test 5: Mod Law AST Scanner Edge Cases
// ----------------------------------------------------------------------------
async function runModLawAstEdgeCases() {
  console.log('[Stress 5] Mod Law Static AST Gate: Testing alternative import/export syntax...');
  const edgeCases = [
    { code: "import 'node:path';", expectCatch: true, name: 'Side-effect node:* import' },
    { code: "export * from 'node:os';", expectCatch: true, name: 'Export wildcard from node:*' },
    { code: "export { spawn } from 'node:child_process';", expectCatch: true, name: 'Export named from node:*' },
    { code: "const x = { $: 123 };", expectCatch: true, name: 'Object property with $ key' }
  ];

  const missedGates = [];
  for (const ec of edgeCases) {
    const res = checkModLaws(ec.code);
    const caught = !res.valid;
    if (ec.expectCatch && !caught) {
      missedGates.push({ name: ec.name, code: ec.code });
    }
  }

  results.astEdgeCases = {
    testedCount: edgeCases.length,
    missedGates,
    status: missedGates.length > 0 ? 'GATE_GAPS_IDENTIFIED' : 'PASS'
  };

  console.log(`[Stress 5] COMPLETED: ${edgeCases.length} AST patterns tested, ${missedGates.length} potential gaps identified.`);
}

async function main() {
  await runConcurrencyStress();
  await runFileLockingStress();
  await runIpcBenchmark();
  await runSchemaFuzzing();
  await runModLawAstEdgeCases();

  // Final empirical verdict
  const isConfirmed = results.concurrency.status === 'PASS' &&
                      results.fileLocking.status === 'PASS' &&
                      results.ipcPingPong.slaMet === true;

  results.verdict = isConfirmed ? 'CONFIRMED' : 'REJECTED';
  console.log('\n======================================================');
  console.log(`FINAL EMPIRICAL VERDICT: ${results.verdict}`);
  console.log('======================================================');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Adversarial Harness Error:', err);
  process.exit(1);
});
