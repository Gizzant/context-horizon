# Enterprise & Team Deployment Guide (MDM, OpenTelemetry & Verification)

Highbeam (`highbeam-cli` v4.2) is designed for security-conscious engineering organizations running **Google Antigravity**, **Claude Code**, **OpenAI Codex CLI**, **Gemini CLI**, **Cursor**, and **Windsurf** on regulated or air-gapped developer workstations.

---

## 1. Security & Supply-Chain Guarantees

1. **Zero Outbound Network Connections & Zero Dependencies**:
   - Highbeam (`highbeam-cli`) ships with **0 runtime npm dependencies** (`dependencies` absent from [package.json](../package.json)) and opens **0 external HTTP, HTTPS, WebSocket, or DNS sockets**.
   - Works natively behind corporate firewalls, air-gapped networks, and fixed-seat OAuth subscriptions where cloud LLM proxies cannot sit in the request path.
2. **Signed npm Provenance & Cryptographic File Integrity**:
   - Releases publish via `npm publish --provenance --access public` with GitHub OIDC attestation (`id-token: write`).
   - Endpoint integrity can be verified anytime with `npx highbeam-cli verify --json` against `CHECKSUMS.sha256`.
3. **Read-Only Host Database & Credential Exclusion (`SQLITE_OPEN_READONLY`)**:
   - Host Antigravity/IDE SQLite databases are opened strictly with `{ readOnly: true }`.
   - `highbeam audit` inspects only session transcript logs across its 5 supported hosts (including `~/.gemini/tmp/**/chats/session-*.json` for Gemini CLI) and explicitly skips OAuth credential files (`~/.gemini/oauth_creds.json`).

---

## 2. Open-Core License Boundary (`MIT` vs. Pro / Team)

- **Free Core (`MIT`)**: Interactive HUD (`npx highbeam-cli`), 5-host read-only audit (`highbeam audit`), FTS5 CLI compression + BM25 search (`highbeam search`), repeat-read AST stubs (`GUARD-4`), non-blocking `COACH` mode, and `DET-01..32` guards run 100% under MIT with no license key required.
- **Commercial (`packages/pro/`)**: `COACH` previews Pro value locally; `AUTO_PILOT` holds, 30-day persistent workspace ledgers, cross-machine encrypted sync (`highbeam sync`), Git/PR cost attribution (`highbeam pr-cost`), zero-knowledge org FinOps rollups (`highbeam team-rollup`), CI token-budget gates (`highbeam ci-gate`), SHA-256 Corporate PDF FinOps receipts, and Team OTel bundles verify Ed25519 offline keys (`CTXP1.*`) against the SPKI public key pinned in the release. Team and enterprise licenses are issued by Highbeam and verified offline; the trust key cannot be replaced by configuration.

---

## 3. Centralized Policy Rollout via MDM / Endpoint Management

### Global Policy Schema (`~/.attention-horizon.json`)
Deploy a read-only or managed policy baseline to standardize flight mode, Turn-0 prefix budgets, and mandatory safety detectors (`DET-09`, `DET-19`, `DET-20`):

```json
{
  "flightMode": "COACH",
  "turnZeroTokenBudget": 20000,
  "detectors": {
    "DET-06": "block",
    "DET-07": "block",
    "DET-08": "warn",
    "DET-09": "block",
    "DET-19": "block",
    "DET-20": "warn"
  }
}
```

### Platform Rollout Snippets

| Platform | Target Path & Rollout Command |
| :--- | :--- |
| **macOS (Jamf / Kandji)** | Install via global npm/tarball, deploy `~/.attention-horizon.json` per logged-in user, and run:<br/>`npx highbeam-cli init --all-hosts --global && npx highbeam-cli doctor --json` |
| **Windows (Intune / GPO)** | Push `%USERPROFILE%\.attention-horizon.json` via PowerShell logon/Intune script, use Node >= 20 LTS (Node >= 22.13+ recommended for native SQLite), and run:<br/>`npx highbeam-cli init --all-hosts --global` |
| **Linux / DevContainers** | Bake `npm install -g highbeam-cli` and `/etc/skel/.attention-horizon.json` into base image; verify with `highbeam verify --json && highbeam doctor`. |

---

## 4. Zero-PII Telemetry, BYO-Grafana OTel & FinOps Receipts

- **Sanitized Forensic Sharing**: All exported bundles pass through `src/core/sanitizer.mjs`, redacting filesystem home prefixes, tokens, and secrets prior to emission.
- **Zero-Knowledge Org FinOps Rollup (`npx highbeam-cli team-rollup`)**: Emits salted pseudonymous snapshots (`dev_<12hex>`) strictly stripped by the `FORBIDDEN_ZK_KEYS` PII/path/secret firewall (zero prompts, zero file paths, zero emails, zero API keys) and aggregates offline org Markdown/JSON/CSV rollups.
- **Branch PR Attribution & CI Token-Budget Gate (`npx highbeam-cli pr-cost`, `npx highbeam-cli ci-gate`)**: Correlates `git log` commits with local ledgers for per-PR token/USD cost attribution and enforces `.attention-horizon.json` `ciBudgetGate` thresholds in GitHub Actions or GitLab CI.
- **OpenTelemetry / Grafana FinOps Pack (`npx highbeam-cli team-pack`)**: Generates local OTel collector templates and Grafana dashboards fed from `saved_quota_ledger.sqlite` + local JSONL spans—ready to forward only scrubbed token/cost counters into your internal observability stack.
- **Audit-Ready FinOps & GreenOps Receipts**: `npx highbeam-cli receipt --pdf` produces a standalone PDF 1.4 expense artifact stamped with a deterministic SHA-256 digest of workspace 30-day token, USD, and Scope-3 energy savings.
