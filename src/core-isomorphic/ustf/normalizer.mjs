/**
 * @file src/core-isomorphic/ustf/normalizer.mjs
 * Universal Session Trajectory Format (USTF v1) Dual-Harness Normalizer.
 *
 * Normalizes raw session events, steps, DAGs, and transcripts from Google Antigravity
 * and Claude Code into canonical USTF v1 trajectory objects.
 *
 * Pure JS / ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

import {
  USTF_SCHEMA_VERSION,
  USTF_SCHEMA_URI,
  validateUstfTrajectory
} from './schema.mjs';

/**
 * Creates an empty canonical USTF v1 session object.
 *
 * @param {string} sessionId
 * @param {'antigravity' | 'claude-code' | 'cursor'} [harness='claude-code']
 * @param {object} [options={}]
 * @returns {object}
 */
export function createEmptyUstfSession(sessionId = 'default-session', harness = 'claude-code', options = {}) {
  const now = options.nowMs || Date.now();
  return {
    $schema: USTF_SCHEMA_URI,
    version: USTF_SCHEMA_VERSION,
    sessionId: String(sessionId),
    harness,
    streamKey: `${sessionId}::${options.agentId || 'main'}`,
    modelId: options.modelId || 'unknown',
    startTimeMs: options.startTimeMs || now,
    endTimeMs: options.endTimeMs || null,
    events: [],
    spans: [],
    usage: {
      uncached: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
      costUSD: 0
    },
    worktree: {
      path: options.worktreePath || '',
      branch: options.branch || '',
      isDetached: Boolean(options.isDetached)
    },
    rewindBranches: [],
    metadata: { ...options.metadata }
  };
}

/**
 * Normalizes a raw usage object from various host shapes into canonical USTF usage.
 *
 * @param {object} [raw={}]
 * @param {object} [rates={}]
 * @returns {object}
 */
export function normalizeUsage(raw = {}, rates = {}) {
  if (!raw || typeof raw !== 'object') {
    return {
      uncached: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
      costUSD: 0
    };
  }

  const cacheCreation = raw.cache_creation || raw.cacheCreation || null;
  const cacheWrite5m = Number(
    raw.cacheWrite5m ??
    cacheCreation?.ephemeral_5m_input_tokens ??
    raw.cache_creation_input_tokens ??
    raw.cacheCreationInputTokens ??
    0
  );
  const cacheWrite1h = Number(
    raw.cacheWrite1h ??
    cacheCreation?.ephemeral_1h_input_tokens ??
    0
  );
  const cacheRead = Number(
    raw.cacheRead ??
    raw.cache_read_input_tokens ??
    raw.cacheReadInputTokens ??
    raw.cached_tokens ??
    raw.cachedTokens ??
    0
  );
  const uncached = Number(
    raw.uncached ??
    raw.input_tokens ??
    raw.inputTokens ??
    raw.prompt_tokens ??
    raw.promptTokens ??
    0
  );
  const output = Number(
    raw.output ??
    raw.output_tokens ??
    raw.outputTokens ??
    0
  );
  const thinking = Number(
    raw.thinking ??
    raw.thinking_tokens ??
    raw.thinkingTokens ??
    0
  );

  let costUSD = Number(raw.costUSD ?? raw.cost_usd ?? raw.costUsd ?? 0);
  if (costUSD === 0 && rates && typeof rates === 'object') {
    const inputRate = Number(rates.inputRate ?? rates.input ?? 3.0) / 1_000_000;
    const cacheWriteRate = Number(rates.cacheWriteRate ?? rates.cacheWrite ?? 3.75) / 1_000_000;
    const cacheReadRate = Number(rates.cacheReadRate ?? rates.cacheRead ?? 0.30) / 1_000_000;
    const outputRate = Number(rates.outputRate ?? rates.output ?? 15.0) / 1_000_000;
    costUSD =
      uncached * inputRate +
      (cacheWrite5m + cacheWrite1h) * cacheWriteRate +
      cacheRead * cacheReadRate +
      output * outputRate;
  }

  return {
    uncached: Math.max(0, uncached),
    cacheWrite5m: Math.max(0, cacheWrite5m),
    cacheWrite1h: Math.max(0, cacheWrite1h),
    cacheRead: Math.max(0, cacheRead),
    output: Math.max(0, output),
    thinking: Math.max(0, thinking),
    costUSD: Math.max(0, Number(costUSD.toFixed(6)))
  };
}

