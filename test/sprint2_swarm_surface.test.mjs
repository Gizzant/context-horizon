import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSwarmRoster,
  parseWorktreePorcelain,
  inspectGitWorktrees,
  computeLeaseOverlaps,
  computeSwarmTopology,
  formatSwarmLabel
} from '../src/core/swarm_topology.mjs';
import {
  renderCostRadarHtml,
  renderRetentionStepChart,
  renderDriftSparkline,
  renderTopologyGraph,
  escapeXml
} from '../src/core/timeline_svg.mjs';
import { computePrefixRetentionIndex } from '../src/core/sprint_metrics.mjs';
import { buildCostRadarFromState, parseCostRadarArgs } from '../src/cli/cost_radar.mjs';
import { buildHooksConfig } from '../src/cli/init.mjs';
import { handlePreInvocation, handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { buildFullLifecycleHooksBlock } from '../scripts/sync_mirrors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1_794_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

function swarmSteps() {
  return [
    { type: 'PLANNER_RESPONSE', createdAt: iso(T0), toolCalls: [
      { name: 'swarm', args: { action: 'add', name: 'author', n: 2, model: 'gemini-4-carbon', workspace: 'share', brief: 'x' } },
      { name: 'swarm', args: { action: 'add', name: 'verifier', brief: 'check' } }
    ] },
    { type: 'PLANNER_RESPONSE', createdAt: iso(T0 + 60_000), toolCalls: [
      { name: 'swarm', args: { action: 'kill', name: 'author-2' } }
    ] },
    { type: 'PLANNER_RESPONSE', createdAt: iso(T0 + 400_000), toolCalls: [
      { name: 'invoke_subagent', args: { Role: 'Researcher', TypeName: 'research' }, result: { conversationId: 'c320b441-3a60-440e-b034-4fc625e2de62' } }
    ] }
  ];
}

test('Sprint 2.1: swarm roster expands n/tasks, tracks kill + parked state honestly', () => {
  const { workers } = parseSwarmRoster(swarmSteps(), { nowMs: T0 + 420_000 });
  const byName = Object.fromEntries(workers.map((w) => [w.name, w]));
  assert.deepEqual(Object.keys(byName).sort(), ['Researcher#c320b441', 'author-1', 'author-2', 'verifier']);
  assert.equal(byName['author-2'].state, 'killed');
  assert.equal(byName['author-2'].ttlRemainingSec, 0);
  assert.equal(byName['author-1'].state, 'waiting', 'idle > 2 min without status evidence => parked');
  assert.equal(byName['author-1'].parked, true);
  assert.equal(byName['author-1'].model, 'gemini-4-carbon');
  assert.equal(byName['author-1'].workspace, 'share');
  assert.equal(byName['author-1'].cacheWarm, false, '7 min idle => 5 min prefix TTL expired');
  assert.equal(byName['Researcher#c320b441'].state, 'working');
  assert.equal(byName['Researcher#c320b441'].warmKnown, false, 'warm prefix never fabricated');
});

test('Sprint 2.1: explicit `swarm status` output overrides inferred state', () => {
  const steps = [
    ...swarmSteps(),
    { type: 'PLANNER_RESPONSE', createdAt: iso(T0 + 410_000), toolCalls: [{ name: 'swarm', args: { action: 'status' } }] },
    { type: 'TOOL_RESULT', createdAt: iso(T0 + 410_500), content: 'author-1 (gemini-4-carbon) stopped\nverifier (inherit) working' }
  ];
  const { workers } = parseSwarmRoster(steps, { nowMs: T0 + 420_000 });
  const byName = Object.fromEntries(workers.map((w) => [w.name, w]));
  assert.equal(byName['author-1'].state, 'stopped');
  assert.equal(byName.verifier.state, 'working');
});

test('Sprint 2.1: git worktree porcelain parser + fail-soft probe', () => {
  const text = [
    'worktree /work/repo', 'HEAD 085b89a1234567890', 'branch refs/heads/main', '',
    'worktree /work/repo-wt-auth', 'HEAD abcdef0123456789', 'branch refs/heads/feature-auth', 'locked', '',
    'worktree /work/detached', 'HEAD 1111111111111111', 'detached', 'prunable gitdir file points to non-existent location', ''
  ].join('\n');
  const wts = parseWorktreePorcelain(text);
  assert.equal(wts.length, 3);
  assert.equal(wts[0].isMain, true);
  assert.equal(wts[0].branch, 'main');
  assert.equal(wts[1].locked, true);
  assert.equal(wts[2].detached, true);
  assert.equal(wts[2].prunable, true);

  const failed = inspectGitWorktrees('/work/not-a-repo', {
    useCache: false,
    runner: () => { const e = new Error('not a git repository'); e.code = 128; throw e; }
  });
  assert.equal(failed.available, false);
  assert.deepEqual(failed.worktrees, []);
});

test('Sprint 2.1: scope-lease overlaps surface as DET-20 and drive auto-expand', () => {
  const leases = [
    { trajectoryId: 'agy-a', tool: 'antigravity', claimedPaths: ['src/core/'] },
    { trajectoryId: 'cc-b', tool: 'claude-code', claimedPaths: ['src/core/quota.mjs'] },
    { trajectoryId: 'agy-c', claimedPaths: ['docs/readme.md'] }
  ];
  const collisions = computeLeaseOverlaps(leases);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].trajectories, ['agy-a', 'cc-b']);
  assert.equal(collisions[0].detectorId, 'DET-20');

  const solo = computeSwarmTopology([], { worktrees: [{ path: '/r', isMain: true, name: 'r' }], probeGit: false });
  assert.equal(solo.mode, 'solo');
  assert.equal(solo.autoExpand, false);
  assert.equal(formatSwarmLabel(solo), '');

  const busy = computeSwarmTopology(swarmSteps(), {
    nowMs: T0 + 420_000,
    worktrees: parseWorktreePorcelain('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\nbranch refs/heads/x\n'),
    leases
  });
  assert.equal(busy.mode, 'swarm');
  assert.equal(busy.autoExpand, true);
  assert.equal(busy.counts.live, 3);
  assert.equal(busy.counts.killed, 1);
  assert.equal(busy.worktreeCount, 2);
  assert.equal(formatSwarmLabel(busy), 'Swarm 3W WT 2 !DET-20');
});

