/**
 * @file test/batch3_autopilot_detectors_interop.test.mjs
 * Comprehensive Regression & Interop Verification Suite for Batch 3 (`cc-attention-horizon`):
 *   - ISS-038: Stateful `AUTO_PILOT` / `COACH` / `SILENT` / `OFF` enforcement via `.attention-horizon.json`,
 *              persistent CLI breaker state across hook spawns (`.claude/cache/ah_breaker_state_<sessionId>.json`),
 *              `DET-06` `threshold` parameter fix, `DET-11` + `DET-13` wiring in `PreToolUse`, and
 *              `ah_flight_mode` + `ah_recent_file_changed` wiring in `hooks/register.js` for `TtlWatchdog`.
 *   - ISS-043: Hardened `DET-01` shell tokenizer (`HUSKY=0` commit-message / grep false-positive elimination,
 *              `git commit -u --no-verify` & `-mfoo --no-verify` bypass fixes, pipes/newlines/`$(...)` subshells,
 *              PowerShell `&` call operator & backtick escapes, `git config core.hooksPath`, and `git clean -uf`).
 *   - ISS-052: Cross-Edition `.attention-horizon.json` Semantic Slug Registry (all 20 canonical slugs + aliases),
 *              `detectorNamespace: "antigravity"` translation (`GA DET-01` -> `retry-churn` -> `CC DET-04`),
 *              and Ambiguous Legacy Disk Config Guard protecting Ring-0 security guards (`DET-01/02/18/19`).
 *   - ISS-055: Cross-harness `active_scopes.json` `locks[]` + `leases[]` normalization (`900_000`ms TTL + alias fields),
 *              UTC `HANDOFF_<YYYYMMDD_HHMMSS>.md` + `HANDOFF_LATEST.md` naming, `parsePortableHandoffMarkdown`,
 *              and cross-tool `SessionStart` markdown hydration without `state_baton.json`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  FLIGHT_MODES,
  normalizeFlightMode,
  isSilentOrOffMode
} from '../../src/core-isomorphic/coach/cacheGravityRouter.mjs';
import {
  CANONICAL_DETECTOR_IDS,
  RING0_SECURITY_DETECTOR_IDS,
  DETECTOR_SEMANTIC_SLUGS,
  DETECTOR_SEMANTIC_ALIASES,
  ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG,
  normalizeDetectorId,
  resolveDetectorSlug,
  resolveDetectorOverride,
  loadHorizonConfig,
  setDetectorOverride
} from '../../src/core-isomorphic/config/horizonConfig.mjs';
import {
  CircuitBreakerEngine,
  evaluateDet01GitAndShellSafety,
  evaluateDet06BlindSearchGuard
} from '../../src/core-isomorphic/guards/circuitBreakers.mjs';
import {
  DEFAULT_SCOPE_LOCK_TTL_MS,
  acquireScopeLock,
  readActiveScopeLocks,
  evaluateScopeAndQuotaBrake
} from '../../src/core-isomorphic/telemetry/scopeLockRegistry.mjs';
import {
  formatUtcHandoffTimestamp,
  parsePortableHandoffMarkdown,
  handlePreCompactBatonFlush,
  handleSessionStartHydration
} from '../../src/core-isomorphic/coach/stateBatonHydrator.mjs';
import { runPreModelSwitchHook } from '../../hooks/handlers/pre-model-switch.mjs';
import { runPreToolUseHook } from '../../hooks/handlers/pre-tool-use.mjs';
import { runPostToolUseHook } from '../../hooks/handlers/post-tool-use.mjs';
import { runStopGateHook } from '../../hooks/handlers/stop-gate.mjs';
import { runCompactLifecycleHook } from '../../hooks/handlers/compact-lifecycle.mjs';
import register from '../../hooks/register.js';

/**
 * Creates a fresh isolated temporary workspace directory and isolated global config path.
 * @param {string} prefix
 */
