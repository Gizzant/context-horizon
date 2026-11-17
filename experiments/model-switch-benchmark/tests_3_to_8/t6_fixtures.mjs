import { loadPinnedCorpusSlice } from './prefix_lab.mjs';

function makeRichToolSchema(idx, variant = 'normal') {
  const num = String(idx).padStart(2, '0');
  const propsNormal = {
    scope_id: {
      type: 'string',
      description: `Immutable identifier for telemetry slice ${num} in the read-only snapshot ledger.`
    },
    start_line: {
      type: 'integer',
      description: `One-indexed inclusive starting line cursor for bounded examination of buffer ${num}.`
    },
    end_line: {
      type: 'integer',
      description: `One-indexed inclusive ending line cursor for bounded inspection of buffer ${num}.`
    },
    granularity_tier: {
      type: 'string',
      enum: ['summary', 'block', 'token', 'wire'],
      description: `Aggregation granularity selector controlling prefix bucket boundaries for stream ${num}.`
    },
    include_metadata: {
      type: 'boolean',
      description: `When true, attaches schema hashes, breakpoint indices, and layer sizes for stream ${num}.`
    }
  };

  if (variant === 'shuffled') {
    const propsShuffled = {
      include_metadata: {
        description: propsNormal.include_metadata.description,
        type: propsNormal.include_metadata.type
      },
      granularity_tier: {
        description: propsNormal.granularity_tier.description,
        enum: propsNormal.granularity_tier.enum,
        type: propsNormal.granularity_tier.type
      },
      end_line: {
        description: propsNormal.end_line.description,
        type: propsNormal.end_line.type
      },
      start_line: {
        description: propsNormal.start_line.description,
        type: propsNormal.start_line.type
      },
      scope_id: {
        description: propsNormal.scope_id.description,
        type: propsNormal.scope_id.type
      }
    };
    return {
      required: ['end_line', 'start_line', 'scope_id'],
      properties: propsShuffled,
      type: 'object'
    };
  }

  return {
    type: 'object',
    properties: propsNormal,
    required: ['scope_id', 'start_line', 'end_line']
  };
}

export function buildT6ToolCatalog({ shuffled = false } = {}) {
  const names = [
    'ledger_inspect_block',
    'ledger_diff_snapshots',
    'cache_probe_breakpoint',
    'cache_verify_prefix_hash',
    'quota_compute_burn_rate',
    'ttl_measure_countdown',
    'breaker_check_cliff',
    'parser_extract_usage',
    'session_audit_transcript',
    'telemetry_rank_wasters',
    'cost_project_billing_block',
    'stream_measure_ttfb',
    'header_inspect_capabilities',
    'route_verify_pinning',
    'rule_evaluate_compliance',
    'state_serialize_checkpoint',
    'summary_measure_drift',
    'salt_verify_isolation',
    'wire_hash_layers',
    'report_export_medians'
  ];

  return names.map((name, i) => {
    const idx = i + 1;
    const num = String(idx).padStart(2, '0');
    const description =
      `Read-only analysis tool #${num} (${name}) for prompt-cache prefix validation and layer attribution across tools, system, and messages.`;
    const input_schema = makeRichToolSchema(idx, shuffled ? 'shuffled' : 'normal');
    if (shuffled) {
      return {
        input_schema,
        description,
        name
      };
    }
    return {
      name,
      description,
      input_schema
    };
  });
}

export function buildExtraTool21() {
  return {
    name: 'audit_append_delta_verify',
    description:
      'Tool #21 appended dynamically at turn 6 to test whether appending one tool invalidates the tools cache layer and downstream layers.',
    input_schema: makeRichToolSchema(21, 'normal')
  };
}

export function buildSearchStubTool() {
  return {
    name: 'search_tools',
    description:
      'Static deferred tool-discovery stub kept constant in tools[0]. Deferred schemas arrive in tail user messages without mutating tools[].',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword query matching deferred capability schemas.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum deferred schemas to return.'
        }
      },
      required: ['query']
    }
  };
}

export function buildDeferredSchemaBlockText(tools20) {
  const deferred5 = tools20.slice(15, 20);
  return (
    '\n\n[DEFERRED_TOOL_SCHEMAS_LOADED_AT_T6]\n' +
    JSON.stringify(deferred5, null, 2)
  );
}

