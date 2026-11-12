/**
 * @file test/challenger_t1_r2_stress.mjs
 * Empirical Challenge Harness for Milestone T1 Iteration 2 Quality Gate Re-evaluation
 * 
 * Deeply stress-tests:
 * 1. JsonlDatabaseFallbackWrapper & executeJsonlQuery SQL Query Engine & SQLite Parity:
 *    - WHERE equality (numbers, strings, booleans, parameters)
 *    - Comparison operators (<, <=, >, >=, !=, <>)
 *    - SQL Three-Valued Logic boundary behavior (NULL handling in comparisons)
 *    - LIKE operator (prefix %, suffix %, substring %, wildcard _, parameterized ?, case-insensitivity)
 *    - IN operator (integers, strings, single element, no matches)
 *    - IS NULL / IS NOT NULL (nulls, missing properties, non-nulls)
 *    - Multi-condition AND clauses (mixed types, parameterized)
 *    - ORDER BY (ASC, DESC, NULL collation)
 *    - LIMIT (integer, parameterized ?, LIMIT 0, combined with ORDER BY)
 *    - COUNT(*) (COUNT(*), COUNT(*) AS alias, filtered COUNT(*))
 *    - Column projections (SELECT *, specific columns, column aliases, backticks/quotes)
 *    - Direct SQLite vs JSONL equivalence oracle (identical rows returned across both)
 *    - Mutation attempt rejection (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, VACUUM, PRAGMA)
 *    - Syntax errors / graceful degradation
 * 2. Invariant Enforcement Blockers:
 *    - assertSqliteReadOnlyEnforced on string paths and wrapper objects
 *    - assertHostDbWriteRejected catching permissive open functions
 * 3. Windows Backslash Path Protection:
 *    - assertActiveSourceProtected validating Windows backslash paths
 *    - Adversarial detection when active source files are marked ignorable
 *    - Adversarial detection when ignorable artifacts are marked non-ignorable
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  isSqliteAvailable,
  createTempWorkspace,
  createMockDatabaseFixture,
  getMockDatabaseClient,
  JsonlDatabaseFallbackWrapper,
  executeJsonlQuery,
  assertSqliteReadOnlyEnforced,
  assertHostDbWriteRejected,
  assertActiveSourceProtected
} from './helpers/e2e_harness.mjs';

// ============================================================================
// 1. JSONL Query Engine & SQL API Parity Stress
// ============================================================================
describe('JsonlDatabaseFallbackWrapper & executeJsonlQuery SQL Engine Stress', () => {
  const sampleRecords = [
    { id: 1, name: 'Alice', role: 'admin', score: 98.5, active: 1, tag: 'core' },
    { id: 2, name: 'Bob', role: 'developer', score: 85.0, active: 0, tag: 'frontend' },
    { id: 3, name: 'Charlie', role: 'developer', score: 72.0, active: 1, tag: null },
    { id: 4, name: 'Diana', role: 'qa', score: 91.0, active: 1, tag: 'backend' },
    { id: 5, name: 'Evan', role: 'intern', score: null, active: 0 } // tag is undefined
  ];

  it('WHERE equality queries match exact values across literals and parameters', () => {
    // Integer equality literal and param
    const r1 = executeJsonlQuery(sampleRecords, 'SELECT * FROM test WHERE id = 3');
    const r2 = executeJsonlQuery(sampleRecords, 'SELECT * FROM test WHERE id = ?', [3]);
    assert.equal(r1.length, 1);
    assert.equal(r1[0].name, 'Charlie');
    assert.deepEqual(r1, r2);

    // String equality literal (single quotes, double quotes, unquoted)
    const r3 = executeJsonlQuery(sampleRecords, "SELECT * FROM test WHERE role = 'admin'");
    const r4 = executeJsonlQuery(sampleRecords, 'SELECT * FROM test WHERE role = "admin"');
    const r5 = executeJsonlQuery(sampleRecords, 'SELECT * FROM test WHERE role = ?', ['admin']);
    assert.equal(r3.length, 1);
    assert.deepEqual(r3, r4);
    assert.deepEqual(r3, r5);

    // Boolean/numeric conversion equality
    const r6 = executeJsonlQuery(sampleRecords, 'SELECT * FROM test WHERE active = 1');
    assert.equal(r6.length, 3); // Alice, Charlie, Diana
  });

  it('Comparison operators evaluate numerical boundaries on non-null values correctly', () => {
    // Non-null records subset
    const nonNullRecords = sampleRecords.filter(r => r.score !== null && r.score !== undefined);

    // Greater than (>)
    const gt = executeJsonlQuery(nonNullRecords, 'SELECT id, score FROM test WHERE score > 85');
    assert.equal(gt.length, 2); // Alice (98.5), Diana (91.0)
    assert.deepEqual(gt.map(r => r.id), [1, 4]);

    // Greater than or equal (>=)
    const gte = executeJsonlQuery(nonNullRecords, 'SELECT id, score FROM test WHERE score >= ?', [85.0]);
    assert.equal(gte.length, 3); // Alice (98.5), Bob (85.0), Diana (91.0)
    assert.deepEqual(gte.map(r => r.id), [1, 2, 4]);

    // Less than (<)
    const lt = executeJsonlQuery(nonNullRecords, 'SELECT id, score FROM test WHERE score < 85');
    assert.equal(lt.length, 1); // Charlie (72.0)
    assert.equal(lt[0].id, 3);

    // Less than or equal (<=)
    const lte = executeJsonlQuery(nonNullRecords, 'SELECT id, score FROM test WHERE score <= 85.0');
    assert.equal(lte.length, 2); // Bob (85.0), Charlie (72.0)
    assert.deepEqual(lte.map(r => r.id), [2, 3]);

    // Not equal (!= and <>)
    const ne1 = executeJsonlQuery(sampleRecords, "SELECT id FROM test WHERE role != 'developer'");
    const ne2 = executeJsonlQuery(sampleRecords, "SELECT id FROM test WHERE role <> 'developer'");
    assert.equal(ne1.length, 3); // Alice, Diana, Evan
    assert.deepEqual(ne1, ne2);
  });

  it('Boundary finding: SQL three-valued logic discrepancy on NULL comparisons in JSONL', () => {
    // In SQL standard, comparison against NULL (score < 85) returns UNKNOWN (false).
    // In JavaScript, null < 85 coerces null to 0 (0 < 85 is true).
    const ltWithNull = executeJsonlQuery(sampleRecords, 'SELECT id, score FROM test WHERE score < 85');
    
    // Documenting empirical behavior:
    // JSONL query returns 2 records (Charlie id 3 with 72, and Evan id 5 with null coerced to 0)
    assert.equal(ltWithNull.length, 2);
    assert.equal(ltWithNull.some(r => r.id === 5), true, 'Evan (null score) is coerced to 0 in JS comparison');

    // Safe pattern: callers filtering nullable columns in JSONL should combine with IS NOT NULL
    const safeLt = executeJsonlQuery(sampleRecords, 'SELECT id, score FROM test WHERE score IS NOT NULL AND score < 85');
    assert.equal(safeLt.length, 1);
    assert.equal(safeLt[0].id, 3);
  });

  it('LIKE operator handles %, _, parameterized patterns, and case-insensitivity', () => {
    // Prefix match
    const prefix = executeJsonlQuery(sampleRecords, "SELECT name FROM test WHERE name LIKE 'Al%'");
    assert.equal(prefix.length, 1);
    assert.equal(prefix[0].name, 'Alice');

    // Suffix match
    const suffix = executeJsonlQuery(sampleRecords, "SELECT name FROM test WHERE name LIKE '%na'");
    assert.equal(suffix.length, 1);
    assert.equal(suffix[0].name, 'Diana');

    // Substring match
    const sub = executeJsonlQuery(sampleRecords, "SELECT name FROM test WHERE name LIKE '%li%'");
    assert.equal(sub.length, 2); // Alice, Charlie

    // Single character wildcard (_)
    const single = executeJsonlQuery(sampleRecords, "SELECT name FROM test WHERE name LIKE 'Bo_'");
    assert.equal(single.length, 1);
    assert.equal(single[0].name, 'Bob');

    // Parameterized LIKE
    const paramLike = executeJsonlQuery(sampleRecords, 'SELECT name FROM test WHERE name LIKE ?', ['%AN%']);
    assert.equal(paramLike.length, 2); // Diana, Evan (case-insensitive)

    // Non-matching LIKE
    const noMatch = executeJsonlQuery(sampleRecords, "SELECT name FROM test WHERE name LIKE 'Z%'");
    assert.equal(noMatch.length, 0);
  });

  it('IN operator matches sets of numbers, strings, single elements, and empty hits', () => {
    // Numeric IN
    const inNum = executeJsonlQuery(sampleRecords, 'SELECT id FROM test WHERE id IN (1, 4, 99)');
    assert.equal(inNum.length, 2);
    assert.deepEqual(inNum.map(r => r.id), [1, 4]);

    // String IN
    const inStr = executeJsonlQuery(sampleRecords, "SELECT id, name FROM test WHERE role IN ('admin', 'qa')");
    assert.equal(inStr.length, 2);
    assert.deepEqual(inStr.map(r => r.name), ['Alice', 'Diana']);

    // Single-element IN
    const inSingle = executeJsonlQuery(sampleRecords, 'SELECT id FROM test WHERE id IN (2)');
    assert.equal(inSingle.length, 1);
    assert.equal(inSingle[0].id, 2);

    // Empty/non-matching IN
    const inNone = executeJsonlQuery(sampleRecords, 'SELECT id FROM test WHERE id IN (999, 1000)');
    assert.equal(inNone.length, 0);
  });

  it('IS NULL and IS NOT NULL properly distinguish null/undefined from present values', () => {
    // IS NULL matches explicit null AND missing/undefined fields
    const isNullTag = executeJsonlQuery(sampleRecords, 'SELECT id, name FROM test WHERE tag IS NULL');
    assert.equal(isNullTag.length, 2); // Charlie (null), Evan (undefined)
    assert.deepEqual(isNullTag.map(r => r.name), ['Charlie', 'Evan']);

    // IS NOT NULL
    const isNotNullTag = executeJsonlQuery(sampleRecords, 'SELECT id, name FROM test WHERE tag IS NOT NULL');
    assert.equal(isNotNullTag.length, 3); // Alice, Bob, Diana
    assert.deepEqual(isNotNullTag.map(r => r.name), ['Alice', 'Bob', 'Diana']);

    // IS NULL on score
    const isNullScore = executeJsonlQuery(sampleRecords, 'SELECT id, name FROM test WHERE score IS NULL');
    assert.equal(isNullScore.length, 1);
    assert.equal(isNullScore[0].name, 'Evan');
  });

  it('Compound WHERE clauses with multiple ANDs and parameter binding alignment', () => {
    const query = 'SELECT name FROM test WHERE role = ? AND active = ? AND score > ?';
    const params = ['developer', 1, 70];
    const res = executeJsonlQuery(sampleRecords, query, params);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, 'Charlie');
  });

  it('ORDER BY correctly sorts ASC, DESC, and handles NULL collation', () => {
    // Numeric ASC
    const asc = executeJsonlQuery(sampleRecords, 'SELECT id, score FROM test WHERE score IS NOT NULL ORDER BY score ASC');
    assert.deepEqual(asc.map(r => r.id), [3, 2, 4, 1]);

    // Numeric DESC
    const desc = executeJsonlQuery(sampleRecords, 'SELECT id, score FROM test WHERE score IS NOT NULL ORDER BY score DESC');
    assert.deepEqual(desc.map(r => r.id), [1, 4, 2, 3]);

    // ORDER BY with NULL values: DESC puts nulls last, ASC puts nulls first
    const descWithNull = executeJsonlQuery(sampleRecords, 'SELECT id, score FROM test ORDER BY score DESC');
    assert.equal(descWithNull[descWithNull.length - 1].score, null);

    const ascWithNull = executeJsonlQuery(sampleRecords, 'SELECT id, score FROM test ORDER BY score ASC');
    assert.equal(ascWithNull[0].score, null);
  });

  it('LIMIT handles numeric values, parameterized ?, LIMIT 0, and ORDER BY combination', () => {
    // Plain LIMIT
    const l2 = executeJsonlQuery(sampleRecords, 'SELECT id FROM test LIMIT 2');
    assert.equal(l2.length, 2);

    // Parameterized LIMIT
    const lparam = executeJsonlQuery(sampleRecords, 'SELECT id FROM test LIMIT ?', [3]);
    assert.equal(lparam.length, 3);

    // LIMIT 0 returns empty array
    const l0 = executeJsonlQuery(sampleRecords, 'SELECT id FROM test LIMIT 0');
    assert.equal(l0.length, 0);

    // ORDER BY + LIMIT 1 (top record)
    const top = executeJsonlQuery(sampleRecords, 'SELECT name, score FROM test WHERE score IS NOT NULL ORDER BY score DESC LIMIT 1');
    assert.equal(top.length, 1);
    assert.equal(top[0].name, 'Alice');

    // Parameterized WHERE + Parameterized LIMIT
    const filteredTop = executeJsonlQuery(
      sampleRecords,
      'SELECT name FROM test WHERE role = ? ORDER BY id ASC LIMIT ?',
      ['developer', 1]
    );
    assert.equal(filteredTop.length, 1);
    assert.equal(filteredTop[0].name, 'Bob');
  });

  it('COUNT(*) returns valid count object with default or custom alias', () => {
    // Default count(*)
    const c1 = executeJsonlQuery(sampleRecords, 'SELECT COUNT(*) FROM test');
    assert.equal(c1.length, 1);
    assert.equal(c1[0]['count(*)'], 5);

    // Custom alias
    const c2 = executeJsonlQuery(sampleRecords, 'SELECT COUNT(*) AS total_users FROM test');
    assert.equal(c2.length, 1);
    assert.equal(c2[0].total_users, 5);

    // Filtered count
    const c3 = executeJsonlQuery(sampleRecords, "SELECT COUNT(*) AS active_devs FROM test WHERE role = 'developer' AND active = 1");
    assert.equal(c3.length, 1);
    assert.equal(c3[0].active_devs, 1);

    // Count matching zero records
    const c4 = executeJsonlQuery(sampleRecords, "SELECT COUNT(*) AS none FROM test WHERE role = 'nonexistent'");
    assert.equal(c4.length, 1);
    assert.equal(c4[0].none, 0);
  });

  it('Projections extract exact requested fields and honor column aliases', () => {
    // Specific columns
    const cols = executeJsonlQuery(sampleRecords, 'SELECT id, name FROM test WHERE id = 1');
    assert.equal(cols.length, 1);
    assert.deepEqual(Object.keys(cols[0]).sort(), ['id', 'name']);
    assert.equal(cols[0].id, 1);
    assert.equal(cols[0].name, 'Alice');

    // Aliased columns
    const alias = executeJsonlQuery(sampleRecords, 'SELECT id AS user_id, name AS full_name FROM test WHERE id = 1');
    assert.equal(alias.length, 1);
    assert.deepEqual(Object.keys(alias[0]).sort(), ['full_name', 'user_id']);
    assert.equal(alias[0].user_id, 1);
    assert.equal(alias[0].full_name, 'Alice');
  });

  it('Zero-Trust read-only enforcement rejects all mutation SQL keywords', () => {
    const forbidden = [
      'INSERT INTO test VALUES (6, "Frank")',
      'UPDATE test SET score = 100 WHERE id = 1',
      'DELETE FROM test WHERE id = 1',
      'DROP TABLE test',
      'ALTER TABLE test ADD COLUMN email TEXT',
      'CREATE TABLE forbidden (x INT)',
      'VACUUM',
      'PRAGMA writable_schema = ON'
    ];

    for (const sql of forbidden) {
      assert.throws(
        () => executeJsonlQuery(sampleRecords, sql),
        /SQLITE_READONLY/i,
        `Forbidden SQL must be rejected: ${sql}`
      );
    }
  });

  it('JsonlDatabaseFallbackWrapper get() and all() maintain zero-crash file handling', () => {
    const ws = createTempWorkspace();
    try {
      const jsonlPath = path.join(ws.wsDir, 'test_wrapper.jsonl');
      fs.writeFileSync(jsonlPath, sampleRecords.map(r => JSON.stringify(r)).join('\n') + '\n');

      const wrapper = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });

      // all() with SQL
      const allRows = wrapper.all('SELECT name FROM test WHERE active = 1');
      assert.equal(allRows.length, 3);

      // get() with SQL returning single row
      const alice = wrapper.get('SELECT * FROM test WHERE id = ?', [1]);
      assert.equal(alice.name, 'Alice');

      // get() with SQL returning null when not found
      const missing = wrapper.get('SELECT * FROM test WHERE id = ?', [999]);
      assert.equal(missing, null);

      // all() with function predicate
      const devRows = wrapper.all(r => r.role === 'developer');
      assert.equal(devRows.length, 2);

      // get() with function predicate
      const diana = wrapper.get(r => r.name === 'Diana');
      assert.equal(diana.role, 'qa');

      // Mutation methods throw SQLITE_READONLY
      assert.throws(() => wrapper.exec(), /SQLITE_READONLY/);
      assert.throws(() => wrapper.run(), /SQLITE_READONLY/);
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// 2. Direct SQLite vs JSONL Equivalence Oracle
// ============================================================================
describe('Direct SQLite vs JSONL Fallback Equivalence Oracle', () => {
  it('executing identical SQL queries yields identical results across SQLite and JSONL', async () => {
    if (!(await isSqliteAvailable())) {
      return;
    }

    const ws = createTempWorkspace();
    try {
      const records = [
        { __table: 'metrics', __values: { id: 1, name: 'ttft', value: 120.5, category: 'latency' }, id: 1, name: 'ttft', value: 120.5, category: 'latency' },
        { __table: 'metrics', __values: { id: 2, name: 'tbt', value: 45.0, category: 'latency' }, id: 2, name: 'tbt', value: 45.0, category: 'latency' },
        { __table: 'metrics', __values: { id: 3, name: 'cache_hit', value: 98.2, category: 'cache' }, id: 3, name: 'cache_hit', value: 98.2, category: 'cache' },
        { __table: 'metrics', __values: { id: 4, name: 'cache_miss', value: 1.8, category: 'cache' }, id: 4, name: 'cache_miss', value: 1.8, category: 'cache' },
        { __table: 'metrics', __values: { id: 5, name: 'drift_sigma', value: 0.12, category: 'drift' }, id: 5, name: 'drift_sigma', value: 0.12, category: 'drift' }
      ];

      const { dbPath, jsonlPath } = await createMockDatabaseFixture(path.join(ws.wsDir, 'oracle_test'), {
        tables: { metrics: 'id INT, name TEXT, value REAL, category TEXT' },
        records
      });

      const sqliteClient = await getMockDatabaseClient({ dbPath, jsonlPath, forceFallback: false, readOnly: true });
      const jsonlClient = await getMockDatabaseClient({ dbPath, jsonlPath, forceFallback: true, readOnly: true });

      assert.equal(sqliteClient.type, 'sqlite');
      assert.equal(jsonlClient.type, 'jsonl');

      // Test queries to execute on both
      const testQueries = [
        { sql: 'SELECT id, name FROM metrics WHERE category = ?', params: ['cache'] },
        { sql: 'SELECT name, value FROM metrics WHERE value > ? ORDER BY value DESC', params: [50.0] },
        { sql: 'SELECT id FROM metrics WHERE name LIKE ?', params: ['cache%'] },
        { sql: 'SELECT COUNT(*) AS cnt FROM metrics WHERE category = ?', params: ['latency'] },
        { sql: 'SELECT name FROM metrics WHERE id IN (1, 3, 5)' },
        { sql: 'SELECT name, value FROM metrics ORDER BY value ASC LIMIT ?', params: [2] }
      ];

      for (const { sql, params } of testQueries) {
        const sqliteResult = sqliteClient.all(sql, params);
        const jsonlResult = jsonlClient.all(sql, params);

        // Normalize row objects from SQLite [Object: null prototype] to plain JS objects for comparison
        const normalizedSqlite = sqliteResult.map(r => ({ ...r }));
        const normalizedJsonl = jsonlResult.map(r => ({ ...r }));

        assert.deepEqual(
          normalizedJsonl,
          normalizedSqlite,
          `Query results must be identical for SQL: ${sql} with params: ${JSON.stringify(params)}`
        );
      }

      sqliteClient.close();
      jsonlClient.close();
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// 3. Invariant Checks: assertSqliteReadOnlyEnforced & assertHostDbWriteRejected
// ============================================================================
describe('Invariant Checks: assertSqliteReadOnlyEnforced & assertHostDbWriteRejected', () => {
  it('assertSqliteReadOnlyEnforced verifies read-only write rejection on active SQLite file and wrapper', async () => {
    const ws = createTempWorkspace();
    try {
      const jsonlPath = path.join(ws.wsDir, 'test.jsonl');
      fs.writeFileSync(jsonlPath, '{"a":1}\n');

      const wrapper = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });
      // Wrapper verification (async call)
      await assertSqliteReadOnlyEnforced(wrapper);

      // SQLite file verification
      if (await isSqliteAvailable()) {
        const { dbPath } = await createMockDatabaseFixture(path.join(ws.wsDir, 'ro_check'), {
          tables: { demo: 'id INT' },
          records: [{ __table: 'demo', __values: { id: 1 }, id: 1 }]
        });

        await assertSqliteReadOnlyEnforced(dbPath);
      }
    } finally {
      ws.cleanup();
    }
  });

  it('assertSqliteReadOnlyEnforced catches mock that fails to block write operations', async () => {
    const permissiveMock = {
      exec: (sql) => {
        // Does not throw! Simulates a buggy read-write connection.
        return true;
      }
    };

    // assertSqliteReadOnlyEnforced is async, so it returns a rejected promise when assertions fail
    await assert.rejects(
      assertSqliteReadOnlyEnforced(permissiveMock),
      /Database must reject write operations/,
      'assertSqliteReadOnlyEnforced must reject when exec() permits write'
    );
  });

  it('assertHostDbWriteRejected catches open functions that permit read-write access', () => {
    // Compliant openFn throws when readOnly is false
    const strictOpenFn = (p, opts) => {
      if (!opts.readOnly) {
        throw new Error('Zero-Trust SQLite Guard: read-only required');
      }
    };
    assert.doesNotThrow(() => {
      assertHostDbWriteRejected(strictOpenFn, '/path/to/conversations.db');
    });

    // Permissive openFn does not throw
    const leakyOpenFn = (p, opts) => {
      return { handle: 'opened_rw' };
    };
    assert.throws(
      () => {
        assertHostDbWriteRejected(leakyOpenFn, '/path/to/conversations.db');
      },
      /Must refuse read-write open on protected host database/
    );
  });
});

// ============================================================================
// 4. Invariant Checks: assertActiveSourceProtected & Windows Backslash Paths
// ============================================================================
describe('Invariant Checks: assertActiveSourceProtected & Windows Paths', () => {
  it('assertActiveSourceProtected passes on canonical compliant isIgnorablePath implementation', () => {
    // Compliant path classifier: handles both POSIX and Windows backslashes
    const compliantIsIgnorablePath = (filePath) => {
      if (!filePath || typeof filePath !== 'string') return false;
      const normalized = filePath.replace(/\\/g, '/');
      if (
        normalized.startsWith('src/') ||
        normalized.startsWith('lib/') ||
        normalized.endsWith('.mjs') ||
        normalized.endsWith('.py')
      ) {
        return false;
      }
      if (
        normalized.endsWith('.log') ||
        normalized.endsWith('.lock') ||
        normalized.includes('lock.json') ||
        normalized.includes('min.js')
      ) {
        return true;
      }
      return false;
    };

    assert.doesNotThrow(() => {
      assertActiveSourceProtected(compliantIsIgnorablePath);
    });
  });

  it('assertActiveSourceProtected throws when active source file is erroneously flagged ignorable', () => {
    // Buggy classifier that mistakenly ignores Windows path src\\core\\router.mjs
    const buggyClassifier = (filePath) => {
      if (filePath === 'src\\core\\router.mjs') {
        return true; // BUG: active source marked as ignorable!
      }
      return filePath.endsWith('.log');
    };

    assert.throws(
      () => assertActiveSourceProtected(buggyClassifier),
      /Active source router\.mjs \(Windows path\) must not be ignorable/
    );
  });

  it('assertActiveSourceProtected throws when ignorable build artifact is rejected', () => {
    // Buggy classifier that refuses to ignore output.log
    const refusingClassifier = (filePath) => {
      return false; // Refuses to ignore anything
    };

    assert.throws(
      () => assertActiveSourceProtected(refusingClassifier),
      /package-lock\.json should be ignorable/
    );
  });

  it('assertActiveSourceProtected throws when non-function argument is provided', () => {
    assert.throws(
      () => assertActiveSourceProtected(null),
      /Path checker function required/
    );
    assert.throws(
      () => assertActiveSourceProtected('not_a_function'),
      /Path checker function required/
    );
  });
});
