import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  runStrictPreInvocation,
  runStrictPreToolUse
} from '../src/hooks/portfolio_runtime.mjs';
import { handlePostInvocation } from '../src/hooks/post_invocation.mjs';
import { EffortAdvisor, resolveCarbonPricingForTimestamp } from '../src/core/coach/effort_advisor.mjs';
import { TrajectoryWatcher } from '../src/core/telemetry/trajectory_watcher.mjs';
import { resolveModelDescriptor, resolveModelRates } from '../src/core/constants.mjs';
import { getQuotaMultiplier } from '../src/core/task_quota_router.mjs';

function makeTmp(prefix = 'ah-b3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Batch 3 — Rank 6 (DET-06B): Lean Flash Subagent Search Offloader (@ah-flash-scout)', () => {
  it('ships agents/ah-flash-scout.md with strict flash/subagent/read-only frontmatter and gates call 7+ on warm Carbon/Argon', async () => {
    const agentMd = fs.readFileSync(path.resolve('agents/ah-flash-scout.md'), 'utf8');
    assert.match(agentMd, /^---\r?\n[\s\S]*?model:\s*flash/m);
    assert.match(agentMd, /mainAgent:\s*false/);
    assert.match(agentMd, /subagent:\s*true/);
    assert.match(agentMd, /excludeDefaultComponents:\s*true/);
    assert.match(agentMd, /commandExecutionPolicy:\s*off/);
    for (const tool of ['view_file', 'grep_search', 'find_by_name', 'list_dir']) {
      assert.ok(agentMd.includes(`- ${tool}`), `Missing tool ${tool} in ah-flash-scout.md`);
    }
    assert.ok(!agentMd.includes('- run_command'));

    const ws = makeTmp('ah-det06b-');
    const sid = `det06b-${Date.now()}`;
    try {
      // Calls 1..6 on warm gemini-4-carbon (cachedTokens = 12000 > 3529) -> allow
      for (let i = 1; i <= 6; i++) {
        const res = await runStrictPreToolUse({
          conversationId: sid,
          cwd: ws,
          flightMode: 'AUTO_PILOT',
          activeModel: 'gemini-4-carbon',
          cachedTokens: 12000,
          tool_name: 'grep_search',
          tool_input: { Query: `symbol_${i}` }
        });
        assert.equal(res.decision, 'allow', `Call ${i} should be allowed`);
      }

      // Call 7 -> denied in AUTO_PILOT with @ah-flash-scout delegation guidance!
      const seventh = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        activeModel: 'gemini-4-carbon',
        cachedTokens: 12000,
        tool_name: 'grep_search',
        tool_input: { Query: 'symbol_7' }
      });
      assert.equal(seventh.decision, 'deny');
      assert.match(seventh.reason, /@ah-flash-scout/);

      // Subagent trajectories are exempt!
      const subagentCall = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        activeModel: 'gemini-4-carbon',
        cachedTokens: 12000,
        isSubagent: true,
        tool_name: 'grep_search',
        tool_input: { Query: 'subagent_ok' }
      });
      assert.equal(subagentCall.decision, 'allow');

      // New user turn resets counter!
      await runStrictPreInvocation({
        conversationId: sid,
        cwd: ws,
        invocationNum: 1,
        prompt: 'Next step'
      });
      const afterNewTurn = await runStrictPreToolUse({
        conversationId: sid,
        cwd: ws,
        flightMode: 'AUTO_PILOT',
        activeModel: 'gemini-4-carbon',
        cachedTokens: 12000,
        tool_name: 'grep_search',
        tool_input: { Query: 'fresh_turn' }
      });
      assert.equal(afterNewTurn.decision, 'allow');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('Batch 3 — Rank 7 (DET-08): KV-Cache Gravity, Carbon 2026-12-01 Rate Step, Dual-Trigger EffortAdvisor & Box 3 Chip', () => {
  it('validates src/config/modelCatalog.json Carbon weights (3.2/6.0/10.0), 2026-12-01 rate step ($2->$4), Turn 0-2 vs Mid-Session math, HysteresisLock, and 3-strike SQLite muting', async () => {
    const srcCatalog = JSON.parse(fs.readFileSync(path.resolve('src/config/modelCatalog.json'), 'utf8'));
    const carbon = srcCatalog.models['gemini-4-carbon'];
    assert.equal(carbon.shared_pool_ceiling, 1048576);
    assert.equal(carbon.caching_mode, 'implicit_only');
    assert.equal(carbon.supports_explicit_cache, false);
    assert.deepEqual(carbon.weights, { low: 3.2, med: 6.0, medium: 6.0, high: 10.0 });
    assert.equal(getQuotaMultiplier('gemini-4-carbon', 'low'), 3.2);
    assert.equal(getQuotaMultiplier('gemini-4-carbon', 'med'), 6.0);
    assert.equal(getQuotaMultiplier('gemini-4-carbon', 'high'), 10.0);

    // Pre vs Post 2026-12-01 Carbon pricing step
    const preRates = resolveModelRates('gemini-4-carbon', '2026-11-30T12:00:00Z');
    assert.equal(preRates.input_per_1m, 2.00);
    assert.equal(preRates.cached_read_per_1m, 0.10);
    assert.equal(preRates.output_per_1m, 10.00);

    const postRates = resolveModelRates('gemini-4-carbon', '2026-12-01T00:00:00Z');
    assert.equal(postRates.input_per_1m, 4.00);
    assert.equal(postRates.cached_read_per_1m, 0.20);
    assert.equal(postRates.output_per_1m, 20.00);

    const flashRates = resolveModelRates('gemini-3.8-flash', '2026-11-10T12:00:00Z');
    assert.equal(flashRates.input_per_1m, 0.75);
    assert.equal(flashRates.cached_read_per_1m, 0.075);
    assert.equal(flashRates.output_per_1m, 3.75);

    const tmp = makeTmp('ah-effort-');
    try {
      const dbPath = path.join(tmp, 'effort.sqlite');
      const advisor = new EffortAdvisor({ dbPath });

      // Lane 1: Turn 0-2 with cachedTokens <= 3529 -> routes simple task to gemini-3.8-flash
      const coldRoute = advisor.evaluate({
        sessionId: 's1',
        turnCount: 1,
        cachedTokens: 2000,
        activeModel: 'gemini-4-carbon',
        activeEffort: 'high',
        isSimpleTask: true
      });
      assert.equal(coldRoute.lane, 'TURN_0_2_COLD_FLASH_ROUTE');
      assert.equal(coldRoute.recommendedModel, 'gemini-3.8-flash');

      // Lane 2: Mid-session (cachedTokens = 40000 > 3529) -> NEVER switch to Flash (7.5x input penalty), surfaces Box 3 downshift chip!
      const warmRoute = advisor.evaluate({
        sessionId: 's1',
        turnCount: 6,
        cachedTokens: 40000,
        activeModel: 'gemini-4-carbon',
        activeEffort: 'high',
        isSimpleTask: true,
        timestampUtc: '2026-11-10T12:00:00Z'
      });
      assert.equal(warmRoute.forbidFlashModelSwitch, true);
      assert.equal(warmRoute.coldFlashInputPenaltyMultiplier, 7.5);
      assert.equal(warmRoute.recommendedModel, 'gemini-4-carbon');
      assert.equal(warmRoute.recommendedEffort, 'low');
      assert.equal(warmRoute.box3Chip.label, '[Downshift: /effort low (-68% output burn, keeps warm cache)]');

      // HysteresisLock: >=2 recent test failures OR DET-05 oscillation suppresses downshift!
      const lockedRoute = advisor.evaluate({
        sessionId: 's1',
        turnCount: 6,
        cachedTokens: 40000,
        activeModel: 'gemini-4-carbon',
        activeEffort: 'high',
        isSimpleTask: true,
        recentTestFailures: 2
      });
      assert.equal(lockedRoute.hysteresisLocked, true);
      assert.equal(lockedRoute.box3Chip, null);

      // Dual triggers: PostInvocation AND TrajectoryWatcher
      const postOut = await handlePostInvocation({
        conversationId: `post-${Date.now()}`,
        modelName: 'gemini-4-carbon',
        effort: 'high',
        cachedTokens: 50000,
        isSimpleTask: true,
        effortAdvisorDbPath: dbPath
      });
      assert.ok(postOut.effortAdvisor?.box3Chip);

      const watcher = new TrajectoryWatcher();
      let emittedChip = null;
      watcher.on('EFFORT_ADVISOR_CHIP', (ev) => { emittedChip = ev; });
      watcher.observeTrajectoryUpdate({
        sessionId: 'pb-sess',
        stepCount: 5,
        effortContext: { cachedTokens: 45000, activeModel: 'gemini-4-carbon', activeEffort: 'high', isSimpleTask: true }
      });
      assert.ok(emittedChip?.effortAdvice?.triggered);

      // 3-Strike SQLite dismissal muting
      advisor.recordDismissal('s1');
      advisor.recordDismissal('s1');
      assert.equal(advisor.evaluate({ sessionId: 's1', turnCount: 6, cachedTokens: 40000 }).mutedByStrikes, false);
      advisor.recordDismissal('s1');
      const muted = advisor.evaluate({ sessionId: 's1', turnCount: 6, cachedTokens: 40000 });
      assert.equal(muted.mutedByStrikes, true);
      assert.equal(muted.box3Chip, null);

      // Verify Box 3 chip template exists in horizon_panel.html
      const html = fs.readFileSync(path.resolve('src/webview/horizon_panel.html'), 'utf8');
      assert.ok(html.includes('data-action-id="det08-effort-downshift"'));
      assert.ok(html.includes('[Downshift: /effort low (-68% output burn, keeps warm cache)]'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Batch 3 — Rank 12 (DET-16 & DET-20): 80% Hybrid Quota Fan-Out Throttle & Vision Overage HTTP 400 Guard', () => {
  it('throttles multi-worker fan-out at 80% Base Quota, ask-gates at 90%, caps subagents at 40k/12 turns, and warns on Vision overage HTTP 400', async () => {
    const quirks = JSON.parse(fs.readFileSync(path.resolve('src/config/platformQuirks.json'), 'utf8'));
    assert.equal(quirks.visionOverageHttp400.enabled, true);

    const ws = makeTmp('ah-det16-');
    try {
      // 1. 75% Base Quota -> multi-worker swarm allowed
      const allow75 = await runStrictPreToolUse({
        cwd: ws,
        baseQuotaUsedPct: 75,
        tool_name: 'swarm',
        tool_input: { action: 'add', n: 3 }
      });
      assert.equal(allow75.decision, 'allow');

      // 2. 82% Base Quota -> 1 sequential worker allowed, 2+ workers denied!
      const single82 = await runStrictPreToolUse({
        cwd: ws,
        baseQuotaUsedPct: 82,
        activeSubagentsCount: 0,
        tool_name: 'invoke_subagent',
        tool_input: { TypeName: 'research', Role: 'Scout', Prompt: 'Check file' }
      });
      assert.equal(single82.decision, 'allow');

      const multi82 = await runStrictPreToolUse({
        cwd: ws,
        baseQuotaUsedPct: 82,
        activeSubagentsCount: 1,
        tool_name: 'invoke_subagent',
        tool_input: { TypeName: 'research', Role: 'Scout 2', Prompt: 'Parallel check' }
      });
      assert.equal(multi82.decision, 'deny');
      assert.match(multi82.reason, /\[DET-16\].*168h lockout/);

      // 3. 92% Base Quota -> hard ask-gate!
      const ask92 = await runStrictPreToolUse({
        cwd: ws,
        baseQuotaUsedPct: 92,
        tool_name: 'invoke_subagent',
        tool_input: { TypeName: 'research', Role: 'Scout', Prompt: 'Check' }
      });
      assert.equal(ask92.decision, 'ask');

      // 4. Per-subagent 40,000 token / 12 turn cap
      const overCap = await runStrictPreToolUse({
        cwd: ws,
        baseQuotaUsedPct: 30,
        subagentTokens: 42000,
        subagentTurns: 8,
        tool_name: 'invoke_subagent',
        tool_input: { TypeName: 'self', Role: 'Worker', Prompt: 'More work' }
      });
      assert.equal(overCap.decision, 'deny');
      assert.match(overCap.reason, /40000 tok/);

      // 5. DET-20 Vision Overage HTTP 400 pre-invocation warning
      const visionWarn = await runStrictPreInvocation({
        cwd: ws,
        invocationNum: 1,
        aiCreditOveragesActive: true,
        media: [{ mime_type: 'image/png', uri: 'screenshot.png' }],
        prompt: 'Fix this UI alignment'
      });
      assert.match(visionWarn.ephemeralMessage, /HTTP 400 Bad Request \(Unable to process input image\)/);

      // Negative check: text-only prompt during overages -> clean {}
      const textOnlyClean = await runStrictPreInvocation({
        cwd: ws,
        invocationNum: 1,
        aiCreditOveragesActive: true,
        prompt: 'Fix this UI alignment'
      });
      assert.deepEqual(textOnlyClean, {});
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
