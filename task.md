# Task Checkpoint: Universal Auto-Dismiss for Recommended Action Items & Tag Sanitization

## 1. Problem Statement & Root Cause
In earlier revisions:
- Only chronic re-reads and rule learning had dismissal keys assigned.
- Actions like **Checkpoint Hygiene** (`Save/Update task.md`), **AST Condense** (`Condense duplicate reads into signature stubs`), and **MCP Lazy** (`Switch unused eager MCP to lazy`) lacked `data-dismiss-key` attributes, so clicking their copy or direct execution buttons did not dismiss them.
- Direct execution buttons (`Auto-Add Rule`, `Condense Now`, `Register PreToolUse Hook`) did not consistently dismiss their respective action rows.
- If `navigator.clipboard.writeText()` rejected (e.g. in unfocused iframes or webviews without clipboard permissions), dismissals were aborted.
- User correction strings could retain `<USER_REQUEST>` wrapper tags if the tags had leading whitespace or were truncated before the closing tag.

## 2. Completed Items & Architectural Enhancements

- [x] **Universal Auto-Dismiss across All 5 Action Categories**:
  - **Checkpoint Sync (`checkpoint-sync`)**:
    - Assigned `data-dismiss-key="checkpoint"` to container `<details>`, `📋 Copy Prompt`, and `🚀 Send Prompt to Chat`.
    - Added filter `!dismissedKeys.has('checkpoint')` to both new and stale checkpoint checks.
    - Synchronized Tier 2 `#actionRowCheckpoint` to hide when `checkpoint` is dismissed.
  - **AST Condense (`condense-ast`)**:
    - Assigned `data-dismiss-key="condense"` to container, `📋 Copy Command`, and `⚡ Condense Now`.
    - Added filter `!dismissedKeys.has('condense')`.
  - **MCP Lazy (`mcp-lazy`)**:
    - Assigned `data-dismiss-key="mcp:<serverName>"`.
    - Filtered `unusedEagerServers` by `!dismissedKeys.has('mcp:' + s.name)` to support granular per-server dismissal.
  - **Single-Turn Spikes (`dampen-blowup`)**:
    - Assigned `data-dismiss-key="spike:<stepIndex>"` to container and buttons.
    - Added dismissal trigger to `registerDampeningHook` upon successful hook registration.
  - **Agent Learning (`agent-learning`)**:
    - Assigned `data-dismiss-key="rule"`.
    - Auto-Add Rule and Copy Prompt both dismiss the card and decrement action counts.
  - **Chronic Re-reads (`chronic-read`)**:
    - Retained `data-dismiss-key="chronic:<normPath>"`.

- [x] **Direct Execution Button Dismissal**:
  - Both copy buttons (`📋 Copy Prompt` / `📋 Copy Command`) and direct action buttons (`🎯 Auto-Add Rule`, `⚡ Condense Now`, `🛡️ Register PreToolUse Hook`, `🚀 Send Prompt to Chat`) trigger row dismissal with visual feedback (`✓ Copied & Dismissed!`, `✓ Condensing & Dismissed!`, etc.).

- [x] **Resilient Clipboard Fallback (`copyTextWithFallback`)**:
  - Implemented async fallback attempting `navigator.clipboard.writeText(text)` first, falling back to an off-screen `textarea` with `document.execCommand('copy')`.
  - Guarantees dismissal executes even in environments with restricted clipboard permissions.

- [x] **Global `<USER_REQUEST>` Tag Sanitization**:
  - Replaced anchored regexes with `/<\/?USER_REQUEST>/gi` across:
    - `src/core/classifier.mjs`
    - `src/core/layer5_hygiene.mjs`
    - `src/webview/horizon_panel.html` (preview, rule attribute, and `promoteRuleDirect`)

- [x] **Deterministic Test Coverage**:
  - Added new comprehensive test `Universal Action Auto-Dismiss: Checkpoint, Condense, MCP, and Spike dismiss on Copy or Direct Action` in `tests/test_wave3_wedge.mjs`.
  - Verified 52/52 unit tests pass (100%).
  - Verified all 8 phase verification test suites pass (0 errors).
  - Verified all 7 E2E validation layers pass.

- [x] **Conditional Gating for Compaction & Task Checkpoint Recommendations**:
  - `Compact conversation history (/compact)` (`compact-context`) is now hidden until compaction is actually needed (`isOverLimit || isNeedsCleanup || reclaimable >= 25k`).
  - `Save / Update task.md checkpoint before compacting` (`checkpoint-sync` and `#actionRowCheckpoint`) is now hidden until compaction is needed, pre-compaction git drift is active (`hasDriftWarn`), or `task.md` is `>= 5` turns behind (`turnsBehind >= 5`), and only when `task.md` is actually unsaved/stale (`!exists || !isSaved || turnsBehind >= 3 || hasDriftWarn`).

- [x] **Mirror Parity & Asset Build**:
  - Synchronized `src/webview/horizon_panel.html` byte-for-byte across all 3 mirrors (`SHA-256: fe6ee78701943859edfddad0f8c5a1a18a20443b63a9947404290fdc2dcebb9e`).
  - Built standalone demo page `docs/index.html`.
