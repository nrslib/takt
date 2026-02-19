import type { BranchListItem, TaskListItem } from '../../../infra/task/index.js';

export type ListAction = 'diff' | 'instruct' | 'sync' | 'try' | 'merge' | 'delete';

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
