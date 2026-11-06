/**
 * Modular Webview Chart & Small-Multiple Registry for Context Horizon (`ctxtop`).
 *
 * Allows contributors to register custom telemetry panels and small-multiple
 * visualizations against the standardized `HorizonStatePayload` returned by `/api/state`
 * without modifying core classification logic.
 */

export const BUILTIN_PANELS = [
  {
    id: 'chrono-40-cell-bar',
    title: '40-Cell Chronological Context Horizon',
    domSelector: '#horizonGrid',
    dataKeys: ['cells', 'window', 'amputation'],
    description: 'Plots Turn 0 (Left) to Current Turn (Right) across 40 discrete cells with red amputation brackets.'
  },
  {
    id: 'tufte-u-curve',
    title: 'U-Shaped Attention Recall Curve',
    domSelector: '#uCurveContainer',
    dataKeys: ['cells', 'breakdown'],
    description: 'Maps positional retrieval probability across Primacy (Cells 1-8), Lost-in-the-Middle trough, and Recency tail.'
  },
  {
    id: 'dual-pool-quota-strip',
    title: 'Dual-Pool Quota & Cache Hit Strip',
    domSelector: '#quotaStrip',
    dataKeys: ['quota', 'effortGovernor'],
    description: 'Tracks 5-hour Sprint vs 7-day Weekly pool burn and KV cache-read hit rate.'
  },
  {
    id: 'surgical-pruner-offenders',
    title: 'Sludge Tax Ledger & Surgical Pruner',
    domSelector: '#offendersList',
    dataKeys: ['offenders', 'brainSignals', 'metrics'],
    description: 'Lists top duplicate file reads and dead error traces with one-click AST signature folding.'
  },
  {
    id: 'host-process-watchdog',
    title: 'Host Process & Zombie Subagent Watchdog',
    domSelector: '#hostWatchdogBar',
    dataKeys: ['hostHealth', 'subagents'],
    description: 'Detects orphaned language servers and detached MCP stdio pipes.'
  }
];

const customPanels = new Map();

export function registerHorizonPanel(panelDef) {
  if (!panelDef || typeof panelDef.id !== 'string' || typeof panelDef.render !== 'function') {
    throw new Error('Panel definition requires { id: string, title: string, render(state): string }');
  }
  customPanels.set(panelDef.id, {
    id: panelDef.id,
    title: panelDef.title || panelDef.id,
    dataKeys: Array.isArray(panelDef.dataKeys) ? panelDef.dataKeys : [],
    render: panelDef.render
  });
  return customPanels.get(panelDef.id);
}

export function getRegisteredPanels() {
  return [...BUILTIN_PANELS, ...customPanels.values()];
}
