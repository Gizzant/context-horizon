# Claude Code Mid-Chat Model & Effort Switch Benchmark (`45 Runs / 540 Turns`)

Reproducible wire-level experiment measuring prompt-cache hit ratios, USD cost, Time-To-First-Byte (TTFB), and wall-clock latency when switching models or changing `--effort` mid-conversation in **Claude Code**.

- **Experiment Date (UTC):** `2026-11-14`
- **Target CLI Harness:** `@anthropic-ai/claude-code@2.1.325` (`--tools "Read"`, frozen empty settings, isolated `HOME` and `CLAUDE_CONFIG_DIR` per run)
- **Pinned Repository Commit:** `19c51055902c545508af1979a392505355777d90` (detached `HEAD`, `git checkout -f` + `git clean -fdx` before every run)
- **Upstream Route:** OpenRouter Anthropic Messages API (`https://openrouter.ai/api/v1/messages`) locked strictly to first-party Anthropic (`provider: { only: ["anthropic"], allow_fallbacks: false }`) so multi-cloud cache variance (`Bedrock` / `Vertex` / `Azure`) is eliminated.
- **Pre-Registered Hypotheses:** [`predictions.md`](predictions.md) (`SHA-256: 4b74083f47524c053dd8470644961442e473ff2f70f8bbc4a1069f7ca1961c56`, hashed before live runs)
- **Published Findings:** [`results/article_findings_report.md`](results/article_findings_report.md)

---

## Model Pair & Verified Rate Card (Per 1M Tokens, USD)

Defined in [`config.mjs`](config.mjs) (`PRICING_PER_1M`) using verified OpenRouter / first-party Anthropic pricing at run time:

| CLI Flag | OpenRouter Model Slug | Uncached Input | 5m Cache Write (`1.25x`) | 1h Cache Write (`2.0x`) | Cache Read (`0.10x`) | Output |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `claude-opus-4-6` | `anthropic/claude-opus-4.6` | `$5.00` | `$6.25` | `$10.00` | `$0.50` | `$25.00` |
| `claude-sonnet-4-6` | `anthropic/claude-sonnet-4.6` | `$3.00` | `$3.75` | `$6.00` | `$0.30` | `$15.00` |
| `claude-haiku-4-5` | `anthropic/claude-haiku-4.5` | `$1.00` | `$1.25` | `$2.00` | `$0.10` | `$5.00` |

*(Observed live traffic used `ephemeral_5m` exclusively: `eph1h_write_tokens = 0` across all 540 turns, and `0` background Haiku LLM calls occurred.)*

---

## Experimental Design & Arms (`N = 5` Replicates, Seed `20261114`)

Two calibrated context tiers (`12` fixed read-only turns per session; Turns `1–3` run single `Read` calls with explicit `offset`/`limit`, Turns `4–12` run zero-tool analytical Q&A capped at `<= 100` words):

- **Small Tier (`~15k` wire tokens at Turn 6):** `~8.85k` Claude Code baseline floor + `~6.3k` read/chat context (`fixtures/prompts_small.json`).
- **Large Tier (`~56k–60k` wire tokens across Turns 6–12):** `~8.85k` baseline floor + `~47k–50k` read/chat context (`fixtures/prompts_large.json`).

| Arm | Name | Schedule (12 Turns) | Small (`~15k`) Runs | Large (`~56k–60k`) Runs | Research Question Tested |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **A** | Control | `Opus 4.6 (medium)` Turns `1–12` | `5` | `5` | Baseline cost, latency & warm cache hit rate |
| **B** | One Switch | `Opus 4.6` `T1–T5` -> `Sonnet 4.6` `T6–T12` | `5` | `5` | **Q1** first-switch penalty, **Q2** `T7` recovery, **Q5** prefix scaling |
| **C** | Switch & Back | `Opus 4.6` `T1–T5` -> `Sonnet 4.6` `T6–T7` -> `Opus 4.6` `T8–T12` | `5` | — | **Q3** returning to Opus within `5m` TTL (`T8`) |
| **D** | Effort Only | `Opus 4.6` `medium` `T1–T5` -> `high` `T6–T12` | `5` | — | **Q4** whether `--effort` alone invalidates prompt cache |
| **E** | Idle > TTL + Switch | `Opus 4.6` `T1–T5` -> `>=330s` idle -> `Sonnet 4.6` `T6–T12` | `5` | — | TTL expiry control (`5m 30s+` wait vs warm switch) |
| **F** | Ten Switches | Alternating `Opus <-> Sonnet` every turn `T1–T11`, `Opus` `T12` | `5` | `5` | **Headline** 10 mid-chat switches (`<5m` dual warm caches) |

Total matrix: **`9` cells × `5` randomized replicates = `45` runs (`540` user turns)**.

### Confound Controls

1. **Identical `--resume` pattern:** Every session passes `--append-system-prompt "Benchmark-Run-Salt: <runId>_<hash>"` to isolate cache keys across replicates and uses `--resume <sessionId>` on Turns `2–12` across *all* arms including Control.
2. **Randomized run order:** All 45 runs are shuffled via deterministic `mulberry32(20261114)` Fisher–Yates shuffle; parked `Arm E` sessions resume immediately once their `>=330s` timer elapses (`single-wire concurrency`, avoiding idle timing drift).
3. **Wire-truth recording + transcript parity:** [`proxy_recorder.mjs`](proxy_recorder.mjs) streams SSE responses unbuffered (`Accept-Encoding: identity`), records structural SHA-256 fingerprints (`system`, `tools`, `thinking`, `output_config`, `cacheBreakpoints`), separates non-main calls (`/v1/messages/count_tokens` 404 probes), and [`analyze_results.mjs`](analyze_results.mjs) verifies `540/540` byte-for-byte cache-token parity against Claude Code `.jsonl` session transcripts.
4. **Resumed run scrub note:** Run `B_L_r01` originally paused after Turn 9 on HTTP `402` (`>7h` pause before wallet top-up). Its stale partial data (`$0.794648`, recorded in [`results/raw/scrubbed_partial_runs.json`](results/raw/scrubbed_partial_runs.json)) was scrubbed prior to `--resume` so `B_L_r01` executed cleanly from Turn 1 through Turn 12 without a 7-hour TTL artifact.

