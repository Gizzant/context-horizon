#!/usr/bin/env node
/**
 * T7 Rulebook Catalog & Deterministic Verifiers (Option 7B)
 *
 * - 3 seeds: ALPHA (seed 1), BRAVO (seed 2), CHARLIE (seed 3)
 * - 10 orthogonal conditional rule dimensions per seed (zero mutual conflicts across any 5-of-10 subset)
 * - 20 balanced probe tasks: each activates a unique 5-of-10 subset; each rule triggers 10/20 times
 * - 490 realistic engineering distractor rules whose trigger tags ([OPT-AAA]...) never appear in probes
 * - Interleaves the 10 seed rules evenly across S in {10, 50, 100, 250, 500}
 * - Run `node rules_500_catalog.mjs --self-test` ($0) to verify zero false positives/negatives
 */

export const SEEDS = [
  { seed: 1, name: 'ALPHA' },
  { seed: 2, name: 'BRAVO' },
  { seed: 3, name: 'CHARLIE' }
];

export const DIMENSION_CODES = [
  'HDR',  // 0: Line 1 prefix
  'END',  // 1: Final closing sentinel
  'BDG',  // 2: Bracketed body badge
  'BAN',  // 3: Forbidden word
  'KW',   // 4: Required exact uppercase keyword
  'NUM',  // 5: Zero Arabic digits (0-9)
  'LIST', // 6: Exact bullet line count
  'LEN',  // 7: Whitespace word count band
  'PUNC', // 8: Forbidden punctuation marks
  'META'  // 9: Required structured note line
];

export const TRIGGER_TAGS = DIMENSION_CODES.map((c) => `[TAG-${c}]`);

const SEED_SPECS = {
  ALPHA: {
    hdrPrefix: 'REC_ALPHA:',
    endSentinel: '<<DONE_ALPHA>>',
    badgeToken: '[VERIFIED-ALPHA]',
    bannedRegex: /\bcach(e|ed|es|ing)\b/i,
    bannedDesc: 'Never use the words `cache`, `cached`, `caches`, or `caching` anywhere (use `store` instead).',
    kwToken: 'CONFIRMATION',
    numDesc: 'Do not write any Arabic numeral digits (`0`-`9`) anywhere in your reply; spell out any numbers in words.',
    bulletMarker: '-',
    bulletCount: 3,
    bulletRegex: /^\s*-\s+\S/,
    minWords: 25,
    maxWords: 65,
    puncRegex: /[!;]/,
    puncDesc: 'Do not use any exclamation marks (`!`) or semicolons (`;`) anywhere.',
    metaPrefix: 'AUDIT_NOTE:'
  },
  BRAVO: {
    hdrPrefix: 'HDR_BRAVO:',
    endSentinel: '<<FIN_BRAVO>>',
    badgeToken: '[CHECKED-BRAVO]',
    bannedRegex: /\btokens?\b/i,
    bannedDesc: 'Never use the words `token` or `tokens` anywhere (use `unit` or `units` instead).',
    kwToken: 'VALIDATION',
    numDesc: 'Spell out all quantities as words; zero Arabic numeral digits (`0`-`9`) may appear anywhere.',
    bulletMarker: '*',
    bulletCount: 2,
    bulletRegex: /^\s*\*\s+\S/,
    minWords: 30,
    maxWords: 70,
    puncRegex: /[?;]/,
    puncDesc: 'Do not use any question marks (`?`) or semicolons (`;`) anywhere.',
    metaPrefix: 'TRACE_NOTE:'
  },
  CHARLIE: {
    hdrPrefix: 'LOG_CHARLIE:',
    endSentinel: '<<STOP_CHARLIE>>',
    badgeToken: '[PASSED-CHARLIE]',
    bannedRegex: /\bmodels?\b/i,
    bannedDesc: 'Never use the words `model` or `models` anywhere (use `engine` or `engines` instead).',
    kwToken: 'COMPLIANCE',
    numDesc: 'Exclude all digit characters (`0`-`9`) from your entire response (write numbers in words).',
    bulletMarker: '-',
    bulletCount: 4,
    bulletRegex: /^\s*-\s+\S/,
    minWords: 25,
    maxWords: 65,
    puncRegex: /[!?]/,
    puncDesc: 'Do not use any exclamation marks (`!`) or question marks (`?`) anywhere.',
    metaPrefix: 'CHECK_NOTE:'
  }
};

