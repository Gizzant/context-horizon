# Stage 1: Schemas, Config & Shared IPC Spine (`sidecar.json`)
**Recommended Model & Effort:** `/model gemini-3.8-flash` | `/effort high` | **Mode:** `auto`

Copy and run the prompt below in Google Antigravity once `implementation_plan.md` is approved:

~~~text
Read @SPEC_AGY_HORIZON_FLIGHTCHECK.md and @implementation_plan.md (Phase 1). Execute Phase 1 by creating the core manifests, configuration defaults, path canonicalizer, and atomic sidecar store. Write one file at a time and keep every file under 300 lines.

### Deliverables to Create in Order

1. `plugin.json`
   - Valid Antigravity v1 plugin manifest (`name`: `"agy-horizon-flightcheck"`, `version`: `"3.1.0"`, `description`, `hooks`: `"./hooks.json"`, `skills`: `["./skills/precheck"]`).

2. `hooks.json`
   - Follow the exact Antigravity hook group specification: top-level key `"horizon-flightcheck-lifecycle"` with `"enabled": true` and direct handler arrays for `"SessionStart"` (timeout 5), `"PreInvocation"` (timeout 15), and `"PostInvocation"` (timeout 5) pointing to `src/hooks/*.mjs`. Do NOT wrap `PreInvocation`, `PostInvocation`, or `SessionStart` in a `matcher` object.

3. `config/default_flightcheck.json`
   - Include default configuration keys:
     - `hook_level`: `"guard"` (`"off" | "audit" | "guard" | "strict"`)
     - `cold_session_max_turns`: 3
     - `trust_decay_turn_threshold`: 10
     - `subagent_min_cache_tokens`: 25000
     - `subagent_min_purity_pct`: 70.0
     - `compact_halt_purity_pct`: 45.0
     - `amputation_token_threshold`: 140000
     - `quota_floor_fraction`: 0.10
     - `max_single_write_lines`: 600
     - `max_tool_payload_tokens`: 25000
     - `uncheckpointed_dirty_file_limit`: 4
     - `consecutive_error_strike_limit`: 3
     - `deprecated_paths`: `["**/legacy/**", "**/deprecated/**", "**/v1/**"]`
     - `model_pricing_per_1m_input`: `{ "gemini-3.8-flash": 0.15, "gemini-3.1-pro": 1.25, "gemini-4-argon": 2.50, "claude-opus-4-6-thinking": 5.00 }`

4. `src/core/path_canonicalizer.mjs`
   - Export `canonicalizePath(rawPath)` and `isSameOrSubPath(parentPath, childPath)`.
   - Must decode URI schemes (`file:///c%3A/...` and `file:///C:/...`), normalize Windows backslashes (`C:\Projects\...`) to forward slashes (`c:/projects/...`), strip trailing slashes, and lowercase drive letters and paths on Windows (`process.platform === "win32"`).

5. `src/core/sidecar_store.mjs`
   - Manage `~/.gemini/flightcheck/sessions/<conversationId>.sidecar.json` and `~/.gemini/flightcheck/tool_usage.json`.
   - Export `createDefaultSidecar(conversationId, workspacePath)`, `readSidecarSync(conversationId)`, `writeSidecarAtomicSync(conversationId, stateObj)`, and `updateSidecarPartialSync(conversationId, mutatorFn)`.
   - Implement lock-free atomic writes using a process-unique temp file (`<conversationId>.<pid>.<hrtime>.tmp`) followed by `fs.renameSync` (with a 1-retry fallback on Windows `EPERM`/`EBUSY` if Antigravity statusLine is reading concurrently).
   - Guarantee `readSidecarSync` executes in under 2ms and returns a valid fallback state object if the file does not exist or is corrupted.

### Verification Step
After creating the 5 files, run a quick Node one-liner or inline test script via `run_command` to verify:
1. `canonicalizePath("file:///c%3A/Projects/argon-test\\studio\\generators.py")` equals `canonicalizePath("C:\\Projects\\argon-test/studio/generators.py")`.
2. `writeSidecarAtomicSync` and `readSidecarSync` complete 100 round-trips with an average read latency under 2ms.
Update `task.md` once Phase 1 passes verification.
~~~