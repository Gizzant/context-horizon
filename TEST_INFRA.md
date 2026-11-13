# Highbeam v4.0 (`ctxtop`) — End-to-End Test Infrastructure (`TEST_INFRA.md`)

## 1. Testing Philosophy: Pure Opaque-Box Requirement-Driven Simulation

The Highbeam v4.0 E2E testing framework provides opaque-box, requirement-driven verification for the unified `ctxtop` platform across Google Antigravity and Claude Code. The test suite operates strictly as an external host environment and client simulator.

### Core Testing Tenets:
1. **Opaque-Box Boundary**: Tests verify observable public contracts—CLI arguments, stdout/stderr, exit codes, IPC socket wire protocols (JSON-RPC 2.0), persisted disk files (`.ctl` state, `.jsonl` audit records, `.ah-backup.*`), and trajectory schemas (`USTF v1`). Tests never couple to private module closures or internal implementation states.
2. **Zero External Dependencies**: All test helpers, fixtures, runners, and invariant checks run entirely on Node.js built-in modules (`node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:os`, `node:net`, `node:crypto`). Neither runtime npm dependencies nor dev runtime libraries (e.g., `jsdom`, `mocha`, `jest`, `vitest`) are permitted in the E2E harness.
3. **Dual Runtime Matrix (Node 20 LTS vs. Node >=22.5)**: The harness supports Node.js 20.0.0+ and Node.js >=22.5.0 natively. Dynamic probing detects `node:sqlite` without static imports (which would trigger `ERR_MODULE_NOT_FOUND` on Node 20) and falls back cleanly to the pure JSONL store with zero `--no-warnings` noise.
4. **Platform Neutrality**: Test execution seamlessly bridges Windows Win32 Named Pipes (`\\.\pipe\ctxtop-*`) and POSIX Unix Domain Sockets (`/tmp/ctxtop-*.sock`), normalizing file paths and line endings (CRLF vs. LF).
5. **Absolute Workspace Sandboxing**: Every test execution runs within an isolated ephemeral directory (`createTempWorkspace`), redirecting home directories, runtime state directories, and plugin configurations to eliminate side effects on the developer's workstation.
6. **Strict Invariant Verification**: All six non-negotiable architectural and security invariants (Read-Only SQLite, Plain-Text `/compact`, Active Source Protection, Byte-for-Byte Mirror Parity, Zero Outbound Sockets, Zero-PII/Unicode Tag Airlock) are validated deterministically.

---

## 2. Test File Hierarchy & Architecture

```
test/
├── helpers/
│   ├── e2e_harness.mjs            # 10 core sub-harnesses (builders, mocks, validators)
│   └── e2e_harness.test.mjs       # Verification test suite for the harness itself
├── e2e_tier1_features.test.mjs    # Tier 1: 41 features × 5 isolated tests = 205 tests
├── e2e_tier2_boundaries.test.mjs  # Tier 2: 41 features × 5 boundary tests = 205 tests
├── e2e_tier3_pairwise.test.mjs    # Tier 3: 41 cross-feature pairwise tests = 41 tests
└── e2e_tier4_scenarios.test.mjs   # Tier 4: 20 multi-turn complex workloads = 20 tests
                                   # TOTAL TEST SUITE: 471 tests minimum
```

### Execution Strategy
Tests are invoked via the native Node.js test runner:
```bash
# Execute full E2E test suite
node --test "test/e2e_tier*.test.mjs"

# Execute individual tiers
node --test test/e2e_tier1_features.test.mjs
node --test test/e2e_tier2_boundaries.test.mjs
node --test test/e2e_tier3_pairwise.test.mjs
node --test test/e2e_tier4_scenarios.test.mjs

# Verify harness functionality
node --test test/helpers/e2e_harness.test.mjs
```

---

## 3. Dual Node.js Runtime & Micro-IPC Architecture

### 3.1 Node 20 LTS vs Node 22.5+ Dual Execution Matrix
- **Node >=22.5**: Features native `node:sqlite` via `DatabaseSync`. Provides full read-only SQLite step traversal, metadata extraction, and FTS5 full-text indexing.
- **Node 20 LTS**: Lacks `node:sqlite`. Dynamic probing via `isSqliteAvailable()` cleanly falls back to `JsonlDatabaseFallbackWrapper` with an identical query interface (`get`, `all`, `searchFts`), preventing any unhandled exception or experimental warning output.
- **Testing Both in Single Runtime**: The harness provides a `forceFallback: true` configuration, enabling test suites on Node 22/25 to thoroughly validate the JSONL fallback paths without requiring Node version switching.

### 3.2 Win32 Named Pipes & POSIX Sockets
- **Windows**: Named Pipes format `\\.\pipe\ctxtop-<identifier>-<uuid>`.
- **POSIX**: Unix Domain Sockets format `/tmp/ctxtop-<identifier>-<uuid>.sock`.
- **Wire Protocol**: 1-line JSON-RPC 2.0 delimited by newline `\n`.
- **Latency SLAs**:
  - In-process evaluation: `< 0.10ms` p95.
  - Warm Micro-IPC Hook Bridge: `< 0.80ms` p95 (CI ceiling `< 1.50ms`).
  - IPC Connection Timeout / Fallback threshold: `15ms`.
  - Statusline render: `< 12ms` (CI ceiling `< 15ms`).
  - DET-31 `git merge-tree`: `< 12ms` (CI ceiling `< 15ms`).

---

## 4. Complete 41-Feature Test Matrix (471 Tests)

### Summary Matrix
- **Tier 1 (Feature Coverage)**: 41 features × 5 isolated happy-path tests = **205 tests**
- **Tier 2 (Boundary & Corner Cases)**: 41 features × 5 boundary/edge tests = **205 tests**
- **Tier 3 (Cross-Feature Pairwise Interactions)**: 41 pairwise tests = **41 tests**
- **Tier 4 (Real-World Application Scenarios)**: 20 end-to-end multi-turn scenarios = **20 tests**
- **Grand Total**: **471 tests**

