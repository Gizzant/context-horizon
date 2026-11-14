/**
 * Pure-JS Airlock Pre-Tool, Prompt & Instruction Guard (Mod Law 4 Compliant).
 * Zero node:* / fs / child_process imports.
 *
 * Enforces:
 * - FM-1: Write-only synthetic placeholder guard + 2-strike retry cap
 * - Airlock self-tamper protection (.airlock/, hooks/, airlock modules)
 * - Class A secret file blocking (.env, keys, cloud creds, oauth_creds.json)
 * - Sensitive binary read path protection (.p12, .pfx, .jks, .kdbx, .sqlite, dumps)
 * - Obfuscated / credential-dumping shell command detection
 * - Outbound PreTool input secret scan & UserPromptSubmit secret guard
 * - SessionStart static instruction file scanner (CLAUDE.md, AGENTS.md, etc.)
 */

import {
  findWriteOnlyPlaceholders,
  containsWriteOnlyPlaceholder,
  verifyPlaceholderCrc8
} from './hmacTwin.mjs';
import {
  globMatchPure,
  scanTextWithAirlock
} from './detector.mjs';

export const AIRLOCK_STRIKE_CAP = 2;

export const CLASS_A_SECRET_PATH_RE = /(?:^|[/\\])(?:\.env(?:\.(?!example$|sample$|template$|dist$)[a-z0-9._-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|\.secrets|id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub$)|oauth_creds\.json|application_default_credentials\.json|credentials\.json|service[-_]?account[^/\\]*\.json|secrets?\.(?:ya?ml|json|toml|ini|env)|vault\.(?:ya?ml|json)|master\.key|terraform\.tfstate(?:\.backup)?|[^/\\]+\.(?:pem|p12|pfx|jks|keystore|kdbx|ovpn|tfvars)|\.ssh[/\\](?!known_hosts$|config$|[^/\\]+\.pub$)[^/\\]+|\.aws[/\\](?:credentials|config)|\.kube[/\\]config|\.docker[/\\]config\.json)$/i;

export const SENSITIVE_BINARY_EXT_RE = /\.(?:p12|pfx|jks|keystore|kdbx|der|sqlite|sqlite3|db|db-wal|dmp|hprof|pcap|pcapng|har)$/i;
export const SENSITIVE_DOCUMENT_NAME_RE = /(?:^|[/\\])[^/\\]*(?:secret|credential|password|private[-_]?key|api[-_]?key|passport|ssn|tax[-_]?return|oauth[-_]?cred)[^/\\]*\.(?:pdf|png|jpe?g|webp|tiff?|bmp|docx?|xlsx?|zip|tar|gz|bin|dat)$/i;

const SELF_TAMPER_PROTECTED_RE = /(?:^|[/\\])(?:\.airlock(?:[/\\]|$)|hooks[/\\](?:hooks\.json|pre[-_]tool[-_]use\.mjs|post[-_]tool[-_]use\.mjs|pre[-_]invocation\.mjs|register\.js|handlers[/\\])|src[/\\](?:core-isomorphic|core)[/\\]airlock[/\\]|\.claude[/\\]settings(?:\.local)?\.json|\.gemini[/\\](?:oauth_creds\.json|antigravity[/\\]hooks\.json|config[/\\]plugins[/\\])|airlock[-_.]?policy\.(?:json|sig)|airlock[-_.]?ledger)/i;
const KEY_DISCLOSURE_READ_RE = /(?:^|[/\\])(?:\.airlock[/\\](?:session\.key|org[-_]?salts\.json|policy\.sig|ledger[^/\\]*)|\.gemini[/\\]oauth_creds\.json)$/i;

const MUTATING_OR_SHELL_TOOL_RE = /^(?:Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell|run_command|write_to_file|replace_file_content|multi_replace_file_content)$/i;
const PATH_INSPECTION_TOOL_RE = /^(?:Read|Grep|Glob|Edit|MultiEdit|Write|NotebookEdit|view_file|grep_search|find_by_name|list_dir|write_to_file|replace_file_content|multi_replace_file_content)$/i;
const SHELL_TOOL_RE = /^(?:Bash|PowerShell|run_command)$/i;

function normalizeSlashes(p) {
  return String(p || '').replace(/\\/g, '/').trim();
}

function collectCandidatePaths(toolInput) {
  const paths = [];
  if (!toolInput || typeof toolInput !== 'object') {
    if (typeof toolInput === 'string' && toolInput.trim()) {
      paths.push(toolInput.trim());
    }
    return paths;
  }
  const keys = [
    'file_path',
    'filePath',
    'path',
    'TargetFile',
    'AbsolutePath',
    'NotebookPath',
    'notebook_path',
    'SearchPath',
    'SearchDirectory',
    'target',
    'cwd',
    'Cwd'
  ];
  for (let i = 0; i < keys.length; i++) {
    const val = toolInput[keys[i]];
    if (typeof val === 'string' && val.trim()) {
      paths.push(val.trim());
    }
  }
  if (Array.isArray(toolInput.files)) {
    for (let i = 0; i < toolInput.files.length; i++) {
      if (typeof toolInput.files[i] === 'string' && toolInput.files[i].trim()) {
        paths.push(toolInput.files[i].trim());
      }
    }
  }
  return paths;
}

function extractShellCommandText(toolInput) {
  if (!toolInput) return '';
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput === 'object') {
    return String(toolInput.command || toolInput.CommandLine || toolInput.cmd || toolInput.script || '');
  }
  return '';
}

