/**
 * Deterministic Zero-Prose ACTION QUEUE Control Surface
 * Evaluates active telemetry state across 5 hazard conditions and emits structured,
 * prioritized action items following the [Action] Target -> Quantified Payoff syntax.
 */

export const ACTION_QUEUE_CONFIG = Object.freeze({
  MAX_DISPLAYED_ITEMS: 4,
  STALE_TOOL_TOKEN_THRESHOLD: 3000,
  IDLE_MCP_TOKEN_THRESHOLD: 1000,
  IDLE_MCP_MIN_TURNS: 5,
  COLD_CACHE_TTL_THRESHOLD_SEC: 120,
  COLD_CACHE_MIN_WARM_TOKENS: 50000
});

export const BANNED_FILLER_WORDS = Object.freeze([
  'click to',
  'consider',
  'when ready',
  'all good',
  'nothing to do',
  'you might want',
  'please'
]);

/**
 * Builds a deterministically sorted array of actionable surgery items.
 * Returns [] when the state is completely nominal.
 *
 * @param {object} state - HorizonStatePayload or CLI telemetry object
 * @returns {Array<{
 *   id: string,
 *   kind: 'ORPHAN_PID' | 'IDLE_MCP' | 'STALE_TOOLS' | 'TROUGH_SPEC' | 'COLD_CACHE_CLIFF',
 *   priorityScore: number,
 *   pinnedSlot1: boolean,
 *   actionLabel: string,
 *   cliFlag: string,
 *   target: string,
 *   payoff: string,
 *   reclaimTokens: number,
 *   reclaimRamGb: number,
 *   commandToCopy: string,
 *   apiAction: string
 * }>}
 */
