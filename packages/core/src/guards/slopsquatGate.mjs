/**
 * @file src/core-isomorphic/guards/slopsquatGate.mjs
 * Guardrail #6 (`SLOPSQUAT_DEP_GATE`): Supply-Chain Slopsquatting & Conflation Gate.
 *
 * Pure isomorphic module (Mod Law 4 compliant: zero `node:*` imports, zero network I/O).
 * - Phase 1 (`<5ms` offline): Parses `npm`/`pnpm`/`yarn`/`bun`/`pip`/`uv`/`poetry`/`cargo` install commands,
 *   auto-allows existing manifest/lockfile deps, `workspace:*`/`file:` protocols, and private `.npmrc` /
 *   `--index-url` scopes, and detects Damerau-Levenshtein-1 typos + empirical LLM package conflations.
 * - Phase 2 (Optional metadata evaluation): Evaluates registry metadata with strict fail-open semantics
 *   on offline/timeout faults (`0%` false-deny on airgapped or private-registry environments).
 */

/**
 * Canonical high-traffic packages across npm, PyPI, and Crates used for distance-1 slopsquat detection.
 */
export const POPULAR_ECOSYSTEM_PACKAGES = Object.freeze({
  npm: Object.freeze([
    'react', 'react-dom', 'next', 'vue', 'svelte', 'angular', 'solid-js', 'preact',
    'express', 'fastify', 'koa', 'hono', 'nestjs', 'socket.io', 'ws', 'cors', 'helmet',
    'lodash', 'underscore', 'ramda', 'immer', 'rxjs', 'zustand', 'jotai', 'redux',
    'axios', 'node-fetch', 'undici', 'ky', 'got', 'superagent', 'graphql', 'apollo-server',
    'typescript', 'tslib', 'tsx', 'ts-node', 'esbuild', 'vite', 'rollup', 'webpack', 'parcel',
    'eslint', 'prettier', 'biome', 'stylelint', 'husky', 'lint-staged', 'jscodeshift',
    'vitest', 'jest', 'mocha', 'chai', 'sinon', 'playwright', 'cypress', 'puppeteer',
    'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'less', 'clsx', 'classnames', 'tailwind-merge',
    'lucide-react', 'heroicons', 'framer-motion', 'radix-ui', 'cmdk', 'sonner', 'vaul',
    'zod', 'yup', 'joi', 'valibot', 'ajv', 'superstruct', 'typebox',
    'prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'sequelize', 'mongoose', 'knex', 'pg',
    'mysql2', 'sqlite3', 'better-sqlite3', 'ioredis', 'redis', 'mongodb',
    'dotenv', 'cross-env', 'chalk', 'picocolors', 'kleur', 'ora', 'inquirer', 'prompts',
    'commander', 'yargs', 'minimist', 'cac', 'arg', 'execa', 'zx', 'glob', 'fast-glob', 'chokidar',
    'date-fns', 'dayjs', 'moment', 'luxon', 'uuid', 'nanoid', 'ulid', 'semver', 'ms', 'debug',
    'jsonwebtoken', 'jose', 'bcrypt', 'bcryptjs', 'argon2', 'passport', 'next-auth', 'lucia',
    'stripe', 'openai', 'anthropic', 'langchain', 'ai', 'cheerio', 'jsdom', 'marked', 'shiki',
    'winston', 'pino', 'morgan', 'sentry', 'bullmq', 'nodemailer', 'resend', 'sharp', 'multer'
  ]),
  pypi: Object.freeze([
    'requests', 'urllib3', 'httpx', 'aiohttp', 'fastapi', 'uvicorn', 'starlette', 'flask',
    'django', 'gunicorn', 'celery', 'werkzeug', 'jinja2', 'itsdangerous', 'click', 'typer',
    'rich', 'tqdm', 'colorama', 'loguru', 'structlog', 'pydantic', 'pydantic-settings',
    'marshmallow', 'attrs', 'sqlalchemy', 'alembic', 'psycopg2', 'psycopg2-binary', 'asyncpg',
    'pymongo', 'redis', 'pymysql', 'aiosqlite', 'peewee', 'tortoise-orm', 'sqlmodel',
    'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'plotly', 'polars', 'pyarrow',
    'scikit-learn', 'torch', 'torchvision', 'torchaudio', 'tensorflow', 'keras', 'jax',
    'transformers', 'datasets', 'accelerate', 'diffusers', 'tokenizers', 'huggingface-hub',
    'openai', 'anthropic', 'langchain', 'llama-index', 'tiktoken', 'chromadb', 'qdrant-client',
    'pytest', 'pytest-asyncio', 'pytest-cov', 'hypothesis', 'coverage', 'mypy', 'ruff', 'black',
    'isort', 'flake8', 'pylint', 'bandit', 'pre-commit', 'tox', 'nox', 'virtualenv', 'poetry',
    'boto3', 'botocore', 's3transfer', 'google-cloud-storage', 'azure-storage-blob',
    'cryptography', 'pyjwt', 'bcrypt', 'passlib', 'pynacl', 'certifi', 'charset-normalizer',
    'idna', 'pyyaml', 'toml', 'tomli', 'python-dotenv', 'python-multipart', 'python-dateutil',
    'pytz', 'arrow', 'pendulum', 'pillow', 'opencv-python', 'beautifulsoup4', 'lxml', 'scrapy',
    'selenium', 'playwright', 'paramiko', 'fabric', 'psutil', 'tenacity', 'orjson', 'ujson'
  ]),
  cargo: Object.freeze([
    'serde', 'serde_json', 'tokio', 'reqwest', 'clap', 'anyhow', 'thiserror', 'tracing',
    'tracing-subscriber', 'futures', 'async-trait', 'axum', 'actix-web', 'hyper', 'tower',
    'sqlx', 'diesel', 'rusqlite', 'redis', 'rand', 'regex', 'chrono', 'time', 'uuid',
    'itertools', 'rayon', 'crossbeam', 'parking_lot', 'once_cell', 'lazy_static', 'bytes',
    'log', 'env_logger', 'eyre', 'color-eyre', 'tempfile', 'proptest', 'criterion', 'syn',
    'quote', 'proc-macro2', 'bindgen', 'cc', 'sha2', 'hmac', 'base64', 'hex', 'url', 'dotenvy'
  ])
});

