import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalizePath, isSameOrSubPath } from '../src/core/path_canonicalizer.mjs';
import {
  createDefaultSidecar,
  readSidecarSync,
  writeSidecarAtomicSync
} from '../src/core/sidecar_store.mjs';
import { classifyHorizonWindow, CATEGORIES } from '../src/core/horizon_classifier.mjs';
import { runAllBlindspotSensors } from '../src/core/blindspot_sensors.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { runHud } from '../src/cli/horizon_hud.mjs';
import {
  SCENARIO_1_COLD_VAGUE,
  SCENARIO_2_WARM_ACTIVE_SET,
  SCENARIO_3_HOT_CONCURRENCY,
  SCENARIO_4_POLLUTED_REFACTOR,
  SCENARIO_5_AMPUTATION_CRISIS,
  SCENARIO_6_PARALLEL_DRIFT,
  SCENARIO_7_QUOTA_SHIELD,
  SCENARIO_8_EXPLICIT_CHECK
} from './fixtures/synthetic_states.mjs';

describe('1. Path Canonicalization & URI Schemes', () => {
  test('decodes URI schemes and matches Windows backslashes', () => {
    const uri = 'file:///c%3A/Projects/argon-test\\studio\\generators.py';
    const win = 'C:\\Projects\\argon-test/studio/generators.py';
    assert.equal(canonicalizePath(uri), canonicalizePath(win));
    assert.equal(canonicalizePath(uri), 'c:/projects/argon-test/studio/generators.py');
  });

  test('isSameOrSubPath correctly matches subdirectories', () => {
    const parent = 'c:/projects/my-app';
    const child = 'C:\\Projects\\my-app/src/utils/file.js';
    const foreign = 'd:/other/file.js';
    assert.ok(isSameOrSubPath(parent, child));
    assert.ok(!isSameOrSubPath(parent, foreign));
  });
});

