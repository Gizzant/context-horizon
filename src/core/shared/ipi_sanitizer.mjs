/**
 * Pure Zero-I/O Credential Scrubber & Indirect Prompt Injection (IPI) Sanitizer
 * (`src/core/shared/ipi_sanitizer.mjs`)
 *
 * Strictly uses functional replacers `str.replace(pattern, () => replacement)` on all dynamic strings.
 */

export const LIVE_SECRET_DEFINITIONS = Object.freeze([
  {
    id: 'pem_private_key',
    label: 'PEM Private Key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|$)/g,
    redaction: '[REDACTED:PEM_PRIVATE_KEY]'
  },
  {
    id: 'anthropic_api_key',
    label: 'Anthropic API Key (sk-ant-api03-)',
    re: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{16,}\b/g,
    redaction: '[REDACTED:ANTHROPIC_KEY]'
  },
  {
    id: 'google_api_key',
    label: 'Google API Key (AIzaSy)',
    re: /\bAIzaSy[0-9A-Za-z_-]{25,}\b/g,
    redaction: '[REDACTED:GOOGLE_API_KEY]'
  },
  {
    id: 'github_classic_pat',
    label: 'GitHub PAT (ghp_)',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    redaction: '[REDACTED:GITHUB_PAT]'
  },
  {
    id: 'github_fine_pat',
    label: 'GitHub Fine-Grained PAT (github_pat_)',
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    redaction: '[REDACTED:GITHUB_PAT]'
  },
  {
    id: 'aws_access_key',
    label: 'AWS Access Key ID (AKIA)',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    redaction: '[REDACTED:AWS_ACCESS_KEY]'
  },
  {
    id: 'slack_bot_token',
    label: 'Slack Token (xoxb-)',
    re: /\bxox[baprs]-[0-9]{8,}-[0-9A-Za-z-]{16,}\b/g,
    redaction: '[REDACTED:SLACK_TOKEN]'
  },
  {
    id: 'openai_api_key',
    label: 'OpenAI API Key (sk-proj-/sk-live-)',
    re: /\bsk-(?:proj-|live-)[A-Za-z0-9_-]{16,}\b/g,
    redaction: '[REDACTED:OPENAI_KEY]'
  },
  {
    id: 'bearer_token',
    label: 'Bearer Authorization Token',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/gi,
    redaction: 'Bearer [REDACTED:TOKEN]'
  }
]);

const PLACEHOLDER_VALUE_RE =
  /^(?:your[_-]?|my[_-]?|insert[_-]?|replace[_-]?|enter[_-]?|example|changeme|placeholder|dummy|redacted|todo|none|null|undefined|test[_-]?key|sample|<[^>]+>|\$\{[^}]+\}|x{4,}|\*{4,}|0{6,})/i;

export function isPlaceholderSecretValue(rawVal = '') {
  const cleaned = String(rawVal || '').trim().replace(/^['"]|['"]$/g, () => '');
  if (!cleaned || cleaned.length < 8) return true;
  if (PLACEHOLDER_VALUE_RE.test(cleaned)) return true;
  if (/YOUR_API_KEY|EXAMPLE|CHANGEME|PLACEHOLDER|DUMMY|REDACTED|FAKE_KEY|SAMPLE_KEY/i.test(cleaned)) {
    return true;
  }
  return false;
}

export function computeShannonEntropy(str = '') {
  const s = String(str || '');
  if (!s.length) return 0;
  const counts = new Map();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function redactSecretsPure(rawText = '') {
  let out = String(rawText ?? '');
  let redactedCount = 0;

  for (const def of LIVE_SECRET_DEFINITIONS) {
    const re = new RegExp(def.re.source, def.re.flags);
    out = out.replace(re, (match) => {
      if (def.id !== 'pem_private_key' && isPlaceholderSecretValue(match)) {
        return match;
      }
      redactedCount += 1;
      return def.redaction;
    });
  }

  // Scrub .env style KEY=VALUE secrets
  const envAssignRe = /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY|CLIENT_SECRET)[A-Z0-9_]*)\s*=\s*(['"]?)([^\s'"\r\n#]+)\2/g;
  out = out.replace(envAssignRe, (full, keyName, _quote, val) => {
    if (isPlaceholderSecretValue(val)) return full;
    redactedCount += 1;
    return `${keyName}=[REDACTED:ENV_SECRET]`;
  });

  return {
    sanitized: out,
    redactedCount
  };
}

const IPI_PATTERNS = Object.freeze([
  {
    id: 'ignore_previous_instructions',
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions|rules|prompts|directives)\b/gi,
    replacement: '[IPI_FILTERED:INSTRUCTION_OVERRIDE]'
  },
  {
    id: 'fake_system_tag',
    re: /<\s*\/?\s*(?:system|system_prompt|developer_instructions|user_rules|antml:thinking)\s*>/gi,
    replacement: '[IPI_FILTERED:TAG]'
  },
  {
    id: 'zero_width_stego',
    re: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,
    replacement: ''
  }
]);

export function sanitizeIpiPure(rawText = '') {
  let out = String(rawText ?? '');
  const detections = [];

  for (const pat of IPI_PATTERNS) {
    const re = new RegExp(pat.re.source, pat.re.flags);
    out = out.replace(re, () => {
      detections.push(pat.id);
      return pat.replacement;
    });
  }

  const secretRes = redactSecretsPure(out);
  return {
    sanitized: secretRes.sanitized,
    ipiDetected: detections.length > 0,
    detections,
    redactedSecretCount: secretRes.redactedCount
  };
}
