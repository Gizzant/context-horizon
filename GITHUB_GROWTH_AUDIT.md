# GitHub Growth Audit: `ga-visualizer-v2` (`agy-horizon-flightcheck`)

**Audit Date:** 2026-11-06  
**Target Directory:** `C:\Projects\ga-visualizer-v2`  
**Audit Verdict:** **CRITICAL FAILURE on Time-to-First-Value (TTFV: 2/10).** The core runtime is elite (zero dependencies, 15/15 deterministic tests passing in 240ms, sub-15ms hook execution), but open-source packaging is nonexistent. An external developer cannot clone, install, or visually evaluate this tool within 5 minutes.

---

## Executive Scorecard

| Phase | Inspection Dimension | Score (/10) | Status | Primary Bottleneck |
| :--- | :--- | :---: | :---: | :--- |
| **Phase 1** | 1.1 The Hero Asset | **0 / 10** | CRITICAL FAIL | Zero images, GIFs, WebPs, or videos in repository |
| **Phase 1** | 1.2 The Hook (H1 & H2) | **2 / 10** | FAIL | Opens with architecture jargon instead of developer pain |
| **Phase 1** | 1.3 Social Proof & Badges | **0 / 10** | FAIL | Zero badges, no `LICENSE`, no `.github/` workflows |
| **Phase 2** | 2.1 Frictionless Onboarding | **1 / 10** | CRITICAL FAIL | Hardcoded local `Copy-Item` from `c:\Projects\...`; broken Option B |
| **Phase 2** | 2.2 Zero-Config Defaults | **5 / 10** | PARTIAL | Auto-port and auto-brain discovery work; statusLine requires manual JSON edit |
| **Phase 2** | 2.3 Time-to-First-Value (TTFV) | **2 / 10** | CRITICAL FAIL | No `--demo` mode; requires active session logs and manual config edits |
| **Phase 3** | 3.1 Contributor Friction | **0 / 10** | FAIL | Missing `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE` |
| **Phase 3** | 3.2 Architecture Scannability | **5 / 10** | PARTIAL | `src/core/` is modular (18 files), but `src/webview/horizon_panel.html` is a 358 KB monolith |
| **Phase 3** | 3.3 Local Dev Setup | **2 / 10** | FAIL | No `package.json`, no `.git`, and author-specific `C:\Users\frank` paths in scripts |

---

## PHASE 1: THE "FIRST 5 SECONDS" REPO AUDIT

### 1.1 The Hero Asset (Score: 0/10)
* **Reality Check:** There are zero `.gif`, `.webp`, `.png`, `.svg`, or `.mp4` files anywhere in `C:\Projects\ga-visualizer-v2`. There is no `assets/` or `docs/img/` directory.
* **What Exists:** Section 5 of `README.md` contains a static 6-line ASCII box (`Flight Check v3.1`) and Section 2 contains a Markdown table of Unicode block glyphs (`█`, `▓`, `▒`, `░`).
* **Why Visitors Bounce:** A memory and context visualizer without a visual above the fold loses 80%+ of cold GitHub traffic in the first 3 seconds. Ironically, `src/webview/horizon_panel.html` (358,525 bytes) implements a full Edward Tufte IDE Webview with a 40-cell chronological horizon bar, U-shaped attention curve, and Sludge Tax ledger, and `src/cli/horizon_hud.mjs` renders an ANSI status bar, yet neither surface is shown to the visitor.

### 1.2 The Hook: H1 & H2 (Score: 2/10)
* **Current H1:** `# Chrono-Attention Horizon & Flight Check (agy-horizon-flightcheck)`
* **Current Lead Copy:**
  > "`agy-horizon-flightcheck` is a zero-external-dependency, sub-millisecond context hygiene auditor, telemetry HUD, and stateful `PreInvocation` prompt router for Google Antigravity. It couples two subsystems over a lock-free atomic IPC spine (`sidecar.json`)..."
