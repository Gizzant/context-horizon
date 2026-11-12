/**
 * @file test/ustf_v1.test.mjs
 * Verification Suite for Universal Session Trajectory Format (USTF v1).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  USTF_SCHEMA_VERSION,
  USTF_SCHEMA_URI,
  USTF_EVENT_TYPES,
  USTF_SPAN_KINDS,
  validateUstfTrajectory,
  validateUstfEvent,
  validateUstfSpan,
  validateUstfUsage,
  createEmptyUstfSession,
  normalizeUsage,
  normalizeAntigravitySession,
  normalizeClaudeCodeSession,
  normalizeSessionTrajectory
} from '../src/core-isomorphic/ustf/index.mjs';

test('USTF v1 Schema: Defines canonical constants and 9 event types', () => {
  assert.equal(USTF_SCHEMA_VERSION, '1.0.0');
  assert.equal(USTF_SCHEMA_URI, 'https://ctxtop.dev/schemas/ustf-v1.json');
  assert.equal(USTF_EVENT_TYPES.length, 9);
  assert.ok(USTF_EVENT_TYPES.includes('turn.start'));
  assert.ok(USTF_EVENT_TYPES.includes('turn.step'));
  assert.ok(USTF_EVENT_TYPES.includes('turn.complete'));
  assert.ok(USTF_EVENT_TYPES.includes('tool.call'));
  assert.ok(USTF_EVENT_TYPES.includes('tool.result'));
  assert.ok(USTF_EVENT_TYPES.includes('model.switch'));
  assert.ok(USTF_EVENT_TYPES.includes('compact.lifecycle'));
  assert.ok(USTF_EVENT_TYPES.includes('subagent.lifecycle'));
  assert.ok(USTF_EVENT_TYPES.includes('control.action'));
  assert.deepEqual(USTF_SPAN_KINDS, ['turn', 'agent', 'tool', 'hook', 'llm']);
});

test('USTF v1 Schema: Factory createEmptyUstfSession produces valid schema object', () => {
  const session = createEmptyUstfSession('sess-123', 'claude-code', { modelId: 'claude-sonnet-5-5' });
  assert.equal(session.$schema, USTF_SCHEMA_URI);
  assert.equal(session.version, USTF_SCHEMA_VERSION);
  assert.equal(session.sessionId, 'sess-123');
  assert.equal(session.harness, 'claude-code');
  assert.equal(session.modelId, 'claude-sonnet-5-5');
  assert.deepEqual(session.events, []);
  assert.deepEqual(session.spans, []);
  assert.equal(session.usage.uncached, 0);
  assert.equal(session.usage.costUSD, 0);

  const check = validateUstfTrajectory(session);
  assert.equal(check.valid, true);
  assert.deepEqual(check.errors, []);
});

test('USTF v1 Schema: Validator catches malformed trajectories and events', () => {
  assert.equal(validateUstfTrajectory(null).valid, false);
  assert.equal(validateUstfTrajectory({}).valid, false);

  const badSchema = createEmptyUstfSession('s1', 'antigravity');
  badSchema.$schema = 'https://invalid.example/schema.json';
  assert.equal(validateUstfTrajectory(badSchema).valid, false);

  const badEvent = { eventId: 'e1', type: 'unknown.type', timestampMs: 100 };
  const evCheck = validateUstfEvent(badEvent);
  assert.equal(evCheck.valid, false);

  const badSpan = { spanId: 'sp1', kind: 'invalid-kind', name: 'span', startTimeMs: -5 };
  const spanCheck = validateUstfSpan(badSpan);
  assert.equal(spanCheck.valid, false);

  const badUsage = { uncached: -10, costUSD: 'free' };
  const usageCheck = validateUstfUsage(badUsage);
  assert.equal(usageCheck.valid, false);
});

test('USTF v1 Usage Normalizer: Normalizes various Anthropic and Antigravity token shapes', () => {
  const anthropicRaw = {
    input_tokens: 1500,
    cache_creation: {
      ephemeral_5m_input_tokens: 2000,
      ephemeral_1h_input_tokens: 500
    },
    cache_read_input_tokens: 12000,
    output_tokens: 800,
    thinking_tokens: 350
  };
  const u1 = normalizeUsage(anthropicRaw);
  assert.equal(u1.uncached, 1500);
  assert.equal(u1.cacheWrite5m, 2000);
  assert.equal(u1.cacheWrite1h, 500);
  assert.equal(u1.cacheRead, 12000);
  assert.equal(u1.output, 800);
  assert.equal(u1.thinking, 350);
  assert.ok(u1.costUSD > 0);

  const antigravityRaw = {
    prompt_tokens: 3000,
    cached_tokens: 45000,
    output_tokens: 1200,
    costUSD: 0.045
  };
  const u2 = normalizeUsage(antigravityRaw);
  assert.equal(u2.uncached, 3000);
  assert.equal(u2.cacheRead, 45000);
  assert.equal(u2.output, 1200);
  assert.equal(u2.costUSD, 0.045);
});

test('USTF v1 Normalizer: Normalizes Google Antigravity steps and tools', () => {
  const rawAntigravity = {
    sessionId: 'agy-session-test',
    modelId: 'gemini-2-5-pro',
    steps: [
      {
        stepIndex: 0,
        type: 'USER_INPUT',
        content: 'Refactor database schema',
        createdAt: 1700000000000
      },
      {
        stepIndex: 1,
        type: 'TOOL_CALL',
        toolName: 'Read',
        toolInput: { file_path: 'src/db.js' },
        createdAt: 1700000001000,
        durationMs: 42
      },
      {
        stepIndex: 2,
        type: 'TOOL_RESULT',
        toolName: 'Read',
        content: '// existing code',
        createdAt: 1700000002000
      },
      {
        stepIndex: 3,
        type: 'PLANNER_RESPONSE',
        content: 'I have analyzed the database schema.',
        createdAt: 1700000003000,
        usage: {
          prompt_tokens: 1200,
          cached_tokens: 8000,
          output_tokens: 400
        }
      }
    ]
  };

  const traj = normalizeAntigravitySession(rawAntigravity);
  assert.equal(traj.harness, 'antigravity');
  assert.equal(traj.sessionId, 'agy-session-test');
  assert.equal(traj.modelId, 'gemini-2-5-pro');
  assert.ok(traj.events.length >= 4);

  // Check event types
  assert.ok(traj.events.some((e) => e.type === 'turn.start'));
  assert.ok(traj.events.some((e) => e.type === 'tool.call'));
  assert.ok(traj.events.some((e) => e.type === 'tool.result'));
  assert.ok(traj.events.some((e) => e.type === 'turn.complete'));

  // Check hierarchical spans
  assert.ok(traj.spans.some((s) => s.kind === 'turn'));
  const toolSpan = traj.spans.find((s) => s.kind === 'tool');
  assert.ok(toolSpan);
  assert.equal(toolSpan.name, 'Read');
  assert.equal(toolSpan.durationMs, 42);

  // Check usage accounting
  assert.equal(traj.usage.uncached, 1200);
  assert.equal(traj.usage.cacheRead, 8000);
  assert.equal(traj.usage.output, 400);

  // Schema validation
  const validation = validateUstfTrajectory(traj);
  assert.equal(validation.valid, true);
});

test('USTF v1 Normalizer: Normalizes Claude Code JSONL DAG with rewind branches', () => {
  const jsonlLines = [
    JSON.stringify({
      uuid: 'turn-1-user',
      parentUuid: null,
      role: 'user',
      content: 'Run tests and fix failures',
      timestamp: 1700000010000
    }),
    JSON.stringify({
      uuid: 'turn-1-asst',
      parentUuid: 'turn-1-user',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'npm test' } }
      ],
      usage: {
        input_tokens: 2500,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 30000,
        output_tokens: 200
      },
      timestamp: 1700000011000
    }),
    JSON.stringify({
      uuid: 'turn-1-toolres',
      parentUuid: 'turn-1-asst',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'FAIL: test 1' }
      ],
      timestamp: 1700000012000
    }),
    // Rewind fork: abandoned child of turn-1-asst
    JSON.stringify({
      uuid: 'abandoned-step',
      parentUuid: 'turn-1-asst',
      role: 'assistant',
      content: 'I will delete the tests',
      timestamp: 1700000013000
    }),
    // Active leaf branch continuing from turn-1-toolres
    JSON.stringify({
      uuid: 'active-leaf',
      parentUuid: 'turn-1-toolres',
      role: 'assistant',
      content: 'I will fix the bug in math.js',
      leafUuid: 'active-leaf',
      timestamp: 1700000014000
    })
  ].join('\n');

  const traj = normalizeClaudeCodeSession(jsonlLines, { sessionId: 'claude-sess-test' });
  assert.equal(traj.harness, 'claude-code');
  assert.equal(traj.sessionId, 'claude-sess-test');
  assert.ok(traj.events.length >= 4);

  // Verify rewind branch detection
  assert.equal(traj.rewindBranches.length, 1);
  assert.equal(traj.rewindBranches[0].forkParentUuid, 'turn-1-asst');
  assert.equal(traj.rewindBranches[0].abandonedTipUuid, 'abandoned-step');

  // Verify tool call span
  const toolSpan = traj.spans.find((s) => s.kind === 'tool');
  assert.ok(toolSpan);
  assert.equal(toolSpan.name, 'Bash');

  // Verify usage aggregation
  assert.equal(traj.usage.uncached, 2500);
  assert.equal(traj.usage.cacheWrite5m, 1000);
  assert.equal(traj.usage.cacheRead, 30000);
  assert.equal(traj.usage.output, 200);

  // Schema validation
  const validation = validateUstfTrajectory(traj);
  assert.equal(validation.valid, true);
});

test('USTF v1 Normalizer: Auto-detects session format', () => {
  const agy = normalizeSessionTrajectory({ steps: [{ type: 'USER_INPUT', content: 'hello' }] });
  assert.equal(agy.harness, 'antigravity');

  const cc = normalizeSessionTrajectory([
    { uuid: '1', role: 'user', content: 'hi' }
  ]);
  assert.equal(cc.harness, 'claude-code');

  const empty = normalizeSessionTrajectory(null);
  assert.equal(empty.sessionId, 'empty-session');
});
