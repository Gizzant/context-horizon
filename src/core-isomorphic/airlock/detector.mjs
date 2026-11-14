/**
 * @file src/core-isomorphic/airlock/detector.mjs
 * Pure-JS 3-Stage Secret/PII/Policy Detection Pipeline (Mod Law 4 compliant).
 *
 * Stages:
 * - Stage 1: Prefix & Mathematical Validators (AWS, Stripe, GitHub, Slack, OpenAI/Anthropic/Google,
 *   PEM private keys, JWT Base64URL header decode, DB URIs, Luhn cards, contextual US SSNs, Mod-97 IBANs)
 * - Stage 2: Aho-Corasick Multi-Pattern Policy Trie (>= 5-char word-bounded terms & internal domains)
 *   + Salted HMAC fixture allowlisting
 * - Stage 3: Contextual Shannon Entropy (> 4.4 bits/char, hard-locked to `AUDIT_ONLY` until Gate G5)
 */

import {
  hmacSha256HexPure,
  deriveWriteOnlyPlaceholder,
  SYNTHETIC_PLACEHOLDER_TEST_RE
} from './hmacTwin.mjs';

const IS_WORD_CHAR_RE = /[A-Za-z0-9_]/;
const HEX_DIGEST_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128})$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PLACEHOLDER_LITERAL_RE =
  /^(?:<REDACTED>|\[REDACTED\]|AKIAIOSFODNN7EXAMPLE|YOUR_[A-Z0-9_]+|CHANGE_ME|REPLACE_ME|DUMMY_[A-Z0-9_]+|x{8,}|0{8,})$/i;

const IBAN_LENGTH_BY_COUNTRY = Object.freeze({
  AL: 28, AD: 24, AT: 20, AZ: 28, BH: 22, BY: 28, BE: 16, BA: 20, BR: 29, BG: 22,
  CR: 22, HR: 21, CY: 28, CZ: 24, DK: 18, DO: 28, EG: 29, SV: 28, EE: 20, FO: 18,
  FI: 18, FR: 27, GE: 22, DE: 22, GI: 23, GR: 27, GL: 18, GT: 28, HU: 28, IS: 26,
  IQ: 23, IE: 22, IL: 23, IT: 27, JO: 30, KZ: 20, XK: 20, KW: 30, LV: 21, LB: 28,
  LY: 25, LI: 21, LT: 20, LU: 20, MT: 31, MR: 27, MU: 30, MD: 24, MC: 27, ME: 22,
  NL: 18, MK: 19, NO: 15, PK: 24, PS: 29, PL: 28, PT: 25, QA: 29, RO: 24, LC: 32,
  SM: 27, ST: 25, SA: 24, RS: 22, SC: 31, SK: 24, SI: 19, ES: 24, SD: 18, SE: 24,
  CH: 21, TL: 23, TN: 24, TR: 26, UA: 29, AE: 23, GB: 22, VA: 22, VG: 24
});

const AUTOMATON_CACHE = new WeakMap();

/**
 * Pure-JS glob matcher supporting `*`, `**`, and `?` over normalized forward-slash paths.
 * @param {string} targetPath
 * @param {string} globPattern
 * @returns {boolean}
 */
export function globMatchPure(targetPath = '', globPattern = '') {
  const normPath = String(targetPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const normGlob = String(globPattern || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normPath || !normGlob) return false;

  const escaped = normGlob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*/g, (tok) => {
      if (tok === '**/') return '(?:.+/)?';
      if (tok === '**') return '.*';
      return '[^/]*';
    })
    .replace(/\?/g, '[^/]');

  try {
    const re = new RegExp(`^(?:.*/)?${escaped}$`, 'i');
    return re.test(normPath);
  } catch {
    return false;
  }
}

/**
 * Multi-pattern Aho-Corasick automaton with word-boundary and >= 5-char enforcement (FM-2).
 */
export class AhoCorasickAutomaton {
  constructor() {
    this.nodes = [{ next: Object.create(null), fail: 0, out: [] }];
    this.termCount = 0;
  }

