# Security & Privacy Policy (`context-horizon` / `ctxtop`)

## 100% Local Execution & Zero Network Telemetry Guarantee

`context-horizon` (`agy-horizon-flightcheck`) inspects sensitive local engineering artifacts (conversation transcripts, file paths, and tool usage). To guarantee enterprise and individual security:

1. **Zero Outbound Network Requests:** Neither the CLI HUD (`src/cli/horizon_hud.mjs`), the lifecycle hooks (`src/hooks/*.mjs`), nor the sidecar daemon (`sidecars/horizon-daemon/server.mjs`) makes any outbound HTTP, HTTPS, WebSocket, or DNS calls.
2. **Loopback-Only Webview Binding:** The Edward Tufte Webview server binds exclusively to `127.0.0.1` (`BIND_HOST = '127.0.0.1'`) and rejects oversized POST payloads (`>4096` bytes).
3. **Zero Third-Party npm Dependencies:** The runtime uses only built-in Node.js standard library modules (`node:fs`, `node:path`, `node:os`, `node:http`, `node:crypto`, `node:child_process`, `node:url`), eliminating transitive npm supply-chain risk.
4. **Atomic Local File I/O:** Shared state in `~/.gemini/flightcheck/` and `~/.gemini/antigravity/cache/agy-horizon/` is written atomically via PID-scoped temporary files and rename operations.

## Reporting a Vulnerability

If you discover a security or path-handling issue, please open a GitHub Security Advisory on the repository or contact `frankmiller@gmail.com`. We respond to security reports within 48 hours.