test('Sprint 2.2: retention series feeds the step chart with bust markers', () => {
  const rates = { input: 2.0, cachedRead: 0.1 };
  const r = computePrefixRetentionIndex([
    { inputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0, timestampMs: T0, rates },
    { inputTokens: 100, cacheReadTokens: 1000, cacheCreationTokens: 0, timestampMs: T0 + 10_000, rates },
    { inputTokens: 1100, cacheReadTokens: 0, cacheCreationTokens: 0, timestampMs: T0 + 20_000, rates }
  ]);
  assert.equal(r.series.length, 2);
  assert.equal(r.series[0].pct, 100);
  assert.equal(r.series[1].bust, true);
  const svg = renderRetentionStepChart(r);
  assert.match(svg, /<svg/);
  assert.match(svg, /prefix bust/);
  assert.match(renderRetentionStepChart(null), /no multi-turn cache usage/);
});

test('Sprint 2 honesty gate: no cache telemetry anywhere => unmeasured, never "0% / N busts"', () => {
  const r = computePrefixRetentionIndex([
    { inputTokens: 700, cacheReadTokens: 0, cacheCreationTokens: 0, timestampMs: T0 },
    { inputTokens: 680, cacheReadTokens: 0, cacheCreationTokens: 0, timestampMs: T0 + 5_000 },
    { inputTokens: 720, cacheReadTokens: 0, cacheCreationTokens: 0, timestampMs: T0 + 9_000 }
  ]);
  assert.equal(r.measured, false);
  assert.equal(r.retentionIndexPct, null);
  assert.equal(r.bustCount, 0);
  assert.equal(r.unmeasuredReason, 'no_cache_telemetry');
  assert.match(r.label, /no cache telemetry/);
});

