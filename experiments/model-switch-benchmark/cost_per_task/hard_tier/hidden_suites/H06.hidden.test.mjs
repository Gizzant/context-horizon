import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClosedPeriodLedger } from './src/invoiceBuilder.mjs';
import { ERROR_CODES } from './src/errors.mjs';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHA_FROZEN_WIRE = 'c86d6f4517450db0753fc721968d27af26efe17b01acba3904c99f8b21505325';
const SHA_CONSTANTS = '25aec7fc36f68b3e71c495a215dafaabcf0ea2f51b52a96cd9f5812c79ea5d89';

function shaLf(rel) {
  const raw = fs.readFileSync(path.join(REPO_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('H06 hidden: baseline and visible suite pass', () => {
  const files = fs.readdirSync(path.join(REPO_DIR, 'test')).filter((x) => x.endsWith('.test.mjs')).sort().map((x) => path.join('test', x));
  const res = spawnSync(process.execPath, ['--test', ...files], { cwd: REPO_DIR, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
});

test('H06 hidden: multi-window VOID_MATCHING re-waterfall, grant expiry cutoff, and atomic negative rollback', () => {
  const grants = [
    { grantId: 'g-jan-feb', remainingCents: 400, effectiveFromMs: 0, expiresAtMs: Date.UTC(2026, 2, 1, 0, 0, 1) }, // expires right after Feb end!
    { grantId: 'g-long', remainingCents: 200, effectiveFromMs: 0, expiresAtMs: Date.UTC(2026, 6, 1) }
  ];
  const grantsBefore = JSON.stringify(grants);

  const ledger = createClosedPeriodLedger({
    accountId: 'acct-h06',
    timeZone: 'UTC',
    anchorHourLocal: 0,
    grants,
    metricTiers: {
      api: [
        { upTo: 100, unitRateCents: 10 },
        { upTo: null, unitRateCents: 5 }
      ]
    }
  });

  // Month 1 (Jan): 40 prod + 30 test = 70 -> 700c. Uses 400 from g-jan-feb + 200 from g-long = 600c credit, 100c due
  const jan = ledger.closePeriod({
    periodKey: '2026-01',
    year: 2026,
    month: 1,
    anchorDay: 1,
    events: [
      { metric: 'api', units: 40, timestampMs: Date.UTC(2026, 0, 10), tags: { env: 'prod' } },
      { metric: 'api', units: 30, timestampMs: Date.UTC(2026, 0, 11), tags: { env: 'test' } }
    ]
  });
  // Month 2 (Feb): 30 prod -> 300c, 0 credits left -> 300c due
  const feb = ledger.closePeriod({
    periodKey: '2026-02',
    year: 2026,
    month: 2,
    anchorDay: 1,
    events: [{ metric: 'api', units: 30, timestampMs: Date.UTC(2026, 1, 10), tags: { env: 'prod' } }]
  });
  // Month 3 (Mar): 20 prod -> 200c, 0 credits left -> 200c due
  const mar = ledger.closePeriod({
    periodKey: '2026-03',
    year: 2026,
    month: 3,
    anchorDay: 1,
    events: [{ metric: 'api', units: 20, timestampMs: Date.UTC(2026, 2, 10), tags: { env: 'prod' } }]
  });
  assert.equal(jan.totalDueCents, 100);
  assert.equal(feb.totalDueCents, 300);
  assert.equal(mar.totalDueCents, 200);

  // Attempting to subtract more units than exist fails atomically with ERR_NEGATIVE_UNITS!
  const snapBeforeErr = JSON.stringify(ledger.getEffectiveLedgerSummary());
  assert.throws(
    () => ledger.applyRetroactiveAmendment({ amendmentId: 'bad', targetPeriodKey: '2026-01', op: 'SUBTRACT', events: [{ metric: 'api', units: 999 }] }),
    (err) => err.code === ERROR_CODES.ERR_NEGATIVE_UNITS
  );
  assert.equal(JSON.stringify(ledger.getEffectiveLedgerSummary()), snapBeforeErr);

  // VOID_MATCHING removes env == "test" (30 units) from Jan -> Jan usage drops 70->40 (400c, uses ONLY g-jan-feb 400c; g-long 200c freed!)
  // Now Feb uses 200c from g-long -> Feb due drops 300 -> 100 (-200c CREDIT_MEMO); Mar unaffected (no memo emitted!)
  const amend1 = ledger.applyRetroactiveAmendment({
    amendmentId: 'am-void-test',
    targetPeriodKey: '2026-01',
    op: 'VOID_MATCHING',
    filterExpr: 'tags.env == "test"'
  });
  assert.equal(amend1.memos.length, 2);
  assert.equal(amend1.memos[0].periodKey, '2026-01');
  assert.equal(amend1.memos[0].type, 'CREDIT_MEMO');
  assert.equal(amend1.memos[0].deltaDueCents, -100);
  assert.equal(amend1.memos[0].deltaCreditsCents, -200);
  assert.equal(amend1.memos[1].periodKey, '2026-02');
  assert.equal(amend1.memos[1].type, 'CREDIT_MEMO');
  assert.equal(amend1.memos[1].deltaDueCents, -200);
  assert.equal(amend1.memos[1].deltaCreditsCents, 200);

  // Add 110 units to Feb (pooled 30+110=140 -> 100*10 + 40*5 = 1200c) -> DEBIT_MEMO
  const amend2 = ledger.applyRetroactiveAmendment({
    amendmentId: 'am-add-feb',
    targetPeriodKey: '2026-02',
    op: 'ADD',
    events: [{ metric: 'api', units: 110 }]
  });
  assert.equal(amend2.memos.length, 1);
  assert.equal(amend2.memos[0].type, 'DEBIT_MEMO');
  assert.equal(amend2.memos[0].effectiveTotalDueCents, 1000);
  assert.equal(JSON.stringify(grants), grantsBefore);
});

test('[CONSTRAINT-1] zero external deps and zero eval/Function in src/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  for (const f of fs.readdirSync(path.join(REPO_DIR, 'src'))) {
    if (!f.endsWith('.mjs')) continue;
    const t = fs.readFileSync(path.join(REPO_DIR, 'src', f), 'utf8');
    assert.equal(/\beval\s*\(/.test(t), false);
    assert.equal(/\bnew\s+Function\b/.test(t), false);
  }
});

test('[CONSTRAINT-2] frozenWire.mjs and constants.mjs remain unmodified', () => {
  assert.equal(shaLf('src/frozenWire.mjs'), SHA_FROZEN_WIRE);
  assert.equal(shaLf('src/constants.mjs'), SHA_CONSTANTS);
});
