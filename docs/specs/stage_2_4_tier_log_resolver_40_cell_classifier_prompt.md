# Stage 2: 4-Tier Untruncated Log Resolver & 40-Cell Horizon Classifier
**Recommended Model & Effort:** `/model gemini-3.8-flash` | `/effort high` | **Mode:** `auto`

Copy and run the prompt below in Google Antigravity after Stage 1 passes verification:

~~~text
Read @SPEC_AGY_HORIZON_FLIGHTCHECK.md (Section 3) and @implementation_plan.md (Phase 2). Implement the 4-tier incremental log resolver and the 40-cell Chrono-Attention Horizon classifier. Keep each file under 350 lines.

### Deliverables to Create in Order

1. `src/core/log_resolver.mjs`
   - Export `resolveAndReadTranscriptIncremental(conversationId, cursorState = {})`.
   - Implement the 4-tier untruncated fallback order under `~/.gemini/antigravity/brain/<conversationId>/`:
     1. `.system_generated/logs/transcript_full.jsonl`
     2. `.system_generated/logs/chunks/transcript_full/*.jsonl` (sorted chronologically)
     3. `.system_generated/logs/transcript.jsonl` (if an entry contains `truncated_fields`, automatically hydrate the full tool output from `steps/<stepIndex>/output.txt` when available)
     4. `~/.gemini/antigravity/conversations/<conversationId>.db` fallback metadata check.
   - Maintain a byte-offset cursor (`{ filePath, byteOffset, parsedEvents }`) using `fs.openSync` and `fs.readSync` so each 300ms tick only parses newly appended bytes since the last call.
   - Normalize each log entry into a lightweight `StepEvent` object: `{ stepIndex, timestampMs, role, type, toolName, targetPath, exitCode, tokenEstimate, isDeprecatedContent, rawTextSample }`.

2. `src/core/horizon_classifier.mjs`
   - Export `classifyHorizonWindow(stepEvents, contextWindowMeta, workspacePath, knowledgeItemsMeta, config)`.
   - Divide the 200,000-token capacity into 40 discrete cells (5,000 tokens per cell).
   - Classify active token spans into the 10 semantic states from the specification:
     - `ANCHOR_CORE` (system prompt, `.agents/rules/*.md`, `implementation_plan.md`, `task.md`)
     - `ANCHOR_SCHEMA` (Turn 0 MCP and Skill JSON schema definitions)
     - `MEMORY_KI` vs `MEMORY_BLEED` (compare canonicalized KI `metadata.json` project paths against `workspacePath` using `path_canonicalizer.mjs`)
     - `ACTIVE_SET` (unique `view_file`, `write_to_file`, `replace_file_content`, and passing test runs within the last 8 turns)
     - `STALE_DUP` (earlier `view_file` or `grep_search` calls whose `targetPath` was re-read in a later step, or chat turns older than 25 steps)
     - `DEAD_ERROR` (`run_command` with `exitCode !== 0` or tool errors followed by a subsequent passing command or edit)
     - `DIRTY_SNAP` and `LEGACY_POISON` hooks (accept flags from `blindspot_sensors.mjs`)
     - `AMPUTATION` flag (`amputationRisk = true` when `totalInputTokens > config.amputation_token_threshold` and cells 0 through 7 contain `ANCHOR_CORE`, active background PIDs, or uncompleted `task.md` items).
   - Compute exact `signalPurityPct` and `sludgeTaxUsdPerTurn` using the model input rate from `config/default_flightcheck.json`.

### Verification Step
Run a verification script via `run_command` using synthetic `StepEvent` arrays to assert:
1. Duplicate `view_file` reads on the same path move the older read from `ACTIVE_SET` to `STALE_DUP`.
2. A failed `run_command` (`exitCode: 1`) followed by a passing `run_command` (`exitCode: 0`) transitions the failed step to `DEAD_ERROR`.
3. Foreign KI paths trigger `MEMORY_BLEED` and populate `foreignBleedKiIds`.
4. `classifyHorizonWindow` executes in under 10ms on a 200-step event list.
Update `task.md` once verification passes.
~~~