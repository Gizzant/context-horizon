/**
 * Pure Zero-I/O Cascade 70k State Baton & Handoff Schemas (`src/core/shared/handoff_schema.mjs`)
 *
 * Shared schema definition between `attention-horizon-antigravity` and `attention-horizon-claude`.
 */

export const CASCADE_COMPACTION_CEILING_TOKENS = 70000;

export const CASCADE_CHECKPOINT_BANDS = Object.freeze([
  Object.freeze({ label: '20%', ratio: 0.20, tokens: 14000 }),
  Object.freeze({ label: '35%', ratio: 0.35, tokens: 25000 }),
  Object.freeze({ label: '50%', ratio: 0.50, tokens: 35000 }),
  Object.freeze({ label: '65%', ratio: 0.65, tokens: 45000 }),
  Object.freeze({ label: '80%', ratio: 0.80, tokens: 56000 })
]);

export const HANDOFF_SCHEMA_VERSION = '2.0.0';

function cleanStringArray(arr, maxItems = 12, maxLen = 220) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const item = String(raw ?? '').trim();
    if (!item) continue;
    const clamped = item.length > maxLen ? `${item.slice(0, maxLen - 3)}...` : item;
    if (!seen.has(clamped)) {
      seen.add(clamped);
      out.push(clamped);
      if (out.length >= maxItems) break;
    }
  }
  return out;
}

export function createStateBaton(input = {}) {
  const currentTokens = Math.max(0, Math.round(Number(input.currentTokens ?? input.tokens ?? 0)));
  const ceilingTokens = Math.max(1, Math.round(Number(input.ceilingTokens ?? CASCADE_COMPACTION_CEILING_TOKENS)));
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    sessionId: String(input.sessionId || 'default_session'),
    bandLabel: String(input.bandLabel || 'manual'),
    turn: Math.max(0, Math.round(Number(input.turn ?? input.turnCount ?? 0))),
    currentTokens,
    ceilingTokens,
    fillPct: Number(((currentTokens / ceilingTokens) * 100).toFixed(1)),
    updatedAt: String(input.updatedAt || new Date().toISOString()),
    activeGoal: String(input.activeGoal || 'Continue active workspace implementation').trim().slice(0, 320),
    workingSetFiles: cleanStringArray(input.workingSetFiles, 12, 180),
    verifiedInvariants: cleanStringArray(input.verifiedInvariants, 10, 220),
    negativeConstraints: cleanStringArray(input.negativeConstraints, 10, 220),
    deadEnds: cleanStringArray(input.deadEnds, 8, 220)
  };
}

export function validateStateBaton(baton) {
  const errors = [];
  if (!baton || typeof baton !== 'object' || Array.isArray(baton)) {
    return { valid: false, errors: ['StateBaton must be an object'] };
  }
  if (typeof baton.activeGoal !== 'string' || !baton.activeGoal.trim()) {
    errors.push('activeGoal must be a non-empty string');
  }
  for (const field of ['workingSetFiles', 'verifiedInvariants', 'negativeConstraints', 'deadEnds']) {
    if (!Array.isArray(baton[field])) {
      errors.push(`${field} must be an array`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Formats a compact ~300-token Cold-Resume State Baton hydration block for 1-click resume
 * after the 5m implicit cache expires or Cascade auto-compacts at 70k.
 */
export function formatColdResumeBatonPrompt(batonInput = {}) {
  const b = createStateBaton(batonInput);
  const lines = [
    `[Attention Horizon Cold-Resume Baton • ${b.bandLabel} (${b.currentTokens.toLocaleString('en-US')}/${b.ceilingTokens.toLocaleString('en-US')} tok)]`,
    `Goal: ${b.activeGoal}`,
    `Working Set: ${b.workingSetFiles.slice(0, 6).join(', ') || '(none recorded)'}`
  ];
  if (b.verifiedInvariants.length > 0) {
    lines.push(`Verified: ${b.verifiedInvariants.slice(0, 4).join(' | ')}`);
  }
  if (b.negativeConstraints.length > 0) {
    lines.push(`Constraints: ${b.negativeConstraints.slice(0, 4).join(' | ')}`);
  }
  if (b.deadEnds.length > 0) {
    lines.push(`Avoid Dead-Ends: ${b.deadEnds.slice(0, 3).join(' | ')}`);
  }
  const text = lines.join('\n');
  // Clamp strictly near ~300 tokens (~1,200 chars)
  return text.length > 1200 ? `${text.slice(0, 1197)}...` : text;
}

export function formatHandoffMarkdown(batonInput = {}, meta = {}) {
  const b = createStateBaton(batonInput);
  const bulletOrNone = (arr) => (arr.length > 0 ? arr.map((x) => `- ${x}`).join('\n') : '- *(none)*');
  return [
    `# Attention Horizon — Session State Baton Handoff`,
    ``,
    `- **Generated At:** ${b.updatedAt}`,
    `- **Trigger:** ${String(meta.trigger || 'explicit_export')}`,
    `- **Cascade Window:** ${b.currentTokens} / ${b.ceilingTokens} tokens (${b.fillPct}%) • Turn ${b.turn}`,
    ``,
    `## Active Goal`,
    `${b.activeGoal}`,
    ``,
    `## Working Set Files`,
    bulletOrNone(b.workingSetFiles),
    ``,
    `## Verified Invariants`,
    bulletOrNone(b.verifiedInvariants),
    ``,
    `## Negative Constraints (Must Preserve)`,
    bulletOrNone(b.negativeConstraints),
    ``,
    `## Dead Ends (Do Not Repeat)`,
    bulletOrNone(b.deadEnds),
    ``
  ].join('\n');
}
