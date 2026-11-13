/**
 * @file src/coach/cacheGravityRouter.mjs
 * Anthropic KV-Cache Flight Computer (`CacheGravityScorer`), `PostCompactMutationQueue`,
 * and `HysteresisLock` for Claude Code Highbeam.
 *
 * Implements the algebraic cross-model break-even equation:
 *   C* = [ O * (P_out,curr - P_out,target) ] / [ P_write5m,target - P_read,curr ]
 *   - Opus 5.5 -> Sonnet 5.5 (O = 1,500): C* = 6,522 tokens
 *   - Opus 4.6 -> Sonnet 4.6 (O = 1,500): C* = 4,615 tokens
 */

import {
  normalizeModelId,
  computeTotalPromptTokens,
  resolveEffectiveRates
} from '../config/catalogLoader.mjs';

export const FLIGHT_MODES = Object.freeze({
  OFF: 'OFF',
  SILENT: 'SILENT',
  COACH: 'COACH',
  AUTO_PILOT: 'AUTO_PILOT'
});

export const DEFAULT_EXPECTED_OUTPUT_TOKENS = 1500;

const PREFIX_INSTRUCTION_FILE_REGEX =
  /(?:^|\/)(?:CLAUDE(?:\.local)?\.md|AGENTS\.md|\.mcp\.json)$|(?:^|\/)\.claude\/(?:CLAUDE\.md|rules\/.+\.md)$/i;

/**
 * Checks whether a workspace file path is a top-level prompt-prefix instruction or MCP config file
 * whose mid-session modification invalidates the Anthropic KV-cache prefix (`DET-09`).
 *
 * @param {string} [filePath='']
 * @returns {boolean}
 */
export function isPrefixInstructionFile(filePath = '') {
  const norm = String(filePath || '').trim().replace(/\\/g, '/');
  if (!norm) return false;
  return PREFIX_INSTRUCTION_FILE_REGEX.test(norm);
}
export const DEFAULT_ADVISORY_COOLDOWN_TURNS = 3;

/**
 * Maps an active model to its natural one-tier downshift peer for cross-model break-even C* (`ISS-006`).
 *   - claude-fable-5-2 / claude-fable-5-1 -> claude-opus-5-5
 *   - claude-opus-5-5 -> claude-sonnet-5-5 (C* = 6,522 at O = 1,500)
 *   - claude-opus-4-6 / claude-opus-4-5 -> claude-sonnet-4-6 (C* = 4,615 at O = 1,500)
 *   - claude-sonnet-5-5 -> claude-haiku-5-5
 *   - claude-sonnet-4-6 / claude-sonnet-4-5 -> claude-haiku-4-5
 *   - claude-haiku-4-5 -> claude-haiku-5-5
 *
 * @param {string} [modelId='claude-opus-5-5']
 * @returns {string}
 */
export function resolveNaturalDownshiftPeer(modelId = 'claude-opus-5-5') {
  const norm = normalizeModelId(modelId);
  switch (norm) {
    case 'claude-fable-5-2':
    case 'claude-fable-5-1':
      return 'claude-opus-5-5';
    case 'claude-opus-5-5':
      return 'claude-sonnet-5-5';
    case 'claude-opus-4-6':
      return 'claude-sonnet-4-6';
    case 'claude-sonnet-5-5':
      return 'claude-haiku-5-5';
    case 'claude-sonnet-4-6':
      return 'claude-haiku-4-5';
    case 'claude-haiku-4-5':
    case 'claude-haiku-5-5':
      return 'claude-haiku-5-5';
    default:
      return 'claude-sonnet-5-5';
  }
}

/**
 * Normalizes any flight mode string into `'OFF' | 'SILENT' | 'COACH' | 'AUTO_PILOT'`.
 * @param {string} [rawMode='COACH']
 * @returns {'OFF'|'SILENT'|'COACH'|'AUTO_PILOT'}
 */