export function buildActionQueue(state = {}) {
  if (!state || typeof state !== 'object') return [];

  const items = [];
  const metrics = state.metrics || {};
  const brainSignals = state.brainSignals || {};
  const quota = state.quota || {};
  const cache = quota.cache || {};
  const hostHealth = state.hostHealth || {};
  const baseline = state.baseline || {};
  const turns = Number(state.metrics?.totalTurns || state.turns || state.steps?.length || 0);

  // 1. Orphan / Host Watchdog Breach (Pin to slot 1 if unmanaged orphans or RAM breach)
  const orphanCount = Number(hostHealth.orphanCount || 0);
  const hostRssGb = Number(hostHealth.rssGb || 0);
  const orphans = Array.isArray(hostHealth.orphans) ? hostHealth.orphans : [];
  const hasOrphanIssue = orphanCount > 0 || hostRssGb >= 4.0 || hostHealth.status === 'ZOMBIE_LEAK';

  if (hasOrphanIssue) {
    const firstOrphan = orphans[0] || {};
    const isScheduled = firstOrphan.reason === 'active_scheduled_task';
    const procSummary = orphans.length === 1
      ? `${firstOrphan.name || 'process'} (PID ${firstOrphan.pid || '?'})${firstOrphan.scheduleDetails ? ' ' + firstOrphan.scheduleDetails : ''}`
      : `${orphanCount} process PIDs (${orphans.map(o => o.pid).filter(Boolean).slice(0, 3).join(', ')}${orphans.length > 3 ? '…' : ''})`;

    const reclaimRamGb = hostRssGb > 0
      ? hostRssGb
      : parseFloat(((orphans.reduce((sum, o) => sum + (o.rssMb || 0), 0)) / 1024).toFixed(2));

    const ramStr = reclaimRamGb > 0 ? `${reclaimRamGb} GB RAM` : (firstOrphan.rssMb ? `${firstOrphan.rssMb} MB RAM` : 'host RAM');
    const isDetachedDead = Boolean(firstOrphan.parentAlive === false || firstOrphan.reason === 'detached_parent_pid' || firstOrphan.reason === 'multicall_schedule_leak');

    items.push({
      id: 'aq-orphan-reap',
      kind: 'ORPHAN_PID',
      priorityScore: 1000000 + Math.round(reclaimRamGb * 10000),
      pinnedSlot1: isDetachedDead || hostHealth.status === 'ZOMBIE_LEAK',
      actionLabel: isScheduled ? `[Stop ${orphanCount} Cron PID${orphanCount === 1 ? '' : 's'}]` : `[Reap ${orphanCount} Orphan PID${orphanCount === 1 ? '' : 's'}]`,
      cliFlag: 'doctor --reap-orphans',
      target: procSummary,
      payoff: `reclaims ${ramStr}`,
      reclaimTokens: 0,
      reclaimRamGb,
      commandToCopy: 'npx ctxtop doctor --reap-orphans',
      apiAction: 'reap-orphans'
    });
  }

  // 2. Idle Eager MCP Schema Tax
  const mcpAudit = state.baseline?.mcpAudit || brainSignals.mcpAudit || {};
  const unusedEager = Array.isArray(mcpAudit.unusedEagerServers)
    ? mcpAudit.unusedEagerServers
    : [];

  const eligibleEager = unusedEager.filter(s =>
    (s.schemaTokens || 0) >= ACTION_QUEUE_CONFIG.IDLE_MCP_TOKEN_THRESHOLD &&
    (s.sessionCallCount || 0) === 0
  );

  if (eligibleEager.length > 0 && turns >= ACTION_QUEUE_CONFIG.IDLE_MCP_MIN_TURNS) {
    const totalSchemaTok = eligibleEager.reduce((s, r) => s + Math.max(0, (r.schemaTokens || 0) - (r.listingTokens || 0)), 0);
    const serverNames = eligibleEager.map(s => s.name).join(', ');
    const tokK = (totalSchemaTok / 1000).toFixed(1);

    items.push({
      id: 'aq-idle-mcp',
      kind: 'IDLE_MCP',
      priorityScore: 250000 + totalSchemaTok * 10,
      pinnedSlot1: false,
      actionLabel: `[Defer ${eligibleEager.length} Idle MCP${eligibleEager.length === 1 ? '' : 's'}]`,
      cliFlag: 'doctor --audit-mcp',
      target: serverNames,
      payoff: `saves ${tokK}k tok/turn (0 calls in ${turns}t)`,
      reclaimTokens: totalSchemaTok,
      reclaimRamGb: 0,
      commandToCopy: `Please update ~/.gemini/config/mcp_config.json (or .agents/mcp_config.json) to set "${serverNames}" to "loading": "lazy" so unused schemas do not bloat Turn-0 prefix tokens.`,
      apiAction: 'mcp-switch-lazy'
    });
  }

  // 3. Stale Tool Outputs / Deduplication (Tool Surgeon)
  const dupTokens = Number(brainSignals.duplicateReads?.reclaimableTokens || 0);
  const deadErrorTokens = Number(brainSignals.deadErrors?.reclaimableTokens || 0);
  const oldHistTokens = Number(brainSignals.oldHistory?.reclaimableTokens || 0);
  const reclaimableToolTokens = dupTokens + deadErrorTokens + oldHistTokens;
  const staleTurnCount = Number(brainSignals.oldHistory?.turnCount || 0) +
    Number(brainSignals.deadErrors?.errorCount || 0) +
    Number(brainSignals.duplicateReads?.fileCount || 0);

  if (reclaimableToolTokens >= ACTION_QUEUE_CONFIG.STALE_TOOL_TOKEN_THRESHOLD) {
    const tokK = (reclaimableToolTokens / 1000).toFixed(1);
    const countLabel = staleTurnCount > 0 ? `${staleTurnCount} Stale Turn${staleTurnCount === 1 ? '' : 's'}` : 'Stale Tool Outputs';

    items.push({
      id: 'aq-tool-prune',
      kind: 'STALE_TOOLS',
      priorityScore: 300000 + reclaimableToolTokens * 10,
      pinnedSlot1: false,
      actionLabel: `[Prune ${countLabel}]`,
      cliFlag: 'doctor --prune-tools',
      target: 'Tool Surgeon (--prune-tools)',
      payoff: `reclaims ~${tokK}k tok (zero LLM loss)`,
      reclaimTokens: reclaimableToolTokens,
      reclaimRamGb: 0,
      commandToCopy: 'npx ctxtop prune',
      apiAction: 'condense-ast'
    });
  }

  // 4. Trough Spec Drift (Parabolic Attention Trough)
  const topRisky = Array.isArray(state.topRiskyCells) ? state.topRiskyCells : [];
  const troughSpecCell = topRisky.find(c =>
    (c.riskReason === 'TROUGH_STRANDED_SPEC' || c.inTrough) &&
    /task\.md|implementation_plan\.md|agents\.md|claude\.md/i.test(String(c.filePath || ''))
  );

  if (troughSpecCell) {
    const cellNum = troughSpecCell.cellNumber || ((troughSpecCell.cellIndex ?? 0) + 1);
    const baseFile = String(troughSpecCell.filePath || 'task.md').split(/[/\\]/).pop();
    const recallGain = Math.max(10, 100 - (troughSpecCell.attentionRecallPct || 40));

    items.push({
      id: 'aq-trough-spec',
      kind: 'TROUGH_SPEC',
      priorityScore: 200000 + (troughSpecCell.tokenWeight || 6400) * 10,
      pinnedSlot1: false,
      actionLabel: '[Re-Anchor Spec Cell]',
      cliFlag: 'checkpoint --reanchor',
      target: `Cell #${cellNum} (${baseFile})`,
      payoff: `restores recall weight (+${recallGain}% attention)`,
      reclaimTokens: 0,
      reclaimRamGb: 0,
      commandToCopy: `Re-anchor ${baseFile} checklist to active turn`,
      apiAction: 'reanchor-spec'
    });
  }

  // 5. Cold Cache Cliff Warning (TTL expiring on warm cache)
  const ttlSec = Number(cache.ttlRemainingSec ?? cache.cacheTtlRemainingSec ?? -1);
  const warmTokens = Number(state.window?.totalActiveTokens || metrics.totalInputTokens || 0);
  const isCacheWarm = Number(cache.hitPercent || 0) > 0 || Number(cache.cacheReadTokens || 0) > 0;

  if (
    ttlSec > 0 &&
    ttlSec <= ACTION_QUEUE_CONFIG.COLD_CACHE_TTL_THRESHOLD_SEC &&
    warmTokens >= ACTION_QUEUE_CONFIG.COLD_CACHE_MIN_WARM_TOKENS &&
    isCacheWarm
  ) {
    items.push({
      id: 'aq-cold-cliff',
      kind: 'COLD_CACHE_CLIFF',
      priorityScore: 150000 + (120 - ttlSec) * 1000,
      pinnedSlot1: false,
      actionLabel: '[Distill Handoff Now]',
      cliFlag: 'handoff --distill',
      target: `TTL expires in ${ttlSec}s`,
      payoff: 'avoids 12.5x cold cache rewrite',
      reclaimTokens: 0,
      reclaimRamGb: 0,
      commandToCopy: 'npx ctxtop doctor --handoff',
      apiAction: 'generate-handoff'
    });
  }

  // Deterministic Sorting:
  // - Any item with pinnedSlot1 = true is sorted to position 0
  // - Otherwise, sorted descending by priorityScore
  items.sort((a, b) => {
    if (a.pinnedSlot1 && !b.pinnedSlot1) return -1;
    if (!a.pinnedSlot1 && b.pinnedSlot1) return 1;
    return b.priorityScore - a.priorityScore;
  });

  return items.slice(0, ACTION_QUEUE_CONFIG.MAX_DISPLAYED_ITEMS);
}

