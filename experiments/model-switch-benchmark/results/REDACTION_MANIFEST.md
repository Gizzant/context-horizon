# Redaction & Privacy Manifest (`REDACTION_MANIFEST.md`)

## 1. Redaction Rules Applied Across All Deliverables & Raw Files

Every deliverable and raw data file under `experiments/model-switch-benchmark/` was scanned and sanitized in-place. The table below lists every category of identifier removed or replaced:

| Category | Original Pattern | Replacement Token | Scope Affected |
| :--- | :--- | :--- | :--- |
| **API Keys & Bearer Tokens** | `sk-or-v1-[A-Za-z0-9_-]+`, `sk-ant-[A-Za-z0-9_-]+` | `[REDACTED_OPENROUTER_KEY]`, `[REDACTED_ANTHROPIC_KEY]` | Redacted at capture time across all transcripts and wire logs |
| **Claude Code Encoded Project Path Slug** | `C--Users-<USER>-AppData-Local-Temp-...-frozen-repo` (`147` occurrences across `49` transcript files) | `<FROZEN_REPO_SLUG>` | `results/raw/transcripts/*.jsonl` (`45` files) and `results/pilot/transcripts/*.jsonl` (`4` files) |
| **OS Username & Local File Paths** | `C:\\Users\\[USER] `<FROZEN_REPO_DIR>`, `<ISOLATED_HOME>`, `<ISOLATED_CLAUDE_CONFIG>` | `C:\\Users\\[USER] `<FROZEN_REPO>`, `<ISOLATED_HOME>`, `<ISOLATED_CLAUDE_CONFIG>` | All `.jsonl` transcripts, wire logs, and manifests |
| **Claude Code Telemetry Device ID** | `"device_id":"<64-hex-sha256>"` inside `requestFingerprint.metadata.user_id` (`63` occurrences) | `"device_id":"[REDACTED_DEVICE_ID]"` | `results/raw/proxy_wire_log.jsonl` and `results/pilot/*_wire_log.jsonl` |
| **OpenRouter Upstream Request IDs** | `gen-<timestamp>-<random>` in `upstreamHeaders.requestId` (`746` occurrences) | `[REDACTED_UPSTREAM_REQ_ID]` | `results/raw/proxy_wire_log.jsonl` and `results/pilot/*_wire_log.jsonl` |
| **Session UUIDs** | Raw UUIDv4 `session_id` / `sessionId` (`45` main + `1` aborted + `4` pilot sessions, `3,987` occurrences) | Deterministic `sess_<run_id>` (e.g. `sess_A_S_r01`, `sess_B_L_r01_aborted_attempt1`) | `results/runs.csv`, `results/raw/checkpoint.json`, `results/raw/proxy_wire_log.jsonl`, `results/raw/transcripts/*.jsonl`, `results/raw/scrubbed_partial_runs.json`, `results/pilot/**` |
| **Anthropic Message IDs** | Raw `msg_01...` IDs on API responses (`746` main + streaming frame occurrences) | Deterministic `msg_<run_id>_T<01..12>_r<1..2>` (and `[REDACTED_MSG_ID]` on unindexed stream frames) | `results/raw/proxy_wire_log.jsonl`, `results/raw/transcripts/*.jsonl`, `results/pilot/**` |
| **Internal Transcript Event UUIDs** | `uuid`, `parentUuid`, `leafUuid`, `promptId`, `sourceToolAssistantUUID`, `requestId` (`4,147` occurrences) | `[REDACTED_UUID]` | `results/raw/transcripts/*.jsonl` and `results/pilot/transcripts/*.jsonl` |
| **Repository, Handle & Project Identifiers** | GitHub owner handle, repository name, local folder name, CLI/brand name (`~1,060` occurrences) | `<GITHUB_HANDLE>`, `<TARGET_REPO>`, `<PROJECT_NAME>`, `<PROJECT_CLI>` | All transcripts, reports, and benchmark scripts under `experiments/model-switch-benchmark/` |

---

## 2. Folder Organization & Publication Safety Classification

### A. Safe to Publish (`experiments/model-switch-benchmark/`)
- **Top-Level Deliverables (`experiments/model-switch-benchmark/results/`):**
  - `results/runs.csv` (`730` rows × `21` columns, unrounded)
  - `results/manifest.md` (complete protocol, batch timeline, rate card, prompts, and deviations)
  - `results/summary.md` (medians and `[min–max]` ranges, switch penalties, Q1–Q5 answers with citations, and anomaly audit)
  - `results/phase0_compact_hooks.md` and `results/smart_compact/phase0_compact_hooks.md` (Smart-Compact Phase 0 binary/mock-SSE verification & Phase 2 cost gate)
  - `results/phase1_boundary_detector.csv` and `results/smart_compact/phase1_boundary_detector.csv` (`1,420` boundary detector rows: `1,240` existing benchmark turns + `180` live Phase 2 turns across `6` 30-turn runs)
  - `results/runs_smart_compact.csv`, `results/smart_compact/runs_smart_compact.csv` (`388` wire rows across `6` runs: `362` `/v1/messages` + `26` `/v1/messages/count_tokens`), and `results/smart_compact/runs_smart_compact_v2.csv` (`142` wire rows across the `2` Fixture v2 runs)
  - `results/summary_smart_compact.md` and `results/smart_compact/summary_smart_compact.md` (Smart-Compact final summary report: limitations, verbatim `preregistration_fixture_v2.json` & provenance, H1–H7 tables, C0 & H6 arithmetic, auto-memory cost finding, compaction latency, `$0` Auto mode proposal, and corrections log)
  - `results/smart_compact/preregistration_fixture_v2.json` (Fixture v2 pre-registration artifact)
  - `results/smart_compact/pilot_c1_r01_summary.json`, `results/smart_compact/stage_a_summary.json`, `results/smart_compact/stage_a2_v2_summary.json`, and `results/smart_compact/phase2_cost_estimate.json`
  - `results/REDACTION_MANIFEST.md` (this file)
