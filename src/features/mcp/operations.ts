import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { TaskRunner, type TaskInfo } from '../../infra/task/index.js';
import { getGitProvider, initGitProvider, type CloseIssueResult } from '../../infra/git/index.js';
import {
  createIssueFromTaskResult as defaultCreateIssueFromTaskResult,
  saveTaskFile as defaultSaveTaskFile,
} from '../tasks/add/index.js';
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
type CompensateCreatedIssue = (input: {
  cwd: string;
  issueNumber: number;
}) => CloseIssueResult;

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

const POSIX_ABSOLUTE_PATH_PATTERN = /(?<![\w:])\/[^\s'"`<>|]*/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /[A-Za-z]:\\[^\s'"`<>|]*/g;

function sanitizeMcpText(text: string): string {
  return text
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, '[path]')
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, '[path]');
}

function safeMcpErrorCause(error: unknown): string {
  const message = getErrorMessage(error);
  if (/EACCES|EPERM|permission denied/i.test(message)) {
    return 'permission denied';
  }
  if (/ENOENT|no such file or directory/i.test(message)) {
    return 'not found';
  }
  return sanitizeMcpText(message);
}

function errorResult(action: string, error: unknown): CallToolResult {
  return textResult(`${action}: ${safeMcpErrorCause(error)}`, true);
}

function resolveWorkflow(workflow: string | undefined): string {
  return workflow ?? DEFAULT_WORKFLOW_NAME;
}

function buildSaveTaskOptions(input: EnqueueTaskInput, issueNumber?: number): Parameters<SaveTaskFile>[2] {
  return {
    workflow: resolveWorkflow(input.workflow),
    worktree: input.worktree ?? true,
    autoPr: input.autoPr ?? false,
    ...(issueNumber !== undefined ? { issue: issueNumber } : {}),
    ...(input.taskContext?.branch !== undefined ? { branch: input.taskContext.branch } : {}),
    ...(input.taskContext?.baseBranch !== undefined ? { baseBranch: input.taskContext.baseBranch } : {}),
    ...(input.taskContext?.prNumber !== undefined ? { prNumber: input.taskContext.prNumber } : {}),
  };
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

function buildRunTaskExecutionContext(input: RunNextTaskInput): RunTaskExecutionContext | undefined {
  return input.taskContext === undefined ? undefined : { taskContext: input.taskContext };
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

function buildIssueCompensationComment(): string {
  return [
    'TAKT MCP created this issue, but saving the pending task failed.',
    '',
    'The issue is being closed to keep the repository state consistent.',
  ].join('\n');
}

function compensateCreatedIssue(input: {
  cwd: string;
  issueNumber: number;
}): CloseIssueResult {
  return getGitProvider().closeIssue(
    input.issueNumber,
    buildIssueCompensationComment(),
    input.cwd,
  );
}

function buildCompensatedIssueSaveFailureText(issueNumber: number, saveError: unknown): string {
  return `Issue #${issueNumber} was created and closed because task saving failed: ${safeMcpErrorCause(saveError)}`;
}

function buildUncompensatedIssueSaveFailureText(
  issueNumber: number,
  saveError: unknown,
  compensationError: string | undefined,
): string {
  if (compensationError === undefined) {
    throw new Error(`Issue compensation failed without an error message: #${issueNumber}`);
  }
  return [
    buildIssueSaveFailureText(issueNumber, saveError),
    '',
    `Issue close failed: ${safeMcpErrorCause(compensationError)}`,
  ].join('\n');
}

export async function enqueueTaktTask(
  input: EnqueueTaskInput,
  deps: McpOperationDependencies = {},
): Promise<CallToolResult> {
  try {
    const saveTaskFile = deps.saveTaskFile ?? defaultSaveTaskFile;
    const workflow = resolveWorkflow(input.workflow);
    const created = await saveTaskFile(input.cwd, input.task, buildSaveTaskOptions(input));
    return jsonResult({
      ...created,
      workflow,
    });
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
    const createIssueFromTaskResult = deps.createIssueFromTaskResult ?? defaultCreateIssueFromTaskResult;
    const issueResult = createIssueFromTaskResult(input.task, {
      cwd: input.cwd,
      labels: input.labels,
      outputMode: 'silent',
    });
    if (!issueResult.success) {
      return textResult(safeMcpErrorCause(issueResult.error), true);
    }

    const saveTaskFile = deps.saveTaskFile ?? defaultSaveTaskFile;
    const workflow = resolveWorkflow(input.workflow);
    let created: Awaited<ReturnType<SaveTaskFile>>;
    try {
      created = await saveTaskFile(
        input.cwd,
        input.task,
        buildSaveTaskOptions(input, issueResult.issueNumber),
      );
    } catch (saveError) {
      const compensate = deps.compensateCreatedIssue ?? compensateCreatedIssue;
      const compensationResult = compensate({
        cwd: input.cwd,
        issueNumber: issueResult.issueNumber,
      });
      if (!compensationResult.success) {
        return textResult(
          buildUncompensatedIssueSaveFailureText(issueResult.issueNumber, saveError, compensationResult.error),
          true,
        );
      }
      return textResult(buildCompensatedIssueSaveFailureText(issueResult.issueNumber, saveError), true);
    }
    return jsonResult({
      ...created,
      workflow,
      issueNumber: issueResult.issueNumber,
    });
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
      buildRunTaskExecutionContext(input),
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
