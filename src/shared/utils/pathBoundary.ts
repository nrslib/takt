import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import * as path from 'node:path';

function isNormalizedPathInside(basePath: string, candidatePath: string): boolean {
  if (basePath === candidatePath) {
    return true;
  }

  return candidatePath.startsWith(basePath + path.sep);
}

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);

  return isNormalizedPathInside(resolvedBase, resolvedCandidate);
}

export function lstatIfExists(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function isRealPathInside(basePath: string, candidatePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  const normalizedBase = existsSync(resolvedBase) ? realpathSync(resolvedBase) : resolvedBase;
  const normalizedCandidate = existsSync(resolvedCandidate) ? realpathSync(resolvedCandidate) : resolvedCandidate;

  return isNormalizedPathInside(normalizedBase, normalizedCandidate);
}

export type BoundaryViolation = 'outside' | 'symlink' | 'not_directory';

/**
 * Walk each path segment from rootDir to targetPath and assert none is a
 * symlink and every intermediate segment is a directory.
 *
 * Returns the Stats of the final segment (or null when a segment does not
 * exist yet).
 */
export function assertPathSegmentsAreSafe(
  rootDir: string,
  targetPath: string,
  buildError: (violation: BoundaryViolation, segmentPath: string) => Error,
  options?: { readonly rejectSamePath?: boolean },
): Stats | null {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget) || (options?.rejectSamePath && resolvedRoot === resolvedTarget)) {
    throw buildError('outside', targetPath);
  }

  const segments = path.relative(resolvedRoot, resolvedTarget)
    .split(path.sep)
    .filter((segment) => segment.length > 0);

  let current = resolvedRoot;
  let stats: Stats | null = null;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    stats = lstatIfExists(current);
    if (stats === null) {
      return null;
    }
    if (stats.isSymbolicLink()) {
      throw buildError('symlink', current);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw buildError('not_directory', current);
    }
  }
  return stats;
}
