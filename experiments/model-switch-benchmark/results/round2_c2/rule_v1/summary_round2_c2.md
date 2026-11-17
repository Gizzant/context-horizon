# Round 2 C2 Live Validation Summary (`rule_v1`)

> **Route & Disclosure (`live`):** Traffic ran via OpenRouter (`https://openrouter.ai/api/v1/messages`, Anthropic provider pinned, `allow_fallbacks: false`); cache behavior and cost may differ on the direct Anthropic API. Tested under API-key `5m` cache TTL rules (`ephemeral_1h_input_tokens = 0`) with 2.1.325 (Claude Code) on Windows (`2026-11-14` UTC) and Highbeam commit `b4e7502` (`rule_v1`). All latency values are directional only due to proxy + OpenRouter routing. Transcript-vs-proxy reconciliation matched on **426/426** main requests (`source = both`, `0` disagreements).

## 1. Native `PreModelSwitch` SDK `set_model` Interception (`live` / `AUTO_PILOT`)

| Run ID | Switch Turn | Hook Event | Permission Decision | Control Subtype (`error_code`) | Distinct Wire Models | Sanitized Hook Reason |
|---|---:|---|---|---|---|---|
| `C2_L1_hb_rule_v1_r01` | T3 | `PreModelSwitch` | `ask` | `error` (`blocked_by_hook`) | `anthropic/claude-opus-4.6` | [DET-08 Warm KV-Cache Hold] Switching from claude-opus-4-6 to claude-sonnet-4-6 with 11,970 warm cached tokens exceeds legacy single-turn threshold (4,615 tokens) and incurs a +$0.0239 cold 1.25x prefix rewrite penalty; payback ~1.4 turns at +$0.0174/turn post-switch saving. Keep main thread on claude-opus-4-6 or confirm if this session will run past payback. |
| `C2_L1_hb_rule_v1_r02` | T3 | `PreModelSwitch` | `ask` | `error` (`blocked_by_hook`) | `anthropic/claude-opus-4.6` | [DET-08 Warm KV-Cache Hold] Switching from claude-opus-4-6 to claude-sonnet-4-6 with 11,930 warm cached tokens exceeds legacy single-turn threshold (4,615 tokens) and incurs a +$0.0238 cold 1.25x prefix rewrite penalty; payback ~1.4 turns at +$0.0174/turn post-switch saving. Keep main thread on claude-opus-4-6 or confirm if this session will run past payback. |
| `C2_L1_hb_rule_v1_r03` | T3 | `PreModelSwitch` | `ask` | `error` (`blocked_by_hook`) | `anthropic/claude-opus-4.6` | [DET-08 Warm KV-Cache Hold] Switching from claude-opus-4-6 to claude-sonnet-4-6 with 11,985 warm cached tokens exceeds legacy single-turn threshold (4,615 tokens) and incurs a +$0.0240 cold 1.25x prefix rewrite penalty; payback ~1.4 turns at +$0.0174/turn post-switch saving. Keep main thread on claude-opus-4-6 or confirm if this session will run past payback. |
| `C2_L2_hb_rule_v1_r01` | T24 | `PreModelSwitch` | `ask` | `error` (`blocked_by_hook`) | `anthropic/claude-opus-4.6` | [DET-08 Warm KV-Cache Hold] Switching from claude-opus-4-6 to claude-sonnet-4-6 with 19,287 warm cached tokens exceeds legacy single-turn threshold (4,615 tokens) and incurs a +$0.0477 cold 1.25x prefix rewrite penalty; payback ~2.5 turns at +$0.0189/turn post-switch saving. Keep main thread on claude-opus-4-6 or confirm if this session will run past payback. |
| `C2_L2_hb_rule_v1_r02` | T24 | `PreModelSwitch` | `ask` | `error` (`blocked_by_hook`) | `anthropic/claude-opus-4.6` | [DET-08 Warm KV-Cache Hold] Switching from claude-opus-4-6 to claude-sonnet-4-6 with 19,001 warm cached tokens exceeds legacy single-turn threshold (4,615 tokens) and incurs a +$0.0468 cold 1.25x prefix rewrite penalty; payback ~2.5 turns at +$0.0188/turn post-switch saving. Keep main thread on claude-opus-4-6 or confirm if this session will run past payback. |
| `C2_L2_hb_rule_v1_r03` | T24 | `PreModelSwitch` | `ask` | `error` (`blocked_by_hook`) | `anthropic/claude-opus-4.6` | [DET-08 Warm KV-Cache Hold] Switching from claude-opus-4-6 to claude-sonnet-4-6 with 19,131 warm cached tokens exceeds legacy single-turn threshold (4,615 tokens) and incurs a +$0.0472 cold 1.25x prefix rewrite penalty; payback ~2.5 turns at +$0.0188/turn post-switch saving. Keep main thread on claude-opus-4-6 or confirm if this session will run past payback. |
| `C2_U1_hb_rule_v1_r01` | T6 | `PreModelSwitch` | `allow` | `success` | `anthropic/claude-sonnet-4.6 -> anthropic/claude-opus-4.6` | pass-through allow |

*(Every paired `baseline_off` run returned `hook_event = none`, `permission_decision = allow_no_hook`, `control_subtype = success`, and switched wire model on `T_switch`.)*

