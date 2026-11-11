import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { scopesOverlap } from './telemetry/scope_lock_registry.mjs';

/**
 * Sprint 2.1 — Subagent `/swarm` & Git Worktree Topology.
 *
 * Pure roster reconstruction from transcript tool calls (`swarm`, `invoke_subagent`,
 * `manage_subagents`, `send_message`) joined with a read-only `git worktree list`
 * probe and the scope-lock registry (DET-20 overlap visibility).
 *
 * Honesty rules:
 *  - Worker state is only reported as `working` when there is recent activity evidence;
 *    otherwise it is `waiting` (parked, $0 while asleep). Explicit `swarm status` output
 *    in the transcript overrides inference.
 *  - Warm-prefix tokens are never fabricated; unknown stays 0 and `warmKnown=false`.
 */

export const SWARM_TOPOLOGY_CONSTANTS = Object.freeze({
  WORKING_WINDOW_MS: 120000, // activity within 2 min => working
  CACHE_TTL_MS: 300000, // 5 min prefix cache window for parked workers
  WORKTREE_CACHE_MS: 15000,
  GIT_TIMEOUT_MS: 1200,
  STATUS_LOOKAHEAD_STEPS: 3
});

const VALID_STATES = new Set(['working', 'waiting', 'stopped', 'killed']);

