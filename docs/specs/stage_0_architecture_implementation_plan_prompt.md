# Stage 0: Architecture & Master Implementation Plan
**Recommended Model & Effort:** `/model gemini-4-argon` (or `gemini-3.1-pro`) | `/effort max` | **Mode:** `/plan`

Copy and submit the prompt below in Google Antigravity after saving `SPEC_AGY_HORIZON_FLIGHTCHECK.md` in your workspace root:

~~~text
/plan Read @SPEC_AGY_HORIZON_FLIGHTCHECK.md in full. Act as Principal Systems Architect for Google Antigravity extensions and write a comprehensive, production-ready `implementation_plan.md` to build, verify, and package the `agy-horizon-flightcheck` v3.1.0 plugin.

### Hard Engineering Constraints
1. Environment: Windows 11 workstation (PowerShell, Node.js 20+ ESM `.mjs`) running Google Antigravity CLI (`agy` v1.4.11+) and Antigravity IDE (v2.25+).
2. Zero External Runtime Dependencies: Use only built-in Node.js 20+ modules (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:os`, `node:sqlite` or JSONL fallback) so `PreInvocation` Tier 1 completes in under 15ms and `statusLine` completes in under 45ms.
3. Official Hook Schema Compliance: In `hooks.json`, use a top-level hook group key (`"horizon-flightcheck-lifecycle"`) containing `"enabled": true`, `"SessionStart": [...]`, `"PreInvocation": [...]`, and `"PostInvocation": [...]` as direct arrays of handler objects without a `matcher` wrapper.
4. StatusLine 30-Failure Immunity: Ensure `src/cli/horizon_hud.mjs` never exits non-zero or times out so Antigravity never triggers the 30-consecutive-failure disable lock.
5. Anti-Truncation Modularity: Keep every source file under 350 lines of code so no file write approaches the 60-second stream timeout.

### Required Structure of `implementation_plan.md`
Break the build into 6 deterministic phases corresponding to Stages 1 through 6:
- **Phase 1: Schemas, Config & Shared IPC Spine (`sidecar.json`)**
  - Exact JSON schemas for `plugin.json`, `hooks.json`, `config/default_flightcheck.json`, and `sidecar.json`.
  - Lock-free atomic write-to-temp-and-rename protocol in `src/core/sidecar_store.mjs`.
  - Windows 11 / URI / POSIX path normalization rules in `src/core/path_canonicalizer.mjs`.
- **Phase 2: 4-Tier Log Resolver & 40-Cell Horizon Classifier**
  - Incremental byte-offset cursor algorithm in `src/core/log_resolver.mjs` across all 4 log tiers.
  - Token bucketing and cell assignment in `src/core/horizon_classifier.mjs` for all 10 semantic states plus Signal Purity (%) and Sludge Tax ($/turn).
- **Phase 3: The 6 Blind-Spot Sensors (`src/core/blindspot_sensors.mjs`)**
  - Data structures and algorithms for `DIRTY_SNAP` (`mtimeMs` vs `view_file`), `SCHEMA_TAX` (Turn 0 MCP schemas + 30-day usage ledger + 25k payload bomb check), `UNSEEN_CALLERS` (`SITEMAP.md` and regex import cache), `LEGACY_POISON`, `QUOTA_AND_STREAM_SHIELD` (native `quota.remaining_fraction` + 600-line guard), and `LOOP_AND_GIT_GUARD` (`git status --porcelain` + 3-strike loop breaker).
- **Phase 4: Dual-Surface HUD (`statusLine` & Tufte IDE Webview)**
  - `src/cli/horizon_hud.mjs` harvesting the 26-field `statusLine` stdin payload (`quota`, `mode`, `agent_state`, `context_window`), updating `sidecar.json`, and rendering width-adaptive ANSI blocks when `process.stdout.columns` is under 120.
  - `src/webview/horizon_panel.html` following Edward Tufte's high data-ink ratio principles (zero chartjunk, sparklines, scannable tabular telemetry, `<agent-embed>` compatibility).
- **Phase 5: Lifecycle Hooks, 8-State `PreInvocation` Router & `/precheck` Skill**
  - Exact decision tree for `session_start.mjs`, `post_invocation.mjs`, and `pre_invocation.mjs` (Tier 1 under 15ms heuristic + Tier 2 `gemini-3.8-flash` low call with 1,500ms timeout fallback to `ALLOW_SILENT`).
  - Exact prompt injection strings for `INJECT_CONTEXT_GUARD` and `STEER_SUBAGENT`, plus the 4-Line Scorecard formatter.
  - `skills/precheck/SKILL.md` specification.
- **Phase 6: Deterministic TDD Suite, Latency Benchmarks & Packaging**
  - Synthetic fixtures in `tests/fixtures/`, `node --test` assertions in `tests/test_router_and_sensors.mjs`, latency benchmark in `tests/bench_latency.mjs`, and `agy plugin validate --strict` verification.

Do not write application code in this turn. Generate `implementation_plan.md` and `task.md` checklists and pause for review.
~~~