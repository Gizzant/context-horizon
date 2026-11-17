/**
 * @file test/windows_hook_latency_and_rsl_opt.test.mjs
 * Regression tests for Windows Hook Latency Reduction (thin fast-shells, warm daemon
 * Micro-IPC RPC bridge, conservative bounded-read fast-path, RSL PostToolUse matcher
 * narrowing + single-spawn folding, and lightweight `code_fold_lite.mjs`).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { MicroIpcServer } from '../src/engine-node/ipc/server.mjs';
import { registerDaemonHookRpcMethods } from '../src/hooks/daemon_hook_bridge.mjs';
import { canFastAllowBoundedRead } from '../src/hooks/fast_hook_ipc.mjs';
import {
  RSL_ANTIGRAVITY_POST_TOOL_MATCHER,
  RSL_CLAUDE_POST_TOOL_MATCHER,
  isMutatingOrExecRslTool
} from '../src/core/rsl_triage.mjs';
import {
  handleAntigravityRslHook,
  syncAntigravityWorkspaceRslHooks
} from '../src/hooks/antigravity_rsl_hook.mjs';
import {
  handleClaudeRslHook,
  syncClaudeWorkspaceRslHooks
} from '../src/hooks/claude_rsl_hook.mjs';
import { handlePostInvocation } from '../src/hooks/post_invocation.mjs';
import { buildRslPostmortemHooksBlock } from '../scripts/sync_mirrors.mjs';
import * as codeFoldLite from '../src/core/code_fold_lite.mjs';
import * as prunerMod from '../src/core/pruner.mjs';

const REPO_ROOT = process.cwd();
const CC_PRE_TOOL = path.join(REPO_ROOT, 'hooks', 'handlers', 'pre-tool-use.mjs');
const CC_POST_TOOL = path.join(REPO_ROOT, 'hooks', 'handlers', 'post-tool-use.mjs');
const AG_PRE_INV = path.join(REPO_ROOT, 'src', 'hooks', 'pre_invocation.mjs');
const AG_POST_INV = path.join(REPO_ROOT, 'src', 'hooks', 'post_invocation.mjs');

function makeTmpDir(prefix = 'ctxtop-lat-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    assert.ok(err instanceof Error);
  }
}

function spawnHookAsync(scriptPath, args = [], { cwd, env, input = '{}', timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (killErr) {
        void killErr;
      }
      reject(new Error(`Hook timed out after ${timeoutMs}ms: ${scriptPath}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 0, stdout, stderr });
    });
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

describe('Windows Hook Latency Optimization & RSL Single-Spawn Folding', () => {
  test('1. Warm MicroIpcServer + registerDaemonHookRpcMethods handles CC & AG CLI hooks end-to-end', async () => {
    const tmpRoot = makeTmpDir('ctxtop-warm-ipc-');
    const ws = path.join(tmpRoot, 'ws');
    const home = path.join(tmpRoot, 'home');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    const pipePath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ctxtop-test-hook-bridge-${process.pid}-${Date.now()}`
        : path.join(tmpRoot, 'test-hook.sock');

    const rpcCounts = { claudePre: 0, claudePost: 0, agPre: 0, agPost: 0 };
    const ipcServer = new MicroIpcServer({ ipcPath: pipePath });
    registerDaemonHookRpcMethods(ipcServer);

    for (const [key, counterName] of [
      ['hook.claude.preToolUse', 'claudePre'],
      ['hook.claude.postToolUse', 'claudePost'],
      ['hook.antigravity.preInvocation', 'agPre'],
      ['hook.antigravity.postInvocation', 'agPost']
    ]) {
      const orig = ipcServer.methods.get(key);
      assert.equal(typeof orig, 'function', `Expected ${key} registered`);
      ipcServer.registerMethod(key, async (params, socket, id) => {
        rpcCounts[counterName] += 1;
        return orig(params, socket, id);
      });
    }

    await ipcServer.listen();
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CTXTOP_IPC_PATH: pipePath
    };

    try {
      // A. Claude PreToolUse allow pass-through via warm IPC (single execution, exit 0)
      const ccAllow = await spawnHookAsync(CC_PRE_TOOL, [], {
        cwd: ws,
        env,
        input: {
          session_id: 'warm-sess-1',
          cwd: ws,
          tool_name: 'Bash',
          tool_input: { command: 'git status --short' }
        }
      });
      assert.equal(ccAllow.status, 0, ccAllow.stderr);
      assert.equal(ccAllow.stdout.trim(), '');
      assert.equal(rpcCounts.claudePre, 1);

      // B. Claude PreToolUse DET-02 secret read block via warm IPC (exit 2, fail-closed)
      const ccBlock = await spawnHookAsync(CC_PRE_TOOL, [], {
        cwd: ws,
        env,
        input: {
          session_id: 'warm-sess-1',
          cwd: ws,
          tool_name: 'Read',
          tool_input: { file_path: '.env' }
        }
      });
      assert.equal(ccBlock.status, 2);
      assert.match(ccBlock.stderr, /DET-02|\.env/i);
      assert.equal(rpcCounts.claudePre, 2);

      // C. Claude PostToolUse via warm IPC
      const ccPost = await spawnHookAsync(CC_POST_TOOL, [], {
        cwd: ws,
        env,
        input: {
          session_id: 'warm-sess-1',
          cwd: ws,
          tool_name: 'Bash',
          tool_input: { command: 'node -v' },
          tool_response: { stdout: 'v22.14.0', exit_code: 0 }
        }
      });
      assert.equal(ccPost.status, 0, ccPost.stderr);
      assert.equal(rpcCounts.claudePost, 1);

      // D. Antigravity PreToolUse allow + DET-01 git hook bypass block via warm IPC
      const agAllow = await spawnHookAsync(AG_PRE_INV, ['--event=PreToolUse'], {
        cwd: ws,
        env,
        input: {
          conversationId: 'ag-warm-1',
          workspacePaths: [ws],
          toolName: 'run_command',
          toolInput: { CommandLine: 'git status --short' }
        }
      });
      assert.equal(agAllow.status, 0, agAllow.stderr);
      assert.deepEqual(JSON.parse(agAllow.stdout.trim()), { decision: 'allow' });
      assert.equal(rpcCounts.agPre, 1);

      const agBlock = await spawnHookAsync(AG_PRE_INV, ['--event=PreToolUse'], {
        cwd: ws,
        env,
        input: {
          conversationId: 'ag-warm-1',
          workspacePaths: [ws],
          toolName: 'run_command',
          toolInput: { CommandLine: 'git commit --no-verify -m "skip"' }
        }
      });
      assert.equal(agBlock.status, 0, agBlock.stderr);
      const agBlockOut = JSON.parse(agBlock.stdout.trim());
      assert.equal(agBlockOut.decision, 'deny');
      assert.equal(rpcCounts.agPre, 2);

      // E. Antigravity PostInvocation via warm IPC
      const agPost = await spawnHookAsync(AG_POST_INV, [], {
        cwd: ws,
        env,
        input: {
          conversationId: 'ag-warm-1',
          workspacePaths: [ws],
          modelName: 'gemini-3.8-flash'
        }
      });
      assert.equal(agPost.status, 0, agPost.stderr);
      assert.deepEqual(JSON.parse(agPost.stdout.trim()), {});
      assert.equal(rpcCounts.agPost, 1);
    } finally {
      await ipcServer.close().catch(() => {});
      cleanupDir(tmpRoot);
    }
  });

  test('2. canFastAllowBoundedRead & cold CLI fast-path enforce strict safety exclusions', () => {
    const tmpRoot = makeTmpDir('ctxtop-fastread-');
    const ws = path.join(tmpRoot, 'ws');
    const home = path.join(tmpRoot, 'home');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    try {
      // Allowed bounded workspace source read (Claude offset/limit & Antigravity StartLine/EndLine)
      assert.equal(
        canFastAllowBoundedRead(
          { tool_name: 'Read', tool_input: { file_path: 'src/app.mjs', offset: 1, limit: 80 } },
          { platform: 'claude', cwd: ws, homeDir: home }
        ),
        true
      );
      assert.equal(
        canFastAllowBoundedRead(
          { toolName: 'read_file', toolInput: { TargetFile: path.join(ws, 'src', 'app.mjs'), StartLine: 1, EndLine: 60 } },
          { platform: 'antigravity', cwd: ws, homeDir: home }
        ),
        true
      );

      // Rejections: unbounded, secrets, extensions, traversal, rule files, airlock, AUTO_PILOT
      const rejectedCases = [
        { tool_name: 'Read', tool_input: { file_path: 'src/app.mjs' } },
        { tool_name: 'Read', tool_input: { file_path: '.env', offset: 1, limit: 10 } },
        { tool_name: 'Read', tool_input: { file_path: 'certs/dev.pem', offset: 1, limit: 10 } },
        { tool_name: 'Read', tool_input: { file_path: 'nb.ipynb', offset: 1, limit: 10 } },
        { tool_name: 'Read', tool_input: { file_path: 'spec.pdf', offset: 1, limit: 10 } },
        { tool_name: 'Read', tool_input: { file_path: '../outside/a.mjs', offset: 1, limit: 10 } },
        { tool_name: 'Read', tool_input: { file_path: 'CLAUDE.md', offset: 1, limit: 10 } },
        { tool_name: 'Read', tool_input: { file_path: 'packages/airlock/index.mjs', offset: 1, limit: 10 } },
        { mode: 'AUTO_PILOT', tool_name: 'Read', tool_input: { file_path: 'src/app.mjs', offset: 1, limit: 10 } }
      ];
      for (const payload of rejectedCases) {
        assert.equal(
          canFastAllowBoundedRead(payload, { platform: 'claude', cwd: ws, homeDir: home }),
          false,
          `Must reject fast-path for ${JSON.stringify(payload)}`
        );
      }

      // Filesystem sentinel rejection (.ctl latch, active_scopes.json, rsl_ledger.json, horizon-state)
      const ctlFile = path.join(home, '.ctxtop', 'runtime', 's1.ctl');
      fs.mkdirSync(path.dirname(ctlFile), { recursive: true });
      fs.writeFileSync(ctlFile, 'state=PAUSED\n', 'utf8');
      assert.equal(
        canFastAllowBoundedRead(
          { session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'src/app.mjs', offset: 1, limit: 20 } },
          { platform: 'claude', cwd: ws, homeDir: home }
        ),
        false
      );
      fs.rmSync(ctlFile);

      const claudeStateFile = path.join(ws, '.claude', 'horizon-state', 's2.json');
      fs.mkdirSync(path.dirname(claudeStateFile), { recursive: true });
      fs.writeFileSync(claudeStateFile, '{}', 'utf8');
      assert.equal(
        canFastAllowBoundedRead(
          { session_id: 's2', tool_name: 'Read', tool_input: { file_path: 'src/app.mjs', offset: 1, limit: 20 } },
          { platform: 'claude', cwd: ws, homeDir: home }
        ),
        false
      );

      // End-to-end spawned cold CLI guard check: bounded .env read must STILL fail closed (exit 2)
      const envSandbox = { ...process.env, HOME: home, USERPROFILE: home };
      delete envSandbox.CTXTOP_IPC_PATH;
      const envProc = spawnSync(process.execPath, [CC_PRE_TOOL], {
        cwd: ws,
        env: envSandbox,
        input: JSON.stringify({
          session_id: 's-cold',
          cwd: ws,
          tool_name: 'Read',
          tool_input: { file_path: '.env', offset: 1, limit: 10 }
        }),
        encoding: 'utf8',
        timeout: 10_000
      });
      assert.equal(envProc.status, 2);
      assert.match(envProc.stderr, /DET-02|\.env/i);
    } finally {
      cleanupDir(tmpRoot);
    }
  });

  test('3. RSL matcher narrowing, deduplication, and single-spawn PostInvocation folding', async () => {
    const tmpRoot = makeTmpDir('ctxtop-rsl-opt-');
    try {
      const rslBlock = buildRslPostmortemHooksBlock(tmpRoot, true);
      assert.equal(Array.isArray(rslBlock.PostToolUse), false, 'ctxtop-rsl-postmortem must omit PostToolUse');
      assert.ok(Array.isArray(rslBlock.SessionStart) && Array.isArray(rslBlock.Stop));

      syncAntigravityWorkspaceRslHooks(tmpRoot);
      const agHooksDoc = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.agents', 'hooks.json'), 'utf8'));
      const agPostMatcher = agHooksDoc['ctxtop-rsl-postmortem']?.PostToolUse?.[0]?.matcher;
      assert.equal(agPostMatcher, RSL_ANTIGRAVITY_POST_TOOL_MATCHER);
      assert.notEqual(agPostMatcher, '*');

      syncClaudeWorkspaceRslHooks(tmpRoot);
      const ccSettingsDoc = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.claude', 'settings.json'), 'utf8'));
      const ccPostMatcher = ccSettingsDoc.hooks?.PostToolUse?.[0]?.matcher;
      assert.equal(ccPostMatcher, RSL_CLAUDE_POST_TOOL_MATCHER);
      assert.equal(/\b(Read|Grep|Glob)\b/.test(ccPostMatcher), false);

      assert.equal(isMutatingOrExecRslTool('read_file'), false);
      assert.equal(isMutatingOrExecRslTool('Grep'), false);
      assert.equal(isMutatingOrExecRslTool('edit_file'), true);
      assert.equal(isMutatingOrExecRslTool('run_command'), true);

      // Read-only PostToolUse is skipped without creating steps JSONL
      const skippedAg = handleAntigravityRslHook(
        {
          conversationId: 'rsl-conv-1',
          workspacePaths: [tmpRoot],
          stepIdx: 0,
          toolCall: { name: 'read_file', args: { TargetFile: path.join(tmpRoot, 'a.mjs') } }
        },
        { event: 'PostToolUse' }
      );
      assert.equal(skippedAg.skippedReason, 'read_only_tool');

      const skippedCc = handleClaudeRslHook(
        {
          session_id: 'rsl-cc-1',
          cwd: tmpRoot,
          tool_name: 'Read',
          tool_input: { file_path: 'a.mjs' }
        },
        { event: 'PostToolUse' }
      );
      assert.equal(skippedCc.skippedReason, 'read_only_tool');

      const stepsFile = path.join(tmpRoot, '.agents', 'telemetry', 'rsl-conv-1.rsl_steps.jsonl');
      assert.equal(fs.existsSync(stepsFile), false);

      // Single-spawn PostToolUse folding inside handlePostInvocation + deduplication on identical retry
      const editPayload = {
        hookEventName: 'PostToolUse',
        conversationId: 'rsl-conv-1',
        workspacePaths: [tmpRoot],
        stepIdx: 1,
        toolCall: { name: 'edit_file', args: { TargetFile: path.join(tmpRoot, 'app.mjs') } },
        error: ''
      };
      await handlePostInvocation(editPayload);
      assert.equal(fs.existsSync(stepsFile), true);

      const dupCheck = handleAntigravityRslHook(editPayload, { event: 'PostToolUse' });
      assert.equal(dupCheck.deduplicated, true);

      const lines = fs
        .readFileSync(stepsFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      assert.equal(lines.length, 1, 'Duplicate stepIdx must be written once');
    } finally {
      cleanupDir(tmpRoot);
    }
  });

  test('4. code_fold_lite.mjs preserves exact parity with pruner.mjs exports', () => {
    const prev = Array.from({ length: 40 }, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n');
    const next = prev.replace('return 5;', 'return 55;');

    assert.deepEqual(
      codeFoldLite.foldCodeToSignatureStub(prev, 'sample.mjs'),
      prunerMod.foldCodeToSignatureStub(prev, 'sample.mjs')
    );
    assert.deepEqual(
      codeFoldLite.collapseDeadErrorToTombstone('Error: boom\n' + '  at fn (a.mjs:1:1)\n'.repeat(30), 4, 'Bash'),
      prunerMod.collapseDeadErrorToTombstone('Error: boom\n' + '  at fn (a.mjs:1:1)\n'.repeat(30), 4, 'Bash')
    );
    assert.deepEqual(
      codeFoldLite.computeCompactLineDiff(prev, next, 'sample.mjs'),
      prunerMod.computeCompactLineDiff(prev, next, 'sample.mjs')
    );
  });
});
