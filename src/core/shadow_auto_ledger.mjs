/**
 * @file src/core/shadow_auto_ledger.mjs
 * Node JSONL persistence layer for verified counterfactual "Shadow Auto" incidents
 * (`~/.ctxtop/shadow_auto_ledger.jsonl`). Never writes into `<workspace>/.claude/cache/`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  estimateShadowIncidentImpact,
  computeShadowAutoSummary,
  SHADOW_AUTO_WINDOW_MS
} from '../core-isomorphic/economics/shadowAutoModel.mjs';

const MAX_SHADOW_BYTES = 262_144;
const MAX_PRUNED_LINES = 500;
const DEDUP_WINDOW_MS = 60_000;
const recentIncidentMemory = new Map();

export function resolveShadowAutoLedgerPath(options = {}) {
  if (typeof options.shadowLedgerPath === 'string' && options.shadowLedgerPath.trim()) {
    return path.resolve(options.shadowLedgerPath.trim());
  }
  const homeDir = options.homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(homeDir, '.ctxtop', 'shadow_auto_ledger.jsonl');
}

export function computeWorkspaceShadowKey(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    return 'global';
  }
  const normalized = path.resolve(workspacePath.trim()).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

function isImplicitTestEnv() {
  return Boolean(
    process.env.NODE_ENV === 'test' ||
      process.env.NODE_TEST_CONTEXT ||
      process.execArgv?.includes('--test')
  );
}

/**
 * Reads valid Shadow Auto counterfactual entries from `~/.ctxtop/shadow_auto_ledger.jsonl`.
 *
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
export function readShadowAutoEntries(options = {}) {
  const filePath = resolveShadowAutoLedgerPath(options);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return [];
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          entries.push(parsed);
        }
      } catch {
        // Ignore corrupt line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function pruneOldEntriesIfNeeded(filePath, nowMs) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_SHADOW_BYTES) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const cutoff = nowMs - SHADOW_AUTO_WINDOW_MS;
    const kept = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const tsMs = typeof parsed.ts === 'number' ? parsed.ts : Date.parse(parsed.ts || '');
        if (Number.isFinite(tsMs) && tsMs >= cutoff) {
          kept.push(JSON.stringify(parsed));
        }
      } catch {
        // Skip invalid line
      }
    }
    const sliced = kept.slice(-MAX_PRUNED_LINES);
    fs.writeFileSync(filePath, sliced.length ? `${sliced.join('\n')}\n` : '', 'utf8');
  } catch {
    // Non-fatal compaction
  }
}

/**
 * Records a verified post-event Shadow Auto miss into `~/.ctxtop/shadow_auto_ledger.jsonl`.
 *
 * @param {object} [incident={}]
 * @param {object} [options={}]
 */
export function recordShadowAutoMiss(incident = {}, options = {}) {
  if (
    isImplicitTestEnv() &&
    !options.shadowLedgerPath &&
    !options.homeDir &&
    !options.allowTestHomeWrite
  ) {
    return { ok: false, skippedTestEnv: true, filePath: resolveShadowAutoLedgerPath(options) };
  }

  const filePath = resolveShadowAutoLedgerPath(options);
  const nowMs = Number.isFinite(Number(options.nowMs ?? incident.ts))
    ? Number(options.nowMs ?? incident.ts)
    : Date.now();
  const sessionId = String(incident.sessionId || options.sessionId || 'default');
  const workspacePath = incident.workspacePath ?? options.workspacePath ?? options.cwd ?? '';
  const workspaceKey = incident.workspaceKey || computeWorkspaceShadowKey(workspacePath);
  const detectorId = String(incident.detectorId || '');
  const category = String(incident.category || 'WARM_SWITCH_BUST');
  const turnKey = String(incident.turnKey ?? incident.turn ?? Math.floor(nowMs / DEDUP_WINDOW_MS));
  const dedupKey = `${filePath}::${sessionId}::${turnKey}::${detectorId || category}`;

  const lastMemTs = recentIncidentMemory.get(dedupKey);
  if (Number.isFinite(lastMemTs) && Math.abs(nowMs - lastMemTs) < DEDUP_WINDOW_MS) {
    return { ok: false, deduplicated: true, filePath };
  }

  if (fs.existsSync(filePath)) {
    const existing = readShadowAutoEntries(options).slice(-40);
    const tailDup = existing.some((e) => {
      const eTs = Number(e.ts || 0);
      const sameKey =
        e.sessionId === sessionId &&
        (e.detectorId || e.category) === (detectorId || category) &&
        String(e.turnKey ?? '') === turnKey;
      return sameKey && Math.abs(nowMs - eTs) < DEDUP_WINDOW_MS;
    });
    if (tailDup) {
      recentIncidentMemory.set(dedupKey, nowMs);
      return { ok: false, deduplicated: true, filePath };
    }
  }

  const impact = estimateShadowIncidentImpact(incident);
  const record = {
    v: 1,
    ts: nowMs,
    sessionId,
    workspaceKey,
    harness: String(incident.harness || options.harness || 'unknown'),
    effectiveMode: String(incident.effectiveMode || 'COACH'),
    category,
    detectorId,
    turnKey,
    wastedTokens: impact.wastedTokens,
    missedUsd: impact.missedUsd,
    wastedFrontierTurns: impact.wastedFrontierTurns,
    avoidedPrompts: impact.avoidedPrompts,
    autoSelected: Boolean(incident.autoSelected),
    detail: String(incident.detail || '').slice(0, 200)
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  recentIncidentMemory.set(dedupKey, nowMs);
  if (recentIncidentMemory.size > 500) {
    recentIncidentMemory.clear();
  }
  pruneOldEntriesIfNeeded(filePath, nowMs);

  return { ok: true, entry: record, filePath };
}

/**
 * Computes rolling 30-day Shadow Auto summary for a workspace/session.
 *
 * @param {object} [options={}]
 */
export function getShadowAutoSummary(options = {}) {
  const entries = readShadowAutoEntries(options);
  const workspacePath = options.workspacePath ?? options.cwd;
  const workspaceKey =
    options.workspaceKey ??
    (typeof workspacePath === 'string' && workspacePath.trim()
      ? computeWorkspaceShadowKey(workspacePath)
      : undefined);

  return computeShadowAutoSummary(entries, {
    nowMs: options.nowMs,
    workspaceKey,
    sessionId: options.sessionId,
    proEntitlement: options.proEntitlement
  });
}