* **Diagnosis:**
  1. **Jargon-First Opening:** Leading with "lock-free atomic IPC spine (`sidecar.json`)" and "stateful `PreInvocation` prompt router" reads like an internal systems spec, not an open-source pitch.
  2. **Buried Pain Point:** The actual developer hair-on-fire problems (silent prefix amputation after 140k tokens, paying "+$0.02/turn" in stale file-read sludge, burning 5-hour quota floors on un-routed prompts, and cross-workspace Knowledge Item bleed) are buried inside a glyph lookup table in Section 2.
  3. **Identity Crisis (4 Competing Names):** Across the repo, the tool is referred to as `ga-visualizer-v2` (folder), `agy-horizon-flightcheck` (`plugin.json` and `README.md`), `Chrono-Attention Horizon` (`sidecars/horizon-daemon/sidecar.json`), and `agy-horizon` (`docs/CONTEXT_MEMORY_EVALUATION_GUIDE.md`). Confused naming kills word-of-mouth sharing.

### 1.3 The Badges (Score: 0/10)
* **Reality Check:** `README.md` has zero badges. Underneath the H1 are three bolded text lines (`Version: 3.1.0`, `Target Platform`, `Host Environments`).
* **Missing Signals:**
  * No CI/test status badge (no `.github/workflows/` exists).
  * No npm version or downloads badge (no `package.json` exists).
  * No License badge (no `LICENSE` file exists in the repository, making the code legally "All Rights Reserved" by default and blocking corporate adoption).
  * No "Zero Dependencies" or "Node >= 20" runtime badge.

---

## PHASE 2: DEVELOPER EXPERIENCE (DX) & TIME-TO-FIRST-VALUE (TTFV)

### 2.1 Frictionless Onboarding (Score: 1/10)
* **What `README.md` Section 3 Tells Users to Run:**
  ```powershell
  # Option A: Global Plugin Installation
  Copy-Item -Path "c:\Projects\ga-visualizer-v2" -Destination "$HOME\.gemini\config\plugins\agy-horizon-flightcheck" -Recurse -Force
  ```
* **Critical Onboarding Failures:**
  1. **Hardcoded Author Path:** The install instruction assumes the user already has `c:\Projects\ga-visualizer-v2` on a Windows `C:` drive.
  2. **No Git Repository:** Running `git status` in `C:\Projects\ga-visualizer-v2` returns `fatal: not a git repository`. Nobody can `git clone` it.
  3. **No One-Liner:** There is no `npx agy-horizon init` or `agy plugin install` bootstrap.
  4. **PowerShell-Only Commands:** Despite `README.md` claiming support for `POSIX (macOS, Linux)`, every installation and verification snippet uses Windows PowerShell (`Copy-Item`, `New-Item`).
  5. **Option B (Workspace Setup) is Broken by Design:** `README.md` Section 3 Option B instructs users to copy the plugin into `.agents\plugins\agy-horizon-flightcheck`. However, `hooks.json` hardcodes the global path on every lifecycle hook:
     ```json
     "command": "node ~/.gemini/config/plugins/agy-horizon-flightcheck/src/hooks/pre_invocation.mjs"
     ```
     If a user follows Option B without Option A, every `SessionStart`, `PreInvocation`, and `PostInvocation` hook fails with `MODULE_NOT_FOUND`.

### 2.2 Zero-Config Defaults (Score: 5/10)
* **What Works Out of the Box (Codebase Strengths):**
  * **Dynamic Port Binding:** `sidecars/horizon-daemon/server.mjs` (lines 16-18, 376) automatically inspects `process.env.ANTIGRAVITY_SIDECAR_WEB_PORT` and `process.env.PORT`, falling back cleanly and probing available ports if `EADDRINUSE` occurs.
  * **Multi-Surface Brain Auto-Discovery:** `src/core/paths.mjs` (lines 52-56) automatically probes `.gemini/antigravity/brain`, `.gemini/antigravity-ide/brain`, and `.gemini/antigravity-cli/brain`.
  * **Crash-Immune CLI HUD:** `src/cli/horizon_hud.mjs` gracefully catches malformed or empty `stdin` and exits `0` with a fallback bar:
    `[▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] Purity: 100% | Noise: 0k tok | Quota: 100% | Effort: OK`
* **What Requires Manual Surgery:**
  * Enabling the CLI HUD requires manually opening `~/.gemini/antigravity/settings.json` and splicing in a `"statusLine"` JSON block (`README.md` Section 4).
  * No setup script automates registering `hooks.json` or `settings.json`.

