import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  WATERMARKS,
  assessCompactionState,
  trimUncachedTail,
  parseTaskChecklist,
  extractFileSignatures,
  generateHandoffMarkdown,
  executeBatonPassHandoff,
  CompactionCoach
} from '../src/core/compaction_coach.mjs';
import { PrefixCacheShield } from '../src/core/prefix_cache_shield.mjs';
import { compressCliOutputFts5 } from '../src/core/fts5_output_compressor.mjs';

function cleanupDir(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (err) {
      if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
    }
  }
}

test('[GATE-2.1] Watermarks & Dual Token + Waste Compaction Rules', () => {
  // 1. Verify Watermarks constants
  assert.equal(WATERMARKS.CASCADE_SYNC, 50000, 'Cascade Sync watermark must be 50k');
  assert.equal(WATERMARKS.AUTO_COMPACT_SAFE, 179000, 'Auto-Compact Safe Limit must be 179k');
  assert.equal(WATERMARKS.BINARY_CLAMP, 256000, 'Binary clamp must be 256k (0x3e800)');
  assert.equal(WATERMARKS.WARM_CACHE_LOCK_MAX_TOKENS, 160000, 'Warm cache lock max threshold must be 160k');
  assert.equal(WATERMARKS.BATON_PASS_TOKEN_TRIGGER, 145000, 'Baton-Pass token trigger must be 145k');

  // 2. Rule 1 (Warm Cache Lock): Hit rate >= 90%, TTL > 60s, Total Tokens < 160k
  const warmSession = {
    totalTokens: 110000,
    cachedTokens: 104500, // ~95% hit rate
    cacheHitRate: 0.95,
    cacheTtlSeconds: 240,
    reclaimableWastePct: 10,
    turnCount: 22,
    activeSignalPct: 90
  };
  const warmResult = assessCompactionState(warmSession);
  assert.equal(warmResult.action, 'DEFER_COMPACTION');
  assert.equal(warmResult.warmCacheLocked, true);
  assert.equal(warmResult.shouldCompact, false);
  assert.equal(warmResult.recommendBatonPass, false);
  assert.ok(warmResult.badge.includes('🛡️ Prefix Cache Warm (95% discount active) — Defer Compaction'));

  // 3. Rule 2 (Dual Token + Waste Trigger): Condition A - Tokens >= 145k
  const highTokenSession = {
    totalTokens: 148000,
    cachedTokens: 60000,
    cacheHitRate: 0.40,
    cacheTtlSeconds: 0,
    reclaimableWastePct: 30,
    turnCount: 30,
    activeSignalPct: 70
  };
  const tokenTriggerResult = assessCompactionState(highTokenSession);
  assert.equal(tokenTriggerResult.action, 'EXECUTE_BATON_PASS');
  assert.equal(tokenTriggerResult.recommendBatonPass, true);
  assert.equal(tokenTriggerResult.triggers.tokenTrigger, true);
  assert.ok(tokenTriggerResult.badge.includes('🤝 Execute Baton Pass (/handoff)'));

  // 4. Rule 2: Condition B - Cold Cache (TTL=0) + Waste >= 45% + Tokens >= 100k
  const wasteSession = {
    totalTokens: 105000,
    cachedTokens: 0,
    cacheHitRate: 0,
    cacheTtlSeconds: 0,
    reclaimableWastePct: 48,
    turnCount: 25,
    activeSignalPct: 52
  };
  const wasteTriggerResult = assessCompactionState(wasteSession);
  assert.equal(wasteTriggerResult.action, 'EXECUTE_BATON_PASS');
  assert.equal(wasteTriggerResult.recommendBatonPass, true);
  assert.equal(wasteTriggerResult.triggers.wasteTrigger, true);

  // 5. Rule 2: Condition C - Turns > 45 && Active Signal < 35%
  const degradedSession = {
    totalTokens: 85000,
    cachedTokens: 20000,
    cacheHitRate: 0.23,
    cacheTtlSeconds: 15,
    reclaimableWastePct: 68,
    turnCount: 52,
    activeSignalPct: 32
  };
  const turnTriggerResult = assessCompactionState(degradedSession);
  assert.equal(turnTriggerResult.action, 'EXECUTE_BATON_PASS');
  assert.equal(turnTriggerResult.recommendBatonPass, true);
  assert.equal(turnTriggerResult.triggers.turnDegradationTrigger, true);

  // 6. Critical Near-Clamp Alarm (>= 179k safe limit)
  const nearClampSession = {
    totalTokens: 182000,
    cachedTokens: 30000,
    cacheHitRate: 0.16,
    cacheTtlSeconds: 0,
    reclaimableWastePct: 40,
    turnCount: 50,
    activeSignalPct: 60
  };
  const nearClampResult = assessCompactionState(nearClampSession);
  assert.equal(nearClampResult.action, 'EXECUTE_BATON_PASS');
  assert.equal(nearClampResult.recommendBatonPass, true);
  assert.equal(nearClampResult.watermarks.clampDistance, 74000);
  assert.ok(nearClampResult.badge.includes('Critical Binary Clamp Risk'));

  // 7. Uncached Tail Sludge recommendation
  const tailSludgeSession = {
    totalTokens: 60000,
    cachedTokens: 45000,
    cacheHitRate: 0.75,
    cacheTtlSeconds: 20,
    reclaimableWastePct: 25,
    reclaimableWasteTokens: 15000,
    turnCount: 18,
    activeSignalPct: 75
  };
  const tailSludgeResult = assessCompactionState(tailSludgeSession);
  assert.equal(tailSludgeResult.action, 'TRIM_UNCACHED_TAIL');
  assert.equal(tailSludgeResult.recommendTailTrim, true);
  assert.ok(tailSludgeResult.badge.includes('✂️ Trim Uncached Tail'));
});

