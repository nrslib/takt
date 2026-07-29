import type { WorkflowConfig, WorkflowStep } from '../models/types.js';

export function findWorkflowStepLocation(
  config: WorkflowConfig,
  target: WorkflowStep,
): readonly PropertyKey[] | undefined {
  return findStepLocation(config.steps, target, ['steps']);
}

function findStepLocation(
  steps: readonly WorkflowStep[],
  target: WorkflowStep,
  parentPath: readonly PropertyKey[],
): readonly PropertyKey[] | undefined {
  for (const [index, step] of steps.entries()) {
    const path = [...parentPath, index];
    if (step === target) {
      return Object.freeze(path);
    }
    const nested = findStepLocation(step.parallel ?? [], target, [...path, 'parallel']);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}