/**
 * Empirically observed LLM package hallucinations & cross-package conflations (USENIX / Socket / Phylum).
 */
export const KNOWN_LLM_CONFLATIONS = Object.freeze({
  'react-codeshift': 'Conflation of `jscodeshift` and `react-codemod`',
  'unused-imports': 'Conflation of `eslint-plugin-unused-imports`',
  'nextjs-auth': 'Hallucinated conflation of `next-auth`',
  'tailwind-merge-classes': 'Hallucinated conflation of `tailwind-merge` + `clsx`',
  'zod-validator': 'Hallucinated wrapper around `zod`',
  'prisma-orm': 'Hallucinated alias for `prisma` / `@prisma/client`',
  'lucide-icons': 'Hallucinated conflation of `lucide-react`',
  'shadcn-ui-react': 'Hallucinated npm package (`shadcn` uses CLI component copy)',
  'express-jwt-auth': 'Hallucinated conflation of `express-jwt`',
  'axios-retry-client': 'Hallucinated conflation of `axios-retry`',
  'jest-dom-extended': 'Hallucinated conflation of `@testing-library/jest-dom`',
  'chalk-cli-colors': 'Hallucinated conflation of `chalk` + `cli-color`',
  'dotenv-safe-cli': 'Hallucinated conflation of `dotenv-safe` + `dotenv-cli`',
  'huggingface-cli': 'PyPI slopsquat for `huggingface-hub` (which provides the `huggingface-cli` binary)',
  'fastapi-cors': 'Hallucinated PyPI package (`CORSMiddleware` is built into `fastapi`)',
  'openai-whisper-api': 'Hallucinated conflation of `openai` + `openai-whisper`',
  'python-dotenv-cli': 'Hallucinated conflation of `python-dotenv`',
  'boto3-stubs-all': 'Hallucinated conflation of `boto3-stubs`',
  'urllib4': 'Hallucinated successor to `urllib3`',
  'sklearn-utils': 'Hallucinated companion to `scikit-learn`'
});

