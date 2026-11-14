#!/usr/bin/env node
/**
 * Highbeam Airlock Benchmark & False-Positive Gate (`scripts/benchmark_airlock.mjs`).
 *
 * 1. Polyglot Corpus Gate: >= 500,000 deterministic non-secret source/config lines across
 *    JS/TS, Python, Go, JSON, Markdown, and SQL; verifies Stage 1/2 FP rate < 0.1%.
 * 2. Detection Latency Matrix: N = 250 runs across payload sizes (1 KB, 10 KB, 100 KB)
 *    x Aho-Corasick policy term counts (100, 1,000, 10,000 terms); reports p50 / p95 / p99.
 */

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  scanTextWithAirlock,
  scrubTextWithAirlock,
  AhoCorasickAutomaton
} from '../src/core-isomorphic/airlock/index.mjs';

function makeDeterministicPrng(seed = 0x51a7f00d) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function deterministicHex(rng, len) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(rng() * 16)];
  }
  return out;
}

function generatePolyglotNonSecretLines(totalLines = 500000) {
  const rng = makeDeterministicPrng(20261113);
  const templates = [
    (i) => `import { renderItem_${i % 97} } from './components/panel_${i % 43}.mjs';`,
    (i) => `export const BUILD_DIGEST_${i % 50} = "${deterministicHex(rng, 64)}";`,
    (i) => `const CORRELATION_UUID_${i % 30} = "${deterministicHex(rng, 8)}-${deterministicHex(rng, 4)}-4${deterministicHex(rng, 3)}-a${deterministicHex(rng, 3)}-${deterministicHex(rng, 12)}";`,
    (i) => `"integrity": "sha512-${Buffer.from(deterministicHex(rng, 32)).toString('base64')}="`,
    (i) => `def process_batch_${i % 64}(rows: list[dict], limit: int = ${(i % 500) + 10}) -> int:`,
    (i) => `SELECT id, workspace_slug, updated_at FROM session_metrics WHERE bucket_idx = ${i % 1024};`,
    (i) => `func ComputeWindow_${i % 80}(tokens int64, ratio float64) float64 { return float64(tokens) * ratio }`,
    (i) => `- Documentation link: https://example.com/docs/v2/section-${i % 120}?page=${(i % 20) + 1}`,
    (i) => `logger.info("completed chunk", { chunkId: ${i}, elapsedMs: ${((i * 13) % 99) + 1}.4, domain: "synthetic.test" });`,
    (i) => `/* SVG path d="M12 ${i % 40} L48 ${(i * 3) % 90} Z" fill="#10b981" class="hz-cell-${i % 40}" */`
  ];

  const lines = new Array(totalLines);
  for (let i = 0; i < totalLines; i++) {
    lines[i] = templates[i % templates.length](i);
  }
  return lines;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return Number(sortedAsc[idx].toFixed(3));
}

function generateCustomTerms(count) {
  const terms = [];
  for (let i = 0; i < count; i++) {
    terms.push(`INTERNAL_CODENAME_${String(i).padStart(5, '0')}_TOKEN`);
  }
  return terms;
}

function makePayloadText(sizeKb) {
  const targetBytes = sizeKb * 1024;
  const line = 'const step = evaluateMetric({ status: "nominal", cacheRatio: 0.94, hash: "0123456789abcdef0123456789abcdef" });\n';
  const repeatCount = Math.max(1, Math.ceil(targetBytes / line.length));
  return line.repeat(repeatCount).slice(0, targetBytes);
}

