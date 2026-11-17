# Highbeam `runPreModelSwitchHook()` Shadow Check (`$0` Audit)

**Status:** Diagnostic only — **no changes merged** into `src/` or `hooks/`.

## 1. Why `runPreModelSwitchHook()` Returned `deny` on 8/8 Runs While `SWITCH` Beat `OPUS` on 7/8

1. **Yes — `6,902` tokens IS the legacy single-turn (1-request, `rule_v1`) `C*` threshold that should not gate multi-request agentic switches:**
   - At Claude 5.5 rates (`Opus 5.5`: `$0.20/M` read, `$5.00/M` write, `$20/M` output; `Sonnet 5.5`: `$2.50/M` write, `$10/M` output), `computeBreakEvenCachedTokens()` in `src/core-isomorphic/coach/cacheGravityRouter.mjs:529-544` computes:
     `C* = Math.round(((1500 * (20 - 10)) + (350 * (5.0 - 2.5))) / (2.5 - 0.2)) = Math.round(15875 / 2.3) = 6,902 tokens`.
   - Because Claude Code `2.1.325` sends `>10k` baseline `tools + system` tokens on Turn 1 alone (`15,860–25,755` prompt tokens by the end of Turn 1), `cachedTokens > 6,902` was **trivially true on 8/8 runs**.
2. **Why `rule_v1` fired instead of `rule_v2` (and why our shadow call starved `liveState`):**
   - `DEFAULT_HORIZON_CONFIG` (`src/core-isomorphic/config/horizonConfig.mjs:558`) defaults `useEmpiricalHorizonPrior = false`. Because no explicit `expectedRemainingTurns` or `useEmpiricalHorizonPrior: true` was passed, `cacheGravityRouter.mjs:700-706` fell back to `rule_v1` (`singleTurnShouldHold`).
   - Furthermore, the shadow harness created an isolated empty `homeDir` (`no session calibration`), passed `turnsCompleted: 0` (from `createInitialTelemetryState`), and omitted `apiCallsCompleted` and Turn-1 `outputTokens`, causing `runPreModelSwitchHook()` to resolve `requestsPerTurn = 1` (`default_1.0`), `expectedOutputTokens = 1500` (`default_1500`), `expectedRemainingTurns = null`, and `horizonPriorSource = null`.
3. **Why `SWITCH` actually beat `OPUS` on 7/8 runs despite paying `$0.0586–$0.1069` on Turn 2 Req 1 (Turn 2+probe `$0.0689–$0.2448`):**
   - **Turn 2 is a multi-request coding loop (`2–8` API calls in `SWITCH`, `2–9` in `OPUS`), not `1` request (`R = 1`).** Across Turn 2, switching to Sonnet 5.5 saved money on three terms that `rule_v1` (`1` request, `O = 1500`, `uncachedWriteTokens = 0`) misses:
     1. **Output & thinking tokens across all Turn-2 calls:** `1,893–13,612` measured Turn-2 output tokens (`$10/M` saved vs Opus `$20/M` = `$0.0189–$0.1361`).
     2. **Intra-turn incremental cache writes (file reads / tool outputs / test logs):** `1,831–13,985` new Turn-2 tokens written at `$2.50/M` instead of `$5.00/M` (`$0.0046–$0.0350` saved).
     3. **`(R - 1)` intra-turn warm reads:** reading the growing prefix at `$0.10/M` instead of `$0.20/M`.
   - Only on `T06` — where `SWITCH` needed **`8` Turn-2 requests** (`13,612` out) vs `OPUS`'s **`4` Turn-2 requests** (`6,341` out) — did `SWITCH` Turn 2 cost `+$0.0584` more than `OPUS` Turn 2 (`-$0.0300` lower Plan turn -> net `+$0.0284`).

## 2. Exact Switch-Point Inputs vs. Measured Turn-1/Turn-2 Reality (`Stage 1`, `n = 8`)

| Task | `cachedTokens` (`measured`) | Shadow Inputs (`O` / `R` / `horizon` / `source` / `rule`) | Shadow `C*` / Penalty / Verdict (`computed offline`) | Measured T1 (`reqs`, `out`) | Measured SWITCH T2 (`reqs`, `incWrite`, `out`, `T2+probe`) | Measured OPUS T2 (`reqs`, `out`, `T2`) | Actual Total Delta (`SWITCH - OPUS`, `billed`) |
| :--- | :---: | :--- | :--- | :---: | :---: | :---: | :---: |
| `T01` | 18,334 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0263 / **deny** | 5 req, 4717 out | 3 req, 2,683 w, 2398 out, $0.0837 | 4 req, 3377 out, $0.1117 | **-$0.0154** (SWITCH cheaper) |
| `T02` | 15,860 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0206 / **deny** | 4 req, 4345 out | 2 req, 2,225 w, 2370 out, $0.0752 | 2 req, 2894 out, $0.0853 | **-$0.0083** (SWITCH cheaper) |
| `T03` | 15,896 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0207 / **deny** | 5 req, 4172 out | 2 req, 1,831 w, 1893 out, $0.0689 | 2 req, 3008 out, $0.0894 | **-$0.0287** (SWITCH cheaper) |
| `T04` | 25,524 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0428 / **deny** | 4 req, 4869 out | 6 req, 9,887 w, 9464 out, $0.2025 | 8 req, 8420 out, $0.2746 | **-$0.0839** (SWITCH cheaper) |
| `T05` | 24,822 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0412 / **deny** | 5 req, 6726 out | 7 req, 9,479 w, 7420 out, $0.1777 | 7 req, 7799 out, $0.2498 | **-$0.0708** (SWITCH cheaper) |
| `T06` | 20,924 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0323 / **deny** | 4 req, 6161 out | 8 req, 13,985 w, 13612 out, $0.2448 | 4 req, 6341 out, $0.1863 | **+$0.0284** (OPUS cheaper) |
| `T07` | 25,755 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0434 / **deny** | 5 req, 9075 out | 4 req, 10,078 w, 10225 out, $0.1948 | 6 req, 8474 out, $0.2572 | **-$0.0769** (SWITCH cheaper) |
| `T08` | 19,966 | 1500 (default_1500) / 1 (default_1.0) / null (null) / rule_v1 | 6902 / $0.0300 / **deny** | 4 req, 5623 out | 7 req, 8,317 w, 7133 out, $0.1597 | 9 req, 10118 out, $0.3190 | **-$0.1757** (SWITCH cheaper) |