function makeTempWorkspace(prefix = 'ah-batch3-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cwd = path.join(tmpDir, 'repo');
  const globalConfigPath = path.join(tmpDir, 'global-ah-config.json');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    tmpDir,
    cwd,
    globalConfigPath,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

/**
 * Builds an in-memory Mod harness (`on`, `$`, `emit`, `store`, `clockCallbacks`, `invalidations`).
 */
function createModHarness() {
  const handlers = new Map();
  const storeMap = new Map();
  const clockCallbacks = [];
  const invalidations = [];

  const on = (eventName, fn) => {
    const list = handlers.get(eventName) || [];
    list.push(fn);
    handlers.set(eventName, list);
  };

  const $ = {
    store: {
      get: (k) => storeMap.get(k),
      set: (k, v) => storeMap.set(k, v)
    },
    ui: {
      invalidate: (target) => invalidations.push(target),
      open: () => {}
    },
    clock: {
      every: (_ms, cb) => {
        const entry = { cb, cancelled: false };
        clockCallbacks.push(entry);
        return () => {
          entry.cancelled = true;
        };
      }
    }
  };

  async function emit(eventName, event = {}, nextFn) {
    const list = handlers.get(eventName) || [];
    let lastResult;
    for (const fn of list) {
      lastResult = await fn(event, $, nextFn);
    }
    return lastResult;
  }

  return { on, $, storeMap, clockCallbacks, invalidations, emit };
}

// ============================================================================
// 1. ISS-038 — AUTO_PILOT / COACH / SILENT Enforcement, Persistent CLI State,
//              DET-06 threshold, Wired DET-11/13 & Mod TtlWatchdog Wiring
// ============================================================================

test('ISS-038a: .attention-horizon.json flightMode="AUTO_PILOT" is enforced by PreModelSwitch and Stop hooks', () => {
  const ws = makeTempWorkspace('ah-iss038a-');
  try {
    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2),
      'utf8'
    );

    // 1. PreModelSwitch without explicit event.mode reads AUTO_PILOT from .attention-horizon.json
    //    and hard-blocks a warm 50,000-token Opus 5.5 -> Sonnet 5.5 downgrade (above C* = 6,522)
    const switchRes = runPreModelSwitchHook(
      {
        cwd: ws.cwd,
        session_id: 'sess-ap-1',
        current_model: 'claude-opus-5-5',
        target_model: 'claude-sonnet-5-5',
        cached_tokens: 50000,
        cache_warm: true
      },
      { globalConfigPath: ws.globalConfigPath }
    );
    assert.equal(switchRes.exitCode, 2, 'AUTO_PILOT PreModelSwitch must hard-block with exitCode 2');
    assert.equal(switchRes.verdict.blocked, true);
    assert.match(switchRes.stderr, /DET-08|Cache Gravity/i);

    // 2. Stop gate without explicit event.mode reads AUTO_PILOT from .attention-horizon.json
    //    and blocks premature stop when codeEditedSinceLastTest is true (!stop_hook_active)
    const stopRes = runStopGateHook(
      {
        cwd: ws.cwd,
        session_id: 'sess-ap-1',
        stop_hook_active: false,
        codeEditedSinceLastTest: true,
        editedFiles: ['src/index.mjs']
      },
      { globalConfigPath: ws.globalConfigPath }
    );
    assert.equal(stopRes.exitCode, 0);
    assert.equal(stopRes.det14.decision, 'block');
    const stopJson = JSON.parse(stopRes.stdout);
    assert.equal(stopJson.decision, 'block');
    assert.match(stopJson.reason, /DET-14/);

    // Loop-safety invariant: when stop_hook_active is true, Stop gate NEVER blocks even in AUTO_PILOT
    const stopLoopSafe = runStopGateHook(
      {
        cwd: ws.cwd,
        session_id: 'sess-ap-1',
        stop_hook_active: true,
        codeEditedSinceLastTest: true,
        editedFiles: ['src/index.mjs']
      },
      { globalConfigPath: ws.globalConfigPath }
    );
    assert.equal(stopLoopSafe.det14.decision, 'allow');
    assert.equal(
      stopLoopSafe.stdout.includes('"decision":"block"'),
      false,
      'Stop gate must never emit decision:"block" when stop_hook_active is true'
    );
  } finally {
    ws.cleanup();
  }
});

