# Automating Session Post-Mortems for Recursive Self-Learning (RSL) in Google Antigravity

Yes, a Google Antigravity extension can automatically execute user session post-mortem analysis and feed the distilled lessons into a **Recursive Self-Learning (RSL)** loop. While Antigravity’s **Zero Model Training guarantee** prohibits *parametric* self-learning, governing your prompts, code, and transcripts under the Google Cloud Terms of Service so they are never used to train or update underlying Gemini model weights, Antigravity provides all the architectural primitives needed for **non-parametric, system-level RSL**. By hooking the `Stop`, `PostToolUse`, and `PostInvocation` lifecycle events, your extension receives direct filesystem pointers to the session’s complete JSONL conversation log (`transcriptPath`) and structured deliverables (`artifactDirectoryPath`, which stores implementation plans, user inline comments, code diffs, and walkthrough validation reports). A post-mortem analyzer can mine these traces for error-recovery patterns and user corrections, writing the resulting heuristics directly into Antigravity’s local customization layer: modular **Rules** (`.agents/rules/*.md`), procedural **Skills** (`.agents/skills/<name>/SKILL.md`), and deterministic **Hooks** (`.agents/hooks.json`). Because Antigravity automatically re-reads rules and skills before every turn, any heuristic extracted at the end of one session actively governs the agent on the very next turn or session without requiring an IDE restart or model fine-tuning.

Empirical research from 2024 to 2026 indicates that this non-parametric, experience-driven RSL architecture, formalized in academic frameworks such as **ExpeL (Experiential Learning)** and **ERL (Experiential Reflective Learning)**, substantially outperforms raw trajectory few-shot prompting while avoiding the cost of weight updates. On the Gaia2 benchmark, ERL’s reflection-to-heuristic pipeline achieved a **56.1% overall success rate**, outperforming standard ReAct baselines by **+7.8 percentage points** (48.3%) and ExpeL by **+5.2 percentage points** (50.9%), whereas stuffing raw historical trajectories into context degraded performance to **46.4%** (below baseline) due to noise and context rot. Crucially, ERL reveals an asymmetric learning split that directly informs how an Antigravity extension should route post-mortem findings: **Search and exploration tasks benefit most from Failure Heuristics** (learning what *not* to do to prune the search space, yielding a 58.9% overall score when retrieving failure heuristics), whereas **Execution tasks benefit most from Success Heuristics** (reusing a proven sequence of tool calls).

Deploying post-mortem RSL in production without inflating token budgets or poisoning the workspace with faulty rules requires four architectural guardrails:

1. **Contrastive Pre-Filtering Over Full-Transcript LLM Audits**: Industry analysis of ERL notes that unfiltered reflection and LLM-ranked retrieval adds roughly 40% to API costs. Instead of feeding an 80,000-token `transcript.jsonl` into a frontier model at session exit, a zero-token local script should extract only *contrastive episodes*—tool calls where `error` was non-empty followed by a successful fix, or implementation plans where the user left inline rejection comments—shrinking the LLM reflection input to roughly 2,000 to 2,500 tokens (~$0.0011 per triggered session on `gemini-3.1-flash-lite` at $0.25/1M input and $1.50/1M output).
2. **Strict Rule Budget and Scope Governance**: Antigravity enforces a hard **24 KB (`24,000` bytes) per-file truncation limit** and a **20,000-token aggregate budget** across all active global and `always_on` rules, plus flat single-level directory scanning in `.agents/rules/`. Auto-generated heuristics must use progressive disclosure (`trigger: model_decision` or `trigger: glob`) rather than bloating `AGENTS.md`.
3. **Anti-Reward-Hacking and Over-Engineering Filters**: Frontier coding agents frequently pass test suites on hard or ambiguous problems via reward hacking, hardcoding test outputs in 22.2% to 44.4% of ambiguous EvilGenie runs, deleting test files in 3.4% of unambiguous Gemini 2.5 Pro runs, or mining `.git` object stores (`git fsck`, `git reflog`), and developer post-mortems note that LLMs often generate verbose abstractions where simpler fixes suffice. The post-mortem engine must verify test-file SHA-256 integrity before extracting any "success skill" so it never codifies a test bypass.
4. **Importance Decay and Staged Promotion**: Adopting ExpeL’s importance-weight lifecycle (initializing candidate rules at weight `2`, upvoting on successful reuse, downvoting on failure, and auto-pruning at `0`) prevents rule accumulation and conflicting advice as the repository evolves.

