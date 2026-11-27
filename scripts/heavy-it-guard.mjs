import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OVERRIDE_ENV = 'TAKT_ALLOW_FULL_HEAVY_IT';
const DENIAL_MESSAGE = [
  '[takt] Unscoped Heavy IT runs require GitHub Actions pull_request CI.',
  'For local verification, specify test files with "npm test -- src/__tests__/<file>.test.ts".',
  `Use ${OVERRIDE_ENV}=1 only when a person explicitly requests the full run.`,
].join('\n');

function isFullHeavyItAllowed() {
  return process.env[OVERRIDE_ENV] === '1'
    || (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'pull_request');
}

export function requireFullHeavyItPermission() {
  if (!isFullHeavyItAllowed()) {
    throw new Error(DENIAL_MESSAGE);
  }
}

function resolveTestFile(filter, directory) {
  const path = filter.replace(/:\d+$/, '').replaceAll('\\', '/');
  if (!/\.test\.tsx?$/.test(path) || /[*?\[\]{}]/.test(path)) {
    return undefined;
  }
  const candidates = [resolve(directory, path)];
  if (basename(path) === path) {
    candidates.push(resolve(directory, 'src/__tests__', path));
  }
  candidates.push(resolve(path));
  return candidates.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

/**
 * @param {readonly string[]} vitestArgs
 * @param {{ root?: string, test?: { root?: string, dir?: string } }} config
 */
export async function resolveHeavyItTargets(vitestArgs, config = {}) {
  if (isFullHeavyItAllowed()) {
    return undefined;
  }

  // Use Vitest's parser so option values cannot be mistaken for test filters.
  const { parseCLI } = await import('vitest/node');
  const { filter, options } = parseCLI(['vitest', ...vitestArgs]);
  if (vitestArgs[0] === 'list' && options.filesOnly) {
    return undefined;
  }
  // Vitest treats an explicit scan directory as relative to the process CWD.
  const scanDirectory = (options.dir ?? config.test?.dir)
    || config.test?.root
    || options.root
    || config.root
    || process.cwd();
  const directory = resolve(scanDirectory);
  if (filter.length === 0) {
    throw new Error(DENIAL_MESSAGE);
  }
  const files = filter.map((name) => {
    const target = resolveTestFile(name, directory);
    if (target === undefined) {
      throw new Error(DENIAL_MESSAGE);
    }
    return target;
  });
  return { directory, files };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  requireFullHeavyItPermission();
}
