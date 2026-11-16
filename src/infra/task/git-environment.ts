import { execFile } from 'node:child_process';
import { configureSafeGitEnvironment, createGitEnvironment, FILTER_CONFIG_ARGS, parseFilterConfigNames } from './git-environment-settings.js';

interface SafeGitEnvironmentOptions {
  readonly allowGitHooks?: boolean;
  readonly allowGitFilters?: boolean;
}

export async function buildSafeGitEnvironment(
  cwd: string,
  options: SafeGitEnvironmentOptions,
  signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const environment = createGitEnvironment(false);
  const filterNames = options.allowGitFilters ? [] : await getFilterConfigNames(cwd, environment, signal);
  return configureSafeGitEnvironment(environment, { allowGitHooks: options.allowGitHooks, filterNames, review: false });
}

async function getFilterConfigNames(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const stdout = await readGitConfigNames(cwd, environment, signal);
    return parseFilterConfigNames(stdout);
  } catch (error) {
    if (isNoMatchingGitConfig(error)) return [];
    throw error;
  }
}

function readGitConfigNames(cwd: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      FILTER_CONFIG_ARGS,
      { cwd, encoding: 'utf-8', env: environment, signal },
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