test('ISS-038b: CLI breaker state persists across separate spawns for DET-04, custom DET-06 blindSearchLimit, and DET-14', () => {
  const ws = makeTempWorkspace('ah-iss038b-');
  try {
    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify(
        {
          flightMode: 'AUTO_PILOT',
          thresholds: {
            blindSearchLimit: 3
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const hookOpts = { cwd: ws.cwd, globalConfigPath: ws.globalConfigPath };

    // --- Part A: DET-06 custom blindSearchLimit (3) across separate CLI spawns ---
    for (let i = 1; i <= 3; i++) {
      const r = runPreToolUseHook(
        {
          session_id: 'sess-cli-streak',
          cwd: ws.cwd,
          tool_name: i % 2 === 1 ? 'Read' : 'Grep',
          tool_input: i % 2 === 1 ? { file_path: `src/f${i}.mjs` } : { pattern: 'foo' }
        },
        hookOpts
      );
      assert.equal(r.exitCode, 0);
      assert.equal(r.verdict.triggered, false, `Search #${i} within limit=3 must not trigger DET-06`);
    }

    // 4th sequential search (> 3) across a fresh CLI invocation triggers DET-06 advise_subagent!
    const fourthSearch = runPreToolUseHook(
      {
        session_id: 'sess-cli-streak',
        cwd: ws.cwd,
        tool_name: 'Glob',
        tool_input: { pattern: 'src/**/*.mjs' }
      },
      hookOpts
    );
    assert.equal(fourthSearch.exitCode, 0);
    assert.equal(fourthSearch.verdict.triggered, true);
    assert.equal(fourthSearch.verdict.detectorId, 'DET-06');
    const fourthJson = JSON.parse(fourthSearch.stdout);
    assert.equal(fourthJson.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(fourthJson.hookSpecificOutput.additionalContext, /DET-06|3 sequential/i);

    // Direct unit check that evaluateDet06BlindSearchGuard accepts both `threshold` and `limit`
    assert.equal(
      evaluateDet06BlindSearchGuard({ sequentialSearchCount: 4, threshold: 3 }).triggered,
      true
    );
    assert.equal(
      evaluateDet06BlindSearchGuard({ sequentialSearchCount: 4, limit: 3 }).triggered,
      true
    );

    // --- Part B: Edit in PreToolUse -> Stop in StopGate triggers DET-14 via persisted state ---
    const editRes = runPreToolUseHook(
      {
        session_id: 'sess-cli-streak',
        cwd: ws.cwd,
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/app.mjs',
          old_string: 'const a = 1;',
          new_string: 'const a = 2;'
        }
      },
      hookOpts
    );
    assert.equal(editRes.exitCode, 0);

    // Separate Stop spawn (with NO manual editedFiles/codeEditedSinceLastTest in payload) blocks via persisted state!
    const stopAfterEdit = runStopGateHook(
      {
        session_id: 'sess-cli-streak',
        cwd: ws.cwd,
        stop_hook_active: false
      },
      hookOpts
    );
    assert.equal(stopAfterEdit.det14.decision, 'block');
    assert.match(JSON.parse(stopAfterEdit.stdout).reason, /src\/app\.mjs/);

    // Running `npm test` via PreToolUse + PostToolUse (success) clears codeEditedSinceLastTest
    runPreToolUseHook(
      {
        session_id: 'sess-cli-streak',
        cwd: ws.cwd,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' }
      },
      hookOpts
    );
    runPostToolUseHook(
      {
        session_id: 'sess-cli-streak',
        cwd: ws.cwd,
        tool_name: 'Bash',
        tool_response: { stdout: 'all tests passed', exit_code: 0 }
      },
      hookOpts
    );

    const stopAfterTest = runStopGateHook(
      {
        session_id: 'sess-cli-streak',
        cwd: ws.cwd,
        stop_hook_active: false
      },
      hookOpts
    );
    assert.equal(stopAfterTest.det14.decision, 'allow');

    // --- Part C: DET-04 3 consecutive failing PostToolUse spawns -> 4th PreToolUse blocked ---
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pre = runPreToolUseHook(
        {
          session_id: 'sess-det04-cli',
          cwd: ws.cwd,
          tool_name: 'Bash',
          tool_input: { command: 'node broken.js' }
        },
        hookOpts
      );
      assert.equal(pre.exitCode, 0);

      runPostToolUseHook(
        {
          session_id: 'sess-det04-cli',
          cwd: ws.cwd,
          tool_name: 'Bash',
          is_error: true,
          tool_response: { stderr: `Error attempt ${attempt}`, exit_code: 1 }
        },
        hookOpts
      );
    }

    const fourthAttempt = runPreToolUseHook(
      {
        session_id: 'sess-det04-cli',
        cwd: ws.cwd,
        tool_name: 'Bash',
        tool_input: { command: 'node broken.js' }
      },
      hookOpts
    );
    assert.equal(fourthAttempt.exitCode, 2, '4th call after 3 consecutive CLI failures must be denied by DET-04');
    assert.equal(fourthAttempt.verdict.detectorId, 'DET-04');
  } finally {
    ws.cleanup();
  }
});

test('ISS-038c: DET-11 Context Rot and DET-13 MCP Schema Bloat are wired into evaluatePreToolUse once per turn', () => {
  const ws = makeTempWorkspace('ah-iss038c-');
  try {
    const engine = new CircuitBreakerEngine({
      cwd: ws.cwd,
      horizonConfig: loadHorizonConfig({ cwd: ws.cwd, globalConfigPath: ws.globalConfigPath }),
      mode: 'COACH'
    });

    // Clean PreToolUse with zero/absent distractor & MCP fields is completely unaffected
    const cleanVerdict = engine.evaluatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
      { contextWindow: { totalInputTokens: 40000 } }
    );
    assert.equal(cleanVerdict.triggered, false);

    // DET-11 triggers once on turn 1 when totalInputTokens > 60k and distractorRatio > 0.35
    const rotVerdict = engine.evaluatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'echo check' } },
      {
        turnCount: 1,
        contextWindow: {
          totalInputTokens: 82000,
          distractorRatio: 0.42
        }
      }
    );
    assert.equal(rotVerdict.triggered, true);
    assert.equal(rotVerdict.detectorId, 'DET-11');
    assert.equal(rotVerdict.decision, 'advise_compact');
    assert.match(rotVerdict.reason, /DET-11/);

    // Second tool call in the SAME turn (turnCount: 1) does not spam duplicate DET-11 advisory
    const rotSameTurn = engine.evaluatePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'echo check2' } },
      {
        turnCount: 1,
        contextWindow: {
          totalInputTokens: 82000,
          distractorRatio: 0.42
        }
      }
    );
    assert.equal(rotSameTurn.triggered, false);

    // DET-13 triggers on turn 2 when MCP schema tokens > 15k (or toolsChanged === true)
    const mcpVerdict = runPreToolUseHook(
      {
        cwd: ws.cwd,
        session_id: 'sess-det13',
        tool_name: 'Bash',
        tool_input: { command: 'echo mcp' }
      },
      {
        cwd: ws.cwd,
        globalConfigPath: ws.globalConfigPath,
        telemetryState: {
          turnCount: 2,
          mcpSchemaTokens: 19500,
          mcpToolCount: 28,
          toolsChanged: true
        }
      }
    );
    assert.equal(mcpVerdict.exitCode, 0);
    assert.equal(mcpVerdict.verdict.triggered, true);
    assert.equal(mcpVerdict.verdict.detectorId, 'DET-13');
    const mcpOut = JSON.parse(mcpVerdict.stdout);
    assert.equal(mcpOut.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(mcpOut.hookSpecificOutput.additionalContext, /DET-13/);
  } finally {
    ws.cleanup();
  }
});

