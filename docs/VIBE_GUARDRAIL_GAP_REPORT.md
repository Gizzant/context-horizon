# Highbeam (`ctxtop`) — 20-Point Vibe-Coding Guardrail Gap Analysis & Implementation Triage

**Audit Date**: 2026-11-15  
**Repository / Branch**: `ctxtop` (`round2-c1-fixes`)  
**Product Framing**: **Quota Shield · Cache Gravity · Code Health** (*Tokens/$ Saved · Sludge Tax Prevented · Context-Rot Blocked · Build Integrity*)  
**Audit Posture**: Read-only codebase inspection (zero production source files modified).  
**SKU Boundary Compliance**: Strict `ctxtop` vs. `ctxvault` isolation maintained — `packages/airlock/`, `.github/workflows/airlock-schema-canary.yml`, and `docs/HIGHBEAM_AIRLOCK_*.md` were strictly excluded from inspection and analysis.

---

## 1. Audit Metadata, Disk Baseline & Cross-Cutting Architectural Findings

### 1.1 Inspected Scope
- **Google Antigravity Target**: `src/hooks/`, `src/core/`, `src/adapters/antigravity/`, `packages/antigravity/`, `.agents/plugins/agy-horizon-flightcheck/`, `src/cli/init.mjs`
- **Claude Code Target**: `hooks/register.js`, `hooks/handlers/`, `hooks/hooks.json`, `src/core-isomorphic/`, `src/adapters/claude-code/`, `packages/claude-code/`, `bin/ctxtop.mjs`, `src/diagnostics/`
- **Shared Daemon & UI Surfaces**: `sidecars/horizon-daemon/server.mjs`, `src/webview/horizon_panel.html`, `src/config/modelCatalog.json`, `test/top10_token_wasters_ui.test.mjs`, `scripts/sync_mirrors.mjs`

### 1.2 Uncommitted Working-Tree Baseline (`git status --short` on `round2-c1-fixes`)
Audit was performed against the live working tree on branch `round2-c1-fixes`:
- **Modified (`M`)**: `bin/ctxtop.mjs`, `hooks/hooks.json`, `hooks/handlers/pre-model-switch.mjs`, `hooks/handlers/stop-gate.mjs`, `scripts/sync_mirrors.mjs`, `src/core-isomorphic/coach/cacheGravityRouter.mjs`, `src/core-isomorphic/config/catalogLoader.mjs`, `src/core-isomorphic/config/horizonConfig.mjs`, `src/diagnostics/doctorEngine.mjs`, `CHECKSUMS.sha256`, `README.md`, `.gitignore`, `docs-site/*`, and 5 test suites (`test/claude-code/batch1_security_mod_hooks.test.mjs`, `test/claude-code/phase6_comprehensive_detectors_and_modes.test.mjs`, `test/claude-code/round2_c1_fixes.test.mjs`, `test/e2e_tier5_adversarial.test.mjs`, `test/v4_rc_remediation_and_mcp.test.mjs`).
- **Deleted (`D`)**: `docs/Highbeam_ctxtop_v4_Product_Overview.docx`.
- **Untracked (`??` in `ctxtop` scope)**: `hooks/handlers/post-model-switch.mjs`, `src/utils/modelSwitchTelemetry.mjs`, `src/utils/sessionCalibration.mjs`, `experiments/`, `docs/marketing/`.
- **Clean vs. `HEAD`**: `src/webview/horizon_panel.html`, `src/core/constants.mjs`, `test/top10_token_wasters_ui.test.mjs`, `hooks/register.js`, `src/hooks/`, and `src/core-isomorphic/guards/`.

### 1.3 Headline Scoreboard

| Classification | Count | Guardrail IDs | Summary |
| :--- | :---: | :--- | :--- |
| **`COVERED`** | **0 / 20** | — | 0% full dual-host + active-hook parity (though sub-engines such as Claude `PreModelSwitch` `DET-08`, Haiku `100k` `DET-12`, and `git reset --hard` `DET-01` are mature on single surfaces). |
| **`PARTIAL`** | **16 / 20** | `#1, #2, #3, #4, #5, #7, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18` | Detected passively in UI/daemon telemetry, implemented on only one host (Antigravity vs. Claude Code), or disconnected from live `PreToolUse`/`PostToolUse` hook matchers. |
| **`MISSING`** | **4 / 20** | `#6, #8, #19, #20` | No active detector or hook implementation (`SLOPSQUAT_DEP_GATE`, `DUPLICATE_CLONE_DETECTOR`, `OVERENGINEERING_DIFF_GATE`, `PROSE_TO_HOOK_COMPILER`). |

### 1.4 Cross-Cutting Structural Wiring Defects Discovered on Disk
Four architectural wiring defects currently suppress guardrails that are already partially written in `src/core-isomorphic/` and `src/hooks/`:

1. **Claude Code Hook Manifest Drift (`hooks/hooks.json:7-28` vs. `bin/ctxtop.mjs:100-250`)**:
   - `hooks/handlers/user-prompt-submit.mjs:1-143` is implemented (calling `engine.evaluateUserPromptSubmit`), yet `UserPromptSubmit` is **omitted** from both `hooks/hooks.json` and `bin/ctxtop.mjs` (`buildCanonicalAhHooks`), leaving prompt-hygiene and anchor hooks dead in CLI installs.
   - `hooks/hooks.json` omits `Grep|Glob` from `PreToolUse` (`L9`) and `PostToolUse` (`L20`), and omits `Edit|MultiEdit|Write` from `PostToolUse` (`L20`).
   - `ConfigChange`, `InstructionsLoaded`, `SessionEnd`, `FileChanged`, `SubagentStart`, `SubagentStop`, and `TeammateIdle` have zero command-hook bindings in `hooks/hooks.json` or `bin/ctxtop.mjs`.
2. **Antigravity Dual `PreToolUse` Entrypoint Split (`src/cli/init.mjs:93-115` & `.agents/plugins/agy-horizon-flightcheck/hooks.json:31-54,86-109`)**:
   - Installed Antigravity plugins invoke `src/hooks/pre_invocation.mjs --event=PreToolUse` (`handlePreToolUse`, `L142-471`), completely bypassing `hooks/pre_tool_use.mjs:1-97` -> `runStrictPreToolUse` (`src/hooks/portfolio_runtime.mjs:370-820`), where `DET-04` (3-strike loop), `DET-05` (pre-write assertion stripping, >50% shrinkage, FNV-1a flip-flop), `DET-06` (unmodified re-read & blind new-module), and `DET-16` (80% quota fan-out throttle) reside.
   - Furthermore, `.agents/plugins/agy-horizon-flightcheck/hooks.json` omits `search_web|read_url_content` across all matchers and omits `grep_search|find_by_name|list_dir` in its `horizon-flightcheck-lifecycle` `PreToolUse` block (`L88`) and `read_file|view_file|grep_search|find_by_name|list_dir` in `PostToolUse` (`L100`).
3. **Optimistic Pre-Execution Test Reset Bug (`src/core-isomorphic/guards/circuitBreakers.mjs:845-851` & `hooks/register.js:166-171,262-266`)**:
   - `this.codeEditedSinceLastTest = false` runs inside `PreToolUse` *before* `node --test`/`npm test`/`pytest` executes, instead of inside `PostToolUse` strictly upon exit code `0`, and its command regex omits `tsc`. Failing or aborted test runs silently clear unverified-edit debt.