export function normalizeFlightMode(rawMode = 'COACH') {
  const cleaned = String(rawMode || 'COACH')
    .toUpperCase()
    .trim()
    .replace(/[-\s]+/g, '_');
  if (cleaned === 'OFF' || cleaned === 'DISABLED') return FLIGHT_MODES.OFF;
  if (cleaned === 'SILENT' || cleaned === 'QUIET' || cleaned === 'MUTE') {
    return FLIGHT_MODES.SILENT;
  }
  if (cleaned === 'AUTO_PILOT' || cleaned === 'AUTOPILOT' || cleaned === 'AUTO') {
    return FLIGHT_MODES.AUTO_PILOT;
  }
  return FLIGHT_MODES.COACH;
}

/**
 * Checks whether a flight mode suppresses non-security coach advisories (`OFF` or `SILENT`).
 * @param {string} [mode='COACH']
 * @returns {boolean}
 */
export function isSilentOrOffMode(mode = 'COACH') {
  const norm = normalizeFlightMode(mode);
  return norm === FLIGHT_MODES.OFF || norm === FLIGHT_MODES.SILENT;
}

/**
 * Computes the exact cross-model break-even cached token threshold `C*` and USD turn costs.
 *
 * Equation:
 *   C* = (O * (P_out,curr - P_out,target)) / (P_write5m,target - P_read,curr)
 *
 * When `cachedTokens > C*` on a warm cache, switching from `currentModel` to `targetModel`
 * costs MORE in cold `1.25x` prefix rewrite than it saves on output tokens.
 *
 * @param {object} [params={}]
 * @param {string} [params.currentModel='claude-opus-5-5']
 * @param {string} [params.targetModel='claude-sonnet-5-5']
 * @param {number} [params.expectedOutputTokens=1500]
 * @param {number} [params.cachedTokens=0]
 * @param {number} [params.uncachedDeltaTokens=0]
 * @param {boolean} [params.cacheWarm=true]
 * @param {'5m'|'1h'} [params.cacheTtlTier='5m']
 * @param {object} [options={}]
 */
