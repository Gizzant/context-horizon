# Highbeam (`ctxtop`) Cookbook & Recipes

Practical, copy-paste workflows for managing AI coding agent context windows, recovering gigabytes of IDE storage, stopping prompt cache cliffs, and embedding `ctxtop` telemetry into custom scripts.

---

## Table of Contents

1. [Cursor: Reclaiming 30GB–100GB of `state.vscdb` Storage](#1-cursor-reclaiming-30gb100gb-of-statevscdb-storage)
2. [Offline Tool-Output Surgery: Halving Active Session Bloat](#2-offline-tool-output-surgery-halving-active-session-bloat)
3. [Google Antigravity: Recovering Orphaned `brain/` Workspaces](#3-google-antigravity-recovering-orphaned-brain-workspaces)
4. [Claude Code: Stopping the 12.5x–80x Prompt Cache Tax](#4-claude-code-stopping-the-125x80x-prompt-cache-tax)
5. [Programmatic Node.js API: Context Profiling in Your Own Tools](#5-programmatic-nodejs-api-context-profiling-in-your-own-tools)
6. [Continuous Context Health: CI & Git Pre-Push Automation](#6-continuous-context-health-ci--git-pre-push-automation)
7. [Step-by-Step Zone C Walkthrough: Triggering Live Auto-Interventions](#7-step-by-step-zone-c-walkthrough-triggering-live-auto-interventions)
8. [Exporting Verified FinOps & GreenOps Receipts (Markdown / PDF 1.4)](#8-exporting-verified-finops--greenops-receipts-markdown--pdf-14)

---

## 1. Cursor: Reclaiming 30GB–100GB of `state.vscdb` Storage

### The Problem
Cursor stores chat history, checkpoints, and multi-file code diffs in a local SQLite database (`state.vscdb` / `store.db`). Over weeks of active use, orphaned `bubbleId:*`, `checkpointId:*`, `messageRequestContext:*`, and unreferenced `agentKv:blob:*` keys accumulate into 30GB–100GB of dead space.

When disk space drops below 20GB, native SQLite `VACUUM` commands fail with `SQLITE_FULL` because `VACUUM` requires duplicate disk space to rebuild the database in-place.

### Default `state.vscdb` Locations by OS
- **macOS:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Linux:** `~/.config/Cursor/User/globalStorage/state.vscdb`
- **Windows:** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`

### Recipe: Streaming Read-Only Compaction (Zero-VACUUM)
`ctxtop` uses a streaming read-only copy algorithm that selectively filters orphaned keys and writes directly to a fresh compacted database, avoiding write locks on active Cursor windows.

```bash
# Step 1: Run a dry-run to measure reclaimable gigabytes
node src/cli/doctor.mjs --gc-cursor --vscdb "$APPDATA/Cursor/User/globalStorage/state.vscdb" --dry-run

# Step 2: Apply the live streaming compaction
node src/cli/doctor.mjs --gc-cursor --vscdb "$APPDATA/Cursor/User/globalStorage/state.vscdb"
```

> **Safety Guarantee:** The original `state.vscdb` is never modified in-place until the compacted database is fully validated and checksummed.

---

## 2. Offline Tool-Output Surgery: Halving Active Session Bloat

### The Problem
Long-running agentic sessions suffer from **middle-window dilution ("Lost in the Middle")**. An agent reads an 800-line file 6 times, runs verbose `grep` or `find` searches, or captures 400 lines of resolved `stderr` traces. These obsolete tool outputs remain in the active context, burning 30k–100k tokens per subsequent turn.

### Recipe: Truncating Stale Tool Outputs Without Busting Prefix Cache
The `ctxtop` Prefix-Safe Tool-Output Surgeon truncates superseded tool outputs while pinning Turn 0 and the newest 6 turns:

```bash
# Step 1: Dry-run preview of candidate tool outputs and reclaimable tokens
node src/cli/doctor.mjs --prune-tools --dry-run

# Step 2: Apply the surgical truncation to the active session transcript
node src/cli/doctor.mjs --prune-tools

# Step 3: Target a specific session UUID
node src/cli/doctor.mjs --prune-tools --session "55d40681-f338-4d14-bbe5-e41591876188"
```

### Rollback / Undo
Every surgery creates an atomic `.pre_surgeon` backup file adjacent to the transcript:
```bash
# Restore original untouched transcript if needed
cp transcript_full.jsonl.pre_surgeon transcript_full.jsonl
```

---

## 3. Google Antigravity: Recovering Orphaned `brain/` Workspaces

### The Problem
When branching or switching git worktrees, Antigravity subagent sessions can leave disconnected task checklists, conversation logs, and generated diffs under `~/.gemini/antigravity/brain/<uuid>`.

### Recipe: Scan & Recover Orphaned Artifacts
```bash
# Dry-run audit of disconnected brain directories
node src/cli/doctor.mjs --recover-brain --dry-run

# Re-link orphaned brain artifacts to local workspace
node src/cli/doctor.mjs --recover-brain
```

---

## 4. Claude Code: Stopping the 12.5x–80x Prompt Cache Tax

### The Problem
Anthropic's prompt caching relies on exact byte prefix matching. In Claude Code:
1. **The 5-Minute Subagent Cliff:** Subagents default to a 5-minute cache TTL. If subagent calls are spaced > 5 minutes apart, every turn pays full uncached rates ($3.00/MTok vs $0.30/MTok).
2. **Turn-0 Mutation:** Changing system prompt instructions, adding an MCP server, or editing a file early in the conversation invalidates the warm prefix cache.

### Recipe: Monitor Dual-TTL & Freeze Prompt Prefix
```bash
# 1. Open the live ANSI HUD to observe the 1h / 5m TTL countdown clock
node src/cli/horizon_hud.mjs --live

# 2. In your chat session, prepend '!lock' to freeze the current effort & prefix
!lock continue implementation according to task.md

# 3. Detect exact turn and byte offset where prefix cache was busted
node src/cli/postmortem.mjs --last 1 --json
```

---

## 5. Programmatic Node.js API: Context Profiling in Your Own Tools

Because `ctxtop` is written entirely with Node.js built-ins (`node:sqlite`, `node:fs`, `node:http`), you can import its engine directly without adding any external dependencies to your `package.json`.

### Recipe A: Profile an Active Session Window
```javascript
import { parseSessionTranscript } from './src/core/parser.mjs';
import { classifyHorizon } from './src/core/classifier.mjs';

// Parse local JSONL or SQLite session
const sessionData = parseSessionTranscript('path/to/transcript.jsonl');

// Run 40-cell attention and waste classification
const horizonState = classifyHorizon(sessionData);

console.log(`Active Tokens: ${horizonState.window.totalActiveTokens}`);
console.log(`Cache Hit Rate: ${horizonState.quota.cache.hitPercent}%`);
console.log(`Waste Tokens: ${horizonState.metrics.sludgeTokens}`);
console.log(`Top Risky Cell:`, horizonState.topRiskyCells[0]);
```

### Recipe B: Run the 6 Blind-Spot Sensors Before Tool Execution
```javascript
import { runAllBlindspotSensors } from './src/core/blindspot_sensors.mjs';

const evaluation = runAllBlindspotSensors({
  prompt: "Update API endpoint in server.mjs",
  recentSteps: sessionData.steps.slice(-5),
  workspaceRoot: process.cwd()
});

if (evaluation.dirtySnapWarning) {
  console.warn("Target file was modified on disk outside context! Re-read required.");
}
if (evaluation.unseenCallersWarning) {
  console.warn("Warning: Unseen callers detected in workspace:", evaluation.unseenCallers);
}
```

### Recipe C: Query SQLite Episodic Memory via FTS5 BM25
```javascript
import { queryEpisodicMemory } from './src/core/episodic_memory.mjs';

// Retrieve <1,000 tokens of high-relevance architectural context
const memoryPacks = queryEpisodicMemory({
  query: "storage_doctor streaming GC cursor",
  limit: 3
});

console.log(`Found ${memoryPacks.length} episodic memories for re-anchoring:`);
memoryPacks.forEach(pack => console.log(`- [${pack.sessionId}] ${pack.summary}`));
```

---

## 6. Continuous Context Health: CI & Git Pre-Push Automation

Ensure your team never commits unpruned test transcripts, corrupted SQLite schemas, or broken UI mirror syncs:

### Recipe: Git Pre-Push Hook (`.git/hooks/pre-push`)
```bash
#!/bin/sh
set -e

echo "Running ctxtop clean-room pre-push validation..."

# 1. Verify 62 unit and multi-harness wedge tests pass
node --test

# 2. Verify all 7 architectural Show-HN verification suites pass
npm run test:phases

# 3. Confirm 3-way WebView mirrors remain byte-for-byte identical
node scripts/sync_mirrors.mjs

echo "ctxtop: All pre-push checks passed."
```

---

## 7. Step-by-Step Zone C Walkthrough: Triggering Live Auto-Interventions

Want to see Highbeam's **Zone C (Automated Activity)** and **Zone D (Verified Savings Receipt)** react in real time? Run this 4-step workflow in any workspace:

### Step 0: Baseline State (`0.0k` Saved, 32 Guards Armed)
Open the Highbeam Sidepane (`npx ctxtop --serve`). On a cold session start, Zone C displays:
`now · Auto-guards armed (FTS5 CLI compressor & PrefixCacheShield) · ready`

### Step 1: Trigger `GUARD-4` Duplicate File-Read Folding + Warm KV Cache (`+95.8k` Saved)
When an agent reads an 800-line file, makes a small edit, and immediately re-reads the entire unmodified file while a `100k` prompt prefix is warm (`5m` TTL active):
- **What Highbeam Does Automatically**: `PreToolUse` (`GUARD-4`) intercepts the redundant full-file read, serves a compact structural signature/diff stub (`+800` physical tokens saved), and preserves the `95%` warm KV-cache discount (`+95.0k` billing-equivalent tokens saved).
- **Zone C Output**:
  - `T1 · Served system & history prefix from warm KV cache · +95.0k`
  - `T1 · Deduped repeat file read on server.mjs (AST stub) · +800`

### Step 2: Trigger `DET-07` SQLite FTS5 CLI Test Sieve (`+11.2k` Saved)
When a test runner (`npm test`, `pytest`, or `cargo test`) outputs `120+` lines of passing suite noise plus 1 failing assertion (`~11,400` tokens):
- **What Highbeam Does Automatically**: `PostToolUse` strips ANSI spinners, indexes raw stdout into an in-memory SQLite FTS5 (`porter unicode61`) table, and returns only the `160`-token failing stack trace to the model.
- **Zone C Output**:
  - `T2 · Compressed verbose test runner output (FTS5) · +11.2k`

### Step 3: Trigger `DET-09` `PrefixCacheShield` Warm Rule Deferral (`+57.0k` Saved)
When you or the agent attempts to edit `AGENTS.md` or `CLAUDE.md` while a `60k` prefix is still warm (`03:42` remaining on the 5-minute TTL clock):
- **What Highbeam Does Automatically**: `PrefixCacheShield` stages the rule delta in `.agents/cache/pending_rule_deltas.json` until TTL expiry or `/compact`, preventing an immediate cold-prefill rebuild of the entire `60k` prefix.
- **Zone C & Zone D Output**:
  - `live · Staged 1 rule edit via PrefixCacheShield until TTL expiry · shielded`
  - **Zone D Total**: **`+164.0k tokens saved (~$0.33)`**

---

## 8. Exporting Verified FinOps & GreenOps Receipts (Markdown / PDF 1.4)

To generate a cryptographically signed (`SHA-256`) savings receipt for engineering expense reports or Scope 3 sustainability audits:

```bash
# Print Markdown FinOps + GreenOps receipt to terminal
npx ctxtop receipt --markdown

# Generate a standalone PDF 1.4 Corporate Expense & GreenOps Receipt
npx ctxtop receipt --pdf
```

Each receipt reconciles all 10 savings event categories (`CLI_DAMPENED`, `READ_DEDUPED`, `SUBAGENT_ISOLATED`, `CACHE_HIT_SAVED`, `PREFIX_SHIELD_SAVED`, `AUTO_PRUNED`, `TURN_ZERO_COMPACTED`, `PROMPT_HYGIENE_STEERED`, `PROMPT_HYGIENE_BLOCKED`, and `SIGHTSEEING_TOOL_PREVENTED`), alongside estimated USD saved, datacenter GPU energy avoided (`~650 Wh` per `1M` tokens), and `CO₂e` avoided (`~247g` per `1M` tokens).

