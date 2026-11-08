---
name: frontend-design
description: Guidance for distinctive, production-grade frontend interfaces with high data-ink ratio (Edward Tufte principles), tabular typography, progressive disclosure, and WCAG AA contrast.
---

# Frontend Design

Approach UI engineering with deliberate aesthetic restraint, high technical precision, and strong domain grounding. Create interfaces that avoid generic AI templates and elevate utility, legibility, and performance.

## Core Visual & Architectural Principles

### 1. High Data-Ink Ratio (Edward Tufte Principles)
- **Eliminate Decorative Sludge**: Remove gratuitous background blur, purple/neon "AI" gradients, outer glow filters, and floating glass cards that convey no information.
- **Structural White Space**: Separate sections with deliberate spacing and subtle hairlines (`1px solid var(--border)`) rather than heavy multi-layer card borders or heavy dropshadows.
- **Every Pixel Must Work**: Visual containers exist solely to group related data. If the layout is readable without an enclosing box, omit the box.

### 2. Typographic Rigor & Metrics Hierarchy
- **Tabular Numerals**: Enforce `font-variant-numeric: tabular-nums` (or `tabular-nums` in Tailwind) on all counters, timestamps, latency monitors, currency, and table data to prevent jitter during state updates.
- **Tight Header Tracking**: Apply deliberate scale contrast with tight tracking (`letter-spacing: -0.02em` to `-0.01em`) on large headings and page titles.
- **Microcopy Legibility**: Keep body line lengths under 75-80 characters with appropriate line-height (`1.5` to `1.6`). Never use all-caps for long labels or full sentences.

### 3. Progressive Disclosure & Dense Layouts
- **Scannable Summaries**: Show high-level summary rows first. Provide expandable detail drawers, collapsible panels (`<details>`, Radix Collapsible, Accordion), or context-preserving modal dialogs for secondary metrics.
- **Compact Scannability**: Avoid sprawling vertical padding in desktop dashboards. Provide information-dense views with clear visual anchors.

### 4. Accessibility & Contrast Standards
- **Strict WCAG AA**: Ensure contrast ratios of at least `4.5:1` for normal text and `3:1` for large text, icons, and interactive borders against their immediate backgrounds.
- **Keyboard & Focus States**: Provide visible, high-contrast `:focus-visible` rings with offset outline styling (`outline: 2px solid var(--ring); outline-offset: 2px`).
- **Reduced Motion**: Always wrap continuous animations and page transitions in `@media (prefers-reduced-motion: reduce)`.

---

## Workflow & Implementation Rules

1. **Ground in Real Context**: Anchor designs in the domain's real data structures, units, and workflows (e.g., developer observability, financial analytics, or content pipelines).
2. **Component Token Consistency**: Use semantic design tokens (`--background`, `--foreground`, `--muted`, `--accent`, `--border`, `--ring`) mapped directly to CSS variables or Tailwind classes.
3. **Restraint in Motion**: Reserve motion for user feedback (collapsing, expanding, submitting, filtering). Never use unsolicited marquee loops, bounce alerts, or perpetual spinning elements.
4. **Action-Oriented Microcopy**: Button text and interactive controls must describe the exact outcome ("Deploy Preview", "Export CSV", "Revert Changes") rather than generic verbs ("Submit", "Go").
