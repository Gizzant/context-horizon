# `ctxtop` (Highbeam v3.3.0) — Public Multi-Channel Launch Kit

Ready-to-post, technical launch copy tailored to the engineering culture of each target community. Zero marketing fluff, zero AI buzzwords.

---

## 1. Hacker News (`Show HN`)

### Title
`Show HN: Ctxtop – Local-only htop for AI coding agent context windows, KV-cache TTLs, and SQLite logs`

### First Comment (Author Technical Breakdown)
Hi HN,

I built `ctxtop` (Highbeam) because cloud LLM observability tools (Langfuse, Helicone, etc.) only see HTTP request/response payloads—they have no visibility into what is happening on disk inside local coding harnesses like Google Antigravity, Claude Code, and Cursor.

When a long coding session degrades at Turn 35, the root cause is almost always local:
1. **Silent 1h-to-5m KV-Cache Cliffs & Prefix Busts:** If your session drops from a 1-hour cache tier to a 5-minute fallback/overage tier—or if an MCP server dynamically injects `mcp_instructions_delta` / `deferred_tools_delta` mid-run—a single turn on a 150k-token context forces a 100% uncached prefix rebuild (costing 12.5x–80x more than a warm cache read).
2. **Compaction Lobotomy:** Autocompact at 80%–95% saturation summarizes away exact line numbers, unresolved test `stderr`, and checklist state, causing the agent to immediately re-read the exact same files it just edited.
3. **Stale Disk Overwrites (`DIRTY_SNAP`):** You edit a file in your IDE or run `git pull`, and the agent overwrites your disk changes using a stale snapshot it read 12 turns ago.
4. **Local SQLite Bloat (`state.vscdb`):** Cursor's `cursorDiskKV` table accumulates 30GB–100GB of orphaned `bubbleId:*`, `checkpointId:*`, and `agentKv:blob:*` rows after composer sessions are deleted, and standard `VACUUM` fails on low-disk machines because it requires 2x free disk space and an exclusive write lock.

**How `ctxtop` works under the hood:**
- **Zero runtime npm dependencies (`.mjs` on Node 22.5+ built-ins):** Uses `node:sqlite`, `node:fs`, `node:http`, and `node:crypto`. Zero outbound network calls, zero telemetry beacons, and zero external API keys.
- **Strict Read-Only SQLite & Protobuf Wire-Walking (`SQLITE_OPEN_READONLY`):** Opens `conversations/<uuid>.db`, `state.vscdb`, and `store.db` strictly with `Object.freeze({ readOnly: true })` so it can never contend for WAL/write locks with a live IDE. Includes a zero-dependency protobuf wire-format decoder (`decodeProtobufWire`) to walk binary `step_payload` blobs without `.proto` schemas, and a DAG stitcher for Claude Code `parentUuid -> uuid` `/rewind` trees.
- **40-Cell Flamegraph & Parabolic Attention Trough:** Maps the context window into 40 chronological cells, computes U-shaped positional recall ($A_u(i) = (1 - \gamma) + 4\gamma(i/N - 0.5)^2$), and highlights the top 3–5 riskiest cells (e.g., `task.md` stranded in the 30%–70% low-attention trough or files read 6x without intermediate edits).
- **Offline Prefix-Safe Tool-Output Surgeon (`--prune-tools`):** Pairs `tool_use` and `tool_result` across turns while pinning Turn 0 and the newest 6 turns. Truncates superseded file reads, unreferenced exploratory `grep` outputs, and resolved test `stderr` traces with an atomic `.pre_surgeon` backup.
- **`<15ms` PreInvocation Flight Check Router:** Optional lifecycle hook that checks 6 local sensors (`fs.statSync` mtime drift, `<8ms` reverse-import scan for unseen callers, Turn-0 eager MCP schema tax, 3-strike identical command error loops) before a turn executes.

Live interactive WebView demo (runs 8 precomputed crisis scenarios in-browser): https://gizzant.github.io/attention-horizon-antigravity/
Repo (MIT): https://github.com/Gizzant/attention-horizon-antigravity

Happy to answer questions on the SQLite/protobuf formats across harnesses or prompt-cache invalidation mechanics.

---

## 2. Google AI Developers Forum (`discuss.ai.google.dev`) & `r/google_antigravity`

### Title
`[Open Source] ctxtop v3.2: 256k Cortex Horizon Profiler, brain/ Migration Recovery, and Subagent Worktree DAG Inspector for Antigravity`

