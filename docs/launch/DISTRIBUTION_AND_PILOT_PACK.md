# Highbeam (`highbeam-cli` v4.4.1) — Distribution, Launch & Pilot Playbook

All assets below are ready to copy-paste once **`v4.4.1` CI is green on `main`**.

---

## 1. Hacker News (Show HN) Draft

**Title (77 chars):**
`Show HN: Highbeam – 144 live Claude Code runs on tool clamping and KV caches`

**URL:** `https://gizzant.github.io/context-horizon/` (navigate to **144-Run Benchmark**, or `docs/launch/BENCHMARK_LAUNCH_POST.md`)

**Author's First Comment:**
```text
Hey HN — I built Highbeam (MIT core CLI/MCP/IDE sidebar + commercial team FinOps features), a 100% local Node tool that sits in Claude Code and Google Antigravity hooks.

After reading Quesma's Terminal-Bench post showing that shrinking CLI output alone didn't lower AI coding bills, we ran 144 live API runs (wire-captured HTTP tokens + settled USD) and are publishing the losses alongside the wins:

1. 72 replicated live A/B runs on doc/log/audit tasks (T01–T08, sonnet-5.5, 3 reps × 8 tasks × 3 arms):
- BASELINE (no Highbeam): 24/24 complete, 240 reqs, $5.5569 total, 9,047,750 prompt-bill tokens
- HIGHBEAM_SHIELD_OFF (hooks + FTS5, Shield disabled): 24/24, 236 reqs, $5.7998 (+4.37%), 9,394,539 prompt-bill — confirms hooks without pre-write clamping don't save money here
- HIGHBEAM (default auto clamp-only Shield + Grep|Glob + FTS5): 24/24, 241 reqs (1.004x), $4.8174 (-13.31% mean, -14.39% median paired, -16.94% vs Shield-off), 6,847,992 prompt-bill tokens (-24.31%; -24.78% write, -24.25% read), 20/24 paired wins, 3/3 reps, 7/8 tasks (T06 lost +13.43%), 0 hard denies

2. 27 live pure code-exploration runs (T09–T11, small clean files, n=9/arm) — honest null result:
- BASELINE: $1.2346 vs HIGHBEAM: $1.3195 (+6.88%) vs HIGHBEAM_SCOUT: $1.4085 (+14.08%)
- Shield fired 0/27 times; Claude spawned 0/27 Haiku subagents. So ah-haiku-scout ships strictly opt-in (false default).

3. 45-run / 540-turn model-switch wire study ($22.72 settled):
- Switching Opus 4.6 -> Sonnet 4.6 mid-chat (Turn 6, ~58k ctx) collapsed cache hits to 0.0% (+$0.1783 spike) and raised 12-turn spend from $0.7789 to $0.8611 (+10.6%).

We also enforce strict 3-bucket receipt accounting so provider prompt-cache discounts are never added into Highbeam's own savings total.

Zero-write, zero-hook 10-second check on your own local logs:
  npx highbeam-cli audit --days 7

Raw JSONs, methodology, wins/losses, and pricing (Free MIT core, $199 Founder LTD, $299/yr Founding 5-seat Team / $15/seat/mo standard):
https://github.com/Gizzant/context-horizon
https://gizzant.github.io/context-horizon/
(Full benchmark report under "144-Run Benchmark" in the top nav)

Happy to answer questions on the wire setup, Windows vs Linux hook latency (~60–80ms Linux, ~200–275ms Windows), or why we kept T06 and T09–T11 front and center.
```

---

## 2. Reddit Drafts

### A. `r/ClaudeAI`
**Title:** `I ran 144 live API tests to see if tool-output compression & cache guards actually lower Claude Code costs (including where it failed)`

**Body:**
```markdown
After seeing benchmarks show that CLI output compression alone doesn't lower total API cost, I tested Highbeam (`highbeam-cli`, local MIT CLI/hooks/statusline for Claude Code) across 144 live billed runs with wire token capture.

**Where it worked (`T01`–`T08`, 72 runs, `sonnet-5.5`, doc/log/audit tasks):**
- `BASELINE`: `$5.5569` across 24 runs (`9.05M` prompt-bill tokens)
- `HIGHBEAM_SHIELD_OFF` (FTS5 on, read clamping off): `$5.7998` (`+4.37%` — lost!)
- `HIGHBEAM` (default clamp-only `auto` Shield + `Grep|Glob` filter + FTS5): **`$4.8174` (`-13.31%` mean, `-14.39%` median paired)**, **`-24.31%` prompt-bill tokens**, `20/24` wins, `7/8` tasks (lost `T06 +13.43%`), `0` hard blocks.

**Where it did NOT help (`T09`–`T11`, 27 runs, clean small-file code navigation):**
- Shield triggered `0/27` times and Claude ignored the optional Haiku scout (`0/27` spawns), landing at `+6.88%` / `+14.08%` noise. So Haiku scout stays opt-in (`false` default).

**What about `/model` downgrades mid-session?**
- In 45 wire-matched runs (`540` turns), `Opus 4.6 -> Sonnet 4.6` at Turn 6 (`~58k` context) wiped cache (`0.0%` hit) and cost `$0.8611` vs `$0.7789` staying on Opus. Highbeam warns before mid-session switches that won't pay back within remaining turns.

Try read-only first (touches zero files and installs zero hooks):
`npx highbeam-cli audit --days 7`

Native Claude Code plugin marketplace install:
`/plugin marketplace add https://github.com/Gizzant/context-horizon`

