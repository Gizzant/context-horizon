# Changelog

All notable changes to the Context Horizon (`ctxtop` / `agy-horizon`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.1.0] - 2026-11-08

### Pre-Launch Bug-Fix & Verification Pass (Show-HN Release Readiness)

#### Fixed
1. **Safe Limit Unification & Idempotent Scaling (`constants.mjs` & `classifier.mjs`)**:
   - Fixed double-scaling bug in `scaleEffortProfileForCeiling()` where passing an already scaled profile resulted in a 229k recall ceiling instead of 179k.
   - Synchronized `activeEffortProfile.safeLimit` with `window.safeLimit` (179,000 on 256k Standard effort) and exposed exact integer `window.safeHeadroomTokens`.
2. **Low-Token False Positive Guard on Attention Trough (`classifier.mjs` & `horizon_panel.html`)**:
   - Added minimum token floor (`totalActiveTokens >= 44800` and `activeCellCount >= 7`) to `calculateParabolicAttentionCurve()`, `classifyHorizon()`, and webview mini-timeline.
   - Guaranteed sessions under 44.8k tokens report 0 cells in low-attention trough and 0 stranded signal warnings.
3. **Internal Telemetry Hydration Path Sanitization (`prompt_rubric.mjs`, `classifier.mjs`, `handoff_audit.mjs`, `layer5_hygiene.mjs`)**:
   - Added `isInternalTelemetryPath()` filter to exclude `.system_generated`, `steps/\d+/output.txt`, and `/.gemini/antigravity*/brain/` hydration logs from parameterized `/compact`, `/handoff`, `HANDOFF.md`, and duplicate re-read tracking.
4. **Cold Cache Prefix Bust Reset (`quota.mjs`, `classifier.mjs`, `horizon_panel.html`)**:
   - Separated historical `lastTurnPrefixBust` from live `prefixBustDetected`, requiring `!isCacheCold && cacheTtlRemainingSec > 0 && idleSeconds < 300`.
   - Cleared stale prefix bust warnings when sessions naturally expire/reach cold cache state, and gated `prefixLockWarning` on `!prefixBustDetected`.
5. **Epoch Checkpoint Slicing & Waste Bucket Rescaling (`classifier.mjs`)**:
   - Recomputed `categoryTotals` and `offenderMap` directly from scaled `classifiedSteps` when `stdinContextWindow` scales context tokens, ensuring mutually exclusive waste buckets sum strictly to `sludgeTokens` without negative residuals.
6. **Deduplicated Early Anchors at Risk (`classifier.mjs`)**:
   - Wrapped `amputation.anchorsAtRisk` in `Array.from(new Set(...))` to prevent duplicate labels in amputation warning payloads.
7. **Multi-Store Turn Count & 0-Step Ghost Session Filtering (`parser.mjs`)**:
   - Extracted real `turnCount` from `gen_metadata` in SQLite session databases, filtered out empty `stepCount: 0` ghost entries, and deduplicated multi-surface sessions by `sessionId` (preferring newest `lastModified`).
8. **Antigravity v2.6.0+ `agy --hub` Plain-HTTP Quota Probing (`quota.mjs` & `host_watchdog.mjs`)**:
   - Added `extractHubProcessInfo()` and `discoverLocalAntigravityHub()` to inspect running processes, extract port and `--csrf_token` / `--csrf-token`.
   - Updated `queryLocalLanguageServerStatus()` to probe plain HTTP `http://127.0.0.1:{port}` first with `x-codeium-csrf-token` header, falling back to HTTPS with `{ rejectUnauthorized: false }`.
   - Updated process table evaluator to recognize `agy --hub` alongside `language_server` for accurate RSS memory and zombie leak tracking.
9. **Cross-Surface `toggleConversation` Guard & `open-brain` Directory Fallback (`horizon_panel.html` & `server.mjs`)**:
   - Added cross-surface detection (`targetSurface !== hostSurface`) to `#btnOpenChat.onclick` to route clicks safely to `POST /api/open-brain` instead of throwing IDE conversation toggle exceptions.
   - Enhanced `POST /api/open-brain` to fall back to opening `~/.gemini/<surface>/conversations/` (or the surface directory root) when `brain/<uuid>/` does not exist on disk.
10. **UI Invariants & Inline Check Alignment (`horizon_panel.html`)**:
    - Enforced Invariant #1: `#compactInstruction` exclusively renders plain-text instructions (`Type /compact in the chat box and press Enter`), with `#compactReclaim` and `#parameterizedCompactBox`, with zero clickable copy buttons.
    - Synchronized inline UI risk calculations, `#quotaStrip` prefix bust states, and `#miniTimeline` attention trough shading with core engine rules.

#### Verification & Quality Gates
- **Unit Suite (`npm test`)**: 18 tests passing across 7 suites (0 failures, 331ms).
- **Phases Suite (`npm run test:phases`)**: All 7 Show-HN phase suites verified (0 errors).
- **End-to-End Suite (`node tests/verify_e2e_context_memory.mjs`)**: 7 validation layers passed (0 errors).
- **Benchmark Suite (`npm run bench`)**: Met all SLA budgets (`readSidecarSync` p95: 0.312ms, `PreInvocation Gate` p95: 0.150ms, `HUD Render` p95: 28.540ms).
- **3-Way WebView Mirror Parity**: Byte-for-byte identical across `ga-visualizer-v2`, `agy-horizon`, and `agy-horizon-flightcheck` (`SHA-256: 56eaad262dc9124191d0a03334b1df51d414f81691498612beda71fec6ac6347`).
