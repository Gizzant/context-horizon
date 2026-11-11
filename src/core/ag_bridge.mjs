import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getHomeDir } from './paths.mjs';
import { atomicWriteFileSync } from './atomic_io.mjs';

/**
 * Phase 0: Native Command & Prompt Dispatch Bridge (`AgBridgeService`)
 *
 * Provides a multi-tier command & session dispatch bridge for Google Antigravity:
 *  1. Tier 1 (`rpc`): Local `language_server` RPC transport (`GetCascadeTrajectoryGeneratorMetadata` / command dispatch)
 *  2. Tier 2 (`cdp`): Chrome DevTools Protocol (CDP) OOPIF target observer & input dispatcher
 *  3. Tier 3 (`clipboard`): Automatic fallback to clipboard ONLY if both RPC and CDP targets are unreachable
 */

/**
 * Pure parser that extracts local RPC port and CSRF/cert metadata from OS process records
 * matching Antigravity's `language_server` binary.
 */
export function discoverLanguageServerProcess(processRecords = []) {
  const list = Array.isArray(processRecords) ? processRecords : [];
  for (const proc of list) {
    const name = String(proc?.name || '').toLowerCase();
    const cmd = String(proc?.commandLine || '');
    if (!name.includes('language_server') && !cmd.toLowerCase().includes('language_server')) {
      continue;
    }

    const portMatch =
      cmd.match(/--(?:https?_port|extension_server_port|rpc_port|port)[=\s]+(\d+)/i) ||
      cmd.match(/127\.0\.0\.1:(\d+)/);
    const csrfMatch =
      cmd.match(/--(?:csrf_token|token|auth_token)[=\s]+([A-Za-z0-9._-]+)/i);
    const certMatch =
      cmd.match(/--(?:cert_path|tls_cert)[=\s]+([^\s"']+)/i);

    return {
      discovered: true,
      pid: Number(proc.pid || 0),
      port: portMatch ? Number(portMatch[1]) : null,
      csrfToken: csrfMatch ? csrfMatch[1] : null,
      certPath: certMatch ? certMatch[1] : null,
      endpoint: portMatch ? `https://127.0.0.1:${portMatch[1]}` : null
    };
  }

  return {
    discovered: false,
    pid: null,
    port: null,
    csrfToken: null,
    certPath: null,
    endpoint: null
  };
}

export class AgBridgeService {
  constructor(options = {}) {
    this.homeDir = options.homeDir || getHomeDir();
    this.rpcTransport = options.rpcTransport || null;
    this.cdpTransport = options.cdpTransport || null;
    this.vscodeCommands = options.vscodeCommands || null;
    this.enableExperimentalCdpActuation = options.enableExperimentalCdpActuation !== undefined
      ? Boolean(options.enableExperimentalCdpActuation)
      : (options.settings?.['attentionHorizon.enableExperimentalCdpActuation'] !== undefined
        ? Boolean(options.settings['attentionHorizon.enableExperimentalCdpActuation'])
        : null);
    this.chatInputFocused = Boolean(options.chatInputFocused || false);
    this.clipboardWriter = typeof options.clipboardWriter === 'function'
      ? options.clipboardWriter
      : (text) => { this.lastClipboardText = String(text || ''); return true; };
    this.lastClipboardText = '';
    this.dispatchLog = [];
  }

  setTransports({ rpcTransport, cdpTransport, vscodeCommands, clipboardWriter } = {}) {
    if (rpcTransport !== undefined) this.rpcTransport = rpcTransport;
    if (cdpTransport !== undefined) this.cdpTransport = cdpTransport;
    if (vscodeCommands !== undefined) this.vscodeCommands = vscodeCommands;
    if (typeof clipboardWriter === 'function') this.clipboardWriter = clipboardWriter;
  }

  setChatInputFocus(isFocused = false) {
    this.chatInputFocused = Boolean(isFocused);
    return this.chatInputFocused;
  }

  setExperimentalCdpActuation(enabled = false) {
    this.enableExperimentalCdpActuation = Boolean(enabled);
    return this.enableExperimentalCdpActuation;
  }

  isCdpActuationAllowed(payload = {}, options = {}) {
    const inputFocused = options.chatInputFocused !== undefined
      ? Boolean(options.chatInputFocused)
      : this.chatInputFocused;

    if (inputFocused) {
      return {
        allowed: false,
        reason: 'CHAT_INPUT_FOCUSED'
      };
    }

    const isModelActuation = typeof payload === 'object' && payload !== null &&
      payload.type === 'SET_MODEL_AND_EFFORT';

    const explicitSetting = options.enableExperimentalCdpActuation !== undefined
      ? Boolean(options.enableExperimentalCdpActuation)
      : (options.settings?.['attentionHorizon.enableExperimentalCdpActuation'] !== undefined
        ? Boolean(options.settings['attentionHorizon.enableExperimentalCdpActuation'])
        : this.enableExperimentalCdpActuation);

    // By default, model/effort actuation is restricted to VS Code commands / RPC notifications
    // unless `attentionHorizon.enableExperimentalCdpActuation` is explicitly enabled.
    if (isModelActuation && explicitSetting !== true) {
      return {
        allowed: false,
        reason: 'EXPERIMENTAL_CDP_DISABLED'
      };
    }

    if (explicitSetting === false) {
      return {
        allowed: false,
        reason: 'EXPERIMENTAL_CDP_DISABLED'
      };
    }

    return {
      allowed: true,
      reason: null
    };
  }

  /**
   * Dispatches a chat command or prompt to the active Antigravity session.
   * Tries registered VS Code commands / RPC first, then CDP OOPIF bridge (when allowed
   * and chat input does not have focus), and falls back to clipboard ONLY when unreachable.
   */
  async sendChatCommand(sessionId, payload, options = {}) {
    const promptText = typeof payload === 'string'
      ? payload
      : String(payload?.prompt || payload?.command || payload?.text || '');
    const normalizedPayload = typeof payload === 'object' && payload !== null
      ? { ...payload, prompt: promptText }
      : { prompt: promptText };

    // 0. Attempt registered VS Code command transport if configured
    if (this.vscodeCommands && typeof this.vscodeCommands.executeCommand === 'function') {
      try {
        const vsRes = await this.vscodeCommands.executeCommand('antigravity.horizon.dispatch', sessionId, normalizedPayload, options);
        if (vsRes && vsRes.ok !== false) {
          const entry = {
            ok: true,
            sessionId,
            transportUsed: 'vscode_command',
            fallbackUsed: false,
            payload: normalizedPayload,
            response: vsRes
          };
          this.dispatchLog.push(entry);
          return entry;
        }
      } catch {}
    }

    // 1. Attempt RPC transport
    if (this.rpcTransport && typeof this.rpcTransport.sendChatCommand === 'function') {
      try {
        const rpcRes = await this.rpcTransport.sendChatCommand(sessionId, normalizedPayload, options);
        if (rpcRes && rpcRes.ok !== false) {
          const entry = {
            ok: true,
            sessionId,
            transportUsed: 'rpc',
            fallbackUsed: false,
            payload: normalizedPayload,
            response: rpcRes
          };
          this.dispatchLog.push(entry);
          return entry;
        }
      } catch {}
    }

    // 2. Attempt CDP OOPIF bridge transport (gated by experimental setting & unfocused chat input guard)
    const cdpGate = this.isCdpActuationAllowed(normalizedPayload, options);
    if (cdpGate.allowed && this.cdpTransport && typeof this.cdpTransport.sendChatCommand === 'function') {
      try {
        const cdpRes = await this.cdpTransport.sendChatCommand(sessionId, normalizedPayload, options);
        if (cdpRes && cdpRes.ok !== false) {
          const entry = {
            ok: true,
            sessionId,
            transportUsed: 'cdp',
            fallbackUsed: false,
            payload: normalizedPayload,
            response: cdpRes
          };
          this.dispatchLog.push(entry);
          return entry;
        }
      } catch {}
    } else if (!cdpGate.allowed && normalizedPayload.type === 'SET_MODEL_AND_EFFORT') {
      const blockedEntry = {
        ok: false,
        sessionId,
        transportUsed: 'blocked_cdp',
        cdpBlockedReason: cdpGate.reason,
        fallbackUsed: false,
        payload: normalizedPayload
      };
      this.dispatchLog.push(blockedEntry);
      return blockedEntry;
    }

    // 3. Fallback to clipboard ONLY if both RPC and CDP are unreachable
    this.clipboardWriter(promptText);
    const fallbackEntry = {
      ok: true,
      sessionId,
      transportUsed: 'clipboard',
      cdpBlockedReason: cdpGate.allowed ? null : cdpGate.reason,
      fallbackUsed: true,
      clipboardText: promptText,
      payload: normalizedPayload
    };
    this.dispatchLog.push(fallbackEntry);
    return fallbackEntry;
  }

  /**
   * Pauses or halts active LLM generation (e.g., when a DET-01..16 circuit breaker trips).
   */
  async pauseActiveGeneration(sessionId, options = {}) {
    const reason = String(options.reason || 'CIRCUIT_BREAKER_HALT');

    if (this.rpcTransport && typeof this.rpcTransport.pauseActiveGeneration === 'function') {
      try {
        const rpcRes = await this.rpcTransport.pauseActiveGeneration(sessionId, { reason, ...options });
        if (rpcRes && rpcRes.ok !== false) {
          return {
            ok: true,
            sessionId,
            transportUsed: 'rpc',
            fallbackUsed: false,
            reason,
            response: rpcRes
          };
        }
      } catch {}
    }

    if (this.cdpTransport && typeof this.cdpTransport.pauseActiveGeneration === 'function') {
      try {
        const cdpRes = await this.cdpTransport.pauseActiveGeneration(sessionId, { reason, ...options });
        if (cdpRes && cdpRes.ok !== false) {
          return {
            ok: true,
            sessionId,
            transportUsed: 'cdp',
            fallbackUsed: false,
            reason,
            response: cdpRes
          };
        }
      } catch {}
    }

    return {
      ok: true,
      sessionId,
      transportUsed: 'sidecar_signal',
      fallbackUsed: true,
      reason
    };
  }

  /**
   * Spawns a clean Antigravity session and pre-seeds `~/.gemini/antigravity/brain/<NEW_GUID>/`
   * with `implementation_plan.md` and `task.md` so the new agent starts with zero amnesia.
   */
  async spawnCleanSession(initialBrainState = {}, options = {}) {
    const newSessionId = String(initialBrainState.sessionId || options.sessionId || crypto.randomUUID());
    const surface = String(initialBrainState.surface || options.surface || 'antigravity');
    const brainDir = options.brainDir || path.join(this.homeDir, '.gemini', surface, 'brain', newSessionId);

    fs.mkdirSync(path.join(brainDir, '.system_generated', 'logs'), { recursive: true });

    const taskMdPath = path.join(brainDir, 'task.md');
    const planMdPath = path.join(brainDir, 'implementation_plan.md');

    const taskContent = String(
      initialBrainState.taskMd ||
      initialBrainState.taskContent ||
      `# Task Checkpoint (Seeded via Baton Pass)\n\n- [/] Resume from Baton Pass handoff\n`
    );
    const planContent = String(
      initialBrainState.implementationPlanMd ||
      initialBrainState.planContent ||
      `# Implementation Plan (Seeded via Baton Pass)\n\nSeeded from prior session handoff.\n`
    );

    atomicWriteFileSync(taskMdPath, taskContent, { encoding: 'utf8' });
    atomicWriteFileSync(planMdPath, planContent, { encoding: 'utf8' });

    if (initialBrainState.handoffMd) {
      atomicWriteFileSync(path.join(brainDir, 'HANDOFF.md'), String(initialBrainState.handoffMd), { encoding: 'utf8' });
    }

    let transportUsed = 'filesystem_seed';
    let fallbackUsed = false;

    if (this.rpcTransport && typeof this.rpcTransport.spawnCleanSession === 'function') {
      try {
        const res = await this.rpcTransport.spawnCleanSession(newSessionId, { brainDir, ...initialBrainState });
        if (res && res.ok !== false) {
          transportUsed = 'rpc';
        }
      } catch {}
    } else if (this.cdpTransport && typeof this.cdpTransport.spawnCleanSession === 'function') {
      try {
        const res = await this.cdpTransport.spawnCleanSession(newSessionId, { brainDir, ...initialBrainState });
        if (res && res.ok !== false) {
          transportUsed = 'cdp';
        }
      } catch {}
    } else if (initialBrainState.bootstrapPrompt) {
      this.clipboardWriter(initialBrainState.bootstrapPrompt);
      fallbackUsed = true;
    }

    return {
      ok: true,
      sessionId: newSessionId,
      brainDir,
      taskMdPath,
      planMdPath,
      transportUsed,
      fallbackUsed
    };
  }
}

export default AgBridgeService;