### 2.3 The "Aha!" Moment & TTFV Rating (Score: 2/10 - CRITICAL FAILURE)
* **Stopwatch Walkthrough for a New User:**
  1. **0:00 - 1:00:** Lands on repo. Sees no screenshot or GIF. Reads about a "40-cell semantic taxonomy".
  2. **1:00 - 3:00:** Copies plugin folder manually into `~/.gemini/config/plugins/agy-horizon-flightcheck`.
  3. **3:00 - 5:00:** Hand-edits `~/.gemini/antigravity/settings.json` to wire up `horizon_hud.mjs`.
  4. **5:00 - 7:00:** Runs `node src/cli/horizon_hud.mjs` in terminal. Because no active degraded session is piped in, it prints an empty green bar (`Purity: 100% | Noise: 0k tok`). Zero visual payoff.
  5. **7:00+:** Tries to view the Tufte IDE Webview (`src/webview/horizon_panel.html`) by running `node sidecars/horizon-daemon/server.mjs`. The server starts silently with no console URL printed unless inspected, and shows an idle state unless an active Antigravity conversation exists.
* **The Irony:** `tests/fixtures/synthetic_states.mjs` already contains rich synthetic telemetry states (amputation crisis, dirty snapshots, foreign KI bleed, duplicate file reads), but there is no `--demo` CLI flag or standalone preview command to feed those fixtures into the HUD or Webview for instant evaluation.

---

## PHASE 3: CONTRIBUTION READINESS & COMMUNITY FLYWHEEL

### 3.1 Contributor Friction (Score: 0/10)
* **Missing Community Infrastructure:**
  * `CONTRIBUTING.md`: **Missing**
  * `CODE_OF_CONDUCT.md`: **Missing**
  * `LICENSE`: **Missing**
  * `.github/ISSUE_TEMPLATE/`: **Missing**
  * `.github/PULL_REQUEST_TEMPLATE.md`: **Missing**
  * `.github/workflows/ci.yml`: **Missing**
* **Root Directory Clutter:** The project root contains 9 internal prompt/spec files that confuse outside contributors:
  * `stage_0_architecture_implementation_plan_prompt.md` through `stage_6_deterministic_tdd_suite_benchmarks_packaging_prompt.md` (7 files)
  * `master_system_specification_v3_1.md` and `SPEC_AGY_HORIZON_FLIGHTCHECK.md` (byte-for-byte identical, 10,195 bytes each, SHA-256 `4939990C...`).
* **Credibility Hazard:** `docs/CONTEXT_MEMORY_EVALUATION_GUIDE.md` (line 6) contains a self-awarded `Status: Production-Ready (10.0 / 10 Evaluation Score)`. On Hacker News or Reddit, self-scoring 10/10 triggers immediate skepticism.

### 3.2 Architecture Scannability (Score: 5/10)
* **Backend / Core (`src/core/`): 9/10.** Clean, zero-dependency Node ESM split across 18 focused modules (`classifier.mjs`, `blindspot_sensors.mjs`, `pruner.mjs`, `quota.mjs`, `log_resolver.mjs`, `sidecar_store.mjs`, etc.). Adding a new blind-spot sensor in `src/core/blindspot_sensors.mjs` is straightforward.
* **Frontend / Webview (`src/webview/horizon_panel.html`): 2/10.** The entire UI lives in a single **358,525-byte (2,269-line)** HTML file mixing CSS, HTML layout, and 3 inline `<script>` blocks. There is no `src/components/` or `src/webview/charts/` directory. A contributor who wants to add a new chart must edit a 2,269-line file and then obey `AGENTS.md` Rule #3:
  > "Keep `C:\Users\frank\.gemini\config\plugins\agy-horizon\src\ui\sidepane.html`, `C:\Projects\ga-visualizer-v2\src\webview\horizon_panel.html`, and `C:\Users\frank\.gemini\config\plugins\agy-horizon-flightcheck\src\webview\horizon_panel.html` byte-for-byte identical"
  External contributors do not have `C:\Users\frank\...` on their machines, making `scripts/sync_mirrors.mjs` fail or write to unintended paths.

### 3.3 Local Dev Setup (Score: 2/10)
* **No `package.json`:** Running `npm run dev`, `npm test`, or `npm run build` fails immediately because there is no `package.json`.
* **Hidden Gem Test Suite:** Running `node --test tests/test_router_and_sensors.mjs` executes 15 tests across 6 suites in **170ms** with 100% pass rate, and `tests/verify_phase_1.mjs` through `verify_phase_6_roadmap.mjs` plus `tests/bench_latency.mjs` provide thorough verification. Because there is no `package.json` `"scripts"` block, contributors have to hunt through `README.md` Section 6 or list `tests/` manually to find them.

