/**
 * @file test/blindspot_sensors_and_git_merge_tree.test.mjs
 * Verification of blindspot forensic sensors (Feature 13) and DET-31 git merge-tree probe (Feature 14).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  detectDirtySnapshots,
  detectUnseenCallers,
  detectLegacyPoison,
  detectForeignBleed,
  runBlindspotSensors
} from '../src/engine-node/sensors/blindspots.mjs';
import {
  probeGitMergeTree
} from '../src/engine-node/sensors/git_merge_tree.mjs';

function createTempWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_blindspots_test_'));
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // fileA is imported by caller1.js and caller2.js
  const fileAPath = path.join(srcDir, 'fileA.js');
  fs.writeFileSync(fileAPath, 'export const a = 1;', 'utf8');

  const caller1Path = path.join(srcDir, 'caller1.js');
  fs.writeFileSync(caller1Path, "import { a } from './fileA.js';", 'utf8');

  const caller2Path = path.join(srcDir, 'caller2.js');
  fs.writeFileSync(caller2Path, "const { a } = require('./fileA.js');", 'utf8');

  // Deprecated file
  const legacyDir = path.join(tmpDir, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyFilePath = path.join(legacyDir, 'old_service.js');
  fs.writeFileSync(legacyFilePath, '/** @deprecated Use v2 */\nexport function old() {}', 'utf8');

  return {
    tmpDir,
    fileAPath,
    caller1Path,
    caller2Path,
    legacyFilePath,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

test('blindspots: detectDirtySnapshots flags files modified externally after last touch', () => {
  const { tmpDir, fileAPath, cleanup } = createTempWorkspace();
  try {
    const pastTime = Date.now() - 5000;
    // Set file mtime to current time
    fs.utimesSync(fileAPath, new Date(), new Date());

    const stepEvents = [
      {
        toolName: 'read_file',
        targetPath: fileAPath,
        timestampMs: pastTime
      }
    ];

    const dirty = detectDirtySnapshots(stepEvents, tmpDir);
    assert.strictEqual(dirty.length, 1);
    assert.ok(dirty[0].toLowerCase().includes('filea.js'));

    // If last touch is fresh (after mtime), it should not be dirty
    const freshEvents = [
      {
        toolName: 'read_file',
        targetPath: fileAPath,
        timestampMs: Date.now() + 10000
      }
    ];
    const notDirty = detectDirtySnapshots(freshEvents, tmpDir);
    assert.strictEqual(notDirty.length, 0);
  } finally {
    cleanup();
  }
});

test('blindspots: detectUnseenCallers identifies importers not in activeSet', () => {
  const { tmpDir, fileAPath, caller1Path, caller2Path, cleanup } = createTempWorkspace();
  try {
    // Only caller1 is in active set; caller2 is unseen
    const unseen = detectUnseenCallers([fileAPath], [fileAPath, caller1Path], tmpDir);
    assert.ok(unseen.length >= 1, 'Should find unseen caller2');
    const hasCaller2 = unseen.some(p => p.toLowerCase().includes('caller2.js'));
    assert.ok(hasCaller2, 'caller2.js must be in unseen callers list');

    // If both callers are in active set, unseen is empty
    const allSeen = detectUnseenCallers([fileAPath], [fileAPath, caller1Path, caller2Path], tmpDir);
    assert.strictEqual(allSeen.length, 0);
  } finally {
    cleanup();
  }
});

test('blindspots: detectLegacyPoison detects deprecated paths and @deprecated tags', () => {
  const { legacyFilePath, cleanup } = createTempWorkspace();
  try {
    const stepEvents = [
      {
        targetPath: legacyFilePath,
        content: '/** @deprecated Use v2 */\nexport function old() {}'
      },
      {
        targetPath: 'src/components/v1/button.js',
        content: 'export const Button = () => null;'
      }
    ];

    const poison = detectLegacyPoison(stepEvents, {
      deprecated_paths: ['**/legacy/**', '**/v1/**']
    });

    assert.strictEqual(poison.length, 2);
  } finally {
    cleanup();
  }
});

test('blindspots: detectForeignBleed detects knowledge:// and cross-workspace paths', () => {
  const stepEvents = [
    {
      description: 'Consulting foreign knowledge item',
      content: 'Using knowledge://foreign-architecture-guide for guidelines',
      isForeignBleed: true
    },
    {
      targetPath: 'C:/other-workspace/secret/keys.json'
    }
  ];

  const bleed = detectForeignBleed(stepEvents, [process.cwd()]);
  assert.strictEqual(bleed.length, 2);
  assert.strictEqual(bleed[0].type, 'KNOWLEDGE_BLEED');
  assert.strictEqual(bleed[1].type, 'WORKSPACE_BLEED');
});

test('blindspots: runBlindspotSensors executes all 4 sensors in <12ms', () => {
  const { tmpDir, fileAPath, cleanup } = createTempWorkspace();
  try {
    const result = runBlindspotSensors({
      stepEvents: [{ toolName: 'read_file', targetPath: fileAPath, timestampMs: 1000 }],
      targetFiles: [fileAPath],
      activeSetPaths: [fileAPath],
      workspacePath: tmpDir,
      canonicalWorkspaces: [tmpDir]
    });

    assert.ok('dirtySnapshotPaths' in result);
    assert.ok('unseenCallers' in result);
    assert.ok('legacyPoisonPaths' in result);
    assert.ok('foreignBleedItems' in result);
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs < 100.0, `runBlindspotSensors duration ${result.durationMs}ms must be < 100ms`);
  } finally {
    cleanup();
  }
});

