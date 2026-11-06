# Viral Marketing & GitHub Growth Playbook (`context-horizon` / `ctxtop`)

**Primary Objective:** Maximize GitHub stars (`Gizzant/context-horizon`), community forks/PRs, and `npx context-horizon` / `npx ctxtop` downloads.  
**Core Positioning:** **`htop` for AI Coding Agent Context Windows.**  
**Zero-Install Conversion Link:** `https://gizzant.github.io/context-horizon/`  
**Repository Link:** `https://github.com/Gizzant/context-horizon`

---

## 1. The 14-Day Compound Launch Sequence

Do not post everywhere at the same hour. Stagger launches so early stars and comments on technical communities create social proof before hitting broader feeds:

| Day | Window (US Eastern) | Channel | Goal & Target Metric |
| :--- | :--- | :--- | :--- |
| **Day 1 (Tue)** | 8:30 AM EST | **`r/LocalLLaMA`** + **`r/GoogleGemini`** | Technical early adopters; first 100-250 stars + feedback |
| **Day 2 (Wed)** | 9:00 AM EST | **`r/ClaudeAI`** + **`r/ChatGPTCoding`** + **`r/Cursor`** | Hit developers frustrated by 5-hour quota burn & `AGENTS.md` amnesia |
| **Day 3 (Thu)** | 8:45 AM EST | **Hacker News (`Show HN`)** | Peak HN front-page velocity (Tufte + zero-dep + `<15ms` hook angle) |
| **Day 4 (Fri)** | 10:30 AM EST | **X / Twitter 6-Post Visual Thread** | Viral `--roast` terminal scorecard challenge + animated SVG |
| **Day 6 (Sun)** | 11:00 AM EST | **Dev.to / Hashnode / Medium Deep-Dive** | SEO capture for *"AI coding agent context rot"* & *"Antigravity plugins"* |
| **Days 7-14** | 15 mins / day | **Guerrilla "Complaint Mining" Loop** | Reply to live Reddit/X complaints about quota burn & context amnesia |

---

## 2. Copy-Paste Channel Posts (Zero AI Fluff, Native Engineering Voice)

### Channel A: Reddit (`r/ClaudeAI`, `r/Cursor`, `r/ChatGPTCoding`, `r/LocalLLaMA`, `r/GoogleGemini`)

**Title Option 1 (High-Pain Story - Recommended):**
> I got tired of my coding agent forgetting `AGENTS.md` at turn 35 and silently burning my 5-hour quota on duplicate file reads, so I built `ctxtop` (`context-horizon`) - a zero-dependency 40-cell context window visualizer and `<15ms` pre-prompt flight check

**Title Option 2 (Visual/Tool Hook):**
> Built `htop` for AI coding agent 200k context windows: see exact token sludge ($/turn), duplicate file reads, dirty disk snapshots, and prefix amputation in real time (0 dependencies, MIT)

**Post Body (Markdown):**
```markdown
If you use long-context coding agents (Google Antigravity, Claude Opus/Sonnet, Gemini 3.1/3.8/4 Argon) for serious multi-file work, you have probably hit at least 4 of these walls:

1. **Turn-35 Rule Amnesia:** Your agent follows `AGENTS.md` and `implementation_plan.md` great for 25 turns, then suddenly ignores your rules at turn 35 because total context crossed 140k tokens and your system anchors got pushed into the prefix truncation / Lost-in-the-Middle zone.
2. **Mystery 5-Hour Quota Evaporation:** The agent reads the same 600-line file 6 times and keeps 4 resolved compiler stack traces in the transcript. Because LLM APIs re-send the history on every turn, you pay a compounding "Sludge Tax" ($/turn) on dead tokens.
3. **Blind Stale-File Overwrites:** You tweak `routes.mjs` in VS Code while the agent is thinking, and the agent overwrites your fix using its 15-minute-old `view_file` snapshot.
4. **Unseen Caller Breakage:** It refactors an exported function in `router.mjs` and says "All done!", breaking 4 files that import it because those callers weren't in the active context window.

I built **Context Horizon (`ctxtop`)** to make the 200k context window visible and fix these automatically before the prompt even fires:

* **Live Browser Demo (0 install, click through all 8 crisis states):** https://gizzant.github.io/context-horizon/
* **GitHub Repo (MIT, 0 dependencies):** https://github.com/Gizzant/context-horizon

### What it does:
* **40-Cell Chronological ANSI HUD & Edward Tufte Webview:** Maps Turn 0 (left) to Current Turn (right) in 5,000-token cells: Cyan (`ANCHOR_CORE`), Violet (`MEMORY_KI`), Neon Pink (`MEMORY_BLEED` from a foreign repo), Amber (`STALE_DUP` duplicate reads), Flashing Amber (`DIRTY_SNAP` modified on disk), Crimson (`DEAD_ERROR` stack traces), Green (`ACTIVE_SET`), and Red `![AMPUTATION]!` brackets when Cells 1-8 are at truncation risk.
* **6 Blind-Spot Sensors (`<15ms` total):** Detects disk `mtimeMs` drift (`DIRTY_SNAP`), Turn-0 MCP schema bloat (`>15%` window with 0 calls in 15 sessions), reverse-import unseen callers, `@deprecated` legacy contagion, 5-hour quota floor (`<10%`), and 3-strike error loops.
* **One-Click Surgical Transcript Pruner:** Folds stale duplicate file reads into compact AST signature stubs (`export function...`) and collapses resolved stack traces into 1-line tombstones without invalidating your hot KV prefix cache.

### Try it in 10 seconds (Node 20+, zero dependencies):
```bash
# Preview the 40-cell HUD & Flight Check Scorecard in terminal
npx context-horizon --demo

