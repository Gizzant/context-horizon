import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../src/utils/nodeIo.mjs';
import {
  installAttentionHorizon,
  uninstallAttentionHorizon,
  runCli
} from '../bin/ctxtop.mjs';
import {
  auditClaudeAgentAutoCompactWindows,
  configureScout,
  getScoutStatus
} from '../src/core/shield_manager.mjs';
import { evaluateDet06BlindSearchGuard } from '../src/core-isomorphic/guards/det04_12_thrash_rot.mjs';
import { evaluateSubagentGovernor } from '../src/core-isomorphic/guards/bucketBGamma.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use-core.mjs';
import { inspectSubagentTree } from '../src/core/subagents.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function makeTempDir(prefix = 'hb-idea4-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

describe('Idea #4: Claude Code Haiku Read-Only Scout & COACH Opt-In Re-Tiering', () => {
  it('ships agents/ah-haiku-scout.md with strict read-only Haiku contract and safe autoCompactWindow', () => {
    const agentPath = path.join(ROOT, 'agents', 'ah-haiku-scout.md');
    assert.equal(fs.existsSync(agentPath), true, 'agents/ah-haiku-scout.md must exist');
    const raw = fs.readFileSync(agentPath, 'utf8');
    assert.match(raw, /^---\r?\n[\s\S]*name:\s*ah-haiku-scout\b/m);
    assert.match(raw, /^model:\s*haiku\b/m);
    assert.match(raw, /^tools:\s*Read,\s*Grep,\s*Glob\b/m);
    assert.match(raw, /^autoCompactWindow:\s*90000\b/m);

    const pluginJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
    );
    assert.ok(Array.isArray(pluginJson.agents), '.claude-plugin/plugin.json must declare agents[]');
    assert.ok(pluginJson.agents.includes('./agents/ah-haiku-scout.md'));
    assert.equal(
      pluginJson.agents.some((a) => a.includes('ah-flash-scout')),
      false,
      'Claude Code plugin manifest must not register Antigravity ah-flash-scout.md'
    );

    const ws = makeTempDir('hb-agent-audit-');
    try {
      const dst = path.join(ws.dir, '.claude', 'agents', 'ah-haiku-scout.md');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, raw, 'utf8');
      const audit = auditClaudeAgentAutoCompactWindows({ cwd: ws.dir });
      assert.equal(audit.triggered, false, 'ah-haiku-scout must pass 90k autoCompactWindow cliff audit');
    } finally {
      ws.cleanup();
    }
  });

  it('installs and cleanly uninstalls ah-haiku-scout.md via installAttentionHorizon / uninstallAttentionHorizon', () => {
    const ws = makeTempDir('hb-install-scout-');
    try {
      const settingsPath = path.join(ws.dir, '.claude', 'settings.json');
      const inst = installAttentionHorizon({
        cwd: ws.dir,
        homeDir: ws.dir,
        settingsPath,
        checkBinaryCapabilities: false
      });
      assert.equal(inst.ok, true);
      const installedAgent = path.join(ws.dir, '.claude', 'agents', 'ah-haiku-scout.md');
      assert.equal(fs.existsSync(installedAgent), true, 'Installer must copy ah-haiku-scout.md');

      const uninst = uninstallAttentionHorizon({
        cwd: ws.dir,
        homeDir: ws.dir,
        settingsPath
      });
      assert.equal(uninst.ok, true);
      assert.equal(uninst.removedScoutAgent, true);
      assert.equal(fs.existsSync(installedAgent), false, 'Uninstaller must remove Highbeam ah-haiku-scout.md');
    } finally {
      ws.cleanup();
    }
  });

  it('updates DET-06 recommendation and exempts ah-haiku-scout default model from false Frontier warning', () => {
    const det06 = evaluateDet06BlindSearchGuard({ sequentialSearchCount: 7 });
    assert.equal(det06.triggered, true);
    assert.equal(det06.recommendedSubagent.agentType, 'ah-haiku-scout');
    assert.equal(det06.recommendedSubagent.model, 'claude-haiku-5-5');
    assert.match(det06.reason, /ah-haiku-scout/);

    const cleanDedicated = evaluateSubagentGovernor({
      typeName: 'ah-haiku-scout',
      role: 'Billing Scout',
      prompt: 'Locate tax and FX conversion policies across src/'
    });
    assert.equal(cleanDedicated.triggered, false, 'Omitted model on ah-haiku-scout defaults to haiku');
    assert.equal(cleanDedicated.isReadOnlyScout, true);

    const opusOverride = evaluateSubagentGovernor({
      typeName: 'ah-haiku-scout',
      role: 'Billing Scout',
      prompt: 'Locate tax and FX conversion policies across src/',
      model: 'opus'
    });
    assert.equal(opusOverride.triggered, true, 'Explicit Frontier model on ah-haiku-scout must warn');
    assert.equal(opusOverride.code, 'SUBAGENT_TEAM_GOVERNOR');
  });

  it('supports COACH opt-in Haiku auto-tiering (without Pro), ask mode, Frontier pins, write-worker exemption, and CLI toggle', () => {
    const ws = makeTempDir('hb-coach-scout-');
    const prevEnv = process.env.HIGHBEAM_AUTO_TIER_SCOUTS;
    delete process.env.HIGHBEAM_AUTO_TIER_SCOUTS;
    try {
      const baseEvent = {
        session_id: 'sess-idea4-coach',
        cwd: ws.dir,
        mode: 'COACH',
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'Explore',
          description: 'Explore billing policies',
          prompt: 'Find discount stacking and FX conversion modules under src/',
          model: 'sonnet'
        }
      };

      // 1. Default COACH (no opt-in): advisory allow, no updatedInput
      const defRes = runPreToolUseHook(baseEvent, { cwd: ws.dir, homeDir: ws.dir, persistState: false });
      const defJson = JSON.parse(defRes.stdout);
      assert.equal(defJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.equal(defJson.hookSpecificOutput.updatedInput, undefined);
      assert.match(defJson.hookSpecificOutput.additionalContext, /haiku.*flash/i);
      assert.match(defJson.hookSpecificOutput.additionalContext, /ah-haiku-scout/);

      // 2. Ask mode in COACH
      const askRes = runPreToolUseHook(baseEvent, {
        cwd: ws.dir,
        homeDir: ws.dir,
        persistState: false,
        scoutTierMode: 'ask'
      });
      const askJson = JSON.parse(askRes.stdout);
      assert.equal(askJson.hookSpecificOutput.permissionDecision, 'ask');
      assert.match(askJson.hookSpecificOutput.permissionDecisionReason, /ah-haiku-scout/);

      // 3. CLI enable (`ctxtop scout --enable`) + auto-tier without Pro license
      const cliEn = runCli(['scout', '--enable', '--cwd', ws.dir, '--json'], { cwd: ws.dir });
      assert.equal(cliEn.exitCode, 0);
      assert.equal(cliEn.data.autoTierReadOnlyScouts, true);
      assert.equal(cliEn.data.agentInstalled, true);

      const cliStat = getScoutStatus({ cwd: ws.dir });
      assert.equal(cliStat.autoTierReadOnlyScouts, true);
      assert.equal(cliStat.autoCompactSafe, true);

      const optRes = runPreToolUseHook(baseEvent, { cwd: ws.dir, homeDir: ws.dir, persistState: false });
      const optJson = JSON.parse(optRes.stdout);
      assert.equal(optJson.hookSpecificOutput.permissionDecision, 'allow');
      assert.equal(optJson.hookSpecificOutput.updatedInput?.model, 'haiku');
      assert.match(optJson.hookSpecificOutput.additionalContext, /Highbeam Scout Auto-Tier/);

      // 4. Explicit Frontier pin stays untouched even when opted-in
      const pinRes = runPreToolUseHook(
        { ...baseEvent, prompt: 'Use sonnet for this scout exploration' },
        { cwd: ws.dir, homeDir: ws.dir, persistState: false }
      );
      const pinJson = JSON.parse(pinRes.stdout);
      assert.equal(pinJson.hookSpecificOutput.updatedInput, undefined);

      // 5. Write worker & Cold Critic never re-tiered
      const writeRes = runPreToolUseHook(
        {
          session_id: 'sess-idea4-write',
          cwd: ws.dir,
          mode: 'COACH',
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'Fix billing bug',
            prompt: 'Edit src/policies/fxConversionPolicy.mjs to fix rounding',
            model: 'sonnet'
          }
        },
        { cwd: ws.dir, homeDir: ws.dir, persistState: false }
      );
      assert.equal(writeRes.stdout, '');

      // 6. CLI disable restores advisory-only COACH behavior
      const cliDis = runCli(['scout', '--disable', '--cwd', ws.dir, '--json'], { cwd: ws.dir });
      assert.equal(cliDis.exitCode, 0);
      assert.equal(cliDis.data.autoTierReadOnlyScouts, false);

      const postDisRes = runPreToolUseHook(baseEvent, { cwd: ws.dir, homeDir: ws.dir, persistState: false });
      const postDisJson = JSON.parse(postDisRes.stdout);
      assert.equal(postDisJson.hookSpecificOutput.updatedInput, undefined);

      // 7. configureScout disable leaves Shield mode intact
      const disabledDirectly = configureScout({ action: 'disable', cwd: ws.dir });
      assert.equal(disabledDirectly.autoTierReadOnlyScouts, false);
    } finally {
      if (prevEnv !== undefined) process.env.HIGHBEAM_AUTO_TIER_SCOUTS = prevEnv;
      else delete process.env.HIGHBEAM_AUTO_TIER_SCOUTS;
      ws.cleanup();
    }
  });

  it('teaches inspectSubagentTree Claude Code Task/Agent spawns and handoff sizes', () => {
    const steps = [
      {
        type: 'PLANNER_RESPONSE',
        toolCalls: [
          {
            id: 'tu_cc_scout_1',
            name: 'Agent',
            args: {
              subagent_type: 'ah-haiku-scout',
              description: 'Billing policy scout',
              prompt: 'Locate tax and FX modules'
            }
          },
          {
            id: 'tu_cc_task_2',
            name: 'Task',
            args: {
              subagent_type: 'Explore',
              description: 'Settlement scout',
              prompt: 'Find settlement reconciler',
              model: 'haiku',
              isolation: 'worktree'
            }
          }
        ]
      },
      {
        agentId: 'child-haiku-1',
        parentToolUseId: 'tu_cc_scout_1',
        outputTokens: 6400
      },
      {
        agentId: 'child-explore-2',
        parentToolUseId: 'tu_cc_task_2',
        outputTokens: 4800
      },
      {
        type: 'TOOL_RESPONSE',
        toolUseId: 'tu_cc_scout_1',
        content: 'Files: src/policies/fxConversionPolicy.mjs:L16-L52',
        outputTokens: 210
      },
      {
        type: 'TOOL_RESPONSE',
        toolUseId: 'tu_cc_task_2',
        content: 'agentId: child-explore-2 -> src/services/settlementReconciler.mjs:L10-L85',
        outputTokens: 180
      }
    ];

    const tree = inspectSubagentTree(steps, { homeDir: os.tmpdir() });
    assert.equal(tree.count, 2);
    assert.equal(tree.invocations[0].toolName, 'Agent');
    assert.equal(tree.invocations[0].platform, 'claude');
    assert.equal(tree.invocations[0].typeName, 'ah-haiku-scout');
    assert.equal(tree.invocations[0].model, 'haiku');
    assert.equal(tree.invocations[0].isolatedTokens, 6400);
    assert.equal(tree.invocations[0].handoffTokens, 210);
    assert.equal(tree.invocations[1].toolName, 'Task');
    assert.equal(tree.invocations[1].workspaceMode, 'worktree');
    assert.equal(tree.invocations[1].isolatedTokens, 4800);
    assert.equal(tree.invocations[1].handoffTokens, 180);
    assert.ok(tree.overallCompressionRatio > 10);
  });
});
