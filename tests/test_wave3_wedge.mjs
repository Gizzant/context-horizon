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
  computeMcpTokenRoiMatrix,
  auditInstructionStaticRot
} from '../src/core/baseline.mjs';
import { buildSubagentWorktreeDag } from '../src/core/subagents.mjs';
import {
  upsertEpisodicMemory,
  queryEpisodicMemoryBm25,
  synthesizeResumeHerePack
} from '../src/core/episodic_memory.mjs';
import { buildGitCommitTokenLedger } from '../src/core/git_ledger.mjs';
import {
  sanitizeForensicPayload,
  exportSanitizedSnapshot
} from '../src/core/sanitizer.mjs';
import {
  trackModelCachePools,
  detectRouterThrash,
  resolveModelShortName,
  computeQuotaAndCacheTelemetry
} from '../src/core/quota.mjs';

describe('Wave 3 — Wedge F6 (MCP Token ROI Matrix & Instruction Static Rot Auditor)', () => {
  test('F6: computeMcpTokenRoiMatrix flags IDLE_BLOAT_TAX on 0-call eager servers and tracks dynamic delta tokens', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f6-home-'));
    const cfgDir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        notebooklm: { loadingMode: 'eager', schemaTokens: 10800 },
        github: { loadingMode: 'lazy', schemaTokens: 2400 }
      }
    }), 'utf8');

    const steps = [
      { stepIndex: 0, mcp_instructions_delta: 'x'.repeat(1600), deferred_tools_delta: 'y'.repeat(800) }
    ];

    const roi = computeMcpTokenRoiMatrix({ homeDir: tmpHome, steps });
    assert.ok(roi.dynamicDeltaTokens >= 600);
    assert.equal(roi.idleBloatServers.length, 1);
    assert.equal(roi.idleBloatServers[0].name, 'notebooklm');
    assert.equal(roi.idleBloatServers[0].status, 'IDLE_BLOAT_TAX');
  });

  test('F6: auditInstructionStaticRot detects broken @path references in AGENTS.md / CLAUDE.md', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f6-ws-'));
    fs.writeFileSync(path.join(tmpWs, 'AGENTS.md'), '# Rules\nSee @src/existing.mjs and @src/missing_ghost_file.mjs for details.\n', 'utf8');
    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, 'src', 'existing.mjs'), 'export const x = 1;', 'utf8');

    const rot = auditInstructionStaticRot(tmpWs);
    assert.equal(rot.hasStaticRot, true);
    assert.equal(rot.brokenReferences.length, 1);
    assert.equal(rot.brokenReferences[0].reference, '@src/missing_ghost_file.mjs');
  });
});

