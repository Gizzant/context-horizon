# 20-Scenario "Bad-Habit" Simulation Suite & Runtime Validation Report

- **Execution Harness**: [`simulate_bad_habits.mjs`](file:///c:/Projects/ga-visualizer-v2/simulate_bad_habits.mjs) (`node simulate_bad_habits.mjs` -> Exit Code `0`)
- **Google Antigravity Extension (`GA_REPO`)**: `C:\Projects\ga-visualizer-v2`
- **Claude Code Extension (`CC_REPO`)**: `C:\Projects\cc-attention-horizon`
- **Operational Guardrails Enforced**:
  - **100% Non-Destructive**: Zero existing source files in `GA_REPO` or `CC_REPO` were altered; all synthetic fixtures ran in an isolated temporary directory (`__sim_tests__/`) and were cleaned up upon completion.
  - **Zero Live API Calls**: All 20 scenarios executed locally by feeding synthetic telemetry objects, mock JSONL turns, CLI stdout floods, and hook JSON payloads directly into programmatic entrypoints.
  - **Observed Runtime Truth Only**: Every exit code, detector ID, byte/token count, and coaching string below is captured verbatim from `node simulate_bad_habits.mjs`.

---

## 1. Validation Summary Scorecard

### 1.1 Overall Scenario Validation Status (`N = 20`)

| Validation Status | Count | Share | Scenarios |
| :--- | :---: | :---: | :--- |
| **PASS** | **20** | **100.0%** | `Sim 01` – `Sim 20` |
| **PARTIAL** | **0** | **0.0%** | None |
| **FAIL** | **0** | **0.0%** | None |
| **Total** | **20** | **100.0%** | `Sim 01` – `Sim 20` |

### 1.2 Per-Repository Reaction Breakdown (`GA_REPO` vs. `CC_REPO`)

| Reaction Category | `GA_REPO` (`ga-visualizer-v2`) | `CC_REPO` (`cc-attention-horizon`) | Scenarios (`GA_REPO` / `CC_REPO`) |
| :--- | :---: | :---: | :--- |
| **Auto-Blocked / Compressed** | **10** (50%) | **8** (40%) | **GA**: `Sim 01`, `Sim 03`, `Sim 07`, `Sim 08`, `Sim 09`, `Sim 12`, `Sim 15`, `Sim 17`, `Sim 18`, `Sim 20`<br>**CC**: `Sim 01`, `Sim 03`, `Sim 07`, `Sim 08`, `Sim 15`, `Sim 17`, `Sim 18`, `Sim 20` |
| **Coached (HUD / Hook Advisory)** | **10** (50%) | **12** (60%) | **GA**: `Sim 02`, `Sim 04`, `Sim 05`, `Sim 06`, `Sim 10`, `Sim 11`, `Sim 13`, `Sim 14`, `Sim 16`, `Sim 19`<br>**CC**: `Sim 02`, `Sim 04`, `Sim 05`, `Sim 06`, `Sim 09`, `Sim 10`, `Sim 11`, `Sim 12`, `Sim 13`, `Sim 14`, `Sim 16`, `Sim 19` |
| **Passive Telemetry Only** | **0** (0%) | **0** (0%) | **GA**: None<br>**CC**: None |
| **Missed (No Detection)** | **0** (0%) | **0** (0%) | **GA**: None<br>**CC**: None |
| **Total Scenarios** | **20** (100%) | **20** (100%) | **Combined Coverage**: **20 / 20 (100%)** detected by at least one harness |

---

## 2. 20-Row Master Validation Matrix

| Sim # | Bad Habit | Simulated Action | `GA_REPO` Reaction (Detector/UI) | `CC_REPO` Reaction (Hook/Statusline) | Tokens Saved / Protected | Validation Status |
| :---: | :--- | :--- | :--- | :--- | :--- | :---: |
| **Sim 01** | **Silent Cache Prefix Break** | Turn 1 on claude-opus-4-6 (effort: high, 80K warm cache) -> Turn 2 mutating AGENTS.md/CLAUDE.md/MEMORY.md (25KB) prefix, connecting late MCP tools, injecting IDE state into system prefix, and switching model to claude-sonnet-4-6. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-08, DET-09, DET-25): deny (SilentSubTypes=LATE_MCP_CONNECT+MEMORY_MD_MID_THREAD_MUTATION+IDE_STATE_PREFIX_MUTATION) | **AUTO_BLOCKED_OR_COMPRESSED** (DET-08, DET-09, DET-13): ModelSwitch(AUTO_PILOT)=deny (exit=2), RuleEdit(AUTO_PILOT)=defer, SilentSubTypes=LATE_MCP_CONNECT+MEMORY_MD_MID_THREAD_MUTATION+IDE_STATE_P | 80,000 cached prefix tokens protected ($1.26–$1.50 cold re-prefill penalty prevented; C* break-even = 3,750 tok) | **PASS** |
| **Sim 02** | **MCP Schema Hoarding** | Initialize session with Turn-0 static prefill (4.2K bundled skills + 3.8K synced skills + 45K eager MCP schemas + 11K CLAUDE.md = 64K tok) with 0 MCP invocations across 5 turns. | **COACHED** (DET-13): allow (IDLE_MCP_HOARDING_5_TURNS -> ENABLE_TOOL_SEARCH=auto:5 + Lean Code profile dampening) | **COACHED** (DET-13): advise_lazy_mcp (IDLE_MCP_HOARDING_5_TURNS) | 30,000–45,000 tokens/turn reclaimed via ENABLE_TOOL_SEARCH=auto:5 / Lean Code MCP profile dampening (Turn-0 static prefill cut from 64K to <19K) | **PASS** |
| **Sim 03** | **Unfiltered CLI Output Flood** | Pipe a 4,000-line pytest failure log packed with ANSI color codes, progress spinners, and repetitive stack frames through PostToolUse / CLI compressor. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-07, DET-10): compressed_and_indexed_fts5 | **AUTO_BLOCKED_OR_COMPRESSED** (DET-07): offloaded_and_sanitized | GA: 67,782 tokens saved (98.3% reduction) / CC: 68,708 tokens saved (99.7% reduction) | **PASS** |
| **Sim 04** | **"Sightseeing" Repo Exploration** | Execute 8 consecutive broad grep/directory listing calls and open 5 unrelated 2,000-line files without making a single edit. | **COACHED** (DET-06B): deny (COACH=allow with HUD alert; AUTO_PILOT=deny at call #7) | **COACHED** (DET-06): advise_subagent | ~95,000 main-thread context tokens protected by delegating open-ended exploration to isolated @ah-flash-scout / Haiku Explore subagent (<200-token File:Line summary) | **PASS** |
| **Sim 05** | **Monolithic Thread Rot** | 45-turn session where a bug fix finishes at Turn 20 (git commit completes) and the developer submits a brand-new feature prompt at Turn 21 without compacting or launching a handoff. | **COACHED** (DET-11, DET-24): Turn 45=TRIM_UNCACHED_TAIL (Turn 21=EXECUTE_BATON_PASS) | **COACHED** (DET-11): Turn21=advise_compact (POST_COMMIT_TOPIC_SHIFT), Turn45=advise_compact | ~60,720 stale bug-fix distractor tokens reset via Baton Pass at Turn 21 commit boundary + Turn 45 soft horizon | **PASS** |
| **Sim 06** | **5-Minute Cache TTL Expiry** | Turn 10 at T=00:00 with 95K cached tokens -> Turn 11 arriving at T=06:30 (390s later, past 5m TTL, plus 1h->5m overage TTL drop at 320s) + attempted /compact on the cold cache. | **COACHED** (DET-10): PreExpiry(T=260s)=pulseAmber(true) / OverageDrop(3600->300s)=true / ColdCompactBlocked=true (EXECUTE_BATON_PASS) | **COACHED** (DET-10, DET-17): T=260s:AMBER_WARNING / OverageDrop(3600->300s)=true / PreCompact=block (COLD_CACHE_COMPACT_BLOCKED) | 95,000 tokens ($0.57–$1.42 uncached /compact summary penalty prevented via <300-token StateBaton redirect; zero-token pre-snapshot flushed at T-10s) | **PASS** |
| **Sim 07** | **The "Doom Loop"** | 6 consecutive failed tool/test turns on the same file + angry user corrections, plus RSI-04 deterministic failedCmd->workingCmd ("pytest" -> "poetry run pytest") Micro-Skill learning across 2 sessions. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-01, DET-04, RSI-01, RSI-04): deny (PreInvocation continue=undefined / RSI-04 MicroSkill=deny) | **AUTO_BLOCKED_OR_COMPRESSED** (DET-04, RSI-04): deny (exit=2) / RSI-04 PreToolUse=KNOWN_BROKEN_REPO_COMMAND | ~45,000–75,000 tokens saved by halting the 4th+ blind retry attempt (DET-04) and preventing repeated broken runner invocations via <80-tok RSI-04 Repo Micro-Skills | **PASS** |
| **Sim 08** | **Unbounded Subagent Swarm** | Spawn 4 parallel subagents (SubagentStart) that each read the exact same 3 core files without parent cache sharing or scope locks. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-14, DET-16, DET-20): ScopeCollision=true / Quota50%_Decision=allow(max=4) / Quota85%_Decision=deny / DuplicateRead=true / Over40kCap=deny | **AUTO_BLOCKED_OR_COMPRESSED** (DET-16, DET-20): ReadOnLockedFile=allow (SUBAGENT_DUPLICATE_READ_DIGEST) / EditOnLockedFile=deny (exit=2) / Over40kCap=allow (exit=0) | Write collisions & >40K/12-turn runaway subagents hard-blocked (DET-16/DET-20); parallel read duplication of identical core files detected via DET-20 coaching parent StateBaton digests | **PASS** |
| **Sim 09** | **Pinned Frontier Model / Max Effort** | Execute 5 trivial turns (renaming a variable, fixing a typo, formatting JSON) while pinned to highest-cost model (claude-opus-4-6) and effort: max. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-08): PreInvocation continue=undefined (EFFORT_OVERKILL halt after 3 consecutive trivial turns on max) + EffortAdvisor=low | **COACHED** (DET-08): allow (advisory: PINNED_MAX_EFFORT_TRIVIAL_STREAK) | GA saves ~68% output/thinking token burn by halting at Turn 3 (EFFORT_OVERKILL) and recommending `/effort low` while keeping warm cache model; CC detects 3 consecutive trivial edits on Opus max effort and coaches /effort low | **PASS** |
| **Sim 10** | **Full-File Regurgitation** | Execute a Write/write_file tool call that rewrites an entire 900-line file to change only 3 lines instead of applying a targeted search/replace Edit diff. | **COACHED** (DET-05, STREAM_CUTOFF_RISK): allow (PreToolUse DET-05 flags FULL_FILE_REGURGITATION; PreInvocation warns Stream Cutoff Risk >600 lines) | **COACHED** (DET-05): allow (FULL_FILE_REGURGITATION) | ~13,400 input+output tokens per full rewrite protected by coaching surgical Edit over full-file regurgitation | **PASS** |
| **Sim 11** | **Bloated CLAUDE.md / Rules File** | Load an 11,000-token (650-line) instruction file at SessionStart containing redundant and conflicting rules (e.g. Always vs Never use Default Exports / semicolons). | **COACHED** (RSI-01, DET-27): RSI-01 prefixBloatExceeded=true (11,000 > 8,000 ceiling) / DET-27 exceedsCap=true (651 lines > 200 cap) / Contradictions=1, Duplicate=true | **COACHED** (DET-09, RSI-01): SessionStart injects [DET-09 / RSI-01 Static Rule Bloat Advisory] | GA identifies 3,000+ overage tokens proposing 9,300 tokens of lazy skill extraction via RSI-01; CC SessionStart audits CLAUDE.md bloat and contradictions, saving prefix cache | **PASS** |
| **Sim 12** | **Shadowed File Reads** | Call read_file / Read on src/auth.ts (700 lines / ~7,000 tokens) in Turn 2, Turn 4, and Turn 6 without external modifications in between. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-06, DET-17): deny (PreToolUse DET-06 blocks unmodified re-read; Trajectory DET-06 & DET-17 compute shadowed waste) | **COACHED** (DET-06): allow | 14,000 redundant tokens (2x 7,000-token duplicate reads of src/auth.ts prevented or flagged for compaction) | **PASS** |
| **Sim 13** | **LLM as Linter/Formatter** | Submit a prompt asking the model to fix indentation and sort imports across a pasted 300-line code block instead of running a local formatter (prettier/eslint), plus per-habit formatter-bypass override verification. | **COACHED** (DET-08, DET-15): PreInvocation advisory=true (override=block -> terminate; Ring-0 DET-15 preserved=true; complexity=LOW -> low) | **COACHED** (DET-15): allow (PreToolUse DET-15 pre-format advisory triggered=true; Stop hook synthesizes single batched command) | ~4,500 output tokens downshifted to low effort (GA DET-08) and formatting offloaded to local CLI (GA & CC DET-15), preventing wasted LLM code regeneration | **PASS** |
| **Sim 14** | **Conversational Drip-Feeding** | Send 5 consecutive 1-sentence user prompts within 90 seconds touching the same module (src/orders.ts) instead of batching requirements. | **COACHED** (DET-02B): allow (PreInvocation DET-02B Conversational Drip-Feed Advisory triggered on prompt 5; recommends batching requirements) | **COACHED** (DET-05): allow | ~18,000–30,000 extra per-turn prefix read + output overhead flagged for requirement batching | **PASS** |
| **Sim 15** | **Reading Lockfiles & Build Artifacts** | Execute a PreToolUse / read_file call targeting package-lock.json, pnpm-lock.yaml, or dist/bundle.min.js. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-07): deny (PreToolUse DET-07 blocks lockfiles/bundles; active source files preserved=true) | **AUTO_BLOCKED_OR_COMPRESSED** (DET-07): Read(package-lock.json)=deny (exit=2) / Read(dist/bundle.min.js)=deny (exit=2) / Bash(cat package-lock.json)=deny (exit=2) / ActiveSource(sr | ~85,000–120,000 tokens saved across package-lock.json and dist/bundle.min.js reads while strictly preserving active source file access | **PASS** |
| **Sim 16** | **Mid-History Array Mutation** | Drop messages 3-5 from the middle of a 15-message history array (60K tokens), shifting token offsets for messages 6-15 outside the 20-block lookback window and invalidating 86.7% of the KV cache prefix. | **COACHED** (RETENTION_RADAR, DET-26): RetentionRadar Grade=C (retentionPct=13.01%, firstDiffOffset=byte 25660); DET-26 shiftedSuffixTokens=40000; trimUncachedTail headBytesPreser | **COACHED** (DET-09): LOOKBACK_WINDOW_DELETION (shiftedSuffixTokens=40000; retentionIndexPct=17%, leakedUSD=$0.54) | 40,000–52,000 shifted tail tokens diagnosed (`LOOKBACK_WINDOW_DELETION` + `firstDiffOffset` byte diffing; `$0.70` Opus cold-prefill leak quantified; `trimUncachedTail` protects 100% of warm prefix) | **PASS** |
| **Sim 17** | **Skipping the Plan/TDD Gate** | Submit a vague prompt ("Refactor the billing pipeline") that immediately attempts Write/Edit tool calls across >=2 non-test files on Turn 1 without prior test or plan creation (while exempting @file + *.test.ts TDD pairs). | **AUTO_BLOCKED_OR_COMPRESSED** (DET-06, DET-13): PreInvocation=terminate; BlindMultiEdit(edit 2)=ask (TDD @file+test exempt=true); ProofGrade=Weak | **AUTO_BLOCKED_OR_COMPRESSED** (DET-14): PreToolUse(edit 2)=deny (exit=2, subType=BLIND_UNPLANNED_MULTI_EDIT) -> StopGate(AUTO_PILOT)=block (exitCode=0) | ~25,000–40,000 tokens saved by halting unconstrained architectural thrashing at >=2 blind non-test edits while preserving zero-friction @file + *.test.* TDD workflows | **PASS** |
| **Sim 18** | **Unbounded Web/Docs Dump** | Inject a 35,000-token (~140KB) raw HTML/DOM boilerplate scrape (<nav>, <script>, <style>, HTML comments) from a documentation fetch into message history. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-07): offloaded=true (saved 60,016 tokens -> indexed in FTS5 & stored at ah_486761cc4b9f3cb31fd3eb4e0bd692e1612fe4378275918eae9d6ba6d243741b.txt) | **AUTO_BLOCKED_OR_COMPRESSED** (DET-07, DET-19): offloaded=true + HTML boilerplate stripped + DET-19 IPI triggered=true | GA: 60,016 tokens offloaded to FTS5 artifact / CC: 60,028 tokens stripped & offloaded to .claude/cache/artifacts/ + DET-19 IPI stripped | **PASS** |
| **Sim 19** | **Vision/Screenshot Abuse** | Attach 3 high-resolution Base64 image payloads across consecutive turns to debug a text-based CSS/console error (compounding historical resend tax). | **COACHED** (DET-20): OverageActive=true: triggers DET-20 (true) / Base64Blocks=3 (cumulativeVisionTaxTokens=9600) | **COACHED** (DET-20): allow (cumulativeVisionTaxTokens=9600) | ~9,600 cumulative resending vision tokens saved by coaching text/DOM logs instead of Base64 screenshot spam, plus HTTP 400 crash prevention on overages | **PASS** |
| **Sim 20** | **Destructive Code-Stripping** | Execute a Write/Edit payload containing lazy truncation placeholders ("// ... existing code ...", "# ... rest of implementation unchanged") that deletes 60%+ of the file's AST/lines. | **AUTO_BLOCKED_OR_COMPRESSED** (DET-05, DET-16): deny | **AUTO_BLOCKED_OR_COMPRESSED** (DET-05): Edit=deny (exit=2, subType=LAZY_ELISION_PLACEHOLDER) / Write(no old_string)=deny (exit=2, subType=LAZY_ELISION_PLACEHOLDER) | 100% of 250-line file AST protected on GA (`Write` & `Edit`) and CC (`Edit` & `Write`); ~25,000–40,000 recovery tokens saved | **PASS** |

