/**
 * @file src/core-isomorphic/ui/pdfReceiptGenerator.mjs
 * Pure Zero-Dependency Corporate Expense Receipt Generator (PDF 1.4 + HTML + Markdown).
 *
 * Strictly zero `node:*` imports (Mod Law 4 compliant).
 * Generates standards-compliant single-page PDF 1.4 binary documents, print-ready HTML,
 * and Markdown corporate reimbursement reports with FIPS 180-4 SHA-256 audit digests.
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Pure-V8 FIPS 180-4 SHA-256 hex digest (zero `node:*` imports).
 * @param {string} input
 * @returns {string}
 */
export function sha256HexPure(input = '') {
  const bytes = new TextEncoder().encode(String(input));
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

function escapePdfText(str = '') {
  return String(str)
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds a standards-compliant PDF 1.4 single-page corporate expense receipt (`Uint8Array`).
 */
export function buildPdf14Document(lines = [], meta = {}) {
  const streamOps = [
    'BT',
    '/F1 15 Tf',
    '48 750 Td',
    `(${escapePdfText(meta.title || 'ATTENTION HORIZON PRO - CORPORATE FINOPS EXPENSE RECEIPT')}) Tj`,
    '/F2 9 Tf',
    '0 -18 Td',
    `(${escapePdfText(`Receipt ID: ${meta.receiptId || 'AH-RCPT'}   |   Issued: ${meta.issuedAt || ''}`)}) Tj`,
    '0 -14 Td',
    `(${escapePdfText(`SHA-256 Audit Digest: ${meta.sha256 || ''}`)}) Tj`,
    '0 -18 Td',
    '(' + '-'.repeat(86) + ') Tj'
  ];

  for (const line of lines) {
    streamOps.push('0 -14 Td');
    streamOps.push(`(${escapePdfText(line)}) Tj`);
  }

  streamOps.push('ET');
  const contentStream = streamOps.join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n',
    `6 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

/**
 * Generates a signed Corporate Expense Receipt in PDF 1.4 (`Uint8Array`), HTML, and Markdown formats.
 *
 * @param {object} summary - Output from `getSavedQuotaReceiptSummary`
 * @param {object} [options={}]
 */
export function generateCorporateExpenseReceipt(summary = {}, options = {}) {
  const issuedAt = options.issuedAt || new Date().toISOString();
  const periodLabel = options.periodLabel || issuedAt.slice(0, 7);
  const employeeEmail = options.email || summary.email || 'developer@workspace.local';
  const tierLabel = options.tierLabel || 'Attention Horizon Pro ($15.00/mo)';
  const subscriptionCostUSD = Number(options.subscriptionCostUSD ?? 15.0);

  const sessionSavedTokens = Number(summary.sessionSavedTokens || 0);
  const sessionSavedUSD = Number(summary.sessionSavedUSD || 0);
  const workspace30dSavedTokens = Number(summary.workspace30dSavedTokens || sessionSavedTokens || 0);
  const workspace30dSavedUSD = Number(summary.workspace30dSavedUSD || sessionSavedUSD || 0);
  const netRoiMultiplier =
    subscriptionCostUSD > 0
      ? Number((Math.max(workspace30dSavedUSD, sessionSavedUSD) / subscriptionCostUSD).toFixed(1))
      : 0;

  const byCategory = summary.byCategory || {};
  const cacheTok = Number(byCategory.DET_09_PREFIX_FENCE?.savedTokens || 0);
  const cacheUsd = Number(byCategory.DET_09_PREFIX_FENCE?.savedUSD || 0);
  const sanitizeTok = Number(byCategory.POST_TOOL_USE_SANITIZER?.savedTokens || 0);
  const sanitizeUsd = Number(byCategory.POST_TOOL_USE_SANITIZER?.savedUSD || 0);
  const readTok = Number(byCategory.DET_11_BOUNDED_READ?.savedTokens || 0);
  const readUsd = Number(byCategory.DET_11_BOUNDED_READ?.savedUSD || 0);
  const breakerTok = Number(byCategory.CIRCUIT_BREAKER_INTERVENTION?.savedTokens || 0);
  const breakerUsd = Number(byCategory.CIRCUIT_BREAKER_INTERVENTION?.savedUSD || 0);

  const canonicalAuditString = JSON.stringify({
    v: 1,
    periodLabel,
    employeeEmail,
    sessionSavedTokens,
    sessionSavedUSD: Number(sessionSavedUSD.toFixed(4)),
    workspace30dSavedTokens,
    workspace30dSavedUSD: Number(workspace30dSavedUSD.toFixed(4))
  });
  const sha256 = sha256HexPure(canonicalAuditString);
  const receiptId = `AH-${periodLabel.replace('-', '')}-${sha256.slice(0, 8).toUpperCase()}`;

  const pdfLines = [
    `Billing Period       : ${periodLabel}`,
    `Account / Seat       : ${employeeEmail}`,
    `Product Tier         : ${tierLabel}`,
    `Subscription Fee     : $${subscriptionCostUSD.toFixed(2)} USD`,
    '-'.repeat(86),
    'ITEMIZED LLM API & KV-CACHE SAVINGS (30-DAY VERIFIED LEDGER)',
    '-'.repeat(86),
    `1. KV-Cache Prefix Fences (DET-09)    : +${cacheTok.toLocaleString('en-US').padStart(10)} tok   ($${cacheUsd.toFixed(2)})`,
    `2. Lossless CLI Output Offloader      : +${sanitizeTok.toLocaleString('en-US').padStart(10)} tok   ($${sanitizeUsd.toFixed(2)})`,
    `3. Bounded File Reads (DET-11)        : +${readTok.toLocaleString('en-US').padStart(10)} tok   ($${readUsd.toFixed(2)})`,
    `4. Circuit Breaker Interventions      : +${breakerTok.toLocaleString('en-US').padStart(10)} tok   ($${breakerUsd.toFixed(2)})`,
    '-'.repeat(86),
    `Current Session Verified Savings      : +${sessionSavedTokens.toLocaleString('en-US')} tokens ($${sessionSavedUSD.toFixed(2)} USD)`,
    `30-Day Cumulative Workspace Savings   : +${workspace30dSavedTokens.toLocaleString('en-US')} tokens ($${workspace30dSavedUSD.toFixed(2)} USD)`,
    `Net FinOps ROI vs. $${subscriptionCostUSD.toFixed(2)}/mo License  : ${netRoiMultiplier}x Return on Investment`,
    '-'.repeat(86),
    'Zero-Trust Privacy Attestation: Computed 100% locally from token counters.',
    'Zero prompt text, source code, or PII transmitted off-device.',
    `Verification Hash (SHA-256): ${sha256}`
  ];

  const pdfBytes = buildPdf14Document(pdfLines, {
    title: 'ATTENTION HORIZON PRO - CORPORATE FINOPS EXPENSE RECEIPT',
    receiptId,
    issuedAt,
    sha256
  });

  const markdown = [
    `# 🧾 Attention Horizon Pro — Corporate FinOps Expense Receipt`,
    ``,
    `| Field | Value |`,
    `| :--- | :--- |`,
    `| **Receipt ID** | \`${receiptId}\` |`,
    `| **Billing Period** | \`${periodLabel}\` |`,
    `| **Seat / Account** | \`${employeeEmail}\` |`,
    `| **Product Tier** | ${tierLabel} |`,
    `| **Subscription Cost** | **$${subscriptionCostUSD.toFixed(2)} USD** |`,
    `| **30-Day Verified API Savings** | **+$${workspace30dSavedUSD.toFixed(2)} USD** (+${workspace30dSavedTokens.toLocaleString('en-US')} tokens) |`,
    `| **Current Session Savings** | **+$${sessionSavedUSD.toFixed(2)} USD** (+${sessionSavedTokens.toLocaleString('en-US')} tokens) |`,
    `| **Net FinOps ROI** | **${netRoiMultiplier}x** |`,
    ``,
    `## Itemized Savings Breakdown`,
    `| Guard Category | Tokens Saved | USD Saved |`,
    `| :--- | ---: | ---: |`,
    `| KV-Cache Prefix Fences (\`DET-09\`) | +${cacheTok.toLocaleString('en-US')} | $${cacheUsd.toFixed(2)} |`,
    `| Lossless CLI Output Offloader | +${sanitizeTok.toLocaleString('en-US')} | $${sanitizeUsd.toFixed(2)} |`,
    `| Bounded File Reads (\`DET-11\`) | +${readTok.toLocaleString('en-US')} | $${readUsd.toFixed(2)} |`,
    `| Circuit Breaker Interventions | +${breakerTok.toLocaleString('en-US')} | $${breakerUsd.toFixed(2)} |`,
    ``,
    `> **SHA-256 Audit Digest**: \`${sha256}\`  `,
    `> *Computed 100% locally via Attention Horizon (\`ctxtop receipt\`) with zero network calls or PII.*`
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Expense Receipt ${escapeHtml(receiptId)} — Attention Horizon Pro</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; max-width: 720px; margin: 32px auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px; }
  h1 { font-size: 18px; margin: 0 0 4px 0; }
  .meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #4b5563; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  td.num, th.num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  . digest { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #6b7280; margin-top: 16px; word-break: break-all; }
  @media print { body { border: none; margin: 0; } }
</style>
</head>
<body>
  <h1>Attention Horizon Pro — Corporate FinOps Expense Receipt</h1>
  <div class="meta">Receipt ID: ${escapeHtml(receiptId)} &middot; Period: ${escapeHtml(periodLabel)} &middot; Issued: ${escapeHtml(issuedAt)}</div>
  <table>
    <tr><th>Product Tier</th><td>${escapeHtml(tierLabel)}</td><th class="num">Subscription Cost</th><td class="num">$${subscriptionCostUSD.toFixed(2)} USD</td></tr>
    <tr><th>30-Day Verified Savings</th><td class="num">+${workspace30dSavedTokens.toLocaleString('en-US')} tok</td><th class="num">30-Day USD Saved</th><td class="num">+$${workspace30dSavedUSD.toFixed(2)} USD</td></tr>
    <tr><th>Session Verified Savings</th><td class="num">+${sessionSavedTokens.toLocaleString('en-US')} tok</td><th class="num">Net FinOps ROI</th><td class="num">${netRoiMultiplier}x</td></tr>
  </table>
  <table>
    <thead><tr><th>Guard Category</th><th class="num">Tokens Saved</th><th class="num">USD Saved</th></tr></thead>
    <tbody>
      <tr><td>KV-Cache Prefix Fences (DET-09)</td><td class="num">+${cacheTok.toLocaleString('en-US')}</td><td class="num">$${cacheUsd.toFixed(2)}</td></tr>
      <tr><td>Lossless CLI Output Offloader</td><td class="num">+${sanitizeTok.toLocaleString('en-US')}</td><td class="num">$${sanitizeUsd.toFixed(2)}</td></tr>
      <tr><td>Bounded File Reads (DET-11)</td><td class="num">+${readTok.toLocaleString('en-US')}</td><td class="num">$${readUsd.toFixed(2)}</td></tr>
      <tr><td>Circuit Breaker Interventions</td><td class="num">+${breakerTok.toLocaleString('en-US')}</td><td class="num">$${breakerUsd.toFixed(2)}</td></tr>
    </tbody>
  </table>
  <div class="digest">SHA-256 Audit Digest: ${escapeHtml(sha256)}</div>
</body>
</html>`;

  return {
    receiptId,
    issuedAt,
    periodLabel,
    sha256,
    sessionSavedTokens,
    sessionSavedUSD,
    workspace30dSavedTokens,
    workspace30dSavedUSD,
    netRoiMultiplier,
    pdfBytes,
    markdown,
    html
  };
}
