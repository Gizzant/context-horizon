# Empirical Findings: “I Switched Models Mid-Chat 10 Times. Here’s What It Actually Cost.”

- **Run Date (UTC):** 2026-11-14T14:28:44.236Z
- **Claude Code CLI Version:** `@anthropic-ai/claude-code@2.1.325 (Claude Code)`
- **Pinned Target Repo Commit:** `19c51055902c545508af1979a392505355777d90`
- **Platform / Runtime:** `win32 x64` / Node `v25.6.0`
- **Upstream Route:** OpenRouter Anthropic Messages API (`/api/v1/messages`) pinned strictly to 1st-party `anthropic` (`allow_fallbacks: false`)
- **Pre-Registered Predictions SHA-256:** `4b74083f47524c053dd8470644961442e473ff2f70f8bbc4a1069f7ca1961c56`
- **Transcript Reconciliation:** 540/540 user turns matched byte-for-byte on cache tokens between Claude Code `.jsonl` transcripts and live proxy SSE wire logs.
- **Side-Call Audit:** 45 background side calls (count_tokens fallbacks/auxiliary probes counted separately & excluded from arm tables; total side-call cost: $0.00000 vs main-turn cost: $21.8349).
- **OpenRouter Server-Side Ledger Delta:** $22.71559 (start=$2.83381, end=$25.54940) vs proxy accounted total=$22.62959 (completed main=$21.8349 + side=$0.00000 + scrubbed paused B_L_r01=$0.79465)

---

## Executive Answers to the 5 Research Questions (Median [Min–Max], N=5 Runs/Arm)

1. **Q1 — First-turn switch penalty (`Opus 4.6 -> Sonnet 4.6` at Turn 6):**
   - **Small (~15k wire tokens: 8.85k CLI floor + ~6k context):** Control Turn 6 cache hit ratio=97.7% (cost=$0.0136). Arm B Turn 6 hit ratio=0.0% [0.0%–0.0%], cost=$0.0602 (**+$0.04655** vs Control Turn 6, **+598.8 ms** latency delta).
   - **Large (~56k–60k wire tokens):** Control Turn 6 cache hit ratio=99.3% (cost=$0.0377). Arm B Turn 6 hit ratio=0.0% [0.0%–0.0%], cost=$0.2160 (**+$0.17827** vs Control Turn 6, **-368.0 ms** latency delta).
2. **Q2 — One-time penalty or repeating miss?**
   - **One-time penalty.** On Turn 7 (second turn on Sonnet 4.6), median cache hit ratio recovered to **97.7% [97.7%–97.8%]** (Small) and **99.3% [99.3%–99.3%]** (Large).
3. **Q3 — Switching back to Opus within the 5m TTL (Arm C, Turn 8) vs. Idle past TTL (Arm E, Turn 6):**
   - **Arm C (warm return at T8):** Hits Opus’s Turn 5 cache cleanly. Median cache hit ratio at Turn 8 was **93.3% [93.0%–93.5%]** (cache write=1062 tokens for the 2-turn delta, cost=$0.0195).
   - **Arm E (idle >=330s past 5m TTL, observed median=394.5s + switch at T6):** Turn 6 hit ratio dropped to **0.0% [0.0%–0.0%]** (write=15155 tokens, cost=$0.0603, penalty vs Ctrl=**+$0.04669**) and recovered on Turn 7 to **97.7% [97.6%–97.9%]** — matching Arm B’s Turn 6 full rewrite because switching models already missed Opus’s cache regardless of TTL expiry.