Full writeup + raw benchmark JSONs ("144-Run Benchmark" tab): https://gizzant.github.io/context-horizon/
```

### B. Antigravity / AI Coding Developer Communities
**Title:** `Highbeam v4.4.1 — Read-only 5-host context audit + 40-cell HUD + warm cache guard (with 144-run Claude Code benchmark)`

**Body:**
```markdown
Sharing Highbeam (`highbeam-cli` v4.4.1), a zero-dependency local CLI, 40-cell WebView HUD, IDE extension (VS Code / Cursor / Antigravity `.vsix`), and 7-tool MCP server (`@ctxtop/mcp`).

Before touching any config or hooks, run a strictly read-only 10-second audit across Antigravity, Claude Code, Codex CLI, Gemini CLI, and Cursor logs:
`npx highbeam-cli audit --days 7`

Highlights in v4.4.1:
- **144-run empirical benchmark (`benchmark.html`):** `-13.31%` mean billed cost (`-24.31%` prompt-bill tokens) on replicated doc/log/audit tasks (`T01`–`T08`), honest `T09`–`T11` code-browsing null result, and 45-run mid-session model-switch cache math.
- **3-bucket savings ledger + `npx highbeam-cli receipt --share`:** Separates avoided writes, wire delta, and provider KV-cache discounts without mixing units or leaking paths/usernames.
- **Zero-network local telemetry:** Opens SQLite DBs strictly `SQLITE_OPEN_READONLY`; local loopback UI only.

Guide & benchmark: https://gizzant.github.io/context-horizon/
```

---

## 3. Exact Publish, Registry & Marketplace Checklist

### A. Publish `highbeam-cli@4.4.1` and `@ctxtop/mcp@4.4.1` (after CI Matrix is green on `v4.4.1`)
```bash
gh workflow run release.yml -f tag_name=v4.4.1 -f publish_npm=true
```
Verify live packages afterwards:
```bash
npm view highbeam-cli version dist-tags
npm view @ctxtop/mcp version dist-tags
```

### B. Publish VS Code / Open VSX Extension (`extensions/vscode-highbeam/highbeam-4.4.1.vsix`)
```bash
cd extensions/vscode-highbeam
npx ovsx publish highbeam-4.4.1.vsix -p "$OVSX_TOKEN"
npx @vscode/vsce publish --packagePath highbeam-4.4.1.vsix
```

### C. Deploy License & 30-Day Emailed Trial Worker (`packages/pro`)
```bash
cd packages/pro
npx wrangler secret put CTXTOP_ED25519_PRIVATE_KEY_PEM
npx wrangler secret put CTXTOP_POLAR_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
# Smoke test POST /trial:
curl -sS -X POST https://<your-worker-subdomain>.workers.dev/trial \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

### D. Refresh MCP Registries (Glama, Smithery, Official MCP Registry)
1. **Official MCP Registry (`server.json`):** `server.json` points to `io.github.gizzant/highbeam` (`v4.4.1`, `identifier: "highbeam-cli"`, `source: "github"`). Publish with `mcp-publisher`:
   ```bash
   mcp-publisher login github
   mcp-publisher publish
   ```
2. **Glama (`glama.json`):** Open `https://glama.ai/mcp/servers` (your server listing for `highbeam-cli` / `Gizzant`) -> **Trigger Re-sync / Inspect** so title updates from `ctxtop v4.1` to `Highbeam Context & KV-Cache MCP Server` (`highbeam-cli@4.4.1`, `smithery.yaml` stdio command `npx -y highbeam-cli mcp`).
3. **Smithery (`smithery.yaml`):** `smithery.yaml` is already synced to `npx -y highbeam-cli mcp` -> click **Refresh / Redeploy from GitHub `main`** on `https://smithery.ai/`.

### E. Submit Google Antigravity Partner Form & Claude Code Plugin Marketplace
- **Claude Code native install command (already wired via `.claude-plugin/marketplace.json`):**
  `/plugin marketplace add https://github.com/Gizzant/context-horizon`
