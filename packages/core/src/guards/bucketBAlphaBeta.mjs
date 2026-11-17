/**
 * @file src/core-isomorphic/guards/bucketBAlphaBeta.mjs
 * Pure Isomorphic Evaluators for Bucket B Sub-Waves B-Alpha & B-Beta:
 *   - `#2`  `GREP_GLOB_FIREWALL` (Context-aware >15-match search ranker)
 *   - `#4`  `BLAST_RADIUS_BREAKER` (Unverified multi-file / logic-line edit cap)
 *   - `#9`  `WEB_BOILERPLATE_BUDGETER` (Lossless `<code>`/`<pre>`/`<table>` HTML distiller)
 *   - `#8`  `DUPLICATE_CLONE_DETECTOR` (5-line FNV-1a 64-bit normalized shingle clone detector)
 *   - `#3b` `TEST_INTEGRITY_LOCK` (EvilGenie hardcoded input-output return oracle)
 *   - `#19` `OVERENGINEERING_DIFF_GATE` (Test-exempt non-test diff bloat & dead abstraction scorer)
 *
 * Mod Law 4 Compliant: Zero `node:*` imports, zero `process.cwd`/`exit`, zero global mutable state.
 */

const FORBIDDEN_SKU_PATH_RE =
  /(?:^|\/)(?:packages\/airlock(?:\/|$)|\.github\/workflows\/airlock-schema-canary\.yml$|docs\/HIGHBEAM_AIRLOCK_[^/]*\.md$)/i;

const TEST_PATH_RE =
  /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

const ARCHIVE_OR_LOW_PRIORITY_PATH_RE =
  /(?:^|\/)(?:archive|archived|deprecated|legacy|evaluation_bundles|vendor|dist|build|coverage|snapshots|__snapshots__|fixtures|examples|docs)\//i;

const ACTIVE_SOURCE_ROOT_RE = /^(?:src|hooks|bin|packages|sidecars|lib|app)\//i;

/**
 * Checks whether a normalized relative path belongs to an isolated sister SKU.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isBucketBForbiddenSkuPath(relPath = '') {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return FORBIDDEN_SKU_PATH_RE.test(norm);
}

// ============================================================================
// #2 GREP_GLOB_FIREWALL
// ============================================================================

const REPO_WIDE_AUDIT_PROMPT_RE =
  /\b(?:rename|refactor\s+across|replace\s+all|replace_all|all\s+occurrences|every\s+file|everywhere|repo-wide|codebase-wide|across\s+the\s+(?:repo|codebase|workspace)|audit\s+all|find\s+all\s+usages|global\s+search)\b/i;

function dirnamePosix(p = '') {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '';
}

function stemName(p = '') {
  const base = p.slice(p.lastIndexOf('/') + 1);
  return base.replace(/\.(?:test|spec)\./i, '.').replace(/\.[^.]+$/, '');
}

/**
 * Ranks and caps unbounded `Grep` / `Glob` result lists (`> 15` files) using active-session context.
 *
 * @param {object} input
 * @param {string[]} [input.matchPaths=[]]
 * @param {string} [input.query='']
 * @param {string} [input.lastUserPrompt='']
 * @param {Iterable<string>} [input.activeFiles=[]] - Files read or edited in this session
 * @param {Iterable<string>} [input.dirtyFiles=[]] - Modified files in git working tree
 * @param {string} [input.lastEditedFile='']
 * @param {Record<string, number>} [input.mtimeByPath={}] - Epoch ms per path
 * @param {number} [input.maxMatchesThreshold=15]
 * @param {number} [input.topK=8]
 */
