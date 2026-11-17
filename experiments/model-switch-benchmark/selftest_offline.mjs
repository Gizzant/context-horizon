import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProxyServer } from './proxy_recorder.mjs';
import { computeUsageCostUsd, buildFullSchedule } from './config.mjs';
import { analyzeResults } from './analyze_results.mjs';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-switch-selftest-'));
  const wireLogPath = path.join(tmpDir, 'proxy_wire_log.jsonl');
  const receivedHeaders = [];
  const receivedBodies = [];

  // 1. Mock OpenRouter Anthropic-skin server
  const mockUpstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      receivedHeaders.push({ url: req.url, headers: { ...req.headers } });
      const parsed = raw ? JSON.parse(raw) : {};
      receivedBodies.push(parsed);

      if (req.url?.startsWith('/api/v1/messages/count_tokens')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not implemented on mock' }));
        return;
      }

      if (req.url?.startsWith('/api/v1/messages')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'x-openrouter-provider': 'Anthropic',
          'x-request-id': 'req_selftest_01'
        });
        const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        const isWarm = Array.isArray(parsed.messages) && parsed.messages.length > 1;
        send('message_start', {
          type: 'message_start',
          message: {
            id: `msg_test_${receivedBodies.length}`,
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [],
            usage: isWarm
              ? {
                  input_tokens: 180,
                  cache_creation_input_tokens: 320,
                  cache_read_input_tokens: 58000,
                  cache_creation: { ephemeral_5m_input_tokens: 320, ephemeral_1h_input_tokens: 0 },
                  output_tokens: 1
                }
              : {
                  input_tokens: 120,
                  cache_creation_input_tokens: 58000,
                  cache_read_input_tokens: 0,
                  cache_creation: { ephemeral_5m_input_tokens: 58000, ephemeral_1h_input_tokens: 0 },
                  output_tokens: 1
                }
          }
        });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        // Test critical rule: message_delta omits cache_* fields and only updates output_tokens
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 200 }
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
  const upPort = mockUpstream.address().port;

  const proxy = await startProxyServer({
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upPort}`,
    upstreamApiPrefix: '/api',
    apiKey: 'sk-or-v1-selftest-secret-key-999999',
    maxBudgetUsd: 0.46,
    wireLogPath,
    pinProvider: true
  });

  try {
    // A. count_tokens 404 fallback
    const ctRes = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-dummy' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hello world'.repeat(20) }] })
    });
    assert.equal(ctRes.status, 200, 'count_tokens should fallback to HTTP 200');
    const ctJson = await ctRes.json();
    assert.ok(ctJson.input_tokens > 0, 'count_tokens fallback should estimate positive tokens');

    // B. Tool-less side call
    proxy.setContext({ runId: 'SELFTEST', arm: 'A', tier: 'large', turn: 1 });
    const sideRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-dummy' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'classify' }]
      })
    });
    assert.equal(sideRes.status, 200);
    await sideRes.text();

    // C. Main Turn 1 cold write on Opus 4.6 (cost ~$0.368)
    const t1Res = await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-dummy-should-be-stripped',
        'accept-encoding': 'gzip, br'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        stream: true,
        output_config: { effort: 'medium' },
        tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
        system: [{ type: 'text', text: 'System instructions', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    assert.equal(t1Res.status, 200);
    await t1Res.text();

    // D. Warm Turn 2 on Opus 4.6 (cumulative spend should exceed 0.40 after this turn)
    const t2Res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-dummy' },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        stream: true,
        output_config: { effort: 'high' },
        tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
        system: [{ type: 'text', text: 'System instructions', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Turn 1' }, { role: 'assistant', content: 'Resp 1' }, { role: 'user', content: 'Turn 2' }]
      })
    });
    assert.equal(t2Res.status, 200);
    await t2Res.text();

    // E. Next request must trip budget circuit breaker (HTTP 429)
    const blockedRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-dummy' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        stream: true,
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'Should block' }]
      })
    });
    assert.equal(blockedRes.status, 429, 'Budget circuit breaker should return 429');

    // Verify wire headers & provider pinning
    const mainReqHeader = receivedHeaders[2].headers;
    assert.equal(mainReqHeader['x-api-key'], undefined, 'Dummy x-api-key must be removed');
    assert.equal(mainReqHeader['authorization'], 'Bearer sk-or-v1-selftest-secret-key-999999');
    assert.equal(mainReqHeader['accept-encoding'], 'identity', 'Accept-Encoding must be forced to identity for unbuffered SSE');
    assert.equal(receivedBodies[2].model, 'anthropic/claude-opus-4.6');
    assert.deepEqual(receivedBodies[2].provider, { only: ['anthropic'], allow_fallbacks: false });
    assert.equal(receivedHeaders[2].url, '/api/v1/messages?beta=true');

    // Verify log contents & secret hygiene
    const rawLogText = fs.readFileSync(wireLogPath, 'utf8');
    assert.ok(!rawLogText.includes('sk-or-v1-'), 'API key must NEVER appear in wire log');
    const logLines = rawLogText.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(logLines.length, 5);

    const t1Log = logLines[2];
    const t2Log = logLines[3];
    assert.equal(t1Log.isSideCall, false);
    assert.equal(logLines[1].isSideCall, true);
    assert.equal(t1Log.usage.cache_creation_input_tokens, 58000, 'Must preserve cache_creation from message_start');
    assert.equal(t1Log.usage.output_tokens, 200, 'Must merge output_tokens from message_delta');
    assert.equal(t2Log.usage.cache_read_input_tokens, 58000);
    assert.equal(t2Log.requestFingerprint.output_config.effort, 'high');
    assert.equal(t1Log.requestFingerprint.systemSha256, t2Log.requestFingerprint.systemSha256);

    const manualCost = computeUsageCostUsd('anthropic/claude-opus-4.6', {
      input_tokens: 120,
      cache_creation_input_tokens: 58000,
      cache_read_input_tokens: 0,
      output_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 58000, ephemeral_1h_input_tokens: 0 }
    });
    assert.ok(Math.abs(t1Log.cost.totalCostUsd - manualCost.totalCostUsd) < 1e-6);

    // Verify schedule builder shape (45 randomized runs)
    const sched = buildFullSchedule();
    assert.equal(sched.length, 45, 'Full schedule must have 45 runs (6 Small + 3 Large) x 5 replicates');
    assert.equal(sched.filter((r) => r.arm === 'F' && r.tier === 'large').length, 5);

    // Verify analyzeResults end-to-end on synthetic raw dir
    const analyzeInDir = path.join(tmpDir, 'mock_raw');
    const analyzeOutDir = path.join(tmpDir, 'mock_out');
    fs.mkdirSync(path.join(analyzeInDir, 'transcripts'), { recursive: true });
    // Copy wire log lines cleanly with Arm A and Arm D synthetic events
    const baseEntries = [
      { ...t1Log, wireSeq: 1, context: { runId: 'A_L_r01', arm: 'A', tier: 'large', replicate: 1, turn: 1, phase: 'load', scheduledEffort: 'medium' } },
      { ...t1Log, wireSeq: 2, context: { runId: 'A_L_r01', arm: 'A', tier: 'large', replicate: 1, turn: 6, phase: 'switch_point', scheduledEffort: 'medium' } },
      { ...t1Log, wireSeq: 3, context: { runId: 'D_S_r01', arm: 'D', tier: 'small', replicate: 1, turn: 5, phase: 'pre_switch', scheduledEffort: 'medium' } },
      { ...t2Log, wireSeq: 4, context: { runId: 'D_S_r01', arm: 'D', tier: 'small', replicate: 1, turn: 6, phase: 'switch_point', scheduledEffort: 'high' } }
    ];
    fs.writeFileSync(path.join(analyzeInDir, 'proxy_wire_log.jsonl'), baseEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(analyzeInDir, 'cli_turns.jsonl'), '');
    fs.writeFileSync(path.join(analyzeInDir, 'openrouter_ledger.jsonl'), '');
    fs.writeFileSync(
      path.join(analyzeInDir, 'transcripts', 'D_S_r01.jsonl'),
      JSON.stringify({ type: 'assistant', message: { id: t2Log.messageId, role: 'assistant', usage: t2Log.usage } }) + '\n'
    );
    const analysisRes = analyzeResults({ modeDir: analyzeInDir, outDir: analyzeOutDir });
    assert.equal(analysisRes.turnRowsCount, 4);
    assert.ok(fs.existsSync(path.join(analyzeOutDir, 'turns.csv')));
    assert.ok(fs.existsSync(path.join(analyzeOutDir, 'summary_by_arm.csv')));
    assert.ok(fs.existsSync(path.join(analyzeOutDir, 'chart_cache_tokens_by_turn.svg')));
    assert.ok(fs.existsSync(path.join(analyzeOutDir, 'chart_cost_penalty.svg')));
    assert.ok(fs.existsSync(path.join(analyzeOutDir, 'article_findings_report.md')));
    assert.ok(analysisRes.armDDiff.changedFields.some((f) => f.field === 'output_config'), 'Arm D diff must detect effort change');

    console.log('SELFTEST_OK:', JSON.stringify({
      logRecords: logLines.length,
      t1CostUsd: t1Log.cost.totalCostUsd,
      t2CostUsd: t2Log.cost.totalCostUsd,
      t2HitRatio: Number(t2Log.usage.cache_hit_ratio.toFixed(4)),
      budgetBreakerTriggered: logLines[4].blockedByBudgetBreaker,
      scheduleCount: sched.length,
      analyzedTurns: analysisRes.turnRowsCount
    }));
  } finally {
    await proxy.close();
    mockUpstream.closeAllConnections?.();
    await new Promise((r) => mockUpstream.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
