# Smart-Compact & Compaction-Switch Benchmark — Final Summary (`summary_smart_compact.md`)

- **Status:** Paid runs stopped after Pilot (`n = 1`), Stage A (`n = 3`), and Stage A2 (`n = 2`).
- **Live Sessions Executed:** `6` thirty-turn sessions (`180` human turns; **`362` billed `/v1/messages` requests** + `26` unbilled `/v1/messages/count_tokens` side calls = **`388` total wire records**).
- **Total Spend (`6` runs, live & settled):** **`$8.229247`** (`$8.23` of `$22.00` hard ceiling; OpenRouter `/api/v1/key` usage moved from `$39.663400` before Pilot to `$47.892647` settled after Stage A2, delta **`$8.229247`**, matching wire-summed `upstreamReportedCostUsd` to `$0.000000`).
- **Billed Rate Card (OpenRouter, `Anthropic` provider pinned, `allow_fallbacks: false`):**
  - `anthropic/claude-opus-4.6`: `$5.00` input / `$6.25` 5m cache write / `$0.50` cache read / `$25.00` output per MTok.
  - `anthropic/claude-sonnet-4.6`: `$3.00` input / `$3.75` 5m cache write / `$0.30` cache read / `$15.00` output per MTok.

---

## 1. Limitations & Scope Boundaries (Read First)

1. **Small sample size (`n = 2` per condition):**
   - Fixture `v1` (`3.13x–3.70x` `compact_boundary` compression at Turn 20): `n = 2` with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`C1_r02`, `C1_r03`) and `n = 2` with stock auto-memory enabled (`C1_r01`, `C1mem_r02`).
   - Fixture `v2` (`26.21x–28.10x` `compact_boundary` compression at Turn 20, `~139k` pre-compaction input tokens): `n = 2` with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`C1_v2_r01`, `C1_v2_r02`).
   - `n = 2` per cell demonstrates repeatability on deterministic probes but cannot bound low-frequency tail losses (e.g., `<20%` per-compaction violation rates).
2. **Scripted 30-turn fixtures (`v1` and `v2`):**
   - Both workloads are scripted 30-turn Node.js coding sessions (`20` pre-compaction turns, manual `/compact` at Turn 20, `10` post-compaction probe/work turns) making real edits and test runs in an isolated copy of a synthetic 6-file repository. Unscripted human sessions exhibit messier multi-topic drift and longer sessions with multiple compactions.
3. **Session & summarization model (`anthropic/claude-sonnet-4.6`, effort `medium`):**
   - Phase 0 confirmed that Claude Code sends the `/compact` summarization call to the active session model. All `6` live runs used `claude-sonnet-4.6` (`effort = medium`), chosen for cost control; Haiku 4.5 and Opus 4.6 summarization quality were not live-tested.
4. **OpenRouter route:**
   - All live calls traversed a local wire-recording proxy to OpenRouter pinned to `Anthropic` (`allow_fallbacks: false`), reconciled to settled `/api/v1/key` accounting.
5. **Phase 1 task-boundary detector is unverified on real multi-task human sessions:**
   - The `78` pre-existing benchmark transcripts (`1,240` turns) contain `0` task boundaries, and the `6` live Phase 2 transcripts (`180` turns) follow scripted 30-turn plans authored in the same study. Real-world precision and false-prompt rates on organic human coding sessions remain **unverified**.
6. **`C0` (no-compaction control) and `S-A`/`S-D` (model switch at compaction) economics are computed, not live-measured:**
   - Per the staged gate decisions, `C0` and `S-A`/`S-D` were not run as separate paid arms; both are **computed directly from the measured per-request wire token logs and Turn 21 cache layer splits**.

---

## 2. Pre-Registration Audit, Verbatim `preregistration_fixture_v2.json`, and Predicted vs. Observed `v2` Outcome

### 2.1 Audit of Contradiction Between Earlier Stage A2 Report and Rejected Summary Draft

- **Which report was right and which was wrong:** The earlier **Stage A2 report (`results/smart_compact/stage_a2_v2_summary.json`) was right**, and the **previous draft of `summary_smart_compact.md` was wrong**.
- **Why the previous `summary_smart_compact.md` draft was wrong:** `stage_a2_v2_summary.json` was written programmatically by `run_smart_compact_stage_a2_v2.mjs` directly from `preregistration_fixture_v2.json`, the live transcripts, and the wire logs. By contrast, the rejected `summary_smart_compact.md` draft was composed manually from degraded late-session context memory without re-reading `preregistration_fixture_v2.json` or `stage_a2_v2_summary.json`. As a result, that draft fabricated probe IDs and details (`V1`–`V6`, `totalMs`/`durationMs`, `E_RANGE_WINDOW`, `docs/arch-notes.md`, `fnv1aHash`, `Q1` recalling `"42"` for `0.5/1` partial credit, and timestamp `2026-11-15T01:02:00Z`) that never existed in `preregistration_fixture_v2.json` or in the `v2` fixture. Every figure in this corrected report is generated deterministically from the raw files via `build_smart_compact_deliverables.mjs`.

### 2.2 Pre-Registration File Provenance & Timestamp Verification

| Verification Field | Measured Value from Disk & Wire Log | Source |
| :--- | :--- | :--- |
| **File Path** | `results/smart_compact/preregistration_fixture_v2.json` (`6,496` bytes) | Filesystem (`fs.statSync`) |
| **SHA-256 Digest** | `c1776d6f55b7ce94550d57949410c09af2ecdb4511d827412ea4f8c2d0e9803f` | `crypto.createHash('sha256')` |
| **Filesystem `mtime` / `birthtime` (UTC)** | **`2026-11-15T02:09:20.372Z`** (`2026-11-14T21:09:20.372-05:00`) | Filesystem (`fs.statSync`) |
| **JSON `preregisteredAt` Field (Line 3)** | `"2026-11-14T21:10:00-05:00"` (`2026-11-15T02:10:00.000Z`, minute-rounded in JSON text) | `preregistration_fixture_v2.json` |
| **First `v2` Request Timestamp (`C1_v2_r01` `wireSeq=1`)** | **`2026-11-15T02:13:32.803Z`** (`+252.431s` / `4m 12.4s` **after** `preregistration_fixture_v2.json` `mtime`) | `stage_a2_C1_v2_r01_wire_log.jsonl` |
| **Second `v2` Run First Request (`C1_v2_r02` `wireSeq=1`)** | **`2026-11-15T02:19:52.749Z`** | `stage_a2_C1_v2_r02_wire_log.jsonl` |

### 2.3 Verbatim Contents of `preregistration_fixture_v2.json`

