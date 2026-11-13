#!/usr/bin/env node
/**
 * @file scripts/bench_hooks.mjs
 * Reproducible Two-Tier Hook Latency Benchmark for Highbeam (`ISS-030`).
 *
 * Separately measures:
 *   1. Tier-1 In-Process V8 Mod evaluation (`hooks/register.js` `tool.call` + `ui.render`, target `< 0.1ms`)
 *   2. Tier-2 Spawned Node ESM CLI Hook wall time (`child_process.spawnSync` `hooks/handlers/pre-tool-use.mjs`,
 *      reflecting `~5ms` minimal POSIX shell exec vs `~15-35ms` POSIX Node ESM cold-start vs `~40-90ms` Windows).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import register from '../hooks/register.js';
import { createInitialTelemetryState } from '../src/core-isomorphic/telemetry/telemetryBridge.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const PRE_TOOL_USE_HANDLER = path.join(PROJECT_ROOT, 'hooks', 'handlers', 'pre-tool-use.mjs');

/**
 * Computes percentile statistics from an array of millisecond durations.
 * @param {number[]} samples
 */
export function summarizeDurationsMs(samples = []) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (pct) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
    return Number(sorted[idx].toFixed(4));
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(4)),
    p50Ms: pick(50),
    p95Ms: pick(95),
    p99Ms: pick(99),
    maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
    meanMs: Number((sum / sorted.length).toFixed(4))
  };
}

/**
 * Runs both Tier-1 in-process V8 Mod and Tier-2 spawned Node ESM CLI hook benchmarks.
 *
 * @param {object} [options={}]
 * @param {number} [options.tier1Iterations=200]
 * @param {number} [options.tier1Warmup=50]
 * @param {number} [options.tier2Iterations=6]
 * @returns {Promise<{
 *   platform: string,
 *   nodeVersion: string,
 *   tier1ModToolCall: object,
 *   tier1ModUiRender: object,
 *   tier2CliPreToolUse: object
 * }>}
 */
export async function runHookLatencyBenchmark(options = {}) {
  const tier1Iterations = Math.max(10, Number(options.tier1Iterations ?? 200));
  const tier1Warmup = Math.max(5, Number(options.tier1Warmup ?? 50));
  const tier2Iterations = Math.max(1, Number(options.tier2Iterations ?? 6));

  const handlers = {};
  register((eventName, fn) => {
    handlers[eventName] = fn;
  });

  const store = new Map();
  const initialState = createInitialTelemetryState('bench-session', 'claude-opus-5-5');
  initialState.contextWindow.totalInputTokens = 85_000;
  initialState.contextWindow.cachedTokens = 80_000;
  initialState.contextWindow.cacheReadTokens = 80_000;
  initialState.promptCache.warm = true;
  initialState.promptCache.expiresAt = Date.now() + 240_000;
  store.set('ah_session_telemetry', initialState);

  const mockCtx = {
    store: {
      get: (k) => store.get(k),
      set: (k, v) => store.set(k, v)
    },
    ui: {
      invalidate: () => {},
      open: () => {}
    },
    clock: {
      every: () => () => {}
    }
  };

  const toolPayload = {
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' }
  };

  // Warmup Tier-1 V8 JIT
  for (let i = 0; i < tier1Warmup; i++) {
    await handlers['tool.call'](toolPayload, mockCtx, async () => undefined);
    await handlers['ui.render']({ component: 'AbovePrompt' }, mockCtx, async () => null);
  }

  const tier1ToolSamples = [];
  for (let i = 0; i < tier1Iterations; i++) {
    const t0 = performance.now();
    await handlers['tool.call'](toolPayload, mockCtx, async () => undefined);
    tier1ToolSamples.push(performance.now() - t0);
  }

  const tier1RenderSamples = [];
  for (let i = 0; i < tier1Iterations; i++) {
    const t0 = performance.now();
    await handlers['ui.render']({ component: 'AbovePrompt' }, mockCtx, async () => null);
    tier1RenderSamples.push(performance.now() - t0);
  }

  // Tier-2 End-to-End Spawned Node ESM CLI Hook (`child_process.spawnSync`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bench-'));
  const tier2Samples = [];
  const stdinJson = JSON.stringify({
    session_id: 'bench-cli',
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' }
  });

  try {
    for (let i = 0; i < tier2Iterations; i++) {
      const t0 = performance.now();
      const proc = spawnSync(process.execPath, [PRE_TOOL_USE_HANDLER], {
        cwd: tmpDir,
        input: stdinJson,
        encoding: 'utf8',
        timeout: 10_000
      });
      const elapsed = performance.now() - t0;
      if (proc.status !== 0) {
        throw new Error(`Tier-2 pre-tool-use exited with status ${proc.status}: ${proc.stderr}`);
      }
      tier2Samples.push(elapsed);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    platform: process.platform,
    nodeVersion: process.version,
    tier1ModToolCall: summarizeDurationsMs(tier1ToolSamples),
    tier1ModUiRender: summarizeDurationsMs(tier1RenderSamples),
    tier2CliPreToolUse: summarizeDurationsMs(tier2Samples)
  };
}

const isDirectCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCli) {
  const report = await runHookLatencyBenchmark();
  console.log('# Highbeam Two-Tier Hook Latency Benchmark');
  console.log(`Platform: ${report.platform} | Node: ${report.nodeVersion}\n`);
  console.log('| Execution Tier | Path | Samples | p50 (ms) | p95 (ms) | Mean (ms) | Reference Envelope |');
  console.log('| :--- | :--- | ---: | ---: | ---: | ---: | :--- |');
  console.log(
    `| Tier 1 In-Process Mod (\`tool.call\`) | \`hooks/register.js\` | ${report.tier1ModToolCall.count} | ${report.tier1ModToolCall.p50Ms} | ${report.tier1ModToolCall.p95Ms} | ${report.tier1ModToolCall.meanMs} | ~0.05ms (< 0.1ms in V8 memory) |`
  );
  console.log(
    `| Tier 1 In-Process Mod (\`ui.render\`) | \`hooks/register.js\` | ${report.tier1ModUiRender.count} | ${report.tier1ModUiRender.p50Ms} | ${report.tier1ModUiRender.p95Ms} | ${report.tier1ModUiRender.meanMs} | ~0.05ms (< 0.1ms in V8 memory) |`
  );
  console.log(
    `| Tier 2 Spawned ESM CLI (\`PreToolUse\`) | \`hooks/handlers/pre-tool-use.mjs\` | ${report.tier2CliPreToolUse.count} | ${report.tier2CliPreToolUse.p50Ms} | ${report.tier2CliPreToolUse.p95Ms} | ${report.tier2CliPreToolUse.meanMs} | ~5ms minimal POSIX shell / ~15-35ms POSIX Node ESM / ~40-90ms Win11 |`
  );
}
