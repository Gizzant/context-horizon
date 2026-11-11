import { isSameOrSubPath, canonicalizePath } from './path_canonicalizer.mjs';
import { evaluateSmartFileReReads, isCompactionCheckpointStep } from './layer5_hygiene.mjs';
import { resolvePricePerM, resolveModelCeilingDetailed } from './constants.mjs';

export const CELL_CAPACITY_TOKENS = 5000;
export const TOTAL_HORIZON_CELLS = 40;
export const MAX_HORIZON_TOKENS = 200000;

export const CATEGORIES = {
  ANCHOR_CORE: 'ANCHOR_CORE',
  ANCHOR_SCHEMA: 'ANCHOR_SCHEMA',
  MEMORY_KI: 'MEMORY_KI',
  MEMORY_BLEED: 'MEMORY_BLEED',
  ACTIVE_SET: 'ACTIVE_SET',
  STALE_DUP: 'STALE_DUP',
  DIRTY_SNAP: 'DIRTY_SNAP',
  LEGACY_POISON: 'LEGACY_POISON',
  DEAD_ERROR: 'DEAD_ERROR',
  FREE_HEADROOM: 'FREE_HEADROOM'
};

export const CATEGORY_GLYPHS = {
  ANCHOR_CORE: '█',
  ANCHOR_SCHEMA: '▒',
  MEMORY_KI: '▓',
  MEMORY_BLEED: '▓',
  ACTIVE_SET: '█',
  STALE_DUP: '▒',
  DIRTY_SNAP: '▒',
  LEGACY_POISON: '▒',
  DEAD_ERROR: '▓',
  FREE_HEADROOM: '░'
};

/**
 * Classifies 200,000-token context window into 40 discrete chronological cells.
 */
