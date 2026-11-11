---
name: cost-radar
description: Render the Cost Radar HTML/SVG timeline (prefix-cache retention, thinking drift / DET-30 loops, swarm & worktree topology) as a Studio artifact.
---

# Cost Radar (`/cost-radar`)

When this command is invoked, render a self-contained HTML/SVG timeline of where the current session spends (and saves) tokens.

## Steps:
1. Run `node --no-warnings ./src/cli/init.mjs cost-radar --json --out <artifactDirectoryPath>/cost_radar.html`.
   - Read-only: it parses local transcripts and `git worktree list`; it makes no network calls.
2. Output an inline visual embed of the generated artifact:
   ```html
   <agent-embed src="file:///<artifactDirectoryPath>/cost_radar.html"></agent-embed>
   ```
3. Summarize in at most 3 lines using the JSON fields `retention`, `drift`, and `swarm`.
   - If `loopTriggered` is `true`, lead with the DET-30 scratchpad-loop warning and recommend injecting a concrete constraint (target file + acceptance test) or stepping effort down.
   - Values shown as `—` are unmeasured — never invent numbers for them.
4. Offer the live side pane pill:
   [Open Attention Horizon](sidecar://agy-horizon-flightcheck/horizon-daemon/)
