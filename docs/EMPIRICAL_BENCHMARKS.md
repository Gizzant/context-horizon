# Highbeam (`highbeam-cli`) — Empirical Benchmarks, Wire Findings & Runtime Mechanics

This document consolidates the granular wire-level measurements, model-catalog mechanics, and explicit verification boundaries behind **Highbeam (highbeam-cli v4.1)**.

---

## 1. Measured Prompt-Cache & Hook Behavior (`Claude Code 2.1.325`)

Every empirical claim below cites its source dataset under [`experiments/model-switch-benchmark/`](../experiments/model-switch-benchmark/README.md); unmeasured behaviors are explicitly marked **unverified**.

- **Mid-Session Model Downgrade Penalty (`Track 1`, `45 runs / 540 turns`, `$22.72` settled OpenRouter -> 1st-party Anthropic):**
  - Switching `Opus 4.6 -> Sonnet 4.6` at Turn 6 on a `~58k` context produced a `0.0%` Turn-6 cache hit (`+$0.1783` spike) and increased total 12-turn cost from `$0.7789` (Opus control) to `$0.8611` (`+$0.0822` net loss).
  - Full transcript/wire parity: `540 / 540` user turns matched byte-for-byte on cache tokens ([`article_findings_report.md`](../experiments/model-switch-benchmark/results/article_findings_report.md)).
- **`CLAUDE.md` Edits Before `--resume` (`T6 CC-M`, `t6_layers.csv`):** Editing `CLAUDE.md` before `--resume` does not invalidate the cached prefix; both old and new versions remain in context.
- **`--append-system-prompt` on `--resume` (`T6 CC-S`, `t6_layers.csv`):** Ignored on `--resume`.
- **MCP / Tool-List Swap on `--resume` (`T6 CC-T`, `t6_layers.csv`):** Changing MCP servers or the tool list on resume wipes the prompt cache.
- **`PreCompact` Templates & Auto-Memory (`Phase 0` + [`summary_smart_compact.md`](../experiments/model-switch-benchmark/results/smart_compact/summary_smart_compact.md)):**
  - `PreCompact` instructions must be plain text on `stdout`; JSON is dropped (`Phase 0`, `$0` binary & mock-SSE audit).
  - Highbeam emits **zero** custom `PreCompact` or `SessionStart` preservation templates because stock `/compact` recorded `0 / 6` constraint violations up to `28.10x` compression (`~139k` tokens) without them.
  - Auto-memory added roughly `23.5%` to session cost in the smart-compact fixture (`n = 2 vs 2`); this is recorded as a cost observation, not a recommendation to disable auto-memory.
- **Cache Pre-Warming & `1h` TTL Break-Even (`Phase 0`, `T3a`, `T3b`):**
  - On OpenRouter, `max_tokens: 0` still generates output; 0-output cache pre-warming works on the direct Anthropic API only (`T3b`).
  - A `1h` prompt cache costs `2x` on writes and beats `5m` TTL once a `5–60` minute idle pause occurs (`T3a`).

---

## 2. Model-Aware Switch (`DET-08`), Effort (`DET-09`), & Resume Guards

- **`DET-08` Catalog-Derived Horizon Break-Even (`PreModelSwitch`):**
  - All break-even thresholds (`C*`, `C_max`), cold-write penalties, and warm-request paybacks (`~a / b`, where `a = P_write,B - P_read,A` and `b = P_read,A - P_read,B`, less output credit and `R - 1` switch-turn reads) are computed at runtime from `src/config/anthropicModelCatalog.json` with zero hardcoded prices.
  - Uses Stop-hook shrunk rolling-median `requestsPerTurn` (`R`, overridden from cold-start prior once `>= 3` deduplicated sessions exist in `~/.claude/projects/**/*.jsonl`), rolling median prompt growth `g` (capped at `g = 0` until `n >= 5` observed turns in a stable regime), and rolling output shrinkage.
  - Unknown model IDs return explicit `unknownModel: true` with `null` USD fields, no price-based hold, a 1-line advisory, and a `highbeam doctor` `WARN`. Under headless `claude -p` / SDK, `"ask"` becomes `blocked_by_hook` (override with `"DET-08": "warn"` or `expectedRemainingTurns`).
