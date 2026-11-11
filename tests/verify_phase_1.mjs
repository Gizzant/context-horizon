import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { canonicalizePath } from '../src/core/path_canonicalizer.mjs';
import { getAntigravitySurfaces } from '../src/core/paths.mjs';
import {
  SESSION_RISK_THRESHOLDS,
  PREFIX_LOCK_WARNING_TEXT,
  resolveSurfaceTag
} from '../src/core/constants.mjs';
import { evaluateCompositeSessionRisk, classifyHorizon } from '../src/core/classifier.mjs';
import { reconcileWorkspaceAndKIs, findSessionDirectory } from '../src/core/parser.mjs';
import {
  createDefaultSidecar,
  readSidecarSync,
  writeSidecarAtomicSync,
  updateSidecarPartialSync
} from '../src/core/sidecar_store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

console.log('--- Verifying Phase 1: Header Health, Composite Session Risk & Multi-Store Discovery ---');

// 1. Path canonicalization test
const uriPath = 'file:///c%3A/Projects/argon-test\\studio\\generators.py';
const winPath = 'C:\\Projects\\argon-test/studio/generators.py';
const canonical1 = canonicalizePath(uriPath);
const canonical2 = canonicalizePath(winPath);

console.log(`URI Path canonical: ${canonical1}`);
console.log(`Win Path canonical: ${canonical2}`);
assert.equal(canonical1, canonical2, 'Canonicalized paths must match!');
assert.equal(canonical1, 'c:/projects/argon-test/studio/generators.py');
console.log('✓ Check 1: Path canonicalization matches perfectly.');

