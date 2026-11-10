import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SavedQuotaReceiptLedger,
  SAVINGS_EVENT_TYPES
} from '../src/core/coach/saved_quota_ledger.mjs';
import {
  TurnZeroGate,
  optimizeUShapedRulePlacement
} from '../src/core/coach/turn_zero_gate.mjs';
import { HandoffHydrationLauncher } from '../src/core/coach/handoff_hydrator.mjs';
import {
  selectHighestPriorityTier2Card,
  formatFiveMinTtlClock
} from '../src/ui/horizon_panel.js';

test('Phase 4.3: SavedQuotaReceiptLedger records SQLite savings events, formats Status Bar receipt, and exports Markdown table', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-ledger-'));
  try {
    const dbPath = path.join(tmpDir, 'saved_quota_ledger.sqlite');
    let copiedText = '';
    const ledger = new SavedQuotaReceiptLedger({
      dbPath,
      clipboardWriter: (t) => { copiedText = t; }
    });

    // Record 2 Cold Prefills (42k + 42k = 84k), 3 Downshifts (15k + 15k + 16.4k = 46.4k), 1 CLI Compress (12k) -> Total = 142.4k
    ledger.recordSaving({
      sessionId: 'sess-receipt',
      eventType: SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED,
      argonEquivTokensSaved: 42000,
      detail: 'Avoided cold Flash prefill on 68.4k warm Argon cache'
    });
    ledger.recordSaving({
      sessionId: 'sess-receipt',
      eventType: SAVINGS_EVENT_TYPES.COLD_PREFILL_AVOIDED,
      argonEquivTokensSaved: 42000,
      detail: 'Avoided cold Flash prefill on 68.4k warm Argon cache'
    });
    ledger.recordSaving({
      sessionId: 'sess-receipt',
      eventType: SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT,
      argonEquivTokensSaved: 15000,
      detail: 'Downshifted Argon-High to Argon-Low'
    });
    ledger.recordSaving({
      sessionId: 'sess-receipt',
      eventType: SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT,
      argonEquivTokensSaved: 15000,
      detail: 'Downshifted Argon-High to Argon-Low'
    });
    ledger.recordSaving({
      sessionId: 'sess-receipt',
      eventType: SAVINGS_EVENT_TYPES.EFFORT_DOWNSHIFT,
      argonEquivTokensSaved: 16400,
      detail: 'Downshifted Argon-High to Argon-Low'
    });
    const summary = ledger.recordSaving({
      sessionId: 'sess-receipt',
      eventType: SAVINGS_EVENT_TYPES.CLI_DUMP_COMPRESSED,
      argonEquivTokensSaved: 12000,
      detail: 'Compressed pytest stdout dump via FTS5'
    });

    assert.equal(summary.totalArgonEquivTokensSaved, 142400);
    assert.equal(
      summary.statusBarText,
      '$(shield) Horizon: +142.4k Argon-equiv tokens saved (2 Cold Prefills • 3 Downshifts • 1 CLI Compress)'
    );

    const receipt = ledger.copySavingsReceipt('sess-receipt');
    assert.equal(receipt.ok, true);
    assert.ok(copiedText.includes('| Cold Prefills Avoided (`COLD_PREFILL_AVOIDED`) | 2 | +84.0k |'));
    assert.ok(copiedText.includes('| Effort Downshifts (`EFFORT_DOWNSHIFT`) | 3 | +46.4k |'));
    assert.ok(copiedText.includes('| CLI Dumps Compressed (`CLI_DUMP_COMPRESSED`) | 1 | +12.0k |'));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('Phase 4.1: TurnZeroGate enforces Invariant 1 (cachedTokens >= 15000), U-shaped rule placement, and MCP Profiles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-turn0-'));
  try {
    const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
    const lines = [
      '# Workspace Rules',
      'General project overview line 1.',
      'General project overview line 2.',
      'General project overview line 3.',
      'General project overview line 4.',
      '- NEVER mutate prefix files while session KV cache is warm.',
      '- NON-NEGOTIABLE: Always use SQLITE_OPEN_READONLY on host DBs.',
      'General project overview line 7.',
      'General project overview line 8.',
      'General project overview line 9.',
      'General project overview line 10.'
    ];
    const initialText = lines.join('\n');
    fs.writeFileSync(agentsMdPath, initialText, 'utf8');

    const uCurve = optimizeUShapedRulePlacement(initialText);
    assert.equal(uCurve.reordered, true);
    assert.equal(uCurve.strandedCount, 2);
    assert.equal(uCurve.primacyInsertedCount, 1);
    assert.equal(uCurve.recencyInsertedCount, 1);

    const gate = new TurnZeroGate({ workspaceDir: tmpDir });

    // 1. Warm session (cachedTokens = 18000 >= 15000, ttlRemainingSeconds = 240) -> queues mutation without touching AGENTS.md!
    const warmAudit = gate.auditAndOptimizeWorkspaceRules(
      { cachedTokens: 18000, ttlRemainingSeconds: 240, turnCount: 3 },
      { writeChanges: true }
    );
    assert.equal(warmAudit.lockedByInvariant1, true);
    assert.equal(warmAudit.queuedCount, 1);
    assert.equal(fs.readFileSync(agentsMdPath, 'utf8'), initialText, 'AGENTS.md must NOT be modified while KV cache >= 15k is warm');

    // Queue MCP profile change while warm -> also queued
    const mcpWarm = gate.selectMcpProfile('Lean Code', { cachedTokens: 18000, ttlRemainingSeconds: 240 });
    assert.equal(mcpWarm.queued, true);
    assert.equal(mcpWarm.applied, false);

    // 2. Flush on Turn 0 / /handoff -> applies both queued changes immediately
    const flushRes = gate.flushQueuedMutations({ turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0, isHandoff: true });
    assert.equal(flushRes.flushed, true);
    assert.equal(flushRes.flushedCount, 2);
    assert.equal(gate.activeMcpProfile, 'Lean Code');
    assert.notEqual(fs.readFileSync(agentsMdPath, 'utf8'), initialText);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('Phase 4.2: HandoffHydrationLauncher generates docs/HANDOFF_<ts>.md, launches hydrated session, and flags Post-Handoff Amnesia on Turns 1-3', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-handoff-'));
  try {
    const taskMd = [
      '# Task Plan',
      '- [x] Phase 1: Telemetry',
      '- [/] Phase 2: Implement CacheGravityScorer in src/core/coach/task_quota_router.mjs',
      '- [ ] Phase 3: Circuit Breakers'
    ].join('\n');

    const launcher = new HandoffHydrationLauncher({ workspaceDir: tmpDir });
    const bundle = launcher.generateHandoffBundle({
      workspaceDir: tmpDir,
      taskMdContent: taskMd,
      gitDiffSummary: ' src/core/coach/task_quota_router.mjs | 120 +++++++++',
      verifiedSchemaFiles: ['src/core/constants.mjs', 'src/core/paths.mjs'],
      timestamp: '2026-11-09T10-45-00Z'
    });

    assert.equal(fs.existsSync(bundle.handoffAbsPath), true);
    assert.ok(bundle.bootstrapContract.includes('Phase 2: Implement CacheGravityScorer'));
    assert.ok(bundle.bootstrapContract.includes('src/core/constants.mjs'));

    const launchRes = await launcher.launchHydratedSession({
      sessionId: 'hydrated-guid-1234',
      taskMdContent: taskMd
    });
    assert.equal(launchRes.ok, true);
    assert.equal(launchRes.action, 'LAUNCH_HYDRATED_SESSION');

    // Post-Handoff Amnesia Check on Turns 1-3: full-file read of verified schema file flags violation
    const amnesiaCheck = launcher.checkPostHandoffAmnesia([
      {
        toolCalls: [
          { name: 'view_file', args: { Path: 'src/core/constants.mjs' } } // Full-file read of verified file!
        ]
      },
      {
        toolCalls: [
          { name: 'view_file', args: { Path: 'src/core/coach/task_quota_router.mjs', StartLine: 1, EndLine: 60 } } // Ranged read is clean
        ]
      }
    ]);
    assert.equal(amnesiaCheck.amnesiaDetected, true);
    assert.equal(amnesiaCheck.violationCount, 1);
    assert.equal(amnesiaCheck.violations[0].turnNumber, 1);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
});

test('Phase 5: 3-Tier Tufte HUD selects at most 1 priority intervention card in Tier 2 and formats 5m TTL clock', () => {
  assert.equal(formatFiveMinTtlClock(220), '3m 40s');
  assert.equal(formatFiveMinTtlClock(0), '0m 00s');

  // Empty state -> collapsed (null)
  assert.equal(selectHighestPriorityTier2Card({}), null);

  // Multiple competing conditions -> returns strictly the single highest-priority card (DET-03 over Turn-45)
  const card = selectHighestPriorityTier2Card({
    turnCount: 48,
    circuitBreakerAlerts: [
      { detectorId: 'DET-02', filePath: 'src/a.mjs' },
      { detectorId: 'DET-03', filePath: 'test/a.test.mjs', netDeletedCount: 2 }
    ]
  });
  assert.equal(card.cardType, 'DET-03_ASSERT_REVERT');
  assert.equal(card.critical, true);
});

