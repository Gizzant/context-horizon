/**
 * @file src/core-isomorphic/guards/det13_20_mcp_scope.mjs
 * MCP Schema Bloat, Premature Stop, Format Batch, Subagent Recursion, Auto-Compaction, Settings Guard, IPI Sanitizer & Scope Lock (`DET-13`..`DET-20`).
 * Pure-V8 isomorphic ESM module (zero `node:*` imports).
 */

import { path } from '../utils/runtime.mjs';
import {
  FLIGHT_MODES,
  normalizeFlightMode,
  isSilentOrOffMode
} from '../coach/cacheGravityRouter.mjs';
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