---

## Reproducing the Benchmark

### 1. Offline Self-Test (`$0` API spend)

Verifies proxy SSE forwarding, usage/cost calculation, budget circuit breaker, seeded 45-run schedule, and CSV/SVG analyzer against a local mock upstream:

```bash
node experiments/model-switch-benchmark/selftest_offline.mjs
```

### 2. Provision Isolated Runtime & API Key

1. Install pinned Claude Code into your OS temp runtime directory (`%TEMP%/claude-code-switch-benchmark-runtime/cli` or `/tmp/claude-code-switch-benchmark-runtime/cli`):
   ```bash
   npm install --prefix "$TMPDIR/claude-code-switch-benchmark-runtime/cli" @anthropic-ai/claude-code@2.1.325
   ```
2. Clone the target repo into `$TMPDIR/claude-code-switch-benchmark-runtime/frozen-repo` and check out commit `19c51055902c545508af1979a392505355777d90`.
3. Provide an OpenRouter API key via `OPENROUTER_API_KEY` or gitignored `.env.benchmark` (`OPENROUTER_API_KEY=<your-openrouter-api-key>`) at the repo root.

### 3. Pilot Calibration Gate & Full Run

```bash
# Quick calibration gate (~$0.93) verifying Small/Large Turn 5 token bounds
node experiments/model-switch-benchmark/run_experiment.mjs --pilot --calib-only

# Full 45-run randomized experiment (~$22 USD total, checkpoint-resumable)
node experiments/model-switch-benchmark/run_experiment.mjs --run-all

# Resume from checkpoint if interrupted
node experiments/model-switch-benchmark/run_experiment.mjs --run-all --resume
```

### 4. Re-Run Analysis & Regenerate CSVs / SVGs / Markdown Report

```bash
node experiments/model-switch-benchmark/analyze_results.mjs
```

---

## Directory & CSV Schema

- [`config.mjs`](config.mjs) — Model map, OpenRouter pricing rates, arm definitions, deterministic scheduler (`buildFullSchedule`).
- [`proxy_recorder.mjs`](proxy_recorder.mjs) — Local HTTP->HTTPS SSE pass-through logging proxy with provider pinning, SHA-256 request fingerprinting, key/path redaction, and budget breaker.
- [`run_experiment.mjs`](run_experiment.mjs) — Isolated Claude Code turn runner with Arm E parking scheduler and OpenRouter `/api/v1/key` ledger tracking.
- [`analyze_results.mjs`](analyze_results.mjs) — Reconciles wire logs against `.jsonl` transcripts, computes medians/min–max ranges & Turn 5->6 wire diffs, writes CSVs, SVGs, and Markdown report.
- [`selftest_offline.mjs`](selftest_offline.mjs) — Zero-cost offline harness verification.
- [`fixtures/prompts_small.json`](fixtures/prompts_small.json) & [`fixtures/prompts_large.json`](fixtures/prompts_large.json) — Calibrated 12-turn read-only prompt suites.
- [`results/turns.csv`](results/turns.csv) — Per-turn dataset (`540` rows × `29` columns including `uncached_input_tokens`, `cache_creation_tokens`, `cache_read_tokens`, `cache_hit_ratio`, `cost_usd`, `ttfb_ms`, `api_latency_ms`, `cli_wall_ms`, `transcript_matched`, `switch_cost_penalty_usd`, `switch_latency_penalty_ms`).
- [`results/summary_by_arm.csv`](results/summary_by_arm.csv) — Per-(tier, arm, turn) medians and `[min, max]` ranges (`108` rows).
- [`results/session_summary.csv`](results/session_summary.csv) — Per-(tier, arm) 12-turn session totals (`9` cells).
- [`results/arm_d_wire_diff.json`](results/arm_d_wire_diff.json) — Exact structural request diff proving `output_config.effort: "medium" -> "high"` is the sole parameter mutation at Arm D Turn 6.
- [`results/chart_cache_tokens_by_turn.svg`](results/chart_cache_tokens_by_turn.svg) & [`results/chart_cost_penalty.svg`](results/chart_cost_penalty.svg) — Publication SVG charts.
- [`results/raw/`](results/raw/) — Full sanitized `.jsonl` transcripts (`45` files), wire logs, CLI turn summaries, checkpoint, manifest, and OpenRouter ledger log.

---

## Disclosure & Scope

- **Disclosure:** This benchmark was authored and executed within the repository of **Highbeam (`ctxtop`)** ([https://github.com/Gizzant/attention-horizon-antigravity](https://github.com/Gizzant/attention-horizon-antigravity)), an open-source local context and prompt-cache monitor designed around horizon-aware cache break-even limits (`C_max`).
- **Scope:** Measurements apply strictly to `@anthropic-ai/claude-code@2.1.325` calling first-party `anthropic/claude-opus-4.6` and `anthropic/claude-sonnet-4.6` via OpenRouter `/api/v1/messages` (`ephemeral_5m` cache TTL) on `2026-11-14`. Cache keying rules, TTLs, and token pricing are subject to change in future CLI or API releases.