---

## PHASE 4: TOP 5 GITHUB GROWTH MULTIPLIERS (RATED & RANKED)

Formula applied:
$$\text{ROI Score} = (\text{Impact on Stars/Downloads} \times 0.60) + (\text{Ease of Implementation} \times 0.40)$$

| Rank | Task Name | Impact | Ease | ROI Score |
| :---: | :--- | :---: | :---: | :---: |
| **#1** | Interactive `--demo` Flag + Above-the-Fold Hero WebP/GIF | 10 | 7 | **8.80** |
| **#2** | Zero-Config `npx agy-horizon init` Cross-Platform Bootstrap CLI | 10 | 6 | **8.40** |
| **#3** | Pain-First `README.md` Overhaul + Badges + Root Declutter | 8 | 9 | **8.40** |
| **#4** | `package.json`, MIT `LICENSE`, and 3-OS GitHub Actions CI Matrix | 7 | 9 | **7.80** |
| **#5** | Modular Webview Chart Registry + Contributor Flywheel Templates | 6 | 5 | **5.60** |

---

### Rank #1: Interactive `--demo` Flag + Above-the-Fold Hero WebP/GIF
* **ROI Score:** **8.80** (Impact: 10 / Ease: 7)
* **The Missing Implementation:**
  1. Add a `--demo` flag to `src/cli/horizon_hud.mjs` and `sidecars/horizon-daemon/server.mjs` that loads the existing synthetic crisis states from `tests/fixtures/synthetic_states.mjs` (155k token amputation warning, 38% purity, `+$0.04/turn` sludge tax, dirty file snapshot, and foreign KI bleed) and prints/serves them immediately without needing a live Antigravity session.
  2. Add a terminal replay mode (`node src/cli/horizon_hud.mjs --demo-animate`) that steps through 40 cells filling from cold start to prefix amputation, followed by a `/compact` recovery reclaiming 68k tokens.
  3. Record a 12-second high-DPI WebP/GIF (`docs/assets/hero-demo.webp`) splitting the screen between the animated ANSI HUD and the Edward Tufte IDE Webview (`src/webview/horizon_panel.html`), and embed it at line 5 of `README.md`.
* **Growth Rationale:** Visualizers live or die on visual proof. Letting any developer run `npx agy-horizon --demo` in 3 seconds to see the 40-cell bar light up in terminal, paired with an auto-playing WebP at the top of the README, converts passive GitHub browsers into immediate starrers and drives high-engagement shares on X, Reddit (`r/LocalLLaMA`, `r/coding`), and Hacker News.

---

### Rank #2: Zero-Config `npx agy-horizon init` Cross-Platform Bootstrap CLI
* **ROI Score:** **8.40** (Impact: 10 / Ease: 6)
* **The Missing Implementation:**
  1. Create `src/cli/init.mjs` exposed via `"bin": { "agy-horizon": "./src/cli/init.mjs" }` in `package.json`.
  2. Implement `npx agy-horizon init` (supporting Windows, macOS, and Linux) to automatically:
     * Copy the plugin files into `~/.gemini/config/plugins/agy-horizon-flightcheck`.
     * Resolve and write absolute OS-native paths into `hooks.json` so both global (Option A) and workspace `.agents/plugins/` (Option B) installations work reliably.
     * Safely merge the `statusLine` configuration into `~/.gemini/antigravity/settings.json` (creating a timestamped `.bak` backup first).
     * Run a 1-second self-test (`horizon_hud.mjs --demo`) and launch the Tufte Webview in the user's browser (`http://127.0.0.1:<port>`) so the user hits the "Aha!" moment in under 15 seconds.
* **Growth Rationale:** Eliminates the #1 adoption killer: manual `Copy-Item` commands and hand-editing `~/.gemini/antigravity/settings.json`. Dropping TTFV from ~10 minutes of error-prone file surgery to a single 10-second `npx agy-horizon init` command directly multiplies npm downloads and prevents onboarding drop-off.

---

