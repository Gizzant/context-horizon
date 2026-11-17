# Empirical Benchmark Report: Cost Optimization Anti-Patterns (Items 3–8, Remedies R1–R2 & Claude 5.5 Check)

**Generated (UTC):** `2026-11-15T23:02:59.927Z`  
**Primary Statistical Convention:** Every multi-rep metric reports `n` and `median [min–max]` (exact `min–max` omitted when `n = 1` or `min == max`); proportion confidence intervals use Wilson 95% bounds. Means and medians are never mixed.  
**Cost Attribution Convention:** Every USD figure explicitly states whether it is **`billed`** (OpenRouter `usage.cost` field), **`computed`** (Direct Anthropic token counts multiplied by the Phase 0 OpenRouter/Anthropic rate card captured `2026-11-15`), or **`unverified`** (where no USD billing field exists in API telemetry).

---

## 1. Limitations & Scope (Read First)

1. **Pinned Models & Dates (`2026-11-15 UTC`):** Results apply to `anthropic/claude-sonnet-4.6`, `anthropic/claude-opus-4.6`, `anthropic/claude-sonnet-5.5` (`claude-sonnet-5-5`), `anthropic/claude-opus-5.5`, `models/gemini-3.1-pro-preview`, and local `@anthropic-ai/claude-code@2.1.325` via OpenRouter (`provider: { only: ["anthropic"], allow_fallbacks: false }`) or direct vendor endpoints on `2026-11-15 UTC`. Cache lifetimes, minimum token thresholds, and per-token pricing can change without notice.
2. **Sample Sizes (`n`):** Most API arms use `n = 3` replications (`n = 2` for `T3b`, `n = 1` for `T4` `N=25` scaling checks, `T3a` `62m`, `T3c` Gemini, and `T7` `CLAUDE.md`). Small `n` values establish deterministic protocol mechanics cleanly (e.g., `0` vs `15k` cache hits), whereas continuous distributions (`latency_ms`, exact accuracy percentages) carry correspondingly wide intervals.
3. **Prefix Token Calibration in `T3`:** `T3a` and `T3b` prefix calibration landed at **`17,551` tokens** (with nonce ~`17,564` tokens billed) instead of `19,800` tokens; this remains far above Sonnet 4.6's `1,024`-token minimum cacheable threshold, and all per-call costs are measured directly from this actual ~`17.6k` prefix.
4. **Direct Anthropic Costs Are `computed`, Not `billed`:** Anthropic's Direct Messages API (`/v1/messages`) returns exact token counts (`input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`) but does not return an inline USD `cost` field. All `anthropic_direct` USD figures (`T4 P1`, `T3b KA-zero`, `R2`) are therefore labeled **`computed`** using the verified Phase 0 rate card.
5. **Gemini Storage Price & Break-Even Remain `unverified` via API:** Google's `generativelanguage.googleapis.com/v1beta` API returns `usageMetadata` token counts and timestamps (`createTime`, `expireTime`, `ttl`) for `cachedContents`, but returns **no USD storage rate or billed charge field**. Claims of `$4.50/M tokens/hr` storage cost and `2.5 queries/hr` break-even could not be verified from API telemetry and are labeled **`unverified`**.
6. **Out of Scope:** OpenAI (`GPT-6` / `prompt_cache_key` / `configuration_update`), multi-tenant self-hosted vLLM/SGLang `cache_salt` latency timing (`Item 8`), and unmeasured Gemini pricing schedules were not executed.
7. **Telemetry Store Policy:** External billing databases were queried strictly read-only (`phase0_rate_card.json` / `/api/v1/key`), with zero persistent cloud caches left alive (all `T3c` Gemini caches deleted `HTTP 200`).

---

## 2. Master Claims & Hypotheses Verdict Matrix

