import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getHomeDir, canonicalizePath } from './paths.mjs';
import { SESSION_RISK_THRESHOLDS } from './constants.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';

/**
 * Phase 0: PrefixCacheShield Transaction Manager
 *
 * Prevents self-inflicted KV prefix-cache busting by intercepting writes to:
 *  - ~/.gemini/GEMINI.md and .gemini/GEMINI.md / .gemini/rules/**\/*.md
 *  - workspace GEMINI.md / AGENTS.md / .antigravityignore / mcp_config.json
 *  - .agents/CONTEXT.md / .agents/rules/**\/*.md / .agents/skills/**\/SKILL.md
 *  - ~/.gemini/antigravity/skills/<skill>/SKILL.md (and antigravity-cli/skills)
 *
 * Strictly excludes CLAUDE.md, .claude/, and .cursorrules per ISS-021.
 */

const FOREIGN_NON_ANTIGRAVITY_RULE_RE = /(^|[\\/])(CLAUDE\.md|\.cursorrules)$|(^|[\\/])\.claude([\\/]|$)/i;

export const PREFIX_CACHE_SHIELD_CONSTANTS = Object.freeze({
  WARM_CACHE_TOKEN_THRESHOLD: SESSION_RISK_THRESHOLDS?.WARM_CACHE_LOCK_TOKENS || 50000,
  PROTECTED_FILE_REGEX:
    /(^|[\\/])(GEMINI\.md|AGENTS\.md|SKILL\.md|\.antigravityignore|mcp_config\.json)$|(^|[\\/])\.gemini[\\/](GEMINI\.md|rules[\\/].+\.md)$|(^|[\\/])\.agents[\\/](CONTEXT\.md|rules[\\/].+\.md|skills[\\/].+[\\/]SKILL\.md)$/i
});

export function getDefaultPendingDeltasPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'pending_rule_deltas.json');
}

export function isProtectedPrefixFile(filePath = '') {
  if (!filePath || typeof filePath !== 'string') return false;
  const trimmed = filePath.trim();
  if (!trimmed) return false;
  if (FOREIGN_NON_ANTIGRAVITY_RULE_RE.test(trimmed)) return false;
  return PREFIX_CACHE_SHIELD_CONSTANTS.PROTECTED_FILE_REGEX.test(trimmed);
}

