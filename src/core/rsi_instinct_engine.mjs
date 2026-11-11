import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getHomeDir, canonicalizePath } from './paths.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';
import { openLocalHorizonDb } from './sqlite_client.mjs';
import { PrefixCacheShield } from './prefix_cache_shield.mjs';
import { auditRuleContradictions } from './coach/contradiction_auditor.mjs';
import {
  computeProjectScopeHash,
  evaluateGlobalPromotionEligibility
} from './coach/reflector_queue.mjs';

/**
 * Phase 3: Bounded Atomic Instinct & Correction Learning Loop (RSI Engine)
 *
 * Turns user corrections and execution outcomes into confidence-weighted Atomic Instincts
 * and modular Antigravity Skills (SKILL.md) with strict anti-reward-hacking safeguards
 * and an automatic Git Rollback Tripwire.
 */

export const RSI_CONSTANTS = Object.freeze({
  INITIAL_CONFIDENCE: 0.30,
  MAX_CONFIDENCE: 0.95,
  MIN_CONFIDENCE: 0.05,
  HELPFUL_DELTA: 0.12,
  HARMFUL_DELTA: -0.20,
  COACH_INJECTION_MIN_CONFIDENCE: 0.55,
  PROMOTION_MIN_CONFIDENCE: 0.75,
  PROMOTION_MIN_HELPFUL_COUNT: 3,
  EVOLVE_CLUSTER_MIN_COUNT: 5,
  EVOLVE_CLUSTER_MIN_CONFIDENCE: 0.55,
  STALENESS_TTL_MS: 48 * 60 * 60 * 1000, // 48 hours
  TRIPWIRE_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
  TRIPWIRE_PASS_RATE_DROP_THRESHOLD: 0.15, // >15% drop triggers rollback
  TRIPWIRE_HARMFUL_COUNT_THRESHOLD: 2
});

const IMMUTABLE_BOUNDARY_PATTERNS = [
  // Test suites
  /(^|[\\/])(tests?|__tests__|specs?)[\\/]/i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  // CI workflows
  /(^|[\\/])\.github[\\/]workflows[\\/]/i,
  /(^|[\\/])(\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile)$/i,
  // Linter, formatter & compiler configs
  /(^|[\\/])(\.eslintrc(\.[a-z0-9]+)?|eslint\.config\.[a-z0-9]+|biome\.jsonc?|\.prettierrc(\.[a-z0-9]+)?|tsconfig(\.[a-z0-9]+)?\.json|package\.json|package-lock\.json)$/i,
  // Scoring & telemetry SQLite databases
  /instincts\.db(-wal|-shm)?$/i,
  /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i
];

/**
 * Enforces the Immutable File Boundary List:
 * The RSI Engine is hard-blocked from writing to test suites, CI workflows,
 * linter/compiler configs, or its own scoring SQLite database.
 */