test('[GATE-2.2] Surgical Tail Truncation preserves 50k Warm Cache Prefix 100% Byte-Identical', () => {
  // Construct a synthetic 10-turn session:
  // - Turns 0-3: Cumulative tokens = 50,000 (Head Prefix - MUST REMAIN UNTOUCHED)
  // - Turns 4-8: Cumulative tokens = 75,000 (Uncached Tail - pruned for DET-06 and DET-10)

  const steps = [
    // Turn 0: System prompt & initial task description (Pinned)
    {
      stepIndex: 0,
      totalTokens: 15000,
      content: 'System instructions: Strict zero-trust posture, never modify read-only SQLite DBs.'
    },
    // Turn 1: Primary architecture read (Pinned)
    {
      stepIndex: 1,
      totalTokens: 15000,
      toolCalls: [{ name: 'read_file', args: { Path: 'src/core/parser.mjs' } }],
      content: 'export function parseSessionGenMetadataSync() { ... 15,000 chars of core code ... }'
    },
    // Turn 2: Secondary architecture read (Pinned)
    {
      stepIndex: 2,
      totalTokens: 10000,
      toolCalls: [{ name: 'read_file', args: { Path: 'src/core/quota.mjs' } }],
      content: 'export function calculateQuotaMultiplier() { ... 10,000 chars of core code ... }'
    },
    // Turn 3: Test suite baseline (Pinned, reaches 50,000 tokens cumulative)
    {
      stepIndex: 3,
      totalTokens: 10000,
      toolCalls: [{ name: 'read_file', args: { Path: 'tests/verify_phase_7.mjs' } }],
      content: 'test("baseline tests", () => { ... 10,000 chars ... });'
    },
    // ---- TAIL WATERMARK (Cumulative > 50,000) ----
    // Turn 4: Normal tool edit in tail (Untouched because length < maxRetainedChars + 60)
    {
      stepIndex: 4,
      totalTokens: 500,
      toolCalls: [{ name: 'edit_file', args: { Path: 'src/config.mjs' } }],
      content: 'const PORT = 3000;'
    },
    // Turn 5: DET-06 Redundant read of src/core/parser.mjs in tail (Target for truncation)
    {
      stepIndex: 5,
      totalTokens: 4000,
      toolCalls: [{ name: 'read_file', args: { Path: 'src/core/parser.mjs' } }],
      content: 'REDUNDANT_READ_BODY: '.repeat(200) // 4,200 chars
    },
    // Turn 6: Second redundant read of src/core/parser.mjs in tail (Target for truncation)
    {
      stepIndex: 6,
      totalTokens: 4000,
      toolCalls: [{ name: 'read_file', args: { Path: 'src/core/parser.mjs' } }],
      content: 'REDUNDANT_READ_BODY_2: '.repeat(200) // 4,600 chars
    },
    // Turn 7: DET-10 Unbounded CLI flood (20,000 characters raw test dump)
    {
      stepIndex: 7,
      totalTokens: 6000,
      toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm run test:verbose' } }],
      content: 'FAILED test_something.py\n'.repeat(500) // 12,500 chars, 500 lines
    },
    // Turn 8: Unreferenced search output (>1,200 chars)
    {
      stepIndex: 8,
      totalTokens: 1500,
      toolCalls: [{ name: 'grep', args: { pattern: 'temporaryUnusedSymbol' } }],
      content: 'grep search result line: '.repeat(100) // 2,500 chars
    }
  ];

  // Hash the protected head prefix (Turns 0-3) before trimming
  const headBeforeRaw = JSON.stringify(steps.slice(0, 4));
  const headBeforeHash = crypto.createHash('sha256').update(headBeforeRaw).digest('hex');

  // Execute surgical tail truncation
  const trimResult = trimUncachedTail(steps, {
    cachedTokens: 50000,
    maxRetainedChars: 300
  });

  // Verify head prefix preservation
  assert.equal(trimResult.splitIndex, 4, 'Split index must protect turns 0 through 3 (50k tokens)');
  assert.equal(trimResult.warmCachePreserved, true, 'warmCachePreserved flag must be true');
  assert.equal(trimResult.headBytesPreserved, true, 'headBytesPreserved flag must be true');

  const headAfterRaw = JSON.stringify(trimResult.prunedSteps.slice(0, 4));
  const headAfterHash = crypto.createHash('sha256').update(headAfterRaw).digest('hex');
  assert.equal(headBeforeHash, headAfterHash, 'Head prefix (0..50k) must be 100% byte-for-byte identical');

  // Verify tail steps were surgically truncated
  assert.ok(trimResult.savedTokens > 2000, `Must save significant tokens (saved: ${trimResult.savedTokens})`);
  assert.ok(trimResult.modifiedCount >= 3, `Must modify at least 3 tail offender steps (modified: ${trimResult.modifiedCount})`);

  // Verify DET-06 truncated older superseded read (step 5) while preserving most recent read (step 6) intact (ISS-040)
  const step5Pruned = trimResult.prunedSteps[5];
  assert.equal(step5Pruned.tailSurgeonTruncated, true);
  assert.equal(step5Pruned.tailSurgeonReason, 'DET-06_REDUNDANT_READ');
  assert.ok(step5Pruned.content.includes('[Tail Surgeon (DET-06_REDUNDANT_READ): truncated'));
  assert.ok(step5Pruned.content.length < 500);
  assert.equal(trimResult.prunedSteps[6].tailSurgeonTruncated, undefined);

  // Verify DET-10 truncated in tail
  const step7Pruned = trimResult.prunedSteps[7];
  assert.equal(step7Pruned.tailSurgeonTruncated, true);
  assert.equal(step7Pruned.tailSurgeonReason, 'DET-10_CLI_FLOOD');
  assert.ok(step7Pruned.content.includes('[Tail Surgeon (DET-10_CLI_FLOOD): truncated'));
  assert.ok(step7Pruned.content.length < 500);
});

