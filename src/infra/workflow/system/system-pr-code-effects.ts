import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { stageAndCommit } from '../../task/git.js';
import { buildSafeGitEnvironment } from '../../task/git-environment.js';
import { toLocalBranchRef, toPullRequestBaseRef } from '../../../shared/utils/gitBranchValidation.js';
import { runSyncConflictResolver } from '../../service/runSyncConflictResolver.js';
import { getCommandErrorDetail } from './system-git-context.js';
import { runGitCommandAbortable } from '../../task/clone-exec.js';

function suppressMergeDrivers(cwd: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let names: string[];
  try {
    names = execFileSync('git', ['config', '--null', '--name-only', '--get-regexp', '^merge\\..*\\.driver$'], {
      cwd, env: environment, encoding: 'utf8', stdio: 'pipe',
    }).split('\0').filter(Boolean);
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) return environment;
    throw error;
  }
  if (names.length === 0) return environment;
  const env = { ...environment };
  let count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (const name of new Set(names)) {
    env[`GIT_CONFIG_KEY_${count}`] = name;
    env[`GIT_CONFIG_VALUE_${count}`] = 'false';
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

function requirePrClone(options: SystemStepServicesOptions, pr: number) {
  const context = options.prExecutionContext;
  if (!context || context.prNumber !== pr || options.cwd === options.projectCwd) {
    throw new Error('A matching isolated PR execution context is required');
  }
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: options.cwd, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  if (branch !== context.headBranch) throw new Error('PR clone is on a different head branch');
  return context;
}

function hasMergeHead(git: (args: string[]) => string): boolean {
  try {
    git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return true;
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) return false;
    throw error;
  }
}

export async function commitAndPushEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
): Promise<Record<string, unknown>> {
  try {
    const context = requirePrClone(options, payload.pr);
    await stageAndCommit(options.cwd, 'fix: apply TAKT PR review changes', options);
    const refspec = `HEAD:${toLocalBranchRef(context.headBranch)}`;
    if (options.prGitOperations) {
      await options.prGitOperations.push(refspec);
    } else {
      const urls = context.headRepositoryPushUrls;
      if (urls.length === 0 || urls.some((url) => !isAbsolute(url)
        && !/^[a-z][a-z\d+.-]*:\/\//iu.test(url) && !/^[^\s/:]+(?:@[^\s/:]+)?:.+/u.test(url))) {
        throw new Error('Explicit PR head push URLs are required');
      }
      const env = await buildSafeGitEnvironment(options.cwd, options);
      for (const url of urls) {
        await runGitCommandAbortable(options.cwd, ['push', url, refspec], options.abortSignal, env);
      }
    }
    const env = await buildSafeGitEnvironment(options.cwd, options);
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: options.cwd, encoding: 'utf8', stdio: 'pipe', env,
    }).trim();
    return { success: true, failed: false, headSha };
  } catch (error) {
    return { success: false, failed: true, error: getCommandErrorDetail(error) };
  }
}

function abortFailedMerge(
  abortMerge: (() => void) | undefined,
  failure: { failed: boolean; conflicted: boolean; error: string },
): Record<string, unknown> {
  try {
    abortMerge?.();
    return { success: false, ...failure };
  } catch (cleanupError) {
    return {
      success: false, ...failure, failed: true,
      error: `${failure.error}; merge abort failed: ${getCommandErrorDetail(cleanupError)}`,
    };
  }
}

export async function syncPrCloneEffect(
  options: SystemStepServicesOptions,
  payload: { pr: number },
  resolveConflicts: boolean,
): Promise<Record<string, unknown>> {
  let conflicted = false;
  let abortMerge: (() => void) | undefined;
  try {
    const context = requirePrClone(options, payload.pr);
    const env = suppressMergeDrivers(options.cwd, await buildSafeGitEnvironment(options.cwd, {
      ...options, allowGitFilters: false,
    }));
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: options.cwd, encoding: 'utf8', stdio: 'pipe', env,
    }).trim();
    const baseRef = toPullRequestBaseRef(context.baseBranch);
    options.abortSignal?.throwIfAborted();
    const refspec = `${toLocalBranchRef(context.baseBranch)}:${baseRef}`;
    if (options.prGitOperations) {
      await options.prGitOperations.fetch('base', refspec);
    } else {
      await runGitCommandAbortable(options.cwd, ['fetch', '--force', 'base', refspec], options.abortSignal, env);
    }
    try {
      options.abortSignal?.throwIfAborted();
      git(['merge', '--no-edit', baseRef]);
    } catch (error) {
      abortMerge = () => { git(['merge', '--abort']); };
      if (git(['ls-files', '-u']) === '') {
        abortMerge = undefined;
        throw error;
      }
      conflicted = true;
      if (!resolveConflicts) {
        return abortFailedMerge(abortMerge, { failed: false, conflicted: true, error: getCommandErrorDetail(error) });
      }
      const response = await runSyncConflictResolver({
        projectCwd: options.projectCwd, cwd: options.cwd, originalInstruction: options.task,
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      });
      options.abortSignal?.throwIfAborted();
      if (response.status !== 'done' || git(['ls-files', '-u']) !== '') {
        return abortFailedMerge(abortMerge, {
          failed: true, conflicted: true, error: response.error ?? 'AI conflict resolution failed',
        });
      }
      await stageAndCommit(options.cwd, 'fix: resolve PR merge conflicts', options);
      if (hasMergeHead(git)) {
        git(['commit', '--no-edit']);
      }
      if (hasMergeHead(git)) {
        throw new Error('PR merge commit was not created');
      }
      abortMerge = undefined;
    }
    return { success: true, failed: false, conflicted: false };
  } catch (error) {
    return abortFailedMerge(abortMerge, { failed: true, conflicted, error: getCommandErrorDetail(error) });
  }
}
