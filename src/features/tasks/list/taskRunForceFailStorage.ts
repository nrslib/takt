import { resolve } from 'node:path';
import {
  readRunMetaBySlug,
  type RunMeta,
} from '../../../core/workflow/run/run-meta.js';
import { resolveCloneBaseDir } from '../../../infra/task/clone.js';
import type { TaskListItem } from '../../../infra/task/types.js';
import { resolveWorkflowConfigValue } from '../../../infra/config/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { isPathInside } from '../../../shared/utils/index.js';
import {
  createFileTaskRunForceFailStorage,
} from '../execute/workflowRunForceFailAdapters.js';
import { createLoopAnalysisScheduler } from '../execute/loopAnalysis.js';
import { createLoopAnalysisPublicationCoordinator } from '../execute/loopAnalysisPublication.js';
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
  let loopAnalysisScheduler: ReturnType<typeof createLoopAnalysisScheduler> = undefined;
  let loopAnalysisPublication:
    ReturnType<typeof createLoopAnalysisPublicationCoordinator> | undefined = undefined;
  try {
    const autoPr = input.task.data?.auto_pr
      ?? resolveWorkflowConfigValue(input.projectDir, 'autoPr')
      ?? false;
    const publication = autoPr && input.task.branch
      ? createLoopAnalysisPublicationCoordinator(input.task.branch)
      : undefined;
    const scheduler = createLoopAnalysisScheduler({
      projectCwd: input.projectDir,
      ...(publication === undefined ? {} : { publication }),
    });
    if (scheduler !== undefined) {
      loopAnalysisScheduler = scheduler;
      loopAnalysisPublication = publication;
    }
  } catch (error) {
    input.onWarning(
      `Loop analysis scheduling setup failed: ${getErrorMessage(error)}`,
    );
  }
  return createFileTaskRunForceFailStorage({
    taskName: input.task.name,
    meta: run.meta,
    cwd: run.cwd,
    projectDir: input.projectDir,
    ...(loopAnalysisScheduler === undefined ? {} : { loopAnalysisScheduler }),
    ...(loopAnalysisPublication === undefined
      ? {}
      : { loopAnalysisPublication }),
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
