---
description: Render the Highbeam Cost Radar (prefix-cache retention, thinking drift / DET-21 loops, swarm & worktrees) as a local HTML/SVG file
---

Render a self-contained, script-free HTML/SVG timeline of where this session spends and saves tokens.

## Execution Steps

1. Run `npx ah-claude cost-radar --json` in the workspace root (optionally `--out <file.html>`). It reads the local live-state snapshot only — no network calls, no project files mutated.
2. Report the `path` from the JSON so the user can open it in a browser.
3. Summarize in at most 3 lines using `retention`, `drift`, and `swarm`. If `loopTriggered` is `true`, lead with the DET-21 scratchpad-loop warning and suggest injecting a concrete constraint (target file + acceptance test) or lowering effort. Values shown as `—` are unmeasured; never invent numbers.
