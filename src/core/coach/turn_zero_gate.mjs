import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWriteFileSync } from '../atomic_io.mjs';

/**
 * Phase 4.1: Turn-0 Workspace Hygiene & MCP Profile Gate (`src/core/coach/turn_zero_gate.mjs`)
 *
 * Enforces Invariant 1 (Zero Mid-Session Prefix Mutation):
 *  - Never modifies `AGENTS.md`, `.agents/CONTEXT.md`, or active MCP server schemas while a
 *    session KV cache is warm (`cachedTokens >= 15000` and `ttlRemainingSeconds > 0`).
 *  - Queues all system-prefix hygiene changes in `TurnZeroGate` until Turn 0 (cold session) or `/handoff`.
 *  - Scans `AGENTS.md` and `.agents/CONTEXT.md` for U-shaped attention placement, moving
 *    `NEVER`, `MUST`, `NON-NEGOTIABLE` rules out of the 30%–70% middle trough into the
 *    top 25% Primacy and bottom 20% Recency bands.
 *  - Provides 1-click Pre-Session MCP Profiles (`Lean Code`, `UI/Frontend`, `Full Stack`)
 *    to dampen unused MCP JSON schemas before Turn 1 warms the cache.
 */

export const TURN_ZERO_GATE_CONSTANTS = Object.freeze({
  WARM_CACHE_LOCK_TOKENS: 15000,
  PRIMACY_BAND_END: 0.25,
  MIDDLE_TROUGH_START: 0.30,
  MIDDLE_TROUGH_END: 0.70,
  RECENCY_BAND_START: 0.80,
  CRITICAL_RULE_REGEX: /\b(NEVER|MUST|NON-NEGOTIABLE)\b/i,
  FENCED_BLOCK_TTL_MS: 48 * 60 * 60 * 1000,
  MAX_RECOMMENDED_RULE_LINES: 200
});

export const MCP_PROFILES = Object.freeze({
  'Lean Code': Object.freeze({
    id: 'lean_code',
    label: 'Lean Code',
    description: 'Core filesystem & terminal only; dampens browser, design, and cloud MCP schemas.',
    enabledServers: ['filesystem', 'git'],
    dampenedServers: ['chrome-devtools', 'figma', 'shadcn-ui', 'notebooklm', 'playwright'],
    estimatedSavedTokens: 14800
  }),
  'UI/Frontend': Object.freeze({
    id: 'ui_frontend',
    label: 'UI/Frontend',
    description: 'Enables Chrome DevTools, Figma, and shadcn-ui; dampens backend/database MCP schemas.',
    enabledServers: ['chrome-devtools', 'figma', 'shadcn-ui'],
    dampenedServers: ['notebooklm', 'postgres', 'databricks', 'looker'],
    estimatedSavedTokens: 8400
  }),
  'Full Stack': Object.freeze({
    id: 'full_stack',
    label: 'Full Stack',
    description: 'Enables full frontend, browser, and knowledge MCP servers for cross-stack debugging.',
    enabledServers: ['chrome-devtools', 'figma', 'shadcn-ui', 'google-developer-knowledge', 'notebooklm'],
    dampenedServers: [],
    estimatedSavedTokens: 0
  })
});

export function isCriticalDirective(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) return false;
  return TURN_ZERO_GATE_CONSTANTS.CRITICAL_RULE_REGEX.test(trimmed);
}

/**
 * Scans rule file content (`AGENTS.md` or `.agents/CONTEXT.md`) and relocates critical
 * `NEVER`, `MUST`, `NON-NEGOTIABLE` rules out of the 30%–70% middle trough into the
 * top 25% Primacy and bottom 20% Recency bands.
 */
