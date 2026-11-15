/**
 * @file test/helpers/bucket_b_harness.mjs
 * Shared Deterministic Evaluation, Grid-Sweep & Latency SLA Spine for Bucket B Guardrails
 * (`#2`, `#3b`, `#4`, `#5`, `#6`, `#8`, `#9`, `#13`, `#16`, `#17`, `#19`, `#20`).
 *
 * Guarantees:
 * - Zero live LLM calls & zero headless CLI spawns.
 * - Zero outbound network calls enforced via `withNetworkSpy`.
 * - Unified Confusion Matrix (`TP`, `FP`, `TN`, `FN`, Precision, Recall, FPR),
 *   Top-K Recall (`Recall@8`), Structural Fidelity, Token Reduction %, and `p50`/`p95`/`p99` ms.
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { withNetworkSpy } from './e2e_harness.mjs';

/**
 * Computes a percentile from a pre-sorted numeric array.
 *
 * @param {number[]} sorted
 * @param {number} percentile - `0..100`
 * @returns {number}
 */
export function computePercentile(sorted = [], percentile = 50) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, Number(percentile) || 0));
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((clamped / 100) * sorted.length) - 1)
  );
  return Number(sorted[idx].toFixed(3));
}

/**
 * Computes confusion-matrix ratios safely when denominators are zero.
 *
 * @param {{ tp: number, fp: number, tn: number, fn: number }} counts
 */
export function computeConfusionMetrics({ tp = 0, fp = 0, tn = 0, fn = 0 } = {}) {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const falsePositiveRate = fp + tn > 0 ? fp / (fp + tn) : 0;
  const accuracy = tp + fp + tn + fn > 0 ? (tp + tn) / (tp + fp + tn + fn) : 1;
  return {
    tp,
    fp,
    tn,
    fn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    falsePositiveRate: Number(falsePositiveRate.toFixed(4)),
    accuracy: Number(accuracy.toFixed(4))
  };
}

/**
 * Evaluates a dataset with a given parameter config and returns confusion, fidelity, ranking, and latency stats.
 *
 * @param {object} options
 * @param {Array<object>} options.dataset
 * @param {(item: object, params?: object) => any} options.evaluateFn
 * @param {object} [options.params={}]
 * @param {(item: object, output: any) => boolean} [options.verifyFidelityFn]
 */
