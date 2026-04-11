/**
 * Shared git operations for task execution
 */

import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('git');

export const NON_FAST_FORWARD_PUSH_HINT =
  'Push rejected (non-fast-forward): remote is ahead of this branch. Sync with origin (fetch/pull or reset to remote) or recreate the worktree from the remote tip; a stale local branch as the clone source often causes this.';

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

function throwPushFailureWithStderr(err: unknown, extraHint: string): never {
  const stderr = ((err as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString();
  const base = err instanceof Error ? err.message : String(err);
  if (stderr && /non-fast-forward/i.test(stderr)) {
    throw new Error(
      `${base}\n${stderr.trim()}\n${extraHint}`,
    );
  }
  throw err;
}

/**
 * Throws on failure.
 */
export function pushBranch(cwd: string, branch: string): void {
  log.info('Pushing branch to origin', { branch });
  try {
    execFileSync('git', ['push', 'origin', branch], {
      cwd,
      stdio: 'pipe',
    });
  } catch (err) {
    throwPushFailureWithStderr(err, NON_FAST_FORWARD_PUSH_HINT);
  }
}

export function materializeCloneHeadToRootBranch(cloneCwd: string, rootCwd: string, branch: string): void {
  log.info('Materializing clone HEAD to root branch', { cloneCwd, rootCwd, branch });
  execFileSync('git', ['fetch', cloneCwd, `HEAD:refs/heads/${branch}`], {
    cwd: rootCwd,
    stdio: 'pipe',
  });
}

/**
 * Relay push: fetches clone HEAD into a temporary ref in the root repo,
 * pushes that ref to origin, then cleans up the temp ref (always, even on failure).
 *
 * This avoids the unsafe `git push <projectDir> HEAD` pattern which can push
 * to a checked-out branch and cause data loss.
 */
export function pushHeadToOriginBranch(cwd: string, branch: string): void {
  log.info('Pushing HEAD to origin branch', { branch });
  try {
    execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {
      cwd,
      stdio: 'pipe',
    });
  } catch (err) {
    throwPushFailureWithStderr(err, NON_FAST_FORWARD_PUSH_HINT);
  }
}

export function relayPushCloneToOrigin(cloneCwd: string, rootCwd: string, branch: string): void {
  const tempRef = `refs/takt-relay/${branch}`;
  log.info('Relay push: fetching clone HEAD', { cloneCwd, rootCwd, tempRef });
  try {
    execFileSync('git', ['fetch', cloneCwd, `HEAD:${tempRef}`], { cwd: rootCwd, stdio: 'pipe' });
    log.info('Relay push: pushing to origin', { rootCwd, branch });
    execFileSync('git', ['push', 'origin', `${tempRef}:refs/heads/${branch}`], { cwd: rootCwd, stdio: 'pipe' });
    log.info('Relay push: succeeded', { rootCwd, branch });
  } finally {
    try {
      execFileSync('git', ['update-ref', '-d', tempRef], { cwd: rootCwd, stdio: 'pipe' });
      log.debug('Relay push: temp ref cleaned up', { tempRef });
    } catch {
      log.debug('Relay push: temp ref cleanup failed (non-fatal)', { tempRef });
    }
  }
}
