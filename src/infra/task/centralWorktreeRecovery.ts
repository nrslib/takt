import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';
import type { CentralTaskRecord } from './centralStateRepository.js';
import { assertCentralWorktreeOwnership } from './centralWorktreeOwnership.js';

interface CloneMetadata {
  readonly branch: string;
  readonly clonePath: string;
}

function readCloneMetadata(directory: string): readonly CloneMetadata[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const value = JSON.parse(readFileSync(join(directory, entry.name), 'utf8')) as unknown;
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
          const record = value as Readonly<Record<string, unknown>>;
          if (typeof record.branch !== 'string' || typeof record.clonePath !== 'string') return [];
          assertValidLocalBranchName(record.branch);
          return [{ branch: record.branch, clonePath: record.clonePath }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Recover execution context written by Web UI versions predating ledger persistence. */
export function recoverLegacyCentralWorktreeContext(
  projectDirectory: string,
  globalConfigDirectory: string,
  stateId: string,
  task: CentralTaskRecord,
): CentralTaskRecord {
  if (
    task.worktree === false
    || task.worktreePath !== undefined && task.branch !== undefined
    || task.status === 'pending'
    || task.status === 'starting'
    || task.status === 'running'
  ) {
    return task;
  }
  const metadataDirectory = join(
    globalConfigDirectory,
    'state',
    'projects',
    stateId,
    'worktree-metadata',
  );
  const taskBranchSuffix = `-${task.taskId.slice(0, 12)}`;
  const candidates = readCloneMetadata(metadataDirectory)
    .filter((candidate) => task.branch === undefined
      ? candidate.branch.endsWith(taskBranchSuffix)
      : candidate.branch === task.branch)
    .filter((candidate) => existsSync(candidate.clonePath))
    .sort((left, right) => right.branch.localeCompare(left.branch));
  for (const candidate of candidates) {
    const recovered = {
      ...task,
      branch: candidate.branch,
      worktreePath: candidate.clonePath,
    };
    try {
      assertCentralWorktreeOwnership(
        projectDirectory,
        globalConfigDirectory,
        stateId,
        recovered,
      );
      return recovered;
    } catch {
      // Try an older matching clone only when ownership validation rejects it.
    }
  }
  return task;
}
