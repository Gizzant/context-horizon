import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalizePath } from '../paths.mjs';
import { SESSION_RISK_THRESHOLDS } from '../constants.mjs';
import { auditRuleContradictions } from './contradiction_auditor.mjs';

/**
 * Phase 2.2: "Teachable Moments" Reflector Queue & Project-Scoped Hash Isolation (`DET-16`)
 * (`src/core/coach/reflector_queue.mjs`)
 *
 * Features #12, #16, #18 (Top Unbuilt Gap #2):
 *  - Stages mid-session user corrections in `.agents/cache/learnings-queue.json` so
 *    `AGENTS.md` / `GEMINI.md` are never mutated while the 5-minute KV cache is warm.
 *  - Isolates learned rules by a 12-char repository identity hash (`project_hash`) to
 *    prevent cross-project Knowledge Bleed.
 *  - Enforces the Global Promotion Pipeline: a rule only promotes to global scope once
 *    it achieves `confidence >= 0.80` across `>= 2` distinct `project_hash` repositories.
 *  - Routes domain clusters (`>= 3` approved learnings) into `.agents/skills/<domain>/SKILL.md`
 *    (which lazy-loads on demand at 0 Turn-0 token cost) strictly when the cache is cold.
 */

export const REFLECTOR_CONSTANTS = Object.freeze({
  WARM_CACHE_LOCK_TOKENS: SESSION_RISK_THRESHOLDS.WARM_CACHE_LOCK_TOKENS,
  GLOBAL_PROMOTION_MIN_CONFIDENCE: 0.80,
  GLOBAL_PROMOTION_MIN_REPOS: 2,
  SKILL_CLUSTER_MIN_COUNT: 3
});

