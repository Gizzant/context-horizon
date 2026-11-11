import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * Phase 3.3: Live Subagent Phantom Burn Auditor & Orphan Process Killer
 * (`src/core/coach/subagent_phantom_auditor.mjs`)
 *
 * - Monitors active subagent trajectories (`browser_subagent`, task workers) and counts
 *   DOM screenshot / image payload blocks.
 * - Renders a live pill in the Coach Bar whenever subagents run:
 *   `⚡ 1 Subagent: browser_subagent (4 turns • 3 screenshots • 41.2k tokens) [Kill]`
 * - Orphan Process Scanner & Killer: Detects orphaned headless Chrome / `browser_subagent`
 *   processes or hung `Pyrefly` LSP child processes after a turn ends or is canceled,
 *   allowing 1-click clean OS termination (`process.kill(pid, 'SIGTERM')`).
 * - Vision HTTP 400 Overage Guard (`DET-15`): Polls `agy --hub GetUserStatus` (or parses
 *   status payload). If primary quota hits `100%` and Google One AI Credit Overages are
 *   active, displays a high-visibility attachment warning before image submission.
 */

export const SCREENSHOT_ESTIMATED_TOKENS = 4800;

function countScreenshotsInStep(step = {}) {
  let count = 0;
  if (Array.isArray(step.media)) {
    count += step.media.filter((m) => String(m?.mime_type || m?.mimeType || '').startsWith('image/')).length;
  }
  const calls = Array.isArray(step.toolCalls)
    ? step.toolCalls
    : (Array.isArray(step.tool_calls) ? step.tool_calls : []);
  for (const call of calls) {
    const name = String(call.name || call.tool || '').toLowerCase();
    if (name.includes('screenshot') || name === 'take_screenshot' || name === 'capture_screenshot') {
      count++;
    }
  }
  if (step.hasScreenshot === true || step.screenshot === true) {
    count = Math.max(1, count);
  }
  return count;
}

/**
 * Audits active or recent subagent trajectories and generates the Coach Bar live pill.
 */
export function auditSubagentPhantomBurn(subagents = []) {
  const startMs = performance.now();
  const list = Array.isArray(subagents) ? subagents : [];
  const audited = [];

  for (const sub of list) {
    const name = String(sub.name || sub.typeName || sub.role || 'browser_subagent').trim();
    const steps = Array.isArray(sub.steps) ? sub.steps : [];
    const turnCount = Number.isFinite(Number(sub.turns ?? sub.turnCount))
      ? Number(sub.turns ?? sub.turnCount)
      : steps.length;

    let screenshotCount = Number.isFinite(Number(sub.screenshots ?? sub.screenshotCount))
      ? Number(sub.screenshots ?? sub.screenshotCount)
      : 0;
    if (!Number.isFinite(Number(sub.screenshots ?? sub.screenshotCount))) {
      for (const s of steps) {
        screenshotCount += countScreenshotsInStep(s);
      }
    }

    let totalTokens = Number(sub.tokens ?? sub.totalTokens ?? 0);
    if (!totalTokens && steps.length > 0) {
      for (const s of steps) {
        totalTokens += Number(s.tokens ?? s.outputTokens ?? 1200);
      }
      totalTokens += screenshotCount * SCREENSHOT_ESTIMATED_TOKENS;
    }

    const tokK = (totalTokens / 1000).toFixed(1);
    const pill = `⚡ 1 Subagent: ${name} (${turnCount} turns • ${screenshotCount} screenshots • ${tokK}k tokens) [Kill]`;

    audited.push({
      id: sub.id || sub.conversationId || `sub-${audited.length + 1}`,
      pid: sub.pid || null,
      name,
      turnCount,
      screenshotCount,
      totalTokens,
      active: sub.active !== false,
      pill
    });
  }

  const activeList = audited.filter((a) => a.active);
  const topActive = activeList[0] || audited[0] || null;

  const summaryPill = topActive
    ? (activeList.length > 1
      ? `⚡ ${activeList.length} Subagents: ${topActive.name} (${topActive.turnCount} turns • ${topActive.screenshotCount} screenshots • ${(topActive.totalTokens / 1000).toFixed(1)}k tokens) [Kill]`
      : topActive.pill)
    : null;

  return {
    activeCount: activeList.length,
    subagents: audited,
    coachBarPill: summaryPill,
    elapsedMs: Number((performance.now() - startMs).toFixed(3))
  };
}

/**
 * Scans OS process records for orphaned headless Chrome / `browser_subagent` processes
 * or hung `Pyrefly` LSP child processes after a turn ends or is canceled.
 */