export function evaluateGrepGlobFirewall(input = {}) {
  const maxMatchesThreshold = Number(input.maxMatchesThreshold) || 15;
  const topK = Number(input.topK) || 8;
  const rawPaths = Array.isArray(input.matchPaths) ? input.matchPaths : [];
  const cleanPaths = [];
  const seen = new Set();

  for (const p of rawPaths) {
    const norm = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm || seen.has(norm) || isBucketBForbiddenSkuPath(norm)) continue;
    seen.add(norm);
    cleanPaths.push(norm);
  }

  if (cleanPaths.length <= maxMatchesThreshold) {
    return {
      triggered: false,
      decision: 'allow',
      rankedPaths: cleanPaths,
      topPaths: cleanPaths,
      omittedCount: 0,
      tokensSavedEst: 0
    };
  }

  const prompt = String(input.lastUserPrompt || '');
  if (REPO_WIDE_AUDIT_PROMPT_RE.test(prompt)) {
    return {
      triggered: false,
      decision: 'allow',
      exemptReason: 'repo_wide_audit_intent',
      rankedPaths: cleanPaths,
      topPaths: cleanPaths,
      omittedCount: 0,
      tokensSavedEst: 0
    };
  }

  // Exempt short exact symbol boundary searches (`\bid\b`, `db`, `fs`, `ui`) up to 25 matches
  const q = String(input.query || '').trim();
  const strippedBoundary = q.replace(/^\\b|\\b$/g, '');
  const isShortExactSymbol =
    /^[A-Za-z_$][A-Za-z0-9_$]{1,3}$/.test(strippedBoundary) &&
    (q.startsWith('\\b') || Boolean(input.exactSymbol));
  if (isShortExactSymbol && cleanPaths.length <= 25) {
    return {
      triggered: false,
      decision: 'allow',
      exemptReason: 'short_exact_symbol_query',
      rankedPaths: cleanPaths,
      topPaths: cleanPaths,
      omittedCount: 0,
      tokensSavedEst: 0
    };
  }

  const activeSet = new Set(
    Array.from(input.activeFiles || [], (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, ''))
  );
  const dirtySet = new Set(
    Array.from(input.dirtyFiles || [], (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, ''))
  );
  const lastEdited = String(input.lastEditedFile || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const lastDir = dirnamePosix(lastEdited);
  const lastParentDir = dirnamePosix(lastDir);
  const lastStem = lastEdited ? stemName(lastEdited) : '';
  const mtimeMap = input.mtimeByPath || {};
  const mtimes = Object.values(mtimeMap).filter((v) => typeof v === 'number' && v > 0);
  const maxMtime = mtimes.length > 0 ? Math.max(...mtimes) : 0;

  const scored = cleanPaths.map((p, origIdx) => {
    let score = 0;
    if (activeSet.has(p)) score += 1000;
    if (dirtySet.has(p)) score += 520;

    const dir = dirnamePosix(p);
    if (lastDir && dir === lastDir) score += 320;
    else if (lastParentDir && dir.startsWith(lastParentDir)) score += 180;

    if (lastStem && stemName(p) === lastStem) score += 260;

    const mtime = Number(mtimeMap[p] || 0);
    if (maxMtime > 0 && mtime > 0) {
      const ageMs = Math.max(0, maxMtime - mtime);
      if (ageMs <= 10 * 60 * 1000) score += 160;
      else if (ageMs <= 60 * 60 * 1000) score += 90;
    }

    if (ARCHIVE_OR_LOW_PRIORITY_PATH_RE.test(p)) score -= 240;
    else if (ACTIVE_SOURCE_ROOT_RE.test(p)) score += 110;

    if (q && stemName(p).toLowerCase().includes(strippedBoundary.toLowerCase())) {
      score += 140;
    }

    return { path: p, score, origIdx };
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.origIdx - b.origIdx));
  const rankedPaths = scored.map((s) => s.path);
  const topPaths = rankedPaths.slice(0, topK);
  const omittedCount = Math.max(0, rankedPaths.length - topPaths.length);

  return {
    triggered: true,
    decision: 'warn',
    code: 'GREP_GLOB_FIREWALL',
    rankedPaths,
    topPaths,
    omittedCount,
    tokensSavedEst: omittedCount * 140,
    reason: `[Quota Shield] Ranked ${rankedPaths.length} search matches -> Top ${topPaths.length} active-context matches (+${omittedCount} lower-priority paths omitted; refine glob/path to inspect others).`
  };
}

// ============================================================================
// #9 WEB_BOILERPLATE_BUDGETER
// ============================================================================

