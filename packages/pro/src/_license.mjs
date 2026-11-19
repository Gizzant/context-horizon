/**
 * @file packages/pro/src/_license.mjs
 * Runtime dual-resolver for pro_license.mjs:
 * - Loads local ./pro_license.mjs in standalone @ctxtop/pro and dev checkouts.
 * - Falls back to ../../../src/core/pro_license.mjs when packed inside root highbeam-cli.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const localPath = path.join(__dir, 'pro_license.mjs');
const rootPath = path.resolve(__dir, '..', '..', '..', 'src', 'core', 'pro_license.mjs');
const targetPath = fs.existsSync(localPath) ? localPath : rootPath;
const proLicense = await import(pathToFileURL(targetPath).href);

export const { requireProFeature } = proLicense;
export default proLicense;
