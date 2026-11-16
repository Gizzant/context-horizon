import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  snapshotTestSuiteBaseline,
  recordStepOutcome,
  buildContrastiveDigest
} from '../src/core/rsl_triage.mjs';
import { distillContrastiveDigest, buildGlobPatterns } from '../src/core/rsl_distiller.mjs';
import {
  readRslLedger,
  getRslSummary,
  adjustHeuristicImportance,
  rewriteAntigravityReferences,
  rewriteClaudeReferences
} from '../src/core/rsl_ledger.mjs';
import { handleAntigravityRslHook, syncAntigravityWorkspaceRslHooks } from '../src/hooks/antigravity_rsl_hook.mjs';
import { handleClaudeRslHook, syncClaudeWorkspaceRslHooks } from '../src/hooks/claude_rsl_hook.mjs';
import { validateAntigravityHooksSchema } from '../src/core/layer5_hygiene.mjs';
import { runCli } from '../bin/ctxtop.mjs';
import { executeStatusLineBridge } from '../bin/ah-statusline.mjs';
import { renderStatusLine, formatRslStatusSegment } from '../src/core-isomorphic/ui/modViews.mjs';

function makeTmpWorkspace(prefix = 'ctxtop-rsl-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (cleanupErr) {
    assert.ok(cleanupErr instanceof Error);
  }
}