test('[GATE-2.3] Simulated 165k-Token Session Baton-Pass (/handoff) Execution with Zero Lost Constraints', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-gate2-test-'));
  const fakeHome = path.join(tmpDir, 'home');
  const fakeWorkspace = path.join(tmpDir, 'workspace');
  const fakeBrainBase = path.join(fakeHome, '.gemini', 'antigravity', 'brain');
  const oldSessionGuid = 'session-gate2-old-165k';
  const newSessionGuid = 'session-gate2-new-clean';

  fs.mkdirSync(fakeWorkspace, { recursive: true });
  fs.mkdirSync(path.join(fakeWorkspace, 'docs'), { recursive: true });
  fs.mkdirSync(fakeBrainBase, { recursive: true });

  const oldBrainDir = path.join(fakeBrainBase, oldSessionGuid);
  fs.mkdirSync(oldBrainDir, { recursive: true });

  try {
    // 1. Create active task.md in old brain
    const taskMdContent = `# Attention Horizon Upgrade Task List

## Active Phases
- [x] Phase 0: Core Dispatch Bridge, WAL Hygiene & PrefixCacheShield ([GATE-0])
- [x] Phase 1: Deterministic Circuit Breakers (DET-01..16) & FTS5 Compressor ([GATE-1])
- [/] Phase 2: Cache-Aware Compaction, Tail Surgeon & Baton-Pass (/handoff) ([GATE-2])
- [ ] Phase 3: Bounded Atomic Instinct & Correction Learning Loop ([GATE-3])
- [ ] Phase 4: U-Shaped Attention, Recency Mirror & Rule Hygiene Optimizer ([GATE-4])
- [ ] Phase 5: Task Model & Multi-Tier Quota Router ([GATE-5])
- [ ] Phase 6: UI Integration, End-to-End Verification & Walkthrough ([GATE-6])

## Active Guardrail Pin
- NEVER mutate GEMINI.md or AGENTS.md while Cached History >= 50k.
- NEVER open Antigravity host session databases in write mode.
- NEVER delete or weaken test assertions.
`;
    fs.writeFileSync(path.join(oldBrainDir, 'task.md'), taskMdContent, 'utf8');

    // 2. Create sample source files in fakeWorkspace to verify AST extraction
    fs.mkdirSync(path.join(fakeWorkspace, 'src', 'core'), { recursive: true });
    const sampleModulePath = path.join(fakeWorkspace, 'src', 'core', 'sample_module.mjs');
    fs.writeFileSync(sampleModulePath, `
export function computeHealthScore(metrics) { return 100; }
export async function flushMetricsSync(target) { return true; }
export class HorizonDiagnosticController { constructor() {} }
export const MAX_RETRY_COUNT = 5;
`, 'utf8');

    // 3. Stage a pending rule delta in PrefixCacheShield (simulating mid-session coaching)
    const shield = new PrefixCacheShield({
      homeDir: fakeHome,
      warmCacheThreshold: 50000
    });
    const targetGeminiMd = path.join(fakeWorkspace, 'GEMINI.md');
    fs.writeFileSync(targetGeminiMd, '# Workspace Rules\n- Rule 1: Initial baseline.\n', 'utf8');

    // Stage delta under locked warm cache
    const stageResult = shield.stageOrApplyDelta({
      targetPath: targetGeminiMd,
      operation: 'ADD',
      ruleText: '- MUST run node scripts/sync_mirrors.mjs after editing horizon_panel.html',
      source: 'coach'
    }, { cachedTokens: 85000, cacheTtlSeconds: 180 });
    assert.equal(stageResult.staged, true, 'Rule delta must be staged in PrefixCacheShield queue');

    // 4. Create FTS5 test execution log in tool_logs_fts5.db (simulating Phase 1 verified state)
    const fts5DbPath = path.join(fakeHome, '.gemini', 'antigravity', 'agy-horizon', 'tool_logs_fts5.db');
    await compressCliOutputFts5({
      sessionId: oldSessionGuid,
      turnId: 'turn-42',
      command: 'node --test tests/verify_gate_1.mjs',
      exitCode: 0,
      rawOutput: '✔ [GATE-1.1] All 16 Deterministic Circuit Breakers passed\n✔ [GATE-1.2] FTS5 output compression passed\n'.repeat(50),
      dbPath: fts5DbPath,
      forceCompress: true
    });

    // 5. Construct 165k-token active session state
    const sessionState = {
      sessionId: oldSessionGuid,
      totalTokens: 165000,
      cachedTokens: 48000,
      cacheHitRate: 0.29,
      cacheTtlSeconds: 0,
      turnCount: 46,
      taskMdPath: path.join(oldBrainDir, 'task.md'),
      activeFiles: ['src/core/sample_module.mjs', 'GEMINI.md'],
      negativeConstraints: [
        'DET-01: Blocked write attempt to read-only SQLite session database',
        'DET-03: Blocked deletion of expect() assertions in test suite'
      ],
      detectorViolations: [
        { id: 'DET-06', message: 'Prevented redundant re-read of unchanged parser.mjs' }
      ]
    };

    // 6. Execute Baton Pass (/handoff)
    const coach = new CompactionCoach({
      workspacePath: fakeWorkspace,
      homeDir: fakeHome,
      prefixCacheShield: shield,
      fts5DbPath
    });

    const handoffResult = coach.executeHandoff(sessionState, {
      newSessionId: newSessionGuid,
      brainBaseDir: fakeBrainBase
    });

    // Verify Execution Output
    assert.equal(handoffResult.success, true, 'Handoff execution must succeed');
    assert.equal(handoffResult.newGuid, newSessionGuid, 'Target GUID must match');
    assert.ok(fs.existsSync(handoffResult.handoffFilePath), 'docs/HANDOFF_<timestamp>.md must exist');
    assert.ok(fs.existsSync(handoffResult.horizonHandoffPath), 'Horizon backup handoff file must exist');

    // Read generated handoff markdown
    const handoffMd = fs.readFileSync(handoffResult.handoffFilePath, 'utf8');

    // Verify Section 1: Active Goal (unified ISS-054 State Baton schema)
    assert.ok(handoffMd.includes('## 1. Active Goal'), 'Must contain Section 1');
    assert.ok(handoffMd.includes('- [x] Phase 0: Core Dispatch Bridge'), 'Preserves completed Phase 0');
    assert.ok(handoffMd.includes('- [x] Phase 1: Deterministic Circuit Breakers'), 'Preserves completed Phase 1');
    assert.ok(handoffMd.includes('- [/] Phase 2: Cache-Aware Compaction'), 'Preserves in-progress Phase 2');
    assert.ok(handoffMd.includes('- [ ] Phase 3: Bounded Atomic Instinct'), 'Preserves pending Phase 3');

    // Verify Section 2: Working Set Files & AST Signatures
    assert.ok(handoffMd.includes('## 2. Working Set Files'), 'Must contain Section 2');
    assert.ok(handoffMd.includes('src/core/sample_module.mjs'), 'Must list active sample module');
    assert.ok(handoffMd.includes('computeHealthScore'), 'Must extract computeHealthScore function AST');
    assert.ok(handoffMd.includes('HorizonDiagnosticController'), 'Must extract HorizonDiagnosticController class AST');

    // Verify Section 3: Verified Invariants (from FTS5 index)
    assert.ok(handoffMd.includes('## 3. Verified Invariants'), 'Must contain Section 3');
    assert.ok(handoffMd.includes('node --test tests/verify_gate_1.mjs'), 'Must record last test command');
    assert.ok(handoffMd.includes('PASSED (exit code 0)'), 'Must record passing exit code');

    // Verify Section 4: Dead Ends & Failures to Avoid
    assert.ok(handoffMd.includes('## 4. Dead Ends & Failures to Avoid'), 'Must contain Section 4');
    assert.ok(handoffMd.includes('DET-01: Blocked write attempt to read-only SQLite'), 'Must retain DET-01 constraint');
    assert.ok(handoffMd.includes('DET-03: Blocked deletion of expect() assertions'), 'Must retain DET-03 constraint');

    // Verify Section 5: Queued Cache-Prefix Mutations
    assert.ok(handoffMd.includes('## 5. Queued Cache-Prefix Mutations (Released on PostCompact)'), 'Must contain Section 5');
    assert.ok(handoffMd.includes('MUST run node scripts/sync_mirrors.mjs'), 'Must record staged rule in handoff');

    // Verify Section 6: Exact Next Step
    assert.ok(handoffMd.includes('## 6. Exact Next Step'), 'Must contain Section 6');

    // Verify Active Guardrail Pin
    assert.ok(handoffMd.includes('## Active Guardrail Pin'), 'Must include Active Guardrail Pin');

    // 7. Verify PrefixCacheShield was flushed on handoff
    assert.ok(handoffResult.flushedDeltasCount >= 1, 'PrefixCacheShield staged deltas must be flushed on handoff');
    const flushedGeminiMd = fs.readFileSync(targetGeminiMd, 'utf8');
    assert.ok(
      flushedGeminiMd.includes('MUST run node scripts/sync_mirrors.mjs'),
      'Flushed rule must be written to target file on disk after handoff'
    );

    // 8. Verify pre-seeded <NEW_GUID> brain session directory
    const newBrainDir = path.join(fakeBrainBase, newSessionGuid);
    assert.ok(fs.existsSync(newBrainDir), 'New brain directory must exist');

    const newTaskMd = fs.readFileSync(path.join(newBrainDir, 'task.md'), 'utf8');
    assert.ok(newTaskMd.includes('Preserved Completed Milestones'), 'New task.md must preserve milestones');
    assert.ok(newTaskMd.includes('Phase 0: Core Dispatch Bridge'), 'New task.md must retain completed Phase 0');
    assert.ok(newTaskMd.includes('Active Next Steps & Carried Tasks'), 'New task.md must retain next steps');
    assert.ok(newTaskMd.includes('Phase 2: Cache-Aware Compaction'), 'New task.md must carry over in-progress task');
    assert.ok(newTaskMd.includes('Phase 3: Bounded Atomic Instinct'), 'New task.md must carry over pending tasks');
    assert.ok(newTaskMd.includes('Active Guardrail Pin'), 'New task.md must retain Active Guardrail Pin');

    const newPlanMd = fs.readFileSync(path.join(newBrainDir, 'implementation_plan.md'), 'utf8');
    assert.ok(newPlanMd.includes('Architectural Continuation'), 'New plan must record continuation');
    assert.ok(newPlanMd.includes(handoffResult.handoffFilePath), 'New plan must link to handoff checkpoint');

    console.log('  [PASS] [GATE-2.3] 165k session Baton Pass (/handoff) generated valid artifact, flushed staged rules, and seeded new brain with zero lost constraints');
  } finally {
    cleanupDir(tmpDir);
  }
});
