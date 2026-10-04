import type { WorkflowResumePoint } from '../../../core/models/index.js';
import { warn } from '../../../shared/ui/index.js';
import type { ExecuteTaskOptions } from './types.js';

export function warnIfResumePointAdjusted(input: {
  readonly context: 'task_reexecution' | 'direct_resume';
  readonly outputMode: ExecuteTaskOptions['outputMode'];
  readonly workflow: string;
  readonly original: WorkflowResumePoint | undefined;
  readonly accepted: WorkflowResumePoint | undefined;
  readonly startStep: string | undefined;
}): void {
  if (
    input.outputMode === 'silent'
    || input.original === undefined
    || input.accepted?.stack.length === input.original.stack.length
  ) {
    return;
  }

  const acceptedStack = input.accepted === undefined ? [] : input.accepted.stack;
  warn(
    'Workflow resume point was adjusted for the current workflow: '
    + `context=${JSON.stringify(input.context)}, workflow=${JSON.stringify(input.workflow)}, `
    + `originalStack=${JSON.stringify(input.original.stack)}, `
    + `acceptedStack=${JSON.stringify(acceptedStack)}, `
    + `startStep=${JSON.stringify(input.startStep ?? null)}`,
  );
}
