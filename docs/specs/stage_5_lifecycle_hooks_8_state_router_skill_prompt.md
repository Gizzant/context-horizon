# Stage 5: Lifecycle Hooks, 8-State `PreInvocation` Router & `/precheck` Skill
**Recommended Model & Effort:** `/model gemini-3.1-pro` (or `gemini-4-argon`) | `/effort high` | **Mode:** `auto`

Copy and run the prompt below in Google Antigravity after Stage 4 passes verification:

~~~text
Read @SPEC_AGY_HORIZON_FLIGHTCHECK.md (Section 5) and @implementation_plan.md (Phase 5). Implement the three lifecycle hooks (`SessionStart`, `PostInvocation`, `PreInvocation`) and the on-demand `/precheck` skill. Keep every file under 350 lines.

### Deliverables to Create in Order

1. `src/hooks/session_start.mjs`
   - Reads the `SessionStart` JSON payload from `stdin`.
   - Initializes `~/.gemini/flightcheck/sessions/<conversationId>.sidecar.json` via `createDefaultSidecar`.
   - Audits Turn 0 MCP schema footprint against `~/.gemini/flightcheck/tool_usage.json` and records initial `activeModel` and `activeEffort`. Always exits `0` with `{}`.

2. `src/hooks/post_invocation.mjs`
   - Reads the `PostInvocation` JSON payload from `stdin`.
   - Increments `turnCount`, updates `tool_usage.json` with any MCP tools invoked during the turn, sets `lastTurnUsedSubagent = true` if `invoke_subagent` was called, and updates `consecutiveTrivialOnMax` and `consecutiveErrorStreak` in `sidecar.json`. Always exits `0` with `{}`.

3. `src/hooks/pre_invocation.mjs`
   - Reads the `PreInvocation` JSON payload from `stdin` and loads `sidecar.json` via `readSidecarSync` (<2ms).
   - **Control Flag Handling:**
     - If `hook_level === "off"` or prompt starts with `!` or `!force`: return `{}` immediately (`ALLOW_SILENT`).
     - If prompt contains `!lock`: set `sessionMeta.effortLocked = true` in `sidecar.json`, strip `!lock`, and return `{}`.
   - **Tier 1 Zero-Latency Gate (<15ms):**
     - Check `ALLOW_PLAN_OR_SUBAGENT` (`inPlanMode === true` or `lastTurnUsedSubagent === true`).
     - Check `HALT_HYGIENE_OR_SAFETY`:
       1. `amputationRisk === true` (>140k tokens with anchors/PIDs at risk) -> Halt and instruct user to update `task.md` and run `/clear`.
       2. `threeStrikeLoop === true` -> Halt 4th consecutive retry and suggest `/compact` or `invoke_subagent` isolation.
       3. `foreignBleedKiIds.length > 0` during `/plan` or architecture refactor -> Halt and list foreign KI IDs to eject in `/context`.
       4. `signalPurityPct < 45` when running on `high`/`max` effort -> Halt with Sludge Tax ($/turn) and instruct user to run `/compact` first.
       5. `uncheckpointedGitDrift === true` (>=4 dirty files across >=3 untested turns) -> Halt and recommend `git commit` or `pytest` checkpoint.
     - Check `HALT_EFFORT_OR_QUOTA`:
       1. `quotaFloorBreached === true` (<10% remaining 5h quota on a `pro`/`argon`/`max` turn) -> Halt to prevent 0% multi-day lockout; suggest switching to `gemini-3.8-flash`.
       2. Cold-cache (`totalInputTokens < 10000`) 1-file trivial edit (<15 tokens) while on `pro`/`argon` + `max` effort (or `consecutiveTrivialOnMax >= 3`) when `!effortLocked` -> Halt and suggest `/model gemini-3.8-flash` + `/effort low`.
     - Check `INJECT_CONTEXT_GUARD`:
       - If `dirtySnapshotPaths.length > 0`, `unseenCallers.length > 0`, `legacyPoisonPaths.length > 0`, or `streamCutoffRiskFiles.length > 0`, inject a concise system directive into the turn context without halting.
     - Check `STEER_SUBAGENT`:
       - If `totalInputTokens >= 25000`, `signalPurityPct >= 70`, active effort is `low` or `medium`, and the prompt requests concurrency debugging, deadlock diagnosis, or multi-module architecture analysis -> Do NOT switch session `/model` (preserving the warm KV cache); inject a directive instructing the main agent to spawn `invoke_subagent` with high reasoning depth.
     - Check `ALLOW_ACTIVE_SET` & Trust Decay:
       - If prompt has no `#check` tag and either (a) references a file/symbol already in `fileState.activeSetPaths` (Green tail) or (b) `turnCount > 10` (`hook_level === "guard"`), return `{}` in under 15ms.
   - **Tier 2 Semantic Linter & Effort Router (`#check` or Cold Turn 1-3 Vague Multi-File Prompt):**
     - If `GEMINI_API_KEY` is present, call `gemini-3.8-flash` (effort `low`) with a strict `AbortSignal.timeout(1500)` to score the prompt, select optimal `/model` + `/effort`, and generate a scoped rewrite; if offline or timed out, use a deterministic local template rewriter so the hook never hangs.
     - Return `{"terminationBehavior": "terminate", "userMessage": "..."}` formatted with the standardized 4-Line Scorecard UX from Section 5.4.

4. `skills/precheck/SKILL.md`
   - Create an Antigravity Skill with YAML frontmatter (`name: precheck`, `description: Analyze a prompt for best practices, context hygiene, and optimal Antigravity model/effort configuration before execution`).
   - Instruct the agent how to read `sidecar.json`, evaluate any draft prompt against the 8-state rubric, and output the 4-Line Scorecard, `/model` and `/effort` slash commands, and a copy-pasteable prompt rewrite.

### Verification Step
Test `src/hooks/pre_invocation.mjs` via `run_command` by piping mock `stdin` JSON payloads for `ALLOW_SILENT`, `STEER_SUBAGENT`, `HALT_HYGIENE_OR_SAFETY`, and `#check` (`HALT_REWRITE_SCORECARD`). Verify valid JSON stdout and <15ms Tier 1 execution. Update `task.md` once verified.
~~~