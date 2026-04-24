import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowResumePoint } from '../../../core/models/index.js';
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

function canReuseWorktreePath(projectDir: string, candidatePath: string): boolean {
  if (!fs.existsSync(candidatePath)) {
    return false;
  }

  const cloneBaseDir = resolveCloneBaseDir(projectDir);
  const fallbackCloneBaseDir = path.join(projectDir, '.takt', 'worktrees');
  return isRealPathInside(cloneBaseDir, candidatePath) || isRealPathInside(fallbackCloneBaseDir, candidatePath);
}

function shouldSyncProjectLocalTaktOnReuse(
  task: TaskInfo,
  configuredStartStep: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
  retryNote: unknown,
): boolean {
  if (task.status === 'failed' || task.status === 'pr_failed' || task.status === 'exceeded') {
    return true;
  }

  return configuredStartStep !== undefined
    || resumePoint !== undefined
    || typeof retryNote === 'string';
}

export function resolveReusedWorktreeExecution(
  projectDir: string,
  task: TaskInfo,
  configuredStartStep: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
  retryNote: unknown,
): ReusedWorktreeExecution | undefined {
  const worktreePath = task.worktreePath;
  if (!worktreePath || !canReuseWorktreePath(projectDir, worktreePath)) {
    return undefined;
  }

  if (
    shouldSyncProjectLocalTaktOnReuse(task, configuredStartStep, resumePoint, retryNote)
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
