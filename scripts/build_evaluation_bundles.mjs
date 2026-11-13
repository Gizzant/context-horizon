import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../src/core/atomic_io.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUNDLES_DIR = path.join(ROOT, 'evaluation_bundles');

export const TIER_1_FILES = [
  'AGENTS.md',
  'README.md',
  'docs/CONTEXT_MEMORY_EVALUATION_GUIDE.md',
  'docs/FLIGHT_COMPUTER_ACTIVE_COACH.md',
  'docs/RING1_SECURITY_AND_CONCURRENCY.md',
  'evaluation_bundles/README.md',
  'src/core/classifier.mjs',
  'tests/verify_phase_6_roadmap.mjs'
];

export const TIER_2_FILES = [
  ...TIER_1_FILES,
  'scripts/sync_mirrors.mjs',
  'sidecars/horizon-daemon/server.mjs',
  'src/adapters/antigravity/index.mjs',
  'src/adapters/claude-code/index.mjs',
  'src/demo/synthetic_states.mjs',
  'src/webview/registry.mjs',
  'src/core/baseline.mjs',
  'src/core/constants.mjs',
  'src/core/hook_diagnostics.mjs',
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
  'src/core/coach/circuit_breakers.mjs',
  'src/core/coach/handoff_hydrator.mjs',
  'src/core/coach/saved_quota_ledger.mjs',
  'src/core/coach/subagent_phantom_auditor.mjs',
  'src/core/coach/task_quota_router.mjs',
  'src/core/coach/turn_zero_gate.mjs',
  'src/core/coach/progressive_checkpointer.mjs',
  'src/core/coach/contradiction_auditor.mjs',
  'src/core/coach/reflector_queue.mjs',
  'src/core/coach/prompt_decomposer_coach.mjs',
  'src/core/coach/subagent_ipi_sanitizer.mjs',
  'src/core/telemetry/cache_ttl_watchdog.mjs',
  'src/core/telemetry/scope_lock_registry.mjs',
  'src/core/telemetry/shadow_file_detector.mjs',
  'src/core/telemetry/trajectory_watcher.mjs',
  'src/shims/agy_cli_compressor.mjs',
  'src/shims/agy_git_guard.mjs',
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

function listAllFilesRecursive(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      listAllFilesRecursive(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function pruneEmptyDirs(dir, stopRoot) {
  if (!fs.existsSync(dir) || path.resolve(dir) === path.resolve(stopRoot)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      pruneEmptyDirs(path.join(dir, ent.name), stopRoot);
    }
  }
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

function syncBundle(bundleName, files, isNotebookLM = false) {
  const targetDir = path.join(BUNDLES_DIR, bundleName);
  fs.mkdirSync(targetDir, { recursive: true });
  const expectedDestPaths = new Set();

  for (const relPath of files) {
    const srcPath = path.join(ROOT, relPath);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`[build_evaluation_bundles] Missing canonical source file: ${srcPath}`);
    }

    const content = fs.readFileSync(srcPath, 'utf8');

    if (isNotebookLM) {
      const flatName = relPath.replace(/[/\\]/g, '__') + (relPath.endsWith('.md') ? '' : '.md');
      const destPath = path.join(targetDir, flatName);
      expectedDestPaths.add(path.resolve(destPath));
      atomicWriteFileSync(destPath, wrapNotebookLM(relPath, content), { encoding: 'utf8' });
    } else {
      const destPath = path.join(targetDir, relPath);
      expectedDestPaths.add(path.resolve(destPath));
      atomicWriteFileSync(destPath, content, { encoding: 'utf8' });
    }
  }

  // Prune any orphan/stale files in the bundle directory (e.g., deleted docs/HANDOFF.md or old prompts)
  for (const existingFile of listAllFilesRecursive(targetDir)) {
    if (!expectedDestPaths.has(path.resolve(existingFile))) {
      fs.rmSync(existingFile, { force: true });
    }
  }
  pruneEmptyDirs(targetDir, targetDir);
}

export function buildEvaluationBundles({ silent = false } = {}) {
  if (!silent) console.log('Building evaluation bundles...');
  fs.mkdirSync(BUNDLES_DIR, { recursive: true });
  const bundleReadmePath = path.join(BUNDLES_DIR, 'README.md');
  if (!fs.existsSync(bundleReadmePath)) {
    atomicWriteFileSync(
      bundleReadmePath,
      '# Highbeam Evaluation Bundles\n\nPre-packaged context bundles for architectural audits and NotebookLM ingestion.\n',
      { encoding: 'utf8' }
    );
  }
  syncBundle('tier_1_essential', TIER_1_FILES, false);
  syncBundle('tier_2_full', TIER_2_FILES, false);
  syncBundle('notebooklm_tier_1_essential', TIER_1_FILES, true);
  syncBundle('notebooklm_tier_2_full', TIER_2_FILES, true);
  if (!silent) console.log('✓ All 4 evaluation bundles synchronized successfully.');
}

function isBundlesMain(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1) === path.resolve(fileURLToPath(metaUrl));
  }
}

if (isBundlesMain()) {
  buildEvaluationBundles();
}
