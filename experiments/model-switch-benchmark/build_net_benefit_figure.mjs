#!/usr/bin/env node
/**
 * Zero-spend ($0) generator for:
 *   1. Canonical Round 2 C2 dataset promotion (Item 1) + archive notices on superseded Phase 2 files
 *   2. Exact net switch benefit sweep dataset (`net_switch_benefit_dataset.csv`) & crossovers (`net_switch_benefit_crossovers.csv`) (Item 5)
 *   3. Tufte small-multiples SVG chart (`chart_net_switch_benefit.svg`) overlaying computed curves and Phase 1 measured paired points (Item 5)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { computeBreakEvenCachedTokens } from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import { shrinkRollingRequestsPerTurn } from '../../src/utils/sessionCalibration.mjs';
import { runStopGateHook } from '../../hooks/handlers/stop-gate.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import { activateLocalTrial } from '../../src/core/pro_license.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUND2_DIR = path.join(__dirname, 'results', 'round2_c2');
const RULE_V1_DIR = path.join(ROUND2_DIR, 'rule_v1');
const RULE_V2_DIR = path.join(ROUND2_DIR, 'rule_v2');
const CALIBRATED_DIR = path.join(ROUND2_DIR, 'rule_v2_calibrated');

const ARCHIVE_BANNER =
  '> **DO NOT PUBLISH (SUPERSEDED PHASE 2 DATA):** The uncalibrated `rule_v2` CSVs in this folder used default `1,500`-token output assumptions, unscaled single-request read savings, and uncalibrated hook inputs. Always publish from the promoted calibrated files in `../runs_round2_c2_calibrated.csv`, `../interceptions_round2_c2_calibrated.csv`, and `../PUBLICATION_TABLES_ROUND2.md`.\n\n';

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[,"\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsvRows(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return { header: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };

  const header = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const cols = parseLine(lines[i]);
    const rec = {};
    for (let j = 0; j < header.length; j += 1) {
      rec[header[j]] = cols[j] ?? '';
    }
    rows.push(rec);
  }
  return { header, rows };
}

function medianStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const median =
    n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    n,
    median: Number(median.toFixed(6)),
    min: Number(sorted[0].toFixed(6)),
    max: Number(sorted[n - 1].toFixed(6))
  };
}

function computeMeasuredPhase1SwitchPoints() {
  const csvPath = path.join(RULE_V1_DIR, 'runs_round2_c2.csv');
  const { rows } = parseCsvRows(fs.readFileSync(csvPath, 'utf8'));

  const runTotals = new Map();
  const postSwitchTotals = new Map();
  const switchTurnTotals = new Map();
  const switchContextAtTurn = new Map();
  const postSwitchContextList = new Map();
  const perRunPostT4Growth = [];
  const runTurnContexts = new Map();
  const postT4Writes = [];

  for (const row of rows) {
    if (row.is_side_call === 'true') continue;
    const arm = row.arm;
    const rep = Number(row.rep);
    const turn = Number(row.turn);
    const notes = row.notes || '';
    const isHold = !notes.includes('condition=baseline_off');
    const cond = isHold ? 'hold' : 'off';
    const key = `${arm}::${rep}::${cond}`;
    const cost = Number(row.cost_usd || 0);
    runTotals.set(key, (runTotals.get(key) || 0) + cost);

    const ctxTok =
      Number(row.input_tokens || 0) +
      Number(row.cache_creation_input_tokens || 0) +
      Number(row.cache_read_input_tokens || 0);
    if (!runTurnContexts.has(key)) runTurnContexts.set(key, new Map());
    runTurnContexts.get(key).set(turn, ctxTok);
    if (turn >= 5 && turn <= 30) {
      postT4Writes.push(Number(row.cache_creation_input_tokens || 0));
    }

    const swT = arm === 'L1' ? 3 : arm === 'L2' ? 24 : 999;
    if (turn === swT) {
      switchTurnTotals.set(key, (switchTurnTotals.get(key) || 0) + cost);
      if (Number(row.request_index_in_turn) === 1 && row.event === 'model_switch') {
        switchContextAtTurn.set(key, Number(row.cache_creation_input_tokens || 0));
      }
    }
    if (turn > swT) {
      postSwitchTotals.set(key, (postSwitchTotals.get(key) || 0) + cost);
      if (!postSwitchContextList.has(key)) postSwitchContextList.set(key, []);
      postSwitchContextList.get(key).push(Number(row.cache_read_input_tokens || 0));
    }
  }

  for (const [, tMap] of runTurnContexts.entries()) {
    const t4 = tMap.get(4);
    const t30 = tMap.get(30);
    if (t4 > 0 && t30 > t4) {
      perRunPostT4Growth.push((t30 - t4) / 26);
    }
  }
  const growthSlopeStats = medianStats(perRunPostT4Growth);
  const measuredGrowthPerTurn = Math.round(growthSlopeStats.median);

  const summarizeArm = (arm, postSwitchTurns, swTurn) => {
    const netBenefits = [];
    const penalties = [];
    const postSavings = [];
    const avgContexts = [];
    for (const rep of [1, 2, 3]) {
      const holdCost = runTotals.get(`${arm}::${rep}::hold`);
      const offCost = runTotals.get(`${arm}::${rep}::off`);
      netBenefits.push(holdCost - offCost);

      const holdSw = switchTurnTotals.get(`${arm}::${rep}::hold`);
      const offSw = switchTurnTotals.get(`${arm}::${rep}::off`);
      penalties.push(offSw - holdSw);

      const holdPost = postSwitchTotals.get(`${arm}::${rep}::hold`);
      const offPost = postSwitchTotals.get(`${arm}::${rep}::off`);
      postSavings.push((holdPost - offPost) / postSwitchTurns);

      const postReads = postSwitchContextList.get(`${arm}::${rep}::off`) || [];
      if (postReads.length > 0) {
        avgContexts.push(postReads.reduce((a, b) => a + b, 0) / postReads.length);
      }
    }
    const netStats = medianStats(netBenefits);
    const penStats = medianStats(penalties);
    const savStats = medianStats(postSavings);
    const ctxStats = medianStats(
      [1, 2, 3].map((rep) => switchContextAtTurn.get(`${arm}::${rep}::off`))
    );
    const avgCtxStats = medianStats(avgContexts);
    const paybackTurns = Number((penStats.median / savStats.median).toFixed(2));
    return {
      arm,
      switchTurn: swTurn,
      postSwitchTurns,
      netBenefitStats: netStats,
      penaltyMedian: penStats.median,
      perTurnSavingMedian: savStats.median,
      paybackMeasured: paybackTurns,
      paybackWarmRequestsMeasured: paybackTurns,
      switchContextMedian: Math.round(ctxStats.median),
      avgPostSwitchContextMedian: Math.round(avgCtxStats.median),
      measuredGrowthPerTurn
    };
  };

  return {
    measuredGrowthPerTurn,
    growthSlopeStats,
    postT4WriteMedian: medianStats(postT4Writes).median,
    L1: summarizeArm('L1', 27, 3),
    L2: summarizeArm('L2', 6, 24)
  };
}

function promoteCanonicalFilesAndWarnLegacy() {
  for (const fname of ['summary_round2_c2.md', 'manifest_round2_c2.md']) {
    const fpath = path.join(RULE_V2_DIR, fname);
    const text = fs.readFileSync(fpath, 'utf8');
    if (!text.startsWith('> **DO NOT PUBLISH')) {
      fs.writeFileSync(fpath, ARCHIVE_BANNER + text, 'utf8');
    }
  }

  fs.copyFileSync(
    path.join(CALIBRATED_DIR, 'runs_round2_c2.csv'),
    path.join(ROUND2_DIR, 'runs_round2_c2_calibrated.csv')
  );
  fs.copyFileSync(
    path.join(CALIBRATED_DIR, 'interceptions_round2_c2.csv'),
    path.join(ROUND2_DIR, 'interceptions_round2_c2_calibrated.csv')
  );

  const phases = [
    { phase: 'phase1_rule_v1_baseline', file: path.join(RULE_V1_DIR, 'runs_round2_c2.csv') },
    { phase: 'phase2_uncalibrated_superseded', file: path.join(RULE_V2_DIR, 'runs_round2_c2.csv') },
    { phase: 'phase2_calibrated', file: path.join(CALIBRATED_DIR, 'runs_round2_c2.csv') }
  ];
  const combinedLines = [];
  let wroteHeader = false;
  for (const entry of phases) {
    const lines = fs.readFileSync(entry.file, 'utf8').trim().split(/\r?\n/);
    if (!wroteHeader) {
      combinedLines.push(`phase,${lines[0]}`);
      wroteHeader = true;
    }
    for (let i = 1; i < lines.length; i += 1) {
      combinedLines.push(`${entry.phase},${lines[i]}`);
    }
  }
  fs.writeFileSync(
    path.join(ROUND2_DIR, 'runs_round2_c2_all_phases.csv'),
    combinedLines.join('\n') + '\n',
    'utf8'
  );
}

function buildSweepDatasetAndCrossovers(measuredPoints, primaryGrowthPerTurn) {
  const contexts = [12_000, 19_000, 50_000, 100_000];
  const outputs = [150, 400, 1500];
  const rpts = [1, 5];
  const tiers = ['5m', '1h'];
  const growthRegimes = Array.from(new Set([primaryGrowthPerTurn, 0]));
  const maxH = 35;

  const datasetHeader = [
    'provenance',
    'model_pair',
    'cache_ttl_tier',
    'requests_per_turn',
    'context_tokens',
    'context_growth_per_turn',
    'output_tokens_per_turn',
    'turns_remaining_post_switch',
    'net_benefit_usd',
    'net_benefit_min_usd',
    'net_benefit_max_usd',
    'sample_n',
    'switch_turn_penalty_usd',
    'per_turn_saving_usd',
    'payback_post_switch_warm_requests',
    'payback_turns',
    'is_first_net_positive_turn',
    'horizon_c_max_tokens',
    'notes'
  ];

  const crossoverHeader = [
    'provenance',
    'model_pair',
    'cache_ttl_tier',
    'requests_per_turn',
    'context_tokens',
    'context_growth_per_turn',
    'output_tokens_per_turn',
    'switch_turn_penalty_usd',
    'per_turn_saving_usd',
    'payback_post_switch_warm_requests',
    'asymptotic_warm_requests_ab',
    'exact_crossover_turns',
    'first_net_positive_integer_turn',
    'net_benefit_h0_usd',
    'net_benefit_h6_usd',
    'net_benefit_h27_usd',
    'net_benefit_h35_usd',
    'c_max_at_h6_tokens',
    'c_max_at_h27_tokens'
  ];

  const datasetRows = [datasetHeader.join(',')];
  const crossoverRows = [crossoverHeader.join(',')];
  const curves = [];

  for (const g of growthRegimes) {
    for (const tier of tiers) {
      for (const rpt of rpts) {
        for (const ctx of contexts) {
          for (const out of outputs) {
            const pts = [];
            let firstPositiveH = null;
            let summaryRes = null;
            for (let h = 0; h <= maxH; h += 1) {
              const res = computeBreakEvenCachedTokens({
                currentModel: 'claude-opus-4-6',
                targetModel: 'claude-sonnet-4-6',
                cachedTokens: ctx,
                uncachedDeltaTokens: 0,
                postSwitchDeltaTokens: g > 0 ? g : 0,
                contextGrowthPerTurn: g,
                expectedOutputTokens: out,
                cacheWarm: true,
                cacheTtlTier: tier,
                requestsPerTurn: rpt,
                expectedRemainingTurns: h
              });
              if (h === 0) summaryRes = res;
              const net = res.horizonNetSavingsUSD;
              const isFirstPos = firstPositiveH === null && net >= 0;
              if (isFirstPos) firstPositiveH = h;
              pts.push({ h, net, cMax: res.horizonMaxCachedTokens });
              datasetRows.push(
                [
                  'computed',
                  'claude-opus-4-6->claude-sonnet-4-6',
                  tier,
                  rpt,
                  ctx,
                  g,
                  out,
                  h,
                  net.toFixed(6),
                  '',
                  '',
                  '',
                  res.coldWritePenaltyUSD.toFixed(6),
                  res.averagePostSwitchSavingUSD.toFixed(6),
                  Number.isFinite(res.paybackWarmRequests)
                    ? res.paybackWarmRequests.toFixed(2)
                    : 'Infinity',
                  Number.isFinite(res.paybackTurns) ? res.paybackTurns.toFixed(4) : 'Infinity',
                  isFirstPos ? 'true' : 'false',
                  Number.isFinite(res.horizonMaxCachedTokens)
                    ? res.horizonMaxCachedTokens
                    : 'Infinity',
                  ''
                ]
                  .map(csvEscape)
                  .join(',')
              );
            }

            const resH6 = computeBreakEvenCachedTokens({
              currentModel: 'claude-opus-4-6',
              targetModel: 'claude-sonnet-4-6',
              cachedTokens: ctx,
              uncachedDeltaTokens: 0,
              postSwitchDeltaTokens: g > 0 ? g : 0,
              contextGrowthPerTurn: g,
              expectedOutputTokens: out,
              cacheWarm: true,
              cacheTtlTier: tier,
              requestsPerTurn: rpt,
              expectedRemainingTurns: 6
            });
            const resH27 = computeBreakEvenCachedTokens({
              currentModel: 'claude-opus-4-6',
              targetModel: 'claude-sonnet-4-6',
              cachedTokens: ctx,
              uncachedDeltaTokens: 0,
              postSwitchDeltaTokens: g > 0 ? g : 0,
              contextGrowthPerTurn: g,
              expectedOutputTokens: out,
              cacheWarm: true,
              cacheTtlTier: tier,
              requestsPerTurn: rpt,
              expectedRemainingTurns: 27
            });

            const payback = summaryRes.paybackTurns;
            const exactCross = Number.isFinite(payback) ? payback.toFixed(4) : 'Infinity';
            crossoverRows.push(
              [
                'computed',
                'claude-opus-4-6->claude-sonnet-4-6',
                tier,
                rpt,
                ctx,
                g,
                out,
                summaryRes.coldWritePenaltyUSD.toFixed(6),
                summaryRes.perTurnPostSwitchSavingUSD.toFixed(6),
                Number.isFinite(summaryRes.paybackWarmRequests)
                  ? summaryRes.paybackWarmRequests.toFixed(2)
                  : 'Infinity',
                summaryRes.asymptoticWarmRequestRatio ?? '',
                exactCross,
                firstPositiveH !== null ? firstPositiveH : '>35',
                pts[0].net.toFixed(6),
                pts[6].net.toFixed(6),
                pts[27].net.toFixed(6),
                pts[35].net.toFixed(6),
                Number.isFinite(resH6.horizonMaxCachedTokens) ? resH6.horizonMaxCachedTokens : 'Infinity',
                Number.isFinite(resH27.horizonMaxCachedTokens) ? resH27.horizonMaxCachedTokens : 'Infinity'
              ]
                .map(csvEscape)
                .join(',')
            );

            if (g === primaryGrowthPerTurn) {
              curves.push({
                tier,
                rpt,
                ctx,
                out,
                g,
                penalty: summaryRes.coldWritePenaltyUSD,
                saving: summaryRes.perTurnPostSwitchSavingUSD,
                payback,
                pts
              });
            }
          }
        }
      }
    }
  }

  for (const m of [measuredPoints.L1, measuredPoints.L2]) {
    const mismatchNote =
      m.arm === 'L1'
        ? `Matches (5m, R=1 post-switch, g~${m.measuredGrowthPerTurn} tok/turn) panel only; minor residual mismatch: T3 executed 1 Read (R_T3=2), avg post-switch context ~${m.avgPostSwitchContextMedian}, post-switch output ~181 vs 150 grid`
        : `Matches (5m, R=1, g~${m.measuredGrowthPerTurn} tok/turn) panel only; minor residual mismatch: avg post-switch context ~${m.avgPostSwitchContextMedian}, post-switch output ~182 vs 150 grid`;
    datasetRows.push(
      [
        'measured',
        'anthropic/claude-opus-4.6->anthropic/claude-sonnet-4.6',
        '5m',
        1,
        m.switchContextMedian,
        m.measuredGrowthPerTurn,
        m.arm === 'L1' ? 181 : 182,
        m.postSwitchTurns,
        m.netBenefitStats.median.toFixed(6),
        m.netBenefitStats.min.toFixed(6),
        m.netBenefitStats.max.toFixed(6),
        m.netBenefitStats.n,
        m.penaltyMedian.toFixed(6),
        m.perTurnSavingMedian.toFixed(6),
        m.paybackWarmRequestsMeasured,
        m.paybackMeasured,
        'false',
        '',
        `Phase 1 paired live runs (${m.arm}: n=${m.netBenefitStats.n}, swT=${m.switchTurn}). ${mismatchNote}`
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  fs.writeFileSync(
    path.join(ROUND2_DIR, 'net_switch_benefit_dataset.csv'),
    datasetRows.join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(ROUND2_DIR, 'net_switch_benefit_crossovers.csv'),
    crossoverRows.join('\n') + '\n',
    'utf8'
  );

  return {
    curves,
    computedRows: datasetRows.length - 3,
    measuredRows: 2,
    totalDatasetRows: datasetRows.length - 1,
    crossoverRows: crossoverRows.length - 1
  };
}

function buildTufteSvgChart(curves, measuredPoints) {
  // 4 rows (5m R=1, 5m R=5, 1h R=1, 1h R=5) x 3 cols (O=150, O=400, O=1500)
  const rows = [
    { tier: '5m', rpt: 1, label: '5m TTL, R = 1 req/turn', yMin: -0.36, yMax: 0.25 },
    { tier: '5m', rpt: 5, label: '5m TTL, R = 5 req/turn', yMin: -0.36, yMax: 0.90 },
    { tier: '1h', rpt: 1, label: '1h TTL, R = 1 req/turn', yMin: -0.58, yMax: 0.25 },
    { tier: '1h', rpt: 5, label: '1h TTL, R = 5 req/turn', yMin: -0.58, yMax: 0.90 }
  ];
  const cols = [
    { out: 150, label: 'O = 150 tok/turn (Sparse Q&A)' },
    { out: 400, label: 'O = 400 tok/turn (Mixed Analysis)' },
    { out: 1500, label: 'O = 1,500 tok/turn (Heavy Codegen)' }
  ];
  const ctxColors = {
    12000: '#1b6ca8',
    19000: '#2a9d8f',
    50000: '#e76f51',
    100000: '#6d2e46'
  };

  const W = 1080;
  const H = 960;
  const marginL = 82;
  const marginT = 92;
  const colW = 295;
  const rowH = 190;
  const gapX = 36;
  const gapY = 44;
  const pW = colW;
  const pH = rowH;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<style>`,
    `  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; fill: #1f2937; }`,
    `  .title { font-size: 16px; font-weight: 700; }`,
    `  .sub { font-size: 11px; fill: #4b5563; }`,
    `  .panel-title { font-size: 11px; font-weight: 600; fill: #111827; }`,
    `  .axis-lbl { font-size: 9.5px; fill: #4b5563; font-variant-numeric: tabular-nums; }`,
    `  .annot { font-size: 9px; font-weight: 600; font-variant-numeric: tabular-nums; }`,
    `</style>`,
    `<text x="${marginL}" y="28" class="title">Opus 4.6 -&gt; Sonnet 4.6 Net Switch Benefit vs. Post-Switch Horizon (Growing Context + Matched Overlay)</text>`,
    `<text x="${marginL}" y="46" class="sub">Solid lines = computed net savings at measured growth g = ${measuredPoints.measuredGrowthPerTurn} tok/turn (C_0 = 12k, 19k, 50k, 100k); dots mark Net = $0.00. Measured diamonds plotted ONLY on matching (5m, R=1, O=150) panel.</text>`,
    `<g transform="translate(${marginL}, 64)">`,
    `  <line x1="0" y1="0" x2="18" y2="0" stroke="#1b6ca8" stroke-width="2"/><text x="23" y="4" class="axis-lbl">C = 12k</text>`,
    `  <line x1="85" y1="0" x2="103" y2="0" stroke="#2a9d8f" stroke-width="2"/><text x="108" y="4" class="axis-lbl">C = 19k</text>`,
    `  <line x1="170" y1="0" x2="188" y2="0" stroke="#e76f51" stroke-width="2"/><text x="193" y="4" class="axis-lbl">C = 50k</text>`,
    `  <line x1="255" y1="0" x2="273" y2="0" stroke="#6d2e46" stroke-width="2"/><text x="278" y="4" class="axis-lbl">C = 100k</text>`,
    `  <circle cx="352" cy="0" r="3.5" fill="#111827"/><text x="360" y="4" class="axis-lbl">Crossover (Net = $0)</text>`,
    `  <polygon points="485,-4.5 489.5,0 485,4.5 480.5,0" fill="#111827" stroke="#ffffff" stroke-width="1"/><text x="494" y="4" class="axis-lbl">Measured Phase 1 median &amp; min-max range (L1 @ 27t, L2 @ 6t, n=3)</text>`,
    `</g>`
  ];

  rows.forEach((rowDef, rIdx) => {
    cols.forEach((colDef, cIdx) => {
      const x0 = marginL + cIdx * (pW + gapX);
      const y0 = marginT + rIdx * (pH + gapY);
      const xMap = (h) => x0 + (h / 35) * pW;
      const yMap = (usd) => {
        const clamped = Math.max(rowDef.yMin, Math.min(rowDef.yMax, usd));
        return y0 + pH - ((clamped - rowDef.yMin) / (rowDef.yMax - rowDef.yMin)) * pH;
      };
      const zeroY = yMap(0);

      lines.push(`<g>`);
      if (rIdx === 0) {
        lines.push(`<text x="${x0}" y="${y0 - 16}" class="panel-title">${esc(colDef.label)}</text>`);
      }
      if (cIdx === 0) {
        lines.push(`<text x="${x0}" y="${y0 - 4}" class="axis-lbl">${esc(rowDef.label)}</text>`);
      }

      // Subtle zero break-even line and baseline axes (Tufte minimal frame)
      lines.push(`<line x1="${x0}" y1="${zeroY.toFixed(1)}" x2="${x0 + pW}" y2="${zeroY.toFixed(1)}" stroke="#9ca3af" stroke-dasharray="3,3" stroke-width="1"/>`);
      lines.push(`<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + pH}" stroke="#d1d5db" stroke-width="1"/>`);
      lines.push(`<line x1="${x0}" y1="${y0 + pH}" x2="${x0 + pW}" y2="${y0 + pH}" stroke="#d1d5db" stroke-width="1"/>`);

      // Y ticks
      const ticksY = [rowDef.yMin, 0, rowDef.yMax];
      for (const ty of ticksY) {
        const yy = yMap(ty);
        lines.push(`<line x1="${x0 - 3}" y1="${yy.toFixed(1)}" x2="${x0}" y2="${yy.toFixed(1)}" stroke="#9ca3af" stroke-width="1"/>`);
        if (cIdx === 0) {
          const sign = ty > 0 ? '+$' : ty < 0 ? '-$' : '$';
          lines.push(`<text x="${x0 - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" class="axis-lbl">${sign}${Math.abs(ty).toFixed(2)}</text>`);
        }
      }

      // X ticks
      for (const tx of [0, 6, 15, 27, 35]) {
        const xx = xMap(tx);
        lines.push(`<line x1="${xx.toFixed(1)}" y1="${y0 + pH}" x2="${xx.toFixed(1)}" y2="${y0 + pH + 3}" stroke="#9ca3af" stroke-width="1"/>`);
        if (rIdx === rows.length - 1) {
          lines.push(`<text x="${xx.toFixed(1)}" y="${y0 + pH + 13}" text-anchor="middle" class="axis-lbl">${tx}</text>`);
        }
      }

      // Plot computed curves for the 4 context sizes
      const panelCurves = curves.filter(
        (c) => c.tier === rowDef.tier && c.rpt === rowDef.rpt && c.out === colDef.out
      );
      for (const curve of panelCurves) {
        const color = ctxColors[curve.ctx];
        const polyPts = curve.pts
          .map((p) => `${xMap(p.h).toFixed(1)},${yMap(p.net).toFixed(1)}`)
          .join(' ');
        lines.push(`<polyline fill="none" stroke="${color}" stroke-width="1.6" points="${polyPts}"/>`);

        if (Number.isFinite(curve.payback) && curve.payback >= 0 && curve.payback <= 35) {
          const cx = xMap(curve.payback);
          lines.push(`<circle cx="${cx.toFixed(1)}" cy="${zeroY.toFixed(1)}" r="2.8" fill="${color}" stroke="#ffffff" stroke-width="0.8"/>`);
        }
      }

      // Overlay measured Phase 1 paired points on Panel (5m, R=1, O=150) where empirical output ~181 tok/t and post-switch R=1
      if (rowDef.tier === '5m' && rowDef.rpt === 1 && colDef.out === 150) {
        for (const m of [measuredPoints.L2, measuredPoints.L1]) {
          const mx = xMap(m.postSwitchTurns);
          const myMed = yMap(m.netBenefitStats.median);
          const myMin = yMap(m.netBenefitStats.min);
          const myMax = yMap(m.netBenefitStats.max);
          const mColor = m.arm === 'L1' ? '#1b6ca8' : '#2a9d8f';
          lines.push(`<line x1="${mx.toFixed(1)}" y1="${myMax.toFixed(1)}" x2="${mx.toFixed(1)}" y2="${myMin.toFixed(1)}" stroke="#111827" stroke-width="1.6"/>`);
          lines.push(`<line x1="${(mx - 4).toFixed(1)}" y1="${myMax.toFixed(1)}" x2="${(mx + 4).toFixed(1)}" y2="${myMax.toFixed(1)}" stroke="#111827" stroke-width="1.4"/>`);
          lines.push(`<line x1="${(mx - 4).toFixed(1)}" y1="${myMin.toFixed(1)}" x2="${(mx + 4).toFixed(1)}" y2="${myMin.toFixed(1)}" stroke="#111827" stroke-width="1.4"/>`);
          lines.push(`<polygon points="${mx.toFixed(1)},${(myMed - 4.5).toFixed(1)} ${(mx + 4.5).toFixed(1)},${myMed.toFixed(1)} ${mx.toFixed(1)},${(myMed + 4.5).toFixed(1)} ${(mx - 4.5).toFixed(1)},${myMed.toFixed(1)}" fill="${mColor}" stroke="#111827" stroke-width="1.2"/>`);
          const labelY = m.arm === 'L1' ? myMed - 10 : myMed + 16;
          const anchor = m.arm === 'L1' ? 'end' : 'start';
          const dx = m.arm === 'L1' ? -6 : 6;
          const valStr = `${m.netBenefitStats.median >= 0 ? '+$' : '-$'}${Math.abs(m.netBenefitStats.median).toFixed(3)}`;
          lines.push(`<text x="${(mx + dx).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${anchor}" class="annot">${m.arm} measured: ${valStr} (n=3)</text>`);
        }
        lines.push(`<text x="${x0 + 6}" y="${y0 + 13}" class="axis-lbl">Overlay note: measured O ~181 tok/t (vs 150 curve) &amp; L1 T3 Read R=2</text>`);
      }

      lines.push(`</g>`);
    });
  });

  lines.push(`<text x="${W / 2}" y="${H - 12}" text-anchor="middle" class="axis-lbl">Post-Switch Turns Remaining (H)</text>`);
  lines.push(`</svg>`);

  fs.writeFileSync(path.join(ROUND2_DIR, 'chart_net_switch_benefit.svg'), lines.join('\n') + '\n', 'utf8');
}

function sliceTranscriptPreSwitch(srcPath, maxHumanPrompts, destPath) {
  const lines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const kept = [];
  let humanCount = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === 'user' && (obj?.message?.role === 'user' || !obj?.message) && !obj?.isMeta) {
      const c = obj?.message?.content;
      const isHuman =
        typeof c === 'string'
          ? c.trim().length > 0 && !/^<(?:local-command-|command-name>)/.test(c.trim())
          : Array.isArray(c) && c.some((b) => b && b.type !== 'tool_result');
      if (isHuman) {
        if (humanCount >= maxHumanPrompts) break;
        humanCount += 1;
      }
    }
    kept.push(line);
  }
  fs.writeFileSync(destPath, kept.join('\n') + '\n', 'utf8');
}

function summarizeHookReplay(verdict) {
  return {
    requestsPerTurnUsed: verdict.requestsPerTurnUsed,
    rptEstimateSource: verdict.rptEstimateSource,
    rptTurnsAgree: Boolean(verdict.rptTurnsAgree),
    rptPriorUsed: verdict.rptPriorUsed ?? null,
    isPlaceholderRptPrior: Boolean(verdict.isPlaceholderRptPrior),
    expectedOutputTokens: verdict.breakEven?.expectedOutputTokens ?? null,
    contextGrowthPerTurnUsed: verdict.contextGrowthPerTurnUsed ?? 0,
    promptGrowthEstimateSource: verdict.promptGrowthEstimateSource ?? 'default_0',
    postSwitchRemainingTurns: verdict.breakEven?.postSwitchRemainingTurns ?? null,
    horizonMaxCachedTokens:
      verdict.breakEven?.horizonMaxCachedTokens === Infinity
        ? 'Infinity'
        : (verdict.breakEven?.horizonMaxCachedTokens ?? null),
    coldWritePenaltyUSD: verdict.breakEven?.coldWritePenaltyUSD ?? null,
    perTurnPostSwitchSavingUSD: verdict.breakEven?.perTurnPostSwitchSavingUSD ?? null,
    averagePostSwitchSavingUSD: verdict.breakEven?.averagePostSwitchSavingUSD ?? null,
    paybackWarmRequests: verdict.breakEven?.paybackWarmRequests ?? null,
    paybackTurns: verdict.breakEven?.paybackTurns ?? null,
    horizonNetSavingsUSD: verdict.breakEven?.horizonNetSavingsUSD ?? null,
    netDollarDisplaySuppressed: Boolean(verdict.netDollarDisplaySuppressed),
    decision: verdict.decision,
    noteOrReason: verdict.notableAllowNote || verdict.reason || null
  };
}

function evaluateOfflineREstimator(measuredPoints) {
  const g = measuredPoints.measuredGrowthPerTurn;
  const thAgreeShrunkR = shrinkRollingRequestsPerTurn(5, 2, { recentTurnRequestCounts: [5, 5] }); // 4.4
  const l1AgreeShrunkR = shrinkRollingRequestsPerTurn(2, 2, { recentTurnRequestCounts: [2, 2] }); // 2.0
  const l2ShrunkR = shrinkRollingRequestsPerTurn(1, 10); // 1.0

  const evalCase = (label, params) => {
    const r = computeBreakEvenCachedTokens(params);
    return {
      label,
      requestsPerTurn: r.requestsPerTurn,
      expectedOutputTokens: r.expectedOutputTokens,
      postSwitchRemainingTurns: r.postSwitchRemainingTurns,
      contextGrowthPerTurn: r.contextGrowthPerTurn,
      coldWritePenaltyUSD: r.coldWritePenaltyUSD,
      perTurnPostSwitchSavingUSD: r.perTurnPostSwitchSavingUSD,
      averagePostSwitchSavingUSD: r.averagePostSwitchSavingUSD,
      paybackWarmRequests: r.paybackWarmRequests,
      paybackTurns: r.paybackTurns,
      horizonNetSavingsUSD: r.horizonNetSavingsUSD,
      decision: r.shouldHold ? 'ask' : 'allow'
    };
  };

  // Run actual Stop + PreModelSwitch hook replays on real pre-switch transcripts under zero-spend temp home
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-r-eval-'));
  let thColdEval, thUnguidedEval, thSelfExcludedEval, l1HookEval, l1H27HookEval, l2HookEval;
  try {
    const txDir = path.join(tmpHome, 'tx');
    fs.mkdirSync(txDir, { recursive: true });
    const thSrc = path.join(ROUND2_DIR, 'tool_heavy', 'raw', 'transcripts', 'TH_allow_r01.jsonl');
    const l1Src = path.join(CALIBRATED_DIR, 'raw', 'transcripts', 'C2_L1_hb_rule_v2_calibrated_r01.jsonl');
    const l2Src = path.join(CALIBRATED_DIR, 'raw', 'transcripts', 'C2_L2_hb_rule_v2_calibrated_r01.jsonl');

    const thTx = path.join(txDir, 'th_pre_t3.jsonl');
    const l1Tx = path.join(txDir, 'l1_pre_t3.jsonl');
    const l2Tx = path.join(txDir, 'l2_pre_t24.jsonl');
    sliceTranscriptPreSwitch(thSrc, 2, thTx);
    sliceTranscriptPreSwitch(l1Src, 2, l1Tx);
    sliceTranscriptPreSwitch(l2Src, 23, l2Tx);

    activateLocalTrial({ homeDir: tmpHome });

    runStopGateHook(
      { session_id: 'replay_th', transcript_path: thTx, cwd: tmpHome },
      { homeDir: tmpHome, cwd: tmpHome, persistState: false }
    );
    thColdEval = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'replay_th',
        transcript_path: thTx,
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 13_216,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 9,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, cwd: tmpHome, recordLedger: false }
    ).verdict;
    thUnguidedEval = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'replay_th',
        transcript_path: thTx,
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 13_169,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        use_empirical_horizon_prior: true,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, cwd: tmpHome, recordLedger: false }
    ).verdict;

    runStopGateHook(
      { session_id: 'replay_l1', transcript_path: l1Tx, cwd: tmpHome },
      { homeDir: tmpHome, cwd: tmpHome, persistState: false }
    );
    l1HookEval = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'replay_l1',
        transcript_path: l1Tx,
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 11_952,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        use_empirical_horizon_prior: true,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, cwd: tmpHome, recordLedger: false }
    ).verdict;
    l1H27HookEval = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'replay_l1',
        transcript_path: l1Tx,
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 11_952,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 27,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, cwd: tmpHome, recordLedger: false }
    ).verdict;

    runStopGateHook(
      { session_id: 'replay_l2', transcript_path: l2Tx, cwd: tmpHome },
      { homeDir: tmpHome, cwd: tmpHome, persistState: false }
    );
    l2HookEval = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'replay_l2',
        transcript_path: l2Tx,
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 19_154,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 6,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, cwd: tmpHome, recordLedger: false }
    ).verdict;

    // Verify that placing TH_allow's own benchmark transcript in ~/.claude/projects/ is excluded
    // (requires >= 3 non-current, non-benchmark sessions)
    const ccProjDir = path.join(tmpHome, '.claude', 'projects', 'replay_th_proj');
    fs.mkdirSync(ccProjDir, { recursive: true });
    fs.copyFileSync(thSrc, path.join(ccProjDir, 'replay_th.jsonl'));
    thSelfExcludedEval = runPreModelSwitchHook(
      {
        hook_event_name: 'PreModelSwitch',
        session_id: 'replay_th',
        transcript_path: thTx,
        from_model: 'claude-opus-4-6',
        to_model: 'claude-sonnet-4-6',
        context_tokens: 13_216,
        prompt_cache_warm: true,
        cache_ttl: '5m',
        expected_remaining_turns: 9,
        mode: 'AUTO_PILOT'
      },
      { homeDir: tmpHome, cwd: tmpHome, recordLedger: false }
    ).verdict;
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  const thSummary = summarizeHookReplay(thColdEval);
  const thSelfExcludedSummary = summarizeHookReplay(thSelfExcludedEval);
  const thUnguidedSummary = summarizeHookReplay(thUnguidedEval);
  const l1Summary = summarizeHookReplay(l1HookEval);
  const l1H27Summary = summarizeHookReplay(l1H27HookEval);
  const l2Summary = summarizeHookReplay(l2HookEval);

  const report = {
    measuredGrowthPerTurn: g,
    thAgreeShrunkRptExample: thAgreeShrunkR,
    l1AgreeShrunkRptExample: l1AgreeShrunkR,
    l2ShrunkRptExample: l2ShrunkR,
    withdrawnSelfSeededClaim:
      'Withdrawn: the previous +$0.2897 ("within 10%") offline figure depended on seeding a 1-session temp dir with TH_allow\'s own benchmark transcript and compounding g = 2,538 before n >= 5. Local R prior now requires >= 3 sessions, excludes the current session, and excludes benchmark/harness sessions.',
    anyDecisionChanged:
      thSummary.decision !== 'allow' ||
      thSelfExcludedSummary.decision !== 'allow' ||
      thUnguidedSummary.decision !== 'allow' ||
      l1Summary.decision !== 'allow' ||
      l1H27Summary.decision !== 'allow' ||
      l2Summary.decision !== 'ask',
    liveHookReplays: {
      TH_allow_cold_start: thSummary,
      TH_allow_self_and_benchmark_excluded: thSelfExcludedSummary,
      TH_unguided_rule_v2: thUnguidedSummary,
      L1: l1Summary,
      L1_H27: l1H27Summary,
      L2: l2Summary
    },
    comparisons: {
      TH_allow_live_pre_fix: evalCase('TH_allow live pre-fix (R=2.6, O=547, H=9, g=0)', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 13_216,
        expectedOutputTokens: 547, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 2.6, expectedRemainingTurns: 9, contextGrowthPerTurn: 0
      }),
      TH_allow_updated_cold_start: evalCase('TH_allow updated cold-start (R=4.4, O=547, H=9, g=2538)', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 13_216,
        expectedOutputTokens: 547, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 4.4, expectedRemainingTurns: 9, contextGrowthPerTurn: 2538
      }),
      TH_allow_updated_local_prior: evalCase('TH_allow >=1 local transcript (R=5.0, O=547, H=9, g=2538)', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 13_216,
        expectedOutputTokens: 547, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 5.0, expectedRemainingTurns: 9, contextGrowthPerTurn: 2538
      }),
      TH_measured_n1: {
        netBenefitUSD: 0.321789,
        holdCostUSD: 1.11225,
        allowCostUSD: 0.790461,
        n: 1
      },
      L1_old_R2_H27_5: evalCase('L1 old cumulative R=2, O=409, H=27.5, g=0', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 11_952,
        expectedOutputTokens: 409, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 2, expectedRemainingTurns: 27.5
      }),
      L1_shrunk_R1_4_H27_5: evalCase('L1 new shrunk R=1.4, O=409, H=27.5, g=0', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 11_952,
        expectedOutputTokens: 409, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 1.4, expectedRemainingTurns: 27.5
      }),
      L1_true_post_R1_H27_O409_g0: evalCase('L1 true post-switch R=1, O=409, H=27, g=0', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 11_952,
        expectedOutputTokens: 409, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 1, expectedRemainingTurns: 27
      }),
      L1_true_post_R1_H27_O181_gMeasured: evalCase(`L1 true post-switch R=1, O=181, H=27, g=${g}`, {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 12_240,
        expectedOutputTokens: 181, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 1, expectedRemainingTurns: 27, contextGrowthPerTurn: g
      }),
      L1_measured_phase1: {
        netBenefitUSD: measuredPoints.L1.netBenefitStats.median,
        minUSD: measuredPoints.L1.netBenefitStats.min,
        maxUSD: measuredPoints.L1.netBenefitStats.max,
        n: measuredPoints.L1.netBenefitStats.n
      },
      L2_old_R1_1304: evalCase('L2 old cumulative R=1.1304, O=150, H=6, g=0 (agreed by cancellation)', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 19_154,
        expectedOutputTokens: 150, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 1.1304, expectedRemainingTurns: 6
      }),
      L2_new_R1_g0: evalCase('L2 new rolling-median R=1, O=150, H=6, g=0', {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 19_154,
        expectedOutputTokens: 150, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 1, expectedRemainingTurns: 6
      }),
      L2_true_post_R1_O182_gMeasured: evalCase(`L2 true post-switch R=1, O=182, H=6, g=${g}`, {
        currentModel: 'claude-opus-4-6', targetModel: 'claude-sonnet-4-6', cachedTokens: 19_298,
        expectedOutputTokens: 182, cacheWarm: true, cacheTtlTier: '5m', requestsPerTurn: 1, expectedRemainingTurns: 6, contextGrowthPerTurn: g
      }),
      L2_measured_phase1: {
        netBenefitUSD: measuredPoints.L2.netBenefitStats.median,
        minUSD: measuredPoints.L2.netBenefitStats.min,
        maxUSD: measuredPoints.L2.netBenefitStats.max,
        n: measuredPoints.L2.netBenefitStats.n
      }
    }
  };
  fs.writeFileSync(
    path.join(ROUND2_DIR, 'r_estimator_offline_eval.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8'
  );
  return report;
}

function main() {
  const argGrowth = process.argv.find((a) => a.startsWith('--context-growth='));
  const measuredPoints = computeMeasuredPhase1SwitchPoints();
  const growthPerTurn = argGrowth
    ? Math.max(0, Math.round(Number(argGrowth.split('=')[1])))
    : measuredPoints.measuredGrowthPerTurn;
  promoteCanonicalFilesAndWarnLegacy();
  const sweepStats = buildSweepDatasetAndCrossovers(measuredPoints, growthPerTurn);
  buildTufteSvgChart(sweepStats.curves, measuredPoints);
  const offlineREval = evaluateOfflineREstimator(measuredPoints);

  console.log(
    JSON.stringify(
      {
        status: 'NET_BENEFIT_DATASET_OK',
        contextGrowthPerTurnUsed: growthPerTurn,
        computedRows: sweepStats.computedRows,
        measuredRows: sweepStats.measuredRows,
        totalDatasetRows: sweepStats.totalDatasetRows,
        crossoverRows: sweepStats.crossoverRows,
        measuredPoints,
        offlineREvalSummary: {
          L1_old_R2_net: offlineREval.comparisons.L1_old_R2_H27_5.horizonNetSavingsUSD,
          L1_shrunk_R1_4_net: offlineREval.comparisons.L1_shrunk_R1_4_H27_5.horizonNetSavingsUSD,
          L1_true_R1_O409_g0_net: offlineREval.comparisons.L1_true_post_R1_H27_O409_g0.horizonNetSavingsUSD,
          L1_true_R1_O181_gMeasured_net: offlineREval.comparisons.L1_true_post_R1_H27_O181_gMeasured.horizonNetSavingsUSD,
          L1_measured_net: offlineREval.comparisons.L1_measured_phase1.netBenefitUSD,
          L2_old_R1_1304_net: offlineREval.comparisons.L2_old_R1_1304.horizonNetSavingsUSD,
          L2_new_R1_g0_net: offlineREval.comparisons.L2_new_R1_g0.horizonNetSavingsUSD,
          L2_measured_net: offlineREval.comparisons.L2_measured_phase1.netBenefitUSD
        }
      },
      null,
      2
    )
  );
}

main();
