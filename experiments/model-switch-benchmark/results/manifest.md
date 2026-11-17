# Experiment Manifest (`manifest.md`)

## 1. Tool, Environment & Execution Batches

- **Agent CLI Tool & Exact Version:** `@anthropic-ai/claude-code@2.1.325` (`claude.exe --version` output: `2.1.325 (Claude Code)`)
- **Operating System & Runtime:** Windows 11 (`win32 x64`, build `10.0.26200`), Node.js `v25.6.0`
- **API Route:** Localhost HTTP logging proxy (`127.0.0.1:<ephemeral_port>`) forwarding HTTPS requests to **OpenRouter** (`https://openrouter.ai/api/v1/messages`) with `"provider": { "only": ["anthropic"], "allow_fallbacks": false }`. Traffic went through OpenRouter, not Anthropic directly; cache behavior and cost may differ on the direct API.
- **Execution Batches (Date, UTC & Local Time Zone `America/New_York` `UTC-05:00`):**
  1. **Pilot Batch 1 (Uncalibrated `~89.7k` Large prefix):** `2026-11-14T05:13:20Z` – `2026-11-14T05:27:19Z` (`00:13:20` – `00:27:19 EST`, `UTC-05:00`). Executed `4` pilot runs (`PILOT_A_S_r01`, `PILOT_C_S_r01`, `PILOT_D_S_r01`, `PILOT_B_L_r01`; `28` turns, `$2.04342`). Archived separately in `results/pilot/pilot_round1_wire_log.jsonl`.
  2. **Pilot Batch 2 (Calibrated prefix verification gate):** `2026-11-14T05:42:35Z` – `2026-11-14T05:45:43Z` (`00:42:35` – `00:45:43 EST`, `UTC-05:00`). Executed `2` gate runs (`PILOT_A_S_r01`, `PILOT_B_L_r01`; `13` turns, `$0.93280`). Archived in `results/pilot/proxy_wire_log.jsonl`.
  3. **Main Batch 1:** `2026-11-14T05:47:09.745Z` – `2026-11-14T06:33:11Z` (`00:47:09` – `01:33:11 EST`, `UTC-05:00`). Completed `26` full 12-turn runs (`423` wire requests, `$13.784552`) plus `1` aborted run (`B_L_r01_aborted_attempt1`, which completed Turns `1–9` for `$0.794648` across `17` wire calls and halted on Turn `10` due to OpenRouter `HTTP 402 payment_required` when wallet balance reached `$1.79`).
  4. **Main Batch 2 (`--resume` after wallet top-up):** `2026-11-14T13:56:16.380Z` – `2026-11-14T14:26:45.982Z` (`08:56:16` – `09:26:45 EST`, `UTC-05:00`). Completed the remaining `19` full 12-turn runs (`297` wire requests, `$8.050385`), including a clean Turn `1–12` rerun of `B_L_r01`.

---

## 2. Exact Model IDs, Effort Settings & Arm Schedules

| Arm Code | Arm Name (`runs.csv`) | CLI `--model` Flag(s) | Upstream Model ID(s) (`runs.csv`) | CLI `--effort` Flag(s) | Turn Schedule (`Turns 1–12`) | Prefix Buckets Tested |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| `A` | `control` | `claude-opus-4-6` | `anthropic/claude-opus-4.6` | `medium` | `Opus 4.6 (medium)` on `T1–T12` | `small` (`n=5`), `large` (`n=5`) |
| `B` | `one_switch` | `claude-opus-4-6` → `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` → `anthropic/claude-sonnet-4.6` | `medium` | `Opus 4.6` `T1–T5` → `Sonnet 4.6` `T6–T12` | `small` (`n=5`), `large` (`n=5` + `1` aborted) |
| `C` | `switch_and_back` | `claude-opus-4-6` ↔ `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` ↔ `anthropic/claude-sonnet-4.6` | `medium` | `Opus 4.6` `T1–T5` → `Sonnet 4.6` `T6–T7` → `Opus 4.6` `T8–T12` | `small` (`n=5`) |
| `D` | `effort_only` | `claude-opus-4-6` | `anthropic/claude-opus-4.6` | `medium` → `high` | `Opus 4.6 (medium)` `T1–T5` → `Opus 4.6 (high)` `T6–T12` | `small` (`n=5`) |
| `E` | `idle_then_switch` | `claude-opus-4-6` → `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` → `anthropic/claude-sonnet-4.6` | `medium` | `Opus 4.6` `T1–T5` → `>=330s` idle wait → `Sonnet 4.6` `T6–T12` | `small` (`n=5`) |
| `F` | `ten_switches` | `claude-opus-4-6` ↔ `claude-sonnet-4-6` | `anthropic/claude-opus-4.6` ↔ `anthropic/claude-sonnet-4.6` | `medium` | Odd turns `T1,T3,T5,T7,T9,T11`: `Opus 4.6`; Even turns `T2,T4,T6,T8,T10`: `Sonnet 4.6`; `T12`: `Opus 4.6` | `small` (`n=5`), `large` (`n=5`) |