---

### Detailed 41-Feature Mapping Table

| # | Feature | Tier 1 Tests (5 Happy Path) | Tier 2 Tests (5 Boundaries & Corners) | Tier 3 Pairwise Partner | Tier 4 Scenario Integration |
|---|---------|-----------------------------|---------------------------------------|-------------------------|------------------------------|
| **1** | **Single `ctxtop` Package** | 1.1 Manifest name is `ctxtop`<br>1.2 Manifest version is 4.0.0<br>1.3 Type is `module`<br>1.4 Bin declarations exist (`ctxtop`, `ah-statusline`)<br>1.5 Node engine `>=20.0.0` | 1.B1 Missing optional fields parse safely<br>1.B2 Empty scripts map does not break CLI<br>1.B3 Corrupted JSON throws readable syntax error<br>1.B4 Non-standard whitespace preserves fields<br>1.B5 Stripped package.json in sandbox retains CLI execution | Paired with #7 (Zero Runtime Dependencies) | Participates in Scenario 1 (Fresh Install & Onboarding) |
| **2** | **Dual Plugin Manifests** | 2.1 Antigravity `plugin.json` exists & valid<br>2.2 Claude Code `.claude-plugin/plugin.json` exists<br>2.3 Hook declarations valid in both<br>2.4 Manifest schema version matches v4<br>2.5 Platform-specific capabilities declared | 2.B1 Trailing commas in manifest handled<br>2.B2 Missing hook script path flags clear error<br>2.B3 Unicode characters in description preserve encoding<br>2.B4 Minimal manifest with 0 hooks loads cleanly<br>2.B5 Dual manifests with conflicting versions detected | Paired with #3 (Zero-Config Installer) | Participates in Scenario 1 (Dual Host Manifest Verification) |
| **3** | **Zero-Config Installer** | 3.1 `ctxtop init` creates config<br>3.2 Auto-detects Antigravity host<br>3.3 Auto-detects Claude Code host<br>3.4 Creates timestamped backup `.ah-backup.<ts>`<br>3.5 Default config matches Blueprint spec | 3.B1 Re-running `init` on existing config does not clobber<br>3.B2 Read-only destination directory aborts cleanly<br>3.B3 Corrupt existing config backed up with `.corrupt` suffix<br>3.B4 Interrupted init rolls back partial writes<br>3.B5 Windows read-only attribute handled gracefully | Paired with #12 (DET-21 Deprecated Alias) | Participates in Scenario 1 & 14 (Configuration Migration) |
| **4** | **Isomorphic Mod Core** | 4.1 Pure ESM module loading<br>4.2 Zero `node:*` imports in `@ctxtop/core-isomorphic`<br>4.3 Operates inside pure V8 isolate simulator<br>4.4 Pure functions return immutable state<br>4.5 All exports are named and deterministic | 4.B1 Passing undefined inputs returns default state<br>4.B2 Object prototypes not mutated<br>4.B3 Circular object references rejected cleanly<br>4.B4 Heavy payload (>5MB) processed without stack overflow<br>4.B5 Attempted access to `globalThis.process` rejected | Paired with #5 (Claude Mod Law Compliance) | Participates in Scenario 2 (Isomorphic Telemetry Processing) |
| **5** | **Claude Mod Law Compliance** | 5.1 AST scan passes Mod Law 1 (no `node:*`)<br>5.2 Law 1: no assignment to `$`<br>5.3 Law 2: balanced call scanner verified<br>5.4 Law 3: string literal event names in `on()`<br>5.5 Law 5: fail-closed `.catch()` returning `{ decision: 'deny' }` | 5.B1 Object shorthand `{ $ }` detected and rejected<br>5.B2 Destructuring `{ $ } = ctx` detected and rejected<br>5.B3 Dynamic template string event name rejected<br>5.B4 Missing `.catch()` handler on async hook flagged<br>5.B5 Unhandled `throw` inside lifecycle hook caught | Paired with #4 (Isomorphic Mod Core) | Participates in Scenario 3 (Adversarial Mod Code Injection) |
| **6** | **Universal Session Trajectory (USTF v1)** | 6.1 `createMockUSTFTrajectory` generates v1.0.0<br>6.2 Antigravity session transforms to USTF v1<br>6.3 Claude Code DAG transforms to USTF v1<br>6.4 Schema validator accepts compliant trajectory<br>6.5 JSON serializer & deserializer round-trip identical | 6.B1 Negative token counts rejected by validator<br>6.B2 Missing required `traceId` fails schema validation<br>6.B3 Out-of-order turn timestamps normalized or flagged<br>6.B4 Extremely large trajectory (10,000 turns) streams without OOM<br>6.B5 Unknown host string rejected | Paired with #24 (Call-Tree Tracking) | Participates in Scenario 4 & 5 (Cross-Platform Replay) |
| **7** | **Zero Runtime Dependencies** | 7.1 `package.json` has empty `"dependencies": {}`<br>7.2 Production node_modules directory is empty<br>7.3 `npm ls --omit=dev` returns 0 packages<br>7.4 Zero imports of external packages in `src/`<br>7.5 Verification script passes in clean environment | 7.B1 Accidental peerDependency rejected<br>7.B2 Transitive dependency injection via subfolder blocked<br>7.B3 Bundled local dependencies adhere to zero external license<br>7.B4 Symlinked node_modules fails compliance gate<br>7.B5 Inlined minified external code detected by header scanner | Paired with #1 (Single `ctxtop` Package) | Participates in Scenario 1 (Enterprise Air-Gapped Deployment) |
| **8** | **Dynamic SQLite Probing** | 8.1 Detects `node:sqlite` on Node >=22.5<br>8.2 Loads `DatabaseSync` without warning flags<br>8.3 Verifies FTS5 table capability<br>8.4 Gracefully handles probe call in non-sqlite runtimes<br>8.5 Cache probe result for sub-millisecond reuse | 8.B1 Repeated probing in rapid loop does not leak handles<br>8.B2 Mocked failed import returns null without throw<br>8.B3 `node:sqlite` available but `DatabaseSync` null handled<br>8.B4 Corrupt native binding intercepted safely<br>8.B5 Concurrent probing from worker threads thread-safe | Paired with #9 (Node 20 JSONL Fallback) | Participates in Scenario 6 (Dynamic Runtime Adaptation) |
| **9** | **Node 20 LTS JSONL Fallback** | 9.1 Activates when `node:sqlite` unavailable<br>9.2 `JsonlDatabaseFallbackWrapper` loads records<br>9.3 `all(filterFn)` returns matching items<br>9.4 `get(filterFn)` returns single match<br>9.5 `searchFts(query)` performs tokenized search | 9.B1 Truncated line at EOF skipped cleanly<br>9.B2 Empty JSONL file returns empty array<br>9.B3 Completely corrupt non-JSON lines filtered out<br>9.B4 Multi-gigabyte JSONL queried via streaming reader<br>9.B5 Missing JSONL file returns empty results without throw | Paired with #8 (Dynamic SQLite Probing) | Participates in Scenario 6 (Node 20 Clean Fallback) |
| **10** | **Read-Only SQLite Invariant** | 10.1 Opens session DB with `{ readOnly: true }`<br>10.2 SELECT queries succeed normally<br>10.3 Protected host databases detected via `isHostProtectedSqlitePath`<br>10.4 `openHostReadOnlyDb` forces readonly mode<br>10.5 Connection closes cleanly without lock leak | 10.B1 `INSERT` attempt throws `SQLITE_READONLY`<br>10.B2 `UPDATE` attempt throws `SQLITE_READONLY`<br>10.B3 `DELETE` attempt throws `SQLITE_READONLY`<br>10.B4 `DROP TABLE` attempt throws `SQLITE_READONLY`<br>10.B5 Requesting read-write on protected path throws Zero-Trust Guard error | Paired with #39 (Zero Outbound Sockets) | Participates in Scenario 7 (Tamper-Proof Telemetry Logging) |
| **11** | **Unified DET-01..32 Catalog** | 11.1 All 32 detectors defined in catalog<br>11.2 DET-30 designated as scratchpad loop detector<br>11.3 Detector severity levels (INFO/WARN/BLOCK) mapped<br>11.4 Empty step sequence returns 0 triggers<br>11.5 Standard findings schema verified | 11.B1 Unknown detector ID in configuration rejected<br>11.B2 Rapid turn burst evaluated within 5ms<br>11.B3 Malformed event payload does not crash detector loop<br>11.B4 Simultaneous trigger of all 32 detectors ordered by priority<br>11.B5 Threshold boundary: exact trigger value vs value-1 | Paired with #12 (DET-21 Deprecated Alias) | Participates in Scenario 8 (Full Diagnostics Suite Evaluation) |
| **12** | **DET-21 Deprecated Alias** | 12.1 Configuration with `DET-21` maps to `DET-30`<br>12.2 Deprecation notice logged on first resolution<br>12.3 Canonical `DET-30` settings override `DET-21`<br>12.4 Legacy rule threshold copied to DET-30<br>12.5 Exported findings report both canonical and alias if requested | 12.B1 Conflicting actions (`DET-21: off`, `DET-30: block`) resolve to canonical `block`<br>12.B2 Null/empty config for DET-21 defaults cleanly<br>12.B3 Circular alias resolution prevented<br>12.B4 Mixed case `det-21` resolves correctly<br>12.B5 Multiple legacy aliases in single file resolved | Paired with #11 (Unified DET Catalog) | Participates in Scenario 8 & 14 (Legacy Config Migration) |
| **13** | **Local Repo Blindspot Sensors** | 13.1 `DIRTY_SNAP` detects uncommitted file changes<br>13.2 `UNSEEN_CALLERS` identifies orphan functions<br>13.3 `LEGACY_POISON` detects deprecated API usage<br>13.4 `FOREIGN_BLEED` flags cross-workspace knowledge items<br>13.5 Heuristic returns file path and line location | 13.B1 Large repository (>50k files) capped at 1.2s timeout<br>13.B2 Non-git workspace skips git sensors without error<br>13.B3 Symlink cycle handled safely without recursion<br>13.B4 Zero findings in pristine clean repository<br>13.B5 Binary files skipped by text scanner | Paired with #14 (DET-31 Git Merge Conflict) | Participates in Scenario 9 (Repository Health Audit) |
| **14** | **DET-31 Git Merge Conflict Sensor** | 14.1 Runs `git merge-tree --write-tree` probe<br>14.2 Detects conflicting files across worktree branches<br>14.3 Non-destructive: zero disk/index mutation<br>14.4 Latency benchmark verifies probe completes `< 12ms`<br>14.5 Clean fast-forward returns `hasConflict: false` | 14.B1 Missing branch name handled gracefully<br>14.B2 Detached HEAD state handled safely<br>14.B3 Repository with empty commit history handled<br>14.B4 Massive merge conflict (1,000 files) summarized<br>14.B5 Non-git directory returns clean skipped status | Paired with #25 (Swarm & Worktree Observability) | Participates in Scenario 10 (Multi-Worktree Concurrency) |
| **15** | **DET-32 Semantic Drift Guard** | 15.1 Detects agent oscillating between refuted hypotheses<br>15.2 Tracks `task.md` constraint contradiction<br>15.3 Generates `< 300`-token re-anchoring directive<br>15.4 Distinguishes legitimate pivot from repetitive loop<br>15.5 Operates in advisory mode by default | 15.B1 Missing `task.md` skips contradiction check gracefully<br>15.B2 Identical turn repeated 3 times triggers maximum severity<br>15.B3 Single turn with high token count does not false-trigger<br>15.B4 Re-anchoring directive never exceeds 300 tokens<br>15.B5 Markdown parse failure in task.md does not crash sensor | Paired with #17 (TTFT & Drift Detection) | Participates in Scenario 11 (Autonomous Drift Remediation) |
| **16** | **Lossless PostToolUse Offloader** | 16.1 Offloads outputs > 4,000 characters<br>16.2 Writes full content to disk/FTS5 store<br>16.3 Replaces transcript output with summary pointer<br>16.4 Strictly preserves workspace `Read` operations<br>16.5 Retrieval command retrieves exact original content | 16.B1 Exactly 4,000 chars passes through untouched<br>16.B2 Exactly 4,001 chars triggers offloader<br>16.B3 Tool named `Read` with 100k chars is NEVER offloaded<br>16.B4 Tool named `read_file` is NEVER offloaded<br>16.B5 Disk write error preserves original output in-memory | Paired with #18 (Prefix-Cache Retention Radar) | Participates in Scenario 12 (Large Artifact Offloading) |
| **17** | **TTFT & Drift Detection** | 17.1 Calculates Time-To-First-Token (TTFT) ms<br>17.2 Calculates thinking token to output token ratio<br>17.3 Detects thinking drift loop (`thinking > 3x output`)<br>17.4 Records per-turn TTFT history<br>17.5 Flags sudden TTFT latency spikes | 17.B1 Zero output tokens with high thinking tokens caps ratio without NaN<br>17.B2 Missing TTFT timestamp returns null without fabrication<br>17.B3 Turn duration 0ms handled safely<br>17.B4 Negative time delta from clock drift ignored<br>17.B5 Unusually large TTFT (>60,000ms) captured accurately | Paired with #15 (DET-32 Semantic Drift Guard) | Participates in Scenario 13 (Thinking Drift & TTFT Profiling) |
| **18** | **95% Prefix-Cache Retention Radar** | 18.1 Calculates prefix byte-offset mutation diff<br>18.2 Reports retention percentage across turns<br>18.3 Flags cache bust cause and byte position<br>18.4 Grades retention: A (>=95%), B (80-94%), C (<80%)<br>18.5 Tracks FNV-1a block hash match rate | 18.B1 Turn 0 (empty history) returns null / baseline<br>18.B2 Exact 95.0% retention matches grade A threshold<br>18.B3 94.9% retention matches grade B threshold<br>18.B4 Zero prefix match (0%) reports bust at offset 0<br>18.B5 Multi-megabyte system prompt diffed in `< 5ms` | Paired with #19 (Algebraic C* Router) | Participates in Scenario 14 (Cache Retention & Routing) |
| **19** | **Algebraic C* Break-Even Router** | 19.1 Computes $C^* = 6,522$ tokens for Opus 5.5 to Sonnet 5.5<br>19.2 Advises model switch when cache is cold<br>19.3 Blocks model switch when warm cache makes Opus cheaper<br>19.4 Evaluates user-defined price override tables<br>19.5 Returns switch penalty calculation in USD | 19.B1 Warm prefix exactly 6,521 tokens allows switch<br>19.B2 Warm prefix exactly 6,522 tokens hits break-even<br>19.B3 Warm prefix 6,523 tokens warns against switch<br>19.B4 Zero token context permits switch without penalty<br>19.B5 Equal model prices returns zero switch barrier | Paired with #18 (Prefix Retention Radar) | Participates in Scenario 14 (Cache Retention & Routing) |
| **20** | **Haiku 100k Cliff Breaker** | 20.1 DET-12 monitors Haiku prompt token volume<br>20.2 Warns at 90,000 tokens<br>20.3 Fires circuit breaker at $\ge 98,000$ tokens<br>20.4 Prevents crossing 100k 5x cost cliff<br>20.5 Recommends compaction or model switch | 20.B1 Prompt at 97,999 tokens does not trip breaker<br>20.B2 Prompt at exactly 98,000 tokens trips breaker<br>20.B3 Prompt at 105,000 tokens (already over cliff) emits emergency halt<br>20.B4 Non-Haiku models (e.g. Sonnet 200k) do not trigger DET-12 at 98k<br>20.B5 Token count 0 evaluates cleanly | Paired with #21 (1s Dual-TTL Countdown) | Participates in Scenario 15 (Context Cliff Breaker) |
| **21** | **1s Live Dual-TTL Countdown** | 21.1 Tracks 5-minute prompt cache TTL (300s)<br>21.2 Tracks 1-hour billing block TTL (3,600s)<br>21.3 Decrements every second with sub-second accuracy<br>21.4 Resets cache TTL upon cache write event<br>21.5 Formats output string as `MM:SS` | 21.B1 Countdown reaches 00:00 and stops without negative numbers<br>21.B2 System clock shift forward by 10m handles jump cleanly<br>21.B3 System clock shift backward by 10m does not loop<br>21.B4 Zero activity for 2 hours reflects expired TTLs<br>21.B5 High timer resolution ticks do not drift over 100 intervals | Paired with #22 (5-Hour Billing Blocks) | Participates in Scenario 16 (TTL Expiration & Rolling Spend) |
| **22** | **5-Hour Billing Blocks** | 22.1 Partitions usage into rolling 5-hour blocks<br>22.2 Computes spend velocity ($/hr and tokens/min)<br>22.3 Attributes spend per subagent/swarm worker<br>22.4 Calculates cumulative session cost USD<br>22.5 Automatically rolls over at 5h timestamp boundary | 22.B1 Session crossing 5h boundary initiates Block 2 cleanly<br>22.B2 Zero token turns do not corrupt cost calculation<br>22.B3 Extremely high burn rate ($50/hr) flags velocity alert<br>22.B4 Multi-day session (48 hours) partitions into 10 blocks<br>22.B5 Multiple subagents with concurrent turns attributed accurately | Paired with #21 (1s Dual-TTL Countdown) | Participates in Scenario 16 (TTL Expiration & Rolling Spend) |
| **23** | **Retention Step-Chart & Sparklines** | 23.1 Generates script-free SVG retention step-chart<br>23.2 Generates ANSI Braille sparklines (`⡀⠄⠂⠁`)<br>23.3 Adapts sparkline to data point count<br>23.4 SVG includes accessible viewBox and data attributes<br>23.5 Zero script tags in rendered SVG | 23.B1 Empty data array returns baseline placeholder sparkline<br>23.B2 Single data point renders clean indicator<br>23.B3 100 identical data points render flat horizontal line<br>23.B4 Negative or NaN data points filtered out<br>23.B5 Extremely high number of points (1,000) downsampled smoothly | Paired with #32 (ANSI StatusLine) | Participates in Scenario 17 (Telemetry Visualization) |
| **24** | **Real-Time Call-Tree Tracking** | 24.1 Starts and ends hierarchical execution spans<br>24.2 Maintains parent-child span relationships<br>24.3 Measures duration ms per span with high precision<br>24.4 Generates ASCII call tree representation<br>24.5 Computes total execution critical path | 24.B1 Unclosed child span auto-closed on turn termination<br>24.B2 Deeply nested call tree (50 levels) renders without stack overflow<br>24.B3 Span ended out of order handled safely<br>24.B4 Span with zero duration records `<0.01ms`<br>24.B5 Concurrently running parallel spans tracked correctly | Paired with #6 (USTF v1 Trajectory) | Participates in Scenario 4 (Call-Tree Flamegraph Generation) |
| **25** | **Swarm & Worktree Observability** | 25.1 Discovers active `/swarm` subagents from session roster<br>25.2 Monitors Git worktrees via porcelain list<br>25.3 Tracks subagent state: `working`, `parked`, `stalled`, `dead`<br>25.4 Maps subagent branches to worktree directories<br>25.5 Detects orphan worktree directories | 25.B1 Subagent process terminated with SIGKILL marked `dead`<br>25.B2 Non-git workspace handles worktree query gracefully<br>25.B3 Swarm with 32 concurrent subagents tracked without lag<br>25.B4 Worktree path with spaces/unicode handled correctly<br>25.B5 Stalled subagent (>60s inactivity) triggers advisory alert | Paired with #14 (DET-31 Git Merge Conflict) | Participates in Scenario 10 (Swarm & Worktree Orchestration) |
| **26** | **Interactive Control State Machine** | 26.1 Validates transitions: RUNNING $\leftrightarrow$ PAUSED<br>26.2 Validates transition: PAUSED $\to$ STEP $\to$ PAUSED<br>26.3 Validates terminal transition: ANY $\to$ ABORTED<br>26.4 Persists state to `~/.ctxtop/runtime/<session>.ctl`<br>26.5 Emits state change notification event | 26.B1 Duplicate `/pause` while already PAUSED is idempotent<br>26.B2 `/step` while RUNNING is rejected or treated as pause-step<br>26.B3 Transition from ABORTED to RUNNING rejected<br>26.B4 Corrupt `.ctl` file defaults safely to RUNNING<br>26.B5 High-frequency transitions (100 in 100ms) thread-safe | Paired with #27 (Control Latching in COACH Mode) | Participates in Scenario 18 (Interactive Execution Steering) |
| **27** | **Control Latching in COACH Mode** | 27.1 User commands (`/pause`, `/step`) latched immediately<br>27.2 Autonomous detector triggers emit advisory warnings<br>27.3 Autonomous triggers do NOT halt execution by default<br>27.4 Switch from COACH to STRICT mode activates autonomous halts<br>27.5 Latch status reflected in HUD pill `[COACH]` | 27.B1 DET-01 trigger in COACH mode logs warning and continues<br>27.B2 User `/pause` takes precedence over advisory status<br>27.B3 Rapid fire user commands queued and processed in order<br>27.B4 Unknown mode string defaults safely to COACH mode<br>27.B5 Session resume retains active latch mode | Paired with #26 (Interactive Control State Machine) | Participates in Scenario 18 (Interactive Execution Steering) |
| **28** | **Atomic Tool-Boundary Suspension** | 28.1 Intercepts execution at `PreToolUse` / `tool.call`<br>28.2 Suspends tool call when state is PAUSED<br>28.3 Resumes immediately when state transitions to RUNNING<br>28.4 Executes single tool call when state is STEP and re-pauses<br>28.5 Denies tool call when state is ABORTED | 28.B1 Zero CPU spinning (<0.5% CPU) while suspended for 10 minutes<br>28.B2 Tool call timeout safety release after configured duration<br>28.B3 Multiple parallel tool calls suspended at same boundary<br>28.B4 Hook handler failure fails closed (`deny`)<br>28.B5 Abort during mid-suspension cancels tool execution cleanly | Paired with #29 (Micro-IPC Hook Bridge) | Participates in Scenario 18 (Tool Suspension & Step Steer) |
| **29** | **Warm Micro-IPC Hook Bridge** | 29.1 Connects to Win32 Named Pipe / POSIX socket<br>29.2 Sends JSON-RPC 2.0 request and receives response<br>29.3 Achieves `< 0.8ms` roundtrip p95 latency<br>29.4 Reconnects automatically on server restart<br>29.5 Manages socket buffer framing with newline delimiter | 29.B1 Server slow (>15ms) triggers client-side fallback<br>29.B2 Malformed JSON from client returns -32700 Parse error<br>29.B3 Socket disconnection mid-request caught cleanly<br>29.B4 1,000 requests in rapid burst handled without pipe overflow<br>29.B5 Connection to non-existent pipe fails within `< 2ms` | Paired with #30 (Standalone CLI Fallback) | Participates in Scenario 19 (High-Frequency IPC Benchmark) |
| **30** | **Standalone CLI Hook Fallback** | 30.1 Activates when daemon IPC server is offline<br>30.2 Evaluates hook decision via local in-process CLI<br>30.3 Produces identical decision object to daemon<br>30.4 Zero stderr warning or error noise emitted<br>30.5 Completes evaluation in `< 5ms` | 30.B1 Read-only directory prevents daemon spawn; CLI succeeds<br>30.B2 Severely constrained environment with 0 socket permissions runs CLI<br>30.B3 Missing config file uses safe in-memory defaults<br>30.B4 CLI exit code 0 returned on valid hook decision<br>30.B5 Multiple concurrent CLI invocations operate independently | Paired with #29 (Micro-IPC Hook Bridge) | Participates in Scenario 19 (Daemon Absence Fallback) |
| **31** | **Unified `ctxtop` CLI** | 31.1 Supports `init` command<br>31.2 Supports `statusline` command<br>31.3 Supports `inspect <session>` command<br>31.4 Supports `radar` command<br>31.5 Supports `control <cmd>` command (`pause`, `step`, `abort`, `resume`) | 31.B1 Unknown command exits with code 1 and prints usage<br>31.B2 `--help` and `-h` display full command documentation<br>31.B3 `--version` outputs 4.0.0<br>31.B4 `inspect` with non-existent session UUID reports not found<br>31.B5 Invalid arguments to `control` print descriptive error | Paired with #32 (ANSI StatusLine) | Participates in Scenario 1 (CLI Developer Journey) |
| **32** | **Zero-Flicker ANSI StatusLine** | 32.1 Renders 80-col compact layout<br>32.2 Renders 110-col standard layout<br>32.3 Renders 144-col wide layout<br>32.4 Strips ANSI codes in non-TTY environments (`NO_COLOR`)<br>32.5 Renders within `< 12ms` SLA | 32.B1 Ultra-narrow terminal (40 cols) truncates safely without wrapping<br>32.B2 Ultra-wide terminal (300 cols) preserves layout alignment<br>32.B3 High terminal resize frequency produces zero flicker<br>32.B4 Total rendered line length never exceeds specified column width<br>32.B5 Missing telemetry metrics render clean placeholder dashes | Paired with #33 (AbovePrompt HUD) | Participates in Scenario 17 (Responsive Terminal HUD) |
| **33** | **AbovePrompt 40-Cell HUD** | 33.1 Renders 40-cell proportional context bar<br>33.2 Correctly categorizes 10 token buckets<br>33.3 Displays `[COACH]` status pill<br>33.4 Sum of cells always equals exactly 40<br>33.5 ANSI color gradients adhere to Tufte data-ink ratio | 33.B1 Context tokens = 0 renders 40 empty cells<br>33.B2 Context at 100% capacity renders 40 full alert cells<br>33.B3 Fractional rounding remainder allocated to largest bucket<br>33.B4 Bucket with 1 token allocated minimum 1 cell or proportional<br>33.B5 Terminal width 40 cols renders HUD cleanly | Paired with #32 (ANSI StatusLine) | Participates in Scenario 17 (Responsive Terminal HUD) |
| **34** | **Docked Claude `/horizon` Pane** | 34.1 Renders 4-Rank Simple View HUD<br>34.2 Renders 5-Section Workbench layout<br>34.3 Embeds Braille sparklines<br>34.4 Displays active model and cache retention index<br>34.5 Supports keyboard navigation shortcuts | 34.B1 Empty session history displays welcome/empty state<br>34.B2 Terminal lacking UTF-8 support falls back to ASCII borders<br>34.B3 Rapid refresh ticks do not produce cursor jump<br>34.B4 Detached or headless session handles stdout redirect<br>34.B5 Viewport height < 10 rows collapses secondary sections | Paired with #35 (Antigravity Studio Artifacts) | Participates in Scenario 20 (Full Cross-Host Host Simulation) |
| **35** | **Antigravity Studio Artifacts** | 35.1 Generates `<agent-embed>` XML wrapper<br>35.2 Generates `/horizon` interactive artifact<br>35.3 Generates `/radar` retention artifact<br>35.4 Generates `/inspect` call-tree artifact<br>35.5 Includes CSRF token and secure sidecar link | 35.B1 XSS script tags in turn inputs sanitized before embed<br>35.B2 Offline daemon sidecar falls back to static SVG/Markdown<br>35.B3 Nested `<agent-embed>` tags escaped properly<br>35.B4 Extremely large SVG payload (>2MB) formatted without truncation<br>35.B5 Malformed query parameters handled cleanly | Paired with #34 (Docked Claude Horizon Pane) | Participates in Scenario 20 (Full Cross-Host Host Simulation) |
| **36** | **Plain-Text `/compact` Invariant** | 36.1 HTML includes `#compactInstruction` with plain text<br>36.2 Content matches `Type /compact in the chat box and press Enter`<br>36.3 Reclaim summary rendered inside `#compactReclaim`<br>36.4 Unit tests assert absence of `#btnCompactPrimary`<br>36.5 Unit tests assert absence of `copyCompactWithGuidance` | 36.B1 Attempted injection of `<button>` inside `#compactInstruction` fails test<br>36.B2 Attempted injection of `Ctrl+V` text fails test<br>36.B3 Reclaim summary with 0 bytes saved handled cleanly<br>36.B4 Internationalized locale strings preserve invariant semantics<br>36.B5 Dynamic DOM alteration checked and guarded | Paired with #37 (Active Source Protection) | Participates in Scenario 7 (Security & Architectural Invariants) |
| **37** | **Active Source Protection Invariant** | 37.1 `isIgnorablePath('src/core/router.mjs')` returns `false`<br>37.2 `isIgnorablePath('package-lock.json')` returns `true`<br>37.3 `isIgnorablePath('build/output.log')` returns `true`<br>37.4 UI hides `Ignore file` button on active source files<br>37.5 UI displays `Ignore file` button on lockfiles and logs | 37.B1 Null, undefined, or empty path returns `false`<br>37.B2 Path traversal (`../../src/index.js`) resolved before check<br>37.B3 Case insensitivity on Windows paths handled<br>37.B4 Source file inside scratch directory classified safely<br>37.B5 Custom source extensions (`.ts`, `.rs`, `.go`) protected | Paired with #36 (Plain-Text Compact Invariant) | Participates in Scenario 7 (Security & Architectural Invariants) |
| **38** | **Byte-for-Byte SHA-256 Parity** | 38.1 `sync_mirrors.mjs --verify` calculates SHA-256<br>38.2 Verifies 6 HTML targets across plugins<br>38.3 Verifies 283 mirrored core files byte-for-byte<br>38.4 Parity report outputs exact hash matches<br>38.5 Non-zero exit code if discrepancy detected | 38.B1 1-byte discrepancy detected and offending file pinpointed<br>38.B2 Windows CRLF vs POSIX LF normalized during comparison<br>38.B3 Missing file in mirror directory flagged as parity failure<br>38.B4 Extra file in mirror directory flagged as parity failure<br>38.B5 Read permission failure reports error without crash | Paired with #39 (Zero Outbound Sockets) | Participates in Scenario 7 (Security & Architectural Invariants) |
| **39** | **Zero Outbound Sockets Invariant** | 39.1 AST audit verifies zero `fetch()` or `http.request()`<br>39.2 Socket monkey-patch intercepts any non-loopback connect<br>39.3 Local IPC connections (`\\.\pipe` / loopback `127.0.0.1`) allowed<br>39.4 All outbound network attempts throw immediate violation<br>39.5 Telemetry exported strictly via local JSONL audit logs | 39.B1 External HTTPS request attempt caught and blocked<br>39.B2 DNS resolution attempt caught and blocked<br>39.B3 Raw TCP socket to remote IP caught and blocked<br>39.B4 WebSocket connection attempt caught and blocked<br>39.B5 Dynamic `import('node:http')` in core flagged by AST gate | Paired with #10 (Read-Only SQLite Invariant) | Participates in Scenario 7 (Security & Architectural Invariants) |
| **40** | **Zero-PII & Unicode Tag Airlock** | 40.1 Sanitizes API keys and tokens (`[REDACTED_SECRET]`)<br>40.2 Scrubs invisible Unicode Tag characters (`\u{E0001}..\u{E007F}`)<br>40.3 Preserves legitimate code generics (e.g. `<T>`, `<string>`)<br>40.4 Sanitizes subagent message payloads in real time<br>40.5 Audit log records redaction count without secret leakage | 40.B1 Zero false-positive redaction on normal programming language syntax<br>40.B2 Multi-line RSA private key sanitized completely<br>40.B3 Nested Unicode tag injection stripped from prompt string<br>40.B4 Payload >1MB sanitized in `< 5ms`<br>40.B5 Non-string inputs (buffers, numbers) handled safely | Paired with #15 (DET-32 Semantic Drift Guard) | Participates in Scenario 3 & 7 (Airlock & Security) |
| **41** | **E2E Test Suite & Adversarial Hardening** | 41.1 100% pass across Tier 1 (205 tests)<br>41.2 100% pass across Tier 2 (205 tests)<br>41.3 100% pass across Tier 3 (41 pairwise tests)<br>41.4 100% pass across Tier 4 (20 scenario tests)<br>41.5 Composite benchmark score $\ge 96.25/100$ verified | 41.B1 Concurrency: 32 parallel worker runs without temp dir collision<br>41.B2 Injected intentional assertion failure fails runner cleanly<br>41.B3 Unhandled promise rejection in test fails suite<br>41.B4 Memory leak check: test runner RSS remains stable across 471 tests<br>41.B5 Zero flaky tests across 10 consecutive full runs | Paired with all 40 features | Orchestrates all 20 Scenarios in Tier 4 |