| Item | Attachment Claim / Hypothesis | Measured vs Inferred | Verdict | Empirical Evidence Summary |
| :--- | :--- | :--- | :---: | :--- |
| **#1** | One-off model ping-pong detour costs "8 to 10x" more & takes "up to 19 turns" to break even | Measured (short chat) | **Partly confirmed on 5.5 (refuted on 4.6 short chat)** | Prior short-chat `4.6` work showed `5.7x` / `9–12` turns (`Opus 4.6 <-> Sonnet 4.6`), and in `R1` ping-pong `SW` cost `1.211x` `M`. On `5.5` (`0.05x` read tier, `one_switch_55`), switching `Opus 5.5 -> Sonnet 5.5` at `T6` wiped cache (`0` read, `7.8x` switch turn, `$0.0584` penalty) vs `~$0.00425/turn` saving -> **~`14`-turn payback** (still `1.146x` over 12t) |
| **#1 (R1)** | Isolated `<1k` side call avoids cache invalidation without losing lookup accuracy | Measured | **Confirmed** | `R1` `SC` (\$0.1463 [\$0.1443–\$0.1465]) saved **27%** vs `SW` (\$0.2004 [\$0.2001–\$0.2021]) and beat `M` (\$0.1655 [\$0.1644–\$0.1662]) at `0.884x` `M`, with 9/9 (100.0%, 95% CI 70.1–100.0%) lookup accuracy |
| **#2 (R2)** | Top-level `output_config.effort` change invalidates cache; per-message `role:"system"` preserves prefix | Measured (`n=3` at `max_tokens: 4,096`) | **Confirmed on 5.5 (cache kept; effort diff measured, n=3) / Confirmed cache wipe on 4.6** | On `4.6`, `EF1_46` wiped `T6` cache (`0` read / `0.0%` vs `99.4% [99.4–99.4%]` in `EF0_46`, `+38.7%` 12t cost) & rejected beta (`400`). On `5.5` (`n=3`, `max_tokens: 4,096`), all 3 arms preserved T1 cache (`R2B_MED`: `27304 [27303–27304]` read, `3321 [2717–3837]` out / `1774 [1592–2438]` thinking; `R2B_TOP_HIGH`: `27311` read, `4096 [1290–4096]` out / `2609 [1290–3008]` thinking; `R2B_BETA_HIGH`: `27311 [27311–27312]` read, `4096 [3863–4096]` out / `2778 [2509–3680]` thinking). `claude.exe@2.1.325` strips the beta header |
| **#3a** | Past 5m TTL pays rebuilds; 1h TTL avoids misses and "breaks even by roughly the third turn" | Measured | **Confirmed (TTL mechanism) / Refuted ("3rd turn")** | `TTL5` hit at `4m` (3/3) and expired at `6m` (0/3); `TTL1H` hit through `30m` (3/3) and scored 0/1 at `62m` (`TTL5_62m`: 0/1). Because `2.0x + 0.1x = 2.1x < 1.25x + 1.25x = 2.5x`, **1h breaks even at Turn 2 (1 post-gap request)** |
| **#3b** | Keep-alive pings prevent 5m expiration (`max_tokens: 0` refreshes without output cost) | Measured | **Confirmed (`KA-zero` Direct API only)** | Both `KA-read` (`out=1`, `openrouter`, 5/5 hits) and `KA-zero` (`out=0`, `anthropic_direct`, 5/5 hits) refreshed across `22.5m`. OpenRouter ignores `max_tokens: 0` (emits output); up to **12 pings** (`~54m`) cost less than 1 cold rewrite |
| **#3c** | Gemini 3.1 Pro storage costs `$4.50/M tokens/hr` and requires `2.5 queries/hr` break-even | Measured (tokens) / Unverified (USD) | **Unverified** | `cachedContents.create` & `generateContent` (`34.5k` tok) reported token counts & TTL timestamps cleanly (`cachedTok=34542`), but emitted **zero USD price/cost fields** in JSON responses |
| **#4** | Simultaneous parallel cold workers all miss & write cache; `max_tokens: 0` or `1` primer fixes it | Measured | **Confirmed (Primer) / Zero OR Scatter Observed** | At `N=10`, `P0` had 10/10 write (\$0.7516 [\$0.6836–\$0.7525]); `P1` (`0`, direct computed) & `P2` (`1`, OR billed) achieved **10/10 worker hits** (\$0.1414 [\$0.1413–\$0.1416], **~81.2% savings**; `N=25`: `24/25` vs `25/25` = **86.6% cheaper**), adding ~1.0s primer latency |
| **#5** | Sliding window yields **"0% hit rate"**; 50% cliff gives **"90–95% hits"**; prose summary drops negative constraints vs structured `STATE` | Measured | **Refuted (0% literal) / Cliff 90–95% Confirmed / STATE vs Prose: inconclusive: harness truncation** | Sliding `B` hit 13.8% post-trim (static `tools6 + sys` ~`3.2k` survives; `16` rebuilds, \$1.4215 [\$1.4203–\$1.4230]). Cliff `C` hit **92.4% [92.4–92.4%]** steady. `C5_PRAGMA_TABS` failed `15/15` everywhere (incl. `0/3` in `A`); excl. broken `C5`, `A`=`12/12` while `E` (`5/12`) vs `D` (`2/12`) is **inconclusive: harness truncation** (`9/9` `E` hit `350/350` & overwrote state; `9/9` `D` hit `500/500`) |
| **#6** | Changing tools invalidates tools+system+history; system edits preserve tools; tail RAG/defer preserves all prior layers | Measured | **Confirmed (with `claude.exe` nuances)** | `TS`/`TF`/`TK`/`TA` all yielded `0` cache read (`none`). `SY` kept `tools_only` (`6,059`); `MRAG` kept `tools+system+history` (`15,126`); `TSTUB` kept `tools+system+history` (`9,265` vs `9,268` `T5` prompt, cheaper via `~4.8k` stub). CLI: `CC-M` tail-appended `CLAUDE.md` V2 (`14,440` read); `CC-S` ignored `--append-system-prompt` (`14,992` read) |
| **#7** | Instruction-following drops sharply past roughly `100–250` rules (`AGENTS.md` / `CLAUDE.md`) | Measured | **Refuted (sharp `100–250` cliff on Sonnet 4.6) / Confirmed (token-cost tax)** | API strict 5/5 pass went 58/60 (96.7%, 95% CI 88.6–99.1%) (`S=10`) -> 54/60 (90.0%, 95% CI 79.9–95.3%) (`S=500`); per-rule compliance dipped `-1.3 pp` (`99.3% -> 98.0%`), with failures driven almost solely by `LEN` (`2 -> 1 -> 3 -> 3 -> 6` failures/30 across `S=10..500`; `<=1/30` all other rules). `CLAUDE.md` scored `100.0%` (`20/20`); 3-seed API block cost rose `4.05x` (`$0.19 -> $0.79`, single-seed `$0.0646 -> $0.2635`) and `CLAUDE.md` `5.77x` (`$0.3710 -> $2.1401`) |
| **#8** | Self-hosted vLLM/SGLang cross-tenant prefix cache timing side-channel (`cache_salt`) | Security Note (Out of Scope) | **Unverified / Out of Scope** | No self-hosted vLLM/SGLang cluster used; Section 9 protocol note included below |

---

## 3. T4: Parallel Cold Start (`t4_parallel.csv`)

Prefix: ~`20k` tokens (`anthropic/claude-sonnet-4.6`). `P0, P2, P3, P0_N25` billed via OpenRouter; `P1, P1_N25` computed via Direct Anthropic (`max_tokens: 0` unsupported on OpenRouter).

| Arm | Route (Cost Source) | N / Reps | Workers Wrote / Read | Primer Wall (ms) | Total Arm Wall (ms) | Total Cost USD |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `P0` | `openrouter` (billed) | N=10 / n=3 | 10 [9–10] wrote / 0 [0–1] read | 0 | 3048.5ms [2801.9–3913.5ms] | \$0.751605 [\$0.683629–\$0.752452] |
| `P1` | `anthropic_direct` (computed) | N=10 / n=3 | 0 wrote / 10 read | 967.4ms [923.4–1237.4ms] | 3470.1ms [3388.6–3665.7ms] | \$0.141512 [\$0.141446–\$0.141547] |
| `P2` | `openrouter` (billed) | N=10 / n=3 | 0 wrote / 10 read | 1023.6ms [942.2–1605.4ms] | 4685.3ms [3299.3–5248.7ms] | \$0.141399 [\$0.141331–\$0.141586] |
| `P3` | `openrouter` (billed) | N=10 / n=3 | 1 wrote / 9 read | 0 | 20899.6ms [19320.2–30950.8ms] | \$0.135291 [\$0.135134–\$0.135359] |
| `P0_N25` | `openrouter` (billed) | N=25 / n=1 | 24 wrote / 1 read | 0 | 3976.8ms | \$1.813115 |
| `P1_N25` | `anthropic_direct` (computed) | N=25 / n=1 | 0 wrote / 25 read | 1048.1ms | 3901.4ms | \$0.242618 |

All `P1` and `P1_N25` primer requests emitted `output_tokens = 0`. Zero post-primer OpenRouter/Anthropic shard misses occurred (`0` scatter writes across `P1`, `P2`, `P1_N25`).

---

## 4. T6: Prefix Layer Invalidation Matrix (`t6_layers.csv`)

Measured layer sizes (OpenRouter Sonnet 4.6): `tools20` = **6347** tokens, `tools20+system` = **9386** tokens (`system` ~ **3039** tokens); `TSTUB` 1-tool stub `tools+system` = **`~4.8k`** tokens (`4,811` read at `T2`). All USD figures `billed` via OpenRouter (`n = 3`, 12 turns).

