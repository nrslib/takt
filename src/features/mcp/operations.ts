import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GoalStore } from '../../infra/goals/store.js';
import { readRunMetaBySlug } from '../../core/workflow/run/run-meta.js';
import { getGitProvider, initGitProvider } from '../../infra/git/index.js';
import { TaskRunner } from '../../infra/task/index.js';
import { loadRunSessionPage } from '../interactive/runSessionReader.js';
import { jsonResult, textResult, pagedResult, MCP_TEXT_PAGE_BYTES } from './response.js';
import { goalSummary, goalValuePage, selectGoalValue } from './goalResponse.js';
export { jsonResult } from './response.js';
import {
  issueTellableRunningTask,
  type TellableRunningTask,
} from '../tasks/liveIntervention.js';
import { assertTaskStateWorktreeOwnership } from '../tasks/taskStateWorktreeOwnership.js';
import {
  createIssueAndEnqueueTask,
  enqueueTask,
  type IssueEnqueueFailure,
} from '../../infra/task/enqueueService.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { formatTaskStateReferenceMarker } from '../../shared/task-state-reference.js';
import {
  createIssueFromTaskResult as defaultCreateIssueFromTaskResult,
  saveTaskFile as defaultSaveTaskFile,
} from '../tasks/add/index.js';
import type {
  GetGoalInput,
  ListGoalsInput,
  EnqueueTaskInput,
  GetRunInput,
  ListTasksInput,
  TellRunInput,
} from './schemas.js';

type SaveTaskFile = typeof defaultSaveTaskFile;
type CreateIssueFromTaskResult = typeof defaultCreateIssueFromTaskResult;

export interface McpOperationDependencies {
  readOnly?: boolean;
  saveTaskFile?: SaveTaskFile;
  createIssueFromTaskResult?: CreateIssueFromTaskResult;
  allowedProjectRoot?: string;
  /** Only the interactive read-only server emits internal conversation metadata. */
  includeReferenceMarkers?: boolean;
}

export function errorResult(action: string, error: unknown): CallToolResult {
  return textResult(`${action}: ${safeExternalErrorMessage(error)}`, true);
}

export async function listTaktGoals(input: ListGoalsInput, deps: McpOperationDependencies): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    let totalCount = 0;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    const { goals, errors } = await new GoalStore(input.cwd).list((goal) => {
      const index = totalCount++;
      return index >= offset && index < offset + limit ? goalSummary(goal) : undefined;
    });
    const errorOffset = input.errorOffset ?? 0;
    const selectedErrors = errors.slice(errorOffset, errorOffset + limit)
      .map(({ goalId, error }) => ({ goalId, error: safeExternalErrorMessage(error) }));
    return pagedResult('goals', goals, totalCount, offset, errors.length > 0, {
      ...(errors.length > 0 ? {
        errors: selectedErrors,
        errorPage: {
          collection: 'errors',
          totalCount: errors.length,
          returnedCount: selectedErrors.length,
          omittedCount: errors.length - selectedErrors.length,
          offset: errorOffset,
          nextOffset: errorOffset + selectedErrors.length < errors.length ? errorOffset + selectedErrors.length : null,
          truncated: selectedErrors.length < errors.length,
          retrieval: 'Pass errorPage.nextOffset as errorOffset to read more errors.',
        },
      } : {}),
    });
  } catch (error) {
    return errorResult('Goal list failed', error);
  }
}

export async function getTaktGoal(input: GetGoalInput, deps: McpOperationDependencies): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const goal = await new GoalStore(input.cwd).get(input.goalId);
    if (input.path !== undefined) {
      const value = selectGoalValue(goal, input.path, input.recordId);
      if (Array.isArray(value)) return pagedResult('items', value.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50)), value.length, input.offset ?? 0, undefined, { goalId: goal.id, path: input.path });
      return jsonResult({ goalId: goal.id, path: input.path, ...goalValuePage(value, input) });
    }
    return jsonResult({ goal: goalSummary(goal) });
  } catch (error) {
    return errorResult('Goal read failed', error);
  }
}

function findRunReadCwd(cwd: string, runSlug: string): string {
  const task = new TaskRunner(cwd)
    .listTaskStateItems()
    .find((candidate) => candidate.runSlug === runSlug);
  if (task?.worktreePath === undefined) {
    return cwd;
  }
  assertTaskStateWorktreeOwnership(cwd, task);
  return task.worktreePath;
}

