# ROLE & OBJECTIVE
You are a Principal Systems Architect on the Google Antigravity Core Team. Your task is to execute a pre-launch bug-fix and verification pass on `C:\Projects\ga-visualizer-v2` (Context Horizon / `agy-horizon` v3.1.0) to resolve 10 telemetry, state, and runtime compatibility bugs uncovered during our Show-HN forensic audit.

> **Status:** **COMPLETED** (All 10 Fixes Verified & 3-Way Mirror Parity Confirmed)  
> **Unit Suite:** 18 tests passing across 7 suites (`npm test`)  
> **Phase Suites:** All 7 phase test suites passing (`npm run test:phases`)  
> **End-to-End Suite:** All 7 validation layers passing (`node tests/verify_e2e_context_memory.mjs`)  
> **Latency Benchmarks:** SLA budgets met (`readSidecarSync` p95: 0.312ms, `PreInvocation Gate` p95: 0.150ms, `HUD Render` p95: 28.540ms)  
> **3-Way WebView Mirror SHA-256:** `56eaad262dc9124191d0a03334b1df51d414f81691498612beda71fec6ac6347` (byte-for-byte identical)

## ARCHITECTURAL INVARIANTS (MUST NOT BE VIOLATED)
Before modifying any file, read `AGENTS.md` and enforce these four repository invariants across every edit:
1. **No Copy/Paste Button for `/compact`**: Never render a clickable copy button (`#btnCompactPrimary` or `copyCompactWithGuidance`) for `/compact`. Keep plain-text instructions inside `#compactInstruction` and `#compactReclaim`.
2. **Active Source File Protection**: `isIgnorablePath` must never allow ignoring editable source files (`*.html`, `*.js`, `*.mjs`, `*.ts`, `*.py`).
3. **3-Way Mirror Parity**: After any edit to `src/core/*.mjs` or `src/webview/horizon_panel.html`, run `node scripts/sync_mirrors.mjs` so the workspace, `agy-horizon`, and `agy-horizon-flightcheck` remain byte-for-byte identical (SHA-256 verified).
4. **Zero-Trust Read-Only Posture**: Open all SQLite databases strictly with `SQLITE_OPEN_READONLY_OPTIONS` (`{ readOnly: true }`), open JSONL files with `'r'`, keep zero runtime npm dependencies, and make zero external network requests.

---

## PHASE 1: CORE ENGINE & TELEMETRY MATH FIXES (`src/core/`)

Inspect and fix the following 7 defects in `src/core/constants.mjs`, `src/core/classifier.mjs`, `src/core/parser.mjs`, `src/core/quota.mjs`, and `src/core/layer5_hygiene.mjs`:

1. **Unify `activeEffortProfile.safeLimit` with the 70% Attention Horizon (`constants.mjs` & `classifier.mjs`)**:
   * **Bug**: On a 256k `STANDARD` session, `activeEffortProfile.safeLimit` resolves to `229000` ("229k recall ceiling") while `window.safeLimit` resolves to `179000` and `window.watermarks.attentionHorizon.tokens` resolves to `179200`.
   * **Fix**: Reconcile `scaleEffortProfileForCeiling()` and `window.safeLimit` so `STANDARD` on a 256,000 ceiling uses a single canonical safe horizon (`179200` exact / `179.2k` display, or `180000` if aligned with Table 3.1), and compute `safeHeadroomTokens` from exact integers (`safeLimitTokens - totalActiveTokens`) before rounding to `0.1k`.

2. **Fix Low-Token False Positives in the U-Shaped Attention Trough (`classifier.mjs`)**:
   * **Bug**: In sessions with small token footprints (e.g., `24,122` tokens / `activeCellCount: 4`), Cell #1 (`6.4k-12.8k` tokens) is flagged with `inAttentionTrough: true` and `isStrandedSignal: true` because its normalized index is `0.333`. Additionally, `specFormulaValue` uses the inverted arch `1.0 - 4.0 * gamma * (x - 0.5)^2` while `uShapedWeight` uses the upright parabola.
   * **Fix**: Gate `inAttentionTrough` and `isStrandedSignal` on a minimum active token floor (`totalActiveTokens >= 44800` or `cellIndex >= 6`, matching the Cell 7-15 specification) so short conversations (<45k tokens) never trigger false "Lost in the Middle" warnings. Remove or align the inverted `specFormulaValue` field so `uShapedWeight` (`(1.0 - gamma) + 4.0 * gamma * (((i + 0.5) / N) - 0.5)^2`) is the single canonical curve.

3. **Filter `.system_generated/steps/` Paths from `/compact` & `/handoff` Synthesis (`classifier.mjs` / `layer5_hygiene.mjs`)**:
   * **Bug**: `compaction.parameterizedCommand` and `compaction.batonPass.command` include internal log hydration paths like `.system_generated/steps/9/output.txt` and `4/output.txt` in the list of active workspace AST files.
   * **Fix**: Exclude any path containing `.system_generated`, `/.gemini/antigravity/brain/`, or temporary step output files when extracting active workspace files for parameterized `/compact` and `/handoff` commands.

