# Highbeam Airlock (`ctxtop Pro`) — Reproducible Claude Code Hook Wire & `.jsonl` Spike Harness

This directory contains the self-contained, path-sanitized loopback HTTP proxy harness, hook scripts, and empirical output summary used to verify Claude Code `@anthropic-ai/claude-code@2.1.325` hook contracts (`Track A` and `Round 3` follow-up checks) without touching personal credentials or live Anthropic endpoints.

> **Important**: None of these files end in `.test.mjs`, so `npm test` does not download or execute `claude.exe` during normal unit/integration CI runs.

## Contents

* [`vault_hook.mjs`](./vault_hook.mjs): Isolated `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` spike hook supporting `NORMAL`, `POST_EDIT_UNSCRUBBED`, `STATELESS_V1`, `PROMPT_BLOCK`, `PROMPT_REWRITE_ATTEMPT`, `PROMPT_SUPPRESS_TEST`, `CRASH_EXIT_1`, and `TIMEOUT_HANG` modes.
* [`mock_mcp_server.mjs`](./mock_mcp_server.mjs): Minimal stdio MCP server (`get_secret_config`) returning mock secrets and echoing arguments.
* [`run_spike.mjs`](./run_spike.mjs): Main 12-scenario Track A wire + `.jsonl` suite (`S1a`–`S7`).
* [`run_spike_followup.mjs`](./run_spike_followup.mjs): Follow-up verification suite (`F1`–`F4` + `.jsonl` line localization).
* [`run_round3_checks.mjs`](./run_round3_checks.mjs): Round 3 empirical suite covering:
  * `R3_1a` / `R3_1b`: `PostToolUse(Read)` scrubbing on editable `config/prod.json` paired with stateless `FM-1` (`exit 2`).
  * `R3_2`: `--continue` and `--resume <sessionId>` HTTP wire replay check for `.jsonl` `attachment.hook_success`.
  * `R3_3`: `N = 250` cold `node` subprocess spawn latency (`p50`/`p95`/`p99`/`max`) + `N = 30` sequential `Read` A/B baseline (`Hooks-OFF` vs. `Hooks-ON`).
* [`spike_empirical_results.json`](./spike_empirical_results.json): Combined, path-sanitized JSON archive of observed results (`win32 x64`, `Node v25.6.0`, `@anthropic-ai/claude-code@2.1.325`).

## Running Offline in an Isolated Temp Directory

All `claude.exe` invocations pin `ANTHROPIC_BASE_URL` to a local `127.0.0.1` mock server, supply a dummy `ANTHROPIC_API_KEY`, and isolate `CLAUDE_CONFIG_DIR`, `HOME`, and `USERPROFILE` inside `./runs*`.

```bash
# 1. Copy this directory into an empty temp directory outside the git working tree
cp -r test/fixtures/airlock_spike /tmp/airlock-spike
cd /tmp/airlock-spike

# 2. Install the pinned Claude Code package into /tmp/airlock-spike/node_modules
npm init -y
npm install --no-save @anthropic-ai/claude-code@2.1.325

# 3. Execute suites
node run_spike.mjs
node run_spike_followup.mjs
node run_round3_checks.mjs
```

*(On macOS/Linux, update `CLAUDE_EXE` in `run_spike*.mjs` / `run_round3_checks.mjs` to point to `node_modules/@anthropic-ai/claude-code/bin/claude` or the installed CLI binary.)*
