# Highbeam (`highbeam-cli` v4.2) — Multi-Family CLI Compression & Antigravity Parity Benchmark

> **Reproducibility:** Generated via `npm run bench:parity` (`scripts/run_antigravity_and_compression_benchmark.mjs`) in isolated temporary directories with zero external network calls.
> **Fixture Corpus SHA-256:** `c8ce9d956dc0d14aef3f893985d8c19f52d797bb1df2c90dd56ee606e9004289`

---

## 1. Suite A — 19-Fixture Multi-Stack CLI Output Compression & 100% Diagnostic Recall

- **Aggregate Token Reduction:** **96%** (`54,415` raw tokens -> `2,176` summary tokens across `19` noisy CLI logs)
- **Critical Diagnostic & Hunk Header Recall:** **100%** (`52/52` ground-truth markers preserved)
- **BM25 FTS5 & MCP Retrieval Rate:** **100%** (`19/19` matched identically via `highbeam search` & `horizon_search_logs`)

| Fixture | Family | Command | Raw Tok | Summary Tok | Token Reduction | Diagnostic Recall | FTS5 + MCP Retrieval |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| `F01-pytest` | `test` | `pytest tests/auth` | `3009` | `124` | **95.9%** | **100%** | PASS |
| `F02-vitest` | `test` | `vitest run` | `2851` | `89` | **96.9%** | **100%** | PASS |
| `F03-tsc` | `lint_build` | `tsc --noEmit` | `2458` | `109` | **95.6%** | **100%** | PASS |
| `F04-cargo` | `test` | `cargo test` | `2863` | `91` | **96.8%** | **100%** | PASS |
| `F05-gotest` | `test` | `go test ./...` | `2515` | `82` | **96.7%** | **100%** | PASS |
| `F06-eslint` | `lint_build` | `eslint src/` | `2741` | `84` | **96.9%** | **100%** | PASS |
| `F07-gitdiff` | `git` | `git diff HEAD~1` | `2487` | `80` | **96.8%** | **100%** | PASS |
| `F08-gitstatus` | `git` | `git status --short` | `2441` | `286` | **88.3%** | **100%** | PASS |
| `F09-docker` | `infra` | `docker build .` | `2588` | `76` | **97.1%** | **100%** | PASS |
| `F10-kubectl` | `infra` | `kubectl logs deploy/api-worker` | `2869` | `72` | **97.5%** | **100%** | PASS |
| `F11-maven` | `test` | `mvn test` | `2780` | `217` | **92.2%** | **100%** | PASS |
| `F12-gradle` | `test` | `./gradlew test` | `3081` | `105` | **96.6%** | **100%** | PASS |
| `F13-dotnet` | `test` | `dotnet test` | `2690` | `124` | **95.4%** | **100%** | PASS |
| `F14-make` | `lint_build` | `make all` | `3413` | `89` | **97.4%** | **100%** | PASS |
| `F15-playwright` | `test` | `npx playwright test` | `3343` | `117` | **96.5%** | **100%** | PASS |
| `F16-rspec` | `test` | `bundle exec rspec` | `3236` | `107` | **96.7%** | **100%** | PASS |
| `F17-phpunit` | `test` | `phpunit` | `2973` | `117` | **96.1%** | **100%** | PASS |
| `F18-denotest` | `test` | `deno test` | `2533` | `106` | **95.8%** | **100%** | PASS |
| `F19-ctest` | `test` | `ctest --output-on-failure` | `3544` | `101` | **97.2%** | **100%** | PASS |

---

## 2. Suite B — 12-Trajectory Google Antigravity & 5-Host Parity Suite

- **Trajectories Verified:** **12 / 12 PASS**
- **5-Host Audit Coverage (`highbeam audit`):** Antigravity=`1`, Claude=`1`, Codex=`1`, Gemini=`1`, Cursor=`1`

| Trajectory | Verified Capability | Measured Latency (ms) | Status |
| :--- | :--- | :---: | :---: |
| `AG-T01` | Bounded read allow & active-source ignore lock | `12.301ms` | **PASS** |
| `AG-T02` | PreInvocation router fast evaluation | `16.975ms` | **PASS** |
| `AG-T03` | Antigravity PostToolUse FTS5 offload | `22.984ms` | **PASS** |
| `AG-T04` | RSL PostToolUse stepIdx deduplication | `0.25ms` | **PASS** |
| `AG-T05` | DET-08 Hold warm switch when payback > horizon | `0.1ms` | **PASS** |
| `AG-T06` | DET-08 Allow model switch when horizon repays rebuild | `0.1ms` | **PASS** |
| `AG-T07` | DET-09 Stage mid-TTL AGENTS.md mutation | `0.2ms` | **PASS** |
| `AG-T08` | DET-09 Flush staged rule deltas on PostCompact | `0.2ms` | **PASS** |
| `AG-T09` | DIRTY_SNAP external IDE edit detection | `0.5ms` | **PASS** |
| `AG-T10` | DET-19 Block --no-verify git hook bypass | `1ms` | **PASS** |
| `AG-T11` | DET-20 /swarm collision lock & worktree hint | `0.5ms` | **PASS** |
| `AG-T12` | 5-Host zero-write session audit parity | `1.5ms` | **PASS** |
