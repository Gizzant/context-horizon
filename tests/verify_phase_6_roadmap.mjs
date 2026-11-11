import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveModelCeiling, scaleEffortProfileForCeiling, EFFORT_PROFILES } from '../src/core/constants.mjs';
import { parseRawJsonl } from '../src/core/parser.mjs';
import { computeDelta, recordAndDelta } from '../src/core/history.mjs';
import { computeQuotaAndCacheTelemetry } from '../src/core/quota.mjs';
import { classifyHorizon } from '../src/core/classifier.mjs';
import { inspectSubagentTree } from '../src/core/subagents.mjs';
import { measureBaseline } from '../src/core/baseline.mjs';
import { foldCodeToSignatureStub, collapseDeadErrorToTombstone, pruneSessionTranscript } from '../src/core/pruner.mjs';
import { fileURLToPath } from 'node:url';
import { evaluateProcessTable } from '../src/core/host_watchdog.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('--- Verifying Phase 6: Evaluation Roadmap (Waves 1-4) ---');

// 1. T1.1: Dynamic 256K & 1M Model Ceiling Resolution & Effort Scaling
assert.equal(resolveModelCeiling('gemini-3.8-flash'), 256000, 'Gemini 3.8 Flash native ceiling should be 256k');
assert.equal(resolveModelCeiling('gemini-4-argon-high'), 1048576, 'Gemini 4 Argon High native ceiling should be 1,048,576');
assert.equal(resolveModelCeiling('claude-opus-5.5'), 1000000, 'Claude Opus 5.5 native ceiling should be 1,000,000');
assert.equal(resolveModelCeiling('gemini-1.5-pro-1m'), 1000000, '1M model ceiling should resolve to 1,000,000');
const scaledHigh = scaleEffortProfileForCeiling(EFFORT_PROFILES.HIGH, 256000);
assert.equal(scaledHigh.safeLimit, 147000, '256k High effort safe limit should scale to 147k');
assert.equal(scaledHigh.thinkingReserve, 32000, '256k High effort thinking reserve should scale to 32k');
console.log('✓ Check 1 (T1.1): 256K / 1M Dynamic Model Ceiling & Effort Scaling verified.');

// 2. T1.2: Undo/Rewind Rollback vs Compaction & Subagent Stream Partitioning
const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-test-'));
const rawJsonlSample = [
  JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Init', input_tokens: 12000, output_tokens: 500 }),
  JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Working', cache_read_input_tokens: 11500, cache_creation_input_tokens: 500, thinking_tokens: 2000, output_tokens: 1000 }),
  JSON.stringify({ step_index: 2, subagent_id: 'sub-123', type: 'PLANNER_RESPONSE', content: 'Child subagent step', output_tokens: 4000 })
].join('\n');
const parsedSteps = parseRawJsonl(rawJsonlSample);
assert.equal(parsedSteps[1].cacheReadTokens, 11500, 'Must extract cache_read_input_tokens');
assert.equal(parsedSteps[1].thinkingTokens, 2000, 'Must extract thinking_tokens');
assert.equal(parsedSteps[2].agentId, 'child:sub-123', 'Must partition child subagent stream');

const prevSnap = { userTurn: 5, stepCount: 15, total: 90000, byCategory: { ACTIVE_WORKING_SET: 90000 } };
const rewindSnap = { userTurn: 4, stepCount: 11, total: 65000, byCategory: { ACTIVE_WORKING_SET: 65000 } };
const deltaRewind = computeDelta(prevSnap, rewindSnap, parsedSteps);
assert.equal(deltaRewind.rewound, true, 'Step regression without checkpoint must be flagged as rewound');
assert.equal(deltaRewind.compacted, false, 'Step regression without checkpoint must NOT misfire compacted');
console.log('✓ Check 2 (T1.2): Undo/Rewind rollback vs Compaction & Subagent stream partitioning verified.');

