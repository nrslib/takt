import { runGitCommandAbortable } from '../../task/clone-exec.js';
import { buildSafeGitEnvironment } from '../../task/git-environment.js';

interface CacciaCloneGitOptions {
  readonly cwd: string;
  readonly headRepositoryUrl: string;
  readonly headRepositoryPushUrls: readonly string[];
  readonly allowGitHooks?: boolean;
  readonly allowGitFilters?: boolean;
  readonly abortSignal?: AbortSignal;
}

export interface CacciaGitOperations {
  fetch(refspec: string): Promise<void>;
  push(refspec: string): Promise<void>;
}

export async function createCacciaCloneGitOperations(options: CacciaCloneGitOptions): Promise<{
  headRepositoryUrl: string;
  headRepositoryPushUrls: string[];
  operations: CacciaGitOperations;
}> {
  return {
    headRepositoryUrl: options.headRepositoryUrl,
    headRepositoryPushUrls: [...options.headRepositoryPushUrls],
    operations: {
      async fetch(refspec) {
        const env = await buildSafeGitEnvironment(options.cwd, { ...options, allowGitFilters: false });
        await runGitCommandAbortable(options.cwd, ['fetch', '--no-tags', 'origin', refspec], options.abortSignal, env);
      },
      async push(refspec) {
        let firstFailure: unknown;
        const env = await buildSafeGitEnvironment(options.cwd, options);
        // git push origin と同じく、通常の拒否後も残りのpush先を試行する。
        for (const url of options.headRepositoryPushUrls) {
          try {
            await runGitCommandAbortable(options.cwd, ['push', url, refspec], options.abortSignal, env);
          } catch (error) {
            if (options.abortSignal?.aborted) throw error;
            firstFailure ??= error;
          }
        }
        if (firstFailure !== undefined) throw firstFailure;
      },
    },
  };
}
