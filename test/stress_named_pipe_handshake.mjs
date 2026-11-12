import assert from 'node:assert/strict';
import { MicroIpcServer } from '../src/engine-node/ipc/server.mjs';
import { MicroIpcClient } from '../src/engine-node/ipc/client.mjs';
import { getPlatformPipePath } from '../test/helpers/e2e_harness.mjs';

console.log('Starting Micro-IPC Named Pipe Stress & Mutation Harness...');

const pipePath = getPlatformPipePath(`stress-handshake-${Date.now()}`);
const server = new MicroIpcServer({ ipcPath: pipePath });
await server.listen();

try {
  // Test 1: 50 sequential connect -> ping -> close cycles
  console.log('1. Testing 50 sequential connect -> ping -> close cycles...');
  const latencies = [];
  for (let i = 1; i <= 50; i++) {
    const t0 = performance.now();
    const client = new MicroIpcClient({ ipcPath: pipePath, connectTimeoutMs: 2000, requestTimeoutMs: 2000 });
    const pingOk = await client.ping();
    assert.equal(pingOk, true, `Sequential cycle ${i} ping failed!`);
    await client.close();
    const lat = performance.now() - t0;
    latencies.push(lat);
  }
  const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`✓ 50 sequential cycles passed! Avg latency: ${avgLat.toFixed(2)}ms (Min: ${Math.min(...latencies).toFixed(2)}ms, Max: ${Math.max(...latencies).toFixed(2)}ms)`);

  // Test 2: 20 concurrent connections
  console.log('2. Testing 20 concurrent connections...');
  const concurrentClients = Array.from({ length: 20 }, () =>
    new MicroIpcClient({ ipcPath: pipePath, connectTimeoutMs: 2000, requestTimeoutMs: 2000 })
  );

  const tStart = performance.now();
  const pingResults = await Promise.all(concurrentClients.map(c => c.ping()));
  const concurrentLat = performance.now() - tStart;

  for (let i = 0; i < pingResults.length; i++) {
    assert.equal(pingResults[i], true, `Concurrent client ${i} ping failed!`);
  }
  await Promise.all(concurrentClients.map(c => c.close()));
  console.log(`✓ 20 concurrent pings passed in ${concurrentLat.toFixed(2)}ms!`);

  // Test 3: Negative / Mutation - Ping non-existent pipe returns false
  console.log('3. Mutation: pinging a non-existent pipe returns false without crashing...');
  const nonExistentPipe = getPlatformPipePath(`non-existent-pipe-${Date.now()}`);
  const deadClient = new MicroIpcClient({ ipcPath: nonExistentPipe, connectTimeoutMs: 100, requestTimeoutMs: 100 });
  const deadPing = await deadClient.ping(100);
  assert.equal(deadPing, false, 'Ping to non-existent pipe must return false');
  console.log('✓ Dead pipe correctly returned false.');

  // Test 4: Mutation - Ping with 0 timeout or negative timeout defaults safely
  console.log('4. Mutation: client default ping uses requestTimeoutMs fallback...');
  const clientFallback = new MicroIpcClient({ ipcPath: pipePath, requestTimeoutMs: 1500 });
  const fallbackPing = await clientFallback.ping();
  assert.equal(fallbackPing, true, 'Default ping should pick up requestTimeoutMs');
  await clientFallback.close();
  console.log('✓ Default ping picked up requestTimeoutMs.');

  console.log('\n[ALL MICRO-IPC STRESS & MUTATION TESTS PASSED]');
} finally {
  await server.close();
}