export function computeBreakEvenCachedTokens(params = {}, options = {}) {
  const rawCurrentModel = params.currentModel || 'claude-opus-5-5';
  const rawTargetModel = params.targetModel || 'claude-sonnet-5-5';
  const currentModel = normalizeModelId(rawCurrentModel);
  const targetModel = normalizeModelId(rawTargetModel);
  const expectedOutputTokens = Math.max(
    0,
    Number(params.expectedOutputTokens ?? DEFAULT_EXPECTED_OUTPUT_TOKENS)
  );
  const cachedTokens = Math.max(0, Number(params.cachedTokens ?? 0));
  const uncachedDeltaTokens = Math.max(0, Number(params.uncachedDeltaTokens ?? 0));
  const cacheWarm = params.cacheWarm !== undefined ? Boolean(params.cacheWarm) : cachedTokens > 0;
  const ttlTier = params.cacheTtlTier === '1h' ? '1h' : '5m';

  const totalPromptTokens = Math.max(
    cachedTokens + uncachedDeltaTokens,
    computeTotalPromptTokens(params)
  );
  const currRates = resolveEffectiveRates(rawCurrentModel, totalPromptTokens, options);
  const targetRates = resolveEffectiveRates(rawTargetModel, totalPromptTokens, options);

  const pOutCurr = currRates.outputPer1M;
  const pOutTarget = targetRates.outputPer1M;
  const pReadCurr = currRates.readPer1M;
  const pWriteCurr = ttlTier === '1h' ? currRates.write1hPer1M : currRates.write5mPer1M;
  const pWriteTarget = ttlTier === '1h' ? targetRates.write1hPer1M : targetRates.write5mPer1M;

  const isCapabilityUpshift = pOutCurr <= pOutTarget;

  let breakEvenTokens = 0;
  if (currentModel === targetModel || isCapabilityUpshift) {
    breakEvenTokens = 0;
  } else {
    const numeratorUSD =
      (expectedOutputTokens / 1_000_000) * (pOutCurr - pOutTarget) +
      (uncachedDeltaTokens / 1_000_000) * (pWriteCurr - pWriteTarget);
    const denominator = pWriteTarget - pReadCurr;
    if (numeratorUSD <= 0) {
      breakEvenTokens = 0;
    } else if (denominator <= 0) {
      breakEvenTokens = Infinity;
    } else {
      breakEvenTokens = Math.round((numeratorUSD * 1_000_000) / denominator);
    }
  }

  // Exact USD turn cost if staying on currentModel vs switching to targetModel
  const stayPrefixCostUSD = cacheWarm
    ? (cachedTokens / 1_000_000) * pReadCurr + (uncachedDeltaTokens / 1_000_000) * pWriteCurr
    : ((cachedTokens + uncachedDeltaTokens) / 1_000_000) * pWriteCurr;
  const stayOutputCostUSD = (expectedOutputTokens / 1_000_000) * pOutCurr;
  const stayOnCurrentModelUSD = stayPrefixCostUSD + stayOutputCostUSD;

  // Switching to a different model invalidates the isolated per-model cache, forcing a full cold write
  const switchPrefixCostUSD =
    currentModel === targetModel && cacheWarm
      ? stayPrefixCostUSD
      : ((cachedTokens + uncachedDeltaTokens) / 1_000_000) * pWriteTarget;
  const switchOutputCostUSD = (expectedOutputTokens / 1_000_000) * pOutTarget;
  const switchToTargetModelUSD = switchPrefixCostUSD + switchOutputCostUSD;

  const coldWritePenaltyUSD = Number(
    (switchToTargetModelUSD - stayOnCurrentModelUSD).toFixed(6)
  );

  // Never hold/deny on capability upshifts (pOutCurr <= pOutTarget) or when coldWritePenaltyUSD <= 0 (`ISS-006`)
  const shouldHoldModel = Boolean(
    currentModel !== targetModel &&
      !isCapabilityUpshift &&
      cacheWarm &&
      coldWritePenaltyUSD > 0 &&
      cachedTokens > breakEvenTokens
  );

  return {
    currentModel,
    targetModel,
    expectedOutputTokens,
    cachedTokens,
    uncachedDeltaTokens,
    totalPromptTokens,
    cacheWarm,
    cacheTtlTier: ttlTier,
    writeMultiplierLabel: ttlTier === '1h' ? '2.0x' : '1.25x',
    isCapabilityUpshift,
    breakEvenTokens,
    rates: {
      currentOutputPer1M: pOutCurr,
      targetOutputPer1M: pOutTarget,
      currentReadPer1M: pReadCurr,
      currentWritePer1M: pWriteCurr,
      targetWritePer1M: pWriteTarget
    },
    stayOnCurrentModelUSD: Number(stayOnCurrentModelUSD.toFixed(6)),
    switchToTargetModelUSD: Number(switchToTargetModelUSD.toFixed(6)),
    coldWritePenaltyUSD,
    shouldHold: shouldHoldModel,
    shouldHoldModel
  };
}

/**
 * Queue for deferring top-level `effort`, `thinking`, `system_prompt`, or `mcp_tools`
 * mutations until immediately after context compaction (`PostCompact`), avoiding mid-session
 * full-prefix cache invalidation (`DET-09`).
 */
export class PostCompactMutationQueue {
  /**
   * @param {Array<object>} [initialItems=[]]
   */
  constructor(initialItems = []) {
    this.items = Array.isArray(initialItems) ? [...initialItems] : [];
  }

  /**
   * Enqueues or updates a deferred mutation keyed by `(type, key)`.
   * @param {object} mutation
   * @param {'effort'|'thinking'|'speed'|'system_prompt'|'mcp_tools'|'model'} mutation.type
   * @param {string} [mutation.key]
   * @param {any} mutation.value
   * @param {string} [mutation.reason]
   * @param {number} [mutation.avoidedRewritePenaltyUSD]
   * @param {number} [mutation.cachedTokens]
   * @param {number} [mutation.savedTokens]
   * @returns {object} Enqueued entry
   */
  enqueue(mutation = {}) {
    const type = String(mutation.type || 'effort');
    const key = String(mutation.key || type);
    const entry = {
      type,
      key,
      value: mutation.value,
      reason: mutation.reason || 'Deferred to PostCompact to preserve warm Anthropic prompt cache prefix',
      avoidedRewritePenaltyUSD: Number(mutation.avoidedRewritePenaltyUSD || 0),
      cachedTokens: Math.max(0, Number(mutation.cachedTokens || 0)),
      savedTokens: Math.max(0, Number(mutation.savedTokens || 0)),
      enqueuedAt: mutation.enqueuedAt || Date.now()
    };

    const existingIdx = this.items.findIndex((item) => item.type === type && item.key === key);
    if (existingIdx >= 0) {
      this.items[existingIdx] = entry;
    } else {
      this.items.push(entry);
    }
    return entry;
  }

