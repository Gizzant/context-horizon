---
name: inspect
description: Inspect session trajectory call-tree spans, tool latencies, and swarm topology as a Studio artifact.
---

# Session Inspection (`/inspect`)

When this command is invoked, inspect the execution spans, tool calls, and swarm topology of the current session.

## Steps:
1. Run `node --no-warnings ./bin/ctxtop.mjs inspect --last --out <artifactDirectoryPath>/inspect_call_tree.json`.
   - Read-only: it parses local USTF v1 trajectories and transcript snapshots; it makes no network calls.
2. Output an inline visual embed:
   ```html
   <agent-embed src="file:///<artifactDirectoryPath>/inspect_call_tree.json"></agent-embed>
   ```
3. Offer the live side pane pill:
   [Open Attention Horizon](sidecar://agy-horizon-flightcheck/horizon-daemon/)
