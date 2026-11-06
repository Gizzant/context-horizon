import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { startServer } from '../sidecars/horizon-daemon/server.mjs';
import { runCLI as runVisualizerCLI } from '../src/cli/horizon_hud.mjs';
import { pruneSessionTranscript } from '../src/core/pruner.mjs';
import { classifyHorizon } from '../src/core/classifier.mjs';
import { parseRawJsonl, parseTranscriptIncremental } from '../src/core/parser.mjs';
import { syncAndVerifyMirrors } from '../scripts/sync_mirrors.mjs';
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
console.log('[1/6] Running Legacy JSDOM Regression Suite (test_regressions.cjs)...');
const regOut = execSync('node "C:/Users/frank/.gemini/antigravity/brain/399d4543-f9ad-435f-9668-7185ad32523b/scratch/test_regressions.cjs"', {
  encoding: 'utf8',
  timeout: 15000
});
assert.ok(regOut.includes('ALL ASSERTIONS PASSED'), 'Legacy JSDOM regression suite must pass 100%');
console.log('  ✓ Legacy JSDOM regression suite passed all assertions.\n');

// ---------------------------------------------------------------------------
// 2. JSDOM Validation of New Wave 1-4 UI Elements & Action Handlers
// ---------------------------------------------------------------------------
console.log('[2/6] Validating New Wave 1-4 WebView UI Elements & Handlers in JSDOM...');
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
    userCorrections: 0
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
assert.ok(d.getElementById('quotaPills').textContent.includes('7d Lockout Risk'), 'Quota strip must show 7d Lockout Risk badge');
assert.ok(d.getElementById('quotaForecast').textContent.includes('Next High turn: ~2.35% of 5h'), 'Quota forecast must show Next High turn burn');
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
console.log('  ✓ All new Wave 1-4 UI elements, 256K ceiling labels, and POST handlers verified in JSDOM.\n');

// ---------------------------------------------------------------------------
// 3. End-to-End Surgical Context Pruner (`pruner.mjs`) on Synthetic Session
// ---------------------------------------------------------------------------
console.log('[3/6] Testing Prefix-Safe Surgical Context Pruner & AST Folder on Multi-Turn Session...');
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
console.log(`  ✓ Surgical Pruner condensed ${execPrune.prunedSteps} steps (${beforeState.window.totalActiveTokens} -> ${afterState.window.totalActiveTokens} tok) with atomic backup.\n`);

// ---------------------------------------------------------------------------
// 4. Live HTTP Sidecar Daemon End-to-End Integration Test
// ---------------------------------------------------------------------------
console.log('[4/6] Starting Live Sidecar Daemon & Testing All HTTP / SSE Endpoints...');
const { server, port } = await startServer(0);
const baseUrl = `http://127.0.0.1:${port}`;

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
  abortCtrl.abort();
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log(`  ✓ Live Sidecar Daemon on port ${port} passed all 8 HTTP & SSE endpoint checks.\n`);

// ---------------------------------------------------------------------------
// 5. Real Active Session Transcript & Plugin Hook Validation
// ---------------------------------------------------------------------------
console.log('[5/6] Validating Real Active Conversation (33c7de94-4a9c-4407-b328-c7f836201e8c) & Lifecycle Hooks...');
const activeConvId = '33c7de94-4a9c-4407-b328-c7f836201e8c';
const cliRes = await runVisualizerCLI({
  silent: true,
  stdinData: { conversation_id: activeConvId }
});
assert.ok(cliRes && cliRes.state, 'Visualizer runCLI must return state for active conversation');
assert.equal(cliRes.state.window.maxTokens, 256000, 'Active conversation must use 256K ceiling');
assert.equal(cliRes.state.window.cellSizeTokens, 6400, 'Active conversation must use 6.4k cell size');
assert.equal(cliRes.state.activeEffortProfile.tier, 'HIGH', 'Active conversation effort tier must resolve to HIGH (Gemini 4 Argon High)');
assert.equal(cliRes.state.activeEffortProfile.safeLimit, 147000, 'Active HIGH effort safeLimit must be 147,000 on 256K window');
assert.ok(cliRes.state.effortTransitions.length >= 2, `Expected >=2 mid-session effort transitions in active chat, found ${cliRes.state.effortTransitions.length}`);

const pluginCliRes = await runPluginCLI({
  silent: true,
  stdinData: { conversation_id: activeConvId }
});
assert.equal(pluginCliRes.state.window.maxTokens, 256000, 'agy-horizon plugin runCLI must also resolve 256K ceiling');

const hookRes = await handleHook('PreInvocation', { conversationId: activeConvId });
assert.ok(typeof hookRes === 'object', 'PreInvocation hook must return valid response object');
console.log(`  ✓ Active conversation verified: ${cliRes.state.window.totalActiveTokens} / ${cliRes.state.window.maxTokens} tok | Tier: ${cliRes.state.activeEffortProfile.label} (Limit: ${cliRes.state.window.safeLimit}) | Transitions: ${cliRes.state.effortTransitions.length}.\n`);

// ---------------------------------------------------------------------------
// 6. Refresh Precomputed Session Catalog & Enforce 3-Way SHA-256 Mirror Parity
// ---------------------------------------------------------------------------
console.log('[6/6] Syncing Precomputed Session Catalog & Verifying 3-Way SHA-256 Mirror Parity...');
await syncSessionCatalog(8);
const mirrorCheck = syncAndVerifyMirrors();
assert.equal(mirrorCheck.parityOk, true, '3-Way SHA-256 parity must hold after catalog refresh');

console.log('\n================================================================================');
console.log(`  ALL 6 END-TO-END VALIDATION LAYERS PASSED (SHA-256: ${mirrorCheck.sha256.slice(0, 16)}...)`);
console.log('================================================================================');
