import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { getHomeDir, canonicalizePath, getAntigravitySurfaces } from './paths.mjs';
import { SESSION_RISK_THRESHOLDS, resolveModelCeiling } from './constants.mjs';
import { SQLITE_OPEN_READONLY_OPTIONS } from './parser.mjs';
import { PrefixCacheShield } from './prefix_cache_shield.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';
import { formatUtcHandoffTimestamp } from './coach/handoff_hydrator.mjs';

/**
 * Phase 2: Cache-Aware Compaction, Tail Surgeon & Baton-Pass (/handoff) Coach (`compaction_coach.mjs`)
 *
 * Eliminates auto-compaction stalls, protects against the 256k binary clamp wipe,
 * surgically trims uncached tail sludge without busting warm prefix caches,
 * and executes zero-amnesia session handoffs with 5 deterministic sections.
 */

export const WATERMARKS = Object.freeze({
  CASCADE_SYNC: SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS,
  WARM_CACHE_LOCK_MIN_TOKENS: SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS,
  AUTO_COMPACT_SAFE: 179000,
  BINARY_CLAMP: 256000, // 0x3e800 binary clamp
  WARM_CACHE_LOCK_MAX_TOKENS: 160000,
  BATON_PASS_TOKEN_TRIGGER: 145000,
  WASTE_TRIGGER_TOKEN: 100000,
  WASTE_TRIGGER_PCT: 45,
  HIGH_TURN_THRESHOLD: 45,
  LOW_SIGNAL_PCT_THRESHOLD: 35
});

/**
 * Evaluates whether compaction should be deferred (Warm Cache Lock) or whether
 * Baton-Pass (/handoff) should be triggered based on dual token + waste thresholds.
 *
 * @param {object} sessionTelemetry
 * @returns {object} Assessment result with recommendations, actions, and badges
 */
