import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  RsiInstinctEngine,
  isImmutableRsiTarget,
  assertMutableRsiTarget
} from '../src/core/rsi_instinct_engine.mjs';

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gate3-'));
  const homeDir = path.join(root, 'home');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { root, homeDir, workspaceDir };
}

function cleanupTempEnv(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

test('[GATE-3.1] 5 user corrections in testing domain, confidence progression 0.30 -> 0.90 (>0.80), task.md coach injection, and /evolve SKILL.md synthesis', () => {
  const { root, homeDir, workspaceDir } = makeTempEnv();
  let engine = null;
  try {
    const geminiMdPath = path.join(workspaceDir, 'GEMINI.md');
    fs.writeFileSync(geminiMdPath, '# Workspace Rules\n\n- Keep builds deterministic.\n', 'utf8');

    const taskMdPath = path.join(homeDir, '.gemini', 'antigravity', 'brain', 'guid-gate3', 'task.md');
    fs.mkdirSync(path.dirname(taskMdPath), { recursive: true });
    fs.writeFileSync(taskMdPath, '# Active Task Checklist\n- [ ] Run Phase 3 tests\n', 'utf8');

    let fakeNow = Date.parse('2026-11-09T01:00:00Z');
    engine = new RsiInstinctEngine({
      homeDir,
      workspaceDir,
      nowFn: () => fakeNow
    });

    // Simulate 5 distinct user corrections in the `testing` domain
    const corrections = [
      'No, use node:test instead of vitest in all unit test files.',
      "Don't use snapshot assertions on volatile timestamps in tests.",
      'Always close DatabaseSync handles in a finally block during tests.',
      'Never delete or skip existing assert.equal statements in test suites.',
      'Remember: run verify_phase_7.mjs after modifying core modules.'
    ];

    const createdInstincts = [];
    for (const msg of corrections) {
      const [inst] = engine.observeTurn({
        userMessage: msg,
        domain: 'testing'
      });
      assert.ok(inst, `Should extract instinct from: ${msg}`);
      assert.equal(inst.domain, 'testing');
      assert.equal(Number(inst.confidence.toFixed(2)), 0.30);
      createdInstincts.push(inst);
    }

    assert.equal(createdInstincts.length, 5);

    // Verify deterministic confidence progression on primary instinct:
    // 0.30 -> 0.42 -> 0.54 -> 0.66 -> 0.78 -> 0.90 (crosses >= 0.75 promotion and >= 0.80 gate target)
    const primary = createdInstincts[0];
    const expectedProgression = [0.42, 0.54, 0.66, 0.78, 0.90];
    const actualProgression = [];

    // Warm prefix cache during turns 1..3 so mid-session coaching happens via task.md
    const warmSession = { cachedTokens: 72000, cacheTtlSeconds: 240 };

    for (let i = 0; i < expectedProgression.length; i++) {
      fakeNow += 60_000;
      const updated = engine.recordOutcome(primary.id, {
        passedTests: true,
        userReverted: false,
        session: warmSession,
        targetRulePath: geminiMdPath
      });
      actualProgression.push(Number(updated.confidence.toFixed(2)));
    }

    assert.deepEqual(actualProgression, expectedProgression);

    // Elevate the remaining 4 testing instincts above 0.55 so all 5 cluster for /evolve
    for (let idx = 1; idx < createdInstincts.length; idx++) {
      const inst = createdInstincts[idx];
      engine.recordOutcome(inst.id, { passedTests: true, session: warmSession }); // 0.42
      engine.recordOutcome(inst.id, { passedTests: true, session: warmSession }); // 0.54
      engine.recordOutcome(inst.id, { passedTests: true, session: warmSession }); // 0.66
    }

    // Verify mid-session coaching injection into brain/<GUID>/task.md (<coach_instincts>)
    const coachRes = engine.injectCoachInstinctsIntoTaskMd(taskMdPath);
    assert.equal(coachRes.injectedCount, 5);
    const updatedTaskMd = fs.readFileSync(taskMdPath, 'utf8');
    assert.match(updatedTaskMd, /<coach_instincts>/);
    assert.match(updatedTaskMd, /Always use node:test instead of vitest/);

    // Because warmSession had 72k cachedTokens & TTL=240s, GEMINI.md on disk was protected by PrefixCacheShield
    const shieldStatus = engine.prefixShield.getStatus(warmSession);
    assert.equal(shieldStatus.locked, true);
    assert.ok(shieldStatus.stagedCount >= 1, 'Promoted rule delta should be staged while prefix cache is warm');

    // Verify Domain Clustering surfaces "🧬 5 Instincts Ready to Evolve (/evolve)"
    const clusters = engine.getDomainClusters();
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].domain, 'testing');
    assert.equal(clusters[0].count, 5);
    assert.equal(clusters[0].badge, '🧬 5 Instincts Ready to Evolve (/evolve)');

    // Execute /evolve on cold session (TTL === 0) so SKILL.md and staged rules flush cleanly
    const coldSession = { cachedTokens: 72000, cacheTtlSeconds: 0 };
    const evolveRes = engine.evolveDomainToSkill('testing', { session: coldSession });
    assert.ok(fs.existsSync(evolveRes.skillPath), 'SKILL.md must be created on disk');

    const skillText = fs.readFileSync(evolveRes.skillPath, 'utf8');
    assert.match(skillText, /^---\nname: testing-instincts\ndescription: Evolved Atomic Instincts for the testing domain/);
    assert.match(skillText, /## Mandatory Domain Directives/);
    assert.match(skillText, /Always use node:test instead of vitest/);
  } finally {
    if (engine) engine.close();
    cleanupTempEnv(root);
  }
});

