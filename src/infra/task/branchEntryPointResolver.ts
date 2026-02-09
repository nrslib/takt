import { createLogger } from '../../shared/utils/index.js';
import { parseDistinctHashes, runGit } from './branchGitCommands.js';

export type BranchEntryPoint = {
  baseCommit: string;
  firstCommit: string;
};

const log = createLogger('branchGitResolver');

export function resolveBranchEntryPointFromReflog(gitCwd: string, branch: string): BranchEntryPoint | null {
  try {
    const output = runGit(gitCwd, ['reflog', 'show', '--format=%H', branch]);
    const hashes = parseDistinctHashes(output).reverse();
    if (hashes.length < 2) {
      return null;
    }

    return {
      baseCommit: hashes[0]!,
      firstCommit: hashes[1]!,
    };
  } catch (error) {
    log.debug('Failed to resolve branch entry point from reflog', { error: String(error), gitCwd, branch });
    return null;
  }
}

export function readCommitSubject(gitCwd: string, commit: string): string {
  return runGit(gitCwd, ['show', '-s', '--format=%s', commit]);
}