  /**
   * Builds the automaton from string terms or `{ term, category, ruleId }` descriptors.
   * Terms shorter than 5 chars are ignored to avoid dictionary false positives (FM-2).
   * @param {Array<string | { term: string, category?: string, ruleId?: string }>} entries
   * @returns {AhoCorasickAutomaton}
   */
  build(entries = []) {
    this.nodes = [{ next: Object.create(null), fail: 0, out: [] }];
    this.termCount = 0;

    for (const rawEntry of entries) {
      const term =
        typeof rawEntry === 'string' ? rawEntry : String(rawEntry?.term || '');
      const clean = term.trim();
      if (clean.length < 5) continue;

      const normalized = clean.toLowerCase();
      let state = 0;
      for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];
        let nextState = this.nodes[state].next[ch];
        if (nextState === undefined) {
          nextState = this.nodes.length;
          this.nodes[state].next[ch] = nextState;
          this.nodes.push({ next: Object.create(null), fail: 0, out: [] });
        }
        state = nextState;
      }

      this.nodes[state].out.push({
        len: normalized.length,
        term: clean,
        category:
          (typeof rawEntry === 'object' && rawEntry?.category) || 'POLICY_TERM',
        ruleId:
          (typeof rawEntry === 'object' && rawEntry?.ruleId) || 'STAGE2_POLICY_TERM'
      });
      this.termCount += 1;
    }

    // BFS failure link construction
    const queue = [];
    const rootNext = this.nodes[0].next;
    const rootKeys = Object.keys(rootNext);
    for (let i = 0; i < rootKeys.length; i++) {
      const child = rootNext[rootKeys[i]];
      this.nodes[child].fail = 0;
      queue.push(child);
    }

    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      const currNext = this.nodes[curr].next;
      const keys = Object.keys(currNext);
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const nextState = currNext[ch];
        let f = this.nodes[curr].fail;
        while (f !== 0 && this.nodes[f].next[ch] === undefined) {
          f = this.nodes[f].fail;
        }
        const failTarget =
          this.nodes[f].next[ch] !== undefined ? this.nodes[f].next[ch] : 0;
        this.nodes[nextState].fail = failTarget;
        if (this.nodes[failTarget].out.length > 0) {
          this.nodes[nextState].out = this.nodes[nextState].out.concat(
            this.nodes[failTarget].out
          );
        }
        queue.push(nextState);
      }
    }

    return this;
  }

  /**
   * Scans `text` in O(n) character steps and emits word-bounded matches.
   * @param {string} text
   * @returns {Array<{ start: number, end: number, value: string, category: string, ruleId: string }>}
   */
  search(text = '') {
    if (this.termCount === 0 || !text) return [];
    const matches = [];
    const str = String(text);
    const lower = str.toLowerCase();
    let state = 0;

    for (let i = 0; i < lower.length; i++) {
      const ch = lower[i];
      while (state !== 0 && this.nodes[state].next[ch] === undefined) {
        state = this.nodes[state].fail;
      }
      const nextState = this.nodes[state].next[ch];
      state = nextState !== undefined ? nextState : 0;

      const outs = this.nodes[state].out;
      if (outs.length === 0) continue;

      const end = i + 1;
      const charAfter = end < str.length ? str[end] : '';
      if (charAfter && IS_WORD_CHAR_RE.test(charAfter)) continue;

      for (let j = 0; j < outs.length; j++) {
        const o = outs[j];
        const start = end - o.len;
        const charBefore = start > 0 ? str[start - 1] : '';
        if (charBefore && IS_WORD_CHAR_RE.test(charBefore)) continue;

        matches.push({
          start,
          end,
          value: str.slice(start, end),
          category: o.category,
          ruleId: o.ruleId
        });
      }
    }
    return matches;
  }
}

/**
 * Validates payment card digits using the Luhn modulo-10 checksum.
 * @param {string} raw
 * @returns {boolean}
 */