export function buildT6SystemText() {
  const b1 = loadPinnedCorpusSlice('src/core-isomorphic/economics/billingBlocks.mjs', 1, 130);
  const b2 = loadPinnedCorpusSlice('src/core-isomorphic/economics/dualTtl.mjs', 1, 95);
  return (
    'You are an analytical assistant answering strictly from the reference source excerpts and prior messages in this conversation.\n' +
    'Follow these rules:\n' +
    '1. Answer concisely in 2-3 sentences or <= 60 words.\n' +
    '2. Do not invoke any tools; all tools provided in the schema are reference definitions only.\n' +
    '3. Only state symbol names, constants, and conditions visible in the provided text.\n\n' +
    '=== REFERENCE MODULE 1 (billingBlocks.mjs) ===\n' +
    b1 +
    '\n\n=== REFERENCE MODULE 2 (dualTtl.mjs) ===\n' +
    b2
  );
}

export function buildT6TurnMessagesAndRag() {
  // Each user turn carries ~820-900 tokens of pinned corpus text so T6 reaches ~14.5k-15.2k total tokens
  // (~6k tools + ~3k system + ~5.5k-6k accumulated messages).
  const slices = [
    ['src/core/parser.mjs', 1, 80, 'Summarize the imports and top-level constants in parser.mjs lines 1-80.'],
    ['src/core/parser.mjs', 81, 160, 'Summarize the parsing helpers defined in parser.mjs lines 81-160.'],
    ['src/core/parser.mjs', 161, 240, 'Identify error-handling or normalization branches in parser.mjs lines 161-240.'],
    ['src/core/parser.mjs', 241, 320, 'Explain the token or usage accounting logic in parser.mjs lines 241-320.'],
    ['src/core/parser.mjs', 321, 400, 'Summarize the record-extraction flow in parser.mjs lines 321-400.'],
    ['src/core/quota.mjs', 1, 80, 'Identify the quota thresholds and constants in quota.mjs lines 1-80.'],
    ['src/core/quota.mjs', 81, 160, 'Explain how window bounds are calculated in quota.mjs lines 81-160.'],
    ['src/core/quota.mjs', 161, 240, 'Summarize the burn-rate or usage projection logic in quota.mjs lines 161-240.'],
    ['src/core/constants.mjs', 1, 80, 'List the primary pricing or model constants in constants.mjs lines 1-80.'],
    ['src/core/constants.mjs', 81, 160, 'Identify provider or pricing overrides in constants.mjs lines 81-160.'],
    ['src/core-isomorphic/economics/cliffBreaker.mjs', 1, 90, 'Summarize the threshold tiers in cliffBreaker.mjs lines 1-90.'],
    ['src/core-isomorphic/economics/cliffBreaker.mjs', 91, 180, 'Synthesize how action states transition in cliffBreaker.mjs lines 91-180.']
  ];

  const turns = slices.map(([relPath, s, e, q], idx) => {
    const code = loadPinnedCorpusSlice(relPath, s, e);
    return {
      turn: idx + 1,
      questionText: `Turn ${idx + 1} Task: ${q}\n\`\`\`javascript\n${code}\n\`\`\``,
      editedTurn2Text:
        idx === 1
          ? `Turn 2 Revised Task (T6 prefix edit test): Examine lines 81-160 and explain any parsing helpers.\n\`\`\`javascript\n${code}\n\`\`\``
          : null
    };
  });

  // Deterministic ~550-650 token RAG passages for turns 2..12
  const ragSlices = [
    ['src/core/quota.mjs', 241, 282],
    ['src/core/quota.mjs', 283, 324],
    ['src/core/quota.mjs', 325, 366],
    ['src/core/quota.mjs', 367, 408],
    ['src/core/parser.mjs', 401, 442],
    ['src/core/parser.mjs', 443, 484],
    ['src/core/parser.mjs', 485, 526],
    ['src/core/parser.mjs', 527, 568],
    ['src/core/constants.mjs', 161, 202],
    ['src/core/constants.mjs', 203, 244],
    ['src/core/constants.mjs', 245, 286]
  ];
  const ragByTurn = {};
  for (let i = 0; i < ragSlices.length; i++) {
    const turnNum = i + 2; // turns 2..12
    const [relPath, s, e] = ragSlices[i];
    ragByTurn[turnNum] =
      `[RETRIEVED CONTEXT FOR TURN ${turnNum}: ${relPath}:${s}-${e}]\n` +
      loadPinnedCorpusSlice(relPath, s, e);
  }

  return { turns, ragByTurn };
}

export function selectDynamicToolsSubset15(tools20, turn) {
  const offset = turn === 1 ? 0 : (turn - 1) % tools20.length;
  const selected = [];
  for (let k = 0; k < 15; k++) {
    selected.push(tools20[(offset + k) % tools20.length]);
  }
  return selected;
}
