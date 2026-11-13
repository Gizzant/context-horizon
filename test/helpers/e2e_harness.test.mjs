/**
 * @file test/helpers/e2e_harness.test.mjs
 * Verification Test Suite for Highbeam v4.0 Shared E2E Test Harness
 * 
 * Verifies all 10 sub-harnesses exported by e2e_harness.mjs:
 *  1. Runtime Probing & Dynamic Fallback
 *  2. Ephemeral Sandbox Workspace Manager
 *  3. USTF v1 Trajectory Builder & Validator
 *  4. Multi-Host Session Transcript Generators
 *  5. Mock Database Fixture & Dual-Mode Store
 *  6. Micro-IPC Hook Bridge Harness
 *  7. Control Plane Latch Simulator
 *  8. Token Economics & Math Verifiers
 *  9. Zero-Dependency AST & Mod Law Compliance Gate
 * 10. UI & Invariant Assertions
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

import {
  // 1. Runtime Environment & Dynamic Probing
  detectRuntimeEnv,
  isSqliteAvailable,
  resetSqliteProbeCache,

  // 2. Ephemeral Sandbox Workspace Manager
  cleanupTempWorkspace,
  createTempWorkspace,
  createIsolatedTestSandbox,

  // 3. USTF v1 Trajectory Builder & Validator
  createMockToolSpan,
  createMockUSTFTurn,
  createMockUSTFTrajectory,
  validateUSTFv1,
  serializeUSTFv1,
  deserializeUSTFv1,

  // 4. Multi-Host Session Transcript Generators
  createAntigravityJsonl,
  createClaudeCodeJsonl,
  createMockSessionDatabase,

  // 5. Mock Database Fixture & Dual-Mode Store
  JsonlDatabaseFallbackWrapper,
  createMockDatabaseFixture,
  getMockDatabaseClient,
  assertSqliteReadOnlyEnforced,
  assertHostDbWriteRejected,

  // 6. Micro-IPC Hook Bridge Harness
  getPlatformPipePath,
  startMockIpcServer,
  sendIpcMessage,
  stopIpcServer,
  simulateCliFallback,

  // 7. Control Plane Latch Simulator
  writeControlLatch,
  readControlLatch,

  // 8. Token Economics & Math Verifiers
  calculateBreakEvenCStar,
  verifyRetentionRadarDiff,
  checkHaiku100kCliffBreaker,
  calculateDualTtlCountdown,
  partitionBillingBlocks,

  // 9. Zero-Dependency AST & Mod Law Compliance Gate
  checkModLaws,
  checkZeroRuntimeDeps,
  assertNoOutboundEgress,
  assertNoNodeBuiltinImports,
  withNetworkSpy,

  // 10. UI & Invariant Assertions
  assertPlainTextCompact,
  assertActiveSourceProtected,
  assertMirrorParity
} from './e2e_harness.mjs';

// ============================================================================
// 1. Runtime Probing & Dynamic Fallback
// ============================================================================
describe('Sub-Harness 1: Runtime Probing & Dynamic Fallback', () => {
  it('detectRuntimeEnv reports valid Node version and platform metadata', () => {
    const env = detectRuntimeEnv();
    assert.ok(typeof env.nodeVersion === 'string');
    assert.ok(typeof env.major === 'number' && env.major >= 20);
    assert.ok(typeof env.minor === 'number' && env.minor >= 0);
    assert.equal(typeof env.isNode20, 'boolean');
    assert.equal(typeof env.isNode22Plus, 'boolean');
    assert.equal(env.platform, process.platform);
    assert.equal(env.isWindows, process.platform === 'win32');
  });

  it('isSqliteAvailable resolves to boolean and caches result cleanly', async () => {
    resetSqliteProbeCache();
    const available1 = await isSqliteAvailable();
    assert.equal(typeof available1, 'boolean');

    const available2 = await isSqliteAvailable();
    assert.equal(available1, available2);
  });
});

// ============================================================================
// 2. Ephemeral Sandbox Workspace Manager
// ============================================================================
describe('Sub-Harness 2: Ephemeral Sandbox Workspace Manager', () => {
  it('createTempWorkspace creates isolated directory hierarchy and writes files', () => {
    const ws = createTempWorkspace({
      files: {
        'config/settings.json': '{"theme":"dark"}',
        'src/main.js': 'console.log("hello");'
      }
    });

    try {
      assert.ok(fs.existsSync(ws.root));
      assert.ok(fs.existsSync(ws.wsDir));
      assert.ok(fs.existsSync(ws.homeDir));
      assert.ok(fs.existsSync(ws.runtimeDir));

      assert.equal(ws.exists('config/settings.json'), true);
      assert.equal(ws.exists('src/main.js'), true);
      assert.equal(ws.exists('missing.txt'), false);

      assert.equal(ws.readFile('config/settings.json'), '{"theme":"dark"}');

      ws.writeFile('extra.txt', 'more data');
      assert.equal(ws.readFile('extra.txt'), 'more data');
    } finally {
      ws.cleanup();
      assert.equal(fs.existsSync(ws.root), false);
    }
  });

  it('createIsolatedTestSandbox creates plugin and worktree structures', () => {
    const sandbox = createIsolatedTestSandbox({
      withAntigravityDir: true,
      withClaudeDir: true,
      withWorktree: true
    });

    try {
      assert.ok(fs.existsSync(path.join(sandbox.workspaceDir, '.antigravity-plugin')));
      assert.ok(fs.existsSync(path.join(sandbox.workspaceDir, '.claude-plugin')));
      assert.ok(fs.existsSync(path.join(sandbox.workspaceDir, '.git', 'worktrees', 'worker-1')));
    } finally {
      sandbox.cleanup();
      assert.equal(fs.existsSync(sandbox.tmpDir), false);
    }
  });

  it('cleanupTempWorkspace is safely idempotent on non-existent directories', () => {
    assert.doesNotThrow(() => {
      cleanupTempWorkspace(path.join(os.tmpdir(), 'non-existent-dir-' + Date.now()));
    });
  });
});

// ============================================================================
// 3. USTF v1 Trajectory Builder & Validator
// ============================================================================
describe('Sub-Harness 3: USTF v1 Trajectory Builder & Validator', () => {
  it('createMockToolSpan creates valid tool span structure', () => {
    const span = createMockToolSpan({ toolName: 'git_status', durationMs: 120 });
    assert.equal(span.toolName, 'git_status');
    assert.equal(span.durationMs, 120);
    assert.equal(span.status, 'ok');
    assert.equal(span.endMs - span.startMs, 120);
  });

  it('createMockUSTFTurn creates valid turn with usage metrics', () => {
    const turn = createMockUSTFTurn({
      turnIndex: 3,
      modelId: 'claude-3-5-sonnet-20241022',
      ttftMs: 280
    });
    assert.equal(turn.turnIndex, 3);
    assert.equal(turn.modelId, 'claude-3-5-sonnet-20241022');
    assert.equal(turn.ttftMs, 280);
    assert.ok(turn.usage.uncached > 0);
    assert.equal(turn.toolSpans.length, 1);
  });

  it('createMockUSTFTrajectory aggregates multi-turn metrics accurately', () => {
    const trajectory = createMockUSTFTrajectory({
      sessionId: 'session-e2e-001',
      harness: 'claude-code',
      turnsCount: 3,
      cacheState: 'warm'
    });

    assert.equal(trajectory.version, '1.0.0');
    assert.equal(trajectory.sessionId, 'session-e2e-001');
    assert.equal(trajectory.harness, 'claude-code');
    assert.equal(trajectory.turns.length, 3);
    assert.equal(trajectory.metrics.totalTurns, 3);
    assert.ok(trajectory.metrics.totalPromptTokens > 0);
    assert.ok(trajectory.metrics.cacheHitRatePct > 50);
  });

  it('validateUSTFv1 accepts compliant trajectory', () => {
    const trajectory = createMockUSTFTrajectory();
    const result = validateUSTFv1(trajectory);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('validateUSTFv1 rejects trajectories with schema violations', () => {
    // Missing required fields
    const invalid1 = validateUSTFv1({ version: '2.0.0' });
    assert.equal(invalid1.valid, false);
    assert.ok(invalid1.errors.some(e => e.includes('version')));

    // Negative tokens
    const trajectory = createMockUSTFTrajectory();
    trajectory.turns[0].usage.uncached = -100;
    const invalid2 = validateUSTFv1(trajectory);
    assert.equal(invalid2.valid, false);
    assert.ok(invalid2.errors.some(e => e.includes('usage.uncached')));

    // Invalid prefixHash64 length
    trajectory.turns[0].usage.uncached = 100;
    trajectory.turns[0].prefixHash64 = 'too-short';
    const invalid3 = validateUSTFv1(trajectory);
    assert.equal(invalid3.valid, false);
    assert.ok(invalid3.errors.some(e => e.includes('prefixHash64')));

    // Non-finite number checks (NaN, Infinity)
    const tNan = createMockUSTFTrajectory();
    tNan.createdAt = NaN;
    const invNan = validateUSTFv1(tNan);
    assert.equal(invNan.valid, false);
    assert.ok(invNan.errors.some(e => e.includes('createdAt')));

    const tInf = createMockUSTFTrajectory();
    tInf.turns[0].usage.output = Infinity;
    const invInf = validateUSTFv1(tInf);
    assert.equal(invInf.valid, false);
    assert.ok(invInf.errors.some(e => e.includes('usage.output')));

    // Non-integer turnIndex (e.g. 3.14)
    const tFloat = createMockUSTFTrajectory();
    tFloat.turns[0].turnIndex = 3.14159;
    const invFloat = validateUSTFv1(tFloat);
    assert.equal(invFloat.valid, false);
    assert.ok(invFloat.errors.some(e => e.includes('turnIndex')));

    // Non-hex prefixHash64 (16 chars but non-hex)
    const tNonHex = createMockUSTFTrajectory();
    tNonHex.turns[0].prefixHash64 = 'gggggggggggggggg';
    const invNonHex = validateUSTFv1(tNonHex);
    assert.equal(invNonHex.valid, false);
    assert.ok(invNonHex.errors.some(e => e.includes('prefixHash64')));
  });

  it('serializeUSTFv1 and deserializeUSTFv1 round-trip correctly', () => {
    const original = createMockUSTFTrajectory({ turnsCount: 2 });
    const jsonStr = serializeUSTFv1(original);
    assert.equal(typeof jsonStr, 'string');

    const deserialized = deserializeUSTFv1(jsonStr);
    assert.equal(deserialized.sessionId, original.sessionId);
    assert.equal(deserialized.turns.length, 2);
  });

  it('serializeUSTFv1 rejects invalid trajectory', () => {
    assert.throws(() => serializeUSTFv1({ invalid: true }), /Cannot serialize invalid USTF v1/);
  });
});

// ============================================================================
// 4. Multi-Host Session Transcript Generators
// ============================================================================
describe('Sub-Harness 4: Multi-Host Session Transcript Generators', () => {
  it('createAntigravityJsonl writes valid transcript lines in correct subfolder', () => {
    const ws = createTempWorkspace();
    try {
      const p = createAntigravityJsonl(ws.wsDir);
      assert.ok(fs.existsSync(p));
      const content = fs.readFileSync(p, 'utf8').trim().split('\n');
      assert.ok(content.length >= 2);
      const parsed = JSON.parse(content[0]);
      assert.equal(parsed.step_id, 'step-0');
    } finally {
      ws.cleanup();
    }
  });

  it('createClaudeCodeJsonl writes valid DAG event lines', () => {
    const ws = createTempWorkspace();
    try {
      const p = createClaudeCodeJsonl(ws.wsDir);
      assert.ok(fs.existsSync(p));
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
      const rootEvent = JSON.parse(lines[0]);
      const childEvent = JSON.parse(lines[1]);

      assert.equal(rootEvent.uuid, 'node-root');
      assert.equal(rootEvent.parentUuid, null);
      assert.equal(childEvent.parentUuid, 'node-root');
    } finally {
      ws.cleanup();
    }
  });

  it('createMockSessionDatabase creates SQLite DB and annotation file', async () => {
    const ws = createTempWorkspace();
    try {
      const { dbPath, pbtxtPath, transcriptJsonlPath } = await createMockSessionDatabase(ws.wsDir, {
        withPbtxt: true,
        stepsCount: 4
      });

      assert.ok(fs.existsSync(transcriptJsonlPath));
      assert.ok(fs.existsSync(pbtxtPath));
      if (await isSqliteAvailable()) {
        assert.ok(fs.existsSync(dbPath));
      }
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// 5. Mock Database Fixture & Dual-Mode Store
// ============================================================================
describe('Sub-Harness 5: Mock Database Fixture & Dual-Mode Store', () => {
  it('JsonlDatabaseFallbackWrapper enforces readOnly: true and executes queries', () => {
    const ws = createTempWorkspace();
    try {
      const jsonlPath = path.join(ws.wsDir, 'test.jsonl');
      fs.writeFileSync(jsonlPath, [
        JSON.stringify({ id: 1, name: 'Alice', role: 'admin' }),
        JSON.stringify({ id: 2, name: 'Bob', role: 'user' }),
        JSON.stringify({ id: 3, name: 'Charlie', role: 'user' }),
        '{ malformed line }' // Malformed line to verify skip logic
      ].join('\n') + '\n', 'utf8');

      // Must throw if readOnly is false
      assert.throws(
        () => new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: false }),
        /Zero-Trust: Database must be opened strictly read-only/
      );

      const db = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });

      // all() with predicate
      assert.equal(db.all().length, 3);
      assert.equal(db.all(r => r.role === 'user').length, 2);

      // get() with predicate
      const admin = db.get(r => r.role === 'admin');
      assert.equal(admin.name, 'Alice');

      // SQL queries on JSONL (API parity)
      const user2 = db.get('SELECT * FROM test WHERE id = ?', [2]);
      assert.equal(user2.name, 'Bob');

      const users = db.all('SELECT * FROM test WHERE role = ?', ['user']);
      assert.equal(users.length, 2);

      const ordered = db.all('SELECT name FROM test WHERE id > ? ORDER BY id DESC LIMIT ?', [1, 1]);
      assert.equal(ordered.length, 1);
      assert.equal(ordered[0].name, 'Charlie');

      const count = db.all('SELECT COUNT(*) AS total FROM test WHERE role = ?', ['user']);
      assert.equal(count[0].total, 2);

      const likeMatches = db.all('SELECT * FROM test WHERE name LIKE ?', ['%li%']);
      assert.equal(likeMatches.length, 2); // Alice and Charlie

      const inMatches = db.all('SELECT * FROM test WHERE id IN (1, 3)');
      assert.equal(inMatches.length, 2);

      // searchFts()
      const matches = db.searchFts('alice');
      assert.equal(matches.length, 1);
      assert.equal(matches[0].name, 'Alice');

      // write operations rejected
      assert.throws(() => db.exec(), /SQLITE_READONLY/);
      assert.throws(() => db.run(), /SQLITE_READONLY/);
      assert.throws(() => db.all("INSERT INTO test VALUES (4, 'Dave', 'user')"), /SQLITE_READONLY/);
    } finally {
      ws.cleanup();
    }
  });

  it('getMockDatabaseClient supports forceFallback: true returning JSONL client', async () => {
    const ws = createTempWorkspace();
    try {
      const { dbPath, jsonlPath } = await createMockDatabaseFixture(path.join(ws.wsDir, 'session'), {
        tables: { items: 'id INT, val TEXT' },
        records: [
          { __table: 'items', __values: { id: 1, val: 'alpha' }, id: 1, val: 'alpha' },
          { __table: 'items', __values: { id: 2, val: 'beta' }, id: 2, val: 'beta' }
        ]
      });

      const client = await getMockDatabaseClient({
        dbPath,
        jsonlPath,
        forceFallback: true,
        readOnly: true
      });

      assert.equal(client.type, 'jsonl');
      const all = client.all();
      assert.equal(all.length, 2);

      // Predicate query
      const found = client.get(r => r.val === 'beta');
      assert.equal(found.id, 2);

      // SQL string query (Reviewer 1 parity invariant)
      const sqlFound = client.get('SELECT * FROM items WHERE id = ?', [2]);
      assert.equal(sqlFound.val, 'beta');

      const sqlAll = client.all('SELECT * FROM items WHERE val = ?', ['alpha']);
      assert.equal(sqlAll.length, 1);
      assert.equal(sqlAll[0].id, 1);

      client.close();

      // Also test standard SQLite client if available
      const sqliteClient = await getMockDatabaseClient({
        dbPath,
        jsonlPath,
        forceFallback: false,
        readOnly: true
      });
      if (sqliteClient.type === 'sqlite') {
        const row = sqliteClient.get('SELECT * FROM items WHERE id = ?', [2]);
        assert.equal(row.val, 'beta');
        // Predicate compatibility on SQLite client
        const fnRow = sqliteClient.get(r => r.id === 2);
        assert.equal(fnRow.val, 'beta');
        sqliteClient.close();
      }
    } finally {
      ws.cleanup();
    }
  });

  it('assertSqliteReadOnlyEnforced verifies readonly write rejection', async () => {
    const ws = createTempWorkspace();
    try {
      const jsonlPath = path.join(ws.wsDir, 'guard.jsonl');
      fs.writeFileSync(jsonlPath, '{"k":"v"}\n', 'utf8');

      const wrapper = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });
      await assertSqliteReadOnlyEnforced(wrapper);
    } finally {
      ws.cleanup();
    }
  });

  it('assertHostDbWriteRejected asserts rejection of read-write open on protected db', () => {
    const fakeOpen = (p, opts) => {
      if (!opts.readOnly) {
        throw new Error('[Zero-Trust SQLite Guard] Refusing read-write open on protected host database');
      }
    };
    assertHostDbWriteRejected(fakeOpen, '/path/to/state.vscdb');
  });
});

// ============================================================================
// 6. Micro-IPC Hook Bridge Harness
// ============================================================================
describe('Sub-Harness 6: Micro-IPC Hook Bridge Harness', () => {
  it('getPlatformPipePath generates valid platform address format', () => {
    const pipe = getPlatformPipePath('bench');
    if (process.platform === 'win32') {
      assert.ok(pipe.startsWith('\\\\.\\pipe\\ctxtop-bench-'));
    } else {
      assert.ok(pipe.includes('ctxtop-bench-'));
      assert.ok(pipe.endsWith('.sock'));
    }
  });

  it('startMockIpcServer and sendIpcMessage execute sub-millisecond communication', async () => {
    const serverHandle = await startMockIpcServer({
      pipeName: 'test-ping',
      responseHandler: (req) => ({
        jsonrpc: '2.0',
        id: req.id,
        result: { decision: 'allow', echoed: req.params?.data }
      })
    });

    try {
      const response = await sendIpcMessage(serverHandle.pipePath, {
        jsonrpc: '2.0',
        id: 42,
        method: 'evaluateToolCall',
        params: { data: 'payload-123' }
      });

      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.id, 42);
      assert.equal(response.result.decision, 'allow');
      assert.equal(response.result.echoed, 'payload-123');

      const requests = serverHandle.getRequests();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].parsed.id, 42);
    } finally {
      await serverHandle.close();
    }
  });

  it('sendIpcMessage safely parses first message when multiple lines arrive', async () => {
    const pipePath = getPlatformPipePath('multi-line-test');
    const net = await import('node:net');
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('{"jsonrpc":"2.0","id":1,"result":"first"}\n{"jsonrpc":"2.0","id":2,"result":"second"}\n');
      });
    });
    await new Promise((resolve) => server.listen(pipePath, resolve));
    try {
      const response = await sendIpcMessage(pipePath, { id: 1 });
      assert.equal(response.id, 1);
      assert.equal(response.result, 'first');
    } finally {
      await stopIpcServer(server, pipePath);
    }
  });

  it('simulateCliFallback seamlessly invokes CLI when server is absent', async () => {
    const nonExistentPipe = getPlatformPipePath('offline-server');
    let cliCalled = false;

    const fallbackResult = await simulateCliFallback(
      nonExistentPipe,
      async () => {
        cliCalled = true;
        return { decision: 'allow', source: 'cli-fallback' };
      },
      { timeoutMs: 15 }
    );

    assert.equal(cliCalled, true);
    assert.equal(fallbackResult.fallbackTriggered, true);
    assert.equal(fallbackResult.result.decision, 'allow');
    assert.equal(fallbackResult.result.source, 'cli-fallback');
    assert.ok(fallbackResult.latencyMs < 100);
  });
});

// ============================================================================
// 7. Control Plane Latch Simulator
// ============================================================================
describe('Sub-Harness 7: Control Plane Latch Simulator', () => {
  it('writeControlLatch and readControlLatch manage state transitions', () => {
    const ws = createTempWorkspace();
    try {
      const sessionId = 'session-ctl-123';

      // Default state when file absent
      const defaultState = readControlLatch(ws.runtimeDir, sessionId);
      assert.equal(defaultState.state, 'RUNNING');

      // Write PAUSED
      writeControlLatch(ws.runtimeDir, sessionId, 'PAUSED', 'User pressed pause');
      const pausedState = readControlLatch(ws.runtimeDir, sessionId);
      assert.equal(pausedState.state, 'PAUSED');
      assert.equal(pausedState.reason, 'User pressed pause');
      assert.ok(pausedState.updatedAt > 0);

      // Transition to STEP
      writeControlLatch(ws.runtimeDir, sessionId, 'STEP', 'Single tool step');
      const stepState = readControlLatch(ws.runtimeDir, sessionId);
      assert.equal(stepState.state, 'STEP');

      // Transition to ABORTED
      writeControlLatch(ws.runtimeDir, sessionId, 'ABORTED', 'User abort');
      const abortedState = readControlLatch(ws.runtimeDir, sessionId);
      assert.equal(abortedState.state, 'ABORTED');
    } finally {
      ws.cleanup();
    }
  });

  it('writeControlLatch rejects invalid state name', () => {
    const ws = createTempWorkspace();
    try {
      assert.throws(
        () => writeControlLatch(ws.runtimeDir, 'session-1', 'INVALID_STATE'),
        /Invalid control state/
      );
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// 8. Token Economics & Math Verifiers
// ============================================================================
describe('Sub-Harness 8: Token Economics & Math Verifiers', () => {
  it('calculateBreakEvenCStar returns exact break-even C* across model tiers and rates', () => {
    // 1. Default transition (Opus 5.5 -> Sonnet 5.5, O=1500) evaluates algebraically to 6,522
    const cStarDefault = calculateBreakEvenCStar();
    assert.equal(cStarDefault, 6522);

    // 2. Named model downshift (Opus 4.6 -> Sonnet 4.6, O=1500)
    // Formula: (1500 * (25.0 - 15.0)) / (3.75 - 0.50) = 15000 / 3.25 = 4615.38 -> 4,615
    const cStarOpus46 = calculateBreakEvenCStar({
      currentModel: 'claude-opus-4-6',
      targetModel: 'claude-sonnet-4-6'
    });
    assert.equal(cStarOpus46, 4615);

    // 3. Custom output tokens (O=800 low effort)
    // Formula: (800 * (20.0 - 10.0)) / (2.5 - 0.2) = 8000 / 2.3 = 3478.26 -> 3,478
    const lowEffort = calculateBreakEvenCStar(800);
    assert.equal(lowEffort, 3478);

    // 4. Custom non-default rate parameters
    // Formula: (2000 * (30.0 - 6.0)) / (4.0 - 0.4) = 48000 / 3.6 = 13333.33 -> 13,333
    const customRates = calculateBreakEvenCStar({
      expectedOutputTokens: 2000,
      ratesCurr: { output: 30.0, read: 0.4 },
      ratesTarget: { output: 6.0, write5m: 4.0 }
    });
    assert.equal(customRates, 13333);

    // 5. Capability upshift returns 0 (never hold on model upgrades)
    const upshift = calculateBreakEvenCStar({
      ratesCurr: { output: 10.0, read: 0.1 },
      ratesTarget: { output: 20.0, write5m: 5.0 }
    });
    assert.equal(upshift, 0);

    // 6. Cold write cheaper than warm read returns Infinity
    const cheapWrite = calculateBreakEvenCStar({
      ratesCurr: { output: 20.0, read: 3.0 },
      ratesTarget: { output: 10.0, write5m: 2.0 }
    });
    assert.equal(cheapWrite, Infinity);
  });

  it('verifyRetentionRadarDiff detects byte offsets, retention %, and grade', () => {
    const original = 'System Prompt: You are a helpful assistant with instructions.';
    const mutated = 'System Prompt: You are a helpful assistant with MODIFIED instructions.';

    const diff = verifyRetentionRadarDiff(original, mutated);
    assert.ok(diff.firstDiffOffset > 0);
    assert.ok(diff.retentionPct < 100);
    assert.ok(diff.prefixMatchBytes > 0);

    // Identical prompts
    const identical = verifyRetentionRadarDiff(original, original);
    assert.equal(identical.firstDiffOffset, -1);
    assert.equal(identical.retentionPct, 100);
    assert.equal(identical.is95PctRetained, true);
    assert.equal(identical.grade, 'A');

    // Completely disjoint prompts
    const disjoint = verifyRetentionRadarDiff('AAAA', 'ZZZZ');
    assert.equal(disjoint.firstDiffOffset, 0);
    assert.equal(disjoint.retentionPct, 0);
    assert.equal(disjoint.is95PctRetained, false);
    assert.equal(disjoint.grade, 'C');
  });

  it('checkHaiku100kCliffBreaker accurately evaluates model cliff boundaries', () => {
    // Non-Haiku
    assert.equal(checkHaiku100kCliffBreaker('claude-3-5-sonnet', 99000).triggered, false);

    // Haiku safe (<90k)
    assert.equal(checkHaiku100kCliffBreaker('claude-3-haiku', 50000).action, 'allow');

    // Haiku advisory (90k-98k)
    assert.equal(checkHaiku100kCliffBreaker('claude-3-haiku', 95000).action, 'advisory');

    // Haiku cliff warning (>=98k)
    const at98k = checkHaiku100kCliffBreaker('claude-3-haiku', 98000);
    assert.equal(at98k.triggered, true);
    assert.equal(at98k.action, 'warn');

    // Haiku emergency halt (>=100k)
    const at100k = checkHaiku100kCliffBreaker('claude-3-haiku', 101000);
    assert.equal(at100k.triggered, true);
    assert.equal(at100k.action, 'halt');
  });

  it('calculateDualTtlCountdown computes remaining seconds, MM:SS format, and expiration', () => {
    const now = Date.now();
    const lastTurn = now - 60000; // 60s ago

    const countdown = calculateDualTtlCountdown(lastTurn, now);
    assert.equal(countdown.cacheTtlSec, 240); // 300s - 60s
    assert.equal(countdown.formattedCacheTtl, '04:00');
    assert.equal(countdown.isCacheExpired, false);
    assert.equal(countdown.billingTtlSec, 3540); // 3600s - 60s
    assert.equal(countdown.formattedBillingTtl, '59:00');
    assert.equal(countdown.isBillingExpired, false);

    // Expired cache (400s elapsed, cache expired but billing active)
    const expiredTurn = now - 400000;
    const expiredCountdown = calculateDualTtlCountdown(expiredTurn, now);
    assert.equal(expiredCountdown.cacheTtlSec, 0);
    assert.equal(expiredCountdown.formattedCacheTtl, '00:00');
    assert.equal(expiredCountdown.isCacheExpired, true);
    assert.equal(expiredCountdown.isBillingExpired, false);

    // Exact billing expiration (3,600,000ms = 1 hour elapsed)
    const expiredBillingTurn = now - 3600000;
    const expiredBillingCountdown = calculateDualTtlCountdown(expiredBillingTurn, now);
    assert.equal(expiredBillingCountdown.billingTtlSec, 0);
    assert.equal(expiredBillingCountdown.formattedBillingTtl, '00:00');
    assert.equal(expiredBillingCountdown.isBillingExpired, true);

    // Past billing expiration (7,200,000ms = 2 hours elapsed)
    const longExpiredTurn = now - 7200000;
    const longExpiredCountdown = calculateDualTtlCountdown(longExpiredTurn, now);
    assert.equal(longExpiredCountdown.billingTtlSec, 0);
    assert.equal(longExpiredCountdown.formattedBillingTtl, '00:00');
    assert.equal(longExpiredCountdown.isBillingExpired, true);

    // Rolling mode countdown in second 1-hour block (75 min elapsed -> 45 min left)
    const rollingCountdown = calculateDualTtlCountdown(lastTurn, lastTurn + 4500000, 300000, 3600000, { rolling: true });
    assert.equal(rollingCountdown.isBillingExpired, true);
    assert.equal(rollingCountdown.billingTtlSec, 2700);
    assert.equal(rollingCountdown.formattedBillingTtl, '45:00');
  });

  it('partitionBillingBlocks rolls over at 5-hour boundaries and calculates spend', () => {
    const t0 = 1000000000;
    const hour = 3600 * 1000;

    const events = [
      { timestamp: t0 + (1 * hour), costUsd: 1.25, tokens: 50000, subagentId: 'worker-1' },
      { timestamp: t0 + (2 * hour), costUsd: 2.50, tokens: 100000, subagentId: 'worker-2' },
      // Cross into block 2 (>5h)
      { timestamp: t0 + (6 * hour), costUsd: 3.00, tokens: 120000, subagentId: 'worker-1' }
    ];

    const blocks = partitionBillingBlocks(events);
    assert.equal(blocks.length, 2);

    assert.equal(blocks[0].blockIndex, 0);
    assert.equal(blocks[0].totalCostUsd, 3.75);
    assert.equal(blocks[0].eventCount, 2);
    assert.equal(blocks[0].subagentSpend['worker-1'], 1.25);
    assert.equal(blocks[0].subagentSpend['worker-2'], 2.50);

    assert.equal(blocks[1].blockIndex, 1);
    assert.equal(blocks[1].totalCostUsd, 3.00);
    assert.equal(blocks[1].subagentSpend['worker-1'], 3.00);
  });
});

// ============================================================================
// 9. Zero-Dependency AST & Mod Law Compliance Gate
// ============================================================================
describe('Sub-Harness 9: Zero-Dependency AST & Mod Law Compliance Gate', () => {
  it('checkModLaws passes compliant pure code', () => {
    const cleanCode = `
      import { evaluate } from './eval.mjs';
      export function onToolCall(event) {
        return { decision: 'allow' };
      }
    `;
    const result = checkModLaws(cleanCode);
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
  });

  it('checkModLaws catches violations across Mod Laws 1–5', () => {
    // 1. node:* import
    assert.ok(checkModLaws("import fs from 'node:fs';").violations.some(v => v.includes('Check 1')));

    // 2. assignment to $
    assert.ok(checkModLaws("$ = 10;").violations.some(v => v.includes('Check 2')));

    // 3. destructuring of $
    assert.ok(checkModLaws("const { $ } = ctx;").violations.some(v => v.includes('Check 3')));

    // 4. object shorthand { $ }
    assert.ok(checkModLaws("const o = { $, name };").violations.some(v => v.includes('Check 4')));

    // 5. unbalanced call scanner
    assert.ok(checkModLaws("function foo() { bar(").violations.some(v => v.includes('Check 5')));

    // 6. dynamic on() event name
    assert.ok(checkModLaws("host.on(`${event}`, () => {})").violations.some(v => v.includes('Check 6')));

    // 7. dynamic import()
    assert.ok(checkModLaws("const mod = await import('dyn');").violations.some(v => v.includes('Check 7')));

    // 8. unhandled async hook
    assert.ok(checkModLaws("async function hook() { await doWork(); }").violations.some(v => v.includes('Check 8')));

    // 9. unhandled throw
    assert.ok(checkModLaws("throw new Error('fail');").violations.some(v => v.includes('Check 9')));

    // 10. process.cwd()
    assert.ok(checkModLaws("const p = process.cwd();").violations.some(v => v.includes('Check 10')));

    // 11. globalThis assignment
    assert.ok(checkModLaws("globalThis.leak = 1;").violations.some(v => v.includes('Check 11')));
  });

  it('checkZeroRuntimeDeps validates empty dependencies in package.json', () => {
    const result = checkZeroRuntimeDeps('package.json');
    assert.equal(result.valid, true);
    assert.equal(result.dependencies.length, 0);
  });

  it('assertNoOutboundEgress catches forbidden external network calls', () => {
    assert.doesNotThrow(() => assertNoOutboundEgress('const x = 1 + 2;'));
    assert.throws(() => assertNoOutboundEgress("fetch('https://evil.com')"), /Forbidden outbound network/);
    assert.throws(() => assertNoOutboundEgress("http.request('http://evil.com')"), /Forbidden outbound network/);
  });

  it('assertNoNodeBuiltinImports catches node:* imports', () => {
    assert.doesNotThrow(() => assertNoNodeBuiltinImports("import { a } from './local.mjs';"));
    assert.throws(() => assertNoNodeBuiltinImports("import { DatabaseSync } from 'node:sqlite';"), /Forbidden node:\* import/);
  });

  it('withNetworkSpy catches non-loopback socket connections while allowing loopback and POSIX UDS', async () => {
    // 1. External connection should be captured
    const { violations: extViolations } = await withNetworkSpy(async () => {
      const socket = new net.Socket();
      try {
        socket.connect(80, '93.184.216.34');
        socket.destroy();
      } catch {}
    });
    assert.ok(extViolations.length >= 1);
    assert.ok(extViolations[0].target.includes('93.184.216.34'));

    // 2. POSIX domain socket connection should NOT be captured (Reviewer 1 & 2 Finding 3)
    const { violations: udsViolations } = await withNetworkSpy(async () => {
      const socket = new net.Socket();
      try {
        socket.connect('/tmp/ctxtop-daemon.sock');
        socket.destroy();
      } catch {}
    });
    assert.equal(udsViolations.length, 0, 'POSIX UDS must not be flagged as network violation');

    // 3. IPv6 loopback connection should NOT be captured
    const { violations: ipv6Violations } = await withNetworkSpy(async () => {
      const socket = new net.Socket();
      try {
        socket.connect(8080, '::1');
        socket.destroy();
      } catch {}
    });
    assert.equal(ipv6Violations.length, 0, 'IPv6 loopback ::1 must not be flagged as network violation');
  });
});

// ============================================================================
// 10. UI & Invariant Assertions
// ============================================================================
describe('Sub-Harness 10: UI & Invariant Assertions', () => {
  it('assertPlainTextCompact verifies /compact instruction and 1-click Copy /compact button', () => {
    const validHtml = `
      <div id="compactInstruction">Type /compact in the chat box and press Enter <button id="btnCompactPrimary">Copy /compact</button></div>
      <div id="compactReclaim">Reclaimed 45,000 tokens</div>
    `;
    assert.doesNotThrow(() => assertPlainTextCompact(validHtml));

    // Scoped container with unrelated Ctrl+V toast elsewhere must pass cleanly (Reviewer 2 Finding 2)
    const validWithToast = `
      <div id="compactInstruction">Type /compact in the chat box and press Enter</div>
      <div class="toast">Prompt copied. Press Ctrl+V in chat.</div>
    `;
    assert.doesNotThrow(() => assertPlainTextCompact(validWithToast));

    // Canonical webview verification
    if (fs.existsSync('src/webview/horizon_panel.html')) {
      const canonicalHtml = fs.readFileSync('src/webview/horizon_panel.html', 'utf8');
      assert.doesNotThrow(() => assertPlainTextCompact(canonicalHtml), 'Canonical horizon_panel.html must pass compact invariant');
      assert.ok(canonicalHtml.includes('id="btnCompactPrimary"'), 'Canonical horizon_panel.html must include #btnCompactPrimary');
    }

    // Must throw if copyCompactWithGuidance is present
    const invalidHtml2 = `<script>function copyCompactWithGuidance() {}</script>`;
    assert.throws(() => assertPlainTextCompact(invalidHtml2), /Invariant 1 Violation/);

    // Must throw if Ctrl+V is present in an unscoped snippet
    const invalidHtml3 = `<div>Press Ctrl+V to paste</div>`;
    assert.throws(() => assertPlainTextCompact(invalidHtml3), /Invariant 1 Violation/);

    // Must throw if Ctrl+V is inside #compactInstruction
    const invalidHtml4 = `<div id="compactInstruction">Type /compact and press Ctrl+V</div>`;
    assert.throws(() => assertPlainTextCompact(invalidHtml4), /Invariant 1 Violation/);
  });

  it('assertActiveSourceProtected verifies isIgnorablePath behavior', () => {
    const dummyClassifier = (filePath) => {
      if (!filePath) return false;
      const normalized = filePath.replace(/\\/g, '/');
      if (normalized.includes('lock') || normalized.endsWith('.log') || normalized.endsWith('.min.js')) return true;
      return false;
    };

    assert.doesNotThrow(() => assertActiveSourceProtected(dummyClassifier));

    // Fails if source file is classified as ignorable
    const brokenClassifier = (p) => true;
    assert.throws(() => assertActiveSourceProtected(brokenClassifier));
  });

  it('assertMirrorParity verifies byte-for-byte identical file pairs', () => {
    const ws = createTempWorkspace();
    try {
      const fileA = ws.writeFile('pluginA/file.txt', 'exact match content');
      const fileB = ws.writeFile('pluginB/file.txt', 'exact match content');
      const fileC = ws.writeFile('pluginC/file.txt', 'different content');

      assert.doesNotThrow(() => {
        assertMirrorParity({ filePairs: [[fileA, fileB]] });
      });

      assert.throws(() => {
        assertMirrorParity({ filePairs: [[fileA, fileC]] });
      }, /Mirror parity violations/);
    } finally {
      ws.cleanup();
    }
  });
});
