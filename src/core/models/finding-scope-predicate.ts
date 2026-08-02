import type { FindingScopeBinding } from './finding-contract-types.js';
import type { FindingLedgerEntry, FindingTarget } from './finding-types.js';

function targetPaths(target: FindingTarget): string[] | undefined {
  switch (target.kind) {
    case 'review_scope':
      return undefined;
    case 'code':
      return target.paths;
    case 'structure':
      return [...target.scope.roots, ...target.manifestTargets];
    case 'absence':
      return target.predicate.kind === 'path_state'
        ? [target.predicate.path]
        : target.predicate.roots;
  }
}

function isCanonicalRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith('/')
    && !path.startsWith('\\')
    && !path.includes('\\')
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function findingScopePredicateResult(input: {
  predicate: FindingScopeBinding['predicate'];
  finding: Pick<FindingLedgerEntry, 'target'>;
}): 'outside' | 'inside' | 'undetermined' {
  const predicate = input.predicate;
  if (input.finding.target === null) {
    return 'undetermined';
  }
  if (predicate.kind === 'target_kind_set') {
    return predicate.allowedKinds.includes(input.finding.target.kind) ? 'inside' : 'outside';
  }
  if (predicate.kind === 'family_tag_set') {
    return 'undetermined';
  }
  const paths = targetPaths(input.finding.target);
  if (
    paths === undefined
    || paths.length === 0
    || predicate.allowedRoots.length === 0
    || paths.some((path) => !isCanonicalRelativePath(path))
    || predicate.allowedRoots.some((root) => !isCanonicalRelativePath(root))
  ) {
    return 'undetermined';
  }
  return paths.some((path) => predicate.allowedRoots.some((root) => pathsOverlap(path, root)))
    ? 'inside'
    : 'outside';
}
