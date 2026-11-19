'use strict';

const crypto = require('node:crypto');
const { isValidLoopbackPort } = require('./daemonClient.js');

function createNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderConnectedShellHtml({ port, nonce = createNonce() } = {}) {
  const numPort = Number(port);
  if (!isValidLoopbackPort(numPort)) {
    throw new Error(`Invalid loopback port for WebView shell: ${port}`);
  }
  const safeNonce = String(nonce || createNonce()).replace(/[^a-zA-Z0-9_-]/g, '');
  const origin = `http://127.0.0.1:${numPort}`;
  const iframeSrc = `${origin}/?vscode=1`;
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${safeNonce}'`,
    `script-src 'nonce-${safeNonce}'`,
    `frame-src ${origin}`,
    `connect-src ${origin}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Highbeam (ctxtop) HUD</title>
  <style nonce="${safeNonce}">
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #0B0C0E;
    }
    iframe {
      display: block;
      width: 100%;
      height: 100vh;
      border: 0;
      background: transparent;
    }
  </style>
</head>
<body>
  <iframe
    id="highbeamFrame"
    src="${iframeSrc}"
    title="Highbeam Context Horizon HUD"
    allow="clipboard-write"
  ></iframe>
  <script nonce="${safeNonce}">
    (function () {
      const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
      const expectedOrigin = ${JSON.stringify(origin)};
      const ALLOWED_TYPES = new Set(['focusChatInput', 'copyCompact', 'openExternal', 'runCommand']);
      window.addEventListener('message', function (ev) {
        if (ev.origin !== expectedOrigin || !ev.data || typeof ev.data !== 'object') return;
        const msgType = String(ev.data.type || '');
        if (!ALLOWED_TYPES.has(msgType)) return;
        if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
          vscodeApi.postMessage(ev.data);
        }
      });
    })();
  </script>
</body>
</html>
`;
}

function renderOfflineShellHtml({ status = 'offline', detail = '', nonce = createNonce() } = {}) {
  const safeNonce = String(nonce || createNonce()).replace(/[^a-zA-Z0-9_-]/g, '');
  const statusNorm = String(status || 'offline').toLowerCase();
  const statusLabel = statusNorm === 'starting'
    ? 'Starting Local Loopback Daemon'
    : 'Local Loopback Daemon Offline';
  const safeDetail = detail ? escapeHtml(detail) : 'Connect or start the Highbeam daemon on 127.0.0.1 to render live 40-cell telemetry and KV-cache TTL timers.';
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${safeNonce}'`,
    `script-src 'nonce-${safeNonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Highbeam (ctxtop) — Offline</title>
  <style nonce="${safeNonce}">
    :root {
      --bg-canvas: #0B0C0E;
      --bg-surface: #121417;
      --bg-elevated: #1B1E23;
      --hairline: rgba(255, 255, 255, 0.08);
      --text-primary: #F1F3F4;
      --text-secondary: #9AA0A6;
      --accent-focus: #1A73E8;
      --status-warning: #F29900;
      --font-sans: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg-canvas: #F8F9FA;
        --bg-surface: #FFFFFF;
        --bg-elevated: #F1F3F4;
        --hairline: rgba(0, 0, 0, 0.09);
        --text-primary: #111315;
        --text-secondary: #3C4043;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg-canvas);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.45;
    }
    .panel {
      background: var(--bg-surface);
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title {
      font-size: 13px;
      font-weight: 600;
      margin: 0;
    }
    .badge {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid var(--hairline);
      background: var(--bg-elevated);
      color: var(--status-warning);
    }
    .detail {
      margin: 0;
      color: var(--text-secondary);
      font-size: 12px;
      word-break: break-word;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      height: 28px;
      padding: 0 11px;
      border-radius: 6px;
      border: 1px solid var(--hairline);
      background: var(--bg-elevated);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    button.primary {
      background: var(--accent-focus);
      border-color: var(--accent-focus);
      color: #FFFFFF;
    }
    button:hover {
      opacity: 0.92;
    }
    .compact-box {
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    #compactInstruction {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
    }
    .meta {
      margin: 0;
      font-size: 11px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }
  </style>
</head>
<body>
  <section class="panel" aria-live="polite">
    <div class="header-row">
      <h1 class="title">${escapeHtml(statusLabel)}</h1>
      <span class="badge">${statusNorm === 'starting' ? 'CONNECTING' : 'OFFLINE'}</span>
    </div>
    <p class="detail">${safeDetail}</p>
    <div class="actions">
      <button type="button" class="primary" data-action="startDaemon">Start Local Daemon</button>
      <button type="button" data-action="runAudit">Run 7-Day Audit</button>
    </div>
    <div class="compact-box">
      <p id="compactInstruction">Type /compact in the chat box and press Enter</p>
      <button type="button" id="btnCompactPrimary" data-action="copyCompact">Copy /compact</button>
    </div>
    <p class="meta">127.0.0.1 loopback only · 0 external network requests</p>
  </section>
  <script nonce="${safeNonce}">
    (function () {
      const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
      document.addEventListener('click', function (ev) {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (!action || !vscodeApi || typeof vscodeApi.postMessage !== 'function') return;
        vscodeApi.postMessage({ type: action });
      });
    })();
  </script>
</body>
</html>
`;
}

module.exports = {
  createNonce,
  escapeHtml,
  renderConnectedShellHtml,
  renderOfflineShellHtml
};
