import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskFileSchema, type TaskFileData, type TaskRecord } from './schema.js';
import type { TaskInfo, TaskListItem } from './types.js';

function firstLine(content: string): string {
  return content.trim().split('\n')[0]?.slice(0, 80) ?? '';
}

export function resolveTaskContent(projectDir: string, task: TaskRecord): string {
  if (task.content) {
    return task.content;
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
    content,
    createdAt: task.created_at,
    status: task.status,
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
    name: task.name,
    createdAt: task.created_at,
    filePath: tasksFile,
    content: firstLine(resolveTaskContent(projectDir, task)),
    data: toTaskData(projectDir, task),
  };
}

export function toFailedTaskItem(projectDir: string, tasksFile: string, task: TaskRecord): TaskListItem {
  return {
    kind: 'failed',
    name: task.name,
    createdAt: task.completed_at ?? task.created_at,
    filePath: tasksFile,
    content: firstLine(resolveTaskContent(projectDir, task)),
    data: toTaskData(projectDir, task),
    failure: task.failure,
  };
}