---

## 5. Tier 4 Real-World Application Scenarios (20 Workloads)

1. **Scenario 1: Fresh Developer Onboarding & Dual Host Initialization**
   - Installs `ctxtop` via `ctxtop init --all`, backs up legacy configs, configures Antigravity and Claude Code plugins, verifies package manifests and zero runtime dependencies.
2. **Scenario 2: Cross-Host Session Replay (Antigravity to Claude Code)**
   - Replays a SQLite/Protobuf Antigravity session into normalized `USTF v1` format and verifies identical rendering in Claude Code's docked `/horizon` pane.
3. **Scenario 3: Adversarial Mod Injection & Airlock Defense**
   - Injects adversarial code with Unicode Tag IPI, hardcoded API keys, and illegal `$` assignments; validates that Zero-PII airlock scrubs secrets, Unicode tags are stripped, and AST compliance gate blocks Mod loading.
4. **Scenario 4: High-Concurrency Call-Tree & Flamegraph Generation**
   - Simulates 50 nested function and tool execution spans; validates parent-child call hierarchy, auto-closure of interrupted spans, and script-free SVG flamegraph generation.
5. **Scenario 5: Multi-Turn Swarm Trajectory Normalization**
   - Simulates a 6-agent `/swarm` session spanning 20 turns, stitching distributed subagent events into a unified `USTF v1` trajectory.
