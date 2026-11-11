import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  loadHorizonConfig,
  setDetectorOverride,
  mapTriggerToNativeCommand,
  filterFindingsByHorizonConfig,
  redactUserPaths,
  generateAntigravityDiagnosticMarkdown
} from '../src/core/horizon_config.mjs';
import { evaluateDetectorsOnSteps } from '../src/core/detectors_det01_to_16.mjs';
import { inspectGitArgs } from '../src/shims/agy_git_guard.mjs';
import { runDoctor } from '../src/cli/doctor.mjs';
import { buildHooksConfig } from '../src/cli/init.mjs';

function makeTempDir(prefix = 'agy-horizon-cfg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('AGY-CFG-01: .attention-horizon.json per-detector overrides (off, warn, block) filter findings in evaluateDetectorsOnSteps', () => {
  const tmp = makeTempDir();
  try {
    const stepsWithSecret = [
      {
        stepIndex: 1,
        toolCalls: [
          {
            name: 'write_to_file',
            args: {
              TargetFile: path.join(tmp, 'walkthrough.md'),
              CodeContent: 'sk-ant-api03-1234567890abcdef1234567890abcdef'
            }
          }
        ]
      }
    ];

    // Default: DET-15 triggers CRITICAL and haltsGeneration: true
    const defaultRes = evaluateDetectorsOnSteps(stepsWithSecret, { cwd: tmp });
    assert.equal(defaultRes.shouldHalt, true);
    assert.ok(defaultRes.findings.some((f) => f.detectorId === 'DET-15'));

    // Override DET-15 to warn -> shouldHalt becomes false, finding remains with overriddenByConfig='warn'
    setDetectorOverride('DET-15', 'warn', { cwd: tmp });
    const warnRes = evaluateDetectorsOnSteps(stepsWithSecret, { cwd: tmp });
    assert.equal(warnRes.shouldHalt, false);
    const det15Warn = warnRes.findings.find((f) => f.detectorId === 'DET-15');
    assert.ok(det15Warn);
    assert.equal(det15Warn.overriddenByConfig, 'warn');

    // Override DET-15 to off -> finding is suppressed completely
    setDetectorOverride('DET-15', 'off', { cwd: tmp });
    const offRes = evaluateDetectorsOnSteps(stepsWithSecret, { cwd: tmp });
    assert.equal(offRes.shouldHalt, false);
    assert.equal(offRes.findings.some((f) => f.detectorId === 'DET-15'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGY-CFG-02: evaluateDetectorsOnSteps inspects ReplacementChunks in multi_replace_file_content (IDEA-06)', () => {
  const tmp = makeTempDir();
  try {
    const steps = [
      {
        stepIndex: 1,
        toolCalls: [
          {
            name: 'multi_replace_file_content',
            args: {
              TargetFile: path.join(tmp, 'walkthrough.md'),
              ReplacementChunks: [
                {
                  TargetContent: 'placeholder',
                  ReplacementContent: 'ghp_1234567890abcdefghijklmnopqrstuvwx'
                }
              ]
            }
          }
        ]
      }
    ];
    const res = evaluateDetectorsOnSteps(steps, { cwd: tmp });
    assert.equal(res.shouldHalt, true);
    assert.ok(res.findings.some((f) => f.detectorId === 'DET-15'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGY-CFG-03: agy_git_guard inspectGitArgs skips -m value so `git commit -m "-next"` is allowed while `-n` is blocked', () => {
  const safeCommit = inspectGitArgs(['commit', '-m', '-next release prep']);
  assert.equal(safeCommit.blocked, false);

  const blockedCommit = inspectGitArgs(['commit', '-n', '-m', 'bypass hooks']);
  assert.equal(blockedCommit.blocked, true);
  assert.equal(blockedCommit.detectorId, 'DET-19');
});

test('AGY-CFG-04: runDoctor({ diagnostic: true, silent: true }) generates zero-PII GitHub issue markdown', async () => {
  const tmp = makeTempDir();
  try {
    setDetectorOverride('DET-06', 'warn', { cwd: tmp });
    const res = await runDoctor({ workspacePath: tmp, diagnostic: true, silent: true });
    assert.ok(res.diagnosticMarkdown);
    assert.match(res.diagnosticMarkdown, /Attention Horizon \(Antigravity Edition\) — Zero-PII Diagnostic Report/);
    assert.match(res.diagnosticMarkdown, /DET-06=warn/);
    assert.equal(
      redactUserPaths('C:\\Users\\PrivateUser\\.gemini', 'C:\\Users\\PrivateUser'),
      '~\\.gemini'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGY-CFG-05: hooks.json and buildHooksConfig serialize SessionStart, PreInvocation, PostInvocation, and Stop as flat arrays without matcher wrappers', () => {
  const rootHooksPath = path.resolve(process.cwd(), 'hooks.json');
  const rootHooks = JSON.parse(fs.readFileSync(rootHooksPath, 'utf8'));
  const generatedHooks = buildHooksConfig('/tmp/agy-horizon-flightcheck');

  for (const [sourceName, cfg] of [
    ['hooks.json', rootHooks],
    ['buildHooksConfig()', generatedHooks]
  ]) {
    const lifecycle = cfg.hooks || cfg['horizon-flightcheck-lifecycle'];
    assert.ok(lifecycle, `${sourceName} must define hooks or horizon-flightcheck-lifecycle`);
    for (const hookEvent of ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']) {
      if (!(hookEvent in lifecycle)) continue;
      const arr = lifecycle[hookEvent];
      assert.equal(Array.isArray(arr), true, `${sourceName} ${hookEvent} must be a flat array`);
      for (const entry of arr) {
        assert.equal(
          'matcher' in entry,
          false,
          `${sourceName} ${hookEvent} handler must NEVER wrap in a matcher object`
        );
        assert.equal(entry.type, 'command');
        assert.equal(typeof entry.command, 'string');
      }
    }
  }
});

test('AGY-CFG-06: mapTriggerToNativeCommand emits /rewind, /fork, /mcp, /effort, /handoff -> /clear, and plain-text /compact invariant', () => {
  const rewind = mapTriggerToNativeCommand({ consecutiveFailures: 3, detectorId: 'DET-01' });
  assert.equal(rewind.category, 'POISONED_CONTEXT_RECOVERY');
  assert.equal(rewind.primaryCommand, '/rewind');
  assert.equal(rewind.secondaryCommand, '/fork');

  const compactAgy = mapTriggerToNativeCommand({
    platform: 'antigravity',
    contextUsedPct: 75,
    modifiedFiles: ['src/webview/horizon_panel.html']
  });
  assert.equal(compactAgy.category, 'SCOPED_CONTEXT_COMPACTION');
  assert.equal(compactAgy.primaryCommand, 'Type /compact in the chat box and press Enter');
  assert.equal(compactAgy.clickableCopyAllowed, false);
  assert.match(compactAgy.reclaimScope, /src\/webview\/horizon_panel\.html/);

  const overhead = mapTriggerToNativeCommand({ detectorId: 'DET-10', idleMcpBloat: true });
  assert.equal(overhead.primaryCommand, '/mcp');
  assert.equal(overhead.secondaryCommand, '/context');

  const baton = mapTriggerToNativeCommand({ milestoneComplete: true });
  assert.equal(baton.sequence, '/handoff -> /clear');
});
