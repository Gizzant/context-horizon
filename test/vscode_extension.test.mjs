import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildVsixArchive, listZipEntries } from '../scripts/build_vsix.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extensions', 'vscode-highbeam');

const daemonClient = require(path.join(EXT_DIR, 'src', 'daemonClient.js'));
const statusBarFormatter = require(path.join(EXT_DIR, 'src', 'statusBarFormatter.js'));
const webviewHtml = require(path.join(EXT_DIR, 'src', 'webviewHtml.js'));
const extensionHost = require(path.join(EXT_DIR, 'src', 'extension.js'));

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vsix-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

async function startMockLoopbackDaemon({ statePayload = null, healthPayload = null } = {}) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          healthPayload || {
            ok: true,
            pid: process.pid,
            port: srv.address().port,
            version: '4.2.3'
          }
        )
      );
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          statePayload || {
            model: { id: 'claude-sonnet-5-5', rawLabel: 'Claude Sonnet 5.5' },
            flightMode: 'COACH',
            window: { totalActiveTokens: 64000, maxTokens: 200000, usedPercentage: 32 },
            quota: { cache: { ttlRemainingSec: 222, isCacheCold: false, hitRatePct: 88 } },
            savings: { workspace30dSavedUSD: 14.5 }
          }
        )
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  return {
    port,
    close: () => new Promise((resolve) => srv.close(() => resolve()))
  };
}

function createMockVscode({ configOverrides = {}, workspaceFolders = [] } = {}) {
  const registeredCommands = new Map();
  let registeredProvider = null;
  const clipboardWrites = [];
  const externalOpens = [];
  const infoMessages = [];
  const warningMessages = [];
  const errorMessages = [];
  const terminalCommands = [];
  const createdPanels = [];

  const statusBarItem = {
    text: '',
    tooltip: '',
    command: '',
    backgroundColor: undefined,
    shown: false,
    disposed: false,
    show() {
      this.shown = true;
    },
    hide() {
      this.shown = false;
    },
    dispose() {
      this.disposed = true;
    }
  };

  class MockThemeColor {
    constructor(id) {
      this.id = id;
    }
  }

  class MockMarkdownString {
    constructor(value) {
      this.value = value;
    }
  }

  function makeWebview() {
    let messageHandler = null;
    return {
      html: '',
      options: {},
      onDidReceiveMessage(cb) {
        messageHandler = cb;
        return { dispose() {} };
      },
      _emitMessage(msg) {
        return messageHandler ? messageHandler(msg) : undefined;
      }
    };
  }

  const vscodeApi = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    ThemeColor: MockThemeColor,
    MarkdownString: MockMarkdownString,
    Uri: {
      parse: (s) => ({ toString: () => String(s), raw: String(s) })
    },
    env: {
      clipboard: {
        writeText: async (txt) => {
          clipboardWrites.push(txt);
        }
      },
      openExternal: async (uri) => {
        externalOpens.push(uri.toString());
        return true;
      }
    },
    workspace: {
      workspaceFolders: workspaceFolders.map((p) => ({ uri: { fsPath: p } })),
      getConfiguration: () => ({
        get: (key, fallback) =>
          Object.prototype.hasOwnProperty.call(configOverrides, key) ? configOverrides[key] : fallback
      }),
      onDidChangeConfiguration: () => ({ dispose() {} })
    },
    commands: {
      registerCommand: (id, fn) => {
        registeredCommands.set(id, fn);
        return { dispose() { registeredCommands.delete(id); } };
      },
      executeCommand: async (id, ...args) => {
        if (registeredCommands.has(id)) {
          return registeredCommands.get(id)(...args);
        }
        return undefined;
      }
    },
    window: {
      createOutputChannel: () => ({
        lines: [],
        appendLine(line) {
          this.lines.push(line);
        },
        dispose() {}
      }),
      createStatusBarItem: () => statusBarItem,
      registerWebviewViewProvider: (viewId, provider) => {
        registeredProvider = { viewId, provider };
        return { dispose() {} };
      },
      createWebviewPanel: (viewType, title, col, opts) => {
        let disposeCb = null;
        const panel = {
          viewType,
          title,
          column: col,
          options: opts,
          revealed: false,
          webview: makeWebview(),
          reveal() {
            this.revealed = true;
          },
          onDidDispose(cb) {
            disposeCb = cb;
            return { dispose() {} };
          },
          dispose() {
            if (disposeCb) disposeCb();
          }
        };
        createdPanels.push(panel);
        return panel;
      },
      createTerminal: () => ({
        exitStatus: undefined,
        show() {},
        sendText(text) {
          terminalCommands.push(text);
        },
        dispose() {}
      }),
      showInformationMessage: (msg) => {
        infoMessages.push(msg);
      },
      showWarningMessage: (msg) => {
        warningMessages.push(msg);
      },
      showErrorMessage: (msg) => {
        errorMessages.push(msg);
      }
    }
  };

  return {
    vscodeApi,
    registeredCommands,
    getRegisteredProvider: () => registeredProvider,
    makeWebview,
    statusBarItem,
    clipboardWrites,
    externalOpens,
    infoMessages,
    warningMessages,
    errorMessages,
    terminalCommands,
    createdPanels
  };
}