```json
{
  "schemaVersion": "1.0.0",
  "preregisteredAt": "2026-11-14T21:10:00-05:00",
  "fixtureVersion": "v2_only_revision",
  "stoppingRule": "This is the only fixture revision. If v2 also scores 0 violations and full recall in both C1 runs (C1_v2_r01 and C1_v2_r02), stop and report 'default compaction adequate up to ~Nx compression' as the result.",
  "targetT20ContextTokensRange": [95000, 110000],
  "costEstimateAt100kContext": {
    "derivedFrom": "v1 memory-off runs (C1_r02, C1_r03 mean: $0.5892 T1-T20, $0.1142 compact, $0.2126 T21-T30 at 42k T20 context)",
    "extraPreCompactionTokens": 58000,
    "extraCacheWriteUsd": 0.2175,
    "extraWarmCacheReadsUsd": 0.357,
    "recomputedT1ToT20BaseUsd": 1.1637,
    "recomputedCompactionCallBaseUsd": 0.1316,
    "recomputedT21ToT30BaseUsd": 0.2176,
    "recomputedPerRunBaseUsd": 1.5129,
    "recomputedPerRunPlus15PctUsd": 1.7398,
    "perRunAbortCap2xUsd": 3.48,
    "stageA2AuthorizedTotalCapUsd": 6.0,
    "overallRemainingHardStopCapUsd": 22.0
  },
  "probes": {
    "constraints": [
      {
        "id": "C_P1",
        "source": "prompt_passing_turn_2",
        "staysOnDisk": false,
        "rule": "Never add any dependencies or devDependencies to package.json.",
        "probedAtTurn": 21,
        "deterministicChecker": "JSON.parse(package.json) has 0 keys in dependencies and devDependencies."
      },
      {
        "id": "C_P2",
        "source": "prompt_passing_turn_3",
        "staysOnDisk": false,
        "rule": "Never use Buffer.concat anywhere in src/ (zero-copy policy).",
        "probedAtTurn": 22,
        "deterministicChecker": "!/Buffer\\.concat\\s*\\(/.test(allFilesInSrc)"
      },
      {
        "id": "C_P3",
        "source": "prompt_passing_turn_7_superseding_turn_2_with_stale_comment_distractor",
        "staysOnDisk": false,
        "rule": "Active RETRY_STRATEGY in src/config.mjs must be 'decorrelated_jitter' (superseding Turn 2's 'exponential_full', despite stale comment distractor in src/config.mjs).",
        "probedAtTurn": 23,
        "deterministicChecker": "src/config.mjs exports RETRY_STRATEGY = 'decorrelated_jitter' and resetRetryConfig() returns 'decorrelated_jitter' (not 'exponential_full' or 'fixed_window')."
      },
      {
        "id": "C_P4",
        "source": "prompt_passing_turn_9",
        "staysOnDisk": false,
        "rule": "Never use Map or WeakMap in src/reconciler.mjs (ruled out due to V8 megamorphic inline-cache regression; use plain Object.create(null) or Array).",
        "probedAtTurn": 24,
        "deterministicChecker": "!/\\bnew\\s+(?:Map|WeakMap)\\s*\\(/.test(src/reconciler.mjs)"
      },
      {
        "id": "C_P5",
        "source": "file_only_docs_architecture_notes_md_turn_4",
        "staysOnDisk": true,
        "note": "docs/architecture_notes.md remains on disk; wire/transcript audit records whether the agent re-reads docs/architecture_notes.md in Turns 21-24.",
        "rule": "Ports 8080 and 9090 are reserved for hardware health checks; DEFAULT_PORT and FALLBACK_PORT in src/config.mjs must remain 4100 and 4101 (never 8080 or 9090).",
        "probedAtTurn": 21,
        "deterministicChecker": "src/config.mjs has DEFAULT_PORT = 4100 and FALLBACK_PORT = 4101, and does not assign 8080 or 9090."
      },
      {
        "id": "C_P6",
        "source": "file_only_docs_architecture_notes_md_turn_4",
        "staysOnDisk": true,
        "note": "docs/architecture_notes.md remains on disk; wire/transcript audit records whether the agent re-reads docs/architecture_notes.md in Turns 21-24.",
        "rule": "src/frozenLegacy.mjs is a checksum-verified vendor file and must never be edited.",
        "probedAtTurn": 24,
        "deterministicChecker": "sha256(src/frozenLegacy.mjs) === initialFrozenLegacySha256"
      }
    ],
    "ghostRevert": {
      "id": "GR_UNSIGNED_SHIFT",
      "plantedAtTurns": [5, 6],
      "probedAtTurn": 25,
      "rule": "Turn 6 fixed signed 32-bit overflow on seq = -2147483648 in computeSlotIndex (src/reconciler.mjs) using unsigned shift ((seq >>> 0) % ringSize) and fixed negative grossCents holdback using (if (grossCents <= 0) return 0; Math.round((grossCents * bps) / 10000)). Turn 25 asks to refactor/consolidate helpers in src/reconciler.mjs.",
      "deterministicChecker": "src/reconciler.mjs retains >>> 0 and grossCents <= 0 guard, and node --test test/suite.test.mjs passes 100% at Turn 30."
    },
    "recallQuestions": [
      {
        "id": "Q1_HARD_TOOL_OUTPUT",
        "category": "Exact CLI test command and error code from Turn 8 Bash tool output only",
        "probedAtTurn": 26,
        "deterministicChecker": "Turn 26 response matches /run_diag_probe\\.mjs/i && /--strict-ring/i && /ERR_DIAG_TAIL_LOCK_819/i"
      },
      {
        "id": "Q2_SUPERSEDED_AND_RULED_OUT",
        "category": "Failed/superseded approaches (exponential_full -> decorrelated_jitter; Map/WeakMap ruled out in reconciler)",
        "probedAtTurn": 27,
        "deterministicChecker": "Turn 27 response matches /exponential_full/i && /decorrelated_jitter/i && /(?:Map|WeakMap)/i"
      },
      {
        "id": "Q3_MODIFIED_FILES",
        "category": "Modified files list in T1-T20",
        "probedAtTurn": 27,
        "deterministicChecker": "Turn 27 response names all 5 modified src/ files (reconciler.mjs, config.mjs, validator.mjs, parser.mjs, exporter.mjs) and test/suite.test.mjs"
      },
      {
        "id": "Q4_REMAINING_CHECKLIST",
        "category": "Remaining checklist item from 6-item list",
        "probedAtTurn": 28,
        "deterministicChecker": "Turn 28 response matches /ITEM-3|\\b3\\b/i && /(?:formatAuditFooter|schemaVersion|exporter\\.mjs)/i"
      },
      {
        "id": "Q5_EXACT_ERROR_CODES_AND_TEST_CMD",
        "category": "Exact test command and active error codes across src/",
        "probedAtTurn": 28,
        "deterministicChecker": "Turn 28 response matches /node\\s+--test\\s+test\\/suite\\.test\\.mjs/i && /ERR_SEQ_RING_OVERFLOW_508/i && /ERR_EMPTY_BATCH_701/i && /ERR_BATCH_CHECKSUM_704/i"
      }
    ]
  },
  "predictedC1OutcomeOnV2": {
    "predictedConstraintViolations": "1 to 2 out of 6 (most likely C_P2 Buffer.concat, C_P3 stale distractor exponential_full, C_P4 Map/WeakMap, or C_P5 file-only port 8080/9090)",
    "predictedRecallScore": "3 to 4 out of 5 (Q1 tool-output-only ERR_DIAG_TAIL_LOCK_819 and/or Q2 superseded/ruled-out details dropped under ~7.5x compression)",
    "predictedGhostRevert": "0 to 1 across 2 runs"
  }
}
```

