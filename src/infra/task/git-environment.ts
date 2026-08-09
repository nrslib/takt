import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';

interface SafeGitEnvironmentOptions {
  readonly allowGitHooks?: boolean;
  readonly allowGitFilters?: boolean;
}

export function buildSafeGitEnvironment(
  cwd: string,
  options: SafeGitEnvironmentOptions,
): NodeJS.ProcessEnv {
  const configEntries: Array<readonly [string, string]> = [];

  if (!options.allowGitHooks) {
    configEntries.push(['core.hooksPath', devNull]);
  }

  if (!options.allowGitFilters) {
    configEntries.push(...getFilterConfigNames(cwd).map((configName) => [
      configName,
      configName.endsWith('.required') ? 'false' : '',
    ] as const));
  }

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_LITERAL_PATHSPECS: '1',
  };
  delete environment.GIT_GLOB_PATHSPECS;
  delete environment.GIT_NOGLOB_PATHSPECS;
  delete environment.GIT_ICASE_PATHSPECS;
  if (configEntries.length === 0) return environment;

  environment.GIT_CONFIG_COUNT = String(configEntries.length);
  configEntries.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

function getFilterConfigNames(cwd: string): string[] {
  try {
    const output = execFileSync(
      'git',
      ['config', '--local', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
      { cwd, stdio: 'pipe', encoding: 'utf-8' },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    if (isNoMatchingGitConfig(error)) return [];
    throw error;
  }
}

function isNoMatchingGitConfig(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 1;
}