export function validateLuhn(raw = '') {
  const digits = String(raw || '').replace(/[\s-]+/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;

  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Validates ISO 13616 IBAN length and modulo-97 check digits.
 * @param {string} raw
 * @returns {boolean}
 */
export function validateIbanMod97(raw = '') {
  const clean = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) return false;

  const country = clean.slice(0, 2);
  const expectedLen = IBAN_LENGTH_BY_COUNTRY[country];
  if (!expectedLen || clean.length !== expectedLen) return false;

  const rearranged = clean.slice(4) + clean.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      const val = code - 55;
      remainder = (remainder * 100 + val) % 97;
    } else {
      return false;
    }
  }
  return remainder === 1;
}

/**
 * Computes Shannon entropy in bits per character.
 * @param {string} str
 * @returns {number}
 */
export function computeShannonEntropyPure(str = '') {
  const s = String(str || '');
  if (!s) return 0;
  const counts = Object.create(null);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    counts[c] = (counts[c] || 0) + 1;
  }
  const len = s.length;
  let entropy = 0;
  const keys = Object.keys(counts);
  for (let i = 0; i < keys.length; i++) {
    const p = counts[keys[i]] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function decodeBase64UrlAscii(segment = '') {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b64 = String(segment || '').replace(/-/g, '+').replace(/_/g, '/');
  let bits = 0;
  let bitCount = 0;
  let out = '';
  for (let i = 0; i < b64.length; i++) {
    const ch = b64[i];
    if (ch === '=') break;
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return '';
    bits = (bits << 6) | idx;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out += String.fromCharCode((bits >>> bitCount) & 0xff);
    }
  }
  return out;
}

function isLikelyJwtHeader(token = '') {
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return false;
  const headerDecoded = decodeBase64UrlAscii(token.slice(0, dotIdx));
  if (!headerDecoded || headerDecoded[0] !== '{') return false;
  try {
    const parsed = JSON.parse(headerDecoded);
    return Boolean(parsed && typeof parsed === 'object' && typeof parsed.alg === 'string');
  } catch {
    return false;
  }
}

function hasCardIinPrefix(digits) {
  if (/^4(?:\d{12}|\d{15}|\d{18})$/.test(digits)) return true;
  if (/^(?:5[1-5]\d{14}|2(?:22[1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720)\d{12})$/.test(digits)) {
    return true;
  }
  if (/^3[47]\d{13}$/.test(digits)) return true;
  if (/^(?:6011\d{12}|65\d{14}|64[4-9]\d{13})$/.test(digits)) return true;
  return false;
}

function shouldSkipSafeToken(val, text, start, end) {
  if (!val) return true;
  if (SYNTHETIC_PLACEHOLDER_TEST_RE.test(val)) return true;
  if (SAFE_PLACEHOLDER_LITERAL_RE.test(val)) return true;
  if (HEX_DIGEST_RE.test(val) || UUID_RE.test(val)) return true;
  if (/^sha(?:256|384|512)-[A-Za-z0-9+/=_-]+$/i.test(val)) return true;

  const ctxBefore = text.slice(Math.max(0, start - 16), start);
  if (/sha(?:256|384|512)-$/i.test(ctxBefore)) return true;
  if (/(?:example\.com|example\.org|example\.net|synthetic\.test|synthetic\.internal)/i.test(val)) {
    return true;
  }
  void end;
  return false;
}

const STAGE1_REGEX_RULES = [
  {
    ruleId: 'STAGE1_PRIVATE_KEY',
    category: 'PRIVATE_KEY',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----(?:[\s\S]{16,4096}?-----END [A-Z0-9 ]+-----)?/g
  },
  {
    ruleId: 'STAGE1_AWS_KEY',
    category: 'AWS_KEY',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
  },
  {
    ruleId: 'STAGE1_STRIPE_KEY',
    category: 'STRIPE_KEY',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}\b/g
  },
  {
    ruleId: 'STAGE1_GITHUB_TOKEN',
    category: 'GITHUB_TOKEN',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})\b/g
  },
  {
    ruleId: 'STAGE1_SLACK_TOKEN',
    category: 'SLACK_TOKEN',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g
  },
  {
    ruleId: 'STAGE1_API_KEY',
    category: 'API_KEY',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /\b(?:sk-ant-[0-9A-Za-z_-]{20,}|sk-proj-[0-9A-Za-z_-]{20,}|AIza[0-9A-Za-z_-]{35})\b/g
  },
  {
    ruleId: 'STAGE1_DB_URI',
    category: 'DB_URI',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/[^:\s/'"@]+:[^@\s/'"]+@[^\s'"<>]+/g
  },
  {
    ruleId: 'STAGE1_JWT',
    category: 'JWT',
    severityTier: 'TIER_1_CREDENTIAL',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
    validate: (val) => isLikelyJwtHeader(val)
  },
  {
    ruleId: 'STAGE1_CREDIT_CARD',
    category: 'CREDIT_CARD',
    severityTier: 'TIER_2_PII',
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: (val, text, start, end) => {
      const prev = start > 0 ? text[start - 1] : '';
      const next = end < text.length ? text[end] : '';
      if (/[0-9a-fA-Fx._]/.test(prev) || /[0-9a-fA-F._]/.test(next)) return false;
      const digits = val.replace(/[\s-]+/g, '');
      return hasCardIinPrefix(digits) && validateLuhn(digits);
    }
  },
  {
    ruleId: 'STAGE1_US_SSN',
    category: 'US_SSN',
    severityTier: 'TIER_2_PII',
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    validate: (_val, text, start, end, opts) => {
      if (opts?.strictSsn === true) return true;
      const windowText = text.slice(Math.max(0, start - 80), Math.min(text.length, end + 80));
      return /\b(?:ssn|social\s*security|tin|tax[_\s-]*id)\b/i.test(windowText);
    }
  },
  {
    ruleId: 'STAGE1_IBAN',
    category: 'IBAN',
    severityTier: 'TIER_2_PII',
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    validate: (val) => validateIbanMod97(val)
  }
];

