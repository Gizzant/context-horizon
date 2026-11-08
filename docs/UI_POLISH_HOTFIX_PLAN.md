# ROLE & OBJECTIVE
You are a Principal Frontend & Systems Architect on the Google Antigravity Core Team. Execute a targeted UI and state-logic hotfix pass on `C:\Projects\ga-visualizer-v2` (`src/webview/horizon_panel.html`, `src/core/classifier.mjs`, and `src/core/layer5_hygiene.mjs`) to resolve 8 visual, mathematical, and cache-coherence bugs visible in the live Context Memory panel.

## ARCHITECTURAL INVARIANTS (DO NOT VIOLATE)
1. **No `/compact` Copy Button**: Keep `/compact` instructions as plain selectable text inside `#compactInstruction` and `#compactReclaim`. Never render `#btnCompactPrimary` or `copyCompactWithGuidance`.
2. **Active Source File Protection**: Never allow `isIgnorablePath` to ignore editable source files (`*.html`, `*.js`, `*.mjs`, `*.ts`, `*.py`).
3. **3-Way Mirror Parity**: Run `node scripts/sync_mirrors.mjs` after editing any core or webview file so the workspace and global plugins match by SHA-256 hash.

---

## PHASE 1: STATE & MATH COHERENCE FIXES (`src/core/`)

1. **Fix False-Warm Cache State When `hitRatePct === 0%` (`classifier.mjs` & `quota.mjs`)**:
   * **Bug**: The UI displays `Cache: 0% hit (299s TTL)` alongside the `🔒 Warm` badge (`#prefixLockBadge`), a teal cached history bar, and the green `"Cache is currently warm (95% token cost discount)"` advisory banner because the state check only evaluates `ttlRemainingSec > 0`.
   * **Fix**: Define a strict boolean `isCacheTrulyWarm = (cache.ttlRemainingSec > 0 && cache.cacheReadTokens > 0 && cache.hitRatePct > 0 && !cache.prefixBustDetected)`.
   * Gate `historyBarState.state = 'CACHED_WARM'`, `prefixLockWarning = true` (`#prefixLockBadge`), and `compaction.cacheAdvisory.state = 'DEFER_WARM'` strictly on `isCacheTrulyWarm === true`. When `cacheReadTokens === 0` or `hitRatePct === 0`, classify the history bar as `COLD_BLOAT` (Amber `#f59e0b`) and hide `#prefixLockBadge`.

2. **Fix Literal `[1 in-chat user constraint(s)]` Placeholder & Ellipsis Paths in `/compact` Template (`classifier.mjs` / `layer5_hygiene.mjs`)**:
   * **Bug**: `compaction.parameterizedCommand` outputs `3) Explicit user constraints: [1 in-chat user constraint(s)].` instead of the actual user rule text, and prefixes file paths with `.../` (`.../webview/horizon_panel.html`).
   * **Fix**: Extract the actual sanitized text from `userCorrectionTexts` (ignoring raw `/plan` headers or artifact URIs, and truncating each constraint cleanly at 90 characters) and interpolate the real text into clause 3. If no valid user constraint text exists, omit clause 3 completely (`Focus on preserving: 1) ..., 2) Current checklist state in task.md.`). Format all file paths in clause 1 as clean workspace-relative paths (`src/webview/horizon_panel.html`, `tests/verify_e2e_context_memory.mjs`) without `.../` prefixes.

3. **Enforce `0.1k` Mathematical Sum Parity Across Cards and Headline (`classifier.mjs` & `horizon_panel.html`)**:
   * **Bug**: `Active Signal` (`30.4k`) + `Reclaimable` (`82.4k`) sums to `112.8k`, whereas the headline total, dropdown badge, and footer display `112.7k`.
   * **Fix**: Enforce Tenth-of-a-Kilotoken Mathematical Parity (`test_regressions.cjs` standard): compute `displayActiveTenths = Math.round(activeSignalTokens / 100)` and `displayTotalTenths = Math.round(totalTokens / 100)`, then derive `displayReclaimableTenths = Math.max(0, displayTotalTenths - displayActiveTenths)` so `Active Signal + Reclaimable` always equals the exact headline token count to `0.1k`.

---

## PHASE 2: WEBVIEW DOM & CSS LAYOUT FIXES (`src/webview/horizon_panel.html`)

