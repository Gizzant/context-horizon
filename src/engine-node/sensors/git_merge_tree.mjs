/**
 * @file src/engine-node/sensors/git_merge_tree.mjs
 * Non-destructive DET-31 Cross-Worktree Git Merge Conflict Sensor.
 *
 * Runs `git merge-tree --write-tree` with 0 working-tree or index mutations,
 * and caches clean/conflict results per (workspaceDir, baseCommit, targetCommit, .git/index mtime, .git/HEAD mtime)
 * so polling loops on win32 run in <0.05ms without repeated 35ms subprocess spawns.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MERGE_TREE_CACHE = new Map();
const MAX_CACHE_ENTRIES = 128;

function resolveGitStateStamp(cwd) {
  try {
    const gitDir = path.join(cwd, '.git');
    const stGit = fs.statSync(gitDir);
    if (!stGit.isDirectory() && !stGit.isFile()) return null;
    let indexMtime = 0;
    let headMtime = 0;
    let refsMtime = 0;
    try { indexMtime = fs.statSync(path.join(gitDir, 'index')).mtimeMs; } catch {}
    try { headMtime = fs.statSync(path.join(gitDir, 'HEAD')).mtimeMs; } catch {}
    try { refsMtime = fs.statSync(path.join(gitDir, 'refs', 'heads')).mtimeMs; } catch {}
    return `${indexMtime}:${headMtime}:${refsMtime}`;
  } catch {
    return null;
  }
}

export function clearGitMergeTreeCache() {
  MERGE_TREE_CACHE.clear();
}

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

let cachedGitVersion;

/**
 * Returns the installed git version as [major, minor] or null when git is missing/unparseable.
 * Cached for the process lifetime (git does not change under a running hook).
 */
export function getGitVersion() {
  if (cachedGitVersion !== undefined) return cachedGitVersion;
  try {
    const out = execFileSync('git', ['--version'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const m = /(\d+)\.(\d+)/.exec(out);
    cachedGitVersion = m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    cachedGitVersion = null;
  }
  return cachedGitVersion;
}

/** `git merge-tree --write-tree` exists only in git >= 2.38. */
export function gitSupportsMergeTreeWriteTree() {
  const v = getGitVersion();
  return Boolean(v && (v[0] > 2 || (v[0] === 2 && v[1] >= 38)));
}

/** Test helper: forget the cached git version. */
export function resetGitVersionCache() {
  cachedGitVersion = undefined;
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
 * @param {boolean} [options.bypassCache=false] - Force fresh git subprocess execution
 * @returns {{
 *   clean: boolean,
 *   hasConflict: boolean,
 *   treeHash: string | null,
 *   conflictFiles: string[],
 *   conflictMessages: string[],
 *   latencyMs: number,
 *   cached?: boolean,
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
  const gitStamp = !options.bypassCache ? resolveGitStateStamp(cwd) : null;
  const cacheKey = gitStamp
    ? `${cwd}|${baseCommit}|${targetCommit}|${Boolean(options.nameOnly)}|${gitStamp}`
    : null;

  if (cacheKey && MERGE_TREE_CACHE.has(cacheKey)) {
    const cachedEntry = MERGE_TREE_CACHE.get(cacheKey);
    const latencyMs = Number((performance.now() - start).toFixed(4));
    return {
      ...cachedEntry,
      conflictFiles: [...cachedEntry.conflictFiles],
      conflictMessages: [...cachedEntry.conflictMessages],
      latencyMs,
      cached: true
    };
  }

  if (!options.skipVersionCheck && !gitSupportsMergeTreeWriteTree()) {
    const v = getGitVersion();
    return {
      clean: false,
      hasConflict: false,
      treeHash: null,
      conflictFiles: [],
      conflictMessages: [],
      latencyMs: Number((performance.now() - start).toFixed(3)),
      error: v
        ? `GIT_TOO_OLD: merge-conflict probe needs git >= 2.38 (found ${v[0]}.${v[1]})`
        : 'GIT_NOT_FOUND: merge-conflict probe needs git >= 2.38',
      degraded: true
    };
  }

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

    const result = {
      clean: true,
      hasConflict: false,
      treeHash,
      conflictFiles: [],
      conflictMessages: [],
      latencyMs
    };
    if (cacheKey) {
      if (MERGE_TREE_CACHE.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = MERGE_TREE_CACHE.keys().next().value;
        MERGE_TREE_CACHE.delete(oldestKey);
      }
      MERGE_TREE_CACHE.set(cacheKey, result);
    }
    return result;
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

      const conflictResult = {
        clean: false,
        hasConflict: hasRealConflict,
        treeHash,
        conflictFiles: parsed.conflictFiles,
        conflictMessages: parsed.conflictMessages,
        latencyMs,
        ...(hasRealConflict ? {} : { error: stderr.trim() || 'Merge probe failed', degraded: true })
      };
      if (cacheKey && hasRealConflict) {
        MERGE_TREE_CACHE.set(cacheKey, conflictResult);
      }
      return conflictResult;
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
  probeGitMergeTree,
  getGitVersion,
  gitSupportsMergeTreeWriteTree,
  clearGitMergeTreeCache
};