  /**
   * Returns a shallow copy of all pending mutations without removing them.
   * @returns {Array<object>}
   */
  peekAll() {
    return [...this.items];
  }

  /**
   * Returns the number of queued mutations.
   * @returns {number}
   */
  size() {
    return this.items.length;
  }

  /**
   * Checks whether any mutations are waiting for compaction.
   * @returns {boolean}
   */
  hasPending() {
    return this.items.length > 0;
  }

  /**
   * Flushes and returns all queued mutations on `PostCompact` so they apply at zero extra rewrite cost.
   * @param {object} [context={}]
   * @returns {{ flushedCount: number, appliedMutations: Array<object>, totalAvoidedPenaltyUSD: number, flushedAt: number }}
   */
  flush(context = {}) {
    const appliedMutations = [...this.items];
    this.items = [];
    const totalAvoidedPenaltyUSD = Number(
      appliedMutations
        .reduce((acc, item) => acc + Number(item.avoidedRewritePenaltyUSD || 0), 0)
        .toFixed(6)
    );
    return {
      flushedCount: appliedMutations.length,
      appliedMutations,
      totalAvoidedPenaltyUSD,
      flushedAt: context.nowMs || Date.now()
    };
  }

  /**
   * Clears the queue.
   */
  clear() {
    this.items = [];
  }

  /**
   * Serializes queue for `$.store` or `StateBaton`.
   * @returns {Array<object>}
   */
  toJSON() {
    return [...this.items];
  }

  /**
   * Restores a `PostCompactMutationQueue` from serialized array.
   * @param {Array<object>} data
   * @returns {PostCompactMutationQueue}
   */
  static fromJSON(data) {
    return new PostCompactMutationQueue(Array.isArray(data) ? data : []);
  }
}

/**
 * Hysteresis Lock ensuring loop-triggered escalations (`DET-04` consecutive failures or `DET-05`
 * edit thrashing) stay pinned until active task completion or rewind/branch reset.
 */
export class HysteresisLock {
  constructor(initialState = {}) {
    this.locked = Boolean(initialState.locked);
    this.pinnedModel = initialState.pinnedModel || null;
    this.pinnedEffort = initialState.pinnedEffort || null;
    this.reason = initialState.reason || null;
    this.lockedAtTurn = initialState.lockedAtTurn ?? null;
  }

  /**
   * Pins model/effort due to a loop or thrashing escalation.
   * @param {object} params
   */
  engage({ model, effort = 'high', reason = 'Loop escalation lock', turn = 0 } = {}) {
    this.locked = true;
    this.pinnedModel = model ? normalizeModelId(model) : this.pinnedModel;
    this.pinnedEffort = effort;
    this.reason = reason;
    this.lockedAtTurn = turn;
    return this.getStatus();
  }

  /**
   * Releases the lock when the active task completes cleanly.
   */
  completeActiveTask() {
    this.locked = false;
    this.pinnedModel = null;
    this.pinnedEffort = null;
    this.reason = null;
    this.lockedAtTurn = null;
    return this.getStatus();
  }

  /**
   * Releases the lock on conversation rewind or git branch reset.
   */
  resetOnRewindOrBranch() {
    return this.completeActiveTask();
  }

  /**
   * Returns current lock status.
   */
  getStatus() {
    return {
      locked: this.locked,
      pinnedModel: this.pinnedModel,
      pinnedEffort: this.pinnedEffort,
      reason: this.reason,
      lockedAtTurn: this.lockedAtTurn
    };
  }
}

/**
 * Anthropic Cache GravityScorer & Flight Computer Router.
 * Supports `OFF | COACH | AUTO_PILOT` modes, 3-turn advisory cooldown,
 * `PreModelSwitch` (`DET-08`) break-even protection, `PostCompactMutationQueue` (`DET-09`),
 * and `Explore`/`Task` Haiku 5.5 subagent leaf delegation.
 */
