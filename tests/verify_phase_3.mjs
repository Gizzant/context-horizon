import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { runAllBlindspotSensors } from '../src/core/blindspot_sensors.mjs';
import {
  CORTEX_CLAMPED_CEILING_LABEL,
  WATERMARK_TOOLTIPS,
  resolveModelCeiling,
  resolveModelCeilingDetailed
} from '../src/core/constants.mjs';
import { loadCliSurfaceSettings } from '../src/core/settings.mjs';
import {
  classifyHorizon,
  computeWatermarks,
  evaluateHistoryBarState
} from '../src/core/classifier.mjs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('C:/Users/frank/AppData/Local/Temp/node_modules/jsdom');

console.log('--- Verifying Phase 3: The 6 Blind-Spot Sensors ---');

const tmpDir = path.join(os.tmpdir(), `fc_sensors_test_${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

// Setup test files
const dirtyFilePath = path.join(tmpDir, 'dirty_target.js');
fs.writeFileSync(dirtyFilePath, 'console.log("hello");\n', 'utf8');

const largeFilePath = path.join(tmpDir, 'large_file.js');
const largeLines = Array.from({ length: 750 }, (_, i) => `// Line ${i}`).join('\n');
fs.writeFileSync(largeFilePath, largeLines, 'utf8');

// Caller file importing large_file
const callerFilePath = path.join(tmpDir, 'caller.js');
fs.writeFileSync(callerFilePath, `import { something } from './large_file.js';\n`, 'utf8');

// Touch dirtyFilePath mtime 5 seconds into future
const nowSec = Date.now() / 1000;
fs.utimesSync(dirtyFilePath, nowSec + 5, nowSec + 5);

// Mock step events
const stepEvents = [
  // Turn 0: Schemas
  {
    stepIndex: 0,
    role: 'system',
    type: 'SCHEMA',
    tokenEstimate: 35000 // 17.5% schema tax
  },
  // Step 1: Read dirty target at now - 10,000ms
  {
    stepIndex: 1,
    role: 'tool',
    toolName: 'view_file',
    targetPath: dirtyFilePath,
    timestampMs: Date.now() - 10000,
    tokenEstimate: 500
  },
  // Step 2: Legacy poison read
  {
    stepIndex: 2,
    role: 'tool',
    toolName: 'view_file',
    targetPath: 'c:/projects/my-app/legacy/old_helper.js',
    timestampMs: Date.now() - 8000,
    tokenEstimate: 500
  },
  // Trailing 3 consecutive failed run_command steps
  {
    stepIndex: 3,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 100
  },
  {
    stepIndex: 4,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 100
  },
  {
    stepIndex: 5,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 100
  }
];

const mockSidecarState = {
  sessionMeta: {
    turnCount: 5,
    activeModel: 'gemini-3.8-flash',
    inPlanMode: true,
    turnsSinceLastPassingTest: 4
  },
  telemetry: {
    totalInputTokens: 50000,
    quota: {
      remaining_fraction: 0.08 // below 0.10
    }
  }
};

const mockToolLedger = {
  servers: {
    'unused-mcp': { invocationsLast15Sessions: 0 },
    'active-mcp': { invocationsLast15Sessions: 12 }
  }
};

const config = {
  quota_floor_fraction: 0.10,
  max_single_write_lines: 600,
  deprecated_paths: ['**/legacy/**'],
  consecutive_error_strike_limit: 3,
  uncheckpointed_dirty_file_limit: 4
};

// Benchmark runAllBlindspotSensors
const t0 = process.hrtime.bigint();
const results = runAllBlindspotSensors({
  stepEvents,
  sidecarState: mockSidecarState,
  workspacePath: tmpDir,
  targetFiles: [largeFilePath],
  activeSetPaths: [],
  toolUsageLedger: mockToolLedger,
  promptText: 'Please rewrite the whole component from scratch',
  config
});
const t1 = process.hrtime.bigint();
const durationMs = Number(t1 - t0) / 1_000_000;

console.log(`Results:`, JSON.stringify(results, null, 2));
console.log(`Execution time: ${durationMs.toFixed(3)}ms (Threshold: < 15.0ms)`);

// Assert Sensor 1: DIRTY_SNAP
assert.ok(results.dirtySnapshotPaths.length > 0, 'DIRTY_SNAP must flag modified file');
console.log('âœ“ Sensor 1 (DIRTY_SNAP) passed.');

// Assert Sensor 2: SCHEMA_TAX
assert.equal(results.schemaTaxPct, 17.5, 'Schema tax must equal 17.5%');
assert.ok(results.unusedMcpServers.includes('unused-mcp'), 'Unused MCP server must be flagged');
console.log('âœ“ Sensor 2 (SCHEMA_TAX) passed.');

// Assert Sensor 3: UNSEEN_CALLERS
assert.ok(results.unseenCallers.length > 0, 'Unseen callers must detect caller.js');
console.log('âœ“ Sensor 3 (UNSEEN_CALLERS) passed.');

// Assert Sensor 4: LEGACY_POISON
assert.ok(results.legacyPoisonPaths.some(p => p.includes('legacy')), 'Legacy poison path detected');
console.log('âœ“ Sensor 4 (LEGACY_POISON) passed.');

// Assert Sensor 5: QUOTA_AND_STREAM_SHIELD
assert.equal(results.quotaFloorBreached, true, 'Quota floor breached (<10%)');
assert.equal(results.planToFlashHandoffNeeded, true, 'Plan to flash handoff detected (>40k tokens in plan)');
assert.ok(results.streamCutoffRiskFiles.length > 0, '750-line file flagged for full rewrite stream cutoff risk');
console.log('âœ“ Sensor 5 (QUOTA_AND_STREAM_SHIELD) passed.');

// Assert Sensor 6: LOOP_AND_GIT_GUARD
assert.equal(results.threeStrikeLoop, true, '3-strike consecutive error loop flagged');
console.log('âœ“ Sensor 6 (LOOP_AND_GIT_GUARD) passed.');

assert.ok(durationMs < 15.0, `Sensors took ${durationMs}ms which exceeds 15ms threshold`);

// Clean up
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ---------------------------------------------------------------------------
// Phase 3 (Layer 3): Dual-Watermark Model, Dynamic Ceilings & Bar Coloring
// ---------------------------------------------------------------------------
console.log('\n--- Verifying Phase 3 (Layer 3): Dynamic Ceilings, Dual Watermarks & Bar Coloring ---');

// 7. Dynamic Context Ceilings (Claude 4.6 200k, Unpatched Gemini 4 Argon Clamped 256k, Patched CLI 512k/900k)
assert.equal(resolveModelCeiling('claude-sonnet-4-6', null, { useLegacyDefault: false }), 200000, 'Claude Sonnet 4.6 must resolve to 200,000 ceiling');
assert.equal(resolveModelCeiling('claude-opus-4-6', null, { useLegacyDefault: false }), 200000, 'Claude Opus 4.6 must resolve to 200,000 ceiling');

const argonDetails = resolveModelCeilingDetailed('gemini-4-argon-high', null, { useLegacyDefault: false });
assert.equal(argonDetails.ceilingTokens, 256000, 'Unpatched Gemini 4 Argon must resolve to 256,000 ceiling');
assert.equal(argonDetails.isClamped1MModel, true, 'Unpatched Gemini 4 Argon must flag isClamped1MModel = true');
assert.equal(argonDetails.clampedLabel, CORTEX_CLAMPED_CEILING_LABEL, 'Must expose 256k Clamped (1M Model Capped by Cortex 0x3E800)');

const tmpCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-cli-settings-'));
const cliSettings512Path = path.join(tmpCliDir, 'settings_512.json');
fs.writeFileSync(cliSettings512Path, JSON.stringify({ contextWindow: 512000 }), 'utf8');
const cliSettings512 = loadCliSurfaceSettings(cliSettings512Path);
const patched512 = resolveModelCeilingDetailed('gemini-4-argon', null, { cliSettings: cliSettings512 });
assert.equal(patched512.ceilingTokens, 512000, 'Patched CLI 512k tier must be whitelisted');
assert.equal(patched512.patchedTier, '512k');
assert.equal(patched512.isClamped1MModel, false, 'Patched 512k CLI must not be marked as 256k clamped');

const cliSettings900Path = path.join(tmpCliDir, 'settings_900.json');
fs.writeFileSync(cliSettings900Path, JSON.stringify({ maxContextTokens: '900k' }), 'utf8');
const cliSettings900 = loadCliSurfaceSettings(cliSettings900Path);
const patched900 = resolveModelCeilingDetailed('gemini-4-argon', null, { cliSettings: cliSettings900 });
assert.equal(patched900.ceilingTokens, 900000, 'Patched CLI 900k tier must be whitelisted');
assert.equal(patched900.patchedTier, '900k');
try { fs.rmSync(tmpCliDir, { recursive: true, force: true }); } catch {}
console.log('âœ“ Check 7: Dynamic Context Ceilings (200k Claude 4.6, 256k Clamped Argon, 512k/900k Patched CLI) verified.');

// 8. Dual-Watermark Model & State-Conditional Bar Coloring in Core Classifier
const wm256 = computeWatermarks(256000, 179000);
assert.equal(wm256.cascadeSync.tokens, 50000);
assert.equal(wm256.cascadeSync.label, 'Cascade Sync Armed');
assert.equal(wm256.cascadeSync.tooltip, WATERMARK_TOOLTIPS.CASCADE_SYNC_ARMED);
assert.equal(wm256.attentionHorizon.tokens, 179200);
assert.equal(wm256.attentionHorizon.label, 'Attention Horizon (Safe Limit)');
assert.equal(wm256.hardCeiling.tokens, 256000);
assert.equal(wm256.hardCeiling.source, 'cortex/utils.GetCheckpointConfig');

const warmBar = evaluateHistoryBarState({ totalActiveTokens: 139900, safeHorizonTokens: 179000, cacheTtlRemainingSec: 185 });
assert.equal(warmBar.state, 'CACHED_WARM');
assert.equal(warmBar.domState, 'cached-warm');
assert.equal(warmBar.label, 'Cached History \u2014 95% Discounted');

const coldBarTtl = evaluateHistoryBarState({ totalActiveTokens: 139900, safeHorizonTokens: 179000, cacheTtlRemainingSec: 0 });
assert.equal(coldBarTtl.state, 'COLD_BLOAT');
assert.equal(coldBarTtl.domState, 'cold-bloat');
assert.equal(coldBarTtl.label, 'Reclaimable Cold Bloat');

const coldBarOverHorizon = evaluateHistoryBarState({ totalActiveTokens: 185000, safeHorizonTokens: 179000, cacheTtlRemainingSec: 220 });
assert.equal(coldBarOverHorizon.state, 'COLD_BLOAT', 'Total context > 179k must transition segment to Reclaimable Cold Bloat even if TTL > 0s');
console.log('âœ“ Check 8: Dual-Watermark ticks and State-Conditional Bar Coloring logic verified.');

// 9. JSDOM WebView Verification of Layer 3 Watermarks, Clamped Pill & Bar Coloring
const htmlPath = path.resolve('src/webview/horizon_panel.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:62935/',
  beforeParse(w) {
    w.fetch = async () => ({ ok: true, json: async () => ({}) });
    w.EventSource = class { addEventListener() {} close() {} };
    w.navigator.clipboard = { writeText: async () => {} };
  }
});
const w = dom.window;
const d = w.document;

