<div align="center">

<img src="assets/logo.svg" alt="Context Horizon Logo" width="76" height="76" />

# Context Horizon (`ctxtop`)

### **`htop` for AI Coding Agents. See inside your 200k context window before it silently amputates your rules and burns your 5-hour quota.**

[![CI Matrix](https://img.shields.io/github/actions/workflow/status/Gizzant/context-horizon/ci.yml?branch=main&label=CI%20%28Win%20%7C%20Mac%20%7C%20Linux%29&style=flat-square)](https://github.com/Gizzant/context-horizon/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0%20%28Pure%20Node%20ESM%29-00d7ff?style=flat-square)](package.json)
[![Hook Latency](https://img.shields.io/badge/Hook%20Latency-%3C15ms%20p99-f59e0b?style=flat-square)](#benchmark--verification-suite)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local%20%2F%200%20Network%20Calls-a855f7?style=flat-square)](SECURITY.md)

**[Launch Live Browser Demo](https://gizzant.github.io/context-horizon/)** • **[30-Second Quickstart](#30-second-quickstart)** • **[8 Reddit Complaints We Fix](#sound-familiar-8-real-redditor-complaints-we-fix)** • **[40-Cell Taxonomy](#the-40-cell-visual-taxonomy)** • **[Contributing](CONTRIBUTING.md)**

<img src="assets/hero-demo.svg" alt="Context Horizon 40-Cell HUD and Flight Check Demo" width="100%" />

</div>

---

## Why `context-horizon` (`ctxtop`) Exists

Every developer pushing long-context coding agents (Google Antigravity, Gemini 3.1/3.8/4 Argon, Claude Opus/Sonnet) hits the same wall around Turn 25 to 40:

1. **Silent Prefix Amputation (`>140k` tokens):** Early turns containing `AGENTS.md`, architecture invariants, and `implementation_plan.md` get pushed into the server truncation zone or fall into the "Lost in the Middle" attention trough.
2. **Invisible Sludge Tax (`$/turn`):** Your agent re-reads the same 600-line file 6 times and keeps 4 resolved compiler stack traces in memory. You pay for those dead tokens on *every single subsequent turn*.
3. **Blind Stale-File Overwrites:** You edit a file in VS Code while the agent is thinking, and the agent overwrites your fix using a 15-minute-old snapshot.
4. **5-Hour Quota Evaporation:** High-effort reasoning runs fire on polluted 40%-purity context, draining your 5-hour quota bucket in 40 minutes.

`context-horizon` (`ctxtop`) solves this with **zero external dependencies** and **`<15ms` hook latency** by combining a **40-Cell Chronological ANSI HUD**, an **Edward Tufte IDE Webview**, **6 Blind-Spot Sensors**, and an **8-State `PreInvocation` Flight Check Router**.

---

## 30-Second Quickstart

Requires **Node.js 20+** (Windows, macOS, or Linux). Zero npm dependencies installed.

```bash
# 1. Preview the 40-cell HUD & Flight Check Scorecard right now (no active session needed)
npx context-horizon --demo

# 2. Watch a live 5-stage terminal replay (Cold Start -> Sludge -> Amputation -> Recovery)
npx context-horizon --demo-animate

# 3. Install globally into Google Antigravity (copies plugin, fixes hooks.json, configures statusLine)
npx context-horizon init

# 4. Audit your local sessions & print a shareable "Context Roast Card"
npx ctxtop --roast

# 5. Launch the standalone Edward Tufte IDE Webview in your browser
npx context-horizon --serve
```

*(Running from a cloned repo? Use `npm start`, `npm run install-plugin`, `npm run roast`, or `npm run dev`.)*

---

## Sound Familiar? 8 Real Redditor Complaints We Fix

We built `context-horizon` by cataloging the top recurring complaints from AI-assisted coding threads on `r/LocalLLaMA`, `r/ClaudeAI`, `r/Cursor`, `r/ChatGPTCoding`, and `r/GoogleGemini`, and engineering a deterministic sensor for each one.

| # | The Real Developer Complaint | Root Cause in the 200k Window | How `context-horizon` Stops It |
| :-: | :--- | :--- | :--- |
| **1** | *"Why did the agent suddenly ignore my `AGENTS.md` rules at turn 35 and rewrite my folder structure?!"* | **Prefix Amputation:** Total tokens crossed `140,000` (`115k` on High effort), pushing Cells 1-8 (`AGENTS.md`, `task.md`) into the truncation zone. | Wraps Cells 1-8 in flashing red `![ 🚨 ]!` brackets, halts High/Max prompts (`HALT_HYGIENE_OR_SAFETY`), and calculates exact `/compact` token recovery. |
| **2** | *"My 5-hour Pro/Opus quota vanished in 45 minutes and I have no idea what ate it!"* | **Compound Sludge Burn:** 60k+ tokens of duplicate file reads and dead errors are re-billed on every turn, compounded by High/Max effort multipliers. | Computes real-time **Sludge Tax (`$/turn`)** + **Dual-Pool Quota (5h Sprint / 7d Weekly)** and trips a circuit breaker when quota drops below `10%`. |
| **3** | *"It read the same 700-line file 6 times and kept 4 old failing test logs in context!"* | **Lost-in-the-Middle Rot:** Older `view_file` outputs and resolved `run_command` errors (`exit != 0`) stay in the transcript forever. | Flags `STALE_DUP` (amber) and `DEAD_ERROR` (crimson) cells. One-click **Surgical Transcript Pruner** folds stale code into AST signature stubs and collapses resolved errors into 1-line tombstones. |
| **4** | *"I fixed a bug in VS Code while the agent was running, and it overwrote my edit with an old snapshot!"* | **Dirty In-Memory Snapshot:** The agent's last `view_file` timestamp is older than the file's disk `fs.stat().mtimeMs`. | **Sensor 1 (`DIRTY_SNAP`)** compares `lastSessionTouchMs` vs disk `mtimeMs` (+500ms tolerance) in `<2ms` and injects a mandatory re-read guard before write. |
| **5** | *"I added 5 MCP servers and now Turn 1 starts with 38,000 tokens burned before I even type hello!"* | **Cold-Start Schema Tax:** Static MCP and skill JSON schemas silently consume `>15%` of the context window on Turn 0. | **Sensor 2 (`SCHEMA_TAX`)** audits Turn-0 schema footprint and flags zombie MCP servers with `0` invocations across your last 15 sessions. |
| **6** | *"It refactored `router.mjs` and said 'Done!', breaking 4 caller files it never bothered to read!"* | **Unseen Caller Blast Radius:** Files importing the modified module are missing from the recent 8-turn `ACTIVE_SET`. | **Sensor 3 (`UNSEEN_CALLERS`)** builds a fast reverse-import map (`importers(target) - ACTIVE_SET`) and warns the agent about unseen dependents. |
| **7** | *"It copied deprecated patterns from `/v1/legacy/` and injected rules from a completely different repo!"* | **Legacy Contagion & Foreign KI Bleed:** Reading `@deprecated` files or loading a Knowledge Item (`metadata.json`) from another workspace. | **Sensor 4 (`LEGACY_POISON`)** & **`MEMORY_BLEED` (Pink `▓`)** reconcile every KI against the canonical workspace path and alert before pollution spreads. |
| **8** | *"It looped 4 times on the same failing test, trashed 6 files without committing, and cut off mid-file on a 900-line rewrite!"* | **3-Strike Loop & Stream Cutoff:** Repeated identical `DEAD_ERROR` runs, uncheckpointed `git status` drift, or single-write outputs exceeding stream limits. | **Sensors 5 & 6 (`LOOP_AND_GIT_GUARD` + `STREAM_SHIELD`)** trip a 3-strike error breaker, enforce git checkpoints after 4 dirty files, and block full-file rewrites on files `>600` lines. |

---

### Concrete Example 1: Catching a Turn-50 Prefix Amputation & Sludge Crisis

When your session crosses 140k tokens with duplicate reads and an external file edit, `npx context-horizon --demo` (and your live CLI status line) renders:

```text
Scenario 5: Turn 50 Prefix Amputation Crisis (145k Tokens)
Redditor Complaint: "Why did the agent suddenly ignore my AGENTS.md rules at turn 35 and break my architecture?!"
[![███▓▒▒▒▒]!▓▒▒▓▒▒▒▒▓▒▒▓▒▒▒▒█████░░░░░░░░░░░] 145k/200k | Purity: 35% | Sludge: +$0.09/turn (94k tok) | Quota: 50%
╭── Flight Check v3.1 (HALT_HYGIENE_OR_SAFETY) ───────────────────────────────────────────╮
│ 1. PROMPT : [Score 31/100] "Add billing summary endpoint"
│ 2. HORIZON: [Purity: 35% | Reclaimable: 84k tok | Tokens: 145k/200k | Quota: 50%]
│ 3. ACTION : CRITICAL: Cells 1-8 (AGENTS.md) in Amputation Zone! Type /compact now
│ 4. REWRITE: "HALT: Reclaim 84k sludge tokens via /compact before adding billing endpoint"
╰─────────────────────────────────────────────────────────────────────────────────────────╯
```

### Concrete Example 2: Preventing a Blind Stale-File Overwrite (`DIRTY_SNAP`)

You edit `src/routes.mjs` in an external editor while the session is active, then ask the agent to `"Update server routes"`:

```text
Scenario 6: External Editor Dirty Snapshot & Unseen Callers
Redditor Complaint: "I edited routes.mjs in VS Code and the agent blindly overwrote my fix with a stale snapshot!"
[█████▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 30k/200k | Purity: 80% | Sludge: +$0.02/turn (6k tok) | Quota: 80%
╭── Flight Check v3.1 (INJECT_CONTEXT_GUARD) ─────────────────────────────────────────────╮
│ 1. PROMPT : [Score 64/100] "Update server routes"
│ 2. HORIZON: [Purity: 80% | Reclaimable: 6k tok | Tokens: 30k/200k | Quota: 80%]
│ 3. ACTION : Re-read dirty @src/routes.mjs (modified on disk) & check unseen caller @src/app.mjs
│ 4. REWRITE: "Re-read @src/routes.mjs and inspect caller @src/app.mjs before updating server routes"
╰─────────────────────────────────────────────────────────────────────────────────────────╯
```

### Concrete Example 3: Roasting Your Local Context History (`npx ctxtop --roast`)

Run `npx ctxtop --roast` to scan your local `.gemini/antigravity/brain` logs and generate a shareable hygiene scorecard:

```text
╭── 🔥 CONTEXT HORIZON ROAST CARD (ctxtop v3.1.0) ──────────────────────────╮
│ Sessions Audited : 14 sessions (1.84M cumulative tokens inspected)
│ Worst Purity     : 34.8% (Lost-in-the-Middle duplicate reads & stale turns)
│ Redundant Reads  : 47 duplicate file reads + 19 dead stack traces kept in memory
│ Sludge Tax Burned: $1.92 wasted re-sending stale context to the model
│ Amputation Zones : 3 sessions crossed 140k tokens (AGENTS.md truncation risk)
╰───────────────────────────────────────────────────────────────────────────╯
```

---

## The 40-Cell Visual Taxonomy

The 200,000-token context window (or dynamic 256k / 1M ceiling) is partitioned chronologically from **Turn 0 (Left)** to **Current Turn (Right)** into 40 discrete cells:

```text
  TRUNCATION WARNING! [🚨 Amputation Risk >140k]
           │
  ╭────────┴────────╮
  ![ █ █ █ ▓ ▒ ▒ ▒ ▒ ]! ▒ ▒ ▓ ▓ ▒ ▒ ▒ ▒ ▒ ▓ ▒ ▒ ▒ ▒ ▒ █ █ █ █ █ █ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░  [ 145k / 200k ]
    ───┬─── ─┬ ───────────┬─────────── ───────┬─────── ────┬──── ──────────┬──────────
       │     │            │                   │            │               │
    ANCHORS  KI        SLUDGE            DEAD ERRORS    ACTIVE       FREE HEADROOM
    (CYAN) (PINK)  (AMBER/ORANGE)         (CRIMSON)     (GREEN)       (SLATE GRAY)
```

| Glyph | Cell State | Color | Ground-Truth Match in Untruncated Logs |
| :---: | :--- | :--- | :--- |
| `█` | `ANCHOR_CORE` | Cyan | System prompt, `.agents/rules/*.md`, `AGENTS.md`, `implementation_plan.md`, `task.md`. |
| `▒` | `ANCHOR_SCHEMA` | Dim Cyan | Cold-start MCP server and Skill JSON schemas at Turn 0 (`SCHEMA_TAX`). |
| `▓` | `MEMORY_KI` | Violet | Valid repository Knowledge Items (`~/.gemini/antigravity/knowledge/`). |
| `▓` | `MEMORY_BLEED` | Neon Pink | Foreign Knowledge Item whose canonical path belongs to another workspace. |
| `▒` | `STALE_DUP` | Amber | Superseded `view_file` / `grep_search` reads or unpinned chat older than 25 steps. |
| `▒` | `DIRTY_SNAP` | Flashing Amber | File modified on disk (`fs.statSync().mtimeMs`) after the agent's last `view_file`. |
| `▒` | `LEGACY_POISON` | Orange | File matching `deprecated_paths` globs (`legacy/`, `v1/`) or `@deprecated` header. |
| `▓` | `DEAD_ERROR` | Crimson | Failed `run_command` (`exitCode != 0`) or stack trace followed by a passing run. |
| `█` | `ACTIVE_SET` | Emerald Green | Unique active file reads/edits and passing tests in the last 8 turns. |
| `![...]!` | `AMPUTATION` | Red Brackets | Earliest 20% of context (Cells 1-8) at risk of server prefix truncation (`>140k`). |
| `░` | `FREE_HEADROOM` | Slate Gray | Unfilled token capacity remaining in the model's context window. |

### Core Telemetry Formulas

$$\text{Signal Purity (\%)} = \frac{\text{Tokens}(\text{ANCHOR\_CORE} + \text{MEMORY\_KI} + \text{ACTIVE\_SET})}{\text{Total Active Input Tokens}} \times 100$$

$$\text{Sludge Tax (\$/turn)} = \frac{\text{Tokens}(\text{STALE\_DUP} + \text{DEAD\_ERROR} + \text{Unused ANCHOR\_SCHEMA})}{1,000,000} \times \text{Model Input Rate (\$/1M)}$$

---

## Flight Check v3.1 Control Flags & Slash Skills

When installed into Google Antigravity, the `PreInvocation` router evaluates every prompt in **`<15ms`** across 8 deterministic states (`ALLOW_SILENT`, `ALLOW_ACTIVE_SET`, `ALLOW_PLAN_OR_SUBAGENT`, `INJECT_CONTEXT_GUARD`, `STEER_SUBAGENT`, `HALT_HYGIENE_OR_SAFETY`, `HALT_EFFORT_OR_QUOTA`, `HALT_REWRITE_SCORECARD`).

* **`! <prompt>` or `!force <prompt>`**: Bypass Flight Check gating for one turn.
* **`!lock <prompt>`**: Lock current `/model` and `/effort` for the remainder of the session.
* **`#check <prompt>`**: Force Tier-2 semantic scoring, blast-radius check, and copy-paste prompt rewrite.
* **`/horizon`**: Open the interactive 40-cell Chrono-Attention Horizon & Edward Tufte Side-Pane.
* **`/precheck`**: Run an on-demand hygiene and model/effort audit before submitting a complex prompt.

---

## Installation Options

### Option 1: Automatic One-Liner (Recommended)
 works on **Windows 11 (PowerShell)**, **macOS**, and **Linux**:
```bash
# Global install (~/.gemini/config/plugins/agy-horizon-flightcheck)
npx context-horizon init

# Or install into current workspace (.agents/plugins/agy-horizon-flightcheck)
npx context-horizon init --workspace
```

### Option 2: Clone & Local Install
```bash
git clone https://github.com/Gizzant/context-horizon.git
cd context-horizon
npm run install-plugin
```

---

## Benchmark & Verification Suite

`context-horizon` ships with a deterministic, zero-dependency verification suite and a 200-iteration latency benchmark:

```bash
# Run the 15-test router, sensor, and crash-immunity suite (~170ms)
npm test

# Run all 6 architectural phase verification suites (256K/1M scaling, AST pruner, quota, watchdog)
npm run test:phases

# Run the 200-iteration p95/p99 latency benchmark (<15ms PreInvocation SLA)
npm run bench
```

---

## 100% Local & Private by Design

* **Zero Outbound Network Calls:** `context-horizon` never opens an external socket, never phones home, and never uploads prompts, file paths, or telemetry.
* **Local Loopback Only:** The optional Tufte IDE Webview binds strictly to `127.0.0.1`.
* **Zero Supply-Chain Risk:** `0` runtime npm dependencies (`node:fs`, `node:path`, `node:http`, `node:crypto` only). See [SECURITY.md](SECURITY.md) for details.

---

## Contributing & License

Contributions, new blind-spot sensors, and new Tufte small-multiple charts are welcome! Read [CONTRIBUTING.md](CONTRIBUTING.md) for our **"Add a 7th Blind-Spot Sensor in 20 Lines"** guide.

Licensed under the [MIT License](LICENSE).
