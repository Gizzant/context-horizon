# Highbeam Airlock — Multi-Round Review Log, Archived Scorecard & Spike Provenance

This companion log preserves the full critical review history, archived standalone-SKU scoring rubric, primary-source disagreements, and assumptions ledger behind [`HIGHBEAM_AIRLOCK_360_EVALUATION.md`](./HIGHBEAM_AIRLOCK_360_EVALUATION.md).

---

## 1. Archived Standalone Sister-SKU Scorecard (Rounds 1 & 2)

> **Context**: Before Track A empirical testing (`@anthropic-ai/claude-code@2.1.325`) triggered Decision Tree Branch 2 and pivoted Airlock into a **stateless one-way module inside `ctxtop Pro`**, Rounds 1 and 2 evaluated the standalone dual-host reversible-vaulting Sister-SKU proposal using a weighted 7-domain rubric. Both original and revised evaluations were written by the same author (with two external review rounds), so **all 7 domains with unbuilt capabilities were capped at $\le 80 / 100$**. In the standing evaluation doc, this compressed scorecard is superseded by the **7-Gate Readiness Checklist** (`Table 1.1`).

* **Arithmetic Correction of Initial Pre-Review Draft**:
  The original draft mis-summed weighted scores as `77.9` (raw) and `91.8` (engineered). Exact arithmetic on the original six domains gives:
  $$\text{Original Raw Composite} = (78 \times 0.20) + (70 \times 0.20) + (86 \times 0.15) + (75 \times 0.15) + (72 \times 0.15) + (90 \times 0.15) = \mathbf{78.05}$$
  $$\text{Original Engineered Composite} = (93 \times 0.20) + (89 \times 0.20) + (94 \times 0.15) + (95 \times 0.15) + (90 \times 0.15) + (92 \times 0.15) = \mathbf{92.05}$$

| Standalone Sister-SKU Domain *(Archived Pre-Pivot)* | Weight | Concept Score (Weighted) | Spec Quality Score (Weighted, Cap $\le 80$) | Round 2 Confidence | Primary Risk Basis |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **1. Dual-Host Architecture & Reversible Vaulting** | **20%** | 65 / 100 (`13.00`) | **78 / 100** (`15.60`) | Medium | Antigravity `PostToolUse` `{}` limit; Claude Code `Edit.validateInput()` & `.jsonl` blockers |
| **2. Detection Precision, Latency & Threat Model** | **10%** | 70 / 100 (`7.00`) | **80 / 100** (`8.00`) | Medium | Stage 3 entropy FP risk & unbenchmarked `100 KB` / `10k` trie |
| **3. Platform & Host-API Risk** | **10%** | 50 / 100 (`5.00`) | **76 / 100** (`7.60`) | Medium | Native Anthropic redaction docs, TrueFoundry hooks, host schema drift |
| **4. Developer & CISO UX Design** | **15%** | 78 / 100 (`11.70`) | **80 / 100** (`12.00`) | Medium | Airlock heartbeat & allowlist UI unbuilt |
| **5. Compliance KPI & Ledger Math** | **15%** | 72 / 100 (`10.80`) | **80 / 100** (`12.00`) | Medium | Hash-chained SQLite ledger unbuilt |
| **6. Red-Team QA & Proof Matrix** | **15%** | 68 / 100 (`10.20`) | **78 / 100** (`11.70`) | Low -> Medium | Spike wire tests run; 500k corpus & CI suites pending |
| **7. Standalone Unit Economics & Wedge** | **15%** | 60 / 100 (`9.00`) | **78 / 100** (`11.70`) | Low | `467`–`644` seat standalone breakeven from `0` current users |
| **Archived Sister-SKU Composite** | **100%** | **66.70 / 100** | **78.60 / 100** | **Low–Medium** | **Replaced by Stateless `ctxtop Pro` Pivot (`Table 1.1`)** |

---

## 2. Consolidated Audit Changelog (Rounds 1, 2 & 3)

