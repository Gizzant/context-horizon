/**
 * @file packages/pro/src/team_finops_rollup.mjs
 * Team Anchor #1: Zero-Knowledge Org FinOps Rollup & PII Firewall.
 *
 * Allows developers to emit strictly aggregate, salted-pseudonymous telemetry snapshots
 * containing zero prompts, zero source paths, zero emails, and zero secrets, and lets
 * Team leads aggregate them offline into Org FinOps Markdown/JSON/CSV rollups.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requireProFeature } from './pro_license.mjs';

export const ZK_SNAPSHOT_FORMAT = 'highbeam-zk-finops/v1';
export const ORG_ROLLUP_FORMAT = 'highbeam-org-rollup/v1';

export const FORBIDDEN_ZK_KEYS = Object.freeze(
  new Set([
    'prompt',
    'prompts',
    'content',
    'messages',
    'diff',
    'filePath',
    'filePaths',
    'absolutePath',
    'email',
    'username',
    'user',
    'workspacePath',
    'cwd',
    'rawOutput',
    'command'
  ])
);

const EMAIL_VALUE_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PATH_VALUE_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\/|file:\/\/\/)/i;
const SECRET_VALUE_RE =
  /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bsk-ant-[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bghp_[A-Za-z0-9]{12,}|\bAKIA[0-9A-Z]{12,}|\bBearer\s+[A-Za-z0-9._-]{12,})/i;

/**
 * Generates a one-way salted pseudonym (`dev_<12hex>`) from a raw developer identity.
 */
export function pseudonymizeDeveloperId(rawIdentity = 'developer', orgSalt = 'highbeam-default-salt') {
  const input = `${String(orgSalt || 'highbeam-default-salt')}:${String(rawIdentity || 'developer')}`;
  const hex = crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
  return `dev_${hex}`;
}

/**
 * Enforces Zero-Knowledge PII/path/secret firewall across an entire snapshot object.
 */
