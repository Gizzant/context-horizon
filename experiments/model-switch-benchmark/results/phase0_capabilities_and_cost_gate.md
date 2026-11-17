# Phase 0 Capability Gate & Live Cost Estimate (`2026-11-15 UTC`)

## 1. Live Provider Catalogs & Balances (`$0` / `<$0.05` Probe Spend)

- **OpenRouter Account (`/api/v1/key`)**: HTTP `200` | Usage `$48.006627` | Limit `$200` | Remaining `$151.993373`
- **Direct Anthropic API (`/v1/models`)**: Configured=`true` | Authenticated=`true` | Method=`x-api-key` | Attempts=`[{"authMode":"x-api-key","statusCode":200,"errorPreview":null}]`
- **Gemini Key Probe**: Configured=`true` | Authenticated=`true` | WorkingEndpoint=`generativelanguage_v1beta_header` | Attempts=`[{"label":"generativelanguage_v1beta_header","statusCode":200,"errorPreview":null}]`
  - Gemini minimal explicit cache probe (`models/gemini-3.1-pro-preview`): HTTP `200`, `usageMetadata={"totalTokenCount":6001}`, `responseKeys=["name","model","createTime","updateTime","expireTime","displayName","usageMetadata"]`, deleted=`200`, error=`none`

### OpenRouter `anthropic/*` Models Returned (`GET /api/v1/models`)
| Model ID | Input / 1M | Output / 1M | Cache Write 5m / 1M | Cache Read / 1M |
| :--- | :---: | :---: | :---: | :---: |
| `anthropic/claude-fable-5.2` | `$8` | `$40` | `$10` | `$0.2` |
| `anthropic/claude-fable-5.2:batch` | `$4` | `$20` | `$5` | `$0.1` |
| `anthropic/claude-haiku-5.5` | `$0.1` | `$0.5` | `$0.125` | `$0.01` |
| `anthropic/claude-haiku-5.5:batch` | `$0.05` | `$0.25` | `$0.0625` | `$0.005` |
| `anthropic/claude-sonnet-5.5` | `$2` | `$10` | `$2.5` | `$0.1` |
| `anthropic/claude-sonnet-5.5:batch` | `$1` | `$5` | `$1.25` | `$0.05` |
| `anthropic/claude-opus-5.5` | `$4` | `$20` | `$5` | `$0.2` |
| `anthropic/claude-opus-5.5:batch` | `$2` | `$10` | `$2.5` | `$0.1` |
| `anthropic/claude-fable-5.1` | `$10` | `$50` | `$12.5` | `$0.25` |
| `anthropic/claude-fable-5.1:batch` | `$5` | `$25` | `$6.25` | `$0.125` |
| `anthropic/claude-opus-5` | `$5` | `$25` | `$6.25` | `$0.5` |
| `anthropic/claude-opus-5:batch` | `$2.5` | `$12.5` | `$3.125` | `$0.25` |
| `anthropic/claude-sonnet-5` | `$2` | `$10` | `$2.5` | `$0.2` |
| `anthropic/claude-fable-5` | `$10` | `$50` | `$12.5` | `$1` |
| `anthropic/claude-opus-4.8` | `$5` | `$25` | `$6.25` | `$0.5` |
| `anthropic/claude-opus-4.7` | `$5` | `$25` | `$6.25` | `$0.5` |
| `anthropic/claude-sonnet-4.6` | `$3` | `$15` | `$3.75` | `$0.3` |
| `anthropic/claude-opus-4.6` | `$5` | `$25` | `$6.25` | `$0.5` |
| `anthropic/claude-opus-4.5` | `$5` | `$25` | `$6.25` | `$0.5` |
| `anthropic/claude-haiku-4.5` | `$1` | `$5` | `$1.25` | `$0.1` |
| `anthropic/claude-sonnet-4.5` | `$3` | `$15` | `$3.75` | `$0.3` |
| `anthropic/claude-opus-4.1` | `$15` | `$75` | `$18.75` | `$1.5` |

### Direct Anthropic Models Returned (`GET /v1/models`)
- `claude-fable-5-2` (Claude Fable 5.2)
- `claude-haiku-5-5` (Claude Haiku 5.5)
- `claude-sonnet-5-5` (Claude Sonnet 5.5)
- `claude-opus-5-5` (Claude Opus 5.5)
- `claude-fable-5-1` (Claude Fable 5.1)
- `claude-opus-5` (Claude Opus 5)
- `claude-sonnet-5` (Claude Sonnet 5)
- `claude-fable-5` (Claude Fable 5)
- `claude-opus-4-8` (Claude Opus 4.8)
- `claude-opus-4-7` (Claude Opus 4.7)
- `claude-sonnet-4-6` (Claude Sonnet 4.6)
- `claude-opus-4-6` (Claude Opus 4.6)
- `claude-opus-4-5-20251101` (Claude Opus 4.5)
- `claude-haiku-4-5-20251001` (Claude Haiku 4.5)