# Watch the 5-stage live terminal animation (Cold Start -> Sludge -> Amputation -> Recovery)
npx context-horizon --demo-animate

# Roast your local sessions (prints a shareable Context Hygiene Report Card)
npx ctxtop --roast
```

Would love feedback on the 6 blind-spot sensors or any other recurring agent failure modes you want detected in `<3ms`!
```

---

### Channel B: Hacker News (`Show HN`)

**Title:**
> Show HN: Context-Horizon (ctxtop) – htop and Tufte visualizer for 200k LLM coding sessions

**First Comment (Post immediately after submitting link):**
```text
Hi HN,

I built `context-horizon` (`ctxtop`) because while building large projects in Google Antigravity, I kept running into silent context degradation around 115k-140k tokens: earlier architectural rules (`AGENTS.md`) would fall into the U-shaped attention trough or get truncated, duplicate `read_file` outputs would accumulate a heavy per-turn token tax, and external editor saves would get clobbered by stale in-memory snapshots.

Interactive zero-install browser demo (preloaded with 8 synthetic telemetry states):
https://gizzant.github.io/context-horizon/

A few architectural details that might be interesting:
1. Zero external npm dependencies (pure Node.js 20+ ESM). The CLI statusLine runs every 300ms and the PreInvocation router runs on every prompt, so startup and execution had to stay under a strict 15ms p99 SLA (currently ~1.8ms read / ~6ms full sensor + 40-cell classification).
2. 4-Tier Untruncated Log Resolution: Standard agent transcripts truncate tool payloads at ~4,120 chars. `log_resolver.mjs` uses byte-offset cursors across untruncated JSONL chunks and SQLite (`node:sqlite`) to classify real token footprints incrementally without re-parsing the whole file.
3. Prefix-Safe Surgical Pruner (`pruner.mjs`): Naively deleting early turns destroys the LLM's KV prefix cache. Instead, our pruner preserves the hot prefix and folds superseded middle-zone code reads into lightweight AST signature stubs (`export function / class`) and 1-line error tombstones.
4. 100% Local-Only: Binds strictly to 127.0.0.1 with zero outbound network sockets.

You can preview the ANSI HUD in your terminal without an active session via:
`npx context-horizon --demo-animate`

Happy to answer any questions about the 40-cell taxonomy, the U-shaped recall curve approximation, or the 6 blind-spot sensors.
```

---

### Channel C: X / Twitter 6-Post Viral Launch Thread

* **Tweet 1 (Attach `assets/hero-demo.svg` or GIF recording of `npx context-horizon --demo-animate`):**
  Ever wonder why your AI coding agent follows `AGENTS.md` for 25 turns and then suddenly loses its mind at turn 35?
  
  Or why your 5-hour quota vanishes in 40 minutes?
  
  I built `ctxtop` (`context-horizon`) — `htop` for your agent's 200k context window.
  
  0 dependencies. `<15ms` latency. MIT. 🧵👇

* **Tweet 2 (The "Sludge Tax" & Duplicate Reads):**
  Most devs don't realize that when an agent reads a 700-line file 6 times and hits 3 test errors, those dead tokens stay in the transcript and get re-billed on *every single turn*.
  
  `ctxtop` plots all 200,000 tokens across 40 chronological cells and calculates your exact **Sludge Tax ($/turn)**.

* **Tweet 3 (The 6 Blind-Spot Sensors):**
  Before your prompt even hits the model, a `<15ms` Flight Check router checks 6 local sensors:
  1. `DIRTY_SNAP`: Did you edit a file in VS Code after the agent read it?
  2. `UNSEEN_CALLERS`: Are there files importing your target that aren't in context?
  3. `SCHEMA_TAX`: Zombie MCP servers eating >15% of Turn 0?

* **Tweet 4 (The Prefix Amputation Shield):**
  4. `AMPUTATION`: Are Cells 1-8 (`AGENTS.md`, `task.md`) crossing 140k tokens?
  5. `MEMORY_BLEED`: Did a Knowledge Item from a foreign repo leak into this session?
  6. `QUOTA_SHIELD`: Is your 5-hour quota under 10%?

