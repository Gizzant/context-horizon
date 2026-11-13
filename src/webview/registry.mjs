/**
 * Modular Webview Chart & Small-Multiple Registry for Highbeam (`ctxtop`).
 *
 * Allows contributors to register custom telemetry panels and small-multiple
 * visualizations against the standardized `HorizonStatePayload` returned by `/api/state`
 * without modifying core classification logic.
 */

export const BUILTIN_PANELS = [
  {
    id: 'chrono-40-cell-bar',
    title: '40-Cell Chronological Attention Horizon',
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
  },
  {
    id: 'single-screen-simple-view',
    title: 'Tufte Single-Screen Simple View',
    domSelector: '#highbeamSimpleScreen',
    route: '/simple',
    dataKeys: ['window', 'breakdown', 'quota', 'brainSignals', 'savings', 'amputation'],
    description: 'Calm, self-contained single-screen HUD (System State, Direct Guidance, Automated Activity Ledger, and Primary Clean/Saved KPI) without modals or secondary drill-downs.'
  },
  {
    id: 'tufte-advanced-workbench',
    title: 'Tufte Advanced Telemetry Workbench',
    domSelector: '#highbeamAdvancedWorkbench',
    route: '/advanced',
    dataKeys: ['cells', 'window', 'breakdown', 'quota', 'brainSignals', 'baseline', 'actionQueue', 'savings', 'coachState', 'hostHealth'],
    description: 'High-density 4-zone forensic workbench (40-cell map, parabolic U-curve recall, ranked payoff queue, KV-cache gravity router, Turn-0 schema tax, DET-01..32 log, and surgical AST pruning).'
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
