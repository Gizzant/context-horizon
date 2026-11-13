/**
 * @file test/batch5_negative_detectors_spawn_diagnostics.test.mjs
 * Batch 5 Comprehensive Verification Suite (`ISS-061`, `ISS-062`, `ISS-065`):
 *   - `ISS-061a`: Explicit benign-input negative tests proving zero false positives for
 *     `DET-09`, `DET-12`, `DET-13`, `DET-15`, `DET-18`, and `DET-19`.
 *   - `ISS-061b`: Real `child_process.spawnSync` CLI hook E2E tests across every handler
 *     (`pre-tool-use.mjs`, `post-tool-use.mjs`, `pre-model-switch.mjs`, `stop-gate.mjs`,
 *     `compact-lifecycle.mjs` across `SessionStart`/`PreCompact`/`PostCompact`/`WorktreeCreate`,
 *     and `bin/ah-statusline.mjs` stdin JSON mode), including malformed stdin fail-closed vs fail-safe.
 *   - `ISS-062`: Authentic Antigravity `{ version: 1, leases: [...] }` scope-lock interop and
 *     hardened token/AST static-analyzer negative & positive tests (`validateModLaw1`,
 *     `validateModLaw2`, `validateModLaw3`, `validateModLaw4Imports`, `validateModLaw5ToolCallCatch`).
 *   - `ISS-065`: Zero silent `catch` block static audit across `hooks/register.js`,
 *     `src/coach/savedQuotaLedger.mjs`, and `src/coach/stateBatonHydrator.mjs`, bounded 50-line
 *     `.claude/cache/ah_diagnostics.jsonl` + pure-V8 in-memory ring buffer, home-path redaction,
 *     zero `stdout` writes, and `ah-claude doctor` (`--json` & `--diagnostic`) `hookDiagnostics` surface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CacheGravityRouter,
  evaluateDet09PrefixMutationFence
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  CircuitBreakerEngine,
  evaluateDet12HaikuPreCliffBreaker,
  evaluateDet13McpSchemaBloatGuard,
  evaluateDet15BatchedStopFormatter,
  evaluateDet18UntrustedSettingsGuard,
  evaluateDet19SubagentIpiSanitizer,
  evaluateDet20ScopeLockAndQuotaBrake
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  getNodeIo,
  registerNodeIo,
  getDiagnosticsFilePath,
  recordRuntimeDiagnostic,
  readRuntimeDiagnostics,
  clearInMemoryRuntimeDiagnostics
} from '../../src/core-isomorphic/utils/runtime.mjs';
import { getLedgerFilePath, readLedgerEntries } from '../../src/core-isomorphic/coach/savedQuotaLedger.mjs';
import {
  handleSessionStartHydration,
  parsePortableHandoffMarkdown
} from '../../src/core-isomorphic/coach/stateBatonHydrator.mjs';
import { inspectHookDiagnostics, runDoctorDiagnostics } from '../../src/diagnostics/doctorEngine.mjs';
import { runCli } from '../../bin/cli.mjs';
import register from '../../hooks/register.js';

import {
  scanJsTokens,
  validateModLaw1,
  validateModLaw2,
  validateModLaw3,
  validateModLaw4Imports,
  validateModLaw5ToolCallCatch
} from '../mod_static_compliance.test.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const HANDLERS = {
  preToolUse: path.join(PROJECT_ROOT, 'hooks', 'handlers', 'pre-tool-use.mjs'),
  postToolUse: path.join(PROJECT_ROOT, 'hooks', 'handlers', 'post-tool-use.mjs'),
  preModelSwitch: path.join(PROJECT_ROOT, 'hooks', 'handlers', 'pre-model-switch.mjs'),
  compactLifecycle: path.join(PROJECT_ROOT, 'hooks', 'handlers', 'compact-lifecycle.mjs'),
  stopGate: path.join(PROJECT_ROOT, 'hooks', 'handlers', 'stop-gate.mjs'),
  statusLine: path.join(PROJECT_ROOT, 'bin', 'ah-statusline.mjs')
};

/**
 * Helper to create an isolated workspace + synthetic home directory in `os.tmpdir()`.
 */
function withTempWorkspace(fn) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-batch5-'));
  const workDir = path.join(rootDir, 'workspace');
  const homeDir = path.join(rootDir, 'home');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  let isAsync = false;
  try {
    const res = fn({ rootDir, workDir, homeDir });
    if (res && typeof res.then === 'function') {
      isAsync = true;
      return res.finally(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
      });
    }
    return res;
  } finally {
    if (!isAsync) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
}

/**
 * Spawns a real Node CLI hook handler subprocess with piped `stdin` inside `workDir`.
 */
function spawnHookProcess(scriptPath, args = [], rawStdin = '{}', { workDir, homeDir } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    input: typeof rawStdin === 'string' ? rawStdin : JSON.stringify(rawStdin),
    encoding: 'utf8',
    cwd: workDir,
    timeout: 10000,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir
    }
  });
}

// ============================================================================
// ISS-061a: Benign-Input Negative Tests for DET-09, DET-12, DET-13, DET-15, DET-18, DET-19
// ============================================================================

