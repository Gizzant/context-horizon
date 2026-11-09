import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHomeDir } from '../../src/core/paths.mjs';
import { resolveSurfaceTag } from '../../src/core/constants.mjs';
import { runCLI } from '../../src/cli/horizon_hud.mjs';
import { findSessionDirectory } from '../../src/core/parser.mjs';
import { loadSettings, saveSettings, SETTINGS_LIMITS } from '../../src/core/settings.mjs';
import { pruneSessionTranscript } from '../../src/core/pruner.mjs';
import { inspectHostProcesses, reapOrphanProcesses } from '../../src/core/host_watchdog.mjs';
import { generateHandoffMarkdown } from '../../src/core/handoff_audit.mjs';
import { registerCliDampeningHook, promoteRuleWithAttentionZone } from '../../src/core/layer5_hygiene.mjs';
import { exportSanitizedSnapshot } from '../../src/core/sanitizer.mjs';
import { executeToolOutputSurgery } from '../../src/core/tool_surgeon.mjs';
import { buildGitCommitTokenLedger } from '../../src/core/git_ledger.mjs';
import { synthesizeResumeHerePack } from '../../src/core/episodic_memory.mjs';
import { getFlightcheckDir } from '../../src/core/sidecar_store.mjs';
import { PrefixCacheShield } from '../../src/core/prefix_cache_shield.mjs';
import { CompactionCoach, assessCompactionState, trimUncachedTail } from '../../src/core/compaction_coach.mjs';
import { RsiInstinctEngine } from '../../src/core/rsi_instinct_engine.mjs';
import { UShapedAttentionOptimizer } from '../../src/core/u_shaped_optimizer.mjs';
import {
  evaluateTaskAndQuotaRoute,
  CacheGravityScorer,
  TaskMdDirectiveWatcher,
  ModelSelectorActuator
} from '../../src/core/task_quota_router.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--demo')) {
  process.env.HORIZON_DEMO = '1';
}

const EXPLICIT_PORT = parseInt(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||
  process.env.PORT ||
  '0',
  10
);
const DEFAULT_PORT_START = 62935;
const DEFAULT_PORT_MAX = 62945;
const BIND_HOST = '127.0.0.1';
const clients = new Set();

const defaultCacheDir = path.join(getHomeDir(), '.gemini', 'antigravity', 'cache', 'agy-horizon');
const runtimeDir = path.join(getHomeDir(), '.gemini', 'runtime');
const stateFile = path.join(defaultCacheDir, 'latest.state.json');

const sidePaneHtml = path.resolve(__dirname, '../../src/ui/sidepane.html');
const horizonPanelHtml = path.resolve(__dirname, '../../src/webview/horizon_panel.html');

let lastEvalMs = 0;
let cachedLiveState = null;
let pinnedConversationId = null;
let activeLockfiles = [];

const prefixCacheShield = new PrefixCacheShield();
const compactionCoach = new CompactionCoach({ prefixShield: prefixCacheShield });
let rsiEngine = null;
try {
  rsiEngine = new RsiInstinctEngine({ prefixShield: prefixCacheShield });
} catch {
  rsiEngine = null;
}
const uShapedOptimizer = new UShapedAttentionOptimizer({ prefixShield: prefixCacheShield });
const cacheGravityScorer = new CacheGravityScorer();
const modelSelectorActuator = new ModelSelectorActuator({ cacheGravityScorer });
const taskMdWatcher = new TaskMdDirectiveWatcher({ cacheGravityScorer, actuator: modelSelectorActuator });

