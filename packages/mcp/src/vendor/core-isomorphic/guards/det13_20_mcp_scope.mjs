/**
 * @file src/core-isomorphic/guards/det13_20_mcp_scope.mjs
 * MCP Schema Bloat, Premature Stop, Format Batch, Subagent Recursion, Auto-Compaction, Settings Guard, IPI Sanitizer & Scope Lock (`DET-13`..`DET-20`).
 * Pure-V8 isomorphic ESM module (zero `node:*` imports).
 */

import { path, getCwd, readJsonSafe, writeJsonAtomic } from '../utils/runtime.mjs';
import {
  FLIGHT_MODES,
  normalizeFlightMode,
  isSilentOrOffMode
} from '../coach/cacheGravityRouter.mjs';
import { RELAY_STATES } from '../coach/promptHygieneGovernor.mjs';
import { evaluateScopeAndQuotaBrake } from '../telemetry/scopeLockRegistry.mjs';
import { EDIT_WRITE_TOOL_REGEX } from './det01_03_shell_secret.mjs';

/**
 * DET-13: MCP Schema Bloat (`> 15k` startup tokens / `20+` tools) & `tools_changed` Cache-Miss Guard.
 *
 * @param {object} [params={}]
 * @param {number} [params.mcpSchemaTokens=0]
 * @param {number} [params.mcpToolCount=0]
 * @param {string|null} [params.lastMissCause=null]
 * @param {boolean} [params.toolsChanged=false]
 * @param {boolean} [params.cacheWarm=false]
 */
export function evaluateDet13McpSchemaBloatGuard(params = {}) {
  const mcpSchemaTokens = Math.max(0, Number(params.mcpSchemaTokens || 0));
  const mcpToolCount = Math.max(0, Number(params.mcpToolCount || 0));
  const bundledSkillsTokens = Math.max(0, Number(params.bundledSkillsTokens || 0));
  const syncedSkillsTokens = Math.max(0, Number(params.syncedSkillsTokens || 0));
  const claudeMdTokens = Math.max(0, Number(params.claudeMdTokens || 0));
  const turnsElapsed = Math.max(0, Number(params.turnsElapsed || 0));
  const mcpInvocations = Math.max(0, Number(params.mcpInvocations || 0));
  const turn0StaticPrefillBreakdown = {
    bundledSkillsTokens,
    syncedSkillsTokens,
    mcpSchemaTokens,
    claudeMdTokens,
    totalStaticPrefillTokens:
      bundledSkillsTokens + syncedSkillsTokens + mcpSchemaTokens + claudeMdTokens
  };

  const lastMissCause =
    params.lastMissCause || (params.toolsChanged ? 'tools_changed' : null);

  if (lastMissCause === 'tools_changed') {
    return {
      detectorId: 'DET-13',
      triggered: true,
      decision: 'defer_mcp_mutation',
      advisory: true,
      subType: 'TOOLS_CHANGED_CACHE_MISS',
      mcpSchemaTokens,
      mcpToolCount,
      turn0StaticPrefillBreakdown,
      reason: `[DET-13 MCP Cache-Miss Guard] Mid-session MCP "tools_changed" invalidated the warm prompt cache prefix. Queue dynamic MCP registrations in PostCompactMutationQueue.`
    };
  }

  const idleMcpHoarding5Turns =
    mcpSchemaTokens >= 15_000 && turnsElapsed >= 5 && mcpInvocations === 0;

  if (idleMcpHoarding5Turns) {
    return {
      detectorId: 'DET-13',
      triggered: true,
      decision: 'advise_lazy_mcp',
      advisory: true,
      subType: 'IDLE_MCP_HOARDING_5_TURNS',
      recommendedEnv: 'ENABLE_TOOL_SEARCH=auto:5',
      mcpSchemaTokens,
      mcpToolCount,
      turn0StaticPrefillBreakdown,
      reason: `[DET-13 Idle MCP Hoarding] ${mcpSchemaTokens.toLocaleString()} MCP schema tokens injected with 0 invocations across ${turnsElapsed} turns (Turn-0 prefill = ${turn0StaticPrefillBreakdown.totalStaticPrefillTokens.toLocaleString()} tok). Set ENABLE_TOOL_SEARCH=auto:5 or disable unused MCP servers.`
    };
  }

  if (mcpSchemaTokens > 15_000 || mcpToolCount >= 20) {
    return {
      detectorId: 'DET-13',
      triggered: true,
      decision: 'advise_lazy_mcp',
      advisory: true,
      subType: 'MCP_SCHEMA_BLOAT',
      recommendedEnv: 'ENABLE_TOOL_SEARCH=auto:5',
      mcpSchemaTokens,
      mcpToolCount,
      turn0StaticPrefillBreakdown,
      reason: `[DET-13 MCP Schema Bloat] ${mcpToolCount} MCP tools consuming ${mcpSchemaTokens.toLocaleString()} startup tokens (> 15k cap). Set ENABLE_TOOL_SEARCH=auto:5 or disable unused MCP servers.`
    };
  }

  return {
    detectorId: 'DET-13',
    triggered: false,
    decision: 'allow',
    mcpSchemaTokens,
    mcpToolCount,
    turn0StaticPrefillBreakdown,
    reason: null
  };
}

