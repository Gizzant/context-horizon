/**
 * @file src/core-isomorphic/catalog/safeguardGuide.mjs
 * Plain-English (grade 10-11) guidance for every Highbeam safeguard and learned rule.
 *
 * Every safeguard is either:
 *   - "action"  -> something the developer should look at or do (what happened + what to do + what to avoid)
 *   - "info"    -> handled automatically; no action needed
 *
 * Pure JS / ESM with strictly 0 node:* imports (isomorphic: daemon, CLI, and webview-safe).
 */

/** Returns the last path segment of a Windows or POSIX path (never truncates mid-word). */
export function safeBaseName(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const parts = s.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/** Strips emoji / pictographs and collapses whitespace so mono-tag rows stay clean. */
export function stripEmoji(text) {
  return String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const g = (title, kind, issue, doText, avoidText) =>
  Object.freeze({ title, kind, issue, doText, avoidText });

/**
 * Guide for the canonical DET-01..DET-32 catalog (what the guard watches).
 * `{file}` is replaced with a clean file name when one is known.
 */
export const SAFEGUARD_GUIDE = Object.freeze({
  'DET-01': g(
    'Unsafe Git or shell command blocked', 'action',
    'The AI tried to run a command that can destroy work, such as git reset --hard, push --force, --no-verify, or rm -rf.',
    'Read the command in chat. Run it yourself only if you really want to overwrite work.',
    'Avoid letting the AI force-push or bypass Git hooks without checking first.'
  ),
  'DET-02': g(
    'Secret or .env file protected', 'action',
    'Highbeam stopped a read or paste of credentials (.env files, SSH keys, API tokens) so secrets stay out of the chat.',
    'Use a placeholder or .env.example instead. If a real key was pasted into chat, replace that key.',
    'Avoid pasting real keys or tokens into the chat.'
  ),
  'DET-03': g(
    'Lockfile or migration changed', 'action',
    '{file} is a package lockfile or database migration, and it changed.',
    'Check that you meant to update dependencies or the database. If not, undo it with git checkout -- "{file}".',
    'Avoid committing lockfile or migration changes you did not ask for.'
  ),
  'DET-04': g(
    'Same command failed 3 times', 'action',
    'The AI ran the same failing command three times in a row without changing its approach.',
    'Read the first error message and point the AI at the real cause, or switch to a stronger model.',
    'Avoid letting the AI keep retrying the same command.'
  ),
  'DET-05': g(
    'Big deletion, weaker tests, or edit loop', 'action',
    'The AI deleted a large part of {file}, removed test checks, or kept flipping between two versions.',
    'Run git diff -- "{file}" and make sure no real code or test checks were removed just to make tests pass.',
    'Avoid accepting more edits until you know what was removed.'
  ),
  'DET-06': g(
    'File read again or edited before reading', 'action',
    'The AI re-read {file} when nothing changed, or edited a file it had not read first.',
    'Ask the AI to read the file in small line ranges (StartLine and EndLine) before it edits.',
    'Avoid letting the AI edit files it has not read.'
  ),
  'DET-07': g(
    'Long command output trimmed', 'info',
    'A very long terminal log was shortened to its errors and summary. The full log is saved on disk.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-08': g(
    'Model switch held while cache is warm', 'info',
    'Switching models now would cost more because your prompt cache is still discounted. Highbeam waits for the cache to cool.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-09': g(
    'Rule file change queued', 'info',
    'A non-urgent edit to AGENTS.md, CLAUDE.md, or .mcp.json is waiting so it does not erase your cache discount.',
    'No action needed. It will be applied after the cache timer ends or after /compact.',
    'Nothing to avoid.'
  ),
  'DET-10': g(
    'Idle cache timer check', 'info',
    'Highbeam saves a short progress summary before your 5-minute prompt cache runs out while you are idle.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-11': g(
    'Old file copies or a missing file path', 'action',
    'Old copies of edited files are filling memory, or the AI mentioned a file that does not exist.',
    'Check that the file path is real, or run /compact to clear old copies.',
    'Avoid trusting file names the AI mentions without checking them.'
  ),
  'DET-12': g(
    'Near a pricing jump or stuck background process', 'action',
    'Context is close to 98,000 tokens, where pricing jumps on this model, or a background process is still running.',
    'Run /compact before your next message, and stop any background process you do not need.',
    'Avoid sending large new files into chat right now.'
  ),
  'DET-13': g(
    'Unused tools load at the start of every chat', 'action',
    'Connected MCP servers add large tool lists to every turn, even when you do not use them.',
    'Set unused MCP servers to load only when needed, or turn them off for this project.',
    'Avoid keeping MCP servers on that you do not use.'
  ),
  'DET-14': g(
    'Code changed without running tests', 'action',
    'Source files were edited, but the tests have not been run to check the change.',
    'Ask the AI to run your test command before it finishes or you commit.',
    'Avoid committing changes that have not been tested.'
  ),
  'DET-15': g(
    'Unfinished TODO left in code', 'action',
    'The AI left TODO notes or placeholder code in {file}.',
    'Open {file} and ask the AI to finish any unfinished parts.',
    'Avoid committing placeholder code.'
  ),
  'DET-16': g(
    'Helper agents limited to save quota', 'info',
    'Highbeam limited how many helper agents run at once because your quota use passed 80%.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-17': g(
    'Waiting for edits to finish before suggesting /compact', 'info',
    'Highbeam is holding back compact suggestions until your current multi-file edit is done.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-18': g(
    'Unsafe editor or hook setting blocked', 'action',
    'An edit to {file} tried to turn on auto-approval or run remote shell commands.',
    'Open {file} and reject any change you did not ask for.',
    'Avoid approving changes to settings or hook files you have not read.'
  ),
  'DET-19': g(
    'Hidden characters removed from helper text', 'info',
    'Invisible control characters were removed from outside text before they could steer the AI.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-20': g(
    'Two agents editing the same file, or quota full', 'action',
    'More than one AI agent tried to edit {file} at the same time, or your 5-hour quota is used up.',
    'Let one agent finish before the next one edits {file}, or give each agent its own files.',
    'Avoid running parallel agents on the same file.'
  ),
  'DET-21': Object.freeze({
    title: 'Deprecated alias of the thinking-loop guard', kind: 'info', hidden: true,
    issue: 'Old name for the thinking-loop guard.', doText: 'No action needed.', avoidText: 'Nothing to avoid.'
  }),
  'DET-22': g(
    'Repeated back-and-forth edits', 'action',
    'The AI undid and redid changes in {file} over the last few turns.',
    'Run git diff -- "{file}" to see what changed, then give the AI one clear goal.',
    'Avoid giving the AI conflicting instructions for the same file.'
  ),
  'DET-23': g(
    'Errors may be hidden in {file}', 'action',
    'The last edit to {file} added an empty catch block or a linter-ignore comment, or removed error handling. That can hide crashes.',
    'Run git diff -- "{file}" and check that errors are still logged or handled. If the AI only moved error handling into a helper, you can keep going.',
    'Avoid approving more changes until you know no error handling was lost.'
  ),
  'DET-24': g(
    'Long chat may be less accurate', 'action',
    'Chats over 30 turns collect old instructions that can make the AI less accurate.',
    'Save your progress to task.md, then run /compact at your next stopping point.',
    'Avoid starting a new, unrelated task in this same long chat.'
  ),
  'DET-25': g(
    'Progress snapshot saved', 'info',
    'Your context passed 70,000 tokens, so Highbeam saved a recovery snapshot in the background.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-26': g(
    'Prompt asks for many things at once', 'action',
    'Asking for four or more separate goals in one message raises the chance the AI misses one.',
    'Split the work into steps, or use /plan so each part is checked off in order.',
    'Avoid bundling unrelated changes into one prompt.'
  ),
  'DET-27': g(
    'Startup rule file is large', 'action',
    'Your AGENTS.md or CLAUDE.md is over 8,000 tokens, which uses up memory on every turn.',
    'Move topic-specific rules into on-demand skills (try /evolve) so only core rules load every time.',
    'Avoid adding long, rarely used rules to the startup file.'
  ),
  'DET-28': g(
    'Background agent running a long time', 'action',
    'A helper agent or tool server has been running unattended for over 5 minutes.',
    'Check whether it is stuck, and stop it if you no longer need it.',
    'Avoid leaving unused background processes running.'
  ),
  'DET-29': g(
    'Saved learnings applied between turns', 'info',
    'Highbeam applied pending warnings and learned rules between turns.',
    'No action needed.',
    'Nothing to avoid.'
  ),
  'DET-30': g(
    'AI is thinking without making progress', 'action',
    'For two or more turns the AI used thousands of thinking tokens without changing any code.',
    'Stop and narrow the request. Name the exact file and function to change.',
    'Avoid sending vague follow-ups like "keep going".'
  ),
  'DET-31': g(
    'Merge conflict between parallel branches', 'action',
    'Parallel agent branches changed overlapping lines, so they will conflict when merged.',
    'Merge or rebase one branch first, then let the other agent continue.',
    'Avoid letting two branches edit the same lines.'
  ),
  'DET-32': g(
    'AI drifted from your task.md rules', 'action',
    'Recent edits go against a rule in task.md, or repeat an idea that already failed.',
    'Compare the AI\'s last step with task.md and remind it of the rule it missed.',
    'Avoid approving steps that break your written rules.'
  )
});

/**
 * Guide for live CircuitBreakers alerts. Their IDs use the live numbering
 * (e.g. DET-03 here means "test checks removed"), so they are keyed separately.
 */
export const CIRCUIT_ALERT_GUIDE = Object.freeze({
  'DET-01': g(
    'Same command keeps failing', 'action',
    'The AI ran a failing command several times in a row.',
    'Read the first error message and point the AI at the real cause, or switch to a stronger model.',
    'Avoid letting the AI retry the exact same command.'
  ),
  'DET-02': g(
    'Edits are going back and forth in {file}', 'action',
    '{file} returned to a version it had a few turns ago.',
    'Run git diff -- "{file}" and give the AI one clear goal for this file.',
    'Avoid giving the AI conflicting instructions for the same file.'
  ),
  'DET-03': g(
    'Test checks were removed from {file}', 'action',
    'Some assert or expect lines were deleted from {file}. Tests may pass only because the checks are gone.',
    'Run git diff -- "{file}" and restore any test checks that were removed.',
    'Avoid accepting passing tests until you know the checks are still there.'
  ),
  'DET-18': SAFEGUARD_GUIDE['DET-18'],
  'DET-20': SAFEGUARD_GUIDE['DET-20'],
  'DET-21': g(
    'File edited before it was read', 'action',
    'The AI changed or created {file} without reading or searching the project first.',
    'Ask the AI to read {file} (or search the project) before it makes more edits.',
    'Avoid letting the AI edit files it has not read.'
  ),
  'DET-22': g(
    'Large part of {file} was deleted', 'action',
    'More than half of {file} was removed in one edit, and you did not ask for that.',
    'Run git diff -- "{file}" to see what was removed, and restore anything needed.',
    'Avoid approving more edits until you know what was lost.'
  ),
  'DET-23': SAFEGUARD_GUIDE['DET-23'],
  'DET-30': SAFEGUARD_GUIDE['DET-30']
});

const fillFile = (text, file) => String(text || '').replace(/\{file\}/g, file || 'this file');

/**
 * Builds display-ready guidance for a safeguard.
 * @param {string} id        Detector id (e.g. 'DET-23').
 * @param {object} [ctx]
 * @param {string} [ctx.file]   Full or partial file path; only the file name is shown.
 * @param {boolean} [ctx.live]  true = use live-alert guide (CircuitBreakers numbering).
 */
export function formatSafeguardGuidance(id, ctx = {}) {
  const key = String(id || '').trim().toUpperCase();
  const guide = (ctx.live ? CIRCUIT_ALERT_GUIDE[key] : null) || SAFEGUARD_GUIDE[key] || null;
  const file = safeBaseName(ctx.file);
  if (!guide) {
    return {
      id: key || 'DET',
      title: 'Highbeam safeguard triggered',
      kind: 'action',
      issue: 'A safeguard flagged the most recent step.',
      doText: 'Review the AI\'s last step before approving more work.',
      avoidText: 'Avoid approving follow-up changes until you have checked it.',
      file
    };
  }
  return {
    id: key,
    title: fillFile(guide.title, file),
    kind: guide.kind,
    issue: fillFile(guide.issue, file),
    doText: fillFile(guide.doText, file),
    avoidText: fillFile(guide.avoidText, file),
    file
  };
}

/** Guidance for a live CircuitBreakers (or daemon) alert object. */
export function getAlertGuidance(alert = {}) {
  return formatSafeguardGuidance(alert.detectorId || alert.id, { live: true, file: alert.filePath || alert.file });
}

/** Short plain-English summary of every canonical guard (for roster tooltips). */
export function getGuardSummary(id) {
  const guide = SAFEGUARD_GUIDE[String(id || '').toUpperCase()];
  if (!guide) return null;
  return { title: guide.title.replace(/\{file\}/g, 'a file'), kind: guide.kind, summary: guide.issue.replace(/\{file\}/g, 'a file') };
}

/**
 * Maps live CircuitBreakers alert ids onto canonical catalog ids so the roster marks the right guard as tripped.
 */
export function canonicalGuardIdForAlert(alert = {}) {
  const id = String(alert.detectorId || alert.id || '').toUpperCase();
  if (id === 'DET-01') return 'DET-04';
  if (id === 'DET-02' || id === 'DET-03') return 'DET-05';
  if (id === 'DET-21') return 'DET-06';
  return id;
}

/**
 * Keeps only breaker alerts that are still fresh: raised after the last /compact (or checkpoint)
 * and no more than `maxUserTurns` user messages ago. Alerts without a turnIndex are kept.
 * When no steps are available, every alert is kept.
 */
export function filterFreshAlerts(alerts = [], steps = [], { maxUserTurns = 1 } = {}) {
  const list = Array.isArray(alerts) ? alerts : [];
  const stepsArr = Array.isArray(steps) ? steps : [];
  if (stepsArr.length === 0) return [...list];
  let lastCompactIdx = -1;
  const userIdxs = [];
  stepsArr.forEach((st, i) => {
    const idx = Number.isFinite(st?.stepIndex) ? st.stepIndex : i;
    if (st?.type === 'USER_INPUT' || st?.source === 'USER_EXPLICIT') {
      userIdxs.push(idx);
      if (/^\/compact\b/i.test(String(st.content || '').trim())) lastCompactIdx = Math.max(lastCompactIdx, idx);
    }
    if (st?.type === 'CHECKPOINT') lastCompactIdx = Math.max(lastCompactIdx, idx);
  });
  return list.filter((a) => {
    const t = Number(a?.turnIndex);
    if (!Number.isFinite(t)) return true;
    if (t <= lastCompactIdx) return false;
    return userIdxs.filter((u) => u > t).length <= maxUserTurns;
  });
}

// ---------------------------------------------------------------------------
// Learned rules (RSL) — plain-English summaries
// ---------------------------------------------------------------------------

const clip = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
};

/**
 * Turns a raw learned-rule ledger item into a short, readable row.
 * @returns {{kind:'hook'|'skill'|'rule', title:string, detail:string, status:string}}
 */
export function humanizeLearnedRule(item = {}) {
  const carrier = String(item.carrier || '');
  const isHook = item.promotedHook === true || carrier === 'pre_tool_hook';
  const isSkill = carrier === 'skill_workflow';
  const kind = isHook ? 'hook' : (isSkill ? 'skill' : 'rule');
  const desc = String(item.description || '');
  const when = String(item.when_condition || '');
  const then = String(item.then_guidance || '');
  const slug = String(item.slug || '').replace(/-[0-9a-f]{6}$/i, '').replace(/[-_]+/g, ' ').trim();

  let title = '';
  let detail = '';

  if (isSkill) {
    const steps = Array.isArray(item.steps) ? item.steps.length : 0;
    const target = (desc.match(/recovery workflow for (.+?)\.\s*Do not/i) || [])[1] || '';
    const tool = (when.match(/after `([^`]+)` fails/i) || [])[1] || '';
    const msg = (when.match(/fails with "([^"]*)"/i) || [])[1] || '';
    const stepWord = steps > 0 ? `${steps}-step recovery` : 'Recovery';
    title = `${stepWord} for ${safeBaseName(target) || 'a repeated failure'}`;
    detail = tool
      ? `Used when ${tool} fails${msg ? ` ("${clip(msg, 60)}")` : ''}.`
      : clip(when || then, 110);
  } else {
    const target = (desc.match(/editing (.+?) affected by/i) || [])[1] || '';
    const isReview = /artifact review feedback/i.test(desc) || /^Enforce user artifact guidance/i.test(then);
    const thenClean = clip(
      then.replace(/^Enforce user artifact guidance:\s*/i, '').replace(/[|`*_]+/g, ' ').replace(/^[-\s]+/, ''),
      110
    );
    title = isReview
      ? `Review feedback rule for ${safeBaseName(target) || 'this project'}`
      : (clip(desc.replace(/^Use when\s+/i, '').replace(/\.\s*Do not.*$/i, ''), 70) || slug || 'Workspace rule');
    detail = thenClean || clip(when, 110);
  }

  return {
    kind,
    title: stripEmoji(title) || slug || 'Learned rule',
    detail: stripEmoji(detail),
    status: 'active'
  };
}
