import {
  loadWorkflowByIdentifier,
  isWorkflowPath,
} from '../../../infra/config/index.js';
import { createSharedClone, summarizeTaskName, resolveBaseBranch, TaskRunner } from '../../../infra/task/index.js';
import { info, error, warn, withProgress } from '../../../shared/ui/index.js';
import { statusLine } from '../../../shared/ui/StatusLine.js';
import { createLogger } from '../../../shared/utils/index.js';
import { generateExecutionReportDir } from '../../../core/workflow/run/run-slug.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { executeTaskWithResult } from './taskExecution.js';
import type { TaskExecutionOptions, WorktreeConfirmationResult, SelectAndExecuteOptions } from './types.js';
import { selectWorkflow } from '../../workflowSelection/index.js';
import { buildBooleanTaskResult, persistTaskError, persistTaskResult } from './taskResultHandler.js';
import { prepareTaskSpecDirectory, cleanupPreparedTaskSpec } from '../attachments.js';
import {
  resolveTaskSpecForExecution,
  type ResolvedTaskSpec,
} from './taskSpecContext.js';
import { buildTraceTaskMetadata } from './traceTaskMetadata.js';

export type { WorktreeConfirmationResult, SelectAndExecuteOptions };

const log = createLogger('selectAndExecute');

function cleanupTransientTaskSpecs(
  preparedSpecTaskDir: string | undefined,
): void {
  if (preparedSpecTaskDir) {
    cleanupPreparedTaskSpec(preparedSpecTaskDir);
  }
}

type WorkflowResolution =
  | { readonly kind: 'resolved'; readonly identifier: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string };

async function resolveWorkflow(cwd: string, override?: string): Promise<WorkflowResolution> {
  if (override) {
    if (isWorkflowPath(override)) {
      return { kind: 'resolved', identifier: override };
    }
    const resolvedWorkflow = loadWorkflowByIdentifier(override, cwd);
    if (!resolvedWorkflow) {
      return { kind: 'failed', reason: `Workflow not found: ${sanitizeTerminalText(override)}` };
    }
    return { kind: 'resolved', identifier: override };
  }
  const identifier = await selectWorkflow(cwd);
  return identifier === null ? { kind: 'cancelled' } : { kind: 'resolved', identifier };
}

export async function determineWorkflow(cwd: string, override?: string): Promise<string | null> {
  const resolution = await resolveWorkflow(cwd, override);
  if (resolution.kind === 'failed') {
    error(resolution.reason);
  }
  return resolution.kind === 'resolved' ? resolution.identifier : null;
}

export async function confirmAndCreateWorktree(
  cwd: string,
  task: string,
  createWorktreeOverride: boolean,
  branchOverride?: string,
  baseBranchOverride?: string,
  materializePullRequestDiff: boolean = false,
): Promise<WorktreeConfirmationResult> {
  if (!createWorktreeOverride) {
    return { execCwd: cwd, isWorktree: false };
  }

  const baseBranch = materializePullRequestDiff && baseBranchOverride !== undefined
    ? baseBranchOverride
    : resolveBaseBranch(cwd, baseBranchOverride).branch;

  const taskSlug = await withProgress(
    'Generating branch name...',
    (slug) => `Branch name generated: ${slug}`,
    () => summarizeTaskName(task, { cwd }),
  );

  const result = await withProgress(
    'Creating clone...',
    (cloneResult) => `Clone created: ${cloneResult.path} (branch: ${cloneResult.branch})`,
        async () => createSharedClone(cwd, {
          worktree: true,
          taskSlug,
          ...(baseBranchOverride ? { baseBranch: baseBranchOverride } : {}),
          ...(branchOverride ? { branch: branchOverride } : {}),
          ...(materializePullRequestDiff ? { pullRequestBaseBranch: baseBranch } : {}),
        }),
      );

  return {
    execCwd: result.path,
    isWorktree: true,
    branch: result.branch,
    baseBranch,
    taskSlug,
    ...(result.pullRequestBaseRef
      ? {
        pullRequestBaseRef: result.pullRequestBaseRef,
        pullRequestHeadRef: result.pullRequestHeadRef,
      }
      : {}),
  };
}

export type TaskExecutionOutcome = { readonly kind: 'cancelled' } | { readonly success: boolean; readonly reason?: string };

