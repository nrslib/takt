import * as path from 'node:path';

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);

  if (resolvedBase === resolvedCandidate) {
    return true;
  }

  return resolvedCandidate.startsWith(resolvedBase + path.sep);
}