| Arm | T6 Mutation | Surviving Layers | T6 Cache Read Tokens | T7 Cache Read Tokens | T6 Cost (billed) | 12-Turn Total Cost (billed) |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| `C` | Control (no change) | `tools+system+history` | 15043 [15001–15062] | 16220 [16178–16239] | \$0.0104 [\$0.0104–\$0.0104] | \$0.1600 [\$0.1599–\$0.1602] |
| `TS` | Drop 5 tools at T6 | `none` | 0 | 14809 [14776–14822] | \$0.0570 [\$0.0569–\$0.0571] | \$0.2046 [\$0.2042–\$0.2047] |
| `TF` | Resample tool subset every turn from T2 | `none` | 0 | 0 | \$0.0570 [\$0.0568–\$0.0571] | \$0.7182 [\$0.7161–\$0.7191] |
| `TK` | Shuffle JSON keys inside tool schemas at T6 | `none` | 0 | 16262 [16240–16303] | \$0.0625 [\$0.0624–\$0.0626] | \$0.2125 [\$0.2123–\$0.2128] |
| `TA` | Append 1 tool at end at T6 | `none` | 0 | 16553 [16532–16553] | \$0.0636 [\$0.0635–\$0.0636] | \$0.2141 [\$0.2139–\$0.2141] |
| `SY` | Add 1 sentence to system prompt at T6 | `tools_only` | 6059 [6039–6079] | 16280 [16260–16302] | \$0.0417 [\$0.0416–\$0.0417] | \$0.1917 [\$0.1916–\$0.1919] |
| `SRAG` | Replace retrieved passages in system from T2 | `tools+system` | 9105 [9105–9126] | 9105 [9105–9126] | \$0.0330 [\$0.0330–\$0.0330] | \$0.4626 [\$0.4626–\$0.4627] |
| `MRAG` | Append retrieved passages to latest user msg from T2 | `tools+system+history` | 15126 [15126–15128] | 16303 [16301–16305] | \$0.0119 [\$0.0119–\$0.0119] | \$0.1795 [\$0.1795–\$0.1795] |
| `TSTUB` | Static tool-search stub; defer full schema into T6 user msg | `tools+system+history` | 9265 [9151–9343] | 12258 [12143–12336] | \$0.0155 [\$0.0155–\$0.0155] | \$0.1296 [\$0.1270–\$0.1301] |
| `ME` | Edit early T2 message at T6 | `approx_10488tok` | 10509 [10488–10509] | 16224 [16202–16224] | \$0.0261 [\$0.0261–\$0.0261] | \$0.1758 [\$0.1757–\$0.1759] |
| `CC-T` | CLI resume with swapped --mcp-config (10 tools) | `none(tools_changed)` | 0 | 18175 [18121–18180] | \$0.0706 [\$0.0703–\$0.0711] | \$0.2323 [\$0.2293–\$0.2335] |
| `CC-M` | CLI resume after editing CLAUDE.md between T5 & T6 | `tools+system+history` | 14440 [14375–14514] | 14924 [14855–15015] | \$0.0092 [\$0.0087–\$0.0092] | \$0.1668 [\$0.1658–\$0.1709] |
| `CC-S` | CLI resume with modified --append-system-prompt | `tools+system+history` | 14992 [14941–15038] | 15311 [15239–15356] | \$0.0082 [\$0.0079–\$0.0082] | \$0.1655 [\$0.1630–\$0.1670] |

**`TSTUB` Stub Prefix & Survivability:** `TSTUB` uses a single `tool_search` stub whose `tools+system` prefix is **`~4.8k` tokens** (`4,811` cache read at `T2`) rather than the `~9.4k` 20-tool layout. At `T6`, `TSTUB` read `9,265 [9,151–9,343]` tokens out of its `9,268 [9,154–9,346]` `T5` prompt, proving that the full **`tools+system+history`** prefix survived; its lower 12-turn total cost (`$0.1296` vs `$0.1600` control `C`, `-19.0%`) comes from carrying the smaller `~4.8k` stub prefix across turns rather than partial invalidation.

**Surprising CLI Behavior (`claude.exe@2.1.325`):** Editing `CLAUDE.md` between T5 and T6 (`CC-M`) did **not** invalidate the prefix because the CLI kept V1 in `messages[0]` and appended V2 at the tail (`14,440` cache read); changing `--append-system-prompt` on `--resume` (`CC-S`) was ignored on wire (`14,992` read). Only `--mcp-config` tool schema replacement (`CC-T`) wiped cache (`0` read).

---

## 5. T3: Idle Past TTL, Keep-Alive & Gemini Explicit Cache (`t3_idle.csv`)

### T3a: 5-Minute vs 1-Hour Cache Across Idle Gaps (~`17.6k` prefix, Sonnet 4.6, `billed` via OpenRouter)

| Arm (Gap) | n | Hits / Total | Actual Idle (min) | Req 2 Cache Read Tokens | Req 1 Write Cost (billed) | Req 2 Cost (billed) | 2-Req Total (billed) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `TTL5_4m` | 3 | 3/3 | 4.00m | 17563 [17562–17565] | \$0.0660 [\$0.0660–\$0.0660] | \$0.0060 [\$0.0060–\$0.0060] | \$0.0720 [\$0.0720–\$0.0721] |
| `TTL1H_4m` | 3 | 3/3 | 4.00m | 17564 [17561–17566] | \$0.1055 [\$0.1055–\$0.1056] | \$0.0060 [\$0.0060–\$0.0060] | \$0.1115 [\$0.1115–\$0.1116] |
| `TTL5_6m` | 3 | 0/3 | 6.00m | 0 | \$0.0660 [\$0.0660–\$0.0660] | \$0.0666 [\$0.0666–\$0.0666] | \$0.1326 [\$0.1326–\$0.1327] |
| `TTL1H_6m` | 3 | 3/3 | 6.00m | 17564 | \$0.1055 | \$0.0060 [\$0.0060–\$0.0060] | \$0.1115 [\$0.1115–\$0.1116] |
| `TTL5_12m` | 3 | 0/3 | 12.00m | 0 | \$0.0660 [\$0.0660–\$0.0660] | \$0.0666 [\$0.0666–\$0.0666] | \$0.1326 |
| `TTL1H_12m` | 3 | 3/3 | 12.00m | 17564 [17561–17565] | \$0.1055 [\$0.1055–\$0.1055] | \$0.0060 [\$0.0060–\$0.0060] | \$0.1116 [\$0.1115–\$0.1116] |
| `TTL5_30m` | 3 | 0/3 | 30.00m | 0 | \$0.0660 [\$0.0660–\$0.0660] | \$0.0666 [\$0.0666–\$0.0666] | \$0.1326 [\$0.1326–\$0.1326] |
| `TTL1H_30m` | 3 | 3/3 | 30.00m | 17563 [17563–17565] | \$0.1055 [\$0.1055–\$0.1055] | \$0.0060 [\$0.0060–\$0.0061] | \$0.1116 [\$0.1115–\$0.1116] |
| `TTL5_62m` | 1 | 0/1 | 62.00m | 0 | \$0.0660 | \$0.0666 | \$0.1326 |
| `TTL1H_62m` | 1 | 0/1 | 62.00m | 0 | \$0.1055 | \$0.1061 | \$0.2117 |