test('ISS-061a [DET-09]: benign ordinary source edit while WARM and CLAUDE.md edit while COLD do NOT trigger', () => {
  const router = new CacheGravityRouter({ mode: 'AUTO_PILOT' });

  // 1. Editing ordinary workspace source file (`src/app.js`) while prompt cache is WARM
  const warmSourceEdit = router.interceptTopLevelMutation({
    filePath: 'src/app.js',
    currentModel: 'claude-opus-5-5',
    cachedTokens: 88_000,
    cacheWarm: true,
    ttlRemainingSeconds: 265
  });
  assert.equal(warmSourceEdit.detectorId, 'DET-09');
  assert.equal(warmSourceEdit.triggered, false);
  assert.equal(warmSourceEdit.queued, false);
  assert.equal(warmSourceEdit.decision, 'allow');

  // Same check through `evaluateDet09PrefixMutationFence` and `CircuitBreakerEngine.evaluatePreToolUse`
  const engine = new CircuitBreakerEngine({ mode: 'AUTO_PILOT' });
  const preToolWarmSource = engine.evaluatePreToolUse(
    {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/app.js',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;'
      }
    },
    {
      modelId: 'claude-opus-5-5',
      promptCache: { warm: true, ttlSeconds: 240, ttlTier: '5m' },
      contextWindow: { cachedTokens: 88_000, totalInputTokens: 90_000 }
    }
  );
  assert.equal(preToolWarmSource.triggered, false);
  assert.equal(preToolWarmSource.decision, 'allow');

  // 2. Editing `CLAUDE.md` while cache is COLD (`ttlRemainingSeconds === 0` / cold turn)
  const coldClaudeMdTtlZero = evaluateDet09PrefixMutationFence(
    {
      filePath: 'CLAUDE.md',
      currentModel: 'claude-opus-5-5',
      cachedTokens: 88_000,
      cacheWarm: true,
      ttlRemainingSeconds: 0
    },
    { mode: 'AUTO_PILOT' }
  );
  assert.equal(coldClaudeMdTtlZero.detectorId, 'DET-09');
  assert.equal(coldClaudeMdTtlZero.triggered, false);
  assert.equal(coldClaudeMdTtlZero.queued, false);
  assert.equal(coldClaudeMdTtlZero.decision, 'allow');

  const preToolColdClaudeMd = engine.evaluatePreToolUse(
    {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'CLAUDE.md',
        old_string: '# Rules',
        new_string: '# Updated Rules'
      }
    },
    {
      modelId: 'claude-opus-5-5',
      promptCache: { warm: false, ttlSeconds: 0, ttlTier: '5m' },
      contextWindow: { cachedTokens: 0, totalInputTokens: 12_000 }
    }
  );
  assert.equal(preToolColdClaudeMd.triggered, false);
  assert.equal(preToolColdClaudeMd.decision, 'allow');
});

test('ISS-061a [DET-12]: Haiku 5.5 < 90k prompt envelope and Sonnet/Opus 5.5 at 120k return triggered === false', () => {
  // 1. claude-haiku-5-5 at 70,000 total prompt tokens (40k fresh + 25k cacheRead + 5k cacheCreate)
  const haiku70k = evaluateDet12HaikuPreCliffBreaker({
    modelId: 'claude-haiku-5-5',
    inputTokens: 40_000,
    cacheReadTokens: 25_000,
    cacheWriteTokens: 5_000
  });
  assert.equal(haiku70k.detectorId, 'DET-12');
  assert.equal(haiku70k.totalInputTokens, 70_000);
  assert.equal(haiku70k.triggered, false);
  assert.equal(haiku70k.decision, 'allow');

  // 2. claude-sonnet-5-5 and claude-opus-5-5 at 120,000 total prompt tokens (cliff is at 200k, not 100k)
  for (const modelId of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    const res = evaluateDet12HaikuPreCliffBreaker({
      modelId,
      inputTokens: 30_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 10_000
    });
    assert.equal(res.totalInputTokens, 120_000);
    assert.equal(res.triggered, false, `${modelId} at 120k must not trigger DET-12`);
    assert.equal(res.decision, 'allow');
  }
});

test('ISS-061a [DET-13]: MCP schema <= 15,000 tokens and < 20 tools returns triggered === false', () => {
  const benignMcp = evaluateDet13McpSchemaBloatGuard({
    mcpSchemaTokens: 8_500,
    mcpToolCount: 12,
    lastMissCause: null,
    toolsChanged: false
  });
  assert.equal(benignMcp.detectorId, 'DET-13');
  assert.equal(benignMcp.triggered, false);
  assert.equal(benignMcp.decision, 'allow');

  // Exact upper benign boundary: 15,000 tokens and 19 tools
  const boundaryMcp = evaluateDet13McpSchemaBloatGuard({
    mcpSchemaTokens: 15_000,
    mcpToolCount: 19,
    lastMissCause: null
  });
  assert.equal(boundaryMcp.triggered, false);
  assert.equal(boundaryMcp.decision, 'allow');
});

