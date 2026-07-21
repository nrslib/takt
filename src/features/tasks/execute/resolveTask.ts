import {
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
  resolveWorkflowConfigValue,
} from '../../../infra/config/index.js';
import {
  type TaskInfo,
  createSharedCloneAbortable,
  resolveBaseBranch,
  branchExists,
  summarizeTaskName,
  resolveTaskWorkflowValue,
  resolveTaskStartStepValue,
  TaskExecutionConfigSchema,
} from '../../../infra/task/index.js';
import type { WorkflowResumePoint } from '../../../core/models/index.js';
import type { RunResumeSource } from '../../../core/workflow/run/run-meta.js';
import { trimResumePointStackForWorkflow } from '../../../core/workflow/run/resume-point.js';
import { getGitProvider, type GitProvider, type Issue } from '../../../infra/git/index.js';
import { withProgress } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { generateReportDir } from '../../../shared/utils/reportDir.js';
import { generateExecutionReportDir } from '../../../core/workflow/run/run-slug.js';
import { getTaskSlugFromTaskDir } from '../../../shared/utils/taskPaths.js';
import { stageTaskSpecForExecution } from './taskSpecContext.js';
import { resolveReusedWorktreeExecution } from './reusedWorktree.js';
import type { ExecuteTaskOptions, TaskExecutionContextOverride } from './types.js';

const log = createLogger('task');

function resolveTaskDataBaseBranch(taskData: TaskInfo['data']): string | undefined {
  return taskData?.base_branch;
}

function resolveTaskBaseBranch(projectDir: string, preferredBaseBranch: string | undefined): string {
  return resolveBaseBranch(projectDir, preferredBaseBranch).branch;
}

function assertReusedWorktreeContext(
  task: TaskInfo,
  reusedWorktree: { branch?: string; worktreePath: string },
  contextOverride: TaskExecutionContextOverride | undefined,
): void {
  if (
    contextOverride?.branch !== undefined
    && reusedWorktree.branch !== undefined
    && contextOverride.branch !== reusedWorktree.branch
  ) {
    throw new Error(
      `Task "${task.name}" has existing worktree ${reusedWorktree.worktreePath} for branch "${reusedWorktree.branch ?? '<none>'}", ` +
      `but runtime taskContext.branch is "${contextOverride.branch}".`,
    );
  }

  const savedBaseBranch = resolveTaskDataBaseBranch(task.data);
  if (
    contextOverride?.baseBranch !== undefined
    && savedBaseBranch !== undefined
    && contextOverride.baseBranch !== savedBaseBranch
  ) {
    throw new Error(
      `Task "${task.name}" has existing worktree ${reusedWorktree.worktreePath} with base_branch "${savedBaseBranch ?? '<none>'}", ` +
      `but runtime taskContext.baseBranch is "${contextOverride.baseBranch}".`,
    );
  }
}

export interface ResolvedTaskExecution {
  execCwd: string;
  workflowIdentifier: string;
  isWorktree: boolean;
  reportDirName: string;
  taskPrompt?: string;
  orderContent?: string;
  branch?: string;
  worktreePath?: string;
  baseBranch?: string;
  startStep?: string;
  retryNote?: string;
  resumePoint?: WorkflowResumePoint;
  resumeSource?: RunResumeSource;
  autoPr: boolean;
  draftPr: boolean;
  managedPr: boolean;
  shouldPublishBranchToOrigin: boolean;
  issueNumber?: number;
  prNumber?: number;
  maxStepsOverride?: number;
  initialIterationOverride?: number;
}

export interface ResolveTaskExecutionOptions {
  outputMode?: ExecuteTaskOptions['outputMode'];
  taskContext?: TaskExecutionContextOverride;
}

function resolveRetryResume(
  workflowIdentifier: string,
  projectCwd: string,
  lookupCwd: string,
  configuredStartStep: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
): {
  startStep?: string;
  resumePoint?: WorkflowResumePoint;
} {
  if (!resumePoint) {
    return configuredStartStep ? { startStep: configuredStartStep } : {};
  }

  const workflowConfig = loadWorkflowByIdentifier(workflowIdentifier, projectCwd, { lookupCwd });
  if (!workflowConfig) {
    return {
      ...(configuredStartStep ? { startStep: configuredStartStep } : {}),
    };
  }

  const resolvedResumePoint = trimResumePointStackForWorkflow({
    workflow: workflowConfig,
    resumePoint,
    resolveWorkflowCall: (parentWorkflow, step) => resolveWorkflowCallTarget(
      parentWorkflow,
      step,
      projectCwd,
      lookupCwd,
    ),
  });
  const rootEntry = resolvedResumePoint?.stack[0];
  if (rootEntry) {
    return {
      startStep: rootEntry.step,
      resumePoint: resolvedResumePoint,
    };
  }

  return {
    ...(configuredStartStep ? { startStep: configuredStartStep } : {}),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Task execution aborted');
  }
}

async function runWithTaskProgress<T>(
  outputMode: ExecuteTaskOptions['outputMode'],
  message: string,
  successMessage: string | ((result: T) => string),
  action: () => Promise<T>,
): Promise<T> {
  if (outputMode === 'silent') {
    return action();
  }
  return withProgress(message, successMessage, action);
}