const FLAGS_WITH_VALUE = new Set([
  '--registry',
  '--index-url',
  '--extra-index-url',
  '-i',
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-w',
  '--workspace',
  '--filter',
  '--prefix',
  '-C',
  '--dir',
  '--features',
  '--trusted-host',
  '--target',
  '-t',
  '--cache-dir',
  '--find-links',
  '-f'
]);

/**
 * Computes optimal string alignment (Damerau-Levenshtein) distance with fast early exit for `> 1`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} `0`, `1`, or `2` (`2` means distance `>= 2`)
 */
export function damerauLevenshteinMax1(a = '', b = '') {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return 2;

  const prevPrev = new Array(lb + 1).fill(0);
  const prev = new Array(lb + 1).fill(0);
  const curr = new Array(lb + 1).fill(0);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prevPrev[j - 2] + 1);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > 1) return 2;
    for (let j = 0; j <= lb; j++) {
      prevPrev[j] = prev[j];
      prev[j] = curr[j];
    }
  }
  return prev[lb] <= 1 ? prev[lb] : 2;
}

/**
 * Normalizes a package specifier token into `{ name, raw, isLocalOrProtocol, scope }`.
 *
 * @param {string} rawSpec
 * @param {'npm' | 'pypi' | 'cargo'} ecosystem
 */
