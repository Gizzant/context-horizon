# Changelog

All notable changes to the Highbeam (`highbeam-cli` / `ctxtop`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.4.1] - 2026-11-20

### Linux CI Offload Test Fix, Hybrid Pricing, 30-Day Emailed Trial & 144-Run Launch Pack

#### Fixed
- **Ubuntu CI Test Alignment (`test/claude-code/easy_fixes.test.mjs`)**: Replaced `cat dump.log` (intentionally excluded from flat Bash artifact offload by `classifyShellPostToolPolicy`) with non-FTS5 `curl -s https://example.com/dump.log` in the POSIX `0600`/`0700` file-permission test and added a cross-platform assertion covering both paths.
- **MCP Server Title Metadata (`packages/mcp/server.json`)**: Aligned server title to `Highbeam Context & KV-Cache MCP Server` at `v4.4.1`.

#### Added & Changed
- **Hybrid Pricing & Pilot/Audit Funnel (`pro_license.mjs`, `polar_webhook_worker.mjs`, `LICENSE-COMMERCIAL.md`, `README.md`)**: Kept live Polar SKUs (`$199` Founder Lifetime Cap-200 lead, `$149/yr` Pro Annual expensable, `$299/yr` 5-seat Founding Team Intro), replaced the `$39/seat/mo` cliff with `$15/seat/mo` standard (`$900/yr` 5-seat min, preserving legacy `$39/seat` webhook parsing), and added the Free 60-day Team Pilot and `$1,500–$3,000` Fixed-Price Context Audit offer.
- **30-Day Emailed Trial Worker Route (`packages/pro/workers/polar_webhook_worker.mjs`, `wrangler.toml`)**: Added `POST /trial` + `OPTIONS /trial` CORS routing to mint and email offline 30-day `CTXP1` evaluation tokens with email-hash KV deduplication.
- **Offline Zero-PII Share Snapshot (`bin/ctxtop.mjs receipt --share`)**: Formats a scrubbed 3-bucket snapshot separating `Avoided Writes`, `Ex-Post Realized Prompt-Bill Delta`, and `Provider KV-Cache Discount` without emitting local paths, hostnames, or usernames.
- **Claude Code Native Marketplace & `docs-site` Refresh (`.claude-plugin/marketplace.json`, `docs-site/`, `docs/launch/`)**: Added `/plugin marketplace add https://github.com/Gizzant/context-horizon`, refreshed `docs-site/` from stale `v4.1` copy to `v4.4.1`, published `docs-site/benchmark.html` + `docs/launch/BENCHMARK_LAUNCH_POST.md` (144 live runs including `T06` and `T09`–`T11` null results), and added `docs/launch/DISTRIBUTION_AND_PILOT_PACK.md`.

---

## [4.4.0] - 2026-11-20

### 72-Run Replicated Live A/B, 3-Bucket Savings UI & 19-Stack FTS5 Parsers

#### Added
- **Step Zero Telemetry & Orthogonal 3-Bucket Ledger (`savedQuotaLedger.mjs`, `saved_quota_ledger.mjs`)**:
  - Separated savings telemetry cleanly into **`avoidedWrites`** (real-time Highbeam interventions), **`realizedPromptBill`** (signed ex-post session vs. baseline wire delta), and **`platformCacheDiscount`** (provider KV-cache read discounts tracked separately and never credited to Highbeam ROI), plus wire/transcript capture (`wireObs`) and cold-resume `DET-17` fix.
- **Default Clamp-Only `auto` Shield & Net-Positive `PostToolUse` Filtering (`shield_manager.mjs`, `pre-tool-use-core.mjs`, `post-tool-use-core.mjs`)**:
  - Defaulted fresh Claude Code workspaces to clamp-only `mode: 'auto'` Shield (`updatedInput` `<=250L` / `<=16 KB` slices, `0` hard blocks), added net-positive FTS5/Shield gates, excluded file-inspection shell verbs (`cat`, `head`, `tail`, `sed`, `awk`, `grep`, `rg`, `jq`), and routed `Grep|Glob` through `PostToolUse` structured array filtering.
- **Opt-In Haiku Read-Only Scout (`agents/ah-haiku-scout.md`, `bin/ctxtop.mjs scout`)**:
  - Added `.claude-plugin/plugin.json` `agents[]` entry and `npx highbeam-cli scout <--enable | --disable | --status>` while keeping `autoTierReadOnlyScouts: false` by default.
- **19-Stack FTS5 Parsers (`src/core/fts5_output_compressor.mjs`, `scripts/run_antigravity_and_compression_benchmark.mjs`)**:
  - Added explicit structured parsers + fixtures (`F11-maven` through `F19-ctest`) for Maven, Gradle, .NET, Make, Playwright, RSpec, PHPUnit, Deno, and CTest with zero unmatched fallback (`96%` aggregate reduction, `100%` diagnostic recall, `100%` FTS5/MCP retrieval across `19` fixtures).

