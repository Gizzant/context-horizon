# Source File: tests/verify_e2e_context_memory.mjs

```javascript
﻿import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { startServer } from '../sidecars/horizon-daemon/server.mjs';
import { runCLI as runVisualizerCLI } from '../src/cli/horizon_hud.mjs';
import { pruneSessionTranscript } from '../src/core/pruner.mjs';
import { classifyHorizon, calculateParabolicAttentionCurve, evaluateCompositeSessionRisk, evaluateHistoryBarState, computeDisplayTenthsParity } from '../src/core/classifier.mjs';
import { parseRawJsonl, parseTranscriptIncremental, readSessionGenMetadataSync, reconcileWorkspaceAndKIs } from '../src/core/parser.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';
import { EFFORT_PROFILES, scaleEffortProfileForCeiling } from '../src/core/constants.mjs';
import { isInternalTelemetryPath, synthesizeParameterizedCompact, synthesizeBatonPassHandoffCommand, evaluateCompactionCacheAdvisory } from '../src/core/prompt_rubric.mjs';
import { computeQuotaAndCacheTelemetry, extractHubProcessInfo } from '../src/core/quota.mjs';
import { evaluateProcessTable } from '../src/core/host_watchdog.mjs';
import { runCLI as runPluginCLI } from 'file:///C:/Users/frank/.gemini/config/plugins/agy-horizon/src/cli/horizon_hud.mjs';
import { handleHook } from 'file:///C:/Users/frank/.gemini/config/plugins/agy-horizon/src/cli/horizon_hook.mjs';
import { syncSessionCatalog } from 'file:///C:/Users/frank/.gemini/config/plugins/agy-horizon/src/core/catalog.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('C:/Users/frank/AppData/Local/Temp/node_modules/jsdom');

console.log('================================================================================');
console.log('  END-TO-END CONTEXT MEMORY VALIDATION SUITE (CORE + DAEMON + JSDOM + LIVE)');
console.log('================================================================================\n');

// ---------------------------------------------------------------------------
// 1. Run Legacy JSDOM Regression Suite (`test_regressions.cjs`)
// ---------------------------------------------------------------------------
console.log('[1/7] Running Legacy JSDOM Regression Suite (test_regressions.cjs)...');
const regOut = execSync('node "C:/Users/frank/.gemini/antigravity/brain/399d4543-f9ad-435f-9668-7185ad32523b/scratch/test_regressions.cjs"', {
  encoding: 'utf8',
  timeout: 15000
});
assert.ok(regOut.includes('ALL ASSERTIONS PASSED'), 'Legacy JSDOM regression suite must pass 100%');
console.log('  âœ“ Legacy JSDOM regression suite passed all assertions.\n');

// ---------------------------------------------------------------------------
// 2. JSDOM Validation of New Wave 1-4 UI Elements & Action Handlers
// ---------------------------------------------------------------------------
console.log('[2/7] Validating New Wave 1-4 WebView UI Elements & Handlers in JSDOM...');
const htmlPath = 'C:/Projects/ga-visualizer-v2/src/webview/horizon_panel.html';
const html = fs.readFileSync(htmlPath, 'utf8');

const apiCalls = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:62935/',
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      apiCalls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (url === '/api/prune') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            prunedSteps: 4,
            savedTokens: 18400
          })
        };
      }
      if (url === '/api/host/reap') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            reapedCount: 2
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    w.EventSource = class { addEventListener() {} close() {} };
    w.navigator.clipboard = { writeText: async () => {} };
  }
});

const w = dom.window;
const d = w.document;

// Verify isIgnorablePath invariant
assert.equal(w.isIgnorablePath('src/core/classifier.mjs'), false, 'Active .mjs source file must NEVER be ignorable');
assert.equal(w.isIgnorablePath('src/webview/horizon_panel.html'), false, 'Active .html source file must NEVER be ignorable');
assert.equal(w.isIgnorablePath('package-lock.json'), true, 'Lockfile must be ignorable');
assert.equal(w.isIgnorablePath('dist/bundle.min.js'), true, 'Build artifact must be ignorable');
assert.equal(w.isIgnorablePath('scratch/test_tmp.js'), true, 'Scratch file must be ignorable');

const richRoadmapState = {
  schemaVersion: '1.1.0',
  sessionId: 'e2e-roadmap-session',
  sessionTitle: 'E2E Roadmap Validation',
  window: {
    maxTokens: 256000,
    cellSizeTokens: 6400,
    totalCells: 40,
    totalActiveTokens: 132000,
    usedPercentage: 51.6,
    turnCount: 38,
    safeLimit: 147000,
    reminderAt: 124950
  },
  breakdown: {
    ANCHOR: 22000,
    ACTIVE_WORKING_SET: 74000,
    STALE_DUPLICATE: 31000,
    DEAD_ERROR: 5000,
    FREE_HEADROOM: 124000
  },
  metrics: {
    signalPurityPct: 73,
    sludgeTokens: 36000,
    healthBand: 'VISIBLE_CLUTTER'
  },
  activeEffortProfile: {
    tier: 'HIGH',
    safeLimit: 147000,
    thinkingReserve: 32000,
    label: 'High Effort',
    shortLabel: 'High',
    limitReason: '32k reserved for deep reasoning'
  },
  effortTransitions: [
    { turnIndex: 12, stepNumber: 12, blockIndex: 8, fromTier: 'STANDARD', toTier: 'HIGH', fromLabel: 'Auto', toLabel: 'High' }
  ],
  quota: {
    sprint5h: { usedPct: 24.5, remainingPct: 75.5 },
    weekly7d: { usedPct: 68.2, remainingPct: 31.8, lockoutRisk: true },
    cache: { hitRatePct: 92, ttlRemainingSec: 185, isCacheCold: false },
    forecast: { nextTurnHighSprintPct: 2.35 }
  },
  subagents: {
    count: 1,
    totalIsolatedTokens: 48200,
    totalHandoffTokens: 1200,
    totalSavedTokens: 47000,
    overallCompressionRatio: 40.2,
    invocations: [
      {
        stepIndex: 6,
        typeName: 'research',
        workspaceMode: 'inherit',
        isolatedTokens: 48200,
        handoffTokens: 1200,
        tokensSaved: 47000,
        compressionRatio: 40.2,
        badgeLabel: '[Subagent: research | 48.2k isolated -> 1.2k handoff (40x)]'
      }
    ]
  },
  baseline: {
    totalEst: 4800,
    rows: [
      { source: 'AGENTS.md (workspace)', kind: 'rule', tokens: 1200 },
      { source: 'MCP: notebooklm', kind: 'mcp', tokens: 600, schemaTokens: 10800, toolCount: 50 }
    ],
    buckets: {
      rule: { id: 'rule', label: 'Rules (AGENTS.md & Global)', tokens: 1200, budgetTokens: 20000, usedPct: 6 },
      skill: { id: 'skill', label: 'Skills (Frontmatter Index)', tokens: 1400, budgetTokens: 20000, usedPct: 7 },
      mcp: { id: 'mcp', label: 'MCP Tool Listings & Instructions', tokens: 1800, budgetTokens: 20000, usedPct: 9 },
      subagent: { id: 'subagent', label: 'Subagent Definitions', tokens: 250, budgetTokens: 20000, usedPct: 1.3 },
      workflow: { id: 'workflow', label: 'Workflows', tokens: 150, budgetTokens: 20000, usedPct: 0.8 }
    }
  },
  hostHealth: {
    rssGb: 2.45,
    languageServerCount: 4,
    orphanCount: 2,
    status: 'ZOMBIE_LEAK'
  },
  brainSignals: {
    activeSignal: { liveSessionTokens: 74000, taskMdSaved: true, taskMdTurnsBehind: 1, semanticallyPinnedTurns: 2 },
    duplicateReads: {
      fileCount: 1,
      reclaimableTokens: 21000,
      topFiles: [{ path: 'src/core/classifier.mjs', occurrences: 3, wastedTokens: 21000 }]
    },
    oldHistory: { turnCount: 12, reclaimableTokens: 10000 },
    deadErrors: { errorCount: 1, reclaimableTokens: 5000, isErrorLoop: false },
    blowupSteps: [],
    userCorrections: 1
  },
  delta: { tokens: -14200, rewound: true, compacted: false },
  cells: Array.from({ length: 40 }, (_, i) => ({
    index: i,
    tokenRange: [i * 6400, (i + 1) * 6400],
    turnRange: [i, i + 1],
    dominantCategory: i < 20 ? 'ACTIVE_WORKING_SET' : 'FREE_HEADROOM'
  }))
};

w.renderState(richRoadmapState);
await new Promise(r => setTimeout(r, 30));

assert.equal(d.getElementById('usedMaxTok').textContent, '256k', 'Header denominator must render 256k');
assert.equal(d.getElementById('quotaStrip').hidden, false, 'Quota strip must be visible');
assert.ok(d.getElementById('quotaPills').textContent.includes('5h Sprint: 24.5%'), 'Quota strip must show 5h Sprint %');
assert.ok(d.getElementById('quotaPills').textContent.includes('Cache: 92% hit (185s TTL)'), 'Quota strip must consolidate Cache hit % and TTL inline');
assert.ok(d.getElementById('quotaPills').textContent.includes('7d Lockout Risk'), 'Quota strip must show 7d Lockout Risk badge');
assert.ok(d.getElementById('quotaForecast').textContent.includes('Next High turn: ~2.35% of 5h'), 'Quota forecast must show Next High turn burn');
assert.equal(d.getElementById('barError').style.width, '0%', 'Red error bar segment must be merged into amber Reclaimable bar');
assert.ok(d.getElementById('limitLine').classList.contains('border-rose-400/80'), 'Limit line must use border-rose-400/80 threshold styling');
assert.ok(d.getElementById('limitTag').classList.contains('text-rose-300'), 'Limit tag must use text-rose-300 threshold styling');
assert.equal(d.querySelector('.diag-group.reclaim .group-meta')?.textContent.trim(), '3 categories', 'Reclaim subheader must show 3 categories label');
const reclaimImpacts = [...d.querySelectorAll('.diag-group.reclaim .diag-impact')].map(el => el.textContent.trim());
assert.deepEqual(reclaimImpacts, ['21.0k', '10.0k', '5.0k'], 'Reclaim diagnostic rows must show 1-decimal tabular numerals without repeating "reclaimable"');
assert.ok(d.getElementById('playbookList').textContent.includes('Unlogged User Corrections (1 rule candidate)'), 'User corrections row must use de-duplicated Unlogged User Corrections label');
assert.equal(d.getElementById('highEffortSludgeBanner').hidden, false, 'High-Effort Sludge Tax banner must be visible when High effort + >=30k clutter');
assert.ok(d.getElementById('deltaLine').textContent.includes('(rewound step)'), 'Delta line must show (rewound step) on Undo/Rewind');
assert.equal(d.getElementById('bucketBars').children.length, 5, '5-Bucket Zero-Turn Profiler must render 5 progress rows');
assert.equal(d.getElementById('subagentPills').hidden, false, 'Subagent pills container must be visible');
assert.ok(d.getElementById('subagentPills').textContent.includes('48.2k isolated -> 1.2k handoff (40x)'), 'Subagent pill must render compression ratio');
assert.equal(d.getElementById('hostWatchdogBar').hidden, false, 'Host Watchdog footer bar must be visible');
assert.equal(d.getElementById('btnReapOrphans').hidden, false, 'Reap Zombies button must be visible when orphanCount > 0');

// Click Condense Stale Reads (AST Fold) button & Reap Zombies button
d.getElementById('btnCondenseAst').click();
await new Promise(r => setTimeout(r, 30));
assert.ok(apiCalls.some(c => c.url === '/api/prune' && c.method === 'POST'), 'Clicking #btnCondenseAst must POST to /api/prune');
assert.ok(d.getElementById('feedbackToast').textContent.includes('Condensed 4 stale steps'), 'Toast must confirm condensed steps');

d.getElementById('btnReapOrphans').click();
await new Promise(r => setTimeout(r, 30));
assert.ok(apiCalls.some(c => c.url === '/api/host/reap' && c.method === 'POST'), 'Clicking #btnReapOrphans must POST to /api/host/reap');
assert.ok(d.getElementById('feedbackToast').textContent.includes('Reaped 2 orphaned process(es)'), 'Toast must confirm reaped processes');

dom.window.close();
console.log('  âœ“ All new Wave 1-4 UI elements, 256K ceiling labels, and POST handlers verified in JSDOM.\n');

// ---------------------------------------------------------------------------
// 3. End-to-End Surgical Context Pruner (`pruner.mjs`) on Synthetic Session
// ---------------------------------------------------------------------------
console.log('[3/7] Testing Prefix-Safe Surgical Context Pruner & AST Folder on Multi-Turn Session...');
const tmpSessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-prune-e2e-'));
const logsDir = path.join(tmpSessionRoot, '.system_generated', 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const transcriptFile = path.join(logsDir, 'transcript_full.jsonl');

const largeSourceRead = [
  'import path from "node:path";',
  'export async function processTelemetryBatch(items) {',
  ...Array.from({ length: 60 }, (_, idx) => `  const row_${idx} = items[${idx}] || 0;`),
  '  return items.length;',
  '}',
  'export class TelemetryAggregator {',
  ...Array.from({ length: 50 }, (_, idx) => `  // internal implementation line ${idx}`),
  '}'
].join('\n');

