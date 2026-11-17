# Cost per Completed Task (routine tasks): Opus vs. Sonnet vs. Opus-then-Sonnet (`summary_cost_per_task.md`)

## 1. Limitations

- **Study Tier & Sample Size:** `routine tasks` — `n = 1` repetitions per task-arm across `8` tasks (`24` total runs). Paired comparisons count task medians across `8` tasks; small effects cannot be reliably separated from variance at this sample size.
- **Turn-1 Plan Mode (Option A):** Per study design, Turn 1 runs in read-only `--permission-mode plan` across every arm, and Turn 2+ switches to `bypassPermissions` (with `SWITCH` changing `claude-opus-5-5 -> claude-sonnet-5-5` via `set_model` before Turn 2 on 100% of runs). Results reflect plan-on-Opus-then-implement-on-Sonnet rather than retry-only switching.
- **Routing & Synthetic Repo:** Requests ran through OpenRouter (`provider: { only: ["anthropic"], allow_fallbacks: false }`) against a synthetic 16-file zero-dependency Node.js repository (`ledgerpulse`). Cache behavior and pricing on direct first-party APIs or larger production codebases may differ.
- **Cache Isolation:** Same-model runs were spaced `>= 365s` apart (plus per-run `--append-system-prompt` salt) because `tools + system[0..1]` precedes the appended salt in Claude Code `2.1.325`.

## 2. Per-Task Completion & Cost to Completion — routine tasks (Section 7.1)

*(All USD figures are `billed` per OpenRouter `usage.cost` when returned, else `computed` from rate card; Plan turn T1 is reported on its own row in every section.)*