// 3. T2.1: Rank #1 Dual-Pool Quota (5h Sprint / 7d Weekly) & Cache-Read Engine
const quotaTelemetry = computeQuotaAndCacheTelemetry(parsedSteps, {
  sessionId: 'test-quota-session',
  totalActiveTokens: 120000,
  activeEffortProfile: EFFORT_PROFILES.HIGH,
  cacheDir: tmpCache
});
assert.ok(quotaTelemetry.cache.hitRatePct > 0, 'Cache hit rate should be computed from cache_read_input_tokens');
assert.ok(quotaTelemetry.sprint5h.poolUnits === 5000000, '5h Sprint pool should be initialized');
assert.ok(quotaTelemetry.weekly7d.sprintToWeeklyMultiplier === 2.8, 'Weekly-to-Sprint ratio should be 2.8x');
assert.ok(quotaTelemetry.forecast.nextTurnHighSprintPct > 0, 'Next-turn High-effort Sprint burn forecast must be > 0');
console.log('✓ Check 3 (T2.1): Rank #1 Dual-Pool Quota & Cache-Read Telemetry Engine verified.');

// 4. T2.2: HN Critique Fix — Semantic Reference Pinning for Turns > 25 Steps Old
const longSessionSteps = [];
for (let i = 0; i < 32; i++) {
  if (i === 2) {
    // Turn 2 (>25 steps ago) reads core_schema.sql and defines CREATE TABLE user_accounts
    longSessionSteps.push({
      stepIndex: i,
      type: 'PLANNER_RESPONSE',
      toolCalls: [{ name: 'read_file', args: { Path: 'src/db/core_schema.sql' } }],
      content: 'CREATE TABLE user_accounts (id INT PRIMARY KEY);',
      outputTokens: 2000,
      untruncatedLength: 8000
    });
  } else if (i === 30) {
    // Active window references core_schema.sql and user_accounts without re-reading the file
    longSessionSteps.push({
      stepIndex: i,
      type: 'PLANNER_RESPONSE',
      toolCalls: [],
      content: 'Querying user_accounts defined in core_schema.sql for active login.',
      outputTokens: 1000,
      untruncatedLength: 4000
    });
  } else {
    longSessionSteps.push({
      stepIndex: i,
      type: 'PLANNER_RESPONSE',
      toolCalls: [],
      content: `Minor CSS tweak step ${i}`,
      outputTokens: 500,
      untruncatedLength: 2000
    });
  }
}
const classified = classifyHorizon(longSessionSteps, { useNativeCeiling: true, cacheDir: tmpCache });
assert.equal(classified.window.maxTokens, 256000, 'useNativeCeiling must set window.maxTokens to 256,000');
assert.equal(classified.window.cellSizeTokens, 6400, '256,000 window must set cellSizeTokens to 6,400');
assert.ok(classified.brainSignals.activeSignal.semanticallyPinnedTurns >= 1, 'Turn 2 core_schema.sql must be semantically pinned against step-25 decay');
console.log('✓ Check 4 (T2.2): Semantic Reference Pinning (>25 steps) & 256K 40-cell scaling verified.');

// 5. T2.3 & T2.4: Subagent Context Tree Inspector & 5-Bucket Zero-Turn Profiler
const subagentSteps = [
  {
    stepIndex: 0,
    type: 'PLANNER_RESPONSE',
    toolCalls: [{ name: 'invoke_subagent', args: { Role: 'Codebase Researcher', TypeName: 'research', Workspace: 'inherit' } }],
    content: 'Launching research subagent',
    outputTokens: 400
  },
  {
    stepIndex: 1,
    agentId: 'child:sub-research',
    type: 'PLANNER_RESPONSE',
    content: 'x'.repeat(80000),
    outputTokens: 20000,
    untruncatedLength: 80000
  },
  {
    stepIndex: 2,
    type: 'USER_INPUT',
    content: 'Subagent research completed: summary is 500 tokens.',
    outputTokens: 500,
    untruncatedLength: 2000
  }
];
const subTree = inspectSubagentTree(subagentSteps, { cacheDir: tmpCache });
assert.equal(subTree.count, 1, 'Must detect 1 invoke_subagent call');
assert.ok(subTree.overallCompressionRatio >= 10, `Expected high subagent compression ratio, got ${subTree.overallCompressionRatio}x`);

