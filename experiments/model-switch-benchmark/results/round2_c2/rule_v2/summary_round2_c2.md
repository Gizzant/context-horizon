> **DO NOT PUBLISH (SUPERSEDED PHASE 2 DATA):** The uncalibrated `rule_v2` CSVs in this folder used default `1,500`-token output assumptions, unscaled single-request read savings, and uncalibrated hook inputs. Always publish from the promoted calibrated files in `../runs_round2_c2_calibrated.csv`, `../interceptions_round2_c2_calibrated.csv`, and `../PUBLICATION_TABLES_ROUND2.md`.

# Round 2 C2 Live Validation Summary (`rule_v2`)

> **Route & Disclosure (`live`):** Traffic ran via OpenRouter (`https://openrouter.ai/api/v1/messages`, Anthropic provider pinned, `allow_fallbacks: false`); cache behavior and cost may differ on the direct Anthropic API. Tested under API-key `5m` cache TTL rules (`ephemeral_1h_input_tokens = 0`) with 2.1.325 on Windows (`2026-11-14` UTC) and Highbeam commit `b4e7502` (`rule_v2`). All latency values are directional only due to proxy + OpenRouter routing. Transcript-vs-proxy reconciliation matched on **132/132** main requests (`source = both`, `0` disagreements).

## 1. Native `PreModelSwitch` SDK `set_model` Interception (`live` / `AUTO_PILOT`)

| Run ID | Switch Turn | Hook Event | Permission Decision | Control Subtype (`error_code`) | Distinct Wire Models | Sanitized Hook Reason |
|---|---:|---|---|---|---|---|
| `C2_L1_hb_rule_v2_r01` | T3 | `PreModelSwitch` | `allow` | `success` | `anthropic/claude-opus-4.6 -> anthropic/claude-sonnet-4.6` | pass-through allow |
| `C2_L1_hb_rule_v2_r02` | T3 | `PreModelSwitch` | `allow` | `success` | `anthropic/claude-opus-4.6 -> anthropic/claude-sonnet-4.6` | pass-through allow |
| `C2_L1_hb_rule_v2_r03` | T3 | `PreModelSwitch` | `allow` | `success` | `anthropic/claude-opus-4.6 -> anthropic/claude-sonnet-4.6` | pass-through allow |
| `C2_L2_hb_rule_v2_r01` | T24 | `PreModelSwitch` | `allow` | `success` | `anthropic/claude-opus-4.6 -> anthropic/claude-sonnet-4.6` | pass-through allow |

*(Phase 1 `baseline_off` and `highbeam_rule_v1` reference runs come from `results/round2_c2/rule_v1/` on the identical frozen commit and API-key route.)*

## 2. Session-Level Results (`live` — `median [min–max]` for `n > 1`, single value for `n = 1`)

| Arm | Condition | n | Total Cost (`billed`) | Paired Delta vs Off (`billed`) | Delta vs `rule_v1` Hold (`billed`) | Cache Write Tokens | Paired Write Delta vs Off | Cache Read Share | Main API Reqs |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `L1` (30t, @T3) | `baseline_off` *(Phase 1 ref)* | 3 | $0.4032 [$0.3948–$0.4058] | — | — | 33,008 [32,629–33,142] | — | 93.89% [93.88%–93.90%] | 33 [33–33] |
| `L1` (30t, @T3) | `highbeam_rule_v1` *(Phase 1 hold ref)* | 3 | $0.5280 [$0.5277–$0.5317] | +$0.1248 [+$0.1218 to +$0.1369] | — | 20,928 [20,915–21,010] | -12,080 [-12,227 to -11,619] | 96.08% [96.08%–96.08%] | 33 [33–33] |
| `L1` (30t, @T3) | `highbeam_rule_v2` *(Phase 2 live)* | 3 | $0.4051 [$0.4016–$0.4059] | +$0.0018 [-$0.0042 to +$0.0111] | -$0.1258 [-$0.1260 to -$0.1229] | 33,121 [32,930–33,129] | +113 [-212 to +500] | 93.88% [93.88%–93.89%] | 33 [33–33] |
| `L2` (30t, @T24) | `baseline_off` *(Phase 1 ref `r01`)* | 1 | $0.5455 | — | — | 39,960 | — | 92.50% | 33 |
| `L2` (30t, @T24) | `baseline_off` *(Phase 1 ref `n=3`)* | 3 | $0.5461 [$0.5455–$0.5484] | — | — | 39,960 [39,932–40,088] | — | 92.50% [92.50%–92.50%] | 33 [33–33] |
| `L2` (30t, @T24) | `highbeam_rule_v1` *(Phase 1 ref `r01`)* | 1 | $0.5308 | -$0.0148 | — | 20,997 | -18,963 | 96.08% | 33 |
| `L2` (30t, @T24) | `highbeam_rule_v1` *(Phase 1 ref `n=3`)* | 3 | $0.5214 [$0.5174–$0.5308] | -$0.0247 [-$0.0310 to -$0.0148] | — | 20,754 [20,669–20,997] | -19,178 [-19,419 to -18,963] | 96.09% [96.08%–96.10%] | 33 [33–33] |
| `L2` (30t, @T24) | `highbeam_rule_v2` *(unguided prior, live)* | 1 | $0.5550 | +$0.0095 (vs `n=3` med: +$0.0089) | +$0.0243 (vs `n=3` med: +$0.0336) | 40,386 | +426 | 92.48% | 33 |