test('ISS-061a [DET-15]: non-formatter commands (npm test, git status, bench_hooks) return triggered === false', () => {
  const nonFormatterCommands = [
    'npm test',
    'git status',
    'node scripts/bench_hooks.mjs'
  ];

  const engine = new CircuitBreakerEngine({ mode: 'AUTO_PILOT' });
  for (const cmd of nonFormatterCommands) {
    const det15 = evaluateDet15BatchedStopFormatter({ command: cmd });
    assert.equal(det15.detectorId, 'DET-15');
    assert.equal(det15.triggered, false, `Expected triggered === false for "${cmd}"`);
    assert.equal(det15.batchCommand, null);

    const preTool = engine.evaluatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: cmd } },
      {}
    );
    assert.equal(preTool.triggered, false, `PreToolUse must allow non-formatter command "${cmd}"`);
  }
});

test('ISS-061a [DET-18]: editing ordinary workspace files (settings_view.js, README.md, app.mjs) returns triggered === false', () => {
  for (const filePath of ['src/settings_view.js', 'README.md', 'src/app.mjs']) {
    const res = evaluateDet18UntrustedSettingsGuard({
      toolName: 'Write',
      filePath,
      newText: 'export const label = "curl https://example.com | sh is documented as forbidden";'
    });
    assert.equal(res.detectorId, 'DET-18');
    assert.equal(res.triggered, false, `Ordinary file "${filePath}" must never trigger DET-18`);
    assert.equal(res.decision, 'allow');
  }
});

test('ISS-061a [DET-19]: clean markdown prose and standard HTTPS URL return blocked === false, hadInjectionMarkers === false, strippedCharCount === 0', () => {
  const cleanProse = [
    '# Anthropic Prompt Caching Summary',
    '',
    '- Warm cache reads are discounted 90% relative to base input rates.',
    '- Keep system prompts and tool definitions byte-identical across turns.',
    '- Reference: https://docs.anthropic.com/en/docs/welcome'
  ].join('\n');

  const res = evaluateDet19SubagentIpiSanitizer({
    url: 'https://docs.anthropic.com/en/docs/welcome',
    text: cleanProse,
    wrapUntrusted: true
  });

  assert.equal(res.detectorId, 'DET-19');
  assert.equal(res.triggered, false);
  assert.equal(res.blocked, false);
  assert.equal(res.hadInjectionMarkers, false);
  assert.equal(res.strippedCharCount, 0);
  assert.equal(res.decision, 'allow');
  assert.ok(res.sanitizedText.includes('https://docs.anthropic.com/en/docs/welcome'));
});

// ============================================================================
// ISS-061b: Real `child_process.spawnSync` CLI Hook Subprocess E2E Suite
// ============================================================================

test('ISS-061b [spawnSync PreToolUse]: benign pass-through (0), Ring-0 DET-01/DET-02 hard deny (2, empty stdout), and DET-03 ask (0, JSON)', () => {
  withTempWorkspace(({ workDir, homeDir }) => {
    // 1. Benign Bash payload -> exit 0, empty stdout
    const benign = spawnHookProcess(
      HANDLERS.preToolUse,
      [],
      {
        session_id: 'spawn-s1',
        cwd: workDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' }
      },
      { workDir, homeDir }
    );
    assert.equal(benign.status, 0);
    assert.equal(benign.stdout.trim(), '');

    // 2a. Ring-0 DET-01 (`git commit --no-verify`) -> exit 2, empty stdout, explanatory stderr
    const det01 = spawnHookProcess(
      HANDLERS.preToolUse,
      [],
      {
        session_id: 'spawn-s1',
        cwd: workDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit --no-verify -m "bypass"' }
      },
      { workDir, homeDir }
    );
    assert.equal(det01.status, 2);
    assert.equal(det01.stdout.trim(), '');
    assert.match(det01.stderr, /DET-01/);

    // 2b. Ring-0 DET-02 (`.env` secret read) -> exit 2, empty stdout, explanatory stderr
    const det02 = spawnHookProcess(
      HANDLERS.preToolUse,
      [],
      {
        session_id: 'spawn-s1',
        cwd: workDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: path.join(workDir, '.env') }
      },
      { workDir, homeDir }
    );
    assert.equal(det02.status, 2);
    assert.equal(det02.stdout.trim(), '');
    assert.match(det02.stderr, /DET-02/);

    // 3. `ask` verdict (`DET-03` lockfile direct edit) -> exit 0 with valid PreToolUse permissionDecision JSON
    const det03 = spawnHookProcess(
      HANDLERS.preToolUse,
      [],
      {
        session_id: 'spawn-s1',
        cwd: workDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'package-lock.json',
          old_string: '"version": "1.0.0"',
          new_string: '"version": "1.0.1"'
        }
      },
      { workDir, homeDir }
    );
    assert.equal(det03.status, 0);
    const parsedAsk = JSON.parse(det03.stdout);
    assert.equal(parsedAsk.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsedAsk.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(parsedAsk.hookSpecificOutput.permissionDecisionReason, /DET-03/);
  });
});