| Task / Phase | Difficulty | OPUS Completion | OPUS Cost (billed) | SONNET Completion | SONNET Cost (billed) | SWITCH Completion | SWITCH Cost (billed) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `T01` — Plan turn (T1) | easy | — | $0.1836 [$0.1836–$0.1836] | — | $0.0674 [$0.0674–$0.0674] | — | $0.1962 [$0.1962–$0.1962] |
| `T01` — Impl & retries (T2+) | easy | — | $0.1117 [$0.1117–$0.1117] | — | $0.0312 [$0.0312–$0.0312] | — | $0.0837 [$0.0837–$0.0837] |
| `T01` — Total | easy | 1/1 | $0.2953 [$0.2953–$0.2953] | 1/1 | $0.0986 [$0.0986–$0.0986] | 1/1 | $0.2799 [$0.2799–$0.2799] |
| `T02` — Plan turn (T1) | easy | — | $0.1711 [$0.1711–$0.1711] | — | $0.0665 [$0.0665–$0.0665] | — | $0.1729 [$0.1729–$0.1729] |
| `T02` — Impl & retries (T2+) | easy | — | $0.0853 [$0.0853–$0.0853] | — | $0.0359 [$0.0359–$0.0359] | — | $0.0752 [$0.0752–$0.0752] |
| `T02` — Total | easy | 1/1 | $0.2564 [$0.2564–$0.2564] | 1/1 | $0.1024 [$0.1024–$0.1024] | 1/1 | $0.2482 [$0.2482–$0.2482] |
| `T03` — Plan turn (T1) | easy | — | $0.1802 [$0.1802–$0.1802] | — | $0.0804 [$0.0804–$0.0804] | — | $0.1720 [$0.1720–$0.1720] |
| `T03` — Impl & retries (T2+) | easy | — | $0.0894 [$0.0894–$0.0894] | — | $0.0328 [$0.0328–$0.0328] | — | $0.0689 [$0.0689–$0.0689] |
| `T03` — Total | easy | 1/1 | $0.2696 [$0.2696–$0.2696] | 1/1 | $0.1132 [$0.1132–$0.1132] | 1/1 | $0.2409 [$0.2409–$0.2409] |
| `T04` — Plan turn (T1) | medium | — | $0.2469 [$0.2469–$0.2469] | — | $0.0702 [$0.0702–$0.0702] | — | $0.2352 [$0.2352–$0.2352] |
| `T04` — Impl & retries (T2+) | medium | — | $0.2746 [$0.2746–$0.2746] | — | $0.0770 [$0.0770–$0.0770] | — | $0.2025 [$0.2025–$0.2025] |
| `T04` — Total | medium | 1/1 | $0.5216 [$0.5216–$0.5216] | 1/1 | $0.1471 [$0.1471–$0.1471] | 1/1 | $0.4377 [$0.4377–$0.4377] |
| `T05` — Plan turn (T1) | medium | — | $0.2693 [$0.2693–$0.2693] | — | $0.0716 [$0.0716–$0.0716] | — | $0.2706 [$0.2706–$0.2706] |
| `T05` — Impl & retries (T2+) | medium | — | $0.2498 [$0.2498–$0.2498] | — | $0.0595 [$0.0595–$0.0595] | — | $0.1777 [$0.1777–$0.1777] |
| `T05` — Total | medium | 1/1 | $0.5191 [$0.5191–$0.5191] | 1/1 | $0.1311 [$0.1311–$0.1311] | 1/1 | $0.4483 [$0.4483–$0.4483] |
| `T06` — Plan turn (T1) | medium | — | $0.2654 [$0.2654–$0.2654] | — | $0.0615 [$0.0615–$0.0615] | — | $0.2354 [$0.2354–$0.2354] |
| `T06` — Impl & retries (T2+) | medium | — | $0.1863 [$0.1863–$0.1863] | — | $0.0470 [$0.0470–$0.0470] | — | $0.2448 [$0.2448–$0.2448] |
| `T06` — Total | medium | 1/1 | $0.4518 [$0.4518–$0.4518] | 1/1 | $0.1086 [$0.1086–$0.1086] | 1/1 | $0.4802 [$0.4802–$0.4802] |
| `T07` — Plan turn (T1) | hard | — | $0.3362 [$0.3362–$0.3362] | — | $0.0981 [$0.0981–$0.0981] | — | $0.3217 [$0.3217–$0.3217] |
| `T07` — Impl & retries (T2+) | hard | — | $0.2572 [$0.2572–$0.2572] | — | $0.0842 [$0.0842–$0.0842] | — | $0.1948 [$0.1948–$0.1948] |
| `T07` — Total | hard | 1/1 | $0.5934 [$0.5934–$0.5934] | 1/1 | $0.1823 [$0.1823–$0.1823] | 1/1 | $0.5165 [$0.5165–$0.5165] |
| `T08` — Plan turn (T1) | hard | — | $0.2364 [$0.2364–$0.2364] | — | $0.0638 [$0.0638–$0.0638] | — | $0.2200 [$0.2200–$0.2200] |
| `T08` — Impl & retries (T2+) | hard | — | $0.3190 [$0.3190–$0.3190] | — | $0.1119 [$0.1119–$0.1119] | — | $0.1597 [$0.1597–$0.1597] |
| `T08` — Total | hard | 1/1 | $0.5554 [$0.5554–$0.5554] | 1/1 | $0.1757 [$0.1757–$0.1757] | 1/1 | $0.3796 [$0.3796–$0.3796] |
| **All routine tasks — Plan turn (T1)** | all | — | $0.2417 [$0.1711–$0.3362] | — | $0.0688 [$0.0615–$0.0981] | — | $0.2276 [$0.1720–$0.3217] |
| **All routine tasks — Total** | all | 8/8 | $0.4854 [$0.2564–$0.5934] | 8/8 | $0.1221 [$0.0986–$0.1823] | 8/8 | $0.4087 [$0.2409–$0.5165] |

## 3. Headline Metric: Cost per Completed Task by Arm — routine tasks (Section 7.2 & Plan Turn Row)

