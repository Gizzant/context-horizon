# Stage 3: The 6 Community Blind-Spot Sensors
**Recommended Model & Effort:** `/model gemini-3.8-flash` | `/effort high` | **Mode:** `auto`

Copy and run the prompt below in Google Antigravity after Stage 2 passes verification:

~~~text
Read @SPEC_AGY_HORIZON_FLIGHTCHECK.md (Section 4) and @implementation_plan.md (Phase 3). Create `src/core/blindspot_sensors.mjs` implementing all 6 blind-spot detectors. Keep the file modular and under 350 lines.

### Deliverables to Create

1. `src/core/blindspot_sensors.mjs`
   Export pure/fast sensor functions plus a unified `runAllBlindspotSensors(params)` aggregator:

   - **Sensor 1: `detectDirtySnapshots(stepEvents, workspacePath)` (`DIRTY_SNAP`)**
     - Track the latest `timestampMs` of `view_file`, `write_to_file`, or `replace_file_content` per canonical file path in the current session.
     - Check `fs.statSync(filePath).mtimeMs` on disk. If `mtimeMs > lastSessionTouchMs + 500` (500ms clock-skew tolerance), add the path to `dirtySnapshotPaths` so Flight Check knows another session, subagent, or external editor modified the file.

   - **Sensor 2: `auditSchemaAndPayloads(stepEvents, toolUsageLedger, config)` (`SCHEMA_TAX`)**
     - Calculate `schemaTaxPct` from Turn 0 schema tokens divided by 200,000.
     - Identify MCP servers in `toolUsageLedger` with 0 invocations across the last 15 sessions when `schemaTaxPct > 15`.
     - Check the most recent turn's tool outputs for any single payload exceeding `config.max_tool_payload_tokens` (25,000 tokens, such as unclipped base64 images or massive logs) and flag `oversizedPayloadDetected`.

   - **Sensor 3: `detectUnseenCallers(targetFiles, activeSetPaths, workspacePath)` (`UNSEEN_CALLERS`)**
     - Build or read a fast cached reverse-import map of the workspace (parse `SITEMAP.md` if present, or scan `.py`, `.ts`, `.tsx`, `.js`, `.mjs` files for `import` / `from` / `require` statements cached by directory `mtime`).
     - For any file in `targetFiles`, return all importing files in the workspace that are NOT currently in `activeSetPaths`.

   - **Sensor 4: `detectLegacyPoison(stepEvents, config)` (`LEGACY_POISON`)**
     - Match `view_file` paths against `config.deprecated_paths` patterns (`legacy`, `deprecated`, `v1`) or check if `isDeprecatedContent` (`@deprecated` in the first 30 lines) is true. Return `legacyPoisonPaths`.

   - **Sensor 5: `evaluateQuotaAndStreamShield(sidecarState, targetFiles, promptText, config)` (`QUOTA_AND_STREAM_SHIELD`)**
     - Read native `quota.remaining_fraction` from `sidecarState.telemetry` (falling back to the rolling 5-hour request ledger if omitted). Flag `quotaFloorBreached = true` when remaining fraction is below `config.quota_floor_fraction` (`0.10`).
     - Flag `planToFlashHandoffNeeded = true` when the previous turn was in `plan` mode on a `pro`/`argon`/`opus` model, the current model is `flash`, and `totalInputTokens > 40000`.
     - For each existing file in `targetFiles`, check line count; if line count exceeds `config.max_single_write_lines` (600 lines) and the prompt asks for a full rewrite/regeneration, flag `streamCutoffRiskFiles`.

   - **Sensor 6: `evaluateLoopAndGitGuard(stepEvents, sidecarState, workspacePath, config)` (`LOOP_AND_GIT_GUARD`)**
     - Count consecutive trailing `DEAD_ERROR` / failed `run_command` events on the same command or file. Flag `threeStrikeLoop = true` at `>= config.consecutive_error_strike_limit` (3).
     - Run a fast `git status --porcelain` check (with a 200ms timeout) in `workspacePath`. If modified/untracked code files `>= config.uncheckpointed_dirty_file_limit` (4) and turns since last passing test `>= 3`, flag `uncheckpointedGitDrift = true`.

### Verification Step
Run a verification test via `run_command` that mocks each of the 6 conditions (including touching a temp file's `mtime` 5 seconds into the future, simulating 3 consecutive failed `run_command` events, and passing a 750-line file target) and verifies all 6 sensors return exact matches in under 15ms total. Update `task.md` when complete.
~~~