function serializeToolInputForScan(toolName, toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';

  const name = String(toolName || '');
  // For Edit / replace_file_content, scan new content (new_string / ReplacementContent)
  // rather than old_string so developers can remediate/remove an existing leaked secret cleanly.
  if (/^(?:Edit|MultiEdit|replace_file_content|multi_replace_file_content)$/i.test(name)) {
    const parts = [];
    if (typeof toolInput.new_string === 'string') parts.push(toolInput.new_string);
    if (typeof toolInput.ReplacementContent === 'string') parts.push(toolInput.ReplacementContent);
    if (Array.isArray(toolInput.edits)) {
      for (let i = 0; i < toolInput.edits.length; i++) {
        if (typeof toolInput.edits[i]?.new_string === 'string') parts.push(toolInput.edits[i].new_string);
      }
    }
    if (Array.isArray(toolInput.ReplacementChunks)) {
      for (let i = 0; i < toolInput.ReplacementChunks.length; i++) {
        if (typeof toolInput.ReplacementChunks[i]?.ReplacementContent === 'string') {
          parts.push(toolInput.ReplacementChunks[i].ReplacementContent);
        }
      }
    }
    return parts.join('\n');
  }

  try {
    return JSON.stringify(toolInput);
  } catch {
    return '';
  }
}

export function isClassASecretPath(filePath = '', policy = {}) {
  const norm = normalizeSlashes(filePath);
  if (!norm) return false;

  const allowGlobs = Array.isArray(policy?.allowPathGlobs) ? policy.allowPathGlobs : [];
  for (let i = 0; i < allowGlobs.length; i++) {
    if (globMatchPure(norm, allowGlobs[i])) {
      return false;
    }
  }

  if (CLASS_A_SECRET_PATH_RE.test(norm)) {
    return true;
  }

  const extraGlobs = Array.isArray(policy?.classASecretGlobs) ? policy.classASecretGlobs : [];
  for (let i = 0; i < extraGlobs.length; i++) {
    if (globMatchPure(norm, extraGlobs[i])) {
      return true;
    }
  }
  return false;
}

export function isSensitiveBinaryReadPath(filePath = '') {
  const norm = normalizeSlashes(filePath);
  if (!norm) return false;
  if (SENSITIVE_BINARY_EXT_RE.test(norm)) return true;
  if (SENSITIVE_DOCUMENT_NAME_RE.test(norm)) return true;
  return false;
}

