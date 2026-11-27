import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrGitOperations } from '../../core/workflow/system/pr-execution-context.js';
import { runGitCommandAbortable } from '../../infra/task/clone-exec.js';
import { suppressMergeDrivers } from '../../infra/task/git-merge-environment.js';
import { captureSyncConflictFiles } from '../../infra/service/syncConflictFiles.js';
import { runSyncConflictResolver } from '../../infra/service/runSyncConflictResolver.js';
import { getErrorMessage } from '../../shared/utils/index.js';

interface RetrySyncOptions {
  readonly projectCwd: string;
  readonly cwd: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly knownRemoteHeadSha: string;
  readonly isFork: boolean;
  readonly operations: PrGitOperations;
  readonly environment: NodeJS.ProcessEnv;
  readonly abortSignal?: AbortSignal;
}

export async function synchronizeRetryPrHead(options: RetrySyncOptions): Promise<string> {
  const { cwd, headSha, abortSignal } = options;
  const env = suppressMergeDrivers(cwd, options.environment);
  const git = async (args: string[]) =>
    (await runGitCommandAbortable(cwd, args, abortSignal, env)).stdout.trim();
  const mergeHeadPath = resolve(cwd, await git(['rev-parse', '--git-path', 'MERGE_HEAD']));
  if (existsSync(mergeHeadPath) || await git(['ls-files', '-u']) !== '') {
    throw new Error('PR retry clone has an unfinished merge');
  }
  const originalHead = await git(['rev-parse', 'HEAD']);
  await options.operations.fetch('origin', options.headRef);
  if (await git(['rev-parse', 'FETCH_HEAD']) !== headSha) {
    throw new Error('PR head changed during retry synchronization');
  }
  try {
    await git(['merge-base', '--is-ancestor', options.knownRemoteHeadSha, headSha]);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
      throw new Error('PR head history was rewritten since the last known remote head');
    }
    throw error;
  }
  if (originalHead !== headSha) {
    const mergeBase = await git(['merge-base', originalHead, headSha]);
    if (mergeBase === originalHead) {
      await git(['merge', '--ff-only', headSha]);
    } else if (mergeBase !== headSha) {
      try {
        await git(['merge', '--no-ff', '--no-edit', headSha]);
      } catch (mergeError) {
        // MERGE_HEAD was absent before this operation, so only this merge is ours to abort.
        if (!existsSync(mergeHeadPath)) throw mergeError;
        try {
          abortSignal?.throwIfAborted();
          if (await git(['ls-files', '-u']) === '') throw mergeError;
          if (options.isFork) throw new Error('Cannot resolve retry merge conflicts for a fork PR before threat checking');
          const conflictFiles = captureSyncConflictFiles(cwd, env);
          const response = await runSyncConflictResolver({
            projectCwd: options.projectCwd, cwd, abortSignal,
            originalInstruction: `Prepare a requeued PR merge task by incorporating PR head ${headSha} into clone HEAD ${originalHead}. Preserve both histories and resolve the current conflicts. Edit files only; TAKT will validate, stage, and complete the merge. Do not push or merge the base branch.`,
          });
          abortSignal?.throwIfAborted();
          if (response.status !== 'done') {
            throw new Error(response.error ?? 'AI conflict resolution failed');
          }
          conflictFiles.validateAndStage();
          await git(['commit', '--no-edit']);
          if (existsSync(mergeHeadPath) || await git(['ls-files', '-u']) !== '') {
            throw new Error('PR retry merge did not complete');
          }
        } catch (error) {
          try {
            // Cleanup must still run when the task signal has been aborted.
            await runGitCommandAbortable(cwd, ['merge', '--abort'], undefined, env);
          } catch (cleanupError) {
            throw new Error(`${getErrorMessage(error)}; merge abort failed: ${getErrorMessage(cleanupError)}`, { cause: error });
          }
          throw error;
        }
      }
    }
  }
  if (existsSync(mergeHeadPath) || await git(['ls-files', '-u']) !== '') {
    throw new Error('PR retry merge did not complete');
  }
  const synchronizedHead = await git(['rev-parse', 'HEAD']);
  for (const requiredHead of [originalHead, headSha]) {
    if (await git(['merge-base', requiredHead, synchronizedHead]) !== requiredHead) {
      throw new Error('PR retry synchronization did not preserve both histories');
    }
  }
  return synchronizedHead;
}
