import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  createMockUSTFTrajectory,
  validateUSTFv1,
  serializeUSTFv1,
  deserializeUSTFv1,
  startMockIpcServer,
  sendIpcMessage,
  stopIpcServer,
  getPlatformPipePath
} from './e2e_harness.mjs';

const report = {
  fuzzing: { total: 0, passedRejections: 0, anomalies: [] },
  framing: { total: 0, passed: 0, failures: [] },
  latencySla: null,
  verdict: 'PENDING'
};

// ============================================================================
// 1. USTF v1 Adversarial Fuzzing
// ============================================================================
console.log('=== TARGET 1: USTF v1 Adversarial Fuzzing ===');

function createCompliantBase() {
  return createMockUSTFTrajectory({ turnsCount: 2 });
}

const targetFields = [
  { name: 'createdAt', setter: (t, v) => { t.createdAt = v; } },
  { name: 'turns[0].turnIndex', setter: (t, v) => { t.turns[0].turnIndex = v; } },
  { name: 'turns[0].ttftMs', setter: (t, v) => { t.turns[0].ttftMs = v; } },
  { name: 'turns[0].usage.uncached', setter: (t, v) => { t.turns[0].usage.uncached = v; } },
  { name: 'turns[0].usage.cacheWrite5m', setter: (t, v) => { t.turns[0].usage.cacheWrite5m = v; } },
  { name: 'turns[0].usage.cacheWrite1h', setter: (t, v) => { t.turns[0].usage.cacheWrite1h = v; } },
  { name: 'turns[0].usage.cacheRead', setter: (t, v) => { t.turns[0].usage.cacheRead = v; } },
  { name: 'turns[0].usage.thinking', setter: (t, v) => { t.turns[0].usage.thinking = v; } },
  { name: 'turns[0].usage.output', setter: (t, v) => { t.turns[0].usage.output = v; } }
];

const adversarialNumericValues = [
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: '-Infinity', value: -Infinity },
  { label: 'negative integer (-1)', value: -1 },
  { label: 'negative float (-0.001)', value: -0.001 }
];

for (const field of targetFields) {
  for (const { label, value } of adversarialNumericValues) {
    report.fuzzing.total++;
    const t = createCompliantBase();
    field.setter(t, value);
    const res = validateUSTFv1(t);
    if (res.valid) {
      report.fuzzing.anomalies.push({
        field: field.name,
        value: label,
        anomaly: 'ACCEPTED_INVALID_NUMERIC',
        errors: res.errors
      });
      console.error(`[FAIL] Field ${field.name} accepted invalid numeric value ${label}`);
    } else {
      report.fuzzing.passedRejections++;
    }
  }
}

// Float turnIndex fuzzing
const nonIntegerTurnIndices = [
  3.14159,
  0.0001,
  1e-7,
  Number.MIN_VALUE,
  Number.EPSILON,
  -1,
  -1.5,
  NaN,
  Infinity
];

for (const nonInt of nonIntegerTurnIndices) {
  report.fuzzing.total++;
  const t = createCompliantBase();
  t.turns[0].turnIndex = nonInt;
  const res = validateUSTFv1(t);
  if (res.valid) {
    report.fuzzing.anomalies.push({
      field: 'turnIndex',
      value: String(nonInt),
      anomaly: 'ACCEPTED_NON_INTEGER_TURN_INDEX'
    });
    console.error(`[FAIL] turnIndex accepted non-integer: ${nonInt}`);
  } else {
    report.fuzzing.passedRejections++;
  }
}

// prefixHash64 adversarial fuzzing
const adversarialHashes = [
  { val: 'gggggggggggggggg', desc: '16 non-hex chars (g)' },
  { val: 'zzzzzzzzzzzzzzzz', desc: '16 non-hex chars (z)' },
  { val: '0123456789abcdef0', desc: '17 hex chars (too long)' },
  { val: '0123456789abcde', desc: '15 hex chars (too short)' },
  { val: '', desc: 'empty string' },
  { val: '                ', desc: '16 spaces' },
  { val: '0123456789abcde ', desc: '15 hex + 1 space' },
  { val: '0123456789abcde\n', desc: '15 hex + newline' },
  { val: '0123456789abcde\x00', desc: '15 hex + null byte' },
  { val: '⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡', desc: '16 unicode emojis' },
  { val: 1234567890123456, desc: 'numeric instead of string' },
  { val: null, desc: 'null' },
  { val: undefined, desc: 'undefined' }
];

for (const { val, desc } of adversarialHashes) {
  report.fuzzing.total++;
  const t = createCompliantBase();
  t.turns[0].prefixHash64 = val;
  const res = validateUSTFv1(t);
  if (res.valid) {
    report.fuzzing.anomalies.push({
      field: 'prefixHash64',
      value: desc,
      anomaly: 'ACCEPTED_INVALID_PREFIX_HASH'
    });
    console.error(`[FAIL] prefixHash64 accepted invalid value: ${desc}`);
  } else {
    report.fuzzing.passedRejections++;
  }
}