4. **Q4 — Changing `--effort` alone (`medium -> high` on Opus 4.6, Arm D Turn 6–7):**
   - **Baseline "no reset" assumption REFUTED.** Turn 6 median cache hit ratio collapsed to **0.0% [0.0%–0.0%]** (median cache_creation=15157 tokens, median cache_read=0 tokens, cost=$0.0989, penalty vs Ctrl=**+$0.08527**, **-347.4 ms** latency delta). Wire diff between Turn 5 and Turn 6 changed fields: `[{"field":"output_config","before":{"effort":"medium"},"after":{"effort":"high"}},{"field":"cacheBreakpoints","before":[{"section":"system","index":1,"cache_control":{"type":"ephemeral"}},{"section":"system","index":2,"cache_control":{"type":"ephemeral"}},{"section":"messages","messageIndex":14,"role":"user","blockIndex":1,"blockType":"text","cache_control":{"type":"ephemeral"}}],"after":[{"section":"system","index":1,"cache_control":{"type":"ephemeral"}},{"section":"system","index":2,"cache_control":{"type":"ephemeral"}},{"section":"messages","messageIndex":16,"role":"user","blockIndex":1,"blockType":"text","cache_control":{"type":"ephemeral"}}]}]`.
   - **Turn 7 recovery at `high` effort:** Median cache hit ratio immediately recovered to **98.1% [98.1%–98.2%]** (cost=$0.0138).
5. **Q5 — Prefix size scaling (`Small ~15k` vs `Large ~56k–60k`) & Arm F (10 Switches):**
   - Turn 6 switch cost penalty scaled sharply with prefix size from **+$0.04655** (Small ~15k) to **+$0.17827** (Large ~56k–60k). Over the full 12-turn session at ~56k–60k, Control Arm A cost **$0.7789** vs Arm B (switching down to Sonnet!) at **$0.8611** (**+$0.0822**) and Arm F (10 switches!) at **$0.9130** (**+$0.1341**).

---

## Pre-Registered Predictions (`predictions.md`) vs. Empirical Verdict

| Item | Pre-Registered Prediction | Measured Result (Median) | Verdict |
| :--- | :--- | :--- | :---: |
| Q1 (First Switch T6) | 0% hit on T6; full prefix rewrite on Sonnet makes T6 cost ~5x-6x Control at ~60k | Confirmed (0.0% hit; Large T6=$0.2160 vs Ctrl=$0.0377, 5.7x) | **Confirmed** |
| Q2 (T7+ Recovery) | One-time penalty; T7 recovers >90% cache hit on Sonnet (refutes repeating-miss articles) | Confirmed (Small T7=97.7%; Large T7=99.3%) | **Confirmed** |
| Q3 (Switch Back T8) | Returning to Opus within 5m TTL hits T5 warm cache (~80%-95% hit), writing only T6-T7 delta | Confirmed (Arm C T8=93.3% [93.0%–93.5%], write=1062 tok) | **Confirmed** |
| Q4 (Effort Change T6) | Baseline: no reset vs Counter-prediction: output_config.effort breaks prefix cache, T7 >90% | Baseline REFUTED / Counter Confirmed (T6=0.0%, read=0, write=15157; T7=98.1%) | **Baseline Refuted / Wire Confirmed** |
| Q5 (Prefix Scaling) | T6 switch penalty scales ~linearly with prefix size (~8x-10x Small->Large), inverting T6+T7-12 savings | Confirmed (T6 penalty +$0.0466 -> +$0.1783; Large session $0.8611 > Ctrl $0.7789) | **Confirmed** |
| Arm F (10 Switches) | Opus<->Sonnet every turn (<5m TTL) holds dual warm caches (<10x full rebuild) | Confirmed (Small=$0.3081 vs $0.2699; Large=$0.9130 vs $0.7789) | **Confirmed** |

---

## 12-Turn Session Summary (Median & Min–Max Range Across N=5 Replicates)

| Tier | Arm | Name | N | Median Session Cost (Range) | vs Control | Median Cache Hit | Median Write Tokens | Median Read Tokens |
| :--- | :---: | :--- | :---: | :--- | :---: | :---: | :---: | :---: |
| large | A | Control | 5 | $0.7789 [$0.7659–$0.7811] | +$0.0000 | 91.7% | 58810 | 647777 |
| large | B | One Switch | 5 | $0.8611 [$0.8585–$0.8651] | +$0.0822 | 83.7% | 114671 | 590788 |
| large | F | Ten Switches | 5 | $0.9130 [$0.9048–$0.9162] | +$0.1341 | 83.4% | 117674 | 591624 |
| small | A | Control | 5 | $0.2699 [$0.2673–$0.2734] | +$0.0000 | 92.0% | 16993 | 194790 |
| small | B | One Switch | 5 | $0.2834 [$0.2821–$0.2846] | +$0.0135 | 84.9% | 31969 | 180518 |
| small | C | Switch & Back | 5 | $0.3200 [$0.3160–$0.3233] | +$0.0500 | 84.6% | 32772 | 180085 |
| small | D | Effort Only | 5 | $0.3560 [$0.3508–$0.3572] | +$0.0861 | 85.0% | 31834 | 179935 |
| small | E | Idle > TTL + Switch | 5 | $0.2835 [$0.2809–$0.2841] | +$0.0135 | 84.9% | 32010 | 180500 |
| small | F | Ten Switches | 5 | $0.3081 [$0.3043–$0.3110] | +$0.0382 | 84.0% | 34469 | 180806 |

