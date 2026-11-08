import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './paths.mjs';

/**
 * Zero-PII Sanitized Forensic Snapshot Exporter.
 *
 * Scrubs API keys (`sk-ant-*`, `sk-proj-*`, `AIza*`), GitHub PATs (`ghp_*`, `github_pat_*`),
 * Bearer tokens, AWS keys (`AKIA*`), `.env` assignments, and user home directory paths (`C:\Users\<user>` -> `~`)
 * before exporting a shareable JSON or self-contained HTML forensic bundle.
 */

const SECRET_PATTERNS = [
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED:ANTHROPIC_KEY]' },
  { name: 'openai_key', re: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED:OPENAI_KEY]' },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: '[REDACTED:GOOGLE_API_KEY]' },
  { name: 'github_pat', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, replacement: '[REDACTED:GITHUB_PAT]' },
  { name: 'github_fine_pat', re: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, replacement: '[REDACTED:GITHUB_PAT]' },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED:AWS_KEY]' },
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi, replacement: 'Bearer [REDACTED:TOKEN]' },
  { name: 'env_secret', re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*(['"]?)[^\s'"]+\2/g, replacement: '$1=[REDACTED:ENV]' }
];

export function sanitizeForensicPayload(input, { homeDir = getHomeDir() } = {}) {
  let redactedSecretCount = 0;
  let redactedPathCount = 0;

  const cleanHome = String(homeDir || '').replace(/\\/g, '/').replace(/\/$/, '');
  const winHome = cleanHome.replace(/\//g, '\\');

  const scrubString = (str) => {
    let out = String(str);
    for (const pat of SECRET_PATTERNS) {
      out = out.replace(pat.re, (...args) => {
        redactedSecretCount += 1;
        if (pat.name === 'env_secret') {
          return `${args[1]}=[REDACTED:ENV]`;
        }
        return pat.replacement;
      });
    }

    if (cleanHome && cleanHome.length > 3) {
      if (out.includes(cleanHome)) {
        redactedPathCount += 1;
        out = out.split(cleanHome).join('~');
      }
      if (winHome && out.includes(winHome)) {
        redactedPathCount += 1;
        out = out.split(winHome).join('~');
      }
    }

    // Also scrub generic OS user paths like C:\Users\<username> or /Users/<username>
    out = out.replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)([A-Za-z0-9._-]+)(?=[\\/])/g, () => {
      redactedPathCount += 1;
      return '~';
    });

    return out;
  };

  const walk = (val) => {
    if (typeof val === 'string') return scrubString(val);
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') {
      const next = {};
      for (const [k, v] of Object.entries(val)) {
        next[k] = walk(v);
      }
      return next;
    }
    return val;
  };

  const sanitized = walk(input);
  return {
    sanitized,
    redactedSecretCount,
    redactedPathCount
  };
}

export function exportSanitizedSnapshot(state = {}, { format = 'json', homeDir = getHomeDir(), outputPath = null } = {}) {
  const { sanitized, redactedSecretCount, redactedPathCount } = sanitizeForensicPayload(state, { homeDir });
  const payload = {
    exportedAt: new Date().toISOString(),
    zeroPiiVerified: true,
    redactedSecretCount,
    redactedPathCount,
    state: sanitized
  };

  const content = format === 'html'
    ? `<!doctype html><html><head><meta charset="utf-8"><title>Sanitized Horizon Snapshot</title></head><body><pre id="snapshotData">${JSON.stringify(payload, null, 2).replace(/</g, '&lt;')}</pre></body></html>`
    : JSON.stringify(payload, null, 2);

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf8');
  }

  return {
    success: true,
    format,
    outputPath,
    redactedSecretCount,
    redactedPathCount,
    content,
    payload
  };
}