/**
 * DET-14: Premature Completion `Stop` Gate.
 * Strictly checks `stop_hook_active` first to prevent infinite loops.
 * Advisory in `COACH` mode; blocks `Stop` in `AUTO_PILOT` mode only when code was edited without running tests.
 *
 * @param {object} [params={}]
 * @param {boolean} [params.stopHookActive=false]
 * @param {boolean} [params.codeEditedSinceLastTest=false]
 * @param {Array<string>} [params.editedFiles=[]]
 * @param {'OFF'|'SILENT'|'COACH'|'AUTO_PILOT'} [params.mode='COACH']
 */
export function evaluateDet14PrematureStopGate(params = {}) {
  const stopHookActive = Boolean(params.stopHookActive ?? params.stop_hook_active ?? false);
  const mode = normalizeFlightMode(params.mode || FLIGHT_MODES.COACH);
  const editedFiles = Array.isArray(params.editedFiles) ? params.editedFiles : [];
  const codeEditedSinceLastTest = Boolean(
    params.codeEditedSinceLastTest ?? editedFiles.length > 0
  );

  // Loop-safety invariant: NEVER block when `stop_hook_active` is already true
  if (stopHookActive) {
    return {
      detectorId: 'DET-14',
      triggered: false,
      stopHookActive: true,
      decision: 'allow',
      advisory: false,
      reason: null
    };
  }

  if (!codeEditedSinceLastTest || isSilentOrOffMode(mode)) {
    return {
      detectorId: 'DET-14',
      triggered: false,
      stopHookActive: false,
      decision: 'allow',
      advisory: false,
      reason: null
    };
  }

  const fileSummary = editedFiles.slice(0, 4).join(', ') || 'workspace source files';

  if (mode === FLIGHT_MODES.COACH) {
    return {
      detectorId: 'DET-14',
      triggered: true,
      stopHookActive: false,
      decision: 'allow',
      advisory: true,
      reason: `[DET-14 Verification Advisory] Modified ${fileSummary} without running tests in this turn.`
    };
  }

  // AUTO_PILOT mode: block premature Stop once
  return {
    detectorId: 'DET-14',
    triggered: true,
    stopHookActive: false,
    decision: 'block',
    advisory: false,
    reason: `[DET-14 Premature Stop Gate] Modified ${fileSummary} without running verification tests. Run the relevant unit test suite before completing the turn.`
  };
}

/**
 * DET-15: Batched `Stop`-Phase Formatter.
 * Collects modified files during the turn so formatting can run once at `Stop` instead of after every edit.
 *
 * @param {object} [params={}]
 * @param {Array<string>} [params.modifiedFiles=[]]
 */
export function evaluateDet15BatchedStopFormatter(params = {}) {
  const files = Array.from(new Set(params.modifiedFiles || []))
    .map((f) => String(f).trim())
    .filter((f) => /\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|css|html)$/i.test(f));

  if (files.length === 0) {
    const cmd = String(params.command || params.cmd || '').trim();
    if (
      cmd &&
      /\b(?:prettier\s+(?:--write|-w)|biome\s+format\s+--write|gofmt\s+-w|rustfmt)\b/i.test(cmd)
    ) {
      return {
        detectorId: 'DET-15',
        triggered: true,
        filesToFormat: [],
        batchCommand: cmd
      };
    }
    return {
      detectorId: 'DET-15',
      triggered: false,
      filesToFormat: [],
      batchCommand: null
    };
  }

  return {
    detectorId: 'DET-15',
    triggered: true,
    filesToFormat: files,
    batchCommand: `npx prettier --write ${files.map((f) => `"${f}"`).join(' ')}`
  };
}

/**
 * DET-15: Pre-Invocation / Pre-Tool-Use Local CLI Formatter Bypass Advisory.
 * Emits advisory recommending local `npx prettier --write` / `npx eslint --fix` on pasted >=40-line blocks.
 *
 * @param {object} [params={}]
 */
export function evaluateDet15PreFormatBypass(params = {}) {
  const prompt = String(params.prompt || params.userPrompt || '');
  const newText = String(params.newText || '');
  const lineCount = Number(
    params.lineCount ??
    (newText ? newText.split(/\r?\n/).length : (prompt.match(/\r?\n/g) || []).length)
  );
  const isFormattingIntent = /\b(fix\s+(?:the\s+)?indentation|sort\s+(?:the\s+)?imports|format\s+this\s+(?:code|file|block)|convert\s+tabs\s+to\s+spaces|run\s+prettier)\b/i.test(prompt);

  if (isFormattingIntent && lineCount >= 40 && !/\b(add|implement|refactor|create|fix\s+bug|logic|test|calculate)\b/i.test(prompt)) {
    return {
      detectorId: 'DET-15',
      triggered: true,
      subType: 'LOCAL_FORMATTER_BYPASS',
      decision: 'allow',
      advisory: true,
      reason: '[DET-15 Local Formatter Bypass] Prompt requests code formatting / import sorting on a pasted code block. Run `npx prettier --write <file>` or `npx eslint --fix <file>` directly (0 LLM tokens).'
    };
  }

  return { detectorId: 'DET-15', triggered: false, decision: 'allow' };
}

/**
 * DET-16: Subagent Token (`40k`) & Turn (`12`) Recursion Cap.
 *
 * @param {object} [params={}]
 * @param {string} [params.agentId]
 * @param {number} [params.turns=0]
 * @param {number} [params.totalTokens=0]
 * @param {number} [params.maxTurns=12]
 * @param {number} [params.maxTokens=40000]
 */
