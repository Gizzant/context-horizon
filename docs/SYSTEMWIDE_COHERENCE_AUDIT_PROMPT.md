# ROLE & OBJECTIVE
You are a Principal Systems & Frontend Architect on the Google Antigravity Core Team. We have recently uncovered several classes of state-logic contradictions, false-positive heuristics, mismatched remediation copy, and UI layout bugs in `C:\Projects\ga-visualizer-v2` (Attention Horizon / `agy-horizon`). 

Your objective is to perform an exhaustive, line-by-line forensic sweep across the entire codebase (`src/core/*.mjs`, `src/cli/*.mjs`, `src/hooks/*.mjs`, `sidecars/horizon-daemon/server.mjs`, `src/webview/horizon_panel.html`, `src/ui/sidepane.html`, and `src/ui/widget.html`) to find, document, and recommend exact code fixes for **all other similar issues** before our Hacker News launch.

## ARCHITECTURAL INVARIANTS (MUST BE PRESERVED)
Read `AGENTS.md` first. Every recommended fix must uphold:
1. **No `/compact` Copy Button**: Never render a clickable copy button (`#btnCompactPrimary` or `copyCompactWithGuidance`) for `/compact`.
2. **Active Source File Protection**: `isIgnorablePath` must never allow ignoring editable source files (`*.html`, `*.js`, `*.mjs`, `*.ts`, `*.py`).
3. **3-Way Mirror Parity**: Any fix in `src/webview/horizon_panel.html` or `src/core/*.mjs` must also be evaluated against `src/ui/sidepane.html`, `src/ui/widget.html`, and synced via `node scripts/sync_mirrors.mjs`.
4. **Zero-Trust Read-Only Posture**: Maintain `SQLITE_OPEN_READONLY`, zero runtime npm dependencies, and `127.0.0.1` loopback binding.

---

## AUDIT TAXONOMY: THE 6 BUG CLASSES TO HUNT DOWN

Scan every module and UI template for the following six defect patterns:

### Class 1: Cross-Layer State & Banner Contradictions
Look for places where two UI components, badges, or banners evaluate overlapping state variables using slightly different boolean logic, resulting in contradictory simultaneous messages:
* **Banner vs. Banner Conflicts**: Check all conditional banners (`#cacheCompactionAdvisory`, `#artifactDriftBanner`, `#highEffortSludgeBanner`, `#strandedSignalBanner`, `#overageAlert`, `#actionCard`) to verify they cannot display conflicting next-step instructions at the same time (e.g., telling the user to "Sync `task.md` before compacting" in one banner while telling them to "Run compaction now" in the banner directly below it).
* **Header/Badge vs. Strip Conflicts**: Verify that `#statusDot`, `#statusBadge`, `#prefixLockBadge`, `#quotaStrip`, `#taskSyncBadge`, and `#historyBarState` all derive "Warm vs. Cold", "Synced vs. Stale vs. Missing", and "Healthy vs. Cluttered" from single canonical boolean predicates rather than re-implementing ad-hoc checks in DOM rendering code.
* **Simple vs. Advanced Mode Leaks**: Check whether `Simple` mode references or instructs the user to use elements that are only visible in `Advanced` mode (or hidden inside collapsed drawers).

