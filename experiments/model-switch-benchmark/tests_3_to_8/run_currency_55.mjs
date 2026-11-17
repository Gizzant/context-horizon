#!/usr/bin/env node
/**
 * Section 9 Optional Currency Check: Claude 5.5 Pair (Opus 5.5 / Sonnet 5.5)
 *
 * Tests whether 4.6 model-switch & effort-switch findings hold under 5.5 pricing
 * (where cache read is 0.05x input instead of 0.10x, raising write/read ratio to 25x!).
 *
 * 3 arms (n=3, 12 turns, ~15k prefix, OpenRouter with live phase0_rate_card.json):
 * - control_55     : anthropic/claude-opus-5.5 pinned all 12 turns (effort='low')
 * - one_switch_55  : anthropic/claude-opus-5.5 (T1..T5) -> anthropic/claude-sonnet-5.5 (T6..T12)
 * - effort_only_55 : anthropic/claude-opus-5.5 all 12 turns (effort low -> high @T6..T7 -> low @T8..T12)
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

const CHECKPOINT_PATH = path.join(RESULTS_DIR, 'raw', 'currency_55_checkpoint_rows.jsonl');
const CSV_OUT_PATH = path.join(RESULTS_DIR, 'currency_55.csv');
const SUMMARY_OUT_PATH = path.join(RESULTS_DIR, 'currency_55_summary.json');

const OPUS_55 = 'anthropic/claude-opus-5.5';
const SONNET_55 = 'anthropic/claude-sonnet-5.5';

const ARMS = ['control_55', 'one_switch_55', 'effort_only_55'];
const REPS = [1, 2, 3];

const CURRENCY_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'effort_setting',
  'switch_event',
  'session_key'
];

const TWELVE_PROMPTS = [
  '1) Summarize the billing block aggregation boundary rule in 2 concise sentences.',
  '2) Describe why dual TTL tracking separates 5m vs 1h writes in 2 concise sentences.',
  '3) Explain how cliff breakers avoid noisy repeated trimming in 2 concise sentences.',
  '4) Summarize how session transcript deltas accumulate total prompt tokens in 2 concise sentences.',
  '5) Identify one invariance requirement for deterministic benchmark runs in 2 concise sentences.',
  '6) Carefully analyze the break-even inequality when cache read drops from 0.10x to 0.05x while write remains 1.25x. State how many warm turns are needed to recoup one switch.',
  '7) Compare keeping an expensive reasoning model pinned vs switching once mid-session when remaining turns vary from 2 to 20.',
  '8) Describe one practical advantage of tail-appending diagnostic observations in 2 sentences.',
  '9) Summarize why effort downgrades affect cost differently across model generations in 2 sentences.',
  '10) Explain why prefix nonces guarantee independent replication trials in 2 sentences.',
  '11) Identify how usage telemetry separates uncached suffix tokens from cached prefix reads in 2 sentences.',
  '12) Conclude with a 2-sentence operational rule of thumb for Claude 5.5 prefix stability.'
];

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
    try { entries.push(JSON.parse(t)); } catch {}
  }
  return entries;
}

function appendCheckpoint(entry, extraSecrets) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  const s = JSON.stringify(entry);
  assertNoSensitiveLeaks(s, 'currency55_checkpoint', extraSecrets);
  fs.appendFileSync(CHECKPOINT_PATH, `${s}\n`, 'utf8');
}

function build15kPrefixText() {
  // Target ~58,000 chars (~15k tokens) of pinned codebase corpus
  const sources = [
    loadPinnedCorpusSlice('src/core-isomorphic/economics/billingBlocks.mjs', 1, 220),
    loadPinnedCorpusSlice('src/core-isomorphic/economics/dualTtl.mjs', 1, 220),
    loadPinnedCorpusSlice('src/core-isomorphic/guards/circuitBreakers.mjs', 1, 600),
    loadPinnedCorpusSlice('src/core/parser.mjs', 1, 450)
  ].filter(Boolean);
  let text = sources.join('\n\n// --- MODULE ---\n\n');
  if (text.length > 58000) text = text.slice(0, 58000);
  return [
    'You are a distributed systems performance engineer reviewing telemetry architecture.',
    'Keep answers crisp and focused.',
    '',
    text
  ].join('\n');
}

async function runOneSession({ arm, rep, sysText, rateCard, budgetTracker, extraSecrets }) {
  const sessionKey = `CURR55|${arm}|${rep}`;
  const nonce = createRepNonce(`c55_${arm}_r${rep}`);
  const messages = [];
  const rows = [];
  let aborted = false;

  console.log(`[5.5 Check] Running ${sessionKey}...`);

  for (let turn = 1; turn <= 12; turn += 1) {
    let model = OPUS_55;
    let effort = 'medium';
    let switchEvent = 'none';

    if (arm === 'one_switch_55' && turn >= 6) {
      model = SONNET_55;
      if (turn === 6) switchEvent = 'model_opus55_to_sonnet55';
    } else if (arm === 'effort_only_55' && turn >= 6) {
      effort = 'high';
      if (turn === 6) switchEvent = 'effort_medium_to_high';
    }

    messages.push({ role: 'user', content: TWELVE_PROMPTS[turn - 1] });
    const built = injectNonceAndBreakpoints({
      nonce,
      system: [{ type: 'text', text: sysText }],
      messages: [...messages],
      breakpointLayers: ['system', 'messages']
    });

    const res = await sendMessagesCall({
      test: 'CURRENCY55',
      arm,
      rep,
      turn,
      route: 'openrouter',
      model,
      system: built.system,
      messages: built.messages,
      max_tokens: 150,
      stream: true,
      output_config: { effort },
      nonceId: nonce,
      customRateCard: rateCard,
      budgetTracker
    });

    rows.push({
      ...res.row,
      effort_setting: effort,
      switch_event: switchEvent,
      session_key: sessionKey
    });

    if (res.row.http_status !== 200) {
      aborted = true;
      console.error(`[5.5 Check] ABORT ${sessionKey} T${turn}: HTTP ${res.row.http_status} ${res.row.error_text}`);
      break;
    }

    messages.push({ role: 'assistant', content: [{ type: 'text', text: res.assistantText || 'Noted.' }] });
  }

  const totalCostUsd = Number(rows.reduce((a, r) => a + (r.billed_cost_usd ?? r.computed_cost_usd ?? 0), 0).toFixed(6));
  const t6 = rows.find((r) => r.turn === 6);
  const t8 = rows.find((r) => r.turn === 8);
  const totalIn = rows.reduce((a, r) => a + r.prompt_tokens, 0);
  const totalRead = rows.reduce((a, r) => a + r.cache_read_tokens, 0);

  console.log(`[5.5 Check] Done ${sessionKey}: cost=$${totalCostUsd} hit=${totalIn ? ((totalRead / totalIn) * 100).toFixed(1) : 0}% T6(read=${t6?.cache_read_tokens},write=${t6?.cache_write_tokens}) T8(read=${t8?.cache_read_tokens},write=${t8?.cache_write_tokens})`);

  const entry = {
    sessionKey,
    arm,
    rep,
    aborted,
    rows,
    metrics: {
      totalCostUsd,
      overallHitPct: totalIn ? Number(((totalRead / totalIn) * 100).toFixed(2)) : 0,
      t6Read: t6?.cache_read_tokens ?? 0,
      t6Write: t6?.cache_write_tokens ?? 0,
      t8Read: t8?.cache_read_tokens ?? 0,
      t8Write: t8?.cache_write_tokens ?? 0,
      t6CostUsd: t6 ? (t6.billed_cost_usd ?? t6.computed_cost_usd) : 0,
      t8CostUsd: t8 ? (t8.billed_cost_usd ?? t8.computed_cost_usd) : 0
    }
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

function buildSummary(entries) {
  const valid = entries.filter((e) => !e.aborted);
  const arms = {};
  for (const arm of ARMS) {
    const g = valid.filter((e) => e.arm === arm);
    if (!g.length) continue;
    arms[arm] = {
      n: g.length,
      totalCostUsd: summarizeMedianRange(g.map((x) => x.metrics.totalCostUsd)),
      overallCacheHitPct: summarizeMedianRange(g.map((x) => x.metrics.overallHitPct)),
      t6Read: summarizeMedianRange(g.map((x) => x.metrics.t6Read)),
      t6Write: summarizeMedianRange(g.map((x) => x.metrics.t6Write)),
      t8Read: summarizeMedianRange(g.map((x) => x.metrics.t8Read)),
      t8Write: summarizeMedianRange(g.map((x) => x.metrics.t8Write)),
      t6CostUsd: summarizeMedianRange(g.map((x) => x.metrics.t6CostUsd)),
      t8CostUsd: summarizeMedianRange(g.map((x) => x.metrics.t8CostUsd))
    };
  }
  const medCtrl = arms.control_55?.totalCostUsd?.median ?? null;
  const medSw = arms.one_switch_55?.totalCostUsd?.median ?? null;
  const medEf = arms.effort_only_55?.totalCostUsd?.median ?? null;

  return {
    generatedAtUtc: new Date().toISOString(),
    pricingSource: 'phase0_rate_card.json (OpenRouter 2026-11-15: Opus 5.5 $4/$20/$5/$0.20, Sonnet 5.5 $2/$10/$2.5/$0.10)',
    arms,
    comparisons: {
      oneSwitchVsControlRatio: medCtrl && medSw ? Number((medSw / medCtrl).toFixed(3)) : null,
      effortOnlyVsControlRatio: medCtrl && medEf ? Number((medEf / medCtrl).toFixed(3)) : null
    },
    abortedSessions: entries.filter((e) => e.aborted).map((e) => e.sessionKey)
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const sys = build15kPrefixText();
    console.log(`run_currency_55.mjs self-test PASS (prefixChars=${sys.length}).`);
    return;
  }

  const fresh = args.includes('--fresh');
  const keys = loadBenchmarkKeys();
  const extraSecrets = getExtraSecrets(keys);
  const rateCard = loadRateCard();
  const sysText = build15kPrefixText();

  if (fresh && fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
  const doneKeys = new Set(loadCheckpoints().filter((e) => !e.aborted).map((e) => e.sessionKey));

  const budgetTracker = new RunBudgetTracker({
    expectedRunUsd: 0.9,
    multiplier: 3,
    maxRunUsd: 3.0,
    globalCapUsd: 10.0,
    label: 'Currency_55'
  });

  for (const arm of ARMS) {
    const pendingReps = REPS.filter((rep) => {
      const key = `CURR55|${arm}|${rep}`;
      if (doneKeys.has(key)) {
        console.log(`[5.5 Check] Skipping completed ${key}`);
        return false;
      }
      return true;
    });
    if (pendingReps.length > 0) {
      await Promise.all(
        pendingReps.map((rep) => runOneSession({ arm, rep, sysText, rateCard, budgetTracker, extraSecrets }))
      );
    }
  }

  const finalMap = new Map();
  for (const e of loadCheckpoints()) finalMap.set(e.sessionKey, e);
  const allEntries = [...finalMap.values()];
  const allRows = allEntries.flatMap((e) => e.rows || []);

  writeCsv(CSV_OUT_PATH, CURRENCY_CSV_COLUMNS, allRows);
  const summary = buildSummary(allEntries);
  const sStr = JSON.stringify(summary, null, 2);
  assertNoSensitiveLeaks(sStr, 'currency_55_summary.json', extraSecrets);
  fs.writeFileSync(SUMMARY_OUT_PATH, sStr, 'utf8');

  console.log(`[5.5 Check] Complete! Wrote ${allRows.length} rows -> ${CSV_OUT_PATH}`);
  if (summary.abortedSessions.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[5.5 Check] Fatal error:', redactSensitiveText(err.stack || err.message));
  process.exit(1);
});