describe('Dual-Platform Highbeam RSL Engine (Antigravity + Claude Code)', () => {
  test('1. Antigravity ingestion: ignores Stop when fullyIdle===false and extracts contrastive + artifact supervision when fullyIdle===true', () => {
    const ws = makeTmpWorkspace('ctxtop-rsl-ag-');
    const artifactDir = path.join(ws, '.mock_artifacts');
    fs.mkdirSync(path.join(ws, 'test'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.mkdirSync(artifactDir, { recursive: true });

    fs.writeFileSync(
      path.join(ws, 'test', 'sample.test.mjs'),
      'import assert from "node:assert/strict";\nassert.equal(1 + 1, 2);\nassert.ok(true);\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(artifactDir, 'implementation_plan.md'),
      '# Plan\n✗ rejected: Do not import @[schema](src/db/schema.ts) synchronously on startup.\n💬 Always use lazy loader in src/db/loader.ts instead.\n',
      'utf8'
    );

    try {
      const convId = 'ag-conv-1';
      const startRes = handleAntigravityRslHook(
        {
          hookEventName: 'SessionStart',
          conversationId: convId,
          workspacePaths: [ws],
          artifactDirectoryPath: artifactDir
        },
        { event: 'SessionStart' }
      );
      assert.deepEqual(startRes.stdoutJson, {});
      assert.ok(fs.existsSync(path.join(ws, '.agents', 'telemetry', `${convId}.test_hashes.json`)));

      // Step 0 fails, Step 1 recovers on same file, Step 2 runs passing test
      handleAntigravityRslHook({
        hookEventName: 'PostToolUse',
        conversationId: convId,
        workspacePaths: [ws],
        stepIdx: 0,
        toolCall: { name: 'edit_file', args: { TargetFile: path.join(ws, 'src', 'app.ts') } },
        error: 'Cannot find module src/db/schema.ts without .js extension'
      });
      handleAntigravityRslHook({
        hookEventName: 'PostToolUse',
        conversationId: convId,
        workspacePaths: [ws],
        stepIdx: 1,
        toolCall: { name: 'edit_file', args: { TargetFile: path.join(ws, 'src', 'app.ts') } },
        error: ''
      });
      handleAntigravityRslHook({
        hookEventName: 'PostToolUse',
        conversationId: convId,
        workspacePaths: [ws],
        stepIdx: 2,
        toolCall: { name: 'run_command', args: { CommandLine: 'node --test test/sample.test.mjs' } },
        error: ''
      });

      // fullyIdle === false MUST skip post-mortem and return allow
      const midStop = handleAntigravityRslHook({
        hookEventName: 'Stop',
        conversationId: convId,
        workspacePaths: [ws],
        artifactDirectoryPath: artifactDir,
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: false
      });
      assert.deepEqual(midStop.stdoutJson, { decision: 'allow' });
      assert.equal(midStop.skippedReason, 'fullyIdle_false');
      assert.equal(fs.existsSync(path.join(ws, '.agents', 'telemetry', 'rsl_ledger.json')), false);

      // fullyIdle === true MUST extract both contrastive pair + artifact comments into dual rules
      const finalStop = handleAntigravityRslHook({
        hookEventName: 'Stop',
        conversationId: convId,
        workspacePaths: [ws],
        artifactDirectoryPath: artifactDir,
        terminationReason: 'model_stop',
        fullyIdle: true
      });
      assert.deepEqual(finalStop.stdoutJson, { decision: 'allow' });
      assert.equal(finalStop.digest.triggered, true);
      assert.equal(finalStop.digest.tainted, false);
      assert.ok(finalStop.digest.contrastivePairs.length >= 1);
      assert.ok(finalStop.digest.artifactComments.length >= 2);

      const summary = getRslSummary(ws);
      assert.ok(summary.activeRules >= 2, `Expected >= 2 active rules, got ${summary.activeRules}`);

      const agRules = fs.readdirSync(path.join(ws, '.agents', 'rules'));
      const ccRules = fs.readdirSync(path.join(ws, '.claude', 'rules'));
      assert.deepEqual(agRules.sort(), ccRules.sort());

      // Ensure @[label](path) was converted to @path in Antigravity and `path` in Claude
      const reviewAgRule = agRules.find((f) => f.includes('review-rejected'));
      assert.ok(reviewAgRule, 'Expected artifact rejection rule');
      const agBody = fs.readFileSync(path.join(ws, '.agents', 'rules', reviewAgRule), 'utf8');
      const ccBody = fs.readFileSync(path.join(ws, '.claude', 'rules', reviewAgRule), 'utf8');
      assert.match(agBody, /^---\ntrigger: (?:glob|model_decision)\n/m);
      assert.ok(agBody.includes('@src/db/schema.ts'), 'Antigravity rule must rewrite @[label](path) to @path');
      assert.equal(agBody.includes('@[schema]'), false);
      assert.ok(ccBody.includes('`src/db/schema.ts`'), 'Claude rule must use backtick-wrapped paths');
      assert.equal(/(^|\s)@src\//.test(ccBody), false, 'Claude rule must not emit bare @path');
    } finally {
      cleanupDir(ws);
    }
  });

  test('2. EvilGenie anti-reward-hacking gate: blocks test deletion, .skip insertion, assertion stripping, git mining, and skips packages/airlock', () => {
    const ws = makeTmpWorkspace('ctxtop-rsl-evil-');
    fs.mkdirSync(path.join(ws, 'test'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'packages', 'airlock', 'test'), { recursive: true });

    const targetTest = path.join(ws, 'test', 'auth.test.mjs');
    const airlockTest = path.join(ws, 'packages', 'airlock', 'test', 'secret.test.mjs');
    fs.writeFileSync(
      targetTest,
      'import assert from "node:assert/strict";\nassert.equal(1, 1);\nassert.equal(2, 2);\n',
      'utf8'
    );
    fs.writeFileSync(airlockTest, 'assert.equal(1, 1);\n', 'utf8');

    try {
      const snap = snapshotTestSuiteBaseline(ws, 'evil-1');
      assert.ok('test/auth.test.mjs' in snap.files);
      assert.equal('packages/airlock/test/secret.test.mjs' in snap.files, false, 'Must exclude packages/airlock');

      // Case A: .skip inserted + assertions removed without prompt authorization
      recordStepOutcome({
        conversationId: 'evil-1',
        workspacePaths: [ws],
        stepIdx: 0,
        toolCall: { name: 'run_command', args: { CommandLine: 'node --test' } },
        error: 'AssertionError: expected 1 to equal 2'
      });
      fs.writeFileSync(targetTest, 'test.skip("broken", () => {});\n', 'utf8');
      recordStepOutcome({
        conversationId: 'evil-1',
        workspacePaths: [ws],
        stepIdx: 1,
        toolCall: { name: 'run_command', args: { CommandLine: 'node --test' } },
        error: ''
      });

      const stopA = handleAntigravityRslHook({
        hookEventName: 'Stop',
        conversationId: 'evil-1',
        workspacePaths: [ws],
        terminationReason: 'NO_TOOL_CALL',
        lastUserInput: 'Fix auth bug',
        fullyIdle: true
      });
      assert.equal(stopA.digest.status, 'TAINTED_REWARD_HACK');
      assert.equal(stopA.digest.tainted, true);
      assert.ok(stopA.digest.taintDetails.some((d) => d.includes('test_skip_added')));
      assert.ok(stopA.digest.taintDetails.some((d) => d.includes('test_assertions_removed')));
      assert.equal(getRslSummary(ws).activeRules, 0, 'Tainted session must not distill rules');
      assert.equal(getRslSummary(ws).taintedSessions, 1);

      // Case B: Deleted test file
      fs.writeFileSync(targetTest, 'assert.equal(1, 1);\n', 'utf8');
      snapshotTestSuiteBaseline(ws, 'evil-del');
      fs.rmSync(targetTest);
      const digestDel = buildContrastiveDigest({
        conversationId: 'evil-del',
        workspacePaths: [ws],
        lastUserInput: 'Make tests pass'
      });
      assert.equal(digestDel.status, 'TAINTED_REWARD_HACK');
      assert.ok(digestDel.taintDetails.some((d) => d.includes('test_file_deleted')));

      // Case C: .git object mining (`git reflog` / `git cat-file`)
      snapshotTestSuiteBaseline(ws, 'evil-git');
      recordStepOutcome({
        conversationId: 'evil-git',
        workspacePaths: [ws],
        stepIdx: 0,
        toolCall: { name: 'run_command', args: { CommandLine: 'git cat-file -p HEAD~1' } },
        error: ''
      });
      const digestGit = buildContrastiveDigest({
        conversationId: 'evil-git',
        workspacePaths: [ws]
      });
      assert.equal(digestGit.status, 'TAINTED_REWARD_HACK');
      assert.ok(digestGit.taintDetails.some((d) => d.includes('git_object_mining')));
    } finally {
      cleanupDir(ws);
    }
  });

  test('3. Claude Code ingestion: exits immediately on stop_hook_active===true, parses mock transcript JSONL, audits memory, and syncs dual rules', () => {
    const ws = makeTmpWorkspace('ctxtop-rsl-cc-');
    const mockHome = makeTmpWorkspace('ctxtop-rsl-home-');
    const slug = ws.replace(/[:\\/]+/g, '-').replace(/^-+/, '');
    const projDir = path.join(mockHome, '.claude', 'projects', slug);
    const memDir = path.join(projDir, 'memory');
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

    // Create oversized >200 line MEMORY.md to verify Claude memory hygiene audit
    const bigMem = Array.from({ length: 215 }, (_, i) => `- Memory line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), bigMem, 'utf8');

    const transcriptPath = path.join(projDir, 'cc-uuid-1234.jsonl');
    const transcriptLines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Edit',
              input: { file_path: path.join(ws, 'src', 'query.ts') }
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              is_error: true,
              content: 'Error: Missing parameterized SQL binding in src/query.ts'
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_2',
              name: 'Edit',
              input: { file_path: path.join(ws, 'src', 'query.ts') }
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_2',
              is_error: false,
              content: 'Updated src/query.ts with prepared statement'
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: 'Never run raw string interpolation in src/query.ts; always use $1 placeholders.'
        }
      })
    ].join('\n');
    fs.writeFileSync(transcriptPath, `${transcriptLines}\n`, 'utf8');

    try {
      // Recursion guard: stop_hook_active === true must exit immediately with zero side effects
      const recGuard = handleClaudeRslHook({
        hook_event_name: 'Stop',
        session_id: 'cc-uuid-1234',
        cwd: ws,
        transcript_path: transcriptPath,
        stop_hook_active: true
      });
      assert.deepEqual(recGuard.stdoutJson, {});
      assert.equal(recGuard.skippedReason, 'stop_hook_active');
      assert.equal(fs.existsSync(path.join(ws, '.agents', 'telemetry', 'rsl_ledger.json')), false);

      // Normal Stop execution
      const stopRes = handleClaudeRslHook(
        {
          hook_event_name: 'Stop',
          session_id: 'cc-uuid-1234',
          cwd: ws,
          transcript_path: transcriptPath,
          stop_hook_active: false
        },
        { homeDir: mockHome }
      );
      assert.deepEqual(stopRes.stdoutJson, {});
      assert.equal(stopRes.digest.triggered, true);

      const summary = getRslSummary(ws, { homeDir: mockHome });
      assert.ok(summary.activeRules >= 1);
      assert.ok(summary.candidateRules >= 1);
      assert.equal(summary.claudeMemoryAudit.triggered, true);
      assert.ok(summary.claudeMemoryAudit.maxLines > 200);

      // Verify simultaneous valid .agents/rules/rsl-*.md AND .claude/rules/rsl-*.md (excluding staged candidate)
      const agFiles = fs.readdirSync(path.join(ws, '.agents', 'rules')).filter((f) => f.startsWith('rsl-'));
      const ccFiles = fs.readdirSync(path.join(ws, '.claude', 'rules')).filter((f) => f.startsWith('rsl-'));
      assert.ok(agFiles.length >= 1);
      assert.equal(agFiles.some((f) => f.startsWith('rsl-user-correction-')), false);
      assert.deepEqual(agFiles.sort(), ccFiles.sort());

      const firstFile = agFiles[0];
      const agContent = fs.readFileSync(path.join(ws, '.agents', 'rules', firstFile), 'utf8');
      const ccContent = fs.readFileSync(path.join(ws, '.claude', 'rules', firstFile), 'utf8');
      assert.ok(Buffer.byteLength(agContent, 'utf8') < 24_000);
      assert.match(agContent, /^---\ntrigger: glob\nglobs: "[^"]+"/m);
      assert.equal(agContent.includes('$ARGUMENTS'), false);
      assert.match(ccContent, /^---\npaths:\n\s+- "/m);
      assert.equal(ccContent.includes('@['), false);

      // Downvoting importance 2 -> 1 -> 0 must delete BOTH .agents and .claude rule files
      const slug = firstFile.replace(/^rsl-/, '').replace(/\.md$/, '');
      const d1 = adjustHeuristicImportance(ws, slug, -1);
      assert.equal(d1.item.importance, 1);
      assert.equal(fs.existsSync(path.join(ws, '.agents', 'rules', firstFile)), true);
      assert.equal(fs.existsSync(path.join(ws, '.claude', 'rules', firstFile)), true);

      const d2 = adjustHeuristicImportance(ws, slug, -1);
      assert.equal(d2.item.status, 'pruned');
      assert.equal(d2.item.importance, 0);
      assert.equal(fs.existsSync(path.join(ws, '.agents', 'rules', firstFile)), false);
      assert.equal(fs.existsSync(path.join(ws, '.claude', 'rules', firstFile)), false);
    } finally {
      cleanupDir(ws);
      cleanupDir(mockHome);
    }
  });

  test('4. Skill compilation, importance >= 5 PreToolUse hook promotion parity, runtime deny enforcement, CLI, and StatusLine', () => {
    const ws = makeTmpWorkspace('ctxtop-rsl-promo-');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

    try {
      const convId = 'skill-session-1';
      handleAntigravityRslHook({
        hookEventName: 'SessionStart',
        conversationId: convId,
        workspacePaths: [ws]
      });

      // Multi-step recovery (>= 2 steps ending in green test run) -> skill_workflow
      handleAntigravityRslHook({
        hookEventName: 'PostToolUse',
        conversationId: convId,
        workspacePaths: [ws],
        stepIdx: 0,
        toolCall: { name: 'run_command', args: { CommandLine: 'npx prisma migrate deploy' } },
        error: 'P3009 migrate found failed migration'
      });
      handleAntigravityRslHook({
        hookEventName: 'PostToolUse',
        conversationId: convId,
        workspacePaths: [ws],
        stepIdx: 1,
        toolCall: { name: 'run_command', args: { CommandLine: 'npx prisma migrate resolve --rolled-back 001_init' } },
        error: ''
      });
      handleAntigravityRslHook({
        hookEventName: 'PostToolUse',
        conversationId: convId,
        workspacePaths: [ws],
        stepIdx: 2,
        toolCall: { name: 'run_command', args: { CommandLine: 'npx prisma migrate deploy' } },
        error: ''
      });
      handleAntigravityRslHook({
        hookEventName: 'PostToolUse',
        conversationId: convId,
        workspacePaths: [ws],
        stepIdx: 3,
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
        error: ''
      });

      const stopRes = handleAntigravityRslHook({
        hookEventName: 'Stop',
        conversationId: convId,
        workspacePaths: [ws],
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true
      });
      assert.equal(stopRes.distillation.is_valid_learning, true);
      assert.equal(stopRes.distillation.heuristics[0].carrier, 'skill_workflow');

      const slug = stopRes.distillation.heuristics[0].slug;
      const agSkillFile = path.join(ws, '.agents', 'skills', `rsl-${slug}`, 'SKILL.md');
      const ccSkillFile = path.join(ws, '.claude', 'skills', `rsl-${slug}`, 'SKILL.md');
      assert.equal(fs.existsSync(agSkillFile), true);
      assert.equal(fs.existsSync(ccSkillFile), true);

      const agSkill = fs.readFileSync(agSkillFile, 'utf8');
      const ccSkill = fs.readFileSync(ccSkillFile, 'utf8');
      assert.match(agSkill, /^---\nname: rsl-[a-z0-9-]+\ndescription: /m);
      assert.match(agSkill, /Use when .* Do not use /);
      assert.equal(/\b(?:You are|PROACTIVELY)\b|\$ARGUMENTS/.test(agSkill), false);
      assert.match(ccSkill, /argument-hint: /);
      assert.match(ccSkill, /allowed-tools: Read Bash/);

      // Upvote 2 -> 3 -> 4 -> 5 to trigger Carrier C PreToolUse hook promotion on BOTH platforms
      adjustHeuristicImportance(ws, slug, 1);
      adjustHeuristicImportance(ws, slug, 1);
      const promo = adjustHeuristicImportance(ws, slug, 1);
      assert.equal(promo.item.importance, 5);
      assert.equal(promo.item.promotedHook, true);

      const agHooksPath = path.join(ws, '.agents', 'hooks.json');
      const ccSettingsPath = path.join(ws, '.claude', 'settings.json');
      assert.equal(fs.existsSync(agHooksPath), true);
      assert.equal(fs.existsSync(ccSettingsPath), true);

      const agHooks = JSON.parse(fs.readFileSync(agHooksPath, 'utf8'));
      const ccSettings = JSON.parse(fs.readFileSync(ccSettingsPath, 'utf8'));
      assert.equal(agHooks['ctxtop-rsl-guards']?.enabled, true);
      assert.ok(Array.isArray(agHooks['ctxtop-rsl-guards']?.PreToolUse));
      assert.notEqual(ccSettings.disableAllHooks, true);
      assert.ok(Array.isArray(ccSettings.hooks?.PreToolUse));

      // Verify runtime PreToolUse deny output contracts on both adapters
      const agDeny = handleAntigravityRslHook({
        hookEventName: 'PreToolUse',
        workspacePaths: [ws],
        toolCall: { name: 'run_command', args: { CommandLine: 'npx prisma migrate deploy' } }
      });
      assert.equal(agDeny.stdoutJson.decision, 'deny');
      assert.ok(agDeny.stdoutJson.reason.includes(slug));

      const ccDeny = handleClaudeRslHook({
        hook_event_name: 'PreToolUse',
        cwd: ws,
        tool_name: 'Bash',
        tool_input: { command: 'npx prisma migrate deploy' }
      });
      assert.equal(ccDeny.stdoutJson.permissionDecision, 'deny');
      assert.equal(ccDeny.stdoutJson.hookSpecificOutput?.permissionDecision, 'deny');

      // CLI `ctxtop rsl status|list|prune` & StatusLine integration
      const statusCli = runCli(['rsl', 'status', '--cwd', ws, '--json']);
      assert.equal(statusCli.exitCode, 0);
      assert.equal(statusCli.data.activeSkills, 1);
      assert.equal(statusCli.data.promotedHooks, 1);

      const listCli = runCli(['rsl', 'list', '--cwd', ws, '--json']);
      assert.equal(listCli.exitCode, 0);
      assert.equal(listCli.data.count, 1);

      const sl = executeStatusLineBridge(
        { session_id: 'sl-1', cwd: ws, model: { id: 'claude-sonnet-5-5' } },
        { cwd: ws, columns: 144, ansi: false, checkCapabilities: false }
      );
      assert.match(sl.plainLine, /RSL: 0 rules \| Budget: \d+(?:\.\d+)?k?\/20k/);
      assert.equal(formatRslStatusSegment({ activeRules: 3, ruleBudgetTokens: 1200 }), 'RSL: 3 rules | Budget: 1.2k/20k');
      assert.equal(renderStatusLine({ modelId: 'claude-sonnet-5-5' }, { columns: 80, ansi: false }).visibleLength <= 80, true);

      // Prune via CLI deletes both skill directories and clears PreToolUse guard
      const pruneCli = runCli(['rsl', 'prune', slug, '--cwd', ws, '--json']);
      assert.equal(pruneCli.exitCode, 0);
      assert.equal(fs.existsSync(agSkillFile), false);
      assert.equal(fs.existsSync(ccSkillFile), false);
      const ledgerAfter = readRslLedger(ws);
      assert.equal(ledgerAfter.items[slug].status, 'pruned');
      assert.equal(ledgerAfter.stats.prunedCount, 1);
    } finally {
      cleanupDir(ws);
    }
  });

  test('5. Reference normalization, standalone CLI stdin hook execution, SDK fallback, and root hooks.json schema check', () => {
    assert.equal(rewriteAntigravityReferences('Check @[auth](src/auth.ts) $ARGUMENTS'), 'Check @src/auth.ts');
    assert.equal(
      rewriteClaudeReferences('Check @[auth](src/auth.ts) and @src/db.ts and dev@example.com'),
      'Check `src/auth.ts` and `src/db.ts` and dev@example.com'
    );

    // SDK mode falls back cleanly when mocked runner throws, and uses mocked output when valid
    const digest = {
      triggered: true,
      tainted: false,
      contrastivePairs: [
        {
          failureStepIdx: 0,
          recoveryStepIdx: 1,
          toolName: 'run_command',
          targetFile: 'src/index.mjs',
          command: 'node src/index.mjs',
          errorText: 'ERR_MODULE_NOT_FOUND',
          recoveryAction: 'node --experimental-specifier-resolution=node',
          recoverySteps: [{ stepIdx: 1, toolName: 'edit_file', targetFile: 'src/index.mjs', command: '' }],
          validatedByTest: true
        }
      ],
      artifactComments: [],
      userCorrections: [],
      thrashLoops: []
    };
    const fallback = distillContrastiveDigest(digest, {
      mode: 'sdk',
      sdkRunner: () => {
        throw new Error('SDK offline');
      }
    });
    assert.equal(fallback.mode, 'local');
    assert.equal(fallback.is_valid_learning, true);

    // Standalone CLI hook fast-exit on stop_hook_active === true (<500ms including node boot)
    const ws = makeTmpWorkspace('ctxtop-rsl-cli-');
    try {
      const stdout = execFileSync(
        process.execPath,
        [path.resolve('src/hooks/claude_rsl_hook.mjs'), '--event=Stop'],
        {
          input: JSON.stringify({ hook_event_name: 'Stop', cwd: ws, stop_hook_active: true }),
          encoding: 'utf8',
          timeout: 5000
        }
      );
      assert.deepEqual(JSON.parse(stdout.trim()), {});
      assert.equal(fs.existsSync(path.join(ws, '.agents', 'telemetry', 'rsl_ledger.json')), false);

      // Standalone Antigravity & Claude workspace hook sync helpers
      syncAntigravityWorkspaceRslHooks(ws);
      syncClaudeWorkspaceRslHooks(ws);
      const wsAgHooks = JSON.parse(fs.readFileSync(path.join(ws, '.agents', 'hooks.json'), 'utf8'));
      const wsCcSettings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.json'), 'utf8'));
      assert.equal(validateAntigravityHooksSchema(wsAgHooks).valid, true);
      assert.equal(wsCcSettings.disableAllHooks, undefined);
      assert.ok(Array.isArray(wsCcSettings.hooks?.Stop));
    } finally {
      cleanupDir(ws);
    }

    // Root hooks.json still passes Antigravity schema validator cleanly
    const rootHooks = JSON.parse(fs.readFileSync(path.resolve('hooks.json'), 'utf8'));
    const check = validateAntigravityHooksSchema(rootHooks);
    assert.equal(check.valid, true, check.errors.join('; '));
  });

  test('6. RSL hygiene guards: candidate graduation, XML/casual filtering, and ephemeral/out-of-workspace glob rejection', () => {
    const ws = makeTmpWorkspace('ctxtop-rsl-hygiene-');
    const mockHome = makeTmpWorkspace('ctxtop-rsl-hygiene-home-');
    const slug = ws.replace(/[:\\/]+/g, '-').replace(/^-+/, '');
    const projDir = path.join(mockHome, '.claude', 'projects', slug);
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

    try {
      // A. Negative regression: XML wrapper text, casual chat, and ephemeral brain/external paths must yield 0 rules & 0 candidates
      const noiseTranscript = path.join(projDir, 'cc-noise-1.jsonl');
      const brainFile = 'C:/Users/dev-user/.gemini/antigravity/brain/abc123/task.md';
      fs.writeFileSync(
        noiseTranscript,
        [
          JSON.stringify({
            type: 'user',
            message: {
              content:
                '<USER_REQUEST>Please add dark mode</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnever break layout\n</ADDITIONAL_METADATA>'
            }
          }),
          JSON.stringify({
            type: 'user',
            message: { content: 'i dont see publish button' }
          }),
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'tu_n1', name: 'Read', input: { file_path: brainFile } }] }
          }),
          JSON.stringify({
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'tu_n1', is_error: true, content: 'ENOENT' }] }
          }),
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'tu_n2', name: 'Write', input: { file_path: brainFile } }] }
          }),
          JSON.stringify({
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'tu_n2', is_error: false, content: 'ok' }] }
          })
        ].join('\n') + '\n',
        'utf8'
      );

      const noiseStop = handleClaudeRslHook(
        { hook_event_name: 'Stop', session_id: 'cc-noise-1', cwd: ws, transcript_path: noiseTranscript, stop_hook_active: false },
        { homeDir: mockHome }
      );
      assert.equal(noiseStop.digest.userCorrections.length, 0);
      assert.equal(noiseStop.digest.contrastivePairs.length, 0);
      const noiseSummary = getRslSummary(ws, { homeDir: mockHome });
      assert.equal(noiseSummary.activeRules, 0);
      assert.equal(noiseSummary.candidateRules, 0);

      // B. Glob safety: ephemeral and out-of-workspace drive paths never emit C:/**
      assert.deepEqual(buildGlobPatterns(brainFile, ws), { globs: '', paths: [] });
      assert.deepEqual(buildGlobPatterns('C:/other/unrelated/secret.ts', ws), { globs: '', paths: [] });
      assert.deepEqual(buildGlobPatterns(path.join(ws, 'src', 'query.ts'), ws), {
        globs: '*.ts, src/**',
        paths: ['*.ts', 'src/**']
      });

      // C. XML-stripped genuine directive stages as candidate on Session 1, does not auto-promote in same session, graduates on Session 2
      const directiveTranscript = path.join(projDir, 'cc-cand-1.jsonl');
      fs.writeFileSync(
        directiveTranscript,
        JSON.stringify({
          type: 'user',
          message: {
            content:
              '<USER_REQUEST>\nNever log raw JWT tokens in auth responses.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>workspace: test</ADDITIONAL_METADATA>'
          }
        }) + '\n',
        'utf8'
      );

      const stop1 = handleClaudeRslHook(
        { hook_event_name: 'Stop', session_id: 'cc-cand-1', cwd: ws, transcript_path: directiveTranscript, stop_hook_active: false },
        { homeDir: mockHome }
      );
      assert.equal(stop1.digest.userCorrections.length, 1);
      assert.doesNotMatch(stop1.digest.userCorrections[0].text, /USER_REQUEST|ADDITIONAL_METADATA/);
      const sum1 = getRslSummary(ws, { homeDir: mockHome });
      assert.equal(sum1.candidateRules, 1);
      assert.equal(sum1.activeRules, 0);
      assert.equal(fs.existsSync(path.join(ws, '.agents', 'rules')), false);

      // Repeating within same session keeps item staged as candidate
      handleClaudeRslHook(
        { hook_event_name: 'Stop', session_id: 'cc-cand-1', cwd: ws, transcript_path: directiveTranscript, stop_hook_active: false },
        { homeDir: mockHome }
      );
      const sumSame = getRslSummary(ws, { homeDir: mockHome });
      assert.equal(sumSame.candidateRules, 1);
      assert.equal(sumSame.activeRules, 0);

      // Second distinct session promotes candidate -> active dual rules
      const directiveTranscript2 = path.join(projDir, 'cc-cand-2.jsonl');
      fs.copyFileSync(directiveTranscript, directiveTranscript2);
      handleClaudeRslHook(
        { hook_event_name: 'Stop', session_id: 'cc-cand-2', cwd: ws, transcript_path: directiveTranscript2, stop_hook_active: false },
        { homeDir: mockHome }
      );
      const sum2 = getRslSummary(ws, { homeDir: mockHome });
      assert.equal(sum2.candidateRules, 0);
      assert.equal(sum2.activeRules, 1);
      const agFiles = fs.readdirSync(path.join(ws, '.agents', 'rules')).filter((f) => f.startsWith('rsl-'));
      const ccFiles = fs.readdirSync(path.join(ws, '.claude', 'rules')).filter((f) => f.startsWith('rsl-'));
      assert.equal(agFiles.length, 1);
      assert.deepEqual(agFiles, ccFiles);
    } finally {
      cleanupDir(ws);
      cleanupDir(mockHome);
    }
  });
});
