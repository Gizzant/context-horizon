---
name: precheck
description: Analyze a prompt for best practices, context hygiene, and optimal Antigravity model/effort configuration before execution.
---

# Flight Check Prompt Precheck (`/precheck`)

The `/precheck` command evaluates draft user prompts, current context window health, and active attention hygiene to prevent token waste, prompt ambiguity, and server-side prefix amputation before spending high-effort quota.

## How It Works

1. **Context Telemetry Inspection:**
   Reads the local session sidecar at `~/.gemini/flightcheck/sessions/<conversationId>.sidecar.json` (<2ms) to extract:
   - 40-cell attention window (Signal Purity %, Sludge Tax $/turn, Amputation Risk).
   - 6 blind-spot hazards (`DIRTY_SNAP`, `SCHEMA_TAX`, `UNSEEN_CALLERS`, `LEGACY_POISON`, `QUOTA_AND_STREAM_SHIELD`, `LOOP_AND_GIT_GUARD`).
   - Active recency tail (`ACTIVE_SET`) vs stale reads (`STALE_DUP`).

2. **The 8-State Decision Rubric:**
   - `ALLOW_SILENT`: Prompt is clean, scoped, or prefixed with `!` / `!force`.
   - `ALLOW_ACTIVE_SET`: Explicit file tags omitted, but targets exist in Green `ACTIVE_SET`.
   - `ALLOW_PLAN_OR_SUBAGENT`: Session is actively in `/plan` mode or delegated to `invoke_subagent`.
   - `INJECT_CONTEXT_GUARD`: Injects background system guardrails for external file modifications or unseen importers.
   - `STEER_SUBAGENT`: Context is warm (>25k tokens, >70% Purity) on low/medium effort; delegates complex concurrency or architecture refactors to `invoke_subagent` to avoid wiping the KV cache.
   - `HALT_HYGIENE_OR_SAFETY`: Stops execution when Amputation risk is active (>140k tokens), Purity is <45% on high effort, 3-strike loops occur, or foreign KI memory is detected.
   - `HALT_EFFORT_OR_QUOTA`: Stops cold-cache pro/max overkill on trivial edits or when 5-hour quota drops below 10%.
   - `HALT_REWRITE_SCORECARD`: Formats the 4-Line Scorecard with an improved, scoped rewrite.

## Output Format: 4-Line Scorecard UX

```text
╭─ Flight Check v3.1 ──────────────────────────────────────────────────────────╮
│ 1. PROMPT : [Score XX/100] Scope: <ScopeStatus> | Target: <TargetFiles>     │
│ 2. HORIZON: [Purity: XX% | Sludge: +$0.XX/t | Tokens: XXk/200k | Quota: XX%]│
│ 3. ACTION : /model <recommended_model>  •  /effort <recommended_effort>     │
│ 4. REWRITE: "<copy-pasteable scoped prompt or remediation command>"          │
╰──────────────────────────────────────────────────────────────────────────────╯
Bypass once: prefix with `!`  •  Lock model/effort: include `!lock`
```

## Control Flags

- `! <prompt>` or `!force <prompt>`: Bypasses Flight Check gating for one turn.
- `!lock <prompt>`: Locks the current `/model` and `/effort` for the duration of the conversation.
- `#check <prompt>`: Forces Tier 2 semantic analysis, prompt scoring, and scorecard rewriting.
