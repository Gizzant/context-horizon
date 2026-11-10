import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TurnZeroGate,
  upsertFencedCoachBlock,
  pruneExpiredFencedBlocks,
  auditRuleLineCountHygiene
} from '../src/core/coach/turn_zero_gate.mjs';
import {
  PromptDecomposerCoach,
  analyzePromptSprawl
} from '../src/core/coach/prompt_decomposer_coach.mjs';

test('Phase 3 (Feature #17): TurnZeroGate manages 48-hour TTL fenced blocks (COACH & MODEL_ROUTING) and defers pruning while KV cache is warm', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-tzg-fenced-'));
  try {
    const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
    const baseRules = '# Core Rules\n- NEVER render a clickable Copy button for /compact.\n';
    fs.writeFileSync(agentsMdPath, baseRules, 'utf8');

    const gate = new TurnZeroGate({ workspaceDir: tmpDir });
    const t0 = Date.parse('2026-11-09T12:00:00.000Z');

    // 1. Insert COACH block at Turn 0 (cold cache) -> applied immediately
    const coachRes = gate.stageOrApplyFencedBlock(
      {
        targetPath: agentsMdPath,
        blockType: 'COACH',
        bodyText: '- Prefer targeted StartLine/EndLine slices on large HTML files.',
        nowMs: t0
      },
      { turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0 }
    );
    assert.equal(coachRes.mutation.applied, true);

    // 2. Insert MODEL_ROUTING block 24 hours later at Turn 0 -> applied immediately
    const t24h = t0 + 24 * 3600 * 1000;
    const routingRes = gate.stageOrApplyFencedBlock(
      {
        targetPath: agentsMdPath,
        blockType: 'MODEL_ROUTING',
        bodyText: '- Route formatting tasks to Flash Low when quota > 80%.',
        nowMs: t24h
      },
      { turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0 }
    );
    assert.equal(routingRes.mutation.applied, true);

    const contentWithBoth = fs.readFileSync(agentsMdPath, 'utf8');
    assert.ok(contentWithBoth.includes('HORIZON:COACH:START'));
    assert.ok(contentWithBoth.includes('HORIZON:MODEL_ROUTING:START'));

    // 3. Advance time to T + 50 hours (COACH block is expired at 48h, MODEL_ROUTING is only 26h old)
    const t50h = t0 + 50 * 3600 * 1000;

    // Attempt to prune while KV cache is WARM (80,000 tokens, 210s TTL) -> MUST queue and NOT touch disk!
    const warmPrune = gate.pruneExpiredFencedBlocksOnColdCache(
      agentsMdPath,
      { turnCount: 14, cachedTokens: 80000, ttlRemainingSeconds: 210 },
      { nowMs: t50h }
    );
    assert.equal(warmPrune.pruned, true);
    assert.deepEqual(warmPrune.prunedBlockTypes, ['COACH']);
    assert.equal(warmPrune.mutation.applied, false);
    assert.equal(warmPrune.mutation.queued, true);
    assert.equal(warmPrune.mutation.lockedByInvariant1, true);
    assert.ok(
      fs.readFileSync(agentsMdPath, 'utf8').includes('HORIZON:COACH:START'),
      'Disk file must remain untouched while KV cache is warm'
    );

    // 4. Flush queued mutations once cache expires (ttlRemainingSeconds = 0)
    const flushRes = gate.flushQueuedMutations({
      turnCount: 15,
      cachedTokens: 80000,
      ttlRemainingSeconds: 0
    });
    assert.equal(flushRes.flushed, true);
    const afterFlush = fs.readFileSync(agentsMdPath, 'utf8');
    assert.equal(afterFlush.includes('HORIZON:COACH:START'), false, 'Expired 48h COACH block must be pruned');
    assert.equal(
      afterFlush.includes('HORIZON:MODEL_ROUTING:START'),
      true,
      'Unexpired 26h MODEL_ROUTING block must be preserved'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 3 (DET-13): auditRuleLineCountHygiene flags rule files exceeding 200 lines and integrates with auditAndOptimizeWorkspaceRules', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-tzg-lines-'));
  try {
    const bloatedLines = [
      '# Workspace Rules',
      ...Array.from({ length: 110 }, (_, i) => `- Normal guideline ${i + 1}`),
      '- NEVER mutate session SQLite databases in write mode.',
      ...Array.from({ length: 110 }, (_, i) => `- Normal guideline ${i + 111}`)
    ].join('\n');

    const memoryMdPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(memoryMdPath, bloatedLines, 'utf8');

    const lineAudit = auditRuleLineCountHygiene(bloatedLines);
    assert.equal(lineAudit.exceedsCap, true);
    assert.equal(lineAudit.lineCount, 222);
    assert.equal(lineAudit.excessLines, 22);

    const gate = new TurnZeroGate({ workspaceDir: tmpDir });
    const report = gate.auditAndOptimizeWorkspaceRules(
      { turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0 },
      { workspaceDir: tmpDir, writeChanges: true }
    );
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0].reordered, true, 'Must rescue stranded NEVER rule from middle trough');
    assert.equal(report.files[0].lineCapAudit.exceedsCap, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 3 (DET-12): PromptDecomposerCoach provides non-blocking /plan advisory on multi-file mega-prompts', () => {
  const coach = new PromptDecomposerCoach();

  // 1. Concise focused prompt -> not a mega-prompt
  const simpleRes = coach.evaluate('Fix the off-by-one error in src/core/quota.mjs');
  assert.equal(simpleRes.isMegaPrompt, false);
  assert.equal(simpleRes.blocking, false);

  // 2. Multi-objective mega-prompt without /plan -> triggers advisory DET-12
  const megaPrompt = [
    'Please refactor src/core/parser.mjs, migrate src/core/classifier.mjs to use the new schema,',
    'redesign src/webview/horizon_panel.html with a new tab layout, and integrate a new endpoint in',
    'sidecars/horizon-daemon/server.mjs.'
  ].join(' ');

  const megaRes = coach.evaluate(megaPrompt);
  assert.equal(megaRes.isMegaPrompt, true);
  assert.equal(megaRes.detectorId, 'DET-12');
  assert.equal(megaRes.blocking, false, 'Must be strictly advisory and never hard-block');
  assert.equal(megaRes.recommendedSlashCommand, '/plan');
  assert.ok(megaRes.distinctVerbCount >= 3);
  assert.ok(megaRes.targetFileCount >= 4);
  assert.equal(megaRes.decomposedStages.length, 3);

  // 3. Same prompt with /plan already present -> does not re-flag
  const alreadyPlanned = coach.evaluate(`/plan ${megaPrompt}`);
  assert.equal(alreadyPlanned.isMegaPrompt, false);
});
