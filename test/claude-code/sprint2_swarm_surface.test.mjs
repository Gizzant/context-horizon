import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  computeSwarmSummary,
  formatSwarmCompact,
  toCostRadarTopology,
  extractAgentLocation
} from '../../src/core-isomorphic/telemetry/swarmTopology.mjs';
import { createInitialPrefixRetention, applyPrefixRetentionRequest } from '../../src/core-isomorphic/telemetry/sprintMetrics.mjs';
import { createInitialTelemetryState, ingestModTurnEvent } from '../../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { renderSimpleViewPane, renderStatusLine } from '../../src/core-isomorphic/ui/modViews.mjs';
import { renderCostRadarHtml } from '../../src/core-isomorphic/ui/costRadarSvg.mjs';
import { generateCostRadar } from '../../bin/cli.mjs';

const T0 = 1_794_000_000_000;
const usage = (n) => ({ input_tokens: n, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

function swarmState() {
  let s = createInitialTelemetryState('s2', 'claude-sonnet-5-5');
  s = ingestModTurnEvent(s, { type: 'turn.step', agentId: 'worker-a', turnId: 'a1', messageId: 'ma1', model: 'claude-haiku-5-5', gitBranch: 'feature-a', worktree: '/repo-wt-a', result: { usage: usage(3000) } }, { nowMs: T0 });
  s = ingestModTurnEvent(s, { type: 'turn.step', agentId: 'worker-b', turnId: 'b1', messageId: 'mb1', result: { usage: usage(2000) } }, { nowMs: T0 + 1000 });
  s = ingestModTurnEvent(s, { type: 'turn.complete', agentId: 'worker-b', turnId: 'b1', messageId: 'mb1', result: { usage: usage(2000) } }, { nowMs: T0 + 2000 });
  s = ingestModTurnEvent(s, { type: 'turn.step', agentId: 'worker-c', turnId: 'c1', messageId: 'mc1', gitBranch: 'feature-c', result: { usage: usage(1000) } }, { nowMs: T0 + 3000 });
  s = ingestModTurnEvent(s, { type: 'turn.complete', agentId: 'worker-c', turnId: 'c1', messageId: 'mc1', result: { usage: usage(1000) } }, { nowMs: T0 + 3500 });
  s = ingestModTurnEvent(s, { type: 'turn.step', agentId: 'worker-c', turnId: 'c2', messageId: 'mc2', result: { usage: usage(1000) } }, { nowMs: T0 + 4000 });
  return s;
}

test('Sprint 2.1 (CC): per-agent lifecycle working / waiting / completed + worktree metadata', () => {
  const state = swarmState();
  // worker-c has an open turn (in-flight) => working; worker-b completed; worker-a idle 60s => waiting
  const summary = computeSwarmSummary(state, { nowMs: T0 + 60_000 });
  const byId = Object.fromEntries(summary.workers.map((w) => [w.agentId, w]));
  assert.equal(byId['worker-a'].state, 'working', 'worker-a still has an in-flight turn');
  assert.equal(byId['worker-b'].state, 'completed');
  assert.equal(byId['worker-c'].state, 'working');
  assert.equal(byId['worker-a'].branch, 'feature-a');
  assert.equal(byId['worker-a'].model, 'claude-haiku-5-5');
  assert.equal(summary.live, 2);
  assert.ok(summary.worktreeCount >= 2);

  const s2 = JSON.parse(JSON.stringify(state));
  delete s2.subagentInFlightTurns['worker-a'];
  const parked = computeSwarmSummary(s2, { nowMs: T0 + 60_000 });
  assert.equal(parked.workers.find((w) => w.agentId === 'worker-a').state, 'waiting');
  assert.equal(formatSwarmCompact(parked), 'Swarm 2W');
  assert.equal(formatSwarmCompact(computeSwarmSummary(createInitialTelemetryState('x'))), '');
  assert.deepEqual(extractAgentLocation({ cwd: '/w', branch: 'main' }), { model: null, worktree: '/w', branch: 'main' });
});

test('Sprint 2.1 (CC): Pane shows Swarm & Worktrees block only when subagents exist; wide statusLine shows Swarm NW', () => {
  const solo = renderSimpleViewPane(createInitialTelemetryState('solo'), { maxCols: 100 });
  assert.ok(!solo.text.includes('Swarm & Worktrees'));
  const state = swarmState();
  const pane = renderSimpleViewPane(state, { maxCols: 110, nowMs: T0 + 5000 });
  assert.match(pane.text, /Swarm & Worktrees: 2 live \(2 working · 0 parked\) · 1 done/);
  assert.match(pane.text, /worker-a working/);
  const wide = renderStatusLine(state, { columns: 200, ansi: false, nowMs: T0 + 5000 });
  assert.match(wide.plainLine, /Swarm 2W/);
  const narrow = renderStatusLine(state, { columns: 80, ansi: false, nowMs: T0 + 5000 });
  assert.ok(!narrow.plainLine.includes('Swarm'), 'compact tier keeps the 80-col budget');
  assert.ok(narrow.visibleLength <= 80);
});

test('Sprint 2 honesty gate (CC): zero cache telemetry => unmeasured; series recorded when measured', () => {
  let r = createInitialPrefixRetention();
  for (let i = 0; i < 3; i++) {
    r = applyPrefixRetentionRequest(r, { streamKey: 'main', uncachedInputTokens: 700, nowMs: T0 + i * 1000 });
  }
  assert.equal(r.measured, false);
  assert.equal(r.unmeasuredReason, 'no_cache_telemetry');
  assert.equal(r.retentionIndexPct, null);

  let m = createInitialPrefixRetention();
  m = applyPrefixRetentionRequest(m, { streamKey: 'main', cacheWriteTokens: 40000, nowMs: T0, inputPer1M: 3, readPer1M: 0.3 });
  m = applyPrefixRetentionRequest(m, { streamKey: 'main', cacheReadTokens: 40000, uncachedInputTokens: 500, nowMs: T0 + 5000, inputPer1M: 3, readPer1M: 0.3 });
  assert.equal(m.measured, true);
  assert.equal(m.series.length, 1);
  assert.equal(m.series[0].pct, 100);
});

test('Sprint 2.2 (CC): cost-radar export (shared GA renderer port) is self-contained and script-free', () => {
  const ccSrc = readFileSync(fileURLToPath(new URL('../../src/core-isomorphic/ui/costRadarSvg.mjs', import.meta.url)), 'utf8');
  assert.ok(!/from 'node:/.test(ccSrc), 'renderer stays node-free');
  const state = swarmState();
  const { html, summary } = generateCostRadar({ state, nowMs: T0 + 5000, generatedAt: 'fixed' });
  assert.match(html, /Claude Code|Cross-Platform/);
  assert.match(html, /worker-a/);
  assert.ok(!/<script/i.test(html));
  assert.equal(summary.swarm, 'Swarm 2W');
  assert.equal(toCostRadarTopology(computeSwarmSummary(createInitialTelemetryState('x'))), null);
  assert.match(renderCostRadarHtml({}), /solo agent/);
});

test('Sprint 2 (CC): no eager .mcpServers registration anywhere in plugin manifests', () => {
  for (const rel of ['../../.claude-plugin/plugin.json', '../../package.json']) {
    const txt = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.ok(!/"mcpServers"/.test(txt), `${rel} must not register MCP servers`);
  }
});