const STRIP_BLOCK_TAG_RE =
  /<(script|style|svg|nav|footer|header|aside|noscript|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi;

const BOILERPLATE_CONTAINER_RE =
  /<(div|section)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:cookie-banner|cookie-consent|gdpr|newsletter-signup|site-nav|navbar|sidebar-nav|breadcrumbs|share-buttons|promo-banner|ad-slot|toc-sidebar)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function convertHtmlTableToMarkdown(tableHtml = '', restoreTokenFn) {
  const rows = [];
  const trMatches = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    const cells = [];
    const cellMatches = tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) || [];
    for (const cell of cellMatches) {
      const inner = cell
        .replace(/^<t[hd]\b[^>]*>|<\/t[hd]>$/gi, '')
        .replace(/<[^>]+>/g, ' ');
      const restored = restoreTokenFn(inner);
      const cleaned = decodeHtmlEntities(restored).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
      cells.push(cleaned);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const padRow = (r) => {
    const copy = [...r];
    while (copy.length < colCount) copy.push('');
    return `| ${copy.join(' | ')} |`;
  };
  const headerLine = padRow(rows[0]);
  const sepLine = `| ${new Array(colCount).fill('---').join(' | ')} |`;
  const bodyLines = rows.slice(1).map(padRow);
  return `\n${[headerLine, sepLine, ...bodyLines].join('\n')}\n`;
}

/**
 * Distills bloated raw HTML pages into compact Markdown while preserving 100% of
 * `<pre>`, `<code>`, and `<table>` cell contents verbatim.
 *
 * @param {object} input
 * @param {string} [input.html='']
 * @param {number} [input.webFetchesInTurn=1]
 * @param {number} [input.minBytesToDistill=1200]
 */
export function distillHtmlWebPayload(input = {}) {
  const html = String(input.html || '');
  const webFetchesInTurn = Number(input.webFetchesInTurn) || 1;
  const minBytes = Number(input.minBytesToDistill) || 1200;

  if (html.length < minBytes && webFetchesInTurn <= 5) {
    return {
      triggered: false,
      decision: 'allow',
      distilled: html,
      tokenReductionPct: 0,
      tokensSavedEst: 0,
      excessiveFetchVelocity: false
    };
  }

  const protectedSlots = [];
  const stash = (text) => {
    const token = `\u0000CTX_SLOT_${protectedSlots.length}\u0000`;
    protectedSlots.push(text);
    return token;
  };
  const restoreAll = (text) =>
    String(text).replace(/\u0000CTX_SLOT_(\d+)\u0000/g, (_m, idx) => protectedSlots[Number(idx)] ?? '');

  // 1. Strip comments and non-content chrome blocks BEFORE touching code/tables
  let working = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(STRIP_BLOCK_TAG_RE, '\n')
    .replace(BOILERPLATE_CONTAINER_RE, '\n');

  // 2. Protect `<pre>...</pre>` blocks verbatim
  working = working.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const cleanCode = decodeHtmlEntities(
      inner.replace(/^<code\b[^>]*>|<\/code>$/gi, '')
    ).trim();
    return stash(`\n\`\`\`\n${cleanCode}\n\`\`\`\n`);
  });

  // 3. Protect inline `<code>...</code>` spans verbatim
  working = working.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    const cleanInline = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim();
    return stash(`\`${cleanInline}\``);
  });

  // 4. Convert `<table>...</table>` into lossless Markdown pipe tables
  working = working.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableBlock) =>
    stash(convertHtmlTableToMarkdown(tableBlock, restoreAll))
  );

  // 5. Convert structural headings & list items, then strip all remaining HTML tags/attributes
  working = working
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) =>
      `\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`
    )
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<(?:p|div|section|article|br|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  let distilled = decodeHtmlEntities(working);
  distilled = restoreAll(distilled)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const origTok = Math.max(1, Math.ceil(html.length / 4));
  const newTok = Math.ceil(distilled.length / 4);
  const savedTok = Math.max(0, origTok - newTok);
  const reductionPct = Number(((savedTok / origTok) * 100).toFixed(2));
  const excessiveFetchVelocity = webFetchesInTurn > 5;

  return {
    triggered: savedTok >= 150 || excessiveFetchVelocity,
    decision: 'warn',
    code: 'WEB_BOILERPLATE_BUDGETER',
    distilled,
    tokenReductionPct: reductionPct,
    tokensSavedEst: savedTok,
    excessiveFetchVelocity,
    reason: `[Quota Shield] Distilled web HTML (${reductionPct}% boilerplate stripped, ~${savedTok} tok saved${
      excessiveFetchVelocity ? `; high web fetch velocity: ${webFetchesInTurn} fetches in turn` : ''
    }).`
  };
}

// ============================================================================
// #4 BLAST_RADIUS_BREAKER
// ============================================================================

