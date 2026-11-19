'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_DAEMON_PORT,
  isValidLoopbackPort,
  DaemonManager
} = require('./daemonClient.js');
const { formatStatusBar } = require('./statusBarFormatter.js');
const {
  createNonce,
  renderConnectedShellHtml,
  renderOfflineShellHtml
} = require('./webviewHtml.js');

const ALLOWED_WEBVIEW_COMMANDS = new Set([
  'highbeam.openSidebar',
  'highbeam.openPanel',
  'highbeam.copyCompact',
  'highbeam.runAudit',
  'highbeam.runDoctor',
  'highbeam.startDaemon',
  'highbeam.stopDaemon',
  'highbeam.openInBrowser'
]);

function isAllowedExternalUrl(rawUrl, daemonPort = null) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'gizzant.github.io' &&
      (parsed.pathname === '/context-horizon' || parsed.pathname.startsWith('/context-horizon/'))
    ) {
      return true;
    }
    if (
      isValidLoopbackPort(daemonPort) &&
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      Number(parsed.port || 80) === Number(daemonPort)
    ) {
      return true;
    }
    return false;
  } catch (err) {
    void err; // Reject malformed URLs safely.
    return false;
  }
}

function getWorkspacePaths(vscodeApi) {
  const folders = vscodeApi?.workspace?.workspaceFolders;
  if (!Array.isArray(folders)) return [];
  return folders
    .map((f) => f?.uri?.fsPath)
    .filter((p) => typeof p === 'string' && p.length > 0);
}

function buildCliCommandString(subcommand, workspaceFolders = []) {
  for (const wsPath of workspaceFolders) {
    const localCli = path.join(wsPath, 'bin', 'ctxtop.mjs');
    if (fs.existsSync(localCli)) {
      return `node "${localCli}" ${subcommand}`;
    }
  }
  return `npx ctxtop ${subcommand}`;
}

