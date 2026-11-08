> **Archived (historical).** Superseded by the current code and `docs/CONTEXT_MEMORY_EVALUATION_GUIDE.md`. Some labels and behaviors described below have since changed.

# Tactical Refactor Plan: Attention Horizon (`ga-visualizer-v2`)
## Pre-Launch Architecture Upgrade for Hacker News ("Show HN")

> **Implementation Status:** **ALL 7 PHASES IMPLEMENTED & VERIFIED (`0 errors`)**
> - **Phase 1 (Layer 1 — Header Health & Composite Session Risk):** Verified via `tests/verify_phase_1.mjs`
> - **Phase 2 (Layer 2 — Quota Telemetry, Real Cache TTL & Overage Guardrails):** Verified via `tests/verify_phase_2.mjs`
> - **Phase 3 (Layer 3 — Dual-Watermark Model & Dynamic Context Ceilings):** Verified via `tests/verify_phase_3.mjs`
> - **Phase 4 (Layer 4 — Parameterized Compaction & The Baton Pass `/handoff`):** Verified via `tests/verify_phase_4.mjs`
> - **Phase 5 (Layer 5 — Filtered Waste Classification & MCP Prefix Auditing):** Verified via `tests/verify_phase_5.mjs`
> - **Phase 6 (Layer 6 — U-Shaped Attention Heatmap & Session Fracture Overlay):** Verified via `tests/verify_phase_6.mjs` & `tests/verify_phase_6_roadmap.mjs`
> - **Phase 7 (Zero-Trust Security & Open-Source Manifest):** Verified via `tests/verify_phase_7.mjs` & `tests/verify_e2e_context_memory.mjs`

This blueprint translates the forensic findings in `HN_RESEARCH_REPORT.md` into concrete code updates across `C:\Projects\ga-visualizer-v2`. Follow this phased plan strictly sequentially. Do not move to the next phase until all acceptance tests for the active phase pass.

---

## Phase 1: Header Health & Composite Session Risk (Layer 1)

### Objective
Decouple the header health status from raw conversation length and anchor it to composite operational session risk. Unify multi-surface session discovery.

### Target Files
* `src/components/Header.tsx` (or `Header.jsx`)
* `src/lib/sessionScanner.ts`
* `src/constants/statusThresholds.ts`

### Architectural Changes
1. **Composite Health Indicator (`● Context Memory`)**:
   * **GREEN**: Total tokens $< 179\text{k}$ AND Cache $\text{TTL} > 0\text{s}$ AND `task.md` is in sync ($0$ turns behind).
   * **AMBER**: Cache $\text{TTL} == 0\text{s}$ (cold cache window expired) OR context $> 50\text{k}$ with pending checklist item OR `task.md` is $\ge 1$ turn stale.
   * **RED**: Context $\ge 179\text{k}$ (safe horizon breached) OR $7\text{d}$ lockout risk active without AI Credit overages enabled.
2. **Multi-Store Discovery**:
   * Inspect all three local Antigravity stores:
     * Desktop 2.0 / Unified Daemon: `~/.gemini/antigravity/conversations/*.db`
     * Standalone IDE Fork: `~/.gemini/antigravity-ide/conversations/*.db`
     * CLI: `~/.gemini/antigravity-cli/conversations/*.db`
   * Prefix each session dropdown item with surface source tags: `[CLI]`, `[IDE]`, or `[App]`.
3. **Prefix-Lock Protection Warning**:
   * If a session holds $> 50\text{k}$ cached tokens with $\text{TTL} > 0\text{s}$, attach a warning tooltip to the Effort/Model selector:
     > *"Active warm cache ($>50\text{k}$ tokens). Changing reasoning effort or switching models rewrites the system prefix and triggers a 100% uncached KV cache rebuild."*
4. **Dual-Target Session Jump**:
   * Primary click on `Open ↗`: Opens chat transcript in active workspace.
   * `Alt + Click` (or secondary icon): Opens OS file explorer at `~/.gemini/<surface>/brain/<session-uuid>/`.

---

## Phase 2: Quota Telemetry, Real Cache TTL & Overage Guardrails (Layer 2)

### Objective
Eliminate generic usage percentages. Pull live gRPC-JSON status from local daemon ports and distinguish between natural TTL expiration and mid-run prefix busts.

### Target Files
* `src/services/quotaService.ts`
* `src/components/QuotaStrip.tsx`
* `src/lib/transcriptParser.ts`

### Architectural Changes
1. **Live Model Pool Status & Reset Timers**:
   * Query local `language_server` endpoint on `127.0.0.1` (`GetUserStatus` / `GetUsageLimits`).
   * Display pool-specific countdowns: e.g., `Gemini 4 Argon: Resets in 3h 12m` (5h sprint) and `7d Usage: 100% (Resets in 4d 18h)`.
   * Display remaining Google One AI Credit reserves: `✦ AI Credits: 23,500`.
