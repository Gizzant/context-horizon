<div align="center">

# `ctxtop` — Context Horizon (v3.1.0)

**Local Context Window Profiler, KV-Cache TTL Monitor & `<15ms` PreInvocation Router for Google Antigravity (`agy`)**

[![Zero Runtime Dependencies](https://img.shields.io/badge/dependencies-0_runtime-brightgreen.svg)](#systems-architecture--zero-trust-security)
[![Hook Latency](https://img.shields.io/badge/PreInvocation_hook-%3C15ms_p99-00e5ff.svg)](#deterministic-preinvocation-router--6-local-sensors)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22.5_builtin_sqlite-339933.svg)](#quick-start)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[**Live Interactive WebView Demo**](https://gizzant.github.io/context-horizon/) • [**Quick Start**](#quick-start) • [**Systems Architecture**](#systems-architecture--zero-trust-security) • [**CLI & Forensics**](#cli-commands--forensic-postmortem)

<br/>

<img src="assets/hero_terminal.svg" alt="Context Horizon 40-Cell ANSI HUD & PreInvocation Router" width="100%" />

</div>

---

## Why `ctxtop` Exists (vs. Cloud LLM Observability)

Cloud trace platforms (Langfuse, Helicone, Arize) require proxying API keys over the network and only observe HTTP request/response payloads. They have **zero visibility into the local filesystem, git working tree, IDE process table, or local SQLite/JSONL session stores**.

`ctxtop` is a zero-dependency local systems profiler built on Node.js built-ins (`node:sqlite`, `node:fs`, `node:http`). It correlates local session transcripts and SQLite `gen_metadata` tables with live disk state to catch failure modes that cloud proxies cannot see:

| Failure Mode | Root Cause in Agentic Sessions | How `ctxtop` Detects & Remediates It Locally |
| :--- | :--- | :--- |
| **Stale File Overwrites (`DIRTY_SNAP`)** | Developer edits or runs `git pull` on a file the agent read 10 turns ago; the agent overwrites disk changes with its stale in-context snapshot. | Compares `fs.statSync(path).mtimeMs` on disk against the last `read_file` / `view_file` step timestamp in the JSONL transcript (`+1000ms` tolerance) and injects a pre-turn re-read guard. |
| **Unseen Call-Site Breakage (`UNSEEN_CALLERS`)** | Agent modifies an exported function signature without reading downstream callers in the repo. | Runs a bounded `<8ms` regex import scan (`import ... from`, `require()`, Python `from ... import`) across workspace files (up to 250 files) and flags callers absent from the active working set. |
| **Superseded Full-File Reads (`STALE_DUPLICATE`)** | Agent reads the same 800-line file 6 times across a session without intermediate edits, burning KV cache and diluting middle-window recall. | Tracks file reads per compaction epoch (`CORTEX_STEP_TYPE_CHECKPOINT = 23`), exempting legitimate `read -> edit -> read` and `read -> run_command -> read` verification cycles, and folds superseded reads into line-numbered declaration stubs. |
| **Turn-0 MCP Schema Bloat (`SCHEMA_TAX`)** | Eagerly loaded MCP servers inject 15k–40k tokens of JSON tool schemas on Turn 0 even when never invoked. | Audits `~/.gemini/config/mcp_config.json`, `.agents/mcp_config.json`, and `~/.gemini/antigravity/mcp/` against actual `call_mcp_tool` invocations and identifies zero-call eager servers to switch to `"loading": "lazy"`. |
| **KV-Cache Prefix Busts (`PREFIX_BUST`)** | Switching models or mutating system rules mid-session while the 5-minute KV cache is warm (`>50k` tokens) forces a 100% uncached prefix rebuild. | Inspects per-turn `cache_read_tokens` deltas and `<USER_SETTINGS_CHANGE>` events in `conversations/<id>.db` (`gen_metadata`) to distinguish natural 300s TTL expiry from config-induced prefix busts. |
| **Prefix Truncation & Unsynced State** | Crossing the safe context ceiling (`140k–179k` tokens) while `task.md` is stale or git has uncommitted session edits risks losing early architectural constraints. | Cross-checks `git status --porcelain=v1 -z` (filtered to files written in the current session) against `task.md` freshness before `/compact` or session handoff. |

---

## Quick Start

### 1. Inspect Live Sessions or Run a Forensic Postmortem
```bash
# Audit the last 5 local Antigravity sessions for duplicate file reads, dead errors & MCP schema tax
node src/cli/postmortem.mjs --last 5

# Run environment & transcript health diagnostics (hooks, SQLite/JSONL confidence, 3-way mirror SHA-256)
node src/cli/doctor.mjs

# Print the 40-cell ANSI status bar for the active Antigravity session
node src/cli/horizon_hud.mjs --live
```

### 2. Launch the Local Telemetry WebView (`127.0.0.1`)
```bash
# Start the loopback sidecar daemon and open the Tufte WebView
node sidecars/horizon-daemon/server.mjs
```

### 3. Install Lifecycle Hooks & CLI `statusLine`
```bash
# Global install (~/.gemini/config/plugins/agy-horizon-flightcheck)
node src/cli/init.mjs init

# Workspace-local install (.agents/plugins/agy-horizon-flightcheck)
node src/cli/init.mjs init --workspace
```

---

## Systems Architecture & Zero-Trust Security

`ctxtop` is engineered for strict operational safety alongside live IDE/CLI database writers:

1. **Zero Outbound Network Connections**:
   - **0 runtime `npm` dependencies** (`package.json` has no `dependencies` block).
   - **0 external HTTP/HTTPS requests, telemetry beacons, or remote API calls**. All parsing, classification, and routing run 100% in-memory on the local machine.
   - The local WebView daemon (`sidecars/horizon-daemon/server.mjs`) binds strictly to `127.0.0.1` (loopback only) and rejects cross-origin `Origin` or non-local `Host` headers (`HTTP 403`) to prevent DNS rebinding and drive-by localhost CSRF.
2. **Read-Only Database & Transcript Introspection (`SQLITE_OPEN_READONLY`)**:
   - Every connection to Antigravity's SQLite databases (`conversations/<uuid>.db` and `conversation_summaries.db`) is opened via Node's native `node:sqlite` `DatabaseSync` with `Object.freeze({ readOnly: true })` (`SQLITE_OPEN_READONLY`). `ctxtop` can never contend for write locks with the Antigravity IDE or CLI.
   - Live JSONL transcripts (`transcript_full.jsonl` / `transcript.jsonl`) are read via `fs.openSync(filePath, 'r')` using byte-offset slicing (`O(Δbytes)` per turn), falling back to full re-parse only when a step-index regression (Undo/Rewind) is detected.
3. **Multi-Surface Discovery (`[App]`, `[IDE]`, `[CLI]`)**:
   - Automatically discovers and reconciles sessions across `~/.gemini/antigravity/` (`[App]`), `~/.gemini/antigravity-ide/` (`[IDE]`), and `~/.gemini/antigravity-cli/` (`[CLI]`).
4. **Prefix-Safe Surgical Context Pruner (`src/core/pruner.mjs`)**:
   - Opt-in transcript condensation writes an atomic `.pre_prune.<timestamp>.bak` backup before replacing superseded full-file reads with line-numbered declaration stubs (`SIGNATURE_LINE_RE`) and collapsing resolved error traces into 1-line `[Resolved Error at Turn #N]` tombstones.
   - Guards against busting a warm 5-minute KV cache (`isCacheCold === false`) unless explicitly confirmed.

---

## Deterministic `PreInvocation` Router & 6 Local Sensors

When registered in `hooks.json`, `src/hooks/pre_invocation.mjs` evaluates incoming prompts in **`< 15ms`** across 8 deterministic router states:

1. `ALLOW_SILENT`: Immediate pass-through (`{}`) on `!` bypass prefix or healthy turns.
2. `ALLOW_ACTIVE_SET`: Silent pass-through when referenced files are already warm in the last 5 turns.
3. `ALLOW_PLAN_OR_SUBAGENT`: Silent pass-through during `/plan` mode or subagent delegation.
4. `INJECT_CONTEXT_GUARD`: Appends a `systemMessage` warning when target files were modified externally on disk (`DIRTY_SNAP`), have unseen callers (`UNSEEN_CALLERS`), or touch deprecated paths (`LEGACY_POISON`).
5. `STEER_SUBAGENT`: Advises `invoke_subagent` when a broad exploratory prompt would pollute a warm `>30k`-token parent context window.
6. `HALT_HYGIENE_OR_SAFETY`: Halts execution (or warns in `advisory` mode) on context ceiling breach, 3-strike identical command error loops, or severe duplicate-read dilution.
7. `HALT_EFFORT_OR_QUOTA`: Warns when 5-hour/7-day quota falls below the configured floor (`10%`) or when `>600`-line single-shot file rewrites risk output stream truncation.
8. `HALT_REWRITE_SCORECARD`: Triggered via `#check` or vague cold-start prompts (`Turn <= 2`), outputting a 4-line prompt rewrite scorecard.

### In-Chat Control Flags
- `! <prompt>`: Bypass `PreInvocation` checks for a single turn.
- `!lock <prompt>`: Lock current reasoning effort tier for the remainder of the session.
- `#check <prompt>`: Force an explicit pre-flight scorecard and concrete prompt rewrite.

---

## CLI Commands & Forensic Postmortem

| Command | Description |
| :--- | :--- |
| `npx ctxtop postmortem [--last N] [--json]` | Scans the last `N` real local sessions, classifies root causes (`CONTEXT_ROT_DECAY`, `VERIFICATION_CHURN`, `SPEC_AMBIGUITY`, `CLEAN`), lists top duplicate-read files with step indices, audits Turn-0 MCP schema overhead, and writes `session_analysis_report.md` + `conversation_diagnostics.jsonl`. |
| `npx ctxtop --roast` | Prints a terminal forensic summary of recent sessions with top duplicate-read file offenders and copy-pasteable remediations. |
| `npx ctxtop doctor` | Validates lifecycle hook registration, config overlays, dynamic model ceilings, sidecar storage, 3-way WebView SHA-256 parity, and live JSONL parser confidence. |
| `npx ctxtop --serve` | Launches the local HTTP/SSE telemetry daemon (`127.0.0.1`) and interactive WebView. |
| `npx ctxtop --demo-animate` | Plays the 5-stage terminal crisis simulation across synthetic fixtures. |

---

## Verification & Benchmarks

Run the full zero-dependency test and verification suite:

```bash
# Unit tests: Path canonicalizer, atomic sidecar store, 40-cell classifier, 6 sensors, 8 router states
npm test

# Architectural verification suite (Phases 1-7: SQLite read-only locks, JSDOM UI invariants, MCP audit, pruner)
npm run test:phases

# End-to-end context memory & live loopback daemon integration suite
npm run test:e2e

# Latency benchmark (<15ms PreInvocation p99, <45ms CLI statusLine p99)
npm run bench
```

---

## License

MIT © [Gizzant](https://github.com/Gizzant)
