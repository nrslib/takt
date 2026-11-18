import { matchesGlob, relative } from 'node:path';
import type { Plugin } from 'vitest/config';
import { resolveHeavyItTargets } from './heavy-it-guard.mjs';

export const heavyItGuard: Plugin = {
  name: 'takt-heavy-it-guard',
  async config(config) {
    const targets = await resolveHeavyItTargets(process.argv.slice(2), config);
    if (targets === undefined || config.test?.include === undefined) {
      return;
    }
    const { include } = config.test;
    const paths = targets.files.map((file) => relative(targets.directory, file).replaceAll('\\', '/'));

    // Vitest's positional filters match substrings. Exact includes also keep
    // watch-mode reruns inside the explicitly requested scope.
    config.test.include = paths.filter((path) => include.some((glob) => matchesGlob(path, glob)));
  },
};
