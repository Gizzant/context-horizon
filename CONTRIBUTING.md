# Contributing to Context Horizon (`ctxtop`)

Thank you for helping build `context-horizon` (`ctxtop`)! Our goal is to keep AI coding agent context windows transparent, fast (`<15ms` hook latency), and 100% dependency-free.

---

## Quick Local Development Setup

Requires **Node.js 20+** (Windows, macOS, or Linux). Because `context-horizon` has **zero external npm dependencies**, you do not even need to run `npm install` to run the core engine or test suite:

```bash
# 1. Clone your fork
git clone https://github.com/<your-username>/context-horizon.git
cd context-horizon

# 2. Preview the 40-cell ANSI HUD & Flight Check Scorecard
npm start

# 3. Launch the Edward Tufte IDE Webview on localhost (with synthetic crisis data)
npm run dev

# 4. Run the 15-test unit/router suite (~170ms) + 6-phase verification suite
npm test
npm run test:phases

# 5. Run the 200-iteration latency benchmark (<15ms PreInvocation SLA)
npm run bench
```

---

## How to Add a 7th Blind-Spot Sensor in 20 Lines

All `PreInvocation` hygiene sensors live in [`src/core/blindspot_sensors.mjs`](src/core/blindspot_sensors.mjs). Every sensor must execute synchronously or in under `3ms` with zero network calls.

### Step 1: Export a pure detector function in `src/core/blindspot_sensors.mjs`
```js
export function detectEnvSecretLeak(stepEvents) {
  const leakedPaths = [];
  for (const ev of stepEvents || []) {
    if (ev.targetPath && /\.env(\.local|\.production)?$/i.test(ev.targetPath)) {
      leakedPaths.push(ev.targetPath);
    }
  }
  return { envLeakDetected: leakedPaths.length > 0, leakedPaths };
}
```

### Step 2: Wire it into `runAllBlindspotSensors(params)`
Add your detector output to the returned object in `runAllBlindspotSensors` in `src/core/blindspot_sensors.mjs`.

### Step 3: Add a deterministic test in `tests/test_router_and_sensors.mjs`
Run `npm test` and `npm run bench` to verify your sensor passes and total `PreInvocation` p95 latency stays under `15ms`.

---

## How to Add a New Telemetry Panel or Chart

1. Inspect [`src/webview/registry.mjs`](src/webview/registry.mjs) to see the `HorizonStatePayload` keys (`cells`, `window`, `metrics`, `offenders`, `brainSignals`, `quota`, `subagents`, `hostHealth`).
2. Register your panel via `registerHorizonPanel({ id, title, dataKeys, render(state) })` or propose a UI small-multiple in `src/webview/horizon_panel.html`.
3. **Important UI Invariants (see [`AGENTS.md`](AGENTS.md)):**
   - Never add a clickable "Copy `/compact`" button (`#btnCompactPrimary`). Always keep `#compactInstruction` as plain text.
   - Never show the `Ignore file` button on active source code files (`isIgnorablePath` must return `false` for `.mjs`, `.js`, `.ts`, `.py`, `.html`, etc.).
   - If you update `src/webview/horizon_panel.html`, run `npm run build:assets` and `node scripts/sync_mirrors.mjs` before committing.

---

## Pull Request Checklist

- [ ] `npm test` passes (18/18 router & sensor tests).
- [ ] `npm run test:phases` passes (Phases 1–7 Show-HN verification suites).
- [ ] `npm run test:e2e` passes (all 6 End-to-End validation layers + 3-way SHA-256 mirror parity).
- [ ] `npm run bench` confirms p95 `PreInvocation` latency `<15ms`.
- [ ] Zero third-party runtime dependencies added to `package.json`, and all SQLite opens use `SQLITE_OPEN_READONLY_OPTIONS` (`{ readOnly: true }`).
