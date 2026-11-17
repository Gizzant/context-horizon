import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CLAUDE_EXE,
  FROZEN_REPO_DIR,
  RESULTS_DIR
} from '../config.mjs';
import {
  loadBenchmarkKeys,
  redactSensitiveText,
  assertNoSensitiveLeaks,
  createRepNonce,
  injectNonceAndBreakpoints,
  loadPinnedCorpusSlice,
  sendMessagesCall,
  makeSimpleHttpRequestForProbe
} from './prefix_lab.mjs';

const RATE_CARD_OUT = path.join(RESULTS_DIR, 'phase0_rate_card.json');
const REPORT_OUT = path.join(RESULTS_DIR, 'phase0_capabilities_and_cost_gate.md');

function getExtraSecretsList(keys) {
  return [
    keys.OPENROUTER_API_KEY,
    keys.ANTHROPIC_API_KEY,
    keys.GEMINI_BENCHMARK_API_KEY,
    keys.ENV_GEMINI_API_KEY
  ].filter(Boolean);
}

async function fetchJsonProbe({ url, method = 'GET', headers = {}, body = null }) {
  const res = await makeSimpleHttpRequestForProbe({ url, method, headers, body, timeoutMs: 30000 });
  let json = null;
  try {
    json = JSON.parse(res.rawText);
  } catch {
    json = null;
  }
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    json,
    rawPreview: redactSensitiveText(res.rawText.slice(0, 800))
  };
}

