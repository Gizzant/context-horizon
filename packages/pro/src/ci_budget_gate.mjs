/**
 * @file packages/pro/src/ci_budget_gate.mjs
 * Team Anchor #2: CI / PR Token-Budget Gate.
 *
 * Enforces organizational token/cost/cache-efficiency/safety budgets on PR branches
 * using `.attention-horizon.json` `ciBudgetGate` policy and emits GitHub Actions
 * workflow annotations + Markdown Job Summary tables. Zero runtime dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireProFeature } from './pro_license.mjs';
import { buildPrCostAttribution } from './pr_cost_attribution.mjs';

export const DEFAULT_CI_BUDGET_POLICY = Object.freeze({
  maxPrCostUsd: 15.0,
  maxPrTokens: 1_500_000,
  minCacheHitPct: 50,
  maxWasteRatioPct: 35,
  maxRing0Violations: 0,
  mode: 'enforce'
});

/**
 * Loads `.attention-horizon.json` `ciBudgetGate` policy merged with explicit CLI overrides.
 */
export function loadCiBudgetPolicy(cwd, overrides = {}) {
  const repoDir = path.resolve(cwd || process.cwd());
  const configPath = path.join(repoDir, '.attention-horizon.json');
  let filePolicy = {};

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed?.ciBudgetGate && typeof parsed.ciBudgetGate === 'object') {
        filePolicy = parsed.ciBudgetGate;
      }
    } catch (err) {
      void err; // Ignore malformed workspace config and use safe default policy.
    }
  }

  const merged = { ...DEFAULT_CI_BUDGET_POLICY };
  for (const key of Object.keys(DEFAULT_CI_BUDGET_POLICY)) {
    if (filePolicy[key] !== undefined && filePolicy[key] !== null) {
      merged[key] = key === 'mode' ? String(filePolicy[key]).toLowerCase() : Number(filePolicy[key]);
    }
    if (overrides[key] !== undefined && overrides[key] !== null) {
      merged[key] = key === 'mode' ? String(overrides[key]).toLowerCase() : Number(overrides[key]);
    }
  }

  if (merged.mode !== 'advisory' && merged.mode !== 'enforce') {
    merged.mode = 'enforce';
  }
  return merged;
}

/**
 * Evaluates a PR branch or attribution report against the Team CI Token-Budget Gate.
 */
