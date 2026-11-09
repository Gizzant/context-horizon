import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getHomeDir, canonicalizePath } from './paths.mjs';
import { SESSION_RISK_THRESHOLDS } from './constants.mjs';

/**
 * Phase 0: PrefixCacheShield Transaction Manager
 *
 * Prevents self-inflicted KV prefix-cache busting by intercepting writes to:
 *  - ~/.gemini/GEMINI.md (global rules)
 *  - workspace GEMINI.md / AGENTS.md / .agents/CONTEXT.md / CLAUDE.md
 *  - ~/.gemini/antigravity/skills/<skill>/SKILL.md (and .agents/skills / antigravity-cli/skills)
 *
 * Rule: While `session.cachedTokens >= 50000 && session.cacheTtlSeconds > 0` (and not pre-Turn-1),
 * any rule/skill mutation is queued in `~/.gemini/antigravity/agy-horizon/pending_rule_deltas.json`
 * without touching the target file on disk. Queued deltas flush immediately when:
 *  1. `cacheTtlSeconds === 0`
 *  2. Before Turn 1 of a new session (`turnCount === 0` or `isPreTurn1 === true`)
 *  3. During an explicit `/handoff` baton pass (`flushOnHandoff()`)
 */

export const PREFIX_CACHE_SHIELD_CONSTANTS = Object.freeze({
  WARM_CACHE_TOKEN_THRESHOLD: SESSION_RISK_THRESHOLDS?.WARM_CACHE_LOCK_TOKENS || 50000,
  PROTECTED_FILE_REGEX: /(^|[\\/])(GEMINI\.md|AGENTS\.md|CLAUDE\.md|SKILL\.md)$|[\\/]\.agents[\\/](CONTEXT\.md|rules[\\/][^\\/]+\.md)$/i
});

export function getDefaultPendingDeltasPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'pending_rule_deltas.json');
}

export function isProtectedPrefixFile(filePath = '') {
  if (!filePath || typeof filePath !== 'string') return false;
  return PREFIX_CACHE_SHIELD_CONSTANTS.PROTECTED_FILE_REGEX.test(filePath.trim());
}

export function formatStagedBadge(stagedCount = 0) {
  const n = Math.max(0, Number(stagedCount) || 0);
  if (n === 0) return '';
  if (n === 1) {
    return '⏳ 1 Rule Update Staged (Waiting for Cache TTL expiry to prevent Prefix Bust)';
  }
  return `⏳ ${n} Rule Updates Staged (Waiting for Cache TTL expiry to prevent Prefix Bust)`;
}

function writeAtomicSync(targetPath, contentStr) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, contentStr, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Applies a single delta operation ('ADD' | 'MODIFY' | 'REMOVE' | 'REPLACE' | 'REORDER')
 * to the existing text content of a rule or skill file.
 */
export function applyRuleDeltaToContent(existingText = '', delta = {}) {
  const op = String(delta.operation || delta.op || 'ADD').toUpperCase();
  const base = String(existingText || '');

  if (op === 'REPLACE' || op === 'REORDER') {
    return String(delta.newContent ?? delta.content ?? base);
  }

  if (op === 'REMOVE') {
    const targetStr = String(delta.targetText || delta.ruleText || delta.content || '').trim();
    if (!targetStr) return base;
    const lines = base.split(/\r?\n/);
    const filtered = lines.filter(line => line.trim() !== targetStr && !line.includes(targetStr));
    return filtered.join('\n');
  }

  if (op === 'MODIFY') {
    const targetStr = String(delta.targetText || '').trim();
    const replacementStr = String(delta.replacementText ?? delta.ruleText ?? delta.content ?? '').trim();
    if (targetStr && base.includes(targetStr)) {
      return base.replace(targetStr, replacementStr);
    }
    return base ? `${base.replace(/\s+$/, '')}\n${replacementStr}\n` : `${replacementStr}\n`;
  }

  // Default: 'ADD'
  const addition = String(delta.ruleText ?? delta.content ?? delta.newContent ?? '').trim();
  if (!addition) return base;
  if (base.includes(addition)) return base;

  if (!base.trim()) {
    return `${addition}\n`;
  }
  return `${base.replace(/\s+$/, '')}\n${addition}\n`;
}

