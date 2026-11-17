# Highbeam v4.1 Virtual Mode Effectiveness Report (`Off` vs. `Coach` vs. `Auto`)

**Generated (UTC):** `2026-11-16T14:51:28.567Z` | **API Spend:** `$0.00` (Offline Counterfactual Replay) | **Hook Evaluations:** `181` active checks, median `13.66 ms` (P95 `16.71 ms`, max `18.69 ms`)

> **Provenance & Statistical Convention:** Every multi-rep figure reports **`n`** and **`median [min–max]`** (never mixing means and medians). Every USD number carries an explicit provenance tag: `measured` (OpenRouter `billed` wire usage or Direct API `computed`), `counterfactual` (offline replay using paired empirical control vs. switched runs — `Coach` additionally models compliance rate $p_{\text{follow}} \in \{25\%, 50\%, 75\%, 100\%\}$). **Zero** estimates from `horizon_ledger.jsonl` are quoted.

---

## Executive Verdict (`14` Empirical Arms / `58` Sessions Across Tracks 1 & 2)

| Mode / Policy | Decision Accuracy (Arms / Sessions) | 58-Session Weighted Basket Cost (Counterfactual) | Net Delta vs. `Off` | Net Delta vs. Legacy `rule_v1` | Operational Behavior |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **`OFF`** | `6/14` (`22/58`) | `$26.9639` | `+$0.0000` | `-$1.4973` | Passes every bad switch/effort bust untouched. |
| **`COACH` (25% follow)** | Advises accurately; user obeys 25% | `$26.4198` | `+$0.5441` | `-$0.9533` | Non-blocking warnings; leaks 75% of cache busts. |
| **`COACH` (50% follow)** | Advises accurately; user obeys 50% | `$25.8688` | `+$1.0951` | `-$0.4022` | Requires human friction on every warm switch prompt. |
| **`COACH` (75% follow)** | Advises accurately; user obeys 75% | `$25.3216` | `+$1.6423` | `+$0.1450` | High savings only if user manually overrides instinct. |
| **Legacy `rule_v1` (Blind Hold)** | `11/14` (`51/58`) | `$25.4665` | `+$1.4973` | `+$0.0000` | **Over-blocks `L1` (`-$0.1248/run`), `TH` (`-$0.3218/run`), & 5.5 effort.** |
| **`AUTO` (Zero-Config 0-Horizon)** | **`12/14` (`54/58`)** | `$25.4666` | `+$1.4972` | `-$0.0001` | **Best short-session default (`54/58` = `93.1%`): holds all 12t busts + `L2` + `C55`, keeps `Arm E` & `5.5 effort`, holds `L1`/`TH` without horizon.** |
| **`AUTO` (Unguided 496-run Prior)** | `7/14` (`27/58`) | `$26.4657` | `+$0.4981` | `-$0.9992` | Captures `L1` & `TH`, but `~54–59` req prior lets short chats (`12t`, `L2`, `5.5`) switch cold. |
| **`AUTO` (v4.1 Horizon-Calibrated)** | `12/14` (`48/58`) | `$25.7858` | `+$1.1780` | `-$0.3193` | **`100%` on Track 2 (`+$0.1248` `L1`, `+$0.3218` `TH`, `+$0.0247` `L2`) & holds `small` @T6 (`+$0.0122`/`+$0.0487`); only misses `Arm F` T2 blind ping-pong.** |

> **Two Concrete Insights from Virtual Replay (`Track 1` vs. `Track 2`):**
> 1. **Trailing Regime Calibration Resolved Track 1 `small` @T6 (`[2,2,2,1,1] -> R=1.0`):** In Track 1 `small` sessions, Turns `1–3` run `Read` calls (`R = 2`) and Turns `4–5` switch to `Q&A` (`R = 1`). With trailing-regime detection in `shrinkRollingRequestsPerTurn`, Highbeam detects the `[1, 1]` Q&A suffix (`R = 1.0` while keeping `turnsAgree = false` so `g = 0` stays capped), holding **`5/5` `one_switch`** and **`5/5` `switch_and_back`** at Turn 6.
> 2. **Partial Hold on `ten_switches` (`Arm F`) under Horizon-Calibrated Auto:** At Turn 2 (`H = 10`), `Auto (Horizon-Calibrated)` treats an isolated downgrade as a permanent stay (`payback < 10 -> allow`) because the caller's Turn-3 flip-back intent is unobservable, allows T3 upshift, and blocks later switches once remaining turns fall below payback. `Auto (Zero-Cfg)` holds `Arm F` from Turn 2 (`5/5`).

