import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const EXPERIMENT_DIR = __dirname;
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const RESULTS_DIR = path.join(EXPERIMENT_DIR, 'results');
export const RAW_RESULTS_DIR = path.join(RESULTS_DIR, 'raw');
export const TRANSCRIPTS_DIR = path.join(RAW_RESULTS_DIR, 'transcripts');

export const RUNTIME_ROOT = path.join(os.tmpdir(), 'claude-code-switch-benchmark-runtime');
export const CLI_DIR = path.join(RUNTIME_ROOT, 'cli');
export const CLAUDE_EXE = path.join(CLI_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
export const FROZEN_REPO_DIR = path.join(RUNTIME_ROOT, 'frozen-repo');
export const RUNS_WORK_DIR = path.join(RUNTIME_ROOT, 'runs');

export const PINNED_REPO_COMMIT = '19c51055902c545508af1979a392505355777d90';
export const PINNED_CLAUDE_CODE_VERSION = '2.1.325';
export const MAX_BUDGET_USD = 30.0;
export const PILOT_BUDGET_USD = 3.0;
export const ARM_E_IDLE_SECONDS = 330; // 5m 30s > 5m (300s) ephemeral TTL
export const REPLICATES_PER_ARM = 5;
export const RANDOM_SEED = 20261114;

export const MODEL_A_CLI = 'claude-opus-4-6';
export const MODEL_B_CLI = 'claude-sonnet-4-6';
export const EFFORT_BASELINE = 'medium';
export const EFFORT_SWITCHED = 'high';

export const OPENROUTER_MODEL_MAP = Object.freeze({
  'claude-opus-4-6': 'anthropic/claude-opus-4.6',
  'claude-opus-4-6[1m]': 'anthropic/claude-opus-4.6',
  'claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'claude-sonnet-4-6[1m]': 'anthropic/claude-sonnet-4.6',
  'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
  'claude-3-5-haiku-latest': 'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4.6': 'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
  'claude-opus-5-5': 'anthropic/claude-opus-5.5',
  'claude-opus-5-5[1m]': 'anthropic/claude-opus-5.5',
  'anthropic/claude-opus-5.5': 'anthropic/claude-opus-5.5',
  'claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5',
  'claude-sonnet-5-5[1m]': 'anthropic/claude-sonnet-5.5',
  'anthropic/claude-sonnet-5.5': 'anthropic/claude-sonnet-5.5',
  'claude-haiku-5-5': 'anthropic/claude-haiku-5.5',
  'anthropic/claude-haiku-5.5': 'anthropic/claude-haiku-5.5'
});

/**
 * Verified per-1M token USD pricing from OpenRouter /api/v1/models (1st-party Anthropic rates).
 */
export const PRICING_PER_1M = Object.freeze({
  'anthropic/claude-opus-4.6': Object.freeze({
    input: 5.0,
    output: 25.0,
    write5m: 6.25,
    write1h: 10.0,
    read: 0.5
  }),
  'anthropic/claude-sonnet-4.6': Object.freeze({
    input: 3.0,
    output: 15.0,
    write5m: 3.75,
    write1h: 6.0,
    read: 0.3
  }),
  'anthropic/claude-haiku-4.5': Object.freeze({
    input: 1.0,
    output: 5.0,
    write5m: 1.25,
    write1h: 2.0,
    read: 0.1
  }),
  'anthropic/claude-opus-5.5': Object.freeze({
    input: 4.0,
    output: 20.0,
    write5m: 5.0,
    write1h: 8.0,
    read: 0.2
  }),
  'anthropic/claude-sonnet-5.5': Object.freeze({
    input: 2.0,
    output: 10.0,
    write5m: 2.5,
    write1h: 4.0,
    read: 0.1
  }),
  'anthropic/claude-haiku-5.5': Object.freeze({
    input: 0.1,
    output: 0.5,
    write5m: 0.125,
    write1h: 0.2,
    read: 0.01
  })
});

export function mapCliModelToOpenRouter(model = '') {
  const m = String(model || '').trim();
  if (OPENROUTER_MODEL_MAP[m]) return OPENROUTER_MODEL_MAP[m];
  const lower = m.toLowerCase();
  if (lower.includes('opus-5-5') || lower.includes('opus-5.5')) return 'anthropic/claude-opus-5.5';
  if (lower.includes('sonnet-5-5') || lower.includes('sonnet-5.5')) return 'anthropic/claude-sonnet-5.5';
  if (lower.includes('haiku-5-5') || lower.includes('haiku-5.5')) return 'anthropic/claude-haiku-5.5';
  if (lower.includes('opus-4-6') || lower.includes('opus-4.6')) return 'anthropic/claude-opus-4.6';
  if (lower.includes('sonnet-4-6') || lower.includes('sonnet-4.6')) return 'anthropic/claude-sonnet-4.6';
  if (lower.includes('haiku')) return 'anthropic/claude-haiku-4.5';
  if (lower.includes('opus')) return 'anthropic/claude-opus-4.6';
  if (lower.includes('sonnet')) return 'anthropic/claude-sonnet-4.6';
  return 'anthropic/claude-sonnet-4.6';
}

export function normalizeModelShortName(model = '') {
  const mapped = mapCliModelToOpenRouter(model);
  if (mapped.includes('opus-5.5')) return 'opus-5.5';
  if (mapped.includes('sonnet-5.5')) return 'sonnet-5.5';
  if (mapped.includes('haiku-5.5')) return 'haiku-5.5';
  if (mapped.includes('opus')) return 'opus-4.6';
  if (mapped.includes('sonnet')) return 'sonnet-4.6';
  if (mapped.includes('haiku')) return 'haiku-4.5';
  return mapped;
}

export function loadOpenRouterApiKey() {
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  const envPath = path.join(REPO_ROOT, '.env.benchmark');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0 && trimmed.slice(0, eq).trim() === 'OPENROUTER_API_KEY') {
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (val) return val;
      }
    }
  }
  throw new Error('OPENROUTER_API_KEY not found in environment or .env.benchmark');
}

