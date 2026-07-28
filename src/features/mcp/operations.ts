import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getGitProvider, initGitProvider } from '../../infra/git/index.js';
import {
  createIssueAndEnqueueTask,
  enqueueTask,
  type IssueEnqueueFailure,
} from '../../infra/task/enqueueService.js';
import type { TaskRecord, TaskStatus } from '../../infra/task/schema.js';
import { TaskStore } from '../../infra/task/store.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import {
  createIssueFromTaskResult as defaultCreateIssueFromTaskResult,
  saveTaskFile as defaultSaveTaskFile,
} from '../tasks/add/index.js';
import type { EnqueueTaskInput, ListTasksInput } from './schemas.js';

type SaveTaskFile = typeof defaultSaveTaskFile;
type CreateIssueFromTaskResult = typeof defaultCreateIssueFromTaskResult;

export interface McpOperationDependencies {
  saveTaskFile?: SaveTaskFile;
  createIssueFromTaskResult?: CreateIssueFromTaskResult;
  allowedProjectRoot?: string;
}

function textResult(text: string, isError?: boolean): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text }],
  };
}

function jsonResult(value: Record<string, unknown>, isError?: boolean): CallToolResult {
  return textResult(JSON.stringify(value), isError);
}

function errorResult(action: string, error: unknown): CallToolResult {
  return textResult(`${action}: ${safeExternalErrorMessage(error)}`, true);
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

type TaskSummary = { total: number } & Record<TaskStatus, number>;

function summarizeTasks(tasks: TaskRecord[]): TaskSummary {
  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    exceeded: 0,
    pr_failed: 0,
  } satisfies Record<TaskStatus, number>;

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  return { total: tasks.length, ...counts };
}

function projectTaskForMcp(task: TaskRecord): Record<string, unknown> {
  return {
    name: task.name,
    status: task.status,
    ...(task.workflow !== undefined ? { workflow: task.workflow } : {}),
    ...(task.branch !== undefined ? { branch: task.branch } : {}),
  };
}

function listTasksErrorResult(): CallToolResult {
  return errorResult('Task list failed', new Error('Unable to read task history'));
}

function issueFailureResult(failure: IssueEnqueueFailure): CallToolResult {
  if (failure.stage === 'issue_creation') {
    return jsonResult({
      issueCreated: false,
      taskEnqueued: false,
      stage: failure.stage,
      error: safeExternalErrorMessage(failure.error),
    }, true);
  }
  if (failure.stage === 'issue_number_parsing') {
    return jsonResult({
      issueCreated: true,
      ...(failure.issueUrl !== undefined ? { issueUrl: failure.issueUrl } : {}),
      taskEnqueued: false,
      stage: failure.stage,
      error: safeExternalErrorMessage(failure.error),
    }, true);
  }
  return jsonResult({
    issueCreated: true,
    issueNumber: failure.issueNumber,
    ...(failure.issueUrl !== undefined ? { issueUrl: failure.issueUrl } : {}),
    taskEnqueued: false,
    stage: failure.stage,
    error: safeExternalErrorMessage(failure.error),
  }, true);
}

export async function enqueueTaktTask(
  input: EnqueueTaskInput,
  deps: McpOperationDependencies = {},
  abortSignal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const saveTaskFile = deps.saveTaskFile ?? defaultSaveTaskFile;
    if (input.issue === undefined || 'number' in input.issue) {
      const created = await enqueueTask({
        cwd: input.cwd,
        task: input.task,
        workflow: input.workflow,
        worktree: input.worktree ?? true,
        autoPr: input.autoPr,
        taskContext: input.taskContext,
        abortSignal,
        ...(input.issue !== undefined ? { issueNumber: input.issue.number } : {}),
      }, saveTaskFile);
      return jsonResult(created);
    }

    initGitProvider(input.cwd);
    const result = await createIssueAndEnqueueTask({
      cwd: input.cwd,
      task: input.task,
      workflow: input.workflow,
      worktree: input.worktree ?? true,
      autoPr: input.autoPr,
      taskContext: input.taskContext,
      ...(input.issue.title !== undefined ? { explicitTitle: input.issue.title } : {}),
      ...(input.issue.labels !== undefined ? { labels: input.issue.labels } : {}),
      gitProvider: getGitProvider(),
      abortSignal,
      issueOutputMode: 'silent',
    }, {
      saveTaskFile,
      createIssueFromTaskResult: deps.createIssueFromTaskResult ?? defaultCreateIssueFromTaskResult,
    });
    return result.success ? jsonResult(result.created) : issueFailureResult(result.failure);
  } catch (error) {
    return errorResult('Task enqueue failed', error);
  }
}

export function listTaktTasks(
  input: ListTasksInput,
  deps: McpOperationDependencies = {},
): CallToolResult {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const state = new TaskStore(input.cwd).readOnly();
    return jsonResult({
      summary: summarizeTasks(state.tasks),
      tasks: state.tasks.map(projectTaskForMcp),
    });
  } catch {
    return listTasksErrorResult();
  }
}
