import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CentralTaskRecord } from './centralStateRepository.js';
import { loadCloneMeta } from './clone-meta.js';
import { isRealPathInside } from '../../shared/utils/pathBoundary.js';

/** The central ledger and worker use the same ownership boundary. */
export interface CentralWorktreeOwnership {
  readonly branch: string;
  readonly worktreePath: string;
  readonly metadataDirectory: string;
}

export class CentralWorktreeOwnershipError extends Error {
  readonly code = 'CENTRAL_WORKTREE_OWNERSHIP_INVALID';
}

function requireBranch(task: Pick<CentralTaskRecord, 'branch'>): string {
  const branch = task.branch;
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new CentralWorktreeOwnershipError('This task has no branch target');
  }
  return branch;
}

/**
 * Resolve and verify a task worktree without following a user-controlled
 * symlink.  Callers must treat a failure as terminal; a missing or mismatched
 * worktree must never silently turn into a newly-created clone.
 */
export function assertCentralWorktreeOwnership(
  projectDirectory: string,
  globalConfigDirectory: string,
  stateId: string,
  task: Pick<CentralTaskRecord, 'worktree' | 'worktreePath' | 'branch'>,
): CentralWorktreeOwnership {
  if (task.worktree === false || task.worktreePath === undefined) {
    throw new CentralWorktreeOwnershipError('This task has no owned central worktree');
  }
  const branch = requireBranch(task);
  const worktreePath = resolve(task.worktreePath);
  if (worktreePath === resolve(projectDirectory)) {
    throw new CentralWorktreeOwnershipError('Refusing to use the project directory as a task worktree');
  }
  const metadataDirectory = join(
    globalConfigDirectory,
    'state',
    'projects',
    stateId,
    'worktree-metadata',
  );
  const cloneMeta = loadCloneMeta(projectDirectory, branch, metadataDirectory);
  if (cloneMeta === null || typeof cloneMeta.clonePath !== 'string') {
    throw new CentralWorktreeOwnershipError('Central worktree ownership metadata is missing');
  }
  if (resolve(cloneMeta.clonePath) !== worktreePath) {
    throw new CentralWorktreeOwnershipError('Central worktree ownership metadata does not match the task');
  }
  let worktreeRealPath: string;
  try {
    const stats = lstatSync(worktreePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new CentralWorktreeOwnershipError('Central worktree is not a regular directory');
    }
    worktreeRealPath = realpathSync(worktreePath);
  } catch (error) {
    if (error instanceof CentralWorktreeOwnershipError) throw error;
    throw new CentralWorktreeOwnershipError('Central worktree cannot be inspected');
  }
  const configuredRoot = typeof task.worktree === 'string'
    ? resolve(task.worktree)
    : undefined;
  const knownRoots = [
    resolve(globalConfigDirectory, 'worktrees', stateId),
    resolve(projectDirectory, '..', 'takt-worktrees'),
    resolve(projectDirectory, '.takt', 'worktrees'),
    ...(configuredRoot === undefined ? [] : [configuredRoot]),
  ];
  if (!knownRoots.some((root) => isRealPathInside(root, worktreeRealPath))) {
    throw new CentralWorktreeOwnershipError('Central worktree is outside its owned root');
  }
  if (!existsSync(worktreePath)) {
    throw new CentralWorktreeOwnershipError('Central worktree is unavailable');
  }
  return { branch, worktreePath, metadataDirectory };
}
