import fs from 'node:fs';

const t0 = process.hrtime.bigint();

const CANARY_PAIRS = [
  {
    raw: 'ceo.secret@acme-corp.internal',
    twin: 'persona_4f2a8c10@synthetic.test'
  },
  {
    raw: 'postgres://admin:LivePass99!@db-prod.acme-corp.internal:5432/core',
    twin: 'postgres://synth:SynthPass00@host-4f2a8c10.synthetic.internal:5432/core'
  },
  {
    raw: ('sk_live_' + '99887766554433221100aabbcc'),
    twin: 'SYNTH_STRIPE_4f2a8c10_9e'
  },
  {
    raw: 'ProjectTitan',
    twin: 'CODENAME_4f2a8c10'
  }
];

// Also partial components that might appear individually (e.g., Grep/Glob or split URI)
const PARTIAL_RAW_TO_TWIN = [
  ...CANARY_PAIRS,
  { raw: 'db-prod.acme-corp.internal', twin: 'host-4f2a8c10.synthetic.internal' },
  { raw: 'LivePass99!', twin: 'SynthPass00' }
];

const SYNTH_PATTERN =
  /(?:persona_[0-9a-f]+@synthetic\.test|host-[0-9a-f]+\.synthetic\.internal|SYNTH_[A-Z0-9_]+|CODENAME_[0-9a-f]+|postgres:\/\/synth:[^@]+@host-[0-9a-f]+\.synthetic\.internal:\d+\/\w+)/g;

function readAllStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function replaceDeep(value, pairs, direction) {
  let count = 0;
  function walk(node) {
    if (typeof node === 'string') {
      let out = node;
      for (const p of pairs) {
        const from = direction === 'vault' ? p.raw : p.twin;
        const to = direction === 'vault' ? p.twin : p.raw;
        if (out.includes(from)) {
          const parts = out.split(from);
          count += parts.length - 1;
          out = parts.join(to);
        }
      }
      return out;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === 'object') {
      const clone = {};
      for (const [k, v] of Object.entries(node)) {
        clone[k] = walk(v);
      }
      return clone;
    }
    return node;
  }
  const result = walk(value);
  return { result, count };
}

