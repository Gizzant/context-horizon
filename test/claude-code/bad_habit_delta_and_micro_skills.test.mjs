/**
 * @file test/bad_habit_delta_and_micro_skills.test.mjs
 * Verification Suite for Deep-Dive Bad-Habit Sub-Vectors, Semantic Habit Slugs, and RSI-04 Micro-Skills.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  HABIT_SEMANTIC_SLUGS,
  normalizeDetectorId,
  setDetectorOverride,
  loadHorizonConfig,
  resolveDetectorOverride
} from '../../src/core-isomorphic/config/horizonConfig.mjs';
import { TtlWatchdog } from '../../src/core-isomorphic/coach/ttlWatchdog.mjs';
import {
  CircuitBreakerEngine,
  evaluateDet13McpSchemaBloatGuard,
  evaluateSilentPrefixMutations
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  MAX_MICRO_SKILL_BATON_CHARS,
  MAX_MICRO_SKILL_BATON_TOKENS,
  createEmptyMicroSkillsRegistry,
  recordShellOutcomeInRegistry,
  evaluateMicroSkillIntercept,
  formatMicroSkillsBatonSnippet,
  inspectCommandSafetyForMicroSkill
} from '../../src/core-isomorphic/coach/microSkills.mjs';
import { runCompactLifecycleHook } from '../../hooks/handlers/compact-lifecycle.mjs';
import { runPostToolUseHook } from '../../hooks/handlers/post-tool-use.mjs';
import { runUserPromptSubmitHook } from '../../hooks/handlers/user-prompt-submit.mjs';
import { runPreToolUseHook } from '../../hooks/handlers/pre-tool-use.mjs';
import { normalizeDetectorMode } from '../../src/core-isomorphic/config/horizonConfig.mjs';

test('BH-01: HABIT_SEMANTIC_SLUGS normalize independently and persist in .attention-horizon.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cc-habits-'));
  try {
    for (const slug of HABIT_SEMANTIC_SLUGS) {
      assert.equal(normalizeDetectorId(slug), slug);
      setDetectorOverride(slug, 'off', { cwd: tmp, homeDir: tmp });
      const cfg = loadHorizonConfig({ cwd: tmp, homeDir: tmp });
      assert.equal(resolveDetectorOverride(slug, cfg), 'off');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BH-02: Adaptive 1h->5m TTL drop on overage/subagent/API and Cold-Cache PreCompact block', () => {
  const watchdog = new TtlWatchdog({ mode: 'COACH' });
  const baseMs = 1_700_000_000_000;
  const tick = watchdog.evaluateTick({
    cacheWarm: true,
    cachedTokens: 95000,
    lastActivityAt: baseMs,
    nowMs: baseMs + 320_000,
    planDefaultTtlSeconds: 3600,
    aiCreditOveragesActive: true,
    modelId: 'claude-opus-4-6'
  });
  assert.equal(tick.effectiveTtlSeconds, 300);
  assert.equal(tick.ttlDroppedTo5m, true);
  assert.equal(tick.statusReason, 'CACHE_COLD_OR_EXPIRED');

  const coldCompact = runCompactLifecycleHook({
    hook_event_name: 'PreCompact',
    trigger: 'manual',
    cacheExpired: true,
    cachedTokens: 95000
  });
  assert.equal(coldCompact.stdoutJson?.decision, 'block');
  assert.equal(coldCompact.result?.subType, 'COLD_CACHE_COMPACT_BLOCKED');
});

test('BH-03: Silent Prefix Mutations (Late MCP, 25KB MEMORY.md, IDE prefix state, 20-block lookback deletion)', () => {
  const prevIds = Array.from({ length: 14 }, (_, i) => `msg-${i + 1}`);
  const currIds = prevIds.filter((_, idx) => idx !== 3 && idx !== 4); // 2 deleted -> 9 suffix messages shift
  const mut = evaluateSilentPrefixMutations({
    turnCount: 4,
    prevMcpServerCount: 1,
    currMcpServerCount: 3,
    prevMemoryMdBytes: 1024,
    currMemoryMdBytes: 25600,
    ideStateInSystemPrefix: true,
    prevMessageIds: prevIds,
    currMessageIds: currIds,
    tokensPerMessage: 3000
  });
  assert.equal(mut.triggered, true);
  assert.equal(mut.subTypes.length, 4);
  assert.equal(mut.shiftedSuffixTokens, 27000);
});

test('BH-04: Turn-0 static prefill + 5-turn idle MCP hoarding, TDD Turn-1 exemption, and Base64 compounding vision tax', () => {
  // 5-turn idle MCP hoarding
  const mcpRes = evaluateDet13McpSchemaBloatGuard({
    mcpSchemaTokens: 45000,
    mcpToolCount: 48,
    bundledSkillsTokens: 4000,
    syncedSkillsTokens: 3500,
    claudeMdTokens: 11500,
    turnsElapsed: 5,
    mcpInvocations: 0,
    turnId: 5
  });
  assert.equal(mcpRes.triggered, true);
  assert.equal(mcpRes.subType, 'IDLE_MCP_HOARDING_5_TURNS');
  assert.equal(mcpRes.recommendedEnv, 'ENABLE_TOOL_SEARCH=auto:5');
  assert.equal(mcpRes.turn0StaticPrefillBreakdown.totalStaticPrefillTokens, 64000);

  // TDD Turn-1 companion pair (source + *.test.ts) must NOT trigger blind multi-file edit
  const tddEngine = new CircuitBreakerEngine({ flightMode: 'AUTO_PILOT' });
  const editSrc = tddEngine.evaluatePreToolUse({
    tool_name: 'Edit',
    tool_input: { file_path: 'src/billing.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    turnId: 1
  });
  const editTest = tddEngine.evaluatePreToolUse({
    tool_name: 'Edit',
    tool_input: { file_path: 'src/billing.test.ts', old_string: 'expect(1)', new_string: 'expect(2)' },
    turnId: 1
  });
  assert.notEqual(editSrc.subType, 'BLIND_UNPLANNED_MULTI_EDIT');
  assert.notEqual(editTest.subType, 'BLIND_UNPLANNED_MULTI_EDIT');

  // 2 non-test source files on Turn 1 without @file anchor -> triggers BLIND_UNPLANNED_MULTI_EDIT
  const blindEngine = new CircuitBreakerEngine({ flightMode: 'AUTO_PILOT' });
  blindEngine.evaluatePreToolUse({
    tool_name: 'Edit',
    tool_input: { file_path: 'src/billing.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    turnId: 1
  });
  const secondBlind = blindEngine.evaluatePreToolUse({
    tool_name: 'Edit',
    tool_input: { file_path: 'src/ledger.ts', old_string: 'const b = 1;', new_string: 'const b = 2;' },
    turnId: 1
  });
  assert.equal(secondBlind.triggered, true);
  assert.equal(secondBlind.subType, 'BLIND_UNPLANNED_MULTI_EDIT');

  // Base64 multimodal compounding vision tax
  const visEngine = new CircuitBreakerEngine({ flightMode: 'COACH' });
  const visRes = visEngine.evaluatePreToolUse({
    tool_name: 'Read',
    tool_input: { file_path: 'src/styles.css' },
    prompt: 'Fix CSS alignment bug',
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'BBBB' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'CCCC' } }] }
    ],
    turnId: 3
  });
  assert.equal(visRes.triggered, true);
  assert.equal(visRes.subType, 'VISION_SCREENSHOT_ABUSE');
  assert.equal(visRes.cumulativeVisionTaxTokens, 9600);
});

test('BH-05: RSI-04 Micro-Skills end-to-end promotion, PreToolUse intercept, SessionStart <80-tok Baton, and safety filters', () => {
  assert.equal(inspectCommandSafetyForMicroSkill('OPENAI_API_KEY=sk-proj-1234567890abcdefghijklm pytest').safe, false);
  assert.equal(inspectCommandSafetyForMicroSkill('git commit -m "wip" --no-verify').safe, false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cc-ms-'));
  try {
    for (const sId of ['s-1', 's-2']) {
      runPostToolUseHook({
        session_id: sId,
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/test_core.py' },
        tool_response: { exit_code: 1, stderr: 'pytest: command not found' },
        turnId: 1
      }, { cwd: tmp });
      runPostToolUseHook({
        session_id: sId,
        tool_name: 'Bash',
        tool_input: { command: 'poetry run pytest tests/test_core.py' },
        tool_response: { exit_code: 0, stdout: '1 passed' },
        turnId: 2
      }, { cwd: tmp });
    }

    const sessionStartOut = runCompactLifecycleHook({
      hook_event_name: 'SessionStart',
      source: 'startup'
    }, { cwd: tmp });
    const ctx = sessionStartOut.stdoutJson?.hookSpecificOutput?.additionalContext || '';
    assert.ok(ctx.includes('"pytest" -> "poetry run pytest"'));

    const cb = new CircuitBreakerEngine({ flightMode: 'AUTO_PILOT', cwd: tmp });
    const blocked = cb.evaluatePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'pytest tests/test_next.py' },
      turnId: 1,
      cwd: tmp
    });
    assert.equal(blocked.triggered, true);
    assert.equal(blocked.detectorId, 'RSI-04');
    assert.equal(blocked.decision, 'deny');

    // Contradiction eviction & <=80-token cap
    let reg = createEmptyMicroSkillsRegistry();
    reg = recordShellOutcomeInRegistry(reg, { command: 'pytest', exitCode: 1, turn: 1, sessionId: 'a', confirmSessions: 1 }).registry;
    reg = recordShellOutcomeInRegistry(reg, { command: 'poetry run pytest', exitCode: 0, turn: 2, sessionId: 'a', confirmSessions: 1 }).registry;
    assert.equal(reg.skills.length, 1);
    reg = recordShellOutcomeInRegistry(reg, { command: 'poetry run pytest', exitCode: 1, turn: 3, sessionId: 'b', confirmSessions: 1 }).registry;
    const sup = recordShellOutcomeInRegistry(reg, { command: 'uv run pytest', exitCode: 0, turn: 4, sessionId: 'b', confirmSessions: 1 });
    assert.equal(sup.evictedContradictions.length, 1);

    const interceptOff = evaluateMicroSkillIntercept(sup.registry, {
      command: 'poetry run pytest',
      flightMode: 'AUTO_PILOT',
      overrideMode: 'off'
    });
    assert.equal(interceptOff.triggered, false);

    const many = formatMicroSkillsBatonSnippet({
      skills: Array.from({ length: 20 }, (_, i) => ({
        promoted: true,
        failedCmd: `npm test --w=${i}`,
        workingCmd: `pnpm --filter w-${i} test`
      }))
    });
    assert.ok(many.snippet.length <= MAX_MICRO_SKILL_BATON_CHARS);
    assert.ok(many.estimatedTokens <= MAX_MICRO_SKILL_BATON_TOKENS);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BH-06: Prompt Hygiene Governor (v4.1 Phase 1) — UserPromptSubmit Scope Brake, Relay Breaker & Two-Stage PreToolUse Intercept', () => {
  assert.equal(normalizeDetectorMode('steer'), 'warn');
  assert.ok(HABIT_SEMANTIC_SLUGS.includes('relay-breaker'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cc-hygiene-'));
  try {
    // 1. Unanchored prompt ('make it better') steers on UserPromptSubmit and sets unanchoredTurnFlag
    const promptRes = runUserPromptSubmitHook({
      session_id: 'hyg-1',
      prompt: 'make it better',
      activeSetPaths: ['src/auth.ts', 'src/session.ts']
    }, { cwd: tmp });
    assert.equal(promptRes.verdict.triggered, true);
    assert.equal(promptRes.verdict.subType, 'UNANCHORED_SCOPE_BRAKE');
    assert.ok(promptRes.stdoutJson?.hookSpecificOutput?.additionalContext?.includes('src/auth.ts'));

    // 2. Two-Stage PreToolUse intercepts exploratory Grep on the unanchored turn when vague-prompt-rubric='steer'
    setDetectorOverride('vague-prompt-rubric', 'steer', { cwd: tmp, homeDir: tmp });
    const preToolRes = runPreToolUseHook({
      session_id: 'hyg-1',
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO' }
    }, { cwd: tmp, useJsonDecision: true });
    assert.equal(preToolRes.verdict.triggered, true);
    assert.equal(preToolRes.verdict.subType, 'TWO_STAGE_SCOPE_BRAKE_INTERCEPT');
    assert.equal(preToolRes.verdict.decision, 'deny');

    // 3. Autonomous/affirmative prompt passes silently
    const yesRes = runUserPromptSubmitHook({
      session_id: 'hyg-1',
      prompt: 'yes, go ahead'
    }, { cwd: tmp });
    assert.equal(yesRes.verdict.triggered, false);
    assert.equal(yesRes.stdout, '');

    // 4. Relay Breaker transitions Candidate -> Armed -> Final Pass -> Locked
    const critiqueText = `${'Reviewing the updated specification and architecture boundaries. '.repeat(28)}\nWhat I confirmed: token accounting is solid.\nWhere the spec overreaches: S0: Blocker on Windows git spawn and overall assessment 8/10.`;
    const r1 = runUserPromptSubmitHook({
      session_id: 'relay-1',
      prompt: critiqueText
    }, { cwd: tmp });
    assert.equal(r1.verdict.triggered, false);

    const r2 = runUserPromptSubmitHook({
      session_id: 'relay-1',
      prompt: critiqueText,
      priorTurnWebSearches: 3
    }, { cwd: tmp });
    assert.equal(r2.verdict.triggered, true);
    assert.equal(r2.verdict.relayState, 'Armed');
    assert.ok(r2.stdoutJson?.hookSpecificOutput?.additionalContext?.includes('Owner Protocol'));

    // While Armed, exploratory WebFetch is denied by Two-Stage Relay Gate
    const webBlocked = runPreToolUseHook({
      session_id: 'relay-1',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://docs.example.com/hooks' }
    }, { cwd: tmp, useJsonDecision: true });
    assert.equal(webBlocked.verdict.triggered, true);
    assert.equal(webBlocked.verdict.subType, 'TWO_STAGE_RELAY_WEB_SEARCH_INTERCEPT');
    assert.equal(webBlocked.verdict.decision, 'deny');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