### Measured Prefix Token Sizes at the Switch Point (Turn 6, Request 1)
- **`small` bucket (`n = 30` completed runs across Arms `A–F`):** Median `total_input_tokens` = **`15171`** `[15095–15437]` tokens (comprising `~8,846` tokens of unmodified Claude Code base system/tool/repo instructions plus `~6,328` tokens of file reads and conversation history).
- **`large` bucket (`n = 15` completed runs across Arms `A, B, F`):** Median `total_input_tokens` = **`56535`** `[56338–56766]` tokens (comprising `~8,840` base floor tokens plus `~47,695` tokens of file reads and conversation history).

---

## 3. Turn Invocation Method

- **Headless CLI Invocation with `--resume` Across All Arms (Including Control):**
  - **Turn 1 of every run:**
    `claude.exe -p "<prompt>" --model <model> --effort <effort> --tools "Read" --append-system-prompt "Benchmark-Run-Salt: <runId>_<8hex>" --dangerously-skip-permissions --output-format json --settings <frozen_settings.json>`
  - **Turns 2–12 of every run (Control `Arm A` and Arms `B–F` identically):**
    `claude.exe --resume <session_id> -p "<prompt>" --model <model> --effort <effort> --tools "Read" --append-system-prompt "Benchmark-Run-Salt: <runId>_<8hex>" --dangerously-skip-permissions --output-format json --settings <frozen_settings.json>`
- **Confirmation:** Control (`Arm A`) used the exact same headless `--resume <session_id> --model --effort` process-per-turn invocation pattern as every other arm.
- **Multi-Request Turns (`Turns 1–3` vs `Turns 4–12`):**
  - Turns `1`, `2`, and `3` instruct Claude Code to read a repository file via the `Read` tool. Within a single CLI turn on Turns `1–3`, Claude Code makes **2 sequential `/v1/messages` API requests**: `request_index_in_turn = 1` (where the assistant emits `stop_reason = "tool_use"` for `Read`) and `request_index_in_turn = 2` (where Claude Code sends the `tool_result` containing the file lines and the assistant emits `stop_reason = "end_turn"`).
  - On `large` runs, Claude Code also sends `1` pre-flight `/v1/messages/count_tokens?beta=true` side call (`is_side_call = true`) on each of Turns `1`, `2`, and `3` (`15 runs × 3 turns = 45` side calls total).
  - Turns `4–12` are analytical Q&A turns with zero tool calls (`requests_in_turn = 1`, `is_side_call = false`).

---

## 4. Usage & Cost Measurement Sources

- **Dual Recording (`source = both`):** Usage was recorded simultaneously from:
  1. **Session Transcripts:** Claude Code’s per-session `.jsonl` transcript files (`type: "assistant"`, `message.usage`).
  2. **Wire Logging Proxy:** The local pass-through HTTP→HTTPS proxy capturing raw SSE `message_start` and `message_delta` events from `https://openrouter.ai/api/v1/messages`.