export function optimizeUShapedRulePlacement(rawContent = '') {
  const startMs = performance.now();
  const lines = String(rawContent || '').split(/\r?\n/);
  const totalLines = lines.length;
  if (totalLines < 4) {
    return {
      reordered: false,
      strandedCount: 0,
      strandedRules: [],
      primacyInsertedCount: 0,
      recencyInsertedCount: 0,
      optimizedContent: String(rawContent || ''),
      elapsedMs: Number((performance.now() - startMs).toFixed(3))
    };
  }

  const troughStartIdx = Math.floor(totalLines * TURN_ZERO_GATE_CONSTANTS.MIDDLE_TROUGH_START);
  const troughEndIdx = Math.ceil(totalLines * TURN_ZERO_GATE_CONSTANTS.MIDDLE_TROUGH_END);

  const strandedRules = [];
  const keptLines = [];

  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    const inTrough = i >= troughStartIdx && i <= troughEndIdx;
    if (inTrough && isCriticalDirective(line)) {
      strandedRules.push({
        originalLineNumber: i + 1,
        positionRatio: Number((i / Math.max(1, totalLines - 1)).toFixed(3)),
        text: line
      });
    } else {
      keptLines.push(line);
    }
  }

  if (strandedRules.length === 0) {
    return {
      reordered: false,
      strandedCount: 0,
      strandedRules: [],
      primacyInsertedCount: 0,
      recencyInsertedCount: 0,
      optimizedContent: String(rawContent || ''),
      elapsedMs: Number((performance.now() - startMs).toFixed(3))
    };
  }

  // Split rescued rules between Top 25% Primacy band and Bottom 20% Recency band
  const half = Math.ceil(strandedRules.length / 2);
  const primacyBatch = strandedRules.slice(0, half).map((r) => r.text);
  const recencyBatch = strandedRules.slice(half).map((r) => r.text);

  // Find insertion index inside Top 25% Primacy (right after first heading if present)
  let primacyInsertIdx = 0;
  const maxPrimacyIdx = Math.max(1, Math.floor(keptLines.length * TURN_ZERO_GATE_CONSTANTS.PRIMACY_BAND_END));
  for (let i = 0; i < Math.min(keptLines.length, maxPrimacyIdx); i++) {
    if (keptLines[i].trim().startsWith('#')) {
      primacyInsertIdx = i + 1;
      break;
    }
  }

  const reorderedLines = [
    ...keptLines.slice(0, primacyInsertIdx),
    ...primacyBatch,
    ...keptLines.slice(primacyInsertIdx),
    ...recencyBatch
  ];

  return {
    reordered: true,
    strandedCount: strandedRules.length,
    strandedRules,
    primacyInsertedCount: primacyBatch.length,
    recencyInsertedCount: recencyBatch.length,
    optimizedContent: reorderedLines.join('\n'),
    elapsedMs: Number((performance.now() - startMs).toFixed(3))
  };
}

/**
 * Feature #17: Inserts or updates a 48-hour TTL fenced managed coach block
 * (`COACH` or `MODEL_ROUTING`) using deterministic, timestamp-free markers so
 * identical directives produce byte-for-byte identical prefix content across turns.
 */
export function upsertFencedCoachBlock(
  rawContent = '',
  {
    blockType = 'COACH',
    bodyText = '',
    nowMs = Date.now(),
    ttlMs = TURN_ZERO_GATE_CONSTANTS.FENCED_BLOCK_TTL_MS
  } = {}
) {
  const cleanType = String(blockType || 'COACH').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const createdIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + ttlMs).toISOString();
  const startMarker = `<!-- HORIZON:${cleanType}:START -->`;
  const endMarker = `<!-- HORIZON:${cleanType}:END -->`;
  const blockContent = `${startMarker}\n${String(bodyText || '').trim()}\n${endMarker}`;

  const existingRegex = new RegExp(
    `<!--\\s*HORIZON:${cleanType}:START\\b[^>]*-->[\\s\\S]*?<!--\\s*HORIZON:${cleanType}:END\\s*-->`,
    'g'
  );

  const base = String(rawContent || '');
  let updatedContent;
  if (existingRegex.test(base)) {
    updatedContent = base.replace(existingRegex, () => blockContent);
  } else {
    updatedContent = base.trim() ? `${base.trimEnd()}\n\n${blockContent}\n` : `${blockContent}\n`;
  }

  return {
    blockType: cleanType,
    timestamp: createdIso,
    expiresAt: expiresIso,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    blockContent,
    updatedContent
  };
}

/**
 * Feature #17: Scans rule content for `<!-- HORIZON:<TYPE>:START ... -->` blocks and
 * removes any block whose external `blockMeta` TTL (or legacy inline `expires_at`) has elapsed.
 */