function getPolicyAutomaton(policy) {
  const terms = Array.isArray(policy?.terms) ? policy.terms : [];
  if (terms.length === 0) return null;

  if (policy && typeof policy === 'object') {
    const cached = AUTOMATON_CACHE.get(policy);
    if (cached && cached.count === terms.length) {
      return cached.automaton;
    }
    const automaton = new AhoCorasickAutomaton().build(terms);
    AUTOMATON_CACHE.set(policy, { count: terms.length, automaton });
    return automaton;
  }

  return new AhoCorasickAutomaton().build(terms);
}

function buildAllowlistSet(policy) {
  const arr = Array.isArray(policy?.allowlistHmacs) ? policy.allowlistHmacs : [];
  return arr.length > 0 ? new Set(arr.map((h) => String(h).toLowerCase())) : null;
}

function isMatchAllowlisted(ruleId, rawValue, filePath, policy, allowlistSet, orgAllowlistSalt) {
  if (!allowlistSet || !orgAllowlistSalt) return false;
  const globs =
    Array.isArray(policy?.allowlistGlobs) && policy.allowlistGlobs.length > 0
      ? policy.allowlistGlobs
      : ['test/**', 'tests/**', '__tests__/**', '**/*.test.*'];
  const pathMatches = globs.some((g) => globMatchPure(filePath || '', g));
  if (!pathMatches) return false;

  const candidate = hmacSha256HexPure(orgAllowlistSalt, `${ruleId}:${rawValue}`).toLowerCase();
  if (allowlistSet.has(candidate)) return true;
  const wildcard = hmacSha256HexPure(orgAllowlistSalt, `*:${rawValue}`).toLowerCase();
  return allowlistSet.has(wildcard);
}

function resolveNonOverlappingSpans(rawSpans) {
  const sorted = [...rawSpans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });
  const kept = [];
  let cursor = -1;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.start >= cursor) {
      kept.push(s);
      cursor = s.end;
    }
  }
  return kept;
}