*(Note on `L1` `rule_v1` hold reference: `+$0.1463` was the pre-Phase-1 `computed` rate-card simulation estimate `$0.5818 - $0.4355`; Phase 1 live measured `$0.5280 [$0.5277–$0.5317]` `billed` vs `$0.4032 [$0.3948–$0.4058]` `billed` = paired `+$0.1248 [+$0.1218 to +$0.1369]` `billed`.)*

## 3. Switch Turn (`T_switch`) and Next Two Turns (`live`, Directional Latency)

| Arm | Condition | n | `T_switch` Cost (`billed`) | `T_switch` Write Tokens | `T_switch` Read % | `T_switch` Latency | `T+1` Cost (`billed`) | `T+2` Cost (`billed`) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `L1` (T3) | `baseline_off (Phase 1 ref)` | 3 | $0.0591 [$0.0590–$0.0591] | 13,602 [13,598–13,606] | 47.36% [47.35%–47.36%] | 6,727 [6,659–7,288] ms | $0.0082 [$0.0079–$0.0083] | $0.0088 [$0.0084–$0.0088] |
| `L1` (T3) | `highbeam_rule_v1 (Phase 1 ref)` | 3 | $0.0289 [$0.0289–$0.0291] | 1,620 [1,611–1,620] | 93.65% [93.64%–93.66%] | 6,185 [6,071–6,449] ms | $0.0137 [$0.0131–$0.0141] | $0.0147 [$0.0147–$0.0166] |
| `L1` (T3) | `highbeam_rule_v2 (Phase 2 live)` | 3 | $0.0592 [$0.0591–$0.0596] | 13,616 [13,601–13,638] | 47.36% [47.35%–47.36%] | 7,036 [6,937–7,364] ms | $0.0080 [$0.0078–$0.0080] | $0.0083 [$0.0080–$0.0087] |
| `L2` (T24) | `baseline_off (Phase 1 ref r01)` | 1 | $0.0754 | 19,298 | 0.00% | 4,393 ms | $0.0096 | $0.0096 |
| `L2` (T24) | `baseline_off (Phase 1 ref n=3)` | 3 | $0.0755 [$0.0754–$0.0756] | 19,298 [19,292–19,358] | 0.00% [0.00%–0.00%] | 4,668 [4,393–5,232] ms | $0.0094 [$0.0092–$0.0096] | $0.0098 [$0.0096–$0.0101] |
| `L2` (T24) | `highbeam_rule_v1 (Phase 1 ref r01)` | 1 | $0.0150 | 226 | 98.82% | 5,351 ms | $0.0153 | $0.0161 |
| `L2` (T24) | `highbeam_rule_v1 (Phase 1 ref n=3)` | 3 | $0.0147 [$0.0143–$0.0150] | 228 [226–238] | 98.79% [98.75%–98.82%] | 4,953 [4,836–5,351] ms | $0.0149 [$0.0146–$0.0153] | $0.0158 [$0.0157–$0.0161] |
| `L2` (T24) | `highbeam_rule_v2 (unguided, live)` | 1 | $0.0763 | 19,504 | 0.00% | 4,355 ms | $0.0094 | $0.0100 |

