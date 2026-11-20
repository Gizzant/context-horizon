# Does Compressing Tool Output Actually Lower AI Coding Bills? 144 Live Runs on Claude Code (Wins, Losses, and Cache Math)

In September 2026, Quesma ran 1,740 Terminal-Bench attempts and published a sharp, uncomfortable result for CLI-compression tools: **shrinking terminal output didn't automatically lower API bills**, because terminal logs were a small, mostly cached share of total spend unless early uncached cache writes or turn growth actually dropped.

That forced us to stop guessing and benchmark **Highbeam (`highbeam-cli` v4.4.1)** on live API billing (`wireObs` token telemetry and settled USD), publishing the losses alongside the wins. Across **144 live Claude Code runs** (`72` replicated doc/log/audit A/B runs + `27` code-exploration null-result runs + `45` model-switch wire runs) plus **19 offline multi-stack CLI fixtures**, here is what actually moved the bill, what did not, and why.

---

## TL;DR — What Actually Moved Billed Cost

| Study | Scope & Hardware | Result vs. Baseline | Key Engineering Lesson |
| :--- | :--- | :--- | :--- |
| **Study 1: 72-Run Live A/B (`T01`–`T08`)** | Doc/log/audit workloads (`sonnet-5.5`, `3` reps × `8` tasks × `3` arms) | **`-13.31%` mean USD** (`$4.8174` vs. `$5.5569`, `-14.39%` median), **`-24.31%` prompt-bill tokens** (`6.85M` vs. `9.05M`), `20/24` wins | Hooks + FTS5 *without* Shield lost **`+4.37%`**. Pre-write read clamping (`auto`) + `Grep\|Glob` filtering + FTS5 together created `-16.94%` vs. Shield-off. |
| **Study 2: 27-Run Exploration (`T09`–`T11`)** | Pure small-file code navigation (no large docs/logs) | **`+6.88%`** (`$1.3195` vs. `$1.2346`) & **`+14.08%`** with opt-in scout (`$1.4085`) — **null result** | `0/27` Shield clamps and `0/27` subagent spawns. Pure code exploration stays inside normal LLM variance; Haiku scout remains **opt-in** (`false` default). |
| **Study 3: 45-Run Model-Switch Wire Study** | 540 turns (`$22.72` settled OpenRouter -> 1st-party Anthropic) | `Opus 4.6 -> Sonnet 4.6` at Turn 6 **lost money** (`$0.8611` vs. `$0.7789`, `+10.6%`) | Mid-session downgrades wipe warm prompt caches (`0.0%` Turn-6 hit rate, `+$0.1783` spike) unless remaining turns exceed horizon break-even `C_max`. |
| **Study 4: 19-Fixture Offline Compression** | `npm run bench:parity` (`F01`–`F19`, 19 tool families) | **`96%` reduction** (`54,415 -> 2,176` tok), **`100%` recall (`52/52`)** | Never rewrite `cat`/`head`/`tail`/`sed`/`awk`/`grep`/`rg`/`jq` or unknown commands — avoids re-read penalty loops. |

---

## Study 1: 72-Run Replicated Live A/B (`T01`–`T08`, Doc/Log/Audit Workloads)

**Source artifact:** [`experiments/model-switch-benchmark/results/highbeam_ab_results.json`](../../experiments/model-switch-benchmark/results/highbeam_ab_results.json) (`recordedAtUtc: 2026-11-20T02:30:12.549Z`, `anthropic/claude-sonnet-5.5`, full HTTP `wireObs` capture and `exPostLedgerReconciliation`).

We ran **3 arms × 8 tasks × 3 replications = 72 runs**, deliberately including a **middle ablation arm (`HIGHBEAM_SHIELD_OFF`)** with hooks and FTS5 active but Active Context Shield disabled:

| Arm | Runs Completed | HTTP Reqs | Total Billed USD | Mean / Run | Prompt-Bill Tokens (`write` + `read` + `input`) | Delta vs. `BASELINE` | Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **`BASELINE`** (no Highbeam) | `24 / 24` (`100%`) | `240` | `$5.5569` | `$0.2315` | `9,047,750` (`1,062,008`w + `7,985,262`r + `480`in) | — | Reference (`0` clamps, `0` FTS5) |
| **`HIGHBEAM_SHIELD_OFF`** (`hooks`, Shield off) | `24 / 24` (`100%`) | `236` | `$5.7998` | `$0.2417` | `9,394,539` (`1,083,543`w + `8,310,518`r + `478`in) | **`+4.37%`** (`+$0.2429`) | Proves FTS5 hooks alone don't lower cost here |
| **`HIGHBEAM`** (Default `auto` Shield + `Grep\|Glob` + FTS5) | **`24 / 24` (`100%`)** | **`241`** (`1.004x`) | **`$4.8174`** | **`$0.2007`** | **`6,847,992`** (`798,874`w + `6,048,636`r + `482`in) | **`-13.31%` mean** (`-14.39%` median paired) | **`-24.31%` prompt-bill** (`-24.78%`w / `-24.25%`r), **`20/24` wins**, **`3/3` reps**, **`-16.94%` vs. Shield-off** |

### Replication & Task Consistency (Including the `T06` Loss)
- **All 3 replications won independently:** Rep 1 `-13.31%` (`$1.8802 -> $1.6300`), Rep 2 `-11.06%` (`$1.8239 -> $1.6221`), Rep 3 `-15.52%` (`$1.8528 -> $1.5652`).
- **7 of 8 tasks won (`BASELINE` -> `HIGHBEAM`):** `T01` (`-28.52%`), `T03` (`-22.39%`), `T07` (`-16.78%`), `T08` (`-15.51%`), `T04` (`-14.98%`), `T05` (`-7.53%`), `T02` (`-4.45%`).
- **The loss (`T06`, `+13.43%`):** On `T06`, extra exploration turns outweighed clamping gains. No selective filtering or omitted runs.
- **Zero broken workflows:** `24/24` (`100%`) task completion, `241` vs. `240` requests (`1.004x`), `15` clamp-only `updatedInput` slices (`mode: 'auto'` default), `0` hard blocks, and `0` false Bash offload hits.

### Why Shield + Clamp-Only Was Crucial (Answer to Quesma)
Post-hoc terminal compression alone (`HIGHBEAM_SHIELD_OFF`) did **not** save money (`+4.37%`). What moved the needle (`-13.31%` cost / `-24.31%` prompt-bill) was preventing multi-thousand-line `Read` and wide `Grep`/`Glob` payloads from entering the prefix at `PreToolUse` (`updatedInput` slices capped to `<=250` lines / `<=16 KB` without rejecting the tool call) paired with net-positive FTS5 filtering on noisy CLI output. Because every subsequent turn re-pays read/write costs on active prefix history, stopping bloated tool inputs early cuts both cache creation (`-24.78%`) and cache read tokens (`-24.25%`).

---

## Study 2: 27-Run Code-Exploration Null Result (`T09`–`T11`)

**Source artifact:** [`experiments/model-switch-benchmark/results/highbeam_ab_exploration_results.json`](../../experiments/model-switch-benchmark/results/highbeam_ab_exploration_results.json) (`3` pure code-navigation tasks × `3` reps × `3` arms = **`27` live runs**, `anthropic/claude-sonnet-5.5`).

When tasks inspect clean source files without large docs, log dumps, or wide search explosions, what happens?

| Arm (`T09`–`T11`, `n = 9`/arm) | Runs | Reqs | Total Billed USD | Prompt-Bill Tokens | Delta vs. `BASELINE` | Observed Mechanism |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **`BASELINE`** | `9/9` | `69` | `$1.2346` | `1,489,924` | — | `0` subagents |
| **`HIGHBEAM`** (`auto` Shield, no scout) | `9/9` | `71` | `$1.3195` | `1,577,934` | **`+6.88%`** (`+$0.0849`) | `0/9` Shield clamps, `0/9` subagents (`T09 +21.37%`, `T10 +3.23%`, `T11 -2.60%`) |
| **`HIGHBEAM_SCOUT`** (`autoTierReadOnlyScouts`) | `9/9` | `69` | `$1.4085` | `1,617,677` | **`+14.08%`** (`+$0.1739`) | `0/9` Shield clamps, `0/9` subagents (`T09 +13.48%`, `T10 +5.59%`, `T11 +23.13%`) |