function stepTimestampMs(step = {}) {
  if (typeof step.timestampMs === 'number' && step.timestampMs > 0) return step.timestampMs;
  const raw = step.createdAt || step.timestamp || null;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function argOf(args, ...keys) {
  for (const k of keys) {
    if (args && args[k] !== undefined && args[k] !== null && args[k] !== '') return args[k];
  }
  return undefined;
}

function expandRosterNames(name, n, tasks) {
  const base = String(name || '').trim();
  if (!base) return [];
  if (Array.isArray(tasks) && tasks.length > 0) {
    return tasks.map((_, idx) => `${base}-${idx + 1}`);
  }
  const count = Number(n);
  if (Number.isFinite(count) && count > 1) {
    return Array.from({ length: Math.floor(count) }, (_, idx) => `${base}-${idx + 1}`);
  }
  return [base];
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reconstructs the swarm / subagent roster from transcript steps.
 */
export function parseSwarmRoster(steps = [], {
  nowMs = Date.now(),
  workingWindowMs = SWARM_TOPOLOGY_CONSTANTS.WORKING_WINDOW_MS,
  cacheTtlMs = SWARM_TOPOLOGY_CONSTANTS.CACHE_TTL_MS
} = {}) {
  const roster = new Map();
  const statusCalls = [];
  let title = null;

  const touch = (name, ts, patch = {}) => {
    const key = String(name || '').trim();
    if (!key) return null;
    const existing = roster.get(key) || {
      name: key,
      kind: 'swarm',
      model: 'inherit',
      workspace: 'inherit',
      fork: null,
      addedAtMs: ts || 0,
      lastActiveMs: ts || 0,
      killed: false,
      explicitState: null,
      messages: 0
    };
    const next = { ...existing, ...patch };
    if (ts && ts > next.lastActiveMs) next.lastActiveMs = ts;
    roster.set(key, next);
    return next;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const ts = stepTimestampMs(step);
    const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    for (const call of calls) {
      const toolName = String(call?.name || call?.tool || '').toLowerCase();
      const args = call?.args || call?.parameters || {};

      if (toolName === 'swarm') {
        const action = String(argOf(args, 'action', 'Action') || '').toLowerCase();
        const name = argOf(args, 'name', 'Name');
        if (action === 'add') {
          const names = expandRosterNames(name, argOf(args, 'n'), argOf(args, 'tasks'));
          for (const nm of names) {
            touch(nm, ts, {
              kind: 'swarm',
              model: String(argOf(args, 'model', 'Model') || 'inherit'),
              workspace: String(argOf(args, 'workspace', 'Workspace') || 'inherit'),
              fork: argOf(args, 'fork') ? String(argOf(args, 'fork')) : null,
              killed: false,
              explicitState: 'working'
            });
          }
        } else if (action === 'kill' && name) {
          touch(name, ts, { killed: true, explicitState: 'killed' });
        } else if (action === 'model' && name) {
          touch(name, ts, { model: String(argOf(args, 'model', 'Model') || 'inherit') });
        } else if (action === 'status') {
          statusCalls.push(i);
        } else if (action === 'title') {
          title = String(argOf(args, 'title') || '') || title;
        }
      } else if (toolName === 'invoke_subagent') {
        const role = String(argOf(args, 'Role', 'role') || 'Subagent');
        const convId = call?.result?.conversationId || call?.conversationId || null;
        touch(convId ? `${role}#${String(convId).slice(0, 8)}` : role, ts, {
          kind: 'subagent',
          model: String(argOf(args, 'Model', 'model') || 'inherit'),
          workspace: String(argOf(args, 'Workspace', 'workspace') || 'inherit'),
          conversationId: convId,
          killed: false,
          explicitState: 'working'
        });
      } else if (toolName === 'manage_subagents') {
        const action = String(argOf(args, 'Action', 'action') || '').toLowerCase();
        const ids = Array.isArray(args.ConversationIds) ? args.ConversationIds.map(String) : [];
        for (const w of roster.values()) {
          if (w.kind !== 'subagent') continue;
          const matches = action === 'kill_all' || (action === 'kill' && w.conversationId && ids.includes(String(w.conversationId)));
          if (matches) touch(w.name, ts, { killed: true, explicitState: 'killed' });
        }
      } else if (toolName === 'send_message') {
        const recipient = String(argOf(args, 'Recipient', 'recipient') || '');
        for (const w of roster.values()) {
          if (w.name === recipient || (w.conversationId && String(w.conversationId) === recipient)) {
            touch(w.name, ts, { messages: (w.messages || 0) + 1, explicitState: w.killed ? 'killed' : 'working' });
          }
        }
      }
    }
  }

  // Explicit `swarm status` output overrides inferred state.
  for (const idx of statusCalls) {
    const end = Math.min(steps.length, idx + 1 + SWARM_TOPOLOGY_CONSTANTS.STATUS_LOOKAHEAD_STEPS);
    for (let j = idx; j < end; j++) {
      const text = String(steps[j]?.content || '');
      if (!text) continue;
      for (const w of roster.values()) {
        const re = new RegExp(`\\b${escapeRegex(w.name)}\\b[^\\n]{0,120}?\\b(working|waiting|stopped|killed)\\b`, 'i');
        const m = text.match(re);
        if (m) {
          const state = m[1].toLowerCase();
          roster.set(w.name, { ...w, explicitState: state, killed: state === 'killed', statusAtMs: stepTimestampMs(steps[j]) || w.lastActiveMs });
        }
      }
    }
  }

  const workers = Array.from(roster.values()).map((w) => {
    const idleMs = w.lastActiveMs > 0 ? Math.max(0, nowMs - w.lastActiveMs) : null;
    let state;
    if (w.killed) state = 'killed';
    else if (w.explicitState === 'stopped') state = 'stopped';
    else if (w.statusAtMs && VALID_STATES.has(w.explicitState) && w.statusAtMs >= w.lastActiveMs) state = w.explicitState;
    else if (idleMs !== null && idleMs <= workingWindowMs) state = 'working';
    else state = 'waiting';

    const ttlRemainingSec = (state === 'killed' || state === 'stopped' || idleMs === null)
      ? 0
      : Math.max(0, Math.ceil((cacheTtlMs - idleMs) / 1000));

    return {
      name: w.name,
      kind: w.kind,
      model: w.model,
      workspace: w.workspace,
      fork: w.fork,
      conversationId: w.conversationId || null,
      state,
      parked: state === 'waiting',
      idleSec: idleMs === null ? null : Math.round(idleMs / 1000),
      ttlRemainingSec,
      cacheWarm: ttlRemainingSec > 0,
      warmPrefixTokens: 0,
      warmKnown: false,
      messages: w.messages || 0
    };
  });

  return { title, workers };
}

/**
 * Parses `git worktree list --porcelain` output.
 */
export function parseWorktreePorcelain(text = '') {
  const out = [];
  let cur = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: val, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
    } else if (cur) {
      if (key === 'HEAD') cur.head = val.slice(0, 12);
      else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
      else if (key === 'bare') cur.bare = true;
      else if (key === 'detached') cur.detached = true;
      else if (key === 'locked') cur.locked = true;
      else if (key === 'prunable') cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out.map((w, idx) => ({ ...w, isMain: idx === 0, name: path.basename(w.path || '') || w.path }));
}

const worktreeCache = new Map(); // workspaceDir -> { atMs, result }

/**
 * Read-only `git worktree list --porcelain` probe (1.2s timeout, 15s memo).
 */
export function inspectGitWorktrees(workspaceDir, { nowMs = Date.now(), useCache = true, runner = null } = {}) {
  if (!workspaceDir) return { available: false, worktrees: [], error: 'no-workspace' };
  const cached = worktreeCache.get(workspaceDir);
  if (useCache && cached && nowMs - cached.atMs < SWARM_TOPOLOGY_CONSTANTS.WORKTREE_CACHE_MS) {
    return cached.result;
  }
  let result;
  try {
    const exec = runner || ((args) => execFileSync('git', args, {
      cwd: workspaceDir,
      timeout: SWARM_TOPOLOGY_CONSTANTS.GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    }));
    const text = exec(['worktree', 'list', '--porcelain']);
    result = { available: true, worktrees: parseWorktreePorcelain(text), error: null };
  } catch (err) {
    if (process.env.HORIZON_DEBUG) console.error('[swarm_topology] git worktree probe failed:', err?.message || err);
    result = { available: false, worktrees: [], error: String(err?.code || err?.message || 'git-error') };
  }
  worktreeCache.set(workspaceDir, { atMs: nowMs, result });
  return result;
}

/**
 * Pairwise overlap between active scope leases (DET-20 visibility in the topology view).
 */
export function computeLeaseOverlaps(leases = []) {
  const list = Array.isArray(leases) ? leases : [];
  const collisions = [];
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const A = list[a] || {};
      const B = list[b] || {};
      if (!A.trajectoryId || A.trajectoryId === B.trajectoryId) continue;
      const overlapping = [];
      for (const pa of (A.claimedPaths || [])) {
        for (const pb of (B.claimedPaths || [])) {
          if (scopesOverlap(pa, pb)) overlapping.push(pa === pb ? pa : `${pa} ~ ${pb}`);
        }
      }
      if (overlapping.length > 0) {
        collisions.push({
          detectorId: 'DET-20',
          trajectories: [A.trajectoryId, B.trajectoryId],
          tools: [A.tool || 'antigravity', B.tool || 'antigravity'],
          overlappingPaths: Array.from(new Set(overlapping)).slice(0, 6)
        });
      }
    }
  }
  return collisions;
}

