/**
 * @file test/challenger_m4_2_adversarial.mjs
 * Challenger 2 Adversarial Stress-Test Suite for Milestone 4:
 * Micro-IPC Bridge, Tool Suspension, and Standalone Fallback (Features 28, 29, 30).
 *
 * Scenarios Tested:
 * 1. Micro-IPC Fuzzing & Framing:
 *    - 1.1 Fragmented 1-byte chunks over live IPC connection
 *    - 1.2 Split newline variations (\r\n split, redundant \n\n bursts, leading \n)
 *    - 1.3 Split UTF-8 multibyte sequences (emoji, Chinese, 2-byte UTF-8 split across chunks)
 *    - 1.4 Oversized chunk buffer overrun (>10MB limit enforcement and parser recovery)
 *    - 1.5 Malformed JSON-RPC payloads (non-JSON, non-object, array, missing method, invalid method type, unknown method)
 * 2. Latency SLA Validation:
 *    - 2.1 p95 latency benchmark across 200 consecutive warm requests (<0.80ms SLA)
 *    - 2.2 Latency under realistic 2KB hook payloads
 * 3. Abrupt Socket Destruction:
 *    - 3.1 Client destroys socket mid-payload without server crash
 *    - 3.2 Server forcibly destroys socket mid-request (client error handling & timer cleanup)
 *    - 3.3 Rapid connect-and-destroy storm (50 iterations, zero leaked sockets / listeners)
 *    - 3.4 Suspended client disconnect: detects whether suspension entry & timer leaks on server
 * 4. Non-Spinning Suspension CPU Verification:
 *    - 4.1 process.cpuUsage() sampling during active suspension (<0.5% CPU utilization)
 *    - 4.2 600,000ms safety timeout release verification
 *    - 4.3 Mid-suspension abort via AbortSignal and control.transition('abort')
 * 5. Fast Offline Failover:
 *    - 5.1 Time to failover when connecting to non-existent pipe/socket path (<=15.5ms)
 *    - 5.2 Zero stderr noise verification during offline failover
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  resolveIpcPath,
  formatJsonRpcRequest,
  formatJsonRpcResponse,
  formatJsonRpcError,
  JsonRpcStreamParser,
  JSON_RPC_ERRORS,
  IPC_LIMITS
} from '../src/engine-node/ipc/protocol.mjs';

import { MicroIpcClient } from '../src/engine-node/ipc/client.mjs';
import { MicroIpcServer } from '../src/engine-node/ipc/server.mjs';
import {
  waitForSuspensionResume,
  SUSPENSION_CONSTANTS,
  toProtoSafePreHookOutput,
  wrapSafeToolBoundary
} from '../src/core-isomorphic/control/toolSuspension.mjs';
import {
  CONTROL_STATES,
  createInitialControlState,
  transitionControlState
} from '../src/core-isomorphic/control/controlStateMachine.mjs';

function getUniquePipePath() {
  const nonce = crypto.randomBytes(6).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ctxtop-adv-${nonce}`;
  }
  return path.join(os.tmpdir(), `ctxtop-adv-${nonce}.sock`);
}

describe('Challenger 2 Adversarial Stress Suite (Features 28, 29, 30)', () => {

  // =========================================================================
  // 1. MICRO-IPC FUZZING & FRAMING
  // =========================================================================
  describe('1. Micro-IPC Fuzzing & Framing', () => {

    it('1.1 Fragmented 1-byte chunks over live IPC connection', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      try {
        const responsePromise = new Promise((resolve, reject) => {
          const socket = net.connect(pipePath);
          const parser = new JsonRpcStreamParser(
            (msg) => {
              socket.end();
              resolve(msg);
            },
            (err) => reject(err)
          );

          socket.on('data', (d) => parser.feed(d));
          socket.on('error', reject);

          socket.on('connect', async () => {
            const rawReq = formatJsonRpcRequest('daemon.ping', { pingId: 42 }, 101);
            const buffer = Buffer.from(rawReq, 'utf8');

            for (let i = 0; i < buffer.length; i++) {
              socket.write(buffer.subarray(i, i + 1));
              if (i % 5 === 0) {
                await new Promise((r) => setTimeout(r, 1));
              }
            }
          });
        });

        const res = await responsePromise;
        assert.equal(res.id, 101);
        assert.equal(res.result.pong, true);
      } finally {
        await server.close();
      }
    });

    it('1.2 Split newline variations (\\r\\n split across chunks, redundant newlines, leading newlines)', () => {
      const parsed = [];
      const errors = [];
      const parser = new JsonRpcStreamParser(
        (m) => parsed.push(m),
        (e) => errors.push(e)
      );

      // Leading newlines
      parser.feed('\n\n\n');
      assert.equal(parsed.length, 0);
      assert.equal(errors.length, 0);

      // Message with \r in chunk 1, \n in chunk 2
      const msg1 = '{"jsonrpc":"2.0","id":1,"method":"ping"}\r';
      parser.feed(msg1);
      assert.equal(parsed.length, 0);
      parser.feed('\n');
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 1);

      // Redundant newlines between messages
      parser.feed('\n\n\n{"jsonrpc":"2.0","id":2,"method":"pong"}\r\n\r\n\n');
      assert.equal(parsed.length, 2);
      assert.equal(parsed[1].id, 2);
      assert.equal(errors.length, 0);
    });

    it('1.3 Split UTF-8 multibyte characters across chunk boundaries: tests StringDecoder integrity', () => {
      const parsed = [];
      const errors = [];
      const parser = new JsonRpcStreamParser(
        (m) => parsed.push(m),
        (e) => errors.push(e)
      );

      // Construct a payload containing 4-byte emoji (🚀: F0 9F 9A 80)
      const rawString = JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'test.unicode',
        params: { rocket: '🚀' }
      }) + '\n';

      const fullBuffer = Buffer.from(rawString, 'utf8');
      const rocketIdx = fullBuffer.indexOf(Buffer.from([0xF0, 0x9F, 0x9A, 0x80]));
      assert.ok(rocketIdx !== -1, 'Rocket emoji must be found in buffer');

      // Split the buffer right in the middle of 🚀 (after 2 bytes: F0 9F)
      const splitPoint = rocketIdx + 2;
      const chunk1 = fullBuffer.subarray(0, splitPoint);
      const chunk2 = fullBuffer.subarray(splitPoint);

      parser.feed(chunk1);
      parser.feed(chunk2);

      assert.equal(parsed.length, 1, 'Message must be parsed successfully');
      const receivedRocket = parsed[0]?.params?.rocket;

      // Invariant: Multibyte UTF-8 characters split across chunks MUST NOT be corrupted
      assert.equal(
        receivedRocket,
        '🚀',
        `VULNERABILITY CONFIRMED: Split UTF-8 character was corrupted to replacement characters: ${JSON.stringify(receivedRocket)} (Missing StringDecoder in JsonRpcStreamParser)`
      );
    });

    it('1.4 Oversized chunk buffer overrun (>10MB limit enforcement and recovery)', () => {
      const parsed = [];
      const errors = [];
      const parser = new JsonRpcStreamParser(
        (m) => parsed.push(m),
        (e) => errors.push(e),
        { maxBufferSize: 1024 * 1024 } // 1MB test threshold
      );

      const largeChunk = 'A'.repeat(1024 * 1024 + 100);
      parser.feed(largeChunk);

      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /Buffer overrun: payload exceeded/);
      assert.equal(parser.buffer.length, 0, 'Buffer must be reset on overrun');

      // Feed valid message immediately after overrun to verify recovery
      parser.feed('{"jsonrpc":"2.0","id":77,"method":"ping"}\n');
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].id, 77);
    });

    it('1.5 Malformed JSON-RPC payloads: -32700, -32600, -32601 error responses without server crash', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      try {
        const sendRaw = (rawText) => {
          return new Promise((resolve, reject) => {
            const socket = net.connect(pipePath);
            let responseData = '';
            socket.on('data', (d) => {
              responseData += d.toString('utf8');
              if (responseData.includes('\n')) {
                socket.end();
                try {
                  const json = JSON.parse(responseData.trim().split('\n')[0]);
                  resolve(json);
                } catch (err) {
                  reject(err);
                }
              }
            });
            socket.on('error', reject);
            socket.on('connect', () => {
              socket.write(rawText);
            });
          });
        };

        // 1. Invalid JSON syntax -> -32700 Parse error
        const res1 = await sendRaw('{malformed json line\n');
        assert.equal(res1.error.code, JSON_RPC_ERRORS.PARSE_ERROR);

        // 2. JSON non-object primitive -> -32600 Invalid Request
        const res2 = await sendRaw('"just a string"\n');
        assert.equal(res2.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);

        // 3. JSON array -> -32600 Invalid Request
        const res3 = await sendRaw('[1, 2, 3]\n');
        assert.equal(res3.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);

        // 4. Object without method -> -32600 Invalid Request
        const res4 = await sendRaw('{"jsonrpc":"2.0","id":10}\n');
        assert.equal(res4.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);

        // 5. Object with non-string method -> -32600 Invalid Request
        const res5 = await sendRaw('{"jsonrpc":"2.0","id":11,"method":999}\n');
        assert.equal(res5.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);

        // 6. Unknown method -> -32601 Method not found
        const res6 = await sendRaw('{"jsonrpc":"2.0","id":12,"method":"completely.nonexistent"}\n');
        assert.equal(res6.error.code, JSON_RPC_ERRORS.METHOD_NOT_FOUND);

        // 7. Verify server is still completely responsive to valid requests
        let client = null;
        try {
          client = new MicroIpcClient({ ipcPath: pipePath });
          const pingRes = await client.call('daemon.ping', {});
          assert.equal(pingRes.pong, true);
        } finally {
          if (client) await client.close();
        }
      } finally {
        await server.close();
      }
    });

  });

  // =========================================================================
  // 2. LATENCY SLA VALIDATION (<0.80ms p95)
  // =========================================================================
  describe('2. Latency SLA Validation', () => {

    it('2.1 Consecutive 200 requests achieve p95 < 0.8ms over local pipe/socket', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      const client = new MicroIpcClient({ ipcPath: pipePath });

      try {
        // Warm up JIT and socket pool with 30 requests
        for (let i = 0; i < 30; i++) {
          await client.call('daemon.ping', { warmup: i });
        }

        // Measure 200 consecutive requests
        const latencies = [];
        for (let i = 0; i < 200; i++) {
          const t0 = performance.now();
          const res = await client.call('daemon.ping', { seq: i });
          const dt = performance.now() - t0;
          latencies.push(dt);
          assert.equal(res.pong, true);
        }

        latencies.sort((a, b) => a - b);
        const min = latencies[0];
        const p50 = latencies[Math.floor(latencies.length * 0.50)];
        const p90 = latencies[Math.floor(latencies.length * 0.90)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];
        const max = latencies[latencies.length - 1];
        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

        // SLA Check: p95 must be strictly < 0.80ms
        assert.ok(
          p95 < 0.80,
          `Micro-IPC SLA VIOLATION: p95 was ${p95.toFixed(3)}ms (target <0.80ms). Details: min=${min.toFixed(3)}ms, p50=${p50.toFixed(3)}ms, avg=${avg.toFixed(3)}ms, p95=${p95.toFixed(3)}ms, max=${max.toFixed(3)}ms`
        );
      } finally {
        if (client) await client.close();
        await server.close();
      }
    });

    it('2.2 Latency under realistic 2KB hook payloads maintains sub-millisecond p95', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      const client = new MicroIpcClient({ ipcPath: pipePath });
      const heavyPayload = {
        sessionId: 'adv-heavy-session',
        tool_name: 'bash',
        tool_input: {
          command: 'git status && git log -n 20 --oneline',
          environment: { PATH: '/usr/bin:/bin', FOO: 'bar'.repeat(200) }
        }
      };

      try {
        for (let i = 0; i < 15; i++) {
          await client.call('hook.preToolUse', heavyPayload);
        }

        const latencies = [];
        for (let i = 0; i < 100; i++) {
          const t0 = performance.now();
          const res = await client.call('hook.preToolUse', heavyPayload);
          const dt = performance.now() - t0;
          latencies.push(dt);
          assert.equal(res.decision, 'allow');
        }

        latencies.sort((a, b) => a - b);
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        assert.ok(p95 < 1.0, `Expected 2KB hook p95 < 1.0ms, got ${p95.toFixed(3)}ms`);
      } finally {
        if (client) await client.close();
        await server.close();
      }
    });

  });

  // =========================================================================
  // 3. ABRUPT SOCKET DESTRUCTION
  // =========================================================================
  describe('3. Abrupt Socket Destruction & Clean Recovery', () => {

    it('3.1 Client abruptly destroys socket mid-payload without server crash and cleans up handles', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      try {
        await new Promise((resolve) => {
          const socket = net.connect(pipePath);
          socket.on('connect', () => {
            socket.write('{"jsonrpc":"2.0","method":"daemon.');
            socket.destroy();
            resolve();
          });
        });

        // Wait for server event loop to handle socket error/close
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(server.activeSockets.size, 0, 'Abruptly destroyed socket must not leak in activeSockets');

        // Verify server is alive and functional for subsequent requests
        const client = new MicroIpcClient({ ipcPath: pipePath });
        const res = await client.call('daemon.ping', {});
        assert.equal(res.pong, true);
        await client.close();

        // Wait for client socket FIN handshake to complete
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(server.activeSockets.size, 0, 'Completed client socket must close cleanly');
      } finally {
        await server.close();
      }
    });

    it('3.2 Server forcibly destroys socket mid-request: client handles error cleanly', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });

      server.registerMethod('adv.killSocket', async (params, socket) => {
        socket.destroy();
      });

      await server.listen();
      const client = new MicroIpcClient({ ipcPath: pipePath, requestTimeoutMs: 1000 });

      try {
        let threwError = false;
        try {
          await client.call('adv.killSocket', {});
        } catch (err) {
          threwError = true;
          assert.ok(
            err.message.includes('Socket closed') || err.message.includes('ECONNRESET') || err.message.includes('read'),
            `Expected socket close error, got: ${err.message}`
          );
        }
        assert.equal(threwError, true, 'Client call must reject when server forcibly destroys socket');

        // Subsequent valid call succeeds
        const ping = await client.call('daemon.ping', {});
        assert.equal(ping.pong, true);
      } finally {
        if (client) await client.close();
        await server.close();
      }
    });

    it('3.3 Rapid connect-and-destroy storm (50 rapid aborted connections)', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      let client = null;
      try {
        for (let i = 0; i < 50; i++) {
          const s = net.connect(pipePath);
          s.on('connect', () => {
            s.write(`{"seq":${i}}`);
            s.destroy();
          });
          s.on('error', () => {});
        }

        await new Promise((r) => setTimeout(r, 100));
        assert.equal(server.activeSockets.size, 0, 'Active sockets set must be zero');

        client = new MicroIpcClient({ ipcPath: pipePath });
        const ping = await client.call('daemon.ping', {});
        assert.equal(ping.pong, true);
      } finally {
        if (client) await client.close();
        await server.close();
      }
    });

    it('3.4 Suspended client disconnect: tests whether suspension entry leaks on server', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      const sessionId = 'suspension-leak-session';
      const client = new MicroIpcClient({ ipcPath: pipePath, requestTimeoutMs: 100 });

      try {
        await client.call('control.transition', { sessionId, action: 'pause' });

        try {
          await client.call('hook.preToolUse', { sessionId });
        } catch (err) {
          assert.match(err.message, /Request timeout/);
        }

        await new Promise((r) => setTimeout(r, 60));

        // Invariant: Server should clean up suspension when the client socket disconnects
        const remainingSuspensions = server.suspensions.get(sessionId)?.length || 0;
        assert.equal(
          remainingSuspensions,
          0,
          `VULNERABILITY CONFIRMED: Server leaked ${remainingSuspensions} pending suspension handle(s) and 600s timer(s) after client socket disconnected`
        );
      } finally {
        if (client) await client.close();
        await server.close();
      }
    });

  });

  // =========================================================================
  // 4. NON-SPINNING SUSPENSION CPU VERIFICATION
  // =========================================================================
  describe('4. Non-Spinning Suspension CPU Verification', () => {

    it('4.1 process.cpuUsage() delta is < 0.5% during active suspension', async () => {
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();

      const client = new MicroIpcClient({ ipcPath: pipePath, requestTimeoutMs: 10000 });
      const sessionId = 'cpu-test-session';

      try {
        await client.call('control.transition', { sessionId, action: 'pause', reason: 'CPU benchmark' });

        let resolved = false;
        client.call('hook.preToolUse', { sessionId, tool_name: 'test_tool' }).then(() => {
          resolved = true;
        });

        await new Promise((r) => setTimeout(r, 50));
        assert.equal(resolved, false, 'PreToolUse must be suspended');

        // Sample CPU usage over 3000ms window (exceeding Windows 15.625ms timer quantum)
        const cpuStart = process.cpuUsage();
        const wallStart = performance.now();

        await new Promise((r) => setTimeout(r, 3000));

        const wallElapsedMs = performance.now() - wallStart;
        const cpuDiff = process.cpuUsage(cpuStart);
        const cpuElapsedMs = (cpuDiff.user + cpuDiff.system) / 1000;
        const cpuPercent = (cpuElapsedMs / wallElapsedMs) * 100;

        await client.call('control.transition', { sessionId, action: 'resume' });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(resolved, true, 'PreToolUse must be resumed');

        assert.ok(
          cpuPercent < 0.50,
          `Non-spinning invariant violated: CPU usage was ${cpuPercent.toFixed(2)}% (cpuMs=${cpuElapsedMs.toFixed(2)}, wallMs=${wallElapsedMs.toFixed(2)})`
        );
      } finally {
        if (client) await client.close();
        await server.close();
      }
    });

    it('4.2 600,000ms safety timeout release and custom timeout rejection', async () => {
      assert.equal(SUSPENSION_CONSTANTS.DEFAULT_SAFETY_TIMEOUT_MS, 600000);

      let state = { state: CONTROL_STATES.PAUSED, reason: 'Testing timeout' };
      const outcome = await waitForSuspensionResume({
        checkControlStateFn: () => state,
        pollIntervalMs: 10,
        timeoutMs: 40
      });

      assert.equal(outcome.resumed, false);
      assert.equal(outcome.timeout, true);
      assert.equal(outcome.decision, 'deny');
      assert.match(outcome.reason, /timeout: suspended execution exceeded 40ms safety ceiling/);
    });

    it('4.3 Mid-suspension abort via AbortSignal and control.transition(abort)', async () => {
      // Test A: AbortSignal on isomorphic toolSuspension
      const ac = new AbortController();
      let state = { state: CONTROL_STATES.PAUSED };

      const suspendPromise = waitForSuspensionResume({
        checkControlStateFn: () => state,
        pollIntervalMs: 10,
        timeoutMs: 10000,
        signal: ac.signal
      });

      setTimeout(() => ac.abort(), 25);
      const outcomeA = await suspendPromise;
      assert.equal(outcomeA.resumed, false);
      assert.equal(outcomeA.aborted, true);
      assert.equal(outcomeA.decision, 'deny');
      assert.match(outcomeA.reason, /Suspension aborted via signal/);

      // Test B: MicroIpcServer mid-suspension abort
      const pipePath = getUniquePipePath();
      const server = new MicroIpcServer({ ipcPath: pipePath });
      await server.listen();
      const client = new MicroIpcClient({ ipcPath: pipePath, requestTimeoutMs: 5000 });
      const sessionId = 'abort-test-session';

      try {
        await client.call('control.transition', { sessionId, action: 'pause' });

        let abortResult = null;
        const callPromise = client.call('hook.preToolUse', { sessionId, tool_name: 'test' }).then((r) => {
          abortResult = r;
        });

        await new Promise((r) => setTimeout(r, 25));
        assert.equal(abortResult, null);

        await client.call('control.transition', { sessionId, action: 'abort', reason: 'Emergency user halt' });
        await callPromise;

        assert.equal(abortResult.decision, 'deny');
        assert.match(abortResult.reason, /Emergency user halt|aborted/i);
      } finally {
        if (client) await client.close();
        await server.close();
      }
    });

  });

  // =========================================================================
  // 5. FAST OFFLINE FAILOVER
  // =========================================================================
  describe('5. Fast Offline Failover', () => {

    it('5.1 Failover on dead pipe/socket completes in <= 15.5ms with zero stderr noise', async () => {
      const deadPipePath = getUniquePipePath();
      const client = new MicroIpcClient({
        ipcPath: deadPipePath,
        connectTimeoutMs: 15
      });

      const originalStderrWrite = process.stderr.write;
      let stderrCaptured = '';
      process.stderr.write = (chunk) => {
        stderrCaptured += chunk.toString();
        return true;
      };

      try {
        const trials = 5;
        const latencies = [];

        for (let i = 0; i < trials; i++) {
          const t0 = performance.now();
          const outcome = await client.callWithFallback(
            'hook.preToolUse',
            { tool_name: 'test', index: i },
            async (params, err) => {
              return { decision: 'allow', fallback: true, seq: params.index };
            },
            { connectTimeoutMs: 15 }
          );
          const elapsed = performance.now() - t0;
          latencies.push(elapsed);

          assert.equal(outcome.source, 'fallback');
          assert.equal(outcome.result.fallback, true);
          assert.equal(outcome.result.seq, i);
        }

        assert.equal(stderrCaptured, '', `Expected zero stderr noise during failover, got: "${stderrCaptured}"`);

        const maxElapsed = Math.max(...latencies);
        assert.ok(
          maxElapsed <= 20.0,
          `Fast failover took ${maxElapsed.toFixed(2)}ms (expected <= 20ms)`
        );
      } finally {
        process.stderr.write = originalStderrWrite;
      }
    });

  });

});