| ID | Review Round & Finding | Section Impacted | Change Applied | Rationale |
| :---: | :--- | :--- | :--- | :--- |
| **R1-1** | Fix weighted math, split Concept/Spec/Confidence, add 10% Platform Risk, cap unbuilt domains at $\le 80$ | Review Log §1 | Corrected `78.05`/`92.05`, converged archived rubric to `66.70`/`78.60`. | Eliminated arithmetic errors and self-grading inflation. |
| **R1-2** | Remove absolute zero-cloud / cryptographic guarantee claims; add Approved/Prohibited Claims table | Eval §3.4 & Table 3.4a | Repositioned as best-effort Pre-Ingestion Airlock; clarified Airlock makes no network calls while host IDE/LLM still do. | Matches user-space hook threat model and prevents legal overclaiming. |
| **R1-3** | Separate JS algorithm time, process spawn, and end-to-end tool overhead | Eval §3.1–3.3 | Added 3-tier latency model and 3-OS benchmark plan; removed speed from competitive wedge. | Fresh `node` CLI spawns dominate `< 10 ms` targets. |
| **R2-1** | Separate local handler limit (`ISS-034` in `post-tool-use.mjs`) from Claude Code `updatedToolOutput`, inspect Antigravity `hooks.md` | Eval §2.0 & Table 2.3a | Confirmed Antigravity `PostToolUse` expects `{}` (`agy-customizations/docs/hooks.md`) and scoped Track A spike to verify Claude Code wire & `.jsonl`. | Replaced stale host premise with primary-source hook verification. |
| **R2-2** | Add missing failure modes (`FM-8` fail-open, `FM-9` asymmetric re-vault, `FM-10` unsafe destinations) | Eval §2.3 | Added `FM-8`, `FM-9`, `FM-10`, Zone A heartbeat, and lapse counters on PDF receipts. | Closes silent crash/timeout and `git commit` secret injection traps. |
| **R2-3** | Salted HMAC fixture allowlist & precise KV-cache explanation | Eval §2.2 & §4.1 | Replaced plain `SHA-256` with keyed `HMAC-SHA256(orgKeychainSalt, ...)`; clarified deterministic placeholders protect co-reference rather than past immutable turns' KV cache. | Prevents brute-forcing short test fixtures (e.g., test SSNs). |
| **R2-4** | Reconcile prices, OpEx FTE math, disclose `0` pre-launch installs, move buyer interviews earlier | Review Log §1, Eval §7 | Disclosed `0` external users today, moved 15 buyer interviews to Gate 0, and adopted `ctxtop Pro` fold-in baseline. | Aligns financial model before committing R&D build. |
| **R3-1** | Track A (`@anthropic-ai/claude-code@2.1.325`) 18-scenario wire + `.jsonl` spike + Decision Tree Branch 2 | Eval §1–3, [`test/fixtures/airlock_spike`](../test/fixtures/airlock_spike/README.md) | Proved `updatedToolOutput` scrubs wire & `.jsonl` across `Read`, `Bash`, `Grep`, `Glob`, `mcp__*` **only with exact `sdk-tools.d.ts` shapes**; uncovered `Edit.validateInput()`, `.jsonl` `hook_success` persistence, and `exit 1`/timeout fail-open. | Replaced assumptions with reproducible loopback HTTP & `.jsonl` evidence. |
| **R3-2** | Gap #1: Schema Drift is a silent fail-open without version guards (`FM-11`) | Eval Table 1.1 (G2), §2.3 (`FM-11`) | Added `FM-11`: `cloneAndScrubToolResponse` preserving unknown keys, `TESTED_CLAUDE_CODE_RANGE` Zone A `"Untested Version"` warning, and CI `latest` canary workflow. | Prevents host schema upgrades from silently turning off redaction. |
| **R3-3** | Gap #2: Hardened `FM-8` (`3.5s` watchdog, `SessionStart` self-check, honest `PostToolUse` contract) | Eval Table 1.1 (G3), §2.3 (`FM-8`), §4.2 | Added `3.5s` internal `exit 2` deadline before `5s` host kill, `SessionStart` `Airlock INACTIVE` check for missing `node` on `PATH`, and explicitly stated `PostToolUse` is **fail-open with detection**. | `try/catch` cannot survive host timeout kills or launch failures. |
| **R3-4** | Gap #3: Write-only placeholder UX, `FM-1` retry cap & Suite 5 stall metrics | Eval §2.1, §4.1, §6 (Suite 5) | Renamed v1 tokens to **Write-Only Co-Reference Placeholders**; added actionable `exit 2` message, 2-strike retry cap, and Suite 5 block-loop/stall metrics. | Prevents misleading "in flow" claims and bounds retry token burn. |
| **R3-5** | Gap #4 & #5: Empirically test `SCRUB_ALL_TEXT_READS` (`R3_1a`/`R3_1b`) and `--continue`/`--resume` `.jsonl` wire replay (`R3_2`) | Eval §2.0 Table 2.0a, §2.1, §2.2 | Proved clean-anchor `Edit` succeeds (`R3_1a`) and placeholder writes fail closed (`R3_1b`) under `SCRUB_ALL_TEXT_READS` -> promoted to default; proved `.jsonl` `hook_success` is `LOCAL_DISK_ONLY` (`R3_2`) -> clarified local-rest vs. v2 scrubber rationale. | Closes the largest leak vector safely and anchors `.jsonl` rationale in fact. |
| **R3-6** | Gap #6: `N = 250` cold spawns + `N = 30` Hooks-OFF vs. Hooks-ON A/B latency (`R3_3`) | Eval §3.1 | Measured `58.02 ms` p50 / `82.58 ms` max cold Win11 spawn (`N = 250`) and `+284.05 ms` p50 added overhead (`420.41 ms` ON vs. `136.36 ms` OFF, `N = 30` reads, reporting only `p50`/`max` for `N = 30`). | Replaces unbaselined `295 ms` turn figure and validates `register.js` in-process path. |
| **R3-7** | Gap #7 & #8: Honest `$24k/yr` incremental OpEx + `18.5-day` breakdown + expanded `Table 2.3a` channels | Eval §2.3a, §7.3 | Added `9.0d` Phase 2A + `9.5d` Phase 2B line items, `$24k/yr` maintenance OpEx, Pro cohort lift measurement plan, and `WebFetch`, `WebSearch`, `NotebookEdit`, `Task`/`Agent`, `Read` (`image`/`pdf`/`notebook`/`parts`), and `CLAUDE.md` coverage rows. | Replaces `$0` OpEx claim and eliminates channel blind spots. |
| **R3-8** | Smaller Items: Subtitle, 7-Gate checklist, clean standing doc + review log split, committed spike harness | Both Docs & [`test/fixtures/airlock_spike/`](../test/fixtures/airlock_spike/README.md) | Stripped `[REVISED]`/`[ADDED]` tags from `HIGHBEAM_AIRLOCK_360_EVALUATION.md`, added local `hooks.md` citation caveat, replaced numeric composite with Table 1.1 Gates, and staged sanitized harness/fixtures. | Leaves a clean, reproducible standing architecture document in `docs/`. |