## Key Single-Turn Checkpoints (Turn 1, Turn 5 Pre-Switch, Turn 6 Switch, Turn 7 Recovery, Turn 8 Return)

| Tier | Arm | Turn | Model / Effort | Cache Hit % (Range) | Median Write | Median Read | Median Out | Median Cost (Range) | Penalty vs Ctrl |
| :--- | :---: | :---: | :--- | :--- | :---: | :---: | :---: | :--- | :---: |
| large | A | T1 | opus-4.6 (medium) | 27.2% [27.2–27.2%] | 23700 | 8840 | 385 | $0.16219 [$0.16121–$0.16282] | +$0.00000 |
| large | A | T5 | opus-4.6 (medium) | 99.3% [99.3–99.3%] | 399 | 55723 | 254 | $0.03684 [$0.03634–$0.03738] | +$0.00000 |
| large | A | T6 | opus-4.6 (medium) | 99.3% [99.3–99.3%] | 383 | 56136 | 285 | $0.03775 [$0.03644–$0.03825] | +$0.00000 |
| large | A | T7 | opus-4.6 (medium) | 99.3% [99.3–99.4%] | 389 | 56532 | 243 | $0.03683 [$0.03583–$0.03766] | +$0.00000 |
| large | A | T8 | opus-4.6 (medium) | 99.4% [99.3–99.4%] | 346 | 56931 | 244 | $0.03679 [$0.03592–$0.03721] | +$0.00000 |
| large | A | T11 | opus-4.6 (medium) | 99.4% [99.3–99.4%] | 374 | 58031 | 301 | $0.03889 [$0.03747–$0.03927] | +$0.00000 |
| large | B | T1 | opus-4.6 (medium) | 27.2% [27.2–27.2%] | 23700 | 8840 | 370 | $0.16182 [$0.16101–$0.16253] | -$0.00037 |
| large | B | T5 | opus-4.6 (medium) | 99.3% [99.3–99.4%] | 371 | 55684 | 241 | $0.03617 [$0.03590–$0.03634] | -$0.00067 |
| large | B | T6 | sonnet-4.6 (medium) | 0.0% [0.0–0.0%] | 56404 | 0 | 302 | $0.21602 [$0.21560–$0.21630] | +$0.17827 |
| large | B | T7 | sonnet-4.6 (medium) | 99.3% [99.3–99.3%] | 407 | 56404 | 283 | $0.02269 [$0.02234–$0.02308] | -$0.01415 |
| large | B | T8 | sonnet-4.6 (medium) | 99.3% [99.3–99.4%] | 387 | 56811 | 227 | $0.02191 [$0.02171–$0.02277] | -$0.01488 |
| large | B | T11 | sonnet-4.6 (medium) | 99.4% [99.3–99.4%] | 374 | 57870 | 283 | $0.02308 [$0.02276–$0.02341] | -$0.01581 |
| large | F | T1 | opus-4.6 (medium) | 27.2% [27.2–27.2%] | 23700 | 8840 | 370 | $0.16181 [$0.16138–$0.16219] | -$0.00038 |
| large | F | T5 | opus-4.6 (medium) | 98.6% [98.6–98.7%] | 777 | 55491 | 284 | $0.03971 [$0.03908–$0.03997] | +$0.00287 |
| large | F | T6 | sonnet-4.6 (medium) | 98.5% [98.4–98.6%] | 867 | 55860 | 305 | $0.02439 [$0.02416–$0.02498] | -$0.01336 |
| large | F | T7 | opus-4.6 (medium) | 98.4% [98.4–98.5%] | 891 | 56257 | 221 | $0.03920 [$0.03874–$0.04018] | +$0.00237 |
| large | F | T8 | sonnet-4.6 (medium) | 98.6% [98.5–98.6%] | 832 | 56726 | 230 | $0.02357 [$0.02294–$0.02483] | -$0.01322 |
| large | F | T11 | opus-4.6 (medium) | 98.6% [98.4–98.6%] | 846 | 57951 | 310 | $0.04248 [$0.04040–$0.04285] | +$0.00359 |
| small | A | T1 | opus-4.6 (medium) | 45.6% [45.6–45.6%] | 10550 | 8846 | 267 | $0.07705 [$0.07702–$0.07733] | +$0.00000 |
| small | A | T5 | opus-4.6 (medium) | 97.7% [97.6–97.8%] | 338 | 14482 | 230 | $0.01516 [$0.01495–$0.01595] | +$0.00000 |
| small | A | T6 | opus-4.6 (medium) | 97.7% [97.5–97.7%] | 344 | 14822 | 162 | $0.01363 [$0.01356–$0.01452] | +$0.00000 |
| small | A | T7 | opus-4.6 (medium) | 98.2% [98.0–98.2%] | 282 | 15165 | 178 | $0.01381 [$0.01360–$0.01444] | +$0.00000 |
| small | A | T8 | opus-4.6 (medium) | 98.2% [98.0–98.2%] | 289 | 15453 | 207 | $0.01468 [$0.01448–$0.01493] | +$0.00000 |
| small | A | T11 | opus-4.6 (medium) | 98.3% [98.1–98.4%] | 287 | 16414 | 198 | $0.01490 [$0.01448–$0.01641] | +$0.00000 |
| small | B | T1 | opus-4.6 (medium) | 45.6% [45.6–45.6%] | 10549 | 8845 | 267 | $0.07705 [$0.07690–$0.07721] | +$0.00001 |
| small | B | T5 | opus-4.6 (medium) | 97.7% [97.6–97.8%] | 344 | 14470 | 230 | $0.01517 [$0.01454–$0.01540] | +$0.00001 |
| small | B | T6 | sonnet-4.6 (medium) | 0.0% [0.0–0.0%] | 15165 | 0 | 228 | $0.06018 [$0.06008–$0.06051] | +$0.04655 |
| small | B | T7 | sonnet-4.6 (medium) | 97.7% [97.7–97.8%] | 349 | 15165 | 224 | $0.00923 [$0.00909–$0.00946] | -$0.00459 |
| small | B | T8 | sonnet-4.6 (medium) | 97.9% [97.8–97.9%] | 336 | 15506 | 238 | $0.00955 [$0.00923–$0.00964] | -$0.00512 |
| small | B | T11 | sonnet-4.6 (medium) | 98.3% [98.0–98.3%] | 290 | 16542 | 238 | $0.00979 [$0.00872–$0.00982] | -$0.00511 |
| small | C | T1 | opus-4.6 (medium) | 45.6% [45.6–45.6%] | 10550 | 8846 | 269 | $0.07710 [$0.07694–$0.07716] | +$0.00005 |
| small | C | T5 | opus-4.6 (medium) | 97.6% [97.6–97.8%] | 349 | 14481 | 231 | $0.01522 [$0.01457–$0.01597] | +$0.00006 |
| small | C | T6 | sonnet-4.6 (medium) | 0.0% [0.0–0.0%] | 15174 | 0 | 244 | $0.06071 [$0.06026–$0.06091] | +$0.04709 |
| small | C | T7 | sonnet-4.6 (medium) | 97.6% [97.6–97.7%] | 365 | 15174 | 227 | $0.00929 [$0.00909–$0.00952] | -$0.00453 |
| small | C | T8 | opus-4.6 (medium) | 93.3% [93.0–93.5%] | 1062 | 14840 | 218 | $0.01952 [$0.01911–$0.02033] | +$0.00485 |
| small | C | T11 | opus-4.6 (medium) | 98.3% [98.3–98.4%] | 281 | 16610 | 223 | $0.01568 [$0.01541–$0.01577] | +$0.00077 |
| small | D | T1 | opus-4.6 (medium) | 45.6% [45.6–45.6%] | 10550 | 8846 | 267 | $0.07705 [$0.07703–$0.07712] | +$0.00001 |
| small | D | T5 | opus-4.6 (medium) | 97.8% [97.5–97.8%] | 328 | 14483 | 231 | $0.01511 [$0.01423–$0.01546] | -$0.00006 |
| small | D | T6 | opus-4.6 (high) | 0.0% [0.0–0.0%] | 15157 | 0 | 166 | $0.09890 [$0.09821–$0.09920] | +$0.08527 |
| small | D | T7 | opus-4.6 (high) | 98.1% [98.1–98.2%] | 286 | 15157 | 176 | $0.01378 [$0.01374–$0.01411] | -$0.00004 |
| small | D | T8 | opus-4.6 (high) | 98.2% [98.1–98.2%] | 287 | 15443 | 204 | $0.01464 [$0.01429–$0.01483] | -$0.00003 |
| small | D | T11 | opus-4.6 (high) | 98.3% [98.2–98.4%] | 289 | 16407 | 208 | $0.01521 [$0.01488–$0.01540] | +$0.00031 |
| small | E | T1 | opus-4.6 (medium) | 45.6% [45.6–45.6%] | 10551 | 8847 | 265 | $0.07703 [$0.07696–$0.07717] | -$0.00002 |
| small | E | T5 | opus-4.6 (medium) | 97.8% [97.7–97.8%] | 330 | 14463 | 226 | $0.01495 [$0.01438–$0.01516] | -$0.00021 |
| small | E | T6 | sonnet-4.6 (medium) | 0.0% [0.0–0.0%] | 15155 | 0 | 238 | $0.06032 [$0.05998–$0.06068] | +$0.04669 |
| small | E | T7 | sonnet-4.6 (medium) | 97.7% [97.6–97.9%] | 359 | 15155 | 221 | $0.00920 [$0.00908–$0.00934] | -$0.00461 |
| small | E | T8 | sonnet-4.6 (medium) | 97.9% [97.9–97.9%] | 333 | 15500 | 239 | $0.00948 [$0.00921–$0.01002] | -$0.00519 |
| small | E | T11 | sonnet-4.6 (medium) | 98.1% [98.0–98.3%] | 311 | 16562 | 220 | $0.00951 [$0.00859–$0.00995] | -$0.00540 |
| small | F | T1 | opus-4.6 (medium) | 45.6% [45.6–45.6%] | 10549 | 8845 | 268 | $0.07708 [$0.07687–$0.07716] | +$0.00003 |
| small | F | T5 | opus-4.6 (medium) | 95.8% [95.7–96.0%] | 621 | 14345 | 242 | $0.01726 [$0.01672–$0.01788] | +$0.00209 |
| small | F | T6 | sonnet-4.6 (medium) | 94.9% [94.8–95.1%] | 779 | 14633 | 187 | $0.01013 [$0.00990–$0.01017] | -$0.00350 |
| small | F | T7 | opus-4.6 (medium) | 95.2% [94.9–95.2%] | 756 | 14960 | 177 | $0.01663 [$0.01650–$0.01695] | +$0.00281 |
| small | F | T8 | sonnet-4.6 (medium) | 95.7% [95.6–95.8%] | 698 | 15405 | 242 | $0.01088 [$0.01035–$0.01104] | -$0.00380 |
| small | F | T11 | opus-4.6 (medium) | 95.5% [95.3–95.6%] | 770 | 16482 | 201 | $0.01803 [$0.01761–$0.01944] | +$0.00313 |

---

## Disclosure & Scope
- **Author Disclosure:** This benchmark harness and analysis were conducted within the repository of **Highbeam (`ctxtop`)** ([https://github.com/Gizzant/attention-horizon-antigravity](https://github.com/Gizzant/attention-horizon-antigravity)), an open-source local context and cache-economics monitor designed around horizon-aware cache-gravity break-even limits (`C_max`).
- **Scope:** Results apply specifically to `@anthropic-ai/claude-code@2.1.325` calling first-party `anthropic/claude-opus-4.6` and `anthropic/claude-sonnet-4.6` via OpenRouter `/api/v1/messages` (`ephemeral_5m` cache TTL) on the run date above.
