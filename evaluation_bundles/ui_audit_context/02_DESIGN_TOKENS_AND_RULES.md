# Design Tokens & Layout Rules

## Embedded CSS & Variables
```css
/* Source: docs/index.html */
#chDemoBar {
    position: sticky;
    top: 0;
    z-index: 99999;
    background: linear-gradient(90deg, #090d16 0%, #111827 100%);
    border-bottom: 1px solid #334155;
    padding: 8px 14px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    color: #f8fafc;
    box-shadow: 0 4px 12px rgba(0,0,0,0.45);
  }
  #chDemoBar .ch-brand {
    font-weight: 700;
    font-size: 13px;
    color: #38bdf8;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #chDemoBar select {
    background: #1e293b;
    color: #f8fafc;
    border: 1px solid #475569;
    border-radius: 5px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  #chDemoBar .ch-complaint {
    font-size: 11.5px;
    color: #fbbf24;
    flex: 1 1 100%;
    padding-top: 2px;
  }
  #chDemoBar .ch-cta {
    background: #22c55e;
    color: #052e16;
    text-decoration: none;
    font-size: 11.5px;
    font-weight: 700;
    padding: 5px 10px;
    border-radius: 5px;
  }
:root {
    /* Host IDE Bridge Overrides (Prevents #333 fallback bleed) */
    --background: #090d16;
    --foreground: #f8fafc;
    --muted: #111827;
    --muted-foreground: #94a3b8;
    --border: rgba(255, 255, 255, 0.10);
    --ring: #38bdf8;

    /* Surface Palette (Developer Slate / Zinc) */
    --hz-bg: #090d16;
    --hz-card: #0f1623;
    --hz-card-alt: #161f30;
    --hz-fg: #f8fafc;
    --hz-fg-secondary: #cbd5e1;
    --hz-muted: #94a3b8;         /* WCAG AA 7.1:1 against --hz-bg */
    --hz-dim: var(--hz-muted);   /* Alias of --hz-muted (~7:1 on --hz-bg) */
    --hz-border: rgba(255, 255, 255, 0.10);
    --hz-border-subtle: rgba(255, 255, 255, 0.06);

    /* Semantic Telemetry Indicators */
    --hz-useful: #10b981;        /* Green: Active code + rules */
    --hz-cached-history: #0d9488;/* Muted Slate/Teal: Cached History â€” 95% Discounted */
    --hz-clutter: #f59e0b;       /* Amber: Reclaimable noise / Cold Bloat */
    --hz-danger: #ef4444;        /* Red: Over limit / errors */
    --hz-free: #1e293b;          /* Dark slate: Free headroom */
    --hz-anchor: #38bdf8;        /* Cyan: Rules & interactive links */
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: var(--hz-bg); color: var(--hz-fg); color-scheme: dark; }
  body {
    background: var(--hz-bg) !important;
    color: var(--hz-fg) !important;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 12.5px;
    line-height: 1.45;
    padding: 12px 14px !important;
    user-select: none;
    -webkit-font-smoothing: antialiased;
  }

  .mono,
  .badge,
  .session-select,
  .b-val,
  .diag-impact,
  .group-pill,
  .chronic-badge,
  .retained-badge,
  .handoff-dot,
  .sig-val,
  .base-tok {
    font-family: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  /* Strict WCAG Keyboard Focus States (shadcn/ui ring pattern) */
  button:focus-visible,
  select:focus-visible,
  input:focus-visible,
  summary:focus-visible,
  a:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid var(--ring) !important;
    outline-offset: 2px !important;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }

  .wrap {
    max-width: 560px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* 1. Top Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 2px;
  }
  .title-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--hz-useful);
    border: 1px solid rgba(255, 255, 255, 0.25);
  }
  .dot.warn { background: var(--hz-clutter); }
  .dot.danger { background: var(--hz-danger); }

  h1 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--hz-fg) !important;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* shadcn/ui Tabs Primitive for Simple / Advanced View Mode */
  .shadcn-tabs-list {
    display: inline-flex;
    align-items: center;
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }
  .shadcn-tab-trigger {
    background: transparent;
    border: none;
    color: var(--hz-muted) !important;
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .shadcn-tab-trigger:hover {
    color: var(--hz-fg) !important;
  }
  .shadcn-tab-trigger[aria-selected="true"] {
    background: var(--hz-card-alt);
    color: var(--hz-fg) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }

  /* In Simple Mode, hide deep diagnostics & 40-cell timeline unless expanded */
  body[data-view-mode="simple"] .advanced-only {
    display: none !important;
  }

  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 999px;
    background: rgba(16, 185, 129, 0.12);
    color: var(--hz-useful);
    border: 1px solid rgba(16, 185, 129, 0.35);
    font-variant-numeric: tabular-nums;
  }
  .badge.warn {
    background: rgba(245, 158, 11, 0.12);
    color: var(--hz-clutter);
    border-color: rgba(245, 158, 11, 0.4);
  }
  .badge.danger {
    background: rgba(239, 68, 68, 0.14);
    color: var(--hz-danger);
    border-color: rgba(239, 68, 68, 0.45);
  }
  .icon-btn {
    background: var(--hz-card-alt);
    border: 1px solid var(--hz-border);
    color: var(--hz-fg) !important;
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
    color: var(--hz-fg) !important;
  }

  /* Conversation Switcher Bar */
  .session-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 6px;
    padding: 5px 10px;
  }
  .session-label {
    font-size: 11px;
    color: var(--hz-muted) !important;
    font-weight: 600;
    white-space: nowrap;
  }
  .session-select {
    flex: 1;
    min-width: 0;
    background: var(--hz-card-alt);
    color: var(--hz-fg) !important;
    border: 1px solid var(--hz-border);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11.5px;
    font-weight: 500;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .session-select option {
    background: var(--hz-card);
    color: var(--hz-fg);
  }
  .prefix-lock-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(56, 189, 248, 0.12);
    color: var(--hz-anchor) !important;
    border: 1px solid rgba(56, 189, 248, 0.35);
    white-space: nowrap;
    cursor: help;
    font-variant-numeric: tabular-nums;
  }
  .prefix-lock-badge[hidden] {
    display: none !important;
  }

  /* 2. Storage Bar Card (Tufte High Data-Ink Ratio: Unified Horizontal Band) */
  .storage-card {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .storage-top {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 4px 10px;
    margin-bottom: 6px;
  }
  .used-big {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--hz-fg) !important;
  }
  .used-of {
    font-size: 12px;
    color: var(--hz-muted) !important;
    font-weight: 400;
    margin-left: 4px;
  }
  .free-label {
    font-size: 11.5px;
    color: var(--hz-muted) !important;
  }
  .delta-line {
    font-size: 11px;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--hz-muted) !important;
    align-items: baseline;
    min-width: 0;
  }
  /* Turn-delta row: the file label ellipsizes; the token suffix never clips */
  .delta-line .delta-head { flex-shrink: 0; white-space: pre; }
  .delta-line .delta-src {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 210px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delta-line .delta-tok { flex-shrink: 0; white-space: pre; }
  .delta-line.up { color: #cbd5e1 !important; }
  .delta-line.up.big { color: #f59e0b !important; }
  .delta-line.down { color: #10b981 !important; }
  .free-wrap { display: inline-flex; align-items: center; gap: 6px; }
  .gear-btn {
    background: transparent !important;
    border: 1px solid rgba(148, 163, 184, 0.3);
    border-radius: 4px;
    color: #cbd5e1 !important;
    font-size: 12px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;
  }
  .gear-btn:hover { border-color: #f59e0b; color: #f59e0b !important; }
  .settings-pop {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 0 10px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid var(--hz-border);
    background: var(--hz-bg) !important;
    font-size: 11.5px;
    color: var(--hz-fg) !important;
  }
  .settings-pop[hidden] { display: none; }
  .settings-pop label { display: flex; justify-content: space-between; align-items: center; gap: 10px; color: #e2e8f0 !important; }
  .settings-pop input {
    width: 110px;
    padding: 3px 6px;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: #1e293b !important;
    color: #f8fafc !important;
    font-family: ui-monospace, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .settings-row { display: flex; align-items: center; gap: 8px; }
  .settings-save, .settings-cancel {
    padding: 4px 12px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid #f59e0b;
  }
  .settings-save { background: #f59e0b !important; color: #090d16 !important; }
  .settings-cancel { background: transparent !important; color: #cbd5e1 !important; border-color: rgba(148, 163, 184, 0.4); }
  .settings-msg { font-size: 10.5px; color: #94a3b8 !important; }
  .settings-msg.err { color: #ef4444 !important; }
  .base-rows { list-style: none; margin: 6px 0 0; padding: 0; font-size: 10.5px; }
  .base-rows[hidden] { display: none; }
  .base-rows li { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 3px 0; border-bottom: 1px solid var(--hz-border-subtle); color: #cbd5e1 !important; }
  .base-rows li:last-child { border-bottom: none; }
  .base-rows .base-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .base-rows .base-tok { flex: none; color: #f8fafc !important; text-align: right; font-variant-numeric: tabular-nums; }
  .base-rows em { font-style: normal; color: #94a3b8 !important; font-size: 9.5px; }
  .chronic-badge { font-size: 9.5px; padding: 1px 6px; border-radius: 9px; border: 1px solid rgba(148, 163, 184, 0.35); color: #cbd5e1 !important; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .chronic-badge.hot { border-color: rgba(245, 158, 11, 0.6); color: #f59e0b !important; }
  .chip-btn.chronic { border-color: #f59e0b !important; color: #f59e0b !important; font-weight: 700; }
  .tip-dismiss { background: transparent !important; border: none; color: #94a3b8 !important; cursor: pointer; font-size: 11px; padding: 0 2px; }
  .tip-dismiss:hover { color: #f8fafc !important; }
  #sipTipCard a { color: #38bdf8 !important; }

  .bar-outer {
    position: relative;
    height: 18px;
    width: 100%;
    background: var(--hz-free);
    border-radius: 4px;
    margin-top: 18px;           /* reserved lane for the limit tag so it never overlaps the delta line */
    margin-bottom: 18px;        /* reserved lane below the track for the 50k Sync / ceiling tags */
  }
  .bar-track {
    display: flex;
    height: 100%;
    width: 100%;
    border-radius: 4px;
    overflow: hidden;
    gap: 1px;
  }
  .seg-useful { background: var(--hz-useful); height: 100%; transition: width 0.25s ease; }
  .seg-clutter { background: var(--hz-clutter); height: 100%; transition: width 0.25s ease, background-color 0.25s ease; }
  .seg-clutter.cached-warm { background: var(--hz-cached-history) !important; }
  .seg-clutter.cold-bloat { background: var(--hz-clutter) !important; }
  .seg-error { display: none; width: 0 !important; height: 100%; }

  .ceiling-clamp-pill {
    display: inline-block;
    font-size: 9.5px;
    font-weight: 600;
    padding: 1px 6px;
    margin-left: 4px;
    border-radius: 4px;
    background: rgba(56, 189, 248, 0.10);
    border: 1px solid rgba(56, 189, 248, 0.35);
    color: var(--hz-anchor) !important;
    white-space: nowrap;
    vertical-align: middle;
  }
  .ceiling-clamp-pill[hidden] { display: none !important; }

  .cascade-line {
    position: absolute;
    left: 19.5%;
    top: -3px;
    bottom: -3px;
    border-left: 1px dashed rgba(56, 189, 248, 0.75);
    pointer-events: auto;
    cursor: help;
    z-index: 4;
  }
  .cascade-tag {
    /* Anchored BELOW the bar track so it can never collide with the Safe Limit tag above it */
    position: absolute;
    left: 3px;
    top: auto;
    bottom: -14px;
    font-size: 9.5px;
    font-weight: 600;
    color: #7dd3fc;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .hard-ceiling-line {
    position: absolute;
    right: 0;
    top: -3px;
    bottom: -3px;
    border-right: 2px solid rgba(239, 68, 68, 0.75);
    pointer-events: auto;
    cursor: help;
    z-index: 4;
  }
  .hard-ceiling-tag {
    position: absolute;
    right: 2px;
    bottom: -13px;
    font-size: 9px;
    font-weight: 600;
    color: #94a3b8;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .limit-line {
    position: absolute;
    left: 70%;
    top: -3px;
    bottom: -3px;
    border-left: 1px dashed rgba(251, 113, 133, 0.8); /* border-rose-400/80 */
    pointer-events: auto;
    cursor: help;
    z-index: 5;
  }
  .limit-line::before {
    content: '';
    position: absolute;
    left: -2.5px;
    top: -1px;
    width: 4px;
    height: 1px;
    background: rgba(251, 113, 133, 0.8);
  }
  .limit-tag {
    /* Right-aligned ABOVE the bar track, ending at the marker */
    position: absolute;
    left: -4px;
    right: auto;
    transform: translateX(-100%);
    top: -14px;
    font-size: 10px;
    font-weight: 600;
    color: #fda4af; /* text-rose-300 */
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Flattened Horizontal Metric Band (No Nested Boxes-Within-Boxes) */
  .breakdown-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    border-top: 1px solid var(--hz-border);
    padding-top: 10px;
  }
  .b-item {
    background: transparent;
    border: none;
    border-right: 1px solid var(--hz-border-subtle);
    border-radius: 0;
    padding: 0 10px;
    min-width: 0;
  }
  .b-item:first-child { padding-left: 0; }
  .b-item:last-child { border-right: none; padding-right: 0; }
  .b-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--hz-muted) !important;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .b-swatch {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .b-val {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--hz-fg) !important;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .b-sub {
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 3. Action Center Card */
  .action-card {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--hz-fg) !important;
  }
  .action-card.warn {
    background: #191610 !important;
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: var(--hz-fg) !important;
  }
  .action-card.danger {
    background: #1e1216 !important;
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: var(--hz-fg) !important;
  }
  .action-msg {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--hz-fg) !important;
  }
  .action-msg strong {
    color: #ffffff !important;
  }
  .action-icon {
    font-size: 14px;
    line-height: 1.2;
    flex-shrink: 0;
  }

  /* Compact Guided Action Box - Flattened */
  .guided-step-box {
    background: transparent !important;
    border: none;
    border-radius: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .action-card .action-icon, .action-card .action-msg { color: var(--hz-fg) !important; }
  .action-card.danger .guided-step-box {
    border: none;
  }

  .compact-instruction {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.5;
    border: 1px solid var(--hz-border-subtle);
    border-left: 3px solid #f59e0b;
    background: var(--hz-bg) !important;
    color: var(--hz-fg) !important;
    cursor: default;
    user-select: text;
  }
  .compact-instruction kbd {
    font-family: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: #1e293b !important;
    color: #e2e8f0 !important;
  }
  .compact-instruction kbd.cmd-kbd {
    color: #f59e0b !important;
    border-color: rgba(245, 158, 11, 0.55);
    font-weight: 700;
  }
  .compact-reclaim {
    display: block;
    font-size: 10.5px;
    font-weight: 500;
    color: #f59e0b !important;
    font-variant-numeric: tabular-nums;
  }
  /* While the green DEFER_WARM banner is visible, mute the urgent amber accent so hierarchy doesn't contradict it */
  #guidedStepBox[data-cache-advisory="lean"] .compact-instruction {
      border-color: var(--hz-border, #475569) !important;
      background: transparent !important;
    }
    #guidedStepBox[data-cache-advisory="warm-defer"] .compact-instruction {
    border-left-color: var(--hz-border);
  }

  .param-compact-details > summary {
    cursor: pointer;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--hz-muted) !important;
    user-select: none;
    padding: 2px 0;
  }
  .param-compact-details[open] > summary { margin-bottom: 4px; }
  /* Advanced mode: template is force-opened by applyViewMode(); hide the disclosure chrome */
  body[data-view-mode="advanced"] .param-compact-details > summary { display: none; }

  .param-compact-box {
    padding: 6px 10px;
    border-radius: 5px;
    border: 1px dashed var(--hz-border);
    background: rgba(15, 22, 35, 0.85);
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--hz-fg-secondary) !important;
    user-select: text;
    word-break: break-word;
  }
  .param-compact-label {
    display: block;
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--hz-anchor) !important;
    margin-bottom: 2px;
  }
  .cache-compaction-advisory {
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.4;
  }
  .cache-compaction-advisory.warm-defer {
    background: rgba(13, 148, 136, 0.12);
    border: 1px solid rgba(13, 148, 136, 0.4);
    color: #5eead4 !important;
  }
  .cache-compaction-advisory.cold-compact-now {
    background: rgba(245, 158, 11, 0.14);
    border: 1px solid rgba(245, 158, 11, 0.45);
    color: #fde68a !important;
  }
  .artifact-drift-banner {
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.4;
    background: rgba(239, 68, 68, 0.14);
    border: 1px solid rgba(239, 68, 68, 0.45);
    color: #fca5a5 !important;
  }
  .artifact-drift-banner[hidden] { display: none !important; }
  .baton-pass-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid rgba(56, 189, 248, 0.35);
    background: rgba(56, 189, 248, 0.08);
  }
  .baton-pass-info {
    font-size: 10.5px;
    color: var(--hz-fg-secondary) !important;
    flex: 1 1 180px;
  }
  .baton-pass-info strong {
    color: var(--hz-anchor) !important;
  }
  .btn-baton-pass {
    padding: 5px 11px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    border: 1px solid rgba(56, 189, 248, 0.55);
    background: var(--hz-card-alt);
    color: var(--hz-anchor) !important;
    white-space: nowrap;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .btn-baton-pass:hover {
    background: rgba(56, 189, 248, 0.16);
    border-color: var(--hz-anchor);
  }

  /* Collapsible Secondary Actions */
  .secondary-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .btn-secondary {
    flex: 1;
    min-width: 135px;
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--hz-border);
    background: var(--hz-card-alt);
    color: var(--hz-fg) !important;
    text-align: center;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.22);
  }

  .feedback-toast {
    display: none;
    padding: 7px 10px;
    border-radius: 5px;
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.35);
    color: var(--hz-fg) !important;
    font-size: 11px;
    line-height: 1.4;
  }

  /* 4. Diagnostic & Brain Playbook Cards (shadcn/ui Accordion / Collapsible) */
  .playbook-card {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .playbook-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--hz-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .playbook-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--hz-fg) !important;
  }
  .playbook-sub {
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    font-variant-numeric: tabular-nums;
  }
  .diag-item {
    padding: 0;
    border-bottom: 1px solid var(--hz-border-subtle);
    display: flex;
    flex-direction: column;
    color: var(--hz-fg) !important;
  }
  .diag-item:last-child { border-bottom: none; }
  .diag-item.diag-rollup summary.diag-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    cursor: pointer;
    user-select: none;
    list-style: none;
    gap: 8px;
    background: transparent;
    color: var(--hz-fg) !important;
    transition: background-color 0.15s ease;
  }
  .diag-item.diag-rollup summary.diag-top::-webkit-details-marker { display: none; }
  .diag-item.diag-rollup summary.diag-top:hover {
    background: rgba(255, 255, 255, 0.035);
  }
  .diag-item.diag-rollup .diag-body {
    padding: 6px 12px 10px 24px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--hz-border-subtle);
    background: rgba(0, 0, 0, 0.18);
  }
  .diag-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    color: var(--hz-fg) !important;
  }
  .diag-name {
    font-size: 11.5px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--hz-fg) !important;
  }
  .diag-caret {
    display: inline-block;
    font-size: 8.5px;
    color: var(--hz-muted) !important;
    transition: transform 0.15s ease;
    width: 10px;
  }
  .diag-item.diag-rollup[open] summary .diag-caret {
    transform: rotate(90deg);
  }
  .diag-impact {
    font-size: 11px;
    font-weight: 600;
    color: var(--hz-clutter);
    white-space: nowrap;
    text-align: right;
    min-width: 44px;
    font-variant-numeric: tabular-nums;
  }
  .diag-desc {
    font-size: 11px;
    color: var(--hz-muted) !important;
    line-height: 1.45;
  }
  .diag-desc code {
    background: rgba(255, 255, 255, 0.08);
    padding: 1px 4px;
    border-radius: 3px;
    color: var(--hz-anchor);
    font-family: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 10.5px;
  }
  .diag-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 3px;
  }
  .mini-btn {
    padding: 4px 9px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
    background: var(--hz-card-alt);
    border: 1px solid var(--hz-border);
    color: var(--hz-anchor) !important;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .mini-btn:hover { background: rgba(56, 189, 248, 0.12); border-color: rgba(56, 189, 248, 0.35); }
  .mini-btn.danger { color: var(--hz-danger) !important; }
  .mini-btn.danger:hover { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.35); }

  .diag-pill {
    font-size: 10px;
    color: var(--hz-muted) !important;
    background: rgba(255, 255, 255, 0.04);
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--hz-border-subtle);
  }

  details.file-drawer summary {
    font-size: 10.5px;
    color: var(--hz-anchor) !important;
    cursor: pointer;
    margin-top: 2px;
  }
  .file-sublist {
    margin-top: 4px;
    padding-left: 10px;
    border-left: 1px solid var(--hz-border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .file-subrow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    font-variant-numeric: tabular-nums;
  }

  /* Diagnostic groups */
  .diag-group.reclaim { border-left: 2px solid var(--hz-clutter); }
  .diag-group.spike {
    border-left: 2px dashed var(--hz-muted);
    background: rgba(148, 163, 184, 0.04);
  }
  .diag-group.tips { border-left: 2px solid var(--hz-anchor); }
  .group-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.025);
    border-bottom: 1px solid var(--hz-border-subtle);
  }
  .group-title { font-size: 11px; font-weight: 600; letter-spacing: 0.01em; color: #cbd5e1 !important; }
  .group-pill {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--hz-border);
    color: var(--hz-muted) !important;
    white-space: nowrap;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .diag-group.reclaim .group-pill {
    display: none !important;
  }
  .group-meta {
    font-size: 10px;
    font-weight: 500;
    color: var(--hz-muted) !important;
    white-space: nowrap;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .retained-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    color: var(--hz-muted) !important;
    background: rgba(148, 163, 184, 0.10);
    border: 1px solid var(--hz-border);
  }
  .prompt-btn.flash, .btn-secondary.flash {
    color: var(--hz-useful) !important;
    border-color: var(--hz-useful) !important;
  }

  /* 5. Optional Collapsible 40-Block Timeline */
  details.advanced-drawer {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    padding: 8px 12px;
  }
  details.advanced-drawer summary {
    font-size: 11px;
    color: var(--hz-muted) !important;
    cursor: pointer;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  details.advanced-drawer summary:hover {
    color: var(--hz-fg) !important;
  }
  .mini-timeline {
    display: flex;
    gap: 2px;
    height: 16px;
    margin-top: 10px;
    border-radius: 3px;
    overflow: visible;
  }
  .mini-cell { flex: 1; height: 100%; background: var(--hz-free); position: relative; border-radius: 1px; cursor: crosshair; }
  .mini-cell.effort-shift {
    border-top: 2px solid #f59e0b;
  }
  .effort-shift-badge {
    position: absolute;
    top: -9px;
    right: -2px;
    font-size: 8.5px;
    line-height: 1;
    font-weight: 700;
    color: #fbbf24;
    background: var(--hz-bg);
    border: 1px solid rgba(245, 158, 11, 0.65);
    border-radius: 3px;
    padding: 0 2px;
    pointer-events: none;
    z-index: 3;
  }
  .limit-reason-tip {
    display: inline-block;
    margin-left: 4px;
    font-size: 10px;
    color: var(--hz-anchor);
    cursor: help;
    vertical-align: baseline;
  }
  .high-effort-sludge-banner {
    background: #231518 !important;
    border: 1px solid rgba(245, 158, 11, 0.55);
    border-left: 3px solid #ef4444;
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    color: #fde68a !important;
  }
  .high-effort-sludge-banner[hidden] { display: none !important; }
  .mini-inspector { font-size: 10.5px; color: var(--hz-muted) !important; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .timeline-legend {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    margin-top: 5px;
    font-size: 9.5px;
    color: var(--hz-muted) !important;
    font-variant-numeric: tabular-nums;
  }

  .footer-meta {
    text-align: center;
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    padding-top: 2px;
    font-variant-numeric: tabular-nums;
  }
    /* ---- Progressive disclosure & guardrails ---- */
    .b-toggle { background: none; border: 0; padding: 0; margin: 0; text-align: left; font: inherit; font-size: 10.5px; cursor: pointer; color: var(--hz-muted) !important; }
    .b-toggle:hover { color: var(--hz-anchor) !important; }
    .b-toggle .caret { display: inline-block; font-size: 8.5px; transition: transform .15s; }
    .b-toggle[aria-expanded="true"] .caret { transform: rotate(90deg); }
    .signal-drawer { margin-top: 10px; border-top: 1px solid var(--hz-border); padding-top: 10px; background: transparent; }
    .signal-drawer[hidden] { display: none; }
    .sig-row + .sig-row { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--hz-border-subtle); }
    .sig-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 11.5px; font-weight: 600; color: var(--hz-fg) !important; }
    .sig-val { color: var(--hz-useful); text-align: right; font-variant-numeric: tabular-nums; }
    .sig-desc { font-size: 10.5px; color: var(--hz-muted) !important; margin-top: 2px; }
    .sig-desc code { font-family: ui-monospace, Consolas, monospace; color: var(--hz-anchor); }

    /* Single footer row under primary compact button */
    .action-footers-row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 6px 14px;
      margin-top: 4px;
      padding-top: 8px;
      border-top: 1px solid var(--hz-border-subtle);
    }
    .action-footers-row details {
      flex: 1 1 auto;
      font-size: 11px;
    }
    .action-footers-row details[open] {
      flex: 1 1 100%;
    }
    .action-footers-row details summary {
      cursor: pointer;
      color: var(--hz-anchor) !important;
      font-size: 11px;
      font-weight: 600;
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      user-select: none;
    }
    .action-footers-row details summary::-webkit-details-marker { display: none; }
    .action-footers-row details summary::before {
      content: '\25B6';
      display: inline-block;
      font-size: 8px;
      transition: transform 0.15s ease;
    }
    .action-footers-row details[open] summary::before {
      transform: rotate(90deg);
    }
    .action-footers-row details summary:hover {
      color: var(--hz-fg) !important;
    }

    .survive-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin-top: 8px; }
  .survive-grid > * { min-width: 0; overflow-wrap: anywhere; }
    .survive-col { border: 1px solid var(--hz-border); border-radius: 6px; padding: 6px 8px; font-size: 11px; }
    .survive-col.keep { background: rgba(16, 185, 129, 0.06); border-color: rgba(16, 185, 129, 0.25); }
    .survive-col.drop { background: rgba(245, 158, 11, 0.06); border-color: rgba(245, 158, 11, 0.25); }
    .survive-title { font-weight: 700; margin-bottom: 3px; }
    .survive-col.keep .survive-title { color: var(--hz-useful); }
    .survive-col.drop .survive-title { color: var(--hz-clutter); }
    .survive-col ul { margin: 0; padding-left: 16px; color: var(--hz-muted) !important; }

    .handoff-dot { font-size: 10.5px; font-weight: 700; margin-left: 4px; }
    .handoff-dot.synced { color: var(--hz-useful); }
    .handoff-dot.stale { color: var(--hz-clutter); }
    .handoff-dot .task-sync-badge { color: inherit; }
    .handoff-status { margin-top: 8px; font-size: 11.5px; font-weight: 600; }
    .handoff-status[hidden], .handoff-confirm[hidden] { display: none; }
    .handoff-status.synced { color: var(--hz-useful); }
    .handoff-status.stale { color: var(--hz-clutter); }
    .btn-secondary.emphasis { border-color: var(--hz-clutter); }
    .handoff-confirm { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--hz-clutter); border-radius: 6px; background: rgba(245, 158, 11, 0.08); font-size: 11.5px; color: var(--hz-fg) !important; }
    .handoff-confirm-btns { display: flex; gap: 8px; margin-top: 6px; }
    .mini-btn.muted { color: var(--hz-muted) !important; }

    /* Diagnostic item alignment & full-line drawers */
    .diag-drawer-full { margin: 0; }
    .diag-drawer-full summary {
      font-size: 11px;
      color: var(--hz-anchor) !important;
      cursor: pointer;
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      user-select: none;
    }
    .diag-drawer-full summary::-webkit-details-marker { display: none; }
    .diag-drawer-full summary::before { content: '\25B6'; font-size: 8px; }
    .diag-drawer-full[open] summary::before { content: '\25BC'; }
    .diag-footer-bar, .diag-actions-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
      padding-bottom: 2px;
    }
    .diag-actions-label {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--hz-muted) !important;
    }
    .diag-actions-buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .diag-hint {
      font-size: 10px;
      color: var(--hz-muted) !important;
      user-select: none;
      white-space: nowrap;
      align-self: center;
    }
    .prompt-btn.flash, .btn-secondary.flash, .chip-btn.flash {
      color: var(--hz-useful) !important;
      border-color: var(--hz-useful) !important;
    }
    .file-subrow.rich { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; }
    .file-subrow.rich .fpath { flex: 1 1 140px; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: left; color: #cbd5e1 !important; }
    .file-subrow.rich .fmeta { text-align: right; font-variant-numeric: tabular-nums; color: var(--hz-muted) !important; }
    .chip-btn { font: inherit; font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--hz-border); background: transparent; color: var(--hz-muted) !important; cursor: pointer; }
    .chip-btn:hover { color: var(--hz-anchor) !important; border-color: var(--hz-anchor); }
    .chip-btn.noisy { color: var(--hz-clutter) !important; border-color: var(--hz-clutter); }
    .payload-box { margin-top: 6px; padding: 6px 8px; border: 1px solid var(--hz-border); border-radius: 6px; font-size: 11px; color: var(--hz-fg) !important; word-break: break-all; }
    .payload-box .payload-kind { color: var(--hz-muted) !important; display: block; margin-bottom: 2px; }
    .payload-box .chip-btn, .payload-box .mini-btn { margin-top: 6px; }
    .quota-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 6px;
      padding: 5px 10px;
      background: var(--hz-card);
      border: 1px solid var(--hz-border);
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      font-size: 10px;
      letter-spacing: -0.01em;
      color: var(--hz-muted) !important;
      font-variant-numeric: tabular-nums;
    }
    .quota-strip[hidden] { display: none !important; }
    .quota-pills {
      display: flex;
      flex: 1 1 100%;
      flex-wrap: wrap;
      gap: 4px 8px;
      align-items: center;
      justify-content: space-between;
    }
    .quota-telemetry {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .quota-Forecast { color: var(--hz-anchor) !important; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .quota-Forecast[hidden] { display: none !important; }
    .quota-warn {
      color: var(--hz-clutter) !important;
      font-weight: 700;
      white-space: nowrap;
      margin-left: auto;
    }
    @keyframes hzTtlPulse {
      0%, 100% { border-color: rgba(245, 158, 11, 0.35); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
      50% { border-color: rgba(245, 158, 11, 0.9); box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2); }
    }
    .quota-strip.ttl-pulse {
      animation: hzTtlPulse 1.6s ease-in-out infinite;
      border-color: rgba(245, 158, 11, 0.65);
    }
    .ttl-pulse-badge {
      color: var(--hz-clutter) !important;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.4);
      white-space: nowrap;
    }
    .prefix-bust-badge {
      color: var(--hz-clutter) !important;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.4);
      white-space: nowrap;
    }
    .quota-est {
      color: var(--hz-muted, #94a3b8) !important;
      font-weight: 500;
      font-style: italic;
      cursor: help;
    }
    .quota-meta-row {
      display: flex;
      flex: 1 1 100%;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 8px;
      font-size: 9.5px;
      color: var(--hz-fg-secondary) !important;
      border-top: 1px dashed var(--hz-border-subtle);
      padding-top: 3px;
      margin-top: 2px;
    }
    .quota-meta-row[hidden] { display: none !important; }
    .quota-credits {
      color: var(--hz-anchor) !important;
      font-weight: 600;
      white-space: nowrap;
    }
    .overage-guardrail-banner {
      flex: 1 1 100%;
      margin-top: 3px;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.35;
    }
    .overage-guardrail-banner[hidden] { display: none !important; }
    .overage-guardrail-banner.danger {
      background: rgba(239, 68, 68, 0.14);
      border: 1px solid rgba(239, 68, 68, 0.45);
      color: #fca5a5 !important;
    }
    .overage-guardrail-banner.warn {
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fde68a !important;
    }
    .bucket-bars { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .bucket-row { display: grid; grid-template-columns: 72px 1fr 64px; align-items: center; gap: 8px; font-size: 10.5px; color: var(--hz-muted) !important; font-variant-numeric: tabular-nums; }
    .bucket-row > span:first-child { text-align: left; color: #cbd5e1 !important; }
    .bucket-row > span:last-child { text-align: right; font-variant-numeric: tabular-nums; }
    .bucket-track { height: 5px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
    .bucket-fill { height: 100%; background: var(--hz-anchor); border-radius: 3px; }
    .subagent-pills { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .subagent-pill { font-size: 10.5px; padding: 4px 8px; border-radius: 5px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); color: var(--hz-fg) !important; font-variant-numeric: tabular-nums; }
    .mini-cell { cursor: pointer; position: relative; transition: transform 0.12s ease, opacity 0.12s ease, box-shadow 0.12s ease; }
    .mini-cell.low-attention-trough {
      outline: 1px dashed rgba(245, 158, 11, 0.65);
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.45);
    }
    .mini-cell.stranded-signal {
      outline: 1.5px solid #f59e0b;
      box-shadow: 0 0 6px rgba(245, 158, 11, 0.45);
    }
    .mini-cell.selected {
      outline: 2px solid #38bdf8;
      transform: translateY(-1px);
      z-index: 3;
    }
    .fracture-marker {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      line-height: 1;
      color: #f59e0b !important;
      padding: 0 1px;
      user-select: none;
      cursor: help;
    }
    .stranded-signal-banner {
      margin-top: 6px;
      padding: 6px 8px;
      border-radius: 5px;
      font-size: 10.5px;
      line-height: 1.35;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fde68a !important;
    }
    .stranded-signal-banner[hidden] { display: none !important; }
    .cell-turn-filter-panel {
      margin-top: 6px;
      padding: 7px 9px;
      border-radius: 6px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(56, 189, 248, 0.35);
      font-size: 10.5px;
      color: var(--hz-fg) !important;
    }
    .cell-turn-filter-panel[hidden] { display: none !important; }
    .cell-turn-filter-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-weight: 600;
      color: #38bdf8 !important;
      margin-bottom: 4px;
    }
    .host-watchdog-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 10.5px;
      color: var(--hz-muted) !important;
      padding: 5px 12px;
      border-radius: 6px;
      background: var(--hz-card);
      border: 1px solid var(--hz-border-subtle);
      font-variant-numeric: tabular-nums;
    }
    .host-watchdog-bar.alert {
      border-color: rgba(239, 68, 68, 0.45);
      background: rgba(239, 68, 68, 0.08);
      color: #fca5a5 !important;
    }
    .host-watchdog-bar[hidden] { display: none !important; }
--background: #090d16;
--foreground: #f8fafc;
--muted: #111827;
--muted-foreground: #94a3b8;
--border: rgba(255, 255, 255, 0.10);
--ring: #38bdf8;
--hz-bg: #090d16;
--hz-card: #0f1623;
--hz-card-alt: #161f30;
--hz-fg: #f8fafc;
--hz-fg-secondary: #cbd5e1;
--hz-muted: #94a3b8;
--hz-dim: var(--hz-muted);
--hz-border: rgba(255, 255, 255, 0.10);
--hz-border-subtle: rgba(255, 255, 255, 0.06);
--hz-useful: #10b981;
--hz-cached-history: #0d9488;
--hz-clutter: #f59e0b;
--hz-danger: #ef4444;
--hz-free: #1e293b;
--hz-anchor: #38bdf8;
/* Source: scripts/build_demo_page.mjs */
#chDemoBar {
    position: sticky;
    top: 0;
    z-index: 99999;
    background: linear-gradient(90deg, #090d16 0%, #111827 100%);
    border-bottom: 1px solid #334155;
    padding: 8px 14px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    color: #f8fafc;
    box-shadow: 0 4px 12px rgba(0,0,0,0.45);
  }
  #chDemoBar .ch-brand {
    font-weight: 700;
    font-size: 13px;
    color: #38bdf8;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #chDemoBar select {
    background: #1e293b;
    color: #f8fafc;
    border: 1px solid #475569;
    border-radius: 5px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  #chDemoBar .ch-complaint {
    font-size: 11.5px;
    color: #fbbf24;
    flex: 1 1 100%;
    padding-top: 2px;
  }
  #chDemoBar .ch-cta {
    background: #22c55e;
    color: #052e16;
    text-decoration: none;
    font-size: 11.5px;
    font-weight: 700;
    padding: 5px 10px;
    border-radius: 5px;
  }
/* Source: scripts/generate_hero_svg.mjs */
.mono { font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; }
      @keyframes blinkAmber {
        0%, 100% { fill-opacity: 1; stroke: #facc15; stroke-width: 1.5px; }
        50% { fill-opacity: 0.35; stroke-width: 0px; }
      }
      @keyframes pulseDanger {
        0%, 100% { filter: drop-shadow(0 0 4px rgba(239, 68, 68, 0.85)); }
        50% { filter: drop-shadow(0 0 0px rgba(239, 68, 68, 0)); }
      }
      .blink-amber { animation: blinkAmber 1.4s infinite ease-in-out; }
      .pulse-danger { animation: pulseDanger 1.8s infinite ease-in-out; }
.mono { font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
/* Source: src/webview/horizon_panel.html */
:root {
    /* Host IDE Bridge Overrides (Prevents #333 fallback bleed) */
    --background: #090d16;
    --foreground: #f8fafc;
    --muted: #111827;
    --muted-foreground: #94a3b8;
    --border: rgba(255, 255, 255, 0.10);
    --ring: #38bdf8;

    /* Surface Palette (Developer Slate / Zinc) */
    --hz-bg: #090d16;
    --hz-card: #0f1623;
    --hz-card-alt: #161f30;
    --hz-fg: #f8fafc;
    --hz-fg-secondary: #cbd5e1;
    --hz-muted: #94a3b8;         /* WCAG AA 7.1:1 against --hz-bg */
    --hz-dim: var(--hz-muted);   /* Alias of --hz-muted (~7:1 on --hz-bg) */
    --hz-border: rgba(255, 255, 255, 0.10);
    --hz-border-subtle: rgba(255, 255, 255, 0.06);

    /* Semantic Telemetry Indicators */
    --hz-useful: #10b981;        /* Green: Active code + rules */
    --hz-cached-history: #0d9488;/* Muted Slate/Teal: Cached History â€” 95% Discounted */
    --hz-clutter: #f59e0b;       /* Amber: Reclaimable noise / Cold Bloat */
    --hz-danger: #ef4444;        /* Red: Over limit / errors */
    --hz-free: #1e293b;          /* Dark slate: Free headroom */
    --hz-anchor: #38bdf8;        /* Cyan: Rules & interactive links */
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: var(--hz-bg); color: var(--hz-fg); color-scheme: dark; }
  body {
    background: var(--hz-bg) !important;
    color: var(--hz-fg) !important;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 12.5px;
    line-height: 1.45;
    padding: 12px 14px !important;
    user-select: none;
    -webkit-font-smoothing: antialiased;
  }

  .mono,
  .badge,
  .session-select,
  .b-val,
  .diag-impact,
  .group-pill,
  .chronic-badge,
  .retained-badge,
  .handoff-dot,
  .sig-val,
  .base-tok {
    font-family: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  /* Strict WCAG Keyboard Focus States (shadcn/ui ring pattern) */
  button:focus-visible,
  select:focus-visible,
  input:focus-visible,
  summary:focus-visible,
  a:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid var(--ring) !important;
    outline-offset: 2px !important;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }

  .wrap {
    max-width: 560px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* 1. Top Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 2px;
  }
  .title-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--hz-useful);
    border: 1px solid rgba(255, 255, 255, 0.25);
  }
  .dot.warn { background: var(--hz-clutter); }
  .dot.danger { background: var(--hz-danger); }

  h1 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--hz-fg) !important;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* shadcn/ui Tabs Primitive for Simple / Advanced View Mode */
  .shadcn-tabs-list {
    display: inline-flex;
    align-items: center;
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }
  .shadcn-tab-trigger {
    background: transparent;
    border: none;
    color: var(--hz-muted) !important;
    font-family: inherit;
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .shadcn-tab-trigger:hover {
    color: var(--hz-fg) !important;
  }
  .shadcn-tab-trigger[aria-selected="true"] {
    background: var(--hz-card-alt);
    color: var(--hz-fg) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }

  /* In Simple Mode, hide deep diagnostics & 40-cell timeline unless expanded */
  body[data-view-mode="simple"] .advanced-only {
    display: none !important;
  }

  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 999px;
    background: rgba(16, 185, 129, 0.12);
    color: var(--hz-useful);
    border: 1px solid rgba(16, 185, 129, 0.35);
    font-variant-numeric: tabular-nums;
  }
  .badge.warn {
    background: rgba(245, 158, 11, 0.12);
    color: var(--hz-clutter);
    border-color: rgba(245, 158, 11, 0.4);
  }
  .badge.danger {
    background: rgba(239, 68, 68, 0.14);
    color: var(--hz-danger);
    border-color: rgba(239, 68, 68, 0.45);
  }
  .icon-btn {
    background: var(--hz-card-alt);
    border: 1px solid var(--hz-border);
    color: var(--hz-fg) !important;
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.2);
    color: var(--hz-fg) !important;
  }

  /* Conversation Switcher Bar */
  .session-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 6px;
    padding: 5px 10px;
  }
  .session-label {
    font-size: 11px;
    color: var(--hz-muted) !important;
    font-weight: 600;
    white-space: nowrap;
  }
  .session-select {
    flex: 1;
    min-width: 0;
    background: var(--hz-card-alt);
    color: var(--hz-fg) !important;
    border: 1px solid var(--hz-border);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11.5px;
    font-weight: 500;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .session-select option {
    background: var(--hz-card);
    color: var(--hz-fg);
  }
  .prefix-lock-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(56, 189, 248, 0.12);
    color: var(--hz-anchor) !important;
    border: 1px solid rgba(56, 189, 248, 0.35);
    white-space: nowrap;
    cursor: help;
    font-variant-numeric: tabular-nums;
  }
  .prefix-lock-badge[hidden] {
    display: none !important;
  }

  /* 2. Storage Bar Card (Tufte High Data-Ink Ratio: Unified Horizontal Band) */
  .storage-card {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .storage-top {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 4px 10px;
    margin-bottom: 6px;
  }
  .used-big {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--hz-fg) !important;
  }
  .used-of {
    font-size: 12px;
    color: var(--hz-muted) !important;
    font-weight: 400;
    margin-left: 4px;
  }
  .free-label {
    font-size: 11.5px;
    color: var(--hz-muted) !important;
  }
  .delta-line {
    font-size: 11px;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--hz-muted) !important;
    align-items: baseline;
    min-width: 0;
  }
  /* Turn-delta row: the file label ellipsizes; the token suffix never clips */
  .delta-line .delta-head { flex-shrink: 0; white-space: pre; }
  .delta-line .delta-src {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 210px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delta-line .delta-tok { flex-shrink: 0; white-space: pre; }
  .delta-line.up { color: #cbd5e1 !important; }
  .delta-line.up.big { color: #f59e0b !important; }
  .delta-line.down { color: #10b981 !important; }
  .free-wrap { display: inline-flex; align-items: center; gap: 6px; }
  .gear-btn {
    background: transparent !important;
    border: 1px solid rgba(148, 163, 184, 0.3);
    border-radius: 4px;
    color: #cbd5e1 !important;
    font-size: 12px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;
  }
  .gear-btn:hover { border-color: #f59e0b; color: #f59e0b !important; }
  .settings-pop {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 0 10px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid var(--hz-border);
    background: var(--hz-bg) !important;
    font-size: 11.5px;
    color: var(--hz-fg) !important;
  }
  .settings-pop[hidden] { display: none; }
  .settings-pop label { display: flex; justify-content: space-between; align-items: center; gap: 10px; color: #e2e8f0 !important; }
  .settings-pop input {
    width: 110px;
    padding: 3px 6px;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: #1e293b !important;
    color: #f8fafc !important;
    font-family: ui-monospace, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .settings-row { display: flex; align-items: center; gap: 8px; }
  .settings-save, .settings-cancel {
    padding: 4px 12px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid #f59e0b;
  }
  .settings-save { background: #f59e0b !important; color: #090d16 !important; }
  .settings-cancel { background: transparent !important; color: #cbd5e1 !important; border-color: rgba(148, 163, 184, 0.4); }
  .settings-msg { font-size: 10.5px; color: #94a3b8 !important; }
  .settings-msg.err { color: #ef4444 !important; }
  .base-rows { list-style: none; margin: 6px 0 0; padding: 0; font-size: 10.5px; }
  .base-rows[hidden] { display: none; }
  .base-rows li { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 3px 0; border-bottom: 1px solid var(--hz-border-subtle); color: #cbd5e1 !important; }
  .base-rows li:last-child { border-bottom: none; }
  .base-rows .base-src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .base-rows .base-tok { flex: none; color: #f8fafc !important; text-align: right; font-variant-numeric: tabular-nums; }
  .base-rows em { font-style: normal; color: #94a3b8 !important; font-size: 9.5px; }
  .chronic-badge { font-size: 9.5px; padding: 1px 6px; border-radius: 9px; border: 1px solid rgba(148, 163, 184, 0.35); color: #cbd5e1 !important; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .chronic-badge.hot { border-color: rgba(245, 158, 11, 0.6); color: #f59e0b !important; }
  .chip-btn.chronic { border-color: #f59e0b !important; color: #f59e0b !important; font-weight: 700; }
  .tip-dismiss { background: transparent !important; border: none; color: #94a3b8 !important; cursor: pointer; font-size: 11px; padding: 0 2px; }
  .tip-dismiss:hover { color: #f8fafc !important; }
  #sipTipCard a { color: #38bdf8 !important; }

  .bar-outer {
    position: relative;
    height: 18px;
    width: 100%;
    background: var(--hz-free);
    border-radius: 4px;
    margin-top: 18px;           /* reserved lane for the limit tag so it never overlaps the delta line */
    margin-bottom: 18px;        /* reserved lane below the track for the 50k Sync / ceiling tags */
  }
  .bar-track {
    display: flex;
    height: 100%;
    width: 100%;
    border-radius: 4px;
    overflow: hidden;
    gap: 1px;
  }
  .seg-useful { background: var(--hz-useful); height: 100%; transition: width 0.25s ease; }
  .seg-clutter { background: var(--hz-clutter); height: 100%; transition: width 0.25s ease, background-color 0.25s ease; }
  .seg-clutter.cached-warm { background: var(--hz-cached-history) !important; }
  .seg-clutter.cold-bloat { background: var(--hz-clutter) !important; }
  .seg-error { display: none; width: 0 !important; height: 100%; }

  .ceiling-clamp-pill {
    display: inline-block;
    font-size: 9.5px;
    font-weight: 600;
    padding: 1px 6px;
    margin-left: 4px;
    border-radius: 4px;
    background: rgba(56, 189, 248, 0.10);
    border: 1px solid rgba(56, 189, 248, 0.35);
    color: var(--hz-anchor) !important;
    white-space: nowrap;
    vertical-align: middle;
  }
  .ceiling-clamp-pill[hidden] { display: none !important; }

  .cascade-line {
    position: absolute;
    left: 19.5%;
    top: -3px;
    bottom: -3px;
    border-left: 1px dashed rgba(56, 189, 248, 0.75);
    pointer-events: auto;
    cursor: help;
    z-index: 4;
  }
  .cascade-tag {
    /* Anchored BELOW the bar track so it can never collide with the Safe Limit tag above it */
    position: absolute;
    left: 3px;
    top: auto;
    bottom: -14px;
    font-size: 9.5px;
    font-weight: 600;
    color: #7dd3fc;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .hard-ceiling-line {
    position: absolute;
    right: 0;
    top: -3px;
    bottom: -3px;
    border-right: 2px solid rgba(239, 68, 68, 0.75);
    pointer-events: auto;
    cursor: help;
    z-index: 4;
  }
  .hard-ceiling-tag {
    position: absolute;
    right: 2px;
    bottom: -13px;
    font-size: 9px;
    font-weight: 600;
    color: #94a3b8;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .limit-line {
    position: absolute;
    left: 70%;
    top: -3px;
    bottom: -3px;
    border-left: 1px dashed rgba(251, 113, 133, 0.8); /* border-rose-400/80 */
    pointer-events: auto;
    cursor: help;
    z-index: 5;
  }
  .limit-line::before {
    content: '';
    position: absolute;
    left: -2.5px;
    top: -1px;
    width: 4px;
    height: 1px;
    background: rgba(251, 113, 133, 0.8);
  }
  .limit-tag {
    /* Right-aligned ABOVE the bar track, ending at the marker */
    position: absolute;
    left: -4px;
    right: auto;
    transform: translateX(-100%);
    top: -14px;
    font-size: 10px;
    font-weight: 600;
    color: #fda4af; /* text-rose-300 */
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Flattened Horizontal Metric Band (No Nested Boxes-Within-Boxes) */
  .breakdown-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    border-top: 1px solid var(--hz-border);
    padding-top: 10px;
  }
  .b-item {
    background: transparent;
    border: none;
    border-right: 1px solid var(--hz-border-subtle);
    border-radius: 0;
    padding: 0 10px;
    min-width: 0;
  }
  .b-item:first-child { padding-left: 0; }
  .b-item:last-child { border-right: none; padding-right: 0; }
  .b-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--hz-muted) !important;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .b-swatch {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .b-val {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--hz-fg) !important;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .b-sub {
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 3. Action Center Card */
  .action-card {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--hz-fg) !important;
  }
  .action-card.warn {
    background: #191610 !important;
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: var(--hz-fg) !important;
  }
  .action-card.danger {
    background: #1e1216 !important;
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: var(--hz-fg) !important;
  }
  .action-msg {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--hz-fg) !important;
  }
  .action-msg strong {
    color: #ffffff !important;
  }
  .action-icon {
    font-size: 14px;
    line-height: 1.2;
    flex-shrink: 0;
  }

  /* Compact Guided Action Box - Flattened */
  .guided-step-box {
    background: transparent !important;
    border: none;
    border-radius: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .action-card .action-icon, .action-card .action-msg { color: var(--hz-fg) !important; }
  .action-card.danger .guided-step-box {
    border: none;
  }

  .compact-instruction {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.5;
    border: 1px solid var(--hz-border-subtle);
    border-left: 3px solid #f59e0b;
    background: var(--hz-bg) !important;
    color: var(--hz-fg) !important;
    cursor: default;
    user-select: text;
  }
  .compact-instruction kbd {
    font-family: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: #1e293b !important;
    color: #e2e8f0 !important;
  }
  .compact-instruction kbd.cmd-kbd {
    color: #f59e0b !important;
    border-color: rgba(245, 158, 11, 0.55);
    font-weight: 700;
  }
  .compact-reclaim {
    display: block;
    font-size: 10.5px;
    font-weight: 500;
    color: #f59e0b !important;
    font-variant-numeric: tabular-nums;
  }
  /* While the green DEFER_WARM banner is visible, mute the urgent amber accent so hierarchy doesn't contradict it */
  #guidedStepBox[data-cache-advisory="lean"] .compact-instruction {
      border-color: var(--hz-border, #475569) !important;
      background: transparent !important;
    }
    #guidedStepBox[data-cache-advisory="warm-defer"] .compact-instruction {
    border-left-color: var(--hz-border);
  }

  .param-compact-details > summary {
    cursor: pointer;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--hz-muted) !important;
    user-select: none;
    padding: 2px 0;
  }
  .param-compact-details[open] > summary { margin-bottom: 4px; }
  /* Advanced mode: template is force-opened by applyViewMode(); hide the disclosure chrome */
  body[data-view-mode="advanced"] .param-compact-details > summary { display: none; }

  .param-compact-box {
    padding: 6px 10px;
    border-radius: 5px;
    border: 1px dashed var(--hz-border);
    background: rgba(15, 22, 35, 0.85);
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--hz-fg-secondary) !important;
    user-select: text;
    word-break: break-word;
  }
  .param-compact-label {
    display: block;
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--hz-anchor) !important;
    margin-bottom: 2px;
  }
  .cache-compaction-advisory {
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.4;
  }
  .cache-compaction-advisory.warm-defer {
    background: rgba(13, 148, 136, 0.12);
    border: 1px solid rgba(13, 148, 136, 0.4);
    color: #5eead4 !important;
  }
  .cache-compaction-advisory.cold-compact-now {
    background: rgba(245, 158, 11, 0.14);
    border: 1px solid rgba(245, 158, 11, 0.45);
    color: #fde68a !important;
  }
  .artifact-drift-banner {
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.4;
    background: rgba(239, 68, 68, 0.14);
    border: 1px solid rgba(239, 68, 68, 0.45);
    color: #fca5a5 !important;
  }
  .artifact-drift-banner[hidden] { display: none !important; }
  .baton-pass-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid rgba(56, 189, 248, 0.35);
    background: rgba(56, 189, 248, 0.08);
  }
  .baton-pass-info {
    font-size: 10.5px;
    color: var(--hz-fg-secondary) !important;
    flex: 1 1 180px;
  }
  .baton-pass-info strong {
    color: var(--hz-anchor) !important;
  }
  .btn-baton-pass {
    padding: 5px 11px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    border: 1px solid rgba(56, 189, 248, 0.55);
    background: var(--hz-card-alt);
    color: var(--hz-anchor) !important;
    white-space: nowrap;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .btn-baton-pass:hover {
    background: rgba(56, 189, 248, 0.16);
    border-color: var(--hz-anchor);
  }

  /* Collapsible Secondary Actions */
  .secondary-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .btn-secondary {
    flex: 1;
    min-width: 135px;
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--hz-border);
    background: var(--hz-card-alt);
    color: var(--hz-fg) !important;
    text-align: center;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.22);
  }

  .feedback-toast {
    display: none;
    padding: 7px 10px;
    border-radius: 5px;
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.35);
    color: var(--hz-fg) !important;
    font-size: 11px;
    line-height: 1.4;
  }

  /* 4. Diagnostic & Brain Playbook Cards (shadcn/ui Accordion / Collapsible) */
  .playbook-card {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .playbook-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--hz-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .playbook-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--hz-fg) !important;
  }
  .playbook-sub {
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    font-variant-numeric: tabular-nums;
  }
  .diag-item {
    padding: 0;
    border-bottom: 1px solid var(--hz-border-subtle);
    display: flex;
    flex-direction: column;
    color: var(--hz-fg) !important;
  }
  .diag-item:last-child { border-bottom: none; }
  .diag-item.diag-rollup summary.diag-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    cursor: pointer;
    user-select: none;
    list-style: none;
    gap: 8px;
    background: transparent;
    color: var(--hz-fg) !important;
    transition: background-color 0.15s ease;
  }
  .diag-item.diag-rollup summary.diag-top::-webkit-details-marker { display: none; }
  .diag-item.diag-rollup summary.diag-top:hover {
    background: rgba(255, 255, 255, 0.035);
  }
  .diag-item.diag-rollup .diag-body {
    padding: 6px 12px 10px 24px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--hz-border-subtle);
    background: rgba(0, 0, 0, 0.18);
  }
  .diag-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    color: var(--hz-fg) !important;
  }
  .diag-name {
    font-size: 11.5px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--hz-fg) !important;
  }
  .diag-caret {
    display: inline-block;
    font-size: 8.5px;
    color: var(--hz-muted) !important;
    transition: transform 0.15s ease;
    width: 10px;
  }
  .diag-item.diag-rollup[open] summary .diag-caret {
    transform: rotate(90deg);
  }
  .diag-impact {
    font-size: 11px;
    font-weight: 600;
    color: var(--hz-clutter);
    white-space: nowrap;
    text-align: right;
    min-width: 44px;
    font-variant-numeric: tabular-nums;
  }
  .diag-desc {
    font-size: 11px;
    color: var(--hz-muted) !important;
    line-height: 1.45;
  }
  .diag-desc code {
    background: rgba(255, 255, 255, 0.08);
    padding: 1px 4px;
    border-radius: 3px;
    color: var(--hz-anchor);
    font-family: ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 10.5px;
  }
  .diag-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 3px;
  }
  .mini-btn {
    padding: 4px 9px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
    background: var(--hz-card-alt);
    border: 1px solid var(--hz-border);
    color: var(--hz-anchor) !important;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  .mini-btn:hover { background: rgba(56, 189, 248, 0.12); border-color: rgba(56, 189, 248, 0.35); }
  .mini-btn.danger { color: var(--hz-danger) !important; }
  .mini-btn.danger:hover { background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.35); }

  .diag-pill {
    font-size: 10px;
    color: var(--hz-muted) !important;
    background: rgba(255, 255, 255, 0.04);
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--hz-border-subtle);
  }

  details.file-drawer summary {
    font-size: 10.5px;
    color: var(--hz-anchor) !important;
    cursor: pointer;
    margin-top: 2px;
  }
  .file-sublist {
    margin-top: 4px;
    padding-left: 10px;
    border-left: 1px solid var(--hz-border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .file-subrow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    font-variant-numeric: tabular-nums;
  }

  /* Diagnostic groups */
  .diag-group.reclaim { border-left: 2px solid var(--hz-clutter); }
  .diag-group.spike {
    border-left: 2px dashed var(--hz-muted);
    background: rgba(148, 163, 184, 0.04);
  }
  .diag-group.tips { border-left: 2px solid var(--hz-anchor); }
  .group-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.025);
    border-bottom: 1px solid var(--hz-border-subtle);
  }
  .group-title { font-size: 11px; font-weight: 600; letter-spacing: 0.01em; color: #cbd5e1 !important; }
  .group-pill {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--hz-border);
    color: var(--hz-muted) !important;
    white-space: nowrap;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .diag-group.reclaim .group-pill {
    display: none !important;
  }
  .group-meta {
    font-size: 10px;
    font-weight: 500;
    color: var(--hz-muted) !important;
    white-space: nowrap;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .retained-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    color: var(--hz-muted) !important;
    background: rgba(148, 163, 184, 0.10);
    border: 1px solid var(--hz-border);
  }
  .prompt-btn.flash, .btn-secondary.flash {
    color: var(--hz-useful) !important;
    border-color: var(--hz-useful) !important;
  }

  /* 5. Optional Collapsible 40-Block Timeline */
  details.advanced-drawer {
    background: var(--hz-card);
    border: 1px solid var(--hz-border);
    border-radius: 8px;
    padding: 8px 12px;
  }
  details.advanced-drawer summary {
    font-size: 11px;
    color: var(--hz-muted) !important;
    cursor: pointer;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  details.advanced-drawer summary:hover {
    color: var(--hz-fg) !important;
  }
  .mini-timeline {
    display: flex;
    gap: 2px;
    height: 16px;
    margin-top: 10px;
    border-radius: 3px;
    overflow: visible;
  }
  .mini-cell { flex: 1; height: 100%; background: var(--hz-free); position: relative; border-radius: 1px; cursor: crosshair; }
  .mini-cell.effort-shift {
    border-top: 2px solid #f59e0b;
  }
  .effort-shift-badge {
    position: absolute;
    top: -9px;
    right: -2px;
    font-size: 8.5px;
    line-height: 1;
    font-weight: 700;
    color: #fbbf24;
    background: var(--hz-bg);
    border: 1px solid rgba(245, 158, 11, 0.65);
    border-radius: 3px;
    padding: 0 2px;
    pointer-events: none;
    z-index: 3;
  }
  .limit-reason-tip {
    display: inline-block;
    margin-left: 4px;
    font-size: 10px;
    color: var(--hz-anchor);
    cursor: help;
    vertical-align: baseline;
  }
  .high-effort-sludge-banner {
    background: #231518 !important;
    border: 1px solid rgba(245, 158, 11, 0.55);
    border-left: 3px solid #ef4444;
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    color: #fde68a !important;
  }
  .high-effort-sludge-banner[hidden] { display: none !important; }
  .mini-inspector { font-size: 10.5px; color: var(--hz-muted) !important; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .timeline-legend {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    margin-top: 5px;
    font-size: 9.5px;
    color: var(--hz-muted) !important;
    font-variant-numeric: tabular-nums;
  }

  .footer-meta {
    text-align: center;
    font-size: 10.5px;
    color: var(--hz-muted) !important;
    padding-top: 2px;
    font-variant-numeric: tabular-nums;
  }
    /* ---- Progressive disclosure & guardrails ---- */
    .b-toggle { background: none; border: 0; padding: 0; margin: 0; text-align: left; font: inherit; font-size: 10.5px; cursor: pointer; color: var(--hz-muted) !important; }
    .b-toggle:hover { color: var(--hz-anchor) !important; }
    .b-toggle .caret { display: inline-block; font-size: 8.5px; transition: transform .15s; }
    .b-toggle[aria-expanded="true"] .caret { transform: rotate(90deg); }
    .signal-drawer { margin-top: 10px; border-top: 1px solid var(--hz-border); padding-top: 10px; background: transparent; }
    .signal-drawer[hidden] { display: none; }
    .sig-row + .sig-row { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--hz-border-subtle); }
    .sig-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 11.5px; font-weight: 600; color: var(--hz-fg) !important; }
    .sig-val { color: var(--hz-useful); text-align: right; font-variant-numeric: tabular-nums; }
    .sig-desc { font-size: 10.5px; color: var(--hz-muted) !important; margin-top: 2px; }
    .sig-desc code { font-family: ui-monospace, Consolas, monospace; color: var(--hz-anchor); }

    /* Single footer row under primary compact button */
    .action-footers-row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 6px 14px;
      margin-top: 4px;
      padding-top: 8px;
      border-top: 1px solid var(--hz-border-subtle);
    }
    .action-footers-row details {
      flex: 1 1 auto;
      font-size: 11px;
    }
    .action-footers-row details[open] {
      flex: 1 1 100%;
    }
    .action-footers-row details summary {
      cursor: pointer;
      color: var(--hz-anchor) !important;
      font-size: 11px;
      font-weight: 600;
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      user-select: none;
    }
    .action-footers-row details summary::-webkit-details-marker { display: none; }
    .action-footers-row details summary::before {
      content: '\25B6';
      display: inline-block;
      font-size: 8px;
      transition: transform 0.15s ease;
    }
    .action-footers-row details[open] summary::before {
      transform: rotate(90deg);
    }
    .action-footers-row details summary:hover {
      color: var(--hz-fg) !important;
    }

    .survive-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; margin-top: 8px; }
  .survive-grid > * { min-width: 0; overflow-wrap: anywhere; }
    .survive-col { border: 1px solid var(--hz-border); border-radius: 6px; padding: 6px 8px; font-size: 11px; }
    .survive-col.keep { background: rgba(16, 185, 129, 0.06); border-color: rgba(16, 185, 129, 0.25); }
    .survive-col.drop { background: rgba(245, 158, 11, 0.06); border-color: rgba(245, 158, 11, 0.25); }
    .survive-title { font-weight: 700; margin-bottom: 3px; }
    .survive-col.keep .survive-title { color: var(--hz-useful); }
    .survive-col.drop .survive-title { color: var(--hz-clutter); }
    .survive-col ul { margin: 0; padding-left: 16px; color: var(--hz-muted) !important; }

    .handoff-dot { font-size: 10.5px; font-weight: 700; margin-left: 4px; }
    .handoff-dot.synced { color: var(--hz-useful); }
    .handoff-dot.stale { color: var(--hz-clutter); }
    .handoff-dot .task-sync-badge { color: inherit; }
    .handoff-status { margin-top: 8px; font-size: 11.5px; font-weight: 600; }
    .handoff-status[hidden], .handoff-confirm[hidden] { display: none; }
    .handoff-status.synced { color: var(--hz-useful); }
    .handoff-status.stale { color: var(--hz-clutter); }
    .btn-secondary.emphasis { border-color: var(--hz-clutter); }
    .handoff-confirm { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--hz-clutter); border-radius: 6px; background: rgba(245, 158, 11, 0.08); font-size: 11.5px; color: var(--hz-fg) !important; }
    .handoff-confirm-btns { display: flex; gap: 8px; margin-top: 6px; }
    .mini-btn.muted { color: var(--hz-muted) !important; }

    /* Diagnostic item alignment & full-line drawers */
    .diag-drawer-full { margin: 0; }
    .diag-drawer-full summary {
      font-size: 11px;
      color: var(--hz-anchor) !important;
      cursor: pointer;
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      user-select: none;
    }
    .diag-drawer-full summary::-webkit-details-marker { display: none; }
    .diag-drawer-full summary::before { content: '\25B6'; font-size: 8px; }
    .diag-drawer-full[open] summary::before { content: '\25BC'; }
    .diag-footer-bar, .diag-actions-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
      padding-bottom: 2px;
    }
    .diag-actions-label {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--hz-muted) !important;
    }
    .diag-actions-buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .diag-hint {
      font-size: 10px;
      color: var(--hz-muted) !important;
      user-select: none;
      white-space: nowrap;
      align-self: center;
    }
    .prompt-btn.flash, .btn-secondary.flash, .chip-btn.flash {
      color: var(--hz-useful) !important;
      border-color: var(--hz-useful) !important;
    }
    .file-subrow.rich { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; }
    .file-subrow.rich .fpath { flex: 1 1 140px; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: left; color: #cbd5e1 !important; }
    .file-subrow.rich .fmeta { text-align: right; font-variant-numeric: tabular-nums; color: var(--hz-muted) !important; }
    .chip-btn { font: inherit; font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--hz-border); background: transparent; color: var(--hz-muted) !important; cursor: pointer; }
    .chip-btn:hover { color: var(--hz-anchor) !important; border-color: var(--hz-anchor); }
    .chip-btn.noisy { color: var(--hz-clutter) !important; border-color: var(--hz-clutter); }
    .payload-box { margin-top: 6px; padding: 6px 8px; border: 1px solid var(--hz-border); border-radius: 6px; font-size: 11px; color: var(--hz-fg) !important; word-break: break-all; }
    .payload-box .payload-kind { color: var(--hz-muted) !important; display: block; margin-bottom: 2px; }
    .payload-box .chip-btn, .payload-box .mini-btn { margin-top: 6px; }
    .quota-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 6px;
      padding: 5px 10px;
      background: var(--hz-card);
      border: 1px solid var(--hz-border);
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      font-size: 10px;
      letter-spacing: -0.01em;
      color: var(--hz-muted) !important;
      font-variant-numeric: tabular-nums;
    }
    .quota-strip[hidden] { display: none !important; }
    .quota-pills {
      display: flex;
      flex: 1 1 100%;
      flex-wrap: wrap;
      gap: 4px 8px;
      align-items: center;
      justify-content: space-between;
    }
    .quota-telemetry {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .quota-Forecast { color: var(--hz-anchor) !important; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .quota-Forecast[hidden] { display: none !important; }
    .quota-warn {
      color: var(--hz-clutter) !important;
      font-weight: 700;
      white-space: nowrap;
      margin-left: auto;
    }
    @keyframes hzTtlPulse {
      0%, 100% { border-color: rgba(245, 158, 11, 0.35); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
      50% { border-color: rgba(245, 158, 11, 0.9); box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2); }
    }
    .quota-strip.ttl-pulse {
      animation: hzTtlPulse 1.6s ease-in-out infinite;
      border-color: rgba(245, 158, 11, 0.65);
    }
    .ttl-pulse-badge {
      color: var(--hz-clutter) !important;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.4);
      white-space: nowrap;
    }
    .prefix-bust-badge {
      color: var(--hz-clutter) !important;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.4);
      white-space: nowrap;
    }
    .quota-est {
      color: var(--hz-muted, #94a3b8) !important;
      font-weight: 500;
      font-style: italic;
      cursor: help;
    }
    .quota-meta-row {
      display: flex;
      flex: 1 1 100%;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 8px;
      font-size: 9.5px;
      color: var(--hz-fg-secondary) !important;
      border-top: 1px dashed var(--hz-border-subtle);
      padding-top: 3px;
      margin-top: 2px;
    }
    .quota-meta-row[hidden] { display: none !important; }
    .quota-credits {
      color: var(--hz-anchor) !important;
      font-weight: 600;
      white-space: nowrap;
    }
    .overage-guardrail-banner {
      flex: 1 1 100%;
      margin-top: 3px;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.35;
    }
    .overage-guardrail-banner[hidden] { display: none !important; }
    .overage-guardrail-banner.danger {
      background: rgba(239, 68, 68, 0.14);
      border: 1px solid rgba(239, 68, 68, 0.45);
      color: #fca5a5 !important;
    }
    .overage-guardrail-banner.warn {
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fde68a !important;
    }
    .bucket-bars { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .bucket-row { display: grid; grid-template-columns: 72px 1fr 64px; align-items: center; gap: 8px; font-size: 10.5px; color: var(--hz-muted) !important; font-variant-numeric: tabular-nums; }
    .bucket-row > span:first-child { text-align: left; color: #cbd5e1 !important; }
    .bucket-row > span:last-child { text-align: right; font-variant-numeric: tabular-nums; }
    .bucket-track { height: 5px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
    .bucket-fill { height: 100%; background: var(--hz-anchor); border-radius: 3px; }
    .subagent-pills { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .subagent-pill { font-size: 10.5px; padding: 4px 8px; border-radius: 5px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); color: var(--hz-fg) !important; font-variant-numeric: tabular-nums; }
    .mini-cell { cursor: pointer; position: relative; transition: transform 0.12s ease, opacity 0.12s ease, box-shadow 0.12s ease; }
    .mini-cell.low-attention-trough {
      outline: 1px dashed rgba(245, 158, 11, 0.65);
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.45);
    }
    .mini-cell.stranded-signal {
      outline: 1.5px solid #f59e0b;
      box-shadow: 0 0 6px rgba(245, 158, 11, 0.45);
    }
    .mini-cell.selected {
      outline: 2px solid #38bdf8;
      transform: translateY(-1px);
      z-index: 3;
    }
    .fracture-marker {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      line-height: 1;
      color: #f59e0b !important;
      padding: 0 1px;
      user-select: none;
      cursor: help;
    }
    .stranded-signal-banner {
      margin-top: 6px;
      padding: 6px 8px;
      border-radius: 5px;
      font-size: 10.5px;
      line-height: 1.35;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fde68a !important;
    }
    .stranded-signal-banner[hidden] { display: none !important; }
    .cell-turn-filter-panel {
      margin-top: 6px;
      padding: 7px 9px;
      border-radius: 6px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(56, 189, 248, 0.35);
      font-size: 10.5px;
      color: var(--hz-fg) !important;
    }
    .cell-turn-filter-panel[hidden] { display: none !important; }
    .cell-turn-filter-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-weight: 600;
      color: #38bdf8 !important;
      margin-bottom: 4px;
    }
    .host-watchdog-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 10.5px;
      color: var(--hz-muted) !important;
      padding: 5px 12px;
      border-radius: 6px;
      background: var(--hz-card);
      border: 1px solid var(--hz-border-subtle);
      font-variant-numeric: tabular-nums;
    }
    .host-watchdog-bar.alert {
      border-color: rgba(239, 68, 68, 0.45);
      background: rgba(239, 68, 68, 0.08);
      color: #fca5a5 !important;
    }
    .host-watchdog-bar[hidden] { display: none !important; }
--background: #090d16;
--foreground: #f8fafc;
--muted: #111827;
--muted-foreground: #94a3b8;
--border: rgba(255, 255, 255, 0.10);
--ring: #38bdf8;
--hz-bg: #090d16;
--hz-card: #0f1623;
--hz-card-alt: #161f30;
--hz-fg: #f8fafc;
--hz-fg-secondary: #cbd5e1;
--hz-muted: #94a3b8;
--hz-dim: var(--hz-muted);
--hz-border: rgba(255, 255, 255, 0.10);
--hz-border-subtle: rgba(255, 255, 255, 0.06);
--hz-useful: #10b981;
--hz-cached-history: #0d9488;
--hz-clutter: #f59e0b;
--hz-danger: #ef4444;
--hz-free: #1e293b;
--hz-anchor: #38bdf8;
```
