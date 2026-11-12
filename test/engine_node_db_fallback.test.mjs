/**
 * @file test/engine_node_db_fallback.test.mjs
 * Verification of pure-JS JSONL fallback wrapper for Node 20 LTS (Features 9, 10).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getDatabaseClient,
  JsonlDatabaseFallbackWrapper
} from '../src/engine-node/db/index.mjs';

function createTempJsonlSession() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_jsonl_test_'));
  const jsonlPath = path.join(tmpDir, 'transcript.jsonl');

  const records = [
    { id: 1, tool: 'read_file', content: 'Reading package.json configuration file', turn: 1 },
    { id: 2, tool: 'edit_file', content: 'Updating build script in package.json and vite config', turn: 2 },
    { id: 3, tool: 'run_command', content: 'Running npm test suite for verification', turn: 3 },
    { id: 4, tool: 'read_file', content: 'Inspecting test results and summary', turn: 4 }
  ];

  fs.writeFileSync(jsonlPath, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  return {
    tmpDir,
    jsonlPath,
    records,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

test('engine-node fallback: strictly requires { readOnly: true }', () => {
  assert.throws(
    () => getDatabaseClient({ dbPath: 'dummy.jsonl', readOnly: false, forceFallback: true }),
    /\[Zero-Trust SQLite Guard\] getDatabaseClient strictly requires \{ readOnly: true \}/
  );

  assert.throws(
    () => new JsonlDatabaseFallbackWrapper('dummy.jsonl', { readOnly: false }),
    /\[Zero-Trust SQLite Guard\] JsonlDatabaseFallbackWrapper strictly requires \{ readOnly: true \}/
  );
});

test('engine-node fallback: factory instantiates JsonlDatabaseFallbackWrapper on forceFallback', () => {
  const { jsonlPath, cleanup } = createTempJsonlSession();
  try {
    const client = getDatabaseClient({ dbPath: jsonlPath, readOnly: true, forceFallback: true });
    assert.ok(client instanceof JsonlDatabaseFallbackWrapper);
    client.close();
  } finally {
    cleanup();
  }
});

test('engine-node fallback: rejects mutating SQL statements', () => {
  const { jsonlPath, cleanup } = createTempJsonlSession();
  try {
    const client = getDatabaseClient({ dbPath: jsonlPath, readOnly: true, forceFallback: true });

    const mutatingQueries = [
      "INSERT INTO events (tool) VALUES ('hack')",
      "UPDATE events SET tool = 'hacked'",
      "DELETE FROM events WHERE id = 1",
      "DROP TABLE events"
    ];

    for (const sql of mutatingQueries) {
      assert.throws(
        () => client.all(sql),
        /\[Zero-Trust SQLite Guard\] Mutation query not permitted on read-only database/,
        `Should reject: ${sql}`
      );
      assert.throws(
        () => client.get(sql),
        /\[Zero-Trust SQLite Guard\] Mutation query not permitted on read-only database/,
        `Should reject: ${sql}`
      );
    }

    client.close();
  } finally {
    cleanup();
  }
});

test('engine-node fallback: executes get and all queries with WHERE and COUNT', () => {
  const { jsonlPath, cleanup } = createTempJsonlSession();
  try {
    const client = getDatabaseClient({ dbPath: jsonlPath, readOnly: true, forceFallback: true });

    // COUNT(*)
    const countResult = client.all('SELECT COUNT(*) AS total FROM events');
    assert.strictEqual(countResult.length, 1);
    assert.strictEqual(countResult[0].total, 4);

    // WHERE tool = ?
    const readEvents = client.all('SELECT * FROM events WHERE tool = ?', ['read_file']);
    assert.strictEqual(readEvents.length, 2);
    assert.strictEqual(readEvents[0].id, 1);
    assert.strictEqual(readEvents[1].id, 4);

    // get (single row)
    const singleRow = client.get('SELECT * FROM events WHERE id = ?', [2]);
    assert.ok(singleRow);
    assert.strictEqual(singleRow.id, 2);
    assert.strictEqual(singleRow.tool, 'edit_file');

    // LIMIT
    const limited = client.all('SELECT * FROM events LIMIT 2');
    assert.strictEqual(limited.length, 2);

    client.close();
  } finally {
    cleanup();
  }
});

test('engine-node fallback: pure-JS searchFts returns ranked scores and highlighted snippets', () => {
  const { jsonlPath, cleanup } = createTempJsonlSession();
  try {
    const client = getDatabaseClient({ dbPath: jsonlPath, readOnly: true, forceFallback: true });

    const ftsResults = client.searchFts('package', 10);
    assert.ok(Array.isArray(ftsResults));
    assert.strictEqual(ftsResults.length, 2);

    for (const r of ftsResults) {
      assert.ok(r.snippet, 'Snippet must be generated');
      assert.ok(r.score > 0, 'Score must be positive');
      assert.ok(r.content.toLowerCase().includes('package'));
    }

    // Top result should be the one with package mentioned
    assert.ok(ftsResults[0].score >= ftsResults[1].score);

    client.close();
  } finally {
    cleanup();
  }
});

test('engine-node fallback: query parity across engines', () => {
  const records = [
    { id: 1, tool: 'bash', content: 'building core project' },
    { id: 2, tool: 'test', content: 'running test verification' }
  ];

  const client = new JsonlDatabaseFallbackWrapper('virtual.jsonl', {
    readOnly: true,
    records
  });

  const all = client.all('SELECT * FROM events');
  assert.strictEqual(all.length, 2);
  const row = client.get('SELECT * FROM events WHERE tool = ?', ['test']);
  assert.strictEqual(row.id, 2);

  const search = client.searchFts('verification');
  assert.strictEqual(search.length, 1);
  assert.strictEqual(search[0].id, 2);
  assert.ok(search[0].snippet.includes('running test verification'));

  client.close();
});