export function buildSeedRules(seedName) {
  const s = SEED_SPECS[seedName];
  if (!s) throw new Error(`Unknown seedName: ${seedName}`);

  return [
    {
      dimIndex: 0,
      dimCode: 'HDR',
      trigger: '[TAG-HDR]',
      text: `When user prompt includes [TAG-HDR], begin line 1 verbatim with "${s.hdrPrefix}" followed by a short space-separated summary.`,
      check(text) {
        const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return lines.length > 0 && lines[0].startsWith(s.hdrPrefix);
      }
    },
    {
      dimIndex: 1,
      dimCode: 'END',
      trigger: '[TAG-END]',
      text: `When user prompt includes [TAG-END], end your entire response (final non-whitespace characters) verbatim with "${s.endSentinel}" on its own closing line.`,
      check(text) {
        return String(text || '').trim().endsWith(s.endSentinel);
      }
    },
    {
      dimIndex: 2,
      dimCode: 'BDG',
      trigger: '[TAG-BDG]',
      text: `When user prompt includes [TAG-BDG], include the exact badge "${s.badgeToken}" verbatim inside the body of your reply.`,
      check(text) {
        return String(text || '').includes(s.badgeToken);
      }
    },
    {
      dimIndex: 3,
      dimCode: 'BAN',
      trigger: '[TAG-BAN]',
      text: `When user prompt includes [TAG-BAN], ${s.bannedDesc}`,
      check(text) {
        return !s.bannedRegex.test(String(text || ''));
      }
    },
    {
      dimIndex: 4,
      dimCode: 'KW',
      trigger: '[TAG-KW]',
      text: `When user prompt includes [TAG-KW], include the exact ALL-CAPS word "${s.kwToken}" as a standalone word inside your reply.`,
      check(text) {
        return new RegExp(`\\b${s.kwToken}\\b`).test(String(text || ''));
      }
    },
    {
      dimIndex: 5,
      dimCode: 'NUM',
      trigger: '[TAG-NUM]',
      text: `When user prompt includes [TAG-NUM], ${s.numDesc}`,
      check(text) {
        return !/\d/.test(String(text || ''));
      }
    },
    {
      dimIndex: 6,
      dimCode: 'LIST',
      trigger: '[TAG-LIST]',
      text: `When user prompt includes [TAG-LIST], include exactly ${s.bulletCount} bullet lines starting with "${s.bulletMarker} " in the middle body.`,
      check(text) {
        const lines = String(text || '').split(/\r?\n/);
        const count = lines.filter((l) => s.bulletRegex.test(l)).length;
        return count === s.bulletCount;
      }
    },
    {
      dimIndex: 7,
      dimCode: 'LEN',
      trigger: '[TAG-LEN]',
      text: `When user prompt includes [TAG-LEN], keep the entire response between ${s.minWords} and ${s.maxWords} whitespace-separated words inclusive.`,
      check(text) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        return words.length >= s.minWords && words.length <= s.maxWords;
      }
    },
    {
      dimIndex: 8,
      dimCode: 'PUNC',
      trigger: '[TAG-PUNC]',
      text: `When user prompt includes [TAG-PUNC], ${s.puncDesc}`,
      check(text) {
        return !s.puncRegex.test(String(text || ''));
      }
    },
    {
      dimIndex: 9,
      dimCode: 'META',
      trigger: '[TAG-META]',
      text: `When user prompt includes [TAG-META], include one line starting verbatim with "${s.metaPrefix} " followed by at least three words.`,
      check(text) {
        const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
        return lines.some((l) => {
          if (!l.startsWith(`${s.metaPrefix} `)) return false;
          const rest = l.slice(s.metaPrefix.length + 1).trim().split(/\s+/).filter(Boolean);
          return rest.length >= 3;
        });
      }
    }
  ];
}