/**
 * Scans `text` across Stage 1, Stage 2 (Aho-Corasick + internal domains), and Stage 3 (entropy audit-only).
 * Returns resolved non-overlapping spans plus zero-plaintext entity HMAC digests.
 *
 * @param {string} text
 * @param {object} [options={}]
 */
export function scanTextWithAirlock(text = '', options = {}) {
  const src = String(text ?? '');
  if (!src) {
    return { matches: [], auditOnlyMatches: [], uniqueEntityHmacs: [] };
  }

  const policy = options.policy || {};
  const filePath = options.filePath || '';
  const orgAuditSalt = options.orgAuditSalt || options.sessionKey || 'default-audit-salt';
  const orgAllowlistSalt = options.orgAllowlistSalt || '';
  const allowlistSet = buildAllowlistSet(policy);
  const candidates = [];

  // Stage 1: Deterministic Prefix & Checksum Validators
  for (let i = 0; i < STAGE1_REGEX_RULES.length; i++) {
    const rule = STAGE1_REGEX_RULES[i];
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src)) !== null) {
      const val = m[0];
      const start = m.index;
      const end = start + val.length;
      if (shouldSkipSafeToken(val, src, start, end)) continue;
      if (rule.validate && !rule.validate(val, src, start, end, options)) continue;
      if (isMatchAllowlisted(rule.ruleId, val, filePath, policy, allowlistSet, orgAllowlistSalt)) {
        continue;
      }
      candidates.push({
        start,
        end,
        value: val,
        ruleId: rule.ruleId,
        category: rule.category,
        severityTier: rule.severityTier,
        action: 'SCRUBBED'
      });
    }
  }

  // Stage 2A: Internal Company Domains (emails & hostnames)
  const internalDomains = Array.isArray(policy.internalDomains)
    ? policy.internalDomains.map((d) => String(d || '').trim().toLowerCase()).filter((d) => d.length >= 4)
    : [];
  if (internalDomains.length > 0) {
    const emailRe = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
    let em;
    while ((em = emailRe.exec(src)) !== null) {
      const domain = em[1].toLowerCase();
      if (
        internalDomains.some(
          (d) => domain === d.replace(/^\./, '') || domain.endsWith(d.startsWith('.') ? d : `.${d}`)
        )
      ) {
        const val = em[0];
        if (!shouldSkipSafeToken(val, src, em.index, em.index + val.length) &&
            !isMatchAllowlisted('STAGE2_INTERNAL_EMAIL', val, filePath, policy, allowlistSet, orgAllowlistSalt)) {
          candidates.push({
            start: em.index,
            end: em.index + val.length,
            value: val,
            ruleId: 'STAGE2_INTERNAL_EMAIL',
            category: 'EMAIL',
            severityTier: 'TIER_3_POLICY',
            action: 'SCRUBBED'
          });
        }
      }
    }

    const hostRe = /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
    let hm;
    while ((hm = hostRe.exec(src)) !== null) {
      const host = hm[0].toLowerCase();
      if (
        internalDomains.some(
          (d) => host === d.replace(/^\./, '') || host.endsWith(d.startsWith('.') ? d : `.${d}`)
        )
      ) {
        const val = hm[0];
        if (!shouldSkipSafeToken(val, src, hm.index, hm.index + val.length) &&
            !isMatchAllowlisted('STAGE2_INTERNAL_HOST', val, filePath, policy, allowlistSet, orgAllowlistSalt)) {
          candidates.push({
            start: hm.index,
            end: hm.index + val.length,
            value: val,
            ruleId: 'STAGE2_INTERNAL_HOST',
            category: 'HOST',
            severityTier: 'TIER_3_POLICY',
            action: 'SCRUBBED'
          });
        }
      }
    }
  }

  // Stage 2B: Compiled Aho-Corasick Policy Automaton
  const automaton = getPolicyAutomaton(policy);
  if (automaton) {
    const termMatches = automaton.search(src);
    for (let i = 0; i < termMatches.length; i++) {
      const tm = termMatches[i];
      if (shouldSkipSafeToken(tm.value, src, tm.start, tm.end)) continue;
      if (isMatchAllowlisted(tm.ruleId, tm.value, filePath, policy, allowlistSet, orgAllowlistSalt)) {
        continue;
      }
      candidates.push({
        start: tm.start,
        end: tm.end,
        value: tm.value,
        ruleId: tm.ruleId,
        category: tm.category,
        severityTier: 'TIER_3_POLICY',
        action: 'SCRUBBED'
      });
    }
  }

  // Stage 3: Contextual Shannon Entropy (hard-locked AUDIT_ONLY unless enableStage3Redaction === true)
  const entropyRe =
    /\b(?:secret|token|password|passwd|pwd|api_key|apikey|access_key|private_key|auth_token|bearer)\b\s*[:=]\s*['"]?([A-Za-z0-9+/=_-]{20,})['"]?/gi;
  let entM;
  while ((entM = entropyRe.exec(src)) !== null) {
    const secretVal = entM[1];
    const start = entM.index + entM[0].lastIndexOf(secretVal);
    const end = start + secretVal.length;
    if (shouldSkipSafeToken(secretVal, src, start, end)) continue;
    if (computeShannonEntropyPure(secretVal) <= 4.4) continue;
    if (isMatchAllowlisted('STAGE3_ENTROPY', secretVal, filePath, policy, allowlistSet, orgAllowlistSalt)) {
      continue;
    }
    candidates.push({
      start,
      end,
      value: secretVal,
      ruleId: 'STAGE3_ENTROPY',
      category: 'HIGH_ENTROPY_TOKEN',
      severityTier: 'TIER_3_ENTROPY',
      action: options.enableStage3Redaction === true ? 'SCRUBBED' : 'AUDIT_ONLY'
    });
  }

  const resolved = resolveNonOverlappingSpans(candidates);
  const matches = [];
  const auditOnlyMatches = [];
  const hmacSet = new Set();

  for (let i = 0; i < resolved.length; i++) {
    const m = resolved[i];
    const entityHmac = hmacSha256HexPure(orgAuditSalt, `${m.category}:${m.value}`);
    const record = {
      start: m.start,
      end: m.end,
      ruleId: m.ruleId,
      category: m.category,
      severityTier: m.severityTier,
      action: m.action,
      entityHmac,
      value: m.value
    };
    hmacSet.add(entityHmac);
    if (m.action === 'AUDIT_ONLY') {
      auditOnlyMatches.push(record);
    } else {
      matches.push(record);
    }
  }

  return {
    matches,
    auditOnlyMatches,
    uniqueEntityHmacs: Array.from(hmacSet)
  };
}

