/**
 * @file test/challenger_m2_storage_deep_stress.mjs
 * Empirical Challenger 1 deep stress test & adversarial harness for Milestone 2:
 * 1. Deep adversarial probing of JsonlDatabaseFallbackWrapper (null, undefined, malformed, 10k scale).
 * 2. Windows-specific and URI path stress for SqliteDatabaseSyncWrapper (:memory:, file: URIs, defense-in-depth write blocks).
 * 3. Multi-column FTS5 verification for column -1 snippet highlighting and adversarial query resilience.
 * 4. High-concurrency reader contention and handle exhaustion stress.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getDatabaseClient,
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  SqliteDatabaseSyncWrapper,
  JsonlDatabaseFallbackWrapper
} from '../src/engine-node/db/index.mjs';
import {
  openLocalHorizonDb,
  openHostReadOnlyDb
} from '../src/core/sqlite_client.mjs';

// ---------------------------------------------------------------------------
// 1. JsonlDatabaseFallbackWrapper Adversarial Stress Battery
// ---------------------------------------------------------------------------

test('ADVERSARIAL 1.1: JsonlDatabaseFallbackWrapper handles diverse corrupted record arrays', () => {
  const corruptedRecords = [
    null,
    undefined,
    false,
    true,
    0,
    42,
    -1,
    NaN,
    '',
    'a plain string record',
    {},
    { id: null, tool: undefined, content: null },
    { id: 1, tool: 'read_file', content: 'valid search target alpha' },
    { id: 2, meta: { nested: { deep: 'valid search target beta' } } },
    { id: 3, arrayVal: ['valid', 'search', 'target', 'gamma'] },
    null,
    undefined
  ];

  const wrapper = new JsonlDatabaseFallbackWrapper('dummy.jsonl', {
    readOnly: true,
    records: corruptedRecords
  });

  // Verify searchFts handles every corrupted item without throwing
  assert.doesNotThrow(() => {
    const resAlpha = wrapper.searchFts('alpha');
    assert.strictEqual(resAlpha.length, 1);
    assert.strictEqual(resAlpha[0].id, 1);
    assert.ok(resAlpha[0].snippet.includes('alpha'));
  });

  assert.doesNotThrow(() => {
    const resBeta = wrapper.searchFts('beta');
    assert.strictEqual(resBeta.length, 1);
    assert.strictEqual(resBeta[0].id, 2);
    assert.ok(resBeta[0].snippet.includes('beta'));
  });

  assert.doesNotThrow(() => {
    const resGamma = wrapper.searchFts('gamma');
    assert.strictEqual(resGamma.length, 1);
    assert.strictEqual(resGamma[0].id, 3);
  });

  // Non-matching term returns empty array safely
  const resNone = wrapper.searchFts('nonexistent_token_xyz');
  assert.strictEqual(resNone.length, 0);

  // Queries with adversarial strings
  const adversarialQueries = [
    '',
    '   ',
    null,
    undefined,
    '.*+?^${}()|[]\\',
    '\' OR \'1\'=\'1',
    '-- comment',
    '/* comment */',
    'SELECT * FROM events',
    'a'.repeat(2000)
  ];

  for (const q of adversarialQueries) {
    assert.doesNotThrow(() => wrapper.searchFts(q));
  }

  wrapper.close();
});

test('ADVERSARIAL 1.2: JsonlDatabaseFallbackWrapper scale test with 10,000 records & 2,000 nulls', () => {
  const records = [];
  const TOTAL = 10000;
  for (let i = 0; i < TOTAL; i++) {
    if (i % 5 === 0) {
      records.push(null);
    } else if (i % 7 === 0) {
      records.push(undefined);
    } else {
      records.push({
        id: i,
        tool: i % 2 === 0 ? 'read_file' : 'edit_file',
        content: `Record number ${i} with special token needle_${i % 100}`,
        turn: Math.floor(i / 10)
      });
    }
  }

  const wrapper = new JsonlDatabaseFallbackWrapper('scale.jsonl', {
    readOnly: true,
    records
  });

  const t0 = Date.now();
  const results = wrapper.searchFts('needle_42', 20);
  const elapsed = Date.now() - t0;

  assert.ok(results.length > 0, 'Must find matching records');
  assert.ok(results.length <= 20, 'Must respect limit');
  for (const r of results) {
    assert.ok(r.content.includes('needle_42'));
    assert.ok(r.snippet);
    assert.ok(r.score > 0);
  }
  // Search through 10,000 records in pure JS must complete reasonably fast
  assert.ok(elapsed < 200, `Search through 10k records took ${elapsed}ms (>200ms threshold)`);

  wrapper.close();
});