test('Sprint 2.2: drift sparkline highlights DET-30 loop turns; topology graph renders workers + worktrees', () => {
  const drift = {
    measured: true,
    turns: [
      { thinkingTokens: 500, visibleOutputTokens: 400, driftRatio: 1.25, driftState: 'nominal', ttftMs: 1200, mutatingCalls: 2 },
      { thinkingTokens: 9000, visibleOutputTokens: 300, driftRatio: 30, driftState: 'loop_suspect', ttftMs: 22000, mutatingCalls: 0 }
    ],
    lastDriftRatio: 30, rollingDriftRatio: 13.5, avgTtftMs: 11600,
    loop: { triggered: true, severity: 'warn', consecutiveLoopTurns: 1 }
  };
  const svg = renderDriftSparkline(drift);
  assert.match(svg, /DET-30 WARN/);
  assert.match(svg, /loop suspect/);
  const topo = computeSwarmTopology(swarmSteps(), { nowMs: T0 + 420_000, worktrees: [], probeGit: false });
  const g = renderTopologyGraph(topo);
  assert.match(g, /author-1/);
  assert.match(renderTopologyGraph(null), /solo agent/);
});

test('Sprint 2.2: cost-radar HTML is self-contained, escaped, and network-free', () => {
  const html = renderCostRadarHtml({ meta: { sessionTitle: '<script>alert(1)</script>', model: 'carbon' } });
  assert.ok(!html.includes('<script>alert'), 'session title must be escaped');
  assert.ok(html.includes(escapeXml('<script>alert(1)</script>')));
  assert.ok(!/https?:\/\//.test(html.replace('http://www.w3.org', '')), 'no external URLs');
  assert.ok(!/<script/i.test(html), 'artifact ships no scripts');

  const { html: h2, summary } = buildCostRadarFromState({ sessionTitle: 'demo', quota: {}, swarmTopology: null });
  assert.match(h2, /Cost Radar — demo/);
  assert.equal(summary.swarm, 'Solo');
  assert.equal(summary.loopTriggered, false);
  assert.deepEqual(parseCostRadarArgs(['cost-radar', '--out', 'x.html', '--json']), { out: 'x.html', conversationId: null, json: true, demo: false });
});

test('Sprint 2 wiring: skill registered, CLI subcommand, loopback API route, panel drawer', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  assert.ok(plugin.skills.includes('./skills/cost-radar'));
  assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'cost-radar', 'SKILL.md')));
  const init = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'init.mjs'), 'utf8');
  assert.match(init, /cmd === 'cost-radar'/);
  const server = fs.readFileSync(path.join(ROOT, 'sidecars', 'horizon-daemon', 'server.mjs'), 'utf8');
  assert.match(server, /url\.pathname === '\/api\/cost-radar'/);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
  assert.match(html, /id="swarmTopologyDrawer"/);
  assert.match(html, /function renderSwarmTopology\(/);
  assert.ok(!/btnCompactPrimary/.test(html), 'no copy-/compact button invariant');
});

test('Windows PreToolUse hook safety: unquoted space-free hook paths + explicit decision="allow"', async () => {
  const block = buildFullLifecycleHooksBlock('/opt/plugins/agy-horizon-flightcheck', true);
  assert.ok(!block.PreInvocation[0].command.includes('"'), 'space-free PreInvocation command must not wrap path in quotes');
  assert.match(block.PreToolUse[0].hooks[0].command, /--event=PreToolUse$/);

  const cfg = buildHooksConfig('/opt/plugins/agy-horizon-flightcheck');
  assert.ok(!cfg.hooks.PreInvocation[0].command.includes('"'));
  assert.match(cfg.hooks.PreToolUse[0].hooks[0].command, /--event=PreToolUse$/);

  const allowRes = await handlePreToolUse({ tool_name: 'read_file', tool_input: { Path: 'README.md' } });
  assert.equal(allowRes.decision, 'allow', 'handlePreToolUse must return decision="allow" so Go PreToolUse runner permits call');

  const routedRes = await handlePreInvocation({ toolName: 'swarm', args: { action: 'status' } });
  assert.equal(routedRes.decision, 'allow', 'handlePreInvocation must route toolName/args payloads to handlePreToolUse');
});
