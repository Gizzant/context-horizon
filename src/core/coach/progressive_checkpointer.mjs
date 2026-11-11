import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { atomicWriteFileSync } from '../atomic_io.mjs';

/**
 * Phase 1.1: Progressive Checkpoint & Session Continuity Sync (`DET-10`)
 * (`src/core/coach/progressive_checkpointer.mjs`)
 *
 * Prevents Negative Constraint Evaporation and context amnesia across unexpected
 * automatic compactions (50k-70k soft watermark) or deep fill bands:
 *  - Takes zero-token out-of-band disk snapshots at 20%, 35%, 50%, 65%, and 80%
 *    fill bands, plus at the 50,000-token soft watermark.
 *  - Writes strictly to `.agents/cache/checkpoints/` without touching `AGENTS.md`,
 *    `GEMINI.md`, or `.agents/CONTEXT.md` (preserving 100% KV prefix cache hits).
 *  - Detects evaporated negative constraints (`NEVER`, `MUST`, `DO NOT`, `NON-NEGOTIABLE`)
 *    and lost `[/]` active task steps immediately after `/compact`, generating a
 *    1-click recovery prompt.
 */

export const CHECKPOINT_BANDS = Object.freeze([0.20, 0.35, 0.50, 0.65, 0.80]);
export const SOFT_WATERMARK_TOKENS = 50000;
export const DEFAULT_MAX_TOKENS = 256000;