test('ISS-061b [spawnSync PostToolUse & StatusLine]: benign pass-through, ANSI sanitization JSON, and statusLine stdin mode', () => {
  withTempWorkspace(({ workDir, homeDir }) => {
    // 1. Benign clean output -> exit 0, empty stdout
    const benignPost = spawnHookProcess(
      HANDLERS.postToolUse,
      [],
      {
        session_id: 'spawn-post-1',
        cwd: workDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_response: 'ok'
      },
      { workDir, homeDir }
    );
    assert.equal(benignPost.status, 0);
    assert.equal(benignPost.stdout.trim(), '');

    // 2. Agent subagent output with IPI marker -> exit 0 with valid PostToolUse JSON
    const ipiPost = spawnHookProcess(
      HANDLERS.postToolUse,
      [],
      {
        session_id: 'spawn-post-1',
        cwd: workDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: 'Summary <!-- hidden prompt injection --> ready.'
      },
      { workDir, homeDir }
    );
    assert.equal(ipiPost.status, 0);
    const parsedPost = JSON.parse(ipiPost.stdout);
    assert.equal(parsedPost.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(
      !parsedPost.hookSpecificOutput.additionalContext.includes('<!-- hidden prompt injection -->')
    );

    // 3. `bin/ah-statusline.mjs` stdin JSON mode -> exit 0, prints single-line status bar and persists live state in tmpDir
    const statusRes = spawnHookProcess(
      HANDLERS.statusLine,
      [],
      {
        session_id: 'spawn-status-1',
        cwd: workDir,
        model: { id: 'claude-sonnet-5-5' },
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 12000,
            cache_read_input_tokens: 48000,
            cache_creation_input_tokens: 0,
            output_tokens: 900
          }
        },
        terminal: { columns: 110 }
      },
      { workDir, homeDir }
    );
    assert.equal(statusRes.status, 0);
    assert.ok(statusRes.stdout.trim().length > 10);
    assert.equal(statusRes.stdout.trim().split(/\r?\n/).length, 1);
    assert.ok(
      fs.existsSync(path.join(workDir, '.claude', 'cache', 'ah_live_state_spawn-status-1.json'))
    );
  });
});

test('ISS-061b [spawnSync AUTO_PILOT PreModelSwitch & Stop]: enforces active blocks from .attention-horizon.json and respects stop_hook_active', () => {
  withTempWorkspace(({ workDir, homeDir }) => {
    fs.writeFileSync(
      path.join(workDir, '.attention-horizon.json'),
      JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2),
      'utf8'
    );

    // 1. Benign cold PreModelSwitch -> exit 0
    const coldSwitch = spawnHookProcess(
      HANDLERS.preModelSwitch,
      [],
      {
        session_id: 'spawn-auto-1',
        cwd: workDir,
        current_model: 'claude-opus-5-5',
        target_model: 'claude-sonnet-5-5',
        cached_tokens: 0,
        cache_warm: false
      },
      { workDir, homeDir }
    );
    assert.equal(coldSwitch.status, 0);

    // 2. Warm Opus -> Sonnet downgrade above C* in AUTO_PILOT -> exit 2 hard hold, empty stdout, DET-08 stderr
    const warmSwitch = spawnHookProcess(
      HANDLERS.preModelSwitch,
      [],
      {
        session_id: 'spawn-auto-1',
        cwd: workDir,
        current_model: 'claude-opus-5-5',
        target_model: 'claude-sonnet-5-5',
        cached_tokens: 85_000,
        cache_warm: true
      },
      { workDir, homeDir }
    );
    assert.equal(warmSwitch.status, 2);
    assert.equal(warmSwitch.stdout.trim(), '');
    assert.match(warmSwitch.stderr, /DET-08/);

    // 3. Stop gate in AUTO_PILOT with unverified source edit -> exit 0 with `{ decision: 'block', reason }` JSON
    const blockedStop = spawnHookProcess(
      HANDLERS.stopGate,
      [],
      {
        session_id: 'spawn-auto-1',
        cwd: workDir,
        hook_event_name: 'Stop',
        stop_hook_active: false,
        editedFiles: ['src/engine.mjs'],
        codeEditedSinceLastTest: true
      },
      { workDir, homeDir }
    );
    assert.equal(blockedStop.status, 0);
    const stopJson = JSON.parse(blockedStop.stdout);
    assert.equal(stopJson.decision, 'block');
    assert.match(stopJson.reason, /DET-14/);

    // 4. `stop_hook_active: true` in Stop gate -> exits 0 immediately with empty stdout (zero infinite recursion!)
    const recursiveStop = spawnHookProcess(
      HANDLERS.stopGate,
      [],
      {
        session_id: 'spawn-auto-1',
        cwd: workDir,
        hook_event_name: 'Stop',
        stop_hook_active: true,
        editedFiles: ['src/engine.mjs'],
        codeEditedSinceLastTest: true
      },
      { workDir, homeDir }
    );
    assert.equal(recursiveStop.status, 0);
    assert.equal(recursiveStop.stdout.trim(), '');
  });
});

