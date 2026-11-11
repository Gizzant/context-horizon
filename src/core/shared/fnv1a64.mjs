/**
 * Pure 64-bit FNV-1a Content Hash & Rolling 6-Turn Flip-Flop Ring Buffer (`src/core/shared/fnv1a64.mjs`)
 *
 * Zero Node I/O imports so cross-repo sync with `cc-attention-horizon` stays 100% clean.
 */

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const FNV1A_64_MASK = 0xffffffffffffffffn;

export function normalizeCodeForHash(content = '') {
  return String(content ?? '')
    .replace(/\r\n/g, () => '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, () => ''))
    .join('\n')
    .trim();
}

export function fnv1a64Hex(content = '', { normalize = true } = {}) {
  const str = normalize ? normalizeCodeForHash(content) : String(content ?? '');
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let hash = FNV1A_64_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV1A_64_PRIME) & FNV1A_64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Updates a bounded per-file rolling 6-turn ring buffer of `{ hash, turn }` entries
 * and detects `State A -> State B -> State A` oscillation flip-flops.
 */
export function evaluateFnv1aRingBuffer(existingRing = [], nextContent = '', {
  turn = 0,
  maxEntries = 6,
  initialContent = null
} = {}) {
  const cap = Math.max(3, Number(maxEntries) || 6);
  const ring = Array.isArray(existingRing)
    ? existingRing
        .filter((e) => e && typeof e.hash === 'string')
        .map((e) => ({ hash: e.hash, turn: Number(e.turn ?? 0) }))
    : [];

  if (ring.length === 0 && typeof initialContent === 'string' && initialContent.length > 0) {
    ring.push({ hash: fnv1a64Hex(initialContent), turn: Math.max(0, Number(turn) - 1) });
  }

  const nextHash = fnv1a64Hex(nextContent);
  const lastEntry = ring.length > 0 ? ring[ring.length - 1] : null;

  // Identical no-op write is not an A -> B -> A oscillation
  if (lastEntry && lastEntry.hash === nextHash) {
    return {
      oscillationDetected: false,
      hash: nextHash,
      matchedTurn: null,
      ring: ring.slice(-cap)
    };
  }

  // Look for an earlier occurrence of `nextHash` with at least one distinct intermediate state B
  let matchedEntry = null;
  for (let i = ring.length - 2; i >= 0; i--) {
    const candidate = ring[i];
    if (candidate.hash === nextHash) {
      const hasDistinctIntermediate = ring.slice(i + 1).some((mid) => mid.hash !== nextHash);
      if (hasDistinctIntermediate) {
        matchedEntry = candidate;
        break;
      }
    }
  }

  const updatedRing = [...ring, { hash: nextHash, turn: Number(turn || 0) }].slice(-cap);
  return {
    oscillationDetected: Boolean(matchedEntry),
    hash: nextHash,
    matchedTurn: matchedEntry ? matchedEntry.turn : null,
    ring: updatedRing
  };
}
