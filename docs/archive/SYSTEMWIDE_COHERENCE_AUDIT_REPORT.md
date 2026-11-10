# Context Horizon (ctxtop) — Systemwide Coherence Forensic Audit Report
**Target System**: ga-visualizer-v2 / Attention Horizon (agy-horizon / agy-horizon-flightcheck)
**Audit Scope**: Forensic sweep across src/core/*.mjs, src/cli/*.mjs, src/hooks/*.mjs, sidecars/horizon-daemon/server.mjs, src/webview/horizon_panel.html, src/ui/sidepane.html, src/ui/widget.html, and scripts/sync_mirrors.mjs.
**Date**: November 2026

---

## 1. Executive Summary Table

Across all 6 Bug Classes, the forensic sweep uncovered **38 distinct issues** (42 individual defect sites):

| Bug Class | Description | CRITICAL | HIGH | MEDIUM | LOW | Total |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Class 1** | Cross-Layer State & Banner Contradictions | 1 | 5 | 2 | 0 | **8** |
| **Class 2** | False-Positive Heuristics on Edge-Case Sessions | 4 | 6 | 1 | 0 | **11** |
| **Class 3** | Mismatched Remediation Prompts, Tool Advice & Technical Claims | 2 | 3 | 3 | 0 | **8** |
| **Class 4** | Hardcoded Repo Paths & Non-Portable Commands | 0 | 2 | 1 | 0 | **3** |
| **Class 5** | Mathematical, Unit-Scope & Rounding Drift | 0 | 4 | 5 | 0 | **9** |
| **Class 6** | CSS, Overflow, Word-Break & Legacy Mirror Drift | 0 | 2 | 1 | 0 | **3** |
| **Total** | **All Audited Subsystems** | **7** | **22** | **13** | **0** | **42*** |

---

## 2. Detailed Issue Inventory

### Bug Class 1: Cross-Layer State & Banner Contradictions

﻿# Forensic Audit Report: `horizon_panel.html`, `sidepane.html`, `widget.html`, `server.mjs` & `sync_mirrors.mjs`

---

## Class 1: Cross-Layer State & Banner Contradictions

### 1.1 Banner vs. Banner Conflicts

#### Bug 1.1a: `#highEffortSludgeBanner` ("compact now") vs. `#cacheCompactionAdvisory.warm-defer` ("Defer compaction until work pause") vs. `#artifactDriftBanner` ("Sync task.md before compacting")
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `2072â€“2077` (DOM stack inside `#guidedStepBox`), Lines `3752â€“3760` (`highEffortBanner`), Lines `3815â€“3843` (`cacheAdvisoryEl`), Lines `3845â€“3863` (`driftBannerEl`).
- **Function Name**: `renderState(raw, fromCatalog)`
- **Reproduction Scenario**:
  1. Active effort tier is `HIGH` (`effortProfile.tier === 'HIGH'`, `safeLimit = 115000`).
  2. `totalTokens = 85000`, `clutterTokens = 35000` (`>= 30000`).
  3. Prompt cache is warm (`ttlRemainingSec = 240`, `cacheReadTokens = 75000`, `hitRatePct = 88`, `nextTurnLikelyWarm = true`).
  4. Optional: `hasDriftWarn = true` (1 dirty git file while `task.md` is stale).
- **Root Cause in Code**:
  - `isNeedsCleanup` is `true` (`clutterTokens >= 25000`), so `#guidedStepBox` is shown (`display: flex`, line `3879`).
  - Lines `3752â€“3755` unhide `#highEffortSludgeBanner` whenever `effortProfile.tier === 'HIGH' && clutterTokens >= 30000` without checking whether the cache is warm (`!isColdOrOver179k`) or whether `hasDriftWarn` requires saving `task.md` first:
    `âš¡ High Effort active with 35k of stale noise â€” compact now to prevent slow reasoning turns and thinking-token burn.`
  - Immediately below it (line `2074`, lines `3849â€“3858`), `#artifactDriftBanner` renders:
    `âš ï¸ Pre-Compaction Drift Warning: ... Sync task.md before compacting.`
  - Immediately below that (line `2075`, lines `3837â€“3840`), `#cacheCompactionAdvisory` renders:
    `Cache is currently warm (95% token cost discount). Defer compaction until work pause to avoid 70s execution stall and complete KV cache invalidation.`
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3750,11 +3750,6 @@
       }
     }
 
-    if (highEffortBanner) {
-      if (effortProfile.tier === 'HIGH' && clutterTokens >= 30000) {
-        highEffortBanner.hidden = false;
-        highEffortBanner.textContent = `\u26A1 High Effort active with ${reclaimSumStr} of stale noise \u2014 compact now to prevent slow reasoning turns and thinking-token burn.`;
-      } else {
-        highEffortBanner.hidden = true;
-        highEffortBanner.textContent = '';
-      }
-    }
-
     // Update Top Header Badge and /compact instruction subtitle in all states
@@ -3836,9 +3831,24 @@
       } else {
         cacheAdvisoryEl.className = 'cache-compaction-advisory warm-defer';
         cacheAdvisoryEl.dataset.advisoryState = 'warm-defer';
-        cacheAdvisoryEl.textContent = 'Cache is currently warm (95% token cost discount). Defer compaction until work pause to avoid 70s execution stall and complete KV cache invalidation.';
+        cacheAdvisoryEl.textContent = hasDriftWarn
+          ? 'Cache is currently warm (95% token cost discount). Save task.md now and defer /compact until a work pause or cache expiry.'
+          : 'Cache is currently warm (95% token cost discount). Defer compaction until work pause to avoid 70s execution stall and complete KV cache invalidation.';
       }
       // Mute the /compact instruction's amber accent while the green "Defer compaction" banner is shown.
       if (guidedBox) guidedBox.dataset.cacheAdvisory = cacheAdvisoryEl.dataset.advisoryState;
     }
+
+    if (highEffortBanner) {
+      const isWarmDeferActive = cacheAdvisoryEl && cacheAdvisoryEl.dataset.advisoryState === 'warm-defer';
+      if (effortProfile.tier === 'HIGH' && clutterTokens >= 30000) {
+        highEffortBanner.hidden = false;
+        highEffortBanner.textContent = hasDriftWarn
+          ? `\u26A1 High Effort active with ${reclaimSumStr} of stale noise \u2014 sync task.md first, then compact to prevent thinking-token burn.`
+          : (isWarmDeferActive
+              ? `\u26A1 High Effort active with ${reclaimSumStr} of stale noise \u2014 compact at your next pause (or when cache TTL expires) to prevent thinking-token burn.`
+              : `\u26A1 High Effort active with ${reclaimSumStr} of stale noise \u2014 compact now to prevent slow reasoning turns and thinking-token burn.`);
+      } else {
+        highEffortBanner.hidden = true;
+        highEffortBanner.textContent = '';
+      }
+    }
```

---

#### Bug 1.1b: `#guidedStepBox` / `#compactInstruction` Shows Contradictory "Type `/compact`..." + "Session is lean Â· No compaction needed until >50k" Simultaneously
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `3710â€“3711`, `3766`, `3803â€“3804`, `3823â€“3827`, `3872`, `3880`.
- **Function Name**: `renderState(raw, fromCatalog)`
- **Reproduction Scenario**:
  1. User configures a custom `safeLimit` in Settings (e.g., `40000` tokens, so `reminderAt = 34000`) with `totalTokens = 36000`, `clutterTokens = 12000`; **OR** `clutterTokens = 26000` derived from `breakdownClutter` while `raw.metrics.sludgeTokens` is `0` (e.g. V3 telemetry or breakdown-only fixture) and `totalTokens = 42000` (`< 50000`).
- **Root Cause in Code**:
  - `isCompactionWorthStall` (line `3710`) checks `totalTokens > 179000 || totalTokens >= 50000 || clutterTokens >= 25000 || (reclaimSumK * 1000) >= 25000 || Number(raw.metrics?.sludgeTokens || 0) >= 25000`, and `isNeedsCleanup` (line `3711`) checks `totalTokens >= reminderAt || clutterTokens >= 25000 || ...`.
  - However, `compactionRelevant` (line `3804`) checks `totalTokens > 179000 || totalTokens >= 50000 || sludgeNow >= 25000` (using only `raw.metrics?.sludgeTokens` and ignoring `clutterTokens`, `reclaimSumK`, `isOverLimit`, and `isNeedsCleanup`).
  - When `isOverLimit` or `isNeedsCleanup` is `true` while `compactionRelevant` is `false`:
    - `#guidedStepBox` is shown (`display: flex` at lines `3871` / `3879`).
    - `cacheAdvisoryEl.dataset.advisoryState` is set to `'lean'` (line `3825`).
    - `#compactInstruction` displays title `"Type /compact in the chat box and press Enter"` while its own subtitle `#compactReclaim` (lines `3766`, `3872`, `3880`) displays `"Session is lean (36k / 14%) Â· No compaction needed until >50k Â· reclaims up to ~12k"`.
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3800,8 +3800,8 @@
     }
 
     const handoffAudit = signals.handoff || {};
-    const sludgeNow = Number(raw.metrics?.sludgeTokens || 0);
-    const compactionRelevant = totalTokens > 179000 || totalTokens >= 50000 || sludgeNow >= 25000;
+    const sludgeNow = Math.max(clutterTokens, Math.round(reclaimSumK * 1000), Number(raw.metrics?.sludgeTokens || 0));
+    const compactionRelevant = isOverLimit || isNeedsCleanup || isCompactionWorthStall || sludgeNow >= 25000;
     const sessionEditedWs = signals.activeSignal?.sessionHasWorkspaceEdits !== false;
```

---

#### Bug 1.1c: Action Ordering Conflict Between Advanced View (`#actionRowsStack`) and Simple View (`#simpleActionList`) When `task.md` Checkpoint Sync Is Required Before `/compact`
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `2079â€“2103` (DOM order in `#actionRowsStack`) vs. Lines `4780â€“4914` (`#simpleActionList` Tier A1 before Tier B1).
- **Function Name**: `renderState(raw, fromCatalog)`
- **Reproduction Scenario**: `totalTokens = 90000`, `clutterTokens = 30000`, `taskMdTurnsBehind = 4` (or `hasDriftWarn = true`).
- **Root Cause in Code**:
  - In Simple View (`#simpleActionList`, lines `4780â€“4914`), `#checkpoint-sync` ("Update task.md checkpoint before compacting") is rendered first (`topNonTokenRows`), above `#compact-context` ("Compact conversation history (/compact)").
  - In Advanced View (`#actionRowsStack`, lines `2079â€“2102`), `#actionRowCompact` is hardcoded in DOM order **above** `#actionRowCheckpoint` ("Update task.md checkpoint before compacting"), instructing the user to run `/compact` first before reading the row below it telling them to update `task.md` *before* compacting.
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -2078,6 +2078,19 @@
       </div>
       <!-- Tier 2: Priority Action Rows (Google Material 3 Tonal Surface Layering) -->
       <div class="action-rows-stack" id="actionRowsStack">
+        <!-- Action 1 (Pre-requisite when stale/missing): Checkpoint Hygiene (task.md Sync) -->
+        <div class="m3-action-row" id="actionRowCheckpoint" hidden>
+          <div class="m3-action-content">
+            <span class="m3-action-icon dot" id="actionCheckpointDot">&#x25CF;</span>
+            <div class="m3-action-text">
+              <span class="m3-action-title" id="actionCheckpointTitle">Update task.md checkpoint before compacting</span>
+              <span class="m3-action-sub mono" id="actionCheckpointSub">currently 1 turn behind</span>
+            </div>
+            <button type="button" class="mini-btn m3-action-btn" id="btnActionSaveTask" title="Ask Agent to save progress to task.md">Save task.md</button>
+          </div>
+        </div>
+
         <!-- Action 1: /compact instruction (Strictly preserves UI Invariant 1) -->
         <div class="m3-action-row" id="actionRowCompact">
           <div class="compact-instruction" id="compactInstruction">
@@ -2089,18 +2102,6 @@
             <span class="m3-impact-badge amber mono" id="compactImpactBadge">~0k</span>
           </div>
         </div>
-
-        <!-- Action 2: Checkpoint Hygiene (task.md Sync) -->
-        <div class="m3-action-row" id="actionRowCheckpoint" hidden>
-          <div class="m3-action-content">
-            <span class="m3-action-icon dot" id="actionCheckpointDot">&#x25CF;</span>
-            <div class="m3-action-text">
-              <span class="m3-action-title" id="actionCheckpointTitle">Update task.md checkpoint before compacting</span>
-              <span class="m3-action-sub mono" id="actionCheckpointSub">currently 1 turn behind</span>
-            </div>
-            <button type="button" class="mini-btn m3-action-btn" id="btnActionSaveTask" title="Ask Agent to save progress to task.md">Save task.md</button>
-          </div>
-        </div>
```

---

### 1.2 Header/Badge vs. Strip Conflicts

#### Bug 1.2a: Five Divergent "Warm vs. Cold" Predicates Across `#statusDot`, `#prefixLockBadge`, `#quotaStrip`, `#barClutter`/`#lblClutter`, `#playbookList`, `#sessionHealthSummary`, and `buildClientActionQueue`
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**:
  1. `isCacheTrulyWarmInline`: Lines `2346â€“2354` (`ttlRemainingSec > 0 && cacheReadTokens > 0 && hitRatePct > 0 && !prefixBustDetected`).
  2. `isNextTurnLikelyWarmInline`: Lines `2340â€“2343` (`cache.nextTurnLikelyWarm ?? isCacheTrulyWarmInline(cache)`).
  3. `evaluateCompositeSessionRiskInline` (`#statusDot`): Lines `2639, 2652, 2664, 2669` (`const isCacheExpired = ttlSec <= 0;`).
  4. `buildClientActionQueue`: Lines `3187â€“3190` (`cache.hitPercent` â€” **non-existent property**, actual property is `hitRatePct`!).
  5. `#quotaStrip` (`#quotaPills` / `#quotaForecast`): Lines `3404â€“3405, 3429â€“3435, 3454â€“3456` (`hasCacheReadTelemetry = cacheReadTokens > 0 || cHit > 0`, `isWarmWindow = ttlSec > 0 && !q.cache?.isCacheCold`).
  6. `#barClutter` / `#lblClutter` / `#cacheCompactionAdvisory`: Lines `3626â€“3630`, `3817â€“3821` (`win.historyBarState?.state === 'COLD_BLOAT' || !isNextTurnLikelyWarmInline(...) || cacheTtlSec <= 0 || totalTokens > 179000`).
  7. `#playbookList` group header `isWarmEarly`: Line `4132` (`totalTokens < 80000 && !raw.quota?.cache?.prefixBustDetected` â€” ignores `ttlRemainingSec <= 0` and `isCacheCold`!).
  8. `renderSessionHealthSummary` (`#summaryIconQuota` vs `#summaryTextQuota`): Line `4727` uses `isTrulyWarm` for the icon class, while Line `4739` uses `ttlSec > 0 && !q.cache?.isCacheCold` for the text!
- **Reproduction Scenarios**:
  - **Scenario 1 (Cold cache `ttlRemainingSec = 0`, `totalTokens = 60000`, `prefixBustDetected = false`)**:
    - `#quotaStrip` says `Cache: Cold (0s TTL)`, `#barClutter` is Amber `Reclaimable Cold Bloat`, `#cacheCompactionAdvisory` says `Cache expired. Run parameterized compaction now`.
    - Yet `#playbookList` ("Cleared by `/compact`" header, line `4135`) renders green **`Warm Cache (Compaction optional)`** because line `4132` only checks `totalTokens < 80000 && !raw.quota?.cache?.prefixBustDetected`!
  - **Scenario 2 (`ttlRemainingSec = 240`, `cacheReadTokens = 0`, `hitRatePct = 0`, `isCacheCold = false`, `nextTurnLikelyWarm = undefined`)**:
    - `#quotaStrip` (line `3434`) renders `Cache: Warm (240s TTL)` and Simple View `#summaryTextQuota` (line `4741`) renders `Prompt cache is warm (240s TTL).`
    - Yet `#summaryIconQuota` (line `4727`) is Amber `.warn`, `#barClutter` (line `3634`) is Amber `Reclaimable Cold Bloat`, `#lblClutter` (line `3659`) is `Reclaimable` (not `Cached History`), and `#cacheCompactionAdvisory` (line `3829`) says `Cache expired. Run parameterized compaction now before firing next turn.`!
  - **Scenario 3 (`buildClientActionQueue`, line `3189`)**:
    - Checks `Number(cache.hitPercent || 0) > 0` instead of `cache.hitRatePct`. When `cache.hitRatePct = 90` and `cache.cacheReadTokens` is omitted, `isCacheWarm` evaluates to `false` and fails to enqueue `[Distill Handoff Now]`.
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -2649,7 +2649,7 @@
     const isSafeHorizonBreached = totalTokens >= safeHorizon || totalTokens >= 179000 || Boolean(rawState?.amputation?.amputationCrisis || rawState?.telemetry?.amputationRisk);
     // Local quota estimates never escalate to RED.
     const is7dLockoutWithoutOverages = !w7IsEstimate && (w7Used >= 100 || w7Lockout) && !overagesEnabled;
-    const isCacheExpired = ttlSec <= 0;
+    const isCacheExpired = ttlSec <= 0 || Boolean(q.cache?.isCacheCold);
     const isCascadeArmedWithPendingTask = totalTokens > 50000 && hasPendingTaskItems;
     const isTaskMdStale = turnsBehind >= 1;
 
@@ -3186,7 +3186,7 @@
     const cache = raw?.quota?.cache || {};
     const ttlSec = Number(cache.ttlRemainingSec ?? cache.cacheTtlRemainingSec ?? -1);
     const warmTokens = Number(raw?.window?.totalActiveTokens || raw?.metrics?.totalInputTokens || 0);
-    const isCacheWarm = Number(cache.hitPercent || 0) > 0 || Number(cache.cacheReadTokens || 0) > 0;
+    const isCacheWarm = isCacheTrulyWarmInline(cache) || Number(cache.hitRatePct ?? cache.hitPercent ?? 0) > 0 || Number(cache.cacheReadTokens || 0) > 0;
     if (ttlSec > 0 && ttlSec <= 120 && warmTokens >= 50000 && isCacheWarm) {
       items.push({
         id: 'aq-cold-cliff',
@@ -3402,7 +3402,7 @@
         ? ` <span class="ttl-pulse-badge" id="ttlPulseBadge" title="Warm prefix cache expires in ${ttlSec}s! Send your next prompt or compact now before losing warm KV cache state.">&#x23F1; ${ttlSec}s left</span>`
         : '';
       const hasCacheReadTelemetry = (Number(q.cache?.cacheReadTokens || 0) > 0) || (cHit > 0);
-      const isWarmWindow = ttlSec > 0 && !q.cache?.isCacheCold;
+      const isWarmWindow = ttlSec > 0 && !q.cache?.isCacheCold && isNextTurnLikelyWarmInline(q.cache);
       // a known cause (e.g. model switch) gets a plain-language label; unknown keeps the legacy label.
       const legacyBustLabel = '\u26A0\uFE0F Prefix Bust (system_message / config drift)';
       const thrash = q.cache?.routerThrash;
@@ -4129,7 +4129,7 @@
       const group = (cls, title, pill, items, metaLabel = '') => items.length
         ? `<div class="diag-group ${cls}"><div class="group-head"><span class="group-title">${title}</span><span class="group-pill mono"${cls === 'reclaim' ? ' hidden style="display:none !important;"' : ''}>${pill}</span>${metaLabel ? `<span class="group-meta mono">${metaLabel}</span>` : ''}</div>${items.join('')}</div>`
         : '';
-      const isWarmEarly = totalTokens < 80000 && !raw.quota?.cache?.prefixBustDetected;
+      const isWarmEarly = totalTokens < 80000 && !isColdBloat && !raw.quota?.cache?.prefixBustDetected;
       const reclaimCategoryPill = `${reclaimCards.length} ${reclaimCards.length === 1 ? 'category' : 'categories'}`;
       const reclaimMeta = isWarmEarly
         ? `${reclaimCategoryPill} &middot; <span style="color:var(--hz-useful);">Warm Cache (Compaction optional)</span>`
@@ -4723,8 +4723,9 @@
     const standby = q.cache?.standbyCache;
     const preSwitchAdvice = q.cache?.preSwitchCompactionAdvice;
+    const isNextWarm = ttlSec > 0 && !q.cache?.isCacheCold && isNextTurnLikelyWarmInline(q.cache);
 
     if (iconQuota) {
-      iconQuota.className = (isTrulyWarm && !thrash?.detected) ? 'summary-bullet-icon' : 'summary-bullet-icon warn';
+      iconQuota.className = ((isTrulyWarm || isNextWarm) && !thrash?.detected && !w7Lockout && w7 < 80) ? 'summary-bullet-icon' : 'summary-bullet-icon warn';
     }
     if (txtQuota) {
       if (preSwitchAdvice) {
@@ -4736,7 +4737,7 @@
         let cachePart = '';
         if (isTrulyWarm) {
           cachePart = `Prompt cache is warm (${cHit}% hit \u00B7 ${ttlSec}s TTL, 95% token cost discount).`;
-        } else if (ttlSec > 0 && !q.cache?.isCacheCold) {
+        } else if (isNextWarm) {
           const standbyStr = (standby && standby.modelName) ? ` (${standby.modelName} pool warm: ${standby.remainingTtl}s)` : '';
           cachePart = `Prompt cache is warm (${ttlSec}s TTL${standbyStr}).`;
         } else {
```

---

#### Bug 1.2b: Four Conflicting "Synced vs. Stale vs. Missing" (`task.md`) Thresholds Across `#statusDot`, `#artifactDriftBanner`, `#taskSyncBadge`, `#actionRowCheckpoint`, and `#simpleActionList`
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**:
  - `evaluateCompositeSessionRiskInline` (`#statusDot`): Line `2654` (`const isTaskMdStale = turnsBehind >= 1;`).
  - `hasDriftWarn` (`#artifactDriftBanner`): Line `3812` (`(signals.activeSignal?.taskMdTurnsBehind || 0) >= 1 || handoffAudit.artifacts?.taskMd?.exists === false`).
  - `#taskSyncBadge` / `#handoffDot` / `#handoffStatus`: Line `4173` (`const synced = hs.taskMdSaved && behind <= 3;`).
  - `#actionRowCheckpoint` (Advanced View): Lines `4584, 4592` (`!exists || !isSaved || turnsBehind >= 3 || hasDriftWarn`, using `< 3` as synced).
  - `#simpleActionList` (`checkpoint-sync` in Simple View): Lines `4786, 4809` (`!exists || !isSaved || turnsBehind >= 3 || hasDriftWarn`).
- **Function Name**: `evaluateCompositeSessionRiskInline`, `renderState`, `renderSessionHealthSummary`
- **Reproduction Scenarios**:
  1. **Scenario A (`taskMdSaved = true`, `taskMdTurnsBehind = 3`, `dirtyFileCount = 0`, `totalTokens = 65000`)**:
     - `#actionRowCheckpoint` (line `4592`: `turnsBehind >= 3`) and Simple View `#simpleActionList` (line `4809`: `turnsBehind >= 3`) both display **"Update task.md checkpoint before compacting Â· currently 3 turns behind live state"**.
     - Simultaneously, `#taskSyncBadge` inside `#handoffDot` (line `4173`: `behind <= 3`) displays green **`â— task.md synced`**!
  2. **Scenario B (`taskMdSaved = true`, `taskMdTurnsBehind = 2`, `dirtyFileCount = 1`, `totalTokens = 65000`)**:
     - `#statusDot` (line `2654`: `turnsBehind >= 1`) is Amber with tooltip `"task.md is 2 turns stale"`.
     - `#artifactDriftBanner` (line `3812`) is Red saying `"âš ï¸ ... while task.md is stale. Sync task.md before compacting."`
     - `#actionRowCheckpoint` (line `4592`: `hasDriftWarn`) displays `"Update task.md checkpoint before compacting Â· currently 2 turns behind live state"`.
     - Yet `#taskSyncBadge` (line `4173`: `behind <= 3` without checking `!hasDriftWarn`) still displays green **`â— task.md synced`**, and clicking `#btnNewChat` (`Resume in Clean Chat â†—`, line `5303`) bypasses the stale confirmation prompt because `handoffState.synced` is `true`!
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -2651,7 +2651,7 @@
     const is7dLockoutWithoutOverages = !w7IsEstimate && (w7Used >= 100 || w7Lockout) && !overagesEnabled;
     const isCacheExpired = ttlSec <= 0 || Boolean(q.cache?.isCacheCold);
     const isCascadeArmedWithPendingTask = totalTokens > 50000 && hasPendingTaskItems;
-    const isTaskMdStale = turnsBehind >= 1;
+    const isTaskMdStale = turnsBehind >= 3 || (turnsBehind >= 1 && Boolean(signals.handoff?.gitDrift?.dirtyFileCount > 0));
 
     const reasons = [];
@@ -4170,7 +4170,8 @@
     const hs = signals.activeSignal;
     if (hs && typeof hs.taskMdTurnsBehind === 'number') {
       const behind = hs.taskMdTurnsBehind;
-      const synced = hs.taskMdSaved && behind <= 3;
+      const taskExists = signals.handoff?.artifacts?.taskMd?.exists !== false;
+      const synced = Boolean(hs.taskMdSaved && taskExists && behind < 3 && !hasDriftWarn);
       handoffState = { synced, behind, saved: hs.taskMdSaved };
       const txt = synced ? '&#x25CF; task.md synced'
         : (hs.taskMdSaved ? `&#x25CF; task.md stale &bull; ${behind} turn${behind === 1 ? '' : 's'} behind` : '&#x25CF; task.md stale &bull; not saved yet');
```

---

#### Bug 1.2c: Four Divergent "Healthy vs. Cluttered / Near Limit" Predicates Across `#statusDot`, `#statusBadge`, `#actionCard`, and Simple View `#summaryStatusPill`
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**:
  - `#statusBadge` text vs. class: Lines `3767â€“3776` vs. Lines `3865â€“3889`.
  - `#summaryStatusPill` (Simple View): Lines `4668â€“4690`.
- **Function Name**: `renderState(raw, fromCatalog)`, `renderSessionHealthSummary(...)`
- **Reproduction Scenarios**:
  1. **Scenario A (`clutterTokens = 15000`, `totalTokens = 45000`, `safeLimit = 140000`)**:
     - Line `3771` sets `#statusBadge` text to `"15k can be cleared"`.
     - Line `3882` sets `#statusBadge` class to `'badge'` (**green** styling!) because `isOverLimit` and `isNeedsCleanup` are both `false`, while `#actionCard` (line `3887`) says `"âœ“ Memory is clean and focused"`. A green badge saying `"15k can be cleared"` next to `"Memory is clean"` is self-contradictory.
  2. **Scenario B (`totalTokens = 90000`, `clutterTokens = 45000`, `safeLimit = 140000`, `distance = 50000 > 15000`)**:
     - `#statusBadge` is Amber (`.badge.warn`, `"45k can be cleared"`) and `#actionCard` is Amber (`.action-card.warn`).
     - Yet in Simple View, `#summaryStatusPill` (line `4671`) only checks `if (distance > 15000)` and displays green **`Optimal`**, ignoring `isNeedsCleanup` (`clutterTokens >= 25000` / `reminderAt`)!
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3880,7 +3880,7 @@
       compactReclaim.textContent = (guidedBox && guidedBox.dataset.cacheAdvisory === 'lean' ? `Session is lean (${fmtK(totalTokens)} / ${Math.round(totalTokens / (raw.window?.maxTokens || 256000) * 100)}%) \u00B7 No compaction needed until >50k \u00B7 ` : '') + reclaimLine;
     } else {
-      badge.className = 'badge';
+      badge.className = (clutterTokens > 0 || reclaimSumK > 0) ? 'badge warn' : 'badge';
       actionCard.className = 'action-card';
       actionCard.dataset.cleanState = 'nominal-clean';
       actionIcon.textContent = 'âœ“';
@@ -4667,7 +4667,7 @@
     const effortLabel = effortProfile?.shortLabel || 'Safe Limit';
     if (totalTokens < safeLimit) {
       const distance = safeLimit - totalTokens;
-      if (distance > 15000) {
+      if (distance > 15000 && !isNeedsCleanup) {
         if (summaryPill) { summaryPill.className = 'summary-status-pill mono'; summaryPill.textContent = 'Optimal'; }
         if (iconMem) { iconMem.className = 'summary-bullet-icon'; }
         if (txtMem) {
@@ -4675,7 +4675,10 @@
         }
       } else {
-        if (summaryPill) { summaryPill.className = 'summary-status-pill warn mono'; summaryPill.textContent = 'Horizon Near'; }
+        if (summaryPill) {
+          summaryPill.className = 'summary-status-pill warn mono';
+          summaryPill.textContent = distance <= 15000 ? 'Horizon Near' : `${reclaimSumStr} Reclaimable`;
+        }
         if (iconMem) { iconMem.className = 'summary-bullet-icon warn'; }
         if (txtMem) {
-          txtMem.textContent = `Using ${fmtK(totalTokens)} of ${fmtK(maxTokens)} tokens (${usedPct}%) â€” approaching the ${limitK} ${effortLabel} safe limit (${fmtK(distance)} left). Early instructions may soon decay; consider compacting.`;
+          txtMem.textContent = distance <= 15000
+            ? `Using ${fmtK(totalTokens)} of ${fmtK(maxTokens)} tokens (${usedPct}%) â€” approaching the ${limitK} ${effortLabel} safe limit (${fmtK(distance)} left). Early instructions may soon decay; consider compacting.`
+            : `Using ${fmtK(totalTokens)} of ${fmtK(maxTokens)} tokens (${usedPct}%) â€” ${fmtK(distance)} below your ${limitK} ${effortLabel} limit, with ~${reclaimSumStr} of reclaimable history.`;
         }
       }
```

---

### 1.3 Simple vs. Advanced Mode Leaks

#### Bug 1.3a: `#feedbackToast` Is Nested Inside `#actionCard` (Which Has `display: none !important` in Simple Mode), Making All Action Toasts Invisible in Simple Mode
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**:
  - Line `1916â€“1918`: `body[data-view-mode="simple"] .action-card { display: none !important; }`
  - Line `2168`: `<div class="feedback-toast" id="feedbackToast"></div>` (nested inside `<section class="action-card" id="actionCard">`, lines `2063â€“2169`).
  - Line `2374â€“2378`: `showToast(html)` writes to `#feedbackToast`.
  - Callers of `showToast()` invoked while in Simple Mode:
    - `registerDampeningHook` (lines `2460, 2475, 2478` via Simple View `data-simple-act="dampen-hook"` at line `5190`)
    - `promoteRuleDirect` (lines `2507, 2513, 2517` via Simple View `data-simple-act="promote-rule"` at line `5181`)
    - `runPrompt` (lines `2597, 2606` via Simple View `data-simple-act="checkpoint"` -> `#btnCheckpoint.click()` at line `5178`)
    - `btnCondenseAst.onclick` (lines `5356, 5358, 5361` via Simple View `data-simple-act="condense-ast"` -> `#btnCondenseAst.click()` at line `5184`)
    - `btnReapOrphans.onclick` (lines `5374, 5391, 5394` in `#hostWatchdogBar`)
    - `btnOpenChat.onclick` (lines `5435, 5440, 5443, 5448, 5450` in `.session-bar`)
- **Function Name**: `showToast`, `renderSessionHealthSummary`, `registerDampeningHook`, `promoteRuleDirect`
- **Reproduction Scenario**: In default Simple Mode (`data-view-mode="simple"`), click `ðŸŽ¯ Auto-Add Rule to AGENTS.md`, `âœ‚ï¸ Condense Now`, `ðŸ›¡ï¸ Register PreToolUse Hook`, `Open â†—`, or `Clean up orphansâ€¦`.
- **Root Cause in Code**: `#feedbackToast` is a child of `#actionCard`. Because `#actionCard` is hidden via `display: none !important` in Simple Mode, `#feedbackToast` is never rendered on screen in Simple Mode. Furthermore, `data-simple-act="condense-ast"` (line `5184`) delegates to `document.getElementById('btnCondenseAst')?.click()` (which is hidden inside `#secondaryDrawer`), so `flashButton(btnCondense, ...)` flashes the hidden button instead of the clicked Simple View button!
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -2165,9 +2165,9 @@
       </div>
     </div>
-
-    <div class="feedback-toast" id="feedbackToast"></div>
   </section>
 
+  <div class="feedback-toast" id="feedbackToast"></div>
+
   <!-- Tier 3A (Upper Box): User-Friendly Session Health Summary (Information Only â€” Fixed 3 Bullets) -->
```

---

#### Bug 1.3b: Simple Mode CSS Hides `#quotaOverageAlert` (`display: none !important`), Causing `#quotaLockoutPill` Removal Logic to Hide BOTH Lockout Warnings in Simple Mode
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `1919â€“1924` (CSS) and Lines `3517â€“3521` (`renderState`).
- **Function Name**: `renderState(raw, fromCatalog)`
- **Reproduction Scenario**: In Simple Mode (`data-view-mode="simple"`), `weekly7d.usedPct = 100` (or `lockoutRisk = true` with `overageAlert.state !== 'NONE'`).
- **Root Cause in Code**:
  - Lines `3497` / `3502` set `quotaOverageAlert.hidden = false`.
  - Lines `3518â€“3521` check `if (!quotaOverageAlert.hidden) { const lockPill = document.getElementById('quotaLockoutPill'); if (lockPill) lockPill.remove(); }` assuming `#quotaOverageAlert` is visible to the user.
  - However, lines `1919â€“1924` hide `#quotaOverageAlert` via CSS (`body[data-view-mode="simple"] #quotaOverageAlert { display: none !important; }`)! Because the DOM `.hidden` property is `false` while CSS hides the element, `#quotaLockoutPill` is removed AND `#quotaOverageAlert` is hidden by CSS â€” leaving the user in Simple Mode with neither pill nor banner in `#quotaStrip`!
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3515,7 +3515,8 @@
           quotaOverageAlert.textContent = '';
         }
         // the overage banner already says it; don't also show the 7d Lockout pill.
-        if (!quotaOverageAlert.hidden) {
+        const isSimpleView = document.body.getAttribute('data-view-mode') === 'simple';
+        if (!quotaOverageAlert.hidden && !isSimpleView) {
           const lockPill = document.getElementById('quotaLockoutPill');
           if (lockPill) lockPill.remove();
         }
```

---



---

### Bug Class 2: False-Positive Heuristics on Edge-Case Sessions

﻿# Forensic Audit Report: `src/core/*.mjs` (Bug Classes 2 & 5)

Below is the exhaustive line-by-line forensic audit of `src/core/*.mjs` in `c:\Projects\ga-visualizer-v2`, covering every instance of **Class 2 (False-Positive Heuristics on Edge-Case Sessions)** and **Class 5 (Mathematical, Unit-Scope & Rounding Drift)** with exact file paths, line numbers, function names, reproduction scenarios across the 4 boundary session profiles, root causes, and drop-in replacement diffs.

---

## Part 1 â€” Class 2: False-Positive Heuristics on Edge-Case Sessions

### 1.1 Premature Alarms & Unscoped Workspace Blame

#### Issue C2-01: `calculateParabolicAttentionCurve` & `rankRiskiestCells` Flag the Final Recency Cells (Cells #7â€“#15) of Small Chats (`activeCellCount` 7..22) as Low-Attention Trough
- **File**: `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs`
- **Lines**: `95â€“99` (`calculateParabolicAttentionCurve`) and `222` (`rankRiskiestCells`)
- **Functions**: `calculateParabolicAttentionCurve(cellIndex, activeCellCount, gamma)`, `rankRiskiestCells(cells, options)`
- **Boundary Profile Affected**: **Profile 1 / Early-to-Mid Sessions** (e.g., a 7- to 16-cell session, ~44.8kâ€“102k tokens, or `rankRiskiestCells` called on a 7-cell chat).
- **Reproduction Scenario**:
  1. A session has `activeCellCount = 8` (Cells `0..7`, ~51k tokens). Cell `#7` (`cellIndex = 6`) and Cell `#8` (`cellIndex = 7`, the **very last/most recent turn** of the chat, where `ratio = 7/7 = 1.0` and `uShapedWeight = 1.00`) are evaluated.
  2. In `calculateParabolicAttentionCurve` (line 98):
     `const inCanonicalCellTrough = activeCellCount >= 7 && cellIndex >= 6 && cellIndex <= 15 && cellIndex < activeCellCount;`
     Because `6 <= cellIndex <= 15`, **Cell #7 and Cell #8 (the final Recency cell of the 8-cell chat!)** have `inCanonicalCellTrough = true`, forcing `inTrough = true` and `zone = 'LOW_ATTENTION_TROUGH'` even though `ratio = 1.0` (100% Recency edge!).
  3. Furthermore, in `rankRiskiestCells` (line 222):
     `const inTrough = Boolean(c.inAttentionTrough || (c.index >= 6 && c.index <= 15));`
     This hardcodes `c.index >= 6 && c.index <= 15` **without even checking `meetsTokenFloor` (`totalActiveTokens >= 44800`) or `activeCellCount`**, so even if `c.inAttentionTrough` was `false` (or in unit calls / small cell arrays), any cell at index `6..15` is flagged as `inTrough = true` and triggers `TROUGH_STRANDED_SPEC` in `action_queue.mjs` (`aq-trough-spec`).
- **Root Cause**:
  `inCanonicalCellTrough` (`cellIndex >= 6 && cellIndex <= 15`) assumes a full 40-cell (or >=23-cell) window where indices `6..15` lie in the middle `[0.30, 0.70]` band. When `activeCellCount` is `7..22`, indices `6..15` overlap the **Recency zone (`ratio > 0.70`, including the final cell `cellIndex === activeCellCount - 1`)**. And `rankRiskiestCells` bypasses `c.inAttentionTrough === false` via the fallback `|| (c.index >= 6 && c.index <= 15)`.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -95,7 +95,9 @@ export function calculateParabolicAttentionCurve(cellIndex, activeCellCount, gam
   const inRatioTrough = activeCellCount >= 7 &&
     ratio >= ATTENTION_TROUGH_CONFIG.TROUGH_START_RATIO &&
     ratio <= ATTENTION_TROUGH_CONFIG.TROUGH_END_RATIO;
-  const inCanonicalCellTrough = activeCellCount >= 7 && cellIndex >= 6 && cellIndex <= 15 && cellIndex < activeCellCount;
+  const inCanonicalCellTrough = activeCellCount >= 23 &&
+    cellIndex >= ATTENTION_TROUGH_CONFIG.CANONICAL_TROUGH_START_CELL &&
+    cellIndex <= ATTENTION_TROUGH_CONFIG.CANONICAL_TROUGH_END_CELL &&
+    ratio <= ATTENTION_TROUGH_CONFIG.TROUGH_END_RATIO;
   const inTrough = inRatioTrough || inCanonicalCellTrough;
 
   let zone = 'LOW_ATTENTION_TROUGH';
@@ -219,7 +221,9 @@ export function rankRiskiestCells(cells = [], { totalActiveTokens = 0, safeLimit
 
     const target = String(c.topTarget || c.primaryPath || `Cell #${(c.index ?? 0) + 1}`);
     const isCriticalSpec = /task\.md|implementation_plan\.md|agents\.md|context\.md|state\.md/i.test(target);
-    const inTrough = Boolean(c.inAttentionTrough || (c.index >= 6 && c.index <= 15));
+    const inTrough = typeof c.inAttentionTrough === 'boolean'
+      ? c.inAttentionTrough
+      : Boolean(totalActiveTokens >= 44800 && c.index >= 6 && c.index <= 15);
     const isStrandedSpec = (Boolean(c.isStrandedSignal) || inTrough) && (isCriticalSpec || c.dominantCategory === CATEGORIES.ANCHOR || c.dominantCategory === CATEGORIES.ACTIVE_WORKING_SET);
```

---

#### Issue C2-02: `evaluateLoopAndGitGuard` in `blindspot_sensors.mjs` Runs Unscoped Repo-Wide `git status --porcelain` and Blames Read-Only / 0-Edit Sessions
- **File**: `c:\Projects\ga-visualizer-v2\src\core\blindspot_sensors.mjs`
- **Lines**: `283â€“332`
- **Function**: `evaluateLoopAndGitGuard(stepEvents, sidecarState, workspacePath, config)`
- **Boundary Profile Affected**: **Profile 1 (Brand-new / Lean 0-edit sessions)** & read-only audit sessions in a dirty git repo.
- **Reproduction Scenario**:
  1. User opens a read-only chat (0 file writes) in a workspace that already has 4 uncommitted files from prior work.
  2. `sidecarState.sessionMeta.turnsSinceLastPassingTest` is `>= 3` (e.g., 4 turns of reading files without running a test suite).
  3. `evaluateLoopAndGitGuard` runs `git status --porcelain` across the entire repo, counts `dirtyGitFileCount = 4 >= fileLimit`, and sets `uncheckpointedGitDrift = true`, blaming the 0-edit session for uncommitted repo files.
  4. Additionally, line 332 returns `{ threeStrikeLoop, uncheckpointedGitDrift, dirtyGitFileCount }` â€” **omitting `loopFingerprint`** on the uncached return path (whereas lines 288 and 295 include `loopFingerprint`).
- **Root Cause**:
  1. Never checks whether the current session actually modified any workspace files (`edit_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `write_file`).
  2. Does not intersect `git status --porcelain` paths with files written by `stepEvents` in this session.
  3. Missing `loopFingerprint` property on line 332 return object.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/blindspot_sensors.mjs
+++ b/src/core/blindspot_sensors.mjs
@@ -283,8 +283,16 @@ export function evaluateLoopAndGitGuard(stepEvents = [], sidecarState = {}, work
   const turnsSincePassing = sidecarState.sessionMeta?.turnsSinceLastPassingTest || 0;
   const fileLimit = config.uncheckpointed_dirty_file_limit || 4;
 
+  const editTools = new Set(['write_to_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file']);
+  const sessionEditedPaths = new Set();
+  for (const ev of stepEvents) {
+    if (ev?.targetPath && (editTools.has(String(ev.toolName || '').toLowerCase()) || ev.type === 'FILE_WRITE')) {
+      sessionEditedPaths.add(canonicalizePath(ev.targetPath));
+    }
+  }
+  const sessionHasEdits = sessionEditedPaths.size > 0 || Boolean(sidecarState.brainSignals?.activeSignal?.sessionHasWorkspaceEdits);
+
   // If passing tests are recent (<3 turns) or session made 0 workspace edits, git drift is false by definition
-  if (turnsSincePassing < 3 || !workspacePath) {
+  if (turnsSincePassing < 3 || !workspacePath || !sessionHasEdits) {
     return { threeStrikeLoop, loopFingerprint, uncheckpointedGitDrift: false, dirtyGitFileCount: 0 };
   }
 
@@ -312,7 +320,16 @@ export function evaluateLoopAndGitGuard(stepEvents = [], sidecarState = {}, work
         stdio: ['ignore', 'pipe', 'ignore']
       });
       const lines = stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
-      dirtyGitFileCount = lines.length;
+      if (sessionEditedPaths.size > 0) {
+        const matched = lines.filter(rawLine => {
+          const rel = rawLine.slice(3).trim().replace(/^"(.*)"$/, '$1');
+          const abs = canonicalizePath(path.isAbsolute(rel) ? rel : path.join(workspacePath, rel));
+          return sessionEditedPaths.has(abs);
+        });
+        dirtyGitFileCount = matched.length;
+      } else {
+        dirtyGitFileCount = lines.length;
+      }
 
       if (dirtyGitFileCount >= fileLimit && turnsSincePassing >= 3) {
         uncheckpointedGitDrift = true;
@@ -329,7 +346,7 @@ export function evaluateLoopAndGitGuard(stepEvents = [], sidecarState = {}, work
     workspace: workspacePath
   };
 
-  return { threeStrikeLoop, uncheckpointedGitDrift, dirtyGitFileCount };
+  return { threeStrikeLoop, loopFingerprint, uncheckpointedGitDrift, dirtyGitFileCount };
 }
```

---

#### Issue C2-03: `auditHandoff` & `checkBrainArtifactsAndGitDrift` in `handoff_audit.mjs` Blame 0-Edit / Brand-New Sessions for Stale `task.md` & Unscoped Git Drift
- **File**: `c:\Projects\ga-visualizer-v2\src\core\handoff_audit.mjs`
- **Lines**: `47â€“57`, `150â€“157`, `223â€“255`
- **Functions**: `auditHandoff`, `checkBrainArtifactsAndGitDrift`
- **Boundary Profile Affected**: **Profile 1 (`< 25k` tokens, `< 10` turns, `0` file writes)**.
- **Reproduction Scenario**:
  1. **Direct `checkBrainArtifactsAndGitDrift` / `auditHandoff` call without `options.sessionWrittenPaths`**:
     In `checkBrainArtifactsAndGitDrift` (lines 230â€“232):
     `const sessionEditedWorkspace = sessionSignals?.sessionHasWorkspaceEdits !== false && sessionSignals?.activeSignal?.sessionHasWorkspaceEdits !== false;`
     Because `undefined !== false` evaluates to `true`, any caller that omits `sessionHasWorkspaceEdits` (or passes `{ totalActiveTokens: 60000 }`) defaults `sessionEditedWorkspace` to `true` and `hasSessionScope` to `false`, causing repo-wide `dirtyFiles` to trigger `preCompactionWarning = true` on a 0-edit session!
  2. **False-positive `state_freshness` failure on 0-edit / read-only sessions** (lines 150â€“157):
     In `classifier.mjs` (line 1068): `const taskTurnsBehind = steps.slice(lastTaskWrite + 1).filter(isUserTurn).length;`
     When a user has a 3-turn read-only Q&A session (`0` file writes, `lastTaskWrite === -1`), `taskTurnsBehind` is `3`.
     If `task.md` exists in the workspace or brain dir, `auditHandoff` (line 152) checks `if (turnsBehind > 2)` and fails `state_freshness` (`result: 'NEEDS_FIXES'`, `"task.md is 3 user turns stale"`), and `evaluateCompositeSessionRisk` (`classifier.mjs:307, 320`) escalates the entire session risk band from `GREEN` to `AMBER` (`isTaskMdStale = Number(taskMdTurnsBehind) >= 1`) even on a 1-turn, 2k-token, 0-edit chat where `lastTaskWrite === -1`!
- **Root Cause**:
  1. `handoff_audit.mjs:230`: `!== false` defaults to `true` when `sessionHasWorkspaceEdits` is `undefined`, instead of requiring explicit truthy `Boolean(...)` when `sessionWrittenPaths` is empty/absent.
  2. `classifier.mjs:307` and `classifier.mjs:1068`: `taskTurnsBehind` counts user turns even when `lastTaskWrite === -1` and `!sessionHasWorkspaceEdits` (a read-only/Q&A session that never used `task.md` or edited files), causing `evaluateCompositeSessionRisk` (`classifier.mjs:307`) to mark every 1-turn read-only session `AMBER` (`task.md is 1 turn stale`)!
  3. `handoff_audit.mjs:151`: `turnsBehind > 2` fails `state_freshness` even on 0-edit sessions (`sessionHasWorkspaceEdits === false`).
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/handoff_audit.mjs
+++ b/src/core/handoff_audit.mjs
@@ -148,8 +148,12 @@ export function auditHandoff(brainDirOrPath = '', sessionSignals = {}, options =
   }
 
   // 5. Freshness: task.md turns behind
+  const sessionEdited = Boolean(
+    sessionSignals?.sessionHasWorkspaceEdits ??
+    sessionSignals?.activeSignal?.sessionHasWorkspaceEdits ??
+    (Array.isArray(options.sessionWrittenPaths) && options.sessionWrittenPaths.length > 0)
+  );
   const turnsBehind = sessionSignals?.activeSignal?.taskMdTurnsBehind ?? 0;
-  if (turnsBehind > 2) {
+  if (turnsBehind > 2 && sessionEdited) {
     checks.push({ id: 'state_freshness', name: 'State Freshness', pass: false, detail: `task.md is ${turnsBehind} user turns stale` });
     fixes.push('Update task.md with latest turn accomplishments');
   } else {
@@ -227,9 +231,11 @@ export function checkBrainArtifactsAndGitDrift(brainDir = null, workspacePath =
     totalActiveTokens: sessionSignals?.totalActiveTokens ?? 0,
     sludgeTokens: sessionSignals?.sludgeTokens ?? 0
   });
+  const explicitEditFlag = sessionSignals?.sessionHasWorkspaceEdits ?? sessionSignals?.activeSignal?.sessionHasWorkspaceEdits;
   const sessionEditedWorkspace =
-    sessionSignals?.sessionHasWorkspaceEdits !== false &&
-    sessionSignals?.activeSignal?.sessionHasWorkspaceEdits !== false;
+    explicitEditFlag !== undefined
+      ? Boolean(explicitEditFlag)
+      : (hasSessionScope ? sessionDirtyFiles.length > 0 : true);
   const preCompactionWarning = hasDirtyGit && sessionEditedWorkspace && isTaskMdStale && compactionRelevant;
```

And in `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs` (lines `307` and `1068â€“1075`):
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -287,6 +287,7 @@ export function evaluateCompositeSessionRisk({
   cacheReadTokens = 0,
   cacheHitRatePct = 0,
   taskMdTurnsBehind = 0,
+  sessionHasWorkspaceEdits = true,
   hasPendingTaskItems = false,
   weekly7dUsedPct = 0,
   weekly7dLockoutRisk = false,
@@ -304,7 +305,7 @@ export function evaluateCompositeSessionRisk({
     (weekly7dUsedPct >= 100 || Boolean(weekly7dLockoutRisk)) && !aiCreditOveragesEnabled;
   const isCacheExpired = Number(cacheTtlRemainingSec) <= 0;
   const isCascadeArmedWithPendingTask = totalActiveTokens > SESSION_RISK_THRESHOLDS.CASCADE_SYNC_WATERMARK_TOKENS && Boolean(hasPendingTaskItems);
-  const isTaskMdStale = Number(taskMdTurnsBehind) >= 1;
+  const isTaskMdStale = Boolean(sessionHasWorkspaceEdits) && Number(taskMdTurnsBehind) >= 1;
```
```diff
@@ -1065,13 +1066,16 @@ export function classifyHorizon(rawSteps, options = {}) {
       if (/task\.md/i.test(p)) lastTaskWritePath = p;
     }
   });
-  const taskTurnsBehind = steps.slice(lastTaskWrite + 1).filter(isUserTurn).length;
   const isWorkspaceFileWrite = x => (x.toolCalls || []).some(c => {
     if (!/write|edit|replace|create/i.test(c.name || '')) return false;
     const p = String(c.args?.Path || c.args?.path || c.args?.TargetFile || c.args?.AbsolutePath || '');
     return Boolean(p) && !isInternalTelemetryPath(p);
   });
   const sessionHasWorkspaceEdits = steps.some(isWorkspaceFileWrite);
+  const rawTaskTurnsBehind = steps.slice(lastTaskWrite + 1).filter(isUserTurn).length;
+  const taskTurnsBehind = (lastTaskWrite >= 0 || sessionHasWorkspaceEdits)
+    ? rawTaskTurnsBehind
+    : 0;
```
(And pass `sessionHasWorkspaceEdits` into `evaluateCompositeSessionRisk` at line 1219 of `classifier.mjs`.)

---

#### Issue C2-04: `gradeProofQuality` in `session_forensics.mjs` Grades Brand-New / In-Progress / 0-Edit Sessions as `'None'` ("Completion stated verbally without tool execution proof")
- **File**: `c:\Projects\ga-visualizer-v2\src\core\session_forensics.mjs`
- **Lines**: `81â€“172`
- **Function**: `gradeProofQuality(steps)`
- **Boundary Profile Affected**: **Profile 1 (Brand-new / Lean sessions, `< 10` turns, `0` file writes)** and **Profile 3 (Post-compaction sessions)**.
- **Reproduction Scenario**:
  1. A brand-new session has 2 turns: User asks a question, Agent answers or reads 1 file (no completion claim made, no edits made).
  2. In `gradeProofQuality` (lines 100â€“103):
     ```js
     // If no explicit completion claim was found, check the final turn
     if (claimStepIndex === -1) {
       claimStepIndex = steps.length - 1;
     }
     ```
  3. Because the agent neither edited files nor ran `run_command`, `gradeProofQuality` falls through to lines 167â€“171:
     `return { grade: 'None', reason: 'Completion stated verbally without tool execution proof', claimStepIndex };`
  4. Since `config.mjs:28` has `proof_quality_warn_on: ['None']`, any brand-new or read-only session is falsely accused of *"Completion stated verbally without tool execution proof"* even though completion was **never claimed** and no files were edited!
- **Root Cause**:
  When `claimStepIndex === -1` (no completion claim was made) and the session has 0 file edits (`!hasFileEdits`), the session is either in-progress or read-only/advisory â€” not an unverified completion claim.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/session_forensics.mjs
+++ b/src/core/session_forensics.mjs
@@ -97,10 +97,12 @@ export function gradeProofQuality(steps = []) {
     }
   }
 
+  const explicitClaimFound = claimStepIndex !== -1;
   // If no explicit completion claim was found, check the final turn
   if (claimStepIndex === -1) {
     claimStepIndex = steps.length - 1;
   }
@@ -164,6 +166,14 @@ export function gradeProofQuality(steps = []) {
     };
   }
 
+  if (!explicitClaimFound) {
+    return {
+      grade: 'Pending',
+      reason: 'Session in progress or read-only (no completion claim or file edits yet)',
+      claimStepIndex: -1
+    };
+  }
+
   return {
     grade: 'None',
     reason: 'Completion stated verbally without tool execution proof',
```

---

#### Issue C2-05: `detectDirtySnapshots` in `blindspot_sensors.mjs` Fires False-Positive `DIRTY_SNAP` on Missing/Zero `timestampMs` (Log-Tier Degraded Sessions)
- **File**: `c:\Projects\ga-visualizer-v2\src\core\blindspot_sensors.mjs`
- **Lines**: `19â€“37`
- **Function**: `detectDirtySnapshots(stepEvents, workspacePath)`
- **Boundary Profile Affected**: **Profile 2 (Log-tier degraded sessions where ISO timestamps / `timestampMs` are missing or `0`)**.
- **Reproduction Scenario**:
  1. In a log-tier degraded session (Tier 3/4 or timestamp-less transcript), `ev.timestampMs` is `0`, `undefined`, or `NaN`.
  2. Line 23: `lastTouchMap.set(canonical, Math.max(prev, ev.timestampMs));`
     - If `ev.timestampMs` is `undefined`, `Math.max(0, undefined)` evaluates to `NaN`!
     - If `ev.timestampMs` is `0`, `lastTouchMs` is `0`.
  3. Line 32: `if (stat.mtimeMs > lastTouchMs + 500)`:
     - When `lastTouchMs === 0`, **every single file on disk** has `stat.mtimeMs > 500` (since 1970) and is falsely flagged in `dirtySnapshotPaths`!
- **Root Cause**:
  Missing guard `Number.isFinite(ev.timestampMs) && ev.timestampMs > 0` before recording `lastTouchMs`.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/blindspot_sensors.mjs
+++ b/src/core/blindspot_sensors.mjs
@@ -20,9 +20,12 @@ export function detectDirtySnapshots(stepEvents = [], workspacePath = '') {
   for (const ev of stepEvents) {
     if (ev.targetPath && (fileTools.has(ev.toolName) || ev.type === 'FILE_ACCESS')) {
+      const ts = Number(ev.timestampMs || (ev.createdAt ? Date.parse(ev.createdAt) : 0));
+      if (!Number.isFinite(ts) || ts <= 0) continue;
       const canonical = canonicalizePath(ev.targetPath);
       const prev = lastTouchMap.get(canonical) || 0;
-      lastTouchMap.set(canonical, Math.max(prev, ev.timestampMs));
+      lastTouchMap.set(canonical, Math.max(prev, ts));
     }
   }
 
   const dirtySnapshotPaths = [];
   for (const [filePath, lastTouchMs] of lastTouchMap.entries()) {
+    if (!Number.isFinite(lastTouchMs) || lastTouchMs <= 0) continue;
     try {
```

---

#### Issue C2-06: `detectContextRot` in `session_forensics.mjs` Uses `s.created_at` (Snake Case) Instead of `s.createdAt` (Camel Case from `parser.mjs`), Triggering Synthetic Duration Fallback on All Parsed Sessions
- **File**: `c:\Projects\ga-visualizer-v2\src\core\session_forensics.mjs`
- **Lines**: `188â€“210`
- **Function**: `detectContextRot(steps, state, config)`
- **Boundary Profile Affected**: **Profile 1, Profile 2 (Log-tier degraded), and Profile 4 (Idle historical sessions)**.
- **Reproduction Scenario**:
  1. `parser.mjs:364` normalizes step timestamps into `createdAt` (camelCase), NOT `created_at`.
  2. In `detectContextRot` (line 189): `if (s.created_at)` â€” because `s.created_at` is `undefined` on all steps produced by `parseRawJsonl`, `firstTs` and `lastTs` are ALWAYS `null`!
  3. Line 198â€“200 falls back to `Math.round(steps.length * 1.5)`. Conversely, in **Profile 2 (Log-tier degraded sessions without timestamps)**, a fast 30-step burst session (which actually took 2 minutes) is synthesized as `30 * 1.5 = 45 minutes` (`>= splitMinutesThreshold`), triggering a false `splitRecommended = true`!
  4. Additionally, on line 207: `const isErr = s => s.status === 'ERROR' || (s.exitCode !== undefined && s.exitCode !== 0);` â€” if `s.exitCode === null` (which `blindspot_sensors.mjs:273` uses for non-command steps!), `null !== undefined && null !== 0` is **`true`**, marking every step with `exitCode: null` as an error!
- **Root Cause**:
  1. Only checks `s.created_at` instead of `s.createdAt || s.created_at || s.timestamp`.
  2. When timestamps are genuinely absent (Profile 2 degraded logs), duration cannot be proven `>= 45m`, violating the ground rule *"Duration alone never triggers split; requires evidence"*.
  3. `s.exitCode !== undefined && s.exitCode !== 0` treats `exitCode: null` as a non-zero error exit code.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/session_forensics.mjs
+++ b/src/core/session_forensics.mjs
@@ -186,8 +186,9 @@ export function detectContextRot(steps = [], state = {}, config = {}) {
   let firstTs = null;
   let lastTs = null;
   for (const s of steps) {
-    if (s.created_at) {
-      const t = new Date(s.created_at).getTime();
+    const rawTs = s?.createdAt || s?.created_at || s?.timestamp;
+    if (rawTs) {
+      const t = new Date(rawTs).getTime();
       if (!isNaN(t)) {
         if (!firstTs || t < firstTs) firstTs = t;
         if (!lastTs || t > lastTs) lastTs = t;
@@ -195,16 +196,17 @@ export function detectContextRot(steps = [], state = {}, config = {}) {
     }
   }
 
+  const hasRealTimestamps = Boolean(firstTs && lastTs && lastTs >= firstTs);
   const elapsedMinutes = (firstTs && lastTs && lastTs > firstTs)
     ? Math.round((lastTs - firstTs) / (1000 * 60))
-    : Math.round(steps.length * 1.5); // Fallback: ~1.5 min per step
+    : (hasRealTimestamps ? 0 : Math.round(steps.length * 1.5));
 
   // Compare error rate: first third vs last third
   const third = Math.max(2, Math.floor(steps.length / 3));
   const initialSteps = steps.slice(0, third);
   const finalSteps = steps.slice(-third);
 
-  const isErr = s => s.status === 'ERROR' || (s.exitCode !== undefined && s.exitCode !== 0);
+  const isErr = s => s.status === 'ERROR' || (typeof s.exitCode === 'number' && s.exitCode !== 0);
   const errInitial = initialSteps.filter(isErr).length / initialSteps.length;
   const errFinal = finalSteps.filter(isErr).length / finalSteps.length;
```
(Note: Also in `fingerprintErrorLoop` at `session_forensics.mjs:242`, `s.exitCode !== undefined && s.exitCode !== 0` has the same `exitCode: null` bug and should be `(typeof s.exitCode === 'number' && s.exitCode !== 0)`.)

---

### 1.2 Missing Prior-State Guards (Cache Warmth, Degraded Logs, Post-Compaction, Idle Sessions)

#### Issue C2-07: `computeQuotaAndCacheTelemetry` in `quota.mjs` Synthesizes Fake Warm Cache Hits (`cacheHitRatePct = 88%` and Inferred `sessionCacheReadTokens`) on Log-Tier Degraded Sessions
- **File**: `c:\Projects\ga-visualizer-v2\src\core\quota.mjs`
- **Lines**: `538â€“540`, `566â€“579`, `590`, `607â€“610`, `771â€“780`, `849â€“854`
- **Function**: `computeQuotaAndCacheTelemetry(steps, options)`
- **Boundary Profile Affected**: **Profile 2 (Log-tier degraded sessions where `cache_read_input_tokens` or ISO timestamps are missing/zero)** and **Profile 4 (Idle / Cold historical sessions)**.
- **Reproduction Scenario**:
  1. **Scenario A (Degraded log without `cache_read_input_tokens` or `input_tokens`)**:
     In `quota.mjs` lines 566â€“578:
     ```js
     } else if (s.type === 'PLANNER_RESPONSE' && i > 0) {
       // Infer prefix cache read vs write when JSONL lacks explicit usage counters
       const effectiveGapSec = gapSec !== null ? gapSec : 30;
       if (effectiveGapSec <= QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
         sessionCacheReadTokens += Math.max(0, cumContextEst - stepTok);
         sessionCacheCreationTokens += stepTok;
         lastTurnCacheRead = Math.max(0, cumContextEst - stepTok);
         lastTurnCacheCreation = stepTok;
     ```
     When a Tier 3/4 degraded transcript has neither `cacheReadTokens` nor `createdAt` timestamps (`gapSec === null`), `effectiveGapSec` is hardcoded to `30` seconds! Every `PLANNER_RESPONSE` step fabricates `sessionCacheReadTokens` and `lastTurnCacheRead > 0`!
  2. **Scenario B (1-step or 2-step degraded log with `totalPromptTokens === 0`)**:
     In `quota.mjs` lines 608â€“610:
     ```js
     const cacheHitRatePct = totalPromptTokens > 0
       ? Math.min(100, Math.round((sessionCacheReadTokens / totalPromptTokens) * 100))
       : (steps.length > 1 ? 88 : 0);
     ```
     Even when `sessionCacheReadTokens === 0`, if `steps.length > 1` and `totalPromptTokens === 0`, it fabricates `cacheHitRatePct = 88`!
  3. **Scenario C (Missing ISO timestamps on all steps: `latestStepTimestampMs === 0`)**:
     In `quota.mjs` lines 771â€“777:
     ```js
     const idleSeconds = latestStepTimestampMs > 0
       ? Math.max(0, Math.round((nowMs - latestStepTimestampMs) / 1000))
       : 0;
     const cacheTtlRemainingSec = latestStepTimestampMs > 0
       ? Math.max(0, QUOTA_CONSTANTS.CACHE_TTL_SECONDS - idleSeconds)
       : QUOTA_CONSTANTS.CACHE_TTL_SECONDS;
     const isCacheCold = latestStepTimestampMs > 0 && cacheTtlRemainingSec === 0;
     ```
     Combined with Scenario A (`sessionCacheReadTokens > 0` fabricated via `effectiveGapSec = 30`), a timestamp-less historical log has `latestStepTimestampMs === 0`, `cacheTtlRemainingSec = 300`, `isCacheCold = false`, `cacheReadTokens > 0`, `hitRatePct > 0`, so `computeIsCacheTrulyWarm` (`classifier.mjs:366`) returns **`true`** on a degraded log that has zero timestamps and zero `cache_read_input_tokens`!
  4. **Scenario D (`turn.timestampMs` fallback to `nowMs` on line 590)**:
     Line 590 sets `timestampMs: currTs || nowMs`. In `trackModelCachePools` (lines 289â€“294), `nowMs - pool.lastSeenTimestampMs` is `0`, so every model pool in a timestamp-less log is marked `remainingTtl: 300, isWarm: true`!
- **Root Cause**:
  1. Lines 566â€“578 fabricate `sessionCacheReadTokens` when `gapSec === null` (missing timestamps) or when the log never reported any real cache tokens.
  2. Line 610 fabricates `88%` hit rate when `totalPromptTokens === 0`.
  3. When `sessionCacheReadTokens === 0 && sessionCacheCreationTokens === 0` (the session never established a warm cache), `evaluateColdSessionCostGate` (`quota.mjs:849â€“854` and `1199â€“1261`) still fires `KEEPWARM_WARNING` (`ttlSec <= 120`) or `COLD_COST_GATE` (`ttlSec === 0`) on a session that **never had a warm cache** (e.g., a log-tier degraded session or a 1-turn uncached session)!
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/quota.mjs
+++ b/src/core/quota.mjs
@@ -563,7 +563,7 @@ export function computeQuotaAndCacheTelemetry(steps = [], {
         stepPrefixBustDetected = false;
         stepPrefixBustCause = null;
       }
-    } else if (s.type === 'PLANNER_RESPONSE' && i > 0) {
-      // Infer prefix cache read vs write when JSONL lacks explicit usage counters
-      const effectiveGapSec = gapSec !== null ? gapSec : 30;
-      if (effectiveGapSec <= QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
+    } else if (s.type === 'PLANNER_RESPONSE' && i > 0 && gapSec !== null) {
+      // Only infer prefix cache read when real step timestamps exist and prove <300s turnaround
+      if (gapSec <= QUOTA_CONSTANTS.CACHE_TTL_SECONDS) {
         sessionCacheReadTokens += Math.max(0, cumContextEst - stepTok);
         sessionCacheCreationTokens += stepTok;
         lastTurnCacheRead = Math.max(0, cumContextEst - stepTok);
@@ -607,7 +607,7 @@ export function computeQuotaAndCacheTelemetry(steps = [], {
   const totalPromptTokens = sessionCacheReadTokens + sessionCacheCreationTokens + sessionInputTokens;
   const cacheHitRatePct = totalPromptTokens > 0
     ? Math.min(100, Math.round((sessionCacheReadTokens / totalPromptTokens) * 100))
-    : (steps.length > 1 ? 88 : 0);
+    : 0;
```
And in `evaluateColdSessionCostGate` (`quota.mjs:849â€“854` & `1199â€“1250`):
```diff
--- a/src/core/quota.mjs
+++ b/src/core/quota.mjs
@@ -846,11 +846,13 @@ export function computeQuotaAndCacheTelemetry(steps = [], {
   const effectiveTtlSec = dualTtl.mainTtlTier === '1h' ? dualTtl.mainTtlRemainingSec : cacheTtlRemainingSec;
+  const hadWarmCache = sessionCacheReadTokens > 0 || sessionCacheCreationTokens > 0;
   const costGate = evaluateColdSessionCostGate({
     ttlRemainingSec: effectiveTtlSec,
     totalActiveTokens,
     modelId,
-    isCacheCold: isCacheCold || effectiveTtlSec <= 0
+    isCacheCold: isCacheCold || effectiveTtlSec <= 0,
+    hadWarmCache
   });
```
```diff
@@ -1196,12 +1198,13 @@ export function evaluateColdSessionCostGate({
   ttlRemainingSec = 300,
   totalActiveTokens = 0,
   modelId = 'gemini-4-argon',
   pricePerMillionUsd = 3.0,
-  isCacheCold = false
+  isCacheCold = false,
+  hadWarmCache = true
 } = {}) {
   const activeTok = Math.max(0, Number(totalActiveTokens) || 0);
   const ttlSec = Math.max(0, Math.round(Number(ttlRemainingSec ?? 300)));
   const price = Number(pricePerMillionUsd) > 0 ? Number(pricePerMillionUsd) : 3.0;
 
   // Warm cache read (0.1x) + compact summary vs Cold 5m/1h cache write (1.25x - 2.0x = 12.5x - 20x warm read)
   const warmCompactionCostUsd = parseFloat(Math.max(0.01, (activeTok / 1_000_000) * price * 0.125).toFixed(2));
   const coldRewriteCostUsd = parseFloat(Math.max(0.05, (activeTok / 1_000_000) * price * 3.125).toFixed(2));
   const costMultiplier = parseFloat((coldRewriteCostUsd / Math.max(0.01, warmCompactionCostUsd)).toFixed(1));
   const quotaPenaltyUnits = Math.round(activeTok * (QUOTA_CONSTANTS.UNCACHED_INPUT_WEIGHT - QUOTA_CONSTANTS.CACHE_READ_WEIGHT));
 
-  if (activeTok <= 50000) {
+  if (activeTok <= 50000 || !hadWarmCache) {
     return {
       state: 'NOMINAL',
```

---

#### Issue C2-08: `stepPrefixBustDetected` in `quota.mjs` and `readSessionGenMetadataSync` in `parser.mjs` Fire False-Positive Prefix Busts When the Session Never Had a Prior Warm Cache Hit
- **File**: `c:\Projects\ga-visualizer-v2\src\core\quota.mjs` (lines `551â€“562`, `747â€“768`) and `c:\Projects\ga-visualizer-v2\src\core\parser.mjs` (lines `545â€“557`)
- **Functions**: `computeQuotaAndCacheTelemetry`, `detectRouterThrash`, `readSessionGenMetadataSync`
- **Boundary Profile Affected**: **Profile 1 (Brand-new sessions)** & **Profile 2 (Log-tier degraded sessions where `cache_read_input_tokens === 0`)**.
- **Reproduction Scenario**:
  1. **In `quota.mjs` lines 551â€“558**:
     ```js
     if (
       i > 0 &&
       rawCacheRead === 0 &&
       rawInput > 0 &&
       (hadPriorCacheHit || explicitMutation) &&
       gapSec !== null &&
       gapSec < QUOTA_CONSTANTS.CACHE_TTL_SECONDS
     )
     ```
     Suppose Turn 0 was a user prompt (`rawCacheRead === 0`, `sessionCacheReadTokens === 0` â€” no warm cache was ever established), and Turn 1 has a `<system_message>` tag or model selection change (`explicitMutation === true`), with `rawCacheRead === 0` (either because the provider doesn't log `cache_read_input_tokens` in Profile 2, or because Turn 0 didn't establish a cache). Because `(hadPriorCacheHit || explicitMutation)` only requires `explicitMutation`, `stepPrefixBustDetected` fires `true` even when `hadPriorCacheHit === false` and `sessionCacheCreationTokens === 0`!
  2. **In `quota.mjs` lines 406 & 756â€“761 (`MODEL_SWITCH_COLD_START`)**:
     In `detectRouterThrash` (line 406):
     `if (isCurrentTurnSwitch || (lastSwitchEvent && (windowTurns.length - 1) === lastSwitchEvent.turnIndex))`
     Even if the current turn **actually hit the warm standby cache** (`lastTurn.cacheReadTokens > 0`! e.g. switching back to Model A whose cache was still warm), Case B (`line 406`) runs *before* Case C (`line 440`) and unconditionally reports `badgeText = "Last turn: cache miss (model switch -> ...)"` and sets `stepPrefixBustDetected = true` at line 756!
     Furthermore, on line 406, `(windowTurns.length - 1) === lastSwitchEvent.turnIndex` compares `windowTurns.length - 1` (which is `0..4` because `windowTurns = recentTurns.slice(-5)`) against `lastSwitchEvent.turnIndex` (which is `turn.stepIndex ?? i` across the full session)! So if a model switch happened at `stepIndex = 4` on Turn 4, and the session is now on Turn 12 (`windowTurns.length - 1 === 4`), `(windowTurns.length - 1) === lastSwitchEvent.turnIndex` (`4 === 4`) is **permanently `true` on every subsequent turn >= 5**!
  3. **In `parser.mjs` lines 546â€“557 (`readSessionGenMetadataSync`)**:
     ```js
     const prevCacheRead = Number(prevRow?.cache_read_tokens || 0);
     const modelChanged = Boolean(prevRow?.model && row?.model && prevRow.model !== row.model);
     if (prevRow && cacheReadTokens === 0 && inputTokens > 0 && (prevCacheRead > 0 || modelChanged))
     ```
     If a session is in a degraded log tier where `cache_read_tokens` is always `0` in `gen_metadata`, any model change sets `prefixBustDetected = true` even when `prevCacheRead === 0`.
  4. **In `classifier.mjs` lines 1316â€“1321 (Session Fracture `PREFIX_BUST`)**:
     ```js
     let deltaSec = 60;
     if (st?.createdAt && prev?.createdAt) { ... }
     if (currCache === 0 && prevCache > 0 && currInput > 0 && deltaSec < 300)
     ```
     When timestamps are missing (`st.createdAt` is null â€” Profile 2), `deltaSec` defaults to `60` (`< 300`), fabricating a `Mid-run Prefix Bust (... at Î”t = 60s < 300s)` fracture even if the two turns were hours apart!
- **Root Cause**:
  1. `quota.mjs:406` checks `isCurrentTurnSwitch` without checking `Number(lastTurn?.cacheReadTokens || 0) === 0`, and compares `windowTurns.length - 1` (`0..4`) to full-session `lastSwitchEvent.turnIndex`.
  2. `quota.mjs:555` allows `explicitMutation` to trigger a prefix bust even when no prior turn ever created or read a cache (`!hadPriorCacheHit && sessionCacheCreationTokens <= rawCacheCreate`).
  3. `classifier.mjs:1316` defaults `deltaSec = 60` when timestamps are missing instead of `null`.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/quota.mjs
+++ b/src/core/quota.mjs
@@ -403,7 +403,11 @@ export function detectRouterThrash(recentTurns = [], isAutoMode = false, {
   }
 
   // Case B: Single Model Switch / Cold Start
-  if (isCurrentTurnSwitch || (lastSwitchEvent && (windowTurns.length - 1) === lastSwitchEvent.turnIndex)) {
+  const lastTurnMissedCache = Number(lastTurn?.cacheReadTokens || 0) === 0;
+  const isLastTurnSwitchEvent = Boolean(
+    lastSwitchEvent && lastTurn && (lastTurn.stepIndex ?? (recentTurns.length - 1)) === lastSwitchEvent.turnIndex
+  );
+  if ((isCurrentTurnSwitch || isLastTurnSwitchEvent) && lastTurnMissedCache) {
     const severity = (isAutoMode && totalTokens >= 100000) ? 'warn' : 'info';
     const badgeText = `Last turn: cache miss (model switch \u2192 ${currentShortName})`;
@@ -540,7 +544,7 @@ export function computeQuotaAndCacheTelemetry(steps = [], {
     const gapSec = (prevTs > 0 && currTs >= prevTs) ? (currTs - prevTs) / 1000 : null;
 
     if (rawCacheRead > 0 || rawCacheCreate > 0 || rawInput > 0) {
-      const hadPriorCacheHit = sessionCacheReadTokens > 0;
+      const hadPriorCacheHit = sessionCacheReadTokens > 0 || sessionCacheCreationTokens > 0;
       const explicitMutation = i > 0 && hasExplicitPrefixMutation(s, steps[i - 1]);
       sessionInputTokens += rawInput;
       sessionCacheReadTokens += rawCacheRead;
@@ -552,7 +556,7 @@ export function computeQuotaAndCacheTelemetry(steps = [], {
         i > 0 &&
         rawCacheRead === 0 &&
         rawInput > 0 &&
-        (hadPriorCacheHit || explicitMutation) &&
+        hadPriorCacheHit &&
         gapSec !== null &&
         gapSec < QUOTA_CONSTANTS.CACHE_TTL_SECONDS
       ) {
```
And in `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs` (lines `1316â€“1321`):
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -1313,12 +1313,12 @@ export function classifyHorizon(rawSteps, options = {}) {
       const currCache = Number(st?.cacheReadTokens || 0);
       const prevCache = Number(prev?.cacheReadTokens || 0);
       const currInput = Number(st?.inputTokens || st?.outputTokens || 0);
-      let deltaSec = 60;
+      let deltaSec = null;
       if (st?.createdAt && prev?.createdAt) {
         const dMs = Date.parse(st.createdAt) - Date.parse(prev.createdAt);
         if (Number.isFinite(dMs) && dMs >= 0) deltaSec = dMs / 1000;
       }
-      if (currCache === 0 && prevCache > 0 && currInput > 0 && deltaSec < 300) {
+      if (currCache === 0 && prevCache > 0 && currInput > 0 && deltaSec !== null && deltaSec < 300) {
```

---

#### Issue C2-09: Post-Compaction Bugs in `classifier.mjs` & `layer5_hygiene.mjs` (Profile 3: Sessions Where `CORTEX_STEP_TYPE_CHECKPOINT` / `step_type == 23` Just Occurred)
- **File**: `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs` (lines `497â€“500`, `1148`, `1289â€“1310`) and `c:\Projects\ga-visualizer-v2\src\core\layer5_hygiene.mjs` (lines `533â€“590`)
- **Functions**: `classifyHorizon`, `evaluatePostCompactionReReadTax`
- **Boundary Profile Affected**: **Profile 3 (Post-compaction sessions where `CORTEX_STEP_TYPE_CHECKPOINT` / `step_type == 23` just occurred)**.
- **Reproduction Scenario**:
  1. **Duplicate `COMPACTION` Fracture Marker at Cell 0 (`classifier.mjs:1289â€“1310`)**:
     In `classifyHorizon` (line 497): `const steps = lastCheckpointIdx >= 0 ? rawSteps.slice(lastCheckpointIdx) : rawSteps;`
     Because `rawSteps.slice(lastCheckpointIdx)` starts at `lastCheckpointIdx`, **`steps[0]` IS the checkpoint step**!
     If there were two checkpoints in `rawSteps`, or if `extractEffortTimeline(rawSteps)` (line 516) runs on `rawSteps` instead of `steps`:
     - Line 516 calls `extractEffortTimeline(rawSteps)` on the **pre-compaction `rawSteps`** (where `turnIndex` is `0..rawSteps.length - 1`), and then line 869 maps `tr.turnIndex` against `cells` whose `turnRange` is indexed by `0..steps.length - 1` (post-compaction indices)! Every pre-compaction effort transition gets mapped onto the wrong post-compaction cell!
     - Line 498 calls `const fullReReadEval = evaluateSmartFileReReads(rawSteps);` on the entire pre-compaction history even when `lastCheckpointIdx >= 0`, and line 1148 exposes `exemptedReReads: fullReReadEval.exemptedReReads` from pre-compaction turns.
  2. **Multi-Checkpoint Accumulation Bug in `evaluatePostCompactionReReadTax` (`layer5_hygiene.mjs:533â€“590`)**:
     In `evaluatePostCompactionReReadTax`:
     - When a second compaction checkpoint occurs (lines 552â€“556), `preCompactionReads` and `editedSincePreRead` are **not reset** (`preCompactionReads` still holds files from 2 epochs ago even if they were not in the epoch immediately preceding the latest compaction, or `editedSincePreRead` suppresses tax for a file edited in Epoch 1, read again in Epoch 1, compacted into Epoch 2, and re-read in Epoch 2!).
     -Wait: look closely at lines 569â€“576 of `layer5_hygiene.mjs`:
       If a file is read after compaction (in Epoch 2) at step 10, AND read a second time in Epoch 2 at step 12: both step 10 and step 12 match `else if (preCompactionReads.has(canon) && !editedSincePreRead.has(canon))`! Step 12 is a **same-epoch duplicate read** (already counted by `evaluateSmartFileReReads`), NOT a post-compaction re-read tax! Because `preCompactionReads.delete(canon)` is not called once the post-compaction re-read occurs, every subsequent read in the new epoch is double-counted as "Post-Compaction Re-Read Tax"!
- **Root Cause**:
  1. `classifier.mjs:516`: `extractEffortTimeline(rawSteps)` uses `rawSteps` instead of `steps` (post-checkpoint slice).
  2. `layer5_hygiene.mjs:576`: `evaluatePostCompactionReReadTax` never consumes/deletes `canon` from `preCompactionReads` after the first post-compaction re-read of that file, double-counting same-epoch repeat reads as compaction re-read tax.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -513,7 +513,7 @@ export function classifyHorizon(rawSteps, options = {}) {
     ? Number(maxTokensOverride)
     : ceilingDetails.ceilingTokens;
 
-  const parsedEffort = extractEffortTimeline(rawSteps);
+  const parsedEffort = extractEffortTimeline(steps);
   const rawEffortProfile = options.activeEffortProfile
```
```diff
--- a/src/core/layer5_hygiene.mjs
+++ b/src/core/layer5_hygiene.mjs
@@ -584,6 +584,7 @@ export function evaluatePostCompactionReReadTax(rawSteps = []) {
             postCompactionStepIndex: s.stepIndex ?? i,
             wastedTokens: tok
           });
+          preCompactionReads.delete(canon);
         }
       }
     }
```

---

#### Issue C2-10: Idle / Cold Historical Sessions (`idleSeconds > 300`, Profile 4) Trigger Active Alarms (`AMBER` Session Risk, `COLD_COST_GATE` Banner, and `COMPACT_NOW` Advisory)
- **File**: `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs` (lines `305, 320â€“324`), `c:\Projects\ga-visualizer-v2\src\core\quota.mjs` (lines `1228â€“1238`), and `c:\Projects\ga-visualizer-v2\src\core\prompt_rubric.mjs` (lines `330â€“337`)
- **Functions**: `evaluateCompositeSessionRisk`, `evaluateColdSessionCostGate`, `evaluateCompactionCacheAdvisory`
- **Boundary Profile Affected**: **Profile 1 (Lean sessions `< 50k` tokens with `TTL == 0s`)** and **Profile 4 (Idle / Cold historical sessions with `idleSeconds > 300`)**.
- **Reproduction Scenario**:
  1. **Lean session (`< 50k` tokens) that has been idle for `> 5` minutes (`cacheTtlRemainingSec === 0`)**:
     In `evaluateCompositeSessionRisk` (`classifier.mjs:305, 320`):
     `const isCacheExpired = Number(cacheTtlRemainingSec) <= 0;`
     `else if (isCacheExpired || isCascadeArmedWithPendingTask || isTaskMdStale) { band = 'AMBER'; }`
     Even when a session has only **3,000 tokens** (brand-new/lean session where a cold cache rebuild costs almost nothing and `evaluateColdSessionCostGate` returns `'NOMINAL'` for `<= 50000` tokens!), `evaluateCompositeSessionRisk` sets `band = 'AMBER'` with reason `'Cache TTL == 0s (cold cache window expired)'`!
  2. **Clean session (`> 50k` tokens, `0` sludge tokens, `signalPurityPct = 100%`) that goes idle (`TTL == 0s`)**:
     In `evaluateCompactionCacheAdvisory` (`prompt_rubric.mjs:320â€“338`):
     Because `totalActiveTokens >= 50000`, `isCompactionRelevant` returns `true` even if `sludgeTokens === 0` (there is literally nothing to compact!). Then when `cacheTtlRemainingSec <= 0`, `evaluateCompactionCacheAdvisory` returns `state: 'COMPACT_NOW'` (`"Cache expired. Run parameterized compaction now before firing next turn."`) even on a 55k session with 100% signal purity and 0k reclaimable tokens!
- **Root Cause**:
  1. `evaluateCompositeSessionRisk` flags `isCacheExpired` (`band = 'AMBER'`) unconditionally even when `totalActiveTokens <= SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS` (`50,000` tokens) or when the session never had a warm cache.
  2. `evaluateCompactionCacheAdvisory` recommends `COMPACT_NOW` when `cacheTtlRemainingSec <= 0` even when `sludgeTokens < LEAN_SESSION_MIN_SLUDGE` (25k) and `totalActiveTokens <= safeHorizonTokens` (i.e. when there is negligible sludge to reclaim).
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -302,7 +302,8 @@ export function evaluateCompositeSessionRisk({
   // Local quota estimates never escalate to RED; only host-sourced (or legacy unsourced) 7d values do.
   const is7dLockoutWithoutOverages = weekly7dSource !== 'estimate' &&
     (weekly7dUsedPct >= 100 || Boolean(weekly7dLockoutRisk)) && !aiCreditOveragesEnabled;
-  const isCacheExpired = Number(cacheTtlRemainingSec) <= 0;
+  const isCacheExpired = Number(cacheTtlRemainingSec) <= 0 &&
+    totalActiveTokens > SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS;
   const isCascadeArmedWithPendingTask = totalActiveTokens > SESSION_RISK_THRESHOLDS.CASCADE_SYNC_WATERMARK_TOKENS && Boolean(hasPendingTaskItems);
```

---

#### Issue C2-11: `classifyHorizon` Error Detection (`classifier.mjs:611, 1037` and `pruner.mjs:162`) Only Checks `step.exitCode === 1`, Missing Non-Zero Exit Codes (`2`, `127`, `137`, etc.) or Treating `Traceback` in Source File Reads as `DEAD_ERROR`
- **File**: `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs` (lines `611`, `1037`) and `c:\Projects\ga-visualizer-v2\src\core\pruner.mjs` (line `162`)
- **Functions**: `classifyHorizon`, `pruneSessionTranscript`
- **Boundary Profile Affected**: **Profile 1 (Read-only audit sessions reading files that mention `"Traceback (most recent call last)"`)**.
- **Reproduction Scenario**:
  1. In this very session (or any read-only audit session), the agent calls `view_file` on `classifier.mjs` or `pruner.mjs`, which contains the literal string `'Traceback (most recent call last)'` on line 611!
  2. Because `classifier.mjs:611` evaluates:
     `const isError = step.status === 'ERROR' || step.exitCode === 1 || contentStr.includes('Traceback (most recent call last)');`
     Every `view_file` step that reads `classifier.mjs` or `pruner.mjs` (or any Python error handler) is **misclassified as `CATEGORIES.DEAD_ERROR` ("Resolved Stack Trace")**!
  3. And in `pruner.mjs:162`, `pruneSessionTranscript` checks `content.includes('Traceback (most recent call last)')` and **collapses the file read of `classifier.mjs` into a 1-line `[Resolved Error at Turn #N]` tombstone**, destroying the file read content!
- **Root Cause**:
  1. `contentStr.includes('Traceback (most recent call last)')` is checked even when the step is a `view_file`/`read_file` tool call (or assistant prose) rather than a command execution or `ERROR` status step.
  2. `step.exitCode === 1` misses exit codes `2`, `127`, `-1`, etc. (`typeof step.exitCode === 'number' && step.exitCode !== 0`).
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -608,7 +608,10 @@ export function classifyHorizon(rawSteps, options = {}) {
     const contentStr = String(step.content || '');
     const calls = step.toolCalls || [];
-    const isError = step.status === 'ERROR' || step.exitCode === 1 || contentStr.includes('Traceback (most recent call last)');
+    const isReadOnlyFileCall = calls.length > 0 && calls.every(c => /^(view_file|read_file|view_file_outline|view_code_item)$/i.test(String(c.name || '')));
+    const isError = step.status === 'ERROR' ||
+      (typeof step.exitCode === 'number' && step.exitCode !== 0) ||
+      (!isReadOnlyFileCall && contentStr.includes('Traceback (most recent call last)'));
```
And in `c:\Projects\ga-visualizer-v2\src\core\pruner.mjs` (line `162`):
```diff
--- a/src/core/pruner.mjs
+++ b/src/core/pruner.mjs
@@ -159,7 +159,10 @@ export function pruneSessionTranscript(sessionDir, {
     const content = String(entry.content || '');
     const calls = entry.tool_calls || entry.toolCalls || [];
-    const isError = entry.status === 'ERROR' || entry.exitCode === 1 || content.includes('Traceback (most recent call last)');
+    const isReadOnlyFileCall = calls.length > 0 && calls.every(c => /^(view_file|read_file|view_file_outline|view_code_item)$/i.test(String(c.name || c.tool || '')));
+    const isError = entry.status === 'ERROR' ||
+      (typeof entry.exitCode === 'number' && entry.exitCode !== 0) ||
+      (!isReadOnlyFileCall && content.includes('Traceback (most recent call last)'));
```

---



---

### Bug Class 3 & Class 4: Mismatched Remediation Prompts, Technical Claims, Hardcoded Paths & Non-Portable Commands

﻿# Forensic Audit Report: Remediation Prompts, CLI Tools, Hooks & Daemon Routes (Bug Classes 3 & 4)

Below is the exhaustive, line-by-line forensic audit across `src/webview/horizon_panel.html`, `src/core/action_queue.mjs`, `src/core/prompt_rubric.mjs`, `src/core/offenders.mjs`, `src/core/layer5_hygiene.mjs`, `src/core/classifier.mjs`, `src/core/handoff_audit.mjs`, `src/core/pruner.mjs`, `src/hooks/*.mjs`, `src/cli/*.mjs`, and `sidecars/horizon-daemon/server.mjs`.

---

## Class 3: Mismatched Remediation Prompts, Tool Advice & Technical Claims

### 3.1 Tool / Payload Mismatches

#### Finding 3.1.a â€” `blowupSteps` in `classifier.mjs` Misses File-Based Payloads When `TargetFile`, `Target`, `target`, or `step.targetPath` Is Used, Causing File Spikes to Trigger Shell Command (`Select-Object -First 50` / `PreToolUse` Hook) Remedies
- **Files & Lines**:
  - `src/core/classifier.mjs:1013-1034` (`classifyHorizon` -> `blowupSteps` builder)
  - `src/webview/horizon_panel.html:3960-3988` (`renderState` -> Card C: Blowup Steps)
  - `src/webview/horizon_panel.html:4984-5032` (`renderSessionHealthSummary` -> B4. Single-Turn Blowup Output `dampen-blowup`)
- **Reproduction Scenario**:
  1. An agent invokes `replace_file_content`, `multi_replace_file_content`, `write_to_file`, or `view_file_outline` with `{ TargetFile: "src/webview/horizon_panel.html" }` (or `{ Target: ... }`), or a parsed step carries `step.targetPath` instead of `args.Path`.
  2. In `classifier.mjs:1020`, `const filePath = args.Path || args.path || args.AbsolutePath || null;` only checks 3 keys (`Path`, `path`, `AbsolutePath`), ignoring `TargetFile`, `Target`, `target`, `file_path`, and `step.targetPath` (even though lines 553, 656, and 1057 of the same file check `TargetFile`/`Target`).
  3. Consequently, `filePath` evaluates to `null` and `payload.kind` becomes `'other'` (`detail: call?.name || 'Model/tool output'`).
  4. In `horizon_panel.html:3981-3985` (Playbook Card C) and `horizon_panel.html:4991-5008` (Simple Actionable Box `dampen-blowup`), because `bp.kind !== 'file'` and `bp.path` is null, `isFile` evaluates to `false`!
  5. **Result**:
     - Playbook Card C (`horizon_panel.html:3985`) renders `onclick="runPrompt('truncate', this)"` (`PROMPTS.truncate.text`: *"From now on, truncate command output (for example pipe through Select-Object -First 50 or use head/tail...)"*).
     - Simple Actionable Box (`horizon_panel.html:5000-5008`) treats the non-file spike as a CLI spike, displaying `cmdSpikePrompt` (`PROMPTS.truncate.text` with `Select-Object -First 50`) AND rendering `<button data-simple-act="dampen-hook">ðŸ›¡ï¸ Register PreToolUse Hook</button>` (which registers a `run_command` stdout hook in `.agents/hooks.json` with `data-command="replace_file_content"`!).
- **Root Cause in Code**:
  1. `classifier.mjs:1020` omits `args.TargetFile || args.Target || args.target || args.file_path || steps[s.stepIndex]?.targetPath` and does not check if `call?.name` is a known file tool (`view_file`, `read_file`, `replace_file_content`, `multi_replace_file_content`, `write_to_file`, `edit_file`, `write_file`).
  2. `horizon_panel.html:5000-5008` uses a binary `isFile ? ... : ...` ternary that assumes anything not `isFile` is a CLI command needing `dampen-hook` and `PROMPTS.truncate`.
- **Drop-In Replacement Diffs**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -1017,18 +1017,21 @@
     .map(s => {
       const rawStep = steps[s.stepIndex] || {};
       const call = (rawStep.toolCalls || [])[0];
       const args = call?.args || {};
-      const filePath = args.Path || args.path || args.AbsolutePath || null;
-      const command = args.CommandLine || null;
+      const toolName = String(call?.name || rawStep.toolName || '').toLowerCase();
+      const filePath = args.Path || args.path || args.TargetFile || args.Target || args.target || args.AbsolutePath || args.file_path || rawStep.targetPath || null;
+      const command = args.CommandLine || args.command || null;
+      const isFileTool = Boolean(filePath) || /^(view_file|read_file|view_file_outline|view_code_item|replace_file_content|multi_replace_file_content|write_to_file|write_file|edit_file)$/.test(toolName);
+      const isCmdTool = Boolean(command) || /^(run_command|bash|execute_command)$/.test(toolName);
       return {
         stepIndex: s.stepIndex,
         tokens: s.tokens,
         category: s.category,
         target: s.target || `Step ${s.stepIndex}`,
         payload: {
-          kind: command ? 'command' : (filePath ? 'file' : 'other'),
+          kind: isCmdTool ? 'command' : (isFileTool ? 'file' : 'other'),
           tool: call?.name || null,
           detail: String(command || filePath || call?.name || 'Model/tool output').slice(0, 300),
           path: filePath
         }
       };
     });
```
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -4990,8 +4990,8 @@
           const bp = topBlowup.payload || {};
           const bpKind = bp.kind || '';
           const isCmd = bpKind === 'command' || (!bpKind && !bp.path && /(git|npm|node|powershell|bash|sh|cmd|run_command)/i.test(topBlowup.target || ''));
-          const isFile = bpKind === 'file' || Boolean(bp.path) || (!isCmd && /\.[a-z0-9]+$/i.test(topBlowup.target || ''));
+          const isFile = bpKind === 'file' || Boolean(bp.path) || (!isCmd && (/\.[a-z0-9]+$/i.test(topBlowup.target || '') || /(view_file|read_file|replace_file|write_to_file|edit_file)/i.test(bp.tool || '')));
           const blowSrc = bp.detail || topBlowup.target || (isCmd ? 'command output' : 'file output');
           const shortSrc = formatShortPath(blowSrc);
           const spikeDismissKey = `spike:${topBlowup.stepIndex}`;
```

#### Finding 3.1.b â€” `PROMPTS.truncate.text` Conflates Command and File Outputs and Hardcodes PowerShell `Select-Object -First 50`
- **File & Line**: `src/webview/horizon_panel.html:2400-2403` (`PROMPTS.truncate`)
- **Code**:
  ```js
  truncate: {
    short: 'Truncate Command Output',
    text: 'The last very large command/file output filled my context window. From now on, truncate command output (for example pipe through Select-Object -First 50 or use head/tail, grep, or line ranges) so a single step never injects more than a few thousand tokens.'
  },
  ```
- **Root Cause**: `PROMPTS.truncate.text` says `"command/file output"` and mixes shell piping (`Select-Object -First 50`, `head/tail`) with file reading (`line ranges`), while also violating Single Action Button Simplicity in `horizon_panel.html:5007-5008` where **two competing buttons** (`Register PreToolUse Hook` AND `Copy Prompt`) are rendered on the same `dampen-blowup` card in `#simpleActionList`!
- **Note on UI Invariant 4 (`Single Action Button Simplicity`)**:
  - In `src/webview/horizon_panel.html:4859-4861` (`agent-learning`), `4940-4942` (`condense-ast`), and `5007-5008` (`dampen-blowup`), the `#simpleActionList` cards render **two buttons** inside `.m3-action-btn-row` instead of one primary action button.

---

### 3.2 Ephemeral vs. Persistent Remedy Mismatches

#### Finding 3.2.a â€” Cross-Session `chronicReads` Recommends an Ephemeral Single-Chat Prompt Instead of Promoting a Persistent Rule to `AGENTS.md` / `.agents/skills/`
- **Files & Lines**:
  - `src/webview/horizon_panel.html:4619-4632` (`renderState` -> Tier 2 `#actionRowHighLeverage`)
  - `src/webview/horizon_panel.html:5035-5071` (`renderSessionHealthSummary` -> Tier 3B B5 `chronic-read` card)
  - `src/webview/horizon_panel.html:5237-5242` (`initPromptButtons` -> `#btnActionHighLeverage.onclick`)
- **Reproduction Scenario**:
  1. A source file (e.g., `src/webview/horizon_panel.html` or `src/core/classifier.mjs`, where `isIgnorablePath(ch.path) === false`) is flagged in `raw.chronicReads` across 3+ sessions (`c.sessions >= 3`).
  2. In `horizon_panel.html:5042-5044`:
     ```js
     const chronicPrompt = canIgnore
       ? ignorePromptText(ch.path)
       : `To keep context memory lean, please use StartLine/EndLine when reading ${shortP} instead of reading full files repeatedly.`;
     ```
     This copies a **one-off chat message** that only affects the current conversation and will be forgotten in the next sessionâ€”even though `chronicReads` is specifically a **cross-session** pathology (`c.sessions >= 3`)!
  3. Worse still, in `horizon_panel.html:4628-4632` (`#btnActionHighLeverage`):
     ```js
     if (btnActionHl) {
       btnActionHl.textContent = canIgnoreTop ? 'Ignore File' : 'Use Subagent';
       btnActionHl.dataset.action = canIgnoreTop ? 'ignore-file' : 'prompt-subagent';
       btnActionHl.dataset.path = topC.path;
     }
     ```
     When the user clicks `#btnActionHighLeverage` (`Use Subagent`) when `dataset.action === 'prompt-subagent'`, look at `horizon_panel.html:5232-5243`:
     ```js
     actionHl.onclick = async () => {
       const act = actionHl.dataset.action;
       if (act === 'promote-rule') { ... }
       else if (act === 'ignore-file') { ... }
       else {
         applyViewMode('advanced');
       }
     };
     ```
     `act === 'prompt-subagent'` is **not handled** in `actionHl.onclick`! Clicking `Use Subagent` silently switches the tab to Advanced view instead of executing the action or promoting a persistent rule to `AGENTS.md`!
- **Root Cause in Code**:
  - Cross-session source-file re-reads (`chronicReads`) should either promote a persistent Primacy rule to `AGENTS.md` (`promoteRuleDirect('Always use StartLine/EndLine ranges when reading ' + shortP, 'primacy')`) or instruct the agent to add the rule to `AGENTS.md`, and `actionHl.onclick` must handle `prompt-subagent` / `promote-chronic-rule`.
- **Drop-In Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -4625,8 +4625,9 @@
         if (actionHlSub) actionHlSub.textContent = canIgnoreTop
           ? `seen in ${topC.sessions} recent sessions Â· add to .antigravityignore`
-          : `seen in ${topC.sessions} recent sessions Â· use subagent or line ranges`;
+          : `seen in ${topC.sessions} recent sessions Â· persist line-range rule in AGENTS.md`;
         if (btnActionHl) {
-          btnActionHl.textContent = canIgnoreTop ? 'Ignore File' : 'Use Subagent';
-          btnActionHl.dataset.action = canIgnoreTop ? 'ignore-file' : 'prompt-subagent';
+          btnActionHl.textContent = canIgnoreTop ? 'Ignore File' : 'Promote Rule';
+          btnActionHl.dataset.action = canIgnoreTop ? 'ignore-file' : 'promote-chronic-rule';
           btnActionHl.dataset.path = topC.path;
+          btnActionHl.dataset.rule = `To keep context memory lean, always use StartLine/EndLine line ranges when reading ${formatWorkspaceRelativePath(topC.path)} instead of reading the full file.`;
         }
@@ -5042,3 +5043,3 @@
         const chronicPrompt = canIgnore
           ? ignorePromptText(ch.path)
-          : `To keep context memory lean, please use StartLine/EndLine when reading ${shortP} instead of reading full files repeatedly.`;
+          : `Please add a persistent rule to the Primacy zone (top 30%) of AGENTS.md: "Always use StartLine/EndLine line ranges when reading ${formatWorkspaceRelativePath(ch.path)} instead of reading the full file."`;
@@ -5237,6 +5238,9 @@
         } else if (act === 'ignore-file') {
           const p = actionHl.dataset.path;
           if (p) runPrompt('ignore', actionHl, ignorePromptText(p));
+        } else if (act === 'promote-chronic-rule') {
+          const ruleText = actionHl.dataset.rule || `Always use StartLine/EndLine when reading ${formatWorkspaceRelativePath(actionHl.dataset.path || '')}.`;
+          await promoteRuleDirect(ruleText, 'primacy', actionHl);
         } else {
           applyViewMode('advanced');
         }
```

#### Finding 3.2.b â€” Action Queue `aq-idle-mcp` Button Has No Click Handler in `horizon_panel.html` and Copies a Non-Executable JS Comment
- **Files & Lines**:
  - `src/core/action_queue.mjs:121-122` (`buildActionQueue` -> `aq-idle-mcp`)
  - `src/webview/horizon_panel.html:3133-3134` (`buildClientActionQueue` -> `aq-idle-mcp`)
  - `src/webview/horizon_panel.html:4462-4480` (`aqList.querySelectorAll('.aq-btn')` click handler)
- **Reproduction Scenario**:
  1. An eager MCP server has 0 calls after 5+ turns, generating the Action Queue item `id: 'aq-idle-mcp'`, `apiAction: 'mcp-switch-lazy'`, `commandToCopy: '// Switch "server" to lazy loading in mcp_config.json'`.
  2. In `horizon_panel.html:4467-4479`, the click handler checks `act === 'reap-orphans'`, `act === 'condense-ast'`, `act === 'generate-handoff'`, and `act === 'reanchor-spec'`, but **never checks `act === 'mcp-switch-lazy'`**!
  3. Clicking `[Defer 1 Idle MCP]` in the Action Queue does nothing except copy a JS comment `// Switch "X" to lazy loading in mcp_config.json` to the clipboard.
- **Drop-In Replacement Diff**:
```diff
--- a/src/core/action_queue.mjs
+++ b/src/core/action_queue.mjs
@@ -121,2 +121,2 @@
-      commandToCopy: `// Switch "${serverNames}" to lazy loading in mcp_config.json`,
+      commandToCopy: `Please update ~/.gemini/config/mcp_config.json (or .agents/mcp_config.json) to set "${serverNames}" to "loading": "lazy" so unused schemas do not bloat Turn-0 prefix tokens.`,
       apiAction: 'mcp-switch-lazy'
```
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3133,2 +3133,2 @@
-        commandToCopy: `// Switch "${serverNames}" to lazy loading in mcp_config.json`,
+        commandToCopy: `Please update ~/.gemini/config/mcp_config.json (or .agents/mcp_config.json) to set "${serverNames}" to "loading": "lazy" so unused schemas do not bloat Turn-0 prefix tokens.`,
         apiAction: 'mcp-switch-lazy'
@@ -4476,4 +4476,7 @@
             } else if (act === 'reanchor-spec') {
               const checkpointBtn = document.getElementById('btnCheckpoint');
               if (checkpointBtn) checkpointBtn.click();
+            } else if (act === 'mcp-switch-lazy') {
+              const mcpBtn = document.querySelector('[data-act="mcp-switch-lazy"]');
+              if (mcpBtn) mcpBtn.click();
             }
```

---

### 3.3 Inaccurate Antigravity Physics Claims

#### Finding 3.3.a â€” `btnCondenseAst` (`Condense Now`) Unconditionally Passes `forceHotCache: true` while Claiming "Prefix-Cache Safe" and "(requires confirmation if cache is warm)"
- **Files & Lines**:
  - `src/webview/horizon_panel.html:2153` (`#btnCondenseAst` tooltip)
  - `src/webview/horizon_panel.html:4937` (`condense-ast` card description)
  - `src/webview/horizon_panel.html:5343-5352` (`btnCondense.onclick` handler)
  - `src/core/action_queue.mjs:147` & `src/webview/horizon_panel.html:3154` (`aq-tool-prune` payoff: `'reclaims ~Xk tok (zero LLM loss)'`)
- **Reproduction Scenario**:
  1. Look at `horizon_panel.html:4937`:
     > `"Folds older duplicate file snapshots and resolved error traces into 1-line declaration stubs, best run when the 5m prompt cache is cold (requires confirmation if cache is warm)."`
  2. Look at `horizon_panel.html:2153`:
     > `title="Condenses stale duplicate file reads into compact declaration signature stubs and collapses resolved stack traces (Prefix-Cache Safe)"`
  3. Now look at `horizon_panel.html:5348-5352`:
     ```js
     const r = await fetch('/api/prune', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ conversationId: currentRenderedState?.sessionId, forceHotCache: true })
     });
     ```
     **It hardcodes `forceHotCache: true` without any confirmation dialog!** Even though `src/core/pruner.mjs:118-126` specifically returns `{ requiresConfirmation: true, isCacheCold: false, cacheTtlRemainingSec }` when `forceHotCache` is `false` and the cache is warm, the UI bypasses `pruner.mjs`'s warm-cache guard by sending `forceHotCache: true` on the very first click, silently mutating mid-transcript JSONL lines and busting the active 5-minute KV prefix cache!
- **Root Cause in Code**: `btnCondense.onclick` passes `forceHotCache: true` initially instead of `forceHotCache: false` and prompting `window.confirm(...)` when `data.requiresConfirmation === true`.
- **Drop-In Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -5345,15 +5345,27 @@
     btnCondense.onclick = async () => {
       try {
         flashButton(btnCondense, '&#x23F3; Condensing...', 2500);
-        const r = await fetch('/api/prune', {
+        let r = await fetch('/api/prune', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
-          body: JSON.stringify({ conversationId: currentRenderedState?.sessionId, forceHotCache: true })
+          body: JSON.stringify({ conversationId: currentRenderedState?.sessionId, forceHotCache: false })
         });
-        const data = await r.json();
+        let data = await r.json();
+        if (!data.success && data.requiresConfirmation) {
+          const confirmHot = typeof window.confirm === 'function'
+            ? window.confirm(`${data.error}\n\nCondensing now will rewrite earlier JSONL turns and invalidate the warm KV prefix cache. Proceed anyway?`)
+            : true;
+          if (!confirmHot) return;
+          r = await fetch('/api/prune', {
+            method: 'POST',
+            headers: { 'Content-Type': 'application/json' },
+            body: JSON.stringify({ conversationId: currentRenderedState?.sessionId, forceHotCache: true })
+          });
+          data = await r.json();
+        }
         if (data.success) {
           if (data.state) renderState(data.state);
           showToast(`&#x2713; <strong>Condensed ${data.prunedSteps || 0} stale steps (~${fmtK(data.savedTokens || 0)} saved).</strong> Backup saved automatically.`);
```

#### Finding 3.3.b â€” `#compactReclaim` Claims Bare `/compact` "keeps rules, plan & code intact"
- **File & Line**: `src/webview/horizon_panel.html:3763-3765` (`renderState` -> `reclaimLine`)
- **Code**:
  ```js
  const reclaimLine = (clutterTokens > 0 || reclaimSumK > 0)
    ? `reclaims up to ~${reclaimSumStr} \u00B7 keeps rules, plan & code intact`
    : '';
  ```
- **Root Cause**: Bare `/compact` (`CORTEX_STEP_TYPE_CHECKPOINT = 23`) summarizes prior turns into `<CONTEXT_SUMMARY>` and **wipes** earlier raw `view_file` / `read_file` code buffers from active memory (which is why `layer5_hygiene.mjs:49` and `evaluatePostCompactionReReadTax` at `layer5_hygiene.mjs:530` explicitly note that in-memory file buffers are wiped at compaction checkpoints, and why `horizon_panel.html:4910` accurately says *"keeping `AGENTS.md` rules, `task.md` state, and active working summary intact"*). Claiming `/compact` *"keeps rules, plan & code intact"* misleads users into thinking raw file buffers survive bare `/compact`.
- **Drop-In Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3763,3 +3763,3 @@
     const reclaimLine = (clutterTokens > 0 || reclaimSumK > 0)
-      ? `reclaims up to ~${reclaimSumStr} \u00B7 keeps rules, plan & code intact`
+      ? `reclaims up to ~${reclaimSumStr} \u00B7 keeps rules, task.md & active summary intact`
       : '';
```

#### Finding 3.3.c â€” Claiming `task.md` Is "Stale" When `task.md` Was Never Created (`exists === false` / `taskMdSaved === false`)
- **Files & Lines**:
  1. `src/core/classifier.mjs:1058-1068` (`classifyHorizon` -> `taskTurnsBehind`) & `src/core/classifier.mjs:307, 329-330` (`evaluateCompositeSessionRisk`)
  2. `src/webview/horizon_panel.html:2642, 2654, 2666` (`evaluateCompositeSessionRiskInline`)
  3. `src/webview/horizon_panel.html:4175-4176` (`renderState` -> `handoffStatus.innerHTML`)
  4. `src/webview/horizon_panel.html:4582, 4785` (`renderState` & `renderSessionHealthSummary` -> `const exists = Boolean(signals.handoff?.artifacts?.taskMd?.exists !== false);`)
- **Reproduction Scenario**:
  1. In a brand-new or exploratory session where `task.md` has **never** been created (`lastTaskWrite === -1`, `taskMdSaved === false`, `handoff.artifacts.taskMd.exists === false`), `classifier.mjs:1068` computes:
     ```js
     const taskTurnsBehind = steps.slice(lastTaskWrite + 1).filter(isUserTurn).length;
     ```
     Since `lastTaskWrite` is `-1`, `steps.slice(0)` counts **every user turn in the entire conversation** (e.g., `taskTurnsBehind = 4`) even though `task.md` does not exist!
  2. Then `evaluateCompositeSessionRisk` (`classifier.mjs:307, 329-330` and `horizon_panel.html:2654, 2666`) unconditionally checks `isTaskMdStale = Number(taskMdTurnsBehind) >= 1` and emits:
     - Status dot = `AMBER` (`dot warn`) on Turn 1 of every session without a `task.md`!
     - Tooltip reason: `"task.md is 4 turns stale"` when `task.md` was never created!
  3. In `horizon_panel.html:4176`:
     ```js
     const txt = synced ? '&#x25CF; task.md synced'
       : (hs.taskMdSaved ? `&#x25CF; task.md stale &bull; ${behind} turn${behind === 1 ? '' : 's'} behind` : '&#x25CF; task.md stale &bull; not saved yet');
     ```
     It literally says `task.md stale â€¢ not saved yet` when `hs.taskMdSaved === false`!
  4. In `horizon_panel.html:4582` and `4785`:
     ```js
     const exists = Boolean(signals.handoff?.artifacts?.taskMd?.exists !== false);
     ```
     Whenever `signals.handoff` is omitted or `artifacts.taskMd` is undefined (e.g., in V3 sidecar payloads or partial states), `undefined !== false` evaluates to **`true`**, so `exists` defaults to `true`! Then when `isSaved === false` and `turnsBehind === 4`, it skips the `if (!isSaved && !exists)` branch ("Save initial task.md checkpoint") and falls into `else if (turnsBehind >= 3 || !isSaved)` ("Update task.md checkpoint before compacting â€” `task.md` is 4 turns behind live state") even though `task.md` was never saved!
- **Drop-In Replacement Diffs**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -289,6 +289,7 @@
   cacheReadTokens = 0,
   cacheHitRatePct = 0,
   taskMdTurnsBehind = 0,
+  taskMdExists = true,
   hasPendingTaskItems = false,
   weekly7dUsedPct = 0,
   weekly7dLockoutRisk = false,
@@ -304,7 +305,7 @@
     (weekly7dUsedPct >= 100 || Boolean(weekly7dLockoutRisk)) && !aiCreditOveragesEnabled;
   const isCacheExpired = Number(cacheTtlRemainingSec) <= 0;
   const isCascadeArmedWithPendingTask = totalActiveTokens > SESSION_RISK_THRESHOLDS.CASCADE_SYNC_WATERMARK_TOKENS && Boolean(hasPendingTaskItems);
-  const isTaskMdStale = Number(taskMdTurnsBehind) >= 1;
+  const isTaskMdStale = Boolean(taskMdExists) && Number(taskMdTurnsBehind) >= 1;
 
   const reasons = [];
   let band = 'GREEN';
@@ -1217,6 +1218,7 @@
     cacheReadTokens: quota.cache?.cacheReadTokens ?? 0,
     cacheHitRatePct: quota.cache?.hitRatePct ?? 0,
     taskMdTurnsBehind: taskTurnsBehind,
+    taskMdExists: Boolean(lastTaskWrite >= 0 || handoff?.artifacts?.taskMd?.exists),
     hasPendingTaskItems,
```
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -2643,6 +2643,7 @@
     const cacheHitPct = Number(q.cache?.hitRatePct || 0);
     const turnsBehind = typeof hs.taskMdTurnsBehind === 'number' ? hs.taskMdTurnsBehind : 0;
+    const taskMdExists = Boolean(hs.taskMdSaved || signals.handoff?.artifacts?.taskMd?.exists);
     const hasPendingTaskItems = Boolean(hs.hasPendingTaskItems);
@@ -2654,1 +2655,1 @@
-    const isTaskMdStale = turnsBehind >= 1;
+    const isTaskMdStale = taskMdExists && turnsBehind >= 1;
@@ -4175,3 +4176,3 @@
       const txt = synced ? '&#x25CF; task.md synced'
-        : (hs.taskMdSaved ? `&#x25CF; task.md stale &bull; ${behind} turn${behind === 1 ? '' : 's'} behind` : '&#x25CF; task.md stale &bull; not saved yet');
+        : (hs.taskMdSaved ? `&#x25CF; task.md stale &bull; ${behind} turn${behind === 1 ? '' : 's'} behind` : '&#x25CF; task.md missing &bull; not saved yet');
@@ -4582,1 +4583,1 @@
-      const exists = Boolean(signals.handoff?.artifacts?.taskMd?.exists !== false);
+      const exists = Boolean(isSaved || signals.handoff?.artifacts?.taskMd?.exists === true);
@@ -4785,1 +4786,1 @@
-      const exists = Boolean(signals?.handoff?.artifacts?.taskMd?.exists !== false);
+      const exists = Boolean(isSaved || signals?.handoff?.artifacts?.taskMd?.exists === true);
```

---

### 3.4 Uninterpolated Template Fallbacks & Raw Internal Paths Leaking into UI / Prompts

#### Finding 3.4.a â€” `formatShortPath` Returns Literal `'unknown'` and Does Not Filter Internal `.system_generated/steps/` Paths
- **File & Lines**:
  - `src/webview/horizon_panel.html:2318-2324` (`formatShortPath`)
  - Called at `horizon_panel.html:2507, 3913, 3980, 4047, 4314, 4338, 4361, 4364, 4526, 4624, 4705, 4994, 5041, 5435`
- **Reproduction Scenario**:
  1. When `formatShortPath(p)` is called with an empty/null path, line 2319 returns the literal string `'unknown'`, which is interpolated directly into user-facing text and prompts.
  2. When a cell's `topTarget` or `turnsDetail[].target` contains a Tier-3 hydration path like `C:/Users/frank/.gemini/antigravity/brain/<uuid>/.system_generated/steps/14/output.txt`, `formatShortPath` returns `'.../14/output.txt'` and leaks it into the 40-Cell inspector (`horizon_panel.html:4338, 4361, 4364`) and Stranded Signal banner (`horizon_panel.html:4314`).
- **Root Cause in Code**: `classifier.mjs:656` (`for (const call of calls)` in step classification) and `classifier.mjs:812` (`toolCallLabels` in `cellTurnsDetailMap`) do not filter `isInternalTelemetryPath(targetFile)` when assigning `stepFileBasename` or `toolCallLabels`. And `formatShortPath` in `horizon_panel.html:2318` neither strips `.system_generated/steps/` nor avoids returning `'unknown'`.
- **Drop-In Replacement Diffs**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -2318,7 +2318,9 @@
   function formatShortPath(p) {
-    if (!p) return 'unknown';
+    if (!p) return 'workspace file';
     const clean = String(p).replace(/\\/g, '/');
+    if (/\.system_generated(\/|$)|(^|\/)steps\/\d+\/output\.txt$/i.test(clean)) return 'tool output';
     const segs = clean.split('/').filter(Boolean);
     if (segs.length <= 2) return clean;
     return '.../' + segs.slice(-2).join('/');
   }
```
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -655,7 +655,7 @@
       for (const call of calls) {
         const args = call.args || {};
         const targetFile = args.Path || args.path || args.Target || args.target || args.TargetFile || args.AbsolutePath;
-        if (targetFile) {
+        if (targetFile && !isInternalTelemetryPath(targetFile)) {
           stepFileBasename = path.basename(String(targetFile)).toLowerCase();
           break;
         }
```

#### Finding 3.4.b â€” `generateHandoffMarkdown` in `handoff_audit.mjs` Emits `sessionId = 'unknown'` and Hardcoded Fallback Clause `3) Explicit user constraints: [preserve all active invariants and user rules]`
- **File & Lines**: `src/core/handoff_audit.mjs:328, 352-353` (`generateHandoffMarkdown`)
- **Code**:
  ```js
  const sessionId = state?.sessionId || 'unknown';
  ...
  const parameterizedCompact = state?.compaction?.parameterizedCommand ||
    `/compact Focus on preserving: 1) Exported symbol signatures and state scales for [${activeFiles.slice(0, 4).join(', ') || 'active workspace files'}], 2) Current checklist state in task.md, 3) Explicit user constraints: [preserve all active invariants and user rules].`;
  ```
- **Root Cause**:
  1. When `state.sessionId` is missing (or in V3 sidecar format where the key is `state.conversationId`), `sessionId` falls back to literal `'unknown'`, generating `# Session Handoff Baton Pass (\`unknown\`)`.
  2. When `state.compaction?.parameterizedCommand` is absent, line 353 emits the generic placeholder `3) Explicit user constraints: [preserve all active invariants and user rules]` instead of calling `synthesizeParameterizedCompact` (which omits clause 3 when there are no explicit user constraints).
- **Drop-In Replacement Diff**:
```diff
--- a/src/core/handoff_audit.mjs
+++ b/src/core/handoff_audit.mjs
@@ -10,1 +10,1 @@
-import { isInternalTelemetryPath, isCompactionRelevant } from './prompt_rubric.mjs';
+import { isInternalTelemetryPath, isCompactionRelevant, synthesizeParameterizedCompact } from './prompt_rubric.mjs';
@@ -328,1 +328,1 @@
-  const sessionId = state?.sessionId || 'unknown';
+  const sessionId = state?.sessionId || state?.conversationId || 'active-session';
@@ -352,2 +352,6 @@
-  const parameterizedCompact = state?.compaction?.parameterizedCommand ||
-    `/compact Focus on preserving: 1) Exported symbol signatures and state scales for [${activeFiles.slice(0, 4).join(', ') || 'active workspace files'}], 2) Current checklist state in task.md, 3) Explicit user constraints: [preserve all active invariants and user rules].`;
+  const parameterizedCompact = state?.compaction?.parameterizedCommand ||
+    synthesizeParameterizedCompact({
+      activeFiles,
+      userCorrections: state?.brainSignals?.userCorrectionTexts || [],
+      workspaceRoot: wsPath
+    });
```

#### Finding 3.4.c â€” `pre_invocation.mjs` Hardcodes `@src/index.js` Fallback Target in Rewrite Scorecard
- **File & Line**: `src/hooks/pre_invocation.mjs:262-267` (`handlePreInvocation` -> Step 8 `HALT_REWRITE_SCORECARD`)
- **Code**:
  ```js
  const targetHint = (fileState.activeSetPaths && fileState.activeSetPaths[0]) || 'src/index.js';
  ...
  const rewriteSuggestion = promptSufficiency.missing.includes('testability & expected outcome')
    ? `"In @${targetHint}, ${cleanedPrompt || 'implement updates'} and run automated tests to verify"`
    : `"In @${targetHint}, ${cleanedPrompt || 'implement surgical updates with unit test'}"`;
  ```
- **Reproduction Scenario**: On a cold session (Turn <= 3) when `fileState.activeSetPaths` is empty, a user types `#check` or a vague prompt in a Python/Go/Rust/ESM repo where `src/index.js` does not exist. The Flight Check scorecard instructs the user to rewrite their prompt targeting `@src/index.js`! Additionally, if `activeSetPaths[0]` is an absolute Windows path (`C:\Projects\foo\src\bar.mjs`), `@${targetHint}` injects `@C:\Projects\foo\src\bar.mjs` instead of a clean workspace-relative path.
- **Drop-In Replacement Diff**:
```diff
--- a/src/hooks/pre_invocation.mjs
+++ b/src/hooks/pre_invocation.mjs
@@ -6,1 +6,1 @@
-import { scorePromptSufficiency } from '../core/prompt_rubric.mjs';
+import { scorePromptSufficiency, toWorkspaceRelativePath } from '../core/prompt_rubric.mjs';
@@ -262,1 +262,3 @@
-    const targetHint = (fileState.activeSetPaths && fileState.activeSetPaths[0]) || 'src/index.js';
+    const rawTargetHint = (fileState.activeSetPaths && fileState.activeSetPaths[0]) || '';
+    const targetHint = (rawTargetHint ? toWorkspaceRelativePath(rawTargetHint, sidecar.workspacePath || process.cwd()) : '') || '<target-file>';
```

#### Finding 3.4.d â€” `session_start.mjs` Throws `ReferenceError: modelId is not defined` When `inputData.mcpServers` Is Present
- **File & Line**: `src/hooks/session_start.mjs:36, 68` (`handleSessionStart`)
- **Code**:
  ```js
  36: const activeModel = inputData.modelName || inputData.model?.id || 'gemini-3.8-flash';
  ...
  66: if (schemaTokens > 0) {
  67:   const config = loadFlightcheckConfig();
  68:   const ceiling = resolveModelCeiling(modelId, inputData.context_window || inputData.contextWindow, { config });
  69:   sidecar.sensors.schemaTaxPct = Number(((schemaTokens / (ceiling || 256000)) * 100).toFixed(1));
  70: }
  ```
- **Root Cause**: Line 68 references undeclared identifier `modelId` instead of `activeModel`, causing `handleSessionStart` to throw a `ReferenceError` and skip `writeSidecarAtomicSync` whenever `inputData.mcpServers` is non-empty!
- **Drop-In Replacement Diff**:
```diff
--- a/src/hooks/session_start.mjs
+++ b/src/hooks/session_start.mjs
@@ -68,1 +68,1 @@
-    const ceiling = resolveModelCeiling(modelId, inputData.context_window || inputData.contextWindow, { config });
+    const ceiling = resolveModelCeiling(activeModel, inputData.context_window || inputData.contextWindow, { config });
```

---

## Class 4: Hardcoded Repo Paths & Non-Portable Commands

### 4.1 Non-Portable Local Script Invocations (`node src/cli/doctor.mjs ...`) & Unimplemented CLI Flags

#### Finding 4.1.a â€” `action_queue.mjs` and `horizon_panel.html` Emit Non-Portable `node src/cli/doctor.mjs` Commands with Non-Existent Flags (`--reap-orphans`, `--audit-mcp`, `--handoff`)
- **Files & Lines**:
  - `src/core/action_queue.mjs:84, 89` (`aq-orphan-reap`: `cliFlag: 'doctor --reap-orphans'`, `commandToCopy: 'node src/cli/doctor.mjs'`)
  - `src/core/action_queue.mjs:116` (`aq-idle-mcp`: `cliFlag: 'doctor --audit-mcp'`)
  - `src/core/action_queue.mjs:145, 150` (`aq-tool-prune`: `cliFlag: 'doctor --prune-tools'`, `commandToCopy: 'node src/cli/doctor.mjs --prune-tools'`)
  - `src/core/action_queue.mjs:200, 205` (`aq-cold-cliff`: `cliFlag: 'handoff --distill'`, `commandToCopy: 'node src/cli/doctor.mjs --handoff'`)
  - `src/webview/horizon_panel.html:3111` (`buildClientActionQueue` -> `aq-orphan-reap`: `commandToCopy: 'node src/cli/doctor.mjs'`)
  - `src/webview/horizon_panel.html:3201` (`buildClientActionQueue` -> `aq-cold-cliff`: `commandToCopy: 'node src/cli/doctor.mjs --handoff'`)
  - `src/cli/doctor.mjs:16-27` (`parseDoctorArgs`)
- **Reproduction Scenario**:
  1. A user runs `ctxtop` in any workspace other than `c:\Projects\ga-visualizer-v2`, or clicks an Action Queue button in `horizon_panel.html`.
  2. `action_queue.mjs` and `horizon_panel.html` copy `node src/cli/doctor.mjs`, `node src/cli/doctor.mjs --prune-tools`, or `node src/cli/doctor.mjs --handoff` to the clipboard. In any external project, `src/cli/doctor.mjs` does not exist (`Error: Cannot find module '.../src/cli/doctor.mjs'`).
  3. Furthermore, inspect `src/cli/doctor.mjs:16-27` (`parseDoctorArgs`):
     ```js
     export function parseDoctorArgs(argv = process.argv.slice(2)) {
       const pruneTools = argv.includes('--prune-tools');
       const gcCursor = argv.includes('--gc-cursor');
       const recoverBrain = argv.includes('--recover-brain');
       const storageGc = argv.includes('--storage-gc') || gcCursor || recoverBrain;
       ...
     ```
     **`doctor.mjs` does NOT implement `--handoff`, `--reap-orphans`, or `--audit-mcp`!** Running `doctor.mjs --handoff` or `doctor.mjs --reap-orphans` completely ignores the flag and just runs the generic health check!
- **Drop-In Replacement Diffs**:
  1. Replace `node src/cli/doctor.mjs ...` with portable `npx ctxtop ...` commands in `src/core/action_queue.mjs` and `src/webview/horizon_panel.html`.
  2. Support `--handoff` and `--reap-orphans` in `src/cli/doctor.mjs` and `src/cli/init.mjs` so those CLI flags actually work when executed!
```diff
--- a/src/core/action_queue.mjs
+++ b/src/core/action_queue.mjs
@@ -84,6 +84,6 @@
       cliFlag: 'doctor --reap-orphans',
       target: procSummary,
       payoff: `reclaims ${ramStr}`,
       reclaimTokens: 0,
       reclaimRamGb,
-      commandToCopy: 'node src/cli/doctor.mjs',
+      commandToCopy: 'npx ctxtop doctor --reap-orphans',
       apiAction: 'reap-orphans'
@@ -145,6 +145,6 @@
       cliFlag: 'prune',
       target: 'Tool Surgeon (--prune-tools)',
       payoff: `reclaims ~${tokK}k tok (zero LLM loss)`,
       reclaimTokens: reclaimableToolTokens,
       reclaimRamGb: 0,
-      commandToCopy: 'node src/cli/doctor.mjs --prune-tools',
+      commandToCopy: 'npx ctxtop prune',
       apiAction: 'condense-ast'
@@ -200,6 +200,6 @@
       cliFlag: 'doctor --handoff',
       target: `TTL expires in ${ttlSec}s`,
       payoff: 'avoids 12.5x cold cache rewrite',
       reclaimTokens: warmTokens,
       reclaimRamGb: 0,
-      commandToCopy: 'node src/cli/doctor.mjs --handoff',
+      commandToCopy: 'npx ctxtop doctor --handoff',
       apiAction: 'generate-handoff'
```
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3111,1 +3111,1 @@
-        commandToCopy: 'node src/cli/doctor.mjs',
+        commandToCopy: 'npx ctxtop doctor --reap-orphans',
@@ -3201,1 +3201,1 @@
-        commandToCopy: 'node src/cli/doctor.mjs --handoff',
+        commandToCopy: 'npx ctxtop doctor --handoff',
```
```diff
--- a/src/cli/doctor.mjs
+++ b/src/cli/doctor.mjs
@@ -12,11 +12,15 @@
+import { reapOrphanProcesses } from '../core/host_watchdog.mjs';
+import { generateHandoffMarkdown } from '../core/handoff_audit.mjs';
 
 export function parseDoctorArgs(argv = process.argv.slice(2)) {
   const pruneTools = argv.includes('--prune-tools');
+  const reapOrphans = argv.includes('--reap-orphans');
+  const handoff = argv.includes('--handoff') || argv.includes('--distill');
   const gcCursor = argv.includes('--gc-cursor');
   const recoverBrain = argv.includes('--recover-brain');
   const storageGc = argv.includes('--storage-gc') || gcCursor || recoverBrain;
   const dryRun = argv.includes('--dry-run');
   const tIdx = argv.indexOf('--transcript');
   const transcriptPath = tIdx !== -1 && argv[tIdx + 1] ? argv[tIdx + 1] : null;
   const vIdx = argv.indexOf('--vscdb');
   const vscdbPath = vIdx !== -1 && argv[vIdx + 1] ? argv[vIdx + 1] : null;
-  return { pruneTools, storageGc, gcCursor, recoverBrain, dryRun, transcriptPath, vscdbPath };
+  return { pruneTools, reapOrphans, handoff, storageGc, gcCursor, recoverBrain, dryRun, transcriptPath, vscdbPath };
 }
```

---

### 4.2 Windows-Only vs. POSIX Shell Assumptions

#### Finding 4.2.a â€” `layer5_hygiene.mjs` Generates POSIX-Only `tee ... | head -n 100 || true` Wrapper While `PROMPTS.truncate` Recommends PowerShell-Only `Select-Object -First 50`
- **Files & Lines**:
  - `src/core/layer5_hygiene.mjs:214-225` (`wrapNoisyCommandWithDampener`)
  - `src/core/layer5_hygiene.mjs:258-277` (`registerCliDampeningHook`)
  - `src/webview/horizon_panel.html:2400-2403` (`PROMPTS.truncate`)
  - `src/webview/horizon_panel.html:3233` (`renderState` -> workspace path splitting `raw.workspace.canonicalPath.split('/').pop()`)
- **Reproduction Scenarios & Root Causes**:
  1. **POSIX-only syntax on Windows (`layer5_hygiene.mjs:224, 261-262`)**:
     - `wrapNoisyCommandWithDampener` returns `(${cleanCmd}) 2>&1 | tee ${logFile} | head -n ${limit} || true`. In Windows PowerShell (`powershell.exe`), `|| true` is a syntax error (in PowerShell 5.1) and `head -n` does not exist natively (`Select-Object -First ${limit}` is required).
     - Meanwhile, `inlineGuardScript` at line 262 advises only `head -n ${limit}` even on Windows hosts (`process.platform === 'win32'`).
  2. **PowerShell-only syntax on macOS/Linux (`horizon_panel.html:2402`)**:
     - `PROMPTS.truncate.text` unconditionally leads with PowerShell `Select-Object -First 50` even on macOS/Linux hosts where `head -n 50` is standard.
  3. **Forward-slash-only path split on Windows (`horizon_panel.html:3233`)**:
     - Line 3233: `const rawWs = raw.workspace.canonicalPath.split('/').pop();` â€” if `canonicalPath` contains Windows backslashes (`C:\Projects\ga-visualizer-v2`), `.split('/')` fails to split the path, so `rawWs` is the entire path `"C:\\Projects\\ga-visualizer-v2"` instead of `"ga-visualizer-v2"`, causing the workspace comparison `rawWs.toLowerCase() !== currentWorkspaceBasename.toLowerCase()` at line 3234 to falsely mismatch on Windows!
- **Drop-In Replacement Diffs**:
```diff
--- a/src/core/layer5_hygiene.mjs
+++ b/src/core/layer5_hygiene.mjs
@@ -261,2 +261,2 @@
-    `if(cmd&&cmd.length>0&&!cmd.includes('head -n')&&!cmd.includes('Select-Object')){`,
-    `process.stdout.write(JSON.stringify({systemMessage:'[CLI Output Dampener] Pipe large command output through head -n ${limit} or ${logFile} to prevent >20k single-turn context bloat.'}));`,
+    `if(cmd&&cmd.length>0&&!cmd.includes('head -n')&&!cmd.includes('Select-Object')){`,
+    `process.stdout.write(JSON.stringify({systemMessage:'[CLI Output Dampener] Pipe large command output through head -n ${limit} (or Select-Object -First ${limit} on PowerShell) or redirect to ${logFile} to prevent >20k single-turn context bloat.'}));`,
```
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3233,1 +3233,1 @@
-        const rawWs = raw.workspace.canonicalPath.split('/').pop();
+        const rawWs = String(raw.workspace.canonicalPath).replace(/\\/g, '/').split('/').filter(Boolean).pop();
```

---

### 4.3 Cross-Surface Navigation & Session Switching Failures (`[CLI]` / `[IDE]` vs `[App]`)

#### Finding 4.3.a â€” Cross-Surface Detection (`isForeignSurface`) Fails When Inspecting `[CLI]` or `[IDE]` Sessions Because `latestAutoState` Is Overwritten by the Selected Foreign Session
- **Files & Lines**:
  - `src/webview/horizon_panel.html:3226` (`renderState`: `latestAutoState = raw;`)
  - `src/webview/horizon_panel.html:5419-5452` (`#btnOpenChat.onclick`)
  - `src/webview/horizon_panel.html:5455-5468` (`#sessionSelect.onchange`)
  - `sidecars/horizon-daemon/server.mjs:307-311` (`GET /api/state?conversationId=...`)
  - `sidecars/horizon-daemon/server.mjs:646-651` (`setInterval` SSE broadcast loop)
- **Reproduction Scenario**:
  1. The user opens the Horizon panel inside the Antigravity Desktop App (`[App]`, `storeSource: 'antigravity'`), where `window.sidecar.ui.toggleConversation` is defined, but `window.sidecar.surface` is `undefined`.
  2. The user selects a `[CLI]` session (`storeSource: 'antigravity-cli'`) or `[IDE]` session (`storeSource: 'antigravity-ide'`) from `#sessionSelect`.
  3. Look at what happens in `horizon_panel.html:5464`:
     - `#sessionSelect.onchange` fetches `/api/state?conversationId=<cli-session-id>`.
     - On the server (`server.mjs:308`), `pinnedConversationId` is set to `<cli-session-id>`.
     - Then, 2 seconds later, the SSE stream (`server.mjs:648`) calls `refreshLiveState(true)` (which uses `pinnedConversationId`!) and broadcasts the `[CLI]` session over `evtSource.onmessage` (`horizon_panel.html:5490`), which calls `renderState(JSON.parse(e.data))` with `fromCatalog = false`!
  4. Now look at `horizon_panel.html:3225-3226`:
     ```js
     if (!fromCatalog) {
       latestAutoState = raw;
     ```
     Because `fromCatalog` is `false` on every SSE broadcast, **`latestAutoState` is overwritten with the pinned `[CLI]` session!**
  5. Next, the user clicks **Open â†—** (`#btnOpenChat`, `horizon_panel.html:5422-5424`):
     ```js
     const targetSurface = currentRenderedState?.storeSource || selOpt?.dataset?.surface || 'antigravity';
     const hostSurface = window.sidecar?.surface || latestAutoState?.storeSource || 'antigravity';
     const isForeignSurface = Boolean(targetSurface && hostSurface && targetSurface !== hostSurface);
     ```
     Because `latestAutoState` was overwritten by the `[CLI]` session, `hostSurface` is now `'antigravity-cli'`, which equals `targetSurface` (`'antigravity-cli'`)!
     **Result**: `isForeignSurface` evaluates to **`false`**! Instead of calling `/api/open-brain` to open the `[CLI]` session's folder, line 5447 calls `window.sidecar.ui.toggleConversation(targetId)` inside `[App]` for a `[CLI]` session UUID that does not exist in `[App]`, silently failing to switch conversations while showing a fake toast: `âœ“ Switched IDE chat view to ...`!
  6. Furthermore, in `runPrompt` (`horizon_panel.html:2593-2598`), `CAN_INJECT` is checked without checking `isForeignSurface`. If a user is inspecting a `[CLI]` session from `[App]` and clicks a prompt button, `window.sidecar.agent.sendMessage(p.text, targetId)` attempts to inject the message into `[App]` for a `[CLI]` session ID instead of copying to clipboard!
- **Root Cause in Code**:
  1. `latestAutoState` in `horizon_panel.html:3226` is updated even when `selectedSessionMode !== 'auto'` or `raw.pinnedConversationId` is set, clobbering the host's initial `auto` surface state.
  2. `initialHostSurface` should be captured once on first unpinned auto state (`window.sidecar?.surface || initialHostSurface || 'antigravity'`).
  3. `runPrompt` (`horizon_panel.html:2593`) does not check `!isForeignSurfaceSession()` before calling `window.sidecar.agent.sendMessage`.
- **Drop-In Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -2271,4 +2271,12 @@
   let selectedSessionMode = 'auto';
   let latestAutoState = null;
+  let initialHostSurface = window.sidecar?.surface || null;
   let currentWorkspaceBasename = '';
+
+  function isCurrentSessionForeignSurface() {
+    const selOpt = document.getElementById('sessionSelect')?.selectedOptions?.[0];
+    const targetSurface = currentRenderedState?.storeSource || selOpt?.dataset?.surface || 'antigravity';
+    const hostSurface = window.sidecar?.surface || initialHostSurface || latestAutoState?.storeSource || 'antigravity';
+    return Boolean(targetSurface && hostSurface && targetSurface !== hostSurface);
+  }
@@ -2593,1 +2601,1 @@
-    if (CAN_INJECT) {
+    if (CAN_INJECT && !isCurrentSessionForeignSurface()) {
@@ -3225,3 +3233,6 @@
     if (!fromCatalog) {
-      latestAutoState = raw;
+      if (selectedSessionMode === 'auto' && !raw.pinnedConversationId) {
+        latestAutoState = raw;
+        if (!initialHostSurface && raw.storeSource) initialHostSurface = raw.storeSource;
+      }
       if (selectedSessionMode !== 'auto') {
@@ -5422,3 +5433,3 @@
     const targetSurface = currentRenderedState?.storeSource || selOpt?.dataset?.surface || 'antigravity';
-    const hostSurface = window.sidecar?.surface || latestAutoState?.storeSource || 'antigravity';
-    const isForeignSurface = Boolean(targetSurface && hostSurface && targetSurface !== hostSurface);
+    const isForeignSurface = isCurrentSessionForeignSurface();
```

---

## Summary Table of All Audited Findings

| ID | Bug Class | File & Line Numbers | Function / Component | Issue Summary |
| :--- | :--- | :--- | :--- | :--- |
| **3.1.a** | Class 3.1 (Tool/Payload Mismatch) | `src/core/classifier.mjs:1020-1032`, `src/webview/horizon_panel.html:3981-3985, 4990-5008` | `classifyHorizon` (`blowupSteps`), `renderState`, `renderSessionHealthSummary` (`dampen-blowup`) | `blowupSteps` only checks `Path`/`path`/`AbsolutePath`, missing `TargetFile`/`Target`/`target`/`step.targetPath` and file tool names; non-matched file spikes fall back to `kind: 'other'` and trigger CLI `Select-Object -First 50` prompts and `.agents/hooks.json` `PreToolUse` hook buttons. |
| **3.1.b** | Class 3.1 (Tool/Payload Mismatch) | `src/webview/horizon_panel.html:2400-2403, 4859-4861, 4940-4942, 5007-5008` | `PROMPTS.truncate`, `renderSessionHealthSummary` | `PROMPTS.truncate` conflates command/file outputs with PowerShell `Select-Object -First 50`; `#simpleActionList` cards render 2 competing buttons instead of 1. |
| **3.2.a** | Class 3.2 (Ephemeral vs. Persistent) | `src/webview/horizon_panel.html:4619-4632, 5035-5071, 5232-5243` | `#actionRowHighLeverage`, `chronic-read`, `initPromptButtons` | Cross-session `chronicReads` on source files only copies a 1-chat prompt instead of persisting a rule to `AGENTS.md`; clicking `#btnActionHighLeverage` (`data-action="prompt-subagent"`) is unhandled in `onclick` and silently switches to Advanced view. |
| **3.2.b** | Class 3.2 (Ephemeral vs. Persistent) | `src/core/action_queue.mjs:121-122`, `src/webview/horizon_panel.html:3133-3134, 4462-4480` | `buildActionQueue`, `buildClientActionQueue`, `.aq-btn` onclick | `aq-idle-mcp` (`mcp-switch-lazy`) is unhandled in the `.aq-btn` click listener and copies a non-executable `// Switch ...` comment. |
| **3.3.a** | Class 3.3 (Antigravity Physics) | `src/webview/horizon_panel.html:2153, 4937, 5345-5352` | `#btnCondenseAst` (`btnCondense.onclick`) | UI copy claims "Prefix-Cache Safe (requires confirmation if cache is warm)", but `btnCondense.onclick` hardcodes `forceHotCache: true` on the first POST to `/api/prune`, bypassing `pruner.mjs`'s warm-cache confirmation guard and busting warm KV cache. |
| **3.3.b** | Class 3.3 (Antigravity Physics) | `src/webview/horizon_panel.html:3763-3765` | `renderState` (`#compactReclaim`) | Claims bare `/compact` *"keeps rules, plan & code intact"*, whereas bare `/compact` summarizes turns and drops raw file buffers. |
| **3.3.c** | Class 3.3 (Antigravity Physics) | `src/core/classifier.mjs:307, 1068, 1219`, `src/webview/horizon_panel.html:2654, 4176, 4582, 4785` | `evaluateCompositeSessionRisk`, `renderState`, `renderSessionHealthSummary` | When `task.md` was never created (`lastTaskWrite === -1`, `exists === false`), `taskTurnsBehind` counts all user turns and flags `task.md` as `"N turns stale"` / `"task.md stale â€¢ not saved yet"`, and `exists !== false` defaults `undefined` to `true`. |
| **3.4.a** | Class 3.4 (Template Fallbacks) | `src/webview/horizon_panel.html:2318-2324`, `src/core/classifier.mjs:655-658` | `formatShortPath`, `classifyHorizon` | `formatShortPath` returns literal `'unknown'` on empty input and does not filter `.system_generated/steps/<id>/output.txt` paths. |
| **3.4.b** | Class 3.4 (Template Fallbacks) | `src/core/handoff_audit.mjs:328, 352-353` | `generateHandoffMarkdown` | Emits literal ``(`unknown`)`` when `state.sessionId` is missing and emits generic placeholder `3) Explicit user constraints: [preserve all active invariants and user rules]`. |
| **3.4.c** | Class 3.4 (Template Fallbacks) | `src/hooks/pre_invocation.mjs:262-267` | `handlePreInvocation` | Hardcodes `@src/index.js` fallback in Rewrite Scorecard when `activeSetPaths` is empty, and does not normalize `activeSetPaths[0]` to a workspace-relative path. |
| **3.4.d** | Class 3.4 (Runtime Bug in Hook) | `src/hooks/session_start.mjs:36, 68` | `handleSessionStart` | References undeclared `modelId` instead of `activeModel` when `inputData.mcpServers` is non-empty, throwing `ReferenceError`. |
| **4.1.a** | Class 4.1 (Non-Portable CLI) | `src/core/action_queue.mjs:89, 150, 205`, `src/webview/horizon_panel.html:3111, 3201`, `src/cli/doctor.mjs:16-27` | `buildActionQueue`, `buildClientActionQueue`, `parseDoctorArgs` | Emits non-portable `node src/cli/doctor.mjs`, `node src/cli/doctor.mjs --prune-tools`, and `node src/cli/doctor.mjs --handoff` instead of `npx ctxtop ...`, and `doctor.mjs` does not parse `--handoff` or `--reap-orphans`. |
| **4.2.a** | Class 4.2 (OS/Path Assumptions) | `src/core/layer5_hygiene.mjs:224, 261-262`, `src/webview/horizon_panel.html:2402, 3233` | `wrapNoisyCommandWithDampener`, `registerCliDampeningHook`, `renderState` | `layer5_hygiene.mjs` only mentions `head -n` in its hook message; `PROMPTS.truncate` leads with PowerShell `Select-Object -First 50`; `horizon_panel.html:3233` splits `canonicalPath` only on `'/'`, failing on Windows `\` paths. |
| **4.3.a** | Class 4.3 (Cross-Surface Navigation) | `src/webview/horizon_panel.html:2593, 3226, 5419-5452` | `renderState`, `#btnOpenChat.onclick`, `runPrompt` | `latestAutoState` is overwritten by SSE broadcasts after selecting a `[CLI]`/`[IDE]` session, making `hostSurface === targetSurface` (`isForeignSurface = false`), so `window.sidecar.ui.toggleConversation` and `sendMessage` are called on foreign-surface sessions. |



---

### Bug Class 5: Mathematical, Unit-Scope & Rounding Drift (Core & UI)

 â€” Class 5 (Core Math): Mathematical, Unit-Scope & Rounding Drift

### 2.1 Bucket Sums vs. Totals & Reclaimable Token Discrepancies

#### Issue C5-01: `classifier.mjs` Reclaimable Token Bucket Sum (`duplicateReads` + `oldHistory` + `deadErrors`) Does NOT Equal `metrics.sludgeTokens` (`FOREIGN_BLEED` Omitted from `brainSignals` & `action_queue.mjs`, and `displayParity` Missing `anchorReclaimTenths`)
- **File**: `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs` (lines `920â€“924`, `1140â€“1163`, `1453`) and `c:\Projects\ga-visualizer-v2\src\core\action_queue.mjs` (lines `127â€“130`)
- **Functions**: `classifyHorizon`, `computeDisplayTenthsParity`, `buildActionQueue`
- **Mathematical Discrepancy**:
  1. **Active Signal + Sludge Sum vs. `totalActiveTokens` (`classifier.mjs:920, 924`)**:
     - Line 582 defines 6 active categories in `categoryTotals`:
       `ANCHOR`, `MEMORY_KI`, `FOREIGN_BLEED`, `STALE_DUPLICATE`, `DEAD_ERROR`, `ACTIVE_WORKING_SET`.
     - Line 920: `const signalTokens = categoryTotals[CATEGORIES.ANCHOR] + categoryTotals[CATEGORIES.ACTIVE_WORKING_SET];`
     - Line 924: `const sludgeTokens = categoryTotals[CATEGORIES.STALE_DUPLICATE] + categoryTotals[CATEGORIES.DEAD_ERROR] + categoryTotals[CATEGORIES.FOREIGN_BLEED];`
     - Notice **`categoryTotals[CATEGORIES.MEMORY_KI]` is excluded from `signalTokens` AND excluded from `sludgeTokens`**!
     - Yet on line 1453:
       `displayParity: computeDisplayTenthsParity(totalActiveTokens, Math.max(0, totalActiveTokens - sludgeTokens))`
       Here, `activeSignalTokens` is passed as `totalActiveTokens - sludgeTokens` (which **includes** `MEMORY_KI`), whereas `signalPurityPct` on line 921 uses `signalTokens / totalActiveTokens` (which **excludes** `MEMORY_KI`)! Thus, in any session with `MEMORY_KI > 0`, `signalPurityPct` is lower than `activeK / totalK`!
  2. **Reclaimable Sub-Buckets vs. `sludgeTokens` (`classifier.mjs:1140â€“1163`, `1453`)**:
     - `sludgeTokens` = `STALE_DUPLICATE + DEAD_ERROR + FOREIGN_BLEED`.
     - In `brainSignals` (lines 1140â€“1163):
       - `brainSignals.duplicateReads.reclaimableTokens` = sum of `STALE_DUPLICATE` where `target !== 'Older chat history (>25 turns ago)'`
       - `brainSignals.oldHistory.reclaimableTokens` = `STALE_DUPLICATE` where `target === 'Older chat history (>25 turns ago)'`
       - `brainSignals.deadErrors.reclaimableTokens` = `categoryTotals[CATEGORIES.DEAD_ERROR]`
       - **`FOREIGN_BLEED` is completely missing from `brainSignals` reclaimable buckets**, so `duplicateReads + oldHistory + deadErrors !== sludgeTokens` whenever `FOREIGN_BLEED > 0`!
     - Furthermore, when each row (`duplicateReads`, `oldHistory`, `deadErrors`) is rounded to `0.1k` (tenths of a kilotoken) in the UI/CLI, the sum of the rounded rows (`Math.round(dup / 100) + Math.round(old / 100) + Math.round(err / 100)`) can drift by `Â±0.1kâ€“0.2k` from `displayParity.reclaimableK` because `classifier.mjs:1453` calls `computeDisplayTenthsParity(totalActiveTokens, Math.max(0, totalActiveTokens - sludgeTokens))` **without passing the 3rd parameter `anchorReclaimTenths`** (which `computeDisplayTenthsParity` at line 382 was specifically designed to accept!).
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -917,7 +917,7 @@ export function classifyHorizon(rawSteps, options = {}) {
   }
 
   // Metrics computation
-  const signalTokens = categoryTotals[CATEGORIES.ANCHOR] + categoryTotals[CATEGORIES.ACTIVE_WORKING_SET];
+  const signalTokens = categoryTotals[CATEGORIES.ANCHOR] + categoryTotals[CATEGORIES.ACTIVE_WORKING_SET] + categoryTotals[CATEGORIES.MEMORY_KI];
   const signalPurityPct = Math.round((signalTokens / Math.max(1, totalActiveTokens)) * 100);
 
   const pricePerM = resolvePricePerM(modelId, activeConfig);
@@ -1161,6 +1161,10 @@ export function classifyHorizon(rawSteps, options = {}) {
         wastedTokens: o.wastedTokens
       }))
     },
+    foreignBleed: {
+      reclaimableTokens: categoryTotals[CATEGORIES.FOREIGN_BLEED] || 0
+    },
     blowupSteps,
@@ -1450,7 +1454,13 @@ export function classifyHorizon(rawSteps, options = {}) {
       sludgeTaxPerTurnUsd,
       totalTurnCostUsd,
       healthBand,
-      displayParity: computeDisplayTenthsParity(totalActiveTokens, Math.max(0, totalActiveTokens - sludgeTokens))
+      displayParity: computeDisplayTenthsParity(
+        totalActiveTokens,
+        Math.max(0, totalActiveTokens - sludgeTokens),
+        Math.round((brainSignals.duplicateReads.reclaimableTokens || 0) / 100) +
+          Math.round((brainSignals.oldHistory.reclaimableTokens || 0) / 100) +
+          Math.round((brainSignals.deadErrors.reclaimableTokens || 0) / 100) +
+          Math.round(((categoryTotals[CATEGORIES.FOREIGN_BLEED] || 0)) / 100)
+      )
     },
```

---

#### Issue C5-02: `classifier.mjs` 40-Cell Token Partitioning Overflow (`effectiveCellSize * 40 !== effectiveMaxTokens` & `FREE_HEADROOM` Sum Drift)
- **File**: `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs`
- **Lines**: `745â€“784`
- **Function**: `classifyHorizon`
- **Mathematical Discrepancy**:
  1. On line 745:
     ```js
     const effectiveCellSize = Math.max(
       Math.round(effectiveMaxTokens / HORIZON_WINDOW.TOTAL_CELLS),
       Math.ceil(totalActiveTokens / HORIZON_WINDOW.TOTAL_CELLS) || HORIZON_WINDOW.CELL_SIZE_TOKENS
     );
     ```
     And on line 750:
     `const freeHeadroom = Math.max(0, effectiveMaxTokens - totalActiveTokens);`
     `categoryTotals[CATEGORIES.FREE_HEADROOM] = freeHeadroom;`
  2. Now trace the 40 cells loop (lines 760â€“866):
     - Suppose `effectiveMaxTokens = 256000` (`effectiveCellSize = 6400`), and `totalActiveTokens = 10000`.
     - Cell 0 consumes `6400` active tokens.
     - Cell 1 (`cellStartToken = 6400`) has `bucketTokensRemaining = Math.min(6400, 10000 - 6400) = 3600` active tokens. Notice the remaining `2800` tokens of Cell 1 are **not added to `bucketCategories[CATEGORIES.FREE_HEADROOM]`**, so Cell 1's `tokensByCategory` sums to `3600` instead of `6400`!
     - Cells `2..39` (38 cells) each get `tokensByCategory: { [CATEGORIES.FREE_HEADROOM]: 6400 }`.
     - Sum of `FREE_HEADROOM` across the 40 cells = `38 * 6400 = 243,200` tokens, whereas `categoryTotals[CATEGORIES.FREE_HEADROOM]` = `256,000 - 10,000 = 246,000` tokens! The `2,800` headroom tokens in the partially-filled Cell 1 vanish from the cell category sums!
- **Root Cause**:
  In the partially-filled boundary cell (where `totalActiveTokens - cellStartToken < effectiveCellSize`), the unused capacity of that cell (`effectiveCellSize - activeConsumedInCell`) is not assigned to `bucketCategories[CATEGORIES.FREE_HEADROOM]`.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -831,6 +831,11 @@ export function classifyHorizon(rawSteps, options = {}) {
         stepTokenOffset = 0;
       }
     }
+    const cellUsedTokens = Object.values(bucketCategories).reduce((s, v) => s + v, 0);
+    if (cellUsedTokens < effectiveCellSize) {
+      bucketCategories[CATEGORIES.FREE_HEADROOM] = (bucketCategories[CATEGORIES.FREE_HEADROOM] || 0) + (effectiveCellSize - cellUsedTokens);
+    }
```

---

#### Issue C5-03: `action_queue.mjs` Sums Overlapping & Non-Reclaimable Token Scopes (`IDLE_MCP` per-turn schema + `STALE_TOOLS` history + `TROUGH_SPEC` weight + `COLD_CACHE_CLIFF` full window) into a Single `"reclaimable"` Headline Total
- **File**: `c:\Projects\ga-visualizer-v2\src\core\action_queue.mjs`
- **Lines**: `119`, `148`, `176`, `203`, `236â€“242`
- **Functions**: `buildActionQueue`, `formatActionQueueAnsi`
- **Mathematical & Unit-Scope Discrepancy**:
  1. Look at what `reclaimTokens` represents across the 4 token-bearing items in `buildActionQueue`:
     - `IDLE_MCP` (line 119): `reclaimTokens: totalSchemaTok` â€” static schema tokens per turn (More importantly, `baseline.mjs:334` defines `reclaimableEagerSchemaTokens` as `r.schemaTokens - r.listingTokens`, because switching to lazy still keeps `listingTokens` in context, whereas `action_queue.mjs:106` uses the gross `r.schemaTokens` without subtracting `r.listingTokens`!).
     - `STALE_TOOLS` (line 148): `reclaimTokens: reclaimableToolTokens` (`dupTokens + deadErrorTokens + oldHistTokens`).
     - `TROUGH_SPEC` (line 176): `reclaimTokens: Number(troughSpecCell.tokenWeight || 6400)` â€” re-anchoring a spec cell does **NOT** reclaim/delete those tokens from the context window; it moves/repeats the spec in the active turn!
     - `COLD_CACHE_CLIFF` (line 203): `reclaimTokens: warmTokens` (`totalActiveTokens`, e.g., `120,000` tokens) â€” this is the entire active context window (which already includes `STALE_TOOLS`, `IDLE_MCP`, and `TROUGH_SPEC`!).
  2. Then in `formatActionQueueAnsi` (lines 236â€“242):
     `const totalTok = queue.reduce((s, item) => s + (item.reclaimTokens || 0), 0);`
     `const summaryStr = parts.length > 0 ? \` â€” ${parts.join(' + ')} reclaimable\` : '';`
     If a 100k session has 20k `STALE_TOOLS`, 6.4k `TROUGH_SPEC`, and a `COLD_CACHE_CLIFF` (100k `warmTokens`), `formatActionQueueAnsi` adds them together and prints:
     **`ACTION QUEUE (3) â€” 126.4k tok reclaimable`** on a **100.0k token session** (claiming 126.4% of the session's total tokens are reclaimable)!
- **Root Cause**:
  1. `COLD_CACHE_CLIFF` (`warmTokens`) and `TROUGH_SPEC` (`tokenWeight`) are not context-window token reductions; setting `reclaimTokens` on them causes `formatActionQueueAnsi` to double-count `totalActiveTokens` + `reclaimableToolTokens` + `cell.tokenWeight` as a single additive `"reclaimable"` sum that exceeds `totalActiveTokens`.
  2. `IDLE_MCP` uses gross `s.schemaTokens` instead of net `Math.max(0, (s.schemaTokens || 0) - (s.listingTokens || 0))` (mismatching `baseline.mjs:334`).
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/action_queue.mjs
+++ b/src/core/action_queue.mjs
@@ -103,7 +103,7 @@ export function buildActionQueue(state = {}) {
   );
 
   if (eligibleEager.length > 0 && turns >= ACTION_QUEUE_CONFIG.IDLE_MCP_MIN_TURNS) {
-    const totalSchemaTok = eligibleEager.reduce((s, r) => s + (r.schemaTokens || 0), 0);
+    const totalSchemaTok = eligibleEager.reduce((s, r) => s + Math.max(0, (r.schemaTokens || 0) - (r.listingTokens || 0)), 0);
     const serverNames = eligibleEager.map(s => s.name).join(', ');
     const tokK = (totalSchemaTok / 1000).toFixed(1);
@@ -173,7 +173,7 @@ export function buildActionQueue(state = {}) {
       cliFlag: 'checkpoint --reanchor',
       target: `Cell #${cellNum} (${baseFile})`,
       payoff: `restores recall weight (+${recallGain}% attention)`,
-      reclaimTokens: Number(troughSpecCell.tokenWeight || 6400),
+      reclaimTokens: 0,
       reclaimRamGb: 0,
       commandToCopy: `Re-anchor ${baseFile} checklist to active turn`,
       apiAction: 'reanchor-spec'
@@ -200,7 +200,7 @@ export function buildActionQueue(state = {}) {
       cliFlag: 'handoff --distill',
       target: `TTL expires in ${ttlSec}s`,
       payoff: 'avoids 12.5x cold cache rewrite',
-      reclaimTokens: warmTokens,
+      reclaimTokens: 0,
       reclaimRamGb: 0,
       commandToCopy: 'node src/cli/doctor.mjs --handoff',
       apiAction: 'generate-handoff'
```

---

#### Issue C5-04: `offenders.mjs` Uses 3 Different Magic Fallback Token Multipliers (`2000`, `1800`, `1500`) and Conflates `totalReads` with `repeated re-reads (k tokens)` in `bannerText`
- **File**: `c:\Projects\ga-visualizer-v2\src\core\offenders.mjs`
- **Lines**: `57`, `89`, `95`, `100`, `113`, `115`
- **Functions**: `recordSession`, `aggregate`, `formatCrossSessionBanner`
- **Mathematical & Unit-Scope Discrepancy**:
  1. Look at the three inconsistent token fallback formulas across `offenders.mjs`:
     - Line 57 (`recordSession`): `wastedTokens: Number(f.wastedTokens || ((f.occurrences - 1) * 2000) || 0)` (`2000` tok per repeat read)
     - Line 89 (`aggregate`): `agg.totalWastedTokens += Number(f.wastedTokens || ((f.reads || 1) * 1800) || 0)` (`1800` tok * total reads, not `reads - 1`!)
     - Line 95 (`aggregate`) & Line 113 (`formatCrossSessionBanner`): `const wastedK = Math.max(1, Math.round((a.totalWastedTokens || a.totalReads * 1500) / 1000))` (`1500` tok * total reads!)
  2. Furthermore, in `classifier.mjs` (lines 662â€“665 & 685â€“691), `off.occurrences` counts **only the wasted/superseded read steps** (`wasteTargetByStep.has(idx)`, which marks `first.idx` â€” i.e., if a file is read 2 times, `wasteTargetByStep` marks 1 step, so `off.occurrences === 1`!).
     Then `offenders.mjs:53` filters:
     `.filter(f => f && f.path && (f.occurrences || 0) >= 2)`
     Because `classifier.mjs` only increments `off.occurrences` on steps in `wasteTargetByStep` (which has `occurrences = totalReads - 1`), a file read **twice** in a session has `off.occurrences === 1` in `classifier.mjs` and is **silently dropped** by `offenders.mjs:53` (`occurrences >= 2` requires the file to be read **3+ times** in a single session!).
     And in `classifier.mjs:958â€“960`:
     `Fold ${Math.max(1, off.occurrences - 1)} superseded read(s)` â€” since `off.occurrences` is *already* the count of superseded reads (`totalReads - 1`), subtracting `1` again undercounts superseded reads by 1!
- **Root Cause**:
  1. In `classifier.mjs`, `off.occurrences` for `STALE_DUPLICATE` file offenders only counts the `first.idx` steps in `wasteTargetByStep` (`N - 1` wasted reads), whereas `classifier.mjs:958, 960` and `offenders.mjs:53, 57` assume `off.occurrences` is total reads (`N`), subtracting `1` a second time (`occurrences - 1`) and filtering `occurrences >= 2`.
  2. `offenders.mjs` uses `2000`, `1800`, and `1500` across three functions for the same fallback estimate.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/offenders.mjs
+++ b/src/core/offenders.mjs
@@ -13,6 +13,7 @@ import { canonicalizePath } from './paths.mjs';
 
 export const OFFENDER_RETENTION = { maxSessions: 20, maxDays: 14 };
 export const CHRONIC_MIN_SESSIONS = 3;
+const FALLBACK_TOKENS_PER_WASTED_READ = 2000;
 
 export function offendersFile(cacheDir) {
   return path.join(cacheDir, 'offenders.jsonl');
@@ -50,11 +51,11 @@ function sameFiles(a, b) {
  */
 export function recordSession(cacheDir, sessionId, duplicateFiles = [], opts = OFFENDER_RETENTION, now = Date.now()) {
   const files = (duplicateFiles || [])
-    .filter(f => f && f.path && (f.occurrences || 0) >= 2)
+    .filter(f => f && f.path && (f.occurrences || 0) >= 1)
     .map(f => ({
       path: String(f.path),
       reads: f.occurrences,
-      wastedTokens: Number(f.wastedTokens || ((f.occurrences - 1) * 2000) || 0)
+      wastedTokens: Number(f.wastedTokens || (Math.max(1, f.occurrences - 1) * FALLBACK_TOKENS_PER_WASTED_READ) || 0)
     }))
     .sort((a, b) => a.path.localeCompare(b.path));
   const entries = readSessions(cacheDir);
@@ -86,13 +87,13 @@ export function aggregate(entries, opts = OFFENDER_RETENTION, now = Date.now())
       const agg = map.get(key) || { path: f.path, key, sessions: 0, totalReads: 0, totalWastedTokens: 0 };
       agg.sessions += 1;
       agg.totalReads += f.reads || 0;
-      agg.totalWastedTokens += Number(f.wastedTokens || ((f.reads || 1) * 1800) || 0);
+      agg.totalWastedTokens += Number(f.wastedTokens || (Math.max(1, (f.reads || 2) - 1) * FALLBACK_TOKENS_PER_WASTED_READ) || 0);
       map.set(key, agg);
     }
   }
   return [...map.values()]
     .map(a => {
-      const wastedK = Math.max(1, Math.round((a.totalWastedTokens || a.totalReads * 1500) / 1000));
+      const wastedK = Math.max(1, Math.round((a.totalWastedTokens || Math.max(1, a.totalReads - a.sessions) * FALLBACK_TOKENS_PER_WASTED_READ) / 1000));
       const baseName = path.basename(String(a.path || 'file'));
       return {
         ...a,
@@ -110,7 +111,7 @@ export function formatCrossSessionBanner(chronicReads = []) {
   if (!top || !top.path) return '';
   if (top.bannerText) return top.bannerText;
   const n = top.windowSessions || top.sessions || 3;
-  const wastedK = Math.max(1, Math.round((top.totalWastedTokens || (top.totalReads || 2) * 1500) / 1000));
+  const wastedK = Math.max(1, Math.round((top.totalWastedTokens || Math.max(1, (top.totalReads || 2) - 1) * FALLBACK_TOKENS_PER_WASTED_READ) / 1000));
   const baseName = path.basename(String(top.path));
   return `Across last ${n} sessions, ${baseName} caused ${wastedK}k repeated re-reads`;
 }
```

---

#### Issue C5-05: `quota.mjs` Conflates Cumulative Multi-Turn `sessionInputTokens` with Current Context Window Size, and Double-Counts `modelUsage` Ephemeral Cache Tokens in `computeDualTtlState`
- **File**: `c:\Projects\ga-visualizer-v2\src\core\quota.mjs`
- **Lines**: `529â€“549`, `607â€“616`, `951â€“970`
- **Functions**: `computeQuotaAndCacheTelemetry`, `computeDualTtlState`
- **Mathematical & Unit-Scope Discrepancy**:
  1. **Double-counting `ephemeral1hTokens` / `ephemeral5mTokens` in `computeDualTtlState` (`quota.mjs:951â€“970`)**:
     Look at lines 951â€“970:
     ```js
     const modelUsage = s.costState?.modelUsage || s['cost-state']?.modelUsage || s.modelUsage || {};
     let turn1h = Number(
       s.cacheCreationEphemeral1hInputTokens ??
       s.usage?.cache_creation_ephemeral_1h_input_tokens ??
       modelUsage.cacheCreationEphemeral1hInputTokens ??
       0
     );
     ...
     for (const val of Object.values(modelUsage)) {
       if (val && typeof val === 'object') {
         turn1h += Number(val.cacheCreationEphemeral1hInputTokens || 0);
         turn5m += Number(val.cacheCreationEphemeral5mInputTokens || 0);
       }
     }
     ```
     When a step has **both** top-level `s.cacheCreationEphemeral1hInputTokens` (or `s.usage.cache_creation_ephemeral_1h_input_tokens`) **and** `s.modelUsage[modelName].cacheCreationEphemeral1hInputTokens`, `turn1h` initializes to the top-level value and then **adds `modelUsage[modelName]` on top of it**, **doubling (2x) the token count**!
  2. **Double-counting `sessionCacheCreationTokens` in `totalPromptTokens` and `weightedUnits` (`quota.mjs:607, 612â€“616`)**:
     In Anthropic / Vertex / Antigravity usage payloads, `input_tokens` (`rawInput`) in some surfaces includes `cache_creation_input_tokens`, or when `rawCacheCreate` is tracked separately:
     Look at `detectRouterThrash` (`quota.mjs:379`):
     `const totalPrompt = Number(lastTurn?.cacheReadTokens || 0) + Number(lastTurn?.inputTokens || 0);` (does NOT include `cacheCreationTokens`), whereas `computeQuotaAndCacheTelemetry` (`quota.mjs:607`) computes:
     `const totalPromptTokens = sessionCacheReadTokens + sessionCacheCreationTokens + sessionInputTokens;` (DOES include `cacheCreationTokens`).
     So `detectRouterThrash` (`line 380`) and `computeQuotaAndCacheTelemetry` (`line 608`) compute two different cache hit percentages for the exact same turn when `cacheCreationTokens > 0`!
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/quota.mjs
+++ b/src/core/quota.mjs
@@ -376,7 +376,7 @@ export function detectRouterThrash(recentTurns = [], isAutoMode = false, {
   const currentShortName = lastTurn ? resolveModelShortName(lastTurn.modelRaw || lastTurn.model || lastTurn.modelId) : 'Model';
   const currentDisplayName = lastTurn ? resolveModelPoolDisplayName(lastTurn.modelId || lastTurn.model) : 'Model';
 
-  const totalPrompt = Number(lastTurn?.cacheReadTokens || 0) + Number(lastTurn?.inputTokens || 0);
+  const totalPrompt = Number(lastTurn?.cacheReadTokens || 0) + Number(lastTurn?.cacheCreationTokens || 0) + Number(lastTurn?.inputTokens || 0);
   const cacheHitPct = totalPrompt > 0 ? (Number(lastTurn?.cacheReadTokens || 0) / totalPrompt) * 100 : 0;
```
```diff
@@ -962,10 +962,12 @@ export function computeDualTtlState(steps = [], { nowMs = Date.now(), subagentSt
       0
     );
 
-    for (const val of Object.values(modelUsage)) {
-      if (val && typeof val === 'object') {
-        turn1h += Number(val.cacheCreationEphemeral1hInputTokens || 0);
-        turn5m += Number(val.cacheCreationEphemeral5mInputTokens || 0);
+    if (turn1h === 0 && turn5m === 0) {
+      for (const val of Object.values(modelUsage)) {
+        if (val && typeof val === 'object') {
+          turn1h += Number(val.cacheCreationEphemeral1hInputTokens || 0);
+          turn5m += Number(val.cacheCreationEphemeral5mInputTokens || 0);
+        }
       }
     }
```

---

#### Issue C5-06: `classifier.mjs` Step Token Scaling with `stdinContextWindow.total_input_tokens` Fails to Scale `rawLiveTokens`, Breaking `brainSignals.activeSignal.liveSessionTokens`
- **File**: `c:\Projects\ga-visualizer-v2\src\core\classifier.mjs`
- **Lines**: `714â€“739`, `1134`
- **Function**: `classifyHorizon`
- **Mathematical Discrepancy**:
  1. Before `stdinContextWindow` scaling (line 714):
     `const rawTotalTokens = Math.max(1, totalActiveTokens);`
     And `rawLiveTokens` is accumulated during the pre-scaled step loop (line 702).
  2. When `stdinContextWindow.total_input_tokens > 0` (lines 716â€“739), `totalActiveTokens` is replaced with `stdinContextWindow.total_input_tokens`, and all `classifiedSteps` and `categoryTotals` are scaled, **plus `residual` is added to `maxStep` (lines 727â€“735)**.
  3. On line 1134:
     `liveSessionTokens: Math.round((rawLiveTokens / rawTotalTokens) * totalActiveTokens)`
     Because `residual` was added to `maxStep.Category` in `categoryTotals`, `Math.round((rawLiveTokens / rawTotalTokens) * totalActiveTokens)` can differ by 1â€“2 tokens from the actual sum of `s.tokens` for live steps in `classifiedSteps`!
     Even worse: if `totalActiveTokens === 0` before `stdinContextWindow` scaling (e.g. empty steps array with `stdinContextWindow.total_input_tokens = 15000`), `classifiedSteps` is empty, so `categoryTotals` remains `0` for all active categories while `totalActiveTokens = 15000` â€” causing the sum of `breakdown` active categories (`0`) to not equal `window.totalActiveTokens` (`15000`)!
- **Root Cause**:
  1. When `classifiedSteps.length === 0` and `stdinContextWindow.total_input_tokens > 0`, `categoryTotals[CATEGORIES.ANCHOR]` is not populated with `totalActiveTokens`.
  2. `liveSessionTokens` is computed from the pre-residual ratio instead of summing the scaled `classifiedSteps`.
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/classifier.mjs
+++ b/src/core/classifier.mjs
@@ -725,13 +725,16 @@ export function classifyHorizon(rawSteps, options = {}) {
     }
     const scaledSum = Object.values(categoryTotals).reduce((acc, v) => acc + v, 0);
     const residual = totalActiveTokens - scaledSum;
-    if (residual !== 0 && classifiedSteps.length > 0) {
-      let maxStep = classifiedSteps[0];
-      for (const s of classifiedSteps) {
-        if (s.tokens > maxStep.tokens) maxStep = s;
+    if (residual !== 0) {
+      if (classifiedSteps.length > 0) {
+        let maxStep = classifiedSteps[0];
+        for (const s of classifiedSteps) {
+          if (s.tokens > maxStep.tokens) maxStep = s;
+        }
+        maxStep.tokens = Math.max(0, maxStep.tokens + residual);
+        categoryTotals[maxStep.category] = Math.max(0, (categoryTotals[maxStep.category] || 0) + residual);
+      } else {
+        categoryTotals[CATEGORIES.ANCHOR] = Math.max(0, (categoryTotals[CATEGORIES.ANCHOR] || 0) + residual);
       }
-      maxStep.tokens = Math.max(0, maxStep.tokens + residual);
-      categoryTotals[maxStep.category] = Math.max(0, (categoryTotals[maxStep.category] || 0) + residual);
     }
     for (const off of offenderMap.values()) {
```

---

#### Issue C5-07: `layer5_hygiene.mjs` Normalized Line Insertion Position Uses `insertIdx / totalLinesAfter` Instead of `insertIdx / (totalLinesAfter - 1)` and Off-By-One Primacy/Recency Boundary
- **File**: `c:\Projects\ga-visualizer-v2\src\core\layer5_hygiene.mjs`
- **Lines**: `329â€“349` (`computeAttentionZoneInsertionIndex`) and `478â€“485` (`promoteRuleWithAttentionZone`)
- **Functions**: `computeAttentionZoneInsertionIndex`, `promoteRuleWithAttentionZone`
- **Mathematical Discrepancy**:
  1. In `computeAttentionZoneInsertionIndex` (lines 329â€“331):
     ```js
     if (total <= 3) {
       return normalizedZone === 'primacy' ? Math.min(1, total) : total;
     }
     ```
     When `lines` has `total = 2` lines and `zone = 'primacy'`, `insertIdx` is `1`.
     Then in `promoteRuleWithAttentionZone` (lines 478â€“483):
     `totalLinesAfter` is `3`.
     `normalizedPosition = parseFloat((insertIdx / totalLinesAfter).toFixed(3))` = `1 / 3 = 0.333`.
     Line 483: `const inPrimacyZone = normalizedPosition <= 0.30;` -> **`false` (`0.333 > 0.30`)**!
     So promoting a rule into the `'primacy'` zone of a 2-line file returns **`inPrimacyZone: false`**!
  2. Similarly, for `total = 4` lines and `zone = 'primacy'` when line 0 is `# Heading`:
     Line 334: `maxPrimacyLine = Math.max(1, Math.floor(4 * 0.25))` = `1`.
     Line 339 returns `insertIdx = 1`.
     `totalLinesAfter = 5`. `insertIdx / (totalLinesAfter - 1) = 1 / 4 = 0.25`, or `1 / 5 = 0.20`.
     Wait: what if `total = 3` lines and `zone = 'primacy'`? `insertIdx = 1`, `totalLinesAfter = 4`, `1 / 4 = 0.25 <= 0.30` (`true`), whereas for `total = 2` lines, `insertIdx = 1`, `totalLinesAfter = 3`, `1 / 3 = 0.333 > 0.30` (`false`)!
- **Root Cause**:
  For `total <= 2` in `computeAttentionZoneInsertionIndex`, inserting at index `1` places the rule at `1/3 = 33.3%` (> 30% primacy threshold). And when `requestedZone === 'primacy'`, `insertIdx` for `total <= 2` must be `0` (or `inPrimacyZone` must account for small line counts `totalLinesAfter <= 4`).
- **Drop-in Replacement Diff**:
```diff
--- a/src/core/layer5_hygiene.mjs
+++ b/src/core/layer5_hygiene.mjs
@@ -327,7 +327,7 @@ export function computeAttentionZoneInsertionIndex(lines = [], zone = 'primacy')
   const normalizedZone = String(zone || 'primacy').toLowerCase() === 'recency' ? 'recency' : 'primacy';
 
   if (total <= 3) {
-    return normalizedZone === 'primacy' ? Math.min(1, total) : total;
+    return normalizedZone === 'primacy' ? (total <= 2 ? 0 : 1) : total;
   }
```

---



 Mathematical, Unit-Scope & Rounding Drift (UI Layer)

### 5.1 Scope Mixing (Single-Session vs. Cross-Session)

#### Bug 5.1a: `dupFiles` Sorts Current-Session Offenders by Cross-Session `isChronic` Boolean Instead of Current-Session `wastedTokens`, Corrupting Simple View's "#1 Bloat Contributor" Headline and `/compact` Template
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `3331â€“3336`, `3784â€“3786`, `3900â€“3918`, and `4704â€“4706`.
- **Function Name**: `renderState(raw, fromCatalog)` and `renderSessionHealthSummary(...)`
- **Reproduction Scenario**:
  - In the current session, `README.md` was re-read once (`wastedTokens = 400` tokens), and appears in `raw.chronicReads` with `sessions = 3` (`isChronic === true`).
  - In the current session, `src/core/classifier.mjs` was re-read 6 times (`wastedTokens = 38000` tokens), with `sessions = 1` (`isChronic === false`).
- **Root Cause in Code**:
  - Line `3335` sorts `dupFiles` strictly by cross-session chronic status:
    `const dupFiles = dupFilesRaw.slice().sort((a, b) => (isChronic(b) ? 1 : 0) - (isChronic(a) ? 1 : 0));`
  - It does not sort by current-session `wastedTokens` (`b.wastedTokens - a.wastedTokens`), so the `0.4k` `README.md` is placed at `dupFiles[0]` ahead of the `38.0k` `classifier.mjs`.
  - Consequently, Simple View Bullet 2 (`renderSessionHealthSummary`, lines `4705â€“4706`) reads `dupFiles[0].path` and tells the user:
    `Repeated file reads are the #1 bloat contributor (~38.4k across 2 files, led by README.md).` â€” attributing a `38.4k` single-session bloat spike to a file that only used `0.4k` in this session!
  - Likewise, `#parameterizedCompactText` (line `3785`) and `#playbookList` Card A ("Repeated File Reads" under "Cleared by `/compact`", line `3900`) rank cross-session chronic files above the current session's actual largest token offenders.
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3332,7 +3332,9 @@
     const chronicMap = new Map((raw.chronicReads || []).map(c => [normPath(c.path), c]));
     const chronicOf = f => chronicMap.get(normPath(f.path));
     const isChronic = f => (chronicOf(f)?.sessions || 0) >= 3;
-    const dupFiles = dupFilesRaw.slice().sort((a, b) => (isChronic(b) ? 1 : 0) - (isChronic(a) ? 1 : 0));
+    const dupFiles = dupFilesRaw.slice().sort((a, b) =>
+      ((b.wastedTokens || 0) - (a.wastedTokens || 0)) || ((isChronic(b) ? 1 : 0) - (isChronic(a) ? 1 : 0))
+    );
     const dupTotalTok = signals.duplicateReads?.reclaimableTokens ?? dupFiles.reduce((s, f) => s + f.wastedTokens, 0);
```

---

#### Bug 5.1b: Cross-Session `chronicReads` Fallback Token Formula & Rounding Diverge Between `#crossSessionOffenderBanner` and `#simpleActionList`
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `4520â€“4526` (`#crossSessionOffenderBanner`) vs. Lines `5039â€“5053` (`#simpleActionList` B5 `chronic-read`).
- **Function Name**: `renderState(raw, fromCatalog)` and `renderSessionHealthSummary(...)`
- **Reproduction Scenario**: `raw.chronicReads[0]` has `{ path: 'src/config.mjs', sessions: 4, windowSessions: 5, wastedTokens: 5400 }` (or `wastedTokens` omitted, `reads` omitted, `sessions: 4`).
- **Root Cause in Code**:
  - Line `4520`: `const wastedTokens = topChronic?.totalWastedTokens ?? topChronic?.wastedTokens ?? ((topChronic?.reads || 1) * 1500);` (when `reads` is omitted, multiplies `1 * 1500 = 1500`), and line `4524` formats with integer rounding: `const wastedK = Math.max(1, Math.round(wastedTokens / 1000));` (`5400` -> `5k`).
  - Line `5039`: `const chTok = Number(ch.totalWastedTokens || ch.wastedTokens || (ch.reads || ch.sessions) * 1500);` (when `reads` is omitted, multiplies `ch.sessions * 1500 = 6000`), and line `5047` formats with tenth-k `fmtK(chTok)` (`5400` -> `5.4k`).
  - Furthermore, line `5053` sets `data-impact-tokens="${chTok}"` (multi-session cumulative tokens) using the same attribute name as single-session rows (`data-impact-tokens`), without a `data-impact-scope="cross-session"` attribute to distinguish unit scope.
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -4517,13 +4517,12 @@
       const topChronic = Array.isArray(raw.chronicReads) && raw.chronicReads.length > 0
         ? raw.chronicReads.find(c => !dismissedKeysBanner.has('chronic:' + normPath(c.path)))
         : null;
-      const wastedTokens = topChronic?.totalWastedTokens ?? topChronic?.wastedTokens ?? ((topChronic?.reads || 1) * 1500);
+      const wastedTokens = Number(topChronic?.totalWastedTokens ?? topChronic?.wastedTokens ?? ((topChronic?.reads || topChronic?.sessions || 1) * 1500));
       if (topChronic && (topChronic.bannerText || wastedTokens >= 5000)) {
         crossSessionBannerEl.hidden = false;
         const winN = topChronic.windowSessions || topChronic.sessions || 1;
-        const wastedK = Math.max(1, Math.round(wastedTokens / 1000));
         crossSessionTextEl.textContent = topChronic.bannerText ||
-          `Across last ${winN} sessions, ${formatShortPath(topChronic.path)} caused ${wastedK}k repeated re-reads`;
+          `Across last ${winN} sessions, ${formatShortPath(topChronic.path)} caused ~${fmtK(wastedTokens)} repeated re-reads`;
       } else {
         crossSessionBannerEl.hidden = true;
         crossSessionTextEl.textContent = '';
@@ -5036,7 +5035,7 @@
       const chronicList = (raw.chronicReads || [])
         .filter(c => c.sessions >= 3 && !dismissedKeys.has('chronic:' + normPath(c.path)))
         .slice(0, 3);
       for (const ch of chronicList) {
-        const chTok = Number(ch.totalWastedTokens || ch.wastedTokens || (ch.reads || ch.sessions) * 1500);
+        const chTok = Number(ch.totalWastedTokens ?? ch.wastedTokens ?? ((ch.reads || ch.sessions || 1) * 1500));
         const canIgnore = isIgnorablePath(ch.path);
         const shortP = formatShortPath(ch.path);
@@ -5050,7 +5049,7 @@
         crossSessionRows.push({
           impactTokens: chTok,
           html:
-            `<details class="m3-action-row m3-action-collapsible" data-action-id="chronic-read" data-impact-tokens="${chTok}" data-dismiss-key="${escAttr(chronicDismissKey)}">` +
+            `<details class="m3-action-row m3-action-collapsible" data-action-id="chronic-read" data-impact-scope="cross-session" data-impact-tokens="${chTok}" data-dismiss-key="${escAttr(chronicDismissKey)}">` +
```

---

### 5.2 `0.1k` Sum & Subtraction Parity

#### Bug 5.2a: `Used + Safe Headroom !== Safe Limit` (`0.1k` Rounding Drift & `.0k` Formatting Mismatch Across `#usedBig`, `#freeLabel`, `#valFree`, `#statusBadge`, and `#summaryTextMemory`)
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**:
  - Line `3568`: `document.getElementById('usedBig').textContent = fmtTenths(displayParity.displayTotalTenths);`
  - Lines `3603â€“3606`: `const toLimit = safeLimit - totalTokens;` -> `fmtK(toLimit)` / `fmtK(Math.abs(toLimit))`
  - Lines `3681, 3686â€“3705`: `const fmtHeadroom = hasEffortMeta ? (n => ((Math.max(0, n) / 1000).toFixed(1) + 'k')) : fmtK;` -> `valFreeEl.textContent = "${fmtHeadroom(safeLimit - totalTokens)} left"`
  - Line `3768`: `const overK = totalTokens > safeLimit ? fmtK(totalTokens - safeLimit) : '';`
  - Line `3887`: `actionText.innerHTML = "... ${fmtK(Math.max(0, toLimit))} of room ..."`
  - Lines `4666â€“4689`: `const distance = safeLimit - totalTokens;` -> `fmtK(distance)` / `fmtK(over)` in `renderSessionHealthSummary`.
- **Function Name**: `renderState(raw, fromCatalog)` and `renderSessionHealthSummary(...)`
- **Reproduction Scenarios**:
  1. **Scenario 1 (`0.1k` Addition Failure: `totalTokens = 52350`, `safeLimit = 140000`)**:
     - `#usedBig`: `displayTotalTenths = Math.round(52350 / 100) = 524` -> **`52.4k`**.
     - `toLimit = 140000 - 52350 = 87650`.
     - `#freeLabel`, `#valFree`, and `#summaryTextMemory` format `87650` via `(87650 / 1000).toFixed(1)` -> **`87.7k`**.
     - **Sum in UI**: `52.4k (Used) + 87.7k (Safe Headroom) = 140.1k !== 140k (Safe Limit)`!
  2. **Scenario 2 (`+0k over` / `0k Over Limit` Ghost Breach: `totalTokens = 140030`, `safeLimit = 140000`)**:
     - `#usedBig` rounds `140030` to **`140k`**.
     - Because `totalTokens > safeLimit` (`140030 > 140000`), `#valFree` (line `3702`) displays **`+0.0k over`** (or **`+0k over`**), `#freeLabel` (line `3606`) displays **`0k past 140k safe limit!`**, `#statusBadge` (line `3769`) displays **`0k Over Limit`**, and `#summaryTextMemory` (line `4688`) displays **`Attention Horizon breached by +0k (using 140k / 200k)`**!
  3. **Scenario 3 (`.0k` Format Inconsistency on Exact Kilotokens: `totalTokens = 15000`, `safeLimit = 115000`, `hasEffortMeta = true`)**:
     - `safeLimit - totalTokens = 100000`.
     - `#freeLabel` (line `3605`) uses `fmtK(100000)` -> **`100k below 115k safe limit`**.
     - `#valFree` (line `3692`) uses `fmtHeadroom(100000)` -> **`100.0k left`** (because `fmtHeadroom` uses `.toFixed(1) + 'k'` without `.replace(/\.0$/, '')` when `hasEffortMeta` is true!).
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3600,10 +3600,12 @@
     const limitK = fmtK(safeLimit);
     const showProfileTag = hasEffortMeta || safeLimit === effortProfile.safeLimit;
     renderLimitLine(safeLimit, win.maxTokens || 200000, showProfileTag ? effortProfile : null);
+    const safeLimitTenths = Math.round(Math.max(0, Number(safeLimit) || 0) / 100);
+    const toLimitTenths = safeLimitTenths - displayParity.displayTotalTenths;
     const toLimit = safeLimit - totalTokens;
-    document.getElementById('freeLabel').textContent = toLimit > 0
-      ? `${fmtK(toLimit)} below ${limitK} safe limit`
-      : `${fmtK(Math.abs(toLimit))} past ${limitK} safe limit!`;
+    document.getElementById('freeLabel').textContent = toLimit >= 0
+      ? `${fmtTenths(Math.max(0, toLimitTenths))} below ${limitK} safe limit`
+      : `${fmtTenths(Math.max(1, -toLimitTenths))} past ${limitK} safe limit!`;
     renderDelta(raw.delta);
 
     const parityActiveTok = displayParity.displayActiveTenths * 100;
@@ -3678,7 +3680,6 @@
     const lblFreeEl = document.getElementById('lblFree');
     const subFreeEl = document.getElementById('subFree');
     const swatchFreeEl = document.getElementById('swatchFree');
-    const fmtHeadroom = hasEffortMeta ? (n => ((Math.max(0, n) / 1000).toFixed(1) + 'k')) : fmtK;
     const reasonTip = effortProfile?.limitReason
       ? ` <span class="limit-reason-tip" title="${escAttr(effortProfile.limitReason)}" data-limit-reason="${escAttr(effortProfile.limitReason)}">&#x24D8;</span>`
       : '';
@@ -3689,7 +3690,7 @@
         swatchFreeEl.style.background = 'var(--hz-free)';
         swatchFreeEl.style.borderColor = 'var(--hz-border)';
       }
-      valFreeEl.textContent = `${fmtHeadroom(safeLimit - totalTokens)} left`;
+      valFreeEl.textContent = `${fmtTenths(Math.max(0, toLimitTenths))} left`;
       // Neutral white/slate (#f1f5f9) when > 15k left, amber when approaching safe limit, red when over limit
       valFreeEl.style.setProperty('color', (safeLimit - totalTokens) > 15000 ? '#f1f5f9' : '#f59e0b', 'important');
       subFreeEl.innerHTML = `Until ${limitK} safe limit${reasonTip}`;
@@ -3699,7 +3700,7 @@
         swatchFreeEl.style.background = 'var(--hz-danger)';
         swatchFreeEl.style.borderColor = 'var(--hz-danger)';
       }
-      valFreeEl.textContent = `+${fmtHeadroom(totalTokens - safeLimit)} over`;
+      valFreeEl.textContent = `+${fmtTenths(Math.max(1, -toLimitTenths))} over`;
       valFreeEl.style.setProperty('color', '#ef4444', 'important');
       subFreeEl.innerHTML = `Past ${limitK} limit${reasonTip}`;
     }
@@ -3765,7 +3766,7 @@
       : '';
     compactReclaim.textContent = (guidedBox && guidedBox.dataset.cacheAdvisory === 'lean' ? `Session is lean (${fmtK(totalTokens)} / ${Math.round(totalTokens / (raw.window?.maxTokens || 256000) * 100)}%) \u00B7 No compaction needed until >50k \u00B7 ` : '') + reclaimLine;
     if (isOverLimit) {
-      const overK = totalTokens > safeLimit ? fmtK(totalTokens - safeLimit) : '';
+      const overK = totalTokens > safeLimit ? fmtTenths(Math.max(1, -toLimitTenths)) : '';
       badge.textContent = overK ? `${overK} Over Limit` : 'Over Safe Limit';
     } else if (clutterTokens > 0 || reclaimSumK > 0) {
       badge.textContent = `${reclaimSumStr} can be cleared`;
@@ -3884,7 +3885,7 @@
       actionCard.dataset.cleanState = 'nominal-clean';
       actionIcon.textContent = 'âœ“';
       if (document.querySelector('.action-msg')) document.querySelector('.action-msg').style.display = 'flex';
-      actionText.innerHTML = `<strong>Memory is clean and focused.</strong> ${pureRound}% of context (${fmtK(usefulTokens)}) is active code and rules with ${fmtK( Math.max(0, toLimit) )} of room before earliest instructions could be affected.`;
+      actionText.innerHTML = `<strong>Memory is clean and focused.</strong> ${parityPureRound}% of context (${fmtTenths(displayParity.displayActiveTenths)}) is active code and rules with ${fmtTenths(Math.max(0, toLimitTenths))} of room before earliest instructions could be affected.`;
       guidedBox.style.display = 'none';
     }
@@ -4665,28 +4666,31 @@
     // 1. Memory State & Headroom (Fixed Bullet 1)
     const limitK = fmtK(safeLimit);
     const effortLabel = effortProfile?.shortLabel || 'Safe Limit';
+    const totalTenths = Math.round(Math.max(0, Number(totalTokens) || 0) / 100);
+    const limitTenths = Math.round(Math.max(0, Number(safeLimit) || 0) / 100);
+    const totalKStr = fmtTenths(totalTenths);
     if (totalTokens < safeLimit) {
       const distance = safeLimit - totalTokens;
+      const distKStr = fmtTenths(Math.max(0, limitTenths - totalTenths));
       if (distance > 15000) {
         if (summaryPill) { summaryPill.className = 'summary-status-pill mono'; summaryPill.textContent = 'Optimal'; }
         if (iconMem) { iconMem.className = 'summary-bullet-icon'; }
         if (txtMem) {
-          txtMem.textContent = `Using ${fmtK(totalTokens)} of ${fmtK(maxTokens)} tokens (${usedPct}%) â€” ${fmtK(distance)} below your ${limitK} ${effortLabel} limit. Recall quality is optimal with zero truncation risk.`;
+          txtMem.textContent = `Using ${totalKStr} of ${fmtK(maxTokens)} tokens (${usedPct}%) â€” ${distKStr} below your ${limitK} ${effortLabel} limit. Recall quality is optimal with zero truncation risk.`;
         }
       } else {
         if (summaryPill) { summaryPill.className = 'summary-status-pill warn mono'; summaryPill.textContent = 'Horizon Near'; }
         if (iconMem) { iconMem.className = 'summary-bullet-icon warn'; }
         if (txtMem) {
-          txtMem.textContent = `Using ${fmtK(totalTokens)} of ${fmtK(maxTokens)} tokens (${usedPct}%) â€” approaching the ${limitK} ${effortLabel} safe limit (${fmtK(distance)} left). Early instructions may soon decay; consider compacting.`;
+          txtMem.textContent = `Using ${totalKStr} of ${fmtK(maxTokens)} tokens (${usedPct}%) â€” approaching the ${limitK} ${effortLabel} safe limit (${distKStr} left). Early instructions may soon decay; consider compacting.`;
         }
       }
     } else {
-      const over = totalTokens - safeLimit;
+      const overKStr = fmtTenths(Math.max(1, totalTenths - limitTenths));
       if (summaryPill) { summaryPill.className = 'summary-status-pill danger mono'; summaryPill.textContent = 'Over Limit'; }
       if (iconMem) { iconMem.className = 'summary-bullet-icon danger'; }
       if (txtMem) {
-        txtMem.textContent = `Attention Horizon breached by +${fmtK(over)} (using ${fmtK(totalTokens)} / ${fmtK(maxTokens)}). Earliest instructions are at risk of automatic dilution or truncation.`;
+        txtMem.textContent = `Attention Horizon breached by +${overKStr} (using ${totalKStr} / ${fmtK(maxTokens)}). Earliest instructions are at risk of automatic dilution or truncation.`;
       }
     }
```

---

#### Bug 5.2b: Active Signal Drawer (`#sigBaseVal + #sigLiveVal`) Does Not Sum to `#valUseful` (`Active Signal`) Due to Independent Rounding & Raw `usefulTokens` Basis
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `4148â€“4154`.
- **Function Name**: `renderState(raw, fromCatalog)`
- **Reproduction Scenario**:
  - Let `totalTokens = 50000`, `parityActiveTok = 35300` (`35.3k` shown in `#valUseful`), `signals.activeSignal.liveSessionTokens = 17650`.
  - `liveWorkTok = 17650` -> `fmtK(17650)` = **`17.7k`**.
  - `baseTok = 35300 - 17650 = 17650` -> `fmtK(17650)` = **`17.7k`**.
  - **Drawer Sum**: `17.7k (Workspace Baseline Overhead) + 17.7k (Live Session Work) = 35.4k !== 35.3k (Active Signal)`!
  - Furthermore, when `reclaimSumK * 1000 !== clutterTokens` (e.g., `dupRowK + oldTurnRowK + errRowK` rounds differently from `clutterTokens`), `usefulTokens` (`totalTokens - clutterTokens`) differs from `parityActiveTok` (`displayParity.displayActiveTenths * 100`), so `#sigBaseVal + #sigLiveVal` isn't even computed from the same total as `#valUseful`!
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -4146,11 +4146,13 @@
     }
 
     // 5b. Active Signal drawer: baseline overhead vs live session work
-    const pctOf = n => totalTokens > 0 ? Math.round((n / totalTokens) * 100) : 0;
-    const liveWorkTok = Math.min(usefulTokens, signals.activeSignal?.liveSessionTokens ?? Math.round(usefulTokens * 0.5));
-    const baseTok = Math.max(0, usefulTokens - liveWorkTok);
-    document.getElementById('sigBaseVal').textContent = `${fmtK(baseTok)} (${pctOf(baseTok)}%)`;
-    document.getElementById('sigLiveVal').textContent = `${fmtK(liveWorkTok)} (${pctOf(liveWorkTok)}%)`;
+    const activeTenthsTotal = displayParity.displayActiveTenths;
+    const rawLiveTok = Math.min(parityActiveTok, signals.activeSignal?.liveSessionTokens ?? Math.round(parityActiveTok * 0.5));
+    const liveTenths = Math.min(activeTenthsTotal, Math.round(Math.max(0, rawLiveTok) / 100));
+    const baseTenths = Math.max(0, activeTenthsTotal - liveTenths);
+    const baseTok = baseTenths * 100;
+    const pctOfTenths = t => displayParity.displayTotalTenths > 0 ? Math.round((t / displayParity.displayTotalTenths) * 100) : 0;
+    document.getElementById('sigBaseVal').textContent = `${fmtTenths(baseTenths)} (${pctOfTenths(baseTenths)}%)`;
+    document.getElementById('sigLiveVal').textContent = `${fmtTenths(liveTenths)} (${pctOfTenths(liveTenths)}%)`;
     renderBaselineRows(raw.baseline, baseTok);
```

---

#### Bug 5.2c: Layer 5 Action Queue (`buildClientActionQueue`) vs. Simple View (`condense-ast`) vs. `reclaimSumStr` Use Conflicting Sums & Rounding
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**:
  - `buildClientActionQueue`: Lines `3138â€“3160` (`totalReclaimableToolTok = dupTok + deadErrTok + oldHistTok`, formatted via `(totalReclaimableToolTok / 1000).toFixed(1) + 'k'`).
  - `renderState` (`reclaimSumK`): Lines `3349â€“3357` (`dupRowK + oldTurnRowK + errRowK`, where each row is rounded to `0.1k` *before* summing).
  - `renderSessionHealthSummary` (`condense-ast`): Lines `4917â€“4945` (`surgicalTok = Math.round((dupRowK + errRowK) * 1000)` â€” excludes `oldTurnRowK` even though both buttons trigger `#btnCondenseAst` / `POST /api/prune`!).
- **Function Name**: `buildClientActionQueue`, `renderState`, `renderSessionHealthSummary`
- **Reproduction Scenario**:
  - Let `dupTok = 4440` (`dupRowK = 4.4`), `deadErrTok = 4440` (`errRowK = 4.4`), `oldHistTok = 4440` (`oldTurnRowK = 4.4`).
  - `#valClutter`, `#statusBadge`, `#compactImpactBadge`, and `#playbookList` sum the rounded rows: `4.4 + 4.4 + 4.4 = 13.2k`.
  - `#aqList` (`buildClientActionQueue`, line `3154`) sums raw tokens first (`4440 + 4440 + 4440 = 13320`) and displays **`reclaims ~13.3k tok`** (and `#aqTotalPayoff` at line `4449` displays **`13.3k tok reclaimable`**), drifting by `0.1k` from `#valClutter` (`13.2k`)!
  - Meanwhile, Simple View's `condense-ast` row (line `4917`) only sums `dupRowK + errRowK = 8.8k`, whereas Advanced View's Action Queue row for the exact same `apiAction: 'condense-ast'` (line `3158`) sums `dup + err + oldHist = 13.3k`!
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -3138,10 +3138,10 @@
     const dupTok = Number(raw?.brainSignals?.duplicateReads?.reclaimableTokens || 0);
     const deadErrTok = Number(raw?.brainSignals?.deadErrors?.reclaimableTokens || 0);
     const oldHistTok = Number(raw?.brainSignals?.oldHistory?.reclaimableTokens || 0);
-    const totalReclaimableToolTok = dupTok + deadErrTok + oldHistTok;
+    const totalReclaimableToolK = Math.round((roundK(dupTok) + roundK(deadErrTok) + roundK(oldHistTok)) * 10) / 10;
+    const totalReclaimableToolTok = Math.round(totalReclaimableToolK * 1000);
     const staleTurnCount = Number(raw?.brainSignals?.oldHistory?.turnCount || 0) +
       Number(raw?.brainSignals?.deadErrors?.errorCount || 0) +
       Number(raw?.brainSignals?.duplicateReads?.fileCount || 0);
     if (totalReclaimableToolTok >= 3000) {
       const countLabel = staleTurnCount > 0 ? `${staleTurnCount} Stale Turn${staleTurnCount === 1 ? '' : 's'}` : 'Stale Tool Outputs';
       items.push({
         id: 'aq-tool-prune',
         kind: 'STALE_TOOLS',
         priorityScore: 300000 + totalReclaimableToolTok * 10,
         pinnedSlot1: false,
         actionLabel: `[Prune ${countLabel}]`,
         target: 'Tool Surgeon (--prune-tools)',
-        payoff: `reclaims ~${(totalReclaimableToolTok / 1000).toFixed(1)}k tok (zero LLM loss)`,
+        payoff: `reclaims ~${fmtKFixed1(totalReclaimableToolK)} tok (zero LLM loss)`,
         reclaimTokens: totalReclaimableToolTok,
```

---



---

### Bug Class 6: CSS, Overflow, Word-Break & Legacy Mirror Drift

 CSS, Overflow, Word-Break & Legacy Mirror Drift

### 6.1 Mid-Word Line Breaks

#### Bug 6.1a: `.payload-box` Uses `word-break: break-all`, Splitting English Prose Labels and Descriptions Mid-Word
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Line `1593` (CSS) and Lines `3978â€“3988` (DOM rendered inside `#playbookList` Card C: `Large Output at Turn #N`).
- **Reproduction Scenario**: At `320pxâ€“420px` side-pane width, open Card C (`âš¡ Large Output at Turn #N`). `.payload-box` contains `<span class="payload-kind">Command that produced this output:</span>` and command/file descriptions. Because `.payload-box` sets `word-break: break-all;`, English words in `.payload-kind` and prose descriptions split mid-word across line wraps.
- **Root Cause in Code**: Line `1593` sets `word-break: break-all;` on the entire `.payload-box` container instead of `overflow-wrap: break-word; word-break: normal;`.
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -1590,5 +1590,5 @@
     .chip-btn:hover { color: var(--hz-anchor) !important; border-color: var(--hz-anchor); }
     .chip-btn.noisy { color: var(--hz-clutter) !important; border-color: var(--hz-clutter); }
-    .payload-box { margin-top: 6px; padding: 6px 8px; border: 1px solid var(--hz-border); border-radius: 6px; font-size: 11px; color: var(--hz-fg) !important; word-break: break-all; }
-    .payload-box .payload-kind { color: var(--hz-muted) !important; display: block; margin-bottom: 2px; }
+    .payload-box { margin-top: 6px; padding: 6px 8px; border: 1px solid var(--hz-border); border-radius: 6px; font-size: 11px; color: var(--hz-fg) !important; overflow-wrap: break-word; word-break: normal; }
+    .payload-box .payload-kind { color: var(--hz-muted) !important; display: block; margin-bottom: 2px; word-break: normal; overflow-wrap: break-word; }
```

---

### 6.2 Collision & Clipping Risks (`320pxâ€“420px` Narrow Side-Pane Widths)

#### Bug 6.2a: Absolute-Positioned `#limitTag` Clips Off the Left Edge of `.storage-card` at `320pxâ€“420px` Widths
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**: Lines `482â€“494` (`.limit-tag` CSS) and Lines `2905â€“2917` (`renderLimitLine`).
- **Function Name**: `renderLimitLine(safeLimit, maxTokens, effortProfile)`
- **Reproduction Scenario**:
  1. Resize side-pane to `320pxâ€“380px` width (`.bar-outer` width is `~264pxâ€“324px`).
  2. Set effort tier to `FAST` (`safeLimit = 95000`, `maxTokens = 256000` -> `pct = 37.1%`, i.e., `98px` from left of `.bar-outer`) or `HIGH` (`115000 / 256000 = 44.9%`, i.e., `118px` from left), or configure a custom `safeLimit` `< 120k`.
  3. `#limitTag` text is `"95k Safe Limit (Fast)"` or `"115k Safe Limit (High)"` (~`135pxâ€“155px` wide).
- **Root Cause in Code**:
  - `.limit-tag` (lines `485â€“487`) uses `left: -4px; transform: translateX(-100%);`, which unconditionally projects the entire label to the **left** of `.limit-line`.
  - Whenever `pct < 55%` at narrow widths (`320pxâ€“400px`), `pct% * barWidth` (`98pxâ€“118px`) is smaller than the width of `.limit-tag` (`135pxâ€“155px`), clipping the start of `"95k Safe Limit (Fast)"` outside `.storage-card` and off the left edge of the viewport!
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -492,3 +492,8 @@
     white-space: nowrap;
     font-variant-numeric: tabular-nums;
   }
+  .limit-tag.flip-right {
+    left: 4px;
+    transform: none;
+  }
@@ -2909,6 +2914,7 @@
       const pct = Math.round(rawPct * 10) / 10;
       line.style.left = pct + '%';
       line.dataset.tokens = String(safeLimit);
+      tag.classList.toggle('flip-right', pct < 52);
       const labelSuffix = effortProfile && effortProfile.label ? ` (${effortProfile.label})` : '';
       tag.textContent = `${fmtK(safeLimit)} Safe Limit (${(effortProfile && effortProfile.shortLabel) || 'Auto'})`;
```

---

#### Bug 6.2b: Top `<header>`, `.aq-row` (Action Queue), `.top-risky-cell-row`, and `.base-rows li` Overflow or Clip Numbers at `320pxâ€“420px` Widths
- **File Path**: `c:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`
- **Line Numbers**:
  1. `<header>` & `.header-right`: Lines `96â€“128`, `1931â€“1946` â€” lacks `flex-wrap: wrap` on `header` and `.header-right`, and `white-space: nowrap` on `h1` and `.badge`. In Advanced Mode (`#workloadModeBadge` + `#statusBadge` + `#confidenceBadge` + `.shadcn-tabs-list` + `.icon-btn`), total width exceeds `520px`, overflowing `320pxâ€“420px` side-panes.
  2. `.base-rows .base-src`: Line `371` â€” has `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` but lacks `min-width: 0; flex: 1 1 auto;`, so long MCP/skill labels push `.base-tok` off the right edge.
  3. `.diag-name` & `.diag-impact`: Lines `1230â€“1256` â€” `.diag-name` lacks `min-width: 0; flex: 1 1 auto;` and `.diag-impact` lacks `flex-shrink: 0;`.
  4. `.top-risky-cell-row`: Lines `1811â€“1821` & `4406â€“4416` â€” `rc.filePath` (line `4407`) is rendered raw without `formatShortPath()`, and `.top-risky-cell-row > span` lacks `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` while its `<button>` lacks `flex-shrink: 0;`.
  5. `.aq-row`: Lines `1870â€“1879` â€” uses `grid-template-columns: auto minmax(130px, 1fr) auto;`. At `320px` width, `auto` (~125px) + `130px` min + `auto` (`.aq-payoff` with `white-space: nowrap`, ~170px) = `425px+`, overflowing `.action-queue`.
- **Exact Drop-in Replacement Diff**:
```diff
--- a/src/webview/horizon_panel.html
+++ b/src/webview/horizon_panel.html
@@ -96,14 +96,17 @@
   /* 1. Top Header */
   header {
     display: flex;
+    flex-wrap: wrap;
     align-items: center;
     justify-content: space-between;
+    gap: 6px 8px;
     padding-bottom: 2px;
   }
   .title-group {
     display: flex;
     align-items: center;
     gap: 8px;
+    flex-shrink: 0;
   }
@@ -119,12 +122,15 @@
     font-weight: 600;
     letter-spacing: -0.015em;
     color: var(--hz-fg) !important;
+    white-space: nowrap;
   }
 
   .header-right {
     display: flex;
+    flex-wrap: wrap;
     align-items: center;
+    justify-content: flex-end;
     gap: 6px;
+    min-width: 0;
   }
@@ -175,4 +181,6 @@
     color: var(--hz-useful);
     border: 1px solid rgba(16, 185, 129, 0.35);
     font-variant-numeric: tabular-nums;
+    white-space: nowrap;
+    flex-shrink: 0;
   }
@@ -371,2 +379,2 @@
-  .base-rows .base-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
-  .base-rows .base-tok { flex: none; color: #f8fafc !important; text-align: right; font-variant-numeric: tabular-nums; }
+  .base-rows .base-src { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
+  .base-rows .base-tok { flex: 0 0 auto; color: #f8fafc !important; text-align: right; font-variant-numeric: tabular-nums; }
@@ -1230,8 +1238,10 @@
   .diag-name {
     font-size: 11.5px;
     font-weight: 600;
     display: flex;
     align-items: center;
     gap: 6px;
+    flex: 1 1 auto;
+    min-width: 0;
     color: var(--hz-fg) !important;
   }
@@ -1253,4 +1263,5 @@
     text-align: right;
     min-width: 44px;
+    flex-shrink: 0;
     font-variant-numeric: tabular-nums;
   }
@@ -1811,11 +1822,19 @@
     .top-risky-cell-row {
       display: flex;
       align-items: center;
       justify-content: space-between;
       gap: 6px;
       padding: 4px 8px;
       border-radius: 5px;
       background: rgba(15, 23, 42, 0.55);
       border: 1px solid var(--hz-border-subtle);
       color: var(--hz-fg) !important;
     }
+    .top-risky-cell-row > span {
+      flex: 1 1 auto;
+      min-width: 0;
+      overflow: hidden;
+      text-overflow: ellipsis;
+      white-space: nowrap;
+    }
+    .top-risky-cell-row > button { flex-shrink: 0; }
@@ -1870,9 +1889,9 @@
     .aq-row {
       display: grid;
-      grid-template-columns: auto minmax(130px, 1fr) auto;
+      grid-template-columns: auto minmax(0, 1fr) auto;
       align-items: center;
-      gap: 10px;
+      gap: 6px 8px;
       padding: 4px 6px;
       border-radius: 4px;
       background: rgba(15, 23, 42, 0.55);
       border: 1px solid rgba(255, 255, 255, 0.04);
     }
@@ -4407,8 +4426,9 @@
-          const pathStr = rc.filePath || `Cell #${rc.cellNumber}`;
+          const rawPathStr = rc.filePath || `Cell #${rc.cellNumber}`;
+          const pathStr = rc.filePath ? formatShortPath(rc.filePath) : rawPathStr;
           const tokStr = fmtK(rc.tokenWeight || 6400);
           const recPct = rc.attentionRecallPct ?? 40;
           const actLabel = rc.actionLabel || '[Re-Anchor / Prune]';
           const specificTitle = rc.specificActionLabel || (rc.actionType === 'PRUNE' ? '[Prune Stale Tool Outputs]' : '[Re-Anchor Cell to Handoff]');
           return `<div class="top-risky-cell-row" data-cell-index="${Number(rc.cellIndex ?? 0)}">` +
-            `<span>Cell #${Number(rc.cellNumber ?? 1)} \u00B7 ${escAttr(pathStr)} \u00B7 ${tokStr} tok (${recPct}% recall)</span>` +
-            `<button type="button" class="mini-btn" data-act="reanchor-prune" data-path="${escAttr(pathStr)}" data-action-type="${escAttr(rc.actionType || 'RE_ANCHOR')}" title="${escAttr(specificTitle)}">${escAttr(actLabel)}</button>` +
+            `<span title="${escAttr(rawPathStr)}">Cell #${Number(rc.cellNumber ?? 1)} \u00B7 ${escAttr(pathStr)} \u00B7 ${tokStr} tok (${recPct}% recall)</span>` +
+            `<button type="button" class="mini-btn" data-act="reanchor-prune" data-path="${escAttr(rawPathStr)}" data-action-type="${escAttr(rc.actionType || 'RE_ANCHOR')}" title="${escAttr(specificTitle)}">${escAttr(actLabel)}</button>` +
           `</div>`;
```

---

### 6.3 Legacy UI File Drift (`sidepane.html`, `widget.html`, `server.mjs`, `sync_mirrors.mjs`)

#### Bug 6.3a: Legacy `src/ui/widget.html` Still Exists in `~/.gemini/config/plugins/agy-horizon/src/ui/widget.html` (5,023 bytes), Is Actively Served by `server.mjs` on `/widget` and `/widget.html`, Is Omitted from `sync_mirrors.mjs`, and Has Severely Drifted
- **File Paths & Line Numbers**:
  1. `C:\Users\frank\.gemini\config\plugins\agy-horizon\src\ui\widget.html` (Lines `1â€“153`, `5,023` bytes).
  2. `c:\Projects\ga-visualizer-v2\sidecars\horizon-daemon\server.mjs` (Line `43`: `const widgetHtml = path.resolve(__dirname, '../../src/ui/widget.html');`, Lines `195â€“196`, and Lines `288â€“298`: route `GET /widget` and `GET /widget.html` serves `widgetHtml` before `horizonPanelHtml` and without injecting `window.__LIVE_INITIAL_STATE__`).
  3. `c:\Projects\ga-visualizer-v2\scripts\sync_mirrors.mjs` (Lines `29â€“33`: `HTML_TARGETS` syncs `agy-horizon/src/ui/sidepane.html` and `agy-horizon-flightcheck/src/webview/horizon_panel.html`, which are currently SHA-256 identical `fe6ee787...`, but never syncs or removes `agy-horizon/src/ui/widget.html`).
  4. `c:\Projects\ga-visualizer-v2\evaluation_bundles\tier_2_full\src\webview\horizon_panel.html` (`176,576` bytes vs. `253,106` bytes canonical) and `c:\Projects\ga-visualizer-v2\evaluation_bundles\tier_2_full\sidecars\horizon-daemon\server.mjs` (`27,227` bytes vs. `27,428` bytes canonical).
- **Forensic Drift in `~/.gemini/config/plugins/agy-horizon/src/ui/widget.html`**:
  - **Hardcoded 200k Ceiling & 140k Safe Limit**: Lines `89`, `94`, `126`, `129` hardcode `200k` (`const pct = (tokens / 2000).toFixed(1);`) and `140k Safe Limit â€¢ 200k Ceiling`, displaying `>100%` usage on `256k` Gemini 4 Argon sessions.
  - **Integer Rounding Drift**: Lines `125, 129, 132` use `Math.round(tokens/1000)` and `Math.round(noiseTok/1000)` instead of `0.1k` tenth-kilotoken parity.
  - **Missing Sidecar Token Auth & SSE**: Line `150` calls `fetch('/api/state')` without propagating `?token=` / `X-Sidecar-Token` (so it gets `403 Forbidden` when `ANTIGRAVITY_SIDECAR_UI_TOKEN` is active!) and has no `/api/stream` `EventSource`.
  - **WCAG Contrast Failure**: Line `66` uses `color: #64748b` on `#111827` (`3.2:1` contrast ratio, failing WCAG AA `4.5:1`).
- **Exact Drop-in Replacement Diffs**:

**1. `c:\Projects\ga-visualizer-v2\sidecars\horizon-daemon\server.mjs` (Lines `42â€“45` & `262â€“298`)**:
```diff
--- a/sidecars/horizon-daemon/server.mjs
+++ b/sidecars/horizon-daemon/server.mjs
@@ -40,8 +40,7 @@
 const stateFile = path.join(defaultCacheDir, 'latest.state.json');
 
 const sidePaneHtml = path.resolve(__dirname, '../../src/ui/sidepane.html');
-const widgetHtml = path.resolve(__dirname, '../../src/ui/widget.html');
 const horizonPanelHtml = path.resolve(__dirname, '../../src/webview/horizon_panel.html');
 
 let lastEvalMs = 0;
@@ -260,39 +259,28 @@
     return;
   }
 
-  if (url.pathname === '/' || url.pathname === '/index.html') {
+  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/widget' || url.pathname === '/widget.html') {
     const qConv = url.searchParams.get('conversationId');
     if (qConv && qConv !== 'auto') {
       pinnedConversationId = qConv;
     }
     const initState = await refreshLiveState(false, pinnedConversationId);
     res.writeHead(200, {
       'Content-Type': 'text/html; charset=utf-8',
       'Cache-Control': 'no-store, no-cache, must-revalidate'
     });
-    const rawHtmlPath = fs.existsSync(sidePaneHtml)
-      ? sidePaneHtml
-      : (fs.existsSync(horizonPanelHtml) ? horizonPanelHtml : null);
+    const rawHtmlPath = fs.existsSync(horizonPanelHtml)
+      ? horizonPanelHtml
+      : (fs.existsSync(sidePaneHtml) ? sidePaneHtml : null);
     if (rawHtmlPath) {
       let html = fs.readFileSync(rawHtmlPath, 'utf8');
       if (initState) {
         const stateScript = `<script id="liveInitialState">window.__LIVE_INITIAL_STATE__ = ${JSON.stringify(initState).replace(/</g, '\\u003c')};</script>`;
         html = html.replace('<script id="precomputedCatalogScript">', `${stateScript}\n<script id="precomputedCatalogScript">`);
       }
       res.end(html);
     } else {
       res.end('<h1>Chrono-Attention Horizon Side-Pane</h1>');
     }
     return;
   }
-
-  if (url.pathname === '/widget' || url.pathname === '/widget.html') {
-    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
-    if (fs.existsSync(widgetHtml)) {
-      res.end(fs.readFileSync(widgetHtml));
-    } else if (fs.existsSync(horizonPanelHtml)) {
-      res.end(fs.readFileSync(horizonPanelHtml));
-    } else {
-      res.end('<h1>Chrono-Attention Horizon Widget</h1>');
-    }
-    return;
-  }
```

**2. `c:\Projects\ga-visualizer-v2\scripts\sync_mirrors.mjs` (Lines `29â€“53`)**:
```diff
--- a/scripts/sync_mirrors.mjs
+++ b/scripts/sync_mirrors.mjs
@@ -29,8 +29,9 @@
 const HTML_TARGETS = [
   path.join(CANONICAL_ROOT, 'src', 'webview', 'horizon_panel.html'),
   path.join(AGY_HORIZON_ROOT, 'src', 'ui', 'sidepane.html'),
+  path.join(AGY_HORIZON_ROOT, 'src', 'webview', 'horizon_panel.html'),
   path.join(FLIGHTCHECK_ROOT, 'src', 'webview', 'horizon_panel.html')
 ];
 
 function sha256File(filePath) {
@@ -47,8 +48,14 @@
   if (!verifyOnly) {
     // 1. Sync HTML to agy-horizon and agy-horizon-flightcheck
     for (const target of HTML_TARGETS.slice(1)) {
-      if (fs.existsSync(path.dirname(target))) {
+      const parentRoot = target.startsWith(AGY_HORIZON_ROOT) ? AGY_HORIZON_ROOT : FLIGHTCHECK_ROOT;
+      if (fs.existsSync(parentRoot)) {
+        fs.mkdirSync(path.dirname(target), { recursive: true });
         fs.copyFileSync(canonicalHtml, target);
       }
     }
+    const legacyWidget = path.join(AGY_HORIZON_ROOT, 'src', 'ui', 'widget.html');
+    if (fs.existsSync(legacyWidget)) {
+      fs.copyFileSync(canonicalHtml, legacyWidget);
+    }
```


---

## 3. Prioritized Phased Fix Plan

### Phase 1: Core Heuristics, Math Parity, CLI & Hooks
- src/core/classifier.mjs: Attention trough calculation, risk band gating, error detection with read-only exclusions, step blowup target extraction, math parity.
- src/core/quota.mjs & src/core/parser.mjs: Eliminate fabricated cache hits on degraded logs, fix thrash turn index comparison, require prior cache hit for prefix bust.
- src/core/blindspot_sensors.mjs: Session-scoped git drift guard, timestamp validation in dirty snapshots.
- src/core/session_forensics.mjs: In-progress proof grading ('Pending'), createdAt parsing, exitCode type checks.
- src/core/handoff_audit.mjs & src/core/prompt_rubric.mjs: Scoped session edit guards, compaction advisory thresholds.
- src/core/layer5_hygiene.mjs & src/core/pruner.mjs: Post-compaction tax set deletion, read-only traceback guard in pruning, primacy index on small files.
- src/core/offenders.mjs & src/core/action_queue.mjs: Standardize 2000 token multiplier, zero-out non-reclaimable token properties, portable npx commands.
- src/hooks/*.mjs & src/cli/doctor.mjs: Model variable scope fix, --handoff and --reap-orphans CLI args.

### Phase 2: WebView State, Math, Portability & CSS
- src/webview/horizon_panel.html:
  - Harmonize banner priority (#highEffortSludgeBanner, #artifactDriftBanner, #cacheCompactionAdvisory).
  - Reorder #actionRowCheckpoint above #actionRowCompact in #actionRowsStack.
  - Unify warm/cold cache and task.md sync predicates across all badges, pills, and indicators.
  - Move #feedbackToast outside #actionCard so toasts display in Simple Mode.
  - Support lockout warnings in Simple Mode.
  - Sort duplicate reads by wastedTokens primary.
  - Enforce 0.1k tenth-token parity across used, safe headroom, and active signal breakdown.
  - Fix narrow-width CSS: overflow-wrap on .payload-box, .flip-right on #limitTag, flex-wrap on header.
  - Preserve initialHostSurface for cross-surface session switching.
  - Implement warm-cache confirmation on Condense Now.

### Phase 3: Daemon Route Unification, Mirror Parity & E2E Validation
- sidecars/horizon-daemon/server.mjs: Route /widget and /widget.html to canonical horizonPanelHtml.
- scripts/sync_mirrors.mjs: Keep agy-horizon/src/ui/widget.html in parity.
- tests/verify_e2e_context_memory.mjs: Add Layer 8 Systemwide Coherence regression test suite covering all 6 bug classes.