6. **Scenario 6: Zero-Warning Dynamic SQLite / JSONL Fallback Transition**
   - Simulates runtime downgrade from Node 22+ (`node:sqlite`) to Node 20 LTS; validates seamless activation of `JsonlDatabaseFallbackWrapper` with zero console warnings.
7. **Scenario 7: Security Guardrails & Invariant Lockdown**
   - Asserts Read-Only SQLite on all session DBs, validates Plain-Text `/compact` instruction, verifies Active Source Protection on 50 file paths, and confirms zero outbound socket egress.
8. **Scenario 8: Complete Diagnostic Detector Storm (DET-01 to DET-32)**
   - Feeds a synthetic degraded turn stream triggering all 32 detectors; verifies scratchpad loop fires on `DET-30`, legacy `DET-21` resolves as an alias, and findings schema matches specification.
9. **Scenario 9: Monorepo Blindspot Forensics Audit**
   - Executes blindspot sensors across a 5,000-file simulated repository; detects uncommitted dirty state, orphan functions, and cross-workspace knowledge bleed within 1.2s timeout.
10. **Scenario 10: Multi-Worktree Concurrent Git Merge Conflict Detection**
    - Simulates 3 parallel Git worktree workers; triggers `DET-31` non-destructive `git merge-tree --write-tree` probe in `< 12ms` without altering index or workspace trees.