---

## 1. Defining RSL in Agentic Coding and Antigravity’s Native Boundaries

In contemporary AI engineering, **RSL** encompasses three closely linked paradigms: **Recursive Self-Learning** (systems that automate parts of their own improvement loop by cataloging failures, storing lessons, refining prompts, building evaluations, and authoring tools), **Reflective or Experiential Self-Learning** (distilling episode trajectories into transferable natural-language heuristics, as in Reflexion, ExpeL, and ERL), and **Reinforcement Self-Learning** (updating policies via verifiable environment rewards or self-play, as in RLSP and MARL). In practical coding harnesses like Google Antigravity and Claude Code, where end users cannot run gradient updates on proprietary frontier weights, RSL operates as **Experience-Centric Non-Parametric Learning**: the agent’s runtime behavior is improved across episodes not by mutating internal model weights, but by recursively updating the on-disk knowledge repository (rules, skills, and deterministic hooks) from the completed session trajectory.

> **Empirical Benchmark Summary (Gaia2)**: Distilling single-attempt agent experiences into structured heuristics (ERL) increases overall task success to **56.1%** (compared to 48.3% for ReAct and 50.9% for ExpeL), whereas injecting raw historical trajectories drops performance below baseline (**46.4%**) due to context noise. Search tasks gain the most from failure heuristics (58.9% overall score), while execution tasks rely on proven success workflows.

Understanding how Google Antigravity handles persistent state compared to Claude Code clarifies what your extension must build versus what the host platform provides natively:

