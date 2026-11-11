import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

import { CacheTtlWatchdog } from '../src/core/telemetry/cache_ttl_watchdog.mjs';
import { AgBridgeService } from '../src/core/ag_bridge.mjs';
import {
  ModelSelectorActuator,
  actuateRoutingRecommendation
} from '../src/core/task_quota_router.mjs';
import { TaskQuotaRouter, COACH_MODES } from '../src/core/coach/task_quota_router.mjs';
import {
  FULL_TOOL_HOOK_MATCHER,
  CLI_DAMPENER_MATCHER,
  validateAntigravityHooksSchema,
  wrapNoisyCommandWithDampener,
  registerCliDampeningHook,
  promoteRuleWithAttentionZone,
  updateAntigravityIgnore
} from '../src/core/layer5_hygiene.mjs';
import { buildHooksConfig } from '../src/cli/init.mjs';
import { handlePreInvocation, handlePreToolUse } from '../src/hooks/pre_invocation.mjs';
import { handlePostToolUse } from '../src/hooks/post_invocation.mjs';
import {
  trimUncachedTail,
  generateHandoffMarkdown,
  executeBatonPassHandoff
} from '../src/core/compaction_coach.mjs';
import { pruneSessionTranscript } from '../src/core/pruner.mjs';
import {
  PrefixCacheShield,
  isProtectedPrefixFile,
  isWarmCacheState
} from '../src/core/prefix_cache_shield.mjs';
import {
  ReflectorQueue,
  isReflectorProtectedFile
} from '../src/core/coach/reflector_queue.mjs';
import { TurnZeroGate } from '../src/core/coach/turn_zero_gate.mjs';
import { RsiInstinctEngine } from '../src/core/rsi_instinct_engine.mjs';
import { UShapedAttentionOptimizer } from '../src/core/u_shaped_optimizer.mjs';
import {
  CANONICAL_DETECTOR_IDS,
  EXTENDED_DETECTOR_IDS,
  ANTIGRAVITY_DETECTOR_SLUGS,
  loadHorizonConfig,
  setDetectorOverride,
  resolveDetectorOverride
} from '../src/core/horizon_config.mjs';
import {
  DETECTOR_CATALOG,
  evaluateDet09MidSessionRuleMutate,
  evaluateDet18UntrustedWorkspaceSettings,
  evaluateDet19GitHookBypass,
  evaluateDetectorsOnSteps
} from '../src/core/detectors_det01_to_16.mjs';
import { CircuitBreakers } from '../src/core/coach/circuit_breakers.mjs';
import { ProgressiveCheckpointer } from '../src/core/coach/progressive_checkpointer.mjs';
import { PromptDecomposerCoach } from '../src/core/coach/prompt_decomposer_coach.mjs';
import { SubagentPhantomAuditor } from '../src/core/coach/subagent_phantom_auditor.mjs';
import { sanitizeSubagentOutput } from '../src/core/coach/subagent_ipi_sanitizer.mjs';
import {
  HandoffHydrationLauncher,
  formatUtcHandoffTimestamp,
  parsePortableHandoffMarkdown,
  discoverAndHydrateLatestBaton
} from '../src/core/coach/handoff_hydrator.mjs';
import {
  ScopeLockRegistry,
  SCOPE_LOCK_CONSTANTS,
  loadRegistry,
  getLockFilePath,
  getClaudeLockFilePath
} from '../src/core/telemetry/scope_lock_registry.mjs';
import { startServer, HORIZON_CSRF_TOKEN } from '../sidecars/horizon-daemon/server.mjs';

function makeTmpDir(prefix = 'hz-batch3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmSafe(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 });
    } catch (err) {
      if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
    }
  }
}

