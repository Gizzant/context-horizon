import assert from 'node:assert/strict';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { writeSidecarAtomicSync, createDefaultSidecar } from '../src/core/sidecar_store.mjs';

console.log('--- Verifying Phase 5: Lifecycle Hooks & 8-State Router ---');

const testSessionId = 'test_pre_invoc_session';
const baseSidecar = createDefaultSidecar(testSessionId, 'c:/projects/ga-visualizer-v2');

// 1. ALLOW_SILENT test (with ! prefix)
const t0 = process.hrtime.bigint();
const res1 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: '! run arbitrary command without flightcheck'
});
const t1 = process.hrtime.bigint();
const duration1 = Number(t1 - t0) / 1_000_000;

console.log(`ALLOW_SILENT duration: ${duration1.toFixed(3)}ms`);
assert.deepEqual(res1, {}, 'ALLOW_SILENT must return empty object {}');
console.log('✓ Check 1: ALLOW_SILENT returned {}');

// 2. STEER_SUBAGENT test
const warmSidecar = {
  ...baseSidecar,
  telemetry: {
    ...baseSidecar.telemetry,
    totalInputTokens: 35000,
    signalPurityPct: 85.0
  },
  sessionMeta: {
    ...baseSidecar.sessionMeta,
    activeEffort: 'low',
    turnCount: 5
  }
};
writeSidecarAtomicSync(testSessionId, warmSidecar);

const t2 = process.hrtime.bigint();
const res2 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: 'Diagnose the concurrency deadlock in the worker queue',
  effort: 'low'
});
const t3 = process.hrtime.bigint();
const duration2 = Number(t3 - t2) / 1_000_000;

console.log(`STEER_SUBAGENT duration: ${duration2.toFixed(3)}ms`);
assert.ok(res2.systemMessage, 'STEER_SUBAGENT must inject systemMessage');
assert.ok(res2.systemMessage.includes('invoke_subagent'), 'Must advise using invoke_subagent');
console.log('✓ Check 2: STEER_SUBAGENT injected KV-Cache preservation directive.');

// 3. HALT_HYGIENE_OR_SAFETY test (Amputation risk)
const amputateSidecar = {
  ...baseSidecar,
  telemetry: {
    ...baseSidecar.telemetry,
    totalInputTokens: 160000,
    amputationRisk: true,
    signalPurityPct: 35.0
  }
};
writeSidecarAtomicSync(testSessionId, amputateSidecar);

const t4 = process.hrtime.bigint();
const res3 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: 'Add new payment gateway endpoint',
  effort: 'high'
});
const t5 = process.hrtime.bigint();
const duration3 = Number(t5 - t4) / 1_000_000;

console.log(`HALT_HYGIENE_OR_SAFETY duration: ${duration3.toFixed(3)}ms`);
assert.equal(res3.terminationBehavior, 'terminate', 'Must terminate execution');
assert.ok(res3.userMessage.includes('Flight Check'), 'Must output Scorecard');
assert.ok(res3.userMessage.includes('/clear') || res3.userMessage.includes('/compact'), 'Must advise /clear or /compact');
console.log('✓ Check 3: HALT_HYGIENE_OR_SAFETY terminated with Scorecard.');

// 4. HALT_REWRITE_SCORECARD test (explicit #check)
const normalSidecar = {
  ...baseSidecar,
  telemetry: {
    ...baseSidecar.telemetry,
    totalInputTokens: 20000,
    signalPurityPct: 80.0
  },
  fileState: {
    ...baseSidecar.fileState,
    activeSetPaths: ['src/core/router.mjs']
  }
};
writeSidecarAtomicSync(testSessionId, normalSidecar);

const t6 = process.hrtime.bigint();
const res4 = await handlePreInvocation({
  conversationId: testSessionId,
  prompt: '#check Refactor everything across database and auth modules'
});
const t7 = process.hrtime.bigint();
const duration4 = Number(t7 - t6) / 1_000_000;

console.log(`HALT_REWRITE_SCORECARD duration: ${duration4.toFixed(3)}ms`);
assert.equal(res4.terminationBehavior, 'terminate');
assert.ok(res4.userMessage.includes('Flight Check v3.1'));
assert.ok(res4.userMessage.includes('PROMPT :'));
assert.ok(res4.userMessage.includes('REWRITE:'));
console.log('✓ Check 4: #check triggered HALT_REWRITE_SCORECARD with 4-Line Scorecard.');

const maxDuration = Math.max(duration1, duration2, duration3, duration4);
console.log(`Max Hook Execution Latency: ${maxDuration.toFixed(3)}ms (Threshold: < 15.0ms)`);
assert.ok(maxDuration < 15.0, `Hook latency ${maxDuration}ms exceeded 15ms threshold`);

console.log('✓ Phase 5 verification PASSED with 0 errors.');
