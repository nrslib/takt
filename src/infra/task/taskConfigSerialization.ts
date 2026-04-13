import { z } from 'zod/v4';

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getPositiveIntField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolveExceededMaxValue(record: Record<string, unknown>): number | undefined {
  return getPositiveIntField(record, 'exceeded_max_steps');
}

function resolveResumePointValue(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = record.resume_point;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return { ...value } as Record<string, unknown>;
}

function toTaskConfigRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

export function resolveTaskWorkflowValue(record: Record<string, unknown>): string | undefined {
  return getStringField(record, 'workflow');
}

export function resolveTaskStartStepValue(record: Record<string, unknown>): string | undefined {
  return getStringField(record, 'start_step');
}

export function normalizeTaskConfig(input: unknown): unknown {
  const record = toTaskConfigRecord(input);
  if (!record) {
    return input;
  }

  const workflow = resolveTaskWorkflowValue(record);
  const startStep = resolveTaskStartStepValue(record);
  const exceededMax = resolveExceededMaxValue(record);
  const resumePoint = resolveResumePointValue(record);

  const next: Record<string, unknown> = { ...record };
  if (exceededMax !== undefined) {
    next.exceeded_max_steps = exceededMax;
  }
  if (workflow !== undefined) {
    next.workflow = workflow;
  }
  if (startStep !== undefined) {
    next.start_step = startStep;
  }
  if (resumePoint !== undefined) {
    next.resume_point = resumePoint;
  }

  return next;
}

export function serializeTaskConfig(record: Record<string, unknown>): Record<string, unknown> {
  const serialized = { ...record };
  const workflow = getStringField(serialized, 'workflow');
  const startStep = getStringField(serialized, 'start_step');
  const exceededMax = getPositiveIntField(serialized, 'exceeded_max_steps');
  const resumePoint = resolveResumePointValue(serialized);

  delete serialized.workflow;
  delete serialized.start_step;
  delete serialized.exceeded_max_steps;
  delete serialized.resume_point;

  if (workflow !== undefined) {
    serialized.workflow = workflow;
  }
  if (startStep !== undefined) {
    serialized.start_step = startStep;
  }
  if (exceededMax !== undefined) {
    serialized.exceeded_max_steps = exceededMax;
  }
  if (resumePoint !== undefined) {
    serialized.resume_point = resumePoint;
  }

  return serialized;
}

export function buildTaskSchema<T extends z.ZodType>(schema: T): z.ZodPipe<z.ZodTransform<unknown, unknown>, T> {
  return z.preprocess(normalizeTaskConfig, schema);
}