export function pruneExpiredFencedBlocks(
  rawContent = '',
  {
    nowMs = Date.now(),
    ttlMs = TURN_ZERO_GATE_CONSTANTS.FENCED_BLOCK_TTL_MS,
    blockMeta = null
  } = {}
) {
  const base = String(rawContent || '');
  const blockRegex =
    /<!--\s*HORIZON:([A-Z0-9_]+):START\b([^>]*)-->([\s\S]*?)<!--\s*HORIZON:\1:END\s*-->\n?/g;

  const prunedBlockTypes = [];
  const cleanedContent = base.replace(blockRegex, (fullMatch, typeName, attrStr) => {
    let expiresAtMs = NaN;

    const metaEntry = blockMeta && typeof blockMeta === 'object' ? blockMeta[typeName] : null;
    if (metaEntry) {
      if (Number.isFinite(metaEntry.expiresAtMs)) {
        expiresAtMs = metaEntry.expiresAtMs;
      } else if (typeof metaEntry.expiresAt === 'string') {
        expiresAtMs = Date.parse(metaEntry.expiresAt);
      } else if (Number.isFinite(metaEntry.createdAtMs)) {
        expiresAtMs = metaEntry.createdAtMs + ttlMs;
      }
    }

    if (!Number.isFinite(expiresAtMs)) {
      const expiresMatch = attrStr.match(/(?:expires_at|expires)="([^"]+)"/i);
      const timestampMatch = attrStr.match(/(?:timestamp|created)="([^"]+)"/i);
      if (expiresMatch) {
        expiresAtMs = Date.parse(expiresMatch[1]);
      } else if (timestampMatch) {
        const tsMs = Date.parse(timestampMatch[1]);
        if (Number.isFinite(tsMs)) expiresAtMs = tsMs + ttlMs;
      }
    }

    if (Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs) {
      prunedBlockTypes.push(typeName);
      return '';
    }
    return fullMatch;
  });

  const normalizedCleaned = cleanedContent.replace(/\n{3,}/g, '\n\n');

  return {
    pruned: prunedBlockTypes.length > 0,
    prunedCount: prunedBlockTypes.length,
    prunedBlockTypes,
    cleanedContent: normalizedCleaned
  };
}

/**
 * DET-27: Audits rule file length against the 200-line ceiling (`MEMORY.md` / `AGENTS.md`).
 */
export function auditRuleLineCountHygiene(
  rawContent = '',
  { maxLines = TURN_ZERO_GATE_CONSTANTS.MAX_RECOMMENDED_RULE_LINES } = {}
) {
  const text = String(rawContent || '');
  const lineCount = text ? text.split(/\r?\n/).length : 0;
  const excessLines = Math.max(0, lineCount - maxLines);
  return {
    exceedsCap: lineCount > maxLines,
    lineCount,
    maxLines,
    excessLines,
    detectorId: 'DET-27'
  };
}

export class TurnZeroGate {
  constructor(options = {}) {
    this.warmCacheLockTokens = Number(
      options.warmCacheLockTokens ?? TURN_ZERO_GATE_CONSTANTS.WARM_CACHE_LOCK_TOKENS
    );
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.metaPath =
      options.metaPath ||
      path.join(this.workspaceDir, '.agents', 'horizon', 'turn_zero_meta.json');
    this.queuedMutations = [];
    this.activeMcpProfile = options.activeMcpProfile || 'Full Stack';
  }

  _normalizeMetaKey(targetPath) {
    return path.resolve(String(targetPath || '')).replace(/\\/g, '/').toLowerCase();
  }

  _readMetaStore() {
    if (!fs.existsSync(this.metaPath)) return { version: 1, files: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { version: 1, files: {} };
      if (!parsed.files || typeof parsed.files !== 'object') parsed.files = {};
      return parsed;
    } catch {
      return { version: 1, files: {} };
    }
  }

