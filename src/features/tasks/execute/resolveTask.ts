/**
 * Resolve execution directory and piece from task data.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePieceConfigValue } from '../../../infra/config/index.js';
import { type TaskInfo, createSharedClone, summarizeTaskName, getCurrentBranch } from '../../../infra/task/index.js';
import { withProgress } from '../../../shared/ui/index.js';
import { getTaskSlugFromTaskDir } from '../../../shared/utils/taskPaths.js';

export interface ResolvedTaskExecution {
  execCwd: string;
  execPiece: string;
  isWorktree: boolean;
  taskPrompt?: string;
  reportDirName?: string;
  branch?: string;
  worktreePath?: string;
  baseBranch?: string;
  startMovement?: string;
  retryNote?: string;
  autoPr: boolean;
  issueNumber?: number;
}

function buildRunTaskDirInstruction(reportDirName: string): string {
  const runTaskDir = `.takt/runs/${reportDirName}/context/task`;
  const orderFile = `${runTaskDir}/order.md`;
  return [
    `Implement using only the files in \`${runTaskDir}\`.`,
    `Primary spec: \`${orderFile}\`.`,
    'Use report files in Report Directory as primary execution history.',
    'Do not rely on previous response or conversation summary.',
  ].join('\n');
}

function stageTaskSpecForExecution(
  projectCwd: string,
  execCwd: string,
  taskDir: string,
  reportDirName: string,
): string {
  const sourceOrderPath = path.join(projectCwd, taskDir, 'order.md');
  if (!fs.existsSync(sourceOrderPath)) {
    throw new Error(`Task spec file is missing: ${sourceOrderPath}`);
  }

  const targetTaskDir = path.join(execCwd, '.takt', 'runs', reportDirName, 'context', 'task');
  const targetOrderPath = path.join(targetTaskDir, 'order.md');
  fs.mkdirSync(targetTaskDir, { recursive: true });
  fs.copyFileSync(sourceOrderPath, targetOrderPath);

  return buildRunTaskDirInstruction(reportDirName);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Task execution aborted');
  }
}

/**
 * Resolve execution directory and piece from task data.
 * If the task has worktree settings, create a shared clone and use it as cwd.
 * Task name is summarized to English by AI for use in branch/clone names.
 */
export async function resolveTaskExecution(
  task: TaskInfo,
  defaultCwd: string,
  defaultPiece: string,
  abortSignal?: AbortSignal,
): Promise<ResolvedTaskExecution> {
  throwIfAborted(abortSignal);

  const data = task.data;
  if (!data) {
    return { execCwd: defaultCwd, execPiece: defaultPiece, isWorktree: false, autoPr: false };
  }

  let execCwd = defaultCwd;
  let isWorktree = false;
  let reportDirName: string | undefined;
  let taskPrompt: string | undefined;
  let branch: string | undefined;
  let worktreePath: string | undefined;
  let baseBranch: string | undefined;
  if (task.taskDir) {
    const taskSlug = getTaskSlugFromTaskDir(task.taskDir);
    if (!taskSlug) {
      throw new Error(`Invalid task_dir format: ${task.taskDir}`);
    }
    reportDirName = taskSlug;
  }

  if (data.worktree) {
    throwIfAborted(abortSignal);
    baseBranch = getCurrentBranch(defaultCwd);

    if (task.worktreePath && fs.existsSync(task.worktreePath)) {
      // Reuse existing worktree (clone still on disk from previous execution)
      execCwd = task.worktreePath;
      branch = data.branch;
      worktreePath = task.worktreePath;
      isWorktree = true;
    } else {
      const taskSlug = task.slug ?? await withProgress(
        'Generating branch name...',
        (slug) => `Branch name generated: ${slug}`,
        () => summarizeTaskName(task.content, { cwd: defaultCwd }),
      );

      throwIfAborted(abortSignal);
      const result = await withProgress(
        'Creating clone...',
        (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
        async () => createSharedClone(defaultCwd, {
          worktree: data.worktree!,
          branch: data.branch,
          taskSlug,
          issueNumber: data.issue,
        }),
      );
      throwIfAborted(abortSignal);
      execCwd = result.path;
      branch = result.branch;
      worktreePath = result.path;
      isWorktree = true;
    }
  }

  if (task.taskDir && reportDirName) {
    taskPrompt = stageTaskSpecForExecution(defaultCwd, execCwd, task.taskDir, reportDirName);
  }

  const execPiece = data.piece || defaultPiece;
  const startMovement = data.start_movement;
  const retryNote = data.retry_note;

  let autoPr: boolean;
  if (data.auto_pr !== undefined) {
    autoPr = data.auto_pr;
  } else {
    autoPr = resolvePieceConfigValue(defaultCwd, 'autoPr') ?? false;
  }

  return {
    execCwd,
    execPiece,
    isWorktree,
    autoPr,
    ...(taskPrompt ? { taskPrompt } : {}),
    ...(reportDirName ? { reportDirName } : {}),
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(startMovement ? { startMovement } : {}),
    ...(retryNote ? { retryNote } : {}),
    ...(data.issue !== undefined ? { issueNumber: data.issue } : {}),
  };
}
