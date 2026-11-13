# Changelog

All notable changes to the Highbeam (`attention-horizon-antigravity` / `ctxtop`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.4.0] - 2026-11-10

### Sprint 1 + 2: Cost-Visibility Wedge (local/private build)

#### Added
- **Prefix-Cache Retention Index** (`src/core/sprint_metrics.mjs`): per-stream, turns 2+ only, TTL-expired turns excluded, bust cause attribution (`model_switch` / `prefix_mutation` / `prefix_drift`), USD savings and leakage, plus a per-turn `series` feeding the timeline.
- **Thinking vs. Generation Drift + DET-30 scratchpad-loop detector**: reasoning÷output ratio, TTFT, consecutive or cumulative loop escalation. Estimated thinking tokens are excluded.
- **Subagent `/swarm` & Git Worktree Topology** (`src/core/swarm_topology.mjs`):
  - Rebuilds the roster from `swarm` / `invoke_subagent` / `manage_subagents` / `send_message`.
  - Worker states: working, parked (`waiting`, $0), stopped, killed. Explicit `swarm status` output overrides inferred state.
  - Read-only `git worktree list --porcelain` probe (1.2s timeout, 15s memo).
  - DET-20 overlaps between scope leases.
  - Exposed as `state.swarmTopology`.
- **Panel drawer** `#swarmTopologyDrawer`: a 1-line pill when solo. It auto-expands once when workers > 0, worktrees > 1 or a DET-20 overlap appears.
- **`/cost-radar`**: skill, `ctxtop cost-radar [--out] [--json]` CLI and loopback `GET /api/cost-radar` (strict CSP). It renders a self-contained, script-free dark HTML/SVG timeline (`src/core/timeline_svg.mjs`) with:
  - a retention step chart with bust markers;
  - a drift sparkline with a TTFT strip;
  - a swarm/worktree graph.

#### Fixed
- Retention now reports **unmeasured** (`no_cache_telemetry`) when a transcript never exposes cache reads or writes, instead of a false "0% / N busts".
- TTFT ignores 0 ms deltas caused by second-resolution timestamps.
- Removed pre-existing empty `catch {}` blocks in `quota.mjs` and `classifier.mjs` (DET-05 hygiene).

## [3.2.0] - 2026-11-08

### Multi-Harness v2.0 Wedge & Production Hardening Release

#### Added
1. **Multi-Harness Trajectory Stitcher (`src/core/trajectory_stitcher.mjs`)**:
   - **Google Antigravity (`[App]`, `[IDE]`, `[CLI]`)**: Native protobuf wire-walker (`decodeProtobufWire`) inspects `conversations/<uuid>.db` (`steps` table binary `step_payload` and `metadata` blobs) in strict read-only mode to extract `file:///` workspace URIs and correlate with `transcript_full.jsonl` and `annotations/<uuid>.pbtxt`.
   - **Claude Code**: Reconstructs complete `uuid -> parentUuid` DAG trees up to the active `leafUuid`, accurately isolating `/rewind` forks, `file-history-snapshot` restore points, and Turn-1 `cache_creation_input_tokens`.
   - **Cursor**: Correlates `composerData:<id>`, `bubbleId:<id>:<bubble>`, `messageRequestContext`, and `agentKv:blob:*` (`requestId`) with `store.db` and timestamp-less `agent-transcripts/*.jsonl`.
2. **Offline Prefix-Safe Tool-Output Surgeon (`src/core/pruner.mjs`, `src/cli/doctor.mjs --prune-tools`)**:
   - Truncates stale, superseded tool results (duplicate full-file re-reads, unreferenced exploratory grep outputs, resolved test stderr) directly in offline transcripts.
   - Preserves Turn 0 anchor prompts and the newest 6 turns of live context; creates atomic `.pre_surgeon` rollback backups before applying surgical edits.
3. **Cursor `state.vscdb` Streaming Storage Doctor (`src/core/storage_doctor.mjs`, `src/cli/doctor.mjs --gc-cursor`)**:
   - Zero-`VACUUM` streaming SQLite compaction of `state.vscdb` that purges orphaned `bubbleId:*`, `checkpointId:*`, `messageRequestContext:*`, and unreferenced `agentKv:blob:*` rows.
   - Eliminates 30GB–100GB of dead IDE state without requiring 2x-disk-space lockouts or contending with active Cursor write locks.