const DISTRACTOR_TEMPLATES = [
  ['schema migrations', 'emit backward-compatible SQL DDL before any column drop'],
  ['TLS handshakes', 'require certificate chain verification without skipping host checks'],
  ['CSV exports', 'quote every text cell containing commas, newlines, or double quotes'],
  ['retry loops', 'apply bounded exponential backoff with jitter capped at five attempts'],
  ['webhook dispatch', 'sign every outbound payload body with an HMAC header'],
  ['structured logs', 'omit bearer tokens, session cookies, and private user directories'],
  ['graceful shutdown', 'drain in-flight sockets before closing worker listener handles'],
  ['read-only telemetry', 'open external trace stores without creating journal files on disk'],
  ['UTF-8 normalization', 'preserve line endings explicitly instead of reformatting unrelated lines'],
  ['deterministic sorting', 'order object properties lexicographically before digest hashing'],
  ['pagination cursors', 'return an opaque continuation string rather than mutating caller state'],
  ['idempotency keys', 'deduplicate repeated mutations inside an atomic transaction block'],
  ['memory pools', 'release large scratch buffers immediately after streaming serialization'],
  ['circuit breakers', 'transition back to half-open state only after cooldown expiry'],
  ['queue backpressure', 'pause upstream producers whenever pending depth exceeds safe bounds'],
  ['canary releases', 'compare baseline error percentiles against previous stable builds'],
  ['snapshot backups', 'verify archive checksums before pruning superseded local copies'],
  ['timezone handling', 'store canonical UTC ISO timestamps alongside offset metadata'],
  ['regex compilation', 'hoist static patterns outside tight inner iteration loops'],
  ['dependency pinning', 'record exact package digests instead of floating semver ranges']
];

function indexToAlphaTag(idx) {
  const a = String.fromCharCode(65 + (Math.floor(idx / 676) % 26));
  const b = String.fromCharCode(65 + (Math.floor(idx / 26) % 26));
  const c = String.fromCharCode(65 + (idx % 26));
  return `[OPT-${a}${b}${c}]`;
}

export function buildDistractorRules(count = 490) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const [topic, action] = DISTRACTOR_TEMPLATES[i % DISTRACTOR_TEMPLATES.length];
    const variant = Math.floor(i / DISTRACTOR_TEMPLATES.length) + 1;
    const tag = indexToAlphaTag(i);
    out.push({
      dimIndex: -1,
      dimCode: `DIST_${i + 1}`,
      trigger: tag,
      text: `When user prompt includes ${tag} (policy group ${topic}, profile ${variant}), ${action} and label the step cleanly.`
    });
  }
  return out;
}

/**
 * 20 unique 5-of-10 subsets where each of the 10 rules appears in exactly 10 probes
 * (pairs of complement masks cover all 10 rules uniformly!).
 */
const PROBE_MASKS = [
  [0, 1, 2, 3, 4], [5, 6, 7, 8, 9],
  [0, 1, 2, 5, 6], [3, 4, 7, 8, 9],
  [0, 1, 3, 5, 7], [2, 4, 6, 8, 9],
  [0, 1, 4, 6, 8], [2, 3, 5, 7, 9],
  [0, 2, 3, 6, 9], [1, 4, 5, 7, 8],
  [0, 2, 4, 7, 9], [1, 3, 5, 6, 8],
  [0, 3, 4, 5, 8], [1, 2, 6, 7, 9],
  [0, 5, 6, 8, 9], [1, 2, 3, 4, 7],
  [0, 2, 5, 8, 9], [1, 3, 4, 6, 7],
  [0, 3, 6, 7, 8], [1, 2, 4, 5, 9]
];

const TOPIC_QUESTIONS = [
  'Briefly explain why immutable identifiers simplify distributed debugging.',
  'Briefly summarize why bounded retries prevent cascading upstream overload.',
  'Briefly describe why checksums detect silent file corruption after transfer.',
  'Briefly explain the benefit of separating static configuration from volatile input.',
  'Briefly state why read-only handles prevent accidental mutation of shared stores.',
  'Briefly describe how structured audit records speed up incident triage.',
  'Briefly explain why deterministic key ordering stabilizes content digests.',
  'Briefly describe why clean error propagation helps callers recover safely.',
  'Briefly explain how queue depth caps protect worker memory stability.',
  'Briefly state why keeping worker tasks independent simplifies failure recovery.',
  'Briefly explain why explicit schema boundaries reduce integration defects.',
  'Briefly describe how local dry runs catch format errors prior to deployment.',
  'Briefly explain why concise progress summaries improve long task handoffs.',
  'Briefly state the advantage of grouping related constants in one module.',
  'Briefly describe why append-only logs simplify crash resumption.',
  'Briefly explain why explicit resource teardown avoids leaked handles.',
  'Briefly describe how monotonic timestamps avoid clock skew ordering bugs.',
  'Briefly state why isolating external secrets keeps build artifacts portable.',
  'Briefly explain why incremental validation catches regressions sooner.',
  'Briefly describe how tail-appended updates preserve stable shared headers.'
];

