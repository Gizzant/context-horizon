---
description: Analyze prompt scope, context hygiene, and optimal Claude model/effort selection before execution
---

Evaluate prompt anchoring, active KV-cache gravity (`C*`), and model/effort routing before launching a multi-step turn.

## Execution Steps

1. Check active cached prefix tokens and remaining 5m/1h TTL (`npx ah status --json`).
2. Verify concrete file/symbol anchoring and recommend holding model switches while `C > C*` inside an active warm cache window.
