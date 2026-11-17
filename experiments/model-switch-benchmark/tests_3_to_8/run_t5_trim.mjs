#!/usr/bin/env node
/**
 * T5: History Trimming & Constraint Retention (Item 5 of Cost Optimization Anti-Patterns)
 *
 * - 30-turn scripted session on anthropic/claude-sonnet-4.6 (OpenRouter, n=3 concurrent per arm)
 * - Static tools6 + expanded system prefix (~2.8k tokens > 1,024 cache min) so sliding window
 *   still hits the static top prefix rather than an artificial 0% hit rate.
 * - Artificial prompt budget W = 24,000 tokens; each turn pastes ~1,000 corpus tokens so
 *   trimming triggers around turn 20.
 * - 5 negative constraints planted in T2-T6:
 *     T2: port 9411 only (never 8080)
 *     T3: header X-Session-Guard: strict-v2 (never Authorization: Bearer / X-Api-Key)
 *     T4: error constant ERR_CHUNK_SPLIT (never ERR_RETRY_LOOP)
 *     T5: override file overrides.local.mjs (never config.default.mjs)
 *     T6: pragma // @strict-tabs (never eslint-disable)
 * - 5 natural bait prompts in T24, T25, T26, T28, T30 checked deterministically.
 * - Arms:
 *     A: Append-only control (exceeds W)
 *     B: Sliding window (drop oldest pair each turn once > W)
 *     C: 50% Cliff (drop oldest 50% of completed pairs in one batch once > W)
 *     D: Prose Summary (summarize oldest 50% in <=500 tok via API; summary cost + size recorded)
 *     E: 50% Cliff + structured STATE block in system[1] updated ONLY at the cliff (API cost recorded)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  STANDARD_CSV_COLUMNS,
  RESULTS_DIR,
  createRepNonce,
  injectNonceAndBreakpoints,
  loadBenchmarkKeys,
  loadPinnedCorpusSlice,
  loadRateCard,
  sendMessagesCall,
  RunBudgetTracker,
  summarizeMedianRange,
  wilson95,
  writeCsv,
  assertNoSensitiveLeaks,
  redactSensitiveText
} from './prefix_lab.mjs';
import { buildT6ToolCatalog } from './t6_fixtures.mjs';

const CHECKPOINT_PATH = path.join(RESULTS_DIR, 'raw', 't5_checkpoint_rows.jsonl');
const CSV_OUT_PATH = path.join(RESULTS_DIR, 't5_trim.csv');
const SUMMARY_OUT_PATH = path.join(RESULTS_DIR, 't5_summary.json');

const BUDGET_W = 24000;
const ARMS = ['A', 'B', 'C', 'D', 'E'];
const REPS = [1, 2, 3];

const T5_CSV_COLUMNS = [
  ...STANDARD_CSV_COLUMNS,
  'row_kind',
  'prompt_token_estimate',
  'trim_event',
  'evicted_pairs_count',
  'active_history_pairs',
  'constraint_id',
  'constraint_passed',
  'constraint_violated',
  'session_key'
];

export const CONSTRAINTS = [
  {
    id: 'C1_PORT_9411',
    plantTurn: 2,
    baitTurn: 24,
    plantText: 'Mandatory project rule [C1]: Production telemetry servers in this codebase must NEVER listen on port 8080 or 3000; ALWAYS bind strictly to port 9411 (`listen(9411)`). Acknowledge this rule briefly.',
    baitPrompt: 'Based strictly on the project rules established earlier in this session, write the exact single Node configuration call (`listen(...)`) and port number for our telemetry server. State only the compliant call and brief reason; do not mention forbidden port numbers.',
    check(text) {
      const s = String(text || '');
      const hasReq = /\b9411\b/.test(s);
      const hasForbidden = /\b8080\b/.test(s);
      return { passed: hasReq && !hasForbidden, violated: hasForbidden || !hasReq, detail: { hasReq, hasForbidden } };
    }
  },
  {
    id: 'C2_HEADER_GUARD',
    plantTurn: 3,
    baitTurn: 25,
    plantText: 'Mandatory project rule [C2]: Internal service middleware must NEVER use `Authorization: Bearer` or `X-Api-Key`; ALWAYS require the custom header `X-Session-Guard: strict-v2`. Acknowledge this rule briefly.',
    baitPrompt: 'Based strictly on the project rules established earlier in this session, provide the exact HTTP request header name and value required for internal telemetry service calls. State only the compliant header and brief reason; do not output banned header names.',
    check(text) {
      const s = String(text || '');
      const hasReq = /X-Session-Guard:\s*strict-v2/i.test(s);
      const hasForbidden = /Authorization:\s*Bearer|\bX-Api-Key\b/i.test(s);
      return { passed: hasReq && !hasForbidden, violated: hasForbidden || !hasReq, detail: { hasReq, hasForbidden } };
    }
  },
  {
    id: 'C3_ERR_CHUNK',
    plantTurn: 4,
    baitTurn: 26,
    plantText: 'Mandatory project rule [C3]: Retry approach `ERR_RETRY_LOOP` was permanently ruled out in postmortem; modules must ALWAYS throw fatal constant `ERR_CHUNK_SPLIT` instead. Acknowledge this rule briefly.',
    baitPrompt: 'Based strictly on the project rules established earlier in this session, name the exact fatal error constant string that the retry boundary must throw when a payload stalls. State only the compliant constant and brief reason; omit ruled-out constant names.',
    check(text) {
      const s = String(text || '');
      const hasReq = /\bERR_CHUNK_SPLIT\b/.test(s);
      const hasForbidden = /\bERR_RETRY_LOOP\b/.test(s);
      return { passed: hasReq && !hasForbidden, violated: hasForbidden || !hasReq, detail: { hasReq, hasForbidden } };
    }
  },
  {
    id: 'C4_OVERRIDE_FILE',
    plantTurn: 5,
    baitTurn: 28,
    plantText: 'Mandatory project rule [C4]: Never edit or recommend editing `config.default.mjs`; ALL custom runtime timeout overrides in this repository go strictly into `overrides.local.mjs`. Acknowledge this rule briefly.',
    baitPrompt: 'Based strictly on the project rules established earlier in this session, name the exact override file a developer must edit to change runtime timeout settings. State only the compliant filename and brief reason; do not mention forbidden filenames.',
    check(text) {
      const s = String(text || '');
      const hasReq = /\boverrides\.local\.mjs\b/.test(s);
      const hasForbidden = /\bconfig\.default\.mjs\b/.test(s);
      return { passed: hasReq && !hasForbidden, violated: hasForbidden || !hasReq, detail: { hasReq, hasForbidden } };
    }
  },
  {
    id: 'C5_PRAGMA_TABS',
    plantTurn: 6,
    baitTurn: 30,
    plantText: 'Mandatory project rule [C5]: Every new module header must start with the exact pragma `// @strict-tabs` and must NEVER include `eslint-disable` comments. Acknowledge this rule briefly.',
    baitPrompt: 'Based strictly on the project rules established earlier in this session, write the exact top-of-file formatting pragma comment line required for any new module here. State only the compliant comment pragma and brief reason; do not include banned directives.',
    check(text) {
      const s = String(text || '');
      const hasReq = /\/\/\s*@strict-tabs\b/.test(s);
      const hasForbidden = /eslint-disable/i.test(s);
      return { passed: hasReq && !hasForbidden, violated: hasForbidden || !hasReq, detail: { hasReq, hasForbidden } };
    }
  }
];

function getExtraSecrets(keys) {
  return [
    keys.OPENROUTER_API_KEY,
    keys.ANTHROPIC_API_KEY,
    keys.GEMINI_BENCHMARK_API_KEY,
    keys.ENV_GEMINI_API_KEY
  ].filter(Boolean);
}

function loadCheckpoints() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return [];
  const raw = fs.readFileSync(CHECKPOINT_PATH, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch {}
  }
  return entries;
}

function appendCheckpoint(entry, extraSecrets) {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  const serialized = JSON.stringify(entry);
  assertNoSensitiveLeaks(serialized, 't5_checkpoint_entry', extraSecrets);
  fs.appendFileSync(CHECKPOINT_PATH, `${serialized}\n`, 'utf8');
}

function estimateTokensApprox(text) {
  return Math.ceil(Buffer.byteLength(String(text || ''), 'utf8') / 3.8);
}

function buildStaticPrefixAssets() {
  const tools6 = buildT6ToolCatalog({ shuffled: false }).slice(0, 6);
  const sysGuideSlice = loadPinnedCorpusSlice('src/core-isomorphic/economics/billingBlocks.mjs', 1, 95);
  const baseSystemText = [
    'You are a principal telemetry and runtime architecture reviewer conducting a 30-turn code inspection session.',
    'Keep every answer crisp, technically grounded, and compliant with ALL project constraints established by the user.',
    'Do not call external tools unless strictly necessary; focus on concise architectural reasoning over the pasted code excerpts.',
    '',
    '// Reference invariant baseline module (static session handbook):',
    sysGuideSlice
  ].join('\n');
  return { tools6, baseSystemText, toolsJsonStr: JSON.stringify(tools6) };
}

function build30CorpusSlices() {
  const sources = [
    ['src/core/parser.mjs', 1, 2200],
    ['src/core/quota.mjs', 1, 2200],
    ['src/core/classifier.mjs', 1, 2200],
    ['src/core-isomorphic/guards/circuitBreakers.mjs', 1, 1400],
    ['src/core/compaction_coach.mjs', 1, 1200]
  ];
  const combinedLines = [];
  for (const [relPath, s, e] of sources) {
    try {
      const txt = loadPinnedCorpusSlice(relPath, s, e);
      if (txt) {
        for (const line of txt.split(/\r?\n/)) {
          combinedLines.push(line);
        }
      }
    } catch {
      // ignore
    }
  }

  // ~3,700 chars (~980-1,020 corpus tokens/turn) + ~2.8k static tools+sys -> ~24k around turn 20
  const targetChars = 3700;
  const slices = [];
  let lineIdx = 0;
  for (let turn = 1; turn <= 30; turn += 1) {
    const buf = [`// Turn ${turn} source excerpt (chunk #${turn})`];
    let len = buf[0].length;
    while (len < targetChars) {
      const line = combinedLines[lineIdx % combinedLines.length];
      buf.push(line);
      len += line.length + 1;
      lineIdx += 1;
    }
    slices.push(buf.join('\n'));
  }
  return slices;
}

function buildTurnUserPrompt(turn, corpusSlice) {
  const planted = CONSTRAINTS.find((c) => c.plantTurn === turn);
  const bait = CONSTRAINTS.find((c) => c.baitTurn === turn);
  if (planted) {
    return `${planted.plantText}\n\nReference code slice for turn ${turn}:\n\`\`\`js\n${corpusSlice}\n\`\`\`\nBriefly summarize the main responsibility in the code above while confirming the mandatory rule.`;
  }
  if (bait) {
    return `Reference code slice for turn ${turn}:\n\`\`\`js\n${corpusSlice}\n\`\`\`\nQuestion: ${bait.baitPrompt}`;
  }
  return `Reference code slice for turn ${turn}:\n\`\`\`js\n${corpusSlice}\n\`\`\`\nIn 2 concise sentences, describe one key state invariant or helper in this slice.`;
}

function flattenPairsToMessages(pairs) {
  const msgs = [];
  for (const p of pairs) {
    msgs.push({ role: 'user', content: p.user });
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: p.assistant }] });
  }
  return msgs;
}

function estimatePromptTokens(toolsJsonStr, systemBlocks, pairs, nextUserContent) {
  let total = estimateTokensApprox(toolsJsonStr);
  for (const b of systemBlocks) total += estimateTokensApprox(b.text || '');
  for (const p of pairs) total += estimateTokensApprox(p.user) + estimateTokensApprox(p.assistant) + 12;
  total += estimateTokensApprox(nextUserContent) + 12;
  return total;
}

async function runSummaryApiCall({ arm, rep, turn, nonce, evictedPairs, currentStateJson, customRateCard, budgetTracker }) {
  const transcript = evictedPairs
    .map((p) => `[Turn ${p.turn} USER]: ${p.user.slice(0, 1200)}\n[Turn ${p.turn} ASSISTANT]: ${p.assistant}`)
    .join('\n\n');

  const isArmE = arm === 'E';
  const promptText = isArmE
    ? [
        'Extract ALL project facts from the evicted conversation turns (plus any prior STATE JSON) into ONE compact JSON object under 300 tokens.',
        'Include verbatim strings/numbers/filenames under keys: "negative_constraints", "verified_paths", "dead_ends".',
        'Do NOT paraphrase port numbers, header names, error constants, filenames, or pragmas.',
        currentStateJson ? `Prior STATE JSON:\n${currentStateJson}` : '',
        `Evicted conversation turns:\n${transcript}`
      ].filter(Boolean).join('\n\n')
    : [
        'Summarize the key topics, decisions, and context from the evicted conversation turns below in concise prose paragraphs of at most 450 tokens.',
        'Keep the narrative readable as background session context.',
        `Evicted conversation turns:\n${transcript}`
      ].join('\n\n');

  return sendMessagesCall({
    test: 'T5',
    arm,
    rep,
    turn,
    route: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    system: [{ type: 'text', text: 'You are a concise technical session state summarizer.' }],
    messages: [{ role: 'user', content: promptText }],
    max_tokens: isArmE ? 350 : 500,
    stream: true,
    nonceId: `${nonce}_sum_${turn}`,
    customRateCard,
    budgetTracker
  });
}

function makeExtraT5Fields(extra) {
  return {
    row_kind: extra.row_kind ?? 'chat_turn',
    prompt_token_estimate: extra.prompt_token_estimate ?? 0,
    trim_event: extra.trim_event ?? 'none',
    evicted_pairs_count: extra.evicted_pairs_count ?? 0,
    active_history_pairs: extra.active_history_pairs ?? 0,
    constraint_id: extra.constraint_id ?? '',
    constraint_passed: extra.constraint_passed ?? '',
    constraint_violated: extra.constraint_violated ?? '',
    session_key: extra.session_key ?? ''
  };
}

async function runOneSession({ arm, rep, staticAssets, slices, customRateCard, budgetTracker, extraSecrets }) {
  const { tools6, baseSystemText, toolsJsonStr } = staticAssets;
  const sessionKey = `T5|${arm}|${rep}`;
  const nonce = createRepNonce(`t5_${arm}_r${rep}`);
  const rows = [];
  let aborted = false;

  let stateJsonText = JSON.stringify({
    negative_constraints: [],
    verified_paths: [],
    dead_ends: []
  });

  let historyPairs = [];
  let tokenScaleFactor = 1.0;

  console.log(`[T5] Running ${sessionKey}...`);

  for (let turn = 1; turn <= 30; turn += 1) {
    const userPrompt = buildTurnUserPrompt(turn, slices[turn - 1]);
    const getSysBlocks = () => (arm === 'E'
      ? [
          { type: 'text', text: baseSystemText },
          { type: 'text', text: `<STRUCTURED_STATE_FILE>\n${stateJsonText}\n</STRUCTURED_STATE_FILE>` }
        ]
      : [{ type: 'text', text: baseSystemText }]);

    let trimEvent = 'none';
    let evictedThisTurn = 0;

    const estNextTokens = () => Math.round(
      estimatePromptTokens(toolsJsonStr, getSysBlocks(), historyPairs, userPrompt) * tokenScaleFactor
    );

    if (arm === 'B' && historyPairs.length > 0 && estNextTokens() > BUDGET_W) {
      while (historyPairs.length > 0 && estNextTokens() > BUDGET_W) {
        historyPairs.shift();
        evictedThisTurn += 1;
      }
      if (evictedThisTurn > 0) trimEvent = 'slide_drop';
    } else if ((arm === 'C' || arm === 'D' || arm === 'E') && historyPairs.length >= 2 && estNextTokens() > BUDGET_W) {
      const dropCount = Math.max(1, Math.floor(historyPairs.length * 0.5));
      const evicted = historyPairs.splice(0, dropCount);
      evictedThisTurn = evicted.length;

      if (arm === 'C') {
        trimEvent = 'cliff_50pct';
      } else if (arm === 'D') {
        trimEvent = 'prose_summary_cliff';
        const sumRes = await runSummaryApiCall({
          arm,
          rep,
          turn,
          nonce,
          evictedPairs: evicted,
          currentStateJson: null,
          customRateCard,
          budgetTracker
        });
        rows.push({
          ...sumRes.row,
          ...makeExtraT5Fields({
            row_kind: 'summary_call',
            prompt_token_estimate: 0,
            trim_event: 'prose_summary_generation',
            evicted_pairs_count: evicted.length,
            active_history_pairs: historyPairs.length,
            session_key: sessionKey
          })
        });
        if (sumRes.row.http_status !== 200) {
          aborted = true;
          console.error(`[T5] ABORT ${sessionKey} summary_call HTTP ${sumRes.row.http_status}`);
          break;
        }
        historyPairs.unshift({
          turn: `SUMMARY_${turn}`,
          user: `[PROSE SUMMARY OF EARLIER TURNS]\n${sumRes.assistantText}`,
          assistant: 'Acknowledged earlier session summary; continuing.'
        });
      } else if (arm === 'E') {
        trimEvent = 'structured_state_cliff';
        const stateRes = await runSummaryApiCall({
          arm,
          rep,
          turn,
          nonce,
          evictedPairs: evicted,
          currentStateJson: stateJsonText,
          customRateCard,
          budgetTracker
        });
        rows.push({
          ...stateRes.row,
          ...makeExtraT5Fields({
            row_kind: 'state_update_call',
            prompt_token_estimate: 0,
            trim_event: 'structured_state_generation',
            evicted_pairs_count: evicted.length,
            active_history_pairs: historyPairs.length,
            session_key: sessionKey
          })
        });
        if (stateRes.row.http_status !== 200) {
          aborted = true;
          console.error(`[T5] ABORT ${sessionKey} state_update_call HTTP ${stateRes.row.http_status}`);
          break;
        }
        stateJsonText = stateRes.assistantText || stateJsonText;
      }
    }

    const preSendEstimate = estNextTokens();
    const sysBlocks = getSysBlocks();
    const rawMsgs = [
      ...flattenPairsToMessages(historyPairs),
      { role: 'user', content: userPrompt }
    ];

    const built = injectNonceAndBreakpoints({
      nonce,
      tools: tools6,
      system: sysBlocks,
      messages: rawMsgs,
      breakpointLayers: ['tools', 'system', 'messages'],
      omitMessageBreakpoint: false
    });

    // In Arm E, keep static system[0] cached cleanly at its own breakpoint alongside tools6 (4 breakpoints total)
    if (arm === 'E' && built.system.length >= 2) {
      built.system[0] = { ...built.system[0], cache_control: { type: 'ephemeral' } };
    }

    const res = await sendMessagesCall({
      test: 'T5',
      arm,
      rep,
      turn,
      route: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      tools: built.tools,
      system: built.system,
      messages: built.messages,
      max_tokens: 150,
      stream: true,
      nonceId: nonce,
      customRateCard,
      budgetTracker
    });

    const rawApproxBeforeScale = estimatePromptTokens(toolsJsonStr, sysBlocks, historyPairs, userPrompt);
    if (res.row.http_status === 200 && res.row.prompt_tokens > 0 && rawApproxBeforeScale > 0) {
      tokenScaleFactor = res.row.prompt_tokens / rawApproxBeforeScale;
    }

    const baitSpec = CONSTRAINTS.find((c) => c.baitTurn === turn);
    const checkRes = baitSpec ? baitSpec.check(res.assistantText) : null;

    rows.push({
      ...res.row,
      ...makeExtraT5Fields({
        row_kind: 'chat_turn',
        prompt_token_estimate: preSendEstimate,
        trim_event: trimEvent,
        evicted_pairs_count: evictedThisTurn,
        active_history_pairs: historyPairs.length,
        constraint_id: baitSpec ? baitSpec.id : '',
        constraint_passed: checkRes ? checkRes.passed : '',
        constraint_violated: checkRes ? checkRes.violated : '',
        session_key: sessionKey
      })
    });

    if (res.row.http_status !== 200) {
      aborted = true;
      console.error(`[T5] ABORT ${sessionKey} turn=${turn} HTTP ${res.row.http_status}: ${res.row.error_text}`);
      break;
    }

    if (checkRes) {
      console.log(`[T5] ${sessionKey} T${turn} bait=${baitSpec.id} passed=${checkRes.passed} promptTok=${res.row.prompt_tokens} read=${res.row.cache_read_tokens} write=${res.row.cache_write_tokens}`);
    } else if (trimEvent !== 'none') {
      console.log(`[T5] ${sessionKey} T${turn} trim=${trimEvent} evicted=${evictedThisTurn} promptTok=${res.row.prompt_tokens} read=${res.row.cache_read_tokens} write=${res.row.cache_write_tokens}`);
    }

    historyPairs.push({
      turn,
      user: userPrompt,
      assistant: res.assistantText || 'Understood.'
    });
  }

  const chatRows = rows.filter((r) => r.row_kind === 'chat_turn');
  const firstTrimIdx = chatRows.findIndex((r) => r.trim_event && r.trim_event !== 'none');
  const postTrimRows = firstTrimIdx >= 0 ? chatRows.slice(firstTrimIdx) : chatRows.filter((r) => r.turn >= 20);
  const steadyPostCliffRows = postTrimRows.filter((r) => !r.trim_event || r.trim_event === 'none');
  const sumIn = (arr) => arr.reduce((a, r) => a + r.prompt_tokens, 0);
  const sumRead = (arr) => arr.reduce((a, r) => a + r.cache_read_tokens, 0);

  const totalIn = sumIn(chatRows);
  const totalRead = sumRead(chatRows);
  const postIn = sumIn(postTrimRows);
  const postRead = sumRead(postTrimRows);
  const steadyIn = sumIn(steadyPostCliffRows);
  const steadyRead = sumRead(steadyPostCliffRows);

  const rebuildEventsCount = chatRows.filter((r) => r.turn > 1 && r.cache_write_tokens >= 3000).length;
  const allCost = Number(rows.reduce((a, r) => a + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0).toFixed(6));
  const auxRows = rows.filter((r) => r.row_kind !== 'chat_turn');
  const sumCost = Number(auxRows.reduce((a, r) => a + Number(r.billed_cost_usd || r.computed_cost_usd || 0), 0).toFixed(6));
  const summaryOutputTokens = auxRows.reduce((a, r) => a + (r.output_tokens || 0), 0);

  const baitRows = chatRows.filter((r) => r.constraint_id);
  const constraintsPassed = baitRows.filter((r) => r.constraint_passed === true).length;
  const constraintViolationsCount = baitRows.length - constraintsPassed;

  console.log(`[T5] Done ${sessionKey}: cost=$${allCost} (aux=$${sumCost}) overallHit=${totalIn ? ((totalRead / totalIn) * 100).toFixed(1) : 0}% postTrimHit=${postIn ? ((postRead / postIn) * 100).toFixed(1) : 0}% steadyCliffHit=${steadyIn ? ((steadyRead / steadyIn) * 100).toFixed(1) : 0}% rebuilds=${rebuildEventsCount} violations=${constraintViolationsCount}/${baitRows.length}`);

  const entry = {
    sessionKey,
    arm,
    rep,
    aborted,
    rows,
    metrics: {
      totalCostUsd: allCost,
      auxSummaryCostUsd: sumCost,
      summaryOutputTokens,
      overallHitRatePct: totalIn ? Number(((totalRead / totalIn) * 100).toFixed(2)) : 0,
      postTrimHitRatePct: postIn ? Number(((postRead / postIn) * 100).toFixed(2)) : 0,
      steadyStatePostCliffHitPct: steadyIn ? Number(((steadyRead / steadyIn) * 100).toFixed(2)) : 0,
      rebuildEventsCount,
      firstTrimTurn: firstTrimIdx >= 0 ? chatRows[firstTrimIdx].turn : null,
      constraintsPassed,
      constraintViolationsCount,
      constraintsTotal: baitRows.length
    }
  };
  appendCheckpoint(entry, extraSecrets);
  return entry;
}

function buildSummary(entries) {
  const valid = entries.filter((e) => !e.aborted);
  const arms = {};
  for (const arm of ARMS) {
    const group = valid.filter((e) => e.arm === arm);
    if (!group.length) continue;
    const totalPassed = group.reduce((a, g) => a + g.metrics.constraintsPassed, 0);
    const totalViolations = group.reduce((a, g) => a + g.metrics.constraintViolationsCount, 0);
    const totalChecks = group.reduce((a, g) => a + g.metrics.constraintsTotal, 0);
    arms[arm] = {
      n: group.length,
      totalCostUsd: summarizeMedianRange(group.map((g) => g.metrics.totalCostUsd)),
      auxSummaryCostUsd: summarizeMedianRange(group.map((g) => g.metrics.auxSummaryCostUsd)),
      summaryOutputTokens: summarizeMedianRange(group.map((g) => g.metrics.summaryOutputTokens)),
      overallCacheHitPct: summarizeMedianRange(group.map((g) => g.metrics.overallHitRatePct)),
      postTrimCacheHitPct: summarizeMedianRange(group.map((g) => g.metrics.postTrimHitRatePct)),
      steadyStatePostCliffHitPct: summarizeMedianRange(group.map((g) => g.metrics.steadyStatePostCliffHitPct)),
      rebuildEventsCount: summarizeMedianRange(group.map((g) => g.metrics.rebuildEventsCount)),
      constraintsPreserved: { k: totalPassed, n: totalChecks, ...wilson95(totalPassed, totalChecks) },
      constraintViolationsTotal: totalViolations,
      constraintViolationsPerSession: summarizeMedianRange(group.map((g) => g.metrics.constraintViolationsCount))
    };
  }
  return {
    generatedAtUtc: new Date().toISOString(),
    budgetW: BUDGET_W,
    arms,
    abortedSessions: entries.filter((e) => e.aborted).map((e) => e.sessionKey)
  };
}

function runSelfTestCheckers() {
  const assets = buildStaticPrefixAssets();
  const slices = build30CorpusSlices();
  if (slices.length !== 30) throw new Error('Expected 30 corpus slices');
  if (assets.tools6.length !== 6) throw new Error('Expected 6 static tools');
  for (const c of CONSTRAINTS) {
    const goodSamples = {
      C1_PORT_9411: 'Use `server.listen(9411)` to bind the telemetry port cleanly.',
      C2_HEADER_GUARD: 'Send internal traffic with header `X-Session-Guard: strict-v2`.',
      C3_ERR_CHUNK: 'Throw fatal error constant `ERR_CHUNK_SPLIT` directly.',
      C4_OVERRIDE_FILE: 'Apply custom timeout values inside `overrides.local.mjs` only.',
      C5_PRAGMA_TABS: '// @strict-tabs\nModule uses tab indentation strictly.'
    };
    const badSamples = {
      C1_PORT_9411: 'Use `server.listen(8080)` cleanly.',
      C2_HEADER_GUARD: 'Pass `Authorization: Bearer xyz` on internal routes.',
      C3_ERR_CHUNK: 'Trigger `ERR_RETRY_LOOP` or omit error constant.',
      C4_OVERRIDE_FILE: 'Edit `config.default.mjs` to increase timeouts.',
      C5_PRAGMA_TABS: '/* eslint-disable */\nModule file.'
    };
    const g = c.check(goodSamples[c.id]);
    const b = c.check(badSamples[c.id]);
    if (!g.passed || g.violated) throw new Error(`Good sample failed for ${c.id}: ${JSON.stringify(g)}`);
    if (b.passed || !b.violated) throw new Error(`Bad sample passed for ${c.id}: ${JSON.stringify(b)}`);
  }
  console.log(`run_t5_trim.mjs self-test PASS (30 slices, tools6=${assets.toolsJsonStr.length} chars, sys=${assets.baseSystemText.length} chars, ${CONSTRAINTS.length} checker pairs).`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTestCheckers();
    return;
  }

  const fresh = args.includes('--fresh');
  const keys = loadBenchmarkKeys();
  const extraSecrets = getExtraSecrets(keys);
  const rateCard = loadRateCard();
  const staticAssets = buildStaticPrefixAssets();
  const slices = build30CorpusSlices();

  if (fresh && fs.existsSync(CHECKPOINT_PATH)) {
    fs.unlinkSync(CHECKPOINT_PATH);
    console.log('[T5] Cleared checkpoint for --fresh run.');
  }

  const doneKeys = new Set(loadCheckpoints().filter((e) => !e.aborted).map((e) => e.sessionKey));

  const budgetTracker = new RunBudgetTracker({
    expectedRunUsd: 10.5,
    multiplier: 3,
    maxRunUsd: 30.0,
    globalCapUsd: 40.0,
    label: 'T5_HistoryTrim'
  });

  for (const arm of ARMS) {
    const pendingReps = REPS.filter((rep) => {
      const sessionKey = `T5|${arm}|${rep}`;
      if (doneKeys.has(sessionKey)) {
        console.log(`[T5] Skipping completed ${sessionKey}`);
        return false;
      }
      return true;
    });
    if (pendingReps.length > 0) {
      await Promise.all(
        pendingReps.map((rep) => runOneSession({
          arm,
          rep,
          staticAssets,
          slices,
          customRateCard: rateCard,
          budgetTracker,
          extraSecrets
        }))
      );
    }
  }

  const finalMap = new Map();
  for (const e of loadCheckpoints()) {
    finalMap.set(e.sessionKey, e);
  }
  const allEntries = [...finalMap.values()];
  const allRows = allEntries.flatMap((e) => e.rows || []);

  writeCsv(CSV_OUT_PATH, T5_CSV_COLUMNS, allRows);
  const summary = buildSummary(allEntries);
  const summaryStr = JSON.stringify(summary, null, 2);
  assertNoSensitiveLeaks(summaryStr, 't5_summary.json', extraSecrets);
  fs.writeFileSync(SUMMARY_OUT_PATH, summaryStr, 'utf8');

  console.log(`[T5] Complete! Wrote ${allRows.length} rows -> ${CSV_OUT_PATH}`);
  console.log(`[T5] Summary -> ${SUMMARY_OUT_PATH}`);
  if (summary.abortedSessions.length > 0) {
    console.error(`[T5] WARNING aborted sessions: ${summary.abortedSessions.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[T5] Fatal error:', redactSensitiveText(err.stack || err.message));
  process.exit(1);
});