describe('Phase 2 — VS Code / Open VSX Extension Wrapper', () => {
  it('1. Manifest, commands, configuration schema, SVG currentColor icon, and 128x128 PNG icon are valid', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const extPkg = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));

    assert.equal(extPkg.name, 'highbeam');
    assert.equal(extPkg.publisher, 'gizzant');
    assert.equal(extPkg.version, rootPkg.version);
    assert.equal(extPkg.license, 'MIT');
    assert.equal(extPkg.main, './src/extension.js');
    assert.deepEqual(extPkg.dependencies || {}, {});
    assert.ok(extPkg.engines && typeof extPkg.engines.vscode === 'string');

    const cmdIds = extPkg.contributes.commands.map((c) => c.command);
    assert.equal(cmdIds.length, 8);
    for (const requiredCmd of [
      'highbeam.openSidebar',
      'highbeam.openPanel',
      'highbeam.copyCompact',
      'highbeam.runAudit',
      'highbeam.runDoctor',
      'highbeam.startDaemon',
      'highbeam.stopDaemon',
      'highbeam.openInBrowser'
    ]) {
      assert.ok(cmdIds.includes(requiredCmd), `Missing command ${requiredCmd}`);
    }

    assert.equal(extPkg.contributes.views['highbeam-sidebar'][0].id, 'highbeam.hudView');

    const sidebarSvg = fs.readFileSync(path.join(EXT_DIR, 'media', 'sidebar-icon.svg'), 'utf8');
    assert.ok(sidebarSvg.includes('currentColor'), 'Activity bar SVG must use currentColor');

    const iconPngPath = path.join(EXT_DIR, 'media', 'icon.png');
    assert.equal(fs.existsSync(iconPngPath), true, 'media/icon.png must exist');
    const iconBytes = fs.readFileSync(iconPngPath);
    assert.deepEqual(
      iconBytes.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      'icon.png must have valid PNG signature'
    );
    assert.equal(iconBytes.readUInt32BE(16), 128);
    assert.equal(iconBytes.readUInt32BE(20), 128);
  });

  it('2. daemonClient discovers running loopback daemon, validates ports, resolves launch priority, and leaves external daemons running on stop()', async () => {
    assert.equal(daemonClient.isValidLoopbackPort(62935), true);
    assert.equal(daemonClient.isValidLoopbackPort(80), false);
    assert.equal(daemonClient.isValidLoopbackPort(70000), false);
    assert.equal(daemonClient.isValidLoopbackPort('abc'), false);

    await withTempDir(async (tmpHome) => {
      const ctxDir = path.join(tmpHome, '.ctxtop');
      fs.mkdirSync(ctxDir, { recursive: true });

      const mockDaemon = await startMockLoopbackDaemon();
      try {
        fs.writeFileSync(
          path.join(ctxDir, 'daemon.json'),
          JSON.stringify({ port: mockDaemon.port, pid: process.pid, workspace: ROOT }),
          'utf8'
        );

        const lock = daemonClient.readPortLockfile(tmpHome);
        assert.equal(lock.port, mockDaemon.port);
        assert.equal(lock.source, 'daemon.json');

        const found = await daemonClient.discoverRunningDaemon({
          homeDir: tmpHome,
          preferredPort: 62999,
          timeoutMs: 1200
        });
        assert.equal(found.port, mockDaemon.port);
        assert.equal(found.source, 'lockfile');
        assert.equal(found.health.ok, true);

        let spawnedCount = 0;
        const mgr = new daemonClient.DaemonManager({
          getOptions: () => ({ homeDir: tmpHome, preferredPort: 62999 }),
          spawnFn: () => {
            spawnedCount += 1;
            throw new Error('Should not spawn when daemon is already running');
          }
        });

        const ensureRes = await mgr.ensureRunning();
        assert.equal(ensureRes.ok, true);
        assert.equal(ensureRes.port, mockDaemon.port);
        assert.equal(ensureRes.owned, false);
        assert.equal(spawnedCount, 0);

        const stopRes = mgr.stop();
        assert.equal(stopRes.stopped, false);
        assert.equal(stopRes.reason, 'EXTERNAL_DAEMON');
      } finally {
        await mockDaemon.close();
      }
    });

    const winFallbackSpec = daemonClient.resolveDaemonLaunchSpec({
      workspaceFolders: [],
      homeDir: path.join(os.tmpdir(), 'nonexistent-hb-home'),
      extensionRoot: path.join(os.tmpdir(), 'nonexistent-ext'),
      platform: 'win32'
    });
    assert.equal(winFallbackSpec.source, 'npx_fallback');
    assert.equal(winFallbackSpec.useCmdWrapper, true);
    assert.ok(Array.isArray(winFallbackSpec.args) && winFallbackSpec.args.includes('npx'));
    assert.ok(winFallbackSpec.args.includes('highbeam-cli'));

    const wsSpec = daemonClient.resolveDaemonLaunchSpec({
      workspaceFolders: [ROOT],
      platform: 'linux'
    });
    assert.equal(wsSpec.source, 'workspace_checkout');
    assert.equal(wsSpec.useCmdWrapper, false);
    assert.equal(path.basename(wsSpec.args[0]), 'server.mjs');
  });

  it('3. statusBarFormatter formats offline, nominal, warning, critical, and AUTO_PILOT states with real values only', () => {
    const offline = statusBarFormatter.formatStatusBar(null, { connected: false });
    assert.equal(offline.severity, 'disconnected');
    assert.ok(offline.text.includes('Offline'));
    assert.equal(offline.tooltipMarkdown.includes('$'), false);

    const nominal = statusBarFormatter.formatStatusBar(
      {
        model: { id: 'claude-sonnet-5-5' },
        flightMode: 'COACH',
        window: { totalActiveTokens: 64000, maxTokens: 200000, usedPercentage: 32 },
        quota: { cache: { ttlRemainingSec: 222, isCacheCold: false, hitRatePct: 88 } },
        savings: { workspace30dSavedTokens: 142000 }
      },
      { connected: true, port: 62935 }
    );
    assert.equal(nominal.severity, 'nominal');
    assert.equal(nominal.text, '$(eye) HB 32% · TTL 3m42s');
    assert.ok(nominal.tooltipMarkdown.includes('+142k tokens'));
    assert.equal(nominal.tooltipMarkdown.includes('USD'), false);
    assert.ok(nominal.tooltipMarkdown.includes('64k / 200k'));

    const warnTtl = statusBarFormatter.formatStatusBar(
      {
        flightMode: 'AUTO_PILOT',
        window: { totalActiveTokens: 156000, maxTokens: 200000, usedPercentage: 78 },
        quota: { cache: { ttlRemainingSec: 35, isCacheCold: false } }
      },
      { connected: true, port: 62935 }
    );
    assert.equal(warnTtl.severity, 'warning');
    assert.equal(warnTtl.text, '$(warning) HB 78% · TTL 0m35s · AUTO');

    const crit = statusBarFormatter.formatStatusBar(
      {
        amputationCrisis: true,
        window: { totalActiveTokens: 186000, maxTokens: 200000, usedPercentage: 93 },
        quota: { cache: { ttlRemainingSec: 0, isCacheCold: true } }
      },
      { connected: true, port: 62935 }
    );
    assert.equal(crit.severity, 'critical');
    assert.equal(crit.text, '$(error) HB 93% · Risk');
  });

  it('4. webviewHtml builds strict CSP shells, validates message origins, escapes errors, and keeps #btnCompactPrimary invariant', () => {
    const connHtml = webviewHtml.renderConnectedShellHtml({ port: 62935, nonce: 'abc123' });
    assert.ok(connHtml.includes("frame-src http://127.0.0.1:62935"));
    assert.ok(connHtml.includes("script-src 'nonce-abc123'"));
    assert.ok(connHtml.includes('src="http://127.0.0.1:62935/?vscode=1"'));
    assert.ok(connHtml.includes("ev.origin !== expectedOrigin"));
    assert.throws(() => webviewHtml.renderConnectedShellHtml({ port: 80 }), /Invalid loopback port/);

    const offHtml = webviewHtml.renderOfflineShellHtml({
      status: 'offline',
      detail: '<script>alert(1)</script>',
      nonce: 'xyz789'
    });
    assert.equal(offHtml.includes('<script>alert(1)</script>'), false);
    assert.ok(offHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(offHtml.includes('id="btnCompactPrimary"'));
    assert.ok(offHtml.includes('id="compactInstruction">Type /compact in the chat box and press Enter</p>'));
  });

  it('5. extension host activates commands, connects WebView with portMapping, blocks untrusted external URLs, and disposes cleanly', async () => {
    await withTempDir(async (tmpHome) => {
      const ctxDir = path.join(tmpHome, '.ctxtop');
      fs.mkdirSync(ctxDir, { recursive: true });
      const mockDaemon = await startMockLoopbackDaemon();
      fs.writeFileSync(path.join(ctxDir, 'daemon.port'), String(mockDaemon.port), 'utf8');

      const host = createMockVscode({
        configOverrides: { autoStartDaemon: true, statusBarEnabled: true, pollIntervalMs: 60000 },
        workspaceFolders: [ROOT]
      });

      const controller = extensionHost.createExtensionController(host.vscodeApi, {
        homeDir: tmpHome,
        extensionRoot: EXT_DIR
      });

      try {
        const ctx = { subscriptions: [] };
        await controller.activate(ctx);

        assert.equal(host.registeredCommands.size, 8);
        assert.ok(host.statusBarItem.shown);
        assert.equal(host.statusBarItem.text, '$(eye) HB 32% · TTL 3m42s');

        const sidebarWebview = host.makeWebview();
        host.getRegisteredProvider().provider.resolveWebviewView({
          webview: sidebarWebview,
          show() {}
        });
        assert.deepEqual(sidebarWebview.options.portMapping, [
          { webviewPort: mockDaemon.port, extensionHostPort: mockDaemon.port }
        ]);
        assert.ok(sidebarWebview.html.includes(`http://127.0.0.1:${mockDaemon.port}/?vscode=1`));

        await host.registeredCommands.get('highbeam.copyCompact')();
        assert.deepEqual(host.clipboardWrites, ['/compact']);

        await host.registeredCommands.get('highbeam.openPanel')();
        assert.equal(host.createdPanels.length, 1);
        assert.ok(host.createdPanels[0].webview.html.includes(`http://127.0.0.1:${mockDaemon.port}/?vscode=1`));

        await controller.handleWebviewMessage({ type: 'openExternal', url: 'https://evil.example/phish' });
        assert.equal(host.externalOpens.length, 0, 'Untrusted external URL must be blocked');

        await controller.handleWebviewMessage({
          type: 'openExternal',
          url: `http://127.0.0.1:${mockDaemon.port}/cost-radar`
        });
        assert.deepEqual(host.externalOpens, [`http://127.0.0.1:${mockDaemon.port}/cost-radar`]);

        await host.registeredCommands.get('highbeam.runAudit')();
        assert.ok(host.terminalCommands.some((c) => c.includes('audit --days 7')));
      } finally {
        controller.dispose();
        await mockDaemon.close();
      }
    });
  });

  it('6. buildVsixArchive packages a valid <100 KB ZIP/.vsix containing OPC manifests, PNG icon, and extension sources', async () => {
    await withTempDir(async (tmpOutDir) => {
      const res = buildVsixArchive({ outDir: tmpOutDir, writeIcon: false });
      assert.equal(res.ok, true);
      assert.ok(res.bytes > 1000 && res.bytes < 100 * 1024, `Unexpected .vsix size: ${res.bytes} bytes`);

      const buf = fs.readFileSync(res.outPath);
      assert.deepEqual(buf.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'Must start with ZIP PK\\x03\\x04');

      const entries = listZipEntries(buf).map((e) => e.name);
      for (const requiredEntry of [
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/package.json',
        'extension/README.md',
        'extension/LICENSE',
        'extension/media/icon.png',
        'extension/media/sidebar-icon.svg',
        'extension/src/daemonClient.js',
        'extension/src/statusBarFormatter.js',
        'extension/src/webviewHtml.js',
        'extension/src/extension.js'
      ]) {
        assert.ok(entries.includes(requiredEntry), `Missing .vsix archive entry: ${requiredEntry}`);
      }
      assert.equal(entries.some((n) => n.endsWith('.vsix')), false, 'Archive must not nest another .vsix');
    });
  });
});
