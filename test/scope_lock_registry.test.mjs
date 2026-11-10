import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ScopeLockRegistry,
  deriveSessionClaimedPaths,
  loadRegistry,
  saveRegistry,
  isPidAlive,
  SCOPE_LOCK_CONSTANTS
} from '../src/core/telemetry/scope_lock_registry.mjs';
import { HandoffHydrationLauncher } from '../src/core/coach/handoff_hydrator.mjs';

test('ScopeLockRegistry (Task 4.4): deriveSessionClaimedPaths ignores completed [x] items and version strings, and includes modified dotfiles', () => {
  const sampleTaskMd = [
    '# Context Horizon (`v3.2.0`)',
    '- [x] Completed task in `src/core/completed_module.mjs` and `package.json`',
    '- [/] Active task in `src/core/active_module.mjs:176-199` (target `v3.1.0` -> `3.2.0`, saved `142.4k`)',
    '- [ ] Pending task in `sidecars/horizon-daemon/server.mjs`'
  ].join('\n');

  const sampleGitStatus = [
    ' M .gitignore',
    ' M .eslintrc.json',
    ' M src/core/modified.mjs',
    '?? .agents/scope-locks.json',
    '?? .agents/cache/sidecar.json'
  ].join('\n');

  const claimed = deriveSessionClaimedPaths({
    taskMdContent: sampleTaskMd,
    gitStatusOutput: sampleGitStatus
  });

  assert.deepEqual(claimed, [
    '.eslintrc.json',
    '.gitignore',
    'sidecars/horizon-daemon/server.mjs',
    'src/core/active_module.mjs',
    'src/core/modified.mjs'
  ]);
});

test('ScopeLockRegistry: acquires and renews leases, and evicts dead PIDs and expired TTLs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-lock-'));
  try {
    const registry = new ScopeLockRegistry({ workspaceDir: tmpDir, pid: process.pid });

    // 1. Acquire lease for trajectory-1
    const res1 = registry.acquireOrRenewLease({
      trajectoryId: 'traj-1',
      claimedPaths: ['src/core/router.mjs', 'src/core/constants.mjs'],
      ttlSeconds: 300
    });
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.collisionDetected, false);
    assert.strictEqual(res1.activeLeaseCount, 1);

    // Verify written to disk
    const diskReg = loadRegistry(tmpDir);
    assert.strictEqual(diskReg.leases.length, 1);
    assert.strictEqual(diskReg.leases[0].trajectoryId, 'traj-1');

    // 2. Add an expired lease manually and verify loadRegistry evicts it
    diskReg.leases.push({
      trajectoryId: 'expired-traj',
      pid: process.pid,
      claimedPaths: ['src/old.mjs'],
      expiresAtMs: Date.now() - 5000
    });
    // Add a dead PID lease (e.g. PID 999999)
    diskReg.leases.push({
      trajectoryId: 'dead-pid-traj',
      pid: 9999999,
      claimedPaths: ['src/dead.mjs'],
      expiresAtMs: Date.now() + 60000
    });
    saveRegistry(tmpDir, diskReg);

    const prunedReg = loadRegistry(tmpDir);
    // Both expired and dead PID should be pruned
    assert.strictEqual(prunedReg.leases.length, 1);
    assert.strictEqual(prunedReg.leases[0].trajectoryId, 'traj-1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ScopeLockRegistry: triggers DET-20 on concurrent file-scope collision', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-lock-'));
  try {
    const registryA = new ScopeLockRegistry({ workspaceDir: tmpDir, pid: process.pid, tool: 'antigravity' });
    const registryB = new ScopeLockRegistry({ workspaceDir: tmpDir, pid: process.pid, tool: 'cursor' });

    // Trajectory A claims core/router.mjs
    const leaseA = registryA.acquireOrRenewLease({
      trajectoryId: 'trajectory-alpha',
      claimedPaths: ['src/core/router.mjs', 'src/core/config.mjs']
    });
    assert.strictEqual(leaseA.ok, true);

    // Trajectory B attempts to claim non-overlapping file -> succeeds
    const leaseB_ok = registryB.acquireOrRenewLease({
      trajectoryId: 'trajectory-beta',
      claimedPaths: ['src/core/parser.mjs']
    });
    assert.strictEqual(leaseB_ok.ok, true);
    assert.strictEqual(leaseB_ok.collisionDetected, false);

    // Trajectory C attempts to claim src/core/router.mjs -> trips DET-20
    const leaseC = registryB.acquireOrRenewLease({
      trajectoryId: 'trajectory-gamma',
      claimedPaths: ['src/core/router.mjs', 'src/core/history.mjs']
    });

    assert.strictEqual(leaseC.ok, false);
    assert.strictEqual(leaseC.collisionDetected, true);
    assert.strictEqual(leaseC.detectorId, 'DET-20');
    assert.strictEqual(leaseC.conflictingTrajectoryId, 'trajectory-alpha');
    assert.deepEqual(leaseC.overlappingPaths, ['src/core/router.mjs']);
    assert.ok(leaseC.worktreeCommand.includes('git worktree add'));
    assert.ok(leaseC.warning.includes('[HORIZON DET-20]'));

    // Release lease A
    registryA.releaseLease('trajectory-alpha');
    const diskAfterRelease = loadRegistry(tmpDir);
    assert.strictEqual(diskAfterRelease.leases.some((l) => l.trajectoryId === 'trajectory-alpha'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HandoffHydrator: generates standardized cross-tool portable handoff markdown with DET-20 scope paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-portable-'));
  try {
    const launcher = new HandoffHydrationLauncher({ workspaceDir: tmpDir });
    const bundle = launcher.generateHandoffBundle({
      workspaceDir: tmpDir,
      taskMdContent: '- [/] Implement Ring 1 Hardening in src/core/router.mjs\n',
      gitDiffSummary: ' 1 file changed, 10 insertions(+)',
      verifiedSchemaFiles: ['src/core/constants.mjs'],
      ownedScopePaths: ['src/core/router.mjs'],
      negativeConstraints: [
        'NEVER modify AGENTS.md while cache is warm.',
        'NEVER delete existing test assertions.'
      ],
      timestamp: '2026-11-09T22-00-00'
    });

    // Check standardized headers
    assert.ok(bundle.markdown.includes('## 1. Resume Contract & Active Step'));
    assert.ok(bundle.markdown.includes('## 2. Verified Unchanged File Schemas (Skip Re-Reading)'));
    assert.ok(bundle.markdown.includes('## 3. Active File Diffs & Owned Scope Paths'));
    assert.ok(bundle.markdown.includes('## 4. Negative Constraints & Ruled-Out Approaches'));

    // Check owned scope paths section
    assert.ok(bundle.markdown.includes('### Owned Scope Paths (Concurrent Lockfile DET-20)'));
    assert.ok(bundle.markdown.includes('- `src/core/router.mjs`'));

    // Check verified schema files
    assert.ok(bundle.markdown.includes('- `src/core/constants.mjs`'));

    // Check constraints
    assert.ok(bundle.markdown.includes('NEVER modify AGENTS.md while cache is warm.'));

    // Check file on disk
    assert.ok(fs.existsSync(bundle.handoffAbsPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
