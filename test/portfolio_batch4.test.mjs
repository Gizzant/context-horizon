import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import {
  CASCADE_COMPACTION_CEILING_TOKENS,
  CASCADE_CHECKPOINT_BANDS,
  evaluateCascadeBatonCheckpoint,
  validateStateBaton
} from '../src/core/coach/progressive_checkpointer.mjs';
import { assessCompactionState } from '../src/core/compaction_coach.mjs';
import { CacheTtlWatchdog } from '../src/core/telemetry/cache_ttl_watchdog.mjs';
import { RsiInstinctEngine, auditPrefixDietAndRouteSkillFault } from '../src/core/rsi_instinct_engine.mjs';
import { TurnZeroGate } from '../src/core/coach/turn_zero_gate.mjs';
import { computeReadOnlyUCurveConversationHeatmap } from '../src/core/u_shaped_optimizer.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('Batch 4 — Rank 4 (DET-17): 70k Cascade Progressive Checkpoints, >96% Premature /compact Suppression & Export Gate', () => {
  it('anchors State Baton snapshots to 70,000-token Cascade bands (14k/25k/35k/45k/56k), suppresses /compact >96% below 50k, and gates docs/HANDOFF_<timestamp>.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-batch4-det17-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), '# git exclude\n', 'utf8');

      assert.equal(CASCADE_COMPACTION_CEILING_TOKENS, 70000);
      assert.deepEqual(
        CASCADE_CHECKPOINT_BANDS.map((b) => b.tokens),
        [14000, 25000, 35000, 45000, 56000]
      );

      const sessionBands = new Map();

      // 1. Negative exemption: 10,000 tokens (<14k 20% band) -> does NOT write state_baton.json or docs/HANDOFF_*.md
      const lowRes = evaluateCascadeBatonCheckpoint(
        {
          sessionId: 'sess-70k',
          currentTokens: 10000,
          cacheHitRatio: 0.98,
          turn: 8,
          flightMode: 'AUTO_PILOT',
          activeGoal: 'Implement Cascade Baton'
        },
        { workspaceDir: tmpDir, sessionBandsMap: sessionBands }
      );
      assert.equal(lowRes.persistedBaton, false);
      assert.equal(lowRes.suppressPrematureCompact, true);
      assert.equal(lowRes.handoffExported, false);

      // Verify CompactionCoach also suppresses premature /compact when hit ratio >96% below 50,000 tokens
      const coachAssess = assessCompactionState({
        totalTokens: 32000,
        cachedTokens: 31200,
        cacheHitRate: 0.975,
        cacheTtlSeconds: 210,
        reclaimableWastePct: 30
      });
      assert.equal(coachAssess.action, 'DEFER_COMPACTION');
      assert.equal(coachAssess.shouldCompact, false);
      assert.equal(coachAssess.suppressPrematureCompact, true);

      // 2. Positive trigger: Crossing 25,000 tokens (20% = 14k and 35% = 25k) persists atomic .agents/cache/state_baton.json
      const midRes = evaluateCascadeBatonCheckpoint(
        {
          sessionId: 'sess-70k',
          currentTokens: 26000,
          cacheHitRatio: 0.97,
          turn: 20,
          flightMode: 'AUTO_PILOT',
          activeGoal: 'Verify 70k Cascade progressive checkpoints',
          workingSetFiles: ['src/core/coach/progressive_checkpointer.mjs'],
          verifiedInvariants: ['Zero outbound network sockets'],
          negativeConstraints: ['NEVER mutate AGENTS.md while cache is warm'],
          deadEnds: ['Avoid writing root task.md']
        },
        { workspaceDir: tmpDir, sessionBandsMap: sessionBands }
      );
      assert.equal(midRes.persistedBaton, true);
      assert.deepEqual(
        midRes.newlyCrossedBands.map((b) => b.label),
        ['20%', '35%']
      );
      assert.equal(fs.existsSync(midRes.stateBatonPath), true);
      const savedBaton = JSON.parse(fs.readFileSync(midRes.stateBatonPath, 'utf8'));
      assert.equal(validateStateBaton(savedBaton).valid, true);
      assert.ok(fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf8').includes('.agents/cache/'));
      // Still Turn 20 (<45) without explicit click -> NO docs/HANDOFF_*.md!
      assert.equal(midRes.handoffExported, false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'docs')), false);

      // 3. Positive trigger: Turn >= 45 in AUTO_PILOT writes docs/HANDOFF_<timestamp>.md
      const turn45Res = evaluateCascadeBatonCheckpoint(
        {
          sessionId: 'sess-70k',
          currentTokens: 57000, // crosses 50%, 65%, 80% (56k)
          cacheHitRatio: 0.91,
          turn: 45,
          flightMode: 'AUTO_PILOT',
          activeGoal: 'Complete long-running session handoff'
        },
        { workspaceDir: tmpDir, sessionBandsMap: sessionBands }
      );
      assert.equal(turn45Res.suppressPrematureCompact, false);
      assert.equal(turn45Res.handoffExported, true);
      assert.ok(turn45Res.handoffPath && fs.existsSync(turn45Res.handoffPath));

      // 4. Positive trigger: Explicit Export Handoff click in COACH at Turn 5 also writes docs/HANDOFF_<timestamp>.md
      const clickRes = evaluateCascadeBatonCheckpoint(
        {
          sessionId: 'sess-coach',
          currentTokens: 15000,
          turn: 5,
          flightMode: 'COACH',
          explicitExportClick: true,
          timestampStamp: '20261111_000500',
          activeGoal: 'Manual export test'
        },
        { workspaceDir: tmpDir }
      );
      assert.equal(clickRes.handoffExported, true);
      assert.ok(clickRes.handoffPath.endsWith('HANDOFF_20261111_000500.md'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 4 — Rank 8 (DET-10): Est. 5m Implicit Cache Watchdog & Cold-Resume Baton Pulse', () => {
  it('labels Est. 5m Implicit Cache (300s), pulses amber + flushes ~300-tok Cold-Resume Baton at T<=45s with >=25k cached + edits, with zero network sockets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-batch4-det10-'));
    try {
      // Verify zero network imports inside cache_ttl_watchdog.mjs
      const watchdogSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'core', 'telemetry', 'cache_ttl_watchdog.mjs'),
        'utf8'
      );
      assert.ok(!/\b(fetch|node:http|node:https|node:net|WebSocket)\b/.test(watchdogSrc));

      // 1. Negative exemption: T = 30s remaining, cachedTokens = 40,000, but workspaceEditsOccurred = false -> NO amber baton flush
      const noEditWatchdog = new CacheTtlWatchdog({
        sessionId: 'sess-no-edits',
        cachedTokens: 40000,
        workspaceEditsOccurred: false,
        workspaceDir: tmpDir
      });
      const noEditStatus = noEditWatchdog.evaluateElapsed(270); // 30s remaining
      assert.equal(noEditStatus.implicitCacheLabel, 'Est. 5m Implicit Cache: 0m 30s');
      assert.equal(noEditStatus.pulseAmber, false);
      assert.equal(noEditStatus.coldResumeBatonFlushed, false);

      // 2. Positive trigger: T = 40s remaining (260s elapsed), cachedTokens = 30,000 (>=25k), workspaceEditsOccurred = true -> pulses amber + flushes ~300-tok Cold-Resume State Baton
      const activeWatchdog = new CacheTtlWatchdog({
        sessionId: 'sess-edited',
        cachedTokens: 30000,
        workspaceEditsOccurred: true,
        workspaceDir: tmpDir,
        batonState: {
          activeGoal: 'Finish Rank 8 Cold-Resume Baton integration',
          workingSetFiles: ['src/core/telemetry/cache_ttl_watchdog.mjs'],
          negativeConstraints: ['Zero network sockets or automated prompt-chaining']
        }
      });
      const pulseStatus = activeWatchdog.evaluateElapsed(260); // 40s remaining
      assert.equal(pulseStatus.implicitCacheLabel, 'Est. 5m Implicit Cache: 0m 40s');
      assert.equal(pulseStatus.pulseAmber, true);
      assert.equal(pulseStatus.coldResumeBatonFlushed, true);
      assert.ok(pulseStatus.coldResumeBatonPath && fs.existsSync(pulseStatus.coldResumeBatonPath));
      assert.ok(pulseStatus.coldResumePrompt.length > 40 && pulseStatus.coldResumePrompt.length <= 1200);
      assert.equal(fs.existsSync(path.join(tmpDir, '.agents', 'cache', 'state_baton.json')), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 4 — Rank 9 (RSI-01): /evolve Prefix Diet, Skill Fault Router, >=5 Instincts Floor & TurnZeroGate Diff Approval', () => {
  it('validates skills/evolve/SKILL.md frontmatter, >8k Prefix Diet extraction, skill-fault routing, >=5 instincts floor, zero recursive subagents, and TurnZeroGate diff gate', () => {
    // 1. Verify skills/evolve/SKILL.md frontmatter matches parent folder name
    const evolveSkillPath = path.join(REPO_ROOT, 'skills', 'evolve', 'SKILL.md');
    assert.equal(fs.existsSync(evolveSkillPath), true);
    const evolveMd = fs.readFileSync(evolveSkillPath, 'utf8');
    assert.match(evolveMd, /^---\r?\nname:\s*evolve\r?\n/);
    assert.ok(!/context-horizon/i.test(evolveMd));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-batch4-rsi01-'));
    try {
      // Create bloated AGENTS.md (> 8,000 tokens = > 32,000 chars) with domain sections
      const bloatedAgents = [
        '# Core Invariants',
        '- NEVER bypass read-only SQLite telemetry.',
        '## GraphQL Resolvers',
        'x'.repeat(18000),
        '## Playwright E2E Suite',
        'y'.repeat(18000)
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), bloatedAgents, 'utf8');

      const gate = new TurnZeroGate({ workspaceDir: tmpDir });
      const engine = new RsiInstinctEngine({
        workspaceDir: tmpDir,
        homeDir: tmpDir,
        dbPath: path.join(tmpDir, 'instincts.db'),
        turnZeroGate: gate
      });

      // 2. Prefix Diet (>8,000 tokens) + <5 instincts negative exemption + unapproved skill fault
      const dietAudit = engine.auditPrefixDietAndRouteSkillFault({
        domain: 'graphql-resolvers',
        validatedDomainInstinctsCount: 3, // < 5 -> cannot synthesize standalone new skill draft
        lastExecutedSkill: 'playwright-e2e',
        userCorrectionText: 'Always await locator.waitFor() before asserting text.',
        userApprovedDiff: false
      });
      assert.equal(dietAudit.prefixBloatExceeded, true);
      assert.ok(dietAudit.proposedExtractions.length >= 2);
      assert.equal(dietAudit.canSynthesizeNewSkillDraft, false);
      assert.equal(dietAudit.routedDeltaTarget, '.agents/skills/playwright-e2e/SKILL.md');
      assert.equal(dietAudit.mutatesGlobalAgentsMdDirectly, false);
      assert.equal(dietAudit.mutation.applied, false);
      assert.equal(dietAudit.mutation.awaitingUserDiffApproval, true);
      assert.ok(dietAudit.unifiedDiff.includes('+++ b/.agents/skills/playwright-e2e/SKILL.md'));

      // 3. Outlaw recursive LLM self-critique subagents even if userApprovedDiff = true
      const recursiveAttempt = auditPrefixDietAndRouteSkillFault(
        {
          workspaceDir: tmpDir,
          domain: 'testing',
          validatedDomainInstinctsCount: 6,
          recursiveSubagentCritique: true,
          userApprovedDiff: true
        },
        { workspaceDir: tmpDir, turnZeroGate: gate }
      );
      assert.equal(recursiveAttempt.recursiveSubagentCritiqueAllowed, false);
      assert.equal(recursiveAttempt.recursiveSubagentRejected, true);
      assert.equal(recursiveAttempt.mutation.applied, false);

      // 4. >= 5 validated instincts + explicit 1-click user diff approval while KV cache is WARM -> queued in TurnZeroGate!
      const warmApproved = engine.auditPrefixDietAndRouteSkillFault({
        domain: 'testing',
        validatedDomainInstinctsCount: 5,
        validatedInstincts: [
          { directive_action: 'Assert exact exitCode in CLI tests' },
          { directive_action: 'Use os.tmpdir() for SQLite fixtures' },
          { directive_action: 'Clean up temp directories in finally blocks' },
          { directive_action: 'Test both positive triggers and negative exemptions' },
          { directive_action: 'Avoid sleep-based flaky timers' }
        ],
        userApprovedDiff: true,
        session: { turnCount: 10, cachedTokens: 60000, ttlRemainingSeconds: 220 }
      });
      assert.equal(warmApproved.canSynthesizeNewSkillDraft, true);
      assert.equal(warmApproved.mutation.applied, false);
      assert.equal(warmApproved.mutation.queued, true);
      assert.equal(warmApproved.mutation.lockedByInvariant1, true);
      assert.equal(fs.existsSync(warmApproved.proposedSkillPath), false, 'Must not write while cache is warm');

      // Flush on Turn 0 / cold cache -> writes SKILL.md atomically!
      const flushed = gate.flushQueuedMutations({ turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0 });
      assert.equal(flushed.flushed, true);
      assert.equal(fs.existsSync(warmApproved.proposedSkillPath), true);
      if (engine.db) engine.db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Batch 4 — HUD Hygiene: Read-Only U-Curve Transcript Heatmap, Vertical 5-Box Simple View & Zero context-horizon Strings', () => {
  it('computes strictly read-only U-curve conversation heatmap, renders Est. 5m Implicit Cache amber pulse in HUD, and keeps Simple View vertical', () => {
    const heatmap = computeReadOnlyUCurveConversationHeatmap([
      { content: 'NEVER mutate AGENTS.md mid-session', tokens: 200 },
      { content: 'Exploring repository files', tokens: 1200 },
      { content: 'MUST preserve exact exit codes', tokens: 400 },
      { content: 'Final verification summary', tokens: 300 }
    ]);
    assert.equal(heatmap.readOnly, true);
    assert.equal(heatmap.mutatesAgentsMd, false);
    assert.equal(heatmap.enforces200LineMemoryCap, false);
    assert.equal(heatmap.totalSteps, 4);
    assert.ok(heatmap.middleTroughCriticalSteps >= 1);

    const htmlPath = path.join(REPO_ROOT, 'src', 'webview', 'horizon_panel.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(!/context-horizon/i.test(html), 'horizon_panel.html must have zero context-horizon strings');
    assert.ok(!/200-line MEMORY\.md/i.test(html), 'horizon_panel.html must not enforce Claude Code 200-line MEMORY.md cap');

    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43210/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.EventSource = class { close() {} };
        win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
      }
    });

    try {
      const { window: w } = dom;
      const d = w.document;
      assert.equal(d.body.getAttribute('data-view-mode'), 'simple');

      // Render warm cache at T=35s (<=45s) with 45,000 cached tokens -> Est. 5m Implicit Cache + amber pulse
      w.renderState({
        schemaVersion: '1.1.0',
        sessionId: 'hud-hygiene-test',
        modelId: 'gemini-4-carbon',
        window: { maxTokens: 1048576, cellSizeTokens: 26214, totalCells: 40, totalActiveTokens: 50000, usedPercentage: 5, turnCount: 6, safeLimit: 179000 },
        tokens: { totalTokens: 50000, maxTokens: 1048576 },
        model: { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', maxTokens: 1048576 },
        metrics: { signalPurityPct: 92, sludgeTokens: 1000, sludgeCostUsd: 0.002 },
        quota: {
          modelLabel: 'Gemini 4 Carbon',
          cache: {
            isCacheCold: false,
            hitRatePct: 95,
            ttlRemainingSec: 35,
            cacheReadTokens: 45000,
            freshInputTokens: 5000,
            inputPricePerMillionUsd: 2.00
          }
        },
        diagnostics: {
          amputationCrisis: false,
          recommendedCommand: '/compact',
          duplicateReads: { count: 0, topFiles: [] },
          deadErrorTraces: { count: 0, totalWastedTokens: 0 },
          staleSnapshots: { count: 0 },
          activeSignal: { taskMdSaved: true, taskMdTurnsBehind: 0 }
        },
        effortAdvisor: {
          mutedByStrikes: false,
          box3Chip: {
            label: '[Downshift: /effort low (-68% output burn, keeps warm cache)]',
            commandText: '/effort low'
          }
        },
        cells: Array.from({ length: 40 }, (_, i) => ({
          index: i,
          dominantCategory: i < 2 ? 'CACHED_HISTORY' : 'FREE_HEADROOM',
          tokens: i < 2 ? 25000 : 0
        })),
        chronicReads: []
      });

      const clockEl = d.getElementById('ttlCountdownClock');
      assert.equal(clockEl.textContent, 'Est. 5m Implicit Cache: 0m 35s');
      assert.ok(clockEl.classList.contains('ttl-warning-pulse'), 'Clock must pulse amber at T<=45s with >=25k cached');

      const box3Chip = d.querySelector('[data-action-id="det08-effort-downshift"]');
      assert.ok(box3Chip, 'Box 3 must render the 1-click DET-08 downshift chip');

      const compactInst = d.getElementById('compactInstruction');
      assert.ok(compactInst.textContent.includes('Type /compact in the chat box and press Enter'));
      assert.ok(d.getElementById('btnCompactPrimary'), 'Must render clickable 1-click Copy /compact button');
    } finally {
      dom.window.close();
    }
  });
});
