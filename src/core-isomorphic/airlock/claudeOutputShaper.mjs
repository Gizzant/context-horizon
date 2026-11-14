/**
 * @file src/core-isomorphic/airlock/claudeOutputShaper.mjs
 * Schema-preserving PostToolUse output scrubber (`FM-11` resilient) for Claude Code
 * (`sdk-tools.d.ts` FileReadOutput, BashOutput, GrepOutput, GlobOutput, FileEditOutput,
 * FileWriteOutput, NotebookEditOutput, WebFetchOutput, WebSearchOutput, AgentOutput, McpOutput).
 *
 * Pure-JS Mod Law 4 compliant (zero `node:*` imports).
 */

import { globMatchPure, scrubTextWithAirlock } from './detector.mjs';

export const TESTED_CLAUDE_CODE_RANGE = '>=2.1.121 <2.2.0';

/**
 * Evaluates whether a detected Claude Code CLI version is inside the verified
 * `updatedToolOutput` schema compatibility range (`>=2.1.121 <2.2.0`).
 *
 * @param {string} [versionStr='']
 * @returns {{ known: boolean, tested: boolean, normalized: string }}
 */
export function isTestedClaudeCodeVersion(versionStr = '') {
  const raw = String(versionStr || '').trim();
  if (!raw) {
    return { known: false, tested: true, normalized: '' };
  }
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    return { known: false, tested: true, normalized: raw };
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const normalized = `${major}.${minor}.${patch}`;
  const tested = major === 2 && minor === 1 && patch >= 121;
  return { known: true, tested, normalized };
}

function clonePlainDeep(val) {
  if (val === null || val === undefined || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    const out = new Array(val.length);
    for (let i = 0; i < val.length; i++) out[i] = clonePlainDeep(val[i]);
    return out;
  }
  const out = {};
  const keys = Object.keys(val);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    out[k] = clonePlainDeep(val[k]);
  }
  return out;
}

function extractTargetFilePath(event = {}, rawResp = null) {
  const input = event.tool_input || event.toolInput || event.args || {};
  return String(
    input.file_path ||
      input.notebook_path ||
      input.filePath ||
      input.path ||
      rawResp?.file?.filePath ||
      rawResp?.filePath ||
      ''
  );
}

function collectScrubStats(acc, res) {
  if (!res) return;
  for (let i = 0; i < res.matches.length; i++) {
    const { ruleId, category, severityTier, action, entityHmac } = res.matches[i];
    acc.matches.push({ ruleId, category, severityTier, action, entityHmac });
  }
  for (let i = 0; i < res.auditOnlyMatches.length; i++) {
    const { ruleId, category, severityTier, action, entityHmac } = res.auditOnlyMatches[i];
    acc.auditOnlyMatches.push({ ruleId, category, severityTier, action, entityHmac });
  }
  for (let i = 0; i < res.uniqueEntityHmacs.length; i++) {
    acc.hmacSet.add(res.uniqueEntityHmacs[i]);
  }
}

function scrubStringField(obj, key, scrubOpts, acc) {
  if (!obj || typeof obj !== 'object' || typeof obj[key] !== 'string') return false;
  const res = scrubTextWithAirlock(obj[key], scrubOpts);
  collectScrubStats(acc, res);
  if (res.modified) {
    obj[key] = res.scrubbedText;
    return true;
  }
  return false;
}

function scrubDeepAllStrings(node, scrubOpts, acc, skipKeys = null) {
  if (typeof node === 'string') {
    const res = scrubTextWithAirlock(node, scrubOpts);
    collectScrubStats(acc, res);
    return { value: res.modified ? res.scrubbedText : node, modified: res.modified };
  }
  if (Array.isArray(node)) {
    let anyModified = false;
    const out = new Array(node.length);
    for (let i = 0; i < node.length; i++) {
      const child = scrubDeepAllStrings(node[i], scrubOpts, acc, skipKeys);
      out[i] = child.value;
      if (child.modified) anyModified = true;
    }
    return { value: out, modified: anyModified };
  }
  if (node && typeof node === 'object') {
    let anyModified = false;
    const out = {};
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (skipKeys && skipKeys.has(k)) {
        out[k] = clonePlainDeep(node[k]);
        continue;
      }
      const child = scrubDeepAllStrings(node[k], scrubOpts, acc, skipKeys);
      out[k] = child.value;
      if (child.modified) anyModified = true;
    }
    return { value: out, modified: anyModified };
  }
  return { value: node, modified: false };
}

