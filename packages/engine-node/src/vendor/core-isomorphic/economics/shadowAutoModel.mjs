/**
 * @file src/core-isomorphic/economics/shadowAutoModel.mjs
 * Pure isomorphic Counterfactual "Shadow Auto" economics rollup & Reverse-ROI copy guard.
 * Zero `node:*` imports and zero upward imports from `src/core/**`.
 */

export const PRO_ANNUAL_MONTHLY_EQUIV_USD = 12.42;
export const HIGH_IMPACT_INCIDENT_USD = 0.50;
export const FRONTIER_QUOTA_TURN_TOKENS = 45000;
export const SHADOW_AUTO_WINDOW_MS = 30 * 86400 * 1000;

export const SHADOW_AUTO_CATEGORIES = Object.freeze({
  WARM_SWITCH_BUST: 'WARM_SWITCH_BUST',
  PREFIX_MUTATION_BUST: 'PREFIX_MUTATION_BUST',
  COLD_SWARM_WAKEUP: 'COLD_SWARM_WAKEUP',
  RUNAWAY_LOOP_TURN: 'RUNAWAY_LOOP_TURN'
});

/**
 * Normalizes and derives token, dollar, frontier-turn, and prompt-interruption impact
 * for a verified post-event Shadow Auto counterfactual miss.
 *
 * @param {object} [raw={}]
 * @returns {{ wastedTokens: number, missedUsd: number, wastedFrontierTurns: number, avoidedPrompts: number }}
 */
export function estimateShadowIncidentImpact(raw = {}) {
  const wastedTokens = Math.max(0, Math.round(Number(raw.wastedTokens || 0) || 0));

  const hasExplicitUsd =
    raw.missedUsd !== undefined &&
    raw.missedUsd !== null &&
    Number.isFinite(Number(raw.missedUsd)) &&
    Number(raw.missedUsd) >= 0;
  const missedUsd = hasExplicitUsd
    ? Number(Number(raw.missedUsd).toFixed(4))
    : Number((wastedTokens * 0.00001125).toFixed(4));

  const hasExplicitTurns =
    raw.wastedFrontierTurns !== undefined &&
    raw.wastedFrontierTurns !== null &&
    Number.isFinite(Number(raw.wastedFrontierTurns)) &&
    Number(raw.wastedFrontierTurns) > 0;
  const wastedFrontierTurns = hasExplicitTurns
    ? Number(Number(raw.wastedFrontierTurns).toFixed(1))
    : wastedTokens > 0
      ? Math.max(0.2, Number((wastedTokens / FRONTIER_QUOTA_TURN_TOKENS).toFixed(1)))
      : 0.5;

  const hasExplicitPrompts =
    raw.avoidedPrompts !== undefined &&
    raw.avoidedPrompts !== null &&
    Number.isFinite(Number(raw.avoidedPrompts));
  const avoidedPrompts = hasExplicitPrompts
    ? Math.max(0, Math.round(Number(raw.avoidedPrompts)))
    : 1;

  return {
    wastedTokens,
    missedUsd,
    wastedFrontierTurns,
    avoidedPrompts
  };
}

