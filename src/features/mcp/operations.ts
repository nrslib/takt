import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { TaskRunner, type TaskInfo } from '../../infra/task/index.js';
import { getGitProvider, initGitProvider, type CloseIssueResult, type GitProvider } from '../../infra/git/index.js';
import {
  createIssueFromTaskResult as defaultCreateIssueFromTaskResult,
  saveTaskFile as defaultSaveTaskFile,
} from '../tasks/add/index.js';
import {
  createIssueAndEnqueueTask,
  enqueueTask,
  type IssueEnqueueCompensationInput,
  type IssueEnqueueFailure,
} from '../../infra/task/enqueueService.js';
import {
  executeRunTaskAndCompleteWithDetails as defaultExecuteRunTaskAndCompleteWithDetails,
  type TaskCompletionResult,
  type RunTaskExecutionContext,
} from '../tasks/execute/runTaskExecution.js';
import type { TaskExecutionOptions, TaskExecutionParallelOptions } from '../tasks/execute/types.js';
import type {
  CreateIssueAndEnqueueTaskInput,
  EnqueueTaskInput,
  RunNextTaskInput,
} from './schemas.js';

type SaveTaskFile = typeof defaultSaveTaskFile;
type CreateIssueFromTaskResult = typeof defaultCreateIssueFromTaskResult;
type ExecuteRunTaskAndCompleteWithDetails = typeof defaultExecuteRunTaskAndCompleteWithDetails;
type CreateTaskRunner = (cwd: string) => TaskRunner;
type CompensateCreatedIssue = (input: IssueEnqueueCompensationInput) => CloseIssueResult;

export interface McpOperationDependencies {
  saveTaskFile?: SaveTaskFile;
  createIssueFromTaskResult?: CreateIssueFromTaskResult;
  compensateCreatedIssue?: CompensateCreatedIssue;
  createTaskRunner?: CreateTaskRunner;
  executeRunTaskAndCompleteWithDetails?: ExecuteRunTaskAndCompleteWithDetails;
}

function textResult(text: string, isError?: boolean): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text }],
  };
}

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return textResult(JSON.stringify(value));
}

function safeMcpErrorCause(error: unknown): string {
  return safeExternalErrorMessage(error);
}

function errorResult(action: string, error: unknown): CallToolResult {
  return textResult(`${action}: ${safeMcpErrorCause(error)}`, true);
}

function resolveWorkflow(workflow: string | undefined): string {
  return workflow ?? DEFAULT_WORKFLOW_NAME;
}

