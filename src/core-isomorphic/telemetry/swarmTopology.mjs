/**
 * Sprint 2.1 (Claude Code) — Subagent lifecycle & worktree topology.
 *
 * Pure ESM, zero `node:*` imports (Mod-safe). Derives per-`agentId` lifecycle from the
 * telemetry bridge's `state.subagents` / `state.subagentInFlightTurns` maps:
 *   - `working`   : in-flight turn, or activity within the idle window (default 30s)
 *   - `waiting`   : idle longer than the window with no completion seen (parked, $0)
 *   - `completed` : the subagent's final `turn.complete` was observed and nothing since
 * Worktree / branch metadata is only reported when the host event supplied it.
 */

export const SWARM_LIFECYCLE_CONSTANTS = Object.freeze({
  IDLE_WINDOW_MS: 30000,
  MAX_WORKERS: 24
});

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Extracts optional worktree / branch / model metadata from a mod turn event.
 */
export function extractAgentLocation(event = {}) {
  const ev = event && typeof event === 'object' ? event : {};
  return {
    model: str(ev.model) || str(ev.result?.model),
    worktree: str(ev.worktree) || str(ev.worktreePath) || str(ev.worktree_path) || str(ev.cwd) || null,
    branch: str(ev.gitBranch) || str(ev.git_branch) || str(ev.branch) || null
  };
}

/**
 * Mutates a `state.subagents[agentKey]` record with lifecycle + location fields.
 */
export function applySubagentLifecycle(sub, event = {}, { nowMs = 0, eventType = 'turn.step' } = {}) {
  if (!sub || typeof sub !== 'object') return sub;
  const loc = extractAgentLocation(event);
  if (loc.model) sub.model = loc.model;
  if (loc.worktree) sub.worktree = loc.worktree;
  if (loc.branch) sub.branch = loc.branch;
  if (!sub.firstSeenAt) sub.firstSeenAt = nowMs || sub.lastActiveAt || 0;
  if (eventType === 'turn.complete') {
    sub.completedAt = nowMs || sub.lastActiveAt || 0;
  } else {
    sub.completedAt = null;
  }
  return sub;
}

/**
 * Builds the swarm summary rendered by the Pane and statusLine.
 */
export function computeSwarmSummary(state = {}, {
  nowMs = Date.now(),
  idleWindowMs = SWARM_LIFECYCLE_CONSTANTS.IDLE_WINDOW_MS
} = {}) {
  const subs = state && typeof state.subagents === 'object' && state.subagents ? state.subagents : {};
  const inFlight = state && typeof state.subagentInFlightTurns === 'object' && state.subagentInFlightTurns
    ? state.subagentInFlightTurns
    : {};

  const workers = Object.values(subs)
    .filter((s) => s && typeof s === 'object' && s.agentId)
    .map((s) => {
      const lastActive = Number(s.lastActiveAt) || 0;
      const idleMs = lastActive > 0 ? Math.max(0, nowMs - lastActive) : null;
      let lifecycle;
      if (inFlight[s.agentId]) lifecycle = 'working';
      else if (s.completedAt && Number(s.completedAt) >= lastActive) lifecycle = 'completed';
      else if (idleMs !== null && idleMs <= idleWindowMs) lifecycle = 'working';
      else lifecycle = 'waiting';
      return {
        agentId: String(s.agentId),
        state: lifecycle,
        idleSec: idleMs === null ? null : Math.round(idleMs / 1000),
        turns: Number(s.turns) || 0,
        totalTokens: Number(s.totalTokens) || 0,
        model: s.model || null,
        worktree: s.worktree || null,
        branch: s.branch || null
      };
    })
    .sort((a, b) => (a.state === b.state ? b.totalTokens - a.totalTokens : (a.state === 'working' ? -1 : b.state === 'working' ? 1 : 0)))
    .slice(0, SWARM_LIFECYCLE_CONSTANTS.MAX_WORKERS);

  const counts = { working: 0, waiting: 0, completed: 0 };
  for (const w of workers) counts[w.state] = (counts[w.state] || 0) + 1;
  const live = counts.working + counts.waiting;

  const wtMap = new Map();
  const mainLoc = { worktree: str(state?.cwd) || str(state?.workspace) || null, branch: str(state?.gitBranch) || null };
  if (mainLoc.worktree || mainLoc.branch) wtMap.set(`${mainLoc.worktree || ''}|${mainLoc.branch || ''}`, { ...mainLoc, agents: ['main'] });
  for (const w of workers) {
    if (!w.worktree && !w.branch) continue;
    const key = `${w.worktree || ''}|${w.branch || ''}`;
    const entry = wtMap.get(key) || { worktree: w.worktree, branch: w.branch, agents: [] };
    entry.agents.push(w.agentId);
    wtMap.set(key, entry);
  }
  const worktrees = Array.from(wtMap.values());

  const parts = [];
  if (live > 0) parts.push(`${live} live (${counts.working} working · ${counts.waiting} parked)`);
  if (counts.completed > 0) parts.push(`${counts.completed} done`);
  if (worktrees.length > 1) parts.push(`${worktrees.length} worktrees`);

  return {
    active: workers.length > 0,
    live,
    counts: { ...counts, total: workers.length },
    workers,
    worktrees,
    worktreeCount: worktrees.length,
    label: parts.length > 0 ? parts.join(' · ') : 'Solo'
  };
}

/**
 * Compact statusLine token: `Swarm 3W` (live workers) / '' when solo.
 */
export function formatSwarmCompact(summary) {
  if (!summary || !summary.live) return '';
  return `Swarm ${summary.live}W`;
}

/**
 * Converts the CC summary into the shared `/cost-radar` topology shape.
 */
export function toCostRadarTopology(summary) {
  if (!summary || !summary.active) return null;
  const stateMap = { working: 'working', waiting: 'waiting', completed: 'killed' };
  return {
    workers: summary.workers.map((w) => ({
      name: w.agentId,
      state: stateMap[w.state] || 'waiting',
      parked: w.state === 'waiting',
      model: w.model || 'inherit',
      workspace: w.branch || (w.worktree ? 'worktree' : 'inherit')
    })),
    worktrees: summary.worktrees.map((t, idx) => ({
      path: t.worktree || '',
      branch: t.branch || null,
      name: t.worktree || t.branch || `wt-${idx}`,
      isMain: idx === 0,
      detached: false,
      locked: false,
      prunable: false
    })),
    scopeLocks: { leaseCount: 0, collisions: [] }
  };
}
