import crypto from 'node:crypto';
import { INVOICE_STATUS } from './constants.mjs';
import { ERROR_CODES, LedgerError } from './errors.mjs';
import { computeGraduatedCharge } from './tierEngine.mjs';
import { applyCredits } from './creditPool.mjs';
import { encodeFrozenWireDigest } from './frozenWire.mjs';

function canonicalJson(val) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const keys = Object.keys(val)
    .filter((k) => val[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(val[k])}`).join(',')}}`;
}

function hashSagaPayload(req) {
  const payload = {
    invoiceId: req.invoiceId,
    accountId: req.accountId,
    currency: req.currency ?? 'USD',
    usageRows: req.usageRows ?? [],
    asOfMs: req.asOfMs ?? 0
  };
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * Builds an invoice from usage rows and credit grants.
 */
export function buildInvoice({
  invoiceId,
  accountId,
  currency = 'USD',
  usageRows = [],
  grants = [],
  asOfMs = 0
} = {}) {
  const lineItems = [];
  let usageSubtotalCents = 0;

  for (const row of usageRows) {
    const { totalCents } = computeGraduatedCharge(row.units, row.tiers);
    usageSubtotalCents += totalCents;
    lineItems.push({
      metric: row.metric,
      units: row.units,
      amountCents: totalCents
    });
  }

  const creditResult = applyCredits(usageSubtotalCents, grants, asOfMs);
  const totalDueCents = creditResult.remainingChargeCents;
  const status = INVOICE_STATUS.FINALIZED;
  const wireDigest = encodeFrozenWireDigest({
    invoiceId,
    accountId,
    currency,
    totalDueCents,
    status
  });

  return {
    invoiceId,
    accountId,
    currency,
    status,
    lineItems,
    usageSubtotalCents,
    appliedCreditsCents: creditResult.appliedCents,
    creditAllocations: creditResult.allocations,
    totalDueCents,
    wireDigest
  };
}

/**
 * Creates a mutable settlement registry holding cloned grants, finalized invoices,
 * and `unreconciledGatewayCents`.
 */
export function createSettlementRegistry(initialGrants = []) {
  if (!Array.isArray(initialGrants)) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'initialGrants must be an array');
  }
  return {
    grants: initialGrants.map((g) => ({ ...g })),
    invoices: [],
    unreconciledGatewayCents: 0
  };
}

/**
 * Executes a multi-stage async payment settlement saga with strict idempotency
 * and reverse-order compensation.
 */
export async function executeSettlementSaga(ctx, request) {
  if (!ctx || !ctx.registry || !ctx.guard || !ctx.gateway || !ctx.ledgerStore) {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_CONFIG, 'Invalid settlement saga context');
  }
  if (!request || typeof request !== 'object') {
    throw new LedgerError(ERROR_CODES.ERR_INVALID_EVENT, 'Invalid settlement request');
  }

  const { registry, guard, gateway, ledgerStore } = ctx;
  const {
    idempotencyKey,
    invoiceId,
    accountId,
    currency = 'USD',
    usageRows = [],
    asOfMs = 0
  } = request;

  const payloadHash = hashSagaPayload({ invoiceId, accountId, currency, usageRows, asOfMs });
  const gate = guard.beginInFlight(idempotencyKey, payloadHash, asOfMs);
  if (gate.status === 'replayed') {
    return {
      ...gate.cachedResult,
      replayed: true
    };
  }

  let invoice;
  let creditResult;
  try {
    const lineItems = [];
    let usageSubtotalCents = 0;
    for (const row of usageRows) {
      const { totalCents } = computeGraduatedCharge(row.units, row.tiers);
      usageSubtotalCents += totalCents;
      lineItems.push({ metric: row.metric, units: row.units, amountCents: totalCents });
    }
    creditResult = applyCredits(usageSubtotalCents, registry.grants, asOfMs);
    for (let i = 0; i < registry.grants.length; i += 1) {
      registry.grants[i].remainingCents = creditResult.updatedGrants[i].remainingCents;
    }

    const totalDueCents = creditResult.remainingChargeCents;
    const status = INVOICE_STATUS.FINALIZED;
    const wireDigest = encodeFrozenWireDigest({
      invoiceId,
      accountId,
      currency,
      totalDueCents,
      status
    });
    invoice = {
      invoiceId,
      accountId,
      currency,
      status,
      lineItems,
      usageSubtotalCents,
      appliedCreditsCents: creditResult.appliedCents,
      creditAllocations: creditResult.allocations,
      totalDueCents,
      wireDigest
    };
  } catch (err) {
    guard.markFailedRelease(idempotencyKey, payloadHash);
    throw err;
  }

  function restoreReservedCredits() {
    for (const alloc of creditResult.allocations) {
      const grant = registry.grants.find((g) => g.grantId === alloc.grantId);
      if (grant) {
        grant.remainingCents += alloc.appliedCents;
      }
    }
  }

  const remainingGatewayCents = invoice.totalDueCents;
  let authId = null;
  let captureId = null;

  if (remainingGatewayCents > 0) {
    try {
      const authRes = await gateway.authorize({
        amountCents: remainingGatewayCents,
        currency,
        invoiceId,
        accountId
      });
      authId = authRes?.authId ?? null;
    } catch (err) {
      restoreReservedCredits();
      guard.markFailedRelease(idempotencyKey, payloadHash);
      err.compensationSteps = ['restore_credits'];
      throw err;
    }

    try {
      const capRes = await gateway.capture({
        authId,
        amountCents: remainingGatewayCents,
        currency,
        invoiceId
      });
      captureId = capRes?.captureId ?? null;
    } catch (err) {
      await gateway.release(authId);
      restoreReservedCredits();
      guard.markFailedRelease(idempotencyKey, payloadHash);
      err.compensationSteps = ['release_auth', 'restore_credits'];
      throw err;
    }
  }

  try {
    await ledgerStore.append(structuredClone(invoice));
  } catch (err) {
    if (captureId !== null) {
      try {
        await gateway.refund({
          captureId,
          amountCents: remainingGatewayCents,
          invoiceId
        });
      } catch (compErr) {
        registry.unreconciledGatewayCents += remainingGatewayCents;
        guard.markCompensationFailed(
          idempotencyKey,
          payloadHash,
          {
            captureId,
            unreconciledCents: remainingGatewayCents,
            primaryError: err?.message || String(err),
            compensationError: compErr?.message || String(compErr)
          },
          asOfMs
        );
        throw new LedgerError(ERROR_CODES.ERR_COMPENSATION_FAILED, 'Refund compensation failed', {
          primaryError: err,
          compensationError: compErr,
          captureId,
          compensationSteps: ['refund_capture_failed']
        });
      }
      restoreReservedCredits();
      guard.markFailedRelease(idempotencyKey, payloadHash);
      err.compensationSteps = ['refund_capture', 'restore_credits'];
      throw err;
    }

    restoreReservedCredits();
    guard.markFailedRelease(idempotencyKey, payloadHash);
    err.compensationSteps = ['restore_credits'];
    throw err;
  }

  registry.invoices.push(structuredClone(invoice));
  const completedResult = {
    ...invoice,
    authId,
    captureId
  };
  guard.markSucceeded(idempotencyKey, payloadHash, completedResult, asOfMs);
  return {
    ...completedResult,
    replayed: false
  };
}