export function evaluateDet16SubagentRecursionCap(params = {}) {
  const agentId = params.agentId || null;
  if (!agentId) {
    return { detectorId: 'DET-16', triggered: false, decision: 'allow', reason: null };
  }

  const turns = Math.max(0, Number(params.turns || 0));
  const totalTokens = Math.max(0, Number(params.totalTokens || 0));
  const maxTurns = Number(params.maxTurns ?? 12);
  const maxTokens = Number(params.maxTokens ?? 40_000);

  if (turns >= maxTurns || totalTokens >= maxTokens) {
    return {
      detectorId: 'DET-16',
      triggered: true,
      decision: 'deny',
      agentId,
      turns,
      totalTokens,
      reason: `[DET-16 Subagent Recursion Cap] Subagent "${agentId}" reached ${turns}/${maxTurns} turns and ${totalTokens.toLocaleString()}/${maxTokens.toLocaleString()} tokens. Terminate exploration and return synthesized summary immediately.`
    };
  }

  return {
    detectorId: 'DET-16',
    triggered: false,
    decision: 'allow',
    agentId,
    turns,
    totalTokens,
    reason: null
  };
}

/**
 * DET-17: Untimely Auto-Compaction Deferral (`PreCompact` `auto` mid-batch syntax guard).
 *
 * @param {object} [params={}]
 * @param {'auto'|'manual'} [params.trigger='auto']
 * @param {boolean} [params.midBatchEditInProgress=false]
 * @param {boolean} [params.unbalancedSyntaxDetected=false]
 */
export function evaluateDet17AutoCompactionDeferral(params = {}) {
  const trigger = String(params.trigger || 'auto').toLowerCase();
  const midBatch = Boolean(params.midBatchEditInProgress || params.unbalancedSyntaxDetected);
  const cacheExpired = Boolean(params.cacheExpired);
  const cachedTokens = Math.max(0, Number(params.cachedTokens ?? params.cached_tokens ?? 0));

  if (cacheExpired && cachedTokens >= 25_000) {
    return {
      detectorId: 'DET-17',
      subType: 'COLD_CACHE_COMPACT_BLOCKED',
      triggered: true,
      decision: 'defer',
      reason: `[DET-17 Cold-Cache /compact Guard] Prompt cache TTL has expired (${cachedTokens.toLocaleString()} cold tokens). Running /compact now would pay full uncached input rates to summarize stale history — flush a <300-token StateBaton and /clear instead.`
    };
  }

  if (trigger === 'auto' && midBatch) {
    return {
      detectorId: 'DET-17',
      subType: 'MID_BATCH_DEFERRED',
      triggered: true,
      decision: 'defer',
      reason: `[DET-17 Auto-Compaction Deferred] Deferring automatic compaction while a multi-file edit batch or syntax repair is in progress.`
    };
  }

  return {
    detectorId: 'DET-17',
    triggered: false,
    decision: 'allow',
    reason: null
  };
}

/**
 * Pure zero-I/O evaluator for Silent Prefix Mutations (`Sim 01` & `Sim 16` in Claude Code):
 *  - `LATE_MCP_CONNECT`: MCP server count or schema hash changing after Turn 1
 *  - `MEMORY_MD_MID_THREAD_MUTATION`: Mid-thread `MEMORY.md` hash/byte change (up to 25KB)
 *  - `IDE_STATE_PREFIX_MUTATION`: Dynamic IDE state injected into system prefix instead of user-turn tail
 *  - `LOOKBACK_WINDOW_DELETION`: Message deletion inside 20-block lookback window shifting cached suffix
 */
