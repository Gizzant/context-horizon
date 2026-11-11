import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  buildActionQueue,
  formatActionQueueAnsi,
  BANNED_FILLER_WORDS
} from '../src/core/action_queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Zero-Prose ACTION QUEUE & Simple Mode Verification', () => {
  test('1. Zero-Height Collapse When Nominal: returns [] and empty string ""', () => {
    const nominalState = {
      window: { totalActiveTokens: 25000, maxTokens: 256000 },
      metrics: { totalTurns: 10, signalPurityPct: 98, sludgeTokens: 0 },
      brainSignals: { duplicateReads: { reclaimableTokens: 0 }, deadErrors: { reclaimableTokens: 0 }, oldHistory: { reclaimableTokens: 0 } },
      quota: { cache: { ttlRemainingSec: 280, hitPercent: 95 } },
      hostHealth: { orphanCount: 0, rssGb: 0.5, status: 'HEALTHY', orphans: [] },
      topRiskyCells: []
    };

    const queue = buildActionQueue(nominalState);
    assert.deepEqual(queue, [], 'Nominal state must return empty action queue array');

    const ansi = formatActionQueueAnsi(queue);
    assert.equal(ansi, '', 'Nominal state must format to exact zero-length string ""');
  });

  test('2. Deterministic Prioritization: Orphan/RAM pinned to Slot 1, capped at 4 items', () => {
    const crisisState = {
      window: { totalActiveTokens: 145000, maxTokens: 200000 },
      metrics: { totalTurns: 42, signalPurityPct: 35, sludgeTokens: 84000 },
      brainSignals: {
        duplicateReads: { reclaimableTokens: 24000, fileCount: 4 },
        deadErrors: { reclaimableTokens: 10000, errorCount: 2 },
        oldHistory: { reclaimableTokens: 50000, turnCount: 37 },
        mcpAudit: {
          unusedEagerServers: [
            { name: 'notebooklm', schemaTokens: 10900, sessionCallCount: 0 },
            { name: 'google-dev', schemaTokens: 1500, sessionCallCount: 0 }
          ]
        }
      },
      quota: { cache: { ttlRemainingSec: 45, hitPercent: 41, cacheReadTokens: 60000 } },
      hostHealth: {
        orphanCount: 2,
        rssGb: 2.14,
        status: 'ZOMBIE_LEAK',
        orphans: [
          { pid: 41820, ppid: 1, name: 'language_server.exe', parentAlive: false, rssMb: 1200 },
          { pid: 44912, ppid: 1, name: 'mcp-server.exe', parentAlive: false, rssMb: 940 }
        ]
      },
      topRiskyCells: [
        { cellNumber: 9, cellIndex: 8, filePath: 'task.md', tokenWeight: 6400, riskReason: 'TROUGH_STRANDED_SPEC', inTrough: true, attentionRecallPct: 42 }
      ]
    };

    const queue = buildActionQueue(crisisState);
    assert.ok(queue.length > 0 && queue.length <= 4, 'Must emit at most 4 items');
    assert.equal(queue[0].kind, 'ORPHAN_PID', 'Slot #1 must be pinned to Orphan/RAM breach');
    assert.ok(queue.some(i => i.kind === 'STALE_TOOLS'), 'Must include stale tool output pruning');
    assert.ok(queue.some(i => i.kind === 'IDLE_MCP'), 'Must include idle MCP deferral');

    const ansi = formatActionQueueAnsi(queue);
    assert.ok(ansi.includes('ACTION QUEUE (4)'), 'Must include header with item count');
    assert.ok(ansi.includes('├─') || ansi.includes('└─'), 'Must use tree branch characters');
    assert.ok(ansi.includes('reclaims 2.14 GB RAM'), 'Must show quantified RAM payoff');
  });

  test('3. Strict Anti-Slop Syntax: zero banned conversational filler words', () => {
    const testState = {
      window: { totalActiveTokens: 60000 },
      metrics: { totalTurns: 15 },
      brainSignals: { duplicateReads: { reclaimableTokens: 12000 } },
      quota: { cache: { ttlRemainingSec: 30, hitPercent: 80, cacheReadTokens: 55000 } }
    };
    const queue = buildActionQueue(testState);
    const textBlob = JSON.stringify(queue).toLowerCase();

    for (const filler of BANNED_FILLER_WORDS) {
      assert.ok(!textBlob.includes(filler), `Action queue text must NOT contain filler phrase "${filler}"`);
    }
  });

  test('4. Web UI JSDOM: Simple mode collapses nominal state and renders Action Queue panel', () => {
    const htmlPath = path.resolve(__dirname, '../src/webview/horizon_panel.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const { window } = dom;

    // Verify #actionQueuePanel exists in DOM
    const aqPanel = window.document.getElementById('actionQueuePanel');
    assert.ok(aqPanel, '#actionQueuePanel must be present in HTML structure');

    // Render nominal state
    window.renderState({
      window: { totalActiveTokens: 20000, maxTokens: 256000 },
      metrics: { totalTurns: 5, signalPurityPct: 99, sludgeTokens: 0 },
      hostHealth: { orphanCount: 0, status: 'HEALTHY' }
    });
    assert.equal(aqPanel.hidden, true, '#actionQueuePanel must be hidden when nominal');

    // Render state with actions
    window.renderState({
      window: { totalActiveTokens: 75000, maxTokens: 256000 },
      metrics: { totalTurns: 20, signalPurityPct: 40, sludgeTokens: 45000 },
      brainSignals: { duplicateReads: { reclaimableTokens: 15000, fileCount: 2 } },
      hostHealth: { orphanCount: 1, rssGb: 0.8, orphans: [{ pid: 9999, name: 'node.exe', rssMb: 800 }] }
    });
    assert.equal(aqPanel.hidden, false, '#actionQueuePanel must be visible when actions exist');
    const rows = aqPanel.querySelectorAll('.aq-row');
    assert.ok(rows.length >= 1, 'Must render action queue rows');
    assert.ok(aqPanel.textContent.includes('ACTION QUEUE'), 'Must render ACTION QUEUE header');
  });
});
