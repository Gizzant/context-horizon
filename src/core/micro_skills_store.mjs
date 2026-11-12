/**
 * @file src/core/micro_skills_store.mjs
 * Disk-backed RSI-04 Repo Micro-Skills persistence store for Google Antigravity (`GA_REPO`).
 * Persists `.agents/state/micro_skills.json` atomically after secret/bypass validation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomic_io.mjs';
import { redactSecretsPure } from './shared/ipi_sanitizer.mjs';
import {
  MAX_MICRO_SKILL_BATON_TOKENS,
  MAX_MICRO_SKILL_BATON_CHARS,
  inspectCommandSafetyForMicroSkill,
  canonicalizeMicroSkillCommand,
  createEmptyMicroSkillsRegistry,
  recordShellOutcomeInRegistry,
  evaluateMicroSkillIntercept,
  formatMicroSkillsBatonSnippet
} from '../core-isomorphic/diagnostics/micro_skills.mjs';

export {
  MAX_MICRO_SKILL_BATON_TOKENS,
  MAX_MICRO_SKILL_BATON_CHARS,
  inspectCommandSafetyForMicroSkill,
  canonicalizeMicroSkillCommand,
  createEmptyMicroSkillsRegistry,
  recordShellOutcomeInRegistry,
  evaluateMicroSkillIntercept,
  formatMicroSkillsBatonSnippet
};

export function resolveMicroSkillsPath(workspaceDir = process.cwd()) {
  return path.join(workspaceDir, '.agents', 'state', 'micro_skills.json');
}

export function loadMicroSkillsRegistry(workspaceDir = process.cwd()) {
  const filePath = resolveMicroSkillsPath(workspaceDir);
  try {
    if (!fs.existsSync(filePath)) {
      return createEmptyMicroSkillsRegistry();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyMicroSkillsRegistry();
    }
    return {
      schemaVersion: '1.0.0',
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      pendingFailuresBySession:
        parsed.pendingFailuresBySession && typeof parsed.pendingFailuresBySession === 'object'
          ? parsed.pendingFailuresBySession
          : {}
    };
  } catch {
    return createEmptyMicroSkillsRegistry();
  }
}

export function saveMicroSkillsRegistry(workspaceDir = process.cwd(), registry = {}) {
  const filePath = resolveMicroSkillsPath(workspaceDir);
  const rawJson = JSON.stringify(registry, null, 2);
  // Defense-in-depth secondary airlock scrub via ipi_sanitizer
  const { sanitized } = redactSecretsPure(rawJson);
  atomicWriteFileSync(filePath, `${sanitized}\n`, { encoding: 'utf8' });
  return filePath;
}

export function recordWorkspaceShellOutcome(workspaceDir = process.cwd(), event = {}) {
  const rawCmd = String(event.command || '');
  // Secondary secret check via redactSecretsPure: if redaction alters the command, reject immediately
  if (rawCmd) {
    const scrubCheck = redactSecretsPure(rawCmd);
    if (scrubCheck.redactedCount > 0 || scrubCheck.sanitized !== rawCmd) {
      return {
        updated: false,
        rejectedReason: 'SECRET_DETECTED',
        promotedSkill: null,
        capturedCandidate: null,
        evictedContradictions: [],
        registry: loadMicroSkillsRegistry(workspaceDir)
      };
    }
  }
  const current = loadMicroSkillsRegistry(workspaceDir);
  const res = recordShellOutcomeInRegistry(current, event);
  if (res.updated) {
    saveMicroSkillsRegistry(workspaceDir, res.registry);
  }
  return res;
}