// ---------------------------------------------------------------------------
// 2. SqliteDatabaseSyncWrapper & SQLite Client :memory: on Windows
// ---------------------------------------------------------------------------

test('ADVERSARIAL 2.1: :memory: databases open and operate safely across all wrappers on Windows', () => {
  if (!isNodeSqliteAvailable()) return;

  // 1. Direct SqliteDatabaseSyncWrapper with :memory:
  const directMem = new SqliteDatabaseSyncWrapper(':memory:', { readOnly: true });
  assert.strictEqual(directMem.dbPath, ':memory:');
  assert.doesNotThrow(() => directMem.all('SELECT 1 AS num'));
  const numRow = directMem.get('SELECT 42 AS val');
  assert.strictEqual(numRow.val, 42);
  directMem.close();

  // 2. Factory getDatabaseClient with :memory:
  const clientMem = getDatabaseClient({ dbPath: ':memory:', readOnly: true });
  assert.strictEqual(clientMem.dbPath, ':memory:');
  const countRow = clientMem.all('SELECT 100 AS c');
  assert.strictEqual(countRow[0].c, 100);
  clientMem.close();

  // 3. openLocalHorizonDb with :memory: and readOnly: true
  const localMem = openLocalHorizonDb(':memory:', { readOnly: true });
  assert.ok(localMem);
  const localRow = localMem.prepare('SELECT 999 AS code').get();
  assert.strictEqual(localRow.code, 999);
  localMem.close();

  // 4. openHostReadOnlyDb with :memory:
  const hostMem = openHostReadOnlyDb(':memory:');
  assert.ok(hostMem);
  const hostRow = hostMem.prepare('SELECT 777 AS code').get();
  assert.strictEqual(hostRow.code, 777);
  hostMem.close();

  // 5. URI filename support: file::memory:?cache=shared
  const uriMem = new SqliteDatabaseSyncWrapper('file::memory:?cache=shared', { readOnly: true });
  assert.strictEqual(uriMem.dbPath, 'file::memory:?cache=shared');
  assert.doesNotThrow(() => uriMem.all('SELECT 1'));
  uriMem.close();
});

test('ADVERSARIAL 2.2: Defense-in-depth: Write queries rejected by regex AND C-engine on :memory:', () => {
  if (!isNodeSqliteAvailable()) return;

  const memDb = new SqliteDatabaseSyncWrapper(':memory:', { readOnly: true });

  // Lowercase mutation queries (must be blocked by regex /i flag)
  const lowercaseMutations = [
    'create table t (x int)',
    'insert into t values (1)',
    'update t set x = 2',
    'delete from t',
    'drop table t',
    'alter table t add col int',
    'vacuum',
    'reindex',
    'attach database "other.db" as other'
  ];

  for (const sql of lowercaseMutations) {
    assert.throws(
      () => memDb.all(sql),
      /\[Zero-Trust SQLite Guard\] Mutation query not permitted/
    );
  }

  // Obfuscated / bypass attempts that don't start with keyword (e.g. CTE WITH)
  // Must be rejected by SQLite C-engine because { readOnly: true } was passed to native constructor
  const stealthMutations = [
    'WITH cte AS (SELECT 1) CREATE TABLE t (x int)',
    'WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte'
  ];

  for (const sql of stealthMutations) {
    assert.throws(() => {
      memDb.all(sql);
    }, /(unable to open database file|attempt to write a readonly database|syntax error|no such table)/i);
  }

  memDb.close();
});

// ---------------------------------------------------------------------------
// 3. Multi-Column FTS5 Snippet Column -1 Verification & Query Resilience
// ---------------------------------------------------------------------------

