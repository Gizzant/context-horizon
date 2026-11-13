# Attention Horizon (`ctxtop`) — Architectural & UI Invariants
- **User Constraint**: my account was just re-enabled from getting disabled (see error message below) review tips to avoid
- **User Constraint**: To keep context memory lean, please use `StartLine`/`EndLine` when reading `src/webview/horizon_panel.html`, `src/core/classifier.mjs`, and `sidecars/horizon-daemon/server.mjs` instead of reading full files repeatedly.

## UI & Architecture Invariants
1. **1-Click Copy Button for `/compact`**:
   - Render a clickable "Copy `/compact`" button (`#btnCompactPrimary`, `#btnCopyParameterizedCompact`) alongside `#compactInstruction` (`Type /compact in the chat box and press Enter`) and `#compactReclaim`.
2. **Active Source File Protection**:
   - Only show the `Ignore file` (`.antigravityignore`) button on lockfiles, logs, build artifacts, or scratch files (`isIgnorablePath`) — never on active source code files.
3. **Webview Mirror Parity**:
   - When local Antigravity plugin directories (`~/.gemini/config/plugins/agy-horizon` and `~/.gemini/config/plugins/agy-horizon-flightcheck`) are present on disk, run `node scripts/sync_mirrors.mjs` to keep `horizon_panel.html` and `src/core/*.mjs` byte-for-byte identical (verified via SHA-256).
4. **Zero-Trust Read-Only Telemetry (`SQLITE_OPEN_READONLY`)**:
   - Open all Antigravity SQLite session databases (`conversations/*.db`, `conversation_summaries.db`) strictly with `{ readOnly: true }` (`SQLITE_OPEN_READONLY_OPTIONS`) and JSONL transcripts with `'r'`. Never make outbound network requests.
5. **Account & OAuth Seat Safety (Anti-Ban Protocol)**:
   - Never read or touch Antigravity/Cloud Code OAuth credentials (`~/.gemini/oauth_creds.json`, Windows Credential Manager `gemini:antigravity`) or poll internal Google Cloud Code endpoints.
   - Never spawn headless `gemini` or `agy` CLI processes inside test runners (`e2e_harness.mjs` or integration tests) using `"selectedAuthType": "oauth-personal"`.
   - Avoid unthrottled repo-wide grep/read loops and parallel subagent fan-out (`/teamwork` or concurrent `invoke_subagent` bursts) on an interactive OAuth seat; batch searches or edits into 1–2 consolidated tool calls per turn.