### 2.4 Pre-Registered Prediction vs. Observed `C1_v2` Outcome (`n = 2`, Auto-Memory OFF)

| Metric | Pre-Registered Prediction (`preregistration_fixture_v2.json`) | Observed `C1_v2_r01` (Live, Billed) | Observed `C1_v2_r02` (Live, Billed) | Comparison |
| :--- | :--- | :--- | :--- | :--- |
| **`T20` Pre-Compact Context** | `95,000–110,000` tokens | `139,174` prompt tok (`139,231` `preTokens`) | `138,930` prompt tok (`138,987` `preTokens`) | Exceeded target (`~139k` tokens; `26.21x` & `28.10x` `compact_boundary` compression) |
| **Constraint Violations (`C_P1`–`C_P6`, out of `6`)** | **`1 to 2 out of 6`** (`C_P2` `Buffer.concat`, `C_P3` `exponential_full` distractor, `C_P4` `Map`/`WeakMap`, or `C_P5` file-only port `8080`/`9090`) | **`0 / 6`** (`C_P1..C_P6` all `false`) | **`0 / 6`** (`C_P1..C_P6` all `false`) | **Prediction refuted: `0` violations vs. predicted `1–2`** |
| **Post-Compact Re-Read of `docs/architecture_notes.md`** | Tracked via wire/transcript audit (`C_P5`, `C_P6` stay on disk) | **`false`** (`0` post-compact reads) | **`false`** (`0` post-compact reads) | File-only rules (`4100`/`4101`, `frozenLegacy.mjs`) survived inside the compaction summary itself |
| **Ghost Revert (`GR_UNSIGNED_SHIFT`: `(seq >>> 0) % ringSize` & `grossCents <= 0`)** | **`0 to 1` across `2` runs** | **`0`** (`unsignedShiftIntact = true`, `holdbackGuardIntact = true`, final tests pass) | **`0`** (`unsignedShiftIntact = true`, `holdbackGuardIntact = true`, final tests pass) | `0` ghost reverts in both runs |
| **Recall Score (`Q1`–`Q5`, binary `0`/`1` per question)** | **`3 to 4 out of 5`** (`Q1` tool-output-only `ERR_DIAG_TAIL_LOCK_819` and/or `Q2` dropped) | **`4 / 5`** (`Q1:0, Q2:1, Q3:1, Q4:1, Q5:1`) | **`4 / 5`** (`Q1:0, Q2:1, Q3:1, Q4:1, Q5:1`) | Matches `4/5` recall range: `Q2–Q5` `4/4` in both runs; `Q1` scored `0/1` in both runs (`C1_v2_r01` recalled neither command nor code; `C1_v2_r02` recalled `node scripts/run_diag_probe.mjs --strict-ring --batch-7` in part (a) and noted `ERR_DIAG_*` stdout was not in its summary in part (b)) |

**Plain statement of prediction vs. observation:** We predicted **`1–2` constraint violations out of `6`** under `~100k+` compression with auto-memory disabled. Observed violations were **`0 / 6` in both `C1_v2_r01` and `C1_v2_r02`** (at `139k` pre-compaction tokens / `26.21x–28.10x` compression), with `0` ghost reverts and `4 / 5` binary recall. Only `Q1` failed because `ERR_DIAG_TAIL_LOCK_819` appeared once inside a passing Turn 8 `Bash` stdout log (`node scripts/run_diag_probe.mjs --strict-ring --batch-7`) and was never mentioned in prompts or source files.

---

## 3. Per-Run Wire Request Accounting, Compaction Metrics, and Billed Costs (`6` Live Runs)

Every `*_wire_log.jsonl` file contains two request classes: billed Anthropic `/v1/messages?beta=true` completions (`T1–T20` + `1` `/compact` call + `T21–T30`) and unbilled `/v1/messages/count_tokens?beta=true` preflight side calls (`$0.000000`). Every row and column below sums identically:

| Run ID | Fixture & Auto-Memory | `T1–T20` Msgs | `/compact` Call | `T21–T30` Msgs | Total `/v1/messages` | `count_tokens` Side Calls | Total Wire Lines | `T20` Last Prompt / `preTokens` | `postTokens` (`Ratio`) | Compact Latency (`boundary` / `wire`) | Summary (`chars` / `out tok`) | Compact Cost (Billed) | `T21` Split (`warm read` / `cold write`) | Total Run Cost (Billed) | Settled `/api/v1/key` Delta | Violations / Ghost / Recall |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`C1_r01`** | `v1` Mem-**ON** | `49` | `1` | `12` | **`62`** | `4` | `66` | `49,338` / `49,409` | `13,352` (**`3.70x`**) | **`104.4s`** (`104,397 ms` / `104344 ms`) | `14,073` / `6,348` | `$0.115296` | `10,619` / `21,957` | **`$1.165405`** | **`$1.165405`** | `0/4` / `0` / `3/3` |
| **`C1mem_r02`** | `v1` Mem-**ON** | `55` | `1` | `12` | **`68`** | `4` | `72` | `50,537` / `50,618` | `13,699` (**`3.70x`**) | **`103.9s`** (`103,915 ms` / `103870 ms`) | `15,256` / `6,572` | `$0.119015` | `10,623` / `22,344` | **`$1.227996`** | **`$1.227996`** | `0/4` / `0` / `3/3` |
| **`C1_r02`** | `v1` Mem-**OFF** | `37` | `1` | `12` | **`50`** | `4` | `54` | `41,930` / `42,002` | `13,429` (**`3.13x`**) | **`103.9s`** (`103,916 ms` / `103851 ms`) | `14,368` / `6,360` | `$0.113380` | `7,627` / `21,725` | **`$0.921348`** | **`$0.921348`** | `0/4` / `0` / `3/3` |
| **`C1_r03`** | `v1` Mem-**OFF** | `37` | `1` | `12` | **`50`** | `4` | `54` | `42,085` / `42,158` | `13,230` (**`3.19x`**) | **`105.2s`** (`105,191 ms` / `105136 ms`) | `13,571` / `6,468` | `$0.115061` | `7,627` / `21,573` | **`$0.910737`** | **`$0.910737`** | `0/4` / `0` / `3/3` |
| **`C1_v2_r01`** | `v2` Mem-**OFF** | `44` | `1` | `21` | **`66`** | `5` | `71` | `139,174` / `139,231` | `5,313` (**`26.21x`**) | **`126.0s`** (`125,975 ms` / `125900 ms`) | `15,796` / `8,233` | `$0.170804` | `7,629` / `7,846` | **`$2.021380`** | **`$2.021380`** | `0/6` / `0` / `4/5` |
| **`C1_v2_r02`** | `v2` Mem-**OFF** | `44` | `1` | `21` | **`66`** | `5` | `71` | `138,930` / `138,987` | `4,946` (**`28.10x`**) | **`105.4s`** (`105,449 ms` / `105397 ms`) | `14,328` / `7,006` | `$0.152331` | `7,631` / `7,310` | **`$1.982381`** | **`$1.982381`** | `0/6` / `0` / `4/5` |
| **Total (`6` Runs)** | — | **`266`** | **`6`** | **`90`** | **`362`** (`266+6+90`) | **`26`** | **`388`** (`362+26`) | — | — | Range: **`103.9s–126.0s`** | `6,348–8,233` out tok | `$0.785887` | — | **`$8.229247`** | **`$8.229247`** | `0` violations, `0` ghost reverts |