11. **Scenario 11: Semantic Drift & Refuted Hypothesis Remediation**
    - Simulates an agent repeating a falsified hypothesis for 3 consecutive turns; `DET-32` activates and injects a `< 300`-token re-anchoring directive to restore execution discipline.
12. **Scenario 12: Massive Tool Output PostToolUse Offloading & FTS5 Indexing**
    - Agent generates a 50,000-character tool output; offloader safely offloads content to disk/FTS5 store, injects summary pointer, and verifies that `Read` tool operations are strictly never offloaded.
13. **Scenario 13: Thinking Drift Detection & TTFT Latency Profiling**
    - Injects runaway thinking loop (12,000 thinking tokens vs 150 generation tokens); validates thinking drift flag trigger, TTFT recording, and HUD advisory alert.
14. **Scenario 14: 95% Prefix-Cache Retention Radar & Algebraic C* Routing**
    - Agent mutates prompt prefix at byte offset 1,200; retention radar detects cache bust, drops retention to 72% (Grade C), and algebraic $C^*$ router blocks switch from Opus to Sonnet due to warm prefix threshold ($C^* = 6,522$).
15. **Scenario 15: Haiku 100k Context Cliff Breaker**
    - Monitored Haiku prompt grows to 98,200 tokens; `DET-12` circuit breaker trips prior to reaching 100k 5x cost cliff, preventing unexpected billing surge.
