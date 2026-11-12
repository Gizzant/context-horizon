/**
 * @file test/challenger_t1_stress.test.mjs
 * Empirical Challenge Harness for Milestone T1 Invariant Verification & Fallback Paths
 * 
 * Conducts adversarial stress-testing against:
 * 1. SQLite Read-Only Invariant & Permission Violation Attempts
 * 2. JSONL Fallback Store Under Corrupt, Multi-Line, BOM, and Edge Conditions
 * 3. checkModLaws AST Static Scanner Edge Cases (Template Strings, Comments, Destructuring)
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isSqliteAvailable,
  createTempWorkspace,
  createMockDatabaseFixture,
  getMockDatabaseClient,
  assertSqliteReadOnlyEnforced,
  assertHostDbWriteRejected,
  JsonlDatabaseFallbackWrapper,
  checkModLaws,
  assertNoNodeBuiltinImports,
  assertNoOutboundEgress
} from './helpers/e2e_harness.mjs';

// ============================================================================
// 1. Adversarial SQLite Read-Only Violation Attempts
// ============================================================================
describe('Adversarial SQLite Read-Only Stress', () => {
  it('raw SQL mutations fail on SQLite databaseSync opened with { readOnly: true }', async () => {
    if (!(await isSqliteAvailable())) {
      return;
    }
    const { DatabaseSync } = await import('node:sqlite');
    const ws = createTempWorkspace({ prefix: 'challenger-sqlite-' });

    try {
      const dbPath = path.join(ws.wsDir, 'readonly_target.db');

      // Initialize test database with schema and records in RW mode
      const initDb = new DatabaseSync(dbPath);
      initDb.exec(`
        CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, balance REAL);
        INSERT INTO items VALUES (1, 'initial', 100.0);
      `);
      initDb.close();

      // Open strictly read-only
      const roDb = new DatabaseSync(dbPath, { readOnly: true });

      // 1. INSERT attempt
      assert.throws(
        () => roDb.exec("INSERT INTO items VALUES (2, 'injected', 50.0);"),
        /readonly|read-only/i,
        'INSERT must be rejected'
      );

      // 2. UPDATE attempt
      assert.throws(
        () => roDb.exec("UPDATE items SET balance = 999.0 WHERE id = 1;"),
        /readonly|read-only/i,
        'UPDATE must be rejected'
      );

      // 3. DELETE attempt
      assert.throws(
        () => roDb.exec("DELETE FROM items WHERE id = 1;"),
        /readonly|read-only/i,
        'DELETE must be rejected'
      );

      // 4. DROP TABLE attempt
      assert.throws(
        () => roDb.exec("DROP TABLE items;"),
        /readonly|read-only/i,
        'DROP TABLE must be rejected'
      );

      // 5. PRAGMA writable_schema attempt
      // PRAGMA writable_schema = ON does not fail, but modifying sqlite_master fails with
      // "table sqlite_master may not be modified"
      roDb.exec("PRAGMA writable_schema = ON;");
      assert.throws(
        () => {
          roDb.exec("UPDATE sqlite_schema SET sql = 'broken' WHERE name = 'items';");
        },
        /may not be modified|readonly|read-only/i,
        'PRAGMA writable_schema mutation must be rejected'
      );

      // 6. PRAGMA journal_mode = WAL attempt
      assert.throws(
        () => roDb.exec("PRAGMA journal_mode = WAL;"),
        /readonly|read-only/i,
        'PRAGMA journal_mode change must be rejected on readonly connection'
      );

      // 7. VACUUM attempt
      assert.throws(
        () => roDb.exec("VACUUM;"),
        /readonly|read-only/i,
        'VACUUM must be rejected on readonly connection'
      );

      // 8. Prepared Statement run() attempt
      assert.throws(
        () => {
          const stmt = roDb.prepare("INSERT INTO items VALUES (?, ?, ?)");
          stmt.run(3, 'prep', 20.0);
        },
        /readonly|read-only/i,
        'Prepared statement mutation must be rejected'
      );

      // 9. Mutation disguised inside prepare().get() or prepare().all()
      assert.throws(
        () => {
          roDb.prepare("INSERT INTO items VALUES (4, 'disguised', 10.0)").get();
        },
        /readonly|read-only/i,
        'prepare().get() with mutation SQL must be rejected'
      );

      // 10. Temporary tables: SQLite allows CREATE TEMP TABLE in memory, but not in main DB
      assert.doesNotThrow(() => {
        roDb.exec("CREATE TEMP TABLE temp_items (id INT);");
        roDb.exec("INSERT INTO temp_items VALUES (99);");
      });

      // Verify that main DB items table was NOT modified
      const rows = roDb.prepare("SELECT * FROM items").all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'initial');
      assert.equal(rows[0].balance, 100.0);

      roDb.close();
    } finally {
      ws.cleanup();
    }
  });

  it('assertSqliteReadOnlyEnforced behaves properly on path and wrapper objects', async () => {
    const ws = createTempWorkspace({ prefix: 'challenger-assert-ro-' });
    try {
      const { dbPath, jsonlPath } = await createMockDatabaseFixture(path.join(ws.wsDir, 'test_assert'), {
        tables: { test: 'id INT' },
        records: [{ __table: 'test', __values: { id: 1 } }]
      });

      // Pass file path string
      await assertSqliteReadOnlyEnforced(dbPath);

      // Pass jsonl fallback wrapper
      const jsonlWrapper = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });
      await assertSqliteReadOnlyEnforced(jsonlWrapper);

      // Pass client returned from getMockDatabaseClient
      const client = await getMockDatabaseClient({ dbPath, readOnly: true, forceFallback: true });
      await assertSqliteReadOnlyEnforced(client);
    } finally {
      ws.cleanup();
    }
  });

  it('assertHostDbWriteRejected validates defense against non-readonly open options', () => {
    const strictOpen = (dbPath, options = {}) => {
      if (options.readOnly !== true) {
        throw new Error('[Zero-Trust SQLite Guard] Refusing read-write open on protected host database');
      }
      return { ok: true };
    };

    // Standard assertion with readOnly: false
    assert.doesNotThrow(() => {
      assertHostDbWriteRejected(strictOpen, '/path/to/conversations/123.db');
    });

    // What if someone opens with options = {} or readOnly: undefined?
    assert.throws(
      () => strictOpen('/path/to/conversations/123.db', {}),
      /Zero-Trust SQLite Guard/
    );
    assert.throws(
      () => strictOpen('/path/to/conversations/123.db', { readOnly: undefined }),
      /Zero-Trust SQLite Guard/
    );
    assert.throws(
      () => strictOpen('/path/to/conversations/123.db', { readOnly: 0 }),
      /Zero-Trust SQLite Guard/
    );
  });
});

// ============================================================================
// 2. Adversarial JSONL Fallback Store Stress
// ============================================================================
describe('Adversarial JSONL Fallback Store Stress', () => {
  it('handles empty files, whitespace-only files, and missing files without crash', () => {
    const ws = createTempWorkspace({ prefix: 'challenger-jsonl-empty-' });
    try {
      // 1. Missing file
      const missingWrapper = new JsonlDatabaseFallbackWrapper(path.join(ws.wsDir, 'missing.jsonl'), { readOnly: true });
      assert.deepEqual(missingWrapper.all(), []);
      assert.equal(missingWrapper.get(), null);
      assert.deepEqual(missingWrapper.searchFts('query'), []);

      // 2. Empty file
      const emptyPath = ws.writeFile('empty.jsonl', '');
      const emptyWrapper = new JsonlDatabaseFallbackWrapper(emptyPath, { readOnly: true });
      assert.deepEqual(emptyWrapper.all(), []);
      assert.equal(emptyWrapper.get(), null);

      // 3. Whitespace-only file (spaces, tabs, empty newlines)
      const wsPath = ws.writeFile('whitespace.jsonl', '   \n\n\t  \r\n   \n');
      const wsWrapper = new JsonlDatabaseFallbackWrapper(wsPath, { readOnly: true });
      assert.deepEqual(wsWrapper.all(), []);
      assert.equal(wsWrapper.get(), null);
    } finally {
      ws.cleanup();
    }
  });

  it('handles UTF-8 Byte Order Mark (BOM) cleanly', () => {
    const ws = createTempWorkspace({ prefix: 'challenger-jsonl-bom-' });
    try {
      // File starting with UTF-8 BOM: \uFEFF
      const bomContent = '\uFEFF' + JSON.stringify({ id: 1, name: 'BOM Record' }) + '\n' + JSON.stringify({ id: 2, name: 'Normal Record' }) + '\n';
      const bomPath = ws.writeFile('bom.jsonl', bomContent);

      const wrapper = new JsonlDatabaseFallbackWrapper(bomPath, { readOnly: true });
      const records = wrapper.all();

      assert.ok(Array.isArray(records));
      // In V8, JSON.parse fails on leading BOM character if not stripped.
      // Therefore, the first line is gracefully skipped as malformed, and record 2 is parsed!
      assert.ok(records.some(r => r.id === 2));
    } finally {
      ws.cleanup();
    }
  });

  it('handles corrupt, truncated, and mixed primitive lines', () => {
    const ws = createTempWorkspace({ prefix: 'challenger-jsonl-corrupt-' });
    try {
      const mixedContent = [
        '{"id": 1, "valid": true}',
        '{"id": 2, truncated line without closing',
        'NOT EVEN JSON',
        '{"id": 3, "nested": {"a": [1, 2, 3]}}',
        '12345',              // number primitive (parsed as 12345)
        '"a string literal"', // string primitive
        'null',               // null primitive (filtered out by Boolean)
        'true',               // boolean true
        'false',              // boolean false (filtered out by Boolean)
        '{"id": 4, "valid": true}',
        '{"escaped_unicode": "Hello \\u0000 \\u001F \u{1F600}"}'
      ].join('\n') + '\n';

      const jsonlPath = ws.writeFile('corrupt.jsonl', mixedContent);
      const wrapper = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });

      const records = wrapper.all();
      assert.ok(Array.isArray(records));

      // Valid records 1, 3, 4 should be present
      const ids = records.filter(r => r && typeof r === 'object' && 'id' in r).map(r => r.id);
      assert.deepEqual(ids, [1, 3, 4]);

      // searchFts resilience across mixed primitives
      const ftsMatches = wrapper.searchFts('valid');
      assert.equal(ftsMatches.length, 2);

      // Unicode search
      const unicodeMatches = wrapper.searchFts('\u{1F600}');
      assert.equal(unicodeMatches.length, 1);
    } finally {
      ws.cleanup();
    }
  });

  it('handles Windows CRLF and trailing newlines gracefully', () => {
    const ws = createTempWorkspace({ prefix: 'challenger-jsonl-crlf-' });
    try {
      const crlfContent = '{"id": 1}\r\n{"id": 2}\r\n{"id": 3}\r\n';
      const jsonlPath = ws.writeFile('crlf.jsonl', crlfContent);

      const wrapper = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });
      const records = wrapper.all();
      assert.equal(records.length, 3);
      assert.equal(records[0].id, 1);
      assert.equal(records[2].id, 3);
    } finally {
      ws.cleanup();
    }
  });

  it('searchFts handles edge-case queries and documents off-by-one boundary on limit=0', () => {
    const ws = createTempWorkspace({ prefix: 'challenger-jsonl-fts-' });
    try {
      const content = [
        JSON.stringify({ text: 'The quick brown fox', tag: 'A' }),
        JSON.stringify({ text: 'Jumps over the lazy dog', tag: 'B' }),
        JSON.stringify({ text: 'Special regex chars .*+?^${}()|[]\\ here', tag: 'C' })
      ].join('\n') + '\n';

      const jsonlPath = ws.writeFile('fts.jsonl', content);
      const wrapper = new JsonlDatabaseFallbackWrapper(jsonlPath, { readOnly: true });

      // 1. Empty query returns up to limit records
      const emptyRes = wrapper.searchFts('', 2);
      assert.equal(emptyRes.length, 2);

      // 2. Regex special characters must not throw or fail (they are treated as substrings)
      const regexRes = wrapper.searchFts('.*+?^$');
      assert.equal(regexRes.length, 1);
      assert.equal(regexRes[0].tag, 'C');

      // 3. Empirical verification of limit <= 0 boundary behavior:
      // In searchFts: `matches.push(record); if (matches.length >= limit) break;`
      // For limit = 0, matches.push happens before check, so matches.length is 1.
      const zeroLimit = wrapper.searchFts('the', 0);
      assert.equal(zeroLimit.length, 1, 'Documents boundary behavior where limit=0 returns 1 match');

      // 4. Case-insensitive token matching
      const caseRes = wrapper.searchFts('BROWN FOX');
      assert.equal(caseRes.length, 1);
      assert.equal(caseRes[0].tag, 'A');

      // 5. Multiple tokens (AND semantics)
      const andRes = wrapper.searchFts('lazy dog jumps');
      assert.equal(andRes.length, 1);
      assert.equal(andRes[0].tag, 'B');

      // 6. Non-matching query
      const noMatch = wrapper.searchFts('nonexistent token xyz');
      assert.equal(noMatch.length, 0);
    } finally {
      ws.cleanup();
    }
  });
});

// ============================================================================
// 3. Adversarial checkModLaws AST Scanner Stress
// ============================================================================
describe('Adversarial checkModLaws AST Scanner Stress', () => {
  it('empirically demonstrates Check 1 (node:* imports) bypasses and false positives', () => {
    // False negative 1: Multiline import
    const multilineImport = "import {\n  readFile\n} from 'node:fs';";
    const r1 = checkModLaws(multilineImport);
    assert.equal(
      r1.violations.some(v => v.includes('Check 1')),
      false,
      'Empirical: Check 1 regex lacks /s flag and fails to detect multiline import'
    );

    // False negative 2: Side-effect import
    const sideEffectImport = "import 'node:fs';";
    const r2 = checkModLaws(sideEffectImport);
    assert.equal(
      r2.violations.some(v => v.includes('Check 1')),
      false,
      'Empirical: Check 1 regex requires "from" and fails to detect side-effect import'
    );

    // False negative 3: Re-export from node:*
    const exportNode = "export * from 'node:fs';";
    const r3 = checkModLaws(exportNode);
    assert.equal(
      r3.violations.some(v => v.includes('Check 1')),
      false,
      'Empirical: Check 1 only inspects import, missing export from node:*'
    );

    // False positive 1: Comment containing import
    const commentImport = "// import fs from 'node:fs';";
    const r4 = checkModLaws(commentImport);
    assert.equal(
      r4.violations.some(v => v.includes('Check 1')),
      true,
      'Empirical: Check 1 flags comments as violations (False Positive)'
    );

    // False positive 2: String containing import
    const stringImport = "const msg = \"import fs from 'node:fs'\";";
    const r5 = checkModLaws(stringImport);
    assert.equal(
      r5.violations.some(v => v.includes('Check 1')),
      true,
      'Empirical: Check 1 flags string literals as violations (False Positive)'
    );
  });

  it('empirically demonstrates Check 2 ($ assignment) compound assignment bypass and comment false positive', () => {
    // False negative: Compound assignment
    const compound = "$ += 1;";
    const r1 = checkModLaws(compound);
    assert.equal(
      r1.violations.some(v => v.includes('Check 2')),
      false,
      'Empirical: Check 2 regex fails to catch compound assignment $ += 1'
    );

    // False negative: Increment
    const inc = "++$;";
    const r2 = checkModLaws(inc);
    assert.equal(
      r2.violations.some(v => v.includes('Check 2')),
      false,
      'Empirical: Check 2 regex fails to catch prefix increment ++$'
    );

    // False positive: Comment
    const comment = "// $ = 5;";
    const r3 = checkModLaws(comment);
    assert.equal(
      r3.violations.some(v => v.includes('Check 2')),
      true,
      'Empirical: Check 2 flags comments as violations (False Positive)'
    );
  });

  it('empirically demonstrates Check 3 & 4 ($ destructuring & shorthand) multi-var bypasses', () => {
    // False negative: Multi-var destructuring
    const multiVar = "const { a, $ } = ctx;";
    const r1 = checkModLaws(multiVar);
    assert.equal(
      r1.violations.some(v => v.includes('Check 3')),
      false,
      'Empirical: Check 3 regex fails to catch multi-var destructuring { a, $ }'
    );

    // False negative: Array destructuring
    const arrayDestruct = "const [ $ ] = arr;";
    const r2 = checkModLaws(arrayDestruct);
    assert.equal(
      r2.violations.some(v => v.includes('Check 3')),
      false,
      'Empirical: Check 3 regex fails to catch array destructuring [ $ ]'
    );

    // False negative: Shorthand not first property
    const shorthandSecond = "const obj = { a: 1, $ };";
    const r3 = checkModLaws(shorthandSecond);
    assert.equal(
      r3.violations.some(v => v.includes('Check 4')),
      false,
      'Empirical: Check 4 regex fails to catch shorthand when not first property { a: 1, $ }'
    );
  });

  it('empirically demonstrates Check 5 (Balanced call scanner) false positives on strings and comments', () => {
    // False positive 1: Parenthesis in string literal
    const parenInString = "const log = console.log('Unbalanced ( paren in string');";
    const r1 = checkModLaws(parenInString);
    assert.equal(
      r1.violations.some(v => v.includes('Check 5')),
      true,
      'Empirical: Check 5 treats parenthesis in string literal as unbalanced code syntax'
    );

    // False positive 2: Brace in comment
    const braceInComment = "// Unbalanced { in comment\nconst x = 1;";
    const r2 = checkModLaws(braceInComment);
    assert.equal(
      r2.violations.some(v => v.includes('Check 5')),
      true,
      'Empirical: Check 5 treats brace in comment as unbalanced code syntax'
    );

    // False positive 3: Regex with parenthesis
    const parenInRegex = "const re = /\\(/;";
    const r3 = checkModLaws(parenInRegex);
    assert.equal(
      r3.violations.some(v => v.includes('Check 5')),
      true,
      'Empirical: Check 5 treats parenthesis in regex literal as unbalanced code syntax'
    );
  });

  it('empirically demonstrates Check 8 & 9 (Async hooks and unhandled throws) blindspots', () => {
    // False negative: Async arrow function
    const asyncArrow = "const hook = async (e) => { await execute(e); };";
    const r1 = checkModLaws(asyncArrow);
    assert.equal(
      r1.violations.some(v => v.includes('Check 8')),
      false,
      'Empirical: Check 8 uses sourceCode.includes("async function") and misses async arrow functions'
    );

    // False negative: Async method
    const asyncMethod = "class H { async onEvent(e) { await run(e); } }";
    const r2 = checkModLaws(asyncMethod);
    assert.equal(
      r2.violations.some(v => v.includes('Check 8')),
      false,
      'Empirical: Check 8 misses async class methods'
    );

    // False negative: TypeError throw
    const throwType = "function test() { throw new TypeError('custom'); }";
    const r3 = checkModLaws(throwType);
    assert.equal(
      r3.violations.some(v => v.includes('Check 9')),
      false,
      'Empirical: Check 9 regex only matches "throw new Error" and misses TypeError'
    );

    // False negative 3: Inline unhandled throw (not at line start)
    const inlineThrow = "function test() { if (bad) throw new Error('unhandled inline'); }";
    const r4 = checkModLaws(inlineThrow);
    assert.equal(
      r4.violations.some(v => v.includes('Check 9')),
      false,
      'Empirical: Check 9 regex requires line start and misses inline throw statements'
    );

    // False positive: Handled throw inside try/catch block (on new line)
    const throwInsideTry = "try {\n  throw new Error('handled');\n} catch (err) {\n  return { decision: 'deny' };\n}";
    const r5 = checkModLaws(throwInsideTry);
    assert.equal(
      r5.violations.some(v => v.includes('Check 9')),
      true,
      'Empirical: Check 9 flags throw statements inside try/catch as unhandled violations'
    );
  });

  it('empirically demonstrates Check 11 (globalThis assignment) bracket notation bypass', () => {
    const bracketAssign = "globalThis['compromised'] = true;";
    const r = checkModLaws(bracketAssign);
    assert.equal(
      r.violations.some(v => v.includes('Check 11')),
      false,
      'Empirical: Check 11 regex only checks dot notation and misses bracket assignment'
    );
  });
});
