import * as fs from 'node:fs';
import { localBranchExists, materializeCloneHeadToRootBranch, relayPushCloneToOrigin } from '../../../infra/task/index.js';
import { error as logError, info } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import type { BranchListItem, TaskListItem } from '../../../infra/task/index.js';

const log = createLogger('list-tasks');

export type ListAction = 'diff' | 'instruct' | 'sync' | 'pull' | 'try' | 'merge' | 'delete';

export type BranchActionTarget = TaskListItem | Pick<BranchListItem, 'info' | 'originalInstruction'>;

export function resolveTargetBranch(target: BranchActionTarget): string {
  if ('kind' in target) {
    if (!target.branch) {
      throw new Error(`Branch is required for task action: ${target.name}`);
    }
    return target.branch;
  }
  return target.info.branch;
}

export function resolveTargetWorktreePath(target: BranchActionTarget): string | undefined {
  if ('kind' in target) {
    return target.worktreePath;
  }
  return target.info.worktreePath;
}

export function resolveTargetInstruction(target: BranchActionTarget): string {
  if ('kind' in target) {
    return target.content;
  }
  return target.originalInstruction;
}

/**
 * Validates that the target is a task target with a valid worktree path.
 * Returns `false` with an error log if validation fails.
 * Throws if the target is not a task target (programming error).
 */
export function validateWorktreeTarget(
  target: BranchActionTarget,
  actionName: string,
): target is TaskListItem & { worktreePath: string } {
  if (!('kind' in target)) {
    throw new Error(`${actionName} requires a task target.`);
  }

  if (!target.worktreePath || !fs.existsSync(target.worktreePath)) {
    logError(`Worktree directory does not exist for task: ${target.name}`);
    return false;
  }
  return true;
}

export function ensureRootBranchReady(
  projectDir: string,
  target: BranchActionTarget,
  actionName: string,
): boolean {
  const branch = resolveTargetBranch(target);
  if (localBranchExists(projectDir, branch)) {
    return true;
  }

  const worktreePath = resolveTargetWorktreePath(target);
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    logError(`Branch ${branch} is missing in root, and no worktree is available to restore it.`);
    log.error('Root branch missing and worktree unavailable', {
      projectDir,
      branch,
      actionName,
      worktreePath,
    });
    return false;
  }

  try {
    materializeCloneHeadToRootBranch(worktreePath, projectDir, branch);
    info(`Restored missing root branch ${branch} from worktree.`);
    log.info('Restored missing root branch from worktree', {
      projectDir,
      branch,
      actionName,
      worktreePath,
    });
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError(`Failed to restore missing root branch ${branch}: ${error}`);
    log.error('Failed to restore missing root branch from worktree', {
      projectDir,
      branch,
      actionName,
      worktreePath,
      error,
    });
    return false;
  }
}

/** Relay push: clone HEAD を root repo 経由で origin へ転送する（checked-out branch を変更しない） */
export function pushWorktreeToOrigin(worktreePath: string, projectDir: string, branch: string): void {
  materializeCloneHeadToRootBranch(worktreePath, projectDir, branch);
  relayPushCloneToOrigin(worktreePath, projectDir, branch);
  log.info('Relay pushed to origin', { worktreePath, projectDir, branch });
}