export function runAirlockBenchmark(options = {}) {
  const corpusLinesCount = Number(options.corpusLines) || 500000;
  const matrixRuns = Number(options.matrixRuns) || 250;
  const sizesKb = options.sizesKb || [1, 10, 100];
  const termCounts = options.termCounts || [100, 1000, 10000];

  // 1. 500k-line polyglot false-positive corpus benchmark
  const corpusLines = generatePolyglotNonSecretLines(corpusLinesCount);
  const basePolicy = {
    internalDomains: ['corp-internal.example'],
    terms: generateCustomTerms(250),
    allowlistGlobs: ['test/**']
  };
  // Pre-warm automaton cache once (as persistent/warm runtime does)
  AhoCorasickAutomaton && scanTextWithAirlock('warmup', { policy: basePolicy });

  const chunkSizeLines = 2500;
  let totalBytes = 0;
  let fpStage12 = 0;
  let fpStage3Audit = 0;
  const sampleFpRules = {};
  const corpusStart = performance.now();

  for (let i = 0; i < corpusLines.length; i += chunkSizeLines) {
    const chunkText = corpusLines.slice(i, i + chunkSizeLines).join('\n');
    totalBytes += Buffer.byteLength(chunkText, 'utf8');
    const scan = scanTextWithAirlock(chunkText, { policy: basePolicy, orgAuditSalt: 'bench-salt' });
    fpStage12 += scan.matches.length;
    fpStage3Audit += scan.auditOnlyMatches.length;
    for (let k = 0; k < scan.matches.length; k++) {
      const r = scan.matches[k].ruleId;
      sampleFpRules[r] = (sampleFpRules[r] || 0) + 1;
    }
  }
  const corpusElapsedMs = Number((performance.now() - corpusStart).toFixed(2));
  const fpRatePct = Number(((fpStage12 / corpusLinesCount) * 100).toFixed(6));
  const throughputMbSec = Number(((totalBytes / (1024 * 1024)) / Math.max(0.001, corpusElapsedMs / 1000)).toFixed(2));

  // 2. Planted recall sanity check
  const planted = [
    ['AKIA', '89ABCDEF01234567'].join(''),
    ['sk', 'live', '51AbCdEfGhIjKlMnOpQrStUvWx'].join('_'),
    ['ghp', '0123456789abcdef0123456789abcdef0123'].join('_'),
    'postgres://admin:SuperSecret99@db.prod.local:5432/appdb',
    ['xoxb', '123456789012', '1234567890123', 'abcdefghijklmnop'].join('-')
  ].join('\n');
  const plantedRes = scrubTextWithAirlock(planted, { policy: basePolicy, sessionKey: 'bench-session-key' });

  // 3. Aho-Corasick scaling matrix (N = 250 per cell)
  const matrix = [];
  for (let tIdx = 0; tIdx < termCounts.length; tIdx++) {
    const termCount = termCounts[tIdx];
    const policy = { terms: generateCustomTerms(termCount), internalDomains: ['internal.acme.local'] };
    const buildStart = performance.now();
    scanTextWithAirlock('warmup_line', { policy, orgAuditSalt: 'bench-salt' });
    const automatonBuildMs = Number((performance.now() - buildStart).toFixed(3));

    for (let sIdx = 0; sIdx < sizesKb.length; sIdx++) {
      const sizeKb = sizesKb[sIdx];
      const payload = makePayloadText(sizeKb);
      const timings = [];
      for (let r = 0; r < matrixRuns; r++) {
        const t0 = performance.now();
        scanTextWithAirlock(payload, { policy, orgAuditSalt: 'bench-salt' });
        timings.push(performance.now() - t0);
      }
      timings.sort((a, b) => a - b);
      const sum = timings.reduce((a, b) => a + b, 0);
      matrix.push({
        sizeKb,
        termCount,
        runs: matrixRuns,
        automatonBuildMs,
        meanMs: Number((sum / timings.length).toFixed(3)),
        p50Ms: percentile(timings, 50),
        p95Ms: percentile(timings, 95),
        p99Ms: percentile(timings, 99)
      });
    }
  }

  return {
    ok: fpRatePct < 0.1 && plantedRes.matches.length >= 5,
    corpus: {
      lines: corpusLinesCount,
      bytes: totalBytes,
      elapsedMs: corpusElapsedMs,
      throughputMbSec,
      falsePositivesStage12: fpStage12,
      auditOnlyStage3Hits: fpStage3Audit,
      falsePositiveRatePct: fpRatePct,
      thresholdMaxPct: 0.1,
      fpByRule: sampleFpRules
    },
    plantedRecall: {
      plantedCount: 5,
      detectedCount: plantedRes.matches.length,
      modified: plantedRes.modified
    },
    latencyMatrix: matrix
  };
}

const isEntrypoint = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  const asJson = process.argv.includes('--json');
  const result = runAirlockBenchmark();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(
      `[Airlock Benchmark] ${result.corpus.lines.toLocaleString()} lines (${result.corpus.throughputMbSec} MB/s): ` +
        `FP=${result.corpus.falsePositiveRatePct}% (${result.corpus.falsePositivesStage12} hits, limit < 0.1%)`
    );
    for (const row of result.latencyMatrix) {
      console.log(
        `  size=${row.sizeKb}KB terms=${row.termCount} N=${row.runs} | p50=${row.p50Ms}ms p95=${row.p95Ms}ms p99=${row.p99Ms}ms (build=${row.automatonBuildMs}ms)`
      );
    }
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}
