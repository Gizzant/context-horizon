# Smart-Compact Phase 0, Phase 1 (Unverified), Pilot `C1_r01`, & Recomputed Phase 2 Cost Gate

- **OpenRouter Account Available Credit Balance (`/api/v1/credits`):** **`$78.517771` (`$78.52`)** (`total_credits = $525.00`, `total_usage = $446.482229`; **`$77.52` usable** after `$1.00` reserve)
- **OpenRouter Per-Key Spend Cap (`/api/v1/key`, `limit = $50.00`):**
  - **Before Pilot `C1_r01`:** `limit_remaining = $10.336600` (`usage = $39.663400`)
  - **After Pilot `C1_r01` (8s snapshot):** `limit_remaining = $9.208424` (`usage = $40.791576`, delta `$1.128175`)
  - **After Pilot `C1_r01` (fully settled):** `limit_remaining = $9.171195` (`usage = $40.828805`, **settled `/api/v1/key` delta = `$1.165405`**, matching wire-billed **`$1.165405`** to 6 decimal places)

---

## 1. Pilot `C1_r01` Live Results (`anthropic/claude-sonnet-4.6`, 30 Turns, Default `/compact` @ Turn 20, Abort Cap `$2.00`)

### A. Per-Turn `requests/turn`, Prompt Context Tokens, Output Tokens, and Billed Cost (`C1_r01`)

| Turn | Scripted Phase | Plan Label | `requests/turn` | First-Call `cache_read` | First-Call `cache_write` | First-Call Prompt Tok | Last-Call Prompt Tok | Turn Output Tok | Turn Billed Cost |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T01** | `plant` | `other` | **`2`** | `0` | `11,450` | `11,453` | `15,360` | `258` | `$0.064913` |
| **T02** | `plant_nc1_nc2` | `other` | **`13`** | `15,359` | `231` | `15,593` | `23,125` | `2,633` | `$0.147295` |
| **T03** | `plant_nc3_nc4` | `other` | **`3`** | `23,124` | `283` | `23,410` | `31,594` | `976` | `$0.069632` |
| **T04** | `plant` | `other` | **`2`** | `31,593` | `221` | `31,817` | `40,286` | `539` | `$0.059714` |
| **T05** | `plant_bug_fail` | `mid_debug` | **`2`** | `40,285` | `342` | `40,630` | `41,287` | `214` | `$0.031249` |
| **T06** | `plant_bug_fix` | `task_boundary` | **`3`** | `41,286` | `235` | `41,524` | `42,257` | `418` | `$0.047338` |
| **T07** | `work_post_t6` | `other` | **`1`** | `42,256` | `146` | `42,405` | `42,405` | `97` | `$0.014688` |
| **T08** | `plant_cmd_err` | `other` | **`1`** | `42,402` | `203` | `42,608` | `42,608` | `60` | `$0.014391` |
| **T09** | `work` | `other` | **`1`** | `42,605` | `146` | `42,754` | `42,754` | `149` | `$0.015573` |
| **T10** | `plant_checklist` | `other` | **`1`** | `42,751` | `353` | `43,107` | `43,107` | `158` | `$0.016528` |
| **T11** | `todo1_edit` | `other` | **`2`** | `43,104` | `247` | `43,354` | `43,636` | `211` | `$0.031105` |
| **T12** | `todo1_test_pass` | `task_boundary` | **`2`** | `43,635` | `131` | `43,769` | `44,109` | `107` | `$0.029611` |
| **T13** | `todo2_edit` | `other` | **`2`** | `44,108` | `174` | `44,285` | `44,782` | `428` | `$0.035473` |
| **T14** | `todo2_test_draft` | `other` | **`2`** | `44,781` | `188` | `44,972` | `45,685` | `644` | `$0.039983` |
| **T15** | `todo2_test_fail` | `mid_debug` | **`2`** | `45,684` | `132` | `45,819` | `46,507` | `186` | `$0.033335` |
| **T16** | `todo2_test_fix` | `task_boundary` | **`3`** | `46,506` | `228` | `46,737` | `47,385` | `292` | `$0.049773` |
| **T17** | `todo4_plan` | `other` | **`1`** | `47,384` | `140` | `47,527` | `47,527` | `121` | `$0.016564` |
| **T18** | `todo4_edit` | `other` | **`2`** | `47,524` | `270` | `47,797` | `48,354` | `503` | `$0.039261` |
| **T19** | `todo5_edit` | `other` | **`2`** | `48,353` | `162` | `48,518` | `48,851` | `272` | `$0.035016` |
| **T20** | `pre_compact_gate` | `task_boundary` | **`2`** | `48,850` | `146` | `48,999` | `49,338` | `156` | `$0.033532` |
| **T21** | `probe_nc1` | `other` | **`1`** | `10,619` | `21,957` | `32,579` | `32,579` | `91` | `$0.086898` |
| **T22** | `probe_nc2` | `other` | **`1`** | `32,576` | `198` | `32,777` | `32,777` | `62` | `$0.011454` |
| **T23** | `probe_nc3` | `other` | **`1`** | `32,774` | `196` | `32,973` | `32,973` | `67` | `$0.011581` |
| **T24** | `probe_nc4` | `other` | **`1`** | `32,970` | `184` | `33,157` | `33,157` | `47` | `$0.011295` |
| **T25** | `probe_ghost_revert` | `other` | **`1`** | `33,154` | `205` | `33,362` | `33,362` | `121` | `$0.012539` |
| **T26** | `recall_q1` | `other` | **`1`** | `33,359` | `208` | `33,570` | `33,570` | `48` | `$0.011517` |
| **T27** | `recall_q2` | `other` | **`1`** | `33,567` | `132` | `33,702` | `33,702` | `199` | `$0.013559` |
| **T28** | `recall_q3` | `other` | **`1`** | `33,699` | `288` | `33,990` | `33,990` | `230` | `$0.014649` |
| **T29** | `normal_todo3` | `other` | **`2`** | `33,987` | `330` | `34,320` | `34,640` | `245` | `$0.026623` |
| **T30** | `final_test_run` | `other` | **`2`** | `34,639` | `127` | `34,769` | `35,140` | `154` | `$0.025018` |
| **Compaction Call (@T20)** | `/compact` (default) | — | **`1`** | `48,996` | `89` | `50,766` | `50,766` | `6,348` | **`$0.115296`** |
| **Total / Mean (30 Turns + Compact)** | — | — | **`62` reqs** (`2.03/turn` over 30 turns; `2.45` T1–T20, `1.20` T21–T30) | — | — | — | **T20: `49,338`**<br/>**T21: `32,579`** | **`15,049`** (`8,701` turns + `6,348` compact) | **`$1.165405`** (fully settled key delta: **`$1.165405`**) |

