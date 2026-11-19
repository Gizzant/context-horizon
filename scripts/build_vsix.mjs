import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function blendPixel(buf, width, height, x, y, r, g, b, alpha = 1) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height || alpha <= 0) return;
  const idx = (py * width + px) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  const inv = 1 - a;
  buf[idx] = Math.round(buf[idx] * inv + r * a);
  buf[idx + 1] = Math.round(buf[idx + 1] * inv + g * a);
  buf[idx + 2] = Math.round(buf[idx + 2] * inv + b * a);
  buf[idx + 3] = Math.min(255, Math.round(buf[idx + 3] + (255 - buf[idx + 3]) * a));
}

function drawDisc(buf, width, height, cx, cy, radius, rgb) {
  const minX = Math.floor(cx - radius - 1);
  const maxX = Math.ceil(cx + radius + 1);
  const minY = Math.floor(cy - radius - 1);
  const maxY = Math.ceil(cy + radius + 1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius + 0.7) {
        const cov = d <= radius - 0.5 ? 1 : Math.max(0, Math.min(1, radius + 0.5 - d));
        blendPixel(buf, width, height, x, y, rgb[0], rgb[1], rgb[2], cov);
      }
    }
  }
}

/**
 * Deterministically renders Highbeam's 128x128 8-bit RGBA PNG icon without native deps.
 */
export function generateHighbeamIconPng() {
  const width = 128;
  const height = 128;
  const rgba = Buffer.alloc(width * height * 4, 0);
  const radius = 24;

  // Dark rounded square background (#090D16) with subtle perimeter border (#1E293B)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = Math.max(0, Math.abs(x + 0.5 - width / 2) - (width / 2 - radius));
      const dy = Math.max(0, Math.abs(y + 0.5 - height / 2) - (height / 2 - radius));
      const dist = Math.hypot(dx, dy) - radius;
      if (dist <= 0.6) {
        const cov = dist <= -0.5 ? 1 : Math.max(0, Math.min(1, 0.5 - dist));
        const isBorder = dist > -2.2 && dist <= 0;
        const rgb = isBorder ? [30, 41, 59] : [9, 13, 22];
        blendPixel(rgba, width, height, x, y, rgb[0], rgb[1], rgb[2], cov);
      }
    }
  }

  // Faint circular horizon ring (#1E293B, r = 50)
  for (let y = 10; y < 118; y++) {
    for (let x = 10; x < 118; x++) {
      const ringDist = Math.abs(Math.hypot(x - 64, y - 64) - 50);
      if (ringDist < 1.2) {
        const angle = Math.atan2(y - 64, x - 64);
        if (Math.sin(angle * 16) > -0.1) {
          blendPixel(rgba, width, height, x, y, 30, 41, 59, (1.2 - ringDist) * 0.7);
        }
      }
    }
  }

  // U-shaped parabolic recall curve in cyan (#38BDF8)
  for (let t = 0; t <= 400; t++) {
    const u = (t / 400) * 2 - 1; // -1..1
    const cx = 64 + u * 44;
    const cy = 68 - 28 * u * u;
    drawDisc(rgba, width, height, cx, cy, 2.0, [56, 189, 248]);
  }

  // Primacy & Recency anchor nodes
  drawDisc(rgba, width, height, 20, 40, 4.4, [56, 189, 248]);
  drawDisc(rgba, width, height, 108, 40, 4.4, [56, 189, 248]);

  // 9-segment horizon bar along lower half (#00D7FF, #AF5FFF, #FFAF00, #FF0000, #00FF00)
  const palette = [
    [0, 215, 255],
    [0, 215, 255],
    [175, 95, 255],
    [255, 175, 0],
    [255, 175, 0],
    [255, 69, 58],
    [255, 69, 58],
    [48, 209, 88],
    [48, 209, 88]
  ];
  for (let i = 0; i < palette.length; i++) {
    const bx = 19 + i * 10;
    const bw = 8;
    const by = 82;
    const bh = 14;
    const [r, g, b] = palette[i];
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        blendPixel(rgba, width, height, x, y, r, g, b, 1);
      }
    }
  }

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // PNG filter type None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildContentTypesXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Default Extension="vscodeignore" ContentType="text/plain"/>
  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>
