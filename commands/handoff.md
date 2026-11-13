---
description: Audit and write a compressed State Baton checkpoint before /compact or cross-session handoff
---

Generate a lossless State Baton checkpoint (`.claude/cache/HANDOFF_LATEST.md` and `task.md`) preserving active constraints, modified files, and unresolved tasks before running `/compact` or `/clear`.

## Execution Steps

1. Inspect the active session state and flush any staged `TurnZeroGate` rule updates if the prompt cache is cold (`0s` TTL).
2. Run `npx ah handoff` (or write `.claude/cache/HANDOFF_LATEST.md` + `task.md`) with exact file paths, passing tests, and remaining steps so the next session hydrates with zero Governance Decay.