// Positive tests for prefixHash64: valid 16-hex lower, upper, mixed
const validHashes = [
  '0123456789abcdef',
  '0123456789ABCDEF',
  'aAbBcCdDeEfF0123',
  'ffffffffffffffff',
  '0000000000000000'
];

for (const validHash of validHashes) {
  const t = createCompliantBase();
  t.turns[0].prefixHash64 = validHash;
  const res = validateUSTFv1(t);
  assert.equal(res.valid, true, `Valid prefixHash64 ${validHash} should pass`);
}

// Serialization / Deserialization check with valid base
{
  const t = createCompliantBase();
  const serialized = serializeUSTFv1(t);
  const deserialized = deserializeUSTFv1(serialized);
  assert.equal(deserialized.sessionId, t.sessionId);
  assert.equal(deserialized.turns.length, t.turns.length);
  assert.equal(deserialized.metrics.totalTokens, t.metrics.totalTokens);
}

console.log(`[USTF Fuzzing] Total tested: ${report.fuzzing.total}, Passed rejections: ${report.fuzzing.passedRejections}, Anomalies: ${report.fuzzing.anomalies.length}`);

// ============================================================================
// 2. sendIpcMessage Framing & Multi-Chunk Responses
// ============================================================================
console.log('\n=== TARGET 2: sendIpcMessage Framing & Multi-Chunk Handling ===');

async function testFramingScenarios() {
  // Scenario 2.1: Multi-chunk split response (response arrived across multiple small TCP/socket packets)
  {
    report.framing.total++;
    const pipePath = getPlatformPipePath('bench-framing-chunks');
    const srv = net.createServer((socket) => {
      socket.on('data', () => {
        // Send response in 4 separate chunks with tiny delays
        const part1 = '{"jsonrpc": "2.0", ';
        const part2 = '"id": 42, ';
        const part3 = '"result": {"status": "ok", "split": true}';
        const part4 = '}\n';

        socket.write(part1);
        setTimeout(() => {
          socket.write(part2);
          setTimeout(() => {
            socket.write(part3);
            setTimeout(() => {
              socket.write(part4);
            }, 5);
          }, 5);
        }, 5);
      });
    });

    await new Promise((r) => srv.listen(pipePath, r));
    try {
      const res = await sendIpcMessage(pipePath, { method: 'test' }, { timeoutMs: 2000 });
      assert.equal(res.id, 42);
      assert.equal(res.result.status, 'ok');
      assert.equal(res.result.split, true);
      report.framing.passed++;
      console.log('  ✔ Scenario 2.1: Multi-chunk split response reassembled and parsed correctly');
    } catch (err) {
      report.framing.failures.push({ scenario: 'Multi-chunk split', error: err.message });
      console.error('  ✘ Scenario 2.1 Failed:', err.message);
    } finally {
      await stopIpcServer(srv, pipePath);
    }
  }

  // Scenario 2.2: Multi-line response in single chunk (first line extracted, remainder ignored without syntax error)
  {
    report.framing.total++;
    const pipePath = getPlatformPipePath('bench-framing-multiline');
    const srv = net.createServer((socket) => {
      socket.on('data', () => {
        // Send two newline-delimited JSON objects + trailing partial content in ONE single write
        socket.write('{"jsonrpc": "2.0", "id": 1, "result": "first"}\n{"jsonrpc": "2.0", "id": 2, "result": "second"}\n{"trailing":');
      });
    });

    await new Promise((r) => srv.listen(pipePath, r));
    try {
      const res = await sendIpcMessage(pipePath, { method: 'test' });
      assert.equal(res.id, 1);
      assert.equal(res.result, 'first');
      report.framing.passed++;
      console.log('  ✔ Scenario 2.2: Multi-line response in single chunk: first line parsed cleanly');
    } catch (err) {
      report.framing.failures.push({ scenario: 'Multi-line single chunk', error: err.message });
      console.error('  ✘ Scenario 2.2 Failed:', err.message);
    } finally {
      await stopIpcServer(srv, pipePath);
    }
  }

  // Scenario 2.3: Large payload (64KB JSON response) delivered across streaming buffers
  {
    report.framing.total++;
    const pipePath = getPlatformPipePath('bench-framing-large');
    const largeData = 'A'.repeat(64 * 1024);
    const expectedResponse = { jsonrpc: '2.0', id: 999, data: largeData };
    const jsonString = JSON.stringify(expectedResponse) + '\n';

    const srv = net.createServer((socket) => {
      socket.on('data', () => {
        // Stream in 8KB chunks
        const chunkSize = 8192;
        for (let i = 0; i < jsonString.length; i += chunkSize) {
          socket.write(jsonString.slice(i, i + chunkSize));
        }
      });
    });

    await new Promise((r) => srv.listen(pipePath, r));
    try {
      const res = await sendIpcMessage(pipePath, { method: 'large' }, { timeoutMs: 3000 });
      assert.equal(res.id, 999);
      assert.equal(res.data.length, 64 * 1024);
      assert.equal(res.data, largeData);
      report.framing.passed++;
      console.log('  ✔ Scenario 2.3: Large payload (64KB) streamed across chunks reassembled cleanly');
    } catch (err) {
      report.framing.failures.push({ scenario: 'Large payload streaming', error: err.message });
      console.error('  ✘ Scenario 2.3 Failed:', err.message);
    } finally {
      await stopIpcServer(srv, pipePath);
    }
  }

  // Scenario 2.4: Malformed JSON before newline triggers clean rejection
  {
    report.framing.total++;
    const pipePath = getPlatformPipePath('bench-framing-malformed');
    const srv = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('{not valid json}\n');
      });
    });

    await new Promise((r) => srv.listen(pipePath, r));
    try {
      await sendIpcMessage(pipePath, { method: 'test' });
      report.framing.failures.push({ scenario: 'Malformed JSON', error: 'Did not reject malformed JSON' });
      console.error('  ✘ Scenario 2.4 Failed: did not reject malformed JSON');
    } catch (err) {
      if (err.message.includes('Malformed IPC response')) {
        report.framing.passed++;
        console.log('  ✔ Scenario 2.4: Malformed JSON rejected with "Malformed IPC response"');
      } else {
        report.framing.failures.push({ scenario: 'Malformed JSON error message mismatch', error: err.message });
      }
    } finally {
      await stopIpcServer(srv, pipePath);
    }
  }
}

