/**
 * Synthetic demo and test fixtures covering all 8 canonical session and router scenarios.
 * Mathematically self-consistent:
 *   - sum(cells[i].totalTokens) === totalActiveTokens
 *   - ANCHOR + INJECTED_MEMORY + ACTIVE_WORKING_SET + DUPLICATE_READ + STALE_TURN + DEAD_ERROR === totalActiveTokens
 *   - topRiskyCells, chronicReads, and subagents strictly scoped to active session depth
 */
import { resolvePricePerM, resolveModelCeiling } from '../core/constants.mjs';

export const SCENARIO_1_COLD_VAGUE = {
  conversationId: 'fixture_scenario_1_cold',
  prompt: 'Update the whole caching system and refactor everything',
  modelName: 'gemini-3.8-flash',
  effort: 'low',
  sidecar: {
    conversationId: 'fixture_scenario_1_cold',
    sessionMeta: { turnCount: 1, activeModel: 'gemini-3.8-flash', activeEffort: 'low', inPlanMode: false },
    telemetry: { totalInputTokens: 3500, signalPurityPct: 100.0, quota: { remaining_fraction: 0.95 } },
    fileState: { activeSetPaths: ['src/cache.mjs'] }
  }
};

export const SCENARIO_2_WARM_ACTIVE_SET = {
  conversationId: 'fixture_scenario_2_warm',
  prompt: 'In router.mjs add error handling to the dispatch function',
  modelName: 'gemini-3.8-flash',
  effort: 'medium',
  sidecar: {
    conversationId: 'fixture_scenario_2_warm',
    sessionMeta: { turnCount: 18, activeModel: 'gemini-3.8-flash', activeEffort: 'medium' },
    telemetry: { totalInputTokens: 62000, signalPurityPct: 82.0, quota: { remaining_fraction: 0.85 } },
    fileState: { activeSetPaths: ['c:/projects/attention-horizon-antigravity/src/core/router.mjs'] }
  }
};

export const SCENARIO_3_HOT_CONCURRENCY = {
  conversationId: 'fixture_scenario_3_hot',
  prompt: 'Investigate the async concurrency deadlock in worker queue',
  modelName: 'gemini-3.8-flash',
  effort: 'medium',
  sidecar: {
    conversationId: 'fixture_scenario_3_hot',
    sessionMeta: { turnCount: 45, activeModel: 'gemini-3.8-flash', activeEffort: 'medium' },
    telemetry: { totalInputTokens: 85000, signalPurityPct: 79.0, quota: { remaining_fraction: 0.70 } },
    fileState: { activeSetPaths: ['src/queue.mjs'] }
  }
};

export const SCENARIO_4_POLLUTED_REFACTOR = {
  conversationId: 'fixture_scenario_4_polluted',
  prompt: 'Refactor database connection pool',
  modelName: 'gemini-3.1-pro',
  effort: 'high',
  sidecar: {
    conversationId: 'fixture_scenario_4_polluted',
    sessionMeta: { turnCount: 22, activeModel: 'gemini-3.1-pro', activeEffort: 'high' },
    telemetry: { totalInputTokens: 95000, signalPurityPct: 39.0, sludgeTaxUsdPerTurn: 0.07, quota: { remaining_fraction: 0.60 } },
    fileState: { activeSetPaths: [] }
  }
};

export const SCENARIO_5_AMPUTATION_CRISIS = {
  conversationId: 'fixture_scenario_5_amputation',
  prompt: 'Add billing summary endpoint',
  modelName: 'gemini-3.1-pro',
  effort: 'high',
  sidecar: {
    conversationId: 'fixture_scenario_5_amputation',
    sessionMeta: { turnCount: 50, activeModel: 'gemini-3.1-pro', activeEffort: 'high' },
    telemetry: { totalInputTokens: 145000, amputationRisk: true, signalPurityPct: 35.0, quota: { remaining_fraction: 0.50 } },
    fileState: { activeSetPaths: [] }
  }
};

