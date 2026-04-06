/**
 * Task schema definitions
 */

import { z } from 'zod/v4';
import { isValidTaskDir } from '../../shared/utils/taskPaths.js';
import { warnLegacyConfigKeyOncePerProcess } from '../config/legacy-workflow-key-deprecation.js';

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getPositiveIntField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function assertMatchingAliasValues(
  canonicalValue: string | undefined,
  aliasValue: string | undefined,
  message: string,
): void {
  if (canonicalValue !== undefined && aliasValue !== undefined && canonicalValue !== aliasValue) {
    throw new Error(message);
  }
}

function assertMatchingExceededMaxAlias(
  stepsValue: number | undefined,
  movementsValue: number | undefined,
): void {
  if (stepsValue !== undefined && movementsValue !== undefined && stepsValue !== movementsValue) {
    throw new Error(
      "Task configuration conflict: 'exceeded_max_steps' and 'exceeded_max_movements' must match when both are set.",
    );
  }
}

function resolveExceededMaxValue(record: Record<string, unknown>): number | undefined {
  const steps = getPositiveIntField(record, 'exceeded_max_steps');
  const movements = getPositiveIntField(record, 'exceeded_max_movements');
  assertMatchingExceededMaxAlias(steps, movements);
  return steps ?? movements;
}

function toTaskConfigRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

export function resolveTaskWorkflowValue(record: Record<string, unknown>): string | undefined {
  const piece = getStringField(record, 'piece');
  const workflow = getStringField(record, 'workflow');
  assertMatchingAliasValues(piece, workflow, "Task configuration conflict: 'workflow' and 'piece' must match when both are set.");
  return workflow ?? piece;
}

export function resolveTaskStartMovementValue(record: Record<string, unknown>): string | undefined {
  const startMovement = getStringField(record, 'start_movement');
  const startStep = getStringField(record, 'start_step');
  assertMatchingAliasValues(startMovement, startStep, "Task configuration conflict: 'start_step' and 'start_movement' must match when both are set.");
  return startStep ?? startMovement;
}

function normalizeAliasedTaskConfig(input: unknown): unknown {
  const record = toTaskConfigRecord(input);
  if (!record) {
    return input;
  }

  if ('piece' in record) {
    warnLegacyConfigKeyOncePerProcess('piece', 'workflow');
  }
  if ('start_movement' in record) {
    warnLegacyConfigKeyOncePerProcess('start_movement', 'start_step');
  }
  if ('exceeded_max_movements' in record) {
    warnLegacyConfigKeyOncePerProcess('exceeded_max_movements', 'exceeded_max_steps');
  }

  const workflow = resolveTaskWorkflowValue(record);
  const startMovement = resolveTaskStartMovementValue(record);
  const exceededMax = resolveExceededMaxValue(record);

  const hadExceededMovementsKey = Object.prototype.hasOwnProperty.call(record, 'exceeded_max_movements');
  const hadExceededStepsKey = Object.prototype.hasOwnProperty.call(record, 'exceeded_max_steps');

  const next: Record<string, unknown> = { ...record };
  delete next.exceeded_max_movements;
  delete next.exceeded_max_steps;
  if (exceededMax !== undefined) {
    next.exceeded_max_steps = exceededMax;
  } else if (hadExceededMovementsKey) {
    next.exceeded_max_movements = record.exceeded_max_movements;
  } else if (hadExceededStepsKey) {
    next.exceeded_max_steps = record.exceeded_max_steps;
  }
  if (workflow !== undefined) {
    next.piece = workflow;
  }
  if (startMovement !== undefined) {
    next.start_movement = startMovement;
  }

  return next;
}

function serializeTaskConfig(record: Record<string, unknown>): Record<string, unknown> {
  const serialized = { ...record };
  const piece = getStringField(serialized, 'piece') ?? getStringField(serialized, 'workflow');
  const startMovement = getStringField(serialized, 'start_movement') ?? getStringField(serialized, 'start_step');
  const exceededMax =
    getPositiveIntField(serialized, 'exceeded_max_steps') ?? getPositiveIntField(serialized, 'exceeded_max_movements');

  delete serialized.piece;
  delete serialized.workflow;
  delete serialized.start_movement;
  delete serialized.start_step;
  delete serialized.exceeded_max_movements;
  delete serialized.exceeded_max_steps;

  if (piece !== undefined) {
    serialized.workflow = piece;
  }
  if (startMovement !== undefined) {
    serialized.start_step = startMovement;
  }
  if (exceededMax !== undefined) {
    serialized.exceeded_max_steps = exceededMax;
  }

  return serialized;
}

/**
 * Per-task execution config schema.
 * Used by `takt add` input and in-memory TaskInfo.data.
 */
const TaskExecutionConfigObjectSchema = z.object({
  worktree: z.union([z.boolean(), z.string()]).optional(),
  branch: z.string().optional(),
  base_branch: z.string().optional(),
  piece: z.string().optional(),
  workflow: z.string().optional(),
  issue: z.number().int().positive().optional(),
  start_movement: z.string().optional(),
  start_step: z.string().optional(),
  retry_note: z.string().optional(),
  auto_pr: z.boolean().optional(),
  draft_pr: z.boolean().optional(),
  exceeded_max_movements: z.number().int().positive().optional(),
  exceeded_max_steps: z.number().int().positive().optional(),
  exceeded_current_iteration: z.number().int().min(0).optional(),
});

