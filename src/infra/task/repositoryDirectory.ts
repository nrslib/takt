import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { buildSafeGitEnvironment } from './git-environment.js';
import { GitSelectorCommandRunner } from './selector-git-command-runner.js';

export async function isGitRepository(directory: string): Promise<boolean> {
  return new GitSelectorCommandRunner().isInsideWorkTree(directory, undefined);
}

export async function resolveGitRepositoryDirectory(directory: string): Promise<string> {
  const cwd = await realpath(directory);
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8',
    env: await buildSafeGitEnvironment(cwd, { allowGitHooks: false, allowGitFilters: false }),
  });
  return realpath(stdout.replace(/\r?\n$/u, ''));
}