function httpJsonRequest(port, method, urlPath, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj !== null ? JSON.stringify(bodyObj) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Horizon-CSRF': HORIZON_CSRF_TOKEN,
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data || '{}') });
          } catch {
            resolve({ status: res.statusCode, raw: data, json: {} });
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('Batch 3 Regression Suite — ISS-039, ISS-040, ISS-041, ISS-042, ISS-051, ISS-054', () => {
  // =========================================================================
  // ISS-039: AUTO_PILOT Actuation, Polled CacheTtlWatchdog, blocked_cdp & Hooks
  // =========================================================================
  describe('ISS-039: AUTO_PILOT Actuation, Polled CacheTtlWatchdog, Accurate blocked_cdp & Full Tool Matchers', () => {
    test('CacheTtlWatchdog polls with unref timer, supports AUTO_PILOT keep-alive, and persists pre-expiry snapshot to .agents/horizon/', () => {
      const tmpWs = makeTmpDir('hz-b3-ttl-');
      try {
        const hydrator = new HandoffHydrationLauncher({ workspaceDir: tmpWs });
        const keepAlives = [];
        const snapshots = [];

        const watchdog = new CacheTtlWatchdog({
          flightMode: 'AUTO_PILOT',
          cachedTokens: 75000,
          onKeepAlive: (ev) => keepAlives.push(ev),
          onPreSnapshot: (ev) => {
            snapshots.push(ev);
            hydrator.preStageOnTtlSnapshot({
              workspaceDir: tmpWs,
              sessionId: ev.sessionId,
              writeToDisk: true,
              writeDocsHandoff: false
            });
          }
        });

        watchdog.startPolling(500);
        assert.equal(watchdog.isPolling(), true);
        watchdog.stopPolling();
        assert.equal(watchdog.isPolling(), false);

        const stKeepAlive = watchdog.evaluateElapsed(272, { sessionId: 'sess-ttl-1', cachedTokens: 75000 });
        assert.equal(stKeepAlive.keepAliveTriggered, true);
        assert.equal(keepAlives.length, 1);
        assert.equal(keepAlives[0].event, 'TTL_AUTO_PILOT_KEEPALIVE');

        const stPreSnap = watchdog.evaluateElapsed(292, { sessionId: 'sess-ttl-1', cachedTokens: 75000 });
        assert.ok(stPreSnap.eventsEmitted.includes('TTL_PRE_SNAPSHOT'));
        assert.equal(snapshots.length, 1);

        const latestSnapPath = path.join(tmpWs, '.agents', 'horizon', 'HANDOFF_LATEST.md');
        assert.equal(fs.existsSync(latestSnapPath), true, 'Pre-expiry snapshot must persist to .agents/horizon/HANDOFF_LATEST.md');
      } finally {
        rmSafe(tmpWs);
      }
    });

    test('blocked_cdp returns actuated: false across ModelSelectorActuator, actuateRoutingRecommendation, and TaskQuotaRouter', async () => {
      const cdpBridge = new AgBridgeService({
        cdpTransport: {
          sendChatCommand: async () => ({ ok: true })
        }
      });

      const actuator = new ModelSelectorActuator({
        agBridge: cdpBridge,
        mode: 'autopilot',
        activeModel: 'gemini-4-argon',
        activeEffort: 'high'
      });

      const res1 = await actuateRoutingRecommendation(
        {
          activeModel: 'gemini-4-argon',
          activeEffort: 'high',
          targetModel: 'gemini-3.8-flash',
          targetEffort: 'low',
          cachedTokens: 0,
          cacheTtlSeconds: 0
        },
        { actuator, flightMode: 'AUTO_PILOT', sessionId: 'sess-cdp-block' }
      );

      assert.equal(res1.actuated, false, 'Must NEVER report actuated: true when CDP is blocked');
      assert.equal(res1.method, 'blocked_cdp');
      assert.equal(res1.reason, 'EXPERIMENTAL_CDP_DISABLED');
      assert.equal(actuator.activeModel, 'gemini-4-argon', 'Must not mutate activeModel when blocked');

      const coachRouter = new TaskQuotaRouter({
        mode: COACH_MODES.AUTO_PILOT,
        activeModel: 'gemini-4-argon',
        activeEffort: 'high',
        languageServerState: 'IDLE',
        agBridge: cdpBridge
      });
      const res2 = await coachRouter.evaluateTurn({
        sessionId: 'sess-cdp-block-2',
        currentModel: 'gemini-4-argon',
        currentEffort: 'high',
        targetModel: 'gemini-3.8-flash',
        targetEffort: 'low',
        cachedTokens: 0,
        ttlRemainingSeconds: 0
      });
      assert.equal(res2.actuated, false, 'TaskQuotaRouter must return actuated: false on blocked_cdp');
      assert.equal(res2.method, 'blocked_cdp');
      assert.equal(res2.reason, 'EXPERIMENTAL_CDP_DISABLED');

      // Enable experimental CDP with unfocused chat input -> actuation succeeds
      cdpBridge.setExperimentalCdpActuation(true);
      cdpBridge.setChatInputFocus(false);
      const resAllowed = await actuateRoutingRecommendation(
        {
          activeModel: 'gemini-4-argon',
          activeEffort: 'high',
          targetModel: 'gemini-3.8-flash',
          targetEffort: 'low',
          cachedTokens: 0,
          cacheTtlSeconds: 0
        },
        { actuator, flightMode: 'AUTO_PILOT', sessionId: 'sess-cdp-ok' }
      );
      assert.equal(resAllowed.actuated, true);
      assert.equal(resAllowed.transportUsed, 'cdp');
    });

    test('hooks.json and buildHooksConfig widen PreToolUse & PostToolUse matchers to all core file/shell/subagent tools', () => {
      const hooksJson = JSON.parse(fs.readFileSync(path.resolve('hooks.json'), 'utf8'));
      const preMatcher = hooksJson['horizon-flightcheck-lifecycle'].PreToolUse[0].matcher;
      const postMatcher = hooksJson['horizon-flightcheck-lifecycle'].PostToolUse[0].matcher;

      for (const expectedTool of [
        'run_command',
        'edit_file',
        'write_file',
        'read_file',
        'view_file',
        'invoke_subagent',
        'define_subagent',
        'send_message',
        'manage_subagents'
      ]) {
        assert.ok(preMatcher.includes(expectedTool), `PreToolUse matcher missing ${expectedTool}`);
        assert.ok(postMatcher.includes(expectedTool), `PostToolUse matcher missing ${expectedTool}`);
      }
      assert.equal(preMatcher, FULL_TOOL_HOOK_MATCHER);
      assert.equal(validateAntigravityHooksSchema(hooksJson).valid, true);

      const generatedHooks = buildHooksConfig('/tmp/plugin');
      assert.equal(generatedHooks['horizon-flightcheck-lifecycle'].PreToolUse[0].matcher, FULL_TOOL_HOOK_MATCHER);
      assert.equal(generatedHooks['horizon-flightcheck-lifecycle'].PostToolUse[0].matcher, FULL_TOOL_HOOK_MATCHER);
    });

    test('pre_invocation.mjs honors .attention-horizon.json flightMode (OFF, SILENT, AUTO_PILOT) while keeping Ring-0 blocks active', async () => {
      const tmpWs = makeTmpDir('hz-b3-flightmode-');
      const tmpHome = makeTmpDir('hz-b3-home-');
      try {
        // 1. SILENT mode: suppresses DET-09 advisory chatter, but still blocks Ring-0 DET-19 git --no-verify
        fs.writeFileSync(
          path.join(tmpWs, '.attention-horizon.json'),
          JSON.stringify({ flightMode: 'SILENT', detectorNamespace: 'antigravity' }),
          'utf8'
        );

        const silentDet09 = await handlePreToolUse({
          cwd: tmpWs,
          homeDir: tmpHome,
          tool_name: 'edit_file',
          tool_input: { Path: path.join(tmpWs, 'AGENTS.md') },
          cachedTokens: 80000,
          cacheTtlSeconds: 200
        });
        assert.equal(silentDet09.systemMessage, undefined, 'SILENT mode must suppress non-Ring-0 advisory chatter');
        assert.notEqual(silentDet09.decision, 'block');

        const silentRing0 = await handlePreToolUse({
          cwd: tmpWs,
          homeDir: tmpHome,
          tool_name: 'run_command',
          tool_input: { CommandLine: 'git commit -m "wip" --no-verify' }
        });
        assert.equal(silentRing0.decision, 'block', 'SILENT mode must still enforce Ring-0 DET-19 security gate');
        assert.equal(silentRing0.detectorId, 'DET-19');

        const silentPreInv = await handlePreInvocation({
          cwd: tmpWs,
          homeDir: tmpHome,
          prompt: '#check refactor everything'
        });
        assert.deepEqual(silentPreInv, {});

        // 2. OFF mode: skips non-Ring-0 advisories cleanly while preserving Ring-0 destructive shell block
        fs.writeFileSync(
          path.join(tmpWs, '.attention-horizon.json'),
          JSON.stringify({ flightMode: 'OFF', detectorNamespace: 'antigravity' }),
          'utf8'
        );
        const offPreInv = await handlePreInvocation({
          cwd: tmpWs,
          homeDir: tmpHome,
          prompt: '#check refactor everything'
        });
        assert.deepEqual(offPreInv, {});

        const offPost = await handlePostToolUse({
          cwd: tmpWs,
          homeDir: tmpHome,
          conversationId: 'b3-off-conv'
        });
        assert.equal(offPost.flightMode, 'OFF');

        // 3. AUTO_PILOT mode: enforces active DET-09 & DET-20 gates with decision: 'block'
        fs.writeFileSync(
          path.join(tmpWs, '.attention-horizon.json'),
          JSON.stringify({ flightMode: 'AUTO_PILOT', detectorNamespace: 'antigravity' }),
          'utf8'
        );
        const autoDet09 = await handlePreToolUse({
          cwd: tmpWs,
          homeDir: tmpHome,
          tool_name: 'edit_file',
          tool_input: { Path: path.join(tmpWs, 'AGENTS.md') },
          cachedTokens: 80000,
          cacheTtlSeconds: 220
        });
        assert.equal(autoDet09.decision, 'block');
        assert.equal(autoDet09.permissionDecision, 'deny');
        assert.equal(autoDet09.detectorId, 'DET-09');
      } finally {
        rmSafe(tmpWs);
        rmSafe(tmpHome);
      }
    });
  });

  // =========================================================================
  // ISS-040: Protect read_file/view_file Outputs & Offload Pointers & Read-Only Host JSONL
  // =========================================================================
  describe('ISS-040: Protect Disjoint & Post-Edit File Reads, Offload Truncated Outputs, and Keep Host JSONL Read-Only', () => {
    test('trimUncachedTail preserves disjoint line ranges, post-edit reads, and latest identical reads while offloading truncated outputs', () => {
      const tmpWs = makeTmpDir('hz-b3-tail-');
      try {
        const range1Body = 'LINE_RANGE_1_TO_100\n' + 'a'.repeat(1600);
        const range2Body = 'LINE_RANGE_101_TO_200\n' + 'b'.repeat(1600);
        const postEditBody = 'POST_EDIT_EXACT_MATCH_TARGET\n' + 'c'.repeat(1600);
        const dupOlderBody = 'OLDER_IDENTICAL_FULL_READ\n' + 'd'.repeat(1600);
        const dupNewestBody = 'NEWEST_IDENTICAL_FULL_READ\n' + 'e'.repeat(1600);
        const cliFloodBody = 'PASS test case line\n'.repeat(150);

        const steps = [
          { stepIndex: 0, totalTokens: 60000, content: 'Pinned warm cache head' },
          // Tail starts at index 1
          {
            stepIndex: 1,
            totalTokens: 500,
            toolCalls: [{ name: 'read_file', args: { Path: 'src/big.mjs', StartLine: 1, EndLine: 100 } }],
            content: range1Body
          },
          {
            stepIndex: 2,
            totalTokens: 500,
            toolCalls: [{ name: 'read_file', args: { Path: 'src/big.mjs', StartLine: 101, EndLine: 200 } }],
            content: range2Body
          },
          {
            stepIndex: 3,
            totalTokens: 100,
            toolCalls: [{ name: 'edit_file', args: { Path: 'src/big.mjs' } }],
            content: 'Edited src/big.mjs'
          },
          {
            stepIndex: 4,
            totalTokens: 500,
            toolCalls: [{ name: 'read_file', args: { Path: 'src/big.mjs', StartLine: 1, EndLine: 100 } }],
            content: postEditBody
          },
          {
            stepIndex: 5,
            totalTokens: 500,
            toolCalls: [{ name: 'read_file', args: { Path: 'src/dup.mjs' } }],
            content: dupOlderBody
          },
          {
            stepIndex: 6,
            totalTokens: 500,
            toolCalls: [{ name: 'read_file', args: { Path: 'src/dup.mjs' } }],
            content: dupNewestBody
          },
          {
            stepIndex: 7,
            totalTokens: 900,
            toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
            content: cliFloodBody
          }
        ];

        const res = trimUncachedTail(steps, {
          cachedTokens: 50000,
          maxRetainedChars: 240,
          cwd: tmpWs
        });

        // 1. Disjoint line ranges (steps 1 & 2) MUST remain 100% intact
        assert.equal(res.prunedSteps[1].content, range1Body);
        assert.equal(res.prunedSteps[2].content, range2Body);

        // 2. Post-edit read (step 4) has a new edit generation and MUST remain 100% intact
        assert.equal(res.prunedSteps[4].content, postEditBody);

        // 3. Identical repeated read: older copy (step 5) is truncated with offload pointer; newest copy (step 6) is intact!
        assert.equal(res.prunedSteps[5].tailSurgeonTruncated, true);
        assert.equal(res.prunedSteps[5].tailSurgeonReason, 'DET-06_REDUNDANT_READ');
        assert.ok(res.prunedSteps[5].content.includes('.agents/tmp/offload_'));
        assert.ok(res.prunedSteps[5].offloadPath && fs.existsSync(res.prunedSteps[5].offloadPath));
        assert.equal(fs.readFileSync(res.prunedSteps[5].offloadPath, 'utf8'), dupOlderBody);
        assert.equal(res.prunedSteps[6].content, dupNewestBody, 'Most recent identical read must stay intact');

        // 4. CLI flood (step 7) offloaded to .agents/tmp/offload_<hash>.txt before truncation
        assert.equal(res.prunedSteps[7].tailSurgeonTruncated, true);
        assert.ok(res.prunedSteps[7].offloadPath && fs.existsSync(res.prunedSteps[7].offloadPath));
        assert.equal(fs.readFileSync(res.prunedSteps[7].offloadPath, 'utf8'), cliFloodBody);

        // 5. Safety fallback: if offloadDir is unwritable (file blocking directory creation), preserve raw output intact
        const blockerFile = path.join(tmpWs, 'blocked_file');
        fs.writeFileSync(blockerFile, 'not-a-dir', 'utf8');
        const failSafeRes = trimUncachedTail(steps, {
          cachedTokens: 50000,
          maxRetainedChars: 240,
          offloadDir: path.join(blockerFile, 'cannot_mkdir')
        });
        assert.equal(failSafeRes.modifiedCount, 0);
        assert.equal(failSafeRes.prunedSteps[7].content, cliFloodBody);
      } finally {
        rmSafe(tmpWs);
      }
    });

    test('pruneSessionTranscript protects disjoint ranges and post-edit reads while writing offload files for superseded items', () => {
      const tmpSession = makeTmpDir('hz-b3-pruner-');
      try {
        const logsDir = path.join(tmpSession, '.system_generated', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const transcriptPath = path.join(logsDir, 'transcript_full.jsonl');

        const makeCodeBlock = (tag) => [
          `import fs from "node:fs"; // ${tag}`,
          `export function handler_${tag}(input) {`,
          ...Array.from({ length: 55 }, (_, idx) => `  const v_${idx} = "${tag}_" + ${idx};`),
          `  return input;`,
          `}`
        ].join('\n');

        const codeRangeA = makeCodeBlock('rangeA');
        const codeRangeB = makeCodeBlock('rangeB');
        const codePostEdit = makeCodeBlock('postEdit');
        const codeDupOld = makeCodeBlock('dupOld');
        const codeDupNew = makeCodeBlock('dupNew');
        const oldIdleIso = new Date(Date.now() - 600_000).toISOString();

        const lines = [
          JSON.stringify({ step_index: 0, type: 'SYSTEM_PROMPT', content: 'System anchor', created_at: oldIdleIso }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            tool_calls: [{ name: 'read_file', args: { Path: 'src/mod.mjs', StartLine: 1, EndLine: 60 } }],
            content: codeRangeA,
            created_at: oldIdleIso
          }),
          JSON.stringify({
            step_index: 2,
            type: 'PLANNER_RESPONSE',
            tool_calls: [{ name: 'read_file', args: { Path: 'src/mod.mjs', StartLine: 61, EndLine: 120 } }],
            content: codeRangeB,
            created_at: oldIdleIso
          }),
          JSON.stringify({
            step_index: 3,
            type: 'PLANNER_RESPONSE',
            tool_calls: [{ name: 'edit_file', args: { Path: 'src/mod.mjs' } }],
            content: 'Applied edit',
            created_at: oldIdleIso
          }),
          JSON.stringify({
            step_index: 4,
            type: 'PLANNER_RESPONSE',
            tool_calls: [{ name: 'read_file', args: { Path: 'src/mod.mjs', StartLine: 1, EndLine: 60 } }],
            content: codePostEdit,
            created_at: oldIdleIso
          }),
          JSON.stringify({
            step_index: 5,
            type: 'PLANNER_RESPONSE',
            tool_calls: [{ name: 'read_file', args: { Path: 'src/dup.mjs' } }],
            content: codeDupOld,
            created_at: oldIdleIso
          }),
          JSON.stringify({
            step_index: 6,
            type: 'PLANNER_RESPONSE',
            tool_calls: [{ name: 'read_file', args: { Path: 'src/dup.mjs' } }],
            content: codeDupNew,
            created_at: oldIdleIso
          }),
          ...Array.from({ length: 10 }, (_, idx) => JSON.stringify({
            step_index: 7 + idx,
            type: 'PLANNER_RESPONSE',
            content: `Recent active step ${idx}`,
            created_at: oldIdleIso
          }))
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');

        const pruneRes = pruneSessionTranscript(tmpSession, {
          dryRun: false,
          forceHotCache: true,
          cacheDir: tmpSession,
          cwd: tmpSession
        });
        assert.equal(pruneRes.success, true);
        assert.equal(pruneRes.prunedSteps, 1, 'Only step 5 (superseded identical full read) should be folded');

        const updated = fs.readFileSync(transcriptPath, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
        assert.equal(updated[1].content, codeRangeA, 'Disjoint range A must remain intact');
        assert.equal(updated[2].content, codeRangeB, 'Disjoint range B must remain intact');
        assert.equal(updated[4].content, codePostEdit, 'Post-edit read must remain intact');
        assert.ok(updated[5].content.includes('[AST Signature Stub'));
        assert.ok(updated[5].content.includes('.agents/tmp/offload_'));
        assert.equal(updated[6].content, codeDupNew, 'Latest identical read must remain intact');

        const detail = pruneRes.details[0];
        assert.ok(detail.offloadPath && fs.existsSync(detail.offloadPath));
        assert.equal(fs.readFileSync(detail.offloadPath, 'utf8'), codeDupOld);
      } finally {
        rmSafe(tmpSession);
      }
    });
  });

  // =========================================================================
  // ISS-041: Unified PrefixCacheShield Fence, Deterministic TurnZeroGate & Rule Globs
  // =========================================================================
  describe('ISS-041: Unified PrefixCacheShield Warm-Cache Fence, Deterministic TurnZeroGate & Aligned Rule Globs', () => {
    test('Aligned Antigravity protected prefix globs match all AG rule paths while strictly excluding CLAUDE.md/.claude/', () => {
      const protectedPaths = [
        'GEMINI.md',
        'AGENTS.md',
        'SKILL.md',
        '.antigravityignore',
        '.gemini/GEMINI.md',
        '.gemini/rules/security.md',
        '.gemini/rules/nested/perf.md',
        '.agents/CONTEXT.md',
        '.agents/rules/frontend.md',
        '.agents/skills/horizon/SKILL.md'
      ];
      for (const p of protectedPaths) {
        assert.equal(isProtectedPrefixFile(p), true, `PrefixCacheShield must protect ${p}`);
        assert.equal(isReflectorProtectedFile(p), true, `ReflectorQueue must protect ${p}`);
        const det09 = evaluateDet09MidSessionRuleMutate(
          [{ toolCalls: [{ name: 'edit_file', args: { Path: p } }] }],
          { cacheState: 'WARM_5M' }
        );
        assert.ok(det09, `DET-09 must guard ${p} when cache is warm`);
      }

      // ISS-021 invariant: CLAUDE.md and .claude/ MUST NEVER be treated as Antigravity prefix rule files
      for (const foreignPath of ['CLAUDE.md', '/repo/CLAUDE.md', '.claude/rules/sec.md', '.cursorrules']) {
        assert.equal(isProtectedPrefixFile(foreignPath), false, `Must exclude foreign rule file ${foreignPath}`);
        assert.equal(isReflectorProtectedFile(foreignPath), false, `ReflectorQueue must exclude ${foreignPath}`);
      }
      assert.equal(isWarmCacheState({ cacheState: 'WARM_5M' }), true);
      assert.equal(isWarmCacheState({ cacheState: 'WARM_1H' }), true);
      assert.equal(isWarmCacheState({ cacheState: 'COLD' }), false);
    });

    test('Warm-cache fence defers AGENTS.md / .antigravityignore mutations across RSI, U-Shape, Layer5, and Daemon routes until cold/PostCompact', async () => {
      const tmpHome = makeTmpDir('hz-b3-shield-home-');
      const tmpWs = makeTmpDir('hz-b3-shield-ws-');
      let daemon = null;
      try {
        const agentsMd = path.join(tmpWs, 'AGENTS.md');
        const initialAgents = [
          '# Workspace Rules',
          '- Rule 1: Keep telemetry read-only',
          '- Rule 2: Preserve test assertions',
          '- Rule 3: Use atomic writes',
          '- Rule 4: Avoid full file reads',
          '- Rule 5: Check scope locks',
          '- Rule 6: Never leak secrets',
          ''
        ].join('\n');
        fs.writeFileSync(agentsMd, initialAgents, 'utf8');

        const shield = new PrefixCacheShield({ homeDir: tmpHome, warmCacheThreshold: 50000 });
        const rq = new ReflectorQueue({
          queueFilePath: path.join(tmpWs, '.agents', 'horizon', 'reflector_queue.json'),
          prefixCacheShield: shield
        });
        shield.attachReflectorQueue(rq);

        // 1. Layer 5 rule promotion & .antigravityignore under WARM_5M
        const promoWarm = promoteRuleWithAttentionZone(tmpWs, 'Rule 7: Gate mid-session rule edits', {
          cacheState: 'WARM_5M',
          prefixCacheShield: shield
        });
        assert.equal(promoWarm.staged, true);
        assert.equal(promoWarm.written, false);
        assert.equal(fs.readFileSync(agentsMd, 'utf8'), initialAgents, 'AGENTS.md must remain untouched while cache is warm');

        const ignWarm = updateAntigravityIgnore(tmpWs, 'dist/bundle.log', {
          cacheState: 'WARM_5M',
          prefixCacheShield: shield
        });
        assert.equal(ignWarm.staged, true);
        assert.equal(fs.existsSync(path.join(tmpWs, '.antigravityignore')), false);

        // 2. UShapedAttentionOptimizer under WARM_5M
        const optimizer = new UShapedAttentionOptimizer({ homeDir: tmpHome, prefixCacheShield: shield });
        const uWarm = optimizer.optimizeRuleFile(agentsMd, { cacheState: 'WARM_5M' });
        assert.equal(uWarm.staged, true);
        assert.equal(fs.readFileSync(agentsMd, 'utf8'), initialAgents);

        // 3. RsiInstinctEngine under WARM_5M
        const evolvedSkillPath = path.join(tmpWs, '.agents', 'skills', 'sqlite_safety_evolved', 'SKILL.md');
        const rsi = new RsiInstinctEngine({
          homeDir: tmpHome,
          workspaceDir: tmpWs,
          dbPath: path.join(tmpHome, 'instincts.db'),
          prefixCacheShield: shield
        });
        for (let s = 1; s <= 5; s++) {
          rsi.observeTurn({
            domain: 'sqlite_safety',
            userText: `Always open SQLite databases with readOnly true in helper_${s}`,
            initialConfidence: 0.85
          });
        }
        const rsiWarm = rsi.evolveDomainToSkill('sqlite_safety', {
          skillPath: evolvedSkillPath,
          minCount: 3,
          minConfidence: 0.7,
          cacheState: 'WARM_5M'
        });
        assert.equal(rsiWarm.staged, true);
        assert.equal(fs.existsSync(evolvedSkillPath), false, 'SKILL.md write must be deferred in PrefixCacheShield while warm');
        rsi.close();

        // 4. Flush on PostCompact writes all queued mutations + bridged ReflectorQueue items cleanly
        const flushRes = shield.flushOnPostCompact();
        assert.ok(flushRes.flushedCount >= 3);
        assert.equal(fs.existsSync(evolvedSkillPath), true, 'SKILL.md must flush on PostCompact');
        assert.equal(fs.existsSync(path.join(tmpWs, '.antigravityignore')), true, '.antigravityignore must flush on PostCompact');

        // 5. Daemon HTTP endpoints: /api/shield/flush warm fence + /api/tail/trim read-only host JSONL guard
        const freePort = await new Promise((resolve, reject) => {
          const srv = net.createServer();
          srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close((err) => (err ? reject(err) : resolve(p)));
          });
          srv.on('error', reject);
        });
        daemon = await startServer(freePort);
        const warmFlushHttp = await httpJsonRequest(daemon.port, 'POST', '/api/shield/flush', {
          cacheState: 'WARM_5M',
          cachedTokens: 85000,
          cacheTtlSeconds: 210
        });
        assert.equal(warmFlushHttp.status, 200);
        assert.equal(warmFlushHttp.json.deferred, true);
        assert.equal(warmFlushHttp.json.reason, 'CACHE_WARM_FENCE');

        const warmPromoteHttp = await httpJsonRequest(daemon.port, 'POST', '/api/instincts/promote', {
          workspacePath: tmpWs,
          ruleText: 'Never bust warm prompt caches via HTTP',
          cacheState: 'WARM_5M',
          cachedTokens: 85000,
          cacheTtlSeconds: 210
        });
        assert.equal(warmPromoteHttp.status, 200);
        assert.equal(warmPromoteHttp.json.staged, true);

        const warmUshapeHttp = await httpJsonRequest(daemon.port, 'POST', '/api/ushape/reorder', {
          workspacePath: tmpWs,
          filePath: agentsMd,
          cacheState: 'WARM_5M',
          cachedTokens: 85000,
          cacheTtlSeconds: 210
        });
        assert.equal(warmUshapeHttp.status, 200);
        assert.equal(warmUshapeHttp.json.staged, true);

        // Verify POST /api/tail/trim NEVER mutates host transcript_full.jsonl even when persist: true is passed
        const hostTranscript = path.join(tmpWs, 'transcript_full.jsonl');
        const rawHostJsonl = [
          JSON.stringify({ step_index: 0, totalTokens: 60000, content: 'Head' }),
          JSON.stringify({
            step_index: 1,
            totalTokens: 1000,
            toolCalls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
            content: 'line\n'.repeat(200)
          })
        ].join('\n') + '\n';
        fs.writeFileSync(hostTranscript, rawHostJsonl, 'utf8');

        const trimHttp = await httpJsonRequest(daemon.port, 'POST', '/api/tail/trim', {
          transcriptPath: hostTranscript,
          cwd: tmpWs,
          persist: true
        });
        assert.equal(trimHttp.status, 200);
        assert.equal(trimHttp.json.hostTranscriptMutated, false);
        assert.equal(trimHttp.json.persistBlockedReason, 'HOST_TRANSCRIPT_READONLY_GUARD');
        assert.equal(fs.readFileSync(hostTranscript, 'utf8'), rawHostJsonl, 'Host transcript must remain 100% byte-identical');
      } finally {
        if (daemon?.server) {
          await new Promise((r) => daemon.server.close(r));
        }
        rmSafe(tmpHome);
        rmSafe(tmpWs);
      }
    });

    test('TurnZeroGate strips volatile timestamps from AGENTS.md fenced blocks for byte-for-byte determinism across turns', () => {
      const tmpWs = makeTmpDir('hz-b3-t0-');
      try {
        const agentsPath = path.join(tmpWs, 'AGENTS.md');
        fs.writeFileSync(agentsPath, '# Core Rules\n- Keep deterministic prefixes.\n', 'utf8');

        const gate = new TurnZeroGate({ workspaceDir: tmpWs });
        const t1 = gate.stageOrApplyFencedBlock(
          {
            targetPath: agentsPath,
            blockType: 'ARCHITECTURE_MAP',
            bodyText: '- `src/core/`: core telemetry engine',
            nowMs: 1_760_000_000_000
          },
          { turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0 }
        );
        assert.equal(t1.mutation.applied, true);
        const contentAfterT1 = fs.readFileSync(agentsPath, 'utf8');
        assert.ok(!/timestamp=|expires_at=|created=|expires=/i.test(contentAfterT1), 'No volatile timestamps in AGENTS.md');

        const t2 = gate.stageOrApplyFencedBlock(
          {
            targetPath: agentsPath,
            blockType: 'ARCHITECTURE_MAP',
            bodyText: '- `src/core/`: core telemetry engine',
            nowMs: 1_760_000_060_000 // 60 seconds later
          },
          { turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0 }
        );
        assert.equal(t2.mutation.applied, true);
        const contentAfterT2 = fs.readFileSync(agentsPath, 'utf8');
        assert.equal(contentAfterT1, contentAfterT2, 'Identical blocks must produce byte-identical AGENTS.md across turns');
        assert.equal(fs.existsSync(path.join(tmpWs, '.agents', 'horizon', 'turn_zero_meta.json')), true);
      } finally {
        rmSafe(tmpWs);
      }
    });
  });

  // =========================================================================
  // ISS-042: Windows 11 PowerShell-Compatible CLI Output Dampener
  // =========================================================================
  describe('ISS-042: Windows 11 PowerShell-Compatible CLI Output Dampener', () => {
    test('wrapNoisyCommandWithDampener and registerCliDampeningHook emit valid PowerShell on win32 and POSIX on linux/darwin', () => {
      const tmpWs = makeTmpDir('hz-b3-ps-');
      try {
        const logPath = path.join(tmpWs, 'stdout.log').replace(/\\/g, '/');
        const winWrapped = wrapNoisyCommandWithDampener('Write-Output "line1"; Write-Output "line2"; Write-Output "line3"', {
          maxLines: 10,
          logFile: logPath,
          platform: 'win32'
        });
        assert.ok(winWrapped.includes('Tee-Object -FilePath'));
        assert.ok(winWrapped.includes('Select-Object -First 10'));
        assert.ok(winWrapped.includes('$LASTEXITCODE = 0'));
        assert.ok(!winWrapped.includes('|| true'));
        assert.ok(!winWrapped.includes('head -n'));

        if (process.platform === 'win32') {
          const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', winWrapped], {
            cwd: tmpWs,
            encoding: 'utf8'
          });
          assert.ok(out.includes('line1'));
          assert.equal(fs.existsSync(logPath), true);
        }

        const posixWrapped = wrapNoisyCommandWithDampener('npm test', {
          maxLines: 50,
          logFile: '.agents/tmp/cli.log',
          platform: 'linux'
        });
        assert.equal(posixWrapped, '(npm test) 2>&1 | tee ".agents/tmp/cli.log" | head -n 50 || true');

        const hookRes = registerCliDampeningHook(tmpWs, { platform: 'win32', maxLines: 80 });
        assert.equal(hookRes.success, true);
        assert.equal(hookRes.hookEntry.matcher, CLI_DAMPENER_MATCHER);
        assert.ok(hookRes.hookEntry.matcher.includes('run_command'));
        assert.ok(hookRes.hookEntry.matcher.includes('execute_bash'));
        assert.ok(hookRes.hookEntry.matcher.includes('Bash'));
        assert.ok(hookRes.hookEntry.wrappedCommandTemplate.includes('Tee-Object'));
      } finally {
        rmSafe(tmpWs);
      }
    });
  });

  // =========================================================================
  // ISS-051: DET-01..DET-29 Zero Collisions, DET-18 Guard & Cross-Edition Config
  // =========================================================================
  describe('ISS-051: Unified DET-01..DET-29 Catalog, Zero Collisions, DET-18 Guard & Cross-Edition Config Namespace', () => {
    test('DETECTOR_CATALOG has all 20 canonical entries (DET-01..20) and secondary coach detectors use unique DET-21..29 IDs', () => {
      assert.equal(CANONICAL_DETECTOR_IDS.length, 20);
      assert.equal(Object.keys(DETECTOR_CATALOG).length, 20);
      assert.equal(EXTENDED_DETECTOR_IDS.length, 29);

      for (let i = 1; i <= 20; i++) {
        const id = `DET-${String(i).padStart(2, '0')}`;
        assert.ok(DETECTOR_CATALOG[id], `Missing ${id} in DETECTOR_CATALOG`);
        assert.ok(ANTIGRAVITY_DETECTOR_SLUGS[id], `Missing semantic slug for ${id}`);
      }

      // Verify zero ID collisions across secondary coach modules
      const cb = new CircuitBreakers({ enableBlindEditGuard: true });
      const blindRes = cb.recordTurn({
        turnIndex: 1,
        toolName: 'edit_file',
        filePath: 'src/unseen_target.mjs',
        previousContent: 'a\n'.repeat(120),
        newContent: 'b\n'.repeat(120)
      });
      assert.ok(blindRes.triggered.some((t) => t.detectorId === 'DET-21'), 'Blind edit must emit DET-21 (never DET-17b)');

      const tmpCkpt = makeTmpDir('hz-b3-ckpt-');
      try {
        const ckpt = new ProgressiveCheckpointer({ workspaceDir: tmpCkpt, captureGitStat: false });
        const ckptRes = ckpt.evaluateAndSnapshot({ sessionId: 's1', totalTokens: 160000, maxTokens: 200000 });
        assert.equal(ckptRes.checkpoint.detectorId, 'DET-25');
      } finally {
        rmSafe(tmpCkpt);
      }

      const decomp = new PromptDecomposerCoach().evaluate(
        '1. Edit `a.mjs`\n2. Edit `b.mjs`\n3. Edit `c.mjs`\n4. Edit `d.mjs`\n5. Edit `e.mjs`\n6. Edit `f.mjs`'
      );
      assert.equal(decomp.detectorId, 'DET-26');

      const auditor = new SubagentPhantomAuditor();
      const visGuard = auditor.checkVisionOverage({ primaryQuotaUsedPct: 100, overagesEnabled: true });
      assert.equal(visGuard.detectorId, 'DET-28');
    });

    test('DET-18 Untrusted Workspace Settings Guard catches malicious hooks/tasks/MCP RCE while trusting official agy-horizon hooks', () => {
      const tmpWs = makeTmpDir('hz-b3-det18-');
      try {
        // 1. Official repo hooks.json must NOT trigger DET-18
        const cleanCheck = evaluateDet18UntrustedWorkspaceSettings([], {
          workspacePath: path.resolve('.'),
          scanWorkspace: true
        });
        assert.equal(cleanCheck, null, 'Trusted agy-horizon plugin hooks must not trigger DET-18');

        // 2. Malicious .vscode/tasks.json with runOn: folderOpen + encoded PowerShell RCE
        fs.mkdirSync(path.join(tmpWs, '.vscode'), { recursive: true });
        fs.writeFileSync(
          path.join(tmpWs, '.vscode', 'tasks.json'),
          JSON.stringify({
            version: '2.0.0',
            tasks: [{
              label: 'auto-bootstrap',
              command: 'powershell -enc SQBFAFgA',
              runOptions: { runOn: 'folderOpen' }
            }]
          }),
          'utf8'
        );
        const tasksAlert = evaluateDet18UntrustedWorkspaceSettings([], {
          workspacePath: tmpWs,
          scanWorkspace: true
        });
        assert.ok(tasksAlert);
        assert.equal(tasksAlert.id, 'DET-18');

        // 3. Unauthorized agent tool attempt to write .gemini/settings.json
        const stepAlert = evaluateDetectorsOnSteps([
          { toolCalls: [{ name: 'write_file', args: { Path: '.gemini/settings.json', Content: '{"yolo":true}' } }] }
        ], { workspacePath: tmpWs });
        assert.ok(stepAlert.findings.some((f) => f.id === 'DET-18' && f.detectorId === 'DET-18'));
      } finally {
        rmSafe(tmpWs);
      }
    });

    test('Cross-edition .attention-horizon.json prevents Claude Code DET-19 (subagent-ipi) from disabling Antigravity DET-19 (git-hook-bypass)', () => {
      const tmpWs = makeTmpDir('hz-b3-cfg-');
      const tmpHome = makeTmpDir('hz-b3-cfghome-');
      try {
        // Case A: Shared repo config written by Claude Code with "DET-19": "off"
        fs.writeFileSync(
          path.join(tmpWs, '.attention-horizon.json'),
          JSON.stringify({
            detectorNamespace: 'claude-code',
            detectors: {
              'DET-19': 'off'
            }
          }),
          'utf8'
        );
        const ccCfg = loadHorizonConfig({ cwd: tmpWs, homeDir: tmpHome });
        assert.equal(ccCfg.semanticDetectors['subagent-ipi'], 'off');
        assert.notEqual(resolveDetectorOverride(ccCfg, 'DET-19'), 'off', 'Claude Code DET-19=off must NEVER disable GA git-hook-bypass');

        // Verify GA DET-19 still catches git --no-verify while subagent-ipi sanitizer respects semanticDetectors['subagent-ipi']='off'
        const gitBypass = evaluateDet19GitHookBypass([
          { toolCalls: [{ name: 'run_command', args: { CommandLine: 'git commit --no-verify -m "x"' } }] }
        ]);
        assert.ok(gitBypass && gitBypass.id === 'DET-19');
        const ipiBypassed = sanitizeSubagentOutput('hello', { horizonConfig: ccCfg });
        assert.equal(ipiBypassed.bypassedByConfig, true);

        // Case B: Legacy un-namespaced config trying to set Ring-0 "DET-08": "off" & "DET-19": "off" -> clamped to "warn"
        fs.writeFileSync(
          path.join(tmpWs, '.attention-horizon.json'),
          JSON.stringify({
            detectors: {
              'DET-08': 'off',
              'DET-19': 'off'
            }
          }),
          'utf8'
        );
        const legacyCfg = loadHorizonConfig({ cwd: tmpWs, homeDir: tmpHome });
        assert.equal(resolveDetectorOverride(legacyCfg, 'DET-08'), 'warn');
        assert.equal(resolveDetectorOverride(legacyCfg, 'DET-19'), 'warn');
        assert.ok(legacyCfg.warnings.length >= 2);

        // Case C: setDetectorOverride supports DET-21 and semantic slugs cleanly in Antigravity namespace
        const saved21 = setDetectorOverride('DET-21', 'warn', { cwd: tmpWs, homeDir: tmpHome });
        assert.equal(resolveDetectorOverride(saved21.config, 'DET-21'), 'warn');
        assert.equal(resolveDetectorOverride(saved21.config, 'blind-edit-without-read'), 'warn');
      } finally {
        rmSafe(tmpWs);
        rmSafe(tmpHome);
      }
    });
  });

  // =========================================================================
  // ISS-054: Unified 6-Section State Baton Schema & Cross-Harness 900s Scope Locks
  // =========================================================================
  describe('ISS-054: Unified 6-Section State Baton Schema & Cross-Harness 900s DET-20 Scope Lock Visibility', () => {
    test('HandoffHydrationLauncher and executeBatonPassHandoff emit unified 6-section State Baton to docs/HANDOFF_YYYYMMDD_HHMMSS.md + .agents/horizon/HANDOFF_LATEST.md', () => {
      const tmpWs = makeTmpDir('hz-b3-baton-ws-');
      const tmpHome = makeTmpDir('hz-b3-baton-home-');
      try {
        assert.equal(formatUtcHandoffTimestamp(Date.UTC(2026, 10, 11, 1, 2, 3)), '20261111_010203');

        const launcher = new HandoffHydrationLauncher({ workspaceDir: tmpWs });
        const bundle = launcher.generateHandoffBundle({
          workspaceDir: tmpWs,
          sessionId: 'ga-sess-100',
          activeModel: 'gemini-4-argon',
          taskMdContent: '- [x] Step 1\n- [/] Implement ISS-054 unified baton\n',
          verifiedSchemaFiles: ['src/core/constants.mjs'],
          ownedScopePaths: ['src/core/coach/handoff_hydrator.mjs'],
          timestamp: Date.UTC(2026, 10, 11, 4, 5, 6)
        });

        assert.ok(bundle.handoffRelPath === 'docs/HANDOFF_20261111_040506.md');
        assert.equal(fs.existsSync(bundle.handoffAbsPath), true);
        assert.equal(fs.existsSync(bundle.latestHandoffAbsPath), true);

        const coachRes = executeBatonPassHandoff(
          {
            sessionId: 'ga-sess-101',
            activeModel: 'gemini-4-argon',
            totalTokens: 150000,
            taskMdContent: '- [/] Finish Batch 3 verification\n',
            activeFiles: ['src/core/compaction_coach.mjs']
          },
          {
            workspacePath: tmpWs,
            homeDir: tmpHome,
            timestamp: Date.UTC(2026, 10, 11, 5, 6, 7)
          }
        );
        assert.ok(coachRes.handoffFilePath.endsWith('HANDOFF_20261111_050607.md'));
        assert.equal(fs.existsSync(coachRes.latestHandoffPath), true);

        for (const md of [bundle.markdown, coachRes.markdown]) {
          assert.ok(md.includes('# Attention Horizon State Baton Handoff'));
          assert.ok(md.includes('## 1. Active Goal'));
          assert.ok(md.includes('## 2. Working Set Files'));
          assert.ok(md.includes('## 3. Verified Invariants'));
          assert.ok(md.includes('## 4. Dead Ends & Failures to Avoid'));
          assert.ok(md.includes('## 5. Queued Cache-Prefix Mutations (Released on PostCompact)'));
          assert.ok(md.includes('## 6. Exact Next Step'));
          const parsed = parsePortableHandoffMarkdown(md);
          assert.equal(parsed.isCanonicalStateBaton, true);
        }

        const discovered = discoverAndHydrateLatestBaton(tmpWs);
        assert.ok(discovered && discovered.isCanonicalStateBaton);
      } finally {
        rmSafe(tmpWs);
        rmSafe(tmpHome);
      }
    });

    test('ScopeLockRegistry uses 900s (15m) default TTL and detects cross-harness DET-20 collisions from .claude/locks/active_scopes.json (exact & glob)', () => {
      const tmpWs = makeTmpDir('hz-b3-locks-');
      try {
        assert.equal(SCOPE_LOCK_CONSTANTS.DEFAULT_TTL_SECONDS, 900);
        assert.equal(SCOPE_LOCK_CONSTANTS.DEFAULT_TTL_MS, 900_000);

        // Simulate Claude Code holding a lock in <cwd>/.claude/locks/active_scopes.json (locks[] + epoch-ms + glob)
        const claudeLockPath = getClaudeLockFilePath(tmpWs);
        fs.mkdirSync(path.dirname(claudeLockPath), { recursive: true });
        const claudeRaw = JSON.stringify({
          schemaVersion: '2026.11.1',
          updatedAt: new Date().toISOString(),
          locks: [
            {
              ownerId: 'claude-code-sess-77',
              pid: process.pid,
              tool: 'claude-code',
              scopes: ['src/core/**', '.github/*'],
              acquiredAt: Date.now(),
              expiresAt: Date.now() + 900_000
            }
          ]
        }, null, 2);
        fs.writeFileSync(claudeLockPath, claudeRaw, 'utf8');

        const loaded = loadRegistry(tmpWs);
        assert.equal(loaded.leases.length, 1);
        assert.equal(loaded.leases[0].trajectoryId, 'claude-code-sess-77');
        assert.equal(loaded.leases[0].source, 'cross_harness');

        // Antigravity agent attempting to claim src/core/router.mjs MUST detect DET-20 collision against Claude Code's glob lock!
        const agReg = new ScopeLockRegistry({ workspaceDir: tmpWs, pid: process.pid, tool: 'antigravity' });
        const conflict = agReg.acquireOrRenewLease({
          trajectoryId: 'ag-traj-99',
          claimedPaths: ['src/core/router.mjs']
        });
        assert.equal(conflict.ok, false);
        assert.equal(conflict.collisionDetected, true);
        assert.equal(conflict.detectorId, 'DET-20');
        assert.equal(conflict.conflictingTrajectoryId, 'claude-code-sess-77');
        assert.equal(conflict.conflictingTool, 'claude-code');
        assert.deepEqual(conflict.overlappingPaths, ['src/core/router.mjs']);

        // Non-overlapping Antigravity claim succeeds with 900s default TTL and writes ONLY to .agents/locks/active_scopes.json
        const okLease = agReg.acquireOrRenewLease({
          trajectoryId: 'ag-traj-99',
          claimedPaths: ['sidecars/horizon-daemon/server.mjs']
        });
        assert.equal(okLease.ok, true);
        assert.equal(okLease.lease.ttl_ms, 900_000);
        assert.equal(fs.existsSync(getLockFilePath(tmpWs)), true);
        assert.equal(fs.readFileSync(claudeLockPath, 'utf8'), claudeRaw, '.claude/locks/active_scopes.json must remain strictly read-only');
      } finally {
        rmSafe(tmpWs);
      }
    });
  });
});