export function normalizeUsage(usage = {}) {
  const input_tokens = Number(usage.input_tokens || 0);
  const cache_creation_input_tokens = Number(usage.cache_creation_input_tokens || 0);
  const cache_read_input_tokens = Number(usage.cache_read_input_tokens || 0);
  const output_tokens = Number(usage.output_tokens || 0);
  const cc = usage.cache_creation || {};
  const ephemeral_5m_input_tokens = Number(cc.ephemeral_5m_input_tokens || 0);
  const ephemeral_1h_input_tokens = Number(cc.ephemeral_1h_input_tokens || 0);
  const total_input_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
  const cache_hit_ratio = total_input_tokens > 0 ? cache_read_input_tokens / total_input_tokens : 0;

  return {
    input_tokens,
    cache_creation_input_tokens,
    ephemeral_5m_input_tokens,
    ephemeral_1h_input_tokens,
    cache_read_input_tokens,
    output_tokens,
    total_input_tokens,
    cache_hit_ratio
  };
}

export function computeUsageCostUsd(modelId, rawUsage = {}) {
  const mapped = mapCliModelToOpenRouter(modelId);
  const rate = PRICING_PER_1M[mapped] || PRICING_PER_1M['anthropic/claude-sonnet-4.6'];
  const u = normalizeUsage(rawUsage);

  let write5mTokens = u.ephemeral_5m_input_tokens;
  let write1hTokens = u.ephemeral_1h_input_tokens;
  const detailedSum = write5mTokens + write1hTokens;
  if (detailedSum === 0 && u.cache_creation_input_tokens > 0) {
    write5mTokens = u.cache_creation_input_tokens;
  } else if (u.cache_creation_input_tokens > detailedSum) {
    write5mTokens += (u.cache_creation_input_tokens - detailedSum);
  }

  const uncachedCost = (u.input_tokens / 1e6) * rate.input;
  const write5mCost = (write5mTokens / 1e6) * rate.write5m;
  const write1hCost = (write1hTokens / 1e6) * rate.write1h;
  const readCost = (u.cache_read_input_tokens / 1e6) * rate.read;
  const outputCost = (u.output_tokens / 1e6) * rate.output;
  const totalCost = uncachedCost + write5mCost + write1hCost + readCost + outputCost;

  return {
    model: mapped,
    uncachedCostUsd: Number(uncachedCost.toFixed(8)),
    writeCostUsd: Number((write5mCost + write1hCost).toFixed(8)),
    readCostUsd: Number(readCost.toFixed(8)),
    outputCostUsd: Number(outputCost.toFixed(8)),
    totalCostUsd: Number(totalCost.toFixed(8))
  };
}