function findUnknownSyntheticTokens(value) {
  const knownTwins = new Set(CANARY_PAIRS.map((p) => p.twin));
  knownTwins.add('host-4f2a8c10.synthetic.internal');
  const unknown = [];

  function walk(node) {
    if (typeof node === 'string') {
      const matches = node.match(SYNTH_PATTERN);
      if (matches) {
        for (const m of matches) {
          if (!knownTwins.has(m)) {
            unknown.push(m);
          }
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  }
  walk(value);
  return unknown;
}

function containsAnySyntheticToken(value) {
  let found = false;
  function walk(node) {
    if (found) return;
    if (typeof node === 'string') {
      if (SYNTH_PATTERN.test(node)) found = true;
      SYNTH_PATTERN.lastIndex = 0;
      return;
    }
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  }
  walk(value);
  return found;
}

function logEvent(record) {
  const logPath = process.env.SPIKE_HOOK_LOG;
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // ignore
  }
}

const mode = process.env.SPIKE_HOOK_MODE || 'NORMAL';
const rawStdin = readAllStdin().trim();
let event = {};
try {
  event = rawStdin ? JSON.parse(rawStdin) : {};
} catch {
  event = { parseError: true, rawStdin };
}

const hookEvent = event.hook_event_name || 'UNKNOWN';
const toolName = event.tool_name || '';

if (mode === 'CRASH_EXIT_1') {
  const algMs = Number(process.hrtime.bigint() - t0) / 1e6;
  logEvent({ ts: Date.now(), mode, hookEvent, toolName, algMs, action: 'EXIT_1_CRASH' });
  process.stderr.write('Simulated unhandled hook crash\n');
  process.exit(1);
}

if (mode === 'TIMEOUT_HANG') {
  const algMs = Number(process.hrtime.bigint() - t0) / 1e6;
  logEvent({ ts: Date.now(), mode, hookEvent, toolName, algMs, action: 'SLEEP_3500MS' });
  setTimeout(() => {
    process.exit(0);
  }, 3500);
} else {
  let outObj = null;
  let action = 'PASS_THROUGH';
  let exitCode = 0;
  let stderrMsg = '';

  if (hookEvent === 'UserPromptSubmit') {
    const promptText = String(event.prompt || '');
    if (mode === 'PROMPT_BLOCK') {
      const { count } = replaceDeep(promptText, PARTIAL_RAW_TO_TWIN, 'vault');
      if (count > 0) {
        action = 'BLOCKED_EXIT_2';
        exitCode = 2;
        stderrMsg = '[Airlock UserPromptSubmit] Blocked raw secret in prompt\n';
      }
    } else if (mode === 'PROMPT_REWRITE_ATTEMPT') {
      const { result: scrubbed, count } = replaceDeep(promptText, PARTIAL_RAW_TO_TWIN, 'vault');
      if (count > 0) {
        action = 'PROMPT_REWRITE_ATTEMPT';
        outObj = {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            updatedPrompt: scrubbed,
            updatedInput: { prompt: scrubbed },
            additionalContext: `[Airlock Rewrite Attempt] Scrubbed prompt: ${scrubbed}`
          }
        };
      }
    } else if (mode === 'PROMPT_SUPPRESS_TEST') {
      const { result: scrubbed, count } = replaceDeep(promptText, PARTIAL_RAW_TO_TWIN, 'vault');
      if (count > 0) {
        action = 'PROMPT_SUPPRESS_TEST';
        outObj = {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            suppressOriginalPrompt: true,
            additionalContext: `Replaced user request safely: ${scrubbed}`
          }
        };
      }
    }
  } else if (hookEvent === 'PreToolUse') {
    const tIn = event.tool_input || {};

    if (mode === 'STATELESS_V1') {
      if (containsAnySyntheticToken(tIn)) {
        action = 'FM1_BLOCKED_STATELESS_PLACEHOLDER';
        exitCode = 2;
        stderrMsg =
          '[Airlock FM-1] Blocked one-way synthetic placeholder in PreToolUse input. Refer to config/env names instead of placeholder literals; do not retry with synthetic tokens.\n';
      }
    } else if (toolName === 'Bash' && /\bgit\s+commit\b/i.test(String(tIn.command || '')) && containsAnySyntheticToken(tIn)) {
      action = 'FM10_BLOCKED_GIT_COMMIT';
      exitCode = 2;
      stderrMsg = '[Airlock FM-10] Blocked unvault into git commit message\n';
    } else if (/^(Edit|Write)$/i.test(toolName) && /README\.md$/i.test(String(tIn.file_path || '')) && containsAnySyntheticToken(tIn)) {
      action = 'FM10_BLOCKED_DOC_WRITE';
      exitCode = 2;
      stderrMsg = '[Airlock FM-10] Blocked unvault into documentation file\n';
    } else {
      const unknownTwins = findUnknownSyntheticTokens(tIn);
      if (unknownTwins.length > 0) {
        action = 'FM1_BLOCKED_UNKNOWN_TWIN';
        exitCode = 2;
        stderrMsg = `[Airlock FM-1] Unknown or mutated synthetic token(s): ${unknownTwins.join(', ')}\n`;
      } else {
        const { result: unvaulted, count } = replaceDeep(tIn, CANARY_PAIRS, 'unvault');
        if (count > 0) {
          action = 'PRE_UNVAULTED';
          outObj = {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: unvaulted
            }
          };
        }
      }
    }
  } else if (hookEvent === 'PostToolUse') {
    if (mode === 'POST_EDIT_UNSCRUBBED' && toolName === 'Edit') {
      action = 'SKIPPED_POST_EDIT_BY_MODE';
    } else {
      const rawResp = event.tool_response;
      const { result: scrubbedResp, count } = replaceDeep(rawResp, PARTIAL_RAW_TO_TWIN, 'vault');
      if (count > 0) {
        action = 'POST_VAULTED';
        outObj = {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            updatedToolOutput: scrubbedResp
          }
        };
      }
    }
  }

  const algMs = Number(process.hrtime.bigint() - t0) / 1e6;
  logEvent({
    ts: Date.now(),
    mode,
    hookEvent,
    toolName,
    algMs: Number(algMs.toFixed(3)),
    action,
    stdinKeys: Object.keys(event),
    toolResponseType: event.tool_response === undefined ? 'undefined' : Array.isArray(event.tool_response) ? 'array' : typeof event.tool_response,
    toolResponsePreview: event.tool_response !== undefined ? JSON.stringify(event.tool_response).slice(0, 350) : undefined,
    toolInputPreview: event.tool_input !== undefined ? JSON.stringify(event.tool_input).slice(0, 350) : undefined,
    outputPreview: outObj ? JSON.stringify(outObj).slice(0, 350) : ''
  });

  if (exitCode !== 0) {
    process.stderr.write(stderrMsg);
    process.exit(exitCode);
  }
  if (outObj) {
    process.stdout.write(JSON.stringify(outObj) + '\n');
  }
  process.exit(0);
}