/**
 * Formats the Action Queue into high-contrast ANSI tree output for the CLI HUD.
 * Returns "" (empty string) when items is empty (Zero-Height Collapse).
 *
 * @param {object|Array} stateOrQueue
 * @returns {string}
 */
export function formatActionQueueAnsi(stateOrQueue = {}) {
  const queue = Array.isArray(stateOrQueue)
    ? stateOrQueue
    : buildActionQueue(stateOrQueue);

  if (!queue || queue.length === 0) return '';

  const totalTok = queue.reduce((s, item) => s + (item.reclaimTokens || 0), 0);
  const totalRamGb = queue.reduce((s, item) => s + (item.reclaimRamGb || 0), 0);

  const parts = [];
  if (totalTok > 0) parts.push(`${(totalTok / 1000).toFixed(1)}k tok`);
  if (totalRamGb > 0) parts.push(`${totalRamGb.toFixed(2)} GB RAM`);
  const summaryStr = parts.length > 0 ? ` — ${parts.join(' + ')} reclaimable` : '';

  const header = `\x1b[1;37mACTION QUEUE (${queue.length})${summaryStr}\x1b[0m`;
  const lines = [header];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const isLast = i === queue.length - 1;
    const branch = isLast ? '└─' : '├─';

    // 3-Column Aligned Syntax:
    // Col 1: Action (pad to 24 chars)
    // Col 2: Target (pad to 32 chars)
    // Col 3: Payoff
    const col1 = item.actionLabel.padEnd(24, ' ');
    const col2 = item.target.padEnd(32, ' ');
    const col3 = `-> ${item.payoff}`;

    lines.push(`\x1b[36m${branch}\x1b[0m \x1b[1;33m${col1}\x1b[0m \x1b[37m${col2}\x1b[0m \x1b[32m${col3}\x1b[0m`);
  }

  return lines.join('\n');
}
