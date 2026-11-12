---
description: Inspect session trajectory call-tree spans, tool latencies, and swarm topology
---

Inspect the execution spans, tool calls, and swarm topology of the current or specified session.

## Execution Steps

1. Run `npx ctxtop inspect [<session-id> | --last] [--out <file.json>] [--json]` in the workspace root to inspect USTF v1 trajectory spans.
2. Read-only: it parses local live-state snapshots, USTF session traces, or Antigravity transcripts; it makes no network calls.