export function evaluateSilentPrefixMutations(params = {}) {
  const turn = Math.max(1, Number(params.turnCount || 1));
  const subTypes = [];
  const details = [];
  let shiftedSuffixTokens = 0;

  if (turn > 1) {
    const mcpCountChanged =
      params.prevMcpServerCount != null &&
      params.currMcpServerCount != null &&
      Number(params.prevMcpServerCount) !== Number(params.currMcpServerCount);
    const mcpHashChanged =
      Boolean(params.prevMcpSchemaHash && params.currMcpSchemaHash) &&
      String(params.prevMcpSchemaHash) !== String(params.currMcpSchemaHash);
    if (mcpCountChanged || mcpHashChanged) {
      subTypes.push('LATE_MCP_CONNECT');
      details.push(
        `Mid-session MCP server/schema change at Turn ${turn} (${params.prevMcpServerCount ?? '?'} -> ${params.currMcpServerCount ?? '?'} servers)`
      );
    }

    const memHashChanged =
      Boolean(params.prevMemoryMdHash && params.currMemoryMdHash) &&
      String(params.prevMemoryMdHash) !== String(params.currMemoryMdHash);
    const memBytesChanged =
      params.prevMemoryMdBytes != null &&
      params.currMemoryMdBytes != null &&
      Number(params.prevMemoryMdBytes) !== Number(params.currMemoryMdBytes);
    if (memHashChanged || memBytesChanged) {
      subTypes.push('MEMORY_MD_MID_THREAD_MUTATION');
      const kb =
        params.currMemoryMdBytes != null
          ? `${(Number(params.currMemoryMdBytes) / 1024).toFixed(1)}KB`
          : 'updated';
      details.push(`Mid-thread MEMORY.md mutation (${kb}) invalidated static system prefix`);
    }

    const ideHashChanged =
      Boolean(params.prevIdePrefixHash && params.currIdePrefixHash) &&
      String(params.prevIdePrefixHash) !== String(params.currIdePrefixHash);
    if (Boolean(params.ideStateInSystemPrefix) || ideHashChanged) {
      subTypes.push('IDE_STATE_PREFIX_MUTATION');
      details.push(
        'Dynamic IDE state (active tab / highlighted lines / Problems diagnostics) injected into system prefix instead of user-turn tail'
      );
    }
  }

  if (
    Array.isArray(params.prevMessageIds) &&
    Array.isArray(params.currMessageIds) &&
    params.prevMessageIds.length > 0
  ) {
    const currSet = new Set(params.currMessageIds);
    let firstDeletedIdx = -1;
    let deletedCount = 0;
    for (let i = 0; i < params.prevMessageIds.length; i++) {
      if (!currSet.has(params.prevMessageIds[i])) {
        if (firstDeletedIdx === -1) firstDeletedIdx = i;
        deletedCount += 1;
      }
    }
    if (firstDeletedIdx !== -1) {
      const remaining = Math.max(0, params.prevMessageIds.length - firstDeletedIdx - deletedCount);
      if (Array.isArray(params.tokensPerMessage)) {
        for (let j = firstDeletedIdx + deletedCount; j < params.prevMessageIds.length; j++) {
          shiftedSuffixTokens += Math.max(0, Number(params.tokensPerMessage[j] || 0));
        }
      } else {
        shiftedSuffixTokens = remaining * Math.max(1, Number(params.tokensPerMessage || 5000));
      }
      subTypes.push('LOOKBACK_WINDOW_DELETION');
      details.push(
        `Deleted ${deletedCount} historical message(s) starting at index ${firstDeletedIdx}, shifting ${shiftedSuffixTokens.toLocaleString()} suffix tokens outside 20-block lookback window`
      );
    }
  }

  const triggered = subTypes.length > 0;
  const detectorId = subTypes.includes('LOOKBACK_WINDOW_DELETION')
    ? 'DET-09'
    : subTypes.includes('LATE_MCP_CONNECT')
      ? 'DET-13'
      : 'DET-09';

  return {
    detectorId,
    triggered,
    subTypes,
    shiftedSuffixTokens:
      shiftedSuffixTokens || (triggered ? Math.max(0, Number(params.cachedTokens || 0)) : 0),
    details,
    reason: triggered ? `[${detectorId} Silent Prefix Mutation] ${details.join('; ')}.` : null
  };
}

/**
 * DET-18: Untrusted Project `settings.json` Hook CVE & Clobber Guard.
 *
 * @param {object} [params={}]
 * @param {string} [params.toolName='Write']
 * @param {string} [params.filePath='']
 * @param {string} [params.newText='']
 */
