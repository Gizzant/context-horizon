#!/usr/bin/env node
/**
 * @file scripts/run_bucket_b_harness.mjs
 * Unified Deterministic Validation & Shadow-Promotion Scorecard Runner for all 12 Bucket B Guardrails:
 *   - Sub-Wave B-Alpha: `#2`, `#6`, `#9`, `#4`
 *   - Sub-Wave B-Beta:  `#8`, `#3b`, `#19`
 *   - Sub-Wave B-Gamma: `#5`, `#13`, `#16`, `#17`, `#20`
 *
 * Usage:
 *   node scripts/run_bucket_b_harness.mjs [--json] [--strict]
 */

process.env.CTXTOP_BENCH_IMPORT_ONLY = '1';

const [
  { runGrepGlobFirewallBenchmark },
  { runSlopsquatDepGateBenchmark },
  { runWebBoilerplateFidelityBenchmark },
  { runBlastRadiusBenchmark },
  { runDuplicateCloneBenchmark },
  {
    runEvilGenieOracleBenchmark,
    runOverengineeringDiffBenchmark,
    runSubagentGovernorBenchmark,
    runVaguePromptAnchorBenchmark,
    runMcpCliRouterBenchmark,
    runLspSymbolRouterBenchmark,
    runProseToHookCompilerBenchmark
  }
] = await Promise.all([
  import('../test/grep_glob_firewall_sim.test.mjs'),
  import('../test/slopsquat_dep_gate.test.mjs'),
  import('../test/web_boilerplate_fidelity.test.mjs'),
  import('../test/blast_radius_sim.test.mjs'),
  import('../test/duplicate_clone_shingle_bench.test.mjs'),
  import('../test/bucket_b_gamma_suites.test.mjs')
]);

function resolveDefaultStageForGuardrail(summary) {
  if (summary.id === '#20') return 'DOCTOR_PREVIEW';
  if (summary.id === '#17') return 'SHADOW';
  return 'COACH';
}

export async function runAllBucketBBenchmarks() {
  const results = [];
  results.push(await runGrepGlobFirewallBenchmark());
  results.push(await runSlopsquatDepGateBenchmark());
  results.push(await runWebBoilerplateFidelityBenchmark());
  results.push(await runBlastRadiusBenchmark());
  results.push(await runDuplicateCloneBenchmark());
  results.push(await runEvilGenieOracleBenchmark());
  results.push(await runOverengineeringDiffBenchmark());
  results.push(await runSubagentGovernorBenchmark());
  results.push(await runVaguePromptAnchorBenchmark());
  results.push(await runMcpCliRouterBenchmark());
  results.push(await runLspSymbolRouterBenchmark());
  results.push(await runProseToHookCompilerBenchmark());

  const promoteReadyCount = results.filter((r) => r.status === 'PROMOTE_READY').length;
  return {
    generatedAt: new Date().toISOString(),
    totalGuardrails: results.length,
    promoteReadyCount,
    keepShadowCount: results.length - promoteReadyCount,
    zeroOutboundNetworkVerified: results.every((r) => r.zeroOutboundNetwork),
    guardrails: results.map(({ itemRecords: _ir, ...summary }) => ({
      ...summary,
      defaultStage: resolveDefaultStageForGuardrail(summary)
    }))
  };
}

function formatPct(val) {
  if (val === null || val === undefined) return '—';
  return `${(val * 100).toFixed(1)}%`;
}

function renderMarkdownScorecard(summary) {
  const lines = [
    '# Highbeam (`ctxtop`) — Bucket B Validation & Shadow-Promotion Scorecard',
    '',
    `- **Guardrails Evaluated**: \`${summary.totalGuardrails}\` (\`0\` live API tokens, \`0\` outbound network calls: \`${summary.zeroOutboundNetworkVerified}\`)`,
    `- **SLA Promotion Status**: \`${summary.promoteReadyCount}/${summary.totalGuardrails} PROMOTE_READY\` (Sub-Waves B-Alpha, B-Beta & B-Gamma \`#5\`/\`#13\`/capability-gated \`#16\` in \`COACH\`; \`#17\` in \`SHADOW\` \`.hints.jsonl\`; \`#20\` in \`DOCTOR_PREVIEW\`)`,
    '',
    '| ID | Guardrail | Sub-Wave | Default Stage | Samples | Precision | Recall | FPR | Extra SLA Metric | p99 Latency | Status |',
    '| :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- | ---: | :--- |'
  ];

  for (const g of summary.guardrails) {
    let extra = '—';
    if (g.recallAt8 !== null && g.recallAt8 !== undefined) {
      extra = `Recall@8=${formatPct(g.recallAt8)}`;
    } else if (g.fidelityRate !== null && g.fidelityRate !== undefined) {
      extra = `Fidelity=${formatPct(g.fidelityRate)}, -${g.avgTokenReductionPct}% tok`;
    } else if (g.coldBuildMs !== undefined) {
      extra = `Cold=${g.coldBuildMs}ms, Inc=${g.incrementalUpdateMs}ms`;
    } else if (g.sweepResults && g.sweepResults.length > 0) {
      extra = `Optimal=(${g.selectedParams.maxUnverifiedFiles}f, ${g.selectedParams.maxNetLogicLines}L)`;
    } else if (g.sla?.zeroFalseDeny) {
      extra = `FalseDeny=${g.falseDenies}`;
    }

    const stage = g.defaultStage || resolveDefaultStageForGuardrail(g);
    lines.push(
      `| \`${g.id}\` | \`${g.code}\` | ${g.subWave} | \`${stage}\` | ${g.sampleCount} | ${formatPct(g.precision)} | ${formatPct(g.recall)} | ${formatPct(g.falsePositiveRate)} | ${extra} | ${g.latencyMs.p99}ms | **${g.status}** |`
    );
  }

  return lines.join('\n');
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const args = new Set(process.argv.slice(2));
  const summary = await runAllBucketBBenchmarks();
  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderMarkdownScorecard(summary)}\n`);
  }
  if (args.has('--strict') && summary.keepShadowCount > 0) {
    process.exitCode = 1;
  }
}
