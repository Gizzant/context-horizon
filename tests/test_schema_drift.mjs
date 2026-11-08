import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawJsonl } from '../src/core/parser.mjs';
import { handlePreInvocation } from '../src/hooks/pre_invocation.mjs';
import { writeSidecarAtomicSync, createDefaultSidecar } from '../src/core/sidecar_store.mjs';

describe('Schema Drift & Telemetry Confidence Tests', () => {
  test('golden transcript yields HIGH confidence', () => {
    const lines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Hello' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'World', usage: { input_tokens: 100 } }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: 'Done' })
    ].join('\n');

    const result = parseRawJsonl(lines, { withHealth: true });
    assert.equal(result.health.confidence, 'HIGH');
    assert.equal(result.health.parsedLines, 3);
    assert.equal(result.health.malformedLines, 0);
  });

  test('corrupt/malformed lines trigger LOW confidence', () => {
    const lines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Hi' }),
      'not valid json at all!',
      '{ unclosed json',
      'another garbage line'
    ].join('\n');

    const result = parseRawJsonl(lines, { withHealth: true });
    assert.equal(result.health.confidence, 'LOW');
    assert.equal(result.health.parsedLines, 1);
    assert.equal(result.health.malformedLines, 3);
  });

  test('unknown non-agent JSON objects trigger LOW/DEGRADED confidence', () => {
    const lines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Hi' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Working' }),
      JSON.stringify({ foo: 'bar', baz: 123 }), // unknown shape
      JSON.stringify({ unexpected: true })     // unknown shape
    ].join('\n');

    const result = parseRawJsonl(lines, { withHealth: true });
    assert.ok(result.health.unknownShapeLines >= 2);
    assert.ok(result.health.confidence === 'DEGRADED' || result.health.confidence === 'LOW');
  });

  test('router fails open (no terminate) when telemetry confidence is LOW', async () => {
    const conversationId = `drift_failopen_${Date.now()}`;
    const sidecar = createDefaultSidecar(conversationId);
    sidecar.sessionMeta.turnCount = 12;
    sidecar.telemetry.totalInputTokens = 195000;
    sidecar.telemetry.amputationRisk = true;
    sidecar.telemetry.signalPurityPct = 20; // Critical sludge
    sidecar.telemetry.confidence = 'LOW';   // Corrupt logs detected!

    writeSidecarAtomicSync(conversationId, sidecar);

    const res = await handlePreInvocation({
      conversationId,
      prompt: 'Fix the bug in src/index.js',
      effort: 'high'
    });

    // Should NOT terminate because confidence is LOW (fail open)
    assert.notEqual(res.terminationBehavior, 'terminate');
    assert.ok(res.systemMessage?.includes('telemetry') || Object.keys(res).length === 0 || res.systemMessage?.includes('degraded') || res.systemMessage?.includes('DEGRADED'));
  });
});
