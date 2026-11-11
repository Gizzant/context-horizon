import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  classifyHorizonWindow,
  CATEGORIES
} from '../src/core/horizon_classifier.mjs';
import {
  computeQuotaAndCacheTelemetry,
  formatResetCountdown,
  resolveModelPoolDisplayName,
  hasExplicitPrefixMutation,
  OVERAGE_ALERT_MESSAGES
} from '../src/core/quota.mjs';
import { readSessionGenMetadataSync, extractTurnEffortMetadata, resolveSessionModel } from '../src/core/parser.mjs';
import { normalizeModelId, resolveModelCeiling, resolvePricePerM } from '../src/core/constants.mjs';
import { evaluateCompositeSessionRisk } from '../src/core/classifier.mjs';
import { evaluateCompactionCacheAdvisory } from '../src/core/prompt_rubric.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

console.log('--- Verifying Phase 2: Quota Telemetry, Real Cache TTL & Overage Guardrails (Layer 2) ---');

const workspacePath = 'c:/projects/my-app';
const config = {
  amputation_token_threshold: 140000,
  deprecated_paths: ['**/legacy/**', '**/deprecated/**'],
  model_pricing_per_1m_input: {
    'gemini-3.8-flash': resolvePricePerM('gemini-3.8-flash'),
    'gemini-3.1-pro': 1.25
  }
};

// 1. Duplicate view_file reads move older read to STALE_DUP
const dupSteps = [
  {
    stepIndex: 1,
    role: 'tool',
    toolName: 'view_file',
    targetPath: 'c:/projects/my-app/src/index.js',
    exitCode: 0,
    tokenEstimate: 2000
  },
  {
    stepIndex: 2,
    role: 'model',
    type: 'PLANNER_RESPONSE',
    tokenEstimate: 500
  },
  {
    stepIndex: 3,
    role: 'tool',
    toolName: 'view_file',
    targetPath: 'c:/projects/my-app/src/index.js',
    exitCode: 0,
    tokenEstimate: 2000
  }
];

const res1 = classifyHorizonWindow(dupSteps, { total_input_tokens: 4500 }, workspacePath, [], config);
assert.ok(res1.fileState.staleDupPaths.includes('c:/projects/my-app/src/index.js'), 'Older read must be in staleDupPaths');
assert.ok(res1.fileState.activeSetPaths.includes('c:/projects/my-app/src/index.js'), 'Latest read must be in activeSetPaths');
assert.ok(res1.tokenBreakdown[CATEGORIES.STALE_DUP] >= 2000, 'Stale tokens counted');
console.log('✓ Check 1: Duplicate view_file read moved to STALE_DUP.');

// 2. Failed run_command followed by passing run_command transitions to DEAD_ERROR
const errorSteps = [
  {
    stepIndex: 1,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 1,
    tokenEstimate: 3000
  },
  {
    stepIndex: 2,
    role: 'tool',
    toolName: 'run_command',
    exitCode: 0,
    tokenEstimate: 1000
  }
];

const res2 = classifyHorizonWindow(errorSteps, { total_input_tokens: 4000 }, workspacePath, [], config);
assert.ok(res2.tokenBreakdown[CATEGORIES.DEAD_ERROR] >= 3000, 'Failed command followed by pass must be DEAD_ERROR');
console.log('✓ Check 2: Resolved failed command classified as DEAD_ERROR.');

// 3. Foreign KI paths trigger MEMORY_BLEED
const foreignKIs = [
  {
    id: 'ki-foreign-1',
    projectPath: 'd:/other-workspace/repo-x',
    tokenCount: 4000
  },
  {
    id: 'ki-valid-1',
    projectPath: 'c:/projects/my-app/docs',
    tokenCount: 1500
  }
];

const res3 = classifyHorizonWindow([], { total_input_tokens: 5500 }, workspacePath, foreignKIs, config);
assert.ok(res3.fileState.foreignBleedKiIds.includes('ki-foreign-1'), 'Foreign KI must be flagged in foreignBleedKiIds');
assert.equal(res3.flags.hasForeignBleed, true, 'hasForeignBleed flag must be true');
assert.ok(res3.tokenBreakdown[CATEGORIES.MEMORY_BLEED] >= 4000, 'Memory bleed tokens counted');
assert.ok(res3.tokenBreakdown[CATEGORIES.MEMORY_KI] >= 1500, 'Valid memory tokens counted');
console.log('✓ Check 3: Foreign KI triggered MEMORY_BLEED and foreignBleedKiIds populated.');

