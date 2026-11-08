# Telemetry Data Contracts & State Models

## Source: scripts/sync_mirrors.mjs
```javascript
/**
 * T4.2: Canonical Mirror Synchronization & SHA-256 Parity Verifier.
 *
 * Keeps core modules and the WebView HTML (`horizon_panel.html` / `sidepane.html`)
 * byte-for-byte identical across the repository root and any installed local
 * Antigravity plugin mirrors (`~/.gemini/config/plugins/agy-horizon*`).
 */

```

## Source: src/cli/doctor.mjs
```javascript
/**
 * Runs a comprehensive diagnosis of the Context Horizon (ctxtop) environment.
 */

```

## Source: src/cli/horizon_hud.mjs
```javascript
/**
 * Renders the ANSI statusLine bar and full 256K-aware HorizonStatePayload for Antigravity CLI / Sidecar Daemon
 */

```

## Source: src/core/baseline.mjs
```javascript
/**
 * Per-source estimate of the "workspace baseline" that is re-sent every turn:
 * rules (AGENTS.md / GEMINI.md / .agents/rules / plugin rules), the skill list
 * (name + description frontmatter only) and MCP tool listings.
 *
 * Token counts are ceil(bytes / 4) and always flagged `exact: false`.
 * MCP servers report the lazy listing cost (tool names + instructions.md) as
 * `tokens`, and the full schema size as `schemaTokens` (what eager loading would cost).
 * Results are memoised on a stat signature (path + mtime + size).
 */

/**
 * Parses `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`
 * to discover configured MCP servers, their loading mode (`eager` vs `lazy`),
 * and any inline tool schemas.
 */

/**
 * Phase 5 (Layer 5): MCP Prefix Bloat & Schema Audit.
 *
 * - Parses `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`.
 * - Calculates static token overhead of registered tool schemas.
 * - Flags `eager`-loaded MCP servers that have had zero tool calls across the active session
 *   and suggests switching to `lazy` loading.
 */

```

## Source: src/core/blindspot_sensors.mjs
```javascript
/**
 * Sensor 2: auditSchemaAndPayloads (SCHEMA_TAX)
 * Audits Turn 0 schema cost and oversized tool payloads (>25k tokens).
 */

/**'];
  const legacyPoison = new Set();

  for (const ev of stepEvents) {
    if (ev.isDeprecatedContent && ev.targetPath) {
      legacyPoison.add(canonicalizePath(ev.targetPath));
    } else if (ev.targetPath) {
      const lower = ev.targetPath.toLowerCase();
      const isDeprecated = deprecatedGlobs.some(g => lower.includes(g.replace(/\*/

```

## Source: src/core/classifier.mjs
```javascript
/**
 * Phase 6 (Layer 6): Parabolic U-Shaped Attention Curve & Low-Attention Trough Model.
 *
 * Models transformer attention across N populated cells using a parabolic curve with gamma ~= 0.6:
 * - Literal algebraic expression from specification:
 *     A_spec(i) = 1.0 - 4.0 * gamma * ((i / N) - 0.5)^2
 * - U-shaped recall weight (1.0 at Primacy/Recency edges, minimum 1.0 - gamma at midpoint 0.5):
 *     A_u(i) = (1.0 - gamma) + 4.0 * gamma * ((i / N) - 0.5)^2
 * - Shades the middle 30% to 70% band (or Cells 7..15) as the Low-Attention Trough.
 */

/**
 * Phase 1 (Layer 1): Evaluates Composite Operational Session Risk & Prefix-Lock Protection.
 *
 * Rules:
 * - RED: Context >= 179k (safe horizon breached) OR 7d lockout risk active without AI Credit overages enabled.
 * - AMBER: Cache TTL == 0s (cold cache window expired) OR context > 50k with pending checklist item OR task.md is >= 1 turn stale.
 * - GREEN: Total tokens < 179k AND Cache TTL > 0s AND task.md is in sync (0 turns behind).
 * - Prefix-Lock Protection Warning: Active when a session holds > 50k cached tokens with TTL > 0s.
 */

/**
 * Phase 3 (Layer 3): Evaluates State-Conditional Bar Coloring for the older history segment.
 * - Muted Slate/Teal ('Cached History â€” 95% Discounted') while TTL > 0s and totalActiveTokens <= 179k.
 * - Amber ('Reclaimable Cold Bloat') ONLY when TTL == 0s OR totalActiveTokens > 179k.
 */

/**
 * Phase 3 (Layer 3): Computes Dual-Watermark + Hard Ceiling visual markers for the context bar.
 */

/**
 * Classifies an array of parsed steps into a full 40-cell HorizonStatePayload
 */

```

