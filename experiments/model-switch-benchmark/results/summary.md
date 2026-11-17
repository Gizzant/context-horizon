# Experiment Summary (`summary.md`)

## 1. Setup, Route & Scope Disclosures

- **API Route Disclosure:** All traffic went through **OpenRouter** (`https://openrouter.ai/api/v1/messages` with `"provider": { "only": ["anthropic"], "allow_fallbacks": false }`), not Anthropic directly; **cache behavior and cost may differ on the direct API.**
- **Tool, Models, OS & Date:**
  - **CLI Tool:** `@anthropic-ai/claude-code@2.1.325` (`2.1.325 (Claude Code)`)
  - **Models Tested:** `claude-opus-4-6` (`anthropic/claude-opus-4.6`) and `claude-sonnet-4-6` (`anthropic/claude-sonnet-4.6`)
  - **Effort Settings Tested:** `medium` (baseline) and `high` (`effort_only` Arm D Turns `6–12`)
  - **OS & Runtime:** Windows 11 (`win32 x64`, build `10.0.26200`), Node.js `v25.6.0`
  - **Run Date:** `2026-11-14` (`Batch 1: 05:47:09Z–06:33:11Z`; `Batch 2: 13:56:16Z–14:26:45Z`)
- **Measured Prefix Token Sizes at Turn 6 (Switch Point, Request 1):**
  - **`small` bucket (`n = 30` runs):** Median `total_input_tokens` = **`15171`** `[15095–15437]` tokens (`~8,846` baseline system/tool/repo tokens + `~6,328` file/chat tokens).
  - **`large` bucket (`n = 15` runs):** Median `total_input_tokens` = **`56535`** `[56338–56766]` tokens (`~8,840` baseline system/tool/repo tokens + `~47,695` file/chat tokens).
- **Statistical & Cost Convention:** All summary statistics below report **median `[min–max]`** across `n = 5` replicates per cell (no means are mixed with medians). All main-request costs come directly from OpenRouter’s `usage.cost` field (`0/675` main rows required fallback to computed pricing).
- **Directional Latency Caveat:** Latency measurements (`latency_ms`) are **directional only** because both the localhost logging proxy and OpenRouter sit in the network path.

---

## 2. Per-Arm Results: Turn After Change (`Turn 6`) and Next Two Turns (`Turn 7`, `Turn 8`)

All values below are **median `[min–max]`** across `n = 5` completed runs per cell, computed directly from `runs.csv` (`is_side_call = false`, `source = both`). Turns `6`, `7`, and `8` each have `requests_in_turn = 1`.

### A. Cost (`cost_usd`, USD) — Median `[Min–Max]`

| Prefix Bucket | Arm | `n` | Turn 6 (`cost_usd`) | Turn 7 (`cost_usd`) | Turn 8 (`cost_usd`) | 12-Turn Session Total (`cost_usd`) |
| :--- | :--- | :---: | :--- | :--- | :--- | :--- |
| `small` | `control` | `5` | $0.01363 [$0.01356–$0.01452] | $0.01381 [$0.01360–$0.01444] | $0.01468 [$0.01448–$0.01493] | $0.2699 [$0.2673–$0.2734] |
| `small` | `one_switch` | `5` | $0.06018 [$0.06008–$0.06052] | $0.00923 [$0.00909–$0.00946] | $0.00955 [$0.00922–$0.00964] | $0.2834 [$0.2821–$0.2846] |
| `small` | `switch_and_back` | `5` | $0.06071 [$0.06026–$0.06091] | $0.00929 [$0.00909–$0.00952] | $0.01952 [$0.01911–$0.02034] | $0.3200 [$0.3160–$0.3233] |
| `small` | `effort_only` | `5` | $0.09890 [$0.09821–$0.09920] | $0.01377 [$0.01374–$0.01411] | $0.01464 [$0.01429–$0.01483] | $0.3560 [$0.3508–$0.3572] |
| `small` | `idle_then_switch` | `5` | $0.06032 [$0.05998–$0.06068] | $0.00920 [$0.00908–$0.00934] | $0.00948 [$0.00921–$0.01002] | $0.2835 [$0.2809–$0.2841] |
| `small` | `ten_switches` | `5` | $0.01013 [$0.00990–$0.01017] | $0.01663 [$0.01650–$0.01695] | $0.01088 [$0.01035–$0.01104] | $0.3081 [$0.3043–$0.3110] |
| `large` | `control` | `5` | $0.03775 [$0.03644–$0.03825] | $0.03683 [$0.03583–$0.03766] | $0.03679 [$0.03592–$0.03721] | $0.7789 [$0.7659–$0.7811] |
| `large` | `one_switch` | `5` | $0.21602 [$0.21560–$0.21631] | $0.02269 [$0.02234–$0.02308] | $0.02191 [$0.02171–$0.02277] | $0.8611 [$0.8585–$0.8651] |
| `large` | `ten_switches` | `5` | $0.02439 [$0.02416–$0.02498] | $0.03920 [$0.03874–$0.04018] | $0.02357 [$0.02294–$0.02483] | $0.9130 [$0.9048–$0.9162] |

