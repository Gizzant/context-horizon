#!/usr/bin/env python3
"""Optional Stage 2 Dual-Platform RSL Distiller via Google Antigravity Python SDK."""
import asyncio
import json
import pathlib
import sys
from typing import Literal

try:
    import pydantic
    from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
    from google.antigravity.types import BuiltinTools
except ImportError as exc:
    sys.stderr.write(f"google-antigravity SDK or pydantic unavailable: {exc}\n")
    sys.exit(2)


class LearnedHeuristic(pydantic.BaseModel):
    carrier: Literal["rule_glob", "rule_model_decision", "skill_workflow", "pre_tool_hook"]
    slug: str = pydantic.Field(description="Lowercase kebab-case identifier, e.g. prisma-migration-order")
    description: str = pydantic.Field(description="Third-person summary with 'Use when...' and 'Do not use...'")
    globs: str = pydantic.Field(default="", description="Comma-separated globs if carrier is rule_glob")
    paths: list[str] = pydantic.Field(default_factory=list, description="Array of path globs for Claude rules")
    when_condition: str = pydantic.Field(description="Exact task, tool, or error signature where this applies")
    then_guidance: str = pydantic.Field(description="Concise actionable instruction or step-by-step protocol")
    steps: list[str] = pydantic.Field(default_factory=list, description="Ordered workflow steps for skill_workflow")
    evidence_step_ids: list[int] = pydantic.Field(default_factory=list)


class PostMortemReport(pydantic.BaseModel):
    is_valid_learning: bool = pydantic.Field(
        description="False if fix was a one-off typo, reward hack, or speculative over-engineering"
    )
    heuristics: list[LearnedHeuristic] = pydantic.Field(default_factory=list)


async def run_distillation(digest_path: pathlib.Path) -> None:
    digest = json.loads(digest_path.read_text(encoding="utf-8"))
    if digest.get("tainted") or digest.get("status") == "TAINTED_REWARD_HACK":
        print(json.dumps({"is_valid_learning": False, "heuristics": []}))
        return

    config = LocalAgentConfig(
        response_schema=PostMortemReport,
        capabilities=CapabilitiesConfig(enabled_tools=BuiltinTools.read_only()),
    )
    prompt = (
        "Analyze this contrastive session post-mortem digest. "
        "Extract Failure Heuristics as 'rule_glob' or 'rule_model_decision', "
        "proven multi-step workflows as 'skill_workflow', and repeat zero-exception bans as 'pre_tool_hook'. "
        "Reject one-off syntax typos, hardcoded test bypasses, or speculative abstractions.\n\n"
        f"DIGEST:\n{json.dumps(digest, indent=2)}"
    )
    async with Agent(config) as agent:
        response = await agent.chat(prompt)
        report = await response.structured_output()
        if hasattr(report, "model_dump"):
            payload = report.model_dump()
        elif isinstance(report, dict):
            payload = report
        else:
            payload = {"is_valid_learning": False, "heuristics": []}
        print(json.dumps(payload))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: rsl_sdk_distiller.py <digest.json>\n")
        sys.exit(1)
    asyncio.run(run_distillation(pathlib.Path(sys.argv[1])))