4. **Antigravity Brain Recovery (`src/core/storage_doctor.mjs`, `src/cli/doctor.mjs --recover-brain`)**:
   - Identifies and recovers orphaned agent artifacts, task checklists, and code diffs in `~/.gemini/antigravity/brain/<uuid>` orphaned by cross-workspace branching.
5. **Dual-TTL KV-Cache Monitoring & Prefix Mutation Diffs (`src/core/quota.mjs`, `src/core/classifier.mjs`)**:
   - Independent tracking of 1-hour primary prompt cache TTL vs. 5-minute fallback/overage and subagent cache tiers.
   - `computePrefixMutationDiff` pinpoints exact turn index, component name, and byte offset of cache prefix mutations.
   - Cold-Session Cost Gate flags when restarting an expired session incurs a full 12.5x–80x uncached token penalty.
6. **Subagent Worktree Collision Sensor (`src/core/subagents.mjs`)**:
   - Real-time DAG tracking with independent 5-minute subagent cache countdowns.
   - Fires `SUBAGENT_FILE_COLLISION` warnings when concurrent subagent branches edit overlapping canonical file paths.
7. **SQLite FTS5 Episodic Memory & Git Ledger (`src/core/episodic_memory.mjs`, `src/core/git_ledger.mjs`)**:
   - Indexes historical session decisions, modified files, and resolved error signatures in local SQLite FTS5 (`porter unicode61`) for `<1,000`-token context re-anchoring.
   - Correlates `.git/logs/HEAD` commit timestamps against session windows to attribute exact token consumption, cache hit rate, and USD cost per commit.
8. **Zero-PII Forensic Sanitizer (`src/core/sanitizer.mjs`)**:
   - Redacts Anthropic/OpenAI/Gemini API keys, GitHub PATs, AWS secrets, Bearer tokens, `.env` secrets, and OS user home paths prior to forensic JSON export.
9. **Zero-Config Test Discovery (`test/all.test.mjs`)**:
   - Standard root test file enabling single-command `node --test` execution across all 62 unit, wedge, concurrency, and schema drift tests.

#### Fixed & Enhanced
- **Top Risky Cells Hero Section**: Surfaced top 3–5 highest-risk context cells directly underneath the 40-cell flamegraph with exact file paths, attention recall %, and 1-click remediation actions.
- **MCP Schema ROI & Lazy Switching**: Added idle bloat tax calculation and one-click `[Switch to Lazy]` action for 0-call eager MCP servers.
- **Silent-When-Nominal Watchdog**: Host RAM and zombie process counters stay hidden during normal operation to maximize Edward Tufte data-ink ratio.
- **3-Way WebView Mirror Parity**: Verified SHA-256 byte-for-byte parity across `attention-horizon-antigravity`, `agy-horizon`, and `agy-horizon-flightcheck`.

#### Verification & Quality Gates
- **Unit Suite (`node --test`)**: 62 tests passing across 24 suites (0 failures).
- **Phases Suite (`npm run test:phases`)**: All 7 Show-HN phase verification suites passing (0 errors).
- **End-to-End Suite (`npm run test:e2e`)**: 7 validation layers verified (0 errors).
- **Zero Runtime Dependencies**: Confirmed 0 dependencies in `package.json`.
- **Zero-Trust Read-Only Safety**: Confirmed all SQLite connections open with `SQLITE_OPEN_READONLY_OPTIONS`.

---

## [3.1.0] - 2026-11-08

### Pre-Launch Bug-Fix & Verification Pass (Show-HN Release Readiness)

#### Fixed
1. **Safe Limit Unification & Idempotent Scaling (`constants.mjs` & `classifier.mjs`)**:
   - Fixed double-scaling bug in `scaleEffortProfileForCeiling()` where passing an already scaled profile resulted in a 229k recall ceiling instead of 179k.
   - Synchronized `activeEffortProfile.safeLimit` with `window.safeLimit` (179,000 on 256k Standard effort) and exposed exact integer `window.safeHeadroomTokens`.
2. **Low-Token False Positive Guard on Attention Trough (`classifier.mjs` & `horizon_panel.html`)**:
   - Added minimum token floor (`totalActiveTokens >= 44800` and `activeCellCount >= 7`) to `calculateParabolicAttentionCurve()`, `classifyHorizon()`, and webview mini-timeline.
   - Guaranteed sessions under 44.8k tokens report 0 cells in low-attention trough and 0 stranded signal warnings.