- **Google Antigravity Plugin Marketplace Partner Form copy-paste answers:**
  - **Plugin Name:** `Highbeam` (`attention-horizon-antigravity`)
  - **Category:** `Developer Tools / Context & Token Observability`
  - **Repository & Manifest:** `https://github.com/Gizzant/context-horizon` (`.antigravity-plugin/plugin.json`)
  - **One-line Summary:** `Zero-dependency local 40-cell context HUD, KV-Cache Gravity effort/switch router, FTS5 CLI compression (96% offline reduction), and 6 slash skills.`
  - **Security & Privacy Posture:** `100% local execution, zero outbound network requests, zero OAuth credential reads (~/.gemini/oauth_creds.json blocked by DET-02), and strict SQLITE_OPEN_READONLY reads of Antigravity session databases.`
  - **Documentation & Benchmark URL:** `https://gizzant.github.io/context-horizon/`

---

## 4. 60-Second Real-Session Demo Script (`audit` + `receipt --share` + HUD)

Record at `1920x1080` (24pt JetBrains Mono / SF Mono, high-contrast dark terminal):
- **0:00–0:10 (The Hook):** Show a noisy multi-host session problem; run `npx highbeam-cli audit --days 7`. Highlight the immediate read-only numbers (`Sludge Tax Preventable`, `Cold-Cache Spikes`, `Un-Sliced Large Reads`, `Oversized Tool Dumps`).
- **0:10–0:25 (Why Compression Alone Isn't Enough):** Flash the 72-run A/B table (`-13.31%` mean cost, `-24.31%` prompt-bill vs. `+4.37%` with Shield off) — 1 clear chart frame.
- **0:25–0:42 (Live Claude Code / Antigravity Experience):** Run `npx highbeam-cli init --claude --global --lean-hooks` (or `--all-hosts`), trigger `npx highbeam-cli statusline --demo`, and open `npx highbeam-cli ui --demo` showing **Zone A** (TTL countdown), **Zone B** (`Hold Model — busts warm cache`), **Zone D** (separated 3-bucket savings).
- **0:42–0:55 (Offline Share & Zero Lock-In):** Run `npx highbeam-cli receipt --share` — show clean 3-bucket output with zero paths or usernames.
- **0:55–1:00 (CTA):** Show `npx highbeam-cli audit --days 7` + `https://gizzant.github.io/context-horizon/`.

---

## 5. Pilot Team Recruitment & Fixed-Price Context Audit Outreach

### A. Free 60-Day Pilot Team DM / Cold Email (Target: 3–5 Metered-API Teams)
**Subject:** `Quick 7-day read-only audit of your team's Claude/Antigravity prompt-cache misses (+ 60d free pilot)`

```text
Hey <Name>,

Saw your team is using Claude Code / coding agents heavily across metered API seats. We just finished 144 live API runs testing what actually lowers coding agent spend vs. what just looks good in token counters (write-up: https://gizzant.github.io/context-horizon/ under "144-Run Benchmark" — -13.31% mean billed cost and -24.31% prompt-bill tokens on doc/log/audit loops, plus the honest cases where it doesn't help).

You can run our read-only auditor locally in 10 seconds with zero hooks or network calls:
  npx highbeam-cli audit --days 7

If you want PR cost attribution (`highbeam pr-cost`), CI token-budget gates (`highbeam ci-gate`), and local zero-PII team rollups (`highbeam team-rollup`), I'm onboarding 3–5 engineering teams on a Free 60-day Team Pilot (normally $15/seat/mo, 5-seat min; $299/yr Founding Intro for the first teams) in exchange for an anonymized rollup and a 2-sentence quote if it moves the needle.

Want me to send a 60-day offline pilot key?

— Frank
sales@highbeamdev.com
```

### B. $1,500–$3,000 Fixed-Price Context & Cache Audit (2-Week Engagement Sheet)
- **Fee:** `$1,500` (up to 10 developers / 2 repos) or `$3,000` (up to 40 developers / monorepo), **100% credited** toward an annual `$15/seat/mo` Team license.
- **Deliverables (zero source/prompt exfiltration — developer-run offline bundles only):**
  1. **Week 1:** Read-only baseline audit (`audit --days 30`, `postmortem`, `DET-08`/`DET-09` warm cache hit/miss breakdown, `AGENTS.md`/`CLAUDE.md` Turn-0 bloat & MCP schema audit).
  2. **Week 2:** Calibrated `.attention-horizon.json` + `.agents/rules/` governance pack, tuned `ci-gate` + `pr-cost` GitHub Action thresholds, before/after 3-bucket savings rollup (`avoidedWrites` vs. `realizedPromptBill`), and executive FinOps summary.