async function probeOpenRouterCatalogAndKey(apiKey) {
  const keyRes = await fetchJsonProbe({
    url: 'https://openrouter.ai/api/v1/key',
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const modelsRes = await fetchJsonProbe({
    url: 'https://openrouter.ai/api/v1/models',
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  const allModels = Array.isArray(modelsRes.json?.data) ? modelsRes.json.data : [];
  const anthropicModels = allModels
    .filter((m) => String(m.id || '').startsWith('anthropic/'))
    .map((m) => {
      const p = m.pricing || {};
      const toPerM = (v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))
        ? Number((Number(v) * 1e6).toFixed(6))
        : null);
      return {
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length ?? null,
        input_per_1m: toPerM(p.prompt),
        output_per_1m: toPerM(p.completion),
        cache_read_per_1m: toPerM(p.input_cache_read),
        cache_write_per_1m: toPerM(p.input_cache_write),
        supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : null
      };
    });

  return {
    keyStatus: keyRes.statusCode,
    keyUsageUsd: keyRes.json?.data?.usage ?? null,
    keyLimitUsd: keyRes.json?.data?.limit ?? null,
    keyLimitRemainingUsd: keyRes.json?.data?.limit_remaining ?? null,
    modelsStatus: modelsRes.statusCode,
    anthropicModels
  };
}

async function probeAnthropicDirectModels(apiKey) {
  if (!apiKey) return { configured: false, ok: false, error: 'Not configured' };
  const attempts = [];
  for (const mode of ['x-api-key', 'bearer']) {
    const headers = {
      'anthropic-version': '2023-06-01',
      ...(mode === 'x-api-key' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` })
    };
    const res = await fetchJsonProbe({
      url: 'https://api.anthropic.com/v1/models?limit=100',
      headers
    });
    attempts.push({
      authMode: mode,
      statusCode: res.statusCode,
      errorPreview: res.statusCode >= 400 ? res.rawPreview : null
    });
    if (res.statusCode === 200 && Array.isArray(res.json?.data)) {
      return {
        configured: true,
        ok: true,
        authModeUsed: mode,
        attempts,
        models: res.json.data.map((m) => ({
          id: m.id,
          display_name: m.display_name || null,
          created_at: m.created_at || null
        }))
      };
    }
  }
  return {
    configured: true,
    ok: false,
    authModeUsed: null,
    attempts,
    models: []
  };
}

async function probeGeminiEndpoint(apiKey, billingBlocksText) {
  if (!apiKey) return { configured: false, ok: false, error: 'Not configured' };

  // Test standard Generative Language API header + query auth, and Vertex Express URL
  const candidateProbes = [
    {
      label: 'generativelanguage_v1beta_header',
      endpointType: 'generativelanguage',
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
      headers: { 'x-goog-api-key': apiKey }
    },
    {
      label: 'generativelanguage_v1beta_query',
      endpointType: 'generativelanguage',
      url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`,
      headers: {}
    },
    {
      label: 'aiplatform_express_publishers_header',
      endpointType: 'vertex_express',
      url: 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=50',
      headers: { 'x-goog-api-key': apiKey }
    },
    {
      label: 'aiplatform_express_publishers_query',
      endpointType: 'vertex_express',
      url: `https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=50&key=${encodeURIComponent(apiKey)}`,
      headers: {}
    }
  ];

  const probeAttempts = [];
  let working = null;

  for (const c of candidateProbes) {
    const res = await fetchJsonProbe({ url: c.url, headers: c.headers });
    probeAttempts.push({
      label: c.label,
      statusCode: res.statusCode,
      errorPreview: res.statusCode >= 400 ? res.rawPreview : null
    });
    if (res.statusCode === 200 && res.json) {
      working = {
        ...c,
        models: (res.json.models || res.json.publisherModels || []).map((m) => ({
          name: m.name,
          displayName: m.displayName || null,
          supportedGenerationMethods: m.supportedGenerationMethods || []
        }))
      };
      break;
    }
  }

  let cacheProbe = null;
  if (working && working.endpointType === 'generativelanguage') {
    const rankGemini = (name = '') => {
      if (/^models\/gemini-3\.1-pro-preview$/i.test(name)) return 0;
      if (/gemini-3\.1-pro/i.test(name)) return 1;
      if (/gemini-3\.5-flash/i.test(name)) return 2;
      if (/gemini-3-flash/i.test(name)) return 3;
      return 9;
    };
    const relevantModels = working.models
      .filter((m) => /gemini-(3\.1|3|2\.5)-pro/i.test(m.name) && m.supportedGenerationMethods.includes('createCachedContent'))
      .map((m) => m.name)
      .sort((a, b) => rankGemini(a) - rankGemini(b));
    const targetModel = relevantModels[0] || 'models/gemini-3.1-pro-preview';
    const fillerRepeat = `${billingBlocksText}\n`.repeat(3); // ~6k tokens
    const authHeader = working.label.endsWith('_header') ? { 'x-goog-api-key': apiKey } : {};
    const keyQs = working.label.endsWith('_query') ? `?key=${encodeURIComponent(apiKey)}` : '';
    const createUrl = `https://generativelanguage.googleapis.com/v1beta/cachedContents${keyQs}`;
    const tryCreate = async (textPayload) => {
      const createBody = JSON.stringify({
        model: targetModel.startsWith('models/') ? targetModel : `models/${targetModel}`,
        displayName: `phase0_probe_${createRepNonce('gem')}`,
        contents: [{ role: 'user', parts: [{ text: textPayload }] }],
        ttl: '60s'
      });
      return fetchJsonProbe({
        url: createUrl,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(createBody, 'utf8'),
          ...authHeader
        },
        body: createBody
      });
    };
    let created = await tryCreate(fillerRepeat);
    if (created.statusCode === 400 && /minimum|too small|token/i.test(created.rawPreview || '')) {
      created = await tryCreate(`${billingBlocksText}\n`.repeat(18)); // ~35k tokens if 32k min enforced
    }
    let deletedStatus = null;
    if (created.statusCode === 200 && created.json?.name) {
      const delUrl = `https://generativelanguage.googleapis.com/v1beta/${created.json.name}${keyQs}`;
      const delRes = await fetchJsonProbe({ url: delUrl, method: 'DELETE', headers: authHeader });
      deletedStatus = delRes.statusCode;
    }
    cacheProbe = {
      targetModel,
      createStatus: created.statusCode,
      usageMetadata: created.json?.usageMetadata || null,
      expireTime: created.json?.expireTime || null,
      responseKeys: created.json ? Object.keys(created.json) : [],
      errorPreview: created.statusCode >= 400 ? created.rawPreview : null,
      deletedStatus
    };
  }

  return {
    configured: true,
    ok: Boolean(working),
    workingEndpoint: working?.label || null,
    geminiModels: working ? working.models.filter((m) => /gemini-(3|2\.5)/i.test(m.name)).slice(0, 25) : [],
    probeAttempts,
    cacheProbe
  };
}

async function probeAnthropicCapabilities({ route, model, keys, filler1400, probeCostAccumulator }) {
  const results = {};

  // Probe 1: stream 5m write + immediate warm read
  const n1 = createRepNonce(`${route}_p1`);
  const b1 = injectNonceAndBreakpoints({
    nonce: n1,
    system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
    messages: [{ role: 'user', content: 'Reply with one word: READY.' }]
  });
  const p1Write = await sendMessagesCall({
    test: 'PHASE0',
    arm: `${route}_5m_write`,
    rep: 1,
    turn: 1,
    route,
    model,
    system: b1.system,
    messages: b1.messages,
    max_tokens: 16,
    stream: true,
    nonceId: n1
  });
  probeCostAccumulator.push(p1Write.row);

  const b1Read = injectNonceAndBreakpoints({
    nonce: n1,
    system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
    messages: [
      ...b1.messages,
      { role: 'assistant', content: [{ type: 'text', text: p1Write.assistantText || 'READY' }] },
      { role: 'user', content: 'Reply with one word: OK.' }
    ]
  });
  const p1Read = await sendMessagesCall({
    test: 'PHASE0',
    arm: `${route}_5m_read`,
    rep: 1,
    turn: 2,
    route,
    model,
    system: b1Read.system,
    messages: b1Read.messages,
    max_tokens: 16,
    stream: true,
    nonceId: n1
  });
  probeCostAccumulator.push(p1Read.row);
  results.basic5mWriteRead = {
    writeStatus: p1Write.row.http_status,
    write5mTokens: p1Write.row.cache_write_5m_tokens,
    writeTotalTokens: p1Write.row.cache_write_tokens,
    writeCostSource: p1Write.row.cost_source,
    writeBilledUsd: p1Write.row.billed_cost_usd,
    readStatus: p1Read.row.http_status,
    readTokens: p1Read.row.cache_read_tokens,
    readBilledUsd: p1Read.row.billed_cost_usd,
    error: p1Write.row.error_text || p1Read.row.error_text || null
  };

  // Probe 2: max_tokens: 0 (non-streaming) + warm read follow-up
  const n2 = createRepNonce(`${route}_p2_zero`);
  const b2 = injectNonceAndBreakpoints({
    nonce: n2,
    system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
    messages: [{ role: 'user', content: 'Acknowledge once warmed.' }]
  });
  const p2Warm = await sendMessagesCall({
    test: 'PHASE0',
    arm: `${route}_maxtok0`,
    rep: 1,
    turn: 0,
    route,
    model,
    system: b2.system,
    messages: b2.messages,
    max_tokens: 0,
    stream: false,
    nonceId: n2
  });
  probeCostAccumulator.push(p2Warm.row);

  let p2Follow = null;
  if (p2Warm.row.http_status === 200) {
    const b2f = injectNonceAndBreakpoints({
      nonce: n2,
      system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
      messages: [
        { role: 'user', content: 'Acknowledge once warmed.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Warm.' }] },
        { role: 'user', content: 'Reply with one word: WARMED.' }
      ]
    });
    // Actually system prefix alone > 1024 tokens; test system cache hit directly
    const b2SysHit = injectNonceAndBreakpoints({
      nonce: n2,
      system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
      messages: [{ role: 'user', content: 'Now say: CONFIRMED.' }]
    });
    p2Follow = await sendMessagesCall({
      test: 'PHASE0',
      arm: `${route}_maxtok0_follow`,
      rep: 1,
      turn: 1,
      route,
      model,
      system: b2SysHit.system,
      messages: b2SysHit.messages,
      max_tokens: 16,
      stream: true,
      nonceId: n2
    });
    probeCostAccumulator.push(p2Follow.row);
  }
  results.maxTokensZero = {
    warmStatus: p2Warm.row.http_status,
    warmOutputTokens: p2Warm.row.output_tokens,
    warmWriteTokens: p2Warm.row.cache_write_tokens,
    warmError: p2Warm.row.error_text || null,
    followStatus: p2Follow?.row.http_status ?? null,
    followCacheReadTokens: p2Follow?.row.cache_read_tokens ?? null,
    works: p2Warm.row.http_status === 200 && (p2Follow?.row.cache_read_tokens || 0) >= 1000
  };

  // Probe 3: ttl: "1h" write + 5m/1h usage breakdown + billed cost
  const n3 = createRepNonce(`${route}_p3_1h`);
  const b3 = injectNonceAndBreakpoints({
    nonce: n3,
    ttl: '1h',
    system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
    messages: [{ role: 'user', content: 'Reply with one word: TTL1H.' }]
  });
  const p3 = await sendMessagesCall({
    test: 'PHASE0',
    arm: `${route}_ttl1h`,
    rep: 1,
    turn: 1,
    route,
    model,
    system: b3.system,
    messages: b3.messages,
    max_tokens: 16,
    stream: false,
    requestedTtl: '1h',
    nonceId: n3
  });
  probeCostAccumulator.push(p3.row);
  results.ttl1h = {
    status: p3.row.http_status,
    cacheWrite5mTokens: p3.row.cache_write_5m_tokens,
    cacheWrite1hTokens: p3.row.cache_write_1h_tokens,
    cacheWriteTotalTokens: p3.row.cache_write_tokens,
    billedCostUsd: p3.row.billed_cost_usd,
    computed1hCostUsd: p3.row.computed_cost_usd,
    costSource: p3.row.cost_source,
    rawUsage: p3.rawUsage,
    error: p3.row.error_text || null,
    splitReported: p3.row.cache_write_1h_tokens > 0
  };

  // Probe 4: mid-conversation-output-config-2026-07-01 beta header + role: "system" in messages
  const n4 = createRepNonce(`${route}_p4_effort`);
  const b4Base = injectNonceAndBreakpoints({
    nonce: n4,
    system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
    messages: [{ role: 'user', content: 'Reply with one word: BASE.' }]
  });
  const p4t1 = await sendMessagesCall({
    test: 'PHASE0',
    arm: `${route}_mideffort_t1`,
    rep: 1,
    turn: 1,
    route,
    model,
    system: b4Base.system,
    messages: b4Base.messages,
    max_tokens: 16,
    stream: false,
    output_config: { effort: 'low' },
    anthropicBeta: 'mid-conversation-output-config-2026-07-01',
    nonceId: n4
  });
  probeCostAccumulator.push(p4t1.row);

  let p4t2 = null;
  if (p4t1.row.http_status === 200) {
    const msgsWithMidConfig = [
      ...b4Base.messages,
      { role: 'assistant', content: [{ type: 'text', text: p4t1.assistantText || 'BASE' }] },
      { role: 'system', content: [], output_config: { effort: 'high' } },
      { role: 'user', content: 'Reply with one word: HIGH.' }
    ];
    const b4t2 = injectNonceAndBreakpoints({
      nonce: n4,
      system: [{ type: 'text', text: `Follow instructions strictly.\n\n${filler1400}` }],
      messages: msgsWithMidConfig
    });
    p4t2 = await sendMessagesCall({
      test: 'PHASE0',
      arm: `${route}_mideffort_t2`,
      rep: 1,
      turn: 2,
      route,
      model,
      system: b4t2.system,
      messages: b4t2.messages,
      max_tokens: 16,
      stream: false,
      output_config: { effort: 'low' },
      anthropicBeta: 'mid-conversation-output-config-2026-07-01',
      nonceId: n4
    });
    probeCostAccumulator.push(p4t2.row);
  }
  results.midConversationOutputConfig = {
    t1Status: p4t1.row.http_status,
    t1Error: p4t1.row.error_text || null,
    t2Status: p4t2?.row.http_status ?? null,
    t2CacheReadTokens: p4t2?.row.cache_read_tokens ?? null,
    t2CacheWriteTokens: p4t2?.row.cache_write_tokens ?? null,
    t2Error: p4t2?.row.error_text || null,
    worksAndPreservesPrefix: Boolean(p4t2 && p4t2.row.http_status === 200 && p4t2.row.cache_read_tokens >= 1000)
  };

  assertNoSensitiveLeaks(JSON.stringify(results), `probe_${route}`, getExtraSecretsList(keys));
  return results;
}

