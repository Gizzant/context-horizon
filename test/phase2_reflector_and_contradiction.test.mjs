import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContradictionAuditor,
  auditRuleContradictions,
  auditTestSuiteImmutability
} from '../src/core/coach/contradiction_auditor.mjs';
import {
  ReflectorQueue,
  computeProjectScopeHash,
  evaluateGlobalPromotionEligibility
} from '../src/core/coach/reflector_queue.mjs';
import { RsiInstinctEngine } from '../src/core/rsi_instinct_engine.mjs';

test('Phase 2 (Feature #19): ContradictionAuditor catches polarity inversions, instead-of inversions, and unauthorized test file edits', () => {
  const auditor = new ContradictionAuditor();

  const existingAgentsMd = [
    '# Architectural Rules',
    '- NEVER render a clickable Copy button for /compact.',
    '- Always use pnpm instead of npm for package scripts.',
    '- NEVER use inline styles in webview components.'
  ].join('\n');

  // 1. Direct polarity inversion (POSITIVE vs NEGATIVE)
  const inlineConflict = auditor.auditRule(
    'ALWAYS use inline styles in webview components.',
    existingAgentsMd
  );
  assert.equal(inlineConflict.hasContradiction, true);
  assert.equal(inlineConflict.conflictCount, 1);
  assert.ok(inlineConflict.conflicts[0].overlapTokens.includes('inline'));

  // 2. Inverted "instead of" preference
  const pkgConflict = auditor.auditRule(
    'Always use npm instead of pnpm for package scripts.',
    existingAgentsMd
  );
  assert.equal(pkgConflict.hasContradiction, true);
  assert.ok(pkgConflict.conflicts[0].reason.includes('Inverted preference'));

  // 3. Non-contradictory rule passes cleanly
  const cleanAudit = auditor.auditRule(
    'ALWAYS open SQLite session databases in read-only mode.',
    existingAgentsMd
  );
  assert.equal(cleanAudit.hasContradiction, false);

  // 4. Immutable Evaluation Protection: unauthorized test edit vs authorized test edit
  const unauthorizedTest = auditTestSuiteImmutability({
    modifiedFiles: ['src/core/router.mjs', 'test/router.test.mjs'],
    userPrompt: 'Fix the null pointer bug in router.mjs'
  });
  assert.equal(unauthorizedTest.violated, true);
  assert.deepEqual(unauthorizedTest.unauthorizedTestFiles, ['test/router.test.mjs']);

  const authorizedTest = auditTestSuiteImmutability({
    modifiedFiles: ['src/core/router.mjs', 'test/router.test.mjs'],
    userPrompt: 'Fix the null pointer bug in router.mjs and update unit test assertions'
  });
  assert.equal(authorizedTest.violated, false);
});