4. **Mirror Sync & Isomorphic Purity Invariant (`scripts/sync_mirrors.mjs:1-150`, `hooks/register.js:1-600`)**:
   - All shared logic placed in `src/core-isomorphic/**` must obey Claude Mod Laws (pure relative ESM, zero `node:*` built-in imports, zero `process.getBuiltinModule`, fail-closed). Node FS and child-process I/O must live in `hooks/handlers/*.mjs`, `src/hooks/*.mjs`, `src/diagnostics/*.mjs`, or `bin/ctxtop.mjs`.
   - Every shared source/hook change must propagate across `.agents/plugins/agy-horizon-flightcheck`, `~/.gemini/config/plugins/agy-horizon*`, and `evaluation_bundles/tier_2_full` via:
     `cmd /c "node scripts/sync_mirrors.mjs && node scripts/generate_checksums.mjs && node bin/ctxtop.mjs verify --json"`

---

## 2. 20-Point Gap Classification Matrix

| Rank & Score | Guardrail ID | Status | Current Code Location (Exact File & Lines) | Specific Gap (Antigravity vs. Claude Code & Passive vs. Active) | Triage Bucket |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **#1** (92) | `MID_SESSION_CACHE_BUST` | `PARTIAL` | **Claude**: `hooks/handlers/pre-model-switch.mjs:242-955`, `src/core-isomorphic/coach/cacheGravityRouter.mjs:295-680,861-1412`, `hooks/hooks.json:29-48`, `src/diagnostics/claudeHookCapabilities.mjs:24-35`.<br>**Antigravity**: `src/core/quota.mjs:46-120` (`TurnBoundaryModelSwitchBuffer`), `src/hooks/pre_invocation.mjs:148-160,541,759-768`, `src/hooks/post_invocation.mjs:182-194,247-259`, `src/webview/horizon_panel.html:11290-11375`. | **Claude**: `PreModelSwitch` (`DET-08`) guards `/model`, but `ConfigChange` is unhooked—mid-session `/effort` changes (cache-busting on non-unified Claude models), speed mode, and `/plugin` toggles at `>25k` warm prefix bypass gating; `PostCompact` lacks held `pending_downshift` actuation (`Opus -> Sonnet`).<br>**Antigravity**: `handlePreInvocation` (`L541`) reads `modelName` passively without comparing against active session model at warm `>25k` prefixes to block/steer to `invoke_subagent`. | **Bucket A** |
| **#2** (91) | `GREP_GLOB_FIREWALL` | `PARTIAL` | **Claude**: `src/core-isomorphic/guards/det04_12_thrash_rot.mjs:259-288` (`DET-06`), `L297-366` (`DET-07`), `src/core-isomorphic/guards/losslessPostSanitizer.mjs:46,218-261` (`>4k` tok offload), `hooks/handlers/pre-tool-use.mjs:43-51`, `hooks/handlers/post-tool-use.mjs:94-102`.<br>**Antigravity**: `src/hooks/portfolio_runtime.mjs:535-557` (`DET-06B`), `src/core/tool_surgeon.mjs:14-20,127-260`. | `Grep\|Glob` missing from `hooks/hooks.json:9,20` & `LEAN_*_MATCHER` (`bin/ctxtop.mjs:111-114`); `grep_search\|find_by_name` missing from `.agents/plugins/agy-horizon-flightcheck/hooks.json:88,100`. Zero `<4`-char/generic-term query blocking or `updatedInput` injection (`--max-count=5 --max-filesize=200K` + artifact excludes); zero `PostToolUse` `>15`-file -> top-8 (`git status`/`mtime` ranked) inline collapse with `.agents/tmp/last_grep.txt` overflow. | **Bucket B** |
| **#3** (90) | `TEST_INTEGRITY_LOCK` | `PARTIAL` | **Claude**: `src/core-isomorphic/guards/det04_12_thrash_rot.mjs:201-226` (`DET-05`).<br>**Antigravity / Core**: `src/core/shared/detectors.mjs:196-202,235`, `src/core/detectors_det01_to_16.mjs:505-513,840-854,1173-1185`, `src/core/coach/circuit_breakers.mjs:44-76`, `src/core/coach/contradiction_auditor.mjs:204-227` (`auditTestSuiteImmutability` daemon-only). | Zero `SessionStart` SHA-256 + assertion-count snapshot (`.agents/telemetry/<sessionId>.test_hashes.json`); zero `PreToolUse` block on EvilGenie `.git` object mining (`git fsck`, `git cat-file`, `git reflog`) or test-file `rm`; Claude `DET-05` (`L216`) requires `deletedAssertions.length >= 2` (misses `-1` deletion), misses `.skip`/`xit`/`test.todo`, and misses `toEqual -> toBeTruthy`; Antigravity `pre_invocation.mjs` bypasses `DET-05` completely. | **Bucket A** *(core lock)* / **Bucket B** *(`#3b` hardcoded oracle)* |
| **#4** (89) | `BLAST_RADIUS_BREAKER` | `PARTIAL` | **Claude**: `src/core-isomorphic/guards/circuitBreakers.mjs:176-179,569-588,770-778,845-851`, `hooks/handlers/post-tool-use.mjs:120-125`, `hooks/handlers/stop-gate.mjs:122-160` (`DET-14`).<br>**Antigravity**: `src/hooks/pre_invocation.mjs:669-677` (`GIT_DRIFT`), `src/hooks/post_invocation.mjs:314-318`. | Enforced only at `Stop` (`DET-14`), Turn-1 blind edit, or 3-turn `PreInvocation` drift—no mid-turn `PreToolUse` ceiling tracking `unverified_touched_files > 5` or `unverified_changed_lines > 250`. Suffers from the optimistic `PreToolUse` reset bug (`circuitBreakers.mjs:845-851`) and lacks `tsc` reset matching. | **Bucket B** *(ceiling)* / **Bucket A0** *(exit-0 reset fix)* |
| **#5** (88) | `SUBAGENT_TEAM_GOVERNOR` | `PARTIAL` | **Claude**: `src/core-isomorphic/guards/det13_20_mcp_scope.mjs:250-290` (`DET-16`), `src/core-isomorphic/guards/circuitBreakers.mjs:678-702`.<br>**Antigravity**: `src/hooks/pre_invocation.mjs:393-439` (`SwarmIdleTtlTracker`), `src/hooks/portfolio_runtime.mjs:696-727`, `src/core/coach/subagent_phantom_auditor.mjs:114-255` (`DET-28`). | Neither host blocks `>1,500`-token spawn prompts or steers `haiku`/`flash` + `omitClaudeMd: true` on search workers; Antigravity `handlePreToolUse` (`L418`) does not validate `define_subagent` `tools:` names against the host registry; Claude lacks `SubagentStart`, `SubagentStop`, `TeammateIdle`, and `Monitor` (filter-pipe/timeout) hooks in `hooks/hooks.json`. | **Bucket B** *(heuristics)* / **Bucket A0** *(`define_subagent` & `Monitor` validation)* |
| **#6** (87) | `SLOPSQUAT_DEP_GATE` | `MISSING` | `None` (`src/core-isomorphic/guards/det01_03_shell_secret.mjs:1004,1012` skips `npm install` via `Bash\|PowerShell`). | Zero parsing of `npm i` / `pnpm add` / `yarn add` / `pip install` / `uv add` / `cargo add`, zero lockfile diffing, zero conflation blocklist (`react-codeshift`, `unused-imports`), and zero npm/PyPI metadata validation (`404`, `<30d`, `<500/wk` downloads, cross-ecosystem collisions). | **Bucket B** |
| **#7** (86) | `PRICING_CLIFF_BREAKER` | `PARTIAL` | **Claude**: `src/core-isomorphic/economics/cliffBreaker.mjs:21-170` (`DET-12` Haiku 5.5 `90k/98k/100k`), `src/core-isomorphic/guards/circuitBreakers.mjs:914-931`, `src/config/modelCatalog.json:258,272-278`.<br>**Antigravity**: `src/core/classifier.mjs:1042,1680` (passive flags only). | `cliffBreaker.mjs:33-35,54-60` explicitly exempts non-Haiku models—Gemini 3.1 Pro / 2.5 Pro `200K` cliff (`180K` 90% threshold; `2x` input/cached read, `1.5x` output) is missing from `modelCatalog.json`, `constants.mjs`, and Antigravity hooks; neither host tightens `Read`/`read_file` limit from `400` -> `150` lines at 90% cliff or audits `.claude/agents/*.md` for `autoCompactWindow: 180000`. | **Bucket A** |
| **#8** (85) | `DUPLICATE_CLONE_DETECTOR` | `MISSING` | `None` (`src/core/pruner.mjs` folds signatures only on 3rd+ Read; `src/engine-node/sensors/blindspots.mjs:180` tracks import edges only). | No `.agents/telemetry/repo_symbols.json` (exports + normalized 5-line block shingle hashes) built on `SessionStart`/`FileChanged`; no `PostToolUse` clone check on edits injecting `<25`-token `[CTX_HINT: DUPLICATE_CODE -> reuse <file>:<line>]`. | **Bucket B** |
| **#9** (84) | `WEB_BOILERPLATE_BUDGETER` | `PARTIAL` | **Claude**: `src/core-isomorphic/guards/losslessPostSanitizer.mjs:27-30,170-173` (`WebFetch` basic nav/footer/script/style regex + `>4k` tok offload), `src/core-isomorphic/guards/det13_20_mcp_scope.mjs:489-535` (`DET-19`), `src/core-isomorphic/diagnostics/prompt_hygiene_governor.mjs:557-615`.<br>**Antigravity**: `None`. | Antigravity `search_web` and `read_url_content` are unhooked in `.agents/plugins/agy-horizon-flightcheck/hooks.json:33,45`; neither host deduplicates URLs/queries via 24h `.agents/tmp/web_cache/` or enforces a 5-search/turn cap (`$10-$14/1k`); `losslessPostSanitizer.mjs` misses `mcp__.*(search\|fetch).*`, leaves HTML-to-Markdown incomplete, and lacks `>150`-line `.index.md` indexing. | **Bucket B** |
| **#10** (83) | `IDLE_DRAIN_BLOCKER` | `PARTIAL` | **Antigravity**: `src/core/coach/subagent_phantom_auditor.mjs:114-255` (`DET-28` >5m orphan Chrome/LSP processes), `src/core/host_watchdog.mjs:1-140`.<br>**Claude**: `hooks/register.js:49-66,566-578` (`clearWatchdogClock` internal Mod clock only). | Zero audit/sync of `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`, `crossSessionInbound: "hold"`, and `idleCompaction: false` in `.claude/settings.local.json`; `SessionEnd` is unhooked in `hooks/hooks.json` and `bin/ctxtop.mjs`; neither `stop-gate.mjs` nor `post_invocation.mjs` warns about active background `/tasks` at exit. | **Bucket A** |
| **#11** (82) | `THINKING_TIMEOUT_GOV` | `PARTIAL` | `src/core-isomorphic/catalog/detectorCatalog.mjs:303-312` (`DET-30`), `src/core/sprint_metrics.mjs:215-285`, `src/core-isomorphic/economics/driftLatency.mjs:1-120`, `src/core/constants.mjs:1420-1500` (`evaluateCarbonVerbosityGuardrail`), `src/core-isomorphic/guards/circuitBreakers.mjs:591-617`. | Missing Google Nov 13, 2026 `>32K` completion-timeout billing guard (retrievable thinking+output tokens billed even on client/server timeouts); missing `SessionStart` `MAX_THINKING_TOKENS` audit; `DET-30` (`thinking/visible` ratio) is passive telemetry in `sprint_metrics.mjs` rather than an active `/effort` step-down guard across non-Carbon models. | **Bucket A** |
| **#12** (81) | `ERROR_MASKING_LINTER` | `PARTIAL` | **Core / Daemon**: `src/core/coach/circuit_breakers.mjs:144-209,474-503` (`inspectErrorMaskingDiff` `DET-23`), `src/core/shared/detectors.mjs:188-193`.<br>**Claude**: `src/core-isomorphic/guards/det04_12_thrash_rot.mjs:212-214,228-237`. | Claude `DET-05` (`L228`) only blocks empty `catch {}` when `deletedAssertions.length > 0` (new silent catches in app code pass), and `Edit\|MultiEdit\|Write` are absent from `hooks/hooks.json:20` `PostToolUse`; Python `except: pass` / `except Exception: pass` is unmatched; Antigravity `pre_invocation.mjs`/`post_invocation.mjs` never runs `inspectErrorMaskingDiff`. | **Bucket A** |
| **#13** (80) | `VAGUE_PROMPT_ANCHOR` | `PARTIAL` | `src/core-isomorphic/diagnostics/prompt_hygiene_governor.mjs:146-350` (`evaluateScopeBrake`), `src/hooks/pre_invocation.mjs:856-940`, `hooks/handlers/user-prompt-submit.mjs:1-143`, `src/core-isomorphic/guards/circuitBreakers.mjs:1115-1175`. | `UserPromptSubmit` is unhooked in `hooks/hooks.json` and `bin/ctxtop.mjs` (dead in Claude CLI); `evaluateScopeBrake` lists sidecar `activeSetPaths` on Antigravity but neither host attaches `git diff --stat` + last failing `file:line` when prompt is `<6` words (`"fix it"`, `"still broken"`). | **Bucket B** *(`<6`-word anchor heuristic)* / **Bucket A0** *(`UserPromptSubmit` wiring)* |
| **#14** (79) | `MULTIMODAL_IPYNB_SANITIZER` | `PARTIAL` | `src/core-isomorphic/guards/circuitBreakers.mjs:619-676` (`DET-20`), `src/core/shared/detectors.mjs:994-1105`, `hooks/handlers/pre-tool-use.mjs:125`. | Counts historical `base64` image blocks in `messages`, but has zero `PreToolUse` interception on `Read`/`read_file`/`view_file` for `.ipynb` notebooks (`>256KB` fail cap / base64 chart blob stripping) and zero enforcement of `pages` / line ranges on `.pdf` files `>10` pages. | **Bucket A** |
| **#15** (78) | `MEMORY_RULE_VALIDATOR` | `PARTIAL` | **Claude**: `hooks/handlers/compact-lifecycle.mjs:33-95,162` (`auditWorkspaceClaudeMd`).<br>**Antigravity**: `src/core/coach/turn_zero_gate.mjs:255-280` (`DET-27`), `src/core/layer5_hygiene.mjs:881-964`, `src/core/shared/plugin_validator.mjs:20-139`. | Claude `auditWorkspaceClaudeMd` checks `CLAUDE.md`/`AGENTS.md` (`>200` lines / `>4k` tok) but misses `~/.claude/projects/<proj>/memory/MEMORY.md` (`>200` lines / `25KB`) and `InstructionsLoaded`; Antigravity `session_start.mjs` & `doctorEngine.mjs` lack YAML frontmatter checks for silent camelCase key drops (`alwaysOn`/`modelDecision` -> `always_on`/`model_decision`), `>20k`-tok rule budget, and nested rules missing `.agents/rules.json`. | **Bucket A** |
| **#16** (77) | `MCP_CLI_ROUTER` | `PARTIAL` | **Antigravity**: `src/core/mcp_auditor.mjs:102-145`, `src/core/shared/detectors.mjs:713-804` (`DET-13`), `src/hooks/session_start.mjs:89-126`.<br>**Claude**: `src/core-isomorphic/guards/det13_20_mcp_scope.mjs:26-113`, `src/core-isomorphic/guards/circuitBreakers.mjs:941-979`. | Audits `>15k` MCP startup schema tokens (`>25` tools), but misses `>10` MCP server count / `skills add --all` cap on Antigravity and has **zero** `PreToolUse` routing of `mcp__(github\|aws\|gcloud\|sentry)__*` calls to native zero-schema CLIs (`gh`, `aws`, `gcloud`, `sentry-cli`). | **Bucket B** |
| **#17** (76) | `LSP_SYMBOL_ROUTER` | `PARTIAL` | `src/core-isomorphic/guards/det04_12_thrash_rot.mjs:259-288` (`DET-06`), `src/hooks/portfolio_runtime.mjs:540-557` (`DET-06B`). | Tracks sequential `Read`/`Grep` count (`>6`) to advise subagent delegation, but does not detect `>=3` consecutive symbol searches on `.ts`/`.py`/`.go`/`.rs` or route to native `LSP` jump-to-definition. | **Bucket B** |
| **#18** (75) | `WORKTREE_DESTRUCTIVE_GUARD` | `PARTIAL` | `src/core-isomorphic/guards/det01_03_shell_secret.mjs:779-939` (`DET-01`), `src/core-isomorphic/guards/det13_20_mcp_scope.mjs:601-603` (`DET-20`), `src/core/telemetry/scope_lock_registry.mjs:500-520`, `src/engine-node/sensors/git_merge_tree.mjs` (`DET-31`). | `DET-01` blocks `git reset --hard` and `git clean -f`, but **allows un-stashed `git checkout -- <path>`, `git checkout .`, and `git restore <path>` (without `--staged`)**; `PreToolUse` on `Agent`/`Task`/`invoke_subagent`/`swarm` does not enforce `isolation: "worktree"` (Claude) or `Workspace: "branch"\|"share"` (Antigravity) on concurrent write workers. | **Bucket A** |
| **#19** (73) | `OVERENGINEERING_DIFF_GATE` | `MISSING` | `None` (`DET-05` in `src/core-isomorphic/guards/det04_12_thrash_rot.mjs:151-199` only catches `>50%` shrinkage and full-file regurgitation). | No `PostToolUse` diff analyzer flagging `50-60%` speculative abstraction bloat (e.g., `>200` lines added or multi-class wrappers on a narrow 1-line bugfix prompt). | **Bucket B** |
| **#20** (70) | `PROSE_TO_HOOK_COMPILER` | `MISSING` | `None` (`src/core/coach/contradiction_auditor.mjs:20-80` only checks rule-vs-rule polarity contradictions during `/evolve`). | Neither platform compiles `NEVER edit <path>` / `DO NOT modify <dir>` prose rules in `CLAUDE.md`/`AGENTS.md` into deterministic `PreToolUse` path/shell deny matchers. | **Bucket B** |