test('[GATE-3.2] Immutable File Boundary List hard-blocks RSI writes to test suites, CI configs, linters, and SQLite DBs', () => {
  assert.equal(isImmutableRsiTarget('tests/verify_gate_3.mjs'), true);
  assert.equal(isImmutableRsiTarget('src/auth/login.spec.ts'), true);
  assert.equal(isImmutableRsiTarget('src/components/Button.test.tsx'), true);
  assert.equal(isImmutableRsiTarget('.github/workflows/ci.yml'), true);
  assert.equal(isImmutableRsiTarget('tsconfig.json'), true);
  assert.equal(isImmutableRsiTarget('.eslintrc.json'), true);
  assert.equal(isImmutableRsiTarget('biome.json'), true);
  assert.equal(isImmutableRsiTarget('~/.gemini/antigravity/agy-horizon/instincts.db'), true);

  assert.equal(isImmutableRsiTarget('GEMINI.md'), false);
  assert.equal(isImmutableRsiTarget('.agents/CONTEXT.md'), false);
  assert.equal(isImmutableRsiTarget('~/.gemini/antigravity/skills/testing-instincts/SKILL.md'), false);

  assert.throws(
    () => assertMutableRsiTarget('tests/unit/foo.test.js'),
    err => err.code === 'IMMUTABLE_FILE_BOUNDARY'
  );
});

test('[GATE-3.3] Downstream test regression (>15% pass-rate drop) triggers automatic Git Rollback Tripwire and quarantines instinct', () => {
  const { root, homeDir, workspaceDir } = makeTempEnv();
  let engine = null;
  try {
    // Initialize a real git repository in workspaceDir to test git commit SHA capture & rollback
    execFileSync('git', ['init'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceDir, stdio: 'ignore' });

    const geminiMdPath = path.join(workspaceDir, 'GEMINI.md');
    const originalGeminiContent = '# Workspace Rules\n\n- Original baseline rule.\n';
    fs.writeFileSync(geminiMdPath, originalGeminiContent, 'utf8');
    execFileSync('git', ['add', 'GEMINI.md'], { cwd: workspaceDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial baseline GEMINI.md'], { cwd: workspaceDir, stdio: 'ignore' });

    engine = new RsiInstinctEngine({
      homeDir,
      workspaceDir
    });

    // Establish 100% baseline rolling test pass rate across 4 turns
    engine.recordTestTurnResult({ passRate: 1.0 });
    engine.recordTestTurnResult({ passRate: 1.0 });
    engine.recordTestTurnResult({ passRate: 1.0 });
    engine.recordTestTurnResult({ passRate: 1.0 });

    // Create and promote a flawed instinct on a cold cache so it immediately mutates GEMINI.md
    const [flawed] = engine.observeTurn({
      userMessage: 'Always mock node:fs globally before importing modules in tests.',
      domain: 'testing'
    });

    const coldSession = { cachedTokens: 0, cacheTtlSeconds: 0 };
    engine.recordOutcome(flawed.id, { passedTests: true, session: coldSession, targetRulePath: geminiMdPath }); // 0.42 (1)
    engine.recordOutcome(flawed.id, { passedTests: true, session: coldSession, targetRulePath: geminiMdPath }); // 0.54 (2)
    engine.recordOutcome(flawed.id, { passedTests: true, session: coldSession, targetRulePath: geminiMdPath }); // 0.66 (3)
    engine.recordOutcome(flawed.id, { passedTests: true, session: coldSession, targetRulePath: geminiMdPath }); // 0.78 (4) -> promoted & flushed!

    const mutatedGeminiContent = fs.readFileSync(geminiMdPath, 'utf8');
    assert.notEqual(mutatedGeminiContent, originalGeminiContent);
    assert.match(mutatedGeminiContent, /ALWAYS mock node:fs globally/i);

    // Simulate a downstream test regression on the 5th turn (rolling 5-turn pass rate drops from 100% to 80%, a 20% drop > 15%)
    const tripwireRes = engine.recordTestTurnResult({ passRate: 0.0 });

    assert.equal(tripwireRes.rolledBack, true, 'Git Rollback Tripwire must fire when rolling pass rate drops > 15%');
    assert.ok(tripwireRes.quarantinedInstincts.includes(flawed.id));

    // Verify GEMINI.md was automatically reverted to its exact pre-mutation content
    const restoredGeminiContent = fs.readFileSync(geminiMdPath, 'utf8');
    assert.equal(restoredGeminiContent, originalGeminiContent);

    // Verify offending instinct is marked quarantined in SQLite
    const afterQuarantine = engine.getInstinctById(flawed.id);
    assert.equal(afterQuarantine.status, 'quarantined');
  } finally {
    if (engine) engine.close();
    cleanupTempEnv(root);
  }
});
