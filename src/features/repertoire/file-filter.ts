/**
 * File filtering for repertoire package copy operations.
 *
 * Security constraints:
 * - Only .md, .yaml, .yml files are copied
 * - Only files under facets/ or pieces/ top-level directories are copied
 * - Symbolic links are skipped (lstat check)
 * - Files exceeding MAX_FILE_SIZE (1 MB) are skipped
 * - Packages with more than MAX_FILE_COUNT files throw an error
 */

import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('repertoire-file-filter');

/** Allowed file extensions for repertoire package files. */
export const ALLOWED_EXTENSIONS = ['.md', '.yaml', '.yml'] as const;

/** Top-level directories that are copied from a package. */
export const ALLOWED_DIRS = ['facets', 'pieces'] as const;

/** Maximum single file size in bytes (1 MB). */
export const MAX_FILE_SIZE = 1024 * 1024;

/** Maximum total file count per package. */
export const MAX_FILE_COUNT = 500;

export interface CopyTarget {
  /** Absolute path to the source file. */
  absolutePath: string;
  /** Relative path from the package root (e.g. "facets/personas/coder.md"). */
  relativePath: string;
}

/**
 * Check if a filename has an allowed extension.
 */
export function isAllowedExtension(filename: string): boolean {
  const ext = extname(filename);
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Determine whether a single file should be copied.
 *
 * @param filePath - absolute path to the file
 * @param stats    - result of lstat(filePath)
 */
function shouldCopyFile(
  filePath: string,
  stats: Stats,
): boolean {
  if (stats.size > MAX_FILE_SIZE) return false;
  if (!isAllowedExtension(filePath)) return false;
  return true;
}

/**
 * Recursively collect files eligible for copying from within a directory.
 * Used internally by collectCopyTargets.
 */
function collectFromDir(
  dir: string,
  packageRoot: string,
  targets: CopyTarget[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir, 'utf-8');
  } catch (err) {
    log.debug('Failed to read directory', { dir, err });
    return;
  }

  for (const entry of entries) {
    if (targets.length >= MAX_FILE_COUNT) {
      throw new Error(
        `Package exceeds maximum file count of ${MAX_FILE_COUNT}`,
      );
    }

    const absolutePath = join(dir, entry);
    const stats = lstatSync(absolutePath);

    if (stats.isSymbolicLink()) continue;

    if (stats.isDirectory()) {
      collectFromDir(absolutePath, packageRoot, targets);
      continue;
    }

    if (!shouldCopyFile(absolutePath, stats)) continue;

    targets.push({
      absolutePath,
      relativePath: relative(packageRoot, absolutePath),
    });
  }
}

/**
 * Collect all files to copy from a package root directory.
 *
 * Only files under facets/ and pieces/ top-level directories are included.
 * Symbolic links are skipped. Files over MAX_FILE_SIZE are skipped.
 * Throws if total file count exceeds MAX_FILE_COUNT.
 *
 * @param packageRoot - absolute path to the package root (respects takt-repertoire.yaml path)
 */
export function collectCopyTargets(packageRoot: string): CopyTarget[] {
  const targets: CopyTarget[] = [];

  for (const allowedDir of ALLOWED_DIRS) {
    const dirPath = join(packageRoot, allowedDir);
    let stats: Stats | undefined;
    try {
      stats = lstatSync(dirPath);
    } catch (err) {
      log.debug('Directory not accessible, skipping', { dirPath, err });
      continue;
    }
    if (!stats?.isDirectory()) continue;

    collectFromDir(dirPath, packageRoot, targets);

    if (targets.length >= MAX_FILE_COUNT) {
      throw new Error(
        `Package exceeds maximum file count of ${MAX_FILE_COUNT}`,
      );
    }
  }

  return targets;
}
