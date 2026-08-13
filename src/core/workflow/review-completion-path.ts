import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { resolve, sep } from 'node:path';

export type ReviewCompletionRealPathResolution =
  | { readonly ok: true; readonly realPath: string; readonly stat: Stats }
  | { readonly ok: false };

function isInsideBase(base: string, candidate: string): boolean {
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return candidate === base || candidate.startsWith(prefix);
}

/** Resolve a regular evidence path without permitting lexical or symlink escape. */
export function resolveReviewCompletionPath(
  cwd: string,
  path: string,
): ReviewCompletionRealPathResolution {
  const resolvedBase = resolve(cwd);
  const resolvedPath = resolve(resolvedBase, path);
  if (!isInsideBase(resolvedBase, resolvedPath)) return { ok: false };

  try {
    const unresolvedStat = lstatSync(resolvedPath);
    if (unresolvedStat.isSymbolicLink()) return { ok: false };
    const realBase = realpathSync(resolvedBase);
    const realPath = realpathSync(resolvedPath);
    if (!isInsideBase(realBase, realPath)) return { ok: false };
    return { ok: true, realPath, stat: lstatSync(realPath) };
  } catch {
    return { ok: false };
  }
}
