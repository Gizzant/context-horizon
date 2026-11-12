# Attention Horizon Architecture Port Map: Antigravity (`attention-horizon-antigravity`) to Claude Code (`attention-horizon-claude`)

This document maps every module in `attention-horizon-antigravity` to its equivalent in `attention-horizon-claude`, detailing architectural shifts, runtime host differences, and explicit bug fixes.

---

## 1. Architectural Philosophy Shift

| Dimension | Antigravity (`attention-horizon-antigravity`) | Claude Code (`attention-horizon-claude`) |
| :--- | :--- | :--- |
| **Execution Model** | Out-of-process daemon (`server.mjs`) + Webview HTML panel (`horizon_panel.html`) | **Two-Tier Hybrid**: In-Process Mod (`register.js` via `$.ui`) + Tier 2 Lifecycle Command Hooks (`hooks/handlers/`) |
| **Latency Profile** | Local HTTP poll (`~2–15ms`) | **Tier 1 In-Process Mod:** `~0.05ms` (`50µs`, `< 0.1ms`) in V8 memory; **Tier 2 Command Hooks:** `~5ms` minimal POSIX shell exec + `~15–35ms` Node ESM CLI cold-start (POSIX) / `~40–90ms` (Windows 11 PowerShell process spawn + stdio JSON; benchmarked via `scripts/bench_hooks.mjs`) |
| **Path Resolution** | Antigravity plugin roots (`~/.gemini/config/plugins/` & `.agents/plugins/`) | Native Claude Code plugin root (`${CLAUDE_PLUGIN_ROOT}` in `hooks/hooks.json`, `~/.claude/settings.json`, and project `.claude/settings.json`) |
| **Telemetry Ingestion** | Polling SQLite databases (`conversations/*.db`) + JSONL parsing (`transcript.jsonl`) | In-Process Event Streams (`turn.step`, `turn.complete`) + `statusLine` JSON stdin |
| **Cache Mechanics** | Gemini context storage leases (implicit KV cache) | Anthropic Prompt Caching (5m `1.25x` write, 1h `2.0x` write, `0.025x..0.10x` read discount) |
| **Storage Engine** | Native `node:sqlite` (`conversation_summaries.db`, `horizon_ledger.db`) | Pure ESM `$.store` + atomic JSON / append-only `.jsonl` (zero binary npm dependencies, Node >= 20.0.0) |
| **UI Surface** | 420px browser webview iframe | Native terminal `AbovePrompt` band, docked `Pane` (`/horizon`), active `Spinner`, and CLI `statusLine` |

---

## 2. Module Mapping Table

| `attention-horizon-antigravity` Source | `attention-horizon-claude` Destination | Tier | Key Improvements & Bug Fixes Applied |
| :--- | :--- | :---: | :--- |
| `src/config/modelCatalog.json` | `src/config/anthropicModelCatalog.json` + `catalogLoader.mjs` | Tier 1/2 | Full late-2026 Anthropic catalog (Fable 5.2/5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 at `$0.10/$0.50` base and `$0.50/$2.50` above 100k total prompt tokens). |
| `sidecars/horizon-daemon/server.mjs` | Replaced by in-process Mod (`hooks/register.js`) & `bin/ah-statusline.mjs` | Tier 1 | Eliminates background daemon, port conflicts (ports 62935..62945), and HTTP latency. |
| `src/core/task_quota_router.mjs` | `src/coach/cacheGravityRouter.mjs` | Tier 1/2 | Exact algebraic break-even math ($C^* = 6,522$ on Opus 5.5 $\to$ Sonnet 5.5; $C^* = 4,615$ on Opus 4.6 $\to$ Sonnet 4.6). `COACH` mode is 100% advisory; `AUTO_PILOT` mode gates `PreModelSwitch`. |
| `src/core/cache_ttl_watchdog.mjs` | `src/coach/ttlWatchdog.mjs` | Tier 1 | 1-second `$.clock.every` countdown. Amber alert at $\le 45$s; zero-token `StateBaton` snapshot at $T-10$s and opt-in local CLI keep-alive at $T-15$s in `AUTO_PILOT` mode (zero raw HTTPS sockets). |
| `src/core/circuit_breakers.mjs` | `src/guards/circuitBreakers.mjs` + `hooks/handlers/pre-tool-use.mjs` | Tier 1/2 | Normalized `DET-01..20`. Option-argument skipping in `DET-01` (`-m` commit messages allowed). Diff-only scanning in `DET-05` (no false-positive error-masking alerts). |
| `src/core/agy_git_guard.mjs` | Embedded into `src/guards/circuitBreakers.mjs` (`DET-01`) | Tier 2 | Windows `Bash|PowerShell` parity. Does not block `git commit -m "-next..."`, `git log -n 5`, or `git clean -n`. |
| `src/core/subagent_ipi_sanitizer.mjs` | `src/guards/circuitBreakers.mjs` (`DET-19`) | Tier 1/2 | Strips Unicode tags `U+E0000`..`U+E007F`, zero-width characters, and HTML comments. Wraps data in `<untrusted_subagent_data>`. |
| `src/core/scope_lock_registry.mjs` | `src/telemetry/scopeLockRegistry.mjs` (`DET-20`) | Tier 1/2 | Multi-session atomic locks in `.claude/locks/active_scopes.json`. Properly includes dotfiles (`.github/*`, `.claude/*`, `.env.example`). |
| `src/core/handoff_hydrator.mjs` | `src/coach/stateBatonHydrator.mjs` | Tier 1/2 | Deterministic ~300-token Durable Fact Schema. Flushes to `docs/HANDOFF_<ts>.md` on `PreCompact` and injects via `additionalContext` on `SessionStart[compact]`. |
| `src/core/saved_quota_ledger.mjs` | `src/coach/savedQuotaLedger.mjs` | Tier 1/2 | Append-only `.jsonl` ledger. **Zero non-zero fallback**: initialized strictly at `0` (replaces hardcoded `142,400` default bug). |
| `src/webview/horizon_panel.html` | `src/ui/modViews.mjs` + `src/ui/horizonGrid.mjs` | Tier 1 | Terminal-native rendering. 40-cell non-linear bar with 3 zoom tiers (100k, 200k, 1M). Strict 5-Box Simple View hierarchy. Zero promotional text. |
| `scripts/sync_mirrors.mjs` | Deprecated (Not Needed) | N/A | Claude Code uses native plugin layout (`.claude-plugin/plugin.json` + root `hooks/hooks.json`). Eliminates 3-way mirror synchronization. |

