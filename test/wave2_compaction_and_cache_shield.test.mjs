import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateTaskBoundaryTurn,
  evaluateIdleTtlPreCompactGate
} from '../src/core-isomorphic/coach/smartCompactAdvisor.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { runStopGateHook } from '../hooks/handlers/stop-gate.mjs';
import { runUserPromptSubmitHook } from '../hooks/handlers/user-prompt-submit.mjs';
import { runCompactLifecycleHook } from '../hooks/handlers/compact-lifecycle.mjs';
import { handlePreToolUse, handlePreInvocation } from '../src/hooks/pre_invocation_core.mjs';
import { handlePostToolUse, handlePostInvocation } from '../src/hooks/post_invocation_core.mjs';
import { activateLocalTrial } from '../src/core/pro_license.mjs';

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    void err;
  }
}

function uniqueCid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

describe('OPT-1A & OPT-1B: Task-Boundary Edit Tracking & Baton Pre-Staging (Claude Code)', () => {
  it('recognizes Antigravity edit_file/write_file in evaluateTaskBoundaryTurn while ignoring non-code docs', () => {
    const docSkip = evaluateTaskBoundaryTurn({ toolName: 'edit_file', filePath: 'README.md' }, {});
    assert.equal(docSkip.editsSinceBoundary, 0);

    const codeEdit = evaluateTaskBoundaryTurn({ toolName: 'edit_file', filePath: 'src/core/router.mjs' }, {});
    assert.equal(codeEdit.editsSinceBoundary, 1);

    const writeEdit = evaluateTaskBoundaryTurn({ toolName: 'write_file', filePath: 'src/core/helper.mjs' }, codeEdit);
    assert.equal(writeEdit.editsSinceBoundary, 2);

    const boundaryPass = evaluateTaskBoundaryTurn(
      { toolName: 'run_command', command: 'node --test test/router.test.mjs', exitCode: 0, failed: false },
      writeEdit
    );
    assert.equal(boundaryPass.boundaryDetected, true);
    assert.equal(boundaryPass.detectorState, 'task_boundary');
    assert.equal(boundaryPass.editsSinceBoundary, 0);
  });

  it('tracks PreToolUse(Edit) -> PostToolUse(Bash npm test pass) -> Stop(/compact + staged StateBaton) without Edit in PostToolUse matcher', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt1b-cc-'));
    try {
      const targetFile = path.join(tmpDir, 'worker.mjs');
      fs.writeFileSync(targetFile, 'export const v = 1;\n', 'utf8');
      const sid = 'sess-opt1b-cc-1';

      // 1. PreToolUse Edit increments taskBoundaryState.editsSinceBoundary
      const preEdit = runPreToolUseHook(
        {
          session_id: sid,
          cwd: tmpDir,
          tool_name: 'Edit',
          tool_input: { file_path: targetFile, old_string: 'v = 1', new_string: 'v = 2' }
        },
        { cwd: tmpDir }
      );
      assert.equal(preEdit.exitCode, 0);

      // 2. Unrelated Read must preserve taskBoundaryState before test runs
      runPreToolUseHook(
        { session_id: sid, cwd: tmpDir, tool_name: 'Read', tool_input: { file_path: targetFile } },
        { cwd: tmpDir }
      );

      // 3. Passing test in PostToolUse promotes boundary -> turnBoundaryReached: true
      runPostToolUseHook(
        {
          session_id: sid,
          cwd: tmpDir,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: { stdout: 'all 12 tests passed\n', exit_code: 0 },
          exit_code: 0
        },
        { cwd: tmpDir }
      );

      // 4. Stop gate sees verified task_boundary at 140k, suggests /compact, and pre-stages StateBaton
      const stopRes = runStopGateHook(
        {
          session_id: sid,
          cwd: tmpDir,
          codeEditedSinceLastTest: false,
          context_tokens: 140_000,
          expected_remaining_turns: 10,
          model: 'claude-sonnet-5-5'
        },
        { cwd: tmpDir }
      );
      assert.equal(stopRes.smartCompactSuggestion?.shouldSuggest, true);
      assert.equal(stopRes.smartCompactSuggestion?.batonStaged, true);
      assert.ok(
        stopRes.smartCompactSuggestion?.batonPath && fs.existsSync(stopRes.smartCompactSuggestion.batonPath),
        'Pre-staged StateBaton JSON must exist on disk'
      );
      assert.ok(stopRes.stdoutJson?.systemMessage?.includes('Task boundary reached'));

      // 5. Immediate repeat Stop without compaction is suppressed by 4-turn cooldown
      const repeatStop = runStopGateHook(
        {
          session_id: sid,
          cwd: tmpDir,
          codeEditedSinceLastTest: false,
          boundaryDetected: true,
          context_tokens: 140_000,
          expected_remaining_turns: 10,
          model: 'claude-sonnet-5-5'
        },
        { cwd: tmpDir }
      );
      assert.equal(repeatStop.smartCompactSuggestion?.shouldSuggest, false);
      assert.equal(repeatStop.smartCompactSuggestion?.suppressedReason, 'post_compact_cooldown');
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

describe('OPT-1C: Antigravity Task-Boundary Compaction & Out-of-Workspace Baton Pre-Staging', () => {
  it('tracks edit_file -> run_command passing test, suggests /compact at 140k, stages baton under homeDir, and creates zero .claude in workspace', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt1c-ws-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt1c-home-'));
    try {
      const target = path.join(tmpWs, 'engine.mjs');
      fs.writeFileSync(target, 'export function run() { return 1; }\n', 'utf8');
      const cid = uniqueCid('ag-opt1c-conv');

      await handlePreToolUse({
        conversationId: cid,
        cwd: tmpWs,
        homeDir: tmpHome,
        tool_name: 'edit_file',
        tool_input: {
          Path: target,
          TargetContent: 'return 1;',
          ReplacementContent: 'return 2;'
        }
      });

      const postPass = await handlePostToolUse({
        conversationId: cid,
        cwd: tmpWs,
        homeDir: tmpHome,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'node --test test/engine.test.mjs' },
        tool_output: 'pass 5\nfail 0\n',
        exitCode: 0,
        contextTokens: 140_000,
        expectedRemainingTurns: 10,
        modelName: 'claude-sonnet-5-5'
      });

      assert.equal(postPass.smartCompactSuggestion?.shouldSuggest, true);
      assert.equal(postPass.smartCompactSuggestion?.batonStaged, true);
      assert.ok(
        postPass.smartCompactSuggestion?.batonPath &&
          fs.existsSync(postPass.smartCompactSuggestion.batonPath) &&
          postPass.smartCompactSuggestion.batonPath.startsWith(tmpHome),
        'Antigravity baton must be staged under homeDir (~/.gemini/antigravity/agy-horizon/batons)'
      );
      assert.equal(fs.existsSync(path.join(tmpWs, '.claude')), false, 'Workspace must never contain .claude/');
      assert.ok(postPass.systemMessage?.includes('Task boundary reached'));

      // Cooldown blocks immediate second boundary suggestion without compaction
      const cooldownRes = await handlePostInvocation({
        conversationId: cid,
        cwd: tmpWs,
        homeDir: tmpHome,
        boundaryDetected: true,
        contextTokens: 140_000,
        expectedRemainingTurns: 10,
        modelName: 'claude-sonnet-5-5'
      });
      assert.equal(cooldownRes.smartCompactSuggestion?.shouldSuggest, false);
      assert.equal(cooldownRes.smartCompactSuggestion?.suppressedReason, 'post_compact_cooldown');
    } finally {
      cleanupDir(tmpWs);
      cleanupDir(tmpHome);
    }
  });
});

describe('OPT-4A: Idle-TTL Cold-Resume Gate (DET-17 Aligned Cold-Rewrite Avoidance)', () => {
  it('fires accurately only after TTL expiry (>5m or >1h) and >=60k context, aligns with DET-17 (/handoff + /clear), and redirects /compact', async () => {
    const warmSkip = evaluateIdleTtlPreCompactGate({
      idleGapMs: 120_000,
      contextTokens: 120_000,
      modelId: 'claude-sonnet-5-5'
    });
    assert.equal(warmSkip.shouldSuggest, false);
    assert.equal(warmSkip.suppressedReason, 'cache_still_warm');

    const smallCtxSkip = evaluateIdleTtlPreCompactGate({
      idleGapMs: 600_000,
      contextTokens: 35_000,
      modelId: 'claude-sonnet-5-5'
    });
    assert.equal(smallCtxSkip.shouldSuggest, false);
    assert.equal(smallCtxSkip.suppressedReason, 'below_min_context');

    const clearSkip = evaluateIdleTtlPreCompactGate({
      idleGapMs: 600_000,
      contextTokens: 120_000,
      modelId: 'claude-sonnet-5-5',
      promptText: '/clear'
    });
    assert.equal(clearSkip.shouldSuggest, false);
    assert.equal(clearSkip.suppressedReason, 'already_resetting');

    const handoffSkip = evaluateIdleTtlPreCompactGate({
      idleGapMs: 600_000,
      contextTokens: 120_000,
      modelId: 'claude-sonnet-5-5',
      promptText: '/handoff save baton'
    });
    assert.equal(handoffSkip.shouldSuggest, false);
    assert.equal(handoffSkip.suppressedReason, 'already_resetting');

    const compactRedirect = evaluateIdleTtlPreCompactGate({
      idleGapMs: 600_000,
      contextTokens: 120_000,
      modelId: 'claude-sonnet-5-5',
      promptText: '/compact focus on Wave 2'
    });
    assert.equal(compactRedirect.shouldSuggest, true);
    assert.equal(compactRedirect.coldCompactRedirect, true);
    assert.equal(compactRedirect.recommendedAction, 'STATE_BATON_CLEAR');
    assert.equal(compactRedirect.det17Aligned, true);
    assert.ok(compactRedirect.message.includes('Avoid /compact'));
    assert.ok(compactRedirect.message.includes('/handoff'));
    assert.ok(compactRedirect.message.includes('/clear'));

    const fireEval = evaluateIdleTtlPreCompactGate({
      idleGapMs: 600_000,
      contextTokens: 120_000,
      modelId: 'claude-sonnet-5-5',
      promptText: 'Continue fixing router tests'
    });
    assert.equal(fireEval.shouldSuggest, true);
    assert.equal(fireEval.coldCompactRedirect, false);
    assert.equal(fireEval.det17Aligned, true);
    assert.equal(fireEval.recommendedAction, 'STATE_BATON_CLEAR');
    assert.equal(fireEval.coldTokensAvoided, 119_700);
    assert.ok(fireEval.immediateColdRewriteSavingUSD >= 0.24);
    assert.ok(fireEval.message.includes('Idle-TTL Cold-Resume'));
    assert.ok(fireEval.message.includes('DET-17'));
    assert.ok(fireEval.message.includes('/clear'));
    assert.ok(!fireEval.message.includes('Run /compact'));

    // Cross-check DET-17 PreCompact block agrees (no contradiction)
    const det17Block = runCompactLifecycleHook({
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      cacheExpired: true,
      cachedTokens: 120_000
    });
    assert.equal(det17Block.stdoutJson?.decision, 'block');
    assert.equal(det17Block.result?.subType, 'COLD_CACHE_COMPACT_BLOCKED');

    // Live Claude Code UserPromptSubmit hook + 60s dedupe
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt4a-cc-'));
    try {
      const t0 = 1_795_000_000_000;
      const ccIdle = runUserPromptSubmitHook(
        {
          session_id: 'sess-opt4a-cc',
          cwd: tmpDir,
          prompt: 'Resume feature work in src/core/router.mjs',
          nowMs: t0,
          lastTurnTimestampMs: t0 - 420_000, // 7 min idle > 5m TTL
          context_tokens: 110_000,
          model: 'claude-sonnet-5-5'
        },
        { cwd: tmpDir }
      );
      assert.equal(ccIdle.verdict.subType, 'IDLE_TTL_PRE_COMPACT');
      assert.ok(ccIdle.stdoutJson?.hookSpecificOutput?.additionalContext?.includes('Idle-TTL Cold-Resume'));
      assert.ok(ccIdle.stdoutJson?.hookSpecificOutput?.additionalContext?.includes('/clear'));

      // Duplicate prompt 10s later is deduplicated silently
      const ccDup = runUserPromptSubmitHook(
        {
          session_id: 'sess-opt4a-cc',
          cwd: tmpDir,
          prompt: 'Also check tests in src/core/router.mjs',
          nowMs: t0 + 10_000,
          context_tokens: 110_000,
          model: 'claude-sonnet-5-5'
        },
        { cwd: tmpDir }
      );
      assert.notEqual(ccDup.verdict.subType, 'IDLE_TTL_PRE_COMPACT');
    } finally {
      cleanupDir(tmpDir);
    }

    // Live Antigravity PreInvocation hook
    const tmpAgWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt4a-ag-'));
    const tmpAgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt4a-aghome-'));
    try {
      const t0 = 1_795_100_000_000;
      const agIdle = await handlePreInvocation({
        conversationId: uniqueCid('ag-opt4a'),
        cwd: tmpAgWs,
        homeDir: tmpAgHome,
        prompt: 'Continue implementing cache shield wiring in src/hooks/pre_invocation_core.mjs',
        nowMs: t0,
        lastTurnTimestampMs: t0 - 480_000,
        contextTokens: 120_000,
        modelName: 'claude-sonnet-5-5'
      });
      assert.equal(agIdle.subType, 'IDLE_TTL_PRE_COMPACT');
      assert.ok(agIdle.systemMessage?.includes('Idle-TTL Cold-Resume'));
      assert.ok(agIdle.systemMessage?.includes('/clear'));
      assert.ok(agIdle.idlePreCompactSuggestion?.coldTokensAvoided >= 119_700);
    } finally {
      cleanupDir(tmpAgWs);
      cleanupDir(tmpAgHome);
    }
  });
});

describe('OPT-4B: Warm-Prefix Cache Shield Auto-Staging & PostCompact Flush', () => {
  it('stages DET-09 AGENTS.md edit on Antigravity and flushes cleanly on PostInvocation(postCompact: true)', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt4b-ag-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt4b-aghome-'));
    try {
      activateLocalTrial({ homeDir: tmpHome });
      const agentsPath = path.join(tmpWs, 'AGENTS.md');
      fs.writeFileSync(agentsPath, '# Rules\nRule A = v1\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpWs, '.attention-horizon.json'),
        JSON.stringify({ flightMode: 'AUTO_PILOT', detectorNamespace: 'antigravity' }),
        'utf8'
      );

      const ag4bCid = uniqueCid('ag-opt4b');
      const blockRes = await handlePreToolUse({
        conversationId: ag4bCid,
        cwd: tmpWs,
        homeDir: tmpHome,
        tool_name: 'edit_file',
        tool_input: {
          Path: agentsPath,
          TargetContent: 'Rule A = v1',
          ReplacementContent: 'Rule A = v2 (post-compact)'
        },
        cachedTokens: 85_000,
        cacheTtlSeconds: 210
      });

      assert.equal(blockRes.decision, 'block');
      assert.equal(blockRes.detectorId, 'DET-09');
      assert.equal(blockRes.prefixDeltaStaged, true);
      assert.equal(blockRes.stagedCount, 1);
      assert.equal(fs.readFileSync(agentsPath, 'utf8'), '# Rules\nRule A = v1\n', 'Prefix file must stay untouched while cache is warm');

      const flushRes = await handlePostInvocation({
        conversationId: ag4bCid,
        cwd: tmpWs,
        homeDir: tmpHome,
        postCompact: true
      });
      assert.equal(flushRes.flushedPrefixDeltas?.flushedCount, 1);
      assert.ok(
        fs.readFileSync(agentsPath, 'utf8').includes('Rule A = v2 (post-compact)'),
        'AGENTS.md must reflect staged edit after PostCompact flush'
      );
      assert.equal(fs.existsSync(path.join(tmpWs, '.claude')), false, 'Antigravity staging/flush must never create .claude/ in workspace');
    } finally {
      cleanupDir(tmpWs);
      cleanupDir(tmpHome);
    }
  });

  it('stages DET-09 CLAUDE.md edit in .claude/cache on Claude Code and flushes cleanly on PostCompact', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt4b-cc-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-opt4b-cchome-'));
    try {
      activateLocalTrial({ homeDir: tmpHome });
      const claudeMdPath = path.join(tmpWs, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, '# Claude Instructions\nAlways verify = old\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpWs, '.attention-horizon.json'),
        JSON.stringify({ flightMode: 'AUTO_PILOT' }),
        'utf8'
      );

      const ccDeny = runPreToolUseHook(
        {
          session_id: 'cc-opt4b-1',
          cwd: tmpWs,
          tool_name: 'Edit',
          tool_input: {
            file_path: claudeMdPath,
            old_string: 'Always verify = old',
            new_string: 'Always verify = strict'
          },
          usage: { cache_read_input_tokens: 90_000 },
          cacheWarm: true,
          ttlRemainingSeconds: 210
        },
        { cwd: tmpWs, homeDir: tmpHome }
      );
      assert.ok(
        ccDeny.verdict.decision === 'defer' || ccDeny.verdict.decision === 'deny',
        `Expected DET-09 in AUTO_PILOT to defer or deny, got: ${ccDeny.verdict.decision}`
      );
      assert.equal(ccDeny.verdict.detectorId, 'DET-09');
      assert.equal(ccDeny.verdict.prefixDeltaStaged, true);
      assert.equal(fs.readFileSync(claudeMdPath, 'utf8'), '# Claude Instructions\nAlways verify = old\n');

      const postCompactRes = runCompactLifecycleHook(
        { session_id: 'cc-opt4b-1', cwd: tmpWs, hook_event_name: 'PostCompact' },
        { phase: 'post', cwd: tmpWs, homeDir: tmpHome }
      );
      assert.equal(postCompactRes.result?.flushedPrefixDeltas?.flushedCount, 1);
      assert.ok(postCompactRes.stdoutJson?.systemMessage?.includes('Flushed 1 staged prefix rule update'));
      assert.ok(
        fs.readFileSync(claudeMdPath, 'utf8').includes('Always verify = strict'),
        'CLAUDE.md must reflect staged edit after PostCompact flush'
      );
    } finally {
      cleanupDir(tmpWs);
      cleanupDir(tmpHome);
    }
  });
});