export function build20Probes() {
  return PROBE_MASKS.map((activeDims, idx) => {
    const tags = activeDims.map((d) => TRIGGER_TAGS[d]);
    const question = TOPIC_QUESTIONS[idx];
    return {
      probeIndex: idx + 1,
      activeDims,
      activeCodes: activeDims.map((d) => DIMENSION_CODES[d]),
      tags,
      question,
      userPrompt: [
        `Active triggers for this task: ${tags.join(' ')}`,
        `Task: ${question}`,
        'Obey ONLY the conditional rules whose trigger markers appear in the active triggers line above.'
      ].join('\n')
    };
  });
}

/**
 * Builds an interleaved rulebook of size S for a given seedName.
 * Places the 10 active seed rules at evenly spaced slots across [0..S-1].
 */
export function buildInterleavedRulebook({ S, seedName, extraOffset = 0 }) {
  if (S < 10 || S > 500) throw new Error(`S must be in [10..500], got ${S}`);
  const seedRules = buildSeedRules(seedName);
  const distractors = buildDistractorRules(Math.max(0, S - 10));

  const targetPositions = [];
  const used = new Set();
  for (let k = 0; k < 10; k += 1) {
    let pos = Math.floor(((k + 0.5) * S) / 10);
    pos = Math.max(0, Math.min(S - 1, pos));
    while (used.has(pos)) pos = (pos + 1) % S;
    used.add(pos);
    targetPositions.push(pos);
  }

  const ordered = new Array(S);
  targetPositions.forEach((pos, k) => {
    ordered[pos] = seedRules[k];
  });

  let di = 0;
  for (let i = 0; i < S; i += 1) {
    if (!ordered[i]) {
      const shifted = distractors[(di + extraOffset) % distractors.length];
      ordered[i] = shifted;
      di += 1;
    }
  }

  const lines = ordered.map((r, i) => `RULE_${String(i + 1).padStart(3, '0')}: ${r.text}`);
  return {
    S,
    seedName,
    activeRulePositions: targetPositions.map((p) => p + 1),
    rulebookText: [
      `FOLLOW ALL APPLICABLE CONDITIONAL RULES BELOW (RULEBOOK SIZE: ${S} RULES; SEED PROFILE: ${seedName}).`,
      'Every rule only activates when its exact trigger tag appears in the user prompt.',
      'Do NOT explain which rules you followed; emit ONLY the compliant response.',
      '',
      ...lines
    ].join('\n'),
    seedRules
  };
}

export function evaluateProbeResponse({ seedName, activeDims, responseText }) {
  const rules = buildSeedRules(seedName);
  const perRule = {};
  let passedCount = 0;
  for (const dim of activeDims) {
    const rule = rules[dim];
    const ok = Boolean(rule.check(responseText));
    perRule[rule.dimCode] = ok;
    if (ok) passedCount += 1;
  }
  return {
    passedCount,
    totalActive: activeDims.length,
    strictAllPassed: passedCount === activeDims.length,
    perRule
  };
}