#### Verified & Changed
- **72-Run Replicated Live A/B (`T01`–`T08`, `n = 24`/arm, `anthropic/claude-sonnet-5.5`, [`highbeam_ab_results.json`](experiments/model-switch-benchmark/results/highbeam_ab_results.json))**:
  - Measured **`-13.31%` mean billed cost** (`$4.8174` vs. `$5.5569`, **`-14.39%` median paired delta**), **`-24.31%` prompt-bill tokens** (`6.85M` vs. `9.05M`, `-24.78%` cache writes, `-24.25%` cache reads), **`20/24` paired wins**, **`3/3` replications**, **`7/8` tasks**, **`100%` completion (`24/24`)**, **`1.004x` request ratio (`241` vs. `240`)**, **`0` hard denies**, and **`-16.94%` vs. `HIGHBEAM_SHIELD_OFF`** (`$4.8174` vs. `$5.7998`). *(Supersedes the single-replicate `v4.3.0` `-16.18%` / `n=1` figure below.)*
- **27-Run Exploration Scope Boundary (`T09`–`T11`, [`highbeam_ab_exploration_results.json`](experiments/model-switch-benchmark/results/highbeam_ab_exploration_results.json))**:
  - Verified null result on pure small-file code navigation (`$1.2346` `BASELINE` vs. `$1.3195` `HIGHBEAM` `+6.88%` vs. `$1.4085` `HIGHBEAM_SCOUT` `+14.08%`; `0/27` Shield clamps, `0/27` subagent spawns), scoping savings claims strictly to doc/log/audit workloads.
- **3-Bucket UI & Receipt Parity (`modViews.mjs`, `horizonPanelHtml.mjs`, `pdfReceiptGenerator.mjs`, WebView HUD & `docs/index.html`)**:
  - Surfaced explicit `Highbeam Avoided Writes` vs. `Platform Cache Discount (Provider KV)` splits across WebView Simple/Advanced views, Claude Code HTML/terminal panes, `copyPlainSavingsReceipt`, and PDF/Markdown/HTML FinOps receipts.

---

## [4.3.0] - 2026-11-19

### Waves 1–3 Token-Savings Suite, Zero-Round-Trip Shield & Tarball Compaction

#### Added
- **Wave 1 (`OPT-2` + `OPT-3`) — Unified `PostToolUse` FTS5 Parity, Explicit-Slice Clamping, Read-Interval Ledger & `GUARD-4` Fix**:
  - Reordered `hooks/handlers/post-tool-use-core.mjs` to run `stripAnsiAndSpinners` + `compressCliOutputFts5Sync` before flat `ARTIFACT_OFFLOAD_4K` file dumps (`CLI_FTS5_COMPRESSED`) without double-counting `totalSavedTokens` or duplicating unreplaced output into `additionalContext` in default `replace` mode.
  - Added `compressAntigravityPostOutput` and `recordAntigravityPostSavings` in `src/hooks/post_invocation_core.mjs`, keeping FTS5 DBs and fallback artifacts under `~/.gemini/antigravity/agy-horizon`.
  - Removed the `!hasLineBounds` bypass in `src/core/shield_manager.mjs`, `hooks/handlers/pre-tool-use-core.mjs`, and `src/hooks/pre_invocation_core.mjs`, enforcing explicit-slice bounds (`250L`/`20 KB` normal, `150L`/`8 KB` near cliff via `computeByteBoundedSliceWindow`), adding per-file read-interval overlap trimming/anchoring (`mergeLineIntervals`, `trimRequestedRangeAgainstIntervals`, auto-invalidated on `mtimeMs`/`size`/edits/mutating shell), and attaching bounded `updatedInput` slices on `GUARD-4` delta and AST stub reads.
- **Wave 2 (`OPT-1` + `OPT-4`) — Task-Boundary Compaction, Durable `StateBaton` Staging, Idle-TTL Pre-Compact Gate & Warm-Prefix Cache Shield**:
  - Extended `src/core-isomorphic/coach/smartCompactAdvisor.mjs` (`EDIT_TOOL_REGEX` now matches `edit_file|write_file`) and added `evaluateIdleTtlPreCompactGate` (`IDLE_TTL_PRE_COMPACT`, `>=60k` context after `>5m`/`>1h` idle expiry).
  - Wired task-boundary edit tracking into `hooks/handlers/pre-tool-use-core.mjs` (`saveBreakerWithBoundaryPreserved`), `StateBaton` pre-staging on `Stop` (`hooks/handlers/stop-gate.mjs`), Antigravity `evaluateAntigravityTaskBoundaryCompact` (`src/hooks/post_invocation_core.mjs` under `~/.gemini/antigravity/agy-horizon/batons`), and warm-prefix `DET-09` edit delta auto-staging + automatic `PostCompact` flush (`hooks/handlers/compact-lifecycle.mjs`, `hooks/handlers/user-prompt-submit.mjs`, `src/hooks/pre_invocation_core.mjs`).
- **Wave 3 (`OPT-5` + `OPT-6` Half) — Read-Only Subagent Auto-Tiering, Handoff Condenser & Terse `MCP_TOOLS`**:
  - Auto-tiered read-only scout spawns (`Task`/`Agent` → `haiku`, `invoke_subagent` → `flash` via `updatedInput`) in `AUTO_PILOT` when no Frontier model is explicitly pinned by the prompt.
  - Added `condenseSubagentHandoffOutput` in `src/core/coach/subagent_ipi_sanitizer.mjs` and wired `>1,200`-token subagent handoff condensing + raw FTS5 archiving + single-wrapper `DET-19` framing (`SUBAGENT_HANDOFF_CONDENSED`) into both Claude Code (`hooks/handlers/post-tool-use-core.mjs`) and Antigravity (`src/hooks/post_invocation_core.mjs`).
  - Compacted `MCP_TOOLS` prose descriptions in `packages/mcp/src/server.mjs` (`2,493` chars serialized across all 7 tools).