export function isWarmCacheState(session = {}, warmThreshold = PREFIX_CACHE_SHIELD_CONSTANTS.WARM_CACHE_TOKEN_THRESHOLD) {
  if (!session || typeof session !== 'object') return false;
  if (
    session.forceColdBust === true ||
    session.forceHotCache === true ||
    session.postCompact === true ||
    session.isPostCompact === true
  ) {
    return false;
  }
  if (session.isPreTurn1 === true || (Number(session.turnCount) === 0 && session.forcePreTurn1 === true)) {
    return false;
  }
  const stateStr = String(session.cacheState || '').trim().toUpperCase();
  if (stateStr === 'COLD' || stateStr === 'POST_COMPACT') {
    return false;
  }
  if (session.cacheWarm === true || stateStr === 'WARM' || stateStr === 'WARM_5M' || stateStr === 'WARM_1H') {
    return true;
  }
  const cachedTokens = Number(session.cachedTokens ?? session.cacheReadTokens ?? 0);
  const cacheTtlSeconds = Number(session.cacheTtlSeconds ?? session.ttlRemainingSec ?? session.ttlRemainingSeconds ?? 0);
  return cachedTokens >= warmThreshold && cacheTtlSeconds > 0;
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
  atomicWriteFileSync(targetPath, contentStr, { encoding: 'utf8' });
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
    const targetStr = String(delta.targetText ?? delta.target ?? '').trim();
    const replacementStr = String(delta.replacementText ?? delta.ruleText ?? delta.content ?? delta.newContent ?? '').trim();
    if (targetStr && base.includes(targetStr)) {
      return base.replace(targetStr, () => replacementStr);
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
    this.reflectorQueue = options.reflectorQueue || null;
    this._memoryQueue = null;
  }

  attachReflectorQueue(reflectorQueue) {
    this.reflectorQueue = reflectorQueue || null;
    return this;
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
    return isWarmCacheState(session, this.warmCacheThreshold);
  }

  /**
   * Returns current queue status and UI badge metadata.
   */
  getStatus(session = {}) {
    const deltas = this._loadQueue();
    const reflectorApproved = this.reflectorQueue?.listItems
      ? this.reflectorQueue.listItems({ status: 'approved' }).length
      : 0;
    const totalStaged = deltas.length + reflectorApproved;
    const locked = this.isPrefixLocked(session);
    return {
      locked,
      stagedCount: totalStaged,
      pendingDeltasCount: deltas.length,
      reflectorApprovedCount: reflectorApproved,
      badge: formatStagedBadge(totalStaged),
      queuePath: this.queuePath,
      deltas: [...deltas]
    };
  }

  /**
   * Stages or immediately applies a rule/skill file mutation depending on prefix cache warmth.
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
      targetText: deltaRequest.targetText ?? deltaRequest.target ?? null,
      replacementText: deltaRequest.replacementText ?? null,
      newContent: deltaRequest.newContent ?? deltaRequest.content ?? null,
      source: String(deltaRequest.source || 'coach'),
      metadata: deltaRequest.metadata || {},
      createdAt: deltaRequest.createdAt || new Date().toISOString()
    };

    const existingQueue = this._loadQueue();
    const cacheTtlSeconds = Number(session?.cacheTtlSeconds ?? session?.ttlRemainingSec ?? session?.ttlRemainingSeconds ?? 0);
    const forceColdBust = Boolean(session?.forceColdBust === true || session?.forceHotCache === true);
    const isPreTurn1 = Boolean(
      session?.isPreTurn1 === true || (Number(session?.turnCount) === 0 && session?.forcePreTurn1 === true)
    );
    const locked =
      !forceColdBust &&
      (this.isPrefixLocked(session) || (existingQueue.length > 0 && cacheTtlSeconds > 0 && !isPreTurn1));

    if (locked) {
      existingQueue.push(deltaRecord);
      this._saveQueue(existingQueue);
      return {
        staged: true,
        flushed: false,
        deferred: true,
        locked: true,
        reason: 'CACHE_WARM_FENCE',
        delta: deltaRecord,
        stagedCount: existingQueue.length,
        badge: formatStagedBadge(existingQueue.length),
        queuePath: this.queuePath
      };
    }

    if (existingQueue.length > 0 && (cacheTtlSeconds <= 0 || isPreTurn1 || forceColdBust)) {
      existingQueue.push(deltaRecord);
      this._saveQueue(existingQueue);
      const flushResult = this._flushAllNow(forceColdBust ? 'FORCE_COLD_BUST' : 'COLD_OR_PRE_TURN_1');
      return {
        staged: false,
        flushed: true,
        deferred: false,
        locked: false,
        delta: deltaRecord,
        flushedCount: flushResult.flushedCount,
        modifiedFiles: flushResult.modifiedFiles,
        stagedCount: 0,
        badge: ''
      };
    }

    const existingText = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    const nextContent = applyRuleDeltaToContent(existingText, deltaRecord);
    writeAtomicSync(targetPath, nextContent);
    return {
      staged: false,
      flushed: true,
      deferred: false,
      locked: false,
      delta: deltaRecord,
      flushedCount: 1,
      modifiedFiles: [targetPath],
      stagedCount: existingQueue.length,
      badge: formatStagedBadge(existingQueue.length)
    };
  }

  /**
   * Flushes staged deltas only if the prefix lock has expired (`cacheTtlSeconds === 0`,
   * `cacheState === 'COLD'`, `postCompact === true`, or `force === true`).
   */
  flushIfEligible(session = {}) {
    const forceFlush = Boolean(session?.force === true || session?.forceColdBust === true);
    const postCompact = Boolean(session?.postCompact === true || session?.isPostCompact === true);
    const cacheTtlSeconds = Number(session?.cacheTtlSeconds ?? session?.ttlRemainingSec ?? session?.ttlRemainingSeconds ?? 0);
    const isPreTurn1 = Boolean(
      session?.isPreTurn1 === true || (Number(session?.turnCount) === 0 && session?.forcePreTurn1 === true)
    );

    if (!forceFlush && !postCompact && (this.isPrefixLocked(session) || (cacheTtlSeconds > 0 && !isPreTurn1))) {
      const status = this.getStatus(session);
      return {
        flushed: false,
        deferred: true,
        reason: 'CACHE_WARM_FENCE',
        stagedCount: status.stagedCount,
        queuedCount: status.stagedCount,
        badge: status.badge,
        modifiedFiles: []
      };
    }
    return this._flushAllNow(forceFlush ? 'FORCE_FLUSH' : (postCompact ? 'POST_COMPACT' : 'TTL_EXPIRED_OR_ELIGIBLE'));
  }

  /**
   * Explicitly flushes all queued rule/skill deltas during a `/handoff` baton pass
   * or `PostCompact` lifecycle boundary.
   */
  flushOnHandoff() {
    return this._flushAllNow('EXPLICIT_HANDOFF');
  }

  flushOnPostCompact() {
    return this._flushAllNow('POST_COMPACT');
  }

  _flushAllNow(reason = 'MANUAL') {
    const queue = this._loadQueue();
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

    if (queue.length > 0) {
      this._saveQueue([]);
    }

    // Bridge: flush approved ReflectorQueue items together when cold / PostCompact / handoff
    if (this.reflectorQueue && typeof this.reflectorQueue.flushApprovedWhenCold === 'function') {
      try {
        const rqRes = this.reflectorQueue.flushApprovedWhenCold({
          isCacheWarm: false,
          cacheTtlSeconds: 0,
          cachedTokens: 0,
          bypassShield: true
        });
        if (rqRes && rqRes.flushedCount > 0) {
          flushedCount += rqRes.flushedCount;
          for (const f of rqRes.flushedItems || []) {
            if (f?.targetPath) modifiedFilesSet.add(f.targetPath);
          }
        }
      } catch {}
    }

    return {
      flushed: true,
      deferred: false,
      reason,
      flushedCount,
      stagedCount: 0,
      queuedCount: 0,
      badge: '',
      modifiedFiles: Array.from(modifiedFilesSet)
    };
  }
}

export default PrefixCacheShield;