## 2. Phase 0 Capability Matrix
| Feature | OpenRouter Status | Direct Anthropic Status | Classification / Impact |
| :--- | :--- | :--- | :--- |
| **Basic 5m Write/Read + Billed Cost** | HTTP `200`/`200`, `cost_source=billed`, readTok=`3150` | HTTP `200`/`200`, readTok=`4111` | `PASS` |
| **`max_tokens: 0` Pre-Warming** | HTTP `200`, warmCache=`true`, outTok=`9 / countProbeOut=116 (end_turn)`, err=`none` | HTTP `200`, outTok=`0`, works=`true`, followRead=`4103` | `DIRECT-API-ONLY` (OpenRouter does not enforce 0 output; `T4-P1`, `T3b KA-zero` on Direct API) |
| **`ttl: "1h"` + 5m/1h Split + 2x Rate** | HTTP `200`, 1hSplit=`true` (`5m=0`, `1h=3156`), billed=`$0.01905` vs comp1h=`$0.01905` | HTTP `200`, 1hSplit=`true` (`1h=4119`) | `PASS` |
| **`mid-conversation-output-config-2026-07-01`** | T1=`200`, T2=`400`, cacheRead=`0`, err=`{"type":"invalid_request_error","message":"Mid-conversation reasoning effort (configuration_update) is not supported on anthropic/claude-4.6-sonnet-20260217.","error_type":"invalid_request"}` | T1=`200`, T2=`200`, works=`true`, err=`none` | `R2` direct-API-only |
| **Claude Code `2.1.325` Custom Beta Header** | Baseline=`claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,thinking-token-count-2026-05-13,effort-2025-11-24` | CustomEnvForwarded=`false` | Local `$0` CLI inspection |

## 3. Recomputation of Cost Gate Table (Awaiting User Approval)

*Source & Date: Live OpenRouter `/api/v1/models` + Anthropic `/v1/models` on `2026-11-15 UTC`.*

