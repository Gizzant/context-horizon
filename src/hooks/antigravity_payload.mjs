/**
 * @file src/hooks/antigravity_payload.mjs
 * Maps Antigravity's documented PreToolUse stdin onto the field names the guards read.
 *
 * Antigravity sends `{ toolCall: { name, args }, hookEventName?, stepIdx, conversationId, ... }`
 * (https://antigravity.google/docs/hooks). The guards read `tool_name` / `tool_input` /
 * `hook_event_name`, so without this every Antigravity tool call looked empty and was allowed.
 * Zero imports so the thin hook entrypoint stays fast.
 */

/**
 * Returns a shallow copy with `tool_name`, `tool_input` and `hook_event_name` filled from
 * `toolCall` / `hookEventName` when those are present. Existing snake_case fields win.
 * @param {object} input
 * @returns {object}
 */
export function normalizeAntigravityToolPayload(input) {
  if (!input || typeof input !== 'object') return input;
  const out = { ...input };
  if (!out.hook_event_name && typeof input.hookEventName === 'string' && input.hookEventName) {
    out.hook_event_name = input.hookEventName;
  }
  const tc = input.toolCall || input.tool_call;
  if (!tc || typeof tc !== 'object') return out;

  let args = tc.args ?? tc.arguments ?? tc.parameters ?? tc.input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { command: args };
    }
  }
  if (!out.tool_name && typeof tc.name === 'string' && tc.name) out.tool_name = tc.name;
  if (!out.tool_input && args && typeof args === 'object') out.tool_input = args;
  if (!out.hook_event_name) out.hook_event_name = 'PreToolUse';
  return out;
}
