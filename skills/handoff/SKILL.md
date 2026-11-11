---
name: handoff
description: Audit and write a compressed, actionable task.md checkpoint before running /compact or handing off across sessions.
---

# Session Handoff & State Compression (`/handoff`)

The `/handoff` command audits the current session checkpoint in `task.md` (or `STATE.md`) to guarantee that all architectural decisions, active blockers, and immediate next steps are preserved before context compaction or session rotation.

## State Compressor Taxonomy

When writing or updating `task.md`, apply the **KEEP / DROP** filter:

### KEEP
- **Decisions:** Every architectural or design choice with a 1-sentence rationale and alternatives considered.
- **Blockers:** Active error loops or unresolved impediments with severity (`Low`, `Medium`, `High`) and context.
- **Artifacts:** Specific files created, modified, or deleted with explicit paths.
- **State Changes:** Milestone progress and deliverables verified.
- **Next Action:** Single, specific, unblocked next action with exact file target (`@file` or symbol).

### DROP
- **Reasoning Traces:** Exploration narratives ("I tried X, then Y, then Z worked — record only Z").
- **Dead-End Scaffolding:** Resolved temporary debug scripts and raw stack traces.
- **Vague Directives:** "Continue working", "Finish implementation", or "WIP".

## 5-Point Handoff Audit Checklist

1. **Next Action Clarity:** The first unchecked item `- [ ]` or `## Next Action` specifies an exact file target and concrete action verb.
2. **Incomplete Coverage:** In-progress items `[/]` document the specific files being modified.
3. **Blocker Accuracy:** Any unresolved command failures or error loops are recorded in `## Blockers`.
4. **Decision Completeness:** If the plan changed, the decision rationale is captured in `## Decisions`.
5. **Freshness:** `task.md` reflects the current user turn and latest verified state.

## Recommended Usage

1. Write or update `task.md`, `implementation_plan.md`, and `walkthrough.md` in the session brain directory using the State Compressor format, and verify working-tree git status (`git status --porcelain`).
2. Generate a structured Baton Pass handoff artifact (`docs/HANDOFF_<timestamp>.md`) via the Attention Horizon panel's **"Generate Handoff Markdown"** button (`POST /api/handoff/generate`) or run audit verification:
   ```bash
   node --no-warnings ./src/cli/init.mjs --demo
   ```
3. When the audit reports `CLEAN ✅` and the KV cache window is ready, advise the user with the parameterized compaction prompt:
   > Type `/compact` in the chat box and press Enter (preserving active exported symbols, `task.md` checklist state, and explicit in-chat constraints).