export function normalizePackageSpec(rawSpec = '', ecosystem = 'npm') {
  const raw = String(rawSpec || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;

  if (
    raw === '.' ||
    raw.startsWith('./') ||
    raw.startsWith('../') ||
    raw.startsWith('/') ||
    raw.startsWith('workspace:') ||
    raw.startsWith('file:') ||
    raw.startsWith('link:') ||
    raw.startsWith('portal:') ||
    raw.startsWith('git+') ||
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    raw.startsWith('github:') ||
    /\.(?:tgz|tar\.gz|whl|zip)$/i.test(raw)
  ) {
    return { raw, name: raw, scope: '', isLocalOrProtocol: true };
  }

  if (ecosystem === 'npm') {
    if (raw.startsWith('@')) {
      const slashIdx = raw.indexOf('/');
      if (slashIdx <= 1) return null;
      const scope = raw.slice(0, slashIdx).toLowerCase();
      const rest = raw.slice(slashIdx + 1);
      const atVerIdx = rest.indexOf('@');
      const pkgPart = atVerIdx > 0 ? rest.slice(0, atVerIdx) : rest;
      const verPart = atVerIdx > 0 ? rest.slice(atVerIdx + 1) : '';
      if (verPart.startsWith('workspace:') || verPart.startsWith('file:') || verPart.startsWith('link:')) {
        return { raw, name: `${scope}/${pkgPart}`.toLowerCase(), scope, isLocalOrProtocol: true };
      }
      return {
        raw,
        name: `${scope}/${pkgPart}`.toLowerCase(),
        scope,
        isLocalOrProtocol: false
      };
    }
    const atIdx = raw.indexOf('@');
    const name = (atIdx > 0 ? raw.slice(0, atIdx) : raw).toLowerCase();
    const verPart = atIdx > 0 ? raw.slice(atIdx + 1) : '';
    if (verPart.startsWith('workspace:') || verPart.startsWith('file:') || verPart.startsWith('link:')) {
      return { raw, name, scope: '', isLocalOrProtocol: true };
    }
    return { raw, name, scope: '', isLocalOrProtocol: false };
  }

  if (ecosystem === 'pypi') {
    // Strip extras `pkg[standard]` and PEP 440 version operators `==`, `>=`, `<=`, `~=`, `!=`, `<`, `>`
    const base = raw.split(/[=<>~!;\s[]/)[0].trim().toLowerCase().replace(/_/g, '-');
    if (!base) return null;
    return { raw, name: base, scope: '', isLocalOrProtocol: false };
  }

  // cargo
  const base = raw.split('@')[0].trim().toLowerCase();
  return base ? { raw, name: base, scope: '', isLocalOrProtocol: false } : null;
}

/**
 * Parses a shell command string to extract package-manager install invocations.
 *
 * @param {string} command
 * @returns {Array<{ ecosystem: 'npm'|'pypi'|'cargo', manager: string, packages: Array<object>, hasCustomRegistry: boolean, isLockfileSyncOnly: boolean }>}
 */
export function parsePackageInstallCommands(command = '') {
  const cmdText = String(command || '').trim();
  if (!cmdText) return [];

  const segments = cmdText.split(/\s*(?:&&|\|\||;|\n)\s*/).filter(Boolean);
  const invocations = [];

  for (const seg of segments) {
    const tokens = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (tokens.length === 0) continue;

    // Strip leading env assignments `FOO=bar`
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx += 1;
    if (idx >= tokens.length) continue;

    const bin = tokens[idx].replace(/^['"]|['"]$/g, '').toLowerCase();
    let ecosystem = null;
    let manager = bin;
    let argStart = -1;
    let isLockfileSyncOnly = false;

    if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') {
      const sub = (tokens[idx + 1] || '').toLowerCase();
      if (sub === 'ci' || sub === 'dedupe') {
        invocations.push({
          ecosystem: 'npm',
          manager: bin,
          packages: [],
          hasCustomRegistry: false,
          isLockfileSyncOnly: true
        });
        continue;
      }
      if (['install', 'i', 'add', 'in', 'ins'].includes(sub)) {
        ecosystem = 'npm';
        argStart = idx + 2;
      } else if (bin === 'yarn' && !sub.startsWith('-') && tokens.length === idx + 1) {
        isLockfileSyncOnly = true;
        invocations.push({
          ecosystem: 'npm',
          manager: 'yarn',
          packages: [],
          hasCustomRegistry: false,
          isLockfileSyncOnly
        });
        continue;
      }
    } else if (bin === 'pip' || bin === 'pip3') {
      if ((tokens[idx + 1] || '').toLowerCase() === 'install') {
        ecosystem = 'pypi';
        argStart = idx + 2;
      }
    } else if ((bin === 'python' || bin === 'python3') && tokens[idx + 1] === '-m' && /^pip3?$/i.test(tokens[idx + 2] || '')) {
      if ((tokens[idx + 3] || '').toLowerCase() === 'install') {
        ecosystem = 'pypi';
        manager = 'pip';
        argStart = idx + 4;
      }
    } else if (bin === 'uv') {
      const sub = (tokens[idx + 1] || '').toLowerCase();
      if (sub === 'add') {
        ecosystem = 'pypi';
        argStart = idx + 2;
      } else if (sub === 'pip' && (tokens[idx + 2] || '').toLowerCase() === 'install') {
        ecosystem = 'pypi';
        argStart = idx + 3;
      }
    } else if (bin === 'poetry' && (tokens[idx + 1] || '').toLowerCase() === 'add') {
      ecosystem = 'pypi';
      argStart = idx + 2;
    } else if (bin === 'cargo' && (tokens[idx + 1] || '').toLowerCase() === 'add') {
      ecosystem = 'cargo';
      argStart = idx + 2;
    }

    if (!ecosystem || argStart < 0) continue;

    let hasCustomRegistry = false;
    let hasRequirementManifestFlag = false;
    let hasCargoLocalOrGit = false;
    const rawPkgSpecs = [];

    for (let i = argStart; i < tokens.length; i++) {
      const tok = tokens[i].replace(/^['"]|['"]$/g, '');
      if (!tok) continue;

      if (
        tok.startsWith('--registry=') ||
        tok.startsWith('--index-url=') ||
        tok.startsWith('--extra-index-url=')
      ) {
        hasCustomRegistry = true;
        continue;
      }
      if (tok === '--registry' || tok === '--index-url' || tok === '--extra-index-url' || tok === '-i') {
        hasCustomRegistry = true;
        i += 1;
        continue;
      }
      if (tok === '-r' || tok === '--requirement' || tok.startsWith('--requirement=')) {
        hasRequirementManifestFlag = true;
        if (tok === '-r' || tok === '--requirement') i += 1;
        continue;
      }
      if (tok === '-e' || tok === '--editable') {
        const nextTok = (tokens[i + 1] || '').replace(/^['"]|['"]$/g, '');
        if (nextTok.startsWith('.') || nextTok.startsWith('/')) {
          i += 1;
          continue;
        }
      }
      if (ecosystem === 'cargo' && (tok === '--path' || tok === '--git')) {
        hasCargoLocalOrGit = true;
        i += 1;
        continue;
      }
      if (FLAGS_WITH_VALUE.has(tok)) {
        i += 1;
        continue;
      }
      if (tok.startsWith('-')) continue;

      const parsed = normalizePackageSpec(tok, ecosystem);
      if (parsed) rawPkgSpecs.push(parsed);
    }

    if (hasCargoLocalOrGit && rawPkgSpecs.every((p) => !p.raw.includes('@'))) {
      for (const p of rawPkgSpecs) p.isLocalOrProtocol = true;
    }

    invocations.push({
      ecosystem,
      manager,
      packages: rawPkgSpecs,
      hasCustomRegistry,
      isLockfileSyncOnly: rawPkgSpecs.length === 0 && !hasRequirementManifestFlag
        ? true
        : rawPkgSpecs.length === 0 && hasRequirementManifestFlag
    });
  }

  return invocations;
}

/**
 * Evaluates Guardrail #6 (`SLOPSQUAT_DEP_GATE`) across Phase 1 (offline `<5ms`) and optional Phase 2 metadata.
 *
 * @param {object} input
 * @param {string} input.command
 * @param {Iterable<string>} [input.manifestDeps] - Existing manifest/lockfile package names
 * @param {Iterable<string>} [input.workspacePackages] - Monorepo workspace package names
 * @param {Iterable<string>} [input.privateScopes] - Private scopes from `.npmrc` (e.g. `['@corp', '@internal']`)
 * @param {Record<string, { exists?: boolean, ageDays?: number, weeklyDownloads?: number, offline?: boolean, timedOut?: boolean, error?: string }>} [input.registryMetadata]
 */
export function evaluateSlopsquatCommand(input = {}) {
  const invocations = parsePackageInstallCommands(input.command || '');
  if (invocations.length === 0) {
    return {
      triggered: false,
      decision: 'allow',
      reason: 'No package install invocation detected',
      findings: [],
      tokensSavedEst: 0
    };
  }

  const manifestSet = new Set(
    Array.from(input.manifestDeps || [], (d) => String(d).toLowerCase().replace(/_/g, '-'))
  );
  const workspaceSet = new Set(
    Array.from(input.workspacePackages || [], (d) => String(d).toLowerCase())
  );
  const privateScopeSet = new Set(
    Array.from(input.privateScopes || [], (s) =>
      (String(s).startsWith('@') ? String(s) : `@${s}`).toLowerCase()
    )
  );
  const registryMetaMap = input.registryMetadata || null;

  const findings = [];

  for (const inv of invocations) {
    if (inv.isLockfileSyncOnly || inv.packages.length === 0) continue;

    const canonicalList = POPULAR_ECOSYSTEM_PACKAGES[inv.ecosystem] || [];
    const canonicalSet = new Set(canonicalList.map((p) => p.toLowerCase()));

    for (const pkg of inv.packages) {
      if (pkg.isLocalOrProtocol) continue;
      const normalizedKey =
        inv.ecosystem === 'pypi' ? pkg.name.replace(/_/g, '-') : pkg.name.toLowerCase();

      // 1. Existing manifest / lockfile / monorepo workspace allowlist
      if (
        manifestSet.has(normalizedKey) ||
        manifestSet.has(pkg.name) ||
        workspaceSet.has(pkg.name)
      ) {
        continue;
      }

      // 2. Private `.npmrc` scope or custom `--registry` / `--index-url` allowlist (0% false-deny!)
      if (pkg.scope && privateScopeSet.has(pkg.scope)) {
        continue;
      }
      if (inv.hasCustomRegistry) {
        continue;
      }

      // 3. Canonical popular package fast-allow
      if (canonicalSet.has(normalizedKey)) {
        continue;
      }

      // 4. Phase 1a: Known LLM package conflation / hallucination dictionary
      if (Object.prototype.hasOwnProperty.call(KNOWN_LLM_CONFLATIONS, normalizedKey)) {
        findings.push({
          package: pkg.name,
          ecosystem: inv.ecosystem,
          phase: 1,
          kind: 'LLM_CONFLATION',
          detail: KNOWN_LLM_CONFLATIONS[normalizedKey]
        });
        continue;
      }

      // 5. Phase 1b: Damerau-Levenshtein distance == 1 against canonical ecosystem top list
      let closestTarget = null;
      if (normalizedKey.length >= 4) {
        for (const popular of canonicalList) {
          if (damerauLevenshteinMax1(normalizedKey, popular) === 1) {
            closestTarget = popular;
            break;
          }
        }
      }
      if (closestTarget) {
        findings.push({
          package: pkg.name,
          ecosystem: inv.ecosystem,
          phase: 1,
          kind: 'TYPOSQUAT_DISTANCE_1',
          suggestedPackage: closestTarget,
          detail: `Edit-distance 1 from canonical \`${closestTarget}\``
        });
        continue;
      }

      // 6. Phase 1c: Suspicious LLM affix hallucination (`<popular>-official`, `python-<popular>` when canonical exists)
      const strippedAffix = normalizedKey
        .replace(/^(?:python-|py-|node-|npm-)/, '')
        .replace(/(?:-official|-sdk-v2|-js-sdk|-py)$/, '');
      if (
        strippedAffix !== normalizedKey &&
        strippedAffix.length >= 4 &&
        canonicalSet.has(strippedAffix)
      ) {
        findings.push({
          package: pkg.name,
          ecosystem: inv.ecosystem,
          phase: 1,
          kind: 'AFFIX_HALLUCINATION',
          suggestedPackage: strippedAffix,
          detail: `Suspicious affix wrapper around canonical \`${strippedAffix}\``
        });
        continue;
      }

      // 7. Phase 2 (Opt-in / Mocked Registry Metadata): Fail-open on offline/timeout!
      if (registryMetaMap && Object.prototype.hasOwnProperty.call(registryMetaMap, pkg.name)) {
        const meta = registryMetaMap[pkg.name] || {};
        if (meta.offline || meta.timedOut || meta.error) {
          // Strict fail-open: never block or nag when offline or timed out on unflagged packages
          continue;
        }
        if (meta.exists === false) {
          findings.push({
            package: pkg.name,
            ecosystem: inv.ecosystem,
            phase: 2,
            kind: 'UNPUBLISHED_404_HALLUCINATION',
            detail: `Package \`${pkg.name}\` returned 404 Not Found on ${inv.ecosystem} registry`
          });
        } else if (
          typeof meta.ageDays === 'number' &&
          meta.ageDays < 14 &&
          typeof meta.weeklyDownloads === 'number' &&
          meta.weeklyDownloads < 50
        ) {
          findings.push({
            package: pkg.name,
            ecosystem: inv.ecosystem,
            phase: 2,
            kind: 'LOW_REPUTATION_NEW_PACKAGE',
            detail: `Newly published (${meta.ageDays}d old, ${meta.weeklyDownloads} weekly downloads)`
          });
        }
      }
    }
  }

  if (findings.length === 0) {
    return {
      triggered: false,
      decision: 'allow',
      reason: 'All package specifiers verified or allowlisted',
      findings: [],
      tokensSavedEst: 0
    };
  }

  // Always use human-in-the-loop `ask` (never blind `deny` that blocks legitimate obscure packages)
  return {
    triggered: true,
    decision: 'ask',
    code: 'SLOPSQUAT_DEP_GATE',
    reason: `[Quota & Supply-Chain Shield] Unverified package install (${findings
      .map((f) => `${f.package}: ${f.detail}`)
      .join('; ')}). Confirm package name before running install scripts.`,
    findings,
    tokensSavedEst: 1800
  };
}
