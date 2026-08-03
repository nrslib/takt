import * as path from 'node:path';
import type { WorkflowRestartPoint, WorkflowResumePoint } from '../../core/models/index.js';
import type { RunResumeSource } from '../../core/workflow/run/run-meta.js';
import { nowIso } from './naming.js';
import type { TaskRecord, TaskStatus } from './schema.js';
import { TASK_RESTART_POINT_KEY } from './taskExecutionSchemas.js';

export interface ResolvedTaskRetryMetadata {
  startStep?: string;
  resumePoint?: WorkflowResumePoint;
  currentIteration?: number;
  preserveExisting?: boolean;
}

export interface ExceededTaskRecordUpdates {
  currentStep: string;
  newMaxSteps: number;
  currentIteration: number;
  resumePoint?: WorkflowResumePoint;
  worktreePath?: string;
  branch?: string;
}

type TerminalTaskUpdates = Omit<
  Partial<TaskRecord>,
  'start_step' | 'resume_point' | typeof TASK_RESTART_POINT_KEY | 'exceeded_current_iteration' | 'exceeded_max_steps'
>;

type ClearedRetryTaskRecord = Omit<
  TaskRecord,
  'start_step' | 'resume_point' | typeof TASK_RESTART_POINT_KEY | 'exceeded_current_iteration' | 'exceeded_max_steps'
>;

export function buildClaimedTaskRecord(task: TaskRecord): TaskRecord {
  return {
    ...task,
    status: 'running',
    started_at: nowIso(),
    owner_pid: process.pid,
    run_slug: undefined,
  };
}

export function buildTerminalTaskRecord(
  task: TaskRecord,
  updates: TerminalTaskUpdates,
  retryMetadata?: ResolvedTaskRetryMetadata,
): TaskRecord {
  const nextTask = retryMetadata?.preserveExisting ? { ...task } : clearRetryMetadata(task);
  const nextRetryMetadata = retryMetadata?.preserveExisting ? undefined : retryMetadata;

  return {
    ...nextTask,
    ...updates,
    ...(nextRetryMetadata?.startStep ? { start_step: nextRetryMetadata.startStep } : {}),
    ...(nextRetryMetadata?.resumePoint ? { resume_point: nextRetryMetadata.resumePoint } : {}),
    ...(nextRetryMetadata?.currentIteration !== undefined
      ? { exceeded_current_iteration: nextRetryMetadata.currentIteration }
      : {}),
  };
}

export function buildExceededTaskRecord(
  task: TaskRecord,
  updates: ExceededTaskRecordUpdates,
): TaskRecord {
  return {
    ...clearRetryMetadata(task),
    status: 'exceeded',
    completed_at: nowIso(),
    owner_pid: null,
    failure: undefined,
    start_step: updates.currentStep,
    exceeded_max_steps: updates.newMaxSteps,
    exceeded_current_iteration: updates.currentIteration,
    ...(updates.resumePoint === undefined ? {} : { resume_point: updates.resumePoint }),
    ...(updates.worktreePath ? { worktree_path: updates.worktreePath } : {}),
    ...(updates.branch ? { branch: updates.branch } : {}),
  };
}

export function buildRetryTaskRecord(
  task: TaskRecord,
  status: Extract<TaskStatus, 'pending' | 'running'>,
  startStep: string | undefined,
  retryNote: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
  workflow: string | undefined,
  taskDir: string | undefined,
  resumeSource: RunResumeSource,
  restartPoint?: WorkflowRestartPoint,
): TaskRecord {
  if (resumePoint !== undefined && restartPoint !== undefined) {
    throw new Error('Retry task cannot own both resume_point and restart_point');
  }
  if (startStep !== undefined && restartPoint !== undefined) {
    throw new Error('Retry task cannot own both start_step and restart_point');
  }
  const taskWithoutSourceRunSlug = resumePoint === undefined
    ? clearRetryMetadata(task)
    : { ...task, [TASK_RESTART_POINT_KEY]: undefined };
  delete taskWithoutSourceRunSlug.source_run_slug;
  const taskSpecSource = taskDir
    ? { content: undefined, content_file: undefined, task_dir: taskDir }
    : {};

  return {
    ...taskWithoutSourceRunSlug,
    ...(workflow ? { workflow } : {}),
    ...taskSpecSource,
    status,
    started_at: status === 'running' ? nowIso() : null,
    completed_at: null,
    owner_pid: status === 'running' ? process.pid : null,
    run_slug: undefined,
    ...(resumeSource.sourceRunSlug ? { source_run_slug: resumeSource.sourceRunSlug } : {}),
    resume_mode: resumeSource.resumeMode,
    failure: undefined,
    start_step: startStep,
    retry_note: retryNote,
    resume_point: resumePoint,
    ...(restartPoint === undefined ? {} : { [TASK_RESTART_POINT_KEY]: restartPoint }),
  };
}

export function normalizeTaskRef(taskRef: string): string {
  if (!taskRef.includes(path.sep)) {
    return taskRef;
  }

  const base = path.basename(taskRef);
  if (base.includes('_')) {
    return base.slice(base.indexOf('_') + 1);
  }

  return base;
}

export function generateTaskName(slug: string, existingNames: string[]): string {
  const base = slug || `task-${Date.now()}`;
  let candidate = base;
  let counter = 1;
  while (existingNames.includes(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function clearRetryMetadata(task: TaskRecord): ClearedRetryTaskRecord {
  const retryMetadataKeys = new Set<string>([
    'start_step',
    'resume_point',
    TASK_RESTART_POINT_KEY,
    'exceeded_current_iteration',
    'exceeded_max_steps',
  ]);
  return Object.fromEntries(
    Object.entries(task).filter(([key]) => !retryMetadataKeys.has(key)),
  ) as ClearedRetryTaskRecord;
}
