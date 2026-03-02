import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { error as logError } from '../../../shared/ui/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { pushBranch } from '../../../infra/task/index.js';
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

/** Push worktree → project dir, then project dir → origin */
export function pushWorktreeToOrigin(worktreePath: string, projectDir: string, branch: string): void {
  execFileSync('git', ['push', projectDir, 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  log.info('Pushed to main repo', { worktreePath, projectDir });

  pushBranch(projectDir, branch);
  log.info('Pushed to origin', { projectDir, branch });
}
