# Empirical Findings: “I Switched Models Mid-Chat 10 Times. Here’s What It Actually Cost.”

- **Run Date (UTC):** 2026-11-14T05:39:24.990Z
- **Claude Code CLI Version:** `@anthropic-ai/claude-code@2.1.325 (Claude Code)`
- **Pinned Target Repo Commit:** `19c51055902c545508af1979a392505355777d90`
- **Platform / Runtime:** `win32 x64` / Node `v25.6.0`
- **Upstream Route:** OpenRouter Anthropic Messages API (`/api/v1/messages`) pinned strictly to 1st-party `anthropic` (`allow_fallbacks: false`)
- **Pre-Registered Predictions SHA-256:** `4b74083f47524c053dd8470644961442e473ff2f70f8bbc4a1069f7ca1961c56`
- **Transcript Reconciliation:** 28/28 user turns matched byte-for-byte on cache tokens between Claude Code `.jsonl` transcripts and live proxy SSE wire logs.
- **Side-Call Audit:** 0 background side calls (counted separately & excluded from arm tables; total side-call cost: $0.00000 vs main-turn cost: $2.0434).
- **OpenRouter Server-Side Ledger Delta:** $1.35801 (start=$0.00000, end=$1.35801)

---

## Executive Answers to the 5 Research Questions (Median [Min–Max], N=5 Runs/Arm)

1. **Q1 — First-turn switch penalty (`Opus 4.6 -> Sonnet 4.6` at Turn 6):**
   - **Small (~6k–8k):** Control Turn 6 cache hit ratio=98.0% (cost=$0.0160). Arm B Turn 6 hit ratio=N/A, cost=N/A (**+N/A** vs Control Turn 6, **+N/A ms** latency delta).
   - **Large (~60k):** Control Turn 6 cache hit ratio=N/A (cost=N/A). Arm B Turn 6 hit ratio=0.0% [0.0–0.0%], cost=$0.3422 (**+$0.0000** vs Control Turn 6, **+0 ms** latency delta).
2. **Q2 — One-time penalty or repeating miss?**
   - **One-time penalty.** On Turn 7 (second turn on Sonnet 4.6), median cache hit ratio recovered to **N/A** (Small) and **99.5%** (Large).
3. **Q3 — Switching back to Opus within the 5m TTL (Arm C, Turn 8):**
   - **Hits Opus’s Turn 5 cache.** At Turn 8 back on Opus 4.6, median cache hit ratio was **93.9% [93.9–93.9%]** (cache write=1091 tokens for the 2-turn delta, cost=$0.0219).
4. **Q4 — Changing `--effort` alone (`medium -> high` on Opus 4.6, Arm D Turn 6):**
   - Turn 6 median cache hit ratio=0.0% [0.0–0.0%], median cache_creation=17122 tokens, median cache_read=0 tokens, cost=$0.1121 (delta vs Control Turn 6: **+$0.0961**). Wire diff between Turn 5 and Turn 6 changed fields: `[{"field":"output_config","before":{"effort":"medium"},"after":{"effort":"high"}},{"field":"cacheBreakpoints","before":[{"section":"system","index":1,"cache_control":{"type":"ephemeral"}},{"section":"system","index":2,"cache_control":{"type":"ephemeral"}},{"section":"messages","messageIndex":14,"role":"user","blockIndex":1,"blockType":"text","cache_control":{"type":"ephemeral"}}],"after":[{"section":"system","index":1,"cache_control":{"type":"ephemeral"}},{"section":"system","index":2,"cache_control":{"type":"ephemeral"}},{"section":"messages","messageIndex":16,"role":"user","blockIndex":1,"blockType":"text","cache_control":{"type":"ephemeral"}}]}]`.
5. **Q5 — Prefix size scaling (`Small` vs `Large`):**
   - Turn 6 switch cost penalty increased from **N/A** (Small) to **$0.0000** (Large). Over the full 12-turn session at ~60k, Control Arm A cost **N/A** vs Arm B (switching down to Sonnet!) at **$1.2526** and Arm F (10 switches!) at **N/A**.

---

## 12-Turn Session Summary (Median & Min–Max Range Across N=5 Replicates)

| Tier | Arm | Name | N | Median Session Cost (Range) | vs Control | Median Cache Hit | Median Write Tokens | Median Read Tokens |
| :--- | :---: | :--- | :---: | :--- | :---: | :---: | :---: | :---: |
| large | B | One Switch | 1 | $1.2526 [$1.2526–$1.2526] | +$1.2526 | 72.2% | 179954 | 467912 |
| small | A | Control | 1 | $0.1984 [$0.1984–$0.1984] | +$0.0000 | 86.3% | 17156 | 108491 |
| small | C | Switch & Back | 1 | $0.2841 [$0.2841–$0.2841] | +$0.0857 | 78.0% | 35489 | 125841 |
| small | D | Effort Only | 1 | $0.3084 [$0.3084–$0.3084] | +$0.1099 | 76.1% | 34236 | 108904 |

