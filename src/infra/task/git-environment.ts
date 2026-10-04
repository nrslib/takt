import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';

interface SafeGitEnvironmentOptions {
  readonly allowGitHooks?: boolean;
  readonly allowGitFilters?: boolean;
}

export async function buildSafeGitEnvironment(
  cwd: string,
  options: SafeGitEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    ...buildChildProcessEnv(),
    GIT_LITERAL_PATHSPECS: '1',
  };
  removeInheritedGitCommandConfig(environment);
  delete environment.GIT_GLOB_PATHSPECS;
  delete environment.GIT_NOGLOB_PATHSPECS;
  delete environment.GIT_ICASE_PATHSPECS;
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_COMMON_DIR;
  delete environment.GIT_INDEX_FILE;
  const configEntries: Array<readonly [string, string]> = [];

  if (!options.allowGitHooks) {
    configEntries.push(['core.hooksPath', devNull]);
  }

  if (!options.allowGitFilters) {
    configEntries.push(...(await getFilterConfigNames(cwd, environment)).map((configName) => [
      configName,
      configName.toLowerCase().endsWith('.required') ? 'false' : '',
    ] as const));
  }

  if (configEntries.length === 0) return environment;

  environment.GIT_CONFIG_COUNT = String(configEntries.length);
  configEntries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

function removeInheritedGitCommandConfig(environment: NodeJS.ProcessEnv): void {
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
}

async function getFilterConfigNames(
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  try {
    const stdout = await readGitConfigNames(cwd, environment);
    const names = stdout.trim().split('\n').filter(Boolean);
    return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
  } catch (error) {
    if (isNoMatchingGitConfig(error)) return [];
    throw error;
  }
}

function readGitConfigNames(cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
      { cwd, encoding: 'utf-8', env: environment },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function isNoMatchingGitConfig(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 1;
}
