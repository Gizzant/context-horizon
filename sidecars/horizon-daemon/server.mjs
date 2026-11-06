import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getHomeDir } from '../../src/core/paths.mjs';
import { runCLI } from '../../src/cli/horizon_hud.mjs';
import { findSessionDirectory } from '../../src/core/parser.mjs';
import { loadSettings, saveSettings, SETTINGS_LIMITS } from '../../src/core/settings.mjs';
import { pruneSessionTranscript } from '../../src/core/pruner.mjs';
import { inspectHostProcesses, reapOrphanProcesses } from '../../src/core/host_watchdog.mjs';

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
const widgetHtml = path.resolve(__dirname, '../../src/ui/widget.html');
const horizonPanelHtml = path.resolve(__dirname, '../../src/webview/horizon_panel.html');

let lastEvalMs = 0;
let cachedLiveState = null;
let pinnedConversationId = null;
let activeLockfiles = [];

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
    return cachedLiveState;
  }
  try {
    const [resLive, hostHealth] = await Promise.all([
      runCLI({
        silent: true,
        useNativeCeiling: true,
        stdinData: targetConvId ? { conversation_id: targetConvId } : null
      }),
      inspectHostProcesses({ force: false })
    ]);
    if (resLive && resLive.state) {
      resLive.state.pinnedConversationId = pinnedConversationId;
      resLive.state.hostHealth = hostHealth;
      cachedLiveState = resLive.state;
      lastEvalMs = now;
      return cachedLiveState;
    }
  } catch {}

  if (fs.existsSync(stateFile)) {
    try {
      cachedLiveState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!cachedLiveState.hostHealth) {
        cachedLiveState.hostHealth = await inspectHostProcesses({ force: false });
      }
      return cachedLiveState;
    } catch {}
  }

  // Fallback to FlightCheck session sidecar if present
  const fcSessionsDir = path.join(getHomeDir(), '.gemini', 'flightcheck', 'sessions');
  if (fs.existsSync(fcSessionsDir)) {
    try {
      const files = fs.readdirSync(fcSessionsDir)
        .filter(f => f.endsWith('.sidecar.json'))
        .map(f => ({ name: f, time: fs.statSync(path.join(fcSessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (files.length > 0) {
        cachedLiveState = JSON.parse(fs.readFileSync(path.join(fcSessionsDir, files[0].name), 'utf8'));
        return cachedLiveState;
      }
    } catch {}
  }

  return cachedLiveState;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
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

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    if (fs.existsSync(sidePaneHtml)) {
      res.end(fs.readFileSync(sidePaneHtml));
    } else if (fs.existsSync(horizonPanelHtml)) {
      res.end(fs.readFileSync(horizonPanelHtml));
    } else {
      res.end('<h1>Chrono-Attention Horizon Side-Pane</h1>');
    }
    return;
  }

  if (url.pathname === '/widget' || url.pathname === '/widget.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (fs.existsSync(widgetHtml)) {
      res.end(fs.readFileSync(widgetHtml));
    } else if (fs.existsSync(horizonPanelHtml)) {
      res.end(fs.readFileSync(horizonPanelHtml));
    } else {
      res.end('<h1>Chrono-Attention Horizon Widget</h1>');
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
    const state = await refreshLiveState(true, pinnedConversationId);
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

  // Route: POST /api/prune (Rank #2: Prefix-Safe Surgical Context Pruner & AST Folder)
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

  // Route: POST /api/host/reap (Rank #3: Host Process & Zombie Subagent/MCP Watchdog)
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
