import { isDynamicParallelSubSteps, type WorkflowConfig, type WorkflowStep } from '../models/types.js';

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
    const nested = step.parallel === undefined
      ? undefined
      : isDynamicParallelSubSteps(step.parallel)
        ? findDynamicParallelStepLocation(step.parallel, target, [...path, 'parallel'])
        : findStepLocation(step.parallel, target, [...path, 'parallel']);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function findDynamicParallelStepLocation(
  parallel: NonNullable<WorkflowStep['parallel']>,
  target: WorkflowStep,
  parallelPath: readonly PropertyKey[],
): readonly PropertyKey[] | undefined {
  if (!isDynamicParallelSubSteps(parallel)) {
    return undefined;
  }
  return findStepLocation(parallel.fixed, target, [...parallelPath, 'fixed'])
    ?? findStepLocation(parallel.pool, target, [...parallelPath, 'pool']);
}