### B. `cache_read` Share (`cache_read_input_tokens / total_input_tokens`, %) — Median `[Min–Max]`

| Prefix Bucket | Arm | `n` | Turn 6 (`cache_read` %) | Turn 7 (`cache_read` %) | Turn 8 (`cache_read` %) | 12-Turn Session `cache_read` % |
| :--- | :--- | :---: | :--- | :--- | :--- | :--- |
| `small` | `control` | `5` | 97.71% [97.54%–97.72%] | 98.16% [97.95%–98.17%] | 98.15% [98.04%–98.19%] | 91.96% [91.92%–91.97%] |
| `small` | `one_switch` | `5` | 0.00% [0.00%–0.00%] | 97.73% [97.68%–97.84%] | 97.86% [97.79%–97.89%] | 84.93% [84.91%–84.95%] |
| `small` | `switch_and_back` | `5` | 0.00% [0.00%–0.00%] | 97.64% [97.56%–97.72%] | 93.30% [93.03%–93.48%] | 84.59% [84.57%–84.62%] |
| `small` | `effort_only` | `5` | 0.00% [0.00%–0.00%] | 98.13% [98.12%–98.19%] | 98.16% [98.08%–98.16%] | 84.95% [84.94%–84.98%] |
| `small` | `idle_then_switch` | `5` | 0.00% [0.00%–0.00%] | 97.66% [97.61%–97.85%] | 97.87% [97.85%–97.90%] | 84.93% [84.90%–84.96%] |
| `small` | `ten_switches` | `5` | 94.92% [94.85%–95.08%] | 95.18% [94.94%–95.24%] | 95.65% [95.63%–95.80%] | 83.98% [83.93%–84.03%] |
| `large` | `control` | `5` | 99.32% [99.28%–99.33%] | 99.31% [99.27%–99.38%] | 99.39% [99.34%–99.44%] | 91.67% [91.66%–91.70%] |
| `large` | `one_switch` | `5` | 0.00% [0.00%–0.00%] | 99.28% [99.26%–99.30%] | 99.32% [99.28%–99.36%] | 83.74% [83.73%–83.74%] |
| `large` | `ten_switches` | `5` | 98.47% [98.43%–98.56%] | 98.44% [98.39%–98.47%] | 98.55% [98.47%–98.60%] | 83.41% [83.40%–83.45%] |

### C. Directional Latency (`latency_ms`, ms) — Median `[Min–Max]`