export function isAirlockSelfTamperTarget(toolName = '', toolInput = {}) {
  const name = String(toolName || '').trim();
  const candidates = collectCandidatePaths(toolInput);
  const cmdText = SHELL_TOOL_RE.test(name) ? extractShellCommandText(toolInput) : '';

  const isReadTool = /^(?:Read|Grep|Glob|view_file|grep_search|find_by_name|list_dir)$/i.test(name);
  if (isReadTool) {
    for (let i = 0; i < candidates.length; i++) {
      if (KEY_DISCLOSURE_READ_RE.test(normalizeSlashes(candidates[i]))) {
        return true;
      }
    }
    return false;
  }

  if (MUTATING_OR_SHELL_TOOL_RE.test(name) || /write|edit|delete|remove|patch|chmod|chown|mv|cp/i.test(name)) {
    for (let i = 0; i < candidates.length; i++) {
      if (SELF_TAMPER_PROTECTED_RE.test(normalizeSlashes(candidates[i]))) {
        return true;
      }
    }
  }

  if (cmdText) {
    const trimmedCmd = cmdText.trim();
    // Read-only test runners / checksum / verify commands are permitted; mutating shell commands on Airlock targets are blocked.
    if (KEY_DISCLOSURE_READ_RE.test(trimmedCmd)) {
      return true;
    }
    if (
      /(?:^|[;&|]\s*)(?:rm|del|erase|mv|move|cp|copy|chmod|chown|attrib|icacls|truncate|sed\s+-i|perl\s+-i|tee\b|echo\b.*>|printf\b.*>|cat\b.*>|Set-Content|Out-File|Remove-Item|Move-Item|Copy-Item)\b/i.test(trimmedCmd) &&
      SELF_TAMPER_PROTECTED_RE.test(trimmedCmd)
    ) {
      return true;
    }
    if (/(?:>|>>)\s*[^\s]*(?:\.airlock|\.claude[/\\]settings|hooks[/\\]hooks\.json|airlock[/\\]policy)/i.test(trimmedCmd)) {
      return true;
    }
  }

  return false;
}

