# `@ctxtop/mcp` — Highbeam MCP Server

> Zero-dependency, 7-tool Model Context Protocol (MCP) server for Cursor, Windsurf, Claude Code, Google Antigravity, Codex CLI, and Gemini CLI.

`@ctxtop/mcp` connects your coding agents directly to Highbeam's local-only context observability, KV-cache gravity checks, deterministic CLI compression, and multi-agent file-scope locks.

---

## 🛠️ The 7 Built-In Tools

| Tool | Mode | Description |
| :--- | :---: | :--- |
| **`horizon_status`** | Read | Telemetry snapshot: 40-cell context saturation, 30-day saved quota ledger, and offline Ed25519 Pro entitlement status. |
| **`cache_gravity_check`** | Compute | Evaluates warm KV-cache break-even gravity before downshifting models or switching providers. |
| **`scope_lock_claim`** | State | Inspects or leases `DET-20` multi-agent file-scope locks to prevent conflicting subagent edits. |
| **`export_receipt_pdf`** | Export | Generates local SHA-256 verified Corporate PDF 1.4 Expense Receipts from saved-quota ledger history. |
| **`horizon_compress_cli`** | Transform | Compresses verbose test, lint, build, or git diff CLI output into `<= 25` lines while archiving raw text in SQLite FTS5. |
| **`horizon_search_logs`** | Read | BM25 full-text search across local FTS5-compressed CLI outputs and offloaded artifacts by keyword or `turnId`. |
| **`horizon_audit_sessions`** | Audit | Strictly read-only 5-host audit of context sludge, duplicate reads, and wasted tokens across local transcripts. |

---

## ⚡ Quick Start

### 1. One-Click Install via Smithery
```bash
npx -y @smithery/cli install @ctxtop/mcp
```

### 2. Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "highbeam": {
      "command": "npx",
      "args": ["-y", "@ctxtop/mcp"]
    }
  }
}
```

### 3. Claude Code (`~/.claude.json` or project `.mcp.json`)
```json
{
  "mcpServers": {
    "highbeam": {
      "command": "npx",
      "args": ["-y", "@ctxtop/mcp"]
    }
  }
}
```

### 4. Windsurf (`~/.codeium/windsurf/mcp_config.json`)
```json
{
  "mcpServers": {
    "highbeam": {
      "command": "npx",
      "args": ["-y", "@ctxtop/mcp"]
    }
  }
}
```

### 5. Google Antigravity
Highbeam is natively integrated as an Antigravity plugin. You can also configure `@ctxtop/mcp` directly in your workspace settings or invoke tools directly via the native MCP client.

---

## 🔒 Zero-Trust Privacy Guarantee

- **Zero Network Calls**: All telemetry, SQLite queries, and compression happen 100% locally on your machine.
- **Read-Only SQLite**: Opened strictly with `SQLITE_OPEN_READONLY` options.
- **Zero Credential Access**: Never touches `oauth_creds.json`, tokens, or private workspace secrets.

---

## 📄 License
MIT © Highbeam Contributors