| Prefix Bucket | Arm | `n` | Turn 6 (`latency_ms`) | Turn 7 (`latency_ms`) | Turn 8 (`latency_ms`) | 12-Turn Session `latency_ms` |
| :--- | :--- | :---: | :--- | :--- | :--- | :--- |
| `small` | `control` | `5` | 5050.2 ms [4325.4 ms–5897.4 ms] | 5409.2 ms [4575.0 ms–6782.5 ms] | 5447.2 ms [4911.1 ms–5880.3 ms] | 68632.5 ms [65270.6 ms–77127.0 ms] |
| `small` | `one_switch` | `5` | 5648.9 ms [5163.7 ms–6391.5 ms] | 5613.0 ms [4912.8 ms–6373.6 ms] | 6136.2 ms [5784.5 ms–7487.8 ms] | 73496.1 ms [66671.7 ms–82363.2 ms] |
| `small` | `switch_and_back` | `5` | 5750.2 ms [5539.0 ms–6602.7 ms] | 5431.0 ms [5073.9 ms–5750.8 ms] | 6683.1 ms [6002.9 ms–7339.4 ms] | 79204.7 ms [70626.5 ms–86426.8 ms] |
| `small` | `effort_only` | `5` | 4702.8 ms [4474.6 ms–4810.0 ms] | 5226.0 ms [4412.0 ms–5763.0 ms] | 5354.1 ms [5062.4 ms–5817.4 ms] | 67306.1 ms [64605.2 ms–68558.1 ms] |
| `small` | `idle_then_switch` | `5` | 5707.5 ms [5195.9 ms–8512.1 ms] | 5692.0 ms [5463.5 ms–5893.6 ms] | 6047.6 ms [5656.2 ms–6497.8 ms] | 72554.9 ms [70796.3 ms–77550.2 ms] |
| `small` | `ten_switches` | `5` | 4838.1 ms [4652.2 ms–5419.1 ms] | 5467.6 ms [4676.4 ms–6043.9 ms] | 6488.6 ms [5065.5 ms–7993.4 ms] | 73561.4 ms [63331.4 ms–80057.3 ms] |
| `large` | `control` | `5` | 8542.6 ms [7994.6 ms–9473.9 ms] | 8544.8 ms [7782.5 ms–9046.6 ms] | 8472.6 ms [7231.7 ms–9607.9 ms] | 114341.9 ms [109423.5 ms–125983.7 ms] |
| `large` | `one_switch` | `5` | 8174.6 ms [7807.7 ms–8855.5 ms] | 7452.0 ms [6461.6 ms–8638.6 ms] | 7313.1 ms [6661.2 ms–7918.3 ms] | 103597.4 ms [102084.4 ms–109104.3 ms] |
| `large` | `ten_switches` | `5` | 7897.2 ms [7074.1 ms–8869.6 ms] | 8217.0 ms [7329.3 ms–9407.3 ms] | 7050.8 ms [6060.9 ms–8661.0 ms] | 108562.3 ms [103878.4 ms–120461.1 ms] |

---

## 3. Switch Penalty (Arm Minus Control Median on the Same Turn)

Switch penalty is computed per replicate as `arm_value - control_median_value` on the turn immediately following the change (`Turn 6` for Arms `B, C, D, E, F`; plus `Turn 8` for `switch_and_back` `Arm C` when switching back from `Sonnet 4.6` to `Opus 4.6`), reported as **median `[min–max]`**:

| Prefix Bucket | Arm | Change Turn & Transition | Cost Penalty vs. Control (`cost_usd`) | Latency Penalty vs. Control (`latency_ms`, directional) | 12-Turn Cumulative Session Cost Penalty vs. Control |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `small` | `one_switch` | Turn 6 (`Opus -> Sonnet`) | **+$0.04655 [+$0.04645 to +$0.04689]** | +598.8 ms [+113.5 ms to +1341.4 ms] | **+$0.0135 [+$0.0122 to +$0.0146]** |
| `small` | `switch_and_back` | Turn 6 (`Opus -> Sonnet`) | **+$0.04709 [+$0.04663 to +$0.04728]** | +700.0 ms [+488.8 ms to +1552.5 ms] | **+$0.0500 [+$0.0460 to +$0.0533]** |
| `small` | `effort_only` | Turn 6 (`medium -> high` on `Opus`) | **+$0.08527 [+$0.08459 to +$0.08557]** | -347.3 ms [-575.6 ms to -240.2 ms] | **+$0.0861 [+$0.0809 to +$0.0872]** |
| `small` | `idle_then_switch` | Turn 6 (`>=330s idle + Opus -> Sonnet`) | **+$0.04669 [+$0.04635 to +$0.04705]** | +657.3 ms [+145.7 ms to +3462.0 ms] | **+$0.0136 [+$0.0110 to +$0.0141]** |
| `small` | `ten_switches` | Turn 6 (`Switch #5: Opus -> Sonnet`) | **-$0.00350 [-$0.00373 to -$0.00346]** | -212.1 ms [-398.0 ms to +368.9 ms] | **+$0.0382 [+$0.0343 to +$0.0410]** |
| `large` | `one_switch` | Turn 6 (`Opus -> Sonnet`) | **+$0.17827 [+$0.17785 to +$0.17856]** | -368.0 ms [-734.9 ms to +312.9 ms] | **+$0.0822 [+$0.0796 to +$0.0862]** |
| `large` | `ten_switches` | Turn 6 (`Switch #5: Opus -> Sonnet`) | **-$0.01336 [-$0.01358 to -$0.01277]** | -645.4 ms [-1468.5 ms to +327.0 ms] | **+$0.1341 [+$0.1259 to +$0.1373]** |
| `small` | `switch_and_back` | Turn 8 Return (`Sonnet -> Opus`) | **+$0.00485 [+$0.00444 to +$0.00566]** | +1235.9 ms [+555.7 ms to +1892.2 ms] | *(same session as above)* |