test('ISS-038d: SILENT and OFF modes normalize cleanly, suppress coach advisories, and keep Ring-0 guards active', () => {
  const ws = makeTempWorkspace('ah-iss038d-');
  try {
    assert.equal(FLIGHT_MODES.SILENT, 'SILENT');
    assert.equal(FLIGHT_MODES.OFF, 'OFF');
    assert.equal(normalizeFlightMode('SILENT'), 'SILENT');
    assert.equal(normalizeFlightMode('silent'), 'SILENT');
    assert.equal(normalizeFlightMode('OFF'), 'OFF');
    assert.equal(isSilentOrOffMode('SILENT'), true);
    assert.equal(isSilentOrOffMode('OFF'), true);
    assert.equal(isSilentOrOffMode('COACH'), false);

    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify({ flightMode: 'SILENT' }, null, 2),
      'utf8'
    );
    const loadedSilent = loadHorizonConfig({ cwd: ws.cwd, globalConfigPath: ws.globalConfigPath });
    assert.equal(loadedSilent.flightMode, 'SILENT');

    const silentEngine = new CircuitBreakerEngine({
      cwd: ws.cwd,
      horizonConfig: loadedSilent,
      mode: 'SILENT'
    });

    // 8 sequential Read calls in SILENT mode suppress DET-06 coach advisory
    for (let i = 0; i < 8; i++) {
      const v = silentEngine.evaluatePreToolUse(
        { tool_name: 'Read', tool_input: { file_path: `src/mod${i}.mjs` } },
        { turnCount: 1, contextWindow: { totalInputTokens: 90000, distractorRatio: 0.5 } }
      );
      assert.equal(v.triggered, false, 'SILENT mode must suppress non-security coach advisories');
    }

    // Ring-0 security guards (DET-01 and DET-02) MUST STILL BLOCK in SILENT mode!
    const det01InSilent = silentEngine.evaluatePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git commit --no-verify -m "sneak"' }
    });
    assert.equal(det01InSilent.triggered, true);
    assert.equal(det01InSilent.detectorId, 'DET-01');
    assert.equal(det01InSilent.decision, 'deny');

    const det02InSilent = silentEngine.evaluatePreToolUse({
      tool_name: 'Read',
      tool_input: { file_path: '.env.production' }
    });
    assert.equal(det02InSilent.triggered, true);
    assert.equal(det02InSilent.detectorId, 'DET-02');
    assert.equal(det02InSilent.decision, 'deny');

    // Stop gate in SILENT mode does not nag or block
    const stopSilent = runStopGateHook(
      {
        cwd: ws.cwd,
        codeEditedSinceLastTest: true,
        editedFiles: ['src/a.mjs']
      },
      { globalConfigPath: ws.globalConfigPath }
    );
    assert.equal(stopSilent.det14.decision, 'allow');
    assert.equal(stopSilent.stdout, '');
  } finally {
    ws.cleanup();
  }
});

test('ISS-038e: hooks/register.js wires ah_flight_mode and ah_recent_file_changed so TtlWatchdog fires active alerts', async () => {
  const ws = makeTempWorkspace('ah-iss038e-');
  try {
    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify({ flightMode: 'AUTO_PILOT' }, null, 2),
      'utf8'
    );

    const mod = createModHarness();
    register(mod.on);

    // 1. Workspace Edit via tool.call syncs ah_flight_mode="AUTO_PILOT" and sets ah_recent_file_changed=true
    await mod.emit(
      'tool.call',
      {
        cwd: ws.cwd,
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/feature.mjs',
          old_string: 'export const x = 1;',
          new_string: 'export const x = 2;'
        }
      },
      async () => ({ ok: true })
    );

    assert.equal(mod.storeMap.get('ah_flight_mode'), 'AUTO_PILOT');
    assert.equal(mod.storeMap.get('ah_recent_file_changed'), true);

    // 2. Warm cache turn.step with T-8s remaining starts watchdog clock; tick fires AMBER + StateBaton snapshot!
    const nowMs = Date.now();
    await mod.emit('turn.step', {
      cwd: ws.cwd,
      sessionId: 'mod-sess-1',
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 1200,
        cache_read_input_tokens: 48000,
        output_tokens: 400
      },
      promptCache: {
        warm: true,
        ttlTier: '5m',
        expiresAt: nowMs + 8000
      }
    });

    assert.equal(mod.clockCallbacks.length, 1);

    // Simulate 4m52s of idle user think-time so T-8s remains on the 5-minute warm cache
    const liveTelemetry = mod.storeMap.get('ah_session_telemetry');
    liveTelemetry.promptCache.expiresAt = Date.now() + 8000;
    mod.storeMap.set('ah_session_telemetry', liveTelemetry);

    mod.clockCallbacks[0].cb();

    const tick = mod.storeMap.get('ah_ttl_tick');
    assert.ok(tick, 'TtlWatchdog tick must be stored in ah_ttl_tick');
    assert.notEqual(tick.statusReason, 'IDLE_NO_EDITS', 'TtlWatchdog must not exit early with IDLE_NO_EDITS after Edit');
    assert.equal(tick.amberAlertActive, true);
    assert.equal(tick.preSnapshotTriggered, true);
    assert.ok(mod.storeMap.get('ah_state_baton'), 'T-10s StateBaton snapshot must be saved in ah_state_baton');

    // 3. Running git commit clears ah_recent_file_changed
    await mod.emit(
      'tool.call',
      {
        cwd: ws.cwd,
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "ship feature"' }
      },
      async () => ({ ok: true })
    );
    assert.equal(mod.storeMap.get('ah_recent_file_changed'), false);

    // 4. file.changed sets ah_recent_file_changed=true, and classic.PostCompact clears it again
    await mod.emit('file.changed', { filePath: 'src/another.mjs' });
    assert.equal(mod.storeMap.get('ah_recent_file_changed'), true);

    await mod.emit('classic.PostCompact', { cwd: ws.cwd, sessionId: 'mod-sess-1' });
    assert.equal(mod.storeMap.get('ah_recent_file_changed'), false);

    await mod.emit('classic.Stop', {});
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 2. ISS-043 — Harden DET-01 Shell Tokenizer (Bash & PowerShell)
// ============================================================================