  _writeMetaStore(store) {
    atomicWriteFileSync(this.metaPath, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8' });
  }

  _recordBlockMeta(targetPath, blockType, { createdAtMs, expiresAtMs, timestamp, expiresAt }) {
    const store = this._readMetaStore();
    const key = this._normalizeMetaKey(targetPath);
    if (!store.files[key]) store.files[key] = {};
    store.files[key][blockType] = {
      createdAtMs,
      expiresAtMs,
      createdAt: timestamp,
      expiresAt
    };
    this._writeMetaStore(store);
  }

  _getBlockMetaForFile(targetPath) {
    const store = this._readMetaStore();
    const key = this._normalizeMetaKey(targetPath);
    return store.files[key] || null;
  }

  _removeBlockMetaTypes(targetPath, prunedTypes = []) {
    if (!Array.isArray(prunedTypes) || prunedTypes.length === 0) return;
    const store = this._readMetaStore();
    const key = this._normalizeMetaKey(targetPath);
    if (!store.files[key]) return;
    for (const t of prunedTypes) {
      delete store.files[key][t];
    }
    this._writeMetaStore(store);
  }

  /**
   * Invariant 1 check: returns true if session KV cache is warm (`cachedTokens >= 15000 && ttlRemainingSeconds > 0`).
   */
  isWarmPrefixLocked(session = {}) {
    const cachedTokens = Number(session.cachedTokens ?? session.cacheReadTokens ?? 0);
    const ttlRemainingSeconds = Number(session.ttlRemainingSeconds ?? session.cacheTtlSeconds ?? 0);
    const isHandoff = Boolean(session.isHandoff || session.onHandoff);
    const isTurnZero = Number(session.turnCount ?? -1) === 0 && cachedTokens < this.warmCacheLockTokens;

    if (isHandoff || isTurnZero) return false;
    return cachedTokens >= this.warmCacheLockTokens && ttlRemainingSeconds > 0;
  }

  /**
   * Queues or applies a mutation to `AGENTS.md`, `.agents/CONTEXT.md`, or MCP config.
   * Never mutates disk while `isWarmPrefixLocked(session)` is true.
   */
  queueOrApplyHygieneMutation(mutation = {}, session = {}) {
    if (this.isWarmPrefixLocked(session)) {
      const queuedItem = {
        id: `tzg-${Date.now()}-${this.queuedMutations.length + 1}`,
        ...mutation,
        queuedAt: new Date().toISOString()
      };
      this.queuedMutations.push(queuedItem);
      return {
        applied: false,
        queued: true,
        lockedByInvariant1: true,
        queueLength: this.queuedMutations.length,
        item: queuedItem
      };
    }

    return this._applyMutationNow(mutation);
  }

  _applyMutationNow(mutation = {}) {
    if (mutation.type === 'MCP_PROFILE') {
      const profile = MCP_PROFILES[mutation.profileName] || MCP_PROFILES['Lean Code'];
      this.activeMcpProfile = profile.label;
      if (mutation.mcpConfigPath && fs.existsSync(path.dirname(mutation.mcpConfigPath))) {
        const payload = {
          activeProfile: profile.id,
          enabledServers: profile.enabledServers,
          dampenedServers: profile.dampenedServers
        };
        atomicWriteFileSync(mutation.mcpConfigPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8' });
      }
      return {
        applied: true,
        queued: false,
        lockedByInvariant1: false,
        profile
      };
    }

    if (mutation.targetPath && mutation.newContent !== undefined) {
      atomicWriteFileSync(mutation.targetPath, String(mutation.newContent), { encoding: 'utf8' });
      if (mutation.type === 'FENCED_COACH_BLOCK_PRUNE' && Array.isArray(mutation.prunedBlockTypes)) {
        this._removeBlockMetaTypes(mutation.targetPath, mutation.prunedBlockTypes);
      }
      return {
        applied: true,
        queued: false,
        lockedByInvariant1: false,
        targetPath: mutation.targetPath
      };
    }

    return {
      applied: true,
      queued: false,
      lockedByInvariant1: false
    };
  }

  /**
   * Scans workspace `AGENTS.md` and `.agents/CONTEXT.md` for U-shaped attention placement
   * and either applies (at Turn 0 / `/handoff`) or queues (when warm cache locked).
   */
  auditAndOptimizeWorkspaceRules(session = {}, { workspaceDir = this.workspaceDir, writeChanges = false, nowMs = Date.now() } = {}) {
    const candidates = [
      path.join(workspaceDir, 'AGENTS.md'),
      path.join(workspaceDir, '.agents', 'CONTEXT.md'),
      path.join(workspaceDir, 'MEMORY.md')
    ];

    const fileReports = [];
    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const pruneAudit = pruneExpiredFencedBlocks(raw, {
        nowMs,
        blockMeta: this._getBlockMetaForFile(filePath)
      });
      const analysis = optimizeUShapedRulePlacement(pruneAudit.cleanedContent);
      const lineCapAudit = auditRuleLineCountHygiene(analysis.optimizedContent);
      let mutationStatus = null;

      if (writeChanges && (analysis.reordered || pruneAudit.pruned)) {
        mutationStatus = this.queueOrApplyHygieneMutation(
          {
            type: 'U_SHAPED_REORDER',
            targetPath: filePath,
            newContent: analysis.optimizedContent,
            prunedBlockTypes: pruneAudit.prunedBlockTypes
          },
          session
        );
      }

      fileReports.push({
        filePath,
        ...analysis,
        prunedExpiredBlocks: pruneAudit.prunedCount,
        prunedBlockTypes: pruneAudit.prunedBlockTypes,
        lineCapAudit,
        mutationStatus
      });
    }

    return {
      lockedByInvariant1: this.isWarmPrefixLocked(session),
      queuedCount: this.queuedMutations.length,
      availableMcpProfiles: Object.values(MCP_PROFILES),
      activeMcpProfile: this.activeMcpProfile,
      files: fileReports
    };
  }

  /**
   * Feature #17: Upserts a 48-hour TTL fenced block (`COACH` or `MODEL_ROUTING`) into `targetPath`,
   * strictly gated by Invariant 1 (queued if KV cache is warm, written immediately if cold / Turn 0).
   */
  stageOrApplyFencedBlock(
    {
      targetPath,
      blockType = 'COACH',
      bodyText = '',
      nowMs = Date.now(),
      ttlMs = TURN_ZERO_GATE_CONSTANTS.FENCED_BLOCK_TTL_MS
    } = {},
    session = {}
  ) {
    if (!targetPath) {
      throw new Error('TurnZeroGate.stageOrApplyFencedBlock: targetPath is required');
    }
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    const upserted = upsertFencedCoachBlock(existing, { blockType, bodyText, nowMs, ttlMs });
    this._recordBlockMeta(targetPath, upserted.blockType, upserted);
    return {
      ...upserted,
      mutation: this.queueOrApplyHygieneMutation(
        {
          type: 'FENCED_COACH_BLOCK_UPSERT',
          blockType: upserted.blockType,
          targetPath,
          newContent: upserted.updatedContent
        },
        session
      )
    };
  }

  /**
   * Feature #17: Prunes expired 48-hour TTL fenced blocks from `targetPath` strictly
   * when the KV cache is cold (or queues the prune if the cache is currently warm).
   */
  pruneExpiredFencedBlocksOnColdCache(
    targetPath,
    session = {},
    { nowMs = Date.now(), ttlMs = TURN_ZERO_GATE_CONSTANTS.FENCED_BLOCK_TTL_MS } = {}
  ) {
    if (!targetPath || !fs.existsSync(targetPath)) {
      return { pruned: false, prunedCount: 0, mutation: null };
    }
    const existing = fs.readFileSync(targetPath, 'utf8');
    const res = pruneExpiredFencedBlocks(existing, {
      nowMs,
      ttlMs,
      blockMeta: this._getBlockMetaForFile(targetPath)
    });
    if (!res.pruned) {
      return { ...res, mutation: null };
    }
    const mutation = this.queueOrApplyHygieneMutation(
      {
        type: 'FENCED_COACH_BLOCK_PRUNE',
        targetPath,
        newContent: res.cleanedContent,
        prunedBlockTypes: res.prunedBlockTypes
      },
      session
    );
    return {
      ...res,
      mutation
    };
  }

  /**
   * Selects a 1-click Pre-Session MCP Profile (`Lean Code`, `UI/Frontend`, `Full Stack`).
   */
  selectMcpProfile(profileName = 'Lean Code', session = {}, options = {}) {
    return this.queueOrApplyHygieneMutation(
      {
        type: 'MCP_PROFILE',
        profileName,
        mcpConfigPath: options.mcpConfigPath || null
      },
      session
    );
  }

  /**
   * Flushes all queued hygiene mutations at Turn 0 or during `/handoff`.
   */
  flushQueuedMutations(session = { turnCount: 0, cachedTokens: 0, ttlRemainingSeconds: 0, isHandoff: true }) {
    if (this.isWarmPrefixLocked(session)) {
      return {
        flushed: false,
        flushedCount: 0,
        remainingCount: this.queuedMutations.length
      };
    }

    const pending = this.queuedMutations.splice(0, this.queuedMutations.length);
    const applied = pending.map((m) => this._applyMutationNow(m));
    return {
      flushed: applied.length > 0,
      flushedCount: applied.length,
      remainingCount: 0,
      applied
    };
  }
}

export default TurnZeroGate;
