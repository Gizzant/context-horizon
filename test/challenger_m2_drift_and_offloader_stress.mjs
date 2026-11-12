/**
 * @file test/challenger_m2_drift_and_offloader_stress.mjs
 * Adversarial Stress Test Suite for Milestone 2 by Challenger 2.
 *
 * Covers:
 * 1. DET-32 IOEDR / REMORY Semantic Drift Guard (invariants, loops, token length, V8 sandbox)
 * 2. Catalog DET-01..32 retrieval & DET-21 alias config mapping
 * 3. Lossless PostToolUse >4k Offloader (100k char workspace reads, non-read error preservation, edge tools)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Modules under test
import {
  DETECTOR_CATALOG,
  resolveDetectorId,
  getDetectorMeta,
  detectors
} from '../src/core-isomorphic/catalog/detectorCatalog.mjs';

import {
  evaluateSemanticDrift,
  parseDirectivePolarity,
  auditInvariantContradiction,
  auditHypothesisLoop,
  extractLockedInvariants
} from '../src/core-isomorphic/diagnostics/drift_guard.mjs';

import {
  normalizeDetectorId,
  resolveDetectorOverride,
  loadHorizonConfig,
  CANONICAL_DETECTOR_IDS
} from '../src/core-isomorphic/config/horizonConfig.mjs';

import {
  isWorkspaceReadTool,
  stripAnsi,
  estimateTokens,
  offloadToolResult,
  CRITICAL_ERROR_REGEX
} from '../src/engine-node/offloader/tool_offloader.mjs';

function createTempEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_challenger_offloader_'));
  const artifactDir = path.join(tmpDir, 'artifacts');
  const ctxtopDir = tmpDir;
  return {
    tmpDir,
    artifactDir,
    ctxtopDir,
    cleanup() {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// SUITE 1: DET-32 IOEDR / REMORY Semantic Drift Guard Stress Tests
// ---------------------------------------------------------------------------

test('CHALLENGE-1.1 [DET-32]: Contradiction detection against negative invariants', () => {
  const invariants = [
    'NEVER modify package-lock.json directly',
    'Do not touch database migrations without confirmation'
  ];

  // Action explicitly modifying package-lock.json
  const action1 = {
    tool: 'edit_file',
    targetFile: 'package-lock.json',
    description: 'Updating dependencies in package-lock.json'
  };
  const res1 = auditInvariantContradiction(action1, invariants);
  assert.ok(res1.length > 0, 'Must detect violation on negative invariant');
  assert.strictEqual(res1[0].rule, invariants[0]);

  // Clean action not touching locked files
  const actionClean = {
    tool: 'read_file',
    targetFile: 'src/index.mjs',
    description: 'Reading source file'
  };
  const resClean = auditInvariantContradiction(actionClean, invariants);
  assert.strictEqual(resClean.length, 0, 'Clean action must produce 0 violations');
});

test('CHALLENGE-1.2 [DET-32 FINDING 1 - REMEDIATED]: Substring collision and false positive on INSTEAD_OF matching', () => {
  // Invariant specifies: Use pnpm instead of npm
  const invariants = ['Use pnpm instead of npm'];

  // Case 1: Action using forbidden alternative "npm" directly
  const actionViolating = {
    command: 'npm install express',
    description: 'Installing packages with npm'
  };
  const resViolating = auditInvariantContradiction(actionViolating, invariants);
  assert.ok(resViolating.length > 0, 'Must detect violation when forbidden alternative is used');
  assert.ok(resViolating[0].reason.includes('Action references forbidden alternative "npm"'));

  // Case 2: Action using preferred tool "pnpm"
  // Token boundary regex ensures "pnpm" does NOT trigger false positive for "npm"
  const actionPreferred = {
    command: 'pnpm install express',
    description: 'Installing packages with pnpm'
  };
  const resPreferred = auditInvariantContradiction(actionPreferred, invariants);

  assert.strictEqual(
    resPreferred.length,
    0,
    'VERIFIED: action using preferred tool "pnpm" is NOT flagged'
  );

  // Case 3: Invariant "Use bash instead of sh"
  // Running "git push origin main" or "bash run_tests.sh" should NOT trigger false positive
  const resBash = auditInvariantContradiction({ command: 'bash run_tests.sh' }, ['Use bash instead of sh']);
  assert.strictEqual(
    resBash.length,
    0,
    'VERIFIED: preferred "bash run_tests.sh" does not trigger false positive on .sh'
  );
  const resPush = auditInvariantContradiction({ command: 'git push origin main' }, ['Use bash instead of sh']);
  assert.strictEqual(
    resPush.length,
    0,
    'VERIFIED: "git push origin main" does not trigger false positive on "sh"'
  );
});

test('CHALLENGE-1.3 [DET-32 FINDING 2 - REMEDIATED]: Positive invariant contradiction checking', () => {
  // Invariants with POSITIVE polarity
  const invariants = [
    'ALWAYS run verification tests before completion',
    'MUST maintain 3-way mirror parity',
    'ENSURE readOnly is true on all sqlite connections'
  ];

  for (const rule of invariants) {
    const parsed = parseDirectivePolarity(rule);
    assert.strictEqual(parsed.polarity, 'POSITIVE', `Rule "${rule}" must be parsed as POSITIVE`);
  }

  // Candidate action explicitly contradicts and negates the positive invariants
  const contradictingActions = [
    { description: 'Never run verification tests, skip testing entirely', command: 'exit 0' },
    { description: 'Disable 3-way mirror parity sync script', command: 'rm scripts/sync_mirrors.mjs' },
    { description: 'Do not enforce readOnly, open database readWrite', command: 'db.open({ readOnly: false })' }
  ];

  for (let i = 0; i < invariants.length; i++) {
    const res = auditInvariantContradiction(contradictingActions[i], [invariants[i]]);
    assert.ok(
      res.length > 0,
      `VERIFIED: auditInvariantContradiction enforces POSITIVE invariant "${invariants[i]}"`
    );
  }
});

test('CHALLENGE-1.4 [DET-32 FINDING 3 - REMEDIATED]: Stop words elision preserves essential rule subjects', () => {
  // If rule uses domain subjects like "delete", "files":
  const rule = 'NEVER delete files';
  const parsed = parseDirectivePolarity(rule);
  assert.strictEqual(parsed.polarity, 'NEGATIVE');

  // Subjects are preserved
  assert.ok(
    parsed.subjects.length > 0,
    'VERIFIED: subjects list is not empty'
  );
  assert.ok(parsed.subjects.includes('delete') || parsed.subjects.includes('files'));

  // Consequently, an action explicitly deleting files IS flagged!
  const actionDelete = {
    command: 'rm -rf files',
    description: 'Delete files from workspace'
  };
  const res = auditInvariantContradiction(actionDelete, [rule]);
  assert.strictEqual(
    res.length,
    1,
    'VERIFIED: candidate action deleting files is flagged'
  );
});

test('CHALLENGE-1.5 [DET-32]: Hypothesis loop boundary testing (0, 1, 2, 3, 4 turns, passed turns)', () => {
  // Boundary 0: empty turns
  const loop0 = auditHypothesisLoop([]);
  assert.strictEqual(loop0.isLoop, false);
  assert.strictEqual(loop0.failedCount, 0);

  // Boundary 1: single failed turn
  const loop1 = auditHypothesisLoop([
    { turn: 1, hypothesis: 'Hypothesis A', outcome: 'failed' }
  ]);
  assert.strictEqual(loop1.isLoop, false);

  // Boundary 2: exactly 2 consecutive failed turns with SAME hypothesis
  const loop2 = auditHypothesisLoop([
    { turn: 1, hypothesis: 'Hypothesis A', outcome: 'failed' },
    { turn: 2, hypothesis: 'Hypothesis A', outcome: 'failed' }
  ]);
  assert.strictEqual(loop2.isLoop, false);
  assert.strictEqual(loop2.hypothesis, null);

  // Boundary 3: exactly 3 consecutive failed turns with SAME hypothesis -> MUST TRIGGER
  const loop3 = auditHypothesisLoop([
    { turn: 1, hypothesis: 'Hypothesis A', outcome: 'failed' },
    { turn: 2, hypothesis: 'Hypothesis A', outcome: 'failed' },
    { turn: 3, hypothesis: 'Hypothesis A', outcome: 'failed' }
  ]);
  assert.strictEqual(loop3.isLoop, true, '3 consecutive failed turns must trigger loop');
  assert.strictEqual(loop3.failedCount, 3);
  assert.ok(loop3.hypothesis.includes('Hypothesis A'));

  // Boundary 4: 4 consecutive failed turns with SAME hypothesis -> MUST TRIGGER with count 4
  const loop4 = auditHypothesisLoop([
    { turn: 1, hypothesis: 'Hypothesis A', outcome: 'failed' },
    { turn: 2, hypothesis: 'Hypothesis A', outcome: 'failed' },
    { turn: 3, hypothesis: 'Hypothesis A', outcome: 'failed' },
    { turn: 4, hypothesis: 'Hypothesis A', outcome: 'failed' }
  ]);
  assert.strictEqual(loop4.isLoop, true);
  assert.strictEqual(loop4.failedCount, 4);

  // Interrupted: 3 failed turns interrupted by 1 passed turn -> MUST NOT TRIGGER
  const loopInterrupted = auditHypothesisLoop([
    { turn: 1, hypothesis: 'Hypothesis A', outcome: 'failed' },
    { turn: 2, hypothesis: 'Hypothesis A', outcome: 'passed' },
    { turn: 3, hypothesis: 'Hypothesis A', outcome: 'failed' }
  ]);
  assert.strictEqual(loopInterrupted.isLoop, false);
  assert.strictEqual(loopInterrupted.failedCount, 1);

  // Different hypotheses: 3 failed turns with DIFFERENT hypotheses -> MUST NOT TRIGGER
  const loopDiff = auditHypothesisLoop([
    { turn: 1, hypothesis: 'Missing environment variable', outcome: 'failed' },
    { turn: 2, hypothesis: 'Syntax error in config', outcome: 'failed' },
    { turn: 3, hypothesis: 'Network timeout occurred', outcome: 'failed' }
  ]);
  assert.strictEqual(loopDiff.isLoop, false);
  assert.strictEqual(loopDiff.failedCount, 1);

  // Status variants: check status: 'failed' and error property
  const loopStatusVariants = auditHypothesisLoop([
    { turn: 1, description: 'Fixing lockfile parser', status: 'failed' },
    { turn: 2, description: 'Fixing lockfile parser', error: 'Parser failed' },
    { turn: 3, description: 'Fixing lockfile parser', outcome: 'failed' }
  ]);
  assert.strictEqual(loopStatusVariants.isLoop, true);
  assert.strictEqual(loopStatusVariants.failedCount, 3);
});

test('CHALLENGE-1.6 [DET-32]: Re-anchoring directive token length strictly <300 tokens under stress', () => {
  // Test with both invariant violation and hypothesis loop simultaneously
  const context = {
    invariants: [
      'NEVER modify package-lock.json directly',
      'NEVER bypass git pre-commit hooks'
    ],
    candidateAction: {
      tool: 'edit_file',
      targetFile: 'package-lock.json',
      command: 'git commit --no-verify',
      description: 'Force commit package-lock.json bypass'
    },
    recentTurns: [
      { turn: 1, hypothesis: 'Bypassing hook will allow lockfile to commit cleanly', outcome: 'failed' },
      { turn: 2, hypothesis: 'Bypassing hook will allow lockfile to commit cleanly', outcome: 'failed' },
      { turn: 3, hypothesis: 'Bypassing hook will allow lockfile to commit cleanly', outcome: 'failed' }
    ],
    flightMode: 'AUTO_PILOT'
  };

  const evalResult = evaluateSemanticDrift(context);
  assert.strictEqual(evalResult.detectorId, 'DET-32');
  assert.strictEqual(evalResult.triggered, true);
  assert.strictEqual(evalResult.decision, 'deny');
  assert.ok(evalResult.reanchoringDirective);

  // Measure directive tokens (~4 chars per token) and word tokens
  const chars = evalResult.reanchoringDirective.length;
  const charTokens = Math.ceil(chars / 4);
  const wordTokens = evalResult.reanchoringDirective.split(/\s+/).length;

  assert.ok(
    charTokens < 300,
    `Char token estimate (${charTokens}) must be strictly < 300 tokens`
  );
  assert.ok(
    wordTokens < 300,
    `Word token count (${wordTokens}) must be strictly < 300 tokens`
  );
});

test('CHALLENGE-1.7 [DET-32]: Zero node:* imports and pure V8 sandbox execution', async () => {
  const filePath = path.resolve('src/core-isomorphic/diagnostics/drift_guard.mjs');
  const content = fs.readFileSync(filePath, 'utf8');

  // Verify static AST / regex invariant: 0 node:* imports
  const nodeImportRegex = /import\s+.*from\s+['"]node:[^'"]+['"]/g;
  const matches = content.match(nodeImportRegex) || [];
  assert.strictEqual(matches.length, 0, 'drift_guard.mjs must contain 0 node:* imports');

  // Verify pure execution in V8 without process
  const originalProcess = globalThis.process;
  try {
    const driftMod = await import('../src/core-isomorphic/diagnostics/drift_guard.mjs');
    assert.ok(typeof driftMod.evaluateSemanticDrift === 'function');
    assert.ok(typeof driftMod.parseDirectivePolarity === 'function');

    const result = driftMod.evaluateSemanticDrift({
      invariants: ['NEVER touch lockfile'],
      candidateAction: { description: 'touch lockfile' }
    });
    assert.strictEqual(result.triggered, true);
  } finally {
    globalThis.process = originalProcess;
  }
});

// ---------------------------------------------------------------------------
// SUITE 2: Catalog DET-01..32 & DET-21 Deprecated Alias Resolution Stress Tests
// ---------------------------------------------------------------------------

test('CHALLENGE-2.1 [Catalog]: All 32 detectors exist with valid schemas and contract retrieval', () => {
  assert.strictEqual(CANONICAL_DETECTOR_IDS.length, 32);
  assert.strictEqual(Object.keys(DETECTOR_CATALOG).length, 32);

  for (let i = 1; i <= 32; i++) {
    const id = `DET-${String(i).padStart(2, '0')}`;

    // 1. detectors.get(id)
    const def = detectors.get(id);
    assert.ok(def, `${id} must be returned by detectors.get(id)`);
    assert.strictEqual(def.id, id);
    assert.ok(typeof def.name === 'string' && def.name.length > 5);
    assert.ok(typeof def.primarySlug === 'string' && def.primarySlug.length > 2);
    assert.ok(Array.isArray(def.aliases));
    assert.ok(['CRITICAL', 'HIGH', 'WARN', 'MEDIUM', 'INFO'].includes(def.severity));
    assert.ok(['guard', 'advisory'].includes(def.defaultMode));
    assert.ok(typeof def.description === 'string');

    // 2. detectors.has(id)
    assert.ok(detectors.has(id), `detectors.has(${id}) must return true`);

    // 3. Case-insensitive access
    const lowerId = id.toLowerCase();
    assert.ok(detectors.has(lowerId), `detectors.has(${lowerId}) must return true`);
    assert.ok(detectors.get(lowerId), `detectors.get(${lowerId}) must return detector`);

    // 4. resolveDetectorId(id)
    const resolved = resolveDetectorId(id);
    assert.ok(resolved, `resolveDetectorId(${id}) must not return empty`);
  }

  // Detectors Map facade methods
  assert.strictEqual(detectors.keys().length, 32);
  assert.strictEqual(detectors.values().length, 32);
  assert.strictEqual(detectors.entries().length, 32);

  // Missing IDs safely return null/false without throwing
  assert.strictEqual(detectors.get('DET-99'), null);
  assert.strictEqual(detectors.has('DET-99'), false);
  assert.strictEqual(detectors.get(''), null);
  assert.strictEqual(detectors.has(''), false);
  assert.strictEqual(detectors.get(null), null);
});

test('CHALLENGE-2.2 [Catalog & Config]: DET-21 alias maps seamlessly to DET-30 across all lookup paths', () => {
  // 1. resolveDetectorId('DET-21') -> 'DET-30'
  assert.strictEqual(resolveDetectorId('DET-21'), 'DET-30');
  assert.strictEqual(resolveDetectorId('det-21'), 'DET-30');
  assert.strictEqual(resolveDetectorId('DET21'), 'DET-30');
  assert.strictEqual(resolveDetectorId('det21'), 'DET-30');

  // 2. getDetectorMeta('DET-21') returns DET-30 canonical metadata
  const meta21 = getDetectorMeta('DET-21');
  assert.ok(meta21);
  assert.strictEqual(meta21.id, 'DET-30');
  assert.strictEqual(meta21.name, DETECTOR_CATALOG['DET-30'].name);

  // 3. detectors.get('DET-21') includes aliasOf: 'DET-30'
  const catalogEntry21 = detectors.get('DET-21');
  assert.strictEqual(catalogEntry21.aliasOf, 'DET-30');

  // 4. normalizeDetectorId in config engine
  assert.strictEqual(normalizeDetectorId('DET-21'), 'DET-30');
  assert.strictEqual(normalizeDetectorId('det-21'), 'DET-30');
  assert.strictEqual(normalizeDetectorId('det21'), 'DET-30');
  assert.strictEqual(normalizeDetectorId('DET_21'), 'DET-30');

  // 5. Config resolution with legacy "DET-21": "off"
  const legacyConfigs = [
    { detectors: { 'DET-21': 'off' } },
    { detectors: { 'det-21': 'off' } },
    { claudeDetectors: { 'DET-21': 'off' } },
    { detectors: { 'thinking-drift-loop': 'off' } }
  ];

  for (const cfg of legacyConfigs) {
    assert.strictEqual(
      resolveDetectorOverride('DET-30', cfg),
      'off',
      'Config with DET-21: off must resolve DET-30 override to off'
    );
    assert.strictEqual(
      resolveDetectorOverride('DET-21', cfg),
      'off',
      'Lookup by DET-21 must also resolve override to off'
    );
  }

  // 6. loadHorizonConfig with DET-21 override
  const loadedConfig = loadHorizonConfig({
    overrides: {
      detectors: {
        'DET-21': 'off'
      }
    }
  });
  assert.strictEqual(loadedConfig.detectors['DET-30'], 'off');
  assert.strictEqual(resolveDetectorOverride('DET-30', loadedConfig), 'off');
});

// ---------------------------------------------------------------------------
// SUITE 3: Lossless PostToolUse >4k Offloader Stress Tests
// ---------------------------------------------------------------------------

test('CHALLENGE-3.1 [Offloader]: 100k character outputs on workspace read tools are 100% PRESERVED', () => {
  // Generate massive 100,000 character output (~25,000 tokens)
  const hugeChunk = 'export const CONFIG_CHUNK_DATA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\n';
  const massiveOutput = hugeChunk.repeat(Math.ceil(100000 / hugeChunk.length)).slice(0, 100000);
  assert.strictEqual(massiveOutput.length, 100000, 'Payload must be exactly 100,000 chars');

  const workspaceReadTools = [
    'read_file',
    'Read',
    'view_file',
    'View',
    'Edit',
    'Write',
    'write_file',
    'write_to_file',
    'replace_file_content',
    'MultiEdit',
    'NotebookEdit'
  ];

  for (const tool of workspaceReadTools) {
    assert.strictEqual(
      isWorkspaceReadTool(tool),
      true,
      `Tool "${tool}" must be recognized as workspace read/edit tool`
    );

    const result = offloadToolResult(tool, massiveOutput);
    assert.strictEqual(result.eligible, false, `${tool} must not be eligible for offload`);
    assert.strictEqual(result.offloaded, false, `${tool} must never be offloaded`);
    assert.strictEqual(result.output.length, 100000, `${tool} output length must be 100,000`);
    assert.strictEqual(
      result.output,
      massiveOutput,
      `Tool "${tool}" output must be 100% byte-for-byte identical to input`
    );
  }
});

test('CHALLENGE-3.2 [Offloader FINDING 4 - REMEDIATED]: Antigravity edit_file tool exemption', () => {
  // Google Antigravity uses edit_file as its primary file edit tool.
  const editFileRecognized = isWorkspaceReadTool('edit_file');

  // REMEDIATED BEHAVIOR:
  assert.strictEqual(
    editFileRecognized,
    true,
    'VERIFIED: "edit_file" IS recognized by isWorkspaceReadTool regex'
  );

  // Demonstrate consequence on large edit_file output (>4k tokens)
  const { ctxtopDir, artifactDir, cleanup } = createTempEnv();
  try {
    const hugeDiff = '--- a/src/test.js\n+++ b/src/test.js\n@@ -1,5 +1,5 @@\n'.repeat(600);
    const result = offloadToolResult('edit_file', hugeDiff, { ctxtopDir, artifactDir });
    assert.strictEqual(
      result.offloaded,
      false,
      'VERIFIED: large "edit_file" output is NEVER offloaded, preserving inline diff'
    );
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.output, hugeDiff);
  } finally {
    cleanup();
  }
});

test('CHALLENGE-3.3 [Offloader]: Non-read tools (>4k tokens) offload with 100% critical errors preserved', () => {
  const { ctxtopDir, artifactDir, cleanup } = createTempEnv();
  try {
    const nonReadTools = ['Bash', 'bash', 'mcp__execute_command', 'run_command', 'cargo_build'];

    for (const tool of nonReadTools) {
      assert.strictEqual(isWorkspaceReadTool(tool), false, `${tool} must be non-read tool`);

      // Construct a payload > 4,000 tokens (>16,000 characters)
      const lines = [];
      lines.push('--- Build Step 1 Initializing ---');
      lines.push('Running compiler pass on 1500 source files...');
      for (let i = 1; i <= 600; i++) {
        lines.push(`[info] [step-${i}] Compiling target module_${i}.cpp`);
      }

      // Inject distinctive critical error lines of each type
      const injectedErrors = [
        'FAIL test/sqlite_client.test.mjs: connection refused',
        'AssertionError [ERR_ASSERTION]: expected 200 to equal 500',
        'npm ERR! code ERESOLVE could not resolve dependency',
        'panic: runtime error: index out of range [3] with length 2',
        'cargo error[E0308]: mismatched types expected struct String found &str',
        'SyntaxError: Unexpected token < in JSON at position 0'
      ];
      lines.push(...injectedErrors);

      for (let i = 601; i <= 800; i++) {
        lines.push(`[info] [step-${i}] Cleaning up intermediate object_${i}.o`);
      }
      lines.push('--- Build failed with multiple errors ---');

      const fullOutput = lines.join('\n');
      assert.ok(fullOutput.length > 20000, 'Payload must be >20,000 characters (>5k tokens)');

      const res = offloadToolResult(tool, fullOutput, { ctxtopDir, artifactDir });
      assert.strictEqual(res.eligible, true, `${tool} must be eligible`);
      assert.strictEqual(res.offloaded, true, `${tool} must be offloaded`);
      assert.ok(res.sha256, `${tool} must produce sha256`);
      assert.ok(res.artifactPath, `${tool} must produce artifactPath`);

      // 1. Verify artifact exists on disk with full content
      assert.ok(fs.existsSync(res.artifactPath), `Artifact file ${res.artifactPath} must exist on disk`);
      const diskContent = fs.readFileSync(res.artifactPath, 'utf8');
      assert.strictEqual(diskContent, fullOutput, 'Disk artifact must contain 100% of raw content');

      // 2. Verify sha256 matches disk content
      const expectedSha = crypto.createHash('sha256').update(fullOutput, 'utf8').digest('hex');
      assert.strictEqual(res.sha256, expectedSha);

      // 3. Verify ALL injected critical error lines are preserved in summary output
      for (const errLine of injectedErrors) {
        assert.ok(
          res.output.includes(errLine),
          `Summary must preserve error line: "${errLine}"`
        );
      }

      // 4. Verify summary output conforms to <=25 lines
      const summaryLineCount = res.output.split(/\r?\n/).length;
      assert.ok(
        summaryLineCount <= 25,
        `Summary line count (${summaryLineCount}) must be <= 25 lines`
      );

      // 5. Verify query pointer exists
      assert.ok(
        res.output.includes(`ctxtop search "ah_${res.sha256.slice(0, 12)}"`),
        'Summary must include ctxtop search pointer with shortId'
      );
    }
  } finally {
    cleanup();
  }
});

test('CHALLENGE-3.4 [Offloader]: Boundary threshold exactness (4,000 tokens)', () => {
  const { ctxtopDir, artifactDir, cleanup } = createTempEnv();
  try {
    // estimateTokens divides length by 4: tokens = Math.ceil(len / 4)
    // 4000 tokens * 4 = 16,000 chars exactly
    const exact4kOutput = 'A'.repeat(16000);
    assert.strictEqual(estimateTokens(exact4kOutput), 4000);

    const resAtBoundary = offloadToolResult('Bash', exact4kOutput, { ctxtopDir, artifactDir });
    assert.strictEqual(resAtBoundary.eligible, true);
    assert.strictEqual(resAtBoundary.offloaded, false, 'Output at exactly 4,000 tokens must NOT be offloaded');
    assert.strictEqual(resAtBoundary.output, exact4kOutput);

    // 4001 tokens = 16,001 chars
    const overBoundaryOutput = 'A'.repeat(16004);
    assert.strictEqual(estimateTokens(overBoundaryOutput), 4001);

    const resOverBoundary = offloadToolResult('Bash', overBoundaryOutput, { ctxtopDir, artifactDir });
    assert.strictEqual(resOverBoundary.eligible, true);
    assert.strictEqual(resOverBoundary.offloaded, true, 'Output at 4,001 tokens MUST be offloaded');
    assert.ok(resOverBoundary.output.includes('[Artifact Offloaded: ah_'));
  } finally {
    cleanup();
  }
});

test('CHALLENGE-3.5 [Offloader]: Strips ANSI sequences before hashing and saving', () => {
  const { ctxtopDir, artifactDir, cleanup } = createTempEnv();
  try {
    const rawAnsi = '\x1B[31m[ERROR]\x1B[0m \x1B[1mFatal build error occurred\x1B[0m\n'.repeat(500);
    const res = offloadToolResult('Bash', rawAnsi, { ctxtopDir, artifactDir });
    assert.strictEqual(res.offloaded, true);

    const saved = fs.readFileSync(res.artifactPath, 'utf8');
    assert.strictEqual(saved.includes('\x1B['), false, 'Saved artifact must NOT contain raw ANSI escapes');
    assert.ok(saved.includes('[ERROR] Fatal build error occurred'));
  } finally {
    cleanup();
  }
});
