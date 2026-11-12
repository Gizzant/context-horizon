/**
 * @file test/challenger_m2_storage_git.test.mjs
 * Empirical Challenger 1 stress harness for Milestone 2:
 * - Dynamic SQLite probing & Node 20 fallback
 * - Read-only invariant enforcement (Zero-Trust)
 * - Mutating query rejection battery & defense-in-depth verification
 * - Query parity between SQLite and JSONL
 * - DET-31 Git merge-tree sensor (clean, conflict, invalid sha, latency, zero tree mutation)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  getDatabaseClient,
  isNodeSqliteAvailable,
  getDatabaseSyncClass,
  suppressSqliteWarning,
  SqliteDatabaseSyncWrapper,
  JsonlDatabaseFallbackWrapper
} from '../src/engine-node/db/index.mjs';
import {
  probeSqliteBuiltin,
  resetProbeCacheForTesting
} from '../src/engine-node/db/probe.mjs';
import {
  probeGitMergeTree
} from '../src/engine-node/sensors/git_merge_tree.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempSqliteDb(rows = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_sqlite_'));
  const dbPath = path.join(tmpDir, 'session.db');

  const DatabaseSync = getDatabaseSyncClass();
  const initDb = new DatabaseSync(dbPath);
  initDb.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      tool TEXT,
      content TEXT,
      turn INTEGER
    );
    CREATE VIRTUAL TABLE events_fts USING fts5(tool, content);
  `);

  for (const r of rows) {
    const stmt = initDb.prepare('INSERT INTO events (id, tool, content, turn) VALUES (?, ?, ?, ?)');
    stmt.run(r.id, r.tool, r.content, r.turn);
    const ftsStmt = initDb.prepare('INSERT INTO events_fts (tool, content) VALUES (?, ?)');
    ftsStmt.run(r.tool, r.content);
  }
  initDb.close();

  return {
    tmpDir,
    dbPath,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

function createTempJsonlDb(rows = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_jsonl_'));
  const jsonlPath = path.join(tmpDir, 'transcript.jsonl');
  const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, content, 'utf8');

  return {
    tmpDir,
    jsonlPath,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

const SAMPLE_RECORDS = [
  { id: 1, tool: 'read_file', content: 'Reading package.json configuration file', turn: 1 },
  { id: 2, tool: 'edit_file', content: 'Updating build script in package.json and vite config', turn: 2 },
  { id: 3, tool: 'run_command', content: 'Running npm test suite for verification', turn: 3 },
  { id: 4, tool: 'read_file', content: 'Inspecting test results and summary', turn: 4 },
  { id: 5, tool: 'bash', content: 'git status and git merge-tree conflict check', turn: 5 }
];

// ---------------------------------------------------------------------------
// 1. Dynamic SQLite Probing & Warning Suppression
// ---------------------------------------------------------------------------

test('CHALLENGE 1.1: suppressSqliteWarning handles invalid warning payloads without throwing', () => {
  let emitCount = 0;
  const mockOrigEmit = (warning, ...args) => {
    emitCount++;
  };
  const prevEmit = process.emitWarning;

  try {
    process.emitWarning = mockOrigEmit;
    suppressSqliteWarning({ force: true });

    // Edge cases for emitWarning arguments
    assert.doesNotThrow(() => process.emitWarning(null));
    assert.doesNotThrow(() => process.emitWarning(undefined));
    assert.doesNotThrow(() => process.emitWarning(12345));
    assert.doesNotThrow(() => process.emitWarning({}));
    assert.doesNotThrow(() => process.emitWarning({ message: null }));
    assert.doesNotThrow(() => process.emitWarning('SQLite is experimental', 'ExperimentalWarning'));
  } finally {
    process.emitWarning = prevEmit;
    suppressSqliteWarning({ force: true });
  }
});

test('CHALLENGE 1.2: probeSqliteBuiltin handles throw inside getBuiltinModule cleanly', () => {
  const throwingOverride = () => {
    throw new Error('ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite');
  };
  const result = probeSqliteBuiltin({ getBuiltinModuleOverride: throwingOverride });
  assert.strictEqual(result, null, 'Must fail open to null when builtin throws');
});

test('CHALLENGE 1.3: probeSqliteBuiltin handles module without DatabaseSync constructor', () => {
  const invalidModOverride = () => ({ notDatabaseSync: true });
  const result = probeSqliteBuiltin({ getBuiltinModuleOverride: invalidModOverride });
  assert.strictEqual(result, null, 'Must return null if DatabaseSync is missing or not a function');
});

test('CHALLENGE 1.4: probeSqliteBuiltin cache isolation and reset', () => {
  resetProbeCacheForTesting();
  const ctor = getDatabaseSyncClass();
  if (isNodeSqliteAvailable()) {
    assert.strictEqual(typeof ctor, 'function');
  }
  resetProbeCacheForTesting();
});

// ---------------------------------------------------------------------------
// 2. Read-Only Invariant Enforcement (Zero-Trust Guard)
// ---------------------------------------------------------------------------

test('CHALLENGE 2.1: getDatabaseClient rejects missing or non-boolean readOnly', () => {
  // Calling with no args or empty object throws Zero-Trust guard error
  assert.throws(
    () => getDatabaseClient(),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );
  assert.throws(() => getDatabaseClient(null), TypeError);
  assert.throws(() => getDatabaseClient('invalid'), TypeError);
  assert.throws(() => getDatabaseClient(123), TypeError);

  // Missing readOnly
  assert.throws(
    () => getDatabaseClient({ dbPath: 'test.db' }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );

  // Falsy readOnly
  assert.throws(
    () => getDatabaseClient({ dbPath: 'test.db', readOnly: false }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );

  // Truthy non-boolean readOnly
  assert.throws(
    () => getDatabaseClient({ dbPath: 'test.db', readOnly: 1 }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );
  assert.throws(
    () => getDatabaseClient({ dbPath: 'test.db', readOnly: 'true' }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );
  assert.throws(
    () => getDatabaseClient({ dbPath: 'test.db', readOnly: {} }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );

  // Invalid dbPath
  assert.throws(
    () => getDatabaseClient({ readOnly: true }),
    TypeError
  );
  assert.throws(
    () => getDatabaseClient({ dbPath: '', readOnly: true }),
    TypeError
  );
  assert.throws(
    () => getDatabaseClient({ dbPath: 12345, readOnly: true }),
    TypeError
  );
});

test('CHALLENGE 2.2: Wrapper constructors enforce readOnly: true independently', () => {
  if (isNodeSqliteAvailable()) {
    assert.throws(
      () => new SqliteDatabaseSyncWrapper('test.db'),
      /\[Zero-Trust SQLite Guard\] SqliteDatabaseSyncWrapper strictly requires \{ readOnly: true \}/
    );
    assert.throws(
      () => new SqliteDatabaseSyncWrapper('test.db', { readOnly: false }),
      /\[Zero-Trust SQLite Guard\] SqliteDatabaseSyncWrapper strictly requires \{ readOnly: true \}/
    );
    assert.throws(
      () => new SqliteDatabaseSyncWrapper('test.db', { readOnly: 'true' }),
      /\[Zero-Trust SQLite Guard\] SqliteDatabaseSyncWrapper strictly requires \{ readOnly: true \}/
    );
  }

  assert.throws(
    () => new JsonlDatabaseFallbackWrapper('test.jsonl'),
    /\[Zero-Trust SQLite Guard\] JsonlDatabaseFallbackWrapper strictly requires \{ readOnly: true \}/
  );
  assert.throws(
    () => new JsonlDatabaseFallbackWrapper('test.jsonl', { readOnly: false }),
    /\[Zero-Trust SQLite Guard\] JsonlDatabaseFallbackWrapper strictly requires \{ readOnly: true \}/
  );
  assert.throws(
    () => new JsonlDatabaseFallbackWrapper('test.jsonl', { readOnly: 1 }),
    /\[Zero-Trust SQLite Guard\] JsonlDatabaseFallbackWrapper strictly requires \{ readOnly: true \}/
  );
});

// ---------------------------------------------------------------------------
// 3. Mutating Query Rejection Battery & Defense-in-Depth
// ---------------------------------------------------------------------------

test('CHALLENGE 3.1: Standard mutating queries rejected across both SQLite and JSONL', () => {
  const sqliteFixture = isNodeSqliteAvailable() ? createTempSqliteDb(SAMPLE_RECORDS) : null;
  const jsonlFixture = createTempJsonlDb(SAMPLE_RECORDS);

  try {
    const clients = [];
    if (sqliteFixture) {
      clients.push({
        name: 'SQLite',
        client: getDatabaseClient({ dbPath: sqliteFixture.dbPath, readOnly: true })
      });
    }
    clients.push({
      name: 'JSONL',
      client: getDatabaseClient({ dbPath: jsonlFixture.jsonlPath, readOnly: true, forceFallback: true })
    });

    const standardMutations = [
      "INSERT INTO events (id, tool) VALUES (99, 'evil')",
      "UPDATE events SET tool = 'pwned' WHERE id = 1",
      "DELETE FROM events WHERE id = 1",
      "DROP TABLE events",
      "ALTER TABLE events ADD COLUMN leaked TEXT",
      "CREATE TABLE hacked (x INT)",
      "REPLACE INTO events (id, tool) VALUES (1, 'pwn')",
      "ATTACH DATABASE ':memory:' AS evil",
      "DETACH DATABASE evil",
      "VACUUM",
      "REINDEX events"
    ];

    const caseVariants = [
      "insert into events values (100, 'a', 'b', 1)",
      "update events set turn = 99",
      "delete from events",
      "drop table events_fts",
      "create index idx_evil on events(turn)",
      "\n\t  INSERT INTO events VALUES (1, 2, 3, 4)",
      "  \n  DELETE FROM events"
    ];

    for (const { name, client } of clients) {
      for (const sql of [...standardMutations, ...caseVariants]) {
        assert.throws(
          () => client.get(sql),
          /\[Zero-Trust SQLite Guard\] Mutation query not permitted on read-only database/,
          `[${name}] client.get should reject: ${sql}`
        );
        assert.throws(
          () => client.all(sql),
          /\[Zero-Trust SQLite Guard\] Mutation query not permitted on read-only database/,
          `[${name}] client.all should reject: ${sql}`
        );
      }
      client.close();
    }
  } finally {
    if (sqliteFixture) sqliteFixture.cleanup();
    jsonlFixture.cleanup();
  }
});

test('CHALLENGE 3.2: Defense-in-depth: SQLite C-engine blocks writes even when regex bypassed', () => {
  if (!isNodeSqliteAvailable()) return;

  const { dbPath, cleanup } = createTempSqliteDb(SAMPLE_RECORDS);
  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });

    // Queries designed to bypass /^\s*(INSERT|...)/ regex
    const adversarialQueries = [
      "/* harmless */ INSERT INTO events (id, tool, content, turn) VALUES (88, 'evil', 'hack', 8)",
      "-- inline comment\nINSERT INTO events (id, tool, content, turn) VALUES (89, 'evil', 'hack', 8)",
      "WITH cte AS (SELECT 1) INSERT INTO events (id, tool, content, turn) VALUES (90, 'evil', 'hack', 8)"
    ];

    for (const sql of adversarialQueries) {
      // Must either be rejected by JS guard or rejected by SQLite C readonly flag
      assert.throws(
        () => client.all(sql),
        /(?:\[Zero-Trust SQLite Guard\]|attempt to write a readonly database)/i,
        `Adversarial mutation should fail: ${sql}`
      );
    }

    client.close();

    // Verify zero mutations occurred
    const DatabaseSync = getDatabaseSyncClass();
    const verifier = new DatabaseSync(dbPath);
    const count = verifier.prepare('SELECT COUNT(*) as cnt FROM events').get().cnt;
    assert.strictEqual(count, SAMPLE_RECORDS.length, 'Database record count must remain identical');
    verifier.close();
  } finally {
    cleanup();
  }
});

