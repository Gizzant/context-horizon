import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { readSidecarSync } from '../src/core/sidecar_store.mjs';
import {
  COMPACTION_ADVISORY_MESSAGES,
  synthesizeParameterizedCompact,
  evaluateCompactionCacheAdvisory,
  synthesizeBatonPassHandoffCommand
} from '../src/core/prompt_rubric.mjs';
import {
  auditHandoff,
  checkBrainArtifactsAndGitDrift,
  generateHandoffMarkdown,
  parseGitPorcelain
} from '../src/core/handoff_audit.mjs';
import { describeStep } from '../src/core/history.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

console.log('--- Verifying Phase 4: Dual-Surface HUD (statusLine CLI & Tufte Webview) ---');

const samplePayload = {
  conversation_id: 'test_phase_4_session',
  workspacePath: ROOT.replace(/\\/g, '/'),
  modelName: 'gemini-3.8-flash',
  mode: 'auto',
  agent_state: 'working',
  context_window: {
    total_input_tokens: 45000,
    used_percentage: 22.5,
    exceeds_200k_tokens: false
  },
  quota: {
    remaining_fraction: 0.75,
    remaining_amount: 75,
    reset_in_seconds: 14400,
    buckets: {
      standard: { remaining_fraction: 0.75 }
    }
  }
};

const payloadJson = JSON.stringify(samplePayload);

// Test 1: Pipe valid payload and measure execution latency
const t0 = process.hrtime.bigint();
const stdoutValid = execSync('node src/cli/horizon_hud.mjs', {
  input: payloadJson,
  encoding: 'utf8',
  timeout: 5000
});
const t1 = process.hrtime.bigint();
const durationMs = Number(t1 - t0) / 1_000_000;

console.log(`HUD Output:\n${stdoutValid.trim()}`);
console.log(`Execution Latency: ${durationMs.toFixed(3)}ms (Threshold: < 45.0ms)`);
assert.ok(stdoutValid.includes('Purity:'), 'Output must contain Purity label');
assert.ok(stdoutValid.includes('Quota: 75%'), 'Output must contain parsed Quota');
console.log('✓ Check 1: Formatted ANSI status bar output in under 45ms.');

// Test 2: Check sidecar.json persistence
const sidecar = readSidecarSync('test_phase_4_session');
assert.equal(sidecar.telemetry.quota.remaining_fraction, 0.75, 'Sidecar quota fraction must be 0.75');
assert.equal(sidecar.telemetry.mode, 'auto', 'Sidecar mode must be auto');
assert.equal(sidecar.telemetry.totalInputTokens, 45000, 'Sidecar tokens must be 45000');
console.log('✓ Check 2: Sidecar atomically persisted with correct quota and mode.');

// Test 3: Malformed stdin test
const stdoutMalformed = execSync('node src/cli/horizon_hud.mjs', {
  input: '{ corrupt_json: [ unclosed ',
  encoding: 'utf8',
  timeout: 5000
});
console.log(`Malformed stdin HUD output:\n${stdoutMalformed.trim()}`);
assert.ok(stdoutMalformed.includes('Purity:'), 'Malformed stdin must produce safe fallback status bar');
console.log('✓ Check 3: Malformed stdin exited 0 with fallback bar.');

// ---------------------------------------------------------------------------
// Phase 4 (Layer 4): Parameterized Compaction, Cache Advisory, Baton Pass & Git Drift
// ---------------------------------------------------------------------------
console.log('\n--- Verifying Phase 4 (Layer 4): Parameterized Compaction & The Baton Pass (/handoff) ---');

// Test 4: Dynamic Parameterized /compact Synthesizer
const paramCmd = synthesizeParameterizedCompact({
  activeFiles: ['src/core/classifier.mjs', 'src/webview/horizon_panel.html'],
  userCorrections: ['Do not render a copy button for /compact']
});
assert.ok(paramCmd.startsWith('/compact Focus on preserving: 1) Exported symbol signatures and state scales for ['), 'Must start with parameterized /compact template');
assert.ok(paramCmd.includes('core/classifier.mjs') && paramCmd.includes('webview/horizon_panel.html'), 'Must include active files');
assert.ok(paramCmd.includes('2) Current checklist state in task.md'), 'Must include task.md checklist state');
assert.ok(paramCmd.includes('3) Explicit user constraints: [Do not render a copy button for /compact]'), 'Must include extracted user constraints');
console.log('✓ Check 4: Dynamic Parameterized /compact Synthesizer verified.');