### Turn-by-Turn Breakdown for `ten_switches` (`Arm F`, Request 1 of Each Turn)

In `ten_switches` (`Arm F`), the model alternates on every turn from Turn `2` through Turn `11` (`10` switches total) and holds `Opus 4.6` on Turn `12`. (On Turns `1–3`, `request_index_in_turn = 1` is the initial switch request and `request_index_in_turn = 2` is the intra-turn `tool_result` continuation):

| Turn | Model (`Arm F`) | Event (`req 1`) | `small` `cache_read` % (`req 1`) | `small` Cost Penalty vs. Ctrl (`req 1`) | `large` `cache_read` % (`req 1`) | `large` Cost Penalty vs. Ctrl (`req 1`) |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `T1` | `anthropic/claude-opus-4.6` | `message` | 0.0% [0.0%–0.0%] | -$0.00001 [-$0.00001 to +$0.00000] | 0.0% [0.0%–0.0%] | +$0.00000 [-$0.00001 to +$0.00013] |
| `T2` | `anthropic/claude-sonnet-4.6` | `model_switch (#1)` | 0.0% [0.0%–0.0%] | +$0.03282 [+$0.03277 to +$0.03283] | 0.0% [0.0%–0.0%] | +$0.07538 [+$0.07524 to +$0.07550] |
| `T3` | `anthropic/claude-opus-4.6` | `model_switch (#2)` | 81.2% [81.2%–81.2%] | +$0.01299 [+$0.01241 to +$0.01302] | 59.6% [59.5%–59.6%] | +$0.09072 [+$0.09058 to +$0.09085] |
| `T4` | `anthropic/claude-sonnet-4.6` | `model_switch (#3)` | 86.6% [86.6%–86.6%] | +$0.00011 [-$0.00019 to +$0.00032] | 70.5% [70.5%–70.6%] | +$0.04077 [+$0.04009 to +$0.04111] |
| `T5` | `anthropic/claude-opus-4.6` | `model_switch (#4)` | 95.8% [95.7%–96.0%] | +$0.00209 [+$0.00156 to +$0.00272] | 98.6% [98.6%–98.7%] | +$0.00287 [+$0.00224 to +$0.00313] |
| `T6` | `anthropic/claude-sonnet-4.6` | `model_switch (#5)` | 94.9% [94.9%–95.1%] | -$0.00350 [-$0.00373 to -$0.00346] | 98.5% [98.4%–98.6%] | -$0.01336 [-$0.01358 to -$0.01277] |
| `T7` | `anthropic/claude-opus-4.6` | `model_switch (#6)` | 95.2% [94.9%–95.2%] | +$0.00281 [+$0.00268 to +$0.00314] | 98.4% [98.4%–98.5%] | +$0.00237 [+$0.00191 to +$0.00335] |
| `T8` | `anthropic/claude-sonnet-4.6` | `model_switch (#7)` | 95.6% [95.6%–95.8%] | -$0.00380 [-$0.00432 to -$0.00363] | 98.5% [98.5%–98.6%] | -$0.01322 [-$0.01385 to -$0.01196] |
| `T9` | `anthropic/claude-opus-4.6` | `model_switch (#8)` | 95.5% [95.4%–95.7%] | +$0.00264 [+$0.00199 to +$0.00329] | 98.7% [98.5%–98.7%] | +$0.00235 [+$0.00141 to +$0.00321] |
| `T10` | `anthropic/claude-sonnet-4.6` | `model_switch (#9)` | 95.2% [95.1%–95.5%] | -$0.00374 [-$0.00413 to -$0.00355] | 98.6% [98.5%–98.7%] | -$0.01307 [-$0.01404 to -$0.01212] |
| `T11` | `anthropic/claude-opus-4.6` | `model_switch (#10)` | 95.5% [95.3%–95.6%] | +$0.00312 [+$0.00271 to +$0.00454] | 98.6% [98.4%–98.6%] | +$0.00359 [+$0.00151 to +$0.00395] |
| `T12` | `anthropic/claude-opus-4.6` | `message` | 98.2% [98.0%–98.3%] | +$0.00135 [-$0.00004 to +$0.00157] | 99.3% [99.2%–99.4%] | +$0.00001 [-$0.00027 to +$0.00144] |