/**
 * Normalizes Antigravity session steps and transcripts into a USTF v1 trajectory.
 *
 * @param {object} raw - Antigravity session data (steps array, transcript lines, metadata)
 * @param {object} [options={}]
 * @returns {object}
 */
export function normalizeAntigravitySession(raw = {}, options = {}) {
  const sessionId = raw.sessionId || raw.session_id || options.sessionId || 'antigravity-session';
  const session = createEmptyUstfSession(sessionId, 'antigravity', {
    ...options,
    modelId: raw.modelId || options.modelId || 'gemini-2-5-pro'
  });

  const rawSteps = Array.isArray(raw.steps)
    ? raw.steps
    : Array.isArray(raw)
      ? raw
      : [];

  let currentTurnId = null;
  let turnIndex = 0;
  let currentTurnStartMs = session.startTimeMs;

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    if (!step || typeof step !== 'object') continue;

    const stepType = String(step.type || step.stepType || step.step_type || 'STEP').toUpperCase();
    const timestampMs = Number(step.createdAt || step.timestampMs || step.timestamp || (session.startTimeMs + i * 1000));
    const content = String(step.content || step.extractedText || '');

    if (stepType === 'USER_INPUT' || stepType === 'USER') {
      if (currentTurnId) {
        session.events.push({
          eventId: `turn-comp-${turnIndex}`,
          type: 'turn.complete',
          turnId: currentTurnId,
          timestampMs: timestampMs - 1
        });
      }
      turnIndex++;
      currentTurnId = `turn-${turnIndex}`;
      currentTurnStartMs = timestampMs;

      session.events.push({
        eventId: `turn-start-${turnIndex}`,
        type: 'turn.start',
        turnId: currentTurnId,
        timestampMs,
        payload: { userPrompt: content }
      });

      session.spans.push({
        spanId: currentTurnId,
        parentSpanId: null,
        kind: 'turn',
        name: `Turn ${turnIndex}`,
        startTimeMs: currentTurnStartMs,
        durationMs: 0,
        status: 'ok',
        attributes: { userPrompt: content }
      });
    } else if (stepType === 'TOOL_CALL' || stepType === 'CALL') {
      const toolName = step.toolName || step.tool_name || 'Tool';
      const toolInput = step.toolInput || step.tool_input || {};
      const spanId = `span-tool-${i}`;

      session.events.push({
        eventId: `ev-tool-call-${i}`,
        type: 'tool.call',
        turnId: currentTurnId || `turn-${turnIndex}`,
        timestampMs,
        payload: { toolName, toolInput, spanId }
      });

      session.spans.push({
        spanId,
        parentSpanId: currentTurnId,
        kind: 'tool',
        name: toolName,
        startTimeMs: timestampMs,
        durationMs: Number(step.durationMs || 50),
        status: step.status === 'ERROR' ? 'error' : 'ok',
        attributes: { toolName, input: toolInput }
      });
    } else if (stepType === 'TOOL_RESULT' || stepType === 'RESULT') {
      session.events.push({
        eventId: `ev-tool-result-${i}`,
        type: 'tool.result',
        turnId: currentTurnId || `turn-${turnIndex}`,
        timestampMs,
        payload: {
          toolName: step.toolName || step.tool_name,
          result: content.slice(0, 1000)
        }
      });
    } else {
      session.events.push({
        eventId: `ev-turn-step-${i}`,
        type: 'turn.step',
        turnId: currentTurnId || `turn-${turnIndex}`,
        timestampMs,
        payload: { stepType, content: content.slice(0, 1000) }
      });
    }

    if (step.usage) {
      const u = normalizeUsage(step.usage);
      session.usage.uncached += u.uncached;
      session.usage.cacheWrite5m += u.cacheWrite5m;
      session.usage.cacheWrite1h += u.cacheWrite1h;
      session.usage.cacheRead += u.cacheRead;
      session.usage.output += u.output;
      session.usage.thinking += u.thinking;
      session.usage.costUSD += u.costUSD;
    }
  }

  if (currentTurnId) {
    session.events.push({
      eventId: `turn-comp-${turnIndex}`,
      type: 'turn.complete',
      turnId: currentTurnId,
      timestampMs: session.startTimeMs + rawSteps.length * 1000
    });
  }

  return session;
}

