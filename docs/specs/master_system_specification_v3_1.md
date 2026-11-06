# System Specification: Chrono-Attention Horizon & Flight Check (agy-horizon-flightcheck)
**Version:** 3.1.0
**Target Platform:** Google Antigravity CLI (agy v1.4.11+) and Antigravity Desktop/IDE (v2.25+)
**Host OS Priority:** Windows 11 (PowerShell, Node.js 20+ ESM) and POSIX (macOS, Linux)
**Plugin Manifest Schema:** https://antigravity.google/schemas/v1/plugin.json

## 1. Executive Summary
`agy-horizon-flightcheck` is a unified telemetry HUD, context-hygiene sensor, and stateful `PreInvocation` prompt router for Google Antigravity. It couples two subsystems over an atomic shared IPC spine (`sidecar.json`):
1. **Chrono-Attention Horizon (`agy-horizon`):** Plots the 200,000-token context window chronologically from Turn 0 (Left) to Current Turn (Right) across 40 discrete cells (5,000 tokens per cell). It resolves untruncated local logs in under 45ms, computes Signal Purity and Sludge Tax, and extracts native CLI `statusLine` telemetry (`quota`, `mode`, `agent_state`).
2. **Flight Check (`agy-flightcheck`):** A two-tier lifecycle hook (`SessionStart`, `PreInvocation`, `PostInvocation`) that reads `sidecar.json` in under 2ms. It preserves KV caches via `invoke_subagent` delegation, blocks parallel stale-file overwrites, enforces `/compact` before high-effort runs on polluted context, guards the 5-hour rolling quota floor, and rewrites vague cold-start or `#check` prompts.

## 2. Directory Layout & Official Hook Schema Contract

### 2.1 File Tree
~~~text
agy-horizon-flightcheck/
├── plugin.json
├── hooks.json
├── config/
│   └── default_flightcheck.json
├── src/
│   ├── core/
│   │   ├── path_canonicalizer.mjs
│   │   ├── sidecar_store.mjs
│   │   ├── log_resolver.mjs
│   │   ├── horizon_classifier.mjs
│   │   └── blindspot_sensors.mjs
│   ├── cli/
│   │   └── horizon_hud.mjs
│   ├── hooks/
│   │   ├── session_start.mjs
│   │   ├── pre_invocation.mjs
│   │   └── post_invocation.mjs
│   └── webview/
│       └── horizon_panel.html
├── skills/
│   └── precheck/
│       └── SKILL.md
└── tests/
    ├── fixtures/
    ├── test_router_and_sensors.mjs
    └── bench_latency.mjs
~~~

### 2.2 Official Antigravity `hooks.json` Structure
In Antigravity, `hooks.json` maps top-level hook group names to event definitions. While `PreToolUse` and `PostToolUse` require a `matcher` object with a nested `hooks` array, `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop` do not use a `matcher` and must map directly to an array of handler objects:

~~~json
{
  "horizon-flightcheck-lifecycle": {
    "enabled": true,
    "SessionStart": [
      {
        "type": "command",
        "command": "node ~/.gemini/config/plugins/agy-horizon-flightcheck/src/hooks/session_start.mjs",
        "timeout": 5
      }
    ],
    "PreInvocation": [
      {
        "type": "command",
        "command": "node ~/.gemini/config/plugins/agy-horizon-flightcheck/src/hooks/pre_invocation.mjs",
        "timeout": 15
      }
    ],
    "PostInvocation": [
      {
        "type": "command",
        "command": "node ~/.gemini/config/plugins/agy-horizon-flightcheck/src/hooks/post_invocation.mjs",
        "timeout": 5
      }
    ]
  }
}
~~~

## 3. Data Pipeline & 40-Cell Visual Taxonomy