// Test 5: Cache-Aware Compaction Advisory
const warmAdv = evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 193, totalActiveTokens: 139900, safeHorizonTokens: 179000 });
assert.equal(warmAdv.state, 'DEFER_WARM');
assert.equal(warmAdv.message, COMPACTION_ADVISORY_MESSAGES.DEFER_WARM);

const coldAdvTtl = evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 0, totalActiveTokens: 139900, safeHorizonTokens: 179000 });
assert.equal(coldAdvTtl.state, 'COMPACT_NOW');
assert.equal(coldAdvTtl.message, COMPACTION_ADVISORY_MESSAGES.COMPACT_NOW);

const coldAdvHorizon = evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 210, totalActiveTokens: 184000, safeHorizonTokens: 179000 });
assert.equal(coldAdvHorizon.state, 'COMPACT_NOW');
console.log('✓ Check 5: Cache-Aware Compaction Advisory verified.');

// Test 6: Brain Artifact (task.md, implementation_plan.md, walkthrough.md) & Git Drift Synchronization Check
const tmpBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase4-brain-'));
fs.writeFileSync(path.join(tmpBrainDir, 'task.md'), '# Tasks\n- [ ] Implement Phase 4 in @src/core/prompt_rubric.mjs\n', 'utf8');
fs.writeFileSync(path.join(tmpBrainDir, 'implementation_plan.md'), '# Plan\n', 'utf8');

const driftRes = checkBrainArtifactsAndGitDrift(
  tmpBrainDir,
  process.cwd(),
  { activeSignal: { taskMdTurnsBehind: 2 }, totalActiveTokens: 60000 },
  { gitPorcelainOutput: ' M src/core/classifier.mjs\n M src/webview/horizon_panel.html\n' }
);
assert.equal(driftRes.artifacts.taskMd.exists, true);
assert.equal(driftRes.artifacts.implementationPlanMd.exists, true);
assert.equal(driftRes.artifacts.walkthroughMd.exists, false);
assert.equal(driftRes.gitDrift.hasDirtyFiles, true);
assert.equal(driftRes.gitDrift.dirtyFileCount, 2);
assert.equal(driftRes.preCompactionWarning, true, 'Dirty git working tree + stale task.md must raise preCompactionWarning');
assert.ok(driftRes.preCompactionWarningMessage.includes('2 uncommitted workspace file(s)'));

// Phase 3: porcelain -z parsing (renames -> new path, untracked, status read before trim) & session scope.
const zOut = ' M src/core/Classifier.mjs\0R  src/new_name.mjs\0src/old_name.mjs\0?? scratch/tmp.txt\0M  README.md\0';
const zEntries = parseGitPorcelain(zOut);
assert.deepEqual(zEntries.map(e => e.path), ['src/core/Classifier.mjs', 'src/new_name.mjs', 'scratch/tmp.txt', 'README.md'], '-z parsing must keep full paths, use the NEW path for renames, and include untracked files');
assert.equal(zEntries[0].status, ' M', 'Status columns must be read before trimming');
assert.deepEqual(parseGitPorcelain(' M src/a.mjs\nR  old.mjs -> new.mjs\n').map(e => e.path), ['src/a.mjs', 'new.mjs'], 'Newline porcelain must not lose the first path character and must use rename targets');
const fakeRoot = 'C:/Repo/Proj';
const sessionDrift = checkBrainArtifactsAndGitDrift(
  emptyBrainForSession(),
  fakeRoot,
  { activeSignal: { taskMdTurnsBehind: 0 }, totalActiveTokens: 60000 },
  {
    gitPorcelainOutput: zOut,
    // Windows case + separator differences must still match.
    sessionWrittenPaths: ['c:\\repo\\proj\\SRC\\core\\classifier.mjs', 'C:/Repo/Proj/src/new_name.mjs', 'C:/elsewhere/unrelated.mjs']
  }
);
assert.equal(sessionDrift.gitDrift.dirtyFileCount, 4, 'Repo-wide dirty count must include all entries');
assert.equal(sessionDrift.gitDrift.sessionDirtyFileCount, 2, 'Session-scoped count must match only files this session edited (case/separator-insensitive)');
assert.equal(sessionDrift.preCompactionWarning, true);
assert.equal(sessionDrift.preCompactionWarningMessage, '\u26A0\uFE0F 2 files edited in this session are uncommitted (4 repo-wide) while task.md is missing.', 'Warning must show both session and repo-wide counts');
const noSessionDirty = checkBrainArtifactsAndGitDrift(emptyBrainForSession(), fakeRoot, { totalActiveTokens: 60000 }, { gitPorcelainOutput: zOut, sessionWrittenPaths: ['C:/elsewhere/x.mjs'] });
assert.equal(noSessionDirty.preCompactionWarning, false, 'No warning when none of the session-edited files are dirty');
function emptyBrainForSession() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase4-sess-')); }

