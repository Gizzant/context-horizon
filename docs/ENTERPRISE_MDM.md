# Enterprise & Team Deployment Guide (MDM, OpenTelemetry & Verification)

Highbeam (`ctxtop` v4.1) is designed for security-conscious engineering organizations running **Google Antigravity**, **Claude Code**, **OpenAI Codex CLI**, **Gemini CLI**, **Cursor**, and **Windsurf** on regulated or air-gapped developer workstations.

---

## 1. Security & Supply-Chain Guarantees

1. **Zero Outbound Network Connections & Zero Dependencies**:
   - `ctxtop` ships with **0 runtime npm dependencies** (`dependencies` absent from [package.json](../package.json)) and opens **0 external HTTP, HTTPS, WebSocket, or DNS sockets**.
   - Works natively behind corporate firewalls, air-gapped networks, and fixed-seat OAuth subscriptions where cloud LLM proxies cannot sit in the request path.
2. **Signed npm Provenance & Cryptographic File Integrity**:
   - Releases publish via `npm publish --provenance --access public` with GitHub OIDC attestation (`id-token: write`).
   - Endpoint integrity can be verified anytime with `npx ctxtop verify --json` against `CHECKSUMS.sha256`.
3. **Read-Only Host Database & Credential Exclusion (`SQLITE_OPEN_READONLY`)**:
   - Host Antigravity/IDE SQLite databases are opened strictly with `{ readOnly: true }`.
   - `ctxtop audit` inspects only session transcript logs across its 5 supported hosts (including `~/.gemini/tmp/**/chats/session-*.json` for Gemini CLI) and explicitly skips OAuth credential files (`~/.gemini/oauth_creds.json`).

---

## 2. Open-Core License Boundary (`MIT` vs. Pro / Team)

- **Free Core (`MIT`)**: Interactive HUD (`npx ctxtop`), 5-host read-only audit (`ctxtop audit`), FTS5 CLI compression + BM25 search (`ctxtop search`), repeat-read AST stubs (`GUARD-4`), non-blocking `COACH` mode, and `DET-01..32` guards run 100% under MIT with no license key required.
- **Commercial (`packages/pro/`)**: `COACH` previews Pro value locally; `AUTO_PILOT` holds, 30-day persistent workspace ledgers, SHA-256 Corporate PDF FinOps receipts, and Team OTel bundles verify Ed25519 offline keys (`CTXP1.*`) against the SPKI public key pinned in the release. Team and enterprise licenses are issued by Highbeam and verified offline; the trust key cannot be replaced by configuration.

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
| **macOS (Jamf / Kandji)** | Install via global npm/tarball, deploy `~/.attention-horizon.json` per logged-in user, and run:<br/>`npx ctxtop init --all --global && npx ctxtop doctor --json` |
| **Windows (Intune / GPO)** | Push `%USERPROFILE%\.attention-horizon.json` via PowerShell logon/Intune script, pin global Node >= 22.13, and run:<br/>`npx ctxtop init --all-hosts --global` |
| **Linux / DevContainers** | Bake `npm install -g ctxtop` and `/etc/skel/.attention-horizon.json` into base image; verify with `ctxtop verify --json && ctxtop doctor`. |

---

## 4. Zero-PII Telemetry, BYO-Grafana OTel & FinOps Receipts

- **Sanitized Forensic Sharing**: All exported bundles pass through `src/core/sanitizer.mjs`, redacting filesystem home prefixes, tokens, and secrets prior to emission.
- **OpenTelemetry / Grafana FinOps Pack (`npx ctxtop team-pack`)**: Generates local OTel collector templates and Grafana dashboards fed from `saved_quota_ledger.sqlite` + local JSONL spans—ready to forward only scrubbed token/cost counters into your internal observability stack.
- **Audit-Ready FinOps & GreenOps Receipts**: `npx ctxtop receipt --pdf` produces a standalone PDF 1.4 expense artifact stamped with a deterministic SHA-256 digest of workspace 30-day token, USD, and Scope-3 energy savings.