export const SCENARIO_6_PARALLEL_DRIFT = {
  conversationId: 'fixture_scenario_6_drift',
  prompt: 'Update server routes',
  modelName: 'gemini-3.8-flash',
  effort: 'high',
  sidecar: {
    conversationId: 'fixture_scenario_6_drift',
    sessionMeta: { turnCount: 12, activeModel: 'gemini-3.8-flash', activeEffort: 'high' },
    telemetry: { totalInputTokens: 30000, signalPurityPct: 80.0, quota: { remaining_fraction: 0.80 } },
    fileState: {
      activeSetPaths: ['src/server.mjs'],
      dirtySnapshotPaths: ['src/routes.mjs'],
      unseenCallers: ['src/app.mjs'],
      legacyPoisonPaths: [],
      streamCutoffRiskFiles: []
    }
  }
};

export const SCENARIO_7_QUOTA_SHIELD = {
  conversationId: 'fixture_scenario_7_quota',
  prompt: 'Generate detailed architecture plan',
  modelName: 'gemini-3.1-pro',
  effort: 'max',
  sidecar: {
    conversationId: 'fixture_scenario_7_quota',
    sessionMeta: { turnCount: 8, activeModel: 'gemini-3.1-pro', activeEffort: 'max' },
    telemetry: { totalInputTokens: 40000, signalPurityPct: 85.0, quota: { remaining_fraction: 0.08 } },
    sensors: { quotaFloorBreached: true },
    fileState: { activeSetPaths: [] }
  }
};

export const SCENARIO_8_EXPLICIT_CHECK = {
  conversationId: 'fixture_scenario_8_check',
  prompt: '#check Break down large 9950 line legacy parser into modules',
  modelName: 'gemini-3.8-flash',
  effort: 'medium',
  sidecar: {
    conversationId: 'fixture_scenario_8_check',
    sessionMeta: { turnCount: 6, activeModel: 'gemini-3.8-flash', activeEffort: 'medium' },
    telemetry: { totalInputTokens: 25000, signalPurityPct: 75.0, quota: { remaining_fraction: 0.85 } },
    fileState: { activeSetPaths: ['src/parser.mjs'] }
  }
};