- **Paired Live OpenRouter A/B Benchmark (`experiments/model-switch-benchmark/results/highbeam_ab_results.json`)**:
  - Verified **`8/8` (`100%`)** task completion across alternating `BASELINE` vs. `HIGHBEAM` runs (`anthropic/claude-sonnet-5.5`), achieving **`-16.18%` net USD** (`$1.8557` → `$1.5555`, `-$0.3002`), **`-23.43%`** total prompt billable tokens (`-36.12%` `cache_creation`, `-21.65%` `cache_read`), `12` zero-round-trip byte clamps (`0` byte-cap hard blocks vs. `12` in `v4.2.3`), and `29` hook savings receipts (`79,155` tokens saved).

#### Changed & Packaged
- **Tarball & Cross-Package Parity Trim (`scripts/build_webview_html.mjs`, `packages/pro/src/_license.mjs`, `package.json`, `.npmignore`)**:
  - Added `packages/pro/src/_license.mjs` dual-resolver and excluded duplicate/legacy unreferenced assets from root `npm pack`, plus added ASI/template/regex-safe `<script>`/`<style>`/HTML build compaction (`src/webview/horizon_panel.html` `634,287` B, root `npm pack` `1,232,873` B / `270` entries).

## [4.2.3] - 2026-11-19

### Broad CLI FTS5 Compression, Byte-Width Read Clamping & Post-Edit Verify Fold

#### Added
- **Broad CLI FTS5 Compression (`IMP-1`, `src/core/fts5_output_compressor.mjs`, `hooks/handlers/post-tool-use-core.mjs`, `src/core-isomorphic/guards/losslessPostSanitizer.mjs`)**: Lowered compression threshold to `>=40` lines or `>=4,096` bytes, expanded command coverage across PowerShell (`Select-String`, `Get-ChildItem`/`gci`, `Get-Content`, `Write-Output`, `powershell`/`pwsh`, `@'` heredocs), `node`, `python`, `rg`/`grep`/`find`/`fd`/`tree`, `curl`/`wget`/`aws`/`gcloud`/`terraform`, `npm`/`pnpm`/`yarn`/`bun`/`pip`/`uv`/`poetry`, and `gh` / extra `git` verbs, added `search_list` and `generic_cli` families, and wired live `compressCliOutputFts5Sync` receipts (`CLI_FTS5_COMPRESSED`) into `runPostToolUseHook`.
- **Byte-Width Read Guard (`IMP-4D`, `src/core/shield_manager.mjs`, `hooks/handlers/pre-tool-use-core.mjs`)**: Guards unsliced reads exceeding `16 KB` (`6 KB` near pricing cliffs). On Claude Code, wide `>=20`-line files clamp in-place via `updatedInput` (`offset: 1`, bounded `limit`, inline `.index.md` map) with zero extra model turn; Antigravity, `line_cap` overflows, and `<20`-line minified blobs retain fail-closed structural index guidance.
- **Post-Edit Verify Re-Read Fold (`IMP-4B`, `src/core/code_fold_lite.mjs`, `hooks/handlers/pre-tool-use-core.mjs`, `src/hooks/pre_invocation_core.mjs`, `src/hooks/fast_hook_ipc.mjs`)**: Folds immediate post-Edit full-file verification re-reads (`>150` lines) into a `<=150`-line window centered on the edited hunk across Claude Code and Antigravity.
- **Paired Live OpenRouter A/B Benchmark (`experiments/model-switch-benchmark/cost_per_task/run_highbeam_ab.mjs`, `results/highbeam_ab_results.json`)**: Verified `8/8` (`100%`) task completion across alternating Highbeam-OFF vs. Highbeam-ON arms with `-13.37%` net USD reduction (`-33.58%` `cache_creation`, `-10.88%` `cache_read`).

#### Fixed
- **CI Suite Wiring & Flake Elimination**: Wired `test/imp1_and_imp4_token_guards.test.mjs` into `test/all.test.mjs` and replaced the 1-in-64 base64 flake in `test/pro_team_anchors.test.mjs` (`Pro Anchor #1`) with a deterministic `'A' <-> 'B'` tamper flip.
- **`@ctxtop/mcp` Packaging (`scripts/sync_workspaces.mjs`, `packages/mcp/package.json`)**: Normalized `bin` entries to `{ "mcp": "src/server.mjs", "ctxtop-mcp": "src/server.mjs" }`, eliminating all `npm publish` bin-renaming and path-normalization warnings while preserving `npx @ctxtop/mcp`.

## [4.2.2] - 2026-11-19

### Launch Polish, Unified Pricing, Split Receipt Units & Node 20 CI Matrix

