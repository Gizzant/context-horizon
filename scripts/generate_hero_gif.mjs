#!/usr/bin/env node
/**
 * @file scripts/generate_hero_gif.mjs
 * Deterministically renders the 45-second Highbeam (ctxtop) terminal showcase GIF
 * (`assets/hero-fts5-ttl-demo.gif`) using ffmpeg (`drawbox`, `drawtext`, `palettegen`, `paletteuse`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_GIF = path.join(ROOT, 'assets', 'hero-fts5-ttl-demo.gif');

function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

function resolveFonts() {
  const candidates = [
    {
      regular: 'C:\\Windows\\Fonts\\consola.ttf',
      bold: 'C:\\Windows\\Fonts\\consolab.ttf'
    },
    {
      regular: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
      bold: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
    }
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand.regular)) {
      return {
        regular: escapeFilterPath(cand.regular),
        bold: escapeFilterPath(fs.existsSync(cand.bold) ? cand.bold : cand.regular)
      };
    }
  }
  throw new Error('No monospace TTF font found for ffmpeg drawtext');
}

export function generateHeroGif(outputPath = OUT_GIF) {
  const fonts = resolveFonts();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highbeam-gif-'));
  let textIdx = 0;
  const writeTextFile = (content) => {
    const filePath = path.join(tmpDir, `txt_${String(++textIdx).padStart(3, '0')}.txt`);
    fs.writeFileSync(filePath, content, 'utf8');
    return escapeFilterPath(filePath);
  };

  const addText = (filters, { text, x, y, size = 16, color = '#e2e8f0', bold = false, enable = null }) => {
    const tf = writeTextFile(text);
    const font = bold ? fonts.bold : fonts.regular;
    const parts = [
      `drawtext=fontfile='${font}'`,
      `textfile='${tf}'`,
      'expansion=none',
      `x=${x}`,
      `y=${y}`,
      `fontsize=${size}`,
      `fontcolor=${color}`
    ];
    if (enable) {
      parts.push(`enable='${enable}'`);
    }
    filters.push(parts.join(':'));
  };

  try {
    const f = [];

    // Outer window header bar (y=0..38) + macOS dots + progress underline
    f.push('drawbox=x=0:y=0:w=920:h=38:color=#111827@1:t=fill');
    f.push('drawbox=x=18:y=13:w=12:h=12:color=#ef4444@1:t=fill');
    f.push('drawbox=x=38:y=13:w=12:h=12:color=#f59e0b@1:t=fill');
    f.push('drawbox=x=58:y=13:w=12:h=12:color=#22c55e@1:t=fill');
    addText(f, {
      text: 'Highbeam (ctxtop v4.1.1) — FTS5 CLI Surgeon & Warm KV-Cache TTL Shield (45s Demo)',
      x: 92,
      y: 12,
      size: 14,
      color: '#94a3b8',
      bold: true
    });

    // Top 3-segment timeline indicator (y=38..41)
    f.push("drawbox=x=0:y=38:w=306:h=3:color=#38bdf8@1:t=fill:enable='between(t,0,15)'");
    f.push("drawbox=x=306:y=38:w=308:h=3:color=#22c55e@1:t=fill:enable='between(t,15,30)'");
    f.push("drawbox=x=614:y=38:w=306:h=3:color=#f59e0b@1:t=fill:enable='between(t,30,45)'");

    // Main card container (y=54..422)
    f.push('drawbox=x=24:y=54:w=872:h=368:color=#131c2e@1:t=fill');
    f.push('drawbox=x=24:y=54:w=872:h=368:color=#1e293b@1:t=2');

    // =========================================================================
    // SCENE 1 (0s - 15s): 10-Second Zero-Write 5-Host ROI Audit
    // =========================================================================
    f.push("drawbox=x=42:y=70:w=450:h=28:color=#0ea5e9@0.20:t=fill:enable='between(t,0,15)'");
    addText(f, {
      text: '[1/3] ZERO-WRITE 5-HOST ROI AUDIT (0s - 15s)',
      x: 54,
      y: 77,
      size: 15,
      color: '#38bdf8',
      bold: true,
      enable: 'between(t,0,15)'
    });
    addText(f, {
      text: '$ npx ctxtop audit --days 7',
      x: 42,
      y: 118,
      size: 18,
      color: '#f8fafc',
      bold: true,
      enable: 'between(t,0.5,15)'
    });
    addText(f, {
      text: 'Scanning 5 hosts read-only (Antigravity | Claude Code | Codex | Gemini | Cursor)...',
      x: 42,
      y: 150,
      size: 14,
      color: '#94a3b8',
      enable: 'between(t,2.5,15)'
    });
    f.push("drawbox=x=42:y=184:w=836:h=214:color=#090d16@1:t=fill:enable='between(t,5,15)'");
    f.push("drawbox=x=42:y=184:w=836:h=214:color=#22c55e@0.75:t=2:enable='between(t,5,15)'");
    addText(f, {
      text: '[Highbeam Session ROI Audit] Window: 7d | Platform: all | Sessions: 12',
      x: 60,
      y: 204,
      size: 15,
      color: '#38bdf8',
      bold: true,
      enable: 'between(t,5,15)'
    });
    addText(f, {
      text: '  Sludge Tax Preventable  : 1,420,850 tok ($2.84 USD recoverable)',
      x: 60,
      y: 242,
      size: 16,
      color: '#4ade80',
      bold: true,
      enable: 'between(t,5.5,15)'
    });
    addText(f, {
      text: '  Cold-Cache Spikes (>5m) : 14 events   |  3x Thrash Loops     : 4',
      x: 60,
      y: 278,
      size: 15,
      color: '#fbbf24',
      enable: 'between(t,6.5,15)'
    });
    addText(f, {
      text: '  Un-Sliced Large Reads   : 11 files    |  Oversized Tool Dumps: 38',
      x: 60,
      y: 312,
      size: 15,
      color: '#f87171',
      enable: 'between(t,7.5,15)'
    });
    addText(f, {
      text: '  Zero hooks modified · SQLITE_OPEN_READONLY · Ready for COACH mode',
      x: 60,
      y: 354,
      size: 14,
      color: '#cbd5e1',
      enable: 'between(t,9,15)'
    });

    // =========================================================================
    // SCENE 2 (15s - 30s): SQLite FTS5 BM25 CLI Compression & Search
    // =========================================================================
    f.push("drawbox=x=42:y=70:w=555:h=28:color=#22c55e@0.20:t=fill:enable='between(t,15,30)'");
    addText(f, {
      text: '[2/3] SQLITE FTS5 BM25 CLI COMPRESSION & SEARCH (15s - 30s)',
      x: 54,
      y: 77,
      size: 15,
      color: '#4ade80',
      bold: true,
      enable: 'between(t,15,30)'
    });
    addText(f, {
      text: '$ npm test   # 10 CLI families: pytest, vitest, tsc, cargo, go, eslint, git',
      x: 42,
      y: 118,
      size: 16,
      color: '#f8fafc',
      bold: true,
      enable: 'between(t,15.5,30)'
    });
    addText(f, {
      text: 'Streaming 840 stdout lines (26,822 raw tokens) through PostToolUse FTS5 hook...',
      x: 42,
      y: 148,
      size: 14,
      color: '#94a3b8',
      enable: 'between(t,17,30)'
    });
    f.push("drawbox=x=42:y=180:w=836:h=112:color=#090d16@1:t=fill:enable='between(t,18.5,30)'");
    f.push("drawbox=x=42:y=180:w=836:h=112:color=#22c55e@0.8:t=2:enable='between(t,18.5,30)'");
    addText(f, {
      text: '[PostToolUse: FTS5 Compressor] 26,822 raw tok -> 1,055 digest tok (96.1% saved)',
      x: 60,
      y: 198,
      size: 15,
      color: '#4ade80',
      bold: true,
      enable: 'between(t,18.5,30)'
    });
    addText(f, {
      text: '  Diagnostic Recall : 25/25 failing assertions preserved (100% recall)',
      x: 60,
      y: 228,
      size: 14,
      color: '#e2e8f0',
      enable: 'between(t,19.5,30)'
    });
    addText(f, {
      text: '  Local Index Store : ~/.ctxtop/tool_logs_fts5.db (SQLite porter unicode61)',
      x: 60,
      y: 256,
      size: 14,
      color: '#94a3b8',
      enable: 'between(t,20.5,30)'
    });
    f.push("drawbox=x=42:y=308:w=836:h=92:color=#090d16@1:t=fill:enable='between(t,23,30)'");
    f.push("drawbox=x=42:y=308:w=836:h=92:color=#38bdf8@0.75:t=2:enable='between(t,23,30)'");
    addText(f, {
      text: '$ npx ctxtop search "AssertionError"   ->  BM25 hit in 1.4ms',
      x: 60,
      y: 326,
      size: 15,
      color: '#38bdf8',
      bold: true,
      enable: 'between(t,23,30)'
    });
    addText(f, {
      text: '  [Rank #1 | turn-14] test/auth.test.mjs:142 Expected 200 OK, received 401',
      x: 60,
      y: 358,
      size: 14,
      color: '#fbbf24',
      enable: 'between(t,24.5,30)'
    });

    // =========================================================================
    // SCENE 3 (30s - 45s): Warm KV-Cache TTL Countdown & PrefixCacheShield
    // =========================================================================
    f.push("drawbox=x=42:y=70:w=600:h=28:color=#f59e0b@0.20:t=fill:enable='between(t,30,45)'");
    addText(f, {
      text: '[3/3] WARM KV-CACHE TTL COUNTDOWN & PREFIX CACHE SHIELD (30s - 45s)',
      x: 54,
      y: 77,
      size: 15,
      color: '#fbbf24',
      bold: true,
      enable: 'between(t,30,45)'
    });

    // 40-Cell Context Telemetry Strip in Scene 3 (x=42..876, y=114..136)
    for (let i = 0; i < 40; i++) {
      const cx = 42 + i * 21;
      let cellColor = '#1e293b@0.85';
      if (i < 4) {
        cellColor = '#00d7ff@1';
      } else if (i < 16) {
        cellColor = '#22c55e@1';
      }
      f.push(`drawbox=x=${cx}:y=114:w=18:h=22:color=${cellColor}:t=fill:enable='between(t,30,45)'`);
    }

    addText(f, {
      text: 'Warm KV Prefix: 100.0k tok (95% discount)  |  5m TTL Remaining: 03:34  |  Recall: 94%',
      x: 42,
      y: 148,
      size: 15,
      color: '#f8fafc',
      bold: true,
      enable: 'between(t,30,35)'
    });
    addText(f, {
      text: 'Warm KV Prefix: 100.0k tok (95% discount)  |  5m TTL Remaining: 03:29  |  Recall: 94%',
      x: 42,
      y: 148,
      size: 15,
      color: '#f8fafc',
      bold: true,
      enable: 'between(t,35,40)'
    });
    addText(f, {
      text: 'Warm KV Prefix: 100.0k tok (95% discount)  |  5m TTL Remaining: 03:24  |  Recall: 94%',
      x: 42,
      y: 148,
      size: 15,
      color: '#f8fafc',
      bold: true,
      enable: 'between(t,40,45)'
    });

    // Zone B Box (t=33..45)
    f.push("drawbox=x=42:y=184:w=836:h=96:color=#090d16@1:t=fill:enable='between(t,33,45)'");
    f.push("drawbox=x=42:y=184:w=836:h=96:color=#f59e0b@0.85:t=2:enable='between(t,33,45)'");
    addText(f, {
      text: 'Zone B [DET-08 PreModelSwitch]: Model: Hold (Warm TTL active)',
      x: 60,
      y: 202,
      size: 15,
      color: '#fbbf24',
      bold: true,
      enable: 'between(t,33,45)'
    });
    addText(f, {
      text: '  Switching Opus -> Sonnet mid-TTL busts 100k prefix (+$0.18 cold prefill > C_max)',
      x: 60,
      y: 236,
      size: 14,
      color: '#e2e8f0',
      enable: 'between(t,33.5,45)'
    });

    // Zone C Box (t=38..45)
    f.push("drawbox=x=42:y=298:w=836:h=102:color=#090d16@1:t=fill:enable='between(t,38,45)'");
    f.push("drawbox=x=42:y=298:w=836:h=102:color=#22c55e@0.85:t=2:enable='between(t,38,45)'");
    addText(f, {
      text: 'Zone C [DET-09 PrefixCacheShield]: Staged AGENTS.md edit until TTL expiry (+57.0k tok)',
      x: 60,
      y: 316,
      size: 15,
      color: '#4ade80',
      bold: true,
      enable: 'between(t,38,45)'
    });
    addText(f, {
      text: '  4-Step Session Savings: +164.0k tokens ($0.33 USD) | 0 interruptions in COACH mode',
      x: 60,
      y: 350,
      size: 14,
      color: '#38bdf8',
      enable: 'between(t,39,45)'
    });

    // =========================================================================
    // Persistent Bottom statusLine (y=436..480)
    // =========================================================================
    f.push('drawbox=x=0:y=436:w=920:h=44:color=#090d16@1:t=fill');
    f.push('drawbox=x=0:y=436:w=920:h=1:color=#1e293b@1:t=fill');
    addText(f, {
      text: 'AH [SCCCCCCC................] opus-4-6 64k/200k (32%) | Cache 95% (Warm TTL) | COACH | Saved +164.0k tok',
      x: 24,
      y: 451,
      size: 14,
      color: '#cbd5e1',
      bold: true
    });

    const filterComplex = `[0:v]${f.join(',')},split[s0][s1];[s0]palettegen=max_colors=64:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
    const filterScriptPath = path.join(tmpDir, 'filter_complex.txt');
    fs.writeFileSync(filterScriptPath, filterComplex, 'utf8');

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=#0b1120:s=920x480:r=4:d=45',
        '-filter_complex_script',
        filterScriptPath,
        outputPath
      ],
      { stdio: 'inherit' }
    );

    const stat = fs.statSync(outputPath);
    console.log(`✓ Generated ${path.relative(ROOT, outputPath)} (${stat.size} bytes, 45s)`);
    return { ok: true, outputPath, sizeBytes: stat.size };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateHeroGif();
}