### Class 2: False-Positive Heuristics on Edge-Case Sessions
Audit every detector and sensor (`classifier.mjs`, `quota.mjs`, `layer5_hygiene.mjs`, `session_forensics.mjs`, `handoff_audit.mjs`, `blindspot_sensors.mjs`) against four boundary session profiles:
1. **Brand-new / Lean sessions** (`< 25k` tokens, `< 10` turns, `0` file writes).
2. **Log-tier degraded sessions** (where `cache_read_input_tokens` or ISO timestamps are missing/zero in JSONL).
3. **Post-compaction sessions** (where `CORTEX_STEP_TYPE_CHECKPOINT` / `step_type == 23` just occurred).
4. **Idle / Cold historical sessions** (`idleSeconds > 300`).
* Specifically check for:
  * **Premature Alarms**: Warnings that fire on tiny token counts or 0-edit sessions (e.g., repo-wide `git status --porcelain` blaming a read-only chat for 60 dirty workspace files, or U-curve attention troughs flagging Cell #1 of a 4-cell chat or the final Recency cell of a 10-cell chat).
  * **Missing Prior-State Guards**: Detectors like `stepPrefixBustDetected` firing when `rawCacheRead === 0` even if the session never established a warm cache hit on any prior turn.

### Class 3: Mismatched Remediation Prompts, Tool Advice & Technical Claims
Inspect every entry in `PROMPTS`, `playbookList`, `offenders`, `diagnostics`, `prompt_rubric.mjs`, and `pre_invocation.mjs`:
* **Tool/Payload Mismatches**: Find any place where a file-based event (`read_file`, `view_file`, `edit_file`, `write_file`) triggers a shell-command remedy (e.g., recommending PowerShell `Select-Object -First 50` or a `PreToolUse` CLI stdout hook when the token spike actually came from reading/editing a large source file), or vice versa.
* **Ephemeral vs. Persistent Remedy Mismatches**: Find cross-session problems (e.g., `chronicReads` across 10 sessions, Turn-0 MCP schema bloat) where the recommended action only injects a temporary one-chat prompt instead of promoting a rule to `AGENTS.md` or updating `mcp_config.json`.
* **Inaccurate Antigravity Physics Claims**: Check all UI copy, tooltips, and explanations for claims that violate actual Antigravity runtime behavior (e.g., claiming JSONL pruning doesn't bust a warm KV prefix cache, claiming bare `/compact` keeps all active raw code buffers intact, or claiming `task.md` is stale when `task.md` was never created).
* **Uninterpolated Template Fallbacks**: Check all string builders for generic fallback placeholders (like `"generic"`, `"[1 in-chat user constraint(s)]"`, `"unknown"`, or raw `.system_generated/steps/` paths) that leak into user-facing prompts.

### Class 4: Hardcoded Repo Paths & Non-Portable Commands
Scan all UI code boxes, CLI hints, daemon routes, and test scripts for commands or paths that only work inside `C:\Projects\ga-visualizer-v2`:
* Check for hardcoded local script invocations (like `node src/cli/doctor.mjs --prune-tools`) instead of portable package commands (`npx ctxtop ...` or `npx context-horizon ...`).
* Check for Windows-only path assumptions (`\` vs `/`, PowerShell-only syntax on macOS/Linux hosts) and cross-surface `window.sidecar.ui.toggleConversation` calls that fail when inspecting `[CLI]` or `[IDE]` sessions from `[App]`.

### Class 5: Mathematical, Unit-Scope & Rounding Drift
Verify numerical consistency across all cards, badges, and tables:
* **Scope Mixing (Single-Session vs. Cross-Session)**: Identify any UI list (such as `playbookList`) that mixes multi-session cumulative token totals (e.g., `~76.9k` across 10 sessions) with current-session token counts (`~49.2k`) using identical badge styling or sorting them into the same ranking scale.
* **`0.1k` Sum & Subtraction Parity**: Check every place where `roundK()`, `fmtK()`, or `.toFixed(1)` is used to ensure displayed parts always sum to displayed totals (`Active Signal + Reclaimable === Total`, `Used + Safe Headroom === Safe Limit`, and Layer 5 waste bucket rows `=== Total Reclaimable`).

### Class 6: CSS, Overflow, Word-Break & Legacy Mirror Drift
Inspect `src/webview/horizon_panel.html`, `src/ui/sidepane.html`, and `src/ui/widget.html`:
* **Mid-Word Line Breaks**: Find any CSS rules using `word-break: break-all` on prose or prompt containers that split English words across