---

## 4. Direct Answers to the 5 Research Questions (With Row Citations)

### Question 1: Does switching models cause a full cache miss on the next turn? How large is the extra cost?
- **Yes, on the first switch to a model that does not yet have a warm cache in the current session.**
- **Evidence (`small` bucket, `one_switch` Arm B Turn 6 vs. `control` Arm A Turn 6):**
  - Across all `5/5` runs (`B_S_r01` through `B_S_r05`, `turn = 6`, `request_index_in_turn = 1`), `cache_read_input_tokens` was **`0`** `[0–0]` (`0.00%` cache_read share), while `cache_creation_input_tokens` jumped to **`15165`** `[15121–15187]` tokens (e.g., `B_S_r01` `turn=6`: `input_tokens=3`, `cache_creation_input_tokens=15165`, `cache_read_input_tokens=0`, `output_tokens=228`, `cost_usd=0.06029875`).
  - In `control` (`A_S_r01..r05`, `turn = 6`), `cache_read_input_tokens` was **`14822`** `[14772–14856]` (`97.71%` median hit share) at `cost_usd` = **$0.01363 [$0.01356–$0.01452]**.
  - **Extra cost at `small` (`~15.2k` tokens):** **+$0.04655 [+$0.04645 to +$0.04689]** on Turn 6 (`4.42x` Control Turn 6 cost).
- **Evidence (`large` bucket, `one_switch` Arm B Turn 6 vs. `control` Arm A Turn 6):**
  - Across all `5/5` completed runs (`B_L_r01` through `B_L_r05`, `turn = 6`, `request_index_in_turn = 1`), `cache_read_input_tokens` was **`0`** `[0–0]` (`0.00%` cache_read share) and `cache_creation_input_tokens` was **`56404`** `[56335–56431]` tokens (e.g., `B_L_r02` `turn=6`: `input_tokens=3`, `cache_creation_input_tokens=56404`, `cache_read_input_tokens=0`, `output_tokens=300`, `cost_usd=0.216024`).
  - In `control` (`A_L_r01..r05`, `turn = 6`), `cache_read_input_tokens` was **`56136`** `[56021–56180]` (`99.32%` median hit share) at `cost_usd` = **$0.03775 [$0.03644–$0.03825]**.
  - **Extra cost at `large` (`~56.5k` tokens):** **+$0.17827 [+$0.17785 to +$0.17856]** on Turn 6 (**`5.72x`** Control Turn 6 cost, even though `Sonnet 4.6` has a `40%` lower base input price than `Opus 4.6`).

### Question 2: Is the penalty one-time, or does it repeat on later turns?
- **One-time penalty.** Once the new model (`anthropic/claude-sonnet-4.6`) writes its own cache on Turn 6, every subsequent turn on that model hits the new cache.
- **Evidence (`one_switch` Arm B Turns 7 and 8):**
  - **`small` (`B_S_r01..r05`):** On Turn 7, `cache_read_input_tokens` recovered to **`15165`** `[15121–15187]` tokens (**97.73% [97.68%–97.84%]** cache_read share; `cache_creation_input_tokens` = `349` `[332–358]`; `cost_usd` = $0.00923 [$0.00909–$0.00946]). On Turn 8, `cache_read` share was **97.86% [97.79%–97.89%]** (`cost_usd` = $0.00955 [$0.00922–$0.00964]).
  - **`large` (`B_L_r01..r05`):** On Turn 7, `cache_read_input_tokens` recovered to **`56404`** `[56335–56431]` tokens (**99.28% [99.26%–99.30%]** cache_read share; `cache_creation_input_tokens` = `407` `[394–417]`; `cost_usd` = $0.02269 [$0.02234–$0.02308], e.g. `B_L_r02` `turn=7`: `cache_read_input_tokens=56404` matching `turn=6` `cache_creation_input_tokens=56404` token-for-token). On Turn 8, `cache_read` share was **99.32% [99.28%–99.36%]**.