---

## 3. Bucket A — List 1: Implement Immediately (Zero-Risk, Deterministic, `<15ms`, No Tuning Required)

All Bucket A items rely strictly on exact mathematical formulas, committed file hashes, or platform schema validation, run purely locally in **`<15ms`**, and carry near-zero false-positive risk.

> **Shared Implementation Rule (Mod Law 4 & Mirror Parity)**:
> - Shared guard evaluators live in `src/core-isomorphic/**` with **zero `node:*` imports** and zero dynamic `process.getBuiltinModule` (`hooks/register.js`).
> - Filesystem / subprocess I/O lives in `hooks/handlers/*.mjs` (Claude), `src/hooks/*.mjs` (Antigravity), `src/diagnostics/*.mjs`, and `bin/ctxtop.mjs`.
> - Every edit must end with `cmd /c "node scripts/sync_mirrors.mjs && node scripts/generate_checksums.mjs && node bin/ctxtop.mjs verify --json"`.

### Item A0: Cross-Cutting Deterministic Plumbing Fixes (Prerequisite for List 1)
- **Target `ctxtop` Files to Edit**:
  - `hooks/hooks.json`, `bin/ctxtop.mjs` (`buildCanonicalAhHooks`), `.agents/plugins/agy-horizon-flightcheck/hooks.json`
  - `hooks/handlers/post-tool-use.mjs`, `src/hooks/pre_invocation.mjs`, `src/hooks/portfolio_runtime.mjs`
  - `src/core-isomorphic/guards/circuitBreakers.mjs` (`L845-851`), `hooks/register.js` (`L166-171,262-266`)