export class CacheGravityRouter {
  /**
   * @param {object} [options={}]
   */
  constructor(options = {}) {
    this.options = options;
    this.mode = normalizeFlightMode(options.mode || FLIGHT_MODES.COACH);
    this.cooldownTurns = Number(options.cooldownTurns ?? DEFAULT_ADVISORY_COOLDOWN_TURNS);
    this.lastAdvisoryTurn = null;
    this.mutationQueue =
      options.mutationQueue instanceof PostCompactMutationQueue
        ? options.mutationQueue
        : new PostCompactMutationQueue(options.queuedMutations || []);
    this.hysteresisLock =
      options.hysteresisLock instanceof HysteresisLock
        ? options.hysteresisLock
        : new HysteresisLock(options.hysteresisState || {});
  }

  /**
   * Updates the Flight Computer operating mode (`OFF | COACH | AUTO_PILOT`).
   * @param {string} mode
   * @returns {'OFF'|'COACH'|'AUTO_PILOT'}
   */
  setMode(mode) {
    this.mode = normalizeFlightMode(mode);
    return this.mode;
  }

  /**
   * Checks whether a non-crisis advisory nudge is currently in its 3-turn cooldown window.
   * Unconditional prefix-loss blocks and Haiku 100k cliff crises are exempt from cooldown.
   *
   * @param {number} currentTurn
   * @param {boolean} [isUnconditionalCrisis=false]
   * @returns {boolean}
   */
  isCooldownActive(currentTurn = 0, isUnconditionalCrisis = false) {
    if (isUnconditionalCrisis) return false;
    if (this.lastAdvisoryTurn === null) return false;
    return currentTurn - this.lastAdvisoryTurn < this.cooldownTurns;
  }