### B. Turn 21 First Post-Compaction Request: `tools/system` Layer vs. `messages` Cache Split (`H4` / `H6`)

| Metric | Measured Value in `C1_r01` (`claude-sonnet-4-6`) | Interpretation |
| :--- | :---: | :--- |
| **Turn 1 Initial `cache_creation_input_tokens` (`tools + system` baseline)** | `11,450` tokens | Baseline size of `tools` (`17,243` chars) + `system[0..2]` (`27,115` chars) + 1-sentence T1 prompt (`~48` tok) |
| **Turn 20 Last Request Total Prompt Tokens (Pre-Compaction)** | `49,338` tokens | `48,850` `cache_read` + `146` `cache_write` + `3` `input` (+ `339` on 2nd call) |
| **Compaction Request (`@T20`) Usage & Cost** | `48,996` `cache_read`, `89` `cache_write`, `1,681` `input`, **`6,348` `output`** | **`$0.115296`** billed (`50,766` prompt tokens; generated a `14,073`-char / `6,348`-tok summary) |
| **Turn 21 First Post-Compaction `cache_read_input_tokens` (`tools + system[0..1]` layer)** | **`10,619` tokens** | **SURVIVED COMPACTION:** `toolsSha256` matched Turn 20 (`true`), and the `system[1]` ephemeral breakpoint hit warm cache! |
| **Turn 21 First Post-Compaction `cache_creation_input_tokens` (`system[2] + messages` layer)** | **`21,957` tokens** | Re-written cold: `~831` tokens in `system[2]` (updated `MEMORY.md` block) + **`~21,126` tokens in `messages`** (`58,385` chars = compacted summary + preserved tail segment) |
| **Turn 21 First Post-Compaction Total Prompt Tokens** | **`32,579` tokens** | `10,619` warm read (`32.6%`) + `21,957` cold write (`67.4%`) + `3` uncached input |

