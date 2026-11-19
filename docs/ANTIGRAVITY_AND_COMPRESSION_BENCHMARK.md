# Highbeam (`highbeam-cli` v4.2) — Multi-Family CLI Compression & Antigravity Parity Benchmark

> **Reproducibility:** Generated via `npm run bench:parity` (`scripts/run_antigravity_and_compression_benchmark.mjs`) in isolated temporary directories with zero external network calls.
> **Fixture Corpus SHA-256:** `04e14669c1b2397631a8a5fb854a304f3e909ba967aa934ac256beba849df541`

---

## 1. Suite A — 10-Family CLI Output Compression & 100% Diagnostic Recall

- **Aggregate Token Reduction:** **96.1%** (`26,822` raw tokens -> `1,055` summary tokens across `10` noisy CLI logs)
- **Critical Diagnostic & Hunk Header Recall:** **100%** (`25/25` ground-truth markers preserved)
- **BM25 FTS5 & MCP Retrieval Rate:** **100%** (`10/10` matched identically via `highbeam search` & `horizon_search_logs`)

| Fixture | Family | Command | Raw Tok | Summary Tok | Token Reduction | Diagnostic Recall | FTS5 + MCP Retrieval |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| `F01-pytest` | `test` | `pytest tests/auth` | `3009` | `100` | **96.7%** | **100%** | PASS |
| `F02-vitest` | `test` | `vitest run` | `2851` | `89` | **96.9%** | **100%** | PASS |
| `F03-tsc` | `lint_build` | `tsc --noEmit` | `2458` | `109` | **95.6%** | **100%** | PASS |
| `F04-cargo` | `test` | `cargo test` | `2863` | `77` | **97.3%** | **100%** | PASS |
| `F05-gotest` | `test` | `go test ./...` | `2515` | `82` | **96.7%** | **100%** | PASS |
| `F06-eslint` | `lint_build` | `eslint src/` | `2741` | `84` | **96.9%** | **100%** | PASS |
| `F07-gitdiff` | `git` | `git diff HEAD~1` | `2487` | `80` | **96.8%** | **100%** | PASS |
| `F08-gitstatus` | `git` | `git status --short` | `2441` | `286` | **88.3%** | **100%** | PASS |
| `F09-docker` | `infra` | `docker build .` | `2588` | `76` | **97.1%** | **100%** | PASS |
| `F10-kubectl` | `infra` | `kubectl logs deploy/api-worker` | `2869` | `72` | **97.5%** | **100%** | PASS |

---

## 2. Suite B — 12-Trajectory Google Antigravity & 5-Host Parity Suite

- **Trajectories Verified:** **12 / 12 PASS**
- **5-Host Audit Coverage (`highbeam audit`):** Antigravity=`1`, Claude=`1`, Codex=`1`, Gemini=`1`, Cursor=`1`

| Trajectory | Verified Capability | Measured Latency (ms) | Status |
| :--- | :--- | :---: | :---: |
| `AG-T01` | Bounded read allow & active-source ignore lock | `7.185ms` | **PASS** |
| `AG-T02` | PreInvocation router fast evaluation | `12.897ms` | **PASS** |
| `AG-T03` | Antigravity PostToolUse FTS5 offload | `3.779ms` | **PASS** |
| `AG-T04` | RSL PostToolUse stepIdx deduplication | `0.25ms` | **PASS** |
| `AG-T05` | DET-08 Hold warm switch when payback > horizon | `0.1ms` | **PASS** |
| `AG-T06` | DET-08 Allow model switch when horizon repays rebuild | `0.1ms` | **PASS** |
| `AG-T07` | DET-09 Stage mid-TTL AGENTS.md mutation | `0.2ms` | **PASS** |
| `AG-T08` | DET-09 Flush staged rule deltas on PostCompact | `0.2ms` | **PASS** |
| `AG-T09` | DIRTY_SNAP external IDE edit detection | `0.5ms` | **PASS** |
| `AG-T10` | DET-19 Block --no-verify git hook bypass | `1ms` | **PASS** |
| `AG-T11` | DET-20 /swarm collision lock & worktree hint | `0.5ms` | **PASS** |
| `AG-T12` | 5-Host zero-write session audit parity | `1.5ms` | **PASS** |