- **`DET-09` Effort & Rule-File Cache Capabilities (`MODEL_EFFORT_CACHE_CAPABILITIES`):**
  - Defers effort mutations on `4.6` models (`Arm D` `output_config.effort` mutation collapsed Turn-6 hit rate to `0.0%`, `+$0.0853`).
  - Stays silent on measured cache-preserving `claude-sonnet-5-5` (`r2_effort.csv`, `n = 3` with thinking expansion) and `claude-opus-5-5` (`currency_55.csv` `effort_only_55`, reasoning output change **unverified**), and warns with `"unverified for this model"` on untested models.
- **SDK / `stream-json` Host Downshift Pattern (`Item 4.2`):**
  - Interactive hooks (`SessionStart:compact`, `PostCompact`) cannot mutate `mainLoopModel` (`Phase 0`). In interactive Claude Code, Highbeam emits a 1-line `SessionStart:compact` `systemMessage` (`0` `/v1/messages` tokens leaked, verified at `$0` on `claude.exe@2.1.325`) reminding `/model <target>`, and avoids invalid `PostCompact` `hookSpecificOutput`.
  - In SDK or `stream-json` hosts, watch stream frames for `compact_boundary` and invoke `set_model` on the host controller immediately afterward—never inside a hook.
- **Resume Toolset Visibility (`Item 6`):**
  - On `claude.exe@2.1.325`, `SessionStart:resume` stdin supplies `context_tokens` and `prompt_cache_likely_expired` without exposing `tools` or `mcp_servers` (`deferred_tools_delta` is written to `.jsonl` after `SessionStart`). Highbeam hashes observable config files (`.mcp.json`, `.claude/settings*.json`, `~/.claude.json`), CLI `--mcp-config`/`--tools` flags, and optional host arrays, warning if hashes diverge on large non-expired resumes (`CC-T`).

---

## 3. Reconciled Virtual Mode ROI & Unverified Boundaries

- **Calibrated Mode Accuracy & Developer ROI ([`VIRTUAL_AUTO_EFFECTIVENESS_REPORT.md`](../experiments/model-switch-benchmark/results/virtual_auto_v4_1/VIRTUAL_AUTO_EFFECTIVENESS_REPORT.md)):**
  - Across `14` empirical arms / `58` sessions (`181` checks, `13.66ms` median / `16.71ms` p95 hook eval), v4.1 Zero-Cfg Auto achieved `54/58` (`93.1%`) accuracy and Horizon-Calibrated Auto reached `100%` across Track 2 horizon stress tests (`L1 +$0.1248`, `TH +$0.3218`).
  - Reconciled bottom-up monthly API savings vs. `OFF` for an average full-time agentic developer (`~40` chats/wk, `$390–$650/mo` raw API spend) are **`$9.42/wk` / `$40.79/mo` (`~6%–11%`, midpoint `~8%`)**, scaling from `$9.83/mo` (light dev) to `$149.13/mo` (heavy Opus swarm dev).
- **Explicitly Unverified Items:**
  - `claude-opus-5-5` reasoning output behavior under mid-session effort changes (`currency_55.csv` verified cache preservation only).
  - `DET-09` effort behavior on models outside the `4.6` and `5.5` families (`"unverified for this model"`).
  - `evaluateTaskBoundaryTurn` compaction suggestions (`phase1_boundary_detector.csv`: `80.00%` precision on scripted plans, `0` organic boundaries in `78` historical transcripts; `smartCompactBoundarySuggest` defaults to `false`).
  - Multi-replicate live task-completion A/B benchmark on Google Antigravity (currently validated via unit, JSDOM, and local `.rsl_steps.jsonl` telemetry suites rather than a paid wire benchmark).