- **Key Finding on `tools/system` Cache Survival & Auto-Memory Confound:**
  1. **`tools + system[0..1]` (`10,619` tokens) survives compaction on the same model:** Compaction replaces `messages` (and preserves the latest tail segment), but does **not** bust the `tools + system[0..1]` cache prefix (`10,619` tokens read at warm rate on Turn 21). When switching models immediately after compaction (`S-A`: Opus -> Sonnet), those `10,619` `tools + system[0..1]` tokens will be cold-written on Sonnet instead of read warm on Opus.
  2. **Turn 2 Auto-Memory Confound Discovered in `C1_r01`:** On Turn 2 (`13` requests, `$0.1473`), Claude Code's built-in auto-memory tried to persist `NC1..NC4` into `claude_config/projects/.../memory/MEMORY.md` via `Bash`/`python3`. That both inflated Turn 2 from `2` requests to `13` requests **and** injected `MEMORY.md` into `system[2]` after compaction (contributing to `C1_r01` scoring `0/4` constraint violations, `0` ghost reverts, and `3/3` recall). For Phase 2 runs, if you want pure compaction isolation without `MEMORY.md` assistance (and `~$0.125/run` lower cost), we can set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

---

## 2. Phase 1: Boundary Detector Replay — Labeled **UNVERIFIED**

- **Status:** **UNVERIFIED**
  - The `78` existing benchmark transcripts (`1,240` turns) contain **`0` task boundaries** (`0` test-suite executions following code edits/failures).
  - The earlier synthetic preview trajectories have been removed from `phase1_boundary_detector.csv` because their turns and labels came from the same author as the detector.
  - Below is the detector's evaluation on the live **`C1_r01` pilot transcript (`30` turns, `n = 1`)** using labels derived **strictly from the scripted 30-turn plan** (`4` `task_boundary` turns at `T6, T12, T16, T20`; `2` `mid_debug` turns at `T5, T15`; `24` `other` turns):

| Dataset Group | Sessions | Turns | Plan `task_boundary` | Plan `mid_debug` | Plan `other` | TP | FP | FN | TN | Precision | Recall | False Prompts / 100 Turns | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Existing Benchmark Transcripts** (`C1, C2, Cal, TH`) | `78` | `1,240` | `0` | `0` | `1,240` | `0` | `0` | `0` | `1,240` | N/A | N/A | `0.00` | **UNVERIFIED (`0` boundaries)** |
| **Live Phase 2 Pilot Transcript (`C1_r01`, scripted turn-plan labels)** | `1` | `30` | `4` (`T6, T12, T16, T20`) | `2` (`T5, T15`) | `24` | **`4`** | **`1`** (`T30`) | **`0`** | **`25`** | **`80.00%` (`4/5`)** | **`100.0%` (`4/4`)** | **`3.33`** | **UNVERIFIED (`n = 1` pilot)** |

*(Note: The single `FP` on `C1_r01` is at Turn 30, where the agent edited `src/exporter.mjs` on Turn 29 and passed `node --test test/suite.test.mjs` on Turn 30; the scripted 30-turn plan labels Turn 30 as `other` because the session ends at Turn 30 rather than starting new work on Turn 31.)*

---

## 3. Recomputed Phase 2 Cost Estimate From Pilot `C1_r01` With `+15%` Margin

- **Account Available Credit Balance (`/api/v1/credits`):** **`$78.52`** (`$78.517771`; **`$77.52` usable** after `$1.00` reserve)
- **Current Per-Key Cap Remaining (`/api/v1/key`, `limit = $50.00`):** **`$9.171195`** (**`$8.1712` usable** after `$1.00` reserve unless key cap is raised)
- **Arm Changes Applied:**
  - Dropped `S-B` and `S-C` (`S-C` is covered by `L1`/`L2`).
  - Set `S-A` and `S-D` to `n = 1` each.
  - Changed `C3` to re-inject constraints via `SessionStart(source="compact")` `additionalContext` (`c3_sessionstart_compact_hook.mjs`).
  - Ordered by requested priority: **`C1, C2, C0, C3, S-A, S-D, T1, C4`**.

### A. Strict Priority Table (`C1` 2 Remaining, `C2` n=3, `C0` n=3, `C3` n=3, `S-A` n=1, `S-D` n=1, `T1` n=2, `C4` n=2)

