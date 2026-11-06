# Stage 4: Dual-Surface HUD (`statusLine` CLI & Tufte IDE Webview)
**Recommended Model & Effort:** `/model gemini-3.8-flash` | `/effort high` | **Mode:** `auto`

Copy and run the prompt below in Google Antigravity after Stage 3 passes verification:

~~~text
Read @SPEC_AGY_HORIZON_FLIGHTCHECK.md (Section 3) and @implementation_plan.md (Phase 4). Build the CLI `statusLine` HUD script and the IDE Webview panel. Keep each file under 350 lines.

### Deliverables to Create in Order

1. `src/cli/horizon_hud.mjs`
   - Invoked every 300ms by Antigravity CLI via `statusLine` (`type: "command"`, `stack_with_default: true`).
   - **Critical Reliability Requirement:** Antigravity CLI disables the statusline after 30 consecutive failures. Wrap the entire script in a top-level `try / catch` block and register `process.on("uncaughtException", ...)` so any error prints a safe minimal ANSI bar and exits with code `0`.
   - Read the JSON payload from `process.stdin` (non-blocking with a 150ms stdin read timeout). Extract:
     - `conversation_id` (or active brain UUID fallback)
     - `context_window.total_input_tokens`, `used_percentage`, `exceeds_200k_tokens`
     - `modelName`
     - `mode` (`"accept-edits" | "auto" | "plan"`)
     - `agent_state` (`"idle" | "working" | "tool_use" | "reviewing" | "error"`)
     - `quota` (extract minimum `remaining_fraction` across active buckets)
   - Run `resolveAndReadTranscriptIncremental`, `classifyHorizonWindow`, and `runAllBlindspotSensors`, then persist the updated state atomically to `sidecar.json` via `writeSidecarAtomicSync`.
   - Render the single-line ANSI HUD bar:
     - Full mode (`process.stdout.columns >= 120`): 40-cell colored glyph strip (`█`, `▓`, `▒`, `░`), `![...]!` red brackets around cells 0 to 7 when `amputationRisk` is true, followed by `Purity: XX% | Sludge: +$0.XX/t | Quota: XX% | Effort: <STATUS>`.
     - Compact mode (`process.stdout.columns < 120`): 20-cell condensed strip + `P:XX% | S:$0.XX | Q:XX%` so Antigravity's Ink TUI renderer never clips or hides the bar.

2. `src/webview/horizon_panel.html`
   - Self-contained single-file HTML/CSS/JS dashboard for the Antigravity IDE Side-Pane and `/horizon` inline widget (`<agent-embed>`).
   - Strictly follow Edward Tufte's data visualization principles:
     - High data-ink ratio, zero decorative chartjunk, no heavy drop shadows or neon gradients, clean monospace and system-ui typography, crisp 1px hairlines.
     - Top band: 40-cell chronological horizon strip with hover inspection showing exact token counts, step indices, and file paths per cell.
     - Middle band: Small-multiple sparklines for Signal Purity (%) and Sludge Tax ($/turn) over the last 20 turns.
     - Bottom band: Scannable tabular ledger listing Active Set files (green), Stale Duplicate paths (amber), Dirty Disk Snapshots (flashing amber), Unseen Callers, and Foreign KI Bleed with one-click copyable `/compact`, `/clear`, or `/context` remediation commands.
     - Include a `window.updateHorizonTelemetry(sidecarJson)` global hook plus a built-in demo state loader for standalone previewing.

### Verification Step
Pipe a sample 26-field Antigravity `statusLine` JSON payload into `node src/cli/horizon_hud.mjs` via `run_command` and verify:
1. It outputs a properly formatted ANSI status bar in under 45ms and exits `0`.
2. It writes the updated `sidecar.json` containing the parsed `quota` and `mode` fields.
3. Passing malformed JSON to `stdin` still exits `0` with the fallback status bar.
Update `task.md` once verified.
~~~