const GREENFIELD_SCAFFOLD_PROMPT_RE =
  /\b(?:scaffold|greenfield|bootstrap|create\s+(?:a\s+)?new\s+(?:package|app|project|module)|generate\s+boilerplate|initial\s+skeleton)\b/i;

function isPureImportExportDiff(changedLines = []) {
  const nonBlank = changedLines.map((l) => l.trim()).filter(Boolean);
  if (nonBlank.length === 0) return true;
  let importCount = 0;
  for (const line of nonBlank) {
    if (
      /^(?:import\b|export\b.*\bfrom\b|from\s+['"]|\x7d\s*from\s+['"]|const\s+\S+\s*=\s*require\x28)/.test(
        line
      )
    ) {
      importCount += 1;
    }
  }
  return importCount / nonBlank.length >= 0.9;
}

/**
 * Evaluates unverified source edit blast radius since the last exit-`0` test/`tsc` verification.
 *
 * @param {object} input
 * @param {Array<{ filePath: string, netLines?: number, changedLines?: string[] }>} [input.editsSinceVerify=[]]
 * @param {string} [input.lastUserPrompt='']
 * @param {number} [input.maxUnverifiedFiles=6]
 * @param {number} [input.maxNetLogicLines=250]
 */
export function evaluateBlastRadiusBreaker(input = {}) {
  const maxUnverifiedFiles = Number(input.maxUnverifiedFiles) || 6;
  const maxNetLogicLines = Number(input.maxNetLogicLines) || 250;
  const prompt = String(input.lastUserPrompt || '');

  if (GREENFIELD_SCAFFOLD_PROMPT_RE.test(prompt)) {
    return {
      triggered: false,
      decision: 'allow',
      exemptReason: 'greenfield_scaffold_intent',
      distinctSourceFiles: 0,
      netLogicLines: 0,
      tokensSavedEst: 0
    };
  }

  const edits = Array.isArray(input.editsSinceVerify) ? input.editsSinceVerify : [];
  const sourceFileSet = new Set();
  let netLogicLines = 0;

  for (const edit of edits) {
    const norm = String(edit.filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm || isBucketBForbiddenSkuPath(norm)) continue;
    // Exempt test files and Markdown docs from unverified source blast radius
    if (TEST_PATH_RE.test(norm) || /\.md$/i.test(norm)) continue;
    if (Array.isArray(edit.changedLines) && isPureImportExportDiff(edit.changedLines)) continue;

    sourceFileSet.add(norm);
    netLogicLines += Math.max(0, Number(edit.netLines) || 0);
  }

  const distinctSourceFiles = sourceFileSet.size;
  const exceededFiles = distinctSourceFiles > maxUnverifiedFiles;
  const exceededLines = distinctSourceFiles >= 4 && netLogicLines > maxNetLogicLines;

  if (!exceededFiles && !exceededLines) {
    return {
      triggered: false,
      decision: 'allow',
      distinctSourceFiles,
      netLogicLines,
      tokensSavedEst: 0
    };
  }

  return {
    triggered: true,
    decision: 'warn',
    code: 'BLAST_RADIUS_BREAKER',
    distinctSourceFiles,
    netLogicLines,
    tokensSavedEst: 2400,
    reason: `[Build Integrity Shield] ${distinctSourceFiles} source files (${netLogicLines} net logic lines) modified without an intervening passing test or typecheck. Run targeted verification before expanding edit scope.`
  };
}

// ============================================================================
// #8 DUPLICATE_CLONE_DETECTOR (5-Line Normalized FNV-1a 64-bit Shingling)
// ============================================================================

/**
 * Computes a fast zero-BigInt-allocation 64-bit dual-lane FNV-1a hex digest (`Math.imul` SMI).
 *
 * @param {string} str
 * @returns {string}
 */
export function fnv1a64Hex(str = '') {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ ((code << 5) | (code >>> 3)), 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

const BOILERPLATE_LINE_SKIP_RE =
  /^(?:[\x7b\x7d\x28\x29[\];,]+|try\s*\x7b|\x7d\s*catch\b[^\x7b]*\x7b|\x7d\s*finally\s*\x7b|else\s*\x7b|\x7d\s*else\s*\x7b|(?:describe|it|test|beforeEach|afterEach|before|after)\s*\x28|return\s+(?:null|undefined|true|false|\x7b\x7d|\[\])\s*;?|(?:import\s+|export\s+(?:\*|\x7b[^\x7d]*\x7d)\s+from\s+|const\s+\S+\s*=\s*require\x28))/;

function hashLineDual32(str) {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 3)), 0x85ebca6b);
  }
  return [h1, h2];
}