export function evaluateDet18UntrustedSettingsGuard(params = {}) {
  const filePath = String(params.filePath || params.path || '').trim().replace(/\\/g, '/');
  if (!/(?:^|\/)\.claude\/settings(?:\.local)?\.json$/i.test(filePath)) {
    return { detectorId: 'DET-18', triggered: false, decision: 'allow', reason: null };
  }

  const content = String(params.newText || params.content || '');
  const suspiciousHookRegex =
    /(?:\bcurl\b.*\|\s*(?:sh|bash|pwsh)|\bwget\b.*\|\s*(?:sh|bash)|\bInvoke-Expression\b|\biex\b\s*\(|\bnc\s+-e\b|\bbase64\s+-d\b.*\|\s*(?:sh|bash))/i;

  if (suspiciousHookRegex.test(content)) {
    return {
      detectorId: 'DET-18',
      triggered: true,
      decision: 'deny',
      subType: 'MALICIOUS_SETTINGS_HOOK_CVE',
      targetPath: filePath,
      reason: `[DET-18 Untrusted Settings CVE Guard] Blocked suspicious remote shell execution payload in "${filePath}".`
    };
  }

  if (EDIT_WRITE_TOOL_REGEX.test(String(params.toolName || 'Write')) && !params.hasBackup) {
    return {
      detectorId: 'DET-18',
      triggered: true,
      decision: 'ask',
      subType: 'SETTINGS_CLOBBER_GUARD',
      targetPath: filePath,
      reason: `[DET-18 Settings Clobber Guard] Direct modification of "${filePath}" requires user confirmation (or use "npx ah-claude install" for non-destructive backup merge).`
    };
  }

  return { detectorId: 'DET-18', triggered: false, decision: 'allow', reason: null };
}

/**
 * DET-19: Subagent Indirect Prompt Injection (IPI) & Untrusted URL Exfiltration Sanitizer (`ISS-053`).
 * - Neutralizes XML boundary breakout tags (`</untrusted_subagent_data>`, `<untrusted_subagent_output>`) BEFORE wrapping.
 * - Strips Unicode tag characters (`U+E0000`..`U+E007F`), zero-width/bidi override & isolate chars (`U+200B`..`U+200F`,
 *   `U+202A`..`U+202E`, `U+2060`..`U+2069`, `U+061C`, `U+FEFF`), general HTML comments (`<!-- ... -->`),
 *   `<script>`/`<style>` blocks, `data:text/html` / `application/javascript` URIs, chat template tokens,
 *   and line-leading prompt-injection role spoof headers.
 * - Counts stripped/neutralized source characters BEFORE replacement substitution so `strippedCharCount > 0`
 *   whenever any injection vector is neutralized.
 * - Wraps subagent / untrusted data in `<untrusted_subagent_data trust="untrusted" readonly="true">...</untrusted_subagent_data>`.
 * - Blocks `WebFetch` URLs attempting to exfiltrate secrets/tokens in query strings.
 *
 * @param {object} [params={}]
 * @param {string} [params.text='']
 * @param {string} [params.url='']
 * @param {boolean} [params.wrapUntrusted=true]
 */
export function evaluateDet19SubagentIpiSanitizer(params = {}) {
  const urlStr = String(params.url || '').trim();
  if (urlStr) {
    if (
      /(?:api[_-]?key|secret|token|password|authorization|aws_access_key|sk-ant-)[=:]\S+/i.test(
        urlStr
      ) ||
      /\$\{?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\}?/i.test(urlStr)
    ) {
      return {
        detectorId: 'DET-19',
        triggered: true,
        blocked: true,
        hadInjectionMarkers: false,
        decision: 'deny',
        subType: 'URL_EXFILTRATION_BLOCKED',
        sanitizedText: '',
        strippedCharCount: 0,
        reason: `[DET-19 Untrusted URL Exfiltration Blocked] Outbound request URL contains credential or environment secret interpolation.`
      };
    }
  }

  const rawText = String(params.text ?? '');
  if (!rawText) {
    return {
      detectorId: 'DET-19',
      triggered: false,
      blocked: false,
      hadInjectionMarkers: false,
      decision: 'allow',
      sanitizedText: '',
      strippedCharCount: 0,
      reason: null
    };
  }

  let strippedCharCount = 0;
  let hadInjectionMarkers = false;

  const stripEmpty = (text, regex) =>
    text.replace(regex, (match) => {
      strippedCharCount += match.length;
      hadInjectionMarkers = true;
      return '';
    });

  const stripWithMarker = (text, regex, replacement = '[STRIPPED_IPI_MARKER]') =>
    text.replace(regex, (match) => {
      strippedCharCount += match.length;
      hadInjectionMarkers = true;
      return replacement;
    });

  // 1. Neutralize closing/opening XML boundary tags FIRST so untrusted payloads can NEVER break out
  const boundaryTagRegex = /<\s*\/?\s*untrusted_subagent_(?:data|output)\b[^>]*>/gi;
  let cleaned = rawText.replace(boundaryTagRegex, (match) => {
    strippedCharCount += match.length;
    hadInjectionMarkers = true;
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });

  // 2. Strip Unicode Tags (U+E0000..U+E007F) and zero-width / bidi overrides & isolates / Arabic Letter Mark (U+061C)
  cleaned = stripEmpty(cleaned, /[\u{E0000}-\u{E007F}]/gu);
  cleaned = stripEmpty(cleaned, /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g);

  // 3. Strip general HTML comments, <script>, <style>, executable data: URIs, and chat template tokens
  cleaned = stripWithMarker(cleaned, /<!--[\s\S]*?-->/g);
  cleaned = stripWithMarker(cleaned, /<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi);
  cleaned = stripWithMarker(cleaned, /<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi);
  cleaned = stripWithMarker(
    cleaned,
    /data:(?:text\/(?:html|javascript)|application\/(?:javascript|x-javascript)|image\/svg\+xml)[^,\s"')]*(?:,[^\s"')>]+)?/gi
  );
  cleaned = stripWithMarker(
    cleaned,
    /<\|(?:im_start|im_end|endoftext|assistant|system|user|startoftext|extra_\d+)\|>/gi
  );

  // 4. Neutralize line-leading prompt-injection role spoof headers
  cleaned = cleaned.replace(
    /(^|\n)([ \t]*(?:SYSTEM|DEVELOPER|IMPORTANT\s+INSTRUCTION|IGNORE\s+(?:ALL\s+)?PREVIOUS\s+INSTRUCTIONS)[ \t]*:)/gi,
    (_full, prefix, roleHeader) => {
      strippedCharCount += roleHeader.length;
      hadInjectionMarkers = true;
      return `${prefix}[STRIPPED_IPI_MARKER]:`;
    }
  );

  if (params.wrapUntrusted !== false) {
    cleaned = `<untrusted_subagent_data trust="untrusted" readonly="true">\n${cleaned}\n</untrusted_subagent_data>`;
  }

  return {
    detectorId: 'DET-19',
    triggered: hadInjectionMarkers,
    blocked: false,
    hadInjectionMarkers,
    decision: 'allow',
    subType: hadInjectionMarkers ? 'IPI_PAYLOAD_SANITIZED' : null,
    sanitizedText: cleaned,
    strippedCharCount,
    reason: hadInjectionMarkers
      ? `[DET-19 Subagent IPI Sanitizer] Neutralized ${strippedCharCount} char(s) of hidden Unicode / XML boundary / prompt-injection markers and wrapped output in <untrusted_subagent_data trust="untrusted" readonly="true">.`
      : null
  };
}

/**
 * DET-20: Concurrent Multi-Agent File-Scope Lockfile + Quota Hard Brake.
 * Wrapper delegating to `evaluateScopeAndQuotaBrake` in `src/telemetry/scopeLockRegistry.mjs`.
 */
export function evaluateDet20ScopeLockAndQuotaBrake(params = {}, options = {}) {
  return evaluateScopeAndQuotaBrake(params, options);
}

/**
 * Sanitizes a session ID for `.claude/cache/ah_breaker_state_<sessionId>.json`.
 * @param {string} [sessionId='default']
 * @returns {string}
 */
export function sanitizeBreakerSessionId(sessionId = 'default') {
  return String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Resolves the atomic CLI circuit-breaker state file path (`.claude/cache/ah_breaker_state_<sessionId>.json`).
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {string}
 */
export function getBreakerStateFilePath(sessionId = 'default', options = {}) {
  if (options?.breakerStatePath) {
    return options.breakerStatePath;
  }
  const cwd = getCwd(options);
  return path.join(
    cwd,
    '.claude',
    'cache',
    `ah_breaker_state_${sanitizeBreakerSessionId(sessionId)}.json`
  );
}

/**
 * Safely reads a persisted `CircuitBreakerEngine` snapshot from disk (`ISS-038`).
 * @param {string} [sessionId='default']
 * @param {object} [options={}]
 * @returns {object | null}
 */
export function readBreakerStateSnapshot(sessionId = 'default', options = {}) {
  return readJsonSafe(getBreakerStateFilePath(sessionId, options), null, options);
}

/**
 * Atomically writes a `CircuitBreakerEngine` snapshot to disk (`ISS-038`).
 * @param {string} [sessionId='default']
 * @param {object} [snapshot={}]
 * @param {object} [options={}]
 * @returns {boolean}
 */
export function writeBreakerStateSnapshot(sessionId = 'default', snapshot = {}, options = {}) {
  return writeJsonAtomic(getBreakerStateFilePath(sessionId, options), snapshot, options);
}

/**
 * Exports a serializable snapshot of a `CircuitBreakerEngine` instance (`ISS-038`).
 * @param {object} engine
 * @returns {object}
 */
export function serializeCircuitBreakerState(engine) {
  const hashObj = {};
  for (const [k, v] of engine.fileHashHistory.entries()) {
    hashObj[k] = Array.isArray(v) ? [...v] : [];
  }
  return {
    schemaVersion: '1.0.0',
    updatedAt: Date.now(),
    mode: engine.mode,
    consecutiveFailures: engine.consecutiveFailures,
    lastFailedToolKey: engine.lastFailedToolKey,
    sequentialSearchCount: engine.sequentialSearchCount,
    fileHashHistory: hashObj,
    modifiedFilesInTurn: Array.from(engine.modifiedFilesInTurn),
    editedFiles: Array.from(engine.modifiedFilesInTurn),
    unverifiedEdits: Array.isArray(engine.unverifiedEdits) ? engine.unverifiedEdits.slice(-32) : [],
    turnFileDiffs: Array.isArray(engine.turnFileDiffs) ? engine.turnFileDiffs.slice(-32) : [],
    pendingBatchEdits: Array.from(engine.pendingBatchEdits),
    pendingFormatFiles: Array.from(engine.pendingFormatFiles),
    codeEditedSinceLastTest: Boolean(engine.codeEditedSinceLastTest),
    pendingVerificationCommand: Boolean(engine.pendingVerificationCommand),
    lastFailingLocation: engine.lastFailingLocation || null,
    pendingDownshiftModel: engine.pendingDownshiftModel || null,
    pending_downshift: engine.pending_downshift ? { ...engine.pending_downshift } : null,
    justCompacted: Boolean(engine.justCompacted),
    turnsSinceLastCompact:
      typeof engine.turnsSinceLastCompact === 'number' && Number.isFinite(engine.turnsSinceLastCompact)
        ? Math.max(0, engine.turnsSinceLastCompact)
        : null,
    taskBoundaryState: engine.taskBoundaryState
      ? {
          openFailure: Boolean(engine.taskBoundaryState.openFailure),
          editsSinceBoundary: Math.max(0, Number(engine.taskBoundaryState.editsSinceBoundary || 0)),
          lastBoundarySuggestedTurn: engine.taskBoundaryState.lastBoundarySuggestedTurn ?? null
        }
      : { openFailure: false, editsSinceBoundary: 0, lastBoundarySuggestedTurn: null },
    lastToolsetHash: engine.lastToolsetHash ? { ...engine.lastToolsetHash } : null,
    lastContextTokens:
      typeof engine.lastContextTokens === 'number' && Number.isFinite(engine.lastContextTokens)
        ? Math.max(0, engine.lastContextTokens)
        : null,
    lastModelId: engine.lastModelId ? String(engine.lastModelId) : null,
    activeBackgroundTasks: Array.isArray(engine.activeBackgroundTasks)
      ? [...engine.activeBackgroundTasks]
      : [],
    activeWriteWorkers: Array.isArray(engine.activeWriteWorkers)
      ? [...engine.activeWriteWorkers]
      : [],
    lastUserPrompt: engine.lastUserPrompt || '',
    lastTurnGitCommitted: Boolean(engine.lastTurnGitCommitted),
    committedTopDirs: Array.isArray(engine.committedTopDirs) ? [...engine.committedTopDirs] : [],
    consecutiveTrivialMaxEffortTurns: engine.consecutiveTrivialMaxEffortTurns,
    recentEditTimestampsByFile: { ...engine.recentEditTimestampsByFile },
    totalDiscoveryCalls: engine.totalDiscoveryCalls,
    consecutiveVisionTurns: engine.consecutiveVisionTurns,
    unanchoredTurnFlag: Boolean(engine.unanchoredTurnFlag),
    candidateFiles: Array.isArray(engine.candidateFiles) ? [...engine.candidateFiles] : [],
    relayState: engine.relayState ? { ...engine.relayState } : { state: RELAY_STATES.IDLE, critiquePastes: 0, boundSpecPath: 'SPEC.md' },
    steeredPrompts: Number(engine.steeredPrompts || 0),
    blockedPrompts: Number(engine.blockedPrompts || 0),
    sightseeingToolsPrevented: Number(engine.sightseeingToolsPrevented || 0),
    subagentTurns: { ...engine.subagentTurns },
    subagentTokens: { ...engine.subagentTokens },
    det11AdvisedTurn: engine.det11AdvisedTurn,
    det13AdvisedTurn: engine.det13AdvisedTurn,
    queuedMutations: engine.router.mutationQueue.toJSON(),
    hysteresisState: engine.router.hysteresisLock.getStatus()
  };
}

/**
 * Hydrates stateful breaker counters and queues onto a `CircuitBreakerEngine` instance (`ISS-038`).
 * @param {object} engine
 * @param {object | null} snap
 * @returns {object}
 */
export function hydrateCircuitBreakerState(engine, snap) {
  if (!snap || typeof snap !== 'object') return engine;

  if (typeof snap.consecutiveFailures === 'number' && Number.isFinite(snap.consecutiveFailures)) {
    engine.consecutiveFailures = Math.max(0, snap.consecutiveFailures);
  }
  if (snap.lastFailedToolKey !== undefined) {
    engine.lastFailedToolKey = snap.lastFailedToolKey ? String(snap.lastFailedToolKey) : null;
  }
  if (
    typeof snap.sequentialSearchCount === 'number' &&
    Number.isFinite(snap.sequentialSearchCount)
  ) {
    engine.sequentialSearchCount = Math.max(0, snap.sequentialSearchCount);
  }
  if (snap.fileHashHistory && typeof snap.fileHashHistory === 'object') {
    engine.fileHashHistory = new Map();
    for (const [k, v] of Object.entries(snap.fileHashHistory)) {
      if (Array.isArray(v)) {
        engine.fileHashHistory.set(k, v.slice(-6).map(String));
      }
    }
  }
  const editedList = Array.isArray(snap.modifiedFilesInTurn)
    ? snap.modifiedFilesInTurn
    : Array.isArray(snap.editedFiles)
      ? snap.editedFiles
      : null;
  if (editedList) {
    engine.modifiedFilesInTurn = new Set(editedList.filter(Boolean).map(String));
  }
  if (Array.isArray(snap.unverifiedEdits)) {
    engine.unverifiedEdits = snap.unverifiedEdits
      .filter((e) => e && typeof e.filePath === 'string')
      .slice(-32)
      .map((e) => ({
        filePath: String(e.filePath),
        netLines: Math.max(0, Number(e.netLines) || 0),
        ...(Array.isArray(e.changedLines) ? { changedLines: e.changedLines.slice(0, 64).map(String) } : {})
      }));
  }
  if (Array.isArray(snap.turnFileDiffs)) {
    engine.turnFileDiffs = snap.turnFileDiffs
      .filter((e) => e && typeof e.filePath === 'string')
      .slice(-32)
      .map((e) => ({
        filePath: String(e.filePath),
        addedLines: Array.isArray(e.addedLines) ? e.addedLines.slice(0, 400).map(String) : [],
        deletedLineCount: Math.max(0, Number(e.deletedLineCount) || 0)
      }));
  }
  if (Array.isArray(snap.pendingBatchEdits)) {
    engine.pendingBatchEdits = new Set(snap.pendingBatchEdits.filter(Boolean).map(String));
  }
  if (Array.isArray(snap.pendingFormatFiles)) {
    engine.pendingFormatFiles = new Set(snap.pendingFormatFiles.filter(Boolean).map(String));
  }
  if (typeof snap.codeEditedSinceLastTest === 'boolean') {
    engine.codeEditedSinceLastTest = snap.codeEditedSinceLastTest;
  }
  if (typeof snap.pendingVerificationCommand === 'boolean') {
    engine.pendingVerificationCommand = snap.pendingVerificationCommand;
  }
  if (snap.lastFailingLocation !== undefined) {
    engine.lastFailingLocation = snap.lastFailingLocation ? String(snap.lastFailingLocation) : null;
  }
  if (snap.pendingDownshiftModel !== undefined) {
    engine.pendingDownshiftModel = snap.pendingDownshiftModel ? String(snap.pendingDownshiftModel) : null;
  }
  if (snap.pending_downshift !== undefined) {
    engine.pending_downshift =
      snap.pending_downshift && typeof snap.pending_downshift === 'object'
        ? { ...snap.pending_downshift }
        : null;
    if (engine.pending_downshift?.toModel && snap.pendingDownshiftModel === undefined) {
      engine.pendingDownshiftModel = String(engine.pending_downshift.toModel);
    }
  }
  if (typeof snap.justCompacted === 'boolean') {
    engine.justCompacted = snap.justCompacted;
  }
  if (snap.turnsSinceLastCompact !== undefined) {
    engine.turnsSinceLastCompact =
      snap.turnsSinceLastCompact !== null && Number.isFinite(Number(snap.turnsSinceLastCompact))
        ? Math.max(0, Number(snap.turnsSinceLastCompact))
        : null;
  }
  if (snap.taskBoundaryState && typeof snap.taskBoundaryState === 'object') {
    engine.taskBoundaryState = {
      openFailure: Boolean(snap.taskBoundaryState.openFailure),
      editsSinceBoundary: Math.max(0, Number(snap.taskBoundaryState.editsSinceBoundary || 0)),
      lastBoundarySuggestedTurn: snap.taskBoundaryState.lastBoundarySuggestedTurn ?? null
    };
  }
  if (snap.lastToolsetHash !== undefined) {
    engine.lastToolsetHash =
      snap.lastToolsetHash && typeof snap.lastToolsetHash === 'object'
        ? { ...snap.lastToolsetHash }
        : null;
  }
  if (snap.lastContextTokens !== undefined) {
    engine.lastContextTokens =
      snap.lastContextTokens !== null && Number.isFinite(Number(snap.lastContextTokens))
        ? Math.max(0, Number(snap.lastContextTokens))
        : null;
  }
  if (snap.lastModelId !== undefined) {
    engine.lastModelId = snap.lastModelId ? String(snap.lastModelId) : null;
  }
  if (Array.isArray(snap.activeBackgroundTasks)) {
    engine.activeBackgroundTasks = snap.activeBackgroundTasks.filter(Boolean).map(String);
  }
  if (Array.isArray(snap.activeWriteWorkers)) {
    engine.activeWriteWorkers = snap.activeWriteWorkers.filter(Boolean).map(String);
  }
  if (typeof snap.lastUserPrompt === 'string') {
    engine.lastUserPrompt = snap.lastUserPrompt;
  }
  if (typeof snap.lastTurnGitCommitted === 'boolean') {
    engine.lastTurnGitCommitted = snap.lastTurnGitCommitted;
  }
  if (Array.isArray(snap.committedTopDirs)) {
    engine.committedTopDirs = [...snap.committedTopDirs];
  }
  if (typeof snap.consecutiveTrivialMaxEffortTurns === 'number') {
    engine.consecutiveTrivialMaxEffortTurns = snap.consecutiveTrivialMaxEffortTurns;
  }
  if (snap.recentEditTimestampsByFile && typeof snap.recentEditTimestampsByFile === 'object') {
    engine.recentEditTimestampsByFile = { ...snap.recentEditTimestampsByFile };
  }
  if (typeof snap.totalDiscoveryCalls === 'number') {
    engine.totalDiscoveryCalls = snap.totalDiscoveryCalls;
  }
  if (typeof snap.consecutiveVisionTurns === 'number') {
    engine.consecutiveVisionTurns = snap.consecutiveVisionTurns;
  }
  if (typeof snap.unanchoredTurnFlag === 'boolean') {
    engine.unanchoredTurnFlag = snap.unanchoredTurnFlag;
  }
  if (Array.isArray(snap.candidateFiles)) {
    engine.candidateFiles = [...snap.candidateFiles];
  }
  if (snap.relayState && typeof snap.relayState === 'object') {
    engine.relayState = { ...snap.relayState };
  }
  if (typeof snap.steeredPrompts === 'number') {
    engine.steeredPrompts = snap.steeredPrompts;
  }
  if (typeof snap.blockedPrompts === 'number') {
    engine.blockedPrompts = snap.blockedPrompts;
  }
  if (typeof snap.sightseeingToolsPrevented === 'number') {
    engine.sightseeingToolsPrevented = snap.sightseeingToolsPrevented;
  }
  if (snap.subagentTurns && typeof snap.subagentTurns === 'object') {
    engine.subagentTurns = { ...snap.subagentTurns };
  }
  if (snap.subagentTokens && typeof snap.subagentTokens === 'object') {
    engine.subagentTokens = { ...snap.subagentTokens };
  }
  if (snap.det11AdvisedTurn !== undefined) {
    engine.det11AdvisedTurn = snap.det11AdvisedTurn;
  }
  if (snap.det13AdvisedTurn !== undefined) {
    engine.det13AdvisedTurn = snap.det13AdvisedTurn;
  }
  if (Array.isArray(snap.queuedMutations)) {
    engine.router.mutationQueue.items = [...snap.queuedMutations];
  }
  if (snap.hysteresisState && typeof snap.hysteresisState === 'object') {
    engine.router.hysteresisLock.locked = Boolean(snap.hysteresisState.locked);
    engine.router.hysteresisLock.pinnedModel = snap.hysteresisState.pinnedModel || null;
    engine.router.hysteresisLock.pinnedEffort = snap.hysteresisState.pinnedEffort || null;
    engine.router.hysteresisLock.reason = snap.hysteresisState.reason || null;
    engine.router.hysteresisLock.lockedAtTurn = snap.hysteresisState.lockedAtTurn ?? null;
  }
  return engine;
}
