import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter } from '../src/queryDsl.mjs';
import { buildInvoice } from '../src/invoiceBuilder.mjs';

test('T05 visible: IN operator and filtered grouped event invoicing', () => {
  const pred = compileFilter('tags.region IN ("us-east", "eu-west")');
  assert.equal(pred({ tags: { region: 'us-east' } }), true);
  assert.equal(pred({ tags: { region: 'ap-south' } }), false);

  const metricTiers = {
    api_calls: [
      { upTo: 100, unitRateCents: 10 },
      { upTo: null, unitRateCents: 5 }
    ]
  };
  const inv = buildInvoice({
    invoiceId: 'inv-t05',
    accountId: 'acct-2',
    events: [
      { metric: 'api_calls', units: 40, tags: { region: 'us-east', team: 'core' } },
      { metric: 'api_calls', units: 30, tags: { region: 'eu-west', team: 'core' } },
      { metric: 'api_calls', units: 20, tags: { region: 'ap-south', team: 'ml' } }
    ],
    metricTiers,
    filterExpr: 'tags.region IN ("us-east", "eu-west")',
    groupByTag: 'team'
  });

  assert.equal(inv.excludedEventCount, 1);
  assert.equal(inv.usageSubtotalCents, 700);
  assert.equal(inv.lineItems.length, 1);
  assert.equal(inv.lineItems[0].groupValue, 'core');
});