### Post Body
If you run long multi-turn sessions in Google Antigravity (`[App]`, `[IDE]`, or `[CLI]`), you have likely hit three platform-specific walls:
1. **The 256k Cortex Ceiling (`0x3E800`) & 50k Cascade Sync:** Even on 1M-context models like Gemini 4 Argon, unpatched `cortex/utils.GetCheckpointConfig` clamps assembly at `256k` (`179k` safe horizon), and crossing `50k` tokens with a pending `task.md` item arms synchronous auto-compaction (`CORTEX_STEP_TYPE_CHECKPOINT = 23`).
2. **Orphaned `brain/` Directories Across Surface Updates:** Switching between `antigravity-cli`, `antigravity-ide`, and `antigravity` or upgrading across 2.6+ can leave `task.md`, `implementation_plan.md`, and `walkthrough.md` stranded in an older surface directory while the active `.db` session expects them in `~/.gemini/antigravity/brain/<uuid>/`.
3. **Opaque `.db` Protobuf Steps & Multi-Agent Worktree Collisions:** When `transcript.jsonl` truncates fields or when multiple `invoke_subagent` workers run in parallel, it is hard to see which subagent is burning quota or if two subagents edited the same file concurrently.

I built **`ctxtop` (Highbeam v3.3.0)**—a zero-dependency local profiler and `<15ms` `PreInvocation` router built specifically around Antigravity's storage architecture:

- **Read-Only `conversations/<uuid>.db` + Protobuf Stitcher:** Uses Node's built-in `node:sqlite` with `{ readOnly: true }` (`SQLITE_OPEN_READONLY`) to read `gen_metadata` (`input_tokens`, `cache_read_tokens`) and walks binary protobuf `steps` payloads alongside `annotations/<uuid>.pbtxt` and `transcript_full.jsonl`.
- **Pre-Compaction `.handoff.md` Distiller & `task.md` Drift Guard:** Cross-checks `git status --porcelain=v1 -z` (filtered to files modified in the current session) against `task.md` freshness before you run `/compact`, and deterministically writes `.handoff.md` at `>=80%` saturation.
- **Automated `brain/` Migration Recovery:** Run `node src/cli/doctor.mjs --recover-brain` to scan all `~/.gemini/antigravity*/conversations/*.db` stores and relink orphaned `task.md` / `implementation_plan.md` artifacts back into the active brain directory.
- **Subagent Worktree DAG & Collision Detector:** Tracks child vs. parent token compression ratios, independent 5-minute subagent cache TTLs, and flags `SUBAGENT_FILE_COLLISION` if two subagents touch the same canonical file path.

**Try it locally (0 npm dependencies):**
```bash
git clone https://github.com/Gizzant/attention-horizon-antigravity.git
cd attention-horizon-antigravity
node src/cli/doctor.mjs
node src/cli/horizon_hud.mjs --demo
```
- **Interactive WebView Demo:** https://gizzant.github.io/attention-horizon-antigravity/
- **GitHub Repository:** https://github.com/Gizzant/attention-horizon-antigravity

---

## 3. `r/ClaudeAI` & `r/ClaudeCode`

### Title
`I built a local-only profiler to stop the 12.5x–80x Prompt Cache Tax, subagent 5m TTL starvation, and compaction lobotomies (0 dependencies, no API keys)`

### Post Body
Anyone running heavy refactors in Claude Code knows how brutal prompt cache invalidation and autocompact can be on both token costs and 5-hour/7-day rate limits:

1. **The 12.5x–80x Prompt Cache Tax & 1h -> 5m Overage Cliff:** Warm cache reads are discounted 90%–95%, while cache writes/uncached input tokens cost 10x–12.5x more (and up to 80x more across 20 turns when a prefix busts). Worse, if your session drops from the 1-hour cache tier to the 5-minute fallback/overage tier—or a parent thread waits >300s on a slow subagent—your 150k prefix silently expires.
2. **Mid-Session Prefix Mutations:** Dynamic MCP tool additions (`deferred_tools_delta`, `mcp_instructions_delta`) or `CLAUDE.md` edits mid-session invalidate the KV cache from that block forward without warning.
3. **Offline Tool Sludge (`Read` x6, Exploratory `grep`, Old `stderr`):** Reading an 800-line file 5 times or dumping 15k tokens of `grep`/test failure output bloats the middle of the context window (the 30%–70% low-attention trough) and triggers autocompact early.

I open-sourced **`ctxtop` (Highbeam)**, a 100% offline CLI and Edward Tufte WebView that inspects local JSONL/SQLite transcripts with **zero external API keys and zero network calls**:

- **Dual-TTL Countdown & Prefix Mutation Diff:** Tracks `1h` vs. `5m` main-thread TTL alongside `5m` subagent TTLs, and pinpoints the exact turn, component (`system_prompt`, `mcp_tool_declarations`, `mcp_instructions_delta`), block index, and byte/token delta that caused a cache miss.
- **Cold-Session Cost Gate:** Calculates the exact dollar and quota-unit multiplier before you send a prompt into a cold `0s TTL` window, advising when `/clear` + `.handoff.md` beats paying a cold compaction rebuild.
- **100% Offline Verbatim Tool-Output Surgeon (`--prune-tools`):** Pairs `tool_use_id` / `sourceToolAssistantUUID` with tool results while strictly pinning Turn 0 and the newest 6 turns. Truncates superseded `Read` outputs, unreferenced `grep`/`glob` dumps, and resolved test `stderr` traces on disk after writing an atomic `.pre_surgeon.<ts>.bak` backup.
- **Claude Code `/rewind` DAG & MCP Token ROI Matrix:** Reconstructs the `parentUuid -> uuid` tree up to `leafUuid` (isolating abandoned `/rewind` branches), audits `CLAUDE.md` for broken `@path` imports, and flags 0-call eager MCP servers (`IDLE_BLOAT_TAX`).

**Quick start:**
```bash
npx attention-horizon-antigravity --demo
node src/cli/doctor.mjs --prune-tools --dry-run
```
- **Live Browser Demo:** https://gizzant.github.io/attention-horizon-antigravity/
- **GitHub (MIT, 0 dependencies):** https://github.com/Gizzant/attention-horizon-antigravity

---

## 4. Cursor Forum & `r/cursor`

### Title
`[Tool] Safely reclaim 30GB–100GB of orphaned Cursor state.vscdb bloat (without VACUUM locks) + stitch fragmented agent transcripts`

### Post Body
If Cursor's `state.vscdb` has ballooned to 30GB–100GB+ on your machine, you've probably discovered two painful facts:
1. Deleting old Composer chats in the UI leaves behind millions of orphaned `bubbleId:<composerId>:<bubbleId>`, `checkpointId:*`, `messageRequestContext:*`, and unreferenced `agentKv:blob:*` rows inside the `cursorDiskKV` SQLite table.
2. Running `sqlite3 state.vscdb "VACUUM;"` fails on low-disk laptops because SQLite `VACUUM` requires **2x the database size in free disk space** and locks the database file.

On top of that, Cursor splits agent telemetry across three separate places: `state.vscdb` (`cursorDiskKV`), `~/.cursor/chats/.../store.db` (hex-encoded `meta` + `blobs`), and timestamp-less `agent-transcripts/*.jsonl` files—making it nearly impossible to see why an agent session is hitting context rot or re-reading the same files.

I built **`ctxtop` (Highbeam)**, a zero-dependency local systems utility (Node.js built-in `node:sqlite`, 0 npm packages, 0 network calls) that solves both problems:

### 1. Streaming `state.vscdb` Garbage Collector (`--gc-cursor`)
Instead of an in-place `VACUUM` lock, `ctxtop` opens `state.vscdb` strictly with `SQLITE_OPEN_READONLY`, audits active `composerData:<id>` roots and live `agentKv:blob:*` references, streams only live rows into a clean `.compact.sqlite` file, writes a `.pre_gc.<timestamp>.bak` backup, and atomically swaps it in:
```bash
# Audit orphaned bubbleId / checkpointId / agentKv bytes first (100% read-only dry run)
node src/cli/doctor.mjs --gc-cursor --vscdb "/path/to/Cursor/User/globalStorage/state.vscdb" --dry-run

# Execute streaming compaction with automatic .pre_gc backup
node src/cli/doctor.mjs --gc-cursor --vscdb "/path/to/Cursor/User/globalStorage/state.vscdb"
```

### 2. Cross-Store Cursor Trajectory Stitcher & 40-Cell Context HUD
- Correlates `composerData`, `bubbleId`, `agentKv:blob:*` (`providerOptions.cursor.requestId` / `ai_code_hashes.requestId`), `store.db`, and `agent-transcripts/*.jsonl` into a unified timeline.
- Visualizes your 40-cell context window, highlights duplicate file reads and stale disk snapshots (`DIRTY_SNAP`), and lets you prune stale tool outputs offline (`--prune-tools`).

- **Live Interactive Demo:** https://gizzant.github.io/attention-horizon-antigravity/
- **GitHub Repo (MIT, 0 runtime dependencies):** https://github.com/Gizzant/attention-horizon-antigravity