const largeStackTrace = [
  'Traceback (most recent call last):',
  ...Array.from({ length: 35 }, (_, idx) => `  File "worker_${idx}.py", line ${idx + 10}, in execute_step`),
  'RuntimeError: Connection reset by peer during batch upload'
].join('\n');

const nowIso = new Date().toISOString();
const syntheticJsonlLines = [
  JSON.stringify({ step_index: 0, type: 'SYSTEM_PROMPT', content: 'System rules & anchors', input_tokens: 15000, created_at: nowIso }),
  JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: 'Inspect telemetry module', output_tokens: 200, created_at: nowIso }),
  JSON.stringify({
    step_index: 2,
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'read_file', args: { Path: 'src/core/telemetry.mjs' } }],
    content: largeSourceRead,
    output_tokens: Math.ceil(largeSourceRead.length / 4),
    created_at: nowIso
  }),
  JSON.stringify({
    step_index: 3,
    type: 'PLANNER_RESPONSE',
     status: 'ERROR',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'python worker.py' } }],
    content: largeStackTrace,
    output_tokens: Math.ceil(largeStackTrace.length / 4),
    created_at: nowIso
  }),
  JSON.stringify({
    step_index: 4,
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'read_file', args: { Path: 'src/core/telemetry.mjs' } }],
    content: largeSourceRead,
    output_tokens: Math.ceil(largeSourceRead.length / 4),
    created_at: nowIso
  }),
  ...Array.from({ length: 9 }, (_, idx) => JSON.stringify({
    step_index: 5 + idx,
    type: 'PLANNER_RESPONSE',
    content: `Active working window step ${5 + idx}`,
    output_tokens: 300,
    created_at: nowIso
  }))
];
fs.writeFileSync(transcriptFile, syntheticJsonlLines.join('\n') + '\n', 'utf8');