function runSinglePass({ dataset, evaluateFn, params = {}, verifyFidelityFn = null }) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let falseDenies = 0;

  let rankCases = 0;
  let rankHitsAt8 = 0;
  let rankHitsAt12 = 0;

  let fidelityCases = 0;
  let fidelityPassed = 0;

  const tokenReductionSamples = [];
  const timingsMs = [];
  const itemRecords = [];

  // Warm-up first item once to avoid V8 JIT cold parse skewing micro-benchmarks
  if (dataset.length > 0) {
    evaluateFn(dataset[0], params);
  }

  for (const item of dataset) {
    const t0 = performance.now();
    const out = evaluateFn(item, params);
    const elapsedMs = performance.now() - t0;
    timingsMs.push(elapsedMs);

    const triggered = Boolean(out?.triggered ?? out?.wouldTrigger ?? false);
    const expected = Boolean(item.expectedTrigger);

    if (expected && triggered) tp += 1;
    else if (!expected && triggered) fp += 1;
    else if (!expected && !triggered) tn += 1;
    else if (expected && !triggered) fn += 1;

    const decision = String(out?.decision || out?.wouldDecision || 'allow').toLowerCase();
    if (item.forbidDeny && (decision === 'deny' || decision === 'block')) {
      falseDenies += 1;
    }

    if (Array.isArray(item.expectedTopTargets) && item.expectedTopTargets.length > 0) {
      rankCases += 1;
      const ranked = Array.isArray(out?.rankedPaths) ? out.rankedPaths : [];
      const top8 = new Set(ranked.slice(0, 8));
      const top12 = new Set(ranked.slice(0, 12));
      if (item.expectedTopTargets.every((target) => top8.has(target))) rankHitsAt8 += 1;
      if (item.expectedTopTargets.every((target) => top12.has(target))) rankHitsAt12 += 1;
    }

    if (typeof verifyFidelityFn === 'function' && item.checkFidelity !== false) {
      fidelityCases += 1;
      if (verifyFidelityFn(item, out)) fidelityPassed += 1;
    } else if (typeof out?.fidelityOk === 'boolean' && item.checkFidelity) {
      fidelityCases += 1;
      if (out.fidelityOk) fidelityPassed += 1;
    }

    if (typeof out?.tokenReductionPct === 'number' && Number.isFinite(out.tokenReductionPct)) {
      tokenReductionSamples.push(out.tokenReductionPct);
    }

    itemRecords.push({
      id: item.id || '',
      category: item.category || 'default',
      expected,
      triggered,
      decision,
      elapsedMs: Number(elapsedMs.toFixed(3))
    });
  }

  const sortedMs = [...timingsMs].sort((a, b) => a - b);
  const confusion = computeConfusionMetrics({ tp, fp, tn, fn });
  const recallAt8 = rankCases > 0 ? Number((rankHitsAt8 / rankCases).toFixed(4)) : null;
  const recallAt12 = rankCases > 0 ? Number((rankHitsAt12 / rankCases).toFixed(4)) : null;
  const fidelityRate = fidelityCases > 0 ? Number((fidelityPassed / fidelityCases).toFixed(4)) : null;
  const avgTokenReductionPct =
    tokenReductionSamples.length > 0
      ? Number(
          (
            tokenReductionSamples.reduce((acc, v) => acc + v, 0) / tokenReductionSamples.length
          ).toFixed(2)
        )
      : null;

  return {
    params,
    sampleCount: dataset.length,
    ...confusion,
    falseDenies,
    recallAt8,
    recallAt12,
    fidelityRate,
    avgTokenReductionPct,
    latencyMs: {
      p50: computePercentile(sortedMs, 50),
      p95: computePercentile(sortedMs, 95),
      p99: computePercentile(sortedMs, 99),
      max: sortedMs.length > 0 ? Number(sortedMs[sortedMs.length - 1].toFixed(3)) : 0
    },
    itemRecords
  };
}

/**
 * Checks measured experiment metrics against the guardrail's Section 4 Promotion SLA.
 *
 * @param {object} metrics
 * @param {object} [sla={}]
 * @returns {{ passed: boolean, failedChecks: string[] }}
 */
export function evaluatePromotionSla(metrics, sla = {}) {
  const failedChecks = [];

  if (sla.minPrecision !== undefined && metrics.precision < sla.minPrecision) {
    failedChecks.push(`precision ${metrics.precision} < ${sla.minPrecision}`);
  }
  if (sla.minRecall !== undefined && metrics.recall < sla.minRecall) {
    failedChecks.push(`recall ${metrics.recall} < ${sla.minRecall}`);
  }
  if (sla.maxFpr !== undefined && metrics.falsePositiveRate > sla.maxFpr) {
    failedChecks.push(`FPR ${metrics.falsePositiveRate} > ${sla.maxFpr}`);
  }
  if (sla.zeroFalseDeny && metrics.falseDenies > 0) {
    failedChecks.push(`falseDenies ${metrics.falseDenies} > 0`);
  }
  if (
    sla.minRecallAt8 !== undefined &&
    (metrics.recallAt8 === null || metrics.recallAt8 < sla.minRecallAt8)
  ) {
    failedChecks.push(`recallAt8 ${metrics.recallAt8} < ${sla.minRecallAt8}`);
  }
  if (
    sla.minFidelityRate !== undefined &&
    (metrics.fidelityRate === null || metrics.fidelityRate < sla.minFidelityRate)
  ) {
    failedChecks.push(`fidelityRate ${metrics.fidelityRate} < ${sla.minFidelityRate}`);
  }
  if (
    sla.minTokenReductionPct !== undefined &&
    (metrics.avgTokenReductionPct === null ||
      metrics.avgTokenReductionPct < sla.minTokenReductionPct)
  ) {
    failedChecks.push(
      `avgTokenReductionPct ${metrics.avgTokenReductionPct}% < ${sla.minTokenReductionPct}%`
    );
  }
  if (sla.maxP99Ms !== undefined && metrics.latencyMs.p99 > sla.maxP99Ms) {
    failedChecks.push(`p99 ${metrics.latencyMs.p99}ms > ${sla.maxP99Ms}ms`);
  }

  return {
    passed: failedChecks.length === 0,
    failedChecks
  };
}