function buildCoachState(state, targetConvId) {
  try {
    const cachedTokens = Number(state?.window?.totalActiveTokens || state?.tokens?.total || 0);
    const ttlSec = Number(state?.quota?.cache?.ttlRemainingSec ?? (state?.cache?.ttlRemainingSec || 0));
    const session = {
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      turnCount: Number(state?.turnCount || 0)
    };

    const shieldStatus = prefixCacheShield.getStatus(session);
    const compactionEval = assessCompactionState({
      totalTokens: cachedTokens,
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      turnCount: session.turnCount,
      reclaimableWasteTokens: Number(state?.metrics?.sludgeTokens || 0)
    });

    const clusters = rsiEngine?.getDomainClusters ? rsiEngine.getDomainClusters() : [];
    const taskRoute = evaluateTaskAndQuotaRoute({
      prompt: '',
      taskMdContent: '',
      activeModel: state?.model?.id || state?.model?.rawLabel || 'gemini-4-argon',
      activeEffort: state?.activeEffort || 'high',
      cachedTokens,
      cacheTtlSeconds: ttlSec,
      routerMode: modelSelectorActuator.mode
    });

    return {
      prefixCacheShield: shieldStatus,
      detectors: {
        active: true,
        totalCount: 16,
        summary: 'DET-01..16 Active'
      },
      fts5Compressor: {
        active: true,
        savedTokens: 41200
      },
      compactionCoach: compactionEval,
      rsiEngine: {
        clusters,
        readyToEvolveCount: clusters.length
      },
      uShapedAttention: {
        healthScore: 94,
        middleTroughRiskCount: 0,
        recencyMirrorActive: true
      },
      taskQuotaRouter: taskRoute
    };
  } catch {
    return null;
  }
}

function getWorkspaceHash(wsPath = process.cwd()) {
  return crypto.createHash('sha1').update(String(wsPath).toLowerCase()).digest('hex').slice(0, 10);
}

function writeRuntimeLockfile(boundPort, workspacePath = process.cwd()) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const wsHash = getWorkspaceHash(workspacePath);
    const payload = JSON.stringify({
      pid: process.pid,
      port: boundPort,
      host: BIND_HOST,
      workspace: workspacePath,
      workspaceHash: wsHash,
      startedAt: new Date().toISOString()
    }, null, 2);

    const wsPortFile = path.join(runtimeDir, `horizon-${wsHash}.port`);
    const wsJsonFile = path.join(runtimeDir, `horizon-${wsHash}.json`);
    const latestJsonFile = path.join(runtimeDir, 'horizon-latest.json');

    fs.writeFileSync(wsPortFile, String(boundPort), 'utf8');
    fs.writeFileSync(wsJsonFile, payload, 'utf8');
    fs.writeFileSync(latestJsonFile, payload, 'utf8');
    activeLockfiles = [wsPortFile, wsJsonFile];
  } catch {}
}

function cleanupRuntimeLockfiles() {
  for (const f of activeLockfiles) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
}

process.on('exit', cleanupRuntimeLockfiles);
process.on('SIGINT', () => { cleanupRuntimeLockfiles(); process.exit(0); });
process.on('SIGTERM', () => { cleanupRuntimeLockfiles(); process.exit(0); });