## 3. Counterfactual Replay: Existing `useEmpiricalHorizonPrior: true` vs. Proposed Multi-Request Fix (`computed offline`)

| Task | Existing `useEmpiricalHorizonPrior: true` + T1 Stats (`rule_v2`) | Proposed Multi-Request Switch-Turn Formula (`expectedRemainingTurnsAfterSwitch = 0`) | Actual `SWITCH` vs `OPUS` Total |
| :--- | :--- | :--- | :---: |
| `T01` | **allow** (R=5, O=4717, H_post=10.4, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0t) | **allow** (R=5, O_turn=4717, netPenalty=-$0.0323) | SWITCH beat OPUS (-$0.0154) |
| `T02` | **allow** (R=4, O=4345, H_post=13.25, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0t) | **allow** (R=4, O_turn=4345, netPenalty=-$0.0274) | SWITCH beat OPUS (-$0.0083) |
| `T03` | **allow** (R=5, O=4172, H_post=10.4, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0t) | **allow** (R=5, O_turn=4172, netPenalty=-$0.0315) | SWITCH beat OPUS (-$0.0287) |
| `T04` | **allow** (R=4, O=4869, H_post=13.25, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0.023t) | **allow** (R=4, O_turn=4869, netPenalty=-$0.0133) | SWITCH beat OPUS (-$0.0839) |
| `T05` | **allow** (R=5, O=6726, H_post=10.4, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0t) | **allow** (R=5, O_turn=6726, netPenalty=-$0.0400) | SWITCH beat OPUS (-$0.0708) |
| `T06` | **allow** (R=4, O=6161, H_post=13.25, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0t) | **allow** (R=4, O_turn=6161, netPenalty=-$0.0354) | OPUS beat SWITCH (+$0.0284) |
| `T07` | **allow** (R=5, O=9075, H_post=10.4, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0t) | **allow** (R=5, O_turn=9075, netPenalty=-$0.0618) | SWITCH beat OPUS (-$0.0769) |
| `T08` | **allow** (R=4, O=5623, H_post=13.25, src=placeholder_antigravity_496_prior, C_max=Infinity, payback=0t) | **allow** (R=4, O_turn=5623, netPenalty=-$0.0320) | SWITCH beat OPUS (-$0.1757) |

## 4. Proposed Fix (NOT Merged — For Review Only)

1. **Enable `useEmpiricalHorizonPrior: true` by default in `src/core-isomorphic/config/horizonConfig.mjs` (`line 558`):** stop defaulting live Claude Code sessions to `rule_v1` single-request `C* = 6,902`.
2. **Retire single-turn `singleTurnShouldHold` (`breakEvenTokens`) from gating `shouldHoldModel` in `src/core-isomorphic/coach/cacheGravityRouter.mjs` (`lines 529-571, 691-706`):**
   - Do not gate `shouldHoldModel` on `cachedTokens > breakEvenTokens` when `hasHorizonTurns` is active (`rule_v2` currently evaluates `singleTurnShouldHold && ...`, AND treats `postSwitchRemainingTurns === 0` with `coldWritePenaltyUSD > 0` as a hold even when intra-turn requests already pay back the cold write).
   - Model **intra-turn** incremental cache writes (`Math.max(0, R - 1) * avgDeltaPerCall * (pWriteCurr - pWriteTarget)`) and **full per-turn output** (`O_turn`, i.e. sum across all `R` requests in the turn, rather than assuming `O = 1500` covers only `1` call) inside `stayOnCurrentModelUSD` vs `switchToTargetModelUSD`, so `coldWritePenaltyUSD` reflects the actual net switch-turn delta.
3. **Populate Turn-1 telemetry into `liveState` & pass Turn-1 `apiCallsCompleted` / `requestsPerTurn` / `current_turn` in hooks** (`hooks/handlers/pre-model-switch.mjs`), so multi-request tool turns are never underestimated as `R = 1.0`.