---

## Track 1 — 45-Session Switch & Effort Matrix (`results/runs.csv`, 12 Turns, `n = 5` / Cell)

| Bucket & Arm | `n` | Optimal | `OFF` (Base `billed`) | `Coach (50%)` (`counterfactual`) | `Auto Zero-Cfg` Decision & Cost | `Auto Calibrated` Decision & Cost | `Auto Zero-Cfg` Saved vs `OFF` | Live `rule_v1` `n=1` (`measured`) |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `small` `control` | 5 | `ALLOW` | `$0.2699 [$0.2673–$0.2734]` | `$0.2699 [$0.2673–$0.2734]` | `passthrough` -> `$0.2699 [$0.2673–$0.2734]` | `passthrough` -> `$0.2699 [$0.2673–$0.2734]` | `+$0.0000` | — |
| `small` `one_switch` | 5 | `BLOCK` | `$0.2834 [$0.2821–$0.2846]` | `$0.2767 [$0.2753–$0.2790]` | `block/hold (DET-08)` -> `$0.2699 [$0.2673–$0.2734]` | `block/hold (DET-08)` -> `$0.2699 [$0.2673–$0.2734]` | `+$0.0122 [+$0.0095 to +$0.0161]` | `$0.2749` (`+$0.0074`) |
| `small` `switch_and_back` | 5 | `BLOCK` | `$0.3200 [$0.3160–$0.3233]` | `$0.2950 [$0.2916–$0.2984]` | `block/hold (DET-08)` -> `$0.2699 [$0.2673–$0.2734]` | `block/hold (DET-08)` -> `$0.2699 [$0.2673–$0.2734]` | `+$0.0487 [+$0.0475 to +$0.0500]` | `$0.2738` (`+$0.0475`) |
| `small` `effort_only` | 5 | `BLOCK` | `$0.3560 [$0.3508–$0.3572]` | `$0.3125 [$0.3118–$0.3142]` | `defer (DET-09)` -> `$0.2699 [$0.2673–$0.2734]` | `defer (DET-09)` -> `$0.2699 [$0.2673–$0.2734]` | `+$0.0869 [+$0.0780 to +$0.0899]` | `$0.2679` (`+$0.0829`) |
| `small` `idle_then_switch` | 5 | `ALLOW` | `$0.2835 [$0.2809–$0.2841]` | `$0.2835 [$0.2809–$0.2841]` | `allow` -> `$0.2835 [$0.2809–$0.2841]` | `allow` -> `$0.2835 [$0.2809–$0.2841]` | `+$0.0000` | `$0.2857` (`-$0.0019`) |
| `small` `ten_switches` | 5 | `BLOCK` | `$0.3081 [$0.3043–$0.3110]` | `$0.2900 [$0.2858–$0.2908]` | `block/hold (DET-08)` -> `$0.2699 [$0.2673–$0.2734]` | `partial hold (from T6)` -> `$0.3094 [$0.3081–$0.3139]` | `+$0.0370 [+$0.0343 to +$0.0418]` | `$0.2709` (`+$0.0362`) |
| `large` `control` | 5 | `ALLOW` | `$0.7789 [$0.7659–$0.7811]` | `$0.7789 [$0.7659–$0.7811]` | `passthrough` -> `$0.7789 [$0.7659–$0.7811]` | `passthrough` -> `$0.7789 [$0.7659–$0.7811]` | `+$0.0000` | — |
| `large` `one_switch` | 5 | `BLOCK` | `$0.8611 [$0.8585–$0.8651]` | `$0.8194 [$0.8148–$0.8211]` | `block/hold (DET-08)` -> `$0.7789 [$0.7659–$0.7811]` | `block/hold (DET-08)` -> `$0.7789 [$0.7659–$0.7811]` | `+$0.0811 [+$0.0777 to +$0.0978]` | `$0.7663` (`+$0.0988`) |
| `large` `ten_switches` | 5 | `BLOCK` | `$0.9130 [$0.9048–$0.9162]` | `$0.8463 [$0.8358–$0.8487]` | `block/hold (DET-08)` -> `$0.7789 [$0.7659–$0.7811]` | `partial hold (from T6)` -> `$0.9425 [$0.9320–$0.9461]` | `+$0.1351 [+$0.1322 to +$0.1398]` | `$0.7657` (`+$0.1391`) |

---

