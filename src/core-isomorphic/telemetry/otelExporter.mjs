/**
 * @file src/telemetry/otelExporter.mjs
 * Zero-socket local OpenTelemetry metric formatter and sink for Claude Code Attention Horizon.
 * Maps `claude_code.token.usage`, `claude_code.cost.usage`, and `vcs.*` attributes when
 * `CLAUDE_CODE_ENABLE_TELEMETRY=1` is set.
 */

import { path, getCwd, appendJsonlSafe } from '../utils/runtime.mjs';

/**
 * Checks whether OpenTelemetry export is enabled via environment or explicit option.
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function isOtelEnabled(options = {}) {
  if (typeof options.enabled === 'boolean') {
    return options.enabled;
  }
  const envVal = String(globalThis.process?.env?.CLAUDE_CODE_ENABLE_TELEMETRY || '').trim();
  return envVal === '1' || envVal.toLowerCase() === 'true';
}

/**
 * Strips embedded basic-auth/PAT credentials (`https://user:ghp_secret@github.com/...`)
 * and query/fragment tokens before writing `vcs.repository.url.full` (`ISS-030`).
 *
 * @param {string} [rawUrl='']
 * @returns {string}
 */
export function sanitizeRepositoryUrl(rawUrl = '') {
  const input = String(rawUrl || '').trim();
  if (!input) return '';

  const withoutQueryOrHash = input.split(/[?#]/)[0];

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutQueryOrHash)) {
    return withoutQueryOrHash.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]+@/, '$1');
  }

  if (/^[^/:@]+:[^/@]+@[^/]+:/.test(withoutQueryOrHash)) {
    return withoutQueryOrHash.replace(/^([^/:@]+):[^/@]+@/, '$1@');
  }

  return withoutQueryOrHash;
}

/**
 * Formats normalized turn/session telemetry into OpenTelemetry data points.
 * @param {object} telemetryState
 * @param {object} [vcsMetadata={}]
 * @returns {Array<object>}
 */
export function buildOtelMetricRecords(telemetryState = {}, vcsMetadata = {}) {
  const timestamp = telemetryState.lastUpdatedAt || Date.now();
  const baseAttributes = {
    'session.id': String(telemetryState.sessionId || 'default'),
    model: String(telemetryState.modelId || 'claude-sonnet-5-5'),
    'agent.id': telemetryState.lastAgentId ? String(telemetryState.lastAgentId) : 'main',
    'vcs.repository.url.full': sanitizeRepositoryUrl(
      vcsMetadata.repositoryUrl || telemetryState.vcs?.repositoryUrl || ''
    ),
    'vcs.ref.head.name': String(vcsMetadata.branch || telemetryState.vcs?.branch || ''),
    'vcs.ref.head.revision': String(vcsMetadata.revision || telemetryState.vcs?.revision || '')
  };

  const latestTurn = telemetryState.lastTurn || {};
  const tokens = latestTurn.tokens || {
    uncachedInput: telemetryState.uncachedInputTokens || 0,
    output: telemetryState.outputTokens || 0,
    cacheRead: telemetryState.cacheReadTokens || 0,
    totalCacheWrite: telemetryState.cacheWriteTokens || 0
  };
  const costs = latestTurn.costsUSD || {
    totalActualSpendUSD: telemetryState.totalActualSpendUSD || 0,
    netCacheSavingsUSD: telemetryState.netCacheSavingsUSD || 0
  };

  const tokenTypes = [
    { type: 'input', value: Number(tokens.uncachedInput || 0) },
    { type: 'output', value: Number((tokens.output || 0) + (tokens.thinking || 0)) },
    { type: 'cacheRead', value: Number(tokens.cacheRead || 0) },
    { type: 'cacheCreation', value: Number(tokens.totalCacheWrite || 0) }
  ];

  const records = [];
  for (const entry of tokenTypes) {
    records.push({
      metricName: 'claude_code.token.usage',
      timestamp,
      value: entry.value,
      unit: 'tokens',
      attributes: {
        ...baseAttributes,
        type: entry.type
      }
    });
  }

  records.push({
    metricName: 'claude_code.cost.usage',
    timestamp,
    value: Number(costs.totalActualSpendUSD || 0),
    unit: 'USD',
    attributes: {
      ...baseAttributes,
      cache_savings_usd: Number(costs.netCacheSavingsUSD || 0),
      negative_cache_roi: Boolean(telemetryState.cacheRoi?.negativeCacheRoi)
    }
  });

  if (
    telemetryState.savedQuotaUSD !== undefined ||
    telemetryState.workspace30dSavedUSD !== undefined ||
    telemetryState.interventionCount !== undefined ||
    telemetryState.breakerTrips !== undefined ||
    telemetryState.includeHorizonMetrics
  ) {
    records.push({
      metricName: 'attention_horizon.saved_quota.usd',
      timestamp,
      value: Number(
        telemetryState.savedQuotaUSD ??
          telemetryState.workspace30dSavedUSD ??
          costs.netCacheSavingsUSD ??
          0
      ),
      unit: 'USD',
      attributes: {
        ...baseAttributes
      }
    });

    records.push({
      metricName: 'attention_horizon.intervention.count',
      timestamp,
      value: Number(telemetryState.interventionCount ?? telemetryState.breakerTrips ?? 0),
      unit: 'count',
      attributes: {
        ...baseAttributes
      }
    });
  }

  return records;
}

/**
 * Exports OpenTelemetry metric records to a local sink or `.claude/cache/otel_metrics.jsonl`
 * when `CLAUDE_CODE_ENABLE_TELEMETRY=1`. Never opens outbound network sockets.
 *
 * @param {object} telemetryState
 * @param {object} [options={}]
 * @returns {{ exported: boolean, recordCount: number, records: Array<object> }}
 */
export function exportOtelTelemetry(telemetryState = {}, options = {}) {
  if (!isOtelEnabled(options)) {
    return { exported: false, recordCount: 0, records: [] };
  }

  const records = buildOtelMetricRecords(telemetryState, options.vcs || {});

  if (typeof options.sink === 'function') {
    options.sink(records);
    return { exported: true, recordCount: records.length, records };
  }

  const cwd = options.cwd || getCwd(options);
  if (cwd) {
    const targetPath = options.otelFilePath || path.join(cwd, '.claude', 'cache', 'otel_metrics.jsonl');
    let anyWritten = false;
    for (const record of records) {
      if (appendJsonlSafe(targetPath, record, options)) {
        anyWritten = true;
      }
    }
    return { exported: anyWritten, recordCount: records.length, records };
  }

  return { exported: false, recordCount: records.length, records };
}

export default {
  isOtelEnabled,
  sanitizeRepositoryUrl,
  buildOtelMetricRecords,
  exportOtelTelemetry
};
