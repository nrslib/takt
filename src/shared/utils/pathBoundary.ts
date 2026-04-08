import { existsSync, realpathSync } from 'node:fs';
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

export function isRealPathInside(basePath: string, candidatePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  const normalizedBase = existsSync(resolvedBase) ? realpathSync(resolvedBase) : resolvedBase;
  const normalizedCandidate = existsSync(resolvedCandidate) ? realpathSync(resolvedCandidate) : resolvedCandidate;

  return isNormalizedPathInside(normalizedBase, normalizedCandidate);
}