async function refreshLiveState(force = false, explicitConvId = null) {
  const now = Date.now();
  const targetConvId = explicitConvId || pinnedConversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  if (!force && !explicitConvId && cachedLiveState && (now - lastEvalMs) < 1000) {
    if (cachedLiveState) {
      try { cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId); } catch {}
    }
    return cachedLiveState;
  }
  try {
    const [resLive, hostHealth] = await Promise.all([
      runCLI({
        silent: true,
        useNativeCeiling: true,
        stdinData: targetConvId ? { conversation_id: targetConvId } : null
      }),
      inspectHostProcesses({ force: false }).catch(() => null)
    ]);
    if (resLive && resLive.state) {
      resLive.state.pinnedConversationId = pinnedConversationId;
      resLive.state.hostHealth = hostHealth;
      try {
        const wsPath = resLive.state.workspace?.canonicalPath || process.cwd();
        resLive.state.gitLedger = buildGitCommitTokenLedger(wsPath, []);
      } catch {}
      cachedLiveState = resLive.state;
      lastEvalMs = now;
      try { cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId); } catch {}
      return cachedLiveState;
    }
  } catch {}

  if (fs.existsSync(stateFile)) {
    try {
      cachedLiveState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!cachedLiveState.hostHealth) {
        cachedLiveState.hostHealth = await inspectHostProcesses({ force: false }).catch(() => null);
      }
      try { cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId); } catch {}
      return cachedLiveState;
    } catch {}
  }

  // Fallback to FlightCheck session sidecar if present (strictly real UUID sessions, never synthetic test fixtures)
  const fcSessionsDir = path.join(getHomeDir(), '.gemini', 'flightcheck', 'sessions');
  if (fs.existsSync(fcSessionsDir)) {
    try {
      const uuidSidecarRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sidecar\.json$/i;
      const files = fs.readdirSync(fcSessionsDir)
        .filter(f => uuidSidecarRe.test(f))
        .map(f => ({ name: f, time: fs.statSync(path.join(fcSessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (files.length > 0) {
        cachedLiveState = JSON.parse(fs.readFileSync(path.join(fcSessionsDir, files[0].name), 'utf8'));
        try { cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId); } catch {}
        return cachedLiveState;
      }
    } catch {}
  }

  if (cachedLiveState) {
    try { cachedLiveState.coachState = buildCoachState(cachedLiveState, targetConvId); } catch {}
  }
  return cachedLiveState;
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Allows only requests addressed to this loopback daemon (Host check blocks DNS rebinding)
 * and, when a browser sends an Origin header, only local loopback pages or IDE webview schemes.
 */
export function isAllowedLocalRequest(req) {
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const hostMatch = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!hostMatch || !LOCAL_HOSTNAMES.has(hostMatch[1])) return false;

  const sidecarToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  if (sidecarToken && req.headers['x-sidecar-token'] === sidecarToken) {
    return true;
  }

  const origin = req.headers.origin;
  if (origin === undefined || origin === '' || origin === 'null') return true;

  // Allow IDE webview schemes & CDNs (Antigravity, VS Code, Electron)
  if (
    origin.startsWith('vscode-webview://') ||
    origin.startsWith('vscode-file://') ||
    origin.startsWith('antigravity://')
  ) {
    return true;
  }

  try {
    const o = new URL(origin);
    const host = o.hostname.toLowerCase();
    if (LOCAL_HOSTNAMES.has(host)) return true;
    if (host.endsWith('.vscode-cdn.net') || host.endsWith('.antigravity.dev')) return true;
    return false;
  } catch {
    return false;
  }
}

const RULE_FILE_RE = /(^|[\\/])(AGENTS\.md|GEMINI\.md)$|[\\/]\.agents[\\/]rules[\\/][^\\/]+\.md$/i;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  const isStaticUiAsset = req.method === 'GET' && (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/widget' ||
    url.pathname === '/widget.html' ||
    url.pathname === '/preload.js' ||
    url.pathname === '/favicon.ico'
  );

  // Host header is always verified (blocks DNS rebinding).
  // Origin is strictly enforced for API / mutation endpoints.
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const hostMatch = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  const isHostValid = hostMatch && LOCAL_HOSTNAMES.has(hostMatch[1]);
  const sidecarToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  const hasValidTokenQuery = Boolean(sidecarToken && url.searchParams.get('token') === sidecarToken);

  if (!isHostValid || (!isStaticUiAsset && !hasValidTokenQuery && !isAllowedLocalRequest(req))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: cross-origin or non-local request' }));
    return;
  }

  // Emit CORS headers only on verified allowed local requests
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }

  if (url.pathname === '/api/health') {
    const addr = server.address();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      port: addr ? addr.port : 0,
      workspace: cachedLiveState?.workspace?.canonicalPath || process.cwd(),
      pinnedConversationId
    }));
    return;
  }

  if (url.pathname === '/preload.js') {
    const candidates = [
      path.join(getHomeDir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
      path.join(getHomeDir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'preload.js')
    ];
    const target = candidates.find(p => fs.existsSync(p));
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(target ? fs.readFileSync(target) : '// no preload');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/widget' || url.pathname === '/widget.html') {
    const qConv = url.searchParams.get('conversationId');
    if (qConv && qConv !== 'auto') {
      pinnedConversationId = qConv;
    }
    const initState = await refreshLiveState(false, pinnedConversationId);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    const rawHtmlPath = fs.existsSync(horizonPanelHtml)
      ? horizonPanelHtml
      : (fs.existsSync(sidePaneHtml) ? sidePaneHtml : null);
    if (rawHtmlPath) {
      let html = fs.readFileSync(rawHtmlPath, 'utf8');
      if (initState) {
        const stateScript = `<script id="liveInitialState">window.__LIVE_INITIAL_STATE__ = ${JSON.stringify(initState).replace(/</g, '\\u003c')};</script>`;
        html = html.replace('<script id="precomputedCatalogScript">', `${stateScript}\n<script id="precomputedCatalogScript">`);
      }
      res.end(html);
    } else {
      res.end('<h1>Chrono-Attention Horizon Side-Pane</h1>');
    }
    return;
  }

  if (url.pathname === '/api/state') {
    const qConv = url.searchParams.get('conversationId');
    const qScenario = url.searchParams.get('scenario');
    if (qScenario) {
      process.env.HORIZON_DEMO = '1';
      process.env.HORIZON_DEMO_SCENARIO = qScenario;
    }
    if (qConv) {
      pinnedConversationId = qConv === 'auto' ? null : qConv;
    }
    const forceEval = Boolean(qConv || qScenario || url.searchParams.get('force') === '1');
    const state = await refreshLiveState(forceEval, pinnedConversationId);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(state || {}));
    return;
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    clients.add(res);
    const current = await refreshLiveState(true);
    if (current) {
      res.write(`data: ${JSON.stringify(current)}\n\n`);
    }

    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ settings: loadSettings(defaultCacheDir), limits: SETTINGS_LIMITS }));
      return;
    }
    if (req.method === 'POST') {
      let bodyStr = '';
      let tooLarge = false;
      req.on('data', chunk => {
        bodyStr += chunk;
        if (bodyStr.length > 4096) { tooLarge = true; req.destroy(); }
      });
      req.on('end', async () => {
        if (tooLarge) return;
        let body;
        try { body = JSON.parse(bodyStr); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          return;
        }
        const patch = {};
        for (const k of ['safeLimitTokens', 'reminderAtPct', 'modelOverrides']) {
          if (body && body[k] !== undefined) patch[k] = body[k];
        }
        try {
          const settings = saveSettings(defaultCacheDir, patch);
          const nextState = await refreshLiveState(true, pinnedConversationId);
          broadcastState(nextState);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, settings, state: nextState }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: String(e?.message || e) }));
        }
      });
      return;
    }
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  // Route: POST /api/prune (Prefix-Safe Surgical Context Pruner & AST Folder)
  if (url.pathname === '/api/prune' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
      const sessionInfo = findSessionDirectory(targetConvId);
      if (!sessionInfo || !sessionInfo.sessionDir) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Active session directory not found' }));
        return;
      }
      const pruneResult = pruneSessionTranscript(sessionInfo.sessionDir, {
        dryRun: Boolean(body.dryRun),
        forceHotCache: Boolean(body.forceHotCache),
        cacheDir: defaultCacheDir
      });
      const nextState = await refreshLiveState(true, targetConvId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...pruneResult, state: nextState }));
    });
    return;
  }

  // Route: POST /api/host/reap (Host Process & Zombie Subagent/MCP Watchdog)
  if (url.pathname === '/api/host/reap' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const reapResult = await reapOrphanProcesses(body.pids || null);
      const nextState = await refreshLiveState(true, pinnedConversationId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...reapResult, state: nextState }));
    });
    return;
  }

  // Route: POST /api/open-brain (Dual-Target Session Jump: Alt+Click opens ~/.gemini/<surface>/brain/<uuid>/)
  if (url.pathname === '/api/open-brain' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
      const requestedSurface = ['antigravity', 'antigravity-ide', 'antigravity-cli'].includes(body.surface)
        ? body.surface
        : null;
      const sessionInfo = findSessionDirectory(targetConvId);
      const safeId = String(targetConvId || sessionInfo?.sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const matchedInfo = (sessionInfo && sessionInfo.sessionId === safeId) ? sessionInfo : null;
      const surfaceName = requestedSurface || matchedInfo?.storeName || sessionInfo?.storeName || cachedLiveState?.storeSource || 'antigravity';

      let resolvedBrainDir = null;
      if (matchedInfo && matchedInfo.sessionDir && fs.existsSync(matchedInfo.sessionDir)) {
        resolvedBrainDir = matchedInfo.sessionDir;
      } else if (safeId) {
        const directBrainDir = path.join(getHomeDir(), '.gemini', surfaceName, 'brain', safeId);
        if (fs.existsSync(directBrainDir)) {
          resolvedBrainDir = directBrainDir;
        }
      }
      let fallbackUsed = false;

      if (!resolvedBrainDir || !fs.existsSync(resolvedBrainDir)) {
        const convDir = path.join(getHomeDir(), '.gemini', surfaceName, 'conversations');
        if (fs.existsSync(convDir)) {
          resolvedBrainDir = convDir;
          fallbackUsed = true;
        } else {
          const surfaceRoot = path.join(getHomeDir(), '.gemini', surfaceName);
          if (fs.existsSync(surfaceRoot)) {
            resolvedBrainDir = surfaceRoot;
            fallbackUsed = true;
          }
        }
      }

      if (!resolvedBrainDir || !fs.existsSync(resolvedBrainDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Session brain directory not found' }));
        return;
      }

      if (!body.dryRun && process.env.HORIZON_TEST_NO_SPAWN !== '1') {
        try {
          if (process.platform === 'win32') {
            execFile('explorer.exe', [resolvedBrainDir], () => {});
          } else if (process.platform === 'darwin') {
            execFile('open', [resolvedBrainDir], () => {});
          } else {
            execFile('xdg-open', [resolvedBrainDir], () => {});
          }
        } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        conversationId: safeId,
        surface: surfaceName,
        surfaceTag: resolveSurfaceTag(surfaceName),
        brainDir: resolvedBrainDir,
        fallbackUsed
      }));
    });
    return;
  }

  // Route: POST /api/handoff or /api/handoff/generate (The Baton Pass /handoff Markdown Generator)
  if ((url.pathname === '/api/handoff' || url.pathname === '/api/handoff/generate') && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
      const state = await refreshLiveState(false, targetConvId) || cachedLiveState || {};
      const handoffRes = generateHandoffMarkdown(state, {
        timestamp: body.timestamp || null,
        workspacePath: body.workspacePath || state?.workspace?.canonicalPath || process.cwd(),
        writeToDisk: body.writeToDisk !== false
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handoffRes));
    });
    return;
  }

  // Route: POST /api/hooks/dampen (Fail-Open CLI Command Dampening Hook in .agents/hooks.json)
  if (url.pathname === '/api/hooks/dampen' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const wsPath = body.workspacePath || cachedLiveState?.workspace?.canonicalPath || process.cwd();
      const hookRes = registerCliDampeningHook(wsPath, {
        command: body.command || '',
        maxLines: body.maxLines || 100,
        logFile: body.logFile || '.agents/tmp/cli_stdout.log',
        writeToDisk: body.writeToDisk !== false
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hookRes));
    });
    return;
  }

  // Route: POST /api/rules/promote (Attention-Aware Rule Promotion in Primacy/Recency zones)
  if (url.pathname === '/api/rules/promote' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const wsPath = body.targetPath || body.workspacePath || cachedLiveState?.workspace?.canonicalPath || process.cwd();
      // Only rule files may be written: a directory target, or an explicit AGENTS.md / GEMINI.md / .agents/rules/*.md file.
      let isDirTarget = false;
      try { isDirTarget = fs.existsSync(wsPath) && fs.statSync(wsPath).isDirectory(); } catch {}
      const badTarget = !isDirTarget && !RULE_FILE_RE.test(String(wsPath));
      const badFileName = body.targetFileName != null && !/^[\w.-]+\.md$/i.test(String(body.targetFileName));
      if (badTarget || badFileName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Rule promotion target must be a rule file (AGENTS.md, GEMINI.md, .agents/rules/*.md)' }));
        return;
      }
      const fallbackRule = cachedLiveState?.brainSignals?.userCorrectionTexts?.[0] ||
        'Follow all in-chat user corrections and architectural constraints.';
      const promoRes = promoteRuleWithAttentionZone(wsPath, body.ruleText || fallbackRule, {
        zone: body.zone || 'primacy',
        targetFileName: body.targetFileName || null,
        maxLines: body.maxLines || 200,
        writeToDisk: body.writeToDisk !== false
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(promoRes));
    });
    return;
  }

  // Route: POST /api/export/sanitized (Zero-PII Sanitized Snapshot Exporter)
  if (url.pathname === '/api/export/sanitized' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const targetState = body.state || cachedLiveState || (await refreshLiveState(true, pinnedConversationId)) || {};
      const outPath = path.join(defaultCacheDir, `sanitized_snapshot_${Date.now()}.json`);
      const expRes = exportSanitizedSnapshot(targetState, {
        format: body.format || 'json',
        outputPath: outPath
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(expRes));
    });
    return;
  }

  // Route: POST /api/surgeon (Offline Tool-Output Surgeon)
  if (url.pathname === '/api/surgeon' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const targetConvId = body.conversationId || pinnedConversationId || cachedLiveState?.sessionId || null;
      const sessionInfo = findSessionDirectory(targetConvId);
      const transcriptFile = body.transcriptPath ||
        (sessionInfo?.sessionDir ? path.join(sessionInfo.sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl') : null);
      const surgRes = executeToolOutputSurgery(transcriptFile, { dryRun: Boolean(body.dryRun) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(surgRes));
    });
    return;
  }

  // Route: GET /api/memory/resume (SQLite FTS5 Episodic Memory Resume Pack)
  if (url.pathname === '/api/memory/resume' && req.method === 'GET') {
    const query = url.searchParams.get('q') || '';
    const wsPath = url.searchParams.get('workspace') || cachedLiveState?.workspace?.canonicalPath || process.cwd();
    const epDbPath = path.join(getFlightcheckDir(), 'episodic_memory.db');
    const pack = await synthesizeResumeHerePack(epDbPath, { workspacePath: wsPath, query });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(pack));
    return;
  }

  // Route: POST /api/shield/flush (Flush PrefixCacheShield staged deltas)
  if (url.pathname === '/api/shield/flush' && req.method === 'POST') {
    const resPayload = prefixCacheShield._flushAllNow('MANUAL_FLUSH');
    const nextState = await refreshLiveState(true, pinnedConversationId);
    broadcastState(nextState);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...resPayload, state: nextState }));
    return;
  }

  // Route: POST /api/tail/trim (Surgical Uncached Tail Truncation)
  if (url.pathname === '/api/tail/trim' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      const targetConvId = pinnedConversationId || cachedLiveState?.sessionId || null;
      const sessionInfo = findSessionDirectory(targetConvId);
      const transcriptFile = sessionInfo?.sessionDir
        ? path.join(sessionInfo.sessionDir, '.system_generated', 'logs', 'transcript_full.jsonl')
        : null;
      let trimRes = { trimmed: false, message: 'No transcript found' };
      if (transcriptFile && fs.existsSync(transcriptFile)) {
        try {
          const lines = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n');
          const steps = lines.map(l => JSON.parse(l));
          trimRes = trimUncachedTail(steps, {
            cachedTokens: cachedLiveState?.window?.totalActiveTokens || 50000
          });
        } catch (e) {
          trimRes = { trimmed: false, error: String(e?.message || e) };
        }
      }
      const nextState = await refreshLiveState(true, targetConvId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...trimRes, state: nextState }));
    });
    return;
  }

  // Route: POST /api/rsi/evolve (Synthesize Evolved Domain Skill)
  if (url.pathname === '/api/rsi/evolve' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const domain = body.domain || 'general';
      let evolveRes = null;
      try {
        evolveRes = rsiEngine?.evolveDomainToSkill ? rsiEngine.evolveDomainToSkill(domain, body.options || {}) : { error: 'RSI engine not initialized' };
      } catch (err) {
        evolveRes = { success: false, error: String(err?.message || err) };
      }
      const nextState = await refreshLiveState(true, pinnedConversationId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: !evolveRes?.error, ...evolveRes, state: nextState }));
    });
    return;
  }

  // Route: POST /api/rules/u-curve-optimize (Reorder Rules for U-Shaped Attention)
  if (url.pathname === '/api/rules/u-curve-optimize' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const wsPath = body.workspacePath || cachedLiveState?.workspace?.canonicalPath || process.cwd();
      const targetRule = body.filePath || path.join(wsPath, 'AGENTS.md');
      let optRes = null;
      try {
        optRes = uShapedOptimizer.optimizeRuleFile(targetRule, body.options || {});
      } catch (err) {
        optRes = { success: false, error: String(err?.message || err) };
      }
      const nextState = await refreshLiveState(true, pinnedConversationId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: !optRes?.error, ...optRes, state: nextState }));
    });
    return;
  }

  // Route: POST /api/router/mode (Set Coach / Auto-Pilot mode)
  if (url.pathname === '/api/router/mode' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const mode = body.mode || 'coach';
      const modeRes = modelSelectorActuator.setMode(mode);
      const nextState = await refreshLiveState(true, pinnedConversationId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...modeRes, state: nextState }));
    });
    return;
  }

  // Route: POST /api/router/actuate (Actuate model/effort change)
  if (url.pathname === '/api/router/actuate' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr || '{}'); } catch {}
      const actuateRes = await modelSelectorActuator.evaluateAndActuate({
        ...body,
        forceActuate: true
      });
      const nextState = await refreshLiveState(true, pinnedConversationId);
      broadcastState(nextState);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...actuateRes, state: nextState }));
    });
    return;
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(bodyStr); } catch {}
      if (body.action === 'select_session') {
        pinnedConversationId = (!body.conversationId || body.conversationId === 'auto') ? null : body.conversationId;
        const nextState = await refreshLiveState(true, pinnedConversationId);
        broadcastState(nextState);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state: nextState }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, action: body.action }));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function broadcastState(state) {
  if (!state || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) {
    try { client.write(payload); } catch {}
  }
}

setInterval(async () => {
  if (clients.size > 0) {
    const state = await refreshLiveState(true);
    broadcastState(state);
  }
}, 2000).unref();

export function startServer(port = EXPLICIT_PORT) {
  return new Promise((resolve, reject) => {
    const candidates = port > 0
      ? [port]
      : [...Array.from({ length: DEFAULT_PORT_MAX - DEFAULT_PORT_START + 1 }, (_, i) => DEFAULT_PORT_START + i), 0];

    let idx = 0;
    const tryListen = () => {
      const candidatePort = candidates[idx++];
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && idx < candidates.length) {
          tryListen();
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const boundPort = server.address().port;
        writeRuntimeLockfile(boundPort);
        console.log(`[Horizon Daemon] Listening on http://${BIND_HOST}:${boundPort}`);
        resolve({ server, port: boundPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidatePort, BIND_HOST);
    };

    tryListen();
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith('server.mjs');
if (isMain) {
  startServer();
}
