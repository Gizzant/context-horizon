/**
 * Tamper-Evident Zero-Plaintext Airlock Audit Ledger (SQLite + JSONL fallback).
 *
 * Design guarantees:
 * - Zero plaintext secret storage: asserts zero Stage 1 secret patterns and forbids raw secret fields.
 * - Append-only SHA-256 hash chain (`prevHash` -> `entryHash`) verifiable offline.
 * - Crash-safe Pre/Post in-flight tracker: expired incomplete tool calls convert into
 *   `coverageLapse: true` audit entries so fail-open crashes never go unreported.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDatabaseSyncClass } from '../../engine-node/db/probe.mjs';
import { scanTextWithAirlock } from '../../core-isomorphic/airlock/detector.mjs';
import { resolveAirlockStateDir } from './policyLoader.mjs';

const FORBIDDEN_PLAINTEXT_KEYS = new Set([
  'rawvalue',
  'plaintext',
  'secret',
  'rawtext',
  'stdout',
  'stderr',
  'toolinput',
  'tooloutput',
  'rawcontent',
  'secretpreview',
  'value'
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function hasForbiddenPlaintextField(obj, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = hasForbiddenPlaintextField(obj[i], depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (FORBIDDEN_PLAINTEXT_KEYS.has(lk) && v !== undefined && v !== null && String(v).trim() !== '') {
      return k;
    }
    if (v && typeof v === 'object') {
      const hit = hasForbiddenPlaintextField(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function assertZeroPlaintextRecord(record = {}) {
  const badKey = hasForbiddenPlaintextField(record);
  if (badKey) {
    throw new Error(`AIRLOCK_LEDGER_PLAINTEXT_VIOLATION: forbidden field '${badKey}'`);
  }
  const serialized = JSON.stringify(record);
  const scan = scanTextWithAirlock(serialized, {
    strictSsn: false,
    enableStage3Redaction: false
  });
  if (scan.matches.length > 0) {
    throw new Error(
      `AIRLOCK_LEDGER_PLAINTEXT_VIOLATION: serialized audit record matched detector [${scan.matches.map((m) => m.category).join(', ')}]`
    );
  }
}

function canonicalEventBody(entry) {
  return JSON.stringify({
    seq: Number(entry.seq),
    eventId: String(entry.eventId || ''),
    ts: String(entry.ts || ''),
    sessionId: String(entry.sessionId || ''),
    host: String(entry.host || ''),
    hookPhase: String(entry.hookPhase || ''),
    toolName: String(entry.toolName || ''),
    decision: String(entry.decision || ''),
    fmCode: entry.fmCode ? String(entry.fmCode) : '',
    categories: Array.isArray(entry.categories) ? [...entry.categories] : [],
    entityHmacs: Array.isArray(entry.entityHmacs) ? [...entry.entityHmacs] : [],
    matchCount: Number(entry.matchCount || 0),
    auditOnlyCount: Number(entry.auditOnlyCount || 0),
    coverageLapse: Boolean(entry.coverageLapse),
    schemaDrift: Boolean(entry.schemaDrift),
    hostVersion: entry.hostVersion ? String(entry.hostVersion) : '',
    latencyMs: Number(entry.latencyMs || 0)
  });
}

export class AirlockAuditLedger {
  constructor(options = {}) {
    this.stateDir = resolveAirlockStateDir(options);
    ensureDir(this.stateDir);
    this.dbPath = options.dbPath || path.join(this.stateDir, 'airlock_ledger.sqlite');
    this.jsonlPath = options.jsonlPath || path.join(this.stateDir, 'airlock_ledger.jsonl');
    this.inflightPath = options.inflightPath || path.join(this.stateDir, 'airlock_inflight.json');
    this.heartbeatPath = options.heartbeatPath || path.join(this.stateDir, 'airlock_heartbeat.json');
    this.forceFallback = Boolean(options.forceFallback);
    this.db = null;
    this.backend = 'jsonl';
    this._initStorage();
  }

  _initStorage() {
    if (!this.forceFallback) {
      const DatabaseSync = getDatabaseSyncClass({ forceFallback: this.forceFallback });
      if (DatabaseSync) {
        try {
          this.db = new DatabaseSync(this.dbPath);
          this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS airlock_events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id TEXT NOT NULL UNIQUE,
              ts TEXT NOT NULL,
              session_id TEXT NOT NULL,
              host TEXT NOT NULL,
              hook_phase TEXT NOT NULL,
              tool_name TEXT NOT NULL,
              decision TEXT NOT NULL,
              fm_code TEXT NOT NULL DEFAULT '',
              categories_json TEXT NOT NULL DEFAULT '[]',
              entity_hmacs_json TEXT NOT NULL DEFAULT '[]',
              match_count INTEGER NOT NULL DEFAULT 0,
              audit_only_count INTEGER NOT NULL DEFAULT 0,
              coverage_lapse INTEGER NOT NULL DEFAULT 0,
              schema_drift INTEGER NOT NULL DEFAULT 0,
              host_version TEXT NOT NULL DEFAULT '',
              latency_ms REAL NOT NULL DEFAULT 0,
              prev_hash TEXT NOT NULL,
              entry_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS airlock_inflight (
              tool_use_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              host TEXT NOT NULL,
              tool_name TEXT NOT NULL,
              started_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS airlock_heartbeats (
              session_id TEXT PRIMARY KEY,
              host TEXT NOT NULL,
              host_version TEXT NOT NULL DEFAULT '',
              mode TEXT NOT NULL DEFAULT 'enforce',
              policy_signed INTEGER NOT NULL DEFAULT 0,
              policy_signature_valid INTEGER NOT NULL DEFAULT 0,
              schema_tested INTEGER NOT NULL DEFAULT 1,
              schema_drift INTEGER NOT NULL DEFAULT 0,
              watchdog_ms INTEGER NOT NULL DEFAULT 3500,
              last_heartbeat_at TEXT NOT NULL
            );
          `);
          this.backend = 'sqlite';
          return;
        } catch {
          this.db = null;
        }
      }
    }
    this.backend = 'jsonl';
    if (!fs.existsSync(this.jsonlPath)) {
      fs.writeFileSync(this.jsonlPath, '', { encoding: 'utf8', mode: 0o600 });
    }
  }

  close() {
    if (this.db && typeof this.db.close === 'function') {
      try {
        if (typeof this.db.exec === 'function') {
          this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        }
      } catch {
        // ignore checkpoint failure
      }
      try {
        this.db.close();
      } catch {
        // ignore close errors
      }
      this.db = null;
    }
  }

  _readJsonlEntries() {
    if (!fs.existsSync(this.jsonlPath)) return [];
    const raw = fs.readFileSync(this.jsonlPath, 'utf8');
    if (!raw.trim()) return [];
    const lines = raw.trim().split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      out.push(JSON.parse(lines[i]));
    }
    return out;
  }

  _getChainTail() {
    if (this.backend === 'sqlite' && this.db) {
      const row = this.db.prepare('SELECT seq, entry_hash FROM airlock_events ORDER BY seq DESC LIMIT 1').get();
      if (row) {
        return { lastSeq: Number(row.seq), prevHash: String(row.entry_hash) };
      }
      return { lastSeq: 0, prevHash: 'GENESIS' };
    }
    const entries = this._readJsonlEntries();
    if (entries.length === 0) return { lastSeq: 0, prevHash: 'GENESIS' };
    const last = entries[entries.length - 1];
    return { lastSeq: Number(last.seq) || entries.length, prevHash: String(last.entryHash || 'GENESIS') };
  }

  recordEvent(input = {}) {
    const cleanInput = {
      eventId: String(input.eventId || crypto.randomUUID()),
      ts: String(input.ts || new Date().toISOString()),
      sessionId: String(input.sessionId || 'default'),
      host: String(input.host || 'claude_code'),
      hookPhase: String(input.hookPhase || 'Unknown'),
      toolName: String(input.toolName || ''),
      decision: String(input.decision || 'allow'),
      fmCode: input.fmCode ? String(input.fmCode) : '',
      categories: Array.isArray(input.categories) ? [...new Set(input.categories.map(String))] : [],
      entityHmacs: Array.isArray(input.entityHmacs) ? [...new Set(input.entityHmacs.map(String))] : [],
      matchCount: Number(input.matchCount || 0),
      auditOnlyCount: Number(input.auditOnlyCount || 0),
      coverageLapse: Boolean(input.coverageLapse),
      schemaDrift: Boolean(input.schemaDrift),
      hostVersion: input.hostVersion ? String(input.hostVersion) : '',
      latencyMs: Number(input.latencyMs || 0)
    };

    assertZeroPlaintextRecord(cleanInput);

    const { lastSeq, prevHash } = this._getChainTail();
    const seq = lastSeq + 1;
    const entryWithoutHash = { ...cleanInput, seq, prevHash };
    const entryHash = sha256Hex(`${prevHash}|${canonicalEventBody(entryWithoutHash)}`);
    const fullEntry = { ...entryWithoutHash, entryHash };

    if (this.backend === 'sqlite' && this.db) {
      this.db.prepare(`
        INSERT INTO airlock_events (
          seq, event_id, ts, session_id, host, hook_phase, tool_name, decision, fm_code,
          categories_json, entity_hmacs_json, match_count, audit_only_count,
          coverage_lapse, schema_drift, host_version, latency_ms, prev_hash, entry_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fullEntry.seq,
        fullEntry.eventId,
        fullEntry.ts,
        fullEntry.sessionId,
        fullEntry.host,
        fullEntry.hookPhase,
        fullEntry.toolName,
        fullEntry.decision,
        fullEntry.fmCode,
        JSON.stringify(fullEntry.categories),
        JSON.stringify(fullEntry.entityHmacs),
        fullEntry.matchCount,
        fullEntry.auditOnlyCount,
        fullEntry.coverageLapse ? 1 : 0,
        fullEntry.schemaDrift ? 1 : 0,
        fullEntry.hostVersion,
        fullEntry.latencyMs,
        fullEntry.prevHash,
        fullEntry.entryHash
      );
      return fullEntry;
    }

    fs.appendFileSync(this.jsonlPath, `${JSON.stringify(fullEntry)}\n`, { encoding: 'utf8', mode: 0o600 });
    return fullEntry;
  }

  listEvents(filter = {}) {
    let entries;
    if (this.backend === 'sqlite' && this.db) {
      const rows = this.db.prepare('SELECT * FROM airlock_events ORDER BY seq ASC').all();
      entries = rows.map((r) => ({
        seq: Number(r.seq),
        eventId: r.event_id,
        ts: r.ts,
        sessionId: r.session_id,
        host: r.host,
        hookPhase: r.hook_phase,
        toolName: r.tool_name,
        decision: r.decision,
        fmCode: r.fm_code,
        categories: JSON.parse(r.categories_json || '[]'),
        entityHmacs: JSON.parse(r.entity_hmacs_json || '[]'),
        matchCount: Number(r.match_count || 0),
        auditOnlyCount: Number(r.audit_only_count || 0),
        coverageLapse: Boolean(r.coverage_lapse),
        schemaDrift: Boolean(r.schema_drift),
        hostVersion: r.host_version,
        latencyMs: Number(r.latency_ms || 0),
        prevHash: r.prev_hash,
        entryHash: r.entry_hash
      }));
    } else {
      entries = this._readJsonlEntries();
    }

    return entries.filter((e) => {
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
      if (filter.sinceIso && e.ts < filter.sinceIso) return false;
      return true;
    });
  }

  verifyLedgerChain() {
    const entries = this.listEvents();
    let expectedPrev = 'GENESIS';
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.prevHash !== expectedPrev) {
        return {
          valid: false,
          count: entries.length,
          brokenAtSeq: entry.seq,
          reason: `prevHash mismatch at seq ${entry.seq}`
        };
      }
      const recomputed = sha256Hex(`${expectedPrev}|${canonicalEventBody(entry)}`);
      if (recomputed !== entry.entryHash) {
        return {
          valid: false,
          count: entries.length,
          brokenAtSeq: entry.seq,
          reason: `entryHash tamper detected at seq ${entry.seq}`
        };
      }
      expectedPrev = entry.entryHash;
    }
    return { valid: true, count: entries.length, brokenAtSeq: null, reason: 'Hash chain intact' };
  }

  _readFallbackInFlight() {
    try {
      if (!fs.existsSync(this.inflightPath)) return {};
      return JSON.parse(fs.readFileSync(this.inflightPath, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  _writeFallbackInFlight(mapObj) {
    fs.writeFileSync(this.inflightPath, JSON.stringify(mapObj, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  recordPreToolInFlight({ sessionId = 'default', toolUseId, toolName = '', host = 'claude_code', startedAtMs = Date.now() }) {
    if (!toolUseId) return;
    if (this.backend === 'sqlite' && this.db) {
      this.db.prepare(`
        INSERT OR REPLACE INTO airlock_inflight (tool_use_id, session_id, host, tool_name, started_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(String(toolUseId), String(sessionId), String(host), String(toolName), Number(startedAtMs));
      return;
    }
    const mapObj = this._readFallbackInFlight();
    mapObj[String(toolUseId)] = {
      toolUseId: String(toolUseId),
      sessionId: String(sessionId),
      host: String(host),
      toolName: String(toolName),
      startedAtMs: Number(startedAtMs)
    };
    this._writeFallbackInFlight(mapObj);
  }

  completePostToolInFlight({ toolUseId }) {
    if (!toolUseId) return false;
    if (this.backend === 'sqlite' && this.db) {
      const info = this.db.prepare('DELETE FROM airlock_inflight WHERE tool_use_id = ?').run(String(toolUseId));
      return Number(info?.changes || 0) > 0;
    }
    const mapObj = this._readFallbackInFlight();
    const existed = Object.prototype.hasOwnProperty.call(mapObj, String(toolUseId));
    if (existed) {
      delete mapObj[String(toolUseId)];
      this._writeFallbackInFlight(mapObj);
    }
    return existed;
  }

  sweepExpiredInFlight(maxAgeMs = 15000, nowMs = Date.now()) {
    const cutoff = nowMs - Math.max(1000, Number(maxAgeMs) || 15000);
    const expired = [];

    if (this.backend === 'sqlite' && this.db) {
      const rows = this.db.prepare('SELECT * FROM airlock_inflight WHERE started_at_ms <= ?').all(cutoff);
      for (let i = 0; i < rows.length; i++) {
        expired.push({
          toolUseId: rows[i].tool_use_id,
          sessionId: rows[i].session_id,
          host: rows[i].host,
          toolName: rows[i].tool_name,
          startedAtMs: Number(rows[i].started_at_ms)
        });
      }
      this.db.prepare('DELETE FROM airlock_inflight WHERE started_at_ms <= ?').run(cutoff);
    } else {
      const mapObj = this._readFallbackInFlight();
      for (const [id, item] of Object.entries(mapObj)) {
        if (Number(item.startedAtMs) <= cutoff) {
          expired.push(item);
          delete mapObj[id];
        }
      }
      if (expired.length > 0) {
        this._writeFallbackInFlight(mapObj);
      }
    }

    const recorded = [];
    for (let i = 0; i < expired.length; i++) {
      const item = expired[i];
      recorded.push(
        this.recordEvent({
          sessionId: item.sessionId,
          host: item.host,
          hookPhase: 'PostToolUse',
          toolName: item.toolName,
          decision: 'coverage_lapse',
          fmCode: 'FM-8-POSTTOOL-LAPSE',
          coverageLapse: true
        })
      );
    }
    return recorded;
  }

  recordSessionHeartbeat({
    sessionId = 'default',
    host = 'claude_code',
    hostVersion = '',
    mode = 'enforce',
    policySigned = false,
    policySignatureValid = false,
    schemaTested = true,
    schemaDrift = false,
    watchdogMs = 3500,
    lastHeartbeatAt = new Date().toISOString()
  } = {}) {
    if (this.backend === 'sqlite' && this.db) {
      this.db.prepare(`
        INSERT OR REPLACE INTO airlock_heartbeats (
          session_id, host, host_version, mode, policy_signed, policy_signature_valid,
          schema_tested, schema_drift, watchdog_ms, last_heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(sessionId),
        String(host),
        String(hostVersion || ''),
        String(mode || 'enforce'),
        policySigned ? 1 : 0,
        policySignatureValid ? 1 : 0,
        schemaTested ? 1 : 0,
        schemaDrift ? 1 : 0,
        Number(watchdogMs || 3500),
        String(lastHeartbeatAt)
      );
      return;
    }

    let mapObj = {};
    try {
      if (fs.existsSync(this.heartbeatPath)) {
        mapObj = JSON.parse(fs.readFileSync(this.heartbeatPath, 'utf8')) || {};
      }
    } catch {
      mapObj = {};
    }
    mapObj[String(sessionId)] = {
      sessionId: String(sessionId),
      host: String(host),
      hostVersion: String(hostVersion || ''),
      mode: String(mode || 'enforce'),
      policySigned: Boolean(policySigned),
      policySignatureValid: Boolean(policySignatureValid),
      schemaTested: Boolean(schemaTested),
      schemaDrift: Boolean(schemaDrift),
      watchdogMs: Number(watchdogMs || 3500),
      lastHeartbeatAt: String(lastHeartbeatAt)
    };
    fs.writeFileSync(this.heartbeatPath, JSON.stringify(mapObj, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  _getLatestHeartbeat(sessionId = null) {
    if (this.backend === 'sqlite' && this.db) {
      const row = sessionId
        ? this.db.prepare('SELECT * FROM airlock_heartbeats WHERE session_id = ?').get(String(sessionId))
        : this.db.prepare('SELECT * FROM airlock_heartbeats ORDER BY last_heartbeat_at DESC LIMIT 1').get();
      if (!row) return null;
      return {
        sessionId: row.session_id,
        host: row.host,
        hostVersion: row.host_version,
        mode: row.mode,
        policySigned: Boolean(row.policy_signed),
        policySignatureValid: Boolean(row.policy_signature_valid),
        schemaTested: Boolean(row.schema_tested),
        schemaDrift: Boolean(row.schema_drift),
        watchdogMs: Number(row.watchdog_ms),
        lastHeartbeatAt: row.last_heartbeat_at
      };
    }

    try {
      if (!fs.existsSync(this.heartbeatPath)) return null;
      const mapObj = JSON.parse(fs.readFileSync(this.heartbeatPath, 'utf8')) || {};
      if (sessionId && mapObj[sessionId]) return mapObj[sessionId];
      const values = Object.values(mapObj).sort((a, b) => String(b.lastHeartbeatAt).localeCompare(String(a.lastHeartbeatAt)));
      return values[0] || null;
    } catch {
      return null;
    }
  }

  getAirlockSummary(filter = {}) {
    const events = this.listEvents(filter);
    const chain = this.verifyLedgerChain();
    const hb = this._getLatestHeartbeat(filter.sessionId || null);

    let blockedCount = 0;
    let scrubbedCount = 0;
    let auditOnlyCount = 0;
    let fm1BlockCount = 0;
    let coverageLapses = 0;
    let schemaDriftEvents = 0;
    let watchdogTimeouts = 0;

    const uniqueHmacs = new Set();
    const byCategory = {};
    const byFmCode = {};

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.decision === 'deny' || e.decision === 'block') blockedCount++;
      if (e.decision === 'scrubbed') scrubbedCount++;
      if (e.decision === 'watchdog_timeout') watchdogTimeouts++;
      auditOnlyCount += Number(e.auditOnlyCount || 0);
      if (e.fmCode === 'FM-1') fm1BlockCount++;
      if (e.coverageLapse) coverageLapses++;
      if (e.schemaDrift) schemaDriftEvents++;

      if (e.fmCode) {
        byFmCode[e.fmCode] = (byFmCode[e.fmCode] || 0) + 1;
      }
      for (let k = 0; k < e.categories.length; k++) {
        const cat = e.categories[k];
        byCategory[cat] = (byCategory[cat] || 0) + 1;
      }
      for (let k = 0; k < e.entityHmacs.length; k++) {
        uniqueHmacs.add(e.entityHmacs[k]);
      }
    }

    const lastHbMs = hb?.lastHeartbeatAt ? Date.parse(hb.lastHeartbeatAt) : 0;
    const heartbeatFresh = lastHbMs > 0 && (Date.now() - lastHbMs) < 180000;

    return {
      backend: this.backend,
      totalEvents: events.length,
      blockedCount,
      scrubbedCount,
      auditOnlyCount,
      fm1BlockCount,
      coverageLapses,
      schemaDriftEvents,
      watchdogTimeouts,
      uniqueEntitiesCount: uniqueHmacs.size,
      byCategory,
      byFmCode,
      lastHeartbeatAt: hb?.lastHeartbeatAt || null,
      heartbeatFresh,
      lastHost: hb?.host || null,
      lastHostVersion: hb?.hostVersion || null,
      mode: hb?.mode || 'enforce',
      policySigned: Boolean(hb?.policySigned),
      policySignatureValid: Boolean(hb?.policySignatureValid),
      schemaTested: hb ? Boolean(hb.schemaTested) : true,
      schemaDriftActive: Boolean(hb?.schemaDrift) || schemaDriftEvents > 0,
      watchdogMs: hb?.watchdogMs || 3500,
      chainValid: chain.valid,
      chainCount: chain.count,
      chainBrokenAtSeq: chain.brokenAtSeq
    };
  }
}