test('Phase 2 (DET-16, #16, #18): ReflectorQueue stages learnings in learnings-queue.json, isolates by project_hash, and gates SKILL.md routing on cache cold state', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-reflector-test-'));
  try {
    const hashA = computeProjectScopeHash(path.join(tmpDir, 'repo-a'), {
      gitRemoteUrl: 'https://github.com/org/repo-a.git'
    });
    const hashB = computeProjectScopeHash(path.join(tmpDir, 'repo-b'), {
      gitRemoteUrl: 'https://github.com/org/repo-b.git'
    });
    assert.equal(hashA.length, 12);
    assert.notEqual(hashA, hashB);

    const queuePath = path.join(tmpDir, '.agents', 'cache', 'learnings-queue.json');
    const rqA = new ReflectorQueue({
      workspaceDir: tmpDir,
      projectHash: hashA,
      queuePath
    });

    const existingRules = '- NEVER use var in ESM modules.';

    // 1. Enqueue 3 valid learnings in Repo A and 1 learning in Repo B
    const l1 = rqA.enqueue(
      {
        domain: 'sqlite-telemetry',
        trigger_condition: 'When opening session DBs',
        directive_action: 'ALWAYS open SQLite with readOnly: true',
        confidence: 0.82
      },
      { existingRulesText: existingRules }
    );
    assert.equal(l1.enqueued, true);
    assert.equal(l1.item.project_hash, hashA);

    rqA.enqueue({
      domain: 'sqlite-telemetry',
      trigger_condition: 'When querying transcripts',
      directive_action: 'NEVER run write transactions on host conversation DBs',
      confidence: 0.78
    });
    rqA.enqueue({
      domain: 'sqlite-telemetry',
      trigger_condition: 'When closing connections',
      directive_action: 'ALWAYS close DatabaseSync in a finally block',
      confidence: 0.85
    });

    // Enqueue a contradictory learning -> blocked automatically
    const blocked = rqA.enqueue(
      {
        domain: 'general',
        directive_action: 'ALWAYS use var in ESM modules.'
      },
      { existingRulesText: existingRules }
    );
    assert.equal(blocked.enqueued, false);
    assert.equal(blocked.blockedByContradiction, true);
    assert.equal(blocked.item.status, 'contradiction_blocked');

    // Enqueue a Repo B learning into the same underlying queue file -> must be isolated from Repo A queries
    rqA.enqueue({
      project_hash: hashB,
      domain: 'sqlite-telemetry',
      directive_action: 'Use Postgres connection pooling in Repo B',
      confidence: 0.90
    });

    const repoAStaged = rqA.listItems({ status: 'staged' });
    assert.equal(repoAStaged.length, 3, 'Must isolate Repo A items from Repo B');

    // 2. Attempt to route domain cluster to .agents/skills/ while KV cache is WARM -> deferred!
    const warmRoute = rqA.routeDomainToSkill('sqlite-telemetry', {
      session: { cachedTokens: 65000, ttlRemainingSeconds: 180 }
    });
    assert.equal(warmRoute.routed, false);
    assert.equal(warmRoute.deferredByWarmCache, true);

    // 3. Route domain cluster when KV cache is COLD (TTL = 0) -> writes .agents/skills/<slug>/SKILL.md
    const coldRoute = rqA.routeDomainToSkill('sqlite-telemetry', {
      session: { cachedTokens: 65000, ttlRemainingSeconds: 0 }
    });
    assert.equal(coldRoute.routed, true);
    assert.equal(coldRoute.promotedCount, 3);
    assert.ok(fs.existsSync(coldRoute.skillPath));
    const skillText = fs.readFileSync(coldRoute.skillPath, 'utf8');
    assert.ok(skillText.includes('ALWAYS open SQLite with readOnly: true'));
    assert.ok(skillText.includes(hashA));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 2 (Feature #18 & #19): RsiInstinctEngine enforces ContradictionAuditor on promotion and evaluates multi-repo global promotion (>= 0.80 across >= 2 repos)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-rsi-p2-'));
  try {
    const dbPath = path.join(tmpDir, 'instincts.db');
    const engine = new RsiInstinctEngine({
      homeDir: tmpDir,
      workspaceDir: tmpDir,
      dbPath,
      projectHash: 'repo_alpha_01'
    });

    // 1. Observe same instinct across 2 distinct project_hash repositories with confidence >= 0.80
    engine.observeTurn({
      projectHash: 'repo_alpha_01',
      domain: 'git-workflow',
      userMessage: 'Always use ; instead of && in PowerShell commands',
      initialConfidence: 0.84
    });
    engine.observeTurn({
      projectHash: 'repo_beta_02',
      domain: 'git-workflow',
      userMessage: 'Always use ; instead of && in PowerShell commands',
      initialConfidence: 0.88
    });
    // Single-repo high confidence instinct (should NOT qualify for global promotion yet)
    engine.observeTurn({
      projectHash: 'repo_alpha_01',
      domain: 'ui-styling',
      userMessage: 'Never use neon gradients on status pills',
      initialConfidence: 0.92
    });

    const globalCandidates = engine.getGlobalPromotionCandidates();
    assert.equal(globalCandidates.length, 1);
    assert.equal(globalCandidates[0].domain, 'git-workflow');
    assert.equal(globalCandidates[0].distinctRepoCount, 2);
    assert.ok(globalCandidates[0].avgConfidence >= 0.80);

    // 2. Contradiction blocking inside promoteInstinctToRule
    const targetGeminiMd = path.join(tmpDir, 'GEMINI.md');
    fs.writeFileSync(
      targetGeminiMd,
      '# Workspace Rules\n- NEVER use default exports in core modules.\n',
      'utf8'
    );

    const [badInstinct] = engine.observeTurn({
      projectHash: 'repo_alpha_01',
      domain: 'general',
      userMessage: 'Always use default exports in core modules',
      initialConfidence: 0.80
    });

    const promoRes = engine.promoteInstinctToRule(badInstinct, {
      targetPath: targetGeminiMd,
      session: { cachedTokens: 0, cacheTtlSeconds: 0 }
    });

    assert.equal(promoRes.contradictionBlocked, true);
    assert.equal(promoRes.contradictionAudit.hasContradiction, true);
    const updatedInst = engine.getInstinctById(badInstinct.id);
    assert.equal(updatedInst.status, 'quarantined', 'Contradictory instinct must be quarantined');

    engine.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