| Priority | Arm | Schedule & Design | Planned `n` | Done in Pilot | Remaining Runs | Pilot Base / Run | **`+15%` Margin / Run** | Abort Cap / Run | Arm Total (Base) | **Arm Total (`+15%`)** | Cum. Rem. Runs | Cum. Base Cost | **Cum. `+15%` Cost** | Fits `$78.52` Account Balance? | Fits Current `$50` Key Cap (`$8.17` Usable)? |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | **`C1`** | sonnet-4.6 (default /compact @ T20; 1/3 done in pilot, 2 remaining) | `3` | `1` | `2` | `$1.1654` | **`$1.3402`** | `$2.68` | `$2.3308` | **`$2.6804`** | `2` | `$2.3308` | **`$2.6804`** | **YES** | **YES** |
| **2** | **`C2`** | sonnet-4.6 (preservation template /compact @ T20) | `3` | `0` | `3` | `$1.1654` | **`$1.3402`** | `$2.68` | `$3.4962` | **`$4.0206`** | `5` | `$5.8270` | **`$6.7010`** | **YES** | **YES** |
| **3** | **`C0`** | sonnet-4.6 (T1-T30, no compact control) | `3` | `0` | `3` | `$1.0290` | **`$1.1833`** | `$2.37` | `$3.0870` | **`$3.5499`** | `8` | `$8.9140` | **`$10.2509`** | **YES** | Raise key cap |
| **4** | **`C3`** | sonnet-4.6 (default /compact + SessionStart(source=compact) additionalContext) | `3` | `0` | `3` | `$1.1674` | **`$1.3425`** | `$2.69` | `$3.5022` | **`$4.0275`** | `11` | `$12.4162` | **`$14.2784`** | **YES** | Raise key cap |
| **5** | **`S-A`** | opus-4.6 T1-T20 -> compact @ T20 -> switch sonnet-4.6 T21-T30 (n=1) | `1` | `0` | `1` | `$1.8289` | **`$2.1032`** | `$4.21` | `$1.8289` | **`$2.1032`** | `12` | `$14.2451` | **`$16.3816`** | **YES** | Raise key cap |
| **6** | **`S-D`** | opus-4.6 T1-T30 (compact only @ T20, no switch, n=1) | `1` | `0` | `1` | `$1.9424` | **`$2.2338`** | `$4.47` | `$1.9424` | **`$2.2338`** | `13` | `$16.1875` | **`$18.6154`** | **YES** | Raise key cap |
| **7** | **`T1`** | sonnet-4.6 (C2 template compacted mid-debug @ T20) | `2` | `0` | `2` | `$1.1654` | **`$1.3402`** | `$2.68` | `$2.3308` | **`$2.6804`** | `15` | `$18.5183` | **`$21.2958`** | **YES** | Raise key cap |
| **8** | **`C4`** | sonnet-4.6 (short template /compact @ T20) | `2` | `0` | `2` | `$1.0620` | **`$1.2213`** | `$2.44` | `$2.1240` | **`$2.4426`** | `17` | `$20.6423` | **`$23.7384`** | **YES** | Raise key cap |

### B. Summary Against Account Balance (`$78.52`) vs. Per-Key Spend Cap (`$9.17` Remaining on `$50` Cap)

1. **Full 8-Arm Matrix (`17` remaining runs = `$20.6423` base / `$23.7384` with `+15%` margin):**
   - **Fits the `$78.52` OpenRouter account balance** with **`~$54.78`** remaining after all 8 arms (`C1, C2, C0, C3, S-A, S-D, T1, C4`) complete at full planned replicate counts (`n = 3` for `C0..C3`, `n = 1` for `S-A, S-D`, `n = 2` for `T1, C4`).
   - **Note on API key cap:** Because the active API key currently has a `$50.00` per-key spend limit (`usage = $40.828805`, `limit_remaining = $9.171195`), running the full `$20.64`–`$23.74` Phase 2 matrix requires raising that key's limit from `$50` to `>=$75` (or removing the per-key cap) in OpenRouter Keys settings.
2. **If Keeping the Existing `$50` Per-Key Cap (`$8.1712` Usable After `$1.00` Reserve):**
   - Fits `C1` (`2` remaining runs) + `C2` (`3` runs) + `C0` (`1` run) = **`$6.8560` base / `$7.8843` at `+15%`**, or `n = 2` across `C1, C2, C0` + `n = 1` on `C3` = **`$6.7214` base / `$7.7296` at `+15%`**.