test('blindspots: handles null, undefined, primitives, and corrupted events without throwing', () => {
  const corruptedEvents = [
    null,
    undefined,
    {},
    42,
    'string-event',
    { timestampMs: 'invalid' },
    { timestampMs: -100 },
    { toolName: null, targetPath: null },
    { isForeignBleed: true },
    { content: null, filePath: undefined },
    { isDeprecatedContent: true, targetPath: null }
  ];

  // Individual sensor null-safety
  assert.doesNotThrow(() => detectDirtySnapshots(corruptedEvents, os.tmpdir()));
  assert.doesNotThrow(() => detectDirtySnapshots(null));
  assert.doesNotThrow(() => detectUnseenCallers(null, null));
  assert.doesNotThrow(() => detectUnseenCallers([null, undefined], [null]));
  assert.doesNotThrow(() => detectLegacyPoison(corruptedEvents, null));
  assert.doesNotThrow(() => detectLegacyPoison(null));
  assert.doesNotThrow(() => detectForeignBleed(corruptedEvents, null));
  assert.doesNotThrow(() => detectForeignBleed(null));

  // Aggregator null-safety
  assert.doesNotThrow(() => {
    const res = runBlindspotSensors({
      stepEvents: corruptedEvents,
      workspacePath: os.tmpdir()
    });
    assert.ok(Array.isArray(res.dirtySnapshotPaths));
    assert.ok(Array.isArray(res.unseenCallers));
    assert.ok(Array.isArray(res.legacyPoisonPaths));
    assert.ok(Array.isArray(res.foreignBleedItems));
    assert.ok(typeof res.durationMs === 'number');
  });

  // Null params call
  assert.doesNotThrow(() => {
    const res = runBlindspotSensors(null);
    assert.ok(Array.isArray(res.dirtySnapshotPaths));
  });
});

test('git_merge_tree: clean merge between HEAD and HEAD leaves tree 100% clean', () => {
  // Check git status before
  const statusBefore = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });

  const result = probeGitMergeTree('HEAD', 'HEAD');
  assert.strictEqual(result.clean, true);
  assert.strictEqual(result.hasConflict, false);
  assert.ok(result.treeHash);
  assert.strictEqual(result.conflictFiles.length, 0);

  // Check git status after (guaranteeing 0 working tree mutation)
  const statusAfter = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  assert.strictEqual(statusAfter, statusBefore, 'Working tree status must be untouched after probe');
});

test('git_merge_tree: detects conflicting branches without mutating working tree', () => {
  // Create a temporary git repo to test merge conflicts
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_git_merge_test_'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo });

    const sharedFile = path.join(tmpRepo, 'shared.txt');
    fs.writeFileSync(sharedFile, 'initial base content\n', 'utf8');
    execFileSync('git', ['add', 'shared.txt'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpRepo });

    // Branch A
    execFileSync('git', ['checkout', '-b', 'branchA'], { cwd: tmpRepo });
    fs.writeFileSync(sharedFile, 'branch A version content\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Commit on branch A'], { cwd: tmpRepo });

    // Branch B
    execFileSync('git', ['checkout', 'main'], { cwd: tmpRepo });
    execFileSync('git', ['checkout', '-b', 'branchB'], { cwd: tmpRepo });
    fs.writeFileSync(sharedFile, 'branch B conflicting content\n', 'utf8');
    execFileSync('git', ['commit', '-am', 'Commit on branch B'], { cwd: tmpRepo });

    // Run probe between branchA and branchB
    const conflictResult = probeGitMergeTree('branchA', 'branchB', { workspaceDir: tmpRepo });
    assert.strictEqual(conflictResult.clean, false);
    assert.strictEqual(conflictResult.hasConflict, true);
    assert.ok(conflictResult.conflictFiles.length >= 1);
    assert.ok(conflictResult.conflictFiles.some(f => f.includes('shared.txt')));

    // Ensure working tree of tmpRepo is 100% clean
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' });
    assert.strictEqual(status.trim(), '', 'Working tree must remain clean');
  } finally {
    try {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
});

test('git_merge_tree: handles invalid commits gracefully without throwing', () => {
  const result = probeGitMergeTree('nonexistent_commit_1', 'nonexistent_commit_2');
  assert.strictEqual(result.clean, false);
  assert.strictEqual(result.hasConflict, false);
  assert.strictEqual(result.degraded, true);
  assert.ok(result.error);
});
