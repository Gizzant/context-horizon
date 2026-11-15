/**
 * @file src/core-isomorphic/guards/bucketBGamma.mjs
 * Pure Isomorphic Evaluators for Bucket B Sub-Wave B-Gamma:
 *   - `#5`  `SUBAGENT_TEAM_GOVERNOR` (Read-only scout model right-sizing, brief cap & safe idle check)
 *   - `#13` `VAGUE_PROMPT_ANCHOR` (Zero-spawn `<6`-word ambiguous failure cry classifier)
 *   - `#16` `MCP_CLI_ROUTER` (Heavy MCP -> verified authenticated local CLI router)
 *   - `#17` `LSP_SYMBOL_ROUTER` (Verified active-LSP symbol lookup hint)
 *   - `#20` `PROSE_TO_HOOK_COMPILER` (Unconditional `NEVER`/`DO NOT` prose -> candidate hook preview)
 *
 * Mod Law 4 Compliant: Zero `node:*` imports, zero `process.cwd`/`exit`, zero global mutable state.
 */

// ============================================================================
// #5 SUBAGENT_TEAM_GOVERNOR
// ============================================================================

const WRITE_CAPABLE_TOOL_RE =
  /^(?:Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell|run_command|write_file|edit_file|delete_file|apply_patch)$/i;

const WRITE_ACTION_PROMPT_RE =
  /\b(?:implement|edit|modify|write|refactor|fix|patch|create\s+file|update\s+code|commit|merge|delete)\b/i;

const READ_ONLY_SCOUT_PROMPT_RE =
  /\b(?:scout|search|find|locate|summarize|explore|survey|grep|read-only|list\s+files|inspect\s+where)\b/i;

const EXEMPT_FRONTIER_ROLE_RE =
  /\b(?:cold\s+critic|spec\s+relay|adversarial\s+critic|security\s+auditor|architecture\s+review|verifier|judge)\b/i;

const FRONTIER_MODEL_RE =
  /^(?:opus|claude-(?:opus|sonnet)(?:-[a-z0-9.]+)*|sonnet|pro|gemini-[a-z0-9.-]*(?:pro|carbon|argon)|inherit)$/i;

/**
 * Evaluates subagent/team spawn parameters for read-only model right-sizing, brief bloat,
 * and safe idle-teammate governance (`0` misclassified write workers, `0` premature verifier kills).
 *
 * @param {object} input
 * @param {string} [input.typeName=''] - e.g. `'research'`, `'Explore'`, `'self'`, `'general-purpose'`
 * @param {string} [input.role='']
 * @param {string} [input.prompt='']
 * @param {string} [input.model='inherit']
 * @param {boolean} [input.enableWriteTools]
 * @param {string[]} [input.allowedTools]
 * @param {string} [input.workspace='inherit'] - `'inherit' | 'branch' | 'share' | 'worktree'`
 * @param {number} [input.idleMinutes=0]
 * @param {number} [input.pendingPeerCommits=0]
 * @param {boolean} [input.coordinatorWaiting=false]
 * @param {number} [input.maxBriefTokens=2500]
 */
