#!/usr/bin/env node
/**
 * T4: Parallel Cold Start (Item 4 of Cost Optimization Anti-Patterns)
 *
 * Tests whether N concurrent workers launched simultaneously with a shared ~20k-token prefix
 * all pay full cache writes vs. pre-warming with max_tokens:0 (Direct API) or max_tokens:1 (OpenRouter)
 * vs. sequential execution. Includes N=25 scaling for P0 and P1.
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  STANDARD_CSV_COLUMNS,
  RESULTS_DIR,
  createRepNonce,
  injectNonceAndBreakpoints,
  loadPinnedCorpusSlice,
  loadBenchmarkKeys,
  loadRateCard,
  sendMessagesCall,
  RunBudgetTracker,
  summarizeMedianRange,
  writeCsv,
  assertNoSensitiveLeaks
} from './prefix_lab.mjs';

const T4_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'n_workers',
  'request_role',
  'barrier_spread_ms',
  'wrote_prefix',
  'read_prefix',
  'arm_wall_ms',
  'primer_wall_ms'
];

function buildSharedPrefixText() {
  // Calibrated via Direct Anthropic count_tokens -> ~19,801 tokens total with nonce + worker question.
  return [
    '// Reference Corpus Slice 1: src/core/parser.mjs (1..560)',
    loadPinnedCorpusSlice('src/core/parser.mjs', 1, 560),
    '// Reference Corpus Slice 2: src/core/quota.mjs (1..520)',
    loadPinnedCorpusSlice('src/core/quota.mjs', 1, 520),
    '// Reference Corpus Slice 3: src/core/constants.mjs (1..415)',
    loadPinnedCorpusSlice('src/core/constants.mjs', 1, 415)
  ].join('\n\n');
}

function workerPromptForIndex(idx, n) {
  return `Worker W${idx}/${n}: In <= 20 words, name symbol or constant #${idx} visible in the reference code above.`;
}

function buildPayload({ nonce, systemText, userText }) {
  return injectNonceAndBreakpoints({
    nonce,
    tools: [],
    system: [{ type: 'text', text: systemText }],
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    breakpointLayers: ['system'],
    omitMessageBreakpoint: true
  });
}

async function runSingleRep({
  armSpec,
  rep,
  systemText,
  customRateCard,
  extraSecrets
}) {
  const nonceId = createRepNonce(`t4_${armSpec.arm}_r${rep}`);
  const tracker = new RunBudgetTracker({
    expectedRunUsd: armSpec.expectedRunUsd,
    multiplier: 3,
    globalCapUsd: 20,
    label: `${armSpec.arm}_r${rep}`
  });

  const rows = [];
  const tArmStartNs = process.hrtime.bigint();
  let primerWallMs = 0;
  let barrierSpreadMs = 0;

  if (armSpec.primerMaxTokens !== null) {
    const primerPayload = buildPayload({
      nonce: nonceId,
      systemText,
      userText: 'Warm shared prefix. Reply briefly.'
    });
    const tPrimerStart = process.hrtime.bigint();
    const primerRes = await sendMessagesCall({
      test: 'T4',
      arm: armSpec.arm,
      rep,
      turn: 0,
      route: armSpec.route,
      model: armSpec.model,
      system: primerPayload.system,
      tools: primerPayload.tools,
      messages: primerPayload.messages,
      max_tokens: armSpec.primerMaxTokens,
      stream: false,
      nonceId,
      customRateCard,
      budgetTracker: tracker
    });
    primerWallMs = Number((Number(process.hrtime.bigint() - tPrimerStart) / 1e6).toFixed(2));
    const wrotePrefix = primerRes.row.cache_write_tokens >= 15000 ? 1 : 0;
    const readPrefix = primerRes.row.cache_read_tokens >= 15000 ? 1 : 0;
    rows.push({
      ...primerRes.row,
      n_workers: armSpec.nWorkers,
      request_role: 'primer',
      barrier_spread_ms: 0,
      wrote_prefix: wrotePrefix,
      read_prefix: readPrefix,
      arm_wall_ms: 0,
      primer_wall_ms: primerWallMs
    });
    if (primerRes.row.http_status >= 400) {
      return { ok: false, reason: `primer_http_${primerRes.row.http_status}:${primerRes.row.error_text}`, rows };
    }
    if (armSpec.primerMaxTokens === 0 && primerRes.row.output_tokens !== 0) {
      return { ok: false, reason: `primer_output_nonzero:${primerRes.row.output_tokens}`, rows };
    }
  }

  // Assert system prefix byte-equality between primer and worker
  const sampleW1 = buildPayload({
    nonce: nonceId,
    systemText,
    userText: workerPromptForIndex(1, armSpec.nWorkers)
  });
  const samplePrimer = buildPayload({
    nonce: nonceId,
    systemText,
    userText: 'Warm shared prefix. Reply briefly.'
  });
  if (JSON.stringify(sampleW1.system) !== JSON.stringify(samplePrimer.system)) {
    throw new Error('System prefix mismatch between primer and worker');
  }

  let workerResults = [];
  if (armSpec.mode === 'sequential') {
    for (let i = 1; i <= armSpec.nWorkers; i++) {
      const payload = buildPayload({
        nonce: nonceId,
        systemText,
        userText: workerPromptForIndex(i, armSpec.nWorkers)
      });
      const res = await sendMessagesCall({
        test: 'T4',
        arm: armSpec.arm,
        rep,
        turn: i,
        route: armSpec.route,
        model: armSpec.model,
        system: payload.system,
        tools: payload.tools,
        messages: payload.messages,
        max_tokens: 50,
        stream: true,
        nonceId,
        customRateCard,
        budgetTracker: tracker
      });
      workerResults.push({ idx: i, res });
    }
  } else {
    // Barrier release: prepare payloads up front so dispatch happens tightly (< 50 ms).
    const prepared = Array.from({ length: armSpec.nWorkers }, (_, idx) => ({
      idx: idx + 1,
      payload: buildPayload({
        nonce: nonceId,
        systemText,
        userText: workerPromptForIndex(idx + 1, armSpec.nWorkers)
      })
    }));
    let releaseBarrier;
    const gate = new Promise((resolve) => { releaseBarrier = resolve; });
    const dispatchTimesNs = [];
    const promises = prepared.map((item) => (async () => {
      await gate;
      dispatchTimesNs.push(process.hrtime.bigint());
      const res = await sendMessagesCall({
        test: 'T4',
        arm: armSpec.arm,
        rep,
        turn: item.idx,
        route: armSpec.route,
        model: armSpec.model,
        system: item.payload.system,
        tools: item.payload.tools,
        messages: item.payload.messages,
        max_tokens: 50,
        stream: true,
        nonceId,
        customRateCard,
        budgetTracker: tracker
      });
      return { idx: item.idx, res };
    })());

    // Microtask flush then release all workers in one synchronous wave
    await new Promise((r) => setTimeout(r, 15));
    releaseBarrier();
    workerResults = await Promise.all(promises);
    const minDispatch = dispatchTimesNs.reduce((a, b) => (a < b ? a : b));
    const maxDispatch = dispatchTimesNs.reduce((a, b) => (a > b ? a : b));
    const tStarts = workerResults.map((w) => Date.parse(w.res.row.t_start));
    const reqSpreadMs = Math.max(...tStarts) - Math.min(...tStarts);
    const dispatchSpreadMs = Number(maxDispatch - minDispatch) / 1e6;
    barrierSpreadMs = Number(Math.max(reqSpreadMs, dispatchSpreadMs).toFixed(2));
  }

  const armWallMs = Number((Number(process.hrtime.bigint() - tArmStartNs) / 1e6).toFixed(2));
  let anyError = null;
  for (const { res } of workerResults) {
    const wrotePrefix = res.row.cache_write_tokens >= 15000 ? 1 : 0;
    const readPrefix = res.row.cache_read_tokens >= 15000 ? 1 : 0;
    rows.push({
      ...res.row,
      n_workers: armSpec.nWorkers,
      request_role: 'worker',
      barrier_spread_ms: barrierSpreadMs,
      wrote_prefix: wrotePrefix,
      read_prefix: readPrefix,
      arm_wall_ms: armWallMs,
      primer_wall_ms: primerWallMs
    });
    if (res.row.http_status >= 400 && !anyError) {
      anyError = `worker_http_${res.row.http_status}:${res.row.error_text}`;
    }
  }
  // Fill arm_wall_ms on primer row too for convenience
  for (const r of rows) {
    r.arm_wall_ms = armWallMs;
  }

  assertNoSensitiveLeaks(JSON.stringify(rows), `t4_${armSpec.arm}_r${rep}`, extraSecrets);
  if (anyError) {
    return { ok: false, reason: anyError, rows };
  }
  if (armSpec.mode === 'barrier' && barrierSpreadMs > 50) {
    console.warn(`[T4] Warning: ${armSpec.arm} rep ${rep} barrierSpreadMs=${barrierSpreadMs}ms > 50ms`);
  }
  return { ok: true, rows, armWallMs, primerWallMs, barrierSpreadMs };
}

async function main() {
  const keys = loadBenchmarkKeys();
  const extraSecrets = [keys.OPENROUTER_API_KEY, keys.ANTHROPIC_API_KEY, keys.GEMINI_BENCHMARK_API_KEY].filter(Boolean);
  const customRateCard = loadRateCard();
  const systemText = buildSharedPrefixText();

  const arms = [
    { arm: 'P0', nWorkers: 10, reps: 3, mode: 'barrier', primerMaxTokens: null, route: 'openrouter', model: 'anthropic/claude-sonnet-4.6', expectedRunUsd: 0.7590 },
    { arm: 'P1', nWorkers: 10, reps: 3, mode: 'barrier', primerMaxTokens: 0, route: 'anthropic_direct', model: 'claude-sonnet-4-6', expectedRunUsd: 0.1440 },
    { arm: 'P2', nWorkers: 10, reps: 3, mode: 'barrier', primerMaxTokens: 1, route: 'openrouter', model: 'anthropic/claude-sonnet-4.6', expectedRunUsd: 0.1449 },
    { arm: 'P3', nWorkers: 10, reps: 3, mode: 'sequential', primerMaxTokens: null, route: 'openrouter', model: 'anthropic/claude-sonnet-4.6', expectedRunUsd: 0.1380 },
    { arm: 'P0_N25', nWorkers: 25, reps: 1, mode: 'barrier', primerMaxTokens: null, route: 'openrouter', model: 'anthropic/claude-sonnet-4.6', expectedRunUsd: 1.8975 },
    { arm: 'P1_N25', nWorkers: 25, reps: 1, mode: 'barrier', primerMaxTokens: 0, route: 'anthropic_direct', model: 'claude-sonnet-4-6', expectedRunUsd: 0.2475 }
  ];

  const allIncludedRows = [];
  const abortedRuns = [];
  const repMetrics = [];

  for (const armSpec of arms) {
    for (let rep = 1; rep <= armSpec.reps; rep++) {
      let attempt = 0;
      let completed = false;
      while (!completed && attempt < 2) {
        attempt += 1;
        console.log(`[T4] Running ${armSpec.arm} rep=${rep} (N=${armSpec.nWorkers}, route=${armSpec.route}, attempt=${attempt})...`);
        let result;
        try {
          result = await runSingleRep({ armSpec, rep, systemText, customRateCard, extraSecrets });
        } catch (err) {
          result = { ok: false, reason: err.message, rows: [] };
        }
        if (!result.ok) {
          abortedRuns.push({ arm: armSpec.arm, rep, attempt, reason: result.reason });
          console.warn(`[T4] Aborted ${armSpec.arm} rep=${rep} attempt=${attempt}: ${result.reason}`);
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw new Error(`T4 arm ${armSpec.arm} rep=${rep} failed after retry: ${result.reason}`);
        }
        completed = true;
        allIncludedRows.push(...result.rows);

        const workerRows = result.rows.filter((r) => r.request_role === 'worker');
        const primerRows = result.rows.filter((r) => r.request_role === 'primer');
        const workersWrote = workerRows.reduce((s, r) => s + r.wrote_prefix, 0);
        const workersRead = workerRows.reduce((s, r) => s + r.read_prefix, 0);
        const totalWroteAll = result.rows.reduce((s, r) => s + r.wrote_prefix, 0);
        const totalReadAll = result.rows.reduce((s, r) => s + r.read_prefix, 0);
        const billedSum = result.rows.reduce((s, r) => s + (r.billed_cost_usd !== '' ? Number(r.billed_cost_usd) : 0), 0);
        const computedSum = result.rows.reduce((s, r) => s + Number(r.computed_cost_usd || 0), 0);
        const effectiveSum = result.rows.reduce(
          (s, r) => s + (r.cost_source === 'billed' ? Number(r.billed_cost_usd) : Number(r.computed_cost_usd)),
          0
        );
        const metric = {
          arm: armSpec.arm,
          rep,
          route: armSpec.route,
          nWorkers: armSpec.nWorkers,
          primerOutTokens: primerRows[0]?.output_tokens ?? null,
          primerWrote: primerRows[0]?.wrote_prefix ?? 0,
          workersWrote,
          workersRead,
          totalWroteAll,
          totalReadAll,
          barrierSpreadMs: result.barrierSpreadMs,
          primerWallMs: result.primerWallMs,
          armWallMs: result.armWallMs,
          costSource: armSpec.route === 'openrouter' ? 'billed' : 'computed',
          totalCostUsd: Number(effectiveSum.toFixed(6)),
          billedUsd: Number(billedSum.toFixed(6)),
          computedUsd: Number(computedSum.toFixed(6))
        };
        repMetrics.push(metric);
        console.log(
          `[T4] Done ${armSpec.arm} rep=${rep}: totalWrote=${totalWroteAll}, workersRead=${workersRead}/${armSpec.nWorkers}, ` +
          `cost=${metric.costSource}=$${metric.totalCostUsd.toFixed(4)}, wall=${metric.armWallMs}ms, primerWall=${metric.primerWallMs}ms, spread=${metric.barrierSpreadMs}ms`
        );
      }
      // Small cooldown between reps
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const armSummaries = arms.map((armSpec) => {
    const reps = repMetrics.filter((m) => m.arm === armSpec.arm);
    return {
      arm: armSpec.arm,
      route: armSpec.route,
      costSource: armSpec.route === 'openrouter' ? 'billed' : 'computed',
      nWorkers: armSpec.nWorkers,
      n: reps.length,
      workersWrote: summarizeMedianRange(reps.map((r) => r.workersWrote)),
      workersRead: summarizeMedianRange(reps.map((r) => r.workersRead)),
      totalWroteAll: summarizeMedianRange(reps.map((r) => r.totalWroteAll)),
      postPrimerScatterWrites: summarizeMedianRange(reps.map((r) => (armSpec.primerMaxTokens !== null ? r.workersWrote : 0))),
      totalCostUsd: summarizeMedianRange(reps.map((r) => r.totalCostUsd)),
      armWallMs: summarizeMedianRange(reps.map((r) => r.armWallMs)),
      primerWallMs: summarizeMedianRange(reps.map((r) => r.primerWallMs)),
      barrierSpreadMs: summarizeMedianRange(reps.map((r) => r.barrierSpreadMs))
    };
  });

  const csvPath = path.join(RESULTS_DIR, 't4_parallel.csv');
  writeCsv(csvPath, T4_CSV_COLUMNS, allIncludedRows);

  const summaryPath = path.join(RESULTS_DIR, 't4_summary.json');
  const summaryJson = {
    generatedAtUtc: new Date().toISOString(),
    prefixCalibrationNote: 'System block corpus slices: parser.mjs:1-560 + quota.mjs:1-520 + constants.mjs:1-415 (~19.8k tokens)',
    abortedRuns,
    repMetrics,
    armSummaries
  };
  const summaryStr = JSON.stringify(summaryJson, null, 2);
  assertNoSensitiveLeaks(summaryStr, 't4_summary.json', extraSecrets);
  fs.writeFileSync(summaryPath, summaryStr + '\n', 'utf8');

  console.log('\n=== T4 SUMMARY ===');
  for (const s of armSummaries) {
    console.log(
      `${s.arm} (n=${s.n}, N=${s.nWorkers}, ${s.route}, ${s.costSource}): ` +
      `wroteAll=${s.totalWroteAll.median}[${s.totalWroteAll.min}-${s.totalWroteAll.max}], ` +
      `workersRead=${s.workersRead.median}[${s.workersRead.min}-${s.workersRead.max}], ` +
      `cost=$${s.totalCostUsd.median.toFixed(4)}[$${s.totalCostUsd.min.toFixed(4)}-$${s.totalCostUsd.max.toFixed(4)}], ` +
      `wall=${s.armWallMs.median.toFixed(0)}ms`
    );
  }
}

main().catch((err) => {
  console.error('[T4 FATAL]', err);
  process.exit(1);
});