16. **Scenario 16: Rolling 5-Hour Billing Blocks & Dual-TTL Expiration**
    - Simulates a 6-hour continuous session; validates 5-minute cache countdown, 1-hour billing TTL reset, and smooth rollover into Billing Block 2 with accurate subagent cost attribution.
17. **Scenario 17: Zero-Flicker Multi-Tier Responsive HUD & Braille Sparklines**
    - Resizes terminal across 80, 110, and 144 columns; validates zero line wrapping, 40-cell proportional AbovePrompt bar, and ANSI Braille sparkline rendering.
18. **Scenario 18: Interactive COACH Control Plane & Atomic Tool Suspension**
    - User executes `/pause` at tool call boundary; execution suspends atomically with 0% CPU consumption; user executes `/step` allowing single tool execution before re-suspending.
19. **Scenario 19: High-Frequency Micro-IPC Bridge & Daemon Fallback**
    - Executes 1,000 IPC requests over Win32 Named Pipe / POSIX socket at `< 0.80ms` p95; kills daemon and validates instantaneous, zero-error fallback to standalone CLI.
20. **Scenario 20: Full End-to-End Cross-Host Observability Session**
    - Comprehensive 25-turn dual-agent development lifecycle executing all subsystems simultaneously; verifies clean session termination, USTF export, and composite benchmark compliance score $\ge 96.25/100$.

