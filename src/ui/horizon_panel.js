/**
 * Phase 5: 3-Tier Tufte HUD Controller (`src/ui/horizon_panel.js`)
 *
 * Implements:
 * - Tier 1 (Always-Visible Top Spine): Primary Capacity & Horizon Bar (with 5m TTL countdown clock),
 *   40-Cell Token Flamegraph (with `DET-17` duplicate file badges), and 1-line Interactive Model & Effort
 *   Coach Bar (`Off | Coach | Auto-Pilot` segmented toggle + `#coachActionPill` / Subagent badge).
 * - Tier 2 (Event-Driven Intervention Card Slot): Collapsed by default; renders at most 1 priority card
 *   at a time (`DET-09` Cold-Resume-Lean, `DET-02` 3-Stage Contract, `DET-06` Assert Revert,
 *   Turn-45 Baton Pass, or Turn-0 Hygiene Gate) with Single Action Button Simplicity.
 * - Tier 3 (Fixed 24px Footer): Live Saved-Quota Receipt + `[Copy Receipt]` button.
 */

export const TIER2_PRIORITY_ORDER = Object.freeze([
  'DET-03_ASSERT_REVERT',
  'DET-02_THREE_STAGE_CONTRACT',
  'DET-09_COLD_RESUME_LEAN',
  'TURN_45_BATON_PASS',
  'TURN_0_HYGIENE_GATE'
]);

