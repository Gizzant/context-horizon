# Multi-Phase Gemini 4 Argon Implementation Prompt: Upgrading Attention Horizon (`ga-visualizer-v2` / `agy-horizon`) into an Active Behavioral Coach & RSI Engine

This document contains two copy-ready prompt blocks for [Google Antigravity IDE](https://antigravity.google/docs/features/):

1. **Mid-Run Delta Continuation Prompt (Start at Phase 4 after `[GATE-3]`)**: Use this block right now since you have already completed Phases 0–3 and are paused at Phase 4. It instructs the agent to patch its existing `~/.gemini/antigravity/brain/<GUID>/implementation_plan.md` and `task.md` ([Antigravity Brain Visualizer](https://github.com/glaforge/antigravity-brain-visualizer)) with the upgraded **Phase 5 (`CacheGravityScorer` + `TaskMdDirectiveWatcher` + `ModelSelectorActuator`)** and **Phase 6** specs without re-running Phases 0–3 or busting your prefix cache ([KV Cache Unit Economics](https://startupfortune.com/how-context-window-length-actually-breaks-your-ai-agents-unit-economics/)).
2. **Full End-to-End Master Prompt (Phases 0–6)**: Complete reference specification below for new workspaces.

## 1. Mid-Run Delta Continuation Prompt (Copy & Paste at Your Phase 4 Pause Point)

### Pre-Send Checklist: Same Session vs. Fresh Session at Phase 4

| Your Current Attention Horizon State | Where to Paste This Prompt | Model & Effort to Select | Why (Cache & Quota Math) |
| :--- | :--- | :--- | :--- |
| **Warm Cache** (`TTL > 0s` and `Total Tokens < 140k`) | Paste as the **next user reply** at the bottom of your **current session** (never edit Turn 1) | Keep current model family, drop effort to **`Low`** (e.g., **Argon `Low`**, `3.0x`) | Appending at the tail preserves your 95% cached prefix discount across Phases 0–3 ([KV Cache Economics](https://startupfortune.com/how-context-window-length-actually-breaks-your-ai-agents-unit-economics/)), while dropping effort cuts output burn by 67% ([Google AI Forum Quota Analysis](https://discuss.ai.google.dev/t/1m-advertised-context-vs-a-256k-compaction-clamp-in-the-shipped-binaries-plus-quota-and-agy-p-policy-questions-desktop-2-29-0-cli-1-5-1/198430)). |
| **Expired Cache** (`TTL == 0s` / `Cache Hit: 0%`) or **Bloated** (`Total Tokens >= 140k`) | Run your Phase 2 **`/handoff`** (or open a **New Chat** in the same workspace) | Switch to **Gemini 3.8 Flash — `High` or `Medium`** (`1.0x` burn) | Once the 296s TTL expires, staying on Argon forces a 100% cold prefill of all Phase 0–3 turns at `3.0x–9.25x` cost ([256K Binary Clamp & Quota Analysis](https://github.com/magiccodelab/antigravity-256k-context-discrepancy)). Starting Phase 4 on Flash (`1.0x`) with a clean window saves $>80\%$ quota. |

### Copy-Paste Block for Resuming at Phase 4 (With Upgraded Phase 5 & Phase 6)

**Status Update & Spec Patch (`[GATE-3]` Approved $\rightarrow$ Proceed to Phase 4, Upgraded Phase 5, and Phase 6)**:

Phases 0, 1, 2, and 3 (`AgBridgeService`, `PrefixCacheShield`, `DET-01..16`, `fts5OutputCompressor`, `CompactionCoach`, `/handoff`, and the `instinctExtractor` / `/evolve` RSI Engine) are complete and verified. **Do NOT re-implement or overwrite Phases 0–3.**

Before writing Phase 4 code, perform **Step 0 (Brain Artifact Patch)**: update your active `~/.gemini/antigravity/brain/<GUID>/implementation_plan.md` and `~/.gemini/antigravity/brain/<GUID>/task.md` ([Antigravity Planning Mode](https://github.com/hamodywe/antigravity-mastery-handbook)) to incorporate the upgraded **Phase 5** and **Phase 6** specifications below, then immediately execute **Phase 4** and pause at `[GATE-4]`.

#### Phase 4: U-Shaped Attention, Recency Mirror & Rule Hygiene Optimizer

**Objective**: Prevent instruction drift caused by [U-shaped transformer attention curves](https://teapot123.github.io/files/CSE_5610_Fall25/Lecture_12_Long_Context.pdf) and Antigravity's [16.6k–30.7k native system prompt sandwich](https://www.reddit.com/r/google_antigravity/comments/1xk8jm1/i_did_the_math_on_google_antigravitys_token/).

1. **Positional Attention Curve Analyzer (`src/optimizers/uShapedAttentionOptimizer.ts`)**:
   * Scan `~/.gemini/GEMINI.md`, workspace `GEMINI.md`, `AGENTS.md`, `.agents/CONTEXT.md`, and optional `CLAUDE.md` / `MEMORY.md` files.
   * Partition each instruction file—and the composite system context (accounting for Antigravity's \~20k native system header + active MCP tool schemas in `~/.gemini/config/mcp_config.json`)—into three positional zones based on [context engineering principles](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering/blob/main/skills/context-fundamentals/SKILL.md):
     * **Primacy Band (First 30% of effective instruction window)**: High recall weight (`0.90–1.00`).
     * **Middle Attention Trough (30%–70% of window)**: Degraded recall weight (`0.55–0.70`, suffering 10–40% recall drop).
     * **Recency Band (Last 30% of window)**: High recall weight (`0.88–0.98`).
   * Flag any critical directive containing `NEVER`, `ALWAYS`, `MUST`, `CRITICAL`, or `NON-NEGOTIABLE` that sits inside the 30%–70% Middle Trough.
2. **1-Click U-Shape Reorder & Recency Anchor Mirror**:
   * Provide a 1-click **"🧲 Optimize Rule Placement (U-Curve)"** button (staged through Phase 0's `PrefixCacheShield` so it never busts a warm cache) that reorders `GEMINI.md` / `AGENTS.md` so foundational architecture rules sit in the top 30% Primacy Band, reference lookup tables sit in the 30%–70% middle, and hard `NEVER`/`MUST` guardrails sit in the bottom 30% Recency Band ([Attention Engineering Pattern](https://agents.kour.me/attention-engineering/)).
   * **Antigravity Recency Anchor Mirror**: Because Antigravity prepends a massive system header before `GEMINI.md`, automatically mirror the top 5 highest-priority `NEVER`/`MUST` invariants into a compact `## Active Guardrail Pin` block at the very bottom of `~/.gemini/antigravity/brain/<GUID>/task.md` so those rules remain inside the final 10% Recency Band of the entire conversation window on every turn.
3. **Rule & Memory Index Hygiene Auditor**:
   * Audit instruction files (`GEMINI.md`, `AGENTS.md`, and cross-IDE `MEMORY.md` if present, enforcing the [200-line / 25 KB `MEMORY.md` cap](https://code.claude.com/docs/en/memory) for dual-IDE repos and a 150-line budget for `GEMINI.md`) to detect duplicate directives, contradictory rules, and stale entries ($>180$ days since last git touch or `last_verified_at`), archiving stale rules to `~/.gemini/antigravity/agy-horizon/archived_rules.md`.

**Phase 4 Verification Gate (`[GATE-4]`)**: Run the analyzer against a synthetic 280-line `GEMINI.md` with `NEVER` rules buried at lines 110–160; verify that the optimizer scores the vulnerability, reorders the directives into the Primacy/Recency bands, archives $>180$-day stale lines, and mirrors the top 5 invariants to `task.md`. Pause or update `task.md` before starting Phase 5.

#### Upgraded Phase 5: Task Model & Multi-Tier Quota Router ("Floor is the Guarantee" + `CacheGravityScorer` + `TaskMdDirectiveWatcher`)

**Objective**: Upgrade Attention Horizon's passive `Gemini 3.8 Flash resets in 46m (model inferred)` line into an active **Pre-Invocation Model & Effort Router and CDP Actuator** that protects developers from 5-hour and 7-day quota lockouts (`7d ~100% est. Lockout Risk`) caused by running routine steps on high-multiplier reasoning models ([3.0x–9.25x Argon burn rate](https://discuss.ai.google.dev/t/1m-advertised-context-vs-a-256k-compaction-clamp-in-the-shipped-binaries-plus-quota-and-agy-p-policy-questions-desktop-2-29-0-cli-1-5-1/198430)).

1. **Zero-API-Call Pre-Invocation Task & Brain Classifier (`src/router/taskQuotaRouter.ts`)**:
   * Before prompt dispatch, score task complexity in $<5\text{ms}$ by combining four local signals:
     * **Agent Lifecycle Mode** ([Antigravity Mastery Handbook](https://github.com/hamodywe/antigravity-mastery-handbook)): `PLANNING` (drafting `implementation_plan.md`) vs. `EXECUTION` (stepping through `[/]` items in `task.md`) vs. `VERIFICATION` (running tests / generating `walkthrough.md`).
     * **Draft Prompt & AST Scope**: Action verb taxonomy (`fix typo`, `rename`, `format`, `add docstring`, `write fixture` vs. `architect`, `refactor across`, `debug race condition`, `state machine`), number of `@file` mentions, and cyclomatic complexity of open editor files.
     * **Active `task.md` Step Depth**: Complexity of the currently active `[/]` checklist item in `~/.gemini/antigravity/brain/<GUID>/task.md` ([Antigravity Brain Visualizer](https://github.com/glaforge/antigravity-brain-visualizer)).
     * **Live Retry / Oscillation Telemetry**: Recent `DET-01` (retry churn) or `DET-02` (edit oscillation) counts from Phase 1.
   * Output a deterministic tuple: `(complexityTier: 'LOW' | 'MEDIUM' | 'HIGH', confidence: 0.0..1.0, recommendedModel: string, recommendedEffort: 'low' | 'medium' | 'high', estimatedBurnMultiplier: number)`.
2. **"Floor is the Guarantee" Asymmetric Safety Rule & Loop Escalation**:
   * Recommend downgrading to a budget tier (**Gemini 3.8 Flash — `Low`/`Medium` effort**, `1.0x` burn) **only** when `complexityTier === 'LOW' && confidence >= 0.85`.
   * If `confidence < 0.85` or the task involves multi-file AST mutations, automatically promote the recommendation upward (**Gemini 3.8 Pro / Gemini 4 Argon / Claude Sonnet 4.6**) so complex refactoring is never under-resourced.
   * **Auto-Escalation on Loop Detection**: If the active session is on `Flash-Low` or `Argon-Low` and triggers `DET-01` ($\ge 2$ consecutive failing tool calls) or `DET-02` (file-hash flip-flopping), automatically escalate the recommendation by one tier (`Flash-Low` $\rightarrow$ `Argon-Medium`) for the recovery turn.
3. **`CacheGravityScorer` & Cache-Adjusted Quota Cost Equation (`src/router/cacheGravityScorer.ts`)**:
   * Because KV prompt caches receive a 95% discount (`0.05x` weight) but are isolated per model family ([KV Cache Unit Economics](https://startupfortune.com/how-context-window-length-actually-breaks-your-ai-agents-unit-economics/)), switching the main chat from **Gemini 4 Argon** to **Gemini 3.8 Flash** mid-session forces Flash to pay a 100% uncached cold-prefill penalty across the entire `Cached History`.
   * Evaluate every candidate `(model m, effort e)` pair using the **Cache-Adjusted Effective Quota Cost Equation**:

$$C_{\text{effective}}(m, e) = M(m, e) \times \Big[ I_{\text{same\_model}}(m) \cdot (0.05 \cdot T_{\text{cached}}) + (1 - I_{\text{same\_model}}(m)) \cdot T_{\text{cached}} + T_{\text{uncached\_delta}} + E_{\text{output}}(e) \Big]$$

   * Where $M(m, e)$ is the model-effort quota multiplier (`1.0x` for Flash Low/Med, `3.0x` for Argon Low, `6.0x` for Argon Med, `9.25x` for Argon High), $I_{\text{same\_model}}(m) \in \{0, 1\}$ indicates whether candidate model $m$ shares the currently warm KV prefix cache, $T_{\text{cached}}$ is `Cached History` tokens (when `TTL > 0s`), $T_{\text{uncached\_delta}}$ is uncached tail + new prompt tokens, and $E_{\text{output}}(e)$ is expected thinking + output tokens for effort tier $e$.
   * **Decision Policy When `Cached History >= 60,000` and `TTL > 0s`**:
     * **Rule A (Modulate Effort Within the Same Model First)**: For `MEDIUM` or single-turn `LOW` follow-ups on a warm **Gemini 4 Argon (`High`)** cache, keep the model on **Gemini 4 Argon** ($I_{\text{same\_model}} = 1$, preserving the 95% cached input discount) and drop effort from `High` (`9.25x`) to `Low` (`3.0x`)—cutting output/thinking burn by 67% with zero cold-prefill penalty.
     * **Rule B (Subagent / Local Offload for Routine Subtasks)**: For `LOW`-complexity tasks (`confidence >= 0.85`), offer a 1-click **"⚡ Offload to Flash-Low Subagent (`<2k` ctx)"** or **[Local LiteRT Gemma 4 26B / Ollama](https://www.reddit.com/r/LocalLLaMA/comments/1wof9kk/introducing_support_for_local_ai_models_in_the/) (`0.0x` cloud quota)** action via `AgBridgeService.spawnCleanSession()`, keeping noisy boilerplate out of the main Argon context window.
4. **`TaskMdDirectiveWatcher` — Brain-Driven Inline Routing Tags (`src/router/taskMdDirectiveWatcher.ts`)**:
   * Attach a fast `fs.watch` listener to `~/.gemini/antigravity/brain/<GUID>/task.md` ([Unofficial Antigravity CLI pattern](https://github.com/michaelw9999/antigravity-cli)).
   * During `PLANNING` mode, automatically annotate (or instruct the planner via `GEMINI.md` to tag) each checklist milestone in `task.md` with its optimal `[model:effort]` badge:
     * `- [x] [argon:high] Architect PrefixCacheShield transaction queue`
     * `- [/] [argon:medium] Implement DET-01..16 state machine in HookStateMachine.ts`
     * `- [ ] [flash:low] Generate 16 synthetic transcript.jsonl unit test fixtures`
     * `- [ ] [local:gemma4] Format docstrings and export barrel files`
   * Whenever the agent updates `task.md` and advances the in-progress `[/]` cursor to a new line, parse the inline `[model:effort]` tag in $<2\text{ms}$, run `CacheGravityScorer` to verify cache safety, and trigger `ModelSelectorActuator`.
5. **`ModelSelectorActuator` — Live CDP OOPIF & RPC Model/Effort Control (`src/router/modelSelectorActuator.ts`)**:
   * Use Phase 0's Chrome DevTools Protocol (CDP) OOPIF bridge ([Antigravity Link](https://open-vsx.org/extension/cafetechne/antigravity-link-extension), [Antigravity Auto Accept](https://open-vsx.org/extension/pesosz/antigravity-auto-accept)) and the local Go `language_server` RPC ([CodeBurn Antigravity Provider](https://github.com/getagentseal/codeburn/blob/main/docs/providers/antigravity.md)) to read the active model and effort dropdown state in the Antigravity chat panel—upgrading Attention Horizon's status text from `(model inferred)` to `(live synced)`.
   * Support a 3-way router mode toggle (`Off | Coach | Auto-Pilot`):
     * **`Coach` Mode (Default)**: Displays a 1-click pre-invocation recommendation pill (`💡 task.md step is [flash:low] → [Switch to Argon-Low (Save 67%)] or [Spawn Flash Subagent (1.0x)]`).
     * **`Auto-Pilot` Mode**: Programmatically actuates the Antigravity model/effort selector via CDP/RPC as `task.md` steps transition (switching effort within the same model when cache is warm, and switching model families only at `/handoff` or clean session boundaries).

**Phase 5 Verification Gate (`[GATE-5]`)**: Test `CacheGravityScorer` across 30 benchmark scenarios (varying `Cached History` from `0` to `180k` and `TTL` from `0s` to `296s`), verify that `TaskMdDirectiveWatcher` detects `- [/] [flash:low]` transitions in `<5ms`, and confirm `ModelSelectorActuator` switches effort tiers without triggering a mid-session cold prefill.

#### Upgraded Phase 6: Attention Horizon UI Integration, End-to-End Verification & Walkthrough

**Objective**: Integrate all five coaching and RSI subsystems into the **Attention Horizon** UI (`Simple` / `Advanced` view modes) while preserving its clean dark-glass aesthetic.

1. **UI Integration Blueprint**:
   * **Interactive Model & Effort Coach Bar (Upgrading `Gemini 3.8 Flash resets in 46m (model inferred)`)**:
     * **Left**: `Active: Gemini 4 Argon • High (9.25x burn • live synced) • Resets in 46m`
     * **Right**: 3-way mode switch (`Off | Coach | Auto-Pilot`) + dynamic action pill driven by `CacheGravityScorer` and `TaskMdDirectiveWatcher` (`💡 Next task.md step is [flash:low] → [Drop to Argon-Low (Keep 80.5k Cache)] | [Run in Flash Subagent]`).
   * **Active Signal Breakdown (`► Rules & work`)**: Expand the collapsible row to show the **U-Shaped Attention Health Score** (`Primacy: 94% | Middle Trough Risk: 0 critical rules | Recency Mirror: Active in task.md`) and **Staged `PrefixCacheShield` Queue**.
   * **Session Health Summary & Guardrail Strip**: Display real-time **Circuit Breaker Status** (`🛡️ DET-01..16 Active • FTS5 Log Compression: 41.2k tokens saved`) and pop a high-contrast red intervention card whenever a detector halts an anti-pattern (e.g., `🚨 DET-03 Blocked: Agent attempted to delete 3 expect() assertions in auth.spec.ts`).
   * **Recommended Actions Panel**: Dynamically populate 1-click coaching actions alongside `/compact`:
     * `🤝 Execute Baton Pass (/handoff) — Zero-Amnesia Session Reset`
     * `✂️ Trim Uncached Tail (Preserve 50k Prefix Cache)`
     * `🧬 Evolve 5 Clustered Instincts into Skill (/evolve)`
     * `🧲 Reorder GEMINI.md Rules for U-Shaped Attention`
2. **End-to-End Verification & Proof-of-Work**:
   * Run the complete unit and integration test suite (`npm test` / `vitest`) and verify zero TypeScript compiler errors (`tsc --noEmit`).
   * Generate `~/.gemini/antigravity/brain/<GUID>/walkthrough.md` with exact test execution exit codes, token-saving benchmarks, and UI verification proofs.

#### Recency Guardrail Pin (Must Obey Across Phases 4–6)

* **NEVER** re-implement or overwrite Phases 0–3 modules; import and wire existing `PrefixCacheShield`, `AgBridgeService`, `DET-01..16`, `CompactionCoach`, and `instinctExtractor` interfaces directly.
* **NEVER** mutate `GEMINI.md`, `AGENTS.md`, `.agents/CONTEXT.md`, or `SKILL.md` on disk while `Cached History >= 50,000` and `Cache TTL > 0s`; always route persistent rule writes through `PrefixCacheShield`.
* **NEVER** switch the main conversation's model family mid-session when `Cached History >= 60,000` and `TTL > 0s` without evaluating `CacheGravityScorer`'s cold-prefill penalty.
* **NEVER** delete, weaken, or skip existing `assert` / `expect` statements in any test file (`DET-03`).

## 2. Full End-to-End Master Prompt Reference (Phases 0–6)

### Role, Architectural Context & Non-Negotiable Invariants

You are a Principal Systems & IDE Extension Architect upgrading the **Attention Horizon** (`ga-visualizer-v2` / `agy-horizon`) extension for [Google Antigravity IDE](https://antigravity.google/docs/features/) from a passive telemetry/quota monitor into an active **Behavioral Coach, Deterministic Guardrail Supervisor, and Recursive Self-Improvement (RSI) Engine**.

Before writing any code, enforce the following **Non-Negotiable Architectural Invariants** (anchored at the top and bottom of your working context to prevent [Lost-in-the-Middle U-shaped attention decay](https://teapot123.github.io/files/CSE_5610_Fall25/Lecture_12_Long_Context.pdf)):

1. **Strict Google Antigravity Path & Runtime Fidelity (Zero Claude Code Leakage)**:
   * Bind strictly to Google Antigravity's real filesystem and runtime surfaces: `~/.gemini/GEMINI.md` (global rules, per [Antigravity Global Setup](https://zenn.dev/imkohenauser/articles/antigravity-minimal-setup?locale=en)), workspace `GEMINI.md` / `AGENTS.md`, `~/.gemini/antigravity/skills/<skill>/SKILL.md` and `~/.gemini/antigravity-cli/skills/` ([Antigravity Agent Skills Docs](https://antigravity.google/docs/skills/)), `~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity-cli/mcp/<serverName>/` ([Antigravity MCP Docs](https://antigravity.google/docs/mcp/)), `~/.gemini/antigravity/conversations/<GUID>.db` (or legacy `.pb`), and `~/.gemini/antigravity/brain/<GUID>/` (`task.md`, `implementation_plan.md`, `walkthrough.md`, and `.system_generated/logs/transcript.jsonl`, as documented in [Antigravity Brain Visualizer](https://github.com/glaforge/antigravity-brain-visualizer) and [CodeBurn Antigravity Provider](https://github.com/getagentseal/codeburn/blob/main/docs/providers/antigravity.md)).
   * Do **not** rely on Claude Code-specific hook settings (`PreToolUse`/`Stop` in `~/.claude/settings.json`, as used in [affaan-m/ECC `continuous-learning-v2`](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md)) or Claude Code's 200-line `~/.claude/projects/.../memory/MEMORY.md` cap ([Claude Code Memory Docs](https://code.claude.com/docs/en/memory)). Maintain optional read/export compatibility with `.agents/CONTEXT.md` and `CLAUDE.md` only as secondary cross-IDE bridges.
2. **Zero Self-Inflicted KV Prefix-Cache Busting (`PrefixCacheShield`)**:
   * Transformer KV prompt caching cuts repeated input token costs by 90–95% only while the system prompt and early conversation prefix remain byte-identical within the 296-second (5-minute) TTL ([KV Cache Unit Economics](https://startupfortune.com/how-context-window-length-actually-breaks-your-ai-agents-unit-economics/)).
   * Never mutate `~/.gemini/GEMINI.md`, workspace `GEMINI.md`, `.agents/CONTEXT.md`, or loaded `SKILL.md` files on disk while an active session has a warm prefix cache (`Cached History >= 50,000 tokens` and `Cache TTL > 0s`). Stage all persistent rule/skill mutations in a **Pending Commit Queue** and flush only when `Cache TTL == 0s`, at session initialization, or during an explicit `/handoff` baton pass.
3. **Zero-Token Deterministic Supervision**:
   * All real-time circuit breakers (`DET-01` to `DET-16`), U-shaped attention scorers, and pre-invocation task complexity classifiers must execute locally in TypeScript/Node.js using deterministic state machines, AST/regex parsers, and SQLite FTS5—consuming **zero LLM API tokens**.
4. **Anti-Reward-Hacking & Immutable Evaluation Boundaries**:
   * Neither the RSI Engine nor any automated refactoring workflow may modify test files (`*.test.ts`, `*.spec.ts`, `*_test.py`), linter configs, or evaluation scripts to force a passing score. Deleting or commenting out `assert` / `expect` statements must trigger an immediate `DET-03` circuit-breaker halt.

### Multi-Phase Execution Architecture Overview

| Phase | Module Name | Primary Antigravity Data & Runtime Hooks | Verification Gate Deliverable |
| :--- | :--- | :--- | :--- |
| **Phase 0** | **Core RPC Bridge & Prefix-Cache Shield** | Local Go `language_server` HTTPS RPC (`GetCascadeTrajectoryGeneratorMetadata`, per [CodeBurn](https://github.com/getagentseal/codeburn/blob/main/docs/providers/antigravity.md)), CDP OOPIF bridge ([Antigravity Link](https://open-vsx.org/extension/cafetechne/antigravity-link-extension)), `PrefixCacheShield` staging queue | `[GATE-0]` Replace `Ctrl+V` fallback with live RPC/CDP dispatch; pass prefix-lock unit tests |
| **Phase 1** | **Deterministic Anti-Pattern Circuit Breakers (`DET-01..16`) & FTS5 Compressor** | `~/.gemini/antigravity/brain/<GUID>/.system_generated/logs/transcript.jsonl` ([agy_watch](https://github.com/vladkol/agy_watch)), SHA-256 file watchers, SQLite FTS5 CLI compressor ([context-mode pattern](https://github.com/mksglu/context-mode)) | `[GATE-1]` Pass all 16 detector state-machine tests + SQLite FTS5 `pytest`/`tsc` log compression benchmarks |
| **Phase 2** | **Cache-Aware Compaction, Tail Surgeon & Baton-Pass (`/handoff`) Coach** | `50k Sync` watermark, `179k Safe Limit`, `256k` (`0x3e800`) binary clamp ([Disassembly Report](https://github.com/magiccodelab/antigravity-256k-context-discrepancy)), `brain/<GUID>/implementation_plan.md` & `task.md` | `[GATE-2]` Generate `docs/HANDOFF_<timestamp>.md` and auto-seed `<NEW_GUID>` brain artifacts with zero amnesia |
| **Phase 3** | **Bounded Atomic Instinct & Correction Learning Loop (RSI Engine)** | User correction parser (`transcript.jsonl`), confidence-scored instincts (`0.30–0.95`, adapted from [affaan-m/ECC](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md)), `/evolve` skill generator, git rollback tripwire | `[GATE-3]` Demonstrate instinct extraction, 48h tail-hint TTL, `/evolve` skill synthesis, and rollback on test regression |
| **Phase 4** | **U-Shaped Attention, Recency Mirror & Rule Hygiene Optimizer** | `~/.gemini/GEMINI.md`, `AGENTS.md`, `~/.gemini/config/mcp_config.json` ([16.6k–30.7k prompt tax](https://www.reddit.com/r/google_antigravity/comments/1xk8jm1/i_did_the_math_on_google_antigravitys_token/)), `brain/<GUID>/task.md` footer mirror | `[GATE-4]` Compute Primacy/Middle/Recency scores, 1-click reorder, and mirror top 5 `NEVER`/`MUST` rules to `task.md` |
| **Phase 5** | **Task Model & Multi-Tier Quota Router (`CacheGravityScorer` + `TaskMdDirectiveWatcher`)** | Pre-invocation prompt/AST classifier, [Argon 3.0x–9.25x quota multipliers](https://discuss.ai.google.dev/t/1m-advertised-context-vs-a-256k-compaction-clamp-in-the-shipped-binaries-plus-quota-and-agy-p-policy-questions-desktop-2-29-0-cli-1-5-1/198430), `task.md` inline tags, CDP `ModelSelectorActuator`, LiteRT/Ollama subagent offload ([Local SDK](https://www.reddit.com/r/LocalLLaMA/comments/1wof9kk/introducing_support_for_local_ai_models_in_the/)) | `[GATE-5]` Validate `CacheGravityScorer` equation, `task.md` reactive tier switching, and CDP model-picker actuation |
| **Phase 6** | **Attention Horizon UI Integration & End-to-End Verification** | `Attention Horizon` Webview (`Simple / Advanced` modes + `Off / Coach / Auto-Pilot` router toggle), SQLite WAL passive checkpointer ([WALmaster](https://www.reddit.com/r/AntigravityGoogle/comments/1xdwoa2/we_reverseengineered_google_antigravitys_go/)), `walkthrough.md` | `[GATE-6]` Full UI integration, zero-regression test suite, and verified `walkthrough.md` |

### Phases 0–3 Reference Specifications (Already Completed in Your Session)

* **Phase 0 (`AgBridgeService` & `PrefixCacheShield`)**: Local Go `language_server` HTTPS RPC + CDP OOPIF command dispatch, 5-second passive SQLite WAL checkpointing, and `pending_rule_deltas.json` staging queue when `cachedTokens >= 50000 && cacheTtlSeconds > 0`.
* **Phase 1 (`DET-01..16` & `fts5OutputCompressor`)**: Zero-token `transcript.jsonl` + SHA-256 stream supervision across 16 anti-patterns (including `DET-03` test-assertion weakening and `DET-04` fake screenshot scripts) plus fail-open SQLite FTS5 CLI output compression.
* **Phase 2 (`CompactionCoach` & `/handoff`)**: Watermark tracking (`50k` / `179k` / `256k`), uncached tail truncation, and 1-click `docs/HANDOFF_<timestamp>.md` generation + `<NEW_GUID>` brain seeding.
* **Phase 3 (`instinctExtractor` & `/evolve` RSI Engine)**: Confidence-weighted Atomic Instincts (`0.30–0.95`), 48-hour tail-hint TTL, `/evolve` `SKILL.md` synthesis when $\ge 5$ instincts cluster, immutable evaluation file boundaries, and automated git rollback tripwires.
* **Phases 4–6**: See the complete specifications in **Section 1** above.