function buildTaskExecutionOptions(input: RunNextTaskInput): TaskExecutionOptions | undefined {
  if (input.provider === undefined && input.model === undefined) {
    return undefined;
  }
  return {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
}

function buildSilentParallelOptions(): TaskExecutionParallelOptions {
  return { outputMode: 'silent' };
}

function buildRunTaskExecutionContext(
  input: RunNextTaskInput,
  gitProvider: GitProvider,
): RunTaskExecutionContext {
  return {
    gitProvider,
    ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
  };
}

function buildTaskFailureText(taskName: string, result: TaskCompletionResult): string {
  if (result.failureReason === undefined) {
    throw new Error(`Task failed without failure reason: ${taskName}`);
  }
  return `Task failed: ${taskName}\n${safeMcpErrorCause(result.failureReason)}`;
}

function buildTaskPostExecutionFailureText(taskName: string, result: TaskCompletionResult): string {
  if (result.postExecutionFailureReason === undefined) {
    throw new Error(`Task post-execution failed without failure reason: ${taskName}`);
  }
  return `Task post-execution failed: ${taskName}\n${safeMcpErrorCause(result.postExecutionFailureReason)}`;
}

function buildIssueSaveFailureText(issueNumber: number, error: unknown): string {
  return `Issue #${issueNumber} was created, but task saving failed: ${safeMcpErrorCause(error)}`;
}

function buildCompensatedIssueSaveFailureText(issueNumber: number, saveError: unknown): string {
  return `Issue #${issueNumber} was created and closed because task saving failed: ${safeMcpErrorCause(saveError)}`;
}

function buildUncompensatedIssueSaveFailureText(
  issueNumber: number,
  saveError: unknown,
  compensation: Extract<CloseIssueResult, { success: false }>,
): string {
  const compensationFailure = compensation.commentCreated === true
    ? `Issue compensation comment was created, but issue close failed: ${safeMcpErrorCause(compensation.error)}`
    : `Issue close failed: ${safeMcpErrorCause(compensation.error)}`;
  return [
    buildIssueSaveFailureText(issueNumber, saveError),
    '',
    compensationFailure,
  ].join('\n');
}

function buildCancelledIssueEnqueueFailureText(
  issueNumber: number,
  compensation: CloseIssueResult,
): string {
  if (compensation.success) {
    return `Issue #${issueNumber} was created and closed because task enqueue was cancelled`;
  }
  const compensationFailure = compensation.commentCreated === true
    ? `Issue compensation comment was created, but issue close failed: ${safeMcpErrorCause(compensation.error)}`
    : `Issue close failed: ${safeMcpErrorCause(compensation.error)}`;
  return [
    `Issue #${issueNumber} was created, but task enqueue was cancelled`,
    '',
    compensationFailure,
  ].join('\n');
}

function buildIssueEnqueueFailureResult(failure: IssueEnqueueFailure): CallToolResult {
  if (failure.stage === 'issue_creation') {
    return textResult(safeMcpErrorCause(failure.error), true);
  }
  if (failure.stage === 'cancelled_after_issue_creation') {
    return textResult(
      buildCancelledIssueEnqueueFailureText(failure.issueNumber, failure.compensation),
      true,
    );
  }
  if (!failure.compensation.success) {
    return textResult(
      buildUncompensatedIssueSaveFailureText(
        failure.issueNumber,
        failure.error,
        failure.compensation,
      ),
      true,
    );
  }
  return textResult(buildCompensatedIssueSaveFailureText(failure.issueNumber, failure.error), true);
}

export async function enqueueTaktTask(
  input: EnqueueTaskInput,
  deps: McpOperationDependencies = {},
): Promise<CallToolResult> {
  try {
    const saveTaskFile = deps.saveTaskFile ?? defaultSaveTaskFile;
    const workflow = resolveWorkflow(input.workflow);
    const created = await enqueueTask({
      cwd: input.cwd,
      task: input.task,
      workflow,
      worktree: input.worktree ?? true,
      autoPr: input.autoPr ?? false,
      taskContext: input.taskContext,
    }, saveTaskFile);
    return jsonResult(created);
  } catch (error) {
    return errorResult('Task saving failed', error);
  }
}

export async function createIssueAndEnqueueTaktTask(
  input: CreateIssueAndEnqueueTaskInput,
  deps: McpOperationDependencies = {},
): Promise<CallToolResult> {
  try {
    initGitProvider(input.cwd);
    const gitProvider = getGitProvider();
    const workflow = resolveWorkflow(input.workflow);
    const issueResult = await createIssueAndEnqueueTask({
      cwd: input.cwd,
      task: input.task,
      workflow,
      worktree: input.worktree ?? true,
      autoPr: input.autoPr ?? false,
      labels: input.labels,
      taskContext: input.taskContext,
      gitProvider,
    }, {
      saveTaskFile: deps.saveTaskFile ?? defaultSaveTaskFile,
      createIssueFromTaskResult: deps.createIssueFromTaskResult ?? defaultCreateIssueFromTaskResult,
      compensateCreatedIssue: deps.compensateCreatedIssue,
    });
    if (!issueResult.success) {
      return buildIssueEnqueueFailureResult(issueResult.failure);
    }
    return jsonResult(issueResult.created);
  } catch (error) {
    return errorResult('Issue task enqueue failed', error);
  }
}

export async function runNextTaktTask(
  input: RunNextTaskInput,
  deps: McpOperationDependencies = {},
): Promise<CallToolResult> {
  try {
    initGitProvider(input.cwd);
    const gitProvider = getGitProvider();
    const createTaskRunner = deps.createTaskRunner ?? ((cwd: string) => new TaskRunner(cwd));
    const executeRunTaskAndCompleteWithDetails = deps.executeRunTaskAndCompleteWithDetails
      ?? defaultExecuteRunTaskAndCompleteWithDetails;
    const taskRunner = createTaskRunner(input.cwd);
    taskRunner.failInterruptedRunningTasks();
    const tasks = taskRunner.claimNextTasks(1);
    const task = tasks[0];
    if (!task) {
      return jsonResult({
        ran: false,
        message: 'No pending tasks in .takt/tasks.yaml',
      });
    }

    const executionResult = await executeRunTaskAndCompleteWithDetails(
      task as TaskInfo,
      taskRunner,
      input.cwd,
      buildTaskExecutionOptions(input),
      buildSilentParallelOptions(),
      buildRunTaskExecutionContext(input, gitProvider),
    );
    if (!executionResult.success) {
      return textResult(buildTaskFailureText(task.name, executionResult), true);
    }
    if (executionResult.prFailed) {
      return textResult(buildTaskPostExecutionFailureText(task.name, executionResult), true);
    }

    return jsonResult({
      ran: true,
      taskName: task.name,
      success: executionResult.success,
    });
  } catch (error) {
    return errorResult('Task execution failed', error);
  }
}