---

## 6. Shared E2E Test Harness (`test/helpers/e2e_harness.mjs`) Specification

The shared test harness exports 10 dedicated sub-harnesses implemented entirely in pure standard library ESM:

1. **Runtime Probing & Dynamic Fallback**:
   - `detectRuntimeEnv()`
   - `isSqliteAvailable()`
   - `getMockDatabaseClient({ dbPath, jsonlPath, forceFallback, readOnly })`
   - `JsonlDatabaseFallbackWrapper`
2. **Ephemeral Workspace Sandbox**:
   - `createTempWorkspace(options)` / `createIsolatedTestSandbox(options)`
   - Robust cleanup with retries for Windows file locks (`EBUSY`/`EPERM`).
3. **USTF v1 Trajectory Builder & Validator**:
   - `createMockToolSpan(options)`
   - `createMockUSTFTurn(options)`
   - `createMockUSTFTrajectory(options)`
   - `validateUSTFv1(trajectory)`
   - `serializeUSTFv1(trajectory)` / `deserializeUSTFv1(json)`
4. **Multi-Host Session Transcript Generators**:
   - `createAntigravityJsonl(targetDir, turns)`
   - `createClaudeCodeJsonl(targetDir, events)`
   - `createMockSessionDatabase(dbDir, options)`