  /**
   * Evaluates a proposed cross-model switch (`PreModelSwitch` / `DET-08`).
   * When `prompt_cache.warm === true` and `cachedTokens > C*`, blocks main-thread downgrades
   * and recommends offloading routine exploration to an isolated `claude-haiku-5-5` subagent.
   *
   * @param {object} [request={}]
   * @param {string} [request.currentModel='claude-opus-5-5']
   * @param {string} [request.targetModel='claude-sonnet-5-5']
   * @param {number} [request.cachedTokens=0]
   * @param {number} [request.uncachedDeltaTokens=0]
   * @param {number} [request.expectedOutputTokens=1500]
   * @param {boolean} [request.cacheWarm=true]
   * @param {'5m'|'1h'} [request.cacheTtlTier='5m']
   * @param {number} [request.currentTurn=0]
   */
  evaluateModelSwitch(request = {}) {
    const breakEven = computeBreakEvenCachedTokens(request, this.options);
    const currentTurn = Number(request.currentTurn ?? 0);

    // Check HysteresisLock first
    if (
      this.hysteresisLock.locked &&
      this.hysteresisLock.pinnedModel &&
      breakEven.targetModel !== this.hysteresisLock.pinnedModel
    ) {
      const suppressed = isSilentOrOffMode(this.mode);
      return {
        detectorId: 'DET-08',
        mode: this.mode,
        decision: suppressed ? 'allow' : 'deny',
        blocked: !suppressed,
        hysteresisLocked: true,
        breakEven,
        recommendedModel: this.hysteresisLock.pinnedModel,
        subagentDelegation: null,
        reason: `HysteresisLock active (${this.hysteresisLock.reason}): model pinned to ${this.hysteresisLock.pinnedModel} until active task completes.`
      };
    }

    if (isSilentOrOffMode(this.mode)) {
      return {
        detectorId: 'DET-08',
        mode: this.mode,
        decision: 'allow',
        blocked: false,
        hysteresisLocked: false,
        breakEven,
        recommendedModel: breakEven.targetModel,
        subagentDelegation: null,
        reason: null
      };
    }

    if (breakEven.shouldHoldModel) {
      // Unconditional prefix-loss protection: exempt from 3-turn advisory cooldown
      const writeMultLabel = breakEven.cacheTtlTier === '1h' ? '2.0x' : '1.25x';
      const subagentDelegation = {
        agentType: 'Explore',
        model: 'claude-haiku-5-5',
        maxContextTokens: 2000,
        turnCap: 12,
        tokenCap: 40000,
        reason: `Delegate routine file search/exploration to an isolated Explore/Task subagent on claude-haiku-5-5 (<2k context) while keeping main-thread ${breakEven.currentModel} cache warm.`
      };

      const reasonText =
        `[DET-08 Warm KV-Cache Hold] Switching from ${breakEven.currentModel} to ${breakEven.targetModel} ` +
        `with ${breakEven.cachedTokens.toLocaleString()} warm cached tokens exceeds break-even ` +
        `C* = ${breakEven.breakEvenTokens.toLocaleString()} tokens and incurs a ` +
        `+$${breakEven.coldWritePenaltyUSD.toFixed(4)} cold ${writeMultLabel} prefix rewrite penalty. ` +
        `Keep main thread on ${breakEven.currentModel} or spawn an Explore subagent on claude-haiku-5-5.`;

      // In COACH mode (default), remain 100% advisory and non-blocking unless strictBlock is explicitly set
      if (this.mode === FLIGHT_MODES.COACH && !request.strictBlock && !this.options.strictBlock) {
        return {
          detectorId: 'DET-08',
          mode: this.mode,
          decision: 'allow',
          blocked: false,
          advisory: true,
          hysteresisLocked: false,
          breakEven,
          recommendedModel: breakEven.currentModel,
          subagentDelegation,
          reason: reasonText
        };
      }

      // In AUTO_PILOT mode, actively gate the destructive model switch ('ask' or 'deny')
      const autoDecision =
        request.autoPilotDecision || this.options.autoPilotDecision || 'deny';

      return {
        detectorId: 'DET-08',
        mode: this.mode,
        decision: autoDecision,
        blocked: true,
        advisory: false,
        hysteresisLocked: false,
        breakEven,
        recommendedModel: breakEven.currentModel,
        subagentDelegation,
        reason: reasonText
      };
    }

    // Advisory evaluation when cache is cold, below C*, or a capability upshift
    const cooldownSuppressed = this.isCooldownActive(currentTurn, false);
    if (!cooldownSuppressed && this.mode === FLIGHT_MODES.COACH) {
      this.lastAdvisoryTurn = currentTurn;
    }

    const allowReason =
      breakEven.isCapabilityUpshift && breakEven.currentModel !== breakEven.targetModel
        ? `Capability upshift from ${breakEven.currentModel} to ${breakEven.targetModel} permitted without warm-cache hold.`
        : `Model switch to ${breakEven.targetModel} is within break-even threshold (cached ${breakEven.cachedTokens.toLocaleString()} <= C* ${breakEven.breakEvenTokens.toLocaleString()}).`;

    return {
      detectorId: 'DET-08',
      mode: this.mode,
      decision: 'allow',
      blocked: false,
      advisory: false,
      cooldownSuppressed,
      hysteresisLocked: false,
      breakEven,
      recommendedModel: breakEven.targetModel,
      subagentDelegation: null,
      reason: allowReason
    };
  }