/**
 * Normalizes Claude Code DAG entries / JSONL transcript into a USTF v1 trajectory.
 *
 * @param {string | object[] | object} raw - JSONL content, array of JSONL entries, or session object
 * @param {object} [options={}]
 * @returns {object}
 */
export function normalizeClaudeCodeSession(raw = {}, options = {}) {
  let entries = [];
  let sessionId = options.sessionId || 'claude-code-session';

  if (typeof raw === 'string') {
    entries = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } else if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === 'object') {
    sessionId = raw.sessionId || raw.session_id || sessionId;
    if (Array.isArray(raw.entries)) entries = raw.entries;
    else if (Array.isArray(raw.events)) entries = raw.events;
  }

  const session = createEmptyUstfSession(sessionId, 'claude-code', {
    ...options,
    modelId: options.modelId || 'claude-sonnet-5-5'
  });

  const nodeMap = new Map();
  const childrenMap = new Map();
  let explicitLeafUuid = null;
  let lastEntryUuid = null;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;

    if (e.leafUuid) explicitLeafUuid = e.leafUuid;
    const uuid = e.uuid || e.id || `node-${i}`;
    const parentUuid = e.parentUuid !== undefined ? e.parentUuid : lastEntryUuid;
    lastEntryUuid = uuid;

    nodeMap.set(uuid, { ...e, uuid, parentUuid, rawIndex: i });
    const pKey = parentUuid || '__ROOT__';
    if (!childrenMap.has(pKey)) childrenMap.set(pKey, []);
    childrenMap.get(pKey).push(uuid);
  }

  const activeTipUuid = explicitLeafUuid && nodeMap.has(explicitLeafUuid) ? explicitLeafUuid : lastEntryUuid;
  const activeChain = [];
  const activeUuidSet = new Set();
  let curr = activeTipUuid;

  while (curr && nodeMap.has(curr) && !activeUuidSet.has(curr)) {
    activeUuidSet.add(curr);
    activeChain.push(nodeMap.get(curr));
    curr = nodeMap.get(curr).parentUuid;
  }
  activeChain.reverse();

  // Find rewind branches
  for (const node of activeChain) {
    const siblings = childrenMap.get(node.uuid) || [];
    for (const childUuid of siblings) {
      if (!activeUuidSet.has(childUuid)) {
        session.rewindBranches.push({
          forkParentUuid: node.uuid,
          abandonedTipUuid: childUuid
        });
      }
    }
  }

  let turnIndex = 0;
  let currentTurnId = null;

  for (let i = 0; i < activeChain.length; i++) {
    const node = activeChain[i];
    const timestampMs = Number(node.timestamp || node.createdAt || (session.startTimeMs + i * 1000));
    const role = node.role || node.type || 'message';

    if (node.type === 'file-history-snapshot' || node.snapshot) {
      session.events.push({
        eventId: `ev-compact-${i}`,
        type: 'compact.lifecycle',
        timestampMs,
        payload: { snapshotFiles: Object.keys(node.snapshot?.trackedFileBackups || node.files || {}) }
      });
      continue;
    }

    if (role === 'user' || node.type === 'user_input') {
      if (currentTurnId) {
        session.events.push({
          eventId: `ev-turn-comp-${turnIndex}`,
          type: 'turn.complete',
          turnId: currentTurnId,
          timestampMs: timestampMs - 1
        });
      }
      turnIndex++;
      currentTurnId = `turn-${turnIndex}`;

      const text = typeof node.content === 'string'
        ? node.content
        : Array.isArray(node.content)
          ? node.content.map((c) => c.text || '').join('')
          : '';

      session.events.push({
        eventId: `ev-turn-start-${turnIndex}`,
        type: 'turn.start',
        turnId: currentTurnId,
        timestampMs,
        payload: { prompt: text }
      });

      session.spans.push({
        spanId: currentTurnId,
        parentSpanId: null,
        kind: 'turn',
        name: `Turn ${turnIndex}`,
        startTimeMs: timestampMs,
        durationMs: 0,
        status: 'ok',
        attributes: { prompt: text }
      });
    } else {
      // Assistant / Tool turns
      const contentBlocks = Array.isArray(node.content) ? node.content : [];
      for (const block of contentBlocks) {
        if (block.type === 'tool_use') {
          const spanId = `span-tool-${block.id || i}`;
          session.events.push({
            eventId: `ev-tool-call-${block.id || i}`,
            type: 'tool.call',
            turnId: currentTurnId || `turn-${turnIndex}`,
            timestampMs,
            payload: { toolName: block.name, toolInput: block.input, spanId }
          });

          session.spans.push({
            spanId,
            parentSpanId: currentTurnId,
            kind: 'tool',
            name: block.name,
            startTimeMs: timestampMs,
            durationMs: 50,
            status: 'ok',
            attributes: { toolName: block.name, input: block.input }
          });
        } else if (block.type === 'tool_result') {
          session.events.push({
            eventId: `ev-tool-result-${block.tool_use_id || i}`,
            type: 'tool.result',
            turnId: currentTurnId || `turn-${turnIndex}`,
            timestampMs,
            payload: { result: String(block.content || '').slice(0, 1000) }
          });
        }
      }

      session.events.push({
        eventId: `ev-step-${i}`,
        type: 'turn.step',
        turnId: currentTurnId || `turn-${turnIndex}`,
        timestampMs,
        payload: { role: 'assistant', messageId: node.message?.id || node.id }
      });
    }

    const rawUsage = node.message?.usage || node.usage;
    if (rawUsage) {
      const u = normalizeUsage(rawUsage);
      session.usage.uncached += u.uncached;
      session.usage.cacheWrite5m += u.cacheWrite5m;
      session.usage.cacheWrite1h += u.cacheWrite1h;
      session.usage.cacheRead += u.cacheRead;
      session.usage.output += u.output;
      session.usage.thinking += u.thinking;
      session.usage.costUSD += u.costUSD;
    }
  }

  if (currentTurnId) {
    session.events.push({
      eventId: `ev-turn-comp-${turnIndex}`,
      type: 'turn.complete',
      turnId: currentTurnId,
      timestampMs: session.startTimeMs + activeChain.length * 1000
    });
  }

  return session;
}

/**
 * Auto-detects the host format and normalizes into a USTF v1 trajectory.
 *
 * @param {any} rawInput
 * @param {object} [options={}]
 * @returns {object}
 */
export function normalizeSessionTrajectory(rawInput, options = {}) {
  if (!rawInput) {
    return createEmptyUstfSession('empty-session', 'claude-code', options);
  }

  if (typeof rawInput === 'string') {
    return normalizeClaudeCodeSession(rawInput, options);
  }

  if (rawInput.harness === 'antigravity' || Array.isArray(rawInput.steps)) {
    return normalizeAntigravitySession(rawInput, options);
  }

  if (rawInput.harness === 'claude-code' || rawInput.leafUuid || Array.isArray(rawInput.entries)) {
    return normalizeClaudeCodeSession(rawInput, options);
  }

  // Heuristic: check first item in array
  if (Array.isArray(rawInput)) {
    const first = rawInput[0];
    if (first && (first.step_type || first.stepType)) {
      return normalizeAntigravitySession(rawInput, options);
    }
    return normalizeClaudeCodeSession(rawInput, options);
  }

  return createEmptyUstfSession('unknown-session', 'claude-code', options);
}
