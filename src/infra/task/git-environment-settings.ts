import { devNull } from 'node:os';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';

export const FILTER_CONFIG_ARGS = ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'];

export function createGitEnvironment(preserveIndex: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...buildChildProcessEnv(),
    GIT_LITERAL_PATHSPECS: '1',
  };
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === 'GIT_CONFIG'
      || normalizedKey === 'GIT_CONFIG_COUNT'
      || normalizedKey === 'GIT_CONFIG_PARAMETERS'
      || normalizedKey.startsWith('GIT_CONFIG_KEY_')
      || normalizedKey.startsWith('GIT_CONFIG_VALUE_')) {
      delete environment[key];
    }
  }
  delete environment.GIT_GLOB_PATHSPECS;
  delete environment.GIT_NOGLOB_PATHSPECS;
  delete environment.GIT_ICASE_PATHSPECS;
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_COMMON_DIR;
  if (!preserveIndex) delete environment.GIT_INDEX_FILE;
  return environment;
}

export function parseFilterConfigNames(stdout: string): string[] {
  const names = stdout.trim().split('\n').filter(Boolean);
  // Git normalizes section/variable names, but filter subsections are case-sensitive.
  return [...new Set(names)];
}

export function configureSafeGitEnvironment(
  environment: NodeJS.ProcessEnv,
  options: { readonly allowGitHooks?: boolean; readonly filterNames: string[]; readonly review: boolean },
): NodeJS.ProcessEnv {
  const entries: Array<readonly [string, string]> = [];
  if (!options.allowGitHooks) entries.push(['core.hooksPath', devNull]);
  if (options.review) entries.push(['core.fsmonitor', 'false'], ['submodule.recurse', 'false'], ['diff.ignoreSubmodules', 'dirty']);
  entries.push(...options.filterNames.map(name => [name, name.toLowerCase().endsWith('.required') ? 'false' : ''] as const));
  if (entries.length === 0) return environment;
  environment.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}
