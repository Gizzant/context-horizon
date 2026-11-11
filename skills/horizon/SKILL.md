---
name: horizon
description: Inspect real-time 40-cell context health, Context Truncation risk, and Wasted Tokens.
---

# Attention Horizon (`/horizon`)

When this command is invoked, visualize the current conversation context health.

## Steps:
1. Run `node --no-warnings ./src/cli/horizon_hud.mjs --emit-widget` to produce the self-contained HTML card at `<artifactDirectoryPath>/horizon_widget.html`.
2. Output an inline visual embed:
   ```html
   <agent-embed src="file:///<artifactDirectoryPath>/horizon_widget.html"></agent-embed>
   ```
3. Offer a one-click auxiliary side pane pill:
   [Open Attention Horizon](sidecar://agy-horizon-flightcheck/horizon-daemon/)