## 4. OpenRouter Account Reconciliation (`billed`) & Audit Notes
- **OpenRouter Key Usage Before / After (`billed`):** `35.06669945` -> `36.8231462` (delta = `$1.756447`, remaining = `$13.176854`).
- **Proxy Sum Across `runs_round2_c2.csv` (`billed`):** `$1.767691` across `132` main rows (`4` side calls, `0` aborted attempt rows).

## 5. Offline `rule_v2` Decision Table (`L1` @ T3 & `L2` @ T24 — `uncalibrated`, `calibrated`, `measured`)

| Arm | Profile | Turns Used | Context Tokens | Out Tok (`source`) | Horizon | Eff. Rem. | Prior Source | Legacy 1-Turn Threshold | Cold Penalty | Saving/t | Payback | Flip (`ask <=` / `allow >=`) | Net Savings | `shouldHoldModel` | Decision |
|---|---|---:|---:|---|---|---:|---|---:|---:|---:|---:|---|---:|---|---|
| `L1` | `uncalibrated` | 0 | 11,970 | 1500 (`explicit`) | `3` | 3 | `explicit` | 4,615 | +$0.0239 | +$0.0174 | 1.37 | 1.37 (<= 1 / >= 2) | +$0.0283 | `false` | `allow` |
| `L1` | `uncalibrated` | 0 | 11,970 | 1500 (`explicit`) | `6` | 6 | `explicit` | 4,615 | +$0.0239 | +$0.0174 | 1.37 | 1.37 (<= 1 / >= 2) | +$0.0805 | `false` | `allow` |
| `L1` | `uncalibrated` | 0 | 11,970 | 1500 (`explicit`) | `12` | 12 | `explicit` | 4,615 | +$0.0239 | +$0.0174 | 1.37 | 1.37 (<= 1 / >= 2) | +$0.1848 | `false` | `allow` |
| `L1` | `uncalibrated` | 0 | 11,970 | 1500 (`explicit`) | `30` | 30 | `explicit` | 4,615 | +$0.0239 | +$0.0174 | 1.37 | 1.37 (<= 1 / >= 2) | +$0.4979 | `false` | `allow` |
| `L1` | `uncalibrated` | 0 | 11,970 | 1500 (`explicit`) | `unguided_prior` | 59 | `placeholder_antigravity_496_prior` | 4,615 | +$0.0239 | +$0.0174 | 1.37 | 1.37 (<= 1 / >= 2) | +$1.0023 | `false` | `allow` |
| `L1` | `calibrated` | 2 | 11,970 | 414 (`stop_hook_shrunk_median`) | `3` | 3 | `explicit` | 1,274 | +$0.0348 | +$0.0065 | 5.32 | 5.32 (<= 5 / >= 6) | -$0.0152 | `true` | `ask` |
| `L1` | `calibrated` | 2 | 11,970 | 414 (`stop_hook_shrunk_median`) | `6` | 6 | `explicit` | 1,274 | +$0.0348 | +$0.0065 | 5.32 | 5.32 (<= 5 / >= 6) | +$0.0044 | `false` | `allow` |
| `L1` | `calibrated` | 2 | 11,970 | 414 (`stop_hook_shrunk_median`) | `12` | 12 | `explicit` | 1,274 | +$0.0348 | +$0.0065 | 5.32 | 5.32 (<= 5 / >= 6) | +$0.0436 | `false` | `allow` |
| `L1` | `calibrated` | 2 | 11,970 | 414 (`stop_hook_shrunk_median`) | `30` | 30 | `explicit` | 1,274 | +$0.0348 | +$0.0065 | 5.32 | 5.32 (<= 5 / >= 6) | +$0.1613 | `false` | `allow` |
| `L1` | `calibrated` | 2 | 11,970 | 414 (`stop_hook_shrunk_median`) | `unguided_prior` | 28.5 | `placeholder_antigravity_496_prior` | 1,274 | +$0.0348 | +$0.0065 | 5.32 | 5.32 (<= 5 / >= 6) | +$0.1515 | `false` | `allow` |
| `L1` | `measured` | 2 | 11,970 | 181 (`empirical_paired_runs`) | `3` | 3 | `explicit` | N/A (empirical) | +$0.0302 | +$0.0058 | 5.30 | 5.30 (<= 5 / >= 6) | -$0.0128 | `true` | `ask` |
| `L1` | `measured` | 2 | 11,970 | 181 (`empirical_paired_runs`) | `6` | 6 | `explicit` | N/A (empirical) | +$0.0302 | +$0.0058 | 5.30 | 5.30 (<= 5 / >= 6) | +$0.0046 | `false` | `allow` |
| `L1` | `measured` | 2 | 11,970 | 181 (`empirical_paired_runs`) | `12` | 12 | `explicit` | N/A (empirical) | +$0.0302 | +$0.0058 | 5.30 | 5.30 (<= 5 / >= 6) | +$0.0394 | `false` | `allow` |
| `L1` | `measured` | 2 | 11,970 | 181 (`empirical_paired_runs`) | `30` | 30 | `explicit` | N/A (empirical) | +$0.0302 | +$0.0058 | 5.30 | 5.30 (<= 5 / >= 6) | +$0.1438 | `false` | `allow` |
| `L1` | `measured` | 2 | 11,970 | 181 (`empirical_paired_runs`) | `unguided_prior` | 28.5 | `placeholder_antigravity_496_prior` | N/A (empirical) | +$0.0302 | +$0.0058 | 5.30 | 5.30 (<= 5 / >= 6) | +$0.1351 | `false` | `allow` |
| `L2` | `uncalibrated` | 0 | 19,131 | 1500 (`explicit`) | `3` | 3 | `explicit` | 4,615 | +$0.0472 | +$0.0188 | 2.51 | 2.51 (<= 2 / >= 3) | +$0.0093 | `false` | `allow` |
| `L2` | `uncalibrated` | 0 | 19,131 | 1500 (`explicit`) | `6` | 6 | `explicit` | 4,615 | +$0.0472 | +$0.0188 | 2.51 | 2.51 (<= 2 / >= 3) | +$0.0658 | `false` | `allow` |
| `L2` | `uncalibrated` | 0 | 19,131 | 1500 (`explicit`) | `12` | 12 | `explicit` | 4,615 | +$0.0472 | +$0.0188 | 2.51 | 2.51 (<= 2 / >= 3) | +$0.1787 | `false` | `allow` |
| `L2` | `uncalibrated` | 0 | 19,131 | 1500 (`explicit`) | `30` | 30 | `explicit` | 4,615 | +$0.0472 | +$0.0188 | 2.51 | 2.51 (<= 2 / >= 3) | +$0.5176 | `false` | `allow` |
| `L2` | `uncalibrated` | 0 | 19,131 | 1500 (`explicit`) | `unguided_prior` | 59 | `placeholder_antigravity_496_prior` | 4,615 | +$0.0472 | +$0.0188 | 2.51 | 2.51 (<= 2 / >= 3) | +$1.0636 | `false` | `allow` |
| `L2` | `calibrated` | 23 | 19,131 | 151 (`stop_hook_rolling_median`) | `3` | 3 | `explicit` | 465 | +$0.0607 | +$0.0053 | 11.37 | 11.37 (<= 11 / >= 12) | -$0.0447 | `true` | `ask` |
| `L2` | `calibrated` | 23 | 19,131 | 151 (`stop_hook_rolling_median`) | `6` | 6 | `explicit` | 465 | +$0.0607 | +$0.0053 | 11.37 | 11.37 (<= 11 / >= 12) | -$0.0286 | `true` | `ask` |
| `L2` | `calibrated` | 23 | 19,131 | 151 (`stop_hook_rolling_median`) | `12` | 12 | `explicit` | 465 | +$0.0607 | +$0.0053 | 11.37 | 11.37 (<= 11 / >= 12) | +$0.0034 | `false` | `allow` |
| `L2` | `calibrated` | 23 | 19,131 | 151 (`stop_hook_rolling_median`) | `30` | 30 | `explicit` | 465 | +$0.0607 | +$0.0053 | 11.37 | 11.37 (<= 11 / >= 12) | +$0.0994 | `false` | `allow` |
| `L2` | `calibrated` | 23 | 19,131 | 151 (`stop_hook_rolling_median`) | `unguided_prior` | 30.08 | `placeholder_antigravity_496_prior` | 465 | +$0.0607 | +$0.0053 | 11.37 | 11.37 (<= 11 / >= 12) | +$0.0998 | `false` | `allow` |
| `L2` | `measured` | 23 | 19,131 | 182 (`empirical_paired_runs`) | `3` | 3 | `explicit` | N/A (empirical) | +$0.0608 | +$0.0059 | 10.30 | 10.30 (<= 10 / >= 11) | -$0.0431 | `true` | `ask` |
| `L2` | `measured` | 23 | 19,131 | 182 (`empirical_paired_runs`) | `6` | 6 | `explicit` | N/A (empirical) | +$0.0608 | +$0.0059 | 10.30 | 10.30 (<= 10 / >= 11) | -$0.0254 | `true` | `ask` |
| `L2` | `measured` | 23 | 19,131 | 182 (`empirical_paired_runs`) | `12` | 12 | `explicit` | N/A (empirical) | +$0.0608 | +$0.0059 | 10.30 | 10.30 (<= 10 / >= 11) | +$0.0100 | `false` | `allow` |
| `L2` | `measured` | 23 | 19,131 | 182 (`empirical_paired_runs`) | `30` | 30 | `explicit` | N/A (empirical) | +$0.0608 | +$0.0059 | 10.30 | 10.30 (<= 10 / >= 11) | +$0.1162 | `false` | `allow` |
| `L2` | `measured` | 23 | 19,131 | 182 (`empirical_paired_runs`) | `unguided_prior` | 30.08 | `placeholder_antigravity_496_prior` | N/A (empirical) | +$0.0608 | +$0.0059 | 10.30 | 10.30 (<= 10 / >= 11) | +$0.1167 | `false` | `allow` |