function parseEntryTimestampMs(entry, fallbackMs) {
  const rawTs = entry?.ts ?? entry?.timestamp;
  if (typeof rawTs === 'number' && Number.isFinite(rawTs)) return rawTs;
  if (typeof rawTs === 'string' && rawTs.trim()) {
    const parsed = Date.parse(rawTs);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

/**
 * Summarizes rolling 30-day counterfactual incidents and applies the Reverse-ROI Guard
 * so free/expired-trial users never see small dollar figures contrasted against Pro pricing.
 *
 * @param {Array<object>} [entries=[]]
 * @param {object} [options={}]
 */
export function computeShadowAutoSummary(entries = [], options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const cutoffMs = nowMs - SHADOW_AUTO_WINDOW_MS;
  const workspaceKeyFilter =
    typeof options.workspaceKey === 'string' && options.workspaceKey.trim()
      ? options.workspaceKey.trim()
      : null;
  const sessionIdFilter =
    typeof options.sessionId === 'string' && options.sessionId.trim()
      ? options.sessionId.trim()
      : null;

  let incidentCount30d = 0;
  let sessionIncidentCount = 0;
  let wastedTokens30d = 0;
  let wastedFrontierTurnsSum = 0;
  let missedUsdSum = 0;
  let avoidedPrompts30d = 0;
  let maxSingleIncidentUsd = 0;
  const byCategory = {};
  const recentCandidates = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const tsMs = parseEntryTimestampMs(entry, nowMs);
    if (tsMs < cutoffMs || tsMs > nowMs + 60000) continue;
    if (workspaceKeyFilter && entry.workspaceKey !== workspaceKeyFilter) continue;

    const impact = estimateShadowIncidentImpact(entry);
    const cat = String(entry.category || SHADOW_AUTO_CATEGORIES.WARM_SWITCH_BUST);

    if (!sessionIdFilter || entry.sessionId === sessionIdFilter) {
      recentCandidates.push({
        ts: tsMs,
        category: cat,
        detectorId: String(entry.detectorId || ''),
        detail: String(entry.detail || '').slice(0, 160),
        missedUsd: Number(impact.missedUsd.toFixed(4)),
        wastedTokens: impact.wastedTokens,
        autoSelected: Boolean(entry.autoSelected)
      });
    }

    incidentCount30d += 1;
    if (sessionIdFilter && entry.sessionId === sessionIdFilter) {
      sessionIncidentCount += 1;
    }
    wastedTokens30d += impact.wastedTokens;
    wastedFrontierTurnsSum += impact.wastedFrontierTurns;
    missedUsdSum += impact.missedUsd;
    avoidedPrompts30d += impact.avoidedPrompts;
    if (impact.missedUsd > maxSingleIncidentUsd) {
      maxSingleIncidentUsd = impact.missedUsd;
    }

    if (!byCategory[cat]) {
      byCategory[cat] = { count: 0, wastedTokens: 0, missedUsd: 0, wastedFrontierTurns: 0 };
    }
    byCategory[cat].count += 1;
    byCategory[cat].wastedTokens += impact.wastedTokens;
    byCategory[cat].missedUsd = Number((byCategory[cat].missedUsd + impact.missedUsd).toFixed(4));
    byCategory[cat].wastedFrontierTurns = Number(
      (byCategory[cat].wastedFrontierTurns + impact.wastedFrontierTurns).toFixed(1)
    );
  }

  const missedUsd30d = Number(missedUsdSum.toFixed(4));
  const wastedFrontierTurns30d = Number(wastedFrontierTurnsSum.toFixed(1));
  maxSingleIncidentUsd = Number(maxSingleIncidentUsd.toFixed(4));

  const exceedsBreakEvenThreshold =
    missedUsd30d >= PRO_ANNUAL_MONTHLY_EQUIV_USD ||
    maxSingleIncidentUsd >= HIGH_IMPACT_INCIDENT_USD;

  const proEntitlement = options.proEntitlement || null;
  const isEntitled = Boolean(proEntitlement?.entitled);
  const trialExpired = Boolean(proEntitlement?.trialExpired);

  let displayMode = 'shadow_quiet';
  let headlineText = '';
  let sublineText = '';
  let ctaMode = 'none';
  let ctaLabel = null;

  if (isEntitled) {
    if (proEntitlement?.tier === 'trial') {
      const daysLeft = Math.max(1, Number(proEntitlement.daysRemaining || 14));
      displayMode = 'reverse_trial_active';
      headlineText = `Auto trial active (${daysLeft}d left)`;
      sublineText =
        'Hands-free cache and loop protection is active during your 14-day local trial.';
    } else {
      displayMode = 'entitled_pro';
      headlineText = 'Auto hands-free protection active';
      sublineText = 'All automatic cache holds and loop guards are unlocked.';
    }
  } else {
    ctaMode = trialExpired ? 'upgrade_pro' : 'start_trial';
    ctaLabel =
      ctaMode === 'start_trial'
        ? 'Start 14-day free Auto trial'
        : 'Unlock Highbeam Pro ($149/yr \u00B7 $15/mo)';

    if (incidentCount30d === 0) {
      displayMode = 'shadow_quiet';
      headlineText = trialExpired
        ? '14-day Auto trial ended \u2014 Auto is in preview'
        : 'Auto is previewing \u2014 start a 14-day trial to apply it';
      sublineText = trialExpired
        ? 'Auto keeps showing what it would fix. Unlock Highbeam Pro to apply cache holds and loop guards.'
        : 'Start a 14-day local trial to let Highbeam hold warm caches and stop runaway loops automatically.';
    } else if (exceedsBreakEvenThreshold) {
      displayMode = 'shadow_roi_proven';
      headlineText =
        missedUsd30d >= PRO_ANNUAL_MONTHLY_EQUIV_USD
          ? `Auto would have prevented $${missedUsd30d.toFixed(2)} in wasted cache rewrites & loops (30d)`
          : `Auto would have blocked a $${maxSingleIncidentUsd.toFixed(2)} cold rewrite ($${missedUsd30d.toFixed(2)} missed over 30d)`;
      const turnLabel = Math.max(1, Math.round(wastedFrontierTurns30d));
      sublineText = `~${turnLabel} frontier quota turns \u00B7 ${avoidedPrompts30d} manual prompts \u00B7 Pro is $12.42/mo annual`;
    } else {
      displayMode = 'shadow_incidents_only';
      const incidentNoun = incidentCount30d === 1 ? 'incident' : 'incidents';
      headlineText = `Auto would have handled ${incidentCount30d} cache or loop ${incidentNoun} silently (30d)`;
      const turnLabel = Math.max(1, Math.round(wastedFrontierTurns30d));
      sublineText = `~${turnLabel} frontier quota turns \u00B7 ${avoidedPrompts30d} manual prompts avoided`;
    }
  }

  return {
    windowDays: 30,
    incidentCount30d,
    sessionIncidentCount,
    wastedTokens30d,
    wastedFrontierTurns30d,
    missedUsd30d,
    avoidedPrompts30d,
    maxSingleIncidentUsd,
    exceedsBreakEvenThreshold,
    displayMode,
    headlineText,
    sublineText,
    ctaMode,
    ctaLabel,
    byCategory,
    recentIncidents: recentCandidates.sort((a, b) => b.ts - a.ts).slice(0, 5)
  };
}