**Break-Even Turn Analysis:** Comparing a session that experiences one idle pause `>5m`: `TTL5` pays `write5m` (\$0.0660, `1.25x`) + expired `write5m` (\$0.0666, `1.25x`) = **\$0.1326** (`2.50x`), whereas `TTL1H` pays `write1h` (\$0.1055, `2.00x`) + cache read (\$0.0060, `0.10x`) = **\$0.1116** (`2.10x`). Thus `TTL1H` already breaks even at **Turn 2 (`1` post-gap request)** — earlier than the attachment claim of "roughly the third turn".

### T3b: Keep-Alive Pings (`6` pings spaced `4.5m`, `n = 2`)

| Arm | Route (Cost Source) | n | Hit Pings / 5 | Max Out Tokens | Keep-Alive Overhead (5 pings) | 6-Ping Total Cost |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `KA-read` | `openrouter` (billed) | 2 | 5/5 | 1 | \$0.0266 [\$0.0266–\$0.0266] (billed) | \$0.0925 [\$0.0924–\$0.0925] (billed) |
| `KA-zero` | `anthropic_direct` (computed) | 2 | 5/5 | 0 | \$0.0265 [\$0.0265–\$0.0265] (computed) | \$0.0924 [\$0.0924–\$0.0924] (computed) |

Measured read-ping cost was **\$0.00531** (`KA-read`, `billed`) and **\$0.00530** (`KA-zero`, `computed`) vs **\$0.0660** cold `5m` rewrite — up to **12 keep-alive pings (~54m idle)** cost less than 1 cold rewrite, while `1h` TTL beats keep-alive once `>= 8` pings (~36m) would be needed.

### T3c: Gemini Explicit Cache (`models/gemini-3.1-pro-preview`, `ttl: "3600s"`)

- **`GEM_0Q` (`0` queries):** Created cache (`totalTokenCount=34542`, `ttl=3600s`, keys=`[name, model, createTime, updateTime, expireTime, displayName, usageMetadata]`, hasBillingUsdField=`false`), held ~20s, deleted (`HTTP 200`).
- **`GEM_3Q` (`3` queries):** Created cache (`totalTokenCount=34542`), issued 3 `generateContent` queries (cached tokens read = `[34542, 34542, 34542]`, `hasBillingUsdField=false`), deleted (`HTTP 200`).
- **Verification Status:** Token counts and TTL expiry metadata verified; USD storage price (`$4.50/M tokens/hr`) and `2.5 queries/hr` break-even remain **`unverified`** via API responses.

---

## 6. T5: History Trimming & Constraint Retention (`t5_trim.csv`)

30 turns on `anthropic/claude-sonnet-4.6` (`OpenRouter`, all costs `billed` including auxiliary summary/state calls in `D` & `E`), artificial budget `W = 24,000` tokens (`~3.2k` static `tools6 + sys` + ~`1k` corpus slice/turn). 5 negative constraints planted at `T2–T6`; 5 deterministic bait prompts at `T24, T25, T26, T28, T30` (`n = 3`). Because `C5_PRAGMA_TABS` failed `15/15` across every arm (including `0/3` in no-trim control `A`), results are reported **both with (`k/15`) and excluding (`k/12`) broken `C5_PRAGMA_TABS`**.

| Arm (Policy) | n | Post-Trim Cache Hit % | Steady Post-Cliff Hit % | Rebuilds | Aux Summary Tok / Cost | All 5 Constraints (`k/15`, Wilson CI) | Excl. Broken `C5` (`k/12`, Wilson CI) | 30-Turn Total Cost (billed) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `A` | 3 | 96.1% [96.1–96.1%] | 96.1% [96.1–96.1%] | 0 | 0 tok / \$0.0000 | 12/15 (80.0%, 95% CI 54.8–93.0%) | 12/12 (100.0%, 95% CI 75.8–100.0%) | \$0.4508 [\$0.4501–\$0.4521] |
| `B` | 3 | 13.8% | 0.0% | 16 | 0 tok / \$0.0000 | 0/15 (0.0%, 95% CI 0.0–20.4%) | 0/12 (0.0%, 95% CI 0.0–24.2%) | \$1.4215 [\$1.4203–\$1.4230] |
| `C` | 3 | 81.7% [81.7–81.7%] | 92.4% [92.4–92.4%] | 3 | 0 tok / \$0.0000 | 0/15 (0.0%, 95% CI 0.0–20.4%) | 0/12 (0.0%, 95% CI 0.0–24.2%) | \$0.4845 [\$0.4818–\$0.4856] |
| `D` | 3 | 81.3% [81.3–81.4%] | 92.5% [92.5–92.8%] | 3 | 1500 tok / \$0.0564 [\$0.0563–\$0.0567] | 2/15 (13.3%, 95% CI 3.7–37.9%) | 2/12 (16.7%, 95% CI 4.7–44.8%) | \$0.5505 [\$0.5493–\$0.5509] |
| `E` | 3 | 81.8% [81.8–81.8%] | 92.6% [92.6–92.6%] | 3 | 1050 tok / \$0.0538 [\$0.0536–\$0.0540] | 5/15 (33.3%, 95% CI 15.2–58.3%) | 5/12 (41.7%, 95% CI 19.3–68.0%) | \$0.5367 [\$0.5348–\$0.5368] |

### Per-Constraint Breakdown & Broken `C5_PRAGMA_TABS` Probe (`pass/3` per arm)