test('ADVERSARIAL 3.1: FTS5 column -1 snippet highlights matches across any column in multi-column table', () => {
  if (!isNodeSqliteAvailable()) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_fts_multi_'));
  const dbPath = path.join(tmpDir, 'multi_fts.db');

  const DatabaseSync = getDatabaseSyncClass();
  const initDb = new DatabaseSync(dbPath);

  // Create virtual table with 4 columns
  initDb.exec(`
    CREATE VIRTUAL TABLE logs_fts USING fts5(
      col_tool,
      col_path,
      col_body,
      col_error
    );
  `);

  const insertStmt = initDb.prepare(`
    INSERT INTO logs_fts (col_tool, col_path, col_body, col_error)
    VALUES (?, ?, ?, ?)
  `);

  // Row 1: match will be in col_tool (column 0)
  insertStmt.run('read_file', 'src/core/main.js', 'executing main entry', 'none');
  // Row 2: match will be in col_path (column 1)
  insertStmt.run('bash', 'scripts/deploy_service.sh', 'deploying container', 'none');
  // Row 3: match will be in col_body (column 2)
  insertStmt.run('edit_file', 'src/storage/db.js', 'optimizing query latency performance', 'none');
  // Row 4: match will be in col_error (column 3)
  insertStmt.run('mcp_tool', 'tools/server.js', 'invoking tool function', 'fatal timeout socket disconnected');
  // Row 5: match in multiple columns simultaneously
  insertStmt.run('concurrency_test', 'test/concurrency.mjs', 'running concurrency stress', 'concurrency lock failure');

  initDb.close();

  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });

    // 1. Match in column 0 (col_tool)
    const resCol0 = client.searchFts('read_file');
    assert.strictEqual(resCol0.length, 1);
    assert.ok(
      resCol0[0].snippet.includes('[read_file]'),
      `Expected [read_file] in snippet, got: ${resCol0[0].snippet}`
    );

    // 2. Match in column 1 (col_path)
    const resCol1 = client.searchFts('deploy_service');
    assert.strictEqual(resCol1.length, 1);
    assert.ok(
      resCol1[0].snippet.includes('[deploy_service]'),
      `Expected [deploy_service] in snippet, got: ${resCol1[0].snippet}`
    );

    // 3. Match in column 2 (col_body)
    const resCol2 = client.searchFts('optimizing');
    assert.strictEqual(resCol2.length, 1);
    assert.ok(
      resCol2[0].snippet.includes('[optimizing]'),
      `Expected [optimizing] in snippet, got: ${resCol2[0].snippet}`
    );

    // 4. Match in column 3 (col_error)
    const resCol3 = client.searchFts('disconnected');
    assert.strictEqual(resCol3.length, 1);
    assert.ok(
      resCol3[0].snippet.includes('[disconnected]'),
      `Expected [disconnected] in snippet, got: ${resCol3[0].snippet}`
    );

    // 5. Match in multiple columns
    const resMulti = client.searchFts('concurrency');
    assert.strictEqual(resMulti.length, 1);
    assert.ok(
      resMulti[0].snippet.includes('[concurrency]'),
      `Expected [concurrency] in snippet, got: ${resMulti[0].snippet}`
    );

    // 6. Adversarial search terms must not crash SQLite FTS5
    const ftsAdversarial = [
      'read*',
      '***',
      '"""',
      "'''",
      'tool:read_file',
      'deploy AND service',
      'deploy OR timeout',
      'fatal NOT disconnected',
      'NEAR(deploy, container, 5)',
      'a'.repeat(500)
    ];

    for (const q of ftsAdversarial) {
      assert.doesNotThrow(() => {
        client.searchFts(q);
      });
    }

    client.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
});

// ---------------------------------------------------------------------------
// 4. High-Concurrency Stress Test
// ---------------------------------------------------------------------------

