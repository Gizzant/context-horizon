# Highbeam Guidelines

The Highbeam plugin tracks active context memory health, preventing context bloat and Context Truncation Risk (Oldest Rules at Risk).

## Ground Rules:
1. **Context Truncation Guard**: When an `[Highbeam Alert]` warns of `amputationCrisis` (Context Truncation Risk), never perform unbounded file re-reads or verbose test loops. Save state to `task.md` (or run `/handoff`) and recommend `/clear` or `/compact`.
2. **Knowledge Bleed**: If injected knowledge items are flagged as foreign bleed from another workspace, verify relevance before adopting cross-project conventions.
4. **Router Ergonomics & Cooldown**: Router operates in `guard` (default) or `advisory` (warn-only) mode. Halts respect a 3-turn cooldown to avoid nag loops (Context Truncation Crisis exempt). Diagnostics can be verified anytime with `npx ctxtop doctor`.
5. **UI Invariants**: Provide a 1-click Copy `/compact` button (`#btnCompactPrimary`) alongside `#compactInstruction`, never show ignore button on active source files, and maintain 3-way mirror parity.
6. **Account & OAuth Seat Safety**: Never access `oauth_creds.json` or `gemini:antigravity` tokens, never spawn headless `gemini`/`agy` CLIs in tests with `oauth-personal`, and avoid unthrottled multi-step grep/read loops or parallel subagent fan-out (`1–2` consolidated tool calls per turn).
