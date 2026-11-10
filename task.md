# Context Horizon (`ctxtop`) — Complete Remediation & High-Impact Launch Plan

> **Goal:** Fix all verified audit defects (Stages 1–5) and execute every `<1 day` high-impact trust, UX, multi-harness, and positioning lever (Stages 6–12) to move `ctxtop` from Scenario A (`150–700` stars, mixed/skeptical reception) to Scenario C (`1,500–6,000+` stars, high-trust community adoption).

---

## Part I — Core Audit Remediation (Stages 1–5)

- [x] **Stage 1: Telemetry Truth & Hardcoded Metric Purge** `[Flash / Sonnet • Low | ~2h]` <!-- id: 1 -->
  - [x] Task 1.1: Eliminate hardcoded telemetry fallbacks in `sidecars/horizon-daemon/server.mjs` (`fts5Compressor: 41200`, `uShapedAttention: 94`, `savedQuotaLedger: 142400`) <!-- id: 1.1 -->
  - [x] Task 1.2: Eliminate dummy placeholders in `src/webview/horizon_panel.html` (`142.4k`, `41.2k`) <!-- id: 1.2 -->
  - [x] Task 1.3: Reconcile and unify cache-warmth status across `/api/state` (`sessionRisk`, `quota.cache`, `compactionCoach`) <!-- id: 1.3 -->
  - [x] Stage 1 Verification: Test run & mirror sync <!-- id: 1.4 -->