test('ISS-043a: DET-01 allows HUSKY=0 inside commit messages/grep, -mnotes, -uno, read-only git config, and dry-run git clean', () => {
  const benignCommands = [
    ['Bash', 'git commit -m "Fix HUSKY=0 false positive"'],
    ['Bash', "git commit -m 'Document HUSKY_SKIP_HOOKS=1 and SKIP_GIT_HOOKS=1'"],
    ['Bash', 'grep "HUSKY=0" src/guards/circuitBreakers.mjs'],
    ['Bash', 'rg "GIT_CONFIG_COUNT=1" test/'],
    ['Bash', 'git commit -mnotes'],
    ['Bash', 'git commit -uno -m "clean tracked commit"'],
    ['Bash', 'git config --get core.hooksPath'],
    ['Bash', 'git config --list'],
    ['Bash', 'git clean -n -d'],
    ['Bash', 'git clean -nd'],
    ['PowerShell', 'git commit -m "Fix HUSKY=0 false positive on PowerShell"']
  ];

  for (const [toolName, command] of benignCommands) {
    const res = evaluateDet01GitAndShellSafety({ toolName, command });
    assert.equal(
      res.triggered,
      false,
      `Expected benign [${toolName}] command to be allowed: ${command} (got reason: ${res.reason})`
    );
  }
});

test('ISS-043b: DET-01 blocks tokenized HUSKY/GIT_CONFIG env vars, -u/--no-verify, pipes/newlines/subshells, PowerShell & / backticks, core.hooksPath, and git clean -uf', () => {
  const maliciousVectors = [
    ['Bash', 'HUSKY=0 git commit -m "bypass"'],
    ['Bash', 'env HUSKY_SKIP_HOOKS=1 git commit -m "bypass"'],
    ['Bash', 'export SKIP_GIT_HOOKS=1 && git commit -m "bypass"'],
    ['Bash', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m "bypass"'],
    ['PowerShell', "$env:HUSKY = '0'; git commit -m 'bypass'"],
    ['PowerShell', '$env:HUSKY_SKIP_HOOKS = "1"; git commit -m "bypass"'],
    ['Bash', 'git commit -u --no-verify -m "bypass"'],
    ['Bash', 'git commit -mfoo --no-verify'],
    ['Bash', 'echo ok | git commit --no-verify -m "piped"'],
    ['Bash', 'echo ready\ngit commit --no-verify -m "newline"'],
    ['Bash', 'echo $(git commit --no-verify -m "subshell")'],
    ['Bash', 'echo `git commit --no-verify -m "backtick-subshell"`'],
    ['PowerShell', '& git commit --no-verify -m "call-op"'],
    ['PowerShell', '& "git.exe" commit --no-verify -m "quoted-exe"'],
    ['PowerShell', 'git commit `--no-verify -m "ps-backtick"'],
    ['Bash', 'git config core.hooksPath .git/empty'],
    ['Bash', 'git -ccore.hooksPath=/dev/null commit -m "attached-c"'],
    ['Bash', 'git clean -uf'],
    ['Bash', 'git clean -xfd']
  ];

  for (const [toolName, command] of maliciousVectors) {
    const res = evaluateDet01GitAndShellSafety({ toolName, command });
    assert.equal(
      res.triggered,
      true,
      `Expected bypass vector [${toolName}] to be DENIED: ${command}`
    );
    assert.equal(res.decision, 'deny');
  }
});

// ============================================================================
// 3. ISS-052 — Cross-Edition .attention-horizon.json Semantic Slug Registry &
//              Ring-0 Inversion Protection
// ============================================================================

test('ISS-052a: detectorNamespace="antigravity" translates GA numeric IDs via semantic slugs and NEVER disables CC DET-01 or DET-02', () => {
  const ws = makeTempWorkspace('ah-iss052a-');
  try {
    // Antigravity config where DET-01 = retry-churn ("off") and DET-02 = edit-oscillation ("off")
    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify(
        {
          detectorNamespace: 'antigravity',
          detectors: {
            'DET-01': 'off',
            'DET-02': 'off',
            'DET-10': 'warn'
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const cfg = loadHorizonConfig({ cwd: ws.cwd, globalConfigPath: ws.globalConfigPath });

    // GA DET-01 -> retry-churn -> CC DET-04 = off
    // GA DET-02 -> edit-oscillation -> CC DET-05 = off
    // GA DET-10 -> output-bomb -> CC DET-07 = warn
    assert.equal(resolveDetectorOverride('DET-04', cfg), 'off');
    assert.equal(resolveDetectorOverride('retry-churn', cfg), 'off');
    assert.equal(resolveDetectorOverride('DET-05', cfg), 'off');
    assert.equal(resolveDetectorOverride('DET-07', cfg), 'warn');

    // CRITICAL INVARIANT: CC DET-01 (git-shell-safety) and CC DET-02 (secret-boundary) MUST NOT BE OFF!
    assert.equal(resolveDetectorOverride('DET-01', cfg), 'default');
    assert.equal(resolveDetectorOverride('git-shell-safety', cfg), 'default');
    assert.equal(resolveDetectorOverride('DET-02', cfg), 'default');
    assert.equal(resolveDetectorOverride('secret-boundary', cfg), 'default');

    const engine = new CircuitBreakerEngine({ cwd: ws.cwd, horizonConfig: cfg, mode: 'COACH' });
    const gitBypass = engine.evaluatePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git commit --no-verify -m "test"' }
    });
    assert.equal(gitBypass.triggered, true);
    assert.equal(gitBypass.decision, 'deny', 'GA DET-01=off must NEVER disable CC git-shell-safety');

    const envRead = engine.evaluatePreToolUse({
      tool_name: 'Read',
      tool_input: { file_path: '.env' }
    });
    assert.equal(envRead.triggered, true);
    assert.equal(envRead.decision, 'deny', 'GA DET-02=off must NEVER disable CC secret-boundary');

    // Meanwhile CC DET-04 (retry-churn) WAS translated to "off"
    engine.recordToolOutcome(false, 'Bash');
    engine.recordToolOutcome(false, 'Bash');
    engine.recordToolOutcome(false, 'Bash');
    const retryRes = engine.evaluatePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'echo retry' }
    });
    assert.equal(retryRes.triggered, false, 'Translated GA DET-01 -> CC DET-04 (retry-churn) should be off');
  } finally {
    ws.cleanup();
  }
});