- **Hook Events & Payload Contracts**:
  - **Claude Code**: Add `"UserPromptSubmit"`, `"ConfigChange"`, `"InstructionsLoaded"`, and `"SessionEnd"` entries to `hooks/hooks.json` and `bin/ctxtop.mjs`; add `Grep|Glob` to `PreToolUse` and `Grep|Glob|Edit|MultiEdit|Write` to `PostToolUse`.
  - **Antigravity**: Add `grep_search|find_by_name|list_dir|read_file|view_file|search_web|read_url_content|define_subagent` across both top-level and `horizon-flightcheck-lifecycle` blocks in `.agents/plugins/agy-horizon-flightcheck/hooks.json`.
- **Exact Deterministic Logic**:
  1. Remove `this.codeEditedSinceLastTest = false` from `PreToolUse` (`circuitBreakers.mjs:845-851`, `hooks/register.js:166-171,262-266`) and move reset exclusively to `PostToolUse` when the executed test/typecheck command (`node --test|npm test|pnpm test|yarn test|bun test|vitest|jest|pytest|cargo test|go test|tsc`) exits `0`. Capture failing `file:line` from stderr into `.state.json` (proposed `lastFailingLocation` field).
  2. Delegate Antigravity `handlePreToolUse` (`src/hooks/pre_invocation.mjs:142-471`) through shared `runStrictPreToolUse` (`src/hooks/portfolio_runtime.mjs:370-820`) so `DET-04`, `DET-05`, `DET-06`, and `DET-16` execute on plugin-installed sessions.
  3. Validate `define_subagent` `tools:` entries against the canonical Antigravity tool registry in `PreToolUse`, and reject `Monitor` invocations missing a bounded `timeout_ms` or downstream filter pipeline.