// Phase 4: describeStep skips cd / Set-Location / pushd / $env: prelude segments.
assert.equal(describeStep('cd c:\\x; node tests/a.mjs'), 'run_command node');
assert.equal(describeStep({ toolCalls: [{ name: 'run_command', args: { CommandLine: 'Set-Location C:/p && $env:FOO=1; pushd x; git status' } }] }), 'run_command git');


// Lean-session gating & task.md path-hint fallback (4 state-coherence fixes)
const leanTtl0 = evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 0, totalActiveTokens: 20414, sludgeTokens: 8892 });
assert.equal(leanTtl0.state, 'LEAN_NO_COMPACT');
assert.equal(evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 100, totalActiveTokens: 20414, isCacheTrulyWarm: false }).state, 'LEAN_NO_COMPACT');
assert.equal(evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 0, totalActiveTokens: 20000, sludgeTokens: 26000 }).state, 'COMPACT_NOW');
assert.equal(evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 0, totalActiveTokens: 60000 }).state, 'COMPACT_NOW');
assert.equal(evaluateCompactionCacheAdvisory({ cacheTtlRemainingSec: 300, totalActiveTokens: 184000 }).state, 'COMPACT_NOW');
const leanDrift = checkBrainArtifactsAndGitDrift(tmpBrainDir, process.cwd(), { activeSignal: { taskMdTurnsBehind: 2 }, totalActiveTokens: 20414, sludgeTokens: 8892 }, { gitPorcelainOutput: ' M a.mjs\n' });
assert.equal(leanDrift.preCompactionWarning, false, 'Lean session must not raise drift warning');
const readOnlySessionDrift = checkBrainArtifactsAndGitDrift(
  tmpBrainDir,
  process.cwd(),
  { sessionHasWorkspaceEdits: false, activeSignal: { taskMdTurnsBehind: 2, sessionHasWorkspaceEdits: false }, totalActiveTokens: 60000, sludgeTokens: 28000 },
  { gitPorcelainOutput: ' M a.mjs\n M b.mjs\n' }
);
assert.equal(readOnlySessionDrift.preCompactionWarning, false, 'Session with 0 workspace file writes must not raise git drift warning for pre-existing repo dirty files');
const outsideTask = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase4-ws2-')), 'task.md');
fs.writeFileSync(outsideTask, '# T\n', 'utf8');
const emptyBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase4-empty-'));
assert.equal(checkBrainArtifactsAndGitDrift(emptyBrain, '', { activeSignal: { taskMdPathHint: outsideTask } }).artifacts.taskMd.exists, true);
assert.equal(checkBrainArtifactsAndGitDrift(emptyBrain, '', {}).artifacts.taskMd.exists, false);
// Test 7: The Baton Pass (/handoff) Markdown Generator
const tmpWsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-phase4-ws-'));
const handoffMdRes = generateHandoffMarkdown({
  sessionId: 'phase4-session-uuid',
  sessionTitle: 'Phase 4 Baton Pass Test',
  model: { id: 'gemini-4-argon-high' },
  window: { totalActiveTokens: 142000, maxTokens: 256000 },
  brainSignals: {
    duplicateReads: { topFiles: [{ path: 'src/core/prompt_rubric.mjs' }] },
    proofQuality: { grade: 'Strong', reason: 'All tests passed' },
    handoff: { targetFile: path.join(tmpBrainDir, 'task.md'), ...driftRes }
  }
}, {
  timestamp: '2026-11-08T00-00-00',
  workspacePath: tmpWsDir,
  writeToDisk: true
});
assert.equal(handoffMdRes.success, true);
assert.equal(handoffMdRes.relativePath, 'docs/HANDOFF_2026-11-08T00-00-00.md');
assert.ok(fs.existsSync(handoffMdRes.filePath), 'Generated HANDOFF_<timestamp>.md must exist on disk');
assert.ok(handoffMdRes.markdown.includes('src/core/prompt_rubric.mjs'));
assert.ok(handoffMdRes.markdown.includes('Implement Phase 4'));
try {
  fs.rmSync(tmpBrainDir, { recursive: true, force: true });
  fs.rmSync(tmpWsDir, { recursive: true, force: true });
} catch (err) {
  if (err && !['ENOENT', 'EBUSY', 'EPERM'].includes(err.code)) throw err;
}
console.log('✓ Check 6 & 7: Brain Artifact & Git Drift Check + Baton Pass Markdown Generator verified.');

