# Highbeam `AUTO_PILOT` Experiment Manifest (`manifest_highbeam_auto.md`)

- **Code Version:** `rule_v1` (pinned at git tag `round1-rule-v1`, commit `19c51055902c545508af1979a392505355777d90`).
- **CLI Tool & Exact Version:** `@anthropic-ai/claude-code@2.1.325`
- **Operating System & Runtime:** Windows 11 (`win32 x64`), Node.js `v25.6.0`, executed `2026-11-14` (`UTC`).
- **Target Repository Commit:** Detached `HEAD` `19c51055902c545508af1979a392505355777d90` (reset before every new run via `git checkout -f`, `git clean -fdx`, and `.git/info/exclude` containing `.claude/`).
- **Highbeam Extension & Invocation Disclosure:** `flightMode: "AUTO_PILOT"`, local 14-day Pro trial (`activateLocalTrial`), canonical Highbeam hooks installed into `--settings` (`leanHooks: false`). Each turn ran as a headless `claude -p --resume <session_id>` invocation, and the harness invoked `runPreModelSwitchHook` (`DET-08`) and `interceptTopLevelMutation` (`DET-09`) in-process prior to spawning each turn (validating decision logic rather than interactive `/model` or `/effort` interception).
- **Upstream Route:** Local logging proxy forwarding to `https://openrouter.ai/api/v1/messages` (`"provider": { "only": ["anthropic"], "allow_fallbacks": false }`). Cache behavior and cost may differ on the direct Anthropic API.
- **OpenRouter Live Execution Usage (`billed`):** Proxy wire `usage.cost` sum = **$2.9053** (`billed`) across **7/7** live sessions (105 main requests, 6 `count_tokens` side calls); OpenRouter `/api/v1/key` billed ledger delta for the 6-session batch = $2.793334 (plus `$0.1120` billed on prior `HB_E_S_r01` pilot = `$2.9053` total billed).
- **Artifacts Generated under `results/highbeam_auto/`:**
  - `runs_auto_live.csv` (`111` rows: `105` main requests with `100%` `source = both` agreement + `6` `count_tokens` side calls — `live` `n = 1` empirical evidence, `billed` `cost_usd`)
  - `interceptions_live.csv` (`84` per-turn hook decisions across all `7` live sessions)
  - `replay_45_sessions.csv` (`45` `counterfactual` decision replays across all `9` baseline cells — decision audit only; paired Control lookup, not independent dollar evidence)
  - `horizon_ledger.jsonl` (`33` persisted Highbeam receipt entries — **caveat:** `DET_08_MODEL_SWITCH_HOLD` `savedUSD` in `rule_v1` reflects a `$5.00/M` fallback bug fixed in Round-2 `C1a`, so do not quote `horizon_ledger.jsonl` for dollar savings)
  - `summary_highbeam_auto.md`, `manifest_highbeam_auto.md`, and sanitized `raw/` wire logs & transcripts (zero local file paths, usernames, or credentials).
