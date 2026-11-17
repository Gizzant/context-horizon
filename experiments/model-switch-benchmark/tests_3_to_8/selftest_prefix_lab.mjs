import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRepNonce,
  injectNonceAndBreakpoints,
  loadPinnedCorpusSlice,
  computeUsageCostExt,
  RunBudgetTracker,
  sendMessagesCall,
  summarizeMedianRange,
  wilson95,
  redactSensitiveText,
  assertNoSensitiveLeaks,
  writeCsv,
  STANDARD_CSV_COLUMNS
} from './prefix_lab.mjs';

async function main() {
  // 1. Nonce isolation & 3-layer cache_control breakpoints
  const n1 = createRepNonce('t6_rep1');
  const n2 = createRepNonce('t6_rep2');
  assert.notEqual(n1, n2);

  const built = injectNonceAndBreakpoints({
    nonce: n1,
    ttl: '1h',
    tools: [
      { name: 't1', description: 'First tool', input_schema: { type: 'object', properties: {} } },
      { name: 't2', description: 'Second tool', input_schema: { type: 'object', properties: {} } }
    ],
    system: [
      { type: 'text', text: 'System rules block', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Secondary system block' }
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Old turn', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] },
      { role: 'user', content: 'Latest user prompt' }
    ]
  });

  assert.ok(built.tools[0].description.startsWith(`[NONCE:${n1}] `));
  assert.ok(built.tools[1].description.startsWith(`[NONCE:${n1}] `));
  assert.equal(built.tools[0].cache_control, undefined);
  assert.deepEqual(built.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.ok(built.system[0].text.startsWith(`[NONCE:${n1}] `));
  assert.equal(built.system[0].cache_control, undefined);
  assert.deepEqual(built.system[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(built.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(built.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });

  // 2. Pinned corpus extraction
  const corpus = loadPinnedCorpusSlice('src/core-isomorphic/economics/billingBlocks.mjs', 1, 30);
  assert.ok(corpus.includes('BILLING_BLOCK_CONSTANTS'));

  // 3. Usage cost calculation (billed vs computed & 5m/1h split)
  const cost1h = computeUsageCostExt(
    'anthropic/claude-sonnet-4.6',
    {
      input_tokens: 100,
      cache_creation_input_tokens: 20000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20000 },
      cache_read_input_tokens: 0,
      output_tokens: 50
    },
    { requestedTtl: '1h' }
  );
  assert.equal(cost1h.write1hTokens, 20000);
  assert.equal(cost1h.write5mTokens, 0);
  assert.ok(Math.abs(cost1h.totalCostUsd - 0.12105) < 1e-6);

  // 4. Budget breaker
  const tracker = new RunBudgetTracker({ expectedRunUsd: 0.10, multiplier: 3, maxBudgetUsd: 5.0, label: 'selftest' });
  tracker.record(0.25);
  assert.throws(() => tracker.record(0.06), /exceeded 3x/i);

  // 5. Redaction & leak guard (construct mock secret strings dynamically)
  const fakeOr = ['sk-or', 'v1', 'abcdef1234567890'].join('-');
  const fakeAnt = ['sk-ant', 'usr', 'fakeToken1234567890'].join('-');
  const fakeGem = ['AQ', 'Ab8RN6MockToken1234567890'].join('.');
  const fakePath = ['C:', 'Users', 'fakeusername', 'proj', 'secret.txt'].join('\\');
  const dirty = `k1=${fakeOr} k2=${fakeAnt} k3=${fakeGem} p=${fakePath}`;
  const clean = redactSensitiveText(dirty);
  assertNoSensitiveLeaks(clean, 'selftest_redacted');
  assert.throws(() => assertNoSensitiveLeaks(dirty, 'selftest_dirty'), /Privacy leak detected/);

  // 6. Median [min-max] and Wilson 95% CI
  const medOdd = summarizeMedianRange([5, 1, 9, 3, 7]);
  assert.deepEqual(medOdd, { n: 5, median: 5, min: 1, max: 9 });
  const medEven = summarizeMedianRange([10, 2, 6, 4]);
  assert.deepEqual(medEven, { n: 4, median: 5, min: 2, max: 10 });
  const ci = wilson95(18, 20);
  assert.ok(ci.p === 0.9 && ci.low > 0.68 && ci.high < 0.99);

  // 7. Local mock server end-to-end (stream=false max_tokens=0, stream=true SSE, auth retry)
  const capturedReqs = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw);
      capturedReqs.push({ headers: req.headers, body });

      // Simulate sk-ant-usr- needing Bearer auth on direct API check
      if (!req.headers['x-api-key'] && !req.headers.authorization) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing auth' } }));
        return;
      }
      if (req.headers['x-api-key'] && String(req.headers['x-api-key']).includes('-usr-')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'x-api-key invalid for usr token' } }));
        return;
      }

      if (!body.stream) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-openrouter-provider': 'Anthropic'
        });
        res.end(JSON.stringify({
          id: 'msg_mock_nonstream',
          model: body.model,
          stop_reason: body.max_tokens === 0 ? 'max_tokens' : 'end_turn',
          content: body.max_tokens === 0 ? [] : [{ type: 'text', text: 'ok nonstream' }],
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 2000,
            cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
            cache_read_input_tokens: 0,
            output_tokens: body.max_tokens === 0 ? 0 : 12,
            cost: 0.007695
          }
        }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'x-openrouter-provider': 'Anthropic'
      });
      res.write('event: message_start\n');
      res.write(`data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_mock_stream',
          model: body.model,
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
            cache_read_input_tokens: 1900,
            output_tokens: 1
          }
        }
      })}\n\n`);
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok stream"}}\n\n');
      res.write('event: message_delta\n');
      res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8,"cost":0.0011}}\n\n');
      res.write('event: message_stop\n');
      res.write('data: {"type":"message_stop"}\n\n');
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}`;

  try {
    const r0 = await sendMessagesCall({
      test: 'SELFTEST',
      arm: 'P1',
      rep: 1,
      turn: 0,
      route: 'openrouter',
      baseUrl: mockUrl,
      apiKey: fakeOr,
      model: 'anthropic/claude-sonnet-4.6',
      system: built.system,
      messages: built.messages,
      max_tokens: 0,
      stream: false,
      nonceId: n1
    });
    assert.equal(r0.row.http_status, 200);
    assert.equal(r0.row.cache_write_5m_tokens, 2000);
    assert.equal(r0.row.cost_source, 'billed');
    assert.equal(r0.row.billed_cost_usd, 0.007695);
    assert.deepEqual(capturedReqs[0].body.provider, { only: ['anthropic'], allow_fallbacks: false });

    const r1 = await sendMessagesCall({
      test: 'SELFTEST',
      arm: 'P1',
      rep: 1,
      turn: 1,
      route: 'anthropic_direct',
      baseUrl: mockUrl,
      apiKey: fakeAnt,
      model: 'anthropic/claude-sonnet-4.6',
      system: built.system,
      messages: built.messages,
      max_tokens: 50,
      stream: true,
      anthropicBeta: 'mid-conversation-output-config-2026-07-01',
      nonceId: n1
    });
    assert.equal(r1.row.http_status, 200);
    assert.equal(r1.row.cache_read_tokens, 1900);
    assert.equal(r1.row.provider, 'anthropic_direct(bearer)');
    assert.equal(r1.assistantText, 'ok stream');
    assert.equal(capturedReqs[2].headers['anthropic-beta'], 'mid-conversation-output-config-2026-07-01');
    assert.equal(capturedReqs[2].body.provider, undefined);

    const tmpCsv = path.join(os.tmpdir(), 'prefix_lab_selftest.csv');
    writeCsv(tmpCsv, STANDARD_CSV_COLUMNS, [r0.row, r1.row]);
    assert.ok(fs.readFileSync(tmpCsv, 'utf8').includes('msg_mock') === false);
    fs.unlinkSync(tmpCsv);
  } finally {
    server.close();
  }

  console.log('SELFTEST_PREFIX_LAB PASS (all 7 offline checks verified, $0 spend)');
}

main().catch((err) => {
  console.error('SELFTEST_PREFIX_LAB FAIL:', err);
  process.exit(1);
});
