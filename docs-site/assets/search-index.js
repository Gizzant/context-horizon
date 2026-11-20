/* Auto-generated offline search index for Highbeam User Guide (117 entries) */
window.AH_SEARCH_INDEX = [
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "System Architecture & Internals",
    "href": "architecture.html",
    "keywords": "architecture",
    "body": "Highbeam uses a six-package monorepo with zero npm dependencies. It keeps pure ESM context math cleanly separated from Node.js storage code and host plugins."
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "1. Six-Package Workspace Topology",
    "href": "architecture.html#monorepo-topology",
    "keywords": "package.json packages/* src/core-isomorphic/ src/engine-node/ src/core/ @ctxtop/core node:* DET-01..DET-32 CircuitBreakerEngine cacheGravity dualTtl cliffBreaker horizonGrid costRadarSvg modViews @ctxtop/engine-node >= 22.13.0 node:sqlite git merge-tree @ctxtop/antigravity PreInvocation horizon_panel.html @ctxtop/claude-code hooks/register.js hooks/handlers/*.mjs ah-statusline @ctxtop/mcp horizon_status cache_gravity_check scope_lock_claim export_receipt_pdf horizon_compress_cli horizon_search_logs horizon_audit_sessions @ctxtop/pro team_finops_pack.mjs ctxtop",
    "body": "Root package.json defines six packages under packages/* backed by shared code in src/core-isomorphic/, src/engine-node/, and src/core/: Workspace Package Runtime Constraint Core Modules @ctxtop/core Pure ESM, zero node:* imports DET-01..DET-32 rules, CircuitBreakerEngine, cacheGravity, dualTtl, cliffBreaker, horizonGrid, costRadarSvg, modViews, USTF v1 parser. @ctxtop/engine-node Node.js >= 22.13.0 stdlib only node:sq"
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "2. Claude Mod Laws 1-5 & Pure-JS Cryptography",
    "href": "architecture.html#isomorphic-laws",
    "keywords": "src/core-isomorphic/ test/mod_static_compliance.test.mjs node:* node:fs node:path node:crypto node:child_process Buffer process globalThis fnv1a64.mjs sha256HexPure evaluatePreToolUse computeBreakEven ~0.2ms p95",
    "body": "Claude Code's in-process module (not loaded by current versions) would run inside a sandboxed V8 isolate without Node.js built-ins. Every file in src/core-isomorphic/ follows five strict rules checked by test/mod_static_compliance.test.mjs: Zero node:* Imports: No node:fs, node:path, node:crypto, or node:child_process imports anywhere in core. Zero Unguarded Node Globals: Never touches bare Buffer or process without safe globalThis checks. Zero External npm Dep"
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "3. Lossless FTS5 CLI Output Compressor",
    "href": "architecture.html#fts5-compressor",
    "keywords": "src/core/fts5_output_compressor.mjs src/shims/agy_cli_compressor.mjs DET-07 \\r 4,096 cargo test npm install .ctxtop/cache/artifacts/ah_<sha256>.txt .ctxtop/cache/artifacts_fts5.db SQLITE_ENABLE_FTS5 CTXTOP_FORCE_FTS5_POLYFILL=1 src/engine-node/db/probe.mjs DatabaseSync createFts5PolyfillClass() USING fts5(...) MATCH bm25() snippet() evaluateFtsSnippet agy-horizon log-search \"<query>\"",
    "body": "Test runs and package installs often dump 50,000+ chars of progress bars and passing test lines. Built into src/core/fts5_output_compressor.mjs and src/shims/agy_cli_compressor.mjs (DET-07), the compressor cleans shell output in four steps: ANSI & Spinner Cleanup: Strips color codes and folds \\r spinner lines before checking the 4,096-char size limit. Smart Noise Filters: Trims boilerplate from cargo test, npm instal"
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "4. PrefixCacheShield & TurnZeroGate Fencing",
    "href": "architecture.html#turn-zero-gate",
    "keywords": "AGENTS.md CLAUDE.md .agents/rules/*.md PrefixCacheShield TurnZeroGate",
    "body": "Editing AGENTS.md, CLAUDE.md, or .agents/rules/*.md mid-chat changes Cell 1 at the top of your prompt. That resets every warm cached token below it. PrefixCacheShield and TurnZeroGate stop mid-chat cache resets by holding rule edits until the cache cools naturally: TurnZeroGate Deferred Rule Promotion Sequence 1. Warm Cache Active (TTL 03:40) /evolve or rule promotion DET-09 fences direct write; delta staged in queue"
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "5. USTF v1 & 3-Way SHA-256 Mirror Parity",
    "href": "architecture.html#ustf-and-mirror-parity",
    "keywords": "src/core-isomorphic/ustf/ version: \"1.0.0\" sessionId harness modelId usage: { uncached, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking, costUSD } events spans node scripts/sync_mirrors.mjs node scripts/generate_checksums.mjs node bin/ctxtop.mjs verify --json",
    "body": "USTF v1 (src/core-isomorphic/ustf/): Maps Antigravity SQLite/JSONL steps and Claude Code events into one shared log format (version: \"1.0.0\", sessionId, harness, modelId, usage: { uncached, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking, costUSD }, events, spans). Release & Mirror Sync: When core or WebView files change, run node scripts/sync_mirrors.mjs first. Then run node scripts/generate_checksums.mjs an"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "CLI & Binaries Reference",
    "href": "cli-reference.html",
    "keywords": "cli-reference",
    "body": "Highbeam ships 12 CLI commands and 3 shell shims across four runtime targets. Every subcommand below matches the flags in bin/ctxtop.mjs, bin/ah-statusline.mjs, and src/cli/*.mjs."
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "Package Binaries & Entrypoints",
    "href": "cli-reference.html#package-binaries",
    "keywords": "ctxtop ah attention-horizon ah-claude attention-horizon-claude ./bin/ctxtop.mjs ah-statusline ./bin/ah-statusline.mjs statusLine 80 110 144 attention-horizon-antigravity ah-antigravity agy-horizon agy-horizon-flightcheck ./src/cli/init.mjs --serve --demo-animate exec log-search ah-mcp ctxtop-mcp ./packages/mcp/src/server.mjs",
    "body": "Binary Name(s) Target Script Primary Purpose ctxtop, ah, attention-horizon, ah-claude, attention-horizon-claude ./bin/ctxtop.mjs Main CLI router. Handles setup, receipts, Cost Radar, settings, session control, log checks, and Pro keys. ah-statusline ./bin/ah-statusline.mjs Claude Code statusLine stdin bridge. Draws 80, 110, or 144-column ANSI status bars. attention-horizon-antigravity, ah-antigravity, agy-horizon, ag"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "Complete Subcommand Reference",
    "href": "cli-reference.html#subcommand-catalog",
    "keywords": "",
    "body": "All Setup & Doctor HUD & Telemetry Control & Config Pro & FinOps"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam init",
    "href": "cli-reference.html#cmd-init",
    "keywords": "--antigravity --claude ah-statusline settings.json --mcp --cursor --windsurf attention-horizon .cursor/mcp.json ~/.cursor/mcp.json --global --all -a --lean-hooks --full-hooks --dry-run --dedupe highbeam init",
    "body": "Safely installs Highbeam across one or more host tools without overwriting your existing hooks. Synopsis highbeam init [--antigravity] [--claude] [--mcp | --cursor | --windsurf] [--all] [--global | -g | --workspace | --project] [--lean-hooks | --full-hooks] [--dry-run] [--dedupe] [--json] --antigravity: Installs Google Antigravity plugin files, rules, skills, and sidecar hooks. --claude: Merges Claude Code hooks and ah"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam install & highbeam uninstall",
    "href": "cli-reference.html#cmd-install-uninstall",
    "keywords": "settings.json inspectClaudeBinaryCapabilities() PostModelSwitch omittedUnsupportedHooks --project <cwd>/.claude/settings.json --global highbeam install highbeam uninstall",
    "body": "Adds or removes Highbeam in Claude Code settings.json and saves a timestamped backup first. It checks your Claude binary with inspectClaudeBinaryCapabilities(). If your CLI build lacks newer hooks like PostModelSwitch, it skips them and lists them in omittedUnsupportedHooks. Synopsis highbeam install [--global | -g | --project] [--lean-hooks | --full-hooks] [--json] highbeam uninstall [--global | -g | --project] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam doctor & highbeam prune",
    "href": "cli-reference.html#cmd-doctor",
    "keywords": "claudeCapabilities modelSwitchTelemetry --diagnostic --bug-report --json checks PreModelSwitch PostModelSwitch supportsAskDecision PreEffortChange hookDiagnostics --prune-tools --uncached-tail agy-horizon prune --transcript <path> .bak --reap-orphans --handoff --distill docs/ --recover-brain --gc-cursor --vscdb <path> state.vscdb --dry-run highbeam doctor highbeam prune",
    "body": "Checks host setup, Claude hook support (claudeCapabilities), privacy-safe switch stats (modelSwitchTelemetry), model lists, and hook error logs. It can also prune old tool logs and clean up disk bloat offline. Synopsis highbeam doctor [--diagnostic | --bug-report] [--json] [--prune-tools | --prune | --uncached-tail | --tail] [--transcript <path>] [--reap-orphans] [--handoff | --distill] [--storage-gc | --gc-cursor | --"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam verify (alias: verify-checksums)",
    "href": "cli-reference.html#cmd-verify",
    "keywords": "CHECKSUMS.sha256 0 highbeam verify [--json] highbeam verify verify-checksums",
    "body": "Checks SHA-256 hashes (with normalized line endings) for every release file in CHECKSUMS.sha256. Exits 0 when all files match. Synopsis highbeam verify [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam receipt",
    "href": "cli-reference.html#cmd-receipt",
    "keywords": "highbeam receipt [--simple | --4-rank | --advanced] [--markdown | --md | --git | --html | --pdf | --json] [--out <path>] --pdf 2 highbeam license trial highbeam receipt",
    "body": "Prints your estimated Tokens & USD Saved receipt as terminal text, Git Markdown, HTML, JSON, or a Pro SHA-256 PDF 1.4 file. Synopsis highbeam receipt [--simple | --4-rank | --advanced] [--markdown | --md | --git | --html | --pdf | --json] [--out <path>] Note: Running --pdf on the Free tier exits with code 2. It shows your 30-day USD savings and explains how to start a local trial (highbeam license trial)."
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam panel",
    "href": "cli-reference.html#cmd-panel",
    "keywords": "~/.claude/attention-horizon/horizon_panel.html highbeam panel [--advanced] [--out <file.html>] [--json] highbeam panel",
    "body": "Writes a standalone, offline Claude Code HTML panel snapshot. Saves to ~/.claude/attention-horizon/horizon_panel.html by default. Synopsis highbeam panel [--advanced] [--out <file.html>] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam cost-radar (alias: radar)",
    "href": "cli-reference.html#cmd-cost-radar",
    "keywords": "~/.claude/attention-horizon/cost_radar.html highbeam cost-radar [--out <file.html>] [--demo] [--share] [--json] highbeam cost-radar radar",
    "body": "Writes a script-free HTML/SVG timeline of turn-by-turn cache hits, thinking-token spikes, and Git worktree branches. Saves to ~/.claude/attention-horizon/cost_radar.html by default. Synopsis highbeam cost-radar [--out <file.html>] [--demo] [--share] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam statusline & ah-statusline",
    "href": "cli-reference.html#cmd-statusline",
    "keywords": "statusLine stdin 1,500ms .claude/cache/ah_live_state_<sessionId>.json ah-statusline [--demo] [--columns <N> | --cols <N>] highbeam statusline ah-statusline",
    "body": "Reads Claude Code's statusLine JSON from stdin (up to 1,500ms). Updates .claude/cache/ah_live_state_<sessionId>.json and prints a one-line ANSI bar. Synopsis ah-statusline [--demo] [--columns <N> | --cols <N>]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam postmortem & highbeam roast",
    "href": "cli-reference.html#cmd-postmortem-roast",
    "keywords": "CONTEXT_ROT_DECAY VERIFICATION_CHURN SPEC_AMBIGUITY CLEAN highbeam postmortem [--last <N>] [--roast] [--demo] [--json] highbeam roast [--demo] [--markdown | --md] [--json] --last 15 session_analysis_report.md conversation_diagnostics.jsonl writeFiles highbeam postmortem highbeam roast",
    "body": "Scans recent local sessions and groups failures into clear types (CONTEXT_ROT_DECAY, VERIFICATION_CHURN, SPEC_AMBIGUITY, or CLEAN). It flags repeated file reads, checks Turn-0 MCP bloat, and prints an ASCII or Markdown summary. Synopsis highbeam postmortem [--last <N>] [--roast] [--demo] [--json] highbeam roast [--demo] [--markdown | --md] [--json] --last checks 15 sessions by default. Writes session_analysis_report.md a"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam inspect",
    "href": "cli-reference.html#cmd-inspect",
    "keywords": "highbeam inspect [<session-id> | --session <id> | --last] [--out <file.json>] [--json] highbeam inspect",
    "body": "Converts any Claude Code snapshot, USTF v1 log, or Antigravity brain folder into a standard USTF v1 trace. Reports event counts, call trees, cached vs. uncached tokens, and USD cost. Synopsis highbeam inspect [<session-id> | --session <id> | --last] [--out <file.json>] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "Antigravity Server, Demos & FTS5 Execution Wrappers",
    "href": "cli-reference.html#cmd-ui-demo-exec",
    "keywords": "agy-horizon src/cli/init.mjs src/cli/horizon_hud.mjs",
    "body": "Run through agy-horizon (src/cli/init.mjs) or src/cli/horizon_hud.mjs: Synopsis # Start loopback HTTP/SSE daemon on 127.0.0.1:62935..62945 agy-horizon ui [--open | --no-open] [--demo] highbeam --serve # Run 5-stage synthetic terminal crisis showcase or emit Studio HTML widget agy-horizon demo [--demo-animate] [--scenario <1..5>] [--harness <antigravity|claude-code>] node src/cli/horizon_hud.mjs --emit-widget # Execute "
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam config",
    "href": "cli-reference.html#cmd-config",
    "keywords": ".attention-horizon.json ~/.attention-horizon/config.json --global highbeam config",
    "body": "Lists, sets, or resets detector rules in .attention-horizon.json (project default) or ~/.attention-horizon/config.json (--global). Synopsis highbeam config [list] [--global | -g] [--json] highbeam config set <DET-01..DET-20 | habit-slug> <default | off | warn | block> [--global | -g] highbeam config reset [--global | -g]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam control",
    "href": "cli-reference.html#cmd-control",
    "keywords": "~/.ctxtop/runtime/<sessionId>.ctl control.transition highbeam control <status | pause | resume | step | abort | rewind> [--session <id>] [--target <turn> | --turn <turn>] abort ABORTED .ctl highbeam control",
    "body": "Updates the 5-state session control file at ~/.ctxtop/runtime/<sessionId>.ctl and notifies any running Micro-IPC daemon via control.transition. Synopsis highbeam control <status | pause | resume | step | abort | rewind> [--session <id>] [--target <turn> | --turn <turn>] Note: abort moves the session to the final ABORTED state. You must start a new session or delete the .ctl file to run tools again."
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "highbeam license (pro), tiers & team-pack",
    "href": "cli-reference.html#cmd-pro-team",
    "keywords": "highbeam license pro tiers team-pack",
    "body": "Manages offline Ed25519 Pro keys, 14-day local trials, and Grafana or Datadog OpenTelemetry packs. Synopsis highbeam tiers [--json] highbeam license [status | tiers | trial | activate <ed25519-token> | deactivate] [--json] highbeam team-pack [--out <dir>] [--org \"<Org Name>\"] [--preview] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "Execution Shims & Standard Exit Codes",
    "href": "cli-reference.html#shims-and-exit-codes",
    "keywords": "src/shims/ src/shims/agy_cli_compressor.mjs AGY_CONVERSATION_ID src/shims/agy_git_guard.mjs DET-01 src/shims/ah_log_query.mjs .ctxtop/cache/artifacts_fts5.db 0 allow deny ask stdout 1 2 stderr highbeam receipt --pdf highbeam team-pack --preview",
    "body": "Three standalone scripts in src/shims/ plug directly into shell workflows: src/shims/agy_cli_compressor.mjs: Strips ANSI escape codes and saves long command output to SQLite FTS5 using AGY_CONVERSATION_ID. src/shims/agy_git_guard.mjs: Checks git and shell flags before execution to back DET-01. src/shims/ah_log_query.mjs: Fast FTS5 reader that searches saved log lines in .ctxtop/cache/artifacts_fts5.db. Exit Code Mean"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "Slash Commands, Skills & Subagents",
    "href": "commands-skills.html",
    "keywords": "commands-skills",
    "body": "Highbeam ships slash commands for Claude Code (commands/*.md), skill packs for Google Antigravity (skills/*/SKILL.md), short chat prefixes, and a fast Gemini Flash scout worker."
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "Slash Commands & Skills Catalog",
    "href": "commands-skills.html#slash-commands-overview",
    "keywords": "/horizon commands/horizon.md command.horizon skills/horizon/SKILL.md <agent-embed> /precheck commands/precheck.md skills/precheck/SKILL.md C* C_max /handoff commands/handoff.md skills/handoff/SKILL.md task.md HANDOFF_LATEST.md /compact /cost-radar commands/cost-radar.md skills/cost-radar/SKILL.md /inspect commands/inspect.md skills/inspect/SKILL.md /evolve commands/evolve.md skills/evolve/SKILL.md AGENTS.md CLAUDE.md >8,000 TurnZeroGate /relay relay-breaker skills/relay/SKILL.md S0 / S1 / T / Defer",
    "body": "Command / Skill Claude Code Source Antigravity Source Primary Deliverable /horizon commands/horizon.md & command.horizon skills/horizon/SKILL.md 40-cell Horizon HUD, Simple verdict bar or 5-part Advanced Workbench, and <agent-embed> card. /precheck commands/precheck.md skills/precheck/SKILL.md Prompt scope check, C* / C_max cache payback check, model and effort advice, and a 4-Line Scorecard rewrite. /handoff command"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "Detailed Command Specifications",
    "href": "commands-skills.html#detailed-command-contracts",
    "keywords": "",
    "body": ""
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "1. /horizon",
    "href": "commands-skills.html#slash-horizon",
    "keywords": "attention-horizon advanced npx ah-claude receipt npx ah-claude panel --json node --no-warnings ./src/cli/horizon_hud.mjs --emit-widget <artifactDirectoryPath>/horizon_widget.html <agent-embed> sidecar://agy-horizon-flightcheck/horizon-daemon/ /horizon",
    "body": "Shows your live context window health without changing any repo files. In Claude Code: Runs npx ah-claude receipt or npx ah-claude panel --json. In Google Antigravity: Runs node --no-warnings ./src/cli/horizon_hud.mjs --emit-widget to write <artifactDirectoryPath>/horizon_widget.html. It shows the c"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "2. /precheck & The 8-State Decision Rubric",
    "href": "commands-skills.html#slash-precheck",
    "keywords": "/precheck ~/.gemini/flightcheck/sessions/<conversationId>.sidecar.json 2ms ALLOW_SILENT ! !force ALLOW_ACTIVE_SET ACTIVE_SET ALLOW_PLAN_OR_SUBAGENT /plan invoke_subagent INJECT_CONTEXT_GUARD DIRTY_SNAP UNSEEN_CALLERS LEGACY_POISON STEER_SUBAGENT >25,000 >70% @ah-flash-scout HALT_HYGIENE_OR_SAFETY advisory >140,000 45% HALT_EFFORT_OR_QUOTA 10% quota_floor_fraction: 0.10 600 HALT_REWRITE_SCORECARD",
    "body": "Checks draft prompts and live cache state before you spend high-effort quota. In Antigravity, /precheck reads ~/.gemini/flightcheck/sessions/<conversationId>.sidecar.json in under 2ms and picks one of eight clear router states: ALLOW_SILENT: Prompt is clear and healthy, or starts with a ! / !force one-turn bypass. ALLOW_ACTIVE_SET: No file paths were typed, but the files you mean are already in your recent green ACTI"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "3. /handoff & State Compressor Taxonomy",
    "href": "commands-skills.html#slash-handoff",
    "keywords": "/compact Decisions Blockers Low | Medium | High Artifacts State Changes Next Action @file \"Continue working\" \"WIP\" /handoff",
    "body": "Builds and checks a clean State Baton before /compact or starting a fresh chat. It uses a strict KEEP / DROP filter and a 5-point check: KEEP: Design Decisions (with a 1-sentence why), open Blockers (Low | Medium | High), touched file Artifacts, proven State Changes, and one clear Next Action naming an exact @file or symbol. DROP: Step-by-step dead ends, fixed debug notes, raw stack traces, and vague lines like \"Cont"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "4. /cost-radar",
    "href": "commands-skills.html#slash-cost-radar",
    "keywords": "retention drift swarm loopTriggered true DET-30 DET-21 -- /cost-radar",
    "body": "Builds a standalone HTML/SVG timeline and sums up chat spend in three short lines from JSON fields retention, drift, and swarm. If loopTriggered is true, it leads right away with a thinking-loop alert (DET-30, or DET-21 in older Claude commands). It then suggests naming a target file plus a test, or lowering effort. Missing numbers always show -- and are never guessed."
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "5. /inspect",
    "href": "commands-skills.html#slash-inspect",
    "keywords": "highbeam inspect --last .claude/cache/ah_live_state_<sessionId>.json ~/.ctxtop/sessions/<sessionId>.jsonl brain/<sessionId> /inspect",
    "body": "Runs highbeam inspect --last to view call spans, tool speeds, and worker layout. It checks three local paths in order: (1) .claude/cache/ah_live_state_<sessionId>.json, (2) ~/.ctxtop/sessions/<sessionId>.jsonl, and (3) Antigravity's local brain/<sessionId> folder."
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "6. /evolve (RSI-01 Prefix Diet & Skill Evolution)",
    "href": "commands-skills.html#slash-evolve",
    "keywords": "AGENTS.md CLAUDE.md .agents/rules/*.md 8,000 SKILL.md >= 5 confidence >= 0.55 harmful_count == 0 TurnZeroGate 0s /evolve RSI-01",
    "body": "Keeps Turn-0 rule files short while saving proven project lessons: 8,000-Token Rule Budget: Checks AGENTS.md, CLAUDE.md, and .agents/rules/*.md. If static rules pass 8,000 tokens, it offers to move topic blocks into on-demand SKILL.md files. Skill Fix Routing: Sends corrections made right after a skill run back to that skill's own SKILL.md instead of bloating global rules. 5-Lesson Floor: Drafts a new skill only afte"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "7. /relay (Asymmetric Cross-Model Spec Relay)",
    "href": "commands-skills.html#slash-relay",
    "keywords": "relay-breaker S0 S1 T <30 Defer /relay",
    "body": "Stops context bloat when you review specs across two or more models (suggested when relay-breaker spots Round 2+ spec churn). Your local chat acts as the Spec Owner and edits the real Markdown file on disk. Outside models act as fresh Cold Critics. Feedback sorts into S0 (Blocker), S1 (Major Flaw), T (Testable Question checked by a <30-line local script), and Defer, capped at 2 rounds."
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "In-Chat Prompt Control Prefixes",
    "href": "commands-skills.html#in-chat-control-flags",
    "keywords": "! !force ! Run full integration suite PreInvocation ALLOW_SILENT PreToolUse !lock !lock Implement B-tree cursor split #check #check Migrate auth middleware",
    "body": "Prefix Example Runtime Effect ! or !force ! Run full integration suite Skips PreInvocation tips and router holds for this turn (ALLOW_SILENT). Ring-0 shell and secret guards still run at PreToolUse. !lock !lock Implement B-tree cursor split Pins your current model and effort level for the rest of the chat so step-down tips stay quiet. #check #check Migrate auth middleware Runs the full prompt check and prints the 4-L"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "Delegation Scout Subagent (@ah-flash-scout)",
    "href": "commands-skills.html#delegation-scout-subagent",
    "keywords": "agents/ah-flash-scout.md @ah-flash-scout gemini-4-carbon gemini-4-argon 200 path/to/file.mjs:L10-L42 - Symbol / invariant summary",
    "body": "Defined in agents/ah-flash-scout.md, @ah-flash-scout keeps warm frontier chats (gemini-4-carbon, gemini-4-argon) free of huge search dumps during repo lookup: agents/ah-flash-scout.md Manifest Contract name: ah-flash-scout model: flash mainAgent: false subagent: true excludeDefaultComponents: true commandExecutionPolicy: off tools: [view_file, grep_search, find_by_name, list_dir] Hard Output Contract: @ah-flash-scout"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Core Concepts & Mental Model",
    "href": "concepts.html",
    "keywords": "concepts",
    "body": "Highbeam treats each AI coding chat as a bounded working memory shaped by model attention and cache pricing. Four core ideas explain every warning, score, and guard in the tool."
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Why Highbeam Exists",
    "href": "concepts.html#why-attention-horizon-exists",
    "keywords": "200k 1M AGENTS.md CLAUDE.md 1.25x",
    "body": "Long coding chats start failing quietly well before they hit a 200k or 1M token limit. Three common problems hurt code quality and drive up costs: Middle-of-Prompt Memory Drop: Model recall follows a U-shaped curve. Rules at Turn 0 (Primacy) and your newest tool outputs (Recency) stay sharp. Files and notes buried in the middle of a long chat are easy for the model to miss. Repeat File Reads & Log Bloat: Agents often"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "The 40-Cell Horizon Bar & U-Shaped Recall",
    "href": "concepts.html#u-shaped-recall-and-40-cell-bar",
    "keywords": "AGENTS.md CLAUDE.md ACTIVE_SET",
    "body": "Highbeam splits your active context limit into 40 time-ordered cells. Instead of one raw token count, the 40-Cell Horizon Bar shows what is in memory and where each item sits on the U-shaped recall curve. Parabolic U-Shaped Attention Recall Across 40 Context Cells 100% 60% 25% Primacy (0–30%, Anchors 1–6) Middle Trough / Distractor Zone (30–70%, Cells 7–28) Recency Tail (70–100%, Cells 29–40) Cell 1 (Turn 0 System + Rules) Stale Reads & Resol"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Dynamic 40-Cell Zoom Tiers",
    "href": "concepts.html#dynamic-zoom-tiers",
    "keywords": "src/core-isomorphic/ui/horizonGrid.mjs 100k 2,500 claude-haiku-5-5 100,000 5x 200k 5,000 180,000 1M 25,000 total_input_tokens > 180,000 gemini-4-carbon gemini-4-argon claude-opus-5-5 claude-sonnet-5-5",
    "body": "In Claude Code and shared UI views (src/core-isomorphic/ui/horizonGrid.mjs), the 40-cell bar scales across three zoom levels so both small and huge windows stay easy to read: 100k Haiku Cliff Ceiling (2,500 tokens/cell): Used on claude-haiku-5-5 up to 100,000 input tokens so you can spot the 100k 5x price step early. 200k Standard Horizon (5,000 tokens/cell): Default scale for normal coding chats up to 180,000 input "
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Cell Taxonomies by Host",
    "href": "concepts.html#cell-taxonomies",
    "keywords": "[S] █ #1A73E8 CLAUDE.md [C] ▓ #81C995 0.1x [D] ▒ #F538A0 [W] #FA903E 1.25x 2.0x ANCHOR_CORE ANCHOR_SCHEMA AGENTS.md task.md MEMORY_KI MEMORY_BLEED ACTIVE_SET STALE_DUP DEAD_ERROR DIRTY_SNAP LEGACY_POISON **/legacy/** **/deprecated/** **/v1/**",
    "body": "Claude Code reports prompt-cache buckets from Anthropic stats. Google Antigravity tags step-by-step SQLite and JSONL session spans. Both map directly onto the 40-cell bar: Host Surface Code / Category Glyph Physical Meaning Claude Code [S] System & MCP █ (#1A73E8) System prompt, CLAUDE.md rules, and eager MCP tool schemas loaded at Turn 0. Claude Code [C] Warm Cache ▓ (#81C995) Saved history served from Anthropic's w"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "KV-Cache Physics & Break-Even Math (C* & C_max)",
    "href": "concepts.html#cache-gravity",
    "keywords": "claude-opus-5-5 claude-sonnet-5-5 DET-08 src/core-isomorphic/coach/cacheGravityRouter.mjs C* rule_v1 C_max rule_v2 O 1-4 outputShrinkagePriorTokens 500 outputShrinkageMinTurns: 5 cal_<sessionId>.json 1,500 H_post R ~/.attention-horizon/cache/ah_session_prior.json DEFAULT_RPT_SHRINKAGE_PRIOR = 2.0 turnsUntilCompact EMPIRICAL_SESSION_API_CALL_PRIOR P_out P_read P_write 1.25x 2.0x A B paybackWarmRequests paybackTurns horizonNetSavingsUSD <= 0 C_max = Infinity minSwitchPenaltyUSD $0.02 48,000 O = 1,500 Delta_uncached = 0 C* = 6,522 C* = 4,615 claude-opus-4-6 claude-sonnet-4-6 H_post < paybackTurns 48,000 > C_max C* = 0",
    "body": "Dropping from a large model like claude-opus-5-5 to a smaller model like claude-sonnet-5-5 sounds cheaper for quick edits. When a big prompt cache is warm, that move often costs more. Switching models (or changing reasoning effort while the cache is live) resets the warm KV cache. The new model then pays full cache-write prices for your entire chat history. Highbeam's Cache Gravity Router (DET-08 in src/core-isomorph"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Dual-TTL Countdowns & The Haiku 100k Cliff",
    "href": "concepts.html#dual-ttl-and-haiku-cliff",
    "keywords": "dualTtl.mjs 300s 3,600s <= 45s <= 15s T-10s 3.1% DET-12 cliffBreaker.mjs 100,000 5x 90k 90k-98k 98k-100k >= 100k",
    "body": "Two more cost guards run in the background at all times: Dual-TTL Countdown (dualTtl.mjs): Watches both the 5-minute (300s) prompt-cache timer and the 1-hour (3,600s) billing block. The status bar turns amber at <= 45s, shows a keep-warm tip at <= 15s, saves the State Baton at T-10s, and suggests 1-hour caching if at least 3.1% of your breaks last 5 to 60 minutes. Haiku 100k 5x Cliff Breaker (DET-12, cliffBreaker.mjs"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Conductor vs. Executor Division of Labor",
    "href": "concepts.html#conductor-vs-executor",
    "keywords": "127.0.0.1:62935 /browser /swarm @ah-flash-scout 200 hooks/register.js ah-statusline .agents/locks/active_scopes.json DET-20 ~/.ctxtop/sessions/ highbeam inspect highbeam postmortem",
    "body": "Highbeam fits naturally across both Google Antigravity and Claude Code: Google Antigravity as Visual Conductor: Great for system planning, live side-panel HUD review (127.0.0.1:62935), browser checks via /browser, multi-agent work via /swarm, and fast read-only repo lookups with Delegation Scout (@ah-flash-scout, capped under 200 tokens so your main chat stays lean). Claude Code as Fast Terminal Executor: Great for t"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Flight Modes & Enforcement Levels",
    "href": "concepts.html#flight-modes",
    "keywords": "default off warn block .attention-horizon.json OFF SILENT COACH AUTO_PILOT hook_level guard advisory default_flightcheck.json DET-01 DET-02 DET-18 DET-19 ah-statusline PostCompactMutationQueue HysteresisLock C* PreInvocation DET-08 DET-12 ! !lock #check",
    "body": "Highbeam separates tracking from blocking with a Three-Layer Control Stack. Per-detector rules (default, off, warn, block) in .attention-horizon.json come first. Top-level Flight Modes (OFF, SILENT, COACH, AUTO_PILOT) sit next, alongside Antigravity's router hook_level (guard, advisory, off) in default_flightcheck.json. Mode / Level Surface Runtime Behavior OFF Claude Code & Isomorphic Mutes habit tips and cache swit"
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "Configuration, Permissions & Security Sandbox",
    "href": "configuration.html",
    "keywords": "configuration",
    "body": "Highbeam layers project settings over user defaults while keeping strict Ring-0 safety checks, read-only SQLite reads, and local-only ports."
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "1. Unified Config Schema (.attention-horizon.json)",
    "href": "configuration.html#horizon-json-schema",
    "keywords": "src/core-isomorphic/config/horizonConfig.mjs ~/.attention-horizon/config.json <workspace>/.attention-horizon.json flightMode \"OFF\" \"SILENT\" \"COACH\" \"AUTO_PILOT\" \"default\" \"off\" \"warn\" \"block\" DET-08 autoPilotDecision \"ask\" | \"deny\" expectedRemainingTurns H_post useEmpiricalHorizonPrior boolean .attention-horizon.json",
    "body": "Built into src/core-isomorphic/config/horizonConfig.mjs, Highbeam merges settings from lowest to highest priority: built-in defaults → global ~/.attention-horizon/config.json → project <workspace>/.attention-horizon.json. .attention-horizon.json (Complete Default Schema) { \"schemaVersion\": \"1.0.0\", \"detectorNamespace\": \"claude-code\", \"flightMode\": \"COACH\", \"detectors\": { \"DET-01\": \"default\", \"DET-02\": \"default\", \"DET"
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "2. Antigravity Router Schema (default_flightcheck.json)",
    "href": "configuration.html#flightcheck-json-schema",
    "keywords": "PreInvocation config/default_flightcheck.json ~/.gemini/flightcheck/config.json hook_level halt_cooldown_turns \"guard\" \"advisory\" 3 cold_session_max_turns trust_decay_turn_threshold 10 warm_cache_lock_tokens 50000 subagent_min_cache_tokens subagent_min_purity_pct 25000 70.0 STEER_SUBAGENT compact_halt_purity_pct 45.0 /compact amputation_token_threshold 140000 amputationCrisis quota_floor_fraction 0.10 10% HALT_EFFORT_OR_QUOTA max_single_write_lines max_tool_payload_tokens 600 uncheckpointed_dirty_file_limit 4 consecutive_error_strike_limit plan_revision_warn split_recommend_minutes 45 handoff_audit_enabled deprecated_paths true [\"**/legacy/**\", \"**/deprecated/**\", \"**/v1/**\"] LEGACY_POISON config/platformQuirks.json visionOverageHttp400 DET-20 \"Unable to process input image\" hybridQuotaLockout DET-16 80% 90% 40,000 12 168 <cacheDir>/settings.json src/core/settings.mjs { safeLimitTokens, reminderAtPct, modelOverrides } 20,000..1,048,576 50%..99% default_flightcheck.json",
    "body": "Antigravity's PreInvocation router loads defaults from config/default_flightcheck.json and applies your changes from ~/.gemini/flightcheck/config.json. See Antigravity Router Levels & Cooldowns for how hook_level works with halt_cooldown_turns: Key Default Operational Meaning hook_level \"guard\" Router mode: \"guard\" stops with a scorecard; \"advisory\" adds soft warnings only. halt_cooldown_turns 3 Turns skipped between"
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "3. Environment Variables Reference",
    "href": "configuration.html#environment-variables",
    "keywords": "AH_COLUMNS bin/ah-statusline.mjs 80 110 144+ --columns AH_INTERCEPTION_LOG_PATH hooks/handlers/pre-model-switch.mjs PreModelSwitch AH_MODEL_SWITCH_TELEMETRY_PATH src/utils/modelSwitchTelemetry.mjs ~/.attention-horizon/cache/model_switch_telemetry.json AH_TIER1_MOD_ACTIVE hooks/register.js \"1\" CLAUDE_BIN src/diagnostics/claudeHookCapabilities.mjs CLAUDE_PLUGIN_ROOT hooks/hooks.json bin/ctxtop.mjs CLAUDE_CODE_ENABLE_TELEMETRY otelExporter.mjs CLAUDE_HEADLESS ANTIGRAVITY_CONVERSATION_ID AGY_CONVERSATION_ID server.mjs agy_cli_compressor.mjs ANTIGRAVITY_SIDECAR_WEB_PORT PORT sidecars/horizon-daemon/server.mjs 62935 62935..62945 ANTIGRAVITY_SIDECAR_UI_TOKEN ATTENTION_HORIZON_HOME_DIR src/core/constants.mjs CTXTOP_FORCE_NO_SQLITE src/engine-node/db/probe.mjs node:sqlite CTXTOP_FORCE_FTS5_POLYFILL SQLITE_ENABLE_FTS5 CTXTOP_IPC_PATH src/engine-node/ipc/protocol.mjs CTXTOP_NO_BROWSER src/cli/init.mjs agy-horizon ui HORIZON_DEMO HORIZON_DEMO_SCENARIO horizon_hud.mjs 1..5 HORIZON_DIAGNOSTICS_DIR src/core/hook_diagnostics.mjs highbeam doctor HORIZON_DEBUG DEBUG classifier.mjs quota.mjs init.mjs HORIZON_TEST_NO_SPAWN POST /api/open-brain CTXTOP_ED25519_PUBLIC_KEY_PEM CTXTOP_PRO_DEV src/core/pro_license.mjs CTXTOP_ED25519_PRIVATE_KEY_PEM CTXTOP_POLAR_WEBHOOK_SECRET polar_webhook_worker.mjs",
    "body": "Variable Read By Effect & Default AH_COLUMNS bin/ah-statusline.mjs Sets terminal width (80, 110, or 144+ columns) when --columns is not passed. AH_INTERCEPTION_LOG_PATH hooks/handlers/pre-model-switch.mjs Optional JSONL file path to log PreModelSwitch break-even math, weights, and results. AH_MODEL_SWITCH_TELEMETRY_PATH src/utils/modelSwitchTelemetry.mjs Custom path for scrubbed switch stats (defaults to ~/.attention"
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "4. Zero-Trust Security Sandbox & Branch Isolation",
    "href": "configuration.html#security-sandbox",
    "keywords": "SECURITY.md test/mod_static_compliance.test.mjs sidecars/horizon-daemon/server.mjs 127.0.0.1 4,096 { readOnly: true } SQLITE_OPEN_READONLY try / finally 'r' DET-18 .claude/settings.json hooks.json workspace: \"share\" git worktree add .agents/locks/active_scopes.json DET-20",
    "body": "Backed by SECURITY.md and checked in test/mod_static_compliance.test.mjs, Highbeam enforces five strict safety rules: Zero Outbound Network Calls: The CLI, hooks, MCP server, and local HTTP server never make external HTTP or DNS requests. Localhost Binding & Size Caps: sidecars/horizon-daemon/server.mjs binds only to 127.0.0.1 and drops POST bodies over 4,096 bytes. Read-Only Session Reads: Every Antigravity "
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Guardrails & Detector Catalog",
    "href": "detectors.html",
    "keywords": "detectors",
    "body": "Highbeam runs 32 core detectors (DET-01..DET-32), 8 habit coaches, and 6 local Blind-Spot Sensors in fast local JavaScript. Zero extra LLM judge tokens are ever spent."
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Canonical Detector Catalog (DET-01 to DET-32)",
    "href": "detectors.html#canonical-detectors",
    "keywords": "DET-01 DET-02 DET-18 DET-19 guard git reset --hard git push --force rm -rf .env* ~/.gemini/oauth_creds.json DET-03 package-lock.json pnpm-lock.yaml Cargo.lock DET-04 3 consecutiveFailureLimit: 3 DET-05 .skip only DET-06 advisory DET-07 4,096 25k SQLITE_ENABLE_FTS5 DET-08 C* C_max PreModelSwitch $0.02 minSwitchPenaltyUSD permissionDecision: \"ask\" \"deny\" DET-09 AGENTS.md CLAUDE.md effort thinking speed mcp_tools computeDet09BreakEvenTokens det09MinCachedTokens TurnZeroGate PostCompact DET-10 300s 45s 10s DET-11 DET-12 100,000 5x 98k 100k DET-13 DET-14 Stop DET-15 TODO FIXME DET-16 80% 90% 40,000 12 168 DET-17 4 .claude/settings.json hooks.json U+E0000..U+E007F DET-20 .agents/locks/active_scopes.json DET-21 DET-30 DET-22 DET-23 catch {} DET-24 trust_decay_turn_threshold 10 DET-25 70,000 140k DET-26 DET-27 8,000 /evolve DET-28 highbeam doctor --reap-orphans DET-29 loopTriggered: true DET-31 git merge-tree DET-32",
    "body": "Four rules carry a Ring-0 Security tag (DET-01, DET-02, DET-18, DET-19). Ring-0 guards protect secrets, shell safety, repo settings, and subagent inputs, and fail closed on broken hook JSON. All (32) Ring-0 Security (4) Default: Guard Default: Advisory ID Detector Name Default / Severity What It Detects & How to Remediate DET-01 Option Argument Skipping & Destructive Git/Shell Guard Ring-0 guard · CRITICAL Reads git "
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Semantic Habit Detectors (semanticDetectors)",
    "href": "detectors.html#semantic-habit-slugs",
    "keywords": ".attention-horizon.json highbeam config set <slug> <default|off|warn|block> formatter-bypass drip-feed vague-prompt-rubric prompt-decomposer scope-brake effort-overkill post-commit-handoff git commit vision-screenshot-coach DET-20 micro-skills microSkillConfirmSessions: 2 relay-breaker spec-relay /relay semanticDetectors",
    "body": "Along with numbered IDs, .attention-horizon.json includes eight readable habit slugs you can set via highbeam config set <slug> <default|off|warn|block>: formatter-bypass: Suggests running prettier or eslint once at the end instead of burning turns after every small edit. drip-feed: Spots rapid 1-line follow-up prompts that pay extra cache-write fees when steps could be grouped. vague-prompt-rubric (aliases: prompt-dec"
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Antigravity 6 Local Blind-Spot Sensors",
    "href": "detectors.html#antigravity-blindspot-sensors",
    "keywords": "PreInvocation src/core/blindspot_sensors.mjs DIRTY_SNAP SCHEMA_TAX UNSEEN_CALLERS ACTIVE_SET LEGACY_POISON deprecated_paths **/legacy/** **/deprecated/** **/v1/** QUOTA_AND_STREAM_SHIELD <10% 600 LOOP_AND_GIT_GUARD",
    "body": "During Antigravity's PreInvocation hook, src/core/blindspot_sensors.mjs runs six fast local disk checks: DIRTY_SNAP: Spots when a file read earlier in chat was changed on disk by you, a formatter, or git. SCHEMA_TAX: Measures Turn-0 MCP and tool schema token size against your window limit. UNSEEN_CALLERS: Scans repo imports when an exported function changes so callers outside ACTIVE_SET do not break. LEGACY_POISON: W"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "Flight Modes & Enforcement Levels",
    "href": "flight-modes.html",
    "keywords": "flight-modes",
    "body": "Highbeam separates tracking from blocking. A clear priority stack lets you tune alerts from quiet local tracking to automatic cache and loop locks while keeping Ring-0 safety guards active."
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "1. The Three-Layer Enforcement Hierarchy",
    "href": "flight-modes.html#enforcement-hierarchy",
    "keywords": "PreInvocation PreToolUse PreModelSwitch PostToolUse horizonConfig.mjs circuitBreakers.mjs cacheGravityRouter.mjs pre_invocation.mjs allow advisory warn ask deny ~/.ctxtop/runtime/<sessionId>.ctl PAUSED STEP ABORTED detectors semanticDetectors <workspace>/.attention-horizon.json ~/.attention-horizon/config.json \"off\" \"warn\" \"block\" flightMode OFF SILENT COACH AUTO_PILOT .attention-horizon.json ah_flight_mode POST /api/router/mode hook_level guard advisory off default_flightcheck.json ! !force !lock #check DETECTOR_CATALOG",
    "body": "Every hook event (PreInvocation, PreToolUse, PreModelSwitch, and PostToolUse) runs as local JavaScript (rule engine under 1 ms; each hook call adds Node startup) inside horizonConfig.mjs, circuitBreakers.mjs, cacheGravityRouter.mjs, and pre_invocation.mjs with zero LLM judge calls. To pick a verdict (allow, soft advisory warn, interactive ask, or hard deny), Highbeam checks four layers from highest to lowest priority: Runtime Control Latch (~/.ctxtop/runtime/"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "2. The Four Flight Modes (OFF, SILENT, COACH, AUTO_PILOT)",
    "href": "flight-modes.html#four-flight-modes",
    "keywords": "flightMode normalizeConfiguredFlightMode() horizonConfig.mjs normalizeFlightMode() circuitBreakers.mjs DISABLED OFF QUIET MUTE SILENT AUTOPILOT AUTO AUTO_PILOT COACH DET-01 DET-02 DET-18 DET-19 scanWorkspaceSettings DET-03..05 DET-07 DET-12 DET-20 ask DET-04 DET-05 DET-08 PreModelSwitch cached > C* C_max allow Explore claude-haiku-5-5 notableAllowNote >= $0.02 \"ask\" \"deny\" DET-08: \"block\" H_post < paybackTurns DET-09 CLAUDE.md AGENTS.md .mcp.json PostCompactMutationQueue computeDet09BreakEvenTokens PostCompact TTL == 0s drip-feed vague-prompt-rubric DET-14 effort-overkill deny DET-06 PreInvocation src/hooks/pre_invocation.mjs {} hook_level guard advisory hookLevel = \"guard\" ah-statusline ah_live_state_<sessionId>.json hooks/handlers/pre-tool-use.mjs flightMode: \"AUTO_PILOT\" requireProFeature(\"auto_pilot_locks\") ~/.ctxtop/license.json npx highbeam-cli license trial \"COACH\"",
    "body": "Highbeam cleans up flightMode case, hyphens, and spaces in normalizeConfiguredFlightMode() (horizonConfig.mjs) and normalizeFlightMode() (circuitBreakers.mjs). Common aliases work too: DISABLED maps to OFF, QUIET and MUTE map to SILENT, and AUTOPILOT and AUTO map to AUTO_PILOT. Unknown values fall back safely to COACH. Subsystem / Rule OFF SILENT COACH Default AUTO_PILOT Pro Ring-0 Security GuardsDET-01, DET-02, DET-"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "3. AUTO_PILOT Escalations & Hysteresis Lock",
    "href": "flight-modes.html#autopilot-and-hysteresis",
    "keywords": "src/core-isomorphic/coach/cacheGravityRouter.mjs AUTO_PILOT HysteresisLock DET-04 DET-05 \"high\" completeActiveTask() POST http://127.0.0.1:62935/api/router/unlock-hysteresis \"ask\" DET-08 PreModelSwitch permissionDecision: \"ask\" coldWritePenaltyUSD paybackWarmRequests paybackTurns C_max -p CLAUDE_HEADLESS \"DET-08\": \"block\" autoPilotDecision: \"deny\" \"deny\" minSwitchPenaltyUSD $0.02 notableAllowPenaltyUSD notableAllowNote unknownModel: true DET-09 PostCompactMutationQueue effort thinking speed system_prompt mcp_tools model ttlRemainingSec > 0 cachedTokens computeDet09BreakEvenTokens() det09MinCachedTokens /compact PostCompact 300s foldCodeToSignatureStub() computeCompactLineDiff()",
    "body": "Built into src/core-isomorphic/coach/cacheGravityRouter.mjs, AUTO_PILOT adds four smart safeguards across turns: Hysteresis Lock (HysteresisLock): When DET-04 (3 tool errors in a row) or DET-05 (edit flip-flops) trips during debugging, AUTO_PILOT pins your current model and sets effort to \"high\". That stops an agent from dropping to a weaker model before the bug is fixed. The lock clears once completeActiveTask() pas"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "4. Antigravity Router Levels (hook_level), Cooldowns & Chat Prefixes",
    "href": "flight-modes.html#antigravity-hook-levels",
    "keywords": "PreInvocation src/hooks/pre_invocation.mjs config/default_flightcheck.json ~/.gemini/flightcheck/config.json hook_level halt_cooldown_turns: 3 \"guard\" Context Health Cache Window Risk Signal Recommended Action { systemMessage } \"advisory\" flightMode: \"AUTO_PILOT\" \"off\" PreToolUse exemptFromCooldown: true amputationCrisis 140,000 AGENTS.md DET-08 5x DET-12 100,000 ! <prompt> !force <prompt> ALLOW_SILENT !lock <prompt> #check <prompt>",
    "body": "On Google Antigravity, Highbeam checks user prompts in PreInvocation (src/hooks/pre_invocation.mjs) using settings from config/default_flightcheck.json and ~/.gemini/flightcheck/config.json. The hook_level setting controls how router stops work: hook_level Router Behavior 3-Turn Cooldown (halt_cooldown_turns: 3) \"guard\" Default Stops vague or risky prompts with the 4-Line Scorecard (Context Health, Cache Window, Risk"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "5. Per-Detector & Habit Overrides (default | off | warn | block)",
    "href": "flight-modes.html#per-detector-overrides",
    "keywords": "applyDetectorOverride() src/core-isomorphic/config/horizonConfig.mjs DET-01..DET-20 formatter-bypass drip-feed vague-prompt-rubric effort-overkill post-commit-handoff vision-screenshot-coach micro-skills relay-breaker \"default\" guard advisory flightMode \"off\" triggered: false, decision: \"allow\", overriddenByConfig: \"off\" \"warn\" decision: \"allow\", blocked: false, advisory: true [Advisory Override (DET-XX=warn)] \"block\" decision: \"deny\", blocked: true, advisory: false isCoachAdvisorySuppressed() circuitBreakers.mjs SILENT OFF .attention-horizon.json default | off | warn | block",
    "body": "When global Flight Modes feel too broad, applyDetectorOverride() in src/core-isomorphic/config/horizonConfig.mjs lets you tune any detector (DET-01..DET-20) or habit rule (formatter-bypass, drip-feed, vague-prompt-rubric, effort-overkill, post-commit-handoff, vision-screenshot-coach, micro-skills, relay-breaker): \"default\": Uses the rule's catalog setting (guard or advisory) and your active flightMode. \"off\": Turns t"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "6. Switching Modes Across Surfaces",
    "href": "flight-modes.html#switching-modes",
    "keywords": "/horizon ah_flight_mode npx highbeam-cli config set <ID|slug> <default|off|warn|block> { \"hook_level\": \"guard\", \"halt_cooldown_turns\": 3, \"warm_cache_lock_tokens\": 50000, \"cache_amputation_tokens\": 140000 } flightMode: \"AUTO_PILOT\" .attention-horizon.json \"hook_level\": \"advisory\" \"guard\" http://127.0.0.1:62935 127.0.0.1",
    "body": "Switch Flight Modes or router levels statically in JSON config files, interactively via the CLI, or live over the loopback daemon API. Claude Code & CLI Google Antigravity Loopback HTTP API <workspace>/.attention-horizon.json (or ~/.attention-horizon/config.json) { \"schemaVersion\": \"1.0.0\", \"flightMode\": \"COACH\", \"detectors\": { \"DET-08\": \"block\" }, \"semanticDetectors\": { \"drip-feed\": \"warn\", \"vague-prompt-rubric\""
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "Terminology & Glossary",
    "href": "glossary.html",
    "keywords": "glossary",
    "body": "Every page in this guide uses the exact terms below. Filter by host or type a keyword to look up any metric, file, or concept."
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "A to D",
    "href": "glossary.html#terms-a-d",
    "keywords": "ACTIVE_SET PreInvocation ALLOW_ACTIVE_SET C* claude-opus-5-5 1.25x DET-08 DIRTY_SNAP SCHEMA_TAX UNSEEN_CALLERS LEGACY_POISON QUOTA_AND_STREAM_SHIELD LOOP_AND_GIT_GUARD ah_claude_capabilities.json 4 MB src/diagnostics/claudeHookCapabilities.mjs 256 PreModelSwitch PostModelSwitch PreEffortChange permissionBehavior===\"ask\" .claude/cache/ah_claude_capabilities.json src/core-isomorphic/ hooks/register.js node:* Buffer process /relay amputationCrisis amputation_token_threshold 140,000 safeLimitTokens 147,000 .attention-horizon.json highbeam cost-radar /cost-radar DET-30 @ah-flash-scout agents/ah-flash-scout.md File:StartLine-EndLine 200 [D] #F538A0 300s 3,600s 00:00",
    "body": "ACTIVE_SET Antigravity Clean file reads, edits, and command outputs from your last 16 steps (~8 chat turns). Files already in ACTIVE_SET pass Antigravity's PreInvocation check quietly via ALLOW_ACTIVE_SET. Algebraic Break-Even (C*) Core Physics The cached token count where staying on a large model (like claude-opus-5-5) costs less than switching down. Below C*, switching saves money; above C*, cold 1.25x cache writes"
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "E to M",
    "href": "glossary.html#terms-f-m",
    "keywords": "cal_<sessionId>.json Stop src/utils/sessionCalibration.mjs ~/.attention-horizon/cache/sessions/ < 5 500 R = 2.0 .attention-horizon.json OFF SILENT COACH AUTO_PILOT MEMORY_BLEED projectPath DET-12 100,000 5x 90k 90k-98k 98k-100k >= 100k ctxtop C_max rule_v2 C* cacheGravityRouter.mjs paybackWarmRequests paybackTurns H_post C_max = Infinity POST /api/router/unlock-hysteresis highbeam install --lean-hooks --full-hooks src/engine-node/ipc/ 15ms 500ms 10MB",
    "body": "Empirical Bayes Session Calibration (cal_<sessionId>.json) Core Physics A read-only Stop-hook tracker (src/utils/sessionCalibration.mjs) saved under ~/.attention-horizon/cache/sessions/. It logs finished turns, unique API calls, starting cache size, and your 10-turn median output length, blending early turns (< 5) toward safe defaults (500 output tokens, R = 2.0). Flight Mode Core Physics Top-level control mode in .a"
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "P to S",
    "href": "glossary.html#terms-p-s",
    "keywords": "TurnZeroGate DET-09 prefix_cache_shield.mjs turn_zero_gate.mjs AGENTS.md CLAUDE.md 0s /compact .agents/cache/learnings-queue.json .claude/cache/learnings-queue.json /evolve confidence >= 0.55 harmful_count == 0 DET-01 DET-02 DET-18 DET-19 .ctl RUNNING PAUSED STEP ABORTED REWIND ~/.ctxtop/runtime/<sessionId>.ctl highbeam control DET-20 .agents/locks/active_scopes.json 900s horizon-daemon sidecars/horizon-daemon/server.mjs 127.0.0.1:62935..62945 ACTIVE_SET task.md docs/HANDOFF_<timestamp>.md .claude/cache/HANDOFF_LATEST.md ah-statusline bin/ah-statusline.mjs statusLine 80 110 144",
    "body": "Prefix Cache Shield & TurnZeroGate Core Physics A cache guard (DET-09, prefix_cache_shield.mjs, turn_zero_gate.mjs) that holds edits to AGENTS.md, CLAUDE.md, and rule files while your prompt cache is warm. Held edits write cleanly once the cache timer hits 0s or right after /compact. Primacy Band & Recency Tail Core Physics The two sharpest recall zones on the U-curve. Primacy covers Turn-0 rules at the start of the "
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "T to W",
    "href": "glossary.html#terms-t-w",
    "keywords": "hooks/register.js ~0.2ms p95 AH_TIER1_MOD_ACTIVE=1 hooks/handlers/*.mjs highbeam doctor --prune-tools POST /api/surgeon .bak src/core-isomorphic/ustf/ highbeam inspect inherit branch share",
    "body": "Tier-1 In-Process Module vs. Tier-2 Command Hook Claude Code Tier-1 is an in-process module (hooks/register.js) that current Claude Code does not load, so it is dormant. Tier-2 runs Node scripts in hooks/handlers/*.mjs as command hooks and is what executes in every session today. Tool-Output Surgeon Core Physics An offline log trimmer (highbeam doctor --prune-tools and POST /api/surgeon). It writes a .bak backup first, then trims old uncached tool outputs "
  },
  {
    "pageTitle": "Lifecycle Hooks & Runtime Control",
    "title": "Lifecycle Hooks & Runtime Control",
    "section": "Lifecycle Hooks & Runtime Control",
    "href": "hooks-lifecycle.html",
    "keywords": "hooks-lifecycle",
    "body": "Highbeam runs zero-token guards and gathers turn stats through fast host hooks. This chapter lists every hook event, tool matcher, JSON format, timeout, and control state."
  },
  {
    "pageTitle": "Lifecycle Hooks & Runtime Control",
    "title": "Lifecycle Hooks & Runtime Control",
    "section": "Google Antigravity Lifecycle Hooks (hooks.json)",
    "href": "hooks-lifecycle.html#antigravity-hooks",
    "keywords": "hooks.json 5 250ms SessionStart hooks/session_start.mjs src/hooks/session_start.mjs PreInvocation hooks/pre_invocation.mjs src/hooks/pre_invocation.mjs systemMessage PreToolUse hooks/pre_tool_use.mjs src/hooks/portfolio_runtime.mjs .ctl DET-01..DET-32 {\"decision\":\"allow|ask|deny\",\"reason\":\"...\"} stdout 0 PostToolUse hooks/post_tool_use.mjs DET-19 DET-04 PostInvocation hooks/post_invocation.mjs src/hooks/post_invocation.mjs ~/.gemini/flightcheck/sessions/<id>.sidecar.json Stop hooks/stop.mjs DET-14 DET-15",
    "body": "In Google Antigravity, hooks.json wires six command hooks. Each runs with a hard 5-second limit and a 250ms stdin read cap: Event Entry Script Tool Matcher Regex Runtime Contract SessionStart hooks/session_start.mjs → src/hooks/session_start.mjs (Session lifecycle) Loads sidecar chat info, measures Turn-0 MCP tool size, and preps resume notes. PreInvocation hooks/pre_invocation.mjs → src/hooks/pre_invocation.mjs (Use"
  },
  {
    "pageTitle": "Lifecycle Hooks & Runtime Control",
    "title": "Lifecycle Hooks & Runtime Control",
    "section": "Claude Code In-Process Module (hooks/register.js): not loaded today",
    "href": "hooks-lifecycle.html#claude-tier1-mod",
    "keywords": "hooks.modules hooks/hooks.json hooks/register.js ~0.2ms p95 AH_TIER1_MOD_ACTIVE=1 on('file.changed') on('tool.call') CircuitBreakerEngine.evaluatePreToolUse on('turn.step') on('turn.complete') $.store on('classic.SessionStart') .claude/cache/HANDOFF_LATEST.md startup|resume|clear|compact|fork on('classic.PreCompact') on('classic.PostCompact') /compact TurnZeroGate on('classic.Stop') DET-14 DET-15 on('command.horizon') on('ui.render')",
    "body": "Listed under hooks.modules in hooks/hooks.json, hooks/register.js runs straight inside Claude Code's V8 isolate with zero process startup cost (~0.2ms p95). It sets AH_TIER1_MOD_ACTIVE=1 and wires 10 handlers: on('file.changed'): Spots outside disk edits so stale in-chat file copies get flagged right away. on('tool.call'): Checks tool calls inside V8, running CircuitBreakerEngine.evaluatePreToolUse, 3rd-read AST stu"
  },
  {
    "pageTitle": "Lifecycle Hooks & Runtime Control",
    "title": "Lifecycle Hooks & Runtime Control",
    "section": "Claude Code Tier-2 Spawned CLI Hooks (hooks/hooks.json)",
    "href": "hooks-lifecycle.html#claude-tier2-cli-hooks",
    "keywords": "hooks/handlers/ user-prompt-submit.mjs PreToolUse handlers/pre-tool-use.mjs Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Task|Agent|WebFetch|mcp__.* CircuitBreakerEngine Grep|Glob PostToolUse handlers/post-tool-use.mjs Bash|PowerShell|Task|Agent|WebFetch|mcp__.* DET-19 PreModelSwitch handlers/pre-model-switch.mjs cal_<sessionId>.json ah_session_prior.json C* C_max DET-08 \"ask\" \"deny\" \"allow\" coldWritePenaltyUSD SavedQuotaLedger PostModelSwitch handlers/post-model-switch.mjs 0 stdout stderr accepted_after_ask completed_after_allow bypassed_after_deny model_switch_telemetry.json PreCompact PostCompact handlers/compact-lifecycle.mjs --phase=pre --phase=post HOLD_COMPACT HANDOFF_LATEST.md TurnZeroGate SessionStart startup|resume|clear|compact|fork --phase=start DET-13 Stop handlers/stop-gate.mjs DET-14 DET-15 updateSessionCalibrationOnStop() hooks/hooks.json",
    "body": "Claude Code runs these command hooks in every session. Seven scripts in hooks/handlers/ enforce the exact same rules (plus optional user-prompt-submit.mjs): Hook Event Handler Script Matcher Primary Responsibility PreToolUse handlers/pre-tool-use.mjs Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Task|Agent|WebFetch|mcp__.* Runs CircuitBreakerEngine, saves strike counts across turns, folds 3rd ful"
  },
  {
    "pageTitle": "Lifecycle Hooks & Runtime Control",
    "title": "Lifecycle Hooks & Runtime Control",
    "section": "Chunked Binary Capability Probing (claudeHookCapabilities.mjs)",
    "href": "hooks-lifecycle.html#claude-binary-capabilities",
    "keywords": "src/diagnostics/claudeHookCapabilities.mjs inspectClaudeBinaryCapabilities() claude CLAUDE_BIN PATH .cmd 4 MB 256 PreModelSwitch PostModelSwitch PreEffortChange from_model to_model prompt_cache_warm context_tokens permissionBehavior===\"ask\" blocked_by_hook (binaryPath, size, mtimeMs) .claude/cache/ah_claude_capabilities.json highbeam install omittedUnsupportedHooks claudeHookCapabilities.mjs",
    "body": "Built into src/diagnostics/claudeHookCapabilities.mjs, Highbeam checks Claude Code hook support on disk without spawning slow subshells or filling V8 memory. inspectClaudeBinaryCapabilities() streams your claude binary (found via CLAUDE_BIN or PATH, unwrapping Windows .cmd shims) in 4 MB chunks with a 256-byte overlap. It checks 10 markers: PreModelSwitch, PostModelSwitch, PreEffortChange, keys from_model, to_model, "
  },
  {
    "pageTitle": "Lifecycle Hooks & Runtime Control",
    "title": "Lifecycle Hooks & Runtime Control",
    "section": "Exit Code & JSON Wire Contract (hookIo.mjs)",
    "href": "hooks-lifecycle.html#hook-wire-contract",
    "keywords": "hooks/handlers/hookIo.mjs 0 stdout {\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"...\"}} updatedInput stderr 2 WorktreeCreate PermissionRequest { allowMalformed: true } hookIo.mjs",
    "body": "Claude Code Tier-2 scripts follow four strict wire rules in hooks/handlers/hookIo.mjs: Quiet Pass: Exit 0 with empty stdout. JSON Decision: Print valid JSON (like {\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"...\"}} or updatedInput) to stdout and exit 0. Hard Block: Print one short note to stderr and exit 2 with empty stdout. Never wired on WorktreeCreate "
  },
  {
    "pageTitle": "Lifecycle Hooks & Runtime Control",
    "title": "Lifecycle Hooks & Runtime Control",
    "section": "5-State Runtime Control FSM (.ctl)",
    "href": "hooks-lifecycle.html#runtime-control-fsm",
    "keywords": "src/core-isomorphic/control/controlStateMachine.mjs ~/.ctxtop/runtime/<sessionId>.ctl PAUSED PreToolUse 50ms 600,000ms resume step abort ABORTED .ctl",
    "body": "Built into src/core-isomorphic/control/controlStateMachine.mjs, Runtime Control lets you pause, step, rewind, or stop a live chat from any terminal via ~/.ctxtop/runtime/<sessionId>.ctl: 5-State Runtime Control Finite State Machine RUNNING pause resume PAUSED step (1) consume_step STEP REWIND ABORTED Terminal & Irreversible While PAUSED, PreToolUse polls lightly every 50ms (up to 600,000ms) until you run resume, step"
  },
  {
    "pageTitle": "Context visibility and zero-token guards for AI coding chats.",
    "title": "Context visibility and zero-token guards for AI coding chats.",
    "section": "Context visibility and zero-token guards for AI coding chats.",
    "href": "index.html",
    "keywords": "index",
    "body": "Highbeam (`highbeam-cli`) maps your live context window across a 40-cell bar, keeps warm KV caches safe from mistimed model switches, and blocks unsafe shell or file edits before tokens leave your machine."
  },
  {
    "pageTitle": "Context visibility and zero-token guards for AI coding chats.",
    "title": "Context visibility and zero-token guards for AI coding chats.",
    "section": "60-Second Quick Launch",
    "href": "index.html#quick-launch",
    "keywords": "npx highbeam-cli init --all-hosts npx highbeam-cli doctor ah-statusline npx attention-horizon-antigravity init --workspace npx highbeam-cli --serve PreInvocation @ah-flash-scout 127.0.0.1:62935 npx ah-claude install --global npx ah-claude statusline --demo npx ah-claude receipt statusLine ~/.claude/settings.json npx highbeam-cli init --mcp npx highbeam-cli doctor --json @ctxtop/mcp .cursor/mcp.json horizon_status cache_gravity_check scope_lock_claim export_receipt_pdf horizon_compress_cli horizon_search_logs horizon_audit_sessions",
    "body": "Run the installer from your project root to wire hooks, status bars, and sidecar files safely. It backs up your current settings before saving any changes. Dual-Host (Recommended) Google Antigravity Claude Code Cursor & Windsurf MCP Terminal · Dual-Host Setup npx highbeam-cli init --all-hosts npx highbeam-cli doctor Configures Google Antigravity, Claude Code, and supported MCP hosts (Cursor, Windsurf, Codex CLI, Gemini CLI) in one pass."
  },
  {
    "pageTitle": "Context visibility and zero-token guards for AI coding chats.",
    "title": "Context visibility and zero-token guards for AI coding chats.",
    "section": "Core Capabilities",
    "href": "index.html#capabilities",
    "keywords": "100k 200k 1M C* C_max \"ask\" SQLITE_OPEN_READONLY 127.0.0.1",
    "body": "Highbeam swaps guesswork for clear facts: exact token counts, cache hit rates, live cache timers, and fast pre-run safety checks. 40-Cell Context Telemetry See where recall drops before rules are forgotten Plots your active prompt across 40 time-ordered cells with auto-zoom at 100k, 200k, and 1M limits. Spots middle-of-prompt clutter, repeat file reads, and cross-project memory bleed before old rules get cut off. Hig"
  },
  {
    "pageTitle": "Context visibility and zero-token guards for AI coding chats.",
    "title": "Context visibility and zero-token guards for AI coding chats.",
    "section": "Start by Engineering Goal",
    "href": "index.html#choose-your-path",
    "keywords": "OFF SILENT COACH AUTO_PILOT hook_level /compact ctxtop",
    "body": "Set Flight Modes & Levels→ Compare OFF, SILENT, COACH, and AUTO_PILOT modes, Antigravity hook_level cooldowns, and rule overrides. Install & Verify→ Set up Highbeam across Antigravity, Claude Code, or Cursor MCP and check SHA-256 hashes. Follow Hands-On Tutorials→ Walk through prompt checks, Git worktree file locks, log trimming, and clean /compact runs. Compare Host Surfaces→ See how Antigravity sidecar panels and C"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Installation, Verification & Migration",
    "href": "installation.html",
    "keywords": "installation",
    "body": "Highbeam installs cleanly without touching your source code, adding npm dependencies, or asking for API keys. Every config update saves a local backup before writing."
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Prerequisites & Runtime Requirements",
    "href": "installation.html#prerequisites",
    "keywords": ">= 22.13.0 PATH node node --version node:sqlite 22.13+ @ctxtop/engine-node SQLITE_OPEN_READONLY SQLITE_ENABLE_FTS5 src/engine-node/db/probe.mjs USING fts5(...) MATCH CTXTOP_FORCE_NO_SQLITE=1 DET-01 DET-03 DET-31 git merge-tree",
    "body": "Node.js >= 22.13.0: Needed on your system PATH so host hooks can run node directly. Check with node --version. SQLite, FTS5 Polyfill & Fallback: On the supported Node versions (22.13+, with built-in node:sqlite), @ctxtop/engine-node opens session databases with SQLITE_OPEN_READONLY and enables local FTS5 log search. If a Node 22 build lacks SQLITE_ENABLE_FTS5, src/engine-node/db/probe.mj"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Clean Installation Across Surfaces",
    "href": "installation.html#clean-install-by-surface",
    "keywords": "--dry-run settings.json hooks.json",
    "body": "Run --dry-run first if you maintain custom hooks in settings.json or hooks.json."
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "1. Unified Dual-Host Installation",
    "href": "installation.html#install-dual-host",
    "keywords": "highbeam init --all-hosts",
    "body": "Use highbeam init --all-hosts to configure Google Antigravity, Claude Code, and supported MCP hosts (Cursor, Windsurf, Codex CLI, Gemini CLI) in one pass: Preview and Run Unified Installer # Preview planned file paths without writing npx highbeam-cli init --all-hosts --dry-run # Perform non-destructive multi-host installation npx highbeam-cli init --all-hosts"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "2. Google Antigravity Installation",
    "href": "installation.html#install-antigravity",
    "keywords": ".agents/plugins/ ~/.gemini/config/plugins/",
    "body": "Install Highbeam for one workspace (.agents/plugins/) or globally across all projects (~/.gemini/config/plugins/). You can also clone the repo for local work: Google Antigravity Setup Options # Option A: Workspace plugin installation npx attention-horizon-antigravity init --workspace # Option B: Global user installation via ctxtop npx highbeam-cli init --antigravity --global # Option C: Local source checkout & 3-way mirror"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "3. Claude Code Installation (Lean vs. Full Hooks)",
    "href": "installation.html#install-claude-code",
    "keywords": "highbeam install ah-claude install ah-statusline .claude/settings.json ~/.claude/settings.json --global -g .claude-plugin/plugin.json /horizon /cost-radar /inspect /handoff /precheck /evolve hooks/hooks.json highbeam init --claude inspectClaudeBinaryCapabilities() PostModelSwitch omittedUnsupportedHooks",
    "body": "For Claude Code, highbeam install (or ah-claude install) merges hooks and the ah-statusline bar into .claude/settings.json (project scope) or ~/.claude/settings.json (--global / -g). Your existing custom hooks stay untouched: Claude Code Project vs. Global Installation # Recommended: Lean hook profile in global ~/.claude/settings.json npx ah-claude install --global --lean-hooks # Project-local full hook profile (.claud"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "4. Cursor & Windsurf MCP Registration",
    "href": "installation.html#install-mcp",
    "keywords": "@ctxtop/mcp C* # Project-scoped .cursor/mcp.json npx highbeam-cli init --mcp # Global ~/.cursor/mcp.json npx highbeam-cli init --mcp --global",
    "body": "Add @ctxtop/mcp to use Highbeam stats, C* switch checks, and multi-agent Scope Lock Leases in Cursor or Windsurf: Register @ctxtop/mcp in .cursor/mcp.json # Project-scoped .cursor/mcp.json npx highbeam-cli init --mcp # Global ~/.cursor/mcp.json npx highbeam-cli init --mcp --global"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Authentication & OAuth Seat Safety",
    "href": "installation.html#authentication-and-seat-safety",
    "keywords": "~/.gemini/oauth_creds.json gemini:antigravity DET-02 gemini agy \"selectedAuthType\": \"oauth-personal\" 1-2",
    "body": "Highbeam needs zero cloud login or API keys. It never asks for Anthropic, Google Cloud, or OpenAI keys because every rule and score runs locally in JavaScript. Account & OAuth Seat Safety Protocol Highbeam enforces three strict rules across its runtime and tests to prevent automated account lockouts. First, it never reads ~/.gemini/oauth_creds.json or Windows Credential Manager gemini:antigravity secrets (enforced by"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Verification & Health Diagnostics",
    "href": "installation.html#doctor-and-verification",
    "keywords": "highbeam doctor highbeam verify --json claudeCapabilities modelSwitchTelemetry sess_<12hex> npx highbeam-cli doctor --diagnostic",
    "body": "After setup, run highbeam doctor and highbeam verify. They check every manifest, hook contract, Claude binary flag, model rate card, and file checksum. Pass --json to view full claudeCapabilities and scrubbed modelSwitchTelemetry (using one-way SHA-256 sess_<12hex> session hashes): Verify Contracts & Release Checksums $ npx highbeam-cli doctor [Highbeam Doctor] Status: HEALTHY [PASS] node_version: Node.js v22.14.0 (requires >="
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Safe Deduplication, Migration & Uninstallation",
    "href": "installation.html#migration-and-uninstall",
    "keywords": "migrateLegacyHorizonConfig DET-01..DET-32 npx highbeam-cli init --claude --dedupe settings.json npx highbeam-cli doctor --recover-brain --dry-run --dry-run",
    "body": "Upgrading from v3.x (`ga-visualizer` / `agy-horizon` IDs) or moving from project hooks to global hooks takes two quick steps: Legacy Config Migration: migrateLegacyHorizonConfig maps old v3 rule names to v4.0 DET-01..DET-32 IDs automatically. Hook Deduplication: Run npx highbeam-cli init --claude --dedupe to clean out duplicate or old Highbeam entries from settings.json. Your other third-party hooks stay intact. Orphaned A"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Clean Uninstallation",
    "href": "installation.html#clean-uninstall",
    "keywords": "",
    "body": "Remove Hooks and Optional Local Caches # 1. Remove Highbeam hooks & statusLine from Claude Code settings npx highbeam-cli uninstall --global npx highbeam-cli uninstall --project # 2. Optional: remove local telemetry caches and runtime control latches rm -rf ~/.ctxtop ~/.attention-horizon .claude/cache/ah_live_state_*.json .attention-horizon.json"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "MCP Server, HTTP Daemon & Micro-IPC API",
    "href": "mcp-daemon-api.html",
    "keywords": "mcp-daemon-api",
    "body": "Highbeam exposes three local-only APIs: a zero-dependency MCP stdio server for external AI editors, a local HTTP/SSE server for the WebView panel, and a fast Micro-IPC socket (`<15ms`) for warm hook calls."
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "1. MCP Stdio Server (@ctxtop/mcp)",
    "href": "mcp-daemon-api.html#mcp-stdio-server",
    "keywords": "packages/mcp/src/server.mjs ah-mcp ctxtop-mcp 2024-11-05 Content-Length: <bytes>\\r\\n\\r\\n stdin stdout { \"mcpServers\": { \"attention-horizon\": { \"command\": \"npx\", \"args\": [\"-y\", \"--package=ctxtop\", \"ctxtop-mcp\"] } } } @ctxtop/mcp",
    "body": "Built in packages/mcp/src/server.mjs (commands ah-mcp and ctxtop-mcp, protocol 2024-11-05). The server reads both newline-delimited JSON-RPC 2.0 lines and LSP-style Content-Length: <bytes>\\r\\n\\r\\n frames over stdin and stdout. .cursor/mcp.json Registration { \"mcpServers\": { \"attention-horizon\": { \"command\": \"npx\", \"args\": [\"-y\", \"--package=ctxtop\", \"ctxtop-mcp\"] } } }"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "Exposed MCP Tools",
    "href": "mcp-daemon-api.html#mcp-tools-catalog",
    "keywords": "horizon_status cwd?: string sessionId?: string \"default\" { ok, cwd, sessionId, entitlement: { entitled, tier, source }, savedQuota, liveState } cache_gravity_check currentModel: string targetModel: string cachedTokens?: number ttlRemainingSeconds?: number 240 remainingExpectedTurns?: number 1 expectedOutputTokens?: number 1500 C* scope_lock_claim workspaceDir?: string agentId?: string paths?: string[] ttlSeconds?: number 900 paths .agents/locks/active_scopes.json export_receipt_pdf email?: string outPath?: string allowPreview?: boolean false horizon_compress_cli horizon_search_logs horizon_audit_sessions",
    "body": "Tool Name Input Parameters Response Payload horizon_status cache_gravity_check scope_lock_claim export_receipt_pdf horizon_compress_cli horizon_search_logs horizon_audit_sessions cwd?: string, sessionId?: string (default \"default\") Returns { ok, cwd, sessionId, entitlement: { entitled, tier, source }, savedQuota, liveState } from local snapshots."
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "2. Loopback HTTP & SSE Daemon API",
    "href": "mcp-daemon-api.html#http-sse-daemon",
    "keywords": "sidecars/horizon-daemon/server.mjs 127.0.0.1 62935 62945 4,096 400 413",
    "body": "sidecars/horizon-daemon/server.mjs binds only to 127.0.0.1 on port 62935 (trying up to 62945 if busy). It rejects POST bodies over 4,096 bytes with HTTP 400 or 413."
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "Telemetry, Streaming & Export Routes (GET)",
    "href": "mcp-daemon-api.html#daemon-read-routes",
    "keywords": "GET / /index.html /widget /widget.html GET /preload.js GET /api/health GET /api/state GET /api/stream text/event-stream GET /api/cost-radar GET /api/settings safeLimitTokens reminderAtPct modelOverrides GET /api/memory/resume GET /api/receipt/export ?format=pdf GET",
    "body": "Method & Path Description GET /, /index.html, /widget, /widget.html Serves the Highbeam WebView HTML panel. GET /preload.js Serves the local sidecar WebView bridge script. GET /api/health Returns daemon status, PID, active port, and schema version. GET /api/state Returns the 40-cell memory grid, U-curve recall scores, active alerts, and token stats. GET /api/stream Server-Sent Events (text/event-stream) stream that p"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "Hygiene, Rule Fencing & Router Action Routes (POST)",
    "href": "mcp-daemon-api.html#daemon-action-routes",
    "keywords": "POST /api/settings POST /api/prune POST /api/surgeon .bak POST /api/tail/trim POST /api/handoff /api/handoff/generate docs/HANDOFF_<timestamp>.md POST /api/rules/promote POST /api/rules/u-curve-optimize /api/ushape/reorder POST /api/shield/flush PrefixCacheShield force: true POST /api/rsi/evolve /api/instincts/promote /api/rsi/queue-action ReflectorQueue POST /api/router/mode /api/router/actuate /api/router/unlock-hysteresis COACH AUTO_PILOT POST /api/host/reap /api/open-brain /api/hooks/dampen HORIZON_TEST_NO_SPAWN=1 POST /api/checkpoint/evaporation-check /api/export/sanitized /api/savings/receipt /api/license/activate /api/action POST",
    "body": "Method & Path Description POST /api/settings Checks, clamps, and saves updated context window settings. POST /api/prune & POST /api/surgeon Prunes stale context or runs the offline Tool-Output Surgeon after saving a .bak backup. POST /api/tail/trim Scans read-only transcripts, stages uncached tail trims, and logs token savings. POST /api/handoff & /api/handoff/generate Writes a verified handoff Markdown file to docs/"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "3. Micro-IPC Socket Protocol (@ctxtop/engine-node)",
    "href": "mcp-daemon-api.html#micro-ipc-protocol",
    "keywords": "src/engine-node/ipc/protocol.mjs client.mjs server.mjs CTXTOP_IPC_PATH MAX_BUFFER_SIZE_BYTES = 10,485,760 DEFAULT_CONNECT_TIMEOUT_MS = 15 DEFAULT_REQUEST_TIMEOUT_MS = 500 600,000ms PAUSED 15ms CircuitBreakerEngine .ctl -32700 PARSE_ERROR -32600 INVALID_REQUEST -32601 METHOD_NOT_FOUND -32602 INVALID_PARAMS -32603 INTERNAL_ERROR @ctxtop/engine-node",
    "body": "Built in src/engine-node/ipc/protocol.mjs, client.mjs, and server.mjs. Micro-IPC lets short-lived CLI hooks hand checks off to a warm local daemon over a Unix socket (macOS/Linux) or Named Pipe (Windows, custom path via CTXTOP_IPC_PATH). Limits: MAX_BUFFER_SIZE_BYTES = 10,485,760 (10 MB), DEFAULT_CONNECT_TIMEOUT_MS = 15, DEFAULT_REQUEST_TIMEOUT_MS = 500 (raised to 600,000ms while a session is PAUSED). Fail-Safe Fallb"
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Pro Licensing, FinOps & Troubleshooting",
    "href": "pro-troubleshooting.html",
    "keywords": "pro-troubleshooting",
    "body": "Highbeam's core HUD and all 32 guards are MIT-licensed and free forever. Optional Pro and Team plans add offline Ed25519 license keys, PDF 1.4 expense receipts, and local Grafana or Datadog metrics packs."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "1. Three-Tier Entitlement Matrix",
    "href": "pro-troubleshooting.html#tier-matrix",
    "keywords": "npx highbeam-cli tiers src/core/pro_license.mjs $0/mo HOLD_COMPACT GUARD-4 PreToolUse $199 Founder Lifetime $149/yr #tufteBaselineStrip AUTO_PILOT C* $299/yr $15/seat/mo $900/yr 5 seats .agents/rules/ POST /api/export/sanitized highbeam team-pack receipt --share pilot audit",
    "body": "Run npx highbeam-cli tiers anytime to view the plan table from src/core/pro_license.mjs: Tier Pricing Included Capabilities Free MIT Core $0/mo Simple View HUD, 40-cell U-curve map, 5m/1h cache timers, clamp-only auto Active Context Shield, GUARD-4, multi-family FTS5 compression, 32 guards. Pro Solo Dev $199 Founder Lifetime (cap 200) or $149/yr Annual: AUTO_PILOT, C_max holds, encrypted sync, pr-cost, PDF 1.4 receipts. Team: $299/yr Founding 5-Seat Intro; standard $15/seat/mo ($900/yr 5-seat min); Free 60-day Pilot & $1,500-$3,000 Context Audit via sales@highbeamdev.com."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "2. Offline Ed25519 Activation & 14-Day Trial",
    "href": "pro-troubleshooting.html#offline-ed25519-licensing",
    "keywords": "src/core/pro_license.mjs ~/.ctxtop/license.json",
    "body": "Pro and Team keys never call a cloud server. Each key is an Ed25519 token checked locally against the public key in src/core/pro_license.mjs and saved to ~/.ctxtop/license.json: Manage Local Trial, License Token & Receipts # Start a 14-day local Pro evaluation (zero network calls, no credit card) npx highbeam-cli license trial # Activate a signed Ed25519 license token npx highbeam-cli license activate <ed25519-license-token> # Verify en"
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "3. Platform Quirks & Diagnostic Playbook",
    "href": "pro-troubleshooting.html#troubleshooting-playbook",
    "keywords": "npx highbeam-cli doctor",
    "body": "Every issue below has a fast check or a one-line local fix. Run npx highbeam-cli doctor first to check host setup and recent hook logs."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Upstream HTTP 400 on Image / Screenshot Attachments (DET-20 Vision Quirk / DET-28)",
    "href": "pro-troubleshooting.html#quirk-vision-http400",
    "keywords": "400 Bad Request \"Unable to process input image\" DET-20 DET-28 active_scopes.json config/platformQuirks.json",
    "body": "Symptom: Sending a screenshot while Google AI Credit Overages are active fails with HTTP 400 Bad Request (\"Unable to process input image\"). Resolution: Alongside its primary concurrent file-scope lockfile role (.agents/locks/active_scopes.json), DET-20 (configured via config/platformQuirks.json, with the DET-28 quota-overage guard) warns before sending images during AI Credit Overage mode. Send plain text or DOM snippets until Base Quota resets."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Preventing 168-Hour Hybrid Quota Lockouts (DET-16)",
    "href": "pro-troubleshooting.html#quirk-hybrid-lockout",
    "keywords": "168 DET-16 80% 90% 40,000 12",
    "body": "Symptom: Launching many parallel subagents near your quota limit can trigger a 7-day (168-hour) upstream lockout. Resolution: Keep DET-16 on. It caps workers to one at 80% quota use, asks before continuing at 90%, and limits each worker to 40,000 tokens and 12 turns."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Windows PowerShell 5.1 Command Chaining",
    "href": "pro-troubleshooting.html#quirk-powershell-chains",
    "keywords": "&& cmd /c \"node scripts/sync_mirrors.mjs && node bin/ctxtop.mjs verify --json\"",
    "body": "Symptom: Shell commands using && fail with a parser error in Windows PowerShell 5.1. Resolution: Wrap chained commands in cmd /c \"node scripts/sync_mirrors.mjs && node bin/ctxtop.mjs verify --json\", or separate steps with semicolons."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Tool Execution Appears Hung or Frozen",
    "href": "pro-troubleshooting.html#quirk-paused-session",
    "keywords": "PreToolUse Execution halted by control latch PAUSED ABORTED highbeam control",
    "body": "Symptom: Tool calls pause at PreToolUse (up to 10 minutes) or fail right away with Execution halted by control latch. Resolution: Check if the session was set to PAUSED or ABORTED via highbeam control: Inspect and Clear Runtime Control Latch npx highbeam-cli control status --session default npx highbeam-cli control resume --session default # If ABORTED (terminal), remove the session latch file to reset: rm ~/.ctxtop/runtime/defaul"
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Missing node:sqlite / SQLITE_ENABLE_FTS5, Binary Capabilities & Bloated state.vscdb",
    "href": "pro-troubleshooting.html#quirk-sqlite-and-storage",
    "keywords": "SQLITE_ENABLE_FTS5 src/engine-node/db/probe.mjs CTXTOP_FORCE_FTS5_POLYFILL=1 node:sqlite CTXTOP_FORCE_NO_SQLITE=1 highbeam doctor [WARN] claude_pre_model_switch npx highbeam-cli doctor --json CLAUDE_BIN PreModelSwitch PostModelSwitch supportsAskDecision npx highbeam-cli doctor --recover-brain --dry-run --dry-run npx highbeam-cli doctor --gc-cursor --vscdb <path-to-state.vscdb> --dry-run npx highbeam-cli doctor --diagnostic > diagnostic.md state.vscdb",
    "body": "Automatic FTS5 Polyfill (Node 22): If your Node 22 binary lacks SQLITE_ENABLE_FTS5, src/engine-node/db/probe.mjs loads a built-in SQLite table and snippet polyfill automatically. Set CTXTOP_FORCE_FTS5_POLYFILL=1 to test it directly. Force JSONL Mode: Highbeam needs Node 22.13 or newer. If SQLite misbehaves on your build, set CTXTOP_FORCE_NO_SQLITE=1. Highbeam switches cleanly to read-only JSONL offset reads. Claude Binary Capability Warnings: "
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Google Antigravity vs. Claude Code",
    "href": "surfaces.html",
    "keywords": "surfaces",
    "body": "Highbeam runs one shared context engine across Google Antigravity, Claude Code, and MCP editors. Each host uses its fastest local hook path while sharing the same guard rules and file locks on disk."
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Host Capability Matrix",
    "href": "surfaces.html#surface-comparison-matrix",
    "keywords": "@ctxtop/mcp plugin.json .antigravity-plugin/plugin.json .claude-plugin/plugin.json settings.json .cursor/mcp.json .agents/plugins/ ~/.gemini/config/plugins/ .claude/settings.json ~/.claude/settings.json ~0.2ms p95 ah-mcp ctxtop-mcp 127.0.0.1:62935 <agent-embed> ah-statusline SQLITE_OPEN_READONLY conversations/*.db statusLine .claude/cache/ah_live_state_<id>.json @ah-flash-scout <200 /browser /swarm inherit|branch|share Task Agent DET-19 scope_lock_claim",
    "body": "Dimension Google Antigravity Claude Code Cursor / Windsurf (@ctxtop/mcp) Manifest Root plugin.json & .antigravity-plugin/plugin.json .claude-plugin/plugin.json & settings.json .cursor/mcp.json (stdio JSON-RPC 2.0) Install Locations .agents/plugins/ (workspace) or ~/.gemini/config/plugins/ (global) .claude/settings.json (project) or ~/.claude/settings.json (global) .cursor/mcp.json or global MCP config Execution Path "
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Google Antigravity Surface Architecture",
    "href": "surfaces.html#google-antigravity-integration",
    "keywords": "agy attention-horizon-antigravity agy-horizon-flightcheck",
    "body": "Inside Google Antigravity (App, IDE, and agy CLI), Highbeam runs as a sidecar plugin under attention-horizon-antigravity (and workspace mirror agy-horizon-flightcheck)."
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Sidecar Daemon & Simple / Advanced WebView",
    "href": "surfaces.html#antigravity-sidecar-and-ui",
    "keywords": "sidecars/horizon-daemon/sidecar.json node --no-warnings server.mjs 62935 62935..62945 SIDECAR_UI_ENTRYPOINT_AUX_PANE sidecar://agy-horizon-flightcheck/horizon-daemon/ npx highbeam-cli --serve #argonSimpleSurface #argonAdvancedSurface 360px test/top10_token_wasters_ui.test.mjs #tsBarSignal #tsBarClutter #tsStatusLabel DO AVOID MODEL EFFORT #tsDoText #tsAvoidText #tsModelCard #tsEffortCard /compact #tsWhyClears #tsWhyList #tsWhyTotal #btnCompactPrimary #btnCopyParameterizedCompact #compactInstruction #compactReclaim #tsBtnCleanPrimary #taConsumersBody Ignore file .antigravityignore isIgnorablePath Active Source ~/.gemini/config/plugins/agy-horizon agy-horizon-flightcheck node scripts/sync_mirrors.mjs horizon_panel.html src/core/*.mjs",
    "body": "sidecars/horizon-daemon/sidecar.json starts node --no-warnings server.mjs on local port 62935 (trying 62935..62945 if busy). It mounts straight into Antigravity's side pane via SIDECAR_UI_ENTRYPOINT_AUX_PANE. You can also open it from chat via the sidecar://agy-horizon-flightcheck/horizon-daemon/ pill or run npx highbeam-cli --serve in a browser. The panel offers a clean Simple View (#argonSimpleSurface) and a full Advance"
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Subagents, /browser, /swarm & Workspace Modes",
    "href": "surfaces.html#antigravity-subagents-and-modes",
    "keywords": "@ah-flash-scout agents/ah-flash-scout.md model: flash commandExecutionPolicy: off view_file grep_search find_by_name list_dir File:StartLine-EndLine 200 /browser browser_sandbox/ /swarm inherit share branch",
    "body": "Antigravity includes built-in multi-agent tools that Highbeam tracks and guards: Delegation Scout (@ah-flash-scout): Set in agents/ah-flash-scout.md with model: flash, commandExecutionPolicy: off, and read-only search tools (view_file, grep_search, find_by_name, list_dir). It returns short File:StartLine-EndLine hits in under 200 tokens so your main model skips raw grep noise. /browser Isolation: Live web checks run "
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Claude Code Dual-Tier Architecture",
    "href": "surfaces.html#claude-code-integration",
    "keywords": "",
    "body": "Highbeam ships two hook paths for Claude Code. Today only the command hooks (Tier-2) run: Claude Code 2.1.325 has no hooks.modules setting, so the in-process module (Tier-1) is not loaded. Claude Code in-process module (not loaded today) and command hook architecture Tier-1: In-Process Module (not loaded) hooks/register.js (dormant) on('tool.call') / on('turn.step') on('command.horizon') / ui.render Zero node:* imports (Mod Laws 1-5) Would set AH_TIER1_MOD_ACTIVE=1 Tier-2: Spawned CLI Handlers "
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Responsive Single-Line ah-statusline Tiers",
    "href": "surfaces.html#responsive-statusline",
    "keywords": "bin/ah-statusline.mjs statusLine .claude/cache/ah_live_state_<sessionId>.json hostCapabilities PreModelSwitch inspectClaudeBinaryCapabilities() --columns <N> AH_COLUMNS ah-statusline",
    "body": "In Claude Code, bin/ah-statusline.mjs reads Claude Code's statusLine JSON after each turn. It saves a snapshot to .claude/cache/ah_live_state_<sessionId>.json (with cached hostCapabilities and any PreModelSwitch binary notes from inspectClaudeBinaryCapabilities()). Then it prints a one-line ANSI bar sized to your terminal width (set via --columns <N> or AH_COLUMNS): Claude Code StatusLine Layout Tiers (80 / 110 / 144"
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Side-by-Side Workflow Switcher",
    "href": "surfaces.html#workflow-equivalence",
    "keywords": "",
    "body": "Select a host below to see the exact command sequence for common daily tasks: Google Antigravity Claude Code Google Antigravity Chat & Terminal Workflow # 1. Inspect 40-cell window as an embedded Studio widget /horizon # 2. Score a complex refactor prompt before spending frontier quota #check Refactor src/core/classifier.mjs to extract span categorization # 3. Delegate fast file discovery to Gemini Flash (<200 tokens"
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Guided Step-by-Step Tutorials",
    "href": "tutorials.html",
    "keywords": "tutorials",
    "body": "Each guide below walks through a real coding workflow from setup to check. Every command runs locally with zero network calls."
  },
  {
    "pageTitle": "144-Run Empirical Benchmark",
    "title": "Does Compressing Tool Output Actually Lower AI Coding Bills?",
    "section": "144 Live Runs on Claude Code (Wins, Losses, and Cache Math)",
    "href": "benchmark.html",
    "keywords": "benchmark -13.31% -24.31% 72 live runs T01-T08 T09-T11 null result ah-haiku-scout 45-run model-switch Opus Sonnet 3-bucket avoidedWrites realizedPromptBill platformCacheDiscount FTS5 96%",
    "body": "Across 72 replicated live Claude Code runs (T01-T08, sonnet-5.5), Highbeam reduced mean billed cost by -13.31% ($4.8174 vs $5.5569; -14.39% median paired delta) and prompt-bill tokens by -24.31% (6,847,992 vs 9,047,750), winning 20/24 runs and 7/8 tasks while losing T06 (+13.43%). In 27 pure code-exploration runs (T09-T11), Shield triggered 0/27 times (+6.88% / +14.08% variance), proving scope boundaries honestly."
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 1: First Setup, Live HUD & Prompt Precheck",
    "href": "tutorials.html#tutorial-1-first-task",
    "keywords": "doctor #check /precheck $ npx highbeam-cli receipt --markdown",
    "body": "Goal: Set up Highbeam in a repo, preview the status bar, test a vague prompt before spending high-effort tokens, and print a savings receipt. Set up the project and run health checks Run the unified installer from your repo root. Then run doctor to make sure all checks pass. Step 1 · Input & Expected Output $ npx highbeam-cli init --all-hosts ⚡ Highbeam (highbeam-cli v4.4.1) - Zero-Config Unified Installer [PASS] Claude Code hooks merged"
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 2: Parallel Delegation on Git Worktrees with Scope Locks",
    "href": "tutorials.html#tutorial-2-parallel-worktrees",
    "keywords": "DET-20 DET-31 workspace: \"share\" git worktree add ../repo-auth-slice -b feat/auth-slice git worktree list src/core/pro_license.mjs scope_lock_claim PreToolUse .agents/locks/active_scopes.json git merge-tree cost-radar",
    "body": "Goal: Run two agents at once across Git worktrees without clobbering files or hitting silent merge clashes, backed by DET-20, DET-31, and Cost Radar. Create a separate Git worktree for Worker B When running parallel edits (like Antigravity's workspace: \"share\" mode), add a branch worktree so each agent builds and tests on its own: Step 1 · Create Feature Worktree git worktree add ../repo-auth-slice -b feat/auth-slice"
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 3: Auditing Failed Runs, Stepping Execution & Surgical Pruning",
    "href": "tutorials.html#tutorial-3-debugging-and-pruning",
    "keywords": "DET-04 highbeam control CONTEXT_ROT_DECAY VERIFICATION_CHURN --prune-tools --dry-run --dry-run .bak",
    "body": "Goal: Pause a stuck test loop, step through one tool call at a time, check recent chats for waste, and trim old tool outputs with a backup. Pause and single-step a live agent chat If an agent loops on failing tests (nearing the DET-04 3-strike limit), pause it from a second terminal with highbeam control: Step 1 · Pause, Step Once, and Resume # Suspend at the next PreToolUse boundary (writes ~/.ctxtop/runtime/default.c"
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 4: Zero-Loss Compaction & Cross-Model Spec Relay",
    "href": "tutorials.html#tutorial-4-compaction-and-relay",
    "keywords": "/compact HOLD_COMPACT $ npx highbeam-cli receipt --simple /handoff Next Action Blockers Decisions git status --porcelain $ npx highbeam-cli doctor --handoff ✔ PASS Handoff Distillation Generated handoff document at docs/HANDOFF_2026-11-12.md TurnZeroGate 00:00 amputation_token_threshold #btnCompactPrimary PrefixCacheShield PostCompact /relay S0 S1 T <30 Defer",
    "body": "Goal: Pack a deep 135k-token chat into a clean State Baton without wasting a warm cache, and build a short Cold Critic Packet for spec reviews. Check your cache timer before compacting Running /compact while 50k+ tokens are still warm inside a 5-minute window throws away cheap cache reads (HOLD_COMPACT). Check your timer first: Step 1 · Inspect TTL & Saved Quota $ npx highbeam-cli receipt --simple Build and check the State"
  }
];