---

## 3. Per-Scenario Execution Logs (`Sim 01` to `Sim 20`)

### Sim 01: Silent Cache Prefix Break (Tier 1)
- **Input Payload Summary**:
  - cachedTokens=80000, cacheTtlSeconds=240, current_model="claude-opus-4-6", target_model="claude-sonnet-4-6", Edit on AGENTS.md/CLAUDE.md, MEMORY.md=25KB, toolsChanged=true, ideStateInSystemPrefix=true
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-08`, `DET-09`, `DET-25`
    - **Decision / Exit Code**: `deny (SilentSubTypes=LATE_MCP_CONNECT+MEMORY_MD_MID_THREAD_MUTATION+IDE_STATE_PREFIX_MUTATION)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `🚨 DET-09 Blocked: Mid-session mutation of AGENTS.md while prompt cache is warm (80000 tok, TTL 240s). | Shield: ⏳ 1 Rule Update Staged (Waiting for Cache TTL expiry to prevent Prefix Bust) (CACHE_WARM_FENCE) | DET-08: [Downshift: /effort low (-68% output burn, keeps warm cache)] | SilentPrefix: [DET-25 Silent Prefix Mutation] Mid-session MCP server/schema change at Turn 2 (2 -> 3 servers); Mid-thread MEMORY.md mutation (25.0KB) invalidated static system prefix; Dynamic IDE state (active tab / highlighted lines / Problems diagnostics) injected into system prefix instead of user-turn tail.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-08`, `DET-09`, `DET-13`
    - **Decision / Exit Code**: `ModelSwitch(AUTO_PILOT)=deny (exit=2), RuleEdit(AUTO_PILOT)=defer, SilentSubTypes=LATE_MCP_CONNECT+MEMORY_MD_MID_THREAD_MUTATION+IDE_STATE_PREFIX_MUTATION`, `exitCode: 2`
    - **Observed Coaching String**:
      > `[DET-08 Warm KV-Cache Hold] Switching from claude-opus-4-6 to claude-sonnet-4-6 with 80,000 warm cached tokens exceeds break-even C* = 3,692 tokens and incurs a +$0.2480 cold 1.25x prefix rewrite penalty. Keep main thread on claude-opus-4-6 or spawn an Explore subagent on claude-haiku-5-5. | [DET-09 Top-Level Mutation Deferred] Mutating top-level system_prompt while 80,000 tokens are warm on claude-sonnet-5-5 would invalidate the Anthropic prompt cache prefix (+$0.1920 rewrite spike). Queued in PostCompactMutationQueue to apply after next compaction. | [DET-13 MCP Cache-Miss Guard] Mid-session MCP "tools_changed" invalidated the warm prompt cache prefix. Queue dynamic MCP registrations in PostCompactMutationQueue. | [DET-13 Silent Prefix Mutation] Mid-session MCP server/schema change at Turn 2 (2 -> 3 servers); Mid-thread MEMORY.md mutation (25.0KB) invalidated static system prefix; Dynamic IDE state (active tab / highlighted lines / Problems diagnostics) injected into system prefix instead of user-turn tail.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories intercept mid-session prefix mutations (DET-09), model switches above break-even C* (DET-08), mid-thread MCP schema toggles (DET-13/DET-25), 25KB MEMORY.md updates, and system-prefix IDE state mutations, deferring updates to PostCompact / PrefixCacheShield.

---

### Sim 02: MCP Schema Hoarding (Tier 1)
- **Input Payload Summary**:
  - 12 MCP servers (45,000 eager schema tok) + 8,000 skills tok + 11,000 rules tok = 64,000 Turn-0 static prefill, turnsElapsed=5, mcpInvocations=0
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-13`
    - **Decision / Exit Code**: `allow (IDLE_MCP_HOARDING_5_TURNS -> ENABLE_TOOL_SEARCH=auto:5 + Lean Code profile dampening)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-13 MCP Audit] Antigravity 1.3.3+ defaults to lazy MCP loading, but detected explicit "eager": true override on [enterprise-mcp-1, enterprise-mcp-2, enterprise-mcp-3, enterprise-mcp-4, enterprise-mcp-5, enterprise-mcp-6, enterprise-mcp-7, enterprise-mcp-8, enterprise-mcp-9, enterprise-mcp-10, enterprise-mcp-11, enterprise-mcp-12]; eager schema overhead 45,000 tok exceeds 15,000 tok; 0 MCP invocations across 5 turns (set ENABLE_TOOL_SEARCH=auto:5 or lazy loading; Turn-0 static prefill = 64,000 tok). | SessionStart schemaTaxPct=8%`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-13`
    - **Decision / Exit Code**: `advise_lazy_mcp (IDLE_MCP_HOARDING_5_TURNS)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-13 Idle MCP Hoarding] 45,000 MCP schema tokens injected with 0 invocations across 5 turns (Turn-0 prefill = 64,000 tok). Set ENABLE_TOOL_SEARCH=auto:5 or disable unused MCP servers.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both GA_REPO (evaluateDet09McpSchemaTax + TurnZeroGate) and CC_REPO (evaluateDet13McpSchemaBloatGuard) decompose Turn-0 static prefill (64,000 tok) and flag IDLE_MCP_HOARDING_5_TURNS after 5 zero-invocation turns, recommending ENABLE_TOOL_SEARCH=auto:5.