export function verifyZeroKnowledgeSnapshot(snapshot) {
  const violations = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { valid: false, violations: ['Snapshot must be a JSON object'] };
  }
  if (snapshot.format !== ZK_SNAPSHOT_FORMAT) {
    violations.push(`Unsupported snapshot format: ${String(snapshot.format || 'missing')}`);
  }
  if (typeof snapshot.developerPseudonym !== 'string' || !/^dev_[a-f0-9]{12}$/.test(snapshot.developerPseudonym)) {
    violations.push('Invalid or missing developerPseudonym (expected /^dev_[a-f0-9]{12}$/)');
  }
  if (!snapshot.metrics || typeof snapshot.metrics !== 'object' || Array.isArray(snapshot.metrics)) {
    violations.push('Missing numeric metrics block');
  }

  const walk = (node, pointer) => {
    if (typeof node === 'string') {
      if (PATH_VALUE_RE.test(node)) {
        violations.push(`Forbidden OS/file path detected at ${pointer}`);
      }
      if (EMAIL_VALUE_RE.test(node)) {
        violations.push(`Forbidden email address detected at ${pointer}`);
      }
      if (SECRET_VALUE_RE.test(node)) {
        violations.push(`Forbidden credential/token detected at ${pointer}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${pointer}[${idx}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_ZK_KEYS.has(k)) {
          violations.push(`Forbidden key "${k}" at ${pointer}.${k}`);
        }
        walk(v, `${pointer}.${k}`);
      }
    }
  };

  walk(snapshot, '$');
  return { valid: violations.length === 0, violations };
}

/**
 * Emits a strictly aggregate Zero-Knowledge developer snapshot (Team/Trial only).
 */
export function buildRedactedDeveloperSnapshot(options = {}) {
  const entitlement = requireProFeature('team_org_rollup', options);
  if (!entitlement.allowed && !options.preview) {
    return { ok: false, entitlement, upgradeHint: entitlement.upgradeHint };
  }

  const orgSalt = String(options.orgSalt || 'highbeam-default-salt');
  const rawIdentity =
    options.developerId ||
    entitlement?.status?.email ||
    globalThis.process?.env?.HIGHBEAM_DEV_ID ||
    globalThis.process?.env?.USERNAME ||
    globalThis.process?.env?.USER ||
    'developer';
  const developerPseudonym = pseudonymizeDeveloperId(rawIdentity, orgSalt);
  const windowDays = Math.max(1, Number(options.windowDays || 30));

  const ledger = options.ledgerSummary || {};
  const audit = options.auditReport || {};

  const inputTokens = Math.max(0, Number(audit.inputTokens ?? ledger.inputTokens ?? 0));
  const cacheReadTokens = Math.max(0, Number(audit.cacheReadTokens ?? ledger.cacheReadTokens ?? 0));
  const outputTokens = Math.max(0, Number(audit.outputTokens ?? ledger.outputTokens ?? 0));
  const totalTokens = Math.max(
    inputTokens + cacheReadTokens + outputTokens,
    Number(audit.totalTokens ?? ledger.totalTokens ?? 0)
  );
  const denom = inputTokens + cacheReadTokens;
  const cacheHitPct =
    denom > 0
      ? Math.round((cacheReadTokens / denom) * 100)
      : Math.max(0, Math.min(100, Number(audit.cacheHitPct ?? 0)));

  const metrics = {
    sessionsCount: Math.max(0, Number(audit.sessionsScanned ?? ledger.sessionsCount ?? 0)),
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    cacheHitPct,
    estimatedSpendUsd: Number(Number(audit.estimatedSpendUsd ?? ledger.estimatedSpendUsd ?? 0).toFixed(4)),
    estimatedSavedUsd: Number(
      Number(ledger.workspace30dSavedUSD ?? audit.estimatedSavedUsd ?? 0).toFixed(4)
    ),
    preventableWasteTokens: Math.max(
      0,
      Number(audit.preventableWasteTokens ?? audit.sludgeTokens ?? 0)
    ),
    preventableWasteUsd: Number(Number(audit.preventableWasteUsd ?? 0).toFixed(4)),
    ring0Violations: Math.max(0, Number(audit.ring0Violations ?? 0))
  };

  const detectorTrips = {};
  if (options.detectorCounts && typeof options.detectorCounts === 'object') {
    for (const [detId, cnt] of Object.entries(options.detectorCounts)) {
      const cleanId = String(detId || '').trim();
      const num = Math.max(0, Number(cnt || 0));
      if (cleanId && num >= 0) detectorTrips[cleanId] = num;
    }
  }

  const models = {};
  if (options.modelBreakdown && typeof options.modelBreakdown === 'object') {
    for (const [modelId, info] of Object.entries(options.modelBreakdown)) {
      const cleanModel = String(modelId || '').trim();
      if (!cleanModel || !info || typeof info !== 'object') continue;
      models[cleanModel] = {
        tokens: Math.max(0, Number(info.tokens || 0)),
        spendUsd: Number(Number(info.spendUsd || 0).toFixed(4)),
        savedUsd: Number(Number(info.savedUsd || 0).toFixed(4))
      };
    }
  }

  const bodyForId = { developerPseudonym, windowDays, metrics, detectorTrips, models };
  const snapshotId = crypto.createHash('sha256').update(JSON.stringify(bodyForId), 'utf8').digest('hex').slice(0, 16);

  const snapshot = {
    format: ZK_SNAPSHOT_FORMAT,
    snapshotId,
    generatedAt: options.generatedAt || new Date().toISOString(),
    developerPseudonym,
    windowDays,
    metrics,
    detectorTrips,
    models
  };

  const verification = verifyZeroKnowledgeSnapshot(snapshot);
  return {
    ok: verification.valid,
    snapshot,
    verification,
    entitlement
  };
}

/**
 * Aggregates Zero-Knowledge developer snapshots into an Org FinOps Rollup (Team/Trial only).
 */
export function aggregateOrgFinopsRollup(options = {}) {
  const entitlement = requireProFeature('team_org_rollup', options);
  if (!entitlement.allowed && !options.preview) {
    return { ok: false, entitlement, upgradeHint: entitlement.upgradeHint };
  }

  const orgName = String(options.orgName || 'Engineering Team').trim();
  const licensedSeats = Math.max(1, Number(options.seats || entitlement?.status?.seats || 5));

  const candidateRecords = [];
  if (Array.isArray(options.snapshots)) {
    options.snapshots.forEach((snap, idx) => {
      candidateRecords.push({ source: `memory[${idx}]`, snap });
    });
  } else if (options.inDir) {
    const dir = path.resolve(options.inDir);
    if (!fs.existsSync(dir)) {
      return { ok: false, error: `Snapshot directory not found: ${dir}`, entitlement };
    }
    const entries = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json')).sort();
    for (const name of entries) {
      const fullPath = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        candidateRecords.push({ source: name, snap: parsed });
      } catch (err) {
        candidateRecords.push({
          source: name,
          parseError: `Malformed JSON: ${err?.message || String(err)}`
        });
      }
    }
  }

  const acceptedMap = new Map();
  const rejectedSnapshots = [];

  for (const item of candidateRecords) {
    if (item.parseError) {
      rejectedSnapshots.push({ source: item.source, violations: [item.parseError] });
      continue;
    }
    const check = verifyZeroKnowledgeSnapshot(item.snap);
    if (!check.valid) {
      rejectedSnapshots.push({ source: item.source, violations: check.violations });
      continue;
    }
    const dedupKey = item.snap.snapshotId || `${item.snap.developerPseudonym}:${item.snap.windowDays}`;
    if (!acceptedMap.has(dedupKey)) {
      acceptedMap.set(dedupKey, item.snap);
    }
  }

  const accepted = Array.from(acceptedMap.values());
  const developersSet = new Set();
  const detectorTotals = new Map();
  const modelTotals = new Map();

  let sessionsCount = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let totalEstimatedSpendUsd = 0;
  let totalEstimatedSavedUsd = 0;
  let preventableWasteTokens = 0;
  let preventableWasteUsd = 0;
  let ring0Violations = 0;

  for (const snap of accepted) {
    developersSet.add(snap.developerPseudonym);
    const m = snap.metrics || {};
    sessionsCount += Number(m.sessionsCount || 0);
    inputTokens += Number(m.inputTokens || 0);
    cacheReadTokens += Number(m.cacheReadTokens || 0);
    outputTokens += Number(m.outputTokens || 0);
    totalTokens += Number(m.totalTokens || 0);
    totalEstimatedSpendUsd += Number(m.estimatedSpendUsd || 0);
    totalEstimatedSavedUsd += Number(m.estimatedSavedUsd || 0);
    preventableWasteTokens += Number(m.preventableWasteTokens || 0);
    preventableWasteUsd += Number(m.preventableWasteUsd || 0);
    ring0Violations += Number(m.ring0Violations || 0);

    for (const [detId, count] of Object.entries(snap.detectorTrips || {})) {
      detectorTotals.set(detId, (detectorTotals.get(detId) || 0) + Number(count || 0));
    }
    for (const [modelId, info] of Object.entries(snap.models || {})) {
      const cur = modelTotals.get(modelId) || { model: modelId, tokens: 0, spendUsd: 0, savedUsd: 0 };
      cur.tokens += Number(info?.tokens || 0);
      cur.spendUsd = Number((cur.spendUsd + Number(info?.spendUsd || 0)).toFixed(4));
      cur.savedUsd = Number((cur.savedUsd + Number(info?.savedUsd || 0)).toFixed(4));
      modelTotals.set(modelId, cur);
    }
  }

  const denom = inputTokens + cacheReadTokens;
  const cacheHitPct = denom > 0 ? Math.round((cacheReadTokens / denom) * 100) : 0;
  const monthlySeatCostUsd = Number(((299 / 12) + Math.max(0, licensedSeats - 5) * 39).toFixed(2));
  const netRoiMultiplier =
    monthlySeatCostUsd > 0 ? Number((totalEstimatedSavedUsd / monthlySeatCostUsd).toFixed(2)) : 0;

  const topDetectors = Array.from(detectorTotals.entries())
    .map(([detectorId, count]) => ({ detectorId, count }))
    .sort((a, b) => b.count - a.count || a.detectorId.localeCompare(b.detectorId));

  const models = Array.from(modelTotals.values()).sort((a, b) => b.tokens - a.tokens || b.spendUsd - a.spendUsd);

  return {
    ok: true,
    format: ORG_ROLLUP_FORMAT,
    generatedAt: new Date().toISOString(),
    orgName,
    licensedSeats,
    activeDevelopers: developersSet.size,
    acceptedCount: accepted.length,
    rejectedCount: rejectedSnapshots.length,
    rejectedSnapshots,
    summary: {
      sessionsCount,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      cacheHitPct,
      totalEstimatedSpendUsd: Number(totalEstimatedSpendUsd.toFixed(4)),
      totalEstimatedSavedUsd: Number(totalEstimatedSavedUsd.toFixed(4)),
      preventableWasteTokens,
      preventableWasteUsd: Number(preventableWasteUsd.toFixed(4)),
      ring0Violations,
      monthlySeatCostUsd,
      netRoiMultiplier
    },
    topDetectors,
    models,
    entitlement
  };
}

/**
 * Formats an Org FinOps Rollup as Executive Markdown.
 */
export function formatOrgRollupMarkdown(rollup = {}) {
  const s = rollup.summary || {};
  const lines = [
    `# Highbeam Org FinOps Rollup — ${rollup.orgName || 'Engineering Team'}`,
    '',
    `Active Developers: \`${rollup.activeDevelopers ?? 0}/${rollup.licensedSeats ?? 5}\` · Accepted Snapshots: \`${rollup.acceptedCount ?? 0}\` · Rejected (PII/Schema): \`${rollup.rejectedCount ?? 0}\``,
    '',
    '| Metric | Value |',
    '| :--- | :--- |',
    `| **Total Org Tokens** | \`${((s.totalTokens || 0) / 1_000_000).toFixed(2)}M\` |`,
    `| **Org Cache Hit Rate** | \`${s.cacheHitPct ?? 0}%\` |`,
    `| **Estimated Org Spend** | \`$${Number(s.totalEstimatedSpendUsd || 0).toFixed(2)}\` |`,
    `| **Estimated Highbeam Savings** | \`$${Number(s.totalEstimatedSavedUsd || 0).toFixed(2)}\` |`,
    `| **Preventable Waste Remaining** | \`$${Number(s.preventableWasteUsd || 0).toFixed(2)}\` (\`${((s.preventableWasteTokens || 0) / 1000).toFixed(1)}k\` tok) |`,
    `| **Monthly Seat Cost / Net ROI** | \`$${Number(s.monthlySeatCostUsd || 0).toFixed(2)}/mo\` · \`${s.netRoiMultiplier ?? 0}x\` |`
  ];

  if (Array.isArray(rollup.topDetectors) && rollup.topDetectors.length > 0) {
    lines.push('', '## Top Triggered Guardrails', '', '| Detector | Interventions |', '| :--- | :---: |');
    for (const d of rollup.topDetectors) {
      lines.push(`| \`${d.detectorId}\` | \`${d.count}\` |`);
    }
  }

  if (Array.isArray(rollup.models) && rollup.models.length > 0) {
    lines.push('', '## Spend & Savings by Model', '', '| Model | Tokens | Spend USD | Saved USD |', '| :--- | :---: | :---: | :---: |');
    for (const m of rollup.models) {
      lines.push(
        `| \`${m.model}\` | \`${(m.tokens / 1000).toFixed(1)}k\` | \`$${Number(m.spendUsd || 0).toFixed(2)}\` | \`$${Number(m.savedUsd || 0).toFixed(2)}\` |`
      );
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Formats an Org FinOps Rollup as RFC-4180 CSV (org summary + per-model breakdown).
 */
export function formatOrgRollupCsv(rollup = {}) {
  const s = rollup.summary || {};
  const escapeCsv = (val) => {
    const str = String(val ?? '');
    if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const header = [
    'rowType',
    'orgName',
    'key',
    'activeDevelopers',
    'licensedSeats',
    'totalTokens',
    'cacheHitPct',
    'estimatedSpendUsd',
    'estimatedSavedUsd',
    'preventableWasteUsd',
    'monthlySeatCostUsd',
    'netRoiMultiplier'
  ].join(',');

  const rows = [
    header,
    [
      'org_summary',
      rollup.orgName || 'Engineering Team',
      'ALL',
      rollup.activeDevelopers ?? 0,
      rollup.licensedSeats ?? 5,
      s.totalTokens ?? 0,
      s.cacheHitPct ?? 0,
      Number(s.totalEstimatedSpendUsd || 0).toFixed(4),
      Number(s.totalEstimatedSavedUsd || 0).toFixed(4),
      Number(s.preventableWasteUsd || 0).toFixed(4),
      Number(s.monthlySeatCostUsd || 0).toFixed(2),
      Number(s.netRoiMultiplier || 0).toFixed(2)
    ]
      .map(escapeCsv)
      .join(',')
  ];

  for (const m of rollup.models || []) {
    rows.push(
      [
        'model',
        rollup.orgName || 'Engineering Team',
        m.model,
        rollup.activeDevelopers ?? 0,
        rollup.licensedSeats ?? 5,
        m.tokens ?? 0,
        '',
        Number(m.spendUsd || 0).toFixed(4),
        Number(m.savedUsd || 0).toFixed(4),
        '',
        '',
        ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  return rows.join('\n') + '\n';
}
