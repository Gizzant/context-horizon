import { WIRE_SCHEMA_VERSION } from './constants.mjs';

/**
 * Legacy LP-WIRE-V1 deterministic 32-bit FNV-1a digest serializer.
 * FROZEN CONTRACT: downstream settlement consumers rely on exact byte output.
 *
 * @param {object} summary
 * @returns {string}
 */
export function encodeFrozenWireDigest(summary = {}) {
  const invoiceId = String(summary.invoiceId || '');
  const accountId = String(summary.accountId || '');
  const currency = String(summary.currency || 'USD');
  const totalDueCents = Math.trunc(Number(summary.totalDueCents || 0));
  const status = String(summary.status || 'FINALIZED');
  const canonical = `${WIRE_SCHEMA_VERSION}|${invoiceId}|${accountId}|${currency}|${totalDueCents}|${status}`;

  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `${WIRE_SCHEMA_VERSION}:${hex}:${totalDueCents}`;
}
