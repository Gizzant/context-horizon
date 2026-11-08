import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUNDLES_DIR = path.join(ROOT, 'evaluation_bundles');

const TIER_1_FILES = [
  'AGENTS.md',
  'README.md',
  'docs/CONTEXT_MEMORY_EVALUATION_GUIDE.md',
  'src/core/classifier.mjs',
  'tests/verify_phase_6_roadmap.mjs'
];

const TIER_2_FILES = [
  ...TIER_1_FILES,
  'scripts/sync_mirrors.mjs',
  'sidecars/horizon-daemon/server.mjs',
  'src/core/baseline.mjs',
  'src/core/constants.mjs',
  'src/core/history.mjs',
  'src/core/host_watchdog.mjs',
  'src/core/offenders.mjs',
  'src/core/parser.mjs',
  'src/core/paths.mjs',
  'src/core/pruner.mjs',
  'src/core/quota.mjs',
  'src/core/settings.mjs',
  'src/core/subagents.mjs',
  'src/core/prompt_rubric.mjs',
  'src/core/session_forensics.mjs',
  'src/core/handoff_audit.mjs',
  'src/webview/horizon_panel.html',
  'tests/verify_e2e_context_memory.mjs',
  'tests/test_postmortem_features.mjs'
];

function wrapNotebookLM(relPath, content) {
  const normRel = relPath.replace(/\\/g, '/');
  if (normRel.endsWith('.md')) {
    return `# Path: ${normRel}\n\n${content}`;
  }
  let lang = 'text';
  if (normRel.endsWith('.mjs') || normRel.endsWith('.js') || normRel.endsWith('.cjs')) {
    lang = 'javascript';
  } else if (normRel.endsWith('.html')) {
    lang = 'html';
  } else if (normRel.endsWith('.json')) {
    lang = 'json';
  }
  return `# Source File: ${normRel}\n\n\`\`\`${lang}\n${content.trimEnd()}\n\`\`\`\n`;
}

function syncBundle(bundleName, files, isNotebookLM = false) {
  const targetDir = path.join(BUNDLES_DIR, bundleName);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const relPath of files) {
    const srcPath = path.join(ROOT, relPath);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[WARN] Source file missing: ${srcPath}`);
      continue;
    }

    const content = fs.readFileSync(srcPath, 'utf8');

    if (isNotebookLM) {
      const flatName = relPath.replace(/[/\\]/g, '__') + (relPath.endsWith('.md') ? '' : '.md');
      const destPath = path.join(targetDir, flatName);
      fs.writeFileSync(destPath, wrapNotebookLM(relPath, content), 'utf8');
    } else {
      const destPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content, 'utf8');
    }
  }
}

export function buildEvaluationBundles() {
  console.log('Building evaluation bundles...');
  syncBundle('tier_1_essential', TIER_1_FILES, false);
  syncBundle('tier_2_full', TIER_2_FILES, false);
  syncBundle('notebooklm_tier_1_essential', TIER_1_FILES, true);
  syncBundle('notebooklm_tier_2_full', TIER_2_FILES, true);
  console.log('✓ All 4 evaluation bundles synchronized successfully.');
}

const isMain = process.argv[1] && process.argv[1].endsWith('build_evaluation_bundles.mjs');
if (isMain) {
  buildEvaluationBundles();
}
