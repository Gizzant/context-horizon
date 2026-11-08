# Known UI Anti-Patterns & Regression Guardrails

Reject any UI state or proposed fix that violates these rules:
1. Maximize Data-Ink Ratio: No decorative card wrappers, oversized padding, or multi-line headers where a single compact bar suffices.
2. Chrono-Attention Horizon: Keep primary capacity/horizon bar charts and Layer 1-6 telemetry visible at a glance without requiring hover states or modal clicks.
3. Compact Controls: Enforce compact button dimensions; never introduce large pill buttons or redundant confirmation dialogs that clash with high-density HUD layouts.
4. Contrast & Legibility: Do not use low-contrast muted grays for active telemetry numbers, root-cause diagnostics, or status badges.