export const DEMO_SCENARIOS = [
  {
    id: 1,
    slug: 'cold-vague',
    title: 'Scenario 1: Cold Vague Prompt (Turn 1 Rewrite)',
    complaint: 'I typed a quick refactor prompt and burned 20k tokens because the agent guessed the wrong files.',
    fixture: SCENARIO_1_COLD_VAGUE,
    routerState: 'HALT_REWRITE_SCORECARD',
    score: 42,
    sludgeTaxUsd: 0.00,
    reclaimTokens: 0,
    recommendedAction: '/model gemini-3.8-flash  •  /effort medium',
    rewrite: 'In @src/cache.mjs refactor cache eviction policy and update unit tests'
  },
  {
    id: 2,
    slug: 'warm-active',
    title: 'Scenario 2: Healthy Warm Session (82% Purity)',
    complaint: 'Baseline healthy coding session with clean active working set.',
    fixture: SCENARIO_2_WARM_ACTIVE_SET,
    routerState: 'ALLOW_ACTIVE_SET',
    score: 88,
    sludgeTaxUsd: 0.01,
    reclaimTokens: 11000,
    recommendedAction: '/model gemini-3.8-flash  •  /effort medium (Optimal)',
    rewrite: 'In @src/core/router.mjs add error handling to the dispatch function'
  },
  {
    id: 3,
    slug: 'subagent-steer',
    title: 'Scenario 3: Hot Cache Subagent Steer (85k Tokens)',
    complaint: 'Deep debugging polluted my main thread and ruined my warm 85k KV cache.',
    fixture: SCENARIO_3_HOT_CONCURRENCY,
    routerState: 'STEER_SUBAGENT',
    score: 79,
    sludgeTaxUsd: 0.02,
    reclaimTokens: 18000,
    recommendedAction: 'Delegate via invoke_subagent to preserve warm 85k parent KV cache',
    rewrite: 'Use invoke_subagent (research) to isolate async concurrency deadlock in @src/queue.mjs'
  },
  {
    id: 4,
    slug: 'polluted-sludge',
    title: 'Scenario 4: Polluted Context & Duplicate File Sludge ($0.07/turn)',
    complaint: 'The agent read the same 600-line file 7 times and kept 5 old stack traces in memory!',
    fixture: SCENARIO_4_POLLUTED_REFACTOR,
    routerState: 'HALT_HYGIENE_OR_SAFETY',
    score: 39,
    sludgeTaxUsd: 0.07,
    reclaimTokens: 58000,
    recommendedAction: 'Run /compact or One-Click Surgical Pruner before High-effort refactor',
    rewrite: 'After /compact: In @src/db/pool.mjs refactor connection retry backoff'
  },
  {
    id: 5,
    slug: 'amputation-crisis',
    title: 'Scenario 5: Turn 50 Prefix Amputation Crisis (145k Tokens)',
    complaint: 'Why did the agent suddenly ignore my AGENTS.md rules at turn 35 and break my architecture?!',
    fixture: SCENARIO_5_AMPUTATION_CRISIS,
    routerState: 'HALT_HYGIENE_OR_SAFETY',
    score: 31,
    sludgeTaxUsd: 0.09,
    reclaimTokens: 84000,
    recommendedAction: 'CRITICAL: Cells 1-8 (AGENTS.md) in Amputation Zone! Type /compact now',
    rewrite: 'HALT: Reclaim 84k sludge tokens via /compact before adding billing endpoint'
  },
  {
    id: 6,
    slug: 'dirty-snap-drift',
    title: 'Scenario 6: External Editor Dirty Snapshot & Unseen Callers',
    complaint: 'I edited routes.mjs in VS Code and the agent blindly overwrote my fix with a stale snapshot!',
    fixture: SCENARIO_6_PARALLEL_DRIFT,
    routerState: 'INJECT_CONTEXT_GUARD',
    score: 64,
    sludgeTaxUsd: 0.02,
    reclaimTokens: 6000,
    recommendedAction: 'Re-read dirty @src/routes.mjs (modified on disk) & check unseen caller @src/app.mjs',
    rewrite: 'Re-read @src/routes.mjs and inspect caller @src/app.mjs before updating server routes'
  },
  {
    id: 7,
    slug: 'quota-shield',
    title: 'Scenario 7: 5-Hour Quota Floor Shield (8% Remaining)',
    complaint: 'My 5-hour Pro/Opus quota evaporated in 40 minutes without warning!',
    fixture: SCENARIO_7_QUOTA_SHIELD,
    routerState: 'HALT_EFFORT_OR_QUOTA',
    score: 52,
    sludgeTaxUsd: 0.03,
    reclaimTokens: 12000,
    recommendedAction: 'QUOTA SHIELD (<10% left): Switch /model gemini-3.8-flash • /effort low',
    rewrite: 'Switch to Flash/Low or wait for 5h bucket reset before generating architecture plan'
  },
  {
    id: 8,
    slug: 'stream-cutoff-check',
    title: 'Scenario 8: #check 600-Line Stream Cutoff & Legacy Poison Guard',
    complaint: 'It tried rewriting a 9,950-line legacy file in one shot and cut off mid-stream!',
    fixture: SCENARIO_8_EXPLICIT_CHECK,
    routerState: 'HALT_REWRITE_SCORECARD',
    score: 85,
    sludgeTaxUsd: 0.01,
    reclaimTokens: 6000,
    recommendedAction: '/model gemini-3.8-flash • Split 9,950-line @src/parser.mjs via chunked edits',
    rewrite: 'In @src/parser.mjs extract tokenizer (lines 1-350) into @src/lexer.mjs using edit_file'
  }
];

/**
 * Builds a complete, mathematically self-consistent 40-cell Horizon + Webview + HUD payload
 * for any of the 8 demo scenarios.
 */
