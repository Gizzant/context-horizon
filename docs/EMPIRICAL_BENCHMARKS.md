# Highbeam (`highbeam-cli`) — Empirical Benchmarks, Wire Findings & Runtime Mechanics

This document consolidates the granular wire-level measurements, replicated live OpenRouter A/B trials, model-catalog mechanics, and explicit verification boundaries behind **Highbeam (`highbeam-cli` v4.3)**.

---

## 1. 72-Run Replicated Live A/B (`T01`–`T08`, Claude Code + `anthropic/claude-sonnet-5.5`)

Source artifact: [`highbeam_ab_results.json`](../experiments/model-switch-benchmark/results/highbeam_ab_results.json) (`recordedAtUtc: 2026-11-20T02:30:12.549Z`, `8` tasks × `3` replications × `3` arms = **`72` live runs**, with full `wireObs` HTTP request telemetry and `exPostLedgerReconciliation`).

| Arm | Runs Completed | Requests | Total Billed USD | Mean USD / Run | Prompt-Bill Tokens (`cacheCreate` + `cacheRead` + `input`) | Delta vs. `BASELINE` | Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **`BASELINE`** (no Highbeam) | `24 / 24` (`100%`) | `240` | `$5.5569` | `$0.2315` | `9,047,750` (`1,062,008` write + `7,985,262` read + `480` input) | — | Control arm (`0` clamps, `0` FTS5 receipts) |
| **`HIGHBEAM_SHIELD_OFF`** (`hooks` without Shield) | `24 / 24` (`100%`) | `236` | `$5.7998` | `$0.2417` | `9,394,539` (`1,083,543` write + `8,310,518` read + `478` input) | **`+4.37%` USD** (`+$0.2429`) | Proves hooks without Active Context Shield do not deliver net cost wins |
| **`HIGHBEAM`** (Default `mode: 'auto'` Shield + `Grep\|Glob` + FTS5) | **`24 / 24` (`100%`)** | **`241`** (`1.004x`) | **`$4.8174`** | **`$0.2007`** | **`6,847,992`** (`798,874` write + `6,048,636` read + `482` input) | **`-13.31%` mean USD** (`-$0.7396`) · **`-14.39%` median paired** | **`-24.31%` prompt-bill** (`-24.78%` write, `-24.25%` read), **`20/24` paired wins**, **`3/3` reps**, **`7/8` tasks**, **`-16.94%` vs. Shield-off**, **`15` Shield byte-cap clamps**, **`0` hard denies**, **`0` false Bash offload hits** |

- **Per-Replication Consistency (`BASELINE` -> `HIGHBEAM`):** Rep 1 `-13.31%` (`$1.8802 -> $1.6300`), Rep 2 `-11.06%` (`$1.8239 -> $1.6221`), Rep 3 `-15.52%` (`$1.8528 -> $1.5652`).
- **Per-Task Breakdown (`BASELINE` -> `HIGHBEAM`, `3` reps/task):** `T01` (`-28.52%`), `T03` (`-22.39%`), `T07` (`-16.78%`), `T08` (`-15.51%`), `T04` (`-14.98%`), `T05` (`-7.53%`), `T02` (`-4.45%`), `T06` (`+13.43%`).
- **Out-of-the-Box Delivery:** Fresh workspaces without `.attention-horizon.json` now default to clamp-only `mode: 'auto'` Shield on Claude Code, `net-positive` FTS5/Bash exclusion rules (`cat`/`head`/`tail`/`sed`/`awk`/`grep`/`rg`/`jq`), `Grep|Glob` `PostToolUse` array filtering, and 3-bucket ledger separation (`avoidedWrites` vs. `realizedPromptBill` vs. `platformCacheDiscount`).

---

## 2. 27-Run Code-Exploration Benchmark (`T09`–`T11`) — Null Result & Scope Boundary

Source artifact: [`highbeam_ab_exploration_results.json`](../experiments/model-switch-benchmark/results/highbeam_ab_exploration_results.json) (`3` pure multi-file code-exploration tasks × `3` replications × `3` arms = **`27` live runs** on `anthropic/claude-sonnet-5.5` with no oversized docs/logs).