test('ISS-061b [spawnSync CompactLifecycle]: covers PreCompact, SessionStart, PostCompact, and WorktreeCreate', () => {
  withTempWorkspace(({ workDir, homeDir }) => {
    // 1. PreCompact (`--phase=pre`) flushes StateBaton to tmpDir/.claude/cache/
    const preRes = spawnHookProcess(
      HANDLERS.compactLifecycle,
      ['--phase=pre'],
      {
        session_id: 'spawn-compact-1',
        cwd: workDir,
        hook_event_name: 'PreCompact',
        trigger: 'manual',
        activeGoal: 'Finish Batch 5 verification',
        verifiedInvariants: ['Preserve Mod Laws 1-5'],
        workingSetFiles: ['hooks/register.js']
      },
      { workDir, homeDir }
    );
    assert.equal(preRes.status, 0);
    assert.equal(preRes.stdout.trim(), '');

    // 2. SessionStart (`--phase=start`) hydrates the flushed StateBaton onto stdout JSON
    const startRes = spawnHookProcess(
      HANDLERS.compactLifecycle,
      ['--phase=start'],
      {
        session_id: 'spawn-compact-1',
        cwd: workDir,
        hook_event_name: 'SessionStart',
        source: 'compact'
      },
      { workDir, homeDir }
    );
    assert.equal(startRes.status, 0);
    const startJson = JSON.parse(startRes.stdout);
    assert.equal(startJson.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(startJson.hookSpecificOutput.additionalContext, /Finish Batch 5 verification/);

    // 3. PostCompact (`--phase=post`) flushes queued mutations cleanly
    const postRes = spawnHookProcess(
      HANDLERS.compactLifecycle,
      ['--phase=post'],
      {
        session_id: 'spawn-compact-1',
        cwd: workDir,
        hook_event_name: 'PostCompact'
      },
      { workDir, homeDir }
    );
    assert.equal(postRes.status, 0);
    assert.equal(postRes.stdout.trim(), '');

    // 4. WorktreeCreate (both event-inferred and `--phase=worktree`) exits 0 with empty stdout
    for (const args of [[], ['--phase=worktree']]) {
      const wtRes = spawnHookProcess(
        HANDLERS.compactLifecycle,
        args,
        {
          session_id: 'spawn-compact-1',
          cwd: workDir,
          hook_event_name: 'WorktreeCreate',
          name: 'feature-wt'
        },
        { workDir, homeDir }
      );
      assert.equal(wtRes.status, 0);
      assert.equal(wtRes.stdout.trim(), '');
    }
  });
});

test('ISS-061b [spawnSync Malformed Stdin]: guard hooks fail CLOSED (exit 2) while advisory hooks fail SAFE (exit 0)', () => {
  withTempWorkspace(({ workDir, homeDir }) => {
    const malformed = '{malformed-json-payload-without-closing-brace';

    // Guard hooks MUST fail CLOSED (`status === 2`, empty stdout)
    for (const guardScript of [HANDLERS.preToolUse, HANDLERS.preModelSwitch]) {
      const res = spawnHookProcess(guardScript, [], malformed, { workDir, homeDir });
      assert.equal(
        res.status,
        2,
        `Guard hook ${path.basename(guardScript)} must exit 2 (fail-closed) on malformed stdin`
      );
      assert.equal(res.stdout.trim(), '');
      assert.ok(res.stderr.trim().length > 0);
    }

    // Advisory & UI hooks MUST fail SAFE (`status === 0`)
    for (const [script, args] of [
      [HANDLERS.postToolUse, []],
      [HANDLERS.compactLifecycle, ['--phase=pre']],
      [HANDLERS.stopGate, []],
      [HANDLERS.statusLine, []]
    ]) {
      const res = spawnHookProcess(script, args, malformed, { workDir, homeDir });
      assert.equal(
        res.status,
        0,
        `Advisory hook ${path.basename(script)} must exit 0 (fail-safe) on malformed stdin`
      );
    }
  });
});

// ============================================================================
// ISS-062: Authentic Antigravity `leases[]` Interop & Hardened Token/AST Static-Compliance Validators
// ============================================================================

test('ISS-062 [DET-20 Antigravity leases[]]: authentic { version: 1, leases: [...] } blocks conflicting scope and allows non-conflicting or same-owner edits', () => {
  withTempWorkspace(({ workDir }) => {
    const nowMs = Date.now();
    const lockDir = path.join(workDir, '.agents', 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, 'active_scopes.json'),
      JSON.stringify(
        {
          version: 1,
          leases: [
            {
              agent_id: 'antigravity-ide-session-1',
              session_id: '25520b4b-909e-4688-896d-95523af52c4e',
              files_locked: ['src/core/*'],
              acquired_at: new Date(nowMs - 5000).toISOString(),
              expires_at: new Date(nowMs + 895000).toISOString(),
              ttl_ms: 900000
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );

    // 1. Conflicting edit (`src/core/engine.mjs`) by a different Claude Code agent -> DENIED
    const conflict = evaluateDet20ScopeLockAndQuotaBrake(
      {
        agentId: 'claude-code-worker-2',
        sessionId: 'cc-session-99',
        filePath: 'src/core/engine.mjs',
        nowMs
      },
      { cwd: workDir }
    );
    assert.equal(conflict.triggered, true);
    assert.equal(conflict.decision, 'deny');
    assert.match(conflict.reason, /antigravity-ide-session-1/);

    // 2. Non-conflicting edit (`src/ui/panel.mjs`) by a different Claude Code agent -> ALLOWED
    const nonConflict = evaluateDet20ScopeLockAndQuotaBrake(
      {
        agentId: 'claude-code-worker-2',
        sessionId: 'cc-session-99',
        filePath: 'src/core-isomorphic/ui/panel.mjs',
        nowMs
      },
      { cwd: workDir }
    );
    assert.equal(nonConflict.triggered, false);
    assert.equal(nonConflict.decision, 'allow');

    // 3. Same owner (`antigravity-ide-session-1`) editing its own locked scope -> ALLOWED
    const sameOwner = evaluateDet20ScopeLockAndQuotaBrake(
      {
        agentId: 'antigravity-ide-session-1',
        filePath: 'src/core/engine.mjs',
        nowMs
      },
      { cwd: workDir }
    );
    assert.equal(sameOwner.triggered, false);
    assert.equal(sameOwner.decision, 'allow');
  });
});

test('ISS-062 [Mod Laws 1-5 Static Validators]: catches nested/shorthand/decoy violations while allowing valid pure-JS Mod idioms', () => {
  // Law 1: Assignment & destructuring vs direct capability call return assignment
  assert.equal(validateModLaw1('const alias = $;').ok, false);
  assert.equal(validateModLaw1('const storeRef = $.store;').ok, false);
  assert.equal(validateModLaw1('const getter = $.store.get;').ok, false);
  assert.equal(validateModLaw1('const { store } = $;').ok, false);
  assert.equal(validateModLaw1("const val = $.store.get('k'); // const bad = $;").ok, true);

  // Law 2: Balanced call-arg, object-shorthand, array, template interpolation, and helper params
  const badLaw2Snippets = [
    `export default function register(on) { on('turn.step', (e, $) => { helper(foo(), $); }); }`,
    `export default function register(on) { on('turn.step', (e, $) => { helper(a, $.store); }); }`,
    `export default function register(on) { on('turn.step', (e, $) => { helper({ $ }); }); }`,
    `export default function register(on) { on('turn.step', (e, $) => { const o = { s: $.store }; }); }`,
    `export default function register(on) { on('turn.step', (e, $) => { const arr = [$]; }); }`,
    'export default function register(on) { on(\'turn.step\', (e, $) => { const s = `${$}`; }); }',
    `function leak($) { return $; }`
  ];
  for (const snippet of badLaw2Snippets) {
    const res = validateModLaw2(snippet);
    assert.equal(res.ok, false, `Expected Law 2 failure for: ${snippet}`);
  }

  const goodLaw2Snippet = `
    // Passing $ or { $ } in comments or "$ in strings" is ignored
    export default function register(on) {
      on('tool.call', async (event, $, next) => {
        const label = "do not flag $ or $.store inside string literals";
        const ok = Boolean($.store.get('flag'));
        $.store.set('payload', JSON.stringify({ label, ok }));
        return await next(event);
      });
    }
  `;
  assert.equal(validateModLaw2(goodLaw2Snippet).ok, true);
  assert.equal(validateModLaw3(goodLaw2Snippet).ok, true);

  // Law 4: Complete ESM import/re-export parser & forbidden API detector
  const allEsmForms = `
    // import fake from 'node:fs';
    const str = "import bad from 'node:path'";
    import defOnly from './a.mjs';
    import * as nsOnly from '../b.mjs';
    import { x, y as z } from './c.mjs';
    import defAndNamed, { m } from '../d.mjs';
    import defAndNs, * as ns2 from './e.mjs';
    import './side-effect.mjs';
    export * from './re1.mjs';
    export * as reNs from '../re2.mjs';
    export { x } from './re3.mjs';
  `;
  const parsedImports = validateModLaw4Imports(allEsmForms);
  assert.equal(parsedImports.ok, true);
  assert.deepEqual(parsedImports.specifiers, [
    './a.mjs',
    '../b.mjs',
    './c.mjs',
    '../d.mjs',
    './e.mjs',
    './side-effect.mjs',
    './re1.mjs',
    '../re2.mjs',
    './re3.mjs'
  ]);

  assert.equal(validateModLaw4Imports(`import fs from 'node:fs';`).ok, false);
  assert.equal(validateModLaw4Imports(`import pkg from 'lodash';`).ok, false);
  assert.equal(validateModLaw4Imports(`const x = require('./a.js');`).ok, false);
  assert.equal(validateModLaw4Imports(`const m = await import('./a.mjs');`).ok, false);
  assert.equal(validateModLaw4Imports(`const fs = process.getBuiltinModule('node:fs');`).ok, false);

  // Law 5: Exact `on('tool.call', ...)` fail-closed verifier (cannot be fooled by decoy `.catch` elsewhere!)
  const decoyUnguardedToolCall = `
    export default function register(on) {
      Promise.resolve().catch(() => ({ decision: 'deny', reason: 'decoy elsewhere in file' }));
      on('tool.call', async (event, $, next) => {
        return await next(event);
      });
    }
  `;
  assert.equal(validateModLaw5ToolCallCatch(decoyUnguardedToolCall).ok, false);

  const rethrowingCatchToolCall = `
    export default function register(on) {
      on('tool.call', (event, $, next) => {
        return Promise.resolve().then(() => next(event)).catch((err) => {
          throw err;
        });
      });
    }
  `;
  assert.equal(validateModLaw5ToolCallCatch(rethrowingCatchToolCall).ok, false);

  const failOpenCatchToolCall = `
    export default function register(on) {
      on('tool.call', (event, $, next) => {
        return Promise.resolve().then(() => next(event)).catch(() => ({ decision: 'allow' }));
      });
    }
  `;
  assert.equal(validateModLaw5ToolCallCatch(failOpenCatchToolCall).ok, false);

  const validChainedCatchToolCall = `
    export default function register(on) {
      on('tool.call', (event, $, next) => {
        return Promise.resolve()
          .then(async () => await next(event))
          .catch((err) => ({ decision: 'deny', reason: String(err) }));
      });
    }
  `;
  assert.equal(validateModLaw5ToolCallCatch(validChainedCatchToolCall).ok, true);

  const validAsyncTryCatchToolCall = `
    export default function register(on) {
      on('tool.call', async (event, $, next) => {
        try {
          return await next(event);
        } catch (err) {
          return { decision: 'deny', reason: String(err) };
        }
      });
    }
  `;
  assert.equal(validateModLaw5ToolCallCatch(validAsyncTryCatchToolCall).ok, true);
});

// ============================================================================
// ISS-065: Zero Silent Catch Audit, Bounded `ah_diagnostics.jsonl` Ring Buffer & `doctor` Surface
// ============================================================================

test('ISS-065 [Static Audit]: zero empty or comment-only catch blocks remain in hooks/register.js, savedQuotaLedger.mjs, or stateBatonHydrator.mjs', () => {
  const auditedFiles = [
    path.join(PROJECT_ROOT, 'hooks', 'register.js'),
    path.join(PROJECT_ROOT, 'src', 'core-isomorphic', 'coach', 'savedQuotaLedger.mjs'),
    path.join(PROJECT_ROOT, 'src', 'core-isomorphic', 'coach', 'stateBatonHydrator.mjs')
  ];

  for (const filePath of auditedFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const tokens = scanJsTokens(source);
    let catchCount = 0;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'ident' || tokens[i].value !== 'catch') continue;
      // Ignore `.catch(...)` method invocations
      if (tokens[i - 1]?.type === 'punct' && tokens[i - 1].value === '.') continue;

      catchCount += 1;
      let cursor = i + 1;
      if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '(') {
        while (cursor < tokens.length && !(tokens[cursor].type === 'punct' && tokens[cursor].value === ')')) {
          cursor += 1;
        }
        cursor += 1;
      }

      assert.equal(tokens[cursor]?.value, '{', `Expected catch block brace in ${path.basename(filePath)}`);
      let depth = 0;
      let closeIdx = -1;
      for (let k = cursor; k < tokens.length; k++) {
        if (tokens[k].type === 'punct' && tokens[k].value === '{') depth += 1;
        else if (tokens[k].type === 'punct' && tokens[k].value === '}') {
          depth -= 1;
          if (depth === 0) {
            closeIdx = k;
            break;
          }
        }
      }
      assert.ok(closeIdx > cursor + 1, `Empty/comment-only catch block found in ${path.basename(filePath)}`);
      const bodySlice = tokens.slice(cursor + 1, closeIdx);
      const callsDiagnostic = bodySlice.some(
        (t) => t.type === 'ident' && t.value === 'recordRuntimeDiagnostic'
      );
      assert.equal(
        callsDiagnostic,
        true,
        `Every catch block in ${path.basename(filePath)} must call recordRuntimeDiagnostic`
      );
    }

    assert.ok(catchCount >= 1, `Expected at least 1 audited catch block in ${path.basename(filePath)}`);
  }
});

test('ISS-065 [Runtime Diagnostics & Doctor Surface]: records fault-injected errors cleanly without stdout, bounds 50-line JSONL + pure-V8 ring, redacts homeDir, and surfaces in doctor', async () => {
  await withTempWorkspace(async ({ workDir, homeDir }) => {
    clearInMemoryRuntimeDiagnostics();

    // Capture `process.stdout.write` during fault injection to prove ZERO stdout writes
    const originalStdoutWrite = process.stdout.write;
    let capturedStdout = '';
    process.stdout.write = (chunk) => {
      capturedStdout += String(chunk);
      return true;
    };

    try {
      // 1. Fault-inject `hooks/register.js` (`file.changed` and `tool.call`) with explicit tmp `cwd`
      const handlers = new Map();
      register((evt, fn) => handlers.set(evt, fn));

      const throwingStoreCap = {
        store: {
          get() {
            throw new Error(`Store read failure inside ${homeDir}/secret-config.json`);
          },
          set() {
            throw new Error(`Store write failure inside ${homeDir}/secret-store.db`);
          }
        },
        ui: { invalidate() {} },
        clock: { every: () => () => {} }
      };

      await handlers.get('file.changed')(
        { cwd: workDir, filePath: 'src/index.mjs' },
        throwingStoreCap
      );
      const failClosedToolVerdict = await handlers.get('tool.call')(
        { cwd: workDir, tool_name: 'Bash', tool_input: { command: 'echo ok' } },
        throwingStoreCap,
        async () => ({ decision: 'allow' })
      );
      assert.equal(failClosedToolVerdict.decision, 'deny');

      // 2. Fault-inject `savedQuotaLedger.mjs` (corrupted JSONL line)
      const ledgerDir = path.join(workDir, '.claude', 'cache');
      fs.mkdirSync(ledgerDir, { recursive: true });
      fs.writeFileSync(
        getLedgerFilePath({ cwd: workDir, homeDir }),
        '{"savedUSD":0.25,"savedTokens":1000,"category":"CACHE_READ_DISCOUNT"}\n{corrupted-ledger-line\n',
        'utf8'
      );
      const ledgerEntries = readLedgerEntries({ cwd: workDir, homeDir });
      assert.equal(ledgerEntries.length, 1);

      // 3. Fault-inject `stateBatonHydrator.mjs` (corrupted `state_baton.json` + malformed handoff mutation JSON)
      fs.writeFileSync(
        path.join(ledgerDir, 'state_baton_corrupt-sess.json'),
        '{broken-baton-json',
        'utf8'
      );
      handleSessionStartHydration(
        { session_id: 'corrupt-sess', source: 'compact' },
        { cwd: workDir, homeDir }
      );
      parsePortableHandoffMarkdown(
        [
          '# Highbeam State Baton Handoff',
          '## 5. Queued Cache-Prefix Mutations (Released on PostCompact)',
          '- **effort** (`effort`): `{broken-json-value`'
        ].join('\n'),
        { cwd: workDir, homeDir }
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    // Zero stdout pollution during diagnostic recording!
    assert.equal(capturedStdout, '');

    const diagPath = getDiagnosticsFilePath({ cwd: workDir });
    assert.equal(fs.existsSync(diagPath), true);

    const recordedSoFar = readRuntimeDiagnostics({ cwd: workDir, homeDir });
    assert.ok(recordedSoFar.length >= 5);
    const sources = new Set(recordedSoFar.map((e) => e.source));
    assert.ok(sources.has('hooks/register.js'));
    assert.ok(sources.has('savedQuotaLedger'));
    assert.ok(sources.has('stateBatonHydrator'));

    // Home path must be redacted (`~`) in persisted messages
    for (const entry of recordedSoFar) {
      assert.equal(entry.message.includes(homeDir), false);
    }

    // 4. Overflow test: record 60 additional entries and verify strict 50-line cap on disk
    for (let idx = 1; idx <= 60; idx++) {
      recordRuntimeDiagnostic(
        'hooks/register.js',
        `ringOverflowTest.${idx}`,
        new Error(`Synthetic fault #${idx} under ${homeDir}/file-${idx}.txt`),
        { cwd: workDir, homeDir }
      );
    }

    const rawLines = fs
      .readFileSync(diagPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    assert.equal(rawLines.length, 50, 'ah_diagnostics.jsonl must be bounded to at most 50 lines');
    const lastEntry = JSON.parse(rawLines[rawLines.length - 1]);
    assert.equal(lastEntry.operation, 'ringOverflowTest.60');
    assert.match(lastEntry.message, /~\/file-60\.txt|~\\file-60\.txt/);

    // 5. Verify `inspectHookDiagnostics`, `runDoctorDiagnostics`, `ah-claude doctor --json`, and `ah-claude doctor --diagnostic`
    const hookDiag = inspectHookDiagnostics({ cwd: workDir, homeDir });
    assert.equal(hookDiag.recentErrorCount, 50);
    assert.equal(hookDiag.recentErrors.length, 5);
    assert.equal(hookDiag.recentErrors[4].operation, 'ringOverflowTest.60');

    const doctorRes = runDoctorDiagnostics({ cwd: workDir, homeDir });
    assert.equal(doctorRes.checks.length, 7);
    assert.equal(doctorRes.hookDiagnostics.recentErrorCount, 50);
    assert.equal(doctorRes.hookDiagnostics.recentErrors.length, 5);

    const cliDocText = runCli(['doctor'], { cwd: workDir, homeDir });
    assert.match(cliDocText.output, /hook_diagnostics: 50 recent non-fatal error\(s\)/);
    assert.match(cliDocText.output, /ringOverflowTest\.60/);

    const cliDocRes = runCli(['doctor', '--json'], { cwd: workDir, homeDir });
    assert.equal(cliDocRes.data.hookDiagnostics.recentErrorCount, 50);
    const parsedCliDoc = JSON.parse(cliDocRes.output);
    assert.equal(parsedCliDoc.hookDiagnostics.recentErrorCount, 50);
    assert.equal(parsedCliDoc.hookDiagnostics.recentErrors.length, 5);

    const diagBundle = runCli(['doctor', '--diagnostic'], { cwd: workDir, homeDir });
    assert.equal(diagBundle.data.hookDiagnostics.recentErrorCount, 50);
    assert.match(diagBundle.output, /Recent Runtime Diagnostics/);
    assert.match(diagBundle.output, /ringOverflowTest\.60/);

    // 6. Verify pure-V8 Mod sandbox mode (`registerNodeIo(null)`, no `getBuiltinModule`) uses bounded 50-entry in-memory ring
    const savedIo = getNodeIo();
    const savedGetBuiltin = process.getBuiltinModule;
    try {
      clearInMemoryRuntimeDiagnostics();
      registerNodeIo(null);
      process.getBuiltinModule = undefined;

      for (let i = 1; i <= 55; i++) {
        recordRuntimeDiagnostic('hooks/register.js', `v8Sandbox.${i}`, new Error(`Sandbox err ${i}`));
      }
      const memEntries = readRuntimeDiagnostics();
      assert.equal(memEntries.length, 50);
      assert.equal(memEntries[0].operation, 'v8Sandbox.6');
      assert.equal(memEntries[49].operation, 'v8Sandbox.55');
    } finally {
      process.getBuiltinModule = savedGetBuiltin;
      registerNodeIo(savedIo);
      clearInMemoryRuntimeDiagnostics();
    }
  });
});