### Item A1 (`#1` — `MID_SESSION_CACHE_BUST`)
- **Target `ctxtop` Files**:
  - *Edit*: `src/hooks/pre_invocation.mjs` (`handlePreInvocation`), `hooks/handlers/compact-lifecycle.mjs` (`PostCompact`), `hooks/hooks.json`, `bin/ctxtop.mjs`, `src/core-isomorphic/coach/cacheGravityRouter.mjs`
  - *Create (proposed)*: `hooks/handlers/config-change.mjs`
- **Hook Event & Payload Contracts**:
  - **Claude `ConfigChange`**: Reads stdin JSON `{ source, setting_key, old_value, new_value, session_id }`; returns `{ decision: "block", reason }` when `AUTO_PILOT`/`guard` denies, or `{ systemMessage }` advisory in `COACH`.
  - **Claude `PostCompact`**: Reads `{ session_id, compact_trigger }`; reads pending downshift state and emits `{ hookSpecificOutput: { hookEventName: "PostCompact", additionalContext } }` (plus Mod/host `set_model` trigger where supported).
  - **Antigravity `PreInvocation`**: Reads `inputData.modelName` against `sessionMeta.activeModel` and cache telemetry; returns `{ terminationBehavior: "terminate", decision: "block", userMessage }`.
- **Exact Deterministic Logic & Thresholds (`<5ms`)**:
  - When `cacheWarm` (`idleSeconds < 300`) and `cachedTokens > 25_000`:
    - **Antigravity `PreInvocation`**: If `normalizeModelKey(inputData.modelName) !== normalizeModelKey(sessionMeta.activeModel)`, run `computeBreakEvenCachedTokens` (using `0.10x` warm read vs. `1.25x` 5m / `2.0x` 1h write penalty); block/steer in `AUTO_PILOT`/`guard` (advisory in `COACH`) and prescribe `invoke_subagent`.
    - **Claude `ConfigChange`**: Apply the same break-even check on `/effort` changes (for non-unified-cache Claude models), `fastMode` toggles, or `/plugin` / `mcpServers` / `enabledPlugins` mutations (`tools_changed`). If switching down from `Opus 4.6 -> Sonnet 4.6` mid-thread, queue a pending downshift in `.state.json` and actuate on the next `PostCompact` (`1–3` request payback on a freshly rebuilt prefix).

### Item A2 (`#3` — `TEST_INTEGRITY_LOCK`, Deterministic Core)
- **Target `ctxtop` Files**:
  - *Edit*: `hooks/handlers/compact-lifecycle.mjs` (`SessionStart`), `src/hooks/session_start.mjs` (`SessionStart`), `src/core-isomorphic/guards/det01_03_shell_secret.mjs` (`evaluateDet01GitAndShellSafety`), `src/core-isomorphic/guards/det04_12_thrash_rot.mjs` (`evaluateDet05DiffThrashing`), `src/hooks/pre_invocation.mjs`
- **Hook Event & Payload Contracts**:
  - **`SessionStart`** (Claude + Antigravity): Scans workspace `**/*.{test,spec}.{js,mjs,cjs,ts,tsx,py,go,rs}` (capped at 500 files, `<12ms`) and writes `{ sha256, assertionCount, skipCount }` to `.agents/telemetry/<sessionId>.test_hashes.json`.
  - **`PreToolUse`** (`Edit|MultiEdit|Write|Bash|PowerShell` on Claude; `replace_file_content|multi_replace_file_content|write_to_file|run_command` on Antigravity): Returns `permissionDecision: "deny"` (Claude) / `decision: "deny", blocked: true` (Antigravity).
- **Exact Deterministic Logic & Thresholds (`<12ms`)**:
  - Unless `lastUserInput` contains explicit user intent to modify tests (`/\b(edit|update|delete|remove|fix|skip)\s+(?:the\s+)?tests?\b/i`), hard-deny:
    1. Deleting or truncating any tracked test file (`rm`/`del`/`Remove-Item` or zeroing existing test content).
    2. Lowering `evaluateDet05DiffThrashing` threshold (`det04_12_thrash_rot.mjs:216`) from `>= 2` to **`>= 1` net deleted assertion** (`afterAssertions < beforeAssertions`).
    3. Any net increase in skipped/disabled tests (`.skip(`, `xit(`, `xdescribe(`, `test.todo(`, `@pytest.mark.skip`).
    4. Assertion weakening (`toEqual|toStrictEqual|deepStrictEqual` -> `toBeTruthy|toBeDefined`).
    5. EvilGenie `.git` object/history mining in shell commands (`git fsck`, `git cat-file`, `git reflog`, `git log --all -p` on benchmark refs).

### Item A3 (`#7` — `PRICING_CLIFF_BREAKER`)
- **Target `ctxtop` Files**:
  - *Edit*: `src/config/modelCatalog.json`, `src/core/constants.mjs`, `src/core-isomorphic/economics/cliffBreaker.mjs`, `hooks/handlers/pre-tool-use.mjs`, `src/hooks/pre_invocation.mjs`, `hooks/handlers/compact-lifecycle.mjs`
- **Hook Event & Payload Contracts**:
  - **`SessionStart`** (Claude): Audits `.claude/agents/*.md` for `autoCompactWindow` settings; warns via `{ systemMessage }` if missing or above safe cliff ceiling.
  - **`PreToolUse`** (`Read|read_file|view_file`): Claude returns `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { limit: 150 } } }` at 90% cliff (or `"deny"` when projected file size crosses cliff); Antigravity returns `{ decision: "deny", blocked: true, reason }` when `EndLine - StartLine > 150` or un-bounded.
  - **`PreInvocation`**: Emits `/compact` advisory at 90% cliff.
- **Exact Deterministic Logic & Thresholds (`<5ms`)**:
  - Add `gemini-3.1-pro` and `gemini-2.5-pro` (`prompt_cliff_tokens: 200_000`; `>=200k` 2x input/cached-read, 1.5x output) alongside existing `claude-haiku-5-5` (`100_000`, 5x jump).
  - Remove the non-Haiku exemption in `src/core-isomorphic/economics/cliffBreaker.mjs:33-35,54-60` and parameterize cliff lookup from model catalog (`90%` advisory/clamp = **`90,000` Haiku 5.5**, **`180,000` Gemini 3.1/2.5 Pro**; `98%` breaker; `100%` cliff):
    - Clamp `Read`/`read_file` max slice from `400` -> **`150` lines** at `>=90%` cliff.
    - Hard-deny un-indexed file reads where `currentPromptTokens + ceil(fileBytes / 4) >= cliffTokens`.
    - Flag `.claude/agents/*.md` missing `autoCompactWindow: 180000` (`90000` for Haiku agents).

### Item A4 (`#10` — `IDLE_DRAIN_BLOCKER`)
- **Target `ctxtop` Files**:
  - *Edit*: `bin/ctxtop.mjs`, `hooks/handlers/compact-lifecycle.mjs` (`SessionStart`), `hooks/handlers/stop-gate.mjs` (`Stop` + `SessionEnd`), `hooks/hooks.json`, `src/hooks/post_invocation.mjs`
- **Hook Event & Payload Contracts**:
  - **CLI (`ctxtop shield --enable` / installer)** + **Claude `SessionStart`**: Merges/audits `.claude/settings.local.json`.
  - **Claude `Stop` / `SessionEnd` & Antigravity `PostInvocation`**: Checks active background task registry and emits non-blocking `{ systemMessage }` listing live PIDs/task IDs on exit.
