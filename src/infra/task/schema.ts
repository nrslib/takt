/**
 * Task schema definitions
 */

import { z } from 'zod/v4';
import { isValidTaskDir } from '../../shared/utils/taskPaths.js';

/**
 * Per-task execution config schema.
 * Used by `takt add` input and in-memory TaskInfo.data.
 */
export const TaskExecutionConfigSchema = z.object({
  worktree: z.union([z.boolean(), z.string()]).optional(),
  branch: z.string().optional(),
  piece: z.string().optional(),
  issue: z.number().int().positive().optional(),
  start_movement: z.string().optional(),
  retry_note: z.string().optional(),
  auto_pr: z.boolean().optional(),
});

/**
 * Single task payload schema used by in-memory TaskInfo.data.
 */
export const TaskFileSchema = TaskExecutionConfigSchema.extend({
  task: z.string().min(1),
});

export type TaskFileData = z.infer<typeof TaskFileSchema>;

export const TaskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskFailureSchema = z.object({
  movement: z.string().optional(),
  error: z.string().min(1),
  last_message: z.string().optional(),
});
export type TaskFailure = z.infer<typeof TaskFailureSchema>;

export const TaskRecordSchema = TaskExecutionConfigSchema.extend({
  name: z.string().min(1),
  status: TaskStatusSchema,
  content: z.string().min(1).optional(),
  content_file: z.string().min(1).optional(),
  task_dir: z.string().optional(),
  created_at: z.string().min(1),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  owner_pid: z.number().int().positive().nullable().optional(),
  failure: TaskFailureSchema.optional(),
}).superRefine((value, ctx) => {
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
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TasksFileSchema = z.object({
  tasks: z.array(TaskRecordSchema),
});
export type TasksFileData = z.infer<typeof TasksFileSchema>;