export function buildDemoHorizonState(scenarioNumber = 5) {
  const meta = DEMO_SCENARIOS.find(s => s.id === Number(scenarioNumber)) || DEMO_SCENARIOS[4];
  const sc = meta.fixture.sidecar;
  const totalActiveTokens = sc.telemetry.totalInputTokens || 145000;
  const maxTokens = 200000;
  const cellSize = 5000;
  const activeCells = Math.min(40, Math.max(1, Math.ceil(totalActiveTokens / cellSize)));
  const isCrisis = Boolean(sc.telemetry.amputationRisk || totalActiveTokens >= 140000);
  const purity = sc.telemetry.signalPurityPct ?? 35.0;

  const sludgeTokens = meta.reclaimTokens > 0
    ? meta.reclaimTokens
    : (purity >= 100 ? 0 : Math.round(totalActiveTokens * ((100 - purity) / 100)));

  // Compute exact non-overlapping breakdown components summing to totalActiveTokens
  const dupReadTokens = Math.round(sludgeTokens * 0.65);
  const staleTurnTokens = Math.round(sludgeTokens * 0.15);
  const deadErrorTokens = Math.max(0, sludgeTokens - dupReadTokens - staleTurnTokens);
  const usefulTotalTokens = Math.max(0, totalActiveTokens - sludgeTokens);

  const anchorTokens = totalActiveTokens <= 5000
    ? Math.min(2000, usefulTotalTokens)
    : Math.min(15000, Math.round(usefulTotalTokens * 0.30));
  const injectedMemoryTokens = totalActiveTokens <= 5000
    ? Math.min(500, Math.max(0, usefulTotalTokens - anchorTokens))
    : Math.min(5000, Math.max(0, usefulTotalTokens - anchorTokens));
  const activeWorkingSetTokens = Math.max(0, usefulTotalTokens - anchorTokens - injectedMemoryTokens);

  const sludgeCellCount = sludgeTokens > 0 ? Math.max(1, Math.round(sludgeTokens / cellSize)) : 0;
  const anchorCellCount = Math.max(1, Math.min(activeCells, Math.round((anchorTokens + injectedMemoryTokens) / cellSize) || 1));

  const primaryActiveFile = (sc.fileState?.activeSetPaths && sc.fileState.activeSetPaths[0])
    ? sc.fileState.activeSetPaths[0].replace(/^c:\/projects\/attention-horizon-antigravity\//i, '')
    : (meta.id === 6 ? 'src/routes.mjs' : (meta.id === 8 ? 'src/parser.mjs' : 'src/core/router.mjs'));

  const cells = [];
  let remainingTokensToAssign = totalActiveTokens;
  let assignedSludgeCells = 0;

  for (let i = 0; i < 40; i++) {
    let dominantCategory = 'FREE_HEADROOM';
    let isCrisisCell = false;
    const filled = i < activeCells ? Math.min(cellSize, Math.max(0, remainingTokensToAssign)) : 0;
    remainingTokensToAssign = Math.max(0, remainingTokensToAssign - filled);

    if (filled > 0) {
      if (i < anchorCellCount - (injectedMemoryTokens >= 2500 ? 1 : 0)) {
        dominantCategory = 'ANCHOR';
        isCrisisCell = isCrisis;
      } else if (i === anchorCellCount - 1 && injectedMemoryTokens >= 2500) {
        dominantCategory = 'INJECTED_MEMORY';
        isCrisisCell = isCrisis;
      } else if (sludgeCellCount > 0 && assignedSludgeCells < sludgeCellCount && i >= anchorCellCount && i < activeCells - 1) {
        assignedSludgeCells++;
        if (meta.id === 6 && assignedSludgeCells === 1) {
          dominantCategory = 'STALE_TURN';
        } else if (deadErrorTokens >= 2000 && assignedSludgeCells % 3 === 0) {
          dominantCategory = 'DEAD_ERROR';
        } else {
          dominantCategory = 'DUPLICATE_READ';
        }
        isCrisisCell = isCrisis && i < 8;
      } else {
        dominantCategory = 'ACTIVE_WORKING_SET';
        isCrisisCell = isCrisis && i < 8;
      }
    }

    const targetPath =
      filled === 0 ? 'Free Token Headroom' :
      i === 0 ? 'SYSTEM_PROMPT + AGENTS.md' :
      i === 1 ? 'implementation_plan.md + task.md' :
      i === 2 && dominantCategory === 'ANCHOR' ? 'MCP Tool Schemas (Turn 0)' :
      i === 8 && dominantCategory !== 'DUPLICATE_READ' ? 'task.md' :
      dominantCategory === 'DEAD_ERROR' ? 'src/cli/doctor.mjs (failed run_command trace)' :
      dominantCategory === 'DUPLICATE_READ' ? primaryActiveFile :
      dominantCategory === 'STALE_TURN' ? 'src/routes.mjs (stale snapshot before external edit)' :
      primaryActiveFile;

    const inTrough = activeCells >= 7 && i >= 6 && i <= 15 && i < activeCells;
    cells.push({
      index: i,
      startToken: i * cellSize,
      endToken: i * cellSize + filled,
      totalTokens: filled,
      dominantCategory,
      topTarget: targetPath,
      inAttentionTrough: inTrough,
      attentionWeight: inTrough ? 0.42 : 0.92,
      hudCategory:
        dominantCategory === 'ANCHOR' ? (i === 2 ? 'ANCHOR_SCHEMA' : 'ANCHOR_CORE') :
        dominantCategory === 'INJECTED_MEMORY' ? (meta.id === 5 ? 'MEMORY_BLEED' : 'MEMORY_KI') :
        dominantCategory === 'DUPLICATE_READ' ? (meta.id === 6 ? 'DIRTY_SNAP' : 'STALE_DUP') :
        dominantCategory === 'DEAD_ERROR' ? 'DEAD_ERROR' :
        dominantCategory === 'ACTIVE_WORKING_SET' ? 'ACTIVE_SET' : 'FREE_HEADROOM',
      isAmputationZone: i < 8,
      isCrisisCell,
      turnRange: filled > 0 ? [Math.max(0, i * 2 - 1), i * 2] : [-1, -1],
      breakdown: { [dominantCategory]: filled },
      topContributors: filled > 0 ? [{
        category: dominantCategory,
        tokens: filled,
        target: targetPath,
        stepIndex: i * 2,
        foreignBleed: meta.id === 5 && i === 3
      }] : []
    });
  }

  const quotaRem = Math.round((sc.telemetry.quota?.remaining_fraction ?? 0.5) * 100);
  const workloadMode =
    meta.id === 3 ? { modeId: 'SUBAGENT_SWARM', tag: '[Mode: Subagent Swarm]' } :
    (meta.id === 4 || meta.id === 8) ? { modeId: 'MULTI_FILE_REFACTOR', tag: '[Mode: Multi-File Refactor]' } :
    { modeId: 'READ_HEAVY_AUDIT', tag: '[Mode: Read-Heavy Audit]' };

  // Strictly scope topRiskyCells to filled cells in the attention trough (indices 6..15, i < activeCells)
  const candidateRiskyCells = [
    {
      cellIndex: 6,
      cellNumber: 7,
      filePath: primaryActiveFile,
      tokenWeight: 5000,
      wasteTokens: sludgeTokens > 0 ? Math.min(5000, dupReadTokens) : 0,
      attentionRecallPct: 44,
      inTrough: true,
      riskReason: sludgeTokens > 0 ? 'HIGH_SLUDGE_DENSITY' : 'TROUGH_STRANDED_SPEC',
      actionType: sludgeTokens > 0 ? 'PRUNE' : 'REANCHOR',
      actionLabel: '[Re-Anchor / Prune]',
      specificActionLabel: sludgeTokens > 0 ? '[Prune Stale Tool Outputs]' : '[Re-Anchor Cell to Handoff]'
    },
    {
      cellIndex: 8,
      cellNumber: 9,
      filePath: 'task.md',
      tokenWeight: 5000,
      wasteTokens: 0,
      attentionRecallPct: 42,
      inTrough: true,
      riskReason: 'TROUGH_STRANDED_SPEC',
      actionType: 'REANCHOR',
      actionLabel: '[Re-Anchor / Prune]',
      specificActionLabel: '[Re-Anchor Cell to Handoff]'
    },
    {
      cellIndex: 11,
      cellNumber: 12,
      filePath: 'src/core/router.mjs',
      tokenWeight: 5000,
      wasteTokens: 5000,
      attentionRecallPct: 40,
      inTrough: true,
      riskReason: 'HIGH_SLUDGE_DENSITY',
      actionType: 'PRUNE',
      actionLabel: '[Re-Anchor / Prune]',
      specificActionLabel: '[Prune Stale Tool Outputs]'
    }
  ];
  const topRiskyCells = candidateRiskyCells.filter(c => c.cellIndex < activeCells && cells[c.cellIndex]?.totalTokens > 0);

  // Scope chronicReads and subagents to session maturity
  const chronicReads = (meta.id === 1 || sludgeTokens === 0) ? [] : [
    {
      path: primaryActiveFile,
      sessions: meta.id >= 4 && meta.id <= 5 ? 4 : 3,
      windowSessions: 5,
      wastedTokens: Math.min(35000, Math.max(6000, dupReadTokens)),
      bannerText: `Across last 5 sessions, ${primaryActiveFile} caused ${Math.round(Math.min(35000, Math.max(6000, dupReadTokens)) / 1000)}k repeated re-reads`
    }
  ];

  const hasSubagents = meta.id === 3 || meta.id === 5;
  const subagents = hasSubagents ? {
    count: 2,
    totalChildTokens: 64000,
    totalParentSummaryTokens: 1800,
    overallCompressionRatio: 35.6,
    tokensSaved: 62200,
    invocations: [
      {
        stepIndex: 8,
        role: 'Codebase Researcher',
        typeName: 'research',
        workspace: 'inherit',
        workspaceMode: 'inherit',
        childTokens: 38000,
        summaryTokens: 950,
        tokensSaved: 37050,
        compressionRatio: 40.0,
        badgeLabel: '[Subagent: research | 38.0k isolated -> 1.0k handoff (40x)]'
      }
    ]
  } : {
    count: 0,
    totalChildTokens: 0,
    totalParentSummaryTokens: 0,
    overallCompressionRatio: 1.0,
    tokensSaved: 0,
    invocations: []
  };

  return {
    schemaVersion: '1.1.0',
    sessionId: meta.fixture.conversationId,
    sessionTitle: meta.title,
    demoMeta: meta,
    routerState: meta.routerState,
    recommendedAction: meta.recommendedAction,
    rewrite: meta.rewrite,
    storeSource: 'demo-synthetic',
    logTierUsed: 1,
    logFilePath: 'src/demo/synthetic_states.mjs',
    workspace: {
      canonicalPath: 'c:/projects/attention-horizon-antigravity',
      projectId: 'attention-horizon-demo'
    },
    model: {
      id: meta.fixture.modelName,
      inputPricePerMillionUsd: resolvePricePerM(meta.fixture.modelName),
      nativeCeilingTokens: resolveModelCeiling(meta.fixture.modelName, null, { useLegacyDefault: false })
    },
    window: {
      maxTokens,
      cellSizeTokens: cellSize,
      totalCells: 40,
      totalActiveTokens,
      usedPercentage: parseFloat(((totalActiveTokens / maxTokens) * 100).toFixed(1)),
      exceeds200kTokens: false,
      turnCount: sc.sessionMeta.turnCount || 32,
      safeLimit: 140000,
      reminderAt: 119000
    },
    breakdown: {
      ANCHOR: anchorTokens,
      INJECTED_MEMORY: injectedMemoryTokens,
      STALE_DUPLICATE: dupReadTokens + staleTurnTokens,
      DUPLICATE_READ: dupReadTokens,
      STALE_TURN: staleTurnTokens,
      DEAD_ERROR: deadErrorTokens,
      ACTIVE_WORKING_SET: activeWorkingSetTokens,
      FREE_HEADROOM: Math.max(0, maxTokens - totalActiveTokens)
    },
    metrics: {
      signalPurityPct: purity,
      sludgeTokens,
      sludgeTaxPerTurnUsd: meta.sludgeTaxUsd,
      totalTurnCostUsd: parseFloat((meta.sludgeTaxUsd + 0.02).toFixed(4)),
      healthBand: isCrisis ? 'CRISIS' : (purity < 60 ? 'DEGRADED' : 'OPTIMAL')
    },
    amputation: {
      inAmputationZone: isCrisis,
      bracketCells: [0, 7],
      truncationRiskTokens: isCrisis ? 40000 : 0,
      amputationCrisis: isCrisis,
      anchorsAtRisk: isCrisis ? ['SYSTEM_PROMPT', 'AGENTS.md', 'implementation_plan.md', 'task.md'] : [],
      activeDaemonsAtRisk: []
    },
    cells,
    workloadMode,
    topRiskyCells,
    chronicReads,
    offenders: sludgeTokens === 0 ? [
      {
        category: 'ANCHOR',
        target: 'Turn-0 System & Workspace Rules (AGENTS.md)',
        wastedTokens: 0,
        occurrences: 1,
        stepIndices: [0],
        remediation: `Baseline clean (${(totalActiveTokens / 1000).toFixed(1)}k tokens); ${meta.rewrite}`
      }
    ] : [
      {
        category: 'DUPLICATE_READ',
        target: primaryActiveFile,
        wastedTokens: dupReadTokens,
        occurrences: Math.max(2, Math.min(6, Math.floor((sc.sessionMeta.turnCount || 18) / 3))),
        stepIndices: [3, 7, 14, 19, 26, 31].filter(s => s <= (sc.sessionMeta.turnCount || 32)),
        remediation: `Fold superseded reads of ${primaryActiveFile} via Surgical Pruner or use read_file { Path: "${primaryActiveFile}", StartLine: 1, EndLine: 200 }`
      },
      {
        category: 'DEAD_ERROR',
        target: 'npm test (Resolved TypeError stack trace)',
        wastedTokens: deadErrorTokens,
        occurrences: Math.max(1, Math.min(3, Math.floor((sc.sessionMeta.turnCount || 18) / 6))),
        stepIndices: [11, 12, 13].filter(s => s <= (sc.sessionMeta.turnCount || 32)),
        remediation: 'Collapse resolved error traces into 1-line tombstones via Surgical Pruner or /compact'
      },
      {
        category: 'STALE_TURN',
        target: 'Older chat history (>25 turns ago)',
        wastedTokens: staleTurnTokens,
        occurrences: Math.max(1, Math.floor((sc.sessionMeta.turnCount || 18) / 6)),
        stepIndices: [1, 2],
        remediation: 'Summarize older turns when cache is cold via /compact'
      }
    ],
    brainSignals: {
      activeSignal: {
        liveSessionTokens: usefulTotalTokens,
        taskMdSaved: !isCrisis,
        taskMdTurnsBehind: isCrisis ? 9 : (sludgeTokens === 0 ? 0 : 1),
        semanticallyPinnedTurns: sludgeTokens === 0 ? 0 : 3
      },
      duplicateReads: sludgeTokens === 0 ? {
        fileCount: 0,
        reclaimableTokens: 0,
        topFiles: []
      } : {
        fileCount: 2,
        reclaimableTokens: dupReadTokens,
        topFiles: [
          { path: primaryActiveFile, occurrences: Math.max(2, Math.min(6, Math.floor((sc.sessionMeta.turnCount || 18) / 3))), wastedTokens: Math.round(dupReadTokens * 0.65) },
          { path: 'src/webview/horizon_panel.html', occurrences: Math.max(2, Math.min(4, Math.floor((sc.sessionMeta.turnCount || 18) / 4))), wastedTokens: Math.max(0, dupReadTokens - Math.round(dupReadTokens * 0.65)) }
        ]
      },
      oldHistory: {
        turnCount: sludgeTokens === 0 ? 0 : Math.max(1, (sc.sessionMeta.turnCount || 20) - 5),
        reclaimableTokens: staleTurnTokens
      },
      deadErrors: sludgeTokens === 0 ? {
        errorCount: 0,
        reclaimableTokens: 0,
        isErrorLoop: false,
        topErrors: []
      } : {
        errorCount: 3,
        reclaimableTokens: deadErrorTokens,
        isErrorLoop: meta.id === 5,
        topErrors: [
          { target: 'node --test (exit 1)', occurrences: 3, wastedTokens: deadErrorTokens }
        ]
      },
      blowupSteps: sludgeTokens === 0 ? [] : [
        {
          stepIndex: Math.min(14, Math.max(1, (sc.sessionMeta.turnCount || 18) - 2)),
          tokens: Math.min(18400, Math.round(totalActiveTokens * 0.25)),
          category: 'DUPLICATE_READ',
          target: primaryActiveFile,
          payload: { kind: 'file', tool: 'read_file', detail: `${primaryActiveFile} (unclipped read)`, path: primaryActiveFile }
        }
      ],
      userCorrections: isCrisis ? 4 : 0,
      mcpAudit: {
        unusedEagerServers: meta.id === 1 ? [] : [
          { name: 'postgres-analytics', schemaTokens: 6800, configSource: '.agents/mcp_config.json' }
        ]
      },
      activeDaemons: []
    },
    quota: {
      sprint5h: {
        remainingPct: quotaRem,
        usedPct: 100 - quotaRem,
        poolUnits: 5000000,
        resetInMinutes: 142,
        resetLabel: '2h 22m'
      },
      weekly7d: {
        remainingPct: Math.min(100, quotaRem + 15),
        usedPct: Math.max(0, 100 - Math.min(100, quotaRem + 15)),
        sprintToWeeklyMultiplier: 2.8,
        resetLabel: '4d 12h'
      },
      cache: {
        hitRatePct: (meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8)
          ? (purity > 70 ? 86.4 : 62.0)
          : 0,
        cacheReadTokens: (meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8) ? Math.round(totalActiveTokens * 0.62) : 0,
        ttlRemainingSec: (meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8) ? 215 : 0,
        isCacheCold: !(meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8),
        nextTurnLikelyWarm: (meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8),
        cachedTokens: (meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8) ? Math.round(totalActiveTokens * 0.62) : 0,
        freshTokens: (meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8) ? Math.round(totalActiveTokens * 0.38) : totalActiveTokens,
        dualTtl: {
          mainRemainingSec: (meta.id === 2 || meta.id === 3 || meta.id === 6 || meta.id === 8) ? 215 : 0,
          mainWindowLabel: (meta.id === 2 || meta.id === 3) ? '1h' : '5m',
          subagentRemainingSec: meta.id === 3 ? 180 : null,
          subagentWindowLabel: '5m',
          overageTtlCliffDetected: meta.id === 5 || meta.id === 7,
          cliffWarning: (meta.id === 5 || meta.id === 7)
            ? '1h -> 5m TTL Cliff Detected: Overage/fallback tier active; cache now expires 12x faster (300s).'
            : ''
        }
      },
      forecast: {
        nextTurnHighSprintPct: 6.4,
        turnsUntilExhaustion: Math.max(1, Math.floor(quotaRem / 6.4))
      }
    },
    subagents,
    coachState: {
      routerState: meta.routerState,
      recommendedAction: meta.recommendedAction,
      rewrite: meta.rewrite,
      taskQuotaRouter: {
        activeModel: meta.fixture.modelName,
        activeEffort: meta.fixture.effort,
        recommendDownshift: meta.id === 7,
        recommendedModelLabel: 'Gemini 3.8 Flash (Low)',
        coachPillText: meta.routerState !== 'ALLOW_ACTIVE_SET' ? meta.recommendedAction : ''
      }
    },
    diagnostics: {
      status: isCrisis ? 'AMPUTATION_CRISIS' : (purity < 60 ? 'SLUDGE_HEAVY' : (meta.routerState !== 'ALLOW_ACTIVE_SET' ? meta.routerState : 'HEALTHY')),
      headline: meta.title,
      summary: `Complaint: "${meta.complaint}" — ${meta.recommendedAction}`,
      recommendedCommand: isCrisis || purity < 55 ? '/compact' : meta.recommendedAction,
      reclaimableTokens: sludgeTokens,
      foreignBleedDetected: meta.id === 5,
      dirtySnapshotPaths: sc.fileState?.dirtySnapshotPaths || (meta.id === 6 ? ['src/routes.mjs'] : []),
      unseenCallers: sc.fileState?.unseenCallers || (meta.id === 6 ? ['src/app.mjs'] : [])
    },
    effortGovernor: {
      activeProfile: {
        id: meta.fixture.effort,
        label: meta.fixture.effort.toUpperCase(),
        safeLimit: 140000,
        thinkingReserve: meta.fixture.effort === 'high' ? 25000 : 10000
      },
      recommendedEffort: isCrisis || meta.id === 7 ? 'low' : 'medium',
      reason: meta.recommendedAction
    },
    hostHealth: {
      rssGb: 0.84,
      status: 'HEALTHY',
      orphanCount: 0,
      orphanRamMb: 0,
      orphans: []
    }
  };
}