export function buildCompliantSampleForTest(seedName, activeDims) {
  const s = SEED_SPECS[seedName];
  const has = (d) => activeDims.includes(d);

  const lines = [];
  // Line 1: header if HDR, still safe if not
  lines.push(`${has(0) ? `${s.hdrPrefix} ` : ''}Summary of reliable engineering behavior using stored state and units.`);

  // Body filler lines ensuring word count stays comfortably inside [30..50]
  if (has(6)) {
    for (let b = 0; b < s.bulletCount; b += 1) {
      lines.push(`${s.bulletMarker} Item covers steady state safety and clean operation.`);
    }
  } else {
    lines.push('System operations stay predictable across isolated steps and careful checks without ambiguity.');
  }

  if (has(9)) {
    lines.push(`${s.metaPrefix} Verified steady state operation cleanly`);
  }

  const extraTokens = [];
  if (has(2)) extraTokens.push(s.badgeToken);
  if (has(4)) extraTokens.push(s.kwToken);
  extraTokens.push('All details remain clear and concise.');
  lines.push(extraTokens.join(' '));

  if (has(1)) {
    lines.push(s.endSentinel);
  }
  return lines.join('\n');
}

function runSelfTest() {
  const probes = build20Probes();
  if (probes.length !== 20) throw new Error('Expected 20 probes');

  // Verify uniqueness and exact balance (10 occurrences per rule)
  const counts = new Array(10).fill(0);
  const maskKeys = new Set();
  for (const p of probes) {
    const key = p.activeDims.join(',');
    if (maskKeys.has(key)) throw new Error(`Duplicate probe mask: ${key}`);
    maskKeys.add(key);
    if (p.activeDims.length !== 5) throw new Error(`Probe ${p.probeIndex} does not have 5 dims`);
    for (const d of p.activeDims) counts[d] += 1;
  }
  for (let d = 0; d < 10; d += 1) {
    if (counts[d] !== 10) throw new Error(`Rule dim ${d} appears ${counts[d]} times, expected 10`);
  }

  // Test all 3 seeds x 20 probes compliant + 10 single-violation mutants per probe
  let totalChecks = 0;
  for (const { name } of SEEDS) {
    for (const p of probes) {
      const good = buildCompliantSampleForTest(name, p.activeDims);
      const ev = evaluateProbeResponse({ seedName: name, activeDims: p.activeDims, responseText: good });
      if (!ev.strictAllPassed) {
        throw new Error(`Compliant sample failed for seed=${name} probe=${p.probeIndex}: ${JSON.stringify(ev.perRule)}\n${good}`);
      }
      totalChecks += 1;

      // Also test targeted failure detection on active dims
      const s = SEED_SPECS[name];
      const breakFn = {
        0: (t) => `WRONG_START ${t}`,
        1: (t) => t.replace(s.endSentinel, 'END_WRONG'),
        2: (t) => t.replace(s.badgeToken, '[NOPE]'),
        3: (t) => `${t}\nAdded forbidden word: ${name === 'ALPHA' ? 'cache' : name === 'BRAVO' ? 'tokens' : 'model'}.`,
        4: (t) => t.replace(s.kwToken, s.kwToken.toLowerCase()),
        5: (t) => `${t}\nCount 9 items.`,
        6: (t) => `${t}\n${s.bulletMarker} Extra unexpected bullet line`,
        7: (t) => `${t} ${'word '.repeat(60)}`,
        8: (t) => `${t} ${name === 'BRAVO' ? 'why?' : 'alert!'}`,
        9: (t) => t.replace(`${s.metaPrefix} `, 'OTHER_NOTE: ')
      };
      for (const dim of p.activeDims) {
        const broken = breakFn[dim](good);
        const brokenEv = evaluateProbeResponse({ seedName: name, activeDims: p.activeDims, responseText: broken });
        const code = DIMENSION_CODES[dim];
        if (brokenEv.perRule[code] !== false) {
          throw new Error(`Mutant failed to trip rule ${code} on seed=${name} probe=${p.probeIndex}`);
        }
        totalChecks += 1;
      }
    }

    const rb500 = buildInterleavedRulebook({ S: 500, seedName: name });
    if (rb500.activeRulePositions.length !== 10) throw new Error('Bad active positions');
    // Confirm zero digits accidentally leaked into rule triggers or banned checks
    for (const p of probes) {
      if (/\d/.test(p.userPrompt)) throw new Error(`Probe ${p.probeIndex} userPrompt contains digits!`);
    }
  }

  console.log(`rules_500_catalog.mjs self-test PASS (${totalChecks} compliant/mutant assertions across 3 seeds x 20 probes).`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv.includes('--self-test')) {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
  }
}