export const ARM_DEFINITIONS = Object.freeze({
  A: {
    code: 'A',
    name: 'Control',
    description: 'Opus 4.6 (medium effort) on all 12 turns',
    idleBeforeTurn6Sec: 0,
    schedule: Array.from({ length: 12 }, (_, idx) => ({
      turn: idx + 1,
      model: MODEL_A_CLI,
      effort: EFFORT_BASELINE
    }))
  },
  B: {
    code: 'B',
    name: 'One Switch',
    description: 'Opus 4.6 T1-T5 -> Sonnet 4.6 T6-T12 (medium effort)',
    idleBeforeTurn6Sec: 0,
    schedule: Array.from({ length: 12 }, (_, idx) => {
      const turn = idx + 1;
      return {
        turn,
        model: turn <= 5 ? MODEL_A_CLI : MODEL_B_CLI,
        effort: EFFORT_BASELINE
      };
    })
  },
  C: {
    code: 'C',
    name: 'Switch & Back',
    description: 'Opus 4.6 T1-T5 -> Sonnet 4.6 T6-T7 -> Opus 4.6 T8-T12 (medium effort)',
    idleBeforeTurn6Sec: 0,
    schedule: Array.from({ length: 12 }, (_, idx) => {
      const turn = idx + 1;
      const model = (turn === 6 || turn === 7) ? MODEL_B_CLI : MODEL_A_CLI;
      return { turn, model, effort: EFFORT_BASELINE };
    })
  },
  D: {
    code: 'D',
    name: 'Effort Only',
    description: 'Opus 4.6 throughout; medium T1-T5 -> high T6-T12',
    idleBeforeTurn6Sec: 0,
    schedule: Array.from({ length: 12 }, (_, idx) => {
      const turn = idx + 1;
      return {
        turn,
        model: MODEL_A_CLI,
        effort: turn <= 5 ? EFFORT_BASELINE : EFFORT_SWITCHED
      };
    })
  },
  E: {
    code: 'E',
    name: 'Idle > TTL + Switch',
    description: 'Opus 4.6 T1-T5 -> 330s idle past 5m TTL -> Sonnet 4.6 T6-T12',
    idleBeforeTurn6Sec: ARM_E_IDLE_SECONDS,
    schedule: Array.from({ length: 12 }, (_, idx) => {
      const turn = idx + 1;
      return {
        turn,
        model: turn <= 5 ? MODEL_A_CLI : MODEL_B_CLI,
        effort: EFFORT_BASELINE
      };
    })
  },
  F: {
    code: 'F',
    name: 'Ten Switches',
    description: 'Alternate Opus <-> Sonnet on T1-T11 (10 switches), Opus on T12',
    idleBeforeTurn6Sec: 0,
    schedule: Array.from({ length: 12 }, (_, idx) => {
      const turn = idx + 1;
      // T1:A, T2:B(sw1), T3:A(sw2), ..., T10:B(sw9), T11:A(sw10), T12:A(hold)
      const model = (turn <= 11 && turn % 2 === 0) ? MODEL_B_CLI : MODEL_A_CLI;
      return { turn, model, effort: EFFORT_BASELINE };
    })
  }
});

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildPilotSchedule() {
  return [
    {
      runId: 'PILOT_A_S_r01',
      arm: 'A',
      tier: 'small',
      replicate: 1,
      turnsToRun: 6,
      schedule: ARM_DEFINITIONS.A.schedule.slice(0, 6),
      idleBeforeTurn6Sec: 0
    },
    {
      runId: 'PILOT_C_S_r01',
      arm: 'C',
      tier: 'small',
      replicate: 1,
      turnsToRun: 8,
      schedule: ARM_DEFINITIONS.C.schedule.slice(0, 8),
      idleBeforeTurn6Sec: 0
    },
    {
      runId: 'PILOT_D_S_r01',
      arm: 'D',
      tier: 'small',
      replicate: 1,
      turnsToRun: 7,
      schedule: ARM_DEFINITIONS.D.schedule.slice(0, 7),
      idleBeforeTurn6Sec: 0
    },
    {
      runId: 'PILOT_B_L_r01',
      arm: 'B',
      tier: 'large',
      replicate: 1,
      turnsToRun: 7,
      schedule: ARM_DEFINITIONS.B.schedule.slice(0, 7),
      idleBeforeTurn6Sec: 0
    }
  ];
}

export function buildFullSchedule(seed = RANDOM_SEED, replicates = REPLICATES_PER_ARM) {
  const cells = [
    { arm: 'A', tier: 'small' },
    { arm: 'B', tier: 'small' },
    { arm: 'C', tier: 'small' },
    { arm: 'D', tier: 'small' },
    { arm: 'E', tier: 'small' },
    { arm: 'F', tier: 'small' },
    { arm: 'A', tier: 'large' },
    { arm: 'B', tier: 'large' },
    { arm: 'F', tier: 'large' }
  ];

  const runs = [];
  for (const cell of cells) {
    const def = ARM_DEFINITIONS[cell.arm];
    for (let rep = 1; rep <= replicates; rep++) {
      const tierCode = cell.tier === 'small' ? 'S' : 'L';
      runs.push({
        runId: `${cell.arm}_${tierCode}_r${String(rep).padStart(2, '0')}`,
        arm: cell.arm,
        tier: cell.tier,
        replicate: rep,
        turnsToRun: 12,
        schedule: def.schedule,
        idleBeforeTurn6Sec: def.idleBeforeTurn6Sec
      });
    }
  }

  // Seeded Fisher-Yates randomization
  const rng = mulberry32(seed);
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }
  return runs.map((r, idx) => ({ ...r, orderIndex: idx + 1 }));
}
