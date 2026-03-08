import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePieceConfigValue } from '../../../infra/config/index.js';
import { type TaskInfo, buildTaskInstruction, createSharedClone, resolveBaseBranch, branchExists, summarizeTaskName } from '../../../infra/task/index.js';
import { getGitProvider, type Issue } from '../../../infra/git/index.js';
import { withProgress } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { getTaskSlugFromTaskDir } from '../../../shared/utils/taskPaths.js';

const log = createLogger('task');

function resolveTaskDataBaseBranch(taskData: TaskInfo['data']): string | undefined {
  return taskData?.base_branch;
}

function resolveTaskBaseBranch(projectDir: string, taskData: TaskInfo['data']): string {
  const preferredBaseBranch = resolveTaskDataBaseBranch(taskData);
  return resolveBaseBranch(projectDir, preferredBaseBranch).branch;
}

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
  draftPr: boolean;
  issueNumber?: number;
  maxMovementsOverride?: number;
  initialIterationOverride?: number;
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

  const runTaskDir = `.takt/runs/${reportDirName}/context/task`;
  const orderFile = `${runTaskDir}/order.md`;
  return buildTaskInstruction(runTaskDir, orderFile);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Task execution aborted');
  }
}

export function resolveTaskIssue(issueNumber: number | undefined): Issue[] | undefined {
  if (issueNumber === undefined) {
    return undefined;
  }

  const gitProvider = getGitProvider();
  const cliStatus = gitProvider.checkCliStatus();
  if (!cliStatus.available) {
    log.info('gh CLI unavailable, skipping issue resolution for PR body', { issueNumber });
    return undefined;
  }

  try {
    const issue = gitProvider.fetchIssue(issueNumber);
    return [issue];
  } catch (e) {
    log.info('Failed to fetch issue for PR body, continuing without issue info', { issueNumber, error: getErrorMessage(e) });
    return undefined;
  }
}

export async function resolveTaskExecution(
  task: TaskInfo,
  defaultCwd: string,
  abortSignal?: AbortSignal,
): Promise<ResolvedTaskExecution> {
  throwIfAborted(abortSignal);

  const data = task.data;
  if (!data) {
    throw new Error(`Task "${task.name}" is missing required data, including piece.`);
  }

  if (!data.piece || typeof data.piece !== 'string' || data.piece.trim() === '') {
    throw new Error(`Task "${task.name}" is missing required piece.`);
  }

  let execCwd = defaultCwd;
  let isWorktree = false;
  let reportDirName: string | undefined;
  let taskPrompt: string | undefined;
  let branch: string | undefined;
  let worktreePath: string | undefined;
  let baseBranch: string | undefined;
  const preferredBaseBranch = resolveTaskDataBaseBranch(data);
  if (task.taskDir) {
    const taskSlug = getTaskSlugFromTaskDir(task.taskDir);
    if (!taskSlug) {
      throw new Error(`Invalid task_dir format: ${task.taskDir}`);
    }
    reportDirName = taskSlug;
  }

  if (data.worktree) {
    throwIfAborted(abortSignal);
    // baseBranch resolution is only needed to create a new branch; for existing branches it's just metadata.
    const targetBranch = data.branch;
    const needsBaseBranch = !targetBranch || !branchExists(defaultCwd, targetBranch);
    baseBranch = needsBaseBranch
      ? resolveTaskBaseBranch(defaultCwd, data)
      : preferredBaseBranch;

    if (task.worktreePath && fs.existsSync(task.worktreePath)) {
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
          ...(preferredBaseBranch ? { baseBranch: preferredBaseBranch } : {}),
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

  const execPiece = data.piece;
  const startMovement = data.start_movement;
  const retryNote = data.retry_note;
  const maxMovementsOverride = data.exceeded_max_movements;
  const initialIterationOverride = data.exceeded_current_iteration;

  const autoPr = data.auto_pr ?? resolvePieceConfigValue(defaultCwd, 'autoPr') ?? false;
  const draftPr = data.draft_pr ?? resolvePieceConfigValue(defaultCwd, 'draftPr') ?? false;

  return {
    execCwd,
    execPiece,
    isWorktree,
    autoPr,
    draftPr,
    ...(taskPrompt ? { taskPrompt } : {}),
    ...(reportDirName ? { reportDirName } : {}),
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(startMovement ? { startMovement } : {}),
    ...(retryNote ? { retryNote } : {}),
    ...(data.issue !== undefined ? { issueNumber: data.issue } : {}),
    ...(maxMovementsOverride !== undefined ? { maxMovementsOverride } : {}),
    ...(initialIterationOverride !== undefined ? { initialIterationOverride } : {}),
  };
}