const SHELL_READ_SECRET_CMD_RE = /\b(?:cat|head|tail|less|more|nl|sed|awk|bat|type|Get-Content|gc|xxd|hexdump|od|strings|base64|tar|zip)\b[^\n;|&]*(?:(?:^|[\s"'=/\\])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[a-z0-9._-]+)?\b|id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub\b)|oauth_creds\.json|application_default_credentials\.json|\.aws[/\\]credentials|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.kube[/\\]config)/i;
const SHELL_ENV_DUMP_RE = /(?:^|[;&|]\s*)(?:printenv|Get-ChildItem\s+Env:|dir\s+env:|env\s*(?:$|[|>;])|set\s*(?:$|[|>;]))/i;
const SHELL_ENCODED_EXEC_RE = /(?:base64\s+(?:-d|--decode)|xxd\s+-r|openssl\s+enc\s+-d)[^\n]*\|[^\n]*(?:sh|bash|zsh|pwsh|powershell|node|python)|powershell(?:\.exe)?\s+[^\n]*-(?:e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i;
const SHELL_EXFIL_SECRET_VAR_RE = /\b(?:curl|wget|nc|ncat|socat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]*(?:\$(?:env:)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASS|PWD|CRED|AUTH)[A-Z0-9_]*|\.env\b|id_(?:rsa|ed25519)|oauth_creds\.json|\.aws[/\\]credentials)/i;
const SHELL_KEYCHAIN_OAUTH_RE = /\b(?:cmdkey(?:\.exe)?|security\s+find-(?:generic|internet)-password|oauth_creds\.json|gemini:antigravity)\b/i;

export function isObfuscatedSecretShellCommand(command = '') {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (SHELL_KEYCHAIN_OAUTH_RE.test(cmd)) return true;
  if (SHELL_READ_SECRET_CMD_RE.test(cmd)) return true;
  if (SHELL_ENV_DUMP_RE.test(cmd)) return true;
  if (SHELL_ENCODED_EXEC_RE.test(cmd)) return true;
  if (SHELL_EXFIL_SECRET_VAR_RE.test(cmd)) return true;
  return false;
}

function buildAllowResult(extra = {}) {
  return {
    decision: 'allow',
    blocked: false,
    failClosed: false,
    exitCode: 0,
    fmCode: null,
    reason: '',
    placeholders: [],
    matches: [],
    auditOnlyMatches: [],
    uniqueEntityHmacs: [],
    strikeCount: 0,
    strikeCapReached: false,
    auditOnly: false,
    ...extra
  };
}

function buildDenyResult(fmCode, reason, extra = {}) {
  return {
    decision: 'deny',
    blocked: true,
    failClosed: true,
    exitCode: 2,
    fmCode,
    reason,
    placeholders: [],
    matches: [],
    auditOnlyMatches: [],
    uniqueEntityHmacs: [],
    strikeCount: 0,
    strikeCapReached: false,
    auditOnly: false,
    ...extra
  };
}

function stripPlaintextMatchValues(matches = []) {
  return (Array.isArray(matches) ? matches : []).map((m) => ({
    start: m.start,
    end: m.end,
    ruleId: m.ruleId,
    category: m.category,
    severityTier: m.severityTier,
    action: m.action,
    entityHmac: m.entityHmac
  }));
}

function computeLineAndColumn(text, index) {
  let line = 1;
  let lastNl = -1;
  const limit = Math.max(0, Math.min(Number(index) || 0, text.length));
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: limit - lastNl };
}

function inferDetectorStage(ruleId = '') {
  if (String(ruleId).startsWith('STAGE1_')) return 1;
  if (String(ruleId) === 'STAGE3_ENTROPY') return 3;
  return 2;
}

export function evaluateAirlockPreToolGuard(event = {}, options = {}) {
  const policy = options.policy || {};
  const mode = String(options.mode || policy.mode || 'enforce').toLowerCase();
  if (options.enabled === false || policy.enabled === false || mode === 'off') {
    return buildAllowResult();
  }

  const toolName = String(
    event.tool_name ||
    event.toolName ||
    event.toolCall?.name ||
    ''
  ).trim();
  const toolInput =
    event.tool_input ??
    event.input ??
    event.args ??
    event.toolCall?.args ??
    {};

  // 1. Airlock Self-Tamper Protection (always enforced when Airlock is active, regardless of audit mode)
  if (isAirlockSelfTamperTarget(toolName, toolInput)) {
    return buildDenyResult(
      'FM-SELF-TAMPER',
      `Airlock blocked ${toolName || 'tool'} from modifying or reading protected Airlock policy, hooks, keys, or ledger files.`
    );
  }

  // 2. FM-1: Write-only synthetic placeholder guard on mutating / shell tools + 2-strike retry cap
  if (MUTATING_OR_SHELL_TOOL_RE.test(toolName) && containsWriteOnlyPlaceholder(toolInput)) {
    const rawPlaceholders = findWriteOnlyPlaceholders(toolInput);
    const placeholders = rawPlaceholders.map((p) => {
      const token = typeof p === 'string' ? p : String(p?.token || '');
      return {
        token,
        validCrc8: verifyPlaceholderCrc8(token)
      };
    });
    const prevStrikes = Number(options.strikeCount) || 0;
    const nextStrikes = prevStrikes + 1;
    const cap = Number(policy.fm1StrikeCap || options.strikeCap || AIRLOCK_STRIKE_CAP);
    const strikeCapReached = nextStrikes >= cap;
    const reason = strikeCapReached
      ? `[AIRLOCK FM-1 HARD STOP | strike ${nextStrikes}/${cap}] Tool '${toolName}' received write-only synthetic placeholder (${placeholders.map((p) => p.token).join(', ')}). Retrying with synthetic placeholders is capped at ${cap}. STOP editing or executing with placeholders and ask the user to apply this step or approve the concrete value locally.`
      : `[AIRLOCK FM-1] Blocked '${toolName}': Airlock v1 placeholders (${placeholders.map((p) => p.token).join(', ')}) are write-only co-reference markers, not reversible secret values. Do NOT substitute guessed secrets or retry with synthetic placeholders; operate on clean lines/files or ask the user directly.`;

    if (mode === 'audit') {
      return buildAllowResult({
        auditOnly: true,
        fmCode: 'FM-1',
        placeholders,
        strikeCount: nextStrikes,
        strikeCapReached,
        reason
      });
    }

    return buildDenyResult('FM-1', reason, {
      placeholders,
      strikeCount: nextStrikes,
      strikeCapReached
    });
  }

  // 3. Path-based checks: Class A secret paths and Sensitive binary read paths
  const candidatePaths = collectCandidatePaths(toolInput);
  if (PATH_INSPECTION_TOOL_RE.test(toolName) && candidatePaths.length > 0) {
    for (let i = 0; i < candidatePaths.length; i++) {
      const targetPath = candidatePaths[i];
      if (isClassASecretPath(targetPath, policy)) {
        const reason = `[AIRLOCK CLASS-A] Blocked '${toolName}' on sensitive secret path '${targetPath}'. Ask the user to inspect or rotate credentials locally outside agent context.`;
        if (mode === 'audit') {
          return buildAllowResult({ auditOnly: true, fmCode: 'FM-CLASS-A-PATH', reason });
        }
        return buildDenyResult('FM-CLASS-A-PATH', reason);
      }

      if (/^(?:Read|view_file)$/i.test(toolName) && isSensitiveBinaryReadPath(targetPath)) {
        const reason = `[AIRLOCK BINARY-PATH] Blocked binary/sensitive container read on '${targetPath}' because Airlock cannot inspect opaque container bytes.`;
        if (mode === 'audit') {
          return buildAllowResult({ auditOnly: true, fmCode: 'FM-SENSITIVE-BINARY', reason });
        }
        return buildDenyResult('FM-SENSITIVE-BINARY', reason);
      }
    }
  }

  // 4. Shell obfuscation & secret dump checks
  if (SHELL_TOOL_RE.test(toolName)) {
    const cmdText = extractShellCommandText(toolInput);
    if (isObfuscatedSecretShellCommand(cmdText)) {
      const reason = `[AIRLOCK SHELL-GUARD] Blocked '${toolName}' command matching Class-A credential read, env dump, encoded execution, or secret exfiltration pattern.`;
      if (mode === 'audit') {
        return buildAllowResult({ auditOnly: true, fmCode: 'FM-OBFUSCATED-SHELL', reason });
      }
      return buildDenyResult('FM-OBFUSCATED-SHELL', reason);
    }
  }

  // 5. Outbound / write input plaintext secret scan
  if (
    MUTATING_OR_SHELL_TOOL_RE.test(toolName) ||
    /^(?:WebFetch|WebSearch|Agent|Task)$/i.test(toolName) ||
    /^mcp__/i.test(toolName)
  ) {
    const serialized = serializeToolInputForScan(toolName, toolInput);
    if (serialized) {
      const scan = scanTextWithAirlock(serialized, {
        ...options,
        filePath: candidatePaths[0] || options.filePath || '',
        policy,
        sessionKey: options.sessionKey,
        orgAuditSalt: options.orgAuditSalt,
        orgAllowlistSalt: options.orgAllowlistSalt
      });
      const safeMatches = stripPlaintextMatchValues(scan.matches);
      const safeAuditOnly = stripPlaintextMatchValues(scan.auditOnlyMatches);
      if (safeMatches.length > 0) {
        const cats = [...new Set(safeMatches.map((m) => m.category))].join(', ');
        const reason = `[AIRLOCK PRETOOL-SECRET] Blocked '${toolName}' input containing secret category [${cats}]. Plaintext secrets cannot be sent via tool arguments or written unmasked by an automated call.`;
        if (mode === 'audit') {
          return buildAllowResult({
            auditOnly: true,
            fmCode: 'FM-OUTBOUND-SECRET',
            matches: safeMatches,
            auditOnlyMatches: safeAuditOnly,
            uniqueEntityHmacs: scan.uniqueEntityHmacs,
            reason
          });
        }
        return buildDenyResult('FM-OUTBOUND-SECRET', reason, {
          matches: safeMatches,
          auditOnlyMatches: safeAuditOnly,
          uniqueEntityHmacs: scan.uniqueEntityHmacs
        });
      }
      return buildAllowResult({
        auditOnlyMatches: safeAuditOnly,
        uniqueEntityHmacs: scan.uniqueEntityHmacs
      });
    }
  }

  return buildAllowResult();
}

export function evaluateAirlockPromptGuard(event = {}, options = {}) {
  const policy = options.policy || {};
  const mode = String(options.mode || policy.mode || 'enforce').toLowerCase();
  if (options.enabled === false || policy.enabled === false || mode === 'off') {
    return buildAllowResult();
  }

  const promptText = String(
    event.prompt ??
    event.user_input ??
    event.lastUserInput ??
    event.message ??
    ''
  );
  if (!promptText) {
    return buildAllowResult();
  }

  const scan = scanTextWithAirlock(promptText, {
    ...options,
    policy,
    sessionKey: options.sessionKey,
    orgAuditSalt: options.orgAuditSalt,
    orgAllowlistSalt: options.orgAllowlistSalt
  });
  const safeMatches = stripPlaintextMatchValues(scan.matches);
  const safeAuditOnly = stripPlaintextMatchValues(scan.auditOnlyMatches);

  if (safeMatches.length > 0) {
    const cats = [...new Set(safeMatches.map((m) => m.category))].join(', ');
    const reason = `[AIRLOCK PROMPT-GUARD] Blocked UserPromptSubmit before cloud transmission: detected plaintext secret [${cats}]. Replace credentials with environment variable names and rotate exposed tokens.`;
    if (mode === 'audit') {
      return buildAllowResult({
        auditOnly: true,
        fmCode: 'FM-PROMPT-SECRET',
        matches: safeMatches,
        auditOnlyMatches: safeAuditOnly,
        uniqueEntityHmacs: scan.uniqueEntityHmacs,
        reason
      });
    }
    return buildDenyResult('FM-PROMPT-SECRET', reason, {
      matches: safeMatches,
      auditOnlyMatches: safeAuditOnly,
      uniqueEntityHmacs: scan.uniqueEntityHmacs
    });
  }

  return buildAllowResult({
    auditOnlyMatches: safeAuditOnly,
    uniqueEntityHmacs: scan.uniqueEntityHmacs
  });
}

export function scanInstructionFilesForSecrets(files = [], options = {}) {
  const list = Array.isArray(files) ? files : [];
  const findings = [];
  const auditOnlyFindings = [];
  const hmacSet = new Set();

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry || typeof entry.content !== 'string' || !entry.content) continue;
    const filePath = String(entry.path || `file_${i}`);
    const scan = scanTextWithAirlock(entry.content, { ...options, filePath });
    for (let k = 0; k < scan.uniqueEntityHmacs.length; k++) {
      hmacSet.add(scan.uniqueEntityHmacs[k]);
    }
    for (let k = 0; k < scan.matches.length; k++) {
      const m = scan.matches[k];
      const pos = computeLineAndColumn(entry.content, m.start);
      findings.push({
        path: filePath,
        ruleId: m.ruleId,
        category: m.category,
        stage: inferDetectorStage(m.ruleId),
        line: pos.line,
        column: pos.column,
        entityHmac: m.entityHmac
      });
    }
    for (let k = 0; k < scan.auditOnlyMatches.length; k++) {
      const m = scan.auditOnlyMatches[k];
      const pos = computeLineAndColumn(entry.content, m.start);
      auditOnlyFindings.push({
        path: filePath,
        ruleId: m.ruleId,
        category: m.category,
        stage: inferDetectorStage(m.ruleId),
        line: pos.line,
        column: pos.column,
        entityHmac: m.entityHmac
      });
    }
  }

  return {
    scannedFiles: list.length,
    findings,
    auditOnlyFindings,
    uniqueEntityHmacs: [...hmacSet],
    safe: findings.length === 0
  };
}
