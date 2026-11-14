/**
 * Highbeam Airlock Enforcement Receipt Generator (PDF 1.4, HTML, Markdown, JSON).
 * Zero plaintext secrets included; reports HMAC entity counts, fail-open coverage lapses,
 * schema drift status, and hash-chain integrity.
 */

import { buildPdf14Document, sha256HexPure } from '../../core-isomorphic/ui/pdfReceiptGenerator.mjs';
import { TESTED_CLAUDE_CODE_RANGE } from '../../core-isomorphic/airlock/claudeOutputShaper.mjs';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function generateAirlockEnforcementReceipt(summary = {}, options = {}) {
  const issuedAt = options.issuedAt || new Date().toISOString();
  const periodLabel = options.periodLabel || issuedAt.slice(0, 7);
  const workspaceName = options.workspaceName || 'workspace.local';
  const employeeEmail = options.email || summary.email || 'developer@workspace.local';

  const blockedCount = Number(summary.blockedCount || 0);
  const scrubbedCount = Number(summary.scrubbedCount || 0);
  const auditOnlyCount = Number(summary.auditOnlyCount || 0);
  const fm1BlockCount = Number(summary.fm1BlockCount || 0);
  const coverageLapses = Number(summary.coverageLapses || 0);
  const schemaDriftEvents = Number(summary.schemaDriftEvents || 0);
  const watchdogTimeouts = Number(summary.watchdogTimeouts || 0);
  const uniqueEntitiesCount = Number(summary.uniqueEntitiesCount || 0);
  const chainValid = summary.chainValid !== false;
  const mode = String(summary.mode || 'enforce');
  const hostVersion = String(summary.lastHostVersion || 'unknown');
  const schemaTested = summary.schemaTested !== false;
  const policyStatus = summary.policySigned
    ? (summary.policySignatureValid ? 'SIGNED (VALID)' : 'SIGNED (TAMPERED)')
    : 'UNSIGNED';

  const canonicalAudit = JSON.stringify({
    v: 1,
    kind: 'airlock_enforcement_receipt',
    periodLabel,
    workspaceName,
    employeeEmail,
    mode,
    blockedCount,
    scrubbedCount,
    auditOnlyCount,
    fm1BlockCount,
    coverageLapses,
    schemaDriftEvents,
    watchdogTimeouts,
    uniqueEntitiesCount,
    chainValid,
    policyStatus
  });
  const sha256 = sha256HexPure(canonicalAudit);
  const receiptId = `AL-${periodLabel.replace('-', '')}-${sha256.slice(0, 8).toUpperCase()}`;

  const lapseStatusText = coverageLapses === 0
    ? '0 (PASS - No observed hook lapse)'
    : `${coverageLapses} (WARNING - Fail-open coverage lapse observed)`;

  const pdfLines = [
    `Billing / Audit Period : ${periodLabel}`,
    `Workspace / Seat       : ${workspaceName} (${employeeEmail})`,
    `Airlock Posture        : mode=${mode} | Policy=${policyStatus} | Chain=${chainValid ? 'INTACT' : 'BROKEN'}`,
    `Host Runtime           : Claude Code=${hostVersion} (tested ${TESTED_CLAUDE_CODE_RANGE}) | Tested=${schemaTested}`,
    '-'.repeat(86),
    'ENFORCEMENT & COVERAGE METRICS (ZERO-PLAINTEXT LOCAL LEDGER)',
    '-'.repeat(86),
    `1. Pre-Tool / Prompt Blocks            : ${String(blockedCount).padStart(8)} calls`,
    `2. Post-Tool Output Scrubs             : ${String(scrubbedCount).padStart(8)} payloads`,
    `3. FM-1 Write-Only Placeholder Blocks  : ${String(fm1BlockCount).padStart(8)} retries`,
    `4. Stage-3 High-Entropy Audit Hits     : ${String(auditOnlyCount).padStart(8)} detections`,
    `5. Unique Secret Entities (Salted HMAC): ${String(uniqueEntitiesCount).padStart(8)} entities`,
    `6. Coverage Lapses (Target 0)          : ${lapseStatusText}`,
    `7. Schema Drift Events                 : ${String(schemaDriftEvents).padStart(8)}`,
    `8. Self-Timeout Fail-Closed Watchdogs  : ${String(watchdogTimeouts).padStart(8)}`,
    '-'.repeat(86),
    'Classification: Pre-Ingestion AI Context Airlock & Accidental Leakage Prevention',
    'Attestation   : Best-effort defense-in-depth control. Zero plaintext secrets stored.',
    'Note          : Antigravity hosts remain PreToolUse-only (PostToolUse receives {}).',
    `Verification Hash (SHA-256): ${sha256}`
  ];

  const pdfBytes = buildPdf14Document(pdfLines, {
    title: 'HIGHBEAM PRO - AIRLOCK ENFORCEMENT RECEIPT',
    receiptId,
    issuedAt,
    sha256
  });

  const markdown = [
    `# Highbeam Pro — Airlock Enforcement Receipt`,
    ``,
    `> Pre-Ingestion AI Context Airlock & Accidental Leakage Prevention (best-effort defense-in-depth control; zero plaintext secrets stored in ledger).`,
    ``,
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| **Receipt ID** | \`${receiptId}\` |`,
    `| **Period** | \`${periodLabel}\` |`,
    `| **Workspace / Seat** | \`${workspaceName}\` (\`${employeeEmail}\`) |`,
    `| **Airlock Mode / Policy** | \`${mode}\` / \`${policyStatus}\` |`,
    `| **Ledger Hash Chain** | \`${chainValid ? 'INTACT' : 'BROKEN'}\` (${Number(summary.chainCount || 0)} events) |`,
    `| **Host Version / Tested** | \`${hostVersion}\` (tested \`${TESTED_CLAUDE_CODE_RANGE}\`, schemaTested=\`${schemaTested}\`) |`,
    ``,
    `## Enforcement Summary`,
    `| Metric | Count |`,
    `| :--- | ---: |`,
    `| Pre-Tool / Prompt Blocks | ${blockedCount} |`,
    `| Post-Tool Output Scrubs | ${scrubbedCount} |`,
    `| FM-1 Write-Only Placeholder Blocks | ${fm1BlockCount} |`,
    `| Stage-3 High-Entropy Audit Hits | ${auditOnlyCount} |`,
    `| Unique Secret Entities (Salted HMAC) | ${uniqueEntitiesCount} |`,
    `| **Coverage Lapses (must be 0)** | **${coverageLapses}** |`,
    `| Schema Drift Events | ${schemaDriftEvents} |`,
    `| Watchdog Self-Timeouts (exit 2) | ${watchdogTimeouts} |`,
    ``,
    `> **SHA-256 Digest**: \`${sha256}\``
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Airlock Enforcement Receipt ${escapeHtml(receiptId)} — Highbeam Pro</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; max-width: 720px; margin: 32px auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px; }
  h1 { font-size: 18px; margin: 0 0 4px 0; }
  .meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #4b5563; margin-bottom: 14px; }
  .note { background: #f8fafc; border-left: 3px solid #2563eb; padding: 8px 12px; font-size: 12px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  td.num, th.num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .warn { color: #b91c1c; font-weight: 700; }
  .ok { color: #047857; font-weight: 700; }
  .digest { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #6b7280; margin-top: 16px; word-break: break-all; }
</style>
</head>
<body>
  <h1>Highbeam Pro — Airlock Enforcement Receipt</h1>
  <div class="meta">Receipt ID: ${escapeHtml(receiptId)} &middot; Period: ${escapeHtml(periodLabel)} &middot; Issued: ${escapeHtml(issuedAt)}</div>
  <div class="note">Pre-Ingestion AI Context Airlock &amp; Accidental Leakage Prevention. Best-effort defense-in-depth control; zero plaintext secrets stored in the local ledger.</div>
  <table>
    <tr><th>Workspace / Seat</th><td>${escapeHtml(workspaceName)} (${escapeHtml(employeeEmail)})</td><th>Policy / Chain</th><td>${escapeHtml(policyStatus)} / ${chainValid ? 'INTACT' : 'BROKEN'}</td></tr>
    <tr><th>Host Version</th><td>${escapeHtml(hostVersion)}</td><th>Schema Tested</th><td>${schemaTested ? 'YES' : 'UNTESTED VERSION'} (${escapeHtml(TESTED_CLAUDE_CODE_RANGE)})</td></tr>
  </table>
  <table>
    <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
    <tbody>
      <tr><td>Pre-Tool / Prompt Blocks</td><td class="num">${blockedCount}</td></tr>
      <tr><td>Post-Tool Output Scrubs</td><td class="num">${scrubbedCount}</td></tr>
      <tr><td>FM-1 Write-Only Placeholder Blocks</td><td class="num">${fm1BlockCount}</td></tr>
      <tr><td>Stage-3 High-Entropy Audit Hits</td><td class="num">${auditOnlyCount}</td></tr>
      <tr><td>Unique Secret Entities (Salted HMAC)</td><td class="num">${uniqueEntitiesCount}</td></tr>
      <tr><td>Coverage Lapses (Target: 0)</td><td class="num ${coverageLapses === 0 ? 'ok' : 'warn'}">${coverageLapses}</td></tr>
      <tr><td>Schema Drift Events</td><td class="num ${schemaDriftEvents === 0 ? 'ok' : 'warn'}">${schemaDriftEvents}</td></tr>
      <tr><td>Watchdog Fail-Closed Timeouts (exit 2)</td><td class="num">${watchdogTimeouts}</td></tr>
    </tbody>
  </table>
  <div class="digest">SHA-256 Audit Digest: ${escapeHtml(sha256)}</div>
</body>
</html>`;

  const json = {
    receiptId,
    issuedAt,
    periodLabel,
    workspaceName,
    employeeEmail,
    sha256,
    policyStatus,
    chainValid,
    hostVersion,
    testedClaudeCodeRange: TESTED_CLAUDE_CODE_RANGE,
    schemaTested,
    metrics: {
      blockedCount,
      scrubbedCount,
      auditOnlyCount,
      fm1BlockCount,
      coverageLapses,
      schemaDriftEvents,
      watchdogTimeouts,
      uniqueEntitiesCount
    },
    byCategory: summary.byCategory || {},
    byFmCode: summary.byFmCode || {}
  };

  return {
    receiptId,
    issuedAt,
    periodLabel,
    sha256,
    summary: json,
    pdfBytes,
    markdown,
    html,
    json
  };
}
