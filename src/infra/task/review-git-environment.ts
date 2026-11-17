import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { configureSafeGitEnvironment, createGitEnvironment, FILTER_CONFIG_ARGS, parseFilterConfigNames } from './git-environment-settings.js';

/** Review scope and evidence must observe the same caller-selected index. */
export function buildReviewGitEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment = createGitEnvironment(true);
  // Scope collection and fingerprinting may switch to the repository root.
  const indexFile = environment.GIT_INDEX_FILE;
  if (indexFile !== undefined && indexFile !== '' && !isAbsolute(indexFile)) {
    environment.GIT_INDEX_FILE = resolve(cwd, indexFile);
  }
  environment.LC_ALL = 'C';
  let filterNames: string[];
  try {
    filterNames = parseFilterConfigNames(execFileSync('git', FILTER_CONFIG_ARGS, {
      cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) throw error;
    filterNames = [];
  }
  return configureSafeGitEnvironment(environment, { filterNames, review: true });
}
