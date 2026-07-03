import * as fs from 'node:fs';
import * as path from 'node:path';
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
  formatIssueEnqueueFailure,
  joinIssueEnqueueFailureText,
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
  allowedProjectRoot?: string;
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

function assertCwdAllowedByMcpRoot(cwd: string, allowedProjectRoot: string | undefined): void {
  if (allowedProjectRoot === undefined) {
    return;
  }

  const root = fs.realpathSync(allowedProjectRoot);
  const target = fs.realpathSync(cwd);
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`MCP cwd is outside the allowed project root: ${cwd}`);
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

function buildIssueEnqueueFailureResult(failure: IssueEnqueueFailure): CallToolResult {
  return textResult(joinIssueEnqueueFailureText(
    formatIssueEnqueueFailure(failure, safeMcpErrorCause),
    '\n\n',
  ), true);
}

export async function enqueueTaktTask(
  input: EnqueueTaskInput,
  deps: McpOperationDependencies = {},
): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
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
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
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
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
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