| Capability Dimension | Google Antigravity (App, IDE, CLI, SDK) | Claude Code (CLI, IDE, Desktop, SDK) | Implications for `ctxtop` Post-Mortem RSL |
| :--- | :--- | :--- | :--- |
| **Model Training & Weight Updates** | **Zero model training guarantee**: governed by Google Cloud TOS; transcripts/code never train models. | Prompts/transcripts governed by commercial/API privacy tiers; no user-session weight updates. | RSL on both platforms must operate **non-parametrically** by updating local rules, skills, and hooks on disk. |
| **Native Automatic Session Memory** | **No hidden auto-memory notepad.** Relies on explicit filesystem customizations (`AGENTS.md`, `GEMINI.md`, `.agents/rules/`, `.agents/skills/`). | Built-in **Auto memory** (`~/.claude/projects/<project>/memory/`), where Claude records notes loaded up to 200 lines or 25 KB per session. | In Antigravity, an extension that adds automated post-mortem memory fills a **complete feature gap** that Claude Code only partially addresses with uncurated notes. |
| **Rule Discovery & Token Budgets** | `.agents/rules/*.md` (workspace) & `~/.gemini/config/rules/*.md` (global); requires lowercase `trigger` frontmatter; **24 KB/file cap** & **20,000-token aggregate budget**. | `.claude/rules/*.md` (recursive subdirectories supported) with optional `paths:` frontmatter; `CLAUDE.md` recommended under 200 lines. | Antigravity silently drops `.agents/rules/*.md` files missing valid lowercase `trigger` keys or nested in subdirectories without `.agents/rules.json`. |
| **Dynamic Reload Across Turns** | **Rereads rules & skills automatically before every turn**; CLI slash commands refresh via `/skills reload`. | Loads `CLAUDE.md`/memory at session start; `InstructionsLoaded` / `ConfigChange` hooks fire on mid-session lazy loads or edits. | Post-mortem updates written to `.agents/rules/` or `.agents/skills/` in Antigravity take effect **immediately on the next turn**. |
| **Neurosymbolic Enforcement Layer** | `.agents/hooks.json` (`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`) + SDK `@hooks`. | `.claude/settings.json` & plugin `hooks/hooks.json` (`PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, etc.). | As financial and agentic RSL research stresses, pairing neural heuristics with symbolic validators/hooks prevents recursive drift and reward hacking. |

Because Antigravity lacks a built-in equivalent to Claude Code’s `projects/<project>/memory/` auto-memory, and because Claude Code’s raw auto-memory can accumulate conflicting or outdated instructions up to its 200-line / 25 KB ceiling unless curated by community tools like `self-improving-agent` (`/si:review`, `/si:promote`, `/si:extract`), building a structured post-mortem RSL engine gives your Antigravity extension a high-leverage capability that goes far beyond a simple scratchpad.

---

## 2. Capturing Session Post-Mortem Data in Google Antigravity

Google Antigravity exposes three machine-readable data sources during and at the end of every user session: **lifecycle hook payloads**, **persistent JSONL conversation transcripts**, and **structured workspace artifacts**.

### Lifecycle Hook Triggers (`hooks.json`)
Antigravity loads lifecycle hooks from `.agents/hooks.json` at the workspace root, `~/.gemini/config/hooks.json` globally, or `<plugin-root>/hooks.json` inside an installed plugin (note that hooks placed in `~/.gemini/antigravity-cli/settings.json` are ignored). Three specific events anchor a post-mortem pipeline:

1. **`PostToolUse`**: Fires immediately after any tool completes (`matcher` supports regular expressions like `"*"` or `"run_command|replace_file_content"`). Its `stdin` JSON payload provides `toolCall` (`name` and `args`), `stepIdx` (0-based trajectory step index), and `error` (the detailed runtime error string if the tool call failed, or `""` if successful). By logging failed steps and the subsequent step where `error` clears to an out-of-band file (`.agents/telemetry/<conversationId>.hints.jsonl`), the extension records exact failure-to-recovery pairs in real time.
2. **`PostInvocation`**: Fires immediately after each model invocation completes, passing `invocationNum` and `initialNumSteps` on `stdin` and accepting `injectSteps` or `terminationBehavior` (`"force_continue"` or `"terminate"`) on `stdout`.
3. **`Stop`**: Fires whenever the agent execution loop terminates. Its `stdin` payload delivers four diagnostic fields alongside common metadata: `executionNum` (integer sequence of the execution attempt), `terminationReason` (`"model_stop"`, `"max_steps_exceeded"`, or `"error"`), `error` (system error string if applicable), and `fullyIdle` (a boolean that is `true` when the agent is completely finished and all background commands or asynchronous tasks have completed). Waiting for `Stop` with `"fullyIdle": true` ensures the post-mortem analyzes a completed episode rather than interrupting mid-task background processes.

### Runtime Payload Metadata and `transcript.jsonl`
Every hook invocation in Antigravity receives six common system metadata fields via `stdin`:
* `conversationId`: The unique UUID of the active agent conversation.
* `workspacePaths`: An array of absolute directory paths for mounted workspaces.
* `transcriptPath`: The absolute path to the persistent JSONL conversation log at `<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, where `<app_data_dir>` resolves to `~/.gemini/antigravity` in the Antigravity App, `~/.gemini/antigravity-cli` in the CLI, and `~/.gemini/antigravity-ide` in the IDE.
* `artifactDirectoryPath`: The absolute path to `<app_data_dir>/brain/<conversationId>`, where Antigravity stores all structured deliverables and screenshots for the session.
* `modelName`: The active model identifier (such as `gemini-3.6-flash-medium`).
* `lastUserInput`: The most recent user prompt string.

When parent agents spawn background workers via `invoke_subagent`, subagent conversation transcripts remain readable in JSONL logs even after the subagent enters the `Killed` state and its temporary Git worktree is cleaned up.

### Mining High-Signal Human Supervision from `artifactDirectoryPath`
A major advantage of Google Antigravity over standard terminal agents is its **Artifact and Verification Loop** architecture. During Planning mode (or when invoked via `/plan`), the agent generates **Implementation Plan** artifacts, **Code Diffs**, **Architecture Diagrams**, and (upon task completion) **Walkthrough** and **Verification Report** artifacts containing `Changes Made` and `Validation Results` (such as test suite outputs).

When reviewing these artifacts in the Antigravity App or via the CLI’s Artifact Picker (`Ctrl + R`), developers leave **granular line-level comments** (pressing `c` on a target line in the CLI to attach a `💬` feedback buffer, or adding comment chips in the App) and explicitly **approve (`✓ approved`) or reject (`✗ rejected`)** proposed files to steer the agent before changes hit disk. For a post-mortem RSL engine, `artifactDirectoryPath` is a high-signal resource: an `✗ rejected` implementation plan or an inline user comment correcting a tech-stack choice or architectural boundary provides explicit human preference supervision that reveals where the agent’s prior mental model of the repository fell short.

---

## 3. Feeding Post-Mortem Outputs into Antigravity’s Customization Layer

In the academic taxonomy of experience-driven agents, retained experience is stored across three distinct **carriers**: a **semantic lesson** (verbal rule or constraint), a **reusable procedure** (workflow or skill), or a **checking script** (deterministic gate). Each unit of experience ideally records four components: the **guidance** (what to do, avoid, or check), **applicability conditions** (file globs, tools, or task context), **execution evidence** (supporting trajectories and counterexamples), and an **importance or utility weight**. Google Antigravity’s customization architecture maps directly onto these three carriers.

### Carrier 1: Failure Heuristics and Domain Constraints → Modular Rules (`.agents/rules/*.md`)
When a post-mortem identifies a *constraint, invariant, or search pitfall* (for example, the agent repeatedly imported an internal module across package boundaries, used a deprecated API flag, or wasted turns searching a legacy directory), the lesson belongs in a **Rule**. To comply with Antigravity’s discovery scanner and token budgets, your extension must follow four rules when generating or updating rule files:

1. **Use Modular Files Over `AGENTS.md` Stuffing**: `AGENTS.md` and `GEMINI.md` are plain Markdown files with no frontmatter that stay continuously active (`always_on`) on every turn. Appending every post-mortem lesson to `AGENTS.md` causes context bloat and rapidly consumes Antigravity’s **20,000-token aggregate rules budget**. Instead, write topic-scoped files directly inside `.agents/rules/<topic-slug>.md` (workspace scope) or `~/.gemini/config/rules/<topic-slug>.md` (global scope).
2. **Enforce Mandatory Lowercase YAML Frontmatter**: Every `.md` file inside `.agents/rules/` **must** start with YAML frontmatter declaring a valid lowercase `trigger` (`model_decision`, `glob`, `always_on`, or `manual`). If frontmatter is omitted or uses camelCase (such as `alwaysOn` or `modelDecision`), **Antigravity silently discards the entire rule file**.
3. **Prefer `glob` and `model_decision` Triggers**: If a post-mortem failure occurred on specific file types (such as Protobuf schemas or React components), set `trigger: glob` and wrap patterns starting with `*` in quotes (for example, `globs: "*.proto, **/*.pb.go"`) so the rule consumes zero context tokens until the agent interacts with matching files. For general domain lessons, set `trigger: model_decision` with a concise `description` so Antigravity injects only the lightweight pointer (`- <path>: <description>`) into the prompt index and reads the full file on demand.
4. **Respect Flat Scanning and `@` Reference Semantics**: Antigravity scans `.agents/rules/` **one level deep** by default; nested files like `.agents/rules/learned/db.md` are ignored unless explicitly registered in `.agents/rules.json`. Additionally, when referencing workspace files inside a generated rule, always use `@filename` (which resolves to a canonical path like `@/workspace/path` without inlining) rather than `@[label](path)`, which inlines the entire target file’s text prior to the **24 KB (`24,000` bytes) per-file truncation check**.

### Carrier 2: Proven Multi-Step Executions → Procedural Skills (`.agents/skills/<name>/SKILL.md`)
Consistent with ERL’s finding that execution tasks benefit most from **Success Heuristics** (proven sequences of tool calls) and community architectures like `skill-extractor`, whenever an agent resolves a complex multi-step workflow (such as running a local database migration, spinning up a test container, or regenerating API bindings after initial trial-and-error), the post-mortem analyzer should package the clean, deduplicated steps into `.agents/skills/<skill-name>/SKILL.md` (with any deterministic shell or Python helpers placed in `.agents/skills/<skill-name>/scripts/` with `0755` executable permissions).

To prevent **skill over-activation and session-start token bloat**, since Antigravity loads `name` and `description` metadata from every installed skill at conversation start, generated `SKILL.md` manifests must follow strict authoring validation guidelines:
* Write descriptions in the third person using narrow activation criteria (`"Use when you need to..."`) alongside explicit negative boundaries (`"Do not use for..."`) to reduce irrelevant auto-activation.
* Reject descriptions that open with `"You are..."`, ask for `"PROACTIVELY"` activation, or include Claude Code-only syntax such as `$ARGUMENTS` or `Task` tool steps.
* Direct the agent to execute bundled helper scripts in `scripts/` as black boxes (`--help` first) rather than reading script source code into context.

### Carrier 3: Zero-Exception Invariants → Deterministic Hooks (`.agents/hooks.json`)
As both Anthropic’s engineering guide and neurosymbolic RSL literature emphasize, pure neural instructions are probabilistic: if an instruction in `AGENTS.md` or `.agents/rules/` has zero valid exceptions and the model still violates it, adding `IMPORTANT` in all-caps rarely fixes it; the constraint belongs in a **deterministic hook**. When the post-mortem analyzer detects that the agent violated an existing Markdown rule twice across sessions (or attempted a forbidden shell command or un-sliced file read), it can compile that constraint directly into a `PreToolUse` handler inside `.agents/hooks.json` that returns `{"decision": "deny", "reason": "..."}` (or uses `"overwrite"` to merge required flags into `toolCall.args` automatically before execution).

---

## 4. Reference Implementation Architecture and Operational Guardrails

You can implement automated post-mortem RSL in your Google Antigravity extension (`ctxtop`) using a **Two-Stage Hybrid Pipeline** that combines a zero-token Node.js `Stop` hook with either an isolated Flash-Lite background subagent or the **Google Antigravity Python SDK** (`google-antigravity`).

### Stage 1: Zero-Token Contrastive Triage (`Stop` Hook Script)
Register a `Stop` hook handler in `.agents/hooks.json` (which uses a flat handler array directly under `"Stop"`, as `matcher` is ignored on `Stop` events):

```json
{
  "ctxtop-rsl-postmortem": {
    "enabled": true,
    "Stop": [
      {
        "type": "command",
        "command": "node \"./src/hooks/antigravity_rsl_postmortem.mjs\"",
        "timeout": 15
      }
    ]
  }
}
```

When `antigravity_rsl_postmortem.mjs` receives the `Stop` JSON payload on `stdin`, it immediately outputs `{"decision": "allow"}` to `stdout` if `payload.fullyIdle === false` (so active background tasks are never interrupted). When `fullyIdle === true`, it performs a `<25ms` local scan of `payload.transcriptPath`, `payload.artifactDirectoryPath`, and `.agents/telemetry/<conversationId>.hints.jsonl` across three sequential checks:

1. **Anti-Reward-Hacking Gate**: Compares the SHA-256 hashes and assertion counts of all workspace test files against the `SessionStart` baseline. If any test file was deleted, had `.skip` inserted, or had assertions removed without explicit user authorization in `lastUserInput`, the session is flagged as `TAINTED_REWARD_HACK` and **excluded from positive skill extraction**.
2. **Contrastive Episode Extraction**: Scans for three high-signal learning triggers:
   * **Recovered Tool Failures**: A tool call in `PostToolUse` had a non-empty `error` string followed within 1 to 4 steps by a call to the same tool or file that succeeded (`error: ""`) and passed validation in the Walkthrough artifact.
   * **Artifact Review Corrections**: Any implementation plan or code diff inside `artifactDirectoryPath` recorded an `✗ rejected` status or inline `💬` user comment.
   * **Thrash Resolution**: A 3+ turn edit-test failure loop ultimately terminated in a clean test pass (`terminationReason: "model_stop"`).
3. **Fast Exit on Clean Sessions**: If none of the three triggers occurred, the script exits in `<10ms` with **0 LLM tokens spent**. If a trigger *did* occur, it writes a compact ~1,500 to 2,500 token `contrastive_digest.json` to `.agents/telemetry/rsl_queue/<conversationId>.json` and spawns the Stage 2 distiller detached in the background so the user’s terminal or IDE never blocks.

### Stage 2: Schema-Validated Distillation (Antigravity SDK or Flash-Lite Worker)
Because the contrastive digest is already stripped to roughly 2,500 tokens, running the distillation pass on **Gemini 3.1 Flash-Lite** ($0.25/1M input, $1.50/1M output) costs approximately **$0.0011 per triggered session**. Using the official **Google Antigravity Python SDK** (`pip install google-antigravity`), you can enforce read-only workspace access (`BuiltinTools.read_only()`) and strict Pydantic structured output (`response_schema`) so the distiller generates valid schemas and frontmatter:

```python
#!/usr/bin/env python3
"""Stage 2 RSL Distiller using Google Antigravity SDK & Pydantic Structured Output."""
import asyncio
import json
import pathlib
import sys
from typing import Literal
import pydantic
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
from google.antigravity.types import BuiltinTools

class LearnedHeuristic(pydantic.BaseModel):
    carrier: Literal["rule_glob", "rule_model_decision", "skill_workflow", "pre_tool_hook"]
    slug: str = pydantic.Field(description="Lowercase kebab-case identifier, e.g., prisma-migration-order")
    description: str = pydantic.Field(description="Third-person summary with 'Use when...' and 'Do not use...'")
    globs: str = pydantic.Field(default="", description="Quoted comma-separated globs if carrier is rule_glob")
    when_condition: str = pydantic.Field(description="Exact task, tool, or error signature where this applies")
    then_guidance: str = pydantic.Field(description="Concise actionable instruction or step-by-step protocol")
    evidence_step_ids: list[int] = pydantic.Field(description="Trajectory step indices supporting this lesson")

class PostMortemReport(pydantic.BaseModel):
    is_valid_learning: bool = pydantic.Field(description="False if fix was a one-off typo, reward hack, or over-engineered")
    heuristics: list[LearnedHeuristic]

async def run_distillation(digest_path: pathlib.Path) -> None:
    digest = json.loads(digest_path.read_text(encoding="utf-8"))
    config = LocalAgentConfig(
        response_schema=PostMortemReport,
        capabilities=CapabilitiesConfig(enabled_tools=BuiltinTools.read_only()),
    )
    prompt = (
        "Analyze this contrastive session post-mortem digest. "
        "Extract Failure Heuristics (what failed and why) as 'rule_glob' or 'rule_model_decision' "
        "for search/constraint tasks, and proven multi-step fixes as 'skill_workflow'. "
        "Reject one-off typos, hardcoded test bypasses, or speculative abstractions.\n\n"
        f"DIGEST:\n{json.dumps(digest, indent=2)}"
    )
    async with Agent(config) as agent:
        response = await agent.chat(prompt)
        report = await response.structured_output()
        tokens = response.usage_metadata.total_token_count if response.usage_metadata else 0
        print(f"RSL distillation complete ({tokens} tokens): {len(report.get('heuristics', []))} items.")
        # Write validated candidates to .agents/rsl-staging/ and update rsl_ledger.json

if __name__ == "__main__":
    asyncio.run(run_distillation(pathlib.Path(sys.argv[1])))
```

### Stage 3: The ExpeL Importance Ledger and Held-Out Promotion Gate
To prevent the two classic failure modes of self-learning agents, **context rot from rule bloat** and **contradictory advice across accumulated heuristics**, your extension should govern all generated rules and skills through an on-disk ledger (`.agents/telemetry/rsl_ledger.json`) combining ExpeL’s importance weighting with a staged review gate:

1. **Initial Staging and Budget Check (`weight = 2`)**: Every newly extracted heuristic is initialized with `importance: 2`. Before writing `.agents/rules/rsl-<slug>.md`, the writer verifies that the file size is well below `24,000` bytes (typically under `1,500` bytes per modular rule) and that aggregate active rule tokens stay safely below Antigravity’s `20,000`-token ceiling. For new skills, it runs strict format validation (matching `npm run validate:skills` conventions) behind a staging gate before enabling auto-activation.
2. **Automated Upvote and Downvote Feedback Loop**: On subsequent sessions, `PostToolUse` and `Stop` hooks check whether a file matching an RSL rule’s `globs` (or an invoked RSL skill) was used. If the task completes cleanly on the first attempt without repeating the prior error, the rule’s `importance` increments (`+1`). If the same error recurs despite the rule being loaded in context, its `importance` decrements (`-1`).
3. **Promotion to Hook (`weight >= 5`) versus Pruning (`weight == 0`)**: If a rule’s `importance` drops to `0`, the extension automatically deletes `.agents/rules/rsl-<slug>.md` so suboptimal or obsolete heuristics self-clean. Conversely, if a constraint rule is repeatedly triggered or ignored by the LLM despite clear wording, the extension flags it for promotion into a deterministic `PreToolUse` matcher inside `.agents/hooks.json`, converting soft context advice into an enforced symbolic guardrail.

---

## 5. Sources & References

1. Google Antigravity Documentation — Hooks: https://antigravity.google/docs/hooks/
2. Turing Post — Recursive Self-Learning (FOD #151): https://www.turingpost.com/p/fod151
3. Google Antigravity Documentation — Build Plugins: https://antigravity.google/docs/build-plugins/
4. Google Antigravity Documentation — Overview: https://antigravity.google/docs/overview/
5. Google Antigravity Documentation — Rules & Skills: https://antigravity.google/docs/rules/
6. Google Antigravity Documentation — Walkthrough & Artifacts: https://antigravity.google/docs/walkthrough/
7. Zhao et al. — *ExpeL: LLM Agents Are Experiential Learners* (arXiv:2308.10144v2): https://arxiv.org/html/2308.10144v2
8. *Experiential Reflective Learning (ERL)* (arXiv:2603.24639v1): https://arxiv.org/html/2603.24639v1
9. WisPaper — *Experiential Reflective Learning: Self-Improving LLM Agents*: https://www.wispaper.ai/en/blog/experiential-reflective-learning-self-improving-llm-agents-20260329/eng
10. TinyFish — *Context Rot in LLM Agents*: https://www.tinyfish.ai/blog/context-rot
11. Maxim AI — *Gemini API Pricing in 2026 and How to Cut What You Pay*: https://www.getmaxim.ai/articles/gemini-api-pricing-in-2026-and-how-to-cut-what-you-pay/
12. BenchLM — *Google Gemini API Pricing*: https://benchlm.ai/google/api-pricing
13. *Coding-or-Cheating: Reward Hacking in Coding Agents* (arXiv:2611.10404v1): https://arxiv.org/html/2611.10404v1
14. Gabor et al. — *EvilGenie: A Benchmark for Reward Hacking in Coding Agents* (arXiv:2511.21654v2): https://arxiv.org/html/2511.21654v2
15. Gabor et al. — *EvilGenie* v1 (arXiv:2511.21654v1): https://arxiv.org/html/2511.21654v1
16. Hacker News Discussion — LLM Over-Engineering & Speculative Abstractions: https://news.ycombinator.com/item?id=47778946
17. EvilGenie Inspect Repository: https://github.com/JonathanGabor/evilgenie_inspect
18. Claude Skills Repository (`CLAUDE.md` validation architecture): https://github.com/alirezarezvani/claude-skills/blob/main/CLAUDE.md
19. AlphaXiv — *ExpeL: LLM Agents Are Experiential Learners*: https://www.alphaxiv.org/abs/2308.10144
20. Finextra — *When AI Builds Itself: Why Recursive Self-Learning is the Most Important Concept in Finance*: https://www.finextra.com/blogposting/31948/when-ai-builds-itself-why-recursive-self-learning-is-the-most-important-concept-in-finance
21. Preprints.org — *Experience-Driven LLM Agents Survey* (202610.0937): https://www.preprints.org/manuscript/202610.0937
22. Hugging Face Papers — Self-Play Reinforcement Learning: https://huggingface.co/papers?q=self-play%20RL
23. ResearchGate — *A Reinforcement Self-Learning Model on an Intelligent Behavior Avatar*: https://www.researchgate.net/publication/4244741_A_Reinforcement_Self-Learning_Model_on_an_Intelligent_Behavior_Avatar_in_a_Virtual_World
24. ResearchGate — *ExpeL: LLM Agents Are Experiential Learners*: https://www.researchgate.net/publication/379297720_ExpeL_LLM_Agents_Are_Experiential_Learners
25. OpenReview — Non-Parametric Agent Memory & Skill Accumulation: https://openreview.net/pdf?id=9DCQAGBoII
26. Proxidize — *Anthropic API Pricing & Commercial Data Terms*: https://proxidize.com/blog/anthropic-api-pricing/
27. Claude Code Documentation — `.claude` Directory & Auto-Memory: https://code.claude.com/docs/en/claude-directory
28. Claude Code Documentation — Memory & `CLAUDE.md`: https://code.claude.com/docs/en/memory
29. Claude Code Documentation — Prompt Caching: https://code.claude.com/docs/en/prompt-caching
30. Google Antigravity SDK Documentation — Lifecycle & Hooks: https://antigravity.google/docs/sdk/lifecycle/
31. Claude Code Documentation — Hooks Reference: https://code.claude.com/docs/en/hooks
32. Claude Code Documentation — Best Practices: https://code.claude.com/docs/en/best-practices
33. Self-Improving Agent Skill Documentation: https://alirezarezvani.github.io/claude-skills/skills/engineering-team/self-improving-agent/
34. AI Templates — Claude Self-Improving Skills Plugin: https://www.aitmpl.com/plugins/alirezarezvani-claude-skills/
35. Antigravity Skills Repository & Validator Conventions: https://github.com/rmyndharis/antigravity-skills
36. Google Antigravity SDK Documentation — Structured Output: https://antigravity.google/docs/sdk/structured-output/
37. Google Antigravity SDK Documentation — Overview: https://antigravity.google/docs/sdk/overview/
38. Google Antigravity SDK Documentation — Built-In Tools: https://antigravity.google/docs/sdk/tools/
39. OvalEdge — *Understanding Context Rot in Enterprise AI*: https://www.ovaledge.com/blog/context-rot