export function evaluateSubagentGovernor(input = {}) {
  const typeName = String(input.typeName || '').trim();
  const role = String(input.role || '').trim();
  const prompt = String(input.prompt || '').trim();
  const model = String(input.model || 'inherit').trim();
  const workspace = String(input.workspace || 'inherit').trim().toLowerCase();
  const maxBriefTokens = Number(input.maxBriefTokens) || 2500;

  // 1. Check idle teammate termination governance (if evaluating a live idle teammate)
  const idleMinutes = Number(input.idleMinutes) || 0;
  if (idleMinutes >= 5) {
    const pendingPeerCommits = Number(input.pendingPeerCommits) || 0;
    const coordinatorWaiting = Boolean(input.coordinatorWaiting);
    if (pendingPeerCommits > 0 || coordinatorWaiting || EXEMPT_FRONTIER_ROLE_RE.test(`${role} ${prompt}`)) {
      return {
        triggered: false,
        decision: 'allow',
        exemptReason: 'verifier_or_pending_peer_work',
        isReadOnlyScout: false,
        tokensSavedEst: 0
      };
    }
    return {
      triggered: true,
      decision: 'warn',
      code: 'SUBAGENT_IDLE_DRAIN',
      action: 'recommend_retire_idle_worker',
      isReadOnlyScout: false,
      tokensSavedEst: 3200,
      reason: `[Quota Shield] Teammate \`${role || typeName || 'worker'}\` has been idle for ${idleMinutes}m with 0 pending peer commits and no coordinator wait.`
    };
  }

  // 2. Exempt Cold Critic / Spec Relay / Architecture Verifier roles from model downgrades
  if (EXEMPT_FRONTIER_ROLE_RE.test(`${typeName} ${role} ${prompt}`)) {
    return {
      triggered: false,
      decision: 'allow',
      exemptReason: 'frontier_critic_or_verifier',
      isReadOnlyScout: false,
      tokensSavedEst: 0
    };
  }

  // 3. Determine strict read-only scout status (NEVER misclassify write-capable workers!)
  const hasExplicitWriteFlag = input.enableWriteTools === true;
  const hasIsolatedWriteWorkspace =
    workspace === 'branch' || workspace === 'share' || workspace === 'worktree';
  const tools = Array.isArray(input.allowedTools) ? input.allowedTools : null;
  const hasWriteToolGrant = tools ? tools.some((t) => WRITE_CAPABLE_TOOL_RE.test(String(t))) : false;
  const isKnownReadOnlyType = /^(?:research|explore|ah-flash-scout|scout)$/i.test(typeName);
  const hasWriteIntentInPrompt = WRITE_ACTION_PROMPT_RE.test(prompt);

  const isReadOnlyScout =
    !hasExplicitWriteFlag &&
    !hasIsolatedWriteWorkspace &&
    !hasWriteToolGrant &&
    !hasWriteIntentInPrompt &&
    (isKnownReadOnlyType ||
      (input.enableWriteTools === false && READ_ONLY_SCOUT_PROMPT_RE.test(`${role} ${prompt}`)) ||
      (tools !== null && tools.length > 0 && READ_ONLY_SCOUT_PROMPT_RE.test(`${role} ${prompt}`)));

  const briefTokens = Math.ceil(prompt.length / 4);
  const bloatedBrief = briefTokens > maxBriefTokens;
  const frontierOnScout = isReadOnlyScout && FRONTIER_MODEL_RE.test(model);

  if (!frontierOnScout && !bloatedBrief) {
    return {
      triggered: false,
      decision: 'allow',
      isReadOnlyScout,
      briefTokens,
      tokensSavedEst: 0
    };
  }

  const reasons = [];
  let saved = 0;
  if (frontierOnScout) {
    reasons.push(
      `read-only scout \`${role || typeName}\` requested \`${model}\` -> prefer \`haiku\`/\`flash\` to save ~4x–10x subagent quota`
    );
    saved += 4500;
  }
  if (bloatedBrief) {
    reasons.push(`spawn brief is ~${briefTokens} tokens (>${maxBriefTokens} cap)`);
    saved += Math.max(500, briefTokens - maxBriefTokens);
  }

  return {
    triggered: true,
    decision: 'warn',
    code: 'SUBAGENT_TEAM_GOVERNOR',
    isReadOnlyScout,
    recommendedModel: frontierOnScout ? 'flash_or_haiku' : model,
    briefTokens,
    tokensSavedEst: saved,
    reason: `[Quota Shield] Subagent optimization: ${reasons.join('; ')}.`
  };
}

// ============================================================================
// #13 VAGUE_PROMPT_ANCHOR
// ============================================================================