- **Exact Deterministic Logic & Thresholds (`<5ms`)**:
  - Write/verify `.claude/settings.local.json` values: `env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES = "0"`, `crossSessionInbound = "hold"`, and `idleCompaction = false`.
  - On `Stop` / `SessionEnd` / session teardown, warn if background `/tasks` or orphan daemon child jobs remain open.

### Item A5 (`#15` — `MEMORY_RULE_VALIDATOR`)
- **Target `ctxtop` Files**:
  - *Edit*: `hooks/handlers/compact-lifecycle.mjs` (`auditWorkspaceClaudeMd`), `hooks/hooks.json`, `bin/ctxtop.mjs`, `src/hooks/session_start.mjs`, `src/diagnostics/doctorEngine.mjs`, `src/core/layer5_hygiene.mjs`
- **Hook Event & Payload Contracts**:
  - **Claude `SessionStart` & `InstructionsLoaded`**: Audits workspace rules + user Auto-Memory directory, emitting `{ systemMessage }`.
  - **Antigravity `SessionStart` & `ctxtop doctor`**: Parses `.agents/rules/**/*.md` and `~/.gemini/GEMINI.md` frontmatter and sizes.
- **Exact Deterministic Logic & Thresholds (`<8ms`)**:
  - **Claude Code**: Inspect `CLAUDE.md`, `AGENTS.md`, AND `~/.claude/projects/<projectSlug>/memory/MEMORY.md` (+ topic `*.md` files); warn if `MEMORY.md` exceeds **`200` lines** or **`25,600` bytes** (silent truncation limit).
  - **Antigravity**: Parse YAML frontmatter across `.agents/rules/**/*.md` (skipping excluded SKU paths) to catch:
    1. CamelCase trigger keys (`alwaysOn`, `modelDecision`, `globPattern`) that Antigravity silently drops unless written lowercase (`always_on`, `model_decision`, `glob`).
    2. Cumulative always-on rule token budget **`> 20,000` tokens**.
    3. Nested `.agents/rules/<subdir>/*.md` files loaded without an indexable `.agents/rules.json`.

### Item A6 (`#11` — `THINKING_TIMEOUT_GOV`)
- **Target `ctxtop` Files**:
  - *Edit*: `src/core-isomorphic/economics/driftLatency.mjs`, `src/core-isomorphic/guards/circuitBreakers.mjs`, `hooks/handlers/compact-lifecycle.mjs` (`SessionStart`), `hooks/handlers/user-prompt-submit.mjs`, `src/hooks/pre_invocation.mjs`
- **Hook Event & Payload Contracts**:
  - **`SessionStart`** (Claude + Antigravity): Audits `env.MAX_THINKING_TOKENS` and active model output ceiling (`<3ms`).
  - **`UserPromptSubmit` / `PreInvocation`**: Enforces `/effort` / `MAX_THINKING_TOKENS` step-down when `DET-30` sustained ratio trips (`{ decision: "block" }` in `AUTO_PILOT`, advisory in `COACH`).
- **Exact Deterministic Logic & Thresholds (`<5ms`)**:
  - On Google Gemini targets (`gemini-4-carbon`, `gemini-4-argon`, `gemini-3.1-pro`, `gemini-2.5-pro`), if configured `maxOutputTokens + thinkingBudget > 32_768` with client timeout `< 120s`, emit timeout billing-risk warning (Google Nov 13, 2026 rule: retrievable output/thinking tokens billed on timeouts).
  - Promote `DET-30` (`thinkingTokens > 4_000` and `thinkingTokens / max(1, visibleOutputTokens) > 12` for **`>= 2` consecutive turns**) from passive `sprint_metrics.mjs` telemetry to an active step-down prompt suggesting `/effort medium` or `MAX_THINKING_TOKENS=16000`.

### Item A7 (`#12` — `ERROR_MASKING_LINTER`)
- **Target `ctxtop` Files**:
  - *Edit*: `src/core-isomorphic/guards/det04_12_thrash_rot.mjs` (`evaluateDet05DiffThrashing`), `hooks/hooks.json`, `bin/ctxtop.mjs`, `hooks/handlers/post-tool-use.mjs`, `src/hooks/post_invocation.mjs`
- **Hook Event & Payload Contracts**:
  - **Claude `PreToolUse` / `PostToolUse`** (`Edit|MultiEdit|Write`) & **Antigravity `PreToolUse` / `PostToolUse`** (`replace_file_content|multi_replace_file_content|write_to_file`): Blocks in `AUTO_PILOT` `PreToolUse` or injects `<25`-token `additionalContext` lint reminder in `COACH` `PostToolUse`.
- **Exact Deterministic Logic & Thresholds (`<2ms`)**:
  - Remove the `deletedAssertions.length > 0` precondition in `src/core-isomorphic/guards/det04_12_thrash_rot.mjs:228`.
  - Flag **any** newly added silent handler lacking logging, rethrow, or explicit justification comment (`// ignore|expected|noop|fallback`): JS/TS `catch (e) {}`, TypeScript suppression (`@ts-ignore`, `@ts-nocheck`, `eslint-disable`), and Python `except(?:\s+\w+)?:(?:\s|\n)*pass\b`.

### Item A8 (`#14` — `MULTIMODAL_IPYNB_SANITIZER`)
- **Target `ctxtop` Files**:
  - *Edit*: `hooks/handlers/pre-tool-use.mjs`, `src/hooks/pre_invocation.mjs`, `src/core-isomorphic/guards/det04_12_thrash_rot.mjs` (`evaluateDet07OutputBombGuard`)
- **Hook Event & Payload Contracts**:
  - **Claude `PreToolUse`** (`Read`): Rewrites `updatedInput.file_path` to sanitized `.ipynb` cache file or denies un-paged `>10`-page PDFs.
  - **Antigravity `PreToolUse`** (`read_file|view_file`): Denies oversized `.ipynb` pointing to `.agents/tmp/sanitized_<name>.ipynb`, or denies un-bounded `>10`-page PDFs.
- **Exact Deterministic Logic & Thresholds (`<12ms`)**:
  - **`*.ipynb`**: If `fileBytes > 262_144` (256KB) or cell outputs contain `"image/png"` / `"image/jpeg"` base64 blobs `> 16KB`, strip base64 image payloads while preserving code/markdown/text outputs into `.claude/cache/` or `.agents/tmp/sanitized_<name>.ipynb`.
  - **`*.pdf`**: Scan buffer for `/Type\s*\/Page\b` (excluding `/Pages`); if `pageCount > 10` and `tool_input.pages` (Claude) / bounded `StartLine`–`EndLine` (Antigravity) is omitted, hard-deny with page count and instruct a `<=10`-page slice.

### Item A9 (`#18` — `WORKTREE_DESTRUCTIVE_GUARD`)
- **Target `ctxtop` Files**:
  - *Edit*: `src/core-isomorphic/guards/det01_03_shell_secret.mjs` (`evaluateDet01GitAndShellSafety`), `src/core-isomorphic/guards/circuitBreakers.mjs`, `src/hooks/pre_invocation.mjs`
- **Hook Event & Payload Contracts**:
  - **Claude `PreToolUse`** (`Bash|PowerShell|Agent|Task`) & **Antigravity `PreToolUse`** (`run_command|invoke_subagent|swarm`): Returns `permissionDecision: "deny"` / `blocked: true`.