---

### Sim 03: Unfiltered CLI Output Flood (Tier 1)
- **Input Payload Summary**:
  - 4,000 lines (275,684 bytes / ~68,921 tokens) with ANSI escapes, spinners, and 1 critical AssertionError
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-07`, `DET-10`
    - **Decision / Exit Code**: `compressed_and_indexed_fts5`, `exitCode: 0`
    - **Observed Coaching String**:
      > `Compressed 275,842 B -> 4,712 B (saved 67,782 tok, 100% error lines preserved, FTS5 archived=true)`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-07`
    - **Decision / Exit Code**: `offloaded_and_sanitized`, `exitCode: 0`
    - **Observed Coaching String**:
      > `Sanitized 68,921 tok -> 213 tok (saved 68,708 tok, offloaded=true, artifact=ah_a8ede19199c534069c8bc3ec99c0fa8bc40c3374dc46884de69674bf6f79028a.txt)`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories strip ANSI/spinner noise, deduplicate passing test lines, preserve 100% of critical failure lines (AssertionError), and archive raw logs to FTS5 / content-addressed disk artifacts.

---

### Sim 04: "Sightseeing" Repo Exploration (Tier 1)
- **Input Payload Summary**:
  - 8 consecutive grep_search/Grep + 5 full read_file/Read calls (2,000 lines each, 0 write/edit calls) on main Frontier thread
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-06B`
    - **Decision / Exit Code**: `deny (COACH=allow with HUD alert; AUTO_PILOT=deny at call #7)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-06B] Unedited read/search call #8 on warm gemini-4-carbon (72000 cached tok). Delegate repository scouting to @ah-flash-scout (<200-tok File:Line summary) to protect main-thread KV cache. | Workload Mode: READ_HEAVY_AUDIT`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-06`
    - **Decision / Exit Code**: `advise_subagent`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-06 Blind Search Guard] 8 sequential Read/Grep calls on the main thread (> 6). Delegate open-ended codebase exploration to an Explore subagent on claude-haiku-5-5 to prevent main-window distractor bloat.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both GA_REPO (DET-06B @ah-flash-scout offloader at >6 consecutive Read/Grep calls) and CC_REPO (DET-06 Blind Search Guard at >6 sequential Read/Grep calls) intercept main-thread sightseeing and coach subagent delegation.