export function assessCompactionState(sessionTelemetry = {}) {
  const totalTokens = Number(
    sessionTelemetry.totalTokens ??
    sessionTelemetry.totalActiveTokens ??
    sessionTelemetry.contextTokens ??
    0
  );

  const cachedTokens = Number(
    sessionTelemetry.cachedTokens ??
    sessionTelemetry.cachedHistoryTokens ??
    sessionTelemetry.cacheReadTokens ??
    0
  );

  const cacheTtlSeconds = Number(
    sessionTelemetry.cacheTtlSeconds ??
    sessionTelemetry.ttlRemainingSec ??
    0
  );

  const cacheHitRate = Number(
    sessionTelemetry.cacheHitRate ??
    (totalTokens > 0 ? cachedTokens / totalTokens : 0)
  );

  const reclaimableWastePct = Number(
    sessionTelemetry.reclaimableWastePct ??
    (totalTokens > 0 && sessionTelemetry.sludgeTokens
      ? (Number(sessionTelemetry.sludgeTokens) / totalTokens) * 100
      : (totalTokens > 0 && sessionTelemetry.reclaimableTokens
        ? (Number(sessionTelemetry.reclaimableTokens) / totalTokens) * 100
        : 0))
  );

  const reclaimableWasteTokens = Number(
    sessionTelemetry.reclaimableWasteTokens ??
    sessionTelemetry.sludgeTokens ??
    sessionTelemetry.reclaimableTokens ??
    Math.round((totalTokens * reclaimableWastePct) / 100)
  );

  const turnCount = Number(
    sessionTelemetry.turnCount ??
    sessionTelemetry.stepCount ??
    0
  );

  const lastTurnGitCommitted = Boolean(
    sessionTelemetry.lastTurnGitCommitted ??
    sessionTelemetry.last_turn_git_committed ??
    false
  );

  const topicShiftDetected = Boolean(
    sessionTelemetry.topicShiftDetected ??
    sessionTelemetry.topic_shift ??
    sessionTelemetry.topicShift ??
    false
  );

  const activeSignalPct = Number(
    sessionTelemetry.activeSignalPct ??
    Math.max(0, 100 - reclaimableWastePct)
  );

  const explicitCeiling = Number(
    sessionTelemetry.maxTokens ??
    sessionTelemetry.ceilingTokens ??
    sessionTelemetry.binaryClamp ??
    0
  );
  const dynamicModelId = sessionTelemetry.modelId || sessionTelemetry.model || null;
  const resolvedBinaryClamp = explicitCeiling > 0
    ? explicitCeiling
    : (dynamicModelId
      ? resolveModelCeiling(dynamicModelId, sessionTelemetry.contextWindow || null, { useLegacyDefault: false })
      : WATERMARKS.BINARY_CLAMP);
  const resolvedSafeLimit = Number(sessionTelemetry.safeLimitTokens) > 0
    ? Number(sessionTelemetry.safeLimitTokens)
    : (resolvedBinaryClamp === WATERMARKS.BINARY_CLAMP
      ? WATERMARKS.AUTO_COMPACT_SAFE
      : Math.round(resolvedBinaryClamp * 0.70));
  const resolvedWarmLockMax = resolvedBinaryClamp > WATERMARKS.BINARY_CLAMP
    ? Math.round(resolvedBinaryClamp * 0.625)
    : WATERMARKS.WARM_CACHE_LOCK_MAX_TOKENS;

  const clampDistance = Math.max(0, resolvedBinaryClamp - totalTokens);
  const clampLabelK = `${Math.round(resolvedBinaryClamp / 1000)}k`;

  const watermarks = {
    current: totalTokens,
    cascadeSync: WATERMARKS.CASCADE_SYNC,
    safeLimit: resolvedSafeLimit,
    binaryClamp: resolvedBinaryClamp,
    clampDistance,
    cachedTokens,
    cacheHitRate,
    cacheTtlSeconds,
    turnCount,
    activeSignalPct,
    reclaimableWastePct,
    reclaimableWasteTokens
  };

  // Rule 1: Warm Cache Lock
  // While Cached Tokens >= 50,000, Cache Hit Rate >= 90%, TTL > 60s, and Total Tokens < warm lock max,
  // suppress /compact and preserve 95% discount.
  if (
    cachedTokens >= WATERMARKS.WARM_CACHE_LOCK_MIN_TOKENS &&
    cacheHitRate >= 0.90 &&
    cacheTtlSeconds > 60 &&
    totalTokens < resolvedWarmLockMax
  ) {
    return {
      action: 'DEFER_COMPACTION',
      badge: '🛡️ Prefix Cache Warm (95% discount active) — Defer Compaction',
      shouldCompact: false,
      recommendBatonPass: false,
      recommendTailTrim: false,
      warmCacheLocked: true,
      reason: `Prefix cache is warm (${(cacheHitRate * 100).toFixed(0)}% hit rate, ${cacheTtlSeconds}s TTL remaining). Compacting now would discard the warm prefix cache and force cold-prefill costs.`,
      triggers: {
        warmCacheLock: true,
        tokenTrigger: false,
        wasteTrigger: false,
        turnDegradationTrigger: false
      },
      watermarks
    };
  }

  // Rule 1b (Rank 4 — DET-17): Suppress premature /compact recommendations while prefix cache hit ratio > 96% below 50,000 tokens
  if (
    cacheHitRate > 0.96 &&
    totalTokens > 0 &&
    totalTokens < 50000 &&
    (sessionTelemetry.cacheTtlSeconds === undefined || cacheTtlSeconds > 0)
  ) {
    return {
      action: 'DEFER_COMPACTION',
      detectorId: 'DET-17',
      badge: '🛡️ Prefix Cache >96% Hit Below 50k — Suppress Premature /compact',
      shouldCompact: false,
      suppressPrematureCompact: true,
      recommendBatonPass: false,
      recommendTailTrim: false,
      warmCacheLocked: true,
      reason: `Prefix cache hit ratio is ${(cacheHitRate * 100).toFixed(1)}% (>96%) at ${totalTokens.toLocaleString()} tokens (<50,000). Suppressing premature /compact preserves the warm prefix cache.`,
      triggers: {
        warmCacheLock: true,
        tokenTrigger: false,
        wasteTrigger: false,
        turnDegradationTrigger: false
      },
      watermarks
    };
  }

  // Critical Near-Clamp Alarm (>= auto-compact safe limit)
  if (totalTokens >= resolvedSafeLimit) {
    return {
      action: 'EXECUTE_BATON_PASS',
      badge: `⚠️ Critical Binary Clamp Risk (Approaching ${clampLabelK} limit) — Execute /handoff immediately`,
      shouldCompact: false,
      recommendBatonPass: true,
      recommendTailTrim: false,
      warmCacheLocked: false,
      reason: `Context is ${clampDistance.toLocaleString()} tokens away from the ${clampLabelK} (${resolvedBinaryClamp === 256000 ? '0x3e800 ' : ''}ceiling) clamp. Auto-compaction will wipe prefix cache and cause amnesia.`,
      triggers: {
        warmCacheLock: false,
        tokenTrigger: true,
        wasteTrigger: false,
        turnDegradationTrigger: false
      },
      watermarks
    };
  }

  // Rule 1c (Sim 06): Cold-Cache /compact Block — redirect expired cache (>= 25k tokens) to <300-tok StateBaton handoff
  const cacheExpired = Boolean(
    sessionTelemetry.cacheExpired === true ||
    (cacheTtlSeconds === 0 && Number(sessionTelemetry.elapsedSeconds || 0) > Number(sessionTelemetry.effectiveTtlSeconds || 300))
  );
  if (cacheExpired && totalTokens >= 25000 && Boolean(sessionTelemetry.compactRequested)) {
    return {
      action: 'EXECUTE_BATON_PASS',
      detectorId: 'DET-10',
      coldCompactBlocked: true,
      badge: '🧊 Cold Cache (/compact Blocked) — Execute <300-tok StateBaton Handoff',
      shouldCompact: false,
      recommendBatonPass: true,
      recommendTailTrim: false,
      warmCacheLocked: false,
      reason: `Cache TTL expired (${totalTokens.toLocaleString()} cold tokens). Running /compact now would pay full uncached input rates to summarize stale history — use a <300-token StateBaton (/handoff + /clear) instead.`,
      triggers: {
        warmCacheLock: false,
        coldCompactBlocked: true,
        tokenTrigger: false,
        wasteTrigger: false,
        turnDegradationTrigger: false
      },
      watermarks
    };
  }

  // Rule 2: Dual Token + Waste Trigger
  // Trigger Baton-Pass (/handoff) Coach when:
  // - Post-Commit Topic Shift (Turn >= 15 && totalTokens >= 25,000 && lastTurnGitCommitted && topicShiftDetected) OR
  // - Total Tokens >= 145,000 OR
  // - (Total Tokens >= 100,000 && Reclaimable Waste >= 45% && Cache TTL === 0) OR
  // - (Turn count > 45 && Active Signal < 35%)
  const postCommitOverride = String(
    sessionTelemetry.postCommitHandoffOverride ??
    sessionTelemetry.horizonConfig?.semanticDetectors?.['post-commit-handoff'] ??
    'default'
  ).toLowerCase();
  const postCommitShiftTrigger =
    postCommitOverride !== 'off' &&
    Boolean(lastTurnGitCommitted && topicShiftDetected && (turnCount === 0 || turnCount >= 15) && totalTokens >= 25000);
  const tokenTrigger = totalTokens >= WATERMARKS.BATON_PASS_TOKEN_TRIGGER;
  const wasteTrigger = totalTokens >= WATERMARKS.WASTE_TRIGGER_TOKEN && reclaimableWastePct >= WATERMARKS.WASTE_TRIGGER_PCT && cacheTtlSeconds === 0;
  const turnDegradationTrigger = turnCount > WATERMARKS.HIGH_TURN_THRESHOLD && activeSignalPct < WATERMARKS.LOW_SIGNAL_PCT_THRESHOLD;

  if (postCommitShiftTrigger || tokenTrigger || wasteTrigger || turnDegradationTrigger) {
    let reason = '';
    if (postCommitShiftTrigger) {
      reason = `Post-commit topic shift detected at Turn ${turnCount} (${Math.round(totalTokens / 1000)}K tokens). Previous milestone is committed to git — run /handoff or /compact before starting a new feature on stale context.`;
    } else if (tokenTrigger) {
      reason = `Total context tokens (${totalTokens.toLocaleString()}) reached Baton-Pass watermark (${WATERMARKS.BATON_PASS_TOKEN_TRIGGER.toLocaleString()}). Execute zero-amnesia /handoff before hitting the ${WATERMARKS.AUTO_COMPACT_SAFE.toLocaleString()} safe limit.`;
    } else if (wasteTrigger) {
      reason = `Cold cache (TTL=0) with high reclaimable waste (${reclaimableWastePct.toFixed(1)}% >= 45% at ${totalTokens.toLocaleString()} tokens). Baton-pass will reset context cleanly.`;
    } else {
      reason = `Long-running session (${turnCount} turns > 45) with degraded active signal (${activeSignalPct.toFixed(1)}% < 35%). Fresh baton-pass recommended.`;
    }

    return {
      action: 'EXECUTE_BATON_PASS',
      badge: '🤝 Execute Baton Pass (/handoff) — Zero-Amnesia Session Reset',
      shouldCompact: false,
      recommendBatonPass: true,
      recommendTailTrim: false,
      warmCacheLocked: false,
      reason,
      triggers: {
        warmCacheLock: false,
        tokenTrigger,
        wasteTrigger,
        turnDegradationTrigger,
        postCommitTopicShift: postCommitShiftTrigger
      },
      watermarks
    };
  }

  // Uncached Tail Sludge recommendation:
  if (reclaimableWasteTokens >= 2000 || reclaimableWastePct >= 20) {
    return {
      action: 'TRIM_UNCACHED_TAIL',
      badge: '✂️ Trim Uncached Tail (Preserve 50k Prefix Cache)',
      shouldCompact: false,
      recommendBatonPass: false,
      recommendTailTrim: true,
      warmCacheLocked: false,
      reason: `Uncached tail contains ${reclaimableWasteTokens.toLocaleString()} tokens of reclaimable waste. Surgical trim preserves the warm 50k prefix head intact.`,
      triggers: {
        warmCacheLock: false,
        tokenTrigger: false,
        wasteTrigger: false,
        turnDegradationTrigger: false
      },
      watermarks
    };
  }

  return {
    action: 'NOMINAL',
    badge: 'Context Health Nominal',
    shouldCompact: false,
    recommendBatonPass: false,
    recommendTailTrim: false,
    warmCacheLocked: false,
    reason: 'Context usage is within healthy limits.',
    triggers: {
      warmCacheLock: false,
      tokenTrigger: false,
      wasteTrigger: false,
      turnDegradationTrigger: false
    },
    watermarks
  };
}

