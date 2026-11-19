'use strict';

function formatTokensCompact(tokens) {
  const n = Math.max(0, Number(tokens || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function formatTtlCompact(ttlSec, isCold = false) {
  const sec = Math.max(0, Math.round(Number(ttlSec || 0)));
  if (isCold || sec <= 0) return 'Cold';
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}m${String(rem).padStart(2, '0')}s`;
}

function formatStatusBar(state = null, daemonInfo = { connected: false }) {
  if (!daemonInfo || !daemonInfo.connected) {
    const detail = daemonInfo?.error ? `\n\nLast status: ${daemonInfo.error}` : '';
    return {
      text: '$(pulse) Highbeam: Offline',
      severity: 'disconnected',
      tooltipMarkdown: [
        '**Highbeam (`highbeam-cli`)** — Local loopback daemon is offline.',
        '',
        'Click to open sidebar and start or reconnect on `127.0.0.1`.',
        detail
      ]
        .filter(Boolean)
        .join('\n')
    };
  }

  const win = state?.window || {};
  const usedTok = Math.max(0, Number(win.totalActiveTokens || 0));
  const maxTok = Math.max(0, Number(win.maxTokens || 0));
  const rawPct = Number.isFinite(Number(win.usedPercentage))
    ? Number(win.usedPercentage)
    : (maxTok > 0 ? (usedTok / maxTok) * 100 : 0);
  const usedPct = Math.max(0, Math.min(100, Math.round(rawPct)));

  const qCache = state?.quota?.cache || {};
  const ttlSec = Math.max(0, Number(qCache.ttlRemainingSec || 0));
  const isCold = Boolean(qCache.isCacheCold || ttlSec <= 0);
  const ttlLabel = formatTtlCompact(ttlSec, isCold);
  const hitRatePct = Number.isFinite(Number(qCache.hitRatePct))
    ? Math.max(0, Math.min(100, Math.round(Number(qCache.hitRatePct))))
    : null;

  const flightMode = String(state?.flightMode || state?.routerMode || 'COACH').toUpperCase();
  const autoTag = flightMode === 'AUTO_PILOT' ? ' · AUTO' : '';

  const isCritical = Boolean(state?.amputationCrisis) || usedPct >= 90;
  const isWarning = !isCritical && (usedPct >= 75 || (!isCold && ttlSec > 0 && ttlSec <= 45));

  let severity = 'nominal';
  let text = `$(eye) HB ${usedPct}% · TTL ${ttlLabel}${autoTag}`;
  if (isCritical) {
    severity = 'critical';
    text = `$(error) HB ${usedPct}% · Risk${autoTag}`;
  } else if (isWarning) {
    severity = 'warning';
    text = `$(warning) HB ${usedPct}% · TTL ${ttlLabel}${autoTag}`;
  }

  const modelId = state?.model?.rawLabel || state?.model?.id || state?.activeModel || 'unknown';
  const savedUsd = Number(state?.savings?.workspace30dSavedUSD ?? state?.savings?.totalSavedUSD ?? 0);
  const portLabel = daemonInfo.port ? `http://127.0.0.1:${daemonInfo.port}/` : 'loopback';

  const lines = [
    '**Highbeam (`highbeam-cli`) — Context & KV-Cache HUD**',
    '',
    `- **Model**: \`${modelId}\``,
    maxTok > 0
      ? `- **Context**: \`${formatTokensCompact(usedTok)} / ${formatTokensCompact(maxTok)}\` (${usedPct}%)`
      : `- **Context**: \`${usedPct}%\``,
    `- **KV Cache TTL**: \`${ttlLabel}\`${hitRatePct !== null ? ` (${hitRatePct}% hit)` : ''}`,
    `- **Flight Mode**: \`${flightMode}\``
  ];

  if (savedUsd > 0) {
    lines.push(`- **Est. 30d Saved**: \`$${savedUsd.toFixed(2)} USD\``);
  }
  lines.push(`- **Loopback**: \`${portLabel}\``);
  lines.push('', '_Click to open Highbeam sidebar._');

  return {
    text,
    severity,
    tooltipMarkdown: lines.join('\n')
  };
}

module.exports = {
  formatTokensCompact,
  formatTtlCompact,
  formatStatusBar
};