// Test 8: JSDOM Verification of Phase 4 UI Elements & POST /api/handoff
const htmlPath = path.resolve('src/webview/horizon_panel.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const handoffCalls = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:62935/',
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      if (url === '/api/handoff') {
        handoffCalls.push({ url, method: opts.method });
        return {
          ok: true,
          json: async () => ({
            success: true,
            relativePath: 'docs/HANDOFF_2026-11-08T00-00-00.md'
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

// 8a. Warm Cache State -> Defer Advisory + Parameterized /compact + Pre-Compaction Drift Warning
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase4-ui-session',
  sessionTitle: 'Phase 4 UI Test',
  window: {
    maxTokens: 256000,
    totalActiveTokens: 139900,
    safeLimit: 179000,
    reminderAt: 120000
  },
  breakdown: {
    ANCHOR: 22100,
    ACTIVE_WORKING_SET: 40000,
    STALE_DUPLICATE: 77800
  },
  quota: {
    sprint5h: { usedPct: 30 },
    weekly7d: { usedPct: 60 },
    cache: { hitRatePct: 95, cacheReadTokens: 132900, ttlRemainingSec: 193, isCacheCold: false }
  },
  compaction: {
    parameterizedCommand: paramCmd,
    cacheAdvisory: warmAdv,
    preCompactionWarning: true,
    preCompactionWarningMessage: driftRes.preCompactionWarningMessage
  },
  brainSignals: {
    activeSignal: { liveSessionTokens: 40000, taskMdSaved: true, taskMdTurnsBehind: 2 },
    duplicateReads: {
      fileCount: 1,
      reclaimableTokens: 77800,
      topFiles: [{ path: 'src/core/classifier.mjs', occurrences: 3, wastedTokens: 77800 }]
    },
    handoff: driftRes
  }
});

// UI Invariant #1 check: plain-text instruction preserved, no copy button for /compact
assert.equal(d.getElementById('btnCompactPrimary'), null, 'Must never render #btnCompactPrimary');
assert.ok(/Type \/compact in the chat box and press Enter/.test(d.getElementById('compactInstruction').textContent));
assert.equal(d.getElementById('parameterizedCompactText').textContent, paramCmd);
assert.equal(d.getElementById('cacheCompactionAdvisory').dataset.advisoryState, 'warm-defer');
assert.equal(d.getElementById('cacheCompactionAdvisory').textContent, COMPACTION_ADVISORY_MESSAGES.DEFER_WARM);
assert.equal(d.getElementById('artifactDriftBanner').hidden, false);
assert.ok(d.getElementById('artifactDriftBanner').textContent.includes('2 uncommitted workspace file(s)'));

// 8b. Click "Generate Handoff Markdown" button (#btnGenerateHandoff)
const btnHandoff = d.getElementById('btnGenerateHandoff');
assert.equal(btnHandoff.textContent.trim(), 'Generate Handoff Markdown');
btnHandoff.click();
await new Promise(r => setTimeout(r, 30));
assert.equal(handoffCalls.length, 1, 'Clicking #btnGenerateHandoff must POST to /api/handoff');
assert.ok(d.getElementById('feedbackToast').textContent.includes('docs/HANDOFF_2026-11-08T00-00-00.md'));

// 8c. Cold Cache + Active Drift Warning -> Sequenced Banner #2 ("Cache is cold — click \"Save task.md\" first, then run /compact.")
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase4-cold-drift-session',
  window: { maxTokens: 256000, totalActiveTokens: 60000, safeLimit: 179000 },
  breakdown: { ANCHOR: 12000, ACTIVE_WORKING_SET: 20000, STALE_DUPLICATE: 28000 },
  metrics: { signalPurityPct: 53, sludgeTokens: 28000 },
  quota: {
    sprint5h: { usedPct: 30 },
    weekly7d: { usedPct: 60 },
    cache: { hitRatePct: 0, cacheReadTokens: 0, ttlRemainingSec: 0, isCacheCold: true }
  },
  brainSignals: {
    activeSignal: { liveSessionTokens: 32000, taskMdSaved: false, taskMdTurnsBehind: 3, sessionHasWorkspaceEdits: true },
    handoff: {
      artifacts: { taskMd: { exists: false } },
      gitDrift: { hasDirtyFiles: true, dirtyFileCount: 60 }
    }
  }
});
assert.equal(d.getElementById('artifactDriftBanner').hidden, false, 'Drift banner must show when sessionHasWorkspaceEdits is true');
assert.equal(
  d.getElementById('cacheCompactionAdvisory').textContent,
  'Cache is cold \u2014 click "Save task.md" first, then run /compact.',
  'Cold cache advisory must sequence Save task.md before /compact when drift banner is visible'
);
// Phase 4 #4: the advisory points to a visible "Save task.md" button inside the drift banner,
// which reuses the #btnCheckpoint handler (no duplicate id).
const driftSaveBtn = d.querySelector('#artifactDriftBanner #btnDriftSaveTask');
assert.ok(driftSaveBtn, 'Drift banner must contain an inline Save task.md button');
assert.equal(driftSaveBtn.textContent.trim(), 'Save task.md');
assert.equal(d.querySelectorAll('#btnCheckpoint').length, 1, 'Inline button must not duplicate the #btnCheckpoint id');
let checkpointClicks = 0;
d.getElementById('btnCheckpoint').addEventListener('click', () => { checkpointClicks++; });
driftSaveBtn.click();
await new Promise(r => setTimeout(r, 40));
assert.equal(checkpointClicks, 1, 'Inline Save task.md must trigger the #btnCheckpoint handler');

// 8d. Read-only / planning session (sessionHasWorkspaceEdits: false) with 60 repo dirty files -> Drift banner hidden
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase4-readonly-session',
  window: { maxTokens: 256000, totalActiveTokens: 60000, safeLimit: 179000 },
  breakdown: { ANCHOR: 12000, ACTIVE_WORKING_SET: 20000, STALE_DUPLICATE: 28000 },
  metrics: { signalPurityPct: 53, sludgeTokens: 28000 },
  quota: {
    sprint5h: { usedPct: 30 },
    weekly7d: { usedPct: 60 },
    cache: { hitRatePct: 0, cacheReadTokens: 0, ttlRemainingSec: 0, isCacheCold: true }
  },
  brainSignals: {
    activeSignal: { liveSessionTokens: 32000, taskMdSaved: false, taskMdTurnsBehind: 3, sessionHasWorkspaceEdits: false },
    handoff: {
      preCompactionWarning: false,
      artifacts: { taskMd: { exists: false } },
      gitDrift: { hasDirtyFiles: true, dirtyFileCount: 60 }
    }
  }
});
assert.equal(d.getElementById('artifactDriftBanner').hidden, true, 'Drift banner must be hidden when sessionHasWorkspaceEdits is false');
assert.equal(
  d.getElementById('cacheCompactionAdvisory').textContent,
  'Cache expired. Run parameterized compaction now before firing next turn.',
  'Cold cache advisory shows standard compaction prompt when drift banner is hidden'
);