// 4. Latency test: 200-step event list in under 10ms
const largeStepList = [];
for (let i = 0; i < 200; i++) {
  largeStepList.push({
    stepIndex: i,
    role: i % 2 === 0 ? 'user' : 'model',
    type: i % 4 === 0 ? 'TOOL_RESULT' : 'PLANNER_RESPONSE',
    toolName: i % 4 === 0 ? 'view_file' : null,
    targetPath: i % 4 === 0 ? `c:/projects/my-app/file_${i % 10}.js` : null,
    exitCode: i % 10 === 0 ? 1 : 0,
    tokenEstimate: 500
  });
}

const t0 = process.hrtime.bigint();
const res4 = classifyHorizonWindow(largeStepList, { total_input_tokens: 100000 }, workspacePath, foreignKIs, config);
const t1 = process.hrtime.bigint();
const durationMs = Number(t1 - t0) / 1_000_000;
assert.ok(durationMs < 10.0, `Classification took ${durationMs}ms which exceeds 10ms threshold`);
assert.equal(res4.cells.length, 40, 'Must produce 40 cells');
console.log(`✓ Check 4: 200-step event list classified in ${durationMs.toFixed(3)}ms.`);

// 5. Phase 2 Layer 2: Live Model Pool Status, Reset Timers & AI Credits
console.log('--- Verifying Live Model Pool Status, Reset Timers & AI Credits ---');
assert.equal(formatResetCountdown(3 * 3600 + 12 * 60), '3h 12m');
assert.equal(formatResetCountdown(4 * 86400 + 18 * 3600), '4d 18h');
assert.equal(resolveModelPoolDisplayName('gemini-4-argon'), 'Gemini 4 Argon');
assert.equal(resolveModelPoolDisplayName('claude-sonnet-5-5'), 'Claude Sonnet 5.5');
assert.equal(resolveModelPoolDisplayName('Claude Opus 5.5 (Medium)'), 'Claude Opus 5.5', 'Pool name must resolve human-readable model labels via normalizeModelId');
// (The undocumented local language_server probe was removed: quota is a local estimate unless the host supplies it.)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase2-'));
const nowMs = Date.now();
const qTelemetry = computeQuotaAndCacheTelemetry(
  [
    { stepIndex: 0, type: 'USER_INPUT', inputTokens: 2000, outputTokens: 100, createdAt: new Date(nowMs - 280000).toISOString() },
    { stepIndex: 1, type: 'PLANNER_RESPONSE', inputTokens: 2000, cacheReadTokens: 80000, outputTokens: 1200, createdAt: new Date(nowMs - 265000).toISOString() }
  ],
  {
    sessionId: 'phase2-test-1',
    modelId: 'gemini-4-argon',
    totalActiveTokens: 83200,
    stdinQuota: {
      remaining_fraction: 0.864,
      weekly_remaining_fraction: 0.0,
      reset_in_seconds: 3 * 3600 + 12 * 60,
      weekly_reset_in_seconds: 4 * 86400 + 18 * 3600,
      ai_credits: 23500,
      enable_ai_credit_overages: false
    },
    cacheDir: tmpDir,
    nowMs
  }
);

assert.equal(qTelemetry.sprint5h.poolCountdownLabel, 'Gemini 4 Argon resets in 3h 12m');
assert.equal(qTelemetry.weekly7d.poolCountdownLabel, '7d resets in 4d 18h');
assert.equal(qTelemetry.aiCredits.label, '✦ AI Credits: 23,500');
assert.equal(qTelemetry.overageAlert.state, 'LOCKOUT_ALERT');
assert.equal(qTelemetry.overageAlert.message, OVERAGE_ALERT_MESSAGES.LOCKOUT_ALERT);
assert.equal(qTelemetry.cache.ttlRemainingSec, 35, '265s elapsed out of 300s leaves 35s TTL');
assert.equal(qTelemetry.cache.ttlExpirationPulse, true, '35s remaining (<=45s) must trigger TTL expiration pulse');
console.log('✓ Check 5: Pool countdowns, AI Credits (✦ AI Credits: 23,500), Lockout Alert, and T-45s TTL Pulse verified.');