  /**
   * Evaluates a mid-session top-level `effort`, `thinking`, `system_prompt`, or `mcp_tools`
   * mutation (`DET-09`). When the cache is warm, queues the mutation in `PostCompactMutationQueue`
   * so it takes effect immediately after compaction without invalidating the warm cache prefix.
   *
   * @param {object} [mutationRequest={}]
   * @param {'effort'|'thinking'|'speed'|'system_prompt'|'mcp_tools'} [mutationRequest.type='effort']
   * @param {string} [mutationRequest.key]
   * @param {any} mutationRequest.value
   * @param {string} [mutationRequest.currentModel='claude-opus-5-5']
   * @param {number} [mutationRequest.cachedTokens=0]
   * @param {boolean} [mutationRequest.cacheWarm=true]
   * @param {'5m'|'1h'} [mutationRequest.cacheTtlTier='5m']
   */
  interceptTopLevelMutation(mutationRequest = {}) {
    const rawModel = mutationRequest.currentModel || mutationRequest.modelId || 'claude-opus-5-5';
    const modelId = normalizeModelId(rawModel);
    const cachedTokens = Math.max(0, Number(mutationRequest.cachedTokens ?? 0));
    const hasTtlField =
      mutationRequest.ttlRemainingSeconds !== undefined &&
      mutationRequest.ttlRemainingSeconds !== null;
    const ttlRemainingSeconds = hasTtlField ? Number(mutationRequest.ttlRemainingSeconds) : null;
    const ttlExpired = hasTtlField && ttlRemainingSeconds <= 0;

    const cacheWarm = ttlExpired
      ? false
      : mutationRequest.cacheWarm !== undefined
        ? Boolean(mutationRequest.cacheWarm)
        : cachedTokens > 0;

    const targetFilePath = String(
      mutationRequest.filePath || mutationRequest.file_path || mutationRequest.path || ''
    ).trim();

    if (
      targetFilePath &&
      (!mutationRequest.type || mutationRequest.type === 'file_edit') &&
      !isPrefixInstructionFile(targetFilePath)
    ) {
      return {
        detectorId: 'DET-09',
        triggered: false,
        queued: false,
        decision: 'allow',
        avoidedRewritePenaltyUSD: 0,
        queueSize: this.mutationQueue.size(),
        reason: null
      };
    }

    const ttlTier = mutationRequest.cacheTtlTier === '1h' ? '1h' : '5m';
    const totalPromptTokens = Math.max(cachedTokens, computeTotalPromptTokens(mutationRequest));
    const rates = resolveEffectiveRates(rawModel, totalPromptTokens, this.options);
    const writeRate = ttlTier === '1h' ? rates.write1hPer1M : rates.write5mPer1M;

    if (isSilentOrOffMode(this.mode) || !cacheWarm || cachedTokens === 0) {
      return {
        detectorId: 'DET-09',
        triggered: false,
        queued: false,
        decision: 'allow',
        avoidedRewritePenaltyUSD: 0,
        queueSize: this.mutationQueue.size(),
        reason: 'Cache is cold or router is OFF/SILENT; top-level mutation may apply immediately.'
      };
    }

    const avoidedRewritePenaltyUSD = Number(
      ((cachedTokens / 1_000_000) * (writeRate - rates.readPer1M)).toFixed(6)
    );

    const mutationType =
      mutationRequest.type || (targetFilePath ? 'system_prompt' : 'effort');
    const entry = this.mutationQueue.enqueue({
      type: mutationType,
      key: mutationRequest.key || targetFilePath || mutationType,
      value: mutationRequest.value,
      cachedTokens,
      avoidedRewritePenaltyUSD,
      reason:
        `[DET-09 Top-Level Mutation Deferred] Mutating top-level ${mutationType} ` +
        `while ${cachedTokens.toLocaleString()} tokens are warm on ${modelId} would invalidate the ` +
        `Anthropic prompt cache prefix (+$${avoidedRewritePenaltyUSD.toFixed(4)} rewrite spike). ` +
        `Queued in PostCompactMutationQueue to apply after next compaction.`
    });

    return {
      detectorId: 'DET-09',
      triggered: true,
      queued: true,
      decision: 'defer',
      entry,
      avoidedRewritePenaltyUSD,
      queueSize: this.mutationQueue.size(),
      reason: entry.reason
    };
  }
}

/**
 * Convenience functional wrapper for `DET-09` Warm-Prefix Mutation Fence (`PostCompactMutationQueue`).
 *
 * @param {object} [mutationRequest={}]
 * @param {object} [options={}]
 */
export function evaluateDet09PrefixMutationFence(mutationRequest = {}, options = {}) {
  const router = new CacheGravityRouter(options);
  return router.interceptTopLevelMutation(mutationRequest);
}

/**
 * Convenience functional wrapper for `DET-08` `PreModelSwitch` evaluation.
 * @param {object} [request={}]
 * @param {object} [options={}]
 */
export function evaluatePreModelSwitch(request = {}, options = {}) {
  const router = new CacheGravityRouter(options);
  return router.evaluateModelSwitch(request);
}

export default {
  FLIGHT_MODES,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  DEFAULT_ADVISORY_COOLDOWN_TURNS,
  normalizeFlightMode,
  isSilentOrOffMode,
  isPrefixInstructionFile,
  resolveNaturalDownshiftPeer,
  computeBreakEvenCachedTokens,
  evaluatePreModelSwitch,
  evaluateDet09PrefixMutationFence,
  PostCompactMutationQueue,
  HysteresisLock,
  CacheGravityRouter
};