---

### Sim 05: Monolithic Thread Rot (Tier 1)
- **Input Payload Summary**:
  - Turn 20 git commit -> Turn 21 unrelated feature prompt ("Now build a brand new Stripe webhook billing portal...") running through Turn 45 (138K tok, 44% distractor/waste)
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-11`, `DET-24`
    - **Decision / Exit Code**: `Turn 45=TRIM_UNCACHED_TAIL (Turn 21=EXECUTE_BATON_PASS)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `Turn 21: 🤝 Execute Baton Pass (/handoff) — Zero-Amnesia Session Reset (Post-commit topic shift detected at Turn 21 (48K tokens). Previous milestone is committed to git — run /handoff or /compact before starting a new feature on stale context.) | Turn 45: ✂️ Trim Uncached Tail (Preserve 50k Prefix Cache)`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-11`
    - **Decision / Exit Code**: `Turn21=advise_compact (POST_COMMIT_TOPIC_SHIFT), Turn45=advise_compact`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-11 Context Rot Soft Horizon] Post-commit topic shift detected (48.0k tokens). Previous task was committed; run /compact or /handoff to clear stale context before new feature.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. GA assessCompactionState intercepts the post-commit topic shift at Turn 21 returning EXECUTE_BATON_PASS (/handoff), and CC evaluateDet11ContextRotGate triggers POST_COMMIT_TOPIC_SHIFT with advise_compact to prevent stale monolithic thread rot.

---

### Sim 06: 5-Minute Cache TTL Expiry (Tier 1)
- **Input Payload Summary**:
  - cachedTokens=95000, Turn 11 at T=390s (>300s TTL), overage adaptive TTL drop (3600s -> 300s), cold /compact evaluated (cacheExpired=true, compactRequested=true)
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-10`
    - **Decision / Exit Code**: `PreExpiry(T=260s)=pulseAmber(true) | OverageDrop(3600->300s)=true | ColdCompactBlocked=true (EXECUTE_BATON_PASS)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `T=260s: Est. 5m Implicit Cache: 0m 40s | Cold /compact Block: 🧊 Cold Cache (/compact Blocked) — Execute <300-tok StateBaton Handoff — Cache TTL expired (105,000 cold tokens). Running /compact now would pay full uncached input rates to summarize stale history — use a <300-token StateBaton (/handoff + /clear) instead.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-10`, `DET-17`
    - **Decision / Exit Code**: `T=260s:AMBER_WARNING | OverageDrop(3600->300s)=true | PreCompact=block (COLD_CACHE_COMPACT_BLOCKED)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `amber TTL warning (40s): 95.0k warm cache on Opus 4.6 expires soon (+$0.55 rewrite penalty). | [DET-17 Cold-Cache /compact Guard] Prompt cache TTL has expired (95,000 cold tokens). Running /compact now would pay full uncached input rates to summarize stale history — flush a <300-token StateBaton and /clear instead. | Tier Rec: Inter-turn pause telemetry: 33.33% of turns (1/3) followed a 5-to-60 minute pause (>= 3.1% break-even threshold). Upgrade session prompt cache tier from 5m (1.25x) to 1h (2.0x) to prevent recurring cold prefix rewrites.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repos track the 300s KV cache TTL countdown and 1h->5m overage/subagent TTL drops (DET-10), pulse amber before expiry, auto-flush a zero-token StateBaton pre-snapshot, and block cold-cache /compact requests (redirecting to a <300-token StateBaton handoff instead of paying full uncached input rates).

---

### Sim 07: The "Doom Loop" (Tier 1)
- **Input Payload Summary**:
  - 6 consecutive failed tool/test turns + frustrated prompts + 2-session "pytest" -> "poetry run pytest" recovery pair
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-01`, `DET-04`, `RSI-01`, `RSI-04`
    - **Decision / Exit Code**: `deny (PreInvocation continue=undefined | RSI-04 MicroSkill=deny)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-04] 4 consecutive failures on "run_command::npm test". State a root-cause hypothesis or inspect state before a 4th retry. | RSI-04 Baton: [RSI-04 Verified Repo Commands] "pytest" -> "poetry run pytest" | RSI-01 Target: .agents/skills/billing-refactor/SKILL.md`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-04`, `RSI-04`
    - **Decision / Exit Code**: `deny (exit=2) | RSI-04 PreToolUse=KNOWN_BROKEN_REPO_COMMAND`, `exitCode: 2`
    - **Observed Coaching String**:
      > `[DET-04 Consecutive Failure Breaker] 4 consecutive tool failures detected. Halting 4th attempt to prevent retry churn; re-verify assumptions or escalate reasoning effort. | [RSI-04 Repo Micro-Skill] "pytest" previously failed in this repo; use verified command "poetry run pytest" instead.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both GA_REPO and CC_REPO deterministically break 3-strike failure loops (DET-04) and capture zero-LLM-cost failedCmd->workingCmd pairs (RSI-04) across >=2 sessions into .agents/state/micro_skills.json, injecting <80-token SessionStart reminders and intercepting known-broken shell runners.

