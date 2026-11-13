---
description: Audit static CLAUDE.md / AGENTS.md prefix bloat and synthesize staged learnings gated by TurnZeroGate
---

Audit `CLAUDE.md` and `.claude/rules/` token weight, reorder critical invariants into Primacy/Recency attention bands, and promote staged learnings only when the KV prefix cache is cold (`0s` TTL).

## Execution Steps

1. Inspect `CLAUDE.md` and `.claude/cache/learnings-queue.json` via `npx ah doctor` or `TurnZeroGate`.
2. If the prompt cache is warm, keep rule mutations staged until `TTL == 0s` or `PostCompact` to prevent a cold-cache prefix rebuild.