- **Exact Deterministic Logic & Thresholds (`<4ms`)**:
  1. In `det01_03_shell_secret.mjs` (`L779+`), block un-stashed working-tree discard commands: `git checkout -- <path>`, `git checkout .`, `git checkout -f`, and `git restore <path>` when neither `--staged` nor `-S` is present (`SUBTYPE: 'GIT_UNSTASHED_DISCARD'`; prompt `git stash push -u` first).
  2. When **`>= 1` write-capable worker** is active in `swarmRoster` / `scopeLockRegistry`, require **`isolation: "worktree"`** (Claude `Agent`/`Task`) or **`Workspace: "branch" | "share"`** (Antigravity `invoke_subagent`/`swarm`) on any new concurrent write-capable subagent (`deny` in `AUTO_PILOT`, `ask` in `COACH`).

---

## 4. Bucket B — List 2: Validate / Test First (Requires Simulation Harness or Threshold Tuning)

These 12 capabilities (11 guardrails + the `#3b` hardcoded-return oracle) involve heuristics, external network calls, or workflow limits that risk blocking legitimate scaffolding or inducing context blind spots if shipped directly in `deny` mode. Deploy first in **shadow telemetry (`.agents/telemetry/<sessionId>.hints.jsonl`, 0 extra prompt tokens, 0 hard blocks)** alongside deterministic `test/*.test.mjs` replay harnesses.