async function probeClaudeCodeBetaHeaderLocalMock() {
  if (!fs.existsSync(CLAUDE_EXE) || !fs.existsSync(FROZEN_REPO_DIR)) {
    return { skipped: true, reason: 'claude.exe or frozen-repo missing' };
  }
  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(bodyStr); } catch {}
      captured.push({
        url: req.url,
        anthropicBeta: req.headers['anthropic-beta'] || null,
        anthropicVersion: req.headers['anthropic-version'] || null,
        model: body?.model || null,
        outputConfig: body?.output_config || null
      });
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock_cc","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n');
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n');
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-phase0-header-'));
  const homeDir = path.join(isoRoot, 'home');
  const cfgDir = path.join(isoRoot, 'cfg');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  const runOnce = (extraEnv) => new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.OPENROUTER_API_KEY;
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    env.ANTHROPIC_API_KEY = ['sk', 'ant', 'api03', 'local', 'mock', '000000000000'].join('-');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
    env.CLAUDE_CONFIG_DIR = cfgDir;
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    Object.assign(env, extraEnv);

    const child = spawn(CLAUDE_EXE, [
      '-p', 'Reply strictly with OK.',
      '--model', 'claude-sonnet-4-6',
      '--effort', 'medium',
      '--tools', '',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      '--output-format', 'json'
    ], {
      cwd: FROZEN_REPO_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 25000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });

  try {
    captured.length = 0;
    const baseRes = await runOnce({});
    const baseReqs = captured.filter((c) => !c.url.includes('count_tokens'));

    captured.length = 0;
    const customHdrRes = await runOnce({
      ANTHROPIC_CUSTOM_HEADERS: 'anthropic-beta: mid-conversation-output-config-2026-07-01'
    });
    const customHdrReqs = captured.filter((c) => !c.url.includes('count_tokens'));

    captured.length = 0;
    const envBetaRes = await runOnce({
      ANTHROPIC_BETA: 'mid-conversation-output-config-2026-07-01'
    });
    const envBetaReqs = captured.filter((c) => !c.url.includes('count_tokens'));

    return {
      skipped: false,
      claudeVersion: '2.1.325',
      baselineExit: baseRes.code,
      baselineBetaHeader: baseReqs[0]?.anthropicBeta || null,
      withAnthropicCustomHeaders: {
        exit: customHdrRes.code,
        betaHeaderSent: customHdrReqs[0]?.anthropicBeta || null,
        forwardedMidEffortBeta: String(customHdrReqs[0]?.anthropicBeta || '').includes('mid-conversation-output-config-2026-07-01')
      },
      withAnthropicBetaEnv: {
        exit: envBetaRes.code,
        betaHeaderSent: envBetaReqs[0]?.anthropicBeta || null,
        forwardedMidEffortBeta: String(envBetaReqs[0]?.anthropicBeta || '').includes('mid-conversation-output-config-2026-07-01')
      }
    };
  } finally {
    server.close();
    fs.rmSync(isoRoot, { recursive: true, force: true });
  }
}