### Question 3: If you switch back to the original model within the cache lifetime, does the original cache hit?
- **Yes.** Switching back to `anthropic/claude-opus-4.6` within the 5-minute TTL hits the original model’s pre-switch cache and writes only the intermediate turns’ conversation delta.
- **Evidence (`switch_and_back` Arm C, `C_S_r01..r05`):**
  - On Turn 5 (last turn on `Opus 4.6` before switching), total input was `14843` `[14775–14869]` tokens (`cache_read_input_tokens` = `14481`, `cache_creation_input_tokens` = `349`).
  - After running Turns 6 and 7 on `Sonnet 4.6` (`~11–15s` elapsed), Turn 8 switched back to `Opus 4.6`: `cache_read_input_tokens` was **`14840`** `[14772–14866]` tokens (**93.30% [93.03%–93.48%]** cache_read share) and `cache_creation_input_tokens` was only **`1062`** `[1030–1110]` tokens for the Turns 6–7 delta (e.g., `C_S_r01` `turn=8`: `cache_read_input_tokens=14815` = `turn=5` `cache_read_input_tokens (14483) + cache_creation_input_tokens (332)`, `cache_creation_input_tokens=1075`, `cost_usd=0.019555`).
  - The same warm-cache return occurs on every switch from Turn `3` through Turn `11` in `ten_switches` (`Arm F`, `F_S_r01..r05` and `F_L_r01..r05`), where both `Opus 4.6` and `Sonnet 4.6` maintain warm caches simultaneously (`98.4%–98.6%` median `cache_read` share on `F_L` Turns `5–11`).

### Question 4: Does changing effort alone reset the cache?
- **In this setup, an effort-only change produced a full cache miss on the next request.**
- **Evidence (`effort_only` Arm D, `D_S_r01..r05`, `anthropic/claude-opus-4.6` throughout, `--effort medium` on Turns `1–5` → `--effort high` on Turns `6–12`):**
  - Across all `5/5` runs on Turn 6 (`D_S_r01..r05`, `turn = 6`, `request_index_in_turn = 1`), `cache_read_input_tokens` dropped to **`0`** `[0–0]` (**`0.00%` `[0.00%–0.00%]`** cache_read share) and `cache_creation_input_tokens` jumped to **`15157`** `[15092–15198]` tokens (e.g., `D_S_r01` `turn=6`: `input_tokens=3`, `cache_creation_input_tokens=15147`, `cache_read_input_tokens=0`, `output_tokens=157`, `cost_usd=0.09860875`).
  - Turn 6 cost jumped to **$0.09890 [$0.09821–$0.09920]** vs. Control Turn 6 **$0.01363 [$0.01356–$0.01452]** (a switch penalty of **+$0.08527 [+$0.08459 to +$0.08557]**, or **`7.26x`** Control Turn 6).
  - On Turn 7 (remaining at `effort = high` on `Opus 4.6`), `cache_read_input_tokens` immediately recovered to **`15157`** `[15092–15198]` tokens (**98.13% [98.12%–98.19%]** cache_read share, `cost_usd` = $0.01377 [$0.01374–$0.01411]).
  - Proxy request fingerprinting (`results/arm_d_wire_diff.json`) confirmed that `tools` and `system` blocks were byte-for-byte identical between Turn 5 and Turn 6 (`toolsIdentical: true`, `systemIdentical: true`); the only request parameter change outside the appended conversation turn was `output_config: { "effort": "medium" } -> { "effort": "high" }`.

