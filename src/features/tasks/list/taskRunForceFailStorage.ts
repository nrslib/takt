import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import {
  readRunMetaBySlug,
  type RunMeta,
} from '../../../core/workflow/run/run-meta.js';
import { resolveCloneBaseDir } from '../../../infra/task/clone.js';
import type { TaskListItem } from '../../../infra/task/types.js';
import { isPathInside } from '../../../shared/utils/index.js';
import {
  createWorkflowRunCompositionForExistingRun,
} from '../execute/workflowRunStorage.js';
import type {
  WorkflowRunForceFailHandle,
} from '../execute/workflowRunAdmin.js';

interface ResolvedTaskRun {
  readonly cwd: string;
  readonly meta: RunMeta;
}

export function createTaskRunForceFailStorage(input: {
  readonly task: TaskListItem;
  readonly projectDir: string;
  readonly onWarning: (warning: string) => void;
}): WorkflowRunForceFailHandle | undefined {
  const run = resolveTaskRun(input);
  if (run === undefined) {
    return undefined;
  }
  const composition = createWorkflowRunCompositionForExistingRun(
    run.meta,
    {
      cwd: run.cwd,
      projectCwd: input.projectDir,
    },
  );
  return composition.admin.createForceFail({
    taskName: input.task.name,
    meta: run.meta,
  });
}

function resolveTaskRun(input: {
  readonly task: TaskListItem;
  readonly projectDir: string;
  readonly onWarning: (warning: string) => void;
}): ResolvedTaskRun | undefined {
  const runSlug = input.task.runSlug;
  if (runSlug === undefined) {
    return undefined;
  }
  for (const cwd of taskRunRoots(input.projectDir, input.task.worktreePath)) {
    const meta = readRunMetaBySlug(cwd, runSlug, input.onWarning);
    if (meta !== null) {
      return { cwd, meta };
    }
    const runPaths = buildRunPaths(cwd, runSlug);
    if (existsSync(runPaths.databaseAbs)) {
      throw new Error(
        `Run metadata is required for SQLite force-fail "${runSlug}"`,
      );
    }
  }
  return undefined;
}

function taskRunRoots(
  projectDir: string,
  worktreePath: string | undefined,
): readonly string[] {
  const safeWorktreePath = resolveSafeWorktreePath(projectDir, worktreePath);
  return safeWorktreePath === undefined
    ? [projectDir]
    : [safeWorktreePath, projectDir];
}

function resolveSafeWorktreePath(
  projectDir: string,
  worktreePath: string | undefined,
): string | undefined {
  if (worktreePath === undefined) {
    return undefined;
  }
  const cloneBaseDir = resolveCloneBaseDir(projectDir);
  const projectWorktreeDir = resolve(projectDir, '.takt', 'worktrees');
  return isPathInside(cloneBaseDir, worktreePath)
    || isPathInside(projectWorktreeDir, worktreePath)
    ? worktreePath
    : undefined;
}