describe('Wave 3 — Wedge F7 (Subagent Worktree & Subtrajectory DAG + File Collision Detector)', () => {
  test('F7: buildSubagentWorktreeDag tracks 5m child TTLs and detects concurrent file edit collisions across >=2 subagents', () => {
    const nowMs = Date.parse('2026-11-08T17:00:00Z');
    const parentSteps = [
      { stepIndex: 0, toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Worker A', Workspace: 'share' } }] },
      { stepIndex: 1, toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Worker B', Workspace: 'share' } }] }
    ];
    const childTranscripts = [
      {
        agentId: 'sub-A',
        workspaceMode: 'share',
        steps: [
          { createdAt: '2026-11-08T16:58:00Z', outputTokens: 4200, toolCalls: [{ name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }] }
        ]
      },
      {
        agentId: 'sub-B',
        workspaceMode: 'share',
        steps: [
          { createdAt: '2026-11-08T16:59:00Z', outputTokens: 3800, toolCalls: [{ name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }] }
        ]
      }
    ];

    const dag = buildSubagentWorktreeDag(parentSteps, { childTranscripts, nowMs });
    assert.equal(dag.parentInvocationCount, 2);
    assert.equal(dag.nodes.length, 2);
    assert.equal(dag.nodes[0].ttlRemainingSec, 180);
    assert.equal(dag.hasFileCollision, true);
    assert.equal(dag.fileCollisions.length, 1);
    assert.equal(dag.fileCollisions[0].filePath, 'src/core/quota.mjs');
    assert.deepEqual(dag.fileCollisions[0].agents, ['sub-A', 'sub-B']);
  });
});

describe('Wave 3 — Wedge F10 (SQLite FTS5 Episodic Memory) & F11 (Git Commit Token Ledger)', () => {
  test('F10: upsertEpisodicMemory, queryEpisodicMemoryBm25, and synthesizeResumeHerePack generate <1,000 token [▶ RESUME HERE] pack', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f10-fts-'));
    const dbPath = path.join(tmpDir, 'episodic_memory.db');

    await upsertEpisodicMemory(dbPath, {
      sessionId: 'sess-alpha-1',
      workspacePath: 'c:/Projects/ga-visualizer-v2',
      title: 'Dual-TTL Cache Guardian Implementation',
      summary: 'Implemented 1h vs 5m TTL cliff detection and prefix mutation byte diffs.',
      decisions: ['Use rolling SHA-256 block hashes', 'Open SQLite strictly read-only'],
      modifiedFiles: ['src/core/quota.mjs', 'src/webview/horizon_panel.html']
    });

    const q = await queryEpisodicMemoryBm25(dbPath, {
      query: 'TTL cliff prefix',
      workspacePath: 'c:/Projects/ga-visualizer-v2'
    });
    assert.equal(q.hits.length, 1);
    assert.equal(q.hits[0].sessionId, 'sess-alpha-1');

    const pack = await synthesizeResumeHerePack(dbPath, {
      workspacePath: 'c:/Projects/ga-visualizer-v2',
      query: 'TTL cliff'
    });
    assert.equal(pack.header, '[▶ RESUME HERE]');
    assert.equal(pack.withinTokenBudget, true);
    assert.ok(pack.markdown.includes('[▶ RESUME HERE]'));
    assert.ok(pack.markdown.includes('Dual-TTL Cache Guardian Implementation'));
  });

  test('F11: buildGitCommitTokenLedger attributes session tokens, cache hit %, and USD cost across .git/logs/HEAD commits', () => {
    const headLogContent = [
      '0000000000000000000000000000000000000000 a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4 Dev <dev@example.com> 1762630000 -0500\tcommit (initial): feat: init wave 1',
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4 b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5 Dev <dev@example.com> 1762630600 -0500\tcommit: feat: add wave 2 surgeon'
    ].join('\n');

    const steps = [
      { stepIndex: 0, inputTokens: 10000, cacheReadTokens: 90000, thinkingTokens: 4000, outputTokens: 2000, toolCalls: [{ name: 'edit_file', args: { Path: 'src/core/quota.mjs' } }] }
    ];

    const ledger = buildGitCommitTokenLedger('', steps, { headLogContent });
    assert.equal(ledger.commits.length, 2);
    assert.equal(ledger.cacheHitPct, 90);
    assert.ok(ledger.estimatedCostUsd > 0);
    assert.equal(ledger.files.length, 1);
    assert.ok(ledger.prMarkdownSummary.includes('Context Horizon PR Token Ledger'));

    // Verify timestamp-window interval attribution: step1 before commit 1, step2 between commit 1 and commit 2
    const timedSteps = [
      { stepIndex: 0, createdAt: 1762629900 * 1000, inputTokens: 2000, cacheReadTokens: 8000, thinkingTokens: 1000, outputTokens: 1000 },
      { stepIndex: 1, createdAt: 1762630300 * 1000, inputTokens: 6000, cacheReadTokens: 24000, thinkingTokens: 3000, outputTokens: 3000 }
    ];
    const timedLedger = buildGitCommitTokenLedger('', timedSteps, { headLogContent });
    assert.equal(timedLedger.commits.length, 2);
    assert.equal(timedLedger.commits[0].attributedTokens, 12000, 'Commit 1 must only attribute tokens from interval <= 1762630000');
    assert.equal(timedLedger.commits[1].attributedTokens, 36000, 'Commit 2 must attribute tokens from interval (1762630000, 1762630600]');
  });
});

describe('Wave 3 — Wedge F12 & Law 5 (Zero-PII Sanitizer & Forensic Snapshot Exporter)', () => {
  test('F12: sanitizeForensicPayload & exportSanitizedSnapshot scrub API keys, GitHub PATs, Bearer tokens, .env secrets, and OS home paths', () => {
    const dirtyState = {
      sessionId: 'sess-sec-99',
      workspacePath: 'C:\\Users\\alice\\Projects\\secret-app',
      notes: 'Used sk-ant-api03-1234567890abcdef and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and DATABASE_PASSWORD="superSecretPassword123"'
    };

    const { sanitized, redactedSecretCount, redactedPathCount } = sanitizeForensicPayload(dirtyState, {
      homeDir: 'C:\\Users\\alice'
    });

    assert.ok(redactedSecretCount >= 4, `Expected >=4 secrets scrubbed, got ${redactedSecretCount}`);
    assert.ok(redactedPathCount >= 1, `Expected >=1 home path scrubbed, got ${redactedPathCount}`);
    assert.ok(!JSON.stringify(sanitized).includes('sk-ant-'));
    assert.ok(!JSON.stringify(sanitized).includes('ghp_'));
    assert.ok(!JSON.stringify(sanitized).includes('superSecretPassword123'));
    assert.ok(!JSON.stringify(sanitized).includes('C:\\Users\\alice'));
    assert.equal(sanitized.workspacePath, '~\\Projects\\secret-app');

    const tmpOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hz-f12-out-')), 'snapshot.json');
    const exp = exportSanitizedSnapshot(dirtyState, { format: 'json', homeDir: 'C:\\Users\\alice', outputPath: tmpOut });
    assert.equal(exp.success, true);
    assert.equal(exp.payload.zeroPiiVerified, true);
    assert.ok(fs.existsSync(tmpOut));
  });
});

describe('Per-Model Cache Pool Tracking & Auto-Router Thrash Detection', () => {
  test('Single Intentional Switch (Flash -> Argon) records Flash on warm standby with accurate remainingTtl', () => {
    const nowMs = 1762630100000;
    const turns = [
      {
        stepIndex: 0,
        modelId: 'gemini-3.8-flash',
        modelRaw: 'Gemini 3.8 Flash (Medium)',
        cacheReadTokens: 45000,
        inputTokens: 2000,
        outputTokens: 500,
        timestampMs: nowMs - 60000 // 60s ago
      },
      {
        stepIndex: 1,
        modelId: 'gemini-4-argon',
        modelRaw: 'Gemini 4 Argon (High)',
        cacheReadTokens: 0,
        inputTokens: 47000,
        outputTokens: 600,
        timestampMs: nowMs
      }
    ];

    const poolsResult = trackModelCachePools(turns, { nowMs });
    assert.ok(poolsResult.standbyCache, 'Flash must be placed on warm standby');
    assert.equal(poolsResult.standbyCache.modelName, 'Flash');
    assert.equal(poolsResult.standbyCache.cachedTokens, 45000);
    assert.equal(poolsResult.standbyCache.remainingTtl, 240); // 300 - 60 = 240s
    assert.equal(poolsResult.modelCachePools.size, 2);
    assert.equal(poolsResult.modelCachePools.get('gemini-3.8-flash').isWarm, true);

    const thrash = detectRouterThrash(turns, false, {
      totalTokens: 47000,
      standbyCache: poolsResult.standbyCache
    });
    assert.equal(thrash.state, 'MODEL_SWITCH_COLD_START');
    assert.equal(thrash.severity, 'info');
    assert.ok(thrash.badgeText.includes('model switch'));
    assert.ok(thrash.standbyNote.includes('Flash cache still warm: 240s left'));
  });

  test('Round-Trip Switch (Argon -> Flash -> Argon within 120s) recognizes Argons pre-existing pool and attributes miss to prefix drift', () => {
    const nowMs = 1762630120000;
    const turns = [
      {
        stepIndex: 0,
        modelId: 'gemini-4-argon',
        modelRaw: 'Gemini 4 Argon',
        cacheReadTokens: 80000,
        inputTokens: 1000,
        outputTokens: 400,
        timestampMs: nowMs - 90000 // 90s ago
      },
      {
        stepIndex: 1,
        modelId: 'gemini-3.8-flash',
        modelRaw: 'Gemini 3.8 Flash',
        cacheReadTokens: 0,
        inputTokens: 81000,
        outputTokens: 500,
        timestampMs: nowMs - 30000 // 30s ago
      },
      {
        stepIndex: 2,
        modelId: 'gemini-4-argon',
        modelRaw: 'Gemini 4 Argon',
        cacheReadTokens: 0, // unexpected miss despite warm pool!
        inputTokens: 82000,
        outputTokens: 600,
        explicitMutation: true,
        timestampMs: nowMs
      }
    ];

    const poolsResult = trackModelCachePools(turns, { nowMs });
    assert.equal(poolsResult.lastSwitchEvent.warmPoolBustedReason, 'RULE_FILE_DRIFT');
    assert.equal(poolsResult.modelCachePools.get('gemini-4-argon').remainingTtl, 300); // refreshed on turn 2
  });

  test('Auto-Router Thrash (Argon -> Flash -> Argon in [Auto] mode at 169k tokens) triggers AUTO_ROUTER_THRASH and surfaces model-pinning action item', () => {
    const nowMs = 1762630150000;
    const turns = [
      {
        stepIndex: 0,
        modelId: 'gemini-4-argon',
        modelRaw: 'Gemini 4 Argon',
        cacheReadTokens: 168000,
        inputTokens: 1000,
        outputTokens: 500,
        timestampMs: nowMs - 60000
      },
      {
        stepIndex: 1,
        modelId: 'gemini-3.8-flash',
        modelRaw: 'Gemini 3.8 Flash',
        cacheReadTokens: 0,
        inputTokens: 169000,
        outputTokens: 500,
        timestampMs: nowMs - 30000
      },
      {
        stepIndex: 2,
        modelId: 'gemini-4-argon',
        modelRaw: 'Gemini 4 Argon',
        cacheReadTokens: 0,
        inputTokens: 169000,
        outputTokens: 500,
        timestampMs: nowMs
      }
    ];

    const thrash = detectRouterThrash(turns, true, {
      totalTokens: 169000
    });
    assert.equal(thrash.detected, true);
    assert.equal(thrash.state, 'AUTO_ROUTER_THRASH');
    assert.equal(thrash.severity, 'warn');
    assert.equal(thrash.switchCount, 2);
    assert.ok(thrash.thrashUncachedTokens >= 338000);
    assert.ok(thrash.badgeText.includes('Router Thrash: 2 model hops'));
    assert.ok(thrash.tooltip.includes('Auto-routing is bouncing between models'));
    assert.ok(thrash.tooltip.includes('Pin a single model or run /compact'));
  });

  test('Subsequent turn on the same model with cacheHit > 50% clears the cold-start badge (One-Turn Decay to Healthy)', () => {
    const nowMs = 1762630180000;
    const turns = [
      {
        stepIndex: 0,
        modelId: 'gemini-3.8-flash',
        modelRaw: 'Gemini 3.8 Flash',
        cacheReadTokens: 50000,
        inputTokens: 1000,
        outputTokens: 400,
        timestampMs: nowMs - 60000
      },
      {
        stepIndex: 1,
        modelId: 'gemini-4-argon',
        modelRaw: 'Gemini 4 Argon',
        cacheReadTokens: 0,
        inputTokens: 51000,
        outputTokens: 500,
        timestampMs: nowMs - 30000
      },
      {
        stepIndex: 2,
        modelId: 'gemini-4-argon', // stayed on Argon
        modelRaw: 'Gemini 4 Argon',
        cacheReadTokens: 51000,     // warm hit > 50%
        inputTokens: 1000,
        outputTokens: 600,
        timestampMs: nowMs
      }
    ];

    const thrash = detectRouterThrash(turns, false, {
      totalTokens: 52000
    });
    assert.equal(thrash.state, 'HEALTHY');
    assert.equal(thrash.detected, false);
    assert.equal(thrash.badgeText, '');
  });
});

describe('Simple View Recommended Actions Collapsible Architecture & Open-State Preservation', () => {
  test('Recommended Actions render as initially-collapsed <details> rows with summary header and body instructions', async (t) => {
    if (!JSDOM) {
      t.skip('JSDOM not available in environment');
      return;
    }
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

    const testState = {
      schemaVersion: '1.1.0',
      sessionId: 'collapsible-action-test',
      window: { maxTokens: 256000, cellSizeTokens: 6400, totalCells: 40, totalActiveTokens: 85000, usedPercentage: 33, turnCount: 10, safeLimit: 179000 },
      breakdown: { ANCHOR: 10000, ACTIVE_WORKING_SET: 50000, STALE_DUPLICATE: 20000, DEAD_ERROR: 5000, FREE_HEADROOM: 171000 },
      metrics: { signalPurityPct: 70, sludgeTokens: 25000 },
      chronicReads: [
        { path: 'package-lock.json', sessions: 4, windowSessions: 5, wastedTokens: 12000 }
      ],
      quota: {
        sprint5h: { usedPct: 20, remainingPct: 80 },
        weekly7d: { usedPct: 35, remainingPct: 65 },
        cache: {
          hitRatePct: 88,
          ttlRemainingSec: 220,
          isCacheCold: false,
          cacheReadTokens: 40000,
          uncachedInputTokens: 5000
        }
      },
      brainSignals: {
        activeSignal: { liveSessionTokens: 50000, taskMdSaved: false, taskMdTurnsBehind: 2 },
        userCorrections: 1,
        userCorrectionTexts: ['Do not use any global variables in utility modules.'],
        duplicateReads: { fileCount: 1, reclaimableTokens: 20000, topFiles: [{ path: 'package-lock.json', occurrences: 3, wastedTokens: 20000 }] },
        oldHistory: { turnCount: 5, reclaimableTokens: 15000 },
        deadErrors: { errorCount: 1, reclaimableTokens: 5000 },
        mcpAudit: {
          unusedEagerServers: [{ name: 'notebooklm', schemaTokens: 8000, sessionCallCount: 0 }]
        }
      },
      cells: []
    };

    w.renderState(testState);
    await new Promise(r => setTimeout(r, 30));

    const actionListEl = d.getElementById('simpleActionList');
    assert.ok(actionListEl, '#simpleActionList must exist');

    const detailsRows = Array.from(actionListEl.querySelectorAll('details.m3-action-collapsible'));
    assert.ok(detailsRows.length >= 3, 'Must render multiple collapsible action rows');

    // 1. Initial State: All items must be collapsed
    for (const row of detailsRows) {
      assert.equal(row.open, false, `Row [${row.dataset.actionId}] must be initially collapsed`);
      const summary = row.querySelector('summary.m3-action-summary');
      assert.ok(summary, `Row [${row.dataset.actionId}] must have summary.m3-action-summary`);
      assert.ok(summary.querySelector('.m3-action-caret'), `Summary must have caret`);
      assert.ok(summary.querySelector('.m3-action-title'), `Summary must have title`);
      assert.ok(summary.querySelector('.m3-impact-badge'), `Summary must have impact badge`);

      const body = row.querySelector('.m3-action-body');
      assert.ok(body, `Row [${row.dataset.actionId}] must have .m3-action-body`);
      assert.ok(body.querySelector('.m3-action-inst'), `Body must have instructions .m3-action-inst`);
    }

    // 2. Strict UI Invariant 1: compact-context has NO copy button
    const compactRow = actionListEl.querySelector('details[data-action-id="compact-context"]');
    assert.ok(compactRow, 'Must have compact-context row');
    assert.equal(compactRow.querySelector('[data-simple-copy]'), null, 'UI Invariant 1: compact-context must NEVER have a copy button');
    assert.ok(compactRow.querySelector('.m3-action-inst').textContent.includes('Type /compact in the chat box and press Enter'));

    // 3. Rows with copyable data have [data-simple-copy]
    const cpRow = actionListEl.querySelector('details[data-action-id="checkpoint-sync"]');
    assert.ok(cpRow, 'Must have checkpoint-sync row');
    const cpCopyBtn = cpRow.querySelector('[data-simple-copy]');
    assert.ok(cpCopyBtn, 'checkpoint-sync must have a [data-simple-copy] button');

    // 4. Open-state preservation across renderState
    // Expand checkpoint-sync and agent-learning
    cpRow.open = true;
    const ruleRow = actionListEl.querySelector('details[data-action-id="agent-learning"]');
    if (ruleRow) ruleRow.open = true;

    // Trigger re-render with updated token count
    w.renderState({
      ...testState,
      window: { ...testState.window, totalActiveTokens: 86000 }
    });
    await new Promise(r => setTimeout(r, 30));

    const reRenderedCpRow = actionListEl.querySelector('details[data-action-id="checkpoint-sync"]');
    assert.equal(reRenderedCpRow.open, true, 'checkpoint-sync row must remain open across live re-render');

    const reRenderedCompactRow = actionListEl.querySelector('details[data-action-id="compact-context"]');
    assert.equal(reRenderedCompactRow.open, false, 'unopened rows must remain collapsed across live re-render');

    dom.window.close();
  });

  test('5 Engineering Fixes: Preview CSS, Session Sorting, Chronic Badges, Spike Differentiation & AST/Compact Copy', async (t) => {
    if (!JSDOM) {
      t.skip('JSDOM not available in environment');
      return;
    }
    const htmlPath = path.resolve('src/webview/horizon_panel.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // 1. Prompt preview CSS check
    assert.ok(
      htmlContent.includes('overflow-wrap: break-word') && htmlContent.includes('word-break: normal'),
      'Prompt preview CSS must use overflow-wrap: break-word and word-break: normal'
    );

    const dom = new JSDOM(htmlContent, {
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
    await new Promise(r => setTimeout(r, 60));

    const stateWithSpikeAndChronic = {
      schemaVersion: '1.1.0',
      sessionId: 'fixes-test-session',
      window: { maxTokens: 256000, cellSizeTokens: 6400, totalCells: 40, totalActiveTokens: 120000, usedPercentage: 47, turnCount: 15, safeLimit: 179000 },
      breakdown: { ANCHOR: 10000, ACTIVE_WORKING_SET: 70000, STALE_DUPLICATE: 20000, DEAD_ERROR: 5000, FREE_HEADROOM: 136000 },
      metrics: { signalPurityPct: 75, sludgeTokens: 25000 },
      brainSignals: {
        taskHandoff: { taskMdSaved: true, taskMdTurnsBehind: 0 },
        duplicateReads: { fileCount: 1, files: ['src/core/parser.mjs'], duplicateTokens: 12000 },
        deadErrors: { errorCount: 1, errorTokens: 4000 },
        blowupSteps: [
          {
            stepIndex: 7,
            tokens: 35000,
            category: 'LARGE_FILE',
            target: 'src/webview/horizon_panel.html',
            payload: { kind: 'file', path: 'src/webview/horizon_panel.html', detail: 'src/webview/horizon_panel.html' }
          }
        ]
      },
      chronicReads: [
        { path: 'src/webview/horizon_panel.html', sessions: 10, totalWastedTokens: 76900 }
      ],
      effortProfile: { tier: 'HIGH', label: 'High Effort', shortLabel: 'Argon' },
      baseline: { reclaimSumK: 35 }
    };

    w.renderState(stateWithSpikeAndChronic);
    await new Promise(r => setTimeout(r, 50));

    const actionListEl = d.getElementById('simpleActionList');
    assert.ok(actionListEl, '#simpleActionList must exist');

    // 2. Sorting: Current-session rows must come BEFORE chronic-read
    const allRows = Array.from(actionListEl.querySelectorAll('details.m3-action-collapsible'));
    const actionIds = allRows.map(r => r.dataset.actionId);

    const compactIdx = actionIds.indexOf('compact-context');
    const spikeIdx = actionIds.indexOf('dampen-blowup');
    const astIdx = actionIds.indexOf('condense-ast');
    const chronicIdx = actionIds.indexOf('chronic-read');

    assert.ok(compactIdx !== -1, 'compact-context must be present');
    assert.ok(spikeIdx !== -1, 'dampen-blowup must be present');
    assert.ok(astIdx !== -1, 'condense-ast must be present');
    assert.ok(chronicIdx !== -1, 'chronic-read must be present');

    assert.ok(compactIdx < chronicIdx, 'compact-context must be sorted above chronic-read');
    assert.ok(spikeIdx < chronicIdx, 'single-turn spike must be sorted above chronic-read');
    assert.ok(astIdx < chronicIdx, 'condense-ast must be sorted above chronic-read');

    // 2b. Chronic badge formatting & style
    const chronicRow = actionListEl.querySelector('details[data-action-id="chronic-read"]');
    const chronicBadge = chronicRow.querySelector('.m3-impact-badge');
    assert.ok(chronicBadge.classList.contains('violet'), 'Chronic badge must use violet styling');
    assert.equal(chronicBadge.textContent, '~76.9k (10 chats)', 'Chronic badge must format as ~76.9k (10 chats)');

    // 2c. Chronic filename interpolation & unambiguous copy action
    const chronicPreview = chronicRow.querySelector('.m3-action-data-preview');
    assert.ok(chronicPreview.textContent.includes('horizon_panel.html'), 'Chronic prompt preview must interpolate filename');
    const copyPromptBtn = chronicRow.querySelector('[data-simple-copy]');
    assert.ok(copyPromptBtn, 'Chronic row must have a copy prompt button');
    assert.ok(copyPromptBtn.textContent.includes('Copy Prompt'), 'Button must clearly indicate Copy Prompt');
    const allBtns = chronicRow.querySelectorAll('.m3-action-btn');
    assert.equal(allBtns.length, 1, 'Chronic row must have exactly 1 clear action button (no duplicate/confusing buttons)');

    // 3. File Spike differentiation
    const spikeRow = actionListEl.querySelector('details[data-action-id="dampen-blowup"]');
    const spikePreview = spikeRow.querySelector('.m3-action-data-preview');
    assert.ok(
      spikePreview.textContent.includes('Use view_file_outline or StartLine/EndLine ranges instead of reading/emitting the full file in one step'),
      'File spike must show file-range prompt'
    );
    assert.equal(spikeRow.querySelector('[data-simple-act="dampen-hook"]'), null, 'File spike must not have CLI PreToolUse hook button');

    // Now test Command Spike
    w.renderState({
      ...stateWithSpikeAndChronic,
      brainSignals: {
        ...stateWithSpikeAndChronic.brainSignals,
        blowupSteps: [
          {
            stepIndex: 8,
            tokens: 42000,
            category: 'COMMAND_BLOWUP',
            target: 'npm test --verbose',
            payload: { kind: 'command', detail: 'npm test --verbose' }
          }
        ]
      }
    });
    await new Promise(r => setTimeout(r, 50));

    const cmdSpikeRow = actionListEl.querySelector('details[data-action-id="dampen-blowup"]');
    const hookBtn = cmdSpikeRow.querySelector('[data-simple-act="dampen-hook"]');
    assert.ok(hookBtn, 'Command spike must have PreToolUse hook button');
    assert.ok(hookBtn.textContent.includes('Register PreToolUse Hook'), 'Button text must be Register PreToolUse Hook');

    // 4. AST Condense Cache Claim & CLI Command
    const astRow = actionListEl.querySelector('details[data-action-id="condense-ast"]');
    const astInst = astRow.querySelector('.m3-action-inst');
    assert.ok(
      astInst.textContent.includes('best run when the 5m prompt cache is cold (requires confirmation if cache is warm)'),
      'AST card must accurately describe 5m prompt cache behavior'
    );
    const astPreview = astRow.querySelector('.m3-action-data-preview');
    assert.equal(astPreview.textContent.trim(), 'npx ctxtop prune', 'AST CLI command must be npx ctxtop prune');

    // 5. Accurate /compact Description
    const compactRow = actionListEl.querySelector('details[data-action-id="compact-context"]');
    const compactInst = compactRow.querySelector('.m3-action-inst');
    assert.ok(
      compactInst.textContent.includes('and active working summary intact'),
      'Compact card must say and active working summary intact'
    );
    assert.ok(
      !compactInst.textContent.includes('and active code intact'),
      'Compact card must NOT say and active code intact'
    );

    dom.window.close();
  });

  test('Auto-Dismiss on Copy: removes chronic re-read on Copy Prompt and decrements action count', async () => {
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
    await new Promise(r => setTimeout(r, 60));

    // Mock clipboard
    let copiedText = '';
    w.navigator.clipboard = {
      writeText: async (t) => { copiedText = t; }
    };

    const state = {
      updatedAt: Date.now(),
      sessionId: 'sess-dismiss-test',
      totalTokens: 60000,
      safeLimit: 120000,
      maxTokens: 200000,
      window: { totalTokens: 60000, maxTokens: 200000 },
      chronicReads: [
        {
          path: 'src/webview/horizon_panel.html',
          sessions: 10,
          windowSessions: 10,
          totalReads: 32,
          totalWastedTokens: 76900
        },
        {
          path: 'src/core/classifier.mjs',
          sessions: 4,
          windowSessions: 10,
          totalReads: 8,
          totalWastedTokens: 12000
        }
      ],
      brainSignals: {
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 },
        handoff: { artifacts: { taskMd: { exists: true } } }
      }
    };

    w.renderState(state);
    await new Promise(r => setTimeout(r, 50));

    const actionListEl = d.getElementById('simpleActionList');
    const pill = d.getElementById('simpleActionCountPill');
    const resetBtn = d.getElementById('simpleResetDismissedBtn');

    assert.ok(actionListEl, '#simpleActionList must exist');
    const initialRows = actionListEl.querySelectorAll('details[data-action-id="chronic-read"]');
    assert.equal(initialRows.length, 2, 'Must initially render 2 chronic re-read rows');
    assert.equal(pill.textContent, '2 actions', 'Must show 2 actions in pill');
    assert.equal(resetBtn.style.display, 'none', 'Reset button must initially be hidden');

    // Click Copy Prompt on first chronic re-read (horizon_panel.html)
    const firstCopyBtn = initialRows[0].querySelector('[data-simple-copy]');
    assert.ok(firstCopyBtn, 'Must have copy button');
    assert.ok(firstCopyBtn.dataset.dismissKey.includes('horizon_panel.html'), 'Dismiss key must include path');

    firstCopyBtn.click();
    assert.ok(copiedText.includes('StartLine/EndLine'), 'Clipboard must receive prompt text');

    // Wait for auto-dismiss timeout (500ms)
    await new Promise(r => setTimeout(r, 650));

    // Verify horizon_panel.html is removed and classifier.mjs remains
    const remainingRows = actionListEl.querySelectorAll('details[data-action-id="chronic-read"]');
    assert.equal(remainingRows.length, 1, 'Only 1 chronic row must remain after dismiss');
    assert.ok(remainingRows[0].textContent.includes('classifier.mjs'), 'classifier.mjs must remain');
    assert.equal(pill.textContent, '1 action', 'Action count pill must decrement to 1 action');
    assert.equal(resetBtn.style.display, 'inline-block', 'Reset button must now be visible');

    // Test Reset Dismissed button
    resetBtn.click();
    await new Promise(r => setTimeout(r, 50));

    const restoredRows = actionListEl.querySelectorAll('details[data-action-id="chronic-read"]');
    assert.equal(restoredRows.length, 2, 'Both chronic rows must be restored after Reset');
    assert.equal(pill.textContent, '2 actions', 'Action count pill must restore to 2 actions');
    assert.equal(resetBtn.style.display, 'none', 'Reset button must hide again after reset');

    dom.window.close();
  });

  test('Agent Learning: Auto-Add Rule promotes rule and dismisses; Copy Prompt dismisses and decrements count', async () => {
    const htmlPath = path.resolve('src/webview/horizon_panel.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    let promotePayload = null;
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async (url, opts) => {
          if (url.includes('/api/rules/promote')) {
            promotePayload = JSON.parse(opts.body);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                success: true,
                insertedAtLine: 2,
                totalLinesAfter: 18,
                zoneUsed: 'primacy',
                targetPath: 'C:/Projects/ga-visualizer-v2/AGENTS.md'
              })
            };
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        };
      }
    });

    const w = dom.window;
    const d = w.document;
    await new Promise(r => setTimeout(r, 60));

    // Mock clipboard
    let copiedText = '';
    w.navigator.clipboard = {
      writeText: async (t) => { copiedText = t; }
    };

    const state = {
      updatedAt: Date.now(),
      sessionId: 'sess-rule-test',
      totalTokens: 50000,
      safeLimit: 120000,
      maxTokens: 200000,
      window: { totalTokens: 50000, maxTokens: 200000 },
      signals: {
        userCorrections: 3,
        userCorrectionTexts: [
          '<USER_REQUEST> To keep context memory lean, please use StartLine/EndLine when reading .../webview/ho'
        ],
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 },
        handoff: { artifacts: { taskMd: { exists: true } } }
      },
      brainSignals: {
        userCorrections: 3,
        userCorrectionTexts: [
          '<USER_REQUEST> To keep context memory lean, please use StartLine/EndLine when reading .../webview/ho'
        ],
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 },
        handoff: { artifacts: { taskMd: { exists: true } } }
      }
    };

    w.renderState(state);
    await new Promise(r => setTimeout(r, 50));

    const actionListEl = d.getElementById('simpleActionList');
    const pill = d.getElementById('simpleActionCountPill');

    const ruleRow = actionListEl.querySelector('details[data-action-id="agent-learning"]');
    assert.ok(ruleRow, 'agent-learning row must exist');

    // 1. Verify clean rule preview (no <USER_REQUEST> tags)
    const preview = ruleRow.querySelector('.m3-action-data-preview');
    assert.ok(preview, 'Preview must exist');
    assert.ok(!preview.textContent.includes('<USER_REQUEST>'), 'Preview must strip <USER_REQUEST> envelope');
    assert.ok(preview.textContent.includes('To keep context memory lean'), 'Preview must have clean directive text');

    // 2. Verify Auto-Add Rule button calls promoteRuleDirect with clean text
    const autoAddBtn = ruleRow.querySelector('[data-simple-act="promote-rule"]');
    assert.ok(autoAddBtn, 'Auto-Add Rule button must exist');
    assert.ok(!autoAddBtn.dataset.rule.includes('<USER_REQUEST>'), 'data-rule must strip <USER_REQUEST>');

    await autoAddBtn.onclick({ stopPropagation() {} });
    assert.ok(promotePayload, 'Must have posted to /api/rules/promote');
    assert.equal(promotePayload.zone, 'primacy', 'Must target primacy zone');
    assert.ok(!promotePayload.ruleText.includes('<USER_REQUEST>'), 'Payload ruleText must not contain <USER_REQUEST>');

    // Wait for auto-dismiss
    await new Promise(r => setTimeout(r, 650));
    assert.equal(actionListEl.querySelector('details[data-action-id="agent-learning"]'), null, 'agent-learning must be dismissed after Auto-Add Rule');

    dom.window.close();
  });

  test('Universal Action Auto-Dismiss: Checkpoint, Condense, MCP, and Spike dismiss on Copy or Direct Action', async () => {
    const htmlPath = path.resolve('src/webview/horizon_panel.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async (url) => {
          if (url.includes('/api/hooks/dampen')) {
            return { ok: true, status: 200, json: async () => ({ success: true }) };
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        };
      }
    });

    const w = dom.window;
    const d = w.document;
    await new Promise(r => setTimeout(r, 60));

    let copiedText = '';
    w.navigator.clipboard = {
      writeText: async (t) => { copiedText = t; }
    };

    const multiActionState = {
      updatedAt: Date.now(),
      sessionId: 'sess-universal-dismiss',
      totalTokens: 90000,
      safeLimit: 120000,
      maxTokens: 200000,
      window: { totalTokens: 90000, maxTokens: 200000 },
      breakdown: { STALE_DUPLICATE: 10000, DEAD_ERROR: 2000 },
      signals: {
        activeSignal: { taskMdSaved: false, taskMdTurnsBehind: 5 },
        handoff: { artifacts: { taskMd: { exists: true } } },
        mcpAudit: {
          unusedEagerServers: [{ name: 'github-mcp', schemaTokens: 6000 }]
        },
        duplicateReads: { fileCount: 1, files: ['test.js'], duplicateTokens: 10000 },
        deadErrors: { errorCount: 1, errorTokens: 2000 },
        blowupSteps: [
          {
            stepIndex: 12,
            tokens: 30000,
            target: 'cat big_file.json',
            payload: { kind: 'command', detail: 'cat big_file.json' }
          }
        ]
      },
      brainSignals: {
        activeSignal: { taskMdSaved: false, taskMdTurnsBehind: 5 },
        handoff: { artifacts: { taskMd: { exists: true } } },
        mcpAudit: {
          unusedEagerServers: [{ name: 'github-mcp', schemaTokens: 6000 }]
        },
        duplicateReads: { fileCount: 1, files: ['test.js'], duplicateTokens: 10000 },
        deadErrors: { errorCount: 1, errorTokens: 2000 },
        blowupSteps: [
          {
            stepIndex: 12,
            tokens: 30000,
            target: 'cat big_file.json',
            payload: { kind: 'command', detail: 'cat big_file.json' }
          }
        ]
      }
    };

    w.renderState(multiActionState);
    await new Promise(r => setTimeout(r, 50));

    const actionListEl = d.getElementById('simpleActionList');
    const pill = d.getElementById('simpleActionCountPill');
    const resetBtn = d.getElementById('simpleResetDismissedBtn');
    const resetCount = d.getElementById('simpleResetDismissedCount');

    assert.ok(actionListEl, '#simpleActionList must exist');

    // 1. Verify all 4 action rows are present
    const cpRow = actionListEl.querySelector('details[data-action-id="checkpoint-sync"]');
    const astRow = actionListEl.querySelector('details[data-action-id="condense-ast"]');
    const mcpRow = actionListEl.querySelector('details[data-action-id="mcp-lazy"]');
    const spikeRow = actionListEl.querySelector('details[data-action-id="dampen-blowup"]');

    assert.ok(cpRow, 'Checkpoint row must be present');
    assert.ok(astRow, 'Condense AST row must be present');
    assert.ok(mcpRow, 'MCP Lazy row must be present');
    assert.ok(spikeRow, 'Spike Dampen row must be present');

    // 2. Dismiss Checkpoint via Copy Prompt
    const cpCopyBtn = cpRow.querySelector('[data-simple-copy]');
    assert.ok(cpCopyBtn, 'Checkpoint must have copy button');
    assert.equal(cpCopyBtn.dataset.dismissKey, 'checkpoint', 'Checkpoint copy button must have data-dismiss-key=checkpoint');
    cpCopyBtn.click();
    await new Promise(r => setTimeout(r, 650));
    assert.equal(actionListEl.querySelector('details[data-action-id="checkpoint-sync"]'), null, 'Checkpoint row must be dismissed');

    // 3. Dismiss Condense AST via Copy Command
    const astCopyBtn = actionListEl.querySelector('details[data-action-id="condense-ast"] [data-simple-copy]');
    assert.ok(astCopyBtn, 'AST row must have copy command button');
    assert.equal(astCopyBtn.dataset.dismissKey, 'condense', 'AST copy button must have data-dismiss-key=condense');
    astCopyBtn.click();
    await new Promise(r => setTimeout(r, 650));
    assert.equal(actionListEl.querySelector('details[data-action-id="condense-ast"]'), null, 'Condense AST row must be dismissed');

    // 4. Dismiss MCP Lazy via Copy Prompt
    const mcpCopyBtn = actionListEl.querySelector('details[data-action-id="mcp-lazy"] [data-simple-copy]');
    assert.ok(mcpCopyBtn, 'MCP row must have copy button');
    assert.equal(mcpCopyBtn.dataset.dismissKey, 'mcp:github-mcp', 'MCP copy button must have data-dismiss-key=mcp:github-mcp');
    mcpCopyBtn.click();
    await new Promise(r => setTimeout(r, 650));
    assert.equal(actionListEl.querySelector('details[data-action-id="mcp-lazy"]'), null, 'MCP Lazy row must be dismissed');

    // 5. Dismiss Spike Dampen via Copy Prompt
    const spikeCopyBtn = actionListEl.querySelector('details[data-action-id="dampen-blowup"] [data-simple-copy]');
    assert.ok(spikeCopyBtn, 'Spike row must have copy button');
    assert.equal(spikeCopyBtn.dataset.dismissKey, 'spike:12', 'Spike copy button must have data-dismiss-key=spike:12');
    spikeCopyBtn.click();
    await new Promise(r => setTimeout(r, 650));
    assert.equal(actionListEl.querySelector('details[data-action-id="dampen-blowup"]'), null, 'Spike row must be dismissed');

    // 6. Verify Reset button shows 4 dismissed items and clicking it restores them
    assert.equal(resetBtn.style.display, 'inline-block', 'Reset button must be visible');
    assert.equal(resetCount.textContent, '4', 'Reset count must equal 4');

    resetBtn.click();
    await new Promise(r => setTimeout(r, 60));

    assert.ok(actionListEl.querySelector('details[data-action-id="checkpoint-sync"]'), 'Checkpoint row must be restored');
    assert.ok(actionListEl.querySelector('details[data-action-id="condense-ast"]'), 'Condense AST row must be restored');
    assert.ok(actionListEl.querySelector('details[data-action-id="mcp-lazy"]'), 'MCP Lazy row must be restored');
    assert.ok(actionListEl.querySelector('details[data-action-id="dampen-blowup"]'), 'Spike Dampen row must be restored');
    assert.equal(resetBtn.style.display, 'none', 'Reset button must hide after reset');

    // 7. Verify Compacting & Task Checkpoint items remain hidden when session is healthy and not needed
    w.renderState({
      updatedAt: Date.now(),
      sessionId: 'sess-lean-healthy',
      totalTokens: 45000,
      safeLimit: 140000,
      maxTokens: 200000,
      window: { totalTokens: 45000, safeLimit: 140000, maxTokens: 200000 },
      breakdown: { ANCHOR: 10000, ACTIVE_WORKING_SET: 31000, STALE_DUPLICATE: 4000, DEAD_ERROR: 0 },
      signals: {
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 1 },
        handoff: { artifacts: { taskMd: { exists: true } } }
      },
      brainSignals: {
        activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 1 },
        handoff: { artifacts: { taskMd: { exists: true } } },
        oldHistory: { turnCount: 2, reclaimableTokens: 4000 }
      }
    });
    await new Promise(r => setTimeout(r, 40));

    assert.equal(actionListEl.querySelector('details[data-action-id="compact-context"]'), null, 'compact-context must be hidden when session is lean and below cleanup thresholds');
    assert.equal(actionListEl.querySelector('details[data-action-id="checkpoint-sync"]'), null, 'checkpoint-sync must be hidden when compaction is not needed and task.md is recently synced');

    dom.window.close();
  });
});