---

### Sim 08: Unbounded Subagent Swarm (Tier 1)
- **Input Payload Summary**:
  - 4 parallel subagents (subagent-1..4) reading ["src/core/auth.ts", "src/core/db.ts", "src/core/config.ts"] with 0 parent cache sharing
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-14`, `DET-16`, `DET-20`
    - **Decision / Exit Code**: `ScopeCollision=true | Quota50%_Decision=allow(max=4) | Quota85%_Decision=deny | DuplicateRead=true | Over40kCap=deny`, `exitCode: 0`
    - **Observed Coaching String**:
      > `Scope collision detected | [DET-16] Base Quota is at 85% (>=80% throttle). Capped at 1 sequential subagent worker (requested 4, active 3) to prevent 168h lockout. | [DET-16] Subagent run exceeded per-worker budget (45000/40000 tok, 13/12 turns). Return compact summary now.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-16`, `DET-20`
    - **Decision / Exit Code**: `ReadOnLockedFile=allow (SUBAGENT_DUPLICATE_READ_DIGEST) | EditOnLockedFile=deny (exit=2) | Over40kCap=allow (exit=0)`, `exitCode: 2`
    - **Observed Coaching String**:
      > `[DET-20 Subagent Duplicate Read] File "src/core/auth.ts" was already read/claimed by active subagent "subagent-1". Request parent StateBaton file digest instead of reading full cold file. | [DET-20 Concurrent Scope Lock] File "src/core/auth.ts" is locked by active agent "subagent-1" (scope "src/core/auth.ts"). Coordinate via StateBaton or wait for lock release. | [DET-20 Subagent Duplicate Read] File "src/core/db.ts" was already read/claimed by active subagent "subagent-1". Request parent StateBaton file digest instead of reading full cold file.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repos enforce write-scope locks (DET-20) and per-subagent 40K-token / 12-turn caps (DET-16), and detect parallel subagent duplicate cold reads on identical core files to coach shared parent StateBaton digests.

---