const NEGATIVE_CONSTRAINT_REGEX = /\b(NEVER|MUST\s+NOT|MUST|DO\s+NOT|DON'T|NON-NEGOTIABLE|STRICTLY\s+FORBIDDEN)\b/i;

export function sha256Text(text = '') {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * Extracts critical negative constraints and invariant directives from rule files,
 * `task.md`, or user turns.
 */
export function extractNegativeConstraints(sources = []) {
  const list = Array.isArray(sources) ? sources : [sources];
  const seen = new Set();
  const constraints = [];

  for (const src of list) {
    if (!src) continue;
    const lines = String(src).split(/\r?\n/);
    for (const rawLine of lines) {
      const cleaned = rawLine
        .replace(/^\s*[-*+]\s*(\[[ xX/]\]\s*)?/, '')
        .replace(/^\s*\d+\.\s*/, '')
        .trim();
      if (!cleaned || cleaned.length < 10 || cleaned.length > 260) continue;
      if (cleaned.startsWith('#') || cleaned.startsWith('```') || cleaned.startsWith('//')) continue;
      if (NEGATIVE_CONSTRAINT_REGEX.test(cleaned)) {
        const normKey = cleaned.toLowerCase().replace(/\s+/g, ' ');
        if (!seen.has(normKey)) {
          seen.add(normKey);
          constraints.push(cleaned);
        }
      }
    }
  }

  return constraints;
}

/**
 * Parses `task.md` content into `completed` (`[x]`), `inProgress` (`[/]`), and `pending` (`[ ]`) arrays.
 */
export function parseTaskMdChecklist(taskMdContent = '') {
  const completed = [];
  const inProgress = [];
  const pending = [];

  const lines = String(taskMdContent || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const match = rawLine.match(/^\s*[-*+]\s*\[([ xX/])\]\s*(.+)$/);
    if (!match) continue;
    const marker = match[1].toLowerCase();
    const itemText = match[2].trim();
    if (!itemText) continue;
    if (marker === 'x') {
      completed.push(itemText);
    } else if (marker === '/') {
      inProgress.push(itemText);
    } else {
      pending.push(itemText);
    }
  }

  return { completed, inProgress, pending };
}

function tryCaptureGitDiffStat(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return '';
  try {
    return execFileSync('git', ['diff', '--stat'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500
    }).trim();
  } catch {
    return '';
  }
}

export class ProgressiveCheckpointer {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.checkpointDir =
      options.checkpointDir ||
      path.join(this.workspaceDir, '.agents', 'cache', 'checkpoints');
    this.maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : DEFAULT_MAX_TOKENS;
    this.captureGitStat = options.captureGitStat !== false;
    this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
    // sessionId -> Set<string> of crossed band labels ('20%', '35%', '50k_watermark', etc.)
    this.recordedBandsBySession = new Map();
    // sessionId -> Array<checkpointObj>
    this.checkpointsBySession = new Map();
  }

  _getSessionBands(sessionId) {
    const key = String(sessionId || 'default-session');
    if (!this.recordedBandsBySession.has(key)) {
      this.recordedBandsBySession.set(key, new Set());
    }
    return this.recordedBandsBySession.get(key);
  }

  _getSessionCheckpoints(sessionId) {
    const key = String(sessionId || 'default-session');
    if (!this.checkpointsBySession.has(key)) {
      this.checkpointsBySession.set(key, []);
    }
    return this.checkpointsBySession.get(key);
  }

  /**
   * Evaluates current token usage against the 50k soft watermark and 20%/35%/50%/65%/80%
   * fill bands. Takes a zero-token disk snapshot when crossing any new band.
   */
  evaluateAndSnapshot(input = {}) {
    const startMs = performance.now();
    const sessionId = String(input.sessionId || 'default-session');
    const totalTokens = Math.max(0, Number(input.totalTokens ?? input.contextTokens ?? 0));
    const maxTokens = Number(input.maxTokens) > 0 ? Number(input.maxTokens) : this.maxTokens;
    const fillRatio = maxTokens > 0 ? totalTokens / maxTokens : 0;

    const crossedBands = this._getSessionBands(sessionId);
    const newlyTriggeredBands = [];

    // 1. Check 50,000-token soft compaction watermark
    if (totalTokens >= SOFT_WATERMARK_TOKENS && !crossedBands.has('50k_watermark')) {
      newlyTriggeredBands.push('50k_watermark');
    }

    // 2. Check percentage fill bands (20%, 35%, 50%, 65%, 80%)
    for (const band of CHECKPOINT_BANDS) {
      const label = `${Math.round(band * 100)}%`;
      if (fillRatio >= band && !crossedBands.has(label)) {
        newlyTriggeredBands.push(label);
      }
    }

    if (newlyTriggeredBands.length === 0 && !input.forceSnapshot) {
      const latest = this.getLatestCheckpoint(sessionId);
      return {
        snapshotted: false,
        sessionId,
        totalTokens,
        fillRatio: Number(fillRatio.toFixed(4)),
        crossedBands: Array.from(crossedBands),
        latestCheckpoint: latest,
        elapsedMs: Number((performance.now() - startMs).toFixed(3))
      };
    }

    const primaryBandLabel =
      newlyTriggeredBands[newlyTriggeredBands.length - 1] ||
      `manual_${Math.round(fillRatio * 100)}%`;

    for (const b of newlyTriggeredBands) {
      crossedBands.add(b);
    }

    // Resolve task.md content if path provided
    let taskMdContent = String(input.taskMdContent || '');
    if (!taskMdContent && input.taskMdPath && fs.existsSync(input.taskMdPath)) {
      try {
        taskMdContent = fs.readFileSync(input.taskMdPath, 'utf8');
      } catch {}
    }

    const taskChecklist = parseTaskMdChecklist(taskMdContent);

    // Extract negative constraints from provided sources
    const constraintSources = [
      ...(Array.isArray(input.userConstraints) ? input.userConstraints : [input.userConstraints]),
      input.agentsMdContent || '',
      taskMdContent,
      ...(Array.isArray(input.userMessages) ? input.userMessages : [])
    ];
    const negativeConstraints = extractNegativeConstraints(constraintSources);

    // Hash modified files if provided
    const modifiedFiles = (Array.isArray(input.modifiedFiles) ? input.modifiedFiles : []).map((item) => {
      if (typeof item === 'string') {
        let hash = null;
        if (fs.existsSync(item)) {
          try {
            hash = sha256Text(fs.readFileSync(item, 'utf8'));
          } catch {}
        }
        return { path: item, sha256: hash };
      }
      return {
        path: String(item.path || item.filePath || ''),
        sha256: item.sha256 || (item.content !== undefined ? sha256Text(item.content) : null)
      };
    });

    const gitDiffStat =
      input.gitDiffStat !== undefined
        ? String(input.gitDiffStat)
        : this.captureGitStat
        ? tryCaptureGitDiffStat(this.workspaceDir)
        : '';

    const nowMs = this.nowFn();
    const createdAt = new Date(nowMs).toISOString();
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36);
    const safeBand = primaryBandLabel.replace(/[^a-zA-Z0-9_-]/g, 'pct');
    const fileName = `checkpoint_${safeSession}_${safeBand}.json`;
    const filePath = path.join(this.checkpointDir, fileName);

    const checkpoint = {
      id: `ckpt-${safeSession}-${safeBand}-${nowMs}`,
      detectorId: 'DET-25',
      sessionId,
      bandLabel: primaryBandLabel,
      triggeredBands: newlyTriggeredBands.length > 0 ? newlyTriggeredBands : [primaryBandLabel],
      totalTokens,
      maxTokens,
      fillRatio: Number(fillRatio.toFixed(4)),
      taskChecklist,
      negativeConstraints,
      modifiedFiles,
      gitDiffStat,
      filePath,
      createdAt,
      zeroTokenOverhead: true
    };

    if (input.writeToDisk !== false) {
      atomicWriteFileSync(filePath, JSON.stringify(checkpoint, null, 2) + '\n', { encoding: 'utf8' });
    }

    const sessionList = this._getSessionCheckpoints(sessionId);
    sessionList.push(checkpoint);

    return {
      snapshotted: true,
      sessionId,
      bandLabel: primaryBandLabel,
      triggeredBands: checkpoint.triggeredBands,
      totalTokens,
      fillRatio: checkpoint.fillRatio,
      crossedBands: Array.from(crossedBands),
      checkpoint,
      latestCheckpoint: checkpoint,
      elapsedMs: Number((performance.now() - startMs).toFixed(3))
    };
  }

  getLatestCheckpoint(sessionId = 'default-session') {
    const list = this._getSessionCheckpoints(sessionId);
    if (list.length > 0) {
      return list[list.length - 1];
    }
    // Check disk fallback if checkpointDir has matching files
    if (!fs.existsSync(this.checkpointDir)) return null;
    const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36);
    try {
      const files = fs
        .readdirSync(this.checkpointDir)
        .filter((f) => f.startsWith(`checkpoint_${safeSession}_`) && f.endsWith('.json'))
        .map((f) => path.join(this.checkpointDir, f));
      if (files.length === 0) return null;
      files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const parsed = JSON.parse(fs.readFileSync(files[0], 'utf8'));
      list.push(parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  listCheckpoints(sessionId = 'default-session') {
    return [...this._getSessionCheckpoints(sessionId)];
  }

  /**
   * Compares a post-compaction `<CONTEXT_SUMMARY>` (or active context text) against
   * the latest disk checkpoint for `sessionId` to detect Negative Constraint Evaporation
   * or lost active (`[/]`) task items.
   */
  detectConstraintEvaporation(compactedSummaryText = '', sessionId = 'default-session', explicitCheckpoint = null) {
    const latest = explicitCheckpoint || this.getLatestCheckpoint(sessionId);
    if (!latest) {
      return {
        evaporated: false,
        missingConstraints: [],
        missingActiveTasks: [],
        preservedConstraintsCount: 0,
        recoveryPrompt: '',
        latestCheckpoint: null
      };
    }

    const normSummary = String(compactedSummaryText || '').toLowerCase().replace(/\s+/g, ' ');
    const missingConstraints = [];
    let preservedConstraintsCount = 0;

    for (const constraint of latest.negativeConstraints || []) {
      const normConstraint = String(constraint).toLowerCase().replace(/\s+/g, ' ');
      // Check either full substring or significant tokens (>= 60% of words >= 4 chars)
      if (normSummary.includes(normConstraint)) {
        preservedConstraintsCount++;
        continue;
      }
      const stopWords = new Set([
        'never', 'must', 'always', 'strictly', 'forbidden', 'when', 'with',
        'from', 'that', 'this', 'render', 'preserve', 'across', 'button',
        'clickable', 'make', 'keep', 'ensure', 'into', 'only'
      ]);
      const summaryAlpha = normSummary.replace(/[^a-z0-9\s]/g, ' ');
      const keyWords = normConstraint
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !stopWords.has(w));

      if (keyWords.length > 0) {
        const matchedWords = keyWords.filter((w) => summaryAlpha.includes(w));
        if (matchedWords.length / keyWords.length >= 0.5) {
          preservedConstraintsCount++;
          continue;
        }
      }
      missingConstraints.push(constraint);
    }

    const missingActiveTasks = [];
    for (const activeItem of latest.taskChecklist?.inProgress || []) {
      const normTask = String(activeItem).toLowerCase().replace(/\s+/g, ' ');
      const taskWords = normTask
        .replace(/[^a-z0-9\s/_-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      if (taskWords.length === 0) continue;
      const matched = taskWords.filter((w) => normSummary.includes(w));
      if (matched.length / taskWords.length < 0.6) {
        missingActiveTasks.push(activeItem);
      }
    }

    const evaporated = missingConstraints.length > 0 || missingActiveTasks.length > 0;
    let recoveryPrompt = '';

    if (evaporated) {
      const lines = [
        `[Checkpoint Continuity Sync (${latest.bandLabel} snapshot)]: Please restore the following active session constraints and in-progress tasks that were truncated during compaction:`
      ];
      if (missingActiveTasks.length > 0) {
        lines.push('Active In-Progress Task (`[/]`):');
        for (const t of missingActiveTasks) {
          lines.push(`- [/] ${t}`);
        }
      }
      if (missingConstraints.length > 0) {
        lines.push('Mandatory Invariants:');
        for (const c of missingConstraints) {
          lines.push(`- ${c}`);
        }
      }
      recoveryPrompt = lines.join('\n');
    }

    return {
      evaporated,
      detectorId: 'DET-25',
      bandLabel: latest.bandLabel,
      missingConstraints,
      missingActiveTasks,
      preservedConstraintsCount,
      recoveryPrompt,
      latestCheckpoint: latest
    };
  }
}

export default ProgressiveCheckpointer;
