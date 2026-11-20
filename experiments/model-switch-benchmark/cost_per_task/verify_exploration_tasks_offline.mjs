#!/usr/bin/env node
/**
 * Offline Verification for Longer Multi-File Exploration Tasks (T09..T11):
 *   1. Copies task_repo_template -> applies 24-file exploration overlay (40 files total).
 *   2. Verifies baseline 9/9 tests still pass.
 *   3. Verifies visible & hidden suites FAIL on the unfixed overlaid repo.
 *   4. Applies reference solutions and verifies BOTH visible+baseline AND hidden+constraint suites PASS 100%.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXPLORATION_TASKS, applyExplorationOverlay } from './exploration_tasks_manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, 'task_repo_template');
const EXP_VISIBLE_DIR = path.join(__dirname, 'exploration_suites', 'visible');
const EXP_HIDDEN_DIR = path.join(__dirname, 'exploration_suites', 'hidden');
const EXP_REF_DIR = path.join(__dirname, 'exploration_suites', 'reference');

function walkFilesRel(rootDir, baseDir = rootDir, acc = []) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) walkFilesRel(full, baseDir, acc);
    else acc.push(path.relative(baseDir, full).replace(/\\/g, '/'));
  }
  return acc.sort();
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-verify-'));
  const summary = [];
  try {
    for (const task of EXPLORATION_TASKS) {
      const id = task.task_id;
      const work = path.join(tmpRoot, id);
      copyTree(TEMPLATE_DIR, work);
      const overlaid = applyExplorationOverlay(work, task);
      const repoFiles = walkFilesRel(work);
      assert.equal(overlaid.length, 24, `${id}: expected 24 overlay files, got ${overlaid.length}`);
      assert.equal(repoFiles.length, 40, `${id}: expected 40 total repo files, got ${repoFiles.length}`);

      let totalBytes = 0;
      for (const rel of repoFiles) totalBytes += fs.statSync(path.join(work, rel)).size;

      const baseRun = runNodeTest(work, listTestFiles(work));
      assert.equal(baseRun.status, 0, `${id}: baseline tests failed after overlay`);

      fs.copyFileSync(
        path.join(EXP_VISIBLE_DIR, `${id}.visible.test.mjs`),
        path.join(work, 'test', 'task_visible.test.mjs')
      );
      fs.copyFileSync(
        path.join(EXP_HIDDEN_DIR, `${id}.hidden.test.mjs`),
        path.join(work, '__hidden_eval__.test.mjs')
      );

      const preVis = runNodeTest(work, ['test/task_visible.test.mjs']);
      assert.notEqual(preVis.status, 0, `${id}: visible test unexpectedly PASSED before fix`);

      const preHid = runNodeTest(work, ['__hidden_eval__.test.mjs']);
      assert.notEqual(preHid.status, 0, `${id}: hidden test unexpectedly PASSED before fix`);

      copyTree(path.join(EXP_REF_DIR, id), work);

      const postVisAll = runNodeTest(work, listTestFiles(work));
      assert.equal(
        postVisAll.status,
        0,
        `${id}: visible+baseline suite FAILED after fix:\n${postVisAll.stdout}\n${postVisAll.stderr}`
      );

      const postHid = runNodeTest(work, ['__hidden_eval__.test.mjs']);
      assert.equal(
        postHid.status,
        0,
        `${id}: hidden+constraint suite FAILED after fix:\n${postHid.stdout}\n${postHid.stderr}`
      );

      summary.push({
        task_id: id,
        repoFiles: repoFiles.length,
        repoBytes: totalBytes,
        preFixFailed: true,
        postFixPassed: true
      });
    }
    console.log('EXPLORATION_TASKS_OFFLINE_PASS');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
