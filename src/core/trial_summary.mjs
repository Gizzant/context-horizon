/**
 * @file src/core/trial_summary.mjs
 * What the 14-day local trial saved, and the one-time "trial ended" notice for the status bar.
 *
 * - `getTrialSummary()` sums the project's savings ledger (`.claude/cache/horizon_ledger.jsonl`)
 *   between the trial's start and end. It counts everything Highbeam saved in that window, not
 *   only what Auto did, because the ledger does not split savings by feature.
 * - `getTrialEndNotice()` is called by the status bar (about every 300 ms), so it reads two tiny
 *   files, and only reads the ledger once: the numbers are cached in
 *   `~/.ctxtop/trial_end_notice.json` the first time the notice is shown.
 *
 * Reads only local files. Never touches the network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../utils/nodeIo.mjs';
import { readLedgerEntries } from '../core-isomorphic/coach/savedQuotaLedger.mjs';
import { resolveLicenseFilePath, parseJsonText } from './pro_license.mjs';

/** The notice stays in the status bar this long after it first appears, unless dismissed sooner. */
export const TRIAL_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function homeDirOf(options = {}) {
  return options.homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function noticePath(options = {}) {
  return path.join(homeDirOf(options), '.ctxtop', 'trial_end_notice.json');
}

/**
 * Reads the local trial record without verifying any signature (a trial has none).
 * Returns null when there is no trial, or when a real key has replaced it.
 * @param {object} [options]
 * @returns {{ activatedAtMs: number, expiresAtMs: number, activatedAt: string, expiresAt: string } | null}
 */
export function readTrialRecord(options = {}) {
  try {
    const raw = fs.readFileSync(resolveLicenseFilePath(options), 'utf8');
    const rec = parseJsonText(raw);
    if (!rec || rec.trial !== true || rec.licenseKey) return null;
    const activatedAtMs = Date.parse(rec.activatedAt);
    const expiresAtMs = Date.parse(rec.expiresAt);
    if (!Number.isFinite(activatedAtMs) || !Number.isFinite(expiresAtMs)) return null;
    return { activatedAtMs, expiresAtMs, activatedAt: rec.activatedAt, expiresAt: rec.expiresAt };
  } catch {
    return null;
  }
}

/**
 * @param {object} [options] `cwd` (project whose ledger is read), `ledgerPath`, `homeDir`,
 *   `licensePath`, `nowMs`
 * @returns {{
 *   state: 'none' | 'active' | 'ended',
 *   activatedAt: string | null, expiresAt: string | null, daysLeft: number,
 *   savedTokens: number, savedUSD: number, interventions: number
 * }}
 */
export function getTrialSummary(options = {}) {
  const empty = {
    state: 'none', activatedAt: null, expiresAt: null, daysLeft: 0,
    savedTokens: 0, savedUSD: 0, interventions: 0
  };
  const rec = readTrialRecord(options);
  if (!rec) return empty;
  const nowMs = Number(options.nowMs || Date.now());
  const ended = nowMs > rec.expiresAtMs;
  // A hand-edited record can end before it starts; then count the 14 days up to its end.
  const windowStartMs = rec.activatedAtMs <= rec.expiresAtMs ? rec.activatedAtMs : rec.expiresAtMs - 14 * 86400000;

  let savedTokens = 0;
  let savedUSD = 0;
  let interventions = 0;
  for (const e of readLedgerEntries({ cwd: options.cwd || process.cwd(), ledgerPath: options.ledgerPath })) {
    const ts = Number(e.timestamp);
    if (!Number.isFinite(ts) || ts < windowStartMs || ts > rec.expiresAtMs) continue;
    const t = Math.max(0, Number(e.savedTokens || 0));
    if (t <= 0) continue;
    savedTokens += t;
    savedUSD += Math.max(0, Number(e.savedUSD || 0));
    interventions += 1;
  }

  return {
    state: ended ? 'ended' : 'active',
    activatedAt: rec.activatedAt,
    expiresAt: rec.expiresAt,
    daysLeft: ended ? 0 : Math.max(0, Math.ceil((rec.expiresAtMs - nowMs) / 86400000)),
    savedTokens,
    savedUSD: Number(savedUSD.toFixed(6)),
    interventions
  };
}

function usd(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

/**
 * Plain-text lines for `ctxtop mode` / `ctxtop license status`.
 * @param {ReturnType<typeof getTrialSummary>} s
 * @returns {string[]}
 */
export function formatTrialSummaryLines(s) {
  if (!s || s.state === 'none') return [];
  const saved = `${usd(s.savedUSD)} (${s.savedTokens.toLocaleString('en-US')} tokens) across ${s.interventions} intervention${s.interventions === 1 ? '' : 's'} in this project`;
  if (s.state === 'active') {
    return [
      s.interventions > 0
        ? `  Trial so far: Highbeam saved you ${saved}.`
        : '  Trial so far: no savings recorded in this project yet.'
    ];
  }
  const lines = [`  Your trial ended ${String(s.expiresAt).slice(0, 10)}.`];
  lines.push(
    s.interventions > 0
      ? `  During it, Highbeam saved you ${saved}.`
      : '  Highbeam recorded no savings in this project during the trial. See what earlier sessions wasted: npx ctxtop audit'
  );
  lines.push('  Auto is paused and Highbeam runs COACH. Keep Auto: npx ctxtop license activate <CTXP1-KEY>   (plans: npx ctxtop tiers)');
  return lines;
}

/**
 * The status-bar notice: `{ full, short }` strings, or null when there is nothing to show.
 * Shown only after a trial has ended, for 24 hours from the first time it appears, and never
 * again once the user has run `ctxtop mode` or `ctxtop license status` (see `dismissTrialEndNotice`).
 * @param {object} [options]
 * @returns {{ full: string, short: string } | null}
 */
export function getTrialEndNotice(options = {}) {
  try {
    const rec = readTrialRecord(options);
    const nowMs = Number(options.nowMs || Date.now());
    if (!rec || nowMs <= rec.expiresAtMs) return null;

    const file = noticePath(options);
    let marker = null;
    try {
      marker = parseJsonText(fs.readFileSync(file, 'utf8'));
    } catch {
      marker = null;
    }
    // A marker from an older trial (the user reset it) does not apply to this one.
    if (marker && marker.expiresAt !== rec.expiresAt) marker = null;
    if (marker?.dismissed) return null;

    if (!marker) {
      const s = getTrialSummary(options);
      marker = {
        expiresAt: rec.expiresAt,
        firstShownAt: nowMs,
        savedUSD: s.savedUSD,
        savedTokens: s.savedTokens,
        interventions: s.interventions,
        dismissed: false
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(marker) + '\n', 'utf8');
    }
    if (nowMs - Number(marker.firstShownAt || nowMs) > TRIAL_NOTICE_WINDOW_MS) return null;

    // The bar already shows total savings (`Saved $X`), so only the widest variant repeats a figure.
    const withSavings = marker.interventions > 0 ? `: saved ${usd(marker.savedUSD)} in 14 days,` : ',';
    return {
      full: `Trial ended${withSavings} Auto paused. Keep it: ctxtop license activate`,
      short: 'Trial ended · Auto paused'
    };
  } catch {
    return null; // the status bar must never fail
  }
}

/**
 * Stops the status-bar notice. Called when the user looks at `mode` or `license status`.
 * @param {object} [options]
 */
export function dismissTrialEndNotice(options = {}) {
  try {
    const rec = readTrialRecord(options);
    if (!rec || Number(options.nowMs || Date.now()) <= rec.expiresAtMs) return;
    const file = noticePath(options);
    let marker = {};
    try {
      marker = parseJsonText(fs.readFileSync(file, 'utf8'));
    } catch {
      marker = {};
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...marker, expiresAt: rec.expiresAt, dismissed: true }) + '\n', 'utf8');
  } catch {
    // best effort
  }
}
