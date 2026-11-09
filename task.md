# Task Checklist: Attention Horizon Behavioral Coach & RSI Engine Upgrade

## Planning & Architectural Alignment
- [x] Inspect repository structure, `package.json`, `AGENTS.md`, `SECURITY.md`, and `tests/verify_phase_7.mjs`
- [x] Map existing modules (`quota.mjs`, `layer5_hygiene.mjs`, `handoff_audit.mjs`, `tool_surgeon.mjs`, `episodic_memory.mjs`, `blindspot_sensors.mjs`, `server.mjs`)
- [x] Author `implementation_plan.md` reconciling Phases 0–6 with Zero-Trust (`SQLITE_OPEN_READONLY`), ES Module (`.mjs`), and 3-Way WebView Mirror invariants
- [x] Obtain user approval on `implementation_plan.md` before Phase 0 code execution

## Phase 0: Core Dispatch Bridge, WAL Hygiene & `PrefixCacheShield` (`[GATE-0]`)
- [x] Create `src/core/prefix_cache_shield.mjs` (`PrefixCacheShield` transaction queue at `~/.gemini/antigravity/agy-horizon/pending_rule_deltas.json`, locking writes to `GEMINI.md`, `AGENTS.md`, `.agents/CONTEXT.md`, and `SKILL.md` when `cachedTokens >= 50000 && cacheTtlSeconds > 0`)
- [x] Create `src/core/wal_hygiene.mjs` (Read-only `.db-wal` bloat monitor for host `conversations/*.db` preserving `SQLITE_OPEN_READONLY`, plus non-blocking 5s idle `PRAGMA wal_checkpoint(PASSIVE)` manager for Horizon-owned SQLite DBs)
- [x] Create `src/core/ag_bridge.mjs` (`AgBridgeService` exposing `sendChatCommand`, `pauseActiveGeneration`, and `spawnCleanSession` via pluggable local sidecar/RPC/CDP adapters with clipboard fallback)
- [x] Create `tests/verify_gate_0.mjs` and pass `[GATE-0]` unit tests (`cachedTokens = 80500`, `cacheTtlSeconds = 296` prefix-lock verification + `flushOnHandoff()`)
- [x] **HALT at `[GATE-0]` for user review**

## Phase 1: Deterministic Anti-Pattern Circuit Breakers (`DET-01..16`) & FTS5 Compressor (`[GATE-1]`)
- [x] Create `src/core/detectors_det01_to_16.mjs` implementing `HookStateMachine` (`PreInvocation`, `PreToolUse`, `PostToolUse`, `Stop`) and all 16 deterministic detectors (`DET-01` through `DET-16`)
- [x] Create `src/core/fts5_output_compressor.mjs` (`agy-horizon-exec` fail-open CLI wrapper, `tool_logs_fts5.db` virtual table, 25-line structured summary for $>80$-line `pytest`/`jest`/`vitest`/`cargo test`/`tsc` dumps, and `agy-log-search` query helper)
- [x] Wire `agy-horizon-exec` and `agy-log-search` subcommands into `src/cli/init.mjs`
- [x] Create `tests/verify_gate_1.mjs` and pass `[GATE-1]` (all 16 detector state-machine tests, $<10\text{ms}$ latency, and $>85\%$ token reduction on a 500-line `pytest` failure dump)
- [x] **HALT at `[GATE-1]` for user review**

## Phase 2: Cache-Aware Compaction, Tail Surgeon & Baton-Pass (`/handoff`) Coach (`[GATE-2]`)
- [x] Create `src/core/compaction_coach.mjs` (`CompactionCoach` tracking `50k`, `179k`, `256k` watermarks, Warm Cache Lock, Dual Token + Waste Trigger, Surgical Uncached Tail Truncation after warm cache watermark, and 5-section `docs/HANDOFF_<timestamp>.md` + `<NEW_GUID>` brain seeder)
- [x] Integrate `PrefixCacheShield.flushOnHandoff()` and FTS5 test state into `generateHandoffMarkdown` / `compaction_coach.mjs`
- [x] Create `tests/verify_gate_2.mjs` and pass `[GATE-2]` (simulated 165k-token session `/handoff`, `PrefixCacheShield` flush, and `<NEW_GUID>` brain artifact seeding with zero lost constraints)
- [x] **HALT at `[GATE-2]` for user review**

## Phase 3: Bounded Atomic Instinct & Correction Learning Loop — RSI Engine (`[GATE-3]`)
- [x] Create `src/core/rsi_instinct_engine.mjs` (`instincts.db` SQLite store, correction & detector outcome extractor, deterministic $+0.12/-0.20$ confidence scorer `0.30..0.95`, 48h `<coach_instincts>` `task.md` tail-hint injector, `PrefixCacheShield` staging at `confidence >= 0.75 && helpful_count >= 3`)
- [x] Implement Domain Clustering ($\ge 5$ instincts $\rightarrow$ `/evolve` skill generator at `~/.gemini/antigravity/skills/<domain-skill>/SKILL.md`), Immutable File Boundary guard, and Git Rollback Tripwire
- [x] Create `tests/verify_gate_3.mjs` and pass `[GATE-3]` (5 corrections in `testing` domain, confidence `0.30 -> 0.80+`, `/evolve` skill synthesis, and automatic git rollback on simulated downstream test regression)
- [x] **HALT at `[GATE-3]` for user review**