await testFramingScenarios();

// ============================================================================
// 3. IPC Ping-Pong Performance & SLA Verification (< 0.80ms)
// ============================================================================
console.log('\n=== TARGET 3: IPC Ping-Pong Latency SLA Benchmark (50 iterations) ===');

async function runSlaBenchmark() {
  const server = await startMockIpcServer({ pipeName: 'bench-sla-t1-r2' });
  const ITERATIONS = 50;

  // Warmup 10 iterations
  for (let i = 0; i < 10; i++) {
    await sendIpcMessage(server.pipePath, { jsonrpc: '2.0', id: i, method: 'ping' });
  }

  // 1. One-shot connection per request (sendIpcMessage connect -> write -> read -> disconnect)
  const oneShotLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const res = await sendIpcMessage(server.pipePath, { jsonrpc: '2.0', id: i, method: 'ping' });
    const t1 = performance.now();
    assert.equal(res.id, i);
    oneShotLatencies.push(t1 - t0);
  }

  // 2. Persistent warm socket connection
  const persistentLatencies = [];
  const client = net.connect(server.pipePath);
  await new Promise((r) => client.on('connect', r));
  let buf = '';

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const linePromise = new Promise((resolve) => {
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          client.off('data', onData);
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          resolve(line);
        }
      };
      client.on('data', onData);
    });

    client.write(JSON.stringify({ jsonrpc: '2.0', id: 500 + i, method: 'ping' }) + '\n');
    const raw = await linePromise;
    const parsed = JSON.parse(raw);
    assert.equal(parsed.id, 500 + i);
    const t1 = performance.now();
    persistentLatencies.push(t1 - t0);
  }

  client.destroy();
  await server.close();

  function calcStats(arr) {
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

  const oneShotStats = calcStats(oneShotLatencies);
  const persistentStats = calcStats(persistentLatencies);
  const SLA_LIMIT = 0.80;
  const slaMet = oneShotStats.p95 < SLA_LIMIT && persistentStats.p95 < SLA_LIMIT;

  report.latencySla = {
    iterations: ITERATIONS,
    slaLimitMs: SLA_LIMIT,
    oneShotStats,
    persistentStats,
    slaMet,
    verdict: slaMet ? 'CONFIRMED' : 'REJECTED'
  };

  console.log('One-shot connection stats (ms):', JSON.stringify(oneShotStats));
  console.log('Persistent connection stats (ms):', JSON.stringify(persistentStats));
  console.log(`SLA Result (< ${SLA_LIMIT}ms): One-Shot p95 = ${oneShotStats.p95}ms | Persistent p95 = ${persistentStats.p95}ms | Status: ${slaMet ? 'PASSED' : 'FAILED'}`);
}

await runSlaBenchmark();

// ============================================================================
// Summary Verdict
// ============================================================================
const allFuzzPassed = report.fuzzing.anomalies.length === 0;
const allFramingPassed = report.framing.failures.length === 0 && report.framing.passed === report.framing.total;
const slaMet = report.latencySla && report.latencySla.slaMet;

if (allFuzzPassed && allFramingPassed && slaMet) {
  report.verdict = 'CONFIRMED';
} else {
  report.verdict = 'REJECTED';
}

console.log('\n======================================================');
console.log(`FINAL CHALLENGER VERDICT: ${report.verdict}`);
console.log('======================================================');
console.log(JSON.stringify(report, null, 2));
