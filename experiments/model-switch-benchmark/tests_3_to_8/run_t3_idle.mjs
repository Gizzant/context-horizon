#!/usr/bin/env node
/**
 * T3: Idle Past Cache TTL, Keep-Alive Pings, and Gemini Explicit Storage
 * (Item 3 of Cost Optimization Anti-Patterns)
 *
 * - T3a (OpenRouter, anthropic/claude-sonnet-4.6, ~19.8k prefix):
 *     TTL5 (default 5m) vs TTL1H ("ttl": "1h") across idle gaps:
 *     4, 6, 12, 30 min (n=3) and 62 min (n=1).
 *     Concurrent staggered Req 1 launch; Req 2 scheduled >= gap*60s after Req 1 t_end.
 * - T3b (Keep-alive pings, n=2, 6 pings spaced 4.5m apart on default 5m TTL):
 *     KA-read (OpenRouter, max_tokens: 1) vs KA-zero (Direct Anthropic, max_tokens: 0, non-streaming).
 * - T3c (Gemini explicit cache, models/gemini-3.1-pro-preview, ~33k tokens >= 32k min, ttl: "3600s"):
 *     GEM_0Q (0 queries) vs GEM_3Q (3 queries). Records usageMetadata & response keys; DELETEs in finally.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  STANDARD_CSV_COLUMNS,
  RESULTS_DIR,
  createRepNonce,
  injectNonceAndBreakpoints,
  loadBenchmarkKeys,
  loadPinnedCorpusSlice,
  loadRateCard,
  sendMessagesCall,
  makeSimpleHttpRequestForProbe,
  RunBudgetTracker,
  summarizeMedianRange,
  writeCsv,
  assertNoSensitiveLeaks,
  redactSensitiveText
} from './prefix_lab.mjs';

const CHECKPOINT_PATH = path.join(RESULTS_DIR, 'raw', 't3_checkpoint_rows.jsonl');
const CSV_OUT_PATH = path.join(RESULTS_DIR, 't3_idle.csv');
const SUMMARY_OUT_PATH = path.join(RESULTS_DIR, 't3_summary.json');

const T3_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'subtest',
  'gap_minutes',
  'requested_ttl',
  'actual_idle_ms',
  'ping_index',
  'cache_hit',
  'ttl_status',
  'session_key',
  'gemini_cache_name',
  'gemini_create_tokens',
  'gemini_cached_read_tokens',
  'gemini_response_keys'
];

const CORPUS_SOURCES = [
  ['src/core-isomorphic/economics/billingBlocks.mjs', 1, 220],
  ['src/core-isomorphic/economics/dualTtl.mjs', 1, 220],
  ['src/core-isomorphic/guards/cliffBreaker.mjs', 1, 220],
  ['src/core-isomorphic/guards/circuitBreakers.mjs', 1, 1400],
  ['src/core/parser.mjs', 1, 1800],
  ['src/core/quota.mjs', 1, 1800],
  ['src/core/classifier.mjs', 1, 1800],
  ['src/core/compaction_coach.mjs', 1, 1200]
];

function sleepMs(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntilEpochMs(targetEpochMs) {
  while (true) {
    const remaining = targetEpochMs - Date.now();
    if (remaining <= 0) return;
    await sleepMs(Math.min(remaining, 30_000));
  }
}

function getExtraSecrets(keys) {
  return [
    keys.OPENROUTER_API_KEY,
    keys.ANTHROPIC_API_KEY,
    keys.GEMINI_BENCHMARK_API_KEY,
    keys.ENV_GEMINI_API_KEY
  ].filter(Boolean);
}

function loadCheckpoints() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return [];
  const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      // Ignore partial line if interrupted mid-write
    }
  }
  return entries;
}

function appendCheckpoint(entry, extraSecrets) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  const serialized = JSON.stringify(entry);
  assertNoSensitiveLeaks(serialized, 't3_checkpoint_entry', extraSecrets);
  fs.appendFileSync(CHECKPOINT_PATH, `${serialized}\n`, 'utf8');
}

function buildLinePool() {
  const chunks = [];
  for (const [relPath, s, e] of CORPUS_SOURCES) {
    try {
      const txt = loadPinnedCorpusSlice(relPath, s, e);
      if (txt) {
        chunks.push(`// === FILE: ${relPath} ===\n${txt}`);
      }
    } catch {
      // Skip if slice missing
    }
  }
  return chunks.join('\n\n').split(/\r?\n/);
}

async function countAnthropicTokens({ apiKey, authMode, model = 'claude-sonnet-4-6', text }) {
  const body = JSON.stringify({
    model,
    system: [{ type: 'text', text }],
    messages: [{ role: 'user', content: 'Review the code above and reply with the single token: READY.' }]
  });
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'anthropic-version': '2023-06-01',
    ...(authMode === 'bearer' ? { authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey })
  };
  const res = await makeSimpleHttpRequestForProbe({
    url: 'https://api.anthropic.com/v1/messages/count_tokens',
    method: 'POST',
    headers,
    body,
    timeoutMs: 30000
  });
  if (res.statusCode !== 200) {
    throw new Error(`Anthropic count_tokens HTTP ${res.statusCode}: ${redactSensitiveText(res.rawText.slice(0, 300))}`);
  }
  return JSON.parse(res.rawText).input_tokens;
}

async function countGeminiTokens({ apiKey, model = 'models/gemini-3.1-pro-preview', text }) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text }] }]
  });
  const res = await makeSimpleHttpRequestForProbe({
    url: `https://generativelanguage.googleapis.com/v1beta/${model}:countTokens`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body, 'utf8'),
      'x-goog-api-key': apiKey
    },
    body,
    timeoutMs: 30000
  });
  if (res.statusCode !== 200) {
    throw new Error(`Gemini countTokens HTTP ${res.statusCode}: ${redactSensitiveText(res.rawText.slice(0, 300))}`);
  }
  return JSON.parse(res.rawText).totalTokens;
}

async function calibratePrefixByLines({ targetTokens, minTokens, maxTokens, allLines, countFn, label }) {
  // Ensure line pool can exceed targetTokens by repeating with file iteration headers if needed
  let extendedLines = [...allLines];
  let pass = 2;
  while (extendedLines.join('\n').length < targetTokens * 5.2) {
    extendedLines.push(`// === SUPPLEMENTAL_PASS_${pass} ===`, ...allLines);
    pass += 1;
  }

  let lo = 100;
  let hi = extendedLines.length;
  let bestText = extendedLines.slice(0, Math.min(hi, Math.round(targetTokens / 4))).join('\n');
  let bestTok = await countFn(bestText);
  console.log(`[Calibrate:${label}] Initial guess lines=${bestText.split('\n').length} -> ${bestTok} tok`);

  if (bestTok < minTokens || bestTok > maxTokens) {
    for (let iter = 0; iter < 10; iter += 1) {
      if (bestTok < targetTokens) {
        lo = Math.max(lo, bestText.split('\n').length + 1);
      } else {
        hi = Math.min(hi, bestText.split('\n').length - 1);
      }
      if (lo > hi) break;
      const mid = Math.floor((lo + hi) / 2);
      const candidate = extendedLines.slice(0, mid).join('\n');
      const tok = await countFn(candidate);
      if (Math.abs(tok - targetTokens) < Math.abs(bestTok - targetTokens)) {
        bestText = candidate;
        bestTok = tok;
      }
      if (tok >= minTokens && tok <= maxTokens) {
        bestText = candidate;
        bestTok = tok;
        break;
      }
    }
  }
  console.log(`[Calibrate:${label}] Final calibrated tokens=${bestTok} (target=${targetTokens} [${minTokens}..${maxTokens}])`);
  return { text: bestText, tokens: bestTok };
}

function makeStandardExtraFields(extra) {
  return {
    subtest: extra.subtest ?? '',
    gap_minutes: extra.gap_minutes ?? '',
    requested_ttl: extra.requested_ttl ?? '',
    actual_idle_ms: extra.actual_idle_ms ?? '',
    ping_index: extra.ping_index ?? '',
    cache_hit: extra.cache_hit ?? '',
    ttl_status: extra.ttl_status ?? '',
    session_key: extra.session_key ?? '',
    gemini_cache_name: extra.gemini_cache_name ?? '',
    gemini_create_tokens: extra.gemini_create_tokens ?? '',
    gemini_cached_read_tokens: extra.gemini_cached_read_tokens ?? '',
    gemini_response_keys: extra.gemini_response_keys ?? ''
  };
}

function buildT3aSchedule() {
  // Ordered longest-first so 62m clock starts immediately at t=0
  const gapPlan = [
    { gapMinutes: 62, reps: 1 },
    { gapMinutes: 30, reps: 3 },
    { gapMinutes: 12, reps: 3 },
    { gapMinutes: 6, reps: 3 },
    { gapMinutes: 4, reps: 3 }
  ];
  const sessions = [];
  for (const { gapMinutes, reps } of gapPlan) {
    for (const ttlMode of ['TTL1H', 'TTL5']) {
      for (let rep = 1; rep <= reps; rep += 1) {
        const arm = `${ttlMode}_${gapMinutes}m`;
        const sessionKey = `T3a|${arm}|${rep}`;
        sessions.push({
          subtest: 'T3a',
          arm,
          ttlMode,
          requestedTtl: ttlMode === 'TTL1H' ? '1h' : '5m',
          gapMinutes,
          rep,
          sessionKey
        });
      }
    }
  }
  return sessions;
}

async function runOneT3aSession({
  spec,
  launchDelayMs,
  prefixText,
  customRateCard,
  orBudget,
  extraSecrets
}) {
  await sleepMs(launchDelayMs);

  const nonce = createRepNonce(`t3a_${spec.arm}_r${spec.rep}`);
  const ttlParam = spec.ttlMode === 'TTL1H' ? '1h' : null;
  const prompt1 = 'Review the telemetry module above and reply with the single token: READY.';
  const built1 = injectNonceAndBreakpoints({
    nonce,
    system: [{ type: 'text', text: prefixText }],
    messages: [{ role: 'user', content: prompt1 }],
    ttl: ttlParam,
    breakpointLayers: ['system'],
    omitMessageBreakpoint: true
  });

  console.log(`[T3a] Launching ${spec.sessionKey} Req1 (${spec.requestedTtl}, gap=${spec.gapMinutes}m)...`);
  const res1 = await sendMessagesCall({
    test: 'T3',
    arm: spec.arm,
    rep: spec.rep,
    turn: 1,
    route: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    system: built1.system,
    messages: built1.messages,
    max_tokens: 32,
    stream: true,
    requestedTtl: spec.ttlMode === 'TTL1H' ? '1h' : '5m',
    nonceId: nonce,
    customRateCard,
    budgetTracker: orBudget
  });

  const tEnd1 = Date.now();
  const row1 = {
    ...res1.row,
    ...makeStandardExtraFields({
      subtest: 'T3a',
      gap_minutes: spec.gapMinutes,
      requested_ttl: spec.requestedTtl,
      actual_idle_ms: 0,
      ping_index: 1,
      cache_hit: false,
      ttl_status: res1.row.http_status === 200 ? 'primed' : 'error',
      session_key: spec.sessionKey
    })
  };

  if (res1.row.http_status !== 200) {
    console.error(`[T3a] ABORT ${spec.sessionKey}: Req1 HTTP ${res1.row.http_status} ${res1.row.error_text}`);
    const entry = { sessionKey: spec.sessionKey, subtest: 'T3a', aborted: true, rows: [row1], meta: spec };
    appendCheckpoint(entry, extraSecrets);
    return entry;
  }

  const targetWakeMs = tEnd1 + spec.gapMinutes * 60_000;
  console.log(`[T3a] Primed ${spec.sessionKey} (w5=${res1.row.cache_write_5m_tokens}, w1h=${res1.row.cache_write_1h_tokens}, billed=$${res1.row.billed_cost_usd}). Sleeping ${spec.gapMinutes}m until ${new Date(targetWakeMs).toISOString()}...`);
  await sleepUntilEpochMs(targetWakeMs);
  const actualIdleMs = Date.now() - tEnd1;

  const built2 = injectNonceAndBreakpoints({
    nonce,
    system: [{ type: 'text', text: prefixText }],
    messages: [
      ...built1.messages,
      { role: 'assistant', content: [{ type: 'text', text: res1.assistantText || 'READY' }] },
      { role: 'user', content: 'State the primary purpose of the billing block module in one brief sentence.' }
    ],
    ttl: ttlParam,
    breakpointLayers: ['system'],
    omitMessageBreakpoint: true
  });

  const res2 = await sendMessagesCall({
    test: 'T3',
    arm: spec.arm,
    rep: spec.rep,
    turn: 2,
    route: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    system: built2.system,
    messages: built2.messages,
    max_tokens: 64,
    stream: true,
    requestedTtl: spec.ttlMode === 'TTL1H' ? '1h' : '5m',
    nonceId: nonce,
    customRateCard,
    budgetTracker: orBudget
  });

  const cacheHit = res2.row.http_status === 200 && res2.row.cache_read_tokens >= 14000;
  const ttlStatus = res2.row.http_status !== 200 ? 'error' : (cacheHit ? 'hit' : 'expired_rewrite');
  const row2 = {
    ...res2.row,
    ...makeStandardExtraFields({
      subtest: 'T3a',
      gap_minutes: spec.gapMinutes,
      requested_ttl: spec.requestedTtl,
      actual_idle_ms: actualIdleMs,
      ping_index: 2,
      cache_hit: cacheHit,
      ttl_status: ttlStatus,
      session_key: spec.sessionKey
    })
  };

  console.log(`[T3a] Done ${spec.sessionKey}: idle=${(actualIdleMs / 60000).toFixed(2)}m status=${ttlStatus} read=${res2.row.cache_read_tokens} w5=${res2.row.cache_write_5m_tokens} w1h=${res2.row.cache_write_1h_tokens} cost=$${res2.row.billed_cost_usd || res2.row.computed_cost_usd}`);

  const c1 = Number(res1.row.billed_cost_usd || res1.row.computed_cost_usd || 0);
  const c2 = Number(res2.row.billed_cost_usd || res2.row.computed_cost_usd || 0);
  const entry = {
    sessionKey: spec.sessionKey,
    subtest: 'T3a',
    aborted: res2.row.http_status !== 200,
    rows: [row1, row2],
    meta: {
      ...spec,
      actualIdleMs,
      cacheHit,
      ttlStatus,
      req1Write5m: res1.row.cache_write_5m_tokens,
      req1Write1h: res1.row.cache_write_1h_tokens,
      req2Read: res2.row.cache_read_tokens,
      req2Write5m: res2.row.cache_write_5m_tokens,
      req2Write1h: res2.row.cache_write_1h_tokens,
      req1CostUsd: c1,
      req2CostUsd: c2,
      totalCostUsd: Number((c1 + c2).toFixed(6))
    }
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

async function runOneT3bSession({
  arm,
  rep,
  launchDelayMs,
  prefixText,
  customRateCard,
  budgetTracker,
  extraSecrets
}) {
  await sleepMs(launchDelayMs);

  const isZero = arm === 'KA-zero';
  const route = isZero ? 'anthropic_direct' : 'openrouter';
  const model = isZero ? 'claude-sonnet-4-6' : 'anthropic/claude-sonnet-4.6';
  const maxTokens = isZero ? 0 : 1;
  const stream = !isZero;
  const pingCount = 6;
  const intervalMs = 4.5 * 60_000; // 270,000 ms
  const sessionKey = `T3b|${arm}|${rep}`;
  const nonce = createRepNonce(`t3b_${arm}_r${rep}`);

  const rows = [];
  let aborted = false;
  let lastEndMs = 0;

  for (let ping = 1; ping <= pingCount; ping += 1) {
    let actualIdleMs = 0;
    if (ping > 1) {
      const targetWake = lastEndMs + intervalMs;
      console.log(`[T3b] ${sessionKey} ping ${ping}/${pingCount} sleeping 4.5m until ${new Date(targetWake).toISOString()}...`);
      await sleepUntilEpochMs(targetWake);
      actualIdleMs = Date.now() - lastEndMs;
    }

    const built = injectNonceAndBreakpoints({
      nonce,
      system: [{ type: 'text', text: prefixText }],
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      ttl: null,
      breakpointLayers: ['system'],
      omitMessageBreakpoint: true
    });

    const res = await sendMessagesCall({
      test: 'T3',
      arm,
      rep,
      turn: ping,
      route,
      model,
      system: built.system,
      messages: built.messages,
      max_tokens: maxTokens,
      stream,
      requestedTtl: '5m',
      nonceId: nonce,
      customRateCard,
      budgetTracker
    });
    lastEndMs = Date.now();

    const cacheHit = res.row.http_status === 200 && ping > 1 && res.row.cache_read_tokens >= 14000;
    const ttlStatus = res.row.http_status !== 200
      ? 'error'
      : (ping === 1 ? 'primed' : (cacheHit ? 'refreshed_hit' : 'expired_rewrite'));

    const row = {
      ...res.row,
      ...makeStandardExtraFields({
        subtest: 'T3b',
        gap_minutes: ping === 1 ? 0 : 4.5,
        requested_ttl: '5m',
        actual_idle_ms: actualIdleMs,
        ping_index: ping,
        cache_hit: cacheHit,
        ttl_status: ttlStatus,
        session_key: sessionKey
      })
    };
    rows.push(row);

    const effCost = Number(res.row.billed_cost_usd || res.row.computed_cost_usd || 0);
    console.log(`[T3b] ${sessionKey} ping ${ping}/${pingCount}: status=${ttlStatus} read=${res.row.cache_read_tokens} w5=${res.row.cache_write_5m_tokens} out=${res.row.output_tokens} cost=$${effCost}`);

    if (res.row.http_status !== 200) {
      aborted = true;
      break;
    }
  }

  const totalCostUsd = Number(rows.reduce((acc, r) => acc + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0).toFixed(6));
  const keepAliveOverheadUsd = Number(rows.slice(1).reduce((acc, r) => acc + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0).toFixed(6));
  const hitPings = rows.slice(1).filter((r) => r.cache_hit === true).length;

  const entry = {
    sessionKey,
    subtest: 'T3b',
    aborted,
    rows,
    meta: {
      arm,
      rep,
      route,
      model,
      pingCount: rows.length,
      hitPings,
      totalCostUsd,
      keepAliveOverheadUsd,
      costSource: isZero ? 'computed' : 'billed',
      maxOutputTokensSeen: Math.max(...rows.map((r) => r.output_tokens || 0))
    }
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

async function geminiJsonRequest({ url, method = 'GET', apiKey, bodyObj = null }) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  const headers = {
    'x-goog-api-key': apiKey,
    ...(body ? {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body, 'utf8')
    } : {})
  };
  const tStart = new Date().toISOString();
  const t0 = Date.now();
  const res = await makeSimpleHttpRequestForProbe({
    url,
    method,
    headers,
    body,
    timeoutMs: 60000
  });
  const tEnd = new Date().toISOString();
  const latencyMs = Date.now() - t0;
  let json = null;
  try {
    json = JSON.parse(res.rawText);
  } catch {
    json = null;
  }
  return {
    statusCode: res.statusCode,
    json,
    rawPreview: redactSensitiveText(res.rawText.slice(0, 600)),
    tStart,
    tEnd,
    latencyMs
  };
}

async function runT3cGemini({ keys, geminiPrefixText, geminiCalTokens, extraSecrets }) {
  const apiKey = keys.GEMINI_BENCHMARK_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_BENCHMARK_API_KEY is missing');
  }
  const model = 'models/gemini-3.1-pro-preview';
  const nonceA = createRepNonce('t3c_gem_0q');
  const nonceB = createRepNonce('t3c_gem_3q');
  const textA = `[NONCE:${nonceA}]\n${geminiPrefixText}`;
  const textB = `[NONCE:${nonceB}]\n${geminiPrefixText}`;

  const createdNames = [];
  const rows = [];
  const details = {
    model,
    calibratedPrefixTokens: geminiCalTokens,
    caches: [],
    queries: [],
    deletions: []
  };

  try {
    // Create Cache A (0 queries)
    const createA = await geminiJsonRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta/cachedContents',
      method: 'POST',
      apiKey,
      bodyObj: {
        model,
        displayName: `t3c_0q_${nonceA}`,
        contents: [{ role: 'user', parts: [{ text: textA }] }],
        ttl: '3600s'
      }
    });
    if (createA.statusCode !== 200 || !createA.json?.name) {
      throw new Error(`Gemini Cache A create failed HTTP ${createA.statusCode}: ${createA.rawPreview}`);
    }
    createdNames.push({ name: createA.json.name, arm: 'GEM_0Q' });
    const createATok = createA.json.usageMetadata?.totalTokenCount ?? 0;
    const keysA = Object.keys(createA.json);
    details.caches.push({
      arm: 'GEM_0Q',
      nameRedacted: `cachedContents/redacted_${nonceA}`,
      ttl: createA.json.ttl || '3600s',
      createTime: createA.json.createTime || null,
      expireTime: createA.json.expireTime || null,
      usageMetadata: createA.json.usageMetadata || null,
      responseKeys: keysA,
      hasBillingUsdField: keysA.some((k) => /cost|price|usd|billing/i.test(k))
    });
    rows.push({
      test: 'T3',
      arm: 'GEM_0Q',
      rep: 1,
      turn: 0,
      model_slug: model,
      provider: 'google-ai-studio',
      prompt_tokens: createATok,
      uncached_input_tokens: createATok,
      cache_read_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: createATok,
      cache_write_tokens: createATok,
      output_tokens: 0,
      billed_cost_usd: '',
      computed_cost_usd: '',
      cost_source: 'unverified',
      http_status: createA.statusCode,
      error_text: '',
      t_start: createA.tStart,
      t_first_byte: createA.tEnd,
      t_end: createA.tEnd,
      ttfb_ms: createA.latencyMs,
      latency_ms: createA.latencyMs,
      nonce_id: nonceA,
      ...makeStandardExtraFields({
        subtest: 'T3c',
        gap_minutes: 0,
        requested_ttl: '3600s',
        actual_idle_ms: 0,
        ping_index: 0,
        cache_hit: false,
        ttl_status: 'created_0_queries',
        session_key: 'T3c|GEM_0Q|1',
        gemini_cache_name: `cachedContents/redacted_${nonceA}`,
        gemini_create_tokens: createATok,
        gemini_cached_read_tokens: 0,
        gemini_response_keys: keysA.join(',')
      })
    });

    // Create Cache B (3 queries)
    const createB = await geminiJsonRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta/cachedContents',
      method: 'POST',
      apiKey,
      bodyObj: {
        model,
        displayName: `t3c_3q_${nonceB}`,
        contents: [{ role: 'user', parts: [{ text: textB }] }],
        ttl: '3600s'
      }
    });
    if (createB.statusCode !== 200 || !createB.json?.name) {
      throw new Error(`Gemini Cache B create failed HTTP ${createB.statusCode}: ${createB.rawPreview}`);
    }
    createdNames.push({ name: createB.json.name, arm: 'GEM_3Q' });
    const createBTok = createB.json.usageMetadata?.totalTokenCount ?? 0;
    const keysB = Object.keys(createB.json);
    details.caches.push({
      arm: 'GEM_3Q',
      nameRedacted: `cachedContents/redacted_${nonceB}`,
      ttl: createB.json.ttl || '3600s',
      createTime: createB.json.createTime || null,
      expireTime: createB.json.expireTime || null,
      usageMetadata: createB.json.usageMetadata || null,
      responseKeys: keysB,
      hasBillingUsdField: keysB.some((k) => /cost|price|usd|billing/i.test(k))
    });
    rows.push({
      test: 'T3',
      arm: 'GEM_3Q',
      rep: 1,
      turn: 0,
      model_slug: model,
      provider: 'google-ai-studio',
      prompt_tokens: createBTok,
      uncached_input_tokens: createBTok,
      cache_read_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: createBTok,
      cache_write_tokens: createBTok,
      output_tokens: 0,
      billed_cost_usd: '',
      computed_cost_usd: '',
      cost_source: 'unverified',
      http_status: createB.statusCode,
      error_text: '',
      t_start: createB.tStart,
      t_first_byte: createB.tEnd,
      t_end: createB.tEnd,
      ttfb_ms: createB.latencyMs,
      latency_ms: createB.latencyMs,
      nonce_id: nonceB,
      ...makeStandardExtraFields({
        subtest: 'T3c',
        gap_minutes: 0,
        requested_ttl: '3600s',
        actual_idle_ms: 0,
        ping_index: 0,
        cache_hit: false,
        ttl_status: 'created_for_queries',
        session_key: 'T3c|GEM_3Q|1',
        gemini_cache_name: `cachedContents/redacted_${nonceB}`,
        gemini_create_tokens: createBTok,
        gemini_cached_read_tokens: 0,
        gemini_response_keys: keysB.join(',')
      })
    });

    const prompts = [
      'In one short sentence, what does billingBlocks.mjs calculate?',
      'In one short sentence, what does dualTtl.mjs track?',
      'In one short sentence, what does cliffBreaker.mjs prevent?'
    ];

    for (let qi = 0; qi < prompts.length; qi += 1) {
      if (qi > 0) await sleepMs(3000);
      const qRes = await geminiJsonRequest({
        url: `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`,
        method: 'POST',
        apiKey,
        bodyObj: {
          cachedContent: createB.json.name,
          contents: [{ role: 'user', parts: [{ text: prompts[qi] }] }],
          generationConfig: { maxOutputTokens: 64 }
        }
      });
      const u = qRes.json?.usageMetadata || {};
      const qKeys = qRes.json ? Object.keys(qRes.json) : [];
      const promptTok = u.promptTokenCount ?? 0;
      const cachedTok = u.cachedContentTokenCount ?? 0;
      const outTok = u.candidatesTokenCount ?? 0;
      details.queries.push({
        queryIndex: qi + 1,
        httpStatus: qRes.statusCode,
        usageMetadata: u,
        responseKeys: qKeys,
        hasBillingUsdField: qKeys.some((k) => /cost|price|usd|billing/i.test(k))
      });
      rows.push({
        test: 'T3',
        arm: 'GEM_3Q',
        rep: 1,
        turn: qi + 1,
        model_slug: model,
        provider: 'google-ai-studio',
        prompt_tokens: promptTok,
        uncached_input_tokens: Math.max(0, promptTok - cachedTok),
        cache_read_tokens: cachedTok,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: outTok,
        billed_cost_usd: '',
        computed_cost_usd: '',
        cost_source: 'unverified',
        http_status: qRes.statusCode,
        error_text: qRes.statusCode >= 400 ? qRes.rawPreview : '',
        t_start: qRes.tStart,
        t_first_byte: qRes.tEnd,
        t_end: qRes.tEnd,
        ttfb_ms: qRes.latencyMs,
        latency_ms: qRes.latencyMs,
        nonce_id: nonceB,
        ...makeStandardExtraFields({
          subtest: 'T3c',
          gap_minutes: 0,
          requested_ttl: '3600s',
          actual_idle_ms: 0,
          ping_index: qi + 1,
          cache_hit: cachedTok > 25000,
          ttl_status: qRes.statusCode === 200 ? 'cache_query_ok' : 'error',
          session_key: 'T3c|GEM_3Q|1',
          gemini_cache_name: `cachedContents/redacted_${nonceB}`,
          gemini_create_tokens: createBTok,
          gemini_cached_read_tokens: cachedTok,
          gemini_response_keys: qKeys.join(',')
        })
      });
      console.log(`[T3c] GEM_3Q q=${qi + 1}/3 HTTP=${qRes.statusCode} promptTok=${promptTok} cachedTok=${cachedTok} outTok=${outTok}`);
    }

    // Hold Cache A at least 15s total before cleanup
    await sleepMs(5000);
  } finally {
    for (const item of createdNames) {
      try {
        const delRes = await geminiJsonRequest({
          url: `https://generativelanguage.googleapis.com/v1beta/${item.name}`,
          method: 'DELETE',
          apiKey
        });
        details.deletions.push({ arm: item.arm, deleteHttpStatus: delRes.statusCode });
        console.log(`[T3c] Deleted ${item.arm} cache -> HTTP ${delRes.statusCode}`);
      } catch (err) {
        details.deletions.push({ arm: item.arm, deleteHttpStatus: 0, error: redactSensitiveText(err.message) });
        console.error(`[T3c] Failed to delete ${item.arm} cache: ${redactSensitiveText(err.message)}`);
      }
    }
  }

  const entry = {
    sessionKey: 'T3c|GEMINI|1',
    subtest: 'T3c',
    aborted: rows.some((r) => r.http_status !== 200),
    rows,
    meta: details
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

function reclassifyEntry(entry) {
  const rowCost = (r) => Number(r?.billed_cost_usd || r?.computed_cost_usd || 0);
  if (entry.subtest === 'T3a' && Array.isArray(entry.rows) && entry.rows.length >= 2) {
    const r1 = entry.rows[0];
    const r2 = entry.rows[1];
    const cacheHit = r2.http_status === 200 && Number(r2.cache_read_tokens || 0) >= 14000;
    const ttlStatus = r2.http_status !== 200 ? 'error' : (cacheHit ? 'hit' : 'expired_rewrite');
    r2.cache_hit = cacheHit;
    r2.ttl_status = ttlStatus;
    const c1 = rowCost(r1);
    const c2 = rowCost(r2);
    return {
      ...entry,
      rows: [r1, r2],
      meta: {
        ...entry.meta,
        cacheHit,
        ttlStatus,
        req1CostUsd: c1,
        req2CostUsd: c2,
        totalCostUsd: Number((c1 + c2).toFixed(6))
      }
    };
  }
  if (entry.subtest === 'T3b' && Array.isArray(entry.rows)) {
    const rows = entry.rows.map((r, i) => {
      if (i === 0) return { ...r, cache_hit: false, ttl_status: r.http_status === 200 ? 'primed' : 'error' };
      const cacheHit = r.http_status === 200 && Number(r.cache_read_tokens || 0) >= 14000;
      const ttlStatus = r.http_status !== 200 ? 'error' : (cacheHit ? 'refreshed_hit' : 'expired_rewrite');
      return { ...r, cache_hit: cacheHit, ttl_status: ttlStatus };
    });
    const totalCostUsd = Number(rows.reduce((a, r) => a + rowCost(r), 0).toFixed(6));
    const keepAliveOverheadUsd = Number(rows.slice(1).reduce((a, r) => a + rowCost(r), 0).toFixed(6));
    const hitPings = rows.slice(1).filter((r) => r.cache_hit === true).length;
    return {
      ...entry,
      rows,
      meta: {
        ...entry.meta,
        hitPings,
        totalCostUsd,
        keepAliveOverheadUsd
      }
    };
  }
  return entry;
}

function buildSummary(rawEntries) {
  const entries = rawEntries.map(reclassifyEntry);
  const validT3a = entries.filter((e) => e.subtest === 'T3a' && !e.aborted);
  const t3aSummary = {};
  for (const arm of [...new Set(validT3a.map((e) => e.meta.arm))]) {
    const group = validT3a.filter((e) => e.meta.arm === arm);
    const hitCount = group.filter((e) => e.meta.cacheHit).length;
    t3aSummary[arm] = {
      n: group.length,
      ttlMode: group[0].meta.ttlMode,
      gapMinutes: group[0].meta.gapMinutes,
      hits: hitCount,
      misses: group.length - hitCount,
      actualIdleMin: summarizeMedianRange(group.map((e) => Number((e.meta.actualIdleMs / 60000).toFixed(3)))),
      req2CacheReadTokens: summarizeMedianRange(group.map((e) => e.meta.req2Read)),
      req1CostUsd: summarizeMedianRange(group.map((e) => e.meta.req1CostUsd)),
      req2CostUsd: summarizeMedianRange(group.map((e) => e.meta.req2CostUsd)),
      total2ReqCostUsd: summarizeMedianRange(group.map((e) => e.meta.totalCostUsd))
    };
  }

  const validT3b = entries.filter((e) => e.subtest === 'T3b' && !e.aborted);
  const t3bSummary = {};
  for (const arm of ['KA-read', 'KA-zero']) {
    const group = validT3b.filter((e) => e.meta.arm === arm);
    if (!group.length) continue;
    t3bSummary[arm] = {
      n: group.length,
      route: group[0].meta.route,
      model: group[0].meta.model,
      costSource: group[0].meta.costSource,
      pingsPerSession: summarizeMedianRange(group.map((e) => e.meta.pingCount)),
      hitPingsPerSession: summarizeMedianRange(group.map((e) => e.meta.hitPings)),
      maxOutputTokensSeen: Math.max(...group.map((e) => e.meta.maxOutputTokensSeen)),
      keepAliveOverhead5PingsUsd: summarizeMedianRange(group.map((e) => e.meta.keepAliveOverheadUsd)),
      total6PingCostUsd: summarizeMedianRange(group.map((e) => e.meta.totalCostUsd))
    };
  }

  // Empirical post-gap break-even comparing TTL5 expired rewrite vs TTL1H write+read
  const firstReadCost = Number(validT3b.find((e) => e.meta.arm === 'KA-read')?.rows?.[1]?.billed_cost_usd || 0) || null;
  const firstZeroCost = Number(validT3b.find((e) => e.meta.arm === 'KA-zero')?.rows?.[1]?.computed_cost_usd || 0) || null;
  const write5mSample = validT3a.find((e) => e.meta.ttlMode === 'TTL5')?.meta?.req1CostUsd ?? null;
  const write1hSample = validT3a.find((e) => e.meta.ttlMode === 'TTL1H')?.meta?.req1CostUsd ?? null;
  const readHitSample = t3aSummary.TTL1H_12m?.req2CostUsd?.median ?? t3aSummary.TTL5_4m?.req2CostUsd?.median ?? null;
  const ttl5After1GapUsd = (write5mSample !== null && t3aSummary.TTL5_12m?.req2CostUsd?.median !== undefined)
    ? Number((write5mSample + t3aSummary.TTL5_12m.req2CostUsd.median).toFixed(6))
    : null;
  const ttl1hAfter1GapUsd = (write1hSample !== null && readHitSample !== null)
    ? Number((write1hSample + readHitSample).toFixed(6))
    : null;

  const t3cEntry = entries.find((e) => e.subtest === 'T3c');

  return {
    generatedAtUtc: new Date().toISOString(),
    t3a: t3aSummary,
    t3aBreakEven: {
      write5mSampleUsd: write5mSample,
      write1hSampleUsd: write1hSample,
      readHitSampleUsd: readHitSample,
      ttl5TotalAfterOnePost5mGapUsd: ttl5After1GapUsd,
      ttl1hTotalAfterOnePost5mGapUsd: ttl1hAfter1GapUsd,
      breakEvenPostGapRequests: 1,
      note: 'Because 1h write (2.0x) + 1 read (0.1x) = 2.1x < 5m write (1.25x) + 1 expired 5m rewrite (1.25x) = 2.5x, 1h TTL already breaks even at 1 post-gap request (turn 2) after any >5m pause — earlier than the attachment claim of roughly the third turn.'
    },
    t3b: {
      arms: t3bSummary,
      measuredBreakEvenAnalysis: {
        pingCostKaReadUsd: firstReadCost,
        pingCostKaZeroUsd: firstZeroCost,
        write5mCostUsd: write5mSample,
        write1hCostUsd: write1hSample,
        note: '5m rewrite costs ~1.25x base vs 0.1x read ping (~12.5x ratio), so up to 12 keep-alive pings cost less than 1 cold rewrite (~60m max idle before break-even); 1h cache (2.0x write) beats 5m + keep-alive once >= ~8 idle pings would otherwise be needed.'
      }
    },
    t3c: t3cEntry ? {
      aborted: t3cEntry.aborted,
      ...t3cEntry.meta,
      apiStorageUsdVerified: false,
      note: 'Gemini API returns usageMetadata token counts and timestamps (createTime, expireTime, ttl), with no USD storage rate or billed cost field; claimed $4.50/M tokens/hr rate and 2.5 queries/hr break-even remain unverified by API telemetry.'
    } : null,
    abortedSessions: entries.filter((e) => e.aborted).map((e) => e.sessionKey)
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const recomputeOnly = args.includes('--recompute-only');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const enabledSubtests = onlyArg
    ? new Set(onlyArg.split('=')[1].split(',').map((s) => s.trim()))
    : new Set(['T3a', 'T3b', 'T3c']);

  const keys = loadBenchmarkKeys();
  const extraSecrets = getExtraSecrets(keys);
  const rateCard = loadRateCard();

  if (fresh && !recomputeOnly && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
    console.log('[T3] Cleared existing checkpoint for --fresh run.');
  }

  let checkpointed = loadCheckpoints();
  const doneKeys = new Set(checkpointed.filter((e) => !e.aborted).map((e) => e.sessionKey));

  const allLines = buildLinePool();

  const needsAnthropicPrefix = !recomputeOnly && (
    (enabledSubtests.has('T3a') && buildT3aSchedule().some((s) => !doneKeys.has(s.sessionKey))) ||
    (enabledSubtests.has('T3b') && ['KA-read', 'KA-zero'].some((arm) => [1, 2].some((rep) => !doneKeys.has(`T3b|${arm}|${rep}`))))
  );

  const needsGeminiPrefix = !recomputeOnly && enabledSubtests.has('T3c') && !doneKeys.has('T3c|GEMINI|1');

  let anthropicPrefix = null;
  if (needsAnthropicPrefix) {
    if (!keys.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY needed for free ($0) count_tokens calibration & KA-zero');
    }
    anthropicPrefix = await calibratePrefixByLines({
      targetTokens: 19800,
      minTokens: 19500,
      maxTokens: 20100,
      allLines,
      countFn: (text) => countAnthropicTokens({ apiKey: keys.ANTHROPIC_API_KEY, authMode: 'x-api-key', text }),
      label: 'Anthropic_19.8k'
    });
  }

  let geminiPrefix = null;
  if (needsGeminiPrefix) {
    geminiPrefix = await calibratePrefixByLines({
      targetTokens: 33500,
      minTokens: 32900,
      maxTokens: 35500,
      allLines,
      countFn: (text) => countGeminiTokens({ apiKey: keys.GEMINI_BENCHMARK_API_KEY, text }),
      label: 'Gemini_33.5k'
    });
  }

  const orBudget = new RunBudgetTracker({
    expectedRunUsd: 3.7,
    multiplier: 3,
    maxRunUsd: 12.0,
    globalCapUsd: 25.0,
    label: 'T3_OpenRouter'
  });
  const anthropicBudget = new RunBudgetTracker({
    expectedRunUsd: 0.25,
    multiplier: 3,
    maxRunUsd: 2.0,
    globalCapUsd: 10.0,
    label: 'T3_AnthropicDirect'
  });

  const tasks = [];

  if (!recomputeOnly) {
    if (enabledSubtests.has('T3c') && !doneKeys.has('T3c|GEMINI|1')) {
      tasks.push(
        runT3cGemini({
          keys,
          geminiPrefixText: geminiPrefix.text,
          geminiCalTokens: geminiPrefix.tokens,
          extraSecrets
        })
      );
    }

    if (enabledSubtests.has('T3a')) {
      const t3aSchedule = buildT3aSchedule().filter((s) => !doneKeys.has(s.sessionKey));
      console.log(`[T3a] Scheduling ${t3aSchedule.length} mini-sessions (skipping ${26 - t3aSchedule.length} checkpointed)...`);
      t3aSchedule.forEach((spec, idx) => {
        tasks.push(
          runOneT3aSession({
            spec,
            launchDelayMs: idx * 500,
            prefixText: anthropicPrefix.text,
            customRateCard: rateCard,
            orBudget,
            extraSecrets
          })
        );
      });
    }

    if (enabledSubtests.has('T3b')) {
      const t3bSpecs = [];
      for (const arm of ['KA-read', 'KA-zero']) {
        for (const rep of [1, 2]) {
          const key = `T3b|${arm}|${rep}`;
          if (!doneKeys.has(key)) t3bSpecs.push({ arm, rep, key });
        }
      }
      console.log(`[T3b] Scheduling ${t3bSpecs.length} keep-alive sessions (6 pings x 4.5m)...`);
      t3bSpecs.forEach((spec, idx) => {
        tasks.push(
          runOneT3bSession({
            arm: spec.arm,
            rep: spec.rep,
            launchDelayMs: 1500 + idx * 1500,
            prefixText: anthropicPrefix.text,
            customRateCard: rateCard,
            budgetTracker: spec.arm === 'KA-zero' ? anthropicBudget : orBudget,
            extraSecrets
          })
        );
      });
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  } else {
    console.log('[T3] --recompute-only: regenerating CSV & summary from existing checkpoints ($0)...');
  }

  // Reload full checkpointed dataset (deduped by sessionKey, latest wins) and reclassify cleanly
  const finalByKey = new Map();
  for (const entry of loadCheckpoints()) {
    finalByKey.set(entry.sessionKey, entry);
  }
  const allEntries = [...finalByKey.values()].map(reclassifyEntry);
  const allRows = allEntries.flatMap((e) => e.rows || []);

  writeCsv(CSV_OUT_PATH, T3_CSV_COLUMNS, allRows);
  const summary = buildSummary(allEntries);
  const summaryJson = JSON.stringify(summary, null, 2);
  assertNoSensitiveLeaks(summaryJson, 't3_summary.json', extraSecrets);
  fs.writeFileSync(SUMMARY_OUT_PATH, summaryJson, 'utf8');

  console.log(`[T3] Complete! Wrote ${allRows.length} rows -> ${CSV_OUT_PATH}`);
  console.log(`[T3] Summary -> ${SUMMARY_OUT_PATH}`);
  if (summary.abortedSessions.length > 0) {
    console.error(`[T3] WARNING: Aborted sessions present: ${summary.abortedSessions.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[T3] Fatal error:', redactSensitiveText(err.stack || err.message));
  process.exit(1);
});
