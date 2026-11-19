# Highbeam (`ctxtop`) — AI Context & KV-Cache HUD Extension

Live **40-cell context window profiler**, **warm KV-cache TTL timer (`5m/1h`)**, and **zero-token guardrails HUD** inside **VS Code**, **Google Antigravity**, **Cursor**, **Windsurf**, and **Open VSX** editors.

[**Interactive Demo**](https://gizzant.github.io/context-horizon/demo/) • [**User Guide**](https://gizzant.github.io/context-horizon/) • [**GitHub Repository**](https://github.com/Gizzant/context-horizon)

---

## What It Provides

- **Sidebar Activity Bar WebView (`highbeam.hudView`)**: Embeds Highbeam's Simple & Advanced 40-cell HUD served strictly over local loopback (`http://127.0.0.1:<port>/`).
- **Live Status Bar Item**: Displays context occupancy %, warm KV-cache TTL countdown (`TTL 3m42s` / `Cold`), `AUTO` mode indicator, and severity state without leaving your editor.
- **Zero-Config Daemon Auto-Discovery**: Automatically connects to an already running Highbeam daemon via `~/.ctxtop/daemon.json` / `~/.ctxtop/daemon.port` or launches `ctxtop --serve` cleanly in the background.
- **1-Click Quick Actions & Commands**: Focus sidebar, open full editor panel, copy `/compact`, run a read-only 7-day audit (`npx ctxtop audit --days 7`), or run `npx ctxtop doctor`.

## Requirements

- **Node.js `>= 22.13.0`** on your `PATH` (or configured via `highbeam.nodePath`) so the local telemetry daemon can read Antigravity and Cursor SQLite databases strictly read-only via `node:sqlite`.
- Optional global or workspace install of [`ctxtop`](https://github.com/Gizzant/context-horizon) (falls back automatically to workspace checkout, `~/.ctxtop/app/`, or `npx --yes ctxtop --serve`).

## Commands

| Command ID | Title |
| :--- | :--- |
| `highbeam.openSidebar` | Highbeam: Focus Sidebar View |
| `highbeam.openPanel` | Highbeam: Open Full HUD in Editor Tab |
| `highbeam.copyCompact` | Highbeam: Copy `/compact` to Clipboard |
| `highbeam.runAudit` | Highbeam: Run 7-Day Session ROI Audit (Read-Only) |
| `highbeam.runDoctor` | Highbeam: Run Doctor Health Check |
| `highbeam.startDaemon` | Highbeam: Start / Reconnect Local Telemetry Daemon |
| `highbeam.stopDaemon` | Highbeam: Stop Managed Local Daemon |
| `highbeam.openInBrowser` | Highbeam: Open HUD in External Browser |

## Settings

- `highbeam.autoStartDaemon` (`boolean`, default `true`): Auto-discover or start the local loopback daemon on activation.
- `highbeam.daemonPort` (`integer`, default `62935`): Preferred loopback port on `127.0.0.1`.
- `highbeam.cliCommand` (`string`, default `""`): Custom path to `ctxtop` binary or `sidecars/horizon-daemon/server.mjs`.
- `highbeam.nodePath` (`string`, default `"node"`): Path to Node.js (`>= 22.13.0`).
- `highbeam.statusBarEnabled` (`boolean`, default `true`): Toggle the live status bar telemetry item.
- `highbeam.pollIntervalMs` (`integer`, default `3000`): Polling interval in milliseconds (`1000..30000`).

## Zero-Outbound-Network Privacy Guarantee

- **0 runtime `npm` dependencies**.
- Communicates exclusively over `127.0.0.1` loopback HTTP.
- Never reads OAuth credentials and never sends prompts, file paths, or telemetry to any remote server.