// 3a. Warm cache guard check (forceHotCache: false should block and request confirmation)
const warmCheck = pruneSessionTranscript(tmpSessionRoot, { dryRun: false, forceHotCache: false, cacheDir: tmpSessionRoot });
assert.equal(warmCheck.success, false, 'Warm prefix cache must block unforced pruning');
assert.equal(warmCheck.requiresConfirmation, true, 'Must set requiresConfirmation: true when prefix cache is warm');

// 3b. Dry-run preview check
const dryCheck = pruneSessionTranscript(tmpSessionRoot, { dryRun: true, cacheDir: tmpSessionRoot });
assert.equal(dryCheck.success, true, 'Dry-run prune must succeed');
assert.equal(dryCheck.prunedSteps, 2, 'Must identify 2 prunable steps (Step 2 superseded file read + Step 3 resolved error)');
assert.ok(dryCheck.savedTokens > 800, `Expected >800 saved tokens, got ${dryCheck.savedTokens}`);

// 3c. Execute surgical prune with backup verification
const beforeSteps = parseRawJsonl(fs.readFileSync(transcriptFile, 'utf8'));
const beforeState = classifyHorizon(beforeSteps, { useNativeCeiling: true, cacheDir: tmpSessionRoot });
const execPrune = pruneSessionTranscript(tmpSessionRoot, { dryRun: false, forceHotCache: true, cacheDir: tmpSessionRoot });
assert.equal(execPrune.success, true, 'Forced prune must succeed');
assert.ok(execPrune.backupPath && fs.existsSync(execPrune.backupPath), 'Atomic .pre_prune backup file must exist on disk');

const afterSteps = parseRawJsonl(fs.readFileSync(transcriptFile, 'utf8'));
const afterState = classifyHorizon(afterSteps, { useNativeCeiling: true, cacheDir: tmpSessionRoot });
assert.ok(afterSteps[2].content.includes('[AST Signature Stub'), 'Step 2 must be condensed into an AST Signature Stub');
assert.ok(afterSteps[2].content.includes('export async function processTelemetryBatch'), 'AST stub must preserve function signature');
assert.ok(afterSteps[3].content.includes('[Resolved Error at Turn #3'), 'Step 3 error must be collapsed into a 1-line tombstone');
assert.equal(afterSteps[4].content, largeSourceRead, 'Latest read of telemetry.mjs (Step 4) must remain untouched');
assert.ok(afterState.window.totalActiveTokens < beforeState.window.totalActiveTokens, 'Total active tokens must decrease after surgical pruning');
console.log(`  âœ“ Surgical Pruner condensed ${execPrune.prunedSteps} steps (${beforeState.window.totalActiveTokens} -> ${afterState.window.totalActiveTokens} tok) with atomic backup.\n`);

// ---------------------------------------------------------------------------
// 4. Live HTTP Sidecar Daemon End-to-End Integration Test
// ---------------------------------------------------------------------------
console.log('[4/7] Starting Live Sidecar Daemon & Testing All HTTP / SSE Endpoints...');
const { server, port } = await startServer(0);
const baseUrl = `http://127.0.0.1:${port}`;
let openBrainFallbackVerified = false;

