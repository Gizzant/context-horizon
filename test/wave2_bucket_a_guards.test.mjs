import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateDet01GitAndShellSafety,
  evaluateDet05DiffThrashing,
  CircuitBreakerEngine
} from '../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  evaluateGeminiThinkingTimeoutRisk,
  evaluateActiveDet30StepDown
} from '../src/core-isomorphic/economics/driftLatency.mjs';
import {
  snapshotWorkspaceTestHashes,
  auditClaudeAutoMemory,
  inspectAndSanitizeMultimodalRead
} from '../src/core/shield_manager.mjs';
import { auditAntigravityRulesIntegrity } from '../src/core/layer5_hygiene.mjs';
import { runPreToolUseHook } from '../hooks/handlers/pre-tool-use.mjs';
import { runUserPromptSubmitHook } from '../hooks/handlers/user-prompt-submit.mjs';
import { runCompactLifecycleHook } from '../hooks/handlers/compact-lifecycle.mjs';
import { handlePreInvocation, handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { handleSessionStart } from '../src/hooks/session_start.mjs';
import { runDoctorDiagnostics } from '../src/diagnostics/doctorEngine.mjs';
import { activateLocalTrial } from '../src/core/pro_license.mjs';

test('Wave 2 — Item A2 (#3 TEST_INTEGRITY_LOCK): >=1 net deleted assertion, .skip injection, assertion weakening, EvilGenie git mining & SessionStart test hashes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wave2-a2-'));
  try {
    const testDir = path.join(tmpDir, 'test');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'billing.test.mjs'),
      [
        "import assert from 'node:assert/strict';",
        'export function verifyBilling() {',
        '  assert.strictEqual(1 + 1, 2);',
        '  assert.deepStrictEqual({ ok: true }, { ok: true });',
        '}'
      ].join('\n'),
      'utf8'
    );

    // 1. SessionStart test-hash baseline (<12ms)
    const snap = snapshotWorkspaceTestHashes({ cwd: tmpDir, sessionId: 'sess-a2' });
    assert.equal(snap.fileCount, 1);
    assert.equal(snap.files['test/billing.test.mjs'].assertionCount, 2);
    assert.ok(fs.existsSync(snap.snapshotPath));

    // 2. Single net deleted assertion (1 deleted, 0 added) -> blocked unless user explicitly requested
    const singleStrip = evaluateDet05DiffThrashing({
      filePath: 'test/billing.test.mjs',
      oldText: 'assert.strictEqual(a, 1);\nassert.strictEqual(b, 2);',
      newText: 'assert.strictEqual(a, 1);'
    });
    assert.equal(singleStrip.triggered, true);
    assert.equal(singleStrip.subType, 'TEST_ASSERTION_STRIPPING');

    // Explicit user test intent bypasses lock
    const authorizedStrip = evaluateDet05DiffThrashing({
      filePath: 'test/billing.test.mjs',
      oldText: 'assert.strictEqual(a, 1);\nassert.strictEqual(b, 2);',
      newText: 'assert.strictEqual(a, 1);',
      lastUserInput: 'Please remove the obsolete assertions in billing.test.mjs'
    });
    assert.equal(authorizedStrip.triggered, false);

    // 3. Skip injection (.skip / @pytest.mark.skip) -> blocked
    const skipInject = evaluateDet05DiffThrashing({
      filePath: 'test/billing.test.mjs',
      oldText: "test('calculates quota', () => { expect(x).toBe(1); });",
      newText: "test.skip('calculates quota', () => { expect(x).toBe(1); });"
    });
    assert.equal(skipInject.triggered, true);
    assert.equal(skipInject.subType, 'TEST_SKIP_INJECTION');

    // 4. Assertion weakening (toEqual -> toBeTruthy) -> blocked
    const weakened = evaluateDet05DiffThrashing({
      filePath: 'test/billing.test.mjs',
      oldText: 'expect(result).toEqual({ saved: 42 });',
      newText: 'expect(result).toBeTruthy();'
    });
    assert.equal(weakened.triggered, true);
    assert.equal(weakened.subType, 'TEST_ASSERTION_WEAKENING');

    // 5. EvilGenie .git history mining & shell test file deletion -> blocked
    for (const cmd of [
      'git fsck --full',
      'git cat-file -p HEAD~1',
      'git reflog',
      'git log --all -p',
      'rm test/billing.test.mjs'
    ]) {
      const d01 = evaluateDet01GitAndShellSafety({ toolName: 'Bash', command: cmd });
      assert.equal(d01.triggered, true, `Expected "${cmd}" to trigger DET-01`);
      assert.equal(d01.decision, 'deny');
    }
    // Routine bounded git log remains allowed
    assert.equal(
      evaluateDet01GitAndShellSafety({ toolName: 'Bash', command: 'git log -n 5 --oneline' }).triggered,
      false
    );

    // 6. Antigravity PreToolUse blocks single assertion deletion & EvilGenie git reflog
    const agEditBlock = await handlePreToolUse({
      conversationId: 'ag-wave2-a2',
      cwd: tmpDir,
      flightMode: 'AUTO_PILOT',
      tool_name: 'edit_file',
      tool_input: {
        Path: 'test/billing.test.mjs',
        Target: 'assert.strictEqual(1 + 1, 2);\nassert.deepStrictEqual({ ok: true }, { ok: true });',
        Replacement: 'assert.strictEqual(1 + 1, 2);'
      }
    });
    assert.equal(agEditBlock.blocked, true);
    assert.equal(agEditBlock.detectorId, 'DET-03');

    const agGitBlock = await handlePreToolUse({
      conversationId: 'ag-wave2-a2',
      cwd: tmpDir,
      flightMode: 'COACH',
      tool_name: 'run_command',
      tool_input: { CommandLine: 'git cat-file -p HEAD' }
    });
    assert.equal(agGitBlock.blocked, true);
    assert.equal(agGitBlock.detectorId, 'DET-08');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 2 — Item A5 (#15 MEMORY_RULE_VALIDATOR): Claude MEMORY.md >200 lines / >25KB & Antigravity .agents/rules frontmatter + doctor checks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wave2-a5-'));
  try {
    // 1. Claude MEMORY.md > 200 lines
    const memDir = path.join(tmpDir, 'mem');
    fs.mkdirSync(memDir, { recursive: true });
    const bloatedMem = Array.from({ length: 215 }, (_, i) => `- Memory bullet #${i + 1}`).join('\n');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), bloatedMem, 'utf8');

    const memAudit = auditClaudeAutoMemory({ cwd: tmpDir, memoryDir: memDir });
    assert.equal(memAudit.triggered, true);
    assert.match(memAudit.advisory, /200-line \/ 25KB/);

    const claudeInst = runCompactLifecycleHook(
      { hook_event_name: 'InstructionsLoaded', cwd: tmpDir, memoryDir: memDir },
      { cwd: tmpDir, memoryDir: memDir, checkCapabilities: false }
    );
    assert.equal(claudeInst.exitCode, 0);
    assert.match(claudeInst.stdout, /Auto-Memory Truncation Guard/);

    // 2. Antigravity .agents/rules camelCase keys & nested subdir without rules.json
    const nestedDir = path.join(tmpDir, '.agents', 'rules', 'backend');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents', 'rules', 'style.md'),
      '---\nalwaysOn: true\nglobPattern: "src/**/*.ts"\n---\nUse strict types.\n',
      'utf8'
    );
    fs.writeFileSync(path.join(nestedDir, 'db.md'), 'Open DB read-only.\n', 'utf8');

    const agRules = auditAntigravityRulesIntegrity({ workspacePath: tmpDir });
    assert.equal(agRules.triggered, true);
    assert.equal(agRules.camelCaseFiles.length, 1);
    assert.equal(agRules.nestedUnindexedFiles.length, 1);

    const agStart = await handleSessionStart({
      conversationId: 'ag-wave2-a5',
      workspacePath: tmpDir,
      snapshotTestHashes: false
    });
    assert.match(agStart.systemMessage, /Antigravity Rule Validator/);

    const doc = runDoctorDiagnostics({ cwd: tmpDir, memoryDir: memDir });
    assert.equal(doc.checks.length, 7);
    assert.ok(doc.memoryRuleIntegrity);
    assert.equal(doc.memoryRuleIntegrity.warning, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 2 — Item A6 (#11 THINKING_TIMEOUT_GOV): Gemini timeout-billing audit & active DET-30 runaway step-down gate', async () => {
  // 1. Timeout billing risk: maxOutputTokens + thinkingBudget > 32,768 with timeoutMs < 120,000
  const riskyTimeout = evaluateGeminiThinkingTimeoutRisk({
    modelId: 'gemini-3.1-pro',
    maxOutputTokens: 16384,
    thinkingBudget: 24576,
    timeoutMs: 60000
  });
  assert.equal(riskyTimeout.triggered, true);
  assert.match(riskyTimeout.advisory, /32,768/);

  const safeTimeout = evaluateGeminiThinkingTimeoutRisk({
    modelId: 'gemini-3.1-pro',
    maxOutputTokens: 16384,
    thinkingBudget: 24576,
    timeoutMs: 180000
  });
  assert.equal(safeTimeout.triggered, false);

  // 2. Active DET-30 step-down gate (>4,000 thinking tokens & >12x ratio across >=2 consecutive turns)
  const runawayTurns = [
    { thinkingTokens: 6200, visibleOutputTokens: 200 },
    { thinkingTokens: 7500, visibleOutputTokens: 300 }
  ];
  const stepDownCoach = evaluateActiveDet30StepDown({
    recentTurns: runawayTurns,
    mode: 'COACH'
  });
  assert.equal(stepDownCoach.triggered, true);
  assert.equal(stepDownCoach.decision, 'steer');

  // Claude UserPromptSubmit blocks in AUTO_PILOT
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wave2-a6-home-'));
  try {
    activateLocalTrial({ homeDir: tmpHome });
    const upsBlock = runUserPromptSubmitHook(
      {
        prompt: 'keep going',
        mode: 'AUTO_PILOT',
        recentTurns: runawayTurns
      },
      { persistState: false, mode: 'AUTO_PILOT', homeDir: tmpHome }
    );
    assert.equal(upsBlock.stdoutJson.decision, 'block');
    assert.match(upsBlock.stdoutJson.reason, /DET-30 Thinking Runaway Governor/);

    // Antigravity PreInvocation halts/advises on DET-30 runaway
    const agPre = await handlePreInvocation({
      conversationId: 'ag-wave2-a6',
      prompt: 'continue debugging',
      flightMode: 'AUTO_PILOT',
      homeDir: tmpHome,
      recentTurns: runawayTurns
    });
    assert.equal(agPre.terminationBehavior, 'terminate');
    assert.equal(agPre.detectorId, 'DET-30');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Wave 2 — Item A7 (#12 ERROR_MASKING_LINTER): Standalone empty catch, @ts-ignore, and Python except: pass blocked without deletedAssertions', async () => {
  // 1. Standalone empty catch added with ZERO deleted assertions -> blocked!
  const emptyCatch = evaluateDet05DiffThrashing({
    filePath: 'src/service.ts',
    oldText: 'export function save() {\n  writeDisk();\n}',
    newText: 'export function save() {\n  try { writeDisk(); } cat' + 'ch (e) {}\n}'
  });
  assert.equal(emptyCatch.triggered, true);
  assert.equal(emptyCatch.subType, 'ERROR_MASKING_DIFF');

  // 2. Justified catch comment is allowed (zero false positive)
  const justifiedCatch = evaluateDet05DiffThrashing({
    filePath: 'src/service.ts',
    oldText: 'export function save() {\n  writeDisk();\n}',
    newText: 'export function save() {\n  try { writeDisk(); } cat' + 'ch (e) { // ignore optional cache miss\n  }\n}'
  });
  assert.equal(justifiedCatch.triggered, false);

  // 3. Python multi-line `except Exception:\n    pass` -> blocked!
  const pyPass = evaluateDet05DiffThrashing({
    filePath: 'src/worker.py',
    oldText: 'def run():\n    process_job()\n',
    newText: 'def run():\n    try:\n        process_job()\n    except Exception:\n        pass\n'
  });
  assert.equal(pyPass.triggered, true);
  assert.equal(pyPass.subType, 'ERROR_MASKING_DIFF');

  // 4. @ts-ignore added -> blocked!
  const tsIgnore = evaluateDet05DiffThrashing({
    filePath: 'src/types.ts',
    oldText: 'const x: number = getVal();',
    newText: '// @ts-ignore\nconst x: number = getVal();'
  });
  assert.equal(tsIgnore.triggered, true);
  assert.equal(tsIgnore.subType, 'ERROR_MASKING_DIFF');
});

test('Wave 2 — Item A8 (#14 MULTIMODAL_IPYNB_SANITIZER): Strips >16KB base64 images from .ipynb via updatedInput & blocks un-paged >10-page .pdf', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wave2-a8-'));
  try {
    // 1. Create a notebook with a 24KB base64 PNG output
    const nbPath = path.join(tmpDir, 'analysis.ipynb');
    const bigBase64 = 'A'.repeat(24 * 1024);
    const notebook = {
      cells: [
        {
          cell_type: 'code',
          source: ['import matplotlib.pyplot as plt\n', 'plt.plot([1, 2, 3])\n'],
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'image/png': bigBase64,
                'text/plain': ['<Figure size 640x480>']
              }
            }
          ]
        }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    };
    fs.writeFileSync(nbPath, JSON.stringify(notebook), 'utf8');

    // Claude PreToolUse rewrites updatedInput.file_path to sanitized copy
    const claudeRead = runPreToolUseHook(
      {
        session_id: 'sess-a8',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: nbPath }
      },
      { cwd: tmpDir, persistState: false, recordLedger: false }
    );
    assert.equal(claudeRead.exitCode, 0);
    const parsedOut = JSON.parse(claudeRead.stdout);
    assert.equal(parsedOut.hookSpecificOutput.permissionDecision, 'allow');
    const sanitizedPath = parsedOut.hookSpecificOutput.updatedInput.file_path;
    assert.ok(sanitizedPath.includes('sanitized_analysis.ipynb'));
    assert.ok(fs.existsSync(sanitizedPath));
    const sanitizedNb = JSON.parse(fs.readFileSync(sanitizedPath, 'utf8'));
    assert.equal(sanitizedNb.cells[0].outputs[0].data['image/png'], undefined);
    assert.equal(sanitizedNb.cells[0].source[0], 'import matplotlib.pyplot as plt\n');

    // Antigravity PreToolUse denies raw bloated .ipynb and points to .agents/tmp/sanitized_analysis.ipynb
    const agReadNb = await handlePreToolUse({
      conversationId: 'ag-wave2-a8',
      cwd: tmpDir,
      flightMode: 'COACH',
      tool_name: 'read_file',
      tool_input: { Path: nbPath }
    });
    assert.equal(agReadNb.decision, 'deny');
    assert.ok(agReadNb.sanitizedPath.includes('sanitized_analysis.ipynb'));

    // 2. Create a 14-page synthetic PDF (>10-page cap)
    const pdfPath = path.join(tmpDir, 'spec_manual.pdf');
    const pdfObjects = Array.from({ length: 14 }, (_, i) => `${i + 1} 0 obj << /Type /Page >> endobj`).join('\n');
    fs.writeFileSync(pdfPath, `%PDF-1.7\n${pdfObjects}\n%%EOF`, 'utf8');

    // Un-paged Read -> denied
    const claudePdfDeny = runPreToolUseHook(
      {
        session_id: 'sess-a8',
        cwd: tmpDir,
        tool_name: 'Read',
        tool_input: { file_path: pdfPath }
      },
      { cwd: tmpDir, persistState: false, recordLedger: false }
    );
    const pdfDenyJson = JSON.parse(claudePdfDeny.stdout);
    assert.equal(pdfDenyJson.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(pdfDenyJson.hookSpecificOutput.permissionDecisionReason, /14-page PDF/);

    // Bounded pages: "1-5" -> allowed!
    const pdfBounded = inspectAndSanitizeMultimodalRead({
      platform: 'claude',
      cwd: tmpDir,
      filePath: pdfPath,
      pages: '1-5'
    });
    assert.equal(pdfBounded.action, 'allow');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 2 — Item A9 (#18 WORKTREE_DESTRUCTIVE_GUARD): Blocks un-stashed git checkout/restore & enforces worktree isolation on concurrent write workers', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wave2-a9-'));
  try {
    // 1. Un-stashed working-tree discards blocked; safe branch switches & --staged unstaging allowed
    for (const badCmd of [
      'git checkout -- src/app.ts',
      'git checkout .',
      'git checkout -f main',
      'git restore src/app.ts',
      'git restore .'
    ]) {
      const res = evaluateDet01GitAndShellSafety({ toolName: 'Bash', command: badCmd });
      assert.equal(res.triggered, true, `Expected "${badCmd}" to be blocked`);
      assert.equal(res.subType, 'GIT_UNSTASHED_DISCARD');
    }

    for (const safeCmd of [
      'git checkout feature-branch',
      'git checkout -b feat/new-guard',
      'git restore --staged src/app.ts',
      'git restore -S src/app.ts'
    ]) {
      const res = evaluateDet01GitAndShellSafety({ toolName: 'Bash', command: safeCmd });
      assert.equal(res.triggered, false, `Expected "${safeCmd}" to be allowed`);
    }

    // 2. Claude concurrent write-capable Agent requires isolation: "worktree"
    const engine = new CircuitBreakerEngine({ cwd: tmpDir, mode: 'AUTO_PILOT' });
    const firstWorker = engine.evaluatePreToolUse({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose', run_in_background: true, name: 'worker-1' }
    });
    assert.equal(firstWorker.triggered, false);

    const secondUnisolated = engine.evaluatePreToolUse({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose', run_in_background: true, name: 'worker-2' }
    });
    assert.equal(secondUnisolated.triggered, true);
    assert.equal(secondUnisolated.subType, 'WORKTREE_ISOLATION_REQUIRED');
    assert.equal(secondUnisolated.decision, 'deny');

    const secondIsolated = engine.evaluatePreToolUse({
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'general-purpose',
        isolation: 'worktree',
        run_in_background: true,
        name: 'worker-2'
      }
    });
    assert.equal(secondIsolated.triggered, false);

    // Read-only Explore subagent never requires worktree
    const exploreSub = engine.evaluatePreToolUse({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', run_in_background: true }
    });
    assert.equal(exploreSub.triggered, false);

    // 3. Antigravity concurrent write invoke_subagent requires Workspace: "branch" | "share"
    activateLocalTrial({ homeDir: tmpDir });
    const agBlocked = await handlePreToolUse({
      conversationId: 'ag-wave2-a9',
      cwd: tmpDir,
      homeDir: tmpDir,
      flightMode: 'AUTO_PILOT',
      activeWriteWorkers: 1,
      tool_name: 'invoke_subagent',
      tool_input: { TypeName: 'self', Role: 'Second Writer' }
    });
    assert.equal(agBlocked.blocked, true);
    assert.equal(agBlocked.detectorId, 'DET-20');

    const agIsolated = await handlePreToolUse({
      conversationId: 'ag-wave2-a9',
      cwd: tmpDir,
      homeDir: tmpDir,
      flightMode: 'AUTO_PILOT',
      activeWriteWorkers: 1,
      tool_name: 'invoke_subagent',
      tool_input: { TypeName: 'self', Role: 'Second Writer', Workspace: 'branch' }
    });
    assert.equal(agIsolated.decision, 'allow');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