**Honest conclusion:** On clean multi-file code browsing, Shield clamped `0/27` times and Claude ignored optional scout steering (`0/27` subagent spawns). Both active arms stayed inside normal LLM turn-variance (`+6.88%` / `+14.08%`). Because `ah-haiku-scout` showed **zero live savings**, it ships **opt-in (`false` default)** rather than bundled into default claims.

---

## Study 3: Why Mid-Session Model Switching Usually Costs More (`45 Runs / 540 Turns`)

**Source artifact:** [`experiments/model-switch-benchmark/results/article_findings_report.md`](../../experiments/model-switch-benchmark/results/article_findings_report.md) (`45` runs, `540/540` wire-matched user turns, `$22.72` OpenRouter -> 1st-party Anthropic).

- Switching `Opus 4.6 -> Sonnet 4.6` at Turn 6 on a `~58k` context collapsed Turn-6 prompt-cache hits to **`0.0%`** (`+$0.1783` spike), raising 12-turn cost from **`$0.7789`** (Opus control) to **`$0.8611`** (`+$0.0822` net loss).
- Changing `output_config.effort` mid-chat on `4.6` models (`Arm D`) also collapsed Turn-6 cache hits to `0.0%` (`+$0.0853`), whereas `claude-sonnet-5-5` (`r2_effort.csv`, `n = 3`) and `claude-opus-5-5` (`currency_55.csv`) preserved prefix caches across effort changes.
- That is why `DET-08` computes break-even horizon (`C_max` & payback turns) live from [`anthropicModelCatalog.json`](../../src/config/anthropicModelCatalog.json) and `DET-09` checks `MODEL_EFFORT_CACHE_CAPABILITIES` per model family instead of firing blind downgrade nags.

---

## Study 4: Offline CLI Compression & The 3-Bucket Accounting Rule

1. **19-Fixture Multi-Stack Parity (`npm run bench:parity`):** Across `19` noisy test/build/diff fixtures (`F01`–`F19`), structured FTS5 parsers reduced token count by **`96%`** (`54,415 -> 2,176` tokens) with **`100%` diagnostic recall (`52/52`)** and **`100%` BM25/MCP retrieval (`19/19`)**, explicitly excluding `cat`/`head`/`tail`/`sed`/`awk`/`grep`/`rg`/`jq` with zero generic fallback ([`ANTIGRAVITY_AND_COMPRESSION_BENCHMARK.md`](../ANTIGRAVITY_AND_COMPRESSION_BENCHMARK.md)).
2. **No Unit Mixing (3-Bucket Ledger):** Highbeam separates **Bucket 1: Avoided Writes** (real-time read clamps + FTS5 + repeat-read folding), **Bucket 2: Ex-Post Realized Prompt-Bill Delta** (signed wire delta vs. baseline), and **Bucket 3: Provider KV-Cache Discount** (Anthropic/Google platform cache hits tracked separately and **never** counted as Highbeam savings).

---

## Try Read-Only on Your Own Logs in 10 Seconds

Zero hooks, zero file writes, zero network calls:

```bash
npx highbeam-cli audit --days 7
```

Export an anonymized, PII-scrubbed 3-bucket snapshot from your own local sessions:

```bash
npx highbeam-cli receipt --share
```

If you want `ci-gate`, `pr-cost`, and `team-rollup` on your metered-API CI/repos, we are recruiting **3–5 pilot teams (free for 60 days)** in exchange for an anonymized rollup and a short quote (`sales@highbeamdev.com`).