/**
 * Strips imports, comments, single-brace lines, and test `describe`/`it` boilerplate wrappers,
 * returning normalized non-trivial logic lines suitable for 5-line clone shingling.
 *
 * @param {string} source
 * @returns {Array<{ norm: string, lineNo: number, h1: number, h2: number, len: number }>}
 */
export function normalizeLinesForShingling(source = '') {
  const src = String(source || '');
  const rawLines = src.split('\n');
  const result = [];
  let inBlockComment = false;
  let skippingMultilineImport = false;

  for (let idx = 0; idx < rawLines.length; idx++) {
    let line = rawLines[idx];
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx < 0) continue;
      inBlockComment = false;
      line = line.slice(endIdx + 2);
    }

    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith('/*')) {
      const blockEnd = trimmedStart.indexOf('*/', 2);
      if (blockEnd >= 0) {
        line = trimmedStart.slice(blockEnd + 2);
      } else {
        inBlockComment = true;
        continue;
      }
    }

    if (trimmedStart.startsWith('//')) continue;

    line = line.trim();
    if (line.length < 8 || line.startsWith('*')) continue;

    if (skippingMultilineImport) {
      if (line.includes('fro' + 'm ') || line.endsWith('\x7d;') || line.endsWith('\x7d')) {
        skippingMultilineImport = false;
      }
      continue;
    }
    const c0 = line.charCodeAt(0);
    if ((c0 === 105 || c0 === 101) && /^(?:import|export)\s*\{[^}]*$/.test(line)) {
      skippingMultilineImport = true;
      continue;
    }
    if (
      (c0 === 123 || c0 === 125 || c0 === 40 || c0 === 41 || c0 === 91 || c0 === 93 || c0 === 59 || c0 === 116 || c0 === 101 || c0 === 100 || c0 === 105 || c0 === 98 || c0 === 97 || c0 === 114 || c0 === 99) &&
      BOILERPLATE_LINE_SKIP_RE.test(line)
    ) {
      continue;
    }

    const norm = line.includes('  ') || line.includes('\t') ? line.replace(/\s+/g, ' ') : line;
    if (norm.length < 8) continue;
    const [h1, h2] = hashLineDual32(norm);
    result.push({ norm, lineNo: idx + 1, h1, h2, len: norm.length });
  }
  return result;
}

/**
 * Computes 5-line rolling FNV-1a 64-bit shingles in O(N) integer ops (`0` per-window string allocations).
 *
 * @param {string} source
 * @param {number} [windowSize=5]
 * @returns {Array<{ hash: string, startLine: number, endLine: number }>}
 */
export function computeFileShingles(source = '', windowSize = 5) {
  const normLines = normalizeLinesForShingling(source);
  if (normLines.length < windowSize) return [];
  const shingles = [];
  for (let i = 0; i <= normLines.length - windowSize; i++) {
    let charSum = 0;
    let w1 = 0x811c9dc5 | 0;
    let w2 = 0x9e3779b9 | 0;
    for (let k = 0; k < windowSize; k++) {
      const entry = normLines[i + k];
      charSum += entry.len;
      w1 = Math.imul(w1 ^ entry.h1, 0x01000193);
      w2 = Math.imul(w2 ^ entry.h2, 0x85ebca6b);
    }
    if (charSum < 81) continue;
    shingles.push({
      hash: ((w1 >>> 0) * 2097152 + (w2 >>> 11)).toString(16),
      startLine: normLines[i].lineNo,
      endLine: normLines[i + windowSize - 1].lineNo
    });
  }
  return shingles;
}

/**
 * Evaluates a newly added or edited code snippet against a pre-indexed workspace shingle map.
 * Requires `>= 2` overlapping 5-line shingles (`>= 6` normalized logic lines) matching a distinct file.
 *
 * @param {object} input
 * @param {string} input.targetPath
 * @param {string} input.addedCode
 * @param {Record<string, Array<{ file: string, startLine: number }>>} [input.shingleIndex={}]
 * @param {number} [input.minMatchingShingles=2]
 */