#### Changed
- **Plain-English Top Screen & Empirical Anchor (`README.md`)**: Reframed the opening headline and subhead around concrete developer outcomes, fixed the Quick Start table formatting, added a live GitHub Actions CI status badge, and highlighted the settled 540-turn `Opus 4.6 -> Sonnet 4.6` cache-bust finding directly beneath the 10-second read-only audit command.
- **Explicit Token-Unit Split (`+12.0k` Stripped + `+152.0k` Cache Protected)**: Split the 4-step example receipt in `README.md` and `assets/hero-fts5-ttl-demo.gif` into fresh tokens removed (`physicalTokensAvoided`) vs. warm cache hits and rebuilds avoided (`billingEquivalentCacheTokens`), and refreshed all SVG/GIF/Zone-C HUD visuals plus `docs/index.html` to token-first `highbeam-cli v4.2` copy.
- **Unified Pricing & License Metadata**: Aligned pricing across `README.md` and `packages/pro/LICENSE-COMMERCIAL.md` (`$0` Free MIT Core, `$149/yr` Annual / `$199` Founder Lifetime cap-200 Pro + legacy `$15/mo` compatibility, `$299/yr` 5-seat Team Starter intro pack, `$39/seat/mo` Enterprise FinOps for `>5` seats), documented `mode`, `sync`, `pr-cost`, `team-rollup`, and `ci-gate` across the README and MDM/commercial docs, updated `package.json` `description`, and added `"license": "MIT"` to `.antigravity-plugin/plugin.json`.
- **Verified Node 20 LTS CI & Multi-Channel Release Parity**: Added a dedicated `Node 20.19.0 LTS (JSONL Fallback)` job to `.github/workflows/ci.yml` and synchronized `highbeam-cli`, `@ctxtop/mcp`, and `highbeam-4.2.2.vsix` at `v4.2.2`.

## [4.2.1] - 2026-11-18

### Token-First Developer UX & Extension Positioning Overhaul

#### Changed
- Refocused all individual-developer interfaces on **tokens saved**, **5-hour quota sprint longevity (`30%–50%`)**, and **Context Rot immunity**—removing distracting micro-dollar displays (`$0.00`, `$0.27`, `$1.84`) from the WebView Simple & Advanced HUDs, VS Code/Cursor status bar tooltips, Claude Code `statusLine` (`Saved +164k`), docked HUD panes, Shadow Auto banners, end-of-trial summaries, and CLI `audit` / `postmortem` / `init` output.
- Scoped USD FinOps metrics strictly to Team/Enterprise governance surfaces (`receipt --pdf`, `pr-cost`, `team-rollup`, `ci-gate`, `/cost-radar`, pricing tables, and empirical wire-benchmark docs) while preserving machine-readable JSON USD ledger fields.
- Fixed the VS Code/Cursor extension status bar formatter (`statusBarFormatter.js`) to read unified `savings.session.totalTokens` and `workspace30d.totalTokens` counters cleanly.

## [4.2.0] - 2026-11-18

### Defensible Pro & Team Commercial Anchors

#### Added
- **`highbeam sync` (`packages/pro/src/encrypted_sync.mjs`)**: Cross-machine zero-knowledge encrypted memory & 30-day savings ledger sync (`scrypt` + `AES-256-GCM`) with recursive secret/key scrubbing and LWW deduplicated merge.
- **`highbeam pr-cost` (`packages/pro/src/pr_cost_attribution.mjs`)**: Git branch and pull-request token, cache-hit, USD spend/saved, USD per 100 LOC, and Ring-0 detector attribution (`git log <base>..HEAD --numstat`).
- **`highbeam team-rollup` (`packages/pro/src/team_finops_rollup.mjs`)**: Salted-pseudonymous team snapshots (`dev_<12hex>`) gated behind a strict recursive PII/path/secret firewall (`FORBIDDEN_ZK_KEYS`) and offline org Markdown/JSON/CSV aggregation.
- **`highbeam ci-gate` (`packages/pro/src/ci_budget_gate.mjs`)**: CI/PR token-budget enforcement gate for GitHub Actions and GitLab CI driven by `.attention-horizon.json` `ciBudgetGate` policy.

## [4.1.6] - 2026-11-18

### Tarball Shrink & Restored Node.js 20 LTS Compatibility

#### Changed
- **35%–45% Smaller npm Package**: Removed duplicate workspace mirrors and deduplicated standalone MCP runtime packaging (`273` entries, `1.23 MB` packed / `4.92 MB` unpacked in `highbeam-cli@4.2.x`, down from `509` files / `9.2 MB` unpacked) while enabling dual MCP resolution across workspace and global installs.
- **Restored Node.js `>= 20.0.0` Support (Supersedes `4.1.4` `22.13` floor)**: Enabled pure-JavaScript JSONL fallbacks for FTS5/artifact log search and session savings ledgers whenever `node:sqlite` (`Node >= 22.13`) is absent.

## [4.1.5] - 2026-11-18

### `highbeam-cli` Rename, Mode-Driven HUD, VS Code `.vsix` & Gemini 4 Neon

#### Added
- **Package & Binary Consolidation**: Published under `highbeam-cli` with `highbeam` as the primary binary while keeping `ctxtop` and existing hook aliases backward-compatible.
- **Mode-Driven WebView UX (`Off / Coach / Auto / Settings`)**: Rebuilt the Simple & Advanced HUD around explicit `Off` (watch only), `Coach`, and `Auto` mode views plus a dedicated `Settings` dialog, with **tokens saved** as the headline KPI.
- **Zero-Dependency VS Code / Cursor / Antigravity `.vsix` Extension (`extensions/vscode-highbeam/`)**: Added native IDE sidebar WebView, live status bar item (`context %` + KV-cache `TTL`), `8` IDE commands, and `npm run build:vsix`.
- **Expanded Model Catalogs**: Added support for Gemini 4 Neon, Gemini 4 Carbon, Orchestrator models, and Claude 5.5 catalogs alongside softened legal/empirical wording (`Verified` -> `Estimated`).

## [4.1.4] - 2026-11-18

### Node 22.13 Requirement

