# Design System Master Specification (`design-system/MASTER.md`)

**Project:** Context Horizon (`ctxtop` / `ga-visualizer-v2`)  
**Domain:** Developer Observability, Real-Time LLM Context Window Telemetry, & Prefix-Cache Hygiene  
**Design Philosophy:** Edward Tufte High Data-Ink Ratio + `shadcn/ui` Zinc/Slate Architectural Primitives + Strict WCAG AA Accessibility

---

## 1. Core Architectural & Tufte Mandates

1. **Maximize Data-Ink Ratio:**
   - Zero decorative neon/purple gradients, outer glow shadows (`box-shadow: 0 0 8px ...`), or uninformative nested card boxes.
   - Structural separation is achieved through `1px` crisp hairlines (`var(--hz-border)`), subtle surface elevation shifts, and deliberate typographic contrast.
   - Host IDE Preload Isolation: Always declare `--background` and `--foreground` on `:root` and enforce `color: var(--hz-fg) !important` on `body` so host IDE injected inline styles (`color: var(--foreground, #333)`) never bleed low-contrast `#333333` text into dark-mode telemetry containers.

2. **Typographic Discipline & 3-Tier Hierarchy:**
   - **Font Stack (Sans):** `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif`
   - **Font Stack (Monospace / Telemetry):** `ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace`
   - **Tabular Numerals (`tabular-nums`):** Enforced (`font-variant-numeric: tabular-nums`) across all counters, token metrics, percentages, turn numbers, badges, dropdown options, and tabular rows to prevent horizontal jitter during 2-second SSE updates.
   - **3-Tier Hierarchy:**
     - **Tier 1 — Primary Metric / Header:** `20px` bold (`700`) with tight tracking (`-0.02em`) for hero token counters (`#usedBig`); `13.5px–14px` semibold (`600–700`, `-0.01em`) for primary section headers and band values (`#f8fafc`).
     - **Tier 2 — Secondary Label:** `11.5px–12px` medium/semibold (`500–600`) for diagnostic item titles, interactive controls, and category labels (`#e2e8f0` / `#cbd5e1`).
     - **Tier 3 — Muted Metadata:** `10.5px–11px` regular/medium (`400–500`) for descriptions, timestamps, and secondary hints (`#94a3b8`, contrast ratio `7.1:1` on `#0b0f17` — passes WCAG AA).

3. **Progressive Disclosure (`shadcn/ui` Primitives):**
   - **Switchable Simple / Advanced View Mode (`Tabs`):** Top-level `role="tablist"` (`Simple` vs `Advanced`) allows developers to stay in a focused, zero-noise Simple view (Quota Strip, Primary Token Bar + 3-Band Summary, and Smart Action Center) or switch to Advanced view (or auto-expand) for deep Brain Diagnostics, 5-Bucket Baseline Profiler, and the 40-Cell Chrono-Attention Timeline.
   - **Collapsible Diagnostic Rollups (`Accordion` / `Collapsible`):** Every diagnostic item (`details.diag-rollup[data-slot="collapsible"]`) and secondary drawer (`#signalDrawer`, `#surviveDrawer`, `#secondaryDrawer`) defaults to a compact single-line summary row with right-aligned tabular impact metrics.

---

## 2. Design Tokens & CSS Variables

```css
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
  --hz-dim: #94a3b8;           /* Upgraded from #64748b (3.7:1) to #94a3b8 (>= 6.3:1) for strict WCAG AA */

  /* Structural Hairlines */
  --hz-border: rgba(255, 255, 255, 0.10);
  --hz-border-subtle: rgba(255, 255, 255, 0.06);

  /* Semantic Telemetry Indicators */
  --hz-useful: #10b981;        /* Emerald: Active Signal (code + rules) */
  --hz-clutter: #f59e0b;       /* Amber: Reclaimable Sludge */
  --hz-danger: #ef4444;        /* Rose/Red: Amputation Risk / Dead Errors */
  --hz-free: #1e293b;          /* Slate-800: Safe Headroom Track */
  --hz-anchor: #38bdf8;        /* Sky-400: System Anchors & Interactive Links */
}
```

---

## 3. Spacing, Alignment & Accessibility Rules

| Token / Element | Specification | Rationale |
| :--- | :--- | :--- |
| **Container Width** | `max-width: 560px` centered (`padding: 12px 14px`) | Optimal reading measure (<75ch) in both IDE side-pane (`360px–540px`) and desktop (`1024px–1440px`) |
| **Breakdown Summary Band** | Unified 3-column horizontal hairline band (`1px solid var(--hz-border)`) | Eliminates nested cards-within-cards (`b-item` boxes inside `.storage-card`) |
| **Numeric Alignment** | Right-aligned (`text-align: right`, `font-variant-numeric: tabular-nums`) | Ensures scannable vertical columns in file sublists, baseline profiler rows, and diagnostic impact pills |
| **Focus States** | `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }` | Keyboard accessibility across all buttons, selects, tabs, and `<summary>` triggers |
| **Reduced Motion** | `@media (prefers-reduced-motion: reduce)` disables transitions | Respects OS vestibular motion preferences |

---

## 4. Protected Architectural Invariants

1. **No Copy/Paste Button for `/compact`:** Never render `#btnCompactPrimary` or `copyCompactWithGuidance`. Always render plain-text instruction `Type /compact in the chat box and press Enter` inside `#compactInstruction` with reclaim summary in `#compactReclaim`.
2. **Active Source File Protection:** Only render `.antigravityignore` (`Ignore file`) buttons on lockfiles, logs, build artifacts, or scratch files (`isIgnorablePath`) — never on active source code files.
3. **3-Way WebView Mirror Parity:** Keep `src/webview/horizon_panel.html`, `~/.gemini/config/plugins/agy-horizon/src/ui/sidepane.html`, and `~/.gemini/config/plugins/agy-horizon-flightcheck/src/webview/horizon_panel.html` byte-for-byte identical via `node scripts/sync_mirrors.mjs`.
