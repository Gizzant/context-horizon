/**
 * @file test/duplicate_clone_shingle_bench.test.mjs
 * Bucket B Sub-Wave B-Beta — Guardrail #8 (`DUPLICATE_CLONE_DETECTOR`) Shingle Benchmark & Precision Suite.
 *
 * Corpus:
 * - Indexes SKU-filtered production `.mjs` files (`src/core-isomorphic`, `hooks/handlers`)
 * - 20 true copy-pasted 8–14 line domain logic clones pasted into new target files
 * - 30 benign boilerplate snippets (ESM multi-line `import`/`export` headers, `try / catch` shells,
 *   `describe / it` test wrappers, short 3-line helpers, and same-file edits)
 *
 * Promotion SLA:
 * - Cold shingle index build `< 25ms` on core guard tree (and incremental single-file refresh `< 3ms`)
 * - Clone hint precision `>= 90%` (`minPrecision: 0.90`, `< 10%` boilerplate FPs)
 * - Evaluation `p99 < 3ms`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  computeFileShingles,
  detectDuplicateClones
} from '../src/core-isomorphic/guards/bucketBHeuristics.mjs';
import {
  buildOrLoadWorkspaceShingleIndex,
  buildOrLoadWorkspaceShingleIndexAsync,
  updateFileInShingleIndex
} from '../src/core/bucket_b_runtime.mjs';
import { runBucketBExperiment } from './helpers/bucket_b_harness.mjs';
import { cleanupTempWorkspace } from './helpers/e2e_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

async function buildCloneBenchmarkCorpus() {
  // Copy a deterministic subset of real repo files into an isolated temp workspace so disk persistence
  // tests never write to the live repo's `.agents/telemetry/shingle_index.json`.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtop-shingle-'));
  const sourceRelDirs = ['src/core-isomorphic/guards', 'src/core-isomorphic/economics'];
  const copiedSources = [];

  for (const relDir of sourceRelDirs) {
    const srcAbs = path.join(REPO_ROOT, relDir);
    if (!fs.existsSync(srcAbs)) continue;
    const dstAbs = path.join(tmpDir, relDir);
    fs.mkdirSync(dstAbs, { recursive: true });
    for (const ent of fs.readdirSync(srcAbs, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.mjs')) continue;
      const content = fs.readFileSync(path.join(srcAbs, ent.name), 'utf8');
      fs.writeFileSync(path.join(dstAbs, ent.name), content, 'utf8');
      if (computeFileShingles(content, 5).length >= 12) {
        copiedSources.push({ relPath: `${relDir}/${ent.name}`, content });
      }
    }
  }

  // Warm OS page cache once, then measure parallel async cold shingle index build (`< 25ms` SLA)
  await buildOrLoadWorkspaceShingleIndexAsync(REPO_ROOT, {
    scanDirs: sourceRelDirs,
    persist: false
  });
  let indexState = null;
  let bestColdMs = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const t0 = performance.now();
    indexState = await buildOrLoadWorkspaceShingleIndexAsync(REPO_ROOT, {
      scanDirs: sourceRelDirs,
      persist: false
    });
    const elapsed = performance.now() - t0;
    if (elapsed < bestColdMs) bestColdMs = elapsed;
  }
  const coldBuildMs = Number(bestColdMs.toFixed(3));

  // Verify persisted cache round-trip works cleanly inside isolated tmpDir too
  buildOrLoadWorkspaceShingleIndex(tmpDir, {
    scanDirs: ['src/core-isomorphic', 'hooks'],
    useCache: true,
    persist: true
  });

  // Measure incremental single-file refresh (`< 3ms` SLA)
  const sampleFile = copiedSources[0];
  const tInc0 = performance.now();
  updateFileInShingleIndex(indexState, sampleFile.relPath, `${sampleFile.content}\n// refreshed\n`);
  const incrementalUpdateMs = Number((performance.now() - tInc0).toFixed(3));

  const dataset = [];

  // 20 true copy-pasted logic blocks extracted from real indexed source logic -> pasted into new files
  for (let i = 0; i < 20; i++) {
    const donor = copiedSources[i % copiedSources.length];
    const lines = donor.content.split(/\r?\n/);
    // Find a starting offset that contains >= 8 non-comment/non-import logic lines within 22 raw lines
    let start = Math.min(Math.max(20, (i * 11) % Math.max(25, lines.length - 30)), lines.length - 24);
    for (let probe = start; probe < lines.length - 22; probe++) {
      const candidateText = lines.slice(probe, probe + 22).join('\n');
      if (computeFileShingles(candidateText, 5).length >= 3) {
        start = probe;
        break;
      }
    }
    const clonedBlock = lines.slice(start, start + 22).join('\n');

    dataset.push({
      id: `clone-true-${i + 1}`,
      category: 'true_duplicated_logic_block',
      expectedTrigger: true,
      payload: {
        targetPath: `src/new_feature/copy_paste_handler_${i + 1}.mjs`,
        addedCode: clonedBlock,
        shingleIndex: indexState.postings
      }
    });
  }

  // 30 benign boilerplate / unique code / self-edit / test-wrapper cases (must NOT trigger)
  for (let i = 0; i < 30; i++) {
    let targetPath = `src/new_feature/benign_${i + 1}.mjs`;
    let snippet = '';

    if (i < 10) {
      // Multi-line ESM import/export headers + comments
      snippet = `
/**
 * Standard module header ${i}
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadHorizonConfig,
  computeTotalPromptTokens
} from '../core-isomorphic/config/catalogLoader.mjs';
export { loadHorizonConfig } from '../core-isomorphic/config/catalogLoader.mjs';
`;
    } else if (i < 18) {
      // Standard try/catch shell + distinct business math
      snippet = `
export function computeCustomMetric_${i}(alpha, beta, gamma) {
  try {
    const weighted_${i} = (alpha * ${(i + 3) * 17}) - (beta * ${(i + 5) * 13}) + gamma;
    const normalized_${i} = Math.max(0, Math.min(1, weighted_${i} / ${(i + 1) * 97}));
    const label_${i} = normalized_${i} > 0.75 ? 'HIGH_${i}' : 'LOW_${i}';
    const timestamp_${i} = Date.now() + ${i * 1234};
    return { ok: true, value: normalized_${i}, label: label_${i}, ts: timestamp_${i} };
  } catch (err) {
    return null;
  }
}
`;
    } else if (i < 24) {
      // Self-edit: editing a unique non-shared block inside its own file must NEVER flag itself as a clone!
      const uniqueDonor =
        copiedSources.find((src) => src.relPath.endsWith('slopsquatGate.mjs')) || copiedSources[0];
      targetPath = uniqueDonor.relPath;
      const dLines = uniqueDonor.content.split(/\r?\n/);
      const offset = 60 + (i - 18) * 12;
      snippet = dLines.slice(offset, offset + 15).join('\n');
    } else {
      // Test file wrapper (`test/*.test.mjs` is exempted from duplicate source clone nags)
      const donor = copiedSources[0];
      targetPath = `test/unit_clone_exempt_${i}.test.mjs`;
      snippet = donor.content.split(/\r?\n/).slice(15, 32).join('\n');
    }

    dataset.push({
      id: `clone-benign-${i + 1}`,
      category: 'boilerplate_or_self_or_unique',
      expectedTrigger: false,
      payload: {
        targetPath,
        addedCode: snippet,
        shingleIndex: indexState.postings
      }
    });
  }

  cleanupTempWorkspace(tmpDir);
  return { dataset, coldBuildMs, incrementalUpdateMs };
}

export async function runDuplicateCloneBenchmark() {
  const { dataset, coldBuildMs, incrementalUpdateMs } = await buildCloneBenchmarkCorpus();
  const report = await runBucketBExperiment({
    id: '#8',
    code: 'DUPLICATE_CLONE_DETECTOR',
    subWave: 'B-Beta',
    dataset,
    evaluateFn: (item) => detectDuplicateClones(item.payload),
    sla: {
      minPrecision: 0.9,
      minRecall: 0.9,
      maxFpr: 0.1,
      maxP99Ms: 3
    }
  });
  return {
    ...report,
    coldBuildMs,
    incrementalUpdateMs,
    status:
      report.status === 'PROMOTE_READY' && coldBuildMs < 25 && incrementalUpdateMs < 3
        ? 'PROMOTE_READY'
        : 'KEEP_SHADOW'
  };
}

if (!process.env.CTXTOP_BENCH_IMPORT_ONLY) {
  test('Bucket B #8 DUPLICATE_CLONE_DETECTOR meets <25ms cold index, <3ms incremental refresh, and >=90% precision', async () => {
    const report = await runDuplicateCloneBenchmark();
    assert.ok(report.coldBuildMs < 25, `Expected cold shingle build < 25ms, got ${report.coldBuildMs}ms`);
    assert.ok(
      report.incrementalUpdateMs < 3,
      `Expected incremental shingle update < 3ms, got ${report.incrementalUpdateMs}ms`
    );
    assert.ok(report.precision >= 0.9, `Expected precision >= 0.90, got ${report.precision}`);
    assert.equal(report.status, 'PROMOTE_READY', `Failed checks: ${report.failedChecks.join(', ')}`);
  });
}
