/**
 * @file src/core-isomorphic/control/swarmWorktree.mjs
 * Swarm & Worktree Observability (Feature 25).
 *
 * Implements Git worktree porcelain parsing, subagent roster tracking,
 * lifecycle state monitoring, and DET-20 scope collision detection.
 * Pure ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

import {
  extractAgentLocation,
  applySubagentLifecycle,
  computeSwarmSummary,
  formatSwarmCompact,
  toCostRadarTopology,
  SWARM_LIFECYCLE_CONSTANTS
} from '../telemetry/swarmTopology.mjs';

import {
  acquireScopeLock,
  evaluateScopeAndQuotaBrake,
  matchesScopePattern
} from '../telemetry/scopeLockRegistry.mjs';

/**
 * Parses `git worktree list --porcelain` stdout into structured objects.
 * Pure string parsing with zero node:path dependency.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseWorktreePorcelain(text = '') {
  if (!text || typeof text !== 'string') return [];

  const entries = [];
  const blocks = text.trim().split(/\n\s*\n/);
  let isFirst = true;

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    let worktree = null;
    let head = null;
    let branch = null;
    let bare = false;
    let detached = false;
    let locked = false;
    let prunable = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('worktree ')) {
        worktree = line.slice(9).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice(5).trim();
      } else if (line.startsWith('branch ')) {
        branch = line.slice(7).trim();
      } else if (line === 'bare') {
        bare = true;
      } else if (line === 'detached') {
        detached = true;
      } else if (line.startsWith('locked')) {
        const reason = line.slice(6).trim();
        locked = reason || true;
      } else if (line.startsWith('prunable')) {
        const reason = line.slice(8).trim();
        prunable = reason || true;
      }
    }

    if (worktree) {
      // Extract basename without node:path, handling spaces and Unicode
      const normalizedPath = worktree.replace(/[\\/]+$/, '');
      const parts = normalizedPath.split(/[\\/]/);
      const name = parts[parts.length - 1] || 'worktree';
      const shortBranch = branch ? branch.replace(/^refs\/heads\//, '') : null;

      entries.push({
        worktree,
        name,
        head,
        branch: shortBranch,
        fullBranch: branch,
        bare,
        detached,
        locked,
        prunable,
        isMain: isFirst
      });
      isFirst = false;
    }
  }

  return entries;
}

// Re-export telemetry and scope registry APIs for unified control surface
export {
  extractAgentLocation,
  applySubagentLifecycle,
  computeSwarmSummary,
  formatSwarmCompact,
  toCostRadarTopology,
  SWARM_LIFECYCLE_CONSTANTS,
  acquireScopeLock,
  evaluateScopeAndQuotaBrake,
  matchesScopePattern
};