### 3.1 4-Tier Untruncated Log Resolution
Because standard `transcript.jsonl` clips tool outputs at 4,120 characters (`truncated_fields`), `log_resolver.mjs` reads incremental byte offsets using strict fallback priority:
1. `brain/<uuid>/.system_generated/logs/transcript_full.jsonl`
2. `brain/<uuid>/.system_generated/logs/chunks/transcript_full/*.jsonl`
3. `brain/<uuid>/.system_generated/logs/transcript.jsonl` joined with `steps/<idx>/output.txt`
4. `conversations/<uuid>.db` (merging step start and end timestamps within a 600-second window)

### 3.2 Native `statusLine` Telemetry Harvesting & 30-Failure Safeguard
Antigravity CLI runs `statusLine` scripts at most once every 300ms and permanently disables the status line for the session after 30 consecutive non-zero exits or timeouts.
- **Zero-Crash Mandate:** `horizon_hud.mjs` must wrap its entire lifecycle in a top-level `try/catch` that always exits with code `0` and prints a minimal fallback bar if log parsing fails.
- **Native Stdin Harvesting:** `horizon_hud.mjs` extracts the following fields from the `statusLine` JSON stdin payload and persists them into `sidecar.json`:
  - `context_window.total_input_tokens`, `used_percentage`, `exceeds_200k_tokens`
  - `quota`: Maps bucket IDs to `remaining_fraction`, `remaining_amount`, `reset_in_seconds`
  - `mode`: `"accept-edits"`, `"auto"`, or `"plan"`
  - `agent_state`: `"idle"`, `"working"`, `"tool_use"`, `"reviewing"`, or `"error"`
  - `modelName`

### 3.3 40-Cell Semantic States (5,000 Tokens per Cell)
| Cell State | Visual | Telemetry Match | Operational Meaning |
|---|---|---|---|
| `ANCHOR_CORE` | Cyan `█` | `SYSTEM_PROMPT`, `.agents/rules/*.md`, `implementation_plan.md`, `task.md` | Pinned project guardrails and active plan. |
| `ANCHOR_SCHEMA` | Dim Cyan `▒` | Static MCP server and Skill JSON schemas at Turn 0 | Cold-start schema footprint (`SCHEMA_TAX`). |
| `MEMORY_KI` | Violet `▓` | `~/.gemini/antigravity/knowledge/*/metadata.json` matching current repo | Valid repo Knowledge Items. |
| `MEMORY_BLEED` | Pink `▓` | KI `metadata.json` whose canonical path belongs to a foreign workspace | Cross-project memory contamination. |
| `STALE_DUP` | Amber `▒` | `view_file` or `grep_search` superseded by later reads, or chat over 25 steps old | "Lost in the Middle" duplicate token waste. |
| `DIRTY_SNAP` | Flashing Amber `▒` | `view_file` where disk `fs.stat().mtimeMs` exceeds `step_timestamp_ms` | File modified on disk by another session or editor after agent read it. |
| `LEGACY_POISON` | Orange `▒` | `view_file` matching `deprecated_paths` globs or `@deprecated` header | Brownfield legacy code risking anti-pattern contagion. |
| `DEAD_ERROR` | Crimson `▓` | `run_command` (`exitCode != 0`) or error logs followed by a passing run | Resolved stack traces polluting attention. |
| `ACTIVE_SET` | Green `█` | Unique `view_file`, `write_to_file`, `replace_file_content`, and passing tests in last 8 turns | High-attention recency tail. |
| `AMPUTATION` | Red Bracket `![...]!` | Earliest 20% of cells (Cells 1 to 8) when `total_input_tokens` exceeds 140,000 | Server prefix-truncation zone. |

### 3.4 Telemetry Formulas
$$\text{Signal Purity (\%)} = \frac{\text{Tokens}(\text{ANCHOR\_CORE} + \text{MEMORY\_KI} + \text{ACTIVE\_SET})}{\text{Total Active Input Tokens}} \times 100$$

$$\text{Sludge Tax (\$/turn)} = \frac{\text{Tokens}(\text{STALE\_DUP} + \text{DEAD\_ERROR} + \text{Unused ANCHOR\_SCHEMA})}{1,000,000} \times \text{Model Input Rate (\$/1M)}$$