function tryGetGitRemoteOrigin(workspaceDir) {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return '';
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Computes a deterministic 12-character SHA-256 hex identity hash for a repository
 * to keep learned rules isolated locally until cross-project promotion.
 */
export function computeProjectScopeHash(workspaceDir = process.cwd(), { gitRemoteUrl = '' } = {}) {
  const remote = String(gitRemoteUrl || tryGetGitRemoteOrigin(workspaceDir) || '')
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '');
  const seed = remote || canonicalizePath(String(workspaceDir || process.cwd()));
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Evaluates which instincts across multiple projects meet the Global Promotion Pipeline
 * threshold (`confidence >= 0.80` across `>= 2` distinct `project_hash` values).
 */
export function evaluateGlobalPromotionEligibility(
  instinctRows = [],
  {
    minConfidence = REFLECTOR_CONSTANTS.GLOBAL_PROMOTION_MIN_CONFIDENCE,
    minDistinctRepos = REFLECTOR_CONSTANTS.GLOBAL_PROMOTION_MIN_REPOS
  } = {}
) {
  const groups = new Map();

  for (const row of Array.isArray(instinctRows) ? instinctRows : []) {
    if (!row || row.status === 'quarantined' || row.status === 'contradiction_blocked') continue;
    const conf = Number(row.confidence ?? 0);
    if (conf < minConfidence) continue;

    const domain = String(row.domain || 'general').toLowerCase().trim();
    const directive = String(row.directive_action || '').trim();
    if (!directive) continue;

    const key = `${domain}::${directive.toLowerCase().replace(/\s+/g, ' ')}`;
    const projHash = String(row.project_hash || row.projectHash || 'local');

    if (!groups.has(key)) {
      groups.set(key, {
        domain,
        directive_action: directive,
        trigger_condition: String(row.trigger_condition || 'When executing matching domain tasks'),
        projectHashes: new Set(),
        confidences: [],
        instinctIds: []
      });
    }

    const entry = groups.get(key);
    entry.projectHashes.add(projHash);
    entry.confidences.push(conf);
    if (row.id) entry.instinctIds.push(row.id);
  }

  const eligible = [];
  for (const entry of groups.values()) {
    const repoCount = entry.projectHashes.size;
    if (repoCount >= minDistinctRepos) {
      const avgConf =
        entry.confidences.reduce((a, b) => a + b, 0) / Math.max(1, entry.confidences.length);
      eligible.push({
        domain: entry.domain,
        directive_action: entry.directive_action,
        trigger_condition: entry.trigger_condition,
        distinctRepoCount: repoCount,
        projectHashes: Array.from(entry.projectHashes),
        avgConfidence: Number(avgConf.toFixed(4)),
        instinctIds: entry.instinctIds,
        eligibleForGlobal: true
      });
    }
  }

  return eligible;
}

export class ReflectorQueue {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.projectHash =
      options.projectHash ||
      computeProjectScopeHash(this.workspaceDir, { gitRemoteUrl: options.gitRemoteUrl });
    this.queuePath =
      options.queuePath ||
      path.join(this.workspaceDir, '.agents', 'cache', 'learnings-queue.json');
    this.skillsBaseDir =
      options.skillsBaseDir ||
      path.join(this.workspaceDir, '.agents', 'skills');
    this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
  }

  _readQueueData() {
    if (!fs.existsSync(this.queuePath)) {
      return {
        version: 1,
        project_hash: this.projectHash,
        updated_at: new Date(this.nowFn()).toISOString(),
        items: []
      };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
      if (!Array.isArray(parsed.items)) parsed.items = [];
      return parsed;
    } catch {
      return {
        version: 1,
        project_hash: this.projectHash,
        updated_at: new Date(this.nowFn()).toISOString(),
        items: []
      };
    }
  }

  _writeQueueData(data) {
    fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
    data.updated_at = new Date(this.nowFn()).toISOString();
    fs.writeFileSync(this.queuePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  /**
   * Stages a candidate learning ("Teachable Moment") in `learnings-queue.json`
   * after running `auditRuleContradictions` against existing workspace rules and queued items.
   */
  enqueue(learning = {}, { existingRulesText = '' } = {}) {
    const data = this._readQueueData();
    const directive = String(learning.directive_action || learning.ruleText || '').trim();
    if (!directive) {
      throw new Error('ReflectorQueue.enqueue: directive_action is required');
    }

    const domain = String(learning.domain || 'general').toLowerCase().trim();
    const trigger = String(learning.trigger_condition || 'When working in this project').trim();
    const projHash = String(learning.project_hash || learning.projectHash || this.projectHash);
    const confidence = Number.isFinite(learning.confidence) ? Number(learning.confidence) : 0.30;

    // Combine existing workspace rules + active staged/approved items in the same project for contradiction checking
    const activeProjectDirectives = data.items
      .filter((it) => it.project_hash === projHash && it.status !== 'dismissed' && it.status !== 'contradiction_blocked')
      .map((it) => it.directive_action);

    const combinedExisting = [
      ...String(existingRulesText || '').split(/\r?\n/),
      ...activeProjectDirectives
    ];

    const audit = auditRuleContradictions(directive, combinedExisting);
    const nowIso = new Date(this.nowFn()).toISOString();

    // Check if identical item already exists for this projectHash
    const existingItem = data.items.find(
      (it) =>
        it.project_hash === projHash &&
        it.domain === domain &&
        it.directive_action.toLowerCase().replace(/\s+/g, ' ') === directive.toLowerCase().replace(/\s+/g, ' ')
    );

    if (existingItem) {
      existingItem.confidence = Math.min(0.95, Number((existingItem.confidence + 0.12).toFixed(4)));
      existingItem.updated_at = nowIso;
      if (audit.hasContradiction) {
        existingItem.status = 'contradiction_blocked';
        existingItem.contradictions = audit.conflicts;
      }
      this._writeQueueData(data);
      return {
        enqueued: false,
        reinforced: true,
        blockedByContradiction: audit.hasContradiction,
        item: existingItem,
        contradictionAudit: audit
      };
    }

    const item = {
      id: learning.id || `learn-${crypto.randomBytes(6).toString('hex')}`,
      detectorId: 'DET-16',
      project_hash: projHash,
      scope: learning.scope === 'global' ? 'global' : 'project',
      domain,
      trigger_condition: trigger,
      directive_action: directive,
      confidence,
      status: audit.hasContradiction ? 'contradiction_blocked' : (learning.status || 'staged'),
      contradictions: audit.conflicts,
      source: learning.source || 'teachable_moment',
      session_id: learning.sessionId || 'default-session',
      created_at: nowIso,
      updated_at: nowIso
    };

    data.items.push(item);
    this._writeQueueData(data);

    return {
      enqueued: !audit.hasContradiction,
      reinforced: false,
      blockedByContradiction: audit.hasContradiction,
      item,
      contradictionAudit: audit
    };
  }

  approve(id) {
    const data = this._readQueueData();
    const item = data.items.find((it) => it.id === id);
    if (!item) return null;
    if (item.status === 'contradiction_blocked') {
      return { approved: false, reason: 'CONTRADICTION_BLOCKED', item };
    }
    item.status = 'approved';
    item.updated_at = new Date(this.nowFn()).toISOString();
    this._writeQueueData(data);
    return { approved: true, item };
  }

  dismiss(id) {
    const data = this._readQueueData();
    const item = data.items.find((it) => it.id === id);
    if (!item) return null;
    item.status = 'dismissed';
    item.updated_at = new Date(this.nowFn()).toISOString();
    this._writeQueueData(data);
    return { dismissed: true, item };
  }

  listItems(filter = {}) {
    const data = this._readQueueData();
    const targetHash = filter.projectHash || (filter.currentProjectOnly !== false ? this.projectHash : null);
    return data.items.filter((it) => {
      if (targetHash && it.project_hash !== targetHash) return false;
      if (filter.status && it.status !== filter.status) return false;
      if (filter.domain && it.domain !== filter.domain) return false;
      return true;
    });
  }

  /**
   * Routes approved or staged high-confidence learnings for a domain into
   * `.agents/skills/<domain>/SKILL.md` ONLY when the session KV cache is cold
   * (`cachedTokens < 15000` or `ttlRemainingSeconds === 0`).
   */
  routeDomainToSkill(domain, { session = {}, minCount = REFLECTOR_CONSTANTS.SKILL_CLUSTER_MIN_COUNT } = {}) {
    const cachedTokens = Number(session.cachedTokens ?? 0);
    const ttlRemainingSeconds = Number(session.ttlRemainingSeconds ?? session.cacheTtlSeconds ?? 0);

    if (cachedTokens >= REFLECTOR_CONSTANTS.WARM_CACHE_LOCK_TOKENS && ttlRemainingSeconds > 0) {
      return {
        routed: false,
        deferredByWarmCache: true,
        reason: `Warm KV cache lock active (${cachedTokens} tokens, ${ttlRemainingSeconds}s TTL remaining)`
      };
    }

    const cleanDomain = String(domain || 'general').toLowerCase().trim();
    const data = this._readQueueData();
    const eligible = data.items.filter(
      (it) =>
        it.project_hash === this.projectHash &&
        it.domain === cleanDomain &&
        (it.status === 'approved' || it.status === 'staged')
    );

    if (eligible.length < minCount) {
      return {
        routed: false,
        deferredByWarmCache: false,
        reason: `Domain "${cleanDomain}" has ${eligible.length}/${minCount} learnings required for skill synthesis`
      };
    }

    const skillSlug = `${cleanDomain.replace(/[^a-z0-9-]+/g, '-')}-project-instincts`;
    const skillPath = path.join(this.skillsBaseDir, skillSlug, 'SKILL.md');

    const lines = [
      '---',
      `name: ${skillSlug}`,
      `description: Project-scoped (${this.projectHash}) evolved instincts for ${cleanDomain} (${eligible.length} verified rules).`,
      '---',
      '',
      `# ${skillSlug} (\`${cleanDomain}\` | Repo \`${this.projectHash}\`)`,
      '',
      '## Project Directives',
      '',
      ...eligible.map(
        (it, i) =>
          `${i + 1}. **${it.directive_action}** *(when: ${it.trigger_condition}; confidence: ${Number(it.confidence).toFixed(2)})*`
      ),
      ''
    ];

    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, lines.join('\n'), 'utf8');

    for (const it of eligible) {
      it.status = 'promoted_to_skill';
      it.updated_at = new Date(this.nowFn()).toISOString();
    }
    this._writeQueueData(data);

    return {
      routed: true,
      deferredByWarmCache: false,
      domain: cleanDomain,
      skillSlug,
      skillPath,
      promotedCount: eligible.length,
      projectHash: this.projectHash
    };
  }
}

export default ReflectorQueue;
