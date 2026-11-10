import path from 'node:path';
import { suppressSqliteExperimentalWarning } from './paths.mjs';

suppressSqliteExperimentalWarning();

/**
 * Normalizes file paths across Windows 11, POSIX, and URI schemes.
 * Ensures consistent canonical string comparisons across Antigravity tools and sidecars.
 *
 * @param {string} rawPath
 * @returns {string} Canonicalized path
 */
export function canonicalizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return '';
  }

  let cleaned = rawPath.trim();
  if (!cleaned) return '';

  // Handle file URI schemes (file:/// or file://)
  if (cleaned.startsWith('file://')) {
    cleaned = cleaned.replace(/^file:\/\/\/?/i, '');
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Keep cleaned as is if decodeURIComponent fails
    }
  }

  // Normalize Windows backslashes to forward slashes
  cleaned = cleaned.replace(/\\/g, '/');

  // Collapse multiple consecutive slashes except if leading double slash (UNC)
  cleaned = cleaned.replace(/\/+/g, '/');

  // Normalize dot and double-dot segments using posix normalize
  cleaned = path.posix.normalize(cleaned);

  // Strip trailing slashes unless it is root '/' or Windows drive root 'c:/'
  if (cleaned.length > 1 && cleaned.endsWith('/')) {
    const isWindowsDriveRoot = /^[a-zA-Z]:\/$/.test(cleaned);
    if (!isWindowsDriveRoot) {
      cleaned = cleaned.slice(0, -1);
    }
  }

  // Windows case-insensitivity: lowercase drive letter and path
  const isWindows = process.platform === 'win32' || /^[a-zA-Z]:\//.test(cleaned);
  if (isWindows) {
    cleaned = cleaned.toLowerCase();
  }

  return cleaned;
}

/**
 * Checks whether childPath is the same as or a sub-path of parentPath.
 *
 * @param {string} parentPath
 * @param {string} childPath
 * @returns {boolean}
 */
export function isSameOrSubPath(parentPath, childPath) {
  const normParent = canonicalizePath(parentPath);
  const normChild = canonicalizePath(childPath);

  if (!normParent || !normChild) return false;
  if (normParent === normChild) return true;

  const prefix = normParent.endsWith('/') ? normParent : `${normParent}/`;
  return normChild.startsWith(prefix);
}