## Phase 4: U-Shaped Attention, Recency Mirror & Rule Hygiene Optimizer (`[GATE-4]`)
- [x] Create `src/core/u_shaped_optimizer.mjs` (Positional Attention Curve Analyzer for Primacy 0–30%, Middle Trough 30–70%, Recency 70–100% across `~/.gemini/GEMINI.md`, workspace `GEMINI.md`, `AGENTS.md`, `.agents/CONTEXT.md`, and `MEMORY.md`)
- [x] Implement 1-Click U-Shape Reorder (staged via `PrefixCacheShield`), Antigravity Recency Anchor Mirror (`## Active Guardrail Pin` top 5 `NEVER`/`MUST` invariants at bottom of `brain/<GUID>/task.md`), and $>180$-day stale rule archiver (`~/.gemini/antigravity/agy-horizon/archived_rules.md`)
- [x] Create `tests/verify_gate_4.mjs` and pass `[GATE-4]` (280-line synthetic `GEMINI.md` with `NEVER` directives buried at lines 110–160, U-curve reorder, stale rule archival, and `task.md` Recency Mirror verification)
- [x] **HALT at `[GATE-4]` for user review**

## Phase 5: Task Model & Multi-Tier Quota Router ("Floor is the Guarantee" + `CacheGravityScorer` + `TaskMdDirectiveWatcher` + `ModelSelectorActuator`) (`[GATE-5]`)
- [x] Create `src/core/task_quota_router.mjs`:
  - Zero-API-Call Pre-Invocation Task & Brain Classifier ($<5\text{ms}$) combining Agent Lifecycle Mode (`PLANNING` | `EXECUTION` | `VERIFICATION`), Draft Prompt & AST Scope, Active `task.md` Step Depth, and Live Retry/Oscillation Telemetry (`DET-01`/`DET-02`)
  - `"Floor is the Guarantee"` asymmetric safety rule (`LOW && confidence >= 0.85` for Flash `1.0x`) + Auto-Escalation on Loop Detection (`DET-01`/`DET-02` escalates `Flash-Low -> Argon-Medium`)
  - `CacheGravityScorer` & Cache-Adjusted Effective Quota Cost Equation ($C_{\text{effective}}(m, e)$) enforcing Rule A (Modulate Effort Within Same Model First on warm $\ge 60\text{k}$ cache) and Rule B (Subagent / Local LiteRT Gemma 4 / Ollama Offload)
  - `TaskMdDirectiveWatcher` (`fs.watch` + $<2\text{ms}$ parser for inline `[model:effort]` tags in `brain/<GUID>/task.md`)
  - `ModelSelectorActuator` (Live CDP OOPIF & Go `language_server` RPC model/effort control with `Off | Coach | Auto-Pilot` 3-way mode toggle and `live synced` telemetry)
- [x] Integrate `task_quota_router.mjs` into `src/hooks/pre_invocation.mjs` and telemetry state payload
- [x] Create `tests/verify_gate_5.mjs` and pass `[GATE-5]` (30 benchmark scenarios varying Cached History `0..180k` and TTL `0s..296s`, $<5\text{ms}$ `TaskMdDirectiveWatcher` `- [/] [flash:low]` transition detection, and `ModelSelectorActuator` effort switching without mid-session cold prefill)
- [x] **HALT at `[GATE-5]` for user review**

## Phase 6: Attention Horizon UI Integration, End-to-End Verification & Walkthrough (`[GATE-6]`)
- [x] Wire Phase 0–5 endpoints and telemetry payloads into `sidecars/horizon-daemon/server.mjs` and `src/cli/horizon_hud.mjs`
- [x] Integrate UI components into `src/webview/horizon_panel.html`:
  - Interactive Model & Effort Coach Bar (`Active: Gemini 4 Argon • High (9.25x burn • live synced) • Resets in 46m` + `Off | Coach | Auto-Pilot` 3-way switch + dynamic action pill)
  - U-Shaped Attention Health & Staged `PrefixCacheShield` Queue in `► Rules & work`
  - Circuit Breaker `DET-01..16` & FTS5 savings strip + high-contrast red intervention card
  - Recommended Actions coaching buttons (`🤝 Execute Baton Pass (/handoff)`, `✂️ Trim Uncached Tail`, `🧬 Evolve 5 Clustered Instincts (/evolve)`, `🧲 Reorder GEMINI.md Rules for U-Shaped Attention`) while preserving `#compactInstruction` plain-text invariant and Single Action Button Simplicity
- [x] Run `node scripts/sync_mirrors.mjs` and `node scripts/build_demo_page.mjs` to maintain 3-way SHA-256 mirror parity
- [x] Run full verification suite (`npm test`, `npm run test:phases`, `npm run test:e2e`, and `verify_gate_0`..`verify_gate_6`) and generate `walkthrough.md`
- [x] **ALL PHASES 0 THROUGH 6 FULLY COMPLETE AND VERIFIED**

## Active Guardrail Pin
- **NEVER** re-implement or overwrite Phases 0–3 modules; import and wire existing `PrefixCacheShield`, `AgBridgeService`, `DET-01..16`, `CompactionCoach`, and `RsiInstinctEngine` interfaces directly.
- **NEVER** mutate `GEMINI.md`, `AGENTS.md`, `.agents/CONTEXT.md`, or `SKILL.md` on disk while `Cached History >= 50,000` and `Cache TTL > 0s`; always route persistent rule writes through `PrefixCacheShield`.
- **NEVER** switch the main conversation's model family mid-session when `Cached History >= 60,000` and `TTL > 0s` without evaluating `CacheGravityScorer`'s cold-prefill penalty.
- **NEVER** delete, weaken, or skip existing `assert` / `expect` statements in any test file (`DET-03`).
- **ALWAYS** halt for user review after completing each Phase Verification Gate (`[GATE-0]` through `[GATE-5]`).