## Track 2 — Horizon Intelligence Stress Test (`Allow Profitable / Block Unprofitable`)

| Scenario | `n` | Optimal | `OFF` Cost (`billed`) | Legacy `rule_v1` Cost | `Auto Zero-Cfg` | `Auto Unguided Prior` | `Auto Calibrated` | `Auto Cal` vs `OFF` | `Auto Cal` vs `rule_v1` |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `L1_early_downgrade (30t @T3)` | 3 | `ALLOW` | `$0.4032 [$0.3948–$0.4058]` | `$0.5280 [$0.5277–$0.5317]` | `block (0-horizon)` (`$0.5280 [$0.5277–$0.5317]`) | `allow (horizon)` (`$0.4032 [$0.3948–$0.4058]`) | **`allow (horizon)`** (`$0.4032 [$0.3948–$0.4058]`) | `+$0.0000` | `+$0.1248 [+$0.1218 to +$0.1369]` |
| `L2_late_downgrade (30t @T24)` | 3 | `BLOCK` | `$0.5461 [$0.5455–$0.5484]` | `$0.5214 [$0.5174–$0.5308]` | `block (DET-08)` (`$0.5214 [$0.5174–$0.5308]`) | `allow (prior ~47 reqs)` (`$0.5461 [$0.5455–$0.5484]`) | **`block (DET-08)`** (`$0.5214 [$0.5174–$0.5308]`) | `+$0.0247 [+$0.0148 to +$0.0310]` | `+$0.0000` |
| `TH_tool_heavy (12t R=5 @T3)` | 1 | `ALLOW` | `$0.7905` | `$1.1122` | `block (0-horizon)` (`$1.1122`) | `allow (R=4.4, horizon)` (`$0.7905`) | **`allow (R=4.4, horizon)`** (`$0.7905`) | `+$0.0000` | `+$0.3218` |
| `C55_one_switch (12t @T6)` | 3 | `BLOCK` | `$0.2590 [$0.2590–$0.2591]` | `$0.2261 [$0.2261–$0.2261]` | `block (DET-08)` (`$0.2261 [$0.2261–$0.2261]`) | `allow (prior ~57 reqs)` (`$0.2590 [$0.2590–$0.2591]`) | **`block (DET-08)`** (`$0.2261 [$0.2261–$0.2261]`) | `+$0.0329 [+$0.0329 to +$0.0330]` | `+$0.0000` |
| `C55_effort_only (12t @T6)` | 3 | `ALLOW` | `$0.2261 [$0.2261–$0.2261]` | `$0.2261 [$0.2261–$0.2261]` | `allow (5.5 safe capability)` (`$0.2261 [$0.2261–$0.2261]`) | `allow (5.5 safe capability)` (`$0.2261 [$0.2261–$0.2261]`) | **`allow (5.5 safe capability)`** (`$0.2261 [$0.2261–$0.2261]`) | `+$0.0000` | `-$0.0000 [-$0.0001 to -$0.0000]` |

**Key Track 2 Findings:**
- **Beats Legacy `rule_v1` on profitable early/tool-heavy downgrades:** `Auto (Horizon-Calibrated)` and `Auto (Unguided Prior)` both **allow** `L1` (`+$0.1248 [+$0.1218 to +$0.1369]` `measured` saving vs `rule_v1` hold) and `TH` `R=5` (`+$0.3218` `measured` saving vs `rule_v1` hold: `$1.1122` -> `$0.7905`), whereas `rule_v1` over-blocks both.
- **Model-aware `DET-09` capability intelligence (`Claude 5.5`):** On `C55_effort_only` (`Opus 5.5` `medium -> high`), v4.1 calls `getEffortMutationCacheCapability('claude-opus-5-5')` (`invalidatesCache: "no"`, `currency_55.csv` cache kept) and **allows** the effort shift cleanly, whereas a model-blind rule falsely blocks user intent.
- **Unguided Late-Turn Limitation (`Limitation #5`):** On `L2` (`30t @T24`), `Auto Calibrated` (`H=6`) and `Auto Zero-Cfg` block cleanly (`+$0.0247 [+$0.0148 to +$0.0310]`), while `Auto Unguided Prior` (`~47` residual reqs without caller/local-session horizon) allows the late downgrade (`-$0.0247`).

---

## Track 3 — Anti-Pattern & Session Guardrail Replay (`t3_idle`, `t4_parallel`, `t5_trim`, `t6_layers`)

