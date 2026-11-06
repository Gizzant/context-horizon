# Chrono-Attention Horizon Guidelines

The Chrono-Attention Horizon plugin tracks active context memory health, preventing context bloat and Prefix Amputation.

## Ground Rules:
1. **Prefix Amputation Guard**: When a `[Chrono-Attention Horizon Alert]` warns of `amputationCrisis`, never perform unbounded file re-reads or verbose test loops. Save state to `task.md` and recommend `/clear` or `/compact`.
2. **Knowledge Bleed**: If injected knowledge items are flagged as foreign bleed from another workspace, verify relevance before adopting cross-project conventions.
3. **Sludge Tax**: Minimize duplicate `read_file` or verbose error traces to keep Signal Purity high (> 75%).