export function resolveTaskIssue(
  issueNumber: number | undefined,
  projectCwd: string,
  gitProvider?: GitProvider,
): Issue[] | undefined {
  if (issueNumber === undefined) {
    return undefined;
  }

  const resolvedGitProvider = gitProvider ?? getGitProvider();
  const cliStatus = resolvedGitProvider.checkCliStatus(projectCwd);
  if (!cliStatus.available) {
    log.info('VCS CLI unavailable, skipping issue resolution for PR body', { issueNumber });
    return undefined;
  }

  try {
    const issue = resolvedGitProvider.fetchIssue(issueNumber, projectCwd);
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
  options?: ResolveTaskExecutionOptions,
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
  const configuredStartStep = resolveTaskStartStepValue(normalizedData);
  const resumePoint = normalizedData.resume_point as WorkflowResumePoint | undefined;
  const retryNote = normalizedData.retry_note;

  let execCwd = defaultCwd;
  let isWorktree = false;
  let reportDirName: string | undefined;
  let taskPrompt: string | undefined;
  let orderContent: string | undefined;
  let branch: string | undefined;
  let worktreePath: string | undefined;
  let baseBranch: string | undefined;
  const contextOverride = options?.taskContext;
  if (contextOverride?.baseBranch !== undefined) {
    baseBranch = contextOverride.baseBranch;
  }
  const preferredBaseBranch = contextOverride?.baseBranch ?? resolveTaskDataBaseBranch(data);
  const contextBranch = contextOverride?.branch;
  if (task.taskDir) {
    const taskSlug = getTaskSlugFromTaskDir(task.taskDir);
    if (!taskSlug) {
      throw new Error(`Invalid task_dir format: ${task.taskDir}`);
    }
  }

  if (data.worktree) {
    throwIfAborted(abortSignal);
    const targetBranch = contextBranch ?? data.branch;
    const needsBaseBranch = !targetBranch || !branchExists(defaultCwd, targetBranch);
    baseBranch = needsBaseBranch
      ? resolveTaskBaseBranch(defaultCwd, preferredBaseBranch)
      : preferredBaseBranch;

    const reusedWorktree = resolveReusedWorktreeExecution(
      defaultCwd,
      task,
      configuredStartStep,
      resumePoint,
      retryNote,
    );
    if (reusedWorktree) {
      assertReusedWorktreeContext(task, reusedWorktree, contextOverride);
      execCwd = reusedWorktree.execCwd;
      branch = reusedWorktree.branch;
      worktreePath = reusedWorktree.worktreePath;
      isWorktree = reusedWorktree.isWorktree;
    } else {
      const taskSlug = task.slug ?? await runWithTaskProgress(
        options?.outputMode,
        'Generating branch name...',
        (slug) => `Branch name generated: ${slug}`,
        () => summarizeTaskName(task.content, { cwd: defaultCwd }),
      );

      throwIfAborted(abortSignal);
      const result = await runWithTaskProgress(
        options?.outputMode,
        'Creating clone...',
        (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
        async () => createSharedCloneAbortable(defaultCwd, {
          worktree: data.worktree!,
          branch: targetBranch,
          ...(preferredBaseBranch ? { baseBranch: preferredBaseBranch } : {}),
          taskSlug,
          issueNumber: data.issue,
        }, abortSignal),
      );
      throwIfAborted(abortSignal);
      execCwd = result.path;
      branch = result.branch;
      worktreePath = result.path;
      isWorktree = true;
    }
  } else if (contextBranch !== undefined) {
    branch = contextBranch;
  }

  if (task.taskDir) {
    reportDirName = generateExecutionReportDir(execCwd, task.content);
    const stagedTaskSpec = stageTaskSpecForExecution(defaultCwd, execCwd, task.taskDir, reportDirName);
    taskPrompt = stagedTaskSpec.taskPrompt;
    orderContent = stagedTaskSpec.orderContent;
  }

  const resolvedReportDirName = reportDirName ?? generateReportDir(task.content);
  const retryResume = resolveRetryResume(
    workflowIdentifier,
    defaultCwd,
    execCwd,
    configuredStartStep,
    resumePoint,
  );
  const resolvedRetryNote = data.retry_note;
  const resumeSource = task.resumeMode
    ? { ...(task.sourceRunSlug ? { sourceRunSlug: task.sourceRunSlug } : {}), resumeMode: task.resumeMode }
    : undefined;
  const maxStepsOverride = data.exceeded_max_steps;
  const initialIterationOverride = data.exceeded_current_iteration ?? retryResume.resumePoint?.iteration;

  const autoPr = data.auto_pr ?? resolveWorkflowConfigValue(defaultCwd, 'autoPr') ?? false;
  const draftPr = data.draft_pr ?? resolveWorkflowConfigValue(defaultCwd, 'draftPr') ?? false;
  const managedPr = data.managed_pr === true;
  const shouldPublishBranchToOrigin =
    normalizedData.should_publish_branch_to_origin === true || autoPr;

  return {
    execCwd,
    workflowIdentifier,
    isWorktree,
    reportDirName: resolvedReportDirName,
    autoPr,
    draftPr,
    managedPr,
    shouldPublishBranchToOrigin,
    ...(taskPrompt ? { taskPrompt } : {}),
    ...(orderContent !== undefined ? { orderContent } : {}),
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(retryResume.startStep ? { startStep: retryResume.startStep } : {}),
    ...(resolvedRetryNote ? { retryNote: resolvedRetryNote } : {}),
    ...(retryResume.resumePoint ? { resumePoint: retryResume.resumePoint } : {}),
    ...(resumeSource ? { resumeSource } : {}),
    ...(data.issue !== undefined ? { issueNumber: data.issue } : {}),
    ...(contextOverride?.prNumber !== undefined
      ? { prNumber: contextOverride.prNumber }
      : data.context_pr_number !== undefined ? { prNumber: data.context_pr_number } : {}),
    ...(maxStepsOverride !== undefined ? { maxStepsOverride } : {}),
    ...(initialIterationOverride !== undefined ? { initialIterationOverride } : {}),
  };
}