#### Changed
- **Node.js 22.13 or newer is now required** (was 20). `node:sqlite` is available without a flag only from 22.13, and several features need it: instinct learning and the handoff checkpoint, the session timeline and Tokens Saved figures in the side pane, full-text search over saved output, and telling Antigravity subagent sessions apart. Node 20 reached end of life in April 2026 and never ran those features. `npm` warns on older Node (`engines`), `ctxtop doctor` reports it as a FAIL with the upgrade command, and `init` stops with a clear message. CI now tests Node 22 and 24.

#### Fixed
- The pure-JavaScript database fallback no longer crashes when `all()` or `get()` is called without a query.

## [4.1.3] - 2026-11-18

### Antigravity Guards, Flight Modes & Trial Results

#### Added
- Trial results: after the 14-day trial ends, the status bar shows a one-time "Trial ended" notice (about 24 hours, or until you run `npx ctxtop mode` or `license status`), and `mode` / `license status` (and their `--json` output) report how much Highbeam saved in this project during the trial. The figure counts all Highbeam savings in the trial window, not only Auto's; the savings ledger starts at $0 and is not back-filled from older chats (`npx ctxtop audit` shows what past sessions wasted).
- `ctxtop init` ends with a one-line teaser of what the last 7 days of your Claude Code, Antigravity, Codex, Gemini and Cursor sessions wasted that Highbeam would have caught (read-only scan of existing transcripts; silent when under $0.50; skip with `--no-audit`).
- Opt-in Antigravity hook trace: create `~/.ctxtop/hook_trace.on` to log each pre-tool hook call (event, tool, command, reply) to `~/.ctxtop/hook_trace.jsonl`.
- New `ctxtop mode [coach|auto|silent|off]` shows or sets the flight mode, so Claude Code users can turn Auto on from the CLI. Without Pro or the trial, Auto runs as COACH and says so. `license trial` now says Auto stays off until you turn it on, and `mode` / `license status` say when the trial has ended and Auto is paused.

#### Fixed
- A `#check` prompt now stops with the scorecard in Antigravity (which sends the prompt as `lastUserInput`) and is no longer shadowed by the context-crisis card when the chat is over 87% full.
- `license.json` written with a UTF-8 byte-order mark (Windows PowerShell 5.1 `Set-Content -Encoding utf8`) is read correctly instead of silently falling back to Free.
- `ctxtop license trial` with a paid key already active says so instead of reporting a new trial; a hand-edited trial that ends before it starts still reports the savings from its 14 days.
- Antigravity tool calls are now checked. Antigravity sends `toolCall: { name, args }` (and `hookEventName`), but the guards only read `tool_name` / `tool_input`, so every Antigravity tool call looked empty and was allowed, including `git push --force`. The hook now reads the documented shape.
- Antigravity prompt stops use the documented reply (`injectSteps` + `terminationBehavior: "terminate"`); the old shape was ignored. In `COACH`, only a 3-strike error loop, an explicit `#check`, or a detector set to `block` stops a prompt, as the README states; other states (for example the context-limit card) show as a message. `AUTO_PILOT` keeps every stop.

## [4.1.2] - 2026-11-17

### Packaging, Registry Distribution & Pre-Launch Hardening

#### Added
- `@ctxtop/mcp` registry distribution manifests (`smithery.yaml`, `glama.json`, `server.json`) and automated publication alongside `ctxtop` on release.
- Polar.sh license delivery: the webhook worker issues a key only on `order.paid` (every other event type is ignored, so one purchase can never email several keys), never emails a placeholder address when an order has no customer email (it answers 422 instead), and now emails the signed key to the buyer, de-duplicates retried webhooks, and enforces the 200-seat lifetime cap with a persistent counter. The key is never returned in the HTTP response.
- CI now runs on Node 20.19.0 as well as 22.14.0.
- `HIGHBEAM_POST_OUTPUT_MODE=context` restores the previous add-only post-tool output behavior (records no savings).

#### Changed
- Internal `PreToolUse` faults now allow the tool call (fail-open, exit `0` with a stderr diagnostic); deliberate guard blocks are unchanged; `HIGHBEAM_PRETOOL_FAIL_MODE=closed` restores the strict mode.
- Built-in tool output (Bash, etc.) is now **replaced** with the compacted version through `updatedToolOutput` instead of appended beside the original. The savings ledger records savings only when output was actually replaced.
- Saved command output (`.claude/cache/artifacts/`) is written owner-only (`0600` files in `0700` directories) on POSIX systems.
- `@ctxtop/pro` and the root `ctxtop` package no longer publish the webhook worker or `wrangler.toml`; they stay in the repository for the operator.
- Pro can no longer be unlocked with `CTXTOP_PRO_DEV=1` or `NODE_ENV=test`; the test bypass applies only inside Node's test runner.
- **Breaking:** removed the `CTXTOP_ED25519_PUBLIC_KEY_PEM` override. License keys are verified only against the public key pinned in the release.
- `ctxtop init` reports each host's real install scope (Claude Code defaults to this project, Antigravity to global), `--global` / `--project` now apply to every selected host, and passing both is rejected.
- Test scripts run with an isolated temporary home folder, so running the suites no longer installs the Antigravity plugin or writes state into the real `~/.gemini`, `~/.claude` or `~/.ctxtop`.
- Documentation and `doctor` now state one Node requirement: Node >= 20 (`node:sqlite` is used on Node >= 22.5, with a JSONL fallback otherwise).
- `--lean-hooks` (the default Claude Code install) and `hooks/hooks.json` keep `Read` in the `PreToolUse` matcher (so `GUARD-4` repeat-read delta reads and signature stubs run) while stripping `Grep` and `Glob` unless `--full-hooks` is passed.
- Launch tiers are limited to Pro Annual, Founder Lifetime, and Team Starter; corporate receipt tier labels and Polar checkout links are now dynamic, and the receipt ROI line shows the monthly equivalent for Team and one-time cost for Lifetime.
- `AUTO_PILOT` no longer blocks a model switch when its estimate rests mostly on default values; it shows an advisory instead.