/**
 * Clones `event.tool_response` preserving all unknown host properties (`FM-11`)
 * and scrubs verified string leaves matching Claude Code `sdk-tools.d.ts` shapes.
 *
 * @param {object} [event={}]
 * @param {object} [options={}]
 */
export function cloneAndScrubToolResponse(event = {}, options = {}) {
  const toolName = String(event.tool_name || event.toolName || '');
  const rawResp =
    event.tool_response !== undefined
      ? event.tool_response
      : event.tool_output !== undefined
        ? event.tool_output
        : event.toolOutput !== undefined
          ? event.toolOutput
          : event.output;

  if (rawResp === undefined || rawResp === null) {
    return {
      modified: false,
      updatedToolOutput: rawResp,
      matches: [],
      auditOnlyMatches: [],
      uniqueEntityHmacs: [],
      schemaDriftDetected: false,
      skippedReason: 'EMPTY_RESPONSE'
    };
  }

  const policy = options.policy || {};
  const filePath = extractTargetFilePath(event, rawResp);
  const auditOnlyGlobs = Array.isArray(policy.auditOnlyReadGlobs)
    ? policy.auditOnlyReadGlobs
    : [];
  const scrubAllTextReads =
    options.scrubAllTextReads !== false && policy.scrubAllTextReads !== false;
  const isReadAuditOnly =
    /^(Read|read_file)$/i.test(toolName) &&
    (!scrubAllTextReads || auditOnlyGlobs.some((g) => globMatchPure(filePath, g)));

  const scrubOpts = {
    sessionKey: options.sessionKey || 'ephemeral-default-key',
    policy,
    orgAuditSalt: options.orgAuditSalt || options.sessionKey || 'default-audit-salt',
    orgAllowlistSalt: options.orgAllowlistSalt || '',
    enableStage3Redaction: options.enableStage3Redaction === true,
    filePath,
    auditOnly: options.auditOnly === true || isReadAuditOnly
  };

  const acc = {
    matches: [],
    auditOnlyMatches: [],
    hmacSet: new Set()
  };

  const normTool = toolName.toLowerCase();
  let schemaDriftDetected = false;
  let skippedReason = isReadAuditOnly ? 'AUDIT_ONLY_READ_GLOB' : null;
  let updated = clonePlainDeep(rawResp);
  let modified = false;

  if (normTool === 'read' || normTool === 'read_file') {
    if (!updated || typeof updated !== 'object' || Array.isArray(updated)) {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    } else if (updated.type === 'text' && updated.file && typeof updated.file.content === 'string') {
      if (scrubStringField(updated.file, 'content', scrubOpts, acc)) modified = true;
      if (scrubStringField(updated.file, 'filePath', scrubOpts, acc)) modified = true;
    } else if (
      updated.type === 'notebook' &&
      updated.file &&
      Array.isArray(updated.file.cells)
    ) {
      const cellsRes = scrubDeepAllStrings(updated.file.cells, scrubOpts, acc);
      if (cellsRes.modified) {
        updated.file.cells = cellsRes.value;
        modified = true;
      }
      if (scrubStringField(updated.file, 'filePath', scrubOpts, acc)) modified = true;
    } else if (
      updated.type === 'image' ||
      updated.type === 'pdf' ||
      updated.type === 'parts'
    ) {
      skippedReason = 'BINARY_MEDIA_VARIANT';
      if (updated.file && scrubStringField(updated.file, 'filePath', scrubOpts, acc)) {
        modified = true;
      }
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (
    normTool === 'bash' ||
    normTool === 'powershell' ||
    normTool === 'pwsh' ||
    normTool === 'cmd' ||
    normTool === 'sh'
  ) {
    if (updated && typeof updated === 'object' && ('stdout' in updated || 'stderr' in updated)) {
      if (scrubStringField(updated, 'stdout', scrubOpts, acc)) modified = true;
      if (scrubStringField(updated, 'stderr', scrubOpts, acc)) modified = true;
      if (scrubStringField(updated, 'rawOutput', scrubOpts, acc)) modified = true;
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'grep') {
    if (
      updated &&
      typeof updated === 'object' &&
      ('filenames' in updated || 'content' in updated)
    ) {
      if (scrubStringField(updated, 'content', scrubOpts, acc)) modified = true;
      if (Array.isArray(updated.filenames)) {
        const fnRes = scrubDeepAllStrings(updated.filenames, scrubOpts, acc);
        if (fnRes.modified) {
          updated.filenames = fnRes.value;
          modified = true;
        }
      }
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'glob') {
    if (updated && typeof updated === 'object' && 'filenames' in updated) {
      if (Array.isArray(updated.filenames)) {
        const fnRes = scrubDeepAllStrings(updated.filenames, scrubOpts, acc);
        if (fnRes.modified) {
          updated.filenames = fnRes.value;
          modified = true;
        }
      }
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'edit' || normTool === 'multiedit') {
    if (
      updated &&
      typeof updated === 'object' &&
      ('newString' in updated || 'oldString' in updated || 'originalFile' in updated || 'structuredPatch' in updated || 'filePath' in updated)
    ) {
      if (scrubStringField(updated, 'oldString', scrubOpts, acc)) modified = true;
      if (scrubStringField(updated, 'newString', scrubOpts, acc)) modified = true;
      if (scrubStringField(updated, 'originalFile', scrubOpts, acc)) modified = true;
      if (Array.isArray(updated.structuredPatch)) {
        const patchRes = scrubDeepAllStrings(updated.structuredPatch, scrubOpts, acc);
        if (patchRes.modified) {
          updated.structuredPatch = patchRes.value;
          modified = true;
        }
      }
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'write') {
    if (
      updated &&
      typeof updated === 'object' &&
      ('content' in updated || 'originalFile' in updated || 'structuredPatch' in updated || 'filePath' in updated)
    ) {
      if (scrubStringField(updated, 'content', scrubOpts, acc)) modified = true;
      if (scrubStringField(updated, 'originalFile', scrubOpts, acc)) modified = true;
      if (Array.isArray(updated.structuredPatch)) {
        const patchRes = scrubDeepAllStrings(updated.structuredPatch, scrubOpts, acc);
        if (patchRes.modified) {
          updated.structuredPatch = patchRes.value;
          modified = true;
        }
      }
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'notebookedit') {
    if (
      updated &&
      typeof updated === 'object' &&
      ('new_source' in updated || 'cell_id' in updated || 'notebook_path' in updated || 'cell_type' in updated || 'error' in updated)
    ) {
      if (scrubStringField(updated, 'new_source', scrubOpts, acc)) modified = true;
      if (scrubStringField(updated, 'error', scrubOpts, acc)) modified = true;
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'webfetch') {
    if (updated && typeof updated === 'object' && 'result' in updated) {
      if (scrubStringField(updated, 'result', scrubOpts, acc)) modified = true;
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'websearch') {
    if (updated && typeof updated === 'object' && 'results' in updated) {
      if (scrubStringField(updated, 'query', scrubOpts, acc)) modified = true;
      const wsRes = scrubDeepAllStrings(updated.results, scrubOpts, acc, new Set(['tool_use_id']));
      if (wsRes.modified) {
        updated.results = wsRes.value;
        modified = true;
      }
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool === 'agent' || normTool === 'task') {
    if (
      updated &&
      typeof updated === 'object' &&
      'status' in updated &&
      ('content' in updated || 'outputFile' in updated || 'prompt' in updated)
    ) {
      if (scrubStringField(updated, 'prompt', scrubOpts, acc)) modified = true;
      if (Array.isArray(updated.content)) {
        const agRes = scrubDeepAllStrings(updated.content, scrubOpts, acc);
        if (agRes.modified) {
          updated.content = agRes.value;
          modified = true;
        }
      }
    } else {
      schemaDriftDetected = true;
      const fallback = scrubDeepAllStrings(updated, scrubOpts, acc);
      updated = fallback.value;
      modified = fallback.modified;
    }
  } else if (normTool.startsWith('mcp__')) {
    const mcpRes = scrubDeepAllStrings(updated, scrubOpts, acc);
    updated = mcpRes.value;
    modified = mcpRes.modified;
  } else {
    const genRes = scrubDeepAllStrings(updated, scrubOpts, acc);
    updated = genRes.value;
    modified = genRes.modified;
  }

  return {
    modified,
    updatedToolOutput: modified ? updated : rawResp,
    matches: acc.matches,
    auditOnlyMatches: acc.auditOnlyMatches,
    uniqueEntityHmacs: Array.from(acc.hmacSet),
    schemaDriftDetected,
    skippedReason
  };
}