/**
 * Runs a complete deterministic Bucket B guardrail experiment (with optional parameter grid sweep)
 * inside `withNetworkSpy` to guarantee zero outbound network egress.
 *
 * @param {object} config
 * @param {string} config.id - e.g. `'#2'`
 * @param {string} config.code - e.g. `'GREP_GLOB_FIREWALL'`
 * @param {'B-Alpha' | 'B-Beta' | 'B-Gamma'} [config.subWave='B-Alpha']
 * @param {Array<object>} config.dataset
 * @param {(item: object, params?: object) => any} config.evaluateFn
 * @param {object} [config.defaultParams={}]
 * @param {Array<object>} [config.sweepGrid]
 * @param {(item: object, output: any) => boolean} [config.verifyFidelityFn]
 * @param {object} [config.sla={}]
 */
export async function runBucketBExperiment(config) {
  const {
    id,
    code,
    subWave = 'B-Alpha',
    dataset = [],
    evaluateFn,
    defaultParams = {},
    sweepGrid = null,
    verifyFidelityFn = null,
    sla = {}
  } = config;

  assert.ok(Array.isArray(dataset) && dataset.length > 0, `${id} ${code}: dataset must be non-empty`);
  assert.equal(typeof evaluateFn, 'function', `${id} ${code}: evaluateFn must be a function`);

  const { result, violations } = await withNetworkSpy(() => {
    if (Array.isArray(sweepGrid) && sweepGrid.length > 0) {
      const sweepResults = sweepGrid.map((candidateParams) => {
        const pass = runSinglePass({
          dataset,
          evaluateFn,
          params: candidateParams,
          verifyFidelityFn
        });
        const gate = evaluatePromotionSla(pass, sla);
        return { ...pass, slaPassed: gate.passed, failedChecks: gate.failedChecks };
      });

      // Prefer SLA-passing candidates with highest recall, then lowest FPR, then lowest p99
      const passing = sweepResults.filter((r) => r.slaPassed);
      const pool = passing.length > 0 ? passing : sweepResults;
      pool.sort((a, b) => {
        if (b.recall !== a.recall) return b.recall - a.recall;
        if (a.falsePositiveRate !== b.falsePositiveRate) {
          return a.falsePositiveRate - b.falsePositiveRate;
        }
        return a.latencyMs.p99 - b.latencyMs.p99;
      });
      const selected = pool[0];
      return {
        selected,
        sweepResults: sweepResults.map(({ itemRecords: _ir, ...summary }) => summary)
      };
    }

    const selectedPass = runSinglePass({
      dataset,
      evaluateFn,
      params: defaultParams,
      verifyFidelityFn
    });
    const gate = evaluatePromotionSla(selectedPass, sla);
    return {
      selected: { ...selectedPass, slaPassed: gate.passed, failedChecks: gate.failedChecks },
      sweepResults: []
    };
  });

  assert.equal(
    violations.length,
    0,
    `${id} ${code} violated zero-outbound-network invariant: ${JSON.stringify(violations)}`
  );

  const selected = result.selected;
  return {
    id,
    code,
    subWave,
    status: selected.slaPassed ? 'PROMOTE_READY' : 'KEEP_SHADOW',
    zeroOutboundNetwork: violations.length === 0,
    sla,
    selectedParams: selected.params,
    sampleCount: selected.sampleCount,
    tp: selected.tp,
    fp: selected.fp,
    tn: selected.tn,
    fn: selected.fn,
    precision: selected.precision,
    recall: selected.recall,
    falsePositiveRate: selected.falsePositiveRate,
    falseDenies: selected.falseDenies,
    recallAt8: selected.recallAt8,
    recallAt12: selected.recallAt12,
    fidelityRate: selected.fidelityRate,
    avgTokenReductionPct: selected.avgTokenReductionPct,
    latencyMs: selected.latencyMs,
    failedChecks: selected.failedChecks,
    sweepResults: result.sweepResults,
    itemRecords: selected.itemRecords
  };
}