test('ISS-052b: Ambiguous legacy disk config clamps un-namespaced Ring-0 "off" to "warn", while semantic slugs & setDetectorOverride work end-to-end', () => {
  const ws = makeTempWorkspace('ah-iss052b-');
  try {
    // Verify all 32 canonical IDs & semantic slugs + aliases round-trip cleanly
    assert.equal(CANONICAL_DETECTOR_IDS.length, 32);
    assert.deepEqual(RING0_SECURITY_DETECTOR_IDS, ['DET-01', 'DET-02', 'DET-18', 'DET-19']);
    for (const detId of CANONICAL_DETECTOR_IDS) {
      const slug = resolveDetectorSlug(detId);
      assert.ok(slug, `Missing semantic slug for ${detId}`);
      assert.equal(normalizeDetectorId(slug), detId === 'DET-21' ? 'DET-30' : detId);
    }
    for (const [canonicalId, aliases] of Object.entries(DETECTOR_SEMANTIC_ALIASES)) {
      for (const alias of aliases) {
        assert.equal(normalizeDetectorId(alias), canonicalId === 'DET-21' ? 'DET-30' : canonicalId);
      }
    }
    assert.equal(ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG['DET-01'], 'retry-churn');
    assert.equal(ANTIGRAVITY_DETECTOR_TO_SEMANTIC_SLUG['DET-15'], 'secret-boundary');

    // 1. Un-namespaced legacy disk config with raw numeric Ring-0 "off" (no semantic slug, no detectorNamespace)
    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify(
        {
          detectors: {
            'DET-01': 'off',
            'DET-02': 'off',
            'DET-18': 'off',
            'DET-19': 'off',
            'DET-06': 'off'
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const legacyCfg = loadHorizonConfig({ cwd: ws.cwd, globalConfigPath: ws.globalConfigPath });
    assert.equal(resolveDetectorOverride('DET-01', legacyCfg), 'warn');
    assert.equal(resolveDetectorOverride('DET-02', legacyCfg), 'warn');
    assert.equal(resolveDetectorOverride('DET-18', legacyCfg), 'warn');
    assert.equal(resolveDetectorOverride('DET-19', legacyCfg), 'warn');
    assert.equal(resolveDetectorOverride('DET-06', legacyCfg), 'off', 'Non-Ring-0 DET-06=off is allowed');
    assert.equal(legacyCfg.warnings.length, 4, 'Must record 4 explanatory clamp warnings');

    // 2. Explicit semantic slug ("git-shell-safety": "off") in un-namespaced config IS unambiguous and honored
    fs.writeFileSync(
      path.join(ws.cwd, '.attention-horizon.json'),
      JSON.stringify(
        {
          detectors: {
            'DET-01': 'off',
            'git-shell-safety': 'off'
          }
        },
        null,
        2
      ),
      'utf8'
    );
    const slugConfirmedCfg = loadHorizonConfig({ cwd: ws.cwd, globalConfigPath: ws.globalConfigPath });
    assert.equal(resolveDetectorOverride('DET-01', slugConfirmedCfg), 'off');
    assert.equal(slugConfirmedCfg.warnings.length, 0);

    // 3. setDetectorOverride writes detectorNamespace: 'claude-code', canonical ID, semantic slug, and claudeDetectors
    const writeRes = setDetectorOverride('redundant-reread', 'off', {
      cwd: ws.cwd,
      globalConfigPath: ws.globalConfigPath
    });
    assert.equal(writeRes.detectorId, 'DET-06');
    assert.equal(writeRes.semanticSlug, 'blind-search');

    const rawWritten = JSON.parse(
      fs.readFileSync(path.join(ws.cwd, '.attention-horizon.json'), 'utf8')
    );
    assert.equal(rawWritten.detectorNamespace, 'claude-code');
    assert.equal(rawWritten.detectors['DET-06'], 'off');
    assert.equal(rawWritten.detectors['blind-search'], 'off');
    assert.equal(rawWritten.claudeDetectors['DET-06'], 'off');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 4. ISS-055 — Cross-Harness active_scopes.json Parity, UTC HANDOFF Naming &
//              SessionStart Markdown Hydration
// ============================================================================

test('ISS-055a: DET-20 & scopeLockRegistry normalize authentic Antigravity leases[] and write cross-compatible 900s locks', () => {
  const ws = makeTempWorkspace('ah-iss055a-');
  try {
    assert.equal(DEFAULT_SCOPE_LOCK_TTL_MS, 900_000);

    const nowMs = Date.now();
    const agyLocksDir = path.join(ws.cwd, '.agents', 'locks');
    fs.mkdirSync(agyLocksDir, { recursive: true });

    // Authentic Antigravity active_scopes.json payload (version: 1, leases[], ISO timestamps)
    fs.writeFileSync(
      path.join(agyLocksDir, 'active_scopes.json'),
      JSON.stringify(
        {
          version: 1,
          leases: [
            {
              agent_id: 'agy-worker-alpha',
              session_id: 'conv-agy-77',
              files_locked: ['src/guards/*'],
              acquired_at: new Date(nowMs - 10_000).toISOString(),
              expires_at: new Date(nowMs + 600_000).toISOString(),
              ttl_ms: 900_000
            },
            {
              trajectoryId: 'agy-stale-worker',
              claimedPaths: ['src/core-isomorphic/ui/*'],
              acquired_at: new Date(nowMs - 1_200_000).toISOString(),
              expires_at: new Date(nowMs - 60_000).toISOString()
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );

    const activeState = readActiveScopeLocks({ cwd: ws.cwd, nowMs });
    assert.equal(activeState.locks.length, 1, 'Active lease must be normalized while expired ISO lease is filtered');
    assert.equal(activeState.locks[0].ownerId, 'agy-worker-alpha');
    assert.deepEqual(activeState.locks[0].scopes, ['src/guards/*']);

    // Conflicting Claude Code Edit on src/guards/circuitBreakers.mjs is blocked by DET-20!
    const preEditBlocked = runPreToolUseHook(
      {
        cwd: ws.cwd,
        session_id: 'claude-session-1',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/guards/circuitBreakers.mjs',
          old_string: 'a',
          new_string: 'b'
        }
      },
      { cwd: ws.cwd, globalConfigPath: ws.globalConfigPath }
    );
    assert.equal(preEditBlocked.exitCode, 2);
    assert.equal(preEditBlocked.verdict.detectorId, 'DET-20');
    assert.match(preEditBlocked.stderr, /agy-worker-alpha/);

    // Non-conflicting Edit on src/ui/modViews.mjs (whose Antigravity lease expired) is allowed!
    const preEditAllowed = runPreToolUseHook(
      {
        cwd: ws.cwd,
        session_id: 'claude-session-1',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/core-isomorphic/ui/modViews.mjs',
          old_string: 'a',
          new_string: 'b'
        }
      },
      { cwd: ws.cwd, globalConfigPath: ws.globalConfigPath }
    );
    assert.equal(preEditAllowed.exitCode, 0);

    // Writing a Claude Code lock emits cross-compatible version: 1 + locks[] + leases[] with ISO & numeric fields
    const acq = acquireScopeLock(
      { ownerId: 'claude-agent-9', scopes: ['src/telemetry/**'] },
      { cwd: ws.cwd, nowMs }
    );
    assert.equal(acq.acquired, true);

    const writtenClaudeLocks = JSON.parse(
      fs.readFileSync(path.join(ws.cwd, '.claude', 'locks', 'active_scopes.json'), 'utf8')
    );
    assert.equal(writtenClaudeLocks.version, 1);
    assert.equal(Array.isArray(writtenClaudeLocks.locks), true);
    assert.equal(Array.isArray(writtenClaudeLocks.leases), true);
    assert.equal(writtenClaudeLocks.leases[0].agent_id, 'claude-agent-9');
    assert.deepEqual(writtenClaudeLocks.leases[0].files_locked, ['src/telemetry/**']);
    assert.equal(writtenClaudeLocks.leases[0].ttl_ms, 900_000);
    assert.ok(Date.parse(writtenClaudeLocks.leases[0].expires_at) > nowMs);

    const conflictCheck = evaluateScopeAndQuotaBrake(
      { ownerId: 'other-agent', targetFilePath: 'src/telemetry/otelExporter.mjs' },
      { cwd: ws.cwd, nowMs }
    );
    assert.equal(conflictCheck.triggered, true);
    assert.equal(conflictCheck.decision, 'deny');
    assert.match(conflictCheck.reason, /claude-agent-9/);
  } finally {
    ws.cleanup();
  }
});

test('ISS-055b: PreCompact writes UTC HANDOFF_<YYYYMMDD_HHMMSS>.md + HANDOFF_LATEST.md in .claude/cache and SessionStart hydrates Antigravity/docs markdown without state_baton.json', () => {
  const ws = makeTempWorkspace('ah-iss055b-');
  try {
    // 1. Exact UTC timestamp formatting check
    const fixedMs = Date.UTC(2026, 10, 10, 23, 45, 9); // 2026-11-10T23:45:09Z
    assert.equal(formatUtcHandoffTimestamp(fixedMs), '20261110_234509');

    // 2. handlePreCompactBatonFlush writes HANDOFF_20261110_234509.md + HANDOFF_LATEST.md in .claude/cache
    //    and keeps git-tracked docs/ clean unless explicitly requested!
    const flushRes = handlePreCompactBatonFlush(
      {
        cwd: ws.cwd,
        session_id: 'sess-baton-utc',
        activeGoal: 'Unify cross-edition handoff schema',
        workingSetFiles: ['src/telemetry/scopeLockRegistry.mjs'],
        verifiedInvariants: ['Zero node:* in Mod graph'],
        deadEndsAndFailures: ['Avoid raw writeFileSync']
      },
      { cwd: ws.cwd, nowMs: fixedMs }
    );

    assert.match(
      path.basename(flushRes.handoffMarkdownPath),
      /^HANDOFF_20261110_234509\.md$/
    );
    assert.equal(fs.existsSync(flushRes.handoffMarkdownPath), true);
    assert.equal(fs.existsSync(flushRes.handoffLatestPath), true);
    assert.equal(
      fs.existsSync(path.join(ws.cwd, 'docs')),
      false,
      'Default PreCompact flush must keep git-tracked docs/ clean'
    );

    // Verify parsePortableHandoffMarkdown round-trips the generated markdown cleanly
    const mdContent = fs.readFileSync(flushRes.handoffLatestPath, 'utf8');
    const parsedFromCc = parsePortableHandoffMarkdown(mdContent);
    assert.ok(parsedFromCc);
    assert.equal(parsedFromCc.sessionId, 'sess-baton-utc');
    assert.equal(parsedFromCc.activeGoal, 'Unify cross-edition handoff schema');
    assert.deepEqual(parsedFromCc.workingSetFiles, ['src/telemetry/scopeLockRegistry.mjs']);
    assert.deepEqual(parsedFromCc.verifiedInvariants, ['Zero node:* in Mod graph']);
    assert.deepEqual(parsedFromCc.deadEndsAndFailures, ['Avoid raw writeFileSync']);

    // 3. Cross-tool SessionStart hydration when NO .claude/cache/state_baton.json exists!
    const wsCross = makeTempWorkspace('ah-iss055b-cross-');
    try {
      const agyHorizonDir = path.join(wsCross.cwd, '.agents', 'horizon');
      fs.mkdirSync(agyHorizonDir, { recursive: true });

      const agyMarkdown = [
        '# Baton-Pass Handoff Bundle',
        '',
        '- **Session ID**: `agy-conv-42`',
        '- **Generated**: 2026-11-10T23:55:00.000Z',
        '',
        '## Current Objective',
        'Complete cross-harness handoff from Antigravity into Claude Code.',
        '',
        '## Completed Work',
        '- Implemented scope_lock_registry leases[] parser',
        '- Verified 900s TTL parity',
        '',
        '## Key Architectural Decisions & Invariants',
        '- Preserve pure-JS Mod transitive graph',
        '',
        '## Active Files',
        '- `src/telemetry/scopeLockRegistry.mjs`',
        '',
        '## Immediate Next Action',
        'Run full npm test suite and verify zero regressions.'
      ].join('\n');

      fs.writeFileSync(path.join(agyHorizonDir, 'HANDOFF_LATEST.md'), agyMarkdown, 'utf8');

      // Run SessionStart lifecycle hook (`phase: 'start'`) with source: 'startup'
      const startRes = runCompactLifecycleHook(
        {
          cwd: wsCross.cwd,
          session_id: 'fresh-claude-session',
          source: 'startup'
        },
        { cwd: wsCross.cwd, phase: 'start' }
      );

      assert.equal(startRes.exitCode, 0);
      assert.equal(startRes.result.hydrated, true);
      assert.equal(startRes.result.hydratedFrom, 'markdown');
      const startJson = JSON.parse(startRes.stdout);
      assert.equal(startJson.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(
        startJson.hookSpecificOutput.additionalContext,
        /Complete cross-harness handoff from Antigravity into Claude Code/
      );
      assert.match(
        startJson.hookSpecificOutput.additionalContext,
        /Run full npm test suite and verify zero regressions/
      );

      // 4. Also verify docs/HANDOFF_<YYYYMMDD_HHMMSS>.md discovery when .agents/horizon is absent
      fs.rmSync(agyHorizonDir, { recursive: true, force: true });
      const docsDir = path.join(wsCross.cwd, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(
        path.join(docsDir, 'HANDOFF_20261110_235959.md'),
        agyMarkdown.replace('Complete cross-harness handoff', 'Hydrated from docs HANDOFF timestamped file'),
        'utf8'
      );

      const docsHydration = handleSessionStartHydration(
        {
          cwd: wsCross.cwd,
          session_id: 'fresh-claude-session-2',
          source: 'resume'
        },
        { cwd: wsCross.cwd }
      );
      assert.equal(docsHydration.hydrated, true);
      assert.equal(docsHydration.hydratedFrom, 'markdown');
      assert.match(docsHydration.additionalContext, /Hydrated from docs HANDOFF timestamped file/);
    } finally {
      wsCross.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});