## Source: src/core/constants.mjs
```javascript
/**
 * Resolves the native context window ceiling for a given model or host telemetry payload.
 * Preserves 200,000 when useLegacyDefault is true and no explicit ceiling is supplied.
 */

```

## Source: src/core/handoff_audit.mjs
```javascript
/**
 * Handoff Quality Gate & Checkpoint Auditor.
 * Adapted from .agents/skills/handoff-auditor/SKILL.md & state-compressor/SKILL.md.
 * Verifies that task.md / STATE.md is clean, actionable, and ready before compaction or handoff.
 */

/**
 * Deterministically audits task.md / STATE.md checkpoint for a session.
 * @param {string} brainDirOrPath Directory containing task.md or direct file path
 * @param {Object} [sessionSignals={}] Extracted brainSignals from classifier
 * @returns {Object} { result: 'CLEAN'|'NEEDS_FIXES'|'MISSING', checks: Array, fixes: string[] }
 */

/**
 * Phase 4 (Layer 4): Verifies all three brain artifacts (`task.md`, `implementation_plan.md`, `walkthrough.md`)
 * and checks `git status --porcelain` in the workspace. Raises `preCompactionWarning` when uncommitted
 * git modifications exist alongside a stale or missing `task.md`.
 */

/**
 * Phase 4 (Layer 4): Generates the Baton Pass (`/handoff`) Markdown file summarizing
 * active AST contracts, test states, brain artifact status, and pending `task.md` tasks.
 */

```

## Source: src/core/history.mjs
```javascript
/**
 * Per-session snapshot history powering the turn-to-turn token delta
 * ("+4.2k since last turn Â· from read_file foo.html").
 *
 * Snapshots are keyed by user-turn count: repeated polls within the same user
 * turn overwrite the latest snapshot, so the delta always compares the live
 * state against the end of the previous user turn.
 */

/**
 * One-time compact reminder per crossing of `state.window.reminderAt`.
 * Returns true exactly once per crossing; the flag re-arms after a compaction
 * (delta.compacted) or when usage falls back below the reminder line.
 */

```

## Source: src/core/layer5_hygiene.mjs
```javascript
/**
 * Phase 5 (Layer 5): Filtered Waste Classification, Fail-Open CLI Dampening Hook,
 * and Attention-Aware Rule Promotion.
 */

/**
 * Determines whether a parsed step or stepEvent represents a Cortex compaction checkpoint
 * (`CORTEX_STEP_TYPE_CHECKPOINT = 23`).
 */

/**
 * Phase 5 (Layer 5): Smart File Re-Read Classifier.
 *
 * Inspects transcript steps between consecutive `view_file` / `read_file` calls for the same file path.
 * Does NOT classify a repeat read as waste if:
 *  1. A compaction step (`CORTEX_STEP_TYPE_CHECKPOINT = 23`) occurred between reads (in-memory buffer was wiped).
 *  2. An edit tool (`replace_file_content`, `write_to_file`, `edit_file`, `write_file`) was invoked on that file between reads.
 *  3. A build/test tool (`run_command`) executed between reads.
 *
 * Only classifies as waste if the file was read multiple times in an unmodified state
 * within the same continuous context epoch.
 */

/**
 * Wraps a noisy CLI command in a fail-open stdout dampener (`head -n 100` + log redirect)
 * to prevent accidental 20k+ token single-turn bloat.
 */

```