try {
  // 4a. GET /api/health
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.port, port);

  // 4b. GET / (WebView HTML) & GET /preload.js
  const indexRes = await fetch(`${baseUrl}/`);
  assert.equal(indexRes.status, 200);
  const indexHtml = await indexRes.text();
  assert.ok(indexHtml.includes('id="quotaStrip"'), 'Daemon / route must serve updated WebView HTML');

  const preloadRes = await fetch(`${baseUrl}/preload.js`);
  assert.equal(preloadRes.status, 200);

  // 4c. GET /api/state (Live 256K state + hostHealth + quota + subagents + baseline)
  const stateRes = await fetch(`${baseUrl}/api/state`);
  assert.equal(stateRes.status, 200);
  const liveState = await stateRes.json();
  assert.equal(liveState.window.maxTokens, 256000, 'Live /api/state must report 256,000 native ceiling');
  assert.ok(liveState.quota && liveState.quota.sprint5h, 'Live /api/state must include quota telemetry');
  assert.ok(liveState.hostHealth && typeof liveState.hostHealth.rssGb === 'number', 'Live /api/state must include hostHealth telemetry');
  assert.ok(liveState.baseline && liveState.baseline.buckets, 'Live /api/state must include 5-bucket baseline telemetry');

  // 4d. GET /api/settings & POST /api/settings
  const getSetRes = await fetch(`${baseUrl}/api/settings`);
  assert.equal(getSetRes.status, 200);
  const getSetJson = await getSetRes.json();
  assert.ok(getSetJson.settings, 'GET /api/settings must return settings');

  // 4e. POST /api/prune (dryRun: true)
  const pruneApiRes = await fetch(`${baseUrl}/api/prune`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true })
  });
  assert.equal(pruneApiRes.status, 200);
  const pruneApiJson = await pruneApiRes.json();
  assert.equal(pruneApiJson.success, true, 'POST /api/prune (dryRun) must return success: true');

  // 4f. POST /api/host/reap (safe empty PID list)
  const reapApiRes = await fetch(`${baseUrl}/api/host/reap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pids: [] })
  });
  assert.equal(reapApiRes.status, 200);
  const reapApiJson = await reapApiRes.json();
  assert.equal(reapApiJson.success, true, 'POST /api/host/reap must return success: true');

  // 4g. GET /api/stream (SSE initial payload)
  const abortCtrl = new AbortController();
  const streamRes = await fetch(`${baseUrl}/api/stream`, { signal: abortCtrl.signal });
  assert.equal(streamRes.status, 200);
  assert.ok(streamRes.headers.get('content-type').includes('text/event-stream'));
  const reader = streamRes.body.getReader();
  const { value } = await reader.read();
  const chunkStr = new TextDecoder().decode(value);
  assert.ok(chunkStr.startsWith('data: {'), 'SSE stream must emit initial JSON state event');
  await reader.cancel();
  abortCtrl.abort();

  // 4h. POST /api/open-brain (Fallback to conversations/ when brain/<uuid> absent)
  const openBrainRes = await fetch(`${baseUrl}/api/open-brain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: 'nonexistent-session-for-fallback', surface: 'antigravity-cli', dryRun: true })
  });
  assert.equal(openBrainRes.status, 200);
  const openBrainJson = await openBrainRes.json();
  assert.equal(openBrainJson.success, true);
  assert.equal(openBrainJson.fallbackUsed, true, 'POST /api/open-brain must use fallback when brain/<id> does not exist');
  assert.ok(openBrainJson.brainDir.includes('conversations') || openBrainJson.brainDir.includes('antigravity'), 'Fallback directory must point to conversations or surface directory');
  openBrainFallbackVerified = openBrainJson.fallbackUsed === true;
} finally {
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`  âœ“ Live Sidecar Daemon on port ${port} passed all 9 HTTP & SSE endpoint checks.\n`);

// ---------------------------------------------------------------------------
// 5. Real Active Session Transcript & Plugin Hook Validation
// ---------------------------------------------------------------------------
console.log('[5/7] Validating Real Active Conversation (33c7de94-4a9c-4407-b328-c7f836201e8c) & Lifecycle Hooks...');
const activeConvId = '33c7de94-4a9c-4407-b328-c7f836201e8c';
const cliRes = await runVisualizerCLI({
  silent: true,
  stdinData: { conversation_id: activeConvId }
});
assert.ok(cliRes && cliRes.state, 'Visualizer runCLI must return state for active conversation');
assert.equal(cliRes.state.window.maxTokens, 256000, 'Active conversation must use 256K ceiling');
assert.equal(cliRes.state.window.cellSizeTokens, 6400, 'Active conversation must use 6.4k cell size');
assert.ok(cliRes.state.activeEffortProfile && cliRes.state.activeEffortProfile.safeLimit > 0, 'Active conversation must resolve effort profile with safeLimit');
assert.ok(cliRes.state.effortTransitions.length >= 2, `Expected >=2 mid-session effort transitions in active chat, found ${cliRes.state.effortTransitions.length}`);

const pluginCliRes = await runPluginCLI({
  silent: true,
  stdinData: { conversation_id: activeConvId }
});
assert.equal(pluginCliRes.state.window.maxTokens, 256000, 'agy-horizon plugin runCLI must also resolve 256K ceiling');

const hookRes = await handleHook('PreInvocation', { conversationId: activeConvId });
assert.ok(typeof hookRes === 'object', 'PreInvocation hook must return valid response object');
console.log(`  âœ“ Active conversation verified: ${cliRes.state.window.totalActiveTokens} / ${cliRes.state.window.maxTokens} tok | Tier: ${cliRes.state.activeEffortProfile.label} (Limit: ${cliRes.state.window.safeLimit}) | Transitions: ${cliRes.state.effortTransitions.length}.\n`);

// ---------------------------------------------------------------------------
// 6. Refresh Precomputed Session Catalog & Enforce 3-Way SHA-256 Mirror Parity
// ---------------------------------------------------------------------------
console.log('[6/7] Syncing Precomputed Session Catalog & Verifying 3-Way SHA-256 Mirror Parity...');
await syncSessionCatalog(8);
const mirrorCheck = syncAndVerifyMirrors();
assert.equal(mirrorCheck.parityOk, true, '3-Way SHA-256 parity must hold after catalog refresh');
console.log(`  âœ“ 3-Way SHA-256 mirror parity verified (${mirrorCheck.sha256.slice(0, 16)}...).\n`);

// ---------------------------------------------------------------------------
// 7. Unit Assertions for Pre-Launch Bugfixes 1â€“9
// ---------------------------------------------------------------------------
console.log('[7/7] Validating Pre-Launch Bugfixes 1â€“9 Deterministic Assertions...');

// --- Fix #1: Unify activeEffortProfile.safeLimit with 70% Attention Horizon & Idempotent Scaling ---
const standardScaled = scaleEffortProfileForCeiling(EFFORT_PROFILES.STANDARD, 256000);
assert.equal(standardScaled.safeLimit, 179000, 'Standard 256k effort profile safeLimit must be 179k (70%)');
const doubleScaled = scaleEffortProfileForCeiling(standardScaled, 256000);
assert.equal(doubleScaled.safeLimit, 179000, 'scaleEffortProfileForCeiling must be idempotent (no 229k double-scale)');