| Test | Arm | Route | Pool | Model | Reps (`n`) | Expected / Rep | Expected Total | `3x` Abort Cap / Rep |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| `T4` | P0 (N=10 barrier) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.7590` | `$2.2770` | `$2.2770` |
| `T4` | P1 (N=10 max_tokens=0 primer) | `anthropic_direct` | `anthropic` | `claude-sonnet-4-6` | `3` | `$0.1440` | `$0.4320` | `$0.4320` |
| `T4` | P2 (N=10 max_tokens=1 primer) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1449` | `$0.4347` | `$0.4347` |
| `T4` | P3 (N=10 sequential) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1380` | `$0.4140` | `$0.4140` |
| `T4` | P0 (N=25 barrier) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `1` | `$1.8975` | `$1.8975` | `$5.6925` |
| `T4` | P1 (N=25 max_tokens=0 primer) | `anthropic_direct` | `anthropic` | `claude-sonnet-4-6` | `1` | `$0.2475` | `$0.2475` | `$0.7425` |
| `T6` | API:C (control) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1330` | `$0.3989` | `$0.3989` |
| `T6` | API:TS (drop 5 tools @T6, tools+sys+hist reset) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1855` | `$0.5564` | `$0.5564` |
| `T6` | API:TF (dynamic filter T2-T12) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.6066` | `$1.8198` | `$1.8198` |
| `T6` | API:TK (shuffle tool JSON keys @T6) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1855` | `$0.5564` | `$0.5564` |
| `T6` | API:TA (add 1 tool at end @T6) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1855` | `$0.5564` | `$0.5564` |
| `T6` | API:SY (edit system @T6, tools preserved) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1648` | `$0.4943` | `$0.4943` |
| `T6` | API:SRAG (system RAG every turn T2-T12) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.3884` | `$1.1653` | `$1.1653` |
| `T6` | API:MRAG (tail user RAG T2-T12) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1577` | `$0.4732` | `$0.4732` |
| `T6` | API:TSTUB (static stub + deferred schema @T6 tail) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.0957` | `$0.2872` | `$0.2872` |
| `T6` | API:ME (edit T2 msg @T6, tools+sys preserved) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1544` | `$0.4633` | `$0.4633` |
| `T6` | CC-T (mcp-config/allowedTools @T6) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1650` | `$0.4950` | `$0.4950` |
| `T6` | CC-M (CLAUDE.md @T6) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1650` | `$0.4950` | `$0.4950` |
| `T6` | CC-S (append-system-prompt @T6) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1650` | `$0.4950` | `$0.4950` |
| `T7` | S=10 (~600 rule tok + ~400 task) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1534` | `$0.4603` | `$0.4603` |
| `T7` | S=50 (~1,750 rule tok + ~400 task) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1643` | `$0.4930` | `$0.4930` |
| `T7` | S=100 (~3,100 rule tok + ~400 task) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.1771` | `$0.5312` | `$0.5312` |
| `T7` | S=250 (~7,200 rule tok + ~400 task) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.2158` | `$0.6475` | `$0.6475` |
| `T7` | S=500 (~14,000 rule tok + ~400 task) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.2801` | `$0.8402` | `$0.8402` |
| `T7 (Optional CC)` | CLAUDE.md S={10,100,500} x20 tasks | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `1` | `$2.2500` | `$2.2500` | `$6.7500` |
| `T5` | A (append-only reference) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.3319` | `$0.9956` | `$0.9956` |
| `T5` | B (sliding window 1 turn) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$1.2021` | `$3.6064` | `$3.6064` |
| `T5` | C (50% cliff) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.3950` | `$1.1848` | `$1.1848` |
| `T5` | D (prose summary <=500 tok) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.4232` | `$1.2694` | `$1.2694` |
| `T5` | E (cliff + structured STATE) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `3` | `$0.4112` | `$1.2334` | `$1.2334` |
| `T3a` | TTL5 (gaps 4m x3; 6,12,30m x3 miss; 62m x1 miss) | `openrouter` | `openrouter` | `sonnet-4.6` | `1` | `$1.7664` | `$1.7664` | `$5.2992` |
| `T3a` | TTL1H (gaps 4,6,12,30m x3 hit; 62m x1 miss) | `openrouter` | `openrouter` | `sonnet-4.6` | `1` | `$1.7754` | `$1.7754` | `$5.3262` |
| `T3b` | KA-read (6 pings @ 4.5m) | `openrouter` | `openrouter` | `anthropic/claude-sonnet-4.6` | `2` | `$0.1104` | `$0.2208` | `$0.3312` |
| `T3b` | KA-zero (6 max_tokens=0 pings @ 4.5m) | `anthropic_direct` | `anthropic` | `claude-sonnet-4-6` | `2` | `$0.1050` | `$0.2100` | `$0.3150` |
| `T3c` | Gemini explicit 32k 1h cache (0 vs 3 queries) | `gemini` | `gemini` | `models/gemini-3.1-pro-preview` | `1` | `$0.3500` | `$0.3500` | `$1.0500` |
| `R1` | M (Opus 4.6 all turns) | `openrouter` | `openrouter` | `anthropic/claude-opus-4.6` | `3` | `$0.1573` | `$0.4718` | `$0.4718` |
| `R1` | SW (Opus <-> Sonnet T7/T9/T11 ping-pong) | `openrouter` | `openrouter` | `opus-4.6 / sonnet-4.6` | `3` | `$0.2973` | `$0.8918` | `$0.8918` |
| `R1` | SC (Opus main + 3 isolated <1k Sonnet side calls) | `openrouter` | `openrouter` | `opus-4.6 + isolated sonnet` | `3` | `$0.1723` | `$0.5168` | `$0.5168` |
| `R2` | EF0..EF3 + 4.6 EF0/EF1 (claude-sonnet-5-5) | `anthropic_direct` | `anthropic` | `claude-sonnet-5-5` | `3` | `$0.4200` | `$1.2600` | `$1.2600` |
| `Optional 5.5 Currency` | Control / One-Switch / Effort-Only (5.5 pair) | `openrouter` | `openrouter` | `anthropic/claude-opus-5.5 + sonnet-5.5` | `3` | `$0.5827` | `$1.7483` | `$1.7483` |

- **OpenRouter Pool Expected Total**: `$34.18` (Remaining credit reported by OpenRouter: `$151.993373`)
- **Direct Anthropic Pool Expected Total**: `$2.15` (User stated cap: `$20.00`)
- **Gemini Pool Expected Total**: `$0.35` (User stated cap: `$25.00`)
- **Phase 0 Actual Probe Spend Recorded**: `$0.01361`