export function formatFiveMinTtlClock(ttlRemainingSeconds = 0) {
  const sec = Math.max(0, Math.floor(Number(ttlRemainingSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Selects at most 1 highest-priority intervention card for the Tier 2 slot.
 * Strictly enforces Single Action Button Simplicity (exactly 1 primary action button).
 */
export function selectHighestPriorityTier2Card(coachState = {}) {
  const alerts = Array.isArray(coachState.circuitBreakerAlerts) ? coachState.circuitBreakerAlerts : [];

  // Priority 1: DET-03 Test Assertion Weakening Revert (accepts legacy DET-06 fixture alias)
  const det03 = alerts.find((a) => a.detectorId === 'DET-03' || a.detectorId === 'DET-06');
  if (det03) {
    return {
      cardType: 'DET-03_ASSERT_REVERT',
      critical: true,
      title: `🚨 DET-03 Assertion Weakening (${det03.filePath || 'test file'})`,
      subtitle: `${det03.netDeletedCount || 1} assert/expect statement(s) deleted while fixing tests.`,
      buttonLabel: '📋 Copy Prompt',
      actionKind: 'REVERT_TEST_ASSERTIONS',
      actionPayload: det03.revertAction || { filePath: det03.filePath }
    };
  }

  // Priority 2: DET-02 3-Stage Stepwise Refinement Contract
  const det02 = alerts.find((a) => a.detectorId === 'DET-02');
  if (det02) {
    return {
      cardType: 'DET-02_THREE_STAGE_CONTRACT',
      critical: true,
      title: `🚨 DET-02 AST Edit Oscillation (${det02.filePath || 'source file'})`,
      subtitle: 'File hash reverted to prior turn state. Inject 3-Stage Design-by-Contract refinement.',
      buttonLabel: '📋 Copy Prompt',
      actionKind: 'INJECT_THREE_STAGE_CONTRACT',
      actionPayload: det02.promptPill || {}
    };
  }

  // Priority 3: DET-09 Cold-Resume-Lean (TTL Expired on >= 60k cache)
  if (coachState.ttlWatchdog?.state === 'TTL_EXPIRED_COLD_RISK' || coachState.det09ColdResumeLean) {
    return {
      cardType: 'DET-09_COLD_RESUME_LEAN',
      critical: false,
      title: '❄️ DET-09 Cold-Resume-Lean: 5m Cache TTL Expired',
      subtitle: 'Avoid paying 100% cold prefill on bloated history. Launch hydrated session from pre-staged bundle.',
      buttonLabel: 'Launch Hydrated Session',
      actionKind: 'LAUNCH_HYDRATED_SESSION',
      actionPayload: coachState.handoffBundle || {}
    };
  }

  // Priority 4: Turn-45 Baton Pass
  if (Number(coachState.turnCount || 0) >= 45 || coachState.compactionCoach?.recommendBatonPass) {
    return {
      cardType: 'TURN_45_BATON_PASS',
      critical: false,
      title: '🤝 Turn-45 Baton Pass Recommended',
      subtitle: 'Context horizon approaching high-turn degradation. Execute zero-amnesia Baton Pass.',
      buttonLabel: 'Launch Hydrated Session',
      actionKind: 'LAUNCH_HYDRATED_SESSION',
      actionPayload: coachState.handoffBundle || {}
    };
  }

  // Priority 5: Turn-0 Hygiene Gate
  if (Number(coachState.turnCount || 0) === 0 && coachState.turnZeroGate?.strandedCount > 0) {
    return {
      cardType: 'TURN_0_HYGIENE_GATE',
      critical: false,
      title: '🧲 Turn-0 Workspace Hygiene & MCP Profile Gate',
      subtitle: `${coachState.turnZeroGate.strandedCount} critical rules in middle attention trough. Reorder before Turn 1 warms cache.`,
      buttonLabel: 'Optimize Rules & Apply Lean Profile',
      actionKind: 'APPLY_TURN_ZERO_GATE',
      actionPayload: coachState.turnZeroGate
    };
  }

  return null;
}

/**
 * Updates the 3-Tier Tufte HUD DOM elements when running inside the browser/webview.
 */
export function renderThreeTierTufteHud(doc, state = {}) {
  if (!doc || typeof doc.getElementById !== 'function') return null;

  const coach = state.coach || {};

  // Tier 1A: 5m TTL Countdown Clock
  const ttlClockEl = doc.getElementById('ttlCountdownClock');
  if (ttlClockEl) {
    const ttlSec = Number(
      coach.ttlWatchdog?.ttlRemainingSeconds ??
      state.quota?.cache?.ttlRemainingSec ??
      state.cache?.ttlRemainingSec ??
      300
    );
    ttlClockEl.textContent = `TTL: ${formatFiveMinTtlClock(ttlSec)}`;
    ttlClockEl.classList.remove('ttl-warning-pulse', 'ttl-expired-cold-risk');
    if (ttlSec === 0) {
      ttlClockEl.classList.add('ttl-expired-cold-risk');
    } else if (ttlSec <= 45) {
      ttlClockEl.classList.add('ttl-warning-pulse');
    }
  }

  // Tier 1B: DET-17 Duplicate Shadowed File Badges in 40-Cell Flamegraph
  const det17StripEl = doc.getElementById('det17BadgeStrip');
  if (det17StripEl) {
    const badges = Array.isArray(coach.det17ShadowBloat?.flamegraphBadges)
      ? coach.det17ShadowBloat.flamegraphBadges
      : [];
    if (badges.length > 0) {
      det17StripEl.hidden = false;
      det17StripEl.innerHTML = badges
        .map((b) => `<span class="det17-shadow-badge mono" title="DET-17 Shadowed File Bloat">⚠️ ${b}</span>`)
        .join('');
    } else {
      det17StripEl.hidden = true;
      det17StripEl.innerHTML = '';
    }
  }

  // Tier 1C: Coach Action Pill tooltip (Break-even math) & Subagent Live Pill
  const coachPillEl = doc.getElementById('coachActionPill');
  if (coachPillEl && coach.taskRoute?.gravity?.tooltip) {
    coachPillEl.title = coach.taskRoute.gravity.tooltip;
  }

  const subagentPillEl = doc.getElementById('subagentLivePill');
  if (subagentPillEl) {
    const subPillText = coach.subagentAudit?.coachBarPill || null;
    if (subPillText) {
      subagentPillEl.hidden = false;
      subagentPillEl.textContent = subPillText;
    } else {
      subagentPillEl.hidden = true;
    }
  }

  // Tier 2: Single-Slot Priority Intervention Card (Collapsed by default)
  const tier2SlotEl = doc.getElementById('tier2InterventionSlot');
  const activeCard = selectHighestPriorityTier2Card(coach);
  if (tier2SlotEl) {
    if (!activeCard) {
      tier2SlotEl.hidden = true;
    } else {
      tier2SlotEl.hidden = false;
      tier2SlotEl.classList.toggle('critical', Boolean(activeCard.critical));
      const titleEl = doc.getElementById('tier2CardTitle');
      const subEl = doc.getElementById('tier2CardSub');
      const btnEl = doc.getElementById('btnTier2PrimaryAction');
      if (titleEl) titleEl.textContent = activeCard.title;
      if (subEl) subEl.textContent = activeCard.subtitle;
      if (btnEl) {
        btnEl.textContent = activeCard.buttonLabel;
        btnEl.dataset.actionKind = activeCard.actionKind;
      }
    }
  }

  // Tier 3: Fixed 24px Saved-Quota Receipt Footer
  const receiptTextEl = doc.getElementById('savedQuotaReceiptText');
  if (receiptTextEl && coach.savedQuotaLedger?.statusBarText) {
    receiptTextEl.textContent = coach.savedQuotaLedger.statusBarText;
  }

  return {
    activeTier2Card: activeCard
  };
}

if (typeof window !== 'undefined') {
  window.HorizonTufteHud = {
    TIER2_PRIORITY_ORDER,
    formatFiveMinTtlClock,
    selectHighestPriorityTier2Card,
    renderThreeTierTufteHud
  };
}

export default {
  TIER2_PRIORITY_ORDER,
  formatFiveMinTtlClock,
  selectHighestPriorityTier2Card,
  renderThreeTierTufteHud
};