// 9a. Render Warm Unpatched Gemini 4 Argon Session (139.9k / 256k, 77.8k history, TTL = 193s > 0s)
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase3-warm-argon',
  sessionTitle: 'Phase 3 Warm Argon',
  model: {
    id: 'gemini-4-argon-high',
    nativeCeilingTokens: 256000,
    isClamped1MModel: true,
    clampedLabel: CORTEX_CLAMPED_CEILING_LABEL
  },
  window: {
    maxTokens: 256000,
    totalActiveTokens: 139900,
    safeLimit: 179000,
    reminderAt: 152150
  },
  breakdown: {
    ANCHOR: 22100,
    ACTIVE_WORKING_SET: 40000,
    STALE_DUPLICATE: 77800
  },
  quota: {
    sprint5h: { usedPct: 28 },
    weekly7d: { usedPct: 54 },
    cache: { hitRatePct: 95, cacheReadTokens: 132900, ttlRemainingSec: 193, isCacheCold: false }
  }
});

assert.equal(d.getElementById('usedMaxTok').textContent, '256k');
assert.equal(d.getElementById('ceilingClampPill').hidden, false, 'Clamped pill must be visible for unpatched Gemini 4 Argon');
assert.equal(d.getElementById('ceilingClampPill').textContent, '256k Clamped (1M Model Capped by Cortex 0x3E800)');
assert.equal(d.getElementById('cascadeWatermarkTag').textContent, '50k Sync', 'Tick 1 visible label must be shortened to "50k Sync"');
assert.ok(d.getElementById('cascadeWatermarkLine').title.includes('Cascade Sync Armed'), 'Tick 1 tooltip must keep the full "Cascade Sync Armed" text');
assert.equal(d.getElementById('cascadeWatermarkLine').title, WATERMARK_TOOLTIPS.CASCADE_SYNC_ARMED);
assert.ok(/^\d+(\.\d)?k Safe Limit \([A-Za-z]+\)$/.test(d.getElementById('limitTag').textContent), 'Tick 2 visible label must be shortened to "<N>k Safe Limit"');
assert.ok(d.getElementById('limitLine').title.includes('Attention Horizon (Safe Limit)'), 'Tick 2 tooltip must keep the full "Attention Horizon (Safe Limit)" text');
assert.equal(d.getElementById('hardCeilingLine').dataset.source, 'cortex/utils.GetCheckpointConfig', 'Tick 3 must reference cortex/utils.GetCheckpointConfig');
assert.equal(d.getElementById('barClutter').dataset.barState, 'cached-warm', 'Warm 139.9k session with TTL > 0s must render #barClutter as cached-warm');
assert.equal(d.getElementById('barClutter').dataset.barLabel, 'Cached History \u2014 95% Discounted');
assert.ok(d.getElementById('barClutter').classList.contains('cached-warm'));