describe('2. Atomic Sidecar Store & JSON Resilience', () => {
  test('reads and writes sidecar state atomically in <2ms', () => {
    const tmpDir = path.join(os.tmpdir(), `fc_sidecar_test_${Date.now()}`);
    const cid = 'test_cid_42';
    const init = createDefaultSidecar(cid, 'c:/my-workspace');
    writeSidecarAtomicSync(cid, init, tmpDir);

    const read = readSidecarSync(cid, tmpDir);
    assert.equal(read.conversationId, cid);
    assert.equal(read.workspacePath, 'c:/my-workspace');

    // Corrupt file resilience test
    const filePath = path.join(tmpDir, 'sessions', `${cid}.sidecar.json`);
    fs.writeFileSync(filePath, '{ corrupt: [ unclosed JSON ', 'utf8');
    const fallback = readSidecarSync(cid, tmpDir);
    assert.equal(fallback.version, '3.1.0');
    assert.equal(fallback.conversationId, cid);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});

describe('3. 40-Cell Horizon Classifier & Sludge Tax', () => {
  test('assigns 40 cells and calculates Purity and Sludge', () => {
    const events = [
      { stepIndex: 0, role: 'system', type: 'SCHEMA', tokenEstimate: 5000 },
      { stepIndex: 1, role: 'tool', toolName: 'view_file', targetPath: 'c:/app/index.js', exitCode: 0, tokenEstimate: 10000 },
      { stepIndex: 2, role: 'tool', toolName: 'view_file', targetPath: 'c:/app/index.js', exitCode: 0, tokenEstimate: 10000 }
    ];
    const res = classifyHorizonWindow(events, { total_input_tokens: 30000, modelName: 'gemini-3.8-flash' }, 'c:/app');
    assert.equal(res.cells.length, 40);
    assert.ok(res.fileState.staleDupPaths.includes('c:/app/index.js'));
    assert.ok(res.metrics.sludgeTaxUsdPerTurn > 0);
  });
});

describe('4. The 6 Blind-Spot Sensors', () => {
  test('flags all 6 hazards accurately', () => {
    const tmp = path.join(os.tmpdir(), `fc_sens_${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const targetFile = path.join(tmp, 'target.js');
    fs.writeFileSync(targetFile, Array(700).fill('// row').join('\n'), 'utf8');

    const evs = [
      { stepIndex: 0, role: 'system', type: 'SCHEMA', tokenEstimate: 35000 },
      { stepIndex: 1, role: 'tool', toolName: 'view_file', targetPath: 'c:/app/legacy/old.js', tokenEstimate: 500 },
      { stepIndex: 2, role: 'tool', toolName: 'run_command', exitCode: 1, tokenEstimate: 50 },
      { stepIndex: 3, role: 'tool', toolName: 'run_command', exitCode: 1, tokenEstimate: 50 },
      { stepIndex: 4, role: 'tool', toolName: 'run_command', exitCode: 1, tokenEstimate: 50 }
    ];

    const sidecar = {
      sessionMeta: { turnCount: 4, activeModel: 'gemini-3.8-flash', inPlanMode: true, turnsSinceLastPassingTest: 4 },
      telemetry: { totalInputTokens: 50000, quota: { remaining_fraction: 0.05 } }
    };

    const out = runAllBlindspotSensors({
      stepEvents: evs,
      sidecarState: sidecar,
      workspacePath: tmp,
      targetFiles: [targetFile],
      activeSetPaths: [],
      toolUsageLedger: { servers: { 'unused-tool': { invocationsLast15Sessions: 0 } } },
      promptText: 'rewrite the entire file',
      config: { quota_floor_fraction: 0.10, max_single_write_lines: 600, deprecated_paths: ['**/legacy/**'] }
    });

    assert.equal(out.schemaTaxPct, 17.5);
    assert.ok(out.unusedMcpServers.includes('unused-tool'));
    assert.ok(out.legacyPoisonPaths.some(p => p.includes('legacy')));
    assert.equal(out.quotaFloorBreached, true);
    assert.ok(out.streamCutoffRiskFiles.length > 0);
    assert.equal(out.threeStrikeLoop, true);

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
});

describe('5. The 8 PreInvocation Router States & Control Flags', () => {
  test('State 1: ALLOW_SILENT with ! prefix', async () => {
    const res = await handlePreInvocation({ prompt: '! test without check' });
    assert.deepEqual(res, {});
  });

  test('Control Flag: !lock locks effort in sidecar', async () => {
    const cid = 'lock_test';
    writeSidecarAtomicSync(cid, createDefaultSidecar(cid));
    const res = await handlePreInvocation({ conversationId: cid, prompt: '!lock proceed' });
    assert.deepEqual(res, {});
    const read = readSidecarSync(cid);
    assert.equal(read.sessionMeta.effortLocked, true);
  });

  test('State 2: ALLOW_ACTIVE_SET on recency match', async () => {
    const s = SCENARIO_2_WARM_ACTIVE_SET;
    writeSidecarAtomicSync(s.conversationId, s.sidecar);
    const res = await handlePreInvocation(s);
    assert.deepEqual(res, {});
  });

  test('State 3: ALLOW_PLAN_OR_SUBAGENT in plan mode', async () => {
    const cid = 'plan_test';
    const sc = createDefaultSidecar(cid);
    sc.sessionMeta.inPlanMode = true;
    writeSidecarAtomicSync(cid, sc);
    const res = await handlePreInvocation({ conversationId: cid, prompt: 'Outline next architecture phase' });
    assert.deepEqual(res, {});
  });

  test('State 4: INJECT_CONTEXT_GUARD on drift', async () => {
    const s = SCENARIO_6_PARALLEL_DRIFT;
    writeSidecarAtomicSync(s.conversationId, s.sidecar);
    const res = await handlePreInvocation(s);
    assert.ok(res.systemMessage?.includes('[Flight Check Context Guard]'));
  });

  test('State 5: STEER_SUBAGENT on warm concurrency query', async () => {
    const s = SCENARIO_3_HOT_CONCURRENCY;
    writeSidecarAtomicSync(s.conversationId, s.sidecar);
    const res = await handlePreInvocation(s);
    assert.ok(res.systemMessage?.includes('invoke_subagent'));
  });

  test('State 6: HALT_HYGIENE_OR_SAFETY on amputation crisis & polluted context', async () => {
    const s1 = SCENARIO_5_AMPUTATION_CRISIS;
    writeSidecarAtomicSync(s1.conversationId, s1.sidecar);
    const res1 = await handlePreInvocation(s1);
    assert.equal(res1.terminationBehavior, 'terminate');
    assert.ok(res1.userMessage.includes('/clear'));

    const s2 = SCENARIO_4_POLLUTED_REFACTOR;
    writeSidecarAtomicSync(s2.conversationId, s2.sidecar);
    const res2 = await handlePreInvocation(s2);
    assert.equal(res2.terminationBehavior, 'terminate');
    assert.ok(res2.userMessage.includes('/compact'));
  });

  test('State 7: HALT_EFFORT_OR_QUOTA on quota breach', async () => {
    const s = SCENARIO_7_QUOTA_SHIELD;
    writeSidecarAtomicSync(s.conversationId, s.sidecar);
    const res = await handlePreInvocation(s);
    assert.equal(res.terminationBehavior, 'terminate');
    assert.ok(res.userMessage.includes('Quota Floor Breached'));
  });

  test('State 8: HALT_REWRITE_SCORECARD on #check or vague cold start', async () => {
    const s1 = SCENARIO_8_EXPLICIT_CHECK;
    writeSidecarAtomicSync(s1.conversationId, s1.sidecar);
    const res1 = await handlePreInvocation(s1);
    assert.equal(res1.terminationBehavior, 'terminate');
    assert.ok(res1.userMessage.includes('Flight Check v3.1'));

    const s2 = SCENARIO_1_COLD_VAGUE;
    writeSidecarAtomicSync(s2.conversationId, s2.sidecar);
    const res2 = await handlePreInvocation(s2);
    assert.equal(res2.terminationBehavior, 'terminate');
    assert.ok(res2.userMessage.includes('Flight Check v3.1'));
  });
});

describe('6. HUD Reliability & Crash-Immunity', () => {
  test('horizon_hud handles empty and malformed stdin with exit 0 immunity', async () => {
    const res = await runHud({ stdinData: {}, silent: true });
    assert.ok(res.output.includes('Purity:'));
  });
});

describe('7. Router Ergonomics: Advisory Mode & Halt Cooldown', () => {
  test('Advisory mode (hook_level: advisory) warns via systemMessage but never terminates', async () => {
    const s = { ...SCENARIO_4_POLLUTED_REFACTOR, conversationId: `adv_test_${Date.now()}` };
    writeSidecarAtomicSync(s.conversationId, s.sidecar);

    const res = await handlePreInvocation({
      ...s,
      configOverride: { hook_level: 'advisory' }
    });

    assert.notEqual(res.terminationBehavior, 'terminate');
    assert.ok(res.systemMessage?.includes('Flight Check v3.1'));
  });

  test('Halt cooldown downgrades repeat halts to systemMessage for 3 turns', async () => {
    const cid = `cooldown_test_${Date.now()}`;
    const sidecar = createDefaultSidecar(cid);
    sidecar.sessionMeta.turnCount = 10;
    sidecar.sensors.threeStrikeLoop = true; // Error loop condition
    writeSidecarAtomicSync(cid, sidecar);

    // Turn 10: First occurrence -> terminates
    const res10 = await handlePreInvocation({
      conversationId: cid,
      prompt: 'Retry the build',
      configOverride: { hook_level: 'guard', halt_cooldown_turns: 3 }
    });
    assert.equal(res10.terminationBehavior, 'terminate');
    assert.ok(res10.userMessage.includes('3-Strike Error Loop'));

    // Turn 11: 1 turn later -> within cooldown -> downgrades to systemMessage
    sidecar.sessionMeta.turnCount = 11;
    sidecar.sessionMeta.lastHalts = { THREE_STRIKE_LOOP: 10 };
    writeSidecarAtomicSync(cid, sidecar);

    const res11 = await handlePreInvocation({
      conversationId: cid,
      prompt: 'Retry the build again',
      configOverride: { hook_level: 'guard', halt_cooldown_turns: 3 }
    });
    assert.notEqual(res11.terminationBehavior, 'terminate');
    assert.ok(res11.systemMessage?.includes('3-Strike Error Loop'));

    // Turn 14: 4 turns later (14 - 10 = 4 > 3) -> cooldown expired -> terminates again
    sidecar.sessionMeta.turnCount = 14;
    writeSidecarAtomicSync(cid, sidecar);

    const res14 = await handlePreInvocation({
      conversationId: cid,
      prompt: 'Retry the build after 4 turns',
      configOverride: { hook_level: 'guard', halt_cooldown_turns: 3 }
    });
    assert.equal(res14.terminationBehavior, 'terminate');
    assert.ok(res14.userMessage.includes('3-Strike Error Loop'));
  });

  test('Amputation crisis is exempt from cooldown (always terminates to prevent rule loss)', async () => {
    const cid = `amp_exempt_${Date.now()}`;
    const sidecar = createDefaultSidecar(cid);
    sidecar.sessionMeta.turnCount = 20;
    sidecar.sessionMeta.lastHalts = { AMPUTATION_CRISIS: 19 }; // Was halted just 1 turn ago
    sidecar.telemetry.totalInputTokens = 185000;
    sidecar.telemetry.amputationRisk = true;
    sidecar.telemetry.confidence = 'HIGH';
    writeSidecarAtomicSync(cid, sidecar);

    const res = await handlePreInvocation({
      conversationId: cid,
      prompt: 'Continue with next task',
      configOverride: { hook_level: 'guard', halt_cooldown_turns: 3 }
    });

    // Must still terminate because amputation is exempt
    assert.equal(res.terminationBehavior, 'terminate');
    assert.ok(res.userMessage.includes('[Amputation Crisis]'));
  });
});