// 2. 100 round-trip read/write latency test
const testDir = path.join(os.tmpdir(), `fc_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });

const testId = 'test-conversation-uuid-1234';
const initial = createDefaultSidecar(testId, 'C:\\Projects\\argon-test');
writeSidecarAtomicSync(testId, initial, testDir);

const iterations = 100;
const readDurationsMs = [];

for (let i = 0; i < iterations; i++) {
  updateSidecarPartialSync(testId, (state) => {
    state.sessionMeta.turnCount = i + 1;
    state.telemetry.totalInputTokens = (i + 1) * 500;
    return state;
  }, testDir);

  const t0 = process.hrtime.bigint();
  const readState = readSidecarSync(testId, testDir);
  const t1 = process.hrtime.bigint();

  const durationMs = Number(t1 - t0) / 1_000_000;
  readDurationsMs.push(durationMs);

  assert.equal(readState.sessionMeta.turnCount, i + 1);
  assert.equal(readState.telemetry.totalInputTokens, (i + 1) * 500);
}

const avgReadMs = readDurationsMs.reduce((a, b) => a + b, 0) / iterations;
readDurationsMs.sort((a, b) => a - b);
const p95ReadMs = readDurationsMs[Math.floor(iterations * 0.95)];

console.log(`✓ 100 Round-trips completed successfully (Avg: ${avgReadMs.toFixed(3)}ms, P95: ${p95ReadMs.toFixed(3)}ms).`);
assert.ok(avgReadMs < 2.0, `Average read latency (${avgReadMs}ms) must be under 2ms`);
assert.ok(p95ReadMs < 2.0, `P95 read latency (${p95ReadMs}ms) must be under 2ms`);

// 3. Composite Session Risk Engine (GREEN / AMBER / RED) & Prefix-Lock Protection
console.log('--- Verifying Composite Session Risk Tri-State Rules ---');

// 3a. GREEN: Total tokens < 179k AND Cache TTL > 0s AND task.md in sync (0 turns behind)
const riskGreen = evaluateCompositeSessionRisk({
  totalActiveTokens: 139900,
  safeHorizonTokens: 179000,
  cacheTtlRemainingSec: 193,
  cacheReadTokens: 135000,
  cacheHitRatePct: 97,
  taskMdTurnsBehind: 0,
  hasPendingTaskItems: false,
  weekly7dUsedPct: 42,
  weekly7dLockoutRisk: false,
  aiCreditOveragesEnabled: false
});
assert.equal(riskGreen.band, 'GREEN', 'Warm 139.9k session with synced task.md and no pending checklist items must be GREEN');
assert.equal(riskGreen.dotClass, 'dot');
assert.equal(riskGreen.prefixLockWarning, true, '>50k cached tokens with TTL > 0s must activate Prefix-Lock warning');
assert.equal(riskGreen.prefixLockTooltip, PREFIX_LOCK_WARNING_TEXT);

// 3b. AMBER Case 1: Cache TTL == 0s (cold cache window expired)
const riskAmberTtl = evaluateCompositeSessionRisk({
  totalActiveTokens: 35000,
  safeHorizonTokens: 179000,
  cacheTtlRemainingSec: 0,
  cacheReadTokens: 0,
  taskMdTurnsBehind: 0,
  hasPendingTaskItems: false
});
assert.equal(riskAmberTtl.band, 'AMBER', 'Expired Cache TTL (0s) must trigger AMBER');
assert.equal(riskAmberTtl.dotClass, 'dot warn');
assert.equal(riskAmberTtl.prefixLockWarning, false, 'Expired cache TTL (0s) must NOT trigger warm prefix-lock warning');

// 3c. AMBER Case 2: Context > 50k with pending checklist item in task.md
const riskAmberCascade = evaluateCompositeSessionRisk({
  totalActiveTokens: 62000,
  safeHorizonTokens: 179000,
  cacheTtlRemainingSec: 240,
  cacheReadTokens: 60000,
  taskMdTurnsBehind: 0,
  hasPendingTaskItems: true
});
assert.equal(riskAmberCascade.band, 'AMBER', 'Context > 50k with pending checklist item must trigger AMBER');
assert.ok(riskAmberCascade.summary.includes('Cascade sync armed'));

// 3d. AMBER Case 3: task.md is >= 1 turn stale
const riskAmberStaleTask = evaluateCompositeSessionRisk({
  totalActiveTokens: 40000,
  safeHorizonTokens: 179000,
  cacheTtlRemainingSec: 210,
  cacheReadTokens: 38000,
  taskMdTurnsBehind: 1,
  hasPendingTaskItems: false
});
assert.equal(riskAmberStaleTask.band, 'AMBER', 'task.md >= 1 turn behind must trigger AMBER');
assert.ok(riskAmberStaleTask.summary.includes('1 turn stale'));

// 3e. RED Case 1: Context >= 179k (safe horizon breached)
const riskRedHorizon = evaluateCompositeSessionRisk({
  totalActiveTokens: 182000,
  safeHorizonTokens: 179000,
  cacheTtlRemainingSec: 250,
  cacheReadTokens: 175000,
  taskMdTurnsBehind: 0,
  hasPendingTaskItems: false
});
assert.equal(riskRedHorizon.band, 'RED', 'Context >= 179k must trigger RED');
assert.equal(riskRedHorizon.dotClass, 'dot danger');

// 3f. RED Case 2: 7d lockout risk active without AI Credit overages enabled
const riskRedLockout = evaluateCompositeSessionRisk({
  totalActiveTokens: 80000,
  safeHorizonTokens: 179000,
  cacheTtlRemainingSec: 200,
  cacheReadTokens: 75000,
  taskMdTurnsBehind: 0,
  hasPendingTaskItems: false,
  weekly7dUsedPct: 100,
  weekly7dLockoutRisk: true,
  aiCreditOveragesEnabled: false
});
assert.equal(riskRedLockout.band, 'RED', '7d lockout risk without AI Credit overages must trigger RED');

// When AI Credit overages ARE enabled, 7d=100% alone does not trigger RED lockout
const riskOveragesEnabled = evaluateCompositeSessionRisk({
  totalActiveTokens: 80000,
  safeHorizonTokens: 179000,
  cacheTtlRemainingSec: 200,
  cacheReadTokens: 75000,
  taskMdTurnsBehind: 0,
  hasPendingTaskItems: false,
  weekly7dUsedPct: 100,
  weekly7dLockoutRisk: true,
  aiCreditOveragesEnabled: true
});
assert.equal(riskOveragesEnabled.band, 'GREEN', 'With AI Credit overages enabled and <179k warm synced session, risk band stays GREEN');
console.log('✓ Check 2: Composite Session Risk (GREEN / AMBER / RED) & Prefix-Lock rules verified.');

// 4. Multi-Store Discovery across [App], [IDE], and [CLI] with Read-Only SQLite gen_metadata
console.log('--- Verifying Multi-Store Discovery ([App], [IDE], [CLI]) ---');
const fakeHome = path.join(testDir, 'fake_home');
const surfaces = getAntigravitySurfaces(fakeHome, { includeMissing: true });
assert.equal(surfaces.length, 3, 'Must define all 3 Antigravity surfaces');
assert.deepEqual(surfaces.map(s => s.surfaceTag), ['[App]', '[IDE]', '[CLI]']);
assert.equal(resolveSurfaceTag('antigravity'), '[App]');
assert.equal(resolveSurfaceTag('antigravity-ide'), '[IDE]');
assert.equal(resolveSurfaceTag('antigravity-cli'), '[CLI]');

const { DatabaseSync } = await import('node:sqlite');
for (const [idx, s] of surfaces.entries()) {
  fs.mkdirSync(s.brainDir, { recursive: true });
  fs.mkdirSync(s.conversationsDir, { recursive: true });
  const sid = `sess-${s.name}-${idx}`;
  fs.mkdirSync(path.join(s.brainDir, sid), { recursive: true });

  // Create per-conversation SQLite DB with gen_metadata
  const convDb = new DatabaseSync(path.join(s.conversationsDir, `${sid}.db`));
  convDb.exec(`
    CREATE TABLE gen_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      input_tokens INTEGER,
      cache_read_tokens INTEGER,
      output_tokens INTEGER,
      model TEXT,
      created_at TEXT
    );
  `);
  convDb.prepare(
    'INSERT INTO gen_metadata (input_tokens, cache_read_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(12000 + idx * 5000, 80000 + idx * 10000, 1500, 'gemini-4-argon', new Date().toISOString());
  convDb.close();
}

const reconciled = await reconcileWorkspaceAndKIs('sess-antigravity-cli-2', fakeHome);
assert.equal(reconciled.recentSessions.length, 3, 'Must discover sessions across all 3 surface stores');
const cliSession = reconciled.recentSessions.find(s => s.sessionId === 'sess-antigravity-cli-2');
assert.ok(cliSession, 'CLI session must be present in recentSessions');
assert.equal(cliSession.surfaceTag, '[CLI]');
assert.equal(cliSession.liveTokens, 22000 + 100000, 'Must sum input_tokens + cache_read_tokens from SQLite gen_metadata');

const foundCliDir = findSessionDirectory('sess-antigravity-cli-2', fakeHome);
assert.equal(foundCliDir.surfaceTag, '[CLI]');
console.log('✓ Check 3: Multi-Store SQLite discovery & [App]/[IDE]/[CLI] surface tagging verified.');

// 5. WebView JSDOM Verification of Header Dot, Surface Prefixes, Prefix-Lock Tooltip & Dual-Target Open ↗
console.log('--- Verifying WebView JSDOM Layer 1 Interactions ---');
const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'horizon_panel.html'), 'utf8');
const openBrainCalls = [];
const toggledConversations = [];

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:62935/',
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      if (url === '/api/open-brain') {
        const body = opts.body ? JSON.parse(opts.body) : {};
        openBrainCalls.push(body);
        return {
          ok: true,
          json: async () => ({
            success: true,
            surfaceTag: '[CLI]',
            brainDir: path.join(os.homedir(), '.gemini', body.surface || 'antigravity', 'brain', String(body.conversationId || '')).replace(/\\/g, '/')
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    w.EventSource = class { addEventListener() {} close() {} };
    w.navigator.clipboard = { writeText: async () => {} };
    w.sidecar = {
      ui: {
        toggleConversation: (id) => toggledConversations.push(id)
      }
    };
  }
});

const w = dom.window;
const d = w.document;

w.renderState({
  sessionId: 'sess-cli-warm',
  storeSource: 'antigravity-cli',
  surfaceTag: '[CLI]',
  sessionTitle: 'CLI Warm Cache Session',
  window: {
    maxTokens: 256000,
    totalActiveTokens: 139900,
    safeLimit: 179000,
    reminderAt: 152150,
    turnCount: 42
  },
  breakdown: { ANCHOR: 20000, ACTIVE_WORKING_SET: 42100, STALE_DUPLICATE: 77800, DEAD_ERROR: 0 },
  metrics: { signalPurityPct: 44, sludgeTokens: 77800 },
  quota: {
    sprint5h: { usedPct: 13.6 },
    weekly7d: { usedPct: 45.0, lockoutRisk: false },
    cache: { hitRatePct: 98, cacheReadTokens: 135000, ttlRemainingSec: 193, isCacheCold: false }
  },
  brainSignals: {
    activeSignal: { liveSessionTokens: 42100, taskMdSaved: true, taskMdTurnsBehind: 0, hasPendingTaskItems: false }
  },
  recentSessions: [
    { sessionId: 'sess-cli-warm', title: 'CLI Warm Cache Session', stepCount: 42, surface: 'antigravity-cli', surfaceTag: '[CLI]', liveTokens: 139900 },
    { sessionId: 'sess-ide-2', title: 'IDE Fork Session', stepCount: 18, surface: 'antigravity-ide', surfaceTag: '[IDE]', liveTokens: 64200 },
    { sessionId: 'sess-app-3', title: 'Desktop 2.0 Session', stepCount: 95, surface: 'antigravity', surfaceTag: '[App]', liveTokens: 112000 }
  ],
  cells: []
});
await new Promise(r => setTimeout(r, 30));

// Verify GREEN status dot despite 77.8k older cached history
const dotEl = d.getElementById('statusDot');
assert.equal(dotEl.dataset.riskBand, 'GREEN', '139.9k warm cache session with synced task.md must show GREEN status dot');
assert.equal(dotEl.className, 'dot');

// Verify Prefix-Lock Protection Warning on #sessionSelect and #prefixLockBadge
const selEl = d.getElementById('sessionSelect');
assert.equal(selEl.dataset.prefixLock, 'true', '#sessionSelect must mark data-prefix-lock="true" when >50k warm cached tokens');
assert.equal(selEl.title, PREFIX_LOCK_WARNING_TEXT, '#sessionSelect tooltip must warn against model/effort changes busting warm KV cache');
assert.equal(d.getElementById('prefixLockBadge').hidden, false, '#prefixLockBadge must be visible on warm >50k cache');

// Verify Multi-Store surface tags ([CLI], [IDE], [App]) in dropdown options
const optTexts = [...selEl.querySelectorAll('option')].map(o => o.textContent);
assert.ok(optTexts.some(t => t.startsWith('[CLI]')), `Dropdown must include [CLI] prefix: ${optTexts.join(' | ')}`);
assert.ok(optTexts.some(t => t.startsWith('[IDE]')), `Dropdown must include [IDE] prefix: ${optTexts.join(' | ')}`);
assert.ok(optTexts.some(t => t.startsWith('[App]')), `Dropdown must include [App] prefix: ${optTexts.join(' | ')}`);

// Verify Dual-Target Open ↗ button: primary click vs Alt+Click
const openBtn = d.getElementById('btnOpenChat');
openBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, altKey: false }));
await new Promise(r => setTimeout(r, 20));
assert.deepEqual(toggledConversations, ['sess-cli-warm'], 'Primary click on Open ↗ must toggle conversation in IDE');

openBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, altKey: true }));
await new Promise(r => setTimeout(r, 30));
assert.equal(openBrainCalls.length, 1, 'Alt+Click on Open ↗ must POST to /api/open-brain');
assert.equal(openBrainCalls[0].conversationId, 'sess-cli-warm');
assert.equal(openBrainCalls[0].surface, 'antigravity-cli');

dom.window.close();
console.log('✓ Check 4: WebView JSDOM Layer 1 interactions passed.');

// Clean up test dir
try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch (err) {
  if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
}

console.log('✓ Phase 1 verification PASSED with 0 errors.');