export function isImmutableRsiTarget(filePath = '') {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = filePath.trim().replace(/\\/g, '/');
  for (const pattern of IMMUTABLE_BOUNDARY_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

export function assertMutableRsiTarget(filePath = '') {
  if (isImmutableRsiTarget(filePath)) {
    const err = new Error(
      `RSI Immutable File Boundary violation: RSI Engine is hard-blocked from modifying "${filePath}"`
    );
    err.code = 'IMMUTABLE_FILE_BOUNDARY';
    throw err;
  }
}

export function getDefaultInstinctsDbPath(homeDir = getHomeDir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'agy-horizon', 'instincts.db');
}

const EXPLICIT_CORRECTION_PATTERNS = [
  {
    name: 'instead_of',
    regex: /\b(?:no[,:\s]+)?use\s+([^.,;!\n]+?)\s+instead\s+of\s+([^.,;!\n]+)/i,
    format: m => ({
      trigger_condition: `When tempted to use ${m[2].trim()}`,
      directive_action: `Always use ${m[1].trim()} instead of ${m[2].trim()}`
    })
  },
  {
    name: 'dont_use',
    regex: /\b(?:don'?t|do\s+not)\s+(?:use|call|import|run|write)\s+([^.,;!\n]+)/i,
    format: m => ({
      trigger_condition: `When considering ${m[1].trim()}`,
      directive_action: `Do not use ${m[1].trim()}`
    })
  },
  {
    name: 'stop_doing',
    regex: /\bstop\s+(?:doing|using|calling|writing|adding)\s+([^.,;!\n]+)/i,
    format: m => ({
      trigger_condition: `During implementation involving ${m[1].trim()}`,
      directive_action: `Stop using or doing ${m[1].trim()}`
    })
  },
  {
    name: 'never',
    regex: /\bnever\s+([^.,;!\n]{4,140})/i,
    format: m => ({
      trigger_condition: `When modifying relevant code`,
      directive_action: `NEVER ${m[1].trim()}`
    })
  },
  {
    name: 'always',
    regex: /\balways\s+([^.,;!\n]{4,140})/i,
    format: m => ({
      trigger_condition: `When executing matching domain tasks`,
      directive_action: `ALWAYS ${m[1].trim()}`
    })
  },
  {
    name: 'remember',
    regex: /\bremember(?:\s+to|:)\s*([^.,;!\n]{4,140})/i,
    format: m => ({
      trigger_condition: `Before completing task steps`,
      directive_action: `Remember: ${m[1].trim()}`
    })
  }
];

/**
 * Infers an instinct domain from text or file paths when not explicitly provided.
 */
export function inferInstinctDomain(text = '', filePaths = []) {
  const combined = `${text} ${(filePaths || []).join(' ')}`.toLowerCase();
  if (/\b(test|spec|assert|expect|vitest|jest|node:test|mock)\b/.test(combined)) {
    return 'testing';
  }
  if (/\b(typescript|type|interface|any|ts-ignore|tsconfig|generic)\b/.test(combined)) {
    return 'typescript-types';
  }
  if (/\b(git|commit|branch|rebase|merge|worktree|push|pull)\b/.test(combined)) {
    return 'git-workflow';
  }
  if (/\b(css|html|ui|webview|button|style|contrast|tufte|layout)\b/.test(combined)) {
    return 'ui-styling';
  }
  if (/\b(sqlite|wal|pragma|fts5|database|readonly)\b/.test(combined)) {
    return 'sqlite-telemetry';
  }
  return 'general';
}

/**
 * Extracts explicit user correction patterns and implicit behavioral signals from a turn.
 */
export function parseCorrectionSignals(turn = {}) {
  const results = [];
  const text = String(turn.userMessage || turn.userText || turn.content || turn.text || '').trim();
  const scope = turn.scope === 'global' ? 'global' : 'project';
  const domain = turn.domain || inferInstinctDomain(text, turn.files || []);

  if (text) {
    for (const pattern of EXPLICIT_CORRECTION_PATTERNS) {
      const match = text.match(pattern.regex);
      if (match) {
        const extracted = pattern.format(match);
        results.push({
          scope,
          domain,
          patternName: pattern.name,
          trigger_condition: turn.trigger_condition || extracted.trigger_condition,
          directive_action: turn.directive_action || extracted.directive_action,
          source: 'explicit_user_correction'
        });
        break;
      }
    }
  }

  // Implicit signal 1: User reverted or edited lines written by the agent within 2 turns
  if (turn.userRevertedAgentEdit || turn.userEditedAgentLines) {
    const fileLabel = turn.revertedFile ? path.basename(turn.revertedFile) : 'modified file';
    results.push({
      scope,
      domain,
      patternName: 'implicit_user_revert',
      trigger_condition: turn.trigger_condition || `When editing ${fileLabel}`,
      directive_action:
        turn.directive_action ||
        `Preserve user-preferred pattern in ${fileLabel}: ${turn.revertSummary || 'avoid reverted construct'}`,
      source: 'implicit_user_revert'
    });
  }

  // Implicit signal 2: Deterministic detector DET-01..16 fired
  if (turn.detectorViolation && turn.detectorViolation.id) {
    const det = turn.detectorViolation;
    results.push({
      scope,
      domain,
      patternName: `detector_${det.id}`,
      trigger_condition: turn.trigger_condition || `When executing tool actions monitored by ${det.id}`,
      directive_action:
        turn.directive_action || `Avoid ${det.id} (${det.name || 'anti-pattern'}): ${det.remediation || det.summary || ''}`.trim(),
      source: 'detector_violation'
    });
  }

  return results;
}

function tryGetGitHeadSha(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    }).trim();
  } catch {
    return null;
  }
}

