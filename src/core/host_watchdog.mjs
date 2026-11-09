import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Host Process & Zombie Subagent/MCP Watchdog.
 *
 * Polls the OS process table (memoized for 10s) to detect:
 * 1. Orphaned `language_server*` processes spawned with `multicall schedule`
 *    or detached from exited parent IDE processes.
 * 2. Orphaned `mcp-server*` stdio processes.
 * 3. Total language_server + MCP RSS memory spikes (> 4.0 GB warning threshold).
 */

export const HOST_WATCHDOG_LIMITS = Object.freeze({
  POLL_TTL_MS: 10000,
  WARNING_ORPHAN_COUNT: 3,
  WARNING_RSS_GB: 4.0
});

let lastPollMs = 0;
let cachedHostHealth = null;

function execCommandSafe(file, args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve('');
        resolve(String(stdout || ''));
      });
    } catch {
      resolve('');
    }
  });
}

/**
 * Parses a raw list of OS process records into host health & orphan diagnostics.
 * Exported as a pure function so unit tests can verify orphan detection deterministically.
 */
export function evaluateProcessTable(processRecords = [], activePids = new Set()) {
  const allPidSet = new Set(processRecords.map(p => Number(p.pid)));
  for (const pid of activePids) allPidSet.add(Number(pid));

  let totalRelevantRssBytes = 0;
  const orphans = [];
  let languageServerCount = 0;

  for (const proc of processRecords) {
    const pid = Number(proc.pid || 0);
    const ppid = Number(proc.ppid || 0);
    const name = String(proc.name || '').toLowerCase();
    const cmd = String(proc.commandLine || '').toLowerCase();
    const rssBytes = Number(proc.rssBytes || 0);

    const isAgyHub = (name.includes('agy') || cmd.includes('agy')) && cmd.includes('--hub');
    const isLangServer = name.includes('language_server') || cmd.includes('language_server') || isAgyHub;
    const isMcpServer = cmd.includes('mcp-server') || cmd.includes('@modelcontextprotocol') || name.includes('mcp');

    if (!isLangServer && !isMcpServer) continue;

    totalRelevantRssBytes += rssBytes;
    if (isLangServer) languageServerCount++;

    const isMulticallSchedule = cmd.includes('multicall') && cmd.includes('schedule');
    const parentDead = ppid > 0 && allPidSet.size >= 2 && !allPidSet.has(ppid);

    let scheduleDetails = '';
    if (isMulticallSchedule) {
      const wsMatch = cmd.match(/--workspace\s+([^\s"']+)/i);
      const scriptMatch = cmd.match(/schedule\s+"[^"]*"\s+([^\s"']+)/i);
      const wsName = wsMatch ? path.basename(wsMatch[1].replace(/\\/g, '/')) : '';
      const scriptName = scriptMatch ? path.basename(scriptMatch[1].replace(/\\/g, '/')) : '';
      scheduleDetails = wsName ? `[${wsName}] ${scriptName || 'cron'}` : (scriptName || 'scheduled task');
    }

    if ((isMulticallSchedule || parentDead) && pid !== process.pid && pid !== process.ppid) {
      orphans.push({
        pid,
        ppid,
        name: proc.name || (isAgyHub ? 'agy' : (isLangServer ? 'language_server' : 'mcp-server')),
        reason: isMulticallSchedule ? (parentDead ? 'multicall_schedule_leak' : 'active_scheduled_task') : 'detached_parent_pid',
        scheduleDetails,
        parentAlive: !parentDead,
        rssMb: Math.round(rssBytes / (1024 * 1024))
      });
    }
  }

  const hostRssGb = parseFloat((totalRelevantRssBytes / (1024 ** 3)).toFixed(2));
  const orphanCount = orphans.length;
  const isAlert = orphanCount > HOST_WATCHDOG_LIMITS.WARNING_ORPHAN_COUNT || hostRssGb >= HOST_WATCHDOG_LIMITS.WARNING_RSS_GB;

  return {
    rssGb: hostRssGb,
    languageServerCount,
    orphanCount,
    orphans,
    status: isAlert ? (orphanCount > HOST_WATCHDOG_LIMITS.WARNING_ORPHAN_COUNT ? 'ZOMBIE_LEAK' : 'HIGH_RAM') : 'HEALTHY',
    alertBanner: isAlert
      ? `Host Process Alert: ${orphanCount} orphaned language_server/MCP processes (${hostRssGb} GB RAM)`
      : null,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Polls the live OS process table (Windows CIM / tasklist or POSIX ps) with a 10s cache.
 */
export async function inspectHostProcesses({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedHostHealth && (now - lastPollMs) < HOST_WATCHDOG_LIMITS.POLL_TTL_MS) {
    return cachedHostHealth;
  }

  const records = [];
  if (os.platform() === 'win32') {
    const psScript = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress';
    const out = await execCommandSafe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], 2500);
    if (out) {
      try {
        const parsed = JSON.parse(out);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of arr) {
          if (!item) continue;
          records.push({
            pid: Number(item.ProcessId || 0),
            ppid: Number(item.ParentProcessId || 0),
            name: String(item.Name || ''),
            rssBytes: Number(item.WorkingSetSize || 0),
            commandLine: String(item.CommandLine || '')
          });
        }
      } catch {}
    }
  } else {
    const out = await execCommandSafe('ps', ['-eo', 'pid,ppid,rss,comm,args'], 2000);
    for (const line of out.split(/\r?\n/).slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (m) {
        records.push({
          pid: Number(m[1]),
          ppid: Number(m[2]),
          rssBytes: Number(m[3]) * 1024,
          name: m[4],
          commandLine: m[5]
        });
      }
    }
  }

  try {
    cachedHostHealth = evaluateProcessTable(records);
  } catch {
    cachedHostHealth = {
      rssGb: 0,
      languageServerCount: 0,
      orphanCount: 0,
      orphans: [],
      status: 'HEALTHY',
      alertBanner: null,
      checkedAt: new Date().toISOString()
    };
  }
  lastPollMs = now;
  return cachedHostHealth;
}

/**
 * Safely terminates verified orphan PIDs (restricted strictly to language_server/MCP orphans).
 */
export async function reapOrphanProcesses(explicitPids = null) {
  const currentHealth = await inspectHostProcesses({ force: true });
  const allowedOrphanMap = new Map(currentHealth.orphans.map(o => [o.pid, o]));
  const targets = Array.isArray(explicitPids) && explicitPids.length > 0
    ? explicitPids.map(Number).filter(pid => allowedOrphanMap.has(pid))
    : Array.from(allowedOrphanMap.keys());

  const reaped = [];
  for (const pid of targets) {
    if (pid <= 0 || pid === process.pid || pid === process.ppid) continue;
    try {
      process.kill(pid, 'SIGTERM');
      reaped.push(pid);
    } catch {}
  }

  const nextHealth = await inspectHostProcesses({ force: true });
  return {
    success: true,
    reapedCount: reaped.length,
    reapedPids: reaped,
    hostHealth: nextHealth
  };
}