// 6. AI Credit Overage Vision Bug Alert when enable_ai_credit_overages == true
const qOveragesOn = computeQuotaAndCacheTelemetry(
  [{ stepIndex: 0, type: 'PLANNER_RESPONSE', inputTokens: 5000, cacheReadTokens: 50000, createdAt: new Date(nowMs - 20000).toISOString() }],
  {
    sessionId: 'phase2-test-2',
    modelId: 'gemini-4-argon',
    totalActiveTokens: 55000,
    stdinQuota: {
      remaining_fraction: 0.5,
      weekly_remaining_fraction: 0.0,
      ai_credits: 23500,
      enable_ai_credit_overages: true
    },
    cacheDir: tmpDir,
    nowMs
  }
);
assert.equal(qOveragesOn.overageAlert.state, 'OVERAGES_ACTIVE_VISION_WARN');
assert.equal(qOveragesOn.overageAlert.message, OVERAGE_ALERT_MESSAGES.OVERAGES_ACTIVE_VISION_WARN);
console.log('✓ Check 6: Overages Active HTTP 400 vision bug warning verified.');

// 7. Prefix Bust vs. Natural TTL Expiration (SQLite gen_metadata + Step Telemetry)
const { DatabaseSync } = await import('node:sqlite');
const bustDbPath = path.join(tmpDir, 'bust_session.db');
const bustDb = new DatabaseSync(bustDbPath);
bustDb.exec(`
  CREATE TABLE gen_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input_tokens INTEGER,
    cache_read_tokens INTEGER,
    output_tokens INTEGER,
    model TEXT,
    created_at TEXT
  );
`);
bustDb.prepare('INSERT INTO gen_metadata (input_tokens, cache_read_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(4000, 92000, 800, 'gemini-4-argon', new Date(nowMs - 90000).toISOString());
bustDb.prepare('INSERT INTO gen_metadata (input_tokens, cache_read_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(98000, 0, 950, 'gemini-4-argon', new Date(nowMs - 30000).toISOString());
bustDb.close();

const parsedGenMeta = readSessionGenMetadataSync(bustDbPath, DatabaseSync);
assert.equal(parsedGenMeta.prefixBustDetected, true, 'cache_read_tokens == 0 within 60s (<300s) of previous turn must flag prefixBustDetected');
assert.equal(parsedGenMeta.prefixBustDeltaSec, 60);

const qPrefixBust = computeQuotaAndCacheTelemetry(
  [
    { stepIndex: 0, type: 'PLANNER_RESPONSE', inputTokens: 4000, cacheReadTokens: 92000, outputTokens: 800, createdAt: new Date(nowMs - 90000).toISOString() },
    { stepIndex: 1, type: 'PLANNER_RESPONSE', inputTokens: 98000, cacheReadTokens: 0, outputTokens: 950, createdAt: new Date(nowMs - 30000).toISOString() }
  ],
  {
    sessionId: 'phase2-bust',
    totalActiveTokens: 98000,
    cacheDir: tmpDir,
    nowMs
  }
);
assert.equal(qPrefixBust.cache.prefixBustDetected, true);
assert.equal(qPrefixBust.cache.prefixBustLabel, '⚠️ Prefix Bust (system_message / config drift)');

// 7b. Uninstrumented session (cacheReadTokens == 0 across all steps, no config mutation) must NOT false-alarm Prefix Bust
const qUninstrumented = computeQuotaAndCacheTelemetry(
  [
    { stepIndex: 0, type: 'PLANNER_RESPONSE', inputTokens: 8000, cacheReadTokens: 0, outputTokens: 600, createdAt: new Date(nowMs - 90000).toISOString() },
    { stepIndex: 1, type: 'PLANNER_RESPONSE', inputTokens: 16200, cacheReadTokens: 0, outputTokens: 700, createdAt: new Date(nowMs - 30000).toISOString() }
  ],
  {
    sessionId: 'phase2-uninstrumented',
    totalActiveTokens: 16200,
    cacheDir: tmpDir,
    nowMs
  }
);
assert.equal(qUninstrumented.cache.prefixBustDetected, false, 'Uninstrumented session with 0 cacheReadTokens across all turns must NOT flag prefixBustDetected');

// 7c. Explicit <USER_SETTINGS_CHANGE> or AGENTS.md edit on turn with cacheReadTokens == 0 within <300s MUST flag Prefix Bust
const qExplicitMutation = computeQuotaAndCacheTelemetry(
  [
    { stepIndex: 0, type: 'USER_INPUT', inputTokens: 8000, cacheReadTokens: 0, outputTokens: 100, createdAt: new Date(nowMs - 90000).toISOString() },
    { stepIndex: 1, type: 'USER_INPUT', content: '<USER_SETTINGS_CHANGE>Model changed</USER_SETTINGS_CHANGE>', inputTokens: 16200, cacheReadTokens: 0, outputTokens: 200, createdAt: new Date(nowMs - 30000).toISOString() }
  ],
  {
    sessionId: 'phase2-explicit-mutation',
    totalActiveTokens: 16200,
    cacheDir: tmpDir,
    nowMs
  }
);
assert.equal(qExplicitMutation.cache.prefixBustDetected, true, 'Explicit <USER_SETTINGS_CHANGE> within 300s must flag prefixBustDetected');

// 7d. Settings-change text quoted inside tool output / planner text must NOT count as a prefix mutation.
assert.equal(
  hasExplicitPrefixMutation(
    { type: 'PLANNER_RESPONSE', content: 'viewing parser: <USER_SETTINGS_CHANGE>The user changed setting ...</USER_SETTINGS_CHANGE>' },
    { type: 'TOOL_RESULT', content: '<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>' }
  ),
  false,
  'Settings-change tags inside tool output / code views must be ignored'
);
assert.equal(hasExplicitPrefixMutation({ type: 'USER_INPUT', content: '<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>' }), true);

// 7e. Parser: dotted model versions ("5.5") parse, setting name is captured, and only USER_INPUT counts.
const switchText = '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Claude Sonnet 5.5 (Medium) to Claude Opus 5.5 (Medium). No need to comment on this change if the user doesn\'t ask about it.\n</USER_SETTINGS_CHANGE>';
const switchMeta = extractTurnEffortMetadata({ type: 'USER_INPUT', content: switchText });
assert.ok(switchMeta, 'Model Selection change with dotted versions must parse');
assert.equal(switchMeta.setting, 'Model Selection');
assert.equal(switchMeta.fromSpec, 'Claude Sonnet 5.5 (Medium)');
assert.equal(switchMeta.toSpec, 'Claude Opus 5.5 (Medium)');
assert.equal(switchMeta.modelId, 'claude-opus-5.5', 'Parser must normalize the target model to claude-opus-5.5');
assert.equal(normalizeModelId('Claude Opus 5.5 (Medium)'), 'claude-opus-5.5');
assert.equal(extractTurnEffortMetadata({ type: 'TOOL_RESULT', content: switchText }), null, 'Settings text inside tool output must be ignored by the parser');
assert.deepEqual(
  resolveSessionModel({ stdinData: {}, steps: [{ type: 'USER_INPUT', content: switchText }] }),
  { id: 'claude-opus-5.5', raw: 'Claude Opus 5.5 (Medium)', source: 'transcript' },
  'Model precedence must fall back to the last USER_INPUT Model Selection change'
);
assert.equal(resolveSessionModel({ stdinData: { model: { id: 'gemini-4-argon' } }, steps: [{ type: 'USER_INPUT', content: switchText }] }).source, 'stdin', 'stdin model must take precedence');
assert.equal(resolveSessionModel({ stdinData: {}, steps: [] }).source, 'fallback');
assert.equal(resolveModelCeiling('claude-sonnet-5.5'), 1000000, 'claude-sonnet-5.5 ceiling must be 1000000');
assert.equal(resolvePricePerM('Claude Sonnet 5.5 (Medium)'), 2.00, 'claude-sonnet-5.5 price must be 2.00/M');

// 7f. Model-switch bust: amber label naming the target model; advisory not COMPACT_NOW solely because of the bust.
const qModelSwitch = computeQuotaAndCacheTelemetry(
  [
    { stepIndex: 0, type: 'PLANNER_RESPONSE', inputTokens: 4000, cacheReadTokens: 92000, outputTokens: 800, createdAt: new Date(nowMs - 90000).toISOString() },
    { stepIndex: 1, type: 'USER_INPUT', content: switchText, inputTokens: 98000, cacheReadTokens: 0, cacheCreationTokens: 98000, outputTokens: 950, createdAt: new Date(nowMs - 30000).toISOString() }
  ],
  { sessionId: 'phase2-model-switch', totalActiveTokens: 98000, cacheDir: tmpDir, nowMs }
);
assert.equal(qModelSwitch.cache.prefixBustDetected, true);
assert.deepEqual(qModelSwitch.cache.prefixBustCause, { cause: 'model_switch', from: 'Claude Sonnet 5.5 (Medium)', to: 'Claude Opus 5.5 (Medium)' });
assert.equal(qModelSwitch.cache.prefixBustLabel, 'Last turn: cache miss (model switch \u2192 Claude Opus 5.5)');
assert.equal(qModelSwitch.cache.nextTurnLikelyWarm, true, 'A busting turn writes a fresh prefix, so the next turn is likely warm');
const switchAdvisory = evaluateCompactionCacheAdvisory({
  cacheTtlRemainingSec: qModelSwitch.cache.ttlRemainingSec,
  totalActiveTokens: 98000,
  safeHorizonTokens: 179000,
  isCacheTrulyWarm: false,
  nextTurnLikelyWarm: qModelSwitch.cache.nextTurnLikelyWarm,
  sludgeTokens: 60000
});
assert.notEqual(switchAdvisory.state, 'COMPACT_NOW', 'Advisory must not be COMPACT_NOW solely because of a prefix bust');
const gmDbPath = path.join(tmpDir, 'switch_session.db');
const gmDb = new DatabaseSync(gmDbPath);
gmDb.exec('CREATE TABLE gen_metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, input_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER, model TEXT, created_at TEXT);');
gmDb.prepare('INSERT INTO gen_metadata (input_tokens, cache_read_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, ?)').run(4000, 92000, 800, 'claude-sonnet-5.5', new Date(nowMs - 90000).toISOString());
gmDb.prepare('INSERT INTO gen_metadata (input_tokens, cache_read_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, ?)').run(98000, 0, 950, 'claude-opus-5.5', new Date(nowMs - 30000).toISOString());
gmDb.close();
const gmSwitch = readSessionGenMetadataSync(gmDbPath, DatabaseSync);
assert.deepEqual(gmSwitch.prefixBustCause, { cause: 'model_switch', from: 'claude-sonnet-5.5', to: 'claude-opus-5.5' }, 'gen_metadata model change must yield prefixBustCause');

// 7g. Estimated 7d at 100% -> no alert, no lockout, no RED. Host-sourced 7d at 100% still alerts.
const estTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase2-est-'));
const estLedger = { schemaRev: 1, sessions: { other: { updatedAtMs: nowMs - 3600000, weightedUnits: 20000000 } } };
fs.writeFileSync(path.join(estTmp, 'quota_ledger.json'), JSON.stringify(estLedger));
const qEstimate = computeQuotaAndCacheTelemetry(
  [{ stepIndex: 0, type: 'PLANNER_RESPONSE', inputTokens: 5000, cacheReadTokens: 50000, createdAt: new Date(nowMs - 20000).toISOString() }],
  { sessionId: 'phase2-estimate', totalActiveTokens: 55000, cacheDir: estTmp, nowMs }
);
assert.equal(qEstimate.weekly7d.usedPct, 100, 'Fixture must drive the local 7d estimate to 100%');
assert.equal(qEstimate.weekly7d.source, 'estimate');
assert.equal(qEstimate.sprint5h.source, 'estimate');
assert.equal(qEstimate.weekly7d.lockoutRisk, false, 'Estimated 7d must never set lockoutRisk');
assert.equal(qEstimate.overageAlert.state, 'NONE', 'Estimated 7d must never raise an overage alert');
assert.equal(qTelemetry.weekly7d.source, 'host', 'Numeric host weekly fraction must mark source host');
assert.equal(qTelemetry.overageAlert.state, 'LOCKOUT_ALERT', 'Host-sourced 7d at 100% must still alert');
const estRisk = evaluateCompositeSessionRisk({ totalActiveTokens: 55000, weekly7dUsedPct: 100, weekly7dLockoutRisk: true, weekly7dSource: 'estimate' });
assert.notEqual(estRisk.band, 'RED', 'Estimated 7d at 100% must not produce a RED band');
const hostRisk = evaluateCompositeSessionRisk({ totalActiveTokens: 55000, weekly7dUsedPct: 100, weekly7dLockoutRisk: true, weekly7dSource: 'host' });
assert.equal(hostRisk.band, 'RED', 'Host-sourced 7d at 100% must still produce RED');
try {
  fs.rmSync(estTmp, { recursive: true, force: true });
} catch (err) {
  if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
}
console.log('✓ Check 7: Prefix Bust vs. Natural TTL Expiration & Uninstrumented Session Guard verified.');

// 8. WebView JSDOM Verification of Layer 2 Quota Strip Elements
const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
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

// 8a. Render state with T-45s pulse, pool countdowns, AI credits, and 7d lockout alert (overages disabled)
w.renderState({
  sessionId: 's-layer2',
  window: { maxTokens: 256000, totalActiveTokens: 120000, safeLimit: 179000, turnCount: 25 },
  breakdown: { ANCHOR: 20000, ACTIVE_WORKING_SET: 60000, STALE_DUPLICATE: 40000 },
  metrics: { signalPurityPct: 67, sludgeTokens: 40000 },
  quota: qTelemetry,
  cells: []
});
await new Promise(r => setTimeout(r, 25));

assert.equal(d.getElementById('quotaStrip').dataset.ttlPulse, 'true', '#quotaStrip must activate ttl-pulse at T-35s');
assert.ok(d.getElementById('quotaPoolReset').textContent.includes('Gemini 4 Argon resets in 3h 12m'), 'Must render pool reset countdown');
assert.ok(d.getElementById('quotaPoolReset').textContent.includes('7d resets in 4d 18h'), 'Must render 7d reset countdown');
assert.equal(d.getElementById('quotaAiCredits').textContent, '✦ AI Credits: 23,500', 'Must render Google One AI Credits');
assert.equal(d.getElementById('quotaOverageAlert').hidden, false);
assert.equal(d.getElementById('quotaOverageAlert').textContent, OVERAGE_ALERT_MESSAGES.LOCKOUT_ALERT);

// 8b. Render state with Overages Active vision bug warning & Prefix Bust
w.renderState({
  sessionId: 's-layer2-bust',
  window: { maxTokens: 256000, totalActiveTokens: 98000, safeLimit: 179000, turnCount: 26 },
  breakdown: { ANCHOR: 20000, ACTIVE_WORKING_SET: 78000 },
  metrics: { signalPurityPct: 100, sludgeTokens: 0 },
  quota: {
    ...qOveragesOn,
    cache: qPrefixBust.cache
  },
  cells: []
});
await new Promise(r => setTimeout(r, 25));

assert.ok(d.getElementById('quotaPills').textContent.includes('⚠️ Prefix Bust (system_message / config drift)'), 'Must display Prefix Bust label instead of 0% hit');
assert.equal(d.getElementById('quotaOverageAlert').textContent, OVERAGE_ALERT_MESSAGES.OVERAGES_ACTIVE_VISION_WARN);

// 8c. Render uninstrumented session (cacheReadTokens == 0 across entire session, TTL 270s) -> must show Cache: Warm (270s TTL)
w.renderState({
  sessionId: 's-layer2-uninstrumented',
  window: { maxTokens: 256000, totalActiveTokens: 16200, safeLimit: 179000, turnCount: 10 },
  breakdown: { ANCHOR: 6000, ACTIVE_WORKING_SET: 10200 },
  metrics: { signalPurityPct: 100, sludgeTokens: 0 },
  quota: {
    ...qOveragesOn,
    cache: qUninstrumented.cache
  },
  cells: []
});
await new Promise(r => setTimeout(r, 25));
assert.ok(d.getElementById('quotaPills').textContent.includes('Cache: Warm (270s TTL)'), 'Uninstrumented session must render Cache: Warm (270s TTL) instead of 0% hit or Prefix Bust');
assert.ok(!d.getElementById('quotaPills').textContent.includes('Prefix Bust'), 'Uninstrumented session must not cry wolf with Prefix Bust');

dom.window.close();
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (err) {
  if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
}
console.log('✓ Check 8: WebView JSDOM Layer 2 rendering verified.');
console.log('✓ Phase 2 verification PASSED with 0 errors.');
