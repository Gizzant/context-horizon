# Path: AGENTS.md

# Context Horizon (`ctxtop`) — Architectural & UI Invariants

## UI & Architecture Invariants
1. **No Copy/Paste Button for `/compact`**:
   - Never render a clickable "Copy `/compact`" button (`#btnCompactPrimary`, `copyCompactWithGuidance`) or `Ctrl+V` paste instructions for `/compact`.
   - Always render a plain-text instruction (`Type /compact in the chat box and press Enter`) inside `#compactInstruction` with the reclaim summary in `#compactReclaim`.
2. **Active Source File Protection**:
   - Only show the `Ignore file` (`.antigravityignore`) button on lockfiles, logs, build artifacts, or scratch files (`isIgnorablePath`) — never on active source code files.
3. **Webview Mirror Parity**:
   - When local Antigravity plugin directories (`~/.gemini/config/plugins/agy-horizon` and `~/.gemini/config/plugins/agy-horizon-flightcheck`) are present on disk, run `node scripts/sync_mirrors.mjs` to keep `horizon_panel.html` and `src/core/*.mjs` byte-for-byte identical (verified via SHA-256).
4. **Zero-Trust Read-Only Telemetry (`SQLITE_OPEN_READONLY`)**:
   - Open all Antigravity SQLite session databases (`conversations/*.db`, `conversation_summaries.db`) strictly with `{ readOnly: true }` (`SQLITE_OPEN_READONLY_OPTIONS`) and JSONL transcripts with `'r'`. Never make outbound network requests.
