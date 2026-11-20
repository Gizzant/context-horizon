import { computeProratedAllowanceAndFee } from '../policies/prorationPolicy.mjs';
import { aggregateMeteredUsage } from '../adapters/usageMeterAdapter.mjs';

/**
 * Evaluates subscription entitlement, prorated fee/allowance, and SOFT_GRACE vs HARD_CAP overage.
 * Refer to docs/runbooks/ENTITLEMENT_OVERAGE_RUNBOOK.md.
 */
export function evaluateSubscriptionEntitlement({
  accountId,
  metric,
  baseFeeCents = 0,
  includedUnits = 0,
  graceBufferUnits = 0,
  overageUnitRateCents = 0,
  policyMode = 'HARD_CAP',
  periodStartMs,
  periodEndMs,
  planStartMs = periodStartMs,
  planEndMs = periodEndMs,
  usageEvents = []
} = {}) {
  const proration = computeProratedAllowanceAndFee({
    annualOrMonthlyFeeCents: baseFeeCents,
    includedUnits,
    planStartMs,
    planEndMs,
    periodStartMs,
    periodEndMs
  });
  const usage = aggregateMeteredUsage(usageEvents, {
    accountId,
    metric,
    periodStartMs,
    periodEndMs
  });
  const normalizedMode = String(policyMode || 'HARD_CAP').toUpperCase();
  const safeGrace = Math.max(0, Math.trunc(Number(graceBufferUnits || 0)));
  const effectiveAllowance =
    normalizedMode === 'SOFT_GRACE' ? proration.proratedUnits + safeGrace : proration.proratedUnits;
  const overageUnits = Math.max(0, usage.usedUnits - effectiveAllowance);
  const overageFeeCents = overageUnits * Math.max(0, Math.trunc(Number(overageUnitRateCents || 0)));
  const allowed = usage.usedUnits <= effectiveAllowance;
  const status =
    usage.usedUnits <= proration.proratedUnits
      ? 'WITHIN_ALLOWANCE'
      : allowed
        ? 'GRACE_ALLOWED'
        : 'OVER_LIMIT';

  return {
    accountId,
    metric,
    policyMode: normalizedMode,
    graceBufferUnits: safeGrace,
    proratedFeeCents: proration.proratedFeeCents,
    proratedUnits: proration.proratedUnits,
    effectiveAllowance,
    usedUnits: usage.usedUnits,
    dedupedEventCount: usage.dedupedEventCount,
    overageUnits,
    overageFeeCents,
    totalChargeCents: proration.proratedFeeCents + overageFeeCents,
    allowed,
    status
  };
}