| Arm / Phase | Runs (`n`) | Completions | Completion Rate (`measured`) | Spend (`billed`) | Cost / Completed Task (`computed = spend / completions`) | Capped Runs Breakdown (`measured`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `OPUS` — Plan turn (T1) | 8 | — | — | $1.8893 | $0.2362 | — |
| `OPUS` — Impl & retries (T2+) | 8 | — | — | $1.5734 | $0.1967 | — |
| **`OPUS` — Total** | 8 | 8/8 | 100.0% | **$3.4626** | **$0.4328** | none |
| `SONNET` — Plan turn (T1) | 8 | — | — | $0.5795 | $0.0724 | — |
| `SONNET` — Impl & retries (T2+) | 8 | — | — | $0.4794 | $0.0599 | — |
| **`SONNET` — Total** | 8 | 8/8 | 100.0% | **$1.0589** | **$0.1324** | none |
| `SWITCH` — Plan turn (T1) | 8 | — | — | $1.8240 | $0.2280 | — |
| `SWITCH` — Impl & retries (T2+) | 8 | — | — | $1.2073 | $0.1509 | — |
| **`SWITCH` — Total** | 8 | 8/8 | 100.0% | **$3.0313** | **$0.3789** | none |

## 4. Attempts, Harness Turns & Plan-Turn Cost by Arm and Difficulty — routine tasks (Section 7.3)

| Arm / Phase | Difficulty | `n` | Completions | Attempts Median [min–max] (`measured`) | Turns Median [min–max] (`measured`) | Cost Median [min–max] (`billed`) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `OPUS` — Plan turn (T1) | easy | 3 | — | — | 1.0 [1.0–1.0] | $0.1802 [$0.1711–$0.1836] |
| `OPUS` — Impl & retries (T2+) | easy | 3 | — | — | 1.0 [1.0–1.0] | $0.0894 [$0.0853–$0.1117] |
| **`OPUS` — Total** | easy | 3 | 3/3 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.2696 [$0.2564–$0.2953] |
| `OPUS` — Plan turn (T1) | hard | 2 | — | — | 1.0 [1.0–1.0] | $0.2863 [$0.2364–$0.3362] |
| `OPUS` — Impl & retries (T2+) | hard | 2 | — | — | 1.0 [1.0–1.0] | $0.2881 [$0.2572–$0.3190] |
| **`OPUS` — Total** | hard | 2 | 2/2 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.5744 [$0.5554–$0.5934] |
| `OPUS` — Plan turn (T1) | medium | 3 | — | — | 1.0 [1.0–1.0] | $0.2654 [$0.2469–$0.2693] |
| `OPUS` — Impl & retries (T2+) | medium | 3 | — | — | 1.0 [1.0–1.0] | $0.2498 [$0.1863–$0.2746] |
| **`OPUS` — Total** | medium | 3 | 3/3 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.5191 [$0.4518–$0.5216] |
| `OPUS` — Plan turn (T1) | all | 8 | — | — | 1.0 [1.0–1.0] | $0.2417 [$0.1711–$0.3362] |
| `OPUS` — Impl & retries (T2+) | all | 8 | — | — | 1.0 [1.0–1.0] | $0.2181 [$0.0853–$0.3190] |
| **`OPUS` — Total** | all | 8 | 8/8 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.4854 [$0.2564–$0.5934] |
| `SONNET` — Plan turn (T1) | easy | 3 | — | — | 1.0 [1.0–1.0] | $0.0674 [$0.0665–$0.0804] |
| `SONNET` — Impl & retries (T2+) | easy | 3 | — | — | 1.0 [1.0–1.0] | $0.0328 [$0.0312–$0.0359] |
| **`SONNET` — Total** | easy | 3 | 3/3 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.1024 [$0.0986–$0.1132] |
| `SONNET` — Plan turn (T1) | hard | 2 | — | — | 1.0 [1.0–1.0] | $0.0809 [$0.0638–$0.0981] |
| `SONNET` — Impl & retries (T2+) | hard | 2 | — | — | 1.0 [1.0–1.0] | $0.0980 [$0.0842–$0.1119] |
| **`SONNET` — Total** | hard | 2 | 2/2 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.1790 [$0.1757–$0.1823] |
| `SONNET` — Plan turn (T1) | medium | 3 | — | — | 1.0 [1.0–1.0] | $0.0702 [$0.0615–$0.0716] |
| `SONNET` — Impl & retries (T2+) | medium | 3 | — | — | 1.0 [1.0–1.0] | $0.0595 [$0.0470–$0.0770] |
| **`SONNET` — Total** | medium | 3 | 3/3 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.1311 [$0.1086–$0.1471] |
| `SONNET` — Plan turn (T1) | all | 8 | — | — | 1.0 [1.0–1.0] | $0.0688 [$0.0615–$0.0981] |
| `SONNET` — Impl & retries (T2+) | all | 8 | — | — | 1.0 [1.0–1.0] | $0.0533 [$0.0312–$0.1119] |
| **`SONNET` — Total** | all | 8 | 8/8 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.1221 [$0.0986–$0.1823] |
| `SWITCH` — Plan turn (T1) | easy | 3 | — | — | 1.0 [1.0–1.0] | $0.1729 [$0.1720–$0.1962] |
| `SWITCH` — Impl & retries (T2+) | easy | 3 | — | — | 1.0 [1.0–1.0] | $0.0752 [$0.0689–$0.0837] |
| **`SWITCH` — Total** | easy | 3 | 3/3 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.2482 [$0.2409–$0.2799] |
| `SWITCH` — Plan turn (T1) | hard | 2 | — | — | 1.0 [1.0–1.0] | $0.2708 [$0.2200–$0.3217] |
| `SWITCH` — Impl & retries (T2+) | hard | 2 | — | — | 1.0 [1.0–1.0] | $0.1772 [$0.1597–$0.1948] |
| **`SWITCH` — Total** | hard | 2 | 2/2 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.4481 [$0.3796–$0.5165] |
| `SWITCH` — Plan turn (T1) | medium | 3 | — | — | 1.0 [1.0–1.0] | $0.2354 [$0.2352–$0.2706] |
| `SWITCH` — Impl & retries (T2+) | medium | 3 | — | — | 1.0 [1.0–1.0] | $0.2025 [$0.1777–$0.2448] |
| **`SWITCH` — Total** | medium | 3 | 3/3 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.4483 [$0.4377–$0.4802] |
| `SWITCH` — Plan turn (T1) | all | 8 | — | — | 1.0 [1.0–1.0] | $0.2276 [$0.1720–$0.3217] |
| `SWITCH` — Impl & retries (T2+) | all | 8 | — | — | 1.0 [1.0–1.0] | $0.1687 [$0.0689–$0.2448] |
| **`SWITCH` — Total** | all | 8 | 8/8 | 1.0 [1.0–1.0] | 2.0 [2.0–2.0] | $0.4087 [$0.2409–$0.5165] |

## 5. Paired Task-Level Cost Comparisons — routine tasks (Section 7.4)

Counts across the `8` tasks where Arm A had a lower median cost than Arm B (`n` is small; Plan turn T1 is reported on its own row alongside completed-only and penalized total cost):

| Comparison (`A vs B`) & Phase | Completed-Only Medians (`A cheaper / B cheaper / tied or NA`) | Failure-Penalized Medians (`A cheaper / B cheaper / tied`) |
| :--- | :---: | :---: |
| `SONNET` vs `OPUS` — Plan turn (T1) | 8 / 0 / 0 | 8 / 0 / 0 |
| **`SONNET` vs `OPUS` — Total** | 8 / 0 / 0 | 8 / 0 / 0 |
| `SWITCH` vs `OPUS` — Plan turn (T1) | 5 / 3 / 0 | 5 / 3 / 0 |
| **`SWITCH` vs `OPUS` — Total** | 7 / 1 / 0 | 7 / 1 / 0 |
| `SWITCH` vs `SONNET` — Plan turn (T1) | 0 / 8 / 0 | 0 / 8 / 0 |
| **`SWITCH` vs `SONNET` — Total** | 0 / 8 / 0 | 0 / 8 / 0 |

## 6. SWITCH Penalty, Payback & Offline `PreModelSwitch` Shadow Comparison — routine tasks (Section 7.5)

- **Switch-turn (Turn 2 Req 1 + probe) cost median [min–max] (`billed`):** $0.0769 [$0.0586–$0.1069]
- **Note on shadow evaluation:** Offline `runPreModelSwitchHook()` verdicts below are **`computed offline; not shown to the model`** (`settings.json` used `"hooks": {}`). Actual switch payoff compares each `SWITCH` run total `billed` cost against the same `(task_id, rep)` `OPUS` run (both completed).

| Arm / Phase | Summary Metric (`billed`) |
| :--- | :---: |
| `OPUS` — Plan turn (T1) median [min–max] | $0.2417 [$0.1711–$0.3362] |
| `OPUS` — Total median [min–max] | $0.4854 [$0.2564–$0.5934] |
| `SONNET` — Plan turn (T1) median [min–max] | $0.0688 [$0.0615–$0.0981] |
| `SONNET` — Total median [min–max] | $0.1221 [$0.0986–$0.1823] |
| `SWITCH` — Plan turn (T1) median [min–max] | $0.2276 [$0.1720–$0.3217] |
| `SWITCH` — Total median [min–max] | $0.4087 [$0.2409–$0.5165] |

| Run ID | Task | Shadow Decision (`computed offline; not shown to the model`) | Shadow Blocked | Shadow Cold Penalty (`computed`) | Switch T2 Cost (`billed`) | SWITCH Plan T1 / Total (`billed`) | Paired OPUS Plan T1 / Total (`billed`) | Actual Paid Back vs Paired OPUS? (`computed`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `T01_SWITCH_r01` | `T01` | deny | true | $0.0263 | $0.0649 | $0.1962 / yes $0.2799 | $0.1836 / yes $0.2953 | yes |
| `T02_SWITCH_r01` | `T02` | deny | true | $0.0206 | $0.0628 | $0.1729 / yes $0.2482 | $0.1711 / yes $0.2564 | yes |
| `T03_SWITCH_r01` | `T03` | deny | true | $0.0207 | $0.0586 | $0.1720 / yes $0.2409 | $0.1802 / yes $0.2696 | yes |
| `T04_SWITCH_r01` | `T04` | deny | true | $0.0428 | $0.0712 | $0.2352 / yes $0.4377 | $0.2469 / yes $0.5216 | yes |
| `T05_SWITCH_r01` | `T05` | deny | true | $0.0412 | $0.0826 | $0.2706 / yes $0.4483 | $0.2693 / yes $0.5191 | yes |
| `T06_SWITCH_r01` | `T06` | deny | true | $0.0323 | $0.0959 | $0.2354 / yes $0.4802 | $0.2654 / yes $0.4518 | no |
| `T07_SWITCH_r01` | `T07` | deny | true | $0.0434 | $0.1069 | $0.3217 / yes $0.5165 | $0.3362 / yes $0.5934 | yes |
| `T08_SWITCH_r01` | `T08` | deny | true | $0.0300 | $0.0840 | $0.2200 / yes $0.3796 | $0.2364 / yes $0.5554 | yes |

## 7. Pre-Registered Predictions vs. Results for Q1–Q4 (Section 7.6)

- **Q1 Prediction:** Per completed task, SONNET is lowest-cost on easy and most medium tasks (~45-55% lower token price than OPUS), while OPUS has a higher completion rate on hard tasks (T07 DST windows, T08 parser escaping + async mutex rollback).
- **Q2 Prediction:** SONNET needs more retry attempts on medium/hard tasks (predicted +0.5 to +1.5 retries on hard tasks), partially narrowing its 2x price advantage, though its lower per-token rate keeps total spend/completion below OPUS on easy/medium unless hard-task failures dominate.
- **Q3 Prediction:** Under Option A (Opus Turn-1 plan -> Sonnet Turn-2+ implement), SWITCH incurs a Turn-2 cold-write penalty (25x write/read ratio on Claude 5.5) on a ~15k-25k Turn-1 context (~$0.04-$0.06 surcharge). On easy 1-shot Turn-2 tasks, SWITCH likely costs MORE than SONNET and pays back only partially vs OPUS unless Opus-grade Turn-1 diagnosis cuts Sonnet retries on medium/hard tasks.
- **Q4 Prediction:** Capping failures (retry_cap or turn_request_cap) will occur predominantly on hard tasks (T07/T08), highest on SONNET (1-3 capped runs), lowest on OPUS (0-1), and intermediate on SWITCH (0-2).

## 8. OpenRouter `/api/v1/key` Reconciliation

| Stage | Runs | Key Usage Before (`billed`) | Settled Key Usage After (`billed`) | Settled Key Delta (`billed`) | Summed Run Billed (`billed`) | Residual (`computed`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| stage1 | 24 | $93.516130 | $101.068949 | $7.552819 | $7.552819 | $0.000000 |
