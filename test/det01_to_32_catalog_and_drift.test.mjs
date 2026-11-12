/**
 * @file test/det01_to_32_catalog_and_drift.test.mjs
 * Verification of unified DET-01..32 catalog, DET-21 alias, and DET-32 drift guard (Features 11, 12, 15).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DETECTOR_CATALOG,
  LEGACY_GA_V3_ID_MAP,
  migrateLegacyHorizonConfig,
  resolveDetectorId,
  getDetectorMeta,
  detectors
} from '../src/core-isomorphic/catalog/detectorCatalog.mjs';
import {
  evaluateSemanticDrift,
  parseDirectivePolarity,
  auditInvariantContradiction,
  auditHypothesisLoop
} from '../src/core-isomorphic/diagnostics/drift_guard.mjs';
import {
  normalizeDetectorId,
  resolveDetectorOverride,
  CANONICAL_DETECTOR_IDS
} from '../src/core-isomorphic/config/horizonConfig.mjs';
import {
  THINKING_DRIFT_DETECTOR_ID,
  THINKING_DRIFT_DEPRECATED_ALIAS,
  evaluateThinkingDriftLoop
} from '../src/core-isomorphic/telemetry/sprintMetrics.mjs';

test('catalog: contains all 32 canonical detectors DET-01 through DET-32', () => {
  for (let i = 1; i <= 32; i++) {
    const id = `DET-${String(i).padStart(2, '0')}`;
    const def = detectors.get(id);
    assert.ok(def, `Detector ${id} must exist in catalog`);
    assert.strictEqual(def.id, id);
    assert.ok(def.name, `${id} must have a name`);
    assert.ok(def.primarySlug, `${id} must have a primarySlug`);
    assert.ok(Array.isArray(def.aliases), `${id} must have aliases array`);
    assert.ok(['CRITICAL', 'HIGH', 'WARN', 'MEDIUM', 'INFO'].includes(def.severity), `${id} valid severity`);
    assert.ok(['guard', 'advisory'].includes(def.defaultMode), `${id} valid defaultMode`);
    assert.ok(def.description, `${id} must have a description`);
  }
});

test('catalog: DET-30 is canonical scratchpad loop and DET-21 resolves as deprecated alias', () => {
  // Direct catalog resolution
  assert.strictEqual(resolveDetectorId('DET-21'), 'DET-30');
  assert.strictEqual(resolveDetectorId('DET21'), 'DET-30');
  assert.strictEqual(resolveDetectorId('det-21'), 'DET-30');
  assert.strictEqual(resolveDetectorId('DET-30'), 'DET-30');

  // detectors facade
  assert.ok(detectors.has('DET-21'));
  assert.ok(detectors.has('DET-30'));
  const meta21 = detectors.get('DET-21');
  assert.ok(meta21);
  assert.strictEqual(meta21.id, 'DET-21');
  assert.strictEqual(meta21.aliasOf, 'DET-30');

  // getDetectorMeta
  const meta = getDetectorMeta('DET-21');
  assert.strictEqual(meta.id, 'DET-30');

  // sprintMetrics constants
  assert.strictEqual(THINKING_DRIFT_DETECTOR_ID, 'DET-30');
  assert.strictEqual(THINKING_DRIFT_DEPRECATED_ALIAS, 'DET-21');

  // evaluateThinkingDriftLoop emits DET-30
  const loopResult = evaluateThinkingDriftLoop([
    { thinkingTokens: 5000, visibleOutputTokens: 200, mutatingCalls: 0 },
    { thinkingTokens: 6000, visibleOutputTokens: 200, mutatingCalls: 0 }
  ]);
  assert.strictEqual(loopResult.detectorId, 'DET-30');
  assert.strictEqual(loopResult.triggered, true);
});

test('config normalization: maps DET-21 to DET-30 and resolves overrides', () => {
  assert.strictEqual(normalizeDetectorId('DET-21'), 'DET-30');
  assert.strictEqual(normalizeDetectorId('det-21'), 'DET-30');
  assert.strictEqual(normalizeDetectorId('thinking-drift-loop'), 'DET-30');

  // Resolves config with legacy "DET-21": "off" for DET-30 lookup
  const legacyConfig = {
    detectors: {
      'DET-21': 'off'
    }
  };
  assert.strictEqual(resolveDetectorOverride('DET-30', legacyConfig), 'off');
  assert.strictEqual(resolveDetectorOverride('DET-21', legacyConfig), 'off');
  assert.strictEqual(resolveDetectorOverride('thinking-drift-loop', legacyConfig), 'off');

  // Legacy GA v3 config migration translates numeric IDs and protects Ring-0
  const migratedGa = migrateLegacyHorizonConfig({
    detectorNamespace: 'antigravity',
    detectors: {
      'DET-01': 'off', // GA v3 retry-churn -> canonical DET-04
      'DET-02': 'off', // GA v3 edit-oscillation -> canonical DET-05
      'DET-15': 'off', // GA v3 secret-boundary -> canonical DET-02 (clamped to warn)
      'DET-19': 'off', // GA v3 git-shell-safety -> canonical DET-01 (clamped to warn)
      'DET-21': 'off'  // alias -> DET-30
    }
  });
  assert.strictEqual(migratedGa.detectorNamespace, 'unified-v4');
  assert.strictEqual(migratedGa.detectors['DET-04'], 'off');
  assert.strictEqual(migratedGa.detectors['DET-05'], 'off');
  assert.strictEqual(migratedGa.detectors['DET-02'], 'warn');
  assert.strictEqual(migratedGa.detectors['DET-01'], 'warn');
  assert.strictEqual(migratedGa.detectors['DET-30'], 'off');
  assert.ok(LEGACY_GA_V3_ID_MAP['DET-01'] === 'DET-04');
});

test('drift_guard: parseDirectivePolarity detects POSITIVE, NEGATIVE, and INSTEAD_OF', () => {
  const neg = parseDirectivePolarity('NEVER modify package-lock.json directly');
  assert.strictEqual(neg.polarity, 'NEGATIVE');
  assert.ok(neg.subjects.includes('package-lock.json') || neg.subjects.includes('package'));

  const pos = parseDirectivePolarity('ALWAYS run the verification tests before completion');
  assert.strictEqual(pos.polarity, 'POSITIVE');
  assert.ok(pos.subjects.includes('verification') || pos.subjects.includes('tests'));

  const insteadOf = parseDirectivePolarity('Use pnpm instead of npm for package installs');
  assert.strictEqual(insteadOf.polarity, 'INSTEAD_OF');
  assert.strictEqual(insteadOf.preferred, 'pnpm');
  assert.strictEqual(insteadOf.forbidden, 'npm');
});

test('drift_guard: evaluates invariant contradictions (DET-32)', () => {
  const turnContext = {
    invariants: [
      'NEVER modify package-lock.json directly',
      'Use pnpm instead of npm'
    ],
    candidateAction: {
      tool: 'edit_file',
      targetFile: 'package-lock.json',
      description: 'Updating dependencies in package-lock.json'
    },
    flightMode: 'AUTO_PILOT'
  };

  const result = evaluateSemanticDrift(turnContext);
  assert.strictEqual(result.detectorId, 'DET-32');
  assert.strictEqual(result.triggered, true);
  assert.strictEqual(result.decision, 'deny');
  assert.strictEqual(result.violations.length, 1);
  assert.strictEqual(result.violations[0].type, 'INVARIANT_CONTRADICTION');
  assert.ok(result.reanchoringDirective);
  assert.ok(result.reanchoringDirective.includes('[DET-32 Re-anchoring Directive]'));
});

test('drift_guard: evaluates repeating falsified hypothesis loop (DET-32)', () => {
  const turnContext = {
    recentTurns: [
      { turn: 1, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 2, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' },
      { turn: 3, hypothesis: 'Bug is caused by missing env var', outcome: 'failed' }
    ],
    flightMode: 'COACH'
  };

  const result = evaluateSemanticDrift(turnContext);
  assert.strictEqual(result.detectorId, 'DET-32');
  assert.strictEqual(result.triggered, true);
  assert.strictEqual(result.decision, 'warn');
  assert.strictEqual(result.violations.length, 1);
  assert.strictEqual(result.violations[0].type, 'HYPOTHESIS_LOOP');
  assert.ok(result.reanchoringDirective.includes('Repeated falsified hypothesis') || result.reanchoringDirective.includes('Hypothesis Loop'));
});

test('drift_guard: clean negative pass produces allow without directive', () => {
  const cleanContext = {
    invariants: ['NEVER touch lockfiles'],
    candidateAction: {
      tool: 'read_file',
      targetFile: 'src/core/index.mjs',
      description: 'Reading index file'
    },
    recentTurns: [
      { turn: 1, hypothesis: 'H1', outcome: 'passed' }
    ]
  };

  const result = evaluateSemanticDrift(cleanContext);
  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.decision, 'allow');
  assert.strictEqual(result.reanchoringDirective, null);
});

test('drift_guard: re-anchoring directive is strictly under 300 tokens', () => {
  const triggeredContext = {
    invariants: ['NEVER touch package lockfiles directly'],
    candidateAction: {
      tool: 'edit_file',
      targetFile: 'package-lock.json',
      description: 'Modifying package-lock.json dependencies'
    },
    recentTurns: [
      { turn: 1, hypothesis: 'Failed attempt at fixing lockfile', outcome: 'failed' },
      { turn: 2, hypothesis: 'Failed attempt at fixing lockfile', outcome: 'failed' },
      { turn: 3, hypothesis: 'Failed attempt at fixing lockfile', outcome: 'failed' }
    ]
  };

  const result = evaluateSemanticDrift(triggeredContext);
  assert.strictEqual(result.triggered, true);
  const directive = result.reanchoringDirective;
  // Estimate tokens (~4 chars per token)
  const tokenEstimate = Math.ceil(directive.length / 4);
  assert.ok(tokenEstimate < 300, `Directive token estimate ${tokenEstimate} must be < 300 tokens`);
});

test('drift_guard: token boundary regex prevents substring collisions and file extension false positives', () => {
  const invariants = [
    'Use pnpm instead of npm',
    'Use bash instead of sh',
    'NEVER delete files',
    'Do not touch package.json',
    'ALWAYS run verification tests'
  ];

  // 1. Preferred tool pnpm should NOT collide with npm
  const pnpmAction = { command: 'pnpm install express' };
  assert.deepStrictEqual(auditInvariantContradiction(pnpmAction, invariants), []);

  // 2. bash running run.sh should NOT collide with sh
  const bashAction = { command: 'bash run.sh' };
  assert.deepStrictEqual(auditInvariantContradiction(bashAction, invariants), []);

  // 3. Forbidden tool npm should trigger violation
  const npmAction = { command: 'npm install express' };
  const npmViolations = auditInvariantContradiction(npmAction, invariants);
  assert.strictEqual(npmViolations.length, 1);
  assert.strictEqual(npmViolations[0].rule, 'Use pnpm instead of npm');

  // 4. "NEVER delete files" correctly captures "rm -rf files"
  const deleteAction = { command: 'rm -rf files' };
  const deleteViolations = auditInvariantContradiction(deleteAction, invariants);
  assert.strictEqual(deleteViolations.length, 1);
  assert.strictEqual(deleteViolations[0].rule, 'NEVER delete files');

  // 5. Benign action with "file not found" should NOT trigger violation on "not"
  const benignAction = { description: 'Handling file not found error gracefully' };
  assert.deepStrictEqual(auditInvariantContradiction(benignAction, invariants), []);

  // 6. Action attempting to bypass positive invariant triggers violation
  const skipAction = { description: 'Skip verification tests for faster build' };
  const skipViolations = auditInvariantContradiction(skipAction, invariants);
  assert.strictEqual(skipViolations.length, 1);
  assert.strictEqual(skipViolations[0].rule, 'ALWAYS run verification tests');
});