function buildCostEstimate({ openRouterCatalog, directModels, orProbes, directProbes, geminiProbe }) {
  const findOr = (id) => openRouterCatalog.anthropicModels.find((m) => m.id === id) || null;
  const s46 = findOr('anthropic/claude-sonnet-4.6') || { input_per_1m: 3.0, output_per_1m: 15.0, cache_read_per_1m: 0.3, cache_write_per_1m: 3.75 };
  const o46 = findOr('anthropic/claude-opus-4.6') || { input_per_1m: 5.0, output_per_1m: 25.0, cache_read_per_1m: 0.5, cache_write_per_1m: 6.25 };
  const s55 = findOr('anthropic/claude-sonnet-5.5');
  const o55 = findOr('anthropic/claude-opus-5.5');

  const sonnetRate = {
    in: s46.input_per_1m ?? 3.0,
    out: s46.output_per_1m ?? 15.0,
    w5: s46.cache_write_per_1m ?? 3.75,
    w1h: Number(((s46.input_per_1m ?? 3.0) * 2).toFixed(6)),
    r: s46.cache_read_per_1m ?? 0.3
  };
  const opusRate = {
    in: o46.input_per_1m ?? 5.0,
    out: o46.output_per_1m ?? 25.0,
    w5: o46.cache_write_per_1m ?? 6.25,
    w1h: Number(((o46.input_per_1m ?? 5.0) * 2).toFixed(6)),
    r: o46.cache_read_per_1m ?? 0.5
  };

  // Helper to compute message turn cost on Sonnet/Opus 4.6
  const tokCost = (rate, w5, w1h, rd, unc, out) =>
    ((w5 / 1e6) * rate.w5) + ((w1h / 1e6) * rate.w1h) + ((rd / 1e6) * rate.r) + ((unc / 1e6) * rate.in) + ((out / 1e6) * rate.out);

  const items = [];

  // T4 (P0, P1, P2, P3 at N=10 x3; P0, P1 at N=25 x1), 20k prefix, 50 out tok
  // True max_tokens=0 requires Direct Anthropic if OpenRouter ignores/generates output on max_tokens:0
  const orTrueMaxZero = Boolean(orProbes?.maxTokensZero?.works && (orProbes?.maxTokensZero?.warmOutputTokens ?? 99) === 0);
  const t4RouteP1 = orTrueMaxZero ? 'openrouter' : (directProbes?.maxTokensZero?.works ? 'anthropic_direct' : 'openrouter');
  const t4ModelP1 = t4RouteP1 === 'anthropic_direct' ? 'claude-sonnet-4-6' : 'anthropic/claude-sonnet-4.6';
  const t4PoolP1 = t4RouteP1 === 'anthropic_direct' ? 'anthropic' : 'openrouter';
  const w20k = tokCost(sonnetRate, 20000, 0, 0, 50, 50);
  const r20k = tokCost(sonnetRate, 0, 0, 20000, 50, 50);
  items.push({ test: 'T4', arm: 'P0 (N=10 barrier)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: 10 * w20k });
  items.push({ test: 'T4', arm: 'P1 (N=10 max_tokens=0 primer)', route: t4RouteP1, pool: t4PoolP1, model: t4ModelP1, reps: 3, perRep: tokCost(sonnetRate, 20000, 0, 0, 0, 0) + 10 * r20k });
  items.push({ test: 'T4', arm: 'P2 (N=10 max_tokens=1 primer)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: w20k + 10 * r20k });
  items.push({ test: 'T4', arm: 'P3 (N=10 sequential)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: w20k + 9 * r20k });
  items.push({ test: 'T4', arm: 'P0 (N=25 barrier)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 1, perRep: 25 * w20k });
  items.push({ test: 'T4', arm: 'P1 (N=25 max_tokens=0 primer)', route: t4RouteP1, pool: t4PoolP1, model: t4ModelP1, reps: 1, perRep: tokCost(sonnetRate, 20000, 0, 0, 0, 0) + 25 * r20k });

  // T6 API (10 arms x 3 reps, ~15k tok avg across 12 turns, 100 out tok)
  const apiWarm12 = tokCost(sonnetRate, 11000, 0, 0, 100, 100) + 11 * tokCost(sonnetRate, 700, 0, 13500, 0, 100);
  const t6ApiArms = [
    ['C (control)', apiWarm12],
    ['TS (drop 5 tools @T6, tools+sys+hist reset)', apiWarm12 + tokCost(sonnetRate, 14000, 0, 0, 0, 0)],
    ['TF (dynamic filter T2-T12)', 12 * tokCost(sonnetRate, 13000, 0, 0, 100, 100)],
    ['TK (shuffle tool JSON keys @T6)', apiWarm12 + tokCost(sonnetRate, 14000, 0, 0, 0, 0)],
    ['TA (add 1 tool at end @T6)', apiWarm12 + tokCost(sonnetRate, 14000, 0, 0, 0, 0)],
    ['SY (edit system @T6, tools preserved)', apiWarm12 + tokCost(sonnetRate, 8000, 0, 6000, 0, 0)],
    ['SRAG (system RAG every turn T2-T12)', tokCost(sonnetRate, 11000, 0, 0, 0, 100) + 11 * tokCost(sonnetRate, 7500, 0, 6000, 0, 100)],
    ['MRAG (tail user RAG T2-T12)', apiWarm12 + 11 * tokCost(sonnetRate, 600, 0, 0, 0, 0)],
    ['TSTUB (static stub + deferred schema @T6 tail)', apiWarm12 * 0.72],
    ['ME (edit T2 msg @T6, tools+sys preserved)', apiWarm12 + tokCost(sonnetRate, 5000, 0, 9000, 0, 0)]
  ];
  for (const [armName, perRep] of t6ApiArms) {
    items.push({ test: 'T6', arm: `API:${armName}`, route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep });
  }
  for (const ccArm of ['CC-T (mcp-config/allowedTools @T6)', 'CC-M (CLAUDE.md @T6)', 'CC-S (append-system-prompt @T6)']) {
    items.push({ test: 'T6', arm: ccArm, route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: 0.165 });
  }

  // T7 Option 7B (1 write + 19 cached reads per (S, seed), 400 out tok)
  const out400Cost = (400 / 1e6) * sonnetRate.out;
  const sSizes = [
    ['S=10 (~600 rule tok + ~400 task)', 1000],
    ['S=50 (~1,750 rule tok + ~400 task)', 2150],
    ['S=100 (~3,100 rule tok + ~400 task)', 3500],
    ['S=250 (~7,200 rule tok + ~400 task)', 7600],
    ['S=500 (~14,000 rule tok + ~400 task)', 14400]
  ];
  for (const [label, tok] of sSizes) {
    const seedCost = tokCost(sonnetRate, tok, 0, 0, 400, 400) + 19 * (tokCost(sonnetRate, 0, 0, tok, 400, 400) + 0);
    items.push({ test: 'T7', arm: label, route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: seedCost });
  }
  // T7 optional CLAUDE.md check (S=10, 100, 500 x 20 tasks, n=1)
  items.push({ test: 'T7 (Optional CC)', arm: 'CLAUDE.md S={10,100,500} x20 tasks', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 1, perRep: 2.25 });

  // T5 (30 turns, W=24k, ~1k added/turn, max_tokens 150)
  const t5A = 30 * tokCost(sonnetRate, 1150, 0, 15000, 0, 150);
  const t5B = 19 * tokCost(sonnetRate, 1150, 0, 11000, 0, 150) + 11 * tokCost(sonnetRate, 24000, 0, 0, 0, 150);
  const t5C = 28 * tokCost(sonnetRate, 1150, 0, 13000, 0, 150) + 2 * tokCost(sonnetRate, 13000, 0, 0, 0, 150);
  const t5D = t5C + 2 * tokCost(sonnetRate, 0, 0, 12000, 1000, 500);
  const t5E = t5C + 2 * tokCost(sonnetRate, 1000, 0, 12000, 0, 50);
  items.push({ test: 'T5', arm: 'A (append-only reference)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: t5A });
  items.push({ test: 'T5', arm: 'B (sliding window 1 turn)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: t5B });
  items.push({ test: 'T5', arm: 'C (50% cliff)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: t5C });
  items.push({ test: 'T5', arm: 'D (prose summary <=500 tok)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: t5D });
  items.push({ test: 'T5', arm: 'E (cliff + structured STATE)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 3, perRep: t5E });

  // T3a, T3b, T3c
  const t3Route = orProbes?.ttl1h?.splitReported ? 'openrouter' : (directProbes?.ttl1h?.splitReported ? 'anthropic_direct' : 'openrouter');
  const t3Pool = t3Route === 'anthropic_direct' ? 'anthropic' : 'openrouter';
  const t3Write5m = tokCost(sonnetRate, 20000, 0, 0, 50, 50);
  const t3Read5m = tokCost(sonnetRate, 0, 0, 20000, 50, 50);
  const t3Write1h = tokCost(sonnetRate, 0, 20000, 0, 50, 50);
  items.push({ test: 'T3a', arm: 'TTL5 (gaps 4m x3; 6,12,30m x3 miss; 62m x1 miss)', route: t3Route, pool: t3Pool, model: 'sonnet-4.6', reps: 1, perRep: (13 * t3Write5m) + (3 * t3Read5m) + (10 * t3Write5m) });
  items.push({ test: 'T3a', arm: 'TTL1H (gaps 4,6,12,30m x3 hit; 62m x1 miss)', route: t3Route, pool: t3Pool, model: 'sonnet-4.6', reps: 1, perRep: (13 * t3Write1h) + (12 * t3Read5m) + (1 * t3Write1h) });
  const t3bRoute = orTrueMaxZero ? 'openrouter' : (directProbes?.maxTokensZero?.works ? 'anthropic_direct' : 'blocked');
  const t3bZeroModel = t3bRoute === 'anthropic_direct' ? 'claude-sonnet-4-6' : 'anthropic/claude-sonnet-4.6';
  items.push({ test: 'T3b', arm: 'KA-read (6 pings @ 4.5m)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-sonnet-4.6', reps: 2, perRep: t3Write5m + 5 * r20k });
  items.push({ test: 'T3b', arm: 'KA-zero (6 max_tokens=0 pings @ 4.5m)', route: t3bRoute, pool: t3bRoute === 'anthropic_direct' ? 'anthropic' : 'openrouter', model: t3bZeroModel, reps: 2, perRep: tokCost(sonnetRate, 20000, 0, 0, 0, 0) + 5 * tokCost(sonnetRate, 0, 0, 20000, 0, 0) });
  items.push({ test: 'T3c', arm: 'Gemini explicit 32k 1h cache (0 vs 3 queries)', route: geminiProbe?.cacheProbe?.createStatus === 200 ? 'gemini' : 'blocked', pool: 'gemini', model: geminiProbe?.cacheProbe?.targetModel || 'models/gemini-3.1-pro-preview', reps: 1, perRep: geminiProbe?.cacheProbe?.createStatus === 200 ? 0.35 : 0 });

  // R1 (Opus 4.6 main / Sonnet 4.6 lookup)
  const opusSmall12 = tokCost(opusRate, 7000, 0, 0, 100, 120) + 11 * tokCost(opusRate, 400, 0, 9000, 0, 120);
  items.push({ test: 'R1', arm: 'M (Opus 4.6 all turns)', route: 'openrouter', pool: 'openrouter', model: 'anthropic/claude-opus-4.6', reps: 3, perRep: opusSmall12 });
  items.push({ test: 'R1', arm: 'SW (Opus <-> Sonnet T7/T9/T11 ping-pong)', route: 'openrouter', pool: 'openrouter', model: 'opus-4.6 / sonnet-4.6', reps: 3, perRep: opusSmall12 + 0.14 });
  items.push({ test: 'R1', arm: 'SC (Opus main + 3 isolated <1k Sonnet side calls)', route: 'openrouter', pool: 'openrouter', model: 'opus-4.6 + isolated sonnet', reps: 3, perRep: opusSmall12 + 0.015 });

  // R2 (Direct API Only) & Optional 5.5 currency check
  const directHas55 = (directModels?.models || []).some((m) => /5[-.]5|sonnet-5|opus-5/i.test(m.id));
  const r2SupportedNote = directHas55 ? 'claude-sonnet-5-5' : (directProbes?.midConversationOutputConfig?.worksAndPreservesPrefix ? 'supported-direct-model' : 'check-phase0-output');
  const directOk = Boolean(directModels?.ok);
  items.push({ test: 'R2', arm: `EF0..EF3 + 4.6 EF0/EF1 (${r2SupportedNote})`, route: directOk ? 'anthropic_direct' : 'blocked', pool: 'anthropic', model: r2SupportedNote, reps: 3, perRep: directOk ? 0.42 : 0 });

  const orHas55 = Boolean(s55 && o55);
  const o55Rate = o55
    ? { in: o55.input_per_1m, out: o55.output_per_1m, w5: o55.cache_write_per_1m, w1h: o55.input_per_1m * 2, r: o55.cache_read_per_1m }
    : opusRate;
  const s55Rate = s55
    ? { in: s55.input_per_1m, out: s55.output_per_1m, w5: s55.cache_write_per_1m, w1h: s55.input_per_1m * 2, r: s55.cache_read_per_1m }
    : sonnetRate;
  // 3 arms (Control + One-Switch + Effort-Only) across 15k prefix:
  const c55 = tokCost(o55Rate, 15000, 0, 0, 100, 150) + 11 * tokCost(o55Rate, 350, 0, 15000, 0, 150);
  const sw55 = tokCost(o55Rate, 15000, 0, 0, 100, 150) + 4 * tokCost(o55Rate, 350, 0, 15000, 0, 150) + tokCost(s55Rate, 16000, 0, 0, 100, 150) + 6 * tokCost(s55Rate, 350, 0, 16000, 0, 150);
  const ef55 = c55 + tokCost(o55Rate, 15500, 0, 0, 0, 150);
  const currencyPerRepTriplet = c55 + sw55 + ef55;
  items.push({ test: 'Optional 5.5 Currency', arm: 'Control / One-Switch / Effort-Only (5.5 pair)', route: orHas55 ? 'openrouter' : (directHas55 ? 'anthropic_direct' : 'blocked'), pool: orHas55 ? 'openrouter' : 'anthropic', model: orHas55 ? 'anthropic/claude-opus-5.5 + sonnet-5.5' : '5.5-not-in-catalog', reps: 3, perRep: (orHas55 || directHas55) ? currencyPerRepTriplet : 0 });

  const totalsByPool = { openrouter: 0, anthropic: 0, gemini: 0 };
  for (const it of items) {
    it.expectedTotal = Number((it.perRep * it.reps).toFixed(4));
    it.abortCapPerRep = Number((it.perRep * 3).toFixed(4));
    if (it.route !== 'blocked' && totalsByPool[it.pool] !== undefined) {
      totalsByPool[it.pool] += it.expectedTotal;
    }
  }
  return { items, totalsByPool, sonnetRate, opusRate, orHas55, directHas55 };
}

async function main() {
  const keys = loadBenchmarkKeys();
  const extraSecrets = getExtraSecretsList(keys);
  const probeRows = [];
  const refreshGemini = process.argv.includes('--refresh-gemini') && fs.existsSync(RATE_CARD_OUT);

  const billingSliceFull = loadPinnedCorpusSlice('src/core-isomorphic/economics/billingBlocks.mjs', 1, 200);
  const billing1400Tok = `${billingSliceFull}\n${loadPinnedCorpusSlice('src/core-isomorphic/economics/dualTtl.mjs', 1, 60)}`;

  let openRouterCatalog;
  let directModels;
  let geminiProbe;
  let orProbes;
  let directProbes;
  let claudeCodeBetaProbe;

  if (refreshGemini) {
    console.log('[Phase 0 Refresh] Reusing saved Anthropic/OpenRouter probes and updating Gemini 3.1 + OpenRouter max_tokens=0 check...');
    const prev = JSON.parse(fs.readFileSync(RATE_CARD_OUT, 'utf8'));
    openRouterCatalog = {
      ...(await probeOpenRouterCatalogAndKey(keys.OPENROUTER_API_KEY)),
      anthropicModels: prev.openRouterAnthropicModels
    };
    directModels = prev.directAnthropicModels;
    orProbes = prev.openRouterCapabilityProbes;
    directProbes = prev.directAnthropicCapabilityProbes;
    claudeCodeBetaProbe = prev.claudeCodeBetaProbe;
    geminiProbe = await probeGeminiEndpoint(keys.GEMINI_BENCHMARK_API_KEY, billingSliceFull);

    // Check definitively whether OpenRouter ignores max_tokens: 0 when given a 30-word counting prompt
    const nCheck = createRepNonce('or_maxtok0_check');
    const bCheck = injectNonceAndBreakpoints({
      nonce: nCheck,
      system: [{ type: 'text', text: `Follow instructions strictly.\n\n${billing1400Tok}` }],
      messages: [{ role: 'user', content: 'Count from 1 to 35 in English words separated by commas.' }]
    });
    const orMaxCheck = await sendMessagesCall({
      test: 'PHASE0',
      arm: 'or_maxtok0_strict_check',
      rep: 1,
      turn: 0,
      route: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      system: bCheck.system,
      messages: bCheck.messages,
      max_tokens: 0,
      stream: false,
      nonceId: nCheck
    });
    probeRows.push(orMaxCheck.row);
    orProbes.maxTokensZero.strictCountPromptOutputTokens = orMaxCheck.row.output_tokens;
    orProbes.maxTokensZero.strictCountPromptStopReason = orMaxCheck.stopReason;
    orProbes.maxTokensZero.strictCountPromptBilledUsd = orMaxCheck.row.billed_cost_usd;
    orProbes.maxTokensZero.trueZeroOutput = orMaxCheck.row.output_tokens === 0;
  } else {
    console.log('[Phase 0] Fetching model listings & balances ($0)...');
    openRouterCatalog = keys.OPENROUTER_API_KEY
      ? await probeOpenRouterCatalogAndKey(keys.OPENROUTER_API_KEY)
      : { keyStatus: null, modelsStatus: null, anthropicModels: [] };

    directModels = await probeAnthropicDirectModels(keys.ANTHROPIC_API_KEY);

    console.log('[Phase 0] Probing Gemini explicit cache endpoint...');
    geminiProbe = await probeGeminiEndpoint(keys.GEMINI_BENCHMARK_API_KEY, billingSliceFull);

    console.log('[Phase 0] Probing OpenRouter Messages API capabilities (~$0.03)...');
    orProbes = keys.OPENROUTER_API_KEY
      ? await probeAnthropicCapabilities({
          route: 'openrouter',
          model: 'anthropic/claude-sonnet-4.6',
          keys,
          filler1400: billing1400Tok,
          probeCostAccumulator: probeRows
        })
      : null;

    directProbes = null;
    if (directModels.ok) {
      const newestDirectSonnet = directModels.models.find((m) => /sonnet-5/i.test(m.id))?.id
        || directModels.models.find((m) => /sonnet-4-6/i.test(m.id))?.id
        || 'claude-sonnet-4-6';
      console.log(`[Phase 0] Probing Direct Anthropic API capabilities on ${newestDirectSonnet}...`);
      directProbes = await probeAnthropicCapabilities({
        route: 'anthropic_direct',
        model: newestDirectSonnet,
        keys,
        filler1400: billing1400Tok,
        probeCostAccumulator: probeRows
      });
    } else {
      console.log('[Phase 0] Direct Anthropic API key rejected/unavailable; skipping direct probes.');
    }

    console.log('[Phase 0] Running $0 local mock probe of claude.exe 2.1.325 beta headers...');
    claudeCodeBetaProbe = await probeClaudeCodeBetaHeaderLocalMock();
  }

  const estimate = buildCostEstimate({
    openRouterCatalog,
    directModels,
    orProbes,
    directProbes,
    geminiProbe
  });

  const rateCard = {
    generatedAtUtc: new Date().toISOString(),
    openRouterKeyStatus: {
      status: openRouterCatalog.keyStatus,
      usageUsd: openRouterCatalog.keyUsageUsd,
      limitUsd: openRouterCatalog.keyLimitUsd,
      limitRemainingUsd: openRouterCatalog.keyLimitRemainingUsd
    },
    openRouterAnthropicModels: openRouterCatalog.anthropicModels,
    directAnthropicModels: directModels,
    geminiProbe,
    openRouterCapabilityProbes: orProbes,
    directAnthropicCapabilityProbes: directProbes,
    claudeCodeBetaProbe,
    models: Object.fromEntries(
      openRouterCatalog.anthropicModels.map((m) => [
        m.id,
        {
          input: m.input_per_1m,
          output: m.output_per_1m,
          write5m: m.cache_write_per_1m ?? Number(((m.input_per_1m || 3) * 1.25).toFixed(6)),
          write1h: Number(((m.input_per_1m || 3) * 2).toFixed(6)),
          read: m.cache_read_per_1m
        }
      ])
    )
  };

  const rateCardStr = JSON.stringify(rateCard, null, 2);
  assertNoSensitiveLeaks(rateCardStr, 'phase0_rate_card.json', extraSecrets);
  fs.mkdirSync(path.dirname(RATE_CARD_OUT), { recursive: true });
  fs.writeFileSync(RATE_CARD_OUT, rateCardStr, 'utf8');

  const bt = (s) => '`' + String(s) + '`';
  const lines = [];
  lines.push('# Phase 0 Capability Gate & Live Cost Estimate (' + bt('2026-11-15 UTC') + ')');
  lines.push('');
  lines.push('## 1. Live Provider Catalogs & Balances (' + bt('$0') + ' / ' + bt('<$0.05') + ' Probe Spend)');
  lines.push('');
  lines.push(
    '- **OpenRouter Account (' + bt('/api/v1/key') + ')**: HTTP ' + bt(openRouterCatalog.keyStatus) +
    ' | Usage ' + bt('$' + (openRouterCatalog.keyUsageUsd ?? 'N/A')) +
    ' | Limit ' + bt('$' + (openRouterCatalog.keyLimitUsd ?? 'N/A')) +
    ' | Remaining ' + bt('$' + (openRouterCatalog.keyLimitRemainingUsd ?? 'N/A'))
  );
  lines.push(
    '- **Direct Anthropic API (' + bt('/v1/models') + ')**: Configured=' + bt(directModels.configured) +
    ' | Authenticated=' + bt(directModels.ok) +
    ' | Method=' + bt(directModels.authModeUsed || 'none') +
    ' | Attempts=' + bt(JSON.stringify(directModels.attempts))
  );
  lines.push(
    '- **Gemini Key Probe**: Configured=' + bt(geminiProbe.configured) +
    ' | Authenticated=' + bt(geminiProbe.ok) +
    ' | WorkingEndpoint=' + bt(geminiProbe.workingEndpoint || 'none') +
    ' | Attempts=' + bt(JSON.stringify(geminiProbe.probeAttempts))
  );
  if (geminiProbe.cacheProbe) {
    lines.push(
      '  - Gemini minimal explicit cache probe (' + bt(geminiProbe.cacheProbe.targetModel) +
      '): HTTP ' + bt(geminiProbe.cacheProbe.createStatus) +
      ', ' + bt('usageMetadata=' + JSON.stringify(geminiProbe.cacheProbe.usageMetadata)) +
      ', ' + bt('responseKeys=' + JSON.stringify(geminiProbe.cacheProbe.responseKeys)) +
      ', deleted=' + bt(geminiProbe.cacheProbe.deletedStatus) +
      ', error=' + bt(geminiProbe.cacheProbe.errorPreview || 'none')
    );
  }
  lines.push('');
  lines.push('### OpenRouter ' + bt('anthropic/*') + ' Models Returned (' + bt('GET /api/v1/models') + ')');
  lines.push('| Model ID | Input / 1M | Output / 1M | Cache Write 5m / 1M | Cache Read / 1M |');
  lines.push('| :--- | :---: | :---: | :---: | :---: |');
  for (const m of openRouterCatalog.anthropicModels.filter((x) => /sonnet|opus|haiku|4\.6|5|mythos|fable/i.test(x.id))) {
    lines.push(
      '| ' + bt(m.id) +
      ' | ' + bt('$' + (m.input_per_1m ?? 'N/A')) +
      ' | ' + bt('$' + (m.output_per_1m ?? 'N/A')) +
      ' | ' + bt('$' + (m.cache_write_per_1m ?? 'N/A')) +
      ' | ' + bt('$' + (m.cache_read_per_1m ?? 'N/A')) + ' |'
    );
  }
  lines.push('');
  if (directModels.ok) {
    lines.push('### Direct Anthropic Models Returned (' + bt('GET /v1/models') + ')');
    lines.push(directModels.models.map((m) => '- ' + bt(m.id) + ' (' + (m.display_name || '') + ')').join('\n'));
    lines.push('');
  }

  lines.push('## 2. Phase 0 Capability Matrix');
  lines.push('| Feature | OpenRouter Status | Direct Anthropic Status | Classification / Impact |');
  lines.push('| :--- | :--- | :--- | :--- |');
  lines.push(
    '| **Basic 5m Write/Read + Billed Cost** | HTTP ' +
    bt(orProbes?.basic5mWriteRead?.writeStatus) + '/' + bt(orProbes?.basic5mWriteRead?.readStatus) + ', ' +
    bt('cost_source=' + orProbes?.basic5mWriteRead?.writeCostSource) + ', readTok=' + bt(orProbes?.basic5mWriteRead?.readTokens) +
    ' | ' + (directProbes
      ? ('HTTP ' + bt(directProbes.basic5mWriteRead.writeStatus) + '/' + bt(directProbes.basic5mWriteRead.readStatus) + ', readTok=' + bt(directProbes.basic5mWriteRead.readTokens))
      : 'N/A (auth failed)') +
    ' | ' + bt('PASS') + ' |'
  );
  const orStrictOut = orProbes?.maxTokensZero?.strictCountPromptOutputTokens;
  const orMaxZeroTrue = Boolean(orProbes?.maxTokensZero?.works && (orProbes?.maxTokensZero?.warmOutputTokens ?? 99) === 0);
  lines.push(
    '| **' + bt('max_tokens: 0') + ' Pre-Warming** | HTTP ' +
    bt(orProbes?.maxTokensZero?.warmStatus) + ', warmCache=' + bt(orProbes?.maxTokensZero?.works) +
    ', outTok=' + bt(orProbes?.maxTokensZero?.warmOutputTokens + (orStrictOut !== undefined ? (' / countProbeOut=' + orStrictOut + ' (' + orProbes?.maxTokensZero?.strictCountPromptStopReason + ')') : '')) +
    ', err=' + bt(orProbes?.maxTokensZero?.warmError || 'none') +
    ' | ' + (directProbes
      ? ('HTTP ' + bt(directProbes.maxTokensZero.warmStatus) + ', outTok=' + bt(directProbes.maxTokensZero.warmOutputTokens) + ', works=' + bt(directProbes.maxTokensZero.works) + ', followRead=' + bt(directProbes.maxTokensZero.followCacheReadTokens))
      : 'N/A') +
    ' | ' + (orMaxZeroTrue ? bt('PASS (OpenRouter + Direct)') : (directProbes?.maxTokensZero?.works ? (bt('DIRECT-API-ONLY') + ' (OpenRouter does not enforce 0 output; ' + bt('T4-P1') + ', ' + bt('T3b KA-zero') + ' on Direct API)') : bt('BLOCKED'))) + ' |'
  );
  lines.push(
    '| **' + bt('ttl: "1h"') + ' + 5m/1h Split + 2x Rate** | HTTP ' +
    bt(orProbes?.ttl1h?.status) + ', 1hSplit=' + bt(orProbes?.ttl1h?.splitReported) +
    ' (' + bt('5m=' + orProbes?.ttl1h?.cacheWrite5mTokens) + ', ' + bt('1h=' + orProbes?.ttl1h?.cacheWrite1hTokens) + '), billed=' + bt('$' + orProbes?.ttl1h?.billedCostUsd) + ' vs comp1h=' + bt('$' + orProbes?.ttl1h?.computed1hCostUsd) +
    ' | ' + (directProbes
      ? ('HTTP ' + bt(directProbes.ttl1h.status) + ', 1hSplit=' + bt(directProbes.ttl1h.splitReported) + ' (' + bt('1h=' + directProbes.ttl1h.cacheWrite1hTokens) + ')')
      : 'N/A') +
    ' | ' + (orProbes?.ttl1h?.splitReported ? bt('PASS') : (directProbes?.ttl1h?.splitReported ? (bt('DIRECT-API-ONLY') + ' (' + bt('T3a') + ')') : bt('CHECK RESULT'))) + ' |'
  );
  lines.push(
    '| **' + bt('mid-conversation-output-config-2026-07-01') + '** | T1=' +
    bt(orProbes?.midConversationOutputConfig?.t1Status) + ', T2=' + bt(orProbes?.midConversationOutputConfig?.t2Status) +
    ', cacheRead=' + bt(orProbes?.midConversationOutputConfig?.t2CacheReadTokens) + ', err=' + bt(orProbes?.midConversationOutputConfig?.t2Error || orProbes?.midConversationOutputConfig?.t1Error || 'none') +
    ' | ' + (directProbes
      ? ('T1=' + bt(directProbes.midConversationOutputConfig.t1Status) + ', T2=' + bt(directProbes.midConversationOutputConfig.t2Status) + ', works=' + bt(directProbes.midConversationOutputConfig.worksAndPreservesPrefix) + ', err=' + bt(directProbes.midConversationOutputConfig.t2Error || directProbes.midConversationOutputConfig.t1Error || 'none'))
      : 'N/A') +
    ' | ' + bt('R2') + ' direct-API-only |'
  );
  lines.push(
    '| **Claude Code ' + bt('2.1.325') + ' Custom Beta Header** | Baseline=' +
    bt(claudeCodeBetaProbe.baselineBetaHeader) +
    ' | CustomEnvForwarded=' + bt(claudeCodeBetaProbe.withAnthropicCustomHeaders?.forwardedMidEffortBeta) +
    ' | Local ' + bt('$0') + ' CLI inspection |'
  );
  lines.push('');

  lines.push('## 3. Recomputation of Cost Gate Table (Awaiting User Approval)');
  lines.push('');
  lines.push('*Source & Date: Live OpenRouter ' + bt('/api/v1/models') + ' + Anthropic ' + bt('/v1/models') + ' on ' + bt('2026-11-15 UTC') + '.*');
  lines.push('');
  lines.push('| Test | Arm | Route | Pool | Model | Reps (' + bt('n') + ') | Expected / Rep | Expected Total | ' + bt('3x') + ' Abort Cap / Rep |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |');
  for (const it of estimate.items) {
    lines.push(
      '| ' + bt(it.test) +
      ' | ' + it.arm +
      ' | ' + bt(it.route) +
      ' | ' + bt(it.pool) +
      ' | ' + bt(it.model) +
      ' | ' + bt(it.reps) +
      ' | ' + bt('$' + it.perRep.toFixed(4)) +
      ' | ' + bt('$' + it.expectedTotal.toFixed(4)) +
      ' | ' + bt('$' + it.abortCapPerRep.toFixed(4)) + ' |'
    );
  }
  lines.push('');
  lines.push('- **OpenRouter Pool Expected Total**: ' + bt('$' + estimate.totalsByPool.openrouter.toFixed(2)) + ' (Remaining credit reported by OpenRouter: ' + bt('$' + (openRouterCatalog.keyLimitRemainingUsd ?? 'N/A')) + ')');
  lines.push('- **Direct Anthropic Pool Expected Total**: ' + bt('$' + estimate.totalsByPool.anthropic.toFixed(2)) + ' (User stated cap: ' + bt('$20.00') + ')');
  lines.push('- **Gemini Pool Expected Total**: ' + bt('$' + estimate.totalsByPool.gemini.toFixed(2)) + ' (User stated cap: ' + bt('$25.00') + ')');
  lines.push('- **Phase 0 Actual Probe Spend Recorded**: ' + bt('$' + probeRows.reduce((s, r) => s + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0).toFixed(5)));

  const mdContent = lines.join('\n') + '\n';
  assertNoSensitiveLeaks(mdContent, 'phase0_capabilities_and_cost_gate.md', extraSecrets);
  fs.writeFileSync(REPORT_OUT, mdContent, 'utf8');

  console.log('PHASE0_COMPLETE:', JSON.stringify({
    openRouterKeyRemaining: openRouterCatalog.keyLimitRemainingUsd,
    directAnthropicOk: directModels.ok,
    directAuthMode: directModels.authModeUsed,
    geminiOk: geminiProbe.ok,
    geminiCacheStatus: geminiProbe.cacheProbe?.createStatus ?? null,
    orHas55: estimate.orHas55,
    directHas55: estimate.directHas55,
    orMaxTokens0Works: orProbes?.maxTokensZero?.works ?? false,
    orTtl1hSplit: orProbes?.ttl1h?.splitReported ?? false,
    directMaxTokens0Works: directProbes?.maxTokensZero?.works ?? null,
    directTtl1hSplit: directProbes?.ttl1h?.splitReported ?? null,
    directMidEffortWorks: directProbes?.midConversationOutputConfig?.worksAndPreservesPrefix ?? null,
    poolsExpectedUsd: estimate.totalsByPool
  }, null, 2));
}

main().catch((err) => {
  console.error('PHASE0_FAIL:', redactSensitiveText(err?.stack || err?.message || String(err)));
  process.exit(1);
});