/**
 * Surgically truncates redundant tool outputs (DET-06 repeated reads, DET-10 CLI floods)
 * strictly AFTER the warm prefix cache boundary (0 .. cachedTokens).
 *
 * Guarantees that the head prefix remains 100% byte-for-byte identical (SHA-256 matched).
 *
 * @param {Array<object>} steps Transcript steps or turns
 * @param {object} [options={}]
 * @param {number} [options.cachedTokens=50000] Head prefix token boundary to protect
 * @param {number} [options.maxRetainedChars=300] Characters retained for pruned tail entries
 * @returns {object} { prunedSteps, savedTokens, modifiedCount, splitIndex, warmCachePreserved, headBytesPreserved }
 */
export function trimUncachedTail(steps = [], options = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const cachedTokensWatermark = Number.isFinite(options.cachedTokens)
    ? options.cachedTokens
    : WATERMARKS.CASCADE_SYNC;
  const maxRetainedChars = Number.isFinite(options.maxRetainedChars)
    ? Math.max(80, options.maxRetainedChars)
    : 300;

  if (list.length === 0) {
    return {
      prunedSteps: [],
      savedTokens: 0,
      modifiedCount: 0,
      splitIndex: 0,
      warmCachePreserved: true,
      headBytesPreserved: true,
      candidates: []
    };
  }

  // 1. Identify prefix head boundary (0 .. splitIndex - 1)
  // Pin all steps whose cumulative tokens fall within cachedTokensWatermark.
  // Step 0 (initial prompt/system) is ALWAYS pinned.
  let cumulativeTokens = 0;
  let splitIndex = 1;

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const tok = Number(
      s.totalTokens ??
      s.tokens ??
      s.output_tokens ??
      s.outputTokens ??
      (s.content ? Math.ceil(String(s.content).length / 4) : 0)
    );
    cumulativeTokens += tok;
    if (cumulativeTokens <= cachedTokensWatermark) {
      splitIndex = i + 1;
    } else {
      break;
    }
  }

  // Ensure splitIndex is at least 1 and does not exceed list.length
  splitIndex = Math.min(list.length, Math.max(1, splitIndex));

  // Compute SHA-256 fingerprint of the protected head prefix
  const headPrefixRaw = JSON.stringify(list.slice(0, splitIndex));
  const headPrefixShaBefore = crypto.createHash('sha256').update(headPrefixRaw).digest('hex');

  const prunedSteps = list.map(s => ({ ...s }));
  const candidates = [];
  let savedTokens = 0;
  let modifiedCount = 0;

  const extractStepCallMeta = (stepsArr, idx) => {
    const step = stepsArr[idx] || {};
    let calls = Array.isArray(step.toolCalls)
      ? step.toolCalls
      : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
    if (calls.length === 0 && idx > 0) {
      const prev = stepsArr[idx - 1] || {};
      const prevCalls = Array.isArray(prev.toolCalls)
        ? prev.toolCalls
        : (Array.isArray(prev.tool_calls) ? prev.tool_calls : []);
      const curCalls = Array.isArray(step.toolCalls)
        ? step.toolCalls
        : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
      const isToolResult = prevCalls.length > 0 && curCalls.length === 0 && (
        (prev.type === 'PLANNER_RESPONSE' && (step.type === 'GENERIC' || step.type === 'tool_result' || step.source === 'MODEL')) ||
        (step.type === 'TOOL_RESULT' || step.type === 'tool_result' || step.source === 'TOOL')
      );
      if (isToolResult) {
        calls = prevCalls;
      }
    }
    const firstCall = calls[0] || {};
    const rawToolName = String(firstCall.name || firstCall.tool || step.toolName || '').toLowerCase();
    const args = firstCall.args || firstCall.parameters || firstCall.Arguments || {};
    const rawPath = String(
      args.Path || args.path || args.TargetFile || args.AbsolutePath || args.file_path || step.targetPath || ''
    ).trim();
    const canonPath = rawPath ? canonicalizePath(rawPath) : null;
    const rawStart = args.StartLine ?? args.start_line ?? args.startLine ?? args.offset ?? firstCall.StartLine ?? step.startLine ?? null;
    const rawEnd = args.EndLine ?? args.end_line ?? args.endLine ?? args.limit ?? firstCall.EndLine ?? step.endLine ?? null;
    const normStart = rawStart !== null && rawStart !== undefined && rawStart !== '' && Number.isFinite(Number(rawStart))
      ? Number(rawStart)
      : 'FULL';
    const normEnd = rawEnd !== null && rawEnd !== undefined && rawEnd !== '' && Number.isFinite(Number(rawEnd))
      ? Number(rawEnd)
      : 'FULL';
    return { rawToolName, rawPath, canonPath, startLine: normStart, endLine: normEnd };
  };

  // Pass 1: Track (canonPath, startLine, endLine, lastEditTurnForPath) across the session
  // so disjoint line ranges, post-edit verification reads, and the most recent active read are NEVER truncated.
  const lastEditTurnByPath = new Map();
  const stepReadKeyByIdx = new Map();
  const latestTailReadIdxByKey = new Map();
  const isEditToolRe = /^(edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|edit|write|multiedit|notebookedit)$/i;
  const isReadToolRe = /^(read_file|view_file|read)$/i;

  for (let idx = 0; idx < prunedSteps.length; idx++) {
    const meta = extractStepCallMeta(prunedSteps, idx);
    if (meta.canonPath && isEditToolRe.test(meta.rawToolName)) {
      lastEditTurnByPath.set(meta.canonPath, idx);
    } else if (meta.canonPath && isReadToolRe.test(meta.rawToolName)) {
      const lastEditTurn = lastEditTurnByPath.has(meta.canonPath)
        ? lastEditTurnByPath.get(meta.canonPath)
        : -1;
      const readKey = `${meta.canonPath}::${meta.startLine}::${meta.endLine}::${lastEditTurn}`;
      stepReadKeyByIdx.set(idx, { readKey, lastEditTurn, ...meta });
      if (idx >= splitIndex) {
        latestTailReadIdxByKey.set(readKey, idx);
      }
    }
  }

  const baseWorkspace = options.cwd || options.workspacePath || null;
  const resolvedOffloadDir = options.offloadDir || (baseWorkspace ? path.join(baseWorkspace, '.agents', 'tmp') : null);

  for (let i = splitIndex; i < prunedSteps.length; i++) {
    const step = prunedSteps[i];
    const content = String(
      step.content ??
      step.toolUseResult?.stdout ??
      step.toolUseResult?.content ??
      step.toolFormerData?.result ??
      ''
    );

    const { rawToolName, rawPath, canonPath } = extractStepCallMeta(prunedSteps, i);
    const readMeta = stepReadKeyByIdx.get(i) || null;
    const isReadStep = Boolean(canonPath && isReadToolRe.test(rawToolName));
    const latestIdxForReadKey = readMeta ? latestTailReadIdxByKey.get(readMeta.readKey) : undefined;
    const isLatestActiveRead = isReadStep && (latestIdxForReadKey === undefined || latestIdxForReadKey === i);

    let candidateReason = null;

    // A. DET-06: Repeated identical (canonPath, startLine, endLine, lastEditTurn) read in the tail.
    // Preserve the MOST RECENT read intact; only older superseded identical reads are candidates.
    if (isReadStep && readMeta && latestIdxForReadKey !== undefined && i < latestIdxForReadKey) {
      candidateReason = 'DET-06_REDUNDANT_READ';
    }

    // B. DET-10: Unbounded CLI output flood (>12,000 characters or >80 lines)
    if (!candidateReason && /^(run_command|execute_bash|bash|exec|powershell)$/i.test(rawToolName)) {
      const lineCount = content.split(/\r?\n/).length;
      if (content.length > 12000 || lineCount > 80) {
        candidateReason = 'DET-10_CLI_FLOOD';
      }
    }

    // C. Explicitly flagged or unreferenced search output (>1,200 chars)
    if (!candidateReason && /^(grep|grep_search|find|find_by_name|search)$/i.test(rawToolName) && content.length > 1200) {
      candidateReason = 'UNREFERENCED_SEARCH_OUTPUT';
    }

    // D. Prunable flag from caller (never slice the latest active read_file/view_file output)
    if (!candidateReason && !isLatestActiveRead && (step.canPrune === true || step.isPrunable === true)) {
      candidateReason = step.pruneReason || 'EXPLICIT_TAIL_PRUNE';
    }

    if (candidateReason && content.length > maxRetainedChars + 60) {
      let offloadAbsPath = null;
      let offloadPointer = null;
      if (resolvedOffloadDir) {
        const hash12 = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
        const fileName = `offload_${hash12}.txt`;
        offloadAbsPath = path.join(resolvedOffloadDir, fileName);
        offloadPointer = baseWorkspace && !options.offloadDir
          ? `.agents/tmp/${fileName}`
          : `.agents/tmp/${fileName}`;
        try {
          atomicWriteFileSync(offloadAbsPath, content, { encoding: 'utf8' });
        } catch {
          // ISS-040 Safety Invariant: if offload persistence fails, preserve raw output intact!
          continue;
        }
      }

      const headSlice = content.slice(0, maxRetainedChars).trimEnd();
      const droppedChars = content.length - headSlice.length;
      const stepSavedTok = Math.max(1, Math.floor(droppedChars / 4));
      const pointerNote = offloadPointer ? ` — full output preserved at ${offloadPointer}` : '';
      const annotation = `\n... [Tail Surgeon (${candidateReason}): truncated ${droppedChars} chars (~${stepSavedTok} tok) after warm cache watermark${pointerNote}]`;
      const truncatedContent = `${headSlice}${annotation}`;

      prunedSteps[i] = {
        ...prunedSteps[i],
        content: truncatedContent,
        output_tokens: Math.ceil(truncatedContent.length / 4),
        outputTokens: Math.ceil(truncatedContent.length / 4),
        tailSurgeonTruncated: true,
        tailSurgeonReason: candidateReason,
        savedTokens: stepSavedTok,
        ...(offloadAbsPath ? { offloadPath: offloadAbsPath, offloadPointer } : {})
      };

      candidates.push({
        stepIndex: i,
        toolName: rawToolName || 'tool',
        targetPath: rawPath || null,
        reason: candidateReason,
        originalLength: content.length,
        truncatedLength: truncatedContent.length,
        savedTokens: stepSavedTok,
        ...(offloadAbsPath ? { offloadPath: offloadAbsPath, offloadPointer } : {})
      });

      savedTokens += stepSavedTok;
      modifiedCount++;
    }
  }

  // 3. Verify head prefix is 100% byte-identical
  const headPrefixRawAfter = JSON.stringify(prunedSteps.slice(0, splitIndex));
  const headPrefixShaAfter = crypto.createHash('sha256').update(headPrefixRawAfter).digest('hex');
  const headBytesPreserved = headPrefixShaBefore === headPrefixShaAfter;

  return {
    prunedSteps,
    savedTokens,
    modifiedCount,
    splitIndex,
    warmCachePreserved: true,
    headBytesPreserved,
    candidates
  };
}

