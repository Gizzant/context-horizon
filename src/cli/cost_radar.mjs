import path from 'node:path';
import fs from 'node:fs';
import { runCLI } from './horizon_hud.mjs';
import { atomicWriteFileSync } from '../core/atomic_io.mjs';
import { getFlightcheckDir } from '../core/sidecar_store.mjs';
import { renderCostRadarHtml } from '../core/timeline_svg.mjs';
import { formatRetentionLabel, formatDriftLabel } from '../core/sprint_metrics.mjs';
import { formatSwarmLabel } from '../core/swarm_topology.mjs';

/**
 * Sprint 2.2 — `ctxtop cost-radar` / `/cost-radar` skill backend.
 * Builds the HTML/SVG timeline artifact from the live classifier state (read-only).
 */

export function buildCostRadarFromState(state = {}, { edition = 'Antigravity', generatedAt = null } = {}) {
  const retention = state?.quota?.cache?.prefixRetention || null;
  const drift = state?.quota?.thinkingDrift || null;
  const topology = state?.swarmTopology || null;
  const modelLabel = state?.model?.label || state?.model?.id || (typeof state?.model === 'string' ? state.model : '');
  const html = renderCostRadarHtml({
    retention,
    drift,
    topology,
    meta: {
      sessionTitle: state?.sessionTitle || '',
      model: modelLabel,
      edition,
      generatedAt: generatedAt || new Date().toISOString()
    }
  });
  const summary = {
    retention: retention ? (retention.label || formatRetentionLabel(retention)) : 'Retain —',
    drift: drift ? (drift.label || formatDriftLabel(drift)) : 'Think —',
    swarm: formatSwarmLabel(topology) || 'Solo',
    loopTriggered: Boolean(drift?.loop?.triggered)
  };
  return { html, summary };
}

export function parseCostRadarArgs(args = []) {
  const outIdx = args.indexOf('--out');
  const convIdx = args.indexOf('--conversation');
  return {
    out: outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null,
    conversationId: convIdx !== -1 && args[convIdx + 1] ? args[convIdx + 1] : null,
    json: args.includes('--json'),
    demo: args.includes('--demo')
  };
}

export async function runCostRadar({ out = null, conversationId = null, json = false, demo = false } = {}) {
  const res = await runCLI({
    silent: true,
    useNativeCeiling: true,
    demoScenario: demo ? 5 : null,
    stdinData: conversationId ? { conversation_id: conversationId } : null
  });
  const state = res?.state || {};
  const { html, summary } = buildCostRadarFromState(state);
  const target = path.resolve(out || path.join(getFlightcheckDir(), 'cost_radar.html'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteFileSync(target, html, { encoding: 'utf8' });
  const result = { ok: true, path: target, fileUri: `file:///${target.replace(/\\/g, '/').replace(/^\/+/, '')}`, ...summary };
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`Cost Radar written: ${result.fileUri}\n  ${summary.retention}\n  ${summary.drift}\n  ${summary.swarm}\n`);
  }
  return result;
}