#### Fixed
- Claude Code installs no longer write `hooks.modules` into `settings.json` (Claude Code 2.1.325 has no such setting and reported the file as invalid on every start); reinstalling removes the entry an earlier version added while keeping other entries, and `hooks/hooks.json` drops it too.
- Claude Code `PostToolUse` output offload now writes artifacts and savings lines when routed over IPC through the warm Highbeam daemon (`src/hooks/daemon_hook_bridge.mjs` now loads the Node file adapter).
- `ctxtop receipt` (and `panel`, `roast`, `radar`, `cost-radar`) run from a project now read that project's `.claude/cache/horizon_ledger.jsonl`, where hooks write savings, instead of reading a home-folder ledger and showing `$0.00`.
- `README.md` latency figures now describe what runs: each hook call is a short Node process (about 60–80 ms on Linux, 200–275 ms measured on Windows), not a sub-millisecond in-process tier.
- Claude Code shell output that hits Claude Code's own 30,000-character cap (`BASH_MAX_OUTPUT_LENGTH`) is left alone and records no savings, since Claude Code has already saved the full output to its own file and shows a short preview.
- `ctxtop init --antigravity` warns when the Antigravity hooks are switched off (`"enabled": false` in `hooks.json`), `--enable` turns them back on, and `doctor` reports that state as `WARN` instead of `Active`.
- Model-switch cost (DET-08) now counts every request in a turn and the cache writes inside it; on 42 benchmark switches, wrong holds fell from 6 to 3.
- `scripts/sync_mirrors.mjs` with `verifyOnly: true` no longer bootstraps missing plugin folders or writes into `.agents/` when run under an isolated test home (reports `not installed` instead).
- Mirror parity checks (`10.1` and `test_mirror_boot_smoke.mjs`) now reflect which mirror roots are installed and check `notInstalledRoots` when a root is absent, and CI runs `scripts/sync_mirrors.mjs` before the test suites (skipping gitignored local-only docs when building evaluation bundles).
- Updated clean-clone regression tests for `4.1.2` contracts: observed inputs + default-advisory coverage in Reverse Trial `AUTO_PILOT`, `updatedToolOutput` assertions for Bucket B `WebFetch`/`Grep` hooks, and optional gitignored doc checks in `D13`.
- Naming-hygiene checks now allow the canonical `https://gizzant.github.io/context-horizon/` and `https://github.com/Gizzant/context-horizon` (or `.git`) URLs while rejecting all other occurrences, and Proof 3 aligns `netRoiMultiplier` to the `$12.42/mo` Pro Annual default (`3.6x`).
- `ctxtop uninstall` now lists what it leaves behind (settings backups, artifact cache, `~/.ctxtop` incl. the `app/` runtime copy, Antigravity plugin folders, git exclude entry) instead of leaving them unmentioned.
- One Claude Code install command everywhere (`npx ctxtop init --claude [--global]`), one trial command (`npx ctxtop license trial`), consistent test/detector counts, and a hardened manual release workflow (pinned actions, tag/version checks, no swallowed publish errors).
- Claude Code hooks installed with `npx ctxtop install` / `init` no longer point into npm's temporary `_npx` cache (which npm prunes, silently breaking every hook). When run from a package-runner cache, ctxtop copies itself to `~/.ctxtop/app/<version>/` and wires the hooks there; git checkouts and global installs are used in place.
- `ctxtop install --help`, `init --help` and `uninstall --help` print help instead of running the command.
- The cross-worktree merge-conflict probe reports a clear `GIT_TOO_OLD` message on git < 2.38, and the related tests skip instead of failing.
- Sigstore provenance metadata (`repository` field, repository URL) and Linux fast-IPC socket path resolution.

## [4.1.0] - 2026-11-15

### Dual-Platform RSL Engine, Spec Integrity, Guard Waves & Simple View Guard Roster

#### Added
- **Dual-Platform Recursive Self-Learning (RSL) Engine** (`src/core/rsl_triage.mjs`, `src/core/rsl_distiller.mjs`, `src/core/rsl_ledger.mjs`, `src/hooks/{antigravity,claude}_rsl_hook.mjs`):
  - Contrastive session post-mortem triage with SHA-256 test-suite integrity gating (`evaluateTestIntegrityGate`).
  - Zero-token deterministic local distiller (`--mode local`, `<15ms`) plus opt-in Python SDK mode (`scripts/rsl_sdk_distiller.py --mode sdk`).
  - ExpeL weight decay and promotion lifecycle compiling rules, skills, and `PreToolUse` hooks simultaneously to `.agents/` and `.claude/`.
  - Unified `ctxtop rsl <status|list|run|promote|prune>` CLI subcommand.