export function scanOrphanSubagentAndLspProcesses(processRecords = [], {
  turnActive = false,
  knownParentPids = new Set()
} = {}) {
  const list = Array.isArray(processRecords) ? processRecords : [];
  const allPids = new Set(list.map((p) => Number(p.pid)));
  for (const p of knownParentPids) allPids.add(Number(p));

  const orphans = [];

  for (const proc of list) {
    const pid = Number(proc.pid || 0);
    const ppid = Number(proc.ppid || 0);
    if (!pid || pid === process.pid) continue;

    const name = String(proc.name || '').toLowerCase();
    const cmd = String(proc.commandLine || '').toLowerCase();

    const isHeadlessChromeOrBrowserSubagent =
      cmd.includes('browser_subagent') ||
      ((name.includes('chrome') || name.includes('chromium')) &&
        (cmd.includes('--headless') || cmd.includes('--remote-debugging-port')));

    const isPyreflyLsp =
      name.includes('pyrefly') ||
      cmd.includes('pyrefly');

    if (!isHeadlessChromeOrBrowserSubagent && !isPyreflyLsp) {
      continue;
    }

    const parentDead = ppid > 0 && allPids.size > 1 && !allPids.has(ppid);
    const hungAfterTurnEnd = !turnActive && (proc.turnEnded === true || isHeadlessChromeOrBrowserSubagent || parentDead);

    if (parentDead || hungAfterTurnEnd || proc.hung === true) {
      orphans.push({
        pid,
        ppid,
        kind: isPyreflyLsp ? 'PYREFLY_LSP' : 'BROWSER_SUBAGENT_CHROME',
        name: proc.name || (isPyreflyLsp ? 'pyrefly' : 'chrome --headless'),
        reason: parentDead ? 'ORPHANED_PARENT_EXITED' : 'HUNG_AFTER_TURN_END'
      });
    }
  }

  return {
    orphanCount: orphans.length,
    orphans
  };
}

/**
 * Terminates an orphaned subagent or hung LSP process cleanly via `SIGTERM`.
 */
export function killOrphanProcess(pid, { killFn = process.kill } = {}) {
  const targetPid = Number(pid);
  if (!Number.isFinite(targetPid) || targetPid <= 0 || targetPid === process.pid) {
    return { ok: false, pid: targetPid, error: 'INVALID_PID' };
  }
  try {
    killFn(targetPid, 'SIGTERM');
    return { ok: true, pid: targetPid, signal: 'SIGTERM' };
  } catch (err) {
    return { ok: false, pid: targetPid, error: err.message };
  }
}

/**
 * Vision HTTP 400 Overage Guard (`DET-15`)
 * Evaluates user quota status from `agy --hub GetUserStatus` (or status payload).
 * When primary quota hits `100%` and Google One AI Credit Overages are active,
 * triggers a high-visibility attachment warning before the user submits an image.
 */
export function evaluateVisionOverageGuard(userStatus = {}) {
  const primaryQuotaUsedPct = Number(
    userStatus.primaryQuotaUsedPct ??
    userStatus.quotaUsedPct ??
    userStatus.primaryPoolPct ??
    0
  );
  const aiCreditOveragesActive = Boolean(
    userStatus.googleOneAiCreditOveragesActive ??
    userStatus.aiCreditOveragesActive ??
    userStatus.overagesEnabled ??
    false
  );

  const triggered = primaryQuotaUsedPct >= 100 && aiCreditOveragesActive;

  return {
    detectorId: 'DET-28',
    triggered,
    primaryQuotaUsedPct,
    aiCreditOveragesActive,
    warningBanner: triggered
      ? '⚠️ DET-28 Vision HTTP 400 Guard: Primary quota is at 100% (Google One AI Credit Overages active). Remove image attachments or switch to text-only before submitting to prevent platform HTTP 400 crash.'
      : null
  };
}

export function pollAgyUserStatus({ execFileFn = execFile, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFileFn('agy', ['--hub', 'GetUserStatus'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) {
          return resolve(evaluateVisionOverageGuard({ primaryQuotaUsedPct: 0, aiCreditOveragesActive: false }));
        }
        try {
          const parsed = JSON.parse(String(stdout));
          return resolve(evaluateVisionOverageGuard(parsed));
        } catch {
          const pctMatch = String(stdout).match(/(\d+(?:\.\d+)?)%/);
          const overageMatch = /overage|ai\s+credit/i.test(String(stdout));
          return resolve(evaluateVisionOverageGuard({
            primaryQuotaUsedPct: pctMatch ? Number(pctMatch[1]) : 0,
            aiCreditOveragesActive: overageMatch
          }));
        }
      });
    } catch {
      resolve(evaluateVisionOverageGuard({ primaryQuotaUsedPct: 0, aiCreditOveragesActive: false }));
    }
  });
}

export class SubagentPhantomAuditor {
  constructor(options = {}) {
    this.killFn = options.killFn || process.kill;
  }

  auditTrajectories(subagents = []) {
    return auditSubagentPhantomBurn(subagents);
  }

  scanOrphans(processRecords = [], options = {}) {
    return scanOrphanSubagentAndLspProcesses(processRecords, options);
  }

  killOrphan(pid) {
    return killOrphanProcess(pid, { killFn: this.killFn });
  }

  checkVisionOverage(userStatus = {}) {
    return evaluateVisionOverageGuard(userStatus);
  }
}

export default SubagentPhantomAuditor;