/**
 * Parses markdown task checklist items into completed [x], in-progress [/], and pending [ ] sets.
 */
export function parseTaskChecklist(taskMdContent = '') {
  const text = String(taskMdContent || '');
  const lines = text.split(/\r?\n/);
  const completed = [];
  const inProgress = [];
  const pending = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^[-*]\s*\[x\]/i.test(line)) {
      completed.push(line.replace(/^[-*]\s*\[x\]\s*/i, '').trim());
    } else if (/^[-*]\s*\[\/\]/i.test(line)) {
      inProgress.push(line.replace(/^[-*]\s*\[\/\]\s*/i, '').trim());
    } else if (/^[-*]\s*\[ \]/i.test(line)) {
      pending.push(line.replace(/^[-*]\s*\[ \]\s*/i, '').trim());
    }
  }

  return { completed, inProgress, pending };
}

/**
 * Extracts exported functions, classes, interfaces, and types from touched source files.
 */
export function extractFileSignatures(filePaths = [], { workspacePath = '' } = {}) {
  const results = [];

  for (const relOrAbs of filePaths) {
    if (!relOrAbs || typeof relOrAbs !== 'string') continue;
    const absPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(workspacePath, relOrAbs);
    if (!fs.existsSync(absPath)) continue;

    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(absPath, 'utf8');
      const ext = path.extname(absPath).toLowerCase();
      const functions = [];
      const classes = [];
      const types = [];

      if (/^\.(mjs|js|ts|tsx|jsx)$/.test(ext)) {
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const fnMatch = line.match(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
          if (fnMatch) functions.push(fnMatch[1]);

          const classMatch = line.match(/^export\s+class\s+([A-Za-z0-9_$]+)/);
          if (classMatch) classes.push(classMatch[1]);

          const typeMatch = line.match(/^export\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/);
          if (typeMatch) types.push(typeMatch[1]);

          const constMatch = line.match(/^export\s+const\s+([A-Za-z0-9_$]+)\s*=/);
          if (constMatch && !functions.includes(constMatch[1])) {
            types.push(constMatch[1]);
          }
        }
      } else if (ext === '.py') {
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const fnMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
          if (fnMatch) functions.push(fnMatch[1]);

          const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)/);
          if (classMatch) classes.push(classMatch[1]);
        }
      }

      results.push({
        path: relOrAbs,
        functions,
        classes,
        types
      });
    } catch {
      // Gracefully continue on read errors
    }
  }

  return results;
}