- **Spec Integrity, Rule Clash & Turn-1 Gate** (`src/core/rsl_clash_auditor.mjs`, `src/core-isomorphic/diagnostics/prompt_hygiene_governor.mjs`):
  - **Sharded-Spec Consolidator** (`evaluateShardedSpecDrift`, `[CTX_HINT: SHARDED_SPEC]`, and `ctxtop handoff --consolidate`): detects multi-turn requirement drift (4+ requirement-modifying turns at >=25k tokens) and consolidates scattered constraints into a single contract.
  - **RSL Rule Clash & Polarity Auditor**: scans `AGENTS.md`, `CLAUDE.md`, `.agents/rules/*.md`, and `.claude/rules/*.md`, quarantining conflicting newly distilled RSL directives and reporting active clashes in `ctxtop rsl status`, `ctxtop doctor`, and the Horizon Panel.
  - **Turn-1 Contract Gate** (`evaluateTurn1ContractGate`, `[CTX_CONTRACT]`): nudges Turn-1 multi-file implementation prompts lacking target paths or verification commands to state invariants upfront before mutating files.
- **Simple View Live Guard Roster & Next-Action Signals** (`src/webview/horizon_panel.html`, `sidecars/horizon-daemon/server.mjs`):
  - Expanding **"Auto-guard activity"** in Simple view displays the live sorted guard roster (`#tsGuardList`: tripped -> blocks -> advises) driven directly from `DETECTOR_CATALOG` and live config overrides.
  - Added Next-action guidance in Simple view for tripped circuit breakers, sharded specs, and conflicting rules.
- **Zero-Token Shield (`doc_indexer.mjs`, `ctxtop shield`)**: structural document indexer, net-positive read firewall, and `ctxtop shield` CLI.
- **Bucket A + Bucket B Guardrail Waves**: promoted 10 validated Bucket B guards (`#2`, `#3b`, `#4`, `#5`, `#6`, `#8`, `#9`, `#13`, `#16`, `#19`) from shadow to default `COACH` mode alongside deterministic Bucket A guards.
- **Router Calibration & Claude 5.5/Fable Catalog Guardrails**: `PreModelSwitch` / `PostModelSwitch` session calibration, empirical horizon prior, Claude 5.5/fable model catalog entries, unknown-model safety pass-through, model-aware `DET-09`, and post-compact downshift.

#### Fixed
- Removed fabricated `12.4k` pinned-rules fallback, hard-coded `30` / `32` guard counts, and empty `~$0.00` / `30d: +0.0k` zero-savings placeholders from Simple view telemetry.

---

## [4.0.0] - 2026-11-12

### Unified `ctxtop` Package, Monorepo Workspaces & Simple/Advanced Telemetry HUD

#### Added & Changed
- Unified Antigravity and Claude Code harnesses under the `ctxtop` monorepo (`packages/core`, `packages/engine-node`, `packages/antigravity`, `packages/claude-code`, `packages/pro`, `packages/mcp`).
- Added Simple/Advanced surface toggle in `horizon_panel.html` with 360px compact viewport support and light/dark parity.

---

## [3.4.0] - 2026-11-10

### Sprint 1 + 2: Cost-Visibility Wedge (local/private build)

#### Added
- **Prefix-Cache Retention Index** (`src/core/sprint_metrics.mjs`): per-stream, turns 2+ only, TTL-expired turns excluded, bust cause attribution (`model_switch` / `prefix_mutation` / `prefix_drift`), USD savings and leakage, plus a per-turn `series` feeding the timeline.
- **Thinking vs. Generation Drift + DET-30 scratchpad-loop detector**: reasoning÷output ratio, TTFT, consecutive or cumulative loop escalation. Estimated thinking tokens are excluded.
- **Subagent `/swarm` & Git Worktree Topology** (`src/core/swarm_topology.mjs`):
  - Rebuilds the roster from `swarm` / `invoke_subagent` / `manage_subagents` / `send_message`.
  - Worker states: working, parked (`waiting`, $0), stopped, killed. Explicit `swarm status` output overrides inferred state.
  - Read-only `git worktree list --porcelain` probe (1.2s timeout, 15s memo).
  - DET-20 overlaps between scope leases.
  - Exposed as `state.swarmTopology`.
- **Panel drawer** `#swarmTopologyDrawer`: a 1-line pill when solo. It auto-expands once when workers > 0, worktrees > 1 or a DET-20 overlap appears.
- **`/cost-radar`**: skill, `ctxtop cost-radar [--out] [--json]` CLI and loopback `GET /api/cost-radar` (strict CSP). It renders a self-contained, script-free dark HTML/SVG timeline (`src/core/timeline_svg.mjs`) with:
  - a retention step chart with bust markers;
  - a drift sparkline with a TTFT strip;
  - a swarm/worktree graph.

#### Fixed
- Retention now reports **unmeasured** (`no_cache_telemetry`) when a transcript never exposes cache reads or writes, instead of a false "0% / N busts".
- TTFT ignores 0 ms deltas caused by second-resolution timestamps.
- Removed pre-existing empty `catch {}` blocks in `quota.mjs` and `classifier.mjs` (DET-05 hygiene).

## [3.2.0] - 2026-11-08

### Multi-Harness v2.0 Wedge & Production Hardening Release