const classifiedF1 = classifyHorizon([
  { stepIndex: 0, type: 'USER_INPUT', inputTokens: 5000, outputTokens: 100, content: 'task.md' }
], { maxTokensOverride: 256000 });
assert.equal(classifiedF1.activeEffortProfile.safeLimit, 179000, 'activeEffortProfile.safeLimit must equal 179k');
assert.equal(classifiedF1.window.safeLimit, 179000, 'window.safeLimit must equal 179k');
assert.equal(classifiedF1.window.safeHeadroomTokens, 179000 - classifiedF1.window.totalActiveTokens, 'safeHeadroomTokens must be exact integer');

// --- Fix #2: Low-Token False Positives Guard on U-Shaped Attention Trough ---
const lowTokenClassified = classifyHorizon([
  { stepIndex: 0, type: 'USER_INPUT', inputTokens: 5000, outputTokens: 100, content: 'Start task' },
  { stepIndex: 1, type: 'PLANNER_RESPONSE', inputTokens: 2000, outputTokens: 3000, content: 'Working on code' }
], { maxTokensOverride: 256000 });
assert.ok(lowTokenClassified.window.totalActiveTokens < 44800, 'Session tokens must be < 44.8k');
const troughCellsCount = lowTokenClassified.cells.filter(c => c.inAttentionTrough).length;
assert.equal(troughCellsCount, 0, 'Sessions < 44.8k must have 0 cells in low-attention trough');
assert.equal(lowTokenClassified.attentionHeatmap.strandedSignalCount, 0, 'Sessions < 44.8k must have 0 stranded signals');
const lowCellCurve = calculateParabolicAttentionCurve(2, 5);
assert.equal(lowCellCurve.inTrough, false, 'Curve with activeCellCount < 7 must return inTrough: false');

// --- Fix #3: Filter .system_generated/steps/ Paths from /compact & /handoff Synthesis ---
assert.equal(isInternalTelemetryPath('.system_generated/steps/1/output.txt'), true);
assert.equal(isInternalTelemetryPath('steps/42/output.txt'), true);
assert.equal(isInternalTelemetryPath('C:\\Users\\user\\.gemini\\antigravity\\brain\\abc\\steps\\1\\output.txt'), true);
assert.equal(isInternalTelemetryPath('src/core/classifier.mjs'), false);

const sanitizedCompact = synthesizeParameterizedCompact({
  activeFiles: ['src/core/quota.mjs', '.system_generated/steps/1/output.txt', 'steps/2/output.txt']
});
assert.ok(sanitizedCompact.includes('quota.mjs'), 'Compact must include active source files');
assert.ok(!sanitizedCompact.includes('.system_generated'), 'Compact must NOT include .system_generated');
assert.ok(!sanitizedCompact.includes('steps/'), 'Compact must NOT include steps/ hydration paths');

const sanitizedHandoff = synthesizeBatonPassHandoffCommand({
  activeFiles: ['src/core/quota.mjs', '.system_generated/steps/1/output.txt']
});
assert.ok(sanitizedHandoff.command.includes('quota.mjs'));
assert.ok(!sanitizedHandoff.command.includes('.system_generated'));

// --- Fix #4: Clear Stale prefixBustDetected When Cache Is Cold ---
const coldTimestamp = Date.now() - 400000; // > 300s ago
const coldQuota = computeQuotaAndCacheTelemetry([
  { stepIndex: 0, type: 'USER_INPUT', inputTokens: 5000, outputTokens: 100, createdAt: new Date(coldTimestamp).toISOString() }
], {
  sessionId: 'cold-session',
  totalActiveTokens: 5000,
  stdinQuota: { prefix_bust: true }
});
assert.equal(coldQuota.cache.isCacheCold, true, 'Cache must be cold after 400s idle');
assert.equal(coldQuota.cache.lastTurnPrefixBust, true, 'lastTurnPrefixBust must record historical flag');
assert.equal(coldQuota.cache.prefixBustDetected, false, 'prefixBustDetected must be false when cache is cold');

const warmRiskNoBust = evaluateCompositeSessionRisk({
  totalActiveTokens: 80000,
  cacheTtlRemainingSec: 200,
  cacheReadTokens: 75000,
  cacheHitRatePct: 94,
  prefixBustDetected: false
});
assert.equal(warmRiskNoBust.prefixLockWarning, true, 'Warm cache >50k with no prefix bust must show prefixLockWarning');

const warmRiskWithBust = evaluateCompositeSessionRisk({
  totalActiveTokens: 80000,
  cacheTtlRemainingSec: 200,
  cacheReadTokens: 75000,
  cacheHitRatePct: 94,
  prefixBustDetected: true
});
assert.equal(warmRiskWithBust.prefixLockWarning, false, 'Prefix bust active must suppress prefixLockWarning');

// --- Fix #5: Checkpoint Epoch Slicing & Mutual Exclusivity in Waste Buckets ---
const scaledClassified = classifyHorizon([
  { stepIndex: 0, type: 'USER_INPUT', inputTokens: 10000, outputTokens: 500, content: 'task.md' },
  { stepIndex: 1, type: 'COMMAND', inputTokens: 1000, outputTokens: 2000, status: 'ERROR', content: 'Traceback' },
  { stepIndex: 2, toolCalls: [{ name: 'read_file', args: { Path: 'src/a.js' } }], inputTokens: 1000, outputTokens: 4000 },
  { stepIndex: 3, toolCalls: [{ name: 'read_file', args: { Path: 'src/a.js' } }], inputTokens: 1000, outputTokens: 4000 }
], {
  stdinContextWindow: { total_input_tokens: 30000 },
  maxTokensOverride: 256000
});
const bkd = scaledClassified.breakdown;
const expectedSludge = bkd.STALE_DUPLICATE + bkd.DEAD_ERROR + bkd.FOREIGN_BLEED;
assert.equal(scaledClassified.metrics.sludgeTokens, expectedSludge, 'Sludge tokens must equal sum of mutually exclusive waste buckets');