---

## 3. Cross-Model Disagreements & Primary-Source Resolutions

1. **Claude Code `updatedToolOutput` ("Docs vs. Binary + Round-Trip Reality")**:
   * *Round 2 Counter-Point*: Upstream docs advertised `updatedToolOutput` across all built-in tools (`v2.1.121+`), questioning cautious Domain 1 scoring.
   * *Empirical Resolution (`v2.1.325`)*: Loopback testing confirmed `updatedToolOutput` scrubs wire and `.jsonl` across all tested tools **only** when matching strict Zod `sdk-tools.d.ts` shapes (meaning upstream schema changes fail silently open unless guarded by `FM-11`). Simultaneously, binary tests uncovered `Edit.validateInput()` blocking `old_string` unvaulting and `.jsonl` `hook_success` persistence—validating why wire/disk verification was non-negotiable.
2. **File-Link Scrubbing on `Read` (`R3_1a` / `R3_1b`)**:
   * *Post-Track A Revision*: After Round 2/Track A, our draft excluded editable files from `PostToolUse(Read)` scrubbing to avoid `Edit.validateInput()` errors. The Round 3 review challenged that as a UX trade-off rather than a safety risk; **`R3_1a` and `R3_1b` empirically confirmed the reviewer was right** (`0` file corruptions, clean-anchor `Edit`s work, placeholder edits halt cleanly at `FM-1`), so `SCRUB_ALL_TEXT_READS` is now the default on Claude Code.