| Arm | `C1_PORT_9411` (`T2->T24`) | `C2_HEADER_GUARD` (`T3->T25`) | `C3_ERR_CHUNK` (`T4->T26`) | `C4_OVERRIDE_FILE` (`T5->T28`) | `C5_PRAGMA_TABS` (`T6->T30`, Broken) | Valid Subtotal (`C1–C4`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `A` | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 12/12 |
| `B` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/12 |
| `C` | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/12 |
| `D` | 1/3 | 1/3 | 0/3 | 0/3 | 0/3 | 2/12 |
| `E` | 3/3 | 1/3 | 1/3 | 0/3 | 0/3 | 5/12 |

- **Why `C5_PRAGMA_TABS` is treated as a broken probe (`0/15`):** Its `T30` bait prompt asked the model to output `"only the compliant comment pragma and brief reason; do not include banned directives"`, while `check()` rejected any text matching `/eslint-disable/i`. Even in untrimmed `A` (`3/3` on `C1–C4`), all `3` replies echoed why `eslint-disable` is disallowed in their `"brief reason"`, triggering false-positive violations (`15/15` fails across all 5 arms). Excluding broken `C5`, untrimmed `A` scored `12/12` (`100.0%`), while **`STATE` (`E`, `5/12`) vs prose (`D`, `2/12`) is `inconclusive: harness truncation`** because both auxiliary cliff summary pipelines hit their `max_tokens` limits (`9/9` calls each).

### Arm `E` vs Arm `D` Comparison: **`inconclusive: harness truncation`**

In `run_t5_trim.mjs`, `E` seeded `system[1]` with `<STRUCTURED_STATE_FILE>{"negative_constraints":[],"verified_paths":[],"dead_ends":[]}</STRUCTURED_STATE_FILE>` and updated it at each 50% cliff with `max_tokens: 350`, whereas `D` summarized evicted pairs into prose with `max_tokens: 500` (and evicted the prior `[PROSE SUMMARY OF EARLIER TURNS]` pair into the next summary call at Cliffs 2–3). Every single auxiliary call in both `E` (`9/9` at `350/350`) and `D` (`9/9` at `500/500`) truncated at its output cap. *(Note: `t5_checkpoint_rows.jsonl` logged per-cliff token, eviction, and cost telemetry without persisting raw `assistantText` strings to disk.)*

#### Arm `E` `state_update_call` Telemetry (`9/9` Hit `max_tokens: 350`)

| Arm `E` Cliff Turn (`rep=1..3`) | Evicted Window (`pairs`) | Active Pairs Remaining | Prompt Tokens (`median [min–max]`) | Output Tokens (`cap=350`) | State Update Cost (`billed`) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Cliff 1 (`T15`, before baits) | `7` (`T1–T7`: all `C1–C5` + `parser.mjs`) | 7 | 3978 [3882–4017] | 350 (`3/3` capped) | \$0.0172 [\$0.0169–\$0.0173] |
| Cliff 2 (`T22`, before baits) | `7` (`T8–T14`: code slices only) | 7 | 4457 [4446–4458] | 350 (`3/3` capped) | \$0.0186 [\$0.0186–\$0.0186] |
| Cliff 3 (`T29`, after `C1–C4` baits) | `7` (`T15–T21`: code slices only) | 7 | 4268 [4263–4269] | 350 (`3/3` capped) | \$0.0181 [\$0.0180–\$0.0181] |

#### Arm `D` Prose `summary_call` Telemetry (`9/9` Hit `max_tokens: 500`)

| Arm `D` Cliff (`rep=1..3`) | Turn(s) | Evicted Window (`pairs`) | Prompt Tokens (`median [min–max]`) | Output Tokens (`cap=500`) | Summary Cost (`billed`) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Cliff 1 (`rep 1..3`) | `T15` | `T1–T7` (all `C1–C5` + slices) | 3821 [3790–3955] | 500 (`3/3` capped) | \$0.0190 [\$0.0189–\$0.0194] |
| Cliff 2 (`rep 1..3`) | `T22` | Prior `SUMMARY` pair + `T8–T13/14` | 3877 [3858–3878] | 500 (`3/3` capped) | \$0.0191 [\$0.0191–\$0.0191] |
| Cliff 3 (`rep 1..3`) | `T27/T28` | Prior `SUMMARY` pair + `T14/15–T20/21` | 3612 [3596–3616] | 500 (`3/3` capped) | \$0.0183 [\$0.0183–\$0.0183] |

- **Why `C4_OVERRIDE_FILE` (`overrides.local.mjs`, planted `T5`, bait `T28`) was lost in `3/3` `E` runs & `D` also degraded:** (1) `9/9` `E` `state_update_call`s truncated at `max_tokens: 350` across two unvalidated overwrites (`T15`, `T22`) before `T28`, dropping `C4` in `3/3` sessions (`C1 3/3`, `C2 1/3`, `C3 1/3`, `C4 0/3`). (2) `9/9` `D` `summary_call`s likewise hit `max_tokens: 500` (`1,500` out tokens/session) and `D` folded prior summaries into subsequent `500`-token-capped summaries (`C1 1/3`, `C2 1/3`, `C3 0/3`, `C4 0/3`). Because both truncated on every call, **`E` vs `D` is `inconclusive: harness truncation`**.

#### Fixed Arm `E` Rerun Design & Cost Estimate (Not Executed)

- **Fixed Design (`run_t5_trim.mjs`, unexecuted):** (1) Raise `state_update_call` ceiling to **`max_tokens: 1,500`** (`stop_reason` + raw `stateJsonText` persisted to checkpoint JSONL); (2) replace `stateJsonText = stateRes.assistantText` overwrite with **programmatic JSON parse + deterministic set-union merge** (`negative_constraints`, `verified_paths`, `dead_ends`) against the prior state object; (3) run a **post-update validator** after every cliff asserting `stop_reason === "end_turn"` and presence of every previously evicted constraint anchor (`9411`, `X-Session-Guard: strict-v2`, `ERR_CHUNK_SPLIT`, `overrides.local.mjs`, `// @strict-tabs`), retrying once before deterministic anchor preservation.
- **Estimated OpenRouter Cost (`anthropic/claude-sonnet-4.6`, `2026-11-15` `$3/M` in / `$15/M` out / `$3.75/M` `write5m` / `$0.30/M` `read`, `n = 3`):** **`~$1.72` expected** (~`$0.495` chat turns + ~`$0.078` across 3 cliff calls = ~`$0.573`/session) and **`~$2.15` hard ceiling** (all 9 cliff calls hitting `1,500` output tokens + validation retry headroom; adding a matched `D_fixed` at `max_tokens: 1,500` would add ~`$1.75` expected). *(Not executed unless requested.)*

**T5 Takeaway:** Sliding-window eviction (`B`) still preserved 13.8% post-trim cache hits because the static `tools6 + sys` prefix (~`3.2k` tokens) remained stable across turns, refuting a literal `"0%"` hit rate — yet rebuilding the shifting message tail every post-window turn triggered `16` full rebuilds (\$1.4215 [\$1.4203–\$1.4230] vs \$0.4508 [\$0.4501–\$0.4521] no-trim `A` and \$0.4845 [\$0.4818–\$0.4856] cliff `C`). Batching evictions at 50% cliffs (`C`, `D`, `E`) achieved `92.4%–92.6%` steady post-cliff cache hits (`3` rebuilds), confirming the `90–95%` cliff expectation. On constraint retention, excluding broken `C5`, untrimmed `A` preserved `12/12` (`100.0%`), whereas `E` (`5/12`) vs `D` (`2/12`) is **`inconclusive: harness truncation`** because every summary/state update in both arms hit `max_tokens` (`350`/`500`).

---

## 7. T7: Rule Stuffing Accuracy Sweep (`t7_rules.csv`, Option 7B)

Sonnet 4.6 (`OpenRouter`, `billed`). 3 seeds (`ALPHA`, `BRAVO`, `CHARLIE`) x 20 balanced probes (`5` triggered rules per probe, `100` active rule checks per `(S, seed)`, `300` checks per `S`, `60` total API probes per `S`). Rules block written once per `(S, seed)` and read from cache across probes `2–20` when `>= 1,024` tokens (`S >= 50`).

| Harness / S | Total Rule Checks | Strict Task Pass (5/5, Wilson CI) | Per-Rule Compliance (Wilson CI) | Top / Middle / Bottom Tertile % | Rules Write (`computed`) | Rules Read (`computed`) | Single-Seed 20t (`billed`) | 3-Seed 60-Probe API Block (`billed`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| API `S=10` | 300 | 58/60 (96.7%, 95% CI 88.6–99.1%) | 298/300 (99.3%, 95% CI 97.6–99.8%) | 100.0% / 100.0% / 97.8% | \$0.00000 | \$0.00000 | \$0.0646 [\$0.0645–\$0.0658] | \$0.1949 (\$0.19) |
| API `S=50` | 300 | 59/60 (98.3%, 95% CI 91.1–99.7%) | 298/300 (99.3%, 95% CI 97.6–99.8%) | 100.0% / 99.2% / 98.9% | \$0.00000 [\$0.00000–\$0.00887] | \$0.00071 [\$0.00000–\$0.00071] | \$0.0595 [\$0.0588–\$0.0612] | \$0.1794 (\$0.18) |
| API `S=100` | 300 | 57/60 (95.0%, 95% CI 86.3–98.3%) | 297/300 (99.0%, 95% CI 97.1–99.7%) | 100.0% / 100.0% / 96.7% | \$0.00000 [\$0.00000–\$0.01775] | \$0.00142 [\$0.00000–\$0.00142] | \$0.0812 [\$0.0798–\$0.0858] | \$0.2468 (\$0.25) |
| API `S=250` | 300 | 57/60 (95.0%, 95% CI 86.3–98.3%) | 297/300 (99.0%, 95% CI 97.1–99.7%) | 100.0% / 100.0% / 96.7% | \$0.00000 [\$0.00000–\$0.04439] | \$0.00355 [\$0.00000–\$0.00355] | \$0.1491 [\$0.1487–\$0.1504] | \$0.4482 (\$0.45) |
| API `S=500` | 300 | 54/60 (90.0%, 95% CI 79.9–95.3%) | 294/300 (98.0%, 95% CI 95.7–99.1%) | 100.0% / 100.0% / 93.3% | \$0.00000 [\$0.00000–\$0.08886] | \$0.00711 [\$0.00000–\$0.00711] | \$0.2635 [\$0.2601–\$0.2660] | \$0.7896 (\$0.79) |
| `CLAUDE.md` `S=10` (n=1) | 100 | 20/20 (100.0%, 95% CI 83.9–100.0%) | 100/100 (100.0%, 95% CI 96.3–100.0%) | — | — | — | Block \$0.3710 | — |
| `CLAUDE.md` `S=100` (n=1) | 100 | 20/20 (100.0%, 95% CI 83.9–100.0%) | 100/100 (100.0%, 95% CI 96.3–100.0%) | — | — | — | Block \$0.6521 | — |
| `CLAUDE.md` `S=500` (n=1) | 100 | 20/20 (100.0%, 95% CI 83.9–100.0%) | 100/100 (100.0%, 95% CI 96.3–100.0%) | — | — | — | Block \$2.1401 | — |

### Per-Rule Failure Breakdown (`out of 30 checks per S`)

- **`LEN` (Word-Count Window) Drives Nearly Every Failure (`15/16` total failures):** Failures on `LEN` across `S = 10..500` were `S=10`: **2/30**, `S=50`: **1/30**, `S=100`: **3/30**, `S=250`: **3/30**, `S=500`: **6/30**.
- **All Other 9 Rule Dimensions Combined Had Only `1` Failure Total Across `1,350` Checks:** `LIST` missed `1/30` at `S=50` (`0/30` at `S=10, 100, 250, 500`); `HDR`, `END`, `BDG`, `BAN`, `KW`, `NUM`, `PUNC`, and `META` each scored **`30/30` (`0` failures)** at every rule count `S`.
- **Block Cost Scaling (`billed`):** Total 3-seed API block cost across `S = 10 -> 50 -> 100 -> 250 -> 500` ran **`$0.19 -> $0.18 -> $0.25 -> $0.45 -> $0.79`** (`$0.1949 -> $0.7896`; per-20-task-seed median `$0.0646 -> $0.2635`), while single-seed 20-task `CLAUDE.md` cost rose **`$0.3710 -> $0.6521 -> $2.1401`** (`5.77x`).

**T7 Takeaway:** The hypothesized sharp instruction-following collapse past `100–250` rules did **not** occur on Sonnet 4.6 under this orthogonal 5-of-10 deterministic rubric: API per-rule compliance dipped by only `1.3 percentage points` (`99.3% -> 98.0%`, `96.7% -> 90.0%` strict 5/5 task pass), driven almost entirely by the `LEN` word-count constraint (`2 -> 6` failures out of `30`), and `claude.exe@2.1.325` (`CLAUDE.md`) scored `100.0%` (`20/20`) at `S=10, 100, 500`. Meanwhile, 3-seed API block cost rose `4.05x` (`$0.19 -> $0.79`) and `CLAUDE.md` `5.77x`, indicating that prompt bloat penalizes token cost immediately while severe accuracy collapse likely requires conflicting rules or long multi-turn dilution.

---

## 8. Remedies R1 & R2 (`r1_sidecall.csv`, `r2_effort.csv`)

### R1: Isolated Side Call vs Model Ping-Pong (OpenRouter, `billed`, `n = 3`, 12 turns)

| Arm | n | Main Thread Cache Hit % | Side-Call Cost (billed) | Total Cost USD (billed) | Lookup Accuracy (Wilson CI) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `M` | 3 | 91.2% [91.2–91.2%] | \$0.00000 | \$0.1655 [\$0.1644–\$0.1662] | 9/9 (100.0%, 95% CI 70.1–100.0%) |
| `SW` | 3 | 82.4% [82.3–82.4%] | \$0.00000 | \$0.2004 [\$0.2001–\$0.2021] | 9/9 (100.0%, 95% CI 70.1–100.0%) |
| `SC` | 3 | 88.3% [88.3–88.4%] | \$0.00155 | \$0.1463 [\$0.1443–\$0.1465] | 9/9 (100.0%, 95% CI 70.1–100.0%) |

`SC` cost **0.884x** `M` and reduced spend by **27%** vs `SW`.

### R2: Per-Message Effort Control via Direct Anthropic API (`computed`, `n = 3`, 12 turns)

Pre-check on `claude-sonnet-5-5` (**`supported, n=1`** behavioral + cache evidence): probing off the same omitted-`output_config` prefix read **`27297`** tokens on `high` (`output_tokens = 550`, `TWELVE_PROMPTS[5]`, `max_tokens: 550`) and **`27297`** tokens on `medium` (`output_tokens = 99`, `TWELVE_PROMPTS[1]`, `max_tokens: 180`; `verifiedDefaultEffort = "high"`).

| Arm | Model | n | T6 Cache Read Share | T7 Cache Read Share | T6+T7 Out Tokens (Cap=550/t) | T6 Latency (ms) | 12-Turn Computed Cost |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `EF0` | `claude-sonnet-5-5` | 3 | 99.7% [99.0–99.7%] | 99.7% [99.7–99.7%] | 1100 | 6066ms [5846–6380ms] | \$0.1285 [\$0.1277–\$0.1293] (`computed`) |
| `EF1` | `claude-sonnet-5-5` | 3 | 99.7% | 99.7% | 1100 | 5938ms [5347–6547ms] | \$0.1282 [\$0.1278–\$0.1288] (`computed`) |
| `EF2` | `claude-sonnet-5-5` | 3 | 99.2% [99.2–99.7%] | 99.7% [99.7–99.7%] | 1100 | 5542ms [5072–5629ms] | \$0.1287 [\$0.1279–\$0.1287] (`computed`) |
| `EF3` | `claude-sonnet-5-5` | 3 | 99.7% | 99.7% | 1100 | 5833ms [5304–6301ms] | \$0.1286 [\$0.1282–\$0.1286] (`computed`) |
| `EF0_46` | `claude-sonnet-4-6` | 3 | 99.4% [99.4–99.4%] | 97.1% | 1100 | 11857ms [11366–13109ms] | \$0.1847 [\$0.1831–\$0.1866] (`computed`) |
| `EF1_46` | `claude-sonnet-4-6` | 3 | 0.0% | 97.1% | 1100 | 11540ms [11323–12053ms] | \$0.2561 [\$0.2547–\$0.2591] (`computed`) |

**Caveat on Output Caps in 12-Turn `R2` (`550`) & `currency_55` (`150`):** Across the `219` initial rows in `r2_effort.csv`, streaming SSE usage dropped `thinking_tokens` (`thinking_chars = 0`), and every `T6` and `T7` reply in **all 6 main arms including `medium` controls** hit the `550`-token output cap (`550 + 550 = 1,100`; likewise every turn in `currency_55.csv` hit `150/150`). Those 12-turn runs therefore establish **cache preservation on `5.5`** (`99.7%` `T6` read share in `EF1`, `99.2%` in `EF2`, `1.000x` in OpenRouter `effort_only_55`) vs **cache wipe on `4.6`** (`0.0%` `T6` read share in `EF1_46`, `+38.7%` cost; beta rejected `HTTP 400`), while `claude.exe@2.1.325` strips the beta header on wire (`forwardedMidEffortBeta=false`).

#### Direct-API `R2` Behavioral Rerun at `max_tokens: 4,096` (`claude-sonnet-5-5`, `n = 3`, `computed`)

Each session primes Turn 1 at top-level `effort: "medium"` (`max_tokens: 200`, `~27.3k` prefix), then runs `TWELVE_PROMPTS[5]` on Turn 2 (`max_tokens: 4,096`, `stream: false`, cap `$1.62` total `computed`):

| Arm (`n=3` each) | T2 Cache Read Tokens (Share %) | T2 Total Output Tokens | T2 Thinking Tokens | T2 Visible Text Tokens | T2 Stop Reasons | T2 Latency (ms) | 2-Turn Cost (`computed`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `R2B_MED`: (a) top-level medium (control) | 27304 [27303–27304] (99.33%) | 3321 [2717–3837] | 1774 [1592–2438] | 1399 [1125–1547] | `end_turn (3/3)` | 25996ms [21471–29365ms] | \$0.1056 [\$0.0995–\$0.1107] |
| `R2B_TOP_HIGH`: (b) top-level high | 27311 (99.32% [99.32–99.35%]) | 4096 [1290–4096] | 2609 [1290–3008] | 1088 [0–1487] | `refusal (1/3), max_tokens (2/3)` | 30605ms [12377–31231ms] | \$0.1134 [\$0.0852–\$0.1134] |
| `R2B_BETA_HIGH`: (c) per-message beta high | 27311 [27311–27312] (99.32% [99.31–99.38%]) | 4096 [3863–4096] | 2778 [2509–3680] | 1318 [416–1354] | `max_tokens (2/3), end_turn (1/3)` | 32795ms [30513–34057ms] | \$0.1134 [\$0.1108–\$0.1134] |

- **Total Rerun Cost & Termination:** \$0.9655 (`computed`, within `$1.62` cap) across `9/9` HTTP 200 sessions (`T1` at `medium` emitted `0` thinking tokens on all `9/9` sessions).
- **Behavioral Comparison (`(b)` & `(c)` vs `(a)`):** Both `(b)` and `(c)` materially increased adaptive thinking and total output tokens vs `(a)` while preserving the full `~27,311`-token Turn-1 cache (`99.32%` read share). Control `(a) R2B_MED` finished `3/3` `end_turn` below cap at **1774 [1592–2438]** thinking / **3321 [2717–3837]** output tokens. High-effort `(b) R2B_TOP_HIGH` rose to **2609 [1290–3008]** thinking (**+835**, `1.471x`) and **4096 [1290–4096]** output (`2/3` hit `max_tokens: 4,096`; `rep 1` stopped early with `stop_reason: "refusal"` after `1,290` thinking and `0` visible tokens). Per-message beta `(c) R2B_BETA_HIGH` rose to **2778 [2509–3680]** thinking (**+1004**, `1.566x` — even its minimum `2509` exceeded `(a)`'s maximum `2438`) and **4096 [3863–4096]** output (`2/3` `max_tokens`, `1/3` `end_turn`).

---

## 9. Item 8 Security Note & Claude 5.5 Currency Check (`currency_55.csv`)

### Item 8: Shared Multi-Tenant Prefix Caches Without a Salt (Security Note — Out of Scope)

Cross-tenant prefix-cache leakage (`Item 8`) is a timing side-channel security risk specific to self-hosted multi-tenant inference clusters (e.g., vLLM or SGLang with automatic prefix caching enabled across mutually untrusted tenants) rather than a token-cost anti-pattern; no self-hosted cluster was available in this environment, so no timing probes were run. Where such shared clusters exist, prefill bypasses produce lower time-to-first-token (TTFT) on prefixes warmed by another tenant; isolating cache keys with a per-tenant request salt (e.g., `cache_salt`) eliminates cross-tenant hash collisions.

### Section 9 Optional Check: Opus 5.5 / Sonnet 5.5 Pair (`0.05x` Read Tier, OpenRouter `billed`, `n = 3`, 12 turns)

OpenRouter live catalog pricing (`2026-11-15`): `anthropic/claude-opus-5.5` (`$4/M` in, `$20/M` out, `$5/M` write5m, **`$0.20/M` read = `0.05x`**); `anthropic/claude-sonnet-5.5` (`$2/M` in, `$10/M` out, `$2.50/M` write5m, **`$0.10/M` read = `0.05x`**). Because write-to-read asymmetry rises from `12.5x` (`4.6`) to **`25x`** (`5.5`), cold rebuild penalties dominate longer horizons.

| Arm | n | Overall Hit % | T6 Read Tokens | T6 Write Tokens | T6 Cost (`billed`) | T8 Steady Cost (`billed`) | 12-Turn Cost (`billed`) | Ratio vs Control |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `control_55` | 3 | 91.6% | 26126 [26124–26128] | 70 | \$0.0086 [\$0.0086–\$0.0086] | \$0.0085 [\$0.0085–\$0.0085] | \$0.2261 [\$0.2261–\$0.2261] | `1.000x` |
| `one_switch_55` | 3 | 83.3% | 0 | 26199 [26197–26201] | \$0.0670 [\$0.0670–\$0.0670] | \$0.0042 [\$0.0042–\$0.0042] | \$0.2590 [\$0.2590–\$0.2591] | `1.146x` |
| `effort_only_55` | 3 | 91.6% | 26130 [26130–26132] | 70 | \$0.0086 [\$0.0086–\$0.0086] | \$0.0085 [\$0.0085–\$0.0085] | \$0.2261 [\$0.2261–\$0.2261] | `1.000x` |

**Section 9 Takeaway & Item #1 `5.5` Pair Economics (Verdict: `Partly confirmed on 5.5`):** Switching `Opus 5.5 -> Sonnet 5.5` at `T6` (`one_switch_55`) wiped the cache (`0` read vs `26,126` in `control_55`), making `T6` **`7.8x` more expensive** (`$0.0670` vs `$0.0086`) with a **`$0.0584` upfront penalty** (`$0.058414`, `billed`). On post-switch turns at `150` output tokens/turn, `Sonnet 5.5` saves **`~$0.00425/turn`** (`$0.004233/turn` measured at `T8`: `$0.008466` vs `$0.004233`), yielding a **`~14`-turn payback** (`13.8` turns) — explaining why the 12-turn session (`6` post-switch turns) still finished `1.146x` control (`$0.2590` vs `$0.2261`), while sessions continuing past `~20` turns break even cleanly. Meanwhile, changing top-level `output_config.effort` alone (`effort_only_55`) kept the `T6` cache intact (`26,130` read, `1.000x` control cost; caveat: all turns hit the `150`-token output cap).

---

## 10. CSV Integrity, Excluded Runs & Cross-Provider Spend Reconciliation

- **OpenRouter Key Status (`/api/v1/key`):** HTTP 200 | Cumulative Key Usage: \$93.5161 (`billed`) | Remaining Limit: \$106.4839 (of \$200.00 limit) | New OpenRouter Spend This Pass: `$0.0000`.
- **Direct Anthropic & Gemini Pools:** Total Direct Anthropic CSV sum: **\$4.7650** (`computed`: \$3.7996 initial suite incl. \$2.9477 initial `R2` + **\$0.9655** `4,096` `R2` rerun) against `$20.00` credit cap (~`$15.23` estimated remaining); Gemini `34.5k` explicit cache checks reported `0` USD billing field (`unverified`) against `$25.00` credit cap.

| Deliverable CSV | Rows | Non-200 HTTP | OpenRouter Spend (`billed`) | Direct Anthropic (`computed`) |
| :--- | :---: | :---: | :---: | :---: |
| [t4_parallel.csv](./t4_parallel.csv) | 177 | 0 | \$4.8309 | \$0.6671 |
| [t6_layers.csv](./t6_layers.csv) | 495 | 0 | \$9.6365 | \$0.0000 |
| [t7_rules.csv](./t7_rules.csv) | 360 | 0 | \$5.0222 | \$0.0000 |
| [t5_trim.csv](./t5_trim.csv) | 468 | 0 | \$10.3287 | \$0.0000 |
| [t3_idle.csv](./t3_idle.csv) | 81 | 0 | \$3.2774 | \$0.1847 |
| [r1_sidecall.csv](./r1_sidecall.csv) | 108 | 0 | \$1.5358 | \$0.0000 |
| [r2_effort.csv](./r2_effort.csv) | 237 | 0 | \$0.0000 | \$3.9132 |
| [currency_55.csv](./currency_55.csv) | 108 | 0 | \$2.1338 | \$0.0000 |
| **Suite CSV Totals** | **2034** | **0** | **\$36.7652** (`billed`) | **\$4.7650** (`computed`) |

### OpenRouter Key-Delta to CSV Ledger Reconciliation (`$8.74` Out-of-CSV Gap Closed)

Between the saved Phase 0 baseline snapshot (**\$48.006627**) and post-suite `/api/v1/key` (**\$93.516130**), total OpenRouter key usage rose by **\$45.509503**, leaving **\$8.744317** outside the `1,648` OpenRouter CSV rows (\$36.765186). Every non-CSV OpenRouter request is itemized below:

| Non-CSV Item | OR Calls | Aborted | Notes / Disposition | Amount (`billed`) |
| :--- | :---: | :---: | :--- | :---: |
| Phase 0 post-snapshot probe | 1 | 1 | `phase0_rate_card.json` (`strictMaxTokensCountCheck` ran right after `$48.006627` key GET) | \$0.013607 |
| `T6` initial calibration (`task-7681`) | 2 | 0 | `CAL_TOOLS` + `CAL_TOOLS_SYS` layer sizing before superseded sweep | \$0.058524 |
| `T6` initial API sweep (`task-7681`, overwritten) | 360 | 0 | `10` arms x `3` reps x `12` turns (`CLAUDE` aborted locally `code=1`; replaced by `--only-api`) | \$7.927400 |
| `T6` `--only-api` calibration (`task-7762`) | 2 | 0 | `CAL_TOOLS` + `CAL_TOOLS_SYS` saved to `t6_summary.json` (not CSV) | \$0.058525 |
| `T3` crashed run orphaned `Req1` primes (`task-7763`) | 8 | 0 | `TTL1H_62m (rep 1)` `$0.105543` + `TTL5_62m (rep 1)` `$0.066028` + `TTL1H_30m (reps 1..3)` `$0.316611` + `TTL5_30m (reps 1..3)` `$0.198057` before `TypeError` crash pre-checkpoint | \$0.686239 |
| `T6`/`T7` `CLAUDE.md` side-calls & `T3` `count_tokens` | 0 OR | 0 | `ccProxySideCalls = 0`; `count_tokens` hit direct Anthropic/Gemini `$0` endpoints | \$0.000000 |
| **Accounted Out-of-CSV Subtotal** | **373** | **1** | Covers superseded `T6`, calibrations, Phase 0 strict check & crashed `T3a` primes | **\$8.744295** |
| **Accounted Total (`CSVs + Out-of-CSV`)** | **2,021** | **1** | **Residual vs `/api/v1/key` delta: `+$0.000022`** (4-decimal `task-7681` log rounding) | **\$45.509481** |

All `2,034` rows across the `8` final CSVs completed `HTTP 200` with zero aborted runs included in any CSV metric; the `1` aborted `task-7681` CLI run (`CLAUDE` exit `1` before `T6 CC` OpenRouter calls) and the `1` crashed `task-7763` `T3` run were rerun from scratch (`task-7710`/`task-7762` and `task-7898`) and are itemized above.