import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowRestartPoint, WorkflowResumePoint } from '../../../core/models/index.js';
import { resolveConfigValue } from '../../../infra/config/index.js';
import {
  resolveCloneBaseDir,
  type TaskInfo,
} from '../../../infra/task/index.js';
import { syncProjectLocalTaktForRetry } from '../../../infra/task/projectLocalTaktSync.js';
import { isRealPathInside } from '../../../shared/utils/index.js';

export interface ReusedWorktreeExecution {
  execCwd: string;
  branch?: string;
  worktreePath: string;
  isWorktree: true;
}

/**
 * Validate the trust boundary for a worktree that an existing task says to reuse.
 *
 * Callers that are about to operate on a task's existing worktree use this
 * named boundary before reading task data or mutating task state. Initial
 * executions may still choose a new clone when no reusable path is supplied;
 * retry/instruct callers must not use that fallback.
 */
export function assertReusableWorktreePath(projectDir: string, candidatePath: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Worktree directory does not exist: ${candidatePath}`, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Worktree path must not be a symlink: ${candidatePath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Worktree path is not a directory: ${candidatePath}`);
  }

  const realCandidatePath = fs.realpathSync(candidatePath);
  const cloneBaseDir = resolveCloneBaseDir(projectDir);
  const fallbackCloneBaseDir = path.join(projectDir, '.takt', 'worktrees');
  if (
    !isRealPathInside(cloneBaseDir, realCandidatePath)
    && !isRealPathInside(fallbackCloneBaseDir, realCandidatePath)
  ) {
    throw new Error(`Worktree path is outside the clone base directory: ${candidatePath}`);
  }
}

function shouldSyncProjectLocalTaktOnReuse(
  task: TaskInfo,
  configuredStartStep: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
  restartPoint: WorkflowRestartPoint | undefined,
  retryNote: unknown,
): boolean {
  if (task.status === 'failed' || task.status === 'pr_failed' || task.status === 'exceeded') {
    return true;
  }

  return task.resumeMode !== undefined
    || configuredStartStep !== undefined
    || resumePoint !== undefined
    || restartPoint !== undefined
    || typeof retryNote === 'string';
}

export function resolveReusedWorktreeExecution(
  projectDir: string,
  task: TaskInfo,
  configuredStartStep: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
  restartPoint: WorkflowRestartPoint | undefined,
  retryNote: unknown,
): ReusedWorktreeExecution | undefined {
  const worktreePath = task.worktreePath;
  const requiresExistingWorktree = task.resumeMode !== undefined
    || task.status === 'failed'
    || task.status === 'pr_failed'
    || task.status === 'exceeded';
  if (!worktreePath) {
    if (requiresExistingWorktree) {
      throw new Error(
        `Task "${task.name}" requires its existing worktree for ${task.resumeMode ?? task.status}, but the worktree path is missing; refusing to create a replacement clone.`,
      );
    }
    return undefined;
  }

  try {
    assertReusableWorktreePath(projectDir, worktreePath);
  } catch (error) {
    if (requiresExistingWorktree) {
      throw new Error(
        `Task "${task.name}" requires its existing worktree for ${task.resumeMode ?? task.status}, `
        + 'but the worktree is missing or invalid; refusing to create a replacement clone.',
        { cause: error },
      );
    }
    return undefined;
  }

  if (
    shouldSyncProjectLocalTaktOnReuse(task, configuredStartStep, resumePoint, restartPoint, retryNote)
    && resolveConfigValue(projectDir, 'syncProjectLocalTaktOnRetry')
  ) {
    syncProjectLocalTaktForRetry(projectDir, worktreePath);
  }

  return {
    execCwd: worktreePath,
    branch: task.data?.branch,
    worktreePath,
    isWorktree: true,
  };
}
