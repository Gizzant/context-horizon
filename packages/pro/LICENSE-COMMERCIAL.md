# Highbeam Pro (`@ctxtop/pro`) — Commercial Source-Available License

Copyright (c) 2026 Gizzant (Highbeam). All rights reserved.

## 1. Scope of This License
This Commercial Source-Available License governs all files inside `packages/pro/**`, `src/core/pro_license.mjs`, and the commercial features unlocked by a Highbeam Pro (`CTXP1`) cryptographic license key (`AUTO_PILOT` active cache/model-switch locks, cross-harness `DET-20` lease enforcement, cross-machine zero-knowledge encrypted sync (`encrypted_sync.mjs`), Git branch/PR cost attribution (`pr_cost_attribution.mjs`), zero-knowledge org FinOps rollups (`team_finops_rollup.mjs`), CI/PR token-budget gates (`ci_budget_gate.mjs`), signed Corporate PDF 1.4 Expense Receipts, and the Team FinOps OTel/Grafana Pack).

All other components of this repository (`@ctxtop/core`, `@ctxtop/antigravity`, `@ctxtop/claude-code`, the 40-cell HUD, 5-minute TTL clock, `--roast`, and advisory `COACH` mode) remain licensed under the root **MIT License**.

## 2. Permitted Source Inspection & Local Trial
You are permitted to view, inspect, and audit the source code in `packages/pro/**` to verify security, privacy, and zero-network compliance, and to evaluate Pro features during a 14-day local trial (`npx highbeam-cli license trial`).

## 3. Commercial Restrictions
Without a valid, unexpired Highbeam Pro (`$149/yr` Annual, `$199` Founder Lifetime capped at 200 seats, or legacy `$15/mo` monthly) or Team (`$299/yr` 5-seat Team Starter intro pack, or `$39/seat/mo` for >5 seats / Enterprise FinOps) `CTXP1` Ed25519 license key issued to you or your organization, you may **NOT**:
1. Remove, patch, stub, or bypass `verifyProLicenseKey()`, `getProEntitlementStatus()`, or `requireProFeature()` checks in production builds or forks.
2. Redistribute, publish, or host modified packages that unlock `@ctxtop/pro` commercial features without a valid `CTXP1` cryptographic key.
3. Generate or share forged `CTXP1` license keys for third parties.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