export class RsiInstinctEngine {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.projectHash =
      options.projectHash ||
      computeProjectScopeHash(this.workspaceDir, { gitRemoteUrl: options.gitRemoteUrl });
    this.dbPath = options.dbPath || getDefaultInstinctsDbPath(this.homeDir);
    this.prefixShield =
      options.prefixShield ||
      options.prefixCacheShield ||
      new PrefixCacheShield({
        homeDir: this.homeDir,
        queuePath: options.queuePath
      });
    this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();
    this.db = null;
    this._rollingTestHistory = [];
    this._initDb();
  }

  _initDb() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = openLocalHorizonDb(this.dbPath, { readOnly: false });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instincts (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'project',
        project_hash TEXT NOT NULL DEFAULT 'local',
        domain TEXT NOT NULL DEFAULT 'general',
        trigger_condition TEXT NOT NULL,
        directive_action TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.30,
        helpful_count INTEGER NOT NULL DEFAULT 0,
        harmful_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        ttl_expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_instincts_domain_status
        ON instincts(domain, status, confidence);

      CREATE TABLE IF NOT EXISTS mutation_snapshots (
        mutation_id TEXT PRIMARY KEY,
        instinct_id TEXT,
        domain TEXT,
        target_path TEXT NOT NULL,
        existed_before INTEGER NOT NULL DEFAULT 0,
        previous_content TEXT,
        git_commit_sha TEXT,
        baseline_pass_rate REAL NOT NULL DEFAULT 1.0,
        created_at_ms INTEGER NOT NULL,
        rolled_back INTEGER NOT NULL DEFAULT 0,
        rollback_reason TEXT
      );
    `);

    // Ensure project_hash column exists on pre-existing instincts databases
    try {
      const cols = this.db.prepare(`PRAGMA table_info(instincts)`).all();
      const hasProjectHash = cols.some((c) => c.name === 'project_hash');
      if (!hasProjectHash) {
        this.db.exec(`ALTER TABLE instincts ADD COLUMN project_hash TEXT NOT NULL DEFAULT 'local';`);
      }
    } catch {}
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

  /**
   * Observes a user turn or correction signal and inserts or reinforces an Atomic Instinct.
   */
  observeTurn(turn = {}) {
    const signals = parseCorrectionSignals(turn);
    const createdOrUpdated = [];
    const projHash = String(turn.project_hash || turn.projectHash || this.projectHash);

    for (const sig of signals) {
      const existing = this.db
        .prepare(
          `SELECT * FROM instincts
           WHERE domain = ? AND directive_action = ? AND scope = ? AND project_hash = ?
           LIMIT 1`
        )
        .get(sig.domain, sig.directive_action, sig.scope, projHash);

      const nowMs = this.nowFn();
      const nowIso = new Date(nowMs).toISOString();
      const ttlIso = new Date(nowMs + RSI_CONSTANTS.STALENESS_TTL_MS).toISOString();

      if (existing) {
        // Reinforce existing instinct when user explicitly repeats or confirms it
        const updated = this.recordOutcome(existing.id, {
          helpful: true,
          session: turn.session,
          targetRulePath: turn.targetRulePath
        });
        createdOrUpdated.push(updated);
      } else {
        const id = turn.id || `inst-${crypto.randomBytes(6).toString('hex')}`;
        const initialConf = Number.isFinite(turn.initialConfidence)
          ? Number(turn.initialConfidence)
          : RSI_CONSTANTS.INITIAL_CONFIDENCE;
        this.db
          .prepare(
            `INSERT INTO instincts (
              id, scope, project_hash, domain, trigger_condition, directive_action,
              confidence, helpful_count, harmful_count, status,
              created_at, last_verified_at, ttl_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?)`
          )
          .run(
            id,
            sig.scope,
            projHash,
            sig.domain,
            sig.trigger_condition,
            sig.directive_action,
            initialConf,
            nowIso,
            nowIso,
            ttlIso
          );
        createdOrUpdated.push(this.getInstinctById(id));
      }
    }

    return createdOrUpdated;
  }

  getInstinctById(id) {
    if (!id) return null;
    return this.db.prepare(`SELECT * FROM instincts WHERE id = ?`).get(id) || null;
  }

  listInstincts(filter = {}) {
    const clauses = [];
    const params = [];
    if (filter.domain) {
      clauses.push('domain = ?');
      params.push(filter.domain);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.projectHash) {
      clauses.push('project_hash = ?');
      params.push(filter.projectHash);
    }
    if (Number.isFinite(filter.minConfidence)) {
      clauses.push('confidence >= ?');
      params.push(Number(filter.minConfidence));
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM instincts ${whereSql} ORDER BY confidence DESC, helpful_count DESC`)
      .all(...params);
  }

  /**
   * Evaluates cross-project instincts eligible for global promotion (`confidence >= 0.80` across `>= 2` repos).
   */
  getGlobalPromotionCandidates(options = {}) {
    const allActive = this.db
      .prepare(`SELECT * FROM instincts WHERE status IN ('active', 'promoted')`)
      .all();
    return evaluateGlobalPromotionEligibility(allActive, options);
  }

  /**
   * Deterministically updates confidence:
   *  - +0.12 when applied and subsequent turn passes tests with zero user reverts (`helpful_count++`)
   *  - -0.20 if a DET-01..16 violation or user revert occurs within 2 turns (`harmful_count++`)
   *
   * Automatically stages/applies a rule delta via PrefixCacheShield when
   * `confidence >= 0.75 && helpful_count >= 3`.
   */
  recordOutcome(instinctId, outcome = {}) {
    const inst = this.getInstinctById(instinctId);
    if (!inst) {
      throw new Error(`Instinct not found: ${instinctId}`);
    }

    const isHarmful =
      outcome.harmful === true ||
      outcome.userReverted === true ||
      outcome.detViolation === true ||
      Boolean(outcome.detectorViolation);

    const isHelpful = !isHarmful && (outcome.helpful !== false && outcome.passedTests !== false);

    let nextConfidence = Number(inst.confidence);
    let nextHelpful = Number(inst.helpful_count);
    let nextHarmful = Number(inst.harmful_count);
    let nextStatus = inst.status;

    if (isHarmful) {
      nextConfidence = Math.max(
        RSI_CONSTANTS.MIN_CONFIDENCE,
        Number((nextConfidence + RSI_CONSTANTS.HARMFUL_DELTA).toFixed(4))
      );
      nextHarmful += 1;
    } else if (isHelpful) {
      nextConfidence = Math.min(
        RSI_CONSTANTS.MAX_CONFIDENCE,
        Number((nextConfidence + RSI_CONSTANTS.HELPFUL_DELTA).toFixed(4))
      );
      nextHelpful += 1;
    }

    const nowMs = this.nowFn();
    const nowIso = new Date(nowMs).toISOString();
    const ttlIso = new Date(nowMs + RSI_CONSTANTS.STALENESS_TTL_MS).toISOString();

    let promotionResult = null;
    if (
      nextStatus !== 'quarantined' &&
      nextConfidence >= RSI_CONSTANTS.PROMOTION_MIN_CONFIDENCE &&
      nextHelpful >= RSI_CONSTANTS.PROMOTION_MIN_HELPFUL_COUNT
    ) {
      nextStatus = 'promoted';
      const targetRulePath =
        outcome.targetRulePath || this._resolveDefaultWorkspaceRulePath();
      if (targetRulePath) {
        promotionResult = this.promoteInstinctToRule(
          {
            ...inst,
            confidence: nextConfidence,
            helpful_count: nextHelpful,
            harmful_count: nextHarmful,
            status: nextStatus
          },
          {
            targetPath: targetRulePath,
            operation: outcome.operation || 'ADD',
            session: outcome.session || {}
          }
        );
      }
    }

    this.db
      .prepare(
        `UPDATE instincts
         SET confidence = ?,
             helpful_count = ?,
             harmful_count = ?,
             status = ?,
             last_verified_at = ?,
             ttl_expires_at = ?
         WHERE id = ?`
      )
      .run(nextConfidence, nextHelpful, nextHarmful, nextStatus, nowIso, ttlIso, instinctId);

    // Check if harmful_count >= 2 within 24h of a mutation triggers rollback tripwire
    let rollbackResult = null;
    if (isHarmful && nextHarmful >= RSI_CONSTANTS.TRIPWIRE_HARMFUL_COUNT_THRESHOLD) {
      rollbackResult = this.evaluateRollbackTripwire({
        instinctId,
        reason: `harmful_count=${nextHarmful} reached threshold (${RSI_CONSTANTS.TRIPWIRE_HARMFUL_COUNT_THRESHOLD})`
      });
    }

    return {
      ...this.getInstinctById(instinctId),
      promotionResult,
      rollbackResult
    };
  }

  _resolveDefaultWorkspaceRulePath() {
    const contextMd = path.join(this.workspaceDir, '.agents', 'CONTEXT.md');
    if (fs.existsSync(contextMd)) return contextMd;
    return path.join(this.workspaceDir, 'GEMINI.md');
  }

  /**
   * Stages or applies a deterministic rule delta via PrefixCacheShield and writes to
   * Antigravity's native Knowledge Items store while recording a Rollback Tripwire snapshot.
   */
  promoteInstinctToRule(instinct, options = {}) {
    const targetPath = path.resolve(options.targetPath || this._resolveDefaultWorkspaceRulePath());
    assertMutableRsiTarget(targetPath);

    const existingRulesContent =
      options.existingRulesContent !== undefined
        ? String(options.existingRulesContent)
        : fs.existsSync(targetPath)
        ? fs.readFileSync(targetPath, 'utf8')
        : '';

    if (existingRulesContent) {
      const contradictionAudit = auditRuleContradictions(
        instinct.directive_action || '',
        existingRulesContent
      );
      if (contradictionAudit.hasContradiction) {
        if (instinct.id && this.db) {
          this.db
            .prepare(`UPDATE instincts SET status = 'quarantined' WHERE id = ?`)
            .run(instinct.id);
        }
        return {
          contradictionBlocked: true,
          contradictionAudit,
          targetPath,
          ruleLine: null,
          shieldResult: null
        };
      }
    }

    const ruleLine = `- **[RSI:${instinct.domain}]** ${instinct.directive_action} *(trigger: ${instinct.trigger_condition}; confidence: ${Number(instinct.confidence).toFixed(2)})*`;

    // Record pre-mutation snapshot before flushing or staging
    const snapshotId = this._recordMutationSnapshot({
      instinctId: instinct.id,
      domain: instinct.domain,
      targetPath
    });

    const resolvedSession = options.session || {
      cacheState: options.cacheState,
      cacheWarm: options.cacheWarm,
      cachedTokens: options.cachedTokens,
      cacheTtlSeconds: options.cacheTtlSeconds,
      forceColdBust: options.forceColdBust,
      postCompact: options.postCompact
    };

    const shieldResult = this.prefixShield.stageOrApplyDelta(
      {
        targetPath,
        operation: options.operation || 'ADD',
        ruleText: ruleLine,
        source: 'rsi-instinct-engine',
        metadata: {
          instinctId: instinct.id,
          domain: instinct.domain,
          confidence: instinct.confidence,
          snapshotId
        }
      },
      resolvedSession
    );

    // Also update local Knowledge Items index
    this._syncKnowledgeItem(instinct, ruleLine);

    return {
      snapshotId,
      targetPath,
      ruleLine,
      staged: Boolean(shieldResult.staged),
      deferred: Boolean(shieldResult.deferred),
      shieldResult
    };
  }

  _syncKnowledgeItem(instinct, ruleLine) {
    try {
      const kiDir = path.join(this.homeDir, '.gemini', 'antigravity', 'agy-horizon', 'knowledge_items');
      fs.mkdirSync(kiDir, { recursive: true });
      const kiPath = path.join(kiDir, `${instinct.domain}.json`);
      const existing = fs.existsSync(kiPath)
        ? JSON.parse(fs.readFileSync(kiPath, 'utf8'))
        : { domain: instinct.domain, items: [] };
      const filtered = (existing.items || []).filter(item => item.id !== instinct.id);
      filtered.push({
        id: instinct.id,
        trigger_condition: instinct.trigger_condition,
        directive_action: instinct.directive_action,
        confidence: instinct.confidence,
        helpful_count: instinct.helpful_count,
        ruleLine,
        updated_at: new Date(this.nowFn()).toISOString()
      });
      existing.items = filtered;
      atomicWriteFileSync(kiPath, JSON.stringify(existing, null, 2) + '\n', { encoding: 'utf8' });
    } catch {}
  }

  /**
   * Injects active instincts with `confidence >= 0.55` and valid 48h TTL into
   * `brain/<GUID>/task.md` as a compact `<coach_instincts>` block for mid-session coaching.
   */
  injectCoachInstinctsIntoTaskMd(taskMdPath) {
    if (!taskMdPath) {
      throw new Error('taskMdPath is required for injectCoachInstinctsIntoTaskMd');
    }
    assertMutableRsiTarget(taskMdPath);

    const nowIso = new Date(this.nowFn()).toISOString();
    const eligible = this.db
      .prepare(
        `SELECT * FROM instincts
         WHERE status IN ('active', 'promoted')
           AND confidence >= ?
           AND ttl_expires_at > ?
         ORDER BY confidence DESC, helpful_count DESC
         LIMIT 10`
      )
      .all(RSI_CONSTANTS.COACH_INJECTION_MIN_CONFIDENCE, nowIso);

    const existingContent = fs.existsSync(taskMdPath) ? fs.readFileSync(taskMdPath, 'utf8') : '';
    const stripped = existingContent.replace(/\n*<coach_instincts>[\s\S]*?<\/coach_instincts>\n*/g, '\n');

    if (eligible.length === 0) {
      if (stripped !== existingContent) {
        atomicWriteFileSync(taskMdPath, stripped.trimEnd() + '\n', { encoding: 'utf8' });
      }
      return { injectedCount: 0, instincts: [] };
    }

    const lines = [
      '<coach_instincts>',
      '<!-- Active Mid-Session Atomic Instincts (48h TTL) -->',
      ...eligible.map(
        inst =>
          `- [${inst.domain} | conf=${Number(inst.confidence).toFixed(2)}] ${inst.directive_action} (when: ${inst.trigger_condition})`
      ),
      '</coach_instincts>'
    ];

    const updatedContent = `${stripped.trimEnd()}\n\n${lines.join('\n')}\n`;
    atomicWriteFileSync(taskMdPath, updatedContent, { encoding: 'utf8' });

    return {
      injectedCount: eligible.length,
      instincts: eligible,
      block: lines.join('\n')
    };
  }

  /**
   * Detects domain clusters where >= 5 high-confidence instincts are ready to evolve into a SKILL.md.
   */
  getDomainClusters(options = {}) {
    const minCount = Number.isFinite(options.minCount)
      ? options.minCount
      : RSI_CONSTANTS.EVOLVE_CLUSTER_MIN_COUNT;
    const minConfidence = Number.isFinite(options.minConfidence)
      ? options.minConfidence
      : RSI_CONSTANTS.EVOLVE_CLUSTER_MIN_CONFIDENCE;

    const rows = this.db
      .prepare(
        `SELECT domain, COUNT(*) AS count, AVG(confidence) AS avg_confidence
         FROM instincts
         WHERE status != 'quarantined'
           AND confidence >= ?
         GROUP BY domain
         HAVING COUNT(*) >= ?
         ORDER BY count DESC, avg_confidence DESC`
      )
      .all(minConfidence, minCount);

    return rows.map(r => ({
      domain: r.domain,
      count: Number(r.count),
      avgConfidence: Number(Number(r.avg_confidence).toFixed(2)),
      badge: `🧬 ${r.count} Instincts Ready to Evolve (/evolve)`,
      command: `/evolve ${r.domain}`
    }));
  }

  /**
   * Executes `/evolve` for a clustered domain, synthesizing a valid Antigravity SKILL.md
   * with YAML frontmatter (`name`, `description`) and structured instructions.
   */
  evolveDomainToSkill(domain, options = {}) {
    if (!domain || typeof domain !== 'string') {
      throw new Error('domain is required for evolveDomainToSkill');
    }
    const minConfidence = Number.isFinite(options.minConfidence)
      ? options.minConfidence
      : RSI_CONSTANTS.EVOLVE_CLUSTER_MIN_CONFIDENCE;

    const instincts = this.db
      .prepare(
        `SELECT * FROM instincts
         WHERE domain = ?
           AND status != 'quarantined'
           AND confidence >= ?
         ORDER BY confidence DESC, helpful_count DESC`
      )
      .all(domain, minConfidence);

    const minCount = Number.isFinite(options.minCount)
      ? options.minCount
      : RSI_CONSTANTS.EVOLVE_CLUSTER_MIN_COUNT;

    if (instincts.length < minCount) {
      throw new Error(
        `Domain "${domain}" has ${instincts.length} eligible instincts; at least ${minCount} required to /evolve`
      );
    }

    const skillSlug = options.skillSlug || `${domain.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-instincts`;
    const skillPath =
      options.skillPath ||
      path.join(this.homeDir, '.gemini', 'antigravity', 'skills', skillSlug, 'SKILL.md');

    assertMutableRsiTarget(skillPath);

    const snapshotId = this._recordMutationSnapshot({
      instinctId: instincts[0].id,
      domain,
      targetPath: skillPath
    });

    const yamlFrontmatter = [
      '---',
      `name: ${skillSlug}`,
      `description: Evolved Atomic Instincts for the ${domain} domain (${instincts.length} verified rules synthesized by Attention Horizon RSI Engine).`,
      '---'
    ].join('\n');

    const bodyLines = [
      yamlFrontmatter,
      '',
      `# ${skillSlug} — Evolved Domain Skill (\`${domain}\`)`,
      '',
      'This skill was automatically synthesized from high-confidence Atomic Instincts verified across recent coding sessions.',
      '',
      '## Mandatory Domain Directives',
      '',
      ...instincts.map(
        (inst, idx) =>
          `${idx + 1}. **${inst.directive_action}**\n   - *Trigger*: ${inst.trigger_condition}\n   - *Confidence*: \`${Number(inst.confidence).toFixed(2)}\` (\`helpful=${inst.helpful_count}\`, \`harmful=${inst.harmful_count}\`)`
      ),
      ''
    ];

    const skillContent = bodyLines.join('\n');

    const resolvedSession = options.session || {
      cacheState: options.cacheState,
      cacheWarm: options.cacheWarm,
      cachedTokens: options.cachedTokens,
      cacheTtlSeconds: options.cacheTtlSeconds,
      forceColdBust: options.forceColdBust,
      postCompact: options.postCompact
    };

    const shieldResult = this.prefixShield.stageOrApplyDelta(
      {
        targetPath: skillPath,
        operation: 'REPLACE',
        newContent: skillContent,
        source: 'rsi-evolve',
        metadata: {
          domain,
          skillSlug,
          instinctIds: instincts.map(i => i.id),
          snapshotId
        }
      },
      resolvedSession
    );

    return {
      domain,
      skillSlug,
      skillPath,
      instinctCount: instincts.length,
      snapshotId,
      skillContent,
      staged: Boolean(shieldResult.staged),
      deferred: Boolean(shieldResult.deferred),
      shieldResult
    };
  }

  _recordMutationSnapshot({ instinctId = null, domain = null, targetPath }) {
    const resolved = path.resolve(targetPath);
    const existedBefore = fs.existsSync(resolved) ? 1 : 0;
    const previousContent = existedBefore ? fs.readFileSync(resolved, 'utf8') : null;
    const gitCommitSha = tryGetGitHeadSha(this.workspaceDir);
    const baselinePassRate = this._computeRollingPassRate();
    const mutationId = `mut-${crypto.randomBytes(6).toString('hex')}`;

    this.db
      .prepare(
        `INSERT INTO mutation_snapshots (
          mutation_id, instinct_id, domain, target_path,
          existed_before, previous_content, git_commit_sha,
          baseline_pass_rate, created_at_ms, rolled_back
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        mutationId,
        instinctId,
        domain,
        resolved,
        existedBefore,
        previousContent,
        gitCommitSha,
        baselinePassRate,
        this.nowFn()
      );

    return mutationId;
  }

  _computeRollingPassRate() {
    if (this._rollingTestHistory.length === 0) return 1.0;
    const recent = this._rollingTestHistory.slice(-5);
    const sum = recent.reduce((acc, item) => acc + Number(item.passRate ?? (item.passed ? 1.0 : 0.0)), 0);
    return sum / recent.length;
  }

  /**
   * Records a turn's test suite execution result into the rolling 5-turn window.
   * Automatically triggers the Git Rollback Tripwire if the rolling 5-turn test
   * pass rate drops by > 15% within 24 hours of a rule/skill mutation.
   */
  recordTestTurnResult(testResult = {}) {
    const passRate = Number.isFinite(testResult.passRate)
      ? Number(testResult.passRate)
      : testResult.passed === false
      ? 0.0
      : 1.0;

    this._rollingTestHistory.push({
      passRate,
      timestampMs: this.nowFn()
    });
    if (this._rollingTestHistory.length > 5) {
      this._rollingTestHistory.shift();
    }

    const currentRollingRate = this._computeRollingPassRate();
    const activeSnapshots = this.db
      .prepare(
        `SELECT * FROM mutation_snapshots
         WHERE rolled_back = 0
           AND created_at_ms >= ?
         ORDER BY created_at_ms DESC`
      )
      .all(this.nowFn() - RSI_CONSTANTS.TRIPWIRE_WINDOW_MS);

    for (const snap of activeSnapshots) {
      const drop = Number(snap.baseline_pass_rate) - currentRollingRate;
      if (drop > RSI_CONSTANTS.TRIPWIRE_PASS_RATE_DROP_THRESHOLD) {
        return this.evaluateRollbackTripwire({
          mutationId: snap.mutation_id,
          instinctId: snap.instinct_id,
          domain: snap.domain,
          reason: `Rolling 5-turn test pass rate dropped by ${(drop * 100).toFixed(1)}% (baseline ${(snap.baseline_pass_rate * 100).toFixed(1)}% -> ${(currentRollingRate * 100).toFixed(1)}%)`
        });
      }
    }

    return {
      rolledBack: false,
      rollingPassRate: currentRollingRate
    };
  }

  /**
   * Executes the Git Rollback Tripwire:
   *  - Reverts the mutated GEMINI.md / SKILL.md delta on disk (via git checkout or snapshot restore)
   *  - Purges any staged PrefixCacheShield deltas for the offending instinct/file
   *  - Quarantines the offending instinct in instincts.db
   */
  evaluateRollbackTripwire(trigger = {}) {
    const cutoffMs = this.nowFn() - RSI_CONSTANTS.TRIPWIRE_WINDOW_MS;
    let snapshots = [];

    if (trigger.mutationId) {
      const snap = this.db
        .prepare(`SELECT * FROM mutation_snapshots WHERE mutation_id = ? AND rolled_back = 0`)
        .get(trigger.mutationId);
      if (snap) snapshots = [snap];
    } else if (trigger.instinctId) {
      snapshots = this.db
        .prepare(
          `SELECT * FROM mutation_snapshots
           WHERE instinct_id = ? AND rolled_back = 0 AND created_at_ms >= ?
           ORDER BY created_at_ms DESC`
        )
        .all(trigger.instinctId, cutoffMs);
    } else {
      snapshots = this.db
        .prepare(
          `SELECT * FROM mutation_snapshots
           WHERE rolled_back = 0 AND created_at_ms >= ?
           ORDER BY created_at_ms DESC`
        )
        .all(cutoffMs);
    }

    const revertedFiles = [];
    const quarantinedInstinctIds = new Set();

    for (const snap of snapshots) {
      const targetPath = snap.target_path;
      let restoredViaGit = false;

      if (snap.git_commit_sha && fs.existsSync(this.workspaceDir)) {
        try {
          const relPath = path.relative(this.workspaceDir, targetPath);
          if (!relPath.startsWith('..') && !path.isAbsolute(relPath)) {
            execFileSync('git', ['checkout', snap.git_commit_sha, '--', relPath], {
              cwd: this.workspaceDir,
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: 3000
            });
            restoredViaGit = true;
          }
        } catch {
          restoredViaGit = false;
        }
      }

      // Ensure exact pre-mutation working-tree state is restored even if working tree had uncommitted baseline edits
      if (Number(snap.existed_before) === 1 && snap.previous_content !== null) {
        atomicWriteFileSync(targetPath, snap.previous_content, { encoding: 'utf8' });
      } else if (Number(snap.existed_before) === 0 && fs.existsSync(targetPath)) {
        try {
          fs.unlinkSync(targetPath);
        } catch {}
      }

      this.db
        .prepare(
          `UPDATE mutation_snapshots
           SET rolled_back = 1, rollback_reason = ?
           WHERE mutation_id = ?`
        )
        .run(trigger.reason || 'TRIPWIRE_REGRESSION', snap.mutation_id);

      revertedFiles.push({
        targetPath,
        mutationId: snap.mutation_id,
        gitCommitSha: snap.git_commit_sha,
        restoredViaGit
      });

      if (snap.instinct_id) {
        quarantinedInstinctIds.add(snap.instinct_id);
      }
    }

    if (trigger.instinctId) {
      quarantinedInstinctIds.add(trigger.instinctId);
    }

    for (const instId of quarantinedInstinctIds) {
      this.db
        .prepare(`UPDATE instincts SET status = 'quarantined' WHERE id = ?`)
        .run(instId);
    }

    return {
      rolledBack: revertedFiles.length > 0 || quarantinedInstinctIds.size > 0,
      reason: trigger.reason || 'TRIPWIRE_REGRESSION',
      revertedFiles,
      quarantinedInstincts: Array.from(quarantinedInstinctIds)
    };
  }
}

export default RsiInstinctEngine;