---

## 4. Published Findings From Stage A & Stage A2 (`v1` at `~42k` Tok / `3.1x` vs. `v2` at `~139k` Tok / `27x` Compression)

### A. Finding 1 — Switch-After-Compaction (`S-A` vs. `S-D`, **computed from a measured cache split**)
- **Label:** **computed from a measured cache split** (`C1_r01` memory-on split: `10,619` `tools/system` + `21,957` `messages/system[2]`; `C1_r02..r03` memory-off split: `7,627` `tools/system` + `21,649` `messages`).
- **First post-compaction turn (`T21`):**
  - **Stay on Opus 4.6 (`S-D`):** Warm-read `10,619` `tools/system` tokens (`$0.50/M` = `$0.005310`) + cold-write `21,957` compacted `messages` tokens (`$6.25/M` = `$0.137231`) + `3` input + `91` output = **`$0.142556` prompt / `$0.144831` total** (memory-off: **`$0.139135` prompt / `$0.141410` total**).
  - **Switch Opus 4.6 -> Sonnet 4.6 at compaction (`S-A`):** Cold-write all `32,576` cacheable tokens on Sonnet (`$3.75/M` = `$0.122160`) + `3` input + `91` output = **`$0.122169` prompt / `$0.123534` total** (memory-off: **`$0.109794` prompt / `$0.111159` total**).
  - **Immediate `T21` Net Saving (`S-D - S-A`):** **`+$0.020387` prompt / `+$0.021297` total** (memory-off: **`+$0.029341` prompt / `+$0.030251` total**). Payback is **0 post-switch requests (immediate on `T21`)**.
  - **Subsequent warm turns (`T22..T30`):** Saves **`$0.010240/turn` (`$0.008378/req`)** (memory-off: **`$0.009441/turn` / `$0.007724/req`**), for a 10-turn post-compaction saving of **`+$0.113454`** (memory-off: **`+$0.115219`**).

### B. Finding 2 — Built-In Auto-Memory (`MEMORY.md`) Cost & Cache Footprint (`-23.5%`, `n = 2` vs. `n = 2`)
- **Memory-ON (`C1_r01`, `C1mem_r02`, `n = 2`):** Mean `65.0` requests/session (`13` and `19` requests on Turn 2 to write `MEMORY.md` via `Bash`/`python3`), `27,120` `system` chars (`10,621` `tools+system` tokens on `T21`), mean billed cost = **`$1.196701`** (`$1.165405`, `$1.227996`).
- **Memory-OFF (`C1_r02`, `C1_r03`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `n = 2`):** `0/50` wire requests with `MEMORY.md` in `system[2]`, `50.0` requests/session (`2` requests on Turn 2), `13,997` `system` chars (`7,627` `tools+system` tokens on `T21`), mean billed cost = **`$0.916043`** (`$0.921348`, `$0.910737`) — **saving `23.5%` (`-$0.280658/session`)**.

### C. Stage A2 (`Fixture v2` at `~139,000` Pre-Compaction Tokens, `26.2x–28.1x` Compression, Auto-Memory OFF)
- **Settled `/api/v1/key` Usage:** `$43.888886 -> $47.892647` (settled delta = **`$4.003761`**, matching wire-billed **`$4.003761`** = `$2.021380` [`C1_v2_r01`] + `$1.982381` [`C1_v2_r02`] to 6 decimal places).
- **`C1_v2_r01`:** `T20` prompt = `139,174` tokens (`preTokens = 139,231 -> postTokens = 5,313`, **`26.21x` compression**), compaction call = `8,233` output tokens / `15,796` chars / **`$0.170804`**, violations = **`0 / 6`**, ghost revert = **`false`**, recall = **`4 / 5`** (`Q1: 0, Q2: 1, Q3: 1, Q4: 1, Q5: 1`).
- **`C1_v2_r02`:** `T20` prompt = `138,930` tokens (`preTokens = 138,987 -> postTokens = 4,946`, **`28.10x` compression**), compaction call = `7,006` output tokens / `14,328` chars / **`$0.152331`**, violations = **`0 / 6`**, ghost revert = **`false`**, recall = **`4 / 5`** (`Q1: 0, Q2: 1, Q3: 1, Q4: 1, Q5: 1`).
