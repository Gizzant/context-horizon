/**
 * @file src/engine-node/sensors/git_merge_tree.mjs
 * Non-destructive DET-31 Cross-Worktree Git Merge Conflict Sensor.
 *
 * Runs `git merge-tree --write-tree` in <12ms with 0 working-tree or index mutations.
 */

import { execFileSync } from 'node:child_process';

/**
 * Parses conflict files and messages from git merge-tree output.
 *
 * @param {string} output
 * @returns {{ conflictFiles: string[], conflictMessages: string[] }}
 */
export function parseMergeTreeOutput(output = '') {
  const lines = output.split(/\r?\n/);
  const conflictFiles = new Set();
  const conflictMessages = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Line format: CONFLICT (content): Merge conflict in path/to/file.js
    const conflictMatch = trimmed.match(/^CONFLICT\s*\(([^)]+)\):\s*(.+)$/i);
    if (conflictMatch) {
      conflictMessages.push(trimmed);
      const detail = conflictMatch[2];
      const fileMatch = detail.match(/(?:in|of)\s+([^\s]+)$/i);
      if (fileMatch) {
        conflictFiles.add(fileMatch[1].trim());
      }
      continue;
    }

    // Git merge-tree unmerged stage entry: 100644 <hash> <stage> <file>
    const stageMatch = trimmed.match(/^\d{6}\s+[0-9a-f]{40,64}\s+[123]\s+(.+)$/i);
    if (stageMatch) {
      conflictFiles.add(stageMatch[1].trim());
    }
  }

  return {
    conflictFiles: Array.from(conflictFiles),
    conflictMessages
  };
}

/**
 * Probes for merge conflicts between two commits or branch heads non-destructively.
 *
 * @param {string} baseCommit - Commit or ref (e.g. 'HEAD', 'main')
 * @param {string} targetCommit - Commit or ref (e.g. 'feature-branch', worktree commit)
 * @param {object} [options={}]
 * @param {string} [options.workspaceDir] - Repository working directory
 * @param {boolean} [options.nameOnly=false] - Only report conflicting file names
 * @param {number} [options.timeoutMs=5000] - Process execution timeout
 * @returns {{
 *   clean: boolean,
 *   hasConflict: boolean,
 *   treeHash: string | null,
 *   conflictFiles: string[],
 *   conflictMessages: string[],
 *   latencyMs: number,
 *   error?: string,
 *   degraded?: boolean
 * }}
 */
export function probeGitMergeTree(baseCommit, targetCommit, options = {}) {
  const start = performance.now();
  if (!baseCommit || !targetCommit) {
    return {
      clean: false,
      hasConflict: false,
      treeHash: null,
      conflictFiles: [],
      conflictMessages: [],
      latencyMs: 0,
      error: 'Both baseCommit and targetCommit must be provided'
    };
  }

  const cwd = options.workspaceDir || process.cwd();
  const args = ['merge-tree', '--write-tree'];
  if (options.nameOnly) {
    args.push('--name-only');
  }
  args.push('--', String(baseCommit), String(targetCommit));

  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs || 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const latencyMs = Number((performance.now() - start).toFixed(3));
    const lines = stdout.trim().split(/\r?\n/);
    const treeHash = lines[0] ? lines[0].trim() : null;

    return {
      clean: true,
      hasConflict: false,
      treeHash,
      conflictFiles: [],
      conflictMessages: [],
      latencyMs
    };
  } catch (err) {
    const latencyMs = Number((performance.now() - start).toFixed(3));

    // Exit status 1 signals a merge conflict in git merge-tree --write-tree
    if (err && err.status === 1) {
      const stderr = err.stderr ? String(err.stderr) : '';
      if (/not something we can merge|fatal:|unknown option/i.test(stderr)) {
        return {
          clean: false,
          hasConflict: false,
          treeHash: null,
          conflictFiles: [],
          conflictMessages: [],
          latencyMs,
          error: stderr.trim() || 'Invalid commit or git error',
          degraded: true
        };
      }

      const out = (err.stdout ? String(err.stdout) : '') + '\n' + stderr;
      const parsed = parseMergeTreeOutput(out);
      const lines = (err.stdout ? String(err.stdout) : '').trim().split(/\r?\n/);
      const treeHash = lines[0] && /^[0-9a-f]{40,64}$/i.test(lines[0].trim()) ? lines[0].trim() : null;
      const hasRealConflict = parsed.conflictFiles.length > 0 || parsed.conflictMessages.length > 0;

      return {
        clean: false,
        hasConflict: hasRealConflict,
        treeHash,
        conflictFiles: parsed.conflictFiles,
        conflictMessages: parsed.conflictMessages,
        latencyMs,
        ...(hasRealConflict ? {} : { error: stderr.trim() || 'Merge probe failed', degraded: true })
      };
    }

    // Any other error (e.g. invalid git ref, git not found, git version < 2.38) degrades gracefully
    return {
      clean: false,
      hasConflict: false,
      treeHash: null,
      conflictFiles: [],
      conflictMessages: [],
      latencyMs,
      error: err ? err.message || String(err) : 'Unknown git merge-tree error',
      degraded: true
    };
  }
}

export default {
  probeGitMergeTree
};
