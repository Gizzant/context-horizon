/**
 * Pure Strict Validator for Antigravity Plugin Manifests, `hooks.json`, and Safe Hook Outputs
 * (`src/core/shared/plugin_validator.mjs`)
 *
 * Mirrors `agy plugin validate --strict` rules with zero I/O.
 */

export const FLAT_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'PreInvocation',
  'PostInvocation',
  'Stop'
]);

export const MATCHER_HOOK_EVENTS = Object.freeze([
  'PreToolUse',
  'PostToolUse'
]);

export function validateStrictAntigravityPluginManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['plugin.json must be a JSON object'], warnings };
  }

  const name = String(manifest.name || '');
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    errors.push(`plugin.json "name" must be kebab-case (received "${name}")`);
  }
  if (name !== 'attention-horizon-antigravity') {
    errors.push(`plugin.json "name" must be "attention-horizon-antigravity" (received "${name}")`);
  }

  const displayName = String(manifest.displayName || '');
  if (!displayName) {
    errors.push('plugin.json "displayName" is required');
  } else {
    if (/^(Antigravity|Gemini)\b/i.test(displayName)) {
      errors.push(`plugin.json "displayName" must NOT start with "Antigravity" or "Gemini" (received "${displayName}")`);
    }
    if (/\b(Plugin|MCP)\s*$/i.test(displayName) || /\b(Plugin|MCP)\b/i.test(displayName)) {
      errors.push(`plugin.json "displayName" must omit "Plugin"/"MCP" suffixes (received "${displayName}")`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function validateStrictAntigravityHooksJson(hooksDoc, { requireRelativePluginPaths = true } = {}) {
  const errors = [];
  if (!hooksDoc || typeof hooksDoc !== 'object' || Array.isArray(hooksDoc)) {
    return { valid: false, errors: ['hooks.json must be a non-null JSON object'] };
  }

  const rootScope = hooksDoc.hooks && typeof hooksDoc.hooks === 'object' && !Array.isArray(hooksDoc.hooks)
    ? hooksDoc.hooks
    : hooksDoc;

  const checkCommandObj = (cmdObj, label) => {
    if (!cmdObj || typeof cmdObj !== 'object' || Array.isArray(cmdObj)) {
      errors.push(`${label} must be an object`);
      return;
    }
    if (cmdObj.type !== 'command') {
      errors.push(`${label}.type must be "command"`);
    }
    if (typeof cmdObj.command !== 'string' || !cmdObj.command.trim()) {
      errors.push(`${label}.command must be a non-empty string`);
    } else if (requireRelativePluginPaths && !/^node\s+(?:--no-warnings\s+)?\.\/hooks\/[a-z0-9_.-]+\.mjs\b/i.test(cmdObj.command.trim())) {
      errors.push(`${label}.command must use relative plugin-root path "node ./hooks/..." (received "${cmdObj.command}")`);
    }
    if (typeof cmdObj.timeout !== 'number' || cmdObj.timeout <= 0) {
      errors.push(`${label}.timeout must be a positive number`);
    }
  };

  for (const flatEvt of FLAT_HOOK_EVENTS) {
    if (!(flatEvt in rootScope)) continue;
    const arr = rootScope[flatEvt];
    if (!Array.isArray(arr) || arr.length === 0) {
      errors.push(`${flatEvt} must map directly to a non-empty flat handler array`);
      continue;
    }
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${flatEvt}[${i}] must be a flat handler object`);
        continue;
      }
      if ('matcher' in entry) {
        errors.push(`${flatEvt}[${i}] MUST NOT contain a "matcher" key`);
      }
      if ('hooks' in entry) {
        errors.push(`${flatEvt}[${i}] MUST NOT wrap handlers inside a nested "hooks" array`);
      }
      checkCommandObj(entry, `${flatEvt}[${i}]`);
    }
  }

  for (const matchEvt of MATCHER_HOOK_EVENTS) {
    if (!(matchEvt in rootScope)) continue;
    const arr = rootScope[matchEvt];
    if (!Array.isArray(arr) || arr.length === 0) {
      errors.push(`${matchEvt} must be a non-empty array of { matcher, hooks } entries`);
      continue;
    }
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${matchEvt}[${i}] must be an object`);
        continue;
      }
      if (typeof entry.matcher !== 'string' || !entry.matcher.trim()) {
        errors.push(`${matchEvt}[${i}].matcher must be a non-empty regex string`);
      }
      if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) {
        errors.push(`${matchEvt}[${i}].hooks must be a non-empty array of command handlers`);
        continue;
      }
      if ('type' in entry || 'command' in entry) {
        errors.push(`${matchEvt}[${i}] must nest command handlers inside "hooks": [...] rather than flat properties`);
      }
      for (let j = 0; j < entry.hooks.length; j++) {
        checkCommandObj(entry.hooks[j], `${matchEvt}[${i}].hooks[${j}]`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function containsForbiddenDirectiveKeys(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const forbidden = [];
  const rawJson = JSON.stringify(payload);
  if ('injectSteps' in payload || rawJson.includes('"injectSteps"')) forbidden.push('injectSteps');
  if (payload.systemMessage && typeof payload.systemMessage === 'object' && 'metadata' in payload.systemMessage) {
    forbidden.push('systemMessage.metadata');
  }
  if (rawJson.includes('"user_markdown"')) forbidden.push('user_markdown');
  if ('ask_question' in payload || rawJson.includes('"ask_question"')) forbidden.push('ask_question');
  return forbidden;
}

export function validateSafePreInvocationOutput(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['PreInvocation output must be a JSON object'] };
  }
  const forbidden = containsForbiddenDirectiveKeys(payload);
  if (forbidden.length > 0) {
    errors.push(`Forbidden keys in PreInvocation output: ${forbidden.join(', ')}`);
  }
  const keys = Object.keys(payload);
  if (keys.length === 0) return { valid: errors.length === 0, errors };

  if (keys.length === 1 && typeof payload.ephemeralMessage === 'string') {
    return { valid: errors.length === 0, errors };
  }
  if (
    payload.terminationBehavior === 'terminate' &&
    payload.errorMessage &&
    typeof payload.errorMessage.userMessage === 'string' &&
    keys.every((k) => k === 'terminationBehavior' || k === 'errorMessage')
  ) {
    return { valid: errors.length === 0, errors };
  }

  errors.push(`Unexpected PreInvocation output shape: keys=[${keys.join(', ')}]`);
  return { valid: false, errors };
}

export function validateSafePreToolUseOutput(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['PreToolUse output must be a JSON object'] };
  }
  const forbidden = containsForbiddenDirectiveKeys(payload);
  if (forbidden.length > 0) {
    errors.push(`Forbidden keys in PreToolUse output: ${forbidden.join(', ')}`);
  }
  if (!['allow', 'ask', 'deny'].includes(payload.decision)) {
    errors.push(`PreToolUse decision must be "allow" | "ask" | "deny" (received "${payload.decision}")`);
  }
  if (payload.reason !== undefined && typeof payload.reason !== 'string') {
    errors.push('PreToolUse reason must be a string when present');
  }
  const extraKeys = Object.keys(payload).filter((k) => k !== 'decision' && k !== 'reason');
  if (extraKeys.length > 0) {
    errors.push(`Unexpected PreToolUse keys: ${extraKeys.join(', ')}`);
  }
  return { valid: errors.length === 0, errors };
}
