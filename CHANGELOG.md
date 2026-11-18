# Changelog

All notable changes to the Highbeam (`attention-horizon-antigravity` / `ctxtop`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.1.2] - 2026-11-17

### Packaging, Registry Distribution & Pre-Launch Hardening

#### Added
- Trial results: after the 14-day trial ends, the status bar shows a one-time "Trial ended" notice (about 24 hours, or until you run `npx ctxtop mode` or `license status`), and `mode` / `license status` (and their `--json` output) report how much Highbeam saved in this project during the trial. The figure counts all Highbeam savings in the trial window, not only Auto's; the savings ledger starts at $0 and is not back-filled from older chats (`npx ctxtop audit` shows what past sessions wasted).
- `ctxtop init` ends with a one-line teaser of what the last 7 days of your Claude Code, Antigravity, Codex, Gemini and Cursor sessions wasted that Highbeam would have caught (read-only scan of existing transcripts; silent when under $0.50; skip with `--no-audit`).
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
- Antigravity tool calls are now checked. Antigravity sends `toolCall: { name, args }` (and `hookEventName`), but the guards only read `tool_name` / `tool_input`, so every Antigravity tool call looked empty and was allowed, including `git push --force`. The hook now reads the documented shape.
- Antigravity prompt stops use the documented reply (`injectSteps` + `terminationBehavior: "terminate"`); the old shape was ignored. In `COACH`, only a 3-strike error loop, an explicit `#check`, or a detector set to `block` stops a prompt, as the README states; other states (for example the context-limit card) show as a message. `AUTO_PILOT` keeps every stop.
- Opt-in Antigravity hook trace: create `~/.ctxtop/hook_trace.on` to log each pre-tool hook call (event, tool, command, reply) to `~/.ctxtop/hook_trace.jsonl`.
- New `ctxtop mode [coach|auto|silent|off]` shows or sets the flight mode, so Claude Code users can turn Auto on from the CLI. Without Pro or the trial, Auto runs as COACH and says so. `license trial` now says Auto stays off until you turn it on, and `mode` / `license status` say when the trial has ended and Auto is paused.
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