export function evaluateCiBudgetGate(options = {}) {
  const entitlement = requireProFeature('team_ci_budget_gate', options);
  if (!entitlement.allowed && !options.preview) {
    return {
      ok: false,
      verdict: 'BLOCKED',
      exitCode: 2,
      entitlement,
      upgradeHint: entitlement.upgradeHint
    };
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const policy = loadCiBudgetPolicy(cwd, options.policyOverrides || options);

  let attribution = options.attribution || null;
  if (!attribution && options.inputPath) {
    const absIn = path.resolve(options.inputPath);
    if (!fs.existsSync(absIn)) {
      return {
        ok: false,
        verdict: 'ERROR',
        exitCode: 1,
        error: `Attribution input file not found: ${absIn}`,
        entitlement
      };
    }
    try {
      attribution = JSON.parse(fs.readFileSync(absIn, 'utf8'));
    } catch (err) {
      return {
        ok: false,
        verdict: 'ERROR',
        exitCode: 1,
        error: `Invalid attribution JSON: ${err?.message || String(err)}`,
        entitlement
      };
    }
  }

  if (!attribution) {
    const attrRes = buildPrCostAttribution({ ...options, cwd, preview: true });
    if (!attrRes.ok) {
      return {
        ok: false,
        verdict: 'ERROR',
        exitCode: 1,
        error: attrRes.error || 'Failed to compute PR cost attribution.',
        entitlement
      };
    }
    attribution = attrRes;
  }

  const summary = attribution.summary || attribution;
  const totalInputTokens = Number(summary.totalInputTokens || 0);
  const totalCacheReadTokens = Number(summary.totalCacheReadTokens || 0);
  const estimatedCostUsd = Number(summary.estimatedCostUsd || 0);
  const totalTokens = Number(summary.totalTokens || 0);
  const cacheHitPct = Number(summary.cacheHitPct || 0);
  const wasteRatioPct = Number(summary.wasteRatioPct || 0);
  const ring0Violations = Number(summary.ring0Violations || 0);

  const violations = [];

  if (estimatedCostUsd > policy.maxPrCostUsd) {
    violations.push({
      ruleId: 'MAX_PR_COST_USD',
      actual: estimatedCostUsd,
      limit: policy.maxPrCostUsd,
      message: `Estimated PR cost $${estimatedCostUsd.toFixed(4)} exceeds limit $${policy.maxPrCostUsd.toFixed(2)}`
    });
  }
  if (totalTokens > policy.maxPrTokens) {
    violations.push({
      ruleId: 'MAX_PR_TOKENS',
      actual: totalTokens,
      limit: policy.maxPrTokens,
      message: `Total PR tokens ${totalTokens.toLocaleString('en-US')} exceeds limit ${policy.maxPrTokens.toLocaleString('en-US')}`
    });
  }
  if (totalInputTokens + totalCacheReadTokens > 0 && cacheHitPct < policy.minCacheHitPct) {
    violations.push({
      ruleId: 'MIN_CACHE_HIT_PCT',
      actual: cacheHitPct,
      limit: policy.minCacheHitPct,
      message: `Prompt cache hit rate ${cacheHitPct}% is below minimum threshold ${policy.minCacheHitPct}%`
    });
  }
  if (wasteRatioPct > policy.maxWasteRatioPct) {
    violations.push({
      ruleId: 'MAX_WASTE_RATIO_PCT',
      actual: wasteRatioPct,
      limit: policy.maxWasteRatioPct,
      message: `Preventable waste ratio ${wasteRatioPct}% exceeds limit ${policy.maxWasteRatioPct}%`
    });
  }
  if (ring0Violations > policy.maxRing0Violations) {
    violations.push({
      ruleId: 'MAX_RING0_VIOLATIONS',
      actual: ring0Violations,
      limit: policy.maxRing0Violations,
      message: `Ring-0 guardrail violations (${ring0Violations}) exceed allowed maximum (${policy.maxRing0Violations})`
    });
  }

  let verdict = 'PASS';
  let exitCode = 0;
  if (violations.length > 0) {
    if (policy.mode === 'advisory') {
      verdict = 'WARN';
      exitCode = 0;
    } else {
      verdict = 'FAIL';
      exitCode = 1;
    }
  }

  const annotationLevel = verdict === 'FAIL' ? '::error' : '::warning';
  const annotations = violations.map(
    (v) => `${annotationLevel} title=Highbeam CI Budget Gate (${v.ruleId})::${v.message}`
  );

  return {
    ok: verdict !== 'FAIL',
    verdict,
    exitCode,
    policy,
    metrics: {
      estimatedCostUsd,
      totalTokens,
      cacheHitPct,
      wasteRatioPct,
      ring0Violations,
      totalInputTokens,
      totalCacheReadTokens
    },
    violations,
    annotations,
    entitlement
  };
}

/**
 * Formats CI Budget Gate evaluation as GitHub Actions Job Summary / PR comment Markdown.
 */
export function formatCiGateMarkdown(result = {}) {
  const m = result.metrics || {};
  const p = result.policy || DEFAULT_CI_BUDGET_POLICY;
  const violatedSet = new Set((result.violations || []).map((v) => v.ruleId));

  const statusTag = (ruleId) => (violatedSet.has(ruleId) ? result.verdict : 'PASS');

  const lines = [
    `### Highbeam CI / PR Token-Budget Gate: **${result.verdict || 'UNKNOWN'}** (\`mode: ${p.mode}\`)`,
    '',
    '| Check | Actual | Limit | Status |',
    '| :--- | :---: | :---: | :---: |',
    `| \`MAX_PR_COST_USD\` | \`$${Number(m.estimatedCostUsd || 0).toFixed(4)}\` | \`<=$${Number(p.maxPrCostUsd).toFixed(2)}\` | **${statusTag('MAX_PR_COST_USD')}** |`,
    `| \`MAX_PR_TOKENS\` | \`${Number(m.totalTokens || 0).toLocaleString('en-US')}\` | \`<=${Number(p.maxPrTokens).toLocaleString('en-US')}\` | **${statusTag('MAX_PR_TOKENS')}** |`,
    `| \`MIN_CACHE_HIT_PCT\` | \`${m.cacheHitPct ?? 0}%\` | \`>=${p.minCacheHitPct}%\` | **${statusTag('MIN_CACHE_HIT_PCT')}** |`,
    `| \`MAX_WASTE_RATIO_PCT\` | \`${m.wasteRatioPct ?? 0}%\` | \`<=${p.maxWasteRatioPct}%\` | **${statusTag('MAX_WASTE_RATIO_PCT')}** |`,
    `| \`MAX_RING0_VIOLATIONS\` | \`${m.ring0Violations ?? 0}\` | \`<=${p.maxRing0Violations}\` | **${statusTag('MAX_RING0_VIOLATIONS')}** |`
  ];

  if (Array.isArray(result.violations) && result.violations.length > 0) {
    lines.push('', '#### Violations', '');
    for (const v of result.violations) {
      lines.push(`- **${v.ruleId}**: ${v.message}`);
    }
  }

  return lines.join('\n') + '\n';
}