/**
 * Replaces Stage 1 and Stage 2 matches (plus Stage 3 only when explicitly unlocked) with
 * deterministic Write-Only Co-Reference Placeholders.
 *
 * @param {string} text
 * @param {object} [options={}]
 */
export function scrubTextWithAirlock(text = '', options = {}) {
  const src = String(text ?? '');
  const sessionKey = options.sessionKey || 'ephemeral-default-key';
  const scan = scanTextWithAirlock(src, options);
  const activeMatches = options.auditOnly === true ? [] : scan.matches;

  if (activeMatches.length === 0) {
    return {
      scrubbedText: src,
      modified: false,
      matches: scan.matches,
      auditOnlyMatches: scan.auditOnlyMatches,
      uniqueEntityHmacs: scan.uniqueEntityHmacs
    };
  }

  let out = '';
  let lastIdx = 0;
  for (let i = 0; i < activeMatches.length; i++) {
    const m = activeMatches[i];
    out += src.slice(lastIdx, m.start);
    out += deriveWriteOnlyPlaceholder(m.category, m.value, sessionKey);
    lastIdx = m.end;
  }
  out += src.slice(lastIdx);

  return {
    scrubbedText: out,
    modified: out !== src,
    matches: scan.matches,
    auditOnlyMatches: scan.auditOnlyMatches,
    uniqueEntityHmacs: scan.uniqueEntityHmacs
  };
}