// --- Fix #6: Deduplicate amputation.anchorsAtRisk ---
const dupAnchorClassified = classifyHorizon([
  { stepIndex: 0, type: 'SYSTEM_PROMPT', outputTokens: 100000, content: 'rules/' },
  { stepIndex: 1, type: 'USER_INPUT', outputTokens: 100000, content: 'rules/' }
], { maxTokensOverride: 256000 });
assert.equal(dupAnchorClassified.amputation.inAmputationZone, true);
const anchorsList = dupAnchorClassified.amputation.anchorsAtRisk;
assert.deepEqual(anchorsList, ['System & Project Anchors'], 'anchorsAtRisk must contain deduplicated targets');

// --- Fix #7: Multi-Store GenMetadata Turn Count & 0-Step Ghost Filtering ---
const dummyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-fix7-'));
try {
  const { DatabaseSync } = await import('node:sqlite');
  const dummyConvDb = path.join(dummyDbDir, 'dummy-session.db');
  const db = new DatabaseSync(dummyConvDb);
  db.exec('CREATE TABLE gen_metadata (input_tokens INT, cache_read_tokens INT, output_tokens INT, model TEXT, created_at TEXT)');
  db.exec("INSERT INTO gen_metadata VALUES (5000, 2000, 100, 'gemini-3.8-flash', '2026-11-08T09:00:00Z')");
  db.exec("INSERT INTO gen_metadata VALUES (6000, 3000, 200, 'gemini-3.8-flash', '2026-11-08T09:01:00Z')");
  db.close();

  const metaSync = readSessionGenMetadataSync(dummyConvDb, DatabaseSync);
  assert.equal(metaSync.turnCount, 2, 'readSessionGenMetadataSync must report turnCount from gen_metadata row count');
} finally {
  try { fs.rmSync(dummyDbDir, { recursive: true, force: true }); } catch {}
}

// --- Fix #8: agy --hub Process Command-Line Extraction & Watchdog Recognition ---
const hubInfo = extractHubProcessInfo('C:\\Users\\user\\AppData\\Local\\Programs\\Antigravity\\agy.exe --hub --port 18920 --csrf_token secret-token-42');
assert.ok(hubInfo, 'extractHubProcessInfo must match agy --hub');
assert.equal(hubInfo.port, 18920);
assert.equal(hubInfo.csrfToken, 'secret-token-42');

const watchdogProcEval = evaluateProcessTable([
  { pid: 101, ppid: 1, name: 'agy.exe', commandLine: 'agy.exe --hub --port 18920', rssBytes: 50 * 1024 * 1024 }
]);
assert.equal(watchdogProcEval.languageServerCount, 1, 'evaluateProcessTable must recognize agy --hub as language server process');

// --- Fix #9: Cross-Surface open-brain directory fallback ---
assert.equal(openBrainFallbackVerified, true, 'Fix #9: open-brain fallback must be verified');

console.log('  âœ“ Pre-launch bugfixes 1â€“9 deterministic unit assertions PASSED.\n');

// ---------------------------------------------------------------------------
// UI Polish Hotfix 1â€“8 (docs/UI_POLISH_HOTFIX_PLAN.md): state, math & DOM assertions
// ---------------------------------------------------------------------------
console.log('  [7b] Validating UI Polish Hotfix 1â€“8 state, math & DOM assertions...');

// --- Hotfix #1 (core): 0% hit / 0 cache reads is NEVER warm, even with TTL > 0s ---
const coldHitRisk = evaluateCompositeSessionRisk({
  totalActiveTokens: 112749,
  cacheTtlRemainingSec: 299,
  cacheReadTokens: 0,
  cacheHitRatePct: 0
});
assert.equal(coldHitRisk.isCacheTrulyWarm, false, 'Hotfix #1: hitRatePct 0 / cacheReadTokens 0 must not be truly warm');
assert.equal(coldHitRisk.prefixLockWarning, false, 'Hotfix #1: prefixLockWarning must be false at 0% cache hit');
const coldHitBar = evaluateHistoryBarState({ totalActiveTokens: 112749, cacheTtlRemainingSec: 299, isCacheTrulyWarm: coldHitRisk.isCacheTrulyWarm });
assert.notEqual(coldHitBar.state, 'CACHED_WARM', 'Hotfix #1: historyBarState must not be CACHED_WARM at 0% cache hit');
assert.equal(coldHitBar.colorHex, '#f59e0b', 'Hotfix #1: cold history bar must be Amber');
assert.equal(
  evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 299, totalActiveTokens: 112749, isCacheTrulyWarm: false }).state,
  'COMPACT_NOW',
  'Hotfix #1: cacheAdvisory must not be DEFER_WARM at 0% cache hit'
);

// --- Hotfix #1 + #2 (core, end-to-end through classifyHorizon) ---
const hotfixClassified = classifyHorizon([
  { stepIndex: 0, type: 'USER_INPUT', inputTokens: 4000, outputTokens: 50,
    content: "/plan\nDon't render a copy button for /compact, see file:///C:/Users/frank/plan.md and keep the instruction as plain text" },
  { stepIndex: 1, toolCalls: [{ name: 'edit_file', args: { Path: 'C:\\Projects\\ga-visualizer-v2\\src\\webview\\horizon_panel.html' } }], inputTokens: 1000, outputTokens: 3000 },
  { stepIndex: 2, toolCalls: [{ name: 'edit_file', args: { Path: 'C:/Projects/ga-visualizer-v2/tests/verify_e2e_context_memory.mjs' } }], inputTokens: 1000, outputTokens: 3000 }
], { stdinContextWindow: { total_input_tokens: 60000 }, maxTokensOverride: 256000 });
const hfCache = hotfixClassified.quota.cache;
assert.ok(hfCache.hitRatePct === 0 || hfCache.cacheReadTokens === 0, 'Hotfix #1 fixture precondition: classified session has no cache reads');
assert.notEqual(hotfixClassified.window.historyBarState.state, 'CACHED_WARM', 'Hotfix #1: classifyHorizon must not emit CACHED_WARM without cache reads');
assert.equal(hotfixClassified.sessionRisk.prefixLockWarning, false, 'Hotfix #1: classifyHorizon must hide #prefixLockBadge without cache reads');
assert.notEqual(hotfixClassified.compaction.cacheAdvisory.state, 'DEFER_WARM', 'Hotfix #1: classifyHorizon must not DEFER_WARM without cache reads');
const hfCmd = hotfixClassified.compaction.parameterizedCommand;
assert.ok(!hfCmd.includes('in-chat user constraint(s)'), 'Hotfix #2: parameterizedCommand must never contain a count placeholder');
assert.ok(!hfCmd.includes('.../'), 'Hotfix #2: parameterizedCommand must never contain .../ path prefixes');
assert.ok(hfCmd.includes('src/webview/horizon_panel.html'), 'Hotfix #2: paths must be clean workspace-relative paths');
assert.ok(hfCmd.includes('tests/verify_e2e_context_memory.mjs'), 'Hotfix #2: paths must be clean workspace-relative paths');
assert.ok(hfCmd.includes("3) Explicit user constraints: [Don't render a copy button for /compact"), 'Hotfix #2: clause 3 must interpolate real sanitized user text');
assert.ok(!/\/plan\b|file:\/\//.test(hfCmd.split('3)')[1] || ''), 'Hotfix #2: clause 3 must strip /plan headers and artifact URIs');
const hfConstraint = (hfCmd.match(/3\) Explicit user constraints: \[(.*)\]\.$/) || [])[1] || '';
assert.ok(hfConstraint.length > 0 && hfConstraint.length <= 90, 'Hotfix #2: each constraint must be truncated at 90 characters');
const noConstraintCmd = synthesizeParameterizedCompact({ activeFiles: ['src/core/quota.mjs'], userCorrections: ['/plan'] });
assert.ok(!noConstraintCmd.includes('3)'), 'Hotfix #2: clause 3 must be omitted when no valid constraint text exists');
assert.ok(noConstraintCmd.endsWith('2) Current checklist state in task.md.'), 'Hotfix #2: template must end cleanly after clause 2');