3. **Internal Telemetry Hydration Path Sanitization (`prompt_rubric.mjs`, `classifier.mjs`, `handoff_audit.mjs`, `layer5_hygiene.mjs`)**:
   - Added `isInternalTelemetryPath()` filter to exclude `.system_generated`, `steps/\d+/output.txt`, and `/.gemini/antigravity*/brain/` hydration logs from parameterized `/compact`, `/handoff`, `HANDOFF.md`, and duplicate re-read tracking.
4. **Cold Cache Prefix Bust Reset (`quota.mjs`, `classifier.mjs`, `horizon_panel.html`)**:
   - Separated historical `lastTurnPrefixBust` from live `prefixBustDetected`, requiring `!isCacheCold && cacheTtlRemainingSec > 0 && idleSeconds < 300`.
   - Cleared stale prefix bust warnings when sessions naturally expire/reach cold cache state, and gated `prefixLockWarning` on `!prefixBustDetected`.
5. **Epoch Checkpoint Slicing & Waste Bucket Rescaling (`classifier.mjs`)**:
   - Recomputed `categoryTotals` and `offenderMap` directly from scaled `classifiedSteps` when `stdinContextWindow` scales context tokens, ensuring mutually exclusive waste buckets sum strictly to `sludgeTokens` without negative residuals.
6. **Deduplicated Early Anchors at Risk (`classifier.mjs`)**:
   - Wrapped `amputation.anchorsAtRisk` in `Array.from(new Set(...))` to prevent duplicate labels in amputation warning payloads.
7. **Multi-Store Turn Count & 0-Step Ghost Session Filtering (`parser.mjs`)**:
   - Extracted real `turnCount` from `gen_metadata` in SQLite session databases, filtered out empty `stepCount: 0` ghost entries, and deduplicated multi-surface sessions by `sessionId` (preferring newest `lastModified`).
8. **Antigravity v2.6.0+ `agy --hub` Plain-HTTP Quota Probing (`quota.mjs` & `host_watchdog.mjs`)**:
   - Added `extractHubProcessInfo()` and `discoverLocalAntigravityHub()` to inspect running processes, extract port and `--csrf_token` / `--csrf-token`.
   - Updated `queryLocalLanguageServerStatus()` to probe plain HTTP `http://127.0.0.1:{port}` first with `x-codeium-csrf-token` header, falling back to HTTPS with `{ rejectUnauthorized: false }`.
   - Updated process table evaluator to recognize `agy --hub` alongside `language_server` for accurate RSS memory and zombie leak tracking.
9. **Cross-Surface `toggleConversation` Guard & `open-brain` Directory Fallback (`horizon_panel.html` & `server.mjs`)**:
   - Added cross-surface detection (`targetSurface !== hostSurface`) to `#btnOpenChat.onclick` to route clicks safely to `POST /api/open-brain` instead of throwing IDE conversation toggle exceptions.
   - Enhanced `POST /api/open-brain` to fall back to opening `~/.gemini/<surface>/conversations/` (or the surface directory root) when `brain/<uuid>/` does not exist on disk.
10. **UI Invariants & Inline Check Alignment (`horizon_panel.html`)**:
    - Enforced Invariant #1: `#compactInstruction` exclusively renders plain-text instructions (`Type /compact in the chat box and press Enter`), with `#compactReclaim` and `#parameterizedCompactBox`, with zero clickable copy buttons.
    - Synchronized inline UI risk calculations, `#quotaStrip` prefix bust states, and `#miniTimeline` attention trough shading with core engine rules.

#### Verification & Quality Gates
- **Unit Suite (`npm test`)**: 18 tests passing across 7 suites (0 failures, 331ms).
- **Phases Suite (`npm run test:phases`)**: All 7 Show-HN phase suites verified (0 errors).
- **End-to-End Suite (`node tests/verify_e2e_context_memory.mjs`)**: 7 validation layers passed (0 errors).
- **Benchmark Suite (`npm run bench`)**: Met all SLA budgets (`readSidecarSync` p95: 0.312ms, `PreInvocation Gate` p95: 0.150ms, `HUD Render` p95: 28.540ms).
- **3-Way WebView Mirror Parity**: Byte-for-byte identical across `attention-horizon-antigravity`, `agy-horizon`, and `agy-horizon-flightcheck` (`SHA-256: 56eaad262dc9124191d0a03334b1df51d414f81691498612beda71fec6ac6347`).