function createExtensionController(vscodeApi, deps = {}) {
  const disposables = [];
  let disposed = false;
  let sidebarView = null;
  let hudPanel = null;
  let terminalRef = null;
  let pollTimer = null;
  let daemonStatus = 'offline';
  let lastDetail = '';

  const setIntervalFn = typeof deps.setIntervalFn === 'function' ? deps.setIntervalFn : setInterval;
  const clearIntervalFn = typeof deps.clearIntervalFn === 'function' ? deps.clearIntervalFn : clearInterval;

  const outputChannel = vscodeApi.window.createOutputChannel('Highbeam (ctxtop)');
  disposables.push(outputChannel);

  const log = (line) => {
    if (typeof deps.logger === 'function') deps.logger(line);
    try {
      outputChannel.appendLine(`[${new Date().toISOString()}] ${line}`);
    } catch (err) {
      void err; // Ignore logging failures when output channel is already closing.
    }
  };

  const readConfig = () => {
    const cfg = vscodeApi.workspace?.getConfiguration?.('highbeam');
    const getVal = (key, fallback) => (cfg && typeof cfg.get === 'function' ? cfg.get(key, fallback) : fallback);
    const portNum = Number(getVal('daemonPort', DEFAULT_DAEMON_PORT));
    const pollMs = Number(getVal('pollIntervalMs', 3000));
    return {
      autoStartDaemon: Boolean(getVal('autoStartDaemon', true)),
      preferredPort: isValidLoopbackPort(portNum) ? portNum : DEFAULT_DAEMON_PORT,
      cliCommand: String(getVal('cliCommand', '') || '').trim(),
      nodePath: String(getVal('nodePath', 'node') || 'node').trim() || 'node',
      statusBarEnabled: Boolean(getVal('statusBarEnabled', true)),
      pollIntervalMs: Number.isFinite(pollMs) ? Math.max(1000, Math.min(30000, pollMs)) : 3000
    };
  };

  const daemon =
    deps.daemonManager ||
    new DaemonManager({
      getOptions: () => {
        const cfg = readConfig();
        return {
          homeDir: deps.homeDir,
          preferredPort: cfg.preferredPort,
          cliCommand: cfg.cliCommand,
          nodePath: cfg.nodePath,
          workspaceFolders: Array.isArray(deps.workspaceFolders) ? deps.workspaceFolders : getWorkspacePaths(vscodeApi),
          extensionRoot: deps.extensionRoot || path.resolve(__dirname, '..')
        };
      },
      logger: log
    });

  const statusBarItem = vscodeApi.window.createStatusBarItem(
    vscodeApi.StatusBarAlignment?.Left ?? 1,
    100
  );
  statusBarItem.command = 'highbeam.openSidebar';
  disposables.push(statusBarItem);

  const applyStatusBar = (state = null, info = { connected: false }) => {
    const cfg = readConfig();
    if (!cfg.statusBarEnabled) {
      statusBarItem.hide();
      return;
    }
    const formatted = formatStatusBar(state, info);
    statusBarItem.text = formatted.text;
    statusBarItem.tooltip =
      typeof vscodeApi.MarkdownString === 'function'
        ? new vscodeApi.MarkdownString(formatted.tooltipMarkdown)
        : formatted.tooltipMarkdown;

    if (typeof vscodeApi.ThemeColor === 'function') {
      if (formatted.severity === 'critical') {
        statusBarItem.backgroundColor = new vscodeApi.ThemeColor('statusBarItem.errorBackground');
      } else if (formatted.severity === 'warning') {
        statusBarItem.backgroundColor = new vscodeApi.ThemeColor('statusBarItem.warningBackground');
      } else {
        statusBarItem.backgroundColor = undefined;
      }
    }
    statusBarItem.show();
  };

  const applyWebviewHtml = (webview) => {
    if (!webview) return;
    if (isValidLoopbackPort(daemon.port)) {
      webview.options = {
        enableScripts: true,
        portMapping: [{ webviewPort: daemon.port, extensionHostPort: daemon.port }]
      };
      webview.html = renderConnectedShellHtml({
        port: daemon.port,
        nonce: createNonce()
      });
      return;
    }

    webview.options = { enableScripts: true };
    webview.html = renderOfflineShellHtml({
      status: daemonStatus,
      detail: lastDetail,
      nonce: createNonce()
    });
  };

  const refreshAllWebviews = () => {
    if (sidebarView?.webview) applyWebviewHtml(sidebarView.webview);
    if (hudPanel?.webview) applyWebviewHtml(hudPanel.webview);
  };

  const runInTerminal = (cliSubcommand) => {
    const folders = Array.isArray(deps.workspaceFolders) ? deps.workspaceFolders : getWorkspacePaths(vscodeApi);
    const cmdLine = buildCliCommandString(cliSubcommand, folders);
    if (!terminalRef || terminalRef.exitStatus !== undefined) {
      terminalRef = vscodeApi.window.createTerminal({ name: 'Highbeam' });
      disposables.push(terminalRef);
    }
    terminalRef.show(false);
    terminalRef.sendText(cmdLine, true);
  };

  const refreshTelemetry = async () => {
    if (disposed) return;
    if (!isValidLoopbackPort(daemon.port)) {
      applyStatusBar(null, { connected: false, error: lastDetail });
      return;
    }

    try {
      const state = await daemon.getState();
      applyStatusBar(state, { connected: true, port: daemon.port });
    } catch (err) {
      void err; // Daemon may have stopped externally; check health before resetting shell.
      try {
        const health = await daemon.getHealth();
        if (health && health.ok) {
          applyStatusBar(null, { connected: true, port: daemon.port });
          return;
        }
      } catch (healthErr) {
        lastDetail = healthErr.message;
      }
      daemon.port = null;
      daemonStatus = 'offline';
      applyStatusBar(null, { connected: false, error: lastDetail });
      refreshAllWebviews();
    }
  };

  const ensureDaemonAndRefresh = async () => {
    daemonStatus = 'starting';
    lastDetail = '';
    refreshAllWebviews();

    const res = await daemon.ensureRunning();
    if (res && res.ok && isValidLoopbackPort(res.port)) {
      daemonStatus = 'connected';
      lastDetail = '';
      refreshAllWebviews();
      await refreshTelemetry();
      return res;
    }

    daemonStatus = 'offline';
    lastDetail = res?.error || 'Unable to start local Highbeam daemon.';
    refreshAllWebviews();
    applyStatusBar(null, { connected: false, error: lastDetail });
    return res;
  };

  const handleWebviewMessage = async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const msgType = String(msg.type || '');
    if (msgType === 'startDaemon') {
      await ensureDaemonAndRefresh();
      return;
    }
    if (msgType === 'copyCompact') {
      await vscodeApi.commands.executeCommand('highbeam.copyCompact');
      return;
    }
    if (msgType === 'runAudit') {
      await vscodeApi.commands.executeCommand('highbeam.runAudit');
      return;
    }
    if (msgType === 'runDoctor') {
      await vscodeApi.commands.executeCommand('highbeam.runDoctor');
      return;
    }
    if (msgType === 'focusChatInput') {
      for (const cmdId of ['antigravity.focusChatInput', 'workbench.action.chat.open']) {
        try {
          await vscodeApi.commands.executeCommand(cmdId);
          return;
        } catch (err) {
          void err; // Try fallback chat focus command if host does not register this ID.
        }
      }
      return;
    }
    if (msgType === 'openExternal') {
      if (isAllowedExternalUrl(msg.url, daemon.port)) {
        await vscodeApi.env.openExternal(vscodeApi.Uri.parse(String(msg.url)));
      } else {
        log(`Blocked untrusted openExternal URL from webview: ${String(msg.url || '')}`);
      }
      return;
    }
    if (msgType === 'runCommand') {
      const cmdId = String(msg.command || '');
      if (ALLOWED_WEBVIEW_COMMANDS.has(cmdId)) {
        await vscodeApi.commands.executeCommand(cmdId);
      }
    }
  };

  const registerWebviewProvider = () => {
    if (!vscodeApi.window?.registerWebviewViewProvider) return;
    const provider = {
      resolveWebviewView(webviewView) {
        sidebarView = webviewView;
        applyWebviewHtml(webviewView.webview);
        const msgDisp = webviewView.webview.onDidReceiveMessage((msg) => {
          handleWebviewMessage(msg).catch((err) => {
            log(`WebView message error: ${err.message}`);
          });
        });
        disposables.push(msgDisp);
        if (typeof webviewView.onDidDispose === 'function') {
          disposables.push(
            webviewView.onDidDispose(() => {
              if (sidebarView === webviewView) sidebarView = null;
            })
          );
        }
        if (!isValidLoopbackPort(daemon.port) && readConfig().autoStartDaemon) {
          ensureDaemonAndRefresh().catch((err) => {
            log(`Auto-start daemon error: ${err.message}`);
          });
        }
      }
    };
    const disp = vscodeApi.window.registerWebviewViewProvider('highbeam.hudView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    });
    disposables.push(disp);
  };

  const registerCommand = (id, handler) => {
    const disp = vscodeApi.commands.registerCommand(id, async (...args) => {
      try {
        return await handler(...args);
      } catch (err) {
        log(`Command ${id} failed: ${err.message}`);
        vscodeApi.window?.showErrorMessage?.(`Highbeam error (${id}): ${err.message}`);
        return undefined;
      }
    });
    disposables.push(disp);
  };

  const startPolling = () => {
    if (pollTimer !== null) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
    const { pollIntervalMs } = readConfig();
    pollTimer = setIntervalFn(() => {
      refreshTelemetry().catch((err) => {
        log(`Telemetry poll error: ${err.message}`);
      });
    }, pollIntervalMs);
  };

  const activate = async (context) => {
    registerWebviewProvider();

    registerCommand('highbeam.openSidebar', async () => {
      try {
        await vscodeApi.commands.executeCommand('workbench.view.extension.highbeam-sidebar');
      } catch (err) {
        void err; // Fallback when running under minimal command registries.
      }
      if (sidebarView && typeof sidebarView.show === 'function') {
        sidebarView.show(true);
      }
      if (!isValidLoopbackPort(daemon.port) && readConfig().autoStartDaemon) {
        await ensureDaemonAndRefresh();
      }
    });

    registerCommand('highbeam.openPanel', async () => {
      if (!isValidLoopbackPort(daemon.port)) {
        await ensureDaemonAndRefresh();
      }
      if (hudPanel) {
        hudPanel.reveal(vscodeApi.ViewColumn?.Beside ?? 2);
        applyWebviewHtml(hudPanel.webview);
        return hudPanel;
      }
      hudPanel = vscodeApi.window.createWebviewPanel(
        'highbeam.hudPanel',
        'Highbeam (ctxtop) HUD',
        vscodeApi.ViewColumn?.Beside ?? 2,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          ...(isValidLoopbackPort(daemon.port)
            ? { portMapping: [{ webviewPort: daemon.port, extensionHostPort: daemon.port }] }
            : {})
        }
      );
      applyWebviewHtml(hudPanel.webview);
      const msgDisp = hudPanel.webview.onDidReceiveMessage((msg) => {
        handleWebviewMessage(msg).catch((err) => {
          log(`Panel message error: ${err.message}`);
        });
      });
      const disposePanel = hudPanel.onDidDispose(() => {
        hudPanel = null;
      });
      disposables.push(msgDisp, disposePanel);
      return hudPanel;
    });

    registerCommand('highbeam.copyCompact', async () => {
      await vscodeApi.env.clipboard.writeText('/compact');
      vscodeApi.window?.showInformationMessage?.('Copied /compact — paste in your AI chat box and press Enter.');
    });

    registerCommand('highbeam.runAudit', () => {
      runInTerminal('audit --days 7');
    });

    registerCommand('highbeam.runDoctor', () => {
      runInTerminal('doctor');
    });

    registerCommand('highbeam.startDaemon', async () => {
      const res = await ensureDaemonAndRefresh();
      if (res && res.ok) {
        vscodeApi.window?.showInformationMessage?.(`Highbeam daemon active on http://127.0.0.1:${res.port}/`);
      } else {
        vscodeApi.window?.showWarningMessage?.(
          `Could not start Highbeam daemon: ${res?.error || 'check Node >= 22.13.0 and Output -> Highbeam (ctxtop).'}`
        );
      }
      return res;
    });

    registerCommand('highbeam.stopDaemon', () => {
      const stopRes = daemon.stop();
      if (stopRes.stopped) {
        daemonStatus = 'offline';
        lastDetail = 'Stopped by user';
        applyStatusBar(null, { connected: false, error: lastDetail });
        refreshAllWebviews();
        vscodeApi.window?.showInformationMessage?.('Stopped extension-managed Highbeam telemetry daemon.');
      } else if (stopRes.reason === 'EXTERNAL_DAEMON') {
        vscodeApi.window?.showInformationMessage?.(
          'Highbeam daemon is running externally (started by CLI/Antigravity) and was left running.'
        );
      } else {
        vscodeApi.window?.showInformationMessage?.('Highbeam telemetry daemon is not running.');
      }
      return stopRes;
    });

    registerCommand('highbeam.openInBrowser', async () => {
      if (!isValidLoopbackPort(daemon.port)) {
        const res = await ensureDaemonAndRefresh();
        if (!res || !res.ok) return false;
      }
      const targetUrl = `http://127.0.0.1:${daemon.port}/`;
      if (isAllowedExternalUrl(targetUrl, daemon.port)) {
        return vscodeApi.env.openExternal(vscodeApi.Uri.parse(targetUrl));
      }
      return false;
    });

    if (vscodeApi.workspace?.onDidChangeConfiguration) {
      const cfgDisp = vscodeApi.workspace.onDidChangeConfiguration((ev) => {
        if (ev?.affectsConfiguration?.('highbeam')) {
          startPolling();
          refreshTelemetry().catch((err) => {
            log(`Config refresh error: ${err.message}`);
          });
        }
      });
      disposables.push(cfgDisp);
    }

    applyStatusBar(null, { connected: false });
    startPolling();

    if (readConfig().autoStartDaemon) {
      await ensureDaemonAndRefresh();
    }

    if (Array.isArray(context?.subscriptions)) {
      context.subscriptions.push({
        dispose: () => dispose()
      });
    }
  };

  const dispose = () => {
    disposed = true;
    if (pollTimer !== null) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
    daemon.stop();
    while (disposables.length > 0) {
      const d = disposables.pop();
      try {
        d?.dispose?.();
      } catch (err) {
        void err; // Best-effort cleanup of remaining VS Code disposables.
      }
    }
  };

  return {
    daemon,
    activate,
    dispose,
    refreshTelemetry,
    ensureDaemonAndRefresh,
    handleWebviewMessage,
    getSidebarView: () => sidebarView,
    getHudPanel: () => hudPanel
  };
}

let activeController = null;

async function activate(context) {
  let vscodeApi = null;
  try {
    vscodeApi = require('vscode');
  } catch (err) {
    throw new Error(`Highbeam VS Code host API is unavailable outside IDE runtime: ${err.message}`);
  }
  activeController = createExtensionController(vscodeApi);
  await activeController.activate(context);
  return activeController;
}

function deactivate() {
  if (activeController) {
    activeController.dispose();
    activeController = null;
  }
}

module.exports = {
  ALLOWED_WEBVIEW_COMMANDS,
  isAllowedExternalUrl,
  createExtensionController,
  activate,
  deactivate
};