2. **AI Credit Overage Guardrail & Vision Bug Alert**:
   * When $7\text{d}$ usage reaches $100\%$:
     * If `enable_ai_credit_overages == false`: Display high-visibility alert: *"7d Quota Exhausted. Enable AI Credit Overages in Settings > Models to prevent session lockout."*
     * If `enable_ai_credit_overages == true`: Display warning chip: *"Overages Active. Do NOT attach images or screenshots (known upstream HTTP 400 Bad Request bug on overage calls)."*
3. **Prefix Bust vs. Natural TTL Expiration**:
   * Read `gen_metadata` from session SQLite store.
   * If `cache_read_tokens == 0` AND elapsed time since previous turn $< 300\text{s}$:
     * Display label: `⚠️ Prefix Bust (system_message / config drift)` instead of `0% hit (0s TTL)`.
4. **TTL Expiration Pulse**:
   * At $T - 45\text{s}$ before the $300\text{s}$ TTL expires, trigger a subtle visual pulse prompting the developer to send their next prompt or trigger compaction before losing warm prefix state.

---

## Phase 3: Dual-Watermark Model & Dynamic Context Ceilings (Layer 3)

### Objective
Replace static 256k / 179k ceilings with dynamic model-aware ceilings and expose Antigravity's internal dual-watermark architecture.

### Target Files
* `src/components/HorizonBar.tsx`
* `src/lib/modelRegistry.ts`

### Architectural Changes
1. **Dynamic Context Ceilings**:
   * Inspect active model identity and settings overrides (`~/.gemini/antigravity-cli/settings.json`):
     * Claude Sonnet / Opus 4.6/5.5: Context ceiling = $200\text{k}$.
     * Unpatched Gemini 4 Argon: Display **`256k Clamped (1M Model Capped by Cortex 0x3E800)`**.
     * Patched CLI binaries: Whitelist detected tiers ($512\text{k}$ or $900\text{k}$).
2. **Dual-Watermark Visual Markers**:
   * **Tick Mark 1 ($50\text{k}$ tokens)**: Label `Cascade Sync Armed`. Tooltip: *"Crossing 50k arms the automatic checkpointer. Completing a task.md item or switching subagents will trigger synchronous auto-compaction."*
   * **Tick Mark 2 ($70\%$ of ceiling, $179\text{k}$ on 256k)**: Label `Attention Horizon (Safe Limit)`. Practical recall threshold.
   * **Tick Mark 3 ($256\text{k}$)**: Hard assembly limit (`cortex/utils.GetCheckpointConfig`).
3. **State-Conditional Bar Coloring**:
   * Render the $77.8\text{k}$ history segment in **Muted Slate/Teal (`Cached History — 95% Discounted`)** while $\text{TTL} > 0\text{s}$.
   * Transition segment to **Amber (`Reclaimable Cold Bloat`)** ONLY when $\text{TTL} == 0\text{s}$ OR total context $> 179\text{k}$.

---

## Phase 4: Parameterized Compaction & The Baton Pass (/handoff) (Layer 4)

### Objective
Prevent compaction-induced amnesia, AST clobbering, and cache invalidation. Replace bare `/compact` recommendations with guarded, context-preserving commands.

### Target Files
* `src/components/RemediationBanner.tsx`
* `src/lib/promptSynthesizer.ts`
* `src/lib/artifactChecker.ts`

### Architectural Changes
1. **Dynamic Parameterized `/compact` Generator**:
   * Do not recommend bare `/compact`.
   * Automatically synthesize a parameterized command pulling in active file paths and detected user corrections:
     ```text
     /compact Focus on preserving: 1) Exported symbol signatures and state scales for [Active Files], 2) Current checklist state in task.md, 3) Explicit user constraints: [Extracted In-Chat Corrections].
     ```
2. **Cache-Aware Compaction Advisory**:
   * If `Cache TTL > 0s`: Display advisory: *"Cache is currently warm (95% token cost discount). Defer compaction until work pause to avoid 70s execution stall and complete KV cache invalidation."*
   * If `Cache TTL == 0s` OR tokens $> 179\text{k}$: Display advisory: *"Cache expired. Run parameterized compaction now before firing next turn."*
3. **Primary Action: The Baton Pass (`/handoff`) Workflow**:
   * Surface `/handoff` as a first-class action next to `/compact`.
   * Provide a one-click button: **"Generate Handoff Markdown"**.
   * Command template instructs agent to summarize active AST contracts, test states, and pending `task.md` tasks into `docs/HANDOFF_<timestamp>.md` to allow opening a pristine chat with zero conversational debt and 100% constraint retention.