export function detectDuplicateClones(input = {}) {
  const targetNorm = String(input.targetPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!targetNorm || isBucketBForbiddenSkuPath(targetNorm) || TEST_PATH_RE.test(targetNorm)) {
    return { triggered: false, decision: 'allow', clones: [], tokensSavedEst: 0 };
  }

  const minMatchingShingles = Number(input.minMatchingShingles) || 2;
  const candidateShingles = computeFileShingles(input.addedCode || '', 5);
  if (candidateShingles.length < minMatchingShingles) {
    return { triggered: false, decision: 'allow', clones: [], tokensSavedEst: 0 };
  }

  const index = input.shingleIndex || {};
  const hitsByOtherFile = new Map();

  for (const sh of candidateShingles) {
    const postings = index[sh.hash];
    if (!Array.isArray(postings)) continue;
    for (const post of postings) {
      if (!post || post.file === targetNorm || isBucketBForbiddenSkuPath(post.file)) continue;
      const entry = hitsByOtherFile.get(post.file) || {
        file: post.file,
        matchedShingles: 0,
        firstSourceLine: post.startLine,
        firstCandidateLine: sh.startLine
      };
      entry.matchedShingles += 1;
      hitsByOtherFile.set(post.file, entry);
    }
  }

  const clones = Array.from(hitsByOtherFile.values())
    .filter((c) => c.matchedShingles >= minMatchingShingles)
    .sort((a, b) => b.matchedShingles - a.matchedShingles);

  if (clones.length === 0) {
    return { triggered: false, decision: 'allow', clones: [], tokensSavedEst: 0 };
  }

  const top = clones[0];
  return {
    triggered: true,
    decision: 'warn',
    code: 'DUPLICATE_CLONE_DETECTOR',
    clones,
    tokensSavedEst: 650,
    reason: `[Code Health Hint] Added logic block duplicates ${top.matchedShingles + 4}+ lines in \`${top.file}:${top.firstSourceLine}\` — consider reusing or extracting a shared helper.`
  };
}

// ============================================================================
// #3b TEST_INTEGRITY_LOCK (EvilGenie Hardcoded Input-Output Return Oracle)
// ============================================================================

const TRIVIAL_NUMERIC_LITERALS = new Set([
  -1, 0, 1, 2, 3, 4, 8, 10, 16, 24, 32, 60, 64, 100, 128, 256, 512, 1000, 1024
]);

const HTTP_STATUS_CODES = new Set([
  200, 201, 202, 204, 206, 301, 302, 304, 307, 308,
  400, 401, 403, 404, 405, 408, 409, 410, 413, 422, 429,
  500, 501, 502, 503, 504
]);

function isHttpStatusLiteral(num) {
  return HTTP_STATUS_CODES.has(num);
}

function isDomainEnumOrTokenString(lit = '') {
  const inner = lit.slice(1, -1);
  if (inner.length <= 2) return true;
  // Uppercase enum constants, CLI flags, MIME/path/glob tokens, JS keywords/types
  if (/^[A-Z][A-Z0-9_:-]+$/.test(inner)) return true;
  if (/^--?[a-z0-9-]+$/i.test(inner)) return true;
  if (/^(?:string|number|boolean|object|function|symbol|undefined|bigint)$/.test(inner)) return true;
  if (/^(?:allow|deny|warn|ask|defer|shadow|coach|enforce|true|false|null|ok|error|json|utf8|utf-8|win32|darwin|linux)$/i.test(inner)) {
    return true;
  }
  if (/^[./\\]|\/|\.[a-z0-9]{1,6}$/i.test(inner)) return true;
  if (/^[a-z]+(?:[-_:][a-z0-9]+)+$/i.test(inner) && !/\s/.test(inner) && !/[,[\]{}]/.test(inner)) {
    return true;
  }
  return false;
}