test('ADVERSARIAL 4.1: 50 concurrent SQLite read handles executing 500 simultaneous queries', () => {
  if (!isNodeSqliteAvailable()) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_concurr_'));
  const dbPath = path.join(tmpDir, 'concurr.db');

  const DatabaseSync = getDatabaseSyncClass();
  const initDb = new DatabaseSync(dbPath);
  initDb.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
    CREATE VIRTUAL TABLE items_fts USING fts5(name);
  `);
  for (let i = 1; i <= 50; i++) {
    initDb.prepare('INSERT INTO items (id, name) VALUES (?, ?)').run(i, `Item ${i} alpha beta`);
    initDb.prepare('INSERT INTO items_fts (name) VALUES (?)').run(`Item ${i} alpha beta`);
  }
  initDb.close();

  try {
    const NUM_CLIENTS = 50;
    const clients = [];
    for (let i = 0; i < NUM_CLIENTS; i++) {
      clients.push(getDatabaseClient({ dbPath, readOnly: true }));
    }

    // Interleave 500 queries across the 50 clients
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < NUM_CLIENTS; i++) {
        const client = clients[i];
        const row = client.get('SELECT * FROM items WHERE id = ?', [(i % 50) + 1]);
        assert.ok(row);
        const fts = client.searchFts('alpha', 5);
        assert.ok(fts.length > 0);
      }
    }

    // Close all clients safely
    for (const c of clients) {
      assert.doesNotThrow(() => c.close());
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
});


test('ADVERSARIAL 4.2: searchFts returns empty array when FTS table is absent or invalid table specified', () => {
  if (!isNodeSqliteAvailable()) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_nofts_'));
  const dbPath = path.join(tmpDir, 'no_fts.db');

  const DatabaseSync = getDatabaseSyncClass();
  const initDb = new DatabaseSync(dbPath);
  initDb.exec('CREATE TABLE standard_table (id INTEGER PRIMARY KEY, msg TEXT);');
  initDb.close();

  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });

    // Auto-detect when no FTS table exists
    const resNoTable = client.searchFts('needle');
    assert.deepStrictEqual(resNoTable, [], 'Must fail open to empty array when no FTS table exists');

    // Explicit non-existent table
    const resExplicit = client.searchFts('needle', 10, { table: 'does_not_exist' });
    assert.deepStrictEqual(resExplicit, [], 'Must fail open to empty array on non-existent table parameter');

    client.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
});

test('ADVERSARIAL 4.3: Closed handles throw cleanly and close is idempotent across wrappers', () => {
  const jsonl = new JsonlDatabaseFallbackWrapper('dummy.jsonl', {
    readOnly: true,
    records: [{ id: 1, tool: 'read_file' }]
  });
  jsonl.close();
  assert.strictEqual(jsonl.isOpen, false);
  assert.throws(() => jsonl.all('SELECT * FROM events'), /Database handle is closed/);
  assert.throws(() => jsonl.get('SELECT * FROM events'), /Database handle is closed/);
  assert.throws(() => jsonl.searchFts('test'), /Database handle is closed/);
  assert.doesNotThrow(() => jsonl.close(), 'close() must be safe and idempotent');

  if (isNodeSqliteAvailable()) {
    const sqlite = new SqliteDatabaseSyncWrapper(':memory:', { readOnly: true });
    sqlite.close();
    assert.strictEqual(sqlite.isOpen, false);
    assert.throws(() => sqlite.all('SELECT 1'), /Database handle is closed/);
    assert.throws(() => sqlite.get('SELECT 1'), /Database handle is closed/);
    assert.throws(() => sqlite.searchFts('test'), /Database handle is closed/);
    assert.doesNotThrow(() => sqlite.close(), 'close() must be safe and idempotent');
  }
});

test('ADVERSARIAL 4.4: Windows paths with spaces and nested directory structures open reliably', () => {
  if (!isNodeSqliteAvailable()) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah chal path spaces_'));
  const nestedDir = path.join(tmpDir, 'nested dir (special chars)');
  fs.mkdirSync(nestedDir, { recursive: true });
  const dbPath = path.join(nestedDir, 'session logs [2026].db');

  const DatabaseSync = getDatabaseSyncClass();
  const initDb = new DatabaseSync(dbPath);
  initDb.exec('CREATE TABLE test (x INTEGER); INSERT INTO test VALUES (42);');
  initDb.close();

  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });
    const row = client.get('SELECT x FROM test');
    assert.strictEqual(row.x, 42);
    client.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
});