export function classifyHorizonWindow(
  stepEvents = [],
  contextWindowMeta = {},
  workspacePath = '',
  knowledgeItemsMeta = [],
  config = {},
  sensorFlags = {}
) {
  const normWorkspace = canonicalizePath(workspacePath || '');
  const dirtySet = new Set((sensorFlags.dirtySnapshotPaths || []).map(p => canonicalizePath(p)));
  const foreignBleedKiIds = [];

  const deprecatedGlobs = config.deprecated_paths || ['**/legacy/**', '**/deprecated/**', '**/v1/**'];
  const isDeprecatedPath = (p) => {
    if (!p) return false;
    const lower = p.toLowerCase();
    return deprecatedGlobs.some(g => {
      const seg = g.replace(/\*/g, '');
      return lower.includes(seg);
    });
  };

  // 1. Identify Foreign KI Bleed vs Valid KI
  let memoryKiTokens = 0;
  let memoryBleedTokens = 0;
  for (const ki of knowledgeItemsMeta) {
    const kiProject = canonicalizePath(ki.projectPath || ki.workspacePath || '');
    const tokens = Math.max(0, Number(ki.tokenCount || 0));
    if (kiProject && normWorkspace && !isSameOrSubPath(normWorkspace, kiProject)) {
      foreignBleedKiIds.push(ki.id || ki.name || 'foreign_ki');
      memoryBleedTokens += tokens;
    } else {
      memoryKiTokens += tokens;
    }
  }

  // 2. Identify Dead Errors and Smart Stale Duplicates
  const totalSteps = stepEvents.length;
  const smartReReads = evaluateSmartFileReReads(stepEvents);
  let latestPassingCommandStep = -1;

  for (let i = 0; i < totalSteps; i++) {
    const ev = stepEvents[i];
    if ((ev.toolName === 'run_command' || ev.type === 'COMMAND') && ev.exitCode === 0) {
      latestPassingCommandStep = i;
    }
  }

  // 3. Classify individual step events into spans
  const spans = [];
  const activeSetPaths = new Set();
  const staleDupPaths = new Set();
  const legacyPoisonPaths = new Set();

  for (let i = 0; i < totalSteps; i++) {
    const ev = stepEvents[i];
    const isRecentTurn = (totalSteps - 1 - i) <= 16; // last ~8 conversational turns
    const isVeryOldChat = (totalSteps - 1 - i) > 25;
    let cat = CATEGORIES.ACTIVE_SET;

    // Anchor check
    const isCoreAnchor = ev.role === 'system' ||
      isCompactionCheckpointStep(ev) ||
      (ev.targetPath && (
        ev.targetPath.includes('rules/') ||
        ev.targetPath.endsWith('agents.md') ||
        ev.targetPath.endsWith('implementation_plan.md') ||
        ev.targetPath.endsWith('task.md')
      ));

    if (isCoreAnchor) {
      cat = CATEGORIES.ANCHOR_CORE;
    } else if (ev.stepIndex === 0 && (ev.type === 'SCHEMA' || ev.type === 'ANCHOR_SCHEMA')) {
      cat = CATEGORIES.ANCHOR_SCHEMA;
    } else if (ev.targetPath && dirtySet.has(ev.targetPath)) {
      cat = CATEGORIES.DIRTY_SNAP;
    } else if (ev.isDeprecatedContent || (ev.targetPath && isDeprecatedPath(ev.targetPath))) {
      cat = CATEGORIES.LEGACY_POISON;
      if (ev.targetPath) legacyPoisonPaths.add(ev.targetPath);
    } else if (ev.exitCode !== null && ev.exitCode !== 0) {
      // If a later passing command was executed, mark as DEAD_ERROR
      if (latestPassingCommandStep > i) {
        cat = CATEGORIES.DEAD_ERROR;
      } else {
        cat = CATEGORIES.ACTIVE_SET;
      }
    } else if (ev.targetPath && (ev.toolName === 'view_file' || ev.toolName === 'read_file')) {
      if (smartReReads.wasteTargetByStep.has(i)) {
        cat = CATEGORIES.STALE_DUP;
        staleDupPaths.add(ev.targetPath);
      } else if (isRecentTurn) {
        cat = CATEGORIES.ACTIVE_SET;
        activeSetPaths.add(ev.targetPath);
      } else {
        cat = CATEGORIES.STALE_DUP;
        staleDupPaths.add(ev.targetPath);
      }
    } else if (isVeryOldChat && ev.role !== 'system') {
      cat = CATEGORIES.STALE_DUP;
    } else if (isRecentTurn) {
      cat = CATEGORIES.ACTIVE_SET;
      if (ev.targetPath) activeSetPaths.add(ev.targetPath);
    } else {
      cat = CATEGORIES.STALE_DUP;
    }

    spans.push({
      category: cat,
      tokens: ev.tokenEstimate || 100,
      path: ev.targetPath,
      stepIndex: ev.stepIndex
    });
  }

  // Insert Knowledge Items
  if (memoryKiTokens > 0) {
    spans.unshift({ category: CATEGORIES.MEMORY_KI, tokens: memoryKiTokens, path: null, stepIndex: 0 });
  }
  if (memoryBleedTokens > 0) {
    spans.unshift({ category: CATEGORIES.MEMORY_BLEED, tokens: memoryBleedTokens, path: null, stepIndex: 0 });
  }

  // Total active tokens
  const rawSumTokens = spans.reduce((sum, s) => sum + s.tokens, 0);
  const totalInputTokens = Math.max(
    contextWindowMeta.total_input_tokens || 0,
    rawSumTokens
  );

  // 4. Populate 40 discrete cells
  const cells = [];
  const tokenBreakdown = {
    [CATEGORIES.ANCHOR_CORE]: 0,
    [CATEGORIES.ANCHOR_SCHEMA]: 0,
    [CATEGORIES.MEMORY_KI]: 0,
    [CATEGORIES.MEMORY_BLEED]: 0,
    [CATEGORIES.ACTIVE_SET]: 0,
    [CATEGORIES.STALE_DUP]: 0,
    [CATEGORIES.DIRTY_SNAP]: 0,
    [CATEGORIES.LEGACY_POISON]: 0,
    [CATEGORIES.DEAD_ERROR]: 0,
    [CATEGORIES.FREE_HEADROOM]: 0
  };

  for (const s of spans) {
    tokenBreakdown[s.category] = (tokenBreakdown[s.category] || 0) + s.tokens;
  }

  // Map spans into 40 buckets of 5,000 tokens
  let currentSpanIdx = 0;
  let currentSpanRemaining = spans[0]?.tokens || 0;

  for (let cellIdx = 0; cellIdx < TOTAL_HORIZON_CELLS; cellIdx++) {
    const cellStart = cellIdx * CELL_CAPACITY_TOKENS;
    const cellEnd = cellStart + CELL_CAPACITY_TOKENS;

    if (cellStart >= totalInputTokens) {
      // Cell is beyond context, mark as FREE_HEADROOM
      tokenBreakdown[CATEGORIES.FREE_HEADROOM] += CELL_CAPACITY_TOKENS;
      cells.push({
        index: cellIdx,
        tokenStart: cellStart,
        tokenEnd: cellEnd,
        dominantCategory: CATEGORIES.FREE_HEADROOM,
        glyph: CATEGORY_GLYPHS.FREE_HEADROOM,
        totalTokens: 0,
        paths: []
      });
      continue;
    }

    const cellTally = {};
    const cellPaths = new Set();
    let needed = Math.min(CELL_CAPACITY_TOKENS, Math.max(0, totalInputTokens - cellStart));

    while (needed > 0 && currentSpanIdx < spans.length) {
      const span = spans[currentSpanIdx];
      const alloc = Math.min(needed, currentSpanRemaining);
      cellTally[span.category] = (cellTally[span.category] || 0) + alloc;
      if (span.path) cellPaths.add(span.path);

      needed -= alloc;
      currentSpanRemaining -= alloc;
      if (currentSpanRemaining <= 0) {
        currentSpanIdx++;
        currentSpanRemaining = spans[currentSpanIdx]?.tokens || 0;
      }
    }

    // Find dominant category for this cell
    let dominant = CATEGORIES.FREE_HEADROOM;
    let maxTokensInCell = -1;
    for (const [c, count] of Object.entries(cellTally)) {
      if (count > maxTokensInCell) {
        maxTokensInCell = count;
        dominant = c;
      }
    }

    cells.push({
      index: cellIdx,
      tokenStart: cellStart,
      tokenEnd: cellEnd,
      dominantCategory: dominant,
      glyph: CATEGORY_GLYPHS[dominant] || CATEGORY_GLYPHS.FREE_HEADROOM,
      totalTokens: CELL_CAPACITY_TOKENS - needed,
      paths: Array.from(cellPaths).slice(0, 3)
    });
  }

  // 5. Check Amputation Risk
  const amputationThreshold = config.amputation_token_threshold || 140000;
  const inAmputationZone = totalInputTokens >= amputationThreshold;
  const earlyCellsContainAnchor = cells.slice(0, 8).some(c => c.dominantCategory === CATEGORIES.ANCHOR_CORE);
  const amputationRisk = inAmputationZone && (earlyCellsContainAnchor || totalInputTokens >= 180000);

  // 6. Signal Purity & Sludge Tax
  const pureTokens = tokenBreakdown[CATEGORIES.ANCHOR_CORE] +
    tokenBreakdown[CATEGORIES.MEMORY_KI] +
    tokenBreakdown[CATEGORIES.ACTIVE_SET];

  const signalPurityPct = totalInputTokens > 0
    ? Number(Math.min(100, Math.max(0, (pureTokens / totalInputTokens) * 100)).toFixed(1))
    : 100.0;

  const sludgeTokens = tokenBreakdown[CATEGORIES.STALE_DUP] +
    tokenBreakdown[CATEGORIES.DEAD_ERROR] +
    tokenBreakdown[CATEGORIES.ANCHOR_SCHEMA];

  const activeModel = contextWindowMeta.modelName || contextWindowMeta.modelId || 'gemini-3.8-flash';
  const ceilingDetails = resolveModelCeilingDetailed(activeModel, contextWindowMeta, {
    useLegacyDefault: false,
    config
  });
  const modelMaxTokens = Number(contextWindowMeta.maxTokens) > 0
    ? Number(contextWindowMeta.maxTokens)
    : ceilingDetails.ceilingTokens;
  const pricePer1M = resolvePricePerM(activeModel, config);
  const sludgeTaxUsdPerTurn = Number(((sludgeTokens / 1_000_000) * pricePer1M).toFixed(4));

  let sumCacheRead = 0;
  let sumPromptEnvelope = 0;
  for (const ev of stepEvents) {
    const cr = Math.max(0, Number(ev?.cacheReadTokens || 0));
    const cc = Math.max(0, Number(ev?.cacheCreationTokens || 0));
    const inp = Math.max(0, Number(ev?.inputTokens || 0));
    sumCacheRead += cr;
    sumPromptEnvelope += cr + cc + inp;
  }
  const derivedCacheHitPct = sumPromptEnvelope > 0
    ? Math.min(100, Math.round((sumCacheRead / sumPromptEnvelope) * 100))
    : 0;
  const cacheHitPct = typeof contextWindowMeta.cacheHitPct === 'number' && Number.isFinite(contextWindowMeta.cacheHitPct)
    ? Math.max(0, Math.min(100, Math.round(contextWindowMeta.cacheHitPct)))
    : derivedCacheHitPct;
  const ttlRemainingSec = typeof contextWindowMeta.ttlRemainingSec === 'number' && Number.isFinite(contextWindowMeta.ttlRemainingSec)
    ? Math.max(0, Math.round(contextWindowMeta.ttlRemainingSec))
    : 0;

  return {
    totalInputTokens,
    model: {
      id: activeModel,
      maxTokens: modelMaxTokens,
      ceilingSource: ceilingDetails.source
    },
    cells,
    tokenBreakdown,
    metrics: {
      signalPurityPct,
      sludgeTaxUsdPerTurn,
      pureTokens,
      sludgeTokens,
      cacheHitPct,
      ttlRemainingSec
    },
    flags: {
      amputationRisk,
      inAmputationZone,
      hasForeignBleed: foreignBleedKiIds.length > 0
    },
    fileState: {
      activeSetPaths: Array.from(activeSetPaths),
      staleDupPaths: Array.from(staleDupPaths),
      legacyPoisonPaths: Array.from(legacyPoisonPaths),
      foreignBleedKiIds
    }
  };
}
