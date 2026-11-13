---
name: evolve
description: Audit static AGENTS.md prefix bloat (>8,000 tokens), route post-skill corrections to domain SKILL.md files, and synthesize >=5 validated instincts via 1-click user diff approval gated by TurnZeroGate.
---

# Highbeam Prefix Diet & Skill Fault Router (`/evolve`)

Use `/evolve` when static workspace rules (`AGENTS.md` / `.agents/rules/*.md`) exceed the **8,000-token** static prefix budget, or after repeated domain corrections have accumulated at least **5 validated Atomic Instincts**.

## Guardrails & Execution Rules (`RSI-01`)
1. **Static Prefix Diet (`> 8,000` Tokens):**
   - Measure static rule overhead across `AGENTS.md` and `.agents/rules/*.md`.
   - When static overhead exceeds `8,000` tokens, propose extracting domain-specific sections into lazy-loaded `.agents/skills/<domain>/SKILL.md` bundles so Turn-0 prefix tokens stay lean.
2. **Skill Fault Delta Routing:**
   - When a user correction immediately follows an executed skill (`<skill-name>`), route the proposed rule delta to `.agents/skills/<skill-name>/SKILL.md` rather than polluting global `AGENTS.md`.
3. **5-Instinct Synthesis Floor & Zero Recursive Critique:**
   - Synthesize a new domain `SKILL.md` draft **only** when `>= 5` validated domain instincts exist (`confidence >= 0.55`, `harmful_count == 0`).
   - **Strictly forbidden:** Never spawn recursive LLM self-critique subagents during skill evolution.
4. **Mandatory 1-Click User Diff Approval + `TurnZeroGate`:**
   - Present a unified diff for explicit user approval before any file write.
   - Route approved writes exclusively through `TurnZeroGate` so `AGENTS.md` and active rule prefixes are never mutated while a session KV cache is warm.