| Arm | Runs Completed | Requests | Total Billed USD | Prompt-Bill Tokens | Cost Delta vs. `BASELINE` | Key Observation |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **`BASELINE`** | `9 / 9` (`100%`) | `69` | `$1.2346` | `1,489,924` | — | `0` subagent spawns |
| **`HIGHBEAM`** (`auto` Shield, no scout) | `9 / 9` (`100%`) | `71` | `$1.3195` | `1,577,934` | **`+6.88%`** (`+$0.0849`) | `0/9` Shield clamps, `0` subagent spawns (`T09 +21.37%`, `T10 +3.23%`, `T11 -2.60%`) |
| **`HIGHBEAM_SCOUT`** (`autoTierReadOnlyScouts` enabled) | `9 / 9` (`100%`) | `69` | `$1.4085` | `1,617,677` | **`+14.08%`** (`+$0.1739`) | `0/9` Shield clamps, `0` Haiku/subagent spawns (`T09 +13.48%`, `T10 +5.59%`, `T11 +23.13%`) |

- **Explicit Scope Boundary:** On pure small-file code navigation (`T09`–`T11`), Shield never triggered (`0/27` clamps) and Claude chose direct file tools instead of spawning subagents (`0/27` spawns), leaving both active arms within normal single-digit LLM turn variance (`+6.88%` / `+14.08%`).
- **Product Consequence:** Highbeam ships **`ah-haiku-scout` strictly opt-in** (`autoTierReadOnlyScouts: false` by default; enable via `npx highbeam-cli scout --enable`), claims **zero** live benchmark cost savings from the scout, and scopes its `-13.31%` / `-24.31%` benchmark claim strictly to doc-, log-, and audit-heavy sessions where oversized reads, verbose CLI logs, or wide search outputs occur.

---

## 3. 19-Fixture Offline Multi-Stack CLI Compression (`npm run bench:parity`)

Source artifact: [`ANTIGRAVITY_AND_COMPRESSION_BENCHMARK.md`](ANTIGRAVITY_AND_COMPRESSION_BENCHMARK.md) (`scripts/run_antigravity_and_compression_benchmark.mjs`).

- **Aggregate Offline Reduction:** **`96%` token reduction** (`54,415` raw tokens -> `2,176` summary tokens across **`19` structured CLI fixtures `F01`–`F19`**), **`100%` diagnostic recall (`52/52` ground-truth markers)**, and **`100%` SQLite FTS5 & MCP retrieval (`19/19`)**.
- **Covered Tool Families:** Pytest, Vitest/Jest, `tsc`, Cargo, `go test`, ESLint, `git diff`, `git status`, `docker build`, `kubectl logs`, Maven (`mvn test`), Gradle (`./gradlew test`), .NET (`dotnet test`), Make (`make all`), Playwright, RSpec, PHPUnit, Deno test, and CTest.
- **Explicit Exclusions:** Raw file inspection commands (`cat`, `head`, `tail`, `sed`, `awk`, `grep`, `rg`, `jq`) are excluded from Bash offload, and unmatched arbitrary shell commands fall back safely without synthetic compression.

---

## 4. Measured Prompt-Cache & Hook Behavior (`Claude Code 2.1.325`)

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

## 5. Model-Aware Switch (`DET-08`), Effort (`DET-09`), & Resume Guards

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

## 6. Historical Virtual Mode Model & Remaining Unverified Boundaries

- **Historical Calibration Note (v4.1 vs. v4.3):** Earlier v4.1 bottom-up modeling ([`VIRTUAL_AUTO_EFFECTIVENESS_REPORT.md`](../experiments/model-switch-benchmark/results/virtual_auto_v4_1/VIRTUAL_AUTO_EFFECTIVENESS_REPORT.md)) checked `14` arms / `58` sessions (`54/58`, `93.1%` Zero-Cfg Auto accuracy) and estimated `~6%–11%` monthly API reduction. For current user-facing benchmarks, Section 1 (`72`-run live replicated A/B: `-13.31%` mean / `-14.39%` median billed cost on doc/log/audit workloads) and Section 2 (`27`-run code-exploration null result) supersede those virtual projections.
- **Explicitly Unverified Items:**
  - `claude-opus-5-5` reasoning output behavior under mid-session effort changes (`currency_55.csv` verified cache preservation only).
  - `DET-09` effort behavior on models outside the `4.6` and `5.5` families (`"unverified for this model"`).
  - `evaluateTaskBoundaryTurn` compaction suggestions (`phase1_boundary_detector.csv`: `80.00%` precision on scripted plans, `0` organic boundaries in `78` historical transcripts; `smartCompactBoundarySuggest` defaults to `false`).
  - Opt-in `ah-haiku-scout` (`npx highbeam-cli scout --enable`): zero live A/B cost savings demonstrated (`T09`–`T11` recorded `0/27` spawns).
  - Multi-replicate live task-completion A/B benchmark on Google Antigravity (currently validated via unit, JSDOM, and local `.rsl_steps.jsonl` telemetry suites rather than a paid wire benchmark).
