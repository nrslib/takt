import type { PrGitOperations } from '../../../core/workflow/system/pr-execution-context.js';
import { runGitCommandAbortable } from '../../task/clone-exec.js';
import { buildSafeGitEnvironment } from '../../task/git-environment.js';

interface PrCloneGitOptions {
  readonly cwd: string;
  readonly headRepositoryUrl: string;
  readonly headRepositoryPushUrls: readonly string[];
  readonly baseRepositoryUrl: string;
  readonly allowGitHooks?: boolean;
  readonly allowGitFilters?: boolean;
  readonly abortSignal?: AbortSignal;
}

export async function createPrCloneGitOperations(options: PrCloneGitOptions): Promise<{
  headRepositoryUrl: string;
  headRepositoryPushUrls: string[];
  baseRepositoryUrl: string;
  operations: PrGitOperations;
}> {
  return {
    headRepositoryUrl: options.headRepositoryUrl,
    headRepositoryPushUrls: [...options.headRepositoryPushUrls],
    baseRepositoryUrl: options.baseRepositoryUrl,
    operations: {
      async fetch(remote, refspec) {
        const env = await buildSafeGitEnvironment(options.cwd, { ...options, allowGitFilters: false });
        await runGitCommandAbortable(options.cwd, ['fetch', '--force', remote, refspec], options.abortSignal, env);
      },
      async push(refspec) {
        const env = await buildSafeGitEnvironment(options.cwd, options);
        for (const url of options.headRepositoryPushUrls) {
          await runGitCommandAbortable(options.cwd, ['push', url, refspec], options.abortSignal, env);
        }
      },
    },
  };
}
