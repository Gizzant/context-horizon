# Context Horizon (`ctxtop`) — Automated Context/Memory & Performance Benchmark Report

> **Generated Automatically by**: [`tests/benchmark_context_scenario.mjs`](../tests/benchmark_context_scenario.mjs)  
> **Run Command**: `npm run bench:scenario`  
> **Runtime Environment**: Node `v25.6.0` on `win32 10.0.26300 (x64)` — AMD Ryzen 5 7535U with Radeon Graphics (12 logical cores)  
> **Total Suite Execution Time**: `2829ms`

---

## 1. Executive Summary

This benchmark executes a deterministic **5-Stage Agentic Context & Memory Lifecycle Scenario** in an isolated sandbox workspace, validating both functional context accounting and subsystem latency/memory budgets:

1. **Knowledge Item (KI) & Memory Reconciliation**: Accurately separates project-scoped Knowledge Items (`MEMORY_KI`: `3,600` tok) from cross-workspace foreign Knowledge Items (`FOREIGN_BLEED`: `2,900` tok) via SQLite `conversation_summaries.db` workspace reconciliation.
2. **Zero False-Positive Re-Read Exemptions**: Exempts legitimate `read_file -> edit_file -> read_file` and `read_file -> run_command -> read_file` verification cycles (**0 false-positive duplicate tokens** in Stage 2).
3. **Surgical Transcript Pruning & Checkpoint Compaction**: Condenses `13` superseded full-file reads and resolved stack traces into line-numbered AST signature stubs and 1-line error tombstones, reclaiming **`61,091` tokens (`-41.7%`)** in **`13.75ms`** before restoring **`100%` Signal Purity** on a `CORTEX_STEP_TYPE_CHECKPOINT = 23` (`/compact`) boundary.
4. **Real-Time Hook & Sensor Budgets**: All 9 subsystems pass their `p95` SLA budgets, with the `PreInvocation` Flight Check router executing at **`p95 = 0.175ms`** (budget `< 15.0ms`).

---

## 2. 5-Stage Context & Memory Scenario Progression

| Scenario Stage | Turns | Active Tokens | KI Memory / Foreign Bleed | Stale Dupes (`STALE_DUPLICATE`) | Dead Errors (`DEAD_ERROR`) | Signal Purity | Health Band | Inc. Parse | Classify |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Stage 1: Cold Start & KI Memory** | 5 | 24,150 | 3,600 / 2,900 | 0 | 0 | **73%** | `OPTIMAL_FOCUS` | 3.36ms | 83.18ms |
| **Stage 2: Edit & Verify Cycles** | 13 | 38,850 | 3,600 / 2,900 | 0 | 0 | **83%** | `OPTIMAL_FOCUS` | 2.29ms | 10.06ms |
| **Stage 3: Context Bloat & Error Churn** | 31 | 144,150 | 3,600 / 2,900 | 41,400 | 12,600 | **58%** | `VISIBLE_CLUTTER` | 4.43ms | 6.89ms |
| **Stage 4: Blindspot Sensors & Gate** | 32 | 146,550 | 3,600 / 2,900 | 41,400 | 12,600 | **59%** | `VISIBLE_CLUTTER` | 2.89ms | 5.99ms |
| **Stage 5a: Post-Surgical Prune** | 32 | 85,459 | 3,600 / 2,900 | 1,198 | 90 | **91%** | `OPTIMAL_FOCUS` | 3.83ms | 3.44ms |
| **Stage 5b: Post-/compact Epoch** | 3 | 17,700 | 0 / 0 | 0 | 0 | **100%** | `OPTIMAL_FOCUS` | 1.91ms | 4.62ms |

### Stage-by-Stage Verification Notes
* **Stage 1 (Cold Start & KI Memory)**: Ingests system anchor (`14,450` tok), valid workspace KI (`3,600` tok), and foreign ERP KI (`2,900` tok). Foreign KI bleed is immediately isolated in `FOREIGN_BLEED`.
* **Stage 2 (Edit & Verification Cycles)**: Runs 3 multi-step coding cycles (`read -> edit -> read` and `read -> npm test -> read`). `STALE_DUPLICATE` remains `0` because intermediate file mutations and test executions legitimize re-reading updated state.
* **Stage 3 (Context Bloat & Error Churn)**: Simulates 5 unedited re-reads of `processor.mjs`, 3 full reads of `package-lock.json`, and a 3-strike failing command loop resolved on Turn 25. Signal Purity drops to `58%` (`56,900` reclaimable tokens) and emits concrete `.antigravityignore` and `StartLine`/`EndLine` remediations.
* **Stage 4 (Local Blindspot Sensors & Gate)**: Modifies `processor.mjs` externally on disk (`DIRTY_SNAP`), detects 2 unseen downstream importers (`billing_worker.mjs`, `audit_worker.mjs` via `UNSEEN_CALLERS`), and flags `@deprecated` `v1_adapter.mjs` (`LEGACY_POISON`) in **`7.79ms`**.
* **Stage 5a/5b (Surgical Prune & Checkpoint Epoch)**: `pruneSessionTranscript()` folds stale reads into `[AST Signature Stub]` blocks and collapses resolved stack traces into 1-line tombstones (saving `61,091` tokens), followed by a `CORTEX_STEP_TYPE_CHECKPOINT = 23` compaction event that resets epoch counters and restores Signal Purity to `100%`.

