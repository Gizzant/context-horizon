# Item 5 Summary — Exploratory Tool-Heavy Paired Run (`n = 1`)

> **Sample-size disclaimer:** `n=1 exploratory paired run; no statistical precision claim` Single paired run (`n = 1` hold vs `n = 1` allow); do not extrapolate point precision.

- **Mode:** `live`
- **Pre-registered At (UTC):** `2026-11-14T23:06:58.704Z`
- **Run 1 (`TH_hold_r01`) Started At (UTC):** `2026-11-14T23:06:58.868Z` | **Final Model:** `claude-opus-4-6` | **Mean / Median R:** `5 / 5` (min `5`, max `5`)
- **Run 2 (`TH_allow_r01`) Started At (UTC):** `2026-11-14T23:09:41.463Z` | **Final Model:** `claude-sonnet-4-6` | **Mean / Median R:** `5 / 5` (min `5`, max `5`)
- **Predicted (`hold` / `allow` / `diff`):** `$0.9816` / `$0.6915` / `+$0.2901` at `R = 5`
- **Billed Main (`hold` / `allow` / `diff`):** `$1.112250` / `$0.790461` / `+$0.321789`
- **All-Wire Billed Sum:** `$1.902879`
- **OpenRouter `/api/v1/key`:** before `$12.239478` (usage `$37.76052205`), immediate post-run `$10.414667` (usage `$39.58533315`, delta `$1.824811`), settled at `2026-11-14T23:14:37.314Z` -> remaining **`$10.336600`** (`$10.33659995`, usage `$39.66340005`, settled delta **`$1.902878`**, gap `$0.000001`)
- **Hold Arm Control Disclosure (`rule_v1`-forced control vs. `rule_v2` unguided):** `TH_hold_r01` ran as a **`rule_v1`-forced Opus hold control** (`use_empirical_horizon_prior = false`) solely to establish the paired all-Opus baseline. Under **`rule_v2` (unguided prior)**, the offline counterfactual replay **would `allow` `TH` at `T3`** (`H_post = 11.27` turns, `C_max = Infinity`, payback `7.32` warm reqs / `1.66` turns under the `<5t` `g=0` cap, or `5.28` warm reqs / `1.20` turns with `g`, net USD omitted in `<5t` hook text).
- **Exact Payback Crossover (`runs_tool_heavy.csv`):** Full-session cumulative `hold - allow` crossed `$0` by the end of **`T4`** at request **`T4.5`**, after **`5` post-switch warm requests (`9` total warm reads** including `4` warm reads on `T3.2..T3.5`): `T4.4` is `-$0.000674` and `T4.5` is **`+$0.005060`** (linear interpolation: **`4.12` post-switch warm requests / `0.82` post-switch turns**; or `3.82` post-switch warm requests excluding `-$0.001614` `T1–T2` pre-switch noise). Compared against the predicted payback (`5.3–7.3` post-switch warm requests), **the model is conservative by about `1–3` requests**.
- **In-Hook Estimate & `<5` Turns Rule (`$0` offline replay):** With `<5` observed turns (`turnsCompleted = 2` at `T3`), the hook suppresses the net dollar figure in user-facing messages and caps growth extrapolation to `g = 0` (`R_prior = 2.0` placeholder rationale, `turnsAgree = true -> R = 4.4`, `O = 547`), reporting payback of **`~7.3` post-switch warm requests (`~1.67` turns)** (`C_max = unbounded`, decision `allow`; uncompounded `g = 0` net `+$0.1254`, or `+$0.2629` if `g = 2,538` were extrapolated). The earlier `+$0.2897` ("within 10%") offline figure — which depended on seeding a 1-session temp dir with `TH_allow`'s own benchmark transcript — is **withdrawn** (local `R` prior now requires `>= 3` sessions, excludes the current session, and excludes benchmark/harness transcripts).
- **Scripted Workload Caveat:** `n = 1` exploratory paired run driven by fixed sequential 4-`Read`/turn prompts forcing deterministic `R = 5`; do not claim point precision or generalize directly to interactive sessions.

## Per-Turn Requests/Turn (`T1..T12`)

| Turn | `TH_hold_r01` reqs/turn (`model`) | `TH_allow_r01` reqs/turn (`model`) |
|---:|---|---|
| T1 | `5` (`opus-4-6`) | `5` (`opus-4-6`) |
| T2 | `5` (`opus-4-6`) | `5` (`opus-4-6`) |
| T3 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T4 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T5 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T6 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T7 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T8 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T9 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T10 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T11 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |
| T12 | `5` (`opus-4-6`) | `5` (`sonnet-4-6`) |

