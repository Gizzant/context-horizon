const { JSDOM } = require('C:/Users/frank/AppData/Local/Temp/node_modules/jsdom');
const fs = require('fs');
const html = fs.readFileSync('C:/Projects/ga-visualizer-v2/src/webview/horizon_panel.html', 'utf8');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

async function run() {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1/',
    beforeParse(w) {
      w.fetch = () => Promise.reject(new Error('no net'));
      w.EventSource = class { addEventListener() {} close() {} };
      w.navigator.clipboard = { writeText: async () => {} };
      w.addEventListener('error', e => errors.push(e.message));
    }
  });
  const w = dom.window; const d = w.document;

  // Test 1: Single file pluralization ("1 file" vs "files")
  const stateSingleFile = {
    sessionId: 's1', sessionTitle: 'Test Session',
    window: { totalActiveTokens: 60700, turnCount: 45 },
    breakdown: { STALE_DUPLICATE: 32300, DEAD_ERROR: 0 },
    metrics: { sludgeTokens: 32300 },
    brainSignals: {
      duplicateReads: {
        reclaimableTokens: 10000,
        topFiles: [{ path: 'C:/project/package-lock.json', occurrences: 3, wastedTokens: 10000 }]
      },
      oldHistory: { turnCount: 20, reclaimableTokens: 22300 },
      deadErrors: { errorCount: 0, reclaimableTokens: 0, isErrorLoop: false },
      blowupSteps: [],
      userCorrections: 0,
      activeSignal: { liveSessionTokens: 20000, taskMdSaved: true, taskMdTurnsBehind: 1 }
    },
    offenders: []
  };

  w.renderState(stateSingleFile);
  await new Promise(r => setTimeout(r, 50));
  const txt = id => (d.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();

  // 1. Text contrast & elements
  ok(!d.getElementById('plainContextNote'), 'plainContextNote removed from DOM');
  ok(!d.querySelector('.guided-steps'), 'guided-steps removed from DOM');
  ok(!d.querySelector('.safe-reassurance'), 'safe-reassurance removed from DOM');

  // Check titles and pluralization
  const diagName = d.querySelector('.diag-name')?.textContent || '';
  ok(/Repeated File Reads \(1 file\)/.test(diagName), 'singular pluralization in title: ' + diagName);
  
  const drawerSummary = d.querySelector('.diag-drawer-full summary')?.textContent || '';
  ok(/Inspect 1 file/.test(drawerSummary), 'singular in drawer summary: ' + drawerSummary);

  // Check footer alignment
  const actionsRow = d.querySelector('.diag-actions-row');
  ok(actionsRow, 'actionsRow present');
  ok(/Tell agent:|Prevent re-reads:/.test(actionsRow.textContent), 'action labels present: ' + actionsRow.textContent);
  const btns = actionsRow.querySelectorAll('button');

  // Check typed /compact instruction (no copy button) & footers row
  ok(!d.getElementById('btnCompactPrimary'), 'copy /compact button removed (no #btnCompactPrimary)');
  ok(typeof w.copyCompactWithGuidance === 'undefined', 'copyCompactWithGuidance handler removed');
  const instr = d.getElementById('compactInstruction');
  ok(instr && /Type \/compact in the chat box and press Enter/.test(txt('compactInstruction')), 'instruction text: ' + txt('compactInstruction'));
  ok(/reclaims up to ~32\.3k · keeps rules, (plan & code|task\.md & active summary) intact/.test(txt('compactReclaim')), 'reclaim value: ' + txt('compactReclaim'));
  ok(!/Ctrl\+V|Copy \/compact/i.test(instr.textContent), 'no copy/paste guidance in compactInstruction');

  const footersRow = d.querySelector('.action-footers-row');
  ok(footersRow, 'action-footers-row present');
  ok(footersRow.querySelector('#surviveDrawer') && footersRow.querySelector('#secondaryDrawer'), 'both drawers in footers row');

  // Test 2: Multiple files pluralization ("5 files")
  const stateMulti = JSON.parse(JSON.stringify(stateSingleFile));
  stateMulti.brainSignals.duplicateReads.topFiles = [
    { path: 'a.js', occurrences: 2, wastedTokens: 1000 },
    { path: 'b.js', occurrences: 2, wastedTokens: 1000 }
  ];
  w.renderState(stateMulti);
  await new Promise(r => setTimeout(r, 50));
  const multiDiagName = d.querySelector('.diag-name')?.textContent || '';
  ok(/Repeated File Reads \(2 files\)/.test(multiDiagName), 'plural pluralization in title: ' + multiDiagName);
  const multiDrawer = d.querySelector('.diag-drawer-full summary')?.textContent || '';
  ok(/Inspect 2 files/.test(multiDrawer), 'plural in drawer summary: ' + multiDrawer);

  // Test 2b: single arrow (no hardcoded glyph) + re-read pluralization
  ok(!/\u25B6/.test(multiDrawer), 'no hardcoded arrow in summary text: ' + multiDrawer.trim());
  ok(/\.diag-drawer-full\[open\] summary::before\s*\{\s*content:\s*'\\25BC'/.test(html), 'open state rotates marker to down arrow');
  const subRows = [...d.querySelectorAll('.dup-file-sublist .file-subrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
  ok(subRows.every(t => /\b\d+ re-reads?\b/.test(t) && !/\d+ reads/.test(t.replace(/re-reads/g, ''))), 'rows use re-read wording: ' + subRows.join(' | '));
  const one = JSON.parse(JSON.stringify(stateSingleFile));
  // In v3.2, dupFiles is sorted by wastedTokens descending (900 tok > 500 tok)
  one.brainSignals.duplicateReads.topFiles = [{ path: 'a.js', occurrences: 1, wastedTokens: 500 }, { path: 'b.js', occurrences: 3, wastedTokens: 900 }];
  w.renderState(one);
  await new Promise(r => setTimeout(r, 30));
  const oneRows = [...d.querySelectorAll('.dup-file-sublist .file-subrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
  ok(/3 re-reads ·/.test(oneRows[0]), 'wastedTokens primary sort places 3 re-reads first: ' + oneRows[0]);
  ok(/1 re-read ·/.test(oneRows[1]), 'count 1 -> "1 re-read": ' + oneRows[1]);

  // Test 3: Display-rounding reconciliation (3.4k + 8.9k + 0.1k = 12.4k vs raw 12349 -> 12.3k)
  const stateRounding = {
    sessionId: 's2', sessionTitle: 'Rounding Test',
    window: { totalActiveTokens: 60000, turnCount: 50 },
    breakdown: { STALE_DUPLICATE: 12293, DEAD_ERROR: 56 },
    metrics: { sludgeTokens: 12349 },
    brainSignals: {
      duplicateReads: {
        reclaimableTokens: 3431,
        topFiles: [{ path: 'C:/project/sidepane.html', occurrences: 7, wastedTokens: 3431 }]
      },
      oldHistory: { turnCount: 43, reclaimableTokens: 8862 },
      deadErrors: { errorCount: 1, reclaimableTokens: 56, isErrorLoop: false },
      blowupSteps: [],
      userCorrections: 0,
      activeSignal: { liveSessionTokens: 20000, taskMdSaved: true, taskMdTurnsBehind: 1 }
    },
    offenders: []
  };
  w.renderState(stateRounding);
  await new Promise(r => setTimeout(r, 30));
  const reclaimGroupPill = d.querySelector('.diag-group.reclaim .group-pill')?.textContent || '';
  ok(reclaimGroupPill.trim() === '12.4k total', 'reclaim header pill sums rounded rows (12.4k total): ' + reclaimGroupPill);
  ok(/^12\.4k/.test(txt('valClutter')), 'top Reclaimable card uses 12.4k: ' + txt('valClutter'));
  ok(txt('statusBadge') === '12.4k can be cleared', 'top-right statusBadge uses 12.4k: ' + txt('statusBadge'));
  ok(/reclaims up to ~12\.4k · keeps rules, (plan & code|task\.md & active summary) intact/.test(txt('compactReclaim')), '/compact instruction subtitle uses reclaims up to ~12.4k: ' + txt('compactReclaim'));

  // Test 4: Auto-focus chat input on prompt button copy + 2000ms flash feedback
  const focusMessages = [];
  w.addEventListener('message', e => { if (e.data && e.data.type === 'focusChatInput') focusMessages.push(e.data); });
  const nudgeBtn = d.querySelector('.diag-actions-row button');
  nudgeBtn.click();
  await new Promise(r => setTimeout(r, 30));
  ok(/Copied! Press Ctrl\+V in chat/.test(nudgeBtn.textContent), 'prompt button flash feedback: ' + nudgeBtn.textContent);
  ok(nudgeBtn.classList.contains('flash'), 'prompt button has flash class');
  ok(focusMessages.length >= 1, 'posted focusChatInput message to host on prompt copy');

  ok(errors.length === 0, 'no JS errors: ' + errors.join('; '));
  dom.window.close();
  console.log(fails ? 'TOTAL FAILS: ' + fails : 'ALL ASSERTIONS PASSED');
  process.exitCode = fails ? 1 : 0;
}
run();
