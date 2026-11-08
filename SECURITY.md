# Security & Zero-Trust Open-Source Manifest (`context-horizon` / `ctxtop`)

## 1. Zero-Trust Network Profile (100% Local In-Memory Telemetry)

`context-horizon` (`agy-horizon-flightcheck`) inspects sensitive local engineering artifacts (conversation transcripts, file paths, and tool usage). To guarantee enterprise and individual security for the Antigravity and Hacker News developer community:

1. **100% In-Memory Local Telemetry Parsing:** All session token accounting, U-shaped attention curve modeling, and waste classification are computed 100% in-memory from local SQLite (`conversations/*.db`, `conversation_summaries.db`) and JSONL (`transcript_full.jsonl`) reads.
2. **Zero Outbound Network Connections:** Neither the CLI HUD (`src/cli/horizon_hud.mjs`), the lifecycle hooks (`src/hooks/*.mjs`), nor the sidecar daemon (`sidecars/horizon-daemon/server.mjs`) opens any external HTTP, HTTPS, WebSocket, or DNS connections. There are **zero telemetry pings**, **zero analytics endpoints**, and **zero external LLM API keys required**.
3. **Loopback-Only Binding (`127.0.0.1`):** The Edward Tufte WebView server binds exclusively to `127.0.0.1` (`BIND_HOST = '127.0.0.1'`) and rejects oversized POST payloads (`>4096` bytes). Optional local quota probes communicate strictly over `127.0.0.1` loopback with the local Antigravity `language_server` process.
4. **Zero Third-Party npm Dependencies:** The runtime uses only built-in Node.js standard library modules (`node:fs`, `node:path`, `node:os`, `node:http`, `node:crypto`, `node:child_process`, `node:sqlite`, `node:url`), eliminating transitive npm supply-chain risk.

## 2. Read-Only Filesystem Locks (`SQLITE_OPEN_READONLY`)

To eliminate any risk of database lock contention or corruption while Google Antigravity is actively streaming turns:

1. **Strict `SQLITE_OPEN_READONLY` Database Access:** Every connection to Antigravity's active session databases (`~/.gemini/<surface>/conversations/*.db` and `conversation_summaries.db`) is opened with `SQLITE_OPEN_READONLY_OPTIONS` (`{ readOnly: true }`, mapping to `SQLITE_OPEN_READONLY`) and closed immediately in a `finally` block.
2. **Read-Only JSONL File Descriptors (`'r'`):** Incremental transcript slicing (`transcript_full.jsonl` and `transcript.jsonl`) opens log files strictly with read-only flag `'r'` (`fs.openSync(filePath, 'r')`) and never acquires write locks on active Antigravity session databases.
3. **Atomic Sidecar & Backup I/O:** Any optional user-triggered state (such as `docs/HANDOFF_<timestamp>.md` generation or `.bak` transcript backups prior to surgical pruning) is written atomically via PID-scoped temporary files and rename operations.

## 3. Reporting a Vulnerability

If you discover a security or path-handling issue, please open a GitHub Security Advisory on the repository or contact `frankmiller@gmail.com`. We respond to security reports within 48 hours.