## Source: src/core/log_resolver.mjs
```javascript
/**
 * Normalizes raw JSONL step objects into lightweight StepEvents.
 */

```

## Source: src/core/offenders.mjs
```javascript
/** Records the current session and returns the top-N chronic re-read list for `state.chronicReads`. */

```

## Source: src/core/parser.mjs
```javascript
/**
 * Reads exact token telemetry (input_tokens + cache_read_tokens) and mid-run Prefix Bust
 * events from a session's conversations/<uuid>.db SQLite store (gen_metadata table) in strict read-only mode.
 */

```

## Source: src/core/prompt_rubric.mjs
```javascript
/** True when compaction is worth its ~70s stall: >=50k active, >=25k reclaimable, or past the safe horizon. */

/**
 * Returns true if a file path is an internal Antigravity telemetry/hydration log
 * or brain artifact path that must be excluded from active workspace AST lists.
 */

/**
 * Phase 4 (Layer 4): Synthesizes a parameterized, context-preserving /compact command
 * pulling in active file paths and extracted in-chat user corrections.
 */

/**
 * Phase 4 (Layer 4): Evaluates Cache-Aware Compaction Advisory.
 * - If Cache TTL > 0s and totalActiveTokens <= 179k: Defer compaction until work pause.
 * - If Cache TTL == 0s OR totalActiveTokens > 179k: Run parameterized compaction now.
 * - Hotfix: when `isCacheTrulyWarm === false` (0 cache reads / 0% hit / prefix bust), never DEFER_WARM.
 */

/**
 * Phase 4 (Layer 4): Synthesizes The Baton Pass (/handoff) workflow command and target path.
 */

```

## Source: src/core/quota.mjs
```javascript
/**
 * Rank #1 & Phase 2 (Layer 2): Dual-Pool Quota (5-Hour Sprint vs. 7-Day Weekly Marathon),
 * Live Model Pool Reset Timers, AI Credit Overage Guardrails, Prefix Bust Detection &
 * Cache-Read Telemetry Engine.
 */

/**
 * Detects whether a step or its immediately preceding step contained an explicit
 * prefix-invalidating event (<USER_SETTINGS_CHANGE>, <system_message>, model/effort
 * switch, or an edit to AGENTS.md / .agents/rules/ / mcp_config.json).
 */

/**
 * Computes session and rolling 5h/7d dual-pool quota & cache telemetry.
 */

```

## Source: src/core/settings.mjs
```javascript
/**
 * Phase 3 (Layer 3): Reads `~/.gemini/antigravity-cli/settings.json` (or a custom path)
 * to inspect patched CLI context window overrides (512k or 900k whitelisted tiers).
 */

```

## Source: src/core/sidecar_store.mjs
```javascript
/**
 * Creates a clean default sidecar state object.
 */

/**
 * Reads sidecar JSON synchronously with <2ms guaranteed SLA.
 * Falls back to default state on ENOENT or parse error.
 */

/**
 * Reads the freshest sidecar state immediately before write, merges only the targeted
 * section (e.g. 'sessionMeta', 'telemetry'), and writes back atomically.
 * Prevents race conditions and lost updates between concurrent writers.
 */

/**
 * Mutates sidecar state atomically and returns updated state.
 */

```

## Source: src/webview/registry.mjs
```javascript
/**
 * Modular Webview Chart & Small-Multiple Registry for Context Horizon (`ctxtop`).
 *
 * Allows contributors to register custom telemetry panels and small-multiple
 * visualizations against the standardized `HorizonStatePayload` returned by `/api/state`
 * without modifying core classification logic.
 */

```