- [x] **Stage 2: Ingestion & Parser Sanitization** `[Flash / Sonnet • Medium | ~3h]` <!-- id: 2 -->
  - [x] Task 2.1: Strip host XML tags (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`) in `src/core/classifier.mjs` before running `userCorrections` and `/compact` prompt synthesis <!-- id: 2.1 -->
  - [x] Task 2.2: Fix `isCompactionCheckpointStep` in `src/core/compaction_coach.mjs` so reading/discussing `<CONTEXT_SUMMARY>` in tool results never slices active step history <!-- id: 2.2 -->
  - [x] Task 2.3: Classify Antigravity background task completion events (`SYSTEM_MESSAGE` with `Task id "..." finished`) as `ACTIVE_WORKING_SET` instead of `ANCHOR` in `src/core/classifier.mjs` <!-- id: 2.3 -->
  - [x] Task 2.4: Deduplicate MCP server schemas (`chrome-devtools` vs `chrome_devtools`) in `mcpAudit` <!-- id: 2.4 -->
  - [x] Stage 2 Verification: Test run & mirror sync <!-- id: 2.5 -->

- [x] **Stage 3: Windows Hook Pathing & Plugin Mirror Consolidation** `[Sonnet / Argon • Medium | ~3h]` <!-- id: 3 -->
  - [x] Task 3.1: Fix `scripts/sync_mirrors.mjs` to preserve absolute quoted forward-slash paths in `hooks.json` instead of overwriting with relative `./src/hooks/...` <!-- id: 3.1 -->
  - [x] Task 3.2: Wire `src/hooks/post_invocation.mjs` to `parseTranscriptIncremental()` so `sidecar.telemetry.totalInputTokens` updates in standalone CLI/hook mode <!-- id: 3.2 -->
  - [x] Task 3.3: Consolidate `plugin.json` manifests across repo and mirrors; increase Windows hook `readStdinSafe()` timeout (`150ms` -> adaptive `1000ms` EOF-aware) <!-- id: 3.3 -->
  - [x] Stage 3 Verification: Test run & mirror sync <!-- id: 3.4 -->

- [x] **Stage 4: High-Risk Detector & Guardrail Bugfixes** `[Opus / Argon • High | ~5h]` <!-- id: 4 -->
  - [x] Task 4.1: Support Antigravity edit tool schemas (`TargetContent`, `ReplacementContent`, `ReplacementChunks`) in `detectors_det01_to_16.mjs` and `server.mjs` <!-- id: 4.1 -->
  - [x] Task 4.2: Replace destructive `git checkout -- "<filePath>"` in `src/core/coach/circuit_breakers.mjs` with non-destructive diff previews or explicit user confirmation <!-- id: 4.2 -->
  - [x] Task 4.3: Fix `src/shims/agy_git_guard.mjs` argument parser so commit messages after `-m` / `-F` (`git commit -m "-next..."`) are never blocked as `-n` (`--no-verify`) <!-- id: 4.3 -->
  - [x] Task 4.4: Fix `src/core/telemetry/scope_lock_registry.mjs` `task.md` claiming (ignore completed `[x]` items and version strings; include modified dotfiles from `git status`) <!-- id: 4.4 -->
  - [x] Task 4.5: Fix `src/core/prefix_cache_shield.mjs` premature queue flushing when `isPrefixLocked` is false, and harmonize the 5 conflicting warm-cache token thresholds (`15k..160k`) <!-- id: 4.5 -->
  - [x] Stage 4 Verification: Test run & mirror sync <!-- id: 4.6 -->

- [x] **Stage 5: UI Invariants, DOM Polish & Extensibility** `[Flash / Sonnet • Low | ~3h]` <!-- id: 5 -->
  - [x] Task 5.1: Fix duplicate DOM IDs (`#compactInstruction`, `#compactReclaim`) across Simple and Advanced views in `src/webview/horizon_panel.html` <!-- id: 5.1 -->
  - [x] Task 5.2: Deduplicate the active session entry in `#sessionSelect` dropdown (`horizon_panel.html`) <!-- id: 5.2 -->
  - [x] Task 5.3: Restrict `topRiskyCells` in `src/core/classifier.mjs` to cells with `wasteTokens > 0` or genuine trough risk (no `[Re-Anchor / Prune]` on clean 100%-recall cells) <!-- id: 5.3 -->
  - [x] Task 5.4: Never flag active `language_server.exe` as an orphan/cron PID (`[Stop 1 Cron PID]`) in `server.mjs` / `horizon_panel.html` <!-- id: 5.4 -->
  - [x] Task 5.5: Run `node scripts/sync_mirrors.mjs` and verify 3-way SHA-256 parity <!-- id: 5.5 -->
  - [x] Stage 5 Verification: Full test suite passing <!-- id: 5.6 -->

---

## Part II — `<1 Day` High-Impact Community Trust, Growth & Launch Levers (Stages 6–12)

- [x] **Stage 6: Anti-"AI-Slop" De-Jargoning & Repo Hygiene Sweep** `[Flash / Sonnet • Low | ~3h]` <!-- id: 6 -->
  - [x] Task 6.1: Plain-English terminology sweep across UI, CLI, hooks, and docs:
    - `"Chrono-Attention Horizon"` -> `"Context Horizon"`
    - `"Prefix Amputation"` / `"Amputation Crisis"` -> `"Context Truncation Risk"` / `"Oldest Rules at Risk"`
    - `"Sludge Tax"` / `"Uncached Tail Sludge"` -> `"Wasted Tokens"` / `"Stale Output Waste"`
    - `"Signal Purity"` -> `"Useful Context %"`
    - `"RSI Instinct Engine"` -> `"Session Rule Candidates"` <!-- id: 6.1 -->
  - [x] Task 6.2: Fix Turn vs. Step counter in `horizon_panel.html` and `classifier.mjs`: show real user turns (`Turn 3 · 30 steps`) instead of labeling raw JSONL step indices as `"Turn 30"` <!-- id: 6.2 -->
  - [x] Task 6.3: Fix quota polarity copy in `horizon_panel.html` (`"79% used (~21% left)"` instead of ambiguous `"~79.1% est."`, and suppress `"Lockout Risk"` when `lockoutRisk === false`) <!-- id: 6.3 -->
  - [x] Task 6.4: Read version dynamically from `package.json` across `init.mjs`, `doctor.mjs`, `sidecar_store.mjs`, and `bench_latency.mjs` (eliminate `3.1.0` / `3.1.1` / `3.2.0` drift) <!-- id: 6.4 -->
  - [x] Task 6.5: Clean public repo tree: archive/remove internal AI audit dumps (`docs/SYSTEMWIDE_COHERENCE_AUDIT_*.md`), deduplicate `docs/UI.jpg` vs `docs/UI.png`, and put real public model IDs (`claude-sonnet-4-5`, `claude-opus-4-1`, `gemini-2.5-pro`) first in public config/README examples <!-- id: 6.5 -->

- [x] **Stage 7: Zero-Config One-Command Claude Code + Cursor + Antigravity Onboarding (`3–5x` Reach Lever)** `[Sonnet / Argon • Medium | ~6h]` <!-- id: 7 -->
  - [x] Task 7.1: Make bare `npx ctxtop` auto-discover the newest active session across `~/.claude/projects/` (Claude Code), Cursor `workspaceStorage/**/state.vscdb`, and `~/.gemini/antigravity*/brain` (only fall back to `--demo` if zero sessions exist, with a clear tip) <!-- id: 7.1 -->
  - [x] Task 7.2: Add `npx ctxtop ui` / `npx ctxtop --open` to launch the loopback server and open Simple View in the default browser in one command with **zero hook installation required** <!-- id: 7.2 -->
  - [x] Task 7.3: Suppress Node's noisy `ExperimentalWarning: SQLite is an experimental feature` on CLI/daemon entrypoints, set `"engines": { "node": ">=22.5.0" }` in `package.json`, and print a friendly 2-line upgrade hint on Node `<22.5` instead of crashing on `node:sqlite` import <!-- id: 7.3 -->
  - [x] Task 7.4: Unify daemon port discovery (`47821` in `sidecar.json` vs `62935–62945` in `server.mjs`) and write `~/.ctxtop/daemon.port` so CLI, healthchecks, and UI always agree <!-- id: 7.4 -->
  - [x] Task 7.5: End-to-end live verification of Claude Code JSONL (`cache_read_input_tokens`, `cache_creation_input_tokens`, `/rewind` DAG) and Cursor `state.vscdb` sessions in Simple View <!-- id: 7.5 -->

- [ ] **Stage 8: Zero-Annoyance Day-1 Defaults & Detector Consolidation (D30 Retention Lever)** `[Sonnet • Medium | ~3h]` <!-- id: 8 -->
  - [ ] Task 8.1: Default `hook_level` to `"advisory"` (warn-only, never halt) in `config/default_flightcheck.json` and `src/core/config.mjs` <!-- id: 8.1 -->
  - [ ] Task 8.2: Disable automatic cold-start prompt scorecards on `Turn <= 2` (`State 8: HALT_REWRITE_SCORECARD`); run prompt scorecards strictly on explicit `#check` user opt-in <!-- id: 8.2 -->
  - [ ] Task 8.3: Make `.agents/shims/` (`DET-19` git wrapper and `DET-18` CLI compressor) explicit opt-in (`npx ctxtop init --with-shims`), off by default <!-- id: 8.3 -->
  - [ ] Task 8.4: Remove or hard-disable `src/core/ag_bridge.mjs` (`--csrf_token` process-flag scraping & internal RPC calls) so the repo maintains 100% pure read-only security credibility <!-- id: 8.4 -->
  - [ ] Task 8.5: Exempt small repo onboarding files (`README.md`, `AGENTS.md`, `CLAUDE.md`, `package.json` `< 250` lines) from cross-session `"Chronic Re-Read"` alerts unless re-read `>= 3` times within a single session <!-- id: 8.5 -->
  - [ ] Task 8.6: Resolve all 7 `DET-*` ID collisions (`DET-04/05/06/10/12/13/15/16`) into one canonical `detector_registry.mjs` and expose per-detector on/off toggles in `config.json` + UI `⚙` settings <!-- id: 8.6 -->

- [ ] **Stage 9: Radical Honesty & HN-Skeptic Proofing** `[Flash / Sonnet • Low | ~3h]` <!-- id: 9 -->
  - [ ] Task 9.1: Badge estimated vs. exact token numbers in UI & CLI (`28.6k` when from provider usage metadata vs. `~28.6k est.` when from `chars / 4` fallback) <!-- id: 9.1 -->
  - [ ] Task 9.2: Label the middle-of-context trough indicator transparently as a positional recall heuristic rather than measured transformer attention weights <!-- id: 9.2 -->
  - [ ] Task 9.3: Fix `src/core/git_ledger.mjs` commit-to-session window attribution (currently returning `attributedTokens: 0` across recent commits) and hide empty `$0.0000` ledger rows <!-- id: 9.3 -->
  - [ ] Task 9.4: Add a **"How Every Metric Is Computed (Source-Linked)"** table + **"Verify Zero-Network & Read-Only SQLite in 10 Seconds"** audit commands to `README.md` <!-- id: 9.4 -->

- [ ] **Stage 10: Single-Package & Single-Plugin Packaging Cleanup** `[Sonnet • Medium | ~2.5h]` <!-- id: 10 -->
  - [ ] Task 10.1: Trim `package.json` `bin` entries from 6 confusing names down to `ctxtop` (primary) and `context-horizon` (package match) <!-- id: 10.1 -->
  - [ ] Task 10.2: Unify `agy-horizon` and `agy-horizon-flightcheck` into a single plugin package and retire duplicate `agy-horizon/src/cli/horizon_hook.mjs` <!-- id: 10.2 -->
  - [ ] Task 10.3: Prune or gate speculative bloat modules (`rsi_instinct_engine.mjs`, duplicate `src/core/coach/task_quota_router.mjs`) so `src/core/` is lean and auditable <!-- id: 10.3 -->

- [ ] **Stage 11: High-Conversion README, Hero GIF & Viral Shareables** `[Flash / Sonnet • Medium | ~4h]` <!-- id: 11 -->
  - [ ] Task 11.1: Capture/generate an above-the-fold **Simple View + CLI GIF** showcasing the 3 unique "aha" moments: 40-cell context bar, warm-cache `/compact` hold timer, and `415x` subagent isolation pill <!-- id: 11.1 -->
  - [ ] Task 11.2: Add a concise **"How `ctxtop` Compares to `ccusage`, `/context`, and Cloud Proxies"** positioning table near the top of `README.md` <!-- id: 11.2 -->
  - [ ] Task 11.3: Polish `npx ctxtop --roast` into a screenshot-ready 12-line terminal card (top 3 duplicate-read files, Turn-0 MCP schema cost, cache busts, reclaimable tokens) with `--markdown` export for PRs/X/Reddit <!-- id: 11.3 -->
  - [ ] Task 11.4: Rebuild `docs/index.html` (`npm run build:assets`) so the GitHub Pages live interactive demo opens in **Simple View** with real-looking sanitized fixtures and zero hardcoded `142.4k` / `41.2k` counters <!-- id: 11.4 -->

- [ ] **Stage 12: Clean-Room Release Gate & Show HN Launch Kit** `[Sonnet • Medium | ~2h]` <!-- id: 12 -->
  - [ ] Task 12.1: Run `npm pack` clean-room install test in an isolated temp folder on Windows + Linux/macOS (Claude Code dir, Cursor dir, Antigravity dir, and empty dir graceful state) <!-- id: 12.1 -->
  - [ ] Task 12.2: Update `.github/workflows/ci.yml` to run on `ubuntu-latest`, `windows-latest`, and `macos-latest` (Node 22.x) with automated regression gates blocking hardcoded metric literals and relative hook paths <!-- id: 12.2 -->
  - [ ] Task 12.3: Draft `Show HN: ctxtop – htop for your AI agent's context window (local, 0 deps)` + transparent founder first-comment covering exact vs. estimated token math, multi-harness support, and roadmap <!-- id: 12.3 -->