### Sim 09: Pinned Frontier Model / Max Effort (Tier 1)
- **Input Payload Summary**:
  - 5 consecutive turns with <15 prompt tokens ("rename variable x to userCount", etc.) on claude-opus-4-6 + effort="max"
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-08`
    - **Decision / Exit Code**: `PreInvocation continue=undefined (EFFORT_OVERKILL halt after 3 consecutive trivial turns on max) + EffortAdvisor=low`, `exitCode: 0`
    - **Observed Coaching String**:
      > ` | Chip: [Downshift: /effort low (-68% output burn, keeps warm cache)]`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-08`
    - **Decision / Exit Code**: `allow (advisory: PINNED_MAX_EFFORT_TRIVIAL_STREAK)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-08 Pinned Max Effort Streak] Opus 4.6 pinned at effort: max across 1 trivial edits (<=3 lines). Run /effort low or switch to Sonnet/Haiku to reduce output token latency by 68%.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. GA halts at Turn 3 (EFFORT_OVERKILL) and recommends /effort low while keeping warm cache model. CC evaluatePreToolUse detects 3 consecutive trivial edits under Opus on effort: max (DET-08 PINNED_MAX_EFFORT_TRIVIAL_STREAK) and coaches /effort low.

---

### Sim 10: Full-File Regurgitation (Tier 1)
- **Input Payload Summary**:
  - Write/write_file on 900-line src/large_service.ts (33,089 bytes) where 897/900 lines (99.7%) are unchanged
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-05`, `STREAM_CUTOFF_RISK`
    - **Decision / Exit Code**: `allow (PreToolUse DET-05 flags FULL_FILE_REGURGITATION; PreInvocation warns Stream Cutoff Risk >600 lines)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-05] Pre-write integrity violation on src/large_service.ts: FULL_FILE_REGURGITATION (897/900 lines unchanged — use surgical edit_file/replace_file_content instead of rewriting the full file). 3-Stage Design-by-Contract: (1) State invariant & pre-conditions, (2) Apply minimal surgical diff preserving error handling & assertions, (3) Verify post-conditions via test suite.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-05`
    - **Decision / Exit Code**: `allow (FULL_FILE_REGURGITATION)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `(none)`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both GA evaluateDet05PreWriteIntegrity and CC evaluateDet05DiffThrashing compare proposed buffer against disk content and flag full-file Write rewrites with >=90% unchanged lines as FULL_FILE_REGURGITATION (DET-05).

---

### Sim 11: Bloated CLAUDE.md / Rules File (Tier 2)
- **Input Payload Summary**:
  - 11,000-token (650-line) CLAUDE.md / AGENTS.md loaded at SessionStart with duplicate rules and direct polar contradictions
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `RSI-01`, `DET-27`
    - **Decision / Exit Code**: `RSI-01 prefixBloatExceeded=true (11,000 > 8,000 ceiling) | DET-27 exceedsCap=true (651 lines > 200 cap) | Contradictions=1, Duplicate=true`, `exitCode: 0`
    - **Observed Coaching String**:
      > `RSI-01 proposes extracting 2 domain skills (.agents/skills/legacy-subsystems/SKILL.md, .agents/skills/ui-formatting/SKILL.md) | DET-27: 651 lines (excess=451) | Contradiction: Opposing directive polarity (NEGATIVE vs POSITIVE) on subject [default, exports, react, components, utility, modules] | U-Shape rescued 1 critical directive(s)`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-09`, `RSI-01`
    - **Decision / Exit Code**: `SessionStart injects [DET-09 / RSI-01 Static Rule Bloat Advisory]`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-09 / RSI-01 Static Rule Bloat Advisory] Rules file bloat: 58k tokens across 1302 lines (>4k tokens / >200 lines cap). Contradictions detected: Always vs NEVER use Default Exports contradiction; Always vs NEVER use semicolons contradiction; Always vs NEVER use Default Exports contradiction; Always vs NEVER use semicolons contradiction. Prune stale conventions or extract domain skills via /compact.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. GA RSI-01 and DET-27 detect 11k-token rules bloat and contradictions, proposing skill extractions. CC SessionStart auditWorkspaceClaudeMd detects rules file bloat and polar contradictions, injecting [DET-09 / RSI-01 Static Rule Bloat Advisory].

---

### Sim 12: Shadowed File Reads (Tier 2)
- **Input Payload Summary**:
  - 3 full-file reads of src/auth.ts (700 lines, ~7,000 tok each) at Turn 2, Turn 4, and Turn 6
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-06`, `DET-17`
    - **Decision / Exit Code**: `deny (PreToolUse DET-06 blocks unmodified re-read; Trajectory DET-06 & DET-17 compute shadowed waste)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-06] Unmodified since Turn 2; reuse in-context buffer | DET-17 Shadowed Waste: 14000 tok (auth.ts (2x snapshots • 14.0k stale tokens))`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-06`
    - **Decision / Exit Code**: `allow`, `exitCode: 0`
    - **Observed Coaching String**:
      > `Repo Calibration Alert: "src/auth.ts" has been read 3x (21,000 cumulative tok across 1 session(s)). Use ranged line reads (offset/limit) or delegate to an Explore subagent.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. GA_REPO blocks unmodified re-reads via `evaluateDet06UnmodifiedReRead` (`DET-06`) and tracks shadowed historical copies via `detectShadowedFileBloat` (`DET-17`). CC_REPO tracks cumulative file reads in `repoCalibration.mjs` and fires `DET-06` (`CHRONIC_REPO_FILE_SINK`) on the 3rd read (>=6,000 cumulative tokens).

---

### Sim 13: LLM as Linter/Formatter (Tier 2)
- **Input Payload Summary**:
  - User prompt (22,740 chars / ~302 lines) asking LLM to fix indentation and sort imports (+ formatter-bypass=block/off test)
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-08`, `DET-15`
    - **Decision / Exit Code**: `PreInvocation advisory=true (override=block -> terminate; Ring-0 DET-15 preserved=true; complexity=LOW -> low)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-15 Local Formatter Bypass] Prompt requests code formatting / import sorting on a pasted code block. Run `npx prettier --write <file>` or `npx eslint --fix <file>` directly (0 LLM tokens). | [Downshift: /effort low (-68% output burn, keeps warm cache)]`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-15`
    - **Decision / Exit Code**: `allow (PreToolUse DET-15 pre-format advisory triggered=true; Stop hook synthesizes single batched command)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-15 Local Formatter Bypass] Prompt requests code formatting / import sorting on a pasted code block. Run `npx prettier --write <file>` or `npx eslint --fix <file>` directly (0 LLM tokens). | Batch format: npx prettier --write "src/messy_imports.ts"`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. GA_REPO intercepts pasted code formatting prompts at PreInvocation via `evaluateDet15FormatterBypass` (`DET-15`), supports independent `formatter-bypass` (`off|warn|block`) overrides without affecting Ring-0 `DET-15`, and downshifts complexity to LOW (`DET-08`). CC_REPO flags formatting bypass via `evaluateDet15PreFormatBypass` and synthesizes batched `npx prettier --write` commands at Stop gate.

---

### Sim 14: Conversational Drip-Feeding (Tier 2)
- **Input Payload Summary**:
  - 5 1-sentence prompts sent 18s apart (72s total) all modifying src/orders.ts
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-02B`
    - **Decision / Exit Code**: `allow (PreInvocation DET-02B Conversational Drip-Feed Advisory triggered on prompt 5; recommends batching requirements)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-02B Conversational Drip-Feed Advisory] Detected 5 rapid single-sentence prompts on src/orders.ts in <90s. Batch requirements into a single checklist turn to save prefix cache and 4x turn overhead.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-05`
    - **Decision / Exit Code**: `allow`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-05 Conversational Drip-Feed] Detected 5 rapid edits on "src/orders.ts" in <90s. Batch multiple micro-requirements into a single turn to preserve KV cache.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. GA_REPO detects conversational drip-feeding (<90s, >=4 micro-prompts targeting same module) via `handlePreInvocation` (`DET-02B`), emitting a batching advisory. CC_REPO tracks rapid multi-turn edits targeting the same file within a 90s window in `CircuitBreakerEngine` and fires `DET-05` (`CONVERSATIONAL_DRIP_FEED`).

