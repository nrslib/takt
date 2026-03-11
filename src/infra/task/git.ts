/**
 * Shared git operations for task execution
 */

import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('git');

export interface StageAndCommitOptions {
  allowGitHooks?: boolean;
  allowGitFilters?: boolean;
}

export function getCurrentBranch(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

function getFilterConfigNames(cwd: string): string[] {
  try {
    const output = execFileSync('git', ['config', '--local', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    return output
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getSafeGitEnv(cwd: string, options: StageAndCommitOptions): NodeJS.ProcessEnv | undefined {
  const configEntries: Array<readonly [string, string]> = [];

  if (!options.allowGitHooks) {
    configEntries.push(['core.hooksPath', devNull] as const);
  }

  if (!options.allowGitFilters) {
    const configNames = getFilterConfigNames(cwd);
    configEntries.push(...configNames.map(configName => [
      configName,
      configName.endsWith('.required') ? 'false' : '',
    ] as const));
  }

  if (configEntries.length === 0) {
    return undefined;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: String(configEntries.length),
  };

  configEntries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return env;
}

/**
 * Returns the short commit hash if changes were committed, undefined if no changes.
 */
export function stageAndCommit(cwd: string, message: string, options: StageAndCommitOptions = {}): string | undefined {
  const env = getSafeGitEnv(cwd, options);

  execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe', env });

  const statusOutput = execFileSync('git', ['status', '--porcelain'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
    env,
  });

  if (!statusOutput.trim()) {
    return undefined;
  }

  const commitArgs = options.allowGitHooks
    ? ['commit', '-m', message]
    : ['commit', '--no-verify', '-m', message];

  execFileSync('git', commitArgs, { cwd, stdio: 'pipe', env });

  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
    env,
  }).trim();
}

/**
 * Fetches and checks out a branch from origin. Throws on failure.
 */
export function checkoutBranch(cwd: string, branch: string): void {
  log.info('Checking out branch from origin', { branch });
  execFileSync('git', ['fetch', 'origin', branch], { cwd, stdio: 'pipe' });
  execFileSync('git', ['checkout', branch], { cwd, stdio: 'pipe' });
}

/**
 * Throws on failure.
 */
export function pushBranch(cwd: string, branch: string): void {
  log.info('Pushing branch to origin', { branch });
  execFileSync('git', ['push', 'origin', branch], {
    cwd,
    stdio: 'pipe',
  });
}