4. **Clear Stale `prefixBustDetected` When Cache Is Already Cold (`quota.mjs` & `classifier.mjs`)**:
   * **Bug**: When a session has been idle for hours (`idleSeconds: 5902`, `ttlRemainingSec: 0`, `isCacheCold: true`), `cache.prefixBustDetected` still evaluates to `true` from the last turn pair, displaying `⚠️ Prefix Bust (system_message / config drift)` on an idle, expired session. Also ensure `prefixLockWarning` is strictly `false` whenever `ttlRemainingSec === 0` or `prefixBustDetected === true`.
   * **Fix**: Only set `prefixBustDetected = true` as an active warning on the current state if the session is actively running or within the recent window (`idleSeconds < 300`), or separate `lastTurnPrefixBust` (historical) from live `activePrefixBust`. Gate `#sessionSelect` prefix-lock tooltips strictly on `(ttlRemainingSec > 0 && !prefixBustDetected && cacheReadTokens > 50000)`.

5. **Enforce Checkpoint Epoch Slicing & Mutual Exclusivity in Waste Buckets (`classifier.mjs` & `layer5_hygiene.mjs`)**:
   * **Bug**: Ensure pre-checkpoint steps prior to the latest `CORTEX_STEP_TYPE_CHECKPOINT` (`step_type == 23`) are excluded from active reclaimable waste buckets, and verify that each reclaimable step is assigned to a single mutually exclusive bucket (`STALE_DUPLICATE` file re-read vs `DEAD_ERROR` vs `Earlier Chat History`) so bucket sums always equal `sludgeTokens` without negative residuals.

6. **Deduplicate `amputation.anchorsAtRisk` (`classifier.mjs`)**:
   * **Bug**: `amputation.anchorsAtRisk` contains duplicate entries (`["System & Project Anchors", "System & Project Anchors", "System & Project Anchors"]`).
   * **Fix**: Wrap `anchorsAtRisk` in `Array.from(new Set(...))` before serializing state.

7. **Deduplicate Multi-Store UUIDs & Filter 0-Step Ghost Sessions (`parser.mjs`)**:
   * **Bug**: `reconcileWorkspaceAndKIs` includes empty `stepCount: 0` sessions with blank workspaces in `recentSessions`, and upgrading to Antigravity v2.6.0+ can leave identical `<uuid>.db` files in both `~/.gemini/antigravity` and `~/.gemini/antigravity-ide`.
   * **Fix**: Filter out `stepCount === 0` ghost entries (unless it is the currently active session ID) and deduplicate discovered sessions by `sessionId`, preferring the surface entry with the newest `lastModified` timestamp.

---

## PHASE 2: DAEMON & UI COMPATIBILITY FIXES (`sidecars/` & `src/webview/`)

Inspect and fix the following 3 runtime compatibility issues in `sidecars/horizon-daemon/server.mjs`, `src/core/quota.mjs`, and `src/webview/horizon_panel.html`:

8. **Antigravity v2.6.0+ `agy --hub` Plain-HTTP Quota Probing (`quota.mjs` / `server.mjs`)**:
   * **Bug**: Following the November 3, 2026 `language_server` TLS certificate expiration, Antigravity v2.6.0+ replaced the HTTPS `language_server` daemon with `agy --hub` serving plain HTTP on `127.0.0.1:[port]` with `x-codeium-csrf-token`.
   * **Fix**: Ensure local process discovery matches both `agy* --hub` and legacy `language_server*` processes, extracts the CSRF token, and probes `http://127.0.0.1:{port}` first before falling back to `https://127.0.0.1:{port}` (`rejectUnauthorized: false`).

9. **Cross-Surface `toggleConversation` Crash Guard & `open-brain` Fallback (`horizon_panel.html` & `server.mjs`)**:
   * **Bug**: Calling `window.sidecar.ui.toggleConversation(targetId)` on a foreign-surface session (e.g., clicking `Open ↗` on a `[CLI]` session while inside `[App]`) triggers the Antigravity host UI toast crash. Additionally, headless `[CLI]` sessions may not have a `brain/<uuid>/` directory on disk.
   * **Fix**: In `horizon_panel.html`, if the selected session's surface does not match the active host surface (or if `window.sidecar?.ui?.toggleConversation` is unavailable), route standard clicks on `#btnOpenChat` (`Open ↗`) to `POST /api/open-brain`. In `server.mjs`, make `POST /api/open-brain` check `fs.existsSync(brainDir)` and fall back to opening the parent `conversations/` directory if `brain/<uuid>/` has not been created yet.

10. **Verify No `/compact` Copy Button Regression (`horizon_panel.html`)**:
    * Confirm that Layer 4's parameterized `/compact` advisory renders as selectable plain text inside `#compactInstruction` / `#compactReclaim` without adding a prohibited copy button for `/compact` (Invariant #1 in `AGENTS.md`), while preserving the 1-click `POST /api/handoff/generate` Baton Pass button.

---

## PHASE 3: DETERMINISTIC VERIFICATION & MIRROR SYNC

1. Add unit assertions covering Fixes 1 through 9 to `tests/verify_e2e_context_memory.mjs`:
   * Assert `activeEffortProfile.safeLimit` matches `window.safeLimit`.
   * Assert sessions with `< 40,000` tokens (`activeCellCount <= 6`) have `0` cells with `isStrandedSignal === true`.
   * Assert `compaction.parameterizedCommand` and `batonPass.command` never contain `.system_generated`.
   * Assert `amputation.anchorsAtRisk` has no duplicate strings.
   * Assert `recentSessions` contains unique `sessionId` values and excludes non-active `stepCount === 0` ghost sessions.
2. Run the full verification and benchmark suite:
   * `node scripts/sync_mirrors.mjs`
   * `npm test`
   * `npm run test:phases`
   * `node tests/verify_e2e_context_memory.mjs`
   * `npm run bench`
3. Report the exact test counts, SHA-256 mirror hashes, and p95/p99 latency results.