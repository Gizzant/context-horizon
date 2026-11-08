import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  try {
    ({ JSDOM } = require('C:/Users/frank/AppData/Local/Temp/node_modules/jsdom'));
  } catch {
    JSDOM = null;
  }
}

import {
  computeDualTtlState,
  computePrefixMutationDiff,
  evaluateColdSessionCostGate,
  computeQuotaAndCacheTelemetry
} from '../src/core/quota.mjs';
import {
  decodeProtobufWire,
  parsePbtxtAnnotations,
  stitchAntigravityCliTrajectory,
  stitchCursorTrajectory,
  stitchClaudeCodeDag
} from '../src/core/trajectory_stitcher.mjs';
import {
  classifyWorkloadMode,
  rankRiskiestCells,
  classifyHorizon
} from '../src/core/classifier.mjs';
import {
  recordSession,
  aggregate,
  formatCrossSessionBanner
} from '../src/core/offenders.mjs';
import { formatDemoScenarioAnsi } from '../src/cli/horizon_hud.mjs';

describe('Wave 1 — Locked v2.0 UI Laws (1–5) & HUD / JSDOM Verification', () => {
  test('Law 1 & Law 3 (CLI): formatDemoScenarioAnsi renders raw physical metrics & passive workload mode without 0-100 efficiency score pill', () => {
    const { text } = formatDemoScenarioAnsi(5);
    assert.ok(!/\[Score \d+\/100\]/.test(text), 'Must NEVER render arbitrary [Score X/100] efficiency pill');
    assert.ok(text.includes('Cache Hit:'), 'Must include raw Cache Hit % metric');
    assert.ok(text.includes('Waste:'), 'Must include raw Waste tokens metric');
    assert.ok(text.includes('TTL:'), 'Must include raw TTL countdown metric');
    assert.ok(text.includes('[Mode:'), 'Must include passive workload mode tag');
  });

  test('Law 3 (Core): classifyWorkloadMode passively classifies Read-Heavy Audit, Multi-File Refactor, and Subagent Swarm', () => {
    const readSteps = Array.from({ length: 8 }, (_, i) => ({
      stepIndex: i,
      toolCalls: [{ name: 'read_file', args: { Path: `src/file_${i}.mjs` } }]
    }));
    const readMode = classifyWorkloadMode(readSteps);
    assert.equal(readMode.modeId, 'READ_HEAVY_AUDIT');
    assert.equal(readMode.tag, '[Mode: Read-Heavy Audit]');

    const refactorSteps = Array.from({ length: 6 }, (_, i) => ({
      stepIndex: i,
      toolCalls: [{ name: 'edit_file', args: { Path: `src/mod_${i}.mjs` } }]
    }));
    const refactorMode = classifyWorkloadMode(refactorSteps);
    assert.equal(refactorMode.modeId, 'MULTI_FILE_REFACTOR');
    assert.equal(refactorMode.tag, '[Mode: Multi-File Refactor]');

    const swarmSteps = [
      { stepIndex: 0, toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Worker 1' } }] },
      { stepIndex: 1, toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Worker 2' } }] }
    ];
    const swarmMode = classifyWorkloadMode(swarmSteps);
    assert.equal(swarmMode.modeId, 'SUBAGENT_SWARM');
    assert.equal(swarmMode.tag, '[Mode: Subagent Swarm]');
  });

  test('Law 2 (Core): rankRiskiestCells ranks top 3–5 riskiest cells and prioritizes task.md in low-attention trough', () => {
    const cells = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      totalTokens: i < 20 ? 6400 : 0,
      dominantCategory: i === 10 ? 'ANCHOR' : (i === 12 ? 'STALE_DUPLICATE' : (i < 20 ? 'ACTIVE_WORKING_SET' : 'FREE_HEADROOM')),
      topTarget: i === 10 ? 'C:/Projects/app/task.md' : (i === 12 ? 'src/core/parser.mjs' : `src/mod_${i}.mjs`),
      inAttentionTrough: i >= 6 && i <= 14,
      parabolicAttention: { uShapedWeight: i >= 6 && i <= 14 ? 0.42 : 0.92 }
    }));

    const ranked = rankRiskiestCells(cells, { totalActiveTokens: 128000, safeLimit: 147000, cellSizeTokens: 6400 });
    assert.ok(ranked.length >= 3 && ranked.length <= 5, `Expected 3-5 risky cells, got ${ranked.length}`);
    assert.equal(ranked[0].cellIndex, 10, 'task.md stranded in trough must rank #1');
    assert.equal(ranked[0].actionType, 'REANCHOR');
    assert.equal(ranked[0].actionLabel, '[Re-Anchor / Prune]');
  });

  test('Law 5 (Core): offenders.mjs tracks wastedTokens and formats factual cross-session banner', () => {
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-off-w1-'));
    let entries = [];
    for (let s = 1; s <= 3; s++) {
      entries = recordSession(tmpCache, `sess-${s}`, [
        { path: 'src/core/classifier.mjs', occurrences: 4, wastedTokens: 6000 }
      ]);
    }
    const agg = aggregate(entries);
    assert.equal(agg.length, 1);
    assert.equal(agg[0].totalWastedTokens, 18000);
    assert.ok(agg[0].bannerText.includes('Across last 3 sessions'));
    assert.ok(agg[0].bannerText.includes('caused 18k repeated re-reads'));
    assert.equal(formatCrossSessionBanner(agg), agg[0].bannerText);
  });

  test('Laws 1–5 (WebView JSDOM): renders physicalMetricsBar, workloadModeBadge, topRiskyCellsList, silent-when-nominal watchdog, and cross-session banner', async () => {
    const htmlPath = path.resolve('src/webview/horizon_panel.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });
    const w = dom.window;
    const d = w.document;

    // 1. Nominal Host Watchdog -> must stay hidden (Law 4)
    const stateNominal = {
      schemaVersion: '1.1.0',
      sessionId: 'wave1-jsdom-test',
      window: { maxTokens: 256000, cellSizeTokens: 6400, totalCells: 40, totalActiveTokens: 67800, usedPercentage: 26, turnCount: 14, safeLimit: 147000 },
      breakdown: { ANCHOR: 12000, ACTIVE_WORKING_SET: 45800, STALE_DUPLICATE: 10000, DEAD_ERROR: 0, FREE_HEADROOM: 188200 },
      metrics: { signalPurityPct: 85, sludgeTokens: 10000 },
      workloadMode: { modeId: 'MULTI_FILE_REFACTOR', tag: '[Mode: Multi-File Refactor]' },
      topRiskyCells: [
        { cellIndex: 8, cellNumber: 9, filePath: 'task.md', tokenWeight: 6400, attentionRecallPct: 42, actionType: 'RE_ANCHOR', actionLabel: '[Re-Anchor / Prune]' },
        { cellIndex: 9, cellNumber: 10, filePath: 'src/core/quota.mjs', tokenWeight: 6400, attentionRecallPct: 40, actionType: 'PRUNE', actionLabel: '[Re-Anchor / Prune]' },
        { cellIndex: 10, cellNumber: 11, filePath: 'src/core/classifier.mjs', tokenWeight: 6400, attentionRecallPct: 41, actionType: 'PRUNE', actionLabel: '[Re-Anchor / Prune]' }
      ],
      chronicReads: [
        { path: 'src/core/classifier.mjs', sessions: 4, windowSessions: 5, wastedTokens: 24000, bannerText: 'Across last 5 sessions, src/core/classifier.mjs caused 24k repeated re-reads' }
      ],
      quota: {
        sprint5h: { usedPct: 18, remainingPct: 82 },
        weekly7d: { usedPct: 40, remainingPct: 60 },
        cache: {
          hitRatePct: 91,
          ttlRemainingSec: 240,
          isCacheCold: false,
          dualTtl: {
            mainRemainingSec: 240,
            mainWindowLabel: '5m',
            subagentRemainingSec: 180,
            subagentWindowLabel: '5m',
            overageTtlCliffDetected: true,
            cliffWarning: '1h -> 5m TTL Cliff Detected: Overage/fallback tier active; cache now expires 12x faster (300s).'
          },
          costGate: {
            state: 'COLD_COST_GATE',
            bannerMessage: 'Cold Session Cost Gate: Compacting cold costs ~10.0x more ($0.340 vs $0.034 warm, +340 quota units). Prefer /clear + .handoff.md.'
          },
          prefixDiff: {
            mutated: true,
            summary: 'Prefix mutated at Turn #6 in mcp_instructions_delta (block #2, +1024 bytes / ~256 tok)'
          }
        }
      },
      hostHealth: { rssGb: 0.45, orphanCount: 0, orphans: [], status: 'HEALTHY' },
      brainSignals: {
        activeSignal: { liveSessionTokens: 45800, taskMdSaved: true, taskMdTurnsBehind: 0 },
        duplicateReads: { fileCount: 1, reclaimableTokens: 10000, topFiles: [{ path: 'src/core/classifier.mjs', occurrences: 2, wastedTokens: 10000 }] },
        oldHistory: { turnCount: 0, reclaimableTokens: 0 },
        deadErrors: { errorCount: 0, reclaimableTokens: 0 }
      },
      cells: Array.from({ length: 40 }, (_, i) => ({
        index: i,
        dominantCategory: i < 11 ? 'ACTIVE_WORKING_SET' : 'FREE_HEADROOM',
        totalTokens: i < 11 ? 6400 : 0
      }))
    };

    w.renderState(stateNominal);

    // Law 1: Physical metrics bar
    const physText = d.getElementById('physicalMetricsBar').textContent;
    assert.ok(physText.includes('67.8k / 256k · 26%'), `Expected physicalMetricsBar to show 67.8k / 256k · 26%, got: ${physText}`);
    assert.ok(physText.includes('Cache Hit: 91%'), 'Must show Cache Hit %');
    assert.ok(physText.includes('Waste: 10k'), 'Must show Waste tokens');
    assert.ok(physText.includes('TTL: 240s (5m)'), 'Must show Dual-TTL countdown');

    // Law 2: Repetitive axis legend removed from DOM + Top 3-5 riskiest cells rendered with [Re-Anchor / Prune]
    assert.equal(d.getElementById('timelineLegend'), null, 'Repetitive timelineLegend element must be removed from DOM');
    assert.equal(d.getElementById('topRiskyCellsList').hidden, false, 'topRiskyCellsList must be visible');
    assert.equal(d.querySelectorAll('.top-risky-cell-row').length, 3, 'Must render 3 risky cell rows');
    assert.ok(d.getElementById('topRiskyCellsList').textContent.includes('[Re-Anchor / Prune]'));

    // Law 3: Passive workload tag
    assert.equal(d.getElementById('workloadModeBadge').textContent, '[Mode: Multi-File Refactor]');

    // Law 4: Silent-when-nominal host watchdog
    assert.equal(d.getElementById('hostWatchdogBar').hidden, true, 'Host watchdog bar must be hidden when orphans === 0 and status is HEALTHY');

    // Law 5: Factual cross-session banner & [Export Sanitized Snapshot]
    assert.equal(d.getElementById('crossSessionOffenderBanner').hidden, false);
    assert.ok(d.getElementById('crossSessionOffenderText').textContent.includes('Across last 5 sessions, src/core/classifier.mjs caused 24k repeated re-reads'));
    assert.equal(d.getElementById('btnExportSanitized').textContent.trim(), '[Export Sanitized Snapshot]');

    // F1 & F9 Banners
    assert.equal(d.getElementById('overageTtlCliffBanner').hidden, false);
    assert.equal(d.getElementById('coldSessionCostGateBanner').hidden, false);
    assert.equal(d.getElementById('prefixMutationDiffBanner').hidden, false);

    // Law 4 breach check: when orphanCount > 0, watchdog un-hides
    w.renderState({
      ...stateNominal,
      hostHealth: { rssGb: 2.1, orphanCount: 2, orphans: [{ pid: 101, name: 'mcp' }, { pid: 102, name: 'lsp' }], status: 'ZOMBIE_LEAK' }
    });
    assert.equal(d.getElementById('hostWatchdogBar').hidden, false, 'Host watchdog bar must un-hide when orphans > 0');

    dom.window.close();
  });
});

