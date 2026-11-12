/**
 * @file packages/pro/src/team_finops_pack.mjs
 * Roadmap Item #8: Packaged "BYO-Grafana" Team Policy & OpenTelemetry Bundle ($299/yr for 5 Seats).
 *
 * Generates zero-backend Team FinOps artifacts fed by `src/core-isomorphic/telemetry/otelExporter.mjs`:
 *   1. `grafana-dashboard.json` (Grafana v10+ dashboard)
 *   2. `datadog-dashboard.json` (Datadog dashboard widget template)
 *   3. `.attention-horizon.json` (Committed Team Governance lockfile)
 *   4. `otel-collector-config.yaml` (Local OTel JSONL filelog -> Prometheus/OTLP pipeline)
 *   5. `README-TEAM-FINOPS.md` (5-minute zero-SaaS deployment guide)
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireProFeature } from '../../../src/core/pro_license.mjs';

/**
 * Builds the 5 Team FinOps Pack file payloads in memory.
 *
 * @param {object} [options={}]
 * @param {string} [options.orgName='Engineering Team']
 * @param {number} [options.seats=5]
 */
export function buildTeamFinopsArtifacts(options = {}) {
  const orgName = String(options.orgName || 'Engineering Team').trim();
  const seats = Math.max(1, Number(options.seats || 5));

  const grafanaDashboard = {
    uid: 'ah-team-finops-v4',
    title: `Attention Horizon — ${orgName} Context FinOps & KV-Cache ROI`,
    tags: ['attention-horizon', 'claude-code', 'antigravity', 'finops', 'otel'],
    timezone: 'browser',
    schemaVersion: 39,
    version: 1,
    refresh: '30s',
    panels: [
      {
        id: 1,
        type: 'timeseries',
        title: 'Actual LLM Spend vs. Verified Attention Horizon Savings (USD)',
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        targets: [
          {
            expr: 'sum by (vcs_repository_url_full, model) (claude_code_cost_usage)',
            legendFormat: 'Actual Spend ({{model}})'
          },
          {
            expr: 'sum by (vcs_repository_url_full, model) (attention_horizon_saved_quota_usd)',
            legendFormat: 'Verified Saved USD ({{model}})'
          }
        ]
      },
      {
        id: 2,
        type: 'stat',
        title: 'Team Prompt Cache Hit Ratio (%)',
        gridPos: { h: 8, w: 6, x: 12, y: 0 },
        targets: [
          {
            expr: '100 * sum(claude_code_token_usage{type="cacheRead"}) / clamp_min(sum(claude_code_token_usage{type=~"input|cacheRead|cacheCreation"}), 1)',
            legendFormat: 'Cache Hit %'
          }
        ]
      },
      {
        id: 3,
        type: 'stat',
        title: 'Total Circuit Breaker Interventions (DET-01..32)',
        gridPos: { h: 8, w: 6, x: 18, y: 0 },
        targets: [
          {
            expr: 'sum(attention_horizon_intervention_count)',
            legendFormat: 'Guard Trips'
          }
        ]
      },
      {
        id: 4,
        type: 'table',
        title: 'Negative Cache ROI & Cold-Rebuild Hotspots by Repository',
        gridPos: { h: 8, w: 24, x: 0, y: 8 },
        targets: [
          {
            expr: 'sum by (vcs_repository_url_full, vcs_ref_head_name, model) (claude_code_cost_usage{negative_cache_roi="true"})',
            legendFormat: '{{vcs_repository_url_full}} ({{vcs_ref_head_name}})'
          }
        ]
      }
    ]
  };

  const datadogDashboard = {
    title: `Attention Horizon — ${orgName} Agent FinOps (${seats} Seats)`,
    description: 'Zero-backend Claude Code & Google Antigravity KV-cache efficiency and DET-01..32 circuit breaker telemetry.',
    layout_type: 'ordered',
    widgets: [
      {
        definition: {
          title: 'LLM Spend vs. Attention Horizon Saved USD',
          type: 'timeseries',
          requests: [
            { q: 'sum:claude_code.cost.usage{*} by {model,vcs.repository.url.full}', display_type: 'bars' },
            { q: 'sum:attention_horizon.saved_quota.usd{*} by {model,vcs.repository.url.full}', display_type: 'line' }
          ]
        }
      },
      {
        definition: {
          title: 'Prompt Cache Read vs. Uncached Input Tokens',
          type: 'timeseries',
          requests: [
            { q: 'sum:claude_code.token.usage{type:cacheread} by {vcs.repository.url.full}', display_type: 'area' },
            { q: 'sum:claude_code.token.usage{type:input} by {vcs.repository.url.full}', display_type: 'line' }
          ]
        }
      },
      {
        definition: {
          title: 'Active Circuit Breaker Interventions',
          type: 'query_value',
          requests: [{ q: 'sum:attention_horizon.intervention.count{*}', aggregator: 'sum' }]
        }
      }
    ]
  };

  const teamPolicyConfig = {
    version: 1,
    organization: orgName,
    licensedSeats: seats,
    flightMode: 'AUTO_PILOT',
    detectorNamespace: 'canonical',
    teamGovernance: {
      enforceRing0Safety: true,
      enforceCrossHarnessScopeLocks: true,
      otelExportEnabled: true
    },
    detectors: {
      'DET-01': 'block',
      'DET-02': 'block',
      'DET-04': 'block',
      'DET-05': 'block',
      'DET-08': 'block',
      'DET-09': 'block',
      'DET-19': 'block',
      'DET-20': 'block'
    }
  };

  const otelCollectorYaml = [
    '# Attention Horizon — Zero-Backend Team FinOps OpenTelemetry Collector Config',
    'receivers:',
    '  filelog/attention_horizon:',
    '    include:',
    '      - ~/.attention-horizon/otel/metrics.jsonl',
    '      - ./.claude/telemetry/otel-metrics.jsonl',
    '    operators:',
    '      - type: json_parser',
    '',
    'processors:',
    '  batch:',
    '    timeout: 10s',
    '',
    'exporters:',
    '  prometheus:',
    '    endpoint: "127.0.0.1:9464"',
    '  otlphttp:',
    '    endpoint: "${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"',
    '',
    'service:',
    '  pipelines:',
    '    logs/attention_horizon:',
    '      receivers: [filelog/attention_horizon]',
    '      processors: [batch]',
    '      exporters: [prometheus, otlphttp]'
  ].join('\n') + '\n';

  const readmeMarkdown = [
    `# Attention Horizon Team FinOps Pack — ${orgName} (${seats} Seats)`,
    '',
    'Zero-backend team cost attribution, KV-cache warmth telemetry, and cross-harness (`Claude Code` + `Google Antigravity`) governance.',
    '',
    '## Included Files',
    '1. **`.attention-horizon.json`**: Commit this policy file to your repository root to standardize `DET-01..32` circuit breakers and cross-harness `DET-20` file-scope locks across all developers.',
    '2. **`grafana-dashboard.json`**: Import directly into Grafana (**Dashboards -> New -> Import**) to track actual LLM spend vs. Attention Horizon saved USD.',
    '3. **`datadog-dashboard.json`**: Import into Datadog (**Dashboards -> New Dashboard -> Import Dashboard JSON**).',
    '4. **`otel-collector-config.yaml`**: Point your local or CI OpenTelemetry Collector at `~/.attention-horizon/otel/metrics.jsonl` (`CLAUDE_CODE_ENABLE_TELEMETRY=1`).'
  ].join('\n') + '\n';

  return {
    orgName,
    seats,
    files: {
      'grafana-dashboard.json': JSON.stringify(grafanaDashboard, null, 2) + '\n',
      'datadog-dashboard.json': JSON.stringify(datadogDashboard, null, 2) + '\n',
      '.attention-horizon.json': JSON.stringify(teamPolicyConfig, null, 2) + '\n',
      'otel-collector-config.yaml': otelCollectorYaml,
      'README-TEAM-FINOPS.md': readmeMarkdown
    }
  };
}

/**
 * Writes the BYO-Grafana Team FinOps Pack to disk after checking Pro/Team entitlement.
 *
 * @param {object} [options={}]
 * @returns {{ ok: boolean, outDir: string | null, filesWritten: string[], entitlement: object }}
 */
export function generateTeamFinopsPack(options = {}) {
  const entitlement = requireProFeature('team_finops_pack', options);
  if (!entitlement.allowed && !options.preview) {
    return {
      ok: false,
      outDir: null,
      filesWritten: [],
      entitlement
    };
  }

  const outDir = path.resolve(
    options.outDir || path.join(options.cwd || process.cwd(), 'attention-horizon-team-pack')
  );
  fs.mkdirSync(outDir, { recursive: true });

  const artifacts = buildTeamFinopsArtifacts(options);
  const filesWritten = [];
  for (const [fileName, content] of Object.entries(artifacts.files)) {
    const fullPath = path.join(outDir, fileName);
    fs.writeFileSync(fullPath, content, 'utf8');
    filesWritten.push(fullPath);
  }

  return {
    ok: true,
    outDir,
    orgName: artifacts.orgName,
    seats: artifacts.seats,
    filesWritten,
    entitlement
  };
}