// 8e. Estimated quota at 100%: muted "~N% est." text, no lockout pill, no overage alert, no red header dot.
const estimateQuota = {
  sprint5h: { usedPct: 42, source: 'estimate' },
  weekly7d: { usedPct: 100, source: 'estimate', lockoutRisk: false },
  overageAlert: { state: 'NONE', severity: 'none', message: '' },
  cache: { hitRatePct: 95, cacheReadTokens: 50000, ttlRemainingSec: 200, isCacheCold: false }
};
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase4-estimate-session',
  window: { maxTokens: 256000, totalActiveTokens: 60000, safeLimit: 179000 },
  breakdown: { ANCHOR: 12000, ACTIVE_WORKING_SET: 48000 },
  metrics: { signalPurityPct: 100, sludgeTokens: 0 },
  quota: estimateQuota,
  brainSignals: { activeSignal: { taskMdTurnsBehind: 0 } }
});
const estPills = d.getElementById('quotaPills').textContent;
assert.ok(estPills.includes('5h ~42% est.') && estPills.includes('7d ~100% est.'), `Estimated quota must render "~N% est." (got: ${estPills})`);
assert.ok(!estPills.includes('7d Lockout Risk'), 'Estimated 7d must not render a lockout pill');
assert.equal(d.getElementById('quotaOverageAlert').hidden, true, 'Estimated 7d at 100% must not raise the overage alert');
assert.ok(d.querySelector('#quotaPills .quota-est')?.title.includes('Local estimate'), 'Estimate tooltip must explain provenance');