## 6. Interpretation of `rule_v2` Behavior & Survival Prior Audit
- **`L1` (`rule_v2` live, `n = 3`, Opus -> Sonnet @ T3 of 30t):** `rule_v2` allows the early T3 downgrade via `PreModelSwitch` (`permissionDecision: "allow"`, `control_subtype: "success"`), matching the switched baseline within run-to-run output variance and eliminating the `rule_v1` hold surcharge (`+$0.1248` `billed` measured in Phase 1; `+$0.1463` `computed` pre-Phase-1 simulation).
- **`L2` (`rule_v2` unguided prior live, `n = 1`, Opus -> Sonnet @ T24 of 30t):** **No horizon signal, cannot beat baseline on late switches.** With no explicit remaining-turn bound provided, `rule_v2` relies on the empirical survival prior, predicts long continuation, and passes the T24 switch through cleanly (a structural limit of having no horizon signal, not a hook failure). Explicit bounded horizons (`3` or `6` remaining turns under calibrated output tokens) hold `ask` offline (Section 5) and reproduce the `rule_v1` hold already measured in Phase 1.
- **Survival Prior Provenance & Unit Audit:** `EMPIRICAL_SESSION_API_CALL_PRIOR` (`source = "placeholder_antigravity_496_prior"`, `isPlaceholderPrior = true`) is a **placeholder** built from `496` Antigravity IDE workstation planner runs (`120` interactive multi-turn + `376` single-prompt/subagent sessions, NOT Claude Code telemetry; overridden at runtime when `>= 5` deduplicated local transcripts exist under `~/.claude/projects/**/*.jsonl`, which is empty in isolated benchmark runs). Native bucket residuals (`+59`, `+47`, etc.) are measured in **`api_requests`** (`prior_native_unit = "api_requests"`) and are converted to **`turns`** (`horizon_unit = "turns"`) by dividing by the session's observed `requestsPerTurn`.
