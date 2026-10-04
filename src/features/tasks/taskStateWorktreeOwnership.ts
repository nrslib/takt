import * as path from 'node:path';
import { getCloneMetaPath } from '../../infra/task/clone-meta.js';
import type { TaskState } from '../../infra/task/index.js';
import { assertValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';
import { isPathInside } from '../../shared/utils/pathBoundary.js';
import { readPrivateFileState } from '../../shared/utils/private-file.js';
import { assertReusableWorktreePath } from './execute/reusedWorktree.js';

type TaskStateWorktree = Pick<TaskState, 'branch' | 'worktreePath'>;

function ownershipError(message: string, cause?: unknown): Error {
  return new Error(`Task worktree ownership validation failed: ${message}`, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnershipMetadata(projectCwd: string, branch: string, worktreePath: string): void {
  const metadataPath = getCloneMetaPath(projectCwd, branch);
  if (!isPathInside(projectCwd, metadataPath)) {
    throw ownershipError(`ownership metadata is outside the project: ${metadataPath}`);
  }

  let snapshot: ReturnType<typeof readPrivateFileState>;
  try {
    snapshot = readPrivateFileState(metadataPath);
  } catch (error) {
    throw ownershipError(`ownership metadata is not a regular file: ${metadataPath}`, error);
  }
  if (!('content' in snapshot)) {
    throw ownershipError(`ownership metadata is missing: ${metadataPath}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(snapshot.content.toString('utf8')) as unknown;
  } catch (error) {
    throw ownershipError(`ownership metadata is not valid JSON: ${metadataPath}`, error);
  }
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || typeof value.branch !== 'string'
    || typeof value.clonePath !== 'string') {
    throw ownershipError(`ownership metadata has an invalid shape: ${metadataPath}`);
  }
  try {
    assertValidLocalBranchName(value.branch);
  } catch (error) {
    throw ownershipError(`ownership metadata has an invalid branch: ${metadataPath}`, error);
  }
  if (value.branch !== branch) {
    throw ownershipError(`ownership metadata branch does not match the task: ${metadataPath}`);
  }
  if (!path.isAbsolute(value.clonePath) || path.resolve(value.clonePath) !== path.resolve(worktreePath)) {
    throw ownershipError(`ownership metadata path does not match the task: ${metadataPath}`);
  }
}

/**
 * Validate a worktree referenced by task state before reading its run data or
 * writing an intervention. Project-local fallback clones retain their
 * existing path boundary; clones outside the project additionally require the
 * project's clone metadata to match the task branch and path.
 */
export function assertTaskStateWorktreeOwnership(
  projectCwd: string,
  task: TaskStateWorktree,
): void {
  const worktreePath = task.worktreePath;
  if (worktreePath === undefined) {
    return;
  }

  assertReusableWorktreePath(projectCwd, worktreePath);
  if (isPathInside(projectCwd, path.resolve(worktreePath))) {
    return;
  }

  if (typeof task.branch !== 'string' || task.branch.length === 0) {
    throw ownershipError('an external worktree requires a branch');
  }
  try {
    assertValidLocalBranchName(task.branch);
  } catch (error) {
    throw ownershipError('the task branch is invalid', error);
  }
  readOwnershipMetadata(projectCwd, task.branch, worktreePath);

  // Recheck the path boundary after reading metadata so a replacement during
  // metadata inspection cannot turn the next read into an unvalidated clone.
  assertReusableWorktreePath(projectCwd, worktreePath);
}
