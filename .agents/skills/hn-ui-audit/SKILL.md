---
name: hn-ui-audit
description: >-
  Audits, inspects, and verifies Attention Horizon (ctxtop) UI, state, and
  telemetry components against Edward Tufte high data-ink standards, WCAG AA contrast,
  and strict architectural invariants. Preloads context from evaluation_bundles/ui_audit_context.
context_bundles:
  - evaluation_bundles/ui_audit_context
---

# Horizon UI Audit (`hn-ui-audit`)

A specialized visual, state, and architectural audit skill for **Attention Horizon** (`attention-horizon-antigravity` / `ctxtop`). Use this skill to evaluate UI components, verify state and telemetry contracts, enforce Edward Tufte data-ink principles, prevent UI regressions, and ensure complete compliance with architectural invariants.

---

## 1. Context Preload Directive

Whenever executing this skill or receiving the `/hn-ui-audit` command, **immediately preload and review** the four context documents in `evaluation_bundles/ui_audit_context/`:

1. **[01_UI_COMPONENT_MAP.md](../../../evaluation_bundles/ui_audit_context/01_UI_COMPONENT_MAP.md)**: Index of live UI files, webview HTML views (`src/webview/horizon_panel.html`, `sidepane.html`), and core engine ES modules.
2. **[02_DESIGN_TOKENS_AND_RULES.md](../../../evaluation_bundles/ui_audit_context/02_DESIGN_TOKENS_AND_RULES.md)**: Semantic design tokens (`--hz-*`), layout rules, typography standards, and refactoring guidelines.
3. **[03_TELEMETRY_DATA_CONTRACT.md](../../../evaluation_bundles/ui_audit_context/03_TELEMETRY_DATA_CONTRACT.md)**: Schemas, JSDoc definitions, and telemetry data models for layers 1–6, cache states, and effort profiles.
4. **[04_KNOWN_ANTI_PATTERNS.md](../../../evaluation_bundles/ui_audit_context/04_KNOWN_ANTI_PATTERNS.md)**: Regression guardrails, forbidden UI antipatterns, and non-negotiable architectural constraints.

> [!NOTE]
> If any of these context files are missing or out-of-date, regenerate the bundle before proceeding:
> ```powershell
> powershell -ExecutionPolicy Bypass -File scripts/build-ui-audit-bundle.ps1
> ```

---

## 2. Core Architectural & UI Invariants

Any proposed UI change or code review must strictly adhere to the project invariants defined in `AGENTS.md`:

1. **1-Click Copy Button for `/compact`**:
   - Render a clickable "Copy `/compact`" button (`#btnCompactPrimary`, `#btnCopyParameterizedCompact`) alongside `#compactInstruction` (`Type /compact in the chat box and press Enter`) and `#compactReclaim`.
2. **Active Source File Protection**:
   - Only show the `Ignore file` (`.antigravityignore`) button on lockfiles, logs, build artifacts, or scratch files (`isIgnorablePath`) — never on active source code files (`*.mjs`, `*.js`, `*.html`, `*.py`, `*.ts`).
3. **Webview Mirror Parity**:
   - Run `node scripts/sync_mirrors.mjs` whenever `src/webview/horizon_panel.html` or `src/core/*.mjs` is modified to ensure exact SHA-256 parity across local plugins (`agy-horizon`, `agy-horizon-flightcheck`).
4. **Zero-Trust Read-Only Telemetry**:
   - All session databases and transcripts must be opened read-only (`SQLITE_OPEN_READONLY_OPTIONS`). Never perform outbound network calls from telemetry handlers.

---

## 3. Step-by-Step Audit Workflow

### Phase 1: Context & Bundle Verification
1. Verify the existence and recency of all four context bundle files in `evaluation_bundles/ui_audit_context/`.
2. Read the files to acquire current token variables, component mappings, and contract schemas.

### Phase 2: Visual & Data-Ink Audit (Edward Tufte Standards)
1. **Data-Ink Ratio**:
   - Check for gratuitous card wrappers, outer glow filters, or excess margins.
   - Eliminate redundant multi-line headers where a single compact HUD bar suffices.
2. **Typographic Rigor**:
   - Ensure `font-variant-numeric: tabular-nums` on all token counters, percentages, and timestamps.
   - Verify label spacing and ensure no text clipping or label collisions (e.g., staggering `50k Sync` vs `179k Safe Limit`).
3. **Mathematical Sum Parity**:
   - Confirm Tenth-of-a-Kilotoken Mathematical Parity: `Active Signal (0.1k) + Reclaimable (0.1k) === Total Used (0.1k)`.
4. **Contrast & Legibility (WCAG AA)**:
   - Ensure contrast ratios meet `4.5:1` for normal text and `3:1` for large text/icons.
   - Verify that active telemetry numbers and root-cause badges do not use low-contrast muted grays.

### Phase 3: Telemetry & State Consistency Audit
1. **Cache State Coherence**:
   - Verify that `#prefixLockBadge` (`🔒 Warm`) and teal cached history rendering only appear when `isCacheTrulyWarm` (`ttlRemainingSec > 0 && cacheReadTokens > 0 && hitRatePct > 0`).
   - If `cacheReadTokens === 0` or `hitRatePct === 0`, ensure state is marked `COLD_BLOAT` (Amber).
2. **Compaction Cleanliness**:
   - Ensure parameterized `/compact` instructions contain clean relative paths (no `.../` prefixes) and actual user constraints (no raw placeholders like `[1 in-chat user constraint(s)]`).
3. **Progressive Disclosure**:
   - Verify that detailed template boxes in `Simple` mode are collapsed within `<details>` disclosure elements.

### Phase 4: Verification & Mirror Sync
1. Run automated regression tests:
   ```powershell
   npm test
   node tests/verify_e2e_context_memory.mjs
   ```
2. Run mirror synchronization:
   ```powershell
   node scripts/sync_mirrors.mjs
   ```
3. Generate structured audit summary detailing:
   - **Status**: PASS / WARNING / FAIL
   - **Issues Identified**: File, line number, and violation description
   - **Remediation Plan**: Precise code diffs or corrective actions