| ID | Primary Failure Mode / False-Positive Risk | Deterministic Validation Experiment / Simulation Test (`test/` + Shadow `.hints.jsonl`) | Promotion Metric (`shadow/warn -> deny`) |
| :--- | :--- | :--- | :--- |
| **`#2` `GREP_GLOB_FIREWALL`** | Short 2–3 char symbols (`id`, `db`, `fs`, `ws`, `ui`) and exhaustive rename audits legitimately match `>15` files; truncating `PostToolUse` output silently to top-8 causes incomplete refactors (missing call sites #9–30), and `--max-count` syntax differs between `rg`, GNU `grep`, and Antigravity `grep_search`. | Build **`test/grep_glob_firewall_sim.test.mjs`** replaying historical trajectories + searches over this repo (`ctxtop`); measure whether files edited in later turns appear in the top-8 `git status`/`mtime`-ranked matches, and exempt `replace_all` / multi-file refactor turns in `.hints.jsonl`. | **Recall@8 >= 95%** on downstream edited files AND **false-block rate < 1%** on valid symbol queries. |
| **`#4` `BLAST_RADIUS_BREAKER`** | Greenfield scaffolding, SQL/Prisma schema generation, or cross-module TypeScript interface renames routinely modify `6–12` files or `>250` lines before `tsc` or `npm test` can even compile; hard-blocking file #6 freezes half-completed refactors. | Build **`test/blast_radius_sim.test.mjs`** replaying multi-file commits from `git log` against synthetic runaway zero-test loops (testing `5/8/10`-file and `250/400`-line thresholds with exemptions for new test files and mechanical import updates); shadow-log trips in `.hints.jsonl`. | **Legitimate commit block rate < 3%** while intercepting **100%** of zero-test runaway loops `>6` files. |
| **`#5` `SUBAGENT_TEAM_GOVERNOR` (Heuristics)** | `self` implementation agents, `/relay` Cold Critic spec reviewers, and isolated worktree workers legitimately require `2k–4k` token briefs and frontier models (`Opus`/`Carbon`); `TeammateIdle` auto-stop can kill a coordinator-assigned verifier waiting for a peer commit when `TaskList` is transiently empty. | Build **`test/subagent_governor_sim.test.mjs`** + shadow-log spawn token sizes and worker tool grants in `.hints.jsonl` across read-only (`Read/Grep/Glob/view_file/grep_search/find_by_name`) vs. write-capable subagents. | **0% misclassified write-capable workers** under the read-only `haiku`/`flash` classifier + validated exemption list for deep review roles. |
| **`#6` `SLOPSQUAT_DEP_GATE`** | Live npm/PyPI HTTP requests add `200–1,500ms` latency, break offline/air-gapped/VPN builds, trigger false `404`s on private scopes (`@company/*`, `.npmrc` registries, `--index-url`) and monorepo workspace deps (`workspace:*`), and require explicit opt-in boundary compliance with Highbeam's offline-first telemetry invariant. | Two-phase **`test/slopsquat_dep_gate.test.mjs`**: Phase 1 validates 100% local `<5ms` lockfile-diff + known-conflation/Levenshtein-1 top-1,000 bloom filter (`react-codeshift`, `unused-imports`) + `.npmrc`/`pyproject.toml` private-registry allowlist; Phase 2 benchmarks mocked `1.5s` timeout fail-open (`ask` in `COACH`, never offline hard-deny) cached in `.agents/telemetry/pkg_meta_cache.json`. | **0% false-deny** on offline/private/workspace packages AND **`p99` latency < 400ms**. |
| **`#8` `DUPLICATE_CLONE_DETECTOR`** | Normalized 5-line shingles and `>=0.80` signature similarity trigger high false positives on boilerplate ESM imports, standard `try/catch` blocks, JSDoc banners, `describe/it` test scaffolding, and JSX markup, and risk `>100ms` cold scans on large repos. | Benchmark **`test/duplicate_clone_shingle_bench.test.mjs`** across `src/**/*.mjs`, stripping imports, comments, and structural single-brace lines prior to shingling; measure index build/update latency and false-hint precision on real commits vs. injected duplicates. | **Cold index `<25ms`**, **incremental `FileChanged` `<3ms`**, and **clone hint precision >= 90%** (`<10%` boilerplate FPs). |
| **`#9` `WEB_BOILERPLATE_BUDGETER`** | Lightweight regex HTML stripping frequently corrupts `<pre><code>` indentation, API comparison tables, or SSR JSON payloads (`__NEXT_DATA__`), while a hard 5-query/turn limit blocks legitimate multi-package security/changelog lookups. | Build **`test/web_boilerplate_fidelity.test.mjs`** against 20 saved HTML doc fixtures (MDN, GitHub issues, Next.js docs, API tables, StackOverflow); measure structural `<code>`/`<pre>`/`<table>` integrity alongside token reduction and parse latency. | **100% lossless preservation** of `<code>`/`<table>` blocks AND **`>= 80%` token reduction** in **`<15ms`**. |
| **`#3b` `TEST_INTEGRITY_LOCK` (Hardcoded Oracle)** | Static AST checks struggle to separate EvilGenie hardcoded benchmark return tables (`if (x === 17 && y === 42) return 99`) from valid domain constants, HTTP status handlers, boundary guards (`if (len === 0) return []`), or table-driven unit helpers. | Evaluate AST literal-branch density in **`test/evilgenie_oracle_sim.test.mjs`** across LiveCodeBench hardcoded fixtures vs. Highbeam parser/switch modules; log matches only in `.hints.jsonl` / `Stop` advisory. | **Precision >= 98%** on domain code before upgrading from `warn` to `deny`. |
| **`#13` `VAGUE_PROMPT_ANCHOR` (`<6`-Word Heuristic)** | Short prompts (`<6` words) often represent crisp Q&A or confirmations (`"do option 2"`, `"yes, commit it"`, `"explain DET-08"`). Running `git diff --stat` (`15–60ms` on Windows NTFS) and injecting dirty-tree diffs into Q&A turns adds noise and distracts the model. | Test **`test/vague_prompt_anchor_sim.test.mjs`** across 100 labeled short prompts (ambiguous debug cries `"fix it"` / `"still failing"` vs. confirmations/Q&A), computing git summary asynchronously in `PostToolUse` (`0ms` spawn cost at `UserPromptSubmit`). | **0% false-injection** on affirmative/Q&A prompts before activating auto-attach. |
| **`#16` `MCP_CLI_ROUTER`** | Blocking `mcp__github/aws/gcloud/sentry` calls because a CLI binary exists on `PATH` breaks workflows when the CLI has expired credentials (`gh auth status` exit `1`) while the MCP server holds a valid active session token. | Build **`test/mcp_cli_router_sim.test.mjs`** verifying local auth-cache file checks (`~/.config/gh/hosts.yml`, `~/.aws/config`, `~/.config/gcloud`) without slow subprocess network probes; log routing candidates to `.hints.jsonl`. | **Unauthenticated CLI false-route < 2%** before enabling `COACH` auto-steering. |
| **`#17` `LSP_SYMBOL_ROUTER`** | Intercepting the 3rd `Grep`/`Read` to mandate native `LSP` jump-to-definition deadlocks sessions whenever no LSP server is configured for the file language (e.g., plain `.mjs` projects without `typescript-language-server` or sessions lacking LSP capabilities). | Build **`test/lsp_symbol_router_sim.test.mjs`** gating strictly on verified runtime LSP capability (`ENABLE_LSP_TOOL=1` + active server attachment) and testing non-blocking `<20`-token `[CTX_HINT]` emission. | **100% verified active LSP capability** required before even advisory emission (`0` blind blocks). |
| **`#19` `OVERENGINEERING_DIFF_GATE`** | Ratio checks (`>200` added lines for a short prompt) misclassify legitimate root-cause fixes that properly add defensive parsing plus adversarial regression tests (e.g., Windows PowerShell tokenizer fixes). | Backtest added/deleted line ratios and new-interface counts over `git log -n 100` in **`test/overengineering_diff_sim.test.mjs`** (excluding `test/**` additions from bloat numerator); keep in `.hints.jsonl` shadow mode. | **False-positive rate < 5%** on test-backed bugfix commits. |
| **`#20` `PROSE_TO_HOOK_COMPILER`** | Prose rules like `NEVER edit <path>` often include conditional exceptions (*"unless running sync_mirrors.mjs"*), historical explanations, or negative examples; naive extraction hard-locks legitimate maintenance commands. | Build **`test/prose_to_hook_compiler.test.mjs`** parsing `AGENTS.md`/`CLAUDE.md` with a strict top-level imperative + backticked-glob grammar (rejecting any rule with `unless`/`except`/`if`/`when` clauses) and outputting candidate rules to `ctxtop doctor` review first. | **0% false-compile rate** across workspace `AGENTS.md`/`CLAUDE.md` rule corpora. |

---

## 5. Ordered Implementation Roadmap

### Wave 1 — Structural Plumbing + Immediate Cache & Pricing Shield (`Day 1`)
1. Fix **Item A0**:
   - Unify Antigravity `PreToolUse` (`src/hooks/pre_invocation.mjs`) through `src/hooks/portfolio_runtime.mjs` + validate `define_subagent` `tools:` and `Monitor` timeouts.
   - Register `UserPromptSubmit`, `ConfigChange`, `InstructionsLoaded`, `SessionEnd`, `Grep|Glob`, and `Edit|MultiEdit|Write` (`PostToolUse`) in `hooks/hooks.json`, `bin/ctxtop.mjs`, and `.agents/plugins/agy-horizon-flightcheck/hooks.json`.
   - Move `codeEditedSinceLastTest` reset (`src/core-isomorphic/guards/circuitBreakers.mjs`, `hooks/register.js`) strictly into `PostToolUse` exit code `0` (including `tsc`).
2. Ship **#1 `MID_SESSION_CACHE_BUST`** (Antigravity `PreInvocation` model delta + Claude `ConfigChange` `/effort`/plugin gate + `PostCompact` downshift actuation).
3. Ship **#7 `PRICING_CLIFF_BREAKER`** (Gemini 3.1/2.5 Pro `200K` + Haiku 5.5 `100K` parameterized `cliffBreaker.mjs`, `150`-line read clamp at `90%`, `.claude/agents/*.md` `autoCompactWindow` audit).
4. Ship **#10 `IDLE_DRAIN_BLOCKER`** (`ctxtop shield --enable` / `.claude/settings.local.json` sync + `SessionEnd` active-task warning).

### Wave 2 — Deterministic Code Health & Context Hygiene Locks (`Day 2`)
1. Ship **#3 `TEST_INTEGRITY_LOCK`** (`SessionStart` test-hash baseline + `PreToolUse` `.git` mining block, `-1` assertion guard, `.skip`/weakening lock).
2. Ship **#15 `MEMORY_RULE_VALIDATOR`** (Claude Auto-Memory `200`-line / `25KB` check + Antigravity camelCase frontmatter / `>20k`-tok / `rules.json` audit).
3. Ship **#12 `ERROR_MASKING_LINTER`** (remove `deletedAssertions > 0` gate, add Python `except: pass`, wire Antigravity + Claude `PostToolUse` edits).
4. Ship **#14 `MULTIMODAL_IPYNB_SANITIZER`** (`.ipynb` `>256KB` / base64 stripping + `.pdf` `>10`-page slice guard) and **#11 `THINKING_TIMEOUT_GOV`** (`>32K` Gemini timeout billing warning + active `DET-30` `/effort` gate).
5. Ship **#18 `WORKTREE_DESTRUCTIVE_GUARD`** (`git checkout --` / `git restore` un-stashed discard block + concurrent write-worker `worktree`/`branch` isolation enforcement).
6. Run mirror propagation and integrity verification:
   `cmd /c "node scripts/sync_mirrors.mjs && node scripts/generate_checksums.mjs && node bin/ctxtop.mjs verify --json"`

### Wave 3 — Shadow Telemetry (`.hints.jsonl`) & Replay Harnesses for Bucket B (`Week 1`)
1. Implement zero-block shadow telemetry writer to `.agents/telemetry/<sessionId>.hints.jsonl`.
2. Build and run deterministic `node --test` suites in order of ROI:
   - **`#2 GREP_GLOB_FIREWALL`** (`test/grep_glob_firewall_sim.test.mjs`)
   - **`#6 SLOPSQUAT_DEP_GATE`** (`test/slopsquat_dep_gate.test.mjs`, shipping Phase 1 offline lockfile + conflation filter first)
   - **`#4 BLAST_RADIUS_BREAKER`** (`test/blast_radius_sim.test.mjs`)
   - **`#9 WEB_BOILERPLATE_BUDGETER`** (`test/web_boilerplate_fidelity.test.mjs`)
   - **`#8 DUPLICATE_CLONE_DETECTOR`** (`test/duplicate_clone_shingle_bench.test.mjs`)
   - **`#5`, `#13`, `#16`, `#17`, `#19`, `#20`, `#3b`** replay suites.
3. Promote each Bucket B gate from `shadow/warn` -> `deny` only once its promotion metric in Section 4 is met in CI.
