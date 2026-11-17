#!/usr/bin/env node
/**
 * R2: Per-Message Effort Remedy via Direct Anthropic API ONLY
 * (Item 2 Remedy — beta header mid-conversation-output-config-2026-07-01)
 *
 * Pre-check (3 calls on claude-sonnet-5-5):
 *   Tests whether omitting output_config (`null`) shares prefix cache with explicit
 *   { effort: 'high' } or { effort: 'medium' }, establishing `verifiedDefaultEffort` for EF3.
 *
 * Main Sweep (12 turns short chat, ~15k corpus prefix, n=3 concurrent per arm):
 *   On claude-sonnet-5-5 (direct API, beta header enabled):
 *     - EF0: Static top-level effort='medium' all 12 turns (control)
 *     - EF1: Top-level output_config.effort switch (medium T1-T5 -> high T6-T12)
 *     - EF2: Static top-level effort='medium' + per-message {role:"system", content:[], output_config:{effort:'high'}} @T6
 *     - EF3: Omit output_config (null) T1-T5 -> explicit top-level {effort: verifiedDefaultEffort} T6-T12
 *   On claude-sonnet-4-6 (direct API, NO beta header — Phase 0 confirmed 400 with beta header):
 *     - EF0_46: Static top-level effort='medium' all 12 turns
 *     - EF1_46: Top-level output_config.effort switch (medium T1-T5 -> high T6-T12)
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
  RunBudgetTracker,
  summarizeMedianRange,
  writeCsv,
  assertNoSensitiveLeaks,
  redactSensitiveText
} from './prefix_lab.mjs';

const CHECKPOINT_PATH = path.join(RESULTS_DIR, 'raw', 'r2_checkpoint_rows.jsonl');
const CSV_OUT_PATH = path.join(RESULTS_DIR, 'r2_effort.csv');
const SUMMARY_OUT_PATH = path.join(RESULTS_DIR, 'r2_summary.json');

const BETA_HEADER = 'mid-conversation-output-config-2026-07-01';
const MODEL_55 = 'claude-sonnet-5-5';
const MODEL_46 = 'claude-sonnet-4-6';
const REPS = [1, 2, 3];

const R2_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'arm_group',
  'top_level_effort',
  'injected_system_effort',
  'effective_phase',
  'cache_read_share_pct',
  'thinking_chars',
  'thinking_tokens',
  'stop_reason',
  'session_key'
];

function getExtraSecrets(keys) {
  return [
    keys.OPENROUTER_API_KEY,
    keys.ANTHROPIC_API_KEY,
    keys.GEMINI_BENCHMARK_API_KEY,
    keys.ENV_GEMINI_API_KEY
  ].filter(Boolean);
}

function buildDirectRateCard() {
  const base = loadRateCard();
  const s55 = base['anthropic/claude-sonnet-5.5'] || { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.1 };
  const s46 = base['anthropic/claude-sonnet-4.6'] || { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 };
  return {
    ...base,
    'claude-sonnet-5-5': s55,
    'claude-sonnet-4-6': s46
  };
}

function loadCheckpoints() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return [];
  const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch {}
  }
  return entries;
}

function appendCheckpoint(entry, extraSecrets) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  const s = JSON.stringify(entry);
  assertNoSensitiveLeaks(s, 'r2_checkpoint', extraSecrets);
  fs.appendFileSync(CHECKPOINT_PATH, `${s}\n`, 'utf8');
}

function build15kPrefixText() {
  const parts = [
    loadPinnedCorpusSlice('src/core-isomorphic/economics/billingBlocks.mjs', 1, 250),
    loadPinnedCorpusSlice('src/core-isomorphic/economics/dualTtl.mjs', 1, 250),
    loadPinnedCorpusSlice('src/core-isomorphic/guards/circuitBreakers.mjs', 1, 800),
    loadPinnedCorpusSlice('src/core/parser.mjs', 1, 800),
    loadPinnedCorpusSlice('src/core/quota.mjs', 1, 500)
  ].filter(Boolean);
  let joined = parts.join('\n\n// --- NEXT FILE ---\n\n');
  if (joined.length > 58000) joined = joined.slice(0, 58000);
  return [
    'You are an engineering specialist reviewing telemetry economic guardrails.',
    'Follow user questions directly and concisely.',
    '',
    joined
  ].join('\n');
}

const TWELVE_PROMPTS = [
  '1) State the main purpose of billingBlocks.mjs in 1 concise sentence.',
  '2) Identify one edge case guarded inside dualTtl.mjs in 1 concise sentence.',
  '3) Describe the core trigger condition in circuitBreakers.mjs in 1 concise sentence.',
  '4) Summarize how token attribution handles partial transcript reads in 1 concise sentence.',
  '5) Name one pitfall if cache breakpoints are shifted every turn (1 sentence).',
  // High-effort reasoning turns T6..T7:
  '6) Carefully trace why 5m writes (1.25x) vs 1h writes (2.0x) vs reads (0.1x or 0.05x) cross break-even after k post-gap hits. Derive the exact inequality and verify all boundary integer cases step by step.',
  '7) Suppose a 20k static system block precedes 6k tools vs appending deferred schemas at the tail. Analyze which exact cache levels invalidate at every boundary and prove the per-turn delta formula across T6..T12.',
  '8) Contrast top-level effort mutation vs per-message system output_config in terms of prefix byte hashing (2 sentences).',
  '9) Explain how read-only telemetry stores prevent accidental SQLite lock contention (2 sentences).',
  '10) Identify why deterministic key serialization prevents multi-worker cache thrashing (2 sentences).',
  '11) Summarize why isolating side-call sub-tasks preserves expensive frontier session caches (2 sentences).',
  '12) Give a concise 2-sentence engineering takeaway on mid-conversation effort control.'
];

function computeSharePct(row) {
  return row.prompt_tokens > 0
    ? Number(((row.cache_read_tokens / row.prompt_tokens) * 100).toFixed(2))
    : 0;
}

async function runPrecheck({ sysText, rateCard, budgetTracker, extraSecrets }) {
  const sessionKey = 'R2|PRECHECK|1';
  const nonce = createRepNonce('r2_precheck');
  const rows = [];

  console.log('[R2 Precheck] Testing omitted output_config (null) vs explicit high/medium on claude-sonnet-5-5...');

  // Call 1: omit output_config (null)
  const m1 = [{ role: 'user', content: TWELVE_PROMPTS[0] }];
  const b1 = injectNonceAndBreakpoints({
    nonce,
    system: [{ type: 'text', text: sysText }],
    messages: m1,
    breakpointLayers: ['system', 'messages']
  });
  const r1 = await sendMessagesCall({
    test: 'R2',
    arm: 'PRECHECK',
    rep: 1,
    turn: 1,
    route: 'anthropic_direct',
    model: MODEL_55,
    system: b1.system,
    messages: b1.messages,
    max_tokens: 150,
    stream: true,
    output_config: null,
    anthropicBeta: BETA_HEADER,
    nonceId: nonce,
    customRateCard: rateCard,
    budgetTracker
  });
  rows.push({
    ...r1.row,
    arm_group: 'precheck',
    top_level_effort: 'omitted',
    injected_system_effort: '',
    effective_phase: 'precheck_omitted_prime',
    cache_read_share_pct: computeSharePct(r1.row),
    thinking_chars: r1.thinkingChars,
    session_key: sessionKey
  });

  const a1 = r1.assistantText || 'Billing blocks track API cache windows.';

  // Call 2: probe explicit { effort: 'high' } directly off Call 1's prefix
  const m2 = [
    { role: 'user', content: TWELVE_PROMPTS[0] },
    { role: 'assistant', content: [{ type: 'text', text: a1 }] },
    { role: 'user', content: TWELVE_PROMPTS[5] }
  ];
  const b2 = injectNonceAndBreakpoints({
    nonce,
    system: [{ type: 'text', text: sysText }],
    messages: m2,
    breakpointLayers: ['system', 'messages']
  });
  const r2 = await sendMessagesCall({
    test: 'R2',
    arm: 'PRECHECK',
    rep: 1,
    turn: 2,
    route: 'anthropic_direct',
    model: MODEL_55,
    system: b2.system,
    messages: b2.messages,
    max_tokens: 550,
    stream: true,
    output_config: { effort: 'high' },
    anthropicBeta: BETA_HEADER,
    nonceId: nonce,
    customRateCard: rateCard,
    budgetTracker
  });
  rows.push({
    ...r2.row,
    arm_group: 'precheck',
    top_level_effort: 'high',
    injected_system_effort: '',
    effective_phase: 'precheck_probe_high_vs_omitted',
    cache_read_share_pct: computeSharePct(r2.row),
    thinking_chars: r2.thinkingChars,
    session_key: sessionKey
  });

  // Call 3: probe explicit { effort: 'medium' } directly off Call 1's prefix
  const m3 = [
    { role: 'user', content: TWELVE_PROMPTS[0] },
    { role: 'assistant', content: [{ type: 'text', text: a1 }] },
    { role: 'user', content: TWELVE_PROMPTS[1] }
  ];
  const b3 = injectNonceAndBreakpoints({
    nonce,
    system: [{ type: 'text', text: sysText }],
    messages: m3,
    breakpointLayers: ['system', 'messages']
  });
  const r3 = await sendMessagesCall({
    test: 'R2',
    arm: 'PRECHECK',
    rep: 1,
    turn: 3,
    route: 'anthropic_direct',
    model: MODEL_55,
    system: b3.system,
    messages: b3.messages,
    max_tokens: 180,
    stream: true,
    output_config: { effort: 'medium' },
    anthropicBeta: BETA_HEADER,
    nonceId: nonce,
    customRateCard: rateCard,
    budgetTracker
  });
  rows.push({
    ...r3.row,
    arm_group: 'precheck',
    top_level_effort: 'medium',
    injected_system_effort: '',
    effective_phase: 'precheck_probe_medium_vs_omitted',
    cache_read_share_pct: computeSharePct(r3.row),
    thinking_chars: r3.thinkingChars,
    session_key: sessionKey
  });

  const highHitOmitted = r2.row.http_status === 200 && r2.row.cache_read_tokens >= 10000;
  const medHitOmitted = r3.row.http_status === 200 && r3.row.cache_read_tokens >= 10000;
  const verifiedDefaultEffort = highHitOmitted ? 'high' : (medHitOmitted ? 'medium' : 'high');

  console.log(`[R2 Precheck] probe(high) read=${r2.row.cache_read_tokens} hit=${highHitOmitted} | probe(medium) read=${r3.row.cache_read_tokens} hit=${medHitOmitted} -> verifiedDefaultEffort=${verifiedDefaultEffort}`);

  const entry = {
    sessionKey,
    arm: 'PRECHECK',
    rep: 1,
    aborted: rows.some((r) => r.http_status !== 200),
    rows,
    precheckFindings: {
      verifiedDefaultEffort,
      highMatchedOmittedCache: highHitOmitted,
      mediumMatchedOmittedCache: medHitOmitted,
      probeHighReadTokens: r2.row.cache_read_tokens,
      probeHighWriteTokens: r2.row.cache_write_tokens,
      probeHighOutTokens: r2.row.output_tokens,
      probeMedReadTokens: r3.row.cache_read_tokens,
      probeMedWriteTokens: r3.row.cache_write_tokens,
      probeMedOutTokens: r3.row.output_tokens
    }
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

const ARM_SPECS = [
  { arm: 'EF0', model: MODEL_55, beta: BETA_HEADER, group: '55_mid_effort' },
  { arm: 'EF1', model: MODEL_55, beta: BETA_HEADER, group: '55_mid_effort' },
  { arm: 'EF2', model: MODEL_55, beta: BETA_HEADER, group: '55_mid_effort' },
  { arm: 'EF3', model: MODEL_55, beta: BETA_HEADER, group: '55_mid_effort' },
  { arm: 'EF0_46', model: MODEL_46, beta: null, group: '46_legacy_toggle' },
  { arm: 'EF1_46', model: MODEL_46, beta: null, group: '46_legacy_toggle' }
];

const RERUN_4096_CAP_USD = 1.62;
const RERUN_4096_SPECS = [
  {
    arm: 'R2B_MED',
    label: '(a) top-level medium (control)',
    model: MODEL_55,
    beta: BETA_HEADER,
    group: '55_2t_4096_rerun',
    t2TopEffort: 'medium',
    t2InjectedEffort: ''
  },
  {
    arm: 'R2B_TOP_HIGH',
    label: '(b) top-level high',
    model: MODEL_55,
    beta: BETA_HEADER,
    group: '55_2t_4096_rerun',
    t2TopEffort: 'high',
    t2InjectedEffort: ''
  },
  {
    arm: 'R2B_BETA_HIGH',
    label: '(c) per-message beta high',
    model: MODEL_55,
    beta: BETA_HEADER,
    group: '55_2t_4096_rerun',
    t2TopEffort: 'medium',
    t2InjectedEffort: 'high'
  }
];

function makeR2BRow({ res, spec, topEffort, injectedEffort, phase, sessionKey }) {
  const thinkingTok = typeof res.thinkingTokens === 'number' ? res.thinkingTokens : 0;
  return {
    ...res.row,
    arm_group: spec.group,
    top_level_effort: topEffort,
    injected_system_effort: injectedEffort,
    effective_phase: phase,
    cache_read_share_pct: computeSharePct(res.row),
    thinking_chars: res.thinkingChars,
    thinking_tokens: thinkingTok,
    stop_reason: res.stopReason || '',
    session_key: sessionKey
  };
}

async function runRerun4096Session({ spec, rep, sysText, rateCard, rerunBudgetTracker, extraSecrets }) {
  const sessionKey = `R2|${spec.arm}|${rep}`;
  const nonce = createRepNonce(`r2_${spec.arm}_r${rep}`);
  const rows = [];
  let aborted = false;
  let nonTransient4xx = false;

  console.log(`[R2-4096] Running ${sessionKey} (${spec.label})...`);

  // Turn 1: always top-level effort='medium' on identical ~27.3k prefix
  if (rerunBudgetTracker.runSpentUsd + 0.08 > RERUN_4096_CAP_USD) {
    throw new Error(`R2-4096 cap guard before T1 (${rerunBudgetTracker.runSpentUsd.toFixed(6)} + 0.08 > ${RERUN_4096_CAP_USD})`);
  }
  const m1 = [{ role: 'user', content: TWELVE_PROMPTS[0] }];
  const b1 = injectNonceAndBreakpoints({
    nonce,
    system: [{ type: 'text', text: sysText }],
    messages: m1,
    breakpointLayers: ['system', 'messages']
  });
  const r1 = await sendMessagesCall({
    test: 'R2',
    arm: spec.arm,
    rep,
    turn: 1,
    route: 'anthropic_direct',
    model: spec.model,
    system: b1.system,
    messages: b1.messages,
    max_tokens: 200,
    stream: false,
    output_config: { effort: 'medium' },
    anthropicBeta: spec.beta,
    nonceId: nonce,
    customRateCard: rateCard,
    budgetTracker: rerunBudgetTracker,
    timeoutMs: 180000
  });
  rows.push(makeR2BRow({
    res: r1,
    spec,
    topEffort: 'medium',
    injectedEffort: '',
    phase: 'rerun_t1_prime_medium',
    sessionKey
  }));

  let r2 = null;
  if (r1.row.http_status !== 200) {
    aborted = true;
    nonTransient4xx = r1.row.http_status >= 400 && r1.row.http_status < 500;
    console.error(`[R2-4096] ABORT ${sessionKey} T1: HTTP ${r1.row.http_status} ${r1.row.error_text}`);
  } else {
    // Turn 2: TWELVE_PROMPTS[5] at max_tokens=4096 under arm's effort regime
    if (rerunBudgetTracker.runSpentUsd + 0.045 > RERUN_4096_CAP_USD) {
      throw new Error(`R2-4096 cap guard before T2 (${rerunBudgetTracker.runSpentUsd.toFixed(6)} + 0.045 > ${RERUN_4096_CAP_USD})`);
    }
    const m2 = [
      { role: 'user', content: TWELVE_PROMPTS[0] },
      { role: 'assistant', content: [{ type: 'text', text: r1.assistantText || 'OK.' }] }
    ];
    if (spec.t2InjectedEffort === 'high') {
      m2.push({ role: 'system', content: [], output_config: { effort: 'high' } });
    }
    m2.push({ role: 'user', content: TWELVE_PROMPTS[5] });
    const b2 = injectNonceAndBreakpoints({
      nonce,
      system: [{ type: 'text', text: sysText }],
      messages: m2,
      breakpointLayers: ['system', 'messages']
    });
    const phaseT2 = spec.t2InjectedEffort === 'high'
      ? 'rerun_t2_beta_high'
      : (spec.t2TopEffort === 'high' ? 'rerun_t2_top_high' : 'rerun_t2_control_medium');
    r2 = await sendMessagesCall({
      test: 'R2',
      arm: spec.arm,
      rep,
      turn: 2,
      route: 'anthropic_direct',
      model: spec.model,
      system: b2.system,
      messages: b2.messages,
      max_tokens: 4096,
      stream: false,
      output_config: { effort: spec.t2TopEffort },
      anthropicBeta: spec.beta,
      nonceId: nonce,
      customRateCard: rateCard,
      budgetTracker: rerunBudgetTracker,
      timeoutMs: 180000
    });
    rows.push(makeR2BRow({
      res: r2,
      spec,
      topEffort: spec.t2TopEffort,
      injectedEffort: spec.t2InjectedEffort,
      phase: phaseT2,
      sessionKey
    }));
    if (r2.row.http_status !== 200) {
      aborted = true;
      nonTransient4xx = r2.row.http_status >= 400 && r2.row.http_status < 500;
      console.error(`[R2-4096] ABORT ${sessionKey} T2: HTTP ${r2.row.http_status} ${r2.row.error_text}`);
    }
  }

  const totalCostUsd = Number(rows.reduce((a, r) => a + Number(r.computed_cost_usd || 0), 0).toFixed(6));
  const row1 = rows[0];
  const row2 = rows[1] || null;
  const t1ThinkingTokens = Number(row1?.thinking_tokens || 0);
  const t2ThinkingTokens = Number(row2?.thinking_tokens || 0);
  const t2OutTokens = Number(row2?.output_tokens || 0);
  const t2VisibleOutTokens = Math.max(0, t2OutTokens - t2ThinkingTokens);

  console.log(
    `[R2-4096] Done ${sessionKey}: cost=$${totalCostUsd} T1(w=${row1?.cache_write_tokens},out=${row1?.output_tokens},think=${t1ThinkingTokens}) ` +
    `T2(read=${row2?.cache_read_tokens},share=${row2?.cache_read_share_pct}%,out=${t2OutTokens},think=${t2ThinkingTokens},vis=${t2VisibleOutTokens},stop=${row2?.stop_reason})`
  );

  const entry = {
    sessionKey,
    arm: spec.arm,
    label: spec.label,
    model: spec.model,
    group: spec.group,
    rep,
    aborted,
    nonTransient4xx,
    rows,
    rawUsage: {
      t1: r1.rawUsage || null,
      t2: r2?.rawUsage || null
    },
    metrics: {
      totalComputedCostUsd: totalCostUsd,
      t1WriteTokens: row1?.cache_write_tokens ?? 0,
      t1OutTokens: row1?.output_tokens ?? 0,
      t1ThinkingTokens,
      t2PromptTokens: row2?.prompt_tokens ?? 0,
      t2ReadTokens: row2?.cache_read_tokens ?? 0,
      t2WriteTokens: row2?.cache_write_tokens ?? 0,
      t2ReadSharePct: row2?.cache_read_share_pct ?? 0,
      t2OutTokens,
      t2ThinkingTokens,
      t2VisibleOutTokens,
      t2StopReason: row2?.stop_reason || '',
      t2LatencyMs: row2?.latency_ms ?? 0
    }
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

async function runArmSession({ spec, rep, sysText, rateCard, verifiedDefaultEffort, budgetTracker, extraSecrets }) {
  const sessionKey = `R2|${spec.arm}|${rep}`;
  const nonce = createRepNonce(`r2_${spec.arm}_r${rep}`);
  const messages = [];
  const rows = [];
  let aborted = false;

  console.log(`[R2] Running ${sessionKey} (${spec.model})...`);

  for (let turn = 1; turn <= 12; turn += 1) {
    let topEffort = 'medium'; // null means omit output_config
    let injectedEffort = '';
    let phase = 'medium_control';

    if (spec.arm === 'EF1' || spec.arm === 'EF1_46') {
      if (turn >= 6) {
        topEffort = 'high';
        phase = turn === 6 ? 'top_level_switch_high' : 'top_level_high';
      }
    } else if (spec.arm === 'EF2') {
      topEffort = 'medium';
      if (turn === 6) {
        messages.push({ role: 'system', content: [], output_config: { effort: 'high' } });
        injectedEffort = 'high';
        phase = 'mid_msg_switch_high';
      } else if (turn >= 7) {
        phase = 'mid_msg_post_switch';
      }
    } else if (spec.arm === 'EF3') {
      if (turn < 6) {
        topEffort = null;
        phase = 'omitted_default';
      } else {
        topEffort = verifiedDefaultEffort;
        phase = turn === 6 ? `explicit_default_${verifiedDefaultEffort}` : `post_explicit_${verifiedDefaultEffort}`;
      }
    }

    messages.push({ role: 'user', content: TWELVE_PROMPTS[turn - 1] });
    const built = injectNonceAndBreakpoints({
      nonce,
      system: [{ type: 'text', text: sysText }],
      messages: [...messages],
      breakpointLayers: ['system', 'messages']
    });

    const res = await sendMessagesCall({
      test: 'R2',
      arm: spec.arm,
      rep,
      turn,
      route: 'anthropic_direct',
      model: spec.model,
      system: built.system,
      messages: built.messages,
      max_tokens: (turn === 6 || turn === 7) ? 550 : 180,
      stream: true,
      output_config: topEffort ? { effort: topEffort } : null,
      anthropicBeta: spec.beta,
      nonceId: nonce,
      customRateCard: rateCard,
      budgetTracker
    });

    rows.push({
      ...res.row,
      arm_group: spec.group,
      top_level_effort: topEffort ?? 'omitted',
      injected_system_effort: injectedEffort,
      effective_phase: phase,
      cache_read_share_pct: computeSharePct(res.row),
      thinking_chars: res.thinkingChars,
      session_key: sessionKey
    });

    if (res.row.http_status !== 200) {
      aborted = true;
      console.error(`[R2] ABORT ${sessionKey} T${turn}: HTTP ${res.row.http_status} ${res.row.error_text}`);
      break;
    }

    messages.push({ role: 'assistant', content: [{ type: 'text', text: res.assistantText || 'OK.' }] });
  }

  const totalCostUsd = Number(rows.reduce((a, r) => a + Number(r.computed_cost_usd || 0), 0).toFixed(6));
  const t6 = rows.find((r) => r.turn === 6);
  const t7 = rows.find((r) => r.turn === 7);
  const totalIn = rows.reduce((a, r) => a + r.prompt_tokens, 0);
  const totalRead = rows.reduce((a, r) => a + r.cache_read_tokens, 0);

  console.log(`[R2] Done ${sessionKey}: cost=$${totalCostUsd} (computed) hit=${totalIn ? ((totalRead / totalIn) * 100).toFixed(1) : 0}% T6(read=${t6?.cache_read_tokens},share=${t6?.cache_read_share_pct}%,out=${t6?.output_tokens}) T7(read=${t7?.cache_read_tokens},share=${t7?.cache_read_share_pct}%,out=${t7?.output_tokens})`);

  const entry = {
    sessionKey,
    arm: spec.arm,
    model: spec.model,
    group: spec.group,
    rep,
    aborted,
    rows,
    metrics: {
      totalComputedCostUsd: totalCostUsd,
      overallHitPct: totalIn ? Number(((totalRead / totalIn) * 100).toFixed(2)) : 0,
      t6Read: t6?.cache_read_tokens ?? 0,
      t6Write: t6?.cache_write_tokens ?? 0,
      t6ReadSharePct: t6?.cache_read_share_pct ?? 0,
      t7Read: t7?.cache_read_tokens ?? 0,
      t7Write: t7?.cache_write_tokens ?? 0,
      t7ReadSharePct: t7?.cache_read_share_pct ?? 0,
      t6OutTokens: t6?.output_tokens ?? 0,
      t7OutTokens: t7?.output_tokens ?? 0,
      t6LatencyMs: t6?.latency_ms ?? 0,
      t7LatencyMs: t7?.latency_ms ?? 0,
      t6PlusT7OutTokens: (t6?.output_tokens ?? 0) + (t7?.output_tokens ?? 0)
    }
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

function buildSummary(entries) {
  const precheck = entries.find((e) => e.arm === 'PRECHECK') || null;
  const valid = entries.filter((e) => !e.aborted && e.arm !== 'PRECHECK');
  const arms = {};
  for (const spec of ARM_SPECS) {
    const g = valid.filter((e) => e.arm === spec.arm);
    if (!g.length) continue;
    arms[spec.arm] = {
      n: g.length,
      model: spec.model,
      costSource: 'computed',
      totalComputedCostUsd: summarizeMedianRange(g.map((x) => x.metrics.totalComputedCostUsd)),
      overallCacheHitPct: summarizeMedianRange(g.map((x) => x.metrics.overallHitPct)),
      t6ReadTokens: summarizeMedianRange(g.map((x) => x.metrics.t6Read)),
      t6WriteTokens: summarizeMedianRange(g.map((x) => x.metrics.t6Write)),
      t6CacheReadSharePct: summarizeMedianRange(g.map((x) => x.metrics.t6ReadSharePct)),
      t7ReadTokens: summarizeMedianRange(g.map((x) => x.metrics.t7Read)),
      t7WriteTokens: summarizeMedianRange(g.map((x) => x.metrics.t7Write)),
      t7CacheReadSharePct: summarizeMedianRange(g.map((x) => x.metrics.t7ReadSharePct)),
      t6OutTokens: summarizeMedianRange(g.map((x) => x.metrics.t6OutTokens)),
      t7OutTokens: summarizeMedianRange(g.map((x) => x.metrics.t7OutTokens)),
      t6PlusT7OutTokens: summarizeMedianRange(g.map((x) => x.metrics.t6PlusT7OutTokens)),
      t6LatencyMs: summarizeMedianRange(g.map((x) => x.metrics.t6LatencyMs)),
      t7LatencyMs: summarizeMedianRange(g.map((x) => x.metrics.t7LatencyMs))
    };
  }
  const rerunValid = valid.filter((e) => RERUN_4096_SPECS.some((s) => s.arm === e.arm));
  const rerunAllAttempts = entries.filter((e) => RERUN_4096_SPECS.some((s) => s.arm === e.arm));
  const totalRerunComputedCostUsd = Number(
    rerunAllAttempts
      .reduce((acc, e) => acc + (e.rows || []).reduce((s, r) => s + Number(r.computed_cost_usd || 0), 0), 0)
      .toFixed(6)
  );
  const rerunArms = {};
  for (const spec of RERUN_4096_SPECS) {
    const g = rerunValid.filter((e) => e.arm === spec.arm);
    if (!g.length) continue;
    rerunArms[spec.arm] = {
      arm: spec.arm,
      label: spec.label,
      n: g.length,
      model: spec.model,
      costSource: 'computed',
      t1WriteTokens: summarizeMedianRange(g.map((x) => x.metrics.t1WriteTokens)),
      t1OutTokens: summarizeMedianRange(g.map((x) => x.metrics.t1OutTokens)),
      t1ThinkingTokens: summarizeMedianRange(g.map((x) => x.metrics.t1ThinkingTokens)),
      t2PromptTokens: summarizeMedianRange(g.map((x) => x.metrics.t2PromptTokens)),
      t2ReadTokens: summarizeMedianRange(g.map((x) => x.metrics.t2ReadTokens)),
      t2WriteTokens: summarizeMedianRange(g.map((x) => x.metrics.t2WriteTokens)),
      t2CacheReadSharePct: summarizeMedianRange(g.map((x) => x.metrics.t2ReadSharePct)),
      t2OutTokens: summarizeMedianRange(g.map((x) => x.metrics.t2OutTokens)),
      t2ThinkingTokens: summarizeMedianRange(g.map((x) => x.metrics.t2ThinkingTokens)),
      t2VisibleOutTokens: summarizeMedianRange(g.map((x) => x.metrics.t2VisibleOutTokens)),
      t2LatencyMs: summarizeMedianRange(g.map((x) => x.metrics.t2LatencyMs)),
      sessionComputedCostUsd: summarizeMedianRange(g.map((x) => x.metrics.totalComputedCostUsd)),
      t2StopReasons: g.map((x) => x.metrics.t2StopReason)
    };
  }
  const medR = rerunArms.R2B_MED;
  const cmpPair = (target) => {
    if (!medR || !target) return null;
    const thMed = medR.t2ThinkingTokens.median ?? 0;
    const thTgt = target.t2ThinkingTokens.median ?? 0;
    const outMed = medR.t2OutTokens.median ?? 0;
    const outTgt = target.t2OutTokens.median ?? 0;
    const visMed = medR.t2VisibleOutTokens.median ?? 0;
    const visTgt = target.t2VisibleOutTokens.median ?? 0;
    return {
      thinkingTokensDelta: thTgt - thMed,
      thinkingTokensRatio: thMed > 0 ? Number((thTgt / thMed).toFixed(3)) : null,
      outTokensDelta: outTgt - outMed,
      outTokensRatio: outMed > 0 ? Number((outTgt / outMed).toFixed(3)) : null,
      visibleOutTokensDelta: visTgt - visMed,
      differsFromControl: (thTgt !== thMed) || (outTgt !== outMed)
    };
  };

  return {
    generatedAtUtc: new Date().toISOString(),
    route: 'anthropic_direct (all costs computed from token usage using phase0_rate_card.json)',
    precheck: precheck?.precheckFindings || null,
    arms,
    behavioralRerun4096: {
      capUsd: RERUN_4096_CAP_USD,
      totalRerunComputedCostUsd,
      validSessionsCount: rerunValid.length,
      allT2EndedCleanly: rerunValid.length === RERUN_4096_SPECS.length * REPS.length &&
        rerunValid.every((e) => e.metrics?.t2StopReason === 'end_turn'),
      arms: rerunArms,
      comparisons: {
        topHighVsMed: cmpPair(rerunArms.R2B_TOP_HIGH),
        betaHighVsMed: cmpPair(rerunArms.R2B_BETA_HIGH)
      }
    },
    abortedSessions: entries.filter((e) => e.aborted).map((e) => e.sessionKey)
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const s = build15kPrefixText();
    console.log(`run_r2_effort.mjs self-test PASS (prefixChars=${s.length}, prompts=${TWELVE_PROMPTS.length}).`);
    return;
  }

  const fresh = args.includes('--fresh');
  const keys = loadBenchmarkKeys();
  if (!keys.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required for R2 direct-API suite');
  const extraSecrets = getExtraSecrets(keys);
  const rateCard = buildDirectRateCard();
  const sysText = build15kPrefixText();

  if (fresh && fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
  let checkpoints = loadCheckpoints();
  const doneKeys = new Set(checkpoints.filter((e) => !e.aborted).map((e) => e.sessionKey));

  const budgetTracker = new RunBudgetTracker({
    expectedRunUsd: 1.65,
    multiplier: 3,
    maxRunUsd: 6.0,
    globalCapUsd: 15.0,
    label: 'R2_DirectEffort'
  });

  let precheckEntry = checkpoints.find((e) => e.sessionKey === 'R2|PRECHECK|1' && !e.aborted);
  if (!precheckEntry) {
    precheckEntry = await runPrecheck({ sysText, rateCard, budgetTracker, extraSecrets });
  }
  const verifiedDefaultEffort = precheckEntry?.precheckFindings?.verifiedDefaultEffort || 'high';

  for (const spec of ARM_SPECS) {
    const pendingReps = REPS.filter((rep) => {
      const key = `R2|${spec.arm}|${rep}`;
      if (doneKeys.has(key)) {
        console.log(`[R2] Skipping completed ${key}`);
        return false;
      }
      return true;
    });
    if (pendingReps.length > 0) {
      await Promise.all(
        pendingReps.map((rep) => runArmSession({
          spec,
          rep,
          sysText,
          rateCard,
          verifiedDefaultEffort,
          budgetTracker,
          extraSecrets
        }))
      );
    }
  }

  // Sequential 3-arm x n=3 max_tokens=4096 Direct-API behavioral rerun (strictly capped at $1.62)
  const rerunBudgetTracker = new RunBudgetTracker({
    expectedRunUsd: 0.78,
    multiplier: RERUN_4096_CAP_USD / 0.78,
    maxRunUsd: RERUN_4096_CAP_USD,
    globalCapUsd: RERUN_4096_CAP_USD,
    label: 'R2_Direct4096Rerun'
  });
  const priorRerunSpend = checkpoints
    .filter((e) => RERUN_4096_SPECS.some((s) => s.arm === e.arm))
    .reduce((acc, e) => acc + (e.rows || []).reduce((s, r) => s + Number(r.computed_cost_usd || 0), 0), 0);
  if (priorRerunSpend > 0) {
    rerunBudgetTracker.record(priorRerunSpend);
  }

  for (const spec of RERUN_4096_SPECS) {
    for (const rep of REPS) {
      const key = `R2|${spec.arm}|${rep}`;
      if (doneKeys.has(key)) {
        console.log(`[R2-4096] Skipping completed ${key}`);
        continue;
      }
      let resEntry = await runRerun4096Session({
        spec,
        rep,
        sysText,
        rateCard,
        rerunBudgetTracker,
        extraSecrets
      });
      if (resEntry.aborted) {
        if (resEntry.nonTransient4xx) {
          throw new Error(`Non-transient 4xx on ${key}; halting rerun cleanly without retry.`);
        }
        if (rerunBudgetTracker.runSpentUsd + 0.13 <= RERUN_4096_CAP_USD) {
          console.warn(`[R2-4096] Retrying transient failure once for ${key}...`);
          resEntry = await runRerun4096Session({
            spec,
            rep,
            sysText,
            rateCard,
            rerunBudgetTracker,
            extraSecrets
          });
        }
        if (resEntry.aborted) {
          throw new Error(`Rerun session ${key} failed after retry.`);
        }
      }
    }
  }

  const finalMap = new Map();
  for (const e of loadCheckpoints()) finalMap.set(e.sessionKey, e);
  const allEntries = [...finalMap.values()];
  const allRows = allEntries.filter((e) => !e.aborted).flatMap((e) => e.rows || []);

  writeCsv(CSV_OUT_PATH, R2_CSV_COLUMNS, allRows);
  const summary = buildSummary(allEntries);
  const sStr = JSON.stringify(summary, null, 2);
  assertNoSensitiveLeaks(sStr, 'r2_summary.json', extraSecrets);
  fs.writeFileSync(SUMMARY_OUT_PATH, sStr, 'utf8');

  console.log(`[R2] Complete! Wrote ${allRows.length} rows -> ${CSV_OUT_PATH} (4096-rerun spent=$${rerunBudgetTracker.runSpentUsd.toFixed(6)})`);
  if (summary.abortedSessions.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[R2] Fatal error:', redactSensitiveText(err.stack || err.message));
  process.exit(1);
});
