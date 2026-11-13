# Benchmark Methodology: KV-Cache Economics & Context Hygiene in Claude Code

## 1. Objective

Evaluate the empirical cost, cache-hit preservation, and error-recovery fidelity of **Highbeam (`attention-horizon-claude`)** compared against:
1. **Uninstrumented Baseline**: Native Claude Code CLI without cache-gravity routing or `PostToolUse` sanitization.
2. **Passive Token Counters**: Status-bar token displays that sum raw JSONL `usage.input_tokens` without modeling Anthropic's 5-minute KV-cache TTL or cross-model cache isolation.
3. **Lossy Shell Wrapper Rewriters**: External `PreToolUse` command wrappers that rewrite `Bash`/`PowerShell` commands into truncated pipelines (`| head -n 50`, strip flags), risking dropped compiler errors and broken exit codes.

---

## 2. Anthropic KV-Cache Cost Physics Model

All benchmark calculations use exact Anthropic API billing equations across the four token categories:
- `input_tokens` ($I$): Uncached input beyond the last cache breakpoint ($1.0\times$ base input rate).
- `cache_creation.ephemeral_5m_input_tokens` ($W_{5\text{m}}$): 5-minute TTL cache write ($1.25\times$ base input rate).
- `cache_creation.ephemeral_1h_input_tokens` ($W_{1\text{h}}$): 1-hour TTL cache write ($2.0\times$ base input rate).
- `cache_read_input_tokens` ($R$): Warm cache hit ($0.025\times$ on Fable 5.2/5.1, $0.05\times$ on Opus 5.5 / Sonnet 5.5, $0.10\times$ on Haiku 5.5 / 4.x).
- `output_tokens` + `thinking_tokens` ($O$): Billed at model output rate.

### 2.1 Cross-Model Switch Break-Even Threshold ($C^*$)

Because Anthropic KV caches are strictly isolated per model ID, switching from model $A$ to model $B$ mid-session invalidates the warm cache prefix $C$ and triggers a cold $1.25\times$ write on model $B$:

$$C^* = \frac{O \cdot (P_{\text{out},A} - P_{\text{out},B})}{P_{\text{write5m},B} - P_{\text{read},A}}$$

- **Claude Opus 5.5 $\to$ Claude Sonnet 5.5** ($O = 1,500$ output tokens, $P_{\text{out,Opus5.5}} = \$20.00$, $P_{\text{out,Sonnet5.5}} = \$10.00$, $P_{\text{write5m,Sonnet5.5}} = \$2.50$, $P_{\text{read,Opus5.5}} = \$0.20$):
  $$C^* = \frac{1,500 \times (20.00 - 10.00)}{2.50 - 0.20} = \frac{15,000}{2.30} = 6,522\text{ cached tokens}$$
  Above $C^* = 6,522$ cached tokens, downshifting from a warm Opus 5.5 prefix to a cold Sonnet 5.5 prefix **increases** turn cost in USD.
- **Claude Opus 4.6 $\to$ Claude Sonnet 4.6** ($O = 1,500$ output tokens, $P_{\text{out,Opus4.6}} = \$25.00$, $P_{\text{out,Sonnet4.6}} = \$15.00$, $P_{\text{write5m,Sonnet4.6}} = \$3.75$, $P_{\text{read,Opus4.6}} = \$0.50$):
  $$C^* = \frac{1,500 \times (25.00 - 15.00)}{3.75 - 0.50} = \frac{15,000}{3.25} = 4,615\text{ cached tokens}$$

### 2.2 Claude Haiku 5.5 Rate Card & 100,000-Token $5\times$ Pricing Cliff

On `claude-haiku-5-5`, total prompt tokens ($I + W_{5\text{m}} + W_{1\text{h}} + R$) exceeding `100,000` incur a $5\times$ step-up across all billing categories:
- **Up to `100,000` total prompt tokens:** Input `$0.10/M`, Output `$0.50/M`, 5m Cache Write `$0.125/M` ($1.25\times$), 1h Cache Write `$0.20/M` ($2.0\times$), Cache Read `$0.01/M` ($0.10\times$).
- **Above `100,000` total prompt tokens ($5\times$ cliff):** Input `$0.50/M`, Output `$2.50/M`, 5m Cache Write `$0.625/M`, 1h Cache Write `$1.00/M`, Cache Read `$0.05/M`.
- `DET-12` triggers a pre-cliff compaction advisory at `90,000` total prompt tokens (`90%` of the cliff boundary) and gates at `98,000` tokens.

### 2.3 Two-Tier Hook Execution Latency

| Execution Tier | Runtime Mechanism | Typical Latency |
| :--- | :--- | :--- |
| **Tier 1: In-Process Mod (`hooks/register.js`)** | Runs directly inside the host V8 isolate (`turn.step`, `turn.complete`, `ui.render`, `$.clock.every`) | **`~0.05ms` (`50µs`, `< 0.1ms` p95)** in-memory |
| **Tier 2: External Command Hooks (`hooks/handlers/*.mjs`)** | Spawns a Node.js child process reading event JSON on `stdin` and emitting `hookSpecificOutput` on `stdout` (`~5ms` minimal POSIX shell exec overhead + Node ESM cold-start) | **`~15–35ms`** Node ESM CLI cold-start (POSIX `Bash`, vs `~5ms` minimal POSIX shell) / **`~40–90ms`** (Windows 11 `PowerShell`) |

---

## 3. Reproducible Benchmark Suite

Run the deterministic verification suite and live Tier-1 / Tier-2 latency benchmark directly via Node.js (`>= 20.0.0`, 0 external dependencies):

```bash
node --test
node scripts/bench_hooks.mjs
```

### Verified Invariants Covered by Automated Tests
| Benchmark Dimension | Verification File | Target Metric |
| :--- | :--- | :--- |
| Algebraic Break-Even ($C^*$) & Haiku 100k Cliff | `test/phase2_cache_physics.test.mjs` | Exact match ($C^* = 6,522$ / $4,615$; $5\times$ cliff above 100k) |
| Exact USD Cache ROI (`0.263` 5m / `1.053` 1h) | `test/phase2_cache_physics.test.mjs` | Zero false-positive Negative ROI alerts on warm prefixes |
| Lossless `PostToolUse` Error Survival | `test/phase3_breakers_sanitizer_baton.test.mjs` | `100%` survival of `CRITICAL_ERROR_REGEX` lines; `0%` `Read` offloading |
| `DET-01..20` Circuit Breakers (`Bash\|PowerShell`) | `test/phase3_breakers_sanitizer_baton.test.mjs` | `100%` block on `--no-verify` (`-amn`); `0%` false positives on commit messages |
| Multi-Surface UI (`80` / `110` / `144` cols) | `test/phase4_ui_surfaces.test.mjs` | `visibleLength <= columns`; strict 5-Box Simple View hierarchy |
| Claude Code Mod Static-Analyzer Compliance | `test/mod_static_compliance.test.mjs` | `0` violations across `hooks/` and `src/` |