---

## 4. Hypothesis Verdict Tables (`H1`–`H7`, Verbatim Definitions from `spec_smart_compact_tests.md`)

### `H1`: Default Compaction Loss & Ghost-Revert Rate — **Refuted (in this regime, up to `28.10x` compression)**

| Field | Detail |
| :--- | :--- |
| **Spec Claim (`H1`)** | *"Default compaction turns hard constraints into vague prose, causing 'ghost reverts' (re-introducing a fixed bug, repeating a ruled-out approach)."* |
| **Verdict** | **Refuted (in this regime, up to `28.10x` `compact_boundary` compression)** |
| **Live Evidence (`v1`, `n = 4`, Billed)** | Across `C1_r01` and `C1mem_r02` (auto-memory ON, `3.70x` [`3.695x–3.700x`]) and `C1_r02` and `C1_r03` (auto-memory OFF, `3.13x–3.19x`): **`0 / 4` constraint violations** in every run, **`0` ghost reverts**, and **`3 / 3` recall** in every run. |
| **Live Evidence (`v2`, `n = 2`, Billed)** | Across `C1_v2_r01` (`139,231 -> 5,313` tok, `26.21x`) and `C1_v2_r02` (`138,987 -> 4,946` tok, `28.10x`) with auto-memory OFF: **`0 / 6` constraint violations** (`C_P1` zero dependencies, `C_P2` no `Buffer.concat`, `C_P3` `decorrelated_jitter` superseding `exponential_full` despite stale comment distractor, `C_P4` no `Map`/`WeakMap` in `src/reconciler.mjs`, `C_P5` file-only ports `4100`/`4101` not `8080`/`9090`, `C_P6` file-only `src/frozenLegacy.mjs` untouched without re-reading `docs/architecture_notes.md`), **`0` ghost reverts** (`(seq >>> 0) % ringSize` and `grossCents <= 0` preserved during Turn 25 refactor), and **`4 / 5` recall** (`Q2–Q5` `4/4`; only `Q1`'s unreferenced `ERR_DIAG_TAIL_LOCK_819` inside passing Turn 8 `Bash` stdout was dropped). |

---

### `H2`: Preservation Instructions & `C3` `SessionStart(source=compact)` Re-Injection — **Unverified (Untested in Live Phase 2)**

| Field | Detail |
| :--- | :--- |
| **Spec Claim (`H2`)** | *"Compaction instructions that name what to preserve reduce those losses."* |
| **Arms Under `H2`** | - **`C2`:** `/compact` with the 4-item preservation template (*"Preserve verbatim: (1) all modified file paths and line ranges, (2) negative constraints and failed approaches we ruled out, (3) exact CLI test commands and current error codes, and (4) the remaining task checklist. Discard all raw file reads and passing test logs."*).<br>- **`C3` (Shippable external-state / re-injection design):** Default `/compact`, with project constraints re-injected post-compaction via `SessionStart` (`matcher: "compact"`) `hookSpecificOutput.additionalContext` (replacing the initial spec's manual STATE-file read per pre-pilot design review).<br>- **`C4`:** `/compact` with a short template (constraints and checklist only). |
| **Verdict** | **Unverified (untested in live Phase 2 — `C2`, `C3`, and `C4` not run)** |
| **Why Not Run & Phase 0 Wire Findings (`$0`)** | 1. **Stage A & Stage A2 stopping gates:** Default `C1` scored `0` constraint violations and `0` ghost reverts across all `6` runs. The sole `v2` loss (`Q1` `ERR_DIAG_TAIL_LOCK_819` inside a passing Turn 8 diagnostic script's stdout) would **not** be preserved by `C2` (which explicitly instructs *"Discard all raw file reads and passing test logs"*) nor by `C3`/`C4` (which inject static project constraints/checklists, not mid-session `Bash` stdout).<br>2. **Phase 0 `C3` & `PreCompact` mechanics (verified on localhost mock SSE):** `SessionStart(source="compact")` `hookSpecificOutput.additionalContext` injects cleanly into the post-compaction request without corrupting the summarization prompt, whereas `PreCompact` stdout is a **plain-text-only channel** (emitting JSON on `PreCompact` stdout is a trap that concatenates raw JSON text into `customInstructions`). |

---

### `H3`: Cost Overhead of Preservation Instructions — **Unverified (Untested in Live Phase 2)**

| Field | Detail |
| :--- | :--- |
| **Spec Claim (`H3`)** | *"Preservation instructions do not add unreasonable cost (summary size, summarization output tokens)."* |
| **Verdict** | **Unverified (untested — `C2`, `C3`, and `C4` not run)** |
| **Measured `C1` Baseline (Live, Billed)** | Default `/compact` (`C1`) already generates large summaries: `6,348–6,572` output tokens (`13,571–15,256` chars, `$0.113380–$0.119015` billed, `103.9s–105.2s`) on `v1` and `7,006–8,233` output tokens (`14,328–15,796` chars, `$0.152331–$0.170804` billed, `105.4s–126.0s`) on `v2`. Whether `C2`/`C4` shrink or inflate summary output tokens was not tested. |

---

### `H4`: Post-Compaction Prompt Cache Busting, Layer Split, & `C0` Cost Comparison — **Confirmed (with Measured Layer Split: `tools/system` Survives Warm on Same Model)**

| Field | Detail |
| :--- | :--- |
| **Spec Claim (`H4`)** | *"Compaction busts the whole prompt cache; the first turn after it re-writes the new, smaller prefix."* |
| **Verdict** | **Confirmed on compacted `messages` re-write, with measured layer split (`tools + system[0..1]` survives warm on the same model in `6/6` live runs; `C0` comparison computed, not live-measured)** |
| **Live-Measured `T21` Layer Split (`6/6` Runs)** | Compaction does **not** bust the whole prompt cache on the same model. Because Claude Code places an ephemeral cache breakpoint at `system[1]` ahead of `system[2]` and `messages`, `tools + system[0..1]` hits **warm `cache_read_input_tokens`** on `T21` req 1 in every run:<br>- `v1` Mem-ON (`C1_r01`, `C1mem_r02`): **`10,619` / `10,623` warm `cache_read`** vs. **`21,957` / `22,344` cold `cache_creation`** (`system[2]` `MEMORY.md` + compacted summary + preserved tail).<br>- `v1` Mem-OFF (`C1_r02`, `C1_r03`): **`7,627` / `7,627` warm `cache_read`** vs. **`21,725` / `21,573` cold `cache_creation`**.<br>- `v2` Mem-OFF (`C1_v2_r01`, `C1_v2_r02`): **`7,629` / `7,631` warm `cache_read`** vs. **`7,846` / `7,310` cold `cache_creation`**. |

#### Single Recomputed `C1` vs. `C0` (No-Compaction) Cost Comparison (`Computed` from Wire Logs)

Let $P_{\text{pre}}$ be the total prompt tokens on the final pre-compaction request at `T20`, $P_{\text{post}}$ be the total prompt tokens on the first post-compaction request at `T21`, $\Delta P = P_{\text{pre}} - P_{\text{post}}$ be the cached prompt tokens shed on every one of the $N_{\text{post}}$ post-compaction `/v1/messages` requests (`T21–T30`), $C_{\text{compact}}$ be the billed `/compact` call cost, and $cw_{21}$ be `T21` req 1's `cache_creation_input_tokens`. Full cold-write cost of $cw_{21}$ is $cw_{21} \times \$3.75/\text{MTok}$, which represents a cold-write surcharge of $S_{\text{cold}} = cw_{21} \times (\$3.75 - \$0.30)/\text{MTok} = cw_{21} \times \$3.45/\text{MTok}$ above the warm cache read `C0` would have paid on those tokens (charging the entire $cw_{21}$ surcharge to `C1` is conservative by `~$0.0005` for the `~150`-token `T21` user prompt). Across `T21–T30`:

$$G_{\text{read}} = N_{\text{post}} \times \Delta P \times \frac{\$0.30}{10^6}, \quad C_0(\text{T21–T30}) = C_1(\text{T21–T30}) - S_{\text{cold}} + G_{\text{read}}, \quad \text{Net }(C_1 - C_0) = C_{\text{compact}} + S_{\text{cold}} - G_{\text{read}}$$

| Run ID | $N_{\text{post}}$ Reqs (`T21–T30`) | $P_{\text{pre}}$ (`T20`) | $P_{\text{post}}$ (`T21`) | $\Delta P$ Tokens Shed / Req | Gross Read Saved $G_{\text{read}}$ (`$0.30/M`) | Billed $C_{\text{compact}}$ | `T21` Cold Write ($cw_{21}$ Full `$3.75/M` / Surcharge $S_{\text{cold}}$ `$3.45/M`) | Billed $C_1$ (`Compact + T21–T30`) | Computed $C_0$ (`T21–T30`) | **Net $C_1 - C_0$ (Computed)** | Payback Reqs |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`C1_r01`** | `12` | `49,338` | `32,579` | `16,759` | `-$0.060332` | `+$0.115296` | `$0.082339` / `+$0.075752` | `$0.340430` | `$0.209715` | **`+$0.130715`** | `38` reqs |
| **`C1mem_r02`** | `12` | `50,537` | `32,970` | `17,567` | `-$0.063241` | `+$0.119015` | `$0.083790` / `+$0.077087` | `$0.348862` | `$0.216001` | **`+$0.132861`** | `38` reqs |
| **`C1_r02`** | `12` | `41,930` | `29,355` | `12,575` | `-$0.045270` | `+$0.113380` | `$0.081469` / `+$0.074951` | `$0.326172` | `$0.183111` | **`+$0.143061`** | `50` reqs |
| **`C1_r03`** | `12` | `42,085` | `29,203` | `12,882` | `-$0.046375` | `+$0.115061` | `$0.080899` / `+$0.074427` | `$0.327423` | `$0.184310` | **`+$0.143113`** | `50` reqs |
| **`C1_v2_r01`** | `21` | `139,174` | `15,478` | `123,696` | `-$0.779285` | `+$0.170804` | `$0.029423` / `+$0.027069` | `$0.411443` | `$0.992855` | **`-$0.581412`** | `6` reqs |
| **`C1_v2_r02`** | `21` | `138,930` | `14,944` | `123,986` | `-$0.781112` | `+$0.152331` | `$0.027412` / `+$0.025219` | `$0.394927` | `$0.998488` | **`-$0.603561`** | `5` reqs |

- **Interpretation:** At `~139k` pre-compaction context (`v2`, `21` post-compaction requests shedding `~123,841` tokens/req), `/compact` pays back its upfront cost (`$0.1776–$0.1979`) by **request `5–6`** and saves **`-$0.581412` to `-$0.603561`** (mean **`-$0.592487`**) over `T21–T30`. At `~42k–50k` context (`v1`, `12` post-compaction requests shedding `12,575–17,567` tokens/req), `12` requests are too few to amortize the compaction call + `T21` cold write (`+$0.130715` to `+$0.143113` net; break-even requires `38–50` post-compaction requests).

---

### `H5`: Task-Boundary vs. Mid-Debug Compaction Timing — **Unverified (Untested in Live Phase 2)**

| Field | Detail |
| :--- | :--- |
| **Spec Claim (`H5`)** | *"Compacting at a task boundary loses less than compacting mid-debug."* |
| **Verdict** | **Unverified (untested — `T1` and `C2` not run)** |
| **Reason Not Run** | Gated off after Stage A and Stage A2 showed `0` constraint violations and `0` ghost reverts under default `/compact`. |

---

### `H6`: Downshift (`Opus 4.6 -> Sonnet 4.6`) or Effort Change Right After Compaction — **Confirmed (`"computed from a measured cache split"`)**

| Field | Detail |
| :--- | :--- |
| **Spec Claim (`H6`)** | *"A model switch or effort change applied right after a compaction costs no extra cache penalty, compared with switching without a compaction."* |
| **Verdict** | **Confirmed as `"computed from a measured cache split"` for `Opus 4.6 -> Sonnet 4.6` (`S-A` vs. `S-D` and `S-C`); live-measured `$0` cache penalty for effort-only change in prior benchmark Arm D (`99.99%` warm cache hit preserved)** |
| **Why `Opus 4.6 -> Sonnet 4.6` at Compaction Works** | Under `S-D` (compact on Opus, **stay on Opus**), `messages` (`cw_{21}`) is already busted by compaction and must be written cold at Opus's `$6.25/MTok`, while only `tools + system[0..1]` (`cr_{21}`) reads warm at `$0.50/MTok`. Under `S-A` (compact on Opus, **switch immediately to Sonnet 4.6**), `cr_{21} + cw_{21}` are both written cold at Sonnet's `$3.75/MTok`: forfeiting Opus warmth on `cr_{21}` costs `cr_{21} × ($3.75 - $0.50)/MTok = +$3.25/MTok`, while writing `cw_{21}` on Sonnet instead of Opus **saves** `cw_{21} × ($6.25 - $3.75)/MTok = -$2.50/MTok`! Meanwhile, switching without compaction (`S-C`) must cold-write the entire uncompacted prefix $P_{\text{pre}}$ (`42k–139k` tokens) at `$3.75/MTok`. |

#### `Opus 4.6 -> Sonnet 4.6` Downshift Computed Across Both Measured Splits (`v1` and `v2`, Billed Rate Card)

Rates: **Opus 4.6** `$5.00` in / `$6.25` write / `$0.50` read / `$25.00` out per MTok; **Sonnet 4.6** `$3.00` in / `$3.75` write / `$0.30` read / `$15.00` out per MTok.

| Run ID (Split Regime) | `T21` Split (`cr_{21}` `tools/sys` + `cw_{21}` `msgs`) | `S-D` Req 1 Prompt (Stay Opus) | `S-A` Req 1 Prompt (Switch Sonnet) | Req 1 Prompt Delta (`S-A - S-D`) | Req 1 Total Delta Incl. Output (`S-A - S-D`) | **Payback vs. `S-D` (Prompt / Total)** | `T21–T30` Total (`S-D` Opus vs. `S-A` Sonnet) | **Net Post-Compact Saving (`S-D - S-A`)** | `S-C` Req 1 Prompt (Switch w/o Compact) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`C1_r01`** (`v1` Mem-ON) | `10,619` + `21,957` | `$0.142556` | `$0.122169` | **`-$0.020387`** | `-$0.021297` | **`1 req`** / **`1 req`** | `$0.375224` vs. `$0.261770` | **`+$0.113454`** (`12` reqs) | `$0.185027` |
| **`C1mem_r02`** (`v1` Mem-ON) | `10,623` + `22,344` | `$0.144977` | `$0.123635` | **`-$0.021341`** | `-$0.021871` | **`1 req`** / **`1 req`** | `$0.383079` vs. `$0.266496` | **`+$0.116582`** (`12` reqs) | `$0.189523` |
| **`C1_r02`** (`v1` Mem-OFF) | `7,627` + `21,725` | `$0.139610` | `$0.110079` | **`-$0.029531`** | `-$0.030441` | **`1 req`** / **`1 req`** | `$0.354653` vs. `$0.239105` | **`+$0.115548`** (`12` reqs) | `$0.157247` |
| **`C1_r03`** (`v1` Mem-OFF) | `7,627` + `21,573` | `$0.138660` | `$0.109509` | **`-$0.029151`** | `-$0.030151` | **`1 req`** / **`1 req`** | `$0.353936` vs. `$0.238675` | **`+$0.115261`** (`12` reqs) | `$0.157828` |
| **`C1_v2_r01`** (`v2` Mem-OFF) | `7,629` + `7,846` | `$0.052867` | `$0.058040` | **`+$0.005173`** | `+$0.001093` | **`3 req`** / **`2 req`** | `$0.401065` vs. `$0.266959` | **`+$0.134106`** (`21` reqs) | `$0.521911` |
| **`C1_v2_r02`** (`v2` Mem-OFF) | `7,631` + `7,310` | `$0.049518` | `$0.056038` | **`+$0.006520`** | `+$0.002900` | **`3 req`** / **`2 req`** | `$0.404327` vs. `$0.268923` | **`+$0.135404`** (`21` reqs) | `$0.520996` |

- **`v1` Split Result (`n = 4`, Computed):** Because `cw_{21}` (`21,573–22,344` tok) is larger than `cr_{21}` (`7,627–10,623` tok), `S-A` is **cheaper than staying on Opus (`S-D`) on the very first post-compaction request** by **`-$0.020387` to `-$0.029531` prompt** (**`-$0.021297` to `-$0.030441` total**; **payback = `1` request**, i.e., immediate saving with zero payback delay), and saves **`$0.113454–$0.116582`** over the `12` post-compaction requests (`~$0.0084/req` after `T21`).
- **`v2` Split Result (`n = 2`, Computed):** Because `v2` compressed `messages` `26.2x–28.1x` down to `7,310–7,846` tokens, `S-A` pays a tiny first-request increment of **`+$0.005173` (`C1_v2_r01`) to `+$0.006520` (`C1_v2_r02`) on prompt** (**`+$0.001093` to `+$0.002900` total** including `T21` output), which pays back by **request `2` (total cost)** and **request `3` (prompt-only cost)**, saving **`$0.134106–$0.135404`** across the `21` post-compaction requests — while avoiding `S-C`'s `$0.520996–$0.521911` uncompacted switch prompt cost (`-$0.463871` to `-$0.464958` saved on the switch request alone).

---

### `H7`: Offline & Scripted-Plan Task-Boundary Detector — **Unverified**

| Field | Detail |
| :--- | :--- |
| **Spec Claim (`H7`)** | *"A test-pass boundary can be detected well enough to suggest a compaction without too many false prompts."* |
| **Verdict** | **Unverified** |
| **Detector Implementation & Change Audit** | `evaluateSessionBoundaryDetector` (`run_smart_compact_phase0_phase1.mjs` lines 42–80 and `run_smart_compact_pilot.mjs` lines 23–57) tracks two booleans/counters per human turn: `openFailure` (a test command failed) and `editsSinceBoundary` (a file edit tool ran). When a turn executes a test command (`TEST_CMD_REGEX`) that passes (`testPassed && !testFailed`) while `openFailure || editsSinceBoundary > 0`, it emits `detector_state = "task_boundary"`, `detector_suggest_compact = true`, and resets both states.<br>**Detector change log:** **Zero changes were made to the detector after Phase 0/1.** The code in `run_smart_compact_phase0_phase1.mjs` and `run_smart_compact_pilot.mjs` (imported unchanged by Stage A and Stage A2) is identical; no second detector version, `boundary_detector.mjs`, `git commit` rule, or cooldown was ever written or tuned on the test set. |

#### Measured Replay Table (`results/smart_compact/phase1_boundary_detector.csv`, `1,420` Rows)

| Dataset Group | Sessions | Turns | Scripted `task_boundary` | Scripted `mid_debug` | Scripted `other` | TP | FP | FN | TN | Precision | Recall | False Prompts / 100 Turns | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Existing Benchmark Transcripts** (`C1, C2, Cal, TH`) | `78` | `1,240` | `0` | `0` | `1,240` | `0` | `0` | `0` | `1,240` | N/A (`0/0`) | N/A (`0/0`) | **`0.00`** | **Unverified (`0` boundaries)** |
| **Live Phase 2 Runs (`6` runs × `30` turns, scripted turn-plan labels)** | `6` | `180` | `24` (`T6, T12, T16, T20` × `6`) | `12` (`T5, T15` × `6`) | `144` | **`24`** | **`6`** (`T30` × `6`) | **`0`** | **`150`** | **`80.00%` (`24/30`)** | **`100.00%` (`24/24`)** | **`3.33`** | **Unverified (same-author scripted plans)** |

- **Why `T30` is an `FP` in every Phase 2 run:** Turn 29 edits `src/exporter.mjs` (`editsSinceBoundary = 1`) and Turn 30 runs `node --test test/suite.test.mjs` (passes), so the detector fires `detector_suggest_compact = true` at Turn 30; the scripted turn plan labels Turn 30 `other` because the session ends after Turn 30 rather than starting new work.

---

## 5. Additional Empirical Findings: Compaction Latency, Auto-Memory Cost Difference, & Phase 0 Constraints

1. **Compaction-call wall-clock latency (`103.9s–126.0s` synchronous block, Live):**
   - Across all `6` runs, `/compact` blocked the session for **`103,915 ms` to `105,191 ms` (`103.9s–105.2s`)** on `v1` (`6,348–6,572` output tokens) and **`105,449 ms` (`105.4s`) to `125,975 ms` (`126.0s`)** on `v2` (`7,006–8,233` output tokens). Wire HTTP round-trip latency was `103.85s–125.90s` (`TTFB ~1.08s–1.35s`), dominated by generating `6.3k–8.2k` summary output tokens at `~61–66 tok/s`.
2. **Auto-memory cost difference on `v1` (`-23.5%` cost, `-23.1%` `/v1/messages` requests, `n = 2` vs. `2`, Live & Billed):**
   - **Auto-Memory ON (`C1_r01`, `C1mem_r02`):** mean **`65.0` `[62–68]`** `/v1/messages` requests, `10,621` warm `tools/system` tokens at `T21`, mean cost **`$1.1967005`** (`[$1.165405–$1.227996]`).
   - **Auto-Memory OFF (`C1_r02`, `C1_r03`):** mean **`50.0` `[50–50]`** `/v1/messages` requests (`0/50` wire requests carrying `MEMORY.md` in `system[2]`), `7,627` warm `tools/system` tokens at `T21`, mean cost **`$0.9160425`** (`[$0.910737–$0.921348]`).
   - **Empirical delta (OFF vs. ON):** **`-15.0` requests (`-23.1%`)** and **`-$0.280658` (`-23.5%`)** per 30-turn session, driven by Turn 2 `MEMORY.md` persistence tool calls and the larger `system` prompt. This is reported strictly as a **cost measurement**, **not** a recommendation to disable auto-memory where cross-session memory is desired.
3. **Phase 0 Claude Code 2.1.325 hook constraints (`$0` mock-SSE & binary audit):**
   - `PreCompact` fires on both `manual` and `auto` triggers, but its `stdout` is treated strictly as **plain text** appended to summarization instructions — emitting JSON on `PreCompact` `stdout` injects raw JSON into the prompt. `CLAUDE.md` has no special `Compact Instructions` parser beyond normal system-context inclusion. `PostCompact` cannot inject context or switch models, whereas `SessionStart(matcher: "compact")` supports `hookSpecificOutput.additionalContext`, and a stream-json SDK host can issue `set_model` immediately after `compact_boundary`.

---

## 6. Zero-Dollar (`$0`) Auto Mode Proposal

1. **(a) Apply a held `Opus 4.6 -> Sonnet 4.6` downshift at the next compaction:**
   - Using the billed rate card (`Opus 4.6`: `$5.00 / $6.25 / $0.50 / $25.00` per MTok; `Sonnet 4.6`: `$3.00 / $3.75 / $0.30 / $15.00` per MTok), mid-session downshifting without compaction (`S-C`) must cold-write the entire `42k–139k` prefix on Sonnet (`$0.1572–$0.5219` upfront), which is why Auto mode holds Opus on warm caches.
   - When Auto mode holds a pending `Opus 4.6 -> Sonnet 4.6` downshift, **queue it and apply `set_model` immediately after the next `compact_boundary` (`S-A`)**:
     - On `v1` cache splits (`7.6k–10.6k` `tools/system` + `21.6k–22.3k` `messages`), switching to Sonnet 4.6 is **immediately cheaper on request `1`** (`-$0.0204` to `-$0.0295` prompt; **payback = `1` request**).
     - On `v2` high-compression splits (`7.6k` `tools/system` + `7.3k–7.8k` `messages`), the first-request prompt increment is only `+$0.0052` to `+$0.0065` (`+$0.0011` to `+$0.0029` total), achieving **payback in `2` requests (total cost) / `3` requests (prompt-only cost)** and saving `$0.1341–$0.1354` over the next `21` requests.
   - Scope is restricted to `Opus 4.6 -> Sonnet 4.6` (untested `Sonnet -> Haiku` downshifts are excluded).
2. **(b) Suggestion-only compaction prompt at detected task boundaries — gated OFF by default:**
   - Surface a non-blocking suggestion (never an automatic `/compact`, given the `103.9s–126.0s` synchronous pause and negative `C1 - C0` ROI at `~42k–50k` context) only when context is large (e.g., `>=100k` tokens, where `v2` achieved `5–6` request payback) and a test-pass boundary fires. Keep **gated OFF by default** until `evaluateSessionBoundaryDetector` is validated on organic human transcripts (`H7`).
3. **(c) No changes to compaction instructions:**
   - Do **not** ship custom `PreCompact` templates (`C2`/`C4`) or `SessionStart(source=compact)` constraint re-injection (`C3`). Stock `/compact` achieved `0` constraint violations and `0` ghost reverts up to `28.10x` compression (`139k -> 4.9k` tokens).

---

## 7. Corrections Log (Rejected `summary_smart_compact.md` Draft vs. Raw-Verified Report)

| Item | Rejected `summary_smart_compact.md` Draft (Incorrect) | Corrected Report (Verified from Raw Files) | Raw Source File |
| :--- | :--- | :--- | :--- |
| **1. `v2` Constraint IDs & Rules** | Listed `V1`–`V6` (`totalMs`/`durationMs`, `E_RANGE_WINDOW`, `docs/arch-notes.md`, `fnv1aHash`) | **`C_P1`–`C_P6`** (no deps in `package.json`, no `Buffer.concat`, `decorrelated_jitter` vs. `exponential_full`, no `Map`/`WeakMap` in `src/reconciler.mjs`, ports `4100`/`4101` in `docs/architecture_notes.md`, `src/frozenLegacy.mjs` SHA-256) | `preregistration_fixture_v2.json`, `stage_a2_v2_summary.json` |
| **2. `v2` Ghost-Revert Probe** | `>>> 0` in `fnv1aHash`; predicted `0` ghost reverts | **`GR_UNSIGNED_SHIFT`**: `(seq >>> 0) % ringSize` and `if (grossCents <= 0) return 0` in `computeSlotIndex`/`src/reconciler.mjs`; predicted `0 to 1` across `2` runs, observed `0` | `preregistration_fixture_v2.json`, `stage_a2_v2_summary.json` |
| **3. `v2` Recall `Q1` Definition & Scoring** | Claimed `Q1` recalled `"42"` and scored `0.5/1` (`4.0/5`) | `Q1_HARD_TOOL_OUTPUT` tested `run_diag_probe.mjs --strict-ring` + `ERR_DIAG_TAIL_LOCK_819` (binary `0`/`1`): `C1_v2_r01` recalled neither (`0/1`), `C1_v2_r02` recalled `node scripts/run_diag_probe.mjs --strict-ring --batch-7` in (a) and missed `ERR_DIAG_TAIL_LOCK_819` in (b) (`0/1`), scoring integer **`4 / 5` (`Q1:0, Q2:1, Q3:1, Q4:1, Q5:1`)** | `preregistration_fixture_v2.json`, `stage_a2_v2_summary.json` |
| **4. Pre-Registration Timestamp & Provenance** | Claimed `2026-11-15T01:02:00Z` (which predated Stage A completion and `v2` approval); target `95k–115k` | Real `mtime`: **`2026-11-15T02:09:20.372Z`**; JSON `preregisteredAt`: `"2026-11-14T21:10:00-05:00"`; first `v2` wire request: **`2026-11-15T02:13:32.803Z`** (`+252.431s` later); SHA-256: `c1776d6f55b7ce94550d57949410c09af2ecdb4511d827412ea4f8c2d0e9803f`; target `[95000, 110000]` | `preregistration_fixture_v2.json`, `stage_a2_C1_v2_r01_wire_log.jsonl` |
| **5. Hypothesis Definitions (`H1`–`H7`) & `C3` Placement** | Paraphrased `H1`–`H7` and put `C3` (`SessionStart`) as a standalone `H3` instead of `H3` = instruction cost | Restored exact verbatim `H1`–`H7` claims from `spec_smart_compact_tests.md`; placed `C3` (`SessionStart(source=compact)` re-injection) under **`H2`** alongside `C2`/`C4`, and restored **`H3`** to instruction summary-size/cost overhead | `spec_smart_compact_tests.md` |
| **6. Phase 1 Detector Boundaries & Precision** | Claimed `boundary_detector.mjs` 4-signal heuristic (`git commit`, 4-turn cooldown), boundaries `T8, T14` (`T24` excluded), `TP = 12/12`, `FP = 0`, Precision `100%` | **Zero detector changes were ever made.** `evaluateSessionBoundaryDetector` evaluated `T6, T12, T16, T20` = **`4` TP/run (`24` TPs)**, `T30` = **`1` FP/run (`6` FPs)**, `0` FN -> **Precision `80.00%` (`24/30`)**, **Recall `100.00%` (`24/24`)**, `3.33` false prompts/100 turns on Phase 2 (`0.00` on `1,240` existing turns) | `phase1_boundary_detector.csv`, `run_smart_compact_phase0_phase1.mjs`, `run_smart_compact_pilot.mjs` |
| **7. Wire Request Counts (`C1mem_r02` & Totals)** | Listed `C1mem_r02 = 65` reqs, total `376` `/v1/messages` reqs, and Mem-ON mean `63.5` (`-13.5` / `-21.3%`) | `C1mem_r02` = **`68`** `/v1/messages` reqs (`55 + 1 + 12`) + `4` `count_tokens` = `72` wire lines; total across `6` runs = **`362` `/v1/messages` reqs** (`62+68+50+50+66+66`) + **`26` `count_tokens`** = **`388` wire lines**; Mem-ON mean = **`65.0`** vs. Mem-OFF **`50.0`** (`-15.0` reqs / `-23.1%`) | All 6 `*_wire_log.jsonl` files, `stage_a_summary.json` |
| **8. `C0` Counterfactual Arithmetic** | Used `22` post-compact reqs for `v2` (actual `21`), `15` for `v1` (actual `12`), and full `$3.75/M` instead of `$3.45/M` surcharge (`-$0.6290` `v2`, `+$0.1369` `v1`) | Recomputed once from exact wire counts (`21` post-compact reqs in `v2`, `12` in `v1`) and `$3.45/MTok` cold-write surcharge: `C1_v2_r01` **`-$0.581412`** (payback `6` reqs), `C1_v2_r02` **`-$0.603561`** (payback `5` reqs), `v1` Mem-OFF **`+$0.143061` / `+$0.143113`**, `v1` Mem-ON **`+$0.130715` / `+$0.132861`** | All 6 `*_wire_log.jsonl` files |
| **9. `H6` Direction & Proposal (a) Rate Card / Payback** | Led `H6` with `Sonnet -> Opus` upshift; Proposal (a) cited `$75/MTok` (Opus 3 rate), payback in turns, and untested `Sonnet -> Haiku` | Led `H6` with **`Opus 4.6 -> Sonnet 4.6` downshift (`S-A` vs. `S-D` and `S-C`)** across both `v1` and `v2` splits using billed rates (`Opus 4.6` `$5/$6.25/$0.50/$25`, `Sonnet 4.6` `$3/$3.75/$0.30/$15`), payback in **requests** (`1` req on `v1`; `2` reqs total / `3` reqs prompt on `v2`), and removed `Sonnet -> Haiku` | `spec_smart_compact_tests.md`, `stage_a_summary.json`, all 6 `*_wire_log.jsonl` files |
