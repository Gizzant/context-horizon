# Stage 6: Deterministic Verification Suite, Latency Benchmarks & Packaging
**Recommended Model & Effort:** `/model gemini-3.8-flash` | `/effort high` | **Mode:** `auto`

Copy and run the prompt below in Google Antigravity after Stage 5 passes verification:

~~~text
Read @SPEC_AGY_HORIZON_FLIGHTCHECK.md and @implementation_plan.md (Phase 6). Build the synthetic test fixtures, automated `node:test` verification suite, latency benchmark runner, and installation helper.

### Deliverables to Create in Order

1. `tests/fixtures/synthetic_states.mjs`
   - Export reusable mock transcripts, `statusLine` payloads, and `sidecar.json` states covering:
     1. Cold Session (Turn 1) vague multi-file caching prompt on `flash` / `low`.
     2. Warm Session (Turn 18, 62k tokens, 82% Purity) implicit follow-up referencing a file in `ACTIVE_SET`.
     3. Hot Session (Turn 45, 85k tokens, 79% Purity) async deadlock prompt on `flash` / `medium` (`STEER_SUBAGENT`).
     4. Polluted Session (95k tokens, 39% Purity, $0.07/turn Sludge Tax) high-effort refactor (`HALT_HYGIENE_OR_SAFETY` -> `/compact`).
     5. Amputation Crisis (145k tokens, `ANCHOR_CORE` in Cells 0-3) feature prompt (`HALT_HYGIENE_OR_SAFETY` -> `/clear`).
     6. Parallel Disk Drift (`dirtySnapshotPaths` non-empty) + Unseen Callers (`INJECT_CONTEXT_GUARD`).
     7. Quota Shield (`quota.remaining_fraction: 0.08` on `pro` / `max`) (`HALT_EFFORT_OR_QUOTA`).
     8. Explicit `#check` on a 9,950-line module split (`HALT_REWRITE_SCORECARD`).

2. `tests/test_router_and_sensors.mjs`
   - Use Node's built-in test runner (`node:test` and `node:assert/strict`).
   - Test all 8 router states, all 6 blind-spot sensors, Windows/URI path canonicalization (`file:///c%3A/...` vs `C:\...`), `!force` and `!lock` flags, and `horizon_hud.mjs` crash-immunity on malformed stdin.

3. `tests/bench_latency.mjs`
   - Run 200 iterations of:
     - `readSidecarSync` (assert p95 latency under 2ms)
     - Tier 1 `pre_invocation.mjs` evaluation (assert p95 latency under 15ms)
     - Incremental `horizon_hud.mjs` statusLine render (assert p95 latency under 45ms)
   - Print a clean tabular latency report and exit non-zero if any p95 budget is exceeded.

4. `README.md`
   - Document one-command installation for global (`~/.gemini/config/plugins/agy-horizon-flightcheck`) and workspace (`.agents/`) setups, the `settings.json` `statusLine` snippet, control flags (`!`, `!lock`, `#check`), and the 40-cell visual legend.

### Final Verification Gate
Execute the following commands via `run_command` and fix any issues until all pass with 0 errors:
1. `node --test tests/test_router_and_sensors.mjs`
2. `node tests/bench_latency.mjs`
3. Validate that `plugin.json` and `hooks.json` parse cleanly and conform to the Antigravity schema rules.
Mark all remaining items in `task.md` complete and output a final build summary.
~~~