# Attention Horizon (`ctxtop`) — Architectural & UI Invariants
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
