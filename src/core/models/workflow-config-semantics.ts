import type { WorkflowMaxSteps } from './workflow-types.js';

export const CALLABLE_WORKFLOW_MAX_STEPS_ERROR = 'Callable subworkflow cannot define max_steps';

export function validateCallableWorkflowMaxSteps(input: {
  readonly callable: boolean;
  readonly maxSteps: WorkflowMaxSteps | undefined;
}): void {
  if (input.callable && input.maxSteps !== undefined) {
    throw new Error(CALLABLE_WORKFLOW_MAX_STEPS_ERROR);
  }
}