3. **Antigravity Dual-Host Parity**:
   * *Primary-Source Resolution (`agy-customizations/docs/hooks.md`, unredistributed local file)*: Confirmed `PostToolUse` does not expose tool outputs on Antigravity, permanently scoping Antigravity hooks to `PreToolUse` / `PreInvocation` guard mode in both subtitle and `Table 2.3a`.

---

## 4. Assumptions to Validate Register (`A-1` to `A-7`)

| ID | Assumption Statement | Status | Verification Method & Target Milestone |
| :---: | :--- | :---: | :--- |
| **A-1** | **Claude Code `v2.1.325` Wire, `.jsonl`, `Edit` & `--resume` Replay Integrity** | **VERIFIED (Track A & R3)** | `18` scenarios (`S1a`–`S7`, `F1`–`F5`) + `R3_1`–`R3_3` archived in [`spike_empirical_results.json`](../test/fixtures/airlock_spike/spike_empirical_results.json). Continuous `latest` CI canary ([`airlock-schema-canary.yml`](../.github/workflows/airlock-schema-canary.yml)) active in CI. |
| **A-2** | **Antigravity `PreToolUse` `deny`, `PreInvocation` `terminate` & `overwrite` Safety** | **VERIFIED (Track B Protojson & Live Transcript)** | Verified against `agy-customizations/docs/hooks.md`, 940-step live `transcript.jsonl` (`read_file`/`write_file`/`edit_file`/`run_command`), and real CLI subprocesses across `src/hooks/*` & `hooks/*` in [`airlock_stateless_v1_proofs.test.mjs`](../test/airlock_stateless_v1_proofs.test.mjs) (`Suite 5.1`–`5.1b`); `overwrite` confirmed unused in Stateless v1. |
| **A-3** | **Stateless v1 Build Effort (`18.5` Engineering Days = `9.0d` 2A + `9.5d` 2B)** | **UNVERIFIED ASSUMPTION** | Track actuals against Phase 2A/2B deliverables across [pre-tool-use.mjs](../hooks/handlers/pre-tool-use.mjs) & [post-tool-use.mjs](../hooks/handlers/post-tool-use.mjs). |
| **A-4** | **3-OS `100 KB` + `10,000`-Term Aho-Corasick Latency (`< 6 ms` Target JS)** | **WIN11 `100 KB x 10k` VERIFIED (3-OS CI Active)** | `2.40 ms` p50 / `4.61 ms` p99 at `100 KB x 10,000` terms (`N = 250`) via [`benchmark_airlock.mjs`](../scripts/benchmark_airlock.mjs); 3-OS CI canary ([`airlock-schema-canary.yml`](../.github/workflows/airlock-schema-canary.yml)) active for Ubuntu/macOS capture. |
| **A-5** | **`< 0.1%` Per-Line False-Positive Rate & `< 5%` Write-Only Placeholder Stall Rate** | **VERIFIED IN CI SUITE** | `0.0002% < 0.1%` Stage 1–2 FP across `500,000` lines in [`benchmark_airlock.mjs`](../scripts/benchmark_airlock.mjs); `< 5%` stall rate & `0` >2-strike loops across `30` sessions in [`airlock_stateless_v1_proofs.test.mjs`](../test/airlock_stateless_v1_proofs.test.mjs) (`Suite 5.3`); Stage 3 kept `AUDIT_ONLY`. |
| **A-6** | **Bundled Airlock Lifts `ctxtop Pro` Conversion/Retention Beyond `$24k/yr` Incremental Cost** | **UNVERIFIED ASSUMPTION** | Run 15 structured buyer interviews at `v4.0` launch + 30-day Pro trial cohort A/B (`N >= 200`/arm) post-GA. |
| **A-7** | **Competitor Funding / Acquisition Estimates (§7.1)** | **UNVERIFIED ASSUMPTION** | Press-reported figures only; verify against primary filings or omit from commercial sales collateral. |
