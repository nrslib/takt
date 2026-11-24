import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireFileLocks, withFileLocks } from '../daemon/fileLocks.js';
import { conversationId } from './identity.js';

async function assignmentLockPaths(configDirectory: string, repositories: readonly string[]): Promise<string[]> {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(configDirectory);
  return repositories.map((repositoryDirectory) => join(directory, 'conversations', 'assignment-locks',
    `${conversationId({ kind: 'repository', repositoryDirectory })}.lock`));
}

export async function acquireRepositoryAssignmentLocks(configDirectory: string, canonicalRepositories: readonly string[],
  signal: AbortSignal): Promise<() => Promise<void>> {
  return acquireFileLocks(await assignmentLockPaths(configDirectory, canonicalRepositories), signal);
}

export async function withRepositoryAssignmentLocks<T>(configDirectory: string, canonicalRepositories: readonly string[],
  signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  return withFileLocks(await assignmentLockPaths(configDirectory, canonicalRepositories), signal, action);
}