/**
 * Joins roster + worktrees + scope leases into a single topology payload.
 */
export function computeSwarmTopology(steps = [], {
  nowMs = Date.now(),
  workspaceDir = null,
  worktrees = null,
  leases = [],
  probeGit = true
} = {}) {
  const { title, workers } = parseSwarmRoster(steps, { nowMs });
  const wt = Array.isArray(worktrees)
    ? { available: true, worktrees, error: null }
    : (probeGit && workspaceDir ? inspectGitWorktrees(workspaceDir, { nowMs }) : { available: false, worktrees: [], error: 'not-probed' });

  const counts = { working: 0, waiting: 0, stopped: 0, killed: 0 };
  for (const w of workers) counts[w.state] = (counts[w.state] || 0) + 1;
  const live = counts.working + counts.waiting + counts.stopped;
  const parkedWarm = workers.filter((w) => w.state === 'waiting' && w.cacheWarm).length;
  const nearCliff = workers.filter((w) => w.state === 'waiting' && w.ttlRemainingSec > 0 && w.ttlRemainingSec <= 60).length;

  const leaseList = Array.isArray(leases) ? leases : [];
  const collisions = computeLeaseOverlaps(leaseList);
  const worktreeCount = wt.worktrees.length;

  const autoExpand = live > 0 || worktreeCount > 1 || collisions.length > 0;
  const mode = live > 0 ? 'swarm' : (worktreeCount > 1 ? 'worktrees' : 'solo');

  const parts = [];
  if (live > 0) parts.push(`${live} worker${live === 1 ? '' : 's'} (${counts.working} working · ${counts.waiting} parked)`);
  else parts.push('Solo agent');
  if (worktreeCount > 1) parts.push(`${worktreeCount} worktrees`);
  if (collisions.length > 0) parts.push(`${collisions.length} DET-20 overlap${collisions.length === 1 ? '' : 's'}`);

  return {
    mode,
    title,
    autoExpand,
    label: parts.join(' · '),
    counts: { ...counts, live, total: workers.length, parkedWarm, nearCliff },
    workers,
    worktrees: wt.worktrees,
    worktreeCount,
    worktreesAvailable: wt.available,
    scopeLocks: {
      leaseCount: leaseList.length,
      collisions
    }
  };
}

/**
 * Compact label for status surfaces: `Swarm 3W` / `WT 2` / ''.
 */
export function formatSwarmLabel(topology) {
  if (!topology || typeof topology !== 'object') return '';
  const live = topology.counts?.live || 0;
  const parts = [];
  if (live > 0) parts.push(`Swarm ${live}W`);
  if ((topology.worktreeCount || 0) > 1) parts.push(`WT ${topology.worktreeCount}`);
  if ((topology.scopeLocks?.collisions || []).length > 0) parts.push('!DET-20');
  return parts.join(' ');
}