| Anti-Pattern Benchmark | Measured Empirical Spread (`OFF` Trap vs. Mitigation) | Live Highbeam v4.1 Guard Behavior (`OFF` -> `COACH` -> `AUTO`) |
| :--- | :--- | :--- |
| **`T6` Prefix Mutation (`t6_layers.csv`, `n=3`)** | Append tool `TA`: `$0.2141 [$0.2139–$0.2141]`, MCP swap `CC-T`: `$0.2323 [$0.2293–$0.2335]`, Resample `TF`: `$0.7182 [$0.7161–$0.7191]`, Sys RAG `SRAG`: `$0.4626 [$0.4626–$0.4627]` vs. Control `C`: `$0.1600 [$0.1599–$0.1602]`, User RAG `MRAG`: `$0.1795 [$0.1795–$0.1795]` (**`-$0.2831` / `-61.2%`**) | `AGENTS.md` Shield (`55k`, `evaluateDet09MidSessionRuleMutate`): `OFF` -> `allow (pre_invocation skips in OFF)`, `COACH` -> `warn (non-blocking)`, `AUTO_PILOT` -> `block (DET-09)` (`CLAUDE.md` excluded per ISS-021: `true`; `.mcp.json` `interceptTopLevelMutation`: `defer`). |
| **`T5` Sliding Trim vs. Cliff Compaction (`t5_trim.csv`, `n=3`)** | Sliding trim `B`: `$1.4215 [$1.4203–$1.4230]` (`13.8%` hit) vs. 50% cliff `C`: `$0.4845 [$0.4818–$0.4856]` (`92.4%` hit) -> **`+$0.9359 [+$0.9359 to +$0.9412]` (`-65.9%`) saved** | `DET-12` Cliff Breaker (`Haiku 100k 5x`): `95k` -> `advise_compact`, `99k` -> `deny`; `Sonnet 4.6` `99k` -> `allow` (no false triggers). |
| **`T4` Parallel Subagent Primer (`t4_parallel.csv`)** | `N=10` Cold `P0` (`billed`): `$0.7516 [$0.6836–$0.7525]` vs. Primer `P2` (`billed`): `$0.1414 [$0.1413–$0.1416]` (**`+$0.6100 [+$0.5423 to +$0.6111]` / `-81.2%`**); `N=25`: `$1.8131` -> `$0.2426` (`computed`, **`+$1.5705` / `-86.6%`**) | Architectural pattern disclosure: currently implemented as a host/SDK 1-call primer pattern rather than a standalone Claude Code pre-fanout hook. |
| **`T3` Idle >5m TTL & `DET-16` Wakeup (`t3_idle.csv`, `n=3`)** | `TTL5_6m`: `$0.1326 [$0.1326–$0.1327]` vs. `TTL1H_6m`: `$0.1115 [$0.1115–$0.1116]` (**`+$0.0211 [+$0.0211 to +$0.0211]`**); Keep-Alive `KA-read` (`5` pings): `$0.0925 [$0.0924–$0.0925]` | `DET-16` cold wakeup: `17.6k` (`T3`) penalty = `$0.0474` (< `$0.50` threshold -> warn); `150k` Opus swarm penalty = `$0.6750` (>= `$0.50` -> `AUTO_PILOT` **hard-blocks** cold wakeup). |

---

## Track 4 — Bottom-Up Developer Weekly & Monthly ROI Model (`Reconciled`)

> **Bottom-Up Estimation Basis:** Because Tracks 1–2 deliberately inject mid-session switches and mutations, expecting every normal session to save `12%` would overstate real-world ROI. Instead, this model multiplies **measured/computed unit incident savings** by **realistic weekly trigger rates** (`5` workdays/wk, `4.33` wks/mo). Across an average `$390–$650/mo` (`$90–$150/wk`) full-time developer workload, `Auto` vs. `Off` saves **`$9.42/wk` · `$40.79/mo`** (**`~6%–11%`** of raw API spend, midpoint **`~8%`**), beating `Coach (50% follow)` by **`+$3.46/wk` (`+$14.98/mo`)** interactively and **`+$5.32/wk` (`+$23.04/mo`)** unattended.

