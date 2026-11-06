/**
 * Synthetic test fixtures covering all 8 canonical session and router scenarios.
 */

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
    fileState: { activeSetPaths: ['c:/projects/ga-visualizer-v2/src/core/router.mjs'] }
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
 * Builds a complete 40-cell Horizon + Webview + HUD payload for any of the 8 demo scenarios.
 */
export function buildDemoHorizonState(scenarioNumber = 5) {
  const meta = DEMO_SCENARIOS.find(s => s.id === Number(scenarioNumber)) || DEMO_SCENARIOS[4];
  const sc = meta.fixture.sidecar;
  const totalActiveTokens = sc.telemetry.totalInputTokens || 145000;
  const maxTokens = 200000;
  const cellSize = 5000;
  const activeCells = Math.min(40, Math.max(1, Math.round(totalActiveTokens / cellSize)));
  const isCrisis = Boolean(sc.telemetry.amputationRisk || totalActiveTokens >= 140000);
  const purity = sc.telemetry.signalPurityPct ?? 35.0;

  const cells = [];
  for (let i = 0; i < 40; i++) {
    let dominantCategory = 'FREE_HEADROOM';
    let isCrisisCell = false;
    if (i < activeCells) {
      if (i < 3) {
        dominantCategory = 'ANCHOR';
        isCrisisCell = isCrisis;
      } else if (i === 3) {
        dominantCategory = meta.id === 5 || meta.id === 4 ? 'INJECTED_MEMORY' : 'ANCHOR';
        isCrisisCell = isCrisis;
      } else if (i >= activeCells - 5) {
        dominantCategory = 'ACTIVE_WORKING_SET';
      } else if (meta.id === 6 && i === activeCells - 6) {
        dominantCategory = 'STALE_TURN';
      } else if (i % 4 === 0 && (meta.id === 4 || meta.id === 5)) {
        dominantCategory = 'DEAD_ERROR';
        isCrisisCell = isCrisis && i < 8;
      } else {
        dominantCategory = purity < 60 ? 'DUPLICATE_READ' : 'ACTIVE_WORKING_SET';
        isCrisisCell = isCrisis && i < 8;
      }
    }
    const filled = i < activeCells ? cellSize : 0;
    cells.push({
      index: i,
      startToken: i * cellSize,
      endToken: (i + 1) * cellSize,
      totalTokens: filled,
      dominantCategory,
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
        target:
          i === 0 ? 'SYSTEM_PROMPT + AGENTS.md' :
          i === 1 ? 'implementation_plan.md + task.md' :
          i === 2 ? 'MCP Tool Schemas (Turn 0)' :
          dominantCategory === 'DEAD_ERROR' ? 'Failed run_command stack trace (exit 1)' :
          dominantCategory === 'DUPLICATE_READ' ? 'src/core/router.mjs (duplicate read #4)' :
          'src/core/classifier.mjs',
        stepIndex: i * 2,
        foreignBleed: meta.id === 5 && i === 3
      }] : []
    });
  }

  const sludgeTokens = Math.round(totalActiveTokens * ((100 - purity) / 100));
  const quotaRem = Math.round((sc.telemetry.quota?.remaining_fraction ?? 0.5) * 100);

  return {
    schemaVersion: '1.1.0',
    sessionId: meta.fixture.conversationId,
    sessionTitle: meta.title,
    demoMeta: meta,
    storeSource: 'demo-synthetic',
    logTierUsed: 1,
    logFilePath: 'tests/fixtures/synthetic_states.mjs',
    workspace: {
      canonicalPath: 'c:/projects/context-horizon',
      projectId: 'context-horizon-demo'
    },
    model: {
      id: meta.fixture.modelName,
      inputPricePerMillionUsd: meta.fixture.modelName.includes('pro') ? 1.25 : 0.15,
      nativeCeilingTokens: 200000
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
      ANCHOR: 15000,
      INJECTED_MEMORY: 5000,
      DUPLICATE_READ: Math.round(sludgeTokens * 0.65),
      STALE_TURN: Math.round(sludgeTokens * 0.15),
      DEAD_ERROR: Math.round(sludgeTokens * 0.20),
      ACTIVE_WORKING_SET: Math.max(5000, totalActiveTokens - sludgeTokens - 20000),
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
    offenders: [
      {
        category: 'DUPLICATE_READ',
        target: 'src/core/router.mjs',
        wastedTokens: Math.max(4200, Math.round(sludgeTokens * 0.42)),
        occurrences: 6,
        stepIndices: [3, 7, 14, 19, 26, 31],
        remediation: 'Prune 5 superseded full-file reads via Surgical Pruner or /compact'
      },
      {
        category: 'DEAD_ERROR',
        target: 'npm test (Resolved TypeError stack trace)',
        wastedTokens: Math.max(3100, Math.round(sludgeTokens * 0.28)),
        occurrences: 3,
        stepIndices: [11, 12, 13],
        remediation: 'Collapse resolved error logs into 1-line tombstones'
      },
      {
        category: 'ANCHOR',
        target: 'Unused MCP Server Schemas (Turn 0)',
        wastedTokens: 6800,
        occurrences: 1,
        stepIndices: [0],
        remediation: 'Disable 2 zero-call MCP servers consuming 16.5% Turn-0 schema tax'
      }
    ],
    brainSignals: {
      activeSignal: {
        liveSessionTokens: totalActiveTokens - sludgeTokens,
        taskMdSaved: !isCrisis,
        taskMdTurnsBehind: isCrisis ? 9 : 1,
        semanticallyPinnedTurns: 3
      },
      duplicateReads: {
        fileCount: 3,
        reclaimableTokens: Math.round(sludgeTokens * 0.65),
        topFiles: [
          { path: 'src/core/router.mjs', occurrences: 6, wastedTokens: Math.round(sludgeTokens * 0.42) },
          { path: 'src/webview/horizon_panel.html', occurrences: 4, wastedTokens: Math.round(sludgeTokens * 0.23) }
        ]
      },
      oldHistory: {
        turnCount: Math.max(0, (sc.sessionMeta.turnCount || 20) - 12),
        reclaimableTokens: Math.round(sludgeTokens * 0.15)
      },
      deadErrors: {
        errorCount: 3,
        reclaimableTokens: Math.round(sludgeTokens * 0.20),
        isErrorLoop: meta.id === 5,
        topErrors: [
          { target: 'node --test (exit 1)', occurrences: 3, wastedTokens: Math.round(sludgeTokens * 0.20) }
        ]
      },
      blowupSteps: [
        {
          stepIndex: 14,
          tokens: 18400,
          category: 'DUPLICATE_READ',
          target: 'src/webview/horizon_panel.html',
          payload: { kind: 'file', tool: 'read_file', detail: 'src/webview/horizon_panel.html (unclipped read)', path: 'src/webview/horizon_panel.html' }
        }
      ],
      userCorrections: isCrisis ? 4 : 0,
      activeDaemons: []
    },
    quota: {
      sprint5h: {
        remainingPct: quotaRem,
        usedPct: 100 - quotaRem,
        poolUnits: 5000000,
        resetInMinutes: 142
      },
      weekly7d: {
        remainingPct: Math.min(100, quotaRem + 15),
        sprintToWeeklyMultiplier: 2.8
      },
      cache: {
        hitRatePct: purity > 70 ? 86.4 : 41.2,
        cachedTokens: Math.round(totalActiveTokens * 0.62),
        freshTokens: Math.round(totalActiveTokens * 0.38)
      },
      forecast: {
        nextTurnHighSprintPct: 6.4,
        turnsUntilExhaustion: Math.max(1, Math.floor(quotaRem / 6.4))
      }
    },
    subagents: {
      count: 2,
      totalChildTokens: 64000,
      totalParentSummaryTokens: 1800,
      overallCompressionRatio: 35.6,
      invocations: [
        { stepIndex: 8, role: 'Codebase Researcher', typeName: 'research', workspace: 'inherit', childTokens: 38000, summaryTokens: 950, compressionRatio: 40.0 }
      ]
    },
    diagnostics: {
      status: isCrisis ? 'AMPUTATION_CRISIS' : (purity < 60 ? 'SLUDGE_HEAVY' : 'HEALTHY'),
      headline: meta.title,
      summary: `Complaint: "${meta.complaint}" — ${meta.recommendedAction}`,
      recommendedCommand: isCrisis || purity < 55 ? '/compact' : '/precheck',
      reclaimableTokens: meta.reclaimTokens,
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
      recommendedEffort: isCrisis ? 'low' : 'medium',
      reason: meta.recommendedAction
    },
    hostHealth: {
      orphanCount: meta.id === 5 ? 2 : 0,
      orphanRamMb: meta.id === 5 ? 570 : 0,
      orphans: meta.id === 5 ? [
        { pid: 41820, name: 'language_server_windows_x64.exe', rssMb: 450, reason: 'Detached parent PID' },
        { pid: 44912, name: 'node.exe (mcp-server)', rssMb: 120, reason: 'Zombie MCP stdio pipe' }
      ] : []
    }
  };
}

