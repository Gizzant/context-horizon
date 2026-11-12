import fs from 'node:fs';
import { getHomeDir } from './paths.mjs';
import { findSessionDirectory, parseTranscriptIncremental } from './parser.mjs';
import {
  normalizeModelId,
  resolveModelDescriptor,
  resolveModelRates,
  calculateModelCost,
  createSwarmAgentState,
  validateSwarmAgentState,
  CORE_SCHEMAS
} from './constants.mjs';

/**
 * Multi-Agent (`invoke_subagent`) Context Tree & Handoff Inspector.
 *
 * Scans parent transcript steps for `invoke_subagent` tool calls, resolves child
 * session transcripts across `inherit`, `branch`, and `share` workspace modes,
 * and computes isolated child exploration bloat vs. parent handoff compression.
 */

export const HANDOFF_BLOAT_THRESHOLD_TOKENS = 4000;

export function inspectSubagentTree(steps = [], {
  homeDir = getHomeDir(),
  cacheDir = null
} = {}) {
  const invocations = [];
  const childIdsSeen = new Set();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const calls = step.toolCalls || [];
    for (const call of calls) {
      const name = String(call.name || '').toLowerCase();
      if (name === 'invoke_subagent') {
        const args = call.args || {};
        const role = args.Role || args.role || 'Subagent';
        const typeName = args.TypeName || args.typeName || 'self';
        const workspaceMode = args.Workspace || args.workspace || 'inherit';
        const model = args.Model || args.model || 'inherit';

        // Extract returned conversationId or subagent response from subsequent steps
        let childConversationId = call.result?.conversationId || call.conversationId || args.conversationId || null;
        let handoffTokens = 0;
        let handoffStepIdx = i;

        // Look ahead up to 6 steps for the subagent completion/response or conversationId
        for (let j = i; j < Math.min(steps.length, i + 7); j++) {
          const lookStep = steps[j] || {};
          const text = String(lookStep.content || '');
          if (!childConversationId) {
            const matches = text.matchAll(/conversation(?:Id|_id)["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi);
            for (const m of matches) {
              if (m[1] && !childIdsSeen.has(m[1])) {
                childConversationId = m[1];
                break;
              }
            }
          }
          const isParentStep = !lookStep.agentId || lookStep.agentId === 'parent';
          if (j > i && isParentStep && (text.toLowerCase().includes('subagent') || text.includes(role))) {
            const est = lookStep.outputTokens || Math.ceil(text.length / 4) || 0;
            if (est > handoffTokens) {
              handoffTokens = est;
              handoffStepIdx = j;
            }
          }
        }

        if (handoffTokens === 0) {
          handoffTokens = Math.max(250, Math.min(2500, Math.ceil(String(step.content || '').length / 4) || 600));
        }

        let isolatedTokens = 0;
        let childStepCount = 0;

        // If child session exists on disk, measure its isolated transcript size
        if (childConversationId) {
          childIdsSeen.add(childConversationId);
          try {
            const childSession = findSessionDirectory(childConversationId, homeDir);
            if (childSession && fs.existsSync(childSession.sessionDir)) {
              const parsedChild = parseTranscriptIncremental(childSession.sessionDir, cacheDir);
              childStepCount = (parsedChild.steps || []).length;
              isolatedTokens = (parsedChild.steps || []).reduce((sum, cs) => {
                const tok = cs.outputTokens || Math.ceil((cs.untruncatedLength || 0) / 4) || 500;
                return sum + tok;
              }, 0);
            }
          } catch {}
        }

        // Fallback estimate for child steps embedded via agentId === `child:...`
        if (isolatedTokens === 0) {
          const embeddedChildSteps = steps.filter(s => s.agentId && s.agentId !== 'parent');
          if (embeddedChildSteps.length > 0) {
            childStepCount = embeddedChildSteps.length;
            isolatedTokens = embeddedChildSteps.reduce((sum, cs) => sum + (cs.outputTokens || Math.ceil((cs.untruncatedLength || 0) / 4) || 800), 0);
          } else {
            isolatedTokens = Math.max(handoffTokens * 12, 18000);
            childStepCount = 8;
          }
        }

        const compressionRatio = parseFloat((isolatedTokens / Math.max(1, handoffTokens)).toFixed(1));
        const rawDumpLeak = handoffTokens >= HANDOFF_BLOAT_THRESHOLD_TOKENS;

        const resolvedConvId = childConversationId || `subagent-step-${i}-${invocations.length}`;
        if (invocations.some((inv) => inv.conversationId === resolvedConvId)) {
          continue;
        }

        invocations.push({
          stepIndex: i,
          handoffStepIndex: handoffStepIdx,
          conversationId: resolvedConvId,
          role,
          typeName,
          workspaceMode,
          model,
          childStepCount,
          isolatedTokens,
          handoffTokens,
          tokensSaved: Math.max(0, isolatedTokens - handoffTokens),
          compressionRatio,
          rawDumpLeak,
          badgeLabel: `[Subagent: ${typeName} | ${(isolatedTokens / 1000).toFixed(1)}k isolated -> ${(handoffTokens / 1000).toFixed(1)}k handoff (${Math.round(compressionRatio)}x)]`
        });
      }
    }
  }

  const totalIsolatedTokens = invocations.reduce((s, x) => s + x.isolatedTokens, 0);
  const totalHandoffTokens = invocations.reduce((s, x) => s + x.handoffTokens, 0);
  const totalSavedTokens = invocations.reduce((s, x) => s + x.tokensSaved, 0);
  const overallCompressionRatio = totalHandoffTokens > 0
    ? parseFloat((totalIsolatedTokens / totalHandoffTokens).toFixed(1))
    : 0;

  return {
    count: invocations.length,
    totalIsolatedTokens,
    totalHandoffTokens,
    totalSavedTokens,
    overallCompressionRatio,
    hasRawDumpLeak: invocations.some(x => x.rawDumpLeak),
    invocations
  };
}

/**
 * Builds a parent -> subagent worktree DAG (`inherit`, `branch`, `share`),
 * tracking isolated vs handoff tokens, `cacheCreationEphemeral5mInputTokens` TTL countdowns,
 * and detecting concurrent `fileCollisions` when >= 2 active subagents edit the same file path.
 */
export function buildSubagentWorktreeDag(steps = [], { childTranscripts = [], nowMs = Date.now() } = {}) {
  const baseTree = inspectSubagentTree(steps);
  const editsByAgent = new Map(); // canonPath -> Set<agentId>
  const readsByAgent = new Map(); // canonPath -> Set<agentId>
  const nodes = [];

  for (const child of (childTranscripts || [])) {
    const agentId = String(child.agentId || child.conversationId || `sub-${nodes.length}`);
    const workspaceMode = child.workspaceMode || 'inherit';
    const childSteps = Array.isArray(child.steps) ? child.steps : [];
    let isolatedTokens = 0;
    let latestTs = 0;
    const modifiedFiles = new Set();
    const readFiles = new Set();

    for (const cs of childSteps) {
      isolatedTokens += Math.max(0, Number(cs.outputTokens ?? cs.output_tokens ?? 0) || 0);
      const ts = cs.createdAt ? Date.parse(cs.createdAt) : (cs.timestamp ? Date.parse(cs.timestamp) : 0);
      if (Number.isFinite(ts) && ts > latestTs) latestTs = ts;

      const calls = Array.isArray(cs.toolCalls) ? cs.toolCalls : (Array.isArray(cs.tool_calls) ? cs.tool_calls : []);
      for (const c of calls) {
        const name = String(c.name || c.tool || '').toLowerCase();
        const args = c.args || c.parameters || c.Arguments || {};
        const fp = args.Path || args.path || args.TargetFile || args.AbsolutePath;
        if (fp && /edit|write|replace/i.test(name)) {
          const norm = String(fp).replace(/\\/g, '/').toLowerCase();
          modifiedFiles.add(norm);
          if (!editsByAgent.has(norm)) editsByAgent.set(norm, new Set());
          editsByAgent.get(norm).add(agentId);
        }
        if (fp && /view|read/i.test(name)) {
          const norm = String(fp).replace(/\\/g, '/').toLowerCase();
          readFiles.add(norm);
          if (!readsByAgent.has(norm)) readsByAgent.set(norm, new Set());
          readsByAgent.get(norm).add(agentId);
        }
      }
    }

    const idleSec = latestTs > 0 ? Math.max(0, Math.round((nowMs - latestTs) / 1000)) : 0;
    const ttlRemainingSec = latestTs > 0 ? Math.max(0, 300 - idleSec) : 300;

    nodes.push({
      agentId,
      workspaceMode,
      isolatedTokens,
      ttlWindowSec: 300,
      ttlRemainingSec,
      modifiedFiles: Array.from(modifiedFiles),
      readFiles: Array.from(readFiles)
    });
  }

  const fileCollisions = [];
  for (const [filePath, agentsSet] of editsByAgent.entries()) {
    if (agentsSet.size >= 2) {
      fileCollisions.push({
        filePath,
        agents: Array.from(agentsSet),
        severity: 'CONCURRENT_EDIT_COLLISION'
      });
    }
  }

  const readCollisions = [];
  for (const [filePath, agentsSet] of readsByAgent.entries()) {
    if (agentsSet.size >= 2) {
      readCollisions.push({
        filePath,
        agents: Array.from(agentsSet),
        severity: 'DUPLICATE_READ_COLLISION'
      });
    }
  }

  return {
    parentInvocationCount: baseTree.count,
    nodes,
    fileCollisions,
    hasFileCollision: fileCollisions.length > 0,
    readCollisions,
    hasReadCollision: readCollisions.length > 0
  };
}

export const SWARM_IDLE_TTL_CONSTANTS = Object.freeze({
  DEFAULT_CACHE_TTL_MS: 300000, // 5 minutes (300,000 ms)
  DEFAULT_COLD_WAKE_THRESHOLD_TOKENS: 100000, // 100,000 warm prefix tokens
  CLIFF_WARNING_SECONDS: 60, // warn when within 60 seconds of falling off cache cliff
  SWARM_TOOL_MATCHER: 'invoke_subagent|define_subagent|send_message|manage_subagents'
});

/**
 * Determines whether a model is considered a frontier model subject to cold-cache wakeup diagnostics.
 */
export function isFrontierSwarmModel(modelId = '') {
  const desc = resolveModelDescriptor(modelId);
  if (desc && (desc.family === 'carbon' || desc.family === 'argon' || desc.family === 'opus' || desc.family === 'sonnet')) {
    return true;
  }
  const norm = normalizeModelId(modelId);
  return norm.includes('carbon') || norm.includes('argon') || norm.includes('opus') || norm.includes('pro');
}

/**
 * Extracts target recipient agent IDs from a `send_message` tool call or `@mention` text.
 */
export function extractTargetRecipientAgents(toolInput = {}, rawText = '') {
  const targets = new Set();
  const recipient = toolInput?.Recipient || toolInput?.recipient || toolInput?.targetAgent || toolInput?.agent_id || toolInput?.agentId;
  if (recipient && typeof recipient === 'string' && recipient.trim()) {
    targets.add(recipient.trim());
  }
  const msgText = String(toolInput?.Message || toolInput?.message || toolInput?.brief || rawText || '');
  const mentionMatches = msgText.match(/@([a-z0-9_-]+)/gi) || [];
  for (const m of mentionMatches) {
    const clean = m.slice(1).trim();
    if (clean) targets.add(clean);
  }
  return Array.from(targets);
}

/**
 * Computes per-agent TTL countdown badges for the local state JSON so the UI/statusline
 * warns when a parked Carbon coordinator or verifier is within 60 seconds of falling off the cache cliff.
 */
export function computeSwarmRosterTtlBadges(swarmRoster = {}, {
  nowMs = Date.now(),
  cacheTtlMs = SWARM_IDLE_TTL_CONSTANTS.DEFAULT_CACHE_TTL_MS
} = {}) {
  const badges = [];
  const entries = swarmRoster instanceof Map
    ? Array.from(swarmRoster.entries())
    : Object.entries(swarmRoster || {});

  for (const [keyId, rawAgent] of entries) {
    if (!rawAgent || typeof rawAgent !== 'object') continue;
    const state = createSwarmAgentState({ ...rawAgent, agent_id: rawAgent.agent_id || keyId });
    const ttlMs = Number(state.cache_ttl_ms || cacheTtlMs || SWARM_IDLE_TTL_CONSTANTS.DEFAULT_CACHE_TTL_MS);
    const elapsedMs = Math.max(0, nowMs - state.last_active_timestamp);
    const remainingMs = state.status === 'terminated' ? 0 : Math.max(0, ttlMs - elapsedMs);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const isExpired = state.status !== 'terminated' && elapsedMs > ttlMs;
    const isNearCliff = state.status === 'idle_zero_token' && remainingSec > 0 && remainingSec <= SWARM_IDLE_TTL_CONSTANTS.CLIFF_WARNING_SECONDS;

    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const countdownLabel = remainingSec > 0
      ? `${mins}m ${String(secs).padStart(2, '0')}s`
      : '0m 00s (expired)';

    const badgeText = isNearCliff
      ? `⚠️ [${state.agent_id} • ${state.model_id}] Cache cliff in ${remainingSec}s (${Math.round(state.warm_prefix_tokens / 1000)}k warm) [CACHE CLIFF WARNING]`
      : (isExpired
        ? `❄️ [${state.agent_id} • ${state.model_id}] Cold cache (${Math.round(state.warm_prefix_tokens / 1000)}k expired)`
        : `🟢 [${state.agent_id} • ${state.model_id}] ${countdownLabel} (${Math.round(state.warm_prefix_tokens / 1000)}k warm)`);

    badges.push({
      agent_id: state.agent_id,
      model_id: state.model_id,
      status: state.status,
      warm_prefix_tokens: state.warm_prefix_tokens,
      last_active_timestamp: state.last_active_timestamp,
      cache_ttl_ms: ttlMs,
      elapsed_ms: elapsedMs,
      ttl_remaining_ms: remainingMs,
      ttl_remaining_sec: remainingSec,
      remaining_ttl_sec: remainingSec,
      is_near_cliff: isNearCliff,
      within_cliff_warning: isNearCliff,
      is_expired: isExpired,
      countdown_label: countdownLabel,
      badge_text: badgeText,
      badge_label: badgeText
    });
  }

  return badges;
}

/**
 * Evaluates a `PreToolUse` on `send_message` (or `@mention` dispatch) targeting a specific `Recipient` agent.
 * If the target agent is running `gemini-4-carbon` (or another frontier model), has
 * `warm_prefix_tokens >= cold_wake_threshold` (default 100,000), and `now - target.last_active_timestamp > cache_ttl_ms`,
 * surfaces a Cold-Cache Wakeup diagnostic quantifying the uncached input rebuild cost using `resolveModelRates()`.
 */
export function evaluateSwarmColdCacheWakeup({
  recipientAgentId,
  swarmRoster = {},
  nowMs = Date.now(),
  eventTimestampUtc = null,
  serviceTier = 'standard',
  coldWakeThresholdTokens = SWARM_IDLE_TTL_CONSTANTS.DEFAULT_COLD_WAKE_THRESHOLD_TOKENS,
  cacheTtlMs = SWARM_IDLE_TTL_CONSTANTS.DEFAULT_CACHE_TTL_MS
} = {}) {
  const targetRecord = swarmRoster instanceof Map
    ? swarmRoster.get(recipientAgentId)
    : (swarmRoster?.[recipientAgentId] || null);

  if (!targetRecord) {
    return {
      triggered: false,
      reason: 'UNKNOWN_AGENT',
      recipientAgentId: recipientAgentId || null
    };
  }

  const state = createSwarmAgentState({ ...targetRecord, agent_id: targetRecord.agent_id || recipientAgentId });
  const ttlMs = Number(state.cache_ttl_ms || cacheTtlMs || SWARM_IDLE_TTL_CONSTANTS.DEFAULT_CACHE_TTL_MS);
  const threshold = Number(coldWakeThresholdTokens ?? SWARM_IDLE_TTL_CONSTANTS.DEFAULT_COLD_WAKE_THRESHOLD_TOKENS);
  const elapsedMs = Math.max(0, nowMs - state.last_active_timestamp);
  const elapsedSec = Math.round(elapsedMs / 1000);
  const ttlRemainingSec = Math.max(0, Math.ceil((ttlMs - elapsedMs) / 1000));
  const isCacheExpired = elapsedMs > ttlMs;
  const isFrontier = isFrontierSwarmModel(state.model_id);
  const meetsTokenThreshold = state.warm_prefix_tokens >= threshold;

  const effectiveTimestamp = eventTimestampUtc ?? nowMs;
  const rates = resolveModelRates(state.model_id, effectiveTimestamp, serviceTier);
  const uncachedRebuildCost = calculateModelCost(
    { input_tokens: state.warm_prefix_tokens, output_tokens: 0, thinking_tokens: 0, cached_read_tokens: 0 },
    { modelId: state.model_id, eventTimestampUtc: effectiveTimestamp, serviceTier }
  );
  const warmHitCost = calculateModelCost(
    { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cached_read_tokens: state.warm_prefix_tokens },
    { modelId: state.model_id, eventTimestampUtc: effectiveTimestamp, serviceTier }
  );

  const rebuildCostUsd = uncachedRebuildCost.inputCostUsd;
  const warmReadCostUsd = warmHitCost.cachedReadCostUsd;
  const penaltyDeltaUsd = Number((rebuildCostUsd - warmReadCostUsd).toFixed(6));

  if (state.status !== 'terminated' && isFrontier && meetsTokenThreshold && isCacheExpired) {
    return {
      triggered: true,
      coldWakeDetected: true,
      cacheWarm: false,
      diagnosticType: 'COLD_CACHE_WAKEUP',
      recipientAgentId: state.agent_id,
      modelId: state.model_id,
      status: state.status,
      warmPrefixTokens: state.warm_prefix_tokens,
      elapsedMs,
      elapsedSec,
      cacheTtlMs: ttlMs,
      ttlRemainingSec: 0,
      pricingWindow: rates.pricingWindow,
      serviceTier: rates.serviceTier,
      inputRatePer1M: rates.input_per_1m,
      cachedReadRatePer1M: rates.cached_read_per_1m,
      uncachedRebuildCostUsd: rebuildCostUsd,
      warmReadCostUsd,
      penaltyDeltaUsd,
      incrementalColdPenaltyUsd: penaltyDeltaUsd,
      message: `[Cold-Cache Wakeup] Waking idle agent "${state.agent_id}" (${state.model_id}) after ${elapsedSec}s (> ${Math.round(ttlMs / 1000)}s TTL) triggers an uncached rebuild of ${state.warm_prefix_tokens.toLocaleString('en-US')} prefix tokens costing $${rebuildCostUsd.toFixed(4)} ($${rates.input_per_1m.toFixed(2)}/1M ${rates.pricingWindow} ${rates.serviceTier} rate vs $${warmReadCostUsd.toFixed(4)} warm hit).`
    };
  }

  return {
    triggered: false,
    coldWakeDetected: false,
    cacheWarm: !isCacheExpired,
    diagnosticType: 'WARM_CACHE_HIT',
    recipientAgentId: state.agent_id,
    modelId: state.model_id,
    status: state.status,
    warmPrefixTokens: state.warm_prefix_tokens,
    elapsedMs,
    elapsedSec,
    cacheTtlMs: ttlMs,
    ttlRemainingSec,
    pricingWindow: rates.pricingWindow,
    serviceTier: rates.serviceTier,
    uncachedRebuildCostUsd: 0,
    warmReadCostUsd,
    penaltyDeltaUsd: 0,
    incrementalColdPenaltyUsd: 0,
    message: ''
  };
}

/**
 * Stateful `/swarm` roster & idle-TTL tracker for coordinator and subagent lifecycles.
 */
export class SwarmIdleTtlTracker {
  constructor(options = {}) {
    this.cacheTtlMs = Number(options.cacheTtlMs || SWARM_IDLE_TTL_CONSTANTS.DEFAULT_CACHE_TTL_MS);
    this.coldWakeThresholdTokens = Number(options.coldWakeThresholdTokens || SWARM_IDLE_TTL_CONSTANTS.DEFAULT_COLD_WAKE_THRESHOLD_TOKENS);
    this.roster = new Map();
    if (options.initialRoster && typeof options.initialRoster === 'object') {
      for (const [k, v] of Object.entries(options.initialRoster)) {
        const st = createSwarmAgentState({ ...v, agent_id: v?.agent_id || k, cache_ttl_ms: v?.cache_ttl_ms || this.cacheTtlMs });
        this.roster.set(st.agent_id, st);
      }
    }
  }

  registerOrActivateAgent(agentId, {
    modelId = 'gemini-4-carbon',
    warmPrefixTokens = 0,
    timestampMs = Date.now(),
    role = null
  } = {}) {
    const existing = this.roster.get(agentId);
    const state = createSwarmAgentState({
      agent_id: agentId,
      model_id: modelId || existing?.model_id || 'gemini-4-carbon',
      status: 'active',
      last_active_timestamp: timestampMs,
      warm_prefix_tokens: warmPrefixTokens > 0 ? warmPrefixTokens : (existing?.warm_prefix_tokens || 0),
      cache_ttl_ms: this.cacheTtlMs,
      role: role || existing?.role || null
    });
    this.roster.set(state.agent_id, state);
    return { ...state };
  }

  /**
   * Transitions an agent to `idle_zero_token` when its turn completes while the parent swarm remains live.
   */
  markTurnCompleted(agentId, {
    warmPrefixTokens = undefined,
    timestampMs = Date.now(),
    parentSwarmLive = true
  } = {}) {
    const existing = this.roster.get(agentId) || createSwarmAgentState({ agent_id: agentId });
    const nextStatus = parentSwarmLive ? 'idle_zero_token' : 'terminated';
    const updated = createSwarmAgentState({
      ...existing,
      agent_id: agentId,
      status: nextStatus,
      last_active_timestamp: timestampMs,
      warm_prefix_tokens: warmPrefixTokens !== undefined ? warmPrefixTokens : existing.warm_prefix_tokens,
      cache_ttl_ms: existing.cache_ttl_ms || this.cacheTtlMs
    });
    this.roster.set(updated.agent_id, updated);
    return { ...updated };
  }

  terminateAgent(agentId, timestampMs = Date.now()) {
    const existing = this.roster.get(agentId) || createSwarmAgentState({ agent_id: agentId });
    const updated = createSwarmAgentState({
      ...existing,
      agent_id: agentId,
      status: 'terminated',
      last_active_timestamp: timestampMs
    });
    this.roster.set(updated.agent_id, updated);
    return { ...updated };
  }

  interceptSendMessagePreToolUse(toolInput = {}, {
    nowMs = Date.now(),
    eventTimestampUtc = null,
    serviceTier = 'standard'
  } = {}) {
    const recipients = extractTargetRecipientAgents(toolInput);
    const diagnostics = [];
    for (const recipientId of recipients) {
      const diag = evaluateSwarmColdCacheWakeup({
        recipientAgentId: recipientId,
        swarmRoster: this.roster,
        nowMs,
        eventTimestampUtc: eventTimestampUtc ?? nowMs,
        serviceTier,
        coldWakeThresholdTokens: this.coldWakeThresholdTokens,
        cacheTtlMs: this.cacheTtlMs
      });
      diagnostics.push(diag);
    }
    const triggeredDiagnostics = diagnostics.filter(d => d.triggered);
    return {
      triggered: triggeredDiagnostics.length > 0,
      recipients,
      diagnostics,
      coldWakeupAlerts: triggeredDiagnostics,
      primaryAlert: triggeredDiagnostics[0] || null
    };
  }

  getBadges(nowMsOrOpts = Date.now()) {
    const nowMs = typeof nowMsOrOpts === 'object' && nowMsOrOpts !== null
      ? (nowMsOrOpts.nowMs ?? Date.now())
      : nowMsOrOpts;
    return computeSwarmRosterTtlBadges(this.roster, { nowMs, cacheTtlMs: this.cacheTtlMs });
  }

  getTtlBadges(nowMsOrOpts = Date.now()) {
    return this.getBadges(nowMsOrOpts);
  }

  touchAgentActive(agentId, options = {}) {
    return this.registerOrActivateAgent(agentId, options);
  }

  onTurnComplete(agentId, options = {}) {
    if (options.modelId && !this.roster.has(agentId)) {
      this.registerOrActivateAgent(agentId, {
        modelId: options.modelId,
        warmPrefixTokens: options.warmPrefixTokens ?? 0,
        timestampMs: options.timestampMs ?? Date.now()
      });
    } else if (options.modelId && this.roster.has(agentId)) {
      const cur = this.roster.get(agentId);
      this.roster.set(agentId, { ...cur, model_id: normalizeModelId(options.modelId) });
    }
    return this.markTurnCompleted(agentId, options);
  }

  handlePreToolSendMessage(toolInput = {}, options = {}) {
    const res = this.interceptSendMessagePreToolUse(toolInput, options);
    const primary = res.primaryAlert || res.diagnostics[0] || {
      triggered: false,
      coldWakeDetected: false,
      cacheWarm: true,
      uncachedRebuildCostUsd: 0,
      incrementalColdPenaltyUsd: 0,
      message: ''
    };
    return {
      ...primary,
      ...res,
      coldWakeDetected: Boolean(primary.coldWakeDetected || res.triggered),
      cacheWarm: Boolean(primary.cacheWarm && !res.triggered),
      uncachedRebuildCostUsd: primary.uncachedRebuildCostUsd ?? 0,
      incrementalColdPenaltyUsd: primary.incrementalColdPenaltyUsd ?? 0,
      warmPrefixTokens: primary.warmPrefixTokens ?? 0,
      message: primary.message || ''
    };
  }

  getRosterSnapshot() {
    const agents = {};
    for (const [id, st] of this.roster.entries()) {
      agents[id] = { ...st };
    }
    return agents;
  }

  toJSON(nowMs = Date.now()) {
    const agents = {};
    for (const [id, st] of this.roster.entries()) {
      agents[id] = { ...st };
    }
    return {
      agents,
      badges: this.getBadges(nowMs)
    };
  }
}