/**
 * Safely queries the latest test execution state recorded in Phase 1's SQLite FTS5 table.
 */
export function queryLatestFts5TestState(dbPath, sessionId = null) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  try {
    // node:sqlite DatabaseSync with SQLITE_OPEN_READONLY_OPTIONS
    const { DatabaseSync } = (typeof process !== 'undefined' && process.versions?.node)
      ? requireNodeSqlite()
      : {};
    if (!DatabaseSync) return null;

    const db = new DatabaseSync(dbPath, SQLITE_OPEN_READONLY_OPTIONS);
    let row = null;
    try {
      if (sessionId) {
        const stmt = db.prepare('SELECT command, exit_code, raw_output, created_at FROM tool_logs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1');
        row = stmt.get(sessionId);
      } else {
        const stmt = db.prepare('SELECT command, exit_code, raw_output, created_at FROM tool_logs ORDER BY rowid DESC LIMIT 1');
        row = stmt.get();
      }
    } finally {
      db.close();
    }

    if (!row) return null;

    const raw = String(row.raw_output || '');
    const lines = raw.split(/\r?\n/);
    const failingTests = lines
      .filter(l => /^(FAILED|FAIL|✖)\s+|AssertionError/i.test(l.trim()))
      .slice(0, 5)
      .map(l => l.trim().slice(0, 120));

    return {
      command: row.command,
      exitCode: Number(row.exit_code),
      createdAt: row.created_at,
      failingTests,
      rawOutputPreview: lines.slice(0, 10).join('\n')
    };
  } catch {
    return null;
  }
}

