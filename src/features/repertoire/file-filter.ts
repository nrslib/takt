/**
 * Filters repertoire package content before copy operations.
 *
 * Only supported file types under approved roots are copied. Symbolic links
 * are excluded, oversized step fragments are rejected, and the package-wide
 * file limit is enforced.
 */
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';

export const ALLOWED_EXTENSIONS = Object.freeze(['.md', '.yaml', '.yml'] as const);
export const STEP_FRAGMENT_EXTENSIONS = Object.freeze(['.yaml', '.yml'] as const);

/** Top-level package directories that can be copied. */
export const ALLOWED_DIRS = Object.freeze(['facets', 'workflows', 'provider-options', 'steps', 'facet-pools'] as const);

export const MAX_FILE_SIZE = 1024 * 1024;

export const MAX_FILE_COUNT = 500;

export interface CopyTarget {
  /** Absolute path to the source file. */
  absolutePath: string;
  /** Relative path from the package root. */
  relativePath: string;
}

export function isAllowedExtension(filename: string): boolean {
  const ext = extname(filename);
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

export function isStepFragmentExtension(filename: string): boolean {
  return (STEP_FRAGMENT_EXTENSIONS as readonly string[]).includes(extname(filename));
}

function shouldCopyFile(
  filePath: string,
  stats: Stats,
): boolean {
  if (stats.size > MAX_FILE_SIZE) return false;
  if (!isAllowedExtension(filePath)) return false;
  return true;
}

function appendCopyTarget(targets: CopyTarget[], target: CopyTarget): void {
  if (targets.length >= MAX_FILE_COUNT) {
    throw new Error(`Package exceeds maximum file count of ${MAX_FILE_COUNT}`);
  }
  targets.push(target);
}

function packageRelativePath(packageRoot: string, absolutePath: string): string {
  return relative(packageRoot, absolutePath).split(sep).join('/');
}

function readPackageDirectory(dir: string): string[] {
  try {
    return readdirSync(dir, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read package directory: ${dir}`, { cause: error });
  }
}

function inspectPackageEntry(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    throw new Error(`Failed to inspect package entry: ${path}`, { cause: error });
  }
}

function collectFromDir(
  dir: string,
  packageRoot: string,
  targets: CopyTarget[],
): void {
  const entries = readPackageDirectory(dir);

  for (const entry of entries) {
    const absolutePath = join(dir, entry);
    const stats = inspectPackageEntry(absolutePath);

    if (stats.isSymbolicLink()) continue;

    if (stats.isDirectory()) {
      collectFromDir(absolutePath, packageRoot, targets);
      continue;
    }

    if (!shouldCopyFile(absolutePath, stats)) continue;

    appendCopyTarget(targets, {
      absolutePath,
      relativePath: packageRelativePath(packageRoot, absolutePath),
    });
  }
}

function collectStepFragments(
  stepsDir: string,
  packageRoot: string,
  targets: CopyTarget[],
): void {
  const entries = readPackageDirectory(stepsDir);

  for (const entry of entries) {
    const absolutePath = join(stepsDir, entry);
    const stats = inspectPackageEntry(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile() || !isStepFragmentExtension(entry)) {
      continue;
    }
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`Step fragment exceeds maximum size of ${MAX_FILE_SIZE} bytes: ${packageRelativePath(packageRoot, absolutePath)}`);
    }
    appendCopyTarget(targets, {
      absolutePath,
      relativePath: packageRelativePath(packageRoot, absolutePath),
    });
  }
}

/** Collects copyable package files while applying package safety limits. */
export function collectCopyTargets(packageRoot: string): CopyTarget[] {
  const targets: CopyTarget[] = [];

  for (const allowedDir of ALLOWED_DIRS) {
    const dirPath = join(packageRoot, allowedDir);
    let stats: Stats;
    try {
      stats = lstatSync(dirPath);
    } catch (err) {
      if (isNotFoundError(err)) continue;
      throw new Error(`Failed to inspect package directory: ${dirPath}`, { cause: err });
    }
    if (!stats.isDirectory()) continue;

    if (allowedDir === 'steps') {
      collectStepFragments(dirPath, packageRoot, targets);
    } else {
      collectFromDir(dirPath, packageRoot, targets);
    }
  }

  return targets;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