## 2. Session-Level Results (`live` — `median [min–max]` for `n > 1`)

| Arm | Condition | n | Total Cost (`billed`) | Paired Delta vs Off (`billed`) | Cache Write Tokens | Paired Write Delta | Cache Read Share | Main API Reqs |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `L1` (30t, @T3) | `baseline_off` | 3 | $0.4032 [$0.3948–$0.4058] | — | 33,008 [32,629–33,142] | — | 93.89% [93.88%–93.90%] | 33 [33–33] |
| `L1` (30t, @T3) | `highbeam_rule_v1` | 3 | $0.5280 [$0.5277–$0.5317] | +$0.1248 [+$0.1218 to +$0.1369] | 20,928 [20,915–21,010] | -12,080 [-12,227–-11,619] | 96.08% [96.08%–96.08%] | 33 [33–33] |
| `L2` (30t, @T24) | `baseline_off` | 3 | $0.5461 [$0.5455–$0.5484] | — | 39,960 [39,932–40,088] | — | 92.50% [92.50%–92.50%] | 33 [33–33] |
| `L2` (30t, @T24) | `highbeam_rule_v1` | 3 | $0.5214 [$0.5174–$0.5308] | -$0.0247 [-$0.0310 to -$0.0148] | 20,754 [20,669–20,997] | -19,178 [-19,419–-18,963] | 96.09% [96.08%–96.10%] | 33 [33–33] |
| `U1` (12t, @T6) | `baseline_off` | 1 | $0.2785 | — | 30,433 | — | 84.87% | 15 |
| `U1` (12t, @T6) | `highbeam_rule_v1` | 1 | $0.2750 | -$0.0036 | 30,260 | -173 | 84.90% | 15 |

## 3. Switch Turn (`T_switch`) and Next Two Turns (`live`, Directional Latency)

| Arm | Condition | n | `T_switch` Cost (`billed`) | `T_switch` Write Tokens | `T_switch` Read % | `T_switch` Latency | `T+1` Cost (`billed`) | `T+2` Cost (`billed`) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `L1` (T3) | `baseline_off` | 3 | $0.0591 [$0.0590–$0.0591] | 13,602 [13,598–13,606] | 47.36% [47.35%–47.36%] | 6,727 [6,659–7,288] ms | $0.0082 [$0.0079–$0.0083] | $0.0088 [$0.0084–$0.0088] |
| `L1` (T3) | `highbeam_rule_v1` | 3 | $0.0289 [$0.0289–$0.0291] | 1,620 [1,611–1,620] | 93.65% [93.64%–93.66%] | 6,185 [6,071–6,449] ms | $0.0137 [$0.0131–$0.0141] | $0.0147 [$0.0147–$0.0166] |
| `L2` (T24) | `baseline_off` | 3 | $0.0755 [$0.0754–$0.0756] | 19,298 [19,292–19,358] | 0.00% [0.00%–0.00%] | 4,668 [4,393–5,232] ms | $0.0094 [$0.0092–$0.0096] | $0.0098 [$0.0096–$0.0101] |
| `L2` (T24) | `highbeam_rule_v1` | 3 | $0.0147 [$0.0143–$0.0150] | 228 [226–238] | 98.79% [98.75%–98.82%] | 4,953 [4,836–5,351] ms | $0.0149 [$0.0146–$0.0153] | $0.0158 [$0.0157–$0.0161] |
| `U1` (T6) | `baseline_off` | 1 | $0.0954 | 14,505 | 0.00% | 6,710 ms | $0.0135 | $0.0144 |
| `U1` (T6) | `highbeam_rule_v1` | 1 | $0.0952 | 14,444 | 0.00% | 6,868 ms | $0.0133 | $0.0138 |

## 4. OpenRouter Account Reconciliation (`billed`) & Audit Notes
- **OpenRouter Key Usage Before / After (`billed`):** `28.5111351` -> `35.0246202` (delta = `$6.513485`, remaining = `$14.975380`).
- **Proxy Sum Across `runs_round2_c2.csv` (`billed`):** `$6.554276` across `426` main rows (`14` side calls, `0` aborted attempt rows).

## 5. Interpretation of `rule_v1` Behavior
- **`L1` (Opus -> Sonnet @ T3 of 30t):** `rule_v1` evaluates only single-turn break-even (legacy 0-horizon threshold `4,615` tokens) without remaining-turn horizon, so it blocks the early downgrade via `permissionDecision: "ask"`. Across 30 turns, holding on Opus costs more than taking the T3 cold rewrite — demonstrating the exact horizon limitation targeted by `rule_v2` (`C1e`).
- **`L2` (Opus -> Sonnet @ T24 of 30t):** Blocking the late downgrade via `permissionDecision: "ask"` avoids a large T24 prefix rewrite when only 7 turns remain (`T24–T30`), keeping session cost lower than the switched baseline.
- **`U1` (Sonnet -> Opus @ T6 of 12t):** Capability upshift (`isCapabilityUpshift = true`, `breakEvenTokens = 0`) passes through `PreModelSwitch` (`exit_code = 0`, `permission_decision = allow`), switching wire model cleanly at T6.
