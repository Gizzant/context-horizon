/**
 * @file src/core-isomorphic/catalog/detectorCatalog.mjs
 * Unified DET-01..32 Detector Catalog for Highbeam v4.0.
 *
 * Standardizes scratchpad loop detection on DET-30 across both hosts
 * while accepting DET-21 as a deprecated config alias.
 *
 * Pure JS / ESM with strictly 0 node:* imports.
 */

export const DETECTOR_CATALOG = Object.freeze({
  'DET-01': Object.freeze({
    id: 'DET-01',
    name: 'Option Argument Skipping & Destructive Git/Shell Guard',
    primarySlug: 'git-shell-safety',
    aliases: Object.freeze(['destructive-git', 'git-hook-bypass']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    description: 'Intercepts destructive Git/shell commands (--no-verify, push --force, reset --hard, rm -rf /)',
    origin: 'CC DET-01 / GA DET-08, DET-19'
  }),
  'DET-02': Object.freeze({
    id: 'DET-02',
    name: 'Zero-Token Secret & Sensitive File Guard',
    primarySlug: 'secret-boundary',
    aliases: Object.freeze(['env-read-leak', 'secret-leakage']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    description: 'Blocks credential pastes and unauthorized reads of sensitive files (.env, id_rsa, keys)',
    origin: 'CC DET-02 / GA DET-15'
  }),
  'DET-03': Object.freeze({
    id: 'DET-03',
    name: 'Lockfile & Migration Scope Drift Guard',
    primarySlug: 'scope-drift',
    aliases: Object.freeze(['lockfile-edit', 'protected-files']),
    severity: 'WARN',
    defaultMode: 'guard',
    description: 'Requires confirmation before modifying package lockfiles or database migrations',
    origin: 'CC DET-03 / GA Scope Guard'
  }),
  'DET-04': Object.freeze({
    id: 'DET-04',
    name: '3-Strike Consecutive Tool Failure Breaker',
    primarySlug: 'retry-churn',
    aliases: Object.freeze(['3-strike-churn']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Halts execution after 3 consecutive failures on the same tool target without hypothesis revision',
    origin: 'CC DET-04 / GA DET-01'
  }),
  'DET-05': Object.freeze({
    id: 'DET-05',
    name: 'Destructive Code-Strip, Test-Weakening & Flip-Flop Guard',
    primarySlug: 'edit-oscillation',
    aliases: Object.freeze(['destructive-code-strip', 'diff-thrashing', 'assertion-weakening']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    description: 'Blocks >50% unprompted code shrinkage, lazy elision, stripped assertions, and 6-turn FNV-1a flip-flops',
    origin: 'CC DET-05 / GA DET-02, DET-05'
  }),
  'DET-06': Object.freeze({
    id: 'DET-06',
    name: 'Unmodified File Re-Read & Blind-Edit Guard',
    primarySlug: 'redundant-reread',
    aliases: Object.freeze(['blind-search', 'unmodified-reread']),
    severity: 'MEDIUM',
    defaultMode: 'advisory',
    description: 'Advises against repeated reading of unchanged files or creating greenfield modules without prior search',
    origin: 'CC DET-06 / GA DET-06'
  }),
  'DET-07': Object.freeze({
    id: 'DET-07',
    name: 'Exit-Safe CLI Compressor & Output Bomb Guard',
    primarySlug: 'output-bomb',
    aliases: Object.freeze(['exit-safe-compressor', 'cli-flood']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Compresses large CLI dumps (>4k tokens) retaining head/tail/errors, offloading full output to FTS5',
    origin: 'CC DET-07 / GA DET-07, DET-10'
  }),
  'DET-08': Object.freeze({
    id: 'DET-08',
    name: 'KV-Cache Gravity Cross-Model Switch Guard',
    primarySlug: 'cache-gravity-hold',
    aliases: Object.freeze(['model-switch-buffer']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Prevents wasteful mid-session model switches when warm KV-cache savings outweigh cold cheaper model prefill',
    origin: 'CC DET-08 / GA Adapter'
  }),
  'DET-09': Object.freeze({
    id: 'DET-09',
    name: 'Warm Prefix-Cache Mutation Fence',
    primarySlug: 'prefix-mutation-fence',
    aliases: Object.freeze(['rule-file-fence']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Defers mid-session edits to AGENTS.md, CLAUDE.md, and .mcp.json to post-compaction mutation queue',
    origin: 'CC DET-09 / GA DET-09'
  }),
  'DET-10': Object.freeze({
    id: 'DET-10',
    name: 'Idle 5m Implicit-Cache Watchdog',
    primarySlug: 'ttl-watchdog',
    aliases: Object.freeze(['idle-watchdog']),
    severity: 'WARN',
    defaultMode: 'advisory',
    description: 'Monitors 5-minute ephemeral cache TTL countdown and flushes StateBaton before cache expiration',
    origin: 'CC DET-10 / GA DET-16'
  }),
  'DET-11': Object.freeze({
    id: 'DET-11',
    name: 'Shadow File Context Bloat & Confabulation Guard',
    primarySlug: 'shadow-file-bloat',
    aliases: Object.freeze(['context-rot', 'phantom-file']),
    severity: 'MEDIUM',
    defaultMode: 'advisory',
    description: 'Detects shadowed file context bloat (>60k tokens, >35% distractor ratio) and nonexistent path references',
    origin: 'CC DET-11 / GA DET-17'
  }),
  'DET-12': Object.freeze({
    id: 'DET-12',
    name: 'Haiku 100k Cliff Breaker & Zombie Subprocess Leak Guard',
    primarySlug: 'haiku-pre-cliff',
    aliases: Object.freeze(['file-shrinkage', 'zombie-process']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    description: 'Circuit breaker at >=98,000 prompt tokens on Haiku 5.5 to avoid 5x pricing cliff; audits zombie processes',
    origin: 'CC DET-12 / GA DET-22'
  }),
  'DET-13': Object.freeze({
    id: 'DET-13',
    name: 'Eager MCP Override & Startup Bloat Auditor',
    primarySlug: 'mcp-schema-bloat',
    aliases: Object.freeze(['eager-mcp-auditor']),
    severity: 'MEDIUM',
    defaultMode: 'advisory',
    description: 'Audits startup bloat from eager MCP server schemas (>15k tokens) and advises lazy loading',
    origin: 'CC DET-13 / GA DET-03, DET-13'
  }),
  'DET-14': Object.freeze({
    id: 'DET-14',
    name: 'Premature Stop Gate & Test Verification Guard',
    primarySlug: 'premature-stop-gate',
    aliases: Object.freeze(['empty-catch', 'premature-stop']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Prevents task completion when source files were mutated without running project test verification suites',
    origin: 'CC DET-14 / GA DET-23'
  }),
  'DET-15': Object.freeze({
    id: 'DET-15',
    name: 'Batched Stop-Phase Formatter & Placeholder Slop Guard',
    primarySlug: 'batch-formatter',
    aliases: Object.freeze(['placeholder-slop']),
    severity: 'MEDIUM',
    defaultMode: 'advisory',
    description: 'Detects unimplemented TODO placeholders and queues automated code formatting at stop boundary',
    origin: 'CC DET-15 / GA DET-14'
  }),
  'DET-16': Object.freeze({
    id: 'DET-16',
    name: 'Hybrid Quota Fan-Out Throttle & Subagent Recursion Cap',
    primarySlug: 'subagent-cap',
    aliases: Object.freeze(['quota-fanout-throttle']),
    severity: 'HIGH',
    defaultMode: 'advisory',
    description: 'Enforces subagent caps (max 12 turns, 40k tokens) and throttles parallel workers when quota exceeds 80%',
    origin: 'CC DET-16 / GA DET-05, DET-16'
  }),
  'DET-17': Object.freeze({
    id: 'DET-17',
    name: 'Blind Edit Mid-Batch & Progressive Checkpoint Deferral',
    primarySlug: 'blind-edit',
    aliases: Object.freeze(['progressive-checkpoint-deferral']),
    severity: 'MEDIUM',
    defaultMode: 'advisory',
    description: 'Defers automated compaction triggers while multi-file edits are actively in-flight',
    origin: 'CC DET-17 / GA DET-21, DET-25'
  }),
  'DET-18': Object.freeze({
    id: 'DET-18',
    name: 'Untrusted Workspace Settings & Hook Injection Guard',
    primarySlug: 'untrusted-settings',
    aliases: Object.freeze(['settings-rce-guard']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    description: 'Blocks untrusted mutations to settings.json/hooks.json containing remote curl|sh, autoApprove, or RCE vectors',
    origin: 'CC DET-18 / GA DET-18'
  }),
  'DET-19': Object.freeze({
    id: 'DET-19',
    name: 'Subagent IPI Boundary & Unicode Tag Sanitizer',
    primarySlug: 'subagent-ipi',
    aliases: Object.freeze(['unicode-tag-scrubber', 'git-hook-bypass']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Scrubs Unicode Tag plane characters (U+E0000..U+E007F) and indirect prompt injection attacks at subagent boundaries',
    origin: 'CC DET-19 / GA IPI Sanitizer'
  }),
  'DET-20': Object.freeze({
    id: 'DET-20',
    name: 'Multi-Agent Scope Collision & Hard Quota Brake',
    primarySlug: 'scope-lock',
    aliases: Object.freeze(['concurrent-worktree-lock', 'vision-overage']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    description: 'Halts concurrent file lease collisions across subagents and blocks requests when 5h quota is exhausted',
    origin: 'CC DET-20 / GA DET-20'
  }),
  'DET-21': Object.freeze({
    id: 'DET-21',
    name: 'Scratchpad Loop Guard (Deprecated Alias -> DET-30)',
    primarySlug: 'thinking-drift-loop',
    aliases: Object.freeze(['scratchpad-loop', 'thinking-drift']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    aliasOf: 'DET-30',
    description: 'Deprecated alias for DET-30 scratchpad loop detection in .attention-horizon.json',
    origin: 'CC DET-21 alias'
  }),
  'DET-22': Object.freeze({
    id: 'DET-22',
    name: 'Diff-Thrashing & Rapid Code Mutation Sensor',
    primarySlug: 'diff-thrashing',
    aliases: Object.freeze(['file-shrinkage-rapid']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Detects repeated edit hunks undoing/replacing prior edits within 3 turns on the same target',
    origin: 'GA DET-22'
  }),
  'DET-23': Object.freeze({
    id: 'DET-23',
    name: 'Empty Catch-Block & Swallowed Error Sensor',
    primarySlug: 'empty-catch-block',
    aliases: Object.freeze(['swallowed-error', 'knowledge-bleed']),
    severity: 'HIGH',
    defaultMode: 'advisory',
    description: 'Flags introduction of empty catch blocks (catch (e) {}) lacking logging, handling, or re-throw',
    origin: 'GA DET-23'
  }),
  'DET-24': Object.freeze({
    id: 'DET-24',
    name: 'Context Degradation & High-Turn Prompt Bloat Sensor',
    primarySlug: 'high-turn-degradation',
    aliases: Object.freeze(['prompt-bloat']),
    severity: 'MEDIUM',
    defaultMode: 'advisory',
    description: 'Advises /compact or /handoff when session turn depth exceeds 30 turns with degraded instruction compliance',
    origin: 'GA DET-24'
  }),
  'DET-25': Object.freeze({
    id: 'DET-25',
    name: 'Cascade 70k Progressive Checkpoint Sensor',
    primarySlug: 'progressive-checkpoint',
    aliases: Object.freeze(['cascade-handshake', 'foreign-bleed']),
    severity: 'INFO',
    defaultMode: 'advisory',
    description: 'Triggers intermediate StateBaton persistence as prompt context crosses 70k token cascade checkpoint bands',
    origin: 'GA DET-25'
  }),
  'DET-26': Object.freeze({
    id: 'DET-26',
    name: 'Monolithic Prompt Decomposer Sensor',
    primarySlug: 'prompt-decomposer',
    aliases: Object.freeze(['monolithic-prompt', 'legacy-poison']),
    severity: 'INFO',
    defaultMode: 'advisory',
    description: 'Detects complex monolithic prompts (>4 distinct goals) and recommends decomposition into subtasks',
    origin: 'GA DET-26'
  }),
  'DET-27': Object.freeze({
    id: 'DET-27',
    name: 'Rule File Bloat & Prefix Diet Auditor',
    primarySlug: 'rule-file-bloat',
    aliases: Object.freeze(['prefix-diet', 'unseen-callers']),
    severity: 'WARN',
    defaultMode: 'advisory',
    description: 'Audits AGENTS.md / CLAUDE.md files exceeding 8,000 tokens and routes domain sections to /evolve skills',
    origin: 'GA DET-27'
  }),
  'DET-28': Object.freeze({
    id: 'DET-28',
    name: 'Subagent Phantom & Orphan Process Sensor',
    primarySlug: 'subagent-phantom',
    aliases: Object.freeze(['orphan-subagent', 'dirty-snap']),
    severity: 'HIGH',
    defaultMode: 'advisory',
    description: 'Flags background subagents or LSP child processes running unmonitored for >5 minutes',
    origin: 'GA DET-28'
  }),
  'DET-29': Object.freeze({
    id: 'DET-29',
    name: 'Reflector Queue Starvation & Async Feedback Gate',
    primarySlug: 'reflector-queue',
    aliases: Object.freeze(['async-feedback', 'turn-zero-gate']),
    severity: 'MEDIUM',
    defaultMode: 'guard',
    description: 'Guarantees unacknowledged async errors and staged reflector learnings are flushed at turn boundaries',
    origin: 'GA DET-29'
  }),
  'DET-30': Object.freeze({
    id: 'DET-30',
    name: 'Scratchpad Loop & Reasoning Hallucination Guard',
    primarySlug: 'thinking-drift-loop',
    aliases: Object.freeze(['scratchpad-loop', 'thinking-drift']),
    severity: 'CRITICAL',
    defaultMode: 'guard',
    description: 'Fires when thinking tokens >4k, ratio >12x output, and 0 mutating tool calls persist across >=2 turns',
    origin: 'Unified Standard (GA DET-30, CC DET-21)'
  }),
  'DET-31': Object.freeze({
    id: 'DET-31',
    name: 'Cross-Worktree Git Merge Conflict Sensor',
    primarySlug: 'worktree-merge-conflict',
    aliases: Object.freeze(['git-merge-tree-probe']),
    severity: 'HIGH',
    defaultMode: 'advisory',
    description: 'Runs non-destructive git merge-tree --write-tree probe (<12ms) to detect merge conflicts across active worktrees',
    origin: 'Unified v4.0 Moat (Gap 2)'
  }),
  'DET-32': Object.freeze({
    id: 'DET-32',
    name: 'IOEDR / REMORY Semantic Drift & Contradiction Guard',
    primarySlug: 'semantic-drift-guard',
    aliases: Object.freeze(['hypothesis-loop', 'ioedr-remory-guard']),
    severity: 'HIGH',
    defaultMode: 'guard',
    description: 'Detects actions contradicting locked task.md invariants or repeating falsified hypotheses across >=3 turns; injects <300-token re-anchoring directive',
    origin: 'Unified v4.0 Moat (IOEDR/REMORY)'
  })
});

const SLUG_TO_CANONICAL = new Map();
for (const [id, meta] of Object.entries(DETECTOR_CATALOG)) {
  if (meta.primarySlug) {
    SLUG_TO_CANONICAL.set(meta.primarySlug.toLowerCase(), meta);
  }
  if (Array.isArray(meta.aliases)) {
    for (const a of meta.aliases) {
      SLUG_TO_CANONICAL.set(String(a).toLowerCase(), meta);
    }
  }
}

/**
 * Resolves a detector ID, mapping deprecated aliases (e.g. DET-21 -> DET-30) and slugs.
 *
 * @param {string} id
 * @returns {string}
 */
export function resolveDetectorId(id) {
  const norm = String(id || '').trim().toUpperCase();
  if (norm === 'DET-21' || norm === 'DET21') return 'DET-30';
  const lower = String(id || '').trim().toLowerCase();
  const slugMeta = SLUG_TO_CANONICAL.get(lower);
  if (slugMeta) return slugMeta.aliasOf || slugMeta.id;
  return norm;
}

/**
 * Backward-compatible alias for resolveDetectorId.
 */
export const resolveCanonicalDetectorId = resolveDetectorId;

/**
 * Returns detector metadata for a given ID (resolving aliases and slugs).
 *
 * @param {string} id
 * @returns {object | null}
 */
export function getDetectorMeta(id) {
  const canonical = resolveDetectorId(id);
  if (DETECTOR_CATALOG[canonical]) return DETECTOR_CATALOG[canonical];
  const lower = String(id || '').trim().toLowerCase();
  const slugMeta = SLUG_TO_CANONICAL.get(lower);
  if (slugMeta) return DETECTOR_CATALOG[slugMeta.aliasOf || slugMeta.id] || slugMeta;
  return DETECTOR_CATALOG[id] || null;
}

/**
 * Map-like facade for detector catalog lookup per SCOPE.md interface contract.
 */
export const detectors = Object.freeze({
  get(id) {
    const norm = String(id || '').trim().toUpperCase();
    if (DETECTOR_CATALOG[norm]) return DETECTOR_CATALOG[norm];
    const lower = String(id || '').trim().toLowerCase();
    const slugMeta = SLUG_TO_CANONICAL.get(lower);
    if (slugMeta) return DETECTOR_CATALOG[slugMeta.aliasOf || slugMeta.id] || slugMeta;
    const canonical = resolveDetectorId(id);
    return DETECTOR_CATALOG[canonical] || null;
  },
  has(id) {
    const norm = String(id || '').trim().toUpperCase();
    if (Boolean(DETECTOR_CATALOG[norm])) return true;
    const lower = String(id || '').trim().toLowerCase();
    if (SLUG_TO_CANONICAL.has(lower)) return true;
    const canonical = resolveDetectorId(id);
    return Boolean(DETECTOR_CATALOG[canonical]);
  },
  keys() {
    return Object.keys(DETECTOR_CATALOG);
  },
  values() {
    return Object.values(DETECTOR_CATALOG);
  },
  entries() {
    return Object.entries(DETECTOR_CATALOG);
  }
});

/**
 * Legacy Antigravity v3 numeric detector ID translation map to canonical v4 DET-01..32 IDs.
 * Ensures legacy GA DET-01 ("retry-churn") maps to DET-04 (never disabling DET-01 git-shell-safety)
 * and legacy GA DET-02 ("edit-oscillation") maps to DET-05 (never disabling DET-02 secret-boundary).
 */
export const LEGACY_GA_V3_ID_MAP = Object.freeze({
  'DET-01': 'DET-04',
  'DET-02': 'DET-05',
  'DET-03': 'DET-05',
  'DET-06': 'DET-06',
  'DET-08': 'DET-01',
  'DET-09': 'DET-09',
  'DET-10': 'DET-07',
  'DET-11': 'DET-29',
  'DET-12': 'DET-22',
  'DET-13': 'DET-13',
  'DET-14': 'DET-15',
  'DET-14B': 'DET-15',
  'DET-15': 'DET-02',
  'DET-16': 'DET-10',
  'DET-17': 'DET-11',
  'DET-17B': 'DET-11',
  'DET-18': 'DET-18',
  'DET-19': 'DET-01',
  'DET-20': 'DET-20',
  'DET-21': 'DET-30',
  'DET-30': 'DET-30',
  'DET-31': 'DET-31',
  'DET-32': 'DET-32'
});

const RING0_IDS = new Set(['DET-01', 'DET-02', 'DET-18', 'DET-19']);

/**
 * Migrates a raw `.attention-horizon.json` config object from legacy GA v3 or CC v1
 * into canonical v4 `DET-01..32` IDs while enforcing Ring-0 safety clamping.
 *
 * @param {object} [rawConfig={}]
 * @param {object} [options={}]
 * @returns {object}
 */
export function migrateLegacyHorizonConfig(rawConfig = {}, options = {}) {
  if (!rawConfig || typeof rawConfig !== 'object') return {};
  const ns = String(options.fromNamespace || rawConfig.detectorNamespace || '')
    .trim()
    .toLowerCase();
  const isLegacyAntigravity = ns === 'antigravity' || ns === 'ga-v3';
  const isUnnamespaced = !ns;

  const migratedDetectors = {};
  const rawDetectors =
    rawConfig.detectors && typeof rawConfig.detectors === 'object' ? rawConfig.detectors : {};

  for (const [rawKey, rawMode] of Object.entries(rawDetectors)) {
    const upper = String(rawKey || '').trim().toUpperCase();
    let canonicalId = null;
    if (isLegacyAntigravity && LEGACY_GA_V3_ID_MAP[upper]) {
      canonicalId = LEGACY_GA_V3_ID_MAP[upper];
    } else {
      canonicalId = resolveDetectorId(rawKey);
    }
    if (!canonicalId || !DETECTOR_CATALOG[canonicalId]) continue;
    let mode = rawMode;
    if (
      (isLegacyAntigravity || isUnnamespaced) &&
      RING0_IDS.has(canonicalId) &&
      (mode === 'off' || mode === false || mode === 'disable' || mode === 'disabled')
    ) {
      mode = 'warn';
    }
    migratedDetectors[canonicalId] = mode;
  }

  return {
    ...rawConfig,
    detectorNamespace: 'unified-v4',
    detectors: migratedDetectors
  };
}

export const CORE_AUDITABLE_GUARDS = Object.freeze([
  Object.freeze({
    id: 'GUARD-1',
    name: 'Warm Cache Lock & TTL Cliff Guard',
    detectorIds: Object.freeze(['DET-08', 'DET-09', 'DET-10', 'DET-12', 'DET-25']),
    description: 'Holds prefix-mutating compaction/rule edits while 95% cache is warm and prevents Haiku 100k / 5m TTL cliff re-buys.'
  }),
  Object.freeze({
    id: 'GUARD-2',
    name: 'Safe Horizon & Prefix Amputation Guard',
    detectorIds: Object.freeze(['DET-11', 'DET-17', 'DET-24', 'DET-27', 'DET-29']),
    description: 'Protects Turn-0 AGENTS.md/CLAUDE.md anchors from sliding-window truncation and enforces progressive 70k checkpoints.'
  }),
  Object.freeze({
    id: 'GUARD-3',
    name: 'Middle-Trough Specification Stranding Guard',
    detectorIds: Object.freeze(['DET-16', 'DET-26', 'DET-32']),
    description: 'Detects stranded middle-trough specs, vague unanchored prompts, and IOEDR/REMORY invariant contradictions.'
  }),
  Object.freeze({
    id: 'GUARD-4',
    name: 'Duplicate Read & Dead Error Loop Surgeon',
    detectorIds: Object.freeze(['DET-04', 'DET-05', 'DET-06', 'DET-07', 'DET-14', 'DET-21', 'DET-22', 'DET-23', 'DET-30']),
    description: 'Intercepts repeat full-file reads, compresses >4k CLI floods, and halts 3-strike tool/scratchpad loops.'
  }),
  Object.freeze({
    id: 'GUARD-5',
    name: 'Idle Eager MCP Schema Auditor',
    detectorIds: Object.freeze(['DET-13', 'DET-15', 'DET-28']),
    description: 'Audits unused Turn-0 eager MCP server schemas (>15k tokens) and orphaned stdio worker processes.'
  }),
  Object.freeze({
    id: 'GUARD-6',
    name: 'Multi-Agent Worktree & Ring-0 Safety Guard',
    detectorIds: Object.freeze(['DET-01', 'DET-02', 'DET-03', 'DET-18', 'DET-19', 'DET-20', 'DET-31']),
    description: 'Enforces Ring-0 git/shell/secret boundaries and detects cross-worktree git merge-tree collisions.'
  })
]);

export function summarizeCoreAuditableGuards(trippedDetectorId = null) {
  const canonicalTripped = trippedDetectorId ? resolveDetectorId(trippedDetectorId) : null;
  const activeGuard = canonicalTripped
    ? CORE_AUDITABLE_GUARDS.find(g => g.detectorIds.includes(canonicalTripped)) || null
    : null;
  return {
    coreGuardCount: CORE_AUDITABLE_GUARDS.length,
    totalRuleCount: Object.keys(DETECTOR_CATALOG).length,
    trippedGuard: activeGuard,
    label: activeGuard
      ? `1 Core Guard tripped (${activeGuard.id}: ${canonicalTripped})`
      : `${CORE_AUDITABLE_GUARDS.length} Core Guards quiet (${Object.keys(DETECTOR_CATALOG).length} rules)`
  };
}

export default {
  DETECTOR_CATALOG,
  CORE_AUDITABLE_GUARDS,
  summarizeCoreAuditableGuards,
  LEGACY_GA_V3_ID_MAP,
  migrateLegacyHorizonConfig,
  resolveDetectorId,
  resolveCanonicalDetectorId,
  getDetectorMeta,
  detectors
};