test('CHALLENGE 3.3: JSONL records remain 100% immutable under all queries', () => {
  const { jsonlPath, cleanup } = createTempJsonlDb(SAMPLE_RECORDS);
  try {
    const client = getDatabaseClient({ dbPath: jsonlPath, readOnly: true, forceFallback: true });

    // Read queries
    client.all('SELECT * FROM events');
    client.get('SELECT * FROM events WHERE id = ?', [1]);
    client.searchFts('package');

    // Attempted comment insert
    try {
      client.all('/* comment */ INSERT INTO events VALUES (99)');
    } catch (err) {
      void err;
    }

    assert.strictEqual(client.records.length, SAMPLE_RECORDS.length);
    client.close();

    // Check disk content
    const diskContent = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    assert.strictEqual(diskContent.length, SAMPLE_RECORDS.length);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Query Parity Between SQLite and JSONL
// ---------------------------------------------------------------------------

test('CHALLENGE 4.1: Query parity across SQLite and JSONL on get, all, and count', () => {
  if (!isNodeSqliteAvailable()) return;

  const sqliteFixture = createTempSqliteDb(SAMPLE_RECORDS);
  const jsonlFixture = createTempJsonlDb(SAMPLE_RECORDS);

  try {
    const sqliteClient = getDatabaseClient({ dbPath: sqliteFixture.dbPath, readOnly: true });
    const jsonlClient = getDatabaseClient({ dbPath: jsonlFixture.jsonlPath, readOnly: true, forceFallback: true });

    // 1. COUNT(*)
    const sCount = sqliteClient.all('SELECT COUNT(*) AS total FROM events');
    const jCount = jsonlClient.all('SELECT COUNT(*) AS total FROM events');
    assert.strictEqual(sCount[0].total, jCount[0].total);
    assert.strictEqual(sCount[0].total, SAMPLE_RECORDS.length);

    // 2. WHERE column = ? with param array
    const sWhere = sqliteClient.all('SELECT * FROM events WHERE tool = ?', ['read_file']);
    const jWhere = jsonlClient.all('SELECT * FROM events WHERE tool = ?', ['read_file']);
    assert.strictEqual(sWhere.length, jWhere.length);
    assert.strictEqual(sWhere.length, 2);
    assert.strictEqual(sWhere[0].id, jWhere[0].id);
    assert.strictEqual(sWhere[1].id, jWhere[1].id);

    // 3. get single row
    const sGet = sqliteClient.get('SELECT * FROM events WHERE id = ?', [3]);
    const jGet = jsonlClient.get('SELECT * FROM events WHERE id = ?', [3]);
    assert.ok(sGet);
    assert.ok(jGet);
    assert.strictEqual(sGet.id, jGet.id);
    assert.strictEqual(sGet.tool, jGet.tool);

    // 4. Non-matching query
    const sEmpty = sqliteClient.all('SELECT * FROM events WHERE tool = ?', ['nonexistent_tool']);
    const jEmpty = jsonlClient.all('SELECT * FROM events WHERE tool = ?', ['nonexistent_tool']);
    assert.strictEqual(sEmpty.length, 0);
    assert.strictEqual(jEmpty.length, 0);

    const sGetNone = sqliteClient.get('SELECT * FROM events WHERE id = ?', [9999]);
    const jGetNone = jsonlClient.get('SELECT * FROM events WHERE id = ?', [9999]);
    assert.strictEqual(Boolean(sGetNone), false);
    assert.strictEqual(Boolean(jGetNone), false);

    // 5. LIMIT clause
    const sLimit = sqliteClient.all('SELECT * FROM events LIMIT 2');
    const jLimit = jsonlClient.all('SELECT * FROM events LIMIT 2');
    assert.strictEqual(sLimit.length, 2);
    assert.strictEqual(jLimit.length, 2);
    assert.strictEqual(sLimit[0].id, jLimit[0].id);

    sqliteClient.close();
    jsonlClient.close();
  } finally {
    sqliteFixture.cleanup();
    jsonlFixture.cleanup();
  }
});

test('CHALLENGE 4.2: searchFts parity and edge case stress', () => {
  if (!isNodeSqliteAvailable()) return;

  const sqliteFixture = createTempSqliteDb(SAMPLE_RECORDS);
  const jsonlFixture = createTempJsonlDb(SAMPLE_RECORDS);

  try {
    const sqliteClient = getDatabaseClient({ dbPath: sqliteFixture.dbPath, readOnly: true });
    const jsonlClient = getDatabaseClient({ dbPath: jsonlFixture.jsonlPath, readOnly: true, forceFallback: true });

    // Single term search
    const sRes = sqliteClient.searchFts('package', 10);
    const jRes = jsonlClient.searchFts('package', 10);
    assert.strictEqual(sRes.length, 2);
    assert.strictEqual(jRes.length, 2);
    for (const r of [...sRes, ...jRes]) {
      assert.ok(r.snippet, 'Snippet must be generated');
      assert.ok(typeof r.score === 'number', 'Score must be a number');
    }

    // Zero match search
    const sNone = sqliteClient.searchFts('supercalifragilistic', 10);
    const jNone = jsonlClient.searchFts('supercalifragilistic', 10);
    assert.strictEqual(sNone.length, 0);
    assert.strictEqual(jNone.length, 0);

    // Empty string & whitespace
    assert.deepStrictEqual(sqliteClient.searchFts(''), []);
    assert.deepStrictEqual(jsonlClient.searchFts(''), []);
    assert.deepStrictEqual(sqliteClient.searchFts('   '), []);
    assert.deepStrictEqual(jsonlClient.searchFts('   '), []);

    // Null and non-string query
    assert.deepStrictEqual(sqliteClient.searchFts(null), []);
    assert.deepStrictEqual(jsonlClient.searchFts(null), []);
    assert.deepStrictEqual(sqliteClient.searchFts(undefined), []);
    assert.deepStrictEqual(jsonlClient.searchFts(undefined), []);

    // Special characters & syntax chars
    const specialQueries = ['***', '"""', "'''", '()()', 'NEAR(a, b)', 'foo OR bar', 'tool:read_file'];
    for (const sq of specialQueries) {
      assert.doesNotThrow(() => sqliteClient.searchFts(sq));
      assert.doesNotThrow(() => jsonlClient.searchFts(sq));
    }

    sqliteClient.close();
    jsonlClient.close();
  } finally {
    sqliteFixture.cleanup();
    jsonlFixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Node 20 LTS Simulation End-to-End
// ---------------------------------------------------------------------------

test('CHALLENGE 5.1: Node 20 LTS simulation loads transcripts from various standard paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_node20_sim_'));
  try {
    // 1. Direct .jsonl file
    const f1 = path.join(tmpDir, 'test.jsonl');
    fs.writeFileSync(f1, JSON.stringify({ event: 'direct' }) + '\n', 'utf8');
    const c1 = getDatabaseClient({ dbPath: f1, readOnly: true, forceFallback: true });
    assert.strictEqual(c1.all('SELECT * FROM events').length, 1);
    c1.close();

    // 2. Directory with .system_generated/logs/transcript_full.jsonl
    const logsDir = path.join(tmpDir, 'sessA', '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'transcript_full.jsonl'), JSON.stringify({ event: 'full' }) + '\n', 'utf8');
    const c2 = getDatabaseClient({ dbPath: path.join(tmpDir, 'sessA'), readOnly: true, forceFallback: true });
    assert.strictEqual(c2.all('SELECT * FROM events').length, 1);
    c2.close();

    // 3. Directory with transcript.jsonl
    const sessBDir = path.join(tmpDir, 'sessB');
    fs.mkdirSync(sessBDir, { recursive: true });
    fs.writeFileSync(path.join(sessBDir, 'transcript.jsonl'), JSON.stringify({ event: 'simple' }) + '\n', 'utf8');
    const c3 = getDatabaseClient({ dbPath: sessBDir, readOnly: true, forceFallback: true });
    assert.strictEqual(c3.all('SELECT * FROM events').length, 1);
    c3.close();

    // 4. Non-existent path fails open cleanly without throwing
    const c4 = getDatabaseClient({ dbPath: path.join(tmpDir, 'non_existent'), readOnly: true, forceFallback: true });
    assert.strictEqual(c4.all('SELECT * FROM events').length, 0);
    c4.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. DET-31 Git Merge Conflict Sensor Stress Test
// ---------------------------------------------------------------------------

test('CHALLENGE 6.1: probeGitMergeTree clean merge guarantees 0 tree/index mutation', () => {
  const statusBefore = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });

  const result = probeGitMergeTree('HEAD', 'HEAD');
  assert.strictEqual(result.clean, true);
  assert.strictEqual(result.hasConflict, false);
  assert.ok(result.treeHash);
  assert.match(result.treeHash, /^[0-9a-f]{40,64}$/i);
  assert.strictEqual(result.conflictFiles.length, 0);

  const statusAfter = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  assert.strictEqual(statusAfter, statusBefore, 'Working tree and index must be 100% byte-for-byte identical');
});

test('CHALLENGE 6.2: probeGitMergeTree detects real merge conflict in ephemeral repo', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_git_conflict_'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tmpRepo });

    const testFile = path.join(tmpRepo, 'conflict_file.txt');
    fs.writeFileSync(testFile, 'line 1\nline 2: base\nline 3\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'Initial base commit'], { cwd: tmpRepo });

    // Branch A
    execFileSync('git', ['checkout', '-b', 'branch-alpha'], { cwd: tmpRepo });
    fs.writeFileSync(testFile, 'line 1\nline 2: alpha change\nline 3\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Alpha change'], { cwd: tmpRepo });

    // Branch B
    execFileSync('git', ['checkout', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['checkout', '-b', 'branch-beta'], { cwd: tmpRepo });
    fs.writeFileSync(testFile, 'line 1\nline 2: beta conflicting change\nline 3\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Beta change'], { cwd: tmpRepo });

    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' });

    // Run probe
    const conflictRes = probeGitMergeTree('branch-alpha', 'branch-beta', { workspaceDir: tmpRepo });
    assert.strictEqual(conflictRes.clean, false);
    assert.strictEqual(conflictRes.hasConflict, true);
    assert.ok(conflictRes.conflictFiles.length >= 1);
    assert.ok(conflictRes.conflictFiles.some(f => f.includes('conflict_file.txt')));
    assert.ok(conflictRes.conflictMessages.length >= 1);

    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' });
    assert.strictEqual(statusAfter, statusBefore, 'Ephemeral working tree must have ZERO modifications');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('CHALLENGE 6.3: probeGitMergeTree clean 3-way merge without conflicts', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_git_clean3way_'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tmpRepo });

    fs.writeFileSync(path.join(tmpRepo, 'file1.txt'), 'base 1\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'file2.txt'), 'base 2\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'Base commit'], { cwd: tmpRepo });

    // Branch A edits file1
    execFileSync('git', ['checkout', '-b', 'branch-clean-a'], { cwd: tmpRepo });
    fs.writeFileSync(path.join(tmpRepo, 'file1.txt'), 'modified 1\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Edit file 1'], { cwd: tmpRepo });

    // Branch B edits file2
    execFileSync('git', ['checkout', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['checkout', '-b', 'branch-clean-b'], { cwd: tmpRepo });
    fs.writeFileSync(path.join(tmpRepo, 'file2.txt'), 'modified 2\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Edit file 2'], { cwd: tmpRepo });

    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' });

    // Probe 3-way merge
    const cleanRes = probeGitMergeTree('branch-clean-a', 'branch-clean-b', { workspaceDir: tmpRepo });
    assert.strictEqual(cleanRes.clean, true);
    assert.strictEqual(cleanRes.hasConflict, false);
    assert.ok(cleanRes.treeHash);
    assert.strictEqual(cleanRes.conflictFiles.length, 0);

    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' });
    assert.strictEqual(statusAfter, statusBefore, 'Working tree must remain untouched');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('CHALLENGE 6.4: probeGitMergeTree invalid refs, bad SHAs, empty args handle gracefully', () => {
  // Empty arguments
  const noArgs = probeGitMergeTree();
  assert.strictEqual(noArgs.clean, false);
  assert.strictEqual(noArgs.hasConflict, false);
  assert.ok(noArgs.error);

  const oneArg = probeGitMergeTree('HEAD');
  assert.strictEqual(oneArg.clean, false);
  assert.strictEqual(oneArg.hasConflict, false);
  assert.ok(oneArg.error);

  // Invalid SHA
  const badSha = probeGitMergeTree('0000000000000000000000000000000000000000', '1111111111111111111111111111111111111111');
  assert.strictEqual(badSha.clean, false);
  assert.strictEqual(badSha.hasConflict, false);
  assert.strictEqual(badSha.degraded, true);
  assert.ok(badSha.error);

  // Non-git directory
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_nongit_'));
  try {
    const nonGitRes = probeGitMergeTree('HEAD', 'HEAD', { workspaceDir: nonGitDir });
    assert.strictEqual(nonGitRes.clean, false);
    assert.strictEqual(nonGitRes.hasConflict, false);
    assert.strictEqual(nonGitRes.degraded, true);
    assert.ok(nonGitRes.error);
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test('CHALLENGE 6.5: DET-31 probeGitMergeTree latency benchmark on local repo', () => {
  const latencies = [];
  const WARMUP = 3;
  const RUNS = 10;

  for (let i = 0; i < WARMUP; i++) {
    probeGitMergeTree('HEAD', 'HEAD');
  }

  for (let i = 0; i < RUNS; i++) {
    const res = probeGitMergeTree('HEAD', 'HEAD');
    assert.strictEqual(res.clean, true);
    latencies.push(res.latencyMs);
  }

  latencies.sort((a, b) => a - b);
  const min = latencies[0];
  const max = latencies[latencies.length - 1];
  const median = latencies[Math.floor(latencies.length / 2)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];

  // Log empirical timings for handoff report
  console.log(`[DET-31 Latency Benchmark] Min: ${min}ms, Median: ${median}ms, P95: ${p95}ms, Max: ${max}ms`);

  // Assert reasonable execution time on Windows (sub-150ms ceiling for process spawn)
  assert.ok(median < 150.0, `Median latency ${median}ms exceeds safe boundary`);
});


// ---------------------------------------------------------------------------
// 7. Advanced Stress & Concurrency Verification
// ---------------------------------------------------------------------------

test('CHALLENGE 7.1: Concurrent SQLite read-only clients handle simultaneous queries', () => {
  if (!isNodeSqliteAvailable()) return;

  const { dbPath, cleanup } = createTempSqliteDb(SAMPLE_RECORDS);
  try {
    const CLIENT_COUNT = 15;
    const clients = [];

    // Open multiple handles concurrently
    for (let i = 0; i < CLIENT_COUNT; i++) {
      clients.push(getDatabaseClient({ dbPath, readOnly: true }));
    }

    // Interleave queries across all clients
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < CLIENT_COUNT; i++) {
        const row = clients[i].get('SELECT * FROM events WHERE id = ?', [(round % 5) + 1]);
        assert.ok(row);
        const all = clients[i].all('SELECT COUNT(*) as cnt FROM events');
        assert.strictEqual(all[0].cnt, SAMPLE_RECORDS.length);
      }
    }

    // Close all clients
    for (const c of clients) {
      c.close();
    }
  } finally {
    cleanup();
  }
});

test('CHALLENGE 7.2: [REMEDIATED BUG 1] JSONL fallback handles null records in searchFts without throwing', () => {
  const client = new JsonlDatabaseFallbackWrapper('dummy.jsonl', {
    readOnly: true,
    records: [
      { id: 1, tool: 'read_file', content: 'valid line' },
      null,
      undefined
    ]
  });

  assert.doesNotThrow(() => {
    const res = client.searchFts('valid');
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].id, 1);
  });
  client.close();
});

test('CHALLENGE 7.4: [REMEDIATED BUG 2] SqliteDatabaseSyncWrapper opens :memory: on Windows successfully', () => {
  if (!isNodeSqliteAvailable()) return;

  assert.doesNotThrow(() => {
    const client = new SqliteDatabaseSyncWrapper(':memory:', { readOnly: true });
    assert.strictEqual(client.dbPath, ':memory:');
    assert.doesNotThrow(() => client.all('SELECT 1 as num'));
    client.close();
  });
});

test('CHALLENGE 7.5: [REMEDIATED BUG 3] SqliteDatabaseSyncWrapper.searchFts uses column -1 to highlight content matches', () => {
  if (!isNodeSqliteAvailable()) return;

  const { dbPath, cleanup } = createTempSqliteDb([
    { id: 1, tool: 'read_file', content: 'Reading package.json configuration file', turn: 1 }
  ]);

  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });
    const results = client.searchFts('package', 10);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(
      results[0].snippet,
      'Reading [package].json configuration file',
      'Confirms snippet() uses column -1 and highlights matching content'
    );
    client.close();
  } finally {
    cleanup();
  }
});

test('CHALLENGE 7.3: probeGitMergeTree handles detached HEAD and multi-file conflicts', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_chal_detached_'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tmpRepo });

    // Create 3 files
    for (let f = 1; f <= 3; f++) {
      fs.writeFileSync(path.join(tmpRepo, `file_${f}.txt`), `base content ${f}\n`, 'utf8');
    }
    execFileSync('git', ['add', '.'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'Initial multi-file commit'], { cwd: tmpRepo });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();

    // Branch A modifies all 3 files
    execFileSync('git', ['checkout', '-b', 'multi-a'], { cwd: tmpRepo });
    for (let f = 1; f <= 3; f++) {
      fs.writeFileSync(path.join(tmpRepo, `file_${f}.txt`), `branch A content ${f}\n`, 'utf8');
    }
    execFileSync('git', ['commit', '-am', 'Branch A modifications'], { cwd: tmpRepo });
    const commitA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();

    // Branch B modifies all 3 files differently
    execFileSync('git', ['checkout', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['checkout', '-b', 'multi-b'], { cwd: tmpRepo });
    for (let f = 1; f <= 3; f++) {
      fs.writeFileSync(path.join(tmpRepo, `file_${f}.txt`), `branch B content ${f}\n`, 'utf8');
    }
    execFileSync('git', ['commit', '-am', 'Branch B modifications'], { cwd: tmpRepo });
    const commitB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();

    // Detach HEAD to baseCommit
    execFileSync('git', ['checkout', '--detach', baseCommit], { cwd: tmpRepo });

    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' });

    // Run probe in detached HEAD state with multi-file conflict
    const multiConflictRes = probeGitMergeTree(commitA, commitB, { workspaceDir: tmpRepo });
    assert.strictEqual(multiConflictRes.clean, false);
    assert.strictEqual(multiConflictRes.hasConflict, true);
    assert.strictEqual(multiConflictRes.conflictFiles.length, 3, 'Must report all 3 conflicting files');
    for (let f = 1; f <= 3; f++) {
      assert.ok(
        multiConflictRes.conflictFiles.some(file => file.includes(`file_${f}.txt`)),
        `file_${f}.txt must be reported in conflictFiles`
      );
    }

    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' });
    assert.strictEqual(statusAfter, statusBefore, 'Detached HEAD working tree must remain pristine');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