5. **Dynamic Mock Database Fixtures**:
   - `createMockDatabaseFixture(targetBase, { tables, records })`
   - `assertSqliteReadOnlyEnforced(dbOrPath)`
   - `assertHostDbWriteRejected(openFn, hostDbPath)`
6. **Micro-IPC Hook Bridge Harness**:
   - `getPlatformPipePath(name)`
   - `startMockIpcServer(options)`
   - `sendIpcMessage(pipePath, message, options)`
   - `stopIpcServer(server, pipePath)`
   - `simulateCliFallback(pipePath, cliFallbackFn, options)`
7. **Control Plane Latch Simulator**:
   - `writeControlLatch(runtimeDir, sessionId, state, reason)`
   - `readControlLatch(runtimeDir, sessionId)`
8. **Token Economics & Math Verifiers**:
   - `calculateBreakEvenCStar(opusPrice, sonnetPrice, cacheDiscount)`
   - `verifyRetentionRadarDiff(originalText, mutatedText)`
   - `checkHaiku100kCliffBreaker(modelId, promptTokens)`
   - `calculateDualTtlCountdown(lastTurnTime, now, cacheTtl, billingTtl)`
   - `partitionBillingBlocks(usageEvents, blockDurationMs)`
9. **Zero-Dependency AST & Mod Law Compliance Gate**:
   - `checkModLaws(sourceCode)` (11 static compliance checks)
   - `checkZeroRuntimeDeps(packageJsonPath)`
   - `assertNoOutboundEgress(code)`
   - `withNetworkSpy(testFn, options)`
10. **UI & Invariant Assertions**:
    - `assertPlainTextCompact(htmlOrContent)`
    - `assertActiveSourceProtected(isIgnorablePathFn)`
    - `assertMirrorParity(options)`
    - `assertNoNodeBuiltinImports(code)`
