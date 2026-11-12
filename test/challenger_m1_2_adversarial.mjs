/**
 * @file test/challenger_m1_2_adversarial.test.mjs
 * Adversarial Empirical Challenge Suite for Milestone 1:
 * - ctxtop init & installAttentionHorizon anti-clobber, byte-exact backup, idempotency, uninstall cycle
 * - Git exclude preservation & idempotency
 * - Non-standard settings shapes (array, corrupted, primitive hooks, string statusline)
 * - USTF v1 trajectory normalizer & schema corner cases, rewind DAGs, corrupted inputs, out-of-order steps
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  installAttentionHorizon,
  uninstallAttentionHorizon,
  executeInitSubcommand,
  ensureGitExcludeEntries,
  PKG_ROOT
} from '../bin/ctxtop.mjs';

import {
  USTF_SCHEMA_VERSION,
  USTF_SCHEMA_URI,
  USTF_EVENT_TYPES,
  USTF_SPAN_KINDS,
  validateUstfTrajectory,
  validateUstfEvent,
  validateUstfSpan,
  validateUstfUsage,
  createEmptyUstfSession,
  normalizeUsage,
  normalizeAntigravitySession,
  normalizeClaudeCodeSession,
  normalizeSessionTrajectory
} from '../src/core-isomorphic/ustf/index.mjs';

// ============================================================================
// PART 1: INSTALLER & ANTI-CLOBBER STRESS TESTS
// ============================================================================

test('CHALLENGE 1.1: Installer Anti-Clobber — Backup is byte-for-byte identical to original user settings', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-adv-backup-'));
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');

    // Complex pre-existing user settings with unusual formatting, tabs, unicode
    const originalContent = JSON.stringify({
      env: {
        MY_VAR: 'production_val_42',
        UNICODE_TEST: '🚀 关注视界 Attention Horizon ⚡',
        PATH_OVERRIDE: '/opt/custom/bin:/usr/local/bin'
      },
      permissions: {
        allow: ['Read', 'Write', 'Glob', 'Grep'],
        deny: ['Bash', 'PowerShell']
      },
      statusLine: {
        type: 'command',
        command: 'node "/opt/company/statusline.js" --verbose',
        interval_ms: 750
      },
      hooks: {
        modules: ['/opt/company/corporate-telemetry.js', './relative-mod.js'],
        PreToolUse: [
          {
            matcher: 'CustomSecurityMatcher',
            hooks: [
              {
                type: 'command',
                command: 'python3 "/opt/security/pre_tool_validator.py"'
              }
            ]
          }
        ],
        PostCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node "/opt/backup/save_compact_state.js"'
              }
            ]
          }
        ],
        CustomLifecycleEvent: [
          {
            hooks: [{ type: 'command', command: 'echo "custom event fired"' }]
          }
        ]
      },
      customRootProperty: {
        nestedSetting: true,
        flags: [1, 2, 3]
      }
    }, null, '\t') + '\n';

    fs.writeFileSync(settingsPath, originalContent, 'utf-8');
    const originalBytes = fs.readFileSync(settingsPath);

    const ts = 1762800000000;
    const res = installAttentionHorizon({
      cwd: tmpDir,
      settingsPath,
      timestamp: ts
    });

    assert.equal(res.ok, true, 'Installer should succeed');
    assert.ok(res.backupPath, 'Backup path must be defined');
    assert.equal(fs.existsSync(res.backupPath), true, 'Backup file must exist on disk');

    // EMPIRICAL BYTE-FOR-BYTE CHECK
    const backupBytes = fs.readFileSync(res.backupPath);
    assert.equal(
      Buffer.compare(originalBytes, backupBytes),
      0,
      'Backup MUST be byte-for-byte identical to the original settings file before install'
    );

    // Verify all original settings preserved in merged settings
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.equal(merged.env.MY_VAR, 'production_val_42');
    assert.equal(merged.env.UNICODE_TEST, '🚀 关注视界 Attention Horizon ⚡');
    assert.deepEqual(merged.permissions.deny, ['Bash', 'PowerShell']);
    assert.equal(merged.customRootProperty.nestedSetting, true);
    assert.deepEqual(merged.customRootProperty.flags, [1, 2, 3]);

    // Verify user hooks preserved alongside AH hooks
    assert.ok(merged.hooks.modules.includes('/opt/company/corporate-telemetry.js'));
    assert.ok(merged.hooks.modules.includes('./relative-mod.js'));
    assert.ok(merged.hooks.modules.includes(`${PKG_ROOT}/hooks/register.js`));

    // Custom PreToolUse hook preserved
    const customPreHook = merged.hooks.PreToolUse.find(
      (h) => h.matcher === 'CustomSecurityMatcher'
    );
    assert.ok(customPreHook, 'Custom matcher PreToolUse hook must be preserved');
    assert.equal(
      customPreHook.hooks[0].command,
      'python3 "/opt/security/pre_tool_validator.py"'
    );

    // Custom non-AH event preserved
    assert.ok(merged.hooks.CustomLifecycleEvent, 'Custom non-AH lifecycle event must not be deleted');

    // User statusLine preserved in ahPreviousStatusLine
    assert.equal(
      merged.ahPreviousStatusLine.command,
      'node "/opt/company/statusline.js" --verbose'
    );
    assert.equal(merged.statusLine.command, `node "${PKG_ROOT}/bin/ah-statusline.mjs"`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CHALLENGE 1.2: Installer Idempotency — 5 consecutive runs never duplicate hooks or clobber backup statusline', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-adv-idempotent-'));
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');

    const initialSettings = {
      permissions: { allow: ['Read'] },
      statusLine: {
        type: 'command',
        command: 'node ./user-original-statusline.js'
      },
      hooks: {
        modules: ['./existing-user-mod.js'],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node ./audit-bash.js' }]
          }
        ]
      }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2), 'utf-8');

    // Run installer 5 times consecutively with different timestamps
    for (let run = 1; run <= 5; run++) {
      const ts = 1762800000000 + run * 1000;
      const res = installAttentionHorizon({
        cwd: tmpDir,
        settingsPath,
        timestamp: ts
      });
      assert.equal(res.ok, true, `Run #${run} must succeed`);
      assert.ok(fs.existsSync(res.backupPath), `Backup for run #${run} must exist`);

      const current = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

      // Modules should have exactly 2 entries (user-mod + AH register), NOT grow to 6
      assert.equal(
        current.hooks.modules.length,
        2,
        `Run #${run}: hooks.modules must not accumulate duplicates`
      );

      // PreToolUse should have exactly 2 entries (user audit hook + AH pre-tool-use hook)
      assert.equal(
        current.hooks.PreToolUse.length,
        2,
        `Run #${run}: PreToolUse must not accumulate duplicates`
      );

      // ahPreviousStatusLine must STILL be the original user statusline, NEVER overwritten by ah-statusline
      assert.equal(
        current.ahPreviousStatusLine.command,
        'node ./user-original-statusline.js',
        `Run #${run}: ahPreviousStatusLine must retain original user statusline across multiple runs`
      );
    }

    // Now verify uninstall restores the original state cleanly
    const unRes = uninstallAttentionHorizon({ cwd: tmpDir, settingsPath });
    assert.equal(unRes.ok, true);

    const afterUninstall = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.deepEqual(afterUninstall.hooks.modules, ['./existing-user-mod.js']);
    assert.equal(afterUninstall.hooks.PreToolUse.length, 1);
    assert.equal(afterUninstall.hooks.PreToolUse[0].hooks[0].command, 'node ./audit-bash.js');
    assert.equal(afterUninstall.statusLine.command, 'node ./user-original-statusline.js');
    assert.equal(afterUninstall.ahPreviousStatusLine, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CHALLENGE 1.3: Installer Resilience — Handles non-existent, empty, array, and malformed settings files safely', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-adv-edge-'));
  try {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Edge Case A: settings.json does not exist
    const settingsPathA = path.join(claudeDir, 'settings_nonexistent.json');
    const resA = installAttentionHorizon({
      cwd: tmpDir,
      settingsPath: settingsPathA
    });
    assert.equal(resA.ok, true);
    assert.equal(resA.backupPath, null, 'No backup if settings.json did not exist');
    assert.ok(fs.existsSync(settingsPathA), 'New settings.json should be created');
    const parsedA = JSON.parse(fs.readFileSync(settingsPathA, 'utf-8'));
    assert.ok(parsedA.hooks.modules.length >= 1);
    assert.ok(parsedA.statusLine);

    // Edge Case B: settings.json is completely empty (0 bytes)
    const settingsPathB = path.join(claudeDir, 'settings_empty.json');
    fs.writeFileSync(settingsPathB, '', 'utf-8');
    const resB = installAttentionHorizon({
      cwd: tmpDir,
      settingsPath: settingsPathB,
      timestamp: 1001
    });
    assert.equal(resB.ok, true);
    assert.ok(fs.existsSync(resB.backupPath));
    assert.equal(fs.readFileSync(resB.backupPath).length, 0, 'Backup of empty file is 0 bytes');
    const parsedB = JSON.parse(fs.readFileSync(settingsPathB, 'utf-8'));
    assert.ok(parsedB.hooks.modules.length >= 1);

    // Edge Case C: settings.json contains malformed / broken JSON
    const settingsPathC = path.join(claudeDir, 'settings_corrupted.json');
    const corruptContent = '{ "env": { "UNCLOSED": ';
    fs.writeFileSync(settingsPathC, corruptContent, 'utf-8');
    const resC = installAttentionHorizon({
      cwd: tmpDir,
      settingsPath: settingsPathC,
      timestamp: 1002
    });
    assert.equal(resC.ok, true);
    assert.ok(fs.existsSync(resC.backupPath));
    assert.equal(
      fs.readFileSync(resC.backupPath, 'utf-8'),
      corruptContent,
      'Original corrupt file preserved byte-for-byte in backup'
    );
    const parsedC = JSON.parse(fs.readFileSync(settingsPathC, 'utf-8'));
    assert.ok(parsedC.hooks.modules.length >= 1);

    // Edge Case D: settings.json is a JSON array instead of object
    const settingsPathD = path.join(claudeDir, 'settings_array.json');
    const arrayContent = '[ "legacy", "item" ]';
    fs.writeFileSync(settingsPathD, arrayContent, 'utf-8');
    const resD = installAttentionHorizon({
      cwd: tmpDir,
      settingsPath: settingsPathD,
      timestamp: 1003
    });
    assert.equal(resD.ok, true);
    assert.ok(fs.existsSync(resD.backupPath));
    assert.equal(fs.readFileSync(resD.backupPath, 'utf-8'), arrayContent);
    const parsedD = JSON.parse(fs.readFileSync(settingsPathD, 'utf-8'));
    assert.ok(!Array.isArray(parsedD));
    assert.ok(parsedD.hooks);

    // Edge Case E: hooks is null or string in settings
    const settingsPathE = path.join(claudeDir, 'settings_null_hooks.json');
    fs.writeFileSync(settingsPathE, JSON.stringify({ hooks: null }), 'utf-8');
    const resE = installAttentionHorizon({
      cwd: tmpDir,
      settingsPath: settingsPathE,
      timestamp: 1004
    });
    assert.equal(resE.ok, true);
    const parsedE = JSON.parse(fs.readFileSync(settingsPathE, 'utf-8'));
    assert.ok(typeof parsedE.hooks === 'object');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CHALLENGE 1.4: Git Exclude Preservation & Idempotency', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-adv-git-'));
  try {
    const gitDir = path.join(tmpDir, '.git');
    const infoDir = path.join(gitDir, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, 'exclude');

    // Pre-populate exclude WITHOUT trailing newline
    fs.writeFileSync(excludePath, '# User exclude entries\n*.tmp\nbuild/', 'utf-8');

    // First call: appends .claude/cache/ and .claude/locks/
    const res1 = ensureGitExcludeEntries(tmpDir);
    assert.equal(res1.updated, true);
    const content1 = fs.readFileSync(excludePath, 'utf-8');
    assert.match(content1, /\.claude\/cache\//);
    assert.match(content1, /\.claude\/locks\//);
    assert.match(content1, /build\/\n\.claude\/cache\//, 'Should append with proper newline separator');

    // Second call: already present, must be idempotent
    const res2 = ensureGitExcludeEntries(tmpDir);
    assert.equal(res2.updated, false, 'Second run must not modify file');
    const content2 = fs.readFileSync(excludePath, 'utf-8');
    assert.equal(content1, content2, 'Content must remain identical');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CHALLENGE 1.5: executeInitSubcommand CLI Router — Dry run and flag routing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-adv-init-'));
  try {
    // Dry run with --claude and --workspace
    const dryRunRes = executeInitSubcommand(['--claude', '--workspace', '--dry-run'], {
      cwd: tmpDir
    });
    assert.equal(dryRunRes.ok, true);
    assert.equal(dryRunRes.exitCode, 0);
    assert.match(dryRunRes.output, /DRY RUN/);
    assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'settings.json')), false);

    // Real run with --claude and --workspace
    const realRunRes = executeInitSubcommand(['--claude', '--workspace'], {
      cwd: tmpDir
    });
    assert.equal(realRunRes.ok, true);
    assert.equal(realRunRes.exitCode, 0);
    assert.equal(fs.existsSync(path.join(tmpDir, '.claude', 'settings.json')), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// PART 2: USTF v1 TRAJECTORY NORMALIZER & SCHEMA STRESS TESTS
// ============================================================================

test('CHALLENGE 2.1: Usage Normalizer Corner Cases — Missing, negative, string, and malformed token fields', () => {
  // A: completely empty / null / non-object
  assert.deepEqual(normalizeUsage(null), {
    uncached: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    costUSD: 0
  });

  // B: negative numbers are clamped to 0
  const negRaw = {
    input_tokens: -500,
    cache_read_input_tokens: -1000,
    output_tokens: -250,
    costUSD: -5.0
  };
  const negNorm = normalizeUsage(negRaw);
  assert.equal(negNorm.uncached, 0);
  assert.equal(negNorm.cacheRead, 0);
  assert.equal(negNorm.output, 0);
  assert.equal(negNorm.costUSD, 0);
  assert.equal(validateUstfUsage(negNorm).valid, true);

  // C: string numbers are parsed as numbers
  const strRaw = {
    input_tokens: '1234',
    output_tokens: '567',
    cached_tokens: '8900'
  };
  const strNorm = normalizeUsage(strRaw);
  assert.equal(strNorm.uncached, 1234);
  assert.equal(strNorm.output, 567);
  assert.equal(strNorm.cacheRead, 8900);
  assert.equal(validateUstfUsage(strNorm).valid, true);

  // D: partial token fields
  const partRaw = { thinking_tokens: 420 };
  const partNorm = normalizeUsage(partRaw);
  assert.equal(partNorm.thinking, 420);
  assert.equal(partNorm.uncached, 0);
  assert.equal(validateUstfUsage(partNorm).valid, true);

  // E: custom rates cost calculation
  const customUsage = normalizeUsage(
    { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    { inputRate: 10.0, outputRate: 30.0 }
  );
  assert.equal(customUsage.costUSD, 40.0);
});

test('CHALLENGE 2.2: Antigravity Session Normalizer — Out-of-order steps, missing fields, and timestamp boundaries', () => {
  // Out of order steps: Step 2 arrives before Step 0, null entries interspersed
  const adversarialAgy = {
    sessionId: 'agy-stress-session',
    modelId: 'gemini-2-5-flash',
    steps: [
      null,
      {
        stepIndex: 2,
        type: 'TOOL_RESULT',
        toolName: 'Bash',
        content: 'Exit code 0\n' + 'A'.repeat(5000), // Large result string
        createdAt: 1700000003000
      },
      undefined,
      {
        stepIndex: 0,
        type: 'USER_INPUT',
        content: 'Execute deployment script',
        createdAt: 1700000000000
      },
      {
        stepIndex: 1,
        type: 'TOOL_CALL',
        toolName: 'Bash',
        toolInput: { command: 'deploy.sh' },
        createdAt: 1700000001000,
        durationMs: 1500
      },
      {
        // Missing type entirely, default to STEP
        content: 'Processing finished'
      }
    ]
  };

  const traj = normalizeAntigravitySession(adversarialAgy);
  assert.equal(traj.sessionId, 'agy-stress-session');
  assert.equal(traj.harness, 'antigravity');

  // Verify all produced events and spans are schema-valid
  const v = validateUstfTrajectory(traj);
  assert.equal(v.valid, true, `Validation errors: ${v.errors.join('; ')}`);

  // Large content was clamped in tool result
  const resEv = traj.events.find((e) => e.type === 'tool.result');
  assert.ok(resEv);
  assert.ok(resEv.payload.result.length <= 1000, 'Content must be truncated to prevent bloat');
});

test('CHALLENGE 2.3: Claude Code DAG Normalizer — Complex rewind branches, cycles, and dangling leaves', () => {
  // Complex DAG with 2 forks:
  // Root (Turn 1 User) -> Asst 1
  // Fork A (abandoned after 2 steps): ForkA-1 -> ForkA-2
  // Fork B (abandoned after 1 step): ForkB-1
  // Fork C (active tip with leafUuid): ForkC-1 -> ForkC-2 (active-leaf)
  const dagEntries = [
    {
      uuid: 'node-root',
      parentUuid: null,
      role: 'user',
      content: 'Write an algorithm',
      timestamp: 1700000000000
    },
    {
      uuid: 'node-asst-1',
      parentUuid: 'node-root',
      role: 'assistant',
      content: 'I will write quicksort',
      timestamp: 1700000001000
    },
    // Abandoned Fork A
    {
      uuid: 'node-fork-a-1',
      parentUuid: 'node-asst-1',
      role: 'assistant',
      content: 'Using bubble sort instead',
      timestamp: 1700000002000
    },
    {
      uuid: 'node-fork-a-2',
      parentUuid: 'node-fork-a-1',
      role: 'assistant',
      content: 'Bubble sort failed benchmark',
      timestamp: 1700000003000
    },
    // Abandoned Fork B
    {
      uuid: 'node-fork-b-1',
      parentUuid: 'node-asst-1',
      role: 'assistant',
      content: 'Using bogo sort instead',
      timestamp: 1700000004000
    },
    // Active Fork C
    {
      uuid: 'node-fork-c-1',
      parentUuid: 'node-asst-1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_edit',
          name: 'Edit',
          input: { file_path: 'sort.js' }
        }
      ],
      timestamp: 1700000005000
    },
    {
      uuid: 'active-leaf',
      parentUuid: 'node-fork-c-1',
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_edit',
          content: 'File updated successfully'
        }
      ],
      leafUuid: 'active-leaf',
      timestamp: 1700000006000
    }
  ];

  const traj = normalizeClaudeCodeSession(dagEntries, {
    sessionId: 'claude-rewind-stress'
  });

  assert.equal(traj.sessionId, 'claude-rewind-stress');
  assert.equal(traj.harness, 'claude-code');

  // Verify rewind branches detection
  assert.ok(traj.rewindBranches.length >= 2, 'Must detect at least 2 abandoned rewind branches');
  const abandonedUuids = traj.rewindBranches.map((r) => r.abandonedTipUuid);
  assert.ok(abandonedUuids.includes('node-fork-a-1'));
  assert.ok(abandonedUuids.includes('node-fork-b-1'));
  assert.ok(!abandonedUuids.includes('active-leaf'));

  // Active chain contains only Root -> Asst 1 -> Fork C-1 -> active-leaf
  const validation = validateUstfTrajectory(traj);
  assert.equal(validation.valid, true, `Validation errors: ${validation.errors.join('; ')}`);
});

test('CHALLENGE 2.4: Claude Code DAG — Cyclic parent pointers and dangling leaf pointers terminate cleanly', () => {
  // Test A: Cyclic parent pointers (A -> B -> A)
  const cyclicEntries = [
    { uuid: 'cycle-a', parentUuid: 'cycle-b', role: 'user', content: 'hello' },
    { uuid: 'cycle-b', parentUuid: 'cycle-a', role: 'assistant', content: 'world' }
  ];
  // Normalizer MUST NOT hang or throw Maximum call stack size exceeded
  const trajCycle = normalizeClaudeCodeSession(cyclicEntries, { sessionId: 'cycle-sess' });
  assert.equal(trajCycle.sessionId, 'cycle-sess');
  assert.equal(validateUstfTrajectory(trajCycle).valid, true);

  // Test B: Dangling leafUuid that does not exist in entries
  const danglingEntries = [
    { uuid: 'msg-1', parentUuid: null, role: 'user', content: 'test', leafUuid: 'ghost-leaf-does-not-exist' }
  ];
  const trajDangling = normalizeClaudeCodeSession(danglingEntries, { sessionId: 'dangling-sess' });
  assert.equal(trajDangling.sessionId, 'dangling-sess');
  assert.equal(validateUstfTrajectory(trajDangling).valid, true);
});

test('CHALLENGE 2.5: Empty, Corrupt, and Degenerate Inputs to normalizeSessionTrajectory', () => {
  // A: null and undefined
  const trajNull = normalizeSessionTrajectory(null);
  assert.equal(validateUstfTrajectory(trajNull).valid, true);

  const trajUndef = normalizeSessionTrajectory(undefined);
  assert.equal(validateUstfTrajectory(trajUndef).valid, true);

  // B: empty object
  const trajEmptyObj = normalizeSessionTrajectory({});
  assert.equal(validateUstfTrajectory(trajEmptyObj).valid, true);

  // C: empty string and whitespace string
  const trajEmptyStr = normalizeSessionTrajectory('');
  assert.equal(validateUstfTrajectory(trajEmptyStr).valid, true);

  const trajWhitespace = normalizeSessionTrajectory('   \n\n\r\n   ');
  assert.equal(validateUstfTrajectory(trajWhitespace).valid, true);

  // D: corrupted JSONL text
  const corruptedJsonl = [
    'THIS IS NOT JSON',
    '{ incomplete json',
    JSON.stringify({ uuid: '1', role: 'user', content: 'valid line 1' }),
    '{"bad": syntax,,}',
    JSON.stringify({ uuid: '2', parentUuid: '1', role: 'assistant', content: 'valid line 2' })
  ].join('\n');

  const trajCorrupt = normalizeSessionTrajectory(corruptedJsonl);
  assert.equal(trajCorrupt.harness, 'claude-code');
  assert.ok(trajCorrupt.events.length >= 2);
  assert.equal(validateUstfTrajectory(trajCorrupt).valid, true);

  // E: array of primitives / non-objects
  const trajPrimitives = normalizeSessionTrajectory([null, 42, 'string', true]);
  assert.equal(validateUstfTrajectory(trajPrimitives).valid, true);
});

test('CHALLENGE 2.6: Schema Strict Validation — Invalidation conditions and boundary rejections', () => {
  // Test schema URI mismatch
  const t1 = createEmptyUstfSession('s1', 'claude-code');
  t1.$schema = 'https://wrong-domain.com/schema.json';
  assert.equal(validateUstfTrajectory(t1).valid, false);

  // Test version mismatch
  const t2 = createEmptyUstfSession('s2', 'claude-code');
  t2.version = '99.0.0';
  assert.equal(validateUstfTrajectory(t2).valid, false);

  // Test unknown harness
  const t3 = createEmptyUstfSession('s3', 'unsupported-harness');
  assert.equal(validateUstfTrajectory(t3).valid, false);

  // Test invalid event type
  const badEvent = { eventId: 'ev1', type: 'hacked.injection', timestampMs: 1000 };
  assert.equal(validateUstfEvent(badEvent).valid, false);

  // Test invalid span kind
  const badSpan = {
    spanId: 'sp1',
    kind: 'arbitrary-kind',
    name: 'test',
    startTimeMs: 100
  };
  assert.equal(validateUstfSpan(badSpan).valid, false);

  // Test negative span duration
  const negSpan = {
    spanId: 'sp2',
    kind: 'tool',
    name: 'Read',
    startTimeMs: 100,
    durationMs: -50
  };
  assert.equal(validateUstfSpan(negSpan).valid, false);

  // Test invalid usage accounting
  const badUsage = { uncached: 'thousand', costUSD: -1 };
  assert.equal(validateUstfUsage(badUsage).valid, false);
});