* **Tweet 5 (The Viral `--roast` Challenge):**
  Want to see how much context sludge is hiding in your local sessions right now?
  
  Run:
  `npx ctxtop --roast`
  
  It audits your local logs (100% offline, 0 network calls) and prints your worst Purity % and total $ burned on duplicate file reads. Drop your roast card below 👇

* **Tweet 6 (Links):**
  Try the live Edward Tufte visualizer in your browser (0 install):
  https://gizzant.github.io/context-horizon/
  
  Star the repo on GitHub:
  https://github.com/Gizzant/context-horizon

---

## 3. Guerrilla "Complaint-Mining" Daily Loop (Highest Conversion Rate)

Every day, dozens of developers post threads complaining about the exact problems `context-horizon` solves. Replying with a helpful technical explanation + link converts at **25%+ to GitHub stars**.

### Daily Search Queries (Reddit & X Search):
1. `("AGENTS.md" OR "CLAUDE.md" OR "system prompt") ("ignored" OR "forgets" OR "stopped following")`
2. `("Antigravity" OR "Claude" OR "Cursor") ("5 hour quota" OR "quota burned" OR "rate limit") context`
3. `("overwrote my changes" OR "overwrote my file") (agent OR Claude OR Antigravity)`
4. `("MCP" OR "tool schemas") ("too many tokens" OR "context bloat")`

### Non-Spammy Diagnostic Reply Template:
> "What's happening here is usually **Prefix Amputation + Lost-in-the-Middle dilution** once your cumulative session tokens cross ~115k-140k (especially if the agent re-read a few large files or logged stack traces in the middle turns).
> 
> I actually open-sourced a zero-dependency CLI tool (`npx context-horizon --demo` / repo: `github.com/Gizzant/context-horizon`) that plots the 200k window across 40 cells so you can see the exact turn where `AGENTS.md` enters the truncation zone and how many duplicate-read tokens you can reclaim before running `/compact`."

---

## 4. "Comment Jiu-Jitsu" Objection Playbook (Hacker News & Reddit)

| Inevitable Comment | High-Signal Maintainer Response |
| :--- | :--- |
| **"Why not just run `/compact` every 10 turns?"** | "Two reasons: (1) Blindly running `/compact` destroys your warm KV prefix cache and summarizes away exact line numbers in your active working set (`ACTIVE_SET`). (2) `/compact` doesn't catch external disk edits (`DIRTY_SNAP`), unseen reverse-import callers (`UNSEEN_CALLERS`), or Turn-0 MCP schema bloat (`SCHEMA_TAX`). `ctxtop` tells you *when* compaction actually reclaims >40k sludge tokens vs when surgical AST folding preserves your cache." |
| **"Does running a hook on every prompt slow down my CLI?"** | "We budgeted a strict `<15ms` p99 ceiling. The `PreInvocation` router reads a pre-computed atomic `sidecar.json` in `~0.4ms` and runs incremental byte-offset log parsing in `~5ms` (verified via our 200-iteration `npm run bench` suite)." |
| **"Does this send my prompts or file paths to an external server?"** | "Zero network calls. There isn't a single `fetch`/`http.request` in the backend and `0` third-party npm dependencies in `package.json`. The optional Webview binds strictly to `127.0.0.1`. See `SECURITY.md`." |
| **"Why is the Webview a single HTML file instead of React/Next.js?"** | "So the entire plugin installs in `<1` second with `0` `node_modules` bloat, zero build step required for users, and zero supply-chain vulnerabilities. Contributors can register panels via `src/webview/registry.mjs`." |

---

## 5. Seeded "Good First Issues" to Drive Community Forks

Create these 5 issues on GitHub immediately after pushing `main` and label them `good first issue` + `help wanted`:

1. **`[Sensor]: Add .env / Secret File Read Guard (<2ms) to blindspot_sensors.mjs`**
   - *Goal:* Warn or halt when an agent reads `.env`, `.env.local`, or `.pem` files into transcript logs.
2. **`[Sensor]: Add Minified / Lockfile Token-Bomb Detector`**
   - *Goal:* Flag `view_file` calls on `*.min.js`, `package-lock.json`, or `pnpm-lock.yaml` before they burn 40k+ tokens.
3. **`[CLI]: Add --json and --markdown export flags to npx ctxtop --roast`**
   - *Goal:* Allow CI pipelines or developers to export their session hygiene audit as JSON or a Markdown table.
4. **`[Chart]: Add Token Velocity (tokens/min) Sparkline to the Tufte Webview`**
   - *Goal:* Use `src/webview/registry.mjs` to plot turn-over-turn token growth velocity.
5. **`[Rules]: Add Cursor (.cursorrules) and Windsurf (.windsurfrules) Anchor Recognition`**
   - *Goal:* Expand `ANCHOR_CORE` path matching in `horizon_classifier.mjs` so developers migrating rules across IDEs get automatic anchor protection.
