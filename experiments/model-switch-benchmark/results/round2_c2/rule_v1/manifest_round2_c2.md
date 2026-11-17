# Round 2 C2 Benchmark Manifest (`rule_v1`)

- **Route:** OpenRouter (`https://openrouter.ai/api/v1/messages`, upstream `provider: { only: ["anthropic"], allow_fallbacks: false }`) — **live API traffic**. Cache behavior and cost may differ on the direct Anthropic API.
- **Tool & OS:** 2.1.325 (Claude Code) on Windows (`win32 x64`)
- **Batch Window (UTC):** `2026-11-14T17:32:09.055Z` to `2026-11-14T18:07:28.467Z`
- **Target Frozen Repo:** commit `19c51055902c545508af1979a392505355777d90` (cleaned via `git checkout -f` and `git clean -fdx` before every run)
- **Highbeam Revision:** branch `round2-c1-fixes`, commit `b4e7502`, rule config `rule_v1` (`AUTO_PILOT`, local trial license, `PreModelSwitch` native default `permissionDecision: "ask"`)
- **Invocation Method:** Persistent `claude.exe -p --input-format stream-json --output-format stream-json --verbose --include-hook-events --dangerously-skip-permissions --tools Read --effort medium --settings <settingsPath> --setting-sources local` with SDK `control_request: { subtype: "set_model", model }` sent before `switchBeforeTurn`.
- **Models & Effort:** `anthropic/claude-opus-4.6` (`claude-opus-4-6`), `anthropic/claude-sonnet-4.6` (`claude-sonnet-4-6`), `effort = medium`, API-key `5m` ephemeral cache tier.
- **Cost Accounting:** OpenRouter `usage.cost` (`billed`) when present (`426/426` main rows); fallback to `PRICING_PER_1M` (`computed`, `0` rows).

## Price Table Used for Fallback / Attribution (`PRICING_PER_1M`, USD per 1M tokens)

| Model | Input | 5m Cache Write (1.25x) | 1h Cache Write (2.0x) | Cache Read (0.1x) | Output |
|---|---:|---:|---:|---:|---:|
| `anthropic/claude-opus-4.6` | $5.00 | $6.25 | $10.00 | $0.50 | $25.00 |
| `anthropic/claude-sonnet-4.6` | $3.00 | $3.75 | $6.00 | $0.30 | $15.00 |

## Prompt List & Sample Counts (`small` Tier Fixed Workload)
- **Turns 1–12:** `fixtures/prompts_small.json` (`Read` slices of `billingBlocks.mjs`, `dualTtl.mjs`, `cliffBreaker.mjs` in T1–T3; zero-tool analytical prompts T4–T12).
- **Turns 13–30 (`L1`/`L2` only):** 18 deterministic zero-tool prompts restricted to the already-loaded T1–T3 file slices.
- **Run Counts:** `L1` (6 runs), `L2` (6 runs), `U1` (2 runs); aborted retry attempts recorded: 0 wire rows.
- **Transcript Verification:** `426/426` main rows matched on all 4 token fields (`source = both`), disagreements = 0.
