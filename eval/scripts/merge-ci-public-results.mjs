import { isAbsolute, join, relative, sep } from 'node:path';

const SUITES = new Set(['merge-ci-investigation', 'merge-ci-review']);

export function mergeCiResultPaths(suiteName, repoRoot) {
  if (!SUITES.has(suiteName)) return undefined;
  return {
    raw: join(repoRoot, 'eval', '.results', `${suiteName}.json`),
    published: join(repoRoot, 'eval', 'results', `${suiteName}.json`),
  };
}

export function normalizeMergeCiResults(value, repoRoot) {
  const replacements = new Map([[repoRoot, '.']]);
  function collect(node) {
    if (node === null || typeof node !== 'object') return;
    const error = node.response?.error;
    if (typeof error === 'string') {
      // Preparation may fail before fixture metadata exists; the provider still owns these temporary roots.
      for (const [root] of error.matchAll(/\/(?:[^/\s'"]+\/)*takt-prompt-eval-fixture-[A-Za-z0-9]{6}(?=\/|[\s'"]|$)/g)) {
        replacements.set(root, '.');
      }
    }
    const fixture = node.response?.metadata?.fixture;
    if (fixture !== undefined) {
      const source = fixture.source_directory;
      const working = fixture.working_directory;
      if (typeof source !== 'string' || typeof working !== 'string') {
        throw new Error('Fixture directory metadata is required for publication');
      }
      const sourceRelative = isAbsolute(source) ? relative(repoRoot, source).split(sep).join('/') : source;
      if (!sourceRelative.startsWith('eval/.work/merge-ci-recovery/')) {
        throw new Error('Fixture source directory must belong to merge-ci-recovery');
      }
      if (isAbsolute(source)) replacements.set(source, sourceRelative);
      if (isAbsolute(working)) replacements.set(working, sourceRelative);
    }
    for (const child of Object.values(node)) collect(child);
  }
  collect(value);
  const pattern = new RegExp([...replacements.keys()].sort((a, b) => b.length - a.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  function normalize(node) {
    if (typeof node === 'string') return node.replace(pattern, (path) => replacements.get(path));
    if (Array.isArray(node)) return node.map(normalize);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, normalize(child)]));
    }
    return node;
  }
  return normalize(value);
}
