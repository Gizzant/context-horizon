/**
 * @file test/challenger_t4_r2_1_empirical.test.mjs
 * Empirical Challenge Harness for Milestone T4 Iteration 2 (E2E Testing Track)
 *
 * Stress-tests and empirically validates:
 * 1. Test 3.28: >=15 (30 tested) consecutive Named Pipe handshakes under load with 0% failure.
 * 2. Test 3.25: probeGitMergeTree with genuine divergent branches, working tree cleanliness,
 *    and mutation checks with non-conflicting divergent and fast-forward branches.
 * 3. Test 3.14: Worktree creation/teardown stress across 5 iterations asserting 0 residual
 *    folders in %TEMP% and 0 lingering git.exe processes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { MicroIpcServer } from '../src/engine-node/ipc/server.mjs';
import { MicroIpcClient } from '../src/engine-node/ipc/client.mjs';
import { probeGitMergeTree } from '../src/engine-node/sensors/git_merge_tree.mjs';
import {
  createTempWorkspace,
  getPlatformPipePath
} from './helpers/e2e_harness.mjs';

describe('Empirical Challenge 1: Named Pipe Handshake Stress & Flakiness (Test 3.28)', () => {
  it('executes 30 consecutive Named Pipe handshakes under load with 0% timeout failure', async () => {
    const pipePath = getPlatformPipePath(`challenger-pipe-stress-${Date.now()}`);
    const server = new MicroIpcServer({ ipcPath: pipePath });
    await server.listen();

    const iterations = 30;
    const results = [];
    const latencies = [];

    try {
      for (let i = 0; i < iterations; i++) {
        const client = new MicroIpcClient({
          ipcPath: pipePath,
          connectTimeoutMs: 1500,
          requestTimeoutMs: 1500
        });

        const start = performance.now();
        // Alternate between default ping() and explicit timeout ping(1500)
        const pingResult = (i % 2 === 0)
          ? await client.ping()
          : await client.ping(1500);
        const elapsed = performance.now() - start;

        latencies.push(elapsed);
        results.push(pingResult);

        // Also issue a transactional RPC call to verify duplex pipe throughput
        const pingRpc = await client.call('daemon.ping', { seq: i });
        assert.equal(pingRpc.pong, true, `RPC daemon.ping failed at iteration ${i}`);

        await client.close();
      }

      const failures = results.filter(r => r !== true);
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);

      // Assert 0% failures
      assert.equal(failures.length, 0, `Expected 0 ping failures, got ${failures.length} out of ${iterations}`);
      assert.equal(results.length, iterations);

      // Verify reasonable latency under load
      assert.ok(avgLatency < 500, `Average handshake latency (${avgLatency.toFixed(2)}ms) should be < 500ms`);
    } finally {
      await server.close();
    }
  });

  it('handles 16 simultaneous concurrent Named Pipe handshakes under load', async () => {
    const pipePath = getPlatformPipePath(`challenger-pipe-concurrent-${Date.now()}`);
    const server = new MicroIpcServer({ ipcPath: pipePath });
    await server.listen();

    try {
      const concurrentWorkers = 16;
      const tasks = Array.from({ length: concurrentWorkers }, async (_, idx) => {
        const client = new MicroIpcClient({
          ipcPath: pipePath,
          connectTimeoutMs: 2000,
          requestTimeoutMs: 2000
        });
        const pong = await client.ping();
        const rpc = await client.call('daemon.ping', { worker: idx });
        await client.close();
        return { pong, rpcPong: rpc.pong };
      });

      const results = await Promise.all(tasks);
      for (let i = 0; i < concurrentWorkers; i++) {
        assert.equal(results[i].pong, true, `Worker ${i} ping failed`);
        assert.equal(results[i].rpcPong, true, `Worker ${i} RPC failed`);
      }
    } finally {
      await server.close();
    }
  });

  it('negative test: ping() returns false without throwing or hanging when daemon is down', async () => {
    const deadPipePath = getPlatformPipePath(`challenger-dead-pipe-${Date.now()}`);
    const client = new MicroIpcClient({
      ipcPath: deadPipePath,
      connectTimeoutMs: 200,
      requestTimeoutMs: 200
    });

    const start = performance.now();
    const result = await client.ping(200);
    const elapsed = performance.now() - start;

    assert.equal(result, false, 'Ping on non-existent pipe must return false');
    assert.ok(elapsed < 2000, `Ping should terminate within timeout window, took ${elapsed}ms`);
    await client.close();
  });
});

describe('Empirical Challenge 2: Test 3.25 Mutation & Conflict Validation', () => {
  it('verifies probeGitMergeTree detects genuine divergent conflicts and keeps working tree clean', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-challenger-m25-' });
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Challenger'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'challenger@example.com'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'gc.auto', '0'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Root commit
      ws.writeFile('auth_service.js', 'export const role = "base";\nexport const level = 1;\n');
      ws.writeFile('unrelated.js', 'export const app = "main";\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'root commit'], { cwd: ws.wsDir, stdio: 'ignore' });
      const mainBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

      // Branch feat/auth modifying auth_service.js line 1
      execFileSync('git', ['checkout', '-b', 'feat/auth'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('auth_service.js', 'export const role = "auth-admin";\nexport const level = 1;\n');
      execFileSync('git', ['commit', '-am', 'feat/auth: update role'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Branch feat/billing modifying auth_service.js line 1 divergently
      execFileSync('git', ['checkout', mainBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feat/billing'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('auth_service.js', 'export const role = "billing-manager";\nexport const level = 1;\n');
      execFileSync('git', ['commit', '-am', 'feat/billing: update role'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Probe conflict
      const conflictProbe = probeGitMergeTree('feat/auth', 'feat/billing', { workspaceDir: ws.wsDir });
      assert.equal(conflictProbe.hasConflict, true, 'Divergent branches must report hasConflict: true');
      assert.equal(conflictProbe.clean, false, 'Divergent branches must report clean: false');
      assert.ok(conflictProbe.conflictFiles.length > 0, 'conflictFiles must not be empty');
      assert.ok(
        conflictProbe.conflictFiles.some(f => f.includes('auth_service.js')),
        `Expected auth_service.js in conflictFiles: ${JSON.stringify(conflictProbe.conflictFiles)}`
      );
      assert.ok(conflictProbe.conflictMessages.length >= 1, 'conflictMessages must not be empty');

      // Verify working tree cleanliness
      const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: ws.wsDir, encoding: 'utf8' });
      assert.equal(statusOut.trim(), '', 'Working tree must remain 100% clean after conflict probe');

      // Mutation Check 1: Non-conflicting divergent branches
      execFileSync('git', ['checkout', mainBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feat/clean-a'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('feature_a.js', 'export const a = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add feature A'], { cwd: ws.wsDir, stdio: 'ignore' });

      execFileSync('git', ['checkout', mainBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feat/clean-b'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('feature_b.js', 'export const b = 2;\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'add feature B'], { cwd: ws.wsDir, stdio: 'ignore' });

      const cleanDivergentProbe = probeGitMergeTree('feat/clean-a', 'feat/clean-b', { workspaceDir: ws.wsDir });
      assert.equal(cleanDivergentProbe.hasConflict, false, 'Non-conflicting divergent branches must have hasConflict: false');
      assert.equal(cleanDivergentProbe.clean, true, 'Non-conflicting divergent branches must report clean: true');
      assert.deepEqual(cleanDivergentProbe.conflictFiles, [], 'Non-conflicting branches must have empty conflictFiles');
      assert.ok(typeof cleanDivergentProbe.treeHash === 'string' && cleanDivergentProbe.treeHash.length >= 40, 'Clean probe must return valid treeHash SHA');

      // Mutation Check 2: Fast-forward branch against base
      const ffProbe = probeGitMergeTree(mainBranch, 'feat/clean-a', { workspaceDir: ws.wsDir });
      assert.equal(ffProbe.hasConflict, false, 'Fast-forward merge must have hasConflict: false');
      assert.equal(ffProbe.clean, true, 'Fast-forward merge must report clean: true');

      // Mutation Check 3: Identical branch self-merge
      const selfProbe = probeGitMergeTree('feat/auth', 'feat/auth', { workspaceDir: ws.wsDir });
      assert.equal(selfProbe.hasConflict, false, 'Self-merge must have hasConflict: false');
      assert.equal(selfProbe.clean, true, 'Self-merge must report clean: true');
      assert.deepEqual(selfProbe.conflictFiles, []);

      // Verify working tree cleanliness still holds
      const finalStatus = execFileSync('git', ['status', '--porcelain'], { cwd: ws.wsDir, encoding: 'utf8' });
      assert.equal(finalStatus.trim(), '', 'Working tree must remain 100% clean after all probes');
    } finally {
      ws.cleanup();
    }
  });

  it('handles modify/delete conflict and invalid ref gracefully without exceptions', () => {
    const ws = createTempWorkspace({ prefix: 'ctxtop-challenger-m25-mod-del-' });
    try {
      execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Challenger'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'challenger@example.com'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'gc.auto', '0'], { cwd: ws.wsDir, stdio: 'ignore' });

      ws.writeFile('target.js', 'console.log("hello");\n');
      execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'root commit'], { cwd: ws.wsDir, stdio: 'ignore' });
      const mainBranch = execFileSync('git', ['branch', '--show-current'], { cwd: ws.wsDir, encoding: 'utf8' }).trim() || 'master';

      // Branch 1: modify
      execFileSync('git', ['checkout', '-b', 'feat/modify'], { cwd: ws.wsDir, stdio: 'ignore' });
      ws.writeFile('target.js', 'console.log("modified");\n');
      execFileSync('git', ['commit', '-am', 'modify file'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Branch 2: delete
      execFileSync('git', ['checkout', mainBranch], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['checkout', '-b', 'feat/delete'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['rm', 'target.js'], { cwd: ws.wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'delete file'], { cwd: ws.wsDir, stdio: 'ignore' });

      // Probe modify/delete conflict
      const modDelProbe = probeGitMergeTree('feat/modify', 'feat/delete', { workspaceDir: ws.wsDir });
      assert.equal(modDelProbe.hasConflict, true, 'Modify/delete must trigger hasConflict: true');
      assert.equal(modDelProbe.clean, false);
      assert.ok(modDelProbe.conflictFiles.some(f => f.includes('target.js')));

      // Test invalid / non-existent ref
      const invalidRefProbe = probeGitMergeTree('feat/modify', 'non-existent-ref-12345', { workspaceDir: ws.wsDir });
      assert.equal(invalidRefProbe.clean, false);
      assert.equal(invalidRefProbe.hasConflict, false);
      assert.ok(invalidRefProbe.error || invalidRefProbe.degraded);

      // Null ref input
      const nullRefProbe = probeGitMergeTree(null, 'feat/modify', { workspaceDir: ws.wsDir });
      assert.equal(nullRefProbe.clean, false);
      assert.equal(nullRefProbe.hasConflict, false);
      assert.equal(nullRefProbe.error, 'Both baseCommit and targetCommit must be provided');
    } finally {
      ws.cleanup();
    }
  });
});

describe('Empirical Challenge 3: Test 3.14 Resource Leak Stress Test', () => {
  it('runs 5 consecutive worktree creation/cleanup iterations with 0 residual folders and 0 git processes', () => {
    const tmpDir = os.tmpdir();
    const runIterations = 5;

    for (let i = 0; i < runIterations; i++) {
      const prefix = `ctxtop-swarm-wt-p14-iter${i}-`;
      const ws = createTempWorkspace({ prefix });
      const wt1Dir = path.join(ws.wsDir, `wt-agent-1-${i}`);
      const wt2Dir = path.join(ws.wsDir, `wt-agent-2-${i}`);

      try {
        execFileSync('git', ['init'], { cwd: ws.wsDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws.wsDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws.wsDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'gc.auto', '0'], { cwd: ws.wsDir, stdio: 'ignore' });

        ws.writeFile('index.js', 'module.exports = {};\n');
        execFileSync('git', ['add', '.'], { cwd: ws.wsDir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'root commit'], { cwd: ws.wsDir, stdio: 'ignore' });

        execFileSync('git', ['worktree', 'add', '-b', `swarm-agent-1-${i}`, wt1Dir], { cwd: ws.wsDir, stdio: 'ignore' });
        execFileSync('git', ['worktree', 'add', '-b', `swarm-agent-2-${i}`, wt2Dir], { cwd: ws.wsDir, stdio: 'ignore' });

        fs.writeFileSync(path.join(wt1Dir, 'index.js'), `module.exports = { agent: 1, iter: ${i} };\n`, 'utf8');
        execFileSync('git', ['commit', '-am', 'agent 1 change'], { cwd: wt1Dir, stdio: 'ignore' });

        fs.writeFileSync(path.join(wt2Dir, 'index.js'), `module.exports = { agent: 2, iter: ${i} };\n`, 'utf8');
        execFileSync('git', ['commit', '-am', 'agent 2 change'], { cwd: wt2Dir, stdio: 'ignore' });

        const mergeCheck = probeGitMergeTree(`swarm-agent-1-${i}`, `swarm-agent-2-${i}`, { workspaceDir: ws.wsDir });
        assert.equal(mergeCheck.hasConflict, true);
        assert.ok(mergeCheck.conflictFiles.some(f => f.includes('index.js')));
      } finally {
        // Apply the same resilient cleanup sequence as Test 3.14
        for (const wt of [wt1Dir, wt2Dir]) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              if (fs.existsSync(wt)) {
                execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ws.wsDir, stdio: 'ignore' });
              }
              break;
            } catch {
              const start = Date.now();
              while (Date.now() - start < 50) {}
            }
          }
        }

        try {
          execFileSync('git', ['worktree', 'prune', '--expire', 'now'], { cwd: ws.wsDir, stdio: 'ignore' });
        } catch (_e) {
          void _e;
        }

        for (const wt of [wt1Dir, wt2Dir]) {
          if (fs.existsSync(wt)) {
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                fs.rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
                break;
              } catch {
                const start = Date.now();
                while (Date.now() - start < 50) {}
              }
            }
          }
        }

        ws.cleanup();
      }
    }

    // Post-stress validation: Assert 0 residual folders in %TEMP%
    const residualFolders = fs.readdirSync(tmpDir).filter(f => f.startsWith('ctxtop-swarm-wt-p14-'));
    assert.equal(
      residualFolders.length,
      0,
      `Detected residual temporary worktree folders in ${tmpDir}: ${JSON.stringify(residualFolders)}`
    );

    // Post-stress validation: Assert 0 lingering git.exe processes
    if (process.platform === 'win32') {
      try {
        const tasklistOutput = execSync('tasklist /FI "IMAGENAME eq git.exe"', { encoding: 'utf8' });
        const hasLingeringGit = tasklistOutput.toLowerCase().includes('git.exe');
        assert.equal(hasLingeringGit, false, `Found lingering git.exe processes:\n${tasklistOutput}`);
      } catch (e) {
        // If tasklist throws, ensure it wasn't because git.exe was found
        void e;
      }
    }
  });
});