- **Transcript vs. Proxy Agreement:** Across all **`675/675` (`100%`)** completed main `/v1/messages` requests, the transcript and proxy agreed exactly on all four token columns (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`). Zero rows disagreed (`sourceDisagreementCount = 0`).
- **Side Calls (`source = proxy`):** The `45` `/v1/messages/count_tokens?beta=true` requests returned HTTP `404` from OpenRouter and triggered our proxy’s local character-estimate response (`{"input_tokens": approx}`); because they are not LLM completions, they do not appear as assistant messages in `.jsonl` transcripts and have `source = proxy` with blank token/cost columns.
- **Aborted Run (`source = cli_log_recovered`):** The `10` turn rows of `B_L_r01_aborted_attempt1` were recovered from the Batch 1 runner console log (`task-2877.log`) and `scrubbed_partial_runs.json` after their wire log entries were scrubbed prior to Batch 2 `--resume`.

---

## 5. Price Table & Cost Provenance

- **Retrieval Date & Source:** Retrieved on **`2026-11-14`** from `https://openrouter.ai/api/v1/models` (matching first-party Anthropic API list pricing) and verified against OpenRouter’s live `usage.cost` field in every SSE response.
- **Cost Provenance in `runs.csv`:** Across all **`675/675` (`100%`)** completed main `/v1/messages` rows, `cost_usd` comes directly from OpenRouter’s reported `usage.cost` (`upstreamReportedCostUsd`). **`0` main rows** required fallback to the computed price table (furthermore, OpenRouter’s `usage.cost` matched the formula below to `< 1e-9` USD on all `675/675` rows).

| Model ID | Fresh `input_tokens` (per Tok / per 1M) | `5m` Cache Write (`1.25x`) (per Tok / per 1M) | `1h` Cache Write (`2.0x`) (per Tok / per 1M) | `cache_read_input_tokens` (`0.10x`) (per Tok / per 1M) | `output_tokens` (per Tok / per 1M) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `anthropic/claude-opus-4.6` | `$0.000005` (`$5.00/1M`) | `$0.00000625` (`$6.25/1M`) | `$0.000010` (`$10.00/1M`) | `$0.0000005` (`$0.50/1M`) | `$0.000025` (`$25.00/1M`) |
| `anthropic/claude-sonnet-4.6` | `$0.000003` (`$3.00/1M`) | `$0.00000375` (`$3.75/1M`) | `$0.000006` (`$6.00/1M`) | `$0.0000003` (`$0.30/1M`) | `$0.000015` (`$15.00/1M`) |
| `anthropic/claude-haiku-4.5` *(unused)* | `$0.000001` (`$1.00/1M`) | `$0.00000125` (`$1.25/1M`) | `$0.000002` (`$2.00/1M`) | `$0.0000001` (`$0.10/1M`) | `$0.000005` (`$5.00/1M`) |

---

## 6. Observed Cache Lifetime

- Every main `/v1/messages` response reported `cache_creation.ephemeral_5m_input_tokens` equal to `cache_creation_input_tokens` and `ephemeral_1h_input_tokens = 0`, confirming the **`5-minute` (`300s`) ephemeral TTL** tier was used throughout.
- **Warm return within TTL (`Arm C`, Turn 8):** Returning from `Sonnet 4.6` (`Turns 6–7`) to `Opus 4.6` at Turn 8 (`~11–15s` after Turn 5 finished) hit Opus’s Turn 5 cache on `5/5` runs (`93.3%` median `cache_read` share).
- **Alternating turns within TTL (`Arm F`, Turns `3–11`):** Returning to the prior model every `2` turns (`~12–23s` elapsed) hit the prior turn’s cache on all `10/10` `small` and `large` runs (`94.9%–98.6%` median `cache_read` share on Turns `5–11`).
- **Idle gap (`Arm E`, Turn 6):** Observed idle waits before Turn 6 were `348.74s`, `384.65s`, `394.54s`, `414.35s`, and `439.04s` (median **`394.54s`**). Note that because `Arm E` also switched models at Turn 6, `Arm E` cannot isolate TTL expiration from model switching (see Section 8 Deviations).

---

## 7. Frozen Repository, Constants & Prompt Suites

- **Target Repository & Commit:** Local clone of `<GITHUB_HANDLE>/<TARGET_REPO>` checked out at detached `HEAD` **`19c51055902c545508af1979a392505355777d90`**, reset before every run via `git checkout -f 19c51055902c545508af1979a392505355777d90` and `git clean -fdx`.
- **Constants Held Fixed Across Every Turn:**
  - **Tools:** `--tools "Read"` (all edit, bash, grep, glob, and web tools disabled).
  - **MCP Servers & Hooks:** `0` MCP servers; `--settings` pointed to a frozen file containing `{"hooks":{}}`.
  - **System Prompt & Isolation:** Default Claude Code `v2.1.325` system prompt plus per-run `--append-system-prompt "Benchmark-Run-Salt: <runId>_<8hex>"` (constant within each run so intra-run caching works normally, unique across runs so earlier runs cannot warm later runs’ caches); fresh per-run `HOME` and `CLAUDE_CONFIG_DIR`.
  - **Background Traffic & Auto-Compaction:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`. Maximum context reached `59,268` tokens (`<30%` of the `200,000`-token window), well below auto-compaction thresholds (`0` compactions occurred).

### Fixed 12-Turn Prompt List — `small` Bucket (`fixtures/prompts_small.json`)
1. **Turn 1 (`load`):** `Call the Read tool ONCE in a single tool call on `src/core-isomorphic/economics/billingBlocks.mjs` with offset=1, limit=110 (explicit benchmark override: do NOT split into multiple smaller reads). After reading it, list exactly 3 concise bullet points (under 70 words total) summarizing `BILLING_BLOCK_CONSTANTS` and `partitionBillingBlocks`.`
2. **Turn 2 (`load`):** `Call the Read tool ONCE in a single tool call on `src/core-isomorphic/economics/dualTtl.mjs` with offset=1, limit=100 (explicit benchmark override: do NOT split into multiple smaller reads). After reading it, list exactly 3 concise bullet points (under 70 words total) summarizing `DUAL_TTL_CONSTANTS` and `calculateDualTtlCountdown`.`
3. **Turn 3 (`load`):** `Call the Read tool ONCE in a single tool call on `src/core-isomorphic/economics/cliffBreaker.mjs` with offset=1, limit=96 (explicit benchmark override: do NOT split into multiple smaller reads). After reading it, list exactly 3 concise bullet points (under 70 words total) summarizing `HAIKU_CLIFF_THRESHOLDS` and `checkHaiku100kCliffBreaker`.`
4. **Turn 4 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain in 4 concise bullet points (under 100 words total) how `partitionBillingBlocks` handles null/invalid events, non-finite timestamps, and `burnRateUsdPerHour` calculation.`
5. **Turn 5 (`pre_switch`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, locate every exact threshold constant in `DUAL_TTL_CONSTANTS` and explain in 4 concise bullet points (under 100 words total) how `calculateDualTtlCountdown` handles `{ rolling: true }`.`
6. **Turn 6 (`switch_point`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, compare the 4 action levels in `checkHaiku100kCliffBreaker` (`allow`, `advisory`, `warn`, `halt`) and explain how non-Haiku models are handled in 4 concise bullet points (under 100 words total).`
7. **Turn 7 (`recovery_point`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace in 4 concise bullet points (under 100 words total) what all three modules share architecturally under the 'Claude Mod Laws 1-5' header comment and how `subagentId` defaults to `'main'` inside `partitionBillingBlocks`.`
8. **Turn 8 (`return_point`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, identify all formatting and rounding calls (`formatMmSs`, `formatRemainingTtl`, `toFixed`, `Math.round`) across the 3 loaded slices in 4 concise bullet points (under 100 words total).`
9. **Turn 9 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain in 4 concise bullet points (under 100 words total) the exact boundary checks (`>=`, `=== 0`, `<= 0`) in `calculateDualTtlCountdown` and `checkHaiku100kCliffBreaker`.`
10. **Turn 10 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, summarize in 4 concise bullet points (under 100 words total) all default parameter values used in the functions loaded across `billingBlocks.mjs`, `dualTtl.mjs`, and `cliffBreaker.mjs`.`
11. **Turn 11 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, list in 4 concise bullet points (under 100 words total) any imports vs frozen constant objects across the 3 loaded slices.`
12. **Turn 12 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, provide a final 4-bullet architectural synthesis (under 100 words total) connecting the 5h billing blocks, 5m vs 1h cache TTL countdowns, and Haiku 100k cliff breaker.`

### Fixed 12-Turn Prompt List — `large` Bucket (`fixtures/prompts_large.json`)
1. **Turn 1 (`load`):** `Call the Read tool ONCE in a single tool call on `src/core/parser.mjs` with offset=1, limit=1020 (explicit benchmark override: do NOT split into 150-line chunks). After reading it, list exactly 3 concise bullet points (under 70 words total) summarizing the read-only SQLite guard, transcript effort extraction, and Claude Code JSONL parser.`
2. **Turn 2 (`load`):** `Call the Read tool ONCE in a single tool call on `src/core/quota.mjs` with offset=1, limit=920 (explicit benchmark override: do NOT split into 150-line chunks). After reading it, list exactly 3 concise bullet points (under 70 words total) summarizing `TurnBoundaryModelSwitchBuffer`, `detectModelSwitchCause`, and `computeCacheRoi`.`
3. **Turn 3 (`load`):** `Call the Read tool ONCE in a single tool call on `src/core/constants.mjs` with offset=1, limit=960 (explicit benchmark override: do NOT split into 150-line chunks). After reading it, list exactly 3 concise bullet points (under 70 words total) summarizing `HORIZON_WINDOW`, `SESSION_RISK_THRESHOLDS`, and `CATEGORY_METADATA`.`
4. **Turn 4 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain in 4 concise bullet points (under 100 words total) what `SQLITE_OPEN_READONLY_OPTIONS` and `ZERO_TRUST_SECURITY_MANIFEST` enforce in `src/core/parser.mjs` and how `parseRawJsonl` parses session logs.`
5. **Turn 5 (`pre_switch`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, locate `TurnBoundaryModelSwitchBuffer` and `hasExplicitPrefixMutation` in `src/core/quota.mjs` and explain in 4 concise bullet points (under 100 words total) how model switches vs prefix mutations are classified.`
6. **Turn 6 (`switch_point`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain in 4 concise bullet points (under 100 words total) how `computeCacheRoi` in `quota.mjs` uses `SESSION_5M_READ_TO_WRITE_MIN_ROI_RATIO` and how `CATEGORIES` in `constants.mjs` maps tool/context overhead categories.`
7. **Turn 7 (`recovery_point`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, trace in 4 concise bullet points (under 100 words total) how `extractTurnEffortMetadata` and `extractEffortTimeline` in `parser.mjs` extract effort changes from transcripts.`
8. **Turn 8 (`return_point`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, summarize in 4 concise bullet points (under 100 words total) how `discoverClaudeCodeSessions` and `findSessionDirectory` in `parser.mjs` resolve transcript directories across platforms.`
9. **Turn 9 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, compare `SURFACE_TAGS`, `resolveSurfaceTag`, and `ATTENTION_TROUGH_CONFIG` in `constants.mjs` with `resolveModelPoolDisplayName` in `quota.mjs` in 4 concise bullet points (under 100 words total).`
10. **Turn 10 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, explain in 4 concise bullet points (under 100 words total) how `parseClaudeCodeJsonl` in `parser.mjs` handles Anthropic usage fields and sidecar/subagent entries.`
11. **Turn 11 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, summarize in 4 concise bullet points (under 100 words total) how `SESSION_RISK_THRESHOLDS`, `PATCHED_CLI_CEILING_TIERS`, and `CARBON_RATE_CLIFF_UTC` are structured in `constants.mjs`.`
12. **Turn 12 (`measure`):** `IMPORTANT: Do NOT call Read or any tool on this turn. Using ONLY the file contents already shown above, give a 4-bullet synthesis (under 100 words total) showing how `parser.mjs`, `quota.mjs`, and `constants.mjs` fit together from raw session logs to cache/model diagnostics.`

---

## 8. Run Counts per Arm, Excluded/Aborted Runs & Protocol Deviations

### Completed vs. Planned Runs by Cell
| Prefix Bucket | Arm | Planned Runs | Completed Runs (`12/12` turns) | Aborted / Partial Runs | Missing Turns in Completed Runs |
| :--- | :--- | :---: | :---: | :---: | :---: |
| `small` | `control` | `5` | `5` (`75` main API reqs) | `0` | `0` |
| `small` | `one_switch` | `5` | `5` (`75` main API reqs) | `0` | `0` |
| `small` | `switch_and_back` | `5` | `5` (`75` main API reqs) | `0` | `0` |
| `small` | `effort_only` | `5` | `5` (`75` main API reqs) | `0` | `0` |
| `small` | `idle_then_switch` | `5` | `5` (`75` main API reqs) | `0` | `0` |
| `small` | `ten_switches` | `5` | `5` (`75` main API reqs) | `0` | `0` |
| `large` | `control` | `5` | `5` (`75` main API reqs) | `0` | `0` |
| `large` | `one_switch` | `5` | `5` (`75` main API reqs) | `1 (B_L_r01_aborted_attempt1)` | `0` |
| `large` | `ten_switches` | `5` | `5` (`75` main API reqs) | `0` | `0` |

### Deviations from Original Protocol & Potential Impact
1. **Deviation 1 — Aborted First Attempt of `B_L_r01` (OpenRouter HTTP `402`), `>7h` Pause, and Wire-Row Scrub Before Rerun:**
   - *What happened:* During Batch 1 (`2026-11-14T06:33Z`), `B_L_r01` (`sess_B_L_r01_aborted_attempt1`) completed Turns `1–9` (`17` wire calls, `$0.794648`) and failed twice on Turn `10` with `HTTP 402 payment_required` when the OpenRouter wallet balance dropped to `$1.79`. Over `7` hours elapsed before wallet credits were topped up (`13:56Z`).
   - *Action taken:* Resuming `sess_B_L_r01_aborted_attempt1` at Turn `10` after `7+` hours would have injected an artificial `5m` TTL cold-cache miss into Turn `10` of `one_switch` (`large`). Therefore, the partial run’s `17` wire log lines and `10` CLI turn records were scrubbed from `proxy_wire_log.jsonl` and `cli_turns.jsonl` (recorded in `scrubbed_partial_runs.json`), and `B_L_r01` was rerun from Turn `1` through Turn `12` in Batch 2 (`sess_B_L_r01`). All `10` turns of the aborted first attempt are preserved in `runs.csv` under `run_id = B_L_r01_aborted_attempt1` (`source = cli_log_recovered`) with `latency_ms` and 4-decimal `cost_usd` deltas recovered from `task-2877.log`, while their token columns are left blank rather than estimated.
   - *Impact:* Rerun `B_L_r01` (`$0.86508` session cost, `$0.21630` Turn 6 cost) closely matched the other `4` Batch 1 replicates of `B_L` (`$0.85849–$0.86220` session cost, `$0.21560–$0.21623` Turn 6 cost).
2. **Deviation 2 — `small` Prefix Bucket Size (`~15.2k` Measured Wire Tokens vs. `~5k` Target):**
   - *What happened:* Unmodified Claude Code `v2.1.325` sends an `~8,846`-token baseline prefix on Turn 1 (`~27.1k` chars of system prompt + `Read` tool JSON schema + repository `AGENTS.md` context) before any file is read. Adding `~6.3k` tokens of file reads across Turns `1–3` placed the `small` bucket at **`15,174` median wire tokens** at Turn 6 rather than `5,000` total tokens.
   - *Impact:* Both prefix buckets remain separated by **`3.72x`** (`15,174` vs. `56,535` median tokens at Turn 6), which is sufficient to measure prefix-size scaling (`3.83x` cost penalty increase), but `small` reflects a `~15.2k` prefix rather than a `~5k` prefix.
3. **Deviation 3 — Single-`Read` Prompt Instruction Added After Pilot Batch 1:**
   - *What happened:* Target repository `AGENTS.md` contained a rule instructing agents to read `<= 150` lines per call. In Pilot Batch 1 (`results/pilot/pilot_round1_wire_log.jsonl`), `Opus 4.6` obeyed that rule and split `1,550`-line reads into `11` parallel `Read` calls, inflating the `large` prefix to `89,664` tokens. Before Pilot Batch 2 and the main `45` runs, we calibrated line limits and added `(explicit benchmark override: do NOT split into multiple smaller reads)` to Turns `1–3` in `prompts_small.json` and `prompts_large.json`.
   - *Impact:* Every run in the main `45`-run dataset executed exactly `1` `Read` tool call on each of Turns `1`, `2`, and `3` (`2` `/v1/messages` requests per turn).
4. **Deviation 4 — `Arm E` (`idle_then_switch`) Confounds Idle Gap and Model Switch (Idle-Only Arm Skipped Due to Budget Cap):**
   - *What happened:* Following the original 6-arm table (`Arm E: Wait past the cache lifetime, then switch`), `Arm E` both idled `>=330s` (`348.74s–439.04s`) and switched from `Opus 4.6` to `Sonnet 4.6` at Turn 6. Because a model switch by itself causes a `0.0%` cache read on Turn 6, `Arm E` cannot separate the effect of TTL expiry from the effect of model switching. Running an additional `10`-run `idle_only` control (`5` `small` + `5` `large` staying on `Opus 4.6` after `>=330s`) would have cost `~$7.30` and exceeded the `$30.00` experiment budget cap (`$25.55` already spent).
   - *Impact:* We cannot independently verify `>5m` same-model cache expiry from `Arm E`; we report this explicitly as a design limitation.
