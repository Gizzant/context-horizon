/**
 * @file test/trial_summary.test.mjs
 * "Trial ended" status-bar notice (shown once, then quiet) and the trial results summary
 * ("Highbeam saved you $X during the trial").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { activateLocalTrial } from '../src/core/pro_license.mjs';
import {
  getTrialSummary,
  getTrialEndNotice,
  dismissTrialEndNotice,
  formatTrialSummaryLines,
  TRIAL_NOTICE_WINDOW_MS
} from '../src/core/trial_summary.mjs';
import { executeStatusLineBridge } from '../bin/ah-statusline.mjs';
import { renderStatusLine } from '../src/core-isomorphic/ui/modViews.mjs';
import { createInitialTelemetryState } from '../src/core-isomorphic/telemetry/telemetryBridge.mjs';
import { runCli } from '../bin/ctxtop.mjs';

const DAY = 86400000;

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-trial-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-trial-cwd-'));
  const start = Date.now() - 20 * DAY; // the trial began 20 days ago, so it ended 6 days ago
  activateLocalTrial({ homeDir: home, nowMs: start });
  const ledger = path.join(cwd, '.claude', 'cache', 'horizon_ledger.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const rows = [
    { timestamp: start - DAY, savedTokens: 9000, savedUSD: 9 },          // before the trial: not counted
    { timestamp: start + 2 * DAY, savedTokens: 7337, savedUSD: 0.014674 },
    { timestamp: start + 5 * DAY, savedTokens: 5885, savedUSD: 0.01177 },
    { timestamp: start + 15 * DAY, savedTokens: 4000, savedUSD: 4 }      // after it ended: not counted
  ];
  fs.writeFileSync(ledger, rows.map((r) => JSON.stringify({ sessionId: 's', category: 'ARTIFACT_OFFLOAD_4K', ...r })).join('\n') + '\n');
  return { home, cwd, ledger, start, opts: { homeDir: home, cwd }, cleanup: () => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

test('summary counts only savings recorded inside the trial window', () => {
  const sb = sandbox();
  try {
    const s = getTrialSummary(sb.opts);
    assert.equal(s.state, 'ended');
    assert.equal(s.savedTokens, 7337 + 5885);
    assert.equal(s.interventions, 2);
    assert.ok(Math.abs(s.savedUSD - (0.014674 + 0.01177)) < 1e-6);
    const text = formatTrialSummaryLines(s).join('\n');
    assert.match(text, /Highbeam saved you \$0\.03 \(13,222 tokens\) across 2 interventions/);
    assert.match(text, /license activate/);
  } finally { sb.cleanup(); }
});

test('no trial, an active trial and a real license give the right states', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-trial-none-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-trial-none-cwd-'));
  try {
    assert.equal(getTrialSummary({ homeDir: home, cwd }).state, 'none');
    assert.equal(getTrialEndNotice({ homeDir: home, cwd }), null);
    activateLocalTrial({ homeDir: home });
    const active = getTrialSummary({ homeDir: home, cwd });
    assert.equal(active.state, 'active');
    assert.equal(active.daysLeft, 14);
    assert.equal(getTrialEndNotice({ homeDir: home, cwd }), null, 'no notice while the trial runs');
    // A real key replaces the trial record, so nothing is shown.
    fs.writeFileSync(path.join(home, '.ctxtop', 'license.json'), JSON.stringify({ version: 1, licenseKey: 'CTXP1.x.y', payload: { tier: 'pro' } }));
    assert.equal(getTrialSummary({ homeDir: home, cwd }).state, 'none');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('notice: appears after the trial, caches its numbers, expires after 24 hours, can be dismissed', () => {
  const sb = sandbox();
  try {
    const n1 = getTrialEndNotice(sb.opts);
    assert.equal(n1.full, 'Trial ended: saved $0.03 in 14 days, Auto paused. Keep it: ctxtop license activate');
    assert.equal(n1.short, 'Trial ended · Auto paused');

    // Numbers come from the cache, so a later ledger change does not rewrite the notice.
    fs.appendFileSync(sb.ledger, JSON.stringify({ timestamp: sb.start + DAY, savedTokens: 99999, savedUSD: 50, category: 'X' }) + '\n');
    assert.match(getTrialEndNotice(sb.opts).full, /saved \$0\.03 in 14 days/);

    // Past the 24-hour window it goes quiet.
    assert.equal(getTrialEndNotice({ ...sb.opts, nowMs: Date.now() + TRIAL_NOTICE_WINDOW_MS + 1000 }), null);
  } finally { sb.cleanup(); }

  const sb2 = sandbox();
  try {
    assert.ok(getTrialEndNotice(sb2.opts));
    dismissTrialEndNotice(sb2.opts);
    assert.equal(getTrialEndNotice(sb2.opts), null, 'dismissed');
  } finally { sb2.cleanup(); }
});

test('a trial with no savings says "Trial ended" without a dollar figure', () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.ledger, '');
    const n = getTrialEndNotice(sb.opts);
    assert.equal(n.full, 'Trial ended, Auto paused. Keep it: ctxtop license activate');
    assert.doesNotMatch(n.full, /saved \$/);
    assert.match(formatTrialSummaryLines(getTrialSummary(sb.opts)).join('\n'), /npx ctxtop audit/);
  } finally { sb.cleanup(); }
});

test('status bar: notice is shown, fits the width, and never hides the core status', () => {
  const state = createInitialTelemetryState('s', 'claude-sonnet-5-5');
  state.contextWindow.totalInputTokens = 64000;
  const notice = { full: 'Trial ended: saved $4.12 in 14 days, Auto paused. Keep it: ctxtop license activate', short: 'Trial ended · Auto paused' };
  for (const columns of [60, 80, 110, 144, 200]) {
    const withN = renderStatusLine(state, { columns, ansi: false, trialNotice: notice });
    const without = renderStatusLine(state, { columns, ansi: false });
    assert.ok(withN.visibleLength <= columns, `fits ${columns}`);
    assert.ok(/Saved|\$/.test(withN.plainLine), 'core savings stay visible');
    if (columns >= 144) assert.match(withN.plainLine, /Trial ended/);
    if (withN.plainLine.includes('Trial ended')) {
      assert.ok(withN.plainLine.startsWith('HB '), 'bar still first');
    } else {
      assert.equal(withN.plainLine, without.plainLine, `notice dropped cleanly at ${columns}`);
    }
  }
});

test('status bar bridge: shows the notice until the user runs `license status`', async () => {
  const sb = sandbox();
  try {
    const run = () => executeStatusLineBridge(
      { session_id: 'tn-1', cwd: sb.cwd, model: { id: 'claude-sonnet-5-5' } },
      { cwd: sb.cwd, homeDir: sb.home, columns: 200, ansi: false, checkCapabilities: false }
    );
    assert.match(run().plainLine, /Trial ended: saved \$0\.03 in 14 days/);
    assert.match(run().plainLine, /Trial ended/, 'still there on the next render');

    const st = await runCli(['license', 'status'], { homeDir: sb.home, cwd: sb.cwd, licensePath: path.join(sb.home, '.ctxtop', 'license.json'), strict: true });
    assert.match(st.output, /Your trial ended/);
    assert.match(st.output, /saved you \$0\.03/);
    assert.equal(st.data.trialSummary.interventions, 2);

    assert.doesNotMatch(run().plainLine, /Trial ended/, 'gone once the user has looked');
  } finally { sb.cleanup(); }
});

test('`ctxtop mode` after the trial shows the summary instead of repeating itself', async () => {
  const sb = sandbox();
  try {
    await runCli(['mode', 'auto'], { homeDir: sb.home, cwd: sb.cwd, licensePath: path.join(sb.home, '.ctxtop', 'license.json'), strict: true });
    const res = await runCli(['mode'], { homeDir: sb.home, cwd: sb.cwd, licensePath: path.join(sb.home, '.ctxtop', 'license.json'), strict: true });
    assert.equal(res.data.effectiveMode, 'COACH');
    assert.match(res.output, /Your trial ended/);
    assert.match(res.output, /Highbeam saved you \$0\.03/);
    assert.equal((res.output.match(/Auto is paused/g) || []).length, 1, 'said once');
  } finally { sb.cleanup(); }
});

// ---- Past-waste teaser at the end of `init` -------------------------------------------------
import { formatPastWasteLine } from '../src/core/session_auditor.mjs';

test('past-waste teaser: shows dollars and tokens for real waste, stays silent otherwise', () => {
  const line = formatPastWasteLine({
    ok: true, days: 7, sessionsScanned: 10, sludgeTaxUSD: 35.86, sludgeTaxTokens: 2400000
  });
  assert.match(line, /^Last 7 days: ~\$35\.86 \(2,400,000 tokens\) across 10 sessions/);
  assert.match(line, /npx ctxtop audit/);
  assert.equal(formatPastWasteLine({ ok: true, days: 7, sessionsScanned: 3, sludgeTaxUSD: 0.1, sludgeTaxTokens: 5 }), '');
  assert.equal(formatPastWasteLine({ ok: true, days: 7, sessionsScanned: 0, sludgeTaxUSD: 9, sludgeTaxTokens: 5 }), '');
  assert.equal(formatPastWasteLine(null), '');
});
