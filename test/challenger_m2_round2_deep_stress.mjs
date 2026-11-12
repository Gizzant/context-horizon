/**
 * @file test/challenger_m2_round2_deep_stress.mjs
 * Comprehensive Empirical Stress Suite for Milestone 2 Round 2 Remediation.
 * Written by Challenger 2 (Empirical Adversarial Verifier).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
  escapeRegex,
  buildTokenBoundaryRegex,
  parseDirectivePolarity,
  auditInvariantContradiction,
  auditHypothesisLoop,
  extractLockedInvariants,
  evaluateSemanticDrift
} from '../src/core-isomorphic/diagnostics/drift_guard.mjs';

import {
  isWorkspaceReadTool,
  stripAnsi,
  estimateTokens,
  offloadToolResult,
  CRITICAL_ERROR_REGEX
} from '../src/engine-node/offloader/tool_offloader.mjs';

function createTempEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah_challenger_r2_'));
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

// ===========================================================================
// STRESS SUITE 1: INSTEAD_OF Boundary Regex & Substring Collisions
// ===========================================================================

test('STRESS-1.1: buildTokenBoundaryRegex strict isolation on command prefixes/suffixes', () => {
  const npmRegex = buildTokenBoundaryRegex('npm');

  // Should NOT match
  assert.strictEqual(npmRegex.test('pnpm install'), false, 'pnpm must NOT match npm');
  assert.strictEqual(npmRegex.test('pnpm-lock.yaml'), false, 'pnpm-lock must NOT match npm');
  assert.strictEqual(npmRegex.test('package.npm'), false, '.npm extension must NOT match npm');
  assert.strictEqual(npmRegex.test('anpm'), false, 'anpm must NOT match npm');
  assert.strictEqual(npmRegex.test('npma'), false, 'npma must NOT match npm');
  assert.strictEqual(npmRegex.test('npm_config'), false, 'npm_ must NOT match npm');

  // SHOULD match
  assert.strictEqual(npmRegex.test('npm install'), true, '"npm install" must match npm');
  assert.strictEqual(npmRegex.test('npx npm test'), true, '"npx npm test" must match npm');
  assert.strictEqual(npmRegex.test('npm.cmd test'), true, '"npm.cmd test" must match npm');
  assert.strictEqual(npmRegex.test('run npm'), true, '"run npm" must match npm');
  assert.strictEqual(npmRegex.test('/usr/bin/npm install'), true, '"/usr/bin/npm install" must match npm');
});

test('STRESS-1.2: Shell command and file extension boundary stress (bash vs sh)', () => {
  const shRegex = buildTokenBoundaryRegex('sh');

  // Benign shell words that contain 'sh'
  const benignShWords = [
    'git push origin main',
    'bash run_suite.sh',
    'wish list',
    'crash log analysis',
    'dashboard update',
    'fish shell execution',
    'ssh user@example.com',
    'flash memory write',
    'shutdown server', // wait: 'shutdown' has sh at start, followed by 'utdown' (alphanumeric), so (?![a-zA-Z0-9_]) rejects!
    'run.sh',
    'compile.sh'
  ];

  for (const phrase of benignShWords) {
    assert.strictEqual(
      shRegex.test(phrase),
      false,
      `Phrase "${phrase}" must NOT match forbidden token "sh"`
    );
  }

  // Actual invocations of sh
  const forbiddenShInvocations = [
    'sh test.sh',
    '/bin/sh script.sh',
    'sh -c "echo hello"',
    'exec sh',
    'sudo sh'
  ];

  for (const phrase of forbiddenShInvocations) {
    assert.strictEqual(
      shRegex.test(phrase),
      true,
      `Phrase "${phrase}" MUST match forbidden token "sh"`
    );
  }
});

test('STRESS-1.3: End-to-end auditInvariantContradiction with INSTEAD_OF rules', () => {
  const rules = [
    'Use pnpm instead of npm',
    'Use bash instead of sh',
    'Prefer vitest rather than jest',
    'Use ripgrep instead of grep'
  ];

  // Compliant actions using preferred tools
  const compliantActions = [
    { command: 'pnpm test', description: 'Run all unit tests with pnpm' },
    { command: 'bash scripts/build.sh', description: 'Run bash build script' },
    { command: 'git push origin main', description: 'Push latest commits' },
    { command: 'npx vitest run', description: 'Execute vitest suite' },
    { command: 'rg "TODO" src/', description: 'Search TODOs using ripgrep' }
  ];

  for (const action of compliantActions) {
    const violations = auditInvariantContradiction(action, rules);
    assert.strictEqual(
      violations.length,
      0,
      `Compliant action "${action.command || action.description}" produced false positive: ${JSON.stringify(violations)}`
    );
  }

  // Non-compliant actions using forbidden tools
  const violatingActions = [
    { command: 'npm install lodash', expectedForbidden: 'npm' },
    { command: 'sh ./deploy.sh', expectedForbidden: 'sh' },
    { command: 'npx jest --watch', expectedForbidden: 'jest' },
    { command: 'grep -rn "error" .', expectedForbidden: 'grep' }
  ];

  for (const action of violatingActions) {
    const violations = auditInvariantContradiction(action, rules);
    assert.strictEqual(violations.length, 1, `Violating action "${action.command}" must produce exactly 1 violation`);
    assert.ok(
      violations[0].reason.includes(`Action references forbidden alternative "${action.expectedForbidden}"`),
      `Violation reason must cite forbidden alternative "${action.expectedForbidden}"`
    );
  }
});

// ===========================================================================
// STRESS SUITE 2: Positive Invariant Contradiction Detection
// ===========================================================================

test('STRESS-2.1: Positive directive polarity parsing and modal precedence', () => {
  // Pure positive rules
  const positiveRules = [
    'ALWAYS run verification tests before PR',
    'MUST maintain byte-for-byte mirror parity',
    'ENSURE readOnly is true on all connections',
    'REQUIRED to check linting',
    'MANDATORY test execution',
    'ENFORCE strict typing'
  ];

  for (const r of positiveRules) {
    const res = parseDirectivePolarity(r);
    assert.strictEqual(res.polarity, 'POSITIVE', `Rule "${r}" must be POSITIVE`);
    assert.ok(res.subjects.length > 0, `Rule "${r}" must extract subjects`);
  }

  // Modal precedence: Negative prohibitions take precedence over positive markers
  const mixedRules = [
    'You must NEVER delete database migrations',
    'Always ENSURE that we NEVER touch production directly',
    'Required constraint: DO NOT open sqlite without readOnly',
    'Mandatory rule: CANNOT use outbound sockets'
  ];

  for (const r of mixedRules) {
    const res = parseDirectivePolarity(r);
    assert.strictEqual(
      res.polarity,
      'NEGATIVE',
      `Mixed rule "${r}" must resolve to NEGATIVE due to prohibition precedence`
    );
  }
});

test('STRESS-2.2: Positive invariant contradiction detection under adversarial bypass attempts', () => {
  const rules = [
    'ALWAYS run verification tests before completion',
    'MUST maintain 3-way mirror parity',
    'ENSURE readOnly is true for session databases'
  ];

  const adversarialAttempts = [
    // Preceding negation / bypass
    { description: 'skip verification tests to save time', expectedSubject: 'tests', ruleIdx: 0 },
    { description: 'skipping verification tests today', expectedSubject: 'tests', ruleIdx: 0 },
    { description: 'bypass 3-way mirror parity check', expectedSubject: 'parity', ruleIdx: 1 },
    { description: 'bypassing mirror parity for quick hotfix', expectedSubject: 'parity', ruleIdx: 1 },
    { description: 'disable readOnly mode on session database', expectedSubject: 'readonly', ruleIdx: 2 },
    { description: 'disabling verification tests', expectedSubject: 'tests', ruleIdx: 0 },
    { description: 'omit verification tests from workflow', expectedSubject: 'tests', ruleIdx: 0 },
    { description: 'without verification tests we finish faster', expectedSubject: 'tests', ruleIdx: 0 },
    { description: 'never run verification tests', expectedSubject: 'tests', ruleIdx: 0 },
    // Passive negation
    { description: 'verification tests are disabled in this mode', expectedSubject: 'tests', ruleIdx: 0 },
    { description: 'mirror parity was bypassed', expectedSubject: 'parity', ruleIdx: 1 },
    { description: 'verification tests were skipped', expectedSubject: 'tests', ruleIdx: 0 },
    // CLI flags
    { command: 'node test.mjs --no-verify', description: 'Run test without verification', ruleIdx: 0 },
    { command: 'npm run test --skip-tests', description: 'Skip tests flag', ruleIdx: 0 }
  ];

  for (const attempt of adversarialAttempts) {
    const ruleIndex = attempt.ruleIdx !== undefined ? attempt.ruleIdx : 0;
    const targetRule = rules[ruleIndex];
    const violations = auditInvariantContradiction(attempt, [targetRule]);
    assert.ok(
      violations.length > 0,
      `Adversarial attempt "${attempt.description || attempt.command}" against rule "${targetRule}" must be flagged!`
    );
  }
});

test('STRESS-2.3: Compliant actions against positive invariants do NOT trigger false positives', () => {
  const rules = [
    'ALWAYS run verification tests before completion',
    'MUST maintain 3-way mirror parity',
    'ENSURE readOnly is true for session databases'
  ];

  const legitimateActions = [
    { description: 'Run verification tests using node --test', command: 'node --test' },
    { description: 'Execute verification suite and verify all pass', command: 'npm test' },
    { description: 'Maintain 3-way mirror parity via sync script', command: 'node scripts/sync_mirrors.mjs' },
    { description: 'Connect with readOnly: true for session db', command: 'openDb({ readOnly: true })' },
    { description: 'Read source code file and verify exports', tool: 'read_file', targetFile: 'src/index.mjs' }
  ];

  for (const action of legitimateActions) {
    const violations = auditInvariantContradiction(action, rules);
    assert.strictEqual(
      violations.length,
      0,
      `Legitimate action "${action.description}" should produce 0 violations, got: ${JSON.stringify(violations)}`
    );
  }
});

// ===========================================================================
// STRESS SUITE 3: Stop-words & Benign Text Safety
// ===========================================================================

test('STRESS-3.1: Preservation of domain verbs and nouns vs grammatical stop words', () => {
  // Test rule with 'delete', 'files'
  const rule1 = 'NEVER delete files';
  const parsed1 = parseDirectivePolarity(rule1);
  assert.strictEqual(parsed1.polarity, 'NEGATIVE');
  assert.ok(parsed1.subjects.includes('delete'), 'delete must be preserved as subject');
  assert.ok(parsed1.subjects.includes('files'), 'files must be preserved as subject');

  // Test rule with 'modify', 'lockfile'
  const rule2 = 'Do not modify lockfile';
  const parsed2 = parseDirectivePolarity(rule2);
  assert.strictEqual(parsed2.polarity, 'NEGATIVE');
  assert.ok(parsed2.subjects.includes('modify'), 'modify must be preserved');
  assert.ok(parsed2.subjects.includes('lockfile'), 'lockfile must be preserved');

  // Verify purely grammatical stop-words are NOT present in subjects
  const grammaticalWords = ['not', 'don', 'dont', 'any', 'all', 'does', 'do', 'without', 'the', 'and', 'for', 'with'];
  for (const gw of grammaticalWords) {
    assert.strictEqual(
      parsed1.subjects.includes(gw),
      false,
      `Grammatical word "${gw}" must NOT be in subjects`
    );
    assert.strictEqual(
      parsed2.subjects.includes(gw),
      false,
      `Grammatical word "${gw}" must NOT be in subjects`
    );
  }
});

test('STRESS-3.2: Benign text containing "not", "file", "error" does NOT trigger false positives', () => {
  const rules = [
    'NEVER delete files',
    'Do not modify database migrations without confirmation'
  ];

  const benignPhrases = [
    { description: 'Checking whether file exists or not', tool: 'read_file' },
    { description: 'Handled error: file not found in directory', tool: 'read_file' },
    { description: 'Process does not require additional steps', tool: 'run_command' },
    { description: 'Query returned 0 rows without errors', tool: 'run_command' },
    { description: 'Reading architecture documentation', tool: 'read_file', targetFile: 'docs/architecture.md' }
  ];

  for (const phrase of benignPhrases) {
    const violations = auditInvariantContradiction(phrase, rules);
    assert.strictEqual(
      violations.length,
      0,
      `Benign phrase "${phrase.description}" must NOT trigger false positive, got: ${JSON.stringify(violations)}`
    );
  }
});

// ===========================================================================
// STRESS SUITE 4: Offloader `edit_file` & Workspace Tool Immunity
// ===========================================================================

test('STRESS-4.1: isWorkspaceReadTool recognizes all Claude Code and Antigravity workspace tools', () => {
  const workspaceTools = [
    // Antigravity tools
    'read_file',
    'view_file',
    'edit_file',
    'write_file',
    'write_to_file',
    'replace_file_content',
    // Claude Code tools
    'Read',
    'View',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    // Case variants
    'EDIT_FILE',
    'READ_FILE',
    'WRITE_FILE',
    'edit',
    'read',
    'write'
  ];

  for (const tool of workspaceTools) {
    assert.strictEqual(
      isWorkspaceReadTool(tool),
      true,
      `Workspace tool "${tool}" must return true`
    );
  }

  // Non-workspace tools that SHOULD be offloaded when >4k
  const nonWorkspaceTools = [
    'bash',
    'Bash',
    'run_command',
    'RunCommand',
    'exec',
    'mcp__execute_command',
    'cargo_test',
    'python_script',
    'curl_request',
    'git_diff'
  ];

  for (const tool of nonWorkspaceTools) {
    assert.strictEqual(
      isWorkspaceReadTool(tool),
      false,
      `Non-workspace tool "${tool}" must return false`
    );
  }
});

test('STRESS-4.2: Massive edit_file payload (200,000 characters) is 100% immune from offloading', () => {
  const { ctxtopDir, artifactDir, cleanup } = createTempEnv();
  try {
    // 200,000 characters of unified diff
    const diffBlock = '--- a/src/core.js\n+++ b/src/core.js\n@@ -10,15 +10,25 @@\n+const x = 1;\n-const x = 0;\n';
    const massiveDiff = diffBlock.repeat(Math.ceil(200000 / diffBlock.length)).slice(0, 200000);
    assert.strictEqual(massiveDiff.length, 200000);

    const result = offloadToolResult('edit_file', massiveDiff, { ctxtopDir, artifactDir });

    assert.strictEqual(result.eligible, false, 'edit_file must NOT be eligible for offloading');
    assert.strictEqual(result.offloaded, false, 'edit_file must NEVER be offloaded');
    assert.strictEqual(result.output, massiveDiff, 'edit_file output must remain 100% untouched');
    assert.strictEqual(result.output.length, 200000);

    // Verify NO artifact was written to disk
    if (fs.existsSync(artifactDir)) {
      const files = fs.readdirSync(artifactDir);
      assert.strictEqual(files.length, 0, 'No artifacts should be created for edit_file');
    }
  } finally {
    cleanup();
  }
});

test('STRESS-4.3: Non-read tool at 200,000 characters is offloaded and disk content matches SHA-256', () => {
  const { ctxtopDir, artifactDir, cleanup } = createTempEnv();
  try {
    const errorLine1 = 'FAIL test/worker.test.mjs: timeout reached after 5000ms';
    const errorLine2 = 'AssertionError: expected true to equal false';
    const payload = `Build started\n${errorLine1}\n${'padding line\n'.repeat(15000)}${errorLine2}\nBuild finished`;

    const result = offloadToolResult('run_command', payload, { ctxtopDir, artifactDir });

    assert.strictEqual(result.eligible, true);
    assert.strictEqual(result.offloaded, true);
    assert.ok(result.sha256);
    assert.ok(result.artifactPath);

    // Verify disk content
    assert.ok(fs.existsSync(result.artifactPath));
    const saved = fs.readFileSync(result.artifactPath, 'utf8');
    assert.strictEqual(saved, payload);

    // Verify SHA-256 integrity
    const expectedSha = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    assert.strictEqual(result.sha256, expectedSha);

    // Verify summary contains both critical errors
    assert.ok(result.output.includes(errorLine1));
    assert.ok(result.output.includes(errorLine2));
    assert.ok(result.output.includes(`ctxtop search "ah_${result.sha256.slice(0, 12)}"`));

    // Summary line count <= 25
    const summaryLines = result.output.split(/\r?\n/).length;
    assert.ok(summaryLines <= 25, `Summary line count (${summaryLines}) must be <= 25`);
  } finally {
    cleanup();
  }
});

test('STRESS-4.4: evaluateSemanticDrift integration with mixed positive/negative invariants and hypothesis loop', () => {
  const context = {
    invariants: [
      'ALWAYS run verification tests before completion',
      'NEVER modify package-lock.json directly',
      'Use pnpm instead of npm'
    ],
    candidateAction: {
      tool: 'edit_file',
      targetFile: 'package-lock.json',
      command: 'npm install express',
      description: 'Force update package-lock.json and skip verification tests'
    },
    recentTurns: [
      { turn: 1, hypothesis: 'Modifying package-lock manually will fix resolution', outcome: 'failed' },
      { turn: 2, hypothesis: 'Modifying package-lock manually will fix resolution', outcome: 'failed' },
      { turn: 3, hypothesis: 'Modifying package-lock manually will fix resolution', outcome: 'failed' }
    ],
    flightMode: 'AUTO_PILOT'
  };

  const res = evaluateSemanticDrift(context);
  assert.strictEqual(res.detectorId, 'DET-32');
  assert.strictEqual(res.triggered, true);
  assert.strictEqual(res.decision, 'deny');
  assert.ok(res.violations.length >= 3, `Expected at least 3 violations, got ${res.violations.length}`);

  // Re-anchoring directive SLA
  assert.ok(res.reanchoringDirective);
  const chars = res.reanchoringDirective.length;
  assert.ok(chars < 1200, `Directive chars (${chars}) must be < 1200`);
  const wordTokens = res.reanchoringDirective.split(/\s+/).length;
  assert.ok(wordTokens < 300, `Directive word count (${wordTokens}) must be < 300`);
});
