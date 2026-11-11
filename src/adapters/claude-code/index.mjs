/**
 * Claude Code Adapter (`src/adapters/claude-code/index.mjs`)
 *
 * Normalizes single-agent and subagent Claude Code CLI payloads so `agent_id`
 * defaults to `"primary"` when absent, constructs composite cache keys
 * `${session_id}::${agent_id}::${model_id}`, and delegates cache/thrash tracking
 * to Shared Core.
 */

import {
  formatAgentCacheKey,
  formatAgentStreamKey,
  parseAgentCacheKey,
  normalizeModelKey,
  resolveModelDescriptor,
  resolveModelRates,
  calculateModelCost
} from '../../core/constants.mjs';
import {
  resolveStepAgentId,
  trackModelCachePools,
  detectRouterThrash,
  computeQuotaAndCacheTelemetry
} from '../../core/quota.mjs';

/**
 * Normalizes a Claude Code event payload, defaulting `agent_id` to `"primary"`
 * when absent and computing its composite cache key `${session_id}::${agent_id}::${model_id}`.
 */
export function normalizeClaudeCodePayload(payload = {}) {
  const sessionId = String(payload.session_id || payload.sessionId || payload.conversationId || 'default_session').trim() || 'default_session';
  const agentId = resolveStepAgentId(payload);
  const rawModel = payload.model?.id || payload.message?.model || payload.model_id || payload.modelId || payload.model || 'claude-sonnet-5-5';
  const modelId = normalizeModelKey(rawModel);
  const compositeCacheKey = formatAgentCacheKey(sessionId, agentId, modelId);
  const streamKey = formatAgentStreamKey(sessionId, agentId);

  const usage = payload.message?.usage || payload.usage || payload.token_usage || {};
  const nestedCreate = (usage.cache_creation && typeof usage.cache_creation === 'object')
    ? usage.cache_creation
    : ((payload.cache_creation && typeof payload.cache_creation === 'object') ? payload.cache_creation : null);
  const write5mTokens = Math.max(0, Number(
    payload.cacheCreationEphemeral5mInputTokens ??
    payload.cache_creation_ephemeral_5m_input_tokens ??
    usage.cache_creation_ephemeral_5m_input_tokens ??
    nestedCreate?.ephemeral_5m_input_tokens ??
    0
  ) || 0);
  const write1hTokens = Math.max(0, Number(
    payload.cacheCreationEphemeral1hInputTokens ??
    payload.cache_creation_ephemeral_1h_input_tokens ??
    usage.cache_creation_ephemeral_1h_input_tokens ??
    nestedCreate?.ephemeral_1h_input_tokens ??
    0
  ) || 0);
  const inputTokens = Math.max(0, Number(
    payload.inputTokens ??
    payload.input_tokens ??
    usage.input_tokens ??
    0
  ) || 0);
  const cacheReadTokens = Math.max(0, Number(
    payload.cacheReadTokens ??
    payload.cache_read_input_tokens ??
    usage.cache_read_input_tokens ??
    0
  ) || 0);
  const flatCreate = Math.max(0, Number(
    payload.cacheCreationTokens ??
    payload.cache_creation_input_tokens ??
    usage.cache_creation_input_tokens ??
    0
  ) || 0);
  const cacheCreationTokens = flatCreate > 0 ? flatCreate : (write5mTokens + write1hTokens);
  const outputTokens = Math.max(0, Number(
    payload.outputTokens ??
    payload.output_tokens ??
    usage.output_tokens ??
    0
  ) || 0);
  const totalPromptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const messageId = payload.message?.id || payload.message_id || payload.messageId || null;

  return {
    ...payload,
    session_id: sessionId,
    agent_id: agentId,
    model_id: modelId,
    modelId,
    messageId,
    freshInputTokens: inputTokens,
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    write5mTokens: (write5mTokens > 0 || write1hTokens > 0) ? write5mTokens : cacheCreationTokens,
    write1hTokens,
    outputTokens,
    totalPromptTokens,
    ttlSeconds: write1hTokens > 0 ? 3600 : 300,
    compositeCacheKey,
    streamKey
  };
}

/**
 * Tracks cache state and router thrash across a sequence of Claude Code events
 * using composite keys `${session_id}::${agent_id}::${model_id}`, deduplicating
 * streaming assistant chunks by `message.id` so only the final chunk's usage is counted.
 */
export function trackClaudeCodeSessionCache(events = [], options = {}) {
  const list = Array.isArray(events) ? events : [];
  const rawNormalized = list.map(e => normalizeClaudeCodePayload(e));
  const normalized = [];
  const msgIdxMap = new Map();

  for (const ev of rawNormalized) {
    const key = ev.messageId ? `${ev.streamKey}::${ev.messageId}` : '';
    if (key && msgIdxMap.has(key)) {
      normalized[msgIdxMap.get(key)] = ev;
    } else {
      if (key) msgIdxMap.set(key, normalized.length);
      normalized.push(ev);
    }
  }

  const sessionId = options.sessionId || normalized[0]?.session_id || 'default_session';
  const isAutoMode = Boolean(options.isAutoMode ?? false);

  const pools = trackModelCachePools(normalized, { sessionId, nowMs: options.nowMs });
  const thrash = detectRouterThrash(normalized, isAutoMode, {
    sessionId,
    standbyCache: pools.standbyCache,
    lastSwitchEvent: pools.lastSwitchEvent
  });

  return {
    sessionId,
    normalizedEvents: normalized,
    ...pools,
    ...thrash
  };
}

export {
  formatAgentCacheKey,
  formatAgentStreamKey,
  parseAgentCacheKey,
  resolveStepAgentId,
  trackModelCachePools,
  detectRouterThrash,
  computeQuotaAndCacheTelemetry,
  resolveModelDescriptor,
  resolveModelRates,
  calculateModelCost
};