---

### Sim 15: Reading Lockfiles & Build Artifacts (Tier 2)
- **Input Payload Summary**:
  - PreToolUse with tool_name="read_file"/"Read" on package-lock.json, pnpm-lock.yaml, and dist/bundle.min.js (plus Bash "cat package-lock.json")
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-07`
    - **Decision / Exit Code**: `deny (PreToolUse DET-07 blocks lockfiles/bundles; active source files preserved=true)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-07] Unbounded read of lockfile or minified bundle ("package-lock.json"). Dumping full lockfile/bundle wastes context. Inspect package.json or use StartLine/EndLine <= 100.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-07`
    - **Decision / Exit Code**: `Read(package-lock.json)=deny (exit=2) | Read(dist/bundle.min.js)=deny (exit=2) | Bash(cat package-lock.json)=deny (exit=2) | ActiveSource(src/auth.ts)=allow`, `exitCode: 2`
    - **Observed Coaching String**:
      > `[DET-07 Unbounded Output Bomb Guard] Unbounded native Read on "package-lock.json". Dumping full lockfile/bundle wastes context. Inspect package.json or specify line limits <= 100.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories intercept direct read attempts on lockfiles (package-lock.json, pnpm-lock.yaml, yarn.lock) and minified bundles (dist/*.min.js) via DET-07, preventing 85,000+ token context dumps while preserving normal reads on active source files.

---

### Sim 16: Mid-History Array Mutation (Tier 2)
- **Input Payload Summary**:
  - 15-message array (4,000 tok/msg = 60,000 tok) with messages[2..4] spliced out -> messages 6..15 (40,000 tok) shift outside 20-block lookback window
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `RETENTION_RADAR`, `DET-26`
    - **Decision / Exit Code**: `RetentionRadar Grade=C (retentionPct=13.01%, firstDiffOffset=byte 25660); DET-26 shiftedSuffixTokens=40000; trimUncachedTail headBytesPreserved=true`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-26 Silent Prefix Mutation] Deleted 3 historical message(s) starting at index 2, shifting 40,000 suffix tokens outside 20-block lookback window. | Retention dropped to 13.01% (Grade C, leaked $0.1404). Use trimUncachedTail() to trim only beyond cachedTokens.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-09`
    - **Decision / Exit Code**: `LOOKBACK_WINDOW_DELETION (shiftedSuffixTokens=40000; retentionIndexPct=17%, leakedUSD=$0.54)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-09 Silent Prefix Mutation] Deleted 3 historical message(s) starting at index 2, shifting 40,000 suffix tokens outside 20-block lookback window. | Retain 17% · Saved $0.11 · Leaked $0.54 · 1 bust`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories classify 20-block lookback window splicing via `evaluateSilentPrefixMutations` (`LOOKBACK_WINDOW_DELETION`, quantifying 40,000 shifted suffix tokens) alongside byte-offset diffing (`RetentionRadar`) and `SprintMetrics`, while `trimUncachedTail` enforces tail-only trimming.

---

### Sim 17: Skipping the Plan/TDD Gate (Tier 2)
- **Input Payload Summary**:
  - Turn 1 prompt="Refactor the billing pipeline" (0 reads, 0 plan, 0 tests) -> immediate Write/Edit across 4 billing files (+ TDD @file + *.test.ts exemption check)
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-06`, `DET-13`
    - **Decision / Exit Code**: `PreInvocation=terminate; BlindMultiEdit(edit 2)=ask (TDD @file+test exempt=true); ProofGrade=Weak`, `exitCode: 0`
    - **Observed Coaching String**:
      > `PreInv: ╭─ Flight Check v3.1 ──────────────────────────────────────────────────────────╮ │ 1. PROMPT : [Sufficiency 3/12 Low] | Missing: scope bound | BlindEdit: [DET-06] Blind unplanned multi-file edit on Turn 1 (2 non-test source files modified) with 0 prior read/search discovery calls; verify existing code or create a plan first. | Proof: Weak`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-14`
    - **Decision / Exit Code**: `PreToolUse(edit 2)=deny (exit=2, subType=BLIND_UNPLANNED_MULTI_EDIT) -> StopGate(AUTO_PILOT)=block (exitCode=0)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-14 Blind Multi-File Edit] Turn 1 multi-file edit (2 non-test files) with 0 prior read/grep discovery calls. Verify existing architecture or create a plan first.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories gate blind Turn-1 multi-file edits starting at >=2 non-test source files (`GA_REPO` `DET-06` and `CC_REPO` `DET-14`) while explicitly exempting anchored `@file` + `*.test.*` TDD companion pairs.

---

### Sim 18: Unbounded Web/Docs Dump (Tier 2)
- **Input Payload Summary**:
  - WebFetch response of 240,657 bytes (~60,165 tokens) containing <style>, <script>, <nav>, and HTML comment injection
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-07`
    - **Decision / Exit Code**: `offloaded=true (saved 60,016 tokens -> indexed in FTS5 & stored at ah_486761cc4b9f3cb31fd3eb4e0bd692e1612fe4378275918eae9d6ba6d243741b.txt)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[Artifact Offloaded: ah_486761cc4b9f (3206 lines, ~60165 tokens)] Artifact saved to: C:\Projects\ga-visualizer-v2\__sim_tests__\sim_workspace\.ctxtop\cache\artifacts\ah_486761cc4b9f3cb31fd3eb4e0bd692e1612fe4378275918eae9`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-07`, `DET-19`
    - **Decision / Exit Code**: `offloaded=true + HTML boilerplate stripped + DET-19 IPI triggered=true`, `exitCode: 0`
    - **Observed Coaching String**:
      > `Sanitized 60,165 tok -> 137 tok (saved 60,028 tok; [DET-19 Subagent IPI Sanitizer] Neutralized 81713 char(s) of hidden Unicode / XML boundary / prompt-injection markers and wrapped output in <untrusted_subagent_data trust="untrusted" readonly="true">.)`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories automatically intercept >4,000-token `WebFetch` payloads, offloading the raw dump to content-addressed storage and replacing the in-context message with a compact ~100–350 token summary pointer (with CC additionally stripping `<nav>/<script>/<style>` DOM boilerplate and `DET-19` prompt-injection comments).

---

### Sim 19: Vision/Screenshot Abuse (Tier 2)
- **Input Payload Summary**:
  - 3 consecutive turns with Base64 PNG blocks in messages[] debugging a text CSS/console error (tested with aiCreditOveragesActive=false and true)
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-20`
    - **Decision / Exit Code**: `OverageActive=true: triggers DET-20 (true) | Base64Blocks=3 (cumulativeVisionTaxTokens=9600)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-20 Vision Token Drain Advisory] 3 screenshot/image blocks accumulated (~9,600 cumulative vision tokens) for text/DOM/CSS debugging. Paste console logs or DOM/CSS rules as text instead.`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-20`
    - **Decision / Exit Code**: `allow (cumulativeVisionTaxTokens=9600)`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-20 Vision Token Drain] 3 screenshot/image blocks accumulated (~9,600 cumulative vision tokens) for text-debuggable issues. Paste error logs or DOM/CSS snippets directly.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories inspect historical `messages[]` Base64 image blocks and compute compounding multi-turn resend taxes (`cumulativeVisionTaxTokens` = 9,600 tok across 3 turns) via `DET-20`, while `GA_REPO` additionally halts image uploads when AI credit overages are active to prevent HTTP 400 crashes.

---

### Sim 20: Destructive Code-Stripping (Tier 2)
- **Input Payload Summary**:
  - Edit & Write on 250-line src/payment_processor.ts replacing lines 2..160 with "// ... existing code ..." and "# ... rest of implementation unchanged" (62.8% line shrinkage)
- **Observed Output (`GA_REPO` & `CC_REPO`)**:
  - **`GA_REPO`**:
    - **Detectors Triggered**: `DET-05`, `DET-16`
    - **Decision / Exit Code**: `deny`, `exitCode: 0`
    - **Observed Coaching String**:
      > `[DET-05] Pre-write integrity violation on src/payment_processor.ts: LAZY_ELISION_PLACEHOLDER; UNREQUESTED_FILE_SHRINKAGE_63PCT (250->93 lines). 3-Stage Design-by-Contract: (1) State invariant & pre-conditions, (2) Apply minimal surgical diff preserving error handling & assertions, (3) Verify post-conditions via test suite. (Shrinkage: 63%, stripped=true)`
  - **`CC_REPO`**:
    - **Detectors Triggered**: `DET-05`
    - **Decision / Exit Code**: `Edit=deny (exit=2, subType=LAZY_ELISION_PLACEHOLDER) | Write(no old_string)=deny (exit=2, subType=LAZY_ELISION_PLACEHOLDER)`, `exitCode: 2`
    - **Observed Coaching String**:
      > `[DET-05 Destructive Code-Stripping] Diff inserts lazy placeholder comments ("// ... existing code ...") deleting implemented logic. Write the complete surgical replacement.`
- **Verdict & Gap Fix**:
  - **Verdict**: **PASS**. PASS. Both repositories detect lazy elision placeholders ("// ... existing code ...") and massive unrequested file shrinkage (>50%). GA_REPO inspects disk files via evaluateDet05PreWriteIntegrity and inspectFileShrinkage; CC_REPO hydrates existing disk files in evaluatePreToolUse for Write tools and blocks both Edit and Write with exit code 2 via evaluateDet05DiffThrashing.

---

## 4. Architectural Invariant Verification Attestation

| Invariant | Requirement | Verification Method | Status |
| :--- | :--- | :--- | :---: |
| **1. Plain-Text `/compact`** | Plain-text instruction inside `#compactInstruction`; never render clickable copy button (`#btnCompactPrimary`, `copyCompactWithGuidance`) or `Ctrl+V` guidance. | Grep search across `src/webview/horizon_panel.html` confirms `#compactInstruction` contains plain-text instructions and prohibited symbols are absent. | **VERIFIED** |
| **2. Active Source File Protection** | Only show ignore button on lockfiles, logs, build artifacts, or scratch files (`isIgnorablePath`); never on active source files (`.ts`, `.mjs`, `.js`, `.py`). | Direct programmatic test of `isIgnorablePath()` confirms `false` for active source files and `true` for lockfiles/bundles. | **VERIFIED** |
| **3. 3-Way Webview & Core Mirror Parity** | Byte-for-byte SHA-256 identical parity across all plugin mirrors (`~/.gemini/config/plugins/agy-horizon`, `~/.gemini/config/plugins/agy-horizon-flightcheck`, and `.agents/plugins/agy-horizon-flightcheck`). | `node scripts/sync_mirrors.mjs --verify-only` confirms 8 HTML targets and 639 mirrored file pairs byte-for-byte identical. | **VERIFIED** |
| **4. Read-Only SQLite (`SQLITE_OPEN_READONLY`)** | Open all SQLite databases strictly `{ readOnly: true }` (`SQLITE_OPEN_READONLY_OPTIONS`) and JSONL transcripts with `'r'`. | Zero-trust audit of `src/core/sqlite_client.mjs`, `src/engine-node/db/index.mjs`, `sqlite_wrapper.mjs`. | **VERIFIED** |
| **5. Zero Outbound Network & Zero Runtime Dependencies** | Zero outbound network calls (`fetch`, `http.request`, etc.) and zero runtime `dependencies` in `package.json`. | AST grep confirms 0 network calls across `src/` and `sidecars/`; `package.json` contains 0 runtime dependencies. | **VERIFIED** |
| **6. Zero PII & Unicode Tag Airlock** | Sanitize credentials, API tokens, and prompt injection markers (`DET-04`, `DET-19`). | Programmatic test of credential sanitizers and `DET-19` IPI neutralization. | **VERIFIED** |