`;
}

export function buildVsixManifestXml(pkg = {}) {
  const name = escapeXml(pkg.name || 'highbeam');
  const publisher = escapeXml(pkg.publisher || 'gizzant');
  const version = escapeXml(pkg.version || '4.1.4');
  const displayName = escapeXml(pkg.displayName || 'Highbeam');
  const description = escapeXml(pkg.description || '');
  const categories = Array.isArray(pkg.categories) ? escapeXml(pkg.categories.join(',')) : 'Other';
  const tags = Array.isArray(pkg.keywords) ? escapeXml(pkg.keywords.join(',')) : '';
  const engine = escapeXml(pkg.engines?.vscode || '^1.85.0');
  const repoUrl = escapeXml(
    (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ||
      'https://github.com/Gizzant/context-horizon.git'
  );
  const homepageUrl = escapeXml(pkg.homepage || 'https://gizzant.github.io/context-horizon/');
  const bugsUrl = escapeXml(pkg.bugs?.url || 'https://github.com/Gizzant/context-horizon/issues');

  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${name}" Version="${version}" Publisher="${publisher}" />
    <DisplayName>${displayName}</DisplayName>
    <Description xml:space="preserve">${description}</Description>
    <Categories>${categories}</Categories>
    <Tags>${tags}</Tags>
    <License>extension/LICENSE</License>
    <Icon>extension/media/icon.png</Icon>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${engine}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${repoUrl}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${bugsUrl}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${homepageUrl}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" d:Source="File" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" d:Source="File" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" d:Source="File" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" d:Source="File" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function toDosTimeDate(date = new Date()) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime =
    ((date.getUTCHours() & 0x1f) << 11) |
    ((date.getUTCMinutes() & 0x3f) << 5) |
    ((date.getUTCSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getUTCMonth() + 1) & 0x0f) << 5) |
    (date.getUTCDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Packs deterministic ZIP buffer with deflate compression and valid local/CD/EOCD headers.
 */
export function createZipBuffer(entries = []) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;
  const fixedDate = new Date('2026-11-18T12:00:00Z');

  for (const entry of entries) {
    const entryName = String(entry.name || '').replace(/\\/g, '/');
    const nameBuf = Buffer.from(entryName, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(rawBuf);
    const deflated = zlib.deflateRawSync(rawBuf, { level: 9 });
    const useDeflate = deflated.length < rawBuf.length;
    const method = useDeflate ? 8 : 0;
    const compBuf = useDeflate ? deflated : rawBuf;
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime instanceof Date ? entry.mtime : fixedDate);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compBuf);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8);
    cdHeader.writeUInt16LE(method, 10);
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compBuf.length, 20);
    cdHeader.writeUInt32LE(rawBuf.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42);

    cdParts.push(cdHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

export function listZipEntries(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) {
    throw new Error('Invalid ZIP buffer');
  }
  let eocdOffset = -1;
  const searchFloor = Math.max(0, zipBuffer.length - 65558);
  for (let i = zipBuffer.length - 22; i >= searchFloor; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Missing ZIP End of Central Directory record');
  }
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  let cursor = cdOffset;
  const parsed = [];
  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > zipBuffer.length || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Corrupt ZIP central directory at offset ${cursor}`);
    }
    const method = zipBuffer.readUInt16LE(cursor + 10);
    const crcVal = zipBuffer.readUInt32LE(cursor + 16);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const name = zipBuffer.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    parsed.push({ name, method, crc32: crcVal, compressedSize, uncompressedSize });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return parsed;
}

function shouldIgnoreRelPath(relPosix, ignorePatterns) {
  const base = path.posix.basename(relPosix);
  for (const pat of ignorePatterns) {
    if (pat === '*.vsix' && base.endsWith('.vsix')) return true;
    if (pat === '*.log' && base.endsWith('.log')) return true;
    if (pat === '*.tmp' && base.endsWith('.tmp')) return true;
    if (pat === '.DS_Store' && base === '.DS_Store') return true;
    if (pat === 'test/**' && (relPosix === 'test' || relPosix.startsWith('test/'))) return true;
    if (pat === 'node_modules/**' && (relPosix === 'node_modules' || relPosix.startsWith('node_modules/'))) return true;
  }
  return false;
}