describe('Wave 1 — Wedge F1 (Dual-TTL & Prefix Mutation Diff) & F9 (Cold-Session Cost Gate)', () => {
  test('F1: computeDualTtlState tracks 1h vs 5m main TTL, 5m subagent TTL, and detects 1h -> 5m Overage TTL Cliff', () => {
    const nowMs = Date.parse('2026-11-08T16:00:00Z');
    const steps = [
      { stepIndex: 0, createdAt: '2026-11-08T15:50:00Z', cacheCreationEphemeral1hInputTokens: 12000 },
      { stepIndex: 1, createdAt: '2026-11-08T15:58:00Z', cacheCreationEphemeral5mInputTokens: 4000 },
      { stepIndex: 2, agentId: 'child:sub-1', createdAt: '2026-11-08T15:59:00Z' }
    ];
    const dual = computeDualTtlState(steps, { nowMs });
    assert.equal(dual.mainTtlTier, '5m');
    assert.equal(dual.mainTtlMaxSec, 300);
    assert.equal(dual.mainTtlRemainingSec, 180);
    assert.equal(dual.subagentTtlRemainingSec, 240);
    assert.equal(dual.overageTtlCliffDetected, true);
    assert.ok(dual.overageTtlCliffMessage.includes('Overage TTL Cliff Alert'));
  });

  test('F1: computePrefixMutationDiff pinpoints exact turn, component, block index, and byte/token offset', () => {
    const steps = [
      {
        stepIndex: 0,
        shapeHash: 'aaaa1111',
        mcp_instructions_delta: 'server-a: v1',
        deferred_tools_delta: 'tool-1',
        messageRequestContext: 'ctx-v1'
      },
      {
        stepIndex: 1,
        shapeHash: 'aaaa1111',
        mcp_instructions_delta: 'server-a: v1\n' + 'x'.repeat(800),
        deferred_tools_delta: 'tool-1',
        messageRequestContext: 'ctx-v1'
      }
    ];
    const diff = computePrefixMutationDiff(steps);
    assert.equal(diff.mutated, true);
    assert.equal(diff.turnIndex, 1);
    assert.equal(diff.mutatedComponent, 'MCP_INSTRUCTIONS');
    assert.equal(diff.blockIndex, 0);
    assert.ok(diff.byteOffset > 0);
    assert.ok(diff.tokenOffset > 0);
    assert.ok(diff.summary.includes('MCP_INSTRUCTIONS'));
  });

  test('F9: evaluateColdSessionCostGate triggers KEEPWARM_WARNING at <=120s and COLD_COST_GATE at 0s TTL', () => {
    const warnGate = evaluateColdSessionCostGate({
      ttlRemainingSec: 95,
      totalActiveTokens: 120000,
      modelId: 'claude-opus-4-6'
    });
    assert.equal(warnGate.state, 'KEEPWARM_WARNING');
    assert.ok(warnGate.bannerMessage.includes('95s'));

    const coldGate = evaluateColdSessionCostGate({
      ttlRemainingSec: 0,
      totalActiveTokens: 120000,
      modelId: 'claude-opus-4-6',
      isCacheCold: true
    });
    assert.equal(coldGate.state, 'COLD_COST_GATE');
    assert.ok(coldGate.costMultiplier > 10, `Expected costMultiplier > 10x, got ${coldGate.costMultiplier}`);
    assert.ok(coldGate.coldRewriteCostUsd > coldGate.warmCompactionCostUsd);
    assert.ok(coldGate.bannerMessage.includes('.handoff.md'));
  });
});

