#!/usr/bin/env node
/**
 * R1: Isolated Side Call Remedy vs Model Ping-Pong (Item 1 Remedy)
 *
 * Tests 3 arms (n=3, 12 turns on OpenRouter, ~7.8k-9.5k short-chat prefix):
 * - M : Opus 4.6 pinned across all 12 turns (handles T7/T9/T11 lookups inside main context)
 * - SW: Ping-Pong in-session switching (Opus 4.6 main, Sonnet 4.6 on T7/T9/T11 -> 6 cache transitions)
 * - SC: Opus 4.6 pinned on main session (9 main turns); on T7/T9/T11 runs ONLY an isolated
 *       <1k-token Sonnet 4.6 side call with the relevant excerpt; main history never sees it!
 *
 * Evaluates deterministic lookup accuracy at T7, T9, T11 across all 3 arms alongside billed USD cost.
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
  wilson95,
  writeCsv,
  assertNoSensitiveLeaks,
  redactSensitiveText
} from './prefix_lab.mjs';

const CHECKPOINT_PATH = path.join(RESULTS_DIR, 'raw', 'r1_checkpoint_rows.jsonl');
const CSV_OUT_PATH = path.join(RESULTS_DIR, 'r1_sidecall.csv');
const SUMMARY_OUT_PATH = path.join(RESULTS_DIR, 'r1_summary.json');

const OPUS_MODEL = 'anthropic/claude-opus-4.6';
const SONNET_MODEL = 'anthropic/claude-sonnet-4.6';

const ARMS = ['M', 'SW', 'SC'];
const REPS = [1, 2, 3];

const R1_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'row_kind',
  'lookup_id',
  'lookup_passed',
  'session_key'
];

const LOOKUP_TASKS = {
  7: {
    id: 'L7_PORT_TOKEN',
    excerpt: [
      'Module Snapshot A (worker_pool_cfg.mjs):',
      'export const DEFAULT_HEARTBEAT_PORT = 44719;',
      'export const BACKUP_HEARTBEAT_PORT = 44721;',
      'export const LEASE_EXPIRY_MS = 18500;'
    ].join('\n'),
    question: 'What exact integer value is assigned to BACKUP_HEARTBEAT_PORT in Module Snapshot A? Reply concisely with the exact integer.',
    check: (txt) => /\b44721\b/.test(String(txt || ''))
  },
  9: {
    id: 'L9_THRESHOLD_MS',
    excerpt: [
      'Module Snapshot B (breaker_thresholds.mjs):',
      'export const WARN_WINDOW_TOKENS = 182400;',
      'export const HARD_AMP_FLOOR_MS = 6340;',
      'export const COOLDOWN_TURNS = 3;'
    ].join('\n'),
    question: 'What exact integer value is assigned to HARD_AMP_FLOOR_MS in Module Snapshot B? Reply concisely with the exact integer.',
    check: (txt) => /\b6340\b/.test(String(txt || ''))
  },
  11: {
    id: 'L11_SENTINEL_CODE',
    excerpt: [
      'Module Snapshot C (fault_codes.mjs):',
      'export const SOFT_BACKOFF_CODE = "WARN_QUEUE_DEPTH";',
      'export const FATAL_SPLIT_CODE = "ERR_LEDGER_DIVERGED_94";',
      'export const IDLE_CODE = "STATUS_QUIET";'
    ].join('\n'),
    question: 'What exact string constant is assigned to FATAL_SPLIT_CODE in Module Snapshot C? Reply concisely with the exact string.',
    check: (txt) => /ERR_LEDGER_DIVERGED_94/.test(String(txt || ''))
  }
};

const MAIN_TURN_PROMPTS = {
  1: 'Read the telemetry economics modules above and identify the key responsibility of billingBlocks.mjs in 2 concise sentences.',
  2: 'Explain in 2 concise sentences how dualTtl.mjs models short vs extended TTL cache lifecycles.',
  3: 'Identify the primary safety invariant enforced inside circuitBreakers.mjs in 2 concise sentences.',
  4: 'Contrast read-only inspection vs stateful mutation hazards across telemetry collectors in 2 sentences.',
  5: 'Summarize in 2 concise sentences why cache write/read asymmetry dominates multi-turn session budgets.',
  6: 'Explain why sudden prefix mutations mid-conversation compound total token expenditure in 2 sentences.',
  8: 'State in 2 concise sentences how keeping a fixed system prefix isolates lookup sub-tasks from invalidating downstream history.',
  10: 'Explain in 2 concise sentences how cooldown turn intervals interact with cache TTL expiration windows.',
  12: 'Synthesize in 2 concise sentences the final architectural guidance for keeping Opus reasoning pinned.'
};

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
  assertNoSensitiveLeaks(s, 'r1_checkpoint', extraSecrets);
  fs.appendFileSync(CHECKPOINT_PATH, `${s}\n`, 'utf8');
}

function build75kSystemPrefix() {
  const parts = [
    loadPinnedCorpusSlice('src/core-isomorphic/economics/billingBlocks.mjs', 1, 250),
    loadPinnedCorpusSlice('src/core-isomorphic/economics/dualTtl.mjs', 1, 250),
    loadPinnedCorpusSlice('src/core-isomorphic/guards/circuitBreakers.mjs', 1, 450),
    loadPinnedCorpusSlice('src/core/parser.mjs', 1, 220)
  ].filter(Boolean);
  let joined = parts.join('\n\n// --- NEXT MODULE ---\n\n');
  if (joined.length > 29000) joined = joined.slice(0, 29000);
  const snapshotsBlock = [
    '// === EMBEDDED CONFIGURATION SNAPSHOTS ===',
    LOOKUP_TASKS[7].excerpt,
    LOOKUP_TASKS[9].excerpt,
    LOOKUP_TASKS[11].excerpt
  ].join('\n\n');
  return [
    'You are an engineering architect analyzing a telemetry and prompt-caching codebase.',
    'Keep every answer concise (under 80 words) and exact.',
    '',
    snapshotsBlock,
    '',
    joined
  ].join('\n');
}

async function runOneSession({ arm, rep, sysText, customRateCard, budgetTracker, extraSecrets }) {
  const sessionKey = `R1|${arm}|${rep}`;
  const nonce = createRepNonce(`r1_${arm}_r${rep}`);
  const rows = [];
  const messages = [];
  let aborted = false;

  console.log(`[R1] Running ${sessionKey}...`);

  for (let turn = 1; turn <= 12; turn += 1) {
    const lookup = LOOKUP_TASKS[turn] || null;

    if (lookup && arm === 'SC') {
      // Standalone <1k Sonnet side call ONLY — main Opus history never sees it!
      const sideRes = await sendMessagesCall({
        test: 'R1',
        arm,
        rep,
        turn,
        route: 'openrouter',
        model: SONNET_MODEL,
        system: [{ type: 'text', text: 'You are a precise code constant extractor. Answer concisely with the exact requested literal.' }],
        messages: [{ role: 'user', content: `${lookup.excerpt}\n\n${lookup.question}` }],
        max_tokens: 60,
        stream: true,
        nonceId: `${nonce}_sc_${turn}`,
        customRateCard,
        budgetTracker
      });
      const sideOk = sideRes.row.http_status === 200 && lookup.check(sideRes.assistantText);
      rows.push({
        ...sideRes.row,
        row_kind: 'side_call',
        lookup_id: lookup.id,
        lookup_passed: sideRes.row.http_status === 200 ? sideOk : false,
        session_key: sessionKey
      });
      if (sideRes.row.http_status !== 200) {
        aborted = true;
        console.error(`[R1] ABORT ${sessionKey} side_call T${turn}: HTTP ${sideRes.row.http_status}`);
        break;
      }
      continue;
    }

    const modelForMain = (arm === 'SW' && lookup) ? SONNET_MODEL : OPUS_MODEL;
    const mainUserPrompt = lookup ? `${lookup.excerpt}\n\n${lookup.question}` : MAIN_TURN_PROMPTS[turn];

    messages.push({ role: 'user', content: mainUserPrompt });
    const built = injectNonceAndBreakpoints({
      nonce,
      tools: [],
      system: [{ type: 'text', text: sysText }],
      messages,
      breakpointLayers: ['system', 'messages'],
      omitMessageBreakpoint: false
    });

    const res = await sendMessagesCall({
      test: 'R1',
      arm,
      rep,
      turn,
      route: 'openrouter',
      model: modelForMain,
      system: built.system,
      messages: built.messages,
      max_tokens: 120,
      stream: true,
      nonceId: nonce,
      customRateCard,
      budgetTracker
    });

    const mainLookupPassed = lookup
      ? (res.row.http_status === 200 && lookup.check(res.assistantText))
      : '';

    rows.push({
      ...res.row,
      row_kind: 'main_turn',
      lookup_id: lookup ? lookup.id : '',
      lookup_passed: lookup ? mainLookupPassed : '',
      session_key: sessionKey
    });

    if (res.row.http_status !== 200) {
      aborted = true;
      console.error(`[R1] ABORT ${sessionKey} main T${turn}: HTTP ${res.row.http_status} ${res.row.error_text}`);
      break;
    }

    messages.push({ role: 'assistant', content: [{ type: 'text', text: res.assistantText || 'Noted.' }] });
  }

  const mainRows = rows.filter((r) => r.row_kind === 'main_turn');
  const sideRows = rows.filter((r) => r.row_kind === 'side_call');
  const lookupEvalRows = arm === 'SC' ? sideRows : mainRows.filter((r) => r.lookup_id);
  const lookupPasses = lookupEvalRows.filter((r) => r.lookup_passed === true).length;
  const totalCostUsd = Number(rows.reduce((a, r) => a + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0).toFixed(6));
  const sideCostUsd = Number(sideRows.reduce((a, r) => a + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0).toFixed(6));
  const totalIn = mainRows.reduce((a, r) => a + r.prompt_tokens, 0);
  const totalRead = mainRows.reduce((a, r) => a + r.cache_read_tokens, 0);

  console.log(`[R1] Done ${sessionKey}: cost=$${totalCostUsd} (side=$${sideCostUsd}, mainTurns=${mainRows.length}, sideCalls=${sideRows.length}) mainHit=${totalIn ? ((totalRead / totalIn) * 100).toFixed(1) : 0}% lookup=${lookupPasses}/${lookupEvalRows.length}`);

  const entry = {
    sessionKey,
    arm,
    rep,
    aborted,
    rows,
    metrics: {
      totalCostUsd,
      sideCallCostUsd: sideCostUsd,
      mainTurnsCount: mainRows.length,
      sideCallsCount: sideRows.length,
      mainHitRatePct: totalIn ? Number(((totalRead / totalIn) * 100).toFixed(2)) : 0,
      lookupPasses,
      lookupTotal: lookupEvalRows.length
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
    const totalPass = g.reduce((a, x) => a + x.metrics.lookupPasses, 0);
    const totalChecks = g.reduce((a, x) => a + x.metrics.lookupTotal, 0);
    arms[arm] = {
      n: g.length,
      totalCostUsd: summarizeMedianRange(g.map((x) => x.metrics.totalCostUsd)),
      sideCallCostUsd: summarizeMedianRange(g.map((x) => x.metrics.sideCallCostUsd)),
      mainCacheHitPct: summarizeMedianRange(g.map((x) => x.metrics.mainHitRatePct)),
      lookupAccuracy: { k: totalPass, n: totalChecks, ...wilson95(totalPass, totalChecks) }
    };
  }
  const medM = arms.M?.totalCostUsd?.median ?? null;
  const medSW = arms.SW?.totalCostUsd?.median ?? null;
  const medSC = arms.SC?.totalCostUsd?.median ?? null;
  return {
    generatedAtUtc: new Date().toISOString(),
    arms,
    comparisons: {
      swVsMMultiplier: medM && medSW ? Number((medSW / medM).toFixed(3)) : null,
      scVsMMultiplier: medM && medSC ? Number((medSC / medM).toFixed(3)) : null,
      scSavingsVsSwPct: medSW && medSC ? Number((((medSW - medSC) / medSW) * 100).toFixed(2)) : null
    },
    abortedSessions: entries.filter((e) => e.aborted).map((e) => e.sessionKey)
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const sys = build75kSystemPrefix();
    for (const t of [7, 9, 11]) {
      const l = LOOKUP_TASKS[t];
      if (!l.check(t === 7 ? '44721' : t === 9 ? '6340' : 'ERR_LEDGER_DIVERGED_94')) {
        throw new Error(`Lookup check failed for ${t}`);
      }
      if (!sys.includes(l.excerpt)) throw new Error(`Prefix missing snapshot ${t}`);
    }
    console.log(`run_r1_sidecall.mjs self-test PASS (sysLen=${sys.length} chars).`);
    return;
  }

  const fresh = args.includes('--fresh');
  const keys = loadBenchmarkKeys();
  const extraSecrets = getExtraSecrets(keys);
  const rateCard = loadRateCard();
  const sysText = build75kSystemPrefix();

  if (fresh && fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
  const doneKeys = new Set(loadCheckpoints().filter((e) => !e.aborted).map((e) => e.sessionKey));

  const budgetTracker = new RunBudgetTracker({
    expectedRunUsd: 1.85,
    multiplier: 3,
    maxRunUsd: 6.0,
    globalCapUsd: 15.0,
    label: 'R1_SideCall'
  });

  for (const arm of ARMS) {
    const pendingReps = REPS.filter((rep) => {
      const key = `R1|${arm}|${rep}`;
      if (doneKeys.has(key)) {
        console.log(`[R1] Skipping completed ${key}`);
        return false;
      }
      return true;
    });
    if (pendingReps.length > 0) {
      await Promise.all(
        pendingReps.map((rep) => runOneSession({ arm, rep, sysText, customRateCard: rateCard, budgetTracker, extraSecrets }))
      );
    }
  }

  const finalMap = new Map();
  for (const e of loadCheckpoints()) finalMap.set(e.sessionKey, e);
  const allEntries = [...finalMap.values()];
  const allRows = allEntries.flatMap((e) => e.rows || []);

  writeCsv(CSV_OUT_PATH, R1_CSV_COLUMNS, allRows);
  const summary = buildSummary(allEntries);
  const sStr = JSON.stringify(summary, null, 2);
  assertNoSensitiveLeaks(sStr, 'r1_summary.json', extraSecrets);
  fs.writeFileSync(SUMMARY_OUT_PATH, sStr, 'utf8');

  console.log(`[R1] Complete! Wrote ${allRows.length} rows -> ${CSV_OUT_PATH}`);
  if (summary.abortedSessions.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[R1] Fatal error:', redactSensitiveText(err.stack || err.message));
  process.exit(1);
});