#### Added
1. **Multi-Harness Trajectory Stitcher (`src/core/trajectory_stitcher.mjs`)**:
   - **Google Antigravity (`[App]`, `[IDE]`, `[CLI]`)**: Native protobuf wire-walker (`decodeProtobufWire`) inspects `conversations/<uuid>.db` (`steps` table binary `step_payload` and `metadata` blobs) in strict read-only mode to extract `file:///` workspace URIs and correlate with `transcript_full.jsonl` and `annotations/<uuid>.pbtxt`.
   - **Claude Code**: Reconstructs complete `uuid -> parentUuid` DAG trees up to the active `leafUuid`, accurately isolating `/rewind` forks, `file-history-snapshot` restore points, and Turn-1 `cache_creation_input_tokens`.
   - **Cursor**: Correlates `composerData:<id>`, `bubbleId:<id>:<bubble>`, `messageRequestContext`, and `agentKv:blob:*` (`requestId`) with `store.db` and timestamp-less `agent-transcripts/*.jsonl`.
2. **Offline Prefix-Safe Tool-Output Surgeon (`src/core/pruner.mjs`, `src/cli/doctor.mjs --prune-tools`)**:
   - Truncates stale, superseded tool results (duplicate full-file re-reads, unreferenced exploratory grep outputs, resolved test stderr) directly in offline transcripts.
   - Preserves Turn 0 anchor prompts and the newest 6 turns of live context; creates atomic `.pre_surgeon` rollback backups before applying surgical edits.
3. **Cursor `state.vscdb` Streaming Storage Doctor (`src/core/storage_doctor.mjs`, `src/cli/doctor.mjs --gc-cursor`)**:
   - Zero-`VACUUM` streaming SQLite compaction of `state.vscdb` that purges orphaned `bubbleId:*`, `checkpointId:*`, `messageRequestContext:*`, and unreferenced `agentKv:blob:*` rows.
   - Eliminates 30GB–100GB of dead IDE state without requiring 2x-disk-space lockouts or contending with active Cursor write locks.
4. **Antigravity Brain Recovery (`src/core/storage_doctor.mjs`, `src/cli/doctor.mjs --recover-brain`)**:
   - Identifies and recovers orphaned agent artifacts, task checklists, and code diffs in `~/.gemini/antigravity/brain/<uuid>` orphaned by cross-workspace branching.
5. **Dual-TTL KV-Cache Monitoring & Prefix Mutation Diffs (`src/core/quota.mjs`, `src/core/classifier.mjs`)**:
   - Independent tracking of 1-hour primary prompt cache TTL vs. 5-minute fallback/overage and subagent cache tiers.
   - `computePrefixMutationDiff` pinpoints exact turn index, component name, and byte offset of cache prefix mutations.
   - Cold-Session Cost Gate flags when restarting an expired session incurs a full 12.5x–80x uncached token penalty.
6. **Subagent Worktree Collision Sensor (`src/core/subagents.mjs`)**:
   - Real-time DAG tracking with independent 5-minute subagent cache countdowns.
   - Fires `SUBAGENT_FILE_COLLISION` warnings when concurrent subagent branches edit overlapping canonical file paths.
7. **SQLite FTS5 Episodic Memory & Git Ledger (`src/core/episodic_memory.mjs`, `src/core/git_ledger.mjs`)**:
   - Indexes historical session decisions, modified files, and resolved error signatures in local SQLite FTS5 (`porter unicode61`) for `<1,000`-token context re-anchoring.
   - Correlates `.git/logs/HEAD` commit timestamps against session windows to attribute exact token consumption, cache hit rate, and USD cost per commit.
8. **Zero-PII Forensic Sanitizer (`src/core/sanitizer.mjs`)**:
   - Redacts Anthropic/OpenAI/Gemini API keys, GitHub PATs, AWS secrets, Bearer tokens, `.env` secrets, and OS user home paths prior to forensic JSON export.
9. **Zero-Config Test Discovery (`test/all.test.mjs`)**:
   - Standard root test file enabling single-command `node --test` execution across all 62 unit, wedge, concurrency, and schema drift tests.

#### Fixed & Enhanced
- **Top Risky Cells Hero Section**: Surfaced top 3–5 highest-risk context cells directly underneath the 40-cell flamegraph with exact file paths, attention recall %, and 1-click remediation actions.
- **MCP Schema ROI & Lazy Switching**: Added idle bloat tax calculation and one-click `[Switch to Lazy]` action for 0-call eager MCP servers.
- **Silent-When-Nominal Watchdog**: Host RAM and zombie process counters stay hidden during normal operation to maximize Edward Tufte data-ink ratio.
- **3-Way WebView Mirror Parity**: Verified SHA-256 byte-for-byte parity across `attention-horizon-antigravity`, `agy-horizon`, and `agy-horizon-flightcheck`.

#### Verification & Quality Gates
- **Unit Suite (`node --test`)**: 62 tests passing across 24 suites (0 failures).
- **Phases Suite (`npm run test:phases`)**: All 7 Show-HN phase verification suites passing (0 errors).
- **End-to-End Suite (`npm run test:e2e`)**: 7 validation layers verified (0 errors).
- **Zero Runtime Dependencies**: Confirmed 0 dependencies in `package.json`.
- **Zero-Trust Read-Only Safety**: Confirmed all SQLite connections open with `SQLITE_OPEN_READONLY_OPTIONS`.

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
- **3-Way WebView Mirror Parity**: Byte-for-byte identical across `attention-horizon-antigravity`, `agy-horizon`, and `agy-horizon-flightcheck` (`SHA-256: 56eaad262dc9124191d0a03334b1df51d414f81691498612beda71fec6ac6347`).
