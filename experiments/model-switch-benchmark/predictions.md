# Pre-Registered Predictions — Claude Code Mid-Chat Model & Effort Switch Study

- **Pre-Registration Timestamp (Local):** 2026-11-14T00:29:00-05:00
- **Pinned Repository Commit:** `19c51055902c545508af1979a392505355777d90`
- **Target Agent Harness:** `@anthropic-ai/claude-code@2.1.325` (`--tools "Read"`, frozen empty settings, isolated `CLAUDE_CONFIG_DIR`)
- **Upstream API Route:** OpenRouter Anthropic Messages API (`https://openrouter.ai/api/v1/messages`) pinned to 1st-party Anthropic (`provider: { only: ["anthropic"], allow_fallbacks: false }`)
- **Models & Effort Tiers Tested:**
  - **Model A:** `claude-opus-4-6` (`anthropic/claude-opus-4.6`)
  - **Model B:** `claude-sonnet-4-6` (`anthropic/claude-sonnet-4.6`)
  - **Baseline Effort:** `medium`; **Switched Effort (Arm D):** `high`

*(This file is written and SHA-256 hashed before running the live Pilot or any live benchmark arm. All predictions—whether confirmed or falsified—will be reported verbatim alongside the measured data.)*

---

## Pre-Registered Hypotheses (Q1–Q5 + Arm F)

1. **Q1 — First-turn switch penalty (`Model A → Model B` at Turn 6):**
   - Anthropic prompt caches are strictly keyed per model ID. Switching from `claude-opus-4-6` to `claude-sonnet-4-6` on Turn 6 will drop `cache_read_input_tokens` to **`0`** (`0%` cache hit ratio) and force `100%` of the accumulated conversation prefix into `cache_creation_input_tokens` billed at Sonnet 4.6's `1.25x` (`$3.75/MTok`) 5-minute write rate.
   - Because writing a warm prefix on a cheaper model costs `1.25x` input while reading Opus's warm cache costs only `0.10x` (`$0.50/MTok`), switching to "cheaper" Sonnet at a `~60k` prefix with concise (~200-token) outputs will cost **~5x–6x more USD on Turn 6** than staying on Opus, and across a 12-turn chat Arm B (`Large`) will have a **higher cumulative session cost** than Control Arm A (`Large`).
   - TTFB and wall-clock latency will spike on Turn 6 relative to Control Turn 6 because the upstream engine must re-prefill and materialize KV-cache blocks for the entire prefix.

2. **Q2 — One-time penalty vs. every later turn missing:**
   - **One-time penalty.** On Turn 7 (second consecutive turn on `claude-sonnet-4-6`), Sonnet will read the prompt cache created on Turn 6 (`cache_hit_ratio > 90%`), refuting articles claiming that switching models causes every subsequent turn to miss the cache.

3. **Q3 — Switching back to the original model within cache lifetime (Arm C):**
   - Switching `Opus → Sonnet` for Turns 6–7 and returning `Sonnet → Opus` on Turn 8 (well inside Anthropic's 5-minute `ephemeral_5m` TTL) will **hit Opus's Turn 5 cache** (`~80%–95%` cache hit ratio on Turn 8), paying `1.25x` `cache_creation_input_tokens` *only* for the new messages accumulated during Turns 6–7 (plus Turn 8's prompt).

4. **Q4 — Changing effort alone on the same model (Arm D):**
   - *Baseline protocol expectation:* Changing `--effort` alone leaves the cache intact (`cache_hit_ratio` stays high).
   - *Wire-level counter-prediction:* Changing `--effort medium` to `--effort high` mutates `output_config.effort` (and/or `thinking` configuration) in the `/v1/messages` request payload. Because Anthropic's server-side cache key includes thinking/effort configuration for message blocks, changing effort mid-session will **invalidate the `messages` prefix cache** on Turn 6 (causing a large spike in `cache_creation_input_tokens` and drop in `cache_read_input_tokens`, though static `tools`/`system` prefix blocks may survive depending on Anthropic's exact prefix boundary). Turn 7 at `high` effort will recover to `>90%` cache hit ratio.

5. **Q5 — Does the penalty scale with chat size (`~6k–8k` vs `~60k`)?**
   - **Yes, approximately linearly (`~8x–10x` in USD).** Comparing Arm B minus Control Arm A on Turn 6 at Small (`~6k–8k`) vs. Large (`~60k`) will show the cache-rebuild cost penalty growing in direct proportion to prefix token count, crossing <PROJECT_NAME>'s algebraic break-even threshold $C^* = 4,615$ tokens (for `Opus 4.6 → Sonnet 4.6` at $O = 1,500$).

6. **Arm F — Alternating models 10 times (`Opus ↔ Sonnet` on Turns 1–11):**
   - When alternating every turn (`~15–25s` apart, well inside the `5m` TTL), Anthropic holds **two separate warm caches in parallel** (one for Opus, one for Sonnet).
   - Therefore, switches #2 through #10 will **not** pay 10 full prefix rebuilds! Instead, on each alternating turn $t \ge 3$, the model will hit Turn $t-2$'s cached prefix (~`75%–92%` hit ratio) and pay `cache_creation` only to append the 2-turn incremental conversation delta on both models' caches. As a result, 10 fast switches at `60k` will cost far less than $10\times$ a cold rebuild, yet still noticeably more than staying on Control Arm A.