### Question 5: Does the penalty grow with prefix size (`small` vs `large`)?
- **Yes.** The Turn 6 model-switch cost penalty grew in direct proportion to prefix token size, and at `large` (`~56.5k` tokens) the single-turn cache rebuild cost exceeded the cumulative 7-turn per-token savings of switching to the cheaper model.
- **Evidence (`one_switch` Arm B vs. `control` Arm A across `small` and `large`):**
  - **Turn 6 prefix size ratio:** `56407 / 15168 = 3.72x` (`56,407` vs. `15,168` median total input tokens).
  - **Turn 6 switch cost penalty:** Increased **`3.83x`**, from **+$0.04655 [+$0.04645 to +$0.04689]** at `small` to **+$0.17827 [+$0.17785 to +$0.17856]** at `large`.
  - **12-turn cumulative session cost impact:** At `small`, `one_switch` cost **$0.2834 [$0.2821–$0.2846]** vs. `control` **$0.2699 [$0.2673–$0.2734]** (**+$0.0135 [+$0.0122 to +$0.0146]**). At `large`, `one_switch` cost **$0.8611 [$0.8585–$0.8651]** vs. `control` **$0.7789 [$0.7659–$0.7811]** (**+$0.0822 [+$0.0796 to +$0.0862]** — switching to the cheaper model increased total session cost by `+10.56%`).

---

## 5. Comparison Against the Three Initial Predictions

1. **Prediction (a): "Full miss on the turn after a model switch, recovering by the next turn."**
   - **Confirmed for single/first switches (`Arm B`, `Arm C` Turn 6, `Arm E` Turn 6, and `Arm F` Turn 2 Request 1):** Every first switch to `Sonnet 4.6` produced `0` `cache_read_input_tokens` (`0.00%` share) and recovered on the next request to `97.71%` (`small`) and `99.31%` (`large`).
   - **Where a naive extrapolated version of (a) fails (`Arm C` Turn 8 and `Arm F` Turns `3–11`):** If you switch *back* to a model that already has a warm cache within the 5-minute TTL, you do **not** get a full miss (`93.31%` hit on `Arm C` Turn 8; `94.86%–98.58%` hit on `Arm F` Turns `5–11`).
2. **Prediction (b): "No cache reset from an effort-only change."**
   - **WRONG (Falsified by the data).** In all `5/5` replicates of `effort_only` (`D_S_r01..r05`, Turn 6), an effort-only change (`medium` to `high` on `anthropic/claude-opus-4.6`) produced a **full cache miss** (`cache_read_input_tokens = 0` `[0–0]`, `cache_creation_input_tokens = 15,157` `[15,147–15,180]`) on the next request in this setup, adding `+$0.08527` `[$0.08458 to +$0.08557]` on Turn 6 (`+$0.0861` `[$0.0809 to +$0.0872]` across the 12-turn session) before recovering to `98.13%` on Turn 7.
3. **Prediction (c): "A larger penalty with the large prefix."**
   - **Confirmed.** The Turn 6 switch cost penalty scaled from `+$0.04655` at `small` (`15,168` median tokens) to `+$0.17827` at `large` (`56,407` median tokens) — a `3.83x` cost penalty increase for a `3.72x` token prefix increase.

---

## 6. Surprising Findings, Anomalies & Design Limitations

1. **Why Control Arm Turns 1–3 Looked Anomalous When Aggregated by CLI Turn (2-Request `Read` Tool Loop):**
   - In Claude Code, Turns `1`, `2`, and `3` invoke the `Read` tool and therefore execute **2 sequential `/v1/messages` API requests** inside a single CLI turn (`requests_in_turn = 2`): Request 1 emits `tool_use` (`Read`), and Request 2 sends `tool_result` (the file lines) and receives the assistant’s explanation.
   - On Turn 1 Request 1 (`request_index_in_turn = 1`), `cache_read_input_tokens = 0` (`0.00%` hit) and `cache_creation_input_tokens = 8,846` (`small`) / `8,840` (`large`). Seconds later on Turn 1 Request 2 (`request_index_in_turn = 2`), Claude Code sends the file content and **immediately reads back Request 1’s `8,846` / `8,840` cached tokens** while writing the new file tokens (`1,704` on `small`, `14,860` on `large`).
   - If Request 1 and Request 2 are summed into a single row for Turn 1, Turn 1 appears to have `8,846` cache reads out of `19,400` summed input tokens (`45.6%` cache hit on Turn 1!) and Turn 1–3 summed input tokens (`19.4k -> 23.4k -> 25.5k`) appear to drop on Turn 4 (`14.5k`, the first 1-request Q&A turn). Splitting `runs.csv` to one row per API request with `request_index_in_turn` and `requests_in_turn` resolves this completely:

| Control Run ID | Bucket | Turn 1 Request 1 `cache_read` | Turn 1 Request 2 (`last`) Total Input | Turn 2 Request 1 (`first`) `cache_read` | Ratio (`T2_first_cache_read / T1_last_total_input`) |
| :--- | :--- | :---: | :---: | :---: | :---: |
| `A_L_r01` | `large` | `0` | `23702` | `23701` | **`0.999958` (`100.00%`)** |
| `A_L_r02` | `large` | `0` | `23702` | `23701` | **`0.999958` (`100.00%`)** |
| `A_L_r03` | `large` | `0` | `23700` | `23699` | **`0.999958` (`100.00%`)** |
| `A_L_r04` | `large` | `0` | `23701` | `23700` | **`0.999958` (`100.00%`)** |
| `A_L_r05` | `large` | `0` | `23700` | `23699` | **`0.999958` (`100.00%`)** |
| `A_S_r01` | `small` | `0` | `10553` | `10552` | **`0.999905` (`99.99%`)** |
| `A_S_r02` | `small` | `0` | `10551` | `10550` | **`0.999905` (`99.99%`)** |
| `A_S_r03` | `small` | `0` | `10550` | `10549` | **`0.999905` (`99.99%`)** |
| `A_S_r04` | `small` | `0` | `10550` | `10549` | **`0.999905` (`99.99%`)** |
| `A_S_r05` | `small` | `0` | `10551` | `10550` | **`0.999905` (`99.99%`)** |

2. **Intra-Turn Cache Recovery on `ten_switches` (`Arm F`) Turn 2:**
   - Because Turn 2 is a 2-request `Read` turn, when `Arm F` switches from `Opus 4.6` (Turn 1) to `Sonnet 4.6` on Turn 2, `request_index_in_turn = 1` experiences a **full cache miss** (`cache_read_input_tokens = 0` `[0–0]` across all `5` `small` and `5` `large` runs), writing `10,860` (`small`) / `24,049` (`large`) tokens to Sonnet’s cache. Then `~3` seconds later, `request_index_in_turn = 2` inside Turn 2 hits that newly created Sonnet cache (`cache_read_input_tokens = 10,860` `small` / `24,049` `large`).
3. **`Arm E` (`idle_then_switch`) Confound Limitation:**
   - `Arm E` waited `348.74s–439.04s` (median `394.54s`, past the `300s` TTL) before Turn 6 **and** switched from `Opus 4.6` to `Sonnet 4.6` at Turn 6 (`cache_read_input_tokens = 0` `[0–0]`, `cost_usd = $0.06032` `[$0.05998–$0.06068]`, identical to `one_switch` `Arm B` at `$0.06018` `[$0.06008–$0.06051]`). Because `Arm E` changed both idle duration and model simultaneously, it cannot isolate TTL expiry from model switching. An additional `10`-run `idle_only` arm (idle gap with no model switch at both prefix sizes) was skipped because `~$7.30` of additional Opus runs would have exceeded the `$30.00` experiment budget cap (`$25.55` spent).
4. **Directional Latency on `large` Turn 6 (`latency_ms` vs. Prefill `ttfb_ms`):**
   - On `large` Turn 6, `one_switch` (`B_L`) had a slightly lower median end-to-end `latency_ms` than `control` (`A_L`) (**8174.6 ms [7807.7 ms–8855.5 ms]** vs. **8542.6 ms [7994.6 ms–9473.9 ms]**, penalty **-368.0 ms [-734.9 ms to +312.9 ms]**) even though `B_L` wrote `56,404` uncached prefix tokens. Inspection of proxy time-to-first-byte (`ttfb_ms` in `notes`) shows that cold-cache prefill on `B_L` Turn 6 was slower (2124.9 ms [1964.9 ms–2732.3 ms] vs. Control 1796.6 ms [1679.6 ms–2011.3 ms], and vs. warm Sonnet on `B_L` Turn 7 at 1280.9 ms [1099.8 ms–2016.0 ms]), but `Sonnet 4.6` streamed its `~302` output tokens faster than `Opus 4.6` streamed its `~285` output tokens.
5. **Aborted First Attempt of `B_L_r01` (`B_L_r01_aborted_attempt1`):**
   - Documented in `manifest.md` Section 8 and included as `10` flagged rows at the end of `runs.csv` (`source = cli_log_recovered`).
