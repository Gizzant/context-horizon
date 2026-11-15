/**
 * @file test/grep_glob_firewall_sim.test.mjs
 * Bucket B Sub-Wave B-Alpha — Guardrail #2 (`GREP_GLOB_FIREWALL`) Simulation & SLA Suite.
 *
 * Corpus:
 * - 40 multi-turn search -> edit trajectories (`18..36` matched paths mixing active `src/`, dirty files,
 *   directory neighbors, `docs/`, `evaluation_bundles/`, `archive/`, plus isolated `packages/airlock/` decoys)
 * - 25 benign exemptions (short exact symbols `\bid\b`, `\bdb\b`, `\bfs\b`, `\bui\b` and explicit repo-wide
 *   rename/refactor/audit prompts)
 *
 * Promotion SLA:
 * - `Recall@8 >= 95%` (`0.95`)
 * - `FPR < 1%` (`0.01`) on valid short-symbol / repo-wide rename queries
 * - `p99 < 10ms`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGrepGlobFirewall } from '../src/core-isomorphic/guards/bucketBHeuristics.mjs';
import { runBucketBExperiment } from './helpers/bucket_b_harness.mjs';

function buildSearchTrajectoryDataset() {
  const dataset = [];
  const baseNoisePaths = [
    'evaluation_bundles/tier_1/src/core/alpha.mjs',
    'evaluation_bundles/tier_2_full/src/core/beta.mjs',
    'evaluation_bundles/tier_2_full/src/core/gamma.mjs',
    'archive/legacy_v1/router.mjs',
    'archive/legacy_v1/telemetry.mjs',
    'archive/legacy_v2/hooks.mjs',
    'docs/architecture/overview.md',
    'docs/guides/migration.md',
    'docs/guides/faq.md',
    'fixtures/sample_a.mjs',
    'fixtures/sample_b.mjs',
    'snapshots/ui_snap_1.mjs',
    'snapshots/ui_snap_2.mjs',
    'dist/bundle.mjs',
    'vendor/shim.mjs',
    'packages/airlock/src/vault_secret.mjs'
  ];

  const modules = [
    { dir: 'src/core', target: 'src/core/shield_manager.mjs', peer: 'src/core/constants.mjs', sym: 'evaluateShield' },
    { dir: 'src/hooks', target: 'src/hooks/pre_invocation.mjs', peer: 'src/hooks/post_invocation.mjs', sym: 'handlePreInvocation' },
    { dir: 'hooks/handlers', target: 'hooks/handlers/pre-tool-use.mjs', peer: 'hooks/handlers/post-tool-use.mjs', sym: 'runPreToolUseHook' },
    { dir: 'src/diagnostics', target: 'src/diagnostics/doctorEngine.mjs', peer: 'src/diagnostics/claudeHookCapabilities.mjs', sym: 'runDoctorDiagnostics' },
    { dir: 'src/core-isomorphic/guards', target: 'src/core-isomorphic/guards/circuitBreakers.mjs', peer: 'src/core-isomorphic/guards/det04_12_thrash_rot.mjs', sym: 'evaluatePreToolUse' }
  ];

  const baseNow = 1_794_700_000_000;

  // 40 positive multi-turn trajectories (>15 matches, target file subsequently edited)
  for (let i = 0; i < 40; i++) {
    const mod = modules[i % modules.length];
    const variantTarget = i % 2 === 0 ? mod.target : `${mod.dir}/worker_${i}.mjs`;
    const extraSrcDecoys = [
      `src/cli/cmd_${i}_a.mjs`,
      `src/cli/cmd_${i}_b.mjs`,
      `src/utils/util_${i}_a.mjs`,
      `src/utils/util_${i}_b.mjs`,
      `sidecars/daemon_${i}.mjs`
    ];
    // Place noise paths FIRST so naive head-truncation (`slice(0, 8)`) would get 0% Recall@8!
    const matchPaths = [...baseNoisePaths, ...extraSrcDecoys, mod.peer, variantTarget];

    const activeFiles = i % 3 === 0 ? [variantTarget] : [mod.peer];
    const dirtyFiles = i % 3 === 1 ? [variantTarget] : [];
    const mtimeByPath = {
      [variantTarget]: baseNow - (i % 5) * 60_000,
      [mod.peer]: baseNow - 120_000
    };

    dataset.push({
      id: `grep-traj-${i + 1}`,
      category: 'search_to_edit_trajectory',
      expectedTrigger: true,
      expectedTopTargets: [variantTarget],
      payload: {
        matchPaths,
        query: mod.sym,
        lastUserPrompt: 'fix the failing edge case in the handler',
        activeFiles,
        dirtyFiles,
        lastEditedFile: mod.peer,
        mtimeByPath
      }
    });
  }

  // 13 short exact symbol boundary searches (`<= 25` matches -> must NOT trigger truncation)
  const shortSymbols = ['\\bid\\b', '\\bdb\\b', '\\bfs\\b', '\\bui\\b', '\\bok\\b', '\\bio\\b', '\\bvm\\b'];
  for (let i = 0; i < 13; i++) {
    const sym = shortSymbols[i % shortSymbols.length];
    const paths = Array.from({ length: 20 }, (_v, idx) => `src/mod_${idx}/item_${idx}.mjs`);
    dataset.push({
      id: `grep-short-sym-${i + 1}`,
      category: 'short_exact_symbol_exempt',
      expectedTrigger: false,
      payload: {
        matchPaths: paths,
        query: sym,
        exactSymbol: true,
        lastUserPrompt: `check ${sym} references`
      }
    });
  }

  // 12 explicit repo-wide rename / refactor / audit queries (`> 25` matches -> must NOT trigger truncation)
  const auditPrompts = [
    'rename evaluateDet08 across the codebase',
    'refactor across every file that imports constants.mjs',
    'find all usages of FlightMode repo-wide',
    'replace_all old helper names in all occurrences',
    'audit all handlers across the workspace',
    'global search for deprecated config keys everywhere'
  ];
  for (let i = 0; i < 12; i++) {
    const paths = Array.from({ length: 30 }, (_v, idx) => `src/pkg_${idx}/handler_${idx}.mjs`);
    dataset.push({
      id: `grep-repo-audit-${i + 1}`,
      category: 'repo_wide_audit_exempt',
      expectedTrigger: false,
      payload: {
        matchPaths: paths,
        query: 'FlightMode',
        lastUserPrompt: auditPrompts[i % auditPrompts.length]
      }
    });
  }

  return dataset;
}

export async function runGrepGlobFirewallBenchmark() {
  const dataset = buildSearchTrajectoryDataset();
  return runBucketBExperiment({
    id: '#2',
    code: 'GREP_GLOB_FIREWALL',
    subWave: 'B-Alpha',
    dataset,
    evaluateFn: (item) => evaluateGrepGlobFirewall(item.payload),
    sla: {
      minRecallAt8: 0.95,
      maxFpr: 0.01,
      minPrecision: 0.99,
      maxP99Ms: 10
    }
  });
}

if (!process.env.CTXTOP_BENCH_IMPORT_ONLY) {
  test('Bucket B #2 GREP_GLOB_FIREWALL meets Recall@8 >= 95%, FPR < 1%, p99 < 10ms, and SKU isolation', async () => {
    const report = await runGrepGlobFirewallBenchmark();
    assert.equal(report.status, 'PROMOTE_READY', `Failed SLA checks: ${report.failedChecks.join(', ')}`);
    assert.ok(report.recallAt8 >= 0.95, `Expected Recall@8 >= 0.95, got ${report.recallAt8}`);
    assert.ok(report.falsePositiveRate < 0.01, `Expected FPR < 0.01, got ${report.falsePositiveRate}`);
    assert.ok(report.latencyMs.p99 < 10, `Expected p99 < 10ms, got ${report.latencyMs.p99}ms`);

    // Verify isolated sister SKU paths are stripped from rankedPaths
    const skuCheck = evaluateGrepGlobFirewall({
      matchPaths: [
        'packages/airlock/src/secret.mjs',
        'docs/HIGHBEAM_AIRLOCK_SPEC.md',
        '.github/workflows/airlock-schema-canary.yml',
        ...Array.from({ length: 18 }, (_v, idx) => `src/core/file_${idx}.mjs`)
      ],
      query: 'token'
    });
    assert.ok(
      skuCheck.rankedPaths.every((p) => !p.includes('airlock') && !p.includes('HIGHBEAM_AIRLOCK')),
      'Expected isolated sister SKU paths to be excluded from rankedPaths'
    );
  });
}