- **Builder & Harness Scripts (`experiments/model-switch-benchmark/`):**
  - `build_article_deliverables.mjs` and `build_smart_compact_deliverables.mjs` (recompute CSVs, `manifest.md`, `summary.md`, `summary_smart_compact.md`, `REDACTION_MANIFEST.md`, and run all verification & privacy gates)
  - `config.mjs`, `proxy_recorder.mjs`, `run_experiment.mjs`, `analyze_results.mjs`, `selftest_offline.mjs`, `predictions.md`, `README.md`, `fixtures/prompts_small.json`, `fixtures/prompts_large.json`, `fixtures/prompts_tool_heavy_12t.json`
  - `run_smart_compact_phase0_phase1.mjs`, `run_smart_compact_pilot.mjs`, `run_smart_compact_stage_a.mjs`, `run_smart_compact_stage_a2_v2.mjs`, `analyze_pilot_and_update_phase2_estimate.mjs`
- **Separate Sanitized Raw Data Folders (`results/raw/`, `results/pilot/`, & `results/smart_compact/raw/`):**
  - `results/raw/proxy_wire_log.jsonl` (`720` wire requests across the `45` completed runs)
  - `results/raw/cli_turns.jsonl` (`540` CLI turn records)
  - `results/raw/checkpoint.json`, `results/raw/run_manifest.json`, `results/raw/scrubbed_partial_runs.json`, `results/raw/openrouter_ledger.jsonl`
  - `results/raw/transcripts/*.jsonl` (`45` sanitized session transcript files)
  - `results/pilot/` (`4` Pilot Batch 1 + `2` Pilot Batch 2 wire logs and sanitized transcripts)
  - `results/smart_compact/raw/` (`6` sanitized 30-turn live runs: `C1_r01`, `C1_r02`, `C1_r03`, `C1mem_r02`, `C1_v2_r01`, `C1_v2_r02` — `6` wire logs, `3` OpenRouter ledger JSONLs, and `6` sanitized session transcripts)

### B. NOT Safe to Publish (Must Remain Local / Excluded)
- **`.env.benchmark`** (at the repository root, gitignored — **contains the live `OPENROUTER_API_KEY`; NEVER publish**)
- **OS Temporary Runtime Directory (`%TEMP%/claude-code-switch-benchmark-runtime/`)** (local execution scratch space outside the repository)
---
---
---
---
---
---

## Extension Benchmark Suite (`tests_3_to_8`, `2026-11-15 UTC`)

- **Automated Leak Scanner (`assertNoSensitiveLeaks`):** Executed on all CSVs, checkpoints, JSON summaries, and markdown deliverables verifying zero live API keys (`sk-or-*`, `sk-ant-*`, `AQ.*`, `AIza*`), zero local OS user directories, and zero unsanitized internal repository/product names.
- **Identifier Sanitization Applied in Publication Artifacts:** `<TARGET_REPO>`, `<PROJECT_NAME>`, `<PROJECT_CLI>`, `<HEURISTIC_DET_09>`, and `<GITHUB_HANDLE>`.
- **Verified CSV Artifacts (`results/`):**
  - `results/t4_parallel.csv`: 177 rows, 0 non-200 HTTP responses
  - `results/t6_layers.csv`: 495 rows, 0 non-200 HTTP responses
  - `results/t7_rules.csv`: 360 rows, 0 non-200 HTTP responses
  - `results/t5_trim.csv`: 468 rows, 0 non-200 HTTP responses
  - `results/t3_idle.csv`: 81 rows, 0 non-200 HTTP responses
  - `results/r1_sidecall.csv`: 108 rows, 0 non-200 HTTP responses
  - `results/r2_effort.csv`: 237 rows, 0 non-200 HTTP responses
  - `results/currency_55.csv`: 108 rows, 0 non-200 HTTP responses
- **Companion Reports & Scripts:** `results/phase0_capabilities_and_cost_gate.md`, `results/phase0_rate_card.json`, `results/summary_tests_3_to_8.md`, `tests_3_to_8/*.mjs`, and per-test `results/raw/*_checkpoint_rows.jsonl`.

---

## Cost-Per-Task Benchmark Suite (`cost_per_task/` — Routine Tasks)

- **Audit Timestamp (UTC):** `2026-11-17T00:12:25.480Z`
- **Tier:** `routine tasks`
- **Deliverables Audited (`assertNoSensitiveLeaks` = PASS):** `preregistration_cost_per_task.json`, `runs_cost_per_task.csv` (215 rows), `run_summary_cost_per_task.csv` (24 rows), `summary_cost_per_task.md`, `highbeam_shadow_check.md`, and `cost_per_task_raw/*`.
- **Sanitization Applied:** Zero API keys, zero local OS usernames or temp directories, deterministic `sess_<run_id>` session aliases, and sanitized eval paths in all retry logs.