export class PrefixCacheShield {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.queuePath = options.queuePath || getDefaultPendingDeltasPath(this.homeDir);
    this.warmCacheThreshold = Number.isFinite(options.warmCacheThreshold)
      ? options.warmCacheThreshold
      : PREFIX_CACHE_SHIELD_CONSTANTS.WARM_CACHE_TOKEN_THRESHOLD;
    this._memoryQueue = null;
  }

  _loadQueue() {
    if (Array.isArray(this._memoryQueue) && fs.existsSync(this.queuePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
        if (Array.isArray(parsed.deltas)) {
          this._memoryQueue = parsed.deltas;
          return this._memoryQueue;
        }
      } catch {}
    }
    if (fs.existsSync(this.queuePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
        this._memoryQueue = Array.isArray(parsed?.deltas) ? parsed.deltas : [];
        return this._memoryQueue;
      } catch {}
    }
    this._memoryQueue = [];
    return this._memoryQueue;
  }

  _saveQueue(deltas = []) {
    this._memoryQueue = Array.isArray(deltas) ? deltas : [];
    const payload = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      stagedCount: this._memoryQueue.length,
      badge: formatStagedBadge(this._memoryQueue.length),
      deltas: this._memoryQueue
    };
    writeAtomicSync(this.queuePath, JSON.stringify(payload, null, 2) + '\n');
  }

  /**
   * Determines whether the session's prefix cache is currently warm and locked.
   */
  isPrefixLocked(session = {}) {
    if (!session || typeof session !== 'object') return false;
    if (session.isPreTurn1 === true || Number(session.turnCount) === 0 && session.forcePreTurn1 === true) {
      return false;
    }
    const cachedTokens = Number(session.cachedTokens ?? session.cacheReadTokens ?? 0);
    const cacheTtlSeconds = Number(session.cacheTtlSeconds ?? session.ttlRemainingSec ?? 0);
    return cachedTokens >= this.warmCacheThreshold && cacheTtlSeconds > 0;
  }

  /**
   * Returns current queue status and UI badge metadata.
   */
  getStatus(session = {}) {
    const deltas = this._loadQueue();
    const locked = this.isPrefixLocked(session);
    return {
      locked,
      stagedCount: deltas.length,
      badge: formatStagedBadge(deltas.length),
      queuePath: this.queuePath,
      deltas: [...deltas]
    };
  }

  /**
   * Stages or immediately applies a rule/skill file mutation depending on prefix cache warmth.
   *
   * @param {object} deltaRequest
   * @param {string} deltaRequest.targetPath - Path to GEMINI.md, AGENTS.md, .agents/CONTEXT.md, or SKILL.md
   * @param {string} [deltaRequest.operation='ADD'] - 'ADD' | 'MODIFY' | 'REMOVE' | 'REPLACE' | 'REORDER'
   * @param {string} [deltaRequest.ruleText] - Directive or content to add/modify
   * @param {string} [deltaRequest.newContent] - Full replacement content for REPLACE / REORDER
   * @param {string} [deltaRequest.targetText] - Target substring for MODIFY / REMOVE
   * @param {string} [deltaRequest.source='coach'] - Origin subsystem (e.g. 'rsi', 'u-curve', 'manual')
   * @param {object} [session={}] - { cachedTokens, cacheTtlSeconds, turnCount, isPreTurn1 }
   */
  stageOrApplyDelta(deltaRequest = {}, session = {}) {
    const targetPath = path.resolve(String(deltaRequest.targetPath || ''));
    if (!targetPath) {
      throw new Error('PrefixCacheShield: targetPath is required');
    }

    const deltaRecord = {
      id: deltaRequest.id || `delta-${crypto.randomBytes(6).toString('hex')}`,
      targetPath,
      canonicalTargetPath: canonicalizePath(targetPath),
      operation: String(deltaRequest.operation || 'ADD').toUpperCase(),
      ruleText: deltaRequest.ruleText ?? null,
      targetText: deltaRequest.targetText ?? null,
      replacementText: deltaRequest.replacementText ?? null,
      newContent: deltaRequest.newContent ?? deltaRequest.content ?? null,
      source: String(deltaRequest.source || 'coach'),
      metadata: deltaRequest.metadata || {},
      createdAt: deltaRequest.createdAt || new Date().toISOString()
    };

    const locked = this.isPrefixLocked(session);

    if (locked) {
      const queue = this._loadQueue();
      queue.push(deltaRecord);
      this._saveQueue(queue);
      return {
        staged: true,
        flushed: false,
        locked: true,
        delta: deltaRecord,
        stagedCount: queue.length,
        badge: formatStagedBadge(queue.length),
        queuePath: this.queuePath
      };
    }

    // Prefix cache is cold (TTL === 0), below 50k threshold, or pre-Turn 1 -> flush immediately
    const queue = this._loadQueue();
    queue.push(deltaRecord);
    this._saveQueue(queue);
    const flushResult = this._flushAllNow('COLD_OR_PRE_TURN_1');
    return {
      staged: false,
      flushed: true,
      locked: false,
      delta: deltaRecord,
      flushedCount: flushResult.flushedCount,
      modifiedFiles: flushResult.modifiedFiles,
      stagedCount: 0,
      badge: ''
    };
  }

  /**
   * Flushes staged deltas only if the prefix lock has expired (`cacheTtlSeconds === 0`
   * or `cachedTokens < 50000` or pre-Turn 1).
   */
  flushIfEligible(session = {}) {
    if (this.isPrefixLocked(session)) {
      const deltas = this._loadQueue();
      return {
        flushed: false,
        reason: 'PREFIX_CACHE_LOCKED',
        stagedCount: deltas.length,
        badge: formatStagedBadge(deltas.length),
        modifiedFiles: []
      };
    }
    return this._flushAllNow('TTL_EXPIRED_OR_ELIGIBLE');
  }

  /**
   * Explicitly flushes all queued rule/skill deltas during a `/handoff` baton pass
   * or new session initialization.
   */
  flushOnHandoff() {
    return this._flushAllNow('EXPLICIT_HANDOFF');
  }

  _flushAllNow(reason = 'MANUAL') {
    const queue = this._loadQueue();
    if (queue.length === 0) {
      return {
        flushed: true,
        reason,
        flushedCount: 0,
        stagedCount: 0,
        badge: '',
        modifiedFiles: []
      };
    }

    const modifiedFilesSet = new Set();
    let flushedCount = 0;

    for (const delta of queue) {
      const filePath = delta.targetPath;
      if (!filePath) continue;
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      const nextContent = applyRuleDeltaToContent(existing, delta);
      writeAtomicSync(filePath, nextContent);
      modifiedFilesSet.add(filePath);
      flushedCount++;
    }

    this._saveQueue([]);
    return {
      flushed: true,
      reason,
      flushedCount,
      stagedCount: 0,
      badge: '',
      modifiedFiles: Array.from(modifiedFilesSet)
    };
  }
}

export default PrefixCacheShield;