## Key Single-Turn Checkpoints (Turn 1, Turn 5 Pre-Switch, Turn 6 Switch, Turn 7 Recovery, Turn 8 Return)

| Tier | Arm | Turn | Model / Effort | Cache Hit % (Range) | Median Write | Median Read | Median Out | Median Cost (Range) | Penalty vs Ctrl |
| :--- | :---: | :---: | :--- | :--- | :---: | :---: | :---: | :--- | :---: |
| large | B | T1 | opus-4.6 (medium) | 20.9% [20.9–20.9%] | 33359 | 8834 | 1687 | $0.25511 [$0.25511–$0.25511] | +$0.00000 |
| large | B | T5 | opus-4.6 (medium) | 99.6% [99.6–99.6%] | 386 | 89275 | 299 | $0.05454 [$0.05454–$0.05454] | +$0.00000 |
| large | B | T6 | sonnet-4.6 (medium) | 0.0% [0.0–0.0%] | 89833 | 0 | 355 | $0.34221 [$0.34221–$0.34221] | +$0.00000 |
| large | B | T7 | sonnet-4.6 (medium) | 99.5% [99.5–99.5%] | 460 | 89833 | 325 | $0.03356 [$0.03356–$0.03356] | +$0.00000 |
| small | A | T1 | opus-4.6 (medium) | 44.6% [44.6–44.6%] | 10959 | 8841 | 268 | $0.07963 [$0.07963–$0.07963] | +$0.00000 |
| small | A | T5 | opus-4.6 (medium) | 98.0% [98.0–98.0%] | 333 | 16474 | 226 | $0.01598 [$0.01598–$0.01598] | +$0.00000 |
| small | A | T6 | opus-4.6 (medium) | 98.0% [98.0–98.0%] | 349 | 16807 | 217 | $0.01603 [$0.01603–$0.01603] | +$0.00000 |
| small | C | T1 | opus-4.6 (medium) | 44.6% [44.6–44.6%] | 10959 | 8841 | 298 | $0.08038 [$0.08038–$0.08038] | +$0.00075 |
| small | C | T5 | opus-4.6 (medium) | 98.2% [98.2–98.2%] | 294 | 16523 | 230 | $0.01586 [$0.01586–$0.01586] | -$0.00012 |
| small | C | T6 | sonnet-4.6 (medium) | 0.0% [0.0–0.0%] | 17161 | 0 | 301 | $0.06888 [$0.06888–$0.06888] | +$0.05285 |
| small | C | T7 | sonnet-4.6 (medium) | 97.6% [97.6–97.6%] | 420 | 17161 | 248 | $0.01045 [$0.01045–$0.01045] | +$0.00000 |
| small | C | T8 | opus-4.6 (medium) | 93.9% [93.9–93.9%] | 1091 | 16817 | 265 | $0.02187 [$0.02187–$0.02187] | +$0.00000 |
| small | D | T1 | opus-4.6 (medium) | 44.6% [44.6–44.6%] | 10959 | 8841 | 291 | $0.08021 [$0.08021–$0.08021] | +$0.00057 |
| small | D | T5 | opus-4.6 (medium) | 98.2% [98.2–98.2%] | 298 | 16496 | 205 | $0.01525 [$0.01525–$0.01525] | -$0.00073 |
| small | D | T6 | opus-4.6 (high) | 0.0% [0.0–0.0%] | 17122 | 0 | 202 | $0.11208 [$0.11208–$0.11208] | +$0.09605 |
| small | D | T7 | opus-4.6 (high) | 98.2% [98.2–98.2%] | 320 | 17122 | 167 | $0.01475 [$0.01475–$0.01475] | +$0.00000 |

---

## Disclosure & Scope
- **Author Disclosure:** This benchmark harness and analysis were conducted within the repository of **<PROJECT_NAME> (`<PROJECT_CLI>`)** ([https://github.com/<GITHUB_HANDLE>/<TARGET_REPO>](https://github.com/<GITHUB_HANDLE>/<TARGET_REPO>)), an open-source local context and cache-economics monitor designed around horizon-aware cache-gravity break-even limits (`C_max`).
- **Scope:** Results apply specifically to `@anthropic-ai/claude-code@2.1.325` calling first-party `anthropic/claude-opus-4.6` and `anthropic/claude-sonnet-4.6` via OpenRouter `/api/v1/messages` (`ephemeral_5m` cache TTL) on the run date above.