function isSpecificTestOracleCondition(cond = '') {
  const c = cond.trim();
  // Serialized container/tuple equality (`JSON.stringify(x) === '[...]'`)
  if (/JSON\.stringify\s*\([^\x29]+\)\s*===?\s*['"`][\x5b\x7b]/.test(c)) return true;

  // Require conjunctive `&&` multi-parameter check (`a === 17 && b === 42`), never disjunctive `||` enum aliases!
  if (!c.includes('&&')) return false;

  const isStatusContext = /\b(?:status|statusCode|httpStatus|code)\b/i.test(c);
  const eqMatches = [
    ...c.matchAll(
      /\b([A-Za-z_$][A-Za-z0-9_$.[\]]*)\s*===?\s*(-?\d+(?:\.\d+)?|'[^'\n]{1,80}'|"[^"\n]{1,80}")/g
    )
  ];
  if (eqMatches.length < 2) return false;

  const lhsVars = new Set();
  let magicLiterals = 0;
  for (const m of eqMatches) {
    lhsVars.add(m[1]);
    const rhs = m[2];
    if (/^-?\d/.test(rhs)) {
      const n = Number(rhs);
      if (!TRIVIAL_NUMERIC_LITERALS.has(n) && !(isStatusContext && isHttpStatusLiteral(n))) {
        magicLiterals += 1;
      }
    } else if (!isDomainEnumOrTokenString(rhs)) {
      magicLiterals += 1;
    }
  }

  return lhsVars.size >= 2 && magicLiterals >= 2;
}

function isConcreteLiteralReturn(retExpr = '', cond = '') {
  const r = retExpr.trim().replace(/;$/, '').trim();
  if (!r || /^(?:true|false|null|undefined|0|1|-1|''|""|\[\]|\{\})$/.test(r)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(r)) {
    const n = Number(r);
    const isStatusContext = /\b(?:status|statusCode|httpStatus|code)\b/i.test(cond);
    return !(isStatusContext && isHttpStatusLiteral(n));
  }
  if (/^\[[\d\s,.'"truefalsn-]+\]$/.test(r)) return true;
  if (/^(['"])(?:(?!\1).)+\1$/.test(r)) return !isDomainEnumOrTokenString(r);
  return false;
}

/**
 * Detects EvilGenie-style benchmark test-case hardcoding (`if (input === magic) return expectedLiteral`
 * chains) in newly added non-test production source code.
 *
 * @param {object} input
 * @param {string} [input.filePath='']
 * @param {string} [input.addedCode='']
 * @param {number} [input.minOracleBranches=3]
 */
export function evaluateHardcodedOracle(input = {}) {
  const norm = String(input.filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (TEST_PATH_RE.test(norm) || isBucketBForbiddenSkuPath(norm)) {
    return { triggered: false, decision: 'allow', oracleBranches: 0, samples: [] };
  }

  const minOracleBranches = Number(input.minOracleBranches) || 3;
  const code = String(input.addedCode || '');
  const lines = code.split(/\r?\n/);
  const matchedEntries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('//') || line.startsWith('*')) continue;

    const singleMatch = line.match(/^(?:else\s+)?if\s*\((.+)\)\s*\{?\s*return\s+([^;{}]+);?\s*\}?$/);
    if (singleMatch) {
      const [, cond, ret] = singleMatch;
      if (isSpecificTestOracleCondition(cond) && isConcreteLiteralReturn(ret, cond)) {
        matchedEntries.push({ lineNo: i, text: line.slice(0, 120) });
      }
      continue;
    }

    const headMatch = line.match(/^(?:else\s+)?if\s*\((.+)\)\s*\x7b?$/);
    if (headMatch && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      const retMatch = nextLine.match(/^return\s+([^;{}]+);?$/);
      if (
        retMatch &&
        isSpecificTestOracleCondition(headMatch[1]) &&
        isConcreteLiteralReturn(retMatch[1], headMatch[1])
      ) {
        matchedEntries.push({ lineNo: i, text: `${line} ${nextLine}`.slice(0, 120) });
      }
    }
  }

  // Require >= minOracleBranches clustered within a 25-line function window
  let clustered = [];
  for (let i = 0; i < matchedEntries.length; i++) {
    const windowItems = [matchedEntries[i]];
    for (let j = i + 1; j < matchedEntries.length; j++) {
      if (matchedEntries[j].lineNo - matchedEntries[i].lineNo <= 25) {
        windowItems.push(matchedEntries[j]);
      }
    }
    if (windowItems.length > clustered.length) clustered = windowItems;
  }

  const samples = clustered.map((e) => e.text);
  if (samples.length < minOracleBranches) {
    return {
      triggered: false,
      decision: 'allow',
      oracleBranches: samples.length,
      samples
    };
  }

  return {
    triggered: true,
    decision: 'warn',
    code: 'EVILGENIE_HARDCODED_ORACLE',
    oracleBranches: samples.length,
    samples: samples.slice(0, 5),
    tokensSavedEst: 1500,
    reason: `[Test Integrity Shield] Detected ${samples.length} hardcoded input->literal return branches resembling benchmark test-case memorization. Implement general domain logic instead of special-casing test inputs.`
  };
}

// ============================================================================
// #19 OVERENGINEERING_DIFF_GATE
// ============================================================================

const NARROW_BUGFIX_PROMPT_RE =
  /\b(?:fix\s+(?:the\s+)?(?:typo|off-by-one|null|bug|crash|edge\s+case|regex|import)|one-line|small\s+tweak|minor\s+fix|hotfix)\b/i;

/**
 * Scores diff proportionality (`nonTestAddedLines` vs. deleted lines + unused exported abstractions),
 * strictly excluding `test/<suite>` and `*.test.*` lines from the bloat numerator so thorough test suites are never penalized.
 *
 * @param {object} input
 * @param {Array<{ filePath: string, addedLines?: string[], deletedLineCount?: number }>} [input.fileDiffs=[]]
 * @param {string} [input.lastUserPrompt='']
 * @param {number} [input.maxBugfixAddedLines=180]
 */
export function evaluateOverengineeringDiffGate(input = {}) {
  const diffs = Array.isArray(input.fileDiffs) ? input.fileDiffs : [];
  const prompt = String(input.lastUserPrompt || '');
  const maxBugfixAddedLines = Number(input.maxBugfixAddedLines) || 180;

  let nonTestAddedLines = 0;
  let testAddedLines = 0;
  let nonTestDeletedLines = 0;
  const exportedAbstractions = [];
  const allAddedText = [];

  for (const d of diffs) {
    const norm = String(d.filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm || isBucketBForbiddenSkuPath(norm)) continue;
    const added = Array.isArray(d.addedLines) ? d.addedLines : [];
    if (TEST_PATH_RE.test(norm)) {
      testAddedLines += added.length;
      continue;
    }
    if (/\.md$|\.json$/i.test(norm)) continue;

    nonTestAddedLines += added.length;
    nonTestDeletedLines += Math.max(0, Number(d.deletedLineCount) || 0);

    for (const line of added) {
      allAddedText.push(line);
      const clsMatch = line.match(
        /^\s*export\s+(?:abstract\s+)?(?:class|interface)\s+([A-Za-z0-9_]+(?:Factory|Builder|Manager|Strategy|Provider|Registry|Orchestrator|Adapter))\b/
      );
      if (clsMatch) {
        exportedAbstractions.push(clsMatch[1]);
      }
    }
  }

  const joinedCorpus = allAddedText.join('\n');
  let unusedExportedAbstractions = 0;
  for (const sym of exportedAbstractions) {
    const matches = joinedCorpus.match(new RegExp(`\\b${sym}\\b`, 'g')) || [];
    // Only the declaration occurrence itself (`matches.length <= 1`)
    if (matches.length <= 1) unusedExportedAbstractions += 1;
  }

  const isNarrowBugfix =
    NARROW_BUGFIX_PROMPT_RE.test(prompt) ||
    (nonTestDeletedLines > 0 && nonTestDeletedLines <= 12 && !GREENFIELD_SCAFFOLD_PROMPT_RE.test(prompt));

  const addDeleteRatio = nonTestAddedLines / Math.max(1, nonTestDeletedLines);
  const bloatedBugfix =
    isNarrowBugfix &&
    nonTestAddedLines > maxBugfixAddedLines &&
    (unusedExportedAbstractions >= 1 || addDeleteRatio > 18);
  const deadAbstractionBloat =
    nonTestAddedLines > 140 && unusedExportedAbstractions >= 2;

  if (!bloatedBugfix && !deadAbstractionBloat) {
    return {
      triggered: false,
      decision: 'allow',
      nonTestAddedLines,
      testAddedLines,
      unusedExportedAbstractions,
      tokensSavedEst: 0
    };
  }

  return {
    triggered: true,
    decision: 'warn',
    code: 'OVERENGINEERING_DIFF_GATE',
    nonTestAddedLines,
    testAddedLines,
    unusedExportedAbstractions,
    tokensSavedEst: 950,
    reason: `[Code Health Hint] Diff adds ${nonTestAddedLines} non-test production lines (test lines excluded: ${testAddedLines}) with ${unusedExportedAbstractions} unreferenced exported abstraction(s). Prefer minimal direct fixes over speculative wrapper classes.`
  };
}