function collectExtensionFiles(extensionDir, ignorePatterns) {
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPosix = path.relative(extensionDir, full).split(path.sep).join('/');
      if (shouldIgnoreRelPath(relPosix, ignorePatterns)) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else {
        out.push({
          relPosix,
          archivePath: `extension/${relPosix}`,
          data: fs.readFileSync(full)
        });
      }
    }
  };
  walk(extensionDir);
  return out;
}

export function buildVsixArchive(options = {}) {
  const extensionDir = path.resolve(options.extensionDir || path.join(REPO_ROOT, 'extensions', 'vscode-highbeam'));
  const outDir = path.resolve(options.outDir || extensionDir);
  const rootPackagePath = path.resolve(options.rootPackagePath || path.join(REPO_ROOT, 'package.json'));
  const writeIcon = options.writeIcon !== undefined ? Boolean(options.writeIcon) : outDir === extensionDir;

  const extPkgPath = path.join(extensionDir, 'package.json');
  const extPkg = JSON.parse(fs.readFileSync(extPkgPath, 'utf8'));
  const rootPkg = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));

  if (extPkg.version !== rootPkg.version) {
    throw new Error(
      `Extension version (${extPkg.version}) does not match root package.json (${rootPkg.version})`
    );
  }

  const iconPath = path.join(extensionDir, 'media', 'icon.png');
  const generatedIcon = generateHighbeamIconPng();
  if (writeIcon || !fs.existsSync(iconPath)) {
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(iconPath, generatedIcon);
  }

  const iconBytes = fs.readFileSync(iconPath);
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (iconBytes.length < 24 || !iconBytes.subarray(0, 8).equals(pngSig)) {
    throw new Error('media/icon.png is not a valid PNG file');
  }
  const iconW = iconBytes.readUInt32BE(16);
  const iconH = iconBytes.readUInt32BE(20);
  if (iconW !== 128 || iconH !== 128) {
    throw new Error(`media/icon.png must be 128x128 (got ${iconW}x${iconH})`);
  }

  for (const requiredRel of ['media/sidebar-icon.svg', 'src/extension.js', 'README.md', 'LICENSE']) {
    if (!fs.existsSync(path.join(extensionDir, requiredRel))) {
      throw new Error(`Missing required extension asset: ${requiredRel}`);
    }
  }

  const ignorePath = path.join(extensionDir, '.vscodeignore');
  const ignorePatterns = fs.existsSync(ignorePath)
    ? fs
        .readFileSync(ignorePath, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [];

  const fileEntries = collectExtensionFiles(extensionDir, ignorePatterns);
  const zipEntries = [
    { name: '[Content_Types].xml', data: Buffer.from(buildContentTypesXml(), 'utf8') },
    { name: 'extension.vsixmanifest', data: Buffer.from(buildVsixManifestXml(extPkg), 'utf8') },
    ...fileEntries.map((f) => ({ name: f.archivePath, data: f.data }))
  ];

  const vsixBuffer = createZipBuffer(zipEntries);
  const verifiedEntries = listZipEntries(vsixBuffer);

  fs.mkdirSync(outDir, { recursive: true });
  const filename = `${extPkg.name}-${extPkg.version}.vsix`;
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, vsixBuffer);

  const sha256 = crypto.createHash('sha256').update(vsixBuffer).digest('hex');
  return {
    ok: true,
    outPath,
    filename,
    bytes: vsixBuffer.length,
    entryCount: verifiedEntries.length,
    entries: verifiedEntries.map((e) => e.name),
    sha256
  };
}

function isCliMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch (err) {
    void err; // Fallback to normalized path check if realpath fails.
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isCliMain()) {
  const res = buildVsixArchive();
  console.log(
    `[build_vsix] Built ${res.filename} (${(res.bytes / 1024).toFixed(1)} KB, ${res.entryCount} entries)`
  );
  console.log(`  path   : ${res.outPath}`);
  console.log(`  sha256 : ${res.sha256}`);
}