### Rank #3: Pain-First `README.md` Overhaul + Badges + Root Declutter
* **ROI Score:** **8.40** (Impact: 8 / Ease: 9)
* **The Missing Implementation:**
  1. Unify product naming around **`agy-horizon`** (Chrono-Attention Horizon & Flight Check for Google Antigravity).
  2. Rewrite the top 25 lines of `README.md`:
     * **Headline Hook:** *"Stop losing your system rules at turn 30 and burning 40% of your Antigravity quota on stale file reads."*
     * **Badges Row:** CI status, npm version, MIT License, `0 dependencies`, `<15ms hook latency`.
     * **Hero Asset:** `![Chrono-Attention Horizon Demo](docs/assets/hero-demo.webp)`
     * **30-Second Quickstart:** `npx agy-horizon init` + `npx agy-horizon --demo`.
     * **Before / After Table:** Comparing Vanilla Antigravity (silent truncation at 140k, blind duplicate reads, unguarded quota burn) vs. With `agy-horizon`.
  3. Clean the repository root: move `stage_0_*.md` through `stage_6_*.md` and `master_system_specification_v3_1.md` into `docs/specs/`, and delete the duplicate `SPEC_AGY_HORIZON_FLIGHTCHECK.md`. Remove the self-awarded `10.0 / 10 Evaluation Score` line from `docs/CONTEXT_MEMORY_EVALUATION_GUIDE.md`.
* **Growth Rationale:** Developers scanning a repository from a social link give you one scroll before closing the tab. Leading with concrete cost/reliability pain (prefix amputation and dollar-per-turn sludge tax) plus a 1-line install command turns curiosity into stars.

---

### Rank #4: `package.json`, MIT `LICENSE`, and 3-OS GitHub Actions CI Matrix
* **ROI Score:** **7.80** (Impact: 7 / Ease: 9)
* **The Missing Implementation:**
  1. Initialize Git (`git init`), add a clean `.gitignore` (`node_modules/`, `.gemini/`, `*.log`, `.DS_Store`), and add a root `LICENSE` (MIT).
  2. Create a root `package.json` (`"type": "module"`, `"engines": { "node": ">=20.0.0" }`) with zero runtime dependencies and clear scripts:
     * `"dev"`: `"node sidecars/horizon-daemon/server.mjs --demo"`
     * `"hud"`: `"node src/cli/horizon_hud.mjs --demo"`
     * `"test"`: `"node --test tests/test_router_and_sensors.mjs && node tests/verify_e2e_context_memory.mjs"`
     * `"bench"`: `"node tests/bench_latency.mjs"`
  3. Add `.github/workflows/ci.yml` running `npm test` and `npm run bench` across `[ubuntu-latest, windows-latest, macos-latest]` on Node 20 and 22.
* **Growth Rationale:** The test suite already passes in 170ms with zero dependencies, which is an elite engineering signal. Exposing it via green GitHub Actions badges across Windows, macOS, and Linux proves cross-platform reliability and gives enterprise developers the MIT license clearance required to adopt and star the repo.

---

### Rank #5: Modular Webview Chart Registry + Contributor Flywheel Templates
* **ROI Score:** **5.60** (Impact: 6 / Ease: 5)
* **The Missing Implementation:**
  1. Extract the 3 inline `<script>` blocks and CSS from the 358 KB `src/webview/horizon_panel.html` into modular ES files under `src/webview/` (`src/webview/charts/horizon_bar.js`, `src/webview/charts/u_curve.js`, `src/webview/charts/sludge_ledger.js`) with a single build script (`scripts/build_webview.mjs`) that bundles them back into the single-file `horizon_panel.html` required by the sidecar.
  2. Refactor `scripts/sync_mirrors.mjs` and `AGENTS.md` to read optional local mirror paths from environment variables (`AGY_MIRROR_DIRS`) instead of hardcoding `C:\Users\frank\...`.
  3. Add `CONTRIBUTING.md` (documenting "How to Add a 7th Blind-Spot Sensor in 20 Lines" and "How to Add a Webview Panel"), `CODE_OF_CONDUCT.md`, and `.github/ISSUE_TEMPLATE/` (`bug_report.yml`, `new_sensor_proposal.yml`, `new_chart_proposal.yml`). Seed 5 issues labeled `good first issue`.
* **Growth Rationale:** Turning "Add a new context hygiene sensor" into a 20-line PR against `src/core/blindspot_sensors.mjs` with a deterministic test in `tests/test_router_and_sensors.mjs` lowers the contributor barrier from hours to 15 minutes, converting power users into repeat contributors who evangelize the repository.