const CRISP_CONFIRMATION_OR_SELECTION_RE =
  /^(?:go|yes|yep|yeah|ok|okay|sure|proceed|continue|ship\s+it|do\s+it|lgtm|approved?|looks\s+good|sounds\s+good|thanks|thank\s+you|stop|cancel|skip|done|next|(?:proceed|go|do|pick|use|option|step|choice)\s+(?:with\s+)?(?:#?\d+|[a-c]|both|all))[\s.!]*$/i;

const EXPLICIT_SHORT_COMMAND_RE =
  /^(?:git\s+\S+|npm\s+\S+|pnpm\s+\S+|node\s+\S+|run\s+(?:the\s+)?(?:tests?|lint|build|verify|bench\S*)|commit(?:\s+and\s+push|\s+now)?|push(?:\s+now|\s+to\s+\S+)?|sync\s+mirrors|build\s+(?:release|bundles|assets|all|prod|dev|pkg)|revert\s+that|show\s+diff|check\s+status)[\s.!]*$/i;

const QUESTION_OR_EXPLAIN_RE =
  /\?$|^(?:why|what|where|how|when|who|which|explain|describe|summarize|show\s+me|list|compare)\b/i;

const AMBIGUOUS_FAILURE_CRY_RE =
  /^(?:fix\s+(?:it|this|that)(?:\s+please)?|still\s+(?:broken|failing|fails|buggy|wrong|crashing|errors?)|same\s+(?:error|issue|bug|crash|problem)|(?:it\s+|that\s+)?(?:didnt|didn't|doesnt|doesn't|isnt|isn't)\s+work(?:ing)?|not\s+working|broken\s+again|try\s+again|still\s+doesnt\s+work|still\s+doesn't\s+work|it\s+(?:failed|fails|crashed|broke)|wrong\s+output|test\s+still\s+fails|tests\s+still\s+fail|build\s+broken|fix\s+the\s+error)[\s.!]*$/i;

const EXPLICIT_ANCHOR_TOKEN_RE =
  /(?:[A-Za-z0-9_-]+\.[a-z]{1,5}\b|\/[A-Za-z0-9_.-]+|`[^`]+`|\bDET-\d+\b|\bISS-\d+\b|#[0-9]+\b|\bline\s+\d+\b)/i;

/**
 * Classifies `<8`-word user prompts with `0ms` subprocess overhead:
 * - Returns `triggered: true` ONLY on ambiguous failure cries (`"fix it"`, `"still broken"`, `"same error"`)
 *   lacking any file/symbol/issue anchor when pre-cached `dirtyFiles` or `lastFailingLocation` exist.
 * - Guarantees `0%` false-injection on slash commands, confirmations (`"proceed with 1"`), CLI verbs (`"git push"`), or Q&A.
 *
 * @param {object} input
 * @param {string} [input.prompt='']
 * @param {string[]} [input.cachedDirtyFiles=[]]
 * @param {string} [input.lastFailingLocation='']
 */
export function evaluateVaguePromptAnchor(input = {}) {
  const raw = String(input.prompt || '').trim();
  if (!raw || raw.startsWith('/')) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 7) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  if (
    CRISP_CONFIRMATION_OR_SELECTION_RE.test(raw) ||
    EXPLICIT_SHORT_COMMAND_RE.test(raw) ||
    QUESTION_OR_EXPLAIN_RE.test(raw) ||
    EXPLICIT_ANCHOR_TOKEN_RE.test(raw)
  ) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  if (!AMBIGUOUS_FAILURE_CRY_RE.test(raw)) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  const dirty = Array.isArray(input.cachedDirtyFiles) ? input.cachedDirtyFiles.slice(0, 5) : [];
  const lastFail = String(input.lastFailingLocation || '').trim();
  if (dirty.length === 0 && !lastFail) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  const anchorParts = [];
  if (lastFail) anchorParts.push(`last failure: ${lastFail}`);
  if (dirty.length > 0) anchorParts.push(`modified: ${dirty.join(', ')}`);

  return {
    triggered: true,
    decision: 'warn',
    code: 'VAGUE_PROMPT_ANCHOR',
    anchorContext: `[CTX_ANCHOR] ${anchorParts.join(' | ')}`,
    tokensSavedEst: 1900,
    reason: `[Quota Shield] Short unanchored debug prompt anchored to cached workspace state (${anchorParts.join(' | ')}) to prevent blind exploratory grep sweeps.`
  };
}

// ============================================================================
// #16 MCP_CLI_ROUTER
// ============================================================================

const HEAVY_MCP_SERVER_TO_CLI = Object.freeze({
  github: { cli: 'gh', example: 'gh pr / gh issue / gh api' },
  gh: { cli: 'gh', example: 'gh pr / gh issue / gh api' },
  aws: { cli: 'aws', example: 'aws <service> describe-* --output json' },
  gcloud: { cli: 'gcloud', example: 'gcloud <group> list --format=json' },
  sentry: { cli: 'sentry-cli', example: 'sentry-cli issues list' },
  kubectl: { cli: 'kubectl', example: 'kubectl get <resource> -o json' },
  kubernetes: { cli: 'kubectl', example: 'kubectl get <resource> -o json' }
});

const READ_LIKE_MCP_ACTION_RE = /(?:^|_|-)(?:list|get|read|search|query|fetch|view|describe|status|inspect)(?:$|_|-)/i;

/**
 * Suggests lightweight authenticated CLI calls over heavy MCP JSON-schema/payload calls
 * ONLY when BOTH the local CLI binary AND non-expired local auth state are verified.
 *
 * @param {object} input
 * @param {string} [input.toolName=''] - e.g. `'mcp__github__list_pull_requests'`
 * @param {Record<string, { installed?: boolean, authValid?: boolean, authExpired?: boolean }>} [input.cliCapabilities={}]
 */
export function evaluateMcpCliRouter(input = {}) {
  const toolName = String(input.toolName || '').trim();
  const match = toolName.match(/^mcp__([a-z0-9_-]+)__([a-z0-9_-]+)$/i);
  if (!match) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  const serverKey = match[1].toLowerCase();
  const actionName = match[2];
  const mapping = HEAVY_MCP_SERVER_TO_CLI[serverKey];
  if (!mapping || !READ_LIKE_MCP_ACTION_RE.test(actionName)) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  const caps = (input.cliCapabilities || {})[mapping.cli] || null;
  if (!caps || caps.installed !== true || caps.authValid !== true || caps.authExpired === true) {
    return {
      triggered: false,
      decision: 'allow',
      exemptReason: 'cli_missing_or_unauthenticated',
      tokensSavedEst: 0
    };
  }

  return {
    triggered: true,
    decision: 'warn',
    code: 'MCP_CLI_ROUTER',
    recommendedCli: mapping.cli,
    tokensSavedEst: 3400,
    reason: `[CTX_HINT] Verified authenticated \`${mapping.cli}\` CLI is available locally (${mapping.example}) and avoids ~3k–15k MCP schema/JSON envelope tokens.`
  };
}

// ============================================================================
// #17 LSP_SYMBOL_ROUTER
// ============================================================================

/**
 * Emits a `<20`-token `[CTX_HINT]` recommending native `LSP` definition/reference navigation
 * on repeated symbol `Grep`/`Read` hops STRICTLY when `lspToolEnabled === true` AND an active
 * language server covers the target file extension (`0` hints when LSP is absent).
 *
 * @param {object} input
 * @param {string} [input.symbol='']
 * @param {string} [input.filePath='']
 * @param {number} [input.symbolLookupCount=0]
 * @param {boolean} [input.lspToolEnabled=false]
 * @param {Iterable<string>} [input.activeExtensions=[]] - e.g. `['.ts', '.tsx', '.py', '.go', '.rs']`
 */
export function evaluateLspSymbolRouter(input = {}) {
  const symbol = String(input.symbol || '').trim();
  const filePath = String(input.filePath || '').trim();
  const lookupCount = Number(input.symbolLookupCount) || 0;

  if (!input.lspToolEnabled || lookupCount < 3 || !/^[A-Za-z_$][A-Za-z0-9_$]{2,}$/.test(symbol)) {
    return { triggered: false, decision: 'allow', tokensSavedEst: 0 };
  }

  const dotIdx = filePath.lastIndexOf('.');
  const ext = dotIdx >= 0 ? filePath.slice(dotIdx).toLowerCase() : '';
  const activeSet = new Set(
    Array.from(input.activeExtensions || [], (e) =>
      (String(e).startsWith('.') ? String(e) : `.${e}`).toLowerCase()
    )
  );

  if (!ext || !activeSet.has(ext)) {
    return {
      triggered: false,
      decision: 'allow',
      exemptReason: 'no_active_lsp_for_extension',
      tokensSavedEst: 0
    };
  }

  return {
    triggered: true,
    decision: 'warn',
    code: 'LSP_SYMBOL_ROUTER',
    hint: `[CTX_HINT] Prefer native LSP goToDefinition/findReferences for \`${symbol}\` (${ext}).`,
    tokensSavedEst: 1200,
    reason: `[CTX_HINT] Prefer native LSP goToDefinition/findReferences for \`${symbol}\` (${ext}).`
  };
}

// ============================================================================
// #20 PROSE_TO_HOOK_COMPILER
// ============================================================================

const IMPERATIVE_PROHIBITION_LINE_RE =
  /^\s*(?:[-*+]|\d+\.)\s*(?:\*\*)?(?:NEVER|DO\s+NOT|DON'T|MUST\s+NEVER|STRICTLY\s+NEVER)(?:\*\*)?\b/i;

const CONDITIONAL_QUALIFIER_RE =
  /\b(?:unless|except|if|when|whenever|until|before|after|while|otherwise|instead\s+of|rather\s+than|only\s+when|only\s+if|in\s+case|provided\s+that|except\s+when)\b/i;

const FILE_ACTION_VERB_RE =
  /\b(?:read|edit|modify|write|touch|stage|index|grep|delete|overwrite|access)\b/i;

const SHELL_EXEC_VERB_RE = /\b(?:run|execute|invoke|spawn|call)\b/i;

function looksLikePathOrGlobToken(tok = '') {
  const t = tok.trim();
  if (!t || t.includes(' ') || t.length < 3) return false;
  if (/^(?:true|false|null|undefined|stdout|stderr|json|utf8)$/i.test(t)) return false;
  return (
    t.includes('/') ||
    t.includes('\\') ||
    t.startsWith('~/.') ||
    t.startsWith('.') ||
    /\.(?:json|ya?ml|md|mjs|cjs|js|ts|tsx|py|toml|lock|env|db|sqlite|sql|sh|sha256|sum|pem|key|crt|cfg|ini|conf|xml|csv|txt)$/i.test(
      t
    )
  );
}

function looksLikeShellCommandToken(tok = '') {
  const t = tok.trim();
  if (!t || !t.includes(' ')) return false;
  return /^(?:git|npm|pnpm|yarn|npx|node|rm|del|curl|wget|docker|kubectl|claude|gemini|agy)\s+\S+/i.test(
    t
  );
}

/**
 * Scans `AGENTS.md` / `CLAUDE.md` Markdown text for unconditional imperative `NEVER` / `DO NOT`
 * rules containing explicit backticked globs, paths, or commands, compiling them into candidate
 * `PreToolUse` hook previews for `ctxtop doctor` (rejecting all conditional rules).
 *
 * @param {string} markdown
 * @param {object} [options={}]
 * @param {string} [options.sourceFile='AGENTS.md']
 */
export function compileProseRulesToHooks(markdown = '', options = {}) {
  const sourceFile = String(options.sourceFile || 'AGENTS.md');
  const lines = String(markdown || '').split(/\r?\n/);
  const candidates = [];
  const skippedConditional = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    if (!IMPERATIVE_PROHIBITION_LINE_RE.test(rawLine)) continue;

    // Strip backticked spans before checking conditional prose words so identifiers like `if` inside code don't skew,
    // AND also check full prose outside backticks for any conditional/temporal qualifier!
    const proseOutsideBackticks = rawLine.replace(/`[^`]*`/g, ' ');
    if (CONDITIONAL_QUALIFIER_RE.test(proseOutsideBackticks)) {
      skippedConditional.push({
        line: idx + 1,
        sourceFile,
        reason: 'conditional_or_temporal_clause',
        excerpt: rawLine.trim().slice(0, 140)
      });
      continue;
    }

    const backtickTokens = [...rawLine.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
    if (backtickTokens.length === 0) continue;

    const pathGlobs = backtickTokens.filter(looksLikePathOrGlobToken);
    const shellCommands = backtickTokens.filter(looksLikeShellCommandToken);

    if (pathGlobs.length > 0 && FILE_ACTION_VERB_RE.test(proseOutsideBackticks)) {
      candidates.push({
        line: idx + 1,
        sourceFile,
        hookEvent: 'PreToolUse',
        matcher: 'Read|Edit|MultiEdit|Write|Grep|Glob',
        kind: 'PATH_DENY_RULE',
        patterns: pathGlobs,
        previewOnly: true,
        sourceExcerpt: rawLine.trim().slice(0, 160)
      });
    } else if (shellCommands.length > 0 && SHELL_EXEC_VERB_RE.test(proseOutsideBackticks)) {
      candidates.push({
        line: idx + 1,
        sourceFile,
        hookEvent: 'PreToolUse',
        matcher: 'Bash|PowerShell',
        kind: 'COMMAND_DENY_RULE',
        patterns: shellCommands,
        previewOnly: true,
        sourceExcerpt: rawLine.trim().slice(0, 160)
      });
    }
  }

  return {
    triggered: candidates.length > 0,
    decision: 'allow',
    candidates,
    skippedConditional,
    tokensSavedEst: candidates.length * 400
  };
}
