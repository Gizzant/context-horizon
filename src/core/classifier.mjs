import path from 'node:path';
import { HORIZON_WINDOW, CATEGORIES, MODEL_PRICING_PER_MILLION, EFFORT_PROFILES, resolveEffortProfile, resolveModelCeiling, scaleEffortProfileForCeiling } from './constants.mjs';
import { canonicalizePath } from './paths.mjs';
import { extractEffortTimeline } from './parser.mjs';
import { computeQuotaAndCacheTelemetry } from './quota.mjs';
import { inspectSubagentTree } from './subagents.mjs';

/**
 * Calculates U-Shaped Attention Recall Curve weight A(i) for cell i in [0..totalCells-1]
 */
export function calculateAttentionWeight(cellIndex, activeCellCount) {
  if (activeCellCount <= 1) return 1.0;
  const leftDecay = Math.exp(-cellIndex / 4.5);
  const rightDecay = Math.exp(-(activeCellCount - 1 - cellIndex) / 5.5);
  const raw = 0.20 + 0.80 * Math.max(leftDecay, rightDecay);
  return Math.min(1.0, Math.max(0.20, parseFloat(raw.toFixed(2))));
}

/**
 * Classifies an array of parsed steps into a full 40-cell HorizonStatePayload
 */
export function classifyHorizon(rawSteps, options = {}) {
  const {
    sessionId = 'unknown',
    storeSource = 'antigravity',
    logTierUsed = 1,
    logFilePath = '',
    canonicalWorkspace = '',
    projectId = '',
    kiBleedMap = new Map(),
    modelId = 'gemini-3.8-flash',
    stdinContextWindow = null,
    stdinQuota = null,
    maxTokensOverride = null,
    useNativeCeiling = false,
    cacheDir = null,
    safeLimitTokens = undefined,
    reminderAtPct = 85
  } = options;

  let lastCheckpointIdx = -1;
  for (let i = rawSteps.length - 1; i >= 0; i--) {
    if (rawSteps[i] && rawSteps[i].type === 'CHECKPOINT') {
      lastCheckpointIdx = i;
      break;
    }
  }
  const steps = lastCheckpointIdx >= 0 ? rawSteps.slice(lastCheckpointIdx) : rawSteps;

  const resolvedMaxTokens = Number(maxTokensOverride) >= 20000
    ? Number(maxTokensOverride)
    : resolveModelCeiling(modelId, stdinContextWindow, { useLegacyDefault: !useNativeCeiling });

  const parsedEffort = extractEffortTimeline(rawSteps);
  const rawEffortProfile = options.activeEffortProfile
    ? { ...options.activeEffortProfile }
    : (options.turnMetadata ? resolveEffortProfile(options.turnMetadata) : parsedEffort.activeEffortProfile);
  const activeEffortProfile = scaleEffortProfileForCeiling(rawEffortProfile, resolvedMaxTokens);
  const rawTransitions = Array.isArray(options.effortTransitions)
    ? options.effortTransitions
    : parsedEffort.effortHistory;

  const defaultSafeLimit = activeEffortProfile?.safeLimit || HORIZON_WINDOW.AMPUTATION_THRESHOLD_TOKENS;
  const safeLimit = Number(safeLimitTokens) > 0 ? Number(safeLimitTokens) : defaultSafeLimit;
  const reminderAt = Math.round(safeLimit * (Number(reminderAtPct) > 0 ? Number(reminderAtPct) : 85) / 100);

  // Track file operations for stale duplicate detection & semantic reference pinning
  const latestFileTouchStep = new Map();
  const fileTouchCounts = new Map();
  const activeBackgroundDaemons = [];
  const activeWindowStart = Math.max(0, steps.length - HORIZON_WINDOW.ACTIVE_SET_STEP_WINDOW);
  const activeReferenceTokens = new Set();

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    const calls = step.toolCalls || [];
    if (idx >= activeWindowStart) {
      const recentText = `${step.content || ''} ${JSON.stringify(calls)}`.toLowerCase();
      const identMatches = recentText.match(/[a-z0-9_.-]{4,64}/g) || [];
      for (const tok of identMatches) activeReferenceTokens.add(tok);
    }
    for (const call of calls) {
      const name = (call.name || '').toLowerCase();
      const args = call.args || {};
      const targetFile = args.Path || args.path || args.Target || args.target;
      if (targetFile && typeof targetFile === 'string') {
        const canon = canonicalizePath(targetFile);
        latestFileTouchStep.set(canon, idx);
        fileTouchCounts.set(canon, (fileTouchCounts.get(canon) || 0) + 1);
      }

      if (name === 'run_command') {
        if (args.IsDaemon === true) {
          activeBackgroundDaemons.push({
            taskId: args.TaskId || `step-${idx}`,
            command: args.CommandLine || '',
            stepIndex: idx
          });
        }
      } else if (name === 'manage_task') {
        if (args.Action === 'kill' && args.TaskId) {
          const dIdx = activeBackgroundDaemons.findIndex(d => d.taskId === args.TaskId);
          if (dIdx !== -1) activeBackgroundDaemons.splice(dIdx, 1);
        }
      }
    }
  }

  // Classify each step into categories & tokens
  const totalTurns = steps.length;
  let totalActiveTokens = 0;
  const classifiedSteps = [];

  const categoryTotals = {
    [CATEGORIES.ANCHOR]: 0,
    [CATEGORIES.MEMORY_KI]: 0,
    [CATEGORIES.FOREIGN_BLEED]: 0,
    [CATEGORIES.STALE_DUPLICATE]: 0,
    [CATEGORIES.DEAD_ERROR]: 0,
    [CATEGORIES.ACTIVE_WORKING_SET]: 0,
    [CATEGORIES.FREE_HEADROOM]: 0
  };

  const offenderMap = new Map();
  let rawLiveTokens = 0;

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    let tokens = step.inputTokens > 0 && step.outputTokens > 0
      ? Math.max(step.outputTokens, Math.round(step.untruncatedLength / 4))
      : (step.outputTokens || Math.round(step.untruncatedLength / 4) || 1000);

    if (step.stepIndex === 0 && step.inputTokens > 0) {
      tokens = step.inputTokens;
    }

    let category = CATEGORIES.ACTIVE_WORKING_SET;
    let target = '';

    const contentStr = String(step.content || '');
    const calls = step.toolCalls || [];
    const isError = step.status === 'ERROR' || step.exitCode === 1 || contentStr.includes('Traceback (most recent call last)');

    // 1. Anchor detection
    if (
      step.stepIndex === 0 ||
      step.type === 'CHECKPOINT' ||
      step.type === 'SYSTEM_PROMPT' ||
      contentStr.includes('rules/') ||
      contentStr.includes('task.md') ||
      contentStr.includes('implementation_plan.md')
    ) {
      category = CATEGORIES.ANCHOR;
      target = 'System & Project Anchors';
    }
    // 2. Knowledge Memory & Bleed detection
    else if (
      contentStr.includes('knowledge://') ||
      calls.some(c => (c.name || '').includes('knowledge') || (c.args?.Uri || '').includes('knowledge'))
    ) {
      let isBleed = false;
      for (const [kiName, info] of kiBleedMap.entries()) {
        if (contentStr.includes(kiName) || calls.some(c => JSON.stringify(c).includes(kiName))) {
          if (info.isBleed) isBleed = true;
        }
      }
      category = isBleed ? CATEGORIES.FOREIGN_BLEED : CATEGORIES.MEMORY_KI;
      target = isBleed ? 'Foreign Bleed Knowledge' : 'Project Knowledge Item';
    }
    // 3. Dead Error detection
    else if (isError) {
      category = CATEGORIES.DEAD_ERROR;
      const cmdCall = calls.find(c => (c.name || '').toLowerCase() === 'run_command');
      target = cmdCall?.args?.CommandLine ? `Command: ${cmdCall.args.CommandLine}` : 'Resolved Stack Trace';
      const off = offenderMap.get(target) || { category, target, occurrences: 0, wastedTokens: 0, stepIndices: [] };
      off.occurrences += 1;
      off.wastedTokens += tokens;
      off.stepIndices.push(idx);
      offenderMap.set(target, off);
    }
    // 4. Stale duplicate detection with Semantic Reference Pinning (T2.2)
    else {
      let isStale = false;
      let stepFileBasename = '';
      for (const call of calls) {
        const name = (call.name || '').toLowerCase();
        const args = call.args || {};
        const targetFile = args.Path || args.path;
        if (targetFile) {
          const canon = canonicalizePath(targetFile);
          stepFileBasename = path.basename(String(targetFile)).toLowerCase();
          const latestIdx = latestFileTouchStep.get(canon);
          if (latestIdx !== undefined && latestIdx > idx) {
            isStale = true;
            target = targetFile;
            break;
          }
        }
      }

      let semanticallyPinned = false;
      if (!isStale && idx < totalTurns - HORIZON_WINDOW.STALE_STEP_THRESHOLD) {
        // Check if this older turn defines a file or schema/type symbol still referenced in the active window
        const declMatch = contentStr.match(/\b(?:interface|type|class|struct|CREATE\s+TABLE|schema)\s+([A-Za-z0-9_]{4,64})/i);
        const declaredSymbol = declMatch ? declMatch[1].toLowerCase() : '';
        if (
          (stepFileBasename && activeReferenceTokens.has(stepFileBasename)) ||
          (declaredSymbol && activeReferenceTokens.has(declaredSymbol))
        ) {
          semanticallyPinned = true;
          isStale = false;
          target = stepFileBasename ? `Pinned Reference (${stepFileBasename})` : `Pinned Schema (${declaredSymbol})`;
        } else {
          isStale = true;
          target = 'Older chat history (>25 turns ago)';
        }
      }

      if (isStale) {
        category = CATEGORIES.STALE_DUPLICATE;
        const off = offenderMap.get(target || 'Stale Read') || { category, target: target || 'Stale Read', occurrences: 0, wastedTokens: 0, stepIndices: [] };
        off.occurrences += 1;
        off.wastedTokens += tokens;
        off.stepIndices.push(idx);
        offenderMap.set(target || 'Stale Read', off);
      } else {
        category = CATEGORIES.ACTIVE_WORKING_SET;
        if (!semanticallyPinned) target = 'Active Coding & Context';
      }
    }

    categoryTotals[category] += tokens;
    totalActiveTokens += tokens;
    // Live session work = pinned task/plan state + recent active turns; the rest of the useful set is workspace baseline
    const isRuleAnchor = step.stepIndex === 0 || step.type === 'SYSTEM_PROMPT' || contentStr.includes('rules/');
    if (category === CATEGORIES.ACTIVE_WORKING_SET || (category === CATEGORIES.ANCHOR && !isRuleAnchor)) rawLiveTokens += tokens;

    classifiedSteps.push({
      stepIndex: idx,
      category,
      tokens,
      target,
      semanticallyPinned: target.startsWith('Pinned '),
      rawContent: contentStr
    });
  }

  const rawTotalTokens = Math.max(1, totalActiveTokens);
  // Reconcile total active tokens with stdin context window if provided
  if (stdinContextWindow && stdinContextWindow.total_input_tokens > 0) {
    const scale = stdinContextWindow.total_input_tokens / Math.max(1, totalActiveTokens);
    totalActiveTokens = stdinContextWindow.total_input_tokens;
    for (const cat of Object.keys(categoryTotals)) {
      categoryTotals[cat] = Math.round(categoryTotals[cat] * scale);
    }
    for (const s of classifiedSteps) {
      s.tokens = Math.round(s.tokens * scale);
    }
  }

  // If session crosses 200k tokens on legacy default, auto-promote ceiling to 256k (or 1M) so 40 cells never overflow
  const effectiveMaxTokens = (totalActiveTokens > resolvedMaxTokens && resolvedMaxTokens === 200000)
    ? (totalActiveTokens > 256000 ? 1000000 : 256000)
    : resolvedMaxTokens;
  const effectiveCellSize = Math.max(
    Math.round(effectiveMaxTokens / HORIZON_WINDOW.TOTAL_CELLS),
    Math.ceil(totalActiveTokens / HORIZON_WINDOW.TOTAL_CELLS) || HORIZON_WINDOW.CELL_SIZE_TOKENS
  );

  const freeHeadroom = Math.max(0, effectiveMaxTokens - totalActiveTokens);
  categoryTotals[CATEGORIES.FREE_HEADROOM] = freeHeadroom;

  // Build the 40 cells chronologically (Turn 0 on left -> Current Turn on right)
  const cells = [];
  const activeCellsCount = Math.min(HORIZON_WINDOW.TOTAL_CELLS, Math.ceil(totalActiveTokens / effectiveCellSize));

  let currentStepIdx = 0;
  let stepTokenOffset = 0;

  for (let cellIdx = 0; cellIdx < HORIZON_WINDOW.TOTAL_CELLS; cellIdx++) {
    const cellStartToken = cellIdx * effectiveCellSize;
    const cellEndToken = (cellIdx + 1) * effectiveCellSize;

    if (cellStartToken >= totalActiveTokens) {
      cells.push({
        index: cellIdx,
        tokenRange: [cellStartToken, cellEndToken],
        turnRange: [-1, -1],
        dominantCategory: CATEGORIES.FREE_HEADROOM,
        isAmputationZone: false,
        isCrisisCell: false,
        attentionWeight: 0.20,
        tokensByCategory: { [CATEGORIES.FREE_HEADROOM]: effectiveCellSize },
        topTarget: 'Free Token Headroom'
      });
      continue;
    }

    const bucketCategories = {};
    let bucketTokensRemaining = Math.min(effectiveCellSize, totalActiveTokens - cellStartToken);
    let cellTurns = [];
    let dominantCat = CATEGORIES.ACTIVE_WORKING_SET;
    let maxCatTokens = -1;
    let topTarget = '';

    while (bucketTokensRemaining > 0 && currentStepIdx < classifiedSteps.length) {
      const step = classifiedSteps[currentStepIdx];
      const stepRemainingTokens = step.tokens - stepTokenOffset;
      const consume = Math.min(bucketTokensRemaining, stepRemainingTokens);

      bucketCategories[step.category] = (bucketCategories[step.category] || 0) + consume;
      if (bucketCategories[step.category] > maxCatTokens) {
        maxCatTokens = bucketCategories[step.category];
        dominantCat = step.category;
        topTarget = step.target;
      }

      cellTurns.push(step.stepIndex);
      bucketTokensRemaining -= consume;
      stepTokenOffset += consume;

      if (stepTokenOffset >= step.tokens) {
        currentStepIdx++;
        stepTokenOffset = 0;
      }
    }

    const isAmputationZone = totalActiveTokens > safeLimit && cellIdx < HORIZON_WINDOW.AMPUTATION_CELL_COUNT;
    const attentionWeight = calculateAttentionWeight(cellIdx, Math.max(1, activeCellsCount));

    cells.push({
      index: cellIdx,
      tokenRange: [cellStartToken, cellEndToken],
      turnRange: [cellTurns[0] ?? 0, cellTurns[cellTurns.length - 1] ?? 0],
      dominantCategory: dominantCat,
      isAmputationZone,
      isCrisisCell: false,
      attentionWeight,
      tokensByCategory: bucketCategories,
      topTarget
    });
  }

  // Map effort transitions to their corresponding 5k-token block indices (0..39)
  const effortTransitions = rawTransitions.map(tr => {
    const tIdx = tr.turnIndex ?? tr.stepNumber ?? 0;
    const stepNum = tr.stepNumber ?? tr.turnIndex ?? 0;
    let matchedBlock = -1;
    for (const c of cells) {
      if (c.turnRange && c.turnRange[0] >= 0 && tIdx >= c.turnRange[0] && tIdx <= c.turnRange[1]) {
        matchedBlock = c.index;
        break;
      }
    }
    if (matchedBlock < 0 && typeof tr.blockIndex === 'number' && tr.blockIndex >= 0) {
      matchedBlock = Math.min(39, tr.blockIndex);
    }
    if (matchedBlock < 0) {
      matchedBlock = Math.min(39, Math.max(0, Math.floor((tIdx / Math.max(1, totalTurns)) * Math.max(1, activeCellsCount))));
    }
    const enriched = {
      ...tr,
      turnIndex: tIdx,
      stepNumber: stepNum,
      blockIndex: matchedBlock
    };
    if (cells[matchedBlock]) {
      cells[matchedBlock].effortTransitions = cells[matchedBlock].effortTransitions || [];
      cells[matchedBlock].effortTransitions.push(enriched);
    }
    return enriched;
  });

  // Prefix Amputation Bracket & Crisis evaluation
  // Truncation Zone is Cells 0..7 (earliest 40k tokens) when total tokens > safe limit (default 140k)
  const inAmputationZone = totalActiveTokens > safeLimit;

  // Crisis condition specifically requires:
  // 1. Total tokens nearing 200k limit (> 180,000) OR
  // 2. Active background daemon in cells 0..7 OR
  // 3. Uncompleted task/plan checkpoint in cells 0..7
  const earlySteps = classifiedSteps.filter(s => s.stepIndex <= 7);
  const uncompletedPlanInZone = earlySteps.some(s => s.rawContent.includes('- [ ]'));
  const daemonsAtRisk = activeBackgroundDaemons.filter(d => d.stepIndex <= 7);
  const extremeTokenLimit = totalActiveTokens >= 180000;

  const amputationCrisis = inAmputationZone && (daemonsAtRisk.length > 0 || uncompletedPlanInZone || extremeTokenLimit);

  if (amputationCrisis) {
    for (let c = 0; c < Math.min(HORIZON_WINDOW.AMPUTATION_CELL_COUNT, cells.length); c++) {
      cells[c].isCrisisCell = true;
    }
  }

  // Metrics computation
  const signalTokens = categoryTotals[CATEGORIES.ANCHOR] + categoryTotals[CATEGORIES.ACTIVE_WORKING_SET];
  const signalPurityPct = Math.round((signalTokens / Math.max(1, totalActiveTokens)) * 100);

  const pricePerM = MODEL_PRICING_PER_MILLION[modelId] || MODEL_PRICING_PER_MILLION.default;
  const sludgeTokens = categoryTotals[CATEGORIES.STALE_DUPLICATE] + categoryTotals[CATEGORIES.DEAD_ERROR] + categoryTotals[CATEGORIES.FOREIGN_BLEED];
  const sludgeTaxPerTurnUsd = parseFloat(((sludgeTokens / 1000000) * pricePerM).toFixed(4));
  const totalTurnCostUsd = parseFloat(((totalActiveTokens / 1000000) * pricePerM).toFixed(4));

  // Health band
  let healthBand = 'OPTIMAL_FOCUS';
  if (amputationCrisis) healthBand = 'AMPUTATION_CRISIS';
  else if (signalPurityPct < 40) healthBand = 'CRITICAL_SLUDGE';
  else if (signalPurityPct < 75) healthBand = 'VISIBLE_CLUTTER';

  // Format Top Offenders Ledger
  const offenders = Array.from(offenderMap.values())
    .sort((a, b) => b.wastedTokens - a.wastedTokens)
    .slice(0, 5)
    .map((off, rank) => {
      const avgStep = off.stepIndices.reduce((acc, v) => acc + v, 0) / (off.stepIndices.length || 1);
      const estCell = Math.min(39, Math.floor((avgStep / Math.max(1, totalTurns)) * activeCellsCount));
      const recallPct = Math.round(calculateAttentionWeight(estCell, activeCellsCount) * 100);
      const costUsd = parseFloat(((off.wastedTokens / 1000000) * pricePerM).toFixed(4));

      return {
        rank: rank + 1,
        target: off.target,
        category: off.category,
        occurrences: off.occurrences,
        stepIndices: off.stepIndices,
        wastedTokens: off.wastedTokens,
        sludgeCostPerTurnUsd: costUsd,
        attentionRecallPct: recallPct,
        remediation: off.category === CATEGORIES.DEAD_ERROR
          ? 'Prune resolved stack traces via /compact'
          : 'Deduplicate file reads via /compact'
      };
    });

  // Plain-Language Token-Based Diagnostics (Zero $ references)
  const reclaimK = Math.round(sludgeTokens / 1000);
  let whatsHappening = '';
  let theSludgeTax = '';
  let actionPlan = '';
  let recommendedCommand = '/fast';

  if (amputationCrisis) {
    whatsHappening = `Prefix truncation alert! Total memory (> 180k tokens) or early task checkpoints are inside the ${Math.round(safeLimit / 1000)}k+ truncation zone.`;
    theSludgeTax = `${reclaimK}k reclaimable noise tokens (${100 - signalPurityPct}% of active context) are pushing your earliest rules toward truncation.`;
    actionPlan = `Save progress to task.md and start a fresh chat or run /clear now.`;
    recommendedCommand = '/clear';
  } else if (signalPurityPct < 40 || inAmputationZone) {
    whatsHappening = `High context dilution: ${(100 - signalPurityPct)}% of active memory (${reclaimK}k tokens) consists of outdated turns and repeated file reads.`;
    theSludgeTax = `${reclaimK}k tokens can be reclaimed immediately via /compact. Middle-window recall has dropped to ~24%.`;
    actionPlan = `Run /compact to compress older history and drop duplicate file snapshots while keeping active rules intact.`;
    recommendedCommand = '/compact';
  } else if (signalPurityPct < 75) {
    whatsHappening = `Moderate context clutter (${reclaimK}k reclaimable tokens). Working set is healthy, but duplicate file reads are accumulating.`;
    theSludgeTax = `${reclaimK}k tokens of outdated history can be freed.`;
    actionPlan = `Run /compact when you finish the current step to reclaim ${reclaimK}k tokens.`;
    recommendedCommand = '/compact';
  } else {
    whatsHappening = `High-efficiency session. Memory is clean and focused on active workspace files with plenty of safe headroom.`;
    theSludgeTax = `Minimal noise (${reclaimK}k tokens). Signal purity is optimal at ${signalPurityPct}%.`;
    actionPlan = `Memory is clean. Continue working normally.`;
    recommendedCommand = '/fast';
  }

  // Compute actionable Brain Signals from transcript forensics
  const allOffenders = Array.from(offenderMap.values());
  const dupFileOffenders = allOffenders
    .filter(o => o.category === CATEGORIES.STALE_DUPLICATE && o.target !== 'Older chat history (>25 turns ago)' && !String(o.target).startsWith('Conversational Turn'))
    .sort((a, b) => b.wastedTokens - a.wastedTokens);
  const oldHistOffender = allOffenders.find(o => o.target === 'Older chat history (>25 turns ago)');
  const errorOffenders = allOffenders.filter(o => o.category === CATEGORIES.DEAD_ERROR);

  const blowupSteps = classifiedSteps
    .filter(s => s.tokens >= 8000 && s.stepIndex > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map(s => {
      const call = (steps[s.stepIndex]?.toolCalls || [])[0];
      const args = call?.args || {};
      const filePath = args.Path || args.path || args.AbsolutePath || null;
      const command = args.CommandLine || null;
      return {
        stepIndex: s.stepIndex,
        tokens: s.tokens,
        category: s.category,
        target: s.target || `Step ${s.stepIndex}`,
        payload: {
          kind: command ? 'command' : (filePath ? 'file' : 'other'),
          tool: call?.name || null,
          detail: String(command || filePath || call?.name || 'Model/tool output').slice(0, 300),
          path: filePath
        }
      };
    });

  const recentSteps = steps.slice(-10);
  const recentErrors = recentSteps.filter(s => s.status === 'ERROR' || s.exitCode === 1).length;

  let correctionCount = 0;
  for (const s of steps) {
    if (s.source === 'USER_EXPLICIT' || s.type === 'USER_INPUT') {
      const lower = String(s.content || '').toLowerCase();
      if (/\b(no[, ]|don't|do not|instead|wrong|looks the same|shouldn't|broken|still not)\b/.test(lower)) {
        correctionCount++;
      }
    }
  }

  // task.md freshness: user turns since the last tool call that wrote task.md
  const isUserTurn = x => x.source === 'USER_EXPLICIT' || x.type === 'USER_INPUT';
  const isTaskWrite = x => (x.toolCalls || []).some(c =>
    /write|edit|replace|create/i.test(c.name || '') &&
    /task\.md/i.test(String(c.args?.Path || c.args?.path || c.args?.TargetFile || c.args?.AbsolutePath || '')));
  let lastTaskWrite = -1;
  steps.forEach((x, i) => { if (isTaskWrite(x)) lastTaskWrite = i; });
  const taskTurnsBehind = steps.slice(lastTaskWrite + 1).filter(isUserTurn).length;

  const pinnedStepsCount = classifiedSteps.filter(s => s.semanticallyPinned).length;
  const brainSignals = {
    activeSignal: {
      liveSessionTokens: Math.round((rawLiveTokens / rawTotalTokens) * totalActiveTokens),
      taskMdSaved: lastTaskWrite >= 0,
      taskMdTurnsBehind: taskTurnsBehind,
      semanticallyPinnedTurns: pinnedStepsCount
    },
    duplicateReads: {
      fileCount: dupFileOffenders.length,
      reclaimableTokens: dupFileOffenders.reduce((sum, o) => sum + o.wastedTokens, 0),
      topFiles: dupFileOffenders.slice(0, 5).map(o => ({
        path: o.target,
        occurrences: o.occurrences,
        wastedTokens: o.wastedTokens
      }))
    },
    oldHistory: {
      turnCount: oldHistOffender ? oldHistOffender.occurrences : 0,
      reclaimableTokens: oldHistOffender ? oldHistOffender.wastedTokens : 0
    },
    deadErrors: {
      errorCount: errorOffenders.reduce((sum, o) => sum + o.occurrences, 0),
      reclaimableTokens: categoryTotals[CATEGORIES.DEAD_ERROR] || 0,
      isErrorLoop: recentErrors >= 3,
      topErrors: errorOffenders.slice(0, 3).map(o => ({
        target: o.target,
        occurrences: o.occurrences,
        wastedTokens: o.wastedTokens
      }))
    },
    blowupSteps,
    userCorrections: correctionCount,
    activeDaemons: activeBackgroundDaemons
  };

  // Compute Dual-Pool Quota & Cache-Read Telemetry (T2.1)
  const quota = computeQuotaAndCacheTelemetry(steps, {
    sessionId,
    totalActiveTokens,
    activeEffortProfile,
    stdinQuota,
    cacheDir
  });

  // Compute Multi-Agent (invoke_subagent) Context Tree & Handoff Compression (T2.3)
  const subagents = inspectSubagentTree(steps, { cacheDir });
  for (const inv of subagents.invocations) {
    for (const c of cells) {
      if (c.turnRange && c.turnRange[0] >= 0 && inv.stepIndex >= c.turnRange[0] && inv.stepIndex <= c.turnRange[1]) {
        c.subagents = c.subagents || [];
        c.subagents.push(inv);
        break;
      }
    }
  }

  return {
    schemaVersion: '1.1.0',
    sessionId,
    storeSource,
    logTierUsed,
    logFilePath,
    workspace: {
      canonicalPath: canonicalWorkspace,
      projectId
    },
    model: {
      id: modelId,
      inputPricePerMillionUsd: pricePerM,
      nativeCeilingTokens: resolveModelCeiling(modelId, stdinContextWindow, { useLegacyDefault: false })
    },
    window: {
      maxTokens: effectiveMaxTokens,
      cellSizeTokens: effectiveCellSize,
      totalCells: HORIZON_WINDOW.TOTAL_CELLS,
      totalActiveTokens,
      usedPercentage: parseFloat(((totalActiveTokens / effectiveMaxTokens) * 100).toFixed(1)),
      exceeds200kTokens: totalActiveTokens >= 200000,
      turnCount: totalTurns,
      safeLimit,
      reminderAt
    },
    breakdown: categoryTotals,
    metrics: {
      signalPurityPct,
      sludgeTokens,
      sludgeTaxPerTurnUsd,
      totalTurnCostUsd,
      healthBand
    },
    amputation: {
      inAmputationZone,
      bracketCells: [0, HORIZON_WINDOW.AMPUTATION_CELL_COUNT - 1],
      truncationRiskTokens: inAmputationZone ? HORIZON_WINDOW.AMPUTATION_CELL_COUNT * effectiveCellSize : 0,
      amputationCrisis,
      anchorsAtRisk: earlySteps.filter(s => s.category === CATEGORIES.ANCHOR).map(s => s.target),
      activeDaemonsAtRisk: daemonsAtRisk
    },
    cells,
    offenders,
    brainSignals,
    quota,
    subagents,
    activeEffortProfile,
    effortTransitions,
    effortHistory: effortTransitions,
    diagnostics: {
      whatsHappening,
      theSludgeTax,
      actionPlan,
      recommendedCommand
    },
    updatedAt: new Date().toISOString()
  };
}