describe('Wave 1 — Wedge F3 (Multi-Harness Trajectory Stitcher)', () => {
  test('F3: decodeProtobufWire decodes varints and nested length-delimited strings without external deps', () => {
    // Field 1 (string, wireType 2 -> tag 0x0a): "session-abc"
    // Field 2 (varint, wireType 0 -> tag 0x10): 150 (0x96 0x01)
    const strBytes = Buffer.from('session-abc', 'utf8');
    const buf = Buffer.concat([
      Buffer.from([0x0a, strBytes.length]),
      strBytes,
      Buffer.from([0x10, 0x96, 0x01])
    ]);
    const decoded = decodeProtobufWire(buf);
    assert.equal(decoded.fields.length, 2);
    assert.equal(decoded.fields[0].fieldNumber, 1);
    assert.equal(decoded.fields[0].value, 'session-abc');
    assert.equal(decoded.fields[1].fieldNumber, 2);
    assert.equal(decoded.fields[1].value, 150);
  });

  test('F3: stitchAntigravityCliTrajectory opens SQLite strictly read-only and merges .pbtxt annotations', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f3-agy-'));
    const pbtxtPath = path.join(tmpDir, 'session.pbtxt');
    fs.writeFileSync(pbtxtPath, `
      title: "Trajectory Stitcher Audit"
      workspace_uri: "file:///c:/Projects/ga-visualizer-v2"
    `, 'utf8');

    const uriBytes = Buffer.from('file:///c:/Projects/ga-visualizer-v2/src/core/quota.mjs', 'utf8');
    const payloadBlob = Buffer.concat([Buffer.from([0x0a, uriBytes.length]), uriBytes]);

    const res = await stitchAntigravityCliTrajectory(path.join(tmpDir, 'nonexistent.db'), {
      pbtxtPath,
      stepRows: [
        { idx: 0, step_type: 'USER_INPUT', status: 'DONE', step_payload: payloadBlob },
        { idx: 1, step_type: 'PLANNER_RESPONSE', status: 'DONE', step_payload: payloadBlob }
      ]
    });
    assert.equal(res.title, 'Trajectory Stitcher Audit');
    assert.equal(res.steps.length, 2);
    assert.ok(res.workspaceUri.includes('file:///c:/Projects/ga-visualizer-v2'));
  });

  test('F3: stitchCursorTrajectory merges agent-transcripts, composerData, and bubbleId rows', async () => {
    const res = await stitchCursorTrajectory({
      diskKvRows: [
        { key: 'composerData:comp-1', value: JSON.stringify({ composerId: 'comp-1' }) },
        { key: 'bubbleId:comp-1:b1', value: JSON.stringify({ type: 1, text: 'Refactor auth middleware', requestId: 'req-101' }) }
      ],
      transcriptLines: [
        { role: 'assistant', text: 'Updated auth middleware' }
      ]
    });
    assert.equal(res.composerId, 'comp-1');
    assert.ok(res.correlatedRequestIds.includes('req-101'));
    assert.equal(res.steps.length, 2);
    assert.equal(res.steps[0].type, 'USER_INPUT');
    assert.equal(res.steps[1].type, 'PLANNER_RESPONSE');
  });

  test('F3: stitchClaudeCodeDag reconstructs parentUuid -> uuid DAG, rewind branches, and restore points', () => {
    const lines = [
      JSON.stringify({ uuid: 'u1', parentUuid: null, type: 'user', cache_creation_input_tokens: 14200, content: 'Start task' }),
      JSON.stringify({ uuid: 'u2_abandoned', parentUuid: 'u1', type: 'assistant', output_tokens: 900, content: 'Abandoned branch' }),
      JSON.stringify({ uuid: 'u2_active', parentUuid: 'u1', type: 'assistant', output_tokens: 400, content: 'Active branch', leafUuid: 'u2_active' }),
      JSON.stringify({ uuid: 'snap1', parentUuid: 'u2_active', type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'src/app.js': {} } }, leafUuid: 'snap1' })
    ];
    const dag = stitchClaudeCodeDag(lines);
    assert.equal(dag.activeBranchSteps.length, 3);
    assert.equal(dag.rewindBranches.length, 1);
    assert.equal(dag.rewindBranches[0].abandonedTipUuid, 'u2_abandoned');
    assert.equal(dag.restorePoints.length, 1);
    assert.equal(dag.inferredSystemPromptTokens, 14200);
  });
});