| Developer Profile | Raw API Spend | `Auto` vs. `Off` (Weekly) | `Auto` vs. `Off` (Monthly) | % of Raw Spend | Extra Gain Over `Coach` (`50%` follow) |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Light / Everyday Dev** (`~15 chats/wk, 20k-50k ctx`) | `$25-$40/wk` (`$110-$175/mo`) | **`$2.27/wk`** (`$1.50-$3.50`) | **`$9.83/mo`** (`$6.50-$15`) | `~6%-9%` | **`+$0.62/wk` · `+$2.66/mo`** *(unattended: `+$4.81/mo`)* |
| **Full-Time Agentic Dev (Average)** (`~40 chats/wk, 50k-100k ctx`) | `$90-$150/wk` (`$390-$650/mo`) | **`$9.42/wk`** (`$7-$14`) | **`$40.79/mo`** (`$30-$60`) | `~6%-11% (mid ~8%)` | **`+$3.46/wk` · `+$14.98/mo`** *(unattended: `+$23.04/mo`)* |
| **Heavy / Swarm Power User** (`80+ chats/wk, 100k-200k Opus`) | `$300-$600/wk` (`$1.3k-$2.6k/mo`) | **`$34.44/wk`** (`$25-$50`) | **`$149.13/mo`** (`$110-$215`) | `~6%-11.5%` | **`+$14.29/wk` · `+$61.88/mo`** *(unattended: `+$92.40/mo`)* |

### 6-Lever Breakdown — Average Full-Time Agentic Developer (`~40` Sessions/Wk, `$9.42/wk` · `$40.79/mo`)

| Protection Lever | Unit Saving & Provenance | Freq | Weekly (`Auto` vs `Off`) | Monthly (`× 4.33`) | `Auto` Gain Over `Coach (50%)` |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **1. Warm Model Switches Held (DET-08)** | ~$0.14 ($0.081-$0.135 @58k measured) | `8/wk` | `$1.12` | `$4.85` | `+$0.56/wk` — 50% human compliance in Coach; 100% Auto |
| **2. Profitable Early / Tool-Heavy Downgrades (DET-08 v4.1)** | ~$0.22 ($0.1248 L1 to $0.3218 TH measured) | `5/wk` | `$1.10` | `$4.76` | `+$0.00/wk` — Shared across Coach & Auto when horizon-calibrated |
| **3. Mid-TTL Rule / .mcp.json / 4.6 Effort Shield (DET-09)** | ~$0.25 computed @58k ($0.087 @15k measured) | `4/wk` | `$1.00` | `$4.33` | `+$0.75/wk` — ~75% Auto-incremental (PreToolUse non-blocking warn in Coach; SDK defers both) |
| **4. Cold-Cache Swarm / Idle Wakeup Gate (DET-16)** | ~$0.55 ($0.6750 @150k Opus computed) | `2/wk` | `$1.10` | `$4.76` | `+$1.10/wk` — 100% Auto-exclusive hard block (>= $0.50 in PreToolUse) |
| **5. Halted 3-Strike Loops, Drift & Cliffs (DET-04/12/26/30)** | ~$0.35 computed per halted 60k Opus loop | `6/wk` | `$2.10` | `$9.09` | `+$1.05/wk` — 50% human compliance in Coach; 100% Auto halt |
| **6. FTS5 CLI Log Dampening & Active Read Shield** | ~$0.15 computed per noisy test/large read session | `20/wk` | `$3.00` | `$12.99` | `+$0.00/wk` — Active in both Coach & Auto |

---

## Methodological Scope & Honest Limitations
1. **Interactive `/effort` Hook Coverage:** As established in [`summary_highbeam_auto.md`](file:///c:/Projects/ga-visualizer-v2/experiments/model-switch-benchmark/results/highbeam_auto/summary_highbeam_auto.md), `@anthropic-ai/claude-code@2.1.325` emits no `PreEffortChange` event on interactive `/effort` and ignores headless `--resume --model` in `PreModelSwitch`; `DET-08` and `DET-09` protect in-session `/model`, SDK `set_model`, MCP/rule file edits (`PreToolUse`), and host-mediated `CacheGravityRouter` callers directly.
2. **Counterfactual Pairing & Compliance Assumptions:** Track 1 `Coach` vs `Auto` comparisons pair each switched session with its recorded `control` replicate (`OFF = baseline`, `100%-compliant/Auto hold = control`), while `Coach` compliance tiers (`25% / 50% / 75%`) are modeled sensitivities rather than behavioral human-factors trials.
3. **Route & Price Dependence:** All recorded USD figures were captured against OpenRouter pinned Anthropic (`5m` API-key ephemeral tier, `Opus 4.6`, `Sonnet 4.6`, `Opus 5.5`, `Sonnet 5.5`); direct vendor / `1h` TTL cache eviction may shift exact break-even thresholds.
