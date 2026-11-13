/* Auto-generated offline search index for Highbeam User Guide (116 entries) */
window.AH_SEARCH_INDEX = [
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "System Architecture & Internals",
    "href": "architecture.html",
    "keywords": "architecture",
    "body": "Highbeam is organized as a zero-dependency six-package monorepo separating pure isomorphic context physics from Node.js storage engines and host-specific adapters."
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "1. Six-Package Workspace Topology",
    "href": "architecture.html#monorepo-topology",
    "keywords": "package.json packages/* src/core-isomorphic/ src/engine-node/ src/core/ @ctxtop/core node:* DET-01..DET-32 CircuitBreakerEngine cacheGravity dualTtl cliffBreaker horizonGrid costRadarSvg modViews @ctxtop/engine-node >= 20.0.0 node:sqlite git merge-tree @ctxtop/antigravity >= 20.0.0 PreInvocation horizon_panel.html @ctxtop/claude-code hooks/register.js",
    "body": "Root package.json declares six workspaces under packages/* backed by shared source trees in src/core-isomorphic/ , src/engine-node/ , and src/core/ : Workspace Package Runtime Constraint Core Modules @ctxtop/core Pure ESM, zero node:* imports DET-01..DET-32 catalog, CircuitBreakerEngine , cacheGravity , dualTtl , cliffBreaker , horizonGrid , costRadarSvg , modViews , USTF v1 normalizer. @ctxtop/engine-node Node.js >="
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "2. Claude Mod Laws 1-5 & Pure-JS Cryptography",
    "href": "architecture.html#isomorphic-laws",
    "keywords": "src/core-isomorphic/ test/mod_static_compliance.test.mjs node:* node:fs node:path node:crypto node:child_process Buffer process globalThis fnv1a64.mjs sha256HexPure evaluatePreToolUse computeBreakEven ~0.18ms p95",
    "body": "Because Claude Code's Tier-1 Mod isolate executes inside a sandboxed V8 context without Node.js built-ins, every module inside src/core-isomorphic/ obeys five statically tested laws (verified in test/mod_static_compliance.test.mjs ): Zero node:* Imports: No node:fs , node:path , node:crypto , or node:child_process imports anywhere in the isomorphic graph. Zero Unguarded Node Globals: Never references bare Buffer or p"
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "3. Lossless FTS5 CLI Output Compressor",
    "href": "architecture.html#fts5-compressor",
    "keywords": "src/core/fts5_output_compressor.mjs src/shims/agy_cli_compressor.mjs DET-07 \\r 4,096 cargo test npm install .ctxtop/cache/artifacts/ah_<sha256>.txt .ctxtop/cache/artifacts_fts5.db agy-horizon log-search \"<query>\"",
    "body": "Verbose test suites and package installs routinely emit 50,000+ characters of progress bars and passing test noise. Implemented in src/core/fts5_output_compressor.mjs and src/shims/agy_cli_compressor.mjs ( DET-07 ), the offloader processes shell output in four stages: ANSI & Carriage-Return Scrubbing: Strips terminal color sequences and collapses \\r spinner overwrites before evaluating the 4,096 -character compressio"
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "4. PrefixCacheShield & TurnZeroGate Fencing",
    "href": "architecture.html#turn-zero-gate",
    "keywords": "AGENTS.md CLAUDE.md PrefixCacheShield TurnZeroGate",
    "body": "Editing AGENTS.md , CLAUDE.md , or `.agents/rules/*.md` mid-session mutates Cell 1 of the prompt prefix, invalidating every warm cached token behind it. PrefixCacheShield and TurnZeroGate eliminate mid-session cache rebuilds by staging rule updates until a natural cold-cache boundary arrives:"
  },
  {
    "pageTitle": "System Architecture & Internals",
    "title": "System Architecture & Internals",
    "section": "5. USTF v1 & 3-Way SHA-256 Mirror Parity",
    "href": "architecture.html#ustf-and-mirror-parity",
    "keywords": "src/core-isomorphic/ustf/ version: \"1.0.0\" sessionId harness modelId usage: { uncached, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking, costUSD } events spans node scripts/sync_mirrors.mjs node scripts/generate_checksums.mjs node bin/ctxtop.mjs verify --json",
    "body": "USTF v1 ( src/core-isomorphic/ustf/ ): Normalizes heterogeneous Antigravity SQLite/JSONL steps and Claude Code event streams into a single schema ( version: \"1.0.0\" , sessionId , harness , modelId , usage: { uncached, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking, costUSD } , events , spans ). Release & Mirror Parity Pipeline: Whenever core or WebView files change, contributors run node scripts/sync_mirrors"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "CLI & Binaries Reference",
    "href": "cli-reference.html",
    "keywords": "cli-reference",
    "body": "Highbeam registers 12 CLI binary entrypoints and 3 execution shims across four runtime targets. Every subcommand below is documented directly from bin/ctxtop.mjs , bin/ah-statusline.mjs , and src/cli/*.mjs ."
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "Package Binaries & Entrypoints",
    "href": "cli-reference.html#package-binaries",
    "keywords": "ctxtop ah attention-horizon ah-claude attention-horizon-claude ./bin/ctxtop.mjs ah-statusline ./bin/ah-statusline.mjs statusLine 80 110 144 attention-horizon-antigravity ah-antigravity agy-horizon agy-horizon-flightcheck ./src/cli/init.mjs --serve --demo-animate exec log-search ah-mcp ctxtop-mcp ./packages/mcp/src/server.mjs",
    "body": "Binary Name(s) Target Script Primary Purpose ctxtop , ah , attention-horizon , ah-claude , attention-horizon-claude ./bin/ctxtop.mjs Unified cross-platform CLI dispatcher for installation, receipts, Cost Radar, configuration, runtime control, inspection, and Pro licensing. ah-statusline ./bin/ah-statusline.mjs Standalone Claude Code statusLine stdin JSON bridge rendering 80 , 110 , or 144 -column ANSI telemetry bars."
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
    "section": "ctxtop init",
    "href": "cli-reference.html#cmd-init",
    "keywords": "ctxtop init [--antigravity] [--claude] [--mcp | --cursor | --windsurf] [--all] [--global | -g | --workspace | --project] [--lean-hooks | --full-hooks] [--dry-run] [--dedupe] [--json] --antigravity --claude ah-statusline settings.json --mcp --cursor --windsurf attention-horizon .cursor/mcp.json ~/.cursor/mcp.json --global --all -a --lean-hooks --full-hooks --dry-run --dedupe",
    "body": "Non-destructively installs Highbeam across one or more host environments. Synopsis ctxtop init [--antigravity] [--claude] [--mcp | --cursor | --windsurf] [--all] [--global | -g | --workspace | --project] [--lean-hooks | --full-hooks] [--dry-run] [--dedupe] [--json] --antigravity : Installs Google Antigravity plugin manifests, rules, skills, and sidecar hooks. --claude : Merges Claude Code lifecycle hooks and"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop install & ctxtop uninstall",
    "href": "cli-reference.html#cmd-install-uninstall",
    "keywords": "settings.json ctxtop install [--global | -g | --project] [--lean-hooks | --full-hooks] [--json] ctxtop uninstall [--global | -g | --project] [--json] --project <cwd>/.claude/settings.json --global",
    "body": "Targeted installer and uninstaller for Claude Code settings.json files, creating a timestamped backup on merge. Synopsis ctxtop install [--global | -g | --project] [--lean-hooks | --full-hooks] [--json] ctxtop uninstall [--global | -g | --project] [--json] Defaults to --project ( <cwd>/.claude/settings.json ) when --global is omitted."
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop doctor & ctxtop prune",
    "href": "cli-reference.html#cmd-doctor",
    "keywords": "ctxtop doctor [--diagnostic | --bug-report] [--json] [--prune-tools | --prune | --uncached-tail | --tail] [--transcript <path>] [--reap-orphans] [--handoff | --distill] [--storage-gc | --gc-cursor | --recover-brain] [--vscdb <path>] [--dry-run] --diagnostic --bug-report --json --prune-tools --uncached-tail agy-horizon prune --transcript <path> .bak --reap-orphans --handoff --distill docs/ --recover-brain --gc-cursor --vscdb <path> state.vscdb --dry-run",
    "body": "Validates host contracts, model catalogs, hook error logs, and performs optional offline maintenance and surgical pruning. Synopsis ctxtop doctor [--diagnostic | --bug-report] [--json] [--prune-tools | --prune | --uncached-tail | --tail] [--transcript <path>] [--reap-orphans] [--handoff | --distill] [--storage-gc | --gc-cursor | --recover-brain] [--vscdb <path>] [--dry-run] --diagnostic / --bug-report : Emits a zero-"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop verify (alias: verify-checksums )",
    "href": "cli-reference.html#cmd-verify",
    "keywords": "CHECKSUMS.sha256 0 ctxtop verify [--json]",
    "body": "Computes pure-JS SHA-256 hashes (CRLF-normalized) for every release file listed in CHECKSUMS.sha256 and exits 0 when zero mismatches exist. Synopsis ctxtop verify [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop receipt",
    "href": "cli-reference.html#cmd-receipt",
    "keywords": "ctxtop receipt [--simple | --4-rank | --advanced] [--markdown | --md | --git | --html | --pdf | --json] [--out <path>] --pdf 2 ctxtop pro trial",
    "body": "Renders the verified Tokens & USD Saved receipt in terminal text, Git-commit Markdown, standalone HTML, JSON, or Pro SHA-256 PDF 1.4 format. Synopsis ctxtop receipt [--simple | --4-rank | --advanced] [--markdown | --md | --git | --html | --pdf | --json] [--out <path>] Note: Passing --pdf on the Free tier exits with code 2 and displays your 30-day shadow USD savings alongside local trial instructions ( ctxtop pro tria"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop panel",
    "href": "cli-reference.html#cmd-panel",
    "keywords": "~/.claude/attention-horizon/horizon_panel.html ctxtop panel [--advanced] [--out <file.html>] [--json]",
    "body": "Writes a self-contained, zero-socket Claude Code HTML HUD snapshot (default output: ~/.claude/attention-horizon/horizon_panel.html ). Synopsis ctxtop panel [--advanced] [--out <file.html>] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop cost-radar (alias: radar )",
    "href": "cli-reference.html#cmd-cost-radar",
    "keywords": "~/.claude/attention-horizon/cost_radar.html ctxtop cost-radar [--out <file.html>] [--demo] [--share] [--json]",
    "body": "Writes a script-free HTML/SVG timeline showing per-turn prefix-cache retention, thinking-token drift, and Git worktree swarm topology (default output: ~/.claude/attention-horizon/cost_radar.html ). Synopsis ctxtop cost-radar [--out <file.html>] [--demo] [--share] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop statusline & ah-statusline",
    "href": "cli-reference.html#cmd-statusline",
    "keywords": "statusLine stdin 1,500ms .claude/cache/ah_live_state_<sessionId>.json ah-statusline [--demo] [--columns <N> | --cols <N>]",
    "body": "Reads Claude Code's statusLine JSON payload from stdin ( 1,500ms bounded timeout), updates .claude/cache/ah_live_state_<sessionId>.json , and prints a responsive single-line ANSI bar. Synopsis ah-statusline [--demo] [--columns <N> | --cols <N>]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop postmortem & ctxtop roast",
    "href": "cli-reference.html#cmd-postmortem-roast",
    "keywords": "CONTEXT_ROT_DECAY VERIFICATION_CHURN SPEC_AMBIGUITY CLEAN ctxtop postmortem [--last <N>] [--roast] [--demo] [--json] ctxtop roast [--demo] [--markdown | --md] [--json] --last 15 session_analysis_report.md conversation_diagnostics.jsonl writeFiles",
    "body": "Scans recent local sessions to classify failure archetypes ( CONTEXT_ROT_DECAY , VERIFICATION_CHURN , SPEC_AMBIGUITY , CLEAN ), identify top duplicate-read files, audit Turn-0 MCP overhead, and emit shareable ASCII or Markdown forensic summaries. Synopsis ctxtop postmortem [--last <N>] [--roast] [--demo] [--json] ctxtop roast [--demo] [--markdown | --md] [--json] --last defaults to 15 sessions. Writes session_analysi"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop inspect",
    "href": "cli-reference.html#cmd-inspect",
    "keywords": "ctxtop inspect [<session-id> | --session <id> | --last] [--out <file.json>] [--json]",
    "body": "Normalizes any Claude Code live snapshot, USTF v1 log, or Antigravity brain directory into a USTF v1 trajectory with event counts, span trees, cached vs. uncached tokens, and USD cost. Synopsis ctxtop inspect [<session-id> | --session <id> | --last] [--out <file.json>] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "Antigravity Server, Demos & FTS5 Execution Wrappers",
    "href": "cli-reference.html#cmd-ui-demo-exec",
    "keywords": "agy-horizon src/cli/init.mjs src/cli/horizon_hud.mjs # Start loopback HTTP/SSE daemon on 127.0.0.1:62935..62945 agy-horizon ui [--open | --no-open] [--demo] ctxtop --serve # Run 5-stage synthetic terminal crisis showcase or emit Studio HTML widget agy-horizon demo [--demo-animate] [--scenario <1..5>] [--harness <antigravity|claude-code>] node src/cli/horizon_hud.mjs --emit-widget # Execute a verbose shell command through the lossless FTS5 compressor (>4,096 chars archived) agy-horizon exec <command...> # Query archived FTS5 CLI logs by keyword across turns agy-horizon log-search \"<fts5-query>\"",
    "body": "Invoked via agy-horizon ( src/cli/init.mjs ) or src/cli/horizon_hud.mjs : Synopsis # Start loopback HTTP/SSE daemon on 127.0.0.1:62935..62945 agy-horizon ui [--open | --no-open] [--demo] ctxtop --serve # Run 5-stage synthetic terminal crisis showcase or emit Studio HTML widget agy-horizon demo [--demo-animate] [--scenario <1..5>] [--harness <antigravity|claude-code>] node src/cli/horizon_hud.mjs --emit-widget # Execu"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop config",
    "href": "cli-reference.html#cmd-config",
    "keywords": ".attention-horizon.json ~/.attention-horizon/config.json --global ctxtop config [list] [--global | -g] [--json] ctxtop config set <DET-01..DET-20 | habit-slug> <default | off | warn | block> [--global | -g] ctxtop config reset [--global | -g]",
    "body": "Lists, sets, or resets per-detector overrides in .attention-horizon.json (project default) or ~/.attention-horizon/config.json ( --global ). Synopsis ctxtop config [list] [--global | -g] [--json] ctxtop config set <DET-01..DET-20 | habit-slug> <default | off | warn | block> [--global | -g] ctxtop config reset [--global | -g]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop control",
    "href": "cli-reference.html#cmd-control",
    "keywords": "~/.ctxtop/runtime/<sessionId>.ctl control.transition ctxtop control <status | pause | resume | step | abort | rewind> [--session <id>] [--target <turn> | --turn <turn>] abort ABORTED .ctl",
    "body": "Transitions the 5-state Runtime Control FSM at ~/.ctxtop/runtime/<sessionId>.ctl and notifies any warm Micro-IPC daemon via control.transition . Synopsis ctxtop control <status | pause | resume | step | abort | rewind> [--session <id>] [--target <turn> | --turn <turn>] Note: abort transitions the session into terminal ABORTED state, which cannot be resumed without starting a new session or clearing the .ctl file."
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "ctxtop license ( pro ), tiers & team-pack",
    "href": "cli-reference.html#cmd-pro-team",
    "keywords": "ctxtop tiers [--json] ctxtop pro [status | tiers | trial | activate <ed25519-token> | deactivate] [--json] ctxtop team-pack [--out <dir>] [--org \"<Org Name>\"] [--preview] [--json]",
    "body": "Manages offline Ed25519 Pro licenses, 14-day local trials, and BYO-Grafana / Datadog OpenTelemetry bundles. Synopsis ctxtop tiers [--json] ctxtop pro [status | tiers | trial | activate <ed25519-token> | deactivate] [--json] ctxtop team-pack [--out <dir>] [--org \"<Org Name>\"] [--preview] [--json]"
  },
  {
    "pageTitle": "CLI & Binaries Reference",
    "title": "CLI & Binaries Reference",
    "section": "Execution Shims & Standard Exit Codes",
    "href": "cli-reference.html#shims-and-exit-codes",
    "keywords": "src/shims/ src/shims/agy_cli_compressor.mjs AGY_CONVERSATION_ID src/shims/agy_git_guard.mjs DET-01 src/shims/ah_log_query.mjs .ctxtop/cache/artifacts_fts5.db 0 allow deny ask stdout 1 2 stderr stdout ctxtop receipt --pdf ctxtop team-pack --preview",
    "body": "Three standalone shims inside src/shims/ support direct shell integration: src/shims/agy_cli_compressor.mjs : Standalone ANSI/carriage-return scrubber and SQLite FTS5 output archiver honoring AGY_CONVERSATION_ID . src/shims/agy_git_guard.mjs : Standalone option-argument-aware git and shell command validator backing DET-01 . src/shims/ah_log_query.mjs : Lightweight FTS5 full-text reader for retrieving offloaded lines "
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "Slash Commands, Skills & Subagents",
    "href": "commands-skills.html",
    "keywords": "commands-skills",
    "body": "Highbeam exposes interactive slash commands in Claude Code ( commands/*.md ), structured skills in Google Antigravity ( skills/*/SKILL.md ), single-character prompt control prefixes, and a dedicated Gemini Flash scout subagent."
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "Slash Commands & Skills Catalog",
    "href": "commands-skills.html#slash-commands-overview",
    "keywords": "/horizon commands/horizon.md command.horizon skills/horizon/SKILL.md <agent-embed> /precheck commands/precheck.md skills/precheck/SKILL.md C* /handoff commands/handoff.md skills/handoff/SKILL.md task.md HANDOFF_LATEST.md /compact /cost-radar commands/cost-radar.md skills/cost-radar/SKILL.md /inspect commands/inspect.md skills/inspect/SKILL.md /evolve commands/evolve.md skills/evolve/SKILL.md AGENTS.md",
    "body": "Command / Skill Claude Code Source Antigravity Source Primary Deliverable /horizon commands/horizon.md & command.horizon skills/horizon/SKILL.md 40-Cell Horizon HUD, Simple 4-Rank Verdict Bar or 5-Section Advanced Workbench, and <agent-embed> card. /precheck commands/precheck.md skills/precheck/SKILL.md Prompt anchoring evaluation, active C* cache gravity check, model/effort routing, and 4-Line Scorecard rewrite. /ha"
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
    "keywords": "attention-horizon advanced npx ah-claude receipt npx ah-claude panel --json node --no-warnings ./src/cli/horizon_hud.mjs --emit-widget <artifactDirectoryPath>/horizon_widget.html <agent-embed> sidecar://agy-horizon-flightcheck/horizon-daemon/",
    "body": "Displays your current context window health without mutating any workspace files. In Claude Code: Opens the docked attention-horizon pane when the Tier-1 V8 Mod is active (pass advanced for the 5-section workbench), or executes npx ah-claude receipt / npx ah-claude panel --json . In Google Antigravity: Executes node --no-warnings ./src/cli/horizon_hud.mjs --emit-widget to write <artifactDirectoryPath>/horizon_widget."
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "2. /precheck & The 8-State Decision Rubric",
    "href": "commands-skills.html#slash-precheck",
    "keywords": "/precheck ~/.gemini/flightcheck/sessions/<conversationId>.sidecar.json 2ms ALLOW_SILENT ! !force ALLOW_ACTIVE_SET ACTIVE_SET ALLOW_PLAN_OR_SUBAGENT /plan invoke_subagent INJECT_CONTEXT_GUARD DIRTY_SNAP UNSEEN_CALLERS LEGACY_POISON STEER_SUBAGENT >25,000 >70% invoke_subagent @ah-flash-scout HALT_HYGIENE_OR_SAFETY advisory >140,000 45% HALT_EFFORT_OR_QUOTA",
    "body": "Evaluates draft prompts and active session physics before spending high-effort frontier quota. In Antigravity, /precheck reads ~/.gemini/flightcheck/sessions/<conversationId>.sidecar.json in under 2ms and classifies the turn into one of eight deterministic router states: ALLOW_SILENT : Prompt is well-anchored, healthy, or carries a ! / !force one-turn bypass prefix. ALLOW_ACTIVE_SET : Explicit file paths were omitted"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "3. /handoff & State Compressor Taxonomy",
    "href": "commands-skills.html#slash-handoff",
    "keywords": "Decisions Blockers Low | Medium | High Artifacts State Changes Next Action @file \"Continue working\" \"WIP\"",
    "body": "Audits and writes a lossless State Baton before context compaction or cross-session rotation. Enforces a strict KEEP / DROP filter and a 5-point verification checklist: KEEP: Architectural Decisions (with 1-sentence rationale), active Blockers (with Low | Medium | High severity), explicit modified file Artifacts , verified milestone State Changes , and one concrete unblocked Next Action naming an exact @file or symbo"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "4. /cost-radar",
    "href": "commands-skills.html#slash-cost-radar",
    "keywords": "retention drift swarm loopTriggered true DET-30 DET-21 --",
    "body": "Generates a self-contained HTML/SVG timeline summarizing session spend in at most three lines using JSON fields retention , drift , and swarm . When loopTriggered is true , the summary leads immediately with a scratchpad-loop alert ( DET-30 , aliased as DET-21 in legacy Claude commands) and recommends anchoring a concrete target file + acceptance test or stepping reasoning effort down. Unmeasured metrics always displ"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "5. /inspect",
    "href": "commands-skills.html#slash-inspect",
    "keywords": "ctxtop inspect --last .claude/cache/ah_live_state_<sessionId>.json ~/.ctxtop/sessions/<sessionId>.jsonl brain/<sessionId>",
    "body": "Runs ctxtop inspect --last to inspect execution spans, tool latencies, and swarm topology. Resolution checks three local stores in order: (1) .claude/cache/ah_live_state_<sessionId>.json , (2) ~/.ctxtop/sessions/<sessionId>.jsonl , and (3) Antigravity's local brain/<sessionId> directory."
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "6. /evolve ( RSI-01 Prefix Diet & Skill Evolution)",
    "href": "commands-skills.html#slash-evolve",
    "keywords": "AGENTS.md CLAUDE.md .agents/rules/*.md 8,000 SKILL.md SKILL.md >= 5 confidence >= 0.55 harmful_count == 0 TurnZeroGate 0s",
    "body": "Keeps Turn-0 static rule files lean while preserving validated domain lessons: 8,000-Token Static Prefix Budget: Audits AGENTS.md / CLAUDE.md and .agents/rules/*.md . When static rules exceed 8,000 tokens, proposes extracting domain sections into lazy-loaded SKILL.md bundles. Skill Fault Delta Routing: Routes post-skill user corrections directly to the offending skill's SKILL.md rather than inflating global rules. 5-"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "7. /relay (Asymmetric Cross-Model Spec Relay)",
    "href": "commands-skills.html#slash-relay",
    "keywords": "relay-breaker S0 S1 T <30 Defer",
    "body": "Prevents quadratic context bloat when iterating on specifications across multiple frontier models (automatically recommended when relay-breaker detects Round 2+ spec churn). Assigns the local session as the Stateful Spec Owner (editing the canonical Markdown spec on disk) and external models as stateless Cold Critics , triaging feedback into S0 (Blocker), S1 (Major Flaw), T (Testable Runtime Question settled via a <3"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "In-Chat Prompt Control Prefixes",
    "href": "commands-skills.html#in-chat-control-flags",
    "keywords": "! !force ! Run full integration suite PreInvocation ALLOW_SILENT PreToolUse !lock !lock Implement B-tree cursor split #check #check Migrate auth middleware",
    "body": "Prefix Example Runtime Effect ! or !force ! Run full integration suite Bypasses PreInvocation coaching and router halts for the current turn ( ALLOW_SILENT ). Ring-0 destructive shell/secret guards remain enforced at PreToolUse . !lock !lock Implement B-tree cursor split Locks your active model and reasoning effort tier for the remainder of the conversation so automatic downshift advisories stay silent. #check #check"
  },
  {
    "pageTitle": "Slash Commands, Skills & Subagents",
    "title": "Slash Commands, Skills & Subagents",
    "section": "Delegation Scout Subagent ( @ah-flash-scout )",
    "href": "commands-skills.html#delegation-scout-subagent",
    "keywords": "agents/ah-flash-scout.md @ah-flash-scout gemini-4-carbon gemini-4-argon name: ah-flash-scout model: flash mainAgent: false subagent: true excludeDefaultComponents: true commandExecutionPolicy: off tools: [view_file, grep_search, find_by_name, list_dir] @ah-flash-scout 200 path/to/file.mjs:L10-L42 - Symbol / invariant summary",
    "body": "Defined in agents/ah-flash-scout.md , @ah-flash-scout protects warm frontier sessions ( gemini-4-carbon , gemini-4-argon ) from ingesting multi-thousand-token search dumps during codebase discovery: agents/ah-flash-scout.md Manifest Contract name: ah-flash-scout model: flash mainAgent: false subagent: true excludeDefaultComponents: true commandExecutionPolicy: off tools: [view_file, grep_search, find_by_name, list_di"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Core Concepts & Mental Model",
    "href": "concepts.html",
    "keywords": "concepts",
    "body": "Highbeam treats an AI coding session as a bounded memory system governed by attention recall geometry and prompt-cache economics. Understanding four foundational mechanisms explains every warning, metric, and guardrail in the product."
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Why Highbeam Exists",
    "href": "concepts.html#why-attention-horizon-exists",
    "keywords": "200k 1M AGENTS.md CLAUDE.md 1.25x",
    "body": "Long coding trajectories fail quietly long before they hit a nominal 200k or 1M context limit. Three compounding failure modes degrade agent reliability and inflate API spend: Middle-Window Recall Decay: Transformer attention follows a parabolic curve. System rules at Turn 0 (Primacy) and the most recent tool outputs (Recency) retain strong recall, whereas files and instructions buried in the middle of a session suff"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "The 40-Cell Horizon Bar & U-Shaped Recall",
    "href": "concepts.html#u-shaped-recall-and-40-cell-bar",
    "keywords": "AGENTS.md CLAUDE.md ACTIVE_SET",
    "body": "Highbeam divides your active context ceiling into 40 discrete chronological cells . Rather than showing a single opaque token counter, the 40-Cell Horizon Bar reveals both what occupies your context window and where each item sits along the parabolic attention recall curve. Critical rules belong in the Primacy band ( AGENTS.md / CLAUDE.md ) or the Recency tail ( ACTIVE_SET ). Items stranded in the Middle Tro"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Dynamic 40-Cell Zoom Tiers",
    "href": "concepts.html#dynamic-zoom-tiers",
    "keywords": "src/core-isomorphic/ui/horizonGrid.mjs 100k 2,500 claude-haiku-5-5 100,000 100k 5x 200k 5,000 180,000 1M 25,000 total_input_tokens > 180,000 1M gemini-4-carbon gemini-4-argon claude-opus-5-5 claude-sonnet-5-5",
    "body": "In Claude Code and isomorphic views ( src/core-isomorphic/ui/horizonGrid.mjs ), the 40-cell bar automatically scales across three operational zoom tiers so small and large windows remain readable: 100k Haiku Cliff Ceiling ( 2,500 tokens/cell): Active when running claude-haiku-5-5 at or below 100,000 prompt tokens, giving high-resolution visibility before the 100k 5x price cliff. 200k Standard Operational Horizon ( 5,"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Cell Taxonomies by Host",
    "href": "concepts.html#cell-taxonomies",
    "keywords": "[S] █ #1A73E8 CLAUDE.md [C] ▓ #81C995 0.1x [D] ▒ #F538A0 [W] █ #FA903E 1.25x 2.0x ANCHOR_CORE ANCHOR_SCHEMA █ ▒ AGENTS.md task.md MEMORY_KI MEMORY_BLEED ▓",
    "body": "Claude Code reports prompt-cache token buckets from Anthropic telemetry, whereas Google Antigravity classifies step-level SQLite and JSONL transcript spans. Both map cleanly onto the 40-cell bar: Host Surface Code / Category Glyph Physical Meaning Claude Code [S] System & MCP █ ( #1A73E8 ) Static system prompt, CLAUDE.md rules, and eager MCP tool schemas loaded at Turn 0. Claude Code [C] Warm Cache ▓ ( #81C995 ) Pref"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "KV-Cache Physics & Algebraic Break-Even ( C* )",
    "href": "concepts.html#cache-gravity",
    "keywords": "claude-opus-5-5 claude-sonnet-5-5 DET-08 src/core-isomorphic/economics/cacheGravity.mjs C* C* = [ O * (P_out,curr - P_out,target) + Delta_uncached * (P_write,curr - P_write,target) ] / [ P_write,target - P_read,curr ] O 800 1,500 3,500 6,000 P_out,curr P_out,target P_read,curr $0.20/M claude-opus-5-5 P_write,target $2.50/M claude-sonnet-5-5 claude-opus-5-5 48,000 claude-sonnet-5-5 O = 1,500 Delta_uncached = 0 C* = 6,522",
    "body": "Intuition suggests switching from a frontier model (such as claude-opus-5-5 ) to a smaller model (such as claude-sonnet-5-5 ) saves money on simple follow-up edits. When a large prompt cache is already warm, that intuition is often backwards: switching models invalidates the warm KV prefix and forces the target model to pay full cache-write rates across the entire conversation history. Highbeam's Cache Gravi"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Dual-TTL Countdowns & The Haiku 100k Cliff",
    "href": "concepts.html#dual-ttl-and-haiku-cliff",
    "keywords": "dualTtl.mjs 300s 3,600s <= 45s <= 15s T-10s 3.1% DET-12 cliffBreaker.mjs 100,000 5x 90k 90k-98k 98k-100k >= 100k",
    "body": "Two additional economic boundaries run continuously in the background: Dual-TTL Countdown ( dualTtl.mjs ): Tracks both the 5-minute ( 300s ) ephemeral prompt-cache window and the 1-hour ( 3,600s ) rolling billing block. The status bar raises an amber warning at <= 45s , offers optional keep-alive guidance at <= 15s , snapshots the State Baton at T-10s , and recommends upgrading to 1-hour caching when at least 3.1% of"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Conductor vs. Executor Division of Labor",
    "href": "concepts.html#conductor-vs-executor",
    "keywords": "127.0.0.1:62935 /browser /swarm @ah-flash-scout <200 hooks/register.js ah-statusline .agents/locks/active_scopes.json DET-20 ~/.ctxtop/sessions/ ctxtop inspect ctxtop postmortem",
    "body": "Highbeam supports two complementary ways of working across Google Antigravity and Claude Code: Google Antigravity as Stateful Visual Conductor: Ideal for architectural planning, side-by-side WebView telemetry inspection ( 127.0.0.1:62935 ), browser verification via /browser , multi-agent board coordination via /swarm , and delegating fast read-only repository lookups to Delegation Scout ( @ah-flash-scout , c"
  },
  {
    "pageTitle": "Core Concepts & Mental Model",
    "title": "Core Concepts & Mental Model",
    "section": "Flight Modes & Enforcement Levels",
    "href": "concepts.html#flight-modes",
    "keywords": "default off warn block .attention-horizon.json OFF SILENT COACH AUTO_PILOT hook_level guard advisory off default_flightcheck.json OFF DET-01 DET-02 DET-18 DET-19 SILENT ah-statusline COACH guard advisory PostCompactMutationQueue",
    "body": "Highbeam separates observation from intervention through a Three-Layer Enforcement Hierarchy : explicit per-detector overrides ( default , off , warn , block ) in .attention-horizon.json , top-level Flight Modes ( OFF , SILENT , COACH , AUTO_PILOT ), and Antigravity's router hook_level ( guard , advisory , off ) in default_flightcheck.json . Mode / Level Surface Runtime Behavior OFF Claude Code & Isomorphic "
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "Configuration, Permissions & Security Sandbox",
    "href": "configuration.html",
    "keywords": "configuration",
    "body": "Highbeam layers project-local configuration over user-global defaults while enforcing non-bypassable Ring-0 boundaries, read-only SQLite locks, and loopback-only network sockets."
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "1. Unified Config Schema ( .attention-horizon.json )",
    "href": "configuration.html#horizon-json-schema",
    "keywords": "src/core-isomorphic/config/horizonConfig.mjs ~/.attention-horizon/config.json <workspace>/.attention-horizon.json { \"schemaVersion\": \"1.0.0\", \"detectorNamespace\": \"claude-code\", \"flightMode\": \"COACH\", \"detectors\": { \"DET-01\": \"default\", \"DET-02\": \"default\", \"DET-03\": \"default\", \"DET-04\": \"default\", \"DET-05\": \"default\", \"DET-06\": \"default\", \"DET-07\": \"default\", \"DET-08\": \"default\", \"DET-09\": \"default\", \"DET-10\": \"default\", \"DET-11\": \"default\", \"DET-12\": \"default\", \"DET-13\": \"default\", \"DET-14\": \"default\", \"DET-15\": \"default\", \"DET-16\": \"default\", \"DET-17\": \"default\", \"DET-18\": \"default\", \"DET-19\": \"default\", \"DET-20\": \"default\" }, \"semanticDetectors\": { \"formatter-bypass\": \"default\", \"drip-feed\": \"default\", \"vague-prompt-rubric\": \"default\", \"effort-overkill\": \"default\", \"post-commit-handoff\": \"default\", \"vision-screenshot-coach\": \"default\", \"micro-skills\": \"default\", \"relay-breaker\": \"default\" }, \"thresholds\": { \"safeLimitTokens\": 147000, \"reminderAtPct\": 75, \"subagentOffloadTokens\": 12000, \"blindSearchLimit\": 6, \"consecutiveFailureLimit\": 3, \"enableLocalKeepAlive\": false, \"microSkillConfirmSessions\": 2 } } flightMode \"OFF\" \"SILENT\" \"COACH\" \"AUTO_PILOT\" \"COACH\" \"default\" \"off\" \"warn\" \"block\"",
    "body": "Implemented in src/core-isomorphic/config/horizonConfig.mjs , Highbeam merges configuration in order from lowest to highest precedence: built-in defaults -> user-global ~/.attention-horizon/config.json -> project-local <workspace>/.attention-horizon.json . .attention-horizon.json (Complete Default Schema) { \"schemaVersion\": \"1.0.0\", \"detectorNamespace\": \"claude-code\", \"flightMode\": \"COACH\", \"detectors\": { \"D"
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "2. Antigravity Router Schema ( default_flightcheck.json )",
    "href": "configuration.html#flightcheck-json-schema",
    "keywords": "PreInvocation config/default_flightcheck.json ~/.gemini/flightcheck/config.json hook_level halt_cooldown_turns hook_level \"guard\" \"guard\" \"advisory\" halt_cooldown_turns 3 cold_session_max_turns 3 trust_decay_turn_threshold 10 warm_cache_lock_tokens 50000 subagent_min_cache_tokens subagent_min_purity_pct 25000 70.0 STEER_SUBAGENT compact_halt_purity_pct 45.0 amputation_token_threshold",
    "body": "Antigravity's PreInvocation router loads defaults from config/default_flightcheck.json and overlays user overrides from ~/.gemini/flightcheck/config.json . See Antigravity Router Levels & Cooldowns for how hook_level interacts with halt_cooldown_turns and emergency exemptions: Key Default Operational Meaning hook_level \"guard\" Router enforcement posture: \"guard\" halts with a scorecard; \"advisory\" injects warn-only no"
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "3. Environment Variables Reference",
    "href": "configuration.html#environment-variables",
    "keywords": "AH_COLUMNS bin/ah-statusline.mjs 80 110 144+ --columns AH_TIER1_MOD_ACTIVE hooks/register.js \"1\" CLAUDE_PLUGIN_ROOT hooks/hooks.json bin/ctxtop.mjs hooks/register.js CLAUDE_CODE_ENABLE_TELEMETRY otelExporter.mjs \"1\" CLAUDE_HEADLESS hooks/register.js ANTIGRAVITY_CONVERSATION_ID AGY_CONVERSATION_ID server.mjs agy_cli_compressor.mjs ANTIGRAVITY_SIDECAR_WEB_PORT PORT sidecars/horizon-daemon/server.mjs",
    "body": "Variable Read By Effect & Default AH_COLUMNS bin/ah-statusline.mjs Overrides terminal column width ( 80 , 110 , or 144+ layout tiers) when --columns is omitted. AH_TIER1_MOD_ACTIVE hooks/register.js & Tier-2 handlers Set to \"1\" by the in-process V8 Mod so spawned Tier-2 CLI hooks skip duplicate work. CLAUDE_PLUGIN_ROOT hooks/hooks.json & bin/ctxtop.mjs Resolved by Claude Code to locate plugin hook handlers and hooks/"
  },
  {
    "pageTitle": "Configuration, Permissions & Security Sandbox",
    "title": "Configuration, Permissions & Security Sandbox",
    "section": "4. Zero-Trust Security Sandbox & Branch Isolation",
    "href": "configuration.html#security-sandbox",
    "keywords": "SECURITY.md test/mod_static_compliance.test.mjs sidecars/horizon-daemon/server.mjs 127.0.0.1 4,096 { readOnly: true } SQLITE_OPEN_READONLY try / finally 'r' DET-18 .claude/settings.json hooks.json workspace: \"share\" git worktree add .agents/locks/active_scopes.json DET-20",
    "body": "Defined in SECURITY.md and verified across automated static compliance suites ( test/mod_static_compliance.test.mjs ), Highbeam enforces five strict security invariants: Zero Outbound Network Calls: Neither the CLI, lifecycle hooks, V8 Mod, MCP server, nor HTTP daemon imports external HTTP clients or makes DNS/HTTPS requests. Loopback-Only Binding & Payload Caps: sidecars/horizon-daemon/server.mjs binds stri"
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Guardrails & Detector Catalog",
    "href": "detectors.html",
    "keywords": "detectors",
    "body": "Highbeam evaluates 32 canonical detectors ( DET-01..DET-32 ), 8 semantic habit coaches, and 6 local Blind-Spot Sensors using pure deterministic JavaScript. Zero extra LLM judge tokens are ever consumed."
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Canonical Detector Catalog ( DET-01 to DET-32 )",
    "href": "detectors.html#canonical-detectors",
    "keywords": "DET-01 DET-02 DET-18 DET-19 DET-01 guard git reset --hard git push --force rm -rf DET-02 guard .env* ~/.gemini/oauth_creds.json DET-03 guard package-lock.json pnpm-lock.yaml Cargo.lock DET-04 guard 3 consecutiveFailureLimit: 3 DET-05 guard .skip",
    "body": "Four detectors carry a Ring-0 Security designation ( DET-01 , DET-02 , DET-18 , DET-19 ). Ring-0 guards protect credentials, shell integrity, workspace settings, and subagent prompt boundaries, and fail closed on malformed hook payloads. All (32) Ring-0 Security (4) Default: Guard Default: Advisory ID Detector Name Default / Severity What It Detects & How to Remediate DET-01 Option Argument Skipping & Destructive Git"
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Semantic Habit Detectors ( semanticDetectors )",
    "href": "detectors.html#semantic-habit-slugs",
    "keywords": ".attention-horizon.json ctxtop config set <slug> <default|off|warn|block> formatter-bypass drip-feed vague-prompt-rubric prompt-decomposer scope-brake effort-overkill post-commit-handoff git commit vision-screenshot-coach DET-20 micro-skills microSkillConfirmSessions: 2 relay-breaker spec-relay /relay",
    "body": "In addition to numbered IDs, .attention-horizon.json supports eight human-readable habit coaching slugs configurable via ctxtop config set <slug> <default|off|warn|block> : formatter-bypass : Advises batching prettier/eslint runs at task end rather than burning turns after every single-file edit. drip-feed : Detects fragmented 1-sentence follow-up prompts that repeatedly pay cache-write overhead when instructions cou"
  },
  {
    "pageTitle": "Guardrails & Detector Catalog",
    "title": "Guardrails & Detector Catalog",
    "section": "Antigravity 6 Local Blind-Spot Sensors",
    "href": "detectors.html#antigravity-blindspot-sensors",
    "keywords": "PreInvocation src/core/blindspot_sensors.mjs DIRTY_SNAP SCHEMA_TAX UNSEEN_CALLERS ACTIVE_SET LEGACY_POISON deprecated_paths **/legacy/** **/deprecated/** **/v1/** QUOTA_AND_STREAM_SHIELD <10% 600 LOOP_AND_GIT_GUARD",
    "body": "During Antigravity's PreInvocation hook, src/core/blindspot_sensors.mjs runs six sub-millisecond filesystem checks: DIRTY_SNAP : Detects when a file previously read into context was modified externally by the user, formatter, or git checkout. SCHEMA_TAX : Measures Turn-0 MCP and tool-declaration token weight against session headroom. UNSEEN_CALLERS : Scans workspace imports when a public export signature is being ref"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "Flight Modes & Enforcement Levels",
    "href": "flight-modes.html",
    "keywords": "flight-modes",
    "body": "Highbeam separates what it observes from how forcefully it intervenes. A three-layer enforcement hierarchy lets you tune interruption policy from silent local telemetry to automated KV-cache and hysteresis gating without disabling Ring-0 security invariants."
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "1. The Three-Layer Enforcement Hierarchy",
    "href": "flight-modes.html#enforcement-hierarchy",
    "keywords": "PreInvocation PreToolUse PreModelSwitch PostToolUse horizonConfig.mjs circuitBreakers.mjs cacheGravityRouter.mjs pre_invocation.mjs allow advisory warn ask deny ~/.ctxtop/runtime/<sessionId>.ctl PAUSED STEP ABORTED detectors semanticDetectors <workspace>/.attention-horizon.json ~/.attention-horizon/config.json \"off\" \"warn\" \"block\" flightMode OFF",
    "body": "Every hook event ( PreInvocation , PreToolUse , PreModelSwitch , and PostToolUse ) is evaluated deterministically in sub-millisecond local JavaScript inside horizonConfig.mjs , circuitBreakers.mjs , cacheGravityRouter.mjs , and pre_invocation.mjs with zero LLM judge calls. When computing an actionable decision ( allow , non-blocking advisory warn , interactive ask , or hard deny ), Highbeam resolves configur"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "2. The Four Flight Modes ( OFF , SILENT , COACH , AUTO_PILOT )",
    "href": "flight-modes.html#four-flight-modes",
    "keywords": "flightMode normalizeConfiguredFlightMode() horizonConfig.mjs normalizeFlightMode() circuitBreakers.mjs DISABLED OFF QUIET MUTE SILENT AUTOPILOT AUTO AUTO_PILOT COACH OFF SILENT COACH AUTO_PILOT DET-01 DET-02 DET-18 DET-19 scanWorkspaceSettings DET-03..05 DET-07",
    "body": "Highbeam normalizes flightMode case-, hyphen-, and space-insensitively inside normalizeConfiguredFlightMode() ( horizonConfig.mjs ) and normalizeFlightMode() ( circuitBreakers.mjs ). Accepted aliases resolve cleanly: DISABLED maps to OFF , QUIET and MUTE map to SILENT , and AUTOPILOT and AUTO map to AUTO_PILOT . Unrecognized strings fall back safely to COACH . Subsystem / Rule OFF SILENT COACH Default AUTO_P"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "3. AUTO_PILOT Escalations & Hysteresis Lock",
    "href": "flight-modes.html#autopilot-and-hysteresis",
    "keywords": "src/core-isomorphic/coach/cacheGravityRouter.mjs AUTO_PILOT HysteresisLock DET-04 DET-05 AUTO_PILOT \"high\" completeActiveTask() resetOnRewindOrBranch() POST http://127.0.0.1:62935/api/router/unlock-hysteresis PostCompactMutationQueue effort thinking speed system_prompt mcp_tools model ttlRemainingSec > 0 cachedTokens >= C* AUTO_PILOT /compact PostCompact 300s foldCodeToSignatureStub() computeCompactLineDiff()",
    "body": "Implemented in src/core-isomorphic/coach/cacheGravityRouter.mjs , AUTO_PILOT adds three stateful automation safeguards beyond static single-turn rules: Hysteresis Lock ( HysteresisLock ): When DET-04 (3 consecutive tool failures) or DET-05 (edit thrashing) trips inside a debugging loop, AUTO_PILOT pins the active frontier model and elevates effort to \"high\" across subsequent turns. This stops an agent from prematurel"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "4. Antigravity Router Levels ( hook_level ), Cooldowns & Chat Prefixes",
    "href": "flight-modes.html#antigravity-hook-levels",
    "keywords": "PreInvocation src/hooks/pre_invocation.mjs config/default_flightcheck.json ~/.gemini/flightcheck/config.json hook_level hook_level halt_cooldown_turns: 3 \"guard\" Context Health Cache Window Risk Signal Recommended Action { systemMessage } \"advisory\" { systemMessage } \"guard\" flightMode: \"AUTO_PILOT\" \"off\" PreInvocation PreToolUse exemptFromCooldown: true \"guard\" amputationCrisis 140,000 AGENTS.md",
    "body": "On Google Antigravity, Highbeam evaluates user prompts in PreInvocation ( src/hooks/pre_invocation.mjs ) using settings merged from config/default_flightcheck.json and ~/.gemini/flightcheck/config.json . The hook_level key governs how router states behave: hook_level Router Behavior 3-Turn Cooldown ( halt_cooldown_turns: 3 ) \"guard\" Default Halts vague or hazardous prompts with the 4-Line Scorecard ( Context"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "5. Per-Detector & Habit Overrides ( default | off | warn | block )",
    "href": "flight-modes.html#per-detector-overrides",
    "keywords": "applyDetectorOverride() src/core-isomorphic/config/horizonConfig.mjs DET-01..DET-20 formatter-bypass drip-feed vague-prompt-rubric effort-overkill post-commit-handoff vision-screenshot-coach micro-skills relay-breaker \"default\" guard advisory flightMode \"off\" triggered: false, decision: \"allow\", overriddenByConfig: \"off\" \"warn\" decision: \"allow\", blocked: false, advisory: true [Advisory Override (DET-XX=warn)] \"block\" decision: \"deny\", blocked: true, advisory: false isCoachAdvisorySuppressed() circuitBreakers.mjs SILENT",
    "body": "When global Flight Modes are too coarse, applyDetectorOverride() in src/core-isomorphic/config/horizonConfig.mjs lets you tune individual canonical detectors ( DET-01..DET-20 ) and all 8 semantic habit slugs ( formatter-bypass , drip-feed , vague-prompt-rubric , effort-overkill , post-commit-handoff , vision-screenshot-coach , micro-skills , relay-breaker ): \"default\" : Inherits the detector's catalog posture ( guard"
  },
  {
    "pageTitle": "Flight Modes & Enforcement Levels",
    "title": "Flight Modes & Enforcement Levels",
    "section": "6. Switching Modes Across Surfaces",
    "href": "flight-modes.html#switching-modes",
    "keywords": "{ \"schemaVersion\": \"1.0.0\", \"flightMode\": \"COACH\", \"detectors\": { \"DET-08\": \"block\" }, \"semanticDetectors\": { \"drip-feed\": \"warn\", \"vague-prompt-rubric\": \"default\" } } /horizon ah_flight_mode npx ctxtop config set <ID|slug> <default|off|warn|block> { \"hook_level\": \"guard\", \"halt_cooldown_turns\": 3, \"warm_cache_lock_tokens\": 50000, \"cache_amputation_tokens\": 140000 } flightMode: \"AUTO_PILOT\" .attention-horizon.json \"hook_level\": \"advisory\" \"guard\" http://127.0.0.1:62935 # Switch live daemon router Flight Mode without restarting sessions: curl -X POST http://127.0.0.1:62935/api/router/mode \\ -H \"Content-Type: application/json\" \\ -d '{\"mode\":\"SILENT\"}' # Response: {\"ok\":true,\"flightMode\":\"SILENT\"} # Manually release an active HysteresisLock triggered by DET-04 or DET-05: curl -X POST http://127.0.0.1:62935/api/router/unlock-hysteresis # Response: {\"ok\":true,\"hysteresisUnlocked\":true} 127.0.0.1",
    "body": "Switch Flight Modes or router levels statically in JSON config files, interactively via CLI/V8 Mods, or live over the loopback daemon API. Claude Code & CLI Google Antigravity Loopback HTTP API <workspace>/.attention-horizon.json (or ~/.attention-horizon/config.json) { \"schemaVersion\": \"1.0.0\", \"flightMode\": \"COACH\", \"detectors\": { \"DET-08\": \"block\" }, \"semanticDetectors\": { \"drip-feed\": \"warn\", \"vague-prompt-rubric\""
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "Terminology & Glossary",
    "href": "glossary.html",
    "keywords": "glossary",
    "body": "Every page in this guide uses the exact canonical terms defined below. Filter by host primitive or type any keyword to look up an unfamiliar metric, file, or runtime concept."
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "A to D",
    "href": "glossary.html#terms-a-d",
    "keywords": "ACTIVE_SET ACTIVE_SET PreInvocation ALLOW_ACTIVE_SET C* claude-opus-5-5 1.25x DET-08 PreInvocation DIRTY_SNAP SCHEMA_TAX UNSEEN_CALLERS LEGACY_POISON QUOTA_AND_STREAM_SHIELD LOOP_AND_GIT_GUARD src/core-isomorphic/ hooks/register.js node:* Buffer process /relay amputationCrisis amputation_token_threshold 140,000 safeLimitTokens",
    "body": "ACTIVE_SET Antigravity Clean file reads, edits, and command outputs located within the most recent 16 trajectory steps (~8 conversational turns). Targets already inside ACTIVE_SET pass Antigravity's PreInvocation scope check silently via ALLOW_ACTIVE_SET . Algebraic Break-Even ( C* ) Core Physics The exact number of warm cached prefix tokens above which staying on a higher-tier model (such as claude-opus-5-5 ) is che"
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "F to M",
    "href": "glossary.html#terms-f-m",
    "keywords": ".attention-horizon.json OFF SILENT COACH AUTO_PILOT MEMORY_BLEED projectPath DET-12 100,000 5x 90k 90k-98k 98k-100k >= 100k AUTO_PILOT POST /api/router/unlock-hysteresis ctxtop install --lean-hooks --full-hooks src/engine-node/ipc/ 15ms 500ms 10MB",
    "body": "Flight Mode Core Physics Top-level operating posture configured in .attention-horizon.json : OFF , SILENT , COACH (default), or AUTO_PILOT (Pro tier automated actuation and Hysteresis Lock). Foreign Knowledge Bleed ( MEMORY_BLEED ) Antigravity Injected Antigravity Knowledge Items whose canonical projectPath belongs to a different repository than the active workspace, flagged so cross-project conventions are verified "
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "P to S",
    "href": "glossary.html#terms-p-s",
    "keywords": "TurnZeroGate DET-09 prefix_cache_shield.mjs turn_zero_gate.mjs AGENTS.md CLAUDE.md 0s .agents/cache/learnings-queue.json .claude/cache/learnings-queue.json /evolve confidence >= 0.55 harmful_count == 0 DET-01 DET-02 DET-18 DET-19 .ctl RUNNING PAUSED STEP ABORTED REWIND ~/.ctxtop/runtime/<sessionId>.ctl ctxtop control DET-20",
    "body": "Prefix Cache Shield & TurnZeroGate Core Physics Write-fencing mechanism ( DET-09 , prefix_cache_shield.mjs , turn_zero_gate.mjs ) that queues mutations to AGENTS.md , CLAUDE.md , and static rule files while the prompt cache is warm, flushing them only when cache TTL reaches 0s or immediately after compaction. Primacy Band & Recency Tail Core Physics The two high-recall regions of the U-Shaped Recall Curve: Turn-0 sys"
  },
  {
    "pageTitle": "Terminology & Glossary",
    "title": "Terminology & Glossary",
    "section": "T to W",
    "href": "glossary.html#terms-t-w",
    "keywords": "hooks/register.js ~0.18ms p95 AH_TIER1_MOD_ACTIVE=1 hooks/handlers/*.mjs ctxtop doctor --prune-tools POST /api/surgeon .bak src/core-isomorphic/ustf/ ctxtop inspect inherit branch share inherit share branch",
    "body": "Tier-1 V8 Mod vs. Tier-2 CLI Hook Claude Code Tier-1 runs inside Claude Code's in-process V8 Mod runtime via hooks/register.js at ~0.18ms p95 and sets AH_TIER1_MOD_ACTIVE=1 ; Tier-2 runs spawned Node scripts in hooks/handlers/*.mjs when Mod runtime APIs are inactive. Tool-Output Surgeon Core Physics Offline transcript surgical pruner ( ctxtop doctor --prune-tools and POST /api/surgeon ) that creates an atomic .bak ba"
  },
  {
    "pageTitle": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "title": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "section": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "href": "hooks-lifecycle.html",
    "keywords": "hooks-lifecycle",
    "body": "Highbeam enforces zero-token guardrails and collects turn telemetry through deterministic host lifecycle hooks. This chapter documents every registered hook event, matcher regex, stdin/stdout JSON contract, timeout, and control-latch transition."
  },
  {
    "pageTitle": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "title": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "section": "Google Antigravity Lifecycle Hooks ( hooks.json )",
    "href": "hooks-lifecycle.html#antigravity-hooks",
    "keywords": "hooks.json 5 250ms SessionStart hooks/session_start.mjs src/hooks/session_start.mjs PreInvocation hooks/pre_invocation.mjs src/hooks/pre_invocation.mjs systemMessage PreToolUse hooks/pre_tool_use.mjs src/hooks/portfolio_runtime.mjs run_command|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|read_file|view_file|invoke_subagent|define_subagent|send_message|manage_subagents|swarm .ctl DET-01..DET-32 {\"decision\":\"allow|ask|deny\",\"reason\":\"...\"} stdout 0 PostToolUse hooks/post_tool_use.mjs run_command|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|invoke_subagent|define_subagent|send_message|manage_subagents|swarm DET-19 DET-04 PostInvocation",
    "body": "In Google Antigravity, hooks.json registers six command hooks, each executing with a hard 5 -second timeout and bounded 250ms stdin read window: Event Entry Script Tool Matcher Regex Runtime Contract SessionStart hooks/session_start.mjs -> src/hooks/session_start.mjs (Session lifecycle) Hydrates sidecar session metadata, audits Turn-0 MCP schema weight, and prepares Episodic Memory resume packs. PreInvocation hooks/p"
  },
  {
    "pageTitle": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "title": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "section": "Claude Code Tier-1 In-Process V8 Mod ( hooks/register.js )",
    "href": "hooks-lifecycle.html#claude-tier1-mod",
    "keywords": "hooks.modules hooks/hooks.json hooks/register.js ~0.18ms p95 AH_TIER1_MOD_ACTIVE=1 on('file.changed') on('tool.call') CircuitBreakerEngine.evaluatePreToolUse on('turn.step') on('turn.complete') $.store on('classic.SessionStart') .claude/cache/HANDOFF_LATEST.md startup|resume|clear|compact|fork on('classic.PreCompact') on('classic.PostCompact') TurnZeroGate on('classic.Stop') DET-14 DET-15 on('command.horizon') on('ui.render')",
    "body": "Declared under hooks.modules in hooks/hooks.json , hooks/register.js loads directly into Claude Code's V8 isolate with zero process-spawn overhead ( ~0.18ms p95 ). It sets AH_TIER1_MOD_ACTIVE=1 and registers 10 literal handlers: on('file.changed') : Tracks external workspace edits on disk to invalidate stale in-context read assumptions. on('tool.call') : Intercepts tool invocations synchronously inside V8, running Ci"
  },
  {
    "pageTitle": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "title": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "section": "Claude Code Tier-2 Spawned CLI Hooks ( hooks/hooks.json )",
    "href": "hooks-lifecycle.html#claude-tier2-cli-hooks",
    "keywords": "hooks/handlers/ user-prompt-submit.mjs PreToolUse handlers/pre-tool-use.mjs Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Task|Agent|WebFetch|mcp__.* CircuitBreakerEngine Grep|Glob PostToolUse handlers/post-tool-use.mjs Bash|PowerShell|Task|Agent|WebFetch|mcp__.* DET-19 PreModelSwitch handlers/pre-model-switch.mjs C* DET-08 cachedTokens > C* PreCompact PostCompact handlers/compact-lifecycle.mjs --phase=pre --phase=post HOLD_COMPACT HANDOFF_LATEST.md TurnZeroGate SessionStart",
    "body": "When Claude Code executes external command hooks (or when Tier-1 Mod APIs are unavailable), six CLI scripts in hooks/handlers/ enforce identical contracts (plus an optional user-prompt-submit.mjs handler): Hook Event Handler Script Matcher Primary Responsibility PreToolUse handlers/pre-tool-use.mjs Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Read|Task|Agent|WebFetch|mcp__.* Evaluates CircuitBreakerEngine , pers"
  },
  {
    "pageTitle": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "title": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "section": "Exit Code & JSON Wire Contract ( hookIo.mjs )",
    "href": "hooks-lifecycle.html#hook-wire-contract",
    "keywords": "hooks/handlers/hookIo.mjs 0 stdout {\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"...\"}} updatedInput stdout 0 stderr 2 stdout WorktreeCreate PermissionRequest SyntaxError 2 { allowMalformed: true } 0",
    "body": "Claude Code Tier-2 handlers strictly follow four wire rules in hooks/handlers/hookIo.mjs : Silent Pass-Through: Exit 0 with empty stdout . Structured JSON Decision: Write valid JSON (such as {\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"...\"}} or updatedInput ) to stdout and exit 0 . Hard Veto Block: Write a concise single-block explanation to stderr and e"
  },
  {
    "pageTitle": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "title": "Lifecycle Hooks, V8 Mod & Runtime Control",
    "section": "5-State Runtime Control FSM ( .ctl )",
    "href": "hooks-lifecycle.html#runtime-control-fsm",
    "keywords": "src/core-isomorphic/control/controlStateMachine.mjs ~/.ctxtop/runtime/<sessionId>.ctl PAUSED PreToolUse 50ms 600,000ms resume step abort ABORTED",
    "body": "Implemented in src/core-isomorphic/control/controlStateMachine.mjs , the Runtime Control plane lets you pause, single-step, rewind, or abort an active coding trajectory from any terminal or IDE button via ~/.ctxtop/runtime/<sessionId>.ctl : When PAUSED , PreToolUse enters a non-spinning 50ms poll loop (up to 600,000ms ) until you issue resume , step , or abort . Once ABORTED , no further state transitions are permitt"
  },
  {
    "pageTitle": "Context physics and zero-token guardrails for AI coding sessions.",
    "title": "Context physics and zero-token guardrails for AI coding sessions.",
    "section": "Context physics and zero-token guardrails for AI coding sessions.",
    "href": "index.html",
    "keywords": "index",
    "body": "Highbeam ( ctxtop ) maps your live context window across a 40-cell recall bar, protects warm KV prefixes from costly model switches, and blocks destructive shell or file mutations before tokens leave your machine."
  },
  {
    "pageTitle": "Context physics and zero-token guardrails for AI coding sessions.",
    "title": "Context physics and zero-token guardrails for AI coding sessions.",
    "section": "60-Second Quick Launch",
    "href": "index.html#quick-launch",
    "keywords": "npx ctxtop init --all npx ctxtop doctor ah-statusline npx attention-horizon-antigravity init --workspace npx ctxtop --serve PreInvocation @ah-flash-scout 127.0.0.1:62935 npx ah-claude install --global npx ah-claude statusline --demo npx ah-claude receipt statusLine ~/.claude/settings.json npx ctxtop init --mcp npx ctxtop doctor --json @ctxtop/mcp .cursor/mcp.json horizon_status cache_gravity_check scope_lock_claim export_receipt_pdf",
    "body": "Run the unified installer from your workspace root to wire hooks, status bars, and sidecar configuration non-destructively. Existing settings are backed up automatically before merge. Dual-Host (Recommended) Google Antigravity Claude Code Cursor & Windsurf MCP Terminal · Dual-Host Setup npx ctxtop init --all npx ctxtop doctor Detects both Google Antigravity and Claude Code on your workstation, merges lean lifecycle h"
  },
  {
    "pageTitle": "Context physics and zero-token guardrails for AI coding sessions.",
    "title": "Context physics and zero-token guardrails for AI coding sessions.",
    "section": "Core Capabilities",
    "href": "index.html#capabilities",
    "keywords": "100k 200k 1M SQLITE_OPEN_READONLY 127.0.0.1",
    "body": "Highbeam replaces guesswork about context consumption with physical measurements: exact token counts, cache hit percentages, cache TTL countdowns, and deterministic pre-execution circuit breakers. 40-Cell Context Telemetry See where recall drops before rules are forgotten Maps your active prompt envelope onto 40 chronological cells with automatic zoom across 100k , 200k , and 1M token ceilings. Identifies mi"
  },
  {
    "pageTitle": "Context physics and zero-token guardrails for AI coding sessions.",
    "title": "Context physics and zero-token guardrails for AI coding sessions.",
    "section": "Start by Engineering Goal",
    "href": "index.html#choose-your-path",
    "keywords": "OFF SILENT COACH AUTO_PILOT hook_level ctxtop",
    "body": "Set Flight Modes & Levels -> Compare OFF , SILENT , COACH , and AUTO_PILOT postures, Antigravity hook_level cooldowns, and surgical detector overrides. Install & Verify -> Set up Highbeam across Antigravity, Claude Code, or Cursor MCP and verify SHA-256 checksums. Follow Hands-On Tutorials -> Walk through prompt prechecks, parallel Git worktree scope locks, surgical pruning, and lossless compaction. Compare "
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Installation, Verification & Migration",
    "href": "installation.html",
    "keywords": "installation",
    "body": "Highbeam installs without modifying project source code, adding npm runtime dependencies, or requesting API credentials. Every configuration merge creates a local backup before writing."
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Prerequisites & Runtime Requirements",
    "href": "installation.html#prerequisites",
    "keywords": ">= 20.0.0 PATH node node --version node:sqlite @ctxtop/engine-node SQLITE_OPEN_READONLY node:sqlite CTXTOP_FORCE_NO_SQLITE=1 DET-01 DET-03 DET-31 git merge-tree",
    "body": "Node.js >= 20.0.0 : Required on your system PATH so host lifecycle hooks can invoke node directly. Verify with node --version . SQLite & Automatic Fallback: On Node.js builds providing built-in node:sqlite (Node 22.5+ and modern Node 20 releases), @ctxtop/engine-node opens session databases with SQLITE_OPEN_READONLY and activates local FTS5 archival. On environments without node:sqlite (or when CTXTOP_FORCE_NO_SQLITE"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Clean Installation Across Surfaces",
    "href": "installation.html#clean-install-by-surface",
    "keywords": "--dry-run settings.json hooks.json",
    "body": "Always preview changes first with --dry-run if you manage custom hook pipelines in settings.json or hooks.json ."
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "1. Unified Dual-Host Installation",
    "href": "installation.html#install-dual-host",
    "keywords": "ctxtop init --all # Preview planned file paths without writing npx ctxtop init --all --dry-run # Perform non-destructive dual-host installation npx ctxtop init --all",
    "body": "Use ctxtop init --all when you work in both Google Antigravity and Claude Code on the same machine: Preview and Run Unified Installer # Preview planned file paths without writing npx ctxtop init --all --dry-run # Perform non-destructive dual-host installation npx ctxtop init --all"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "2. Google Antigravity Installation",
    "href": "installation.html#install-antigravity",
    "keywords": ".agents/plugins/ ~/.gemini/config/plugins/ # Option A: Workspace plugin installation npx attention-horizon-antigravity init --workspace # Option B: Global user installation via ctxtop npx ctxtop init --antigravity --global # Option C: Local source checkout & 3-way mirror sync git clone https://github.com/Gizzant/context-horizon.git cd context-horizon node scripts/sync_mirrors.mjs node bin/ctxtop.mjs verify --json",
    "body": "You can install Highbeam either at the workspace level ( .agents/plugins/ ) or globally across all workspaces ( ~/.gemini/config/plugins/ ), or clone from GitHub for local development: Google Antigravity Setup Options # Option A: Workspace plugin installation npx attention-horizon-antigravity init --workspace # Option B: Global user installation via ctxtop npx ctxtop init --antigravity --global # Option C: L"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "3. Claude Code Installation (Lean vs. Full Hooks)",
    "href": "installation.html#install-claude-code",
    "keywords": "ctxtop install ah-claude install ah-statusline .claude/settings.json ~/.claude/settings.json --global -g # Recommended: Lean hook profile in global ~/.claude/settings.json npx ah-claude install --global --lean-hooks # Project-local full hook profile (.claude/settings.json) npx ah-claude install --project --full-hooks .claude-plugin/plugin.json /horizon /cost-radar /inspect /handoff /precheck /evolve hooks/hooks.json",
    "body": "For Claude Code, ctxtop install (or ah-claude install ) merges lifecycle hooks and the ah-statusline bridge into either .claude/settings.json (default project scope) or ~/.claude/settings.json ( --global / -g ), preserving any unrelated hooks you already use: Claude Code Project vs. Global Installation # Recommended: Lean hook profile in global ~/.claude/settings.json npx ah-claude install --global --lean-hooks # Pro"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "4. Cursor & Windsurf MCP Registration",
    "href": "installation.html#install-mcp",
    "keywords": "C* # Project-scoped .cursor/mcp.json npx ctxtop init --mcp # Global ~/.cursor/mcp.json npx ctxtop init --mcp --global",
    "body": "To expose Highbeam telemetry, C* break-even checks, and multi-agent Scope Lock Leases inside Cursor or Windsurf: Register @ctxtop/mcp in .cursor/mcp.json # Project-scoped .cursor/mcp.json npx ctxtop init --mcp # Global ~/.cursor/mcp.json npx ctxtop init --mcp --global"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Authentication & OAuth Seat Safety",
    "href": "installation.html#authentication-and-seat-safety",
    "keywords": "~/.gemini/oauth_creds.json gemini:antigravity DET-02 gemini agy \"selectedAuthType\": \"oauth-personal\" 1-2",
    "body": "Highbeam requires zero external authentication . It never prompts for Anthropic, Google Cloud, or OpenAI API keys because every detector and score calculation is deterministic local JavaScript. Account & OAuth Seat Safety Protocol To protect interactive developer accounts from automated abuse lockouts, Highbeam enforces three hard boundaries across its runtime and test suite: (1) it never reads ~/.g"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Verification & Health Diagnostics",
    "href": "installation.html#doctor-and-verification",
    "keywords": "ctxtop doctor ctxtop verify $ npx ctxtop doctor [Highbeam Doctor] Status: HEALTHY [PASS] node_version: Node.js v22.11.0 (requires >= 20.0.0) [PASS] model_catalog: Loaded 28 Anthropic model rate cards (Haiku 5.5 100k cliff enabled) [PASS] mod_entrypoint: hooks/register.js present at .../hooks/register.js [PASS] hooks_manifest: hooks/hooks.json valid (nested hooks schema) [PASS] plugin_manifest: .claude-plugin/plugin.json valid [PASS] settings_status: Installed in ~/.claude/settings.json [PASS] horizon_config: 20 detectors configured (FlightMode=COACH, overrides=0) [PASS] hook_diagnostics: 0 recent non-fatal error(s) $ npx ctxtop verify [Highbeam Verify] PASS - 148 release files verified against CHECKSUMS.sha256 (0 mismatches) npx ctxtop doctor --diagnostic",
    "body": "After installing, run ctxtop doctor and ctxtop verify to confirm every manifest, hook contract, model rate card, and file checksum is intact: Verify Contracts & Release Checksums $ npx ctxtop doctor [Highbeam Doctor] Status: HEALTHY [PASS] node_version: Node.js v22.11.0 (requires >= 20.0.0) [PASS] model_catalog: Loaded 28 Anthropic model rate cards (Haiku 5.5 100k cliff enabled) [PASS] mod_entrypoint: hooks/"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Safe Deduplication, Migration & Uninstallation",
    "href": "installation.html#migration-and-uninstall",
    "keywords": "DET-01..DET-32 migrateLegacyHorizonConfig npx ctxtop init --claude --dedupe settings.json npx ctxtop doctor --recover-brain --dry-run --dry-run",
    "body": "Upgrading from v3.x (`ga-visualizer` / `agy-horizon` legacy IDs) or switching from project-level hooks to global hooks takes two commands: Legacy Config Migration: Legacy v3 detector IDs inside existing config files are automatically mapped to canonical v4.0 DET-01..DET-32 identifiers via migrateLegacyHorizonConfig . Hook Deduplication: Run npx ctxtop init --claude --dedupe to strip duplicate or outdated Attention Ho"
  },
  {
    "pageTitle": "Installation, Verification & Migration",
    "title": "Installation, Verification & Migration",
    "section": "Clean Uninstallation",
    "href": "installation.html#clean-uninstall",
    "keywords": "# 1. Remove Highbeam hooks & statusLine from Claude Code settings npx ctxtop uninstall --global npx ctxtop uninstall --project # 2. Optional: remove local telemetry caches and runtime control latches rm -rf ~/.ctxtop ~/.attention-horizon .claude/cache/ah_live_state_*.json .attention-horizon.json",
    "body": "Remove Hooks and Optional Local Caches # 1. Remove Highbeam hooks & statusLine from Claude Code settings npx ctxtop uninstall --global npx ctxtop uninstall --project # 2. Optional: remove local telemetry caches and runtime control latches rm -rf ~/.ctxtop ~/.attention-horizon .claude/cache/ah_live_state_*.json .attention-horizon.json"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "MCP Server, HTTP Daemon & Micro-IPC API",
    "href": "mcp-daemon-api.html",
    "keywords": "mcp-daemon-api",
    "body": "Highbeam exposes three local-only programmatic transports: a zero-dependency MCP stdio server for external AI editors, a loopback HTTP/SSE server for the WebView HUD, and a sub-15ms Micro-IPC socket for warm hook dispatch."
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "1. MCP Stdio Server ( @ctxtop/mcp )",
    "href": "mcp-daemon-api.html#mcp-stdio-server",
    "keywords": "packages/mcp/src/server.mjs ah-mcp ctxtop-mcp 2024-11-05 Content-Length: <bytes>\\r\\n\\r\\n stdin stdout { \"mcpServers\": { \"attention-horizon\": { \"command\": \"npx\", \"args\": [\"-y\", \"--package=ctxtop\", \"ctxtop-mcp\"] } } }",
    "body": "Implemented in packages/mcp/src/server.mjs (binaries ah-mcp and ctxtop-mcp , protocol version 2024-11-05 ), the MCP server accepts both newline-delimited JSON-RPC 2.0 messages and LSP-style Content-Length: <bytes>\\r\\n\\r\\n framed payloads over stdin / stdout . .cursor/mcp.json Registration { \"mcpServers\": { \"attention-horizon\": { \"command\": \"npx\", \"args\": [\"-y\", \"--package=ctxtop\", \"ctxtop-mcp\"] } } }"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "Exposed MCP Tools",
    "href": "mcp-daemon-api.html#mcp-tools-catalog",
    "keywords": "horizon_status cwd?: string sessionId?: string \"default\" { ok, cwd, sessionId, entitlement: { entitled, tier, source }, savedQuota, liveState } cache_gravity_check currentModel: string targetModel: string cachedTokens?: number ttlRemainingSeconds?: number 240 remainingExpectedTurns?: number 1 expectedOutputTokens?: number 1500 C* scope_lock_claim workspaceDir?: string sessionId?: string agentId?: string paths?: string[] ttlSeconds?: number 900 paths inspect",
    "body": "Tool Name Input Parameters Response Payload horizon_status cwd?: string , sessionId?: string (default \"default\" ) Returns { ok, cwd, sessionId, entitlement: { entitled, tier, source }, savedQuota, liveState } from local snapshots. cache_gravity_check currentModel: string (req), targetModel: string (req), cachedTokens?: number , ttlRemainingSeconds?: number ( 240 ), remainingExpectedTurns?: number ( 1 ), expectedOutpu"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "2. Loopback HTTP & SSE Daemon API",
    "href": "mcp-daemon-api.html#http-sse-daemon",
    "keywords": "sidecars/horizon-daemon/server.mjs 127.0.0.1 62935 62945 4,096 400 413",
    "body": "sidecars/horizon-daemon/server.mjs binds strictly to 127.0.0.1 on port 62935 (scanning up to 62945 if occupied) and rejects POST bodies exceeding 4,096 bytes with HTTP 400 / 413 ."
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "Telemetry, Streaming & Export Routes ( GET )",
    "href": "mcp-daemon-api.html#daemon-read-routes",
    "keywords": "GET / /index.html /widget /widget.html GET /preload.js GET /api/health GET /api/state GET /api/stream text/event-stream GET /api/cost-radar GET /api/settings safeLimitTokens reminderAtPct modelOverrides GET /api/memory/resume GET /api/receipt/export ?format=pdf",
    "body": "Method & Path Description GET / , /index.html , /widget , /widget.html Serves the interactive Edward Tufte Highbeam WebView HTML application. GET /preload.js Serves the local sidecar WebView bridge preload script. GET /api/health Returns daemon readiness, PID, active port, and sidecar schema version. GET /api/state Returns the complete 40-cell horizon classification, U-curve recall array, sensor flags, and q"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "Hygiene, Rule Fencing & Router Action Routes ( POST )",
    "href": "mcp-daemon-api.html#daemon-action-routes",
    "keywords": "POST /api/settings POST /api/prune POST /api/surgeon .bak POST /api/tail/trim POST /api/handoff /api/handoff/generate docs/HANDOFF_<timestamp>.md POST /api/rules/promote POST /api/rules/u-curve-optimize /api/ushape/reorder POST /api/shield/flush PrefixCacheShield force: true POST /api/rsi/evolve /api/instincts/promote /api/rsi/queue-action ReflectorQueue POST /api/router/mode /api/router/actuate /api/router/unlock-hysteresis COACH AUTO_PILOT POST /api/host/reap /api/open-brain",
    "body": "Method & Path Description POST /api/settings Validates, clamps, and atomically persists updated context window settings. POST /api/prune & POST /api/surgeon Runs targeted context pruning or the offline Tool-Output Surgeon with automatic .bak backup. POST /api/tail/trim Analyzes read-only host transcripts and stages uncached tail compaction output plus ledger savings. POST /api/handoff & /api/handoff/generate Generate"
  },
  {
    "pageTitle": "MCP Server, HTTP Daemon & Micro-IPC API",
    "title": "MCP Server, HTTP Daemon & Micro-IPC API",
    "section": "3. Micro-IPC Socket Protocol ( @ctxtop/engine-node )",
    "href": "mcp-daemon-api.html#micro-ipc-protocol",
    "keywords": "src/engine-node/ipc/protocol.mjs client.mjs server.mjs CTXTOP_IPC_PATH MAX_BUFFER_SIZE_BYTES = 10,485,760 DEFAULT_CONNECT_TIMEOUT_MS = 15 DEFAULT_REQUEST_TIMEOUT_MS = 500 600,000ms PAUSED 15ms CircuitBreakerEngine .ctl -32700 PARSE_ERROR -32600 INVALID_REQUEST -32601 METHOD_NOT_FOUND -32602 INVALID_PARAMS -32603 INTERNAL_ERROR",
    "body": "Defined in src/engine-node/ipc/protocol.mjs , client.mjs , and server.mjs , the Micro-IPC Bridge lets short-lived CLI hook processes delegate evaluation to a warm local daemon over a user-scoped Unix domain socket (POSIX) or Named Pipe (Windows, overridable via CTXTOP_IPC_PATH ). Limits: MAX_BUFFER_SIZE_BYTES = 10,485,760 (10 MB), DEFAULT_CONNECT_TIMEOUT_MS = 15 , DEFAULT_REQUEST_TIMEOUT_MS = 500 (extended to 600,000"
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Pro Licensing, FinOps & Troubleshooting",
    "href": "pro-troubleshooting.html",
    "keywords": "pro-troubleshooting",
    "body": "Highbeam's core HUD and 32 detector rules are MIT-licensed and free forever. Optional Pro and Team tiers add offline Ed25519-verified automation, expensable PDF 1.4 receipts, and zero-cloud Grafana/Datadog observability packs."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "1. Three-Tier Entitlement Matrix",
    "href": "pro-troubleshooting.html#tier-matrix",
    "keywords": "npx ctxtop tiers src/core/pro_license.mjs $0/mo HOLD_COMPACT $15/mo $12-$19 PreToolUse #tufteBaselineStrip AUTO_PILOT C* $39/seat/mo .agents/rules/ POST /api/export/sanitized ctxtop team-pack",
    "body": "Run npx ctxtop tiers at any time to inspect the built-in capability matrix from src/core/pro_license.mjs : Tier Pricing Included Capabilities Free MIT Core $0/mo Simple View HUD & 4-Rank Tufte Verdict Bar, 40-Cell Parabolic U-Curve Context Map, 5m/1h Live Dual-TTL Countdown, HOLD_COMPACT Warm Cache Warning, and all 32 detector rules. Pro Solo Dev $15/mo ( $12-$19 range) Automated PreToolUse Delta-Read & 3rd-Read AST "
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "2. Offline Ed25519 Activation & 14-Day Trial",
    "href": "pro-troubleshooting.html#offline-ed25519-licensing",
    "keywords": "src/core/pro_license.mjs ~/.ctxtop/license.json # Start a 14-day local Pro evaluation (zero network calls, no credit card) npx ctxtop pro trial # Activate a signed Ed25519 license token npx ctxtop pro activate <ed25519-license-token> # Verify entitlement status npx ctxtop pro status --json # Export a SHA-256 verified Corporate Expense Receipt (PDF 1.4) npx ctxtop receipt --pdf --out ./attention-horizon-expense-receipt.pdf # Generate or preview the BYO-Grafana & Datadog Team FinOps Pack npx ctxtop team-pack --org \"Core Infrastructure\" --out ./finops-pack --preview",
    "body": "Pro and Team entitlements never phone home to a license server. Activation tokens are cryptographically signed Ed25519 payloads verified locally against the public key embedded in src/core/pro_license.mjs and stored at ~/.ctxtop/license.json : Manage Local Trial, License Token & Receipts # Start a 14-day local Pro evaluation (zero network calls, no credit card) npx ctxtop pro trial # Activate a signed Ed25519 license"
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "3. Platform Quirks & Diagnostic Playbook",
    "href": "pro-troubleshooting.html#troubleshooting-playbook",
    "keywords": "npx ctxtop doctor",
    "body": "Every failure state below maps to a deterministic check or one-command local repair. Start with npx ctxtop doctor to inspect all host contracts and recent non-fatal hook errors."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Upstream HTTP 400 on Image / Screenshot Attachments ( DET-20 )",
    "href": "pro-troubleshooting.html#quirk-vision-http400",
    "keywords": "400 Bad Request \"Unable to process input image\" config/platformQuirks.json DET-20",
    "body": "Symptom: Submitting a screenshot while Google AI Credit Overages are active fails upstream with HTTP 400 Bad Request ( \"Unable to process input image\" ). Resolution: Configured in config/platformQuirks.json , DET-20 warns before submission when overage mode and image media coincide. Submit text/DOM snippets only (or delegate DOM inspection) until Base Quota resets."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Preventing 168-Hour Hybrid Quota Lockouts ( DET-16 )",
    "href": "pro-troubleshooting.html#quirk-hybrid-lockout",
    "keywords": "168 DET-16 80% 90% 40,000 12",
    "body": "Symptom: Aggressive parallel subagent fan-out near quota exhaustion can trigger upstream 7-day ( 168 -hour) rate lockouts. Resolution: Keep DET-16 enabled. It throttles concurrency to a single worker at 80% quota utilization, prompts explicit confirmation at 90% , and bounds individual subagents to 40,000 tokens and 12 turns."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Windows PowerShell 5.1 Command Chaining",
    "href": "pro-troubleshooting.html#quirk-powershell-chains",
    "keywords": "&& cmd /c \"node scripts/sync_mirrors.mjs && node bin/ctxtop.mjs verify --json\"",
    "body": "Symptom: Shell commands containing POSIX && operators fail with a parser error in Windows PowerShell 5.1. Resolution: Wrap compound verification commands inside cmd /c \"node scripts/sync_mirrors.mjs && node bin/ctxtop.mjs verify --json\" or execute semicolon-separated statements cleanly."
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Tool Execution Appears Hung or Frozen",
    "href": "pro-troubleshooting.html#quirk-paused-session",
    "keywords": "PreToolUse Execution halted by control latch PAUSED ABORTED ctxtop control npx ctxtop control status --session default npx ctxtop control resume --session default # If ABORTED (terminal), remove the session latch file to reset: rm ~/.ctxtop/runtime/default.ctl",
    "body": "Symptom: Tool calls wait indefinitely at the PreToolUse boundary (up to 10 minutes) or immediately reject with Execution halted by control latch . Resolution: Check whether the session was placed into PAUSED or terminal ABORTED state via ctxtop control : Inspect and Clear Runtime Control Latch npx ctxtop control status --session default npx ctxtop control resume --session default # If ABORTED (terminal), remove the s"
  },
  {
    "pageTitle": "Pro Licensing, FinOps & Troubleshooting",
    "title": "Pro Licensing, FinOps & Troubleshooting",
    "section": "Missing node:sqlite , Orphaned Brains & Bloated state.vscdb",
    "href": "pro-troubleshooting.html#quirk-sqlite-and-storage",
    "keywords": "node:sqlite CTXTOP_FORCE_NO_SQLITE=1 npx ctxtop doctor --recover-brain --dry-run --dry-run npx ctxtop doctor --gc-cursor --vscdb <path-to-state.vscdb> --dry-run npx ctxtop doctor --diagnostic > diagnostic.md",
    "body": "Force JSONL Mode: If an older custom Node 20 binary lacks experimental node:sqlite , set CTXTOP_FORCE_NO_SQLITE=1 ; Highbeam switches cleanly to read-only JSONL offset slicing. Relink Antigravity Brains: Run npx ctxtop doctor --recover-brain --dry-run (then omit --dry-run ) to repair broken brain links after IDE profile upgrades. Compact Cursor SQLite Storage: Run npx ctxtop doctor --gc-cursor --vscdb <path-"
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Google Antigravity vs. Claude Code",
    "href": "surfaces.html",
    "keywords": "surfaces",
    "body": "Highbeam ships one shared isomorphic physics engine wrapped by native host adapters for Google Antigravity, Claude Code, and MCP editors. Each host uses its fastest native extension mechanism while sharing identical detector rules and scope locks on disk."
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Host Capability Matrix",
    "href": "surfaces.html#surface-comparison-matrix",
    "keywords": "@ctxtop/mcp plugin.json .antigravity-plugin/plugin.json .claude-plugin/plugin.json settings.json .cursor/mcp.json .agents/plugins/ ~/.gemini/config/plugins/ .claude/settings.json ~/.claude/settings.json .cursor/mcp.json ~0.18ms p95 ah-mcp ctxtop-mcp 127.0.0.1:62935 <agent-embed> ah-statusline SQLITE_OPEN_READONLY conversations/*.db statusLine .claude/cache/ah_live_state_<id>.json @ah-flash-scout <200 /browser /swarm",
    "body": "Dimension Google Antigravity Claude Code Cursor / Windsurf ( @ctxtop/mcp ) Manifest Root plugin.json & .antigravity-plugin/plugin.json .claude-plugin/plugin.json & settings.json .cursor/mcp.json (stdio JSON-RPC 2.0) Install Locations .agents/plugins/ (workspace) or ~/.gemini/config/plugins/ (global) .claude/settings.json (project) or ~/.claude/settings.json (global) .cursor/mcp.json or global MCP config Execution Pat"
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Google Antigravity Surface Architecture",
    "href": "surfaces.html#google-antigravity-integration",
    "keywords": "agy attention-horizon-antigravity agy-horizon-flightcheck",
    "body": "Inside Google Antigravity (App, IDE, and agy CLI), Highbeam operates as a full sidecar-backed plugin registered under attention-horizon-antigravity (and workspace mirror agy-horizon-flightcheck )."
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Sidecar Daemon & Edward Tufte WebView",
    "href": "surfaces.html#antigravity-sidecar-and-ui",
    "keywords": "sidecars/horizon-daemon/sidecar.json node --no-warnings server.mjs 62935 62935..62945 SIDECAR_UI_ENTRYPOINT_AUX_PANE sidecar://agy-horizon-flightcheck/horizon-daemon/ npx ctxtop --serve #btnCompactPrimary #btnCopyParameterizedCompact #compactInstruction #compactReclaim /compact Ignore file .antigravityignore isIgnorablePath ~/.gemini/config/plugins/agy-horizon agy-horizon-flightcheck node scripts/sync_mirrors.mjs horizon_panel.html src/core/*.mjs",
    "body": "The manifest in sidecars/horizon-daemon/sidecar.json launches node --no-warnings server.mjs on loopback port 62935 (scanning 62935..62945 if busy) and mounts directly into Antigravity's auxiliary side pane via SIDECAR_UI_ENTRYPOINT_AUX_PANE . You can also open it from chat via the sidecar://agy-horizon-flightcheck/horizon-daemon/ pill or run npx ctxtop --serve in any browser. The WebView enforces strict UI invariants"
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Subagents, /browser , /swarm & Workspace Modes",
    "href": "surfaces.html#antigravity-subagents-and-modes",
    "keywords": "@ah-flash-scout agents/ah-flash-scout.md model: flash commandExecutionPolicy: off view_file grep_search find_by_name list_dir File:StartLine-EndLine 200 /browser browser_sandbox/ /swarm inherit share branch",
    "body": "Antigravity provides native multi-agent delegation primitives that Highbeam monitors and protects: Delegation Scout ( @ah-flash-scout ): Defined in agents/ah-flash-scout.md with model: flash , commandExecutionPolicy: off , and read-only search tools ( view_file , grep_search , find_by_name , list_dir ). It returns compact File:StartLine-EndLine coordinates in under 200 tokens so your main frontier model avoi"
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Claude Code Dual-Tier Architecture",
    "href": "surfaces.html#claude-code-integration",
    "keywords": "",
    "body": "Claude Code supports two execution tiers. Highbeam ships both in a single package and coordinates them automatically so guardrails never run twice on the same event."
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Responsive Single-Line ah-statusline Tiers",
    "href": "surfaces.html#responsive-statusline",
    "keywords": "bin/ah-statusline.mjs statusLine .claude/cache/ah_live_state_<sessionId>.json --columns <N> AH_COLUMNS # Compact Tier (80 columns) AH [██▓▓▓▓▓▓░░░░] 64k/200k · Hit 88% · TTL 04:12 · +$1.84 # Standard Tier (110 columns, default fallback) AH sonnet-5.5 [██▓▓▓▓▓▓▓▓▒█░░░░░░░░] 64.0k/200k (32%) · Cache 87.5% · 5m TTL 04:12 · Saved +$1.84 # Wide Workbench Tier (144+ columns) AH sonnet-5.5 [COACH] [██▓▓▓▓▓▓▓▓▓▓▓▓▒█░░░░░░░░░░░░░░░░] 64.0k/200k (32%) · Hit 87.5% · 5m 04:12 | 1h 51:08 · C* Hold · Saved +$1.84",
    "body": "In Claude Code, bin/ah-statusline.mjs ingests Claude Code's statusLine stdin JSON after every turn, writes an atomic snapshot to .claude/cache/ah_live_state_<sessionId>.json , and renders a single-line ANSI bar tailored to your terminal width (overridable via --columns <N> or AH_COLUMNS ): Claude Code StatusLine Layout Tiers (80 / 110 / 144 Columns) # Compact Tier (80 columns) AH [██▓▓▓▓▓▓░░░░] 64k/200k · Hit 88% · T"
  },
  {
    "pageTitle": "Google Antigravity vs. Claude Code",
    "title": "Google Antigravity vs. Claude Code",
    "section": "Side-by-Side Workflow Switcher",
    "href": "surfaces.html#workflow-equivalence",
    "keywords": "# 1. Inspect 40-cell window as an embedded Studio widget /horizon # 2. Score a complex refactor prompt before spending frontier quota #check Refactor src/core/classifier.mjs to extract span categorization # 3. Delegate fast file discovery to Gemini Flash (<200 tokens returned) @ah-flash-scout Locate all callers of classifyHorizonWindow # 4. Compress state into task.md before running /compact /handoff # 1. Open docked Mod pane or print the 4-rank terminal receipt /horizon npx ah-claude receipt --advanced # 2. Check warm KV-cache gravity and C* break-even before switching models /precheck # 3. Render self-contained Cost Radar SVG timeline for the active session /cost-radar # 4. Flush State Baton to .claude/cache/HANDOFF_LATEST.md before /compact /handoff",
    "body": "Select a host below to see the exact command sequence for common daily tasks: Google Antigravity Claude Code Google Antigravity Chat & Terminal Workflow # 1. Inspect 40-cell window as an embedded Studio widget /horizon # 2. Score a complex refactor prompt before spending frontier quota #check Refactor src/core/classifier.mjs to extract span categorization # 3. Delegate fast file discovery to Gemini Flash ( Claude Cod"
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Guided Step-by-Step Tutorials",
    "href": "tutorials.html",
    "keywords": "tutorials",
    "body": "Each tutorial below walks through a complete engineering scenario from setup to verification. Every command runs locally without network calls."
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 1: First Setup, Live HUD & Prompt Precheck",
    "href": "tutorials.html#tutorial-1-first-task",
    "keywords": "$ npx ctxtop init --all ⚡ Highbeam (ctxtop v4.0.0) - Zero-Config Unified Installer [PASS] Claude Code hooks merged into .claude/settings.json [PASS] Antigravity workspace plugin verified $ npx ctxtop doctor [Highbeam Doctor] Status: HEALTHY $ npx ah-statusline --demo --columns 110 AH sonnet-5.5 [██▓▓▓▓▓▓▓▓▒█░░░░░░░░] 64.0k/200k (32%) · Cache 87.5% · 5m TTL 04:12 · Saved +$1.84 $ npx ctxtop panel --out ./horizon-preview.html [Highbeam] Claude Code HUD written: /repo/horizon-preview.html Verdict: NOMINAL (Warm Cache Active) Next Action: Continue in current cache window #check /precheck #check # Input in chat: #check Fix the caching bug in the router # Expected Scorecard Output: ╭─ Flight Check v3.1 ──────────────────────────────────────────────────────────╮ │ 1. PROMPT : [Score 42/100] Scope: UNANCHORED | Target: (none specified) │ │ 2. HORIZON: [Purity: 88% | Sludge: +$0.01/t | Tokens: 38k/200k | Quota: 91%] │ │ 3. ACTION : /model gemini-4-argon • /effort medium │ │ 4. REWRITE: \"Inspect computeBreakEven in @src/core-isomorphic/economics/cacheGravity.mjs and run node --test test/economics_engine.test.mjs\" │ ╰──────────────────────────────────────────────────────────────────────────────╯ Bypass once: prefix with `!` • Lock model/effort: include `!lock` $ npx ctxtop receipt --markdown",
    "body": "Goal: Install Highbeam in a repository, preview the responsive status bar, score an ambiguous refactor prompt before spending high-effort tokens, and verify your savings receipt. Initialize the workspace and verify contract health From your project root, run the unified installer and confirm all eight diagnostic checks pass. Step 1 · Input & Expected Output $ npx ctxtop init --all ⚡ Highbeam (ctxtop"
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 2: Parallel Delegation on Git Worktrees with Scope Locks",
    "href": "tutorials.html#tutorial-2-parallel-worktrees",
    "keywords": "DET-20 DET-31 workspace: \"share\" git worktree add ../repo-auth-slice -b feat/auth-slice git worktree list src/core/pro_license.mjs scope_lock_claim PreToolUse .agents/locks/active_scopes.json $ printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"scope_lock_claim\",\"arguments\":{\"sessionId\":\"session-alpha\",\"agentId\":\"claude-code\",\"paths\":[\"src/core/pro_license.mjs\"],\"ttlSeconds\":900}}}\\n' | npx ctxtop-mcp DET-20 src/core/pro_license.mjs DET-20 [DET-20 Multi-Agent Scope Collision] Blocked write to src/core/pro_license.mjs: Active lease held by session \"session-alpha\" (claude-code, expires in 884s). Work on disjoint files or isolate via git worktree. DET-31 git merge-tree cost-radar $ npx ctxtop cost-radar --out ./swarm-radar.html --json { \"ok\": true, \"path\": \"/repo/swarm-radar.html\", \"retention\": \"Cache Hit 91.2% (Warm)\", \"drift\": \"Thinking Drift Nominal (loopTriggered=false)\", \"swarm\": \"2 worktrees active (main, repo-auth-slice)\" }",
    "body": "Goal: Run two coding agents in parallel across Git worktrees without overwriting shared files or introducing silent merge conflicts, verified via DET-20 , DET-31 , and Cost Radar. Create an isolated Git worktree for Worker B When delegating concurrent edits (equivalent to Antigravity's workspace: \"share\" mode), create a dedicated branch worktree so each agent compiles and tests independently: Step 1 · Create Feature "
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 3: Auditing Failed Runs, Stepping Execution & Surgical Pruning",
    "href": "tutorials.html#tutorial-3-debugging-and-pruning",
    "keywords": "DET-04 # Suspend at the next PreToolUse boundary (writes ~/.ctxtop/runtime/default.ctl) $ npx ctxtop control pause --session default [Highbeam Control] State transitioned to PAUSED # Allow exactly 1 tool call, then automatically return to PAUSED $ npx ctxtop control step --session default [Highbeam Control] State transitioned to STEP # Resume normal execution once verified $ npx ctxtop control resume --session default [Highbeam Control] State transitioned to RUNNING CONTEXT_ROT_DECAY VERIFICATION_CHURN $ npx ctxtop inspect --last [Highbeam Inspect] Session \"default\" (claude-code) Model: claude-sonnet-5-5 | Events: 24 | Spans: 11 Tokens: 92,400 (Uncached: 11,200, Cache: 81,200) $ npx ctxtop postmortem --last 10 [Highbeam Postmortem] Analyzed 10 sessions (1.42M active tokens) Clean Sessions: 7 | Churn: 2 | Rot: 1 Report: session_analysis_report.md --prune-tools --dry-run --dry-run .bak $ npx ctxtop doctor --prune-tools --dry-run ✔ PASS Uncached Tail Surgeon Pruned 6 stale tool output(s), saved ~28400 tokens (dry-run) $ npx ctxtop doctor --prune-tools ✔ PASS Uncached Tail Surgeon Pruned 6 stale tool output(s), saved ~28400 tokens",
    "body": "Goal: Pause a runaway loop, single-step the next tool call, diagnose duplicate-read bloat across recent sessions, and surgically prune stale tool payloads with an automatic backup. Pause and single-step a live agent trajectory When an agent begins thrashing on failing tests (and approaches the DET-04 3-strike consecutive failure breaker), pause it from a second terminal using the Runtime Control FSM: Step 1 · Pause, "
  },
  {
    "pageTitle": "Guided Step-by-Step Tutorials",
    "title": "Guided Step-by-Step Tutorials",
    "section": "Tutorial 4: Zero-Loss Compaction & Cross-Model Spec Relay",
    "href": "tutorials.html#tutorial-4-compaction-and-relay",
    "keywords": "HOLD_COMPACT $ npx ctxtop receipt --simple /handoff /handoff Next Action Blockers Decisions git status --porcelain $ npx ctxtop doctor --handoff ✔ PASS Handoff Distillation Generated handoff document at docs/HANDOFF_2026-11-12.md /compact TurnZeroGate 00:00 amputation_token_threshold #btnCompactPrimary PrefixCacheShield TurnZeroGate PostCompact /relay /relay S0 S1 T <30 Defer",
    "body": "Goal: Compress a deep 135k-token session into a verified State Baton without triggering warm-cache penalties, and structure a bounded Cold Critic Packet for external review. Check cache TTL before compacting Compacting while 50k+ tokens are still warm inside a 5-minute TTL window throws away paid cache reads ( HOLD_COMPACT ). Check live status first: Step 1 · Inspect TTL & Saved Quota $ npx ctxtop receipt --simple Ge"
  }
];