4. **Brain Artifact & Git Drift Synchronization Check**:
   * Verify all three brain artifacts: `task.md`, `implementation_plan.md`, and `walkthrough.md`.
   * Run local git check (`git status --porcelain`). If uncommitted modifications exist in workspace alongside stale `task.md`, raise a pre-compaction warning.

---

## Phase 5: Filtered Waste Classification & MCP Prefix Auditing (Layer 5)

### Objective
Eliminate false positives in repeat file reads, audit MCP prefix bloat, and provide fail-open hooks for CLI command dampening.

### Target Files
* `src/lib/transcriptParser.ts`
* `src/components/DiagnosticsView.tsx`
* `src/lib/mcpAuditor.ts`

### Architectural Changes
1. **Smart File Re-Read Classifier**:
   * Inspect `transcript_full.jsonl` between consecutive `view_file` calls for the same file path.
   * **Do NOT classify as waste if**:
     * A compaction step (`CORTEX_STEP_TYPE_CHECKPOINT = 23`) occurred between reads (in-memory buffer was wiped).
     * An edit tool (`replace_file_content`, `write_to_file`) was invoked on that file between reads.
     * A build/test tool (`run_command`) executed between reads.
   * Only classify as waste if the file was read multiple times in an unmodified state within the same continuous context epoch.
2. **MCP Prefix Bloat & Schema Audit**:
   * Parse `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`.
   * Calculate static token overhead of registered tool schemas.
   * Flag `eager`-loaded MCP servers that have had zero tool calls across the active session and suggest switching to `lazy` loading.
3. **Fail-Open CLI Command Dampening Hook**:
   * When `Biggest Single Turn` flags a high-token CLI execution (e.g., verbose test runners or `git log`), provide a one-click button to register a wrapper in `.agents/hooks.json` under `PreToolUse`:
     * Wraps command in `head -n 100` or pipes noisy stdout to a temporary log file, preventing accidental $20\text{k}+$ single-turn bloat.
4. **Attention-Aware Rule Promotion**:
   * When promoting `Unlogged User Corrections` into `.agents/CONTEXT.md` or `AGENTS.md`, insert directives strictly within the top 30% (Primacy zone) or bottom 30% (Recency zone) of the document.
   * Check total line length against Antigravity's 200-line `MEMORY.md` truncation threshold.

---

## Phase 6: U-Shaped Attention Heatmap & Session Fracture Overlay (Layer 6)

### Objective
Upgrade the 40-cell grid into a true attention heatmap that exposes the transformer "Lost in the Middle" trough and marks cache invalidation events.

### Target Files
* `src/components/ChronoTimeline.tsx`
* `src/lib/attentionModel.ts`

### Architectural Changes
1. **Mathematical Attention Trough Overlay**:
   * For the currently populated cells ($N$ cells out of 40):
     * Model attention weight using a parabolic U-shaped curve:
       $$A(i) = 1.0 - 4.0 \cdot \gamma \cdot \left(\frac{i}{N} - 0.5\right)^2$$
       *(where $i \in [0, N]$ and $\gamma \approx 0.6$)*
     * Visually shade the middle band ($30\%$ to $70\%$ of active context) as the **Low-Attention Trough**.
2. **Stranded Signal Warnings**:
   * If an active code buffer or unreferenced rule sits in Cells $7$ to $15$ (within the $30\% - 70\%$ middle zone), display an alert badge:
     > *"Stranded in Low-Attention Trough. Risk of recall decay during multi-file reasoning. Re-reference in active prompt or anchor to task.md."*
3. **Session Fracture Markers (`⚡`)**:
   * Render vertical fracture markers between cells on the timeline whenever:
     * A compaction occurred (`step_type == 23`).
     * A mid-run prefix bust occurred (`cache_read_tokens == 0` with $\Delta t < 300\text{s}$).
4. **Interactive Turn Inspection**:
   * Clicking any cell filters the diagnostic panel to show the exact turns and tool calls that comprise that $6.4\text{k}$-token block.

---

## Phase 7: Zero-Trust Security & Open-Source Manifest

### Objective
Ensure immediate trust from the Hacker News and Antigravity developer community by enforcing zero-trust local-first operational rules.

### Target Files
* `README.md`
* `SECURITY.md`
* `package.json`

### Architectural Changes
1. **Zero-Trust Network Profile**:
   * Ensure 100% of telemetry parsing is done in-memory via local SQLite and JSONL reads.
   * Zero outbound network connections. No telemetry pings, analytics endpoints, or external LLM API keys required.
2. **Read-Only Filesystem Locks**:
   * Open all Antigravity session databases (`conversations/*.db`) and log files (`transcript_full.jsonl`) using strict read-only flags (`SQLITE_OPEN_READONLY`).
   * Never acquire write locks on active Antigravity session files to eliminate any risk of database corruption.