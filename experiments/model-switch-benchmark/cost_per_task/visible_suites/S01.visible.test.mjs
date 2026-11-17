import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice, exportInvoiceCsv } from '../src/invoiceBuilder.mjs';

test('S01 visible: exportInvoiceCsv escapes RFC-4180 quotes and neutralizes formula cells', () => {
  const inv = buildInvoice({
    invoiceId: 'inv-s01',
    accountId: '=SUM(A1:A2)',
    currency: 'USD',
    usageRows: [{ metric: 'api,"core"', units: 10, tiers: [{ upTo: null, unitRateCents: 5 }] }]
  });
  const csv = exportInvoiceCsv(inv);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'invoiceId,accountId,currency,metric,units,amountCents,totalDueCents');
  assert.ok(lines[1].includes("'=SUM(A1:A2)"));
  assert.ok(lines[1].includes('"api,""core"""'));
});
