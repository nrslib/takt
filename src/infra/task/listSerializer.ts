import type { TaskFileData, TaskFailure } from './schema.js';
import type { TaskListItem } from './types.js';

export interface JsonTaskData {
  task: string;
  worktree?: boolean | string;
  branch?: string;
  base_branch?: string;
  workflow?: string;
  issue?: number;
  start_step?: string;
  retry_note?: string;
  auto_pr?: boolean;
  draft_pr?: boolean;
  managed_pr?: boolean;
  should_publish_branch_to_origin?: boolean;
  exceeded_max_steps?: number;
  exceeded_current_iteration?: number;
}

export interface JsonTaskFailure {
  step?: string;
  error: string;
  last_message?: string;
}

export interface JsonTaskListItem {
  kind: TaskListItem['kind'];
  name: string;
  createdAt: string;
  filePath: string;
  content: string;
  summary?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  data?: JsonTaskData;
  failure?: JsonTaskFailure;
  startedAt?: string;
  completedAt?: string;
  ownerPid?: number;
  issueNumber?: number;
  exceededMaxSteps?: number;
  exceededCurrentIteration?: number;
}

function serializeTaskData(data: TaskFileData | undefined): JsonTaskData | undefined {
  if (!data) {
    return undefined;
  }

  return {
    task: data.task,
    worktree: data.worktree,
    branch: data.branch,
    base_branch: data.base_branch,
    workflow: data.workflow,
    issue: data.issue,
    start_step: data.start_step,
    retry_note: data.retry_note,
    auto_pr: data.auto_pr,
    draft_pr: data.draft_pr,
    managed_pr: data.managed_pr,
    should_publish_branch_to_origin: data.should_publish_branch_to_origin,
    exceeded_max_steps: data.exceeded_max_steps,
    exceeded_current_iteration: data.exceeded_current_iteration,
  };
}

function serializeTaskFailure(failure: TaskFailure | undefined): JsonTaskFailure | undefined {
  if (!failure) {
    return undefined;
  }

  return {
    step: failure.step,
    error: failure.error,
    last_message: failure.last_message,
  };
}

export function serializeTaskListItemForJson(task: TaskListItem): JsonTaskListItem {
  return {
    kind: task.kind,
    name: task.name,
    createdAt: task.createdAt,
    filePath: task.filePath,
    content: task.content,
    summary: task.summary,
    branch: task.branch,
    worktreePath: task.worktreePath,
    prUrl: task.prUrl,
    data: serializeTaskData(task.data),
    failure: serializeTaskFailure(task.failure),
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    ownerPid: task.ownerPid,
    issueNumber: task.issueNumber,
    exceededMaxSteps: task.exceededMaxSteps,
    exceededCurrentIteration: task.exceededCurrentIteration,
  };
}
