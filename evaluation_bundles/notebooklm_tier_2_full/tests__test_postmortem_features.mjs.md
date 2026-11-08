# Source File: tests/test_postmortem_features.mjs

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { scorePromptSufficiency, SUFFICIENCY_BANDS } from '../src/core/prompt_rubric.mjs';
import {
  computePlanChurn,
  gradeProofQuality,
  detectContextRot,
  fingerprintErrorLoop,
  normalizeErrorSignature
} from '../src/core/session_forensics.mjs';
import { auditHandoff, HANDOFF_RESULTS } from '../src/core/handoff_audit.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { runPostmortem, ROOT_CAUSES, REWORK_SHAPES } from '../src/cli/postmortem.mjs';
import { createDefaultSidecar, writeSidecarAtomicSync } from '../src/core/sidecar_store.mjs';

describe('1. Prompt Sufficiency Rubric (6-Dimension 0-12)', () => {
  test('vague multi-file prompt scores Low band and identifies missing ingredients', () => {
    const res = scorePromptSufficiency('refactor everything and make it work');
    assert.strictEqual(res.band, SUFFICIENCY_BANDS.LOW);
    assert.ok(res.score < 5, `Expected score < 5, got ${res.score}`);
    assert.ok(res.missing.length >= 2, 'Expected missing ingredients');
    assert.strictEqual(res.shortPrompt, false);
  });

  test('comprehensive scoped prompt scores High band (>=9)', () => {
    const prompt = 'In @src/core/classifier.mjs, update calculateAttentionWeight() to return 1.0. Do not touch other files. Tests in tests/test_router_and_sensors.mjs must pass. Dependent callers in horizon_hud.mjs should be checked.';
    const res = scorePromptSufficiency(prompt, { activeSetPaths: ['src/core/classifier.mjs'] });
    assert.strictEqual(res.band, SUFFICIENCY_BANDS.HIGH);
    assert.ok(res.score >= 9, `Expected score >= 9, got ${res.score}`);
    assert.strictEqual(res.missing.length, 0);
  });

  test('short prompt rule: concise instructions targeting active set are not penalised', () => {
    const res = scorePromptSufficiency('fix typo in classifier.mjs', {
      activeSetPaths: ['src/core/classifier.mjs']
    });
    assert.strictEqual(res.shortPrompt, true);
  });
});

describe('2. Session Forensics (Plan Churn, Proof Quality, Context Rot, Loops)', () => {
  test('computePlanChurn detects plan thrashing when revisions >= 3', () => {
    const steps = [
      { toolCalls: [{ name: 'write_file', args: { Path: 'C:/app/implementation_plan.md' } }] },
      { toolCalls: [{ name: 'edit_file', args: { Path: 'C:/app/src/index.js' } }] },
      { toolCalls: [{ name: 'edit_file', args: { Path: 'C:/app/implementation_plan.md' } }] },
      { toolCalls: [{ name: 'write_file', args: { Path: 'C:/app/implementation_plan.md' } }] }
    ];
    const churn = computePlanChurn(steps, { plan_revision_warn: 3 });
    assert.strictEqual(churn.planRevisions, 3);
    assert.strictEqual(churn.warn, true);
  });

  test('gradeProofQuality attributes Strong proof to passing test suite runs', () => {
    const steps = [
      { toolCalls: [{ name: 'edit_file', args: { Path: 'src/app.js' } }] },
      {
        toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
        exitCode: 0
      },
      { content: 'All steps are verified and the task is complete.' }
    ];
    const proof = gradeProofQuality(steps);
    assert.strictEqual(proof.grade, 'Strong');
  });

  test('gradeProofQuality attributes Weak proof to file edits without execution', () => {
    const steps = [
      { toolCalls: [{ name: 'edit_file', args: { Path: 'src/app.js' } }] },
      { content: 'Task is complete.' }
    ];
    const proof = gradeProofQuality(steps);
    assert.strictEqual(proof.grade, 'Weak');
  });

  test('detectContextRot requires degradation evidence alongside duration', () => {
    // 50 minutes duration, but 0 errors -> should NOT split
    const t0 = new Date('2026-03-25T10:00:00Z').toISOString();
    const t1 = new Date('2026-03-25T10:55:00Z').toISOString();
    const cleanSteps = [
      { created_at: t0, exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { created_at: t1, exitCode: 0 }
    ];
    const resClean = detectContextRot(cleanSteps, { correctionCount: 0, signalPurityPct: 90 }, { split_recommend_minutes: 45 });
    assert.strictEqual(resClean.splitRecommended, false);

    // 50 minutes duration with deteriorating error streak in final third -> should split
    const rotSteps = [
      { created_at: t0, exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1, status: 'ERROR' },
      { exitCode: 1, status: 'ERROR' },
      { created_at: t1, exitCode: 1, status: 'ERROR' }
    ];
    const resRot = detectContextRot(rotSteps, { correctionCount: 3, signalPurityPct: 40 }, { split_recommend_minutes: 45 });
    assert.strictEqual(resRot.splitRecommended, true);
  });

  test('fingerprintErrorLoop detects identical error signature across non-consecutive steps', () => {
    const steps = [
      { toolCalls: [{ name: 'run_command', args: { CommandLine: 'node server.js' } }], status: 'ERROR', content: 'Error: Cannot find module ./missing.js at Object.<anonymous> (C:\\code\\server.js:12:34)' },
      { toolCalls: [{ name: 'read_file', args: { Path: 'package.json' } }] },
      { toolCalls: [{ name: 'run_command', args: { CommandLine: 'node server.js' } }], status: 'ERROR', content: 'Error: Cannot find module ./missing.js at Object.<anonymous> (C:\\code\\server.js:12:34)' },
      { toolCalls: [{ name: 'read_file', args: { Path: 'src/index.js' } }] },
      { toolCalls: [{ name: 'run_command', args: { CommandLine: 'node server.js' } }], status: 'ERROR', content: 'Error: Cannot find module ./missing.js at Object.<anonymous> (C:\\code\\server.js:12:34)' }
    ];
    const loop = fingerprintErrorLoop(steps);
    assert.strictEqual(loop.loop, true);
    assert.strictEqual(loop.occurrences, 3);
    assert.strictEqual(loop.category, 'config');
  });
});

describe('3. Handoff Quality Gate (5 Checks)', () => {
  const tmpDir = path.join(os.tmpdir(), `test_handoff_${Date.now()}`);

  test('clean task.md passes audit with CLEAN result', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const cleanTask = `
# Tasks
- [x] Initial setup
- [/] Updating @src/core/classifier.mjs with attention curve
- [ ] Add unit test in @tests/test_router_and_sensors.mjs for attention weights

## Decisions
- 2026-03-25: Use exponential U-shaped attention curve. Rationale: matches lost-in-the-middle empirical data.
`;
    const taskPath = path.join(tmpDir, 'task.md');
    fs.writeFileSync(taskPath, cleanTask, 'utf8');

    const audit = auditHandoff(tmpDir, {
      planChurn: { planRevisions: 1 },
      activeSignal: { taskMdTurnsBehind: 1 }
    });
    assert.strictEqual(audit.result, HANDOFF_RESULTS.CLEAN);
    assert.strictEqual(audit.fixes.length, 0);
  });

  test('vague next action and stale checkpoint trigger NEEDS_FIXES with specific reasons', () => {
    const vagueTask = `
# Tasks
- [ ] continue working
`;
    const taskPath = path.join(tmpDir, 'task.md');
    fs.writeFileSync(taskPath, vagueTask, 'utf8');

    const audit = auditHandoff(tmpDir, {
      planChurn: { planRevisions: 0 },
      activeSignal: { taskMdTurnsBehind: 5 }
    });
    assert.strictEqual(audit.result, HANDOFF_RESULTS.NEEDS_FIXES);
    assert.ok(audit.fixes.some(f => f.includes('next action')));
    assert.ok(audit.fixes.some(f => f.includes('task.md')));
  });

  test('missing task.md reports MISSING result', () => {
    const emptyDir = path.join(os.tmpdir(), `empty_session_${Date.now()}`);
    fs.mkdirSync(emptyDir, { recursive: true });
    const audit = auditHandoff(emptyDir);
    assert.strictEqual(audit.result, HANDOFF_RESULTS.MISSING);
  });
});