// 9b. Transition to Cold Bloat when TTL == 0s
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase3-cold-claude',
  sessionTitle: 'Phase 3 Cold Claude',
  model: {
    id: 'claude-sonnet-4-6',
    nativeCeilingTokens: 200000,
    isClamped1MModel: false
  },
  window: {
    maxTokens: 200000,
    totalActiveTokens: 139900,
    safeLimit: 140000,
    reminderAt: 119000
  },
  breakdown: {
    ANCHOR: 22100,
    ACTIVE_WORKING_SET: 40000,
    STALE_DUPLICATE: 77800
  },
  quota: {
    sprint5h: { usedPct: 28 },
    weekly7d: { usedPct: 54 },
    cache: { hitRatePct: 0, ttlRemainingSec: 0, isCacheCold: true }
  }
});

assert.equal(d.getElementById('usedMaxTok').textContent, '200k', 'Claude Sonnet 4.6 must render 200k ceiling');
assert.equal(d.getElementById('ceilingClampPill').hidden, true, 'Claude Sonnet 4.6 must not show 256k Argon clamp pill');
assert.equal(d.getElementById('barClutter').dataset.barState, 'cold-bloat', 'TTL == 0s must transition #barClutter to cold-bloat');
assert.equal(d.getElementById('barClutter').dataset.barLabel, 'Reclaimable Cold Bloat');
assert.ok(d.getElementById('barClutter').classList.contains('cold-bloat'));

dom.window.close();
console.log('âœ“ Check 9: JSDOM Layer 3 Watermarks, Clamped Pill, and State-Conditional Bar Coloring verified.');

console.log('âœ“ Phase 3 verification PASSED with 0 errors.');
