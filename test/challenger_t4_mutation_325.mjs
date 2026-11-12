import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTempWorkspace } from './helpers/e2e_harness.mjs';
import { probeGitMergeTree } from '../src/engine-node/sensors/git_merge_tree.mjs';

console.log('Starting Empirical Mutation & Cleanliness Harness for DET-31 probeGitMergeTree (Test 3.25)...');

const ws = createTempWorkspace({ prefix: 'ctxtop-mut-p25-' });

try {
  // Initialize repository
  execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test Challenger'], { cwd: ws.wsDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'challenger@example.com'], { cwd: ws.wsDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: ws.wsDir, stdio: 'ignore' });

  // Initial root commit
  ws.writeFile('common.js', 'console.log("root");\n');
  ws.writeFile('orthogonal_a.js', 'const A = 1;\n');
  ws.writeFile('orthogonal_b.js', 'const B = 2;\n');
  execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'root commit'], { cwd: ws.wsDir, stdio: 'ignore' });

  const defaultBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

  // Branch 1: conflict_1
  execFileSync('git', ['checkout', '-b', 'feat/conflict-1'], { cwd: ws.wsDir, stdio: 'ignore' });
  ws.writeFile('common.js', 'console.log("version 1");\n');
  execFileSync('git', ['commit', '-am', 'feat/conflict-1 edit common.js'], { cwd: ws.wsDir, stdio: 'ignore' });

  // Branch 2: conflict_2 (diverges from root with conflicting edit to common.js)
  execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-b', 'feat/conflict-2'], { cwd: ws.wsDir, stdio: 'ignore' });
  ws.writeFile('common.js', 'console.log("version 2 conflict");\n');
  execFileSync('git', ['commit', '-am', 'feat/conflict-2 conflicting edit common.js'], { cwd: ws.wsDir, stdio: 'ignore' });

  // Branch 3: orthogonal_1 (edits orthogonal_a.js)
  execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-b', 'feat/ortho-1'], { cwd: ws.wsDir, stdio: 'ignore' });
  ws.writeFile('orthogonal_a.js', 'const A = 100;\n');
  execFileSync('git', ['commit', '-am', 'feat/ortho-1 edit A'], { cwd: ws.wsDir, stdio: 'ignore' });

  // Branch 4: orthogonal_2 (edits orthogonal_b.js)
  execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-b', 'feat/ortho-2'], { cwd: ws.wsDir, stdio: 'ignore' });
  ws.writeFile('orthogonal_b.js', 'const B = 200;\n');
  execFileSync('git', ['commit', '-am', 'feat/ortho-2 edit B'], { cwd: ws.wsDir, stdio: 'ignore' });

  // Switch back to defaultBranch to verify state
  execFileSync('git', ['checkout', defaultBranch], { cwd: ws.wsDir, stdio: 'ignore' });

  // -------------------------------------------------------------
  // Test Case 1: Injected Conflicting Commits
  // -------------------------------------------------------------
  console.log('1. Probing injected conflicting commits (feat/conflict-1 vs feat/conflict-2)...');
  const conflictProbe = probeGitMergeTree('feat/conflict-1', 'feat/conflict-2', { workspaceDir: ws.wsDir });
  assert.equal(conflictProbe.clean, false, 'Probe must report clean=false for conflicting commits');
  assert.equal(conflictProbe.hasConflict, true, 'Probe must report hasConflict=true');
  assert.ok(conflictProbe.conflictFiles.some(f => f.includes('common.js')), 'conflictFiles must contain common.js');
  assert.ok(conflictProbe.conflictMessages.length >= 1, 'conflictMessages must contain details');
  console.log(`✓ Conflict caught correctly: files=[${conflictProbe.conflictFiles}], latency=${conflictProbe.latencyMs}ms`);

  // -------------------------------------------------------------
  // Test Case 2: Zero Working Tree Mutation / Index Cleanliness
  // -------------------------------------------------------------
  console.log('2. Verifying working tree and index cleanliness after conflict probe...');
  const statusAfterConflict = execFileSync('git', ['status', '--porcelain'], { cwd: ws.wsDir, encoding: 'utf8' });
  assert.equal(statusAfterConflict.trim(), '', 'Working tree must remain 100% clean (git status --porcelain is empty)');

  const unmergedStages = execFileSync('git', ['ls-files', '-u'], { cwd: ws.wsDir, encoding: 'utf8' });
  assert.equal(unmergedStages.trim(), '', 'Index must have 0 unmerged stages');

  const diffOutput = execFileSync('git', ['diff'], { cwd: ws.wsDir, encoding: 'utf8' });
  assert.equal(diffOutput.trim(), '', 'Working tree git diff must be empty');

  const currentBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim();
  assert.equal(currentBranch, defaultBranch, 'Current branch must remain unchanged');
  console.log('✓ Working tree, index, diff, and HEAD are 100% clean and unmoved.');

  // -------------------------------------------------------------
  // Test Case 3: Self-Merge Verification (baseCommit === targetCommit)
  // -------------------------------------------------------------
  console.log('3. Verifying self-merges (feat/conflict-1 vs feat/conflict-1)...');
  const selfMerge = probeGitMergeTree('feat/conflict-1', 'feat/conflict-1', { workspaceDir: ws.wsDir });
  assert.equal(selfMerge.clean, true, 'Self-merge must report clean=true');
  assert.equal(selfMerge.hasConflict, false, 'Self-merge must report hasConflict=false');
  assert.deepEqual(selfMerge.conflictFiles, [], 'Self-merge must have 0 conflict files');
  assert.ok(selfMerge.treeHash && selfMerge.treeHash.length > 0, 'Self-merge must produce treeHash');
  console.log(`✓ Self-merge passed cleanly (treeHash=${selfMerge.treeHash}, latency=${selfMerge.latencyMs}ms).`);

  // -------------------------------------------------------------
  // Test Case 4: Non-conflicting divergent branches (orthogonal changes)
  // -------------------------------------------------------------
  console.log('4. Verifying orthogonal merge (feat/ortho-1 vs feat/ortho-2)...');
  const orthoMerge = probeGitMergeTree('feat/ortho-1', 'feat/ortho-2', { workspaceDir: ws.wsDir });
  assert.equal(orthoMerge.clean, true, 'Orthogonal branches must merge cleanly');
  assert.equal(orthoMerge.hasConflict, false, 'Orthogonal branches must have no conflict');
  assert.deepEqual(orthoMerge.conflictFiles, []);
  assert.ok(orthoMerge.treeHash);
  console.log(`✓ Orthogonal merge passed cleanly (treeHash=${orthoMerge.treeHash}, latency=${orthoMerge.latencyMs}ms).`);

  // -------------------------------------------------------------
  // Test Case 5: Mutation Testing - Corrupt / Non-existent ref handling
  // -------------------------------------------------------------
  console.log('5. Mutation: invalid ref handling (non-existent-ref-abc)...');
  const invalidProbe = probeGitMergeTree('feat/conflict-1', 'non-existent-ref-abc', { workspaceDir: ws.wsDir });
  assert.equal(invalidProbe.clean, false);
  assert.equal(invalidProbe.hasConflict, false);
  assert.equal(invalidProbe.degraded, true);
  assert.ok(invalidProbe.error && invalidProbe.error.length > 0);
  console.log('✓ Invalid ref degrades gracefully without throwing.');

  // -------------------------------------------------------------
  // Test Case 6: Mutation Testing - Missing parameter handling
  // -------------------------------------------------------------
  console.log('6. Mutation: missing commit parameters...');
  const missingProbe = probeGitMergeTree(null, 'feat/conflict-1');
  assert.equal(missingProbe.clean, false);
  assert.equal(missingProbe.hasConflict, false);
  assert.ok(missingProbe.error);
  console.log('✓ Missing parameters rejected gracefully.');

  console.log('\n[ALL TEST 3.25 DET-31 EMPIRICAL MUTATION & CLEANLINESS TESTS PASSED]');
} finally {
  ws.cleanup();
}
