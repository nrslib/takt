import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWorkflowConfigValue } from '../../../infra/config/index.js';
import {
  type TaskInfo,
  buildTaskInstruction,
  createSharedClone,
  resolveBaseBranch,
  resolveCloneBaseDir,
  branchExists,
  summarizeTaskName,
  resolveTaskWorkflowValue,
  resolveTaskStartStepValue,
  TaskExecutionConfigSchema,
} from '../../../infra/task/index.js';
import { getGitProvider, type Issue } from '../../../infra/git/index.js';
import { withProgress } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage, isRealPathInside } from '../../../shared/utils/index.js';
import { getTaskSlugFromTaskDir } from '../../../shared/utils/taskPaths.js';

const log = createLogger('task');

function canReuseWorktreePath(projectDir: string, candidatePath: string): boolean {
  if (!fs.existsSync(candidatePath)) {
    return false;
  }

  const cloneBaseDir = resolveCloneBaseDir(projectDir);
  const fallbackCloneBaseDir = path.join(projectDir, '.takt', 'worktrees');
  return isRealPathInside(cloneBaseDir, candidatePath) || isRealPathInside(fallbackCloneBaseDir, candidatePath);
}

function resolveTaskDataBaseBranch(taskData: TaskInfo['data']): string | undefined {
  return taskData?.base_branch;
}

function resolveTaskBaseBranch(projectDir: string, taskData: TaskInfo['data']): string {
  const preferredBaseBranch = resolveTaskDataBaseBranch(taskData);
  return resolveBaseBranch(projectDir, preferredBaseBranch).branch;
}

export interface ResolvedTaskExecution {
  execCwd: string;
  workflowIdentifier: string;
  isWorktree: boolean;
  taskPrompt?: string;
  reportDirName?: string;
  branch?: string;
  worktreePath?: string;
  baseBranch?: string;
  startStep?: string;
  retryNote?: string;
  autoPr: boolean;
  draftPr: boolean;
  shouldPublishBranchToOrigin: boolean;
  issueNumber?: number;
  maxStepsOverride?: number;
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

export function resolveTaskIssue(issueNumber: number | undefined, projectCwd: string): Issue[] | undefined {
  if (issueNumber === undefined) {
    return undefined;
  }

  const gitProvider = getGitProvider();
  const cliStatus = gitProvider.checkCliStatus(projectCwd);
  if (!cliStatus.available) {
    log.info('VCS CLI unavailable, skipping issue resolution for PR body', { issueNumber });
    return undefined;
  }

  try {
    const issue = gitProvider.fetchIssue(issueNumber, projectCwd);
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
    throw new Error(`Task "${task.name}" is missing required data, including workflow.`);
  }

  const validationData = { ...data } as Record<string, unknown>;
  delete validationData.task;
  delete validationData.baseBranch;
  const normalizedData = TaskExecutionConfigSchema.parse(validationData) as Record<string, unknown>;
  const workflowIdentifier = resolveTaskWorkflowValue(normalizedData);
  if (!workflowIdentifier || workflowIdentifier.trim() === '') {
    throw new Error(`Task "${task.name}" is missing required workflow.`);
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
    const targetBranch = data.branch;
    const needsBaseBranch = !targetBranch || !branchExists(defaultCwd, targetBranch);
    baseBranch = needsBaseBranch
      ? resolveTaskBaseBranch(defaultCwd, data)
      : preferredBaseBranch;

    if (task.worktreePath && canReuseWorktreePath(defaultCwd, task.worktreePath)) {
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

  const startStep = resolveTaskStartStepValue(normalizedData);
  const retryNote = data.retry_note;
  const maxStepsOverride = data.exceeded_max_steps;
  const initialIterationOverride = data.exceeded_current_iteration;

  const autoPr = data.auto_pr ?? resolveWorkflowConfigValue(defaultCwd, 'autoPr') ?? false;
  const draftPr = data.draft_pr ?? resolveWorkflowConfigValue(defaultCwd, 'draftPr') ?? false;
  const shouldPublishBranchToOrigin =
    normalizedData.should_publish_branch_to_origin === true || autoPr;

  return {
    execCwd,
    workflowIdentifier,
    isWorktree,
    autoPr,
    draftPr,
    shouldPublishBranchToOrigin,
    ...(taskPrompt ? { taskPrompt } : {}),
    ...(reportDirName ? { reportDirName } : {}),
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(startStep ? { startStep } : {}),
    ...(retryNote ? { retryNote } : {}),
    ...(data.issue !== undefined ? { issueNumber: data.issue } : {}),
    ...(maxStepsOverride !== undefined ? { maxStepsOverride } : {}),
    ...(initialIterationOverride !== undefined ? { initialIterationOverride } : {}),
  };
}
