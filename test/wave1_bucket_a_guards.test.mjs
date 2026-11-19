import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../hooks/handlers/post-tool-use.mjs';
import { runStopGateHook } from '../hooks/handlers/stop-gate.mjs';
import { runConfigChangeHook } from '../hooks/handlers/config-change.mjs';
import { runCompactLifecycleHook } from '../hooks/handlers/compact-lifecycle.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { handlePostInvocation } from '../src/hooks/post_invocation.mjs';
import { createDefaultSidecar, writeSidecarAtomicSync } from '../src/core/sidecar_store.mjs';
import { resolveModelRates } from '../src/core/constants.mjs';
import {
  resolveModelCliffSpec,
  evaluateParameterizedCliffBreaker,
  checkHaiku100kCliffBreaker
} from '../src/core-isomorphic/economics/cliffBreaker.mjs';
import {
  configureShield,
  auditClaudeIdleDrainSettings,
  auditClaudeAgentAutoCompactWindows
} from '../src/core/shield_manager.mjs';
import { activateLocalTrial } from '../src/core/pro_license.mjs';

function makeTempWorkspace(prefix = 'ctxtop-wave1-') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}home-`));
  return {
    cwd,
    homeDir,
    cleanup() {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  };
}

describe('Wave 1 Bucket A Guardrails (Item A0 + #1 + #7 + #10)', () => {
  it('Item A0: resets codeEditedSinceLastTest ONLY on exit-0 PostToolUse (including tsc) and surfaces failing file:line', () => {
    const ws = makeTempWorkspace('ctxtop-a0-');
    try {
      activateLocalTrial({ homeDir: ws.homeDir });
      fs.writeFileSync(
        path.join(ws.cwd, '.attention-horizon.json'),
        JSON.stringify({ flightMode: 'AUTO_PILOT' }),
        'utf8'
      );
      const hookOpts = { cwd: ws.cwd, homeDir: ws.homeDir, persistState: true };

      // 1. Edit source file -> marks codeEditedSinceLastTest = true
      runPreToolUseHook(
        {
          session_id: 'sess-a0',
          cwd: ws.cwd,
          tool_name: 'Edit',
          tool_input: {
            file_path: 'src/service.ts',
            old_string: 'const a = 1;',
            new_string: 'const a: string = 1;'
          }
        },
        hookOpts
      );

      // 2. PreToolUse on `npm test` MUST NOT optimistically clear codeEditedSinceLastTest before PostToolUse!
      runPreToolUseHook(
        {
          session_id: 'sess-a0',
          cwd: ws.cwd,
          tool_name: 'Bash',
          tool_input: { command: 'npm test' }
        },
        hookOpts
      );
      const prematureStop = runStopGateHook(
        { session_id: 'sess-a0', cwd: ws.cwd, stop_hook_active: false },
        hookOpts
      );
      assert.equal(
        prematureStop.det14.decision,
        'block',
        'PreToolUse alone must not clear codeEditedSinceLastTest before test exits 0'
      );

      // 3. Failing PostToolUse keeps codeEditedSinceLastTest = true and records failing file:line
      runPostToolUseHook(
        {
          session_id: 'sess-a0',
          cwd: ws.cwd,
          tool_name: 'Bash',
          is_error: true,
          tool_input: { command: 'npm test' },
          tool_response: {
            stderr: 'src/service.ts:42:7 - error TS2322: Type number is not assignable to string',
            exit_code: 1
          }
        },
        hookOpts
      );
      const failedStop = runStopGateHook(
        { session_id: 'sess-a0', cwd: ws.cwd, stop_hook_active: false },
        hookOpts
      );
      assert.equal(failedStop.det14.decision, 'block');
      assert.match(failedStop.stdoutJson.reason, /src\/service\.ts:42/);

      // 4. Passing `npx tsc --noEmit` (exit_code: 0) clears codeEditedSinceLastTest
      runPreToolUseHook(
        {
          session_id: 'sess-a0',
          cwd: ws.cwd,
          tool_name: 'Bash',
          tool_input: { command: 'npx tsc --noEmit' }
        },
        hookOpts
      );
      runPostToolUseHook(
        {
          session_id: 'sess-a0',
          cwd: ws.cwd,
          tool_name: 'Bash',
          tool_input: { command: 'npx tsc --noEmit' },
          tool_response: { stdout: 'Done in 0.4s', exit_code: 0 }
        },
        hookOpts
      );
      const verifiedStop = runStopGateHook(
        { session_id: 'sess-a0', cwd: ws.cwd, stop_hook_active: false },
        hookOpts
      );
      assert.equal(verifiedStop.det14.decision, 'allow');
    } finally {
      ws.cleanup();
    }
  });

  it('Item A0 (Antigravity): validates define_subagent tools: names and unbounded Monitor calls', async () => {
    const ws = makeTempWorkspace('ctxtop-a0-ag-');
    try {
      activateLocalTrial({ homeDir: ws.homeDir });
      const badSubagent = await handlePreInvocation({
        hook_event_name: 'PreToolUse',
        conversationId: 'ag-a0-tools',
        cwd: ws.cwd,
        homeDir: ws.homeDir,
        flightMode: 'AUTO_PILOT',
        tool_name: 'define_subagent',
        tool_input: {
          Name: 'custom-helper',
          tools: ['read_file', 'nonexistent_magic_tool']
        }
      });
      assert.equal(badSubagent.permissionDecision, 'deny');
      assert.equal(badSubagent.detectorId, 'DET-16');
      assert.match(badSubagent.reason, /nonexistent_magic_tool/);

      const unboundedMonitor = await handlePreInvocation({
        hook_event_name: 'PreToolUse',
        conversationId: 'ag-a0-mon',
        cwd: ws.cwd,
        homeDir: ws.homeDir,
        flightMode: 'AUTO_PILOT',
        tool_name: 'Monitor',
        tool_input: { command: 'tail -f server.log' }
      });
      assert.equal(unboundedMonitor.permissionDecision, 'deny');
      assert.equal(unboundedMonitor.detectorId, 'DET-07');
    } finally {
      ws.cleanup();
    }
  });

  it('Item A1 (#1 MID_SESSION_CACHE_BUST): Claude ConfigChange holds warm-cache Opus->Sonnet downshift until PostCompact and Antigravity PreInvocation guards mid-session switches', async () => {
    const ws = makeTempWorkspace('ctxtop-a1-');
    try {
      activateLocalTrial({ homeDir: ws.homeDir });
      const hookOpts = { cwd: ws.cwd, homeDir: ws.homeDir, persistState: true };

      // 1. Warm cache: effort stays silent on measured cache-preserving Opus 5.5,
      //    while invalidating models (Opus 4.6) and model downshifts block in AUTO_PILOT.
      const effort55Silent = runConfigChangeHook(
        {
          session_id: 'sess-a1',
          cwd: ws.cwd,
          mode: 'AUTO_PILOT',
          setting_key: 'effortLevel',
          old_value: 'high',
          new_value: 'low',
          model: 'claude-opus-5-5',
          cached_tokens: 68000,
          cache_warm: true,
          ttl_remaining_seconds: 240
        },
        hookOpts
      );
      assert.equal(effort55Silent.verdict.triggered, false);
      assert.equal(effort55Silent.stdout, '');

      const effortBust = runConfigChangeHook(
        {
          session_id: 'sess-a1',
          cwd: ws.cwd,
          mode: 'AUTO_PILOT',
          setting_key: 'effortLevel',
          old_value: 'high',
          new_value: 'low',
          model: 'claude-opus-4-6',
          cached_tokens: 68000,
          cache_warm: true,
          ttl_remaining_seconds: 240
        },
        hookOpts
      );
      assert.equal(effortBust.verdict.triggered, true);
      assert.equal(effortBust.stdoutJson.decision, 'block');

      const downshiftHold = runConfigChangeHook(
        {
          session_id: 'sess-a1',
          cwd: ws.cwd,
          mode: 'AUTO_PILOT',
          setting_key: 'model',
          old_value: 'claude-opus-5-5',
          new_value: 'claude-sonnet-5-5',
          cached_tokens: 68000,
          cache_warm: true,
          ttl_remaining_seconds: 240
        },
        hookOpts
      );
      assert.equal(downshiftHold.stdoutJson.decision, 'block');
      assert.equal(downshiftHold.verdict.pendingDownshiftModel, 'claude-sonnet-5-5');

      // 2. PostCompact flushes held pending_downshift at $0 cold-cache penalty
      const postCompact = runCompactLifecycleHook(
        {
          hook_event_name: 'PostCompact',
          session_id: 'sess-a1',
          cwd: ws.cwd
        },
        hookOpts
      );
      assert.equal(postCompact.result.actuatedDownshiftModel, 'claude-sonnet-5-5');
      assert.match(postCompact.stdoutJson.systemMessage, /claude-sonnet-5-5/);

      // 3. Antigravity PreInvocation warm-cache mid-session switch guard
      const agId = `ag-a1-${Date.now()}`;
      const sidecar = createDefaultSidecar(agId);
      sidecar.workspacePath = ws.cwd;
      sidecar.sessionMeta.turnCount = 4;
      sidecar.sessionMeta.active_model_id = 'claude-opus-5-5';
      sidecar.sessionMeta.activeModel = 'claude-opus-5-5';
      sidecar.telemetry.totalInputTokens = 80000;
      sidecar.telemetry.cachedTokens = 80000;
      sidecar.telemetry.cacheTtlSeconds = 260;
      sidecar.telemetry.signalPurityPct = 92;
      writeSidecarAtomicSync(agId, sidecar);

      const agSwitch = await handlePreInvocation({
        conversationId: agId,
        cwd: ws.cwd,
        homeDir: ws.homeDir,
        flightMode: 'AUTO_PILOT',
        modelName: 'claude-sonnet-5-5',
        prompt: 'update the helper return value in utils.mjs'
      });
      assert.equal(agSwitch.terminationBehavior, 'terminate');
      assert.equal(agSwitch.detectorId, 'DET-08');
      assert.match(agSwitch.userMessage, /Warm-Cache Model Switch/);
    } finally {
      ws.cleanup();
    }
  });

  it('Item A3 (#7 PRICING_CLIFF_BREAKER): enforces Gemini 3.1/2.5 Pro 200K 2x/1.5x cliff + Haiku 100K 5x cliff while keeping Sonnet/Opus/Gemini-4 exempt', async () => {
    // 1. Rate schedule cliff check
    const g31Base = resolveModelRates('gemini-3.1-pro', '2026-11-15T00:00:00Z', 'standard', {
      totalPromptTokens: 150000
    });
    assert.equal(g31Base.cliffTriggered, false);
    assert.equal(g31Base.input_per_1m, 1.25);
    assert.equal(g31Base.output_per_1m, 10.0);

    const g31Cliff = resolveModelRates('gemini-3.1-pro', '2026-11-15T00:00:00Z', 'standard', {
      totalPromptTokens: 205000
    });
    assert.equal(g31Cliff.cliffTriggered, true);
    assert.equal(g31Cliff.input_per_1m, 2.5);
    assert.equal(g31Cliff.output_per_1m, 15.0);
    assert.equal(g31Cliff.cached_read_per_1m, 0.25);

    // 2. Haiku-only legacy check stays strictly Haiku-only
    assert.equal(checkHaiku100kCliffBreaker('gemini-3.1-pro', 250000).triggered, false);

    // 3. Parameterized cliff spec & breaker across families
    assert.equal(resolveModelCliffSpec('claude-sonnet-5-5'), null);
    assert.equal(resolveModelCliffSpec('claude-opus-5-5'), null);
    assert.equal(resolveModelCliffSpec('gemini-4-carbon'), null);
    assert.equal(resolveModelCliffSpec('gemini-3.1-pro')?.cliffTokens, 200000);
    assert.equal(resolveModelCliffSpec('gemini-2.5-pro-preview')?.cliffTokens, 200000);

    const adv180 = evaluateParameterizedCliffBreaker({
      modelId: 'gemini-3.1-pro',
      totalInputTokens: 184000
    });
    assert.equal(adv180.triggered, true);
    assert.equal(adv180.decision, 'advise_compact');

    const hard196 = evaluateParameterizedCliffBreaker({
      modelId: 'gemini-3.1-pro',
      totalInputTokens: 197000
    });
    assert.equal(hard196.triggered, true);
    assert.equal(hard196.decision, 'deny');

    // 4. Subagent .claude/agents/*.md frontmatter autoCompactWindow audit
    const ws = makeTempWorkspace('ctxtop-a3-');
    try {
      const agentsDir = path.join(ws.cwd, '.claude', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'scout.md'),
        '---\nname: scout\nmodel: claude-haiku-5-5\nautoCompactWindow: 150000\n---\nScout instructions.\n',
        'utf8'
      );
      const audit = auditClaudeAgentAutoCompactWindows({ cwd: ws.cwd });
      assert.equal(audit.triggered, true);
      assert.equal(audit.unguardedAgents.length, 1);
      assert.equal(audit.unguardedAgents[0].recommendedMax, 90000);
    } finally {
      ws.cleanup();
    }
  });

  it('Item A4 (#10 IDLE_DRAIN_BLOCKER): locks .claude/settings.local.json and emits non-blocking orphan background drain warnings on SessionEnd & PostInvocation', async () => {
    const ws = makeTempWorkspace('ctxtop-a4-');
    try {
      // 1. Unsafe settings flagged on SessionStart audit
      const claudeDir = path.join(ws.cwd, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'settings.local.json'),
        JSON.stringify({
          env: { CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '30' },
          crossSessionInbound: 'auto',
          idleCompaction: true
        }),
        'utf8'
      );
      const unsafeAudit = auditClaudeIdleDrainSettings({ cwd: ws.cwd });
      assert.equal(unsafeAudit.triggered, true);
      assert.equal(unsafeAudit.issues.length, 3);

      // 2. Fresh workspace sync via configureShield writes safe idle-drain defaults
      const wsClean = makeTempWorkspace('ctxtop-a4-clean-');
      try {
        configureShield({ action: 'enable', platform: 'claude', cwd: wsClean.cwd });
        const synced = JSON.parse(
          fs.readFileSync(path.join(wsClean.cwd, '.claude', 'settings.local.json'), 'utf8')
        );
        assert.equal(synced.env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES, '0');
        assert.equal(synced.crossSessionInbound, 'hold');
        assert.equal(synced.idleCompaction, false);
        assert.equal(auditClaudeIdleDrainSettings({ cwd: wsClean.cwd }).triggered, false);
      } finally {
        wsClean.cleanup();
      }

      // 3. Claude SessionEnd (--phase=end) emits non-blocking orphan background task warning
      const endRes = runStopGateHook(
        {
          hook_event_name: 'SessionEnd',
          session_id: 'sess-a4',
          cwd: ws.cwd,
          active_background_tasks: ['vite-dev-server', 'playwright-watcher']
        },
        { cwd: ws.cwd, homeDir: ws.homeDir, phase: 'end' }
      );
      assert.equal(endRes.exitCode, 0);
      assert.match(endRes.stdoutJson.systemMessage, /Orphan Background Drain/);
      assert.match(endRes.stdoutJson.systemMessage, /vite-dev-server/);

      // 4. Antigravity IsDaemon PreToolUse + sessionEnding PostInvocation emits orphan warning
      const agId = `ag-a4-${Date.now()}`;
      await handlePreInvocation({
        hook_event_name: 'PreToolUse',
        conversationId: agId,
        cwd: ws.cwd,
        homeDir: ws.homeDir,
        tool_name: 'run_command',
        tool_input: {
          CommandLine: 'npm run dev',
          IsDaemon: true,
          toolSummary: 'Dev server startup'
        }
      });
      const postEnd = await handlePostInvocation({
        conversationId: agId,
        cwd: ws.cwd,
        homeDir: ws.homeDir,
        sessionEnding: true
      });
      assert.ok(postEnd.orphanBackgroundWarning);
      assert.match(postEnd.systemMessage, /Dev server startup/);
    } finally {
      ws.cleanup();
    }
  });
});