const baseProfile = measureBaseline(REPO_ROOT);
assert.ok(baseProfile.buckets && baseProfile.buckets.rule && baseProfile.buckets.skill && baseProfile.buckets.mcp && baseProfile.buckets.subagent && baseProfile.buckets.workflow, 'Baseline profiler must return all 5 customization buckets');
console.log('✓ Check 5 (T2.3 & T2.4): Subagent Context Tree Inspector & 5-Bucket Zero-Turn Profiler verified.');

// 6. T3.1: Rank #2 Prefix-Safe Surgical Context Pruner & AST Signature Folder
const sampleCode = [
  'import fs from "node:fs";',
  'export function computeAlpha(x) {',
  ...Array.from({ length: 40 }, (_, i) => `  const step_${i} = x + ${i};`),
  '  return x;',
  '}',
  'export class HorizonEngine {',
  ...Array.from({ length: 40 }, (_, i) => `  // body line ${i}`),
  '}'
].join('\n');
const folded = foldCodeToSignatureStub(sampleCode, 'src/core/engine.mjs');
assert.equal(folded.wasFolded, true, 'Large source file must be folded into AST signature stub');
assert.ok(folded.condensed.includes('export function computeAlpha'), 'AST stub must preserve exported function signature');
assert.ok(folded.condensed.includes('export class HorizonEngine'), 'AST stub must preserve exported class signature');
assert.ok(folded.savedChars > 400, 'AST stub must save implementation body characters');

const sampleErr = 'Traceback (most recent call last):\n' + '  at Object.<anonymous> (foo.js:12:3)\n'.repeat(30) + 'TypeError: Cannot read properties of undefined';
const collapsed = collapseDeadErrorToTombstone(sampleErr, 4, 'run_command');
assert.equal(collapsed.wasCollapsed, true, 'Dead error trace must collapse to tombstone');
assert.ok(collapsed.condensed.includes('[Resolved Error at Turn #4'), 'Tombstone must include turn index');
console.log('✓ Check 6 (T3.1): Rank #2 Prefix-Safe AST Signature Folder & Error Tombstone verified.');

// 7. T3.2: Rank #3 Host Process & Zombie Watchdog
const mockProcessTable = [
  { pid: 100, ppid: 1, name: 'Antigravity.exe', rssBytes: 500 * 1024 * 1024, commandLine: 'Antigravity.exe' },
  { pid: 201, ppid: 100, name: 'language_server_windows_x64.exe', rssBytes: 800 * 1024 * 1024, commandLine: 'language_server_windows_x64.exe --stdio' },
  { pid: 301, ppid: 99999, name: 'language_server_windows_x64.exe', rssBytes: 450 * 1024 * 1024, commandLine: 'language_server_windows_x64.exe multicall schedule' },
  { pid: 302, ppid: 99998, name: 'node.exe', rssBytes: 120 * 1024 * 1024, commandLine: 'node mcp-server-orphan.js' }
];
const hostEval = evaluateProcessTable(mockProcessTable, new Set([1, 100, 201]));
assert.equal(hostEval.orphanCount, 2, 'Must detect multicall schedule leak and detached parent MCP orphan');
console.log('✓ Check 7 (T3.2): Rank #3 Host Process & Zombie Watchdog verified.');

// 8. T4.1 & T4.2: 3-Way Mirror Sync, SHA-256 Parity & UI Invariants
const syncRes = syncAndVerifyMirrors();
assert.equal(syncRes.parityOk, true, '3-Way WebView Mirror SHA-256 parity must hold');
const htmlContent = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
assert.ok(htmlContent.includes('id="compactInstruction"'), 'Must retain #compactInstruction');
assert.ok(!htmlContent.includes('id="btnCompactPrimary"'), 'Must NEVER render clickable copy button for /compact');
assert.ok(htmlContent.includes('id="quotaStrip"'), 'Must include Dual-Pool Quota strip');
assert.ok(htmlContent.includes('id="hostWatchdogBar"'), 'Must include Host Watchdog footer bar');
console.log('✓ Check 8 (T4.1 & T4.2): 3-Way SHA-256 Mirror Parity & UI Invariants verified.');

console.log('✓ Phase 6 Roadmap verification PASSED with 0 errors.');
