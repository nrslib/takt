import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskFileSchema, type TaskFileData, type TaskRecord } from './schema.js';
import { firstLine } from './naming.js';
import type { TaskInfo, TaskListItem } from './types.js';

function toDisplayPath(projectDir: string, targetPath: string): string {
  const relativePath = path.relative(projectDir, targetPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return targetPath;
  }
  return relativePath;
}

function buildTaskDirInstruction(projectDir: string, taskDirPath: string, orderFilePath: string): string {
  const displayTaskDir = toDisplayPath(projectDir, taskDirPath);
  const displayOrderFile = toDisplayPath(projectDir, orderFilePath);
  return [
    `Implement using only the files in \`${displayTaskDir}\`.`,
    `Primary spec: \`${displayOrderFile}\`.`,
    'Use report files in Report Directory as primary execution history.',
    'Do not rely on previous response or conversation summary.',
  ].join('\n');
}

export function resolveTaskContent(projectDir: string, task: TaskRecord): string {
  if (task.content) {
    return task.content;
  }
  if (task.task_dir) {
    const taskDirPath = path.join(projectDir, task.task_dir);
    const orderFilePath = path.join(taskDirPath, 'order.md');
    if (!fs.existsSync(orderFilePath)) {
      throw new Error(`Task spec file is missing: ${orderFilePath}`);
    }
    return buildTaskDirInstruction(projectDir, taskDirPath, orderFilePath);
  }
  if (!task.content_file) {
    throw new Error(`Task content is missing: ${task.name}`);
  }

  const contentPath = path.isAbsolute(task.content_file)
    ? task.content_file
    : path.join(projectDir, task.content_file);
  return fs.readFileSync(contentPath, 'utf-8');
}

export function toTaskData(projectDir: string, task: TaskRecord): TaskFileData {
  return TaskFileSchema.parse({
    task: resolveTaskContent(projectDir, task),
    worktree: task.worktree,
    branch: task.branch,
    piece: task.piece,
    issue: task.issue,
    start_movement: task.start_movement,
    retry_note: task.retry_note,
    auto_pr: task.auto_pr,
  });
}

export function toTaskInfo(projectDir: string, tasksFile: string, task: TaskRecord): TaskInfo {
  const content = resolveTaskContent(projectDir, task);
  return {
    filePath: tasksFile,
    name: task.name,
    slug: task.slug,
    content,
    taskDir: task.task_dir,
    createdAt: task.created_at,
    status: task.status,
    worktreePath: task.worktree_path,
    data: TaskFileSchema.parse({
      task: content,
      worktree: task.worktree,
      branch: task.branch,
      piece: task.piece,
      issue: task.issue,
      start_movement: task.start_movement,
      retry_note: task.retry_note,
      auto_pr: task.auto_pr,
    }),
  };
}

export function toPendingTaskItem(projectDir: string, tasksFile: string, task: TaskRecord): TaskListItem {
  return {
    kind: 'pending',
    ...toBaseTaskListItem(projectDir, tasksFile, task),
  };
}

export function toFailedTaskItem(projectDir: string, tasksFile: string, task: TaskRecord): TaskListItem {
  return {
    kind: 'failed',
    ...toBaseTaskListItem(projectDir, tasksFile, task),
    failure: task.failure,
  };
}

function toRunningTaskItem(projectDir: string, tasksFile: string, task: TaskRecord): TaskListItem {
  return {
    kind: 'running',
    ...toBaseTaskListItem(projectDir, tasksFile, task),
  };
}

function toCompletedTaskItem(projectDir: string, tasksFile: string, task: TaskRecord): TaskListItem {
  return {
    kind: 'completed',
    ...toBaseTaskListItem(projectDir, tasksFile, task),
  };
}

function toBaseTaskListItem(projectDir: string, tasksFile: string, task: TaskRecord): Omit<TaskListItem, 'kind' | 'failure'> {
  return {
    name: task.name,
    createdAt: task.created_at,
    filePath: tasksFile,
    content: firstLine(resolveTaskContent(projectDir, task)),
    summary: task.summary,
    branch: task.branch,
    worktreePath: task.worktree_path,
    startedAt: task.started_at ?? undefined,
    completedAt: task.completed_at ?? undefined,
    ownerPid: task.owner_pid ?? undefined,
    data: toTaskData(projectDir, task),
  };
}

export function toTaskListItem(projectDir: string, tasksFile: string, task: TaskRecord): TaskListItem {
  switch (task.status) {
    case 'pending':
      return toPendingTaskItem(projectDir, tasksFile, task);
    case 'running':
      return toRunningTaskItem(projectDir, tasksFile, task);
    case 'completed':
      return toCompletedTaskItem(projectDir, tasksFile, task);
    case 'failed':
      return toFailedTaskItem(projectDir, tasksFile, task);
  }
}
