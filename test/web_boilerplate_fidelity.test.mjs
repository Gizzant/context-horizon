/**
 * @file test/web_boilerplate_fidelity.test.mjs
 * Bucket B Sub-Wave B-Alpha — Guardrail #9 (`WEB_BOILERPLATE_BUDGETER`) Fidelity & Token-Reduction Suite.
 *
 * Corpus:
 * - 20 bloated HTML fixtures (MDN Reference, GitHub Issue, Next.js `__NEXT_DATA__` hydration payload,
 *   API Pricing/Comparison Table, StackOverflow Q&A, Stripe Webhook Spec, Rust Crate Docs, etc.)
 *   containing heavy `<nav>`, `<footer>`, `<svg>`, inline `<style>`, cookie banners, and hydration JSON.
 *
 * Promotion SLA:
 * - `100%` lossless `<code>`, `<pre>`, and `<table>` cell preservation (`fidelityRate === 1.0`)
 * - `>= 80%` average token reduction (`avgTokenReductionPct >= 80`)
 * - `p99 < 15ms`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { distillHtmlWebPayload } from '../src/core-isomorphic/guards/bucketBHeuristics.mjs';
import { runBucketBExperiment } from './helpers/bucket_b_harness.mjs';

function makeHeavyChromePage({ title, heading, prose, preBlock, inlineCodes, tableRows, variantIdx }) {
  const navLinks = Array.from(
    { length: 45 },
    (_v, i) => `<li class="nav-item-${i}" data-track="menu-${variantIdx}-${i}"><a href="/docs/section-${i}/subsection-${i}">Navigation Link Item ${i}</a></li>`
  ).join('\n');

  const svgIcons = Array.from(
    { length: 12 },
    (_v, i) => `<svg viewBox="0 0 1024 1024" width="24" height="24" class="icon-${i}"><path d="${'M10 10 H 90 V 90 H 10 Z '.repeat(18)}" fill="#999"/></svg>`
  ).join('\n');

  const inlineCss = `<style>${Array.from(
    { length: 50 },
    (_v, i) => `.layout-grid-wrapper-${i} { display: flex; padding: ${i}px; background: linear-gradient(90deg, #111, #222); }`
  ).join('\n')}</style>`;

  const hydrationJson = JSON.stringify({
    props: {
      pageProps: {
        sidebarTree: Array.from({ length: 60 }, (_v, i) => ({
          id: `node-${variantIdx}-${i}`,
          slug: `/reference/v4/category-${i}/endpoint-${i}`,
          analyticsHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
        }))
      }
    }
  });

  const tableHtml = `
    <table class="api-spec-table" data-testid="spec-${variantIdx}">
      <thead>
        <tr>${tableRows[0].map((h) => `<th scope="col">${h}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${tableRows
          .slice(1)
          .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
          .join('\n')}
      </tbody>
    </table>
  `;

  const inlineHtml = inlineCodes.map((c) => `<code>${c}</code>`).join(' and ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  ${inlineCss}
  <script id="__NEXT_DATA__" type="application/json">${hydrationJson}</script>
</head>
<body class="theme-dark antialiased">
  <header class="site-header"><nav aria-label="Main">${navLinks}</nav>${svgIcons}</header>
  <div id="cookie-consent-banner" class="cookie-consent gdpr-modal">
    We use cookies for analytics, marketing, and session replay. Manage preferences or accept all cookies.
  </div>
  <aside class="toc-sidebar">${navLinks}</aside>
  <main class="doc-article" data-hydrated="true">
    <h1>${heading}</h1>
    <p>${prose} Refer to ${inlineHtml} below.</p>
    <pre><code class="language-ts">${preBlock
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</code></pre>
    ${tableHtml}
  </main>
  <div class="newsletter-signup promo-banner">Subscribe to our developer newsletter for product updates!</div>
  <footer class="site-footer">${navLinks}${svgIcons}</footer>
</body>
</html>`;
}

function buildHtmlFidelityDataset() {
  const specs = [
    {
      name: 'MDN Array.prototype.reduce',
      pre: 'const sum = items.reduce((acc, cur) => acc + cur.price, 0);\nif (sum < 0 && items.length > 0) throw new RangeError("invalid");',
      codes: ['Array.prototype.reduce()', 'initialValue'],
      table: [
        ['Parameter', 'Type', 'Required'],
        ['callbackFn', '(acc, cur, idx) => any', 'Yes'],
        ['initialValue', 'any', 'Optional']
      ]
    },
    {
      name: 'GitHub Issue #4812 Race Condition',
      pre: 'await lock.acquire("session:42");\ntry {\n  await db.exec("BEGIN IMMEDIATE");\n} finally {\n  lock.release();\n}',
      codes: ['SQLITE_BUSY', 'PRAGMA busy_timeout = 5000'],
      table: [
        ['Runtime', 'Node 20.11', 'Node 22.6'],
        ['p99 Latency', '4.2ms', '3.8ms'],
        ['Exit Code', '0', '0']
      ]
    },
    {
      name: 'Next.js App Router Fetch Cache',
      pre: 'export async function GET(req: Request) {\n  const res = await fetch(url, { next: { revalidate: 60 } });\n  return Response.json(await res.json());\n}',
      codes: ['force-cache', 'no-store'],
      table: [
        ['Option', 'Cache Behavior', 'TTL'],
        ['force-cache', 'Static cache hit', 'Infinite'],
        ['revalidate: 60', 'ISR background refresh', '60s']
      ]
    },
    {
      name: 'Anthropic & Gemini Prompt Cliff Rate Card',
      pre: 'const cliff = model.includes("haiku") ? 100_000 : 200_000;\nconst surcharge = promptTokens > cliff ? 2.0 : 1.0;',
      codes: ['cache_read_input_tokens', 'cache_creation_input_tokens'],
      table: [
        ['Model', 'Base Input', 'Over-Cliff Input'],
        ['claude-haiku-4-5', '$1.00 / MTok', '$5.00 / MTok'],
        ['gemini-2.5-pro', '$1.25 / MTok', '$2.50 / MTok']
      ]
    },
    {
      name: 'Stripe Webhook Signature Verification',
      pre: 'const event = stripe.webhooks.constructEvent(rawBody, sigHeader, endpointSecret);\nif (event.type === "invoice.paid") return { ok: true };',
      codes: ['Stripe-Signature', 'whsec_test_secret'],
      table: [
        ['Header', 'Format', 'Replay Window'],
        ['Stripe-Signature', 't=timestamp,v1=hmac', '300 seconds'],
        ['Content-Type', 'application/json', 'N/A']
      ]
    }
  ];

  const dataset = [];
  for (let i = 0; i < 20; i++) {
    const spec = specs[i % specs.length];
    const preVariant = `${spec.pre}\n// fixture_case_${i + 1}`;
    const html = makeHeavyChromePage({
      title: `${spec.name} — Documentation Portal (${i + 1})`,
      heading: `${spec.name} (Case ${i + 1})`,
      prose: 'Production API reference covering deterministic request handling and boundary invariants.',
      preBlock: preVariant,
      inlineCodes: spec.codes,
      tableRows: spec.table,
      variantIdx: i + 1
    });

    dataset.push({
      id: `web-html-${i + 1}`,
      category: 'html_distillation_fidelity',
      expectedTrigger: true,
      checkFidelity: true,
      expectedPre: preVariant,
      expectedInlineCodes: spec.codes,
      expectedTableCells: spec.table.flat(),
      payload: { html, webFetchesInTurn: i === 19 ? 6 : 1 }
    });
  }
  return dataset;
}

function verifyHtmlDistillFidelity(item, out) {
  const text = String(out?.distilled || '');
  if (!text.includes(item.expectedPre)) return false;
  for (const code of item.expectedInlineCodes) {
    if (!text.includes(`\`${code}\``)) return false;
  }
  for (const cell of item.expectedTableCells) {
    if (!text.includes(cell)) return false;
  }
  // Must not leak __NEXT_DATA__, <svg>, or cookie banner boilerplate
  if (
    text.includes('__NEXT_DATA__') ||
    text.includes('<svg') ||
    text.includes('cookie-consent')
  ) {
    return false;
  }
  return true;
}

export async function runWebBoilerplateFidelityBenchmark() {
  const dataset = buildHtmlFidelityDataset();
  return runBucketBExperiment({
    id: '#9',
    code: 'WEB_BOILERPLATE_BUDGETER',
    subWave: 'B-Alpha',
    dataset,
    evaluateFn: (item) => distillHtmlWebPayload(item.payload),
    verifyFidelityFn: verifyHtmlDistillFidelity,
    sla: {
      minFidelityRate: 1.0,
      minTokenReductionPct: 80,
      minRecall: 1.0,
      maxP99Ms: 15
    }
  });
}

if (!process.env.CTXTOP_BENCH_IMPORT_ONLY) {
  test('Bucket B #9 WEB_BOILERPLATE_BUDGETER achieves 100% code/table fidelity, >=80% token reduction, and p99 < 15ms', async () => {
    const report = await runWebBoilerplateFidelityBenchmark();
    assert.equal(report.status, 'PROMOTE_READY', `Failed SLA checks: ${report.failedChecks.join(', ')}`);
    assert.equal(report.fidelityRate, 1.0);
    assert.ok(
      report.avgTokenReductionPct >= 80,
      `Expected >= 80% token reduction, got ${report.avgTokenReductionPct}%`
    );
    assert.ok(report.latencyMs.p99 < 15, `Expected p99 < 15ms, got ${report.latencyMs.p99}ms`);
  });
}