4. **Resolve Watermark Label Collision on the Capacity Bar (`50k` vs `179k`)**:
   * **Bug**: Above the progress bar, `50k Cascade Sync Armed` (at `19.5%`) and `179k Attention Horizon (Safe Limit) (Standard / Auto)` (at `70%`) sit on the same vertical line and collide into unreadable overlapping text.
   * **Fix**:
     * Shorten the inline visible tick labels to `50k Sync` and `179k Safe Limit` (keep the full text in each marker's `title` tooltip).
     * Stagger their vertical placement or alignment: anchor the `50k Sync` label below the bar track (or left-aligned at `19.5%`) and right-align the `179k Safe Limit` label above the bar track (`transform: translateX(-100%)`) with `white-space: nowrap` so they cannot overlap at any viewport width.

5. **Synchronize Middle Metric Card Color & Title with Bar State (Teal vs. Amber)**:
   * **Bug**: When the history bar segment renders in Muted Teal (`--hz-cached-history: #0d9488`), the middle breakdown card below it still renders an Amber dot, Amber `82.4k (73%)` value, and the label `Reclaimable`.
   * **Fix**: When `historyBarState.state === 'CACHED_WARM'`, style the middle card's indicator dot and token value with `var(--hz-cached-history)` (`#0d9488`), update its title to `Cached History`, and set its subtitle to `95% discounted · /compact ready`. When cold or over the 70% horizon, render the Amber dot (`var(--hz-clutter)`), title `Reclaimable`, and subtitle `Can be cleared`.

6. **De-clutter `/compact` Boxes in `Simple` Mode & Mute Contradictory Borders**:
   * **Bug**: In `Simple` mode (`body[data-view-mode="simple"]`), the UI stacks four competing boxes: a green "Defer compaction" banner, an urgent amber-bordered `/compact` box, a 5-line blue dashed `PARAMETERIZED COMPACTION TEMPLATE` box, and the `/handoff` box.
   * **Fix**:
     * In `Simple` mode, collapse the `PARAMETERIZED COMPACTION TEMPLATE` box inside a clean `<details>` disclosure drawer (`▶ Parameterized /compact template`) or restrict the expanded block to `Advanced` mode.
     * Whenever the green `DEFER_WARM` cache banner is visible, change the left/outer border of `#guidedStepBox` (`Type /compact in the chat box...`) from urgent amber (`var(--hz-clutter)`) to subtle slate (`var(--hz-border)`) so the visual hierarchy does not contradict the green "Defer compaction" banner above it.

7. **Prevent Right-Edge Clipping on the Turn-Delta Line (`(~3...`)**:
   * **Bug**: Long filenames in the turn-delta banner push the token count off the right edge (`▲ +26.2k since last turn · largest: edit_file verify_e2e_context_memory.mjs (~3...`).
   * **Fix**: Render the delta row as a flex container where the file path span uses `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 210px;` (or middle-truncate filenames > 24 chars such as `verify_e2e...memory.mjs`), and wrap the token delta suffix `(~3.4k)` in a `flex-shrink: 0` span so the token number is never clipped.

8. **Remove Double Green Dot on `• ● task.md synced`**:
   * **Bug**: The separator character `•` before `● task.md synced` inherits the green status color, rendering two green dots side by side (`• ● task.md synced`).
   * **Fix**: Remove the leading `•` character from `#taskSyncBadge` (or move it outside the green-colored span with `color: var(--hz-muted)`).

---

## PHASE 3: AUTOMATED VERIFICATION & MIRROR SYNC

1. Add explicit DOM and state assertions for all 8 fixes in `tests/verify_e2e_context_memory.mjs`:
   * Assert that when `cache.hitRatePct === 0` or `cache.cacheReadTokens === 0`, `#prefixLockBadge` is hidden and `historyBarState.state !== 'CACHED_WARM'`.
   * Assert that `compaction.parameterizedCommand` never contains the substring `in-chat user constraint(s)` or `.../`.
   * Assert that `parseFloat(activeCardText) + parseFloat(reclaimableCardText) === parseFloat(usedBigText)` to `0.1k`.
   * Assert that `#taskSyncBadge` text does not start with `• ●`.
2. Execute the full verification pipeline:
   * `node scripts/sync_mirrors.mjs`
   * `npm test`
   * `npm run test:phases`
   * `node tests/verify_e2e_context_memory.mjs`