function taskSummary(cwd: string, task: ReturnType<TaskRunner['listTaskStateItems']>[number]): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    name: task.name,
    ...(task.goalId === undefined ? {} : { goalId: task.goalId }),
    ...(task.summary === undefined ? {} : { summary: task.summary }),
    status: task.status,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.workflow === undefined ? {} : { workflow: task.workflow }),
  };
  if (task.runSlug !== undefined) {
    summary.runSlug = task.runSlug;
    try {
      let runCwd = cwd;
      if (task.worktreePath !== undefined) {
        assertTaskStateWorktreeOwnership(cwd, task);
        runCwd = task.worktreePath;
      }
      let warning: string | undefined;
      const meta = readRunMetaBySlug(runCwd, task.runSlug, (message) => { warning = message; });
      if (warning !== undefined) {
        throw new Error(warning);
      }
      if (meta === null) {
        throw new Error('Run metadata is unavailable');
      }
      if (meta.workflow !== undefined && summary.workflow === undefined) {
        summary.workflow = meta.workflow;
      }
      if (meta.currentStep !== undefined) {
        summary.currentStep = meta.currentStep;
      }
    } catch (error) {
      summary.error = safeExternalErrorMessage(error);
    }
  }
  return summary;
}

export function listTaktTasks(
  input: ListTasksInput,
  deps: McpOperationDependencies = {},
): CallToolResult {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const tasks = new TaskRunner(input.cwd).listTaskStateItems();
    const offset = input.offset ?? 0;
    const selected = tasks.slice(offset, offset + (input.limit ?? 50)).map((task) => taskSummary(input.cwd, task));
    return pagedResult('tasks', selected, tasks.length, offset);
  } catch (error) {
    return errorResult('Task list failed', error);
  }
}

export function getTaktRun(
  input: GetRunInput,
  deps: McpOperationDependencies = {},
): CallToolResult {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const runCwd = findRunReadCwd(input.cwd, input.runSlug);
    const context = loadRunSessionPage(runCwd, input.runSlug, { ...input, maxBytes: input.maxBytes ?? MCP_TEXT_PAGE_BYTES, liveInterventionProjectCwd: input.cwd });
    return jsonResult({ runSlug: input.runSlug, ...context }, undefined,
      deps.includeReferenceMarkers ? `\n${formatTaskStateReferenceMarker(input.runSlug)}` : '');
  } catch (error) {
    return errorResult('Run read failed', error);
  }
}

function tellTargetSummary(target: TellableRunningTask): Record<string, unknown> {
  return {
    name: target.task.name,
    ...(target.task.summary === undefined ? {} : { summary: target.task.summary }),
    workflow: target.meta.workflow,
    currentStep: target.meta.currentStep,
    runSlug: target.runSlug,
  };
}

export async function tellTaktRun(
  input: TellRunInput,
  deps: McpOperationDependencies = {},
): Promise<CallToolResult> {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const result = await issueTellableRunningTask(input.cwd, input.runSlug, input.content);
    return jsonResult({
      runSlug: result.target.runSlug,
      instructionId: result.instructionId,
      target: tellTargetSummary(result.target),
    });
  } catch (error) {
    return errorResult('Run tell failed', error);
  }
}

export function assertCwdAllowedByMcpRoot(cwd: string, allowedProjectRoot: string | undefined): void {
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
    const savedSettings = {
      worktree: input.worktree ?? true,
      autoPr: input.autoPr,
      ...(input.draftPr !== undefined ? { draftPr: input.draftPr } : {}),
    };
    const resultSettings = { ...savedSettings, draftPr: savedSettings.draftPr ?? null };
    const enqueueInput = {
      cwd: input.cwd,
      task: input.task,
      workflow: input.workflow,
      ...savedSettings,
      taskContext: input.taskContext,
      abortSignal,
    };
    if (input.issue === undefined || 'number' in input.issue) {
      const created = await enqueueTask({
        ...enqueueInput,
        ...(input.issue !== undefined ? { issueNumber: input.issue.number } : {}),
      }, saveTaskFile);
      return jsonResult({ ...created, ...resultSettings });
    }

    initGitProvider(input.cwd);
    const result = await createIssueAndEnqueueTask({
      ...enqueueInput,
      ...(input.issue.title !== undefined ? { explicitTitle: input.issue.title } : {}),
      ...(input.issue.labels !== undefined ? { labels: input.issue.labels } : {}),
      gitProvider: getGitProvider(),
      issueOutputMode: 'silent',
    }, {
      saveTaskFile,
      createIssueFromTaskResult: deps.createIssueFromTaskResult ?? defaultCreateIssueFromTaskResult,
    });
    return result.success
      ? jsonResult({ ...result.created, ...resultSettings })
      : issueFailureResult(result.failure);
  } catch (error) {
    return errorResult('Task enqueue failed', error);
  }
}
