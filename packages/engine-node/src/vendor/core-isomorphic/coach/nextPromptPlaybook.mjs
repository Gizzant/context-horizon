/**
 * @file src/core-isomorphic/coach/nextPromptPlaybook.mjs
 * Pure zero-I/O 3-Category Next-Prompt Playbook (<0.5ms) using verified
 * `MODEL_EFFORT_CACHE_CAPABILITIES` and rate-card round-trip TTL guards.
 */

import { getEffortMutationCacheCapability, evaluatePreModelSwitch } from './cacheGravityRouter.mjs';

export const PLAYBOOK_REGIMES = Object.freeze({
  WARM_EFFORT_SAFE: 'WARM_EFFORT_SAFE',
  COLD_BOUNDARY: 'COLD_BOUNDARY',
  NEAR_CLIFF: 'NEAR_CLIFF',
  WARM_EFFORT_UNSAFE: 'WARM_EFFORT_UNSAFE',
  WARM_EFFORT_UNVERIFIED: 'WARM_EFFORT_UNVERIFIED'
});

const fmtK = (t) => {
  const n = Math.max(0, Number(t) || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${Math.round(n)}`;
};
const isGemini = (m = '') => /gemini|neon|argon|hydrogen|carbon|flash|orchestrator/i.test(String(m));
const is46 = (m = '') => /[-_.]4[-_.]6\b/i.test(String(m));
const normHost = (h = '', m = '') => {
  const s = String(h || '').toLowerCase();
  if (s.includes('claude')) return 'claude';
  if (s.includes('antigravity') || s.includes('agy') || s.includes('vscode')) return 'antigravity';
  return /claude|sonnet|opus|haiku|fable/i.test(String(m)) ? 'claude' : 'antigravity';
};
const mkRow = (c, l, a, cp, m, t = 'do') => ({ category: c, label: l, action: a, copyCommand: cp, mechanism: m, tone: t });
const LABELS = Object.freeze([
  ['quick', 'Quick / Routine'],
  ['standard', 'Standard Code / Debug'],
  ['deep', 'Deep / Complex']
]);
const mkRows = (specs) => specs.map(([a, cp, m, t], i) => mkRow(LABELS[i][0], LABELS[i][1], a, cp, m, t));

export function computeNextPromptPlaybook(state = {}, options = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const cObj = s.quota?.cache || s.cache || {};
  const wObj = s.window || {};
  const modelId = String(s.modelId ?? s.model?.canonicalId ?? s.model?.id ?? s.activeModel ?? 'unknown');
  const effort = s.effort ?? s.activeEffortProfile?.shortLabel ?? 'Auto';
  const cachedTokens = Math.max(0, Number(s.cachedTokens ?? cObj.cacheReadTokens ?? wObj.cachedTokens ?? 0) || 0);
  const totalTokens = Math.max(0, Number(s.totalTokens ?? wObj.totalActiveTokens ?? s.totalInputTokens ?? cachedTokens) || 0);
  const safeLimit = Math.max(0, Number(s.safeLimit ?? wObj.safeLimit ?? 0) || 0);
  const ttlTier = (s.ttlTier ?? s.cacheTtlTier ?? cObj.cacheTtlTier) === '1h' ? '1h' : '5m';
  const rawTtl = s.ttlRemainingSec ?? cObj.ttlRemainingSec;
  const ttlRemainingSec = rawTtl !== undefined && rawTtl !== null && Number.isFinite(Number(rawTtl)) ? Number(rawTtl) : null;
  const rawIdle = s.idleSeconds ?? cObj.idleSeconds;
  const idleSeconds = rawIdle !== undefined && rawIdle !== null && Number.isFinite(Number(rawIdle)) ? Number(rawIdle) : null;
  const isCrisis = Boolean(s.isCrisis ?? wObj.isCrisis ?? (safeLimit > 0 && totalTokens >= safeLimit));
  const host = normHost(s.host ?? s.surface, modelId);
  const isCC = host === 'claude';

  const cap = getEffortMutationCacheCapability(modelId, options);
  const effortCacheStatus = cap.invalidatesCache === 'no' ? 'safe' : cap.invalidatesCache === 'yes' ? 'unsafe' : 'unverified';
  const gem = isGemini(modelId);
  const isNearCliff = Boolean(isCrisis || totalTokens >= (gem ? 220_000 : 160_000) || (safeLimit > 0 && totalTokens >= safeLimit * 0.9));
  const expWarm = s.cacheWarm ?? (cObj.isCacheCold !== undefined ? !cObj.isCacheCold : undefined);
  const cacheWarm = Boolean(
    (expWarm !== undefined ? expWarm : cachedTokens >= 2_000) &&
      cachedTokens >= 2_000 &&
      (ttlRemainingSec === null || ttlRemainingSec > 0) &&
      (idleSeconds === null || idleSeconds < (ttlTier === '1h' ? 3600 : 300))
  );

  const warmK = fmtK(cachedTokens);
  let regime;
  let badge;
  let headline;
  let rows;
  let optionalDetourNote = null;

  if (isNearCliff) {
    regime = PLAYBOOK_REGIMES.NEAR_CLIFF;
    badge = 'NEAR CLIFF';
    headline = `Compact first (${fmtK(totalTokens)} active) before right-sizing next turn`;
    rows = mkRows([
      [isCC ? '/compact → Haiku + /effort low' : 'Run /compact → Flash · Effort: Low', isCC ? '/compact' : null, `avoids ${gem ? '272k' : '200k'} 2x cliff`, 'danger'],
      [isCC ? '/compact → Sonnet + /effort medium' : 'Run /compact → Standard · Effort: Medium', isCC ? '/compact' : null, 'clears stale clutter with StateBaton', 'danger'],
      [isCC ? '/compact → Opus + /effort high' : 'Run /compact → Frontier · Effort: High', isCC ? '/compact' : null, 'preserves rules; removes noise', 'danger']
    ]);
  } else if (!cacheWarm) {
    regime = PLAYBOOK_REGIMES.COLD_BOUNDARY;
    badge = 'COLD BOUNDARY';
    headline = 'Cache cold or expired — switching models or effort adds 0 bust penalty';
    rows = mkRows([
      [isCC ? '/model haiku then /effort low' : 'Model: Flash · Effort: Low', isCC ? '/effort low' : null, '0 warm prefix to bust', 'do'],
      [isCC ? '/model sonnet then /effort medium' : 'Model: Standard · Effort: Medium', isCC ? '/effort medium' : null, '0 warm prefix to bust', 'do'],
      [isCC ? '/model opus then /effort high' : 'Model: Frontier · Effort: High', isCC ? '/effort high' : null, 'fresh prefix · full reasoning', 'do']
    ]);
  } else if (effortCacheStatus === 'safe') {
    regime = PLAYBOOK_REGIMES.WARM_EFFORT_SAFE;
    badge = 'WARM · EFFORT SAFE';
    headline = `Warm ${warmK} cache (${ttlTier}) — 5.5 keeps prefix across /effort changes`;
    rows = mkRows([
      [isCC ? 'Stay on model + /effort low' : 'Stay on model · Effort: Low', isCC ? '/effort low' : null, `keeps ${warmK} warm cache · effort-safe 5.5`, 'do'],
      [isCC ? 'Stay on model + /effort medium' : 'Stay on model · Effort: Medium', isCC ? '/effort medium' : null, `keeps ${warmK} warm cache · 12/12 test parity`, 'do'],
      [isCC ? 'Stay on model + /effort high' : 'Stay on model · Effort: High', isCC ? '/effort high' : null, `keeps ${warmK} warm cache · full reasoning`, 'do']
    ]);
    if (ttlTier === '1h' && !is46(modelId)) {
      const ck = evaluatePreModelSwitch({ currentModel: modelId, targetModel: 'claude-haiku-5-5', cachedTokens, expectedOutputTokens: 600, expectedRemainingTurns: 1, cacheWarm: true, cacheTtlTier: '1h', isRoundTripDetour: true }, options);
      if (ck.breakEven && !ck.breakEven.unknownModel && !ck.breakEven.shouldHold) {
        optionalDetourNote = `Optional (1h TTL only): Haiku 5.5 / low for trivial Quick turns leaves ${warmK} parent cache sleeping; 1h window absorbs return risk.`;
      }
    }
  } else if (effortCacheStatus === 'unsafe') {
    regime = PLAYBOOK_REGIMES.WARM_EFFORT_UNSAFE;
    badge = 'WARM · 4.6 LOCKED';
    headline = `Warm ${warmK} cache on ${cap.modelId} — effort change invalidates whole prefix`;
    rows = mkRows([
      ['Hold model & effort (scope prompt tighter)', null, `effort change busts ${warmK} warm cache [EF1_46]`, 'avoid'],
      ['Hold model & effort', null, `preserves ${warmK} warm cache [EF1_46]`, 'avoid'],
      ['Hold model & effort (wait for TTL/compact)', null, `avoids rebuilding ${warmK} prefix [EF1_46]`, 'avoid']
    ]);
  } else {
    regime = PLAYBOOK_REGIMES.WARM_EFFORT_UNVERIFIED;
    badge = 'WARM · UNVERIFIED';
    headline = `Warm ${warmK} cache — effort cache impact is unverified for ${modelId}`;
    rows = mkRows([
      ['Hold while warm (unverified)', null, 'effort cache impact unverified for this model', 'avoid'],
      ['Hold while warm (unverified)', null, 'effort cache impact unverified for this model', 'avoid'],
      ['Hold while warm (unverified)', null, 'effort cache unverified — wait for cold boundary or /compact', 'avoid']
    ]);
  }

  return { regime, badge, host, modelId, effort, effortCacheStatus, ttlTier, cachedTokens, totalTokens, isNearCliff, cacheWarm, headline, rows, optionalDetourNote };
}

export function formatNextPromptPlaybookCli(pb) {
  if (!pb || !Array.isArray(pb.rows)) return '';
  const out = [`  Playbook      : [${pb.badge}] ${pb.headline}`];
  for (const r of pb.rows) out.push(`    - ${r.label.padEnd(21)}: ${r.action} (${r.mechanism})`);
  if (pb.optionalDetourNote) out.push(`    * ${pb.optionalDetourNote}`);
  return out.join('\n');
}