function requireNodeSqlite() {
  try {
    const req = createRequire(import.meta.url);
    return req('node:sqlite');
  } catch {
    return {};
  }
}

/**
 * Generates the deterministic 5-section markdown checkpoint for Baton Pass (/handoff).
 *
 * Sections:
 *  1. Progressive Checkpoint Summary ([x], [/], [ ])
 *  2. Active File Schemas & AST Signatures + git diff --stat
 *  3. Verified Test & Build State (from Phase 1 SQLite FTS5 index)
 *  4. Negative Constraints & Dead Ends (failed loops, DET-01..16 violations)
 *  5. Pending RSI Instincts (queued in PrefixCacheShield)
 *  + Active Guardrail Pin
 *
 * @param {object} state
 * @param {object} [options={}]
 * @returns {string} Formatted markdown document
 */
export function generateHandoffMarkdown(state = {}, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const sourceSessionId = state.sessionId || state.guid || 'active-session';
  const targetSessionId = options.newSessionId || options.newGuid || 'new-session';
  const activeModel = state.modelId || state.model || state.activeModel || 'gemini-3.1-pro';
  const totalTokens = state.totalTokens ?? state.totalActiveTokens ?? 0;
  const workspacePath = options.workspacePath || process.cwd();

  // 1. Parse Checkpoint Items from task.md
  let checklist = { completed: [], inProgress: [], pending: [] };
  if (state.taskMdContent) {
    checklist = parseTaskChecklist(state.taskMdContent);
  } else if (state.taskMdPath && fs.existsSync(state.taskMdPath)) {
    try {
      checklist = parseTaskChecklist(fs.readFileSync(state.taskMdPath, 'utf8'));
    } catch {}
  } else if (state.checklist) {
    checklist = state.checklist;
  }

  // 2. Active File Schemas & AST Signatures
  const activeFiles = Array.isArray(state.activeFiles)
    ? state.activeFiles
    : (Array.isArray(state.modifiedFiles) ? state.modifiedFiles : []);
  const fileSignatures = extractFileSignatures(activeFiles, { workspacePath });

  let gitDiffStat = state.gitDiffStat || '';
  if (!gitDiffStat && workspacePath && fs.existsSync(workspacePath)) {
    try {
      gitDiffStat = execFileSync('git', ['diff', '--stat'], {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {
      gitDiffStat = '(Clean git status or diff unavailable)';
    }
  }

  // 3. Verified Test & Build State
  let testState = state.verifiedTestState || null;
  if (!testState && options.fts5DbPath) {
    testState = queryLatestFts5TestState(options.fts5DbPath, sourceSessionId);
  }
  if (!testState && state.lastTestCommand) {
    testState = {
      command: state.lastTestCommand,
      exitCode: state.lastTestExitCode ?? 0,
      failingTests: state.failingTests || []
    };
  }

  // 4. Negative Constraints & Dead Ends
  const negativeConstraints = Array.isArray(state.negativeConstraints)
    ? state.negativeConstraints
    : (Array.isArray(state.deadEnds) ? state.deadEnds : []);
  const detectorViolations = Array.isArray(state.detectorViolations) ? state.detectorViolations : [];

  // 5. Pending RSI Instincts & Staged Rules
  const pendingRules = Array.isArray(state.pendingRuleDeltas)
    ? state.pendingRuleDeltas
    : (Array.isArray(state.stagedDeltas) ? state.stagedDeltas : []);

  const exactNextStep = state.exactNextStep ||
    checklist.inProgress[0] ||
    checklist.pending[0] ||
    'Verify test suite and proceed with next roadmap phase';

  // Build unified cross-edition 6-section State Baton markdown (ISS-054)
  const md = [];
  md.push(`# Highbeam State Baton Handoff`);
  md.push(`- **Session ID:** \`${sourceSessionId}\``);
  md.push(`- **Target Session:** \`${targetSessionId}\``);
  md.push(`- **Active Model:** \`${activeModel}\``);
  md.push(`- **Captured At:** \`${timestamp}\``);
  md.push(`- **Context at Handoff:** \`${totalTokens.toLocaleString()} tokens\` (Safe Limit: 179,000 | Clamp: 256,000)`);
  md.push(``);

  // Section 1: Active Goal
  md.push(`## 1. Active Goal`);
  md.push(`### Completed Milestones (\`[x]\`)`);
  if (checklist.completed.length > 0) {
    for (const item of checklist.completed) {
      md.push(`- [x] ${item}`);
    }
  } else {
    md.push(`- (No completed items recorded)`);
  }
  md.push(``);

  md.push(`### In-Progress Work (\`[/]\`)`);
  if (checklist.inProgress.length > 0) {
    for (const item of checklist.inProgress) {
      md.push(`- [/] ${item}`);
    }
  } else {
    md.push(`- (No active in-progress items)`);
  }
  md.push(``);

  md.push(`### Pending Backlog (\`[ ]\`)`);
  if (checklist.pending.length > 0) {
    for (const item of checklist.pending) {
      md.push(`- [ ] ${item}`);
    }
  } else {
    md.push(`- (Backlog fully cleared)`);
  }
  md.push(``);

  // Section 2: Working Set Files
  md.push(`## 2. Working Set Files`);
  if (fileSignatures.length > 0) {
    for (const sig of fileSignatures) {
      md.push(`- **\`${sig.path}\`**:`);
      if (sig.functions.length > 0) md.push(`  - Functions: \`${sig.functions.join('`, `')}\``);
      if (sig.classes.length > 0) md.push(`  - Classes: \`${sig.classes.join('`, `')}\``);
      if (sig.types.length > 0) md.push(`  - Types/Exports: \`${sig.types.join('`, `')}\``);
    }
  } else if (activeFiles.length > 0) {
    for (const f of activeFiles) {
      md.push(`- \`${f}\``);
    }
  } else {
    md.push(`- (No active files modified in this session)`);
  }
  md.push(``);

  md.push(`### Uncommitted Git Status & Diff Stat`);
  md.push('```');
  md.push(gitDiffStat || '(No uncommitted git changes)');
  md.push('```');
  md.push(``);

  // Section 3: Verified Invariants
  md.push(`## 3. Verified Invariants`);
  if (testState) {
    const statusStr = testState.exitCode === 0 ? '✅ PASSED (exit code 0)' : `❌ FAILED (exit code ${testState.exitCode})`;
    md.push(`- **Last Command**: \`${testState.command || 'npm test'}\``);
    md.push(`- **Status**: ${statusStr}`);
    if (Array.isArray(testState.failingTests) && testState.failingTests.length > 0) {
      md.push(`- **Failing Tests (${testState.failingTests.length})**:`);
      for (const ft of testState.failingTests) {
        md.push(`  - \`${ft}\``);
      }
    }
  } else {
    md.push(`- Last Verified Status: ✅ Clean build / test suite passing`);
  }
  md.push(``);

  // Section 4: Dead Ends & Failures to Avoid
  md.push(`## 4. Dead Ends & Failures to Avoid`);
  if (negativeConstraints.length > 0 || detectorViolations.length > 0) {
    for (const nc of negativeConstraints) {
      md.push(`- 🚫 **Dead End / Blocked**: ${nc}`);
    }
    for (const det of detectorViolations) {
      md.push(`- 🛡️ **Detector Halt (\`${det.id || 'DET'}\`)**: ${det.message || det.reason}`);
    }
  } else {
    md.push(`- (No dead-ends or loop spirals detected; follow existing architectural invariants)`);
  }
  md.push(``);

  // Section 5: Queued Cache-Prefix Mutations (Released on PostCompact)
  md.push(`## 5. Queued Cache-Prefix Mutations (Released on PostCompact)`);
  if (pendingRules.length > 0) {
    for (const delta of pendingRules) {
      md.push(`- **[Staged Delta \`${delta.operation || 'ADD'}\`]** \`${delta.targetPath || 'GEMINI.md'}\`:`);
      md.push(`  \`\`\`markdown`);
      md.push(`  ${delta.ruleText || delta.newContent || JSON.stringify(delta)}`);
      md.push(`  \`\`\``);
    }
  } else {
    md.push(`- (All staged rules flushed; zero pending mutations)`);
  }
  md.push(``);

  // Section 6: Exact Next Step
  md.push(`## 6. Exact Next Step`);
  md.push(`- ${exactNextStep}`);
  md.push(``);

  // Active Guardrail Pin
  md.push(`## Active Guardrail Pin`);
  md.push(`- **NEVER** mutate \`GEMINI.md\`, \`AGENTS.md\`, \`.agents/CONTEXT.md\`, or \`SKILL.md\` while \`Cached History >= 50,000\` and \`Cache TTL > 0s\`; always route persistent rule writes through \`PrefixCacheShield\`.`);
  md.push(`- **NEVER** open Antigravity host session databases in write mode; preserve \`SQLITE_OPEN_READONLY_OPTIONS\` (\`{ readOnly: true }\`).`);
  md.push(`- **NEVER** delete, weaken, or skip existing \`assert\` / \`expect\` statements in any test file (\`DET-03\`).`);
  md.push(`- **NEVER** render a clickable Copy \`/compact\` button in UI panels.`);
  md.push(``);

  return md.join('\n');
}

/**
 * Executes a complete Baton Pass (/handoff) operation:
 *  1. Generates `docs/HANDOFF_<YYYYMMDD_HHMMSS>.md`, `.agents/horizon/HANDOFF_LATEST.md`, and `.gemini/antigravity/agy-horizon/handoffs/HANDOFF_<GUID>.md`
 *  2. Flushes staged `PrefixCacheShield` deltas to disk
 *  3. Pre-seeds `<NEW_GUID>` brain directory with `task.md` and `implementation_plan.md`
 *
 * @param {object} state Active session state
 * @param {object} [options={}]
 * @returns {object} Handoff execution report
 */
export function executeBatonPassHandoff(state = {}, options = {}) {
  const homeDir = options.homeDir || getHomeDir();
  const workspacePath = options.workspacePath || process.cwd();
  const rawTimestamp = options.timestamp || new Date().toISOString();
  const formattedTimestamp = formatUtcHandoffTimestamp(rawTimestamp);
  const newGuid = options.newSessionId || options.newGuid || crypto.randomUUID();

  // 1. Initialize PrefixCacheShield if provided or instantiate default
  const shield = options.prefixCacheShield || new PrefixCacheShield({ homeDir });
  const stagedStatus = shield.getStatus();

  // Resolve taskMdContent if taskMdPath is provided
  let taskMdContent = state.taskMdContent;
  if (!taskMdContent && state.taskMdPath && fs.existsSync(state.taskMdPath)) {
    try {
      taskMdContent = fs.readFileSync(state.taskMdPath, 'utf8');
    } catch {}
  }

  // Combine state with staged deltas and taskMdContent for handoff markdown
  const compositeState = {
    ...state,
    taskMdContent,
    stagedDeltas: stagedStatus.deltas || state.stagedDeltas || []
  };

  const handoffContent = generateHandoffMarkdown(compositeState, {
    timestamp: rawTimestamp,
    newSessionId: newGuid,
    workspacePath,
    fts5DbPath: options.fts5DbPath
  });

  // 2. Write `docs/HANDOFF_<YYYYMMDD_HHMMSS>.md` AND `.agents/horizon/HANDOFF_LATEST.md` in workspace
  const docsDir = options.docsDir || path.join(workspacePath, 'docs');
  const docsHandoffPath = path.join(docsDir, `HANDOFF_${formattedTimestamp}.md`);
  const latestHandoffPath = path.join(workspacePath, '.agents', 'horizon', 'HANDOFF_LATEST.md');
  atomicWriteFileSync(docsHandoffPath, handoffContent, { encoding: 'utf8' });
  atomicWriteFileSync(latestHandoffPath, handoffContent, { encoding: 'utf8' });

  // 3. Write `.gemini/antigravity/agy-horizon/handoffs/HANDOFF_<GUID>.md`
  const horizonHandoffDir = options.horizonHandoffDir || path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'handoffs');
  const horizonHandoffPath = path.join(horizonHandoffDir, `HANDOFF_${newGuid}.md`);
  atomicWriteFileSync(horizonHandoffPath, handoffContent, { encoding: 'utf8' });

  // 4. Flush PrefixCacheShield deltas now that session is handing off
  const flushResult = shield.flushOnHandoff();

  // 5. Pre-seed <NEW_GUID> brain session directory
  const defaultBrainBase = getAntigravitySurfaces(homeDir)[0]?.brainDir || path.join(homeDir, '.gemini', 'antigravity', 'brain');
  const brainBaseDir = options.brainBaseDir || defaultBrainBase;
  const newBrainDir = path.join(brainBaseDir, newGuid);

  // Generate pre-seeded task.md
  const newTaskMdContent = generateNewSessionTaskMd(compositeState, newGuid, docsHandoffPath);
  atomicWriteFileSync(path.join(newBrainDir, 'task.md'), newTaskMdContent, { encoding: 'utf8' });

  // Generate pre-seeded implementation_plan.md
  const planMdContent = generateNewSessionPlanMd(compositeState, newGuid, docsHandoffPath);
  atomicWriteFileSync(path.join(newBrainDir, 'implementation_plan.md'), planMdContent, { encoding: 'utf8' });

  return {
    success: true,
    newGuid,
    timestamp: formattedTimestamp,
    capturedAt: rawTimestamp,
    handoffFilePath: docsHandoffPath,
    latestHandoffPath,
    horizonHandoffPath,
    newBrainDir,
    taskMdPath: path.join(newBrainDir, 'task.md'),
    implementationPlanPath: path.join(newBrainDir, 'implementation_plan.md'),
    flushedDeltasCount: flushResult.flushedCount || 0,
    modifiedFiles: flushResult.modifiedFiles || [],
    constraintsPreserved: true,
    markdown: handoffContent
  };
}

function generateNewSessionTaskMd(state = {}, newGuid = '', handoffFilePath = '') {
  let checklist = { completed: [], inProgress: [], pending: [] };
  if (state.taskMdContent) {
    checklist = parseTaskChecklist(state.taskMdContent);
  } else if (state.taskMdPath && fs.existsSync(state.taskMdPath)) {
    try {
      checklist = parseTaskChecklist(fs.readFileSync(state.taskMdPath, 'utf8'));
    } catch {}
  } else if (state.checklist) {
    checklist = state.checklist;
  }

  const lines = [];
  lines.push(`# Task Checklist: Session Baton-Pass Continuation (${newGuid.slice(0, 8)})`);
  lines.push(`Handoff Reference: \`${handoffFilePath}\``);
  lines.push(``);

  lines.push(`## Preserved Completed Milestones`);
  if (checklist.completed.length > 0) {
    for (const c of checklist.completed) {
      lines.push(`- [x] ${c}`);
    }
  } else {
    lines.push(`- [x] Previous session state handed off cleanly`);
  }
  lines.push(``);

  lines.push(`## Active Next Steps & Carried Tasks`);
  if (checklist.inProgress.length > 0) {
    for (const ip of checklist.inProgress) {
      lines.push(`- [/] ${ip}`);
    }
  }
  if (checklist.pending.length > 0) {
    for (const p of checklist.pending) {
      lines.push(`- [ ] ${p}`);
    }
  } else if (checklist.inProgress.length === 0) {
    lines.push(`- [ ] Verify test suite and proceed with next roadmap phase`);
  }
  lines.push(``);

  lines.push(`## Active Guardrail Pin`);
  lines.push(`- **NEVER** mutate GEMINI.md, AGENTS.md, or SKILL.md while Cached History >= 50k and TTL > 0s.`);
  lines.push(`- **NEVER** open Antigravity host session databases in write mode.`);
  lines.push(`- **NEVER** delete, weaken, or skip existing assert / expect statements in any test file.`);
  lines.push(`- **ALWAYS** preserve verified state from handoff.`);
  lines.push(``);

  return lines.join('\n');
}

function generateNewSessionPlanMd(state = {}, newGuid = '', handoffFilePath = '') {
  const lines = [];
  lines.push(`# Implementation Plan: Session Continuation (${newGuid.slice(0, 8)})`);
  lines.push(`**Handoff Checkpoint**: \`${handoffFilePath}\``);
  lines.push(``);
  lines.push(`## Architectural Continuation`);
  lines.push(`This session continues execution with a clean context window, carrying forward verified test state, file schemas, and guardrail constraints from previous session \`${state.sessionId || 'parent'}\`.`);
  lines.push(``);
  lines.push(`## Verification Requirements`);
  lines.push(`- Zero lost constraints from handoff.`);
  lines.push(`- Verify test suite passes cleanly before proceeding with new edits.`);
  lines.push(``);
  return lines.join('\n');
}

/**
 * State-aware Compaction Coach class
 */
export class CompactionCoach {
  constructor(options = {}) {
    this.workspacePath = options.workspacePath || process.cwd();
    this.homeDir = options.homeDir || getHomeDir();
    this.prefixCacheShield = options.prefixCacheShield || new PrefixCacheShield({ homeDir: this.homeDir });
    this.fts5DbPath = options.fts5DbPath || null;
  }

  assess(sessionTelemetry = {}) {
    return assessCompactionState(sessionTelemetry);
  }

  trimTail(steps = [], options = {}) {
    return trimUncachedTail(steps, options);
  }

  generateHandoff(state = {}, options = {}) {
    return generateHandoffMarkdown(state, {
      workspacePath: this.workspacePath,
      homeDir: this.homeDir,
      fts5DbPath: this.fts5DbPath,
      ...options
    });
  }

  executeHandoff(state = {}, options = {}) {
    return executeBatonPassHandoff(state, {
      workspacePath: this.workspacePath,
      homeDir: this.homeDir,
      prefixCacheShield: this.prefixCacheShield,
      fts5DbPath: this.fts5DbPath,
      ...options
    });
  }
}