describe('4. PreInvocation Router Integration & Invariants', () => {
  const testConvId = `test_conv_router_${Date.now()}`;

  test('#check scorecard uses rubric score and never renders static 65/100', async () => {
    const sidecar = createDefaultSidecar(testConvId);
    sidecar.sessionMeta.turnCount = 1;
    writeSidecarAtomicSync(testConvId, sidecar);

    const res = await handlePreInvocation({
      conversationId: testConvId,
      prompt: '#check refactor everything across the entire codebase'
    });

    assert.strictEqual(res.terminationBehavior, 'terminate');
    assert.ok(!res.userMessage.includes('[Score 65/100]'), 'Must NOT contain hardcoded Score 65/100');
    assert.ok(res.userMessage.includes('Sufficiency'), 'Must contain Sufficiency rubric score');
  });

  test('amputation halt card enforces UI invariant: plain-text /compact instruction only', async () => {
    const ampConvId = `test_conv_amp_${Date.now()}`;
    const sidecar = createDefaultSidecar(ampConvId);
    sidecar.telemetry.amputationRisk = true;
    sidecar.telemetry.totalInputTokens = 150000;
    sidecar.handoff = {
      result: HANDOFF_RESULTS.NEEDS_FIXES,
      failingChecks: ['Next Action Clarity']
    };
    writeSidecarAtomicSync(ampConvId, sidecar);

    const res = await handlePreInvocation({
      conversationId: ampConvId,
      prompt: 'Implement billing endpoint'
    });

    assert.strictEqual(res.terminationBehavior, 'terminate');
    assert.ok(res.userMessage.includes('Amputation Crisis'));
    assert.ok(res.userMessage.includes('Handoff NEEDS FIXES'));
    // User rule invariant: never render clickable button or Ctrl+V
    assert.ok(!res.userMessage.includes('btnCompactPrimary'));
    assert.ok(!res.userMessage.includes('Ctrl+V'));
    assert.ok(res.userMessage.includes('/compact'));
  });
});

describe('5. Evidence-Based Postmortem Engine', () => {
  test('runPostmortem returns structured diagnostic result with bounded metrics', async () => {
    const res = await runPostmortem({ last: 5, writeFiles: false });
    assert.ok(typeof res.sessionCount === 'number');
    assert.ok(typeof res.worstPurityPct === 'number');
    assert.ok(res.worstPurityPct >= 0 && res.worstPurityPct <= 100);
    assert.ok(Array.isArray(res.recommendations));
    assert.ok(res.recommendations.length <= 5, 'Recommendations must be capped at 5 per reflect.md');
  });
});
```
