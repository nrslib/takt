import * as path from 'node:path';
import type { WorkflowResumePoint } from '../../core/models/index.js';
import { nowIso } from './naming.js';
import type { TaskRecord, TaskStatus } from './schema.js';

export interface ResolvedTaskRetryMetadata {
  startStep?: string;
  resumePoint?: WorkflowResumePoint;
  currentIteration?: number;
  preserveExisting?: boolean;
}

type TerminalTaskUpdates = Omit<
  Partial<TaskRecord>,
  'start_step' | 'resume_point' | 'exceeded_current_iteration' | 'exceeded_max_steps'
>;

type ClearedRetryTaskRecord = Omit<
  TaskRecord,
  'start_step' | 'resume_point' | 'exceeded_current_iteration' | 'exceeded_max_steps'
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

export function buildRecoveredTaskRecordWithRetryMetadata(
  task: TaskRecord,
  retryMetadata: ResolvedTaskRetryMetadata,
): TaskRecord {
  const nextTask = retryMetadata.preserveExisting ? { ...task } : clearRetryMetadata(task);
  return {
    ...nextTask,
    status: 'pending',
    started_at: null,
    completed_at: null,
    owner_pid: null,
    run_slug: undefined,
    ...(retryMetadata.startStep ? { start_step: retryMetadata.startStep } : {}),
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

export function buildRetryTaskRecord(
  task: TaskRecord,
  status: Extract<TaskStatus, 'pending' | 'running'>,
  startStep: string | undefined,
  retryNote: string | undefined,
  resumePoint: WorkflowResumePoint | undefined,
): TaskRecord {
  return {
    ...task,
    status,
    started_at: status === 'running' ? nowIso() : null,
    completed_at: null,
    owner_pid: status === 'running' ? process.pid : null,
    run_slug: undefined,
    failure: undefined,
    start_step: startStep,
    retry_note: retryNote,
    resume_point: resumePoint,
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
  const rest = { ...task };
  delete rest.start_step;
  delete rest.resume_point;
  delete rest.exceeded_current_iteration;
  delete rest.exceeded_max_steps;
  return rest;
}