export function selectAndExecuteTask(
  cwd: string,
  task: string,
  options: SelectAndExecuteOptions & { failureMode: 'return' },
  agentOverrides?: TaskExecutionOptions,
): Promise<TaskExecutionOutcome>;
export function selectAndExecuteTask(
  cwd: string,
  task: string,
  options?: SelectAndExecuteOptions,
  agentOverrides?: TaskExecutionOptions,
): Promise<void>;
export async function selectAndExecuteTask(
  cwd: string,
  task: string,
  options?: SelectAndExecuteOptions,
  agentOverrides?: TaskExecutionOptions,
): Promise<TaskExecutionOutcome | void> {
  let workflowIdentifier: string;
  if (options?.failureMode === 'return') {
    const resolution = await resolveWorkflow(cwd, options.workflow);
    if (resolution.kind === 'failed') {
      return { success: false, reason: resolution.reason };
    }
    if (resolution.kind === 'cancelled') {
      info('Cancelled');
      return { kind: 'cancelled' };
    }
    workflowIdentifier = resolution.identifier;
  } else {
    const identifier = await determineWorkflow(cwd, options?.workflow);
    if (identifier === null) {
      info('Cancelled');
      return;
    }
    workflowIdentifier = identifier;
  }

  const execCwd = cwd;
  log.info('Starting task execution', { workflow: workflowIdentifier, worktree: false });
  const taskRunner = new TaskRunner(cwd, { onWarning: warn });
  let taskRecord: Awaited<ReturnType<TaskRunner['addTask']>> | null = null;
  let preparedSpec: ReturnType<typeof prepareTaskSpecDirectory> | undefined;
  let taskSpec: ResolvedTaskSpec | undefined;
  let reportDirName = options?.reportDirName;
  try {
    preparedSpec = options?.attachments && options.attachments.length > 0
      ? prepareTaskSpecDirectory(cwd, task, options.attachments)
      : undefined;
    if (preparedSpec) {
      reportDirName = reportDirName ?? generateExecutionReportDir(execCwd, task);
      taskSpec = resolveTaskSpecForExecution(
        cwd,
        execCwd,
        preparedSpec.taskDirRelative,
        reportDirName,
      );
    }
  } catch (error) {
    if (preparedSpec) {
      cleanupPreparedTaskSpec(preparedSpec.taskDir);
    }
    throw error;
  }
  if (options?.skipTaskList !== true) {
    try {
      taskRecord = taskRunner.addTask(task, {
        workflow: workflowIdentifier,
        ...(preparedSpec ? { task_dir: preparedSpec.taskDirRelative } : {}),
      });
    } catch (error) {
      cleanupTransientTaskSpecs(preparedSpec?.taskDir);
      throw error;
    }
  }
  const preparedSpecTaskDirToCleanup = options?.skipTaskList === true ? preparedSpec?.taskDir : undefined;
  const startedAt = new Date().toISOString();

  statusLine.start('Running...');
  let executionResult: Awaited<ReturnType<typeof executeTaskWithResult>>;
  try {
    executionResult = await executeTaskWithResult({
      task: taskSpec?.taskPrompt ?? task,
      ...(taskSpec === undefined ? {} : { taskSpec }),
      cwd: execCwd,
      workflowIdentifier,
      projectCwd: cwd,
      agentOverrides,
      interactiveUserInput: options?.interactiveUserInput === true,
      interactiveMetadata: options?.interactiveMetadata,
      ...(reportDirName ? { reportDirName } : {}),
      ...(options?.providerProfileOverrides ? { providerProfileOverrides: options.providerProfileOverrides } : {}),
      traceTaskMetadata: buildTraceTaskMetadata({
        task: taskRecord ?? undefined,
        taskContent: taskSpec?.taskPrompt ?? task,
        source: options?.traceTaskContext?.source,
        issueNumber: options?.traceTaskContext?.issueNumber,
        prNumber: options?.traceTaskContext?.prNumber,
        branch: options?.traceTaskContext?.branch,
        baseBranch: options?.traceTaskContext?.baseBranch,
        taskSlug: options?.traceTaskContext?.taskSlug,
        worktreePath: options?.traceTaskContext?.worktreePath,
      }),
      ...(options?.prContext ? { prContext: options.prContext } : {}),
    });
  } catch (err) {
    const completedAt = new Date().toISOString();
    if (taskRecord) {
      persistTaskError(taskRunner, taskRecord, startedAt, completedAt, err, {
        responsePrefix: 'Task failed: ',
      });
    }
    throw err;
  } finally {
    statusLine.stop();
    cleanupTransientTaskSpecs(preparedSpecTaskDirToCleanup);
  }

  const completedAt = new Date().toISOString();

  if (taskRecord) {
    const taskResult = buildBooleanTaskResult({
      task: taskRecord,
      taskSuccess: executionResult.success,
      successResponse: 'Task completed successfully',
      failureResponse: 'Task failed',
      startedAt,
      completedAt,
    });
    persistTaskResult(taskRunner, taskResult);
  }

  if (!executionResult.success) {
    switch (options?.failureMode ?? 'exit') {
      case 'return':
        return { success: false, ...(executionResult.reason === undefined ? {} : { reason: executionResult.reason }) };
      case 'throw':
        throw new Error('Task failed');
      case 'exit':
        process.exit(1);
    }
  }
  if (options?.failureMode === 'return') {
    return { success: true };
  }
}