---

## 3. Token & Memory Reclamation Efficiency (Stage 4 → Stage 5a → Stage 5b)

| Metric | Pre-Prune (Stage 4 Bloat) | Post-Surgical Prune (Stage 5a) | Post-`/compact` Checkpoint (Stage 5b) | Net Improvement |
| :--- | :---: | :---: | :---: | :---: |
| **Total Active Tokens** | 146,550 tok | 85,459 tok | 17,700 tok | **-128,850 tok (-87.9%)** |
| **Stale Duplicate Tokens** | 41,400 tok | 1,198 tok | 0 tok | **-41,400 tok (-100%)** |
| **Dead Error Tokens** | 12,600 tok | 90 tok | 0 tok | **-12,600 tok (-100%)** |
| **Signal Purity (%)** | 59% | 91% | **100%** | **+41% purity** |
| **Est. Per-Turn Input Cost** | \$0.1099 / turn | \$0.0641 / turn | **\$0.0133 / turn** | **-\$0.0966 / turn** |

---

## 4. Subsystem Latency SLA Benchmarks (`N = 100` Iterations)

| Subsystem / Critical Path | SLA Budget (`p95`) | Avg | p50 (Median) | p95 | p99 | Status | Coverage |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Sidecar Hot Read (readSidecarSync)** | `< 2.0ms` | 0.125ms | 0.109ms | **0.184ms** | 0.860ms | PASS | Synchronous JSON read on every PreInvocation turn |
| **Sidecar Atomic Write (NTFS rename)** | `< 35.0ms` | 3.584ms | 1.353ms | **22.949ms** | 25.234ms | PASS | writeFileSync (.tmp) + atomic renameSync |
| **Incremental JSONL Parse O(Δbytes)** | `< 5.0ms` | 0.245ms | 0.211ms | **0.432ms** | 0.713ms | PASS | parseTranscriptIncremental byte-offset slice |
| **Full Cold JSONL Parse (30 turns)** | `< 10.0ms` | 0.351ms | 0.310ms | **0.637ms** | 1.294ms | PASS | parseRawJsonl full file deserialization |
| **40-Cell Classifier (classifyHorizon)** | `< 10.0ms` | 3.164ms | 3.104ms | **4.070ms** | 4.398ms | PASS | 40-cell bucketing, U-curve weights & offender ranking |
| **6 Blindspot Sensors (runAllSensors)** | `< 12.0ms` | 1.425ms | 1.356ms | **1.867ms** | 3.666ms | PASS | DIRTY_SNAP, UNSEEN_CALLERS, LEGACY_POISON, Git/Loop |
| **PreInvocation Flight Check Hook** | `< 15.0ms` | 0.131ms | 0.123ms | **0.175ms** | 0.285ms | PASS | 8-state router + active set & sensor check |
| **PostInvocation Telemetry Hook** | `< 35.0ms` | 7.307ms | 2.501ms | **26.451ms** | 26.726ms | PASS | Turn counter, error streak & atomic sidecar write |
| **CLI 40-Cell HUD Render (runHud)** | `< 45.0ms` | 12.254ms | 5.200ms | **27.138ms** | 40.014ms | PASS | ANSI status bar formatting + sidecar sync |
| **Loopback Daemon GET /api/state** | `< 30.0ms` | 4.119ms | 3.741ms | **8.355ms** | 8.843ms | PASS | HTTP 127.0.0.1 JSON serialization + state cache |

---

## 5. Transcript Scaling Curve (`O(Δbytes)` Incremental vs. Full Cold Parse)

As session transcripts grow from `10k` tokens (10 turns) to `240k` tokens (175 turns), `parseTranscriptIncremental` slices only newly appended bytes via `fs.readSync(fd, buffer, 0, deltaBytes, lastOffset)`, keeping per-turn parse latency near-constant:

| Session Scale | Turns | Active Tokens | JSONL Size | Full Cold Parse (`p50`) | Incremental `O(Δbytes)` (`p50`) | Incremental Speedup | `classifyHorizon` (`p50`) | Node Heap Used |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **10k Tokens (Small)** | 10 | 10,000 | 40.8 KB | 0.679ms | **0.192ms** | **3.5x** | 2.078ms | 35.15 MB |
| **50k Tokens (Cascade Sync)** | 35 | 50,050 | 201.6 KB | 1.019ms | **0.202ms** | **5x** | 2.400ms | 26.04 MB |
| **100k Tokens (Mid-Session)** | 70 | 100,100 | 403.1 KB | 2.266ms | **0.189ms** | **12x** | 2.957ms | 32.15 MB |
| **180k Tokens (Safe Limit)** | 120 | 180,000 | 723.8 KB | 2.884ms | **0.288ms** | **10x** | 5.392ms | 34.48 MB |
| **240k Tokens (Near Ceiling)** | 160 | 240,000 | 965.2 KB | 4.111ms | **0.227ms** | **18.1x** | 4.485ms | 31.99 MB |