function stripTaskAliases<T extends Record<string, unknown>>(
  config: T,
): Omit<T, 'workflow' | 'start_step' | 'exceeded_max_movements'> {
  const canonical = { ...config };
  delete canonical.workflow;
  delete canonical.start_step;
  delete canonical.exceeded_max_movements;
  return canonical;
}

export const TaskExecutionConfigSchema = z.preprocess(
  normalizeAliasedTaskConfig,
  TaskExecutionConfigObjectSchema,
).transform(stripTaskAliases);

/**
 * Single task payload schema used by in-memory TaskInfo.data.
 */
export const TaskFileSchema = z.preprocess(
  normalizeAliasedTaskConfig,
  TaskExecutionConfigObjectSchema.extend({
    task: z.string().min(1),
  }),
).transform(stripTaskAliases);

export type TaskFileData = z.infer<typeof TaskFileSchema>;

export const TaskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskFailureSchema = z.object({
  movement: z.string().optional(),
  error: z.string().min(1),
  last_message: z.string().optional(),
});
export type TaskFailure = z.infer<typeof TaskFailureSchema>;

export const TaskRecordSchema = z.preprocess(
  normalizeAliasedTaskConfig,
  TaskExecutionConfigObjectSchema.extend({
    name: z.string().min(1),
    status: TaskStatusSchema,
    slug: z.string().optional(),
    summary: z.string().optional(),
    worktree_path: z.string().optional(),
    pr_url: z.string().optional(),
    content: z.string().min(1).optional(),
    content_file: z.string().min(1).optional(),
    task_dir: z.string().optional(),
    created_at: z.string().min(1),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    owner_pid: z.number().int().positive().nullable().optional(),
    failure: TaskFailureSchema.optional(),
  }),
).transform(stripTaskAliases).superRefine((value, ctx) => {
  const sourceFields = [value.content, value.content_file, value.task_dir].filter((field) => field !== undefined);
  if (sourceFields.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['content'],
      message: 'Either content, content_file, or task_dir is required.',
    });
  }
  if (sourceFields.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['content'],
      message: 'Exactly one of content, content_file, or task_dir must be set.',
    });
  }
  if (value.task_dir !== undefined && !isValidTaskDir(value.task_dir)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['task_dir'],
      message: 'task_dir must match .takt/tasks/<slug> format.',
    });
  }

  const hasFailure = value.failure !== undefined;
  const hasOwnerPid = typeof value.owner_pid === 'number';

  if (value.status === 'pending') {
    if (value.started_at !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['started_at'],
        message: 'Pending task must not have started_at.',
      });
    }
    if (value.completed_at !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed_at'],
        message: 'Pending task must not have completed_at.',
      });
    }
    if (hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Pending task must not have failure.',
      });
    }
    if (hasOwnerPid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner_pid'],
        message: 'Pending task must not have owner_pid.',
      });
    }
  }

  if (value.status === 'running') {
    if (value.started_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['started_at'],
        message: 'Running task requires started_at.',
      });
    }
    if (value.completed_at !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed_at'],
        message: 'Running task must not have completed_at.',
      });
    }
    if (hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Running task must not have failure.',
      });
    }
  }

  if (value.status === 'completed') {
    if (value.started_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['started_at'],
        message: 'Completed task requires started_at.',
      });
    }
    if (value.completed_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed_at'],
        message: 'Completed task requires completed_at.',
      });
    }
    if (hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Completed task must not have failure.',
      });
    }
    if (hasOwnerPid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner_pid'],
        message: 'Completed task must not have owner_pid.',
      });
    }
  }

  if (value.status === 'failed') {
    if (value.started_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['started_at'],
        message: 'Failed task requires started_at.',
      });
    }
    if (value.completed_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed_at'],
        message: 'Failed task requires completed_at.',
      });
    }
    if (!hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Failed task requires failure.',
      });
    }
    if (hasOwnerPid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner_pid'],
        message: 'Failed task must not have owner_pid.',
      });
    }
  }

  if (value.status === 'exceeded') {
    if (value.started_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['started_at'],
        message: 'Exceeded task requires started_at.',
      });
    }
    if (value.completed_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed_at'],
        message: 'Exceeded task requires completed_at.',
      });
    }
    if (hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Exceeded task must not have failure.',
      });
    }
    if (hasOwnerPid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner_pid'],
        message: 'Exceeded task must not have owner_pid.',
      });
    }
    const hasExceededMax = value.exceeded_max_steps !== undefined;
    const hasExceededIter = value.exceeded_current_iteration !== undefined;
    if (hasExceededMax !== hasExceededIter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exceeded_max_steps'],
        message: 'exceeded_max_steps and exceeded_current_iteration must both be set or both be absent.',
      });
    }
  }

  if (value.status === 'pr_failed') {
    if (value.started_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['started_at'],
        message: 'PR-failed task requires started_at.',
      });
    }
    if (value.completed_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completed_at'],
        message: 'PR-failed task requires completed_at.',
      });
    }
    if (hasOwnerPid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner_pid'],
        message: 'PR-failed task must not have owner_pid.',
      });
    }
  }
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TasksFileSchema = z.object({
  tasks: z.array(TaskRecordSchema),
});
export type TasksFileData = z.infer<typeof TasksFileSchema>;

export function serializeTaskRecord(record: TaskRecord): Record<string, unknown> {
  return serializeTaskConfig(record as Record<string, unknown>);
}

export function serializeTasksFileData(state: TasksFileData): { tasks: Record<string, unknown>[] } {
  return {
    tasks: state.tasks.map(serializeTaskRecord),
  };
}
