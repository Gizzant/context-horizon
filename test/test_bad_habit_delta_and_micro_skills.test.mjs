import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// GA_REPO imports
import * as gaHorizonConfig from '../src/core/horizon_config.mjs';
import * as gaIsoHorizonConfig from '../src/core-isomorphic/config/horizonConfig.mjs';
import * as gaDetectorsShared from '../src/core/shared/detectors.mjs';
import * as gaCompactionCoach from '../src/core/compaction_coach.mjs';
import * as gaMicroSkillsPure from '../src/core/shared/micro_skills.mjs';
import * as gaMicroSkillsStore from '../src/core/micro_skills_store.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { handleSessionStart } from '../src/hooks/session_start.mjs';
import { runStrictPreToolUse, runStrictPostToolUse } from '../src/hooks/portfolio_runtime.mjs';

const GA_ROOT = path.resolve(import.meta.dirname, '..');
const CC_ROOT = 'C:\\Projects\\cc-attention-horizon';
const HAS_CC_REPO = fs.existsSync(path.join(CC_ROOT, 'package.json'));

const importCc = async (rel) => import(pathToFileURL(path.join(CC_ROOT, rel)).href);

function walkMjsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMjsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

describe('Bad-Habit Deep-Dive Sub-Vectors, Semantic Habit Overrides & RSI-04 Micro-Skills', () => {
  it('supports all 8 HABIT_SEMANTIC_SLUGS across GA & CC config engines without colliding with Ring-0 DET-15', async () => {
    const expectedSlugs = [
      'formatter-bypass',
      'drip-feed',
      'vague-prompt-rubric',
      'effort-overkill',
      'post-commit-handoff',
      'vision-screenshot-coach',
      'micro-skills',
      'relay-breaker'
    ];
    assert.deepEqual(gaHorizonConfig.HABIT_SEMANTIC_SLUGS, expectedSlugs);
    assert.deepEqual(gaIsoHorizonConfig.HABIT_SEMANTIC_SLUGS, expectedSlugs);
    assert.equal(gaHorizonConfig.normalizeDetectorMode('steer'), 'warn');
    assert.equal(gaIsoHorizonConfig.normalizeDetectorMode('steer'), 'warn');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-habit-cfg-'));
    try {
      for (const slug of expectedSlugs) {
        gaHorizonConfig.setDetectorOverride(slug, 'off', { scope: 'project', cwd: tmpDir, homeDir: tmpDir });
        const loadedGa = gaHorizonConfig.loadHorizonConfig({ cwd: tmpDir, homeDir: tmpDir });
        assert.equal(gaHorizonConfig.resolveDetectorOverride(loadedGa, slug), 'off');

        // Critical Ring-0 Non-Collision Invariant: formatter-bypass=off MUST NEVER disable DET-15 (secret-boundary)
        assert.notEqual(gaHorizonConfig.resolveDetectorOverride(loadedGa, 'DET-15'), 'off');

        gaHorizonConfig.setDetectorOverride(slug, 'block', { scope: 'project', cwd: tmpDir, homeDir: tmpDir });
        const loadedBlock = gaHorizonConfig.loadHorizonConfig({ cwd: tmpDir, homeDir: tmpDir });
        assert.equal(gaHorizonConfig.resolveDetectorOverride(loadedBlock, slug), 'block');
      }

      // Isomorphic config check (idOrSlug first parameter order)
      const isoCfg = { semanticDetectors: { 'formatter-bypass': 'off', 'micro-skills': 'block' } };
      assert.equal(gaIsoHorizonConfig.resolveDetectorOverride('formatter-bypass', isoCfg), 'off');
      assert.equal(gaIsoHorizonConfig.resolveDetectorOverride('micro-skills', isoCfg), 'block');
      assert.notEqual(gaIsoHorizonConfig.resolveDetectorOverride('DET-15', isoCfg), 'off');

      if (HAS_CC_REPO) {
        const ccCfgMod = await importCc('src/config/horizonConfig.mjs');
        assert.deepEqual(ccCfgMod.HABIT_SEMANTIC_SLUGS, expectedSlugs);
        assert.equal(ccCfgMod.resolveDetectorOverride('formatter-bypass', isoCfg), 'off');
        assert.equal(ccCfgMod.resolveDetectorOverride('micro-skills', isoCfg), 'block');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Scenario 1 (Sim 06): detects 1h -> 5m adaptive TTL drop on overage/subagent/API and blocks cold-cache /compact', async () => {
    const gaNominal1h = gaDetectorsShared.evaluateDet10IdleCacheWatchdog({
      elapsedSeconds: 320,
      planDefaultTtlSeconds: 3600,
      aiCreditOveragesActive: false,
      cachedTokens: 95000
    });
    assert.equal(gaNominal1h.effectiveTtlSeconds, 3600);
    assert.equal(gaNominal1h.ttlDroppedTo5m, false);
    assert.equal(gaNominal1h.cacheExpired, false);

    const gaOverageDrop = gaDetectorsShared.evaluateDet10IdleCacheWatchdog({
      elapsedSeconds: 320,
      planDefaultTtlSeconds: 3600,
      aiCreditOveragesActive: true,
      cachedTokens: 95000
    });
    assert.equal(gaOverageDrop.effectiveTtlSeconds, 300);
    assert.equal(gaOverageDrop.ttlDroppedTo5m, true);
    assert.equal(gaOverageDrop.cacheExpired, true);

    const gaSubagentDrop = gaDetectorsShared.evaluateDet10IdleCacheWatchdog({
      elapsedSeconds: 310,
      planDefaultTtlSeconds: 3600,
      isSubagent: true,
      cachedTokens: 40000
    });
    assert.equal(gaSubagentDrop.ttlDroppedTo5m, true);
    assert.equal(gaSubagentDrop.cacheExpired, true);

    const gaColdCompact = gaCompactionCoach.assessCompactionState({
      cacheTtlSeconds: 0,
      cacheExpired: true,
      compactRequested: true,
      totalTokens: 95000,
      contextLimit: 200000
    });
    assert.equal(gaColdCompact.coldCompactBlocked, true);
    assert.equal(gaColdCompact.action, 'EXECUTE_BATON_PASS');
    assert.equal(gaColdCompact.shouldCompact, false);

    if (HAS_CC_REPO) {
      const ccTtl = await importCc('src/coach/ttlWatchdog.mjs');
      const ccCompact = await importCc('hooks/handlers/compact-lifecycle.mjs');
      const watchdog = new ccTtl.TtlWatchdog({ mode: 'COACH' });
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

      const coldPreCompact = ccCompact.runCompactLifecycleHook({
        hook_event_name: 'PreCompact',
        trigger: 'manual',
        cacheExpired: true,
        cachedTokens: 95000
      });
      assert.equal(coldPreCompact.stdoutJson?.decision, 'block');
      assert.equal(coldPreCompact.result?.subType, 'COLD_CACHE_COMPACT_BLOCKED');
    }
  });

  it('Scenario 2 (Sim 01 & Sim 16): classifies Late MCP Connect, 25KB MEMORY.md mutation, IDE system-prefix state, and 20-block lookback deletion', async () => {
    const prevIds = Array.from({ length: 15 }, (_, i) => `m-${i + 1}`);
    const currIds = prevIds.filter((_, idx) => idx < 2 || idx > 4); // drop 3 messages -> 10 suffix messages shift

    const gaMut = gaDetectorsShared.evaluateSilentPrefixMutations({
      turnCount: 3,
      prevMcpServerCount: 2,
      currMcpServerCount: 4,
      prevMemoryMdBytes: 2048,
      currMemoryMdBytes: 25600,
      ideStateInSystemPrefix: true,
      prevMessageIds: prevIds,
      currMessageIds: currIds,
      tokensPerMessage: 4000
    });
    assert.equal(gaMut.triggered, true);
    assert.deepEqual(gaMut.subTypes, [
      'LATE_MCP_CONNECT',
      'MEMORY_MD_MID_THREAD_MUTATION',
      'IDE_STATE_PREFIX_MUTATION',
      'LOOKBACK_WINDOW_DELETION'
    ]);
    assert.equal(gaMut.shiftedSuffixTokens, 40000);

    if (HAS_CC_REPO) {
      const ccCb = await importCc('src/guards/circuitBreakers.mjs');
      const ccMut = ccCb.evaluateSilentPrefixMutations({
        turnCount: 3,
        prevMcpServerCount: 2,
        currMcpServerCount: 4,
        prevMemoryMdBytes: 2048,
        currMemoryMdBytes: 25600,
        ideStateInSystemPrefix: true,
        prevMessageIds: prevIds,
        currMessageIds: currIds,
        tokensPerMessage: 4000
      });
      assert.equal(ccMut.triggered, true);
      assert.equal(ccMut.shiftedSuffixTokens, 40000);
      assert.equal(ccMut.subTypes.length, 4);
    }
  });

  it('Scenario 3 & 4 (Sim 02 & Sim 19): decomposes Turn-0 static prefill + 5-turn idle MCP hoarding and Base64 compounding vision tax', async () => {
    const gaMcp = gaDetectorsShared.evaluateDet09McpSchemaTax({
      mcpSchemaTokens: 45000,
      bundledSkillsTokens: 4000,
      syncedSkillsTokens: 3500,
      claudeMdTokens: 11500,
      turnsElapsed: 5,
      mcpInvocations: 0
    });
    assert.equal(gaMcp.idleMcpHoarding5Turns, true);
    assert.equal(gaMcp.subType, 'IDLE_MCP_HOARDING_5_TURNS');
    assert.equal(gaMcp.recommendedEnv, 'ENABLE_TOOL_SEARCH=auto:5');
    assert.equal(gaMcp.turn0StaticPrefillBreakdown.totalStaticPrefillTokens, 64000);

    const msgs = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'BBBB' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'CCCC' } }] }
    ];
    const gaVis = gaDetectorsShared.evaluateDet20VisionOverageGuard({
      messages: msgs,
      promptText: 'Fix CSS padding error'
    });
    assert.equal(gaVis.triggered, true);
    assert.equal(gaVis.base64ImageBlockCount, 3);
    assert.equal(gaVis.cumulativeVisionTaxTokens, 9600);
  });

  it('Scenario 6 (Sim 17): gates Turn-1 >=2 blind non-test edits while exempting @file + *.test.* TDD companion pairs', async () => {
    const tddAllowed = gaDetectorsShared.evaluateDet06BlindNewModule({
      targetPath: 'src/auth/login.ts',
      fileAlreadyExists: true,
      discoveryCallsCount: 0,
      userPrompt: 'Implement login validation in @src/auth/login.ts with unit tests',
      editedFiles: ['src/auth/login.ts', 'src/auth/login.test.ts'],
      turnCount: 1,
      flightMode: 'AUTO_PILOT'
    });
    assert.equal(tddAllowed.triggered, false);

    // Even without @anchor, 1 source file + 1 *.test.ts file = only 1 non-test source file -> must NOT false-positive!
    const tddNoAnchorAllowed = gaDetectorsShared.evaluateDet06BlindNewModule({
      targetPath: 'src/auth/login.ts',
      fileAlreadyExists: true,
      discoveryCallsCount: 0,
      userPrompt: 'Implement login validation with unit tests',
      editedFiles: ['src/auth/login.ts', 'src/auth/login.test.ts'],
      turnCount: 1,
      flightMode: 'AUTO_PILOT'
    });
    assert.equal(tddNoAnchorAllowed.triggered, false);

    // 2 non-test source files on Turn 1 without @anchor and 0 discovery calls -> triggers BLIND_UNPLANNED_MULTI_EDIT
    const blindTwoSourceFiles = gaDetectorsShared.evaluateDet06BlindNewModule({
      targetPath: 'src/auth/session.ts',
      fileAlreadyExists: true,
      discoveryCallsCount: 0,
      userPrompt: 'Refactor auth subsystem',
      editedFiles: ['src/auth/login.ts', 'src/auth/session.ts'],
      turnCount: 1,
      flightMode: 'AUTO_PILOT'
    });
    assert.equal(blindTwoSourceFiles.triggered, true);
    assert.equal(blindTwoSourceFiles.subType, 'BLIND_UNPLANNED_MULTI_EDIT');
    assert.equal(blindTwoSourceFiles.decision, 'ask');
  });

  it('RSI-04 Micro-Skills: captures <=3-turn recovery, promotes at >=2 sessions, caps Baton <=80 tokens, evicts contradictions, and rejects secrets/bypasses', async () => {
    // 1. Secret & Ring-0 bypass rejection
    const secretAttempt = gaMicroSkillsPure.recordShellOutcomeInRegistry(
      gaMicroSkillsPure.createEmptyMicroSkillsRegistry(),
      { command: ['STRIPE_KEY=sk', '_live_', '1234567890abcdefghijklmnop pytest'].join(''), exitCode: 0, turn: 2, sessionId: 's1' }
    );
    assert.equal(secretAttempt.updated, false);
    assert.equal(secretAttempt.rejectedReason, 'SECRET_DETECTED');

    const bypassAttempt = gaMicroSkillsPure.recordShellOutcomeInRegistry(
      gaMicroSkillsPure.createEmptyMicroSkillsRegistry(),
      { command: 'git commit -m "wip" --no-verify', exitCode: 0, turn: 2, sessionId: 's1' }
    );
    assert.equal(bypassAttempt.updated, false);
    assert.equal(bypassAttempt.rejectedReason, 'UNSAFE_BYPASS_COMMAND');

    const hardResetAttempt = gaMicroSkillsPure.inspectCommandSafetyForMicroSkill('git reset --hard HEAD~1');
    assert.equal(hardResetAttempt.safe, false);
    assert.equal(hardResetAttempt.reason, 'UNSAFE_BYPASS_COMMAND');

    // 2. >3-turn gap does NOT capture stale failure
    let reg = gaMicroSkillsPure.createEmptyMicroSkillsRegistry();
    reg = gaMicroSkillsPure.recordShellOutcomeInRegistry(reg, {
      command: 'pytest tests/a.py',
      exitCode: 1,
      turn: 1,
      sessionId: 'gap-s1'
    }).registry;
    const staleRecovery = gaMicroSkillsPure.recordShellOutcomeInRegistry(reg, {
      command: 'poetry run pytest tests/a.py',
      exitCode: 0,
      turn: 6, // 5 turns later (>3 window)
      sessionId: 'gap-s1'
    });
    assert.equal(staleRecovery.capturedCandidate, null);

    // 3. 2-session promotion + PreToolUse intercept + SessionStart <80-tok cap + contradiction eviction
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ms-e2e-'));
    try {
      // Session 1: captured (confirmations=1, promoted=false)
      await runStrictPostToolUse({
        conversationId: 'sess-1',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'pytest tests/unit/test_user.py::test_auth' },
        exitCode: 1,
        turn: 1
      });
      await runStrictPostToolUse({
        conversationId: 'sess-1',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'poetry run pytest tests/unit/test_user.py::test_auth' },
        exitCode: 0,
        turn: 2
      });
      const afterS1 = gaMicroSkillsStore.loadMicroSkillsRegistry(tmpWs);
      assert.equal(afterS1.skills.length, 1);
      assert.equal(afterS1.skills[0].promoted, false);

      // Session 2: promoted (confirmations=2, promoted=true)
      await runStrictPostToolUse({
        conversationId: 'sess-2',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'pytest tests/unit/test_order.py' },
        exitCode: 1,
        turn: 1
      });
      await runStrictPostToolUse({
        conversationId: 'sess-2',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'poetry run pytest tests/unit/test_order.py' },
        exitCode: 0,
        turn: 3
      });
      const afterS2 = gaMicroSkillsStore.loadMicroSkillsRegistry(tmpWs);
      assert.equal(afterS2.skills[0].promoted, true);
      assert.equal(afterS2.skills[0].failedCmd, 'pytest');
      assert.equal(afterS2.skills[0].workingCmd, 'poetry run pytest');

      // SessionStart injects <= 80 tokens
      const startOut = await handleSessionStart({
        conversationId: 'sess-3',
        workspacePath: tmpWs,
        homeDir: tmpWs
      });
      assert.ok(startOut.microSkillsBaton.includes('"pytest" -> "poetry run pytest"'));
      assert.ok(Math.ceil(startOut.microSkillsBaton.length / 4) <= 80);

      // PreToolUse intercepts in COACH (warn/allow) and AUTO_PILOT (deny)
      const coachPre = await runStrictPreToolUse({
        conversationId: 'sess-3',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'pytest' },
        flightMode: 'COACH'
      });
      assert.equal(coachPre.detectorId, 'RSI-04');
      assert.equal(coachPre.decision, 'allow');

      const autoPre = await runStrictPreToolUse({
        conversationId: 'sess-3',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'pytest' },
        flightMode: 'AUTO_PILOT'
      });
      assert.equal(autoPre.detectorId, 'RSI-04');
      assert.equal(autoPre.decision, 'deny');

      // Contradiction eviction:
      // (a) A standalone unit-test failure of workingCmd ('poetry run pytest') does NOT falsely evict during TDD
      await runStrictPostToolUse({
        conversationId: 'sess-4',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'poetry run pytest' },
        exitCode: 1,
        turn: 1
      });
      const afterSingleFail = gaMicroSkillsStore.loadMicroSkillsRegistry(tmpWs);
      assert.equal(afterSingleFail.skills.length, 1);
      assert.equal(afterSingleFail.skills[0].promoted, true);

      // (b) When an alternative runner ('uv run pytest') succeeds within <=3 turns, evict contradicted 'pytest -> poetry run pytest'
      await runStrictPostToolUse({
        conversationId: 'sess-4',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'uv run pytest' },
        exitCode: 0,
        turn: 2
      });
      const afterSuperseded = gaMicroSkillsStore.loadMicroSkillsRegistry(tmpWs);
      assert.equal(
        afterSuperseded.skills.some((s) => s.failedCmd === 'pytest' && s.workingCmd === 'poetry run pytest'),
        false
      );
      assert.equal(afterSuperseded.skills.length, 1);
      assert.equal(afterSuperseded.skills[0].failedCmd, 'poetry run pytest');
      assert.equal(afterSuperseded.skills[0].workingCmd, 'uv run pytest');
      assert.equal(afterSuperseded.skills[0].promoted, false);

      // (c) If failedCmd ('poetry run pytest') subsequently succeeds directly, evict the stale candidate too
      await runStrictPostToolUse({
        conversationId: 'sess-5',
        cwd: tmpWs,
        homeDir: tmpWs,
        tool_name: 'run_command',
        tool_input: { CommandLine: 'poetry run pytest' },
        exitCode: 0,
        turn: 1
      });
      const afterDirectWorks = gaMicroSkillsStore.loadMicroSkillsRegistry(tmpWs);
      assert.equal(afterDirectWorks.skills.length, 0);

      // Verify <80-token cap with 25 synthetic promoted skills
      const manySkills = {
        skills: Array.from({ length: 25 }, (_, i) => ({
          promoted: true,
          failedCmd: `npm test --pkg-${i}`,
          workingCmd: `pnpm --filter pkg-${i} test`
        }))
      };
      const capped = gaMicroSkillsPure.formatMicroSkillsBatonSnippet(manySkills);
      assert.ok(capped.snippet.length <= gaMicroSkillsPure.MAX_MICRO_SKILL_BATON_CHARS);
      assert.ok(capped.estimatedTokens <= gaMicroSkillsPure.MAX_MICRO_SKILL_BATON_TOKENS);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('enforces Mod Law 4 (zero node:* imports in core-isomorphic & CC src/ excluding nodeIo adapter) and pure zero-I/O in src/core/shared/', () => {
    const gaIsoFiles = walkMjsFiles(path.join(GA_ROOT, 'src', 'core-isomorphic'));
    assert.ok(gaIsoFiles.length > 0);
    for (const file of gaIsoFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/from\s+['"]node:/.test(text), `Forbidden node:* import in ${file}`);
    }

    const gaSharedFiles = walkMjsFiles(path.join(GA_ROOT, 'src', 'core', 'shared'));
    for (const file of gaSharedFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(
        !/node:(fs|child_process|sqlite|http|https|net|tls|dgram)/.test(text),
        `Forbidden I/O import in ${file}`
      );
    }

    if (HAS_CC_REPO) {
      const ccSrcFiles = walkMjsFiles(path.join(CC_ROOT, 'src')).filter(
        (f) => !f.replace(/\\/g, '/').endsWith('/src/utils/nodeIo.mjs')
      );
      assert.ok(ccSrcFiles.length > 0);
      for (const file of ccSrcFiles) {
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!/from\s+['"]node:/.test(text), `Forbidden Mod-Law-4 node:* import in CC_REPO ${file}`);
      }
    }
  });

  it('respects PreInvocation habit overrides (off | warn | block) for formatter-bypass', async () => {
    const code50Lines = Array.from({ length: 50 }, (_, i) => `const x_${i} = ${i};`).join('\n');
    const prompt = `Please fix the indentation and sort imports across this file:\n\`\`\`ts\n${code50Lines}\n\`\`\``;

    const offRes = await handlePreInvocation({
      conversationId: 'test-fmt-off',
      prompt,
      turnCount: 2,
      horizonConfig: { semanticDetectors: { 'formatter-bypass': 'off' } }
    });
    assert.equal(offRes.systemMessage, undefined);
    assert.equal(offRes.terminationBehavior, undefined);

    const warnRes = await handlePreInvocation({
      conversationId: 'test-fmt-warn',
      prompt,
      turnCount: 2,
      horizonConfig: { semanticDetectors: { 'formatter-bypass': 'warn' } }
    });
    assert.ok(warnRes.systemMessage?.includes('DET-15'));
    assert.equal(warnRes.terminationBehavior, undefined);

    const blockRes = await handlePreInvocation({
      conversationId: 'test-fmt-block',
      prompt,
      turnCount: 2,
      horizonConfig: { semanticDetectors: { 'formatter-bypass': 'block' } }
    });
    assert.equal(blockRes.terminationBehavior, 'terminate');
    assert.ok(blockRes.userMessage?.includes('DET-15'));
  });

  it('Prompt Hygiene Governor (v4.1 Phase 1): evaluates Scope Brake & Relay Breaker in <1ms with autonomous/anchor bypasses and Two-Stage PreToolUse intercept', async () => {
    const t0 = performance.now();

    // 1. Scope Brake triggers on unanchored <12-word imperative ('make it better')
    const unanchored = gaDetectorsShared.evaluateScopeBrake({
      prompt: 'make it better',
      modifiedFiles: ['src/auth/token.ts', 'src/auth/session.ts'],
      overrideMode: 'steer'
    });
    assert.equal(unanchored.triggered, true);
    assert.equal(unanchored.decision, 'steer');
    assert.equal(unanchored.unanchoredTurnFlag, true);
    assert.ok(unanchored.steerContext.includes('src/auth/token.ts'));

    // 2. Scope Brake bypasses autonomous turns, affirmative replies, single-file focus, and prior failures
    assert.equal(
      gaDetectorsShared.evaluateScopeBrake({ prompt: 'yes, ship it', modifiedFiles: ['a.ts'] }).triggered,
      false
    );
    assert.equal(
      gaDetectorsShared.evaluateScopeBrake({ prompt: 'fix it', priorTurnEditedFilesCount: 1 }).triggered,
      false
    );
    assert.equal(
      gaDetectorsShared.evaluateScopeBrake({ prompt: 'still broken', priorTurnHadToolOrTestFailure: true }).triggered,
      false
    );
    assert.equal(
      gaDetectorsShared.evaluateScopeBrake({ prompt: 'make it better', provenance: 'subagent' }).triggered,
      false
    );

    // 3. Relay Breaker transitions Idle -> Candidate -> Armed -> Final Pass -> Locked & aborts on hard negative filters
    const stackTracePrompt = `${'Error: failed\n  at Object.<anonymous> (src/index.ts:42:13)\n'.repeat(45)}What I confirmed and where the spec overreaches 8/10`;
    const negRes = gaDetectorsShared.evaluateRelayBreaker({ prompt: stackTracePrompt });
    assert.equal(negRes.triggered, false);
    assert.equal(negRes.hardNegativeFilter, 'STACK_TRACE');

    const critiqueBody = `${'The reviewer critique raises architectural questions about cache invalidation. '.repeat(25)}\nWhat I confirmed: the prefix boundary holds up.\nWhere the spec overreaches: S0: Blocker on hook timeout and overall assessment 8.5/10.`;
    const r1 = gaDetectorsShared.evaluateRelayBreaker({
      prompt: critiqueBody,
      relayState: null,
      sourceCodeEditsInSession: 0
    });
    assert.equal(r1.nextState, 'Candidate');

    const r2 = gaDetectorsShared.evaluateRelayBreaker({
      prompt: critiqueBody,
      relayState: r1.relayStateSnapshot,
      priorTurnWebSearches: 3,
      sourceCodeEditsInSession: 0,
      boundSpecPath: 'ARCHITECTURE.md'
    });
    assert.equal(r2.triggered, true);
    assert.equal(r2.nextState, 'Armed');
    assert.ok(r2.tailInjection.includes('ARCHITECTURE.md'));

    const r3 = gaDetectorsShared.evaluateRelayBreaker({
      prompt: critiqueBody,
      relayState: r2.relayStateSnapshot,
      sourceCodeEditsInSession: 0
    });
    assert.equal(r3.nextState, 'Final Pass');

    const r4 = gaDetectorsShared.evaluateRelayBreaker({
      prompt: critiqueBody,
      relayState: r3.relayStateSnapshot,
      sourceCodeEditsInSession: 0,
      flightMode: 'AUTO_PILOT'
    });
    assert.equal(r4.nextState, 'Locked');
    assert.equal(r4.decision, 'block');

    // Reset to Idle when source code is edited
    const rReset = gaDetectorsShared.evaluateRelayBreaker({
      prompt: critiqueBody,
      relayState: r4.relayStateSnapshot,
      sourceCodeEditedSinceLastRelay: true
    });
    assert.equal(rReset.nextState, 'Idle');

    // 4. Two-Stage PreToolUse Sightseeing Interception
    const twoStageScope = gaDetectorsShared.evaluateTwoStageSightseeingIntercept({
      toolName: 'grep_search',
      toolArgs: { Query: 'optimize' },
      unanchoredTurnFlag: true,
      candidateFiles: ['src/auth/token.ts'],
      overrideMode: 'warn'
    });
    assert.equal(twoStageScope.intercepted, true);
    assert.equal(twoStageScope.decision, 'deny');
    assert.equal(twoStageScope.consumeFlag, true);

    const twoStageRelayWeb = gaDetectorsShared.evaluateTwoStageSightseeingIntercept({
      toolName: 'search_web',
      toolArgs: { query: 'claude hooks spec' },
      relayState: r2.relayStateSnapshot
    });
    assert.equal(twoStageRelayWeb.intercepted, true);
    assert.equal(twoStageRelayWeb.decision, 'deny');

    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 25, `Expected <25ms for full hygiene suite, took ${elapsedMs.toFixed(2)}ms`);
  });
});
