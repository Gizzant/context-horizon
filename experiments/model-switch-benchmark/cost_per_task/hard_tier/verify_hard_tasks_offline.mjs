#!/usr/bin/env node
/**
 * Offline Hard-Tier Task Verification ($0.00 spend):
 * 1. Verifies task_repo_hard_template has 18 files and passes baseline tests (11/11).
 * 2. For every task (H01..H06):
 *    - Proves visible suite FAILS on unfixed repo
 *    - Proves hidden suite FAILS on unfixed repo
 *    - Applies reference solution and proves BOTH baseline+visible AND hidden+constraints PASS 100%.
 * 3. Computes LF-normalized SHA-256 hashes and writes
 *    results/cost_per_task_raw/offline_hard_task_verification.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESULTS_DIR } from '../../config.mjs';
import { HARD_TASKS } from './hard_tasks_manifest.mjs';
import { assertNoSensitiveLeaks, redactSensitiveText } from '../../tests_3_to_8/prefix_lab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, 'task_repo_hard_template');
const VISIBLE_DIR = path.join(__dirname, 'visible_suites');
const HIDDEN_DIR = path.join(__dirname, 'hidden_suites');
const REF_DIR = path.join(__dirname, 'reference_solutions');
const MANIFEST_PATH = path.join(__dirname, 'hard_tasks_manifest.mjs');
const OUT_PATH = path.join(RESULTS_DIR, 'cost_per_task_raw', 'offline_hard_task_verification.json');

function walkFilesRel(rootDir, baseDir = rootDir, acc = []) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFilesRel(full, baseDir, acc);
    } else {
      acc.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return acc.sort();
}

export function hashFileLf(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function hashDirectoryLf(dirPath) {
  const files = walkFilesRel(dirPath);
  const perFile = {};
  const manifestLines = [];
  for (const rel of files) {
    const h = hashFileLf(path.join(dirPath, rel));
    perFile[rel] = h;
    manifestLines.push(`${rel}:${h}`);
  }
  const treeSha256 = crypto.createHash('sha256').update(manifestLines.join('\n') + '\n').digest('hex');
  return { fileCount: files.length, treeSha256, perFile };
}

function copyTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const rel of walkFilesRel(srcDir)) {
    const dest = path.join(dstDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), dest);
  }
}

function runNodeTest(cwd, targets = []) {
  return spawnSync(process.execPath, ['--test', ...targets], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000
  });
}

function listTestFiles(dir) {
  return fs
    .readdirSync(path.join(dir, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join('test', f));
}

function main() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-hard-verify-'));
  const results = [];

  try {
    // 1. Baseline check
    const baseDir = path.join(tmpRoot, 'baseline');
    copyTree(TEMPLATE_DIR, baseDir);
    const baseFiles = walkFilesRel(TEMPLATE_DIR);
    assert.equal(baseFiles.length, 18, `Expected 18 hard template files, found ${baseFiles.length}`);
    const baseRun = runNodeTest(baseDir, listTestFiles(baseDir));
    assert.equal(baseRun.status, 0, `Baseline tests failed:\n${baseRun.stdout}\n${baseRun.stderr}`);

    // 2. Per-task pre-fix FAIL & post-fix PASS verification
    for (const task of HARD_TASKS) {
      const id = task.task_id;
      const work = path.join(tmpRoot, id);
      copyTree(TEMPLATE_DIR, work);

      const visSrc = path.join(VISIBLE_DIR, `${id}.visible.test.mjs`);
      const hidSrc = path.join(HIDDEN_DIR, `${id}.hidden.test.mjs`);
      const refSrc = path.join(REF_DIR, id);

      fs.copyFileSync(visSrc, path.join(work, 'test', 'task_visible.test.mjs'));
      fs.copyFileSync(hidSrc, path.join(work, '__hidden_eval__.test.mjs'));

      const preVis = runNodeTest(work, ['test/task_visible.test.mjs']);
      assert.notEqual(preVis.status, 0, `${id}: visible test unexpectedly PASSED before fix`);

      const preHid = runNodeTest(work, ['__hidden_eval__.test.mjs']);
      assert.notEqual(preHid.status, 0, `${id}: hidden test unexpectedly PASSED before fix`);

      // Apply reference solution
      copyTree(refSrc, work);

      const postVisAll = runNodeTest(work, listTestFiles(work));
      assert.equal(
        postVisAll.status,
        0,
        `${id}: visible+baseline suite FAILED after reference solution:\n${postVisAll.stdout}\n${postVisAll.stderr}`
      );

      const postHid = runNodeTest(work, ['__hidden_eval__.test.mjs']);
      assert.equal(
        postHid.status,
        0,
        `${id}: hidden+constraint suite FAILED after reference solution:\n${postHid.stdout}\n${postHid.stderr}`
      );

      const passMatch = (postHid.stdout || '').match(/ℹ pass (\d+)/);
      const failMatch = (postHid.stdout || '').match(/ℹ fail (\d+)/);
      results.push({
        task_id: id,
        difficulty: task.difficulty,
        is_spare: task.is_spare,
        preFixVisibleExit: preVis.status,
        preFixHiddenExit: preHid.status,
        postFixVisibleExit: postVisAll.status,
        postFixHiddenExit: postHid.status,
        hiddenPassCount: passMatch ? Number(passMatch[1]) : null,
        hiddenFailCount: failMatch ? Number(failMatch[1]) : null,
        referenceFilesChanged: walkFilesRel(refSrc)
      });
    }

    const templateHashes = hashDirectoryLf(TEMPLATE_DIR);
    const visibleHashes = hashDirectoryLf(VISIBLE_DIR);
    const hiddenHashes = hashDirectoryLf(HIDDEN_DIR);
    const manifestSha256 = hashFileLf(MANIFEST_PATH);

    const payload = {
      generatedAtUtc: new Date().toISOString(),
      templateFileCount: templateHashes.fileCount,
      baselineTestsExitCode: baseRun.status,
      hashes: {
        task_repo_hard_template: templateHashes,
        visible_suites: visibleHashes,
        hidden_suites: hiddenHashes,
        hard_tasks_manifest_sha256: manifestSha256
      },
      tasksVerified: results
    };

    const rawJson = redactSensitiveText(JSON.stringify(payload, null, 2));
    assertNoSensitiveLeaks(rawJson, 'offline_hard_task_verification.json');
    fs.writeFileSync(OUT_PATH, rawJson + '\n', 'utf8');

    console.log('OFFLINE_HARD_TASK_VERIFICATION_PASS');
    console.log(JSON.stringify({
      templateFileCount: templateHashes.fileCount,
      templateTreeSha256: templateHashes.treeSha256,
      visibleTreeSha256: visibleHashes.treeSha256,
      hiddenTreeSha256: hiddenHashes.treeSha256,
      manifestSha256,
      verifiedCount: results.length,
      allFailedPreFix: results.every((r) => r.preFixVisibleExit !== 0 && r.preFixHiddenExit !== 0),
      allPassedPostFix: results.every((r) => r.postFixVisibleExit === 0 && r.postFixHiddenExit === 0)
    }, null, 2));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