---

## 3. Two-Tier IPC Bridge Contract

To guarantee that Tier 1 (in-process Mod) and Tier 2 (external command hooks) stay perfectly in sync without double-execution or Node startup races:
1. **Tier 1 (In-Process Mod - `hooks/register.js`):**
   - Receives high-frequency events: `turn.step`, `turn.complete`, `tool.call`, `clock.tick`.
   - Maintains real-time state in `$.store`.
   - Atomically flushes a lightweight telemetry snapshot to `.claude/cache/ah_live_state_<sessionId>.json` after each turn.
2. **Tier 2 (Command Hooks - `hooks/handlers/*.mjs`):**
   - Triggered by Claude Code lifecycle hooks (`PreToolUse`, `PostToolUse`, `PreModelSwitch`, `PreCompact`, `PostCompact`, `SessionStart`, `Stop`).
   - Reads `.claude/cache/ah_live_state_<sessionId>.json` for live cache metrics.
   - Executes shell checks (`Bash|PowerShell`), git verification, and lossless artifact offloading.
   - Enforces exit code `0` (pass/JSON decision) or `2` (stderr diagnostic hard-block).

---

## 4. The 10 Resolved Specification Traps

1. **Trap 1 (Workflow Preservation):** `PostToolUse` sanitizer offloads structured output $> 4,000$ tokens *only* for `Bash|PowerShell|WebFetch|mcp__.*` and multi-file `Grep` floods. Workspace `Read` is **never** offloaded, preserving exact code context for Claude Code's native `Edit` tool.
2. **Trap 2 (Zero Socket Invariant):** Removed synthetic external HTTP keep-alive pings. Replaced with amber terminal alert + zero-token `StateBaton` pre-snapshot at $T-10$s.
3. **Trap 3 (Carry-Over Bug Removal):** Removed `142,400` hardcoded ledger default; fixed option-argument parsing in `DET-01`; restricted `DET-05` to diff lines; added dotfile support to `DET-20`.
4. **Trap 4 (Mathematical Exactness):** Negative Cache ROI is calculated by exact USD comparison ($\text{Spend} > \text{UncachedEquivalent}$), not an arbitrary $< 1.39$ ratio.
5. **Trap 5 (No Double Execution):** Strict division of responsibilities between in-process Mod and external command hooks; shared state bridged via atomic JSON file.
6. **Trap 6 (Developer Ergonomics):** Allowlisted `.env.example`/`.env.sample` in `DET-02`; restricted `DET-03` to direct edits (permitting `npm install`); made `DET-14` advisory in `COACH` mode.
7. **Trap 7 (Context Scalability):** 40-cell grid dynamically switches zoom levels: 100k ($2.5$k/cell), 200k ($5$k/cell), and 1M ($25$k/cell).
8. **Trap 8 (Zero Dependencies):** Replaced SQLite with `$.store` and atomic JSON/JSONL for pure `Node >= 20` compatibility without binary shims.
9. **Trap 9 (Credible Positioning):** Neutral, technically rigorous documentation without unsourced percentage claims.
10. **Trap 10 (Cache Preservation):** Top-level model and effort settings are preserved across session turns; changes are safely queued in `PostCompactMutationQueue`.
