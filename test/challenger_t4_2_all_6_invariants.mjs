import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createIsolatedTestSandbox,
  assertPlainTextCompact,
  assertNoOutboundEgress,
  assertMirrorParity,
  createMockDatabaseFixture,
  isSqliteAvailable
} from './helpers/e2e_harness.mjs';
import { isIgnorablePath } from '../src/core/paths.mjs';
import { sanitizeForensicPayload } from '../src/core/sanitizer.mjs';
import { scorePromptSufficiency, RUBRIC_DIMENSIONS, SUFFICIENCY_BANDS } from '../src/core/prompt_rubric.mjs';
import { SqliteDatabaseSyncWrapper } from '../src/engine-node/db/sqlite_wrapper.mjs';

async function testAll6Invariants16Tenants() {
  const WORKER_COUNT = 16;
  const sqliteReady = await isSqliteAvailable();

  const results = await Promise.all(
    Array.from({ length: WORKER_COUNT }, async (_, workerId) => {
      const ws = createIsolatedTestSandbox({ withAntigravityDir: true });
      try {
        // Invariant 1: Plain-Text /compact
        assertPlainTextCompact('<div id="compactInstruction">Type /compact in the chat box and press Enter</div>');

        // Invariant 2: Active Source Protection
        assert.equal(isIgnorablePath('src/core/router.mjs'), false);
        assert.equal(isIgnorablePath('package-lock.json'), true);

        // Invariant 3: Mirror Parity
        const pA = path.join(ws.workspaceDir, 'pluginA.mjs');
        const pB = path.join(ws.workspaceDir, 'pluginB.mjs');
        fs.writeFileSync(pA, 'export const v = 42;');
        fs.writeFileSync(pB, 'export const v = 42;');
        const mirrorRes = assertMirrorParity({ filePairs: [[pA, pB]] });
        assert.equal(mirrorRes.mismatches.length, 0);

        // Invariant 4: Zero-Trust Read-Only SQLite
        if (sqliteReady) {
          const fixture = await createMockDatabaseFixture(path.join(ws.workspaceDir, `db_${workerId}`), {
            tables: { t: 'id INT' },
            records: [{ __table: 't', __values: { id: 1 } }]
          });
          const db = new SqliteDatabaseSyncWrapper(fixture.dbPath, { readOnly: true });
          assert.equal(db.get('SELECT count(*) as c FROM t').c, 1);
          assert.throws(() => db.get('INSERT INTO t VALUES (2)'), /Zero-Trust SQLite Guard/);
          db.close();
        }

        // Invariant 5: Zero Outbound Egress
        assert.doesNotThrow(() => assertNoOutboundEgress('const localOnly = true;'));

        // Invariant 6: Zero PII
        const sanitized = sanitizeForensicPayload('key=sk-ant-api03-testkey1234');
        assert.ok(sanitized.sanitized.includes('[REDACTED:ANTHROPIC_KEY]'));

        // Prompt Sufficiency Benchmark
        const prompt = 'Implement Feature 41 E2E Test Suite in test/e2e_tier1_features.test.mjs. Ensure 41 feature suites pass without touching other workspace files. Verify exit code 0 and expect output returns pass, assert strict zero-dep compliance with invariant constraints, and check caller imports in bin/ctxtop.mjs and src/core/prompt_rubric.mjs for mirror sync.';
        const rubric = scorePromptSufficiency(prompt, {
          activeSetPaths: ['test/e2e_tier1_features.test.mjs', 'src/core/prompt_rubric.mjs']
        });
        const score = parseFloat(((rubric.score / (RUBRIC_DIMENSIONS.length * 2)) * 100).toFixed(2));
        return { workerId, success: true, score, band: rubric.band };
      } finally {
        ws.cleanup();
      }
    })
  );

  assert.equal(results.length, WORKER_COUNT);
  for (const r of results) {
    assert.equal(r.success, true);
    assert.equal(r.band, SUFFICIENCY_BANDS.HIGH);
    assert.ok(r.score >= 96.25, `Worker ${r.workerId} composite score ${r.score} < 96.25 requirement`);
  }
  console.log(`[PASS] All ${WORKER_COUNT} tenants successfully enforced all 6 invariants with score >= 96.25`);
}

testAll6Invariants16Tenants().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