// --- Hotfix #3 (core): tenth-of-a-kilotoken parity ---
const parity = computeDisplayTenthsParity(112749, 30400);
assert.equal(parity.displayActiveTenths + parity.displayReclaimableTenths, parity.displayTotalTenths, 'Hotfix #3: Active + Reclaimable tenths must equal total tenths');
const anchoredParity = computeDisplayTenthsParity(112749, 100400, 124);
assert.equal(anchoredParity.displayReclaimableTenths, 124, 'Hotfix #3: anchored Reclaimable must equal the rounded row sum');
assert.equal(anchoredParity.displayActiveTenths + anchoredParity.displayReclaimableTenths, 1127, 'Hotfix #3: anchored parity must sum to the 112.7k headline');

// --- Hotfix #1â€“#8 (JSDOM): render the live-panel bug scenario ---
// Layer 2's JSDOM window is closed at the end of that layer, so use a fresh, block-scoped instance.
{
const hotfixDom = new JSDOM(fs.readFileSync(htmlPath, 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:62935/',
  beforeParse(win) {
    win.fetch = async () => ({ ok: true, json: async () => ({}) });
    win.EventSource = class { addEventListener() {} close() {} };
    win.navigator.clipboard = { writeText: async () => {} };
  }
});
const w = hotfixDom.window;
const d = w.document;
const makeHotfixState = (cache) => ({
  ...richRoadmapState,
  sessionId: 'hotfix-ui-polish',
  window: { ...richRoadmapState.window, totalActiveTokens: 112749, usedPercentage: 44 },
  breakdown: { ANCHOR: 22000, ACTIVE_WORKING_SET: 78400, STALE_DUPLICATE: 12293, DEAD_ERROR: 56, FREE_HEADROOM: 143251 },
  metrics: { signalPurityPct: 89, sludgeTokens: 12349, healthBand: 'VISIBLE_CLUTTER' },
  quota: { ...richRoadmapState.quota, cache },
  brainSignals: {
    activeSignal: { liveSessionTokens: 60000, taskMdSaved: true, taskMdTurnsBehind: 0, semanticallyPinnedTurns: 1 },
    duplicateReads: {
      fileCount: 1,
      reclaimableTokens: 3431,
      topFiles: [{ path: 'C:/Projects/ga-visualizer-v2/src/webview/horizon_panel.html', occurrences: 2, wastedTokens: 3431 }]
    },
    oldHistory: { turnCount: 43, reclaimableTokens: 8862 },
    deadErrors: { errorCount: 1, reclaimableTokens: 56, isErrorLoop: false },
    blowupSteps: [],
    userCorrections: 1
  },
  delta: { tokens: 26200, topSource: { label: 'edit_file verify_e2e_context_memory.mjs', tokens: 3400 } }
});

// Cold scenario: TTL 299s but 0% hit and 0 cache reads (the live false-warm bug)
w.renderState(makeHotfixState({ hitRatePct: 0, cacheReadTokens: 0, ttlRemainingSec: 299, isCacheCold: false }));
await new Promise(r => setTimeout(r, 30));
assert.equal(d.getElementById('prefixLockBadge').hidden, true, 'Hotfix #1: #prefixLockBadge must be hidden at 0% cache hit');
assert.equal(d.getElementById('barClutter').dataset.barState, 'cold-bloat', 'Hotfix #1: history bar must be cold-bloat (Amber) at 0% cache hit');
assert.equal(d.getElementById('cacheCompactionAdvisory').dataset.advisoryState, 'cold-compact-now', 'Hotfix #1: green DEFER_WARM banner must not show at 0% cache hit');

const paramText = d.getElementById('parameterizedCompactText').textContent;
assert.ok(!paramText.includes('in-chat user constraint(s)'), 'Hotfix #2: webview fallback template must not contain a count placeholder');
assert.ok(!paramText.includes('.../'), 'Hotfix #2: webview fallback template must not contain .../ prefixes');
assert.ok(paramText.includes('src/webview/horizon_panel.html'), 'Hotfix #2: webview fallback template must use workspace-relative paths');

const usedBigText = d.getElementById('usedBig').textContent;
const activeCardText = d.getElementById('valUseful').textContent;
const reclaimableCardText = d.getElementById('valClutter').textContent;
assert.equal(usedBigText, '112.7k', 'Hotfix #3: headline must render 112.7k');
assert.equal(
  Math.round((parseFloat(activeCardText) + parseFloat(reclaimableCardText)) * 10),
  Math.round(parseFloat(usedBigText) * 10),
  `Hotfix #3: Active (${activeCardText}) + Reclaimable (${reclaimableCardText}) must equal headline (${usedBigText}) to 0.1k`
);
assert.ok(/^12\.4k/.test(reclaimableCardText), 'Hotfix #3: Reclaimable card must stay pinned to the rounded row sum (12.4k)');

assert.equal(d.getElementById('cascadeWatermarkTag').textContent, '50k Sync', 'Hotfix #4: 50k tick label must be shortened');
assert.ok(/^\d+(\.\d)?k Safe Limit \([A-Za-z]+\)$/.test(d.getElementById('limitTag').textContent), 'Hotfix #4: safe-limit tick label must be shortened');
assert.ok(d.getElementById('cascadeWatermarkLine').title.includes('50k Cascade Sync Armed'), 'Hotfix #4: full 50k text must remain in tooltip');
assert.ok(d.getElementById('limitLine').title.includes('Attention Horizon (Safe Limit)'), 'Hotfix #4: full safe-limit text must remain in tooltip');
const hotfixCss = fs.readFileSync(htmlPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(/\.cascade-tag\s*\{[^}]*bottom:\s*-14px/.test(hotfixCss), 'Hotfix #4: 50k Sync label must be anchored below the bar track');
assert.ok(/\.limit-tag\s*\{[^}]*transform:\s*translateX\(-100%\)/.test(hotfixCss), 'Hotfix #4: Safe Limit label must be right-aligned via translateX(-100%)');

assert.equal(d.getElementById('lblClutter').textContent, 'Reclaimable', 'Hotfix #5: cold middle card must be titled Reclaimable');
assert.equal(d.getElementById('subClutter').textContent, 'Can be cleared', 'Hotfix #5: cold middle card subtitle must be "Can be cleared"');
assert.equal(d.getElementById('valClutter').dataset.historyState, 'cold-bloat', 'Hotfix #5: cold middle card must mirror the Amber bar state');
assert.equal(d.getElementById('guidedStepBox').dataset.cacheAdvisory, 'cold-compact-now', 'Hotfix #6: cold state keeps the urgent amber /compact accent');

const deltaEl = d.getElementById('deltaLine');
assert.equal(deltaEl.style.display, 'flex', 'Hotfix #7: delta row must be a flex container');
assert.equal(deltaEl.querySelector('.delta-tok')?.textContent, ' (~3.4k)', 'Hotfix #7: token suffix must render in its own non-shrinking span');
assert.equal(deltaEl.querySelector('.delta-src')?.title, 'edit_file verify_e2e_context_memory.mjs', 'Hotfix #7: full source label must remain in tooltip');
assert.ok(deltaEl.querySelector('.delta-src')?.textContent.includes('verify_e2e...memory.mjs'), 'Hotfix #7: long filenames must be middle-truncated');

const taskSyncBadge = d.getElementById('taskSyncBadge');
assert.ok(taskSyncBadge, 'Hotfix #8: #taskSyncBadge must render');
assert.ok(!taskSyncBadge.textContent.startsWith('\u2022 \u25CF'), 'Hotfix #8: #taskSyncBadge text must not start with "â€¢ â—"');
assert.ok(!d.getElementById('handoffDot').textContent.includes('\u2022'), 'Hotfix #8: no leading bullet separator may inherit the green color');
assert.equal(taskSyncBadge.textContent, '\u25CF task.md synced', 'Hotfix #8: badge must read "â— task.md synced"');

// Warm scenario: real cache reads + 95% hit
w.renderState(makeHotfixState({ hitRatePct: 95, cacheReadTokens: 107000, ttlRemainingSec: 193, isCacheCold: false }));
await new Promise(r => setTimeout(r, 30));
assert.equal(d.getElementById('prefixLockBadge').hidden, false, 'Hotfix #1: #prefixLockBadge must show on a truly warm >50k cache');
assert.equal(d.getElementById('barClutter').dataset.barState, 'cached-warm', 'Hotfix #1: truly warm cache must render cached-warm bar');
assert.equal(d.getElementById('lblClutter').textContent, 'Cached History', 'Hotfix #5: warm middle card must be titled Cached History');
assert.equal(d.getElementById('subClutter').textContent, '95% discounted \u00B7 /compact ready', 'Hotfix #5: warm middle card subtitle');
assert.equal(d.getElementById('valClutter').dataset.historyState, 'cached-warm', 'Hotfix #5: warm middle card must mirror the Teal bar state');
assert.equal(d.getElementById('cacheCompactionAdvisory').dataset.advisoryState, 'warm-defer', 'Hotfix #6: warm state shows DEFER_WARM banner');
assert.equal(d.getElementById('guidedStepBox').dataset.cacheAdvisory, 'warm-defer', 'Hotfix #6: guided box must flag warm-defer to mute amber accent');
assert.ok(/#guidedStepBox\[data-cache-advisory="warm-defer"\] \.compact-instruction\s*\{\s*border-left-color:\s*var\(--hz-border\)/.test(fs.readFileSync(htmlPath, 'utf8')), 'Hotfix #6: warm-defer must mute the /compact border to var(--hz-border)');

// Hotfix #6: Simple mode collapses the template drawer; Advanced expands it
const paramDetails = d.getElementById('parameterizedCompactDetails');
assert.ok(paramDetails && paramDetails.tagName === 'DETAILS', 'Hotfix #6: template must live in a <details> drawer');
assert.ok(paramDetails.contains(d.getElementById('parameterizedCompactText')), 'Hotfix #6: template text must be inside the drawer');
d.querySelector('[data-view-tab="advanced"]')?.click();
assert.equal(paramDetails.open, true, 'Hotfix #6: Advanced mode must expand the template');
d.querySelector('[data-view-tab="simple"]')?.click();
assert.equal(d.body.getAttribute('data-view-mode'), 'simple');
assert.equal(paramDetails.open, false, 'Hotfix #6: Simple mode must collapse the template');

// Invariants: no /compact copy button
assert.equal(d.getElementById('btnCompactPrimary'), null, 'Invariant: #btnCompactPrimary must never render');
assert.ok(!fs.readFileSync(htmlPath, 'utf8').includes('copyCompactWithGuidance'), 'Invariant: copyCompactWithGuidance must not exist');
hotfixDom.window.close();
}

console.log('  âœ“ UI Polish Hotfix 1â€“8 state, math & DOM assertions PASSED.\n');

console.log('\n================================================================================');
console.log(`  ALL 7 END-TO-END VALIDATION LAYERS PASSED (SHA-256: ${mirrorCheck.sha256.slice(0, 16)}...)`);
console.log('================================================================================');
```