## 4. The 6 Blind-Spot Sensors (`blindspot_sensors.mjs`)
1. **Parallel / External File Overwrite (`DIRTY_SNAP`):** Compares `last_read_ms` from `view_file` against disk `mtimeMs`. Flags files modified externally after the agent's last read.
2. **MCP Schema Tax & Payload Bomb (`SCHEMA_TAX`):** Flags MCP servers consuming over 15% of Turn 0 context with zero calls in `~/.gemini/flightcheck/tool_usage.json` over the past 15 sessions. Flags single tool outputs exceeding 25,000 tokens.
3. **Unseen Caller Blast Radius (`UNSEEN_CALLERS`):** Parses `SITEMAP.md` or cached regex imports (`import`, `from`, `require`). When a prompt modifies an exported symbol or schema in `@file_A`, computes `importers(file_A) - ACTIVE_SET`.
4. **Brownfield Legacy Contagion (`LEGACY_POISON`):** Matches `view_file` paths against `deprecated_paths` in `.agents/flightcheck.json` or `@deprecated` headers in the first 30 lines.
5. **Quota Floor & 60s Stream Cutoff (`QUOTA_AND_STREAM_SHIELD`):** Reads native `quota.remaining_fraction` from `sidecar.json` (plus rolling 5h subagent request counter fallback) and halts high-tier runs when remaining quota drops below $0.10$ ($10\%$). Detects transitions from `mode == "plan"` on `pro` to execution on `flash` when context exceeds 40,000 tokens. Flags full-file rewrites on files over 600 lines.
6. **Uncheckpointed Regression & 3-Strike Loop (`LOOP_AND_GIT_GUARD`):** Runs `git status --porcelain`. Flags `uncheckpointed_drift` when 4 or more files are modified across 3 or more turns with zero passing tests and zero commits. Triggers a circuit breaker on 3 consecutive `DEAD_ERROR` turns on the same command or file.

## 5. Flight Check v3.1 `PreInvocation` Router
- **Control Flags:** `!` or `!force` bypasses for 1 turn; `!lock` locks model/effort for the session; `#check` forces Tier 2 evaluation and prompt rewrite.
- **Operating Modes (`hook_level`):** `"off"`, `"audit"` (only on `#check`), `"guard"` (default: Cold-Start lint Turns 1 to 3, Trust Decay Turn 11+, `ACTIVE_SET` scope matching, `STEER_SUBAGENT`, and hygiene/safety halts), `"strict"`.
- **8 Router States:**
  1. `ALLOW_SILENT`: Clean prompt, matching effort, `!force`, or Turn 11+ Trust Decay follow-up.
  2. `ALLOW_ACTIVE_SET`: Omitted `@file` tag, but target filename/symbol is inside Green `ACTIVE_SET`.
  3. `ALLOW_PLAN_OR_SUBAGENT`: `mode == "plan"` or `last_turn_used_subagent == true`.
  4. `INJECT_CONTEXT_GUARD`: Appends silent guardrail for `DIRTY_SNAP`, `UNSEEN_CALLERS`, `LEGACY_POISON`, or files over 600 lines.
  5. `STEER_SUBAGENT`: Context over 25,000 tokens + Purity over $70\%$ + complex concurrency/architecture prompt on `low` or `medium` effort. Injects directive to invoke `invoke_subagent`.
  6. `HALT_HYGIENE_OR_SAFETY`: Purity under $45\%$ on `high`/`max` effort, `AMPUTATION` risk over 140,000 tokens, `MEMORY_BLEED` during `/plan`, 3-strike loop, or 4+ dirty files uncheckpointed.
  7. `HALT_EFFORT_OR_QUOTA`: Cold-cache `pro/max` overkill on trivial task, 3rd consecutive trivial turn on `max`, or `quota.remaining_fraction` under $0.10$.
  8. `HALT_REWRITE_SCORECARD`: Explicit `#check` tag or Cold Session (Turns 1 to 3) vague multi-file prompt. Outputs the 4-Line Scorecard, `/model` + `/effort` recommendation, and copy-paste rewrite.