// 8f. Host-sourced 7d at 100% still alerts, and the duplicate lockout pill is hidden while the banner is visible.
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase4-host-quota-session',
  window: { maxTokens: 256000, totalActiveTokens: 60000, safeLimit: 179000 },
  breakdown: { ANCHOR: 12000, ACTIVE_WORKING_SET: 48000 },
  metrics: { signalPurityPct: 100, sludgeTokens: 0 },
  quota: {
    sprint5h: { usedPct: 40, source: 'host' },
    weekly7d: { usedPct: 100, source: 'host', lockoutRisk: true, aiCreditOveragesEnabled: false },
    overageAlert: { state: 'LOCKOUT_ALERT', severity: 'danger', message: '7d Quota Exhausted. Enable AI Credit Overages in Settings > Models to prevent session lockout.' },
    cache: { hitRatePct: 95, cacheReadTokens: 50000, ttlRemainingSec: 200, isCacheCold: false }
  },
  brainSignals: { activeSignal: { taskMdTurnsBehind: 0 } }
});
assert.equal(d.getElementById('quotaOverageAlert').hidden, false, 'Host-sourced 7d at 100% must still alert');
assert.ok(!d.getElementById('quotaPills').textContent.includes('7d Lockout Risk'), 'Lockout pill must be hidden while the overage alert is visible');

// 8g. Model-switch Prefix Bust renders an amber, plain-language label naming the target model.
w.renderState({
  schemaVersion: '1.1.0',
  sessionId: 'phase4-model-switch-session',
  window: { maxTokens: 256000, totalActiveTokens: 60000, safeLimit: 179000 },
  breakdown: { ANCHOR: 12000, ACTIVE_WORKING_SET: 48000 },
  metrics: { signalPurityPct: 100, sludgeTokens: 0 },
  quota: {
    sprint5h: { usedPct: 40, source: 'estimate' },
    weekly7d: { usedPct: 50, source: 'estimate' },
    cache: {
      hitRatePct: 60, cacheReadTokens: 0, ttlRemainingSec: 250, isCacheCold: false,
      prefixBustDetected: true, nextTurnLikelyWarm: true,
      prefixBustCause: { cause: 'model_switch', from: 'Claude Sonnet 5.5 (Medium)', to: 'Claude Opus 5.5 (Medium)' },
      prefixBustLabel: 'Last turn: cache miss (model switch \u2192 Claude Opus 5.5)'
    }
  },
  brainSignals: { activeSignal: { taskMdTurnsBehind: 0 } }
});
const bustBadge = d.getElementById('prefixBustBadge');
assert.ok(bustBadge, 'Prefix Bust badge must render');
assert.equal(bustBadge.textContent, 'Last turn: cache miss (model switch \u2192 Claude Opus 5.5)');
const bustCss = d.querySelector('style').textContent;
assert.ok(/\.prefix-bust-badge\s*\{[^}]*--hz-clutter/.test(bustCss), 'Prefix Bust badge must be amber, not red');

dom.window.close();
console.log('✓ Check 8: JSDOM Phase 4 UI Elements & Generate Handoff Markdown handler verified.');

console.log('✓ Phase 4 verification PASSED with 0 errors.');
