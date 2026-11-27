import { GitSelectorCommandRunner } from './selector-git-command-runner.js';
import { resolveGitRepositoryDirectory as resolveDirectory } from './gitRepositoryDirectory.js';

export async function isGitRepository(directory: string): Promise<boolean> {
  return new GitSelectorCommandRunner().isInsideWorkTree(directory, undefined);
}

export async function resolveGitRepositoryDirectory(directory: string): Promise<string> {
  return resolveDirectory(directory);
}
