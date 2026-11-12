/**
 * @file test/engine_node_db_sqlite.test.mjs
 * Verification of read-only SQLite wrapper, invariant enforcement, and FTS5 (Features 8, 10).
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
  SqliteDatabaseSyncWrapper
} from '../src/engine-node/db/index.mjs';

function createTempDbWithFts() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_sqlite_test_'));
  const dbPath = path.join(tmpDir, 'test_session.db');

  const DatabaseSync = getDatabaseSyncClass();
  const initDb = new DatabaseSync(dbPath);
  initDb.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      tool TEXT,
      content TEXT
    );
    INSERT INTO events (tool, content) VALUES ('read_file', 'Reading package.json configuration');
    INSERT INTO events (tool, content) VALUES ('edit_file', 'Updating build script in package.json');
    INSERT INTO events (tool, content) VALUES ('run_command', 'Running test suite verification');

    CREATE VIRTUAL TABLE events_fts USING fts5(tool, content);
    INSERT INTO events_fts (tool, content) VALUES ('read_file', 'Reading package.json configuration');
    INSERT INTO events_fts (tool, content) VALUES ('edit_file', 'Updating build script in package.json');
    INSERT INTO events_fts (tool, content) VALUES ('run_command', 'Running test suite verification');
  `);
  initDb.close();

  return {
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

test('engine-node sqlite: strictly requires { readOnly: true }', () => {
  if (!isNodeSqliteAvailable()) return;

  assert.throws(
    () => getDatabaseClient({ dbPath: ':memory:', readOnly: false }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );

  assert.throws(
    () => getDatabaseClient({ dbPath: ':memory:' }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );

  assert.throws(
    () => new SqliteDatabaseSyncWrapper(':memory:', { readOnly: false }),
    /\[Zero-Trust SQLite Guard\] SqliteDatabaseSyncWrapper strictly requires \{ readOnly: true \}/
  );
});

test('engine-node sqlite: rejects mutating SQL statements', () => {
  if (!isNodeSqliteAvailable()) return;

  const { dbPath, cleanup } = createTempDbWithFts();
  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });

    const mutatingQueries = [
      "INSERT INTO events (tool, content) VALUES ('bash', 'hack')",
      "UPDATE events SET tool = 'malicious'",
      "DELETE FROM events WHERE id = 1",
      "DROP TABLE events",
      "ALTER TABLE events ADD COLUMN leaked TEXT",
      "CREATE TABLE hacked (id INT)",
      "REPLACE INTO events (id, tool) VALUES (1, 'pwn')",
      "VACUUM"
    ];

    for (const sql of mutatingQueries) {
      assert.throws(
        () => client.get(sql),
        /\[Zero-Trust SQLite Guard\] Mutation query not permitted on read-only database/,
        `Should reject: ${sql}`
      );
      assert.throws(
        () => client.all(sql),
        /\[Zero-Trust SQLite Guard\] Mutation query not permitted on read-only database/,
        `Should reject: ${sql}`
      );
    }

    client.close();
  } finally {
    cleanup();
  }
});

test('engine-node sqlite: executes read queries (get and all) with params', () => {
  if (!isNodeSqliteAvailable()) return;

  const { dbPath, cleanup } = createTempDbWithFts();
  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });

    const row = client.get('SELECT * FROM events WHERE id = ?', [1]);
    assert.ok(row);
    assert.strictEqual(row.id, 1);
    assert.strictEqual(row.tool, 'read_file');

    const allRows = client.all('SELECT * FROM events ORDER BY id ASC');
    assert.strictEqual(allRows.length, 3);
    assert.strictEqual(allRows[1].tool, 'edit_file');
    assert.strictEqual(allRows[2].tool, 'run_command');

    client.close();
  } finally {
    cleanup();
  }
});

test('engine-node sqlite: searchFts returns BM25 ranking and snippet', () => {
  if (!isNodeSqliteAvailable()) return;

  const { dbPath, cleanup } = createTempDbWithFts();
  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });

    const results = client.searchFts('package', 10);
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 2);

    for (const r of results) {
      assert.ok(r.snippet, 'Each result should have a snippet');
      assert.ok(typeof r.score === 'number', 'Each result should have a score');
      assert.ok(r.content.includes('package.json'));
    }

    client.close();
  } finally {
    cleanup();
  }
});

test('engine-node sqlite: close is safe and idempotent', () => {
  if (!isNodeSqliteAvailable()) return;

  const { dbPath, cleanup } = createTempDbWithFts();
  try {
    const client = getDatabaseClient({ dbPath, readOnly: true });
    client.close();
    // Subsequent calls to close do not throw
    assert.doesNotThrow(() => client.close());
    // Calling get or all after close throws cleanly
    assert.throws(() => client.get('SELECT 1'), /Database handle is closed/);
  } finally {
    cleanup();
  }
});
